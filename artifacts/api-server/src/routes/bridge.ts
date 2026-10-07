/**
 * Multi-Asset Desk — MetaTrader 5 bridge API.
 *
 * This is the only endpoint the Expert Advisor talks to. Three properties
 * matter more than anything else here:
 *
 * 1. NO CREDENTIALS. The EA never sends an MT5 password, and the server never
 *    stores one. Pairing proves possession of a terminal by echoing a code the
 *    user read off the screen; the server returns a bearer token scoped to one
 *    browser session. The blast radius of a database leak is an account
 *    NUMBER, not the ability to trade someone's money.
 *
 * 2. IDEMPOTENCY. Every command carries a UUID. A sync that is retried after a
 *    timeout must never open a second position, so commands stay in flight
 *    until acknowledged and the EA keeps its own seen-set.
 *
 * 3. FAIL-SAFE DEFAULTS. The response always carries the risk limits, so an EA
 *    that loses contact with the server degrades to manage-only rather than
 *    trading blind.
 */

import { Router, type IRouter, type Request } from "express";
import { randomInt, randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { getBrowserSessionId } from "../lib/session";
import { createRiskState, recordOutcome } from "../lib/multiasset/risk";
import { inferAssetClass, normalizeAssetClass } from "../lib/multiasset/catalog";
import {
  NEWS_BLACKOUT_AFTER_MS,
  NEWS_BLACKOUT_BEFORE_MS,
  NEWS_CALENDAR_MAX_AGE_MS,
  assessNewsEntry,
  isNewsCalendarReady,
  newsGuardFromSnapshot,
} from "../lib/multiasset/news";
import {
  acknowledgeResult,
  applyAccount,
  candleKey,
  drainOutbox,
  expirePlans,
  getDesk,
  issueBridgeToken,
  journal,
  reconcilePositions,
  requeueStaleCommands,
  revokeBridgeToken,
  sessionForToken,
  upsertCandles,
  type DeskState,
} from "../lib/multiasset/store";
import {
  TIMEFRAMES,
  type AccountSnapshot,
  type AssetClass,
  type Bar,
  type CommandResult,
  type HighImpactNewsEvent,
  type MarketCatalogEntry,
  type NewsCalendarSnapshot,
  type Position,
  type Quote,
  type SymbolSpec,
  type SyncResponse,
  type Timeframe,
} from "../lib/multiasset/types";

const router: IRouter = Router();

/** Pairing codes are short-lived: a code left on screen is a weak secret. */
const PAIRING_TTL_MS = 10 * 60 * 1000;

interface PendingPairing {
  code: string;
  sessionId: string;
  createdAt: number;
}

const pendingPairings = new Map<string, PendingPairing>();

function clearLiveDeskData(desk: DeskState): void {
  desk.account = null;
  desk.newsCalendar = {
    status: "unknown",
    fetchedAt: null,
    coverageStart: null,
    coverageEnd: null,
    error: null,
    events: [],
  };
  desk.universe.clear();
  desk.specs.clear();
  desk.quotes.clear();
  desk.candles.clear();
  desk.positions = [];
  desk.watchlist = [];
  desk.plans.clear();
  desk.outbox = [];
  desk.inflight.clear();
  desk.autoTrade = false;
  desk.riskState = createRiskState();
}

/** Replace the broker's full MT5 catalog snapshot, never merge stale symbols. */
function replaceBrokerUniverse(desk: DeskState, entries: MarketCatalogEntry[]): void {
  const next = new Map(entries.map((entry) => [entry.symbol, entry] as const));
  // A transient empty terminal catalog should not erase a previously valid
  // broker universe. Empty is accepted while pairing/initializing the first one.
  if (next.size === 0 && desk.universe.size > 0) return;

  const removed = new Set([...desk.universe.keys()].filter((symbol) => !next.has(symbol)));
  desk.universe.clear();
  for (const [symbol, entry] of next) desk.universe.set(symbol, entry);
  if (removed.size === 0) return;

  desk.watchlist = desk.watchlist.filter((symbol) => !removed.has(symbol));
  for (const [id, plan] of desk.plans) {
    if (!removed.has(plan.symbol)) continue;
    desk.outbox.push({ id: randomUUID(), type: "cancel_plan", planId: plan.id });
    desk.plans.delete(id);
  }
  for (const symbol of removed) {
    desk.specs.delete(symbol);
    desk.quotes.delete(symbol);
    for (const key of desk.candles.keys()) {
      if (key.startsWith(`${symbol}|`)) desk.candles.delete(key);
    }
  }
  journal(desk, "bridge", null, `Broker catalog refreshed; ${removed.size} unavailable symbol(s) removed from the desk.`);
}

function prunePairings(now = Date.now()): void {
  for (const [code, pairing] of pendingPairings) {
    if (now - pairing.createdAt > PAIRING_TTL_MS) pendingPairings.delete(code);
  }
}

/** Unambiguous alphabet: no O/0 or I/1, because the user retypes this by hand. */
function makePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

// ── Pairing ──────────────────────────────────────────────────────────────────

/**
 * POST /api/bridge/pairing-code  (browser)
 * Issues a code the user types into the EA's inputs.
 */
router.post("/pairing-code", (_req, res) => {
  prunePairings();
  const sessionId = getBrowserSessionId();

  // One live code per session: issuing a second would leave the first valid
  // and pairable by someone else who saw it.
  for (const [code, pairing] of pendingPairings) {
    if (pairing.sessionId === sessionId) pendingPairings.delete(code);
  }

  const code = makePairingCode();
  pendingPairings.set(code, { code, sessionId, createdAt: Date.now() });

  res.json({ pairingCode: code, expiresInMs: PAIRING_TTL_MS });
});

/**
 * POST /api/bridge/pair  (Expert Advisor)
 * Exchanges a pairing code for a bearer token.
 */
router.post("/pair", (req, res) => {
  prunePairings();
  const code = String(req.body?.pairingCode ?? "").trim().toUpperCase();
  const terminal = req.body?.terminal ?? {};

  const pairing = pendingPairings.get(code);
  if (!pairing) {
    return res.status(401).json({ error: "Unknown or expired pairing code." });
  }
  // Single use — a code that has been redeemed must not pair a second terminal.
  pendingPairings.delete(code);

  const login = Number(terminal.login ?? 0);
  const server = String(terminal.server ?? "unknown");
  if (!Number.isFinite(login) || login <= 0) {
    return res.status(400).json({ error: "terminal.login is required." });
  }

  const desk = getDesk(pairing.sessionId);
  if (desk.terminal) revokeBridgeToken(desk.terminal.bridgeToken);
  clearLiveDeskData(desk);

  const bridgeToken = issueBridgeToken(pairing.sessionId);
  desk.terminal = {
    accountId: `mt5:${login}@${server}`,
    login,
    server,
    company: String(terminal.company ?? ""),
    bridgeToken,
    pairedAt: Date.now(),
    lastSyncAt: Date.now(),
    lastSeq: 0,
  };
  journal(desk, "bridge", null, `MetaTrader 5 terminal paired: ${login}@${server}.`);
  logger.info({ login, server }, "MT5 bridge paired");

  return res.status(201).json({
    bridgeToken,
    accountId: desk.terminal.accountId,
    syncIntervalMs: 1000,
    subscriptions: { symbols: desk.watchlist, timeframes: TIMEFRAMES },
  });
});

/** POST /api/bridge/unpair (browser) — revoke the token and drop live state. */
router.post("/unpair", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  if (!desk.terminal) return res.status(404).json({ error: "No terminal is linked." });

  revokeBridgeToken(desk.terminal.bridgeToken);
  desk.terminal = null;
  clearLiveDeskData(desk);
  journal(desk, "bridge", null, "MetaTrader 5 terminal unlinked. Live account and market data cleared.");

  return res.json({ ok: true });
});

// ── Authentication ───────────────────────────────────────────────────────────

function deskForRequest(req: Request): DeskState | null {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const sessionId = sessionForToken(token);
  if (!sessionId) return null;
  const desk = getDesk(sessionId);
  // A token that is no longer the desk's current token has been superseded.
  if (desk.terminal?.bridgeToken !== token) return null;
  return desk;
}

// ── Validation ───────────────────────────────────────────────────────────────
//
// The EA is a client like any other: everything it sends is validated before
// it reaches the sizing engine. A malformed tickValue would silently produce
// a position 100x the intended size.

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseSpec(raw: unknown): SymbolSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? "").trim();
  const point = num(r.point);
  if (!symbol || !(point > 0)) return null;

  const tickSize = num(r.tickSize, point);
  const assetClass = normalizeAssetClass(r.assetClass) ?? inferAssetClass({
    symbol,
    path: typeof r.path === "string" ? r.path : "",
    description: typeof r.description === "string" ? r.description : "",
    baseCurrency: typeof r.baseCurrency === "string" ? r.baseCurrency : "",
    calculationMode: typeof r.calculationMode === "string" ? r.calculationMode : "",
  });
  return {
    symbol,
    assetClass,
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

export function parseCatalogEntry(raw: unknown): MarketCatalogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? "").trim();
  if (!symbol) return null;
  const path = typeof r.path === "string" ? r.path : "";
  const description = typeof r.description === "string" ? r.description : "";
  const assetClass = normalizeAssetClass(r.assetClass) ?? inferAssetClass({ symbol, path, description });
  return { symbol, assetClass, path, description };
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
    // MT5 reports 0 when nothing is open; Infinity is the honest value and
    // keeps the margin-level guard from firing on a flat account.
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

function parseBars(raw: unknown): Bar[] {
  if (!Array.isArray(raw)) return [];
  const out: Bar[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 5) continue;
    const bar = entry.slice(0, 6).map((v) => num(v));
    while (bar.length < 6) bar.push(0);
    if (!(bar[0] > 0) || !(bar[4] > 0)) continue;
    out.push(bar as Bar);
  }
  return out;
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

function unavailableNewsSnapshot(error: string, now = Date.now()): NewsCalendarSnapshot {
  return {
    status: "unavailable",
    fetchedAt: now,
    coverageStart: null,
    coverageEnd: null,
    error,
    events: [],
  };
}

function parseNewsCalendar(raw: unknown, now = Date.now()): NewsCalendarSnapshot {
  if (!raw || typeof raw !== "object") {
    return unavailableNewsSnapshot("The linked MT5 bridge did not provide an economic-calendar snapshot.", now);
  }
  const r = raw as Record<string, unknown>;
  if (r.source !== "mt5") {
    return unavailableNewsSnapshot("The economic-calendar source was not the linked MT5 terminal.", now);
  }
  if (r.available !== true) {
    const error = typeof r.error === "string" && r.error.trim()
      ? r.error.trim().slice(0, 240)
      : "MT5 reports its economic calendar unavailable.";
    return unavailableNewsSnapshot(error, now);
  }

  const fetchedAt = num(r.fetchedAt, NaN);
  const coverageStart = num(r.coverageStart, NaN);
  const coverageEnd = num(r.coverageEnd, NaN);
  if (
    !Number.isFinite(fetchedAt) || fetchedAt <= 0 ||
    !Number.isFinite(coverageStart) || coverageStart <= 0 ||
    !Number.isFinite(coverageEnd) || coverageEnd <= coverageStart ||
    !Array.isArray(r.events)
  ) {
    return unavailableNewsSnapshot("MT5 returned an incomplete economic-calendar snapshot.", now);
  }
  if (r.events.length > 1000) {
    return unavailableNewsSnapshot("MT5 calendar event count exceeded the safe processing limit.", now);
  }

  const events: HighImpactNewsEvent[] = [];
  const seen = new Set<string>();
  for (const rawEvent of r.events) {
    if (!rawEvent || typeof rawEvent !== "object") {
      return unavailableNewsSnapshot("MT5 returned a malformed high-impact calendar event.", now);
    }
    const event = rawEvent as Record<string, unknown>;
    const id = String(event.id ?? "").trim().slice(0, 120);
    const currency = String(event.currency ?? "").trim().toUpperCase();
    const title = String(event.title ?? "").trim().slice(0, 200);
    const ts = num(event.ts, NaN);
    if (
      !id || (currency !== "*" && !/^[A-Z]{3}$/.test(currency)) ||
      event.impact !== "high" || !Number.isFinite(ts) || ts <= 0 ||
      ts < coverageStart - 60_000 || ts > coverageEnd + 60_000
    ) {
      return unavailableNewsSnapshot("MT5 returned an invalid or unclassified calendar event.", now);
    }
    const key = `${id}|${ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ id, currency, title, impact: "high", ts });
  }

  return {
    status: "ready",
    fetchedAt,
    coverageStart,
    coverageEnd,
    error: null,
    events: events.sort((a, b) => a.ts - b.ts || a.currency.localeCompare(b.currency)),
  };
}

function cancelNewsUnsafePlans(desk: DeskState, now: number): void {
  const guard = newsGuardFromSnapshot(desk.newsCalendar, now);
  for (const [id, plan] of desk.plans) {
    const gate = assessNewsEntry(guard, desk.specs.get(plan.symbol), now);
    if (gate.allowed) continue;
    desk.plans.delete(id);
    desk.outbox.push({ id: randomUUID(), type: "cancel_plan", planId: plan.id });
    journal(desk, "risk", plan.symbol, `Armed plan cancelled by the fail-safe news gate: ${gate.reason}`);
  }
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/bridge/sync  (Expert Advisor, ~1 Hz)
 *
 * The single heartbeat: the EA pushes state, the server replies with work.
 */
router.post("/sync", (req, res) => {
  const desk = deskForRequest(req);
  if (!desk || !desk.terminal) {
    return res.status(401).json({ error: "Invalid or revoked bridge token." });
  }

  const body = req.body ?? {};
  const seq = Math.round(num(body.seq));
  const now = Date.now();

  // A sequence that went backwards means the EA restarted. Positions are
  // re-adopted from the next payload; stale plans must not survive, because
  // the EA no longer holds them.
  if (seq > 0 && seq < desk.terminal.lastSeq) {
    desk.plans.clear();
    desk.inflight.clear();
    journal(desk, "bridge", null, "Terminal restarted — armed plans cleared and state resynchronised.");
  }
  desk.terminal.lastSeq = seq;
  desk.terminal.lastSyncAt = now;

  // The economic calendar must be present on every heartbeat. A missing or
  // malformed feed (including an older EA version) immediately fails closed.
  desk.newsCalendar = parseNewsCalendar(body.newsCalendar, now);

  // ── Account ────────────────────────────────────────────────────────────────
  const account = parseAccount(body.account);
  if (account) applyAccount(desk, account);

  // ── Broker catalog and live market data ────────────────────────────────────
  // The EA sends symbol metadata only; quotes, contract specs and candles are
  // streamed for the user's selected watchlist, not guessed from a static list.
  if (Array.isArray(body.universe)) {
    const entries = body.universe
      .map((raw: unknown) => parseCatalogEntry(raw))
      .filter((entry: MarketCatalogEntry | null): entry is MarketCatalogEntry => entry !== null);
    replaceBrokerUniverse(desk, entries);
  }

  if (Array.isArray(body.specs)) {
    for (const raw of body.specs) {
      const spec = parseSpec(raw);
      if (spec) desk.specs.set(spec.symbol, spec);
    }
  }

  if (Array.isArray(body.quotes)) {
    for (const raw of body.quotes) {
      const quote = parseQuote(raw);
      if (!quote) continue;
      desk.quotes.set(quote.symbol, quote);
      // Keep the spec's spread fresh: sizing and the cost gate both read it.
      const spec = desk.specs.get(quote.symbol);
      if (spec) spec.spreadPoints = quote.spreadPoints;
    }
  }

  if (Array.isArray(body.candles)) {
    for (const raw of body.candles) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const symbol = String(r.symbol ?? "");
      const timeframe = String(r.timeframe ?? "");
      if (!symbol || !(TIMEFRAMES as readonly string[]).includes(timeframe)) continue;
      const bars = parseBars(r.bars);
      if (bars.length === 0) continue;
      upsertCandles(desk, { symbol, timeframe: timeframe as Timeframe, bars });
    }
  }

  // ── Positions ──────────────────────────────────────────────────────────────
  if (Array.isArray(body.positions)) {
    const positions = (body.positions as unknown[])
      .map((raw: unknown) => parsePosition(raw))
      .filter((p: Position | null): p is Position => p !== null);
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
      // Realised P&L includes swap and commission — the number that actually
      // hit the account, not the gross price move.
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
        { consecutiveLosses: desk.riskState.consecutiveLosses },
      );
      if (desk.riskState.haltedUntilNextSession) {
        journal(desk, "risk", null, desk.riskState.haltReason ?? "Desk halted.");
      }
    }
  }

  // ── Command acknowledgements ───────────────────────────────────────────────
  if (Array.isArray(body.results)) {
    for (const raw of body.results) {
      const result = parseResult(raw);
      if (!result) continue;
      const fresh = acknowledgeResult(desk, result);
      if (!fresh) continue; // duplicate ack — already journalled

      if (result.status === "rejected") {
        journal(
          desk,
          "execution",
          null,
          `Command rejected by the terminal: ${result.error ?? "unknown error"}.`,
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

  // ── Housekeeping ───────────────────────────────────────────────────────────
  const expired = expirePlans(desk, now);
  if (expired.length > 0) {
    journal(desk, "signal", null, `${expired.length} armed plan(s) expired untriggered.`);
  }
  cancelNewsUnsafePlans(desk, now);
  requeueStaleCommands(desk);

  // Ask for a full re-seed whenever a symbol this terminal actually carries is
  // short of the 60 bars the Monte Carlo bootstrap needs.
  //
  // Scoped to the terminal's own instruments rather than the desk watchlist:
  // a user watching seven symbols on a terminal that only offers three would
  // otherwise re-seed full history on every single heartbeat, forever.
  const reported = new Set(desk.specs.keys());
  const activeSymbols = [...new Set([
    ...desk.watchlist,
    ...desk.positions.map((position) => position.symbol),
    ...[...desk.plans.values()].map((plan) => plan.symbol),
  ])].filter((symbol) => desk.universe.has(symbol));
  const needsHistory = activeSymbols
    .filter((symbol) => reported.has(symbol))
    .some((symbol) =>
      TIMEFRAMES.some((timeframe) => {
        const series = desk.candles.get(candleKey(symbol, timeframe));
        return !series || series.bars.length < 60;
      }),
    );

  const response: SyncResponse = {
    serverTime: now,
    commands: drainOutbox(desk),
    needsHistory,
    needsUniverse: desk.universe.size === 0,
    subscriptions: { symbols: activeSymbols, timeframes: [...TIMEFRAMES] },
    newsCalendar: {
      ready: isNewsCalendarReady(desk.newsCalendar, now),
      fetchedAt: desk.newsCalendar.fetchedAt,
      staleAfterMs: NEWS_CALENDAR_MAX_AGE_MS,
      blackoutBeforeMs: NEWS_BLACKOUT_BEFORE_MS,
      blackoutAfterMs: NEWS_BLACKOUT_AFTER_MS,
      events: isNewsCalendarReady(desk.newsCalendar, now)
        ? desk.newsCalendar.events.map(({ id, currency, ts }) => ({ id, currency, ts }))
        : [],
    },
    limits: {
      maxDailyLossPct: desk.policy.maxDailyLossPct,
      maxOpenPositions: desk.policy.maxOpenPositions,
      // A halted desk, or one whose owner switched auto-trade off, must stop
      // the EA from acting on anything still in its memory.
      tradingEnabled: desk.autoTrade && !desk.riskState.haltedUntilNextSession && isNewsCalendarReady(desk.newsCalendar, now),
      liveTradingEnabled: desk.policy.liveTradingEnabled,
      staleAfterMs: 30_000,
      flatOnDisconnect: false,
    },
  };

  return res.json(response);
});

/** GET /api/bridge/status (browser) — pairing/liveness for the UI. */
router.get("/status", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  if (!desk.terminal) return res.json({ linked: false });

  const age = Date.now() - desk.terminal.lastSyncAt;
  return res.json({
    linked: true,
    accountId: desk.terminal.accountId,
    login: desk.terminal.login,
    server: desk.terminal.server,
    company: desk.terminal.company,
    pairedAt: desk.terminal.pairedAt,
    lastSyncAt: desk.terminal.lastSyncAt,
    lastSyncAgeMs: age,
    stale: age > 30_000,
    queuedCommands: desk.outbox.length,
    inflightCommands: desk.inflight.size,
  });
});

export default router;
export { makePairingCode, pendingPairings };
export const __testing = {
  randomCommandId: randomUUID,
  replaceBrokerUniverse,
  parseNewsCalendar,
  cancelNewsUnsafePlans,
};
