import { db } from "@workspace/db";
import { marketWinRatesTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "./logger";

const cache = new Map<string, { winRate: number; count: number }>();

function cacheKey(symbol: string, contractType: string, barrier?: number | null) {
  return `${symbol}|${contractType}|${barrier ?? "none"}`;
}

export async function loadWinRatesFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(marketWinRatesTable);
    cache.clear();
    for (const row of rows) {
      cache.set(cacheKey(row.symbol, row.contractType, row.barrier), {
        winRate: Number(row.winRate),
        count: row.tradeCount,
      });
    }
    logger.info({ count: rows.length }, "Loaded market win rates from DB");
  } catch (err) {
    logger.warn({ err }, "Failed to load win rates — using defaults");
  }
}

export function getWinRate(symbol: string, contractType?: string, barrier?: number | null): number {
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

export function getWinRateCount(symbol: string, contractType: string, barrier?: number | null): number {
  return cache.get(cacheKey(symbol, contractType, barrier))?.count ?? 0;
}

export async function updateWinRate(
  symbol: string,
  contractType: string,
  barrier: number | null | undefined,
  won: boolean,
): Promise<void> {
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
  const barrierCond = barrier === null
    ? isNull(marketWinRatesTable.barrier)
    : eq(marketWinRatesTable.barrier, barrier);

  const existing = await db.select().from(marketWinRatesTable).where(
    and(
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
      symbol,
      contractType,
      barrier,
      winRate: String(winRate),
      tradeCount: count,
    });
  }
}
