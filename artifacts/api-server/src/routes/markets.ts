import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable, settingsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { tradesTable } from "@workspace/db";
import { tickManager, DERIV_MARKETS, getMarketInfo, getCachedToken, analyzeDigits } from "../lib/deriv";
import { runCoordinator, buildLegacyAnalysis } from "../lib/agent-coordinator";
import type { TradingSettings, DailyStats, ScanContext } from "../lib/agents/types";
import { GetMarketsQueryParams } from "@workspace/api-zod";

const router = Router();

interface CachedOutput {
  symbol: string;
  displayName: string;
  category: string;
  output: Awaited<ReturnType<typeof runCoordinator>>;
  prices: number[];
  lastUpdated: Date;
}

const analysisCache = new Map<string, CachedOutput>();
let isScanning = false;
// Track last known preferred types — clear cache when user changes settings
let lastPreferredKey = "";

// ── Settings builders ─────────────────────────────────────────────────────────

async function getAccountAndSettings() {
  const accounts = await db.select().from(accountsTable).limit(1);
  const settings = await db.select().from(settingsTable).limit(1);
  return {
    balance: accounts.length > 0 ? Number(accounts[0].balance) : 10000,
    settings: settings.length > 0 ? settings[0] : null,
    token: getCachedToken() ?? (accounts.length > 0 ? accounts[0].token : null),
    currency: accounts.length > 0 ? (accounts[0].currency ?? "USD") : "USD",
  };
}

function buildTradingSettings(s: any, preferredContractTypes: string[]): TradingSettings {
  return {
    riskAmountType:         (s?.riskAmountType === "percentage" ? "percentage" : "fixed") as "fixed" | "percentage",
    riskAmountValue:        s ? Number(s.riskAmountValue ?? 1) : 1,
    maxRiskPerTrade:        s ? Number(s.maxRiskPerTrade) : 2,
    minConfidenceThreshold: s ? Number(s.minConfidenceThreshold) : 38,
    riskProfile:            (s?.riskProfile ?? "moderate") as "conservative" | "moderate" | "aggressive",
    preferredContractTypes,
    tradeDurationSec:       s?.tradeDurationSec ?? 5,
    maxTradeStake:          s ? Number(s.maxTradeStake) : 500,
    dailyLossLimit:         s ? Number(s.dailyLossLimit) : 30,
    dailyTarget:            s ? Number(s.dailyTarget) : 50,
    consecutiveLossLimit:   s?.consecutiveLossLimit ?? 3,
    maxDrawdown:            s ? Number(s.maxDrawdown ?? 20) : 20,
    requirePositiveEv:      s?.requirePositiveEv ?? true,
    paperTradeMode:         s?.paperTradeMode ?? false,
    normalOverDigit:        s?.normalOverDigit ?? 2,
    normalUnderDigit:       s?.normalUnderDigit ?? 7,
    recoveryOverDigit:      s?.recoveryOverDigit ?? 4,
    recoveryUnderDigit:     s?.recoveryUnderDigit ?? 5,
    recoveryMethod:         (s?.recoveryMethod === "instant" ? "instant" : "split") as "split" | "instant",
    recoveryMultiplier:     s ? Math.max(1.1, Number(s.recoveryMultiplier ?? 1.5)) : 1.5,
    recoveryAutoMode:       s?.recoveryAutoMode ?? true,
    maxRecoverySteps:       s?.maxRecoverySteps ?? 3,
  };
}

async function getDailyStats(): Promise<DailyStats> {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayTrades = await db.select().from(tradesTable).where(sql`${tradesTable.createdAt} >= ${today}`);
    const closed = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
    const sorted = [...closed].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    let consecutiveLosses = 0;
    for (const t of sorted) { if (t.status === "lost") consecutiveLosses++; else break; }
    let consecutiveWins = 0;
    for (const t of sorted) { if (t.status === "won") consecutiveWins++; else break; }
    return {
      tradesCount: closed.length,
      wins: closed.filter((t) => t.status === "won").length,
      losses: closed.filter((t) => t.status === "lost").length,
      profit: closed.reduce((s, t) => s + Number(t.profit ?? 0), 0),
      consecutiveLosses,
      consecutiveWins,
    };
  } catch {
    return { tradesCount: 0, wins: 0, losses: 0, profit: 0, consecutiveLosses: 0, consecutiveWins: 0 };
  }
}

function buildScanContext(
  market: { symbol: string; displayName: string; category: string; digitEnabled?: boolean },
  balance: number,
  settings: TradingSettings,
  daily: DailyStats,
  token: string | null,
  currency: string,
): ScanContext {
  const prices = tickManager.getTicks(market.symbol, 100);
  const digits = market.digitEnabled ? tickManager.getDigits(market.symbol, 300) : [];
  return { symbol: market.symbol, displayName: market.displayName, category: market.category, prices, digits, balance, settings, daily, token, currency };
}

// ── Background scan ───────────────────────────────────────────────────────────

async function analyzeAllMarkets() {
  if (isScanning) return;
  isScanning = true;
  try {
    const { balance, settings, token, currency } = await getAccountAndSettings();
    const preferred = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER"];
    const tradingSettings = buildTradingSettings(settings, preferred);
    const daily = await getDailyStats();
    const now = new Date();

    // If preferred contract types changed (user updated settings), clear the cache
    // so all markets are re-evaluated with the new types immediately.
    const prefKey = [...preferred].sort().join(",");
    if (prefKey !== lastPreferredKey) {
      analysisCache.clear();
      lastPreferredKey = prefKey;
    }

    // Only re-analyze markets stale (> 15s old)
    const staleMarkets = DERIV_MARKETS.filter((m) => {
      const cached = analysisCache.get(m.symbol);
      return !cached || now.getTime() - cached.lastUpdated.getTime() > 15_000;
    });

    await Promise.all(staleMarkets.map(async (market) => {
      try {
        const ctx = buildScanContext(market, balance, tradingSettings, daily, token, currency);
        // For background scans: use a "no live payout" context to avoid 17× WS round-trips
        const ctxNoPayout = { ...ctx, token: null };
        const output = await runCoordinator(ctxNoPayout);
        analysisCache.set(market.symbol, {
          symbol: market.symbol,
          displayName: market.displayName,
          category: market.category,
          output,
          prices: ctx.prices,
          lastUpdated: new Date(),
        });
      } catch { /* skip */ }
    }));
  } finally {
    isScanning = false;
  }
}

// Warm up cache on startup
analyzeAllMarkets().catch(() => {});

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get("/", async (req, res): Promise<void> => {
  const parseResult = GetMarketsQueryParams.safeParse(req.query);
  const params = parseResult.success ? parseResult.data : {} as { category?: string; limit?: number };
  const limit = params.limit ?? 50;

  analyzeAllMarkets().catch(() => {});

  const { balance, settings, token, currency } = await getAccountAndSettings();
  const preferred = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER"];
  const tradingSettings = buildTradingSettings(settings, preferred);
  const daily = await getDailyStats();

  const ranked = await Promise.all(
    DERIV_MARKETS.slice(0, limit).map(async (m) => {
      let cached = analysisCache.get(m.symbol);
      if (!cached) {
        const ctx = buildScanContext(m, balance, tradingSettings, daily, token, currency);
        const output = await runCoordinator({ ...ctx, token: null });
        cached = { symbol: m.symbol, displayName: m.displayName, category: m.category, output, prices: ctx.prices, lastUpdated: new Date() };
        analysisCache.set(m.symbol, cached);
      }
      const { output, prices } = cached;
      return {
        symbol: m.symbol,
        displayName: m.displayName,
        category: m.category,
        qualityScore: output.qualityScore,
        confidenceScore: output.confidenceScore,
        riskScore: output.riskScore,
        trend: output.trend,
        volatility: output.volatility,
        recommendedContractType: output.recommendation.product,
        regime: output.regime,
        shouldTrade: output.shouldTrade,
        lastPrice: tickManager.getLatestPrice(m.symbol) ?? prices[prices.length - 1] ?? null,
        priceChange24h: prices.length > 1 ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100 : null,
        rank: 0,
      };
    })
  );

  ranked.sort((a, b) => b.qualityScore - a.qualityScore);
  ranked.forEach((m, i) => { m.rank = i + 1; });
  res.json(ranked);
});

router.get("/top", async (req, res): Promise<void> => {
  analyzeAllMarkets().catch(() => {});
  const { balance, settings, token, currency } = await getAccountAndSettings();
  const preferred = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER"];
  const tradingSettings = buildTradingSettings(settings, preferred);
  const daily = await getDailyStats();

  // Optional contract-type filter: e.g. ?contractTypeFilter=CALL,PUT
  const contractTypeFilter = req.query.contractTypeFilter as string | undefined;
  const allowedTypes = contractTypeFilter ? new Set(contractTypeFilter.split(",").map(s => s.trim())) : null;

  let best: CachedOutput | null = null;
  for (const [, cached] of analysisCache) {
    if (allowedTypes) {
      const recType = cached.output.recommendation?.product as string | undefined;
      if (!recType || !allowedTypes.has(recType)) continue;
    }
    if (!best || cached.output.qualityScore > best.output.qualityScore) best = cached;
  }

  if (!best) {
    const market = DERIV_MARKETS[0];
    const ctx = buildScanContext(market, balance, tradingSettings, daily, token, currency);
    const output = await runCoordinator(ctx);
    best = { symbol: market.symbol, displayName: market.displayName, category: market.category, output, prices: ctx.prices, lastUpdated: new Date() };
    analysisCache.set(market.symbol, best);
  }

  res.json(buildMarketDetail(best.symbol, best.displayName, best.category, best.output, best.prices));
});

router.get("/scan", async (_req, res): Promise<void> => {
  res.json({
    status: isScanning ? "running" : "queued",
    marketsScanned: analysisCache.size,
    liveTickCount: tickManager.getLiveTickCount(),
    connected: tickManager.getConnectionStatus(),
    startedAt: new Date().toISOString(),
  });
});

router.post("/scan", async (_req, res): Promise<void> => {
  analyzeAllMarkets().catch(() => {});
  res.json({ status: "running", marketsScanned: analysisCache.size, startedAt: new Date().toISOString() });
});

router.get("/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const market = getMarketInfo(symbol);
  if (!market) { res.status(404).json({ error: "Market not found" }); return; }

  const { balance, settings, token, currency } = await getAccountAndSettings();
  const preferred = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER"];
  const tradingSettings = buildTradingSettings(settings, preferred);
  const daily = await getDailyStats();

  const ctx = buildScanContext(market, balance, tradingSettings, daily, token, currency);
  const output = await runCoordinator(ctx);
  analysisCache.set(symbol, { symbol, displayName: market.displayName, category: market.category, output, prices: ctx.prices, lastUpdated: new Date() });

  res.json(buildMarketDetail(symbol, market.displayName, market.category, output, ctx.prices));
});

// ── Response builder ───────────────────────────────────────────────────────────

function buildMarketDetail(
  symbol: string,
  displayName: string,
  category: string,
  output: Awaited<ReturnType<typeof runCoordinator>>,
  prices: number[],
) {
  const analysis = buildLegacyAnalysis(output);
  const now = new Date();
  const priceHistory = prices.slice(-60).map((p, i) => ({
    timestamp: new Date(now.getTime() - (59 - i) * 1000).toISOString(),
    price: p,
  }));

  // Live digit stats from the 50-tick window (more responsive than 200-tick)
  const market = getMarketInfo(symbol);
  const digits100m = market?.digitEnabled ? tickManager.getDigits(symbol, 100) : [];
  const liveDigitStats = digits100m.length > 10 ? analyzeDigits(digits100m) : null;

  return {
    symbol,
    displayName,
    category,
    qualityScore: output.qualityScore,
    regime: output.regime,
    agentScores: analysis.agentScores,
    agentOutputs: output.agents,
    digitStats: liveDigitStats ?? output.digitStats ?? null,
    digitBarrier: analysis.digitBarrier ?? null,
    recommendation: {
      symbol,
      contractType: analysis.recommendedContractType,
      direction: analysis.direction,
      stake: analysis.recommendedStake,
      confidence: analysis.confidenceScore,
      calibratedConfidence: analysis.calibratedConfidence,
      winProbability: analysis.winProbability,
      expectedValue: analysis.expectedValue,
      breakevenWinRate: analysis.breakevenWinRate,
      payoutMultiplier: analysis.payoutMultiplier,
      recommendedDuration: analysis.recommendedDuration,
      tickWindow: null,
      riskScore: analysis.riskScore,
      profitability: analysis.profitability,
      agentScores: analysis.agentScores,
      shouldTrade: analysis.shouldTrade,
      reasoning: analysis.reasoning,
      warnings: analysis.warnings,
      suggestedContractTypes: analysis.suggestedContractTypes,
      generatedAt: new Date().toISOString(),
    },
    priceHistory,
    lastUpdated: new Date().toISOString(),
  };
}

export { analysisCache, getAccountAndSettings };
export default router;
