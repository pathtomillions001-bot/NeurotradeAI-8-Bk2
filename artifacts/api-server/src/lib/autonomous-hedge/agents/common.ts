/**
 * Shared input and helpers for the autonomous Nexus-logic agents.
 *
 * These agents are COPIES of the shared agents' roles, rebuilt on the 1-tick
 * Nexus model. They are pure: they read a cycle snapshot and return an
 * AgentOutput. They never call the broker, the DB, or the shared agents.
 */

import { scoreToSignal, type AgentOutput } from "../../agents/types";
import type { HedgeCandidate, HedgeMode } from "../hedge-analysis";
import type { HedgeDecision } from "../contest";
import type { HedgeMemory } from "../hedge-state";
import type { HedgeTape } from "../tape";

export interface HedgeRecoverySnapshot {
  inRecovery: boolean;
  step: number;
  debt: number;
}

export interface HedgeRiskSnapshot {
  hardStop: boolean;
  hardStopReason?: string;
  riskBudget: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  stakeMultiplier: number;
  recommendedStake: number;
}

export interface HedgeAgentInput {
  mode: HedgeMode;
  decision: HedgeDecision | null;
  rows: HedgeCandidate[];
  tapes: HedgeTape[];
  configuredMarkets: number;
  lossRun: number;
  recovery: HedgeRecoverySnapshot;
  risk: HedgeRiskSnapshot;
  memory: HedgeMemory;
  exposureOpen: boolean;
}

export const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

export function agentResult(
  agentId: string,
  score: number,
  confidence: number,
  reasoning: string,
  data: Record<string, unknown>,
  startedAt: number,
): AgentOutput {
  const rounded = Math.round(clamp(score, 0, 100));
  return {
    agentId,
    score: rounded,
    confidence: Math.round(clamp(confidence, 0, 100)),
    signal: scoreToSignal(rounded),
    reasoning,
    data,
    executionTimeMs: Math.max(0, Date.now() - startedAt),
  };
}

/** Best row in a family set (eligible first, then score), or null. */
export function bestOf(
  rows: HedgeCandidate[],
  filter: (row: HedgeCandidate) => boolean,
): HedgeCandidate | null {
  let best: HedgeCandidate | null = null;
  for (const row of rows) {
    if (!filter(row)) continue;
    if (!best || Number(row.eligible) > Number(best.eligible) ||
        (Number(row.eligible) === Number(best.eligible) && row.score > best.score)) {
      best = row;
    }
  }
  return best;
}

export const DIGIT_FAMILIES = new Set(["DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF"]);
export const DIRECTION_FAMILIES = new Set(["CALL", "PUT"]);
