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
import { createSymbolTicks, syntheticSeries, type SymbolTicks } from "./subminute";
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
/** Equity samples retained for the Desk's equity curve. */
const MAX_EQUITY_SAMPLES = 720;
/** Closed trades retained per desk for the performance pane. */
const MAX_CLOSED_TRADES = 300;

/**
 * A realised trade outcome, keyed by `symbol|mode`.
 *
 * The agent uses these as the Beta prior for its win-rate estimate. Without
 * them every symbol is judged purely by simulation, which flatters the model
 * and never learns that a particular broker symbol trades badly.
 */
export interface OutcomeRecord {
  key: string;
  symbol: string;
  mode: TradeMode;
  wins: number;
  losses: number;
  /** Sum of realised R multiples — the honest measure of edge, not win rate. */
  totalR: number;
  updatedAt: number;
}

export interface ClosedTrade {
  ticket: number;
  symbol: string;
  side: "buy" | "sell";
  volume: number;
  openPrice: number;
  profit: number;
  swap: number;
  commission: number;
  /** Realised result in R when the initial risk is known. */
  rMultiple: number | null;
  openedAt: number;
  closedAt: number;
}

export interface EquitySample {
  t: number;
  equity: number;
  balance: number;
}

/** IANA timezone the Desk renders every timestamp in. */
export const DEFAULT_DESK_TIMEZONE = "Africa/Nairobi";

export function outcomeKey(symbol: string, mode: TradeMode): string {
  return `${symbol}|${mode}`;
}

export interface JournalEntry {
  id: string;
  ts: number;
  kind: "signal" | "no_trade" | "execution" | "risk" | "bridge";
  symbol: string | null;
  message: string;
  detail?: unknown;
}

/**
 * The result of one automatic best-market pass.
 *
 * The desk runs this on the terminal's heartbeat while auto-trade is on: it
 * analyses every selected market for the active mode, ranks the ones that pass
 * every gate, and arms the best. `ranked` is kept (top few) so "why did it take
 * that one instead of mine?" is answerable from the UI rather than guessed at.
 */
export interface AutoSelectRecord {
  at: number;
  mode: TradeMode;
  /** Selected markets considered this pass. */
  scanned: number;
  /** Markets that cleared every gate. */
  qualified: number;
  /** Symbol that was armed, or null when nothing qualified. */
  chosen: string | null;
  /** One-line explanation, shown verbatim on the desk. */
  reason: string;
  /**
   * Selected markets this pass could not analyse at all, because their data was
   * not fresh and self-consistent. Named so "why was my market not even
   * considered?" is answered without reading the journal.
   */
  skipped: string[];
  /** Best few candidates, in rank order. */
  ranked: {
    symbol: string;
    expectancyR: number | null;
    score: number;
    grade: string;
    armed: boolean;
  }[];
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
    /**
     * Heartbeat interval the EA reports, in ms. Zero when it has not said —
     * `live.ts` then falls back to the fixed staleness window.
     */
    syncIntervalMs: number;
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
  /** Realised outcomes per `symbol|mode`, feeding the agent's Beta prior. */
  outcomes: Map<string, OutcomeRecord>;
  /** Closed positions, newest last — the Desk's realised-performance record. */
  closedTrades: ClosedTrade[];
  /** Sampled equity/balance, for the equity curve. */
  equityHistory: EquitySample[];
  /** IANA timezone for every timestamp the Desk renders. */
  timezone: string;
  /**
   * Why the EA's last pairing attempt was refused, or null.
   *
   * The EA — not the browser — calls /api/bridge/pair, so without recording
   * the refusal here the setup dialog would sit on "waiting for the terminal"
   * while the reason was only ever printed in the MT5 Experts log.
   */
  lastPairingError: { message: string; login: number; server: string; at: number } | null;
  /**
   * Measured offset between the terminal's clock and the server's, in ms.
   *
   * A broker server running a few seconds fast or slow is normal; a terminal
   * whose clock is minutes out would otherwise make every quote look either
   * impossibly fresh or permanently stale, and the Desk would either trade on
   * dead prices or refuse to trade at all.
   */
  clockSkewMs: number | null;
  /**
   * Quote staleness the terminal's last heartbeat implied, in ms.
   * Surfaced so a "delayed data" complaint is diagnosable rather than guessed.
   */
  lastQuoteAgeMs: number | null;
  /**
   * symbol → mode of the most recently armed plan. Kept after the plan is
   * consumed so a fill can still be attributed to the right trading style.
   */
  planModes: Map<string, TradeMode>;
  /** Mode each open position belongs to, captured when it was first seen. */
  positionModes: Map<number, TradeMode>;
  /** Last time the equity curve was sampled, to keep the series bounded. */
  lastEquitySampleAt: number;
  /**
   * Sub-minute candles built from the tick feed, per symbol.
   *
   * Kept beside `candles` rather than inside it: these are the server's own
   * synthesis (see subminute.ts), not broker history, and they must never be
   * requested from the EA or merged with a bar the broker sent.
   */
  ticks: Map<string, SymbolTicks>;
  /** Outcome of the most recent automatic best-market pass, if any. */
  lastAutoSelect: AutoSelectRecord | null;
  /** Throttle stamp for the automatic best-market pass. */
  lastAutoSelectAt: number;
  /** When the last "nothing qualified" note was journalled, for rate limiting. */
  lastAutoSelectNoteAt: number;
  /**
   * Rolling start index into the watchlist for the automatic best-market pass.
   *
   * A user may select any number of markets and every one of them is evaluated
   * over successive passes; the window rotates so a long watchlist is covered
   * without analysing hundreds of symbols inside one heartbeat.
   */
  autoSelectCursor: number;
  /**
   * Delivery state of each armed plan's `arm_plan` command, by plan id.
   *
   * The Desk shows a plan as armed the moment it is queued, but the terminal
   * only actually holds it once it has replied. If that reply never arrives —
   * the bridge token was rejected, the heartbeat that carried the command was
   * lost, or the terminal was mid-restart — the user is left looking at an
   * armed plan that the EA never received, and no execution ever happens. This
   * map is what lets the desk notice the silence and re-send, instead of
   * trusting that a queued command was delivered.
   */
  planDelivery: Map<string, PlanDelivery>;
}

/** Per-plan record of whether the terminal has acknowledged the arm command. */
export interface PlanDelivery {
  /** Times the arm command has been sent, including the first attempt. */
  attempts: number;
  /** True once the terminal answered for this plan, with ANY status. */
  acked: boolean;
  /** When the most recent attempt was handed to the terminal. */
  sentAt: number;
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
      outcomes: new Map(),
      closedTrades: [],
      equityHistory: [],
      timezone: DEFAULT_DESK_TIMEZONE,
      lastPairingError: null,
      clockSkewMs: null,
      lastQuoteAgeMs: null,
      planModes: new Map(),
      positionModes: new Map(),
      lastEquitySampleAt: 0,
      ticks: new Map(),
      lastAutoSelect: null,
      lastAutoSelectAt: 0,
      lastAutoSelectNoteAt: 0,
      autoSelectCursor: 0,
      planDelivery: new Map(),
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
  desk.ticks.clear();
  desk.news = { ...UNAVAILABLE_NEWS };
  desk.positions = [];
  desk.plans.clear();
  desk.planDelivery.clear();
  desk.outbox = [];
  desk.inflight.clear();
  desk.watchlist = [];
  desk.autoTrade = false;
  desk.positionModes.clear();
  desk.planModes.clear();
  desk.closedTrades = [];
  desk.equityHistory = [];
  desk.clockSkewMs = null;
  desk.lastQuoteAgeMs = null;
  desk.lastAutoSelect = null;
  desk.lastAutoSelectAt = 0;
  desk.lastAutoSelectNoteAt = 0;
  desk.autoSelectCursor = 0;
  // `outcomes` deliberately survives an unlink: it is the desk's own learned
  // win-rate prior, and re-learning it from zero on every re-pair is how a
  // broker symbol that trades badly keeps getting traded.
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

/**
 * Re-register a token that was issued earlier (a link restored from storage).
 *
 * A redeploy empties `tokenToSession`, so without this every restored heartbeat
 * would take the slow path — a database lookup per beat per terminal — for the
 * rest of this process's life.
 */
export function rememberBridgeToken(sessionId: string, token: string): void {
  const existing = desks.get(sessionId)?.terminal?.bridgeToken;
  if (existing && existing !== token) tokenToSession.delete(existing);
  tokenToSession.set(token, sessionId);
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

/**
 * Every series available for a symbol — broker frames plus the server's own
 * sub-minute frames.
 *
 * Merging here (rather than at each call site) is what makes S10/S30 visible to
 * the agent, the scanner and any consumer of /desk/series with no extra
 * plumbing. A synthetic frame that is not yet dense enough is simply absent.
 */
export function seriesFor(desk: DeskState, symbol: string): Partial<Record<Timeframe, import("./types").Bar[]>> {
  const out: Partial<Record<Timeframe, import("./types").Bar[]>> = {};
  for (const [key, series] of desk.candles) {
    if (!key.startsWith(`${symbol}|`)) continue;
    out[series.timeframe] = series.bars;
  }
  Object.assign(out, syntheticSeries(desk.ticks.get(symbol)));
  return out;
}

/** The tick accumulator for a symbol, created on first use. */
export function ticksFor(desk: DeskState, symbol: string): SymbolTicks {
  let state = desk.ticks.get(symbol);
  if (!state) {
    state = createSymbolTicks(symbol);
    desk.ticks.set(symbol, state);
  }
  return state;
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
  const entry = desk.inflight.get(result.commandId);
  const known = desk.inflight.delete(result.commandId);

  // ANY answer counts as delivered — including "skipped: trading disabled" or
  // "rejected: no free plan slot". Those are the terminal telling us why it did
  // not take the plan, which the desk surfaces separately; only silence means
  // the command never got there, and only silence should trigger a re-send.
  if (entry?.command.type === "arm_plan") {
    const delivery = desk.planDelivery.get(entry.command.plan.id);
    if (delivery) delivery.acked = true;
  } else if (entry?.command.type === "cancel_plan") {
    desk.planDelivery.delete(entry.command.planId);
  }

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
      desk.planDelivery.delete(id);
      enqueueCommand(desk, { id: randomUUID(), type: "cancel_plan", planId: id });
    }
  }
  desk.plans.set(plan.id, plan);
  desk.planModes.set(plan.symbol, plan.mode);
  // `sentAt` starts at the arm time; the command itself waits in the outbox for
  // the next heartbeat. `syncUnackedPlans` refuses to re-send while a command
  // for this plan is still queued or in flight, so this cannot double-send.
  desk.planDelivery.set(plan.id, { attempts: 1, acked: false, sentAt: Date.now() });
  enqueueCommand(desk, { id: randomUUID(), type: "arm_plan", plan });
}

export function cancelPlan(desk: DeskState, planId: string): boolean {
  if (!desk.plans.delete(planId)) return false;
  desk.planDelivery.delete(planId);
  enqueueCommand(desk, { id: randomUUID(), type: "cancel_plan", planId });
  return true;
}

/** Drop plans past their TTL. The EA independently enforces the same expiry. */
export function expirePlans(desk: DeskState, now = Date.now()): string[] {
  const expired: string[] = [];
  for (const [id, plan] of desk.plans) {
    if (plan.expiresAt <= now) {
      desk.plans.delete(id);
      desk.planDelivery.delete(id);
      expired.push(id);
    }
  }
  return expired;
}

/**
 * How many times one plan's arm command may be re-sent after silence.
 *
 * Bounded so a terminal that is genuinely rejecting the plan (or a bridge that
 * is down for good) cannot be hammered with the same command forever.
 */
export const MAX_PLAN_RESENDS = 3;

/**
 * Re-send the arm command for any plan the terminal has not acknowledged.
 *
 * This is the guard against the worst kind of silent failure in the desk: a
 * plan the UI shows as armed, on a terminal that never received it, so nothing
 * ever executes and the only evidence is the plan quietly expiring. The
 * re-send uses a NEW command id on purpose — the EA de-duplicates by command
 * id, so replaying the original would be dropped unread.
 *
 * Runs on every heartbeat, after un-acknowledged commands have been cleared
 * from the in-flight map, and never touches a plan whose command is still
 * queued, still in flight, already answered, expired, or already re-sent
 * {@link MAX_PLAN_RESENDS} times.
 */
export function syncUnackedPlans(desk: DeskState, now = Date.now(), timeoutMs = 15_000): number {
  // Delivery records for plans that no longer exist cannot accumulate.
  for (const planId of [...desk.planDelivery.keys()]) {
    if (!desk.plans.has(planId)) desk.planDelivery.delete(planId);
  }

  const inFlightPlanIds = new Set<string>();
  for (const entry of desk.inflight.values()) {
    if (entry.command.type === "arm_plan") inFlightPlanIds.add(entry.command.plan.id);
  }
  const queuedPlanIds = new Set<string>();
  for (const command of desk.outbox) {
    if (command.type === "arm_plan") queuedPlanIds.add(command.plan.id);
  }

  let resent = 0;
  for (const [planId, plan] of desk.plans) {
    if (plan.expiresAt <= now) continue;
    if (queuedPlanIds.has(planId) || inFlightPlanIds.has(planId)) continue;

    let delivery = desk.planDelivery.get(planId);
    if (!delivery) {
      // No record — e.g. a plan restored from a desk rebuilt after a restart.
      // Start the clock instead of sending twice in the same heartbeat.
      desk.planDelivery.set(planId, { attempts: 0, acked: false, sentAt: now });
      continue;
    }
    if (delivery.acked) continue;
    if (now - delivery.sentAt < timeoutMs) continue;
    if (delivery.attempts >= MAX_PLAN_RESENDS) continue;

    delivery.attempts += 1;
    delivery.sentAt = now;
    enqueueCommand(desk, { id: randomUUID(), type: "arm_plan", plan });
    resent++;
  }
  return resent;
}

/** Delivery state for one armed plan, for the desk's diagnostics. */
export function planDeliveryFor(desk: DeskState, planId: string): PlanDelivery | null {
  return desk.planDelivery.get(planId) ?? null;
}

// ── Account bookkeeping ──────────────────────────────────────────────────────

export function applyAccount(desk: DeskState, incoming: AccountSnapshot): void {
  const previous = desk.account;
  const dayStartEquity = incoming.dayStartEquity ?? previous?.dayStartEquity ?? incoming.equity;
  const peakEquity = Math.max(previous?.peakEquity ?? 0, incoming.equity, dayStartEquity);
  desk.account = { ...incoming, dayStartEquity, peakEquity };
  sampleEquity(desk, incoming);
}

/**
 * Append an equity sample at most once every 30 seconds.
 *
 * The EA heartbeats about once a second, so an unthrottled series would be
 * thousands of points an hour and would bury the shape of the curve in noise.
 */
export function sampleEquity(desk: DeskState, account: AccountSnapshot, now = Date.now()): void {
  if (now - desk.lastEquitySampleAt < 30_000 && desk.equityHistory.length > 0) return;
  desk.lastEquitySampleAt = now;
  desk.equityHistory.push({ t: now, equity: account.equity, balance: account.balance });
  if (desk.equityHistory.length > MAX_EQUITY_SAMPLES) {
    desk.equityHistory.splice(0, desk.equityHistory.length - MAX_EQUITY_SAMPLES);
  }
}

/** Record a realised trade: one closed position, attributed to a mode. */
export function recordClosedTrade(
  desk: DeskState,
  position: Position,
  closedAt = Date.now(),
): ClosedTrade {
  const mode = desk.positionModes.get(position.ticket) ?? desk.mode;
  const net = position.profit + position.swap + position.commission;
  const rMultiple =
    position.initialRiskMoney && position.initialRiskMoney > 0
      ? net / position.initialRiskMoney
      : null;

  const trade: ClosedTrade = {
    ticket: position.ticket,
    symbol: position.symbol,
    side: position.side,
    volume: position.volume,
    openPrice: position.openPrice,
    profit: position.profit,
    swap: position.swap,
    commission: position.commission,
    rMultiple,
    openedAt: position.openTime,
    closedAt,
  };
  desk.closedTrades.push(trade);
  if (desk.closedTrades.length > MAX_CLOSED_TRADES) {
    desk.closedTrades.splice(0, desk.closedTrades.length - MAX_CLOSED_TRADES);
  }

  const key = outcomeKey(position.symbol, mode);
  const existing = desk.outcomes.get(key) ?? {
    key,
    symbol: position.symbol,
    mode,
    wins: 0,
    losses: 0,
    totalR: 0,
    updatedAt: closedAt,
  };
  if (net > 0) existing.wins++;
  else if (net < 0) existing.losses++;
  // A scratch (net ≈ 0) counts as neither a win nor a loss but still moves R.
  existing.totalR += rMultiple ?? 0;
  existing.updatedAt = closedAt;
  desk.outcomes.set(key, existing);
  desk.positionModes.delete(position.ticket);

  return trade;
}

/** Win/loss counts for a symbol+mode, for the agent's Bayesian prior. */
export function outcomesFor(desk: DeskState, symbol: string, mode: TradeMode): { wins: number; losses: number } {
  const record = desk.outcomes.get(outcomeKey(symbol, mode));
  return { wins: record?.wins ?? 0, losses: record?.losses ?? 0 };
}

/**
 * Drop quotes and derived state for symbols that are no longer selected.
 *
 * Without this the Desk keeps showing (and would happily analyse) the last
 * price a deselected symbol ever printed — which is exactly how a stale
 * XAUUSD quote ends up on screen looking live.
 */
export function pruneDeselectedSymbols(desk: DeskState): number {
  const selected = new Set(desk.watchlist);
  let removed = 0;
  for (const symbol of [...desk.quotes.keys()]) {
    if (selected.has(symbol)) continue;
    desk.quotes.delete(symbol);
    removed++;
  }
  for (const symbol of [...desk.specs.keys()]) {
    if (selected.has(symbol)) continue;
    desk.specs.delete(symbol);
  }
  for (const [key] of [...desk.candles.keys()]) {
    const symbol = key.split("|")[0];
    if (selected.has(symbol)) continue;
    desk.candles.delete(key);
  }
  // Sub-minute candles are derived from this symbol's ticks; keeping them would
  // leave a ten-second chart on screen for a market that is no longer selected.
  for (const symbol of [...desk.ticks.keys()]) {
    if (selected.has(symbol)) continue;
    desk.ticks.delete(symbol);
  }
  for (const [planId, plan] of [...desk.plans]) {
    if (selected.has(plan.symbol)) continue;
    desk.plans.delete(planId);
  }
  return removed;
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

  // Attribute each new position to the mode of the plan that produced it, so
  // the realised-outcome ledger (and therefore the agent's win-rate prior) is
  // per style rather than lumped together.
  for (const position of opened) {
    const mode = desk.planModes.get(position.symbol) ?? null;
    if (mode) desk.positionModes.set(position.ticket, mode);
  }
  for (const position of closed) {
    recordClosedTrade(desk, position);
  }

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
