/**
 * Autonomous engine — adaptive recovery ladder (WP4, pure).
 *
 * The legacy ladder sizes the stake to the DEBT (Instant) or to one base stake
 * (Split) and ignores everything else; past ~19× base (Even/Odd) the expected
 * log-debt drift turns UP (D1) and once the max-stake/balance cap binds a win
 * can no longer clear the debt, so debt compounds (D2). The adaptive ladder
 * sizes to three budgets instead:
 *
 *   exact        = D / (payout − 1)                one-win clearance (T′ = 0, D4)
 *   lambdaEff    = lambda · descentScale(D, B)      soft descent near the budget
 *   candidate    = min(exact, max(base, lambdaEff · exact))
 *   stake        = clamp(candidate, minStake, headroomCap)
 *
 * - lambda ∈ (0,1] (default 0.5) controls how fast a win eats the debt. Every
 *   win shrinks debt by the factor (1 − lambdaEff·…), so the ladder always
 *   makes progress; it never promises a one-win clearance it cannot keep.
 * - headroomCap (WP4 headroom module) is φ·min(balance − reserve,
 *   drawdownHeadroom): a stake can never exceed the remaining drawdown budget,
 *   which is the defect D3 fix (the risk stops stay authoritative between
 *   trades AND within a single stake).
 * - Budget B (default 25× base): when D ≥ B·base the episode RE-BASES — the
 *   debt is realised as a logged loss and trading resumes at base stake. When
 *   even the base stake no longer fits under the headroom cap, the episode
 *   re-bases for the same reason: the ladder cannot continue without breaking
 *   the drawdown budget. A re-base never waits and never hides the loss.
 * - Soft descent: over the top half of the budget, lambdaEff scales linearly
 *   to zero so stakes STOP GROWING before the budget binds.
 */

export const ADAPTIVE_MIN_STAKE = 0.35;
export const ADAPTIVE_DEFAULT_LAMBDA = 0.5;
export const ADAPTIVE_DEFAULT_BUDGET_BASE = 25;
export const ADAPTIVE_DEFAULT_HEADROOM_PCT = 5;

export interface AdaptiveStakeInput {
  /** Outstanding loss debt D. */
  debt: number;
  /** Normal base stake. */
  baseStake: number;
  /** Total-return payout multiplier of the chosen contract. */
  payout: number;
  /** λ ∈ (0,1]: fraction of the exact clearance stake to risk. */
  lambda: number;
  /** φ·min(balance − reserve, drawdownHeadroom) for this tick. */
  headroomCap: number;
  /** Recovery budget B in multiples of base stake (re-base at D ≥ B·base). */
  budgetBase: number;
  minStake?: number;
}

export interface AdaptiveStakeResult {
  /** 0 when the episode must RE-BASE instead of staking. */
  stake: number;
  /** True when D ≥ B·base: realise the debt and restart at base stake. */
  rebaseBudget: boolean;
  /** True when even the base stake cannot fit under the headroom cap. */
  rebaseHeadroom: boolean;
  /** True when headroomCap cut the stake below the adaptive candidate. */
  partial: boolean;
  exact: number;
  lambdaEffective: number;
  /** Debt a win at this stake repays: stake·(payout − 1). */
  winRepayment: number;
}

/**
 * Soft-descent factor: 1 while D ≤ half the budget, then linear to 0 at the
 * budget. Stakes stop growing before the re-base point is hit.
 */
export function descentScale(debt: number, budgetAmount: number): number {
  if (!Number.isFinite(budgetAmount) || budgetAmount <= 0) return 1;
  const half = budgetAmount / 2;
  if (debt <= half) return 1;
  if (debt >= budgetAmount) return 0;
  return (budgetAmount - debt) / (budgetAmount - half);
}

export function computeAdaptiveStake(input: AdaptiveStakeInput): AdaptiveStakeResult {
  const minStake = Number.isFinite(input.minStake) && input.minStake! > 0
    ? input.minStake!
    : ADAPTIVE_MIN_STAKE;
  const debt = Math.max(0, Number.isFinite(input.debt) ? input.debt : 0);
  const base = Math.max(minStake, Number.isFinite(input.baseStake) && input.baseStake > 0 ? input.baseStake : minStake);
  const payout = Number.isFinite(input.payout) && input.payout > 1 ? input.payout : 1.95;
  const lambda = Math.min(1, Math.max(0.05, Number.isFinite(input.lambda) ? input.lambda : ADAPTIVE_DEFAULT_LAMBDA));
  const cap = Number.isFinite(input.headroomCap) ? Math.max(0, input.headroomCap) : Number.POSITIVE_INFINITY;
  const budgetBase = Number.isFinite(input.budgetBase) && input.budgetBase > 0
    ? input.budgetBase
    : ADAPTIVE_DEFAULT_BUDGET_BASE;
  const budgetAmount = budgetBase * base;

  // ── Budget re-base: D ≥ B·base. Realise and restart; never trade past it. ──
  if (debt >= budgetAmount) {
    return {
      stake: 0, rebaseBudget: true, rebaseHeadroom: false, partial: false,
      exact: debt / (payout - 1), lambdaEffective: 0, winRepayment: 0,
    };
  }

  const exact = debt / (payout - 1);
  const lambdaEffective = lambda * descentScale(debt, budgetAmount);
  const candidate = Math.min(exact, Math.max(base, lambdaEffective * exact));

  // ── Headroom re-base: even a base stake would break the drawdown budget. ──
  if (base > cap) {
    return {
      stake: 0, rebaseBudget: false, rebaseHeadroom: true, partial: false,
      exact, lambdaEffective, winRepayment: 0,
    };
  }

  const stake = Math.min(Math.max(candidate, minStake), cap);
  const winRepayment = stake * (payout - 1);
  return {
    stake,
    rebaseBudget: false,
    rebaseHeadroom: false,
    partial: stake < candidate - 1e-12,
    exact,
    lambdaEffective,
    winRepayment,
  };
}

/**
 * The debt after one settled outcome at the given stake — the transition the
 * WP5 Markov DP and the harness ladder both use.
 */
export function adaptiveDebtAfter(debt: number, stake: number, payout: number, won: boolean): number {
  if (won) return Math.max(0, debt - stake * (payout - 1));
  return debt + stake;
}
