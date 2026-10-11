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
import { fetchDerivProfitTable, onJournalTransactions } from "./deriv";
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
/**
 * Autonomous 1-tick rows keep their own, much longer sweep window.
 *
 * WHY: an autonomous row that has not settled yet is the ONE thing that can
 * gate the autonomous engine (see `exposureResolved`). Dropping it out of the
 * sweep after 24 h would make the gate permanent with nothing left to resolve
 * it, so these rows stay reachable for a week — long enough for any Deriv
 * outage, token expiry or pagination miss to be healed on a later sweep.
 */
const AUTONOMOUS_RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
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
/** Deriv's hard cap on `profit_table` rows per request. */
const AUTONOMOUS_PAGE_SIZE = 500;
/**
 * How many 500-row pages one sweep may walk back per account.
 *
 * A single 100-row window was the ORIGINAL BUG: the account is shared with
 * every bot, the FAB and manual trades, so once ~100 transactions had happened
 * after a stuck autonomous row, its contract could never appear in a
 * newest-first page again — the window only moves forward, the row only gets
 * older. Four pages (2 000 transactions) is a bounded, rate-limit-friendly
 * walk back that reaches any row of the last week on all but an extremely busy
 * account. We stop as soon as a page reaches past the row's own creation time.
 */
const AUTONOMOUS_MAX_PAGES = 4;
/**
 * Gap between two pages of one autonomous walk.
 *
 * Deriv throttles `profit_table` to roughly ONE request every 3–5 s per
 * account (the journal spaces its own pagination chain exactly 5 s apart for
 * this reason). The walk used to fire its pages back-to-back — four requests
 * inside half a second — which tripped the account-wide RateLimit on every
 * sweep; and because the fetch was all-or-nothing, that error threw away the
 * pages ALREADY fetched (the one carrying the just-settled 1-tick contract),
 * so the row stayed open and the engine kept HOLDing on a trade Deriv had
 * already closed. Pacing the walk is what turns the sweep from a rate-limit
 * bomb back into a background safety net.
 */
const AUTONOMOUS_PAGE_DELAY_MS = 5_000;

export interface UnsettledRow {
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

/**
 * True when a page of newest-first transactions has walked back far enough that
 * no later page can contain something older than `dateFromSec`.
 *
 * Exported (and pure) so the walk-back contract is pinned by a test: the bug it
 * guards against — a stuck row disappearing out of a fixed-size window forever
 * — is exactly a "the loop stopped too early" bug.
 */
export function profitTablePageReachedWindow(
  batch: Array<{ purchase_time?: unknown; sell_time?: unknown }>,
  dateFromSec: number,
): boolean {
  if (batch.length === 0) return true;
  let oldest = Number.POSITIVE_INFINITY;
  for (const tx of batch) {
    const at = Number(tx?.purchase_time ?? tx?.sell_time ?? 0) || Number.POSITIVE_INFINITY;
    if (at < oldest) oldest = at;
  }
  if (!Number.isFinite(oldest)) return false;
  return oldest <= dateFromSec;
}

/**
 * Every profit-table transaction at/after `earliestMs`, newest page first.
 *
 * Pages back with `offset` until the page reaches the row's own era, so an
 * unsettled row is always visible to the matcher no matter how many newer
 * transactions have accumulated on top of it.
 *
 * THREE safety properties, all learned from the production hold bug:
 *
 *  - PAGES ARE PACED (`AUTONOMOUS_PAGE_DELAY_MS`). Deriv's `profit_table`
 *    limit is account-wide and roughly one request per 3–5 s; a back-to-back
 *    burst trips it on the second page and the whole sweep dies.
 *  - A FAILED PAGE NEVER DISCARDS THE PAGES BEFORE IT. The walk returns what
 *    it has with `complete: false` instead of throwing: a just-settled 1-tick
 *    trade sits on page 1 and must be settled even when page 3 times out.
 *    Throwing away page 1 because page 3 failed is exactly how a closed
 *    contract kept the engine HOLDing for minutes.
 *  - THE WALK STOPS EARLY once every row it is sweeping has found its exact
 *    transaction. A stale open row left behind by an older bug widens
 *    `date_from` to its own era and would otherwise force the full walk (and
 *    its full request budget) on EVERY sweep forever; with the early stop the
 *    common case costs one request.
 *
 * `complete` reports whether the lookup saw the row's whole window (table
 * exhausted, window reached, or every row matched). Only a complete lookup may
 * ever be read as "no such trade" — the no-id release is gated on it, so an
 * outage or a walk cut short by `AUTONOMOUS_MAX_PAGES` is never mistaken for a
 * buy that never happened.
 *
 * `options` exists for tests (fake fetcher, zero delay); production uses the
 * real Deriv client and the paced delay.
 */
export interface AutonomousWalkOptions {
  fetchProfitTable?: typeof fetchDerivProfitTable;
  pageDelayMs?: number;
}

export async function fetchAutonomousTransactions(
  token: string,
  accountId: string,
  rows: UnsettledRow[],
  earliestMs: number,
  options: AutonomousWalkOptions = {},
): Promise<{ transactions: any[]; complete: boolean }> {
  const fetchProfitTable = options.fetchProfitTable ?? fetchDerivProfitTable;
  const pageDelayMs = options.pageDelayMs ?? AUTONOMOUS_PAGE_DELAY_MS;
  const dateFromSec = Math.floor((earliestMs - AUTONOMOUS_LOOKBACK_MS) / 1000);
  const all: any[] = [];
  const everyRowFound = () =>
    rows.every(
      (r) =>
        !r.derivContractId ||
        all.some((t) => String(t.contract_id ?? "") === String(r.derivContractId)),
    );
  for (let page = 0; page < AUTONOMOUS_MAX_PAGES; page++) {
    if (page > 0) await sleep(pageDelayMs);
    let batch: any[];
    try {
      batch = await fetchProfitTable(token, accountId, AUTONOMOUS_PAGE_SIZE, {
        dateFrom: dateFromSec,
        offset: page * AUTONOMOUS_PAGE_SIZE,
        strict: true,
      });
    } catch (err) {
      // Partial walk: keep what we have. The caller settles every match it can
      // see and leaves the rest for the next sweep — never reads this as
      // "no such trade".
      logger.warn({ err, page }, "Autonomous profit-table walk interrupted — settling from the pages already fetched");
      return { transactions: all, complete: false };
    }
    all.push(...batch);
    if (batch.length < AUTONOMOUS_PAGE_SIZE) return { transactions: all, complete: true };
    if (profitTablePageReachedWindow(batch, dateFromSec)) return { transactions: all, complete: true };
    if (everyRowFound()) return { transactions: all, complete: true };
  }
  return { transactions: all, complete: false };
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
 *
 * `lookupComplete` says the transaction list covers the rows' WHOLE window
 * (the walk was not cut short by a page failure or the page cap). Only then
 * may a missing transaction be read as "no such trade" and release a no-id
 * row — a partial or failed lookup settles what it can see and changes
 * nothing else.
 */
export async function settleAutonomousRows(
  sessionId: string,
  rows: UnsettledRow[],
  transactions: any[],
  maxRecoverySteps: number,
  lookupComplete = true,
): Promise<number> {
  let settled = 0;
  const claimed = await loadClaimedContractIds(sessionId, new Date(Date.now() - RECONCILE_WINDOW_MS));
  const matches = matchAutonomousRows(rows as ReconRow[], transactions as DerivTx[], claimed);

  for (const row of rows) {
    const tx = matches.get(row.id);
    if (!tx) {
      const unresolvedFor = Date.now() - row.createdAt.getTime();
      if (lookupComplete && !row.derivContractId && unresolvedFor > AUTONOMOUS_UNRESOLVED_AFTER_MS) {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real-time settle path: the journal merged a profit_table batch (Deriv pushed
 * a `transaction`/sell event and the quick refresh answered with the settled
 * rows). Any still-open autonomous row whose exact contract id is in that batch
 * is settled NOW, through the same claim-unique writer as the sweep — no extra
 * Deriv request, no rate-limit pressure, and no minutes-long wait for the next
 * sweep. Exact contract ids only; a batch can never fuzzy-match a row.
 *
 * Only transactions that carry a settlement (`sell_price` and `sell_time`) are
 * offered to the matcher: profit_table rows are settled contracts, and this
 * filter makes it impossible for a half-filled payload to be recorded as a loss.
 */
export async function settleFromJournalBatch(accountId: string, transactions: any[]): Promise<number> {
  try {
    const settledTxs = transactions.filter(
      (t) => t?.contract_id != null && t.sell_price != null && t.sell_time != null,
    );
    if (settledTxs.length === 0) return 0;
    const ids = settledTxs.map((t) => String(t.contract_id));
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
      .where(and(
        eq(tradesTable.status, "open"),
        like(tradesTable.agentReasoning, `${AUTONOMOUS_HEDGE_PREFIX}%`),
        inArray(tradesTable.derivContractId, ids),
      ))
      .limit(RECONCILE_BATCH)) as UnsettledRow[];
    if (rows.length === 0) return 0;

    let settled = 0;
    const bySession = new Map<string, UnsettledRow[]>();
    for (const row of rows) {
      const list = bySession.get(row.sessionId) ?? [];
      list.push(row);
      bySession.set(row.sessionId, list);
    }
    for (const [sessionId, sessionRows] of bySession) {
      const settingsRows = await db
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.sessionId, sessionId))
        .limit(1);
      const maxRecoverySteps = Number((settingsRows[0] as any)?.maxRecoverySteps ?? 3) || 3;
      settled += await settleAutonomousRows(sessionId, sessionRows, settledTxs, maxRecoverySteps, true);
    }
    if (settled > 0) {
      logger.info({ accountId, settled }, "Reconciler settled autonomous 1-tick trades from the journal's real-time feed");
    }
    return settled;
  } catch (err) {
    logger.warn({ err, accountId }, "Real-time journal settle failed — the periodic sweep still covers these rows");
    return 0;
  }
}

/**
 * Settle every `open`/`error` trade that Deriv has already resolved.
 * Returns the number of rows settled.
 *
 * One sweep at a time: the exposure gate re-requests reconciliation every few
 * seconds while it holds, and the periodic timer adds its own — concurrent
 * sweeps would multiply the profit_table walk (and its rate-limit pressure)
 * without settling anything sooner.
 */
let sweepInFlight: Promise<number> | null = null;

export function reconcileUnsettledTrades(): Promise<number> {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = runReconcileSweep().finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

async function runReconcileSweep(): Promise<number> {
  let settled = 0;
  try {
    const since = new Date(Date.now() - RECONCILE_WINDOW_MS);
    const autonomousSince = new Date(Date.now() - AUTONOMOUS_RECONCILE_WINDOW_MS);
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
        or(
          // Autonomous 1-tick rows: only while still open, on the short grace —
          // but with their OWN (much longer) age window, so a stuck row can
          // never age out of the only sweep that can resolve it.
          and(
            gte(tradesTable.createdAt, autonomousSince),
            eq(tradesTable.status, "open"),
            like(tradesTable.agentReasoning, `${AUTONOMOUS_HEDGE_PREFIX}%`),
            lte(tradesTable.createdAt, autonomousCutoff),
          ),
          // Every other row keeps the original rule, unchanged.
          and(
            gte(tradesTable.createdAt, since),
            inArray(tradesTable.status, ["open", "error"]),
            or(isNull(tradesTable.agentReasoning), notLike(tradesTable.agentReasoning, `${AUTONOMOUS_HEDGE_PREFIX}%`)),
            lte(tradesTable.createdAt, cutoff),
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

        // Autonomous 1-tick rows: a paced, paged walk. The walk settles from
        // whatever pages it could fetch (a failed page never discards the
        // earlier ones), and only a COMPLETE walk may release a no-id row —
        // so neither a Deriv outage nor a walk cut short by the page cap can
        // ever be read as "no such trade".
        const autonomousRows = sessionRows.filter((r) => isAutonomousHedgeRow(r.agentReasoning));
        if (autonomousRows.length > 0) {
          const earliest = Math.min(...autonomousRows.map((r) => r.createdAt.getTime()));
          const walk = await fetchAutonomousTransactions(token, accountId, autonomousRows, earliest);
          settled += await settleAutonomousRows(sessionId, autonomousRows, walk.transactions, maxRecoverySteps, walk.complete);
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
let journalHookInstalled = false;

/** Start the periodic sweep (idempotent). */
export function startTradeReconciler(intervalMs = 60_000): void {
  if (reconcilerTimer) return;
  // Real-time fast path: settle from the journal's own profit_table batches
  // the moment Deriv confirms a contract, instead of waiting for a sweep.
  if (!journalHookInstalled) {
    journalHookInstalled = true;
    onJournalTransactions((accountId, transactions) => {
      void settleFromJournalBatch(accountId, transactions);
    });
  }
  // First sweep shortly after boot so a redeploy heals immediately.
  setTimeout(() => { void reconcileUnsettledTrades(); }, 15_000).unref?.();
  reconcilerTimer = setInterval(() => { void reconcileUnsettledTrades(); }, intervalMs);
  reconcilerTimer.unref?.();
}
