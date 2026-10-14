/**
 * MetaTrader 5 bridge API.
 *
 * The EA is the only market-data and execution client for the multi-asset
 * Desk. A pairing code creates a bearer token scoped to one browser session;
 * MT5 passwords never traverse this service. The bridge accepts the broker's
 * full catalogue at pairing, then only accepts real quotes/candles/account
 * snapshots from the paired terminal — there is no replay fallback.
 */

import { Router, type IRouter, type Request, type Response as ExpressResponse } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { getBrowserSessionId } from "../lib/session";
import { recordOutcome } from "../lib/multiasset/risk";
import {
  barTimestampUsable,
  feedHealth,
  quoteTimestampUsable,
  updateClockSkew,
} from "../lib/multiasset/integrity";
import { broadcastSSE } from "../lib/sse";
import { maybeAutoSelect } from "../lib/multiasset/auto-select";
import {
  TERMINAL_DEGRADED_MS,
  terminalIsDegraded,
  terminalIsFresh,
  terminalSilenceMs,
  terminalStaleWindowMs,
} from "../lib/multiasset/live";
import { recordTick } from "../lib/multiasset/subminute";
import { getSlippageLedger, getSpreadHistory, getTimingLedger } from "../lib/multiasset/agent";
import { recordSlippage, recordSpread, recordTimingOutcome, signedSlippageR } from "../lib/multiasset/execution";
import { deskV4, v4On } from "../lib/multiasset/desk-v4-config";
import { reconcileManagement } from "../lib/multiasset/desk-settings-runtime";
import { bindTicket, recordClosedTrade } from "../lib/multiasset/governance-runtime";
import { deskAlertNow } from "../lib/multiasset/alerts";
import {
  computeHistoryNeeded,
  parseBarsAvailable,
  recordLegacyHistoryRequests,
} from "../lib/multiasset/history";
import {
  accountKeyFor,
  describeConflict,
  claimsForSession,
  releaseClaim,
  releaseClaimsForSession,
  touchClaim,
  tryClaimAccount,
} from "../lib/multiasset/claims";
import {
  acknowledgeResult,
  adoptBridgeToken,
  applyAccount,
  bridgeTokensFor,
  clearTerminalData,
  drainOutbox,
  expirePlans,
  getDesk,
  journal,
  pruneDeselectedSymbols,
  reconcilePositions,
  rememberBridgeToken,
  requeueStaleCommands,
  resendArmedPlans,
  revokeBridgeToken,
  revokeBridgeTokens,
  sessionForToken,
  ticksFor,
  upsertCandles,
  type DeskState,
} from "../lib/multiasset/store";
import {
  BRIDGE_LINK_LEASE_MS,
  PAIRING_CODE_TTL_MS,
  bridgeStoreReport,
  deleteBridgeLink,
  deleteBridgeLinksForSession,
  hashBridgeToken,
  linkByCode,
  lookupBridgeLink,
  lookupPairingCode,
  lookupSpentPairingCode,
  retirePairingCode,
  pairingCodesForSession,
  prunePairingCodes,
  pruneRevokedLinks,
  revokeBridgeLink,
  revokeBridgeLinksForSession,
  saveBridgeLink,
  savePairingCode,
  sessionHasLiveLink,
  touchBridgeLink,
  type StoreHealth,
  type StoredBridgeLink,
} from "../lib/multiasset/bridge-links";
import { quoteSnapshot, deskSummary } from "../lib/multiasset/presenter";
import {
  ASSET_CLASSES,
  TIMEFRAMES,
  type AccountSnapshot,
  type AssetClass,
  type Bar,
  type CommandResult,
  type HighImpactNewsEvent,
  type MarketCatalogEntry,
  type NewsFeed,
  type Position,
  type Quote,
  type SymbolSpec,
  type SyncClock,
  type SyncResponse,
  type Timeframe,
} from "../lib/multiasset/types";

const router: IRouter = Router();

/**
 * The EA version this server expects.
 *
 * The Desk ships the expert advisor itself, so a stale terminal is a
 * first-class failure mode: the version that was published before this change
 * sent economic-calendar times in broker-server time, only looked two hours
 * ahead, and reported no read counts — which the desk rendered as "no
 * high-impact events in the next 24 hours" while the MT5 calendar tab showed
 * three red-folder releases. The terminal now reports its version and the Desk
 * says plainly when it is behind, instead of leaving the user to guess why the
 * feed looks empty.
 *
 * v3.04 adds: per-series bar counts (`barsAvailable`) so the desk asks for
 * history only while the terminal holds bars it lacks (killing the re-seed
 * loop that stalled the heartbeat), targeted `history` re-seed keys, a shorter
 * WebRequest timeout, beat-duration logging, and timestamps self-corrected
 * against this server's clock (`serverTime`) instead of the machine clock.
 *
 * v3.06 adds the terminal half of the 401 fix: a 401 that does not carry
 * `code: "bridge_link_revoked"` is treated as UNVERIFIED, so the token is kept
 * and retried (four attempts, fifteen seconds apart) instead of being wiped on
 * sight; 503 is transient and never touches the credentials in memory; and
 * `OnDeinit` names the reason MT5 stopped the expert, so "it detached itself"
 * is answered in the journal instead of guessed at.
 *
 * v3.09 restores the persistence the owner asked for, with a narrower ending:
 * the EA saves its token and pairing code per MT5 account and re-adopts them on
 * the next attach, so a reboot, a redeploy or a network outage costs nothing
 * and needs no new code. A link ends for exactly two reasons — the user unlinks
 * the terminal in the Desk (`bridge_link_revoked`, the only final answer the EA
 * may act on), or the user closes MT5 (`OnDeinit` → `/disconnect`, now sent for
 * `REASON_CLOSE` alone). `BRIDGE_LINK_LEASE_MS` no longer ends anything: silence
 * marks the terminal STALE for display and nothing more.
 */
export const EXPECTED_EA_VERSION = "3.09";

/**
 * What a terminal is told when its code no longer works.
 *
 * Two things end a code, and only two: the user pressing "Unlink terminal"
 * (which revokes the code with the link), or the user generating a newer code in
 * the dialog. Silence, a redeploy and a reboot all leave a code alone. Both
 * endings mean the same thing to whoever is reading the journal — fetch the
 * current code and paste it in — so both answer with this, and the EA prints a
 * single actionable line instead of retrying a dead value forever.
 */
const SPENT_CODE_MESSAGE =
  "This pairing code is no longer active: the Desk unlinked the terminal it belonged to, or a newer " +
  "code replaced it. Generate a NEW code in the Desk (Link MT5) and paste it into the EA's PairingCode " +
  "input.";

/**
 * Answer "I could not check", never "your credential is dead".
 *
 * A 401 from this API is a permanent verdict: the EA clears the bearer token it
 * saved in the terminal's common folder — a file every chart of that account
 * shares — disables trading and falls back to its pairing code. If the store
 * that holds the link could not be read (a deploy in progress, a database
 * failover, the bootstrap DDL still being applied, a second replica that has
 * not seen the row), answering 401 turned a few seconds of unreadable database
 * into a terminal that never came back on its own. 503 is retryable, revokes
 * nothing, and the EA keeps the token it holds and tries again.
 */
interface StoreUnavailableOverrides {
  error?: string;
  code?: string;
  retryAfterMs?: number | null;
  storeBackend?: string;
}

function storeUnavailable(
  res: ExpressResponse,
  health: StoreHealth,
  detail: string | undefined,
  what: string,
  overrides: StoreUnavailableOverrides = {},
): ExpressResponse {
  logger.warn({ health, detail, what }, "MT5 bridge store could not be consulted — answering 503");
  return res.status(503).json({
    error: overrides.error ?? `The bridge link store could not be reached, so ${what} could not be verified. Nothing was revoked — the terminal should retry.`,
    code: overrides.code ?? "bridge_store_unavailable",
    storeHealth: health,
    detail: detail ?? null,
    retryAfterMs: overrides.retryAfterMs === undefined ? 5_000 : overrides.retryAfterMs,
    ...(overrides.storeBackend ? { storeBackend: overrides.storeBackend } : {}),
  });
}

interface PendingPairing {
  code: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
}

/**
 * In-process mirror of the durable pairing codes.
 *
 * Reads and writes go through `bridge-links.ts` (Postgres), so a restart no
 * longer destroys a code the user has already pasted into their terminal. This
 * map only keeps the hot path fast and stays exported for the test harness.
 */
const pendingPairings = new Map<string, PendingPairing>();

function rememberPendingPairing(record: PendingPairing): void {
  pendingPairings.set(record.code, record);
}

/** Drop this session's codes from the in-process mirror (rotation / unlink). */
function forgetPendingPairings(sessionId: string): void {
  for (const [code, pairing] of pendingPairings) {
    if (pairing.sessionId === sessionId) pendingPairings.delete(code);
  }
}

function prunePairings(now = Date.now()): void {
  for (const [code, pairing] of pendingPairings) {
    if (pairing.expiresAt <= now) pendingPairings.delete(code);
  }
  void prunePairingCodes(now);
}

/** Unambiguous alphabet: no O/0 or I/1 when a user types the code by hand. */
function makePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += "-";
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// ── Pairing ──────────────────────────────────────────────────────────────────

/**
 * Issue the browser a pairing code — or hand back the one it already has.
 *
 * THE CODE BELONGS TO THE LINK IT CREATED, FOR AS LONG AS THAT LINK LASTS. It
 * exists to move a credential from the Desk into a running MT5 terminal by
 * hand: it is minted here, typed into the EA's `PairingCode` input, and
 * redeemed by `/pair`. From that moment it is the terminal's credential too —
 * the EA keeps it on disk next to its token, so a reboot, a redeploy or a
 * weekend of silence all reconnect on the SAME code, with no new value to type.
 * It is spent only when the link is: the user unlinks the terminal, or the user
 * closes MT5 and the EA says so.
 *
 * WHY THE REUSE IS NEEDED: the desk holds one link per (browser session,
 * account). An EA reload, a second chart on the same account, a redeploy the
 * terminal survived and the next MT5 session all re-present the SAME code — and
 * must be able to, or every restart would demand a code the user has no reason
 * to expect. Reuse stays scoped to this session, and a redeemed code only ever
 * re-pairs the account its link already holds (see `/pair`).
 *
 * Rotation retires the previous codes outright: leaving alive a value the user
 * believes they have replaced would be a credential they no longer control.
 */
router.post("/pairing-code", async (req, res) => {
  const sessionId = getBrowserSessionId();
  const rotate = req.body?.rotate === true;
  const now = Date.now();
  prunePairings(now);

  // Reported with the code, because the Desk must be able to say whether the
  // store that tracks live links is readable at this moment. Issuance below
  // still requires an acknowledged write; the report alone is not sufficient.
  const store = await bridgeStoreReport();
  if (process.env.NODE_ENV === "production" && store.backend !== "postgres") {
    const detail = `Shared PostgreSQL is required in production; the API reports backend=${store.backend} (${store.detail}).`;
    return storeUnavailable(res, "unavailable", detail, "a new pairing code", {
      error:
        "MT5 pairing is disabled because this production API is not connected to shared PostgreSQL. Configure DATABASE_URL on the API service, then verify GET /api/bridge/ready reports backend=postgres, reachable=true, and schemaApplied=true.",
      code: "bridge_store_not_shared",
      retryAfterMs: null,
      storeBackend: store.backend,
    });
  }

  if (!rotate) {
    const stored = await pairingCodesForSession(sessionId, now);
    // Prefer the code a terminal has already redeemed: that is the value in its
    // PairingCode input, so reopening the dialog shows the code that is actually
    // in use. A fresh unused code is shown only when there is no live link.
    const live = stored.find((record) => record.redeemedAt !== null) ?? stored[0];
    if (live) {
      rememberPendingPairing(live);
      return res.json({
        pairingCode: live.code,
        expiresInMs: live.expiresAt === 0 ? null : Math.max(0, live.expiresAt - now),
        redeemed: live.redeemedAt !== null,
        reused: true,
        durable: store.durable,
        storeReachable: store.reachable,
      });
    }
  } else {
    // An explicit rotation retires the previous codes: leaving them alive would
    // mean a value the user believes they have replaced still pairs. They are
    // retired rather than deleted, so a terminal still using the old value is
    // told what happened instead of being answered "unknown code".
    for (const stale of await pairingCodesForSession(sessionId, now)) {
      await retirePairingCode(stale.code, now);
    }
    forgetPendingPairings(sessionId);
  }

  const code = makePairingCode();
  const record: PendingPairing = {
    code,
    sessionId,
    createdAt: now,
    expiresAt: now + PAIRING_CODE_TTL_MS,
    redeemedAt: null,
  };
  try {
    await savePairingCode(record);
  } catch (err) {
    return storeUnavailable(
      res,
      "error",
      err instanceof Error ? err.message : String(err),
      "a new pairing code",
      {
        error:
          "No pairing code was issued because the API could not save it to the bridge link store. Check the API service's database connectivity and schema, then retry. Existing links were not changed.",
        storeBackend: store.backend,
      },
    );
  }
  rememberPendingPairing(record);
  return res.json({
    pairingCode: code,
    expiresInMs: PAIRING_CODE_TTL_MS,
    redeemed: false,
    reused: false,
    durable: store.durable,
    storeReachable: store.reachable,
  });
});

/**
 * Exchange the pairing code for a terminal-scoped bearer token.
 *
 * A broker account may only be held by one Desk at a time. Two Desks on one
 * account would both stream it, both arm plans against it and either could
 * flatten positions the other believed it owned — one balance counted against
 * two independent sets of risk limits. The claim is taken here, atomically,
 * before any token exists.
 *
 * Re-pairing the SAME account on the SAME Desk (an EA reload, a redeploy the
 * terminal survived, a second chart) adds a token to the existing link instead
 * of rotating it: two instances invalidating each other is what made the
 * connection flap.
 *
 * A CODE THAT HAS ALREADY PAIRED is accepted back for as long as the link it
 * created is alive, and only for that link's account. That is the whole point:
 * the EA saved the code in the terminal's common folder, so the next session
 * re-adopts its own link without the user touching anything. A code whose link
 * is gone — revoked by "Unlink terminal", or deleted with a closed terminal —
 * is refused with `pairing_code_spent`, because a credential that outlives its
 * link is exactly what the user asked us not to keep.
 */
router.post("/pair", async (req, res) => {
  prunePairings();
  const code = String(req.body?.pairingCode ?? "").trim().toUpperCase();
  const terminal = req.body?.terminal ?? {};

  const login = Number(terminal.login ?? 0);
  const server = String(terminal.server ?? "unknown");
  if (!Number.isFinite(login) || login <= 0) {
    return res.status(400).json({ error: "terminal.login is required." });
  }

  /**
   * The record is read through `lookupPairingCode` on EVERY call, never from a
   * map this route keeps.
   *
   * A local copy goes stale the moment the code is redeemed: the mark that says
   * "this code already belongs to a terminal" would be missing, and a spent code
   * would pair again. The call is still cheap — the store module keeps its own
   * in-process mirror, so the hot path never touches the database.
   */
  const lookup = await lookupPairingCode(code);
  const pairing = lookup.record;
  if (!pairing) {
    if (!lookup.checked) return storeUnavailable(res, lookup.health, lookup.detail, "this pairing code");
    // The code is not usable. Say WHY, because the two reasons need different
    // actions from the user: a code that was used by a terminal session that
    // has since ended means "the terminal you closed is gone — take a new
    // code", while an unknown code means the one in the EA is the wrong value
    // (rotated, or typed with a character missing).
    const spent = await lookupSpentPairingCode(code);
    if (spent.record?.redeemedAt !== null && spent.record?.redeemedAt !== undefined) {
      return res.status(401).json({ error: SPENT_CODE_MESSAGE, code: "pairing_code_spent" });
    }
    return res
      .status(401)
      .json({ error: "Unknown or expired pairing code.", code: "pairing_code_unknown" });
  }
  rememberPendingPairing(pairing);

  /**
   * ── Has this code already been used by a terminal? ────────────────────────
   *
   * A code is spent at first use. It may only be presented again by the SAME
   * terminal session, which is the one whose link is still alive and whose
   * account matches: an EA reload, a second chart, or an API redeploy the
   * terminal survived all land here. Once that link ends the code is deleted
   * with it, so this branch cannot resurrect a closed terminal — that path is
   * the whole point of the change, and the message says so plainly.
   */
  if (pairing.redeemedAt !== null) {
    const known = await linkByCode(code);
    if (!known.checked) return storeUnavailable(res, known.health, known.detail, "this pairing code");
    const live = known.record;
    if (!live) {
      return res.status(401).json({ error: SPENT_CODE_MESSAGE, code: "pairing_code_spent" });
    }
    const sameAccount =
      Math.trunc(login) === live.login && accountKeyFor(live.login, live.server) === accountKeyFor(login, server);
    if (!sameAccount) {
      return res.status(401).json({
        error:
          "This pairing code is already connected to another account. Use the code for the terminal you " +
          "are starting, or generate a new code in the Desk.",
        code: "pairing_code_spent",
      });
    }
  }

  const desk = getDesk(pairing.sessionId);

  // ── Global uniqueness check ──────────────────────────────────────────────
  const claim = await tryClaimAccount({
    login,
    server,
    company: String(terminal.company ?? ""),
    sessionId: pairing.sessionId,
    releasePrevious: false,
  });
  if (!claim.ok) {
    // The code deliberately survives a refusal. The EA retries every few
    // seconds with the same value, so keeping it alive means the user sees one
    // clear explanation instead of "unknown or expired code", and the terminal
    // connects by itself the moment the other Desk lets go.
    const message = describeConflict(claim.holder.login || login, claim.holder.server || server);
    desk.lastPairingError = { message, login, server, at: Date.now() };
    journal(desk, "bridge", null, `Pairing refused — ${message}`);
    logger.warn({ login, server, heldBySession: claim.holder.sessionId }, "MT5 pairing refused: account already claimed");
    return res.status(409).json({ error: message, code: "account_already_connected" });
  }

  const accountKey = accountKeyFor(login, server);
  let sameLink = Boolean(
    desk.terminal &&
      desk.terminal.login === Math.trunc(login) &&
      accountKeyFor(desk.terminal.login, desk.terminal.server) === accountKey,
  );

  const pairedAt = sameLink ? (desk.terminal?.pairedAt ?? Date.now()) : Date.now();
  const bridgeToken = `nt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    // Persist BEFORE publishing the token, consuming the code or changing the
    // current Desk. A failed re-pair must leave its existing terminal untouched.
    await saveBridgeLink({
      token: bridgeToken,
      sessionId: pairing.sessionId,
      accountKey,
      login,
      server,
      company: String(terminal.company ?? ""),
      code,
      pairedAt,
    });
  } catch (err) {
    const currentOwnsClaim = desk.terminal && accountKeyFor(desk.terminal.login, desk.terminal.server) === accountKey;
    if (!currentOwnsClaim) await releaseClaim(accountKey, pairing.sessionId);
    return storeUnavailable(res, "error", err instanceof Error ? err.message : String(err), "this terminal's link");
  }

  // Another chart can finish pairing while the database write is in flight.
  // Re-check before replacing anything, so same-account attaches never revoke
  // one another merely because they started at the same time.
  sameLink = Boolean(desk.terminal && accountKeyFor(desk.terminal.login, desk.terminal.server) === accountKey);
  for (const previous of claimsForSession(pairing.sessionId)) {
    if (previous.accountKey !== accountKey) await releaseClaim(previous.accountKey, pairing.sessionId);
  }

  if (!sameLink) {
    // A different terminal (or the same Desk linking another account): the
    // previous link's tokens must die, or a superseded terminal could keep
    // streaming and trading this Desk. Revoking tells that terminal it was
    // replaced — the one refusal an EA may treat as final — and the pairing
    // code it used is destroyed with the link, so the terminal it belonged to
    // can never come back on it.
    const revoked = revokeBridgeTokens(desk);
    for (const token of revoked) {
      const record = (await lookupBridgeLink(token)).record;
      await revokeBridgeLink(token);
      if (record?.code && record.code !== code) await retirePairingCode(record.code);
    }
    clearTerminalData(desk);
  }
  // Same account, same Desk: the existing tokens stay valid. That is the whole
  // point — two EA instances on one account must not invalidate each other in a
  // re-pair loop, and the command outbox already guarantees that each command is
  // delivered to exactly one of them.

  desk.lastPairingError = null;

  adoptBridgeToken(bridgeToken, pairing.sessionId);
  desk.terminal = {
    accountId: `mt5:${login}@${server}`,
    login,
    server,
    company: String(terminal.company ?? ""),
    bridgeToken,
    tokens: sameLink ? [...(desk.terminal?.tokens ?? []), bridgeToken] : [bridgeToken],
    pairedAt,
    lastSyncAt: Date.now(),
    lastSeq: 0,
    // Kept while the same link continues; the next beat re-reports it anyway.
    instanceId: sameLink ? (desk.terminal?.instanceId ?? null) : null,
    eaVersion: typeof terminal.version === "string" ? terminal.version.slice(0, 32) : null,
    // Filled in from the first heartbeat that reports it. Until then the desk
    // uses its fixed staleness window.
    syncIntervalMs: 0,
  };

  const catalog = Array.isArray(req.body?.catalog) ? req.body.catalog : [];
  let catalogCount = 0;
  if (!sameLink) {
    for (const raw of catalog) {
      const entry = parseCatalogEntry(raw);
      if (!entry) continue;
      desk.catalog.set(entry.symbol, entry);
      catalogCount++;
    }
  }

  journal(
    desk,
    "bridge",
    null,
    sameLink
      ? `MetaTrader 5 terminal reconnected on account ${login}@${server}. The existing link was kept, so no re-linking is needed.`
      : `MetaTrader 5 terminal paired: ${login}@${server}. ${catalogCount} broker markets discovered. This account is now reserved for this Desk. The code is spent and this link ends when the terminal does.`,
  );
  logger.info({ login, server, catalogCount, sameLink }, "MT5 bridge paired");

  return res.status(201).json({
    bridgeToken,
    accountId: desk.terminal.accountId,
    syncIntervalMs: 1000,
    /**
     * The link contract, told to the terminal.
     *
     * A link ends for exactly two reasons: the user unlinks it in the Desk, or
     * the user closes MT5 (the EA's own `OnDeinit` reports that one). The EA is
     * expected to persist its token and pairing code per MT5 account and
     * re-adopt them on the next attach, so silence is never interpreted as an
     * ending by either side. `leaseMs` is how long this link may go unheard
     * before the DESK shows the terminal as stale — a display state, not a
     * deadline after which anything is revoked. `durableLink` is back, and this
     * time it is true: the rows, the code and the account claim all outlive the
     * terminal process.
     */
    linkModel: "unlink-or-terminal-close",
    linkEndsWithTerminal: false,
    durableLink: true,
    resumesAutomatically: true,
    leaseMs: BRIDGE_LINK_LEASE_MS,
    subscriptions: { symbols: desk.watchlist, timeframes: TIMEFRAMES },
  });
});

/**
 * The user's deliberate unlink: revoke every token, release the global account
 * claim, drop the pairing codes and remove every terminal-derived value.
 *
 * Revoking (rather than deleting) is what makes this the ONE answer the EA may
 * treat as final: it is told `bridge_link_revoked`, stops retrying that token
 * and asks for a new code. Every other way a link ends deletes the rows
 * instead, so nothing is left for a later process to re-adopt.
 *
 * The pairing codes are retired, not deleted: the user is standing in front of
 * the dialog that just unlinked, and a terminal still holding the old code gets
 * "take a new one" rather than "unknown code".
 *
 * Releasing the claim is what lets the same account be connected somewhere
 * else afterwards.
 */
router.post("/unpair", async (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  if (!desk.terminal) return res.status(404).json({ error: "No terminal is linked." });

  const { login, server } = desk.terminal;
  const tokens = revokeBridgeTokens(desk);
  for (const token of tokens) await revokeBridgeLink(token);
  await revokeBridgeLinksForSession(desk.sessionId);
  for (const stale of await pairingCodesForSession(desk.sessionId)) {
    await retirePairingCode(stale.code);
  }
  forgetPendingPairings(desk.sessionId);
  await releaseClaimsForSession(desk.sessionId);
  desk.terminal = null;
  desk.lastPairingError = null;
  clearTerminalData(desk);
  journal(
    desk,
    "bridge",
    null,
    `MetaTrader 5 terminal unlinked: ${login}@${server} released. The link was revoked, so a fresh pairing code is required to connect again.`,
  );
  return res.json({ ok: true, revoked: tokens.length });
});

/**
 * The terminal is going away — end its link, now.
 *
 * Called by the EA from `OnDeinit` for ONE reason: the user is closing MT5
 * (REASON_CLOSE). A chart close, an EA removal, a timeframe switch or a failed
 * attach does not come through here — those are things the user does to a
 * chart, not decisions to end the connection, and the EA keeps its credentials
 * through all of them.
 *
 * It is best effort by design: MT5 does not wait for an EA's shutdown, so the
 * call may not arrive at all. Nothing else ends the link on a missed goodbye —
 * the next MT5 session re-adopts the saved credentials, and the Desk shows the
 * terminal as stale in the meantime.
 *
 * Several charts of one terminal share ONE link, each holding its own token, so
 * this drops the token that asked and only ends the link when it was the last
 * one beating. That is what stops one chart's removal from disconnecting
 * another chart that is still streaming.
 *
 * NEVER answers 4xx/5xx for a terminal that simply wants to leave: it is
 * leaving either way. A store that cannot be read costs the durable row, not
 * the in-process one.
 */
router.post("/disconnect", async (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(400).json({ error: "A bearer token is required to disconnect." });

  // Resolve what we can WITHOUT turning this into a verification problem: an
  // unreadable store must not leave a terminal's own token mapped in memory.
  const lookup = await lookupBridgeLink(token);
  const record: StoredBridgeLink | null = lookup.record;
  const sessionId = record?.sessionId ?? sessionForToken(token) ?? null;
  if (!sessionId) {
    return res.json({ ok: true, ended: false, reason: "unknown_token" });
  }

  const desk = getDesk(sessionId);
  const reason = String(req.body?.reason ?? "");
  const terminalClosed = reason === "terminal closing" || reason === "terminal_close" ||
    reason === "the terminal or chart was closed"; // v3.09 sends this ONLY for REASON_CLOSE
  if (terminalClosed) {
    await endSessionLink(sessionId, "MetaTrader 5 terminal closed. The link and pairing code were released.");
    return res.json({ ok: true, ended: true });
  }
  revokeBridgeToken(token);
  await deleteBridgeLink(token);

  const siblingsLive = await sessionHasLiveLink(sessionId, hashBridgeToken(token), Date.now());
  const remaining = (desk.terminal ? bridgeTokensFor(desk) : []).length;
  if (siblingsLive || remaining > 0) {
    journal(
      desk,
      "bridge",
      null,
      "One terminal instance disconnected. Other terminal instances on this Desk are still streaming, so the link stays open.",
    );
    return res.json({ ok: true, ended: false, remaining, reason: "one_instance_left" });
  }

  await endSessionLink(
    sessionId,
    `MetaTrader 5 terminal disconnected: ${record ? `${record.login}@${record.server}` : "the terminal"} closed. ` +
      `The link and its pairing code have been released — open Desk → Link MT5 for a new code when you reconnect.`,
  );
  return res.json({ ok: true, ended: true });
});

/**
 * End a Desk's link: revoke the tokens it holds, delete the durable rows and
 * the code that created them, release the account claim, and clear every
 * terminal-derived value from the Desk.
 *
 * Shared by the terminal's own `disconnect` (the user closed MT5), an account
 * handover to another Desk, and a re-pair that supersedes a live terminal, so
 * "the link is over" means exactly one thing wherever it is decided. The in-process Desk is cleared as well as the store, because the
 * next thing the user sees is the Desk UI: leaving a stale terminal record
 * there would show a connected account that no longer exists.
 */
async function endSessionLink(sessionId: string, journalMessage: string): Promise<void> {
  const desk = getDesk(sessionId);
  // In-process tokens first, so the desk's own list is emptied even if the
  // durable row for one of them was already gone.
  const tokens = desk.terminal ? revokeBridgeTokens(desk) : [];
  for (const token of tokens) await deleteBridgeLink(token);
  // Then everything the store still knows for this session — including rows
  // written by another replica — together with the pairing code each link
  // carries. A link that is over must leave no credential behind.
  await deleteBridgeLinksForSession(sessionId);
  forgetPendingPairings(sessionId);
  await releaseClaimsForSession(sessionId);
  desk.terminal = null;
  desk.lastPairingError = null;
  clearTerminalData(desk);
  journal(desk, "bridge", null, journalMessage);
}

/**
 * Housekeeping for link rows. IT NO LONGER ENDS ANYTHING.
 *
 * ── WHAT CHANGED, AND WHY ───────────────────────────────────────────────────
 *
 * This function used to be the desk's biggest source of unrequested
 * disconnections: any link silent for `BRIDGE_LINK_LEASE_MS` (120 s) had its
 * tokens revoked, its account claim released, its pairing code retired and its
 * Desk cleared. A sleeping laptop, a closed lid, a weekend, a broker-side
 * weekend maintenance window, a five-minute ISP wobble — all of it read as "the
 * user unlinked the terminal", and the terminal came back to a 401 it was
 * allowed to treat as final.
 *
 * The owner's rule is now the rule: a link ends when the USER ends it. So:
 *
 *   • silence still marks the terminal stale for DISPLAY (the Desk shows
 *     `MT5 STALE`, the analysis path gates on quote freshness) and nothing more;
 *   • the only rows this prunes are those already REVOKED — the user pressed
 *     Unlink, the EA has had its spaced retries to read that final answer, and
 *     the row is then deleted rather than accumulated;
 *   • no unrevoked token is pruned, even if a sibling is still beating.
 *
 * It keeps returning `0` as "links ended", because nothing ends links any more;
 * the number is retained so the boot log and the tests read the same.
 */
export async function sweepExpiredLinks(now = Date.now()): Promise<number> {
  // No valid token is garbage-collected on silence, even when a sibling is
  // beating. That chart can resume later (or after an API restart) on its token.
  // Revoked rows are kept only long enough for the EA's spaced retries to see
  // the final answer; past that they are deleted rather than accumulated.
  await pruneRevokedLinks(now);
  return 0;
}

/**
 * Start the lease sweeper.
 *
 * Called once from the server entry point, not from the router, so importing
 * the routes (tests, tooling) never leaves a timer running. `unref()` keeps it
 * from holding the process open on a shutdown.
 */
export function startBridgeLinkSweeper(intervalMs = 15_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepExpiredLinks().catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "MT5 bridge lease sweep failed");
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

// ── Authentication ───────────────────────────────────────────────────────────

function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * Resolve the Desk a bearer token belongs to.
 *
 * The token only has to belong to this session's link — it is no longer
 * compared for equality against a single "current" token, because a link can
 * legitimately have more than one live token (a restarted terminal until its
 * old socket goes quiet, a second chart on the same account). Every token is
 * bound to one session by `tokenToSession`, so this cannot cross sessions.
 */
function deskForRequest(req: Request): DeskState | null {
  const token = bearerToken(req);
  if (!token) return null;
  const sessionId = sessionForToken(token);
  if (!sessionId) return null;
  const desk = getDesk(sessionId);
  return desk.terminal ? desk : null;
}

/** What a `/sync` credential check concluded, and how much to trust it. */
interface LinkAttempt {
  desk: DeskState | null;
  /** True when the durable store was consulted successfully. */
  checked: boolean;
  /** The link row exists and carries a revocation — the user unlinked. */
  revoked: boolean;
  health: StoreHealth;
  detail?: string;
}

/**
 * Rebuild a Desk whose link survived in the database but not in this process.
 *
 * This is the fix for "the API restarted and the MT5 terminal never came
 * back": the EA keeps heartbeating with the token it saved, the link row still
 * proves it was issued, so the Desk is re-attached and the account claim is
 * re-taken. The user sees a one-line journal entry, not a dead terminal.
 *
 * The returned `checked` flag is what separates "this token is not a link"
 * (401, and the EA may discard it) from "the store could not be read" (503,
 * and the EA must keep it) — see `storeUnavailable`.
 */
async function rehydrateFromDurableLink(req: Request): Promise<LinkAttempt> {
  const notFound = (extra: Partial<LinkAttempt> = {}): LinkAttempt => ({
    desk: null,
    checked: true,
    revoked: false,
    health: "ok",
    ...extra,
  });

  const token = bearerToken(req);
  if (!token) return notFound();
  const lookup = await lookupBridgeLink(token);
  if (!lookup.checked) {
    return { desk: null, checked: false, revoked: false, health: lookup.health, detail: lookup.detail };
  }
  const link = lookup.record;
  if (!link) return notFound({ detail: lookup.detail });
  if (link.revokedAt) return notFound({ revoked: true, detail: "revoked by the Desk" });

  const desk = getDesk(link.sessionId);
  adoptBridgeToken(token, link.sessionId);

  // Re-take the claim so the local mirror agrees with the database again. If
  // another Desk has taken the account in the meantime this fails and the next
  // touchClaim() disconnects the terminal with the usual explanation.
  const claim = await tryClaimAccount({
    login: link.login,
    server: link.server,
    company: link.company,
    sessionId: link.sessionId,
  });
  if (!claim.ok) {
    logger.warn(
      { login: link.login, server: link.server, heldBySession: claim.holder.sessionId },
      "MT5 durable link rehydrated but the account is held by another Desk",
    );
  }

  if (!desk.terminal) {
    desk.terminal = {
      accountId: `mt5:${link.login}@${link.server}`,
      login: link.login,
      server: link.server,
      company: link.company,
      bridgeToken: token,
      tokens: [token],
      pairedAt: link.pairedAt,
      lastSyncAt: Date.now(),
      lastSeq: 0,
      instanceId: null,
      eaVersion: null,
      syncIntervalMs: 0,
    };
    journal(
      desk,
      "bridge",
      null,
      `Desk restored after a server restart: ${link.login}@${link.server} reconnected on the link its open terminal still holds, so no re-pairing was needed.`,
    );
  } else {
    rememberBridgeToken(desk, token);
  }
  return { desk: desk.terminal ? desk : null, checked: true, revoked: false, health: "ok" };
}

// ── Parse + validate terminal payloads ───────────────────────────────────────

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assetClass(value: unknown): AssetClass {
  return typeof value === "string" && (ASSET_CLASSES as readonly string[]).includes(value)
    ? value as AssetClass
    : "other";
}

export function parseCatalogEntry(raw: unknown): MarketCatalogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? "").trim();
  if (!symbol || symbol.length > 128) return null;
  return {
    symbol,
    description: String(r.description ?? symbol).slice(0, 512),
    path: String(r.path ?? "").slice(0, 512),
    assetClass: assetClass(r.assetClass),
    tradeable: r.tradeable !== false,
  };
}

export function parseSpec(raw: unknown): SymbolSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? "").trim();
  const point = num(r.point);
  if (!symbol || !(point > 0)) return null;

  const tickSize = num(r.tickSize, point);
  return {
    symbol,
    assetClass: assetClass(r.assetClass),
    point,
    digits: Math.round(num(r.digits, 5)),
    tickSize: tickSize > 0 ? tickSize : point,
    tickValue: num(r.tickValue),
    contractSize: num(r.contractSize, 1),
    volumeMin: num(r.volumeMin, 0.01),
    volumeMax: num(r.volumeMax, 100),
    volumeStep: num(r.volumeStep, 0.01),
    stopsLevel: num(r.stopsLevel),
    freezeLevel: num(r.freezeLevel),
    marginInitial: num(r.marginInitial),
    swapLong: num(r.swapLong),
    swapShort: num(r.swapShort),
    commissionPerLot: num(r.commissionPerLot),
    spreadPoints: num(r.spreadPoints),
    baseCurrency: typeof r.baseCurrency === "string" ? r.baseCurrency : undefined,
    quoteCurrency: typeof r.quoteCurrency === "string" ? r.quoteCurrency : undefined,
  };
}

export function parseAccount(raw: unknown): AccountSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const equity = num(r.equity, NaN);
  if (!Number.isFinite(equity)) return null;

  const margin = num(r.margin);
  return {
    balance: num(r.balance, equity),
    equity,
    margin,
    freeMargin: num(r.freeMargin, equity - margin),
    marginLevel: margin > 0 ? num(r.marginLevel, (equity / margin) * 100) : Number.POSITIVE_INFINITY,
    currency: String(r.currency ?? "USD"),
    leverage: num(r.leverage, 100),
    mode: r.mode === "netting" ? "netting" : "hedging",
    isLive: Boolean(r.isLive),
  };
}

function parsePosition(raw: unknown): Position | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ticket = Math.round(num(r.ticket, NaN));
  const symbol = String(r.symbol ?? "");
  if (!Number.isFinite(ticket) || !symbol) return null;
  return {
    ticket,
    symbol,
    side: r.side === "sell" ? "sell" : "buy",
    volume: num(r.volume),
    openPrice: num(r.openPrice),
    openTime: num(r.openTime, Date.now()),
    sl: r.sl === null || r.sl === undefined ? null : num(r.sl) || null,
    tp: r.tp === null || r.tp === undefined ? null : num(r.tp) || null,
    profit: num(r.profit),
    swap: num(r.swap),
    commission: num(r.commission),
    comment: typeof r.comment === "string" ? r.comment : undefined,
    initialRiskMoney: r.initialRiskMoney === undefined ? undefined : num(r.initialRiskMoney),
    initialRiskPoints: r.initialRiskPoints === undefined ? undefined : num(r.initialRiskPoints),
  };
}

function parseQuote(raw: unknown): Quote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? "");
  const bid = num(r.bid);
  const ask = num(r.ask);
  if (!symbol || !(bid > 0) || !(ask > 0)) return null;
  return { symbol, bid, ask, spreadPoints: num(r.spreadPoints), ts: num(r.ts, Date.now()) };
}

function parseBars(raw: unknown, timestampUsable?: (time: number) => boolean): Bar[] {
  if (!Array.isArray(raw)) return [];
  const out: Bar[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 5) continue;
    const bar = entry.slice(0, 6).map((v) => num(v));
    while (bar.length < 6) bar.push(0);
    if (!(bar[0] > 0) || !(bar[4] > 0)) continue;
    // Drop bars whose timestamp cannot be real. A broker clock reset or a
    // timezone bug otherwise injects candles from the future or from years ago
    // into the middle of a series, which corrupts every indicator downstream.
    if (timestampUsable && !timestampUsable(bar[0])) continue;
    out.push(bar as Bar);
  }
  return out;
}

/** Parse the terminal's clock context. Tolerant: absent means "unknown". */
function parseClock(raw: unknown): SyncClock | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const terminalUtcMs = num(r.terminalUtcMs, NaN);
  if (!Number.isFinite(terminalUtcMs) || terminalUtcMs <= 0) return null;
  const syncIntervalMs = Math.round(num(r.syncIntervalMs, 0));
  const computerClockSkewMs = num(r.computerClockSkewMs, NaN);
  return {
    serverUtcOffsetSeconds: Math.round(num(r.serverUtcOffsetSeconds, 0)),
    terminalUtcMs,
    // v3.04+: the machine's own clock error, reported separately because the
    // EA self-corrects its timestamps — this is the "sync NTP" signal, not a
    // data-quality alarm.
    computerClockSkewMs: Number.isFinite(computerClockSkewMs) ? Math.round(computerClockSkewMs) : undefined,
    label: typeof r.label === "string" ? r.label.slice(0, 64) : undefined,
    // Only a plausible heartbeat interval is accepted: 250ms (the EA's floor)
    // to 10 minutes. Anything else is noise and is ignored in favour of the
    // fixed window.
    syncIntervalMs: syncIntervalMs >= 250 && syncIntervalMs <= 600_000 ? syncIntervalMs : undefined,
  };
}

function parseResult(raw: unknown): CommandResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const commandId = String(r.commandId ?? "");
  if (!commandId) return null;
  const status = String(r.status ?? "done");
  return {
    commandId,
    status: (["filled", "rejected", "expired", "skipped", "done"].includes(status)
      ? status
      : "done") as CommandResult["status"],
    ticket: r.ticket === undefined ? undefined : Math.round(num(r.ticket)),
    price: r.price === undefined ? undefined : num(r.price),
    slippagePoints: r.slippagePoints === undefined ? undefined : num(r.slippagePoints),
    error: typeof r.error === "string" ? r.error : null,
    ts: num(r.ts, Date.now()),
  };
}

function parseNewsEvent(raw: unknown): HighImpactNewsEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  const time = num(r.time, NaN);
  const name = String(r.name ?? "").trim();
  if (!id || !Number.isFinite(time) || !name) return null;
  return {
    id,
    time,
    currency: String(r.currency ?? "").trim().toUpperCase().slice(0, 12),
    country: String(r.country ?? "").trim().slice(0, 128),
    name: name.slice(0, 256),
    importance: "high",
    actual: r.actual === null || r.actual === undefined ? null : num(r.actual),
    forecast: r.forecast === null || r.forecast === undefined ? null : num(r.forecast),
    previous: r.previous === null || r.previous === undefined ? null : num(r.previous),
  };
}

function parseNewsFeed(raw: unknown): NewsFeed | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const events = Array.isArray(r.events)
    ? r.events.map(parseNewsEvent).filter((event): event is HighImpactNewsEvent => event !== null)
    : [];
  const now = Date.now();
  // Keep a full day of history: the pane lists the day's releases so "0 in the
  // next 24 h" can be read against what already happened.
  const kept = events
    .filter((event) => event.time >= now - 24 * 60 * 60_000 && event.time <= now + 48 * 60 * 60_000)
    .sort((a, b) => a.time - b.time);
  const rawCount = Number.isFinite(num(r.rawCount, NaN)) ? Math.max(0, Math.round(num(r.rawCount))) : undefined;
  // The window the terminal read, when it reports one. Sanity-bounded: a value
  // years away cannot be a calendar window, and a window whose end precedes its
  // start would only produce nonsense in the UI.
  const windowFromMs = Number.isFinite(num(r.windowFromMs, NaN)) ? Math.round(num(r.windowFromMs)) : null;
  const windowToMs = Number.isFinite(num(r.windowToMs, NaN)) ? Math.round(num(r.windowToMs)) : null;
  const usableWindow =
    windowFromMs !== null && windowToMs !== null &&
    windowToMs > windowFromMs &&
    windowToMs > now - 7 * 24 * 60 * 60_000 &&
    windowFromMs < now + 7 * 24 * 60 * 60_000;
  return {
    available: r.available === true,
    checkedAt: num(r.checkedAt, now),
    events: kept,
    detail: typeof r.detail === "string" ? r.detail.slice(0, 500) : undefined,
    // Passed through untouched: the desk needs to know whether the terminal
    // actually read calendar rows (rawCount) or returned nothing at all.
    rawCount,
    redCount: Number.isFinite(num(r.redCount, NaN)) ? Math.max(0, Math.round(num(r.redCount))) : kept.length,
    windowFromMs: usableWindow ? windowFromMs : null,
    windowToMs: usableWindow ? windowToMs : null,
  };
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

/**
 * POST /api/bridge/sync — the EA's authenticated state heartbeat.
 *
 * The first thing it does is make sure the link can be served at all: if this
 * process has never seen the token (restart, redeploy, a second instance behind
 * the router) the durable link rebuilds the Desk instead of answering 401. A
 * 401 here is what used to knock a terminal out of the system permanently.
 */
router.post("/sync", async (req, res) => {
  const startedAt = Date.now();
  let desk = deskForRequest(req);
  if (!desk) {
    const attempt = await rehydrateFromDurableLink(req);
    if (attempt.desk) {
      desk = attempt.desk;
    } else if (!attempt.checked) {
      // Could not be verified ≠ invalid. The EA keeps its saved token and
      // retries; nothing here is revoked.
      return storeUnavailable(res, attempt.health, attempt.detail, "this terminal's link");
    } else if (attempt.revoked) {
      // The one final answer: the user pressed "Unlink terminal" in the Desk.
      // The EA is allowed to clear the token it holds for this and only this.
      return res.status(401).json({
        error: "This link was revoked — the terminal was unlinked from the Desk.",
        code: "bridge_link_revoked",
      });
    }
  }
  if (!desk || !desk.terminal) {
    return res
      .status(401)
      .json({ error: "Invalid or revoked bridge token.", code: "bridge_token_unknown" });
  }

  const presentedToken = bearerToken(req);
  touchBridgeLink(presentedToken);

  // ── Has this account been claimed by another Desk since the last beat? ───
  // The token is still cryptographically valid, so this is the only place the
  // superseded terminal can be stopped. Letting it continue would mean two
  // Desks streaming one account and each arming plans against it.
  const accountKey = accountKeyFor(desk.terminal.login, desk.terminal.server);
  if (!touchClaim(desk.sessionId, accountKey)) {
    const { login, server } = desk.terminal;
    const tokens = revokeBridgeTokens(desk);
    for (const token of tokens) await revokeBridgeLink(token);
    desk.terminal = null;
    clearTerminalData(desk);
    journal(
      desk,
      "bridge",
      null,
      `MetaTrader 5 account ${login}@${server} was connected in another browser. This Desk has been unlinked so two desks never trade one balance.`,
    );
    logger.warn({ login, server }, "MT5 heartbeat rejected: account claimed by another session");
    return res
      .status(409)
      .json({ error: "This MT5 account is now connected in another browser.", code: "account_claimed_elsewhere" });
  }

  const body = req.body ?? {};
  const seq = Math.round(num(body.seq));
  const now = Date.now();

  /**
   * ── Sequence numbers are per EA INSTANCE ────────────────────────────────
   *
   * `seq` is a counter that the EA increments per heartbeat, and it was
   * compared against a single stored value. That only holds for one instance:
   * a second chart running the same EA (or an instance that restarted) starts
   * its counter near zero, so the desk saw "seq went backwards" and concluded
   * the terminal had restarted — clearing every armed plan and dropping the
   * setups the user had just approved, on every alternating beat.
   *
   * With an instance id the two cases are distinguishable:
   *   • same instance, lower seq  → a genuine restart of that instance;
   *   • different instance        → an additional (or replaced) terminal, whose
   *     local plan array is empty, so the Desk re-delivers its armed plans
   *     instead of discarding them.
   */
  const instanceId = typeof body.instanceId === "string" ? body.instanceId.trim().slice(0, 64) : "";
  const previousInstance = desk.terminal.instanceId;
  if (instanceId) {
    if (instanceId === previousInstance) {
      if (seq > 0 && seq < desk.terminal.lastSeq) {
        journal(desk, "bridge", null, "Terminal restarted — armed plans cleared and state resynchronised.");
        desk.plans.clear();
        desk.inflight.clear();
      }
    } else {
      if (previousInstance !== null) {
        const resent = resendArmedPlans(desk, now);
        journal(
          desk,
          "bridge",
          null,
          resent > 0
            ? `A new terminal instance joined this link; ${resent} armed plan(s) were re-sent to it so nothing was left on screen untraded.`
            : "A new terminal instance joined this link.",
        );
      }
      desk.terminal.instanceId = instanceId;
      desk.terminal.lastSeq = 0;
    }
  } else if (seq > 0 && seq < desk.terminal.lastSeq) {
    // Legacy EA without an instance id: keep the original heuristic.
    desk.plans.clear();
    desk.inflight.clear();
    journal(desk, "bridge", null, "Terminal restarted — armed plans cleared and state resynchronised.");
  }
  desk.terminal.lastSeq = seq;
  desk.terminal.lastSyncAt = now;

  if (typeof body.version === "string" && body.version.trim()) {
    desk.terminal.eaVersion = body.version.trim().slice(0, 32);
  }

  const account = parseAccount(body.account);
  if (account) applyAccount(desk, account);

  // The EA normally ships the whole catalogue once during pairing. Accepting a
  // later refresh handles broker symbol-list changes without a re-pair.
  if (Array.isArray(body.catalog)) {
    for (const raw of body.catalog) {
      const entry = parseCatalogEntry(raw);
      if (entry) desk.catalog.set(entry.symbol, entry);
    }
  }

  if (Array.isArray(body.specs)) {
    for (const raw of body.specs) {
      const spec = parseSpec(raw);
      if (!spec) continue;
      desk.specs.set(spec.symbol, spec);
      if (!desk.catalog.has(spec.symbol)) {
        desk.catalog.set(spec.symbol, {
          symbol: spec.symbol,
          description: spec.symbol,
          path: "",
          assetClass: spec.assetClass,
          tradeable: true,
        });
      }
    }
  }

  // ── Clock ────────────────────────────────────────────────────────────────
  // The EA now converts terminal timestamps to UTC before sending them, but a
  // terminal whose clock is wrong will still produce unusable timestamps.
  // Measuring the offset here is what lets the desk tell "this quote is 3
  // seconds old" from "this terminal thinks it is 1998".
  const clock = parseClock(body.clock);
  if (clock) {
    const previousSkew = desk.clockSkewMs;
    updateClockSkew(desk, clock.terminalUtcMs, now);
    const skew = desk.clockSkewMs ?? 0;
    if (clock.computerClockSkewMs !== undefined) {
      // v3.04+: the EA self-corrects its timestamps against the platform
      // server's clock, so the measured skew settles near zero and the
      // machine's own clock error is the honest "fix your NTP" signal.
      // Journal it once, when it crosses the 30s line.
      const machineSkew = clock.computerClockSkewMs;
      const prevMachineSkew = desk.prevComputerClockSkewMs;
      desk.prevComputerClockSkewMs = machineSkew;
      desk.computerClockSkewMs = machineSkew;
      if (Math.abs(machineSkew) > 30_000 && Math.abs(prevMachineSkew ?? 0) <= 30_000) {
        journal(
          desk,
          "bridge",
          null,
          `The machine running the MT5 terminal has its clock ${Math.round(Math.abs(machineSkew) / 1000)}s ` +
            `${machineSkew > 0 ? "ahead of" : "behind"} this server. The EA corrects its timestamps automatically; ` +
            `sync the machine's clock (NTP) to keep time-based features inside the terminal exact.`,
        );
      }
    } else if (Math.abs(skew) > 30_000 && Math.abs(previousSkew ?? 0) <= 30_000) {
      // Legacy EA: the measured timestamp skew IS the machine clock. Journal
      // once when it appears, so the desk's own record shows it without
      // alarming the dashboard — ages are corrected either way.
      journal(
        desk,
        "bridge",
        null,
        `The MT5 terminal's clock is ${Math.round(skew / 1000)}s ${skew > 0 ? "ahead of" : "behind"} this server. ` +
          `Quote ages are corrected automatically; sync the machine's clock (NTP) to keep time-based features inside the terminal exact.`,
      );
    }
    // The terminal's own heartbeat contract. Recorded (not assumed) so the
    // desk's staleness window can be sized from it: an EA configured to beat
    // every 10 seconds must not be declared dead after 30. A missing value
    // leaves the fixed window in place.
    if (clock.syncIntervalMs) desk.terminal.syncIntervalMs = clock.syncIntervalMs;
  }

  // ── Bar counts (EA v3.04+) ───────────────────────────────────────────────
  // The EA reports how many bars the terminal holds per symbol|timeframe.
  // The desk asks for history only while the terminal holds bars it lacks
  // (history.ts), so a series the terminal cannot fill never triggers a
  // re-seed — which is what used to stall the heartbeat and freeze the desk
  // on stale data.
  for (const [key, count] of parseBarsAvailable(body.barsAvailable)) {
    desk.historyAvailable.set(key, count);
  }

  if (Array.isArray(body.quotes)) {
    let accepted = 0;
    let rejected = 0;
    for (const raw of body.quotes) {
      const quote = parseQuote(raw);
      if (!quote) {
        rejected++;
        continue;
      }
      // A quote timestamped hours away from now cannot be a real tick. Keeping
      // it would pin the symbol's freshness check permanently open or shut.
      if (!quoteTimestampUsable(desk, quote, now)) {
        rejected++;
        continue;
      }
      desk.quotes.set(quote.symbol, quote);
      // WP7's spread z-score compares this quote with the ones this symbol has
      // actually shown the desk. The flag is checked once per heartbeat, not per
      // quote, so a switched-off desk pays nothing for the check.
      if (v4On(deskV4().execution)) recordSpread(getSpreadHistory(), quote.symbol, quote.spreadPoints);
      const spec = desk.specs.get(quote.symbol);
      if (spec) spec.spreadPoints = quote.spreadPoints;
      // Feed the tick into the sub-minute bar builder. MetaTrader has no
      // period faster than M1, so S10/S30 exist only because this runs on
      // every accepted tick (see subminute.ts).
      recordTick(ticksFor(desk, quote.symbol), quote);
      accepted++;
    }
    if (rejected > 0) {
      // Loud, but only once per heartbeat — a permanently misclocked terminal
      // is a support problem the user must be able to see.
      logger.warn({ accepted, rejected, skewMs: desk.clockSkewMs }, "MT5 heartbeat quotes rejected on timestamp sanity");
    }
    if (accepted > 0) {
      const ages = desk.watchlist
        .map((symbol) => feedHealth(desk, symbol, now).ageMs)
        .filter((age): age is number => typeof age === "number");
      desk.lastQuoteAgeMs = ages.length > 0 ? Math.round(Math.max(...ages)) : null;
    }
  }

  // Symbols the user has deselected must stop contributing quotes, specs and
  // candles immediately, or their last price lingers on screen as if live.
  pruneDeselectedSymbols(desk);

  if (Array.isArray(body.candles)) {
    for (const raw of body.candles) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const symbol = String(r.symbol ?? "");
      const timeframe = String(r.timeframe ?? "");
      if (!symbol || !(TIMEFRAMES as readonly string[]).includes(timeframe)) continue;
      const bars = parseBars(r.bars, (time) => barTimestampUsable(desk, time, now));
      if (bars.length > 0) upsertCandles(desk, { symbol, timeframe: timeframe as Timeframe, bars });
    }
  }

  const news = parseNewsFeed(body.news);
  if (news) desk.news = news;

  if (Array.isArray(body.positions)) {
    const positions = (body.positions as unknown[])
      .map(parsePosition)
      .filter((position): position is Position => position !== null);
    const { opened, closed } = reconcilePositions(desk, positions);

    for (const position of opened) {
      journal(desk, "execution", position.symbol, `Position #${position.ticket} opened: ${position.side} ${position.volume} @ ${position.openPrice}.`);
    }
    for (const position of closed) {
      const net = position.profit + position.swap + position.commission;
      desk.riskState = recordOutcome(desk.riskState, { symbol: position.symbol, profit: net, closedAt: now }, desk.policy);
      // WP7's timing ledger: one realised outcome, in R, against the moment the
      // desk acted. The terminal does not report which plan produced the fill,
      // so the position's own open time is the timestamp — exact for immediate
      // entries, and an approximation for a resting one (documented in
      // docs/mt5-live-desk-v4.md, §9). The denominator is the risk the EA
      // recorded at fill (`initialRiskMoney`); without it the trade carries no
      // R and is not recorded at all, rather than recorded as a fabricated one.
      if (v4On(deskV4().execution) && position.initialRiskMoney && position.initialRiskMoney > 0) {
        recordTimingOutcome(getTimingLedger(), { timestampMs: position.openTime, rMultiple: net / position.initialRiskMoney });
      }
      journal(desk, "execution", position.symbol, `Position #${position.ticket} closed: ${net >= 0 ? "+" : ""}${net.toFixed(2)}.`, {
        consecutiveLosses: desk.riskState.consecutiveLosses,
      });
      // ── WP9: the durable close, and the e-process ────────────────────────
      //
      // One trade row, one resolved shadow evaluation and one outcome per agent
      // that proposed it. `initialRiskMoney` is the denominator and it is the
      // EA's own stamp — when it is absent the row is still written, with a NULL
      // realised R, because a trade the desk cannot measure is a fact the weekly
      // report has to be able to count. Any agent whose threshold is crossed is
      // named in the journal: an agent going out of service is not a silent
      // event. Fire-and-forget, so a ledger write can never delay a heartbeat.
      if (v4On(deskV4().governance)) {
        void recordClosedTrade({
          sessionId: desk.sessionId,
          ticket: position.ticket,
          symbol: position.symbol,
          mode: desk.mode,
          side: position.side,
          lots: position.volume,
          openedAtMs: position.openTime,
          closedAtMs: now,
          netProfit: net,
          riskMoney: position.initialRiskMoney ?? null,
          slippageR: null,
          entryPrice: position.openPrice ?? null,
          // MT5 reports the closed position without an exit price in this
          // payload; the trade row carries the entry and the realised money, and
          // the exit reason stays NULL rather than being guessed from profit.
          exitPrice: null,
          exitReason: null,
        })
          .then(({ actions }) => {
            for (const action of actions) {
              if (action.action === "none") continue;
              const verb = action.action === "disable" ? "DISABLED" : "halved";
              journal(
                desk,
                "risk",
                position.symbol,
                `Agent ${action.agentId} ${verb} by the WP9 e-process (e=${action.eValue.toFixed(1)}): ${action.reason}`,
              );
              // The one event in this layer a human must not have to go looking
              // for: an agent has just taken itself out of service.
              deskAlertNow({
                kind: "governance",
                title: `Agent ${action.agentId} ${verb} (e=${action.eValue.toFixed(1)})`,
                body: [action.reason, `${position.symbol} · ticket #${position.ticket}`],
                dedupeKey: `governance:${action.agentId}:${action.action}`,
                sessionId: desk.sessionId,
              });
            }
          })
          .catch(() => {});
      }
      if (desk.riskState.haltedUntilNextSession) {
        journal(desk, "risk", null, desk.riskState.haltReason ?? "Desk halted.");
        // A halt is the loudest thing the desk does. De-duped on the reason, so a
        // long halt is one message however many positions close inside it.
        deskAlertNow({
          kind: "risk",
          title: "Desk halted",
          body: [desk.riskState.haltReason ?? "Desk halted.", `consecutive losses ${desk.riskState.consecutiveLosses}`],
          dedupeKey: `halt:${desk.riskState.haltReason ?? "unknown"}`,
          sessionId: desk.sessionId,
        });
      }
    }
  }

  if (Array.isArray(body.results)) {
    for (const raw of body.results) {
      const result = parseResult(raw);
      if (!result) continue;
      // Read the command BEFORE acknowledging it: the acknowledgement clears the
      // in-flight entry, and the plan embedded in an `arm_plan` command carries
      // the trigger and the risk unit the fill must be judged against.
      const command = desk.inflight.get(result.commandId)?.command ?? null;
      if (!acknowledgeResult(desk, result)) continue;
      if (
        result.status === "filled" &&
        v4On(deskV4().execution) &&
        command?.type === "arm_plan" &&
        command.plan.side !== undefined
      ) {
        const spec = desk.specs.get(command.plan.symbol);
        const risk = (command.plan.riskPoints ?? 0) * (spec?.point ?? 0);
        const fill = result.price ?? null;
        const slippage =
          fill !== null && risk > 0
            ? signedSlippageR({ side: command.plan.side, plannedPrice: command.plan.trigger, fillPrice: fill, riskPrice: risk })
            : null;
        if (slippage !== null) recordSlippage(getSlippageLedger(), slippage);
      }
      // WP9's attribution join: the fill is the only moment the desk learns that
      // THIS ticket came from THAT plan, and the plan is what remembers which
      // agents proposed it. Recorded whenever governance is on, independently of
      // whether the execution layer is measuring slippage.
      if (result.status === "filled" && result.ticket !== undefined && command?.type === "arm_plan") {
        if (v4On(deskV4().governance)) bindTicket(result.ticket, command.plan.id);
      }
      if (result.status === "rejected") {
        journal(desk, "execution", null, `Command rejected by the terminal: ${result.error ?? "unknown error"}.`, result);
      } else if (result.status === "filled") {
        journal(desk, "execution", null, `Filled at ${result.price} (slippage ${result.slippagePoints ?? 0} pts), ticket #${result.ticket}.`, result);
      }
    }
  }

  const expired = expirePlans(desk, now);
  if (expired.length > 0) journal(desk, "signal", null, `${expired.length} armed plan(s) expired untriggered.`);
  requeueStaleCommands(desk);

  // Ask only for history for selected symbols that the terminal has actually
  // reported. A large catalogue does not trigger megabytes of unused history.
  //
  // The exact rule lives in history.ts: with the EA's bar counts the desk asks
  // only while the terminal holds bars it lacks; legacy EAs get a bounded
  // request count. Either way, one thin series can no longer keep `needsHistory`
  // true forever and re-seed a multi-megabyte payload on every heartbeat.
  const reported = new Set(desk.specs.keys());
  const historyKeys = computeHistoryNeeded(desk, reported);
  recordLegacyHistoryRequests(desk, historyKeys);
  const needsHistory = historyKeys.length > 0;

  // ── The owner's policy, enforced on every open position ──────────────────
  //
  // Runs on every heartbeat, AFTER positions have been folded in, and it is
  // what makes a setting true rather than aspirational:
  //
  //   • a position the EA opened itself (a manual trade, a pending order that
  //     filled while the desk was redeploying) has never been sent a policy, so
  //     it gets one here — otherwise it is the one position in the terminal
  //     with no partials and no break-even rule at all;
  //   • a position whose policy was set before the owner changed the settings
  //     is re-sent, because its fingerprint no longer matches;
  //   • a position whose policy already matches is left alone — this runs at
  //     the heartbeat's own rate and a stop modification must never be chatter.
  try {
    const pushed = reconcileManagement(desk);
    if (pushed.length > 0) {
      journal(
        desk,
        "execution",
        null,
        `Management policy sent to ${pushed.length} position${pushed.length === 1 ? "" : "s"} (#${pushed.join(", #")}).`,
      );
    }
  } catch (err) {
    logger.warn({ err }, "Management reconcile failed");
  }

  // ── Automatic best-market pass ───────────────────────────────────────────
  // Runs here — after quotes, candles and positions have been folded in and
  // before the browser is updated — so the desk arms the best of the user's
  // selected markets on the same tick the decision was based on. Throttled per
  // mode; every gate the manual path uses still applies.
  try {
    maybeAutoSelect(desk, now);
  } catch (err) {
    logger.warn({ err }, "Auto-select pass failed");
  }

  // ── Beat health sample ───────────────────────────────────────────────────
  // The heartbeat is the desk's lifeline: a beat that takes seconds ages every
  // quote past the freshness gate. Sample the round trip (and the payload
  // size) so a slow heartbeat is measurable in /bridge/status and the logs
  // instead of guessed from a stale board.
  const rttMs = Date.now() - startedAt;
  desk.beatRttSamples.push(rttMs);
  if (desk.beatRttSamples.length > 20) desk.beatRttSamples.splice(0, desk.beatRttSamples.length - 20);
  logger.debug(
    { rttMs, bytes: Number(req.headers["content-length"] ?? 0), historyKeys: historyKeys.length },
    "MT5 heartbeat",
  );

  // ── Push the new prices to the browser immediately ───────────────────────
  // The Desk used to be polled every 4 s, so a quote could be four seconds
  // old before it was even rendered and up to a full rotation old on symbols
  // the EA had not reached yet. The moment the terminal's heartbeat lands, the
  // browser gets it.
  try {
    broadcastSSE("desk", deskSummary(desk, now), desk.sessionId);
  } catch (err) {
    logger.debug({ err }, "Desk stream broadcast failed");
  }

  const response: SyncResponse = {
    serverTime: now,
    commands: drainOutbox(desk),
    needsHistory,
    // v3.04+ EAs re-seed exactly these series instead of the whole batch.
    history: historyKeys,
    subscriptions: { symbols: desk.watchlist, timeframes: [...TIMEFRAMES] },
    news: desk.news,
    limits: {
      maxDailyLossPct: desk.policy.maxDailyLossPct,
      maxOpenPositions: desk.policy.maxOpenPositions,
      // Auto-trade ON authorises the desk to create plans by itself. A plan the
      // USER armed must be executable regardless of the auto toggle — the EA
      // refuses every arm_plan when this flag is false, so gating it on
      // autoTrade alone silently discarded hand-armed setups ("trading disabled
      // by server" in the MT5 log, nothing on screen). Risk state still wins.
      tradingEnabled: (desk.autoTrade || desk.plans.size > 0) && !desk.riskState.haltedUntilNextSession,
      liveTradingEnabled: desk.policy.liveTradingEnabled,
      staleAfterMs: 30_000,
      flatOnDisconnect: false,
    },
  };
  return res.json(response);
});

/** Deployment readiness, unlike /healthz's backwards-compatible HTTP 200. */
router.get("/ready", async (_req, res) => {
  const store = await bridgeStoreReport(true);
  const sharedStore = process.env.NODE_ENV !== "production" || store.backend === "postgres";
  const ready = store.reachable && store.schemaApplied && sharedStore;
  return res.status(ready ? 200 : 503).json({
    ready,
    store,
    ...(!sharedStore ? { error: "Configure a shared PostgreSQL DATABASE_URL on the API service before pairing MT5." } : {}),
  });
});

/** Browser-facing liveness / diagnostic view. */
router.get("/status", async (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  /**
   * Where the link actually lives.
   *
   * A deployment without a `postgres://` DATABASE_URL falls back to embedded
   * PGlite, which is a file inside the container — so every restart, every
   * second replica and every cold start forgets the pairing code and the bearer
   * token, and the terminal's link dies with it. That used to be invisible:
   * the dialog promised "the link is durable, only Unlink ends it" while the
   * store underneath it was not. The dialog can now say which of the two it is.
   */
  const store = await bridgeStoreReport();
  // Surfaced even while unlinked: the EA performs the pairing, so without this
  // the dialog would sit on "waiting for the terminal" forever while the MT5
  // log quietly explains that the account is already connected elsewhere.
  const lastPairingError = desk.lastPairingError?.message ?? null;
  if (!desk.terminal) {
    return res.json({
      linked: false,
      catalogCount: 0,
      selectedCount: 0,
      lastPairingError,
      store,
      // The contract, stated even with nothing connected: the dialog tells the
      // user what will and will not end a link BEFORE they trust it with an
      // account. One statement, in both branches — the previous split is how
      // the dialog came to promise durability the server did not implement.
      durable: true,
      linkModel: "unlink-or-terminal-close" as const,
      linkEndsWithTerminal: false,
      resumesAutomatically: true,
      leaseMs: BRIDGE_LINK_LEASE_MS,
    });
  }

  /**
   * Staleness is judged by the SAME rules the desk trades by — the two-stage
   * window in live.ts, sized from the heartbeat the terminal reports. This
   * endpoint had its own hardcoded 30-second cliff, so the dialog could tell
   * the user the link was dead while the desk was still analysing normally.
   */
  const now = Date.now();
  // Version skew is judged numerically so a string comparison can never claim
  // "3.9" is older than "3.10".
  const reported = (desk.terminal.eaVersion ?? "").split(".").map((part) => Number(part));
  const expected = EXPECTED_EA_VERSION.split(".").map((part) => Number(part));
  const eaUpdateAvailable =
    reported.some((part) => !Number.isFinite(part)) ||
    reported[0] < expected[0] ||
    (reported[0] === expected[0] && (reported[1] ?? 0) < (expected[1] ?? 0));

  return res.json({
    linked: true,
    accountId: desk.terminal.accountId,
    login: desk.terminal.login,
    server: desk.terminal.server,
    company: desk.terminal.company,
    pairedAt: desk.terminal.pairedAt,
    lastSyncAt: desk.terminal.lastSyncAt,
    lastSyncAgeMs: terminalSilenceMs(desk, now),
    stale: !terminalIsFresh(desk, now),
    degraded: terminalIsDegraded(desk, now),
    degradedAfterMs: TERMINAL_DEGRADED_MS,
    staleAfterMs: terminalStaleWindowMs(desk),
    syncIntervalMs: desk.terminal.syncIntervalMs || null,
    /**
     * ── THE LIFETIME RULE, AS THE DESK STATES IT TO THE USER ─────────────────
     *
     * A link ends for two reasons: the user unlinks the terminal from the Desk,
     * or the user closes MT5. Nothing else — not silence, not a redeploy, not a
     * refused heartbeat, not a slow store.
     *
     * `resumesAutomatically` is the part that matters when MT5 is closed and
     * reopened: the terminal keeps its link credential on disk, so the next
     * session re-adopts the SAME link instead of asking the user for a new
     * pairing code. Closing MT5 therefore ends the streaming session, not the
     * pairing.
     *
     * `leaseMs` is still reported, and it now means only "this long without a
     * heartbeat and the Desk shows the terminal as stale" — a display state,
     * not a deadline after which anything is revoked.
     */
    durable: true,
    linkModel: "unlink-or-terminal-close" as const,
    linkEndsWithTerminal: false,
    resumesAutomatically: true,
    leaseMs: BRIDGE_LINK_LEASE_MS,
    store,
    eaVersion: desk.terminal.eaVersion,
    expectedEaVersion: EXPECTED_EA_VERSION,
    eaUpdateAvailable,
    queuedCommands: desk.outbox.length,
    inflightCommands: desk.inflight.size,
    catalogCount: desk.catalog.size,
    selectedCount: desk.watchlist.length,
    calendarAvailable: desk.news.available,
    calendarAgeMs: desk.news.checkedAt ? Date.now() - desk.news.checkedAt : null,
    clockSkewMs: desk.clockSkewMs,
    /**
     * The terminal MACHINE's own clock error (EA v3.04+). The EA self-corrects
     * its timestamps against this server's clock, so this is a calm "sync NTP"
     * signal — not a data-quality alarm.
     */
    computerClockSkewMs: desk.computerClockSkewMs,
    lastQuoteAgeMs: desk.lastQuoteAgeMs,
    /** Rolling heartbeat round-trip health (ms), for diagnosing a slow beat. */
    lastBeatRttMs: desk.beatRttSamples.length > 0 ? desk.beatRttSamples[desk.beatRttSamples.length - 1] : null,
    avgBeatRttMs: desk.beatRttSamples.length > 0
      ? Math.round(desk.beatRttSamples.reduce((sum, value) => sum + value, 0) / desk.beatRttSamples.length)
      : null,
    lastPairingError,
  });
});

export default router;
export { makePairingCode, pendingPairings };
export const __testing = {
  randomCommandId: randomUUID,
  /** Drive the heartbeat-lease sweep by hand, as the interval would. */
  sweepExpiredLinks,
};
