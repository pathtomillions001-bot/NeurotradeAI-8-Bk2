/** Tick Intelligence — feed freshness gate (copy, Nexus-logic). A stalled feed never fires. */
import type { AgentOutput } from "../../agents/types";
import { agentResult, clamp, type HedgeAgentInput } from "./common";

const FRESH_MS = 3000;
const STALE_MS = 8000;

export function runTickIntelligenceAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  if (input.tapes.length === 0) {
    return agentResult("tickIntelligence", 0, 0, "no tape available — feed unavailable", { freshestMs: null }, started);
  }
  const ages = input.tapes.map((t) => t.ageMs);
  const freshest = Math.min(...ages);
  const stale = ages.filter((a) => a > STALE_MS).length;
  const score = freshest <= FRESH_MS ? 100 : clamp(100 - ((freshest - FRESH_MS) / STALE_MS) * 100, 0, 100);
  return agentResult(
    "tickIntelligence",
    score,
    clamp(100 - stale * 2, 0, 100),
    `freshest tick ${Math.round(freshest / 100) / 10}s ago · ${stale} stale tapes`,
    { freshestMs: Math.round(freshest), staleTapes: stale },
    started,
  );
}
