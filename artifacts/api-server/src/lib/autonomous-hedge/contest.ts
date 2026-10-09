/**
 * Autonomous engine — 1-tick contest (pure).
 *
 * Contest mode is the 4-group parallel tournament: every watched market in each
 * group is ranked on the same 1-tick Nexus tape. Each group produces one winner,
 * and the best group winner executes. The Nexus gate and the rescan memory
 * decide whether that winner may fire this tick.
 */

import { HEDGE_GROUP_NAMES, HEDGE_LIMITS } from "./constants";
import { applyRematch, evaluateConfirmation, rankRows, type HedgeMemory } from "./hedge-state";
import type { HedgeCandidate, HedgeMode } from "./hedge-analysis";

export interface GroupWinner {
  group: number;
  groupName: string;
  winner: HedgeCandidate;
  rowsInGroup: number;
}

export interface HedgeDecision {
  mode: HedgeMode;
  best: HedgeCandidate;
  /** Final verdict for this tick: gate passed AND (normal, or recovery confirmed). */
  eligible: boolean;
  confirmations: number;
  requiredConfirmations: number;
  rescanInProgress: boolean;
  /** Recovery-episode depth the risk terms were weighted at (0 in normal mode). */
  escalation: number;
  blockers: string[];
  reason: string;
  groupWinners: GroupWinner[];
  rowsRanked: number;
}

export interface DecideInput {
  rows: HedgeCandidate[];
  mode: HedgeMode;
  memory: HedgeMemory;
  lossRun: number;
  /** Recovery-episode depth; reported for transparency. Ranking already carries it. */
  escalation?: number;
}

/**
 * Returns null when no market produced a ranked row (feed unavailable). The
 * confirmation is cleared in that case, exactly as in the Nexus runtime.
 */
export function decideHedge(input: DecideInput): HedgeDecision | null {
  const { mode, memory, lossRun } = input;
  const escalation = Math.max(0, Math.floor(input.escalation ?? 0));
  const rows = input.rows.map((row) => ({ ...row })); // never mutate the caller's rows
  if (rows.length === 0) {
    memory.confirmation = undefined;
    return null;
  }

  const rescanInProgress = applyRematch(rows, memory);
  const ranked = rankRows(rows);
  const best = ranked[0];

  // Group winners: the top ranked row of each group, in display order.
  const groupWinners: GroupWinner[] = [];
  for (let g = 0; g < HEDGE_GROUP_NAMES.length; g++) {
    const inGroup = ranked.filter((row) => row.group === g);
    if (inGroup.length === 0) continue;
    groupWinners.push({
      group: g,
      groupName: HEDGE_GROUP_NAMES[g],
      winner: inGroup[0],
      rowsInGroup: inGroup.length,
    });
  }

  const limits = mode === "RECOVERY" ? HEDGE_LIMITS.recovery : HEDGE_LIMITS.normal;
  const blockers: string[] = [];
  if (best.samples < limits.minSamples) blockers.push(`samples ${best.samples}/${limits.minSamples}`);
  if (best.ev <= limits.minEv) blockers.push(`EV ${(best.ev * 100).toFixed(2)}%`);
  if (best.lowerBound <= best.breakEven - limits.lowerBoundMargin) {
    blockers.push(`lower bound ${(best.lowerBound * 100).toFixed(1)}% vs BE ${(best.breakEven * 100).toFixed(1)}%`);
  }
  if (best.instability >= limits.maxInstability) blockers.push(`unstable ${(best.instability * 100).toFixed(1)}pt`);
  if (best.clustering >= limits.maxClustering) blockers.push(`loss clustering ${best.clustering.toFixed(2)}x`);

  const confirmation = evaluateConfirmation(memory, mode, best, lossRun);
  const rescanNote = rescanInProgress ? ` · post-loss rescan (lossRun ${lossRun})` : "";
  // Recovery evidence, reported so an entry or a hold is explainable: the
  // posterior probability that the true win rate beats break-even, the
  // three-loss stress indicator R3L, and the loss-streak weight both were
  // scored at. These re-rank candidates; they never size a stake.
  const recoveryNote = mode === "RECOVERY"
    ? ` · P(edge) ${(best.posteriorEdgeProbability * 100).toFixed(0)}% R3L ${best.lossRunRisk.toFixed(2)} w${best.riskWeight.toFixed(2)}`
    : "";
  const barrierText = best.barrier >= 0 ? ` ${best.barrier}` : "";
  const reason = best.eligible
    ? confirmation.eligible
      ? `READY ${best.contract}${barrierText} on ${best.symbol} score ${best.score.toFixed(2)} EV ${(best.ev * 100).toFixed(2)}% LCB ${(best.lowerBound * 100).toFixed(1)}%${recoveryNote}${rescanNote}`
      : `HOLD · confirming recovery setup ${confirmation.confirmations}/${confirmation.required} on a fresh tick${recoveryNote}${rescanNote}`
    : `HOLD: ${blockers.join(", ") || "no qualified edge"}${recoveryNote}${rescanNote}`;

  return {
    mode,
    best,
    eligible: confirmation.eligible,
    confirmations: confirmation.confirmations,
    requiredConfirmations: confirmation.required,
    rescanInProgress,
    escalation,
    blockers,
    reason,
    groupWinners,
    rowsRanked: ranked.length,
  };
}
