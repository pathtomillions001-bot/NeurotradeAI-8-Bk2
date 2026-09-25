/**
 * Recovery ladder for generated DBot strategies.
 *
 * The ladder is the account's OWN recovery math, precomputed at Create-Bot
 * time with the exact pure helpers every specialist bot uses
 * (`calculateBotRecoveryStake` + `applyRecoveryStakeLimits` from
 * lib/recovery-math): stake[0] is the normal stake; after k consecutive
 * losses the debt is the sum of the stakes already lost and stake[k] is the
 * smallest stake whose win recovers that debt plus the configured markup.
 *
 * The generated Blockly XML reproduces this ladder verbatim as
 * loss-streak → stake conditionals, so the DBot executes the same numbers
 * our server-side engines would — and when its results stream back through
 * the journaling bridge they land in the same single recovery ledger.
 */
import { applyRecoveryStakeLimits, calculateBotRecoveryStake } from "../recovery-math";
import type { DbotRecoverySpec } from "./manifest";

export const DERIV_MIN_STAKE = 0.35;

export interface RecoveryLadder {
  /** stakes[i] = stake to fire while the loss streak equals i (i = 0 → normal). */
  stakes: number[];
  /** Cumulative debt entering each streak level (debts[0] = 0). */
  debts: number[];
  maxSteps: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Precompute the debt-exact recovery ladder. Pure and deterministic — the
 * parity test replays it against the recovery engine's own transitions.
 */
export function computeRecoveryLadder(spec: DbotRecoverySpec): RecoveryLadder {
  const maxSteps = Math.max(1, Math.min(12, Math.floor(spec.maxSteps)));
  const stakes: number[] = [round2(Math.max(DERIV_MIN_STAKE, spec.baseStake))];
  const debts: number[] = [0];
  let debt = 0;
  for (let step = 1; step <= maxSteps; step++) {
    debt = round2(debt + stakes[step - 1]);
    debts.push(debt);
    const raw = calculateBotRecoveryStake(debt, spec.payoutMultiplier, spec.markupPercent);
    const limited = applyRecoveryStakeLimits(raw, spec.maxTradeStake, Number.POSITIVE_INFINITY);
    stakes.push(round2(Math.max(DERIV_MIN_STAKE, limited)));
  }
  return { stakes, debts, maxSteps };
}
