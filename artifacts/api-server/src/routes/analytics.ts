import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, settingsTable, accountsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import { GetPerformanceAnalyticsQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/performance", async (req, res): Promise<void> => {
  const parseResult = GetPerformanceAnalyticsQueryParams.safeParse(req.query);
  const days = parseResult.success ? (parseResult.data.days ?? 30) : 30;

  const since = new Date();
  since.setDate(since.getDate() - days);

  const trades = await db.select().from(tradesTable).where(
    sql`${tradesTable.createdAt} >= ${since} AND ${tradesTable.status} IN ('won', 'lost')`
  );

  // Group by date
  const byDate = new Map<string, typeof trades>();
  for (const t of trades) {
    const d = t.createdAt.toISOString().split("T")[0];
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(t);
  }

  // Build date range
  const dateRange: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dateRange.push(d.toISOString().split("T")[0]);
  }

  const winRateHistory = dateRange.map((date) => {
    const dayTrades = byDate.get(date) ?? [];
    const won = dayTrades.filter((t) => t.status === "won").length;
    return {
      date,
      winRate: dayTrades.length > 0 ? won / dayTrades.length : 0,
      tradeCount: dayTrades.length,
    };
  });

  let cumulative = 0;
  const profitCurve = dateRange.map((date) => {
    const dayTrades = byDate.get(date) ?? [];
    const dailyProfit = dayTrades.reduce((s, t) => s + Number(t.profit ?? 0), 0);
    cumulative += dailyProfit;
    return { date, cumulativeProfit: cumulative, dailyProfit };
  });

  const wonTrades = trades.filter((t) => t.status === "won");
  const lostTrades = trades.filter((t) => t.status === "lost");
  const avgConfidenceWon = wonTrades.length > 0
    ? wonTrades.reduce((s, t) => s + Number(t.aiConfidence ?? 0), 0) / wonTrades.length : 0;
  const avgConfidenceLost = lostTrades.length > 0
    ? lostTrades.reduce((s, t) => s + Number(t.aiConfidence ?? 0), 0) / lostTrades.length : 0;

  res.json({
    days,
    winRateHistory,
    profitCurve,
    avgConfidenceByOutcome: { avgConfidenceWon, avgConfidenceLost },
  });
});

router.get("/drawdown", async (_req, res): Promise<void> => {
  const settings = await db.select().from(settingsTable).limit(1);
  const accounts = await db.select().from(accountsTable).limit(1);
  const trades = await db.select().from(tradesTable).where(
    sql`${tradesTable.status} IN ('won', 'lost')`
  );

  const drawdownLimit = settings.length > 0 ? Number(settings[0].maxDrawdown) : 10;
  const consecutiveLossLimit = settings.length > 0 ? settings[0].consecutiveLossLimit : 3;
  const balance = accounts.length > 0 ? Number(accounts[0].balance) : 10000;

  // Calculate max drawdown from profit curve
  let peak = balance;
  let maxDD = 0;
  let running = 0;
  const sorted = [...trades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  for (const t of sorted) {
    running += Number(t.profit ?? 0);
    if (running > peak - balance) peak = balance + running;
    const dd = (peak - (balance + running)) / Math.max(peak, 1) * 100;
    maxDD = Math.max(maxDD, dd);
  }

  const currentDd = peak > 0 ? (peak - balance) / peak * 100 : 0;

  // Count consecutive losses
  let consecutive = 0;
  const recent = sorted.slice(-20).reverse();
  for (const t of recent) {
    if (t.status === "lost") consecutive++;
    else break;
  }

  const riskExposure = Math.min((currentDd / drawdownLimit) * 100, 100);

  res.json({
    currentDrawdown: Math.max(0, currentDd),
    maxDrawdown: maxDD,
    drawdownLimit,
    isAtRisk: currentDd >= drawdownLimit * 0.8,
    riskExposure,
    consecutiveLosses: consecutive,
    consecutiveLossLimit,
  });
});

router.get("/market-breakdown", async (_req, res): Promise<void> => {
  const trades = await db.select().from(tradesTable).where(
    sql`${tradesTable.status} IN ('won', 'lost')`
  );

  const byMarket = new Map<string, { symbol: string; displayName: string; trades: typeof trades }>();
  for (const t of trades) {
    if (!byMarket.has(t.symbol)) {
      byMarket.set(t.symbol, { symbol: t.symbol, displayName: t.displayName, trades: [] });
    }
    byMarket.get(t.symbol)!.trades.push(t);
  }

  const breakdown = Array.from(byMarket.values()).map(({ symbol, displayName, trades: mTrades }) => {
    const won = mTrades.filter((t) => t.status === "won").length;
    const totalProfit = mTrades.reduce((s, t) => s + Number(t.profit ?? 0), 0);
    const avgStake = mTrades.reduce((s, t) => s + Number(t.stake), 0) / mTrades.length;
    return {
      symbol,
      displayName,
      tradeCount: mTrades.length,
      winRate: mTrades.length > 0 ? won / mTrades.length : 0,
      totalProfit,
      avgStake,
    };
  });

  breakdown.sort((a, b) => b.totalProfit - a.totalProfit);
  res.json(breakdown);
});

router.get("/agent-scores", async (_req, res): Promise<void> => {
  const agents = ["marketScanner", "trendAnalysis", "volatilityAnalysis", "patternRecognition",
    "riskManagement", "capitalPreservation", "tradeExecution", "selfLearning"];

  const trades = await db.select().from(tradesTable).where(
    sql`${tradesTable.status} IN ('won', 'lost')`
  ).orderBy(desc(tradesTable.createdAt)).limit(50);

  const records = [];
  for (const t of trades) {
    const predicted = Number(t.aiConfidence ?? 60);
    const won = t.status === "won";
    for (const agent of agents) {
      records.push({
        date: t.createdAt.toISOString().split("T")[0],
        agentName: agent,
        predictedScore: predicted,
        actualOutcome: t.status,
        accuracy: won ? predicted / 100 : 1 - predicted / 100,
      });
    }
  }

  res.json(records.slice(0, 100));
});

export default router;
