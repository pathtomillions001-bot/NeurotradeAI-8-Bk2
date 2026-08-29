import { addMoney, settleRecoveryWin } from "./recovery-math";

export type SpeedRecoveryContractType =
  | "DIGITOVER" | "DIGITUNDER"
  | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF"
  | "CALL" | "PUT";

export interface RecoveryTradeRecord {
  contractType: SpeedRecoveryContractType;
  barrier: number | undefined;
  won: boolean;
}

export interface SpeedRecoveryState {
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  baseStake: number;
  targetProfit: number;
  remainingTargetProfit: number;
  originPayoutMultiplier: number;
  consecutiveRecoveryLosses: number;
  recentRecoveryTrades: RecoveryTradeRecord[];
}

/**
 * NeuroAI FAB recovery settlement. Uses the same settleRecoveryWin helper as
 * the main autonomous engine so both engines share debt-only completion.
 *
 * Previous FAB path treated remainingDebt <= 0.01 as complete, which would
 * also exit when a real $0.01 of debt remained. Completion is now exact cents.
 */
export function recordRecoveryOutcome(
  rec: SpeedRecoveryState,
  won: boolean,
  profit: number,
  stake: number,
  maxSteps: number,
  payoutMultiplier: number,
  tradeContractType?: SpeedRecoveryContractType,
  tradeBarrier?: number,
): SpeedRecoveryState {
  let recentTrades = rec.recentRecoveryTrades;
  if (tradeContractType) {
    const record: RecoveryTradeRecord = { contractType: tradeContractType, barrier: tradeBarrier, won };
    recentTrades = [...recentTrades, record].slice(-8);
  }

  if (won) {
    if (rec.inRecovery) {
      const settlement = settleRecoveryWin({
        unrecoveredAmount: rec.unrecoveredAmount,
        remainingTargetProfit: rec.remainingTargetProfit,
        actualNetProfit: profit,
      });
      if (settlement.recoveryComplete) {
        return {
          inRecovery: false,
          recoveryStep: 0,
          unrecoveredAmount: 0,
          baseStake: rec.baseStake,
          targetProfit: 0,
          remainingTargetProfit: 0,
          originPayoutMultiplier: 1,
          consecutiveRecoveryLosses: 0,
          recentRecoveryTrades: [],
        };
      }
      return {
        ...rec,
        unrecoveredAmount: settlement.remainingDebt,
        remainingTargetProfit: settlement.remainingTargetProfit,
        consecutiveRecoveryLosses: 0,
        recentRecoveryTrades: recentTrades,
      };
    }
    return rec;
  }

  if (!rec.inRecovery) {
    const target = addMoney(stake * Math.max(0, payoutMultiplier - 1));
    return {
      inRecovery: true,
      recoveryStep: 1,
      unrecoveredAmount: addMoney(stake),
      baseStake: rec.baseStake > 0 ? rec.baseStake : stake,
      targetProfit: target,
      remainingTargetProfit: target,
      originPayoutMultiplier: payoutMultiplier > 1 ? payoutMultiplier : 1,
      consecutiveRecoveryLosses: 0,
      recentRecoveryTrades: recentTrades,
    };
  }
  return {
    ...rec,
    recoveryStep: Math.min(rec.recoveryStep + 1, Math.max(1, maxSteps)),
    unrecoveredAmount: addMoney(rec.unrecoveredAmount, stake),
    consecutiveRecoveryLosses: rec.consecutiveRecoveryLosses + 1,
    recentRecoveryTrades: recentTrades,
  };
}
