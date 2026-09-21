/** Public DTOs for /api/bots/omni; no broker credentials or model parameters. */
export const OMNI_CONTRACTS = [
  { id: "CALL", label: "Rise", hint: "Price up", group: "Direction" },
  { id: "PUT", label: "Fall", hint: "Price down", group: "Direction" },
  {
    id: "DIGITEVEN",
    label: "Even",
    hint: "0 · 2 · 4 · 6 · 8",
    group: "Parity",
  },
  { id: "DIGITODD", label: "Odd", hint: "1 · 3 · 5 · 7 · 9", group: "Parity" },
  {
    id: "DIGITMATCH",
    label: "Matches",
    hint: "AI chooses digit",
    group: "Digit",
  },
  {
    id: "DIGITDIFF",
    label: "Differs",
    hint: "AI chooses digit",
    group: "Digit",
  },
  {
    id: "DIGITOVER",
    label: "Over",
    hint: "AI chooses barrier",
    group: "Barrier",
  },
  {
    id: "DIGITUNDER",
    label: "Under",
    hint: "AI chooses barrier",
    group: "Barrier",
  },
] as const;
export type OmniContractType = (typeof OMNI_CONTRACTS)[number]["id"];
export interface OmniConfig {
  enabledContracts: OmniContractType[];
  stake: number;
  stopLoss: number;
  takeProfit: number;
  marketMode: "locked" | "switching";
  executionMode: "paper" | "live";
}
export interface OmniOpportunity {
  symbol: string;
  displayName: string;
  contract: {
    id: string;
    contractType: OmniContractType;
    label: string;
    barrier?: number;
    fair: number;
  };
  probability: number;
  rawProbability: number;
  uncertainty: number;
  lossAfterLoss: number;
  samples: number;
  expertWeights: number[];
  payout: number;
  quoteSource: "live" | "indicative";
  stake: number;
  breakEven: number;
  expectedValue: number;
  lossPairRisk: number;
  debtCoverage: number;
  utility: number;
  ready: boolean;
  reason: string;
}
export interface OmniReplay {
  ticks: number;
  normalShots: number;
  normalWins: number;
  recoveryShots: number;
  recoveryWins: number;
  recoveryLossPairs: number;
  profit: number;
  remainingDebt: number;
  maxStake: number;
  stoppedByRisk: boolean;
}
export interface OmniMarketCard {
  symbol: string;
  displayName: string;
  source: "live" | "simulated";
  samples: number;
  normal: OmniOpportunity | null;
  recovery: OmniOpportunity | null;
  replay: OmniReplay;
}
export interface OmniScan {
  scanId: string;
  expiresAt: number;
  config: OmniConfig;
  markets: OmniMarketCard[];
  marketsScanned: number;
  reason: string;
  currency: string;
}
export interface OmniSessionDetails {
  config: OmniConfig;
  lockedSymbol: string | null;
  stopping: boolean;
  pendingOrder: boolean;
  watch: {
    phase: "watching" | "pricing" | "settling" | "reconciling" | "stopping";
    mode: "normal" | "recovery";
    reason: string;
    candidates: OmniOpportunity[];
    marketsConsidered: number;
    ticksEvaluated: number;
    source: "live" | "simulated" | "waiting";
    utilityFloor: number;
  };
}

export function omniConfigError(config: OmniConfig): string | null {
  if (config.enabledContracts.length === 0)
    return "Enable at least one contract.";
  if (
    !Number.isFinite(config.stake) ||
    config.stake < 0.35 ||
    Math.abs(config.stake * 100 - Math.round(config.stake * 100)) > 1e-7
  )
    return "Use a stake of at least 0.35, in whole cents.";
  if (!Number.isFinite(config.stopLoss) || config.stopLoss < config.stake)
    return "The stop loss must cover at least one base stake.";
  if (!Number.isFinite(config.takeProfit) || config.takeProfit <= 0)
    return "Take profit must be greater than zero.";
  return null;
}
