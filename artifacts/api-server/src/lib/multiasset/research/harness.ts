/**
 * Desk v4 research harness — the runner (WP2).
 *
 * This drives the SHIPPED desk (`agent.evaluate`) over a dataset and records
 * what it decided and what the EA would have made of each decision. It is the
 * only place the two halves meet, and it is deliberately thin: no re-scoring,
 * no re-gating, no "for research purposes" shortcut. If the harness and the
 * live desk disagree, it is because this file is wrong, and that is a bug worth
 * finding rather than a licence to reinterpret the agent.
 *
 * ── WHAT IS HELD CONSTANT, AND WHY (documented assumptions) ──────────────────
 *
 *   A CLEAR, AVAILABLE CALENDAR. Every evaluation is given
 *   `emptyAvailableNewsFeed(ts)` — an available calendar with no events. The
 *   baseline is a measurement of PRICE LOGIC. If the harness passed a null
 *   feed, the fail-closed news gate would refuse every entry and the report
 *   would say "the desk never trades" for a reason that has nothing to do with
 *   the desk's analysis. A periodic blackout can be switched on
 *   (`newsBlackoutEveryBars`) to measure the rule separately, and the real
 *   calendar is exercised by news.test.ts and by shadow mode on the live feed.
 *
 *   NO PORTFOLIO. One plan is replayed at a time against an empty book. The
 *   harness measures per-trade edge, which is what the WP2 gates are stated in;
 *   portfolio interaction (heat, correlation, the daily loss limit) belongs to
 *   WP8 and is measured there. Consequently `armRate` here is "how often a
 *   setup is offered", not "how often the book would have taken it".
 *
 *   FIXED ACCOUNT. A 10 000-currency account at 1:100, so sizing is
 *   deterministic and the report is comparable across datasets. Position size
 *   changes R by a constant factor only, because every P&L figure is expressed
 *   in R.
 *
 *   SCALP RUNS ON M1-DERIVED FRAMES. The desk's scalp band is S10–M3, but S10
 *   and S30 are synthesised on the server from a 500 ms quote stream, which an
 *   M1 CSV cannot reconstruct. A scalp harness run therefore evaluates M1/M2/M3
 *   and the report says so; the sub-minute frames remain the known defect D7
 *   and are untouched by this work package.
 *
 * ── DETERMINISM ──────────────────────────────────────────────────────────────
 *
 * Everything the desk does is seeded. The single exception is `plan.id`, which
 * `evaluate()` fills with a UUID so that two plans can never be confused on the
 * wire. It is not a feature and it is not reproducible, so
 * `decisionDigest()` hashes every field EXCEPT that one, and the prefix-replay
 * test compares digests. Hashing the id would fail for a reason that has
 * nothing to do with lookahead.
 */

import crypto from "node:crypto";
import { evaluate, type AgentDecision } from "../agent";
import { emptyAvailableNewsFeed } from "../news";
import { createRiskState, type RiskState } from "../risk";
import { slippageAllowancePoints } from "../asset-costs";
import { MODE_ANALYSIS_TIMEFRAMES, type AccountSnapshot, type Bar, type Timeframe, type TradeMode } from "../types";
import { computeMetrics } from "./metrics";
import { buildMarketView, seriesBundleAt, type MarketView } from "./market-view";
import { replayPlan, type SimulatorOptions } from "./simulator";
import type { Dataset, HarnessDecision, ReplayResult, RunReport } from "./types";

/** Harness version. Bumped whenever a convention above changes. */
export const HARNESS_VERSION = "wp2.1.0";

export interface HarnessOptions {
  mode: TradeMode;
  seed: number;
  /** Evaluate a decision every N M1 bars. */
  stepBars?: number;
  /** Bars skipped before the first decision, so indicators are warm. */
  warmupBars?: number;
  /** Hard cap on evaluations, to bound a run's wall-clock time. */
  maxEvaluations?: number;
  /** Configurations covered by the search, for the DSR deflation. */
  dsrTrials?: number;
  /** Slippage allowance in points; defaults to the desk's own for the symbol. */
  slippagePoints?: number;
  /** Passed through to `agent.evaluate`; defaults to the desk's own. */
  minEdgeR?: number;
  maxSpreadPointsOverride?: number;
  /** Simulated news blackouts, every N bars. 0 disables. */
  newsBlackoutEveryBars?: number;
  /** Called after each evaluation, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
}

export const DEFAULT_HARNESS_OPTIONS: Omit<HarnessOptions, "mode" | "seed"> = {
  stepBars: 15,
  warmupBars: 1_500,
  maxEvaluations: 20_000,
  dsrTrials: 1,
  newsBlackoutEveryBars: 0,
};

/** The frames each mode may look at, minus the ones an M1 export cannot build. */
export function framesForMode(mode: TradeMode): Timeframe[] {
  const band = MODE_ANALYSIS_TIMEFRAMES[mode];
  if (mode === "scalp") {
    // S10/S30 are synthetic tick frames; see the module header.
    return band.filter((timeframe) => timeframe === "M1" || timeframe === "M2" || timeframe === "M3");
  }
  return [...band];
}

const ACCOUNT: AccountSnapshot = {
  balance: 10_000,
  equity: 10_000,
  margin: 0,
  freeMargin: 10_000,
  marginLevel: Infinity,
  currency: "USD",
  leverage: 100,
  mode: "hedging",
  isLive: false,
  dayStartEquity: 10_000,
  peakEquity: 10_000,
};

function decisionToRecord(decision: AgentDecision, barIndex: number, ts: number): HarnessDecision {
  const plan = decision.plan;
  return {
    barIndex,
    ts,
    symbol: decision.symbol,
    mode: decision.mode,
    armed: decision.armed,
    predictedProbability: decision.winProbability,
    predictedExpectancyR: decision.expectancyR,
    rewardRiskAtFill: plan?.rationale.rewardRiskAtFill ?? null,
    qualityScore: decision.qualityScore,
    qualityThreshold: decision.qualityThreshold,
    rejection: decision.rejections[0] ?? null,
    costR: decision.costR,
    entryTimeframe: decision.entryTimeframe,
    plan:
      plan === null
        ? null
        : {
            id: plan.id,
            side: plan.side,
            trigger: plan.trigger,
            triggerType: plan.triggerType,
            sl: plan.sl,
            tp: plan.tp[0] ?? plan.trigger,
            lots: plan.lots,
            riskPoints: plan.riskPoints,
            expiresAt: plan.expiresAt,
            entryTimeframe: plan.entryTimeframe,
            costPoints: plan.costPoints,
            management: plan.management,
            maxSpreadPoints: plan.maxSpreadPoints,
          },
  };
}

export interface HarnessRun {
  report: RunReport;
  /** Full decisions, for tests that need more than the report's summary. */
  decisions: AgentDecision[];
  view: MarketView;
}

/**
 * Run the desk over a dataset.
 *
 * Lookahead safety is structural, not incidental: the only market data handed
 * to `evaluate()` is `seriesBundleAt(view, i, frames)`, which cannot contain a
 * bar after index `i`. The simulator, which legitimately looks forward, is the
 * only code that reads later bars, and it is only ever given an already-armed
 * plan.
 */
export function runHarness(dataset: Dataset, options: HarnessOptions): HarnessRun {
  const config = { ...DEFAULT_HARNESS_OPTIONS, ...options };
  const bars = dataset.bars;
  const frames = framesForMode(config.mode);
  const view = buildMarketView(dataset, frames);
  const step = Math.max(1, config.stepBars ?? 15);
  const warmup = Math.max(60, config.warmupBars ?? 1_500);
  const slippagePoints =
    config.slippagePoints ?? slippageAllowancePoints(dataset.spec, config.mode);

  const simulatorOptions: Partial<SimulatorOptions> = {
    slippagePoints,
    newsBlackoutEveryBars: config.newsBlackoutEveryBars ?? 0,
  };

  const decisions: AgentDecision[] = [];
  const records: HarnessDecision[] = [];
  const trades: ReplayResult[] = [];
  const notes: string[] = [];

  const riskState: RiskState = createRiskState();

  const lastIndex = bars.length - 1;
  const totalEvaluations = Math.max(
    0,
    Math.min(
      config.maxEvaluations ?? 20_000,
      Math.floor((lastIndex - warmup) / step) + 1,
    ),
  );
  let done = 0;

  for (let i = warmup; i <= lastIndex && done < totalEvaluations; i += step) {
    const bar = bars[i]!;
    const ts = bar[0]!;
    const spreadPoints = dataset.spreadPointsAt(ts);
    const bid = bar[4]!;
    const quote = {
      symbol: dataset.symbol,
      bid,
      ask: bid + spreadPoints * dataset.spec.point,
      spreadPoints,
      ts,
      ageMs: 0,
    };

    const decision = evaluate({
      symbol: dataset.symbol,
      mode: config.mode,
      spec: { ...dataset.spec, spreadPoints },
      quote,
      series: seriesBundleAt(view, i, frames),
      account: ACCOUNT,
      positions: [],
      specs: new Map([[dataset.symbol, dataset.spec]]),
      riskState,
      news: emptyAvailableNewsFeed(ts),
      now: ts,
      minEdgeR: config.minEdgeR,
    });

    decisions.push(decision);
    records.push(decisionToRecord(decision, i, ts));

    if (decision.armed && decision.plan) {
      const plan = decision.plan;
      const replay = replayPlan(
        dataset,
        {
          id: plan.id,
          symbol: plan.symbol,
          side: plan.side,
          mode: plan.mode,
          trigger: plan.trigger,
          triggerType: plan.triggerType,
          invalidate: plan.invalidate,
          sl: plan.sl,
          tp: plan.tp[0] ?? plan.trigger,
          lots: plan.lots,
          riskPoints: plan.riskPoints,
          expiresAt: plan.expiresAt,
          maxSpreadPoints: plan.maxSpreadPoints,
          entryTimeframe: plan.entryTimeframe ?? "M15",
          costPoints: plan.costPoints ?? 0,
          management: plan.management,
        },
        i,
        simulatorOptions,
        view,
      );
      trades.push(replay);
    }

    done += 1;
    config.onProgress?.(done, totalEvaluations);
  }

  if (bars.length <= warmup) {
    notes.push(
      `Dataset has ${bars.length} bars, at or below the ${warmup}-bar warm-up: nothing was evaluated.`,
    );
  }
  if (done >= (config.maxEvaluations ?? 20_000)) {
    notes.push(`Evaluation capped at ${config.maxEvaluations}; the window was not fully covered.`);
  }
  notes.push(
    `Frames evaluated: ${frames.join(", ")}.${config.mode === "scalp" ? " S10/S30 are synthetic tick frames and are not available from an M1 export (defect D7, untouched)." : ""}`,
  );

  const metrics = computeMetrics({
    decisions: records,
    trades,
    dsrTrials: Math.max(1, config.dsrTrials ?? 1),
  });

  const evaluatedBars = records.length > 0 ? bars[records[0]!.barIndex]! : bars[warmup] ?? bars[0]!;
  const report: RunReport = {
    generatedAt: new Date().toISOString(),
    harness: HARNESS_VERSION,
    dataset: dataset.source,
    symbol: dataset.symbol,
    mode: config.mode,
    seed: config.seed,
    bars: bars.length,
    evaluatedFrom: evaluatedBars?.[0] ?? 0,
    evaluatedTo: records.length > 0 ? records[records.length - 1]!.ts : evaluatedBars?.[0] ?? 0,
    metrics,
    trades,
    decisions: records.map((record) => ({ ...record })),
    notes: [
      ...(dataset.notes ?? []),
      ...notes,
      "Calendar: clear and available for every evaluation (price-logic baseline).",
      "Book: empty — per-trade edge, no portfolio interaction (WP8 measures that).",
    ],
  };

  return { report, decisions, view };
}

/**
 * A stable hash of everything a decision MEANS, excluding its plan id.
 *
 * Used by the prefix-replay test: taking the same dataset and truncating it
 * must not change any decision that was made before the truncation point. The
 * UUID is excluded because it is deliberately unique per call, not because it
 * could leak the future.
 */
export function decisionDigest(decision: AgentDecision): string {
  const plan = decision.plan;
  const canonical = {
    symbol: decision.symbol,
    mode: decision.mode,
    armed: decision.armed,
    qualityScore: round(decision.qualityScore),
    qualityThreshold: decision.qualityThreshold,
    expectancyR: decision.expectancyR,
    winProbability: decision.winProbability,
    entryTimeframe: decision.entryTimeframe,
    horizonMinutes: decision.horizonMinutes,
    costR: decision.costR,
    stopWidened: decision.stopWidened,
    rejections: decision.rejections,
    warnings: decision.warnings,
    plan:
      plan === null
        ? null
        : {
            symbol: plan.symbol,
            side: plan.side,
            mode: plan.mode,
            trigger: round(plan.trigger),
            triggerType: plan.triggerType,
            invalidate: round(plan.invalidate),
            sl: round(plan.sl),
            tp: plan.tp.map(round),
            lots: plan.lots,
            riskPoints: round(plan.riskPoints),
            maxSpreadPoints: plan.maxSpreadPoints,
            // The TTL is relative to `now`, which is the bar timestamp and is
            // therefore observable; the absolute expiry would also be stable,
            // but comparing the offset makes the intent explicit.
            ttlMs: plan.expiresAt - plan.createdAt,
            entryTimeframe: plan.entryTimeframe,
            costPoints: plan.costPoints,
            management: plan.management,
            rationale: {
              rewardRiskAtFill: plan.rationale.rewardRiskAtFill,
              rewardRisk: plan.rationale.rewardRisk,
              winProbability: plan.rationale.winProbability,
              expectancyR: plan.rationale.expectancyR,
              grade: plan.rationale.grade,
              regime: plan.rationale.regime,
            },
          },
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

/** Round to 10 significant digits, so float noise cannot fail an equality test. */
function round(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, 9 - magnitude);
  return Math.round(value * factor) / factor;
}

/**
 * PREFIX-REPLAY CHECK.
 *
 * Runs the harness over `dataset` truncated at `truncateIndex`, then compares
 * every decision the truncated run made with the corresponding decision from
 * the full run. Any difference means the desk read data it should not have
 * been able to see.
 *
 * Returns the mismatches rather than a boolean so a failure can be diagnosed
 * from the report instead of by re-running under a debugger.
 */
export function prefixReplayCheck(input: {
  dataset: Dataset;
  options: HarnessOptions;
  truncateIndex: number;
}): { ok: boolean; checked: number; mismatches: { index: number; fullDigest: string; prefixDigest: string }[] } {
  const { dataset, options, truncateIndex } = input;
  const full = runHarness(dataset, options);

  const truncated: Dataset = { ...dataset, bars: dataset.bars.slice(0, truncateIndex + 1) };
  const prefix = runHarness(truncated, options);

  const byTimestamp = new Map<number, string>();
  for (const decision of full.decisions) {
    if (decision.evaluatedAt <= truncated.bars[truncated.bars.length - 1]![0]!) {
      byTimestamp.set(decision.evaluatedAt, decisionDigest(decision));
    }
  }

  const mismatches: { index: number; fullDigest: string; prefixDigest: string }[] = [];
  let checked = 0;
  for (const decision of prefix.decisions) {
    const expected = byTimestamp.get(decision.evaluatedAt);
    if (expected === undefined) continue;
    checked += 1;
    const actual = decisionDigest(decision);
    if (actual !== expected) {
      mismatches.push({ index: decision.evaluatedAt, fullDigest: expected, prefixDigest: actual });
    }
  }
  return { ok: mismatches.length === 0, checked, mismatches };
}

/** Run the same configuration across several seeds, for the null gates. */
export function runSeeds(
  build: (seed: number) => Dataset,
  optionsFor: (seed: number) => HarnessOptions,
  seeds: number[],
): RunReport[] {
  return seeds.map((seed) => {
    const dataset = build(seed);
    return runHarness(dataset, optionsFor(seed)).report;
  });
}

/** Convenience: bars of a run's dataset that were actually evaluated. */
export function evaluatedBars(bars: Bar[], report: RunReport): Bar[] {
  return bars.filter((bar) => bar[0]! >= report.evaluatedFrom && bar[0]! <= report.evaluatedTo);
}
