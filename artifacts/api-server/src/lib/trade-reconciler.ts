/**
 * Trade reconciliation — the safety net that makes a trade impossible to lose.
 *
 * WHY THIS EXISTS
 *
 * A live trade is written to the database as `open` the moment it is sent to
 * Deriv, then updated to `won`/`lost` when the contract settles. Two things
 * used to break that:
 *
 *  1. The settlement socket was per-trade and rejected the moment it closed, so
 *     a transient drop marked a perfectly healthy trade as `error` with a profit
 *     of 0 — the trade "disappeared" even though Deriv had journalued it.
 *  2. A redeploy (or a browser/session change) between the insert and the
 *     settle left the row stuck on `open` forever.
 *
 * Deriv is the source of truth: the contract is on the account whether or not
 * our process survived. This reconciler sweeps every unsettled row and settles
 * it from Deriv's own profit_table, so no trade is ever left in limbo.
 *
 * It runs at startup (right after a redeploy) and every 60 s afterwards.
 */

import { db } from "@workspace/db";
import { accountsTable, tradesTable } from "@workspace/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { fetchDerivProfitTable } from "./deriv";
import { logger } from "./logger";

/** Trades older than this that are still `open` are considered unsettled. */
const RECONCILE_AFTER_MS = 90_000;
/** How far back to look for unsettled rows (a day is plenty). */
const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many unsettled rows to examine per sweep. */
const RECONCILE_BATCH = 100;

interface UnsettledRow {
  id: number;
  sessionId: string;
  symbol: string;
  contractType: string;
  stake: string;
  derivContractId: string | null;
  agentReasoning: string | null;
  createdAt: Date;
}

function normalizeContractType(ct: string): string[] {
  // Deriv journals RISE/FALL; our rows may store CALL/PUT (and vice versa).
  if (ct === "RISE" || ct === "CALL") return ["RISE", "CALL"];
  if (ct === "FALL" || ct === "PUT") return ["FALL", "PUT"];
  return [ct];
}

/**
 * Match a stored trade against a Deriv profit_table transaction.
 * Exact by contract id when we have it; otherwise by symbol + contract family +
 * stake within a few minutes of the recorded entry time.
 */
export function findTransaction(row: UnsettledRow, transactions: any[]): any | null {
  if (row.derivContractId) {
    const exact = transactions.find(
      (t) => String(t.contract_id ?? "") === String(row.derivContractId),
    );
    // A known contract ID must NEVER fall back to a different same-stake trade.
    return exact ?? null;
  }
  const family = normalizeContractType(row.contractType);
  const stake = Number(row.stake);
  const createdSec = Math.floor(row.createdAt.getTime() / 1000);
  return (
    transactions.find((t) => {
      if (t.underlying_symbol && row.symbol && t.underlying_symbol !== row.symbol) return false;
      if (t.contract_type && !family.includes(String(t.contract_type))) return false;
      if (Math.abs(Number(t.buy_price ?? 0) - stake) > 0.02) return false;
      const purchaseSec = Number(t.purchase_time ?? 0);
      if (purchaseSec && Math.abs(purchaseSec - createdSec) > 300) return false;
      return true;
    }) ?? null
  );
}

/**
 * Settle every `open`/`error` trade that Deriv has already resolved.
 * Returns the number of rows settled.
 */
export async function reconcileUnsettledTrades(): Promise<number> {
  let settled = 0;
  try {
    const since = new Date(Date.now() - RECONCILE_WINDOW_MS);
    const cutoff = new Date(Date.now() - RECONCILE_AFTER_MS);

    const rows = (await db
      .select({
        id: tradesTable.id,
        sessionId: tradesTable.sessionId,
        symbol: tradesTable.symbol,
        contractType: tradesTable.contractType,
        stake: tradesTable.stake,
        derivContractId: tradesTable.derivContractId,
        agentReasoning: tradesTable.agentReasoning,
        createdAt: tradesTable.createdAt,
      })
      .from(tradesTable)
      .where(
        and(
          inArray(tradesTable.status, ["open", "error"]),
          gte(tradesTable.createdAt, since),
          sql`${tradesTable.createdAt} <= ${cutoff}`,
        ),
      )
      .limit(RECONCILE_BATCH)) as UnsettledRow[];

    if (rows.length === 0) return 0;

    // One Deriv lookup per session (the journal is per connected account).
    const bySession = new Map<string, UnsettledRow[]>();
    for (const row of rows) {
      const list = bySession.get(row.sessionId) ?? [];
      list.push(row);
      bySession.set(row.sessionId, list);
    }

    for (const [sessionId, sessionRows] of bySession) {
      try {
        const accounts = await db
          .select()
          .from(accountsTable)
          .where(and(eq(accountsTable.sessionId, sessionId), eq(accountsTable.isActive, true)))
          .limit(1);
        const account = accounts[0] ?? (await db
          .select()
          .from(accountsTable)
          .where(eq(accountsTable.sessionId, sessionId))
          .limit(1))[0];
        const token = account?.bearerToken ?? account?.token ?? null;
        if (!token || !account) continue;

        const transactions = await fetchDerivProfitTable(
          token,
          account.derivAccountId ?? account.loginId,
          100,
        );
        if (transactions.length === 0) continue;

        for (const row of sessionRows) {
          // Omni owns a durable purchase intent and atomically settles it with
          // the shared recovery ledger. Its unknown acknowledgements must NEVER
          // be fuzzy-matched by this legacy display-only reconciliation path.
          // Restart recovery is resumed by Omni's next explicit deployment.
          if (row.agentReasoning?.startsWith("[Omni Sentinel] ")) continue;
          const tx = findTransaction(row, transactions);
          if (!tx) continue;
          const buyPrice = Number(tx.buy_price ?? 0);
          const sellPrice = Number(tx.sell_price ?? 0);
          const profit = Math.round((sellPrice - buyPrice) * 100) / 100;
          const won = profit > 0;
          await db
            .update(tradesTable)
            .set({
              status: won ? "won" : "lost",
              profit: String(profit),
              payout: String(won ? buyPrice + profit : 0),
              exitPrice: String(sellPrice || buyPrice),
              derivContractId: tx.contract_id != null ? String(tx.contract_id) : row.derivContractId,
              closedAt: tx.sell_time ? new Date(Number(tx.sell_time) * 1000) : new Date(),
            })
            .where(eq(tradesTable.id, row.id));
          settled++;
          logger.info(
            { tradeId: row.id, contractId: tx.contract_id, won, profit },
            "Reconciler settled an interrupted trade from Deriv's profit table",
          );
        }
      } catch (err) {
        // One session's failure must never stop the sweep for the others.
        logger.warn({ err, sessionId }, "Reconciliation failed for one session — continuing");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Trade reconciliation sweep failed");
  }
  return settled;
}

let reconcilerTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic sweep (idempotent). */
export function startTradeReconciler(intervalMs = 60_000): void {
  if (reconcilerTimer) return;
  // First sweep shortly after boot so a redeploy heals immediately.
  setTimeout(() => { void reconcileUnsettledTrades(); }, 15_000).unref?.();
  reconcilerTimer = setInterval(() => { void reconcileUnsettledTrades(); }, intervalMs);
  reconcilerTimer.unref?.();
}
