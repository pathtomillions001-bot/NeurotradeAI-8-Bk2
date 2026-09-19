import { db } from "@workspace/db";
import { tradeFeaturesTable, tradesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getBrowserSessionId } from "./session";

// Confidence calibration is learned from ONE account's trades, so the cache is
// keyed per account. The previous single global cache let an account that had
// never traded inherit another account's calibration curve.
type CalibrationBuckets = Map<string, { bucket: number; actualRate: number; count: number }[]>;
const calibrationBySession = new Map<string, CalibrationBuckets>();
const cacheLoadedAtBySession = new Map<string, number>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function loadCalibrationCache(sessionId?: string): Promise<void> {
  const scope = sessionId ?? getBrowserSessionId();
  try {
    const rows = await db
      .select({
        rawConfidence: tradeFeaturesTable.rawConfidence,
        contractType: tradeFeaturesTable.contractType,
        status: tradesTable.status,
      })
      .from(tradeFeaturesTable)
      .innerJoin(tradesTable, and(
        eq(tradeFeaturesTable.tradeId, tradesTable.id),
        eq(tradeFeaturesTable.sessionId, scope),
      ))
      .where(sql`${tradesTable.status} IN ('won', 'lost')`);

    const buckets = new Map<string, Map<number, { wins: number; total: number }>>();

    for (const row of rows) {
      const ct = row.contractType;
      const raw = Number(row.rawConfidence ?? 50);
      const bucket = Math.floor(raw / 10) * 10;
      if (!buckets.has(ct)) buckets.set(ct, new Map());
      const ctBuckets = buckets.get(ct)!;
      const b = ctBuckets.get(bucket) ?? { wins: 0, total: 0 };
      b.total++;
      if (row.status === "won") b.wins++;
      ctBuckets.set(bucket, b);
    }

    const calibrationCache: CalibrationBuckets = new Map();
    for (const [ct, ctBuckets] of buckets) {
      const entries = [...ctBuckets.entries()]
        .map(([bucket, { wins, total }]) => ({
          bucket,
          actualRate: wins / total,
          count: total,
        }))
        .sort((a, b) => a.bucket - b.bucket);
      calibrationCache.set(ct, entries);
    }
    calibrationBySession.set(scope, calibrationCache);
    cacheLoadedAtBySession.set(scope, Date.now());
  } catch {
    // DB may not have trade_features yet
  }
}

export async function calibrateConfidence(
  rawConfidence: number,
  contractType: string,
): Promise<number> {
  const scope = getBrowserSessionId();
  const loadedAt = cacheLoadedAtBySession.get(scope) ?? 0;
  if (Date.now() - loadedAt > CACHE_TTL_MS) {
    await loadCalibrationCache(scope);
  }
  const calibrationCache: CalibrationBuckets = calibrationBySession.get(scope) ?? new Map();

  const bucket = Math.floor(rawConfidence / 10) * 10;
  const entries = calibrationCache.get(contractType) ?? calibrationCache.get("*") ?? [];

  const match = entries.find((e: { bucket: number; count: number }) => e.bucket === bucket && e.count >= 5);
  if (match) {
    return Math.round(match.actualRate * 100);
  }

  // Interpolate from nearby buckets with enough data
  const nearby = entries.filter(
    (e: { bucket: number; count: number }) => Math.abs(e.bucket - bucket) <= 20 && e.count >= 3,
  );
  if (nearby.length > 0) {
    const weighted = nearby.reduce(
      (acc: { rate: number; count: number }, e: { actualRate: number; count: number }) =>
        ({ rate: acc.rate + e.actualRate * e.count, count: acc.count + e.count }),
      { rate: 0, count: 0 },
    );
    return Math.round((weighted.rate / weighted.count) * 100);
  }

  return rawConfidence;
}

export function computeExpectedValue(winProbability: number, stake: number, payoutMultiplier: number): number {
  const payout = stake * payoutMultiplier;
  return (winProbability / 100) * payout - stake;
}

export function computeBreakevenWinRate(payoutMultiplier: number): number {
  if (payoutMultiplier <= 0) return 100;
  return Math.round((1 / payoutMultiplier) * 10000) / 100;
}
