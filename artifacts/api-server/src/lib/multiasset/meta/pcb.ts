/**
 * WP5 — the probability the gatekeeper is allowed to use: p_LCB.
 *
 * ── WHY A POINT ESTIMATE IS NOT ENOUGH ──────────────────────────────────────
 *
 * The gatekeeper (WP6) decides from
 *
 *   EV_LCB = p_LCB · (k + 1) − 1 − c
 *
 * where `k` is the target multiple in R and `c` the round-trip cost in R. Feed it
 * the calibrated point estimate p̂ and a model that is 3 points overconfident
 * produces a positive EV on trades that are actually negative — and it does so
 * most often exactly where the sample is thinnest, because that is where the
 * estimate is noisiest. The desk would then take its worst trades with the most
 * confidence.
 *
 * So the number that reaches the money is a LOWER confidence bound: the smallest
 * probability consistent with the evidence at 95% one-sided confidence. Two
 * things make it honest rather than decorative:
 *
 *   • **It uses the effective sample size, not the row count.** Overlapping
 *     labels are weighted down (`uniqueness.ts`), and the bound is computed from
 *     the Kish effective size of the sample the calibration rests on. A model
 *     with 4,000 overlapping rows and 300 effective observations gets the bound
 *     of 300 — which is the whole point of weighting them.
 *   • **It is a Wilson bound, not a normal approximation.** Wilson stays inside
 *     [0, 1] and behaves at small n, where the desk lives before it has history;
 *     a normal bound at n = 12 cheerfully reports a negative probability.
 *
 * p_LCB is reported BESIDE p̂ everywhere (the journal, the report, the rejection
 * sentence). A trade refused on p_LCB when p̂ was comfortably above the bar is
 * the system working as designed: the evidence was not strong enough yet.
 */
import { wilsonInterval } from "../alpha/edge";

/** One-sided confidence for the bound: 95%. */
export const DEFAULT_LCB_Z = 1.645;

/** Kish effective sample size of a weighted sample: (Σw)² / Σw². */
export function effectiveSampleSize(weights: number[]): number {
  let sum = 0;
  let sumSq = 0;
  for (const w of weights) {
    sum += w;
    sumSq += w * w;
  }
  return sumSq > 0 ? (sum * sum) / sumSq : 0;
}

/**
 * Lower confidence bound on a probability estimated from `nEff` observations.
 *
 * With nEff below 1 the bound is 0: a probability the desk cannot support is a
 * probability the desk may not trade, and returning p̂ here would be the exact
 * failure this function exists to prevent.
 */
export function probabilityLowerBound(p: number, nEff: number, z = DEFAULT_LCB_Z): number {
  const clipped = Math.max(0, Math.min(1, p));
  if (!(nEff >= 1)) return 0;
  const interval = wilsonInterval(clipped * nEff, nEff, z);
  return Math.max(0, Math.min(clipped, interval.lower));
}

/**
 * Expected value in R at the lower bound, net of costs.
 *
 *   EV_LCB = p_LCB · (k + 1) − 1 − c
 *
 * The formula is the desk's own R arithmetic: a win pays k R, a loss costs 1 R,
 * and the round trip costs `c` R whichever way it goes. It is stated as a
 * function so the gatekeeper, the journal and the tests can never disagree about
 * what the number means.
 */
export function expectedValueLowerBound(input: {
  pLcb: number;
  targetMultipleR: number;
  costR: number;
}): number {
  return input.pLcb * (input.targetMultipleR + 1) - 1 - input.costR;
}

/** The realised-frequency check for a batch of decisions (for reports). */
export function realisedRate(hits: number, n: number): { rate: number; lower: number; upper: number } {
  const interval = wilsonInterval(hits, n);
  return { rate: n > 0 ? hits / n : 0, lower: interval.lower, upper: interval.upper };
}
