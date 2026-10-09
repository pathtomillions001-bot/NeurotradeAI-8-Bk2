/**
 * Recovery risk mathematics for the autonomous 1-tick engine.
 *
 * Implements the model in docs/recovery-trade-mathematical-design.md:
 *
 *   - a Beta-posterior estimate of the probability that a candidate's TRUE win
 *     rate beats payout break-even, P(p > p_BE | D);
 *   - a three-loss stress indicator R_3L built from first-order Markov
 *     transitions;
 *   - the loss-streak weight that makes recovery RANKING respond to a growing
 *     consecutive-loss run.
 *
 * These helpers are used for soft candidate-ranking adjustments only. Recovery
 * remains tick-driven, no time-based entry gate is added, and the existing
 * Instant/Split staking path in the recovery engine is intentionally untouched
 * (the staking invariant in the design document).
 */

import { HEDGE_LIMITS } from "./constants";

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
 * exceeds break-even:
 *
 *   P(p > p_BE | D) ≈ Φ((p̄ − p_BE) / √Var(p)),   Var(p) ≈ p̄(1 − p̄)/(w + l + s + 1)
 *
 * The Beta posterior variance is used instead of treating the sample proportion
 * as known, which prevents small recovery samples from looking artificially
 * certain: a 55% observed win rate on 20 samples is not ranked like a 55% win
 * rate on 2,000 samples.
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

/** Beta posterior variance of the win rate, Var(p) ≈ p̄(1 − p̄)/(n + s + 1). */
export function posteriorVariance(probability: number, samples: number, priorStrength: number): number {
  const mean = clamp(probability, 1e-6, 1 - 1e-6);
  const effectiveN = Math.max(1, samples + priorStrength + 1);
  return Math.max(0, (mean * (1 - mean)) / effectiveN);
}

/**
 * Probability of three future losses after the current recovery state:
 *
 *   R_3L ≈ (1 − q_L→W) · q_L→L²
 *
 * `afterLossWin` is the engine's current estimate of q_L→W (the long-run
 * conditional win rate after a loss, blended toward the recent 40-tick window
 * when the tape is unstable — see hedge-analysis.ts). `lossToLoss` is
 * q_L→L = (LL + 1)/(LL + LW + 2).
 *
 * This is not a claim that the sequence is exactly Markovian. It is a compact
 * stress indicator: a candidate with a high chance of another loss immediately
 * after a loss is less suitable for recovery even when its unconditional EV is
 * attractive.
 */
export function threeLossRunRisk(input: { afterLossWin: number; lossToLoss: number }): number {
  const win = clamp(input.afterLossWin, 0, 1);
  const lossToLoss = clamp(input.lossToLoss, 0, 1);
  return clamp((1 - win) * lossToLoss * lossToLoss, 0, 1);
}

/**
 * How deep the account is into the CURRENT recovery episode.
 *
 * `streakLossCount` is the live consecutive-loss run; it is reset by any win and
 * by a cooldown auto-resume. `recoveryStep` only advances on a recovery loss and
 * only clears when the debt is fully repaid, so it survives a cooldown. Taking
 * the maximum keeps the escalation honest across a cooldown instead of silently
 * restarting the ladder at zero while the same debt is still outstanding.
 */
export function recoveryEscalation(lossRun: number, recoveryStep: number): number {
  const run = Number.isFinite(lossRun) ? Math.max(0, Math.floor(lossRun)) : 0;
  const step = Number.isFinite(recoveryStep) ? Math.max(0, Math.floor(recoveryStep)) : 0;
  return Math.max(run, step);
}

/**
 * Loss-streak weight on the two directional recovery risk terms.
 *
 * The design document requires the engine to change "candidate ranking when
 * uncertainty, clustering, or a loss streak rises while leaving exposure sizing
 * unchanged". This is that response: a bounded multiplier that grows from 1.0 to
 * 1 + recoveryRiskWeightMax as the escalation reaches recoveryEscalationCap.
 *
 * It widens the score gap between well-evidenced and poorly-evidenced recovery
 * candidates, so a deep run re-orders the choice instead of pausing the engine.
 * It is deliberately small enough that the established EV, confidence interval,
 * instability and clustering terms remain influential, and it never touches a
 * stake.
 */
export function recoveryRiskWeight(escalation: number): number {
  const cap = HEDGE_LIMITS.recovery.escalationCap;
  const max = HEDGE_LIMITS.recovery.riskWeightMax;
  const depth = clamp(Number.isFinite(escalation) ? escalation : 0, 0, cap);
  return 1 + (max * depth) / cap;
}
