/**
 * Missed Opportunity Agent
 *
 * RESPONSIBILITY: When the AI rejects a trade, continue monitoring the market.
 * After the would-be contract's duration elapses, evaluate whether the rejected
 * trade would have won.  Accumulate statistics to identify filters that are
 * unnecessarily strict, reduce missed opportunities over time.
 *
 * The evaluation uses the live tick / digit buffer at settlement time to
 * reconstruct whether the contract would have resolved in the AI's favour.
 *
 * Supported contract types:
 *   CALL / PUT      → price at exit vs entry (direction)
 *   DIGITOVER N     → last digit of the price at exit > N
 *   DIGITUNDER N    → last digit of the price at exit < N
 *   DIGITEVEN       → last digit even
 *   DIGITODD        → last digit odd
 */

import { db } from "@workspace/db";
import { missedOpportunitiesTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import type { CoordinatorOutput } from "./types";
import { tickManager } from "../deriv";
import { logger } from "../logger";
import { getFallbackPayout } from "../payouts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MissedOpportunityInput {
  symbol:        string;
  contractType:  string;
  barrier?:      number | null;
  rejectReason?: string;
  output:        CoordinatorOutput;
  duration:      number;  // in ticks (approximated as seconds for setTimeout)
  stake:         number;
}

// ── In-memory queue of pending evaluations ────────────────────────────────────
// We schedule a setTimeout for each rejected trade; when it fires we check the
// outcome and persist the result.  The queue is ephemeral (cleared on restart),
// which is fine because we only care about accumulating statistics over time.
let pendingEvaluations = 0;
const MAX_PENDING = 50; // Safety cap — don't accumulate unbounded timers

// ── Outcome estimator ─────────────────────────────────────────────────────────

function estimateOutcome(
  symbol:       string,
  contractType: string,
  barrier?:     number | null,
  entryPrices?: number[],
): { wouldHaveWon: boolean; estimatedProfit: number } | null {
  const ct = contractType.toUpperCase();
  const currentPrices = tickManager.getTicks(symbol, 10);
  const currentDigits = tickManager.getDigits(symbol, 5);

  if (currentPrices.length < 2) return null;

  const exitPrice  = currentPrices[currentPrices.length - 1];
  const entryPrice = (entryPrices && entryPrices.length > 0)
    ? entryPrices[entryPrices.length - 1]
    : currentPrices[0];

  let wouldHaveWon = false;

  if (ct === "CALL" || ct === "RISE") {
    wouldHaveWon = exitPrice > entryPrice;
  } else if (ct === "PUT" || ct === "FALL") {
    wouldHaveWon = exitPrice < entryPrice;
  } else if (ct === "DIGITOVER" && barrier != null) {
    const digit = currentDigits.length > 0 ? currentDigits[currentDigits.length - 1] : null;
    if (digit === null) return null;
    wouldHaveWon = digit > barrier;
  } else if (ct === "DIGITUNDER" && barrier != null) {
    const digit = currentDigits.length > 0 ? currentDigits[currentDigits.length - 1] : null;
    if (digit === null) return null;
    wouldHaveWon = digit < barrier;
  } else if (ct === "DIGITEVEN") {
    const digit = currentDigits.length > 0 ? currentDigits[currentDigits.length - 1] : null;
    if (digit === null) return null;
    wouldHaveWon = digit % 2 === 0;
  } else if (ct === "DIGITODD") {
    const digit = currentDigits.length > 0 ? currentDigits[currentDigits.length - 1] : null;
    if (digit === null) return null;
    wouldHaveWon = digit % 2 !== 0;
  } else {
    return null; // Unknown contract type
  }

  // Estimated profit uses the same canonical barrier-aware fallback schedule as execution.
  const payoutMultiplier = getFallbackPayout(ct, barrier);
  const stake = 1; // normalised — caller scales
  const estimatedProfit = wouldHaveWon ? stake * (payoutMultiplier - 1) : -stake;

  return { wouldHaveWon, estimatedProfit };
}

// ── Main tracking function ────────────────────────────────────────────────────

/**
 * Record a rejected trade and schedule future evaluation.
 * Called fire-and-forget from the autonomous loop; never awaited.
 */
export function trackRejectedTrade(input: MissedOpportunityInput): void {
  if (pendingEvaluations >= MAX_PENDING) return; // silently drop when overloaded
  pendingEvaluations++;

  const {
    symbol, contractType, barrier, rejectReason,
    output, duration, stake,
  } = input;

  const rec = output.recommendation;
  const rejectReasonFinal = rejectReason ?? output.rejectReason ?? "Unknown";

  // Parse blockers from output
  const fusionData = output.agents?.["confidenceFusion"]?.data as any;
  const blockers: string[] = fusionData?.fusionResult?.blockers ?? [];

  // Snapshot entry prices/digits now (before market moves)
  const entryPrices = tickManager.getTicks(symbol, 5);

  // Evaluate after duration seconds (clamped: min 3s, max 60s)
  const delayMs = Math.min(Math.max(duration * 1000, 3000), 60_000);

  const now = new Date();
  const hourOfDay = now.getHours();

  setTimeout(async () => {
    pendingEvaluations--;
    try {
      const outcome = estimateOutcome(symbol, contractType, barrier, entryPrices);

      const wouldHaveWon      = outcome?.wouldHaveWon ?? null;
      const estimatedProfit   = outcome != null ? outcome.estimatedProfit * stake : null;

      // Was the rejection correct?
      // If the trade would have lost → rejection was correct.
      // If the trade would have won  → rejection may have been too strict.
      const wasRejectionCorrect = wouldHaveWon === false;
      const filterTooStrict     = wouldHaveWon === true;

      await db.insert(missedOpportunitiesTable).values({
        symbol,
        contractType,
        barrier:               barrier ?? null,
        stake:                 String(stake),
        rejectReason:          rejectReasonFinal,
        blockingFiltersJson:   JSON.stringify(blockers),
        confidenceAtRejection: String(output.confidenceScore),
        evAtRejection:         String(rec?.expectedValue ?? 0),
        qualityScore:          String(output.qualityScore),
        regime:                output.regime ?? null,
        hourOfDay,
        wouldHaveWon:          wouldHaveWon ?? undefined,
        estimatedProfit:       estimatedProfit != null ? String(estimatedProfit) : undefined,
        wasRejectionCorrect:   wasRejectionCorrect ?? undefined,
        filterTooStrict:       filterTooStrict ?? undefined,
        evaluatedAt:           new Date(),
      });

      logger.debug({
        symbol, contractType, wouldHaveWon, filterTooStrict, blockers: blockers.slice(0, 2),
      }, "Missed opportunity evaluated");

    } catch (err) {
      logger.warn({ err }, "MissedOpportunityAgent: evaluation failed");
    }
  }, delayMs);
}

// ── Query helpers ──────────────────────────────────────────────────────────────

export async function getMissedOpportunitySummary() {
  const records = await db
    .select()
    .from(missedOpportunitiesTable)
    .orderBy(desc(missedOpportunitiesTable.createdAt))
    .limit(200);

  if (records.length === 0) {
    return {
      totalTracked: 0,
      evaluated: 0,
      wouldHaveWon: 0,
      wouldHaveWonRate: 0,
      correctRejections: 0,
      correctRejectionRate: 0,
      strictFilterRate: 0,
      topBlockingFilters: [],
      recentRecords: [],
    };
  }

  const evaluated = records.filter(r => r.evaluatedAt !== null);
  const wouldHaveWon = evaluated.filter(r => r.wouldHaveWon === true);
  const correct = evaluated.filter(r => r.wasRejectionCorrect === true);
  const tooStrict = evaluated.filter(r => r.filterTooStrict === true);

  // Count blocking filter occurrences
  const filterCounts: Record<string, number> = {};
  for (const r of records) {
    try {
      const filters = JSON.parse(r.blockingFiltersJson ?? "[]") as string[];
      for (const f of filters) {
        const key = f.substring(0, 60);
        filterCounts[key] = (filterCounts[key] ?? 0) + 1;
      }
    } catch { /* ignore */ }
  }
  const topBlockingFilters = Object.entries(filterCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([filter, count]) => ({
      filter,
      count,
      tooStrictCount: tooStrict.filter(r => {
        try { return (JSON.parse(r.blockingFiltersJson ?? "[]") as string[]).some(f => f.startsWith(filter.substring(0, 30))); }
        catch { return false; }
      }).length,
    }));

  return {
    totalTracked:         records.length,
    evaluated:            evaluated.length,
    wouldHaveWon:         wouldHaveWon.length,
    wouldHaveWonRate:     evaluated.length > 0 ? Math.round(wouldHaveWon.length / evaluated.length * 100) : 0,
    correctRejections:    correct.length,
    correctRejectionRate: evaluated.length > 0 ? Math.round(correct.length / evaluated.length * 100) : 0,
    strictFilterRate:     evaluated.length > 0 ? Math.round(tooStrict.length / evaluated.length * 100) : 0,
    topBlockingFilters,
    recentRecords: records.slice(0, 10),
  };
}

export async function getRecentMissed(limit = 20) {
  return db
    .select()
    .from(missedOpportunitiesTable)
    .orderBy(desc(missedOpportunitiesTable.createdAt))
    .limit(limit);
}
