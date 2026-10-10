/** Duration Optimizer — fixed to 1 tick for every family (Nexus). Not a score agent. */
import type { AgentOutput } from "../../agents/types";
import { agentResult, type HedgeAgentInput } from "./common";
import { HEDGE_DURATION_TICKS, HEDGE_DURATION_UNIT } from "../constants";

export function runDurationOptimizerAgent(_input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  return agentResult(
    "durationOptimizer",
    100,
    100,
    `duration fixed at ${HEDGE_DURATION_TICKS}${HEDGE_DURATION_UNIT} (Nexus 1-tick)`,
    { duration: HEDGE_DURATION_TICKS, durationUnit: HEDGE_DURATION_UNIT },
    started,
  );
}
