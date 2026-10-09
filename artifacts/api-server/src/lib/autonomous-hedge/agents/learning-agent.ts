/** Learning Agent — advisory run statistics of the winner (copy). Never gates a trade. */
import type { AgentOutput } from "../../agents/types";
import { agentResult, clamp, type HedgeAgentInput } from "./common";

export function runLearningAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const d = input.decision;
  if (!d) return agentResult("learningAgent", 50, 0, "no statistics yet", {}, started);
  const b = d.best;
  return agentResult(
    "learningAgent",
    clamp(50 + 300 * (b.markov - b.breakEven), 0, 100),
    clamp(Math.min(100, b.samples), 0, 100),
    `next-tick Markov estimate ${(b.markov * 100).toFixed(1)}% (after-loss ${(b.afterLoss * 100).toFixed(1)}%, after-win ${(b.afterWin * 100).toFixed(1)}%)`,
    { markov: b.markov, afterLoss: b.afterLoss, afterWin: b.afterWin, samples: b.samples },
    started,
  );
}
