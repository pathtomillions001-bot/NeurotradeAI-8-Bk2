/**
 * Multi-Asset Desk — quantitative analytics toolkit.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The Desk used to lean on a single estimator (a 5-state Markov chain) as a
 * hard veto. One model, one number, one gate: whenever that estimator was
 * unsure — which is most of the time on noisy intraday data — the whole
 * pipeline refused to trade. That is analysis paralysis expressed in code.
 *
 * This module supplies the rest of the quantitative toolbox so the agent can
 * *weigh* several weakly-correlated estimators instead of obeying one of
 * them. Every function here is:
 *
 *   - pure and dependency-free (no external maths library);
 *   - deterministic (the same series always yields the same number);
 *   - defensive about tiny samples — it returns a neutral value plus a
 *     `reliability` / `n` figure rather than a confident-looking guess.
 *
 * The families, and what each one is actually good at:
 *
 *   1. Persistence / memory — Hurst exponent (R/S), variance ratio
 *      (Lo–MacKinlay), lag-1 autocorrelation, Ljung–Box. Answers "is this
 *      move likely to continue, or is it noise that will snap back?"
 *   2. Mean reversion — Ornstein–Uhlenbeck fit (θ, μ, σ, half-life, z).
 *      Answers "is price stretched, and how fast does it normally snap back?"
 *      Only trustworthy when the same series is *not* trending (Hurst < 0.5).
 *   3. Distribution shape — skew, excess kurtosis. Fat tails and asymmetry
 *      break any model that assumes normality, so they are measured, not
 *      assumed, and they widen the Monte Carlo's view of risk.
 *   4. Information / noise — Shannon entropy of discretised returns, Kaufman
 *      efficiency ratio. A market with no structure produces no signal; low
 *      entropy means the little structure there is can be trusted more.
 *   5. Flow — volume-weighted money flow (an MFI built from OHLCV, the only
 *      flow proxy an MT5 candle feed gives us) and close-location value.
 *   6. Trend estimation — a scalar Kalman filter, which tracks a drifting
 *      level without the lag an SMA carries or the whipsaw a short EMA does.
 *   7. Inference — Beta–Binomial posteriors (Bayesian win rate with a prior)
 *      and Wilson intervals. With 6 historical trades a raw 83% win rate is
 *      not evidence of anything; the posterior shrinks it toward the prior.
 *   8. Volatility — GARCH(1,1) one-step-ahead sigma, for stops and targets
 *      that respect volatility clustering.
 *
 * Nothing here is a signal on its own. They are inputs to `evidence.ts`,
 * which votes.
 */

import { clamp, logReturns, mean, stdev } from "./math";
import type { Bar } from "./types";

export const OPEN = 1;
export const HIGH = 2;
export const LOW = 3;
export const CLOSE = 4;
export const VOLUME = 5;

// ── Probability helpers ──────────────────────────────────────────────────────

/** Abramowitz & Stegun 26.2.17 normal CDF — |error| < 7.5e-8. */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

/** Two-sided p-value of a z statistic. */
export function twoSidedP(z: number): number {
  return clamp(2 * (1 - normalCdf(Math.abs(z))), 0, 1);
}

// ── Distribution shape ───────────────────────────────────────────────────────

/** Sample skewness (Fisher–Pearson, adjusted). 0 with fewer than 3 points. */
export function skewness(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const m = mean(values);
  const sd = stdev(values);
  if (sd === 0) return 0;
  let acc = 0;
  for (const v of values) acc += ((v - m) / sd) ** 3;
  return (n / ((n - 1) * (n - 2))) * acc;
}

/** Excess kurtosis (normal = 0). 0 with fewer than 4 points. */
export function excessKurtosis(values: number[]): number {
  const n = values.length;
  if (n < 4) return 0;
  const m = mean(values);
  const sd = stdev(values);
  if (sd === 0) return 0;
  let acc = 0;
  for (const v of values) acc += ((v - m) / sd) ** 4;
  const g2 = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * acc;
  return g2 - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}

// ── Persistence / memory ─────────────────────────────────────────────────────

/**
 * Hurst exponent by rescaled-range (R/S) analysis.
 *
 *   H > 0.55 → persistent, trend-following structure
 *   H ≈ 0.50 → random walk, no memory worth trading
 *   H < 0.45 → anti-persistent, mean-reverting structure
 *
 * Estimated from log-log regression of R/S against lag over several dyadic
 * sub-samples, which is far more stable on short windows than a single lag.
 *
 * Returns 0.5 (the random-walk default) whenever the sample is too small to
 * argue with, and reports `reliability` so callers can discount it.
 */
export function hurstExponent(
  values: number[],
  minLag = 8,
  maxLag = 0,
): { H: number; reliability: number; lags: number } {
  const n = values.length;
  const upper = maxLag > 0 ? Math.min(maxLag, Math.floor(n / 2)) : Math.floor(n / 2);
  if (n < 4 * minLag || upper <= minLag) return { H: 0.5, reliability: 0, lags: 0 };

  const rets = logReturns(values).filter((r) => Number.isFinite(r));
  if (rets.length < 4 * minLag) return { H: 0.5, reliability: 0, lags: 0 };

  const points: { x: number; y: number }[] = [];
  for (let lag = minLag; lag <= upper; lag = Math.max(lag + 1, Math.round(lag * 1.6))) {
    const rsValues: number[] = [];
    for (let start = 0; start + lag <= rets.length; start += lag) {
      const window = rets.slice(start, start + lag);
      const m = mean(window);
      let cumulative = 0;
      let minDev = Number.POSITIVE_INFINITY;
      let maxDev = Number.NEGATIVE_INFINITY;
      for (const r of window) {
        cumulative += r - m;
        if (cumulative < minDev) minDev = cumulative;
        if (cumulative > maxDev) maxDev = cumulative;
      }
      const range = maxDev - minDev;
      const sd = stdev(window);
      if (sd > 0 && range > 0) rsValues.push(range / sd);
    }
    if (rsValues.length === 0) continue;
    // Mean of log(R/S) is less sensitive to a single freak window than the
    // log of the mean, which is the classic small-sample failure of R/S.
    const logMean = mean(rsValues.map((v) => Math.log(v)));
    points.push({ x: Math.log(lag), y: logMean });
  }

  if (points.length < 3) return { H: 0.5, reliability: 0, lags: 0 };

  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of points) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  }
  if (sxx === 0) return { H: 0.5, reliability: 0, lags: points.length };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : clamp((sxy * sxy) / (sxx * syy), 0, 1);

  return {
    H: clamp(slope, 0, 1),
    // Fit quality and sample depth both gate how much this number is worth.
    reliability: clamp(r2 * Math.min(1, rets.length / 200), 0, 1),
    lags: points.length,
  };
}

/**
 * Lo–MacKinlay variance-ratio test at lag `q`.
 *
 * For a random walk, variance scales linearly with horizon, so Var(q-period
 * returns) / (q · Var(1-period returns)) = 1.
 *
 *   ratio > 1 → trending / persistent (momentum works)
 *   ratio < 1 → mean-reverting (fading works)
 *
 * `z` is the heteroskedasticity-robust statistic; |z| > 1.96 is the usual
 * 5% rejection of the random walk.
 */
export function varianceRatio(
  returns: number[],
  q = 4,
): { ratio: number; z: number; pValue: number } {
  const n = returns.length;
  if (n < 3 * q || q < 2) return { ratio: 1, z: 0, pValue: 1 };

  const mu = mean(returns);
  const centred = returns.map((r) => r - mu);

  let varOne = 0;
  for (const c of centred) varOne += c * c;
  varOne /= n - 1;
  if (varOne <= 0) return { ratio: 1, z: 0, pValue: 1 };

  // Variance of q-period sums, using Lo–MacKinlay's small-sample correction
  //   m = q·(n − q + 1)·(1 − q/n)
  // so the ratio is unbiased rather than merely asymptotically correct.
  let sumSquared = 0;
  for (let i = q - 1; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < q; j++) sum += returns[i - j];
    sumSquared += (sum - q * mu) ** 2;
  }
  const m = q * (n - q + 1) * (1 - q / n);
  const varQ = m === 0 ? 0 : sumSquared / m;

  const ratio = varQ / varOne;

  // Robust asymptotic variance of the ratio (Lo–MacKinlay, allowing
  // heteroskedasticity): sum over j<q of [2(q-j)/q]^2 · δ_j.
  let theta = 0;
  for (let j = 1; j < q; j++) {
    let delta = 0;
    for (let i = j; i < n; i++) {
      delta += (centred[i] * centred[i - j]) ** 2;
    }
    const denom = (n - 1) * varOne * varOne;
    delta = denom === 0 ? 0 : delta / denom;
    theta += ((2 * (q - j)) / q) ** 2 * delta;
  }

  const se = Math.sqrt(Math.max(theta, 1e-12));
  const z = (ratio - 1) / se;
  return { ratio, z, pValue: twoSidedP(z) };
}

/** Lag-1 autocorrelation of a series (Pearson). */
export function lag1Autocorrelation(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const m = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 1; i < n; i++) num += (values[i] - m) * (values[i - 1] - m);
  for (const v of values) den += (v - m) ** 2;
  return den === 0 ? 0 : clamp(num / den, -1, 1);
}

/** Ljung–Box Q statistic — "is there ANY structure in these lags?" */
export function ljungBox(returns: number[], lags = 10): { q: number; pValue: number } {
  const n = returns.length;
  if (n < lags + 2) return { q: 0, pValue: 1 };
  let sum = 0;
  for (let k = 1; k <= lags; k++) {
    const rho = autocorrelationAt(returns, k);
    sum += (rho * rho) / (n - k);
  }
  const q = n * (n + 2) * sum;
  // Chi-square with `lags` df: Wilson–Hilferty approximation to the p-value.
  const df = lags;
  const z = ((q / df) ** (1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return { q, pValue: clamp(1 - normalCdf(z), 0, 1) };
}

function autocorrelationAt(values: number[], lag: number): number {
  const n = values.length;
  if (n <= lag) return 0;
  const m = mean(values);
  let num = 0;
  let den = 0;
  for (let i = lag; i < n; i++) num += (values[i] - m) * (values[i - lag] - m);
  for (const v of values) den += (v - m) ** 2;
  return den === 0 ? 0 : num / den;
}

// ── Mean reversion ───────────────────────────────────────────────────────────

export interface OuFit {
  /** Mean-reversion speed θ (per bar). Higher = snaps back faster. */
  theta: number;
  /** Long-run mean μ. */
  mu: number;
  /** Residual standard deviation of the process. */
  sigma: number;
  /** Bars for a deviation to halve. Infinity when there is no reversion. */
  halfLife: number;
  /** Current (price − μ) / σ_eq — the OU z-score. */
  z: number;
  /** R² of the AR(1) regression: how well the OU story actually fits. */
  r2: number;
  /** True when the fit is usable (stable, enough data, real dispersion). */
  usable: boolean;
}

/**
 * Fit a discrete Ornstein–Uhlenbeck process to a price series.
 *
 *   X(t+1) − X(t) = a + b·X(t) + ε     ⇒     θ = −b,  μ = a/θ
 *
 * Equilibrium variance σ_eq² = σ_ε² / (1 − φ²) with φ = 1 + b, and
 * half-life = −ln(2) / ln(φ). The z-score is measured against σ_eq, not the
 * raw residual SD, so a fast-reverting series does not read as "stretched"
 * simply because its bars are small.
 *
 * The estimate is only meaningful when the series is genuinely mean-reverting
 * (Hurst < 0.5); callers must gate on that or they will short every uptrend.
 */
export function ouFit(values: number[]): OuFit {
  const n = values.length;
  const neutral: OuFit = {
    theta: 0,
    mu: n > 0 ? values[n - 1] : 0,
    sigma: 0,
    halfLife: Number.POSITIVE_INFINITY,
    z: 0,
    r2: 0,
    usable: false,
  };
  if (n < 30) return neutral;

  // Work on log price so the fit is scale-free across symbols.
  if (values.some((v) => !(v > 0))) return neutral;
  const x = values.map((v) => Math.log(v));

  let sx = 0;
  let sy = 0;
  for (let i = 1; i < n; i++) {
    sx += x[i - 1];
    sy += x[i] - x[i - 1];
  }
  const mx = sx / (n - 1);
  const my = sy / (n - 1);

  let sxy = 0;
  let sxx = 0;
  for (let i = 1; i < n; i++) {
    const dx = x[i - 1] - mx;
    sxy += dx * (x[i] - x[i - 1] - my);
    sxx += dx * dx;
  }
  if (sxx === 0) return neutral;
  const b = sxy / sxx;
  const a = my - b * mx;

  const phi = 1 + b;
  if (!(phi > 0) || !(phi < 1)) {
    // Not stationary: a random walk or an explosive process. Report the drift
    // direction but mark the mean-reversion reading unusable.
    return { ...neutral, mu: Math.exp(x[n - 1]), r2: 0 };
  }

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 1; i < n; i++) {
    const predicted = a + b * x[i - 1];
    const actual = x[i] - x[i - 1];
    ssRes += (actual - predicted) ** 2;
    ssTot += (actual - my) ** 2;
  }
  const sigmaEps = Math.sqrt(ssRes / Math.max(1, n - 3));
  const sigmaEq = Math.sqrt(Math.max(sigmaEps ** 2 / (1 - phi * phi), 1e-18));
  const theta = -b;
  const mu = a / theta;
  const z = (x[n - 1] - mu) / sigmaEq;

  return {
    theta,
    mu: Math.exp(mu),
    sigma: sigmaEq,
    halfLife: Math.log(2) / theta,
    z: clamp(z, -6, 6),
    r2: ssTot === 0 ? 0 : clamp(1 - ssRes / ssTot, 0, 1),
    usable: theta > 0 && sigmaEq > 0,
  };
}

// ── Information / noise ──────────────────────────────────────────────────────

/**
 * Shannon entropy (bits) of the return distribution, discretised into `bins`
 * quantile buckets. `maxEntropy` is log2(bins).
 *
 * High normalised entropy ≈ 1 means the returns carry almost no information
 * (a coin flip); low values mean the distribution is concentrated and the
 * little structure that exists is more likely to be real.
 */
export function shannonEntropy(values: number[], bins = 8): { bits: number; normalised: number } {
  const n = values.length;
  const maxBits = Math.log2(bins);
  if (n < bins * 4) return { bits: maxBits, normalised: 1 };

  const sorted = [...values].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let i = 1; i < bins; i++) edges.push(sorted[Math.floor((i * n) / bins)]);

  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    let bucket = 0;
    while (bucket < edges.length && v >= edges[bucket]) bucket++;
    counts[bucket]++;
  }

  let bits = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / n;
    bits -= p * Math.log2(p);
  }
  return { bits, normalised: clamp(bits / maxBits, 0, 1) };
}

/**
 * Kaufman efficiency ratio: net displacement / sum of absolute steps.
 *
 * 1.0 is a straight line, 0.0 is pure chop. It is the cleanest single
 * discriminator between "there is a trend here" and "this is noise".
 */
export function efficiencyRatio(values: number[], period = 20): number {
  const slice = values.slice(-Math.max(2, period));
  if (slice.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < slice.length; i++) path += Math.abs(slice[i] - slice[i - 1]);
  if (path === 0) return 0;
  return clamp(Math.abs(slice[slice.length - 1] - slice[0]) / path, 0, 1);
}

// ── Flow ─────────────────────────────────────────────────────────────────────

/**
 * Volume-weighted money flow from OHLCV, normalised to [−1, +1].
 *
 * MT5 gives tick volume, not true order flow, so this is the honest proxy
 * available: each bar's close location within its range is weighted by that
 * bar's volume and compared against the average. Positive means closes have
 * been clustering at the top of the range on above-average participation.
 */
export function moneyFlow(bars: Bar[], period = 14): { value: number; strength: number } {
  if (bars.length < 3) return { value: 0, strength: 0 };
  const slice = bars.slice(-Math.max(4, period * 2));
  const typical: number[] = [];
  const clv: number[] = [];
  for (const bar of slice) {
    const high = bar[HIGH];
    const low = bar[LOW];
    const close = bar[CLOSE];
    const range = high - low;
    typical.push((high + low + close) / 3);
    clv.push(range > 0 ? ((close - low) - (high - close)) / range : 0);
  }

  const positiveFlow: number[] = [];
  const totalFlow: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const volume = Math.max(slice[i][VOLUME] ?? 0, 1);
    const direction = typical[i] >= typical[i - 1] ? 1 : -1;
    // Blend the bar's own close location with its direction: a bar that
    // closed high but below the previous typical price is not bullish flow.
    const signed = clv[i] * 0.5 + direction * 0.5;
    positiveFlow.push(signed > 0 ? signed * volume : 0);
    totalFlow.push(Math.abs(signed) * volume);
  }

  const window = Math.min(period, positiveFlow.length);
  const pos = positiveFlow.slice(-window).reduce((a, b) => a + b, 0);
  const total = totalFlow.slice(-window).reduce((a, b) => a + b, 0);
  if (total <= 0) return { value: 0, strength: 0 };
  const ratio = pos / total; // 0..1
  return {
    value: clamp(ratio * 2 - 1, -1, 1),
    strength: clamp(Math.abs(ratio - 0.5) * 2, 0, 1),
  };
}

// ── Trend estimation ─────────────────────────────────────────────────────────

export interface KalmanTrend {
  /** Filtered price level. */
  level: number;
  /** Estimated slope per bar, in price units. */
  slope: number;
  /** Slope expressed in ATR-normalised units — comparable across symbols. */
  normalisedSlope: number;
  /** Filter confidence in [0,1]: high when the model has converged. */
  confidence: number;
}

/**
 * Scalar (local-level) Kalman filter with a random-walk velocity term.
 *
 * Chosen over an SMA/EMA pair because it separates the two things a trend
 * follower actually needs — where price is *now* (level) and how fast it is
 * moving (slope) — without the lag of a long average or the noise of a short
 * one. Process noise is scaled by the series' own volatility so the same
 * constants behave sensibly on EURUSD and on XAUUSD.
 */
export function kalmanTrend(values: number[], atrValue: number): KalmanTrend {
  const n = values.length;
  if (n < 3) {
    return { level: values[n - 1] ?? 0, slope: 0, normalisedSlope: 0, confidence: 0 };
  }

  const rets = logReturns(values).filter((r) => Number.isFinite(r));
  const sigma = Math.max(stdev(rets), 1e-9);
  const priceScale = Math.max(values[n - 1], 1e-9);

  // Process/measurement noise ratio: a noisier series gets a slower filter.
  const q = sigma * sigma;
  const r = q * 4;

  let level = values[0];
  let slope = 0;
  let pLevel = 1;
  let pSlope = 1;
  let pCross = 0;

  for (let i = 1; i < n; i++) {
    // Predict
    level += slope;
    pLevel += 2 * pCross + pSlope + q;
    pCross += pSlope;
    pSlope += q * 0.25;

    // Update
    const innovation = values[i] - level;
    const s = pLevel + r;
    const kLevel = s === 0 ? 0 : pLevel / s;
    const kSlope = s === 0 ? 0 : pCross / s;

    level += kLevel * innovation;
    slope += kSlope * innovation;

    const newPLevel = pLevel - kLevel * pLevel;
    const newPCross = pCross - kLevel * pCross;
    const newPSlope = pSlope - kSlope * pCross;
    pLevel = Math.max(newPLevel, 1e-12);
    pCross = newPCross;
    pSlope = Math.max(newPSlope, 1e-12);
  }

  const normalised = atrValue > 0 ? slope / atrValue : slope / (priceScale * sigma);
  return {
    level,
    slope,
    normalisedSlope: clamp(normalised, -1, 1),
    // Confidence follows how much the filter has tightened up: a converged
    // filter has a small state variance relative to the observation noise.
    confidence: clamp(r / (r + pLevel), 0, 1),
  };
}

// ── Structure ────────────────────────────────────────────────────────────────

/** Where price sits inside the last `period` bars' range: 0 = at the low, 1 = at the high. */
export function rangePosition(bars: Bar[], period = 20): number {
  const slice = bars.slice(-Math.max(2, period));
  if (slice.length === 0) return 0.5;
  let high = -Infinity;
  let low = Infinity;
  for (const bar of slice) {
    if (bar[HIGH] > high) high = bar[HIGH];
    if (bar[LOW] < low) low = bar[LOW];
  }
  if (!(high > low)) return 0.5;
  const last = slice[slice.length - 1][CLOSE];
  return clamp((last - low) / (high - low), 0, 1);
}

/** Current ATR as a multiple of its own slow average — an expansion/compression gauge. */
export function volatilityExpansion(bars: Bar[], fast = 7, slow = 28): number {
  const fastAtr = averageTrueRange(bars, fast);
  const slowAtr = averageTrueRange(bars, slow);
  if (slowAtr <= 0) return 1;
  return clamp(fastAtr / slowAtr, 0, 5);
}

function averageTrueRange(bars: Bar[], period: number): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i][HIGH];
    const low = bars[i][LOW];
    const prevClose = bars[i - 1][CLOSE];
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const p = Math.min(period, trs.length);
  let acc = mean(trs.slice(0, p));
  for (let i = p; i < trs.length; i++) acc = (acc * (p - 1) + trs[i]) / p;
  return acc;
}

// ── Volatility forecasting ───────────────────────────────────────────────────

/**
 * GARCH(1,1) one-step-ahead volatility, estimated by variance targeting.
 *
 * Volatility clusters: sizing today's stop on last month's calm is how a
 * desk gets stopped out by an ordinary Tuesday. A long-run variance target
 * and a small set of fixed coefficients keeps the estimator stable on the
 * short samples a Desk actually has, unlike a full MLE fit.
 */
export function garchVolatility(returns: number[], omega = 0.05, alpha = 0.09): number {
  if (returns.length < 10) return stdev(returns);
  const beta = 1 - omega - alpha;
  if (beta <= 0 || beta >= 1) return stdev(returns);

  const longRunVariance = variance(returns);
  let varianceNow = longRunVariance;
  for (const r of returns) {
    varianceNow = omega * longRunVariance + alpha * r * r + beta * varianceNow;
  }
  return Math.sqrt(Math.max(varianceNow, 1e-18));
}

function variance(values: number[]): number {
  const s = stdev(values);
  return s * s;
}

// ── Bayesian inference ───────────────────────────────────────────────────────

export interface Posterior {
  /** Posterior mean of the win rate. */
  mean: number;
  /** Conservative lower bound (Wilson 5th percentile) — the number to size with. */
  lower: number;
  /** Posterior standard deviation — how much the estimate is still moving. */
  sd: number;
  /** Effective sample size: observations + prior weight. */
  weight: number;
}

/**
 * Beta–Binomial posterior for a win rate, with a conservative lower bound.
 *
 * Six trades at 5/1 is NOT an 83% strategy. With a Beta(priorWins,
 * priorLosses) prior the posterior mean is pulled toward the prior, and the
 * Wilson lower bound is what the Desk actually uses for sizing: it is the
 * win rate we can defend with the data we have.
 */
export function betaPosterior(
  wins: number,
  losses: number,
  priorWins = 4,
  priorLosses = 6,
): Posterior {
  const a = Math.max(0, wins) + priorWins;
  const b = Math.max(0, losses) + priorLosses;
  const n = a + b;
  const mean = a / n;
  const sd = Math.sqrt((a * b) / (n * n * (n + 1)));

  // Wilson score interval at ~95% (z = 1.96) on the posterior counts.
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = mean + (z * z) / (2 * n);
  const margin = z * Math.sqrt((mean * (1 - mean)) / n + (z * z) / (4 * n * n));
  const lower = clamp((centre - margin) / denom, 0, 1);

  return { mean, lower, sd, weight: n };
}

/** Blend a model probability with an empirical one, weighted by evidence. */
export function blendProbability(
  modelProbability: number,
  empirical: Posterior | null,
  empiricalWeight = 0.35,
): { probability: number; source: string } {
  if (!empirical || empirical.weight <= 0) {
    return { probability: clamp(modelProbability, 0, 1), source: "model" };
  }
  // Confidence in the empirical view grows with sample size, not with luck.
  const trust = clamp((empirical.weight - 8) / 40, 0, 1) * empiricalWeight;
  const blended = (1 - trust) * clamp(modelProbability, 0, 1) + trust * empirical.lower;
  return { probability: clamp(blended, 0, 1), source: trust > 0.02 ? "model+realised" : "model" };
}

// ── Performance statistics ───────────────────────────────────────────────────

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  avgR: number;
  /** Sum of wins / |sum of losses|. Infinity when nothing has lost. */
  profitFactor: number;
  /** Sharpe-like ratio of the R series (mean / sd), unannualised. */
  sharpeLike: number;
  /** Longest losing streak. */
  maxLosingStreak: number;
  /** Largest cumulative drawdown, in R. */
  maxDrawdownR: number;
}

export function performanceStats(rMultiples: number[]): PerformanceStats {
  const n = rMultiples.length;
  if (n === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalR: 0,
      avgR: 0,
      profitFactor: 0,
      sharpeLike: 0,
      maxLosingStreak: 0,
      maxDrawdownR: 0,
    };
  }

  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let streak = 0;
  let maxLosingStreak = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;

  for (const r of rMultiples) {
    if (r > 0) {
      wins++;
      grossWin += r;
      streak = 0;
    } else if (r < 0) {
      losses++;
      grossLoss += Math.abs(r);
      streak++;
      if (streak > maxLosingStreak) maxLosingStreak = streak;
    }
    equity += r;
    if (equity > peak) peak = equity;
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  const totalR = rMultiples.reduce((a, b) => a + b, 0);
  const sd = stdev(rMultiples);
  return {
    trades: n,
    wins,
    losses,
    winRate: wins / n,
    totalR,
    avgR: totalR / n,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Number.POSITIVE_INFINITY : 0) : grossWin / grossLoss,
    sharpeLike: sd === 0 ? 0 : (totalR / n) / sd,
    maxLosingStreak,
    maxDrawdownR,
  };
}
