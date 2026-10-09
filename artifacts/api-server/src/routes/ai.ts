import { Router } from "express";
import { db } from "@workspace/db";
import { aiInsightsTable, tradesTable, settingsTable, accountsTable } from "@workspace/db";
import { and, sql, desc, eq } from "drizzle-orm";
import { tickManager, AUTOMATED_DERIV_MARKETS, getLiveBalance, getMarketInfo, analyzeDigits, analyzeTrend, analyzeEvenOdd, getJournalManager, isAutomatedMarket } from "../lib/deriv";
import { ToggleAutonomousEngineBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { runCoordinator, buildLegacyAnalysis } from "../lib/agent-coordinator";
import { buildHedgePreview, getHedgeMemory, requestHedgeCycle, resetHedgeSession, type HedgeContext, type HedgeHost, type HedgePublish } from "../lib/autonomous-hedge/cycle";
import { normalizePreferredTypes } from "../lib/autonomous-hedge/families";
import { HEDGE_DURATION_TICKS } from "../lib/autonomous-hedge/constants";
import { recoveryEscalation } from "../lib/autonomous-hedge/recovery-risk";
import { resolveContractSets } from "../lib/autonomous-hedge/contract-sets";
import type { TradingSettings, DailyStats, ScanContext } from "../lib/agents/types";
import * as recoveryEngine from "../lib/agents/recovery-engine";
import { getRecentReports, getIntelligenceSummary } from "../lib/agents/trade-intelligence";
import { getMissedOpportunitySummary, getRecentMissed } from "../lib/agents/missed-opportunity";
import { getStatus as getDynamicConfidenceStatus, loadFromDb as loadDynamicConfidence } from "../lib/agents/dynamic-confidence";
import { broadcastSSE, addSSEClient, removeSSEClient } from "../lib/sse";
import { runWithSession } from "../lib/session";
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
  // One engine per account session: reset the requesting session's engine, or
  // ALL engines when the server-side midnight scheduler fires (no sessionId).
  // A midnight request from one browser must never clear another account's
  // cooldown or counters.
  const targets = sessionId
    ? [enginesBySession.get(sessionId)].filter((e): e is EngineInstance => Boolean(e))
    : [...enginesBySession.values()];

  for (const engine of targets) {
    engine.tradesExecutedToday = 0;
    engine.sessionLossCount = 0;
    if (engine.cooldownResumeTimer) { clearTimeout(engine.cooldownResumeTimer); engine.cooldownResumeTimer = null; }
    engine.cooldownUntil = null;

    // Recovery ledger is per account session — bind it via ALS so the right
    // session's state is rolled into a new day.
    runWithSession(engine.sessionId, () => {
      recoveryEngine.setPersistenceSession(engine.sessionId);
      recoveryEngine.forceNewDay();
    });

    if (broadcast) {
      broadcastSSE("day_reset", { ts: new Date().toISOString() }, engine.sessionId);
    }
  }
  logger.info({ sessionId: sessionId ?? "all", enginesReset: targets.length }, "Midnight day-reset fired");
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
  // Account-scoped sessions make auto-resume safe: an enabled settings row
  // belongs to a specific Deriv account, and that account's credentials are
  // stored with it. EVERY account that had its engine running restarts its own
  // INDEPENDENT engine instance — a deploy can never kill or steal another
  // account's bots. Previously this wiped autonomous_enabled for ALL sessions
  // on every restart (the "one account's bots died" bug).
  try {
    const enabled = await db.select().from(settingsTable)
      .where(eq(settingsTable.autonomousEnabled, true));
    for (const row of enabled) {
      const accounts = await db.select().from(accountsTable)
        .where(eq(accountsTable.sessionId, row.sessionId)).limit(1);
      const token = accounts[0]?.bearerToken ?? accounts[0]?.token ?? null;
      if (!token) {
        await db.update(settingsTable).set({ autonomousEnabled: false })
          .where(eq(settingsTable.sessionId, row.sessionId));
        logger.info(
          { sessionId: row.sessionId },
          "Auto-resume skipped — that account session has no connected Deriv account",
        );
        continue;
      }
      startEngineFor(row.sessionId, row);
    }
  } catch (err) {
    logger.warn({ err }, "Auto-resume failed — the engine must be restarted from the browser");
  }
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

// ── Engine state — ONE INSTANCE PER ACCOUNT SESSION ──────────────────────────
//
// Every connected Deriv account (account-scoped browser session) gets its own
// fully independent engine instance: its own loop timer, cooldown, counters,
// cursors and recovery ledger. Starting the engine in one account can never
// disable, stop, or trade on another account — even when both apps are open in
// the same browser or the same Google account. The trading arbiter is likewise
// scoped per session (see lib/engine-arbiter.ts).
interface EngineInstance {
  sessionId: string;
  running: boolean;
  mode: string;
  tradesExecutedToday: number;
  currentMarket: string | null;
  /** Always null: the engine is tick-driven, there is no scan countdown. */
  nextScanIn: number | null;
  stopReasons: string[];
  loopIntervalSec: number;
  lastTradeTime: Date | null;
  cooldownUntil: Date | null;
  cooldownResumeTimer: ReturnType<typeof setTimeout> | null;
  /** Consecutive-loss streak, mirrored from the recovery ledger. */
  sessionLossCount: number;
}

const enginesBySession = new Map<string, EngineInstance>();

function getEngine(sessionId: string): EngineInstance {
  let engine = enginesBySession.get(sessionId);
  if (!engine) {
    engine = {
      sessionId,
      running: false,
      mode: "manual",
      tradesExecutedToday: 0,
      currentMarket: null,
      nextScanIn: null,
      stopReasons: [],
      loopIntervalSec: 5,
      lastTradeTime: null,
      cooldownUntil: null,
      cooldownResumeTimer: null,
      sessionLossCount: 0,
    };
    enginesBySession.set(sessionId, engine);
  }
  return engine;
}

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
    cooldownEnabled:        s?.cooldownEnabled ?? true,
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

  // Recovery context for the evidence-based admission threshold. Read from the
  // single global recovery state so every market scanned in this iteration sees
  // the same elapsed time. Absent ⇒ normal mode (constant threshold).
  const recoveryState = recoveryEngine.getState();
  const recoveryStartedAt = Number(recoveryState.recoveryStartedAt) || 0;
  const recovery = recoveryState.inRecovery
    ? {
        active: true,
        elapsedMs: recoveryStartedAt > 0 ? Math.max(0, Date.now() - recoveryStartedAt) : 0,
      }
    : { active: false, elapsedMs: 0 };

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
    recovery,
  };
}

// ── Wire up TickManager → SSE for live prices + live analysis ─────────────────

// Track the last time each market received a real Deriv tick
const lastTickTime = new Map<string, number>();

tickManager.on("tick", (tick) => {
  broadcastSSE("tick", tick);
  lastTickTime.set(tick.symbol, Date.now());
  // The autonomous engine is tick-driven: every live tick of a watched market
  // triggers a coalesced 1-tick cycle for each running engine.
  dispatchHedgeTick(tick.symbol);
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

function broadcastEngineSSE(engine: EngineInstance, event: string, data: unknown): void {
  broadcastSSE(event, data, engine.sessionId);
}

/**
 * Start (or restart) the independent engine instance for ONE account session.
 * Shared by the /engine/toggle "on" path and startup auto-resume so both set up
 * exactly the same per-account state. Never touches any other session.
 */
function startEngineFor(sessionId: string, settingsRow?: typeof settingsTable.$inferSelect): void {
  const engine = getEngine(sessionId);
  if (engine.running) return;

  // Recovery ledger is per account session — bind via ALS and load THIS
  // session's persisted state (preserving any unrecovered debt). With no
  // persisted state, start this session's ledger fresh.
  runWithSession(sessionId, () => {
    recoveryEngine.setPersistenceSession(sessionId);
    const persistedRecovery = (settingsRow as any)?.recoveryStateJson;
    if (persistedRecovery) {
      try { recoveryEngine.loadState(persistedRecovery); }
      catch { recoveryEngine.resetAll(); }
    } else {
      recoveryEngine.resetAll();
    }
  });

  if (settingsRow?.loopIntervalSec) engine.loopIntervalSec = settingsRow.loopIntervalSec;
  engine.running = true;
  engine.mode = "autonomous";
  engine.stopReasons = [];
  engine.nextScanIn = null;
  // A fresh start rescans from empty memory, exactly like a restarted bot.
  resetHedgeSession(sessionId);
  logger.info(
    { sessionId, loopIntervalSec: engine.loopIntervalSec },
    settingsRow
      ? "Autonomous engine auto-resumed for its account session after restart"
      : "Autonomous engine started",
  );
  // Tick-driven: evaluate now; every later live tick re-evaluates.
  requestHedgeCycle(hedgeHostFor(engine));
}

function stopEngine(engine: EngineInstance, reason: string, cooldownMinutes?: number) {
  engine.running = false;
  engine.mode = "manual";
  engine.stopReasons = [reason];
  engine.currentMarket = null;
  engine.nextScanIn = null;
  // Give up trading ownership (scoped to THIS account session) so another
  // engine on the same account (NeuroAI FAB) may execute while this one is
  // stopped. Ownership is re-acquired before any trade, so a cooldown
  // auto-resume can never race a FAB session that started meanwhile.
  releaseTradingOwnership("autonomous", engine.sessionId);

  // Clear any existing cooldown timer
  if (engine.cooldownResumeTimer) { clearTimeout(engine.cooldownResumeTimer); engine.cooldownResumeTimer = null; }

  if (cooldownMinutes && cooldownMinutes > 0) {
    engine.cooldownUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000);
    engine.cooldownResumeTimer = setTimeout(() => {
      engine.cooldownUntil = null;
      engine.cooldownResumeTimer = null;
      // Reset the loss-streak counter on cooldown expiry — the ONLY reset
      // point outside of a fully-covering win. This clears the counter that
      // gates cooldown (recoveryEngine streakLossCount), NOT the recovery debt
      // itself (unrecoveredAmount persists until a win fully covers the debt).
      runWithSession(engine.sessionId, () => {
        recoveryEngine.setPersistenceSession(engine.sessionId);
        recoveryEngine.seedState({ ...recoveryEngine.getState(), streakLossCount: 0 });
      });
      engine.sessionLossCount = 0;
      // Auto-resume engine
      engine.running = true;
      engine.mode = "autonomous";
      engine.stopReasons = [];
      engine.nextScanIn = null;
      logger.info({ sessionId: engine.sessionId }, "Cooldown expired — autonomous engine auto-resuming, session loss count reset");
      broadcastEngineSSE(engine, "engine_started", { reason: "cooldown_expired" });
      broadcastEngineSSE(engine, "loss_streak_reset", { sessionLossCount: 0 });
      requestHedgeCycle(hedgeHostFor(engine));
    }, cooldownMinutes * 60 * 1000);
    logger.info({ sessionId: engine.sessionId, reason, cooldownMinutes }, "Engine stopped with cooldown");
  } else {
    engine.cooldownUntil = null;
    // Final stop — persist the flag so a server restart does not resurrect an
    // engine its owner intentionally left stopped by a hard stop.
    db.update(settingsTable).set({ autonomousEnabled: false })
      .where(eq(settingsTable.sessionId, engine.sessionId))
      .catch((err) => logger.warn({ err }, "Failed to persist engine-off flag"));
    logger.info({ sessionId: engine.sessionId, reason }, "Autonomous engine stopped");
  }
  broadcastSSE("engine_stopped", { reason, cooldownUntil: engine.cooldownUntil?.toISOString() ?? null }, engine.sessionId);
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

/** Cancel an active cooldown immediately when the account disables it in Settings. */
export function applyCooldownSettingUpdate(
  sessionId: string,
  settings: typeof settingsTable.$inferSelect,
): void {
  if (settings.cooldownEnabled) return;
  const engine = enginesBySession.get(sessionId);
  if (!engine || (!engine.cooldownResumeTimer && !engine.cooldownUntil)) return;

  if (engine.cooldownResumeTimer) clearTimeout(engine.cooldownResumeTimer);
  engine.cooldownResumeTimer = null;
  engine.cooldownUntil = null;
  broadcastEngineSSE(engine, "cooldown_disabled", { ts: Date.now() });

  // The engine remained enabled in settings while it was waiting. Continue the
  // same session now, preserving its recovery streak and tournament memory.
  if (settings.autonomousEnabled && !engine.running) {
    engine.running = true;
    engine.mode = "autonomous";
    engine.stopReasons = [];
    engine.nextScanIn = null;
    engine.loopIntervalSec = settings.loopIntervalSec || engine.loopIntervalSec;
    broadcastEngineSSE(engine, "engine_started", { reason: "cooldown_disabled" });
    requestHedgeCycle(hedgeHostFor(engine));
  }
}

// ── Autonomous engine host (tick-driven 1-tick cycle) ─────────────────────────
//
// The cycle itself lives in lib/autonomous-hedge/cycle.ts. This section binds
// one engine instance (one account session) to it: loads the account context,
// keeps the engine's status fields current, and enforces the single-executor
// rule. Nothing here analyses markets or sizes trades.

function dispatchHedgeTick(symbol: string): void {
  if (!isAutomatedMarket(symbol)) return;
  for (const engine of enginesBySession.values()) {
    if (engine.running) requestHedgeCycle(hedgeHostFor(engine));
  }
}

function hedgeHostFor(engine: EngineInstance): HedgeHost {
  return {
    sessionId: engine.sessionId,
    isRunning: () => engine.running,
    canExecute: () => {
      if (acquireTradingOwnership("autonomous", engine.sessionId)) return true;
      // ── Single-executor guard ─────────────────────────────────────────────
      // One account = one recovery ledger = one executing engine. If the NeuroAI
      // FAB session owns execution right now, this engine must NOT trade.
      const owner = currentTradingOwner(engine.sessionId);
      logger.warn({ owner }, "Autonomous engine cannot trade — another engine owns execution; stopping to protect the shared recovery ledger");
      stopEngine(engine,
        `Stopped: the ${owner ? tradingOwnerLabel(owner) : "other engine"} is trading this account. One recovery ledger = one trading engine at a time — stop that engine before restarting this one.`,
      );
      return false;
    },
    stop: (reason: string, cooldownMinutes?: number) => stopEngine(engine, reason, cooldownMinutes),
    emit: (event: string, data: Record<string, unknown>) => broadcastEngineSSE(engine, event, data),
    publish: (patch: HedgePublish) => {
      if (patch.currentMarket !== undefined) engine.currentMarket = patch.currentMarket;
      if (patch.sessionLossCount !== undefined) engine.sessionLossCount = patch.sessionLossCount;
      if (patch.tradesExecutedToday !== undefined) engine.tradesExecutedToday = patch.tradesExecutedToday;
      if (patch.lastTradeTime !== undefined) engine.lastTradeTime = patch.lastTradeTime;
      if (patch.nextScanIn !== undefined) engine.nextScanIn = patch.nextScanIn;
    },
    loadContext: () => loadHedgeContext(engine),
    afterSettlement: (ctx: HedgeContext) => {
      if (ctx.paperTradeMode || !ctx.token || !ctx.derivAccountId) return;
      getJournalManager(engine.sessionId).forceRefresh();
      void syncLiveBalance(engine.sessionId, ctx.token, ctx.derivAccountId);
    },
  };
}

/** Account, settings and today's resolved P&L for this engine's session. */
async function loadHedgeContext(engine: EngineInstance): Promise<HedgeContext> {
  const sessionId = engine.sessionId;
  const { balance, settings, account } = await getAccountAndSettings(sessionId);
  const token = account?.bearerToken ?? account?.token ?? null;
  const derivAccountId = account?.derivAccountId ?? account?.loginId ?? null;
  const journalManager = getJournalManager(sessionId);
  if (token && derivAccountId) journalManager.setCredentials(token, derivAccountId);

  const rawPreferred = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];
  const tradingSettings = buildTradingSettings(settings, normalizePreferredTypes(rawPreferred));
  // The contract sets the user chose for normal and recovery trades. A set that was
  // never saved is derived from the legacy settings above.
  const contractSets = resolveContractSets({
    normal: settings?.autonomousNormalContracts,
    recovery: settings?.autonomousRecoveryContracts,
    legacy: {
      preferredContractTypes: normalizePreferredTypes(rawPreferred),
      normalOverDigit: tradingSettings.normalOverDigit,
      normalUnderDigit: tradingSettings.normalUnderDigit,
      recoveryOverDigit: tradingSettings.recoveryOverDigit,
      recoveryUnderDigit: tradingSettings.recoveryUnderDigit,
    },
  });
  if (settings?.loopIntervalSec) engine.loopIntervalSec = settings.loopIntervalSec;

  const allowedMarketSymbols: string[] | null =
    (settings as any)?.allowedMarkets
      ? ((settings as any).allowedMarkets as string).split(",").filter(Boolean)
      : null;

  // Daily stats share the day boundary used by the journal and daily-summary views.
  const today = getTodayStart();
  const todayTrades = await db.select().from(tradesTable).where(and(
    eq(tradesTable.sessionId, sessionId),
    sql`${tradesTable.createdAt} >= ${today}`,
  ));
  const closedToday = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
  engine.tradesExecutedToday = closedToday.length;

  // Consecutive losses come from the recovery ledger: the same number the
  // dashboard shows, and the only signal that triggers a cooldown.
  const globalStreakCount = recoveryEngine.getState().streakLossCount;
  engine.sessionLossCount = globalStreakCount;

  // Daily P&L: prefer the Deriv journal (authoritative net P&L), fall back to the local DB.
  const todayMidnightSec = today.getTime() / 1000;
  const derivTxns = token ? journalManager.getCached() : [];
  const derivTodayTxns = derivTxns.filter(
    (t: any) => Number(t.sell_time ?? t.purchase_time ?? 0) >= todayMidnightSec,
  );
  const resolvedDailyProfit = derivTodayTxns.length > 0
    ? derivTodayTxns.reduce((s: number, t: any) => s + Number(t.profit ?? 0), 0)
    : closedToday.reduce((s, t) => s + Number(t.profit ?? 0), 0);

  const daily = buildDailyStats(closedToday, globalStreakCount);
  daily.profit = resolvedDailyProfit;

  return {
    balance,
    currency: account?.currency ?? "USD",
    token,
    derivAccountId,
    settings: tradingSettings,
    consecutiveLossLimit: tradingSettings.consecutiveLossLimit,
    cooldownMinutes: settings?.cooldownMinutes ?? 30,
    allowedMarketSymbols,
    paperTradeMode: tradingSettings.paperTradeMode,
    daily,
    contractSets,
  };
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
// count is the exact same counter that gates cooldown (see lib/autonomous-hedge/cycle.ts).
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

router.get("/engine/preview", async (req, res): Promise<void> => {
  const engine = getEngine(req.sessionId);
  const preview = await runWithSession(req.sessionId, async () => {
    recoveryEngine.setPersistenceSession(req.sessionId);
    const ctx = await loadHedgeContext(engine);
    const ledger = recoveryEngine.getState();
    const mode = recoveryEngine.isInRecovery() ? "RECOVERY" as const : "NORMAL" as const;
    const lossRun = ledger.streakLossCount;
    const escalation = recoveryEscalation(lossRun, ledger.recoveryStep);
    const result = buildHedgePreview(ctx, mode, getHedgeMemory(req.sessionId), lossRun, escalation);
    const stake = result.risk.recommendedStake;
    const markets = result.rankedRows.map((row, index) => {
      const market = getMarketInfo(row.symbol);
      return {
        symbol: row.symbol,
        displayName: market?.displayName ?? row.symbol,
        group: row.group,
        contractType: row.contract,
        recommendedContractType: row.contract,
        barrier: row.barrier >= 0 ? row.barrier : null,
        digitBarrier: row.barrier >= 0 ? row.barrier : null,
        qualityScore: Math.round(row.score * 100) / 100,
        confidenceScore: Math.round(row.lowerBound * 100),
        winProbability: Math.round(row.probability * 10000) / 100,
        expectedValue: Math.round(row.ev * stake * 100) / 100,
        stake,
        recommendedDuration: HEDGE_DURATION_TICKS,
        payoutMultiplier: row.payout,
        // Quick Strike is user-driven when the engine is off. Respect each
        // candidate's market/risk gate here, but don't require the autonomous
        // recovery-confirmation counter (the read-only preview must not mutate it).
        shouldTrade: !result.risk.hardStop && row.eligible,
        regime: mode.toLowerCase(),
        samples: row.samples,
        rank: index + 1,
      };
    });
    return {
      mode,
      markets,
      marketsScanned: result.marketsScanned,
      best: result.decision ? {
        symbol: result.decision.best.symbol,
        contractType: result.decision.best.contract,
        barrier: result.decision.best.barrier >= 0 ? result.decision.best.barrier : null,
        eligible: result.decision.eligible,
        reason: result.decision.reason,
      } : null,
      stopReason: result.risk.hardStopReason ?? null,
    };
  });
  res.json(preview);
});

router.get("/engine/status", async (req, res): Promise<void> => {
  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, req.sessionId)).limit(1);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTrades = await db.select().from(tradesTable).where(and(
    eq(tradesTable.sessionId, req.sessionId),
    sql`${tradesTable.createdAt} >= ${today}`,
  ));
  // This account's OWN independent engine instance — never another session's.
  const engine = getEngine(req.sessionId);

  res.json({
    isRunning: engine.running, mode: engine.running ? engine.mode : "manual",
    tradesExecutedToday: todayTrades.length,
    currentMarket: engine.currentMarket,
    nextScanIn: engine.running ? engine.nextScanIn : null,
    stopReasons: engine.stopReasons,
    loopIntervalSec: engine.running ? engine.loopIntervalSec : (settings[0]?.loopIntervalSec ?? 5),
    lastTradeTime: engine.lastTradeTime?.toISOString() ?? null,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
    tickHealth: tickManager.getTickHealth(),
    paperTradeMode: settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false,
    requirePositiveEv: settings.length > 0 ? (settings[0] as any).requirePositiveEv ?? true : true,
    cooldownUntil: engine.cooldownUntil?.toISOString() ?? null,
    sessionLossCount: engine.sessionLossCount,
    consecutiveLossLimit: settings.length > 0 ? (settings[0].consecutiveLossLimit ?? 3) : 3,
    marketsScanned: AUTOMATED_DERIV_MARKETS.length,
    recovery: buildRecoveryPayload(true),
  });
});

router.post("/engine/toggle", async (req, res): Promise<void> => {
  const parseResult = ToggleAutonomousEngineBody.safeParse(req.body);
  if (!parseResult.success) { res.status(400).json({ error: "Invalid request" }); return; }
  const { running } = parseResult.data;

  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, req.sessionId)).limit(1);

  // This account's OWN independent engine instance — starting or stopping it
  // can never affect another account's engine, even when both apps are open in
  // the same browser or the same Google account.
  const engine = getEngine(req.sessionId);

  if (running) {
    // ── Single-executor guard — ONE recovery ledger per ACCOUNT SESSION ──────
    // If a NeuroAI FAB session is currently executing trades on THIS SAME
    // account, refuse to start: both engines share this account's recovery
    // ledger, so concurrent execution would double-stake the same debt. The
    // arbiter is session-scoped — other accounts' engines are not affected.
    if (!acquireTradingOwnership("autonomous", req.sessionId)) {
      const owner = currentTradingOwner(req.sessionId);
      res.status(409).json({
        error: `Cannot start: the ${owner ? tradingOwnerLabel(owner) : "other engine"} is currently trading this account. Stop it first — only one engine may trade (and own the recovery ledger) at a time.`,
      });
      return;
    }

    // Clear any active cooldown when manually starting. The loss-streak counter
    // (recoveryEngine streakLossCount) is NOT reset here — it is the single
    // source of truth for the cooldown gate and must keep reflecting reality
    // (e.g. restarting mid-streak should not silently clear it).
    if (engine.cooldownResumeTimer) { clearTimeout(engine.cooldownResumeTimer); engine.cooldownResumeTimer = null; }
    engine.cooldownUntil = null;

    startEngineFor(req.sessionId, settings[0]);
    engine.sessionLossCount = runWithSession(req.sessionId, () => {
      recoveryEngine.setPersistenceSession(req.sessionId);
      return recoveryEngine.getState().streakLossCount;
    });
    if (settings.length > 0) await db.update(settingsTable)
      .set({ autonomousEnabled: true })
      .where(eq(settingsTable.id, settings[0].id));
  } else {
    stopEngine(engine, "Stopped by user");
    if (settings.length > 0) await db.update(settingsTable)
      .set({ autonomousEnabled: false })
      .where(eq(settingsTable.id, settings[0].id));
  }

  res.json({
    isRunning: engine.running, mode: engine.mode,
    tradesExecutedToday: engine.tradesExecutedToday, currentMarket: engine.currentMarket,
    nextScanIn: engine.nextScanIn, stopReasons: engine.stopReasons, loopIntervalSec: engine.loopIntervalSec,
    lastTradeTime: engine.lastTradeTime?.toISOString() ?? null,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
    tickHealth: tickManager.getTickHealth(),
    paperTradeMode: settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false,
    requirePositiveEv: settings.length > 0 ? (settings[0] as any).requirePositiveEv ?? true : true,
    cooldownUntil: engine.cooldownUntil?.toISOString() ?? null,
    sessionLossCount: engine.sessionLossCount,
    consecutiveLossLimit: settings.length > 0 ? (settings[0].consecutiveLossLimit ?? 3) : 3,
    marketsScanned: AUTOMATED_DERIV_MARKETS.length,
    recovery: buildRecoveryPayload(true),
  });
});

// ── Trade Intelligence endpoints ──────────────────────────────────────────────

// Every intelligence read is STRICTLY scoped to the requesting account: the
// queries below receive req.sessionId, which is derived from the connected
// Deriv login — this page can therefore only ever show trades this account
// executed itself, never another connected account's reports. (The dynamic
// confidence status is equally per-account: it resolves the ambient session
// through AsyncLocalStorage, bound by the session middleware.)

router.get("/intelligence/summary", async (req, res): Promise<void> => {
  try {
    const [summary, missedSummary, dynamicStatus] = await Promise.all([
      getIntelligenceSummary(req.sessionId),
      getMissedOpportunitySummary(req.sessionId),
      Promise.resolve(getDynamicConfidenceStatus()),
    ]);
    res.json({ summary, missedSummary, dynamicStatus });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch intelligence summary" });
  }
});

router.get("/intelligence/reports", async (req, res): Promise<void> => {
  try {
    const rawLimit = Number(req.query["limit"]);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 50);
    const reports = await getRecentReports(limit, req.sessionId);
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch intelligence reports" });
  }
});

router.get("/intelligence/missed", async (req, res): Promise<void> => {
  try {
    const rawLimit = Number(req.query["limit"]);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 50);
    const missed = await getRecentMissed(limit, req.sessionId);
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
    // Recovery state is per account session (ALS-bound inside the engine) —
    // clearing it here can never touch another account's ledger.
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
    // getState() resolves THIS account session's ledger via AsyncLocalStorage.
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
