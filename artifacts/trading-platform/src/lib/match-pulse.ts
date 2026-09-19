/** Public shapes for the account-driven /api/bots/match-pulse lifecycle. */
export interface PulseAccount {
  id: string;
  loginId: string;
  currency: string;
  isVirtual: boolean;
}
export interface PulseReading {
  digit: number;
  probability: number;
  lower: number;
  recentProbability: number;
  support: number;
  recentSupport: number;
  order: 0 | 1 | 2;
  context: string;
  driftZ: number;
  ready: boolean;
  reason: string;
}
export interface PulseBlock {
  ticks: number;
  shots: number;
  wins: number;
  winRate: number;
  lower: number;
  meanPrediction: number;
  brierSkill: number;
  longestLossRun: number;
}
export interface PulseReport {
  symbol: string;
  displayName: string;
  source: "live" | "simulated";
  history: number;
  payout: number;
  breakEven: number;
  validation: PulseBlock;
  audit: PulseBlock;
  combined: PulseBlock;
  logEvidence: number;
  requiredLogEvidence: number;
  lowerEv: number;
  qualified: boolean;
  reasons: string[];
  latest: PulseReading;
}
export type PulseMarketMode = "locked" | "switching";
export interface PulseRiskSettings {
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  maxConsecutiveLosses: number;
}
/** No client execution-mode or target-digit override: account + AI determine them. */
export interface PulseConfig extends PulseRiskSettings {
  scanId: string;
  selectedSymbol: string;
  marketMode: PulseMarketMode;
}
export interface PulseScan {
  scanId: string;
  createdAt: number;
  expiresAt: number;
  account: PulseAccount | null;
  marketsTested: number;
  scanRound: number;
  qualifiedCount: number;
  candidates: PulseReport[];
  note: string;
}
export interface PulseTelemetry {
  phase: "idle" | "starting" | "watching" | "cooldown" | "quoting" | "settling" | "reconciling" | "stopping" | "stopped";
  account: PulseAccount | null;
  config: PulseConfig | null;
  reading: PulseReading | null;
  active: PulseReport | null;
  source: "live" | "simulated" | null;
  ticksWatched: number;
  rejectedEntries: number;
  stopRequested: boolean;
  reconciliationIssue: string | null;
  cooldownTicks: number;
  markupPercent: number;
  pending: { journalId: number; contractId: number | null; sent: boolean } | null;
}

/** Pick the best qualified broker market, never merely the first measured one. */
export function bestPulseMarket(scan: PulseScan | null): PulseReport | null {
  return scan?.candidates.filter(report => report.qualified && report.source === "live")
    .sort((a, b) => b.lowerEv - a.lowerEv)[0] ?? null;
}

/** Switching the app's account invalidates the old deployment decision. */
export function pulseScanMatchesAccount(scan: PulseScan | null, account: Pick<PulseAccount, "loginId" | "isVirtual" | "currency"> | null | undefined): boolean {
  return !!scan?.account && !!account && scan.account.loginId === account.loginId &&
    scan.account.isVirtual === account.isVirtual && scan.account.currency === account.currency;
}

export function pulseRiskError(config: PulseRiskSettings): string | null {
  for (const [label, value] of [["Base stake", config.stake], ["Stop loss", config.stopLoss], ["Take profit", config.takeProfit]] as const) {
    if (!Number.isFinite(value) || value < 0.35 || value > 1_000_000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
      return `${label} must be 0.35–1,000,000 with at most two decimal places.`;
    }
  }
  if (config.stake > config.stopLoss) return "Base stake cannot exceed the session stop loss.";
  if (!Number.isInteger(config.maxRecoverySteps) || config.maxRecoverySteps < 1 || config.maxRecoverySteps > 10) return "Max recovery steps must be an integer from 1 to 10.";
  if (!Number.isInteger(config.maxConsecutiveLosses) || config.maxConsecutiveLosses < 3 || config.maxConsecutiveLosses > 20) return "Stop after losses must be an integer from 3 to 20.";
  return null;
}
