/**
 * Recovery risk mathematics for the autonomous 1-tick engine.
 *
 * These helpers are used for soft candidate-ranking adjustments only.
 * Recovery remains tick-driven and the existing Instant/Split staking path is
 * intentionally kept in the recovery engine.
 */

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
