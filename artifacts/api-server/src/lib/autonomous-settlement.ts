/** Journal + recovery update in one transaction, with a status compare-and-set.
 * Shared by the autonomous loop and exact-ID restart reconciliation.
 */
import { db, tradesTable, settingsTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as recovery from "./agents/recovery-engine";
import { clearTradingQuarantine } from "./engine-arbiter";
import { runWithSession } from "./session";

export async function settleAutonomousTrade(input: {
  sessionId: string;
  tradeId: number;
  won: boolean;
  profit: number;
  stake: number;
  payout: number;
  payoutMultiplier: number;
  contractType: string;
  entryPrice: number;
  exitPrice: number;
  closedAt?: Date;
  contractId?: string;
}): Promise<boolean> {
  if (
    ![
      input.profit,
      input.stake,
      input.payout,
      input.payoutMultiplier,
      input.entryPrice,
      input.exitPrice,
    ].every(Number.isFinite) ||
    input.stake <= 0 ||
    input.payout < 0 ||
    Math.abs(input.stake + input.profit - input.payout) > 0.011 ||
    input.won !== input.profit > 0
  ) {
    throw new Error("Invalid broker settlement; keep purchase unresolved");
  }
  return runWithSession(input.sessionId, async () => {
    let next: recovery.RecoveryState | undefined;
    const changed = await db.transaction(async (tx) => {
      // Lock settings before reading the ledger so concurrent settlement attempts
      // for this account cannot both apply the same outcome.
      await tx
        .insert(settingsTable)
        .values({ sessionId: input.sessionId })
        .onConflictDoNothing();
      const [settings] = await tx
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.sessionId, input.sessionId))
        .for("update");
      if (settings.recoveryStateJson)
        recovery.hydrateStateIfNeeded(settings.recoveryStateJson);
      const memoryState = { ...recovery.getState() };
      // The locked persisted row is authoritative for same-day outcomes, even
      // when another reconciliation committed while this process held a warm
      // in-memory ledger. Retain legacy migration / day-rollover normalization.
      const persisted = settings.recoveryStateJson
        ? JSON.parse(settings.recoveryStateJson)
        : null;
      const current: recovery.RecoveryState =
        persisted &&
        !Array.isArray(persisted) &&
        persisted.resetDate === memoryState.resetDate
          ? { ...memoryState, ...persisted }
          : memoryState;
      if (
        ![
          current.unrecoveredAmount,
          current.baseStake,
          current.streakLossCount,
          current.recoveryStep,
        ].every(Number.isFinite)
      ) {
        throw new Error(
          "Invalid persisted recovery ledger; reconciliation required",
        );
      }
      const rows = await tx
        .update(tradesTable)
        .set({
          status: input.profit === 0 ? "refunded" : input.won ? "won" : "lost",
          profit: String(input.profit),
          payout: String(input.payout),
          entryPrice: String(input.entryPrice),
          exitPrice: String(input.exitPrice),
          closedAt: input.closedAt ?? new Date(),
          ...(input.contractId ? { derivContractId: input.contractId } : {}),
        })
        .where(
          and(
            eq(tradesTable.id, input.tradeId),
            eq(tradesTable.sessionId, input.sessionId),
            inArray(tradesTable.status, ["open", "error"]),
          ),
        )
        .returning({ id: tradesTable.id });
      if (!rows.length) return false;
      next =
        input.profit === 0
          ? { ...current }
          : recovery.reduceRecoveryOutcome(
              { ...current },
              input.won,
              input.profit,
              input.won ? input.stake : Math.min(input.stake, -input.profit),
              settings.maxRecoverySteps,
              input.contractType,
              input.payoutMultiplier,
            );
      await tx
        .update(settingsTable)
        .set({ recoveryStateJson: JSON.stringify(next), updatedAt: new Date() })
        .where(eq(settingsTable.id, settings.id));
      return true;
    });
    if (changed && next) recovery.seedState(next);
    const pending = await db
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.sessionId, input.sessionId),
          inArray(tradesTable.status, ["open", "error"]),
          sql`${tradesTable.agentReasoning} LIKE '[AUTONOMOUS PENDING]%'`,
        ),
      );
    if (!pending.length) clearTradingQuarantine(input.sessionId);
    return changed;
  });
}
