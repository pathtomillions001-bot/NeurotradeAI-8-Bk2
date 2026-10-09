/** Pattern Discovery — loss clustering and the active rematch tuple (copy). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, clamp, type HedgeAgentInput } from "./common";

export function runPatternDiscoveryAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const d = input.decision;
  const clustering = d?.best.clustering ?? 1;
  return agentResult(
    "patternDiscovery",
    clamp(100 - 50 * Math.max(0, clustering - 1), 0, 100),
    100,
    `loss clustering ${clustering.toFixed(2)}x${input.memory.rematch ? ` · rematch on ${input.memory.rematch.key}` : ""}`,
    { clustering, rematchKey: input.memory.rematch?.key ?? null, rematchPenalty: input.memory.rematch?.penalty ?? 0 },
    started,
  );
}
