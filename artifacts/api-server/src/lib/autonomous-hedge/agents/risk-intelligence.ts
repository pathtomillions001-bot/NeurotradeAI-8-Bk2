/** Risk Intelligence — hard stops and stake reduction (copy of risk-manager semantics). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, type HedgeAgentInput } from "./common";

export function runRiskIntelligenceAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const { risk } = input;
  return agentResult(
    "riskIntelligence",
    risk.hardStop ? 0 : 100 * risk.riskBudget,
    risk.hardStop ? 100 : 80,
    risk.hardStop ? `hard stop: ${risk.hardStopReason ?? "limit reached"}` : `risk ${risk.riskLevel} · stake ×${risk.stakeMultiplier}`,
    { riskLevel: risk.riskLevel, stakeMultiplier: risk.stakeMultiplier, riskBudget: risk.riskBudget, hardStop: risk.hardStop },
    started,
  );
}
