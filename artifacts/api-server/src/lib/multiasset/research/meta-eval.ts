/**
 * WP5 — the meta-model study.
 *
 * ── WHAT IS BEING MEASURED HERE, AND WHAT IS NOT ────────────────────────────
 *
 * This study answers one question: **when the desk says "42%", is it right, and
 * how much margin does that claim actually have?** It is NOT the study that
 * decides whether the desk makes money — that is WP6's job, and it is a different
 * question with a different threshold. Conflating the two is how a desk ends up
 * with a gatekeeper that "passed" a calibration test and still loses.
 *
 * So the outputs are, in order of importance:
 *
 *   1. **Reliability.** Predicted against realised, on rows the model never saw,
 *      with a slope and intercept that a report can be held to (0.8–1.2 is the
 *      standard band for "well calibrated").
 *   2. **Discrimination with a price tag.** Brier skill and log loss against the
 *      constant forecast — a model that cannot beat "the base rate, always" has
 *      learned nothing that is worth a spread.
 *   3. **Coverage of p_LCB.** The bound is only useful if breaking it is rare.
 *      Any decile whose realised rate lands below its own mean lower bound is
 *      reported by name; more than a quarter of the deciles doing that fails the
 *      run, because a bound that is wrong a quarter of the time is a bound that
 *      will hand the gatekeeper a losing trade with a straight face.
 *   4. **The two policies, side by side.** The measured WP4 allowlist (the
 *      reference policy) and the fitted meta policy, armed ONLY on EV_LCB > 0,
 *      measured on the same purged folds of the same corpus.
 *   5. **The null.** On a driftless and on a block-shuffled series the fitted
 *      policy must not show a statistically positive mean R. Refusing to trade at
 *      all passes this gate — that is the correct behaviour of a model that has
 *      found nothing.
 *
 * ── THE FOLDS ARE PURGED, AND THE CORPUS IS NOT FILTERED ────────────────────
 *
 * Folds are folds over EVENTS with a purge and an embargo, because two events
 * whose label spans overlap are not independent. And the corpus is every desk
 * evaluation, not just the ones the reference policy would have taken: a corpus
 * filtered by the rule under test measures the rule, not the market (see
 * `meta/dataset.ts`).
 */
import { buildAlphaAgents, type AlphaAgent, type AlphaId } from "../alpha";
import { wilsonInterval } from "../alpha/edge";
import { pointValuePerLot } from "../sizing";
import type { RegimeKind } from "../regime";
import type { Bar, SymbolSpec, Timeframe, TradeMode } from "../types";
import { binaryOutcomes, buildMetaDataset, type MetaDataset, type MetaView } from "../meta/dataset";
import { metaViewAt } from "../meta/view";
import { trailingRangeMean } from "../meta/range";
export { trailingRangeMean };
import { combinatorialEventSplits, purgedEventFolds } from "../meta/folds";
import {
  MIN_CALIBRATION_SAMPLES,
  applyIsotonic,
  fitIsotonic,
  identityMap,
  reliability,
  type IsotonicMap,
} from "../meta/isotonic";
import { brierScore, fitLogistic, logLoss, predictLogistic } from "../meta/logistic";
import { effectiveSampleSize, expectedValueLowerBound, probabilityLowerBound } from "../meta/pcb";
import { causalAtrSeries } from "./executed-policy";
import { DEFAULT_GENERATOR_SPEC, generate, type GeneratorKind } from "./generators";

/** Rows needed before a calibration claim is even attempted. */
export const META_MIN_LABELLED = 120;
/** The standard band for a well-calibrated slope. */
export const META_SLOPE_MIN = 0.8;
export const META_SLOPE_MAX = 1.2;
/** A decile is only judged when it has this many rows. */
export const META_MIN_BUCKET_ROWS = 10;
/** How far below its own lower bound a decile's realised rate may land. */
export const META_COVERAGE_TOLERANCE = 0.05;
/** Fraction of judgeable deciles allowed to break the bound. */
export const META_COVERAGE_VIOLATION_MAX_FRACTION = 0.25;
/** Armed trades needed on a fixture before "it works" means anything. */
export const META_MIN_ARMED = 20;
/** Armed trades on a null series below this are "refused to trade", which passes. */
export const META_NULL_ARMED_FLOOR = 10;
/** One-sided confidence for the mean-R bound. */
export const META_Z = 1.645;
/** The desk's reward:risk floor at the fill — the multiple the model's EV uses. */
export const META_TARGET_MULTIPLE_R = 2;
export const META_FOLD_COUNT = 5;
export const META_EMBARGO_BARS = 5;
export const META_CPCV_GROUPS = 6;
export const META_CPCV_TEST_GROUPS = 2;
/** Inner purged folds used to cross-fit the calibrator inside a training fold. */
export const META_INNER_FOLDS = 4;
/** Out-of-fold predictions needed before an isotonic map is fitted at all. */
export const META_MIN_CALIBRATION_PAIRS = 50;
/** L2 penalty on the standardised coefficients. */
export const META_L2 = 1;

/**
 * How the raw logistic score is turned into a probability.
 *
 *   isotonic  — PAV step function on the out-of-fold scores, regularised so no
 *               step rests on fewer than `MIN_ISOTONIC_BLOCK_WEIGHT` events.
 *   platt     — a two-parameter logistic recalibration
 *               `logit(p) = a + b · logit(p_raw)`, fitted on the same
 *               out-of-fold scores by the same Newton solver the reliability
 *               gate uses.
 *
 * Both are fitted on the identical out-of-fold sample, so the WP5 study can
 * compare them on the same folds and keep the one that is measurably better
 * calibrated out of sample. A step function can fit the training period's risk
 * spread almost exactly and then hand a test period a spread it never had; a
 * two-parameter map cannot. Which of those two failure modes dominates is not a
 * matter of taste, so the study measures it (`calibrator` is recorded in the
 * artifact) instead of arguing about it.
 */
export type MetaCalibratorKind = "isotonic" | "platt" | "platt-shrunk";
/**
 * The shipped default, chosen by measurement rather than by preference.
 *
 * Measured on the WP5 study's own fixtures — identical folds, identical corpus,
 * three calibrators (`research-reports/*-wp5-meta-intraday-meta-study.json`):
 *
 *   calibrator      home slope   home Brier skill   seasonal slope
 *   isotonic             0.66          0.172              0.64
 *   platt                0.93          0.178              0.58
 *   platt-shrunk         0.40         −0.005              0.57
 *
 * `platt-shrunk` stays in the code as the measured loser rather than being
 * deleted: the internal time split turns out to be a WORSE estimate of period
 * transfer than the folds are (it over-shrinks by roughly a factor of two and
 * destroys the home fixture's skill), and a result worth being able to reproduce
 * is worth keeping the code for. The default is the one whose calibration the
 * gates can verify.
 */
export const META_CALIBRATOR_DEFAULT: MetaCalibratorKind = "platt";

/**
 * The shrinkage floor for the internally-validated calibrator.
 *
 * The measured instability factor can only ever be used to REDUCE confidence
 * (beyond 1 it is ignored), and it is floored here so that a pathological
 * internal split cannot collapse the model to a constant. The floor is a safety
 * rail, not a tuning knob: the factor itself is measured on every fold from the
 * out-of-fold sample, and it is written into the report.
 */
export const META_SHRINKAGE_FLOOR = 0.2;

export interface MetaOosRow {
  series: string;
  index: number;
  fold: number;
  /** Raw model output, before calibration. */
  pRaw: number;
  /** Calibrated probability. */
  pHat: number;
  /** The bound the gatekeeper will use. */
  pLcb: number;
  /** Profit barrier reached first. */
  hit: boolean;
  /** Realised R at the label's resolution, net of the round-trip cost. */
  rMultiple: number;
  /** The reference policy (measured WP4 allowlist) would have taken it. */
  emitted: boolean;
  /** The fitted policy arms it: EV at p_LCB is positive. */
  armed: boolean;
  targetMultipleR: number;
  weight: number;
  /**
   * The WP6 inputs, carried per row so the gatekeeper study measures the gate on
   * exactly the corpus the calibration was fitted and judged on. Nothing below
   * changes the WP5 statistics; these are the same rows, read more closely.
   */
  /** Independent observations behind this row's p_LCB — its fold's evidence. */
  evidence: number;
  /** Round trip in R. */
  costR: number;
  /** The risk unit in price units (the desk's own stop placement). */
  riskPrice: number;
  /** Bars allowed before the time stop. */
  horizonBars: number;
  /** Direction of the view this row came from: +1 long, -1 short. */
  direction: 1 | -1;
}

export interface MetaBucket {
  bucket: number;
  rows: number;
  meanPredicted: number;
  meanLowerBound: number;
  observed: number;
}

export interface MetaStats {
  rows: number;
  hitRate: number;
  hitRateLower: number;
  baseRate: number;
  brier: number;
  brierSkill: number;
  logLoss: number;
  reliability: { slope: number | null; intercept: number | null; identifiable: boolean; reason: string };
  buckets: MetaBucket[];
  violationBuckets: number[];
  judgeableBuckets: number;
  reference: { armed: number; armedRate: number; hitRate: number; meanR: number; meanRLower: number };
  fitted: { armed: number; armedRate: number; hitRate: number; meanR: number; meanRLower: number; meanLowerBound: number };
  corpus: { hitRate: number; meanR: number };
}

export interface MetaStudyMeasurement {
  series: string;
  kind: string;
  symbol: string;
  mode: TradeMode;
  frame: Timeframe;
  /** Diagnostics about how the corpus was built. */
  evaluations: number;
  views: number;
  viewRate: number;
  labelled: number;
  /** Independent observations (sum of uniquenesses) the corpus carries. */
  independentObservations: number;
  /** Kish size of the weights: how concentrated the corpus is. */
  kishEffectiveSampleSize: number;
  unfinished: number;
  missingAtr: number;
  folds: {
    fold: number;
    train: number;
    /** Out-of-fold predictions the calibrator was fitted on. */
    calibration: number;
    /** Whether a calibrator was fitted, or the identity for want of evidence. */
    calibrated: boolean;
    /** Spread that survived the internal time split (1 = no shrinkage applied). */
    shrinkage: number;
    test: number;
    purged: number;
    /** Independent observations the fold's training weights carry. */
    evidence: number;
  }[];
  cpcvPaths: number;
  cpcvPositivePaths: number;
  cpcvMeanR: { min: number; median: number; max: number };
  stats: MetaStats;
  rows: MetaOosRow[];
  elapsedMs: number;
}

export interface MetaFixture {
  name: string;
  kind: string;
  series: number;
  bars: number;
  null?: boolean;
  /**
   * Whether the calibration gates are decided on this fixture.
   *
   * The home fixture is the desk's own POSITIVE CONTROL — the same corpus the
   * WP2 baseline gates and the WP4 trend claim are measured on. Keeping one home
   * across the programme is not a convenience: it stops each work package from
   * quietly picking whichever series it happens to pass on.
   *
   * Every other fixture is measured, printed and stored, and every gate that
   * fails on one is shown and carried into the report's notes. They are evidence
   * about the model; they just do not decide this work package's verdict, and
   * where one fails the report names it.
   */
  home?: boolean;
  note: string;
}

/**
 * The fixtures the WP5 gates are decided on.
 *
 * The positive control is the point: a corpus where a real, learnable relation
 * exists (an OU series, and a clock-driven drift that shows up in `hourOfDay`)
 * so "the model beats the constant forecast" is a claim the data can support
 * rather than a claim about a coin.
 */
export const META_STUDY_FIXTURES: MetaFixture[] = [
  { name: "positive-control", kind: "positive-control", series: 3, bars: 2500, home: true,
    note: "regime-switching drift + AR(1) residual: the desk's own positive control, where the trend structure is real" },
  { name: "seasonal", kind: "seasonal", series: 3, bars: 2500,
    note: "hour-of-day drift: the fixture where the hour feature carries information (report-only; see the calibration caveat in the report notes)" },
  { name: "mean-reverting", kind: "mean-reverting", series: 3, bars: 2500,
    note: "OU around a level: the structure a meta-model should be able to rank" },
  { name: "null-driftless", kind: "driftless", series: 3, bars: 2500, null: true,
    note: "driftless random walk: nothing to learn, so the fitted policy must not claim an edge" },
  { name: "null-shuffled", kind: "block-shuffled", series: 3, bars: 2500, null: true,
    note: "block-shuffled returns: marginals kept, temporal structure destroyed" },
];

export interface MetaViewStream {
  views: MetaView[];
  evaluations: number;
  decisions: number;
}

export interface MetaSeriesInput {
  bars: Bar[];
  symptom?: string;
  mode: TradeMode;
  spec: SymbolSpec;
  symbol: string;
  frame: Timeframe;
  frameWidthMs: number;
  stride: number;
  warmupBars: number;
  targetMultipleR: number;
  horizonBars: number;
  /** Regime read over a bounded causal window. */
  regimeWindowBars?: number;
  agents?: Record<AlphaId, AlphaAgent>;
  /** Which calibrator to fit on the out-of-fold sample (default: isotonic). */
  calibrator?: MetaCalibratorKind;
}

/**
 * Walk the series once and record every decision where at least one agent had a
 * view — the corpus the meta-model learns from.
 *
 * The regime reading is the desk's own `assessRegime` over a bounded, causal
 * window (default 200 bars), and the streak is how many consecutive decision bars
 * the same reading has held. This is deliberately NOT the WP3 HMM state index:
 * HMM states are unlabelled and permutable, so a model trained on "state 0" is a
 * model trained on a label that may move next week. The interpreted reading the
 * desk acts on is the honest feature, and `changeProbability` stays available for
 * callers that have the WP3 model in hand.
 */
export function buildMetaViewStream(input: MetaSeriesInput): MetaViewStream {
  const { bars, mode, spec, symbol, frame, frameWidthMs } = input;
  const agents = input.agents ?? buildAlphaAgents();
  const stride = Math.max(1, input.stride);
  const warmup = Math.max(120, input.warmupBars);
  const regimeWindow = Math.max(60, input.regimeWindowBars ?? 200);
  const horizonBars = input.horizonBars;
  const views: MetaView[] = [];
  let evaluations = 0;
  let decisions = 0;

  const lastDecision = bars.length - horizonBars - 2;
  if (lastDecision <= warmup) return { views, evaluations, decisions };

  const cache = new Map<string, unknown>();
  let previous: { index: number; kind: RegimeKind | null; streak: number } | null = null;

  for (let i = warmup; i <= lastDecision; i += stride) {
    evaluations++;
    const built = metaViewAt({
      symbol,
      mode,
      spec,
      frame,
      bars,
      index: i,
      frameWidthMs,
      regimeWindowBars: regimeWindow,
      agents,
      cache,
      targetMultipleR: input.targetMultipleR,
      horizonBars,
      previous,
    });
    // An abstention is not a row: the corpus is the decisions where at least one
    // agent had a view. It is still a DECISION for the streak feature, so the
    // previous-state record is advanced on every step — with a null kind, which
    // is what makes the next matching reading restart at 1.
    previous = built
      ? { index: i, kind: built.kind, streak: built.streak }
      : { index: i, kind: null, streak: 0 };
    if (!built) continue;
    views.push(built.view);
    decisions++;
  }
  return { views, evaluations, decisions };
}


export function measureMeta(input: MetaSeriesInput & { series: string; kind: string }): MetaStudyMeasurement {
  const started = Date.now();
  const stream = buildMetaViewStream(input);
  const atr = causalAtrSeries(input.bars, 14);
  const rangeMean = trailingRangeMean(input.bars, 20);
  const pointValue = pointValuePerLot(input.spec);
  const dataset = buildMetaDataset({
    views: stream.views,
    bars: input.bars,
    mode: input.mode,
    atr: atr.map((value) => (value > 0 ? value : null)),
    rangeMean,
    spec: {
      point: input.spec.point,
      spreadPoints: input.spec.spreadPoints,
      commissionPerLot: input.spec.commissionPerLot,
      assetClass: input.spec.assetClass,
    },
    pointValuePerLot: pointValue,
  });

  const calibratorKind = input.calibrator ?? META_CALIBRATOR_DEFAULT;
  const rows: MetaOosRow[] = [];
  const foldSummary: MetaStudyMeasurement["folds"] = [];
  const events = dataset.index.map((index, i) => ({ index, span: dataset.spans[i] as { t0: number; t1: number } }));
  const purge = input.horizonBars;
  const folds = purgedEventFolds(events, input.bars.length, {
    folds: META_FOLD_COUNT,
    purgeBars: purge,
    embargoBars: META_EMBARGO_BARS,
  });
  for (const fold of folds) {
    const split = fitAndPredict(dataset, fold.train, fold.test, input.series, fold.fold, purge, input.bars.length, calibratorKind);
    rows.push(...split.rows);
    foldSummary.push({
      fold: fold.fold,
      train: fold.train.length,
      calibration: split.calibration,
      calibrated: split.calibrated,
      shrinkage: split.shrinkage,
      test: fold.test.length,
      purged: fold.purged.length,
      evidence: Math.round(fold.train.reduce((a, i) => a + (dataset.weights[i] as number), 0)),
    });
  }

  // CPCV over the same corpus: how the fitted policy behaves on 15 different
  // out-of-sample pairings, rather than on one lucky fold order.
  const splits = combinatorialEventSplits(events, input.bars.length, {
    groups: META_CPCV_GROUPS,
    testGroups: META_CPCV_TEST_GROUPS,
    purgeBars: purge,
    embargoBars: META_EMBARGO_BARS,
  });
  const pathMeanR: number[] = [];
  for (let path = 0; path < splits.length; path++) {
    const split = splits[path] as { train: number[]; test: number[] };
    const result = fitAndPredict(dataset, split.train, split.test, input.series, 100 + path, purge, input.bars.length, calibratorKind);
    const armed = result.rows.filter((row) => row.armed);
    if (armed.length > 0) pathMeanR.push(mean(armed.map((row) => row.rMultiple)));
  }
  pathMeanR.sort((a, b) => a - b);

  const measurement: MetaStudyMeasurement = {
    series: input.series,
    kind: input.kind,
    symbol: input.symbol,
    mode: input.mode,
    frame: input.frame,
    evaluations: stream.evaluations,
    views: stream.views.length,
    viewRate: stream.evaluations > 0 ? stream.views.length / stream.evaluations : 0,
    labelled: dataset.labelled,
    independentObservations: dataset.independentObservations,
    kishEffectiveSampleSize: dataset.kishEffectiveSampleSize,
    unfinished: dataset.unfinished,
    missingAtr: dataset.missingAtr,
    folds: foldSummary,
    cpcvPaths: splits.length,
    cpcvPositivePaths: pathMeanR.filter((value) => value > 0).length,
    cpcvMeanR: {
      min: pathMeanR[0] ?? 0,
      median: pathMeanR[Math.floor(pathMeanR.length / 2)] ?? 0,
      max: pathMeanR[pathMeanR.length - 1] ?? 0,
    },
    stats: summariseMetaRows(rows),
    rows,
    elapsedMs: Date.now() - started,
  };
  return measurement;
}

/**
 * Fit on a training fold, calibrate it honestly, predict the test fold.
 *
 * ── WHY THE CALIBRATION IS CROSS-FITTED RATHER THAN FITTED ON A SLICE ───────
 *
 * An isotonic map fitted on the same predictions the logistic model was fitted
 * on is an in-sample calibration: its reliability slope is the slope of a curve
 * drawn through the points it is scored on, and it will look excellent on a
 * model that has learned nothing.
 *
 * Slicing the training fold into "fit half" and "calibrate half" avoids that but
 * pays for it twice: the logistic sees half the rows, and the map is fitted on a
 * sample small enough (tens of events, effective size in the teens) that its
 * steps are noise. That is exactly the case the brief's floor exists for —
 * `MIN_CALIBRATION_SAMPLES = 200`, below which a step function is not constrained
 * by anything.
 *
 * So the training fold is cross-fitted instead: k inner purged folds produce
 * OUT-OF-FOLD predictions for every training row, and the isotonic map is fitted
 * once on all of them. Every row used to fit the map was scored by a model that
 * had not seen it; the map is fitted on the whole fold rather than a slice; and
 * when the fold's effective size is still below the floor the map is the IDENTITY
 * and the report says so, because "we could not calibrate this" is a fact the
 * gatekeeper needs, not a detail to hide.
 */
function fitAndPredict(
  dataset: MetaDataset,
  trainIdx: number[],
  testIdx: number[],
  series: string,
  fold: number,
  purge: number,
  totalBars: number,
  calibratorKind: MetaCalibratorKind,
): { rows: MetaOosRow[]; calibration: number; calibrated: boolean; shrinkage: number } {
  const y = binaryOutcomes(dataset);
  const featureNames = dataset.featureNames;
  const empty = { rows: [], calibration: 0, calibrated: false, shrinkage: 1 };
  if (trainIdx.length < 40 || testIdx.length === 0) return empty;

  const X = trainIdx.map((i) => dataset.x[i] as number[]);
  const W = trainIdx.map((i) => dataset.weights[i] as number);
  const Y = trainIdx.map((i) => y[i] as boolean);

  const innerEvents = trainIdx.map((i) => ({ index: dataset.index[i] as number, span: dataset.spans[i] as { t0: number; t1: number } }));
  const innerFolds = purgedEventFolds(innerEvents, totalBars, {
    folds: META_INNER_FOLDS,
    purgeBars: purge,
    embargoBars: META_EMBARGO_BARS,
  });
  const outOfFold: (number | null)[] = new Array(trainIdx.length).fill(null);
  // Every inner model also predicts the TEST rows, and those predictions are
  // averaged into the value the calibrator is applied to. This is not a
  // convenience: the map is fitted on predictions from models trained on
  // (k−1)/k of the fold, so applying it to a prediction from a model trained on
  // the WHOLE fold — a sharper, more extreme predictor — stretches the map and
  // produces exactly the overconfidence the report would then have to flag. The
  // distribution of the input has to match the distribution of the map's inputs,
  // which is what cross-fitting means.
  const testRows = testIdx.map((i) => dataset.x[i] as number[]);
  const bagged: number[][] = [];
  for (const inner of innerFolds) {
    if (inner.train.length < 20 || inner.test.length === 0) continue;
    const innerModel = fitLogistic({
      X: inner.train.map((i) => X[i] as number[]),
      y: inner.train.map((i) => Y[i] as boolean),
      featureNames,
      weights: inner.train.map((i) => W[i] as number),
      l2: META_L2,
    });
    for (const i of inner.test) outOfFold[i] = predictLogistic(innerModel, X[i] as number[]);
    bagged.push(testRows.map((row) => predictLogistic(innerModel, row)));
  }
  if (bagged.length === 0) return empty;
  const scored = outOfFold.map((value, i) => ({ value, i })).filter((entry) => entry.value !== null) as { value: number; i: number }[];

  // The evidence base is the SUM of the fold's uniqueness weights — the number of
  // independent observations the fit rests on — not the row count. See
  // `uniqueness.ts`: Kish is a concentration measure and would read ten identical
  // events as ten.
  const evidence = W.reduce((a, b) => a + b, 0);
  const baseRate = weightedMean(Y.map((hit) => (hit ? 1 : 0)), W);
  const enough = scored.length >= META_MIN_CALIBRATION_PAIRS && evidence >= MIN_CALIBRATION_SAMPLES;
  const calibrationInput = {
    p: scored.map((entry) => entry.value),
    y: scored.map((entry) => Y[entry.i] as boolean),
    weights: scored.map((entry) => W[entry.i] as number),
  };
  const calibrated = enough && (calibratorKind === "isotonic"
    ? true
    : reliability(calibrationInput.p, calibrationInput.y, calibrationInput.weights).identifiable);
  let calibrator =
    calibrated && calibratorKind === "isotonic" ? fitIsotonic(calibrationInput) : identityMap(baseRate);
  let shrinkage = 1;
  if (calibrated && calibratorKind !== "isotonic") {
    calibrator = plattMap(calibrationInput.p, calibrationInput.y, calibrationInput.weights);
    if (calibratorKind === "platt-shrunk") {
      // How much of the fitted spread actually survives to a period the map was
      // not fitted on? Answer it inside the fold: split the out-of-fold sample
      // in half BY TIME, fit the map on one half and measure the reliability
      // slope on the other, both ways round.
      shrinkage = internalShrinkage(dataset, scored, Y, W);
      const platt = calibrator.platt;
      if (platt) calibrator = { ...calibrator, platt: { a: platt.a, b: platt.b * shrinkage } };
    }
  }

  void shrinkage;
  const rows: MetaOosRow[] = [];
  for (let j = 0; j < testIdx.length; j++) {
    const i = testIdx[j] as number;
    const pRaw = mean(bagged.map((predictions) => predictions[j] as number));
    const pHat = calibrated
      ? calibratorKind === "platt"
        ? applyPlatt(calibrator, pRaw)
        : applyIsotonic(calibrator, pRaw)
      : pRaw;
    const pLcb = probabilityLowerBound(pHat, evidence);
    const targetMultipleR = dataset.targetMultipleR[i] as number;
    const costR = dataset.costR[i] as number;
    const armed = expectedValueLowerBound({ pLcb, targetMultipleR, costR }) > 0;
    rows.push({
      series,
      index: dataset.index[i] as number,
      fold,
      pRaw,
      pHat,
      pLcb,
      hit: y[i] as boolean,
      rMultiple: dataset.rMultiple[i] as number,
      emitted: dataset.emitted[i] as boolean,
      armed,
      targetMultipleR,
      weight: dataset.weights[i] as number,
      evidence,
      costR,
      riskPrice: dataset.riskPrice[i] as number,
      horizonBars: dataset.horizonBars[i] as number,
      direction: dataset.direction[i] as 1 | -1,
    });
  }
  return { rows, calibration: scored.length, calibrated, shrinkage };
}

/**
 * The spread that survives an internal time split.
 *
 * `slope < 1` means the map's confidence does not transfer between two periods of
 * the SAME training fold — which is the property that decides whether the
 * confidence will transfer to the test fold. Measuring it internally and
 * deflating by it is the difference between "the model says 80%" and "the model
 * says 80%, and history says that claim arrives at about 55% when the period
 * changes".
 *
 * The value is clamped to [META_SHRINKAGE_FLOOR, 1]: it can only ever reduce
 * confidence, never inflate it, and it is recorded in the report per fold. When
 * the internal split cannot be measured the factor is 1 — the model keeps the
 * calibration it fitted, and the out-of-sample gates judge it.
 */
function internalShrinkage(
  dataset: MetaDataset,
  scored: { value: number; i: number }[],
  Y: boolean[],
  W: number[],
): number {
  if (scored.length < 60) return 1;
  const ordered = [...scored].sort((a, b) => (dataset.index[a.i] as number) - (dataset.index[b.i] as number));
  const half = Math.floor(ordered.length / 2);
  const first = ordered.slice(0, half);
  const second = ordered.slice(half);
  const slopes: number[] = [];
  for (const [fitSide, checkSide] of [
    [first, second],
    [second, first],
  ] as const) {
    if (fitSide.length < 20 || checkSide.length < 20) continue;
    const fit = reliability(
      fitSide.map((entry) => entry.value),
      fitSide.map((entry) => Y[entry.i] as boolean),
      fitSide.map((entry) => W[entry.i] as number),
    );
    if (!fit.identifiable || fit.slope === null) continue;
    const fitSlope = fit.slope;
    const applied = checkSide.map((entry) =>
      applyPlatt({ ...identityMap(), platt: { a: fit.intercept ?? 0, b: fitSlope } }, entry.value),
    );
    const check = reliability(
      applied,
      checkSide.map((entry) => Y[entry.i] as boolean),
      checkSide.map((entry) => W[entry.i] as number),
    );
    if (check.identifiable && check.slope !== null && Number.isFinite(check.slope)) slopes.push(check.slope);
  }
  if (slopes.length === 0) return 1;
  const measured = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  return Math.max(META_SHRINKAGE_FLOOR, Math.min(1, measured));
}

/**
 * A two-parameter logistic recalibration of the out-of-fold scores.
 *
 * Reuses the same Newton solver the reliability gate is built on, so "the map
 * this study applied" and "the map this study measured" cannot drift apart: the
 * fit that produces `a` and `b` is the fit whose slope is reported.
 */
function plattMap(p: number[], y: boolean[], weights: number[]): IsotonicMap {
  const fit = reliability(p, y, weights);
  return {
    ...identityMap(weightedMean(y.map((hit) => (hit ? 1 : 0)), weights)),
    points: [],
    platt: { a: fit.intercept ?? 0, b: fit.slope ?? 1 },
  };
}

function applyPlatt(map: IsotonicMap, pRaw: number): number {
  const platt = map.platt;
  if (!platt) return pRaw;
  const logit = Math.log(Math.min(1 - 1e-9, Math.max(1e-9, pRaw)) / (1 - Math.min(1 - 1e-9, Math.max(1e-9, pRaw))));
  const z = platt.a + platt.b * logit;
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Every headline number, computed from rows — so pools and single series agree. */
export function summariseMetaRows(rows: MetaOosRow[]): MetaStats {
  if (rows.length === 0) {
    const empty = { armed: 0, armedRate: 0, hitRate: 0, meanR: 0, meanRLower: 0 };
    return {
      rows: 0,
      hitRate: 0,
      hitRateLower: 0,
      baseRate: 0,
      brier: 1,
      brierSkill: -1,
      logLoss: 1,
      reliability: { slope: null, intercept: null, identifiable: false, reason: "no rows" },
      buckets: [],
      violationBuckets: [],
      judgeableBuckets: 0,
      reference: { ...empty },
      fitted: { ...empty, meanLowerBound: 0 },
      corpus: { hitRate: 0, meanR: 0 },
    };
  }
  const predictions = rows.map((row) => row.pHat);
  const outcomes = rows.map((row) => row.hit);
  const weights = rows.map((row) => row.weight);
  const hits = rows.filter((row) => row.hit).length;
  const baseRate = weightedMean(outcomes.map((hit) => (hit ? 1 : 0)), weights);
  const brier = brierScore(predictions, outcomes, weights);
  const referenceBrier = brierScore(
    rows.map(() => baseRate),
    outcomes,
    weights,
  );
  const buckets = decileBuckets(rows);
  const violationBuckets = buckets
    .map((bucket, index) => (bucket.rows >= META_MIN_BUCKET_ROWS && bucket.observed < bucket.meanLowerBound - META_COVERAGE_TOLERANCE ? index : -1))
    .filter((index) => index >= 0);
  const judgeable = buckets.filter((bucket) => bucket.rows >= META_MIN_BUCKET_ROWS).length;
  const interval = wilsonInterval(hits, rows.length);
  return {
    rows: rows.length,
    hitRate: hits / rows.length,
    hitRateLower: interval.lower,
    baseRate,
    brier,
    brierSkill: referenceBrier > 0 ? 1 - brier / referenceBrier : 0,
    logLoss: logLoss(predictions, outcomes, weights),
    reliability: reliability(predictions, outcomes, weights),
    buckets,
    violationBuckets,
    judgeableBuckets: judgeable,
    reference: policyStats(rows.filter((row) => row.emitted), "reference"),
    fitted: {
      ...policyStats(rows.filter((row) => row.armed), "fitted"),
      meanLowerBound: mean(rows.map((row) => row.pLcb)),
    },
    corpus: { hitRate: hits / rows.length, meanR: mean(rows.map((row) => row.rMultiple)) },
  };
}

function policyStats(rows: MetaOosRow[], _label: string): { armed: number; armedRate: number; hitRate: number; meanR: number; meanRLower: number } {
  const hits = rows.filter((row) => row.hit).length;
  const r = rows.map((row) => row.rMultiple);
  const m = mean(r);
  const sd = stdDev(r, m);
  const se = rows.length > 0 ? sd / Math.sqrt(rows.length) : 0;
  return {
    armed: rows.length,
    armedRate: 0,
    hitRate: rows.length > 0 ? hits / rows.length : 0,
    meanR: m,
    meanRLower: m - META_Z * se,
  };
}

/** Equal-count deciles by calibrated probability: predicted vs realised. */
export function decileBuckets(rows: MetaOosRow[]): MetaBucket[] {
  const sorted = [...rows].sort((a, b) => a.pHat - b.pHat);
  const buckets: MetaBucket[] = [];
  const size = Math.max(1, Math.ceil(sorted.length / 10));
  for (let start = 0; start < sorted.length; start += size) {
    const slice = sorted.slice(start, start + size);
    buckets.push({
      bucket: buckets.length,
      rows: slice.length,
      meanPredicted: mean(slice.map((row) => row.pHat)),
      meanLowerBound: mean(slice.map((row) => row.pLcb)),
      observed: slice.filter((row) => row.hit).length / slice.length,
    });
  }
  return buckets;
}

export interface MetaGateResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface MetaGateReport {
  gates: MetaGateResult[];
  pass: boolean;
}

/**
 * Calibration gates, decided per fixture series pool (never across fixtures — a
 * different generator is a different question).
 */
export function metaCalibrationGates(stats: MetaStats): MetaGateReport {
  const gates: MetaGateResult[] = [];
  const bandOk =
    stats.reliability.identifiable &&
    stats.reliability.slope !== null &&
    stats.reliability.slope >= META_SLOPE_MIN &&
    stats.reliability.slope <= META_SLOPE_MAX;
  gates.push({
    name: "labelled rows",
    pass: stats.rows >= META_MIN_LABELLED,
    detail: `${stats.rows} rows with a finished label (need ≥ ${META_MIN_LABELLED})`,
  });
  gates.push({
    name: "reliability slope",
    pass: bandOk,
    detail: stats.reliability.identifiable
      ? `slope ${(stats.reliability.slope ?? 0).toFixed(3)} (need ${META_SLOPE_MIN}–${META_SLOPE_MAX})`
      : `unidentifiable: ${stats.reliability.reason}`,
  });
  gates.push({
    name: "Brier skill",
    pass: stats.brierSkill > 0,
    detail: `skill ${stats.brierSkill.toFixed(4)} against the constant base-rate forecast (need > 0)`,
  });
  gates.push({
    name: "p_LCB coverage",
    pass:
      stats.judgeableBuckets === 0 ||
      stats.violationBuckets.length / stats.judgeableBuckets <= META_COVERAGE_VIOLATION_MAX_FRACTION,
    detail:
      `${stats.violationBuckets.length}/${stats.judgeableBuckets} judgeable deciles realised below their own mean p_LCB ` +
      `by > ${(META_COVERAGE_TOLERANCE * 100).toFixed(0)}pp (allowed ≤ ${(META_COVERAGE_VIOLATION_MAX_FRACTION * 100).toFixed(0)}%)`,
  });
  gates.push({
    name: "fitted policy arms",
    pass: stats.fitted.armed >= META_MIN_ARMED,
    detail: `${stats.fitted.armed} armed at EV_LCB > 0 (need ≥ ${META_MIN_ARMED})`,
  });
  gates.push({
    name: "fitted beats corpus",
    pass: stats.fitted.armed > 0 && stats.fitted.meanR > stats.corpus.meanR,
    detail:
      `fitted mean R ${stats.fitted.meanR.toFixed(3)} vs corpus ${stats.corpus.meanR.toFixed(3)} ` +
      `(hit ${(stats.fitted.hitRate * 100).toFixed(1)}% vs ${(stats.corpus.hitRate * 100).toFixed(1)}%)`,
  });
  return { gates, pass: gates.every((gate) => gate.pass) };
}

/**
 * The null gate: on a series with no edge, the fitted policy must not show one.
 *
 * "It refused to trade" is a pass. This is the same shape as the WP4 driftless
 * gate, applied to the composed model rather than one agent: the bar is not
 * "nothing happened", it is "nothing was claimed".
 */
export function metaNullGates(stats: MetaStats): MetaGateReport {
  const gates: MetaGateResult[] = [];
  const quiet = stats.fitted.armed < META_NULL_ARMED_FLOOR;
  gates.push({
    name: "null: no positive edge",
    pass: quiet || stats.fitted.meanRLower <= 0,
    detail: quiet
      ? `refused to arm (${stats.fitted.armed} of ${stats.rows} rows)`
      : `${stats.fitted.armed} armed, mean R ${stats.fitted.meanR.toFixed(3)} with 95% lower bound ${stats.fitted.meanRLower.toFixed(3)} (need ≤ 0)`,
  });
  gates.push({
    name: "null: bound stays honest",
    pass: stats.fitted.meanLowerBound <= stats.baseRate + META_COVERAGE_TOLERANCE,
    detail: `mean p_LCB ${stats.fitted.meanLowerBound.toFixed(3)} vs base rate ${stats.baseRate.toFixed(3)}`,
  });
  return { gates, pass: gates.every((gate) => gate.pass) };
}

/** A per-series record without the row-level detail (the artifact stays readable). */
export interface MetaSeriesRecord {
  series: string;
  evaluations: number;
  views: number;
  viewRate: number;
  labelled: number;
  independentObservations: number;
  kishEffectiveSampleSize: number;
  unfinished: number;
  folds: MetaStudyMeasurement["folds"];
  cpcvPaths: number;
  cpcvPositivePaths: number;
  cpcvMeanR: MetaStudyMeasurement["cpcvMeanR"];
  stats: MetaStats;
  elapsedMs: number;
}

export interface MetaFixtureVerdict {
  name: string;
  kind: string;
  home: boolean;
  null: boolean;
  note: string;
  pooled: MetaStats;
  series: MetaSeriesRecord[];
  calibration: MetaGateReport;
  nullGates: MetaGateReport | null;
}

export interface MetaStudyReport {
  label: string;
  generatedAt: string;
  command: string;
  mode: TradeMode;
  symbol: string;
  seed: number;
  dataSource: string;
  barsPerSeries: number;
  seriesPerFixture: number;
  stride: number;
  horizonBars: number;
  targetMultipleR: number;
  calibrator: MetaCalibratorKind;
  contractSpec: Record<string, unknown>;
  assumedSpecValues: string[];
  fixtures: MetaFixtureVerdict[];
  verdict: "pass" | "fail";
  notes: string[];
}

/** Drop row-level detail: the persisted artifact keeps every statistic, no raw rows. */
export function toSeriesRecord(measurement: MetaStudyMeasurement): MetaSeriesRecord {
  const { rows: _rows, ...rest } = measurement;
  void _rows;
  return rest;
}

export interface MetaFixtureReport {
  fixture: MetaFixture;
  pooled: MetaStats;
  series: MetaStudyMeasurement[];
  calibration: MetaGateReport;
}

export function runMetaFixture(input: {
  fixture: MetaFixture;
  mode: TradeMode;
  seed: number;
  spec: SymbolSpec;
  symbol: string;
  frame: Timeframe;
  frameWidthMs: number;
  stride: number;
  warmupBars: number;
  horizonBars: number;
  seriesOverride?: number;
  barsOverride?: number;
  agents?: Record<AlphaId, AlphaAgent>;
}): MetaFixtureReport {
  const seriesCount = input.seriesOverride ?? input.fixture.series;
  const barsCount = input.barsOverride ?? input.fixture.bars;
  const measurements: MetaStudyMeasurement[] = [];
  for (let r = 0; r < seriesCount; r++) {
    const generated = generate(input.fixture.kind as GeneratorKind, {
      ...DEFAULT_GENERATOR_SPEC,
      seed: input.seed + r * 1013,
      bars: barsCount,
      timeframeMs: input.frameWidthMs,
      volatility: input.mode === "scalp" ? 0.00035 : input.mode === "intraday" ? 0.0008 : 0.0016,
    });
    measurements.push(
      measureMeta({
        bars: generated.bars,
        series: `${input.fixture.name}#${r + 1}`,
        kind: input.fixture.kind,
        mode: input.mode,
        spec: input.spec,
        symbol: input.symbol,
        frame: input.frame,
        frameWidthMs: input.frameWidthMs,
        stride: input.stride,
        warmupBars: input.warmupBars,
        targetMultipleR: META_TARGET_MULTIPLE_R,
        horizonBars: input.horizonBars,
        ...(input.agents ? { agents: input.agents } : {}),
      }),
    );
  }
  const pooledRows = measurements.flatMap((measurement) => measurement.rows);
  const pooled = summariseMetaRows(pooledRows);
  return {
    fixture: input.fixture,
    pooled,
    series: measurements,
    calibration: metaCalibrationGates(pooled),
  };
}

/** Causal trailing mean of finished bar ranges (high − low). */

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function weightedMean(values: number[], weights: number[]): number {
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i] as number;
    sum += w * (values[i] as number);
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : 0;
}

function stdDev(values: number[], m: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}
