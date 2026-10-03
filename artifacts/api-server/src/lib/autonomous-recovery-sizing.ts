import * as recoveryEngine from "./agents/recovery-engine";
import type { TradingSettings } from "./agents/types";

/** Main-engine adapter for the original Split/Instant, Auto/Manual policy.
 * Do not substitute confidence/Kelly caps for the user's selected sizing mode.
 */
export function autonomousRecoveryStake(
  settings: TradingSettings,
  balance: number,
  payoutMultiplier: number,
  winProbability: number,
): number {
  const riskBaseAmount = settings.riskAmountType === "percentage"
    ? balance * settings.riskAmountValue / 100
    : settings.riskAmountValue;
  const raw = recoveryEngine.getDynamicRecoveryStake(
    Math.max(0.35, Math.min(riskBaseAmount, settings.maxTradeStake)),
    settings.maxTradeStake, balance, payoutMultiplier, winProbability,
    settings.riskProfile, settings.recoveryMultiplier, settings.recoveryMethod,
    settings.maxRecoverySteps, settings.recoveryAutoMode,
  );
  // Preserve the original upward cent rounding. Reject an unfundable minimum
  // rather than silently replacing the requested mode with another formula.
  const stake = Math.max(0.35, Math.min(raw, settings.maxTradeStake));
  return Number.isFinite(stake) && stake <= balance && stake <= settings.maxTradeStake ? stake : 0;
}
