/**
 * Autonomous ledger — database claims.
 *
 * Every settlement write is a CONDITIONAL update on the row's status. The
 * writer that changes the row (the live cycle or the reconciler) is the only
 * one that records the outcome in the recovery ledger. A second writer finds
 * the row already settled, changes nothing, and must not record again. This
 * is what stops double-counting and what lets a timed-out settlement be
 * completed later from the exact contract id without ever being lost.
 */

import { db, tradesTable } from "@workspace/db";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import { AUTONOMOUS_HEDGE_PREFIX } from "./constants";
import { runWithSession } from "../session";
import { logger } from "../logger";
import * as recoveryEngine from "../agents/recovery-engine";

export type TradeRowPatch = Partial<typeof tradesTable.$inferInsert>;

export function isAutonomousHedgeRow(agentReasoning: string | null | undefined): boolean {
  return typeof agentReasoning === "string" && agentReasoning.startsWith(AUTONOMOUS_HEDGE_PREFIX);
}

/** Settle a row only while it is still `open`. Returns true when this call changed it. */
export async function claimOpenRow(rowId: number, patch: TradeRowPatch): Promise<boolean> {
  const updated = await db
    .update(tradesTable)
    .set(patch)
    .where(and(eq(tradesTable.id, rowId), eq(tradesTable.status, "open")))
    .returning({ id: tradesTable.id });
  return updated.length === 1;
}

/** Settle a row while it is `open` or `error` (the reconciler's scope). */
export async function claimUnsettledRow(rowId: number, patch: TradeRowPatch): Promise<boolean> {
  const updated = await db
    .update(tradesTable)
    .set(patch)
    .where(and(eq(tradesTable.id, rowId), inArray(tradesTable.status, ["open", "error"])))
    .returning({ id: tradesTable.id });
  return updated.length === 1;
}

/** Autonomous rows still `open` for this session. These are the unresolved exposures. */
export async function loadOpenAutonomousRows(sessionId: string) {
  return db
    .select()
    .from(tradesTable)
    .where(and(
      eq(tradesTable.sessionId, sessionId),
      eq(tradesTable.status, "open"),
      like(tradesTable.agentReasoning, `${AUTONOMOUS_HEDGE_PREFIX}%`),
    ));
}

/** Contract ids already attached to any of this session's rows since `since`. */
export async function loadClaimedContractIds(sessionId: string, since: Date): Promise<Set<string>> {
  const rows = await db
    .select({ derivContractId: tradesTable.derivContractId })
    .from(tradesTable)
    .where(and(eq(tradesTable.sessionId, sessionId), gte(tradesTable.createdAt, since)));
  return new Set(rows.map((r) => r.derivContractId).filter((v): v is string => Boolean(v)));
}

/** Settle a row while it is `open` or `error` (the reconciler's scope). */

export interface SettlementOutcome {
  won: boolean;
  profit: number;
  /** Stake actually paid for the contract (buy price). */
  cost: number;
  contract: string;
  /** Ledger payout multiplier: (buy + profit) / buy when won, 1 otherwise. */
  payout: number;
  maxRecoverySteps: number;
}

/**
 * Result of settling a row:
 * - `settled`: this call changed the row, and the recovery ledger was made durable first.
 * - `already`: the row was already settled, so nothing was recorded again.
 * - `deferred`: the durable write failed. The row stays open for the reconciler to retry.
 */
export type SettleResult = "settled" | "already" | "deferred";

/**
 * Settlements of autonomous rows run one at a time, so the status check, the
 * ledger write and the claim cannot interleave between the live cycle and the reconciler.
 */
let settlementChain: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = settlementChain.then(task, task);
  settlementChain = run.catch(() => undefined);
  return run;
}

/**
 * Rows whose outcome is already in the in-memory recovery ledger but not yet
 * claimed in the DB (the durable write failed). A retry must not record them again.
 */
const recordedInMemory = new Set<string>();

/**
 * Settle an autonomous row and record its outcome in the recovery ledger.
 *
 * Order (crash-safe): the outcome is applied to the in-memory ledger once. The
 * ledger is then made durable. Only after that is the row claimed. A crash at
 * any point therefore never leaves a settled row whose debt is missing from the
 * stored ledger. The worst case is a durable ledger that already includes a
 * row that is still open, which is then recorded again on restart. That
 * overstates debt, which is the safe direction.
 */
export function settleAutonomousRow(
  sessionId: string,
  rowId: number,
  patch: TradeRowPatch,
  outcome: SettlementOutcome | null,
): Promise<SettleResult> {
  return serialized(() => runWithSession(sessionId, async (): Promise<SettleResult> => {
    recoveryEngine.setPersistenceSession(sessionId);
    const [current] = await db
      .select({ status: tradesTable.status })
      .from(tradesTable)
      .where(eq(tradesTable.id, rowId))
      .limit(1);
    if (!current || (current.status !== "open" && current.status !== "error")) return "already";

    const key = `${sessionId}:${rowId}`;
    const tracked = outcome !== null && recoveryEngine.isTrackedContract(outcome.contract);
    if (outcome && tracked && !recordedInMemory.has(key)) {
      recoveryEngine.recordOutcome(
        outcome.won, outcome.profit, outcome.cost, outcome.maxRecoverySteps, outcome.contract, outcome.payout,
      );
      recordedInMemory.add(key);
    }
    if (tracked) {
      const durable = await recoveryEngine.flushRecoveryState();
      if (!durable) {
        logger.warn({ rowId, sessionId }, "Autonomous settlement held open — the recovery ledger could not be persisted yet");
        return "deferred";
      }
    }

    const claimed = await claimUnsettledRow(rowId, patch);
    if (!claimed) {
      // Only reachable if another writer changed the row between the check and the claim.
      // The ledger is already durable, so this is logged rather than recorded twice.
      logger.error({ rowId, sessionId }, "Autonomous settlement lost its claim after the ledger was persisted");
      recordedInMemory.delete(key);
      return "already";
    }
    recordedInMemory.delete(key);
    return "settled";
  }));
}
