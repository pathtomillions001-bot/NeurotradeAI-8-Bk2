import { Router } from "express";
import { db } from "@workspace/db";
import { aiInsightsTable, tradesTable, settingsTable, accountsTable } from "@workspace/db";
import { and, sql, desc, eq } from "drizzle-orm";
import { tickManager, DERIV_MARKETS, AUTOMATED_DERIV_MARKETS, executeLiveTrade, waitForContractResult, getLiveBalance, getMarketInfo, analyzeDigits, analyzeTrend, analyzeEvenOdd, getJournalManager, isAutomatedMarket } from "../lib/deriv";
import { runRecoveryConsensus, getBestConsensus } from "../lib/agents/recovery-consensus";
import { resolveRecoveryPayout } from "../lib/recovery-payout";
import { ToggleAutonomousEngineBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { runCoordinator, buildLegacyAnalysis, recordTradeOutcome } from "../lib/agent-coordinator";
import type { TradingSettings, DailyStats, ScanContext } from "../lib/agents/types";
import { computeStake } from "../lib/agents/ev-calculator";
import * as recoveryEngine from "../lib/agents/recovery-engine";
import { recordLossForPattern, clearLossPattern } from "../lib/agents/recovery-intelligence";
import { analyzeCompletedTrade, getRecentReports, getIntelligenceSummary } from "../lib/agents/trade-intelligence";
import { trackRejectedTrade, getMissedOpportunitySummary, getRecentMissed } from "../lib/agents/missed-opportunity";
import { getStatus as getDynamicConfidenceStatus, loadFromDb as loadDynamicConfidence } from "../lib/agents/dynamic-confidence";
import { broadcastSSE, addSSEClient, removeSSEClient } from "../lib/sse";
import { getTodayStart } from "./trades";
import { setTzOffset } from "../lib/tz";
import {
  acquireTradingOwnership,
  releaseTradingOwnership,
  currentTradingOwner,
  tradingOwnerLabel,
} from "../lib/engine-arbiter";

const router = Router();

// ── Recovery state persistence ────────────────────────────────────────────────
/** Load persisted recovery state from DB on server startup. */
/**
 * Resets every in-memory daily counter at midnight.
 *
 * Clears:  tradesExecutedToday, sessionLossCount, lastTradeCompletedAt,
 *          recentTradesBySymbol, active cooldown timer + cooldownUntil.
 * Also forces the recovery engine into a new-day state (50%-debt carry logic).
 * Broadcasts `day_reset` SSE only to the owning browser session.
 *
 * Called by:
 *  1. The server-side midnight scheduler (lib/tz) — fires even when the browser is closed.
 *  2. POST /api/ai/day-reset from the frontend — fires at the user's exact local midnight.
 */
export function forceDayReset(broadcast = true, sessionId?: string): void {
  const resetSessionId = sessionId ?? engineOwnerSessionId ?? undefined;
  const ownsExecutor = !!resetSessionId && engineOwnerSessionId === resetSessionId;

  // Executor globals belong only to the current owner. A midnight request from
  // another browser must never clear that owner's cooldown or counters.
  if (ownsExecutor) {
    tradesExecutedToday  = 0;
    sessionLossCount     = 0;
    lastTradeCompletedAt = null;
    recentTradesBySymbol.clear();
    if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }
    cooldownUntil = null;
  }

  if (resetSessionId) {
    recoveryEngine.setPersistenceSession(resetSessionId);
    recoveryEngine.forceNewDay();
  }

  if (broadcast && resetSessionId) {
    broadcastSSE("day_reset", { ts: new Date().toISOString() }, resetSessionId);
  }
  logger.info({ sessionId: resetSessionId, executorCountersReset: ownsExecutor }, "Session midnight day-reset fired");
}

/**
 * Called once at startup. If the DB shows autonomous_enabled=true (i.e. the
 * engine was running when the server last shut down), restart the loop
 * automatically so a server restart doesn't silently strand the user in
 * manual mode without any indication.
 *
 * Runs AFTER loadRecoveryStateFromDb so the streak counter is accurate
 * before the first scan fires.
 */
export async function resumeEngineIfEnabled(): Promise<void> {
  // A server restart has no trustworthy browser owner to bind credentials to.
  // Fail closed rather than auto-resuming an arbitrary persisted account.
  await db.update(settingsTable).set({ autonomousEnabled: false });
  logger.info("Autonomous auto-resume disabled for session isolation; user must restart from their browser");
}

export async function loadRecoveryStateFromDb(): Promise<void> {
  // Recovery is loaded from the starting browser's scoped settings row in the
  // toggle handler. Never restore a process-global state from an arbitrary user.
  recoveryEngine.resetAll();
}

// Persistence of recovery state to DB now happens automatically inside
// recoveryEngine.recordOutcome() itself (see recovery-engine.ts) — every caller
// (manual trades in trades.ts, autonomous trades below) gets it for free and it
// can no longer be forgotten at a call site.

/**
 * Recovery state is now tracked ONLY by `recoveryEngine.recordOutcome()`, called
 * synchronously the instant every trade (manual or autonomous) settles — see
 * trades.ts and the trade-execution block below. That in-memory state is the
 * single, real-time source of truth for both the dashboard card and the digit
 * barrier the AI uses on the next trade, and it is persisted to DB after every
 * update so it also survives server restarts (see loadRecoveryStateFromDb).
 *
 * IMPORTANT: this file previously also re-derived recovery state from the
 * cached Deriv journal (`journalManager.getCached()`) on every loop iteration,
 * "correcting" the engine if the journal showed a different picture. That
 * journal cache only refreshes every ~60s (or on a fire-and-forget
 * forceRefresh call), so it can easily be STALE relative to a trade outcome
 * that was just recorded in-memory. Re-seeding recovery from that stale
 * snapshot caused a race: a fully-recovered win would reset `recoveryEngine`
 * to normal instantly, but the very next loop iteration would read the
 * not-yet-refreshed journal (still showing the old loss streak) and
 * incorrectly re-activate recovery mode / resurrect the old debt on the
 * dashboard. That re-derivation has been removed — the journal is used for
 * P&L/journal display only, never to overwrite recovery state.
 */

// ── Engine state ─────────────────────────────────────────────────────────────
let engineRunning = false;
// The singleton autonomous executor is pinned to the browser session that
// started it. Other visitors cannot inspect, stop, or redirect its credentials.
let engineOwnerSessionId: string | null = null;
let autonomousMode = "manual";
let tradesExecutedToday = 0;
let currentMarket: string | null = null;
let nextScanIn: number | null = null;
let stopReasons: string[] = [];
let autonomousTimer: ReturnType<typeof setTimeout> | null = null;
let loopIntervalSec = 5;
let lastTradeTime: Date | null = null;
// Concurrency guard — prevents two loop iterations from running simultaneously
let isLoopRunning = false;
// Cooldown state — set when engine stops due to consecutive losses
let cooldownUntil: Date | null = null;
let cooldownResumeTimer: ReturnType<typeof setTimeout> | null = null;
// Consecutive loss counter — increments on each loss; resets to 0 on any win; full reset on cooldown expiry
let sessionLossCount = 0;
// Tracks when the last cooldown ended (auto or manual). Consecutive-loss counting only
// considers journal entries AFTER this timestamp so the engine never re-triggers cooldown
// from the same streak that already served a cooldown.

let exploitSymbol: string | null = null;
let exploitCount = 0;
let exploitQualityThreshold = 0;

// Real-time agent scores (updated each scan)
let lastAgentScores: Record<string, number> = {};


// ── Family rotation hint ───────────────────────────────────────────────────────
// Tracks which contract family should be preferred in the NEXT scan so that
// Rise/Fall and Even/Odd get executed in rotation alongside Over/Under, rather
// than Over/Under always winning the quality tournament.
let scheduledFamilyHint: string | null = null;

// ── Per-symbol trade cooldown ──────────────────────────────────────────────────
// Prevents more than MAX_TRADES_SAME_SYMBOL executions on the same synthetic pair
// within SAME_SYMBOL_COOLDOWN_MS. After the limit is reached the engine skips that
// symbol and picks the next-best opportunity.
const recentTradesBySymbol = new Map<string, Date[]>();
const MAX_TRADES_SAME_SYMBOL = 2;
const SAME_SYMBOL_COOLDOWN_MS = 8 * 60 * 1000; // 8 minutes

// Stale open-trade threshold — shared between normal path and recovery fast path
const STALE_OPEN_MS = 2 * 60 * 1000; // 2 minutes

// ── Last completed trade timestamp ───────────────────────────────────────────
// Prevents the engine from immediately firing a second scan while a trade is
// still being journalled in Deriv. Set immediately after the trade settles.
let lastTradeCompletedAt: Date | null = null;

// Groups: 0=Volatility 1s (1HZ*), 1=Volatility (R_*), 2=Jump (JD*), 3=Bull/Bear
const GROUP_NAMES = ["Volatility 1s", "Volatility", "Jump Indices", "Bull/Bear"];

// ── Per-group scan cursor ─────────────────────────────────────────────────────
// Each group advances its own cursor by 1 every loop iteration so markets are
// visited in strict canonical order (V10→V25→V50→V75→V100) with NO repeats
// until the entire group has been scanned once (then the cursor wraps to V10).
// All 4 groups advance simultaneously (parallel), but each group never skips
// or revisits a market within its own cycle.
// Index: 0=Volatility 1s, 1=Volatility, 2=Jump Indices, 3=Bull/Bear
const groupCursors = [0, 0, 0, 0];

// 13-agent system names and score keys
const AGENT_NAMES = [
  "Market Scanner", "Tick Intelligence", "Digit Probability",
  "Rise/Fall Model", "Market Regime", "Execution Timing",
  "Confidence Fusion", "Recovery Intelligence", "Risk Intelligence",
  "Portfolio Manager", "Learning Agent", "Pattern Discovery",
  "Trade Explainability",
];

const AGENT_SCORE_KEYS = [
  "marketScanner", "tickIntelligence", "digitProbability",
  "riseFallAgent", "marketRegime", "executionTiming",
  "confidenceFusion", "recoveryIntelligence", "riskIntelligence",
  "portfolioManager", "learningAgent", "patternDiscovery",
  "tradeExplainability",
];

// ── Settings builders ─────────────────────────────────────────────────────────

async function getAccountAndSettings(sessionId: string) {
  // Always prefer this browser session's active account (real vs demo switch).
  let accounts = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, sessionId),
    eq(accountsTable.isActive, true),
  )).limit(1);
  if (accounts.length === 0) {
    accounts = await db.select().from(accountsTable)
      .where(eq(accountsTable.sessionId, sessionId)).limit(1);
  }
  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, sessionId)).limit(1);
  return {
    balance: accounts.length > 0 ? Number(accounts[0].balance) : 10000,
    settings: settings.length > 0 ? settings[0] : null,
    accountId: accounts.length > 0 ? accounts[0].id : null,
    account: accounts.length > 0 ? accounts[0] : null,
  };
}

function buildTradingSettings(s: any, preferredContractTypes: string[]): TradingSettings {
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
    // Clamp digit barriers to valid Deriv ranges.
    // OVER 0–8 are valid (OVER 9 is impossible — no digit > 9 exists).
    // UNDER 1–9 are valid (UNDER 0 is impossible — no digit < 0 exists).
    normalOverDigit:        Math.min(8, Math.max(0, s?.normalOverDigit ?? 2)),
    normalUnderDigit:       Math.min(9, Math.max(1, s?.normalUnderDigit ?? 7)),
    recoveryOverDigit:      Math.min(8, Math.max(0, s?.recoveryOverDigit ?? 4)),
    recoveryUnderDigit:     Math.min(9, Math.max(1, s?.recoveryUnderDigit ?? 5)),
    recoveryMethod:         (s?.recoveryMethod === "instant" ? "instant" : "split") as "split" | "instant",
    // Manual mode owns this value; Auto mode ignores it completely.
    recoveryMultiplier:     s ? Number(s.recoveryMultiplier ?? 1.5) : 1.5,
    recoveryAutoMode:       s?.recoveryAutoMode ?? true,
    maxRecoverySteps:       s?.maxRecoverySteps ?? 3,
  };
}

function buildDailyStats(
  closedToday: any[],
  consecutiveLosses: number,
): DailyStats {
  const wins = closedToday.filter((t) => t.status === "won").length;
  const losses = closedToday.filter((t) => t.status === "lost").length;
  const profit = closedToday.reduce((s: number, t: any) => s + Number(t.profit ?? 0), 0);
  // Consecutive wins (for completeness)
  let consecutiveWins = 0;
  const sorted = [...closedToday].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  for (const t of sorted) { if (t.status === "won") consecutiveWins++; else break; }

  return {
    tradesCount: closedToday.length,
    wins,
    losses,
    profit,
    consecutiveLosses,
    consecutiveWins,
  };
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
  return {
    symbol:      market.symbol,
    displayName: market.displayName,
    category:    market.category,
    prices,
    digits,
    balance,
    settings,
    daily,
    token,
    currency,
  };
}

// ── Wire up TickManager → SSE for live prices + live analysis ─────────────────

// Track the last time each market received a real Deriv tick
const lastTickTime = new Map<string, number>();

tickManager.on("tick", (tick) => {
  broadcastSSE("tick", tick);
  lastTickTime.set(tick.symbol, Date.now());
  const market = getMarketInfo(tick.symbol);
  if (market && isAutomatedMarket(tick.symbol)) {
    const prices = tickManager.getTicks(tick.symbol, 100);
    const trendStats = analyzeTrend(prices);
    // Get 100 digits for richer even/odd and digit analysis
    const digits100 = market.digitEnabled ? tickManager.getDigits(tick.symbol, 100) : null;
    const digitStats = (digits100 && digits100.length > 10) ? analyzeDigits(digits100) : null;
    broadcastSSE("market_analysis", {
      symbol: tick.symbol, trendStats, digitStats,
      lastDigit: tick.lastDigit,
      price: tick.price, epoch: tick.epoch,
    });
  }
});

// ── Heartbeat: broadcast market_analysis for markets that haven't received
//    a real Deriv tick in the last 3s (e.g. 1HZ25V when Deriv throttles).
//    Rotates through all markets, one per 200ms, full cycle every ~7s.
let heartbeatIdx = 0;
setInterval(() => {
  const now = Date.now();
  const markets = AUTOMATED_DERIV_MARKETS;
  if (markets.length === 0) return;
  heartbeatIdx = (heartbeatIdx + 1) % markets.length;
  const market = markets[heartbeatIdx];
  const lastTick = lastTickTime.get(market.symbol) ?? 0;
  // Only broadcast if this market hasn't had a real tick in the last 3 seconds
  if (now - lastTick < 3000) return;
  const prices = tickManager.getTicks(market.symbol, 100);
  const trendStats = analyzeTrend(prices);
  const digits100h = market.digitEnabled ? tickManager.getDigits(market.symbol, 100) : null;
  const digitStats = (digits100h && digits100h.length > 10) ? analyzeDigits(digits100h) : null;
  const latestPrice = tickManager.getLatestPrice(market.symbol) ?? prices[prices.length - 1] ?? 0;
  broadcastSSE("market_analysis", {
    symbol: market.symbol,
    trendStats,
    digitStats,
    lastDigit: digits100h ? digits100h[digits100h.length - 1] ?? null : null,
    price: latestPrice,
    epoch: Math.floor(now / 1000),
  });
}, 200);

function broadcastEngineSSE(event: string, data: unknown): void {
  if (!engineOwnerSessionId) return;
  broadcastSSE(event, data, engineOwnerSessionId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stopEngine(reason: string, cooldownMinutes?: number) {
  const stoppedOwnerSessionId = engineOwnerSessionId;
  engineRunning = false;
  autonomousMode = "manual";
  stopReasons = [reason];
  currentMarket = null;
  nextScanIn = null;
  exploitSymbol = null;
  exploitCount = 0;
  isLoopRunning = false;
  if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
  // Give up trading ownership so another engine (NeuroAI FAB) may execute while
  // this one is stopped. Ownership is re-acquired atomically at loop start, so
  // a cooldown auto-resume can never race a FAB session that started meanwhile.
  releaseTradingOwnership("autonomous");

  // Clear any existing cooldown timer
  if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }

  if (cooldownMinutes && cooldownMinutes > 0) {
    cooldownUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000);
    cooldownResumeTimer = setTimeout(() => {
      cooldownUntil = null;
      cooldownResumeTimer = null;
      // Reset the global loss-streak counter on cooldown expiry — the ONLY reset
      // point outside of a fully-covering win. This clears the counter that
      // gates cooldown (recoveryEngine streakLossCount), NOT the recovery debt
      // itself (unrecoveredAmount persists until a win fully covers the loss debt).
      recoveryEngine.seedState({ ...recoveryEngine.getState(), streakLossCount: 0 });
      sessionLossCount = 0;
      // Auto-resume engine
      engineRunning = true;
      autonomousMode = "autonomous";
      stopReasons = [];
      nextScanIn = loopIntervalSec;
      exploitSymbol = null;
      exploitCount = 0;
      logger.info("Cooldown expired — autonomous engine auto-resuming, session loss count reset");
      broadcastEngineSSE("engine_started", { reason: "cooldown_expired" });
      broadcastEngineSSE("loss_streak_reset", { sessionLossCount: 0 });
      autonomousTimer = setTimeout(runAutonomousLoop, 1000);
    }, cooldownMinutes * 60 * 1000);
    logger.info({ reason, cooldownMinutes, cooldownUntil }, "Engine stopped with cooldown");
  } else {
    cooldownUntil = null;
    engineOwnerSessionId = null;
    logger.info({ reason }, "Autonomous engine stopped");
  }
  if (stoppedOwnerSessionId) {
    broadcastSSE("engine_stopped", { reason, cooldownUntil: cooldownUntil?.toISOString() ?? null }, stoppedOwnerSessionId);
  }
}

async function syncLiveBalance(
  sessionId: string,
  token: string,
  derivAccountId: string,
) {
  try {
    const balance = await getLiveBalance(token, derivAccountId);
    if (balance === null) return;
    const activeAccounts = await db.select().from(accountsTable).where(and(
      eq(accountsTable.sessionId, sessionId),
      eq(accountsTable.isActive, true),
    )).limit(1);
    if (activeAccounts.length > 0) {
      await db.update(accountsTable).set({ balance: String(balance), updatedAt: new Date() })
        .where(eq(accountsTable.id, activeAccounts[0].id));
    }
  } catch { /* ignore */ }
}

// ── Autonomous loop ───────────────────────────────────────────────────────────
async function runAutonomousLoop() {
  if (!engineRunning) return;
  // Prevent concurrent iterations — if a previous loop is still running, skip
  if (isLoopRunning) {
    logger.warn("Autonomous loop: previous iteration still running — skipping this tick");
    scheduleNext(false);
    return;
  }

  // ── Single-executor guard ───────────────────────────────────────────────────
  // One account = one recovery ledger = one executing engine. If the NeuroAI
  // FAB session owns execution right now, this engine must NOT trade — two
  // engines sizing recovery stakes off the same account was the root cause of
  // the "normal trade while in recovery / recovery trade after recovering" bug.
  if (!acquireTradingOwnership("autonomous")) {
    const owner = currentTradingOwner();
    logger.warn({ owner }, "Autonomous loop cannot trade — another engine owns execution; stopping to protect the shared recovery ledger");
    stopEngine(
      `Stopped: the ${owner ? tradingOwnerLabel(owner) : "other engine"} is trading this account. One recovery ledger = one trading engine at a time — stop that engine before restarting this one.`,
    );
    return;
  }

  isLoopRunning = true;

  try {
    const sessionId = engineOwnerSessionId;
    if (!sessionId) {
      stopEngine("Autonomous engine lost its browser-session owner");
      return;
    }
    recoveryEngine.setPersistenceSession(sessionId);
    const { balance, settings, account } = await getAccountAndSettings(sessionId);
    const token = account?.bearerToken ?? account?.token ?? null;
    const derivAccountId = account?.derivAccountId ?? account?.loginId ?? null;
    const journalManager = getJournalManager(sessionId);
    if (token && derivAccountId) journalManager.setCredentials(token, derivAccountId);

    const rawPreferred = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];
    // Normalize: accept both CALL/PUT and RISE/FALL, unify to CALL/PUT
    const preferredContractTypes = rawPreferred.map(t => t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t).filter((v, i, a) => a.indexOf(v) === i);
    const tradingSettings = buildTradingSettings(settings, preferredContractTypes);
    const marketRotationAfter = settings?.marketRotationAfter ?? 5;
    const paperTradeMode = tradingSettings.paperTradeMode;

    // ── Over/Under digit barriers — settings-driven, no hardcoded fallback ────
    // Recovery is a single global state now: whenever it's active, EVERY Over/Under
    // scan uses the user-configured recovery pair; otherwise the normal pair.
    // Computed once per loop iteration since recovery state doesn't change mid-scan.
    const activeBarrierOverride: { DIGITOVER: number; DIGITUNDER: number } = recoveryEngine.isInRecovery()
      ? { DIGITOVER: tradingSettings.recoveryOverDigit, DIGITUNDER: tradingSettings.recoveryUnderDigit }
      : { DIGITOVER: tradingSettings.normalOverDigit, DIGITUNDER: tradingSettings.normalUnderDigit };

    const allowedMarketSymbols: string[] | null =
      (settings as any)?.allowedMarkets
        ? ((settings as any).allowedMarkets as string).split(",").filter(Boolean)
        : null;
    const availableMarkets = allowedMarketSymbols && allowedMarketSymbols.length > 0
      ? AUTOMATED_DERIV_MARKETS.filter((m) => allowedMarketSymbols.includes(m.symbol))
      : AUTOMATED_DERIV_MARKETS;

    if (settings?.loopIntervalSec) loopIntervalSec = settings.loopIntervalSec;

    // Daily stats — shared day boundary with /api/trades/deriv-journal and
    // /api/trades/daily-summary so the engine's own hard-stop checks below use
    // the exact same "today" window the dashboards display.
    const today = getTodayStart();
    const todayTrades = await db.select().from(tradesTable).where(and(
      eq(tradesTable.sessionId, sessionId),
      sql`${tradesTable.createdAt} >= ${today}`,
    ));
    const closedToday = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
    tradesExecutedToday = closedToday.length;

    // ── Ground-truth consecutive-loss and daily P&L ──────────────────────────
    // Consecutive losses: ALWAYS use local DB (written immediately when trades settle,
    // before scheduleNext fires — always current). The Deriv profit_table can lag
    // 15–60 s after forceRefresh, which caused missed cooldown triggers. Unknown-outcome
    // failures are marked "error" (not "lost"), so local DB "lost" records are reliable.
    // Daily P&L: prefer Deriv journal (authoritative net profit), fall back to local DB.
    const derivTxns = token ? journalManager.getCached() : [];
    const todayMidnightSec = today.getTime() / 1000; // Deriv uses Unix seconds
    const derivTodayTxns = derivTxns.filter(
      (t: any) => Number(t.sell_time ?? t.purchase_time ?? 0) >= todayMidnightSec,
    );

    let resolvedDailyProfit: number;

    // ── Daily P&L — prefer Deriv journal (authoritative net P&L), fall back to DB ──
    // The Deriv profit_table has the correct net profit including payout multipliers.
    // Local DB profit fields are set from Deriv's contractResult.profit on live trades
    // so they should match, but the journal is used as a secondary accuracy check.
    if (derivTodayTxns.length > 0) {
      resolvedDailyProfit = derivTodayTxns.reduce(
        (s: number, t: any) => s + Number(t.profit ?? 0), 0,
      );
    } else {
      resolvedDailyProfit = closedToday.reduce((s, t) => s + Number(t.profit ?? 0), 0);
    }

    // ── Consecutive-loss streak — SINGLE authoritative source ────────────────
    // The global Recovery Intelligence loss-streak counter (recoveryEngine.getState()
    // .streakLossCount) is the exact same number shown on the dashboard's Recovery
    // card. It is the ONLY signal that ever triggers a cooldown — no other path
    // (daily-journal recount, per-family counters, etc.) is allowed to do so.
    const globalStreakCount = recoveryEngine.getState().streakLossCount;
    sessionLossCount = globalStreakCount;

    const daily = buildDailyStats(closedToday, globalStreakCount);
    // Override daily.profit with the resolved value (Deriv journal when available)
    daily.profit = resolvedDailyProfit;
    const todayProfit = resolvedDailyProfit;

    // Hard stops — only triggered by Deriv-verified P&L and loss streak.
    if (todayProfit <= -tradingSettings.dailyLossLimit) { stopEngine(`Daily loss limit ${tradingSettings.dailyLossLimit} reached`); return; }
    if (todayProfit >= tradingSettings.dailyTarget) { stopEngine(`Daily target ${tradingSettings.dailyTarget} reached!`); return; }
    // Start-of-loop safety net: if the streak already sits at/above the limit
    // (e.g. engine resumed mid-streak), stop immediately instead of trading first.
    if (globalStreakCount >= tradingSettings.consecutiveLossLimit) {
      const cooldownMins = settings?.cooldownMinutes ?? 30;
      stopEngine(
        `${globalStreakCount} consecutive losses — limit ${tradingSettings.consecutiveLossLimit} reached, cooling down ${cooldownMins}m`,
        cooldownMins,
      );
      return;
    }

    // ── Market selection: parallel tournament scanning ───────────────────────
    // All 4 groups are scanned simultaneously. Each group scans all its markets
    // in parallel and returns the single best candidate (highest qualityScore).
    // The best candidate across all 4 groups is then evaluated for execution.
    // Bull/Bear only participates when CALL/PUT contract types are enabled.
    // If no candidate passes all gates → rescan immediately (no delay).
    const hasDigitTypes = preferredContractTypes.some(t => t.startsWith("DIGIT"));
    const hasDirectionTypes = preferredContractTypes.some(t => ["CALL", "PUT"].includes(t));

    // Build set of symbols currently on per-symbol cooldown so they are excluded
    // from the tournament scan entirely — the engine will find the next-best pair
    // instead of looping on a blocked symbol.
    const symCutoffPre = Date.now() - SAME_SYMBOL_COOLDOWN_MS;
    const cooledDownSymbols = new Set<string>();
    for (const [sym, dates] of recentTradesBySymbol) {
      const recentCount = dates.filter(d => d.getTime() > symCutoffPre).length;
      if (recentCount >= MAX_TRADES_SAME_SYMBOL) cooledDownSymbols.add(sym);
    }
    if (cooledDownSymbols.size > 0) {
      logger.info({ cooledDown: [...cooledDownSymbols] }, "Autonomous: excluding symbols on per-pair cooldown from scan");
    }

    const contractCompatibleMarkets = availableMarkets.filter(m => {
      // Skip symbols that have hit the 2-trades-per-8-min cooldown
      if (cooledDownSymbols.has(m.symbol)) return false;
      // Skip non-digit markets when only digit contract types are enabled
      if (hasDigitTypes && !hasDirectionTypes && !m.digitEnabled) return false;
      // Bull/Bear (RDBULL/RDBEAR) support both direction AND digit contracts
      // (Over/Under, Even/Odd, Match/Differ) — skip only if neither is enabled.
      if ((m.symbol === "RDBULL" || m.symbol === "RDBEAR") && !hasDirectionTypes && !hasDigitTypes) return false;
      return true;
    });

    // ── Contract family type definitions (hoisted so recovery fast path can use them) ──
    const dirTypes = preferredContractTypes.filter(t => ["CALL", "PUT"].includes(t));
    const ouTypes  = preferredContractTypes.filter(t => ["DIGITOVER", "DIGITUNDER"].includes(t));
    const eoTypes  = preferredContractTypes.filter(t => ["DIGITEVEN", "DIGITODD"].includes(t));
    const mdTypes  = preferredContractTypes.filter(t => ["DIGITMATCH", "DIGITDIFF"].includes(t));

    // ── Recovery Fast Path ────────────────────────────────────────────────────────────
    // When in recovery mode, skip the full 8-agent tournament entirely. Instead, run a
    // fast 3-window consensus check (50 / 100 / 150 ticks) on ALL eligible markets in
    // parallel. Execute the recovery trade the instant ALL THREE windows agree — this
    // eliminates the 30+ min delays caused by quality floors, regime gates, and multi-
    // family tournament scoring in the normal path.
    //
    // Contract types: only the user's enabled recovery types (no switching).
    // Markets: the same contractCompatibleMarkets as the normal path (no switching).
    // Barriers: user's recoveryOverDigit / recoveryUnderDigit (no overrides).
    if (recoveryEngine.isInRecovery()) {
      // ── Open-trade guard ──────────────────────────────────────────────────────────
      const recovOpenTrades = await db.select().from(tradesTable).where(and(eq(tradesTable.sessionId, sessionId), eq(tradesTable.status, "open")));
      if (recovOpenTrades.length > 0) {
        const nowMs = Date.now();
        const stale = recovOpenTrades.filter(t => nowMs - new Date(t.createdAt).getTime() > STALE_OPEN_MS);
        if (stale.length > 0) {
          await Promise.all(stale.map(t =>
            db.update(tradesTable).set({
              status: "error", profit: "0", payout: "0", closedAt: new Date(),
              agentReasoning: `${t.agentReasoning ?? ""} [AUTO-RECOVERED: stale open trade]`,
            }).where(eq(tradesTable.id, t.id)).catch(() => {}),
          ));
        }
        const fresh = recovOpenTrades.filter(t => nowMs - new Date(t.createdAt).getTime() <= STALE_OPEN_MS);
        if (fresh.length > 0) { scheduleNext(false); return; }
      }

      // ── Journal-settle delay ──────────────────────────────────────────────────────
      if (lastTradeCompletedAt && (Date.now() - lastTradeCompletedAt.getTime()) < 12_000) {
        scheduleNext(false, 3000);
        return;
      }

      // ── Per-symbol cooldown check on all markets ──────────────────────────────────
      // (cooledDownSymbols already populated above from recentTradesBySymbol)

      // ── Build recovery contract type list ─────────────────────────────────────────
      // MATCH/DIFF strategy: DIGITMATCH in early recovery (high payout recovers debt fast),
      // DIGITDIFF after 3 consecutive MATCH losses (near-certain partial recovery).
      const consecutiveMatchLosses = recoveryEngine.getState().consecutiveMatchLosses;
      const recoveryTypes: string[] = [...ouTypes, ...eoTypes, ...dirTypes];
      if (mdTypes.length > 0) {
        if (mdTypes.includes("DIGITMATCH") && consecutiveMatchLosses < 3) {
          recoveryTypes.push("DIGITMATCH");
        } else if (mdTypes.includes("DIGITDIFF")) {
          recoveryTypes.push("DIGITDIFF");
        } else {
          recoveryTypes.push(...mdTypes);
        }
      }

      if (recoveryTypes.length === 0) {
        logger.warn("Recovery: no recovery contract types configured — falling back to normal scan");
        // Fall through to normal tournament
      } else {
        // ── 3-window consensus scan across all eligible markets ───────────────────
        broadcastEngineSSE("scan_started", { groups: ["Recovery"], ts: Date.now() });

        const consensusInputs = await Promise.all(
          contractCompatibleMarkets.map(async (m) => {
            const marketTypes = recoveryTypes.filter(ct => !ct.startsWith("DIGIT") || m.digitEnabled);
            if (marketTypes.length === 0) return { symbol: m.symbol, market: m, results: [] };
            const digits = m.digitEnabled ? tickManager.getDigits(m.symbol, 150) : [];
            const prices = tickManager.getTicks(m.symbol, 150);
            const results = runRecoveryConsensus(
              digits, prices, marketTypes,
              tradingSettings.recoveryOverDigit, tradingSettings.recoveryUnderDigit,
            );
            return { symbol: m.symbol, market: m, results };
          }),
        );

        const winner = getBestConsensus(consensusInputs);

        if (!winner) {
          logger.info({ marketsScanned: contractCompatibleMarkets.length, types: recoveryTypes },
            "Recovery: 3-window consensus not yet reached — rescanning in 3s");
          broadcastEngineSSE("scan_complete", {
            symbol: null, quality: 0, confidence: 0, agentScores: lastAgentScores,
            marketsScanned: contractCompatibleMarkets.length, shouldTrade: false,
            rejectReason: "recovery_no_consensus", sessionLossCount,
            consecutiveLossLimit: tradingSettings.consecutiveLossLimit,
          });
          scheduleNext(false, 3000);
          return;
        }

        const { symbol: recovSymbol, market: recovMarket, result: cons } = winner;

        // Per-symbol cooldown safety net (symbols already filtered in contractCompatibleMarkets,
        // but guard against the rare mid-scan race where the cooldown was just reached)
        const recovSymHist = recentTradesBySymbol.get(recovSymbol) ?? [];
        if (recovSymHist.filter(d => d.getTime() > Date.now() - SAME_SYMBOL_COOLDOWN_MS).length >= MAX_TRADES_SAME_SYMBOL) {
          logger.info({ symbol: recovSymbol }, "Recovery: symbol just hit cooldown — rescanning");
          scheduleNext(false, 500);
          return;
        }

        const recovContractType = cons.contractType;
        const recovBarrier      = cons.barrier;
        const recovWinP         = cons.avgWinProbability;
        const recovDirection    = recovContractType === "CALL" ? "up"
          : recovContractType === "PUT" ? "down" : "hold";
        const rawDur = tradingSettings.tradeDurationSec ?? 5;
        const recovDuration = (recovContractType === "DIGITEVEN" || recovContractType === "DIGITODD")
          ? Math.max(5, rawDur)
          : (recovContractType === "DIGITMATCH" || recovContractType === "DIGITDIFF")
            ? Math.max(1, Math.min(5, rawDur))
            : rawDur;

        // Price the exact candidate immediately before sizing it. Live proposal
        // wins; the canonical user-provided payout schedule is the fallback.
        const recovPayoutQuote = await resolveRecoveryPayout({
          symbol: recovSymbol,
          contractType: recovContractType,
          barrier: recovBarrier,
          duration: recovDuration,
          durationUnit: "t",
          currency: account?.currency ?? "USD",
        });
        const recovPayoutMult = recovPayoutQuote.payoutMultiplier;

        // Recovery stake — sizes from remaining debt plus an optional original
        // target profit (sizing only) and this candidate's net live payout.
        const riskBaseAmount = tradingSettings.riskAmountType === "percentage"
          ? balance * tradingSettings.riskAmountValue / 100
          : tradingSettings.riskAmountValue;
        const recovStakeRaw = recoveryEngine.getDynamicRecoveryStake(
          Math.max(0.35, Math.min(riskBaseAmount, tradingSettings.maxTradeStake)),
          tradingSettings.maxTradeStake, balance, recovPayoutMult, recovWinP,
          tradingSettings.riskProfile, tradingSettings.recoveryMultiplier,
          tradingSettings.recoveryMethod, tradingSettings.maxRecoverySteps,
          tradingSettings.recoveryAutoMode,
        );
        // The recovery engine already rounds upward to cents; do not round back
        // down here or an "exact" instant stake can finish a cent short.
        const recovStake = Math.max(0.35, Math.min(recovStakeRaw, tradingSettings.maxTradeStake));

        const recovBarrierToStore = recovContractType.includes("DIGIT") ? (recovBarrier ?? null) : null;

        logger.info({
          symbol: recovSymbol, contractType: recovContractType, barrier: recovBarrier,
          stake: recovStake, winP: (recovWinP * 100).toFixed(1) + "%",
          payout: recovPayoutMult, payoutSource: recovPayoutQuote.source, reason: cons.reason,
        }, "Recovery: 3-window consensus reached — executing recovery trade");

        broadcastEngineSSE("scan_complete", {
          symbol: recovSymbol,
          quality: Math.min(99, Math.round(cons.avgStrength * 200 + 60)),
          confidence: Math.round(recovWinP * 100),
          agentScores: lastAgentScores,
          marketsScanned: contractCompatibleMarkets.length,
          shouldTrade: true, rejectReason: null, sessionLossCount,
          consecutiveLossLimit: tradingSettings.consecutiveLossLimit,
        });

        currentMarket = recovSymbol;

        // ── Execute recovery trade (paper or live) ────────────────────────────────
        const estimatedRecovPayout = recovStake * recovPayoutMult;
        let rWon: boolean, rProfit: number, rEntryPrice: number, rExitPrice: number, rActualPayout: number;

        if (paperTradeMode || !token) {
          rWon = Math.random() < recovWinP;
          rProfit = rWon ? estimatedRecovPayout - recovStake : -recovStake;
          rActualPayout = rWon ? estimatedRecovPayout : 0;
          rEntryPrice = rExitPrice = tickManager.getLatestPrice(recovSymbol) ?? 100;

          recordTradeOutcome(recovSymbol, recovContractType, recovBarrier ?? null, rWon, rProfit, recovStake);
          recoveryEngine.recordOutcome(
            rWon, rProfit, recovStake, settings?.maxRecoverySteps ?? 3,
            recovContractType, recovPayoutMult,
          );
          if (rWon) clearLossPattern(recovSymbol); else recordLossForPattern(recovSymbol, recovContractType, "");

          await db.insert(tradesTable).values({
            sessionId,
            symbol: recovSymbol, displayName: recovMarket.displayName,
            contractType: recovContractType, barrier: recovBarrierToStore,
            stake: String(recovStake), direction: recovDirection,
            status: rWon ? "won" : "lost",
            payout: String(rActualPayout), profit: String(rProfit),
            entryPrice: String(rEntryPrice), exitPrice: String(rExitPrice),
            aiConfidence: String(Math.round(recovWinP * 100)), aiRiskScore: "65",
            isAutonomous: true,
            agentReasoning: `[PAPER RECOVERY] 3-window consensus: ${cons.reason}`,
            duration: recovDuration, durationUnit: "t", closedAt: new Date(),
          });
        } else {
          const [openTrade] = await db.insert(tradesTable).values({
            sessionId,
            symbol: recovSymbol, displayName: recovMarket.displayName,
            contractType: recovContractType, barrier: recovBarrierToStore,
            stake: String(recovStake), direction: recovDirection, status: "open",
            aiConfidence: String(Math.round(recovWinP * 100)), aiRiskScore: "65",
            isAutonomous: true,
            agentReasoning: `[RECOVERY] 3-window consensus: ${cons.reason}`,
            duration: recovDuration, durationUnit: "t",
          }).returning();

          broadcastEngineSSE("trade_started", {
            id: openTrade.id, symbol: recovSymbol, contract: recovContractType,
            barrier: recovBarrierToStore, stake: recovStake, duration: recovDuration,
            confidence: Math.round(recovWinP * 100),
          });

          try {
            if (!isAutomatedMarket(recovSymbol)) {
              throw new Error(`${recovMarket.displayName} is blocked from autonomous recovery execution`);
            }
            const liveRes = await executeLiveTrade(token, {
              symbol: recovSymbol, contractType: recovContractType,
              stake: Math.round(recovStake * 100) / 100,
              duration: recovDuration, durationUnit: "t",
              currency: account?.currency ?? "USD",
              accountId: derivAccountId!,
              barrier: recovContractType.includes("DIGIT") ? (recovBarrier ?? undefined) : undefined,
            });
            rEntryPrice = liveRes.buyPrice;
            const contractRes = await waitForContractResult(token, derivAccountId!, liveRes.contractId, (recovDuration + 30) * 1000);
            rWon = contractRes.won;
            rProfit = contractRes.profit;
            rActualPayout = rWon ? recovStake + rProfit : 0;
            rEntryPrice = contractRes.entrySpot || liveRes.buyPrice;
            rExitPrice  = contractRes.exitSpot  || rEntryPrice;
            await syncLiveBalance(sessionId, token, derivAccountId!);
          } catch (liveErr) {
            const errMsg = liveErr instanceof Error ? liveErr.message : String(liveErr);
            logger.warn({ errMsg, symbol: recovSymbol }, "Recovery live trade failed — marking as error");
            try {
              await db.update(tradesTable).set({
                status: "error", profit: "0", payout: "0", closedAt: new Date(),
                agentReasoning: `[RECOVERY] ${cons.reason} [FAILED: ${errMsg}]`,
              }).where(eq(tradesTable.id, openTrade.id));
            } catch { /* ignore */ }
            broadcastEngineSSE("trade_completed", {
              id: openTrade.id, symbol: recovSymbol, won: false, profit: "0",
              contract: recovContractType, error: errMsg,
            });
            lastTradeCompletedAt = new Date();
            const slErr = recentTradesBySymbol.get(recovSymbol) ?? [];
            slErr.push(new Date());
            recentTradesBySymbol.set(recovSymbol, slErr.filter(d => d.getTime() > Date.now() - SAME_SYMBOL_COOLDOWN_MS));
            scheduleNext(true);
            return;
          }

          recordTradeOutcome(recovSymbol, recovContractType, recovBarrier ?? null, rWon, rProfit, recovStake);
          recoveryEngine.recordOutcome(
            rWon, rProfit, recovStake, settings?.maxRecoverySteps ?? 3,
            recovContractType, recovPayoutMult,
          );
          if (rWon) clearLossPattern(recovSymbol); else recordLossForPattern(recovSymbol, recovContractType, "");

          await db.update(tradesTable).set({
            status: rWon ? "won" : "lost",
            payout: String(rActualPayout), profit: String(rProfit),
            entryPrice: String(rEntryPrice), exitPrice: String(rExitPrice),
            closedAt: new Date(),
          }).where(eq(tradesTable.id, openTrade.id));
        }

        // ── Post-recovery bookkeeping ──────────────────────────────────────────────
        const rNow = new Date();
        const rSymLog = recentTradesBySymbol.get(recovSymbol) ?? [];
        rSymLog.push(rNow);
        recentTradesBySymbol.set(recovSymbol, rSymLog.filter(d => d.getTime() > Date.now() - SAME_SYMBOL_COOLDOWN_MS));
        lastTradeCompletedAt = rNow;
        sessionLossCount = recoveryEngine.getState().streakLossCount;
        tradesExecutedToday++;
        lastTradeTime = rNow;

        broadcastEngineSSE("trade_completed", {
          symbol: recovSymbol, won: rWon!, profit: rProfit!.toFixed(2),
          contract: recovContractType, barrier: recovBarrierToStore, stake: recovStake,
          live: !!token && !paperTradeMode, paper: paperTradeMode,
        });
        if (!paperTradeMode && token) journalManager.forceRefresh();

        logger.info({
          symbol: recovSymbol, won: rWon!, profit: rProfit!.toFixed(2),
          stake: recovStake, contract: recovContractType,
        }, "Recovery trade executed");

        if (!rWon! && engineRunning) {
          const freshS = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, sessionId)).limit(1);
          const hardLimit   = freshS[0]?.consecutiveLossLimit ?? 3;
          const cooldownMin = freshS[0]?.cooldownMinutes ?? 30;
          if (sessionLossCount >= hardLimit) {
            stopEngine(`${sessionLossCount} consecutive losses — limit ${hardLimit} reached, cooling down ${cooldownMin}m`, cooldownMin);
            return;
          }
        }

        scheduleNext(true);
        return;
        // ── End of recovery fast path ──────────────────────────────────────────────
      }
    }

    const getGroupIndex = (sym: string): number => {
      if (sym.startsWith("1HZ")) return 0; // Volatility 1s (5 markets)
      if (sym.startsWith("R_"))  return 1; // Volatility     (5 markets)
      if (sym.startsWith("JD"))  return 2; // Jump Indices   (5 markets)
      return 3;                             // Bull/Bear      (2 markets)
    };
    // Bucket markets into their 4 groups
    const marketGroups: (typeof contractCompatibleMarkets)[] = [[], [], [], []];
    for (const m of contractCompatibleMarkets) marketGroups[getGroupIndex(m.symbol)].push(m);

    let totalMarketsScanned = 0;
    const SCAN_TIMEOUT_MS = 4000;
    const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

    type ScanResult = { market: typeof availableMarkets[0]; output: Awaited<ReturnType<typeof runCoordinator>>; ctx: ScanContext; family: string };

    // ── Contract family definitions (already defined above for recovery fast path) ──
    // dirTypes, ouTypes, eoTypes, mdTypes are defined before the recovery fast path
    // so both the recovery path and the normal tournament path can use them.

    // ── Phase 1: All 4 groups scan in PARALLEL, but each group scans
    //    ONLY ONE market per iteration — the one at its cursor position.
    //
    //    Canonical scan order per group (determined by DERIV_MARKETS array):
    //      Volatility 1s : 1HZ10V → 1HZ15V → 1HZ25V → 1HZ30V → 1HZ50V → 1HZ75V → 1HZ90V → 1HZ100V → wrap
    //      Volatility    : R_10    → R_25    → R_50    → R_75    → R_100    → wrap
    //      Jump Indices  : JD10   → JD25   → JD50   → JD75   → wrap (JD100 is manual-only)
    //      Bull/Bear     : RDBULL → RDBEAR → wrap
    //
    //    No market is revisited until every market in its group has been
    //    scanned once. Cursor advances BEFORE awaiting so groups never
    //    block each other. Only enabled contract families are run per market.
    broadcastEngineSSE("scan_started", { groups: GROUP_NAMES.filter((_, i) => marketGroups[i].length > 0), ts: Date.now() });

    const groupWinners = (await Promise.allSettled(
      marketGroups.map(async (group, gi): Promise<(ScanResult & { groupName: string }) | null> => {
        if (group.length === 0) return null;

        // Scan ALL markets in this group in parallel — pick the best opportunity
        // across the whole group rather than using a single cursor position.
        type MarketResult = ScanResult & { allFamilyResults: ScanResult[] };
        const allMarketResults = (await Promise.allSettled(
          group.map(async (m): Promise<MarketResult | null> => {
            try {
              const isBullBear = m.symbol === "RDBULL" || m.symbol === "RDBEAR";

              // Only run families whose contract types are enabled in settings.
              const families: Array<{ name: string; types: string[] }> = [];
              if (dirTypes.length > 0)                                  families.push({ name: "direction", types: dirTypes });
              // Bull/Bear markets (RDBULL/RDBEAR) fully support digit contracts — allow all digit families
              if (m.digitEnabled && ouTypes.length > 0)  families.push({ name: "overunder", types: ouTypes });
              if (m.digitEnabled && eoTypes.length > 0)  families.push({ name: "evenodd",   types: eoTypes });
              if (m.digitEnabled && mdTypes.length > 0) {
                // Strategy:
                //   Normal mode  → DIGITDIFF (coldest digit, high win rate, 1.09× fallback payout)
                //   Recovery 1–2 → DIGITMATCH (hottest digit, 8.93× payout — tiny stake covers full DIFF loss)
                //   Recovery 3+  → DIGITDIFF  (2 consecutive MATCH losses means MATCH isn't hitting;
                //                              fall back to DIFF so the debt can still be recovered)
                // If the user only enabled one of the two, use whichever is enabled.
                const inRecovery = recoveryEngine.isInRecovery();
                const consecutiveMatchLosses = recoveryEngine.getState().consecutiveMatchLosses;
                // Allow up to 3 consecutive MATCH losses before falling back to DIFF.
                // 3 attempts gives the high-payout MATCH contract enough chances to fire
                // (each attempt independently has ~10–15 % win probability); after 3
                // misses the engine switches to DIFF which wins ~96 % of the time to
                // at least partially rebuild the balance before retrying MATCH.
                const matchFallbackToDiff = inRecovery && consecutiveMatchLosses >= 3;
                const activeMdTypes = (inRecovery && !matchFallbackToDiff && mdTypes.includes("DIGITMATCH"))
                  ? ["DIGITMATCH"]   // recovery attempt 1–3: high payout covers full DIFF loss cheaply
                  : mdTypes.includes("DIGITDIFF")
                    ? ["DIGITDIFF"]  // normal mode OR match-fallback: near-certain wins on cold digit
                    : mdTypes;       // fallback: whatever the user enabled
                families.push({ name: "matchdiff", types: activeMdTypes });
              }

              if (families.length === 0) return null;

              const baseCtx = buildScanContext(m, balance, tradingSettings, daily, null, account?.currency ?? "USD");

              const familyResults = (await Promise.allSettled(
                families.map(async (fam) => {
                  // Over/Under always trades the EXACT settings-configured digit pair
                  // (normal or recovery, chosen once per loop iteration above) — no
                  // AI-driven candidate scanning, no hardcoded barriers.
                  const famCtx: ScanContext = {
                    ...baseCtx,
                    settings: {
                      ...baseCtx.settings,
                      preferredContractTypes: fam.types,
                      // Even/odd contracts are inherently near-50/50 so the Markov-edge signal
                      // never reaches the same confidence scores as direction or digit-barrier
                      // agents. Always lower the threshold for this family regardless of what
                      // other families are also active so Even/Odd gets a fair shot in the
                      // tournament when multiple markets are enabled simultaneously.
                      minConfidenceThreshold:
                        fam.name === "evenodd"
                          ? Math.min(baseCtx.settings.minConfidenceThreshold ?? 38, 48)
                          // DIGITMATCH: 8.93× payout but only ~10-15% win rate → agent scores are
                          // naturally lower. Lower the threshold so the EV gate (not confidence)
                          // does the real filtering; master-decision already requires positive EV.
                          // DIGITDIFF: ~96% win rate but low payout → scores may vary; keep same floor.
                          : fam.name === "matchdiff"
                            ? Math.min(baseCtx.settings.minConfidenceThreshold ?? 38, 45)
                            // OVER/UNDER: safe low-payout barriers have naturally lower agent scores
                            // because their "edge" vs breakeven is always negative in near-uniform
                            // markets. Cap at 48 (same as evenodd) so the EV gate and digit skew
                            // do the real filtering, not an artificially high consensus threshold.
                            : fam.name === "overunder"
                              ? Math.min(baseCtx.settings.minConfidenceThreshold ?? 38, 48)
                              : baseCtx.settings.minConfidenceThreshold,
                    },
                    recoveryBarrierOverride: fam.name === "overunder" ? activeBarrierOverride : undefined,
                  };
                  const output = await withTimeout(runCoordinator(famCtx), SCAN_TIMEOUT_MS, null as any);
                  if (!output) return null;
                  return { market: m, output, ctx: famCtx, family: fam.name } as ScanResult;
                })
              )).flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : []);

              if (familyResults.length === 0) return null;

              totalMarketsScanned++;

              const tradeableFamilies = familyResults.filter(r => r.output.shouldTrade);
              const marketBest = tradeableFamilies.length > 0
                ? tradeableFamilies.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0]
                : familyResults.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0];

              return { ...marketBest, allFamilyResults: familyResults };
            } catch { return null; }
          })
        )).flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : []);

        if (allMarketResults.length === 0) return null;

        // Among all markets in this group, prefer tradeable then highest qualityScore.
        const tradeableMarkets = allMarketResults.filter(r => r.output.shouldTrade);
        const groupBest = tradeableMarkets.length > 0
          ? tradeableMarkets.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0]
          : allMarketResults.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0];

        logger.info({
          group: GROUP_NAMES[gi],
          marketsScanned: allMarketResults.length,
          tradeableCount: tradeableMarkets.length,
          bestSymbol: groupBest.market.symbol,
          family: groupBest.family,
          quality: groupBest.output.qualityScore,
          shouldTrade: groupBest.output.shouldTrade,
        }, "Group full scan complete");

        const allFamilySummaries = groupBest.allFamilyResults.map(r => ({
          name: r.family,
          contract: r.output.recommendation?.product ?? null,
          shouldTrade: r.output.shouldTrade,
          confidence: Math.round(r.output.confidenceScore),
          quality: Math.round(r.output.qualityScore),
          rejectReason: r.output.rejectReason ?? null,
        }));

        broadcastEngineSSE("group_scanned", {
          group: GROUP_NAMES[gi],
          totalInGroup: group.length,
          scanned: allMarketResults.length,
          bestSymbol: groupBest.market.symbol,
          bestDisplayName: groupBest.market.displayName,
          quality: groupBest.output.qualityScore,
          shouldTrade: groupBest.output.shouldTrade,
          contract: groupBest.output.recommendation?.product ?? null,
          confidence: groupBest.output.confidenceScore,
          family: groupBest.family,
          families: allFamilySummaries,
          rejectReason: groupBest.output.rejectReason ?? null,
        });

        return { ...groupBest, groupName: GROUP_NAMES[gi] };
      })
    )).flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : []);

    // ── Phase 2: Tournament — pick the overall winner ────────────────────────
    // Among tradeable group winners, apply family rotation so Rise/Fall and
    // Even/Odd get executed in turn alongside Over/Under rather than always
    // losing the quality tournament to higher-scoring digit barriers.
    const tradeableWinners = groupWinners.filter(w => w.output.shouldTrade);

    // Determine which families actually have tradeable results this scan
    const enabledFamiliesThisScan = new Set(tradeableWinners.map(w => w.family));
    const multipleFamily = enabledFamiliesThisScan.size > 1;

    // ── Recovery priority ─────────────────────────────────────────────────────
    // Recovery is a SINGLE global state now, independent of contract type — when
    // active, ANY tradeable contract type is eligible to execute the recovery
    // trade (stake sizing via getDynamicRecoveryStake handles the rest), and the
    // highest-confidence opportunity is chosen rather than the highest-quality one.
    const inRecoveryNow = recoveryEngine.isInRecovery();

    // When multiple families are active and NOT in recovery, narrow the pool to
    // the scheduled family so each family gets executed roughly in turn.
    let tournamentPool = tradeableWinners;
    if (!inRecoveryNow && multipleFamily && scheduledFamilyHint && enabledFamiliesThisScan.has(scheduledFamilyHint)) {
      const hinted = tradeableWinners.filter(w => w.family === scheduledFamilyHint);
      if (hinted.length > 0) tournamentPool = hinted;
    }

    const bestResult: (ScanResult & { groupName: string }) | null = tournamentPool.length > 0
      ? (inRecoveryNow
          // In recovery: execute the highest-confidence opportunity across ALL families.
          ? tournamentPool.sort((a, b) => b.output.confidenceScore - a.output.confidenceScore)[0]
          : tournamentPool.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0])
      : null;

    if (bestResult) {
      logger.info({
        symbol: bestResult.market.symbol,
        group: bestResult.groupName,
        quality: bestResult.output.qualityScore,
        groupsScanned: groupWinners.length,
        marketsScanned: totalMarketsScanned,
      }, "Tournament winner — executing");
    } else {
      logger.info({ groupsScanned: groupWinners.length, marketsScanned: totalMarketsScanned }, "No qualifying opportunity across all groups — rescanning");
      scheduleNext(false, 500); // Near-instant rescan
      return;
    }

    const { market: bestMarket, output } = bestResult;
    // Rebuild ctx with real token for live trade execution (scan used null for speed).
    // Carry recoveryBarrierOverride so any post-tournament coordinator/master-decision
    // call still sees the correct normal-vs-recovery barrier pair rather than falling
    // back to the ALLOWED_BARRIERS constant default.
    const ctx = {
      ...buildScanContext(bestMarket, balance, tradingSettings, daily, token, account?.currency ?? "USD"),
      recoveryBarrierOverride: activeBarrierOverride,
    };
    currentMarket = bestMarket.symbol;

    // ── Guard: block if there is already an open/in-progress trade ───────────
    // Stale "open" trades (> 2 minutes old) are auto-recovered as "error" so
    // they never permanently freeze the loop. This handles the crash path where
    // executeLiveTrade OR waitForContractResult threw after the DB insert but
    // before the status update — leaving a ghost trade that blocked the engine
    // indefinitely (the engine keeps finding the ghost every 3s and backing off).
    // STALE_OPEN_MS is defined at module scope above
    const openTrades = await db.select().from(tradesTable).where(and(eq(tradesTable.sessionId, sessionId), eq(tradesTable.status, "open")));
    if (openTrades.length > 0) {
      const now = Date.now();
      const staleTrades = openTrades.filter(t => now - new Date(t.createdAt).getTime() > STALE_OPEN_MS);
      if (staleTrades.length > 0) {
        logger.warn(
          { staleIds: staleTrades.map(t => t.id), ages: staleTrades.map(t => Math.round((now - new Date(t.createdAt).getTime()) / 1000) + "s") },
          "Autonomous: auto-recovering stale open trades — settlement result unknown, marking as error",
        );
        await Promise.all(
          staleTrades.map(t =>
            db.update(tradesTable)
              .set({ status: "error", profit: "0", payout: "0", closedAt: new Date(),
                     agentReasoning: `${t.agentReasoning ?? ""} [AUTO-RECOVERED: trade left open after crash — settlement unknown]` })
              .where(eq(tradesTable.id, t.id))
              .catch(dbErr => logger.error({ dbErr, tradeId: t.id }, "Failed to auto-recover stale open trade")),
          ),
        );
      }
      const freshTrades = openTrades.filter(t => now - new Date(t.createdAt).getTime() <= STALE_OPEN_MS);
      if (freshTrades.length > 0) {
        logger.info({ openCount: freshTrades.length }, "Autonomous: open trade in progress — waiting before next scan");
        scheduleNext(false);
        return;
      }
      // All open trades were stale and have been cleared — fall through and continue
    }

    // ── Guard: require minimum time since last trade settled ─────────────────
    // Ensures the Deriv journal has time to record the closed trade before we start
    // the next scan. This prevents the engine from opening a second trade while the
    // first is still being journalled on Deriv's side.
    if (lastTradeCompletedAt && (Date.now() - lastTradeCompletedAt.getTime()) < 12_000) {
      logger.info({ msAgo: Date.now() - lastTradeCompletedAt.getTime() }, "Autonomous: journal settle delay — waiting 3s");
      scheduleNext(false, 3000);
      return;
    }

    // ── Guard: per-symbol cooldown (max 2 trades per pair per 8 min) ─────────
    // Note: symbols already on cooldown are filtered out of the scan above so
    // the tournament winner should never be on cooldown. This guard is a safety
    // net for the rare edge case where the cooldown was reached mid-scan.
    const symHistory = recentTradesBySymbol.get(bestMarket.symbol) ?? [];
    const symCutoff = Date.now() - SAME_SYMBOL_COOLDOWN_MS;
    const symRecentCount = symHistory.filter(d => d.getTime() > symCutoff).length;
    if (symRecentCount >= MAX_TRADES_SAME_SYMBOL) {
      logger.info({ symbol: bestMarket.symbol, recentCount: symRecentCount },
        "Autonomous: symbol cooldown guard triggered mid-scan — rescanning for next-best pair");
      scheduleNext(false, 500);
      return;
    }

    // Build legacy analysis for backward-compat fields
    const analysis = buildLegacyAnalysis(output);

    // Update agent scores
    const agentOutputs = output.agents;
    lastAgentScores = Object.fromEntries(
      AGENT_SCORE_KEYS.map((k) => [k, agentOutputs[k]?.score ?? 65])
    );

    broadcastEngineSSE("scan_complete", {
      symbol: bestMarket.symbol,
      quality: output.qualityScore,
      confidence: output.confidenceScore,
      agentScores: lastAgentScores,
      marketsScanned: totalMarketsScanned,
      regime: output.regime,
      shouldTrade: output.shouldTrade,
      rejectReason: output.rejectReason,
      sessionLossCount,
      consecutiveLossLimit: tradingSettings.consecutiveLossLimit,
    });

    if (!output.shouldTrade) {
      logger.info({
        symbol: bestMarket.symbol,
        quality: output.qualityScore,
        reason: output.rejectReason,
      }, "Conditions not favourable — scanning next");

      // Track the rejected trade so the Missed Opportunity Agent can evaluate it
      const rejectedRec = output.recommendation;
      trackRejectedTrade({
        symbol:       bestMarket.symbol,
        contractType: rejectedRec.product,
        barrier:      rejectedRec.barrier ?? null,
        rejectReason: output.rejectReason,
        output,
        duration:     rejectedRec.duration ?? 5,
        stake:        rejectedRec.stake,
      });

      scheduleNext(false);
      return;
    }

    // ── Absolute quality floor ────────────────────────────────────────────────
    // Even when shouldTrade is true, skip the cycle if the tournament winner's
    // quality score is below the floor. A score that low means the agents collectively
    // have borderline confidence — the engine is reaching for a marginal trade
    // rather than a genuinely strong setup. Waiting costs nothing; a bad trade costs real money.
    //
    // During active recovery the floor is relaxed to 50: the master-decision EV,
    // timing, and risk gates already guard execution quality. Keeping the normal
    // 60-pt floor in recovery mode causes the engine to repeatedly skip the very
    // trades it needs to execute to cover the accumulated debt — defeating the purpose
    // of the recovery system entirely.
    const isOverUnderTrade = output.recommendation?.product === "DIGITOVER" ||
      output.recommendation?.product === "DIGITUNDER";
    const qualityFloor = isOverUnderTrade ? 0 : (inRecoveryNow ? 50 : 60);
    if (output.qualityScore < qualityFloor) {
      logger.info({ symbol: bestMarket.symbol, quality: output.qualityScore, inRecovery: inRecoveryNow },
        `Quality floor not met (< ${qualityFloor}) — holding off this scan cycle`);
      scheduleNext(false, 500);
      return;
    }

    // ── Advance family rotation hint for the NEXT scan ───────────────────────
    {
      const allEnabledFamilies = [
        ...(dirTypes.length > 0 ? ["direction"] : []),
        ...(ouTypes.length > 0 ? ["overunder"] : []),
        ...(eoTypes.length > 0 ? ["evenodd"] : []),
        ...(mdTypes.length > 0 ? ["matchdiff"] : []),
      ];
      if (allEnabledFamilies.length > 1) {
        const currentIdx = allEnabledFamilies.indexOf(bestResult.family);
        scheduledFamilyHint = allEnabledFamilies[(currentIdx + 1) % allEnabledFamilies.length];
      } else {
        scheduledFamilyHint = null;
      }
    }

    // ── Trade execution ──────────────────────────────────────────────────────
    const rec = output.recommendation;
    const effectiveContractType = rec.product;
    const effectiveBarrier = rec.barrier;
    // Enforce minimum 5 ticks for DIGITEVEN/DIGITODD — Deriv rejects < 5t for these types.
    // Enforce exactly 5 ticks for DIGITMATCH/DIGITDIFF — these settle on the LAST digit so
    // longer durations add time exposure without improving accuracy. The Markov analysis
    // predicts the next digit distribution; capping at 5t keeps execution tight and accurate.
    const rawDuration = rec.duration ?? 5;
    const duration = (effectiveContractType === "DIGITEVEN" || effectiveContractType === "DIGITODD")
      ? Math.max(5, rawDuration)                          // Deriv minimum 5t for Even/Odd
      : (effectiveContractType === "DIGITMATCH" || effectiveContractType === "DIGITDIFF")
        ? Math.max(1, Math.min(5, rawDuration))           // 1–5t: duration optimizer chooses; never >5 (extra exposure)
        : rawDuration;

    // ── Fix 7: Regime gate on digit recovery trades ───────────────────────────
    // Digit contracts (OVER/UNDER/EVEN/ODD/MATCH/DIFF) assume the terminal digit
    // is drawn from a roughly uniform distribution. In a trending regime this
    // assumption breaks — directional price momentum skews which digits appear at
    // expiry. Executing digit recovery trades in a trend compounds debt rather
    // than recovering it. Hold and rescan in 8s when regime may have normalised.
    if (recoveryEngine.isInRecovery() &&
        effectiveContractType.startsWith("DIGIT") &&
        effectiveContractType !== "DIGITOVER" &&
        effectiveContractType !== "DIGITUNDER") {
      const regime = output.regime;
      if (regime === "trending_up" || regime === "trending_down") {
        logger.info({ symbol: bestMarket.symbol, regime, contractType: effectiveContractType },
          "Recovery: digit trade blocked in trending regime — rescanning in 8s");
        scheduleNext(false, 8000);
        return;
      }
    }

    // ── Recovery Mode stake override ─────────────────────────────────────────
    // Single global recovery state — ANY tracked contract type uses the exact
    // same dynamic-stake formula (minimum stake needed to recover the accumulated
    // loss, adjusted for this trade's own payout and win probability).
    const isTracked = recoveryEngine.isTrackedContract(effectiveContractType);
    let effectivePayoutMultiplier = rec.payoutMultiplier;
    if (isTracked) {
      const payoutQuote = await resolveRecoveryPayout({
        symbol: bestMarket.symbol,
        contractType: effectiveContractType,
        barrier: effectiveBarrier,
        duration,
        durationUnit: "t",
        currency: account?.currency ?? "USD",
      });
      // Preserve an already-live coordinator quote if the dedicated quote timed
      // out; otherwise prefer the freshest proposal obtained immediately here.
      if (payoutQuote.source === "live" || !Number.isFinite(effectivePayoutMultiplier) || effectivePayoutMultiplier <= 1) {
        effectivePayoutMultiplier = payoutQuote.payoutMultiplier;
      }
    }

    let stake = rec.stake;
    if (isTracked && recoveryEngine.isInRecovery()) {
      stake = recoveryEngine.getDynamicRecoveryStake(
        rec.stake,
        tradingSettings.maxTradeStake,
        balance,
        effectivePayoutMultiplier,
        rec.winProbability / 100,
        tradingSettings.riskProfile,
        tradingSettings.recoveryMultiplier,
        tradingSettings.recoveryMethod,
        tradingSettings.maxRecoverySteps,
        tradingSettings.recoveryAutoMode,
      );
    }

    // Estimated payout for paper trades (live payout comes from Deriv result)
    const estimatedPayout = stake * effectivePayoutMultiplier;
    const barrierToStore = effectiveContractType.includes("DIGIT") ? (effectiveBarrier ?? null) : null;

    let won: boolean, profit: number, entryPrice: number, exitPrice: number;
    // Actual payout settled (set after trade outcome known)
    let actualPayout: number;

    if (paperTradeMode || !token) {
      const winProb = rec.winProbability / 100;
      won = Math.random() < winProb;
      profit = won ? estimatedPayout - stake : -stake;
      actualPayout = won ? estimatedPayout : 0;
      entryPrice = ctx.prices[ctx.prices.length - 1] ?? 100;
      exitPrice = entryPrice;
      logger.info({ symbol: bestMarket.symbol, paper: true, won, ev: analysis.expectedValue }, "Paper trade");

      // Paper trades: insert completed record immediately
      recordTradeOutcome(bestMarket.symbol, effectiveContractType, effectiveBarrier ?? null, won, profit, stake);
      if (isTracked) {
        recoveryEngine.recordOutcome(
          won, profit, stake, settings?.maxRecoverySteps ?? 3,
          effectiveContractType, effectivePayoutMultiplier,
        );
      }
      // Update structural loss pattern detector so the next scan avoids repeating
      // the exact same losing contractType+regime combination.
      if (won) clearLossPattern(bestMarket.symbol);
      else recordLossForPattern(bestMarket.symbol, effectiveContractType, output.regime ?? "");

      const [paperTrade] = await db.insert(tradesTable).values({
        sessionId,
        symbol: bestMarket.symbol,
        displayName: bestMarket.displayName,
        contractType: effectiveContractType,
        barrier: barrierToStore,
        stake: String(stake),
        direction: output.direction,
        status: won ? "won" : "lost",
        payout: String(actualPayout),
        profit: String(profit),
        entryPrice: String(entryPrice),
        exitPrice: String(exitPrice),
        aiConfidence: String(rec.winProbability),
        aiRiskScore: String(output.riskScore),
        isAutonomous: true,
        agentReasoning: `[PAPER] ${output.reasoning}`,
        duration,
        durationUnit: "t",
        closedAt: new Date(),
      }).returning();

      // Fire-and-forget: Trade Intelligence analysis (does not block loop)
      if (paperTrade) {
        analyzeCompletedTrade({
          tradeId: paperTrade.id,
          symbol: bestMarket.symbol,
          contractType: effectiveContractType,
          barrier: effectiveBarrier ?? null,
          stake,
          won,
          profit,
          output,
        }).catch(() => {});
      }
    } else {
      // ── Live trade: insert "open" FIRST so journal shows it immediately ──
      const [openTrade] = await db.insert(tradesTable).values({
        sessionId,
        symbol: bestMarket.symbol,
        displayName: bestMarket.displayName,
        contractType: effectiveContractType,
        barrier: barrierToStore,
        stake: String(stake),
        direction: output.direction,
        status: "open",
        aiConfidence: String(rec.winProbability),
        aiRiskScore: String(output.riskScore),
        isAutonomous: true,
        agentReasoning: output.reasoning,
        duration,
        durationUnit: "t",
      }).returning();

      // Broadcast so journal updates immediately
      broadcastEngineSSE("trade_started", {
        id: openTrade.id,
        symbol: bestMarket.symbol,
        contract: effectiveContractType,
        barrier: barrierToStore,
        stake,
        duration,
        regime: output.regime,
        confidence: rec.winProbability,
        ev: analysis.expectedValue,
      });

      try {
        if (!isAutomatedMarket(bestMarket.symbol)) {
          throw new Error(`${bestMarket.displayName} is blocked from autonomous execution`);
        }
        // Deriv requires stake with max 2 decimal places
        const liveStake = Math.round(stake * 100) / 100;
        const liveResult = await executeLiveTrade(token, {
          symbol: bestMarket.symbol,
          contractType: effectiveContractType,
          stake: liveStake,
          duration,
          durationUnit: "t",
          currency: account?.currency ?? "USD",
          accountId: derivAccountId!,
          barrier: effectiveContractType.includes("DIGIT") ? effectiveBarrier : undefined,
        });
        entryPrice = liveResult.buyPrice;
        // Wait for Deriv to settle the contract — timeout = ticks * 1s + 30s buffer
        const contractResult = await waitForContractResult(token, derivAccountId!, liveResult.contractId, (duration + 30) * 1000);
        won = contractResult.won;
        // Use Deriv's exact profit — this is the ground truth for the journal
        profit = contractResult.profit;
        // Actual payout = stake returned + net profit (only when won; 0 when lost)
        actualPayout = won ? stake + profit : 0;
        entryPrice = contractResult.entrySpot || liveResult.buyPrice;
        // profit_table doesn't expose tick-level exit spot; fall back to entry price for display
        exitPrice = contractResult.exitSpot || entryPrice;
        await syncLiveBalance(sessionId, token, derivAccountId!);
      } catch (liveErr) {
        const errMsg = liveErr instanceof Error ? liveErr.message : String(liveErr);
        logger.warn({ liveErrMsg: errMsg, symbol: bestMarket.symbol, contractType: effectiveContractType }, "Live autonomous trade failed — outcome unknown, marking as error");
        // Mark as "error" (NOT "lost") — Deriv may still settle this contract as a WIN.
        // Marking as "lost" would create a false loss that corrupts consecutive-loss count
        // and daily P&L, causing the engine to falsely trigger loss-streak / loss-limit stops
        // even when the actual Deriv journal shows wins.
        //
        // IMPORTANT: wrap this DB update in its own try/catch. If it throws (DB hiccup,
        // network drop), the exception must NOT propagate to the outer catch — that would
        // leave the trade stuck as "open" permanently and freeze the loop (the stale-trade
        // auto-recovery above handles it if that happens, but preventing it is better).
        try {
          await db.update(tradesTable)
            .set({ status: "error", profit: "0", payout: "0", closedAt: new Date(),
                   agentReasoning: `${output.reasoning} [EXECUTION FAILED: ${errMsg}]` })
            .where(eq(tradesTable.id, openTrade.id));
        } catch (dbErr) {
          logger.error({ dbErr, tradeId: openTrade.id },
            "Failed to mark live trade as error in DB — stale-open guard will auto-recover on next iteration");
        }
        broadcastEngineSSE("trade_completed", { id: openTrade.id, symbol: bestMarket.symbol, won: false,
          profit: "0", contract: effectiveContractType, error: errMsg });
        // No forceRefresh here — the trade never settled on Deriv so the
        // profit_table has nothing new to fetch. Calling it was contributing
        // to the concurrent-pagination rate-limit cascade.

        // Do NOT touch sessionLossCount here — the contract outcome
        // is unknown (Deriv may have settled it as won). Adding a false loss count here
        // is what caused consecutive-loss / daily-limit false-positives.
        // Only record the cooldown timestamp so the engine waits before re-scanning
        // (gives Deriv time to settle the contract before another trade is attempted).
        lastTradeCompletedAt = new Date();
        const symNowErr = new Date();
        const symLogErr = recentTradesBySymbol.get(bestMarket.symbol) ?? [];
        symLogErr.push(symNowErr);
        recentTradesBySymbol.set(bestMarket.symbol, symLogErr.filter(d => d.getTime() > Date.now() - SAME_SYMBOL_COOLDOWN_MS));

        scheduleNext(true);
        return;
      }

      // Update the open record to Deriv-confirmed final status
      recordTradeOutcome(bestMarket.symbol, effectiveContractType, effectiveBarrier ?? null, won, profit, stake);
      if (isTracked) {
        recoveryEngine.recordOutcome(
          won, profit, stake, settings?.maxRecoverySteps ?? 3,
          effectiveContractType, effectivePayoutMultiplier,
        );
      }
      // Update structural loss pattern detector — prevents re-entering the same
      // losing contractType+regime combo back-to-back without a regime change.
      if (won) clearLossPattern(bestMarket.symbol);
      else recordLossForPattern(bestMarket.symbol, effectiveContractType, output.regime ?? "");

      await db.update(tradesTable).set({
        status: won ? "won" : "lost",
        // actualPayout: total returned to account (stake + net profit) when won, 0 when lost
        payout: String(actualPayout),
        // profit: exact net P&L from Deriv (positive on win, negative on loss)
        profit: String(profit),
        entryPrice: String(entryPrice),
        exitPrice: String(exitPrice),
        closedAt: new Date(),
      }).where(eq(tradesTable.id, openTrade.id));

      // Fire-and-forget: Trade Intelligence analysis (does not block loop)
      analyzeCompletedTrade({
        tradeId: openTrade.id,
        symbol: bestMarket.symbol,
        contractType: effectiveContractType,
        barrier: effectiveBarrier ?? null,
        stake,
        won,
        profit,
        output,
      }).catch(() => {});
    }

    // ── Record trade in per-symbol cooldown map ──────────────────────────────
    const symNow = new Date();
    const symLog = recentTradesBySymbol.get(bestMarket.symbol) ?? [];
    symLog.push(symNow);
    // Prune old entries outside the cooldown window
    recentTradesBySymbol.set(bestMarket.symbol, symLog.filter(d => d.getTime() > Date.now() - SAME_SYMBOL_COOLDOWN_MS));

    // ── Mark last-trade timestamp so journal-settle guard works correctly ─────
    lastTradeCompletedAt = symNow;

    // ── Consecutive-loss streak — mirrors the single global source of truth ──
    // recoveryEngine.recordOutcome() (called above) already updated
    // getState().streakLossCount: +1 on loss, reset to 0 on ANY win (even a
    // partial one — only the recovery debt itself persists on partial wins).
    // sessionLossCount is kept only as a display mirror of that same number.
    sessionLossCount = recoveryEngine.getState().streakLossCount;

    // ── Immediate post-loss cooldown gate — THE single trigger path ─────────
    // Checks the exact same counter shown on the dashboard's Recovery card
    // right after every trade settles, so the engine never opens the next
    // trade without first knowing if it should enter cooldown. The start-of-
    // loop check is a secondary safety net using the identical counter.
    if (!won && engineRunning) {
      const freshSettingsForCooldown = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, sessionId)).limit(1);
      const hardLimit = freshSettingsForCooldown[0]?.consecutiveLossLimit ?? 3;
      const cooldownMins = freshSettingsForCooldown[0]?.cooldownMinutes ?? 30;
      if (sessionLossCount >= hardLimit) {
        broadcastEngineSSE("trade_completed", {
          symbol: bestMarket.symbol, won, profit: profit.toFixed(2),
          contract: effectiveContractType,
          barrier: barrierToStore,
          stake,
          live: !!token && !paperTradeMode,
          paper: paperTradeMode,
          ev: analysis.expectedValue,
          regime: output.regime,
        });
        if (!paperTradeMode && token) journalManager.forceRefresh();
        logger.info({
          symbol: bestMarket.symbol, won, profit: profit.toFixed(2),
          stake, ev: analysis.expectedValue, contract: effectiveContractType,
        }, "Trade executed");
        stopEngine(
          `${sessionLossCount} consecutive losses — limit ${hardLimit} reached, cooling down ${cooldownMins}m`,
          cooldownMins,
        );
        tradesExecutedToday++;
        lastTradeTime = new Date();
        return;
      }
    }

    tradesExecutedToday++;
    lastTradeTime = new Date();

    broadcastEngineSSE("trade_completed", {
      symbol: bestMarket.symbol, won, profit: profit.toFixed(2),
      contract: effectiveContractType,
      barrier: barrierToStore,
      stake,
      live: !!token && !paperTradeMode,
      paper: paperTradeMode,
      ev: analysis.expectedValue,
      regime: output.regime,
    });
    // Force-refresh the Deriv journal immediately so dashboard stats update right away
    if (!paperTradeMode && token) journalManager.forceRefresh();
    logger.info({
      symbol: bestMarket.symbol, won, profit: profit.toFixed(2),
      stake, ev: analysis.expectedValue,
      contract: effectiveContractType,
    }, "Trade executed");

  } catch (err) {
    logger.error({ err }, "Autonomous loop error");
  } finally {
    // Always release the lock so the loop can run again
    isLoopRunning = false;
  }

  // After a live trade completes, wait before next scan so Deriv can journal the
  // closed trade. The lastTradeCompletedAt guard inside the loop also enforces this.
  scheduleNext(true);
}

function scheduleNext(tradeExecuted = false, overrideDelayMs?: number) {
  if (!engineRunning) return;
  // Clear any pending timer before scheduling a new one (prevents double-fires)
  if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
  // 15s after a trade (gives Deriv journal time to record the closed trade),
  // 500ms when rescanning for opportunity, 3s between normal scans
  const delayMs = overrideDelayMs ?? (tradeExecuted ? 15_000 : 3000);
  nextScanIn = Math.ceil(delayMs / 1000);
  loopIntervalSec = nextScanIn;
  autonomousTimer = setTimeout(runAutonomousLoop, delayMs);
}

// ── Helper: build recommendation payload for /recommendation route ─────────────
async function buildRecommendationPayload(sessionId: string, symbol: string, market: ReturnType<typeof getMarketInfo>, balance: number, settings: any, preferredContractTypes: string[], token: string | null, currency: string) {
  if (!market) return null;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTrades = await db.select().from(tradesTable).where(and(
    eq(tradesTable.sessionId, sessionId),
    sql`${tradesTable.createdAt} >= ${today}`,
  ));
  const closedToday = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
  const sortedByTime = [...closedToday].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  let consecutiveLosses = 0;
  for (const t of sortedByTime) { if (t.status === "lost") consecutiveLosses++; else break; }

  const tradingSettings = buildTradingSettings(settings, preferredContractTypes);
  const daily = buildDailyStats(closedToday, consecutiveLosses);
  const ctx = buildScanContext(market, balance, tradingSettings, daily, token, currency);
  const output = await runCoordinator(ctx);
  const analysis = buildLegacyAnalysis(output);

  const prices = ctx.prices;
  const trendStats = analyzeTrend(prices);
  const digits = market.digitEnabled ? tickManager.getDigits(symbol, 100) : [];
  const liveDigitStats = digits.length > 10 ? analyzeDigits(digits) : null;

  return {
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
    digitStats: liveDigitStats ?? analysis.digitStats ?? null,
    digitBarrier: analysis.digitBarrier ?? null,
    trendStats,
    regime: output.regime,
    agentOutputs: output.agents,
    generatedAt: new Date().toISOString(),
  };
}

// ── Fast agent score computation for engine status ────────────────────────────
async function getComputedAgentScores(): Promise<Record<string, number>> {
  if (Object.keys(lastAgentScores).length > 0) return lastAgentScores;
  // Quick scan on the best-buffered market
  const candidateSymbols = ["1HZ100V", "R_100", "R_50", "R_25", "R_10"];
  const best = candidateSymbols
    .map((s) => ({ symbol: s, count: tickManager.getTicks(s, 100).length }))
    .filter((x) => x.count >= 5)
    .sort((a, b) => b.count - a.count)[0];
  if (!best) return {};
  const mInfo = getMarketInfo(best.symbol);
  if (!mInfo) return {};

  try {
    const ctx: ScanContext = {
      symbol: mInfo.symbol,
      displayName: mInfo.displayName,
      category: mInfo.category,
      prices: tickManager.getTicks(mInfo.symbol, 100),
      digits: mInfo.digitEnabled ? tickManager.getDigits(mInfo.symbol, 100) : [],
      balance: 10000,
      settings: buildTradingSettings(null, ["CALL", "PUT", "DIGITOVER", "DIGITUNDER"]),
      daily: { tradesCount: 0, wins: 0, losses: 0, profit: 0, consecutiveLosses: 0, consecutiveWins: 0 },
      token: null,
      currency: "USD",
    };
    const output = await runCoordinator(ctx);
    return Object.fromEntries(
      AGENT_SCORE_KEYS.map((k) => [k, output.agents[k]?.score ?? 65])
    );
  } catch { return {}; }
}


// ── Routes ─────────────────────────────────────────────────────────────────────

router.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  addSSEClient(res, req.sessionId);
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, liveTickCount: tickManager.getLiveTickCount(), connected: tickManager.getConnectionStatus() })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on("close", () => { clearInterval(heartbeat); removeSSEClient(res); });
});

router.get("/recommendation", async (req, res): Promise<void> => {
  const { balance, settings, account } = await getAccountAndSettings(req.sessionId);
  const token = account?.bearerToken ?? account?.token ?? null;
  const rawPreferred2 = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];
  const preferredContractTypes = rawPreferred2.map((t: string) => t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);

  const allowedSymbols = (settings as any)?.allowedMarkets
    ? ((settings as any).allowedMarkets as string).split(",").filter(Boolean)
    : null;
  const marketsToScan = allowedSymbols && allowedSymbols.length > 0
    ? AUTOMATED_DERIV_MARKETS.filter((m) => allowedSymbols.includes(m.symbol))
    : AUTOMATED_DERIV_MARKETS;

  const results = await Promise.all(
    marketsToScan.map((m) => buildRecommendationPayload(req.sessionId, m.symbol, m, balance, settings, preferredContractTypes, token, account?.currency ?? "USD"))
  );

  const valid = results.filter(Boolean) as NonNullable<typeof results[0]>[];
  valid.sort((a, b) => (b?.expectedValue ?? 0) - (a?.expectedValue ?? 0));
  const best = valid[0];
  if (!best) { res.status(404).json({ error: "No markets available" }); return; }
  res.json(best);
});

router.get("/recommendation/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const market = getMarketInfo(symbol);
  if (!market) { res.status(404).json({ error: "Market not found" }); return; }
  if (!isAutomatedMarket(symbol)) {
    res.status(422).json({ error: `${market.displayName} is available for manual trading only` });
    return;
  }

  const { balance, settings, account } = await getAccountAndSettings(req.sessionId);
  const token = account?.bearerToken ?? account?.token ?? null;
  const rawPreferred3 = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];
  const preferredContractTypes = rawPreferred3.map((t: string) => t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);

  const payload = await buildRecommendationPayload(req.sessionId, symbol, market, balance, settings, preferredContractTypes, token, account?.currency ?? "USD");
  if (!payload) { res.status(500).json({ error: "Analysis failed" }); return; }
  res.json(payload);
});

router.get("/insights", async (req, res): Promise<void> => {
  const trades = await db.select().from(tradesTable).where(and(
    eq(tradesTable.sessionId, req.sessionId),
    sql`${tradesTable.status} IN ('won', 'lost')`,
  )).orderBy(desc(tradesTable.createdAt)).limit(200);

  const won = trades.filter((t) => t.status === "won");
  const lost = trades.filter((t) => t.status === "lost");
  const winRate = trades.length > 0 ? won.length / trades.length : 0;
  const totalProfit = trades.reduce((s, t) => s + Number(t.profit ?? 0), 0);
  const avgProfit = trades.length > 0 ? totalProfit / trades.length : 0;

  const marketStats: Record<string, { won: number; total: number; profit: number }> = {};
  for (const t of trades) {
    if (!marketStats[t.symbol]) marketStats[t.symbol] = { won: 0, total: 0, profit: 0 };
    marketStats[t.symbol].total++;
    marketStats[t.symbol].profit += Number(t.profit ?? 0);
    if (t.status === "won") marketStats[t.symbol].won++;
  }

  const contractStats: Record<string, { won: number; total: number }> = {};
  for (const t of trades) {
    if (!contractStats[t.contractType]) contractStats[t.contractType] = { won: 0, total: 0 };
    contractStats[t.contractType].total++;
    if (t.status === "won") contractStats[t.contractType].won++;
  }

  const marketEntries = Object.entries(marketStats).filter(([, s]) => s.total >= 2);
  const bestMarket = [...marketEntries].sort((a, b) => (b[1].won / b[1].total) - (a[1].won / a[1].total))[0];
  const worstMarket = [...marketEntries].sort((a, b) => (a[1].won / a[1].total) - (b[1].won / b[1].total))[0];

  const sorted = [...trades].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  let currentConsecLosses = 0;
  for (const t of sorted) { if (t.status === "lost") currentConsecLosses++; else break; }

  const highConf = trades.filter((t) => Number(t.aiConfidence ?? 0) >= 65);
  const highConfWinRate = highConf.length > 0 ? highConf.filter((t) => t.status === "won").length / highConf.length : 0;
  const lowConf = trades.filter((t) => Number(t.aiConfidence ?? 0) < 65);
  const lowConfWinRate = lowConf.length > 0 ? lowConf.filter((t) => t.status === "won").length / lowConf.length : 0;

  const digitTrades = trades.filter((t) => t.contractType.includes("DIGIT"));
  const digitWinRate = digitTrades.length > 0 ? digitTrades.filter((t) => t.status === "won").length / digitTrades.length : 0;
  const riseFallTrades = trades.filter((t) => ["RISE", "FALL", "CALL", "PUT"].includes(t.contractType));
  const riseFallWinRate = riseFallTrades.length > 0 ? riseFallTrades.filter((t) => t.status === "won").length / riseFallTrades.length : 0;

  const liveStatus = `Deriv WS ${tickManager.getConnectionStatus() ? "connected" : "disconnected"} — ${tickManager.getLiveTickCount()} ticks buffered`;
  const insights = [];

  if (trades.length === 0) {
    insights.push({ id: 1, type: "improvement", title: "Start Trading to Build AI Insights", description: `${liveStatus}. Start the autonomous engine to begin generating personalized trade analysis.`, priority: "medium", actionable: true, relatedMarket: null });
  } else {
    insights.push({ id: 1, type: "pattern", title: `${(winRate * 100).toFixed(1)}% win rate — ${trades.length} total trades`, description: `Won: ${won.length}, Lost: ${lost.length}. Avg P&L: ${avgProfit >= 0 ? "+" : ""}$${avgProfit.toFixed(2)}. ${winRate > 0.55 ? "You have a profitable edge." : winRate > 0.45 ? "Near break-even — review confidence threshold." : "Below break-even — review settings."}`, priority: winRate > 0.55 ? "low" : "high", actionable: winRate <= 0.55, relatedMarket: null });

    if (digitTrades.length > 5 && riseFallTrades.length > 5) {
      const betterType = digitWinRate > riseFallWinRate ? "DIGIT OVER/UNDER" : "Rise/Fall";
      insights.push({ id: 2, type: "pattern", title: `${betterType} contracts outperforming`, description: `DIGIT: ${(digitWinRate * 100).toFixed(1)}% WR. Rise/Fall: ${(riseFallWinRate * 100).toFixed(1)}%. Adjust preferred contract types in Settings.`, priority: Math.abs(digitWinRate - riseFallWinRate) > 0.1 ? "high" : "medium", actionable: true, relatedMarket: null });
    }

    if (bestMarket) {
      insights.push({ id: 3, type: "milestone", title: `Best market: ${bestMarket[0]} at ${((bestMarket[1].won / bestMarket[1].total) * 100).toFixed(0)}% win rate`, description: `${bestMarket[1].won}/${bestMarket[1].total} wins, $${bestMarket[1].profit.toFixed(2)} profit.`, priority: "low", actionable: false, relatedMarket: bestMarket[0] });
    }

    if (currentConsecLosses >= 2) {
      insights.push({ id: 4, type: "warning", title: `⚠ Active losing streak: ${currentConsecLosses} consecutive losses`, description: `Consider pausing the engine. The Risk Manager will automatically reduce stakes as losses accumulate.`, priority: currentConsecLosses >= 3 ? "high" : "medium", actionable: true, relatedMarket: null });
    }

    if (highConf.length > 3 && lowConf.length > 3) {
      insights.push({ id: 5, type: "improvement", title: `High-confidence trades: ${(highConfWinRate * 100).toFixed(1)}% vs low-confidence: ${(lowConfWinRate * 100).toFixed(1)}%`, description: highConfWinRate > lowConfWinRate + 0.05 ? "Raise confidence threshold to 65+ for better results." : "Your confidence threshold is well-calibrated.", priority: highConfWinRate > lowConfWinRate + 0.1 ? "high" : "low", actionable: highConfWinRate > lowConfWinRate + 0.05, relatedMarket: null });
    }

    if (worstMarket && worstMarket[1].total >= 3 && worstMarket[1].won / worstMarket[1].total < 0.4) {
      insights.push({ id: 6, type: "warning", title: `Avoid ${worstMarket[0]}: ${((worstMarket[1].won / worstMarket[1].total) * 100).toFixed(0)}% win rate`, description: `Only ${worstMarket[1].won}/${worstMarket[1].total} wins. Consider removing from allowed markets in Settings.`, priority: "medium", actionable: true, relatedMarket: worstMarket[0] });
    }
  }

  res.json(insights);
});

// ── Recovery dashboard payload — single global recovery state ───────────────
//
// Recovery is ONE state now, regardless of contract type. The loss-streak
// count is the exact same counter that gates cooldown (see runAutonomousLoop).
// The card only returns to "Normal" once a win FULLY covers unrecoveredAmount
// — a partial win clears the streak count but leaves the debt (and `active`)
// in place, per spec.
function buildRecoveryPayload(visible = true) {
  if (!visible) {
    return {
      active: false, inRecovery: false, recoveryStep: 0, baseStake: 0,
      targetProfit: 0, remainingTargetProfit: 0, originPayoutMultiplier: 1,
      unrecoveredAmount: 0, totalUnrecovered: 0, totalStreakLosses: 0,
      totalStreakAmount: 0, highestStep: 0,
    };
  }
  const state = recoveryEngine.getState();
  return {
    active: state.inRecovery,
    inRecovery: state.inRecovery,
    recoveryStep: state.recoveryStep,
    baseStake: Math.round(state.baseStake * 100) / 100,
    targetProfit: Math.round(state.targetProfit * 100) / 100,
    remainingTargetProfit: Math.round(state.remainingTargetProfit * 100) / 100,
    originPayoutMultiplier: Math.round(state.originPayoutMultiplier * 1000) / 1000,
    unrecoveredAmount: Math.round(state.unrecoveredAmount * 100) / 100,
    totalUnrecovered: Math.round(state.unrecoveredAmount * 100) / 100,
    totalStreakLosses: state.streakLossCount,
    totalStreakAmount: Math.round(state.streakStartAmount * 100) / 100,
    highestStep: state.inRecovery ? state.recoveryStep : 0,
  };
}

router.get("/engine/status", async (req, res): Promise<void> => {
  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, req.sessionId)).limit(1);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTrades = await db.select().from(tradesTable).where(and(
    eq(tradesTable.sessionId, req.sessionId),
    sql`${tradesTable.createdAt} >= ${today}`,
  ));
  const liveScores = await getComputedAgentScores();
  const ownsEngine = engineOwnerSessionId === req.sessionId;
  const visibleRunning = engineRunning && ownsEngine;

  res.json({
    isRunning: visibleRunning, mode: visibleRunning ? "autonomous" : "manual",
    agentStatuses: AGENT_NAMES.map((name, i) => {
      const key = AGENT_SCORE_KEYS[i] ?? "featureEngineering";
      const score = liveScores[key] ?? 65;
      return {
        name,
        isActive: true,
        lastRun: new Date().toISOString(),
        confidence: score,
      };
    }),
    tradesExecutedToday: todayTrades.length,
    currentMarket: ownsEngine ? currentMarket : null,
    nextScanIn: visibleRunning ? nextScanIn : null,
    stopReasons: ownsEngine ? stopReasons : [],
    loopIntervalSec: ownsEngine ? loopIntervalSec : (settings[0]?.loopIntervalSec ?? 5),
    lastTradeTime: ownsEngine ? (lastTradeTime?.toISOString() ?? null) : null,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
    tickHealth: tickManager.getTickHealth(),
    paperTradeMode: settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false,
    requirePositiveEv: settings.length > 0 ? (settings[0] as any).requirePositiveEv ?? true : true,
    cooldownUntil: ownsEngine ? (cooldownUntil?.toISOString() ?? null) : null,
    sessionLossCount: ownsEngine ? sessionLossCount : 0,
    consecutiveLossLimit: settings.length > 0 ? (settings[0].consecutiveLossLimit ?? 3) : 3,
    marketsScanned: AUTOMATED_DERIV_MARKETS.length,
    recovery: buildRecoveryPayload(ownsEngine),
  });
});

router.post("/engine/toggle", async (req, res): Promise<void> => {
  const parseResult = ToggleAutonomousEngineBody.safeParse(req.body);
  if (!parseResult.success) { res.status(400).json({ error: "Invalid request" }); return; }
  const { running } = parseResult.data;

  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, req.sessionId)).limit(1);
  if (settings.length > 0 && settings[0].loopIntervalSec) loopIntervalSec = settings[0].loopIntervalSec;

  if (running) {
    if (engineRunning && engineOwnerSessionId !== req.sessionId) {
      res.status(409).json({ error: "Another isolated browser session is currently using the autonomous executor. Your account was not touched; try again after that session stops." });
      return;
    }
    // ── Single-executor guard — one recovery ledger, one trading engine ──────
    // If a NeuroAI FAB session is currently executing trades, refuse to start:
    // both engines share the same account-level recovery ledger, so concurrent
    // execution would double-stake the same debt and recreate the normal/
    // recovery mix-up. The FAB loop will likewise halt if it loses ownership.
    if (!acquireTradingOwnership("autonomous")) {
      const owner = currentTradingOwner();
      res.status(409).json({
        error: `Cannot start: the ${owner ? tradingOwnerLabel(owner) : "other engine"} is currently trading this account. Stop it first — only one engine may trade (and own the recovery ledger) at a time.`,
      });
      return;
    }
    engineOwnerSessionId = req.sessionId;
    recoveryEngine.setPersistenceSession(req.sessionId);
    recoveryEngine.resetAll();
    const persistedRecovery = (settings[0] as any)?.recoveryStateJson;
    if (persistedRecovery) recoveryEngine.loadState(persistedRecovery);
    // Clear any active cooldown timer when manually starting. Note: the global
    // loss-streak counter (recoveryEngine.getState().streakLossCount) is NOT reset
    // here — it is the single source of truth for the cooldown gate and must keep
    // reflecting reality (e.g. restarting mid-streak should not silently clear it).
    if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }
    cooldownUntil = null;
    sessionLossCount = recoveryEngine.getState().streakLossCount;
    engineRunning = true; autonomousMode = "autonomous"; stopReasons = []; nextScanIn = loopIntervalSec;
    exploitSymbol = null; exploitCount = 0;
    // NOTE: Do NOT call recoveryEngine.resetAll() here — any unrecovered loss amount
    // from before this session must be preserved so the engine can continue recovery.
    // Recovery state is persisted to DB and loaded on startup — it should survive
    // both manual engine restarts AND server restarts.

    // Reset group cursors → scanning restarts from V10 1s / V10 / JD10 / RDBULL
    groupCursors.fill(0);
    if (settings.length > 0) await db.update(settingsTable)
      .set({ autonomousEnabled: true })
      .where(eq(settingsTable.id, settings[0].id));
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    autonomousTimer = setTimeout(runAutonomousLoop, 2000);
    logger.info({ loopIntervalSec }, "Autonomous engine started");
  } else {
    if (engineRunning && engineOwnerSessionId !== req.sessionId) {
      res.status(409).json({ error: "You cannot stop another browser session's autonomous engine." });
      return;
    }
    engineRunning = false; autonomousMode = "manual"; currentMarket = null; nextScanIn = null;
    exploitSymbol = null; lastAgentScores = {};
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }
    cooldownUntil = null;
    releaseTradingOwnership("autonomous");
    engineOwnerSessionId = null;
    if (settings.length > 0) await db.update(settingsTable)
      .set({ autonomousEnabled: false })
      .where(eq(settingsTable.id, settings[0].id));
  }

  const toggleScores = await getComputedAgentScores();
  res.json({
    isRunning: engineRunning, mode: autonomousMode,
    agentStatuses: AGENT_NAMES.map((name, i) => {
      const key = AGENT_SCORE_KEYS[i] ?? "featureEngineering";
      const score = toggleScores[key] ?? 65;
      return { name, isActive: true, lastRun: new Date().toISOString(), confidence: score };
    }),
    tradesExecutedToday, currentMarket, nextScanIn, stopReasons, loopIntervalSec,
    lastTradeTime: lastTradeTime?.toISOString() ?? null,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
    tickHealth: tickManager.getTickHealth(),
    paperTradeMode: settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false,
    requirePositiveEv: settings.length > 0 ? (settings[0] as any).requirePositiveEv ?? true : true,
    cooldownUntil: null,
    sessionLossCount,
    consecutiveLossLimit: settings.length > 0 ? (settings[0].consecutiveLossLimit ?? 3) : 3,
    marketsScanned: AUTOMATED_DERIV_MARKETS.length,
    recovery: buildRecoveryPayload(),
  });
});

// ── Trade Intelligence endpoints ──────────────────────────────────────────────

router.get("/intelligence/summary", async (_req, res): Promise<void> => {
  try {
    const [summary, missedSummary, dynamicStatus] = await Promise.all([
      getIntelligenceSummary(),
      getMissedOpportunitySummary(),
      Promise.resolve(getDynamicConfidenceStatus()),
    ]);
    res.json({ summary, missedSummary, dynamicStatus });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch intelligence summary" });
  }
});

router.get("/intelligence/reports", async (_req, res): Promise<void> => {
  try {
    const rawLimit = Number(_req.query["limit"]);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 50);
    const reports = await getRecentReports(limit);
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch intelligence reports" });
  }
});

router.get("/intelligence/missed", async (_req, res): Promise<void> => {
  try {
    const rawLimit = Number(_req.query["limit"]);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 50);
    const missed = await getRecentMissed(limit);
    res.json(missed);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch missed opportunities" });
  }
});

router.get("/intelligence/thresholds", async (_req, res): Promise<void> => {
  try {
    const status = getDynamicConfidenceStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch adaptive thresholds" });
  }
});

// ── Recovery Intelligence endpoints ───────────────────────────────────────────

/**
 * GET /api/ai/recovery/evaluation
 * Returns the single global recovery state — no per-family candidate scanning.
 * Digit pairs used while trading are the user-configured settings
 * (normalOverDigit/normalUnderDigit/recoveryOverDigit/recoveryUnderDigit), not
 * a scanned/ranked candidate table.
 */
/**
 * POST /api/ai/recovery/clear-debt
 * Immediately zeroes the unrecovered debt so the engine returns to normal-stake
 * trading. Future losses will accumulate fresh (smaller) debt as usual.
 * This does NOT disable Recovery Mode — it only clears the current balance owed.
 */
router.post("/recovery/clear-debt", async (req, res): Promise<void> => {
  try {
    if (engineOwnerSessionId && engineOwnerSessionId !== req.sessionId) {
      res.status(409).json({ error: "You cannot change another browser session's recovery state." });
      return;
    }
    recoveryEngine.setPersistenceSession(req.sessionId);
    recoveryEngine.resetAll();
    // Persist the cleared state only to this browser session.
    const [settings] = await db.select().from(settingsTable)
      .where(eq(settingsTable.sessionId, req.sessionId)).limit(1);
    if (settings) {
      await db.update(settingsTable)
        .set({ recoveryStateJson: recoveryEngine.serializeState(), updatedAt: new Date() } as any)
        .where(eq(settingsTable.id, settings.id));
    }
    logger.info("Recovery debt cleared manually by user");
    res.json({ success: true, message: "Recovery debt cleared — engine returning to normal stake" });
  } catch (err) {
    logger.error({ err }, "Failed to clear recovery debt");
    res.status(500).json({ error: "Failed to clear recovery debt" });
  }
});

router.get("/recovery/evaluation", async (req, res): Promise<void> => {
  try {
    if (engineOwnerSessionId && engineOwnerSessionId !== req.sessionId) {
      res.json({ inRecovery: false, unrecoveredAmount: 0, streakLosses: 0, message: "No recovery state for this browser session" });
      return;
    }
    const state = recoveryEngine.getState();

    if (!state.inRecovery) {
      res.json({
        inRecovery:        false,
        unrecoveredAmount: 0,
        streakLosses:      0,
        message:           "Not in recovery mode",
      });
      return;
    }

    res.json({
      inRecovery:        true,
      unrecoveredAmount: state.unrecoveredAmount,
      baseStake:         state.baseStake,
      streakLosses:      state.streakLossCount,
      streakAmount:      state.streakStartAmount,
      recoveryStep:      state.recoveryStep,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch recovery evaluation" });
  }
});

// ── Day-reset handshake ───────────────────────────────────────────────────────
// Called by the frontend on every page-load with the browser's tzOffsetMin
// (Date.prototype.getTimezoneOffset() — UTC minus local, in minutes).
// On first load: just stores the timezone and reschedules the midnight timer.
// At exactly local midnight: frontend also sets `reset: true` which triggers
// the full in-memory reset immediately (before the server-side timer fires).
router.post("/day-reset", (req, res): void => {
  const { tzOffsetMin, reset } = req.body ?? {};

  if (typeof tzOffsetMin === "number" && Number.isFinite(tzOffsetMin)) {
    setTzOffset(tzOffsetMin); // stores offset + reschedules the server-side midnight timer
  }

  if (reset === true) {
    forceDayReset(true, req.sessionId); // resets only this browser's recovery/day state
  }

  res.json({ ok: true });
});

export default router;
