/**
 * Over/Under Navigator execution engine.
 *
 * This is a dedicated engine rather than a generic barrier preset. The plan
 * carries four user-selected barriers: normal Over/Under and recovery
 * Over/Under. SIX statistical lenses (digit Markov, band Markov, hole hazard,
 * suffix memory, EW drift, 2-state regime HMM) are fused in a calibrated log
 * opinion pool with model-averaged skill weights; side arbitration prices
 * CONTEXTUAL loss-pair risk (order-2 band chain). The recovery selector is
 * always evaluated against both armed recovery contracts against a STATIC
 * payout-aware bar (break-even clamped to [fair, fair+0.02]) — the loss-run
 * is never used to make the bar stricter.
 *
 * MARKET SWITCHING — the MARKET SCOUT (./band-regime) scores every allowed
 * market on a composite of live EW band edge + held-out walk-forward edge
 * (age-decayed) + this bot's own fired outcomes (Beta-shrunk), with
 * hysteresis (margin + cooldown + min dwell). In switching mode it redirects
 * the fire budget to a measurably better tape in NORMAL mode (the legacy bot
 * had none) AND in RECOVERY mode (the hunt fires an instantly-ready
 * cross-market setup immediately, or migrates to the best recovery tape even
 * before a setup exists). The scout adds no veto: when it says "stay", the
 * policy trades exactly like the legacy bot. Locked mode never switches.
 *
 * NO FORCED TRADES — the normal valve floors at each contract's break-even
 * (see NavigatorPolicy), and two conditions on the ACTIVE tape make the scout
 * URGENT (dwell waived, cooldown/margin shrunk, and — when high — a full
 * cross-market NORMAL HUNT, the twin of the recovery hunt):
 *   STARVING — the valve has been pinned at its floor (no fair setup here)
 *   BLEEDING — a fresh normal-mode loss streak on this market, which also
 *              earns the market a decaying scout penalty.
 * The bot moves to where its bar is met instead of lowering the bar.
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
  getLiveBalance,
  isAutomatedMarket,
  getDeepDigits,
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
import { runWithSession } from "./session";
import { registerLiveBot, unregisterLiveBot } from "./live-registry";
import {
  buildNavigatorHMMWindows,
  contractsForPlan,
  scoreNavigatorMarket,
  NavigatorPolicy,
  type NavigatorContract,
  type NavigatorDecision,
  type NavigatorMarketRead,
  type NavigatorParams,
  type NavigatorPlan,
  type NavigatorSideMode,
  type NavigatorVerdict,
  validateNavigatorPlan,
  NAVIGATOR_MIN_MEASURE_DIGITS,
} from "./overunder-navigator-analysis";
import { MarketScout } from "./band-regime.js";

export const NAVIGATOR_BOT_ID = "overunder-navigator";
export const NAVIGATOR_BOT_NAME = "Over/Under Navigator";
const DURATION = 1;
const DURATION_UNIT = "t";
const SCAN_DIGITS = 4500;
const HUNT_DIGITS = 2200;
const REFIT_MS = 30_000;
const HUNT_MS = 3_000;

export interface NavigatorCandidate {
  symbol: string;
  displayName: string;
  verdict: NavigatorVerdict;
  confidence: number;
  paperEdgePerDollar: number;
  normalHitRate: number;
  normalShots: number;
  normalHits: number;
  recoveryHitRate: number;
  recoveryShots: number;
  recoveryHits: number;
  recoveryLossPairs: number;
  recoveryLosses: number;
  avgTicksInRecovery: number;
  fireRatePer100: number;
  breakEvenNormal: number;
  breakEvenRecovery: number;
  params: NavigatorParams;
  diag: NavigatorMarketRead["diag"];
  thinData: boolean;
  metrics: NavigatorMarketRead["metrics"];
}

export interface NavigatorScanResult {
  suitable: boolean;
  best: NavigatorCandidate | null;
  bestAvailable: NavigatorCandidate | null;
  allScored: NavigatorCandidate[];
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

export interface NavigatorConfig {
  ownerSessionId?: string;
  plan: NavigatorPlan;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  symbol: string;
  displayName: string;
  params: NavigatorParams;
  lockedAnalysis?: NavigatorCandidate;
}

export interface NavigatorDeployed {
  symbol: string;
  displayName: string;
  verdict: string;
  confidence: number;
  paperEdgePerDollar: number;
  normalLabel: string;
  recoveryLabel: string;
  normalHitRate: number;
  normalShots: number;
  recoveryHitRate: number;
  recoveryShots: number;
  recoveryLossPairs: number;
  breakEvenNormal: number;
  breakEvenRecovery: number;
}

export interface NavigatorWatchScout {
  active: string;
  top: Array<{ name: string; score: number; live: number; penalty?: number }>;
  /** 0..1 — how hard the scout is currently looking for a way out. */
  urgency?: number;
  /** Why the scout is urgent (starving / bleeding), when it is. */
  urgencyReason?: string;
}

export interface NavigatorWatch {
  phase: "watching" | "armed" | "firing" | "settling" | "hunting";
  mode: "normal" | "recovery";
  sideLabel: string;
  altLabel: string;
  p: number;
  altP: number;
  bar: number;
  ready: boolean;
  pairRisk: number;
  qLL: number;
  /** Six lenses: [digitMarkov, bandMarkov, holeHazard, suffix, ewDrift, regimeHMM]. */
  lenses: [number, number, number, number, number, number];
  recoveryRadar: Array<{
    label: string;
    p: number;
    utility: number;
    bar: number;
    ready: boolean;
  }>;
  /** Market Scout leaderboard (switching mode only). */
  scout?: NavigatorWatchScout;
  reason: string;
  switched: boolean;
  ticksWatched: number;
  confidence: number;
  verdict: string;
}

export interface NavigatorStatus {
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
  currentLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: Omit<
    NavigatorConfig,
    "ownerSessionId" | "params" | "lockedAnalysis"
  > & { params?: NavigatorParams };
  navigatorDeployed?: NavigatorDeployed;
  navigatorWatch?: NavigatorWatch;
}

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: NavigatorConfig | null;
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
  watch: NavigatorWatch;
  activeRead?: NavigatorCandidate | null;
}

function freshWatch(): NavigatorWatch {
  return {
    phase: "watching",
    mode: "normal",
    sideLabel: "—",
    altLabel: "—",
    p: 0,
    altP: 0,
    bar: 0,
    ready: false,
    pairRisk: 0,
    qLL: 0,
    lenses: [0, 0, 0, 0, 0, 0],
    recoveryRadar: [],
    reason: "",
    switched: false,
    ticksWatched: 0,
    confidence: 0,
    verdict: "—",
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
  };
}
let session: SessionState = freshSession();
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function broadcast() {
  const owner = session.config?.ownerSessionId;
  if (owner) broadcastSSE("bot_update", getStatus(), owner);
}

export function getOwnerSessionId() {
  return session.config?.ownerSessionId ?? null;
}
export function isRunning() {
  return session.running;
}
registerBotEngine(NAVIGATOR_BOT_ID, () => ({
  running: session.running,
  name: NAVIGATOR_BOT_NAME,
}));

function deployed(
  read: NavigatorCandidate | null | undefined,
  plan?: NavigatorPlan,
): NavigatorDeployed | undefined {
  if (!read) return undefined;
  const n = (v: unknown, fallback = 0) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    symbol: read.symbol,
    displayName: read.displayName,
    verdict: read.verdict,
    confidence: n(read.confidence),
    paperEdgePerDollar: n(read.paperEdgePerDollar),
    normalLabel: plan
      ? `Over ${plan.normalOver} / Under ${plan.normalUnder}`
      : "configured normal",
    recoveryLabel: plan
      ? `Over ${plan.recoveryOver} / Under ${plan.recoveryUnder}`
      : "configured recovery",
    normalHitRate: n(read.normalHitRate),
    normalShots: n(read.normalShots),
    recoveryHitRate: n(read.recoveryHitRate),
    recoveryShots: n(read.recoveryShots),
    recoveryLossPairs: n(read.recoveryLossPairs),
    breakEvenNormal: n(read.breakEvenNormal),
    breakEvenRecovery: n(read.breakEvenRecovery),
  };
}

export function getStatus(): NavigatorStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  return {
    running: session.running,
    botId: cfg ? NAVIGATOR_BOT_ID : null,
    botName: cfg ? NAVIGATOR_BOT_NAME : null,
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
    currentLossRun: session.currentLossRun,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    config: cfg
      ? {
          plan: cfg.plan,
          stake: cfg.stake,
          stopLoss: cfg.stopLoss,
          takeProfit: cfg.takeProfit,
          maxRecoverySteps: cfg.maxRecoverySteps,
          marketMode: cfg.marketMode,
          ...(cfg.lockedSymbol ? { lockedSymbol: cfg.lockedSymbol } : {}),
          symbol: cfg.symbol,
          displayName: cfg.displayName,
          params: cfg.params,
        }
      : undefined,
    navigatorDeployed: session.running
      ? deployed(session.activeRead, cfg?.plan)
      : undefined,
    navigatorWatch: session.running ? session.watch : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  unregisterLiveBot(NAVIGATOR_BOT_ID);
  broadcast();
  logger.info(
    { botId: NAVIGATOR_BOT_ID },
    "Over/Under Navigator session stopped",
  );
}

function toCandidate(
  symbol: string,
  displayName: string,
  read: NavigatorMarketRead,
): NavigatorCandidate {
  const m = read.metrics;
  const normal = read.normalContracts[0];
  const recovery = read.recoveryContracts[0];
  return {
    symbol,
    displayName,
    verdict: read.verdict,
    confidence: read.confidence,
    paperEdgePerDollar: read.paperEdgePerDollar,
    normalHitRate: m.normalHitRate,
    normalShots: m.normalShots,
    normalHits: m.normalHits,
    recoveryHitRate: m.recoveryHitRate,
    recoveryShots: m.recoveryShots,
    recoveryHits: m.recoveryHits,
    recoveryLossPairs: m.recoveryLossPairs,
    recoveryLosses: m.recoveryLosses,
    avgTicksInRecovery: m.avgTicksInRecovery,
    fireRatePer100: m.fireRatePer100,
    breakEvenNormal: normal?.payout ? 1 / normal.payout : 0,
    breakEvenRecovery: recovery?.payout ? 1 / recovery.payout : 0,
    params: read.params,
    diag: read.diag,
    thinData: read.thinData,
    metrics: m,
  };
}

export async function scanForNavigator(
  ownerSessionId: string | undefined,
  plan: NavigatorPlan,
): Promise<NavigatorScanResult> {
  const planError = validateNavigatorPlan(plan);
  if (planError) throw new Error(planError);
  const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
  const all: NavigatorCandidate[] = [];
  let deepest = 0;
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE(
      "bot_scan_progress",
      {
        botId: NAVIGATOR_BOT_ID,
        scanning: market.displayName,
        symbol: market.symbol,
        scanned: i,
        total: markets.length,
      },
      ownerSessionId,
    );
    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, SCAN_DIGITS);
    } catch {
      digits = tickManager.getDigits(market.symbol, SCAN_DIGITS);
    }
    deepest = Math.max(deepest, digits.length);
    if (digits.length >= NAVIGATOR_MIN_MEASURE_DIGITS)
      all.push(
        toCandidate(
          market.symbol,
          market.displayName,
          scoreNavigatorMarket(digits, plan),
        ),
      );
    await sleep(5);
  }
  const ranked = all.sort(
    (a, b) =>
      b.paperEdgePerDollar - a.paperEdgePerDollar ||
      b.recoveryHitRate - a.recoveryHitRate,
  );
  broadcastSSE(
    "bot_scan_progress",
    {
      botId: NAVIGATOR_BOT_ID,
      scanning: null,
      symbol: null,
      scanned: markets.length,
      total: markets.length,
    },
    ownerSessionId,
  );
  const best = ranked[0] ?? null;
  if (!best)
    return {
      suitable: false,
      best: null,
      bestAvailable: null,
      allScored: [],
      reason:
        "Not enough digit history yet — keep the page open for a moment and scan again.",
      marketsScanned: markets.length,
      historyDepth: deepest,
    };
  const reason = `${best.displayName} measured ${(best.recoveryHitRate * 100).toFixed(0)}% recovery hits over ${best.recoveryShots} shots, ${(best.normalHitRate * 100).toFixed(0)}% normal over ${best.normalShots} shots; recovery loss pairs ${best.recoveryLossPairs}.`;
  return {
    suitable: best.verdict !== "thin",
    best: best.verdict !== "thin" ? best : null,
    bestAvailable: best,
    allScored: ranked.slice(0, 12),
    reason,
    marketsScanned: markets.length,
    historyDepth: deepest,
  };
}

export async function startSession(
  config: NavigatorConfig,
): Promise<{ ok: boolean; error?: string }> {
  if (session.running)
    return {
      ok: false,
      error: `${NAVIGATOR_BOT_NAME} is already active — stop it first`,
    };
  const other = runningOtherEngines(NAVIGATOR_BOT_ID);
  if (other.length)
    return {
      ok: false,
      error: `${other[0]!.name} is already trading on this account. Stop it first — one engine owns the recovery ledger.`,
    };
  if (!acquireTradingOwnership("bots", config.ownerSessionId)) {
    const owner = currentTradingOwner(config.ownerSessionId);
    return {
      ok: false,
      error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account.`,
    };
  }
  const fail = (error: string) => {
    releaseTradingOwnership("bots", config.ownerSessionId);
    return { ok: false as const, error };
  };
  const planError = validateNavigatorPlan(config.plan);
  if (planError) return fail(planError);
  if (config.stake < 0.35 || config.stopLoss <= 0 || config.takeProfit <= 0)
    return fail(
      "Stake, take profit and stop loss must be positive; minimum stake is $0.35",
    );
  if (!isAutomatedMarket(config.symbol))
    return fail(`${config.symbol} cannot be traded by this bot`);
  if (config.marketMode === "locked" && config.lockedSymbol !== config.symbol)
    return fail("Locked mode pins the market that was scanned");
  if (!config.params || !Array.isArray(config.params.weights))
    return fail(
      "Run the Navigator scan first — deployment requires its measured model card",
    );
  const market = AUTOMATED_DERIV_MARKETS.find(
    (m) => m.symbol === config.symbol,
  );
  if (!market?.digitEnabled)
    return fail("This bot needs a digit-enabled market");
  const contracts = contractsForPlan(config.plan);
  if (!contracts.normal.length || !contracts.recovery.length)
    return fail("At least one normal and one recovery side must be armed");

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_navigator_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    activeRead: config.lockedAnalysis ?? null,
    message:
      config.marketMode === "locked"
        ? `Locked on ${config.displayName} — recovery uses your selected digits.`
        : `Deployed on ${config.displayName} — recovery may hunt other markets.`,
  };
  if (session.activeRead) {
    session.watch.confidence = session.activeRead.confidence;
    session.watch.verdict = session.activeRead.verdict;
  }
  registerLiveBot(NAVIGATOR_BOT_ID, () => getStatus());
  broadcast();
  runWithSession(config.ownerSessionId ?? "legacy", () =>
    runLoop(config)
      .catch((err) => {
        logger.error({ err }, "Over/Under Navigator runLoop error");
        session.running = false;
        session.message = `⚠️ ${friendlyErrorMessage(err)}`;
        broadcast();
      })
      .finally(() => releaseTradingOwnership("bots", config.ownerSessionId)),
  );
  return { ok: true };
}

function radarOf(policy: NavigatorPolicy, digits: number[], idx: number) {
  return policy.recoveryContracts
    .map((c) => {
      const r = policy.readSide(digits, idx, c);
      const bar = NavigatorPolicy.recoveryBarFor(c);
      return {
        label: c.label,
        p: r.p,
        utility: r.utility,
        bar,
        ready: r.p >= bar,
      };
    })
    .sort((a, b) => b.utility - a.utility);
}
function applyDecision(
  dec: NavigatorDecision,
  radar: NavigatorWatch["recoveryRadar"],
) {
  session.watch.mode = dec.mode;
  session.watch.sideLabel = dec.side?.label ?? "—";
  session.watch.altLabel = dec.alt?.contract.label ?? "—";
  session.watch.p = dec.read?.p ?? 0;
  session.watch.altP = dec.alt?.p ?? 0;
  session.watch.bar = dec.bar;
  session.watch.ready = dec.ready;
  session.watch.pairRisk = dec.read?.pairRisk ?? 0;
  session.watch.qLL = dec.read?.qLL ?? 0;
  session.watch.lenses = dec.read?.lenses ?? [0, 0, 0, 0, 0, 0];
  session.watch.recoveryRadar = radar;
  session.watch.reason = dec.reason;
}

async function readDigits(symbol: string, count = SCAN_DIGITS) {
  try {
    return await getDeepDigits(symbol, count);
  } catch {
    return tickManager.getDigits(symbol, count);
  }
}

async function runLoop(config: NavigatorConfig) {
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
    .where(
      and(eq(accountsTable.sessionId, owner), eq(accountsTable.isActive, true)),
    )
    .limit(1);
  if (!accounts.length)
    accounts = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.sessionId, owner))
      .limit(1);
  const settings = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.sessionId, owner))
    .limit(1);
  recoveryEngine.setPersistenceSession(owner);
  const paper =
    settings.length > 0
      ? ((settings[0] as any).paperTradeMode ?? false)
      : false;
  const token = accounts[0]?.bearerToken ?? accounts[0]?.token ?? null;
  const currency = accounts[0]?.currency ?? "USD";
  const isLive = !paper && !!token;
  const maxStake =
    settings.length > 0 ? Number(settings[0]!.maxTradeStake) : 500;
  let markup =
    settings.length > 0
      ? Number((settings[0] as any).botRecoveryMarkup ?? 10)
      : 10;
  let balance =
    accounts[0] && Number(accounts[0].balance) > 0
      ? Number(accounts[0].balance)
      : Number.POSITIVE_INFINITY;
  const contracts = contractsForPlan(config.plan);
  const locked = config.marketMode === "locked";
  let activeSymbol = config.symbol;
  let activeName = config.displayName;
  let policy: NavigatorPolicy | null = null;
  let candidate: NavigatorCandidate | null = config.lockedAnalysis ?? null;
  let digits: number[] = [];
  let digitsSymbol = activeSymbol;
  let fedLen = 0;
  let lastDecision: NavigatorDecision | null = null;
  let lastRefit = 0;
  let lastHunt = 0;
  let lastScout = 0;
  let consecutiveErrors = 0;
  let lastDigitCount = 0;

  // ── MARKET SCOUT — live/measured/experienced edge per market, hysteresis-
  // protected. It redirects WHERE the fire budget lands; it never vetoes a
  // shot (no new gate: when the scout says "stay", behaviour is legacy-exact).
  const scout = new MarketScout(
    AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled).map((m) => ({
      symbol: m.symbol,
      displayName: m.displayName,
    })),
    {
      normal: contracts.normal.map((c) => ({
        wins: c.wins,
        fair: c.fair,
        payout: c.payout,
      })),
      recovery: contracts.recovery.map((c) => ({
        wins: c.wins,
        fair: c.fair,
        payout: c.payout,
      })),
    },
  );
  const bufferReader = (symbol: string): number[] =>
    tickManager.getDigits(symbol, 300);
  scout.enter(activeSymbol, Date.now());
  let cardCursor = 0;
  /** A cross-market setup captured by the hunt — fired on the next pass. */
  let pendingFire: NavigatorDecision | null = null;
  /** Cheap composite-only switch check (no re-fit) in normal mode. */
  const NORMAL_SCOUT_MS = 10_000;
  /** …but when the active tape is starving/bleeding us, look every 2 s. */
  const URGENT_SCOUT_MS = 2_000;
  /** Starvation ramp: urgency 0 after this long at the floor … */
  const STARVE_RAMP_START_MS = 20_000;
  /** … 1 after this long. */
  const STARVE_RAMP_FULL_MS = 90_000;
  /** Consecutive normal-mode losses on ONE market before it is penalised. */
  const BLEED_STREAK = 2;
  /** How long a fresh loss streak keeps the scout urgent. */
  const BLEED_URGENT_MS = 45_000;
  /** Full cross-market normal hunt cadence while starving. */
  const NORMAL_HUNT_MS = 6_000;

  // ── WHY the Navigator used to force trades ────────────────────────────────
  // Its normal-mode pacing valve had a floor of 0: on a tape with no fair
  // setup the bar sank until the bot fired anyway, and the scout's anti-flap
  // clocks (90 s dwell, 60 s cooldown, 0.012 $/$ margin) kept it on that tape.
  // Now the valve floors at break-even (analysis), and the engine converts
  // "no fair setup here" (STARVING) and "this tape just punished us"
  // (BLEEDING) into scout URGENCY, which waives the clocks and, when high,
  // runs a full cross-market hunt exactly like recovery already does. The
  // bot never lowers its bar to trade — it moves to where the bar is met.
  let starvedSince = 0;
  let bleedingUntil = 0;
  let bleedReason = "";
  /** Consecutive normal-mode losses on the ACTIVE market. */
  let activeLossRun = 0;
  let lastNormalHunt = 0;

  const scoutUrgency = (now: number): { level: number; reason: string } => {
    let level = 0;
    let reason = "";
    if (starvedSince > 0) {
      const t = now - starvedSince;
      const starve = Math.min(
        1,
        Math.max(0, (t - STARVE_RAMP_START_MS) / (STARVE_RAMP_FULL_MS - STARVE_RAMP_START_MS)),
      );
      if (starve > 0) {
        level = starve;
        reason = `starving — no fair setup on ${activeName} for ${Math.round(t / 1000)}s`;
      }
    }
    if (now < bleedingUntil) {
      const bleed = 0.6 + 0.4 * ((bleedingUntil - now) / BLEED_URGENT_MS);
      if (bleed > level) {
        level = Math.min(1, bleed);
        reason = bleedReason;
      }
    }
    return { level, reason };
  };

  const scoutPanel = (mode: "normal" | "recovery") => {
    if (locked) {
      session.watch.scout = undefined;
      return;
    }
    const now = Date.now();
    const u = scoutUrgency(now);
    session.watch.scout = {
      active: activeName,
      top: scout.top(mode, bufferReader, now).map((s) => ({
        name: s.displayName,
        score: Math.round(s.composite * 10000) / 10000,
        live: Math.round(s.live * 10000) / 10000,
        penalty: s.penalty > 0 ? Math.round(s.penalty * 10000) / 10000 : undefined,
      })),
      urgency: mode === "normal" ? Math.round(u.level * 100) / 100 : undefined,
      urgencyReason: mode === "normal" && u.level > 0 ? u.reason : undefined,
    };
  };

  /** Move the session onto another market (bookkeeping shared by every switch path). */
  const moveTo = (symbol: string, name: string) => {
    activeSymbol = symbol;
    activeName = name;
    scout.markSwitch(Date.now());
    scout.enter(activeSymbol, Date.now());
    session.watch.switched = true;
    starvedSince = 0;
    activeLossRun = 0;
  };

  async function refit() {
    const next = await readDigits(activeSymbol);
    if (next.length < NAVIGATOR_MIN_MEASURE_DIGITS) return false;
    const read = scoreNavigatorMarket(next, config.plan);
    candidate = toCandidate(activeSymbol, activeName, read);
    policy = new NavigatorPolicy(
      read.params,
      contracts.normal,
      contracts.recovery,
      // Regime HMMs warm on the full PAST tape (causal at refit time).
      buildNavigatorHMMWindows(next, contracts.all),
    );
    for (let i = 0; i < next.length; i++) policy.update(next, i);
    digits = next;
    digitsSymbol = activeSymbol;
    fedLen = next.length;
    lastDigitCount = next.length;
    lastDecision = null;
    session.activeRead = candidate;
    session.currentMarket = activeName;
    session.watch.confidence = candidate.confidence;
    session.watch.verdict = candidate.verdict;
    // The active market's scout card refreshes with every re-fit.
    scout.setCard(activeSymbol, {
      edge: read.paperEdgePerDollar,
      recoveryHitRate: read.metrics.recoveryHitRate,
      recoveryShots: read.metrics.recoveryShots,
      at: Date.now(),
    });
    return true;
  }
  /**
   * Rotating background re-fit: one non-active market per refit cycle gets a
   * fresh full walk-forward card (all markets covered in ~10 min) so the
   * scout's "measured" evidence stays current without re-scanning everything.
   */
  async function rotateOneCard() {
    const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
    if (markets.length < 2) return;
    for (let step = 0; step < markets.length; step++) {
      const m = markets[(cardCursor + step) % markets.length]!;
      if (m.symbol === activeSymbol) continue;
      cardCursor = (cardCursor + step + 1) % markets.length;
      try {
        const d = await readDigits(m.symbol);
        if (d.length < NAVIGATOR_MIN_MEASURE_DIGITS) return;
        const read = scoreNavigatorMarket(d, config.plan);
        scout.setCard(m.symbol, {
          edge: read.paperEdgePerDollar,
          recoveryHitRate: read.metrics.recoveryHitRate,
          recoveryShots: read.metrics.recoveryShots,
          at: Date.now(),
        });
      } catch {
        /* the scout lives without cards */
      }
      return;
    }
  }
  /**
   * NORMAL HUNT (switching mode, only while STARVING) — the normal-mode twin
   * of the recovery hunt. Fits every allowed market and asks each one, on its
   * latest tick, whether a normal setup clears that market's OWN initial bar
   * (the strict 80th-percentile seed — a hunt fire must be a genuinely strong
   * read, never a marginal one) AND break-even. Best utility wins and is
   * fired immediately; otherwise the scout's composite decides whether to
   * migrate to a better normal tape and let its valve time the shot there.
   */
  async function huntNormal(urgency: { level: number; reason: string }): Promise<{
    fire: { symbol: string; name: string; decision: NavigatorDecision } | null;
    migrate: { symbol: string; name: string } | null;
  }> {
    let best: { symbol: string; name: string; decision: NavigatorDecision } | null = null;
    for (const m of AUTOMATED_DERIV_MARKETS.filter((x) => x.digitEnabled)) {
      if (m.symbol === activeSymbol) continue;
      const d = await readDigits(m.symbol, HUNT_DIGITS);
      if (d.length < 150) continue;
      const read = scoreNavigatorMarket(d, config.plan);
      scout.setCard(m.symbol, {
        edge: read.paperEdgePerDollar,
        recoveryHitRate: read.metrics.recoveryHitRate,
        recoveryShots: read.metrics.recoveryShots,
        at: Date.now(),
      });
      // A market whose own walk-forward says "not tradeable" is not a rescue.
      if (read.paperEdgePerDollar <= 0) continue;
      const p = new NavigatorPolicy(
        read.params,
        contracts.normal,
        contracts.recovery,
        buildNavigatorHMMWindows(d, contracts.all),
      );
      for (let i = 0; i < d.length - 1; i++) p.update(d, i);
      p.update(d, d.length - 1);
      const dec = p.decideNormal(d, d.length - 1);
      if (dec.ready && dec.read && (!best || dec.read.utility > best.decision.read!.utility))
        best = { symbol: m.symbol, name: m.displayName, decision: dec };
    }
    if (best) return { fire: best, migrate: null };
    const challenger = scout.bestChallenger("normal", bufferReader, activeSymbol, Date.now(), urgency);
    return {
      fire: null,
      migrate: challenger ? { symbol: challenger.symbol, name: challenger.displayName } : null,
    };
  }
  /**
   * RECOVERY HUNT (switching mode) — two outcomes:
   *  - FIRE: a bar-clearing recovery setup exists RIGHT NOW on another
   *    market → returned; the loop fires it immediately (at most one tick
   *    old — no refit round-trip).
   *  - MIGRATE: no setup ready anywhere, but the scout's composite shows
   *    another market has the better recovery tape → returned; the bot moves
   *    there and the STATIC bar times the shot when the tilt appears.
   */
  async function huntRecovery(): Promise<{
    fire: { symbol: string; name: string; decision: NavigatorDecision } | null;
    migrate: { symbol: string; name: string } | null;
  }> {
    let best: {
      symbol: string;
      name: string;
      decision: NavigatorDecision;
    } | null = null;
    for (const m of AUTOMATED_DERIV_MARKETS.filter((x) => x.digitEnabled)) {
      const d = await readDigits(m.symbol, HUNT_DIGITS);
      if (d.length < 150) continue;
      const read = scoreNavigatorMarket(d, config.plan);
      // The hunt's full fits double as fresh scout cards for every market.
      scout.setCard(m.symbol, {
        edge: read.paperEdgePerDollar,
        recoveryHitRate: read.metrics.recoveryHitRate,
        recoveryShots: read.metrics.recoveryShots,
        at: Date.now(),
      });
      const p = new NavigatorPolicy(
        read.params,
        contracts.normal,
        contracts.recovery,
        buildNavigatorHMMWindows(d, contracts.all),
      );
      for (let i = 0; i < d.length; i++) p.update(d, i);
      const dec = p.decideRecovery(d, d.length - 1);
      if (
        dec.ready &&
        dec.read &&
        (!best || dec.read.utility > best.decision.read!.utility)
      )
        best = { symbol: m.symbol, name: m.displayName, decision: dec };
    }
    if (best && best.symbol !== activeSymbol)
      return { fire: best, migrate: null };
    const challenger = scout.bestChallenger(
      "recovery",
      bufferReader,
      activeSymbol,
      Date.now(),
    );
    return {
      fire: null,
      migrate:
        challenger && challenger.symbol !== activeSymbol
          ? { symbol: challenger.symbol, name: challenger.displayName }
          : null,
    };
  }

  while (session.running && !session.stopRequested) {
    try {
      if (!hasTradingOwnership("bots", owner)) {
        const who = currentTradingOwner(owner);
        session.running = false;
        session.message = `⛔ Stopped — ${who ? tradingOwnerLabel(who) : "another engine"} owns this account`;
        broadcast();
        return;
      }
      const inRecovery = recoveryEngine.isInRecovery();
      if (!policy || Date.now() - lastRefit >= REFIT_MS) {
        if (!(await refit())) {
          session.message = "Collecting digit history for the Navigator model…";
          broadcast();
          await sleep(1200);
          continue;
        }
        lastRefit = Date.now();
        if (!locked) await rotateOneCard();
      }

      // ── NORMAL-MODE SCOUT (fast, composite-only — no re-fit) ─────────────
      // Switching mode redirects the fire budget to a measurably better tape
      // up to every 10s (the legacy bot had NO normal-mode switching at all);
      // hysteresis (margin + cooldown + dwell) keeps it from flapping, and it
      // never vetoes a shot.
      const urgency = scoutUrgency(Date.now());
      const scoutEvery = urgency.level > 0 ? URGENT_SCOUT_MS : NORMAL_SCOUT_MS;
      if (!locked && !inRecovery && policy && Date.now() - lastScout >= scoutEvery) {
        lastScout = Date.now();
        scoutPanel("normal");
        const challenger = scout.bestChallenger(
          "normal",
          bufferReader,
          activeSymbol,
          Date.now(),
          urgency.level > 0 ? urgency : undefined,
        );
        if (challenger) {
          const from = activeName;
          moveTo(challenger.symbol, challenger.displayName);
          if (!(await refit())) {
            await sleep(500);
            continue;
          }
          lastRefit = Date.now();
          const why =
            challenger.via === "urgent"
              ? ` · ${urgency.reason}`
              : challenger.flee
                ? " · active tape dead"
                : "";
          session.message = `🔁 Scout — left ${from} for ${activeName} (${challenger.composite.toFixed(3)} vs ${challenger.activeComposite.toFixed(3)} $/$${why})`;
          broadcast();
          await sleep(200);
          continue;
        }
      }
      const latest = await readDigits(activeSymbol, SCAN_DIGITS);
      // A pending cross-market fire (captured by the hunt) bypasses the feed:
      // the live policy still belongs to the previous market until the
      // post-trade re-fit.
      if (latest.length > digits.length && !pendingFire) {
        for (let i = digits.length; i < latest.length; i++)
          policy!.update(latest, i);
        digits = latest;
        fedLen = latest.length;
        session.watch.ticksWatched += latest.length - lastDigitCount;
        lastDigitCount = latest.length;
        const idx = latest.length - 1;
        lastDecision = inRecovery
          ? policy!.decideRecovery(latest, idx)
          : policy!.decideNormal(latest, idx);
      }
      if (pendingFire) {
        // Fire the hunt-captured setup NOW (at most one tick old).
        if (digitsSymbol !== activeSymbol) {
          digits = latest;
          digitsSymbol = activeSymbol;
          lastDigitCount = digits.length;
        }
        lastDecision = pendingFire;
        pendingFire = null;
      }
      if (!lastDecision || !policy) {
        session.watch.phase = "watching";
        session.watch.reason = "waiting for the next digit tick";
        session.message = `👁 ${activeName} — timing the next setup`;
        broadcast();
        await sleep(500);
        continue;
      }
      applyDecision(lastDecision, radarOf(policy, digits, digits.length - 1));
      // Starvation clock: runs while the normal valve is pinned at break-even
      // on this tape; any ready setup (or a switch) resets it.
      if (!inRecovery && lastDecision.mode === "normal") {
        if (lastDecision.ready) starvedSince = 0;
        else if (lastDecision.starved && starvedSince === 0) starvedSince = Date.now();
        else if (!lastDecision.starved) starvedSince = 0;
      }
      if (!lastDecision.ready) {
        if (
          !inRecovery &&
          !locked &&
          urgency.level >= 0.5 &&
          Date.now() - lastNormalHunt >= NORMAL_HUNT_MS
        ) {
          lastNormalHunt = Date.now();
          session.watch.phase = "hunting";
          session.watch.reason = `hunting every allowed market — ${urgency.reason}`;
          session.message = `🔎 ${activeName} offers no fair setup — hunting other markets instead of forcing one here`;
          broadcast();
          const hunt = await huntNormal(urgency);
          scoutPanel("normal");
          if (hunt.fire) {
            const from = activeName;
            moveTo(hunt.fire.symbol, hunt.fire.name);
            pendingFire = hunt.fire.decision;
            session.message = `🔁 Left ${from} — ${activeName} has a timed ${hunt.fire.decision.side!.label} at ${((hunt.fire.decision.read?.p ?? 0) * 100).toFixed(1)}%, firing now`;
            broadcast();
            continue;
          }
          if (hunt.migrate) {
            const from = activeName;
            moveTo(hunt.migrate.symbol, hunt.migrate.name);
            await refit();
            lastRefit = Date.now();
            session.message = `🔁 Left ${from} for ${activeName} — better normal tape; its valve will time the shot`;
            broadcast();
            await sleep(250);
            continue;
          }
          if (!session.running || session.stopRequested) break;
        }
        if (inRecovery && !locked && Date.now() - lastHunt >= HUNT_MS) {
          lastHunt = Date.now();
          session.watch.phase = "hunting";
          session.watch.reason =
            "hunting every allowed market for a better recovery setup";
          session.message =
            "🔎 Recovery hunt — checking other markets without hardening the bar";
          broadcast();
          const hunt = await huntRecovery();
          scoutPanel("recovery");
          if (hunt.fire) {
            // A bar-clearing setup exists on another market RIGHT NOW —
            // capture it and fire immediately (no refit round-trip).
            moveTo(hunt.fire.symbol, hunt.fire.name);
            pendingFire = hunt.fire.decision;
            session.message = `🔁 Recovery setup on ${activeName} — firing ${hunt.fire.decision.side!.label} now`;
            broadcast();
            continue;
          }
          if (hunt.migrate) {
            // No setup anywhere yet — move to the best recovery tape; the
            // STATIC bar times the shot when the tilt appears.
            moveTo(hunt.migrate.symbol, hunt.migrate.name);
            await refit();
            lastRefit = Date.now();
            session.message = `🔁 Recovery scout — migrating to ${activeName} (better recovery tape)`;
            broadcast();
            await sleep(250);
            continue;
          }
        }
        if (!session.watch.scout && !locked)
          scoutPanel(inRecovery ? "recovery" : "normal");
        session.watch.phase = "watching";
        session.watch.reason = lastDecision.reason;
        session.message = inRecovery
          ? `🛡 Recovery waiting — ${lastDecision.reason}`
          : `👁 ${activeName} — ${lastDecision.reason}`;
        broadcast();
        await sleep(500);
        continue;
      }

      const fire = lastDecision.side!;
      const expected = inRecovery ? contracts.recovery : contracts.normal;
      if (
        !expected.some((c) => c.id === fire.id) ||
        !isAutomatedMarket(activeSymbol)
      ) {
        session.running = false;
        session.message =
          "⚠️ Contract sovereignty check failed — stopped safely";
        broadcast();
        return;
      }
      const quote = await resolveRecoveryPayout({
        symbol: activeSymbol,
        contractType: fire.contractType,
        barrier: fire.barrier,
        duration: DURATION,
        durationUnit: DURATION_UNIT,
        currency,
      });
      const payout = quote.payoutMultiplier || fire.payout;
      if (inRecovery) {
        try {
          const fresh = await db
            .select()
            .from(settingsTable)
            .where(eq(settingsTable.sessionId, owner))
            .limit(1);
          const value = Number((fresh[0] as any)?.botRecoveryMarkup);
          if (Number.isFinite(value)) markup = value;
        } catch {
          /* keep */
        }
      }
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(
            config.stake,
            maxStake,
            balance,
            payout,
            markup,
          )
        : config.stake;
      const step = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing";
      session.watch.reason = `firing ${fire.label} on ${activeName}`;
      session.currentStake = stake;
      session.currentMarket = activeName;
      session.currentContractType = fire.contractType;
      session.message = inRecovery
        ? `🎯 [Recovery R${step}] ${fire.label} · $${stake.toFixed(2)}`
        : `🎯 ${fire.label} · $${stake.toFixed(2)}`;
      broadcast();
      const reason = `[Over/Under Navigator${inRecovery ? " RECOVERY" : ""}] ${fire.label} on ${activeName} · p ${(lastDecision.read!.p * 100).toFixed(1)}% · static bar ${(lastDecision.bar * 100).toFixed(1)}% · pair-risk ${(lastDecision.read!.pairRisk * 100).toFixed(0)}%`;
      const [journaled] = await db
        .insert(tradesTable)
        .values({
          sessionId: owner,
          symbol: activeSymbol,
          displayName: activeName,
          contractType: fire.contractType,
          barrier: fire.barrier,
          stake: String(Math.round(stake * 100) / 100),
          direction: "hold",
          status: "open",
          aiConfidence: String(Math.round(lastDecision.read!.p * 100)),
          aiRiskScore: "15",
          isAutonomous: true,
          agentReasoning: `${paper ? "[PAPER] " : ""}${reason}`,
          duration: DURATION,
          durationUnit: DURATION_UNIT,
        })
        .returning();
      let won = false;
      let profit = 0;
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0;
      let exitPrice = entryPrice;
      if (isLive) {
        try {
          const live = await executeLiveTrade(token!, {
            symbol: activeSymbol,
            contractType: fire.contractType,
            stake: Math.round(stake * 100) / 100,
            duration: DURATION,
            durationUnit: DURATION_UNIT,
            currency,
            accountId: accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            barrier: fire.barrier,
          } as any);
          const result = await waitForContractResult(
            token!,
            accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            live.contractId,
            30_000,
          );
          won = result.won;
          profit = result.profit;
          entryPrice = Number(result.entrySpot) || live.buyPrice;
          exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          await db
            .update(tradesTable)
            .set({
              status: "error",
              profit: "0",
              payout: "0",
              closedAt: new Date(),
              agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
            })
            .where(eq(tradesTable.id, journaled.id));
          session.watch.phase = "watching";
          session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}; back to timing`;
          lastDecision = null;
          broadcast();
          await sleep(1200);
          continue;
        }
      } else {
        session.watch.phase = "settling";
        const before = digits[digits.length - 1];
        let d = before;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const next = tickManager.getDigits(activeSymbol, 1)[0];
          if (next !== undefined && next !== before) {
            d = next;
            break;
          }
          d = next;
        }
        won = fire.wins[d ?? 0] === true;
        profit = won ? stake * (payout - 1) : -stake;
      }
      session.tradeCount++;
      session.totalProfit =
        Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) {
        session.winCount++;
        session.lastResult = "won";
        session.currentLossRun = 0;
      } else {
        session.lossCount++;
        session.lastResult = "lost";
        session.currentLossRun++;
        session.deepestLossRun = Math.max(
          session.deepestLossRun,
          session.currentLossRun,
        );
      }
      recoveryEngine.recordOutcome(
        won,
        profit,
        stake,
        config.maxRecoverySteps,
        fire.contractType,
        payout,
      );
      // The scout's experienced-edge term: this bot's own record per market.
      scout.recordOutcome(activeSymbol, inRecovery ? "recovery" : "normal", won);
      // BLEEDING: a normal-mode loss streak on THIS tape. Penalise the market
      // in the scout (decaying, so it must earn the seat back) and make the
      // scout urgent — "no falling knives" applied to WHERE, not just WHEN.
      if (!inRecovery && !locked) {
        activeLossRun = won ? 0 : activeLossRun + 1;
        if (activeLossRun >= BLEED_STREAK) {
          scout.penalize(activeSymbol, 0.01 * activeLossRun, Date.now());
          bleedingUntil = Date.now() + BLEED_URGENT_MS;
          bleedReason = `bleeding — ${activeLossRun} straight losses on ${activeName}`;
          lastScout = 0; // look immediately on the next pass
        }
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
          .where(eq(tradesTable.id, journaled.id));
      } catch {
        /* best effort */
      }
      if (!isLive && Number.isFinite(balance))
        balance = Math.max(0, balance + profit);
      if (isLive) {
        try {
          const nextBalance = await getLiveBalance(
            token!,
            accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
          );
          if (nextBalance !== null) balance = nextBalance;
        } catch {
          /* best effort */
        }
      }
      session.watch = {
        ...freshWatch(),
        ticksWatched: session.watch.ticksWatched,
        confidence: session.activeRead?.confidence ?? 0,
        verdict: session.activeRead?.verdict ?? "—",
      };
      lastDecision = null;
      lastRefit = 0;
      session.message = won
        ? `✅ +$${profit.toFixed(2)} · recovery ledger re-evaluating`
        : `❌ −$${Math.abs(profit).toFixed(2)} · recovery stays available; bar unchanged`;
      broadcast();
      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached.`;
        broadcast();
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit.`;
        broadcast();
        return;
      }
      await sleep(won ? 300 : 400);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error(
        { err, consecutiveErrors },
        "Over/Under Navigator stability catch",
      );
      session.message = `Engine stabilizing… retry ${consecutiveErrors}`;
      broadcast();
      await sleep(Math.min(10_000, 500 * consecutiveErrors));
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
