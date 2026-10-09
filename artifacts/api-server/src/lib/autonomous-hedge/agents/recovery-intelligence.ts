/** Recovery Intelligence — recovery progress, confirmation and rematch state (copy). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, type HedgeAgentInput } from "./common";

export function runRecoveryIntelligenceAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const { recovery, memory, decision } = input;
  if (!recovery.inRecovery) {
    return agentResult("recoveryIntelligence", 100, 100, "no open debt — normal mode", { inRecovery: false, debt: 0 }, started);
  }
  const progress = decision && decision.requiredConfirmations > 0
    ? (100 * decision.confirmations) / decision.requiredConfirmations
    : 0;
  return agentResult(
    "recoveryIntelligence",
    progress,
    recovery.debt > 0 ? 100 : 50,
    `recovery step ${recovery.step} · debt ${recovery.debt.toFixed(2)} · confirmations ${decision?.confirmations ?? 0}/${decision?.requiredConfirmations ?? 0}`,
    { inRecovery: true, step: recovery.step, debt: recovery.debt, rematchActive: Boolean(memory.rematch), rematchPenalty: memory.rematch?.penalty ?? 0 },
    started,
  );
}
