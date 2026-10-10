/** Execution Timing — 1-tick entry timing: confirmations on fresh ticks, rematch state (copy). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, type HedgeAgentInput } from "./common";

export function runExecutionTimingAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const d = input.decision;
  if (!d) return agentResult("executionTiming", 0, 0, "waiting for a ranked tape", {}, started);
  const score = d.eligible ? 100 : d.requiredConfirmations > 0 ? (100 * d.confirmations) / d.requiredConfirmations : 0;
  return agentResult(
    "executionTiming",
    score,
    d.eligible ? 100 : 60,
    d.reason,
    { confirmations: d.confirmations, requiredConfirmations: d.requiredConfirmations, rescanInProgress: d.rescanInProgress, mode: d.mode },
    started,
  );
}
