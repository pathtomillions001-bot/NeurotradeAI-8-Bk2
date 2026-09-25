/**
 * Scanner-agnostic description of a strategy that can be compiled into a
 * Deriv DBot (Blockly) strategy XML.
 *
 * The Over/Under Turbo scan is the first producer; any future scanner only
 * needs to emit this manifest to get a "Create DBot" button for free.
 */
export interface DbotContractSpec {
  /** Deriv contract family — only digit Over/Under is supported today. */
  side: "DIGITOVER" | "DIGITUNDER";
  /** Predicted digit barrier (0-9). */
  barrier: number;
}

export interface DbotRecoverySpec {
  /** Normal (non-recovery) stake — ladder step 0. */
  baseStake: number;
  /** Total-return payout multiplier of the normal leg (e.g. 1.95). */
  payoutMultiplier: number;
  /** Profit markup (%) on debt — settings.botRecoveryMarkup (default 10). */
  markupPercent: number;
  /** Consecutive recovery losses the ladder covers before the breaker trips. */
  maxSteps: number;
  /** Hard stake ceiling — settings.maxTradeStake. */
  maxTradeStake: number;
}

export interface DbotStrategyManifest {
  /** Which scanner produced this manifest (future scanners plug in here). */
  source: string;
  symbol: string;
  displayName: string;
  contract: DbotContractSpec;
  /** The scan's recovery-leg contract (telemetry; execution uses `contract`). */
  recoveryContract?: DbotContractSpec;
  /** Contract duration in ticks (turbo fires 1-tick digits). */
  duration: number;
  durationUnit: "t";
  stake: number;
  takeProfit: number;
  stopLoss: number;
  recovery: DbotRecoverySpec;
  /** Scan telemetry (score, survival, break-evens…) — stored, not executed. */
  scan?: Record<string, unknown>;
  generatedAt: string;
}
