/** Rise/Fall Model — CALL/PUT price-direction model (copy, Nexus logic, 1 tick). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, bestOf, clamp, DIRECTION_FAMILIES, type HedgeAgentInput } from "./common";

export function runRiseFallAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const best = bestOf(input.rows, (r) => DIRECTION_FAMILIES.has(r.contract));
  if (!best) return agentResult("riseFallAgent", 0, 0, "no direction candidate ranked", {}, started);
  const score = clamp(50 + (best.lowerBound - best.breakEven) * 400, 0, 100);
  return agentResult(
    "riseFallAgent",
    score,
    clamp(100 * (1 - best.instability * 2), 0, 100),
    `${best.contract === "CALL" ? "Rise" : "Fall"} on ${best.symbol}: p ${(best.probability * 100).toFixed(1)}% · LCB ${(best.lowerBound * 100).toFixed(1)}% (n=${best.samples})`,
    { contract: best.contract, symbol: best.symbol, samples: best.samples, probability: best.probability, lowerBound: best.lowerBound },
    started,
  );
}
