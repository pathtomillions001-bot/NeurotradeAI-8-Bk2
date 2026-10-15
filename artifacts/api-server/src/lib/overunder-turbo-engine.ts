/**
 * Over/Under Turbo — execution engine.
 *
 * THE OPERATING MODEL (and how it differs from every other over/under bot)
 * ────────────────────────────────────────────────────────────────────────
 *   ALL analysis happens ONCE, before the first trade. `scanForTurbo` crawls
 *   every digit-enabled market × the four normal barriers × the four recovery
 *   barriers and returns the single best (market, normal, recovery) triple. The
 *   user then deploys it in one of two market modes:
 *
 *     LOCKED     — trade that exact market for the whole session, never move.
 *     SWITCHING  — trade it, but if (and ONLY if) the market turns measurably
 *                  unfavorable, move the fire budget to a better tape. The
 *                  chosen barriers NEVER change; only WHERE we fire can.
 *
 *   After deploy the engine ARMS ONCE — it waits for a good entry tick on the
 *   locked normal contract (short-window win rate ≥ break-even) — and then runs
 *   NON-STOP: normal contract while the shared ledger says "no debt", recovery
 *   contract while it says "debt", one trade settling straight into the next
 *   with no re-analysis, no gating and no re-scanning, until take-profit or
 *   stop-loss. That continuous, back-to-back cadence is the product requirement.
 *
 *   The ONLY things that can interrupt the fire cadence:
 *     · TP / SL — the session's own boundaries (the user asked for these);
 *     · the circuit breaker — a realised loss run deeper than the pre-deploy
 *       bootstrap modelled, i.e. the live market has left the regime the lock was
 *       justified on (no mid-session analysis is allowed, so halting is honest);
 *     · SWITCHING rescue — and only when the active market is genuinely bad.
 *
 * NON-NEGOTIABLES INHERITED FROM THE SECTION (identical to the other bots)
 * ────────────────────────────────────────────────────────────────────────
 *   · the ONE shared recovery ledger (`lib/agents/recovery-engine.ts`) — no
 *     private debt state here, so this bot recovers exactly like the others;
 *   · the ONE shared recovery stake formula (`getBotRecoveryStake`,
 *     debt × (1 + markup) / (payout − 1), user-adjustable markup);
 *   · the single-executor arbiter (`lib/engine-arbiter.ts`, owner `bots`),
 *     keyed PER ACCOUNT so two connected Deriv accounts never collide;
 *   · ONE engine state per account session (`createSessionScoped`) — the fix
 *     from the bot-session-isolation work: a second account starting this bot
 *     must never stop, replace or read the first account's session;
 *   · trade journaling, TP/SL boundaries, live/paper execution paths.
 *
 *   Contract sovereignty: the normal leg is checked against the fixed normal
 *   barrier set and the recovery leg against the fixed recovery set immediately
 *   before EVERY buy, so a bug upstream can never make this bot fire a contract
 *   outside its spec.
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
import { registerBotEngine, runningOtherEngines } from "./engine-registry";
import { resolveRecoveryPayout } from "./recovery-payout";
import * as recoveryEngine from "./agents/recovery-engine";
import {
  acquireTradingOwnership,
  releaseTradingOwnership,
  hasTradingOwnership,
  currentTradingOwner,
  tradingOwnerLabel,
} from "./engine-arbiter";
import { createSessionScoped, runWithSession } from "./session";
import { registerLiveBot, unregisterLiveBot } from "./live-registry";
import { evaluateMarket } from "./dual-lock-analysis";
import {
  TURBO_NORMAL_CONTRACTS,
  TURBO_RECOVERY_CONTRACTS,
  contractLabel,
  contractKey,
  isNormalContract,
  isRecoveryContract,
  winSet,
  evaluateDualLockCandidate,
  screenAndRank,
  isDeployable,
  armEntryRead,
  turboMarketHealth,
  rankTurboCandidates,
  type TurboCandidate,
  type TurboContract,
  type TurboScanResult,
  type SessionSimParams,
} from "./overunder-turbo-analysis";

export const TURBO_BOT_ID = "overunder-turbo";
export const TURBO_BOT_NAME = "Over/Under Turbo";

/** Every trade is a 1-tick over/under contract — the fastest possible cadence. */
const DURATION = 1;
const DURATION_UNIT = "t";
/** Digits pulled per market during the one-shot pre-deploy scan. */
const SCAN_DIGITS = 300;
/** Live window used for the cheap arm-entry / favorability reads. */
const LIVE_WINDOW = 200;
/** Arm anyway after this long even if no clean entry tick appeared. */
const ARM_TIMEOUT_MS = 30_000;
/** How often (ms) the switching rescue re-checks the active market's health. */
const RESCUE_CHECK_MS = 12_000;
/** Consecutive unfavorable health reads before we actually look for a new tape. */
const RESCUE_STREAK = 2;
/** Minimum cooldown between two switching moves (anti-flap). */
const SWITCH_COOLDOWN_MS = 45_000;
/** A challenger must beat the active market's score by this much to win the seat. */
const SWITCH_MARGIN = 4;
/** Continuous cadence pauses — short, never a re-analysis. */
const SETTLE_WIN_MS = 120;
const SETTLE_LOSS_MS = 200;

export interface TurboConfig {
  ownerSessionId?: string;
  /** Frozen market at deploy time (switching mode may move it later). */
  symbol: string;
  displayName: string;
  /** Frozen normal contract. */
  normal: TurboContract;
  /** Frozen recovery contract. */
  recovery: TurboContract;
  /** LOCKED never moves; SWITCHING leaves only an unfavorable market. */
  marketMode: "locked" | "switching";
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  /** Pre-deploy bootstrap telemetry — circuit breaker + UI. */
  lockedAnalysis?: TurboCandidate;
}

export interface TurboLock {
  symbol: string;
  displayName: string;
  normal: string;
  recovery: string;
  marketMode: "locked" | "switching";
  survival: number;
  ruin: number;
  clusterRatio: number;
  normalLcb: number;
  recoveryConditional: number;
  expectedMaxLossRun: number;
  recoveryDepthP95: number;
  signals: string[];
}

export interface TurboWatch {
  /** arming = waiting for the entry tick; trading = non-stop turbo. */
  phase: "arming" | "trading";
  mode: "normal" | "recovery";
  market: string;
  contract: string;
  stake: number;
  /** Live short-window win rate of the locked normal contract (0..1). */
  recentRate: number;
  /** Break-even rate of the locked normal contract (0..1). */
  breakEven: number;
  /** True while the active market passes the favorability health check. */
  marketFavorable: boolean;
  /** Why the market is unfavorable (empty when favorable). */
  healthReason: string;
  /** Switching-mode leaderboard (top alternative tapes by score). */
  switchBoard?: Array<{ name: string; score: number; survival: number }>;
  /** Human-readable line for the console. */
  reason: string;
  switches: number;
  ticksWatched: number;
}

export interface TurboStatus {
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
  deepestLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: Omit<TurboConfig, "ownerSessionId">;
  turboLock?: TurboLock;
  turboWatch?: TurboWatch;
}

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: TurboConfig | null;
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
  watch: TurboWatch;
}

function freshWatch(): TurboWatch {
  return {
    phase: "arming",
    mode: "normal",
    market: "—",
    contract: "—",
    stake: 0,
    recentRate: 0,
    breakEven: 0,
    marketFavorable: true,
    healthReason: "",
    reason: "",
    switches: 0,
    ticksWatched: 0,
  };
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
    watch: freshWatch(),
  };
}

// ── ONE STATE PER ACCOUNT SESSION ─────────────────────────────────────────────
// Every read/write of `session` resolves through AsyncLocalStorage to the
// CALLING account's own state, so two connected Deriv accounts can run Over/Under
// Turbo concurrently without one stopping, replacing or reading the other. This
// is the exact contract pinned by bot-session-isolation.test.ts for the other
// engines, and the turbo engine inherits it verbatim.
const { state: session, replace: replaceSession } =
  createSessionScoped<SessionState>(freshSession);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function broadcast() {
  const owner = session.config?.ownerSessionId;
  if (owner) broadcastSSE("bot_update", getStatus(), owner);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

registerBotEngine(TURBO_BOT_ID, () => ({
  running: session.running,
  name: TURBO_BOT_NAME,
}));

export function isRunning(): boolean {
  return session.running;
}

function lockOf(cfg: TurboConfig | null): TurboLock | undefined {
  if (!cfg) return undefined;
  const a = cfg.lockedAnalysis;
  return {
    symbol: cfg.symbol,
    displayName: cfg.displayName,
    normal: contractLabel(cfg.normal),
    recovery: contractLabel(cfg.recovery),
    marketMode: cfg.marketMode,
    survival: a?.survival ?? 0,
    ruin: a?.ruin ?? 0,
    clusterRatio: a?.clusterRatio ?? 1,
    normalLcb: a?.normalLcb ?? 0,
    recoveryConditional: a?.recoveryConditional ?? 0,
    expectedMaxLossRun: a?.expectedMaxLossRun ?? 0,
    recoveryDepthP95: a?.metrics?.["recoveryDepthP95"] ?? 0,
    signals: a?.signals ?? [],
  };
}

export function getStatus(): TurboStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const publicConfig = cfg
    ? (Object.fromEntries(
        Object.entries(cfg).filter(([k]) => k !== "ownerSessionId"),
      ) as Omit<TurboConfig, "ownerSessionId">)
    : undefined;
  return {
    running: session.running,
    botId: TURBO_BOT_ID,
    botName: TURBO_BOT_NAME,
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
    turboLock: lockOf(cfg),
    turboWatch: session.running ? session.watch : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots", session.config?.ownerSessionId);
  unregisterLiveBot(TURBO_BOT_ID);
  broadcast();
  logger.info("Over/Under Turbo session stopped");
}

// ── Pre-deploy scan ───────────────────────────────────────────────────────────

/**
 * The whole intelligence of this bot, spent once: an exhaustive pass over every
 * digit-enabled market × the four normal barriers × the four recovery barriers,
 * with the loss-clustering / stationarity / conditional-recovery / bootstrap
 * survival machinery, then a Benjamini–Hochberg screen. Returns the single best
 * market with its best normal and best recovery barrier.
 */
export async function scanForTurbo(
  ownerSessionId: string | undefined,
  simParams: SessionSimParams,
): Promise<TurboScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
  const all: TurboCandidate[] = [];
  let scanned = 0;

  for (const market of markets) {
    broadcastSSE(
      "bot_scan_progress",
      {
        botId: TURBO_BOT_ID,
        scanning: market.displayName,
        symbol: market.symbol,
        scanned,
        total: markets.length,
        results: screenAndRank(all).slice(0, 8),
      },
      ownerSessionId,
    );

    let digits = tickManager.getDigits(market.symbol, SCAN_DIGITS);
    if (digits.length < 120) {
      // Top up from recent history when the live buffer is still shallow.
      digits = digits.length ? digits : [];
    }
    const candidates = evaluateMarket(market.symbol, market.displayName, digits, {
      ...simParams,
      simulate: true,
    });
    all.push(...candidates);
    scanned++;
    // Yield so the event loop (and the tick feed) keeps breathing.
    await sleep(50);
  }

  const result = rankTurboCandidates(all, markets.length);

  broadcastSSE(
    "bot_scan_progress",
    {
      botId: TURBO_BOT_ID,
      scanning: null,
      symbol: null,
      scanned: markets.length,
      total: markets.length,
      results: result.allScored.slice(0, 8),
    },
    ownerSessionId,
  );

  return result;
}

// ── Session start ─────────────────────────────────────────────────────────────

export async function startSession(
  config: TurboConfig,
): Promise<{ ok: boolean; error?: string }> {
  const owner = config.ownerSessionId;
  if (session.running) {
    return {
      ok: false,
      error: `${TURBO_BOT_NAME} is already active on this account — stop it first`,
    };
  }
  // One executing bot engine at a time PER ACCOUNT (protects the single ledger).
  const otherEngines = runningOtherEngines(TURBO_BOT_ID);
  if (otherEngines.length > 0) {
    return {
      ok: false,
      error: `${otherEngines[0]!.name} is already trading on this account. Stop it first — one engine at a time owns the shared recovery ledger.`,
    };
  }
  if (!acquireTradingOwnership("bots", owner)) {
    const who = currentTradingOwner(owner);
    return {
      ok: false,
      error: `The ${who ? tradingOwnerLabel(who) : "another engine"} is currently trading on this account. Stop it first — only one engine may own the shared recovery ledger.`,
    };
  }
  const fail = (error: string) => {
    releaseTradingOwnership("bots", owner);
    return { ok: false as const, error };
  };

  if (config.stake < 0.35) return fail("Minimum stake is $0.35");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isNormalContract(config.normal.side, config.normal.barrier)) {
    return fail("Normal contract must be Over 1, Over 2, Under 7 or Under 8");
  }
  if (!isRecoveryContract(config.recovery.side, config.recovery.barrier)) {
    return fail("Recovery contract must be Over 4, Over 5, Under 4 or Under 5");
  }
  if (!isAutomatedMarket(config.symbol)) {
    return fail(`${config.symbol} cannot be traded by this bot`);
  }
  const market = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === config.symbol);
  if (!market?.digitEnabled) return fail("This bot needs a digit-enabled market");

  replaceSession({
    ...freshSession(),
    running: true,
    sessionId: `bot_turbo_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    message:
      config.marketMode === "locked"
        ? `Locked on ${config.displayName}: ${contractLabel(config.normal)} → recovery ${contractLabel(
            config.recovery,
          )}. Waiting for the best entry to start the non-stop run…`
        : `Deployed on ${config.displayName}: ${contractLabel(config.normal)} → recovery ${contractLabel(
            config.recovery,
          )}. Switching armed — waiting for the best entry…`,
  });
  session.watch.breakEven = 1 / (config.lockedAnalysis?.normalPayout ?? 1.25);
  session.watch.market = config.displayName;
  session.watch.contract = contractLabel(config.normal);

  logger.info(
    {
      symbol: config.symbol,
      normal: contractKey(config.normal),
      recovery: contractKey(config.recovery),
      marketMode: config.marketMode,
      survival: config.lockedAnalysis?.survival,
    },
    "Over/Under Turbo session starting",
  );
  registerLiveBot(TURBO_BOT_ID, () => getStatus());
  broadcast();

  runWithSession(owner ?? "legacy", () =>
    runLoop(config)
      .catch((err) => {
        logger.error({ err }, "Over/Under Turbo runLoop error");
        session.running = false;
        session.message = `⚠️ ${friendlyErrorMessage(err)}`;
        broadcast();
      })
      .finally(() => {
        releaseTradingOwnership("bots", owner);
        unregisterLiveBot(TURBO_BOT_ID);
      }),
  );

  return { ok: true };
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: TurboConfig) {
  const owner = config.ownerSessionId;
  if (!owner) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely";
    releaseTradingOwnership("bots", owner);
    broadcast();
    return;
  }

  let accounts = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.sessionId, owner), eq(accountsTable.isActive, true)))
    .limit(1);
  if (accounts.length === 0) {
    accounts = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.sessionId, owner))
      .limit(1);
  }
  const settings = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.sessionId, owner))
    .limit(1);
  recoveryEngine.setPersistenceSession(owner);

  // Read THIS account's persisted recovery ledger before the first trade, so a
  // restart never re-opens normal trades while the journal still shows debt.
  const persistedRecovery = (settings[0] as any)?.recoveryStateJson;
  if (persistedRecovery) {
    try {
      recoveryEngine.hydrateStateIfNeeded(persistedRecovery);
    } catch {
      /* malformed row — this account's ledger starts fresh */
    }
  }

  const paperTradeMode =
    settings.length > 0 ? ((settings[0] as any).paperTradeMode ?? false) : false;
  const token =
    accounts.length > 0 ? (accounts[0]!.bearerToken ?? accounts[0]!.token ?? null) : null;
  const currency = accounts.length > 0 ? accounts[0]!.currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0]!.maxTradeStake) : 500;
  let botRecoveryMarkup =
    settings.length > 0 ? Number((settings[0] as any).botRecoveryMarkup ?? 10) : 10;
  let availableBalance =
    accounts.length > 0 && Number(accounts[0]!.balance) > 0
      ? Number(accounts[0]!.balance)
      : Number.POSITIVE_INFINITY;

  // Circuit-breaker threshold: the deepest loss ladder the pre-deploy bootstrap
  // considered plausible (p95), with 2 steps of headroom.
  const predictedDepth = Math.max(
    3,
    Math.round(config.lockedAnalysis?.metrics?.["recoveryDepthP95"] ?? 4),
  );
  const breakerDepth = predictedDepth + 2;

  // ── Live session state (the market can move in switching mode; barriers never do) ──
  let activeSymbol = config.symbol;
  let activeName = config.displayName;
  const normal = config.normal;
  const recovery = config.recovery;
  const locked = config.marketMode === "locked";

  let phase: "arming" | "trading" = "arming";
  let armed = false;
  const armStart = Date.now();
  let lastRescue = 0;
  let lastSwitch = 0;
  let unfavorableStreak = 0;
  let consecutiveErrors = 0;

  const readLive = (symbol: string, count = LIVE_WINDOW): number[] =>
    tickManager.getDigits(symbol, count);

  /**
   * SWITCHING RESCUE — runs only when the active market has turned unfavorable.
   * Keeps the barriers frozen and re-chooses WHERE to fire: every digit market is
   * scored for the locked (normal, recovery) pair and the best is taken, but only
   * if it beats the active market by a clear margin (hysteresis). Returns true if
   * it moved.
   */
  async function switchingRescue(): Promise<boolean> {
    const sim: SessionSimParams = {
      stake: config.stake,
      takeProfit: config.takeProfit,
      stopLoss: config.stopLoss,
      maxRecoverySteps: config.maxRecoverySteps,
      markupPercent: botRecoveryMarkup,
      maxStake,
    };
    const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
    const candidates: TurboCandidate[] = [];
    for (const m of markets) {
      const digits = readLive(m.symbol, SCAN_DIGITS);
      const c = evaluateDualLockCandidate(m.symbol, m.displayName, digits, normal, recovery, {
        ...sim,
        simulate: true,
      });
      if (c) candidates.push(c);
      await sleep(20);
    }
    const ranked = screenAndRank(candidates);
    session.watch.switchBoard = ranked
      .filter((c) => c.symbol !== activeSymbol)
      .slice(0, 5)
      .map((c) => ({
        name: c.displayName,
        score: Math.round(c.score),
        survival: Math.round(c.survival * 100) / 100,
      }));
    const active = ranked.find((c) => c.symbol === activeSymbol) ?? null;
    const activeScore = active?.score ?? 0;
    const challenger = ranked.find((c) => c.symbol !== activeSymbol && isDeployable(c));
    if (challenger && challenger.score >= activeScore + SWITCH_MARGIN) {
      const from = activeName;
      activeSymbol = challenger.symbol;
      activeName = challenger.displayName;
      config.symbol = challenger.symbol;
      config.displayName = challenger.displayName;
      config.lockedAnalysis = challenger;
      session.currentMarket = activeName;
      session.watch.market = activeName;
      session.watch.switches += 1;
      session.watch.marketFavorable = true;
      session.watch.healthReason = "";
      unfavorableStreak = 0;
      lastSwitch = Date.now();
      session.message = `🔁 Switched — ${from} turned unfavorable; continuing non-stop on ${activeName} (${contractLabel(
        normal,
      )} → ${contractLabel(recovery)})`;
      broadcast();
      return true;
    }
    // No better tape — the active market stays; re-check on the next cadence.
    session.message = `👁 ${activeName} is soft but no better tape — holding and continuing non-stop`;
    broadcast();
    return false;
  }

  while (session.running && !session.stopRequested) {
    try {
      if (!hasTradingOwnership("bots", owner)) {
        const who = currentTradingOwner(owner);
        session.running = false;
        session.message = `⛔ Stopped — the ${
          who ? tradingOwnerLabel(who) : "other engine"
        } took over this account. One ledger = one engine.`;
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

      // ── ARM ONCE — wait for the best entry tick, then go non-stop ──────────
      if (!armed) {
        const digits = readLive(activeSymbol);
        const arm = armEntryRead(digits, normal, 40);
        session.watch.phase = "arming";
        session.watch.recentRate = arm.recentRate;
        session.watch.breakEven = arm.breakEven;
        session.watch.reason = arm.reason;
        const timedOut = Date.now() - armStart > ARM_TIMEOUT_MS;
        if (!arm.ready && !timedOut) {
          session.watch.ticksWatched = digits.length;
          session.message = `👁 Waiting for the best entry on ${activeName} — ${arm.reason}`;
          broadcast();
          await sleep(400);
          continue;
        }
        armed = true;
        phase = "trading";
        session.watch.phase = "trading";
        session.message = timedOut && !arm.ready
          ? `⚡ Arming on ${activeName} — entry window elapsed; starting the non-stop run`
          : `⚡ ${arm.reason} — starting the non-stop run`;
        broadcast();
      }

      // ── SWITCHING rescue — only when the active market turns unfavorable ───
      if (!locked && Date.now() - lastRescue >= RESCUE_CHECK_MS) {
        lastRescue = Date.now();
        const h = turboMarketHealth(activeSymbol, activeName, readLive(activeSymbol), normal);
        session.watch.marketFavorable = h.favorable;
        session.watch.healthReason = h.reason;
        if (!h.favorable) {
          unfavorableStreak++;
          if (
            unfavorableStreak >= RESCUE_STREAK &&
            Date.now() - lastSwitch >= SWITCH_COOLDOWN_MS
          ) {
            session.watch.reason = `rescuing — ${h.reason}`;
            session.message = `🔎 ${activeName} turned unfavorable (${h.reason}) — scanning for a better tape without stopping the run`;
            broadcast();
            await switchingRescue();
            lastRescue = Date.now();
            continue;
          }
        } else {
          unfavorableStreak = 0;
        }
      }

      // ── THE LOCK: mode selects the contract, nothing re-analyses it ────────
      const inRecovery = recoveryEngine.isInRecovery();
      const contract = inRecovery ? recovery : normal;
      session.watch.mode = inRecovery ? "recovery" : "normal";
      session.watch.contract = contractLabel(contract);

      // Contract sovereignty — checked on EVERY fire, both legs.
      const legOk = inRecovery
        ? isRecoveryContract(contract.side, contract.barrier)
        : isNormalContract(contract.side, contract.barrier);
      if (!legOk || !isAutomatedMarket(activeSymbol)) {
        session.running = false;
        session.message = "⚠️ Contract integrity check failed — session halted before firing";
        broadcast();
        logger.error({ contract, activeSymbol }, "Over/Under Turbo sovereignty violation");
        return;
      }

      // Circuit breaker — the only non-TP/SL halt (see header).
      if (session.currentLossRun >= breakerDepth) {
        session.running = false;
        session.message = `🛑 Circuit breaker: ${session.currentLossRun} consecutive losses exceeds the ${predictedDepth}-step depth this lock was modelled for. The market left its analysed regime — re-scan before redeploying.`;
        broadcast();
        logger.warn(
          { run: session.currentLossRun, breakerDepth },
          "Over/Under Turbo circuit breaker tripped",
        );
        return;
      }

      // ── Payout quote + stake ───────────────────────────────────────────────
      const payoutQuote = await resolveRecoveryPayout({
        symbol: activeSymbol,
        contractType: contract.side,
        barrier: contract.barrier,
        duration: DURATION,
        durationUnit: DURATION_UNIT,
        currency,
      });
      const payout = payoutQuote.payoutMultiplier;

      if (inRecovery) {
        try {
          const fresh = await db
            .select()
            .from(settingsTable)
            .where(eq(settingsTable.sessionId, owner))
            .limit(1);
          if (fresh.length > 0) {
            const v = Number((fresh[0] as any).botRecoveryMarkup);
            if (Number.isFinite(v)) botRecoveryMarkup = v;
          }
        } catch {
          /* keep the previous value */
        }
      }

      // Shared recovery stake formula — identical to the other bots.
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(
            config.stake,
            maxStake,
            availableBalance,
            payout,
            botRecoveryMarkup,
          )
        : config.stake;

      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.currentStake = stake;
      session.currentMarket = activeName;
      session.currentContractType = `${contract.side} ${contract.barrier}`;
      session.watch.stake = stake;
      session.watch.reason = inRecovery
        ? `recovery R${sharedStep} — ${contractLabel(contract)}`
        : `non-stop — ${contractLabel(contract)}`;
      session.message = inRecovery
        ? `🎯 [Recovery R${sharedStep}] ${contractLabel(contract)} on ${activeName} · $${stake.toFixed(2)}`
        : `⚡ ${contractLabel(contract)} on ${activeName} · $${stake.toFixed(2)}`;
      broadcast();

      // ── Journal ────────────────────────────────────────────────────────────
      const reason =
        `[${TURBO_BOT_NAME}${inRecovery ? " RECOVERY" : ""}] non-stop ${contractLabel(contract)} on ${activeName} · ` +
        `survival ${(((config.lockedAnalysis?.survival ?? 0)) * 100).toFixed(0)}% · ξ ${(
          config.lockedAnalysis?.clusterRatio ?? 1
        ).toFixed(2)}`;
      const [journaled] = await db
        .insert(tradesTable)
        .values({
          sessionId: owner,
          symbol: activeSymbol,
          displayName: activeName,
          contractType: contract.side,
          barrier: contract.barrier,
          stake: String(Math.round(stake * 100) / 100),
          direction: "hold",
          status: "open",
          aiConfidence: String(
            Math.round(
              (inRecovery
                ? (config.lockedAnalysis?.recoveryConditional ?? 0.5)
                : (config.lockedAnalysis?.normalLcb ?? 0.7)) * 100,
            ),
          ),
          aiRiskScore: "55",
          isAutonomous: true,
          agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`,
          duration: DURATION,
          durationUnit: DURATION_UNIT,
        })
        .returning();

      // ── Execute ────────────────────────────────────────────────────────────
      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: activeSymbol,
            contractType: contract.side,
            stake: Math.round(stake * 100) / 100,
            duration: DURATION,
            durationUnit: DURATION_UNIT,
            currency,
            accountId: accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            barrier: contract.barrier,
          });
          const result = await waitForContractResult(
            token!,
            accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            liveResult.contractId,
            30_000,
          );
          won = result.won;
          profit = result.profit;
          entryPrice = Number(result.entrySpot) || liveResult.buyPrice;
          exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          logger.warn({ err }, "Over/Under Turbo live execution error — retrying");
          try {
            await db
              .update(tradesTable)
              .set({
                status: "error",
                profit: "0",
                payout: "0",
                closedAt: new Date(),
                agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, {
                  max: 200,
                })}]`,
              })
              .where(eq(tradesTable.id, journaled!.id));
          } catch {
            /* best-effort */
          }
          session.message = `🔁 Retrying — ${friendlyErrorMessage(err)}`;
          broadcast();
          await sleep(1200);
          continue;
        }
      } else {
        // Paper mode settles against the market's REAL next digit — this bot's
        // whole thesis is the digit stream, so paper results must be driven by it.
        const before = readLive(activeSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 30; i++) {
          await sleep(120);
          const d = readLive(activeSymbol, 1)[0];
          if (d !== undefined && d !== before) {
            digit = d;
            break;
          }
          digit = d;
        }
        const d = digit ?? 0;
        won = winSet(contract).has(d);
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

      // Shared ledger — the same call the other bots make. This is what drives
      // the normal→recovery switch on the very next fire, with no re-analysis.
      recoveryEngine.recordOutcome(
        won,
        profit,
        stake,
        config.maxRecoverySteps,
        contract.side,
        payout,
      );

      if (inRecovery) {
        session.consecutiveRecoveryLosses = won
          ? 0
          : session.consecutiveRecoveryLosses + 1;
        if (!recoveryEngine.isInRecovery()) session.consecutiveRecoveryLosses = 0;
      }

      try {
        await db
          .update(tradesTable)
          .set({
            status: won ? "won" : "lost",
            payout: String(won ? Math.round((stake + profit) * 100) / 100 : 0),
            profit: String(Math.round(profit * 100) / 100),
            entryPrice: String(entryPrice),
            exitPrice: String(exitPrice),
            closedAt: new Date(),
          })
          .where(eq(tradesTable.id, journaled!.id));
      } catch (dbErr) {
        logger.warn({ dbErr }, "Over/Under Turbo: failed to settle journaled trade");
      }

      if (!isLive && Number.isFinite(availableBalance)) {
        availableBalance = Math.max(0, availableBalance + profit);
      }
      if (isLive) {
        try {
          const newBal = await getLiveBalance(
            token!,
            accounts[0]?.derivAccountId ?? accounts[0]?.loginId,
          );
          if (newBal !== null && accounts.length > 0) {
            availableBalance = newBal;
            await db
              .update(accountsTable)
              .set({ balance: String(newBal), updatedAt: new Date() })
              .where(eq(accountsTable.id, accounts[0]!.id));
          }
        } catch {
          /* best-effort */
        }
      }

      session.watch.ticksWatched++;
      broadcast();

      // ── TP / SL — the session's own boundaries ─────────────────────────────
      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached — non-stop session complete.`;
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
      await sleep(won ? SETTLE_WIN_MS : SETTLE_LOSS_MS);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error(
        { err, consecutiveErrors },
        "Over/Under Turbo stability catch — keeping the session alive",
      );
      // Never self-stop on transient errors — the session only stops on TP, SL,
      // the circuit breaker, or a manual stop. Back off (capped) and keep going.
      session.message = `Engine stabilizing… retry ${consecutiveErrors} — the session will keep running`;
      broadcast();
      await sleep(Math.min(15000, 500 * consecutiveErrors));
    }
  }

  if (
    !session.running &&
    !session.message?.startsWith("✅") &&
    !session.message?.startsWith("🛑") &&
    !session.message?.startsWith("⚠️") &&
    !session.message?.startsWith("⛔")
  ) {
    session.message = "Session stopped";
    broadcast();
  }
}

export {
  TURBO_NORMAL_CONTRACTS,
  TURBO_RECOVERY_CONTRACTS,
  contractLabel,
  contractKey,
  rankTurboCandidates,
};
