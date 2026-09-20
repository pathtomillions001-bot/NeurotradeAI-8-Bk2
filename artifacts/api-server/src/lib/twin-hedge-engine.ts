/**
 * BOUNDARY HEDGE SENTINEL — execution engine.
 *
 * SIMPLIFIED from the old Twin-Lock that had too many gates and never traded.
 *
 * THE OPERATING MODEL
 * ───────────────────
 *   • Normal round: Over 4 + Under 5, SAME stake, SAME tick via bulk executor.
 *     On any single digit one leg wins — EXCEPT digit 4 or 5 where both lose.
 *     80% win rate on a fair stream.
 *   • Recovery round: Over 5 + Under 4, SAME stake, SAME tick. Armed ONLY
 *     when BOTH normal legs lost. Same split-win/lose dynamic, same gap {4,5}.
 *     Recovery stake sized to digest the TOTAL lost amount (2 × base stake).
 *   • Contracts are hard-wired. No user choice. Only post-scan choice is
 *     LOCK or SWITCH for the market.
 *
 * GATES (MINIMAL)
 * ───────────────
 *   Normal:   fire if 4/5 frequency < 30%. That's it. No crossing analysis.
 *   Recovery: fire if current digit ≠ 4/5. Patience valve forces after 5 ticks.
 *
 * SPEED: the gate evaluates in <0.1ms. The bot fires on almost every tick.
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeBulkLiveTrades,
  waitForBulkContractResults,
  getLiveBalance,
  isAutomatedMarket,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { resolveRecoveryPayout } from "./recovery-payout";
import * as recoveryEngine from "./agents/recovery-engine";
import {
  acquireTradingOwnership,
  releaseTradingOwnership,
  hasTradingOwnership,
  currentTradingOwner,
  tradingOwnerLabel,
} from "./engine-arbiter";
import { createSessionScoped, getBrowserSessionId, runWithSessionId } from "./session";
import { registerLiveBot } from "./live-registry";
import {
  TWIN_NORMAL_LEGS,
  TWIN_RECOVERY_LEGS,
  legLabel,
  legWins,
  isGapDigit,
  isTwinNormalLeg,
  isTwinRecoveryLeg,
  twinEntryGate,
  edgeHazard,
  evaluateTwinMarket,
  screenAndRankTwin,
  recoveryBreakEvenGapRate,
  type TwinHedgeCandidate,
  type TwinLeg,
} from "./twin-hedge-analysis";
import { payoutForBarrier } from "./specialist-analysis";

export const TWIN_HEDGE_BOT_ID = "twinhedge";
const BOT_NAME = "Boundary Hedge Sentinel";

/** Recovery patience: force fire after this many refused ticks. */
const RECOVERY_PATIENCE_TICKS = 5;
/** Switching mode: rotate market after this many dry ticks. */
const DRY_STREAM_TICKS = 20;
/** Gap rate ceiling for switching trigger. */
const SWITCH_HAZARD = 0.34;
/** Score lead needed to switch. */
const SWITCH_MARGIN = 3;

export const TWIN_MIN_SCORE = 30;

// ── Config / status types ─────────────────────────────────────────────────────

export interface TwinHedgeConfig {
  ownerSessionId?: string;
  symbol: string;
  displayName: string;
  marketMode: "locked" | "switching";
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  lockedAnalysis?: TwinHedgeCandidate;
  rankedCandidates?: TwinHedgeCandidate[];
}

export interface TwinHedgeStatus {
  running: boolean;
  botId: string;
  botName: string;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  bothWinCount: number;
  splitCount: number;
  bothLoseCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  recoveryTargetProfit: number;
  recoveryRemainingTargetProfit: number;
  consecutiveRecoveryLosses: number;
  deepestLossRun: number;
  bothLoseRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost" | "flat";
  lastRound?: {
    mode: "normal" | "recovery";
    legs: Array<{ contract: string; won: boolean; profit: number }>;
    net: number;
    hazard: number;
    forced: boolean;
    market: string;
    at: number;
  };
  gate?: { hazard: number; reason: string };
  marketMode?: "locked" | "switching";
  message?: string;
  config?: Omit<TwinHedgeConfig, "ownerSessionId" | "rankedCandidates">;
  lock?: {
    symbol: string;
    displayName: string;
    normalPair: string;
    recoveryPair: string;
    gapHazard: number;
    safeRate: number;
    recoveryBreakEven: number;
    crossingRate: number;
    signals: string[];
  };
}

export interface TwinHedgeScanResult {
  suitable: boolean;
  best: TwinHedgeCandidate | null;
  allScored: TwinHedgeCandidate[];
  reason: string;
}

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: TwinHedgeConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  bothWinCount: number;
  splitCount: number;
  bothLoseCount: number;
  currentStake: number;
  consecutiveRecoveryLosses: number;
  currentLossRun: number;
  deepestLossRun: number;
  bothLoseRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost" | "flat";
  lastRound?: TwinHedgeStatus["lastRound"];
  gate?: TwinHedgeStatus["gate"];
  marketMode?: "locked" | "switching";
  message?: string;
  stopRequested: boolean;
}

function freshSession(): SessionState {
  return {
    running: false, sessionId: null, config: null, totalProfit: 0, tradeCount: 0,
    winCount: 0, lossCount: 0, bothWinCount: 0, splitCount: 0, bothLoseCount: 0,
    currentStake: 0, consecutiveRecoveryLosses: 0, currentLossRun: 0,
    deepestLossRun: 0, bothLoseRun: 0, stopRequested: false,
  };
}

const { state: session, replace: replaceSession } = createSessionScoped<SessionState>(freshSession);
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

function nextTickFor(symbol: string, timeoutMs = 9_000): Promise<number | null> {
  return new Promise(resolve => {
    let done = false;
    const finish = (d: number | null) => {
      if (done) return; done = true; clearTimeout(timer); tickManager.off("tick", onTick); resolve(d);
    };
    const onTick = (tick: { symbol: string; lastDigit: number }) => {
      if (tick.symbol !== symbol) return; finish(tick.lastDigit);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    tickManager.on("tick", onTick);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null { return session.config?.ownerSessionId ?? null; }
export function isRunning(): boolean { return session.running; }

export function getStatus(): TwinHedgeStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const publicConfig = cfg
    ? (Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== "ownerSessionId" && k !== "rankedCandidates")) as Omit<TwinHedgeConfig, "ownerSessionId" | "rankedCandidates">)
    : undefined;
  const a = cfg?.lockedAnalysis;
  return {
    running: session.running, botId: TWIN_HEDGE_BOT_ID, botName: BOT_NAME,
    sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount, winCount: session.winCount, lossCount: session.lossCount,
    bothWinCount: session.bothWinCount, splitCount: session.splitCount, bothLoseCount: session.bothLoseCount,
    currentStake: session.currentStake,
    inRecovery: rec.inRecovery, recoveryStep: rec.recoveryStep,
    unrecoveredAmount: Math.round(rec.unrecoveredAmount * 100) / 100,
    recoveryTargetProfit: Math.round(rec.targetProfit * 100) / 100,
    recoveryRemainingTargetProfit: Math.round(rec.remainingTargetProfit * 100) / 100,
    consecutiveRecoveryLosses: session.consecutiveRecoveryLosses,
    deepestLossRun: session.deepestLossRun, bothLoseRun: session.bothLoseRun,
    currentMarket: session.currentMarket, currentContractType: session.currentContractType,
    lastResult: session.lastResult, lastRound: session.lastRound,
    gate: session.gate, marketMode: session.marketMode, message: session.message,
    config: publicConfig,
    lock: cfg ? {
      symbol: cfg.symbol, displayName: cfg.displayName,
      normalPair: pairLabel(TWIN_NORMAL_LEGS), recoveryPair: pairLabel(TWIN_RECOVERY_LEGS),
      gapHazard: a?.gapHazard ?? 0, safeRate: a?.safeRate ?? 0,
      recoveryBreakEven: a?.recoveryBreakEven ?? 0,
      crossingRate: a?.crossingRate ?? 0,
      signals: a?.signals ?? [],
    } : undefined,
  };
}

export function pairLabel(legs: readonly TwinLeg[]): string {
  return legs.map(legLabel).join(" + ");
}

export function stopSession() {
  session.stopRequested = true; session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots"); broadcast();
  logger.info("Boundary Hedge session stopped");
}

// ── Scan ──────────────────────────────────────────────────────────────────────

export async function scanTwinMarkets(
  ownerSessionId: string | undefined,
  simParams: { stake: number; takeProfit: number; stopLoss: number; maxRecoverySteps: number; markupPercent: number; maxStake: number },
): Promise<TwinHedgeScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const all: TwinHedgeCandidate[] = [];
  let scanned = 0;

  for (const market of markets) {
    broadcastSSE("bot_scan_progress", {
      botId: TWIN_HEDGE_BOT_ID, scanning: market.displayName, symbol: market.symbol,
      scanned, total: markets.length, results: screenAndRankTwin(all).slice(0, 8),
    }, ownerSessionId);

    const digits = tickManager.getDigits(market.symbol, 300);
    const pOver4 = payoutForBarrier("DIGITOVER", 4);
    const pUnder5 = payoutForBarrier("DIGITUNDER", 5);
    const pOver5 = payoutForBarrier("DIGITOVER", 5);
    const pUnder4 = payoutForBarrier("DIGITUNDER", 4);

    all.push(evaluateTwinMarket(market.symbol, market.displayName, digits, {
      stake: simParams.stake, payoutNormal: (pOver4 + pUnder5) / 2, payoutRecovery: Math.min(pOver5, pUnder4),
    }));
    scanned++;
    await sleep(30);
  }

  const ranked = screenAndRankTwin(all);

  broadcastSSE("bot_scan_progress", {
    botId: TWIN_HEDGE_BOT_ID, scanning: null, symbol: null,
    scanned: markets.length, total: markets.length, results: ranked.slice(0, 12),
  }, ownerSessionId);

  if (ranked.length === 0) {
    return { suitable: false, best: null, allScored: [], reason: "No market has enough history yet (120+ digits needed)." };
  }

  const best = ranked[0]!;
  const suitable = best.samples >= 120 && best.gapHazard <= 0.30;
  const reason = suitable
    ? `${best.displayName}: 4/5 at ${Math.round(best.gapHazard * 100)}% · safe ${Math.round(best.safeRate * 100)}% vs ${Math.round(best.recoveryBreakEven * 100)}% digest · score ${best.score}`
    : best.samples < 120
      ? `${best.displayName} has only ${best.samples} digits (120 needed).`
      : `Best market ${best.displayName} is hovering on 4/5 (${Math.round(best.gapHazard * 100)}%). Re-scan when it cools.`;

  return { suitable, best, allScored: ranked.slice(0, 12), reason };
}

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startSession(config: TwinHedgeConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A Boundary Hedge session is already active — stop it first" };
  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return { ok: false, error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is trading. Stop it first.` };
  }
  const fail = (error: string) => { releaseTradingOwnership("bots"); return { ok: false as const, error }; };
  if (config.stake < 0.35) return fail("Minimum stake is $0.35 (per leg — a round stakes 2×)");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);

  for (const leg of TWIN_NORMAL_LEGS) {
    if (!isTwinNormalLeg(leg.side, leg.barrier)) return fail("Normal pair integrity check failed");
  }
  for (const leg of TWIN_RECOVERY_LEGS) {
    if (!isTwinRecoveryLeg(leg.side, leg.barrier)) return fail("Recovery pair integrity check failed");
  }

  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  replaceSession({
    ...freshSession(), running: true, sessionId: `bot_boundary_${Date.now()}`,
    config: { ...config, displayName: market?.displayName ?? config.displayName },
    currentStake: config.stake, marketMode: config.marketMode,
    currentMarket: market?.displayName ?? config.displayName,
    message: `⚡ ${config.marketMode === "locked" ? "Locked" : "Switching"} on ${market?.displayName ?? config.displayName}: ${pairLabel(TWIN_NORMAL_LEGS)} normal → ${pairLabel(TWIN_RECOVERY_LEGS)} recovery`,
  });

  logger.info({ symbol: config.symbol, marketMode: config.marketMode }, "Boundary Hedge session starting");
  broadcast();
  registerLiveBot("twin-hedge", () => getStatus());

  const loopSessionId = config.ownerSessionId ?? getBrowserSessionId();
  runWithSessionId(loopSessionId, () => runLoop({ ...config, ownerSessionId: loopSessionId }).catch(err => {
    logger.error({ err }, "Boundary Hedge runLoop error");
    session.running = false; session.message = `⚠️ ${friendlyErrorMessage(err)}`; broadcast();
  }).finally(() => releaseTradingOwnership("bots")));

  return { ok: true };
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: TwinHedgeConfig) {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) {
    session.running = false; session.message = "Browser session missing — aborted safely";
    releaseTradingOwnership("bots"); broadcast(); return;
  }

  let accounts = await db.select().from(accountsTable).where(and(eq(accountsTable.sessionId, ownerSessionId), eq(accountsTable.isActive, true))).limit(1);
  if (accounts.length === 0) accounts = await db.select().from(accountsTable).where(eq(accountsTable.sessionId, ownerSessionId)).limit(1);

  const settings = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
  recoveryEngine.setPersistenceSession(ownerSessionId);
  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;
  const token = accounts.length > 0 ? (accounts[0]!.bearerToken ?? accounts[0]!.token ?? null) : null;
  const currency = accounts.length > 0 ? accounts[0]!.currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0]!.maxTradeStake) : 500;
  let botRecoveryMarkup = settings.length > 0 ? Number((settings[0] as any).botRecoveryMarkup ?? 10) : 10;
  let availableBalance = accounts.length > 0 && Number(accounts[0]!.balance) > 0 ? Number(accounts[0]!.balance) : Number.POSITIVE_INFINITY;

  let symbol = config.symbol;
  let displayName = config.displayName;
  let consecutiveErrors = 0;
  let waitedTicks = 0;

  while (session.running && !session.stopRequested) {
    try {
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false;
        session.message = `⛔ Stopped — ${owner ? tradingOwnerLabel(owner) : "other engine"} took over.`;
        broadcast(); return;
      }

      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) {
        session.message = "Stabilizing tick feed…"; broadcast(); await sleep(1000); continue;
      }

      // Wait for a FRESH tick
      const freshDigit = await nextTickFor(symbol, 9_000);
      if (freshDigit === null) {
        session.message = "Feed stalled — waiting for next tick"; broadcast(); continue;
      }
      if (!session.running) break;

      const digits = tickManager.getDigits(symbol, 300);
      const age = tickManager.getTickAgeSeconds(symbol);
      if (age > 8) {
        session.message = `Stale feed on ${displayName} (${age.toFixed(1)}s)`; continue;
      }

      // Circuit breaker: consecutive recovery failures
      if (session.consecutiveRecoveryLosses > config.maxRecoverySteps) {
        session.running = false;
        session.message = `🛑 Circuit breaker: ${session.consecutiveRecoveryLosses} consecutive both-lose rounds exceed the ${config.maxRecoverySteps}-step budget. Re-scan.`;
        broadcast(); return;
      }

      // ── The gate (SIMPLIFIED) ──────────────────────────────────────────
      const inRecovery = recoveryEngine.isInRecovery();
      const legs = inRecovery ? [...TWIN_RECOVERY_LEGS] : [...TWIN_NORMAL_LEGS];

      // Contract sovereignty on EVERY fire
      const okSovereignty = inRecovery
        ? legs.every(l => isTwinRecoveryLeg(l.side, l.barrier))
        : legs.every(l => isTwinNormalLeg(l.side, l.barrier));
      if (!okSovereignty) {
        session.running = false; session.message = "⚠️ Pair integrity check failed — halted";
        broadcast(); return;
      }

      const gate = twinEntryGate({
        digits, mode: inRecovery ? "recovery" : "normal",
        waitedTicks, maxWaitTicks: RECOVERY_PATIENCE_TICKS,
      });
      session.gate = { hazard: gate.hazard.p, reason: gate.reason };

      if (!gate.fire) {
        waitedTicks++;
        // Switching mode: rotate if too dry
        if (config.marketMode === "switching" && waitedTicks >= DRY_STREAM_TICKS) {
          const moved = await tryMarketSwitch(config, symbol, displayName, ownerSessionId);
          if (moved) { symbol = moved.symbol; displayName = moved.displayName; waitedTicks = 0; continue; }
        }
        session.message = `⏸️ ${displayName}: ${gate.reason}`;
        broadcast(); continue;
      }
      waitedTicks = 0;

      // ── Payout quotes ──────────────────────────────────────────────────
      const [qa, qb] = await Promise.all([
        resolveRecoveryPayout({ symbol, contractType: legs[0]!.side, barrier: legs[0]!.barrier, duration: 1, durationUnit: "t", currency }),
        resolveRecoveryPayout({ symbol, contractType: legs[1]!.side, barrier: legs[1]!.barrier, duration: 1, durationUnit: "t", currency }),
      ]);
      const payoutA = qa.payoutMultiplier;
      const payoutB = qb.payoutMultiplier;

      if (inRecovery) {
        try {
          const fresh = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
          if (fresh.length > 0) { const v = Number((fresh[0] as any).botRecoveryMarkup); if (Number.isFinite(v)) botRecoveryMarkup = v; }
        } catch {}
      }

      const minRecPayout = Math.min(payoutA, payoutB);
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, Math.max(1.05, minRecPayout - 2), botRecoveryMarkup)
        : config.stake;

      const roundId = `R${session.tradeCount + 1}`;
      session.currentStake = stake; session.currentMarket = displayName;
      session.currentContractType = `${pairLabel(legs)} @ ${roundId}`;
      session.message = inRecovery
        ? `🎯 [Recovery R${recoveryEngine.getState().recoveryStep}] ${roundId} ${pairLabel(legs)} on ${displayName} · $${stake.toFixed(2)}×2 · ${gate.forced ? "FORCED · " : ""}${gate.reason}`
        : `⚡ ${roundId} ${pairLabel(legs)} on ${displayName} · $${stake.toFixed(2)}×2 · hazard ${Math.round(gate.hazard.p * 100)}%`;
      broadcast();

      // ── Journal ────────────────────────────────────────────────────────
      const reasonText = `[${BOT_NAME}${inRecovery ? " RECOVERY" : ""}] ${roundId} ${inRecovery ? "recovery" : "normal"} · hazard ${Math.round(gate.hazard.pWorst * 100)}% · ${pairLabel(legs)}`;
      const journaled = await Promise.all(legs.map(leg =>
        db.insert(tradesTable).values({
          sessionId: ownerSessionId, symbol, displayName,
          contractType: leg.side, barrier: leg.barrier,
          stake: String(Math.round(stake * 100) / 100), direction: "hold", status: "open",
          aiConfidence: String(Math.round(clamp01(gate.hazard.safe) * 100)),
          aiRiskScore: inRecovery ? "62" : "48", isAutonomous: true,
          agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reasonText} · ${gate.reason}`,
          duration: 1, durationUnit: "t",
        }).returning(),
      ));

      // ── Execute both legs (SAME TICK via bulk executor) ────────────────
      type LegSettle = { won: boolean; profit: number; executed: boolean; entry: number; exit: number };
      let settleA: LegSettle; let settleB: LegSettle;
      const entryPrice = tickManager.getLatestPrice(symbol) ?? 0;

      if (isLive) {
        let legsResult: Awaited<ReturnType<typeof executeBulkLiveTrades>>;
        try {
          legsResult = await executeBulkLiveTrades(token!, accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            legs.map(leg => ({
              symbol, contractType: leg.side, stake: Math.round(stake * 100) / 100,
              duration: 1, durationUnit: "t", currency, barrier: leg.barrier,
            })),
          );
        } catch (err) {
          await settleErrorRows(journaled, `${reasonText} [BATCH FAILED: ${friendlyErrorMessage(err, { max: 160 })}]`);
          session.message = `🔁 Retrying — ${friendlyErrorMessage(err)}`; broadcast(); await sleep(1200); continue;
        }

        const opened = legsResult.map((l, i) => (!("error" in l) ? i : -1)).filter(i => i >= 0);
        if (opened.length === 0) {
          await settleErrorRows(journaled, `${reasonText} [EVERY LEG REJECTED]`);
          session.message = `🔁 Both legs rejected — retrying next tick`; broadcast(); await sleep(1200); continue;
        }

        let results: Awaited<ReturnType<typeof waitForBulkContractResults>> = [];
        try {
          results = await waitForBulkContractResults(token!, accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            opened.map(i => (legsResult[i] as { contractId: number }).contractId), 30_000);
        } catch { results = []; }

        const settleOne = (i: number): LegSettle => {
          const l = legsResult[i]; if ("error" in l) return { won: false, profit: 0, executed: false, entry: 0, exit: 0 };
          const r = results.find(x => x.contractId === l.contractId);
          if (!r || r.missing) return { won: false, profit: 0, executed: true, entry: l.buyPrice, exit: l.buyPrice };
          return { won: r.won, profit: r.profit, executed: true, entry: r.entrySpot || l.buyPrice, exit: r.exitSpot || l.buyPrice };
        };
        settleA = settleOne(0); settleB = settleOne(1);

        for (let i = 0; i < 2; i++) {
          const s = i === 0 ? settleA : settleB;
          const row = journaled[i]![0];
          if (!s.executed) {
            try { await db.update(tradesTable).set({ status: "error", profit: "0", payout: "0", closedAt: new Date(), agentReasoning: `${reasonText} [NOT EXECUTED]` }).where(eq(tradesTable.id, row!.id)); } catch {}
          }
        }
      } else {
        // Paper mode: both legs settle on the SAME tick
        const d = freshDigit;
        const winA = legWins(legs[0]!, d); const winB = legWins(legs[1]!, d);
        const profitFor = (won: boolean, payout: number) => won ? Math.round(stake * (payout - 1) * 100) / 100 : -stake;
        settleA = { won: winA, profit: profitFor(winA, payoutA), executed: true, entry: entryPrice, exit: entryPrice };
        settleB = { won: winB, profit: profitFor(winB, payoutB), executed: true, entry: entryPrice, exit: entryPrice };
      }

      // ── Round settlement ───────────────────────────────────────────────
      const executedCount = (settleA.executed ? 1 : 0) + (settleB.executed ? 1 : 0);
      const netProfit = (settleA.executed ? settleA.profit : 0) + (settleB.executed ? settleB.profit : 0);
      const bothExecuted = executedCount === 2;
      const bothLost = bothExecuted && !settleA.won && !settleB.won;
      const bothWon = bothExecuted && settleA.won && settleB.won;
      const roundWon = netProfit > 0;
      const totalStake = stake * executedCount;

      await Promise.all([settleRow(journaled[0]![0]!, settleA, stake, reasonText), settleRow(journaled[1]![0]!, settleB, stake, reasonText)]);

      // Shared ledger: split rounds IGNORED (never trigger recovery)
      if (inRecovery) {
        recoveryEngine.recordOutcome(roundWon, netProfit, totalStake, config.maxRecoverySteps, legs[0]!.side, Math.max(1.05, minRecPayout - 2));
      } else if (bothLost) {
        recoveryEngine.recordOutcome(false, netProfit, totalStake, config.maxRecoverySteps, "TWINPAIR", 1);
      } else if (roundWon) {
        recoveryEngine.recordOutcome(true, netProfit, totalStake, config.maxRecoverySteps, "TWINPAIR", 1);
      }

      // Session bookkeeping
      session.tradeCount++; session.totalProfit = Math.round((session.totalProfit + netProfit) * 100) / 100;
      if (roundWon) { session.winCount++; session.lastResult = "won"; session.currentLossRun = 0; session.bothLoseRun = 0; }
      else if (netProfit < 0) {
        session.lossCount++; session.lastResult = "lost"; session.currentLossRun++;
        session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun);
        if (bothLost) session.bothLoseRun++;
      } else { session.lastResult = "flat"; }
      if (bothWon) session.bothWinCount++; else if (bothLost) session.bothLoseCount++; else if (bothExecuted) session.splitCount++;

      if (inRecovery) {
        session.consecutiveRecoveryLosses = bothLost ? session.consecutiveRecoveryLosses + 1 : (recoveryEngine.isInRecovery() ? session.consecutiveRecoveryLosses : 0);
        if (!recoveryEngine.isInRecovery()) session.consecutiveRecoveryLosses = 0;
      }

      session.lastRound = {
        mode: inRecovery ? "recovery" : "normal",
        legs: [
          { contract: legLabel(legs[0]!), won: settleA.won, profit: Math.round(settleA.profit * 100) / 100 },
          { contract: legLabel(legs[1]!), won: settleB.won, profit: Math.round(settleB.profit * 100) / 100 },
        ],
        net: Math.round(netProfit * 100) / 100, hazard: gate.hazard.pWorst,
        forced: gate.forced === true, market: displayName, at: Date.now(),
      };

      if (!isLive && Number.isFinite(availableBalance)) availableBalance = Math.max(0, availableBalance + netProfit);
      if (isLive) {
        try {
          const newBal = await getLiveBalance(token!, accounts[0]?.derivAccountId ?? accounts[0]?.loginId);
          if (newBal !== null && accounts.length > 0) { availableBalance = newBal; await db.update(accountsTable).set({ balance: String(newBal), updatedAt: new Date() }).where(eq(accountsTable.id, accounts[0]!.id)); }
        } catch {}
      }

      broadcast();

      // TP / SL
      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached — ${session.bothWinCount} both-wins, ${session.splitCount} splits, ${session.bothLoseCount} recoveries.`;
        broadcast(); return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit.`;
        broadcast(); return;
      }

      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++; logger.error({ err, consecutiveErrors }, "Boundary Hedge stability catch");
      session.message = `Engine stabilizing… retry ${consecutiveErrors}`; broadcast();
      await sleep(Math.min(15000, 600 * consecutiveErrors));
    }
  }

  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️") && !session.message?.startsWith("⛔")) {
    session.message = "Session stopped"; broadcast();
  }
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

async function settleRow(row: { id: number } | undefined, s: { won: boolean; profit: number; executed: boolean; entry: number; exit: number }, stake: number, reasonText: string) {
  if (!row || !s.executed) return;
  try {
    await db.update(tradesTable).set({
      status: s.won ? "won" : "lost", payout: String(s.won ? Math.round((stake + s.profit) * 100) / 100 : 0),
      profit: String(Math.round(s.profit * 100) / 100), entryPrice: String(s.entry), exitPrice: String(s.exit), closedAt: new Date(),
    }).where(eq(tradesTable.id, row.id));
  } catch {}
}

async function settleErrorRows(journaled: Array<Array<{ id: number } | undefined> | undefined>, note: string) {
  for (const ret of journaled) {
    const row = ret?.[0]; if (!row) continue;
    try { await db.update(tradesTable).set({ status: "error", profit: "0", payout: "0", closedAt: new Date(), agentReasoning: note }).where(eq(tradesTable.id, row.id)); } catch {}
  }
}

// ── Market rotation (switching mode) ──────────────────────────────────────────

async function tryMarketSwitch(config: TwinHedgeConfig, currentSymbol: string, currentDisplayName: string, ownerSessionId: string): Promise<{ symbol: string; displayName: string } | null> {
  const universe = config.rankedCandidates;
  if (!universe || universe.length < 2) return null;

  const pOver4 = payoutForBarrier("DIGITOVER", 4);
  const pUnder5 = payoutForBarrier("DIGITUNDER", 5);
  const pOver5 = payoutForBarrier("DIGITOVER", 5);
  const pUnder4 = payoutForBarrier("DIGITUNDER", 4);

  let current: TwinHedgeCandidate | null = null;
  const freshScores: TwinHedgeCandidate[] = [];
  for (const cand of universe.slice(0, 8)) {
    const digits = tickManager.getDigits(cand.symbol, 300);
    const evalled = evaluateTwinMarket(cand.symbol, cand.displayName, digits, {
      stake: config.stake, payoutNormal: (pOver4 + pUnder5) / 2, payoutRecovery: Math.min(pOver5, pUnder4),
    });
    freshScores.push(evalled);
    if (cand.symbol === currentSymbol) current = evalled;
  }
  if (!current) {
    const digits = tickManager.getDigits(currentSymbol, 300);
    current = evaluateTwinMarket(currentSymbol, currentDisplayName, digits, {
      stake: config.stake, payoutNormal: (pOver4 + pUnder5) / 2, payoutRecovery: Math.min(pOver5, pUnder4),
    });
  }

  const best = freshScores.filter(c => c.symbol !== currentSymbol && c.recoveryViable).sort((a, b) => b.score - a.score)[0];
  if (!best || best.score <= (current?.score ?? 0) + SWITCH_MARGIN) return null;

  broadcastSSE("bot_update", { ...getStatus(), message: `🔀 Switching ${currentDisplayName} → ${best.displayName} (4/5 at ${Math.round(best.gapHazard * 100)}% there vs ${Math.round(current.gapHazard * 100)}% here)` }, ownerSessionId);
  logger.info({ from: currentSymbol, to: best.symbol }, "Boundary Hedge market switch");
  return { symbol: best.symbol, displayName: best.displayName };
}

export { TWIN_NORMAL_LEGS, TWIN_RECOVERY_LEGS, legLabel, pairLabel as pairText, edgeHazard };