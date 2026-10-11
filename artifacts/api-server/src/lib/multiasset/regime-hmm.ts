/**
 * WP3 — the regime agent: a 3-state Gaussian HMM plus a change-point veto.
 *
 * ── WHAT CHANGED FROM v3 ────────────────────────────────────────────────────
 *
 * The v3 desk already assessed a regime (`regime.ts`: trend up / trend down /
 * range / volatile) and used it as an *advisory* — one weighted factor among
 * many, plus a soft "is this regime tradeable in this mode" check. A factor can
 * be outvoted; on the null data the desk armed anyway.
 *
 * v4 keeps that assessment (it is still useful, and it is still what the
 * terminal shows) but the regime layer's PRODUCT is a **permission**, not a
 * score:
 *
 *     permit  ⇔  P(required state) ≥ 0.60
 *            AND expected dwell of that state ≥ 1.5 × the holding horizon
 *            AND P(a change point in the last few bars) < 0.30
 *
 * The three conditions answer three different ways a regime trade fails:
 *
 *   1. the state is not actually probable (the model is guessing);
 *   2. the state is probable but short-lived — the desk's holding period is
 *      longer than the regime lasts, so the trade is still open when the tape
 *      changes character (this is the one a trend filter alone can never see);
 *   3. the state WAS probable and the world just changed (the change-point
 *      veto — a filter is most confident exactly when it is most wrong).
 *
 * ── WHY A HIDDEN MARKOV MODEL, AND WHAT IT IS ALLOWED TO SEE ────────────────
 *
 * Regimes are latent: nobody observes "trending", they observe prices. A
 * Markov-switching model with Gaussian emissions is the smallest model that
 * (a) carries state persistence explicitly — which is exactly what the dwell
 * condition needs, and (b) can be fitted offline, deterministically, with no
 * dependencies.
 *
 * The observation vector, computed causally at every bar (each feature uses
 * bars up to and including that bar, never later):
 *
 *   ret_z     the bar's log return, standardised by a robust scale
 *   drift_z   the CUMULATIVE return over the last few bars (a regime is a run
 *             of the same sign; one bar tells you almost nothing about it, and
 *             the causal filter is much faster to notice a switch with this)
 *   vol_ratio rolling realised volatility over 20 bars / robust scale
 *   slope_z   least-squares slope of the last 20 closes / robust scale
 *   markov_z  the v3 Markov model's directional persistence, scaled by 0.25
 *
 * The last one deserves a note: the brief for this work package says the old
 * Markov model is KEPT, as ONE LOW-WEIGHT FEATURE rather than a gate. Its raw
 * signal lives in [−1, 1] while the other three are standardised to roughly
 * unit variance, so weighting it by 0.25 keeps its influence visible in the
 * fitted means but unable to dominate the geometry. It is not deleted, and it
 * is not in charge.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * Every random choice (k-means++ seeding, restart initialisation) comes from
 * the seeded `makeRng`, and the fitted model is a pure function of (bars,
 * config). Two runs with the same input produce bit-identical parameters —
 * which is what lets a report be re-checked a month later.
 */

import { logReturns, makeRng, mean, stdev } from "./math";
import { changeProbabilities, robustScale } from "./change-point";
import { directionalPersistence, markovFromPrices } from "./markov";
import { MODE_HORIZON_BARS } from "./confluence";
import type { Bar, Side, TradeMode } from "./types";
import { CLOSE } from "./math";

// ── Configuration ───────────────────────────────────────────────────────────

export interface RegimeHmmConfig {
  /** Hidden states. The v4 design is 3: up-trend, down-trend, range/volatile. */
  states: number;
  seed: number;
  maxIter: number;
  tol: number;
  restarts: number;
  /** Floor on the diagonal variances — a zero variance is an infinite likelihood. */
  minVariance: number;
  /** Bars of history the model is filtered on (the "how long ago" horizon). */
  windowBars: number;
  /**
   * Bars the model is FITTED on, when more history is available.
   *
   * The emissions identify themselves on a few hundred bars, but the
   * TRANSITIONS — and the dwell condition is nothing but a transition — see
   * only about one switch per regime per window. A 250-bar window contains two
   * or three regime changes on a p_stay-0.99 tape, and the maximum-likelihood
   * self-transition from three observations is a lottery (measured: the fitted
   * dwell of the same regime moved between 10 and 35 bars across adjacent
   * decision points while the truth was ~100). Fitting on four times the filter
   * window costs about 3× the milliseconds and roughly halves that noise. The
   * filter still runs causally over everything the fit saw, so nothing is
   * gained from the future — only from more of the past.
   */
  fitBars: number;
  /** Weight of the legacy Markov persistence feature (see the header). */
  markovFeatureWeight: number;
  /**
   * How significant a state's drift must be before the state is called a TREND.
   *
   * The score is the state's mean per-bar return (in robust σ units) times the
   * square root of its fitted dwell — a t-statistic for "over a typical stay in
   * this state, the tape moved further than a random walk would explain". See
   * `labelStates` for the measured separation this threshold sits in.
   */
  trendScoreThreshold: number;
  /** Permit: minimum posterior of the required state. */
  minStateProbability: number;
  /** Permit: expected dwell must exceed this multiple of the holding horizon. */
  dwellMultiplier: number;
  /** Permit: maximum P(change point within `changeRecentBars` bars). */
  maxChangeProbability: number;
  changeRecentBars: number;
  /** Rolling window for the volatility and slope features. */
  featureWindow: number;
  /** Bars over which the cumulative drift feature is measured. */
  driftWindow: number;
}

export const DEFAULT_REGIME_HMM_CONFIG: RegimeHmmConfig = {
  states: 3,
  seed: 20_261_011,
  // 20 EM iterations from two seeded starts on a 250-bar window, after a Lloyd
  // polish of the seeding: measured to reach (and beat) the accuracy of 40
  // iterations from two raw starts on the labelled control, at a third of the
  // cost. The live desk refits on every evaluation, so the budget is part of
  // the design — see the fit-cost numbers in docs/mt5-live-desk-v4.md.
  maxIter: 20,
  tol: 1e-7,
  restarts: 2,
  minVariance: 1e-6,
  windowBars: 250,
  fitBars: 1000,
  markovFeatureWeight: 0.25,
  // Measured on two generators over 12 seeds each (see labelStates): the
  // driftless null never exceeds |score| 1.44, while the labelled three-regime
  // control puts its trend states at 3.31–10.16 and its range state at ≤ 0.78.
  // 2.0 sits in that gap with margin on both sides.
  trendScoreThreshold: 2,
  minStateProbability: 0.6,
  dwellMultiplier: 1.5,
  maxChangeProbability: 0.3,
  changeRecentBars: 5,
  featureWindow: 20,
  driftWindow: 5,
};

export const FEATURE_NAMES = ["ret_z", "drift_z", "vol_ratio", "slope_z", "markov_z"] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** The regime labels the agent can report. */
export type RegimeState = "trend_up" | "trend_down" | "range" | "volatile";

// ── Features ────────────────────────────────────────────────────────────────

export interface FeatureMatrix {
  /** One row per bar from `startIndex` onwards; columns match FEATURE_NAMES. */
  matrix: number[][];
  startIndex: number;
  /** Robust scale the returns were standardised by (for reporting). */
  scale: number;
}

/**
 * Build the causal feature matrix.
 *
 * `startIndex` is the first bar with enough history for every window; nothing
 * before it is usable and nothing after it is ever read.
 */
export function featuresFromBars(bars: Bar[], config: Partial<RegimeHmmConfig> = {}): FeatureMatrix {
  const cfg = { ...DEFAULT_REGIME_HMM_CONFIG, ...config };
  const w = cfg.featureWindow;
  const closes = bars.map((b) => b[CLOSE]);
  const returns = logReturns(closes);
  const start = Math.max(w + 1, 30);
  if (bars.length <= start + 5) return { matrix: [], startIndex: start, scale: 0 };

  const scale = robustScale(returns.filter((r) => Number.isFinite(r))) || stdev(returns) || 1;
  // The legacy Markov persistence, computed once on the full available history.
  const markov = markovFromPrices(closes);
  const persistence =
    directionalPersistence(markov, "up", MODE_HORIZON_BARS.intraday) -
    directionalPersistence(markov, "down", MODE_HORIZON_BARS.intraday);

  const matrix: number[][] = [];
  for (let i = start; i < bars.length; i++) {
    // ret_z: the bar's own return (returns[i − 1] is the return INTO bar i).
    const ret = (returns[i - 1] ?? 0) / scale;
    // drift_z: the cumulative return over the last `driftWindow` bars. This is
    // the feature that actually carries the regime: a drift of 0.45σ per bar is
    // invisible in one bar and obvious in five.
    const drift = (returns.slice(Math.max(0, i - cfg.driftWindow), i).reduce((a, b) => a + b, 0)) / scale;
    // vol_ratio: realised volatility of the last `w` returns.
    const window = returns.slice(Math.max(0, i - w), i);
    const vol = (stdev(window) || 0) / scale;
    // slope_z: least-squares slope of the last `w` closes, per bar, in σ units.
    const slope = linearSlope(closes.slice(Math.max(0, i - w + 1), i + 1)) / scale;
    // markov_z: the legacy feature, deliberately scaled down.
    const markovZ = persistence * cfg.markovFeatureWeight;
    matrix.push([ret, drift, vol, slope, markovZ]);
  }
  return { matrix, startIndex: start, scale };
}

/** Ordinary least-squares slope of y against its own index. */
export function linearSlope(y: number[]): number {
  const n = y.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * ((y[i] as number) - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

// ── The model ───────────────────────────────────────────────────────────────

export interface HmmModel {
  states: number;
  /** Emission means, [state][feature]. */
  means: number[][];
  /** Emission variances (diagonal covariance), [state][feature]. */
  variances: number[][];
  /** Transition matrix, [from][to]. */
  transition: number[][];
  /** Initial state distribution. */
  initial: number[];
  /** Semantic label per state, derived from the fitted means. */
  labels: RegimeState[];
  logLikelihood: number;
  iterations: number;
  /** Observations the model was fitted on (a dwell cannot exceed the sample). */
  observations: number;
  featureNames: readonly string[];
}

/** Fit a diagonal-Gaussian HMM by EM with seeded restarts (Baum-Welch). */
export function fitHmm(features: number[][], config: Partial<RegimeHmmConfig> = {}): HmmModel {
  const cfg = { ...DEFAULT_REGIME_HMM_CONFIG, ...config };
  if (features.length < cfg.states * 3) {
    throw new Error(`fitHmm needs at least ${cfg.states * 3} observations (got ${features.length})`);
  }
  let best: HmmModel | null = null;
  for (let restart = 0; restart < Math.max(1, cfg.restarts); restart++) {
    const seeded = initialise(features, cfg, cfg.seed + restart * 7919);
    const model = baumWelch(features, seeded, cfg);
    if (!best || model.logLikelihood > best.logLikelihood) best = model;
  }
  const chosen = best as HmmModel;
  return { ...chosen, labels: labelStates(chosen, cfg) };
}

/** k-means++ style seeding, then one Lloyd pass, all on the seeded RNG. */
function initialise(features: number[][], cfg: RegimeHmmConfig, seed: number): HmmModel {
  const rng = makeRng(seed);
  const dims = (features[0] as number[]).length;
  const k = cfg.states;
  const chosen: number[][] = [[...(features[Math.floor(rng() * features.length)] as number[])]];
  while (chosen.length < k) {
    const distances = features.map((row) => {
      let bestDist = Infinity;
      for (const centre of chosen) {
        let d = 0;
        for (let j = 0; j < dims; j++) d += ((row[j] as number) - (centre[j] as number)) ** 2;
        if (d < bestDist) bestDist = d;
      }
      return bestDist;
    });
    const total = distances.reduce((a, b) => a + b, 0);
    let target = rng() * (total > 0 ? total : 1);
    let index = 0;
    for (let i = 0; i < distances.length; i++) {
      target -= distances[i] as number;
      if (target <= 0) {
        index = i;
        break;
      }
    }
    chosen.push([...(features[index] as number[])]);
  }

  let means = chosen;
  // A few Lloyd iterations polish the seeding before EM sees it. Cheap, and it
  // removes most of the bad local optima that otherwise need extra restarts —
  // restarts cost the live desk real milliseconds on every evaluation.
  for (let iter = 0; iter < 8; iter++) {
    const sums = means.map(() => new Array<number>(dims).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (const row of features) {
      let best = 0;
      let bestDist = Infinity;
      for (let s = 0; s < k; s++) {
        let d = 0;
        for (let j = 0; j < dims; j++) d += ((row[j] as number) - ((means[s] as number[])[j] as number)) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      counts[best] += 1;
      for (let j = 0; j < dims; j++) (sums[best] as number[])[j] += (row[j] as number);
    }
    for (let s = 0; s < k; s++) {
      const count = counts[s] as number;
      if (count === 0) continue;
      for (let j = 0; j < dims; j++) (means[s] as number[])[j] = (sums[s] as number[])[j]! / count;
    }
  }
  const variances = means.map(() => new Array<number>(dims).fill(1));
  // A sticky transition matrix: regimes last, and starting from "each state is
  // equally likely to persist" keeps the first EM steps stable.
  const transition = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 0.9 : 0.1 / (k - 1))),
  );
  const initial = new Array<number>(k).fill(1 / k);
  return {
    states: k,
    means,
    variances,
    transition,
    initial,
    labels: [],
    logLikelihood: -Infinity,
    iterations: 0,
    observations: features.length,
    featureNames: FEATURE_NAMES,
  };
}

/** EM: forward-backward in log space, then closed-form diagonal updates. */
function baumWelch(features: number[][], seedModel: HmmModel, cfg: RegimeHmmConfig): HmmModel {
  const n = features.length;
  const k = seedModel.states;
  const dims = (features[0] as number[]).length;
  let { means, variances, transition, initial } = seedModel;
  let logLikelihood = -Infinity;
  let iterations = 0;

  for (let iter = 0; iter < cfg.maxIter; iter++) {
    iterations = iter + 1;
    const logB = features.map((row) =>
      means.map((mu, s) => {
        let acc = 0;
        for (let j = 0; j < dims; j++) {
          const varj = Math.max(cfg.minVariance, (variances[s] as number[])[j] as number);
          const d = (row[j] as number) - (mu[j] as number);
          acc += -0.5 * (Math.log(2 * Math.PI * varj) + (d * d) / varj);
        }
        return acc;
      }),
    );
    const logTrans = transition.map((row) => row.map((p) => Math.log(Math.max(1e-12, p))));

    // Forward.
    const alpha: number[][] = new Array(n);
    for (let t = 0; t < n; t++) alpha[t] = new Array<number>(k).fill(-Infinity);
    for (let s = 0; s < k; s++) alpha[0][s] = Math.log(Math.max(1e-12, initial[s] as number)) + (logB[0] as number[])[s];
    for (let t = 1; t < n; t++) {
      for (let s = 0; s < k; s++) {
        const terms: number[] = [];
        for (let p = 0; p < k; p++) terms.push((alpha[t - 1][p] as number) + (logTrans[p] as number[])[s]);
        alpha[t][s] = logSumExpInline(terms) + (logB[t] as number[])[s];
      }
    }
    const logTotal = logSumExpInline(alpha[n - 1]);

    // Backward.
    const beta: number[][] = new Array(n);
    for (let t = 0; t < n; t++) beta[t] = new Array<number>(k).fill(-Infinity);
    for (let s = 0; s < k; s++) beta[n - 1][s] = 0;
    for (let t = n - 2; t >= 0; t--) {
      for (let s = 0; s < k; s++) {
        const terms: number[] = [];
        for (let ns = 0; ns < k; ns++) {
          terms.push((logTrans[s] as number[])[ns] + (logB[t + 1] as number[])[ns] + (beta[t + 1][ns] as number));
        }
        beta[t][s] = logSumExpInline(terms);
      }
    }

    // Responsibilities and expected transitions.
    const gamma: number[][] = alpha.map((row, t) => row.map((a, s) => Math.exp(a + (beta[t][s] as number) - logTotal)));
    const xiSum: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let t = 0; t < n - 1; t++) {
      const terms: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
      const flat: number[] = [];
      for (let p = 0; p < k; p++) {
        for (let s = 0; s < k; s++) {
          const v = (alpha[t][p] as number) + (logTrans[p] as number[])[s] + (logB[t + 1] as number[])[s] + (beta[t + 1][s] as number);
          terms[p][s] = v;
          flat.push(v);
        }
      }
      const normaliser = logSumExpInline(flat);
      for (let p = 0; p < k; p++) {
        for (let s = 0; s < k; s++) {
          (xiSum[p] as number[])[s] += Math.exp((terms[p] as number[])[s] - normaliser);
        }
      }
    }

    // M-step.
    const newMeans = means.map(() => new Array<number>(dims).fill(0));
    const newVars = variances.map(() => new Array<number>(dims).fill(0));
    for (let s = 0; s < k; s++) {
      let weight = 0;
      for (let t = 0; t < n; t++) weight += (gamma[t] as number[])[s] as number;
      if (weight < 1e-6) {
        // An unused state keeps its parameters (with the variance floor) rather
        // than collapsing to a singular spike on nothing.
        newMeans[s] = [...(means[s] as number[])];
        newVars[s] = (variances[s] as number[]).map((v) => Math.max(cfg.minVariance, v));
        continue;
      }
      for (let j = 0; j < dims; j++) {
        let m = 0;
        for (let t = 0; t < n; t++) m += ((gamma[t] as number[])[s] as number) * ((features[t] as number[])[j] as number);
        m /= weight;
        (newMeans[s] as number[])[j] = m;
        let v = 0;
        for (let t = 0; t < n; t++) {
          const d = ((features[t] as number[])[j] as number) - m;
          v += ((gamma[t] as number[])[s] as number) * d * d;
        }
        (newVars[s] as number[])[j] = Math.max(cfg.minVariance, v / weight);
      }
    }
    const newTrans = xiSum.map((row) => {
      const total = row.reduce((a, b) => a + b, 0);
      return total > 0 ? row.map((v) => v / total) : row.map(() => 1 / k);
    });
    const newInitial = (gamma[0] as number[]).map((v) => v);

    means = newMeans;
    variances = newVars;
    transition = newTrans;
    initial = newInitial;

    const converged = Number.isFinite(logLikelihood) && Math.abs(logTotal - logLikelihood) < cfg.tol * Math.max(1, Math.abs(logLikelihood));
    logLikelihood = logTotal;
    if (converged) break;
  }

  return { ...seedModel, means, variances, transition, initial, logLikelihood, iterations };
}

function logSumExpInline(values: number[]): number {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  if (!Number.isFinite(max)) return max;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

/**
 * Severity of a state's drift: its mean per-bar return in robust σ units, times
 * the square root of its fitted dwell.
 *
 * This is the t-statistic of the state's mean return. A random walk of length
 * `dwell` travels about √dwell σ by accident, so a state whose mean return
 * times √dwell is around 1 or less is indistinguishable from noise no matter
 * how persistent it looks, while a state scoring 3 has genuinely trended.
 */
export function trendScore(model: HmmModel, state: number): number {
  const dwell = Math.min(expectedDwellBars(model, state), Math.max(1, model.observations));
  return ((model.means[state] as number[])[0] as number) * Math.sqrt(dwell);
}

/**
 * Semantic labels from the fitted parameters.
 *
 * State indices are arbitrary (state 0 is whichever the k-means++ seeding
 * happened to pick), so labels must come from the fitted quantities, never from
 * the index. Two of them:
 *
 *   • a state is a TREND only when its drift is statistically significant
 *     (`trendScore`, see above). Note that this can label TWO states as
 *     `trend_up` — a fit can legitimately split a trending tape into a strong
 *     and a mild up state, and the permit SUMS the posterior over every state
 *     carrying the label, so calling the mild one "range" would throw away a
 *     real permission and calling it "trend_up" never invents one;
 *   • the remaining states are `range`, unless one of them is the most volatile
 *     of all — then it is `volatile`, which is a different thing to trade.
 *
 * The threshold is not a free parameter: on the driftless null (12 seeds) the
 * largest |score| was 1.44, and on the labelled three-regime control the trend
 * states scored 3.31–10.16 while the range state never exceeded 0.78.
 */
export function labelStates(model: HmmModel, config: Partial<RegimeHmmConfig> = {}): RegimeState[] {
  const cfg = { ...DEFAULT_REGIME_HMM_CONFIG, ...config };
  const labels = new Array<RegimeState>(model.states).fill("range");
  const scores = [...Array(model.states).keys()].map((state) => trendScore(model, state));
  const volOf = (i: number): number => (model.means[i] as number[])[2] as number;
  const mostVolatile = [...Array(model.states).keys()].reduce((a, b) => (volOf(b) > volOf(a) ? b : a), 0);
  for (let s = 0; s < model.states; s++) {
    const score = scores[s] as number;
    if (score >= cfg.trendScoreThreshold) labels[s] = "trend_up";
    else if (score <= -cfg.trendScoreThreshold) labels[s] = "trend_down";
    else labels[s] = s === mostVolatile ? "volatile" : "range";
  }
  return labels;
}

// ── Inference ───────────────────────────────────────────────────────────────

export interface FilterResult {
  /** Causal (filtered) posterior at each row: only that row and the past. */
  posteriors: number[][];
  /** The most recent filtered posterior. */
  last: number[];
}

/** Forward-only (CAUSAL) inference. This is what the live agent uses. */
export function filterPosterior(model: HmmModel, features: number[][]): FilterResult {
  const k = model.states;
  const dims = (model.means[0] as number[]).length;
  const posteriors: number[][] = [];
  let logAlpha = new Array<number>(k).fill(-Infinity);

  for (let t = 0; t < features.length; t++) {
    const row = features[t] as number[];
    const logB = model.means.map((mu, s) => {
      let acc = 0;
      for (let j = 0; j < dims; j++) {
        const varj = Math.max(1e-12, (model.variances[s] as number[])[j] as number);
        const d = (row[j] as number) - (mu[j] as number);
        acc += -0.5 * (Math.log(2 * Math.PI * varj) + (d * d) / varj);
      }
      return acc;
    });
    const next = new Array<number>(k).fill(-Infinity);
    for (let s = 0; s < k; s++) {
      const terms: number[] = [];
      for (let p = 0; p < k; p++) {
        const prior = t === 0 ? Math.log(Math.max(1e-12, model.initial[p] as number)) : (logAlpha[p] as number);
        terms.push(prior + Math.log(Math.max(1e-12, (model.transition[p] as number[])[s] as number)));
      }
      next[s] = logSumExpInline(terms) + (logB[s] as number);
    }
    const total = logSumExpInline(next);
    logAlpha = next.map((v) => v - total);
    posteriors.push(logAlpha.map((v) => Math.exp(v)));
  }
  return { posteriors, last: posteriors.length > 0 ? (posteriors[posteriors.length - 1] as number[]) : new Array<number>(k).fill(1 / k) };
}

/** Most likely state sequence (Viterbi), for offline analysis and reporting. */
export function viterbiPath(model: HmmModel, features: number[][]): number[] {
  const k = model.states;
  const dims = (model.means[0] as number[]).length;
  const n = features.length;
  if (n === 0) return [];
  const delta: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(-Infinity));
  const back: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(0));

  for (let t = 0; t < n; t++) {
    const row = features[t] as number[];
    for (let s = 0; s < k; s++) {
      let emission = 0;
      for (let j = 0; j < dims; j++) {
        const varj = Math.max(1e-12, (model.variances[s] as number[])[j] as number);
        const d = (row[j] as number) - ((model.means[s] as number[])[j] as number);
        emission += -0.5 * (Math.log(2 * Math.PI * varj) + (d * d) / varj);
      }
      if (t === 0) {
        delta[t][s] = Math.log(Math.max(1e-12, model.initial[s] as number)) + emission;
        continue;
      }
      let bestVal = -Infinity;
      let bestPrev = 0;
      for (let p = 0; p < k; p++) {
        const v = (delta[t - 1][p] as number) + Math.log(Math.max(1e-12, (model.transition[p] as number[])[s] as number));
        if (v > bestVal) {
          bestVal = v;
          bestPrev = p;
        }
      }
      delta[t][s] = bestVal + emission;
      back[t][s] = bestPrev;
    }
  }

  const path = new Array<number>(n).fill(0);
  let state = 0;
  let bestVal = -Infinity;
  for (let s = 0; s < k; s++) {
    if ((delta[n - 1][s] as number) > bestVal) {
      bestVal = delta[n - 1][s] as number;
      state = s;
    }
  }
  path[n - 1] = state;
  for (let t = n - 1; t > 0; t--) path[t - 1] = (back[t][path[t] as number] as number);
  return path;
}

/** Expected dwell of a state in bars: the geometric mean of its self-transition. */
export function expectedDwellBars(model: HmmModel, state: number): number {
  const stay = Math.min(0.999999, Math.max(0, (model.transition[state] as number[])[state] as number));
  return 1 / Math.max(1e-6, 1 - stay);
}

// ── The permission ──────────────────────────────────────────────────────────

export interface RegimePermitInput {
  /** CLOSED bars of the entry timeframe, oldest first. */
  bars: Bar[];
  mode: TradeMode;
  side: Side;
  /** Override the state a trade needs (default: up-trend for a buy). */
  requiredState?: RegimeState;
  config?: Partial<RegimeHmmConfig>;
}

export interface RegimePermit {
  /** The labelled regime the model currently believes in. */
  state: RegimeState;
  /** The state this trade requires. */
  required: RegimeState;
  /** P(required state) — the number the 0.60 threshold applies to. */
  probability: number;
  /** Full posterior by label, for the UI and the journal. */
  posterior: Record<string, number>;
  expectedDwellBars: number;
  requiredDwellBars: number;
  changeProbability: number;
  permit: boolean;
  /** Machine-readable reason codes; `REGIME_PERMIT` when it passes. */
  codes: string[];
  /** One human sentence, safe to show in the terminal. */
  reason: string;
  fit: {
    bars: number;
    iterations: number;
    logLikelihood: number;
    scale: number;
    /**
     * Bars the model WANTS to be fitted on (`fitBars`).
     *
     * Callers must hold this much history for the frame they read: the
     * transition matrix — and the dwell condition is nothing else — needs
     * several observed regime switches, and a 250-bar window contains two or
     * three (§5.3 of the v4 design record measures what happens without it).
     */
    wanted: number;
    /** The floor: fewer usable bars than the filter window starves every axis. */
    minimum: number;
    /** `bars >= minimum`. False means "read this permit with suspicion". */
    adequate: boolean;
  };
}

/** Which state a trade needs. Buys need an up-trend; sells a down-trend. */
export function requiredRegimeFor(side: Side, mode: TradeMode): RegimeState {
  // Mean-reversion modes could legitimately want "range", but the desk's entry
  // logic is directional today; requiring the matching trend is the
  // conservative reading, and it is what WP4's agents will be measured against.
  void mode;
  return side === "buy" ? "trend_up" : "trend_down";
}

/**
 * Evaluate the regime permission for one candidate trade.
 *
 * Every failure path returns a permit of `false` with a reason — never a
 * silent pass. If the model cannot be fitted (too little history), the trade is
 * REFUSED, because "we could not measure the regime" is not the same as "the
 * regime is fine".
 */
export function regimePermit(input: RegimePermitInput): RegimePermit {
  const cfg = { ...DEFAULT_REGIME_HMM_CONFIG, ...input.config };
  const required = input.requiredState ?? requiredRegimeFor(input.side, input.mode);
  const holdingBars = MODE_HORIZON_BARS[input.mode];
  const requiredDwellBars = holdingBars * cfg.dwellMultiplier;
  const base: Omit<RegimePermit, "permit" | "codes" | "reason"> = {
    state: "range",
    required,
    probability: 0,
    posterior: {},
    expectedDwellBars: 0,
    requiredDwellBars,
    changeProbability: 1,
    fit: {
      bars: 0,
      iterations: 0,
      logLikelihood: 0,
      scale: 0,
      wanted: cfg.fitBars,
      minimum: cfg.windowBars,
      adequate: false,
    },
  };

  const window = input.bars.slice(-Math.max(cfg.fitBars, cfg.windowBars));
  const features = featuresFromBars(window, cfg);
  if (features.matrix.length < cfg.states * 5) {
    return {
      ...base,
      permit: false,
      codes: ["REGIME_UNAVAILABLE"],
      reason: `Regime model unavailable: only ${features.matrix.length} usable bars of history (needs ${cfg.states * 5}).`,
    };
  }

  let model: HmmModel;
  try {
    model = fitHmm(features.matrix, cfg);
  } catch (error) {
    return {
      ...base,
      permit: false,
      codes: ["REGIME_UNAVAILABLE"],
      reason: `Regime model unavailable: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  const filtered = filterPosterior(model, features.matrix);
  const posteriorByLabel: Record<string, number> = {};
  for (let s = 0; s < model.states; s++) {
    const label = model.labels[s] ?? "range";
    posteriorByLabel[label] = (posteriorByLabel[label] ?? 0) + (filtered.last[s] as number);
  }

  // The required state's probability is summed over every state that carries
  // that label (a fit may legitimately split a trend across two states).
  let probability = 0;
  for (let s = 0; s < model.states; s++) {
    if (model.labels[s] === required) probability += filtered.last[s] as number;
  }
  const expectedDwellBars = expectedDwellOfLabel(model, required, filtered.last);

  // The change-point veto runs on the bar returns, at the same horizon the
  // caller cares about (the last few bars, not "ever").
  const returns = logReturns(window.map((b) => b[CLOSE])).filter((r) => Number.isFinite(r));
  const change = changeProbabilities(returns, {
    recentBars: cfg.changeRecentBars,
    config: { expectedRunLength: Math.max(50, cfg.windowBars / 2), maxRunLength: Math.max(50, cfg.windowBars / 2) },
  });

  const codes: string[] = [];
  if (probability < cfg.minStateProbability) {
    codes.push("STATE_PROBABILITY_LOW");
  }
  if (expectedDwellBars < requiredDwellBars) {
    codes.push("DWELL_TOO_SHORT");
  }
  if (!(change.changeProbability < cfg.maxChangeProbability)) {
    codes.push("CHANGEPOINT_RECENT");
  }

  const state = model.labels[
    filtered.last.indexOf(Math.max(...filtered.last))
  ] ?? "range";

  const base2 = {
    ...base,
    state,
    probability,
    posterior: posteriorByLabel,
    expectedDwellBars,
    changeProbability: change.changeProbability,
    fit: {
      bars: features.matrix.length,
      iterations: model.iterations,
      logLikelihood: model.logLikelihood,
      scale: features.scale,
      wanted: cfg.fitBars,
      minimum: cfg.windowBars,
      adequate: features.matrix.length >= cfg.windowBars,
    },
  };

  if (codes.length === 0) {
    return {
      ...base2,
      permit: true,
      codes: ["REGIME_PERMIT"],
      reason:
        `Regime permits this trade: P(${required}) ${(probability * 100).toFixed(0)}% ≥ ${(cfg.minStateProbability * 100).toFixed(0)}%, ` +
        `expected dwell ${expectedDwellBars.toFixed(0)} bars ≥ ${requiredDwellBars.toFixed(0)} (${cfg.dwellMultiplier}× the ` +
        `${holdingBars}-bar ${input.mode} horizon), P(change point in the last ${cfg.changeRecentBars} bars) ` +
        `${(change.changeProbability * 100).toFixed(0)}% < ${(cfg.maxChangeProbability * 100).toFixed(0)}%.`,
    };
  }

  const parts: string[] = [];
  if (codes.includes("STATE_PROBABILITY_LOW")) {
    parts.push(
      `P(${required}) is only ${(probability * 100).toFixed(0)}% (needs ${(cfg.minStateProbability * 100).toFixed(0)}%); the model's own view is ${state.replace("_", " ")}.`,
    );
  }
  if (codes.includes("DWELL_TOO_SHORT")) {
    parts.push(
      `the ${state.replace("_", " ")} regime's expected dwell is ${expectedDwellBars.toFixed(0)} bars, shorter than the ${requiredDwellBars.toFixed(0)} ` +
        `bars this ${input.mode} trade is expected to need.`,
    );
  }
  if (codes.includes("CHANGEPOINT_RECENT")) {
    parts.push(
      `a change point in the last ${cfg.changeRecentBars} bars is ${(change.changeProbability * 100).toFixed(0)}% likely (limit ${(cfg.maxChangeProbability * 100).toFixed(0)}%).`,
    );
  }
  return { ...base2, permit: false, codes, reason: `Regime does not permit this trade: ${parts.join(" ")}` };
}

/**
 * Expected dwell of a LABEL, in bars.
 *
 * The dwell condition asks "will this trade still be open when the tape changes
 * character?", so it must measure the regime, not one hidden state: a fit can
 * split an up-trend across a strong and a mild state, and each half then looks
 * short-lived on its own while the label as a whole persists. The lumped
 * self-transition is P(be at a `label` state one bar later | be at one now),
 * weighted by the posterior — the dwell of the merged macro-state, and the same
 * quantity whether the label covers one state or two.
 */
export function expectedDwellOfLabel(model: HmmModel, label: RegimeState, posterior: number[]): number {
  let weight = 0;
  let stay = 0;
  for (let s = 0; s < model.states; s++) {
    if (model.labels[s] !== label) continue;
    const share = Math.max(0, posterior[s] as number);
    weight += share;
    for (let t = 0; t < model.states; t++) {
      if (model.labels[t] !== label) continue;
      stay += share * ((model.transition[s] as number[])[t] as number);
    }
  }
  if (weight <= 0) return 0;
  const p = Math.min(0.999999, Math.max(0, stay / weight));
  return 1 / Math.max(1e-6, 1 - p);
}

// ── Grading the detector (used by the tests AND the stored report) ──────────

export interface RegimeAccuracy {
  /** Held-out bars the detector was graded on. */
  samples: number;
  /** Accuracy of the CAUSAL (filtered) posterior against the truth. */
  causal: number;
  /** Accuracy of the offline Viterbi path, for reference only. */
  viterbi: number;
  /**
   * Accuracy of a SUPERVISED causal filter: the true generative parameters,
   * estimated from the training half, with the empirical transition matrix of
   * the true label sequence. Nothing causal can beat this by much, so it is the
   * ceiling the detector should be judged against — a series whose ceiling is
   * below the gate is a bad test, not a bad detector.
   */
  ceiling: number;
  /** Wilson 95% lower bound on `causal`. */
  causalLowerBound: number;
  /** Which fitted state each true label was mapped to. */
  mapping: Record<string, number>;
  /** confusion[trueLabel][assignedLabel] counts. */
  confusion: Record<string, Record<string, number>>;
  fittedLabels: RegimeState[];
}

/**
 * Grade a fitted model against known regimes, causally.
 *
 * Both the unit test and the CLI report call THIS function: a report that
 * graded itself with different code from the test would be worth nothing.
 */
export function measureRegimeAccuracy(
  bars: Bar[],
  truth: string[],
  config: Partial<RegimeHmmConfig> = {},
  options: { trainFraction?: number } = {},
): RegimeAccuracy {
  const cfg = { ...DEFAULT_REGIME_HMM_CONFIG, ...config };
  const trainFraction = options.trainFraction ?? 0.5;
  const features = featuresFromBars(bars, cfg);
  const rows = features.matrix;
  const labelsAt = (row: number): string | undefined => truth[features.startIndex + row];
  const split = Math.max(1, Math.floor(rows.length * trainFraction));
  const distinct = [...new Set(truth.filter((t): t is string => Boolean(t)))];

  const empty: RegimeAccuracy = {
    samples: 0,
    causal: 0,
    viterbi: 0,
    ceiling: 0,
    causalLowerBound: 0,
    mapping: {},
    confusion: {},
    fittedLabels: [],
  };
  if (rows.length < cfg.states * 6 || split >= rows.length) return empty;

  const model = fitHmm(rows.slice(0, split), cfg);

  // Map fitted states → true labels on the TRAINING half only, greedily by
  // count so two labels can never claim the same state.
  const counts = new Map<string, { state: number; n: number }[]>();
  const train = filterPosterior(model, rows.slice(0, split));
  for (const label of distinct) {
    const histogram = new Array<number>(model.states).fill(0);
    for (let j = 0; j < split; j++) {
      if (labelsAt(j) !== label) continue;
      const posterior = train.posteriors[j] as number[];
      const state = posterior.indexOf(Math.max(...posterior));
      histogram[state] = (histogram[state] as number) + 1;
    }
    counts.set(
      label,
      histogram.map((n, state) => ({ state, n })).sort((a, b) => b.n - a.n),
    );
  }
  const mapping: Record<string, number> = {};
  const used = new Set<number>();
  for (const label of distinct) {
    const ranked = counts.get(label) as { state: number; n: number }[];
    const pick = ranked.find((entry) => !used.has(entry.state)) ?? (ranked[0] as { state: number; n: number });
    mapping[label] = pick.state;
    used.add(pick.state);
  }
  const stateToLabel = new Map<number, string>();
  for (const [label, state] of Object.entries(mapping)) stateToLabel.set(state, label);

  const confusion: Record<string, Record<string, number>> = {};
  for (const label of distinct) {
    const row: Record<string, number> = {};
    for (const other of distinct) row[other] = 0;
    confusion[label] = row;
  }

  const test = filterPosterior(model, rows.slice(split));
  const viterbi = viterbiPath(model, rows.slice(split));
  let correct = 0;
  let viterbiCorrect = 0;
  let samples = 0;
  for (let j = 0; j < test.posteriors.length; j++) {
    const label = labelsAt(split + j);
    if (!label) continue;
    samples++;
    const posterior = test.posteriors[j] as number[];
    const guessedState = posterior.indexOf(Math.max(...posterior));
    const guessed = stateToLabel.get(guessedState) ?? "range";
    const cell = confusion[label] as Record<string, number>;
    cell[guessed] = (cell[guessed] ?? 0) + 1;
    if (guessed === label) correct++;
    const viterbiGuessed = stateToLabel.get(viterbi[j] as number);
    if (viterbiGuessed === label) viterbiCorrect++;
  }
  if (samples === 0) return { ...empty, mapping, fittedLabels: model.labels };

  return {
    samples,
    causal: correct / samples,
    viterbi: viterbiCorrect / samples,
    ceiling: supervisedCeiling(rows, split, labelsAt, distinct),
    causalLowerBound: wilsonLowerBound(correct, samples),
    mapping,
    confusion,
    fittedLabels: model.labels,
  };
}

/** Wilson score lower bound (95%) — the honest floor under an accuracy. */
function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - spread) / denom);
}

/**
 * The supervised ceiling: per-label Gaussian emissions from the training half,
 * plus the EMPIRICAL transition matrix of the true label sequence, filtered
 * causally. No generator parameter is assumed.
 */
function supervisedCeiling(
  rows: number[][],
  split: number,
  labelsAt: (row: number) => string | undefined,
  distinct: string[],
): number {
  const dims = (rows[0] as number[]).length;
  const stats = distinct.map((label) => {
    const sample = rows.slice(0, split).filter((_, j) => labelsAt(j) === label);
    const means = new Array<number>(dims).fill(0);
    for (const row of sample) for (let d = 0; d < dims; d++) (means[d] as number) += (row[d] as number);
    for (let d = 0; d < dims; d++) (means[d] as number) = sample.length > 0 ? ((means[d] as number) / sample.length) : 0;
    const variances = new Array<number>(dims).fill(0);
    for (const row of sample) {
      for (let d = 0; d < dims; d++) (variances[d] as number) += ((row[d] as number) - (means[d] as number)) ** 2;
    }
    for (let d = 0; d < dims; d++) {
      (variances[d] as number) = sample.length > 1 ? (variances[d] as number) / (sample.length - 1) : 1;
      if (!((variances[d] as number) > 1e-12)) (variances[d] as number) = 1e-12;
    }
    return { means, variances };
  });
  // Empirical transitions over the whole truth sequence (the labels are known,
  // so this is measurement, not estimation).
  const transition = distinct.map(() => new Array<number>(distinct.length).fill(0));
  const indexOf = new Map(distinct.map((label, i) => [label, i]));
  for (let j = 1; j < rows.length; j++) {
    const from = labelsAt(j - 1);
    const to = labelsAt(j);
    if (!from || !to) continue;
    const row = transition[indexOf.get(from) as number] as number[];
    row[indexOf.get(to) as number] = (row[indexOf.get(to) as number] as number) + 1;
  }
  for (const row of transition) {
    const total = row.reduce((a, b) => a + b, 0);
    for (let i = 0; i < row.length; i++) (row[i] as number) = total > 0 ? (row[i] as number) / total : 1 / row.length;
  }

  let alpha = distinct.map(() => Math.log(1 / distinct.length));
  let correct = 0;
  let samples = 0;
  for (let j = split; j < rows.length; j++) {
    const row = rows[j] as number[];
    const next = new Array<number>(distinct.length).fill(-Infinity);
    for (let s = 0; s < distinct.length; s++) {
      const terms: number[] = [];
      for (let p = 0; p < distinct.length; p++) {
        terms.push((alpha[p] as number) + Math.log(Math.max(1e-12, (transition[p] as number[])[s] as number)));
      }
      let emission = 0;
      for (let d = 0; d < dims; d++) {
        const variance = (stats[s] as { variances: number[] }).variances[d] as number;
        const delta = (row[d] as number) - ((stats[s] as { means: number[] }).means[d] as number);
        emission += -0.5 * (Math.log(2 * Math.PI * variance) + (delta * delta) / variance);
      }
      next[s] = logSumExpInline(terms) + emission;
    }
    const total = logSumExpInline(next);
    alpha = next.map((v) => v - total);
    const label = labelsAt(j);
    if (!label) continue;
    samples++;
    if (alpha.indexOf(Math.max(...alpha)) === indexOf.get(label)) correct++;
  }
  return samples === 0 ? 0 : correct / samples;
}
