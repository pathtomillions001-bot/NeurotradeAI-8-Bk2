/**
 * KILL-SHOT PRECISION SNIPER — execution engine (7th specialist bot).
 *
 * OPERATING MODEL
 * ───────────────
 * HUNT, THEN WAIT, THEN FIRE. Two separations, and they are the whole design:
 *
 *   WHAT to trade  — chosen continuously by the evidence stack, across every
 *                    digit-enabled market, exactly like the generalist bots.
 *   WHEN to trade  — chosen by the execution-timing layer, which holds an armed
 *                    setup until the entry tick is actually a good one.
 *
 * An earlier revision collapsed both into a single pre-session decision: the
 * user locked one market before pressing run and the bot then waited on it. That
 * was the wrong split. A market that goes quiet produces no setup ever, and the
 * user could not distinguish "waiting for a setup" from "waiting on a dead
 * market" — so in practice the bot looked broken. It now hunts like the Barrier
 * Architect and still refuses to fire on a bad tick.
 *
 * The design consequences:
 *
 *  · MARKET ROTATION IS ON BY DEFAULT (`targetMode: "hunt"`). Every few seconds
 *    the loop re-scores every digit market for the user's contract through the
 *    same screened, surcharged scan the deploy screen uses, and moves to a
 *    challenger only when it beats the held market by SWITCH_MARGIN confidence
 *    points or the held market has been non-deployable for STALE_SCAN_LIMIT
 *    passes. Hysteresis on both sides, so it cannot thrash. `targetMode: "lock"`
 *    restores the original single-market behaviour.
 *
 *  · NO ROTATION WHILE A RECOVERY LADDER IS OPEN. The debt was incurred on the
 *    current market, and moving market mid-recovery would change the payout the
 *    shared stake formula was sized against.
 *
 *  · NO CONTRACT DRIFT, EVER. The user names exactly one contract — Over N,
 *    Under N, Matches D, Even, or Odd. Never both sides of a pair. The only
 *    degree of freedom the AI has is the Matches digit, and only when the user
 *    explicitly delegates it. A sovereignty check runs immediately before every
 *    buy. Hunt mode selects MARKETS; it can never select a contract.
 *
 *  · ARMED IS NOT FIRED. Once the evidence stack clears, `killshot-timing.ts`
 *    decides whether THIS tick is the entry: short-window momentum must still
 *    match the measured regime, the contract's own renewal clock must be near
 *    due rather than just reset or long droughted, the feed must be fresh, and
 *    enough new ticks must have arrived since the last shot for this to be an
 *    independent bet. A patience valve fires the shot anyway once the objection
 *    has stood for TIMING.maxWaitTicks, so a conclusive setup never rots.
 *
 *  · WAITING IS STILL THE DEFAULT STATE. The loop's normal condition is
 *    "watching, not trading". Firing is the exception, and the console shows
 *    both the evidence bar and the timing reason so the waiting is legible.
 *
 *  · THE SAME SHARED RECOVERY SYSTEM. Identical to the other bots: the ONE
 *    account-global ledger (`lib/agents/recovery-engine.ts`), the ONE recovery
 *    stake formula (`getBotRecoveryStake` — debt × (1 + markup) / (payout − 1))
 *    and the same max-step ceiling. No private debt state.
 *
 *  · RECOVERY IS ALSO SNIPED. This is the one place the bot departs from the
 *    others in a way that matters: a recovery trade is not fired on the next
 *    tick. It waits for the same full evidence stack to re-clear. A recovery
 *    trade taken in a hurry is exactly how a two-loss streak becomes a five-loss
 *    streak, and this bot's entire premise is that that must not happen.
 *
 *  · SINGLE-EXECUTOR ARBITER. Shares `lib/engine-arbiter.ts` (owner `bots`) with
 *    every other engine — one ledger, one executor.
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
  evaluateKillShotCandidate,
  screenKillShotCandidates,
  killShotLabel,
  killShotWinSet,
  killShotPayout,
  KILLSHOT_CONTRACT_TYPE,
  KILLSHOT_GATES,
  KILLSHOT_WINDOW,
  type KillShotCandidate,
  type KillShotContract,
} from "./killshot-analysis";
import { evaluateKillShotTiming, TIMING } from "./killshot-timing";

export const KILLSHOT_BOT_ID = "killshot";
const BOT_NAME = "Kill-Shot Precision Sniper";

// ── Config / status ───────────────────────────────────────────────────────────

export interface KillShotConfig {
  ownerSessionId?: string;
  /**
   * Starting market. In `lock` mode it is FROZEN for the whole session; in
   * `hunt` mode it is only the first target and the loop re-selects the best
   * market for the user's contract continuously.
   */
  symbol: string;
  displayName: string;
  /**
   * `hunt` (default) — rotate across every digit-enabled market looking for the
   * best one for the user's contract, exactly as the generalist bots do, and
   * still wait for the entry tick before firing. `lock` — the original
   * behaviour: one market, frozen, for the life of the session.
   *
   * The user's CONTRACT is sovereign in both modes and never rotates.
   */
  targetMode?: "hunt" | "lock";
  /** FROZEN contract — exactly one side, never both. */
  contract: KillShotContract;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  /** Stop after this many kill shots (0 = until TP/SL). */
  maxTrades: number;
  /** Pre-deploy analysis, kept for the UI and journaling. */
  lockedAnalysis?: KillShotCandidate;
}

export interface KillShotStatus {
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
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: Omit<KillShotConfig, "ownerSessionId">;
  /** The current target (market + the user's single contract) and its read. */
  killLock?: {
    symbol: string;
    displayName: string;
    contract: string;
    confidence: number;
    pWin: number;
    pLower: number;
    breakEven: number;
    payout: number;
    expectedValue: number;
    pTwoInARow: number;
    clusterRatio: number;
    signals: string[];
  };
  /** Live evidence state — what the bot is waiting for right now. */
  hunt?: {
    /** "waiting" = accumulating evidence; "armed" = all gates clear. */
    phase: "waiting" | "armed" | "firing" | "settling";
    /** SPRT progress toward the fire threshold, 0–1. */
    evidence: number;
    logLR: number;
    threshold: number;
    oddsForEdge: number;
    /** Ticks the SPRT expects still to need. */
    expectedTicks: number;
    /** Live confidence, 0–100. */
    confidence: number;
    pWin: number;
    pLower: number;
    /** Gates currently blocking a shot. */
    blockers: string[];
    /** Ticks observed since the last shot (or since arming). */
    ticksWatched: number;
    /** Number of shots the bot has declined to take. */
    setupsRejected: number;
    /** "hunt" rotates markets, "lock" keeps the one the user froze. */
    targetMode: "hunt" | "lock";
    /** The market currently being watched. */
    targetSymbol: string;
    targetDisplayName: string;
    /** How many markets the last hunt pass scored. */
    marketsScanned: number;
    /** Best confidence seen anywhere in the last hunt pass. */
    bestConfidence: number;
    /** Evidence tier of the current target. */
    tier: "prime" | "standard" | "marginal";
    /** Entry-timing layer — what the bot is waiting on once the evidence is in. */
    timing: {
      ready: boolean;
      score: number;
      waitTicks: number;
      reason: string;
      momentumPP: number;
      gapRatio: number;
    };
  };
}

export interface KillShotScanResult {
  suitable: boolean;
  best: KillShotCandidate | null;
  allScored: KillShotCandidate[];
  reason: string;
}

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: KillShotConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  stopRequested: boolean;
  hunt: NonNullable<KillShotStatus["hunt"]>;
}

function freshHunt(): NonNullable<KillShotStatus["hunt"]> {
  return {
    phase: "waiting",
    evidence: 0,
    logLR: 0,
    threshold: 0,
    oddsForEdge: 1,
    expectedTicks: 0,
    confidence: 0,
    pWin: 0,
    pLower: 0,
    blockers: [],
    ticksWatched: 0,
    setupsRejected: 0,
    targetMode: "hunt",
    targetSymbol: "",
    targetDisplayName: "",
    marketsScanned: 0,
    bestConfidence: 0,
    tier: "marginal",
    timing: { ready: false, score: 0, waitTicks: 0, reason: "", momentumPP: 0, gapRatio: 0 },
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
    stopRequested: false,
    hunt: freshHunt(),
  };
}

let session: SessionState = freshSession();

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

export function getStatus(): KillShotStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const publicConfig = cfg
    ? (Object.fromEntries(
        Object.entries(cfg).filter(([k]) => k !== "ownerSessionId"),
      ) as Omit<KillShotConfig, "ownerSessionId">)
    : undefined;
  const a = cfg?.lockedAnalysis;
  return {
    running: session.running,
    botId: KILLSHOT_BOT_ID,
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
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    config: publicConfig,
    killLock: cfg
      ? {
          symbol: session.hunt.targetSymbol || cfg.symbol,
          displayName: session.hunt.targetDisplayName || cfg.displayName,
          contract: killShotLabel(cfg.contract),
          confidence: a?.confidence ?? 0,
          pWin: a?.pWin ?? 0,
          pLower: a?.pLower ?? 0,
          breakEven: a?.breakEven ?? 0,
          payout: a?.payout ?? 0,
          expectedValue: a?.expectedValue ?? 0,
          pTwoInARow: a?.loss?.pTwoInARow ?? 0,
          clusterRatio: a?.loss?.clusterRatio ?? 1,
          signals: a?.signals ?? [],
        }
      : undefined,
    hunt: session.running ? { ...session.hunt, targetSymbol: session.hunt.targetSymbol || cfg?.symbol || "" } : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info("Kill-Shot session stopped");
}

// ── Pre-deploy scan ───────────────────────────────────────────────────────────

/**
 * Find the single best market for the user's chosen contract.
 *
 * Every digit-enabled market is scored through the full seven-layer stack. When
 * the user chose Matches WITHOUT naming a digit, all ten digits are scored in
 * every market too, and the selection surcharge log(10 × markets) is applied to
 * the SPRT threshold so the winner cannot be a lucky argmax.
 *
 * The market this returns is the ONLY market the session will ever trade.
 */
/**
 * Score every digit-enabled market for ONE contract through the full stack and
 * return the Benjamini–Hochberg-screened ranking.
 *
 * Shared by the pre-deploy scan and by the running hunt loop, so the market the
 * bot trades in hunt mode is selected by exactly the same statistics the user
 * saw on the scan screen. `onProgress` lets the caller stream scan progress.
 */
async function scoreAllMarkets(
  contract: KillShotContract,
  ownerSessionId?: string,
  onProgress?: (market: { displayName: string; symbol: string }, scanned: number, total: number, results: KillShotCandidate[]) => void,
): Promise<{ ranked: KillShotCandidate[]; scanned: number; penaltyNats: number }> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);

  // Candidate contracts: the user's exact choice, or all ten digits when they
  // delegated the Matches digit to the AI.
  const contracts: KillShotContract[] =
    contract.kind === "match" && contract.digit === undefined
      ? Array.from({ length: 10 }, (_, d) => ({ kind: "match" as const, digit: d }))
      : [contract];

  // Selection surcharge — extra nats of evidence required, log(#candidates).
  const totalCandidates = markets.length * contracts.length;
  const penaltyNats = Math.log(Math.max(1, totalCandidates));

  const all: KillShotCandidate[] = [];
  let scanned = 0;

  for (const market of markets) {
    onProgress?.(market, scanned, markets.length, screenKillShotCandidates(all).slice(0, 8));
    const digits = tickManager.getDigits(market.symbol, KILLSHOT_WINDOW);
    for (const c of contracts) {
      const cand = evaluateKillShotCandidate(market.symbol, market.displayName, digits, c, penaltyNats);
      if (cand) all.push(cand);
    }
    scanned++;
    await sleep(50);
  }

  const ranked = screenKillShotCandidates(all);
  onProgress?.({ displayName: "", symbol: "" }, markets.length, markets.length, ranked.slice(0, 8));
  return { ranked, scanned: markets.length, penaltyNats };
}

/**
 * Explain a refusal in terms the user can act on.
 *
 * The old message said "re-scan in a few minutes", which was wrong advice: for
 * most contracts the block is STRUCTURAL, not transient. Every Deriv digit
 * contract pays below its fair rate, so an unbiased stream is always slightly
 * −EV and the market has to be measurably hot before any analysis can call it
 * +EV. Saying so is the difference between "wait" and "pick another contract".
 */
function explainRefusal(best: KillShotCandidate, contract: KillShotContract): string {
  const head = best.headroomPP;
  const structural =
    `${killShotLabel(contract)} pays ${best.payout.toFixed(2)}×, so break-even is ` +
    `${(best.breakEven * 100).toFixed(1)}% while an unbiased stream wins only ${(best.fairRate * 100).toFixed(1)}% ` +
    `(${head >= 0 ? "+" : ""}${head.toFixed(1)}pp of headroom). The market has to run ` +
    `${Math.abs(head).toFixed(1)}pp ${head < 0 ? "hot" : "cold"} before this contract can be +EV at all.`;
  return `No market currently clears the kill-shot bar for ${killShotLabel(contract)}. ` +
    `Best was ${best.displayName} at ${best.confidence}% confidence — blocked by: ${best.blockers[0] ?? "insufficient evidence"}. ` +
    structural;
}

/**
 * Find the best market for the user's chosen contract, right now.
 *
 * Every digit-enabled market is scored through the full stack. When the user
 * chose Matches WITHOUT naming a digit, all ten digits are scored in every
 * market too, and the selection surcharge log(10 × markets) is applied to the
 * SPRT threshold so the winner cannot be a lucky argmax.
 *
 * In `lock` mode the winner is the only market the session will ever trade. In
 * `hunt` mode this same ranking is re-run continuously by the loop.
 */
export async function scanForTarget(
  ownerSessionId: string | undefined,
  contract: KillShotContract,
): Promise<KillShotScanResult> {
  const { ranked } = await scoreAllMarkets(contract, ownerSessionId, (market, scanned, total, results) => {
    broadcastSSE("bot_scan_progress", {
      botId: KILLSHOT_BOT_ID,
      scanning: market.displayName || null,
      symbol: market.symbol || null,
      scanned,
      total,
      results,
    }, ownerSessionId);
  });

  if (ranked.length === 0) {
    return {
      suitable: false,
      best: null,
      allScored: [],
      reason: `No market has enough history yet — this bot needs ${KILLSHOT_GATES.minSamples}+ digits per market before it will look at anything. Wait a moment and re-scan.`,
    };
  }

  const best = ranked[0]!;
  const suitable = best.deployable;
  const reason = suitable
    ? `${best.displayName}: ${best.label} — ${best.confidence}% confidence (${best.tier.toUpperCase()}), ` +
      `${(best.pWin * 100).toFixed(1)}% win rate (anytime-valid floor ${(best.pLower * 100).toFixed(1)}%), ` +
      `SPRT odds ${best.sprt.oddsForEdge.toFixed(0)}:1, EV ${best.expectedValue >= 0 ? "+" : ""}${(best.expectedValue * 100).toFixed(1)}% per $1`
    : explainRefusal(best, contract);

  return { suitable, best, allScored: ranked.slice(0, 20), reason };
}

// ── Session start ─────────────────────────────────────────────────────────────

export async function startSession(config: KillShotConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A Kill-Shot session is already active — stop it first" };

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
  if (config.contract.kind === "match" && config.contract.digit === undefined) {
    return fail("The Matches digit must be resolved by the scan before deployment");
  }

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_killshot_${Date.now()}`,
    config,
    currentStake: config.stake,
    message: (config.targetMode ?? "hunt") === "hunt"
      ? `Hunting every digit market for ${killShotLabel(config.contract)}, starting on ${config.displayName}. No trade on deploy — the bot waits for conclusive evidence AND a good entry tick.`
      : `Locked on ${config.displayName} · ${killShotLabel(config.contract)}. Hunting for a kill shot — no trade until the evidence is conclusive and the entry tick is right.`,
  };

  logger.info({
    symbol: config.symbol,
    contract: killShotLabel(config.contract),
    confidence: config.lockedAnalysis?.confidence,
  }, "Kill-Shot session starting");
  broadcast();

  runLoop(config).catch(err => {
    logger.error({ err }, "Kill-Shot runLoop error");
    session.running = false;
    session.message = `⚠️ ${friendlyErrorMessage(err)}`;
    broadcast();
  }).finally(() => releaseTradingOwnership("bots"));

  return { ok: true };
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: KillShotConfig) {
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

  // ── WHAT IS FROZEN AND WHAT IS NOT ──────────────────────────────────────
  //
  // THE CONTRACT IS FROZEN. Captured once, here, never reassigned. Every read
  // below goes through these constants, so there is no code path — not a stall,
  // not a loss streak, not an error retry — that can move this session to a
  // contract the user did not choose.
  const LOCKED_CONTRACT: KillShotContract = { ...config.contract };
  const LOCKED_TYPE = KILLSHOT_CONTRACT_TYPE[LOCKED_CONTRACT.kind];
  const LOCKED_WINSET = killShotWinSet(LOCKED_CONTRACT);

  // THE MARKET IS NOT FROZEN IN HUNT MODE. This is the change the bot needed:
  // locking one market before the session meant that if that market went quiet
  // the bot sat on it forever, and the user could not tell "waiting for a setup"
  // from "waiting on a market that will never produce one". Hunt mode re-runs
  // the same scan the user saw on the deploy screen, continuously, and moves to
  // whichever market currently carries the strongest evidence for the user's
  // contract — exactly how the generalist bots rotate.
  const HUNT = (config.targetMode ?? "hunt") === "hunt";
  /** A challenger must beat the held market by this many confidence points. */
  const SWITCH_MARGIN = 8;
  /** Held market is dropped after this many consecutive non-deployable scans. */
  const STALE_SCAN_LIMIT = 3;
  /** Minimum time between hunt passes — a full sweep of every market is costly. */
  const HUNT_SCAN_INTERVAL_MS = 6000;

  let targetSymbol = config.symbol;
  let targetName = config.displayName;
  let targetRead: KillShotCandidate | null = config.lockedAnalysis ?? null;
  let lastHuntAt = 0;
  let staleScans = 0;
  /** Ticks the current timing objection has been standing (patience valve). */
  let timingWaitTicks = 0;
  let ticksSinceLastShot = Number.POSITIVE_INFINITY;
  let lastDigitCount = 0;

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

      // ── THE HUNT ───────────────────────────────────────────────────────────
      // Re-select the best market for the user's contract. Skipped in `lock`
      // mode, and skipped while a recovery ladder is open: the debt was incurred
      // on the current market, and moving market mid-recovery would change the
      // payout the shared stake formula was sized against.
      if (HUNT && !inRecovery && Date.now() - lastHuntAt >= HUNT_SCAN_INTERVAL_MS) {
        lastHuntAt = Date.now();
        try {
          const { ranked } = await scoreAllMarkets(LOCKED_CONTRACT);
          const deployable = ranked.filter(c => c.deployable);
          const best = deployable[0] ?? null;
          const held = ranked.find(c => c.symbol === targetSymbol) ?? null;

          session.hunt.marketsScanned = ranked.length > 0 ? new Set(ranked.map(c => c.symbol)).size : 0;
          session.hunt.bestConfidence = ranked[0]?.confidence ?? 0;

          if (held?.deployable) staleScans = 0; else staleScans++;

          if (best && best.symbol !== targetSymbol) {
            const heldOk = held?.deployable === true && staleScans < STALE_SCAN_LIMIT;
            const betterBy = best.confidence - (held?.confidence ?? 0);
            if (!heldOk || betterBy >= SWITCH_MARGIN) {
              logger.info(
                { from: targetSymbol, to: best.symbol, confidence: best.confidence, tier: best.tier },
                "Kill-Shot hunt: rotating to a stronger market",
              );
              targetSymbol = best.symbol;
              targetName = best.displayName;
              timingWaitTicks = 0;
              lastDigitCount = 0;
              session.message = `🔎 Hunt moved to ${best.displayName} — ${best.label} at ${best.confidence}% confidence (${best.tier}).`;
              broadcast();
            }
          } else if (!deployable.length && staleScans >= STALE_SCAN_LIMIT && ranked.length > 0) {
            // Nothing is deployable anywhere; stay put on the strongest market so
            // the evidence keeps accumulating instead of thrashing between them.
            const strongest = ranked[0]!;
            if (strongest.symbol !== targetSymbol) {
              targetSymbol = strongest.symbol;
              targetName = strongest.displayName;
              lastDigitCount = 0;
            }
          }
        } catch (err) {
          logger.warn({ err }, "Kill-Shot hunt pass failed — holding the current market");
        }
      }

      session.hunt.targetMode = HUNT ? "hunt" : "lock";
      session.hunt.targetSymbol = targetSymbol;
      session.hunt.targetDisplayName = targetName;

      // ── THE READ ───────────────────────────────────────────────────────────
      // The current target, scored on the user's contract. No selection penalty
      // here: the market was already chosen by a screened, surcharged pass.
      const digits = tickManager.getDigits(targetSymbol, KILLSHOT_WINDOW);
      if (digits.length !== lastDigitCount) {
        session.hunt.ticksWatched += Math.max(0, digits.length - lastDigitCount);
        ticksSinceLastShot += Math.max(0, digits.length - lastDigitCount);
        lastDigitCount = digits.length;
      }

      const read = evaluateKillShotCandidate(
        targetSymbol,
        targetName,
        digits,
        LOCKED_CONTRACT,
        0,
      );

      if (!read) {
        session.hunt.phase = "waiting";
        session.message = `Building history on ${targetName} — ${digits.length}/${KILLSHOT_GATES.minSamples} digits before analysis can begin.`;
        broadcast();
        await sleep(1500);
        continue;
      }
      targetRead = read;

      // Publish the live evidence state so the user can watch the bot think.
      session.hunt.evidence = Math.max(0, read.sprt.progress);
      session.hunt.logLR = read.sprt.logLR;
      session.hunt.threshold = read.sprt.upper;
      session.hunt.oddsForEdge = read.sprt.oddsForEdge;
      session.hunt.expectedTicks = read.sprt.expectedRemaining;
      session.hunt.confidence = read.confidence;
      session.hunt.pWin = read.pWin;
      session.hunt.pLower = read.pLower;
      session.hunt.tier = read.tier;
      session.hunt.blockers = read.blockers.slice(0, 3);

      // THE EVIDENCE DECISION. Every gate must be clear. In recovery the bar is
      // the SAME — a recovery trade is sniped exactly as carefully as a normal
      // one, because a rushed recovery trade is how a 2-loss streak becomes a 5.
      if (!read.deployable) {
        session.hunt.phase = "waiting";
        timingWaitTicks = 0;
        session.hunt.timing = { ready: false, score: 0, waitTicks: 0, reason: "", momentumPP: 0, gapRatio: 0 };
        const top = read.blockers[0] ?? "gathering evidence";
        session.message = inRecovery
          ? `🎯 Recovery armed — holding fire until the setup is conclusive. ${top}`
          : `👁 Watching ${targetName} · ${read.confidence}% confidence · ${top}`;
        broadcast();
        // Patience is free. Poll slowly — this is a sniper, not a scalper.
        await sleep(1400);
        continue;
      }

      // ── ARMED. NOW WAIT FOR THE ENTRY TICK ─────────────────────────────────
      // This is the second half of the answer to "don't trade the moment I press
      // run". The evidence says the market carries an edge; it does not say the
      // NEXT tick is the one to be in. A digit contract settles on the next tick,
      // so the bot checks that the regime it measured is still live (momentum),
      // that the contract's own renewal clock is near due rather than just reset
      // or long droughted, that the feed is fresh, and that enough new ticks have
      // arrived since the last shot for this to be an independent bet.
      session.hunt.phase = "armed";
      const timing = evaluateKillShotTiming({
        digits,
        winSet: LOCKED_WINSET,
        secondsSinceLastTick: tickManager.getTickAgeSeconds(targetSymbol),
        medianTickGapSeconds: targetSymbol.startsWith("1HZ") ? 1 : 2,
        ticksSinceLastShot,
        waitedTicks: timingWaitTicks,
      });
      session.hunt.timing = {
        ready: timing.ready,
        score: timing.score,
        waitTicks: timing.waitTicks,
        reason: timing.reason,
        momentumPP: timing.components.momentumPP,
        gapRatio: timing.components.gapRatio,
      };

      if (!timing.ready) {
        timingWaitTicks++;
        session.hunt.setupsRejected++;
        session.message = inRecovery
          ? `🎯 Recovery armed (${read.confidence}% · ${read.tier}) — ${timing.reason}`
          : `⏳ Armed on ${targetName} · ${read.confidence}% confidence (${read.tier}) — ${timing.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }
      timingWaitTicks = 0;
      broadcast();

      // Contract sovereignty — re-asserted immediately before every buy. In hunt
      // mode the market may legitimately have moved, but the contract may not,
      // and the market must still be one the scan is allowed to look at.
      if (LOCKED_CONTRACT.kind !== config.contract.kind
          || LOCKED_CONTRACT.digit !== config.contract.digit
          || !isAutomatedMarket(targetSymbol)) {
        session.running = false;
        session.message = "⚠️ Lock integrity check failed — session halted before firing";
        logger.error({ targetSymbol, LOCKED_CONTRACT, config }, "Kill-Shot lock violation");
        broadcast();
        return;
      }

      const barrier = LOCKED_CONTRACT.kind === "even" || LOCKED_CONTRACT.kind === "odd"
        ? undefined
        : LOCKED_CONTRACT.digit;

      const payoutQuote = await resolveRecoveryPayout({
        symbol: targetSymbol,
        contractType: LOCKED_TYPE,
        barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      const payout = payoutQuote.payoutMultiplier || killShotPayout(LOCKED_CONTRACT);

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

      // Shared recovery stake formula — byte-identical to the other six bots.
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, payout, botRecoveryMarkup)
        : config.stake;

      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.hunt.phase = "firing";
      session.currentStake = stake;
      session.currentMarket = targetName;
      session.currentContractType = killShotLabel(LOCKED_CONTRACT);
      session.message = inRecovery
        ? `🎯 KILL SHOT [Recovery R${sharedStep}] ${killShotLabel(LOCKED_CONTRACT)} on ${targetName} · $${stake.toFixed(2)} · ${read.confidence}% conf`
        : `🎯 KILL SHOT ${killShotLabel(LOCKED_CONTRACT)} on ${targetName} · $${stake.toFixed(2)} · ${read.confidence}% conf · ${read.sprt.oddsForEdge.toFixed(0)}:1 odds`;
      broadcast();

      const reason = `[${BOT_NAME}${inRecovery ? " RECOVERY" : ""}] ${killShotLabel(LOCKED_CONTRACT)} on ${targetName} · ` +
        `conf ${read.confidence}% (${read.tier}) · p̂ ${(read.pWin * 100).toFixed(1)}% (floor ${(read.pLower * 100).toFixed(1)}%) · ` +
        `SPRT ${read.sprt.logLR}/${read.sprt.upper} nats · ξ ${read.loss.clusterRatio.toFixed(2)} · ` +
        `${read.concordance.agreeing}/${read.concordance.total} horizons · EV ${(read.expectedValue * 100).toFixed(1)}%/$1 · ` +
        `entry ${timing.score}/100 (momentum ${timing.components.momentumPP >= 0 ? "+" : ""}${timing.components.momentumPP.toFixed(1)}pp, renewal ${timing.components.gapRatio.toFixed(2)}×) · ` +
        `watched ${session.hunt.ticksWatched} ticks`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: targetSymbol,
        displayName: targetName,
        contractType: LOCKED_TYPE,
        barrier: barrier ?? null,
        stake: String(Math.round(stake * 100) / 100),
        direction: "hold",
        status: "open",
        aiConfidence: String(read.confidence),
        aiRiskScore: "20",
        isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`,
        duration: 1,
        durationUnit: "t",
      }).returning();

      // ── Execute ────────────────────────────────────────────────────────────
      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(targetSymbol) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: targetSymbol,
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
          logger.warn({ err }, "Kill-Shot live execution error — returning to the hunt");
          try {
            await db.update(tradesTable).set({
              status: "error", profit: "0", payout: "0", closedAt: new Date(),
              agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
            }).where(eq(tradesTable.id, journaled!.id));
          } catch { /* best-effort */ }
          session.hunt.phase = "waiting";
          session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}. Back to watching.`;
          broadcast();
          await sleep(2000);
          continue;
        }
      } else {
        // Paper mode settles against the market's REAL next digit — this bot's
        // entire thesis is the digit stream, so a coin flip would be meaningless.
        session.hunt.phase = "settling";
        const before = tickManager.getDigits(targetSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const d = tickManager.getDigits(targetSymbol, 1)[0];
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
      if (won) { session.winCount++; session.lastResult = "won"; }
      else { session.lossCount++; session.lastResult = "lost"; }

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
        logger.warn({ dbErr }, "Kill-Shot: failed to settle journaled trade");
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

      // Reset the hunt: the next shot must earn its own evidence from scratch,
      // and it must be spaced far enough from this one that it is an independent
      // bet rather than the same evidence window spent twice. The market and the
      // hunt-mode counters survive the reset — only the evidence is discarded.
      session.hunt = {
        ...freshHunt(),
        setupsRejected: session.hunt.setupsRejected,
        targetMode: session.hunt.targetMode,
        targetSymbol,
        targetDisplayName: targetName,
        marketsScanned: session.hunt.marketsScanned,
        bestConfidence: session.hunt.bestConfidence,
        tier: read.tier,
      };
      ticksSinceLastShot = 0;
      timingWaitTicks = 0;
      lastHuntAt = 0; // re-hunt immediately: the landscape has changed
      session.message = won
        ? `✅ Kill shot landed — +$${profit.toFixed(2)}. Returning to the hunt.`
        : `❌ Shot missed — -$${Math.abs(profit).toFixed(2)}. Recovery armed; the next shot waits for full evidence.`;
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
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit. Session stopped safely.`;
        broadcast();
        return;
      }
      if (config.maxTrades > 0 && session.tradeCount >= config.maxTrades) {
        session.running = false;
        session.message = `🏁 Shot limit reached (${config.maxTrades}). Session complete — P&L ${session.totalProfit >= 0 ? "+" : "-"}$${Math.abs(session.totalProfit).toFixed(2)}.`;
        broadcast();
        return;
      }

      // Cool-down before hunting again. Deliberately long: fresh, independent
      // evidence is the whole product, and re-firing on the same accumulated
      // window would be double-counting the evidence that justified this shot.
      await sleep(won ? 2500 : 3500);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Kill-Shot stability catch");
      session.message = `Stabilizing engine — retry ${consecutiveErrors}/5`;
      broadcast();
      await sleep(Math.min(3000, 600 * consecutiveErrors));
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
      && !session.message?.startsWith("🏁")
      && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}
