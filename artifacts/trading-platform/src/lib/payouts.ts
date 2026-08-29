/**
 * Canonical fallback payout schedule shown in the UI.
 * Values are total returns for a winning $1 stake, including that $1 stake.
 * Net profit rate is therefore `payout - 1`.
 */

export const OVER_PAYOUTS: Readonly<Record<number, number>> = Object.freeze({
  0: 1.09,
  1: 1.23,
  2: 1.40,
  3: 1.63,
  4: 1.95,
  5: 2.43,
  6: 3.21,
  7: 4.72,
  8: 8.93,
});

export const UNDER_PAYOUTS: Readonly<Record<number, number>> = Object.freeze({
  9: 1.09,
  8: 1.23,
  7: 1.40,
  6: 1.63,
  5: 1.95,
  4: 2.43,
  3: 3.21,
  2: 4.72,
  1: 8.93,
});

export const EVEN_ODD_PAYOUT = 1.95;
export const RISE_FALL_PAYOUT = 1.92;
export const MATCH_PAYOUT = 8.93;
export const DIFF_PAYOUT = 1.09;

export type PayoutContractType =
  | "CALL" | "PUT" | "RISE" | "FALL"
  | "DIGITOVER" | "DIGITUNDER"
  | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF";

export function getFallbackPayout(type: PayoutContractType, barrier?: number): number {
  switch (type) {
    case "CALL":
    case "PUT":
    case "RISE":
    case "FALL":
      return RISE_FALL_PAYOUT;
    case "DIGITEVEN":
    case "DIGITODD":
      return EVEN_ODD_PAYOUT;
    case "DIGITMATCH":
      return MATCH_PAYOUT;
    case "DIGITDIFF":
      return DIFF_PAYOUT;
    case "DIGITOVER":
      return OVER_PAYOUTS[barrier ?? 4] ?? OVER_PAYOUTS[4];
    case "DIGITUNDER":
      return UNDER_PAYOUTS[barrier ?? 5] ?? UNDER_PAYOUTS[5];
  }
}

/** Exact stake needed for a win to clear debt and optionally retain the sizing-target profit. */
export function exactRecoveryStake(
  unrecoveredAmount: number,
  targetProfit: number,
  payoutMultiplier: number,
): number {
  const netProfitRate = payoutMultiplier - 1;
  if (netProfitRate <= 0) return 0;
  return (Math.max(0, unrecoveredAmount) + Math.max(0, targetProfit)) / netProfitRate;
}

export function roundRecoveryStakeUp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil((value - 1e-9) * 100) / 100;
}
