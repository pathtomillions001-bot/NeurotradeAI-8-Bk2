/**
 * TWIN-HEDGE EDGE — execution engine (v3, auto-configured twin pair).
 *
 * The analysis layer (`twin-avoid-analysis.ts`) answers: "which market, and is
 * this tick a clean 4/5 window?" This layer answers the two questions the bot
 * is really about:
 *
 *   1. IS THIS THE TICK — feed freshness, shot spacing, the post-loss
 *      cool-down and the market's own live health (Page–Hinkley on the
 *      realised 4/5 rate) gate every entry.
 *   2. BOTH LEGS, ONE MARKET, SAME TICK — the two contracts of the shot are
 *      placed as ONE bulk order over a single socket, so both proposals go
 *      out in the same millisecond and both contracts open on the same
 *      entry tick. The buy confirmations are checked: equal start_time means
 *      the pair is a true same-tick shot, and the spread is telemetry.
 *
 * THE SHOTS (fixed — the user cannot change them)
 *   normal   : Over 4 + Under 5, equal stakes → one leg always wins, net −5%
 *   recovery : Over 5 + Under 4, equal stakes → +143% net on any digit but
 *              4 or 5, −200% net on 4 or 5. Recovery stakes come from the
 *              shared account ledger, exactly like every other bot.
 *
 * The market MODE (locked vs switching) is decided by the analysis at scan
 * time, not by the user.
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeBulkLiveTrades,
  waitForBulkContractResults,
  getLiveBalance,
  isAutomatedMarket,
  getDeepDigits,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
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
  TWIN_AVOID_PLAN,
  TWIN_AVOID_SCAN_WINDOW,
  TWIN_AVOID_MIN_SPACING,
  measureMarket45,
  decideMarketMode,
  evaluateAvoidGate,
  P45Tracker,
  isInDeadZone,
  type TwinAvoidCard,
  type TwinAvoidRisk,
  type AvoidMode,
} from "./twin-avoid-analysis";

/** Routes import these shapes through the engine's namespace. */
export type { TwinAvoidCard, TwinAvoidRisk } from "./twin-avoid-analysis";

export const TWIN_AVOID_BOT_ID = "twin-hedge";

const REANALYZE_LOCKED_MS = 60_000;
const REANALYZE_SWITCHING_MS = 45_000;
/** Rotation hysteresis — a challenger must beat the active market by this. */
const ROTATE_MARGIN = 0.03;
/** Page–Hinkley drift parameters on the realised 4/5 indicator. */
const PH_H = 6;
const PH_DELTA = 0.05;
const PH_WINDOW = 150;

// ── Public types ────────────────────────────────────────────────────────────

export interface TwinAvoidScanResult {
  suitable: boolean;
  best: TwinAvoidCard | null;
  bestAvailable: TwinAvoidCard | null;
  allScored: TwinAvoidCard[];
  /** Analysis-decided market mode. */
  mode: "locked" | "switching";
  /** The switching cluster (empty when locked). */
  cluster: TwinAvoidCard[];
  modeReason: string;
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

export interface TwinAvoidConfig {
  ownerSessionId?: string;
  botId: string;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  /** The scan ranking the session may rotate within (switching mode). */
  cluster: TwinAvoidCard[];
  symbol: string;
  displayName: string;
  card: TwinAvoidCard;
}

export interface TwinAvoidShotProof {
  sameTick: boolean;
  /** Milliseconds between the two buy confirmations' entry times. */
  spreadMs: number;
  /** Entry tick time (epoch seconds) shared by both legs. */
  entryTick: number;
  /** The closed digit both legs settled against. */
  digit: number;
  overWon: boolean;
  underWon: boolean;
  net: number;
  recovery: boolean;
  paper: boolean;
}

export interface TwinAvoidWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  mode: AvoidMode;
  p45: number;
  p45Se: number;
  bar: number;
  baseline: number;
  veto: string | null;
  reason: string;
  patienceTicks: number;
  ticksWatched: number;
  switched: boolean;
  confidence: number;
  verdict: string;
  overStake: number;
  underStake: number;
  lastShot?: TwinAvoidShotProof;
}

export interface TwinAvoidStatus {
  running: boolean;
  botId: string | null;
  botName: string | null;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  deepestLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: {
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    marketMode: "locked" | "switching";
  };
  /** The measured market card the session is running on. */
  twinDeployed?: {
    symbol: string;
    displayName: string;
    verdict: string;
    baseline: number;
    barNormal: number;
    barRecovery: number;
    survival: number;
    evPerNormalShot: number;
    deepestLadder: number;
    simShots: number;
    marketMode: "locked" | "switching";
  };
  twinWatch?: TwinAvoidWatch;
}

export function isTwinAvoidBot(botId: string): boolean {
  return botId === TWIN_AVOID_BOT_ID;
}

// ── Session state ───────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: TwinAvoidConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  deepestLossRun: number;
  currentLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  stopRequested: boolean;
  watch: TwinAvoidWatch;
  activeSymbol?: string;
  activeName?: string;
  activeCard?: TwinAvoidCard;
  rescanFlags: number;
}

function freshWatch(): TwinAvoidWatch {
  return {
    phase: "watching",
    mode: "normal",
    p45: 0,
    p45Se: 0,
    bar: 0,
    baseline: 0,
    veto: null,
    reason: "",
    patienceTicks: 0,
    ticksWatched: 0,
    switched: false,
    confidence: 0,
    verdict: "—",
    overStake: 0,
    underStake: 0,
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
    deepestLossRun: 0,
    currentLossRun: 0,
    stopRequested: false,
    watch: freshWatch(),
    rescanFlags: 0,
  };
}

// One independent session per connected Deriv account (browser session).
const { state: session, replace: replaceSession } =
  createSessionScoped<SessionState>(freshSession);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

function deployedView(): TwinAvoidStatus["twinDeployed"] | undefined {
  const card = session.activeCard;
  const cfg = session.config;
  if (!card || !cfg) return undefined;
  return {
    symbol: card.symbol,
    displayName: card.displayName,
    verdict: card.verdict,
    baseline: card.baseline,
    barNormal: card.barNormal,
    barRecovery: card.barRecovery,
    survival: card.survival,
    evPerNormalShot: card.evPerNormalShot,
    deepestLadder: card.deepestLadder,
    simShots: card.simNormalShots + card.simRecoveryShots,
    marketMode: cfg.marketMode,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): TwinAvoidStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const watch = session.running ? session.watch : undefined;
  return {
    running: session.running,
    botId: cfg?.botId ?? null,
    botName: cfg ? "Twin-Hedge Edge" : null,
    sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    currentStake: session.currentStake,
    inRecovery: rec.inRecovery,
    recoveryStep: rec.recoveryStep,
    unrecoveredAmount: Math.round(rec.unrecoveredAmount * 100) / 100,
    deepestLossRun: session.deepestLossRun,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    config: cfg
      ? {
          stake: cfg.stake,
          stopLoss: cfg.stopLoss,
          takeProfit: cfg.takeProfit,
          maxRecoverySteps: cfg.maxRecoverySteps,
          marketMode: cfg.marketMode,
        }
      : undefined,
    twinDeployed: session.running ? deployedView() : undefined,
    twinWatch: watch,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info({ botId: session.config?.botId }, "Twin-Hedge session stopped");
}

// ── Pre-deploy scan ─────────────────────────────────────────────────────────

export async function scanForTwinAvoid(
  ownerSessionId: string | undefined,
  risk: TwinAvoidRisk,
): Promise<TwinAvoidScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
  const cards: TwinAvoidCard[] = [];
  let deepest = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE(
      "bot_scan_progress",
      {
        botId: TWIN_AVOID_BOT_ID,
        scanning: market.displayName,
        symbol: market.symbol,
        scanned: i,
        total: markets.length,
      },
      ownerSessionId,
    );

    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, TWIN_AVOID_SCAN_WINDOW);
    } catch {
      digits = tickManager.getDigits(market.symbol, TWIN_AVOID_SCAN_WINDOW);
    }
    deepest = Math.max(deepest, digits.length);
    const card = measureMarket45(market.symbol, market.displayName, digits, risk);
    if (card) cards.push(card);
    await sleep(5);
  }

  const ranked = [...cards].sort((a, b) => b.score - a.score);
  broadcastSSE(
    "bot_scan_progress",
    {
      botId: TWIN_AVOID_BOT_ID,
      scanning: null,
      symbol: null,
      scanned: markets.length,
      total: markets.length,
    },
    ownerSessionId,
  );

  const best = ranked[0] ?? null;
  const bestAvailable = best;
  const deployable = ranked.filter((c) => c.deployable);
  const modeDecision = decideMarketMode(ranked);
  const suitable = deployable.length > 0;

  const reason = !best
    ? "Not enough history yet — the digit feed is still warming up. Wait a moment and re-measure."
    : suitable
      ? `${modeDecision.cluster[0]?.displayName ?? best.displayName} · ${best.verdict.toUpperCase()} — out-of-sample survival ${(best.survival * 100).toFixed(0)}% on ${best.simNormalShots + best.simRecoveryShots} unseen shots. ${modeDecision.reason}.`
      : `No market cleared the bar — best was ${best.displayName} (${best.verdict.toUpperCase()}: ${best.summary}).`;

  return {
    suitable,
    best: suitable ? best : null,
    bestAvailable,
    allScored: ranked.slice(0, 12),
    mode: modeDecision.mode,
    cluster: modeDecision.cluster.map((c) => c),
    modeReason: modeDecision.reason,
    reason,
    marketsScanned: markets.length,
    historyDepth: deepest,
  };
}

// ── Session start ───────────────────────────────────────────────────────────

export async function startSession(
  config: TwinAvoidConfig,
): Promise<{ ok: boolean; error?: string }> {
  if (session.running) {
    return { ok: false, error: "A Twin-Hedge bot is already active — stop it first" };
  }
  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return {
      ok: false,
      error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account. Stop it first — only one engine may own the shared recovery ledger.`,
    };
  }
  const fail = (error: string) => {
    releaseTradingOwnership("bots");
    return { ok: false as const, error };
  };

  if (config.stake < 0.35) return fail("Minimum stake is $0.35");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isAutomatedMarket(config.symbol))
    return fail(`${config.symbol} cannot be traded by this bot`);
  const market = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === config.symbol);
  if (!market || !market.digitEnabled)
    return fail("This bot needs a digit-enabled market");
  if (!config.card || !Number.isFinite(config.card.baseline))
    return fail("Run the analysis first — this bot only deploys a market it has measured");
  if (config.marketMode === "switching" && config.cluster.length < 2)
    return fail("Switching mode needs the scan's market cluster");

  const plan = TWIN_AVOID_PLAN;
  replaceSession({
    ...freshSession(),
    running: true,
    sessionId: `bot_twinavoid_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    currentContractType: `Over ${plan.normal.overDigit} + Under ${plan.normal.underDigit} · rec O${plan.recovery.overDigit}+U${plan.recovery.underDigit}`,
    activeSymbol: config.symbol,
    activeName: config.displayName,
    activeCard: { ...config.card },
    message:
      config.marketMode === "locked"
        ? `🔒 Locked on ${config.displayName} — the analysis found a clear winner. Both legs trade this market only.`
        : `🔁 Deployed on ${config.displayName} — top-${config.cluster.length} cluster; the engine rotates if this market cools.`,
  });

  logger.info(
    {
      botId: config.botId,
      mode: config.marketMode,
      symbol: config.symbol,
      baseline: config.card.baseline.toFixed(3),
    },
    "Twin-Hedge (avoid) session starting",
  );
  broadcast();

  const loopSessionId = config.ownerSessionId ?? getBrowserSessionId();
  runWithSessionId(loopSessionId, () => runLoop(config)
    .catch((err) => {
      logger.error({ err }, "Twin-Hedge runLoop error");
      session.running = false;
      session.message = `⚠️ ${friendlyErrorMessage(err)}`;
      broadcast();
    })
    .finally(() => releaseTradingOwnership("bots")));

  return { ok: true };
}

// ── Page–Hinkley drift monitor (realised 4/5 rate vs baseline) ──────────────

class PageHinkley {
  private m = 0;
  private minM = 0;
  private n = 0;

  reset() {
    this.m = 0;
    this.minM = 0;
    this.n = 0;
  }

  /** Feed one closed digit; true when 4/5 pressure has measurably risen. */
  feed(digit: number, baseline: number): boolean {
    const x = isInDeadZone(digit) ? 1 : 0;
    this.n++;
    this.m += x - baseline;
    this.minM = Math.min(this.minM, this.m);
    return this.n >= 30 && this.m - this.minM - PH_DELTA * this.n > PH_H;
  }
}

// ── Execution loop ──────────────────────────────────────────────────────────

async function runLoop(config: TwinAvoidConfig) {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely";
    releaseTradingOwnership("bots");
    broadcast();
    return;
  }

  let accounts = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.sessionId, ownerSessionId), eq(accountsTable.isActive, true)))
    .limit(1);
  if (accounts.length === 0) {
    accounts = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.sessionId, ownerSessionId))
      .limit(1);
  }
  const settings = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.sessionId, ownerSessionId))
    .limit(1);
  recoveryEngine.setPersistenceSession(ownerSessionId);

  const paperTradeMode = settings.length > 0 ? ((settings[0] as any).paperTradeMode ?? false) : false;
  const token = accounts.length > 0 ? (accounts[0].bearerToken ?? accounts[0].token ?? null) : null;
  const currency = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0].maxTradeStake) : 500;
  let botRecoveryMarkup =
    settings.length > 0 ? Number((settings[0] as any).botRecoveryMarkup ?? 10) : 10;
  let availableBalance =
    accounts.length > 0 && Number(accounts[0].balance) > 0
      ? Number(accounts[0].balance)
      : Number.POSITIVE_INFINITY;

  const P = TWIN_AVOID_PLAN;
  const LOCKED = config.marketMode === "locked";
  const REANALYZE_MS = LOCKED ? REANALYZE_LOCKED_MS : REANALYZE_SWITCHING_MS;

  let activeSymbol: string = config.symbol;
  let activeName: string = config.displayName;
  let activeCard: TwinAvoidCard = { ...config.card };

  let ticksSinceShot = 99;
  let ticksWatched = 0;
  let lastDigitCount = 0;
  let lastReanalyzeAt = 0;
  let consecutiveErrors = 0;
  const ph = new PageHinkley();

  async function measure(marketSymbol: string, displayName: string): Promise<TwinAvoidCard | null> {
    let digits: number[] = [];
    try {
      digits = await getDeepDigits(marketSymbol, TWIN_AVOID_SCAN_WINDOW);
    } catch {
      digits = tickManager.getDigits(marketSymbol, TWIN_AVOID_SCAN_WINDOW);
    }
    return measureMarket45(marketSymbol, displayName, digits, {
      stake: config.stake,
      stopLoss: config.stopLoss,
      takeProfit: config.takeProfit,
      maxRecoverySteps: config.maxRecoverySteps,
      markupPercent: botRecoveryMarkup,
      maxTradeStake: maxStake,
    });
  }

  async function reanalyze(): Promise<void> {
    if (LOCKED) {
      const card = await measure(activeSymbol, activeName);
      if (card) {
        activeCard = card;
        session.activeCard = card;
        ph.reset();
      }
      return;
    }
    // Switching: re-measure the active market plus the cluster challengers,
    // rotate on a decisive margin (hysteresis keeps the session calm).
    const challengers = config.cluster.filter((c) => c.symbol !== activeSymbol).slice(0, 4);
    const active = await measure(activeSymbol, activeName);
    if (active) {
      activeCard = active;
      session.activeCard = active;
      ph.reset();
    }
    let bestChallenger: TwinAvoidCard | null = null;
    for (const c of challengers) {
      const card = await measure(c.symbol, c.displayName);
      if (!card) continue;
      if (!bestChallenger || card.score > bestChallenger.score) bestChallenger = card;
      await sleep(5);
    }
    if (
      active &&
      bestChallenger &&
      bestChallenger.deployable &&
      bestChallenger.score - active.score >= ROTATE_MARGIN
    ) {
      activeSymbol = bestChallenger.symbol;
      activeName = bestChallenger.displayName;
      activeCard = bestChallenger;
      session.activeSymbol = bestChallenger.symbol;
      session.activeName = bestChallenger.displayName;
      session.activeCard = bestChallenger;
      session.currentMarket = bestChallenger.displayName;
      session.watch.switched = true;
      session.rescanFlags = 0;
      ph.reset();
      ticksSinceShot = 99; // fresh market — the spacing clock restarts
      session.message = `🔁 Rotated to ${bestChallenger.displayName} — it now leads the cluster by ${(bestChallenger.score - active.score).toFixed(2)} score`;
      broadcast();
    }
  }

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

      let digits = await getDeepDigits(activeSymbol, TWIN_AVOID_SCAN_WINDOW);
      if (digits.length === 0) {
        session.message = "Waiting for the digit feed…";
        broadcast();
        await sleep(1000);
        continue;
      }
      if (lastDigitCount > 0) {
        const delta = Math.max(0, digits.length - lastDigitCount);
        ticksWatched += delta;
        ticksSinceShot += delta;
      }
      lastDigitCount = digits.length;

      // Periodic re-measure (locked: refresh the card; switching: rotate if the
      // cluster says so). The mode itself was already decided by the scan.
      if (activeCard === undefined || Date.now() - lastReanalyzeAt >= REANALYZE_MS) {
        lastReanalyzeAt = Date.now();
        await reanalyze();
      }

      // Live drift monitor on the realised 4/5 rate of the active market.
      const liveTail = digits.slice(-PH_WINDOW);
      let phAlert = false;
      ph.reset();
      for (const d of liveTail) {
        if (ph.feed(d, activeCard.baseline)) {
          phAlert = true;
          break;
        }
      }
      if (phAlert) {
        session.rescanFlags++;
        if (session.rescanFlags >= 3) {
          if (LOCKED) {
            session.message = "⚠️ RESCAN REQUIRED — 4/5 pressure on the locked market is measurably up. Recovery is holding fire; re-measure to continue.";
            broadcast();
            await sleep(5000);
            continue;
          }
          // Switching: force a rotation pass.
          lastReanalyzeAt = 0;
          session.message = "🔁 4/5 pressure rising — rotating to the next cluster market…";
          broadcast();
          await reanalyze();
          await sleep(1500);
          continue;
        }
      } else if (session.rescanFlags > 0) {
        session.rescanFlags = Math.max(0, session.rescanFlags - 1);
      }

      const inRecovery = recoveryEngine.isInRecovery();
      const mode: AvoidMode = inRecovery ? "recovery" : "normal";
      const bar = mode === "recovery" ? activeCard.barRecovery : activeCard.barNormal;

      // The fused 4/5 reading for the current context.
      const tracker = new P45Tracker();
      tracker.prime(digits);
      const reading = tracker.read();
      const gate = evaluateAvoidGate({
        reading,
        baseline: activeCard.baseline,
        bar,
        mode,
        lastDigits: digits.slice(-10),
        ticksSinceLoss: ticksSinceShot,
        waitedTicks: ticksSinceShot - TWIN_AVOID_MIN_SPACING,
      });

      session.watch.mode = mode;
      session.watch.p45 = reading.p45;
      session.watch.p45Se = reading.p45Se;
      session.watch.bar = bar;
      session.watch.baseline = activeCard.baseline;
      session.watch.veto = gate.veto;
      session.watch.patienceTicks = gate.patienceForced ? 1 : 0;
      session.watch.confidence = Math.round(
        Math.max(0, Math.min(100, 100 - Math.abs(reading.p45 - activeCard.baseline) * 250)),
      );
      session.watch.verdict = activeCard.verdict;

      // Locked market in RESCAN: hold everything (the debt stays frozen —
      // that is the point of the "at no cost" discipline).
      if (LOCKED && session.rescanFlags >= 3) {
        session.watch.phase = "watching";
        session.watch.reason = "RESCAN REQUIRED — holding fire on the locked market";
        session.message = "⚠️ RESCAN REQUIRED — re-measure from the console to continue.";
        broadcast();
        await sleep(4000);
        continue;
      }

      if (!gate.ready) {
        session.watch.phase = "watching";
        session.watch.reason = gate.reason;
        session.message = inRecovery
          ? `🎯 Recovery armed — ${gate.reason}`
          : `👁 ${activeName} — ${gate.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }

      // Timing — speed matters: fresh feed + spacing is all that gates the
      // entry once the 4/5 window is clean.
      session.watch.phase = "armed";
      const age = tickManager.getTickAgeSeconds(activeSymbol);
      const medGap = activeSymbol.startsWith("1HZ") ? 1 : 2;
      if (age > 2.5 * medGap) {
        session.watch.reason = "tick feed lagging — waiting for a fresh tick";
        session.message = `⏳ ${activeName} — ${session.watch.reason}`;
        broadcast();
        await sleep(300);
        continue;
      }
      if (ticksSinceShot < TWIN_AVOID_MIN_SPACING) {
        session.watch.reason = `re-spacing shots (${ticksSinceShot}/${TWIN_AVOID_MIN_SPACING} ticks)`;
        session.message = `⏳ ${activeName} — ${session.watch.reason}`;
        broadcast();
        await sleep(300);
        continue;
      }

      // Contract sovereignty.
      if (!isAutomatedMarket(activeSymbol)) {
        session.running = false;
        session.message = "⚠️ Contract sovereignty check failed — session halted before firing";
        broadcast();
        return;
      }

      // Stake plan. Normal: the configured stake on each leg. Recovery: the
      // shared ledger's debt-driven stake on each leg (equal legs always).
      let legStake: number;
      if (inRecovery) {
        legStake = recoveryEngine.getBotRecoveryStake(
          config.stake,
          maxStake / 2,
          availableBalance,
          P.recoveryEffPayout,
          botRecoveryMarkup,
        );
      } else {
        legStake = config.stake;
      }
      // Pair exposure = both legs combined — cap at balance and max stake.
      let totalExposure = 2 * legStake;
      const exposureCap = Math.min(
        Number.isFinite(availableBalance) ? availableBalance : Number.POSITIVE_INFINITY,
        Number.isFinite(maxStake) && maxStake > 0 ? maxStake : Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(exposureCap) && totalExposure > exposureCap && totalExposure > 0) {
        legStake *= Math.max(0.01, exposureCap / totalExposure);
        totalExposure = 2 * legStake;
      }
      if (legStake < 0.35) {
        session.watch.phase = "watching";
        session.message = "Holding — balance caps push a leg under the $0.35 Deriv minimum";
        broadcast();
        await sleep(2000);
        continue;
      }
      legStake = Math.round(legStake * 100) / 100;

      const pair = inRecovery ? P.recovery : P.normal;
      session.watch.phase = "firing";
      session.currentStake = Math.round(totalExposure * 100) / 100;
      session.currentMarket = activeName;
      session.watch.overStake = legStake;
      session.watch.underStake = legStake;
      const recTag = recoveryEngine.getState().recoveryStep;
      session.message = inRecovery
        ? `🎯 [Recovery R${recTag}] Over ${pair.overDigit} + Under ${pair.underDigit} on ${activeName} · $${legStake.toFixed(2)} per leg — same tick`
        : `🎯 Over ${pair.overDigit} + Under ${pair.underDigit} on ${activeName} · $${legStake.toFixed(2)} per leg — same tick`;
      broadcast();

      const reason =
        `[Twin-Hedge${inRecovery ? " RECOVERY" : ""}] Over ${pair.overDigit} + Under ${pair.underDigit} on ${activeName} · ` +
        `P(4/5|ctx) ${(reading.p45 * 100).toFixed(1)}% (±${(reading.p45Se * 100).toFixed(1)}) · ` +
        `bar ${(bar * 100).toFixed(1)}% · baseline ${(activeCard.baseline * 100).toFixed(1)}% · ` +
        `stake $${legStake.toFixed(2)}/leg${gate.patienceForced ? " · patience valve" : ""}`;

      const [journ] = await db
        .insert(tradesTable)
        .values({
          sessionId: ownerSessionId,
          symbol: activeSymbol,
          displayName: activeName,
          contractType: "DIGITOVER",
          barrier: pair.overDigit,
          stake: String(Math.round(totalExposure * 100) / 100),
          direction: "hold",
          status: "open",
          aiConfidence: String(session.watch.confidence),
          aiRiskScore: "15",
          isAutonomous: true,
          agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`,
          duration: 1,
          durationUnit: "t",
        })
        .returning();

      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0;
      let exitPrice = entryPrice;
      let proof: TwinAvoidShotProof | undefined;

      if (isLive) {
        try {
          const t0 = Date.now();
          // ONE bulk order, ONE socket: both proposals leave in the same
          // millisecond, so both legs open on the same entry tick.
          const legs = await executeBulkLiveTrades(
            token!,
            accounts[0].derivAccountId ?? accounts[0].loginId,
            [
              {
                symbol: activeSymbol,
                contractType: "DIGITOVER",
                stake: legStake,
                duration: 1,
                durationUnit: "t",
                currency,
                barrier: pair.overDigit,
              },
              {
                symbol: activeSymbol,
                contractType: "DIGITUNDER",
                stake: legStake,
                duration: 1,
                durationUnit: "t",
                currency,
                barrier: pair.underDigit,
              },
            ],
          );

          const overLeg = legs[0]!;
          const underLeg = legs[1]!;
          const overOk = !("error" in overLeg);
          const underOk = !("error" in underLeg);
          if (!overOk && !underOk) {
            throw new Error(
              overLeg.error?.message ?? underLeg.error?.message ?? "Both legs rejected",
            );
          }

          const t1 = Date.now();
          const overBuyPrice = overOk ? overLeg.buyPrice : 0;
          const underBuyPrice = underOk ? underLeg.buyPrice : 0;
          const entryA = overOk ? overLeg.entrySpot : 0;
          const entryB = underOk ? underLeg.entrySpot : 0;
          const sameTick = overOk && underOk && entryA > 0 && entryA === entryB;
          const spreadMs =
            overOk && underOk
              ? Math.abs(entryA - entryB) * 1000
              : Number.POSITIVE_INFINITY;
          const entryTick = Math.max(entryA, entryB);

          const ids = [
            ...(overOk ? [overLeg.contractId] : []),
            ...(underOk ? [underLeg.contractId] : []),
          ];
          const results =
            ids.length > 0
              ? await waitForBulkContractResults(
                  token!,
                  accounts[0].derivAccountId ?? accounts[0].loginId,
                  ids,
                  30_000,
                )
              : [];
          const byId = new Map(results.map((r) => [r.contractId, r]));
          const overR = overOk ? byId.get(overLeg.contractId) : undefined;
          const underR = underOk ? byId.get(underLeg.contractId) : undefined;
          const overWon = !!overR && overR.won;
          const underWon = !!underR && underR.won;
          profit = (overR?.profit ?? 0) + (underR?.profit ?? 0);
          won = profit > 0;
          entryPrice =
            Number(overR?.entrySpot ?? 0) || overBuyPrice || underBuyPrice;
          exitPrice = entryPrice;

          // Recover the closed digit from the tick stream for the console's
          // proof strip. A 1-tick digit contract settles on the tick right
          // after entry, so by the time the profit table journals the pair
          // the newest buffered tick is (or has just been) the closing tick.
          // The win/loss flags above come from Deriv itself — the digit is
          // display-grade.
          const lastDigit = tickManager.getDigits(activeSymbol, 1)[0] ?? 0;
          proof = {
            sameTick,
            spreadMs: Number.isFinite(spreadMs) ? Math.round(spreadMs) : -1,
            entryTick,
            digit: lastDigit,
            overWon,
            underWon,
            net: Math.round(profit * 100) / 100,
            recovery: inRecovery,
            paper: false,
          };
          logger.info(
            { sameTick, spreadMs, entryTick, overWon, underWon, profit, execMs: t1 - t0 },
            "Twin-Hedge pair shot settled",
          );
          if (!sameTick) {
            session.message = `⚠️ Legs opened ${spreadMs}ms apart — the pair was split across ticks. Settle recorded; the 4/5 gate protects the next shot.`;
            broadcast();
          }
        } catch (err) {
          logger.warn({ err }, "Twin-Hedge live execution error — returning to the watch");
          try {
            await db
              .update(tradesTable)
              .set({
                status: "error",
                profit: "0",
                payout: "0",
                closedAt: new Date(),
                agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
              })
              .where(eq(tradesTable.id, journ.id));
          } catch {
            /* best-effort */
          }
          session.watch.phase = "watching";
          session.message = `🔁 Pair shot aborted — ${friendlyErrorMessage(err)}. Back to watching.`;
          broadcast();
          await sleep(2000);
          continue;
        }
      } else {
        // Paper/demo: both legs settle on the very next closed digit.
        session.watch.phase = "settling";
        const before = tickManager.getDigits(activeSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 50; i++) {
          await sleep(120);
          const d = tickManager.getDigits(activeSymbol, 1)[0];
          if (d !== undefined && d !== before) {
            digit = d;
            break;
          }
          digit = d;
        }
        const d = digit ?? 0;
        const overWon = d > pair.overDigit;
        const underWon = d < pair.underDigit;
        profit =
          (overWon ? legStake * (pair.overPayout - 1) : -legStake) +
          (underWon ? legStake * (pair.underPayout - 1) : -legStake);
        won = profit > 0;
        proof = {
          sameTick: true,
          spreadMs: 0,
          entryTick: Math.floor(Date.now() / 1000),
          digit: d,
          overWon,
          underWon,
          net: Math.round(profit * 100) / 100,
          recovery: inRecovery,
          paper: true,
        };
      }

      session.tradeCount++;
      const netLoss = Math.max(0, -profit);
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

      recoveryEngine.recordOutcome(
        won,
        profit,
        netLoss || Math.abs(profit),
        config.maxRecoverySteps,
        "DIGITOVER",
        inRecovery ? P.recoveryEffPayout : P.normal.overPayout,
      );

      try {
        await db
          .update(tradesTable)
          .set({
            status: won ? "won" : "lost",
            payout: String(Math.round(Math.max(0, profit) * 100) / 100),
            profit: String(Math.round(profit * 100) / 100),
            entryPrice: String(entryPrice),
            exitPrice: String(exitPrice),
            closedAt: new Date(),
            agentReasoning: `${reason} · closed digit ${proof?.digit ?? "?"} · ${proof?.sameTick ? "same tick" : "SPLIT legs"}`,
          })
          .where(eq(tradesTable.id, journ.id));
      } catch (dbErr) {
        logger.warn({ dbErr }, "Twin-Hedge: failed to settle the journaled trade");
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
              .where(eq(accountsTable.id, accounts[0].id));
          }
        } catch {
          /* best-effort */
        }
      }

      session.watch = {
        ...freshWatch(),
        ticksWatched,
        confidence: session.watch.confidence,
        verdict: activeCard.verdict,
        lastShot: proof,
      };
      ticksSinceShot = 0;
      lastReanalyzeAt = 0;
      session.message = proof
        ? proof.sameTick
          ? `✅ digit ${proof.digit} · ${won ? "+" : "−"}$${Math.abs(profit).toFixed(2)} · both legs same tick (Δ${proof.spreadMs}ms) · ${session.winCount}/${session.tradeCount}`
          : `⚠️ digit ${proof.digit} · ${won ? "+" : "−"}$${Math.abs(profit).toFixed(2)} · legs were split across ticks`
        : "";
      broadcast();

      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached in ${session.tradeCount} shots.`;
        broadcast();
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit after ${session.tradeCount} shots. Session stopped safely.`;
        broadcast();
        return;
      }
      const recAfter = recoveryEngine.getState();
      if (recAfter.inRecovery && recAfter.recoveryStep >= config.maxRecoverySteps) {
        session.message = `⚡ Max recovery step reached (${config.maxRecoverySteps}) — the ladder is capped; the gate keeps every entry clean`;
      }

      await sleep(won ? 1200 : 2500);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Twin-Hedge stability catch — keeping the session alive");
      session.message = `Engine stabilizing… retry ${consecutiveErrors} — the session will keep running`;
      broadcast();
      await sleep(Math.min(15000, 600 * consecutiveErrors));
    }
  }

  if (
    !session.running &&
    !session.message?.startsWith("✅") &&
    !session.message?.startsWith("🛑") &&
    !session.message?.startsWith("⚠️")
  ) {
    session.message = "Session stopped";
    broadcast();
  }
}
