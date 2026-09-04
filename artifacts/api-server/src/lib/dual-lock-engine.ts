/**
 * DUAL-LOCK RANGE SENTINEL — execution engine (6th specialist bot).
 *
 * Operating model, and how it differs from every other bot in the section:
 *
 *   ALL analysis happens ONCE, before the first trade. The scan
 *   (`lib/dual-lock-analysis.ts`) selects a TRIPLE — market, normal contract,
 *   recovery contract — and that triple is then FROZEN for the whole session.
 *   From the first tick to take-profit or stop-loss the loop does nothing but
 *   fire: normal contract while the shared ledger says "no debt", recovery
 *   contract while it says "debt". No re-scoring, no market switching, no
 *   digit re-selection, no green-light waiting. Continuous execution is the
 *   product requirement, so the intelligence had to move entirely to the front.
 *
 * Non-negotiables inherited from the section (identical to the other five):
 *   - the ONE shared recovery ledger (`lib/agents/recovery-engine.ts`) —
 *     no private debt state here;
 *   - the ONE shared recovery stake formula (`getBotRecoveryStake`, debt ×
 *     (1 + markup) / (payout − 1), user-adjustable markup);
 *   - the single-executor arbiter (`lib/engine-arbiter.ts`, owner `bots`);
 *   - trade journaling, TP/SL boundaries, live/paper execution paths.
 *
 * Contract sovereignty is stricter than anywhere else in the app: the normal
 * leg is checked against DUAL_LOCK_NORMAL_CONTRACTS and the recovery leg
 * against DUAL_LOCK_RECOVERY_CONTRACTS immediately before every buy, so a bug
 * upstream can never make this bot fire an Over 7 or a Matches contract.
 *
 * The one safety valve that survives the lock (and cannot be an "analysis"
 * because none is allowed mid-session): a CIRCUIT BREAKER. If the realised
 * loss-run depth exceeds the p95 depth the pre-deploy bootstrap predicted, the
 * live market has left the regime the lock was justified on, and the session
 * halts instead of feeding an unmodelled ladder.
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
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
import {
  evaluateMarket,
  screenAndRank,
  isDeployable,
  contractKey,
  contractLabel,
  isNormalContract,
  isRecoveryContract,
  DUAL_LOCK_NORMAL_CONTRACTS,
  DUAL_LOCK_RECOVERY_CONTRACTS,
  type DualLockCandidate,
  type DualLockContract,
} from "./dual-lock-analysis";

export const DUAL_LOCK_BOT_ID = "duallock";

// ── Session-parameter sovereignty ─────────────────────────────────────────────
//
// PRODUCT RULE (Dual-Lock only): the risk parameters the user sets before their
// FIRST scan are the parameters for the whole engagement. A re-scan may change
// the market and the contract pair — that is what a re-scan is for — but it may
// NEVER change the stake, take-profit, stop-loss or max recovery steps. This
// prevents the subtle failure where a survival figure is quoted for one set of
// boundaries and the session is then run with another.
//
// The committed parameters are held here, keyed by browser session, and every
// scan and start is forced through them. They are released only when the user
// explicitly asks for a fresh engagement (`resetSessionParams`).

export interface DualLockSessionParams {
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
}

const committedParams = new Map<string, DualLockSessionParams>();

/**
 * Commit (or read back) the immutable risk parameters for a browser session.
 * The first call wins; every later call returns the committed values and
 * reports which of the requested fields were overridden.
 */
export function commitSessionParams(
  sessionId: string,
  requested: DualLockSessionParams,
): { params: DualLockSessionParams; committed: boolean; overridden: string[] } {
  const existing = committedParams.get(sessionId);
  if (!existing) {
    const params: DualLockSessionParams = {
      stake: requested.stake,
      takeProfit: requested.takeProfit,
      stopLoss: requested.stopLoss,
      maxRecoverySteps: requested.maxRecoverySteps,
    };
    committedParams.set(sessionId, params);
    return { params, committed: true, overridden: [] };
  }
  const overridden: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  if (!near(existing.stake, requested.stake)) overridden.push("stake");
  if (!near(existing.takeProfit, requested.takeProfit)) overridden.push("takeProfit");
  if (!near(existing.stopLoss, requested.stopLoss)) overridden.push("stopLoss");
  if (existing.maxRecoverySteps !== requested.maxRecoverySteps) overridden.push("maxRecoverySteps");
  return { params: { ...existing }, committed: false, overridden };
}

export function getCommittedParams(sessionId: string): DualLockSessionParams | undefined {
  const p = committedParams.get(sessionId);
  return p ? { ...p } : undefined;
}

/** Start a brand-new engagement: the next scan may set fresh parameters. */
export function resetSessionParams(sessionId: string): void {
  committedParams.delete(sessionId);
}

// ── Config / status types ─────────────────────────────────────────────────────

export interface DualLockConfig {
  ownerSessionId?: string;
  /** Frozen market. */
  symbol: string;
  displayName: string;
  /** Frozen normal contract. */
  normal: DualLockContract;
  /** Frozen recovery contract. */
  recovery: DualLockContract;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  /** Pre-deploy bootstrap telemetry, kept for the circuit breaker + UI. */
  lockedAnalysis?: DualLockCandidate;
}

export interface DualLockStatus {
  running: boolean;
  botId: string;
  botName: string;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  recoveryTargetProfit: number;
  recoveryRemainingTargetProfit: number;
  consecutiveRecoveryLosses: number;
  /** Deepest consecutive-loss run seen this session (circuit-breaker input). */
  deepestLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: Omit<DualLockConfig, "ownerSessionId">;
  lock?: {
    symbol: string;
    displayName: string;
    normal: string;
    recovery: string;
    survival: number;
    ruin: number;
    clusterRatio: number;
    normalLcb: number;
    recoveryConditional: number;
    expectedMaxLossRun: number;
    recoveryDepthP95: number;
    signals: string[];
  };
}

export interface DualLockScanResult {
  suitable: boolean;
  best: DualLockCandidate | null;
  allScored: DualLockCandidate[];
  reason: string;
}

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: DualLockConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  consecutiveRecoveryLosses: number;
  currentLossRun: number;
  deepestLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  stopRequested: boolean;
  /** Advisory edge-decay tracker (never halts the session). */
}

function freshSession(): SessionState {
  return {
    running: false,
    sessionId: null,
    config: null,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    currentStake: 0,
    consecutiveRecoveryLosses: 0,
    currentLossRun: 0,
    deepestLossRun: 0,
    stopRequested: false,
  };
}

let session: SessionState = freshSession();

const BOT_NAME = "Dual-Lock Range Sentinel";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): DualLockStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const publicConfig = cfg
    ? (Object.fromEntries(
        Object.entries(cfg).filter(([k]) => k !== "ownerSessionId"),
      ) as Omit<DualLockConfig, "ownerSessionId">)
    : undefined;
  const a = cfg?.lockedAnalysis;
  return {
    running: session.running,
    botId: DUAL_LOCK_BOT_ID,
    botName: BOT_NAME,
    sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    currentStake: session.currentStake,
    inRecovery: rec.inRecovery,
    recoveryStep: rec.recoveryStep,
    unrecoveredAmount: Math.round(rec.unrecoveredAmount * 100) / 100,
    recoveryTargetProfit: Math.round(rec.targetProfit * 100) / 100,
    recoveryRemainingTargetProfit: Math.round(rec.remainingTargetProfit * 100) / 100,
    consecutiveRecoveryLosses: session.consecutiveRecoveryLosses,
    deepestLossRun: session.deepestLossRun,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    config: publicConfig,
    lock: cfg
      ? {
          symbol: cfg.symbol,
          displayName: cfg.displayName,
          normal: contractLabel(cfg.normal),
          recovery: contractLabel(cfg.recovery),
          survival: a?.survival ?? 0,
          ruin: a?.ruin ?? 0,
          clusterRatio: a?.clusterRatio ?? 1,
          normalLcb: a?.normalLcb ?? 0,
          recoveryConditional: a?.recoveryConditional ?? 0,
          expectedMaxLossRun: a?.expectedMaxLossRun ?? 0,
          recoveryDepthP95: a?.metrics?.["recoveryDepthP95"] ?? 0,
          signals: a?.signals ?? [],
        }
      : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info("Dual-Lock session stopped");
}

// ── Pre-deploy scan ───────────────────────────────────────────────────────────

/**
 * The whole intelligence of this bot: one exhaustive pass over every
 * digit-enabled market × 4 normal contracts × 4 recovery contracts, with the
 * loss-clustering, stationarity, conditional-recovery and bootstrap-survival
 * machinery in `dual-lock-analysis.ts`, then a Benjamini–Hochberg screen.
 */
export async function scanForLock(
  ownerSessionId: string | undefined,
  simParams: {
    stake: number;
    takeProfit: number;
    stopLoss: number;
    maxRecoverySteps: number;
    markupPercent: number;
    maxStake: number;
  },
): Promise<DualLockScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const all: DualLockCandidate[] = [];
  let scanned = 0;

  for (const market of markets) {
    broadcastSSE("bot_scan_progress", {
      botId: DUAL_LOCK_BOT_ID,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned,
      total: markets.length,
      results: screenAndRank(all).slice(0, 8),
    }, ownerSessionId);

    const digits = tickManager.getDigits(market.symbol, 300);
    const candidates = evaluateMarket(market.symbol, market.displayName, digits, {
      ...simParams,
      simulate: true,
    });
    all.push(...candidates);
    scanned++;
    // Yield so the event loop (and the tick feed) keeps breathing.
    await sleep(60);
  }

  const ranked = screenAndRank(all);

  broadcastSSE("bot_scan_progress", {
    botId: DUAL_LOCK_BOT_ID,
    scanning: null,
    symbol: null,
    scanned: markets.length,
    total: markets.length,
    results: ranked.slice(0, 8),
  }, ownerSessionId);

  if (ranked.length === 0) {
    return {
      suitable: false,
      best: null,
      allScored: [],
      reason: "No market has enough tick history yet (120+ digits needed per market) — wait a few seconds and re-scan",
    };
  }

  const best = ranked[0]!;
  const suitable = isDeployable(best);
  const reason = suitable
    ? `${best.displayName}: lock ${contractLabel(best.normal)} → recovery ${contractLabel(best.recovery)} — ${(best.survival * 100).toFixed(0)}% simulated survival, loss-clustering ξ ${best.clusterRatio.toFixed(2)}, normal worst-case ${(best.normalLcb * 100).toFixed(1)}% vs ${(best.normalBreakEven * 100).toFixed(1)}% break-even`
    : `No triple currently clears the lock bar (best: ${best.displayName} ${contractLabel(best.normal)}→${contractLabel(best.recovery)}, survival ${(best.survival * 100).toFixed(0)}%, score ${best.score.toFixed(0)}). A locked non-stop session needs a market that is stationary AND non-clustering — re-scan shortly.`;

  return { suitable, best, allScored: ranked.slice(0, 24), reason };
}

// ── Session start ─────────────────────────────────────────────────────────────

export async function startSession(config: DualLockConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A Dual-Lock session is already active — stop it first" };

  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return {
      ok: false,
      error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account. Stop it first — only one engine may own the shared recovery ledger.`,
    };
  }

  const fail = (error: string) => { releaseTradingOwnership("bots"); return { ok: false as const, error }; };

  if (config.stake < 0.35) return fail("Minimum stake is $0.35");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isNormalContract(config.normal.side, config.normal.barrier)) {
    return fail("Normal contract must be Over 1, Under 8, Over 2 or Under 7");
  }
  if (!isRecoveryContract(config.recovery.side, config.recovery.barrier)) {
    return fail("Recovery contract must be Over 4, Over 5, Under 5 or Under 4");
  }
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_duallock_${Date.now()}`,
    config,
    currentStake: config.stake,
    message: `Locked on ${config.displayName}: ${contractLabel(config.normal)} normal → ${contractLabel(config.recovery)} recovery. Starting continuous execution…`,
  };

  logger.info({
    symbol: config.symbol,
    normal: contractKey(config.normal),
    recovery: contractKey(config.recovery),
    survival: config.lockedAnalysis?.survival,
  }, "Dual-Lock session starting");
  broadcast();

  runLoop(config).catch(err => {
    logger.error({ err }, "Dual-Lock runLoop error");
    session.running = false;
    session.message = `⚠️ ${friendlyErrorMessage(err)}`;
    broadcast();
  }).finally(() => releaseTradingOwnership("bots"));

  return { ok: true };
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: DualLockConfig) {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely";
    releaseTradingOwnership("bots");
    broadcast();
    return;
  }

  let accounts = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, ownerSessionId),
    eq(accountsTable.isActive, true),
  )).limit(1);
  if (accounts.length === 0) {
    accounts = await db.select().from(accountsTable)
      .where(eq(accountsTable.sessionId, ownerSessionId)).limit(1);
  }

  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
  recoveryEngine.setPersistenceSession(ownerSessionId);

  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;
  const token = accounts.length > 0 ? (accounts[0]!.bearerToken ?? accounts[0]!.token ?? null) : null;
  const currency = accounts.length > 0 ? accounts[0]!.currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0]!.maxTradeStake) : 500;
  let botRecoveryMarkup = settings.length > 0 ? Number((settings[0] as any).botRecoveryMarkup ?? 10) : 10;
  let availableBalance = accounts.length > 0 && Number(accounts[0]!.balance) > 0
    ? Number(accounts[0]!.balance)
    : Number.POSITIVE_INFINITY;

  // Circuit-breaker threshold: the deepest loss ladder the pre-deploy bootstrap
  // considered plausible (p95), with 2 steps of headroom. Exceeding it means the
  // live regime is NOT the regime the lock was justified on — and since no
  // mid-session analysis is allowed, the only honest response is to halt.
  const predictedDepth = Math.max(3, Math.round(config.lockedAnalysis?.metrics?.["recoveryDepthP95"] ?? 4));
  const breakerDepth = predictedDepth + 2;

  let consecutiveErrors = 0;

  while (session.running && !session.stopRequested) {
    try {
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false;
        session.message = `⛔ Stopped — the ${owner ? tradingOwnerLabel(owner) : "other engine"} took over this account. One ledger = one engine.`;
        broadcast();
        return;
      }

      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) {
        session.message = "Stabilizing tick feed…";
        broadcast();
        await sleep(1000);
        continue;
      }

      // ── THE LOCK: mode selects the contract, nothing re-analyses it ────────
      const inRecovery = recoveryEngine.isInRecovery();
      const contract = inRecovery ? config.recovery : config.normal;

      // Contract sovereignty — checked on EVERY fire, both legs.
      const legOk = inRecovery
        ? isRecoveryContract(contract.side, contract.barrier)
        : isNormalContract(contract.side, contract.barrier);
      if (!legOk) {
        session.running = false;
        session.message = "⚠️ Contract integrity check failed — session halted before firing";
        broadcast();
        logger.error({ contract }, "Dual-Lock contract sovereignty violation");
        return;
      }

      // Circuit breaker.
      if (session.currentLossRun >= breakerDepth) {
        session.running = false;
        session.message = `🛑 Circuit breaker: ${session.currentLossRun} consecutive losses exceeds the ${predictedDepth}-step depth this lock was modelled for. The market has left its analysed regime — re-scan before redeploying.`;
        broadcast();
        logger.warn({ run: session.currentLossRun, breakerDepth }, "Dual-Lock circuit breaker tripped");
        return;
      }

      // ── Payout quote + stake ───────────────────────────────────────────────
      const payoutQuote = await resolveRecoveryPayout({
        symbol: config.symbol,
        contractType: contract.side,
        barrier: contract.barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      const payout = payoutQuote.payoutMultiplier;

      if (inRecovery) {
        try {
          const fresh = await db.select().from(settingsTable)
            .where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
          if (fresh.length > 0) {
            const v = Number((fresh[0] as any).botRecoveryMarkup);
            if (Number.isFinite(v)) botRecoveryMarkup = v;
          }
        } catch { /* keep the previous value */ }
      }

      // Shared recovery stake formula — identical to the other five bots.
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, payout, botRecoveryMarkup)
        : config.stake;

      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.currentStake = stake;
      session.currentMarket = config.displayName;
      session.currentContractType = `${contract.side} ${contract.barrier}`;
      session.message = inRecovery
        ? `🎯 [Recovery R${sharedStep}] ${contractLabel(contract)} on ${config.displayName} · $${stake.toFixed(2)}`
        : `⚡ ${contractLabel(contract)} on ${config.displayName} · $${stake.toFixed(2)}`;
      broadcast();

      // ── Journal ────────────────────────────────────────────────────────────
      const reason = `[${BOT_NAME}${inRecovery ? " RECOVERY" : ""}] locked ${contractLabel(contract)} · ` +
        `survival ${(((config.lockedAnalysis?.survival ?? 0)) * 100).toFixed(0)}% · ξ ${(config.lockedAnalysis?.clusterRatio ?? 1).toFixed(2)}`;
      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: config.symbol,
        displayName: config.displayName,
        contractType: contract.side,
        barrier: contract.barrier,
        stake: String(Math.round(stake * 100) / 100),
        direction: "hold",
        status: "open",
        aiConfidence: String(Math.round((inRecovery
          ? (config.lockedAnalysis?.recoveryConditional ?? 0.5)
          : (config.lockedAnalysis?.normalLcb ?? 0.7)) * 100)),
        aiRiskScore: "55",
        isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`,
        duration: 1,
        durationUnit: "t",
      }).returning();

      // ── Execute ────────────────────────────────────────────────────────────
      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(config.symbol) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: config.symbol,
            contractType: contract.side,
            stake: Math.round(stake * 100) / 100,
            duration: 1,
            durationUnit: "t",
            currency,
            accountId: accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            barrier: contract.barrier,
          });
          const result = await waitForContractResult(
            token!, accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            liveResult.contractId, 30_000,
          );
          won = result.won;
          profit = result.profit;
          entryPrice = Number(result.entrySpot) || liveResult.buyPrice;
          exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          logger.warn({ err }, "Dual-Lock live execution error — retrying");
          try {
            await db.update(tradesTable).set({
              status: "error", profit: "0", payout: "0", closedAt: new Date(),
              agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
            }).where(eq(tradesTable.id, journaled!.id));
          } catch { /* best-effort */ }
          session.message = `🔁 Retrying — ${friendlyErrorMessage(err)}`;
          broadcast();
          await sleep(1500);
          continue;
        }
      } else {
        // Paper mode: settle against the market's REAL next digit, not a
        // synthetic coin flip — this bot's whole thesis is the digit stream, so
        // paper results must be driven by it.
        const before = tickManager.getDigits(config.symbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 30; i++) {
          await sleep(120);
          const d = tickManager.getDigits(config.symbol, 1)[0];
          if (d !== undefined && d !== before) { digit = d; break; }
          digit = d;
        }
        const d = digit ?? 0;
        won = contract.side === "DIGITOVER" ? d > contract.barrier : d < contract.barrier;
        profit = won ? stake * (payout - 1) : -stake;
      }

      // ── Bookkeeping ────────────────────────────────────────────────────────
      session.tradeCount++;
      session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) {
        session.winCount++;
        session.lastResult = "won";
        session.currentLossRun = 0;
      } else {
        session.lossCount++;
        session.lastResult = "lost";
        session.currentLossRun++;
        session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun);
      }

      // Shared ledger — the same call the other five bots make.
      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, contract.side, payout);

      if (inRecovery) {
        session.consecutiveRecoveryLosses = won ? 0 : session.consecutiveRecoveryLosses + 1;
        if (!recoveryEngine.isInRecovery()) session.consecutiveRecoveryLosses = 0;
      }

      try {
        await db.update(tradesTable).set({
          status: won ? "won" : "lost",
          payout: String(won ? Math.round((stake + profit) * 100) / 100 : 0),
          profit: String(Math.round(profit * 100) / 100),
          entryPrice: String(entryPrice),
          exitPrice: String(exitPrice),
          closedAt: new Date(),
        }).where(eq(tradesTable.id, journaled!.id));
      } catch (dbErr) {
        logger.warn({ dbErr }, "Dual-Lock: failed to settle journaled trade");
      }

      if (!isLive && Number.isFinite(availableBalance)) {
        availableBalance = Math.max(0, availableBalance + profit);
      }
      if (isLive) {
        try {
          const newBal = await getLiveBalance(token!, accounts[0]?.derivAccountId ?? accounts[0]?.loginId);
          if (newBal !== null && accounts.length > 0) {
            availableBalance = newBal;
            await db.update(accountsTable)
              .set({ balance: String(newBal), updatedAt: new Date() })
              .where(eq(accountsTable.id, accounts[0]!.id));
          }
        } catch { /* best-effort */ }
      }

      broadcast();

      // ── TP / SL ────────────────────────────────────────────────────────────
      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached — locked session complete.`;
        broadcast();
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit. Session stopped safely.`;
        broadcast();
        return;
      }

      // Continuous cadence — a short settle pause only, never a re-analysis.
      await sleep(won ? 700 : 1100);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Dual-Lock stability catch");
      session.message = `Stabilizing engine — retry ${consecutiveErrors}/5`;
      broadcast();
      await sleep(Math.min(2000, 500 * consecutiveErrors));
      if (consecutiveErrors >= 5) {
        session.running = false;
        session.message = "Engine paused for stability check — please restart";
        broadcast();
        return;
      }
    }
  }

  if (!session.running
      && !session.message?.startsWith("✅")
      && !session.message?.startsWith("🛑")
      && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}

export { DUAL_LOCK_NORMAL_CONTRACTS, DUAL_LOCK_RECOVERY_CONTRACTS, contractLabel, contractKey };
