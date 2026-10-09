/** Trade Explainability — plain-language reason for the winner (copy). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, type HedgeAgentInput } from "./common";

export function runTradeExplainabilityAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const d = input.decision;
  if (!d) return agentResult("tradeExplainability", 0, 0, "no decision yet", {}, started);
  const b = d.best;
  const explanation = `${b.contract}${b.barrier >= 0 ? ` ${b.barrier}` : ""} on ${b.symbol} (${d.mode.toLowerCase()}): ${d.reason}`;
  return agentResult(
    "tradeExplainability",
    d.eligible ? 100 : 50,
    100,
    explanation,
    { explanation, mode: d.mode, eligible: d.eligible },
    started,
  );
}
