/**
 * Multi-Asset Desk — discrete Markov model of market state.
 *
 * The market is discretised into (direction × volatility) states. From the
 * observed sequence we estimate a transition matrix with Laplace smoothing,
 * which answers the question the agent actually needs:
 *
 *   "Given that we are in a strong-up / normal-vol state right now, what is
 *    the probability we are still in a favourable state in N bars — i.e. long
 *    enough for this trade to reach its target?"
 *
 * Smoothing matters: without it, a state pair never seen in the sample gets
 * probability exactly 0, and the agent becomes falsely certain from a handful
 * of bars.
 */

import { clamp, logReturns, mean, stdev } from "./math";

export const MARKOV_STATES = [
  "strong_down",
  "down",
  "flat",
  "up",
  "strong_up",
] as const;

export type MarkovState = (typeof MARKOV_STATES)[number];

export interface MarkovModel {
  /** Row-stochastic matrix; `matrix[from][to]`. */
  matrix: number[][];
  /** Raw observed counts, before smoothing — exposes sample adequacy. */
  counts: number[][];
  states: readonly MarkovState[];
  /** Number of transitions observed. */
  samples: number;
  current: MarkovState;
}

/**
 * Classify each return into a directional state, scaled by the sample's
 * volatility.
 *
 * The scaling divisor is the standard deviation, but the states are measured
 * against ZERO rather than against the sample mean. That distinction matters:
 * de-meaning would classify a steady, strongly trending market as `flat`
 * (every return sits at its own mean), leaving `directionalPersistence`
 * blind to exactly the condition it exists to detect.
 *
 * Thresholds at ±0.5σ and ±1.5σ give five buckets that stay meaningful for a
 * normal-ish return distribution while keeping the tails informative.
 */
export function classifyReturns(returns: number[]): MarkovState[] {
  if (returns.length === 0) return [];
  const sd = stdev(returns);

  // A zero-variance series is a perfectly constant drift. There is no
  // dispersion to scale by, so fall back to the sign of the move — and stay
  // in the moderate bucket, since a constant return is not an outlier.
  if (sd === 0) {
    const m = mean(returns);
    const state: MarkovState = m > 0 ? "up" : m < 0 ? "down" : "flat";
    return returns.map(() => state);
  }

  return returns.map((r) => {
    const z = r / sd;
    if (z <= -1.5) return "strong_down";
    if (z <= -0.5) return "down";
    if (z < 0.5) return "flat";
    if (z < 1.5) return "up";
    return "strong_up";
  });
}

/** Estimate the transition matrix from a state sequence. */
export function fitMarkov(sequence: MarkovState[], smoothing = 1): MarkovModel {
  const n = MARKOV_STATES.length;
  const counts: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const index = new Map<MarkovState, number>(MARKOV_STATES.map((s, i) => [s, i]));

  for (let i = 1; i < sequence.length; i++) {
    const from = index.get(sequence[i - 1]);
    const to = index.get(sequence[i]);
    if (from === undefined || to === undefined) continue;
    counts[from][to]++;
  }

  const matrix = counts.map((row) => {
    const smoothed = row.map((c) => c + smoothing);
    const total = smoothed.reduce((a, b) => a + b, 0);
    return total === 0 ? row.map(() => 1 / n) : smoothed.map((c) => c / total);
  });

  return {
    matrix,
    counts,
    states: MARKOV_STATES,
    samples: Math.max(sequence.length - 1, 0),
    current: sequence.length > 0 ? sequence[sequence.length - 1] : "flat",
  };
}

/** Build the model straight from a price series. */
export function markovFromPrices(prices: number[], smoothing = 1): MarkovModel {
  return fitMarkov(classifyReturns(logReturns(prices)), smoothing);
}

/** Distribution over states `steps` ahead, starting from `from`. */
export function nStepDistribution(
  model: MarkovModel,
  steps: number,
  from: MarkovState = model.current,
): Record<MarkovState, number> {
  const n = MARKOV_STATES.length;
  const startIdx = MARKOV_STATES.indexOf(from);
  let vec = new Array<number>(n).fill(0);
  vec[startIdx >= 0 ? startIdx : 2] = 1;

  for (let s = 0; s < Math.max(0, Math.floor(steps)); s++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (vec[i] === 0) continue;
      for (let j = 0; j < n; j++) next[j] += vec[i] * model.matrix[i][j];
    }
    vec = next;
  }

  const out = {} as Record<MarkovState, number>;
  MARKOV_STATES.forEach((state, i) => {
    out[state] = vec[i];
  });
  return out;
}

/** Long-run (stationary) distribution, by power iteration. */
export function stationaryDistribution(model: MarkovModel, iterations = 200): Record<MarkovState, number> {
  return nStepDistribution(model, iterations, model.current);
}

/**
 * Probability that the market stays *directionally favourable* for `steps`
 * bars — the quantity the A+ gate tests.
 *
 * "Favourable" for a long is any up state; `flat` counts at half weight
 * because a drifting market neither helps nor kills a trade, and treating it
 * as a loss would reject every pullback entry.
 */
export function directionalPersistence(
  model: MarkovModel,
  direction: "up" | "down",
  steps: number,
): number {
  const dist = nStepDistribution(model, steps);
  const aligned = direction === "up" ? dist.up + dist.strong_up : dist.down + dist.strong_down;
  return clamp(aligned + dist.flat * 0.5, 0, 1);
}

/** Expected drift per bar implied by the n-step distribution, in σ units. */
export function expectedDriftSigma(model: MarkovModel, steps: number): number {
  const dist = nStepDistribution(model, steps);
  // Bucket midpoints in z-space, matching classifyReturns' thresholds.
  return (
    dist.strong_down * -2 +
    dist.down * -1 +
    dist.flat * 0 +
    dist.up * 1 +
    dist.strong_up * 2
  );
}

/**
 * How much the model actually knows. Few samples → the agent must not treat
 * its persistence estimate as reliable, so the A+ gate scales confidence by
 * this value.
 */
export function sampleConfidence(model: MarkovModel, target = 200): number {
  return clamp(model.samples / target, 0, 1);
}
