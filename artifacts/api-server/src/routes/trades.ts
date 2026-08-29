import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, accountsTable, settingsTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
import { ExecuteTradeBody, GetTradesQueryParams, GetTradeParams } from "@workspace/api-zod";
import { tickManager, DERIV_MARKETS, executeLiveTrade, waitForContractResult, getLiveBalance, getJournalManager, isAutomatedMarket } from "../lib/deriv";
import { runCoordinator, buildLegacyAnalysis, recordTradeOutcome } from "../lib/agent-coordinator";
import * as recoveryEngine from "../lib/agents/recovery-engine";
import { analyzeCompletedTrade } from "../lib/agents/trade-intelligence";
import { logger } from "../lib/logger";
import { broadcastSSE } from "../lib/sse";
import { getLocalTodayStart } from "../lib/tz";
import { getFallbackPayout } from "../lib/payouts";
import { resolveRecoveryPayout } from "../lib/recovery-payout";
import { evaluateManualAssist } from "../lib/speed-ai-engine";
import type { TradingSettings, DailyStats, ScanContext } from "../lib/agents/types";

const router = Router();

const DEMO_BALANCE = 10000;

async function getActiveAccount(sessionId: string) {
  let accounts = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, sessionId),
    eq(accountsTable.isActive, true),
  )).limit(1);
  if (accounts.length === 0) {
    accounts = await db.select().from(accountsTable)
      .where(eq(accountsTable.sessionId, sessionId)).limit(1);
  }
  return accounts[0] ?? null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildTradingSettingsForManual(s: any, preferredContractTypes: string[]): TradingSettings {
  return {
    riskAmountType:         (s?.riskAmountType === "percentage" ? "percentage" : "fixed") as "fixed" | "percentage",
    riskAmountValue:        s ? Number(s.riskAmountValue ?? 1) : 1,
    maxRiskPerTrade:        s ? Number(s.maxRiskPerTrade) : 2,
    minConfidenceThreshold: s ? Math.min(Number(s.minConfidenceThreshold), 55) : 38,
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
    // Manual mode owns this value; Auto mode ignores it completely.
    recoveryMultiplier:     s ? Number(s.recoveryMultiplier ?? 1.5) : 1.5,
    recoveryAutoMode:       s?.recoveryAutoMode ?? true,
    maxRecoverySteps:       s?.maxRecoverySteps ?? 3,
  };
}

function buildDailyStatsForManual(closedToday: any[]): DailyStats {
  const wins = closedToday.filter((t) => t.status === "won").length;
  const losses = closedToday.filter((t) => t.status === "lost").length;
  const profit = closedToday.reduce((s: number, t: any) => s + Number(t.profit ?? 0), 0);
  const sorted = [...closedToday].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  let consecutiveLosses = 0;
  for (const t of sorted) { if (t.status === "lost") consecutiveLosses++; else break; }
  let consecutiveWins = 0;
  for (const t of sorted) { if (t.status === "won") consecutiveWins++; else break; }
  return { tradesCount: closedToday.length, wins, losses, profit, consecutiveLosses, consecutiveWins };
}

// ── Single source of truth for "today" boundary ─────────────────────────────
// Every endpoint that reports today's win rate/profit/trade-count MUST call
// this instead of rolling its own `new Date(); setHours(0,0,0,0)`.
// Uses the user's timezone (stored in lib/tz via the day-reset handshake on
// page-load) so "today" on the server always matches the user's local calendar
// date.  Falls back to UTC if the client hasn't connected yet.
export function getTodayStart(): Date {
  return getLocalTodayStart();
}

// ── Helper: get Deriv journal transactions (cache-first, no size cap) ────────
async function getDerivTransactions(sessionId: string): Promise<any[]> {
  const journalManager = getJournalManager(sessionId);
  // Always use this browser session's persistent fully-paginated cache — it holds the
  // COMPLETE result set with no trade-count limit.
  //
  // The old "fallback to fetchDerivProfitTable(500)" when the cache was empty
  // was the root cause of the 500 ↔ full-count oscillation reported in
  // Analytics/Journal: that single-shot fetch returned at most 500 trades,
  // which the UI displayed immediately, only for the number to jump once the
  // manager finished its full paginated sweep seconds later.
  //
  // Fix: if the cache is empty (server just started or reconnecting), kick the
  // manager so it begins paginating immediately and return empty so callers
  // render a brief "loading" state. The next poll (5-10 s) will get the real
  // full set — no more 500-trade intermediate snapshot.
  const cached = journalManager.getCached();
  if (cached.length > 0) {
    return cached;
  }
  // Cache is empty — trigger background pagination and let the caller decide
  // how to handle the momentary empty state (loading spinner / empty message).
  journalManager.forceRefresh();
  return [];
}

const EMPTY_STATS = {
  totalTrades: 0, wonTrades: 0, lostTrades: 0, winRate: 0,
  totalProfit: 0, avgProfit: 0, bestTrade: 0, worstTrade: 0,
  currentStreak: 0, longestWinStreak: 0, longestLoseStreak: 0,
};

// ── Stats ──────────────────────────────────────────────────────────────────────

router.get("/stats", async (req, res): Promise<void> => {
  const account = await getActiveAccount(req.sessionId);
  const token = account?.bearerToken ?? account?.token ?? null;
  if (token && account) {
    getJournalManager(req.sessionId).setCredentials(token, account.derivAccountId ?? account.loginId);
  }

  if (!token) {
    res.json(EMPTY_STATS);
    return;
  }

  const transactions = await getDerivTransactions(req.sessionId);
  const mapped = transactions.map((t: any) => {
    const buyPrice = Number(t.buy_price ?? 0);
    const sellPrice = Number(t.sell_price ?? 0);
    const profit = Math.round((sellPrice - buyPrice) * 100) / 100;
    return { won: profit > 0, profit, createdAt: t.purchase_time ? new Date(t.purchase_time * 1000).toISOString() : new Date().toISOString() };
  });

  const stats = computeJournalStats(mapped);
  res.json({
    totalTrades: stats.totalTrades,
    wonTrades: stats.wonTrades,
    lostTrades: stats.lostTrades,
    winRate: stats.winRate,
    totalProfit: stats.totalProfit,
    avgProfit: stats.avgProfit,
    bestTrade: stats.bestTrade,
    worstTrade: stats.worstTrade,
    currentStreak: stats.currentStreak,
    longestWinStreak: stats.longestWinStreak,
    longestLoseStreak: stats.longestLoseStreak,
  });
});

router.get("/daily-summary", async (req, res): Promise<void> => {
  const today = getTodayStart();

  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, req.sessionId)).limit(1);
  const account = await getActiveAccount(req.sessionId);
  const token = account?.bearerToken ?? account?.token ?? null;
  if (token && account) {
    getJournalManager(req.sessionId).setCredentials(token, account.derivAccountId ?? account.loginId);
  }

  const dailyTarget = settings.length > 0 ? Number(settings[0].dailyTarget) : 50;
  const dailyLossLimit = settings.length > 0 ? Number(settings[0].dailyLossLimit) : 30;
  const balance = account ? Number(account.balance) : 0;

  if (!token) {
    // No Deriv connection — use local DB for engine-tracked trades only. Reuse
    // computeJournalStats so this stays numerically identical to /deriv-journal's
    // todayStats if the app is ever queried on the same local-DB fallback path.
    const todayTrades = await db.select().from(tradesTable).where(and(
      eq(tradesTable.sessionId, req.sessionId),
      sql`${tradesTable.createdAt} >= ${today}`,
    ));
    const closed = todayTrades
      .filter((t) => t.status === "won" || t.status === "lost")
      .map((t) => ({ won: t.status === "won", profit: Number(t.profit ?? 0), createdAt: t.createdAt }));
    const { totalProfit, wonTrades, lostTrades, totalTrades, currentStreak } = computeStatsCore(closed);
    res.json({
      date: today.toISOString().split("T")[0],
      tradesCount: totalTrades, wonCount: wonTrades, lostCount: lostTrades,
      totalProfit, dailyTarget, dailyLossLimit,
      targetProgress: dailyTarget > 0 ? Math.min(totalProfit / dailyTarget, 1) : 0,
      isTargetMet: totalProfit >= dailyTarget, isLossLimitHit: totalProfit <= -dailyLossLimit,
      balanceStart: balance - totalProfit, balanceNow: balance, currentStreak,
    });
    return;
  }

  // Use Deriv journal as source of truth — same computeJournalStats() call the
  // /deriv-journal endpoint uses, so this widget's numbers can never drift from
  // the Dashboard/Journal/Analytics stat cards.
  const transactions = await getDerivTransactions(req.sessionId);
  const allMapped = transactions.map((t: any) => {
    const buyPrice = Number(t.buy_price ?? 0);
    const sellPrice = Number(t.sell_price ?? 0);
    const profit = Math.round((sellPrice - buyPrice) * 100) / 100;
    return { won: profit > 0, profit, createdAt: t.purchase_time ? new Date(t.purchase_time * 1000).toISOString() : new Date().toISOString() };
  });

  const { todayStats, currentStreak } = computeJournalStats(allMapped);
  const totalProfit = todayStats.totalProfit;

  res.json({
    date: today.toISOString().split("T")[0],
    tradesCount: todayStats.totalTrades,
    wonCount: todayStats.wonTrades,
    lostCount: todayStats.lostTrades,
    totalProfit,
    dailyTarget,
    dailyLossLimit,
    targetProgress: dailyTarget > 0 ? Math.min(totalProfit / dailyTarget, 1) : 0,
    isTargetMet: totalProfit >= dailyTarget,
    isLossLimitHit: totalProfit <= -dailyLossLimit,
    balanceStart: balance - totalProfit,
    balanceNow: balance,
    // Streak from ALL recent trades (newest first from Deriv API — most accurate),
    // same field computeJournalStats().currentStreak returns for the all-time view.
    currentStreak,
  });
});

router.get("/", async (req, res): Promise<void> => {
  const parseResult = GetTradesQueryParams.safeParse(req.query);
  const params = parseResult.success ? parseResult.data : {};

  let query = db.select().from(tradesTable).$dynamic();
  const conditions = [eq(tradesTable.sessionId, req.sessionId)];

  const p = params as { status?: string; market?: string; limit?: number; offset?: number };
  if (p.status && p.status !== "all") {
    conditions.push(eq(tradesTable.status, p.status));
  }
  if (p.market) {
    conditions.push(eq(tradesTable.symbol, p.market));
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const trades = await query
    .orderBy(desc(tradesTable.createdAt))
    .limit(p.limit ?? 50)
    .offset(p.offset ?? 0);

  res.json(trades.map(formatTrade));
});

// ── Manual assist evaluation — NeuroAI Quantum timing for manual execution ──
// Uses same Quantum engine as FAB but for user's exact contract/barrier/duration.
// Returns simple Ready/Wait without exposing Markov/Shannon internals.
router.post("/assist", async (req, res): Promise<void> => {
  const { symbol, contractType, barrier, duration } = req.body as {
    symbol?: string;
    contractType?: string;
    barrier?: number | null;
    duration?: number;
  };

  if (!symbol || !contractType) {
    res.status(400).json({ error: "symbol and contractType required" });
    return;
  }

  const dur = typeof duration === "number" && duration >= 1 && duration <= 15 ? duration : 5;
  // Validate contract type against known set
  const allowed = ["DIGITOVER","DIGITUNDER","DIGITEVEN","DIGITODD","DIGITMATCH","DIGITDIFF","CALL","PUT","RISE","FALL"];
  const ct = (contractType === "RISE" ? "CALL" : contractType === "FALL" ? "PUT" : contractType) as any;
  if (!allowed.includes(ct)) {
    res.status(400).json({ error: "Invalid contractType" });
    return;
  }

  try {
    const result = evaluateManualAssist(symbol, ct, barrier ?? undefined, dur);
    // Hide technical metrics: only return ready/wait with simple reason
    res.json({
      ready: result.ready,
      label: result.ready ? "Good timing — Ready" : result.greenLight ? "Waiting for optimal moment" : "Calibrating…",
      detail: result.reason,
      // Keep internal score hidden from UI, but return for debugging if needed (not displayed)
      _debug: { score: Math.round(result.score), winProb: Math.round(result.winProbability*100), ev: result.expectedValue, greenLight: result.greenLight }
    });
  } catch (err) {
    res.status(500).json({ error: "Assist evaluation failed" });
  }
});

// ── Manual trade execution ─────────────────────────────────────────────────────

router.post("/", async (req, res): Promise<void> => {
  const parseResult = ExecuteTradeBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid trade parameters" });
    return;
  }

  const { symbol, contractType, stake, direction, isAutonomous, duration, durationUnit } = parseResult.data;
  // barrier is in Zod schema — use it directly
  const requestBarrier = parseResult.data.barrier ?? undefined;

  // Always resolve credentials from this browser's isolated active account.
  const account = await getActiveAccount(req.sessionId);
  const accounts = account ? [account] : [];
  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, req.sessionId)).limit(1);
  const balance = account ? Number(account.balance) : DEMO_BALANCE;
  const maxRisk = settings.length > 0 ? Number(settings[0].maxRiskPerTrade) : 2;
  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;

  if (stake > balance * (maxRisk / 100) * 5) {
    res.status(400).json({ error: `Stake ${stake.toFixed(2)} exceeds risk limit. Max: ${(balance * maxRisk / 100 * 5).toFixed(2)}` });
    return;
  }
  if (stake <= 0) {
    res.status(400).json({ error: "Stake must be greater than 0" });
    return;
  }

  const market = DERIV_MARKETS.find((m) => m.symbol === symbol);
  const displayName = market?.displayName ?? symbol;
  // Defense in depth: Jump 100 remains available only for true manual orders.
  if (isAutonomous && !isAutomatedMarket(symbol)) {
    res.status(400).json({ error: `${displayName} is manual-only and cannot be executed by an AI engine` });
    return;
  }

  const token = account?.bearerToken ?? account?.token ?? null;
  const currency = account?.currency ?? "USD";
  const isLiveTrade = !paperTradeMode && !!token;

  // ── Run coordinator for rich AI context ──────────────────────────────────
  const preferredContractTypes = [contractType];
  const tradingSettings = buildTradingSettingsForManual(settings.length > 0 ? settings[0] : null, preferredContractTypes);

  // Build daily stats
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTrades = await db.select().from(tradesTable).where(and(
    eq(tradesTable.sessionId, req.sessionId),
    sql`${tradesTable.createdAt} >= ${today}`,
  ));
  const closedToday = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
  const daily = buildDailyStatsForManual(closedToday);

  const prices = tickManager.getTicks(symbol, 100);
  const digits = market?.digitEnabled ? tickManager.getDigits(symbol, 300) : [];

  const ctx: ScanContext = {
    symbol,
    displayName,
    category: market?.category ?? "synthetic",
    prices,
    digits,
    balance,
    settings: tradingSettings,
    daily,
    token,
    currency,
  };

  let analysis;
  let savedCoordinatorOutput: Awaited<ReturnType<typeof runCoordinator>> | null = null;
  try {
    savedCoordinatorOutput = await runCoordinator(ctx);
    analysis = buildLegacyAnalysis(savedCoordinatorOutput);
  } catch (err) {
    logger.warn({ err, symbol }, "Coordinator failed for manual trade — using defaults");
    analysis = {
      calibratedConfidence: 55,
      winProbability: 55,
      expectedValue: 0,
      payoutMultiplier: 1.92,
      breakevenWinRate: 52.08,
      riskScore: 50,
      reasoning: "Manual trade (coordinator unavailable)",
      digitBarrier: requestBarrier,
      recommendedDuration: duration ?? 5,
    };
  }

  const tradeDuration = duration ?? (analysis as any).recommendedDuration ?? 5;
  const isDigit = contractType.includes("DIGIT");

  // For digit contracts, always ensure a valid barrier
  const defaultBarrier = contractType === "DIGITOVER" ? 5 : contractType === "DIGITUNDER" ? 4 : undefined;
  const barrier = isDigit
    ? (requestBarrier ?? (analysis as any).digitBarrier ?? defaultBarrier)
    : undefined;

  const winProbability: number = (analysis as any).winProbability ?? 55;
  const payoutQuote = await resolveRecoveryPayout({
    symbol,
    contractType,
    barrier,
    duration: tradeDuration,
    durationUnit: durationUnit ?? "t",
    currency,
  });
  const payoutMultiplier = payoutQuote.source === "live"
    ? payoutQuote.payoutMultiplier
    : getFallbackPayout(contractType, barrier);
  const payout = stake * payoutMultiplier;

  logger.info({
    symbol, contractType, stake, barrier, duration: tradeDuration,
    isLiveTrade, paperTradeMode, token: token ? "present" : "absent",
  }, "Manual trade request");

  let won: boolean, profit: number, entryPrice: number, exitPrice: number;

  if (isLiveTrade) {
    // Insert as "open" immediately so the journal shows it in-progress
    const [openTrade] = await db.insert(tradesTable).values({
      sessionId: req.sessionId,
      symbol,
      displayName,
      contractType,
      barrier: barrier ?? null,
      stake: String(stake),
      direction,
      status: "open",
      aiConfidence: String(winProbability),
      aiRiskScore: String((analysis as any).riskScore ?? 50),
      isAutonomous: isAutonomous ?? false,
      agentReasoning: `[LIVE] ${(analysis as any).reasoning ?? "Manual trade"}`,
      duration: tradeDuration,
      durationUnit: durationUnit ?? "t",
    }).returning();

    try {
      // Deriv requires stake with max 2 decimal places
      const liveStake = Math.round(stake * 100) / 100;
      logger.info({ symbol, contractType, stake: liveStake, barrier }, "Executing live manual trade on Deriv");
      const liveResult = await executeLiveTrade(token!, {
        symbol,
        contractType,
        stake: liveStake,
        duration: tradeDuration,
        durationUnit: durationUnit ?? "t",
        currency,
        accountId: account!.derivAccountId ?? account!.loginId,
        barrier,
      });

      // Wait for Deriv to settle the contract — ticks * 1s + 30s safety buffer
      const contractResult = await waitForContractResult(
        token!, account!.derivAccountId ?? account!.loginId,
        liveResult.contractId, (tradeDuration + 30) * 1000,
      );
      won = contractResult.won;
      // Use Deriv's exact profit — ground truth for the journal
      profit = contractResult.profit;
      entryPrice = contractResult.entrySpot || liveResult.buyPrice;
      // profit_table doesn't expose tick-level exit spot; fall back to entry price for display
      exitPrice = contractResult.exitSpot || entryPrice;
    } catch (liveErr) {
      const errMsg = liveErr instanceof Error ? liveErr.message : String(liveErr);
      logger.warn({ liveErrMsg: errMsg, symbol, contractType, barrier }, "Live manual trade failed");
      // Mark as "error" (not "lost") — outcome is unknown when execution throws.
      // The consecutive-loss counter in the autonomous loop counts only "lost" records,
      // so an unknown outcome must never pollute the streak or trigger false cooldowns.
      await db.update(tradesTable)
        .set({ status: "error", profit: "0", payout: "0", closedAt: new Date(),
               agentReasoning: `[LIVE — FAILED: ${errMsg}] ${(analysis as any).reasoning ?? ""}` })
        .where(eq(tradesTable.id, openTrade.id));
      res.status(500).json({ error: `Trade execution failed: ${errMsg}` });
      return;
    }

    recordTradeOutcome(symbol, contractType, barrier ?? null, won, profit, stake);

    // Update recovery engine — manual trades must be tracked just like autonomous ones.
    // Recovery is global now: any tracked contract type's outcome affects the single
    // recovery state, regardless of which contract type caused the original loss.
    {
      const maxSteps = settings.length > 0 ? (settings[0] as any).maxRecoverySteps ?? 3 : 3;
      recoveryEngine.setPersistenceSession(req.sessionId);
      if (recoveryEngine.isTrackedContract(contractType)) recoveryEngine.recordOutcome(won, profit, stake, maxSteps, contractType, payoutMultiplier);
    }

    // actualPayout = total returned to account when won (stake + net profit), 0 when lost
    const actualPayout = won ? stake + profit : 0;
    const [closedTrade] = await db.update(tradesTable).set({
      status: won ? "won" : "lost",
      payout: String(actualPayout),
      profit: String(profit),
      entryPrice: String(entryPrice),
      exitPrice: String(exitPrice),
      closedAt: new Date(),
    }).where(eq(tradesTable.id, openTrade.id)).returning();

    // Sync live balance — update only the active account
    try {
      const newBalance = await getLiveBalance(token!, account?.derivAccountId ?? account?.loginId);
      if (newBalance !== null && accounts.length > 0) {
        await db.update(accountsTable).set({ balance: String(newBalance), updatedAt: new Date() }).where(eq(accountsTable.id, accounts[0].id));
      }
    } catch { /* ignore */ }

    broadcastSSE("trade_completed", {
      trade: {
        id: closedTrade.id, symbol, displayName, contractType: normalizeDerivContractType(contractType),
        barrier: barrier ?? null, stake, payout: actualPayout,
        profit: Math.round(profit * 100) / 100, won,
        status: won ? "won" : "lost", duration: tradeDuration,
        durationUnit: durationUnit ?? "t",
        createdAt: new Date().toISOString(), closedAt: new Date().toISOString(),
        aiConfidence: winProbability, isAutonomous: isAutonomous ?? false, source: "live",
      }
    }, req.sessionId);
    // Immediately refresh only this browser session's Deriv profit table.
    const journalManager = getJournalManager(req.sessionId);
    journalManager.once("refreshed", () => {
      broadcastSSE("journal_refreshed", { ts: Date.now() }, req.sessionId);
    });
    journalManager.forceRefresh();

    // Fire-and-forget: Trade Intelligence analysis — stores why this trade won/lost in DB
    if (savedCoordinatorOutput) {
      analyzeCompletedTrade({
        tradeId:      closedTrade.id,
        symbol,
        contractType,
        barrier:      barrier ?? null,
        stake,
        won,
        profit,
        output:       savedCoordinatorOutput,
      }).catch(() => {});
    }

    res.status(201).json(formatTrade(closedTrade));
    return;
  }

  // ── Paper / demo trade simulation ─────────────────────────────────────────
  const winProb = winProbability / 100;
  won = Math.random() < winProb;
  profit = won ? payout - stake : -stake;

  entryPrice = prices[prices.length - 1] ?? 100;
  exitPrice = won
    ? direction === "up" ? entryPrice * 1.001 : entryPrice * 0.999
    : direction === "up" ? entryPrice * 0.999 : entryPrice * 1.001;

  recordTradeOutcome(symbol, contractType, barrier ?? null, won, profit, stake);

  // Update recovery engine for paper/demo manual trades too (global state)
  {
    const maxSteps = settings.length > 0 ? (settings[0] as any).maxRecoverySteps ?? 3 : 3;
    recoveryEngine.setPersistenceSession(req.sessionId);
    if (recoveryEngine.isTrackedContract(contractType)) recoveryEngine.recordOutcome(won, profit, stake, maxSteps, contractType, payoutMultiplier);
  }

  const [trade] = await db.insert(tradesTable).values({
    sessionId: req.sessionId,
    symbol,
    displayName,
    contractType,
    barrier: barrier ?? null,
    stake: String(stake),
    direction,
    status: won ? "won" : "lost",
    payout: String(payout),
    profit: String(profit),
    entryPrice: String(entryPrice),
    exitPrice: String(exitPrice),
    aiConfidence: String(winProbability),
    aiRiskScore: String((analysis as any).riskScore ?? 50),
    isAutonomous: isAutonomous ?? false,
    agentReasoning: `[${token ? "PAPER" : "DEMO"}] ${(analysis as any).reasoning ?? "Manual trade"}`,
    duration: tradeDuration,
    durationUnit: durationUnit ?? "t",
    closedAt: new Date(),
  }).returning();

  // Update simulated balance for paper/demo trades
  try {
    if (accounts.length > 0) {
      const newBalance = Math.max(0, balance + profit);
      await db.update(accountsTable)
        .set({ balance: String(newBalance.toFixed(2)), updatedAt: new Date() })
        .where(eq(accountsTable.id, accounts[0].id));
    }
  } catch { /* ignore */ }

  broadcastSSE("trade_completed", {
    trade: {
      id: trade.id, symbol, displayName, contractType: normalizeDerivContractType(contractType),
      barrier: barrier ?? null, stake, payout: Number(payout.toFixed(2)),
      profit: Math.round(profit * 100) / 100, won,
      status: won ? "won" : "lost", duration: tradeDuration,
      durationUnit: durationUnit ?? "t",
      createdAt: new Date().toISOString(), closedAt: new Date().toISOString(),
      aiConfidence: winProbability, isAutonomous: isAutonomous ?? false, source: "paper",
    }
  }, req.sessionId);

  // Fire-and-forget: Trade Intelligence analysis — stores why this trade won/lost in DB
  if (savedCoordinatorOutput) {
    analyzeCompletedTrade({
      tradeId:      trade.id,
      symbol,
      contractType,
      barrier:      barrier ?? null,
      stake,
      won,
      profit,
      output:       savedCoordinatorOutput,
    }).catch(() => {});
  }

  res.status(201).json(formatTrade(trade));
});

// ── Shared: compute the core stat shape from a trade list ───────────────────────
// NOTE: trades should be sorted newest-first (Deriv profit_table default: sort:"DESC")
// for the streak/longest-streak calculations to be correct.
function computeStatsCore(trades: any[]) {
  const won = trades.filter((t) => t.won);
  const lost = trades.filter((t) => !t.won);
  const totalProfit = trades.reduce((s, t) => s + (t.profit ?? 0), 0);

  // Streak: iterate newest-first (trades[0] is most recent) — correct consecutive count
  let currentStreak = 0;
  for (const t of trades) {
    if (currentStreak === 0) currentStreak = t.won ? 1 : -1;
    else if (t.won && currentStreak > 0) currentStreak++;
    else if (!t.won && currentStreak < 0) currentStreak--;
    else break;
  }

  let longestWin = 0, longestLoss = 0, runLen = 0, runWon: boolean | null = null;
  for (const t of trades) {
    if (runWon === null || runWon !== t.won) {
      if (runWon === true) longestWin = Math.max(longestWin, runLen);
      if (runWon === false) longestLoss = Math.max(longestLoss, runLen);
      runLen = 1; runWon = t.won;
    } else { runLen++; }
  }
  if (runWon === true) longestWin = Math.max(longestWin, runLen);
  if (runWon === false) longestLoss = Math.max(longestLoss, runLen);

  return {
    totalTrades: trades.length,
    wonTrades: won.length,
    lostTrades: lost.length,
    winRate: trades.length > 0 ? won.length / trades.length : 0,
    totalProfit: Math.round(totalProfit * 100) / 100,
    avgProfit: trades.length > 0 ? Math.round((totalProfit / trades.length) * 100) / 100 : 0,
    bestTrade: won.length > 0 ? Math.max(...won.map((t) => t.profit ?? 0)) : 0,
    worstTrade: lost.length > 0 ? Math.min(...lost.map((t) => t.profit ?? 0)) : 0,
    currentStreak,
    longestWinStreak: longestWin,
    longestLoseStreak: longestLoss,
  };
}

// ── Shared: compute stats from a trade list ────────────────────────────────────
// Returns BOTH the all-time stats (used by Analytics, which shows full historical
// detail) and a `todayStats` sub-object scoped to the current calendar day (used by
// the Dashboard and Journal header cards, which start on a clean slate every day —
// no trades/win-rate/streak carried over from yesterday). `today*` scalar fields are
// kept for backward compatibility with existing consumers.
function computeJournalStats(trades: any[]) {
  const allTime = computeStatsCore(trades);

  const todayStart = getTodayStart();
  const today = trades
    .filter((t) => new Date(t.createdAt) >= todayStart)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  // computeStatsCore's streak logic requires newest-first order (trades[0] = most
  // recent) to count consecutive wins/losses correctly. `today` above is sorted
  // ascending (oldest→newest) for the timeline/chart consumers, so pass a
  // newest-first copy here — otherwise the streak gets computed starting from the
  // OLDEST trade of the day instead of the most recent one, producing a wrong
  // "current" streak (e.g. showing a 2-loss streak from earlier in the day while
  // the actual latest trades are a win streak).
  const todayStats = computeStatsCore([...today].reverse());

  return {
    ...allTime,
    todayProfit: todayStats.totalProfit,
    todayTrades: todayStats.totalTrades,
    todayWon: todayStats.wonTrades,
    todayLost: todayStats.lostTrades,
    // Clean-slate view for Dashboard/Journal — everything scoped to "today" only.
    todayStats,
    // The actual today-scoped trade list (oldest → newest), so every consumer
    // (Analytics charts/timeline included) renders the exact same rows the
    // stats above were computed from, instead of re-deriving its own filter.
    todayTradesList: today,
  };
}

// Deriv's profit_table has no structured "barrier" field for digit contracts, so
// the barrier has to be parsed out of the longcode sentence. The naive approach —
// "grab the last digit anywhere in the string" — is WRONG: longcodes end with a
// duration clause ("...after 3 ticks."), so a contract barrier of 8 traded with a
// 3-tick duration would read back as barrier 3. Match the specific phrase the
// barrier actually appears in instead of scanning the whole sentence.
//   DIGITOVER:  "...is strictly higher than 8 after 5 ticks."
//   DIGITUNDER: "...is strictly lower than 8 after 5 ticks."
//   DIGITMATCH: "...is 5 after 5 ticks."
//   DIGITDIFF:  "...is not 5 after 5 ticks."
//   DIGITEVEN/DIGITODD have no barrier — none of these patterns match, correctly.
const BARRIER_PATTERNS: RegExp[] = [
  /strictly higher than (\d)/i,
  /strictly lower than (\d)/i,
  /is not (\d) after \d+ tick/i,
  /is (\d) after \d+ tick/i,
  /matches (\d)/i,
  /differs from (\d)/i,
];

function extractBarrierFromLongcode(longcode: unknown): number | null {
  if (typeof longcode !== "string") return null;
  for (const pattern of BARRIER_PATTERNS) {
    const match = longcode.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function normalizeDerivContractType(ct: string): string {
  // Canonical: CALL (Rise) and PUT (Fall). Normalize legacy RISE/FALL → CALL/PUT.
  if (ct === "RISE") return "CALL";
  if (ct === "FALL") return "PUT";
  return ct;
}

// ── Deriv profit_table journal (sole source of truth — no local fallback) ───────
router.get("/deriv-journal", async (req, res): Promise<void> => {
  const account = await getActiveAccount(req.sessionId);
  const token = account?.bearerToken ?? account?.token ?? null;
  if (token && account) {
    getJournalManager(req.sessionId).setCredentials(token, account.derivAccountId ?? account.loginId);
  }

  const emptyStats = computeJournalStats([]);
  const emptyResponse = { source: "none" as const, trades: [], todayTrades: emptyStats.todayTradesList, stats: emptyStats };

  if (!token) {
    res.json(emptyResponse);
    return;
  }

  const transactions = await getDerivTransactions(req.sessionId);

  if (transactions.length === 0) {
    res.json({ source: "deriv" as const, trades: [], todayTrades: emptyStats.todayTradesList, stats: emptyStats });
    return;
  }

  const mapped = transactions.map((t: any) => {
    const buyPrice = Number(t.buy_price ?? 0);
    const sellPrice = Number(t.sell_price ?? 0);
    const profit = Math.round((sellPrice - buyPrice) * 100) / 100;
    const market = DERIV_MARKETS.find((m) => m.symbol === t.underlying_symbol);
    // See extractBarrierFromLongcode() — parses the specific barrier phrase,
    // not just "the last digit anywhere in the sentence" (which used to pick up
    // the duration's tick count instead of the actual barrier).
    const barrier = extractBarrierFromLongcode(t.longcode);
    return {
      id: t.transaction_id,
      symbol: t.underlying_symbol ?? "—",
      displayName: market?.displayName ?? t.underlying_symbol ?? "—",
      contractType: normalizeDerivContractType(t.contract_type ?? "UNKNOWN"),
      barrier,
      stake: buyPrice,
      payout: sellPrice,
      profit,
      won: profit > 0,
      status: profit > 0 ? "won" : "lost",
      duration: t.duration,
      durationUnit: t.duration_unit,
      createdAt: t.purchase_time ? new Date(t.purchase_time * 1000).toISOString() : new Date().toISOString(),
      closedAt: t.sell_time ? new Date(t.sell_time * 1000).toISOString() : null,
      longcode: t.longcode ?? null,
      isAutonomous: false,
      aiConfidence: null,
      source: "deriv",
    };
  });

  const journalStats = computeJournalStats(mapped);
  // Disable Express ETag / HTTP caching so the client always gets fresh data
  // and React Query doesn't receive stale 304 responses after a journalManager refresh.
  res.set("Cache-Control", "no-store");
  // Limit the trade list to the 200 most recent for display.
  // Stats are computed from the full set above — only the rendered list is capped.
  // This reduces the JSON payload from ~1 MB (5000+ trades) to ~40 KB, which
  // eliminates the main-thread JSON.parse stall that froze the FAB and delayed navigation.
  res.json({ source: "deriv" as const, trades: mapped.slice(0, 200), todayTrades: journalStats.todayTradesList, stats: journalStats });
});

router.get("/:id", async (req, res): Promise<void> => {
  const parseResult = GetTradeParams.safeParse(req.params);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid trade ID" });
    return;
  }
  const trades = await db.select().from(tradesTable).where(and(
    eq(tradesTable.id, parseResult.data.id),
    eq(tradesTable.sessionId, req.sessionId),
  ));
  if (trades.length === 0) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.json(formatTrade(trades[0]));
});

function formatTrade(trade: typeof tradesTable.$inferSelect) {
  return {
    id: trade.id,
    symbol: trade.symbol,
    displayName: trade.displayName,
    contractType: trade.contractType,
    barrier: trade.barrier ?? null,
    stake: Number(trade.stake),
    direction: trade.direction,
    status: trade.status,
    payout: trade.payout ? Number(trade.payout) : null,
    profit: trade.profit ? Number(trade.profit) : null,
    entryPrice: trade.entryPrice ? Number(trade.entryPrice) : null,
    exitPrice: trade.exitPrice ? Number(trade.exitPrice) : null,
    aiConfidence: trade.aiConfidence ? Number(trade.aiConfidence) : null,
    aiRiskScore: trade.aiRiskScore ? Number(trade.aiRiskScore) : null,
    isAutonomous: trade.isAutonomous,
    agentReasoning: trade.agentReasoning,
    createdAt: trade.createdAt.toISOString(),
    closedAt: trade.closedAt ? trade.closedAt.toISOString() : null,
    duration: trade.duration,
  };
}

export default router;
