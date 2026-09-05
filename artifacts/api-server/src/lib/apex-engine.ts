/**
 * APEX ONE-SHOT SNIPER — execution engine (7th specialist bot).
 *
 * OPERATING MODEL
 * ───────────────
 * ANALYSE ONCE, LOCK, THEN WAIT. There are exactly two decisions in this bot's
 * life and both happen before it trades:
 *
 *   1. WHAT to trade — the user names ONE contract (Over N, Under N, Matches,
 *      Even or Odd — never both sides of a pair). It is frozen for the session
 *      and re-checked immediately before every buy.
 *   2. WHERE to trade — the scan names ONE market, chosen by the analysis in
 *      `apex-analysis.ts`, and it is FROZEN. There is no hunt mode, no rotation
 *      and no switching, exactly like the Barrier Architect in locked mode. The
 *      user asked for this explicitly and the engine has no code path that can
 *      move it: `LOCKED_SYMBOL` is a const captured once at session start.
 *
 * Everything after that is patience. The loop's normal state is "watching, not
 * trading", and firing is the exception.
 *
 * THE THREE GATES A SHOT MUST PASS, IN ORDER
 * ──────────────────────────────────────────
 *  · MARKET — the live re-read of the locked market must still be deployable at
 *    the chosen certainty level (replayed accuracy, ladder safety, loss pairing,
 *    stationarity, concordance, SPRT).
 *  · CONTEXT — `evaluateApexEntry`: the conditional estimate's conservative floor
 *    must clear break-even on a context with enough observations behind it. This
 *    is the identical rule the walk-forward replay priced, so the accuracy quoted
 *    on the scan card describes the decisions the live bot makes.
 *  · TICK — `evaluateApexTiming`: momentum, the favoured Markov state, the
 *    renewal clock, feed freshness and shot spacing. Its patience valve takes the
 *    shot anyway once an objection has stood `maxWaitTicks`, so a conclusive
 *    setup never rots.
 *
 * THE DRIFT GUARD — WHAT "NO ROTATION" COSTS, AND HOW IT IS PAID
 * ──────────────────────────────────────────────────────────────
 * A market that cannot be rotated out of can still go bad. So the engine runs a
 * Page–Hinkley change detector on the locked market's realised win rate. When it
 * fires the bot STOPS FIRING — it does not quietly move to another market, which
 * is the one thing the user forbade. If the decay persists for
 * DRIFT_HALT_EVALS consecutive evaluations the session halts and asks for a
 * re-analysis, because a lock whose premise has measurably ended is not a lock
 * worth holding.
 *
 * SHARED RECOVERY, IDENTICAL TO THE OTHER BOTS
 * ────────────────────────────────────────────
 * The ONE account-global ledger (`lib/agents/recovery-engine.ts`), the ONE
 * debt-driven stake formula (`getBotRecoveryStake`) and the ONE single-executor
 * arbiter (`lib/engine-arbiter.ts`, owner `bots`). No private debt state. A
 * recovery shot waits for the same three gates as a normal one — a recovery trade
 * taken in a hurry is exactly how a two-loss streak becomes a five-loss streak.
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
  evaluateApexCandidate,
  evaluateApexEntry,
  screenApexCandidates,
  apexLabel,
  apexWinSet,
  apexPayout,
  certaintySpec,
  APEX_CONTRACT_TYPE,
  APEX_WINDOW,
  type ApexCandidate,
  type ApexCertainty,
  type ApexContract,
} from "./apex-analysis";
import { evaluateApexTiming } from "./apex-timing";

export const APEX_BOT_ID = "apex";
const BOT_NAME = "Apex One-Shot Sniper";

/** Consecutive drift-flagged evaluations before the lock is declared dead. */
const DRIFT_HALT_EVALS = 4;
/** How often the expensive market-level re-read runs, in ms. */
const REREAD_INTERVAL_MS = 3000;

// ── Config / status ───────────────────────────────────────────────────────────

export interface ApexConfig {
  ownerSessionId?: string;
  /** The market the scan locked. FROZEN for the whole session. */
  symbol: string;
  displayName: string;
  /** FROZEN contract — exactly one side, never both. */
  contract: ApexContract;
  /** Which certainty bar this session is held to. */
  certainty: ApexCertainty;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  /** Stop after this many shots (0 = until TP/SL). */
  maxShots: number;
  /** Pre-deploy analysis, kept for the UI and the journal. */
  lockedAnalysis?: ApexCandidate;
}

export interface ApexLockInfo {
  symbol: string;
  displayName: string;
  contract: string;
  certainty: string;
  confidence: number;
  payout: number;
  breakEven: number;
  /** Replayed accuracy of the entry rule — the bot's actual promise. */
  replayWinRate: number;
  replayShots: number;
  replayFireRate: number;
  /** 1 − P(the ladder breaks) over the projection horizon. */
  ladderSafety: number;
  ladderLimit: number;
  ladderHorizon: number;
  expectedShotsToBreak: number;
  /** ξ = P(L|L)/P(L) on the replayed shots, and its 95 % upper bound. */
  xi: number;
  xiUpper: number;
  signals: string[];
}

export interface ApexWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  /** Live composite confidence on the locked market, 0–100. */
  confidence: number;
  /** Conditional P(win | current context). */
  condP: number;
  /** Its conservative floor, and the bar it must clear. */
  condLower: number;
  bar: number;
  marginPP: number;
  contextOrder: number;
  contextCount: number;
  /** Market-level blockers (empty when the market gate is clear). */
  blockers: string[];
  /** Ticks observed this session. */
  ticksWatched: number;
  /** Setups the bot declined. */
  setupsRejected: number;
  /** Page–Hinkley drift state on the locked market. */
  drift: { ph: number; threshold: number; fired: boolean; consecutive: number };
  /** Entry-timing layer. */
  entry: {
    ready: boolean;
    score: number;
    waitTicks: number;
    reason: string;
    momentumPP: number;
    gapRatio: number;
    preferredState: "after-loss" | "after-win" | "none";
    stateEdgePP: number;
  };
}

export interface ApexStatus {
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
  /** Deepest consecutive-loss run realised this session. */
  deepestLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: Omit<ApexConfig, "ownerSessionId" | "lockedAnalysis">;
  apexLock?: ApexLockInfo;
  watch?: ApexWatch;
}

export interface ApexScanResult {
  suitable: boolean;
  best: ApexCandidate | null;
  allScored: ApexCandidate[];
  reason: string;
  certainty: ApexCertainty;
  marketsScanned: number;
}

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: ApexConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  consecutiveRecoveryLosses: number;
  deepestLossRun: number;
  currentLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  stopRequested: boolean;
  watch: ApexWatch;
}

function freshWatch(): ApexWatch {
  return {
    phase: "watching",
    confidence: 0,
    condP: 0,
    condLower: 0,
    bar: 0,
    marginPP: 0,
    contextOrder: 0,
    contextCount: 0,
    blockers: [],
    ticksWatched: 0,
    setupsRejected: 0,
    drift: { ph: 0, threshold: 8, fired: false, consecutive: 0 },
    entry: {
      ready: false, score: 0, waitTicks: 0, reason: "",
      momentumPP: 0, gapRatio: 0, preferredState: "none", stateEdgePP: 0,
    },
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
    deepestLossRun: 0,
    currentLossRun: 0,
    stopRequested: false,
    watch: freshWatch(),
  };
}

let session: SessionState = freshSession();

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

function lockInfo(cfg: ApexConfig | null): ApexLockInfo | undefined {
  if (!cfg) return undefined;
  const a = cfg.lockedAnalysis;
  return {
    symbol: cfg.symbol,
    displayName: cfg.displayName,
    contract: apexLabel(cfg.contract),
    certainty: cfg.certainty,
    confidence: a?.confidence ?? 0,
    payout: a?.payout ?? apexPayout(cfg.contract),
    breakEven: a?.breakEven ?? 0,
    replayWinRate: a?.replay.winRate ?? 0,
    replayShots: a?.replay.nShots ?? 0,
    replayFireRate: a?.replay.fireRate ?? 0,
    ladderSafety: a?.ladder.safety ?? 0,
    ladderLimit: a?.ladder.limit ?? 0,
    ladderHorizon: a?.ladder.horizon ?? 0,
    expectedShotsToBreak: a?.ladder.expectedShotsToBreak ?? 0,
    xi: a?.replay.chain.xi ?? 1,
    xiUpper: a?.replay.chain.xiUpper ?? 1,
    signals: a?.signals ?? [],
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): ApexStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const publicConfig = cfg
    ? {
        symbol: cfg.symbol,
        displayName: cfg.displayName,
        contract: cfg.contract,
        certainty: cfg.certainty,
        stake: cfg.stake,
        stopLoss: cfg.stopLoss,
        takeProfit: cfg.takeProfit,
        maxRecoverySteps: cfg.maxRecoverySteps,
        maxShots: cfg.maxShots,
      }
    : undefined;
  return {
    running: session.running,
    botId: APEX_BOT_ID,
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
    apexLock: lockInfo(cfg),
    watch: session.running ? session.watch : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info("Apex session stopped");
}

// ── Pre-deploy scan ───────────────────────────────────────────────────────────

/**
 * Score every digit-enabled market for the user's ONE contract and return the
 * Benjamini–Hochberg-screened ranking.
 *
 * When the user chose Matches WITHOUT naming a digit, all ten digits are scored
 * in every market and the selection surcharge log(10 × markets) is added to the
 * SPRT threshold, so the winner cannot be a lucky argmax.
 *
 * The winner is the ONLY market this session will ever trade.
 */
export async function scanForMarket(
  ownerSessionId: string | undefined,
  contract: ApexContract,
  certainty: ApexCertainty,
  risk: { stake: number; markupPercent: number; maxStake: number; stopLoss: number },
): Promise<ApexScanResult> {
  const spec = certaintySpec(certainty);
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const contracts: ApexContract[] = contract.kind === "match" && contract.digit === undefined
    ? Array.from({ length: 10 }, (_, d) => ({ kind: "match" as const, digit: d }))
    : [contract];
  const penaltyNats = Math.log(Math.max(1, markets.length * contracts.length));

  const all: ApexCandidate[] = [];
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", {
      botId: APEX_BOT_ID,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned: i,
      total: markets.length,
      results: screenApexCandidates(all).slice(0, 8),
    }, ownerSessionId);

    const digits = tickManager.getDigits(market.symbol, APEX_WINDOW);
    for (const c of contracts) {
      const cand = evaluateApexCandidate(market.symbol, market.displayName, digits, c, {
        certainty: spec.id,
        penaltyNats,
        baseStake: risk.stake,
        markupPercent: risk.markupPercent,
        maxStake: risk.maxStake,
        stopLoss: risk.stopLoss,
      });
      if (cand) all.push(cand);
    }
    await sleep(20);
  }

  const ranked = screenApexCandidates(all);
  broadcastSSE("bot_scan_progress", {
    botId: APEX_BOT_ID,
    scanning: null, symbol: null,
    scanned: markets.length, total: markets.length,
    results: ranked.slice(0, 8),
  }, ownerSessionId);

  if (ranked.length === 0) {
    return {
      suitable: false, best: null, allScored: [], certainty: spec.id,
      marketsScanned: markets.length,
      reason: `No market has enough digit history yet — this bot needs 240+ digits per market before it will look at anything. Give the feed a moment and re-scan.`,
    };
  }

  const best = ranked[0]!;
  const suitable = best.deployable;
  const reason = suitable
    ? `${best.displayName} · ${best.label} — locked at ${best.confidence}% confidence (${spec.label}). ` +
      `Replaying this bot's own entry rule over ${best.replay.examined} ticks fired ${best.replay.nShots} shots at ` +
      `${(best.replay.winRate * 100).toFixed(1)}% (break-even ${(best.breakEven * 100).toFixed(1)}%), ladder safety ` +
      `${(best.ladder.safety * 100).toFixed(1)}% over ${best.ladder.horizon} shots with a limit of ${best.ladder.limit} consecutive losses, ` +
      `ξ ${best.replay.chain.xi.toFixed(2)}.`
    : explainRefusal(best, spec.label);

  return { suitable, best, allScored: ranked.slice(0, 20), reason, certainty: spec.id, marketsScanned: markets.length };
}

/**
 * Explain a refusal the user can act on.
 *
 * Every Deriv digit contract pays below its fair rate, so on an unbiased stream
 * no honest analysis can call it +EV; that gap is stated rather than hidden. And
 * because the certainty bar is a user choice, the message says which knob to turn.
 */
function explainRefusal(best: ApexCandidate, certaintyLabel: string): string {
  const head = best.headroomPP;
  const structural =
    `${best.label} pays ${best.payout.toFixed(2)}×, so break-even is ${(best.breakEven * 100).toFixed(1)}% ` +
    `while an unbiased stream wins only ${(best.fairRate * 100).toFixed(1)}% (${head >= 0 ? "+" : ""}${head.toFixed(1)}pp headroom). ` +
    `The market has to run ${Math.abs(head).toFixed(1)}pp ${head < 0 ? "hot" : "cold"} before this contract can be +EV at all.`;
  const knob = best.blockers.some(b => b.includes("fired only"))
    ? ` This contract's entry rule is not finding enough qualifying contexts at ${certaintyLabel} — a lower certainty level or a different contract will find them sooner.`
    : "";
  return `No market clears the ${certaintyLabel} bar for ${best.label}. ` +
    `Best was ${best.displayName} at ${best.confidence}% confidence — blocked by: ${best.blockers[0] ?? "insufficient evidence"}. ` +
    structural + knob;
}

// ── Session start ─────────────────────────────────────────────────────────────

export async function startSession(config: ApexConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "An Apex session is already active — stop it first" };

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
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  if (!market || !market.digitEnabled) return fail("This bot needs a digit-enabled market");
  if (config.contract.kind === "match" && config.contract.digit === undefined) {
    return fail("The Matches digit must be resolved by the scan before deployment");
  }

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_apex_${Date.now()}`,
    config,
    currentStake: config.stake,
    message: `Locked on ${config.displayName} · ${apexLabel(config.contract)} · ${certaintySpec(config.certainty).label} certainty. ` +
      `No trade on deploy — the bot waits for the market, the context and the tick to all agree.`,
  };

  logger.info({
    symbol: config.symbol,
    contract: apexLabel(config.contract),
    certainty: config.certainty,
    confidence: config.lockedAnalysis?.confidence,
  }, "Apex session starting");
  broadcast();

  runLoop(config).catch(err => {
    logger.error({ err }, "Apex runLoop error");
    session.running = false;
    session.message = `⚠️ ${friendlyErrorMessage(err)}`;
    broadcast();
  }).finally(() => releaseTradingOwnership("bots"));

  return { ok: true };
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: ApexConfig) {
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

  // ── WHAT IS FROZEN ─────────────────────────────────────────────────────────
  // Both are captured once, here, and never reassigned. Every read below goes
  // through these constants, so there is no code path — not a stall, not a loss
  // streak, not an error retry, not a drift alarm — that can move this session to
  // a different market or a different contract. That is the whole product rule.
  const LOCKED_SYMBOL: string = config.symbol;
  const LOCKED_NAME: string = config.displayName;
  const LOCKED_CONTRACT: ApexContract = { ...config.contract };
  const LOCKED_TYPE = APEX_CONTRACT_TYPE[LOCKED_CONTRACT.kind];
  const LOCKED_WINSET = apexWinSet(LOCKED_CONTRACT);
  const SPEC = certaintySpec(config.certainty);

  let timingWaitTicks = 0;
  let ticksSinceLastShot = Number.POSITIVE_INFINITY;
  let lastDigitCount = 0;
  let lastReadAt = 0;
  let cachedRead: ApexCandidate | null = config.lockedAnalysis ?? null;
  let driftEvals = 0;
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

      const inRecovery = recoveryEngine.isInRecovery();

      // ── Tick accounting ────────────────────────────────────────────────────
      const digits = tickManager.getDigits(LOCKED_SYMBOL, APEX_WINDOW);
      if (digits.length !== lastDigitCount) {
        const delta = Math.max(0, digits.length - lastDigitCount);
        session.watch.ticksWatched += delta;
        ticksSinceLastShot += delta;
        lastDigitCount = digits.length;
      }

      // ── GATE 1: the locked market must still be deployable ─────────────────
      // Re-read on an interval rather than every tick: the read includes a
      // walk-forward replay and an anytime-valid sequence, and re-running them
      // every 200 ms would buy nothing but heat.
      if (Date.now() - lastReadAt >= REREAD_INTERVAL_MS) {
        lastReadAt = Date.now();
        const read = evaluateApexCandidate(LOCKED_SYMBOL, LOCKED_NAME, digits, LOCKED_CONTRACT, {
          certainty: SPEC.id,
          penaltyNats: 0, // the market was already chosen by a screened, surcharged pass
          baseStake: config.stake,
          markupPercent: botRecoveryMarkup,
          maxStake,
          stopLoss: config.stopLoss,
        });
        if (read) {
          cachedRead = read;
          session.watch.confidence = read.confidence;
          session.watch.blockers = read.blockers.slice(0, 3);
          session.watch.drift = {
            ph: read.drift.ph,
            threshold: read.drift.threshold,
            fired: read.drift.fired,
            consecutive: read.drift.fired ? driftEvals + 1 : 0,
          };
          driftEvals = read.drift.fired ? driftEvals + 1 : 0;
        }
      }

      if (!cachedRead) {
        session.watch.phase = "watching";
        session.message = `Building history on ${LOCKED_NAME} — ${digits.length}/240 digits before analysis can begin.`;
        broadcast();
        await sleep(1500);
        continue;
      }

      // ── THE DRIFT GUARD ────────────────────────────────────────────────────
      // The market cannot be rotated, so a decayed edge is handled by refusing to
      // fire — and, if the decay persists, by ending the session and asking for a
      // fresh analysis. It NEVER moves to another market.
      if (cachedRead.drift.fired) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        if (driftEvals >= DRIFT_HALT_EVALS) {
          session.running = false;
          session.message = `🛑 ${LOCKED_NAME} has measurably decayed (Page–Hinkley ${cachedRead.drift.ph.toFixed(1)} > ${cachedRead.drift.threshold} for ${driftEvals} reads). ` +
            `The market is locked, so this bot will not rotate — re-run the analysis to pick a new one.`;
          broadcast();
          return;
        }
        session.message = `⏸ Holding fire — ${LOCKED_NAME}'s win rate is drifting below its locked baseline ` +
          `(Page–Hinkley ${cachedRead.drift.ph.toFixed(1)}/${cachedRead.drift.threshold}). No market rotation; standing by.`;
        broadcast();
        await sleep(2000);
        continue;
      }

      if (!cachedRead.deployable) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        session.watch.entry = {
          ready: false, score: 0, waitTicks: 0, reason: "",
          momentumPP: 0, gapRatio: 0, preferredState: "none", stateEdgePP: 0,
        };
        const top = cachedRead.blockers[0] ?? "gathering evidence";
        session.message = inRecovery
          ? `🎯 Recovery armed — holding until the market gate clears. ${top}`
          : `👁 Watching ${LOCKED_NAME} · ${cachedRead.confidence}% confidence · ${top}`;
        broadcast();
        // Patience is free. Poll slowly — this is a sniper, not a scalper.
        await sleep(1600);
        continue;
      }

      // ── GATE 2: the conditional context must clear break-even ──────────────
      const entry = evaluateApexEntry(digits, LOCKED_WINSET, cachedRead.breakEven, SPEC);
      session.watch.condP = entry.condP;
      session.watch.condLower = entry.condLower;
      session.watch.bar = entry.bar;
      session.watch.marginPP = entry.marginPP;
      session.watch.contextOrder = entry.order;
      session.watch.contextCount = entry.contextCount;

      if (!entry.ready) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        session.watch.entry = {
          ready: false, score: 0, waitTicks: 0, reason: entry.reason,
          momentumPP: 0, gapRatio: 0, preferredState: "none", stateEdgePP: 0,
        };
        session.watch.setupsRejected++;
        session.message = inRecovery
          ? `🎯 Recovery armed — waiting for a qualifying context. ${entry.reason}`
          : `👁 Armed market, waiting for the context — ${entry.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }

      // ── GATE 3: is THIS the tick? ──────────────────────────────────────────
      session.watch.phase = "armed";
      const timing = evaluateApexTiming({
        digits,
        winSet: LOCKED_WINSET,
        secondsSinceLastTick: tickManager.getTickAgeSeconds(LOCKED_SYMBOL),
        medianTickGapSeconds: LOCKED_SYMBOL.startsWith("1HZ") ? 1 : 2,
        ticksSinceLastShot,
        waitedTicks: timingWaitTicks,
      });
      session.watch.entry = {
        ready: timing.ready,
        score: timing.score,
        waitTicks: timing.waitTicks,
        reason: timing.reason,
        momentumPP: timing.components.momentumPP,
        gapRatio: timing.components.gapRatio,
        preferredState: timing.components.preferredState,
        stateEdgePP: timing.components.stateEdgePP,
      };

      if (!timing.ready) {
        timingWaitTicks++;
        session.watch.setupsRejected++;
        session.message = inRecovery
          ? `🎯 Recovery armed (${cachedRead.confidence}%) — ${timing.reason}`
          : `⏳ Armed on ${LOCKED_NAME} · context ${(entry.condP * 100).toFixed(1)}% — ${timing.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }
      timingWaitTicks = 0;
      broadcast();

      // Lock integrity — re-asserted immediately before every buy.
      if (LOCKED_CONTRACT.kind !== config.contract.kind
          || LOCKED_CONTRACT.digit !== config.contract.digit
          || LOCKED_SYMBOL !== config.symbol
          || !isAutomatedMarket(LOCKED_SYMBOL)) {
        session.running = false;
        session.message = "⚠️ Lock integrity check failed — session halted before firing";
        logger.error({ LOCKED_SYMBOL, LOCKED_CONTRACT, config }, "Apex lock violation");
        broadcast();
        return;
      }

      const barrier = LOCKED_CONTRACT.kind === "even" || LOCKED_CONTRACT.kind === "odd"
        ? undefined
        : LOCKED_CONTRACT.digit;

      const payoutQuote = await resolveRecoveryPayout({
        symbol: LOCKED_SYMBOL,
        contractType: LOCKED_TYPE,
        barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      const payout = payoutQuote.payoutMultiplier || apexPayout(LOCKED_CONTRACT);

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

      // Shared recovery stake formula — identical to every other bot.
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, payout, botRecoveryMarkup)
        : config.stake;

      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing";
      session.currentStake = stake;
      session.currentMarket = LOCKED_NAME;
      session.currentContractType = apexLabel(LOCKED_CONTRACT);
      session.message = inRecovery
        ? `🎯 ONE SHOT [Recovery R${sharedStep}] ${apexLabel(LOCKED_CONTRACT)} on ${LOCKED_NAME} · $${stake.toFixed(2)} · context ${(entry.condP * 100).toFixed(1)}%`
        : `🎯 ONE SHOT ${apexLabel(LOCKED_CONTRACT)} on ${LOCKED_NAME} · $${stake.toFixed(2)} · context ${(entry.condP * 100).toFixed(1)}% (floor ${(entry.condLower * 100).toFixed(1)}% vs ${(entry.bar * 100).toFixed(1)}% bar)`;
      broadcast();

      const reason = `[${BOT_NAME}${inRecovery ? " RECOVERY" : ""}] ${apexLabel(LOCKED_CONTRACT)} on ${LOCKED_NAME} · ` +
        `${SPEC.label} certainty · market conf ${cachedRead.confidence}% (${cachedRead.tier}) · ` +
        `context P(win|last ${entry.order}) ${(entry.condP * 100).toFixed(1)}% floor ${(entry.condLower * 100).toFixed(1)}% vs bar ${(entry.bar * 100).toFixed(1)}% · ` +
        `replayed accuracy ${(cachedRead.replay.winRate * 100).toFixed(1)}% over ${cachedRead.replay.nShots} shots · ` +
        `ladder safety ${(cachedRead.ladder.safety * 100).toFixed(1)}% (limit ${cachedRead.ladder.limit}) · ξ ${cachedRead.replay.chain.xi.toFixed(2)} · ` +
        `entry ${timing.score}/100 (${timing.components.preferredState === "none" ? "state neutral" : timing.components.preferredState}, renewal ${timing.components.gapRatio.toFixed(2)}×) · ` +
        `watched ${session.watch.ticksWatched} ticks`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: LOCKED_SYMBOL,
        displayName: LOCKED_NAME,
        contractType: LOCKED_TYPE,
        barrier: barrier ?? null,
        stake: String(Math.round(stake * 100) / 100),
        direction: "hold",
        status: "open",
        aiConfidence: String(cachedRead.confidence),
        aiRiskScore: "15",
        isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`,
        duration: 1,
        durationUnit: "t",
      }).returning();

      // ── Execute ────────────────────────────────────────────────────────────
      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(LOCKED_SYMBOL) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: LOCKED_SYMBOL,
            contractType: LOCKED_TYPE,
            stake: Math.round(stake * 100) / 100,
            duration: 1,
            durationUnit: "t",
            currency,
            accountId: accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            ...(barrier !== undefined ? { barrier } : {}),
          } as any);
          const result = await waitForContractResult(
            token!, accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            liveResult.contractId, 30_000,
          );
          won = result.won;
          profit = result.profit;
          entryPrice = Number(result.entrySpot) || liveResult.buyPrice;
          exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          logger.warn({ err }, "Apex live execution error — returning to the watch");
          try {
            await db.update(tradesTable).set({
              status: "error", profit: "0", payout: "0", closedAt: new Date(),
              agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
            }).where(eq(tradesTable.id, journaled!.id));
          } catch { /* best-effort */ }
          session.watch.phase = "watching";
          session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}. Back to watching.`;
          broadcast();
          await sleep(2000);
          continue;
        }
      } else {
        // Paper mode settles against the market's REAL next digit — this bot's
        // whole thesis is the digit stream, so a coin flip would be meaningless.
        session.watch.phase = "settling";
        const before = tickManager.getDigits(LOCKED_SYMBOL, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const d = tickManager.getDigits(LOCKED_SYMBOL, 1)[0];
          if (d !== undefined && d !== before) { digit = d; break; }
          digit = d;
        }
        const d = digit ?? 0;
        won = LOCKED_WINSET.has(d);
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

      // The ONE shared ledger — same call, same semantics, as every other bot.
      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, LOCKED_TYPE, payout);

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
        logger.warn({ dbErr }, "Apex: failed to settle the journaled trade");
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

      // The next shot must earn its own evidence: reset the timing state and the
      // shot clock, keep the lock. Only the evidence is discarded, never the market.
      session.watch = {
        ...freshWatch(),
        ticksWatched: session.watch.ticksWatched,
        setupsRejected: session.watch.setupsRejected,
        confidence: cachedRead.confidence,
      };
      ticksSinceLastShot = 0;
      timingWaitTicks = 0;
      lastReadAt = 0; // force a fresh market read before the next shot
      session.message = won
        ? `✅ Shot landed — +$${profit.toFixed(2)}. Deepest loss run this session: ${session.deepestLossRun}. Back to watching.`
        : `❌ Shot missed — −$${Math.abs(profit).toFixed(2)} (loss run ${session.currentLossRun}/${cachedRead.ladder.limit}). Recovery armed; the next shot waits for all three gates.`;
      broadcast();

      // ── Boundaries ─────────────────────────────────────────────────────────
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
      if (config.maxShots > 0 && session.tradeCount >= config.maxShots) {
        session.running = false;
        session.message = `🏁 Shot limit reached (${config.maxShots}). P&L ${session.totalProfit >= 0 ? "+" : "−"}$${Math.abs(session.totalProfit).toFixed(2)}.`;
        broadcast();
        return;
      }

      // Cool-down. Deliberately long: fresh, independent evidence is the product,
      // and re-firing on the same accumulated window double-counts it.
      await sleep(won ? 2500 : 3500);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Apex stability catch");
      session.message = `Stabilizing engine — retry ${consecutiveErrors}/5`;
      broadcast();
      await sleep(Math.min(3000, 600 * consecutiveErrors));
      if (consecutiveErrors >= 5) {
        session.running = false;
        session.message = "Engine paused for a stability check — please restart";
        broadcast();
        return;
      }
    }
  }

  if (!session.running
      && !session.message?.startsWith("✅")
      && !session.message?.startsWith("🛑")
      && !session.message?.startsWith("🏁")
      && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}
