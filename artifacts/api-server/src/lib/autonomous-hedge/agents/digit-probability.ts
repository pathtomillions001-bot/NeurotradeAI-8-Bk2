/** Digit Probability — Over/Under/Even/Odd/Matches/Differs model (copy, Nexus posterior + Wilson LCB). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, bestOf, clamp, DIGIT_FAMILIES, type HedgeAgentInput } from "./common";

export function runDigitProbabilityAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const best = bestOf(input.rows, (r) => DIGIT_FAMILIES.has(r.contract));
  if (!best) return agentResult("digitProbability", 0, 0, "no digit candidate ranked", {}, started);
  const edge = best.lowerBound - best.breakEven;
  const score = clamp(50 + edge * 400, 0, 100);
  const confidence = clamp(100 * (1 - best.instability * 2), 0, 100);
  return agentResult(
    "digitProbability",
    score,
    confidence,
    `${best.contract}${best.barrier >= 0 ? ` ${best.barrier}` : ""} on ${best.symbol}: p ${(best.probability * 100).toFixed(1)}% · LCB ${(best.lowerBound * 100).toFixed(1)}% vs BE ${(best.breakEven * 100).toFixed(1)}% (n=${best.samples})`,
    { contract: best.contract, barrier: best.barrier, symbol: best.symbol, samples: best.samples, probability: best.probability, lowerBound: best.lowerBound, breakEven: best.breakEven },
    started,
  );
}
