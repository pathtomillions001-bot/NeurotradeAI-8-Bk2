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
import { safeSchemaFailureCode } from "@workspace/db";
import { getBrowserSessionId, linkSessionIdentity } from "../lib/session";
import {
  acquireConnector,
  authenticateBridgeToken,
  bindPairing,
  bridgeTokenForCode,
  createPairingCode,
  deleteBridgeLink,
  findPairing,
  restoreBridgeLink,
  saveBridgeLink,
  withBridgeLock,
} from "../lib/multiasset/bridge-links";
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
  accountKeyFor,
  claimHolder,
  describeConflict,
  releaseClaimsForSession,
  touchClaim,
  tryClaimAccount,
} from "../lib/multiasset/claims";
import {
  acknowledgeResult,
  applyAccount,
  candleKey,
  clearTerminalData,
  drainOutbox,
  expirePlans,
  getDesk,
  journal,
  pruneDeselectedSymbols,
  reconcilePositions,
  requeueStaleCommands,
  revokeBridgeToken,
  ticksFor,
  upsertCandles,
  type DeskState,
} from "../lib/multiasset/store";
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

// ── Pairing ──────────────────────────────────────────────────────────────────

router.post("/pairing-code", async (req, res) => {
  const requestId = randomUUID();
  let stage = "link_session_identity";
  try {
    const sessionId = getBrowserSessionId();
    await linkSessionIdentity({
      sessionId,
      clientId: req.clientId ?? null,
      cookieId: req.cookies?.neurotrade_session ?? null,
      tabId: req.isTabSession ? sessionId : null,
    });

    stage = "persist_pairing_code";
    const code = await withBridgeLock(sessionId, () =>
      createPairingCode(sessionId),
    );
    if (typeof code !== "string" || !code.trim()) {
      throw Object.assign(new Error("Pairing-code generator returned an empty value"), {
        code: "EMPTY_PAIRING_CODE",
      });
    }
    return res.json({ pairingCode: code, expiresInMs: null });
  } catch (error) {
    const failureCode = safeSchemaFailureCode(error);
    logger.error(
      { requestId, stage, failureCode },
      "MT5 pairing-code generation failed",
    );
    return res.status(503).json({
      error: {
        code: failureCode === "SCHEMA_NOT_READY"
          ? "database_not_ready"
          : "pairing_code_unavailable",
        message:
          "Pairing code generation is temporarily unavailable. Retry in a moment. If it keeps failing, contact support with the request ID. Use only the code displayed after a successful retry.",
        retryable: true,
        requestId,
      },
    });
  }
});

/**
 * Exchange the reusable private code for a terminal-scoped bearer token.
 *
 * A broker account may only be held by one Desk at a time. Two Desks on one
 * account would both stream it, both arm plans against it and either could
 * flatten positions the other believed it owned — one balance counted against
 * two independent sets of risk limits. The claim is taken here, atomically,
 * before any token exists.
 */
router.post("/pair", async (req, res) => {
  const code = String(req.body?.pairingCode ?? "")
    .trim()
    .toUpperCase();
  const terminal = req.body?.terminal ?? {};
  const pairing = await findPairing(code);
  if (!pairing)
    return res
      .status(401)
      .json({
        error:
          "Unknown or revoked pairing code. Generate a new code in this Desk and check ServerUrl.",
      });

  const login = Number(terminal.login ?? 0);
  const server = String(terminal.server ?? "unknown");
  if (!Number.isFinite(login) || login <= 0) {
    return res.status(400).json({ error: "terminal.login is required." });
  }

  return withBridgeLock(pairing.sessionId, async () => {
    // Recheck after acquiring the lock: an unlink may have won while waiting.
    if (!(await findPairing(code)))
      return res.status(401).json({ error: "Pairing code was revoked." });
    if (!(await bindPairing(code, accountKeyFor(login, server)))) {
      return res
        .status(409)
        .json({
          error:
            "This code is bound to a different MT5 account. Generate a new code to change accounts.",
        });
    }
    const desk = await restoreBridgeLink(pairing.sessionId);

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
      const message = describeConflict(
        claim.holder.login || login,
        claim.holder.server || server,
      );
      desk.lastPairingError = { message, login, server, at: Date.now() };
      journal(desk, "bridge", null, `Pairing refused — ${message}`);
      logger.warn(
        { login, server, heldBySession: claim.holder.sessionId },
        "MT5 pairing refused: account already claimed",
      );
      return res
        .status(409)
        .json({ error: message, code: "account_already_connected" });
    }

    const sameAccount =
      desk.terminal &&
      accountKeyFor(desk.terminal.login, desk.terminal.server) ===
        accountKeyFor(login, server);
    if (desk.terminal) revokeBridgeToken(desk.terminal.bridgeToken);
    if (!sameAccount) clearTerminalData(desk);
    desk.lastPairingError = null;

    const bridgeToken = bridgeTokenForCode(code);
    desk.terminal = {
      accountId: `mt5:${login}@${server}`,
      login,
      server,
      company: String(terminal.company ?? ""),
      bridgeToken,
      pairedAt: sameAccount ? desk.terminal!.pairedAt : Date.now(),
      lastSyncAt: sameAccount ? desk.terminal!.lastSyncAt : 0,
      lastSeq: sameAccount ? desk.terminal!.lastSeq : 0,
      // Filled in from the first heartbeat that reports it. Until then the desk
      // uses its fixed staleness window.
      syncIntervalMs: 0,
    };

    const catalog = Array.isArray(req.body?.catalog) ? req.body.catalog : [];
    let catalogCount = 0;
    for (const raw of catalog) {
      const entry = parseCatalogEntry(raw);
      if (!entry) continue;
      desk.catalog.set(entry.symbol, entry);
      catalogCount++;
    }

    journal(
      desk,
      "bridge",
      null,
      `MetaTrader 5 terminal paired: ${login}@${server}. ${catalogCount} broker markets discovered. This account is now reserved for this Desk.`,
    );
    logger.info({ login, server, catalogCount }, "MT5 bridge paired");

    await saveBridgeLink(desk);
    return res.status(201).json({
      bridgeToken,
      accountId: desk.terminal.accountId,
      syncIntervalMs: 1000,
      subscriptions: { symbols: desk.watchlist, timeframes: TIMEFRAMES },
    });
  });
});

/**
 * Revoke the bearer token, release the global account claim and remove every
 * terminal-derived value.
 *
 * Releasing the claim is what lets the same account be connected somewhere
 * else afterwards; without it the account would stay reserved for a Desk that
 * is no longer using it.
 */
router.post("/unpair", async (_req, res) => {
  return withBridgeLock(getBrowserSessionId(), async () => {
    const desk = await restoreBridgeLink(getBrowserSessionId());
    if (!desk.terminal) {
      await deleteBridgeLink(desk.sessionId);
      await releaseClaimsForSession(desk.sessionId);
      return res.json({ ok: true });
    }

    await deleteBridgeLink(desk.sessionId);
    revokeBridgeToken(desk.terminal.bridgeToken);
    await releaseClaimsForSession(desk.sessionId);
    const { login, server } = desk.terminal;
    desk.terminal = null;
    desk.lastPairingError = null;
    clearTerminalData(desk);
    journal(
      desk,
      "bridge",
      null,
      `MetaTrader 5 terminal unlinked: ${login}@${server} released and live terminal data was cleared.`,
    );
    return res.json({ ok: true });
  });
});

// ── Authentication ───────────────────────────────────────────────────────────

async function deskForRequest(req: Request): Promise<DeskState | null> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token ? authenticateBridgeToken(token) : null;
}

// ── Parse + validate terminal payloads ───────────────────────────────────────

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assetClass(value: unknown): AssetClass {
  return typeof value === "string" &&
    (ASSET_CLASSES as readonly string[]).includes(value)
    ? (value as AssetClass)
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
    baseCurrency:
      typeof r.baseCurrency === "string" ? r.baseCurrency : undefined,
    quoteCurrency:
      typeof r.quoteCurrency === "string" ? r.quoteCurrency : undefined,
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
    marginLevel:
      margin > 0
        ? num(r.marginLevel, (equity / margin) * 100)
        : Number.POSITIVE_INFINITY,
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
    initialRiskMoney:
      r.initialRiskMoney === undefined ? undefined : num(r.initialRiskMoney),
    initialRiskPoints:
      r.initialRiskPoints === undefined ? undefined : num(r.initialRiskPoints),
  };
}

function parseQuote(raw: unknown): Quote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? "");
  const bid = num(r.bid);
  const ask = num(r.ask);
  if (!symbol || !(bid > 0) || !(ask > 0)) return null;
  return {
    symbol,
    bid,
    ask,
    spreadPoints: num(r.spreadPoints),
    ts: num(r.ts, Date.now()),
  };
}

function parseBars(
  raw: unknown,
  timestampUsable?: (time: number) => boolean,
): Bar[] {
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
  return {
    serverUtcOffsetSeconds: Math.round(num(r.serverUtcOffsetSeconds, 0)),
    terminalUtcMs,
    label: typeof r.label === "string" ? r.label.slice(0, 64) : undefined,
    // Only a plausible heartbeat interval is accepted: 250ms (the EA's floor)
    // to 10 minutes. Anything else is noise and is ignored in favour of the
    // fixed window.
    syncIntervalMs:
      syncIntervalMs >= 250 && syncIntervalMs <= 600_000
        ? syncIntervalMs
        : undefined,
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
    status: (["filled", "rejected", "expired", "skipped", "done"].includes(
      status,
    )
      ? status
      : "done") as CommandResult["status"],
    ticket: r.ticket === undefined ? undefined : Math.round(num(r.ticket)),
    price: r.price === undefined ? undefined : num(r.price),
    slippagePoints:
      r.slippagePoints === undefined ? undefined : num(r.slippagePoints),
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
    currency: String(r.currency ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 12),
    country: String(r.country ?? "")
      .trim()
      .slice(0, 128),
    name: name.slice(0, 256),
    importance: "high",
    actual: r.actual === null || r.actual === undefined ? null : num(r.actual),
    forecast:
      r.forecast === null || r.forecast === undefined ? null : num(r.forecast),
    previous:
      r.previous === null || r.previous === undefined ? null : num(r.previous),
  };
}

export function parseNewsFeed(raw: unknown): NewsFeed | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const events = Array.isArray(r.events)
    ? r.events
        .map(parseNewsEvent)
        .filter((event): event is HighImpactNewsEvent => event !== null)
    : [];
  const now = Date.now();
  // Keep a full day of history: the pane lists the day's releases so "0 in the
  // next 24 h" can be read against what already happened.
  const kept = events
    .filter(
      (event) =>
        event.time >= now - 24 * 60 * 60_000 &&
        event.time <= now + 48 * 60 * 60_000,
    )
    .sort((a, b) => a.time - b.time);
  const rawCount = Number.isFinite(num(r.rawCount, NaN))
    ? Math.max(0, Math.round(num(r.rawCount)))
    : undefined;
  return {
    available: r.available === true && rawCount !== 0,
    checkedAt: num(r.checkedAt, now),
    events: kept,
    detail: typeof r.detail === "string" ? r.detail.slice(0, 500) : undefined,
    // Passed through untouched: the desk needs to know whether the terminal
    // actually read calendar rows (rawCount) or returned nothing at all.
    rawCount,
    redCount: Number.isFinite(num(r.redCount, NaN))
      ? Math.max(0, Math.round(num(r.redCount)))
      : kept.length,
  };
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

/** POST /api/bridge/sync — the EA's authenticated state heartbeat. */
router.post("/sync", async (req, res) => {
  const desk = await deskForRequest(req);
  if (!desk || !desk.terminal)
    return res.status(401).json({ error: "Invalid or revoked bridge token." });

  return withBridgeLock(desk.sessionId, async () => {
    if (!(await deskForRequest(req)) || !desk.terminal)
      return res
        .status(401)
        .json({ error: "Invalid or revoked bridge token." });
    const instanceId = String(req.body?.instanceId ?? "").trim();
    if (!instanceId || instanceId.length > 128)
      return res
        .status(426)
        .json({
          error:
            "Install NeurotradeBridge v3.03 or later: this connector must identify its executor instance.",
        });
    const lease = await acquireConnector(
      desk.sessionId,
      instanceId,
      Date.now(),
    );
    if (!lease.ok)
      return res
        .status(423)
        .json({
          error:
            "Another MT5 connector is active for this Desk. This chart is on standby.",
        });
    if (lease.changed) {
      desk.plans.clear();
      desk.inflight.clear();
      desk.outbox = [];
      journal(
        desk,
        "bridge",
        null,
        "Connector handover — pending plans cancelled, never replayed. Positions will reconcile from MT5.",
      );
    }
    // Restore the account claim after an API restart, without letting an idle
    // terminal lose ownership to another browser.
    const restoredClaim = claimHolder(
      accountKeyFor(desk.terminal.login, desk.terminal.server),
    )
      ? { ok: true }
      : await tryClaimAccount({
          login: desk.terminal.login,
          server: desk.terminal.server,
          company: desk.terminal.company,
          sessionId: desk.sessionId,
        });
    if (!restoredClaim.ok)
      return res
        .status(409)
        .json({
          error: describeConflict(desk.terminal.login, desk.terminal.server),
          code: "account_claimed_elsewhere",
        });
    // ── Has this account been claimed by another Desk since the last beat? ───
    // The token is still cryptographically valid, so this is the only place the
    // superseded terminal can be stopped. Letting it continue would mean two
    // Desks streaming one account and each arming plans against it.
    const accountKey = accountKeyFor(desk.terminal.login, desk.terminal.server);
    if (!touchClaim(desk.sessionId, accountKey)) {
      const { login, server } = desk.terminal;
      revokeBridgeToken(desk.terminal.bridgeToken);
      desk.terminal = null;
      clearTerminalData(desk);
      journal(
        desk,
        "bridge",
        null,
        `MetaTrader 5 account ${login}@${server} was connected in another browser. This Desk has been unlinked so two desks never trade one balance.`,
      );
      logger.warn(
        { login, server },
        "MT5 heartbeat rejected: account claimed by another session",
      );
      return res
        .status(409)
        .json({
          error: "This MT5 account is now connected in another browser.",
          code: "account_claimed_elsewhere",
        });
    }

    const body = req.body ?? {};
    const seq = Math.round(num(body.seq));
    const now = Date.now();

    if (seq > 0 && seq <= desk.terminal.lastSeq) {
      desk.plans.clear();
      desk.inflight.clear();
      desk.outbox = [];
      journal(
        desk,
        "bridge",
        null,
        "Terminal restarted — armed plans cleared and state resynchronised.",
      );
    }
    desk.terminal.lastSeq = seq;
    desk.terminal.lastSyncAt = now;

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
      updateClockSkew(desk, clock.terminalUtcMs, now);
      // The terminal's own heartbeat contract. Recorded (not assumed) so the
      // desk's staleness window can be sized from it: an EA configured to beat
      // every 10 seconds must not be declared dead after 30. A missing value
      // leaves the fixed window in place.
      if (clock.syncIntervalMs)
        desk.terminal.syncIntervalMs = clock.syncIntervalMs;
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
        logger.warn(
          { accepted, rejected, skewMs: desk.clockSkewMs },
          "MT5 heartbeat quotes rejected on timestamp sanity",
        );
      }
      if (accepted > 0) {
        const ages = desk.watchlist
          .map((symbol) => feedHealth(desk, symbol, now).ageMs)
          .filter((age): age is number => typeof age === "number");
        desk.lastQuoteAgeMs =
          ages.length > 0 ? Math.round(Math.max(...ages)) : null;
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
        if (!symbol || !(TIMEFRAMES as readonly string[]).includes(timeframe))
          continue;
        const bars = parseBars(r.bars, (time) =>
          barTimestampUsable(desk, time, now),
        );
        if (bars.length > 0)
          upsertCandles(desk, {
            symbol,
            timeframe: timeframe as Timeframe,
            bars,
          });
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
        journal(
          desk,
          "execution",
          position.symbol,
          `Position #${position.ticket} opened: ${position.side} ${position.volume} @ ${position.openPrice}.`,
        );
      }
      for (const position of closed) {
        const net = position.profit + position.swap + position.commission;
        desk.riskState = recordOutcome(
          desk.riskState,
          { symbol: position.symbol, profit: net, closedAt: now },
          desk.policy,
        );
        journal(
          desk,
          "execution",
          position.symbol,
          `Position #${position.ticket} closed: ${net >= 0 ? "+" : ""}${net.toFixed(2)}.`,
          {
            consecutiveLosses: desk.riskState.consecutiveLosses,
          },
        );
        if (desk.riskState.haltedUntilNextSession) {
          journal(
            desk,
            "risk",
            null,
            desk.riskState.haltReason ?? "Desk halted.",
          );
        }
      }
    }

    if (Array.isArray(body.results)) {
      for (const raw of body.results) {
        const result = parseResult(raw);
        if (!result || !acknowledgeResult(desk, result)) continue;
        if (["rejected", "skipped", "expired"].includes(result.status)) {
          journal(
            desk,
            "execution",
            null,
            `Terminal ${result.status}: ${result.error ?? "unknown error"}.`,
            result,
          );
        } else if (result.status === "filled") {
          journal(
            desk,
            "execution",
            null,
            `Filled at ${result.price} (slippage ${result.slippagePoints ?? 0} pts), ticket #${result.ticket}.`,
            result,
          );
        }
      }
    }

    const expired = expirePlans(desk, now);
    if (expired.length > 0)
      journal(
        desk,
        "signal",
        null,
        `${expired.length} armed plan(s) expired untriggered.`,
      );
    requeueStaleCommands(desk);

    // Ask only for history for selected symbols that the terminal has actually
    // reported. A large catalogue does not trigger megabytes of unused history.
    const reported = new Set(desk.specs.keys());
    const needsHistory = desk.watchlist
      .filter((symbol) => reported.has(symbol))
      .some((symbol) =>
        TIMEFRAMES.some((timeframe) => {
          const series = desk.candles.get(candleKey(symbol, timeframe));
          return !series || series.bars.length < 60;
        }),
      );

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
        tradingEnabled:
          (desk.autoTrade || desk.plans.size > 0) &&
          !desk.riskState.haltedUntilNextSession,
        liveTradingEnabled: desk.policy.liveTradingEnabled,
        staleAfterMs: 30_000,
        flatOnDisconnect: false,
      },
    };
    await saveBridgeLink(desk);
    return res.json(response);
  });
});

/** Browser-facing liveness / diagnostic view. */
router.get("/status", async (_req, res) => {
  const desk = await restoreBridgeLink(getBrowserSessionId());
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
    });
  }

  /**
   * Staleness is judged by the SAME rules the desk trades by — the two-stage
   * window in live.ts, sized from the heartbeat the terminal reports. This
   * endpoint had its own hardcoded 30-second cliff, so the dialog could tell
   * the user the link was dead while the desk was still analysing normally.
   */
  const now = Date.now();
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
    queuedCommands: desk.outbox.length,
    inflightCommands: desk.inflight.size,
    catalogCount: desk.catalog.size,
    selectedCount: desk.watchlist.length,
    calendarAvailable: desk.news.available,
    calendarAgeMs: desk.news.checkedAt
      ? Date.now() - desk.news.checkedAt
      : null,
    clockSkewMs: desk.clockSkewMs,
    lastQuoteAgeMs: desk.lastQuoteAgeMs,
    lastPairingError,
  });
});

export default router;
export const __testing = { randomCommandId: randomUUID };
