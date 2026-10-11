/**
 * WP5 — the meta dataset: every desk evaluation becomes a labelled, weighted
 * event.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * The desk already ran the alpha agents over history (WP4) and attached a regime
 * reading to every decision bar (WP3). That produced a stream of "views". What
 * it did NOT produce was anything a model could learn from, because a view is not
 * an outcome: the agents state a probability, and nothing ever recorded whether
 * the trade implied by that view would have hit its target, been stopped, or run
 * out of time.
 *
 * This turns each view into a supervised event:
 *
 *   features (measured on CAUSAL context at the decision bar)
 *       ↓
 *   triple-barrier label — +1 the profit barrier first, −1 the stop first,
 *                          0 the horizon expired (labels.ts)
 *       ↓
 *   uniqueness weight — overlapping events are down-weighted (uniqueness.ts)
 *       ↓
 *   `emitted` flag — whether the REFERENCE policy would have acted
 *
 * The last point is the one that decides whether the WP5 numbers mean anything.
 * If the corpus contained only the events the desk chose to act on, the label
 * distribution would be conditioned on the very decision rule being evaluated,
 * and a model trained on it would learn that rule's bias and then hand it back as
 * edge. So the dataset is always built over the FULL evaluation stream; the
 * reference policy only marks rows, it never deletes them. The study then
 * measures the reference policy and the fitted policy on the same purged folds,
 * so the comparison is between two policies on one corpus rather than between
 * two corpora.
 *
 * ── COST IS CHARGED EXACTLY ONCE ────────────────────────────────────────────
 *
 * The label is the barrier outcome; the round-trip cost is subtracted from the
 * realised R inside `tripleBarrier`, and the same cost (as a fraction of R)
 * travels with the row as `costR` for the gatekeeper's EV arithmetic. No other
 * layer re-charges it, and the study reports gross and net numbers side by side
 * so the difference is visible instead of asserted.
 */
import { STOP_ATR_MULT, MIN_COST_COVERAGE } from "../desk-constants";
import { slippageAllowancePoints } from "../asset-costs";
import { CLOSE } from "../math";
import type { RegimeKind } from "../regime";
import type { AssetClass, Bar, TradeMode } from "../types";
import { tripleBarrier } from "./labels";
import { spanOf, eventWeights, type EventSpan } from "./uniqueness";

export const META_FEATURE_NAMES = [
  "netDirection",
  "meanAgentProbability",
  "emitCount",
  "pTrend",
  "pMeanReversion",
  "pSweep",
  "pVolRegime",
  "pSeasonality",
  "regimeTrending",
  "regimeRange",
  "regimeDuration",
  "hourOfDay",
  "dayOfWeek",
  /** Cyclic clock terms: a linear hour cannot express a round-the-clock pattern. */
  "hourSin",
  "hourCos",
  "atrRatio",
  "spreadRatio",
  "emitCountTrending",
  "changeRisk",
] as const;

export type MetaFeatureName = (typeof META_FEATURE_NAMES)[number];

/**
 * One desk evaluation.
 *
 * Note the ABSENCE of an HMM state index. The WP3 states are unlabelled — the
 * fit is free to permute them between runs, and a model that learns "state 0 is
 * good" learns a label that may point at a different market next week. Features
 * therefore carry the *interpreted* regime reading the desk actually acts on:
 * whether the state is the trending one, whether a change point is likely, and
 * how long the state has held.
 */
export interface MetaView {
  /** Decision bar index. */
  index: number;
  direction: 1 | -1;
  /** The desk's arm probability for this view. */
  probability: number;
  /** Shipped agent keys that emitted. */
  agents: string[];
  /** Per-agent stated probabilities, keyed by shipped agent key. */
  agentProbabilities: Record<string, number>;
  /** True when the reference policy would have acted. */
  emitted: boolean;
  mode: TradeMode;
  /**
   * The desk's own regime reading at the decision bar (`assessRegime`). A KIND,
   * not an HMM state index: the WP3 states are unlabelled and the fit may permute
   * them, so a feature named "state 0" could point at a different market next
   * week. The kind is what the desk actually acts on.
   */
  regimeKind: RegimeKind | null;
  /** Consecutive decision bars the same regime kind has held. */
  regimeStreakBars: number;
  /**
   * WP3 P(change point at this bar), when the caller has it. `null` means "not
   * measured", which the feature encodes as an explicit 0.5 rather than a zero —
   * a missing measurement must never look like a confident "no change".
   */
  changeProbability: number | null;
  /** Reward:risk of the profit barrier for this view's mode. */
  targetMultipleR: number;
  horizonBars: number;
}

export interface MetaDataset {
  featureNames: MetaFeatureName[];
  x: number[][];
  /** Triple-barrier label per row: +1 / −1 / 0. */
  y: number[];
  /** Uniqueness weights, normalised so their total is the effective count. */
  weights: number[];
  spans: EventSpan[];
  /** Decision-bar index per row. */
  index: number[];
  emitted: boolean[];
  mode: TradeMode[];
  direction: (1 | -1)[];
  /** Realised R at the label's resolution, net of the round-trip cost. */
  rMultiple: number[];
  /** Round-trip cost expressed in R for this row. */
  costR: number[];
  /**
   * The risk unit in PRICE units at the decision bar — the desk's own
   * `riskPriceAt` (structural stop, widened by the cost-coverage floor).
   *
   * Carried because a cost in R is not enough to judge the WP6 cost/sigma_h
   * ratio: that comparison is between two PRICE distances, and re-deriving the
   * stop inside a study is how a study ends up measuring a geometry the desk
   * never trades.
   */
  riskPrice: number[];
  targetMultipleR: number[];
  horizonBars: number[];
  /** Views offered, before label filters. */
  offered: number;
  /** Rows with a usable label. */
  labelled: number;
  /** Rows the reference policy would have emitted. */
  emittedCount: number;
  /**
   * Independent observations the corpus carries: the sum of the uniqueness
   * weights, NOT the row count and NOT the Kish size of the weights (see
   * `uniqueness.ts` for why Kish is the wrong statistic here). This is the
   * number the confidence bound is built from.
   */
  independentObservations: number;
  /** Kish size of the weights — how concentrated the corpus is in a few events. */
  kishEffectiveSampleSize: number;
  /** Views dropped because ATR was unusable at the decision bar. */
  missingAtr: number;
  /** Views dropped because their horizon had not finished (never labelled forward). */
  unfinished: number;
}

export interface BuildMetaDatasetInput {
  views: MetaView[];
  bars: Bar[];
  mode: TradeMode;
  /** Causal ATR from research/executed-policy.ts (masked at each index). */
  atr: (number | null)[];
  /** Causal trailing mean of finished bar ranges, for the ATR ratio feature. */
  rangeMean: (number | null)[];
  /**
   * How the clock enters the features. `cyclic` adds sin/cos hour terms beside
   * the linear hour; the study measures both and keeps the one that is
   * measurably better calibrated out of sample.
   */
  hourEncoding?: "linear" | "cyclic";
  spec: { point: number; spreadPoints: number; commissionPerLot: number; assetClass: AssetClass };
  /** Point value per lot, for converting commission into points. */
  pointValuePerLot: number;
}

/**
 * The part of the build input the cost model reads.
 *
 * Narrowed deliberately: the WP6 study has to price the SAME round trip and the
 * SAME risk unit the corpus was labelled and trained under, and it has a spec but
 * no dataset to point at. Two cost models that agree "by construction" in code
 * are the only kind that cannot drift.
 */
export interface MetaCostInput {
  spec: { point: number; spreadPoints: number; commissionPerLot: number; assetClass: AssetClass };
  pointValuePerLot: number;
}

/**
 * Round-trip cost in price units for one decision bar.
 *
 * Exported because the study and the gatekeeper must agree to the last decimal:
 * a cost that differs between the number the model was trained under and the
 * number the gate applies is a silent change of the trade's economics.
 */
export function roundTripCostPrice(input: MetaCostInput, mode: TradeMode): number {
  const slippage = slippageAllowancePoints(input.spec, mode);
  const commissionPoints =
    input.pointValuePerLot > 0 ? input.spec.commissionPerLot / input.pointValuePerLot : 0;
  return (input.spec.spreadPoints + commissionPoints + slippage) * input.spec.point;
}

/**
 * The risk unit the dataset labels against: the desk's own stop distance for the
 * mode, floored at the cost coverage the desk already enforces at plan time
 * (`MIN_COST_COVERAGE`). Labelling against a *different* risk unit than the desk
 * trades would make the model's target barrier unreachable in practice — the
 * classic way to train a beautiful model that can never be executed.
 */
export function riskPriceAt(input: MetaCostInput, mode: TradeMode, atr: number): number {
  const cost = roundTripCostPrice(input, mode);
  return Math.max(atr * (STOP_ATR_MULT[mode] ?? 1), cost * MIN_COST_COVERAGE);
}

export function buildMetaDataset(input: BuildMetaDatasetInput): MetaDataset {
  const { views, bars, atr, rangeMean, mode } = input;
  const n = bars.length;
  const costPrice = roundTripCostPrice(input, mode);
  const rows: {
    x: number[];
    y: number;
    span: EventSpan;
    index: number;
    emitted: boolean;
    direction: 1 | -1;
    rMultiple: number;
    costR: number;
    riskPrice: number;
    targetMultipleR: number;
    horizonBars: number;
    mode: TradeMode;
  }[] = [];
  let missingAtr = 0;
  let unfinished = 0;

  for (const view of views) {
    const i = view.index;
    if (i < 1 || i >= n) continue;
    const atrValue = atr[i] ?? null;
    const bar = bars[i] as Bar;
    const entry = bar[CLOSE] as number;
    if (atrValue === null || !(atrValue > 0) || !Number.isFinite(entry)) {
      missingAtr++;
      continue;
    }
    const riskPrice = riskPriceAt(input, mode, atrValue);
    const resolved = tripleBarrier({
      bars,
      index: i,
      side: view.direction === 1 ? "buy" : "sell",
      entry,
      riskPrice,
      rr: view.targetMultipleR,
      horizonBars: view.horizonBars,
      costPrice,
    });
    if (resolved === null) {
      unfinished++; // the future is not knowable yet: never label it
      continue;
    }
    rows.push({
      x: featuresOf(
        view,
        {
          atrValue,
          rangeMean: rangeMean[i] ?? null,
          spreadPrice: input.spec.spreadPoints * input.spec.point,
          bar,
        },
        input.hourEncoding ?? "cyclic",
      ),
      y: resolved.label,
      span: spanOf(bar, i, resolved.t1 - i),
      index: i,
      emitted: view.emitted,
      direction: view.direction,
      rMultiple: resolved.rMultiple,
      costR: costPrice / riskPrice,
      riskPrice,
      targetMultipleR: view.targetMultipleR,
      horizonBars: view.horizonBars,
      mode: view.mode,
    });
  }

  const spans = rows.map((r) => r.span);
  const weighted = eventWeights(spans);

  return {
    featureNames: [...META_FEATURE_NAMES],
    x: rows.map((r) => r.x),
    y: rows.map((r) => r.y),
    weights: weighted.items.map((item) => item.weight),
    spans,
    index: rows.map((r) => r.index),
    emitted: rows.map((r) => r.emitted),
    mode: rows.map((r) => r.mode),
    direction: rows.map((r) => r.direction),
    rMultiple: rows.map((r) => r.rMultiple),
    costR: rows.map((r) => r.costR),
    riskPrice: rows.map((r) => r.riskPrice),
    targetMultipleR: rows.map((r) => r.targetMultipleR),
    horizonBars: rows.map((r) => r.horizonBars),
    offered: views.length,
    labelled: rows.length,
    emittedCount: rows.reduce((a, r) => a + (r.emitted ? 1 : 0), 0),
    independentObservations: weighted.independentObservations,
    kishEffectiveSampleSize: weighted.kishEffectiveSampleSize,
    missingAtr,
    unfinished,
  };
}

/**
 * The feature vector for one view, in `META_FEATURE_NAMES` order.
 *
 * Exported because the LIVE model must build its inputs the same way the study
 * did: a model fitted on these numbers and spent on a differently-computed set is
 * the classic silent train/serve skew. `meta/model.ts` is the only other caller.
 */
export function featuresOf(
  view: MetaView,
  ctx: { atrValue: number; rangeMean: number | null; spreadPrice: number; bar: Bar },
  hourEncoding: "linear" | "cyclic",
): number[] {
  const probs = view.agentProbabilities;
  const p = (key: string): number => {
    const value = probs[key];
    return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 0.5;
  };
  const emitting = view.agents.filter((key) => key in probs);
  const meanAgentProbability =
    emitting.length > 0
      ? emitting.reduce((a, key) => a + p(key), 0) / emitting.length
      : clamp01(view.probability);
  const emitCount = Math.min(8, emitting.length);
  const changeRisk = view.changeProbability ?? 0.5;
  const kind = view.regimeKind;
  const trending =
    (kind === "trend_up" && view.direction === 1) || (kind === "trend_down" && view.direction === -1)
      ? 1
      : 0;
  const range = kind === "range" ? 1 : 0;
  const rangeMean = ctx.rangeMean ?? null;
  const atrRatio = rangeMean !== null && rangeMean > 0 ? ctx.atrValue / rangeMean : 1;
  const spreadRatio = ctx.atrValue > 0 ? ctx.spreadPrice / ctx.atrValue : 0;
  return [
    view.direction,
    meanAgentProbability,
    emitCount,
    p("trend"),
    p("meanReversion"),
    p("sweep"),
    p("volRegime"),
    p("seasonality"),
    trending,
    range,
    Math.log1p(Math.max(0, view.regimeStreakBars)),
    hourEncoding === "linear" ? hourOfBar(ctx.bar) : 0,
    dayOfWeekOf(ctx.bar),
    hourEncoding === "cyclic" ? Math.sin((2 * Math.PI * hourOfBar(ctx.bar)) / 24) : 0,
    hourEncoding === "cyclic" ? Math.cos((2 * Math.PI * hourOfBar(ctx.bar)) / 24) : 0,
    atrRatio,
    spreadRatio,
    emitCount * trending,
    changeRisk,
  ];
}

/**
 * The outcome the model is fitted to: did the profit barrier get reached first?
 *
 * A timed-out event (label 0) is a NEGATIVE, and the gatekeeper's EV arithmetic
 * then charges it a full −1R. That is deliberately pessimistic — the true
 * outcome of a timeout is the small return at the time barrier, which the study
 * reports from `rMultiple` — and the pessimism is one-directional: it can only
 * make the desk refuse trades, never take them.
 */
export function binaryOutcomes(dataset: MetaDataset): boolean[] {
  return dataset.y.map((label) => label === 1);
}

/** Per-agent feature index, so the study and the gatekeeper share one mapping. */
export function featureIndex(name: MetaFeatureName): number {
  const index = META_FEATURE_NAMES.indexOf(name);
  if (index < 0) throw new Error(`unknown meta feature: ${name}`);
  return index;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hourOfBar(bar: Bar): number {
  const ts = bar[0] as number;
  return new Date(ts).getUTCHours();
}

function dayOfWeekOf(bar: Bar): number {
  const ts = bar[0] as number;
  return new Date(ts).getUTCDay();
}
