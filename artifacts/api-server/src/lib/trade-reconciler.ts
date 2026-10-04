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
import { accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { fetchDerivProfitTable } from "./deriv";
import { logger } from "./logger";
import { runWithSession } from "./session";
import * as recoveryEngine from "./agents/recovery-engine";

/** Trades older than this that are still `open` are considered unsettled. */
const RECONCILE_AFTER_MS = 90_000;
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

/** A definitive pre-buy rejection is not an unsettled broker contract. */
export const NO_PURCHASE_CONFIRMED_MARKER = "[NO_PURCHASE_CONFIRMED]";

export function isUnsettledTradeRecord(trade: { status: string; agentReasoning?: string | null }): boolean {
  return trade.status === "open" || (
    trade.status === "error" && !trade.agentReasoning?.includes(NO_PURCHASE_CONFIRMED_MARKER)
  );
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
  const candidates = transactions.flatMap((transaction) => {
    const symbol = String(transaction.underlying_symbol ?? transaction.symbol ?? "");
    const contractType = String(transaction.contract_type ?? "");
    const purchaseRaw = Number(transaction.purchase_time ?? 0);
    const purchaseSec = purchaseRaw > 1e11 ? purchaseRaw / 1000 : purchaseRaw;
    if (symbol !== row.symbol || !family.includes(contractType)) return [];
    if (!Number.isFinite(Number(transaction.buy_price)) || Math.abs(Number(transaction.buy_price) - stake) > 0.02) return [];
    // Without the broker timestamp the fallback match is not safe enough to
    // reconcile a real-money row.
    if (!Number.isFinite(purchaseSec) || purchaseSec <= 0) return [];
    const timeDelta = Math.abs(purchaseSec - createdSec);
    if (timeDelta > 300) return [];
    return [{ transaction, timeDelta }];
  }).sort((a, b) => a.timeDelta - b.timeDelta);

  if (candidates.length === 0) return null;
  // Never settle two local rows from the same broker transaction, and avoid a
  // fuzzy match when two same-stake contracts are indistinguishable in time.
  if (candidates.length > 1 && candidates[1].timeDelta - candidates[0].timeDelta < 3) return null;
  return candidates[0].transaction;
}

/**
 * Settle every `open`/`error` trade that Deriv has already resolved.
 * Returns the number of rows settled.
 */
let reconciliationInFlight: Promise<number> | null = null;

/** Single-flight the periodic sweep and an autonomous-loop preflight sweep. */
export function reconcileUnsettledTrades(sessionId?: string): Promise<number> {
  if (reconciliationInFlight) return reconciliationInFlight;
  const work = reconcileUnsettledTradesInner(sessionId);
  reconciliationInFlight = work.finally(() => { reconciliationInFlight = null; });
  return reconciliationInFlight;
}

async function reconcileUnsettledTradesInner(sessionId?: string): Promise<number> {
  let settled = 0;
  try {
    const cutoff = new Date(Date.now() - RECONCILE_AFTER_MS);

    const filters = [
      inArray(tradesTable.status, ["open", "error"]),
      sql`${tradesTable.createdAt} <= ${cutoff}`,
    ];
    if (sessionId) filters.push(eq(tradesTable.sessionId, sessionId));

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
      .where(and(...filters))
      .orderBy(desc(tradesTable.createdAt))
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

        // Recovery parameters for THIS account, so a settled outcome steps the
        // same step cap the engine that opened the trade would have used.
        const settingsRows = await db
          .select()
          .from(settingsTable)
          .where(eq(settingsTable.sessionId, sessionId))
          .limit(1);
        const maxRecoverySteps = Number((settingsRows[0] as any)?.maxRecoverySteps ?? 3) || 3;

        const transactions = await fetchDerivProfitTable(
          token,
          account.derivAccountId ?? account.loginId,
          100,
        );
        if (transactions.length === 0) continue;
        const claimedContractIds = new Set<string>();

        for (const row of sessionRows) {
          // Omni owns a durable purchase intent and atomically settles it with
          // the shared recovery ledger. Its unknown acknowledgements must NEVER
          // be fuzzy-matched by this legacy display-only reconciliation path.
          // Restart recovery is resumed by Omni's next explicit deployment.
          if (row.agentReasoning?.startsWith("[Omni Sentinel] ")) continue;
          if (row.agentReasoning?.includes(NO_PURCHASE_CONFIRMED_MARKER)) continue;
          const tx = findTransaction(row, transactions.filter((candidate) =>
            !claimedContractIds.has(String(candidate.contract_id ?? "")),
          ));
          if (!tx) continue;
          const contractId = String(tx.contract_id ?? "");
          if (!contractId || claimedContractIds.has(contractId)) continue;
          claimedContractIds.add(contractId);
          const buyPrice = Number(tx.buy_price ?? 0);
          const sellPrice = Number(tx.sell_price ?? 0);
          const profit = Math.round((sellPrice - buyPrice) * 100) / 100;
          const won = profit > 0;
          const updatedRows = await db
            .update(tradesTable)
            .set({
              status: won ? "won" : "lost",
              profit: String(profit),
              payout: String(won ? buyPrice + profit : 0),
              exitPrice: String(sellPrice || buyPrice),
              derivContractId: contractId,
              closedAt: tx.sell_time ? new Date(Number(tx.sell_time) * 1000) : new Date(),
            })
            .where(and(eq(tradesTable.id, row.id), inArray(tradesTable.status, ["open", "error"])))
            .returning({ id: tradesTable.id });
          if (updatedRows.length === 0) continue;
          settled++;
          // A REAL money outcome must reach the shared recovery ledger. This row
          // was abandoned (open/error) by the engine that opened it, so without
          // this the loss never grew the debt and the engine's next recovery
          // trade repeated the SAME stake — and the journal showed a loss the
          // ledger never knew about. Executed under the trade's OWN session, so
          // it can only ever touch this account's ledger.
          try {
            runWithSession(sessionId, () => {
              recoveryEngine.setPersistenceSession(sessionId);
              if (!recoveryEngine.isTrackedContract(row.contractType)) return;
              const payoutMultiplier = won && buyPrice > 0
                ? Math.round(((buyPrice + profit) / buyPrice) * 1000) / 1000
                : 1;
              recoveryEngine.recordOutcome(
                won, profit, buyPrice, maxRecoverySteps, row.contractType, payoutMultiplier, `trade:${row.id}`,
              );
            });
          } catch (ledgerErr) {
            logger.warn({ ledgerErr, tradeId: row.id }, "Reconciler could not update the recovery ledger");
          }
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
