import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { accountsTable, db } from "@workspace/db";
import {
  categoryLabel,
  getLiveCandles,
  getLiveMarketSymbols,
  isFreshCandleFeed,
  LiveMarketDataUnavailable,
  type LiveMarketSymbol,
} from "../lib/cfd-market-data";
import {
  analyzeLiveMarket,
  evaluateSignalOutcome,
  higherTimeframeFor,
  timeframeLabel,
  INTELLIGENCE_TIMEFRAMES,
  type IntelligenceInput,
  type MarketIntelligenceResult,
} from "../lib/market-intelligence";

const router = Router();
const signalHistoryBySession = new Map<string, MarketIntelligenceResult[]>();
const MAX_SIGNAL_HISTORY = 100;

function getHistory(sessionId: string): MarketIntelligenceResult[] {
  let history = signalHistoryBySession.get(sessionId);
  if (!history) {
    history = [];
    signalHistoryBySession.set(sessionId, history);
  }
  return history;
}

function failLive(res: any, error: unknown): void {
  const message = error instanceof LiveMarketDataUnavailable
    ? error.message
    : "Deriv live market data is unavailable";
  res.status(503).json({
    error: message,
    code: "LIVE_MARKET_DATA_UNAVAILABLE",
    liveDataOnly: true,
  });
}

function parseTimeframe(value: unknown): number | null {
  const numeric = Number(value);
  return INTELLIGENCE_TIMEFRAMES.some((timeframe) => timeframe.value === numeric) ? numeric : null;
}

function filterSymbols(symbols: LiveMarketSymbol[], category: string | undefined, search: string | undefined): LiveMarketSymbol[] {
  const normalizedCategory = category?.trim().toLowerCase();
  const normalizedSearch = search?.trim().toLowerCase();
  return symbols.filter((symbol) => {
    const matchesCategory = !normalizedCategory || normalizedCategory === "all" || symbol.category === normalizedCategory;
    const haystack = `${symbol.symbol} ${symbol.displayName} ${symbol.market} ${symbol.submarket}`.toLowerCase();
    return matchesCategory && (!normalizedSearch || haystack.includes(normalizedSearch));
  });
}

async function accountBalance(sessionId: string): Promise<number> {
  const rows = await db.select({ balance: accountsTable.balance })
    .from(accountsTable)
    .where(and(eq(accountsTable.sessionId, sessionId), eq(accountsTable.isActive, true)))
    .limit(1);
  return rows.length ? Number(rows[0].balance) : 0;
}

router.get("/status", (_req, res): void => {
  res.json({
    provider: "Deriv",
    endpoint: "wss://api.derivws.com/trading/v1/options/ws/public",
    liveDataOnly: true,
    execution: "SIGNAL_ONLY",
    note: "No synthetic fallback is used by Market Intelligence. A feed outage produces no signal.",
  });
});

router.get("/markets", async (req, res): Promise<void> => {
  try {
    const symbols = await getLiveMarketSymbols();
    const filtered = filterSymbols(symbols, req.query.category as string | undefined, req.query.search as string | undefined);
    res.json({
      fetchedAt: new Date().toISOString(),
      feed: "DERIV_LIVE",
      liveDataOnly: true,
      categories: ["forex", "cryptocurrency", "commodities", "indices", "synthetic_index", "basket_index", "stocks"],
      markets: filtered.map((symbol) => ({ ...symbol, categoryLabel: categoryLabel(symbol.category) })),
    });
  } catch (error) {
    failLive(res, error);
  }
});

router.post("/analyze", async (req, res): Promise<void> => {
  try {
    const symbolValue = String(req.body?.symbol ?? "").trim();
    const timeframeSeconds = parseTimeframe(req.body?.timeframeSeconds ?? req.body?.timeframe);
    if (!symbolValue || !timeframeSeconds) {
      res.status(400).json({
        error: `symbol and timeframe are required. Supported timeframes: ${INTELLIGENCE_TIMEFRAMES.map((timeframe) => timeframe.label).join(", ")}`,
      });
      return;
    }

    const symbols = await getLiveMarketSymbols();
    const symbol = symbols.find((candidate) => candidate.symbol === symbolValue);
    if (!symbol) {
      res.status(400).json({ error: "Select a currently active Deriv symbol from the live market list." });
      return;
    }
    if (symbol.isSuspended === true) {
      res.status(409).json({ error: "Deriv has marked this market as suspended. No signal was generated." });
      return;
    }

    const higherTimeframeSeconds = higherTimeframeFor(timeframeSeconds);
    const [primary, higher] = await Promise.all([
      getLiveCandles(symbol.symbol, timeframeSeconds, 360),
      higherTimeframeSeconds === timeframeSeconds
        ? getLiveCandles(symbol.symbol, timeframeSeconds, 360)
        : getLiveCandles(symbol.symbol, higherTimeframeSeconds, 360),
    ]);
    if (!isFreshCandleFeed(primary.candles, timeframeSeconds) || !isFreshCandleFeed(higher.candles, higherTimeframeSeconds)) {
      res.status(503).json({
        error: "The latest Deriv candle is stale for this market/timeframe. No signal was generated.",
        code: "STALE_LIVE_DATA",
        liveDataOnly: true,
      });
      return;
    }

    const requestedBalance = Number(req.body?.balance);
    const balance = Number.isFinite(requestedBalance) && requestedBalance >= 0
      ? requestedBalance
      : await accountBalance(req.sessionId);
    const requestedRisk = Number(req.body?.riskPercent);
    const riskPercent = Number.isFinite(requestedRisk) ? requestedRisk : 0.5;
    const requestedUnits = Number(req.body?.unitsPerLot);
    const unitsPerLot = Number.isFinite(requestedUnits) && requestedUnits > 0 ? requestedUnits : undefined;
    const input: IntelligenceInput = {
      symbol,
      candles: primary.candles,
      higherCandles: higher.candles,
      timeframeSeconds,
      higherTimeframeSeconds,
      balance,
      riskPercent,
      unitsPerLot,
    };
    const result = analyzeLiveMarket(input);
    getHistory(req.sessionId).unshift(result);
    const history = getHistory(req.sessionId);
    if (history.length > MAX_SIGNAL_HISTORY) history.splice(MAX_SIGNAL_HISTORY);
    res.json({
      ...result,
      feedFetchedAt: new Date(primary.fetchedAt).toISOString(),
      candles: primary.candles.slice(-120),
      higherCandles: higher.candles.slice(-120),
    });
  } catch (error) {
    failLive(res, error);
  }
});

router.get("/signals", async (req, res): Promise<void> => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const history = getHistory(req.sessionId).slice(0, limit);
    // Only refresh open signals. This uses live candles and never marks an
    // outcome from a local timer or simulated price.
    const refreshed = await Promise.all(history.map(async (signal) => {
      if (signal.outcome !== "OPEN") return signal;
      try {
        const live = await getLiveCandles(signal.symbol, signal.timeframeSeconds, 360);
        return evaluateSignalOutcome(signal, live.candles);
      } catch {
        return signal;
      }
    }));
    signalHistoryBySession.set(req.sessionId, refreshed.concat(getHistory(req.sessionId).slice(limit)));
    res.json({ feed: "DERIV_LIVE", liveDataOnly: true, signals: refreshed });
  } catch (error) {
    failLive(res, error);
  }
});

router.delete("/signals", (req, res): void => {
  signalHistoryBySession.delete(req.sessionId);
  res.json({ success: true });
});

export default router;
