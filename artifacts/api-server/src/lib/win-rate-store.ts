import { db } from "@workspace/db";
import { marketWinRatesTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { getBrowserSessionId } from "./session";

// Per-account win-rate memory. These rates are learned from a specific
// account's own trade history, so they must never be shared between accounts:
// the previous global cache fed account B the statistics account A learned.
const cachesBySession = new Map<string, Map<string, { winRate: number; count: number }>>();

/** The calling session's win-rate cache (created on first use). */
function cache(): Map<string, { winRate: number; count: number }> {
  const key = getBrowserSessionId();
  let existing = cachesBySession.get(key);
  if (!existing) {
    existing = new Map();
    cachesBySession.set(key, existing);
  }
  return existing;
}

function cacheKey(symbol: string, contractType: string, barrier?: number | null) {
  return `${symbol}|${contractType}|${barrier ?? "none"}`;
}

export async function loadWinRatesFromDb(sessionId?: string): Promise<void> {
  try {
    const scope = sessionId ?? getBrowserSessionId();
    const rows = await db.select().from(marketWinRatesTable)
      .where(eq(marketWinRatesTable.sessionId, scope));
    const target = cachesBySession.get(scope) ?? new Map();
    target.clear();
    for (const row of rows) {
      target.set(cacheKey(row.symbol, row.contractType, row.barrier), {
        winRate: Number(row.winRate),
        count: row.tradeCount,
      });
    }
    cachesBySession.set(scope, target);
    logger.info({ count: rows.length, sessionId: scope }, "Loaded market win rates from DB");
  } catch (err) {
    logger.warn({ err }, "Failed to load win rates — using defaults");
  }
}

export function getWinRate(symbol: string, contractType?: string, barrier?: number | null): number {
  const cache = getWinRateCache();
  if (contractType) {
    const specific = cache.get(cacheKey(symbol, contractType, barrier));
    if (specific && specific.count >= 3) return specific.winRate;
    const generic = cache.get(cacheKey(symbol, contractType, null));
    if (generic && generic.count >= 3) return generic.winRate;
  }
  const symbolOnly = cache.get(cacheKey(symbol, "*", null));
  if (symbolOnly && symbolOnly.count >= 5) return symbolOnly.winRate;
  return 0.55;
}

function getWinRateCache(): Map<string, { winRate: number; count: number }> {
  return cache();
}

export function getWinRateCount(symbol: string, contractType: string, barrier?: number | null): number {
  return getWinRateCache().get(cacheKey(symbol, contractType, barrier))?.count ?? 0;
}

export async function updateWinRate(
  symbol: string,
  contractType: string,
  barrier: number | null | undefined,
  won: boolean,
): Promise<void> {
  const cache = getWinRateCache();
  const key = cacheKey(symbol, contractType, barrier);
  const prev = cache.get(key) ?? { winRate: 0.55, count: 0 };
  const count = prev.count + 1;
  const winRate = prev.winRate * 0.9 + (won ? 1 : 0) * 0.1;
  cache.set(key, { winRate, count });

  // Symbol-level aggregate
  const symKey = cacheKey(symbol, "*", null);
  const symPrev = cache.get(symKey) ?? { winRate: 0.55, count: 0 };
  const symCount = symPrev.count + 1;
  const symWinRate = symPrev.winRate * 0.9 + (won ? 1 : 0) * 0.1;
  cache.set(symKey, { winRate: symWinRate, count: symCount });

  try {
    await upsertWinRate(symbol, contractType, barrier ?? null, winRate, count);
    await upsertWinRate(symbol, "*", null, symWinRate, symCount);
  } catch (err) {
    logger.warn({ err, symbol, contractType }, "Failed to persist win rate");
  }
}

async function upsertWinRate(
  symbol: string,
  contractType: string,
  barrier: number | null,
  winRate: number,
  count: number,
) {
  const scope = getBrowserSessionId();
  const barrierCond = barrier === null
    ? isNull(marketWinRatesTable.barrier)
    : eq(marketWinRatesTable.barrier, barrier);

  const existing = await db.select().from(marketWinRatesTable).where(
    and(
      eq(marketWinRatesTable.sessionId, scope),
      eq(marketWinRatesTable.symbol, symbol),
      eq(marketWinRatesTable.contractType, contractType),
      barrierCond,
    ),
  );

  if (existing.length > 0) {
    await db.update(marketWinRatesTable)
      .set({ winRate: String(winRate), tradeCount: count, updatedAt: new Date() })
      .where(eq(marketWinRatesTable.id, existing[0].id));
  } else {
    await db.insert(marketWinRatesTable).values({
      sessionId: scope,
      symbol,
      contractType,
      barrier,
      winRate: String(winRate),
      tradeCount: count,
    });
  }
}
