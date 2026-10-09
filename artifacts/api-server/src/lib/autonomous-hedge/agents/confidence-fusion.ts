/** Confidence Fusion — Nexus score composition for the winner (copy). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, clamp, type HedgeAgentInput } from "./common";

export function runConfidenceFusionAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const d = input.decision;
  if (!d) return agentResult("confidenceFusion", 0, 0, "no winner to fuse", {}, started);
  const best = d.best;
  return agentResult(
    "confidenceFusion",
    clamp(50 + best.score, 0, 100),
    clamp(100 * best.lowerBound, 0, 100),
    `Nexus score ${best.score.toFixed(2)} · EV ${(best.ev * 100).toFixed(2)}% · clustering ${best.clustering.toFixed(2)}x`,
    { nexusScore: best.score, lowerBound: best.lowerBound, ev: best.ev, clustering: best.clustering, instability: best.instability },
    started,
  );
}
