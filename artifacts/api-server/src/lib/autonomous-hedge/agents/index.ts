/**
 * Autonomous Nexus-logic agent set. One call per cycle, keyed exactly like the
 * dashboard's agent panel so the UI contract is unchanged.
 */
import type { AgentOutput } from "../../agents/types";
import type { HedgeAgentInput } from "./common";
import { runMarketScannerAgent } from "./market-scanner";
import { runTickIntelligenceAgent } from "./tick-intelligence";
import { runDigitProbabilityAgent } from "./digit-probability";
import { runRiseFallAgent } from "./rise-fall-agent";
import { runMarketRegimeAgent } from "./market-regime";
import { runExecutionTimingAgent } from "./execution-timing";
import { runConfidenceFusionAgent } from "./confidence-fusion";
import { runRecoveryIntelligenceAgent } from "./recovery-intelligence";
import { runDurationOptimizerAgent } from "./duration-optimizer";
import { runPortfolioManagerAgent } from "./portfolio-manager";
import { runRiskIntelligenceAgent } from "./risk-intelligence";
import { runLearningAgent } from "./learning-agent";
import { runPatternDiscoveryAgent } from "./pattern-discovery";
import { runTradeExplainabilityAgent } from "./trade-explainability";

export type { HedgeAgentInput } from "./common";

export function runAutonomousHedgeAgents(input: HedgeAgentInput): Record<string, AgentOutput> {
  const outputs = [
    runMarketScannerAgent(input),
    runTickIntelligenceAgent(input),
    runDigitProbabilityAgent(input),
    runRiseFallAgent(input),
    runMarketRegimeAgent(input),
    runExecutionTimingAgent(input),
    runConfidenceFusionAgent(input),
    runRecoveryIntelligenceAgent(input),
    runDurationOptimizerAgent(input),
    runPortfolioManagerAgent(input),
    runRiskIntelligenceAgent(input),
    runLearningAgent(input),
    runPatternDiscoveryAgent(input),
    runTradeExplainabilityAgent(input),
  ];
  return Object.fromEntries(outputs.map((o) => [o.agentId, o]));
}
