/**
 * TWIN-HEDGE EDGE — execution engine of the 11th specialist bot.
 *
 * The analysis layer answers "which side of this digit pair carries an edge, and
 * how much should the stake skew". This layer answers the two questions the bot
 * is really about:
 *
 *   1. IS THIS THE TICK — the same timing discipline the Over/Under Oracle uses
 *      (momentum, Markov-state preference, renewal position, feed freshness,
 *      evidence independence) applied to the favoured leg.
 *   2. BOTH LEGS, ONE MARKET, SAME TICK — the OVER and UNDER contracts are placed
 *      in parallel (Promise.all) on the ACTIVE symbol only. Switching may change
 *      which market the bot re-measures, but it can never split a pair-shot
 *      across two markets, and it can never fire one leg without the other.
 *
 * Recovery is the shared account-global ledger. Because a pair-shot loses less
 * than its total stake (the hedge leg pays on the losing tick), the debt is the
 * realised NET loss, and the effective recovery payout is the expected $ net
 * returned by a winning pair-shot per $1 of base stake.
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
import * as recoveryEngine from "./agents/recovery-engine";
import {
  acquireTradingOwnership,
  releaseTradingOwnership,
  hasTradingOwnership,
  currentTradingOwner,
  tradingOwnerLabel,
} from "./engine-arbiter";
import { evaluateTiming } from "./killshot-timing";
import {
  twinLabel,
  twinOutcome,
  twinPayouts,
  buildTwinPlan,
  twinRegionNet,
  evaluateTwinCandidate,
  evaluateTwinLiveEntry,
  screenTwinCandidates,
  TWIN_SCAN_WINDOW,
  TWIN_MIN_HISTORY,
  type TwinContract,
  type TwinCertainty,
  type TwinSide,
  type TwinModelCard,
  type TwinCandidate,
  type TwinPlan,
} from "./twin-hedge-analysis";

export const TWIN_BOT_ID = "twin-hedge";

const MAX_BAR_BOOST = 2.5;
const REANALYZE_LOCKED_MS = 15_000;
const REANALYZE_SWITCHING_MS = 45_000;
const SWITCH_MARGIN = 0.01;

// ── Spec / status ─────────────────────────────────────────────────────────────

export interface TwinDeploySpec {
  contract: TwinContract;
  certainty: TwinCertainty;
  targetEvPerDollar: number;
}

export interface TwinConfig {
  ownerSessionId?: string;
  botId: string;
  spec: TwinDeploySpec;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  symbol: string;
  displayName: string;
  card: TwinModelCard;
  lockedAnalysis?: TwinCandidate;
}

export interface TwinDeployed {
  symbol: string;
  displayName: string;
  contract: string;
  verdict: string;
  confidence: number;
  edgePerDollar: number;
  oosWinRate: number;
  oosShots: number;
  primary: TwinSide;
  bias: number;
  overPayout: number;
  underPayout: number;
  netOnWinPerBase: number;
  netOnLossPerBase: number;
}

export interface TwinWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  pOver: number;
  pUnder: number;
  primary: TwinSide;
  bias: number;
  edgePerBase: number;
  z: number;
  bar: number;
  reason: string;
  switched: boolean;
  confidence: number;
  verdict: string;
  ticksWatched: number;
  overStake: number;
  underStake: number;
}

export interface TwinStatus {
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
    contract: TwinContract;
    certainty: TwinCertainty;
    targetEvPerDollar: number;
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    marketMode: "locked" | "switching";
    lockedSymbol?: string;
  };
  deployed?: TwinDeployed;
  twinWatch?: TwinWatch;
}

export interface TwinCandidateSummary {
  symbol: string;
  displayName: string;
  contract: TwinContract;
  label: string;
  verdict: string;
  confidence: number;
  edgePerDollar: number;
  evLowerPerDollar: number;
  oosWinRate: number;
  oosShots: number;
  primary: TwinSide;
  bias: number;
  breakEvenWinRate: number;
  overPayout: number;
  underPayout: number;
  netOnWinPerBase: number;
  netOnLossPerBase: number;
  ladderSafety: number;
  ladderLimit: number;
  deployable: boolean;
  card: TwinModelCard;
}

export interface TwinScanResult {
  suitable: boolean;
  best: TwinCandidateSummary | null;
  bestAvailable: TwinCandidateSummary | null;
  allScored: TwinCandidateSummary[];
  reason: string;
  certainty: TwinCertainty;
  marketsScanned: number;
  historyDepth: number;
  outcome: {
    overCount: number;
    underCount: number;
    bothCount: number;
    noneCount: number;
    complementary: boolean;
  };
}

export function isTwinBot(botId: string): boolean {
  return botId === TWIN_BOT_ID;
}

function simplify(c: TwinCandidate): TwinCandidateSummary {
  return {
    symbol: c.symbol,
    displayName: c.displayName,
    contract: c.contract,
    label: c.label,
    verdict: c.verdict,
    confidence: c.confidence,
    edgePerDollar: c.edgePerDollar,
    evLowerPerDollar: c.evLowerPerDollar,
    oosWinRate: c.oosWinRate,
    oosShots: c.oosShots,
    primary: c.primary,
    bias: c.bias,
    breakEvenWinRate: c.breakEvenWinRate,
    overPayout: c.overPayout,
    underPayout: c.underPayout,
    netOnWinPerBase: c.netOnWinPerBase,
    netOnLossPerBase: c.netOnLossPerBase,
    ladderSafety: c.ladder.safety,
    ladderLimit: c.ladder.limit,
    deployable: c.deployable,
    card: c.card,
  };
}

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: TwinConfig | null;
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
  watch: TwinWatch;
  activeSymbol?: string;
  activeName?: string;
  activeContract?: TwinContract;
  activePrimary?: TwinSide;
  activeRead?: TwinCandidate | null;
  lastPlan?: TwinPlan;
}

function freshWatch(): TwinWatch {
  return {
    phase: "watching",
    pOver: 0,
    pUnder: 0,
    primary: "over",
    bias: 0.1,
    edgePerBase: 0,
    z: 0,
    bar: 0,
    reason: "",
    switched: false,
    confidence: 0,
    verdict: "—",
    ticksWatched: 0,
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
  };
}

let session: SessionState = freshSession();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

function deployed(): TwinDeployed | undefined {
  const read = session.activeRead;
  if (!read) return undefined;
  return {
    symbol: read.symbol,
    displayName: read.displayName,
    contract: read.label,
    verdict: read.verdict,
    confidence: read.confidence,
    edgePerDollar: read.edgePerDollar,
    oosWinRate: read.oosWinRate,
    oosShots: read.oosShots,
    primary: read.primary,
    bias: read.bias,
    overPayout: read.overPayout,
    underPayout: read.underPayout,
    netOnWinPerBase: read.netOnWinPerBase,
    netOnLossPerBase: read.netOnLossPerBase,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): TwinStatus {
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
          contract: cfg.spec.contract,
          certainty: cfg.spec.certainty,
          targetEvPerDollar: cfg.spec.targetEvPerDollar,
          stake: cfg.stake,
          stopLoss: cfg.stopLoss,
          takeProfit: cfg.takeProfit,
          maxRecoverySteps: cfg.maxRecoverySteps,
          marketMode: cfg.marketMode,
          lockedSymbol: cfg.lockedSymbol,
        }
      : undefined,
    deployed: session.running ? deployed() : undefined,
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

// ── Pre-deploy scan ───────────────────────────────────────────────────────────

export async function scanForTwin(
  ownerSessionId: string | undefined,
  spec: TwinDeploySpec,
  risk: { stake: number },
): Promise<TwinScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
  const all: TwinCandidate[] = [];
  let deepest = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE(
      "bot_scan_progress",
      {
        botId: TWIN_BOT_ID,
        scanning: market.displayName,
        symbol: market.symbol,
        scanned: i,
        total: markets.length,
      },
      ownerSessionId,
    );

    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, TWIN_SCAN_WINDOW);
    } catch {
      digits = tickManager.getDigits(market.symbol, TWIN_SCAN_WINDOW);
    }
    deepest = Math.max(deepest, digits.length);
    const cand = evaluateTwinCandidate(
      market.symbol,
      market.displayName,
      digits,
      spec.contract,
      {
        certainty: spec.certainty,
        baseStake: risk.stake,
        targetEvPerDollar: spec.targetEvPerDollar,
      },
    );
    if (cand) all.push(cand);
    await sleep(5);
  }

  const ranked = screenTwinCandidates(all);
  broadcastSSE(
    "bot_scan_progress",
    {
      botId: TWIN_BOT_ID,
      scanning: null,
      symbol: null,
      scanned: markets.length,
      total: markets.length,
    },
    ownerSessionId,
  );

  const best = ranked[0];
  const outcome = twinOutcome(spec.contract);
  if (!best) {
    return {
      suitable: false,
      best: null,
      bestAvailable: null,
      allScored: [],
      certainty: spec.certainty,
      marketsScanned: markets.length,
      historyDepth: deepest,
      reason:
        "Not enough history yet — the digit feed is still warming up. Wait a moment and re-measure.",
      outcome,
    };
  }
  const suitable = best.deployable;
  const reason = suitable
    ? `${best.displayName} · ${best.label} — ${best.oosShots} unseen pair shots at ${(best.oosWinRate * 100).toFixed(0)}% joint win rate, ${(best.edgePerDollar * 100).toFixed(2)}% net per $1 base.`
    : `No ${best.label} setup cleared the bar — best was ${best.displayName} (${best.verdict.toUpperCase()}, ${best.confidence}/100).`;

  return {
    suitable,
    best: suitable ? simplify(best) : null,
    bestAvailable: simplify(best),
    allScored: ranked.slice(0, 12).map(simplify),
    reason,
    certainty: spec.certainty,
    marketsScanned: markets.length,
    historyDepth: deepest,
    outcome,
  };
}

// ── Session start ─────────────────────────────────────────────────────────────

export async function startSession(
  config: TwinConfig,
): Promise<{ ok: boolean; error?: string }> {
  if (session.running)
    return {
      ok: false,
      error: "A Twin-Hedge bot is already active — stop it first",
    };
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
  if (!config.card || !Number.isFinite(Number(config.card.tau)))
    return fail(
      "Run the analysis first — this bot only deploys a rule it has measured",
    );
  if (
    !Number.isInteger(config.spec.contract.overDigit) ||
    config.spec.contract.overDigit < 0 ||
    config.spec.contract.overDigit > 8
  )
    return fail("Over digit must be 0–8");
  if (
    !Number.isInteger(config.spec.contract.underDigit) ||
    config.spec.contract.underDigit < 1 ||
    config.spec.contract.underDigit > 9
  )
    return fail("Under digit must be 1–9");

  const market = AUTOMATED_DERIV_MARKETS.find(
    (m) => m.symbol === config.symbol,
  );
  if (!market || !market.digitEnabled)
    return fail("This bot needs a digit-enabled market");

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_twin_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    currentContractType: twinLabel(config.spec.contract),
    activeSymbol: config.symbol,
    activeName: config.displayName,
    activeContract: { ...config.spec.contract },
    activeRead: null,
    message:
      config.marketMode === "locked"
        ? `🔒 Locked on ${config.displayName} · ${twinLabel(config.spec.contract)} — both legs trade this market only.`
        : `🔁 Deployed on ${config.displayName} · ${twinLabel(config.spec.contract)} — will re-measure for a better market if this one cools.`,
  };

  logger.info(
    {
      botId: config.botId,
      pair: twinLabel(config.spec.contract),
      marketMode: config.marketMode,
      symbol: config.symbol,
    },
    "Twin-Hedge session starting",
  );
  broadcast();

  runLoop(config)
    .catch((err) => {
      logger.error({ err }, "Twin-Hedge runLoop error");
      session.running = false;
      session.message = `⚠️ ${friendlyErrorMessage(err)}`;
      broadcast();
    })
    .finally(() => releaseTradingOwnership("bots"));

  return { ok: true };
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: TwinConfig) {
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
    .where(
      and(
        eq(accountsTable.sessionId, ownerSessionId),
        eq(accountsTable.isActive, true),
      ),
    )
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

  const paperTradeMode =
    settings.length > 0
      ? ((settings[0] as any).paperTradeMode ?? false)
      : false;
  const token =
    accounts.length > 0
      ? (accounts[0].bearerToken ?? accounts[0].token ?? null)
      : null;
  const currency = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake =
    settings.length > 0 ? Number(settings[0].maxTradeStake) : 500;
  let botRecoveryMarkup =
    settings.length > 0
      ? Number((settings[0] as any).botRecoveryMarkup ?? 10)
      : 10;
  let availableBalance =
    accounts.length > 0 && Number(accounts[0].balance) > 0
      ? Number(accounts[0].balance)
      : Number.POSITIVE_INFINITY;

  const SPEC = config.spec;
  const LOCKED = config.marketMode === "locked";
  const REANALYZE_MS = LOCKED ? REANALYZE_LOCKED_MS : REANALYZE_SWITCHING_MS;

  let activeSymbol: string = config.symbol;
  let activeName: string = config.displayName;
  let activeContract: TwinContract = { ...config.spec.contract };
  let activeCard: TwinModelCard = { ...config.card };
  let activeRead: TwinCandidate | null = null;

  let ticksSinceLoss = Number.POSITIVE_INFINITY;
  let ticksSinceLastShot = Number.POSITIVE_INFINITY;
  let lossRun = 0;
  let timingWaitTicks = 0;
  let lastDigitCount = 0;
  let lastReanalyzeAt = 0;
  let consecutiveErrors = 0;

  async function analyzeActive(): Promise<TwinCandidate | null> {
    const markets = LOCKED
      ? AUTOMATED_DERIV_MARKETS.filter((m) => m.symbol === activeSymbol)
      : AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
    const all: TwinCandidate[] = [];
    for (const market of markets) {
      let digits: number[] = [];
      try {
        digits = await getDeepDigits(market.symbol, TWIN_SCAN_WINDOW);
      } catch {
        digits = tickManager.getDigits(market.symbol, TWIN_SCAN_WINDOW);
      }
      if (digits.length < TWIN_MIN_HISTORY) continue;
      const cand = evaluateTwinCandidate(
        market.symbol,
        market.displayName,
        digits,
        activeContract,
        {
          certainty: SPEC.certainty,
          baseStake: config.stake,
          targetEvPerDollar: SPEC.targetEvPerDollar,
        },
      );
      if (cand) all.push(cand);
    }
    const ranked = screenTwinCandidates(all);
    const positive = ranked.filter((c) => c.edgePerDollar > 0);
    if (positive.length === 0) return null;
    const best = positive[0]!;
    if (!LOCKED && best.symbol !== activeSymbol) {
      const currentBest = positive.find((c) => c.symbol === activeSymbol);
      if (
        currentBest &&
        currentBest.edgePerDollar > 0 &&
        best.edgePerDollar - currentBest.edgePerDollar < SWITCH_MARGIN
      ) {
        return currentBest;
      }
    }
    return best;
  }

  while (session.running && !session.stopRequested) {
    try {
      session.watch.switched = false;
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

      const inRecovery = recoveryEngine.isInRecovery();
      let digits = await getDeepDigits(activeSymbol, TWIN_SCAN_WINDOW);
      if (digits.length !== lastDigitCount) {
        const delta = Math.max(0, digits.length - lastDigitCount);
        session.watch.ticksWatched += delta;
        if (Number.isFinite(ticksSinceLastShot)) ticksSinceLastShot += delta;
        if (Number.isFinite(ticksSinceLoss)) ticksSinceLoss += delta;
        lastDigitCount = digits.length;
      }

      // Periodic re-measure (rotation or re-selection — never a dead-end).
      const needsReanalyze =
        activeRead === null || Date.now() - lastReanalyzeAt >= REANALYZE_MS;
      if (needsReanalyze) {
        const pick = await analyzeActive();
        lastReanalyzeAt = Date.now();
        if (pick) {
          const rotated =
            pick.symbol !== activeSymbol ||
            pick.contract.overDigit !== activeContract.overDigit ||
            pick.contract.underDigit !== activeContract.underDigit;
          activeSymbol = pick.symbol;
          activeName = pick.displayName;
          activeContract = pick.contract;
          activeCard = pick.card;
          activeRead = pick;
          session.activeSymbol = pick.symbol;
          session.activeName = pick.displayName;
          session.activeContract = pick.contract;
          session.activeRead = pick;
          session.currentMarket = pick.displayName;
          session.currentContractType = twinLabel(pick.contract);
          session.watch.confidence = pick.confidence;
          session.watch.verdict = pick.verdict;
          if (rotated) {
            session.watch.switched = true;
            session.message = LOCKED
              ? `🔁 Edge moved on ${pick.displayName} — both legs still trade ${twinLabel(pick.contract)} here.`
              : `🔁 Rotated to ${pick.displayName} · ${twinLabel(pick.contract)}`;
          }
          digits = await getDeepDigits(activeSymbol, TWIN_SCAN_WINDOW);
        } else {
          activeRead = null;
          session.watch.phase = "watching";
          session.watch.reason = "no positive pair edge measured right now";
          session.message = LOCKED
            ? `Holding on ${activeName} — no positive pair edge right now`
            : `Scanning markets — no positive pair edge measured right now`;
          broadcast();
          await sleep(1500);
          continue;
        }
      }

      // Live pair entry gate (post-loss shield applied).
      const barBoost = Math.min(
        MAX_BAR_BOOST,
        activeCard.postLossTightening * (lossRun + (inRecovery ? 1 : 0)),
      );
      const entry = evaluateTwinLiveEntry(digits, activeContract, activeCard, {
        barBoost,
        ticksSinceLoss,
      });
      session.watch.pOver = entry.pOver;
      session.watch.pUnder = entry.pUnder;
      session.watch.primary = entry.primary;
      session.watch.bias = entry.bias;
      session.watch.edgePerBase = entry.edgePerBase;
      session.watch.z = entry.zGate;
      session.watch.bar = entry.bar;

      if (!entry.ready) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        session.watch.reason = shortReason(entry.reason);
        session.message = inRecovery
          ? `🎯 Recovery armed — ${session.watch.reason}`
          : `👁 ${twinLabel(activeContract)} on ${activeName} — ${session.watch.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }

      // Timing gate — the Over/Under Oracle discipline, applied to the favoured leg.
      session.watch.phase = "armed";
      const favouredWinSet =
        twinOutcome(activeContract)[
          entry.primary === "over" ? "overWinSet" : "underWinSet"
        ];
      const timing = evaluateTiming({
        digits,
        winSet: favouredWinSet,
        secondsSinceLastTick: tickManager.getTickAgeSeconds(activeSymbol),
        medianTickGapSeconds: activeSymbol.startsWith("1HZ") ? 1 : 2,
        ticksSinceLastShot,
        waitedTicks: timingWaitTicks,
        minSpacing: activeCard.minSpacing,
      });

      if (!timing.ready) {
        timingWaitTicks++;
        session.watch.reason = shortTiming(timing.reason);
        session.message = inRecovery
          ? `🎯 Recovery armed — ${session.watch.reason}`
          : `⏳ Armed on ${activeName} · ${twinLabel(activeContract)} — ${session.watch.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }
      timingWaitTicks = 0;

      // Contract sovereignty — both legs always on the active, digit-enabled market.
      if (!isAutomatedMarket(activeSymbol)) {
        session.running = false;
        session.message =
          "⚠️ Contract sovereignty check failed — session halted before firing";
        broadcast();
        return;
      }

      // Stake plan with shared recovery scaling.
      const preferredRegion =
        entry.primary === "over" ? "overOnly" : "underOnly";
      const plan1 = buildTwinPlan(activeContract, entry.primary, entry.bias, 1);
      const netWinPerBase = Math.max(
        1e-6,
        twinRegionNet(activeContract, plan1, preferredRegion),
      );
      const effPayout = 1 + netWinPerBase;

      if (inRecovery) {
        try {
          const fresh = await db
            .select()
            .from(settingsTable)
            .where(eq(settingsTable.sessionId, ownerSessionId))
            .limit(1);
          if (fresh.length > 0) {
            const v = Number((fresh[0] as any).botRecoveryMarkup);
            if (Number.isFinite(v)) botRecoveryMarkup = v;
          }
        } catch {
          /* keep previous */
        }
      }

      let baseStake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(
            config.stake,
            maxStake / 2,
            availableBalance,
            effPayout,
            botRecoveryMarkup,
          )
        : config.stake;
      let plan = buildTwinPlan(
        activeContract,
        entry.primary,
        entry.bias,
        baseStake,
      );
      // Pair safety: total exposure is both legs combined.
      let totalExposure = plan.overStake + plan.underStake;
      if (
        Number.isFinite(availableBalance) &&
        totalExposure > availableBalance
      ) {
        const scale = Math.max(0.01, availableBalance / totalExposure);
        plan = buildTwinPlan(
          activeContract,
          entry.primary,
          entry.bias,
          baseStake * scale,
        );
        totalExposure = plan.overStake + plan.underStake;
      }
      if (baseStake < 0.35) {
        plan = buildTwinPlan(activeContract, entry.primary, entry.bias, 0.35);
        totalExposure = plan.overStake + plan.underStake;
      }
      session.lastPlan = plan;

      session.watch.phase = "firing";
      session.currentStake = Math.round(totalExposure * 100) / 100;
      session.currentMarket = activeName;
      session.currentContractType = twinLabel(activeContract);
      session.watch.overStake = plan.overStake;
      session.watch.underStake = plan.underStake;
      const recTag = recoveryEngine.getState().recoveryStep;
      session.message = inRecovery
        ? `🎯 [Recovery R${recTag}] ${twinLabel(activeContract)} on ${activeName} · O $${plan.overStake.toFixed(2)} / U $${plan.underStake.toFixed(2)}`
        : `🎯 ${twinLabel(activeContract)} on ${activeName} · O $${plan.overStake.toFixed(2)} / U $${plan.underStake.toFixed(2)}`;
      broadcast();

      const reason =
        `[Twin-Hedge${inRecovery ? " RECOVERY" : ""}] ${twinLabel(activeContract)} on ${activeName} · ` +
        `primary ${entry.primary.toUpperCase()} (bias ${(entry.bias * 100).toFixed(1)}%) · ` +
        `P(over|ctx) ${(entry.pOver * 100).toFixed(1)}% · P(under|ctx) ${(entry.pUnder * 100).toFixed(1)}% · ` +
        `edge ${(entry.edgePerBase * 100).toFixed(2)}% per $1 base · z ${entry.zGate.toFixed(2)}σ / bar ${entry.bar.toFixed(2)}σ`;

      const bar = activeContract.overDigit;
      const [journ] = await db
        .insert(tradesTable)
        .values({
          sessionId: ownerSessionId,
          symbol: activeSymbol,
          displayName: activeName,
          contractType: "DIGITOVER",
          barrier: bar,
          stake: String(Math.round(totalExposure * 100) / 100),
          direction: "hold",
          status: "open",
          aiConfidence: String(
            activeRead?.confidence ?? Math.round(entry.edgePerBase * 1000),
          ),
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

      if (isLive) {
        const overDigit = activeContract.overDigit;
        const underDigit = activeContract.underDigit;
        try {
          // Place BOTH legs in parallel. If one is rejected we still settle the
          // other (so a placed contract is never left orphaned) and journal the
          // partial result rather than pretending the pair shot never happened.
          const [overRes, underRes] = await Promise.allSettled([
            executeLiveTrade(token!, {
              symbol: activeSymbol,
              contractType: "DIGITOVER",
              stake: Math.round(plan.overStake * 100) / 100,
              duration: 1,
              durationUnit: "t",
              currency,
              accountId: accounts[0].derivAccountId ?? accounts[0].loginId,
              barrier: overDigit,
            } as any),
            executeLiveTrade(token!, {
              symbol: activeSymbol,
              contractType: "DIGITUNDER",
              stake: Math.round(plan.underStake * 100) / 100,
              duration: 1,
              durationUnit: "t",
              currency,
              accountId: accounts[0].derivAccountId ?? accounts[0].loginId,
              barrier: underDigit,
            } as any),
          ]);

          const overBuy = overRes.status === "fulfilled" ? overRes.value : null;
          const underBuy =
            underRes.status === "fulfilled" ? underRes.value : null;
          if (!overBuy && !underBuy) {
            const firstErr =
              overRes.status === "rejected"
                ? overRes.reason
                : underRes.status === "rejected"
                  ? underRes.reason
                  : new Error("Both legs rejected");
            throw firstErr;
          }

          const [overSettle, underSettle] = await Promise.all([
            overBuy
              ? waitForContractResult(
                  token!,
                  accounts[0].derivAccountId ?? accounts[0].loginId,
                  overBuy.contractId,
                  30_000,
                ).catch(() => null)
              : Promise.resolve(null),
            underBuy
              ? waitForContractResult(
                  token!,
                  accounts[0].derivAccountId ?? accounts[0].loginId,
                  underBuy.contractId,
                  30_000,
                ).catch(() => null)
              : Promise.resolve(null),
          ]);

          profit = (overSettle?.profit ?? 0) + (underSettle?.profit ?? 0);
          won = profit > 0;
          entryPrice =
            Number(overSettle?.entrySpot ?? underSettle?.entrySpot) ||
            overBuy?.buyPrice ||
            underBuy?.buyPrice ||
            entryPrice;
          exitPrice =
            Number(underSettle?.exitSpot ?? overSettle?.exitSpot) || entryPrice;
          if (!overBuy || !underBuy) {
            session.watch.phase = "watching";
            session.message = `⚠️ One leg was rejected by Deriv — settled the ${overBuy ? "OVER" : "UNDER"} leg alone. Back to watching.`;
            broadcast();
          }
        } catch (err) {
          logger.warn(
            { err },
            "Twin-Hedge live execution error — returning to the watch",
          );
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
        session.watch.phase = "settling";
        const before = tickManager.getDigits(activeSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const d = tickManager.getDigits(activeSymbol, 1)[0];
          if (d !== undefined && d !== before) {
            digit = d;
            break;
          }
          digit = d;
        }
        const d = digit ?? 0;
        const overWon = d > activeContract.overDigit;
        const underWon = d < activeContract.underDigit;
        const payouts = twinPayouts(activeContract);
        profit =
          (overWon ? plan.overStake * (payouts.over - 1) : -plan.overStake) +
          (underWon ? plan.underStake * (payouts.under - 1) : -plan.underStake);
        won = profit > 0;
      }

      session.tradeCount++;
      const netLoss = Math.max(0, -profit);
      session.totalProfit =
        Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) {
        session.winCount++;
        session.lastResult = "won";
        session.currentLossRun = 0;
        lossRun = 0;
        ticksSinceLoss = Number.POSITIVE_INFINITY;
      } else {
        session.lossCount++;
        session.lastResult = "lost";
        session.currentLossRun++;
        session.deepestLossRun = Math.max(
          session.deepestLossRun,
          session.currentLossRun,
        );
        lossRun++;
        ticksSinceLoss = 0;
      }

      recoveryEngine.recordOutcome(
        won,
        profit,
        netLoss || Math.abs(profit),
        config.maxRecoverySteps,
        "DIGITOVER",
        effPayout,
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
          })
          .where(eq(tradesTable.id, journ.id));
      } catch (dbErr) {
        logger.warn(
          { dbErr },
          "Twin-Hedge: failed to settle the journaled trade",
        );
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
        ticksWatched: session.watch.ticksWatched,
        confidence: activeRead?.confidence ?? 0,
        verdict: activeRead?.verdict ?? "—",
      };
      ticksSinceLastShot = 0;
      timingWaitTicks = 0;
      lastReanalyzeAt = 0;
      session.message = won
        ? `✅ +$${profit.toFixed(2)} · ${session.winCount}/${session.tradeCount} · both legs closed on the same tick`
        : `❌ −$${Math.abs(profit).toFixed(2)} · hedge covered part of the loss · ${session.currentLossRun} in a row`;
      broadcast();

      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached in ${session.tradeCount} pair shots.`;
        broadcast();
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit after ${session.tradeCount} pair shots. Session stopped safely.`;
        broadcast();
        return;
      }

      await sleep(won ? 2500 : 4000);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Twin-Hedge stability catch — keeping the session alive");
      // Never self-stop on transient errors — the session only stops on TP,
      // SL, or a manual stop. Back off (capped) and keep retrying.
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

function shortReason(full: string): string {
  if (full.includes("building history"))
    return `collecting history — ${full.replace("building history — ", "")}`;
  if (full.includes("calibrating")) return "calibrating the live scale";
  if (full.includes("post-loss cool-down"))
    return `post-loss cool-down ${full.replace("post-loss cool-down — ", "")}`;
  if (full.includes("under the"))
    return "waiting for the pair edge to clear the bar";
  if (full.includes("not positive"))
    return "pair edge not positive at this reading";
  return "waiting for the pair edge";
}

function shortTiming(full: string): string {
  if (full.includes("re-spacing")) return "spacing out shots";
  if (full.includes("feed")) return "tick feed lagging";
  if (full.includes("colder")) return "momentum cooling";
  if (full.includes("favoured state")) return "waiting for the favoured state";
  if (full.includes("renewal clock")) return "renewal clock just reset";
  if (full.includes("drought")) return "drought — regime may have broken";
  if (full.includes("below the")) return "entry quality below the bar";
  return "holding for a better entry";
}
