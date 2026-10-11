/**
 * Desk v4 research harness — numerical primitives (WP2).
 *
 * Small, dependency-free, deterministic. Everything here is implemented in-repo
 * on purpose (constraint 1: no new heavy dependencies), and every function is
 * pure so a report can be regenerated bit-for-bit from the same inputs.
 *
 * The statistics that decide whether an edge is real live here rather than in
 * `metrics.ts`, because they are also used by the walk-forward engine and by
 * the null-hypothesis machinery:
 *
 *   • quantile / Φ⁻¹ — calibration bins, Deflated Sharpe
 *   • FFT phase randomisation — the phase-randomised null (generators.ts)
 *   • moving-block bootstrap — stationary block resampling of a return series
 *   • linear (and weighted-linear) regression — reliability slope
 *   • Probabilistic / Deflated Sharpe Ratio — Bailey & López de Prado
 *   • CSCV → Probability of Backtest Overfitting
 *
 * None of these may be tuned. They are estimators, not thresholds.
 */

import { normalCdf } from "../analytics";

// ── Basic descriptive statistics ─────────────────────────────────────────────

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function variance(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return acc / (n - 1);
}

export function stdev(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/**
 * Linear-interpolated quantile (type 7, the R/NumPy default).
 *
 * Interpolated rather than nearest-rank because the calibration bins are small
 * and a nearest-rank quantile would make the bin edges jump around as the
 * sample changes, which shows up as noise in the reliability plot.
 */
export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const clamped = Math.max(0, Math.min(1, q));
  const position = (sorted.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/** Sample skewness (γ3, the moment ratio, not the bias-corrected version). */
export function skewness(values: readonly number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const m = mean(values);
  const sd = stdev(values);
  if (sd === 0) return 0;
  let acc = 0;
  for (const v of values) acc += Math.pow((v - m) / sd, 3);
  return (n / ((n - 1) * (n - 2))) * acc;
}

/**
 * Sample excess kurtosis (γ4 − 3).
 *
 * The Sharpe-ratio machinery below needs the NON-excess kurtosis, so callers
 * add 3. Kept as excess here because that is how everyone reads a return
 * distribution, and hiding the convention behind a function name is how the
 * two get confused.
 */
export function excessKurtosis(values: readonly number[]): number {
  const n = values.length;
  if (n < 4) return 0;
  const m = mean(values);
  const sd = stdev(values);
  if (sd === 0) return 0;
  let acc = 0;
  for (const v of values) acc += Math.pow((v - m) / sd, 4);
  const term1 = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3));
  const term2 = (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return term1 * acc - term2;
}

/** Longest run of consecutive values satisfying `isLoss`. */
export function longestStreak<T>(values: readonly T[], isLoss: (value: T) => boolean): number {
  let best = 0;
  let current = 0;
  for (const value of values) {
    if (isLoss(value)) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

/**
 * Maximum drawdown of a cumulative series, returned as a POSITIVE number.
 *
 * `unit: "absolute"` reports the peak-to-trough difference in the series' own
 * units (R, for the research harness); `unit: "relative"` reports it as a
 * fraction of the running peak, which is what an equity-curve drawdown means.
 */
export function maxDrawdown(
  values: readonly number[],
  unit: "absolute" | "relative" = "absolute",
): number {
  let peak = values[0] ?? 0;
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    const drop = unit === "absolute" ? peak - value : peak > 0 ? (peak - value) / peak : 0;
    if (drop > worst) worst = drop;
  }
  return worst;
}

// ── Normal distribution helpers ──────────────────────────────────────────────

/**
 * Φ(x) — the standard normal CDF.
 *
 * Re-exported from `analytics.ts` rather than reimplemented: the desk already
 * has one, it is already tested, and a second copy is a second thing to get
 * wrong. (It was wrong here first: an inverted sign made every Probabilistic
 * Sharpe Ratio read 0.000, which is exactly the kind of bug a duplicated
 * helper invites.)
 */
export { normalCdf } from "../analytics";

/** Φ⁻¹(p) — the standard normal quantile (Acklam's rational approximation). */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/** Lower `q` Beta quantile for integer-ish shapes, via bisection on the CDF. */
export function betaQuantile(q: number, a: number, b: number): number {
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (regularisedBeta(mid, a, b) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Regularised incomplete beta I_x(a,b) — continued fraction (Lentz). */
export function regularisedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - logBeta);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
    if (m === 200) break;
  }
  return h;
}

/** Lanczos log-gamma. */
export function logGamma(x: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += coefficients[j]! / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// ── Regression ───────────────────────────────────────────────────────────────

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination, in [0,1]. 0 when the fit explains nothing. */
  r2: number;
  n: number;
}

/**
 * Weighted least squares of `y` on `x` (weights default to 1).
 *
 * Used for the reliability slope, where each calibration bin contributes a
 * different number of observations and an unweighted fit would let a bin with
 * three trades count as much as one with three hundred.
 */
export function weightedLinearFit(
  xs: readonly number[],
  ys: readonly number[],
  weights?: readonly number[],
): LinearFit {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0, n };
  const w = weights ?? xs.map(() => 1);
  let sw = 0;
  let swx = 0;
  let swy = 0;
  for (let i = 0; i < n; i++) {
    sw += w[i]!;
    swx += w[i]! * xs[i]!;
    swy += w[i]! * ys[i]!;
  }
  if (sw === 0) return { slope: 0, intercept: 0, r2: 0, n };
  const mx = swx / sw;
  const my = swy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += w[i]! * (xs[i]! - mx) * (xs[i]! - mx);
    sxy += w[i]! * (xs[i]! - mx) * (ys[i]! - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i]! + intercept;
    ssRes += w[i]! * (ys[i]! - pred) * (ys[i]! - pred);
    ssTot += w[i]! * (ys[i]! - my) * (ys[i]! - my);
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, Math.min(1, 1 - ssRes / ssTot));
  return { slope, intercept, r2, n };
}

/** Ordinary least squares — the unweighted special case. */
export function linearFit(xs: readonly number[], ys: readonly number[]): LinearFit {
  return weightedLinearFit(xs, ys);
}

// ── FFT (radix-2, in-place on complex pairs) ─────────────────────────────────

/**
 * In-place iterative Cooley–Tukey FFT. `re`/`im` must have a power-of-two
 * length. Sign convention: `inverse = false` computes the forward transform
 * with the e^{-i2πkn/N} kernel.
 *
 * Implemented here rather than pulled in because it has exactly one consumer
 * (phase randomisation) and a dependency for 40 lines of arithmetic is not a
 * trade worth making.
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of two`);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;
        const vRe = re[i + k + len / 2]! * curRe - im[i + k + len / 2]! * curIm;
        const vIm = re[i + k + len / 2]! * curIm + im[i + k + len / 2]! * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Smallest power of two ≥ n. */
export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ── Resampling ───────────────────────────────────────────────────────────────

/**
 * Stationary block-bootstrap index sample (Politis & Romano).
 *
 * Geometric block lengths with the given mean, wrapped around the end of the
 * series. I.i.d. resampling destroys volatility clustering, which is the one
 * stylised fact of returns that matters most for a stop-loss policy: an i.i.d.
 * bootstrap produces far too few long quiet stretches and far too few violent
 * ones, and a trailing stop's realised R depends on exactly that.
 */
export function stationaryBootstrapIndices(
  n: number,
  meanBlock: number,
  rng: () => number,
): number[] {
  if (n <= 0) return [];
  const p = 1 / Math.max(1, meanBlock);
  const out: number[] = new Array(n);
  let i = 0;
  while (i < n) {
    const start = Math.floor(rng() * n);
    let length = 1;
    while (rng() > p) length += 1;
    for (let k = 0; k < length && i < n; k++, i++) out[i] = (start + k) % n;
  }
  return out;
}

/**
 * Circular block-bootstrap index sample with FIXED block length.
 *
 * Provided alongside the stationary variant because the two give different
 * null distributions for a strategy whose edge decays with the horizon: fixed
 * blocks keep a fixed amount of local structure, stationary blocks sometimes
 * draw a single very long block and sometimes a string of singletons.
 */
export function blockBootstrapIndices(n: number, blockLength: number, rng: () => number): number[] {
  if (n <= 0) return [];
  const block = Math.max(1, Math.floor(blockLength));
  const out: number[] = [];
  while (out.length < n) {
    const start = Math.floor(rng() * n);
    for (let k = 0; k < block && out.length < n; k++) out.push((start + k) % n);
  }
  return out;
}

// ── Sharpe-ratio inference (Bailey & López de Prado) ─────────────────────────

/**
 * Annualisation-free per-observation Sharpe ratio.
 *
 * Reported as a per-observation figure throughout, because the research
 * harness compares R-multiples per trade rather than calendar returns and any
 * annualisation constant would be arbitrary.
 */
export function sharpeRatio(returns: readonly number[]): number {
  const sd = stdev(returns);
  if (sd === 0 || returns.length < 2) return 0;
  return mean(returns) / sd;
}

/**
 * Probabilistic Sharpe Ratio: P(true SR > benchmarkSR), accounting for
 * skewness and fat tails.
 *
 *   PSR(SR*) = Φ( (SR − SR*)·√(n−1) / √(1 − γ3·SR + ((γ4−1)/4)·SR²) )
 *
 * The textbook t-statistic assumes normal returns; a 1:2 strategy's R
 * distribution is strongly right-skewed and this correction is the difference
 * between calling a lucky tail "significant" and not.
 */
export function probabilisticSharpeRatio(returns: readonly number[], benchmarkSr = 0): number {
  const n = returns.length;
  if (n < 3) return 0;
  const sr = sharpeRatio(returns);
  const g3 = skewness(returns);
  // Non-excess kurtosis for the denominator.
  const g4 = excessKurtosis(returns) + 3;
  const denominator = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  if (denominator <= 0) return 0;
  const z = ((sr - benchmarkSr) * Math.sqrt(n - 1)) / Math.sqrt(denominator);
  return normalCdf(z);
}

/**
 * Expected maximum Sharpe across `trials` independent null strategies.
 *
 * This is the deflation benchmark: if you tried N configurations, the best one
 * looks good even when nothing has edge, and DSR asks whether the observed
 * Sharpe exceeds what searching alone would have produced.
 */
export function expectedMaxSharpe(trials: number, srStdDev: number, eulerGamma = 0.5772156649): number {
  if (trials <= 1 || srStdDev <= 0) return 0;
  const e = Math.E;
  return (
    srStdDev *
    ((1 - eulerGamma) * normalInv(1 - 1 / trials) + eulerGamma * normalInv(1 - 1 / (trials * e)))
  );
}

/**
 * Deflated Sharpe Ratio: the PSR evaluated against the expected best-of-N
 * benchmark rather than against zero.
 *
 * `trials` must be the honest number of configurations actually searched —
 * including the ones that were discarded. Understating it is the single
 * easiest way to manufacture a false positive, so the harness records the
 * trial count it used in every report.
 */
export function deflatedSharpeRatio(returns: readonly number[], trials: number): number {
  const n = returns.length;
  if (n < 3) return 0;
  if (trials <= 1) return probabilisticSharpeRatio(returns, 0);
  // Standard error of a per-observation Sharpe estimate is √((1+SR²/2)/(n−1)),
  // which is the dispersion the max-of-N search is drawn from.
  const sr = sharpeRatio(returns);
  const srStdDev = Math.sqrt((1 + (sr * sr) / 2) / (n - 1));
  const benchmark = expectedMaxSharpe(trials, srStdDev);
  return probabilisticSharpeRatio(returns, benchmark);
}

// ── CSCV → probability of backtest overfitting ───────────────────────────────

export interface PboResult {
  /** Fraction of CSCV splits in which the in-sample best ranks below median OOS. */
  pbo: number;
  /** Number of combinations evaluated. */
  combinations: number;
  /** Out-of-sample rank logits, for the overfitting histogram. */
  logits: number[];
}

/**
 * Probability of Backtest Overfitting via Combinatorially Symmetric
 * Cross-Validation (Bailey, Borwein, López de Prado & Zhu).
 *
 * Input is a matrix `performance[observation][configuration]`. The series is
 * split into `groups` contiguous slices; every combination of half the slices
 * forms an in-sample set, its complement the out-of-sample set. The
 * configuration that wins in-sample is then ranked out-of-sample: if it
 * systematically lands below the median, the "winner" was noise selected by
 * the split, which is precisely what overfitting means.
 *
 * Returns PBO = 1 when no split is possible (fewer than 2 groups or a single
 * configuration), because a single configuration cannot be shown to be free of
 * selection bias by this method and reporting 0 would be a false all-clear.
 */
export function probabilityOfBacktestOverfitting(
  performance: readonly (readonly number[])[],
  groups = 8,
): PboResult {
  const observations = performance.length;
  const configs = performance[0]?.length ?? 0;
  const evenGroups = groups % 2 === 0 ? groups : groups + 1;
  if (observations < evenGroups || configs < 2 || evenGroups < 4) {
    return { pbo: 1, combinations: 0, logits: [] };
  }

  const groupSize = Math.floor(observations / evenGroups);
  const slices: number[][] = [];
  for (let g = 0; g < evenGroups; g++) {
    const from = g * groupSize;
    const to = g === evenGroups - 1 ? observations : from + groupSize;
    const indices: number[] = [];
    for (let i = from; i < to; i++) indices.push(i);
    slices.push(indices);
  }

  const half = evenGroups / 2;
  const logits: number[] = [];
  let count = 0;

  const combinations = chooseIndices(evenGroups, half);
  for (const inSampleGroups of combinations) {
    const inSample = new Set(inSampleGroups);
    const isIndices: number[] = [];
    const oosIndices: number[] = [];
    for (let g = 0; g < evenGroups; g++) {
      (inSample.has(g) ? isIndices : oosIndices).push(...slices[g]!);
    }

    const inSampleScore = new Array<number>(configs);
    const oosScore = new Array<number>(configs);
    for (let c = 0; c < configs; c++) {
      inSampleScore[c] = mean(isIndices.map((i) => performance[i]![c]!));
      oosScore[c] = mean(oosIndices.map((i) => performance[i]![c]!));
    }

    let best = 0;
    for (let c = 1; c < configs; c++) {
      if (inSampleScore[c]! > inSampleScore[best]!) best = c;
    }

    const oosBest = oosScore[best]!;
    let below = 0;
    for (let c = 0; c < configs; c++) if (oosScore[c]! < oosBest) below += 1;
    // Relative rank in (0,1); the +1 avoids log(0) on a tie for worst.
    const omega = (below + 1) / (configs + 1);
    logits.push(Math.log(omega / (1 - omega)));
    count += 1;
  }

  const overfits = logits.filter((value) => value < 0).length;
  return { pbo: count === 0 ? 1 : overfits / count, combinations: count, logits };
}

/** All size-`k` index combinations of `n` items, lexicographic. */
export function chooseIndices(n: number, k: number): number[][] {
  const out: number[][] = [];
  const current: number[] = [];
  const walk = (start: number) => {
    if (current.length === k) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < n; i++) {
      current.push(i);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}

/**
 * Purged & embargoed indicator of which observations may be used for training
 * given a test block.
 *
 * Exposed here (rather than only inside the walk-forward engine) because both
 * the meta-model's folds and the harness's CPCV need the same rule, and two
 * implementations of "purge" would eventually disagree.
 */
export function purgeIndices(input: {
  total: number;
  testStart: number;
  testEnd: number;
  embargo: number;
  /** Label horizon, in observations, that leaks forward from train rows. */
  horizon: number;
}): number[] {
  const { total, testStart, testEnd, embargo, horizon } = input;
  const keep: number[] = [];
  for (let i = 0; i < total; i++) {
    // Drop anything whose label window overlaps the test block...
    const labelEnd = i + horizon;
    const overlapsTest = labelEnd >= testStart && i <= testEnd;
    // ...and anything inside the embargo immediately after the test block.
    const insideEmbargo = i > testEnd && i <= testEnd + embargo;
    if (!overlapsTest && !insideEmbargo) keep.push(i);
  }
  return keep;
}
