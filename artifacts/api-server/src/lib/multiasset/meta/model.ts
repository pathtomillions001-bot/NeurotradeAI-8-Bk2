/**
 * The fitted meta-model, as data.
 *
 * ── WHY A SNAPSHOT AND NOT A FUNCTION ───────────────────────────────────────
 *
 * A model that lives only inside a study run cannot be audited and cannot be
 * spent: there is no way to ask, six weeks later, which coefficients armed a
 * losing trade. The snapshot is the whole model — feature order, coefficients,
 * calibrator, and the corpus it was fitted on with its counts — so a decision
 * record can carry the exact model that made it. WP9 persists these; WP6 spends
 * them; the study produces them from its own cross-fitted folds.
 *
 * ── THE RULE THE SNAPSHOT EXISTS TO ENFORCE ─────────────────────────────────
 *
 * `predictMetaModel` refuses to answer when it cannot answer honestly:
 *
 *   - the view's mode/frame must be the corpus's (a model fitted on M5 intraday
 *     data says nothing about W1 swing setups);
 *   - the feature vector must be exactly as long as the coefficients;
 *   - the evidence must be non-empty. `independentObservations` is the sum of the
 *     per-event uniquenesses, NOT the row count: five thousand overlapping
 *     five-bar events are a handful of independent ones, and the confidence bound
 *     that ignores that is the bound that arms a losing trade;
 *   - the break-even rate must have been measured. It is the corpus's realised
 *     hit rate for this direction and mode, and it is the null the gatekeeper's
 *     one-sided test uses. Without it the test has no null and WP6 refuses.
 *
 * ⚠ AN ANTI-PATTERN THIS FILE DOES NOT PERMIT: reconstructing the break-even from
 * `1/(1+RR)`. That textbook figure assumes the barriers are hit with probability
 * one inside the horizon; the desk's measured random-entry rates sit between 0.10
 * and 0.34. A model that used it would clear the gate for the wrong reason.
 */
import { featuresOf, META_FEATURE_NAMES, type MetaView } from "./dataset";
import { applyCalibrator, type IsotonicMap } from "./isotonic";
import { predictLogistic, type LogisticModel } from "./logistic";
import { probabilityLowerBound } from "./pcb";
import { trailingRangeMean } from "./range";
import { causalAtrSeries } from "./atr";
import { CLOSE } from "../math";
import type { Bar, Timeframe, TradeMode } from "../types";

/** The corpus a snapshot was fitted on, in the terms the gates need. */
export interface MetaModelCohort {
  /** Human label, e.g. "intraday:synthetic:positive-control". */
  label: string;
  /** Rows in the corpus. */
  rows: number;
  /**
   * Independent observations: the SUM of the per-event uniquenesses. This is the
   * number `p_LCB` is sized from. Never the row count.
   */
  independentObservations: number;
  /**
   * The MEASURED break-even hit rate for this direction and mode — the realised
   * rate at random entry on the same corpora. The one-sided edge test's null.
   */
  breakEvenProbability: number;
  /** The corpus's own realised hit rate of the labelled events it carries. */
  realisedHitRate: number;
}

export interface MetaModelSnapshot {
  version: 1;
  mode: TradeMode;
  frame: Timeframe;
  horizonBars: number;
  targetMultipleR: number;
  /**
   * The fitted logistic model, AS FITTED — feature names, training means and
   * scales, standardised coefficients and intercept, and the fit's own
   * diagnostics. It is stored whole rather than flattened so that prediction
   * cannot drift from training: `predictLogistic` applies exactly the
   * standardisation the fit used.
   */
  model: LogisticModel;
  /** The calibrator map (step function and/or Platt), fitted out of fold. */
  calibrator: IsotonicMap;
  cohort: MetaModelCohort;
  provenance: {
    /** Where the corpus came from, e.g. "synthetic:positive-control". */
    corpus: string;
    /** The calibrator kind the study selected. */
    calibratorKind: "isotonic" | "platt" | "platt-shrunk";
    /** Outer folds the model was cross-fitted over. */
    folds: number;
    /** Out-of-fold rows the calibration was fitted on. */
    oosRows: number;
    /** Brier skill of the cross-fitted predictions, from the WP5 report. */
    brierSkill: number;
    /** Hour encoding the corpus used; must match at prediction time. */
    hourEncoding: "linear" | "cyclic";
    fittedAt: number;
  };
}

export interface MetaModelPrediction {
  /** The calibrated probability. */
  probability: number;
  /** Its Wilson lower bound at the corpus's evidence. This is what EV_LCB spends. */
  probabilityLowerBound: number;
  /** Independent observations behind the bound. */
  evidence: number;
  /** The measured break-even rate the one-sided test uses. */
  breakEvenProbability: number;
  /** The calibrated-but-raw value, for the journal: what the calibrator changed. */
  rawProbability: number;
  /** The feature vector, in `META_FEATURE_NAMES` order — the model's whole input. */
  features: number[];
}

export interface MetaPredictContext {
  /** CLOSED bars of the entry frame, oldest first. */
  bars: Bar[];
  /** Index of the decision bar (the last closed bar in the live path). */
  index: number;
  /** Round-trip cost in price units, for the spread-ratio feature. */
  spreadPrice: number;
  /** Per-bar ATR at the decision bar (causal). */
  atrValue: number;
  /** Trailing mean bar range, or null during warmup. */
  rangeMean: number | null;
}

/**
 * Predict from a snapshot, or return null when the question is not the one the
 * model was fitted to answer.
 *
 * Null is not an error state to be patched over: the gatekeeper turns it into
 * `GK_NO_MODEL` and refuses, which is the only defensible behaviour for a desk
 * that cannot price its own edge.
 */
export function predictMetaModel(
  snapshot: MetaModelSnapshot,
  view: MetaView,
  ctx: MetaPredictContext,
): MetaModelPrediction | null {
  if (view.mode !== snapshot.mode) return null;
  if (view.horizonBars !== snapshot.horizonBars) return null;
  if (snapshot.model.featureNames.length !== META_FEATURE_NAMES.length) return null;
  if (!snapshot.model.converged) return null;
  if (!(snapshot.cohort.independentObservations >= 1)) return null;
  if (!(snapshot.cohort.breakEvenProbability > 0) || !(snapshot.cohort.breakEvenProbability < 1)) return null;
  const bar = ctx.bars[ctx.index];
  if (!bar) return null;

  const features = featuresOf(
    view,
    { atrValue: ctx.atrValue, rangeMean: ctx.rangeMean, spreadPrice: ctx.spreadPrice, bar },
    snapshot.provenance.hourEncoding,
  );
  if (features.length !== snapshot.model.featureNames.length) return null;
  const raw = predictLogistic(snapshot.model, features);
  if (!Number.isFinite(raw)) return null;
  const calibrated = applyCalibrator(snapshot.calibrator, raw);
  if (!Number.isFinite(calibrated)) return null;
  return {
    probability: calibrated,
    probabilityLowerBound: probabilityLowerBound(calibrated, snapshot.cohort.independentObservations),
    evidence: snapshot.cohort.independentObservations,
    breakEvenProbability: snapshot.cohort.breakEvenProbability,
    rawProbability: raw,
    features,
  };
}

/**
 * Build the context a prediction needs, from the entry frame's closed bars.
 *
 * Both series are CAUSAL: the ATR is the desk's own `causalAtrSeries` (which
 * returns 0 during warmup rather than a value that peeks), and the range mean is
 * a trailing window that ends at the decision bar. Returns null when the bar or
 * the ATR is unusable, because a feature vector built on a missing ATR is a
 * prediction about a market that does not exist.
 */
export function metaPredictContext(input: {
  bars: Bar[];
  index: number;
  spreadPrice: number;
  rangePeriod?: number;
}): MetaPredictContext | null {
  const { bars, index } = input;
  if (index < 0 || index >= bars.length) return null;
  const atrSeries = causalAtrSeries(bars);
  const atrValue = atrSeries[index] ?? 0;
  if (!(atrValue > 0)) return null;
  const ranges = trailingRangeMean(bars, input.rangePeriod ?? 20);
  return {
    bars,
    index,
    spreadPrice: input.spreadPrice,
    atrValue,
    rangeMean: ranges[index] ?? null,
  };
}

/** The close of the decision bar — the price the model's features are read at. */
export function decisionClose(bars: Bar[], index: number): number | null {
  const bar = bars[index];
  if (!bar) return null;
  const close = bar[CLOSE] as number;
  return Number.isFinite(close) && close > 0 ? close : null;
}
