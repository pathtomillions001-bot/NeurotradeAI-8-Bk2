/**
 * Agent 13: Trade Explainability Agent
 *
 * RESPONSIBILITY: Generate a complete, human-readable explanation for every
 * trade decision — whether executed or rejected. Synthesizes the outputs of
 * all 12 upstream agents into structured reasoning that the frontend can
 * display to the user.
 *
 * This agent never blocks a trade — it is purely analytical and explanatory.
 */

import type { AgentOutput, ScanContext, ProductType } from "./types";
import { scoreToSignal } from "./types";

export interface TradeExplanation {
  headline: string;              // 1-sentence summary
  rationale: string;             // 2-3 sentence reasoning
  keyFactors: string[];          // bullet-point factors that drove the decision
  riskFactors: string[];         // things that could go wrong
  confidenceBreakdown: {
    agentId: string;
    label: string;
    score: number;
    contribution: "positive" | "negative" | "neutral";
  }[];
  expectedOutcome: string;       // what we expect to happen
  contractSummary: string;       // "CALL on R_100, 5 ticks, $2.00 stake"
}

export interface ExplainabilityInput {
  contractType: ProductType | null;
  barrier: number | null;
  stake: number;
  duration: number;
  symbol: string;
  agentScores: Record<string, number>;
  agentReasonings: Record<string, string>;
  shouldTrade: boolean;
  blockers: string[];
  winProbability: number;
  expectedValue: number;
}

const AGENT_LABELS: Record<string, string> = {
  marketScanner:       "Market Scanner",
  tickIntelligence:    "Tick Intelligence",
  digitProbability:    "Digit Probability",
  riseFallAgent:       "Rise/Fall Model",
  marketRegime:        "Market Regime",
  executionTiming:     "Entry Timing",
  confidenceFusion:    "Confidence Fusion",
  recoveryIntelligence: "Recovery Mode",
  riskIntelligence:    "Risk Assessment",
  portfolioManager:    "Portfolio Mgr",
  learningAgent:       "Learning Agent",
  patternDiscovery:    "Pattern Discovery",
};

function formatContractType(ct: ProductType | null, barrier: number | null): string {
  if (!ct) return "—";
  if (ct === "CALL" || ct === "RISE") return "RISE (Call)";
  if (ct === "PUT" || ct === "FALL") return "FALL (Put)";
  if (ct === "DIGITOVER") return `OVER ${barrier ?? "?"}`;
  if (ct === "DIGITUNDER") return `UNDER ${barrier ?? "?"}`;
  if (ct === "DIGITEVEN") return "EVEN";
  if (ct === "DIGITODD") return "ODD";
  return ct;
}

export function buildTradeExplanation(
  ctx: ScanContext,
  input: ExplainabilityInput,
): TradeExplanation {
  const { contractType, barrier, stake, duration, symbol, agentScores, agentReasonings } = input;

  // Headline
  const ctLabel = formatContractType(contractType, barrier);
  const headline = input.shouldTrade
    ? `Entering ${ctLabel} on ${symbol} — ${(input.winProbability * 100).toFixed(1)}% win probability, EV=${(input.expectedValue * 100).toFixed(1)}%`
    : `Skipping ${symbol} — ${input.blockers.length > 0 ? input.blockers[0] : "insufficient confidence"}`;

  // Contract summary
  const contractSummary = input.shouldTrade
    ? `${ctLabel} on ${symbol}, ${duration} ticks, $${stake.toFixed(2)} stake`
    : `No trade — ${symbol}`;

  // Key factors: top scoring agents
  const sortedAgents = Object.entries(agentScores)
    .sort(([, a], [, b]) => b - a)
    .filter(([id]) => id !== "tradeExplainability");

  const keyFactors = sortedAgents
    .filter(([, score]) => score >= 65)
    .slice(0, 4)
    .map(([id, score]) => `${AGENT_LABELS[id] ?? id}: ${score}/100`);

  if (keyFactors.length === 0) {
    keyFactors.push("All agents below confidence threshold");
  }

  // Risk factors: low-scoring agents and blockers
  const riskFactors: string[] = [
    ...input.blockers,
    ...sortedAgents
      .filter(([, score]) => score < 45)
      .map(([id, score]) => `${AGENT_LABELS[id] ?? id} weak (${score}/100)`),
  ].slice(0, 4);

  if (riskFactors.length === 0) {
    riskFactors.push("No significant risk factors identified");
  }

  // Confidence breakdown
  const confidenceBreakdown = sortedAgents.map(([agentId, score]) => ({
    agentId,
    label: AGENT_LABELS[agentId] ?? agentId,
    score,
    contribution: score >= 65 ? "positive" as const : score <= 45 ? "negative" as const : "neutral" as const,
  }));

  // Rationale: synthesize top 2-3 agent reasonings
  const topReasonings = sortedAgents
    .slice(0, 3)
    .map(([id]) => agentReasonings[id])
    .filter(Boolean)
    .map(r => r.split(".")[0]) // just the first sentence
    .join(". ");

  const rationale = topReasonings.length > 0
    ? `${topReasonings}. Overall confidence: ${input.shouldTrade ? "sufficient to trade" : "below threshold"}.`
    : headline;

  // Expected outcome
  const expectedOutcome = input.shouldTrade
    ? `Expected win: ${(input.winProbability * 100).toFixed(1)}%. Net EV per $1: ${(input.expectedValue * 100).toFixed(1)}%. Target profit: $${(stake * input.expectedValue).toFixed(2)}.`
    : `Trade skipped. Will re-evaluate on next tick scan.`;

  return { headline, rationale, keyFactors, riskFactors, confidenceBreakdown, expectedOutcome, contractSummary };
}

export function runTradeExplainabilityAgent(
  ctx: ScanContext,
  input: ExplainabilityInput,
): AgentOutput & { explanation: TradeExplanation } {
  const t0 = Date.now();
  const explanation = buildTradeExplanation(ctx, input);

  const allScores = Object.values(input.agentScores);
  const avgScore = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 50;
  const score = Math.round(avgScore);

  return {
    agentId: "tradeExplainability",
    score,
    confidence: 100,
    signal: scoreToSignal(score),
    reasoning: explanation.headline,
    data: { explanation },
    executionTimeMs: Date.now() - t0,
    explanation,
  };
}
