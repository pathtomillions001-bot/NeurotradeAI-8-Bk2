/**
 * MetaTrader 5 bridge API.
 *
 * The EA is the only market-data and execution client for the multi-asset
 * Desk. A pairing code creates a bearer token scoped to one browser session;
 * MT5 passwords never traverse this service. The bridge accepts the broker's
 * full catalogue at pairing, then only accepts real quotes/candles/account
 * snapshots from the paired terminal — there is no replay fallback.
 */

import { Router, type IRouter, type Request } from "express";
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
import {
  computeHistoryNeeded,
  parseBarsAvailable,
  recordLegacyHistoryRequests,
} from "../lib/multiasset/history";
import {
  accountKeyFor,
  describeConflict,
  releaseClaimsForSession,
  touchClaim,
  tryClaimAccount,
} from "../lib/multiasset/claims";
import {
  acknowledgeResult,
  adoptBridgeToken,
  applyAccount,
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
  revokeBridgeTokens,
  sessionForToken,
  ticksFor,
  upsertCandles,
  issueBridgeToken,
  type DeskState,
} from "../lib/multiasset/store";
import {
  PAIRING_CODE_TTL_MS,
  deletePairingCodesForSession,
  loadBridgeLink,
  loadPairingCode,
  markPairingCodeRedeemed,
  pairingCodesForSession,
  prunePairingCodes,
  revokeBridgeLink,
  revokeBridgeLinksForSession,
  saveBridgeLink,
  savePairingCode,
  touchBridgeLink,
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
 */
export const EXPECTED_EA_VERSION = "3.04";

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
 * WHY IDEMPOTENT: this used to delete every other code the session owned and
 * mint a new one on every call, and the setup dialog calls it whenever it is
 * reopened. So opening the dialog a second time to read the code out loud
 * invalidated the code the EA was already retrying with, and the MT5 journal
 * filled with `HTTP 401 … Unknown or expired pairing code` every five seconds,
 * forever. A code now lives until the user unlinks the terminal (`unpair`),
 * rotates it explicitly (`{ rotate: true }`), or the sliding 30-day TTL lapses.
 */
router.post("/pairing-code", async (req, res) => {
  const sessionId = getBrowserSessionId();
  const rotate = req.body?.rotate === true;
  const now = Date.now();
  prunePairings(now);

  if (!rotate) {
    const stored = await pairingCodesForSession(sessionId, now);
    const live = stored.find((record) => record.expiresAt > now);
    if (live) {
      rememberPendingPairing(live);
      return res.json({
        pairingCode: live.code,
        expiresInMs: Math.max(0, live.expiresAt - now),
        reused: true,
      });
    }
  } else {
    // An explicit rotation retires the previous codes: leaving them alive would
    // mean a value the user believes they have replaced still pairs.
    await deletePairingCodesForSession(sessionId);
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
  rememberPendingPairing(record);
  await savePairingCode(record);
  return res.json({ pairingCode: code, expiresInMs: PAIRING_CODE_TTL_MS, reused: false });
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
 * Re-pairing the SAME account on the SAME Desk (an EA restart, a redeploy, a
 * second chart) adds a token to the existing link instead of rotating it: two
 * instances invalidating each other is what made the connection flap.
 */
router.post("/pair", async (req, res) => {
  prunePairings();
  const code = String(req.body?.pairingCode ?? "").trim().toUpperCase();
  const terminal = req.body?.terminal ?? {};
  let pairing = pendingPairings.get(code);
  if (!pairing) {
    // Not in this process — a restart may have happened since the code was
    // issued. The durable record is the authority now.
    const stored = await loadPairingCode(code);
    if (stored) {
      pairing = stored;
      rememberPendingPairing(stored);
    }
  }
  if (!pairing) return res.status(401).json({ error: "Unknown or expired pairing code." });

  const login = Number(terminal.login ?? 0);
  const server = String(terminal.server ?? "unknown");
  if (!Number.isFinite(login) || login <= 0) {
    return res.status(400).json({ error: "terminal.login is required." });
  }

  const desk = getDesk(pairing.sessionId);

  // ── Global uniqueness check ──────────────────────────────────────────────
  const claim = await tryClaimAccount({
    login,
    server,
    company: String(terminal.company ?? ""),
    sessionId: pairing.sessionId,
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
  const sameLink = Boolean(
    desk.terminal &&
      desk.terminal.login === Math.trunc(login) &&
      accountKeyFor(desk.terminal.login, desk.terminal.server) === accountKey,
  );

  // The code stays valid (and is marked as used) — that is what lets the same
  // terminal re-pair after a restart without the user fetching a new one.
  await markPairingCodeRedeemed(code);

  if (!sameLink) {
    // A different terminal (or the same Desk linking another account): the
    // previous link's tokens must die, or a superseded terminal could keep
    // streaming and trading this Desk.
    const revoked = revokeBridgeTokens(desk);
    for (const token of revoked) await revokeBridgeLink(token);
    clearTerminalData(desk);
  }
  // Same account, same Desk: the existing tokens stay valid. That is the whole
  // point — two EA instances on one account must not invalidate each other in a
  // re-pair loop, and the command outbox already guarantees that each command is
  // delivered to exactly one of them.

  desk.lastPairingError = null;

  const bridgeToken = issueBridgeToken(pairing.sessionId);
  desk.terminal = {
    accountId: `mt5:${login}@${server}`,
    login,
    server,
    company: String(terminal.company ?? ""),
    bridgeToken,
    tokens: sameLink ? [...(desk.terminal?.tokens ?? []), bridgeToken] : [bridgeToken],
    pairedAt: sameLink ? (desk.terminal?.pairedAt ?? Date.now()) : Date.now(),
    lastSyncAt: Date.now(),
    lastSeq: 0,
    // Kept while the same link continues; the next beat re-reports it anyway.
    instanceId: sameLink ? (desk.terminal?.instanceId ?? null) : null,
    eaVersion: typeof terminal.version === "string" ? terminal.version.slice(0, 32) : null,
    // Filled in from the first heartbeat that reports it. Until then the desk
    // uses its fixed staleness window.
    syncIntervalMs: 0,
  };

  await saveBridgeLink({
    token: bridgeToken,
    sessionId: pairing.sessionId,
    accountKey,
    login,
    server,
    company: String(terminal.company ?? ""),
    pairedAt: desk.terminal.pairedAt,
  });

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
      : `MetaTrader 5 terminal paired: ${login}@${server}. ${catalogCount} broker markets discovered. This account is now reserved for this Desk.`,
  );
  logger.info({ login, server, catalogCount, sameLink }, "MT5 bridge paired");

  return res.status(201).json({
    bridgeToken,
    accountId: desk.terminal.accountId,
    syncIntervalMs: 1000,
    // The EA keeps its link across restarts; `durable` tells a newer EA that
    // the token it saved is expected to keep working.
    durableLink: true,
    subscriptions: { symbols: desk.watchlist, timeframes: TIMEFRAMES },
  });
});

/**
 * Revoke every token, release the global account claim, drop the pairing codes
 * and remove every terminal-derived value.
 *
 * This is the ONLY action that ends a link. Closing MT5, closing the browser or
 * redeploying the API all leave it intact — the terminal reconnects with the
 * token it saved. Releasing the claim is what lets the same account be
 * connected somewhere else afterwards.
 */
router.post("/unpair", async (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  if (!desk.terminal) return res.status(404).json({ error: "No terminal is linked." });

  const { login, server } = desk.terminal;
  const tokens = revokeBridgeTokens(desk);
  for (const token of tokens) await revokeBridgeLink(token);
  await revokeBridgeLinksForSession(desk.sessionId);
  await deletePairingCodesForSession(desk.sessionId);
  forgetPendingPairings(desk.sessionId);
  await releaseClaimsForSession(desk.sessionId);
  desk.terminal = null;
  desk.lastPairingError = null;
  clearTerminalData(desk);
  journal(
    desk,
    "bridge",
    null,
    `MetaTrader 5 terminal unlinked: ${login}@${server} released. The saved link was revoked, so a fresh pairing code is required to connect again.`,
  );
  return res.json({ ok: true, revoked: tokens.length });
});

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

/**
 * Rebuild a Desk whose link survived in the database but not in this process.
 *
 * This is the fix for "the API restarted and the MT5 terminal never came
 * back": the EA keeps heartbeating with the token it saved, the link row still
 * proves it was issued, so the Desk is re-attached and the account claim is
 * re-taken. The user sees a one-line journal entry, not a dead terminal.
 */
async function rehydrateFromDurableLink(req: Request): Promise<DeskState | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const link = await loadBridgeLink(token);
  if (!link || link.revokedAt) return null;

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
      `Desk restored after a server restart: ${link.login}@${link.server} reconnected with its saved link, so no re-pairing was needed.`,
    );
  } else {
    rememberBridgeToken(desk, token);
  }
  return desk.terminal ? desk : null;
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
  if (!desk) desk = await rehydrateFromDurableLink(req);
  if (!desk || !desk.terminal) return res.status(401).json({ error: "Invalid or revoked bridge token." });

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
      journal(desk, "execution", position.symbol, `Position #${position.ticket} closed: ${net >= 0 ? "+" : ""}${net.toFixed(2)}.`, {
        consecutiveLosses: desk.riskState.consecutiveLosses,
      });
      if (desk.riskState.haltedUntilNextSession) {
        journal(desk, "risk", null, desk.riskState.haltReason ?? "Desk halted.");
      }
    }
  }

  if (Array.isArray(body.results)) {
    for (const raw of body.results) {
      const result = parseResult(raw);
      if (!result || !acknowledgeResult(desk, result)) continue;
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

/** Browser-facing liveness / diagnostic view. */
router.get("/status", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  // Surfaced even while unlinked: the EA performs the pairing, so without this
  // the dialog would sit on "waiting for the terminal" forever while the MT5
  // log quietly explains that the account is already connected elsewhere.
  const lastPairingError = desk.lastPairingError?.message ?? null;
  if (!desk.terminal) {
    return res.json({ linked: false, catalogCount: 0, selectedCount: 0, lastPairingError });
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
     * The link is durable: the EA saved its token in the terminal, the server
     * persisted the link, and neither MT5 being closed nor a redeploy ends it.
     * Only "Unlink terminal" does. Surfaced so the dialog can say so plainly
     * instead of warning the user about a ten-minute code that no longer exists.
     */
    durable: true,
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
export const __testing = { randomCommandId: randomUUID };
