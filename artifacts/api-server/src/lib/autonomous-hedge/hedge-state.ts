/**
 * Autonomous engine — Nexus rescan memory (pure).
 *
 *  - Confirmation: a RECOVERY entry must be the best candidate on N DISTINCT
 *    fresh ticks (N = 2, or 3 once the consecutive loss run is ≥ 3).
 *    Settlement clears it.
 *  - Rematch: after a settled LOSS the exact losing tuple (symbol:contract:
 *    barrier) is penalised for the next scans. The penalty decays only when
 *    fresh tape arrives. A WIN clears every penalty.
 *
 * Mirrors Ticks.js ntAnalyseHedge and Total.js updateTotals.
 */

import { HEDGE_LIMITS } from "./constants";
import type { HedgeCandidate, HedgeMode } from "./hedge-analysis";

export interface HedgeRematch {
  key: string;
  penalty: number;
  /** Highest tick sequence the penalty has already been aged against. */
  epoch: number;
}

export interface HedgeConfirmation {
  key: string;
  sequence: number;
  count: number;
}

export interface HedgeMemory {
  rematch?: HedgeRematch;
  confirmation?: HedgeConfirmation;
}

export function requiredConfirmations(lossRun: number): number {
  return lossRun >= HEDGE_LIMITS.escalateAtLossRun
    ? Math.min(HEDGE_LIMITS.recoveryConfirmationsEscalated, HEDGE_LIMITS.recoveryConfirmations + 1)
    : HEDGE_LIMITS.recoveryConfirmations;
}

/**
 * Apply the rematch handicap to this scan's rows, then age it if fresh tape
 * has arrived. Returns true when a rematch is in force (a post-loss rescan).
 */
export function applyRematch(rows: HedgeCandidate[], memory: HedgeMemory): boolean {
  const rematch = memory.rematch;
  if (!rematch) return false;
  for (const row of rows) {
    if (row.key === rematch.key) row.score -= rematch.penalty;
  }
  const maxSequence = rows.reduce((max, row) => Math.max(max, row.tickSequence), 0);
  if (maxSequence > rematch.epoch) {
    rematch.epoch = maxSequence;
    rematch.penalty = Math.max(0, rematch.penalty - HEDGE_LIMITS.rematchDecay);
    if (rematch.penalty === 0) memory.rematch = undefined;
  }
  return true;
}

/** Eligible first, then highest score. Stable for equal scores. */
export function rankRows(rows: HedgeCandidate[]): HedgeCandidate[] {
  return [...rows].sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
}

export interface ConfirmationResult {
  confirmations: number;
  required: number;
  eligible: boolean;
}

/**
 * Recovery: count distinct fresh ticks for the same best key. Normal: no
 * confirmation, the gate decides. Any non-eligible best clears the count.
 */
export function evaluateConfirmation(
  memory: HedgeMemory,
  mode: HedgeMode,
  best: HedgeCandidate,
  lossRun: number,
): ConfirmationResult {
  const required = requiredConfirmations(lossRun);
  if (mode === "RECOVERY" && best.eligible) {
    const previous = memory.confirmation;
    let count: number;
    if (previous?.key === best.key && previous.sequence !== best.tickSequence) count = previous.count + 1;
    else if (previous?.key === best.key && previous.sequence === best.tickSequence) count = previous.count;
    else count = 1;
    memory.confirmation = { key: best.key, sequence: best.tickSequence, count };
    return { confirmations: count, required, eligible: count >= required };
  }
  memory.confirmation = undefined;
  return { confirmations: 0, required, eligible: best.eligible };
}

/** Settlement: every settled trade clears the confirmation; a loss arms the rematch. */
export function applySettlement(
  memory: HedgeMemory,
  outcome: { won: boolean; key: string; lossRun: number; decisionSequence: number },
): void {
  memory.confirmation = undefined;
  if (outcome.won) {
    memory.rematch = undefined;
    return;
  }
  const penalty =
    HEDGE_LIMITS.rematchPenalty +
    HEDGE_LIMITS.rematchPenaltyPerLoss * Math.max(0, outcome.lossRun - 1);
  memory.rematch = { key: outcome.key, penalty, epoch: outcome.decisionSequence };
}
