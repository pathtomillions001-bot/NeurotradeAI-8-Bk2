/** Nexus's small JSON contract; model cards stay server-side. Probabilities are 0–1. */
export type NexusActivity = "active" | "balanced" | "patient";
export interface NexusConfig {
  activity: NexusActivity;
  digit?: number;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  executionMode: "paper" | "live";
}
export interface NexusPrediction {
  probabilities: number[];
  sigma: number[];
  gaps: number[];
  entropy: number;
  samples: number;
  contextSamples: number;
  experts: Array<{ name: string; weight: number; probabilities: number[] }>;
}
export interface NexusDecision {
  digit: number;
  p: number;
  sigma: number;
  conservativeP: number;
  payout: number;
  breakEven: number;
  expectedValue: number;
  utility: number;
  threshold: number;
  ready: boolean;
  reason: string;
}
export interface NexusValidation {
  trainTicks: number;
  testTicks: number;
  shots: number;
  wins: number;
  hitRate: number | null;
  lower95: number | null;
  upper95: number | null;
  meanPrediction: number | null;
  evPerStake: number | null;
  fireRate: number;
  brierSkill: number;
  logLossSkill: number;
  calibrationError: number | null;
  longestLossRun: number;
  evidenceP: number;
  adjustedEvidenceP: number;
  evidence: "supported" | "developing" | "unproven";
}
export interface NexusRisk {
  paths: number;
  horizon: number;
  sampleShots: number;
  stopProbability: number;
  targetProbability: number;
  pnl05: number;
  pnl50: number;
  pnl95: number;
  drawdown95: number;
  note: string;
}
export interface NexusMarketView {
  symbol: string;
  displayName: string;
  source: "live" | "simulated";
  historySource: "broker" | "buffer" | "simulated";
  samples: number;
  deployable: boolean;
  prediction: NexusPrediction;
  decision: NexusDecision;
  validation: NexusValidation;
  risk: NexusRisk;
  analysisMs: number;
  warnings: string[];
  calibration: number;
  payoutSource: "indicative";
}
export interface NexusScanView {
  scanId: string;
  version: string;
  createdAt: number;
  expiresAt: number;
  config: NexusConfig;
  riskSettings: { maxStake: number; markupPercent: number };
  elapsedMs: number;
  marketsScanned: number;
  markets: NexusMarketView[];
  omitted: Array<{ symbol: string; reason: string }>;
  note: string;
}
export interface NexusTelemetry {
  phase:
    | "watching"
    | "quoting"
    | "buying"
    | "settling"
    | "attention"
    | "stopped";
  executionMode: "paper" | "live";
  marketMode: "locked" | "switching";
  activity: NexusActivity;
  source: string;
  symbol: string;
  digit: number | null;
  prediction: NexusPrediction | null;
  decision: NexusDecision | null;
  validation: NexusValidation | null;
  risk: NexusRisk | null;
  stopRequested: boolean;
  pendingContractId: string | null;
  ticksObserved: number;
  switches: number;
  entriesSkipped: number;
  analysisMs: number;
  quoteMs: number | null;
  buyMs: number | null;
  signalToSendMs: number | null;
  executionP95Ms: number | null;
  tickAgeMs: number | null;
  headroomMs: number | null;
  lastEntryAligned: boolean | null;
  recentTrades: Array<{
    digit: number;
    symbol: string;
    won: boolean;
    profit: number;
    at: number;
  }>;
  markets: Array<{
    symbol: string;
    displayName: string;
    digit: number;
    p: number;
    utility: number;
    ready: boolean;
    source: string;
  }>;
}

export const nexusPercent = (
  p: number | null | undefined,
  digits = 1,
): string =>
  p === null || p === undefined || !Number.isFinite(p)
    ? "—"
    : `${(p * 100).toFixed(digits)}%`;
export const nexusMoney = (value: number): string =>
  `${value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}`;

/** Keep the post-scan mode choice and server-owned capability explicit. */
export function nexusDeployBody(
  scan: Pick<NexusScanView, "scanId">,
  symbol: string,
  marketMode: "locked" | "switching",
  confirmLive = false,
) {
  return { scanId: scan.scanId, symbol, marketMode, confirmLive };
}
export function canDeployNexus(
  scan: NexusScanView | null,
  selected: NexusMarketView | undefined,
  now: number,
  confirmLive: boolean,
): boolean {
  return (
    !!scan &&
    !!selected?.deployable &&
    scan.expiresAt > now &&
    (scan.config.executionMode === "paper" || confirmLive)
  );
}
