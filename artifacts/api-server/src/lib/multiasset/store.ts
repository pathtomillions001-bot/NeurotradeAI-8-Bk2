/**
 * Multi-Asset Desk — per-session live state.
 *
 * A Desk mirrors one MT5 terminal. It intentionally starts empty: no account,
 * balance, quotes, candles or synthetic replay exists until the user pairs a
 * real terminal. This protects users from mistaking illustrative values for
 * broker data.
 */

import { randomUUID } from "node:crypto";
import { createRiskState, DEFAULT_RISK_POLICY, type RiskPolicy, type RiskState } from "./risk";
import type {
  AccountSnapshot,
  ArmedPlan,
  BridgeCommand,
  CandleSeries,
  CommandResult,
  MarketCatalogEntry,
  NewsFeed,
  Position,
  Quote,
  SymbolSpec,
  Timeframe,
  TradeMode,
} from "./types";

/** Bars retained per symbol/timeframe. Enough for D1 regime work, bounded. */
const MAX_BARS = 400;
/** Signal-log entries retained per desk. */
const MAX_JOURNAL = 200;
/** Command ids remembered for duplicate suppression. */
const MAX_SEEN_COMMANDS = 500;

export interface JournalEntry {
  id: string;
  ts: number;
  kind: "signal" | "no_trade" | "execution" | "risk" | "bridge";
  symbol: string | null;
  message: string;
  detail?: unknown;
}

export interface DeskState {
  sessionId: string;
  /** Linked terminal, or null while unpaired. */
  terminal: {
    accountId: string;
    login: number;
    server: string;
    company: string;
    bridgeToken: string;
    pairedAt: number;
    lastSyncAt: number;
    lastSeq: number;
  } | null;
  /** Last account snapshot from the paired terminal; never fabricated. */
  account: AccountSnapshot | null;
  /** The broker's full tradeable catalogue, received at pairing. */
  catalog: Map<string, MarketCatalogEntry>;
  /** Specs/quotes/candles only for selected symbols being actively streamed. */
  specs: Map<string, SymbolSpec>;
  quotes: Map<string, Quote>;
  /** `${symbol}|${timeframe}` → bars. */
  candles: Map<string, CandleSeries>;
  /** Latest high-impact calendar state from MT5. Fails closed when unavailable. */
  news: NewsFeed;
  positions: Position[];
  /** Plans currently armed on the EA, by plan id. */
  plans: Map<string, ArmedPlan>;
  /** Commands waiting to be delivered on the next sync. */
  outbox: BridgeCommand[];
  /** Commands delivered but not yet acknowledged, by command id. */
  inflight: Map<string, { command: BridgeCommand; sentAt: number }>;
  seenCommandIds: string[];
  /** User-selected broker symbols. There is deliberately no arbitrary cap. */
  watchlist: string[];
  mode: TradeMode;
  autoTrade: boolean;
  policy: RiskPolicy;
  riskState: RiskState;
  journal: JournalEntry[];
}

const desks = new Map<string, DeskState>();

const UNAVAILABLE_NEWS: NewsFeed = {
  available: false,
  checkedAt: 0,
  events: [],
  detail: "Waiting for the paired MT5 terminal to provide its economic calendar.",
};

export function getDesk(sessionId: string): DeskState {
  let desk = desks.get(sessionId);
  if (!desk) {
    desk = {
      sessionId,
      terminal: null,
      account: null,
      catalog: new Map(),
      specs: new Map(),
      quotes: new Map(),
      candles: new Map(),
      news: { ...UNAVAILABLE_NEWS },
      positions: [],
      plans: new Map(),
      outbox: [],
      inflight: new Map(),
      seenCommandIds: [],
      watchlist: [],
      mode: "intraday",
      autoTrade: false,
      policy: { ...DEFAULT_RISK_POLICY },
      riskState: createRiskState(),
      journal: [],
    };
    desks.set(sessionId, desk);
  }
  return desk;
}

/** Test/maintenance helper — never called from a request path. */
export function resetDesk(sessionId: string): void {
  desks.delete(sessionId);
}

export function allDeskSessionIds(): string[] {
  return [...desks.keys()];
}

/** Remove every terminal-derived value when a user unlinks a broker. */
export function clearTerminalData(desk: DeskState): void {
  desk.account = null;
  desk.catalog.clear();
  desk.specs.clear();
  desk.quotes.clear();
  desk.candles.clear();
  desk.news = { ...UNAVAILABLE_NEWS };
  desk.positions = [];
  desk.plans.clear();
  desk.outbox = [];
  desk.inflight.clear();
  desk.watchlist = [];
  desk.autoTrade = false;
}

// ── Bridge token index ───────────────────────────────────────────────────────

const tokenToSession = new Map<string, string>();

export function issueBridgeToken(sessionId: string): string {
  const existing = desks.get(sessionId)?.terminal?.bridgeToken;
  if (existing) tokenToSession.delete(existing);
  const token = `nt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  tokenToSession.set(token, sessionId);
  return token;
}

export function sessionForToken(token: string): string | null {
  return tokenToSession.get(token) ?? null;
}

export function revokeBridgeToken(token: string): void {
  tokenToSession.delete(token);
}

// ── Market data ──────────────────────────────────────────────────────────────

export function candleKey(symbol: string, timeframe: Timeframe): string {
  return `${symbol}|${timeframe}`;
}

export function upsertCandles(desk: DeskState, series: CandleSeries): void {
  const key = candleKey(series.symbol, series.timeframe);
  const existing = desk.candles.get(key);

  if (!existing) {
    // Every consumer assumes chronological order. Sort even the first batch:
    // CopyRates order differs across terminal builds.
    const deduped = new Map(series.bars.map((bar) => [bar[0], bar] as const));
    desk.candles.set(key, {
      ...series,
      bars: [...deduped.values()].sort((a, b) => a[0] - b[0]).slice(-MAX_BARS),
    });
    return;
  }

  // The forming bar is resent on each heartbeat; merge by timestamp rather
  // than appending it so reconnects cannot create false bars.
  const byTs = new Map(existing.bars.map((bar) => [bar[0], bar] as const));
  for (const bar of series.bars) byTs.set(bar[0], bar);
  const merged = [...byTs.values()].sort((a, b) => a[0] - b[0]);
  desk.candles.set(key, { ...series, bars: merged.slice(-MAX_BARS) });
}

export function seriesFor(desk: DeskState, symbol: string): Partial<Record<Timeframe, import("./types").Bar[]>> {
  const out: Partial<Record<Timeframe, import("./types").Bar[]>> = {};
  for (const [key, series] of desk.candles) {
    if (!key.startsWith(`${symbol}|`)) continue;
    out[series.timeframe] = series.bars;
  }
  return out;
}

// ── Command queue ────────────────────────────────────────────────────────────

export function enqueueCommand(desk: DeskState, command: BridgeCommand): void {
  desk.outbox.push(command);
}

/** Hand the outbox to the EA and move it to in-flight. */
export function drainOutbox(desk: DeskState): BridgeCommand[] {
  const batch = desk.outbox;
  desk.outbox = [];
  const now = Date.now();
  for (const command of batch) desk.inflight.set(command.id, { command, sentAt: now });
  return batch;
}

/** Re-queue safety commands that were never acknowledged. */
export function requeueStaleCommands(desk: DeskState, timeoutMs = 15_000): number {
  const now = Date.now();
  let requeued = 0;
  for (const [id, entry] of desk.inflight) {
    if (now - entry.sentAt < timeoutMs) continue;
    desk.inflight.delete(id);
    if (entry.command.type === "flatten_all") {
      desk.outbox.push(entry.command);
      requeued++;
    }
  }
  return requeued;
}

export function acknowledgeResult(desk: DeskState, result: CommandResult): boolean {
  const known = desk.inflight.delete(result.commandId);
  if (desk.seenCommandIds.includes(result.commandId)) return false;
  desk.seenCommandIds.push(result.commandId);
  if (desk.seenCommandIds.length > MAX_SEEN_COMMANDS) {
    desk.seenCommandIds.splice(0, desk.seenCommandIds.length - MAX_SEEN_COMMANDS);
  }
  return known;
}

// ── Journal ──────────────────────────────────────────────────────────────────

export function journal(
  desk: DeskState,
  kind: JournalEntry["kind"],
  symbol: string | null,
  message: string,
  detail?: unknown,
): JournalEntry {
  const entry: JournalEntry = {
    id: randomUUID(),
    ts: Date.now(),
    kind,
    symbol,
    message,
    detail,
  };
  desk.journal.unshift(entry);
  if (desk.journal.length > MAX_JOURNAL) desk.journal.length = MAX_JOURNAL;
  return entry;
}

// ── Plans ────────────────────────────────────────────────────────────────────

export function armPlan(desk: DeskState, plan: ArmedPlan): void {
  // One armed plan per symbol prevents accidental doubled exposure.
  for (const [id, existing] of desk.plans) {
    if (existing.symbol === plan.symbol) {
      desk.plans.delete(id);
      enqueueCommand(desk, { id: randomUUID(), type: "cancel_plan", planId: id });
    }
  }
  desk.plans.set(plan.id, plan);
  enqueueCommand(desk, { id: randomUUID(), type: "arm_plan", plan });
}

export function cancelPlan(desk: DeskState, planId: string): boolean {
  if (!desk.plans.delete(planId)) return false;
  enqueueCommand(desk, { id: randomUUID(), type: "cancel_plan", planId });
  return true;
}

/** Drop plans past their TTL. The EA independently enforces the same expiry. */
export function expirePlans(desk: DeskState, now = Date.now()): string[] {
  const expired: string[] = [];
  for (const [id, plan] of desk.plans) {
    if (plan.expiresAt <= now) {
      desk.plans.delete(id);
      expired.push(id);
    }
  }
  return expired;
}

// ── Account bookkeeping ──────────────────────────────────────────────────────

export function applyAccount(desk: DeskState, incoming: AccountSnapshot): void {
  const previous = desk.account;
  const dayStartEquity = incoming.dayStartEquity ?? previous?.dayStartEquity ?? incoming.equity;
  const peakEquity = Math.max(previous?.peakEquity ?? 0, incoming.equity, dayStartEquity);
  desk.account = { ...incoming, dayStartEquity, peakEquity };
}

export function startNewTradingDay(desk: DeskState): void {
  if (desk.account) {
    desk.account = {
      ...desk.account,
      dayStartEquity: desk.account.equity,
      peakEquity: Math.max(desk.account.peakEquity ?? 0, desk.account.equity),
    };
  }
  desk.riskState = {
    ...createRiskState(),
    suspendedSymbols: [...desk.riskState.suspendedSymbols],
  };
}

/** Terminal positions are authoritative; reconcile rather than infer. */
export function reconcilePositions(
  desk: DeskState,
  incoming: Position[],
): { opened: Position[]; closed: Position[] } {
  const previous = new Map(desk.positions.map((p) => [p.ticket, p]));
  const next = new Map(incoming.map((p) => [p.ticket, p]));

  const opened = incoming.filter((p) => !previous.has(p.ticket));
  const closed = desk.positions.filter((p) => !next.has(p.ticket));

  desk.positions = incoming.map((position) => {
    const prior = previous.get(position.ticket);
    return prior
      ? {
          ...position,
          initialRiskMoney: prior.initialRiskMoney ?? position.initialRiskMoney,
          initialRiskPoints: prior.initialRiskPoints ?? position.initialRiskPoints,
        }
      : position;
  });

  return { opened, closed };
}
