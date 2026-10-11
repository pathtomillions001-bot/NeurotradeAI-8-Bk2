/**
 * WP7 — the study that measures what the execution agent actually does, on the
 * same synthetic corpora the rest of the programme uses.
 *
 * ── WHAT IS MEASURED, AND WHY IT IS THE HONEST INSTRUMENT ───────────────────
 *
 * WP5/WP6 answer "is there an edge". This layer claims something different and
 * smaller, and it is measured with the instrument that exists for it — the
 * executed-policy simulator (`research/executed-policy.ts`), which walks the bars
 * FORWARD from the decision bar and runs the desk's own management state machine:
 *
 *   WP7 — the entry style. The same plan geometry is simulated twice, once with
 *     the legacy trigger ("break") and once resting a limit at the pullback
 *     retracement ("limit"), and the outcomes are compared per decision. This is
 *     a paired measurement: the market, the stop, the target and the management
 *     are identical, so the difference is the entry and nothing else. The
 *     direction alternates deterministically, because the entry-style question
 *     is symmetric and always going long on an up-trending generator would
 *     answer the wrong question.
 *
 *     Also measured: the timing ledger's premise. Realised outcomes are bucketed
 *     by the minute-of-week of the DECISION bar and the permit rule is applied
 *     to the resulting ledger, so the report states how often that gate would
 *     refuse — a gate that refuses most moments is not a filter, it is an exit.
 *
 * ── WHAT IS NOT MEASURED (AND IS SAID SO IN THE REPORT) ─────────────────────
 *
 *   • the spread z-score: the synthetic corpora carry no SPREAD column, so there
 *     is no spread history to be a z-score against. The gate is only-refuses and
 *     abstains when unmeasured; the unit tests are its coverage, and the live
 *     desk's own quote record is what will measure it.
 *   • the slippage ledger: it is a record of the desk's OWN fills, and a fixture
 *     has none. Its arithmetic is unit-tested; the live ledger is its measure.
 *   • the Kelly term belongs to WP8's composition, not here.
 *
 * The portfolio half of the programme is measured in `research/portfolio-eval.ts`,
 * which consumes the realised R sequence this file produces.
 */
import { atrSeries, CLOSE } from "../math";
import { MODE_HORIZON_BARS } from "../confluence";
import { STOP_ATR_MULT } from "../desk-constants";
import { buildManagementPlan } from "../agent";
import { SLIPPAGE_MEASUREMENT_CEILING_MULT } from "../execution";
import { TIMING_MIN_BUCKET_SAMPLES, createTimingLedger, recordTimingOutcome, timingPermit } from "../execution";
import { simulatePlan } from "./executed-policy";
import type { ArmedPlan, Bar, Side, SymbolSpec, Timeframe, TradeMode } from "../types";

/** Decision cadence of the execution study. */
export const EXECUTION_STRIDE = 5;

/** Warmup bars needed before the first decision (ATR + regime context). */
export const EXECUTION_WARMUP = 150;

/** Refusal share above which the timing gate is an exit rather than a filter. */
export const EXECUTION_TIMING_REFUSAL_MAX = 0.5;

/** The entry-style comparison must not lose more than this, in legacy R. */
export const EXECUTION_PAIRED_TOLERANCE_R = 0.05;

/** A resting entry that fills on fewer than this share is not an entry at all. */
export const EXECUTION_MIN_FILL_RATE = 0.5;

export interface GateRow {
  code: string;
  label: string;
  pass: boolean;
  value: number | null;
  threshold: number | null;
  detail: string;
}

export interface ExecutionSeriesAssessment {
  fixture: string;
  series: string;
  mode: TradeMode;
  decisions: number;
  legacy: { filled: number; meanR: number; hitRate: number; unfilled: number };
  /**
   * Every legacy fill's realised R, in decision order.
   *
   * Carried so the portfolio study can walk an equity path with the SAME
   * instrument that produced the trades, and stripped before the report is
   * written (it is an input to another measurement, not a result).
   */
  legacyR: number[];
  resting: {
    filled: number;
    meanR: number;
    hitRate: number;
    unfilled: number;
    fillRate: number;
    /** How long the resting order waited, in bars (null when nothing filled). */
    medianBarsToFill: number | null;
    /** Share of resting fills that happened on the first bar after the decision. */
    filledOnFirstBarShare: number;
  };
  /** The resting plan re-expressed in the legacy plan's risk unit, per fill. */
  paired: { bothFilled: number; meanDeltaR: number; betterShare: number };
  timing: {
    buckets: number;
    /**
     * "measured" only when at least one minute-of-week bucket has the ledger's
     * own minimum sample count. On a corpus this short the answer is
     * "insufficient": the permit rule then refuses nothing because it has
     * nothing to go on — which is the shipped behaviour and is reported as
     * such rather than dressed up as evidence.
     */
    evidence: "measured" | "insufficient";
    /** The ledger's own minimum samples per bucket, reported for context. */
    requiredBucketSamples: number;
    /** Buckets the ledger has at least TIMING_MIN_BUCKET_SAMPLES outcomes for. */
    measuredBuckets: number;
    refused: number;
    refusalRate: number;
    bestBucket: number | null;
    bestMeanR: number | null;
    worstBucket: number | null;
    worstMeanR: number | null;
  };
  gates: GateRow[];
}

function planFor(input: {
  mode: TradeMode;
  symbol: string;
  spec: SymbolSpec;
  side: Side;
  decisionBar: Bar;
  atr: number;
  riskPrice: number;
  trigger: number;
  triggerType: ArmedPlan["triggerType"];
  rr: number;
  horizonBars: number;
  frame: Timeframe;
}): ArmedPlan {
  const { mode, spec, side, riskPrice, trigger, rr } = input;
  const direction = side === "buy" ? 1 : -1;
  const sl = (input.decisionBar[CLOSE] as number) - direction * riskPrice;
  const fill = trigger;
  const tp = fill + direction * riskPrice * rr;
  const riskPoints = spec.point > 0 ? riskPrice / spec.point : 0;
  const lots = 0.1;
  return {
    id: `${input.symbol}-${input.triggerType}`,
    symbol: input.symbol,
    side,
    mode,
    trigger,
    triggerType: input.triggerType,
    confirmTicks: 1,
    // The live desk invalidates a plan 0.6 ATR beyond the decision price
    // (agent.ts). The study uses the same structural level so the resting
    // limit's fill and the plan's death are decided by the same rule the desk
    // ships: a pullback deeper than the invalidation kills the plan instead of
    // filling it, which is exactly what a limit order can NOT protect itself
    // from and therefore has to be measured, not assumed.
    invalidate: (input.decisionBar[CLOSE] as number) - direction * 0.6 * input.atr,
    sl,
    tp: [tp],
    lots,
    riskMoney: riskPrice,
    riskPoints,
    maxSpreadPoints: Math.max(1, riskPoints * 0.2),
    maxSlippagePoints: Math.max(1, riskPoints * 0.1),
    expiresAt: Number.MAX_SAFE_INTEGER,
    createdAt: input.decisionBar[0] as number,
    management: buildManagementPlan({
      spec,
      mode,
      lots,
      regimeKind: "trend_up",
      atrPoints: spec.point > 0 ? input.atr / spec.point : 0,
      retraceProbability: 0.2,
    }),
    rationale: {
      confluenceScore: 0,
      grade: "B",
      regime: "study",
      winProbability: 0.5,
      expectancyR: 0,
      rewardRisk: rr,
      markovPersistence: 0,
      factors: [],
      warnings: [],
    },
    entryTimeframe: input.frame,
  };
}

/**
 * Simulate the legacy trigger and the resting limit on the same geometry.
 *
 * Both plans share the decision bar, the stop LEVEL, the target rule and the
 * management policy; only the trigger differs. Each trade is measured in its own
 * R (the desk's convention), and the resting plan is additionally re-expressed
 * in the legacy plan's R so the two are comparable in one unit.
 */
export function assessExecutionSeries(input: {
  bars: Bar[];
  spec: SymbolSpec;
  mode: TradeMode;
  symbol: string;
  fixture: string;
  series: string;
  /** The frame the bars are on — the plan's management policy measures ATR on it. */
  frame: Timeframe;
  stride?: number;
  seed?: number;
  horizonBars?: number;
}): ExecutionSeriesAssessment {
  const { bars, spec, mode, symbol, frame } = input;
  const stride = Math.max(1, input.stride ?? EXECUTION_STRIDE);
  const horizonBars = input.horizonBars ?? MODE_HORIZON_BARS[mode];
  const atr = atrSeries(bars);
  const offsetAtr = mode === "scalp" ? 0.08 : 0.12;
  const rr = 2;
  const clean: number[] = [];
  for (let i = EXECUTION_WARMUP; i < bars.length - horizonBars - 8; i += stride) {
    const a = atr[i];
    if (a !== undefined && a > 0) clean.push(i);
  }

  let legacyFilled = 0;
  let legacyUnfilled = 0;
  let legacySum = 0;
  let legacyHits = 0;
  let restingFilled = 0;
  let restingUnfilled = 0;
  let restingSum = 0;
  let restingHits = 0;
  let both = 0;
  let pairedSum = 0;
  let better = 0;
  let restingFirstBar = 0;
  const restingWaitBars: number[] = [];
  const legacyR: number[] = [];
  const timingLedger = createTimingLedger();
  const decisions: number[] = [];

  clean.forEach((index, order) => {
    const bar = bars[index] as Bar;
    const close = bar[CLOSE] as number;
    const a = atr[index] as number;
    const riskPrice = STOP_ATR_MULT[mode] * a;
    if (!(riskPrice > 0)) return;
    // Deterministic alternation: the entry-style question is direction-symmetric.
    const side: Side = order % 2 === 0 ? "buy" : "sell";
    const direction = side === "buy" ? 1 : -1;
    const legacyTrigger = close + direction * offsetAtr * a;
    const restingTrigger = close - direction * offsetAtr * a;
    const options = { spec, slippagePrice: spec.point };
    const legacyPlan = planFor({ mode, symbol, spec, side, decisionBar: bar, atr: a, riskPrice, trigger: legacyTrigger, triggerType: "break", rr, horizonBars, frame });
    const restingPlan = planFor({ mode, symbol, spec, side, decisionBar: bar, atr: a, riskPrice, trigger: restingTrigger, triggerType: "limit", rr, horizonBars, frame });
    const legacy = simulatePlan({
      plan: legacyPlan,
      bars,
      decisionIndex: index,
      spec,
      options: { ...options, entryStyle: "break" },
      atrSeries: atr as number[],
      horizonBars,
    });
    const resting = simulatePlan({
      plan: restingPlan,
      bars,
      decisionIndex: index,
      spec,
      options: { ...options, entryStyle: "limit" },
      atrSeries: atr as number[],
      horizonBars,
    });

    decisions.push(index);
    if (legacy.trade) {
      legacyFilled++;
      legacySum += legacy.trade.r;
      legacyR.push(legacy.trade.r);
      if (legacy.trade.r > 0) legacyHits++;
      recordTimingOutcome(timingLedger, { timestampMs: bar[0] as number, rMultiple: legacy.trade.r });
    } else legacyUnfilled++;
    if (resting.trade) {
      restingFilled++;
      restingSum += resting.trade.r;
      if (resting.trade.r > 0) restingHits++;
      const wait = (resting.trade.entryIndex ?? index) - index;
      restingWaitBars.push(wait);
      if (wait <= 1) restingFirstBar++;
    } else restingUnfilled++;

    if (legacy.trade && resting.trade) {
      both++;
      const legacyRisk = Math.abs(legacy.trade.entryPrice - legacyPlan.sl);
      const restingRisk = Math.abs(resting.trade.entryPrice - restingPlan.sl);
      const delta = legacyRisk > 0 ? resting.trade.r * (restingRisk / legacyRisk) - legacy.trade.r : 0;
      pairedSum += delta;
      if (delta > 0) better++;
    } else if (legacy.trade) {
      // The resting plan did not fill; its outcome is 0R (no trade, no cost) and
      // it is excluded from the paired mean so the comparison is like-for-like.
    }
  });

  // The timing gate's premise, on the legacy trades only (the entry style is
  // orthogonal to the moment).
  let refused = 0;
  let worstBucket: number | null = null;
  let worstMeanR: number | null = null;
  let bestBucket: number | null = null;
  let bestMeanR: number | null = null;
  for (const index of decisions) {
    const permit = timingPermit({ ledger: timingLedger, timestampMs: (bars[index] as Bar)[0] as number });
    if (!permit.permit) refused++;
    if (permit.measured) {
      if (worstMeanR === null || permit.meanR < worstMeanR) {
        worstMeanR = permit.meanR;
        worstBucket = permit.bucket;
      }
      if (bestMeanR === null || permit.meanR > bestMeanR) {
        bestMeanR = permit.meanR;
        bestBucket = permit.bucket;
      }
    }
  }
  const measuredBuckets = Array.from(timingLedger.buckets.values()).filter(
    (bucket) => bucket.wins + bucket.losses >= TIMING_MIN_BUCKET_SAMPLES,
  ).length;

  const fillRate = decisions.length > 0 ? restingFilled / decisions.length : 0;
  restingWaitBars.sort((a, b) => a - b);
  const medianBarsToFill =
    restingWaitBars.length > 0 ? (restingWaitBars[Math.floor((restingWaitBars.length - 1) / 2)] as number) : null;
  const meanDelta = both > 0 ? pairedSum / both : 0;
  const refusalRate = decisions.length > 0 ? refused / decisions.length : 0;
  const gates: GateRow[] = [
    {
      code: "W7_FILL_RATE",
      label: "the resting entry actually gets filled",
      pass: fillRate >= EXECUTION_MIN_FILL_RATE,
      value: fillRate,
      threshold: EXECUTION_MIN_FILL_RATE,
      detail: `${(fillRate * 100).toFixed(1)}% of ${decisions.length} decisions filled at the resting level (floor ${(EXECUTION_MIN_FILL_RATE * 100).toFixed(0)}%)`,
    },
    {
      code: "W7_PAIRED_EDGE",
      label: "resting the limit does not cost the trade its edge",
      pass: meanDelta >= -EXECUTION_PAIRED_TOLERANCE_R,
      value: meanDelta,
      threshold: -EXECUTION_PAIRED_TOLERANCE_R,
      detail: `paired mean ΔR (resting − legacy, both fills, legacy risk unit) ${meanDelta.toFixed(4)}R over ${both} pairs, tolerance −${EXECUTION_PAIRED_TOLERANCE_R}R`,
    },
    {
      code: "W7_TIMING_FILTER",
      label: "the timing gate is a filter, not an exit",
      pass: refusalRate <= EXECUTION_TIMING_REFUSAL_MAX,
      value: refusalRate,
      threshold: EXECUTION_TIMING_REFUSAL_MAX,
      detail: `the permit rule refuses ${(refusalRate * 100).toFixed(1)}% of decision bars on this corpus (ceiling ${(EXECUTION_TIMING_REFUSAL_MAX * 100).toFixed(0)}%); ${measuredBuckets} of ${timingLedger.buckets.size} minute-of-week buckets reach the ledger's own ${TIMING_MIN_BUCKET_SAMPLES}-sample minimum, so the evidence is ${measuredBuckets > 0 ? "measured" : "INSUFFICIENT — nothing to refuse on"}; measured bucket means range ${worstMeanR === null ? "n/a" : worstMeanR.toFixed(3)}R…${bestMeanR === null ? "n/a" : bestMeanR.toFixed(3)}R`,
    },
  ];

  return {
    fixture: input.fixture,
    series: input.series,
    mode,
    decisions: decisions.length,
    legacy: {
      filled: legacyFilled,
      unfilled: legacyUnfilled,
      meanR: legacyFilled > 0 ? legacySum / legacyFilled : 0,
      hitRate: legacyFilled > 0 ? legacyHits / legacyFilled : 0,
    },
    legacyR,
    resting: {
      filled: restingFilled,
      unfilled: restingUnfilled,
      fillRate,
      meanR: restingFilled > 0 ? restingSum / restingFilled : 0,
      hitRate: restingFilled > 0 ? restingHits / restingFilled : 0,
      medianBarsToFill,
      filledOnFirstBarShare: restingFilled > 0 ? restingFirstBar / restingFilled : 0,
    },
    paired: { bothFilled: both, meanDeltaR: meanDelta, betterShare: both > 0 ? better / both : 0 },
    timing: {
      buckets: timingLedger.buckets.size,
      evidence: measuredBuckets > 0 ? "measured" : "insufficient",
      requiredBucketSamples: TIMING_MIN_BUCKET_SAMPLES,
      measuredBuckets,
      refused,
      refusalRate,
      bestBucket,
      bestMeanR,
      worstBucket,
      worstMeanR,
    },
    gates,
  };
}

/** Helpers the report renderer and the CLI share. */
export function executionGatesPass(gates: GateRow[]): boolean {
  return gates.every((gate) => gate.pass);
}

export function summariseExecution(assessments: ExecutionSeriesAssessment[]): {
  decisions: number;
  legacyMeanR: number;
  restingMeanR: number;
  restingFillRate: number;
  pairedMeanDeltaR: number;
  betterShare: number;
  timingRefusalRate: number;
  gates: GateRow[];
} {
  const decisions = assessments.reduce((a, s) => a + s.decisions, 0);
  const legacyFills = assessments.reduce((a, s) => a + s.legacy.filled, 0);
  const restingFills = assessments.reduce((a, s) => a + s.resting.filled, 0);
  const pairs = assessments.reduce((a, s) => a + s.paired.bothFilled, 0);
  const legacyMeanR =
    legacyFills > 0 ? assessments.reduce((a, s) => a + s.legacy.meanR * s.legacy.filled, 0) / legacyFills : 0;
  const restingMeanR =
    restingFills > 0 ? assessments.reduce((a, s) => a + s.resting.meanR * s.resting.filled, 0) / restingFills : 0;
  const fillRate = decisions > 0 ? restingFills / decisions : 0;
  const delta =
    pairs > 0 ? assessments.reduce((a, s) => a + s.paired.meanDeltaR * s.paired.bothFilled, 0) / pairs : 0;
  const betterShare =
    pairs > 0
      ? assessments.reduce((a, s) => a + s.paired.betterShare * s.paired.bothFilled, 0) / pairs
      : 0;
  const refusals = assessments.reduce((a, s) => a + s.timing.refused, 0);
  const refusalRate = decisions > 0 ? refusals / decisions : 0;
  return {
    decisions,
    legacyMeanR,
    restingMeanR,
    restingFillRate: fillRate,
    pairedMeanDeltaR: delta,
    betterShare,
    timingRefusalRate: refusalRate,
    gates: [
      {
        code: "W7_FILL_RATE",
        label: "the resting entry actually gets filled",
        pass: fillRate >= EXECUTION_MIN_FILL_RATE,
        value: fillRate,
        threshold: EXECUTION_MIN_FILL_RATE,
        detail: `${(fillRate * 100).toFixed(1)}% of ${decisions} pooled decisions filled at the resting level`,
      },
      {
        code: "W7_PAIRED_EDGE",
        label: "resting the limit does not cost the trade its edge",
        pass: delta >= -EXECUTION_PAIRED_TOLERANCE_R,
        value: delta,
        threshold: -EXECUTION_PAIRED_TOLERANCE_R,
        detail: `pooled paired mean ΔR ${delta.toFixed(4)}R over ${pairs} pairs (better in ${(betterShare * 100).toFixed(1)}%)`,
      },
      {
        code: "W7_TIMING_FILTER",
        label: "the timing gate is a filter, not an exit",
        pass: refusalRate <= EXECUTION_TIMING_REFUSAL_MAX,
        value: refusalRate,
        threshold: EXECUTION_TIMING_REFUSAL_MAX,
        detail: `the permit rule refuses ${(refusalRate * 100).toFixed(1)}% of pooled decision bars`,
      },
    ],
  };
}

/** The slippage allowance constants the study reports for context. */
export const EXECUTION_ALLOWANCE_CEILING_MULT = SLIPPAGE_MEASUREMENT_CEILING_MULT;
