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
import { regimePermit, type RegimeHmmConfig, type RegimePermit } from "../regime-hmm";
import { DEFAULT_ALPHA_CONFIG, type AlphaConfig } from "../alpha/edge";
import type { AlphaAgent } from "../alpha";

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

// ── The WP4 alpha agents as a strategy ──────────────────────────────────────

/**
 * One entry per decision an alpha strategy made (or refused to make).
 *
 * The ledger is the audit trail, and it records the REFUSALS as carefully as the
 * takes: whether the desk had no plan, the agent had no view, the two disagreed
 * on direction, or the probability was below a floor. A study that only reported
 * its trades could not tell "the agent never fires" from "the agent and the desk
 * never agree", and those are different problems with different fixes.
 *
 * The reason codes are mutually exclusive and PRIORITY ORDERED, exactly as listed
 * in the `reason` union: a decision where the desk had no plan is recorded as
 * `desk-refused` even if the agent also had no view, because the desk's refusal
 * is what stopped it.
 */
export interface AlphaLedgerEntry {
  index: number;
  agent: string;
  /** null when the agent had no view. */
  direction: string | null;
  outOfBand: boolean;
  probability: number | null;
  /** Machine-readable reason code. */
  reason:
    | "taken"
    | "desk-refused"
    | "agent-no-view"
    | "direction-mismatch"
    | "below-probability-floor";
  detail: string | null;
}

/** Counts of every ledger reason over a paper-trading leg. */
export function summariseAlphaLedger(ledger: AlphaLedgerEntry[]): Record<AlphaLedgerEntry["reason"], number> {
  const out = {
    taken: 0,
    "desk-refused": 0,
    "agent-no-view": 0,
    "direction-mismatch": 0,
    "below-probability-floor": 0,
  } as Record<AlphaLedgerEntry["reason"], number>;
  for (const entry of ledger) out[entry.reason] = (out[entry.reason] ?? 0) + 1;
  return out;
}

export interface AlphaStrategyOptions {
  agent: AlphaAgent;
  /**
   * The strategy that supplies the trade's GEOMETRY — entry type, stop, targets,
   * sizing. The agent supplies the direction and the probability; it never
   * places a stop, because a stop is an execution decision and mixing the two
   * into one object is how a research finding becomes unauditable.
   */
  inner?: Strategy;
  /**
   * Minimum stated probability before the strategy will act at all.
   *
   * Defaults to 0 — deliberately. A probability threshold is a SIZING and
   * GATEKEEPER decision (WP6 owns `p_LCB`), and a study that silently applied
   * one here would measure a threshold nobody chose.
   */
  minProbability?: number;
  /** The frame the agent reads; default: the fastest visible frame. */
  frame?: Timeframe;
  config?: AlphaConfig;
  /** Shared per-series scratch (see `AlphaContext.cache`). */
  cache?: Map<string, unknown>;
  id?: string;
}

export interface AlphaStrategy extends Strategy {
  ledger: AlphaLedgerEntry[];
}

/**
 * Wrap the desk with one alpha agent: the desk decides the geometry, the agent
 * decides whether this is its setup.
 *
 * This is the PAPER-TRADING interface: a study through this strategy executes
 * exactly the trades the same wiring would execute live (the shipped
 * `position-manager` runs inside the simulator), so a claim that survives here
 * has been through the desk's real stop, targets and management rather than a
 * simplified stand-in.
 */
export function alphaStrategy(options: AlphaStrategyOptions): AlphaStrategy {
  const inner = options.inner ?? legacyDeskStrategy("desk-v3");
  const ledger: AlphaLedgerEntry[] = [];
  const cfg = options.config ?? DEFAULT_ALPHA_CONFIG;
  return {
    id: options.id ?? `${inner.id}+${options.agent.id}`,
    ledger,
    decide(ctx) {
      const frame = options.frame ?? fastestFrame(ctx.series);
      const bars = (frame ? ctx.series[frame] : undefined) ?? [];
      const barIndex = Math.max(0, bars.length - 1);
      const view = options.agent.view({
        symbol: ctx.symbol,
        mode: ctx.mode,
        spec: ctx.spec,
        series: ctx.series,
        quote: ctx.quote,
        now: ctx.now,
        ...(options.cache ? { cache: options.cache } : {}),
      });
      const plan = inner.decide(ctx);
      if (!plan) {
        ledger.push({
          index: barIndex,
          agent: options.agent.id,
          direction: view ? view.direction : null,
          outOfBand: false,
          probability: view ? view.probability : null,
          reason: "desk-refused",
          detail: "the desk's own geometry gates found no plan at this bar",
        });
        return null;
      }
      if (!view) {
        ledger.push({
          index: barIndex,
          agent: options.agent.id,
          direction: null,
          outOfBand: false,
          probability: null,
          reason: "agent-no-view",
          detail: "the agent had no setup (or not enough closed occurrences) here",
        });
        return null;
      }
      if (view.direction !== plan.side) {
        ledger.push({
          index: barIndex,
          agent: options.agent.id,
          direction: view.direction,
          outOfBand: false,
          probability: view.probability,
          reason: "direction-mismatch",
          detail: `agent says ${view.direction}, the desk's plan is ${plan.side}`,
        });
        return null;
      }
      if ((options.minProbability ?? 0) > 0 && view.probability < (options.minProbability as number)) {
        ledger.push({
          index: barIndex,
          agent: options.agent.id,
          direction: view.direction,
          outOfBand: true,
          probability: view.probability,
          reason: "below-probability-floor",
          detail: `probability ${view.probability.toFixed(3)} below the ${(options.minProbability as number).toFixed(3)} floor`,
        });
        return null;
      }
      ledger.push({
        index: barIndex,
        agent: options.agent.id,
        direction: view.direction,
        outOfBand: false,
        probability: view.probability,
        reason: "taken",
        detail: null,
      });
      // The agent's MEASURED probability becomes the plan's stated probability:
      // that is the number the harness calibrates, the journal records and WP6
      // will size from. Everything else — stop, targets, size — stays the desk's.
      return {
        ...plan,
        rationale: { ...plan.rationale, winProbability: view.probability },
      };
    },
  };
}

// ── The WP3 regime gate as a strategy ───────────────────────────────────────

/**
 * What the regime layer decided, across a run.
 *
 * Kept on the strategy object rather than inside `HarnessRun`: it is a property
 * of the DECISION LAYER, not of the executed trades, and a shadow variant that
 * changes no trade must still be able to report what it would have done.
 */
export interface RegimeTally {
  /** Decisions where the inner strategy wanted to arm and the regime was asked. */
  asked: number;
  permits: number;
  vetoes: number;
  /** Refusals because the model could not be fitted at all. */
  unavailable: number;
  byCode: Record<string, number>;
  byState: Record<string, number>;
}

export interface RegimeStrategyOptions {
  /** true = the permit blocks the trade; false = shadow (observe only). */
  veto: boolean;
  /** Frame the regime agent reads; default: the fastest visible frame. */
  frame?: Timeframe;
  config?: Partial<RegimeHmmConfig>;
  /** The strategy being gated; default: the live desk. */
  inner?: Strategy;
  id?: string;
  /**
   * Shared memo so a veto run and a shadow run over the same series pay for one
   * EM fit instead of two. The live desk computes the permit once per
   * evaluation, and a study should measure the same thing.
   */
  memo?: Map<string, RegimePermit>;
}

export interface RegimeStrategy extends Strategy {
  tally: RegimeTally;
}

/**
 * Wrap a strategy with the WP3 regime permission.
 *
 * The gate runs AFTER the inner strategy has decided: the plan carries the side,
 * and the regime the trade needs depends on that side. A veto returns no plan at
 * all, so the harness sees exactly what the live desk would do — nothing armed,
 * no risk consumed, no position simulated.
 */
export function regimeGatedDeskStrategy(options: RegimeStrategyOptions): RegimeStrategy {
  const inner = options.inner ?? legacyDeskStrategy("desk-v3");
  const tally: RegimeTally = { asked: 0, permits: 0, vetoes: 0, unavailable: 0, byCode: {}, byState: {} };
  return {
    id: options.id ?? `${inner.id}+regime${options.veto ? "" : "-shadow"}`,
    tally,
    decide(ctx) {
      const plan = inner.decide(ctx);
      if (!plan) return null;
      const frame = options.frame ?? fastestFrame(ctx.series);
      // No bars at all is still a question the gate must answer — and its answer
      // is REGIME_UNAVAILABLE, which refuses. "We could not measure the regime"
      // is not "the regime is fine".
      const bars = (frame ? ctx.series[frame] : undefined) ?? [];
      tally.asked++;
      const key = [ctx.symbol, ctx.mode, plan.side, frame, bars.length, (bars[bars.length - 1] as Bar)[0]].join("|");
      let permit = options.memo?.get(key);
      if (!permit) {
        permit = regimePermit({ bars, mode: ctx.mode, side: plan.side, config: options.config });
        options.memo?.set(key, permit);
      }
      for (const code of permit.codes) tally.byCode[code] = (tally.byCode[code] ?? 0) + 1;
      tally.byState[permit.state] = (tally.byState[permit.state] ?? 0) + 1;
      if (permit.codes.includes("REGIME_UNAVAILABLE")) tally.unavailable++;
      if (permit.permit) {
        tally.permits++;
        return plan;
      }
      tally.vetoes++;
      return options.veto ? null : plan;
    },
  };
}

function fastestFrame(series: Partial<Record<Timeframe, Bar[]>>): Timeframe | null {
  const entries = (Object.entries(series) as [Timeframe, Bar[]][]).filter(([, bars]) => bars.length > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => frameWidthMs(a[0]) - frameWidthMs(b[0]));
  return (entries[0] as [Timeframe, Bar[]])[0];
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
