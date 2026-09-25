/**
 * DBot fill mirror — Deriv's profit_table → the app's journal + shared ledger.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A Deriv DBot trades from the browser, on the account this app selected, and
 * Deriv — not the desktop — is the record of what happened. Two things must not
 * be allowed to drift because of that:
 *
 *   1. the app's recovery ledger. It is account-level and shared by every
 *      engine (lib/agents/recovery-engine): if DBot losses were invisible to it,
 *      the next server-side bot would size its stake as if the account were
 *      flat — exactly the "normal/recovery mix-up" class of bug the arbiter
 *      exists to prevent.
 *   2. the app's journal. The user must see DBot fills inside NeuroTrade, tagged
 *      as coming from the DBot (`deriv-dbot`), not only in Deriv's own UI.
 *
 * HOW
 * ───
 * While a DBot is live, Bot Studio posts heartbeats (`POST /api/dbots/:id/
 * heartbeat`); each heartbeat runs one mirror pass for that bot. The pass reads
 * the account's recent profit_table rows and takes the ones that can only be
 * this bot's fills:
 *
 *   symbol        === the bot's scanned symbol
 *   contract_type ∈ the bot's contract types (DIGITOVER / DIGITUNDER)
 *   purchase_time ≥ the moment the bot went live (− a small clock-skew grace)
 *   contract_id   not already mirrored (idempotency, so re-polls are free)
 *
 * Each new fill becomes a journal row (with `derivContractId` = Deriv's
 * contract id, so the app's own reconciler can settle it if a mirror pass is
 * missed) and one `recordOutcome()` — a WIN pays the shared ledger down, a LOSS
 * grows it by the stake, arrow for arrow with what the bot's own ladder did in
 * the browser.
 */

import { db, tradesTable } from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";
import { ensureFreshBearerToken, fetchDerivProfitTable } from "../deriv";
import { normalizeDerivContractType, extractBarrierFromLongcode } from "../deriv-longcode";
import * as recoveryEngine from "../agents/recovery-engine";
import { runWithSessionId } from "../session";
import { logger } from "../logger";
import { activeAccountForSession } from "./factory";
import { appendFill, stopDbot, type DbotFill, type DbotRecord } from "./registry";

/** Source tag every mirrored DBot journal row carries. */
export const DBOT_SOURCE_TAG = "deriv-dbot";
/** Rows pulled per mirror pass (newest first, so a busy bot is never missed). */
const PROFIT_TABLE_LIMIT = 25;
/** Clock-skew grace around the moment the bot went live. */
const LIVE_GRACE_MS = 60_000;

/** Injectable for tests — the real one is Deriv's authenticated profit_table. */
type ProfitTableFetcher = (bearerToken: string, accountId: string, limit: number) => Promise<any[]>;
let fetchProfitTable: ProfitTableFetcher = (bearerToken, accountId, limit) =>
  fetchDerivProfitTable(bearerToken, accountId, limit);

export function __setProfitTableFetcherForTests(fetcher: ProfitTableFetcher | null): void {
  fetchProfitTable = fetcher ?? ((bearerToken, accountId, limit) => fetchDerivProfitTable(bearerToken, accountId, limit));
}

export interface MirrorResult {
  /** Rows Deriv returned for the account. */
  fetched: number;
  /** Fills that were this bot's and had not been mirrored yet. */
  newFills: DbotFill[];
  /** How many of them reached the shared recovery ledger. */
  ledgerRecorded: number;
  /** Set when the pass could not run (no account / no credential / switched). */
  skipped?: "no-account" | "no-credential" | "account-switched";
}

/** True when a profit_table row can only belong to this bot. */
function belongsToBot(record: DbotRecord, row: any): boolean {
  const symbol = row?.underlying_symbol ?? row?.symbol;
  if (symbol !== record.symbol) return false;
  const contractType = String(row?.contract_type ?? "");
  if (!record.contractTypes.includes(contractType)) return false;
  const contractId = row?.contract_id ?? row?.contractId;
  if (!contractId) return false;
  const purchasedAt = Number(row?.purchase_time ?? 0) * 1000;
  const floor = (record.liveSince ?? record.createdAt) - LIVE_GRACE_MS;
  if (!Number.isFinite(purchasedAt) || purchasedAt < floor) return false;
  return true;
}

function toFill(row: any, record: DbotRecord): DbotFill {
  const stake = Number(row.buy_price ?? 0);
  const payout = Number(row.sell_price ?? 0);
  const profit = Math.round((payout - stake) * 100) / 100;
  return {
    contractId: String(row.contract_id ?? row.contractId),
    transactionId: row.transaction_id != null ? String(row.transaction_id) : null,
    contractType: normalizeDerivContractType(String(row.contract_type ?? "")),
    symbol: String(row.underlying_symbol ?? row.symbol ?? record.symbol),
    stake,
    payout,
    profit,
    won: profit > 0,
    barrier: extractBarrierFromLongcode(row.longcode) ?? null,
    purchasedAt: new Date(Number(row.purchase_time ?? 0) * 1000).toISOString(),
    closedAt: row.sell_time ? new Date(Number(row.sell_time) * 1000).toISOString() : null,
    longcode: typeof row.longcode === "string" ? row.longcode : null,
  };
}

/**
 * One mirror pass for one bot. Safe to call repeatedly: fills already in the
 * journal (by Deriv contract id) are never counted or inserted twice.
 */
export async function mirrorDbotFills(sessionId: string, record: DbotRecord): Promise<MirrorResult> {
  const result: MirrorResult = { fetched: 0, newFills: [], ledgerRecorded: 0 };

  const account = await activeAccountForSession(sessionId);
  if (!account) return { ...result, skipped: "no-account" };
  const accountId = account.derivAccountId || account.loginId;

  // A DBot must never outlive the account it was built for: switching demo ↔
  // real (or to another account) stops it instead of mirroring a stranger's
  // fills into this bot's history.
  if (accountId !== record.accountId) {
    stopDbot(sessionId, record.id, "account-switch");
    logger.info(
      { sessionId, dbotId: record.id, accountId, builtFor: record.accountId },
      "dbots: account changed — DBot stopped",
    );
    return { ...result, skipped: "account-switched" };
  }

  const stored = account.bearerToken ?? account.token ?? "";
  if (!stored) return { ...result, skipped: "no-credential" };
  const bearer = await ensureFreshBearerToken(accountId, stored);

  const rows = await fetchProfitTable(bearer, accountId, PROFIT_TABLE_LIMIT);
  result.fetched = rows.length;
  const candidates = rows.filter((row) => belongsToBot(record, row)).map((row) => toFill(row, record));
  if (candidates.length === 0) return result;

  // Idempotency: what the journal already holds for these contract ids.
  const ids = candidates.map((fill) => fill.contractId);
  const already = await db
    .select({ derivContractId: tradesTable.derivContractId })
    .from(tradesTable)
    .where(and(eq(tradesTable.sessionId, sessionId), inArray(tradesTable.derivContractId, ids)));
  const known = new Set(already.map((row) => row.derivContractId));

  // Oldest first: the ledger must see the fills in the order they settled.
  const fresh = candidates
    .filter((fill) => !known.has(fill.contractId))
    .sort((a, b) => Date.parse(a.purchasedAt) - Date.parse(b.purchasedAt));

  for (const fill of fresh) {
    const direction = fill.contractType === "DIGITOVER" ? "up" : "down";
    await db.insert(tradesTable).values({
      sessionId,
      symbol: fill.symbol,
      displayName: record.displayName,
      contractType: fill.contractType,
      barrier: fill.barrier,
      stake: fill.stake.toFixed(2),
      direction,
      status: fill.won ? "won" : "lost",
      payout: fill.payout.toFixed(2),
      profit: fill.profit.toFixed(2),
      derivContractId: fill.contractId,
      // Not autonomous: a human built this bot and ran it in Bot Studio. The
      // reasoning line carries the source tag every consumer filters on.
      isAutonomous: false,
      agentReasoning: `[${DBOT_SOURCE_TAG}] ${record.name} (${record.id}) — run from the ${record.spec.source.console} scan`,
      duration: 1,
      durationUnit: "t",
      createdAt: new Date(fill.purchasedAt),
      closedAt: fill.closedAt ? new Date(fill.closedAt) : null,
    });

    // Mirror the fill into the SINGLE shared recovery ledger. Wrapped in this
    // session's context so the outcome lands on the right account's state.
    runWithSessionId(sessionId, () => {
      recoveryEngine.recordOutcome(
        fill.won,
        fill.profit,
        fill.stake,
        record.spec.recoveryState.maxSteps,
        fill.contractType,
        fill.stake > 0 ? Math.max(1, fill.payout / fill.stake) : 1,
      );
    });

    if (appendFill(record, fill)) {
      result.newFills.push(fill);
      result.ledgerRecorded += 1;
    }
  }

  if (result.newFills.length > 0) {
    logger.info(
      { sessionId, dbotId: record.id, newFills: result.newFills.length, symbol: record.symbol },
      "dbots: mirrored fills into the journal + shared recovery ledger",
    );
  }
  return result;
}

/**
 * Deriv contract ids this session mirrored from a DBot.
 *
 * The app's Journal page renders Deriv's own profit_table (routes/trades.ts
 * `/deriv-journal`), so DBot fills are already visible there the moment they
 * settle. This set is what lets that page TAG them as coming from the DBot
 * (`deriv-dbot`) instead of looking like a stranger's trades.
 */
export async function dbotContractIds(sessionId: string): Promise<Set<string>> {
  const rows = await db
    .select({ derivContractId: tradesTable.derivContractId })
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.sessionId, sessionId),
        like(tradesTable.agentReasoning, `[${DBOT_SOURCE_TAG}]%`),
      ),
    );
  return new Set(rows.map((row) => row.derivContractId).filter((id): id is string => typeof id === "string"));
}
