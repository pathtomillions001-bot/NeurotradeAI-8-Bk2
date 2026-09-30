/** Universal Adaptive Forge analysis primitives.
 *
 * This module is deliberately pure: the DBot generator and the live executor can
 * use the same decisions without sharing mutable state. It is contract agnostic
 * at the framework level, while callers provide the contract's payout and win
 * predicate. No recovery stake is increased by this module.
 */
export type AdaptiveOutcome = "win" | "loss";

export interface AdaptiveObservation {
  outcome: AdaptiveOutcome;
  /** Optional binary feature value for a contract-specific win predicate. */
  value?: boolean;
}

export interface AdaptiveInput {
  observations: AdaptiveObservation[];
  payout: number;
  priorProbability?: number;
  confidenceLevel?: number;
  minimumSample?: number;
  entropyLimit?: number;
}

export interface AdaptiveReading {
  sample: number;
  wins: number;
  losses: number;
  posteriorProbability: number;
  lowerBound: number;
  entropy: number;
  changePoint: boolean;
  expectedValue: number;
  breakEvenProbability: number;
  eligible: boolean;
  reasons: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Wilson lower bound; conservative confidence is safer than raw win rate. */
export function wilsonLowerBound(wins: number, sample: number, confidence = 0.9): number {
  if (sample <= 0) return 0;
  const z = confidence >= 0.99 ? 2.576 : confidence >= 0.95 ? 1.96 : 1.645;
  const p = wins / sample;
  const denominator = 1 + (z * z) / sample;
  const centre = p + (z * z) / (2 * sample);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * sample)) / sample);
  return clamp((centre - spread) / denominator, 0, 1);
}

/** Shannon entropy of a binary tape, normalized to [0, 1]. */
export function binaryEntropy(wins: number, losses: number): number {
  const total = wins + losses;
  if (!total) return 1;
  const p = wins / total;
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

/** Detects a meaningful split-half distribution shift, not a one-tick streak. */
export function hasChangePoint(observations: AdaptiveObservation[], minimumHalf = 12): boolean {
  if (observations.length < minimumHalf * 2) return false;
  const midpoint = Math.floor(observations.length / 2);
  const rate = (slice: AdaptiveObservation[]) => slice.filter(x => x.outcome === "win").length / slice.length;
  return Math.abs(rate(observations.slice(0, midpoint)) - rate(observations.slice(midpoint))) >= 0.25;
}

/**
 * Produces a conservative, payout-aware gate. `payout` is net profit per unit
 * stake (not total return), matching Deriv proposal semantics.
 */
export function evaluateAdaptive(input: AdaptiveInput): AdaptiveReading {
  const observations = input.observations.filter(x => x.outcome === "win" || x.outcome === "loss");
  const wins = observations.filter(x => x.outcome === "win").length;
  const losses = observations.length - wins;
  const sample = observations.length;
  const prior = clamp(input.priorProbability ?? 0.5, 0.01, 0.99);
  // A 20-observation prior keeps tiny tapes close to fair odds.
  const posteriorProbability = (wins + 20 * prior) / (sample + 20);
  const lowerBound = wilsonLowerBound(wins + 10 * prior, sample + 20, input.confidenceLevel ?? 0.9);
  const entropy = binaryEntropy(wins, losses);
  const payout = Math.max(0, input.payout);
  const breakEvenProbability = payout > 0 ? 1 / (1 + payout) : 1;
  const expectedValue = posteriorProbability * payout - (1 - posteriorProbability);
  const reasons: string[] = [];
  if (sample < (input.minimumSample ?? 30)) reasons.push("insufficient sample");
  if (input.entropyLimit !== undefined && entropy > input.entropyLimit) reasons.push("high entropy");
  if (hasChangePoint(observations)) reasons.push("distribution changed");
  if (lowerBound <= breakEvenProbability) reasons.push("no conservative payout edge");
  return {
    sample, wins, losses, posteriorProbability, lowerBound, entropy,
    changePoint: hasChangePoint(observations), expectedValue, breakEvenProbability,
    eligible: reasons.length === 0,
    reasons,
  };
}

/** Recovery is a gate, never a prediction: it must use a fresh qualifying tape. */
export function recoveryAllowed(reading: AdaptiveReading, consecutiveLosses: number, maxSteps: number): boolean {
  return consecutiveLosses > 0 && consecutiveLosses <= maxSteps && reading.eligible && reading.changePoint === false;
}
