/**
 * TWIN-LOCK HEDGE SENTINEL — execution engine.
 *
 * THE OPERATING MODEL
 * ───────────────────
 *   • Normal round  : Over 4 + Under 5, SAME stake, fired on the SAME tick
 *                     through the shared bulk executor (all legs proposed in
 *                     one burst — same-tick entry by construction).
 *   • Recovery round  : Over 5 + Under 4, same mechanic, armed ONLY when BOTH
 *                     normal legs lost. A split round (one wins, one loses) is
 *                     deliberately IGNORED by the recovery logic — the small
 *                     payout-vs-stakes tax never triggers a ladder — exactly as
 *                     the product rule demands. The lost amount of a
 *                     both-lose round is TOTAL (2 × stake) and the recovery
 *                     pair is sized to digest that TOTAL.
 *   • Contracts are hard-wired. There is no user choice of contract anywhere;
 *                     the only post-scan choice is market handling: LOCK the
 *                     scanned market for the session, or SWITCH (the engine
 *                     rotates to the next best scanned market when the
 *                     boundary hazard on the current one measurably decays).
 *
 * WHAT THE ENGINE GUARANTEES
 * ──────────────────────────
 *   1. Same-tick alignment. The fire decision is taken on a FRESH tick (the
 *      loop waits on the tick stream, never on a timer) and both legs go
 *      through `executeBulkLiveTrades`, which bursts all proposals on one
 *      socket in one tick. A leg that the broker rejects is never left naked:
 *      the round degrades to the confirmed leg alone and NEVER arms recovery
 *      (both-lost is by definition both legs having traded and lost).
 *   2. The entry gate (`twinEntryGate`) refuses boundary entries: a current
 *      tick of 4 or 5, a side-crossing on the last tick, an elevated
 *      worst-case gap hazard, or a post-loss cool-down that has not expired.
 *      Recovery rounds keep the same gates but are never blocked forever —
 *      stranded debt is worse than an unfavourable recovery attempt — so the
 *      patience valve FORCES them after maxWaitTicks and logs `forced`.
 *   3. One shared recovery ledger, one shared stake formula. The pair's
 *      effective payout multiplier for the ledger is (min-leg payout − 1):
 *      a covered recovery round nets S·(m−2) per leg stake, so feeding the
 *      shared formula m−1 makes its divisor exactly m−2 and the debt (plus
 *      markup) is digested by the ROUND, not by a leg.
 *   4. Contract sovereignty: every leg is checked against the hard-wired
 *      vocabulary before every buy; a corrupted config halts the session.
 *   5. Circuit breaker on consecutive recovery failures + a Page–Hinkley
 *      style hazard watch that warns (locked) or rotates the market
 *      (switching) — it never rotates contracts.
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

export const TWIN_HEDGE_BOT_ID = "twinhedge";

const BOT_NAME = "Twin-Lock Hedge Sentinel";

/** Consecutive gate-refused ticks after which a RECOVERY round is forced. */
const RECOVERY_PATIENCE_TICKS = 12;
/** …and after which SWITCHING mode may rotate the market on a dry stream. */
const DRY_STREAM_TICKS = 30;
/** Ticks to wait after a gap-digit settlement before re-arming the gate. */
const BOUNDARY_COOLDOWN_TICKS = 3;
/**
 * Live hazard above which SWITCHING mode starts hunting another market. The
 * original .30/.23 split made a near-uniform ten-state stream wait forever
 * because the posterior upper bound is naturally above .23 on a small rolling
 * window. Keep the current-digit/crossing/cooldown checks; loosen only this
 * uncertainty ceiling so quality non-boundary entries can occur.
 */
const SWITCH_HAZARD = 0.34;
/** …and the score lead the alternative must show before we move. */
const SWITCH_MARGIN = 3;

export const TWIN_MIN_SCORE = 44;

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
  /** The scan candidate this market was deployed from. */
  lockedAnalysis?: TwinHedgeCandidate;
  /** Full ranked scan, used by switching mode to pick its next market. */
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
  gate?: { hazard: number; hazardWorst: number; reason: string };
  marketMode?: "locked" | "switching";
  message?: string;
  config?: Omit<TwinHedgeConfig, "ownerSessionId" | "rankedCandidates">;
  lock?: {
    symbol: string;
    displayName: string;
    normalPair: string;
    recoveryPair: string;
    survival: number;
    ruin: number;
    safeLcb: number;
    recoveryBreakEven: number;
    gapHazardWorst: number;
    crossingRate: number;
    clusterRatio: number;
    expectedMaxLossRun: number;
    recoveryDepthP95: number;
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
  /** Consecutive BOTH-LOSE rounds — the only run the breaker should feed on. */
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
    running: false,
    sessionId: null,
    config: null,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    bothWinCount: 0,
    splitCount: 0,
    bothLoseCount: 0,
    currentStake: 0,
    consecutiveRecoveryLosses: 0,
    currentLossRun: 0,
    deepestLossRun: 0,
    bothLoseRun: 0,
    stopRequested: false,
  };
}

const { state: session, replace: replaceSession } =
  createSessionScoped<SessionState>(freshSession);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

// ── Tick alignment ────────────────────────────────────────────────────────────

/**
 * Resolve on the next tick of `symbol` (or `null` after `timeoutMs`). The
 * engine takes EVERY decision on a fresh tick arrival: the round's two legs
 * settle on the tick after that arrival, so entering right after a tick
 * maximises the time the broker has to confirm BOTH buys before the settlement
 * tick — the physical basis of the same-tick guarantee.
 */
function nextTickFor(symbol: string, timeoutMs = 9_000): Promise<number | null> {
  return new Promise(resolve => {
    let done = false;
    const finish = (d: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      tickManager.off("tick", onTick);
      resolve(d);
    };
    const onTick = (tick: { symbol: string; lastDigit: number }) => {
      if (tick.symbol !== symbol) return;
      finish(tick.lastDigit);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    tickManager.on("tick", onTick);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): TwinHedgeStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const publicConfig = cfg
    ? (Object.fromEntries(
        Object.entries(cfg).filter(([k]) => k !== "ownerSessionId" && k !== "rankedCandidates"),
      ) as Omit<TwinHedgeConfig, "ownerSessionId" | "rankedCandidates">)
    : undefined;
  const a = cfg?.lockedAnalysis;
  return {
    running: session.running,
    botId: TWIN_HEDGE_BOT_ID,
    botName: BOT_NAME,
    sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    bothWinCount: session.bothWinCount,
    splitCount: session.splitCount,
    bothLoseCount: session.bothLoseCount,
    currentStake: session.currentStake,
    inRecovery: rec.inRecovery,
    recoveryStep: rec.recoveryStep,
    unrecoveredAmount: Math.round(rec.unrecoveredAmount * 100) / 100,
    recoveryTargetProfit: Math.round(rec.targetProfit * 100) / 100,
    recoveryRemainingTargetProfit: Math.round(rec.remainingTargetProfit * 100) / 100,
    consecutiveRecoveryLosses: session.consecutiveRecoveryLosses,
    deepestLossRun: session.deepestLossRun,
    bothLoseRun: session.bothLoseRun,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    lastRound: session.lastRound,
    gate: session.gate,
    marketMode: session.marketMode,
    message: session.message,
    config: publicConfig,
    lock: cfg
      ? {
          symbol: cfg.symbol,
          displayName: cfg.displayName,
          normalPair: pairLabel(TWIN_NORMAL_LEGS),
          recoveryPair: pairLabel(TWIN_RECOVERY_LEGS),
          survival: a?.survival ?? 0,
          ruin: a?.ruin ?? 0,
          safeLcb: a?.safeLcb ?? 0,
          recoveryBreakEven: a?.recoveryBreakEven ?? 0,
          gapHazardWorst: a?.gapHazardWorst ?? 0,
          crossingRate: a?.crossingRate ?? 0,
          clusterRatio: a?.clusterRatio ?? 1,
          expectedMaxLossRun: a?.expectedMaxGapRun ?? 0,
          recoveryDepthP95: a?.metrics?.["recoveryDepthP95"] ?? 0,
          signals: a?.signals ?? [],
        }
      : undefined,
  };
}

export function pairLabel(legs: readonly TwinLeg[]): string {
  return legs.map(legLabel).join(" + ");
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info("Twin-Lock session stopped");
}

// ── Pre-deploy scan ───────────────────────────────────────────────────────────

/**
 * Rank every digit-enabled market on ONE question: does its live boundary
 * structure let the twin pair survive? Gap-hazard, crossing rate, clustering,
 * stationarity, and a bootstrap of the real digit stream through the real
 * round mechanics. The console then offers LOCK (best market frozen) or
 * SWITCH (the engine may rotate inside this ranked universe).
 */
export async function scanTwinMarkets(
  ownerSessionId: string | undefined,
  simParams: {
    stake: number;
    takeProfit: number;
    stopLoss: number;
    maxRecoverySteps: number;
    markupPercent: number;
    maxStake: number;
  },
): Promise<TwinHedgeScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const all: TwinHedgeCandidate[] = [];
  let scanned = 0;

  for (const market of markets) {
    broadcastSSE("bot_scan_progress", {
      botId: TWIN_HEDGE_BOT_ID,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned,
      total: markets.length,
      results: screenAndRankTwin(all).slice(0, 8),
    }, ownerSessionId);

    const digits = tickManager.getDigits(market.symbol, 300);
    all.push(evaluateTwinMarket(market.symbol, market.displayName, digits, {
      stake: simParams.stake,
      takeProfit: simParams.takeProfit,
      stopLoss: simParams.stopLoss,
      maxRecoverySteps: simParams.maxRecoverySteps,
      markupPercent: simParams.markupPercent,
      payoutNormal: 1.95,
      payoutRecovery: 2.43,
    }));
    scanned++;
    await sleep(45);
  }

  const ranked = screenAndRankTwin(all);

  broadcastSSE("bot_scan_progress", {
    botId: TWIN_HEDGE_BOT_ID,
    scanning: null,
    symbol: null,
    scanned: markets.length,
    total: markets.length,
    results: ranked.slice(0, 12),
  }, ownerSessionId);

  if (ranked.length === 0) {
    return {
      suitable: false,
      best: null,
      allScored: [],
      reason: "No market has enough tick history yet (120+ digits needed) — wait a few seconds and re-scan",
    };
  }

  const best = ranked[0]!;
  const suitable = best.recoveryViable && best.score >= TWIN_MIN_SCORE;
  const reason = suitable
    ? `${best.displayName}: gap hazard ${Math.round(best.gapHazardWorst * 100)}% worst-case, worst-case gap-avoidance ${Math.round(best.safeLcb * 100)}% vs the ${Math.round(best.recoveryBreakEven * 100)}% digest line — the recovery pair can clear debt here. Simulated survival ${(best.survival * 100).toFixed(0)}%.`
    : !best.recoveryViable
      ? `Best market ${best.displayName} fails the digest test (q̂ ${Math.round(best.safeLcb * 100)}% < ${(best.recoveryBreakEven * 100).toFixed(1)}%): on a stream where 4 and 5 appear this often, BOTH recovery legs lose too often for the ladder to repay itself. Re-scan later — the boundary structure moves.`
      : `No market clears the ${TWIN_MIN_SCORE}-point composite right now (best: ${best.displayName}, score ${best.score}, survival ${(best.survival * 100).toFixed(0)}% under your TP/SL). The boundary structure is viable but the bootstrap says this exact session would not survive — a stream with no measurable edge is correctly refused. Re-scan after more history, or set wider TP/SL.`;

  return { suitable, best, allScored: ranked.slice(0, 12), reason };
}

// ── Session start ─────────────────────────────────────────────────────────────

export async function startSession(config: TwinHedgeConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A Twin-Lock session is already active — stop it first" };

  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return {
      ok: false,
      error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account. Stop it first — only one engine may own the shared recovery ledger.`,
    };
  }

  const fail = (error: string) => { releaseTradingOwnership("bots"); return { ok: false as const, error }; };

  if (config.stake < 0.35) return fail("Minimum stake is $0.35 (per leg — a round stakes 2×)");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (config.marketMode !== "locked" && config.marketMode !== "switching") {
    return fail("marketMode must be locked or switching");
  }
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  // Contract sovereignty at the door: the pair is hard-wired, nothing in a
  // request body can change it.
  for (const leg of TWIN_NORMAL_LEGS) {
    if (!isTwinNormalLeg(leg.side, leg.barrier)) return fail("Normal pair integrity check failed");
  }
  for (const leg of TWIN_RECOVERY_LEGS) {
    if (!isTwinRecoveryLeg(leg.side, leg.barrier)) return fail("Recovery pair integrity check failed");
  }

  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  replaceSession({
    ...freshSession(),
    running: true,
    sessionId: `bot_twinhedge_${Date.now()}`,
    config: { ...config, displayName: market?.displayName ?? config.displayName },
    currentStake: config.stake,
    marketMode: config.marketMode,
    currentMarket: market?.displayName ?? config.displayName,
    message:
      `🔁 ${config.marketMode === "locked" ? "Locked" : "Switching"} on ${market?.displayName ?? config.displayName}: ` +
      `normal ${pairLabel(TWIN_NORMAL_LEGS)} → recovery ${pairLabel(TWIN_RECOVERY_LEGS)}, both legs per tick.`,
  });

  logger.info({
    symbol: config.symbol,
    marketMode: config.marketMode,
    survival: config.lockedAnalysis?.survival,
  }, "Twin-Lock session starting");
  broadcast();

  const loopSessionId = config.ownerSessionId ?? getBrowserSessionId();
  runWithSessionId(loopSessionId, () => runLoop({ ...config, ownerSessionId: loopSessionId }).catch(err => {
    logger.error({ err }, "Twin-Lock runLoop error");
    session.running = false;
    session.message = `⚠️ ${friendlyErrorMessage(err)}`;
    broadcast();
  }).finally(() => releaseTradingOwnership("bots")));

  return { ok: true };
}

// ── Hazard bookkeeping (per live symbol) ──────────────────────────────────────

/** Rolling gap-hit tracking per symbol for the switch trigger. */
interface HazardWatch {
  hits: number;
  total: number;
  lastWasGap: boolean;
  ticksSinceBoundary: number;
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: TwinHedgeConfig) {
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

  // Working symbol/market — switching mode may move this; contracts may not.
  let symbol = config.symbol;
  let displayName = config.displayName;

  const predictedDepth = Math.max(3, Math.round(config.lockedAnalysis?.metrics?.["recoveryDepthP95"] ?? 4));
  const breakerDepth = predictedDepth + 2;

  let consecutiveErrors = 0;
  let waitedTicks = 0;
  let rounds = 0;
  const watches = new Map<string, HazardWatch>();

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

      // ── Wait for a FRESH tick on the working symbol, then decide ──────────
      const freshDigit = await nextTickFor(symbol, 9_000);
      if (freshDigit === null) {
        session.message = "Feed stalled — waiting for the next tick before any decision";
        broadcast();
        continue;
      }
      if (!session.running) break;

      const digits = tickManager.getDigits(symbol, 300);
      const watch = watches.get(symbol) ?? { hits: 0, total: 0, lastWasGap: false, ticksSinceBoundary: 0 };
      watch.total++;
      if (isGapDigit(freshDigit)) {
        watch.hits++;
        watch.lastWasGap = true;
        watch.ticksSinceBoundary = 0;
      } else {
        watch.lastWasGap = false;
        watch.ticksSinceBoundary++;
      }
      watches.set(symbol, watch);

      // Feed-age gate (killshot rule 4): a contract settles on the NEXT tick;
      // if the stream is older than 2.5× a nominal tick, "next" is unknowable.
      const age = tickManager.getTickAgeSeconds(symbol);
      if (age > 8) {
        session.message = `Stale feed on ${displayName} (${age.toFixed(1)}s) — refusing to fire`;
        continue;
      }

      // ── The only state that selects the round type: the shared ledger ─────
      const inRecovery = recoveryEngine.isInRecovery();
      const legs = inRecovery ? [...TWIN_RECOVERY_LEGS] : [...TWIN_NORMAL_LEGS];

      // Contract sovereignty on EVERY fire.
      const okSovereignty = inRecovery
        ? legs.every(l => isTwinRecoveryLeg(l.side, l.barrier))
        : legs.every(l => isTwinNormalLeg(l.side, l.barrier));
      if (!okSovereignty) {
        session.running = false;
        session.message = "⚠️ Pair integrity check failed — session halted before firing";
        broadcast();
        logger.error({ legs }, "Twin-Lock contract sovereignty violation");
        return;
      }

      // Circuit breaker: consecutive recovery failures.
      if (session.consecutiveRecoveryLosses > config.maxRecoverySteps) {
        session.running = false;
        session.message = `🛑 Circuit breaker: ${session.consecutiveRecoveryLosses} consecutive both-lose recovery rounds exceed the ${config.maxRecoverySteps}-step ladder budget. The boundary regime has outlived the scan — stop and re-scan.`;
        broadcast();
        logger.warn({ run: session.consecutiveRecoveryLosses }, "Twin-Lock circuit breaker tripped");
        return;
      }
      // Circuit breaker: loss-run depth vs the bootstrap p95.
      if (session.bothLoseRun >= breakerDepth) {
        session.running = false;
        session.message = `🛑 Circuit breaker: ${session.bothLoseRun} consecutive BOTH-LOSE rounds exceeds the ${predictedDepth}-step depth this scan modelled. The boundary regime has outlived the analysis — re-scan before redeploying. (Split rounds never count here: they are the hedge working.)`;
        broadcast();
        return;
      }

      // ── The gate: fire only on a tick that is measurably away from 4 and 5 ─
      const last = digits.length ? digits[digits.length - 1]! : freshDigit;
      const prev = digits.length > 1 ? digits[digits.length - 2]! : last;
      const crossedOnLastTick = (last <= 4) !== (prev <= 4);

      const gate = twinEntryGate({
        digits,
        mode: inRecovery ? "recovery" : "normal",
        // The prior 0.26/0.23 bars rejected most normal markets on the
        // Wilson-style upper bound even when the current tick was clean. A
        // 0.31/0.29 ceiling still refuses boundary digits, crossings, hot
        // recovery hazards and post-gap cooldowns, but permits measured trades.
        maxHazard: inRecovery ? 0.31 : 0.29,
        minSafeLcb: inRecovery
          ? recoveryBreakEvenGapRate(config.lockedAnalysis?.payoutRecovery ?? 2.43) + 0.01
          : 0,
        cooldownTicks: BOUNDARY_COOLDOWN_TICKS,
        ticksSinceBoundary: watch.ticksSinceBoundary,
        waitedTicks,
        maxWaitTicks: RECOVERY_PATIENCE_TICKS,
        crossedOnLastTick,
      });
      session.gate = {
        hazard: gate.hazard.p,
        hazardWorst: gate.hazard.pWorst,
        reason: gate.reason,
      };

      if (!gate.fire) {
        waitedTicks++;
        rounds++;
        // SWITCHING mode: a dry stream for too long, or an elevated hazard,
        // rotates to the next best market from the SAME scan. Locked mode only
        // warns — the lock is the product promise.
        const hazardElevated = gate.hazard.pWorst > SWITCH_HAZARD;
        if (config.marketMode === "switching"
          && (waitedTicks >= DRY_STREAM_TICKS || (hazardElevated && rounds % 10 === 0))) {
          const moved = await tryMarketSwitch(config, symbol, displayName, watches, ownerSessionId);
          if (moved) {
            symbol = moved.symbol;
            displayName = moved.displayName;
            // Keep the public lock card truthful after a real switch. The
            // pair remains hard-wired; only the active market and its fresh
            // analysis move.
            const movedAnalysis = config.rankedCandidates?.find((c) => c.symbol === moved.symbol);
            if (movedAnalysis) {
              session.config = { ...session.config!, symbol, displayName, lockedAnalysis: movedAnalysis };
            } else if (session.config) {
              session.config = { ...session.config, symbol, displayName };
            }
            waitedTicks = 0;
            continue;
          }
        }
        session.message = `⏸️ ${displayName}: gate held (${gate.reason})${
          config.marketMode === "switching" ? "" : " — locked, no rotation"}`;
        broadcast();
        continue;
      }
      waitedTicks = 0;

      // ── Payout quotes for BOTH legs (live proposals, cached briefly) ──────
      const [qa, qb] = await Promise.all([
        resolveRecoveryPayout({ symbol, contractType: legs[0]!.side, barrier: legs[0]!.barrier, duration: 1, durationUnit: "t", currency }),
        resolveRecoveryPayout({ symbol, contractType: legs[1]!.side, barrier: legs[1]!.barrier, duration: 1, durationUnit: "t", currency }),
      ]);
      const payoutA = qa.payoutMultiplier;
      const payoutB = qb.payoutMultiplier;

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

      // Per-leg stake. Normal: the flat base stake (both legs identical — the
      // hedge is only a hedge when the stakes match). Recovery: the shared
      // debt-driven formula fed the PAIR's effective net-profit rate: a covered
      // round nets S·(m−2), so the multiplier we hand the ledger is m−1 and
      // its (payout−1) divisor becomes exactly (m−2) on the MIN leg payout.
      const minRecPayout = Math.min(payoutA, payoutB);
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(
            config.stake, maxStake, availableBalance,
            Math.max(1.05, minRecPayout - 1), botRecoveryMarkup,
          )
        : config.stake;

      const roundId = `R${session.tradeCount + 1}`;
      session.currentStake = stake;
      session.currentMarket = displayName;
      session.currentContractType = `${pairLabel(legs)} @ ${roundId}`;
      session.message = inRecovery
        ? `🎯 [Recovery R${recoveryEngine.getState().recoveryStep}] ${roundId} ${pairLabel(legs)} on ${displayName} · $${stake.toFixed(2)} × 2 · ${gate.forced ? "FORCED · " : ""}${gate.reason}`
        : `⚡ ${roundId} ${pairLabel(legs)} on ${displayName} · $${stake.toFixed(2)} × 2 · hazard ${Math.round(gate.hazard.pWorst * 100)}%`;
      broadcast();

      // ── Journal: one row per leg, tied together by the round id ──────────
      // Normal rounds record the hazard read; the digest line is printed only
      // where it actually decides the round — recovery.
      const reasonText = `[${BOT_NAME}${inRecovery ? " RECOVERY" : ""}] ${roundId} ${inRecovery ? "recovery" : "normal"} pair · ` +
        `hazard ${Math.round(gate.hazard.pWorst * 100)}% (q̂ ${Math.round(gate.hazard.safeLcb * 100)}%)` +
        (inRecovery ? ` vs ${Math.round(recoveryBreakEvenGapRate(minRecPayout) * 100)}% digest` : "") +
        ` · ${pairLabel(legs)}`;
      const journaled = await Promise.all(legs.map(leg =>
        db.insert(tradesTable).values({
          sessionId: ownerSessionId,
          symbol,
          displayName,
          contractType: leg.side,
          barrier: leg.barrier,
          stake: String(Math.round(stake * 100) / 100),
          direction: "hold",
          status: "open",
          aiConfidence: String(Math.round(clamp01(gate.hazard.safe) * 100)),
          aiRiskScore: inRecovery ? "62" : "48",
          isAutonomous: true,
          agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reasonText} · gate: ${gate.reason}`,
          duration: 1,
          durationUnit: "t",
        }).returning(),
      ));

      // ── Execute both legs ──────────────────────────────────────────────────
      type LegSettle = { won: boolean; profit: number; executed: boolean; entry: number; exit: number };
      let settleA: LegSettle;
      let settleB: LegSettle;
      const entryPrice = tickManager.getLatestPrice(symbol) ?? 0;

      if (isLive) {
        let legsResult: Awaited<ReturnType<typeof executeBulkLiveTrades>>;
        try {
          legsResult = await executeBulkLiveTrades(token!, accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            legs.map(leg => ({
              symbol,
              contractType: leg.side,
              stake: Math.round(stake * 100) / 100,
              duration: 1,
              durationUnit: "t",
              currency,
              barrier: leg.barrier,
            })),
          );
        } catch (err) {
          await settleErrorRows(journaled, `${reasonText} [BATCH FAILED: ${friendlyErrorMessage(err, { max: 160 })}]`);
          session.message = `🔁 Retrying round — ${friendlyErrorMessage(err)}`;
          broadcast();
          await sleep(1200);
          continue;
        }

        const opened = legsResult
          .map((l, i) => (!("error" in l) ? i : -1))
          .filter(i => i >= 0);
        if (opened.length === 0) {
          await settleErrorRows(journaled, `${reasonText} [EVERY LEG REJECTED]`);
          session.message = `🔁 Both legs rejected — retrying next tick`;
          broadcast();
          await sleep(1200);
          continue;
        }

        let results: Awaited<ReturnType<typeof waitForBulkContractResults>> = [];
        try {
          results = await waitForBulkContractResults(
            token!, accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            opened.map(i => (legsResult[i] as { contractId: number }).contractId),
            30_000,
          );
        } catch (err) {
          logger.warn({ err }, "Twin-Lock settlement sweep failed — retrying poll");
          results = [];
        }

        const settleOne = (i: number): LegSettle => {
          const l = legsResult[i];
          if ("error" in l) return { won: false, profit: 0, executed: false, entry: 0, exit: 0 };
          const r = results.find(x => x.contractId === l.contractId);
          if (!r || r.missing) {
            return { won: false, profit: 0, executed: true, entry: l.buyPrice, exit: l.buyPrice };
          }
          return { won: r.won, profit: r.profit, executed: true, entry: r.entrySpot || l.buyPrice, exit: r.exitSpot || l.buyPrice };
        };
        settleA = settleOne(0);
        settleB = settleOne(1);

        // A leg the broker never executed is NOT a loss — its stake was never
        // taken. The round settles on the confirmed leg alone and, per product
        // rule, can never arm recovery by itself.
        for (let i = 0; i < 2; i++) {
          const s = i === 0 ? settleA : settleB;
          const row = journaled[i]![0];
          if (!s.executed) {
            try {
              await db.update(tradesTable).set({
                status: "error", profit: "0", payout: "0", closedAt: new Date(),
                agentReasoning: `${reasonText} [LEG NOT EXECUTED]`,
              }).where(eq(tradesTable.id, row!.id));
            } catch { /* best-effort */ }
          }
        }
      } else {
        // Paper mode: BOTH legs settle on the SAME fresh tick we just waited
        // for — that is literally what the bot promises. With a 15%
        // probability leg B settles a tick late, reproducing the execution
        // skew real brokers produce under load (the only route to both-win
        // windfalls and both-lose disasters) so paper telemetry matches live.
        const dA = last;
        let dB = dA;
        if (Math.random() < 0.15) {
          const late = await nextTickFor(symbol, 9_000);
          if (late !== null) dB = late;
        }
        const winA = legWins(legs[0]!, dA);
        const winB = legWins(legs[1]!, dB);
        const profitFor = (won: boolean, payout: number) =>
          won ? Math.round(stake * (payout - 1) * 100) / 100 : -stake;
        settleA = { won: winA, profit: profitFor(winA, payoutA), executed: true, entry: entryPrice, exit: entryPrice };
        settleB = { won: winB, profit: profitFor(winB, payoutB), executed: true, entry: entryPrice, exit: entryPrice };
      }

      // ── Round settlement ───────────────────────────────────────────────────
      const executedCount = (settleA.executed ? 1 : 0) + (settleB.executed ? 1 : 0);
      const netProfit = (settleA.executed ? settleA.profit : 0) + (settleB.executed ? settleB.profit : 0);
      const bothExecuted = executedCount === 2;
      const bothLost = bothExecuted && !settleA.won && !settleB.won;
      const bothWon = bothExecuted && settleA.won && settleB.won;
      const roundWon = netProfit > 0;
      const totalStake = stake * executedCount;

      // Update the two leg rows.
      await Promise.all([settleRow(journaled[0]![0]!, settleA, stake, reasonText), settleRow(journaled[1]![0]!, settleB, stake, reasonText)]);

      // ── The shared ledger, once per ROUND, only for what it means ─────────
      //   normal split  → IGNORED (never enters recovery; "only both-lost
      //                   arms the ladder" — the split tax lives in P&L only)
      //   normal both-lost → record a loss with the TOTAL staked (2 × stake)
      //   any net-positive round → record a win (clears/reduces debt)
      if (inRecovery) {
        recoveryEngine.recordOutcome(roundWon, netProfit, totalStake, config.maxRecoverySteps, legs[0]!.side, Math.max(1.05, minRecPayout - 1));
      } else if (bothLost) {
        // payoutMultiplier = 1 keeps the aspirational target at $0: recovery
        // for THIS bot digests exactly the lost amount, nothing more.
        recoveryEngine.recordOutcome(false, netProfit, totalStake, config.maxRecoverySteps, "TWINPAIR", 1);
      } else if (roundWon) {
        recoveryEngine.recordOutcome(true, netProfit, totalStake, config.maxRecoverySteps, "TWINPAIR", 1);
      }

      // ── Session bookkeeping ────────────────────────────────────────────────
      session.tradeCount++;
      session.totalProfit = Math.round((session.totalProfit + netProfit) * 100) / 100;
      if (roundWon) {
        session.winCount++;
        session.lastResult = "won";
        session.currentLossRun = 0;
        session.bothLoseRun = 0;
      } else if (netProfit < 0) {
        session.lossCount++;
        session.lastResult = "lost";
        session.currentLossRun++;
        session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun);
        // The breaker feeds on the LADDER's enemy — consecutive rounds where
        // both legs actually lost. Split rounds bleed a fixed tax and must
        // never look like a runaway recovery depth.
        if (bothLost) session.bothLoseRun++;
      } else {
        session.lastResult = "flat";
      }
      if (bothWon) session.bothWinCount++;
      else if (bothLost) session.bothLoseCount++;
      else if (bothExecuted) session.splitCount++;

      if (inRecovery) {
        session.consecutiveRecoveryLosses = bothLost
          ? session.consecutiveRecoveryLosses + 1
          : (recoveryEngine.isInRecovery() ? session.consecutiveRecoveryLosses : 0);
        if (!recoveryEngine.isInRecovery()) session.consecutiveRecoveryLosses = 0;
      }

      session.lastRound = {
        mode: inRecovery ? "recovery" : "normal",
        legs: [
          { contract: legLabel(legs[0]!), won: settleA.won, profit: Math.round(settleA.profit * 100) / 100 },
          { contract: legLabel(legs[1]!), won: settleB.won, profit: Math.round(settleB.profit * 100) / 100 },
        ],
        net: Math.round(netProfit * 100) / 100,
        hazard: gate.hazard.pWorst,
        forced: gate.forced === true,
        market: displayName,
        at: Date.now(),
      };

      if (!isLive && Number.isFinite(availableBalance)) {
        availableBalance = Math.max(0, availableBalance + netProfit);
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
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached — ${session.bothWinCount} both-wins, ${session.splitCount} splits (ignored), ${session.bothLoseCount} recoveries armed.`;
        broadcast();
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit. Session stopped safely.`;
        broadcast();
        return;
      }

      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Twin-Lock stability catch — keeping the session alive");
      session.message = `Engine stabilizing… retry ${consecutiveErrors} — the session keeps running`;
      broadcast();
      await sleep(Math.min(15000, 600 * consecutiveErrors));
    }
  }

  if (!session.running
      && !session.message?.startsWith("✅")
      && !session.message?.startsWith("🛑")
      && !session.message?.startsWith("⚠️")
      && !session.message?.startsWith("⛔")) {
    session.message = "Session stopped";
    broadcast();
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

async function settleRow(
  row: { id: number } | undefined,
  s: { won: boolean; profit: number; executed: boolean; entry: number; exit: number },
  stake: number,
  reasonText: string,
) {
  if (!row || !s.executed) return;
  try {
    await db.update(tradesTable).set({
      status: s.won ? "won" : "lost",
      payout: String(s.won ? Math.round((stake + s.profit) * 100) / 100 : 0),
      profit: String(Math.round(s.profit * 100) / 100),
      entryPrice: String(s.entry),
      exitPrice: String(s.exit),
      closedAt: new Date(),
    }).where(eq(tradesTable.id, row.id));
  } catch (err) {
    logger.warn({ err }, "Twin-Lock: failed to settle journaled leg");
  }
}

async function settleErrorRows(
  journaled: Array<Array<{ id: number } | undefined> | undefined>,
  note: string,
) {
  for (const ret of journaled) {
    const row = ret?.[0];
    if (!row) continue;
    try {
      await db.update(tradesTable).set({
        status: "error", profit: "0", payout: "0", closedAt: new Date(),
        agentReasoning: note,
      }).where(eq(tradesTable.id, row.id));
    } catch { /* best-effort */ }
  }
}

// ── Market rotation (switching mode only) ─────────────────────────────────────

/**
 * Re-score the scanned universe from LIVE tick buffers (no proposals, no deep
 * pulls) and, when another market's boundary structure measurably beats the
 * current one, rotate to it. The CONTRACTS NEVER ROTATE — the pair is frozen
 * for the engagement; only the market moves. Returns null when nothing beats
 * the current market by SWITCH_MARGIN.
 */
async function tryMarketSwitch(
  config: TwinHedgeConfig,
  currentSymbol: string,
  currentDisplayName: string,
  watches: Map<string, HazardWatch>,
  ownerSessionId: string,
): Promise<{ symbol: string; displayName: string } | null> {
  const universe = config.rankedCandidates?.length
    ? config.rankedCandidates
    : undefined;
  if (!universe || universe.length < 2) return null;

  const sim: Parameters<typeof evaluateTwinMarket>[3] = {
    stake: config.stake,
    takeProfit: config.takeProfit,
    stopLoss: config.stopLoss,
    maxRecoverySteps: config.maxRecoverySteps,
    markupPercent: 10,
    payoutNormal: 1.95,
    payoutRecovery: 2.43,
  };

  let current: TwinHedgeCandidate | null = null;
  const freshScores: TwinHedgeCandidate[] = [];
  for (const cand of universe.slice(0, 8)) {
    const digits = tickManager.getDigits(cand.symbol, 300);
    const evalled = evaluateTwinMarket(cand.symbol, cand.displayName, digits, sim);
    freshScores.push(evalled);
    if (cand.symbol === currentSymbol) current = evalled;
  }
  if (!current) {
    const digits = tickManager.getDigits(currentSymbol, 300);
    current = evaluateTwinMarket(currentSymbol, currentDisplayName, digits, sim);
  }

  const best = freshScores
    .filter(c => c.symbol !== currentSymbol && c.recoveryViable)
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score <= (current?.score ?? 0) + SWITCH_MARGIN) return null;

  broadcastSSE("bot_update", {
    ...getStatus(),
    message: `🔀 Switching ${currentDisplayName} → ${best.displayName} (gap hazard ${Math.round(edgeHazard(tickManager.getDigits(best.symbol, 300)).pWorst * 100)}% there vs ${Math.round(current.gapHazardWorst * 100)}% here)`,
  }, ownerSessionId);
  logger.info({ from: currentSymbol, to: best.symbol, lead: best.score - (current?.score ?? 0) }, "Twin-Lock market switch");
  return { symbol: best.symbol, displayName: best.displayName };
}

// ── Re-exports the routes layer uses ──────────────────────────────────────────

export { TWIN_NORMAL_LEGS, TWIN_RECOVERY_LEGS, legLabel, pairLabel as pairText, edgeHazard };
