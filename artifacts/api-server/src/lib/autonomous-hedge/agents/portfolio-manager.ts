/** Portfolio Manager — one autonomous exposure at a time (copy). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, type HedgeAgentInput } from "./common";

export function runPortfolioManagerAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  return agentResult(
    "portfolioManager",
    input.exposureOpen ? 0 : 100,
    100,
    input.exposureOpen ? "exposure open — no new trade until it is settled" : "no open exposure",
    { exposureOpen: input.exposureOpen },
    started,
  );
}
