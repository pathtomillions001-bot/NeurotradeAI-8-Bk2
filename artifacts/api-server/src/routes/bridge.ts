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
  acknowledgeResult,
  applyAccount,
  candleKey,
  clearTerminalData,
  drainOutbox,
  expirePlans,
  getDesk,
  journal,
  reconcilePositions,
  requeueStaleCommands,
  revokeBridgeToken,
  sessionForToken,
  upsertCandles,
  issueBridgeToken,
  type DeskState,
} from "../lib/multiasset/store";
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
  type SyncResponse,
  type Timeframe,
} from "../lib/multiasset/types";

const router: IRouter = Router();
const PAIRING_TTL_MS = 10 * 60 * 1000;

interface PendingPairing {
  code: string;
  sessionId: string;
  createdAt: number;
}

const pendingPairings = new Map<string, PendingPairing>();

function prunePairings(now = Date.now()): void {
  for (const [code, pairing] of pendingPairings) {
    if (now - pairing.createdAt > PAIRING_TTL_MS) pendingPairings.delete(code);
  }
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

router.post("/pairing-code", (_req, res) => {
  prunePairings();
  const sessionId = getBrowserSessionId();
  for (const [code, pairing] of pendingPairings) {
    if (pairing.sessionId === sessionId) pendingPairings.delete(code);
  }

  const code = makePairingCode();
  pendingPairings.set(code, { code, sessionId, createdAt: Date.now() });
  res.json({ pairingCode: code, expiresInMs: PAIRING_TTL_MS });
});

/** Exchange the one-time screen code for a terminal-scoped bearer token. */
router.post("/pair", (req, res) => {
  prunePairings();
  const code = String(req.body?.pairingCode ?? "").trim().toUpperCase();
  const terminal = req.body?.terminal ?? {};
  const pairing = pendingPairings.get(code);
  if (!pairing) return res.status(401).json({ error: "Unknown or expired pairing code." });
  pendingPairings.delete(code); // pairing codes are single use

  const login = Number(terminal.login ?? 0);
  const server = String(terminal.server ?? "unknown");
  if (!Number.isFinite(login) || login <= 0) {
    return res.status(400).json({ error: "terminal.login is required." });
  }

  const desk = getDesk(pairing.sessionId);
  if (desk.terminal) revokeBridgeToken(desk.terminal.bridgeToken);
  clearTerminalData(desk);

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
    `MetaTrader 5 terminal paired: ${login}@${server}. ${catalogCount} broker markets discovered.`,
  );
  logger.info({ login, server, catalogCount }, "MT5 bridge paired");

  return res.status(201).json({
    bridgeToken,
    accountId: desk.terminal.accountId,
    syncIntervalMs: 1000,
    subscriptions: { symbols: desk.watchlist, timeframes: TIMEFRAMES },
  });
});

/** Revoke the bearer token and remove every terminal-derived value. */
router.post("/unpair", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  if (!desk.terminal) return res.status(404).json({ error: "No terminal is linked." });

  revokeBridgeToken(desk.terminal.bridgeToken);
  desk.terminal = null;
  clearTerminalData(desk);
  journal(desk, "bridge", null, "MetaTrader 5 terminal unlinked; live terminal data was cleared.");
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
  return desk.terminal?.bridgeToken === token ? desk : null;
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
  return {
    available: r.available === true,
    checkedAt: num(r.checkedAt, Date.now()),
    events: events
      .filter((event) => event.time >= Date.now() - 2 * 60 * 60_000 && event.time <= Date.now() + 48 * 60 * 60_000)
      .sort((a, b) => a.time - b.time),
    detail: typeof r.detail === "string" ? r.detail.slice(0, 500) : undefined,
  };
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

/** POST /api/bridge/sync — the EA's authenticated state heartbeat. */
router.post("/sync", (req, res) => {
  const desk = deskForRequest(req);
  if (!desk || !desk.terminal) return res.status(401).json({ error: "Invalid or revoked bridge token." });

  const body = req.body ?? {};
  const seq = Math.round(num(body.seq));
  const now = Date.now();

  if (seq > 0 && seq < desk.terminal.lastSeq) {
    desk.plans.clear();
    desk.inflight.clear();
    journal(desk, "bridge", null, "Terminal restarted — armed plans cleared and state resynchronised.");
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

  if (Array.isArray(body.quotes)) {
    for (const raw of body.quotes) {
      const quote = parseQuote(raw);
      if (!quote) continue;
      desk.quotes.set(quote.symbol, quote);
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
  const reported = new Set(desk.specs.keys());
  const needsHistory = desk.watchlist
    .filter((symbol) => reported.has(symbol))
    .some((symbol) => TIMEFRAMES.some((timeframe) => {
      const series = desk.candles.get(candleKey(symbol, timeframe));
      return !series || series.bars.length < 60;
    }));

  const response: SyncResponse = {
    serverTime: now,
    commands: drainOutbox(desk),
    needsHistory,
    subscriptions: { symbols: desk.watchlist, timeframes: [...TIMEFRAMES] },
    news: desk.news,
    limits: {
      maxDailyLossPct: desk.policy.maxDailyLossPct,
      maxOpenPositions: desk.policy.maxOpenPositions,
      tradingEnabled: desk.autoTrade && !desk.riskState.haltedUntilNextSession,
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
  if (!desk.terminal) return res.json({ linked: false, catalogCount: 0, selectedCount: 0 });

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
    catalogCount: desk.catalog.size,
    selectedCount: desk.watchlist.length,
    calendarAvailable: desk.news.available,
    calendarAgeMs: desk.news.checkedAt ? Date.now() - desk.news.checkedAt : null,
  });
});

export default router;
export { makePairingCode, pendingPairings };
export const __testing = { randomCommandId: randomUUID };
