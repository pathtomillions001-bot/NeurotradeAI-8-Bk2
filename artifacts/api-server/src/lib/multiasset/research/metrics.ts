/**
 * Research harness — metrics (WP2).
 *
 * Every number here exists because a simpler number lied to the v3 desk:
 *
 *   • HIT RATE alone says nothing about profitability (a 70% winner at 1:0.4
 *     loses), so hit rate is always reported next to E[R] and the R
 *     distribution.
 *   • MEAN R ALONE hides tail risk, so the distribution, its 5% CVaR, the
 *     longest losing streak and the max drawdown travel with it.
 *   • A SHARPE RATIO ALONE is a point estimate of a noisy quantity, so it is
 *     reported with the Probabilistic Sharpe Ratio (the probability the true
 *     ratio is above zero) and, when several configurations were tried, with
 *     the Deflated Sharpe Ratio — which is what stops "we tried 40 variants and
 *     the best looked great" from being mistaken for an edge.
 *   • A CALIBRATION CLAIM is only testable: predicted probability versus
 *     realised frequency, a reliability slope and a Brier score against the
 *     base rate.
 *
 * Pure functions, no dependencies, deterministic. Designed to be read.
 */

import { mean, stdev } from "../math";

// ── Basic trade statistics ──────────────────────────────────────────────────

export interface TradeRecord {
  /** Realised outcome in R (net of costs), including partials. */
  r: number;
  /** Maximum adverse excursion during the trade, in R (≥ 0). */
  maeR: number;
  /** Maximum favourable excursion during the trade, in R (≥ 0). */
  mfeR: number;
  /** Which mode produced it. */
  mode?: string;
  /** Which agent produced it (undefined = the legacy desk). */
  agent?: string;
  /** Predicted probability of a win at entry, when the decision carried one. */
  predictedProbability?: number;
  /** Bars the trade was held. */
  bars: number;
  /** Round-trip cost in R, for the null gate's tolerance. */
  costR?: number;
}

export interface TradeStats {
  trades: number;
  hitRate: number;
  meanR: number;
  /** Standard error of the mean R. */
  meanRStdErr: number;
  rStdDev: number;
  /** Mean of the worst 5% of outcomes (positive number = average loss size). */
  cvar5R: number;
  bestR: number;
  worstR: number;
  profitFactor: number;
  /** Longest run of consecutive losing trades. */
  longestLosingStreak: number;
  /** Peak-to-trough drawdown of the cumulative R curve. */
  maxDrawdownR: number;
  meanMaeR: number;
  meanMfeR: number;
  meanBars: number;
}

export function tradeStats(records: TradeRecord[]): TradeStats {
  if (records.length === 0) {
    return {
      trades: 0,
      hitRate: 0,
      meanR: 0,
      meanRStdErr: 0,
      rStdDev: 0,
      cvar5R: 0,
      bestR: 0,
      worstR: 0,
      profitFactor: 0,
      longestLosingStreak: 0,
      maxDrawdownR: 0,
      meanMaeR: 0,
      meanMfeR: 0,
      meanBars: 0,
    };
  }
  const rs = records.map((r) => r.r);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  let streak = 0;
  let worstStreak = 0;
  for (const r of rs) {
    if (r <= 0) {
      streak++;
      if (streak > worstStreak) worstStreak = streak;
    } else streak = 0;
  }

  // Cumulative-R drawdown.
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rs) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const sorted = [...rs].sort((a, b) => a - b);
  const tailCount = Math.max(1, Math.floor(sorted.length * 0.05));
  const cvar5 = Math.abs(mean(sorted.slice(0, tailCount)));

  const m = mean(rs);
  const sd = stdev(rs);
  return {
    trades: records.length,
    hitRate: wins.length / records.length,
    meanR: m,
    meanRStdErr: records.length > 0 ? sd / Math.sqrt(records.length) : 0,
    rStdDev: sd,
    cvar5R: cvar5,
    bestR: Math.max(...rs),
    worstR: Math.min(...rs),
    profitFactor: grossLoss === 0 ? (gross > 0 ? Infinity : 0) : gross / grossLoss,
    longestLosingStreak: worstStreak,
    maxDrawdownR: maxDd,
    meanMaeR: mean(records.map((r) => r.maeR)),
    meanMfeR: mean(records.map((r) => r.mfeR)),
    meanBars: mean(records.map((r) => r.bars)),
  };
}

/**
 * Lower confidence bound of the mean R, at a chosen level.
 *
 * The rollout's Phase-3 rule is "lower-80% bound of mean R > 0", so the
 * estimator is a first-class metric rather than something recomputed by hand
 * at each review.
 */
export function lowerBoundMeanR(stats: TradeStats, z = 0.8416): number {
  return stats.meanR - z * stats.meanRStdErr;
}

// ── Sharpe, PSR, DSR ────────────────────────────────────────────────────────

/** Sharpe ratio of a return series at the given observation frequency. */
export function sharpeRatio(returns: number[]): number {
  const sd = stdev(returns);
  if (sd === 0) return 0;
  return mean(returns) / sd;
}

/** Skewness (γ3) and kurtosis (γ4) — the corrections PSR needs. */
export function moments(returns: number[]): { skew: number; kurtosis: number } {
  const n = returns.length;
  if (n < 3) return { skew: 0, kurtosis: 3 };
  const m = mean(returns);
  const sd = stdev(returns);
  if (sd === 0) return { skew: 0, kurtosis: 3 };
  let s3 = 0;
  let s4 = 0;
  for (const r of returns) {
    const z = (r - m) / sd;
    s3 += z * z * z;
    s4 += z * z * z * z;
  }
  return { skew: s3 / n, kurtosis: s4 / n };
}

/**
 * Probabilistic Sharpe Ratio (Bailey & López de Prado).
 *
 * The probability that the TRUE Sharpe ratio exceeds `benchmark` given the
 * observed series — i.e. it prices the sampling error of the Sharpe estimate
 * and its non-normality (skew and fat tails), which a plain ratio does not.
 */
export function probabilisticSharpeRatio(returns: number[], benchmark = 0): number {
  const n = returns.length;
  if (n < 3) return 0;
  const sr = sharpeRatio(returns);
  const { skew, kurtosis } = moments(returns);
  const denominator = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurtosis - 1) / 4) * sr * sr));
  return normalCdf(((sr - benchmark) * Math.sqrt(n - 1)) / denominator);
}

/**
 * Deflated Sharpe Ratio.
 *
 * The same probability, but with the benchmark raised to the expected maximum
 * Sharpe of `trials` independent configurations that are truly worthless. This
 * is the number that answers "could my best-of-N have come from luck alone?" —
 * and it is why the harness reports how many configurations were tried.
 */
export function deflatedSharpeRatio(returns: number[], trials: number): number {
  const n = returns.length;
  if (n < 3) return 0;
  if (trials <= 1) return probabilisticSharpeRatio(returns, 0);
  const sr = sharpeRatio(returns);
  // Variance of the Sharpe estimator across trials (1 observation per trial
  // is unknown, so the standard i.i.d. approximation is used and STATED).
  const srVariance = (1 + 0.5 * sr * sr) / Math.max(1, n - 1);
  const srSd = Math.sqrt(srVariance);
  const euler = 0.5772156649015329;
  const e = Math.E;
  // Expected max of `trials` standard normals (Gumbel approximation).
  const z1 = inverseNormalCdf(1 - 1 / trials);
  const z2 = inverseNormalCdf(1 - 1 / (trials * e));
  const expectedMax = srSd * ((1 - euler) * z1 + euler * z2);
  return probabilisticSharpeRatio(returns, expectedMax);
}

/**
 * Probability of Backtest Overfitting via Combinatorial Purged CV.
 *
 * Split the timeline into `groups` contiguous blocks; for every choice of
 * `testGroups` blocks as the out-of-sample set, pick the configuration with the
 * best in-sample mean R and record its rank out-of-sample. PBO is the fraction
 * of splits where the in-sample winner lands below the out-of-sample median —
 * i.e. how often "the best backtest" is not the best strategy.
 */
export function probabilityOfBacktestOverfitting(input: {
  /** returnsByConfig[c][t] — one series per configuration, aligned in time. */
  returnsByConfig: number[][];
  groups?: number;
  testGroups?: number;
}): { pbo: number; splits: number } {
  const series = input.returnsByConfig.filter((s) => s.length > 0);
  if (series.length < 2) return { pbo: 0, splits: 0 };
  const n = Math.min(...series.map((s) => s.length));
  const groups = input.groups ?? 6;
  const testGroups = input.testGroups ?? 2;
  if (n < groups * 3) return { pbo: 0, splits: 0 };

  const blockBounds: [number, number][] = [];
  const size = Math.floor(n / groups);
  for (let g = 0; g < groups; g++) {
    blockBounds.push([g * size, g === groups - 1 ? n : (g + 1) * size]);
  }
  const combinations = combinationsOf(groups, testGroups);
  let belowMedian = 0;
  let counted = 0;
  for (const test of combinations) {
    const testSet = new Set(test);
    const trainIdx: number[] = [];
    const testIdx: number[] = [];
    for (let g = 0; g < groups; g++) {
      const [from, to] = blockBounds[g] as [number, number];
      for (let i = from; i < to; i++) (testSet.has(g) ? testIdx : trainIdx).push(i);
    }
    if (trainIdx.length < 5 || testIdx.length < 5) continue;
    const inSample = series.map((s) => mean(trainIdx.map((i) => s[i] as number)));
    const outSample = series.map((s) => mean(testIdx.map((i) => s[i] as number)));
    const winner = inSample.indexOf(Math.max(...inSample));
    const winnerOos = outSample[winner] as number;
    const sortedOos = [...outSample].sort((a, b) => a - b);
    // The median of an EVEN sample is the midpoint of the two central values.
    // Taking the upper one instead makes a two-configuration study compare the
    // winner against itself, which reports PBO = 1 for every configuration set.
    const mid = sortedOos.length >> 1;
    const median =
      sortedOos.length % 2 === 1
        ? (sortedOos[mid] as number)
        : (((sortedOos[mid - 1] as number) + (sortedOos[mid] as number)) / 2);
    counted++;
    if (winnerOos <= median) belowMedian++;
  }
  return { pbo: counted === 0 ? 0 : belowMedian / counted, splits: counted };
}

function combinationsOf(n: number, k: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, acc: number[]): void => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < n; i++) {
      acc.push(i);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

// ── Calibration ─────────────────────────────────────────────────────────────

export interface CalibrationReport {
  samples: number;
  /** Brier score (mean squared error of the probability forecasts). */
  brier: number;
  /** Brier skill against the base rate: 1 = perfect, 0 = no better than the base rate. */
  brierSkill: number;
  /** Slope of the logistic regression of outcome on logit(prediction). 1.0 = calibrated. */
  reliabilitySlope: number;
  /** Intercept of the same regression; 0 is calibrated. */
  reliabilityIntercept: number;
  /** Reliability curve data: [predictedMid, observedFrequency, count]. */
  bins: [number, number, number][];
  /**
   * Whether the slope can be estimated at all.
   *
   * A reliability slope is only meaningful when the forecasts VARY: if every
   * prediction is 0.18, the regression has no information about its own slope
   * and Newton's method happily returns 128,120 — a number that looks precise
   * and means nothing. When the spread of the logits is negligible the slope is
   * reported as unidentifiable (and the gate fails, because "we could not
   * measure it" is not "it is calibrated").
   */
  slopeIdentifiable: boolean;
  /** Standard deviation of the predicted logits — the slope's information. */
  logitStdDev: number;
}

/**
 * Reliability of predicted probabilities.
 *
 * `slope` is fitted by regressing the outcome on the LOGIT of the prediction
 * (the standard Murphy decomposition): a slope below 1 means the model is
 * over-confident (its probabilities are too extreme), above 1 means it is
 * under-confident. The acceptance band is [0.8, 1.2].
 */
export function calibrationReport(samples: { p: number; outcome: 0 | 1 }[]): CalibrationReport {
  const n = samples.length;
  if (n === 0) {
    return {
      samples: 0,
      brier: 0,
      brierSkill: 0,
      reliabilitySlope: 0,
      reliabilityIntercept: 0,
      bins: [],
      slopeIdentifiable: false,
      logitStdDev: 0,
    };
  }
  const base = mean(samples.map((s) => s.outcome));
  const brier = mean(samples.map((s) => (s.p - s.outcome) ** 2));
  const baseBrier = mean(samples.map((s) => (base - s.outcome) ** 2));
  const brierSkill = baseBrier === 0 ? 0 : 1 - brier / baseBrier;

  // Logistic regression of outcome on logit(p): two parameters, Newton steps.
  const epsilon = 1e-6;
  const xs = samples.map((s) => Math.log(clampProbability(s.p) / (1 - clampProbability(s.p))));
  const logitStdDev = stdev(xs);
  // Below this, the logits carry essentially no information about the slope.
  const slopeIdentifiable = logitStdDev > 0.05;
  let a = 0;
  let b = 1;
  for (let iter = 0; iter < 25; iter++) {
    let g0 = 0;
    let g1 = 0;
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[i] as number;
      const y = samples[i]?.outcome ?? 0;
      const z = a + b * x;
      const p = 1 / (1 + Math.exp(-z));
      const w = Math.max(epsilon, p * (1 - p));
      const residual = y - p;
      g0 += residual;
      g1 += residual * x;
      h00 += w;
      h01 += w * x;
      h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a += da;
    b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }

  const bins: [number, number, number][] = [];
  const binCount = 10;
  for (let i = 0; i < binCount; i++) {
    const lo = i / binCount;
    const hi = (i + 1) / binCount;
    const inBin = samples.filter((s) => s.p >= lo && (i === binCount - 1 ? s.p <= hi : s.p < hi));
    if (inBin.length === 0) continue;
    bins.push([(lo + hi) / 2, mean(inBin.map((s) => s.outcome)), inBin.length]);
  }

  return {
    samples: n,
    brier,
    brierSkill,
    reliabilitySlope: b,
    reliabilityIntercept: a,
    bins,
    slopeIdentifiable,
    logitStdDev,
  };
}

function clampProbability(p: number): number {
  return Math.min(1 - 1e-9, Math.max(1e-9, p));
}

// ── Normal distribution helpers (no dependencies) ────────────────────────────

/** Standard normal CDF via the Abramowitz–Stegun 26.2.17 rational fit. */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  // Coefficients of the classic Acklam approximation (relative error < 1.15e-9).
  const a1 = -3.969683028665376e1, a2 = 2.209460984245205e2, a3 = -2.759285104469687e2;
  const a4 = 1.38357751867269e2, a5 = -3.066479806614716e1, a6 = 2.506628277459239;
  const b1 = -5.447609879822406e1, b2 = 1.615858368580409e2, b3 = -1.556989798598866e2;
  const b4 = 6.680131188771972e1, b5 = -1.328068155288572e1;
  const c1 = -7.784894002430293e-3, c2 = -3.223964580411365e-1, c3 = -2.400758277161838;
  const c4 = -2.549732539343734, c5 = 4.374664141464968, c6 = 2.938163982698783;
  const d1 = 7.784695709041462e-3, d2 = 3.224671290700398e-1, d3 = 2.445134137142996, d4 = 3.754408661907416;
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) / ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) / ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
}
