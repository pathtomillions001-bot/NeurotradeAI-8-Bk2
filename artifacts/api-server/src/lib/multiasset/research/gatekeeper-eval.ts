/**
 * WP6 — the gatekeeper study.
 *
 * ── WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────
 *
 * WP5 measured whether the desk's stated probabilities are true. This measures
 * what happens when the WP6 gate is spent on them: **which trades survive, and
 * what the survivors are worth.**
 *
 * Three of the gatekeeper's six layers are measured here, row by row, on the
 * SAME purged, cross-fitted folds WP5's report was built on:
 *
 *   - the EV floor (`EV_LCB ≥ 0.20R`) against WP5's own `EV_LCB > 0`, so the
 *     cost of demanding a margin is visible in arm count AND in realised mean R;
 *   - the BH gate at q = 0.10, tested in each fold against a MEASURED
 *     direction-matched break-even rate (never `1/(1+RR)` — see `alpha/edge.ts`
 *     and `meta/gatekeeper.ts`), so "significance in a search over many setups"
 *     is priced rather than assumed;
 *   - the cost/σ_h ratio: the round trip against the travel the trade needs,
 *     reported for every mode and enforced where the desk enforces it.
 *
 * Two layers are NOT re-measured here, and the report says so rather than
 * implying coverage it does not have:
 *
 *   - the WP3 regime permit. Fitting a three-state HMM at every row would cost
 *     more than every other measurement in the programme combined, and it is
 *     already measured — `research-reports/2026-10-11-wp3-regime-study-*.json`
 *     is its study, and `wp6-gatekeeper-wiring.test.ts` measures the composition.
 *   - the executed-policy Monte Carlo, per row. It IS sampled here (see
 *     `mcStride`), because a gate nobody has ever seen pass is not a gate; the
 *     per-decision path is exercised by the wiring tests.
 *
 * ── WHY THE NULLS ARE THE INTERESTING PART ──────────────────────────────────
 *
 * A gate that refuses everything passes every null test ever written. So the
 * null verdict here is not "it did not lose" — it is the same shape as WP5's:
 * the null corpus must not show a statistically positive mean R among the trades
 * the gate admitted. Refusing to arm passes; arming into noise fails.
 */
import {
  baselineAt,
  baselineForDirection,
  entryPriceOf,
  extendBaseline,
  newBaselineState,
  returnSeries,
} from "../alpha/edge";
import { causalAtrSeries } from "../meta/atr";
import { riskPriceAt, roundTripCostPrice, type MetaCostInput } from "../meta/dataset";
import { pointValuePerLot } from "../sizing";
import { MODE_HORIZON_BARS } from "../confluence";
import {
  BH_Q,
  MAX_COST_OVER_HORIZON_SIGMA,
  MC_MIN_TARGET_SHARE,
  MC_TAIL_FLOOR_R,
  MIN_EV_LCB_R,
  benjaminiHochberg,
  costOverHorizonSigma,
  edgeTestPValue,
} from "../meta/gatekeeper";
import { expectedValueLowerBound } from "../meta/pcb";
import { executedPolicyMonteCarlo } from "../montecarlo-v2";
import { CLOSE } from "../math";
import type { Bar, SymbolSpec, TradeMode } from "../types";
import { META_TARGET_MULTIPLE_R, summariseMetaRows, type MetaOosRow, type MetaStudyMeasurement } from "./meta-eval";

/**
 * Resolution of the sampled Monte Carlo.
 *
 * Every `mcStride`-th row gets a full executed-policy MC; the rest are not
 * sampled. This is a RUNTIME budget, stated as one: a per-row MC would multiply
 * the study's cost by two orders of magnitude, and the per-decision path is
 * covered by the wiring tests. The paths and trades-per-path are deliberately
 * small for the same reason, and the report prints all three numbers so a reader
 * can see exactly how thin the tail estimate is.
 */
export const GK_MC_STRIDE = 60;
export const GK_MC_PATHS = 100;
export const GK_MC_TRADES_PER_PATH = 8;

/** The floors, echoed into the report so a reader never has to open the source. */
export const GK_STUDY_FLOOR_R = MIN_EV_LCB_R;
export const GK_STUDY_BH_Q = BH_Q;
export const GK_STUDY_COST_SIGMA = MAX_COST_OVER_HORIZON_SIGMA;

export interface GatekeeperPolicySlice {
  armed: number;
  armedRate: number;
  hitRate: number;
  meanR: number;
  meanRLower: number;
}

export interface GatekeeperSeriesAssessment {
  series: string;
  kind: string;
  mode: TradeMode;
  rows: number;
  /** Mean independent observations behind a row's p_LCB. */
  evidenceMean: number;
  /** Mean measured break-even rate the p-value was tested against. */
  breakEvenMean: number;
  /** WP5's fitted policy: armed on `EV_LCB > 0`. */
  evZero: GatekeeperPolicySlice;
  /** WP6: armed on `EV_LCB ≥ floor`, the mode's own floor. */
  evFloor: GatekeeperPolicySlice;
  /** WP6 in full: the floor AND survival of BH at q = 0.10 against the measured break-even. */
  gated: GatekeeperPolicySlice;
  bh: { tested: number; rejected: number; thresholdMedian: number };
  edgeP: { median: number; overQ: number };
  costSigma: { measured: number; median: number; above: number };
  mc: {
    samples: number;
    /** Bars where the simulation's lower tail was positive. REPORTED, not gated. */
    positiveTail: number;
    /** Sampled bars the geometry layer admits (target reachable, tail above the floor). */
    admitted: number;
    medianMeanR: number;
    failedFit: number;
    paths: number;
    tradesPerPath: number;
    stride: number;
    /**
     * The sampled readings, in full.
     *
     * Kept so a reader can recompute any bar over them — including bars this
     * study does not apply. The MC layer is a GEOMETRY check and its bars must be
     * set below the measured range, not inside it, so the range has to be in the
     * report rather than in whoever's head set the constant.
     */
    readings: {
      row: number;
      meanR: number;
      p05MeanR: number;
      targetShare: number;
      timeoutShare: number;
    }[];
    meanR: { p05: number; median: number; min: number };
    p05: { p05: number; median: number; min: number };
    targetShare: { p05: number; median: number; min: number };
    timeoutShare: { p05: number; median: number; max: number };
  };
  corpus: { hitRate: number; meanR: number };
}

/** Per-bar return scale, causally, from a trailing window. */
function trailingSigma(returns: number[], index: number, window = 60): number | null {
  if (index < window) return null;
  let sum = 0;
  let sumSq = 0;
  for (let i = index - window + 1; i <= index; i++) {
    const r = returns[i] as number;
    sum += r;
    sumSq += r * r;
  }
  const meanR = sum / window;
  const variance = Math.max(0, sumSq / window - meanR * meanR);
  const sigma = Math.sqrt(variance);
  return sigma > 0 ? sigma : null;
}

/**
 * Assess one series' out-of-fold rows under the WP6 gate.
 *
 * The break-even each row is tested against is the MEASURED direction-matched
 * random-entry rate at that row's own decision bar — the same quantity the live
 * gatekeeper is handed by the model snapshot's cohort. Using `1/(1+RR)` here
 * instead would be the single easiest way to make this study produce a green
 * verdict it has not earned.
 */
export function assessGatekeeperSeries(input: {
  measurement: MetaStudyMeasurement;
  bars: Bar[];
  spec: SymbolSpec;
  mode: TradeMode;
  horizonBars: number;
  seed: number;
}): GatekeeperSeriesAssessment {
  const { measurement, bars, spec, mode, horizonBars } = input;
  const rows = measurement.rows;
  const floor = MIN_EV_LCB_R[mode];
  const returns = returnSeries(bars);
  const atr = causalAtrSeries(bars);
  const costInput: MetaCostInput = {
    spec: {
      point: spec.point,
      spreadPoints: spec.spreadPoints,
      commissionPerLot: spec.commissionPerLot,
      assetClass: spec.assetClass,
    },
    pointValuePerLot: pointValuePerLot(spec),
  };

  /**
   * The measured break-even: random entry at EVERY bar, both directions, with the
   * desk's own geometry for this mode (the same stop rule and the same
   * side-dependent entry price the corpus was labelled against, so the comparator
   * is literally "the same trade, entered at random").
   */
  const baseline = newBaselineState();
  extendBaseline(baseline, {
    bars,
    stopDistanceAt: (i) => riskPriceAt(costInput, mode, atr[i] ?? 0),
    entryAt: (i, direction) =>
      entryPriceOf((bars[i] as Bar)[CLOSE] as number, direction, spec.spreadPoints * spec.point),
    rr: META_TARGET_MULTIPLE_R,
    horizonBars,
    startIndex: 0,
  });

  const breakEvenOf = (row: MetaOosRow): number | null => {
    const rates = baselineAt(baseline, row.index, horizonBars);
    return baselineForDirection(rates, row.direction === 1 ? "buy" : "sell");
  };

  // Per-row gate verdicts, computed once and sliced three ways.
  const rowBreakEven: (number | null)[] = rows.map((row) => breakEvenOf(row));
  const pValues: (number | null)[] = rows.map((row, i) => {
    const be = rowBreakEven[i];
    if (be === null) return null;
    return edgeTestPValue({ probability: row.pHat, evidence: row.evidence, breakEven: be });
  });
  // BH runs PER FOLD: the family is the set of candidates the cycle considered,
  // and the folds are the honest proxy for "the searches this desk ran".
  const accepts = rows.map(() => false);
  const foldIds = Array.from(new Set(rows.map((row) => row.fold))).sort((a, b) => a - b);
  const thresholds: number[] = [];
  for (const fold of foldIds) {
    const idx = rows.map((row, i) => ({ row, i })).filter((entry) => entry.row.fold === fold);
    const ps = idx.map((entry) => pValues[entry.i]).map((p) => (p === null ? 1 : p));
    const result = benjaminiHochberg(ps, BH_Q);
    thresholds.push(result.threshold);
    idx.forEach((entry, j) => {
      if (result.accepted[j] as boolean) accepts[entry.i] = true;
    });
  }

  const evFloorPass = rows.map((row, i) => {
    const costR = row.costR;
    if (!Number.isFinite(costR)) return false;
    return expectedValueLowerBound({ pLcb: row.pLcb, targetMultipleR: row.targetMultipleR, costR }) >= floor - 1e-9;
  });
  const evZeroPass = rows.map(
    (row) => expectedValueLowerBound({ pLcb: row.pLcb, targetMultipleR: row.targetMultipleR, costR: row.costR }) > 0,
  );

  const slice = (mask: boolean[]): GatekeeperPolicySlice => {
    const stats = summariseMetaRows(rows.map((row, i) => ({ ...row, armed: mask[i] as boolean })));
    return {
      armed: stats.fitted.armed,
      armedRate: stats.fitted.armedRate,
      hitRate: stats.fitted.hitRate,
      meanR: stats.fitted.meanR,
      meanRLower: stats.fitted.meanRLower,
    };
  };

  const gatedMask = rows.map((row, i) => (evFloorPass[i] as boolean) && (accepts[i] as boolean));

  // Cost against the horizon's volatility, on the same geometry the desk prices:
  // the round trip in PRICE units from the corpus's own cost model, over the
  // distance σ_step·√h the trade has to travel to be worth taking.
  const costPrice = roundTripCostPrice(costInput, mode);
  const sigmas = rows.map((row) => trailingSigma(returns, row.index));
  const costRatios = rows.map((row, i) => {
    const sigma = sigmas[i];
    const close = (bars[row.index] as Bar | undefined)?.[CLOSE];
    if (sigma === null || typeof close !== "number") return null;
    return costOverHorizonSigma({
      costPrice,
      expectedFill: close,
      stepVolatility: sigma,
      horizonBars: row.horizonBars,
    });
  });
  const measuredRatios = costRatios.filter((ratio): ratio is number => ratio !== null);

  // The sampled executed-policy Monte Carlo.
  const mcRows = rows.filter((_row, i) => i % GK_MC_STRIDE === 0);
  let mcPositive = 0;
  let mcAdmitted = 0;
  let mcFailed = 0;
  const mcMeans: number[] = [];
  const mcReadings: GatekeeperSeriesAssessment["mc"]["readings"] = [];
  for (const row of mcRows) {
    const close = (bars[row.index] as Bar | undefined)?.[CLOSE];
    if (!(row.riskPrice > 0) || typeof close !== "number") {
      mcFailed++;
      continue;
    }
    const result = executedPolicyMonteCarlo({
      closes: bars.slice(0, row.index + 1).map((bar) => bar[CLOSE] as number),
      entry: close,
      riskPrice: row.riskPrice,
      targetMultipleR: row.targetMultipleR,
      side: row.direction === 1 ? "buy" : "sell",
      costPrice,
      horizonBars: row.horizonBars,
      tradesPerPath: GK_MC_TRADES_PER_PATH,
      paths: GK_MC_PATHS,
      seed: input.seed + row.index,
    });
    const traded = result.outcomes.target + result.outcomes.stop + result.outcomes.timeout;
    if (!result.pathsUsingGarch) mcFailed++;
    else if (result.p05MeanR > 0) mcPositive++;
    if (
      traded > 0 &&
      result.outcomes.target / traded >= MC_MIN_TARGET_SHARE &&
      result.p05MeanR >= -MC_TAIL_FLOOR_R
    ) {
      mcAdmitted++;
    }
    mcMeans.push(result.meanR);
    mcReadings.push({
      row: row.index,
      meanR: result.meanR,
      p05MeanR: result.p05MeanR,
      targetShare: traded > 0 ? result.outcomes.target / traded : 0,
      timeoutShare: traded > 0 ? result.outcomes.timeout / traded : 1,
    });
  }

  /**
   * A reading's own distribution: the low end is what a GEOMETRY bar has to sit
   * below, so the report states it rather than leaving the constant to memory.
   */
  const quantiles = (values: number[]): { p05: number; median: number; min: number; max: number } => {
    if (values.length === 0) return { p05: 0, median: 0, min: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)))] as number;
    return { p05: at(0.05), median: at(0.5), min: sorted[0] as number, max: sorted[sorted.length - 1] as number };
  };

  const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
  };

  return {
    series: measurement.series,
    kind: measurement.kind,
    mode,
    rows: rows.length,
    evidenceMean: rows.length > 0 ? rows.reduce((a, row) => a + row.evidence, 0) / rows.length : 0,
    breakEvenMean:
      rows.length > 0
        ? rows.reduce((a, _row, i) => a + (rowBreakEven[i] ?? 0), 0) /
          Math.max(1, rowBreakEven.filter((value) => value !== null).length)
        : 0,
    evZero: slice(evZeroPass),
    evFloor: slice(evFloorPass),
    gated: slice(gatedMask),
    bh: {
      tested: rows.length,
      rejected: accepts.filter((value) => !value).length,
      thresholdMedian: median(thresholds),
    },
    edgeP: {
      median: median(pValues.filter((p): p is number => p !== null)),
      overQ: pValues.filter((p) => p !== null && (p as number) > BH_Q).length,
    },
    costSigma: { measured: measuredRatios.length, median: median(measuredRatios), above: measuredRatios.filter((r) => r > MAX_COST_OVER_HORIZON_SIGMA).length },
    mc: {
      samples: mcRows.length,
      positiveTail: mcPositive,
      admitted: mcAdmitted,
      medianMeanR: median(mcMeans),
      failedFit: mcFailed,
      paths: GK_MC_PATHS,
      tradesPerPath: GK_MC_TRADES_PER_PATH,
      stride: GK_MC_STRIDE,
      readings: mcReadings,
      meanR: quantiles(mcReadings.map((reading) => reading.meanR)),
      p05: quantiles(mcReadings.map((reading) => reading.p05MeanR)),
      targetShare: quantiles(mcReadings.map((reading) => reading.targetShare)),
      timeoutShare: quantiles(mcReadings.map((reading) => reading.timeoutShare)),
    },
    corpus: { hitRate: measurement.stats.corpus.hitRate, meanR: measurement.stats.corpus.meanR },
  };
}

export interface GatekeeperFixtureAssessment {
  name: string;
  kind: string;
  mode: TradeMode;
  home: boolean;
  null: boolean;
  note: string;
  series: GatekeeperSeriesAssessment[];
  pooled: {
    rows: number;
    evZero: GatekeeperPolicySlice;
    evFloor: GatekeeperPolicySlice;
    gated: GatekeeperPolicySlice;
    corpus: { hitRate: number; meanR: number };
    mcAdmitted: number;
    mcSamples: number;
  };
}

/** Pool the series of one fixture by weights (rows), so a fixture is one number. */
export function poolGatekeeperSeries(
  series: GatekeeperSeriesAssessment[],
  corpus: { hitRate: number; meanR: number },
): GatekeeperFixtureAssessment["pooled"] {
  const total = series.reduce((a, s) => a + s.rows, 0);
  const forRows = (values: (assessment: GatekeeperSeriesAssessment) => GatekeeperPolicySlice): GatekeeperPolicySlice => {
    let armedSum = 0;
    let hitWeighted = 0;
    let rWeighted = 0;
    let lowerWeighted = 0;
    for (const s of series) {
      const slice = values(s);
      armedSum += slice.armed;
      hitWeighted += slice.armed * slice.hitRate;
      rWeighted += slice.armed * slice.meanR;
      lowerWeighted += slice.armed * slice.meanRLower;
    }
    return {
      armed: armedSum,
      armedRate: total > 0 ? armedSum / total : 0,
      hitRate: armedSum > 0 ? hitWeighted / armedSum : 0,
      meanR: armedSum > 0 ? rWeighted / armedSum : 0,
      meanRLower: armedSum > 0 ? lowerWeighted / armedSum : 0,
    };
  };
  return {
    rows: total,
    evZero: forRows((s) => s.evZero),
    evFloor: forRows((s) => s.evFloor),
    gated: forRows((s) => s.gated),
    corpus,
    mcAdmitted: series.reduce((a, s) => a + s.mc.admitted, 0),
    mcSamples: series.reduce((a, s) => a + s.mc.samples, 0),
  };
}

export interface GatekeeperGateResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface GatekeeperGateReport {
  gates: GatekeeperGateResult[];
  pass: boolean;
}

/**
 * The gates that decide the WP6 verdict on a HOME fixture.
 *
 * The first one exists to stop the most flattering failure mode: a gate can
 * always make its own numbers look better by refusing nearly everything, so the
 * control corpus must keep a usable number of trades. The second and third are
 * the substance — the survivors must beat the average row, and demanding a
 * margin must not cost realised edge.
 */
export function gatekeeperHomeGates(pooled: GatekeeperFixtureAssessment["pooled"]): GatekeeperGateReport {
  const gates: GatekeeperGateResult[] = [];
  gates.push({
    name: "gate admits a usable number of trades",
    pass: pooled.gated.armed >= 20,
    detail: `${pooled.gated.armed} of ${pooled.rows} rows armed on the floor AND BH (need ≥ 20)`,
  });
  gates.push({
    name: "gated selection beats the corpus",
    pass: pooled.gated.armed > 0 && pooled.gated.meanR > pooled.corpus.meanR,
    detail:
      pooled.gated.armed > 0
        ? `gated mean R ${pooled.gated.meanR.toFixed(3)} vs corpus ${pooled.corpus.meanR.toFixed(3)}`
        : "nothing armed, so there is no selection to judge",
  });
  gates.push({
    name: "the floor does not cost edge",
    pass: pooled.evFloor.armed > 0 && pooled.evFloor.meanR >= pooled.evZero.meanR - 0.02,
    detail: `floor mean R ${pooled.evFloor.meanR.toFixed(3)} vs WP5's EV_LCB>0 ${pooled.evZero.meanR.toFixed(3)} (need ≥ −0.02R)`,
  });
  gates.push({
    name: "the geometry layer does not bite on healthy corpora",
    pass: pooled.mcSamples > 0 && pooled.mcAdmitted / pooled.mcSamples >= 0.5,
    detail: `${pooled.mcAdmitted} of ${pooled.mcSamples} sampled decision bars pass the geometry layer (need ≥ 50%; the bars sit below the measured range, so this gate exists to catch a broken simulation, not to filter alpha)`,
  });
  return { gates, pass: gates.every((gate) => gate.pass) };
}

/**
 * Pool the home fixtures into one policy comparison.
 *
 * One home today (the desk's own positive control), but the gates are written
 * against a POOL rather than a single fixture so that adding a second control
 * later cannot silently change what "the home corpus" means.
 */
export function poolGatekeeperHomes(fixtures: GatekeeperFixtureAssessment[]): GatekeeperGateReport {
  const rows = fixtures.reduce((a, f) => a + f.pooled.rows, 0);
  const mix = (pick: (pooled: GatekeeperFixtureAssessment["pooled"]) => GatekeeperPolicySlice): GatekeeperPolicySlice => {
    let armed = 0;
    let hit = 0;
    let r = 0;
    let lower = 0;
    for (const fixture of fixtures) {
      const slice = pick(fixture.pooled);
      armed += slice.armed;
      hit += slice.armed * slice.hitRate;
      r += slice.armed * slice.meanR;
      lower += slice.armed * slice.meanRLower;
    }
    return {
      armed,
      armedRate: rows > 0 ? armed / rows : 0,
      hitRate: armed > 0 ? hit / armed : 0,
      meanR: armed > 0 ? r / armed : 0,
      meanRLower: armed > 0 ? lower / armed : 0,
    };
  };
  const corpusMeanR =
    fixtures.reduce((a, f) => a + f.pooled.corpus.meanR * f.pooled.rows, 0) / Math.max(1, rows);
  return gatekeeperHomeGates({
    rows,
    evZero: mix((p) => p.evZero),
    evFloor: mix((p) => p.evFloor),
    gated: mix((p) => p.gated),
    corpus: { hitRate: 0, meanR: corpusMeanR },
    mcAdmitted: fixtures.reduce((a, f) => a + f.pooled.mcAdmitted, 0),
    mcSamples: fixtures.reduce((a, f) => a + f.pooled.mcSamples, 0),
  });
}

/**
 * The null gates: the gate must not find a positive edge in noise.
 *
 * `refused to arm` passes — that is the correct behaviour of a gate with nothing
 * to find — and the check that follows is the bound staying honest.
 */
export function gatekeeperNullGates(assessments: GatekeeperFixtureAssessment[]): GatekeeperGateReport {
  const gates: GatekeeperGateResult[] = [];
  let armed = 0;
  let rows = 0;
  let meanR = 0;
  let lower = 0;
  for (const fixture of assessments) {
    armed += fixture.pooled.gated.armed;
    rows += fixture.pooled.rows;
    meanR += fixture.pooled.gated.armed * fixture.pooled.gated.meanR;
    lower += fixture.pooled.gated.armed * fixture.pooled.gated.meanRLower;
  }
  const quiet = armed < 10;
  const pooledMeanR = armed > 0 ? meanR / armed : 0;
  const pooledLower = armed > 0 ? lower / armed : 0;
  gates.push({
    name: "null: no positive edge",
    pass: quiet || pooledLower <= 0,
    detail: quiet
      ? `refused to arm (${armed} of ${rows} rows)`
      : `${armed} armed of ${rows} rows, mean R ${pooledMeanR.toFixed(3)} with 95% lower bound ${pooledLower.toFixed(3)} (need ≤ 0)`,
  });
  gates.push({
    name: "null: every null fixture is reported",
    pass: assessments.every((fixture) => fixture.null),
    detail: `${assessments.map((fixture) => `${fixture.name} (${fixture.pooled.gated.armed} armed)`).join(", ")}`,
  });
  return { gates, pass: gates.every((gate) => gate.pass) };
}

/** The target multiple the corpus's labels were built on, echoed for the report. */
export { META_TARGET_MULTIPLE_R, MODE_HORIZON_BARS };

export interface GatekeeperStudyReport {
  tool: string;
  mode: TradeMode;
  generatedAt: string;
  command: string;
  /** Resolution of the sampled Monte Carlo, so the reader knows how thin it is. */
  mc: { stride: number; paths: number; tradesPerPath: number };
  /** The thresholds, echoed: a report that does not state them cannot be checked. */
  thresholds: { evLcbFloorR: Record<TradeMode, number>; bhQ: number; costSigmaMax: number };
  contractSpec: Record<string, unknown>;
  fixtures: GatekeeperFixtureAssessment[];
  homeGates: GatekeeperGateReport | null;
  nullGates: GatekeeperGateReport | null;
  verdict: "PASS" | "FAIL";
  notes: string[];
}

/** The human-readable report. The JSON beside it carries every number. */
export function renderGatekeeperStudy(report: GatekeeperStudyReport): string {
  const lines: string[] = [];
  const pad = (value: string | number, width: number): string => String(value).padEnd(width);
  const num = (value: number, digits = 3): string => value.toFixed(digits);
  lines.push(`${report.tool} — mode ${report.mode}`);
  lines.push(
    `thresholds: EV_LCB >= ${report.thresholds.evLcbFloorR.scalp}R scalp / ${report.thresholds.evLcbFloorR.intraday}R intraday / ${report.thresholds.evLcbFloorR.swing}R swing, BH q ${report.thresholds.bhQ}, cost/sigma_h <= ${report.thresholds.costSigmaMax} (scalp)`,
  );
  lines.push(
    `sampled MC: every ${report.mc.stride}th decision bar, ${report.mc.paths} paths x ${report.mc.tradesPerPath} trades`,
  );
  lines.push("");
  lines.push(
    pad("fixture", 18) +
      pad("rows", 7) +
      pad("ev>0", 7) +
      pad("R(ev>0)", 9) +
      pad("floor", 7) +
      pad("R(floor)", 9) +
      pad("gated", 7) +
      pad("R(gated)", 9) +
      pad("corpusR", 9) +
      pad("BH rej%", 8) +
      pad("cost/sig", 9) +
      pad("MC+", 7),
  );
  for (const fixture of report.fixtures) {
    const p = fixture.pooled;
    const mc = fixture.series.reduce(
      (a, s) => ({ pos: a.pos + s.mc.admitted, n: a.n + s.mc.samples, rat: a.rat + s.costSigma.above, m: a.m + s.costSigma.measured, med: a.med + s.costSigma.median }),
      { pos: 0, n: 0, rat: 0, m: 0, med: 0 },
    );
    const rej = fixture.series.reduce((a, s) => a + s.bh.rejected, 0);
    lines.push(
      pad(`${fixture.name}${fixture.home ? " [home]" : fixture.null ? " [null]" : ""}`, 18) +
        pad(p.rows, 7) +
        pad(p.evZero.armed, 7) +
        pad(num(p.evZero.meanR, 2), 9) +
        pad(p.evFloor.armed, 7) +
        pad(num(p.evFloor.meanR, 2), 9) +
        pad(p.gated.armed, 7) +
        pad(num(p.gated.meanR, 2), 9) +
        pad(num(p.corpus.meanR, 2), 9) +
        pad(p.rows > 0 ? ((100 * rej) / p.rows).toFixed(1) : "0.0", 8) +
        pad(mc.m > 0 ? num(mc.med / fixture.series.length, 3) : "n/a", 9) +
        pad(`${mc.pos}/${mc.n}`, 7),
    );
  }
  lines.push("");
  const show = (label: string, gates: GatekeeperGateReport | null) => {
    if (!gates) return;
    lines.push(`${label}: ${gates.pass ? "PASS" : "FAIL"}`);
    for (const gate of gates.gates) lines.push(`  ${gate.pass ? "ok  " : "FAIL"} ${gate.name} — ${gate.detail}`);
  };
  show("home fixtures", report.homeGates);
  show("null fixtures", report.nullGates);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push("");
  lines.push(`VERDICT: ${report.verdict}`);
  return lines.join("\n");
}
