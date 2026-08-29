/**
 * Canonical payout multipliers used when a live Deriv proposal is unavailable.
 *
 * IMPORTANT: each value is the TOTAL amount returned for a winning $1 stake,
 * including the original $1 stake. Recovery calculations must therefore use
 * `payoutMultiplier - 1` as the net profit rate.
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

const allDigitPayouts = (value: number): Readonly<Record<number, number>> =>
  Object.freeze(Object.fromEntries(Array.from({ length: 10 }, (_, digit) => [digit, value])));

/** Barrier-aware digit payout table retained as the canonical agent interface. */
export const DIGIT_PAYOUTS: Readonly<Record<string, Readonly<Record<number, number>>>> = Object.freeze({
  DIGITOVER: OVER_PAYOUTS,
  DIGITUNDER: UNDER_PAYOUTS,
  DIGITMATCH: allDigitPayouts(MATCH_PAYOUT),
  DIGITDIFF: allDigitPayouts(DIFF_PAYOUT),
});

export const DEFAULT_CONTRACT_PAYOUTS: Readonly<Record<string, number>> = Object.freeze({
  CALL: RISE_FALL_PAYOUT,
  PUT: RISE_FALL_PAYOUT,
  RISE: RISE_FALL_PAYOUT,
  FALL: RISE_FALL_PAYOUT,
  DIGITOVER: OVER_PAYOUTS[4],
  DIGITUNDER: UNDER_PAYOUTS[5],
  DIGITEVEN: EVEN_ODD_PAYOUT,
  DIGITODD: EVEN_ODD_PAYOUT,
  DIGITMATCH: MATCH_PAYOUT,
  DIGITDIFF: DIFF_PAYOUT,
});

/**
 * Return the configured fallback payout for a contract and barrier.
 * A live proposal should take precedence whenever one is available.
 */
export function getFallbackPayout(contractType: string, barrier?: number | null): number {
  const normalized = contractType === "RISE" ? "CALL"
    : contractType === "FALL" ? "PUT"
    : contractType;

  if (normalized === "DIGITOVER") {
    return OVER_PAYOUTS[barrier ?? 4] ?? OVER_PAYOUTS[4];
  }
  if (normalized === "DIGITUNDER") {
    return UNDER_PAYOUTS[barrier ?? 5] ?? UNDER_PAYOUTS[5];
  }
  return DEFAULT_CONTRACT_PAYOUTS[normalized] ?? RISE_FALL_PAYOUT;
}
