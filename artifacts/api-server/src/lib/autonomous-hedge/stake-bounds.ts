/**
 * Autonomous engine — stake shape the broker will accept.
 *
 * Stake limits are denominated in the ACCOUNT'S currency, so a single USD
 * constant cannot serve every login: 0.35 means 35 cents in a USD account and
 * roughly a third of a bitcoin in a BTC one, and the broker rejects a proposal
 * whose amount is outside its own min/max for that symbol. The authoritative
 * range comes from `contracts_for` (see `getAccountStakeBounds` in deriv.ts);
 * these helpers only shape the number once the range is known.
 */

/** Currencies whose stake the broker accepts at 2 decimals. Everything else
 *  (crypto accounts) needs finer precision, or the minimum is rounded away. */
const TWO_DECIMAL_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "NOK", "SEK", "DKK", "PLN", "ZAR",
]);

export function isTwoDecimalCurrency(currency: string): boolean {
  return TWO_DECIMAL_CURRENCIES.has((currency || "USD").trim().toUpperCase());
}

/** Round a stake to the decimals the broker accepts for this currency. */
export function roundStake(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) return amount;
  const decimals = isTwoDecimalCurrency(currency) ? 2 : 8;
  const factor = 10 ** decimals;
  return Math.round(amount * factor) / factor;
}

/**
 * Bring a stake inside the broker's own range for this account. Returns null
 * when no stake in range is affordable, so the caller holds instead of sending
 * a proposal the exchange is bound to reject.
 */
export function clampStakeToBounds(args: {
  amount: number;
  currency: string;
  minStake?: number;
  maxStake?: number;
  balance: number;
  /** Floor applied when the broker reports no minimum. */
  fallbackMin: number;
}): number | null {
  const min = args.minStake && args.minStake > 0 ? args.minStake : args.fallbackMin;
  let stake = roundStake(args.amount, args.currency);
  if (!Number.isFinite(stake) || stake <= 0) return null;
  if (args.maxStake && args.maxStake > 0 && stake > args.maxStake) stake = roundStake(args.maxStake, args.currency);
  if (min > 0 && stake < min) stake = roundStake(min, args.currency);
  if (!Number.isFinite(stake) || stake <= 0) return null;
  if (min > 0 && stake < min) return null;          // rounding dropped it below the floor
  if (args.balance > 0 && stake > args.balance) return null;
  return stake;
}
