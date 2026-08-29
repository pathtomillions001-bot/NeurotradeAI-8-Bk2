/** Round a requested stake upward to cents so decimal rounding never under-recovers. */
export function roundRecoveryStakeUp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil((value - 1e-9) * 100) / 100;
}

/**
 * Convert an account-currency amount to an integer minor unit (cents for USD).
 * Avoids IEEE-754 noise that can invent phantom debt or leftover target.
 */
export function toCents(amount: number, precision = 2): number {
  const scale = 10 ** precision;
  const n = Number.isFinite(amount) ? amount : 0;
  return Math.round(n * scale);
}

/** Convert integer minor units back to a major-unit amount. */
export function fromCents(cents: number, precision = 2): number {
  const scale = 10 ** precision;
  return cents / scale;
}

/** Add account-currency amounts at integer-cent precision. */
export function addMoney(...amounts: number[]): number {
  return fromCents(amounts.reduce((sum, amount) => sum + toCents(amount), 0));
}

export interface SettleRecoveryWinInput {
  unrecoveredAmount: number;
  remainingTargetProfit: number;
  actualNetProfit: number;
  currencyPrecision?: number;
}

export interface SettleRecoveryWinResult {
  remainingDebt: number;
  debtRecovered: number;
  excessProfit: number;
  remainingTargetProfit: number;
  recoveryComplete: boolean;
}

/**
 * Shared recovery-win settlement used by the main autonomous engine and NeuroAI FAB.
 *
 * Mandatory obligation is only `unrecoveredAmount` (loss debt).
 * `remainingTargetProfit` is a soft sizing target: it may absorb excess profit
 * after debt is paid, but it must never keep recovery active.
 *
 * Previous completion rule (the extra-trade regression):
 *   remainingDebt + remainingTarget <= 0.005
 * That treated a $0.01 leftover target as an unpaid obligation after a win that
 * had already repaid every cent of debt.
 */
export function settleRecoveryWin(input: SettleRecoveryWinInput): SettleRecoveryWinResult {
  const precision = input.currencyPrecision ?? 2;
  const debtCents = Math.max(0, toCents(input.unrecoveredAmount, precision));
  const profitCents = Math.max(0, toCents(input.actualNetProfit, precision));
  const targetCents = Math.max(0, toCents(input.remainingTargetProfit, precision));

  const debtRecoveredCents = Math.min(debtCents, profitCents);
  const remainingDebtCents = Math.max(0, debtCents - debtRecoveredCents);
  const excessProfitCents = Math.max(0, profitCents - debtRecoveredCents);
  const remainingTargetCents = Math.max(0, targetCents - excessProfitCents);

  return {
    remainingDebt: fromCents(remainingDebtCents, precision),
    debtRecovered: fromCents(debtRecoveredCents, precision),
    excessProfit: fromCents(excessProfitCents, precision),
    remainingTargetProfit: fromCents(remainingTargetCents, precision),
    // Debt-only completion. A leftover $0.01 target is not debt.
    recoveryComplete: remainingDebtCents === 0,
  };
}

/**
 * Payout multipliers are total winning returns and include the original stake.
 * The net profit rate available to repay debt is therefore `payout - 1`.
 *
 * Target profit is included here only as an aspirational sizing input so a
 * single recovery win can attempt to cover debt plus desired profit. It is
 * never a mandatory completion condition.
 */
export function calculateExactRecoveryStake(
  unrecoveredAmount: number,
  remainingTargetProfit: number,
  payoutMultiplier: number,
): number {
  const netProfitRate = payoutMultiplier - 1;
  if (!Number.isFinite(netProfitRate) || netProfitRate <= 0) return 0;
  return (Math.max(0, unrecoveredAmount) + Math.max(0, remainingTargetProfit)) / netProfitRate;
}

export interface RecoveryStakeRequest {
  unrecoveredAmount: number;
  remainingTargetProfit: number;
  payoutMultiplier: number;
  baseStake: number;
  recoveryAutoMode: boolean;
  recoveryMethod: "split" | "instant";
  recoveryMultiplier: number;
  recoveryStep: number;
  maxRecoverySteps: number;
}

/**
 * Shared stake policy used by both the main autonomous engine and NeuroAI FAB.
 * Keeping this decision in one pure function prevents the two recovery panels
 * from silently applying different formulas.
 */
export function calculateRecoveryStakeRequest(input: RecoveryStakeRequest): number {
  const exactStake = calculateExactRecoveryStake(
    input.unrecoveredAmount,
    input.remainingTargetProfit,
    input.payoutMultiplier,
  );
  const baseStake = Number.isFinite(input.baseStake) && input.baseStake > 0
    ? input.baseStake
    : 0.35;

  let requestedStake: number;
  if (input.recoveryAutoMode) {
    // Auto Instant: exact one-win target. Auto Split: exact target capped at one
    // base stake, with all remaining debt/target carried to the next attempt.
    requestedStake = input.recoveryMethod === "instant"
      ? exactStake
      : Math.min(exactStake, baseStake);
  } else {
    // Manual mode never substitutes a payout-implied multiplier. The value is
    // used as entered and compounds only up to the configured maximum step.
    const multiplier = Number.isFinite(input.recoveryMultiplier)
      ? input.recoveryMultiplier
      : 1;
    const stepLimit = input.maxRecoverySteps > 0
      ? input.maxRecoverySteps
      : Math.max(1, input.recoveryStep);
    const step = Math.max(1, Math.min(Math.max(1, input.recoveryStep), stepLimit));
    const manualStake = baseStake * Math.pow(multiplier, step);

    // Split treats the manual ladder as a cap; Instant follows it directly.
    requestedStake = input.recoveryMethod === "split"
      ? Math.min(exactStake, manualStake)
      : manualStake;
  }

  return Number.isFinite(requestedStake) && requestedStake > 0
    ? requestedStake
    : 0.35;
}

/** Apply explicit execution limits and round upward without crossing those limits. */
export function applyRecoveryStakeLimits(
  requestedStake: number,
  maxTradeStake: number,
  availableBalance = Number.POSITIVE_INFINITY,
): number {
  const configuredCap = Number.isFinite(maxTradeStake) && maxTradeStake > 0
    ? maxTradeStake
    : Number.POSITIVE_INFINITY;
  const balanceCap = Number.isFinite(availableBalance) && availableBalance > 0
    ? availableBalance
    : Number.POSITIVE_INFINITY;
  const hardCap = Math.min(configuredCap, balanceCap);
  const capped = Math.min(Math.max(0.35, requestedStake), hardCap);
  const rounded = roundRecoveryStakeUp(capped);
  const roundedCap = Number.isFinite(hardCap)
    ? Math.floor((hardCap + 1e-9) * 100) / 100
    : rounded;
  return Math.max(0.35, Math.min(rounded, roundedCap));
}
