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
import { and, eq, gte, inArray, isNull, lte, notLike, or, like } from "drizzle-orm";
import { fetchDerivProfitTable } from "./deriv";
import { logger } from "./logger";
import { runWithSession } from "./session";
import * as recoveryEngine from "./agents/recovery-engine";
import { AUTONOMOUS_HEDGE_PREFIX } from "./autonomous-hedge/constants";
import {
  matchAutonomousRows,
  settledProfit,
  type DerivTx,
  type ReconRow,
} from "./autonomous-hedge/ledger-match";
import {
  claimUnsettledRow,
  isAutonomousHedgeRow,
  ledgerEntryPayout,
  loadClaimedContractIds,
  settleAutonomousRow,
} from "./autonomous-hedge/ledger";

/** Trades older than this that are still `open` are considered unsettled. */
const RECONCILE_AFTER_MS = 90_000;
/** How far back to look for unsettled rows (a day is plenty). */
const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many unsettled rows to examine per sweep. */
const RECONCILE_BATCH = 100;
/**
 * Autonomous Nexus-logic rows are 1-tick: Deriv settles them within seconds, so
 * they are reconciled after a short grace instead of the 90 s general cutoff.
 */
const AUTONOMOUS_RECONCILE_AFTER_MS = 15_000;
/**
 * An autonomous row with NO contract id that is still unmatched after this long
 * is released as unresolved. It is not counted in the ledger. A buy that never
 * appears on the broker's books inside this window was not placed.
 */
const AUTONOMOUS_UNRESOLVED_AFTER_MS = 10 * 60 * 1000;
/** How far before a row's creation the broker lookup starts (covers an in-flight buy). */
const AUTONOMOUS_LOOKBACK_MS = 2 * 60 * 1000;

interface UnsettledRow {
  id: number;
  sessionId: string;
  symbol: string;
  contractType: string;
  barrier: number | null;
  stake: string;
  derivContractId: string | null;
  /** Payout quoted at buy time (autonomous rows). Null on legacy rows. */
  entryPayout: string | null;
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
 * Autonomous rows. Exact contract id first, otherwise a claim-unique match.
 * Every settlement goes through settleAutonomousRow: the recovery ledger is made
 * durable BEFORE the row is claimed, and a row is recorded at most once. A row whose outcome is not yet on
 * the broker's books stays open, so the exposure gate keeps the engine from
 * trading over it.
 */
export async function settleAutonomousRows(
  sessionId: string,
  rows: UnsettledRow[],
  transactions: any[],
  maxRecoverySteps: number,
): Promise<number> {
  let settled = 0;
  const claimed = await loadClaimedContractIds(sessionId, new Date(Date.now() - RECONCILE_WINDOW_MS));
  const matches = matchAutonomousRows(rows as ReconRow[], transactions as DerivTx[], claimed);

  for (const row of rows) {
    const tx = matches.get(row.id);
    if (!tx) {
      const unresolvedFor = Date.now() - row.createdAt.getTime();
      if (!row.derivContractId && unresolvedFor > AUTONOMOUS_UNRESOLVED_AFTER_MS) {
        const released = await claimUnsettledRow(row.id, {
          status: "error",
          profit: "0",
          payout: "0",
          closedAt: new Date(),
          agentReasoning: `${row.agentReasoning ?? ""} [UNRESOLVED: no Deriv record after 10 min — not counted in the recovery ledger]`,
        });
        if (released) {
          logger.warn({ tradeId: row.id, sessionId }, "Autonomous row released as unresolved — no Deriv record");
        }
      }
      continue;
    }

    const { buy, sell, profit, won } = settledProfit(tx as DerivTx);
    const txContractId = tx.contract_id != null ? String(tx.contract_id) : row.derivContractId;
    // The quote the row was bought at, on win AND loss (see ledgerEntryPayout).
    const payoutMultiplier = ledgerEntryPayout(
      row.entryPayout == null ? null : Number(row.entryPayout),
      row.contractType,
      row.barrier,
    );
    const settlement = await settleAutonomousRow(
      sessionId,
      row.id,
      {
        status: won ? "won" : "lost",
        profit: String(profit),
        payout: String(won ? buy + profit : 0),
        exitPrice: String(sell || buy),
        derivContractId: txContractId,
        closedAt: tx.sell_time ? new Date(Number(tx.sell_time) * 1000) : new Date(),
      },
      { won, profit, cost: buy, contract: row.contractType, payout: payoutMultiplier, maxRecoverySteps },
    );
    if (settlement !== "settled") continue; // already settled elsewhere, or held for retry
    settled++;
    logger.info(
      { tradeId: row.id, contractId: txContractId, won, profit },
      "Reconciler settled an autonomous 1-tick trade from Deriv's profit table",
    );
  }
  return settled;
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
    const autonomousCutoff = new Date(Date.now() - AUTONOMOUS_RECONCILE_AFTER_MS);

    const rows = (await db
      .select({
        id: tradesTable.id,
        sessionId: tradesTable.sessionId,
        symbol: tradesTable.symbol,
        contractType: tradesTable.contractType,
        barrier: tradesTable.barrier,
        stake: tradesTable.stake,
        derivContractId: tradesTable.derivContractId,
        entryPayout: tradesTable.entryPayout,
        agentReasoning: tradesTable.agentReasoning,
        createdAt: tradesTable.createdAt,
      })
      .from(tradesTable)
      .where(
        and(
          gte(tradesTable.createdAt, since),
          or(
            // Autonomous 1-tick rows: only while still open, on the short grace.
            and(
              eq(tradesTable.status, "open"),
              like(tradesTable.agentReasoning, `${AUTONOMOUS_HEDGE_PREFIX}%`),
              lte(tradesTable.createdAt, autonomousCutoff),
            ),
            // Every other row keeps the original rule, unchanged.
            and(
              inArray(tradesTable.status, ["open", "error"]),
              or(isNull(tradesTable.agentReasoning), notLike(tradesTable.agentReasoning, `${AUTONOMOUS_HEDGE_PREFIX}%`)),
              lte(tradesTable.createdAt, cutoff),
            ),
          ),
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

        // Recovery parameters for THIS account, so a settled outcome steps the
        // same step cap the engine that opened the trade would have used.
        const settingsRows = await db
          .select()
          .from(settingsTable)
          .where(eq(settingsTable.sessionId, sessionId))
          .limit(1);
        const maxRecoverySteps = Number((settingsRows[0] as any)?.maxRecoverySteps ?? 3) || 3;

        const accountId = account.derivAccountId ?? account.loginId;

        // Autonomous 1-tick rows: a bounded, STRICT lookup. A failed lookup
        // throws and the rows stay open, so an outage can never be read as
        // "no such trade" and released out of the recovery ledger.
        const autonomousRows = sessionRows.filter((r) => isAutonomousHedgeRow(r.agentReasoning));
        if (autonomousRows.length > 0) {
          const earliest = Math.min(...autonomousRows.map((r) => r.createdAt.getTime()));
          const autonomousTx = await fetchDerivProfitTable(token, accountId, 100, {
            dateFrom: Math.floor((earliest - AUTONOMOUS_LOOKBACK_MS) / 1000),
            strict: true,
          });
          settled += await settleAutonomousRows(sessionId, autonomousRows, autonomousTx, maxRecoverySteps);
        }

        // Legacy rows: unchanged lookup and matching.
        const legacyRows = sessionRows.filter((r) => !isAutonomousHedgeRow(r.agentReasoning));
        if (legacyRows.length === 0) continue;
        const transactions = await fetchDerivProfitTable(token, accountId, 100);
        if (transactions.length === 0) continue;

        for (const row of legacyRows) {
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
                won, profit, buyPrice, maxRecoverySteps, row.contractType, payoutMultiplier,
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
