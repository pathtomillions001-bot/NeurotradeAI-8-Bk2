/**
 * WP3 — Bayesian online change-point detection (BOCPD).
 *
 * ── WHAT IT ANSWERS, AND WHY THE ANSWER IS A PROBABILITY ────────────────────
 *
 * Every regime model has the same failure mode: it is most confident about the
 * state of the world exactly when the world is about to change. A 3-state HMM
 * that has fitted a comfortable up-trend reports 97% "trend up" on the bar
 * before the reversal, and the desk sizes its largest trade on it.
 *
 * The usual patch — a fixed lookback window, or "wait for confirmation bars" —
 * replaces the problem with a different one: the lag is constant, so it is too
 * slow at real changes and needlessly slow inside a stable regime.
 *
 * This module answers a single, narrow question in probability form:
 *
 *     "how likely is it that the process changed within the last N bars?"
 *
 * …and the regime agent refuses a trade when that probability is high. It does
 * not predict the change, it does not need to: it only has to notice that the
 * old model's evidence no longer applies.
 *
 * ── THE MODEL (Adams & MacKay, 2007) ────────────────────────────────────────
 *
 * Under the assumption that change points occur with constant hazard `1/H`
 * (H = expected run length), the posterior over the current RUN LENGTH — how
 * many consecutive observations share the current parameters — is updated
 * exactly, one observation at a time, by Bayes:
 *
 *     P(r_t = 0)      ∝ h · Σ_{r} P(r_{t−1} = r) · π(x_t | r)
 *     P(r_t = r + 1)  ∝ (1 − h) · P(r_{t−1} = r) · π(x_t | r)
 *
 * where π(x | r) is the predictive probability of the new observation under the
 * parameters inferred from those r observations. The observation model here is
 * a Normal with unknown mean AND unknown variance under a Normal–Inverse-Gamma
 * prior, which makes the predictive a Student-t: the honest choice for returns,
 * whose variance changes at least as often as their mean.
 *
 * The output is the full posterior over run length. `changeProbability` sums
 * the mass on short run lengths — that is the probability that a change
 * happened recently — and the regime agent treats it as a veto.
 *
 * Everything is computed in LOG space with an explicit log-sum-exp, because a
 * run of a thousand observations under-flows a double and a silently zeroed
 * posterior is indistinguishable from a confident one.
 *
 * Complexity is O(n · L) for n observations and a run-length cap of L; the cap
 * is an approximation and is stated in the report rather than hidden.
 */

import { mean, stdev } from "./math";

export interface ChangePointConfig {
  /** Prior expected run length in bars (1 / hazard). */
  expectedRunLength: number;
  /** Run lengths beyond this are pooled into the tail — an approximation. */
  maxRunLength: number;
  /** Prior strength for the mean, in pseudo-observations. */
  priorKappa: number;
  /** Prior shape and scale for the variance (Inverse-Gamma). */
  priorAlpha: number;
  priorBeta: number;
  /** A run-length probability below this is treated as zero. */
  pruneBelow: number;
  /**
   * Change probability at which a bar is flagged as a detected change.
   *
   * Not "the run length resets to exactly 0": after a real break the most
   * probable run length is a few bars (the observations since the break), so
   * requiring 0 would report almost no changes at all. A spike IS the signal.
   */
  flagAbove: number;
}

export const DEFAULT_CHANGE_POINT_CONFIG: ChangePointConfig = {
  expectedRunLength: 200,
  maxRunLength: 200,
  priorKappa: 1,
  priorAlpha: 2,
  priorBeta: 1,
  pruneBelow: 1e-12,
  flagAbove: 0.5,
};

export interface ChangePointResult {
  /** Posterior over run length at the final observation (index 0 = changed now). */
  runLengthPosterior: number[];
  /** P(a change occurred within the last `recentBars` observations). */
  changeProbability: number;
  /** Posterior mean run length at the final observation, in bars. */
  expectedRunLength: number;
  /** The run length with the largest posterior mass. */
  mostLikelyRunLength: number;
  /** Bars at which the most likely run length reset — the detected change points. */
  detectedChanges: number[];
  /**
   * P(a change in the last `recentBars`) at EVERY observation.
   *
   * The final value alone is not enough to judge the detector: a change that
   * happened 60 bars ago is correctly no longer "recent", so a series with a
   * clean break still ends with a low reading. The path is what shows the
   * spike, and it is what a report should be read from.
   */
  probabilityPath: number[];
}

/**
 * Run BOCPD forward over a series of observations.
 *
 * `recentBars` is what "recently" means for the veto. It is a parameter, not a
 * constant, because the right window is the holding period: a swing trade
 * should care about a change in the last few hours, a scalp about the last few
 * minutes. Callers pass the same window they use for the holding horizon.
 */
export function detectChangePoints(
  observations: number[],
  config: Partial<ChangePointConfig> = {},
  recentBars = 5,
): ChangePointResult {
  const cfg = { ...DEFAULT_CHANGE_POINT_CONFIG, ...config };
  const n = observations.length;
  const L = Math.max(2, Math.floor(cfg.maxRunLength));
  const hazard = 1 / Math.max(1, cfg.expectedRunLength);

  // Prior over run length: the process just started, so r = 0 with certainty.
  let logP = [0];
  /** Normal–Inverse-Gamma sufficient statistics per run length. */
  let mu: number[] = [0];
  let kappa: number[] = [cfg.priorKappa];
  let alpha: number[] = [cfg.priorAlpha];
  let beta: number[] = [cfg.priorBeta];

  let changeProbability = 0;
  let expectedRunLength = 0;
  let mostLikelyRunLength = 0;
  const detectedChanges: number[] = [];
  const probabilityPath: number[] = [];

  for (let t = 0; t < n; t++) {
    const x = observations[t] as number;
    const predictive: number[] = new Array(logP.length);
    for (let r = 0; r < logP.length; r++) {
      predictive[r] = studentTPredictive(
        x,
        mu[r] as number,
        kappa[r] as number,
        alpha[r] as number,
        beta[r] as number,
      );
    }

    // Change mass: every run length may end here (weighted by the hazard).
    let changeTerms: number[] = logP.map((lp, r) => lp + (predictive[r] as number));
    let logChange = logSumExp(changeTerms) + Math.log(hazard);
    // Growth mass: run length r becomes r + 1.
    let logGrowth: number[] = logP.map((lp, r) => lp + (predictive[r] as number) + Math.log(1 - hazard));

    // Truncate the tail: the oldest run lengths are pooled into one bin so that
    // the mass they carry is not silently discarded.
    if (logGrowth.length > L) {
      const tail = logGrowth.slice(L);
      const pooled = logSumExp(tail);
      logGrowth = logGrowth.slice(0, L);
      if (tail.length > 0) logGrowth[L - 1] = logSumExp([logGrowth[L - 1] as number, pooled]);
    }

    const logTotal = logSumExp([logChange, ...logGrowth]);
    logP = [logChange - logTotal, ...logGrowth.map((lg) => lg - logTotal)];

    // Update the sufficient statistics: the new run length 0 knows only about
    // x, the grown run lengths absorb x into what they already know.
    const nextMu: number[] = [x];
    const nextKappa: number[] = [cfg.priorKappa + 1];
    const nextAlpha: number[] = [cfg.priorAlpha + 0.5];
    const nextBeta: number[] = [
      (cfg.priorBeta as number) + (cfg.priorKappa * (x - 0) * (x - 0)) / (2 * (cfg.priorKappa + 1)),
    ];
    for (let r = 0; r < mu.length; r++) {
      const k = (kappa[r] as number) + 1;
      const m = ((kappa[r] as number) * (mu[r] as number) + x) / k;
      const a = (alpha[r] as number) + 0.5;
      const b =
        (beta[r] as number) +
        ((kappa[r] as number) * (x - (mu[r] as number)) * (x - (mu[r] as number))) / (2 * k);
      nextMu.push(m);
      nextKappa.push(k);
      nextAlpha.push(a);
      nextBeta.push(b);
    }
    mu = nextMu;
    kappa = nextKappa;
    alpha = nextAlpha;
    beta = nextBeta;

    // Prune: drop negligible mass and renormalise, so cost stays bounded on a
    // long series without changing the reported probabilities.
    if (t % 50 === 49) {
      const keep: number[] = [];
      for (let r = 0; r < logP.length; r++) if ((logP[r] as number) > Math.log(cfg.pruneBelow)) keep.push(r);
      if (keep.length > 1 && keep.length < logP.length) {
        logP = keep.map((r) => logP[r] as number);
        mu = keep.map((r) => mu[r] as number);
        kappa = keep.map((r) => kappa[r] as number);
        alpha = keep.map((r) => alpha[r] as number);
        beta = keep.map((r) => beta[r] as number);
      }
    }

    const probs = logP.map((lp) => Math.exp(lp));
    const total = probs.reduce((a, b) => a + b, 0);
    const posterior = total > 0 ? probs.map((p) => p / total) : probs;

    let best = 0;
    for (let r = 1; r < posterior.length; r++) if ((posterior[r] as number) > (posterior[best] as number)) best = r;
    mostLikelyRunLength = best;
    changeProbability = posterior.slice(0, Math.max(1, recentBars)).reduce((a, b) => a + b, 0);
    expectedRunLength = posterior.reduce((acc, p, r) => acc + p * r, 0);
    probabilityPath.push(changeProbability);
    // A change is flagged where the probability first crosses `flagAbove`; the
    // crossing (not every bar above it) is the event a caller acts on.
    if (t > 0 && changeProbability >= cfg.flagAbove && (probabilityPath[t - 1] as number) < cfg.flagAbove) {
      detectedChanges.push(t);
    }

    if (t === n - 1) {
      return {
        runLengthPosterior: posterior,
        changeProbability,
        expectedRunLength,
        mostLikelyRunLength,
        detectedChanges,
        probabilityPath,
      };
    }
  }

  // Empty input.
  return {
    runLengthPosterior: [1],
    changeProbability: 0,
    expectedRunLength: 0,
    mostLikelyRunLength: 0,
    detectedChanges,
    probabilityPath,
  };
}

/**
 * Student-t predictive density of the Normal–Inverse-Gamma model, in LOG space.
 *
 *     x | r ~ t_{2α} ( μ , β(κ+1)/(ακ) )
 */
export function studentTPredictive(x: number, mu: number, kappa: number, alpha: number, beta: number): number {
  const df = 2 * alpha;
  const scaleSq = (beta * (kappa + 1)) / (alpha * kappa);
  if (!(scaleSq > 0) || !Number.isFinite(scaleSq)) return -Infinity;
  const z = (x - mu) / Math.sqrt(scaleSq);
  const logNorm = logGamma((df + 1) / 2) - logGamma(df / 2) - 0.5 * Math.log(df * Math.PI * scaleSq);
  return logNorm - ((df + 1) / 2) * Math.log1p((z * z) / df);
}

/** Log-sum-exp, computed on the maximum for numerical safety. */
export function logSumExp(values: number[]): number {
  if (values.length === 0) return -Infinity;
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  if (!Number.isFinite(max)) return max;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

/** Lanczos approximation of log Γ(x) for x > 0. */
export function logGamma(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += (g[j] as number) / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/**
 * Convenience: BOCPD over a return series with the volatility-aware defaults.
 *
 * `observations` are log returns. Standardised (divided by a robust scale) so
 * the Inverse-Gamma prior means the same thing on EURUSD and on an index — the
 * prior is expressed in units of "typical move", not in price.
 */
export function changeProbabilities(
  returns: number[],
  options: { recentBars?: number; config?: Partial<ChangePointConfig> } = {},
): ChangePointResult {
  const scale = robustScale(returns);
  const scaled = scale > 0 ? returns.map((r) => r / scale) : returns;
  return detectChangePoints(scaled, options.config ?? {}, options.recentBars ?? 5);
}

/** Robust scale estimate: the median absolute deviation, scaled to σ. */
export function robustScale(values: number[]): number {
  if (values.length === 0) return 0;
  const abs = values.map((v) => Math.abs(v)).sort((a, b) => a - b);
  const median = abs[Math.floor(abs.length / 2)] as number;
  const mad = median;
  // 1.4826 converts the MAD to a σ for a normal distribution; the fallback to
  // the plain standard deviation matters for series with long flat stretches.
  return mad > 0 ? mad * 1.4826 : stdev(values) || mean(abs);
}
