/** Market Scanner — coverage of the 1-tick tournament (copy, Nexus-logic). */
import type { AgentOutput } from "../../agents/types";
import { agentResult, type HedgeAgentInput } from "./common";

export function runMarketScannerAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const live = input.tapes.filter((t) => t.live).length;
  const ranked = new Set(input.rows.map((r) => r.symbol)).size;
  const coverage = input.configuredMarkets > 0 ? ranked / input.configuredMarkets : 0;
  const score = coverage * 100;
  const confidence = Math.min(100, live * 5);
  return agentResult(
    "marketScanner",
    score,
    confidence,
    `${ranked}/${input.configuredMarkets} markets ranked on the 1-tick tape (${live} live)`,
    { configuredMarkets: input.configuredMarkets, rankedMarkets: ranked, liveTapes: live },
    started,
  );
}
