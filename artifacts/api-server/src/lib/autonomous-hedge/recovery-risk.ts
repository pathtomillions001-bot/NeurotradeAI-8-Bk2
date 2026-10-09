/**
 * Recovery risk mathematics for the autonomous 1-tick engine.
 *
 * These functions deliberately produce soft adjustments rather than entry
 * vetoes. Recovery remains tick-driven; uncertainty and loss-run risk affect
 * ranking and exposure without forcing a multi-minute wait.
 */

export interface RecoverySafetyInput {
  posteriorEdgeProbability: number;
  lossRunRisk: number;
  instability: number;
  lossRun: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Standard normal CDF, accurate enough for a bounded scoring feature. */
export function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  // Abramowitz-Stegun 7.1.26; max error about 7.5e-8.
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - polynomial * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/**
 * Approximate posterior probability that a candidate's true win probability
 * exceeds break-even. The Beta posterior variance is used instead of treating
 * the sample proportion as known, which prevents small recovery samples from
 * looking artificially certain.
 */
export function posteriorEdgeProbability(input: {
  probability: number;
  samples: number;
  priorStrength: number;
  breakEven: number;
}): number {
  const mean = clamp(input.probability, 1e-6, 1 - 1e-6);
  const effectiveN = Math.max(1, input.samples + input.priorStrength + 1);
  const variance = Math.max(1e-12, (mean * (1 - mean)) / effectiveN);
  const z = (mean - input.breakEven) / Math.sqrt(variance);
  return clamp(normalCdf(z), 0, 1);
}

/**
 * Fraction of the requested recovery stake to expose. The factor is a smooth
 * product of edge confidence, regime stability, projected three-loss survival,
 * and a mild loss-run dampener. It is bounded so a good candidate can still
 * trade promptly, while an uncertain candidate cannot consume the full debt
 * ladder in one attempt.
 */
export function recoverySafetyFactor(input: RecoverySafetyInput): number {
  const edgeConfidence = clamp((input.posteriorEdgeProbability - 0.5) * 2, 0, 1);
  const stability = clamp(1 - 1.75 * Math.max(0, input.instability), 0.35, 1);
  const survival = clamp(1 - input.lossRunRisk, 0.35, 1);
  const streakDampener = 1 / (1 + 0.10 * Math.max(0, input.lossRun));
  const factor = 0.35 + 0.40 * edgeConfidence * stability * survival * streakDampener;
  return clamp(factor, 0.35, 0.75);
}
