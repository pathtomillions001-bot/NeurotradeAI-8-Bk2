/**
 * Walk-forward replay of the desk's own decision logic on historical M1 bars.
 *
 * WHAT IT ANSWERS
 *
 * "If the desk had run on these bars, with these costs, what would the record
 * look like?" It calls the same `evaluate()` the live desk calls, and it manages
 * each filled trade with the same rules the EA v3.05 applies: breakeven once,
 * a conditional extension at checkAtR, and a time stop.
 *
 * WHAT IT DOES NOT ANSWER
 *
 * It does not prove the strategy will be profitable. It is a replay of one
 * history, with simple fills, and it cannot know the broker's real spreads, the
 * real slippage, or the news calendar (no high-impact events are supplied, so
 * the news gate is open). Its numbers are a check on the logic, not a forecast.
 *
 * NO LOOK-AHEAD, BY CONSTRUCTION
 *
 *  - A decision made at M1 bar k sees only bars whose period had CLOSED by the
 *    close of bar k. The forming bar of every timeframe is excluded.
 *  - A plan armed at bar k can first fill at bar k+1.
 *  - Management decisions (breakeven, extension) use bar k's extremes but take
 *    effect from bar k+1, so bar k's exit is checked against the old stop first.
 *  - Within a single bar, a stop and a target that are both touched resolve to
 *    the STOP. That is the conservative tie-break: the path inside the bar is
 *    unknown, so the adverse outcome is assumed.
 *  - The Beta prior on win probability sees only trades already closed.
 *
 * The test suite checks the first two of these directly: altering every bar
 * after a cut-off must leave every decision made before the cut-off unchanged.
 */

import { evaluate } from "./agent";
import { tradeMetrics, type TradeMetrics } from "./quant";
import { createRiskState, DEFAULT_RISK_POLICY } from "./risk";
import { pointValuePerLot } from "./sizing";
import type {
  AccountSnapshot,
  ArmedPlan,
  Bar,
  ManagementPlan,
  Quote,
  SymbolSpec,
  Timeframe,
  TradeMode,
} from "./types";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Bars of history handed to evaluate() per timeframe. Indicators read the recent window only. */
export const MAX_VISIBLE_BARS = 720;
/** Warm-up: no decisions until the entry frame has this many M1 bars behind it. */
export const WARMUP_M1_BARS = 240;

/** Timeframes the desk reads, with their length in minutes. W1 starts on a Monday. */
export const TIMEFRAME_MINUTES: ReadonlyArray<readonly [Timeframe, number]> = [
  ["M1", 1],
  ["M2", 2],
  ["M3", 3],
  ["M5", 5],
  ["M15", 15],
  ["M30", 30],
  ["H1", 60],
  ["H4", 240],
  ["D1", 1440],
  ["W1", 10080],
];

// ── Data ─────────────────────────────────────────────────────────────────────

/**
 * Parse a CSV of M1 bars. Header must include time, open, high, low, close;
 * volume (or tick_volume) is optional. Times are UTC: epoch seconds, epoch
 * milliseconds, ISO-8601, or the MT5 export form "2024.01.02 10:15" (read as UTC).
 * A bar whose high/low do not bracket its open and close is rejected, because
 * such a bar is corrupt and would silently distort every indicator.
 */
export function parseCsv(text: string): Bar[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error("CSV has no data rows.");
  const header = (lines[0] as string).toLowerCase().split(",").map((h) => h.trim());
  const col = (...names: string[]): number => {
    for (const name of names) {
      const at = header.indexOf(name);
      if (at >= 0) return at;
    }
    return -1;
  };
  const ti = col("time", "datetime", "timestamp");
  const oi = col("open");
  const hi = col("high");
  const li = col("low");
  const ci = col("close");
  const vi = col("volume", "tick_volume");
  if ([ti, oi, hi, li, ci].some((i) => i < 0)) {
    throw new Error("CSV header must include time, open, high, low and close.");
  }

  const bars: Bar[] = [];
  for (let row = 1; row < lines.length; row++) {
    const cells = (lines[row] as string).split(",").map((c) => c.trim());
    const at = `line ${row + 1}`;
    const time = parseTime(cells[ti] ?? "", at);
    const [o, h, l, c] = [oi, hi, li, ci].map((i) => Number(cells[i]));
    const v = vi >= 0 ? Number(cells[vi]) : 0;
    if (![o, h, l, c].every(Number.isFinite) || !Number.isFinite(v)) {
      throw new Error(`${at}: open, high, low, close must be numbers.`);
    }
    if (h < l || h < Math.max(o as number, c as number) || l > Math.min(o as number, c as number)) {
      throw new Error(`${at}: high/low do not bracket open and close — the bar is corrupt.`);
    }
    bars.push([time, o as number, h as number, l as number, c as number, v || 0]);
  }
  bars.sort((a, b) => a[0] - b[0]);
  // Duplicate timestamps (a re-exported bar) keep the last occurrence.
  const unique: Bar[] = [];
  for (const bar of bars) {
    if (unique.length > 0 && unique[unique.length - 1]![0] === bar[0]) unique[unique.length - 1] = bar;
    else unique.push(bar);
  }
  return unique;
}

function parseTime(raw: string, at: string): number {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e11 ? n : n * 1000;
  }
  const normalised = raw.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, "$1-$2-$3").replace(" ", "T");
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalised) ? normalised : `${normalised}Z`;
  const parsed = Date.parse(withZone);
  if (!Number.isFinite(parsed)) throw new Error(`${at}: cannot read time "${raw}".`);
  return parsed;
}

/**
 * Aggregate M1 bars into a larger frame. Frames are aligned to the epoch, and
 * weeks to Monday 00:00 UTC. The last group may be incomplete: callers decide
 * visibility with `visibleCount`, which excludes any group not yet closed.
 */
export function aggregateBars(m1: Bar[], minutes: number): Bar[] {
  const span = minutes * MINUTE_MS;
  const origin = minutes === 10080 ? 4 * DAY_MS : 0;
  const out: Bar[] = [];
  let current: Bar | null = null;
  let currentStart = Number.NaN;
  for (const bar of m1) {
    const start = Math.floor((bar[0] - origin) / span) * span + origin;
    if (start !== currentStart || current === null) {
      if (current) out.push(current);
      current = [start, bar[1], bar[2], bar[3], bar[4], bar[5]];
      currentStart = start;
    } else {
      current[2] = Math.max(current[2], bar[2]);
      current[3] = Math.min(current[3], bar[3]);
      current[4] = bar[4];
      current[5] += bar[5];
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * How many of a frame's bars have closed by time `at`. A bar starting at `s`
 * closes at `s + span`, and it counts only when that is no later than `at`.
 */
export function visibleCount(bars: Bar[], span: number, at: number): number {
  // Binary search for the number of bars whose start is ≤ at − span.
  const limit = at - span;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((bars[mid] as Bar)[0] <= limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── Trade mechanics (pure) ───────────────────────────────────────────────────

export interface OpenTrade {
  planId: string;
  mode: TradeMode;
  symbol: string;
  isBuy: boolean;
  lots: number;
  entry: number;
  sl: number;
  tp: number;
  openTime: number;
  /** Price distance from entry to the ORIGINAL stop: the basis of every R figure. */
  riskPrice: number;
  /** Money at risk at the original stop, from the plan. The R unit. */
  riskMoney: number;
  management: ManagementPlan;
  beDone: boolean;
  extendState: 0 | 1 | 2;
  mfeR: number;
  maeR: number;
}

export interface ExitHit {
  reason: "sl" | "breakeven_stop" | "tp" | "time_stop";
  price: number;
  time: number;
}

/**
 * Does this bar close the trade, and at what price? Stop before target, always.
 * The stop fills with adverse slippage; the target and the time stop do not
 * gain from it. The time stop closes at the bar's close, net of the spread.
 */
export function exitForBar(
  trade: OpenTrade,
  bar: Bar,
  costs: { halfSpread: number; slippage: number },
): ExitHit | null {
  const [t, , high, low, close] = bar;
  const barEnd = t + MINUTE_MS;
  if (trade.isBuy ? low <= trade.sl : high >= trade.sl) {
    const adverse = trade.isBuy ? trade.sl - costs.slippage : trade.sl + costs.slippage;
    return { reason: stopReason(trade), price: adverse, time: t };
  }
  if (trade.isBuy ? high >= trade.tp : low <= trade.tp) {
    return { reason: "tp", price: trade.tp, time: t };
  }
  const maxHoldMinutes = trade.management.timeStop?.maxHoldMinutes ?? 0;
  if (maxHoldMinutes > 0 && barEnd - trade.openTime >= maxHoldMinutes * MINUTE_MS) {
    const price = trade.isBuy
      ? close - costs.halfSpread - costs.slippage
      : close + costs.halfSpread + costs.slippage;
    return { reason: "time_stop", price, time: barEnd };
  }
  return null;
}

/** A stop hit after the stop has been moved to breakeven is reported as such. */
function stopReason(trade: OpenTrade): "sl" | "breakeven_stop" {
  if (!trade.beDone) return "sl";
  const atOrBeyondEntry = trade.isBuy ? trade.sl >= trade.entry : trade.sl <= trade.entry;
  return atOrBeyondEntry ? "breakeven_stop" : "sl";
}

/**
 * The EA's trend test, applied to a series of closes (oldest first, last closed
 * bar last). The last closed bar must sit on the trade's side of an EMA that has
 * been moving that way for the last five bars. The EA computes the same EMA from
 * iClose, so the two stay in step.
 */
export function trendStillFavourable(closes: number[], isBuy: boolean, period: number): boolean {
  if (period < 2) return false;
  const lag = 5;
  const seedEnd = period * 3 + lag + 1;
  if (closes.length < seedEnd) return false;
  const at = (shift: number): number => closes[closes.length - shift] as number;
  const alpha = 2 / (period + 1);
  let sum = 0;
  for (let s = seedEnd; s > seedEnd - period; s--) sum += at(s);
  let ema = sum / period;
  let emaNow = 0;
  let emaLag = 0;
  for (let s = seedEnd - period; s >= 1; s--) {
    ema = alpha * at(s) + (1 - alpha) * ema;
    if (s === 1) emaNow = ema;
    if (s === 1 + lag) emaLag = ema;
  }
  const last = at(1);
  return isBuy ? last > emaNow && emaNow > emaLag : last < emaNow && emaNow < emaLag;
}

// ── Replay ───────────────────────────────────────────────────────────────────

export interface BacktestConfig {
  symbol: string;
  mode: TradeMode;
  spec: SymbolSpec;
  balance: number;
  /** Fixed spread in points, used for every quote, fill and exit. */
  spreadPoints: number;
  /** Adverse slippage in points on every fill and every stop exit. */
  slippagePoints: number;
  /** Commission per lot per side, in account currency. */
  commissionPerLot: number;
  /** Evaluate the desk every N M1 bars. Each evaluation is expensive (Monte Carlo). */
  decisionEvery?: number;
  /** Restrict the replay window (epoch ms). */
  from?: number;
  to?: number;
  /**
   * Called with the exact inputs about to be handed to the desk, before it runs.
   * It exists so the no-look-ahead contract can be checked on the inputs
   * themselves, not only on their effects.
   */
  onDecisionInput?: (at: number, series: Partial<Record<Timeframe, Bar[]>>) => void;
}

export interface DecisionRecord {
  t: number;
  armed: boolean;
  side: "buy" | "sell" | null;
  trigger: number | null;
  sl: number | null;
  tp: number | null;
  expectancyR: number | null;
}

export interface BacktestTrade {
  planId: string;
  symbol: string;
  mode: TradeMode;
  side: "buy" | "sell";
  lots: number;
  entry: number;
  exit: number;
  openTime: number;
  closeTime: number;
  reason: ExitHit["reason"];
  pnl: number;
  rMultiple: number;
  mfeR: number;
  maeR: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  decisions: DecisionRecord[];
  metrics: TradeMetrics;
  equity: Array<{ t: number; equity: number }>;
  counts: {
    bars: number;
    decisions: number;
    armed: number;
    filled: number;
    expired: number;
    errors: number;
  };
  /** Most frequent refusal reasons (numbers normalised), for diagnosing the gates. */
  refusals: Array<{ reason: string; count: number }>;
  firstError: string | null;
}

interface PendingPlan {
  plan: ArmedPlan;
  isBuy: boolean;
}

export function runBacktest(m1Input: Bar[], config: BacktestConfig): BacktestResult {
  const every = Math.max(1, Math.floor(config.decisionEvery ?? 5));
  const m1 = m1Input.filter(
    (bar) => (config.from === undefined || bar[0] >= config.from) && (config.to === undefined || bar[0] <= config.to),
  );
  const frames = new Map<Timeframe, { bars: Bar[]; span: number }>();
  for (const [tf, minutes] of TIMEFRAME_MINUTES) {
    frames.set(tf, { bars: tf === "M1" ? m1 : aggregateBars(m1, minutes), span: minutes * MINUTE_MS });
  }

  const pointMoney = pointValuePerLot(config.spec) / config.spec.point; // money per 1.00 price, per lot
  const halfSpread = (config.spreadPoints * config.spec.point) / 2;
  const slippage = config.slippagePoints * config.spec.point;
  const costs = { halfSpread, slippage };

  const trades: BacktestTrade[] = [];
  const decisions: DecisionRecord[] = [];
  const equity: Array<{ t: number; equity: number }> = [];
  const refusalTally = new Map<string, number>();
  const counts = { bars: m1.length, decisions: 0, armed: 0, filled: 0, expired: 0, errors: 0 };
  let firstError: string | null = null;
  let balance = config.balance;
  let pending: PendingPlan | null = null;
  let open: OpenTrade | null = null;
  const outcomesAt = (t: number) => {
    // Only trades already closed by time t inform the prior.
    let wins = 0;
    let losses = 0;
    for (const trade of trades) {
      if (trade.closeTime > t) continue;
      if (trade.pnl > 0) wins++;
      else if (trade.pnl < 0) losses++;
    }
    return { wins, losses };
  };

  const visibleSeries = (bar: number): Partial<Record<Timeframe, Bar[]>> => {
    const at = m1[bar]![0] + MINUTE_MS; // the close of M1 bar `bar`
    const series: Partial<Record<Timeframe, Bar[]>> = {};
    for (const [tf] of TIMEFRAME_MINUTES) {
      const frame = frames.get(tf)!;
      const count = visibleCount(frame.bars, frame.span, at);
      series[tf] = frame.bars.slice(Math.max(0, count - MAX_VISIBLE_BARS), count);
    }
    return series;
  };

  const close = (trade: OpenTrade, hit: ExitHit) => {
    const direction = trade.isBuy ? 1 : -1;
    const lots = trade.lots;
    const grossMoney = (hit.price - trade.entry) * direction * pointMoney * lots;
    const commission = config.commissionPerLot * lots * 2; // both sides
    const pnl = grossMoney - commission;
    const rMultiple = trade.riskMoney > 0 ? pnl / trade.riskMoney : 0;
    balance += pnl;
    trades.push({
      planId: trade.planId,
      symbol: trade.symbol,
      mode: trade.mode,
      side: trade.isBuy ? "buy" : "sell",
      lots,
      entry: trade.entry,
      exit: hit.price,
      openTime: trade.openTime,
      closeTime: hit.time,
      reason: hit.reason,
      pnl,
      rMultiple,
      mfeR: trade.mfeR,
      maeR: trade.maeR,
    });
    equity.push({ t: hit.time, equity: balance });
    open = null;
  };

  for (let k = 0; k < m1.length; k++) {
    const bar = m1[k] as Bar;
    const [t, , high, low] = bar;

    // (a) Manage the open trade against this bar. Management decided here takes
    // effect from the next bar (see the module header).
    if (open) {
      const trade: OpenTrade = open;
      const hit = exitForBar(trade, bar, costs);
      if (hit) {
        close(trade, hit);
      } else {
        const risk = trade.riskPrice;
        const bestMove = trade.isBuy ? high - trade.entry : trade.entry - low;
        const worstMove = trade.isBuy ? low - trade.entry : trade.entry - high;
        trade.mfeR = Math.max(trade.mfeR, bestMove / risk);
        trade.maeR = Math.min(trade.maeR, worstMove / risk);
        const progress = bestMove / risk;
        const management = trade.management;
        const sign = trade.isBuy ? 1 : -1;

        if (!trade.beDone && management.breakeven && progress >= management.breakeven.triggerR) {
          const candidate = trade.entry + sign * management.breakeven.offsetR * risk;
          if (trade.isBuy ? candidate > trade.sl : candidate < trade.sl) trade.sl = candidate;
          trade.beDone = true;
        }
        const ext = management.extension;
        if (ext && trade.extendState === 0 && progress >= ext.checkAtR) {
          const closes = (visibleSeries(k)[ext.timeframe] ?? []).map((b) => b[4]);
          if (trendStillFavourable(closes, trade.isBuy, ext.emaPeriod)) {
            trade.tp = trade.entry + sign * ext.extendToR * risk;
            const lock = trade.entry + sign * ext.lockR * risk;
            if (trade.isBuy ? lock > trade.sl : lock < trade.sl) trade.sl = lock;
            trade.extendState = 2;
          } else {
            trade.extendState = 1;
          }
        }
      }
    }

    // (b) A pending plan: expire, or fill when this bar trades through the trigger.
    if (pending && !open) {
      const { plan, isBuy } = pending;
      if (t >= plan.expiresAt) {
        counts.expired++;
        pending = null;
      } else if (isBuy ? high >= plan.trigger : low <= plan.trigger) {
        const fill = isBuy
          ? Math.max(plan.trigger, bar[1]) + halfSpread + slippage
          : Math.min(plan.trigger, bar[1]) - halfSpread - slippage;
        const riskPrice = Math.abs(fill - plan.sl);
        open = {
          planId: plan.id,
          mode: plan.mode,
          symbol: plan.symbol,
          isBuy,
          lots: plan.lots,
          entry: fill,
          sl: plan.sl,
          tp: plan.tp[0] as number,
          openTime: t,
          riskPrice,
          riskMoney: plan.riskMoney,
          management: plan.management,
          beDone: false,
          extendState: 0,
          mfeR: 0,
          maeR: 0,
        };
        counts.filled++;
        pending = null;
        // The fill bar itself is checked for exits against the stop and target
        // (stop first), so a fill that is immediately stopped out is recorded.
        const hit = exitForBar(open, bar, costs);
        if (hit) close(open, hit);
      }
    }

    // (c) A decision at this bar: only when nothing is pending or open.
    if (k < WARMUP_M1_BARS || k % every !== 0 || open || pending) continue;
    if (k + 1 >= m1.length) continue;
    const mid = bar[4];
    const at = t + MINUTE_MS;
    const quote: Quote = {
      symbol: config.symbol,
      bid: mid - halfSpread,
      ask: mid + halfSpread,
      spreadPoints: config.spreadPoints,
      ts: at,
      ageMs: 0,
    };
    const account: AccountSnapshot = {
      balance,
      equity: balance,
      margin: 0,
      freeMargin: balance,
      marginLevel: Number.POSITIVE_INFINITY,
      currency: "USD",
      leverage: 100,
      mode: "hedging",
      isLive: false,
      dayStartEquity: balance,
      peakEquity: Math.max(config.balance, balance),
    };
    counts.decisions++;
    const series = visibleSeries(k);
    config.onDecisionInput?.(at, series);
    let decision;
    try {
      decision = evaluate({
        symbol: config.symbol,
        mode: config.mode,
        spec: config.spec,
        quote,
        series,
        account,
        positions: [],
        specs: new Map([[config.symbol, config.spec]]),
        riskState: createRiskState(),
        news: { available: true, checkedAt: at, events: [] },
        now: at,
        outcomes: outcomesAt(at),
      });
    } catch (error) {
      counts.errors++;
      firstError ??= error instanceof Error ? error.message : String(error);
      continue;
    }

    if (decision.armed && decision.plan) {
      counts.armed++;
      const plan = decision.plan;
      pending = { plan, isBuy: plan.side === "buy" };
      decisions.push({
        t: at,
        armed: true,
        side: plan.side,
        trigger: plan.trigger,
        sl: plan.sl,
        tp: plan.tp[0] ?? null,
        expectancyR: decision.expectancyR ?? null,
      });
    } else {
      decisions.push({ t: at, armed: false, side: null, trigger: null, sl: null, tp: null, expectancyR: decision.expectancyR ?? null });
      const reason = (decision.rejections[0] ?? "no trade").replace(/[-+]?\d+(\.\d+)?/g, "#").slice(0, 80);
      refusalTally.set(reason, (refusalTally.get(reason) ?? 0) + 1);
    }
  }

  // A plan still pending at the end of the data never filled.
  if (pending) counts.expired++;
  // A trade still open at the end is closed at the last bar's close (marked to market).
  if (open && m1.length > 0) {
    const last = m1[m1.length - 1] as Bar;
    const hit: ExitHit = { reason: "time_stop", price: last[4], time: last[0] + MINUTE_MS };
    close(open, hit);
  }

  const years = m1.length > 1 ? Math.max(1 / 365, ((m1[m1.length - 1] as Bar)[0] - (m1[0] as Bar)[0]) / (365.25 * DAY_MS)) : 1 / 365;
  const metrics = tradeMetrics(
    trades.map((trade) => trade.rMultiple),
    { years, riskPct: DEFAULT_RISK_POLICY.baseRiskPct },
  );
  const refusals = [...refusalTally.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return { trades, decisions, metrics, equity, counts, refusals, firstError };
}
