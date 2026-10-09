/** Market Regime — ADVISORY ONLY (copy). Labels the winner's tape; never gates a trade. */
import type { AgentOutput, MarketRegime } from "../../agents/types";
import { agentResult, type HedgeAgentInput } from "./common";

export function runMarketRegimeAgent(input: HedgeAgentInput): AgentOutput {
  const started = Date.now();
  const tape = input.decision ? input.tapes.find((t) => t.symbol === input.decision!.best.symbol) : input.tapes[0];
  if (!tape || tape.prices.length < 3) {
    return agentResult("marketRegime", 50, 0, "regime unknown — tape too short", { regime: "quiet" }, started);
  }
  const moves: number[] = [];
  for (let i = 1; i < tape.prices.length; i++) moves.push(Math.sign(tape.prices[i] - tape.prices[i - 1]));
  const upShare = moves.filter((m) => m > 0).length / Math.max(1, moves.length);
  let flips = 0;
  for (let i = 1; i < moves.length; i++) if (moves[i] !== moves[i - 1] && moves[i] !== 0) flips++;
  const flipRate = flips / Math.max(1, moves.length - 1);
  let regime: MarketRegime;
  if (flipRate > 0.6) regime = "mean_reverting";
  else if (upShare >= 0.6) regime = "trending_up";
  else if (upShare <= 0.4) regime = "trending_down";
  else regime = "choppy";
  return agentResult(
    "marketRegime",
    50,
    50,
    `advisory: ${regime.replace("_", " ")} (up ${(upShare * 100).toFixed(0)}%, flip ${(flipRate * 100).toFixed(0)}%)`,
    { regime, upShare, flipRate },
    started,
  );
}
