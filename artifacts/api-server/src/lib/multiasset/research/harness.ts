/**
 * Research harness — the runner and the acceptance GATES (WP2).
 *
 * This is the module every later work package is measured by. It answers, for
 * a given strategy and a given data series:
 *
 *   • how often did it arm?            (arm rate)
 *   • did the plan actually fill?      (fill rate)
 *   • what did each trade REALISE, after spread, commission and slippage, with
 *     management executed exactly as the EA executes it? (E[R], R distribution)
 *   • was its stated probability TRUE? (calibration)
 *
 * …and then compares the answers against the gates that decide whether the
 * configuration may leave shadow mode:
 *
 *   NULL (driftless / block-shuffled / phase-randomised)
 *     arm rate ≤ 3% of evaluations
 *     mean realised R ≥ −(cost_R + 0.05)
 *     ≤ 5% of runs show DSR-significant profit
 *
 *   POSITIVE CONTROL (regime-switching drift + AR(1) residual)
 *     arm rate ≥ 10%
 *     mean realised R ≥ +0.30
 *     |predicted − realised| ≤ 0.15R
 *
 *   CALIBRATION (held out)
 *     reliability slope in [0.8, 1.2]
 *     Brier skill ≥ 0
 *
 * A gate is a PASS/FAIL with the measured number attached. A failing gate is
 * reported, never explained away: the correct response to a failing null gate
 * is to disable the configuration, not to re-run it with another seed.
 */

import { evaluate, type AgentInput } from "../agent";
import { createRiskState, recordOutcome, type RiskState } from "../risk";
import type { AccountSnapshot, ArmedPlan, Bar, Quote, SymbolSpec, Timeframe, TradeMode } from "../types";
import { causalAtrSeries, simulatePlan, type ExecutionOptions, type SimulatedTrade } from "./executed-policy";
import {
  deflatedSharpeRatio,
  lowerBoundMeanR,
  tradeStats,
  type TradeRecord,
  type TradeStats,
} from "./metrics";
import type { SyntheticSeries } from "./generators";

// ── A strategy the harness can run ──────────────────────────────────────────

export interface DecisionContext {
  symbol: string;
  mode: TradeMode;
  spec: SymbolSpec;
  /**
   * CLOSED bars as of `now`, per frame, oldest first.
   *
   * "Closed" is not decoration: a 10:15 M15 bar carries the price at 10:30, so
   * feeding it to a decision taken at 10:20 is leakage worth several points of
   * fake accuracy. The harness applies the rule uniformly — a bar is visible
   * only once its own width has elapsed.
   */
  series: Partial<Record<Timeframe, Bar[]>>;
  quote: Quote;
  account: AccountSnapshot;
  /**
   * The desk's risk state as it stands at this decision.
   *
   * The harness carries it across trades and feeds every realised outcome back
   * in, so the consecutive-loss backstop, the loss ladder and the per-symbol
   * cooldown behave as they do live. A study that reset the state on every bar
   * would measure a desk nobody runs.
   */
  riskState: RiskState;
  now: number;
}

export interface Strategy {
  id: string;
  /** One decision, taken as of `ctx.now`. Must read nothing after it. */
  decide(ctx: DecisionContext): ArmedPlan | null;
}

export interface HarnessOptions {
  spec: SymbolSpec;
  mode: TradeMode;
  /** Evaluate every `stride` bars of the fastest frame. */
  stride?: number;
  /** Bars a position may be held before the horizon closes it. */
  horizonBars?: number;
  /** Bars of warm-up before the first decision. */
  warmupBars?: number;
  /** Trading cost model. */
  execution?: ExecutionOptions;
  account?: AccountSnapshot;
  /** Configurations tried in this study, for the DSR deflation. */
  trials?: number;
}

export interface HarnessRun {
  strategy: string;
  symbol: string;
  mode: TradeMode;
  evaluations: number;
  arms: number;
  armRate: number;
  fills: number;
  fillRate: number;
  trades: SimulatedTrade[];
  stats: TradeStats;
  /** Lower-80% bound of the mean R — the rollout's Phase-3 gate. */
  lowerBoundMeanR: number;
  /** DSR over the per-trade R series (what the null gate's 5% test uses). */
  dsr: number;
  /** Mean predicted probability at entry, versus the realised hit rate. */
  meanPredicted: number;
  predictedVsRealised: number;
}

/**
 * Visible CLOSED bars for one frame at time `now`.
 *
 * Binary search rather than filter: a study runs this once per frame per
 * evaluation, and the cost of a linear scan over 100k bars is real.
 */
export function closedBarsAt(bars: Bar[], widthMs: number, now: number): Bar[] {
  // Bars are sorted; find the last one whose own close (start + width) ≤ now.
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid] as Bar)[0] + widthMs <= now) lo = mid + 1;
    else hi = mid;
  }
  return bars.slice(0, lo);
}

/**
 * Run one strategy over one series. Deterministic.
 *
 * The decision clock is the FASTEST frame in the band: that is the frame the
 * desk's stop, ATR and time stop live on, and the one whose bars arrive most
 * often. Every decision at time t may read only bars that had already closed at
 * t on every frame — see `closedBarsAt`.
 */
export function runHarness(input: {
  frames: Partial<Record<Timeframe, Bar[]>>;
  symbol: string;
  strategy: Strategy;
  options: HarnessOptions;
}): HarnessRun {
  const { frames, symbol, strategy, options } = input;
  const spec = options.spec;
  const stride = Math.max(1, options.stride ?? 5);
  const warmup = Math.max(60, options.warmupBars ?? 120);
  const horizonBars = Math.max(5, options.horizonBars ?? 30);
  const account = options.account ?? defaultAccount();

  const frameEntries = (Object.entries(frames) as [Timeframe, Bar[]][])
    .filter(([, bars]) => bars.length >= 30)
    .sort((a, b) => frameWidthMs(a[0]) - frameWidthMs(b[0]) || 0);
  if (frameEntries.length === 0) {
    return emptyRun(strategy.id, symbol, options.mode);
  }
  const [baseFrame, baseBars] = frameEntries[0] as [Timeframe, Bar[]];
  const widths = new Map<Timeframe, number>(frameEntries.map(([f]) => [f, frameWidthMs(f)]));

  const atrSeries = causalAtrSeries(baseBars, 14);
  const spreadPoints = options.execution?.spreadPoints ?? baseBars.map(() => spec.spreadPoints);
  const execution: ExecutionOptions = { spec, ...options.execution, spreadPoints };

  let evaluations = 0;
  let arms = 0;
  let riskState = createRiskState();
  const trades: SimulatedTrade[] = [];

  for (let i = warmup; i < baseBars.length - horizonBars - 2; i += stride) {
    const now = (baseBars[i] as Bar)[0];
    evaluations++;
    const visible: Partial<Record<Timeframe, Bar[]>> = {};
    for (const [frame, bars] of frameEntries) visible[frame] = closedBarsAt(bars, widths.get(frame) as number, now);
    const last = (visible[baseFrame] as Bar[])[(visible[baseFrame] as Bar[]).length - 1] as Bar;
    const price = last[4];
    const quote: Quote = {
      symbol,
      bid: price,
      ask: price + spec.spreadPoints * spec.point,
      spreadPoints: spec.spreadPoints,
      ts: now,
      ageMs: 100,
    };
    const ctx: DecisionContext = {
      symbol,
      mode: options.mode,
      spec,
      series: visible,
      quote,
      account,
      riskState,
      now,
    };
    const plan = strategy.decide(ctx);
    if (!plan) continue;
    arms++;

    const result = simulatePlan({
      plan,
      bars: baseBars,
      decisionIndex: i,
      spec,
      options: execution,
      atrSeries,
      horizonBars,
    });
    if (!result.trade) continue;
    trades.push(result.trade);
    riskState = recordOutcome(riskState, {
      symbol,
      profit: result.trade.r * (plan.riskMoney > 0 ? plan.riskMoney : 0),
      closedAt: now + result.trade.bars * frameWidthMs(baseFrame),
    });
  }

  const stats = tradeStats(trades as TradeRecord[]);
  const rSeries = trades.map((t) => t.r);
  const dsr = rSeries.length >= 5 ? deflatedSharpeRatio(rSeries, options.trials ?? 1) : 0;
  const meanPredicted =
    trades.length > 0 ? trades.reduce((a, t) => a + (t.predictedProbability ?? 0), 0) / trades.length : 0;

  return {
    strategy: strategy.id,
    symbol,
    mode: options.mode,
    evaluations,
    arms,
    armRate: evaluations === 0 ? 0 : arms / evaluations,
    fills: trades.length,
    fillRate: arms === 0 ? 0 : trades.length / arms,
    trades,
    stats,
    lowerBoundMeanR: lowerBoundMeanR(stats),
    dsr,
    meanPredicted,
    predictedVsRealised: meanPredicted - stats.hitRate,
  };
}

function frameWidthMs(frame: Timeframe): number {
  const table: Partial<Record<Timeframe, number>> = {
    S10: 10_000,
    S30: 30_000,
    M1: 60_000,
    M2: 120_000,
    M3: 180_000,
    M5: 300_000,
    M15: 900_000,
    M30: 1_800_000,
    H1: 3_600_000,
    H4: 14_400_000,
    D1: 86_400_000,
    W1: 604_800_000,
  };
  return table[frame] ?? 60_000;
}

function emptyRun(strategy: string, symbol: string, mode: TradeMode): HarnessRun {
  const stats = tradeStats([]);
  return {
    strategy,
    symbol,
    mode,
    evaluations: 0,
    arms: 0,
    armRate: 0,
    fills: 0,
    fillRate: 0,
    trades: [],
    stats,
    lowerBoundMeanR: 0,
    dsr: 0,
    meanPredicted: 0,
    predictedVsRealised: 0,
  };
}

/** The live desk as a harness strategy — the BASELINE. */
export function legacyDeskStrategy(id = "desk-v3"): Strategy {
  return {
    id,
    decide(ctx) {
      const input: AgentInput = {
        symbol: ctx.symbol,
        mode: ctx.mode,
        spec: ctx.spec,
        quote: ctx.quote,
        series: ctx.series,
        account: ctx.account,
        positions: [],
        specs: new Map([[ctx.symbol, ctx.spec]]),
        riskState: ctx.riskState,
        now: ctx.now,
      };
      const decision = evaluate(input);
      return decision.armed ? decision.plan : null;
    },
  };
}

function defaultAccount(): AccountSnapshot {
  return {
    balance: 10_000,
    equity: 10_000,
    margin: 0,
    freeMargin: 10_000,
    marginLevel: Infinity,
    currency: "USD",
    leverage: 500,
    mode: "hedging",
    isLive: false,
    dayStartEquity: 10_000,
    peakEquity: 10_000,
  };
}

// ── The gates ───────────────────────────────────────────────────────────────

export interface GateResult {
  gate: string;
  pass: boolean;
  measured: number;
  threshold: number;
  detail: string;
}

export interface GateReport {
  pass: boolean;
  gates: GateResult[];
}

export const NULL_ARM_RATE_MAX = 0.03;
export const NULL_RUNS_DSR_SIGNIFICANT_MAX = 0.05;
export const CONTROL_ARM_RATE_MIN = 0.1;
export const CONTROL_MEAN_R_MIN = 0.3;
export const CONTROL_PREDICTED_GAP_MAX = 0.15;
export const CALIBRATION_SLOPE_MIN = 0.8;
export const CALIBRATION_SLOPE_MAX = 1.2;

/**
 * Null gates: what a strategy must NOT do on data with no structure.
 *
 * The tolerance on the mean is −(cost_R + 0.05): a strategy that never arms
 * has no cost, so the bound is essentially "do not lose money on noise". A
 * strategy that arms and loses slightly less than the cost of trading is not
 * evidence of an edge — it is evidence of not trading much.
 */
export function nullGates(run: HarnessRun, meanCostR: number): GateReport {
  const gates: GateResult[] = [
    {
      gate: "null: arm rate ≤ 3%",
      pass: run.armRate <= NULL_ARM_RATE_MAX + 1e-12,
      measured: run.armRate,
      threshold: NULL_ARM_RATE_MAX,
      detail: `${run.arms} arms in ${run.evaluations} evaluations on structureless data`,
    },
    {
      gate: "null: mean realised R ≥ −(cost+0.05)",
      pass: run.stats.meanR >= -(meanCostR + 0.05) - 1e-9,
      measured: run.stats.meanR,
      threshold: -(meanCostR + 0.05),
      detail: `${run.stats.trades} realised trades, mean ${run.stats.meanR.toFixed(3)}R`,
    },
    {
      gate: "null: DSR not significant",
      pass: run.dsr < 0.95,
      measured: run.dsr,
      threshold: 0.95,
      detail: `Deflated Sharpe probability ${(run.dsr * 100).toFixed(1)}% on noise`,
    },
  ];
  return { pass: gates.every((g) => g.pass), gates };
}

/** Positive-control gates: what a strategy MUST be able to do. */
export function controlGates(run: HarnessRun): GateReport {
  const gates: GateResult[] = [
    {
      gate: "control: arm rate ≥ 10%",
      pass: run.armRate >= CONTROL_ARM_RATE_MIN - 1e-12,
      measured: run.armRate,
      threshold: CONTROL_ARM_RATE_MIN,
      detail: `${run.arms} arms in ${run.evaluations} evaluations on a series with a known edge`,
    },
    {
      gate: "control: mean realised R ≥ +0.30",
      pass: run.stats.meanR >= CONTROL_MEAN_R_MIN - 1e-9,
      measured: run.stats.meanR,
      threshold: CONTROL_MEAN_R_MIN,
      detail: `${run.stats.trades} trades, mean ${run.stats.meanR.toFixed(3)}R, hit rate ${(run.stats.hitRate * 100).toFixed(0)}%`,
    },
    {
      gate: "control: |predicted − realised| ≤ 0.15R",
      pass: Math.abs(run.predictedVsRealised) <= CONTROL_PREDICTED_GAP_MAX + 1e-9,
      measured: Math.abs(run.predictedVsRealised),
      threshold: CONTROL_PREDICTED_GAP_MAX,
      detail: `predicted ${(run.meanPredicted * 100).toFixed(1)}% vs realised ${(run.stats.hitRate * 100).toFixed(1)}%`,
    },
  ];
  return { pass: gates.every((g) => g.pass), gates };
}

/** Calibration gates, from a held-out calibration report. */
export function calibrationGates(report: {
  reliabilitySlope: number;
  brierSkill: number;
  samples: number;
  slopeIdentifiable?: boolean;
}): GateReport {
  const gates: GateResult[] = [
    {
      gate: "calibration: reliability slope ∈ [0.8, 1.2]",
      pass:
        report.samples >= 30 &&
        report.slopeIdentifiable !== false &&
        report.reliabilitySlope >= CALIBRATION_SLOPE_MIN &&
        report.reliabilitySlope <= CALIBRATION_SLOPE_MAX,
      measured: report.slopeIdentifiable === false ? Number.NaN : report.reliabilitySlope,
      threshold: 1,
      detail:
        report.samples < 30
          ? `only ${report.samples} labelled samples — not enough to fit a reliability slope`
          : report.slopeIdentifiable === false
            ? "UNIDENTIFIABLE: the predictions barely vary, so no slope can be measured (this is not evidence of calibration)"
            : `${report.samples} labelled samples, slope ${report.reliabilitySlope.toFixed(3)}`,
    },
    {
      gate: "calibration: Brier skill ≥ 0",
      pass: report.samples >= 30 && report.brierSkill >= 0,
      measured: report.brierSkill,
      threshold: 0,
      detail: `Brier skill ${report.brierSkill.toFixed(4)} vs the base rate`,
    },
  ];
  return { pass: gates.every((g) => g.pass), gates };
}

/** The fraction of null runs that looked DSR-significant (must be ≤ 5%). */
export function nullSignificanceRate(runs: HarnessRun[]): number {
  if (runs.length === 0) return 0;
  return runs.filter((r) => r.dsr >= 0.95).length / runs.length;
}
