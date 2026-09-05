/**
 * KILL-SHOT ORACLE — execution engine (7th specialist bot).
 *
 * OPERATING MODEL — ANALYSE ONCE, LOCK, THEN WAIT
 * ───────────────────────────────────────────────
 * Two decisions, both taken before a cent is risked:
 *
 *   1. WHAT — the user names ONE contract (Over N, Under N, Matches, Even or
 *      Odd; never both sides of a pair). Frozen for the session and re-asserted
 *      immediately before every buy.
 *   2. WHERE — the scan names ONE market and it is FROZEN. No hunt mode, no
 *      rotation, no switching, exactly like the Barrier Architect in locked
 *      mode. `LOCKED_SYMBOL` is a const captured once at session start and there
 *      is no code path — not a stall, not a loss run, not a drift alarm — that
 *      can reassign it.
 *
 * Everything after that is patience. The loop's normal state is "watching, not
 * trading"; firing is the exception.
 *
 * THE FOUR GATES A SHOT MUST PASS, IN ORDER
 * ─────────────────────────────────────────
 *  · HEALTH  — the locked market must still look like the market that was
 *              analysed (Page–Hinkley on the realised rate + a live re-read of
 *              the verdict). If it does not, the bot STOPS FIRING and raises
 *              RESCAN REQUIRED. It never quietly moves market.
 *  · EDGE    — `evaluateLiveEntry` with the FROZEN MODEL CARD: the same
 *              ensemble, the same Platt calibration and the same τ the
 *              walk-forward measured. This is what makes the quoted
 *              out-of-sample accuracy a statement about this session.
 *  · SHIELD  — the post-loss protocol. After a loss the bar rises by
 *              `postLossTightening` σ per step of the run and a cool-down of
 *              `postLossCoolTicks` is enforced. This is the rule the scan
 *              simulated in `pairShield`, so its measured effect on consecutive
 *              losses is the effect that actually runs.
 *  · TICK    — `evaluateTiming`: momentum, favoured Markov state, renewal
 *              clock, feed freshness, shot spacing. Its patience valve takes the
 *              shot anyway once an objection has stood long enough.
 *
 * SHARED RECOVERY, IDENTICAL TO EVERY OTHER BOT IN THE SECTION
 * ────────────────────────────────────────────────────────────
 * The ONE account-global ledger (`lib/agents/recovery-engine.ts`), the ONE
 * debt-driven stake formula (`getBotRecoveryStake`) and the ONE single-executor
 * arbiter (`lib/engine-arbiter.ts`, owner `bots`). No private debt state. A
 * recovery shot waits for all four gates, and for a HARDER version of the edge
 * gate — a hurried recovery is exactly how a two-loss streak becomes a five-loss
 * streak, and it is the failure mode this bot exists to prevent.
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
  getLiveBalance,
  isAutomatedMarket,
  getDeepDigits,
  deepHistoryDegraded,
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
  evaluateCandidate,
  evaluateLiveEntry,
  screenCandidates,
  shotLabel,
  shotWinSet,
  shotPayout,
  certaintySpec,
  detectability,
  pageHinkley,
  KILLSHOT_CONTRACT_TYPE,
  SCAN_WINDOW,
  MIN_HISTORY,
  type KillShotCandidate,
  type Certainty,
  type ShotContract,
  type ModelCard,
  type ExpertReading,
} from "./killshot-analysis";
import { evaluateTiming } from "./killshot-timing";

export const KILLSHOT_BOT_ID = "killshot";
const BOT_NAME = "Kill-Shot Oracle";

/** Consecutive health-flagged evaluations before the lock is declared dead. */
const RESCAN_HALT_EVALS = 5;
/** How often the expensive market-level re-read runs, in ms. */
const REREAD_INTERVAL_MS = 4000;
/** Ceiling on the post-loss bar boost, in σ. */
const MAX_BAR_BOOST = 2.5;

// ── Config / status ───────────────────────────────────────────────────────────

export interface KillShotConfig {
  ownerSessionId?: string;
  /** The market the scan locked. FROZEN for the whole session. */
  symbol: string;
  displayName: string;
  /** FROZEN contract — exactly one side, never both. */
  contract: ShotContract;
  certainty: Certainty;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  /** Stop after this many shots (0 = until TP/SL). */
  maxShots: number;
  /** The frozen model card — the rule the walk-forward measured. */
  card: ModelCard;
  /** Pre-deploy analysis, kept for the UI and the journal. */
  lockedAnalysis?: KillShotCandidate;
  /** True when the user deliberately locked a market that was only WATCH. */
  forced?: boolean;
}

export interface KillShotLockInfo {
  symbol: string;
  displayName: string;
  contract: string;
  certainty: string;
  verdict: string;
  confidence: number;
  payout: number;
  breakEven: number;
  /** Out-of-sample accuracy of the frozen rule — the bot's actual promise. */
  oosWinRate: number;
  oosWinRateLower: number;
  oosShots: number;
  oosTicks: number;
  edgePerDollar: number;
  evidenceE: number;
  brierSkill: number;
  tau: number;
  ladderSafety: number;
  ladderLimit: number;
  expectedShotsToBreak: number;
  xi: number;
  pairsBefore: number;
  pairsAfter: number;
  forced: boolean;
  signals: string[];
}

export interface KillShotWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  /** Live composite confidence on the locked market, 0–100. */
  confidence: number;
  verdict: string;
  /** Conditional (calibrated) P(win) right now and the edge in σ. */
  p: number;
  /** The decision statistic: how far the live edge sits above the frozen bar's anchor. */
  z: number;
  /** The raw edge in posterior standard deviations, for the journal. */
  edgeZ: number;
  bar: number;
  tau: number;
  marginZ: number;
  leader: string;
  contextOrder: number;
  contextCount: number;
  regimeHot: number;
  experts: ExpertReading[];
  /** Market-level blockers on the live re-read. */
  blockers: string[];
  ticksWatched: number;
  setupsRejected: number;
  /** Health / drift guard. */
  health: {
    ph: number;
    threshold: number;
    fired: boolean;
    consecutive: number;
    needsRescan: boolean;
    note: string;
  };
  /** Post-loss protocol state. */
  shield: {
    lossRun: number;
    barBoost: number;
    ticksSinceLoss: number;
    coolTicks: number;
    active: boolean;
  };
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
  deepestLossRun: number;
  /** True when the locked market has changed and the user must re-analyse. */
  needsRescan: boolean;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: Omit<KillShotConfig, "ownerSessionId" | "lockedAnalysis" | "card">;
  killshotLock?: KillShotLockInfo;
  watch?: KillShotWatch;
}

export interface KillShotScanResult {
  suitable: boolean;
  best: KillShotCandidate | null;
  /** The best market available even when nothing is CERTIFIED. Never null when any market could be judged. */
  bestAvailable: KillShotCandidate | null;
  allScored: KillShotCandidate[];
  reason: string;
  certainty: Certainty;
  marketsScanned: number;
  /** Digits actually available per market — makes data starvation visible. */
  historyDepth: number;
  /** Contract-level facts that do not depend on any market. */
  detect: ReturnType<typeof detectability>;
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
  deepestLossRun: number;
  currentLossRun: number;
  needsRescan: boolean;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  stopRequested: boolean;
  watch: KillShotWatch;
}

function freshWatch(): KillShotWatch {
  return {
    phase: "watching",
    confidence: 0,
    verdict: "—",
    p: 0,
    z: 0,
    edgeZ: 0,
    bar: 0,
    tau: 0,
    marginZ: 0,
    leader: "context-tree",
    contextOrder: 0,
    contextCount: 0,
    regimeHot: 0.5,
    experts: [],
    blockers: [],
    ticksWatched: 0,
    setupsRejected: 0,
    health: { ph: 0, threshold: 10, fired: false, consecutive: 0, needsRescan: false, note: "" },
    shield: { lossRun: 0, barBoost: 0, ticksSinceLoss: 999, coolTicks: 0, active: false },
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
    needsRescan: false,
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

function lockInfo(cfg: KillShotConfig | null): KillShotLockInfo | undefined {
  if (!cfg) return undefined;
  const a = cfg.lockedAnalysis;
  return {
    symbol: cfg.symbol,
    displayName: cfg.displayName,
    contract: shotLabel(cfg.contract),
    certainty: cfg.certainty,
    verdict: a?.verdict ?? "—",
    confidence: a?.confidence ?? 0,
    payout: a?.payout ?? shotPayout(cfg.contract),
    breakEven: a?.breakEven ?? cfg.card.breakEven,
    oosWinRate: a?.walk.test.winRate ?? 0,
    oosWinRateLower: a?.walk.test.winRateLower ?? 0,
    oosShots: a?.walk.test.nShots ?? 0,
    oosTicks: a?.walk.testTicks ?? 0,
    edgePerDollar: a?.edgePerDollar ?? 0,
    evidenceE: a?.walk.test.evidence.peak ?? 1,
    brierSkill: a?.walk.platt.brierSkill ?? 0,
    tau: cfg.card.tau,
    ladderSafety: a?.ladder.safety ?? 0,
    ladderLimit: a?.ladder.limit ?? 0,
    expectedShotsToBreak: a?.ladder.expectedShotsToBreak ?? 0,
    xi: a?.walk.test.chain.xi ?? 1,
    pairsBefore: a?.walk.shield.pairsBefore ?? 0,
    pairsAfter: a?.walk.shield.pairsAfter ?? 0,
    forced: cfg.forced === true,
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

export function getStatus(): KillShotStatus {
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
        forced: cfg.forced,
      }
    : undefined;
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
    deepestLossRun: session.deepestLossRun,
    needsRescan: session.needsRescan,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    config: publicConfig,
    killshotLock: lockInfo(cfg),
    watch: session.running ? session.watch : undefined,
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
 * Score every digit-enabled market for the user's ONE contract.
 *
 * DEPTH FIRST. Each market is pulled to 4999 digits through
 * `getDeepDigits()` before anything is computed. The previous bot analysed a
 * 300-digit ring buffer and could therefore never satisfy its own shot-count
 * gate; the fix is not a looser gate, it is 16× the evidence.
 *
 * When the user chose Matches WITHOUT naming a digit, all ten digits are scored
 * in every market and Benjamini–Hochberg runs across the full 190-candidate
 * family, so the winner cannot be a lucky argmax.
 */
export async function scanForMarket(
  ownerSessionId: string | undefined,
  contract: ShotContract,
  certainty: Certainty,
  risk: { stake: number; markupPercent: number; maxStake: number; stopLoss: number },
): Promise<KillShotScanResult> {
  const spec = certaintySpec(certainty);
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const contracts: ShotContract[] = contract.kind === "match" && contract.digit === undefined
    ? Array.from({ length: 10 }, (_, d) => ({ kind: "match" as const, digit: d }))
    : [contract];
  const detect = detectability(contract.kind === "match" && contract.digit === undefined ? { kind: "match", digit: 0 } : contract);

  const all: KillShotCandidate[] = [];
  let deepest = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    broadcastSSE("bot_scan_progress", {
      botId: KILLSHOT_BOT_ID,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned: i,
      total: markets.length,
      results: screenCandidates(all).slice(0, 8),
    }, ownerSessionId);

    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, SCAN_WINDOW);
    } catch {
      digits = tickManager.getDigits(market.symbol, SCAN_WINDOW);
    }
    deepest = Math.max(deepest, digits.length);

    for (const c of contracts) {
      const cand = evaluateCandidate(market.symbol, market.displayName, digits, c, {
        certainty: spec.id,
        baseStake: risk.stake,
        markupPercent: risk.markupPercent,
        maxStake: risk.maxStake,
        stopLoss: risk.stopLoss,
      });
      if (cand) all.push(cand);
    }
    // Yield to the event loop so SSE progress actually streams.
    await sleep(5);
  }

  const ranked = screenCandidates(all);
  broadcastSSE("bot_scan_progress", {
    botId: KILLSHOT_BOT_ID,
    scanning: null, symbol: null,
    scanned: markets.length, total: markets.length,
    results: ranked.slice(0, 8),
  }, ownerSessionId);

  if (ranked.length === 0) {
    return {
      suitable: false, best: null, bestAvailable: null, allScored: [], certainty: spec.id,
      marketsScanned: markets.length, historyDepth: deepest, detect,
      reason:
        `No market could be judged yet — this bot needs ${MIN_HISTORY}+ digits per market to split into a fit half and a ` +
        `measurement half, and the deepest history available right now is ${deepest}. ` +
        (deepHistoryDegraded()
          ? `Deriv's ticks_history endpoint is not answering, so only ticks collected since this server started are available ` +
            `and they are accumulating in real time. Nothing is guessed from a short window: wait for the buffer to fill, or ` +
            `restore the connection to Deriv, then re-scan.`
          : `That usually means the tick feed has only just started; wait a moment and re-scan.`),
    };
  }

  const best = ranked[0];
  const suitable = best.deployable;
  const reason = suitable
    ? describeLock(best, spec.label)
    : explainRefusal(best, spec.label, ranked.length);

  return {
    suitable,
    best: suitable ? best : null,
    bestAvailable: best,
    allScored: ranked.slice(0, 24),
    reason,
    certainty: spec.id,
    marketsScanned: markets.length,
    historyDepth: deepest,
    detect,
  };
}

function describeLock(best: KillShotCandidate, certaintyLabel: string): string {
  const t = best.walk.test;
  return `${best.displayName} · ${best.label} — ${best.verdict.toUpperCase()} at ${certaintyLabel} (${best.confidence}/100). ` +
    `The rule was fitted on ${best.walk.trainTicks} ticks and then measured on ${best.walk.testTicks} ticks it had never seen: ` +
    `${t.nShots} shots at ${(t.winRate * 100).toFixed(1)}% (Wilson floor ${(t.winRateLower * 100).toFixed(1)}%) against a ${(best.breakEven * 100).toFixed(1)}% break-even, ` +
    `expectancy ${t.evPerDollar >= 0 ? "+" : ""}${(t.evPerDollar * 100).toFixed(2)}% per $1, e-value ${t.evidence.peak.toFixed(1)}. ` +
    `Ladder absorbs ${best.ladder.limit} consecutive losses at ${(best.ladder.safety * 100).toFixed(1)}% safety; the post-loss shield cut out-of-sample loss pairs from ${best.walk.shield.pairsBefore} to ${best.walk.shield.pairsAfter}.`;
}

/**
 * Explain a refusal the user can act on.
 *
 * Three things every refusal must say, because the previous bot said none of
 * them: WHAT was measured, WHY it fell short, and WHICH knob changes it.
 */
function explainRefusal(best: KillShotCandidate, certaintyLabel: string, examined: number): string {
  const t = best.walk.test;
  const measured = t.nShots > 0
    ? `Its rule took ${t.nShots} shots on ${best.walk.testTicks} unseen ticks and won ${(t.winRate * 100).toFixed(1)}% ` +
      `against a ${(best.breakEven * 100).toFixed(1)}% break-even (expectancy ${t.evPerDollar >= 0 ? "+" : ""}${(t.evPerDollar * 100).toFixed(2)}%/$1, e-value ${t.evidence.peak.toFixed(1)}).`
    : `Its rule found no qualifying context in ${best.walk.testTicks} unseen ticks.`;

  const knob = best.verdict === "watch"
    ? ` You can still lock it deliberately — the console will make you confirm — or drop to a lower certainty bar, which widens the entry quantile and produces more shots to judge.`
    : best.verdict === "refused"
      ? ` Its measured expectancy is negative, so locking it would be knowingly betting on a proven loser. Try a different contract: ${best.detect.note}`
      : "";

  return `Nothing is CERTIFIED for ${best.label} at the ${certaintyLabel} bar across ${examined} candidates. ` +
    `The strongest is ${best.displayName} (${best.verdict.toUpperCase()}, ${best.confidence}/100). ${measured} ` +
    `Blocked by: ${best.blockers[0] ?? "insufficient evidence"}.${knob}`;
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
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  if (!market || !market.digitEnabled) return fail("This bot needs a digit-enabled market");
  if (config.contract.kind === "match" && config.contract.digit === undefined) {
    return fail("The Matches digit must be resolved by the scan before deployment");
  }
  if (!config.card || !Number.isFinite(config.card.tau)) {
    return fail("Run the analysis first — this bot only deploys a rule it has measured");
  }

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_killshot_${Date.now()}`,
    config,
    currentStake: config.stake,
    message:
      `Locked on ${config.displayName} · ${shotLabel(config.contract)} · ${certaintySpec(config.certainty).label}. ` +
      `No trade on deploy — the bot holds until health, edge, shield and tick all agree.`,
  };

  logger.info({
    symbol: config.symbol,
    contract: shotLabel(config.contract),
    certainty: config.certainty,
    tau: config.card.tau,
    verdict: config.lockedAnalysis?.verdict,
    forced: config.forced === true,
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
  const token = accounts.length > 0 ? (accounts[0].bearerToken ?? accounts[0].token ?? null) : null;
  const currency = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0].maxTradeStake) : 500;
  let botRecoveryMarkup = settings.length > 0 ? Number((settings[0] as any).botRecoveryMarkup ?? 10) : 10;
  let availableBalance = accounts.length > 0 && Number(accounts[0].balance) > 0
    ? Number(accounts[0].balance)
    : Number.POSITIVE_INFINITY;

  // ── WHAT IS FROZEN ─────────────────────────────────────────────────────────
  // Captured once, never reassigned. There is no branch anywhere below that can
  // move this session to another market, another contract, or another rule.
  const LOCKED_SYMBOL: string = config.symbol;
  const LOCKED_NAME: string = config.displayName;
  const LOCKED_CONTRACT: ShotContract = { ...config.contract };
  const LOCKED_TYPE = KILLSHOT_CONTRACT_TYPE[LOCKED_CONTRACT.kind];
  const LOCKED_WINSET = shotWinSet(LOCKED_CONTRACT);
  const CARD: ModelCard = { ...config.card };
  const SPEC = certaintySpec(config.certainty);

  let timingWaitTicks = 0;
  let ticksSinceLastShot = Number.POSITIVE_INFINITY;
  let ticksSinceLoss = Number.POSITIVE_INFINITY;
  let lossRun = 0;
  let lastDigitCount = 0;
  let lastReadAt = 0;
  let cachedRead: KillShotCandidate | null = config.lockedAnalysis ?? null;
  let healthEvals = 0;
  let consecutiveErrors = 0;

  session.watch.tau = CARD.tau;

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
      const digits = await getDeepDigits(LOCKED_SYMBOL, SCAN_WINDOW);
      if (digits.length !== lastDigitCount) {
        const delta = Math.max(0, digits.length - lastDigitCount);
        session.watch.ticksWatched += delta;
        if (Number.isFinite(ticksSinceLastShot)) ticksSinceLastShot += delta;
        if (Number.isFinite(ticksSinceLoss)) ticksSinceLoss += delta;
        lastDigitCount = digits.length;
      }

      // ── GATE 1: HEALTH — is this still the market that was analysed? ───────
      if (Date.now() - lastReadAt >= REREAD_INTERVAL_MS) {
        lastReadAt = Date.now();
        const read = evaluateCandidate(LOCKED_SYMBOL, LOCKED_NAME, digits, LOCKED_CONTRACT, {
          certainty: SPEC.id,
          baseStake: config.stake,
          markupPercent: botRecoveryMarkup,
          maxStake,
          stopLoss: config.stopLoss,
        });
        if (read) {
          cachedRead = read;
          session.watch.confidence = read.confidence;
          session.watch.verdict = read.verdict;
          session.watch.blockers = read.blockers.slice(0, 3);
        }
        // The drift detector runs on the raw win series of the locked contract,
        // independently of the candidate evaluation, so it keeps working even
        // when the window is too short for a full re-read.
        const wins = digits.map(d => (LOCKED_WINSET.has(d) ? 1 : 0));
        const ph = pageHinkley(wins);
        const degraded = ph.fired || (cachedRead?.verdict === "refused");
        healthEvals = degraded ? healthEvals + 1 : 0;
        session.watch.health = {
          ph: ph.ph,
          threshold: ph.threshold,
          fired: ph.fired,
          consecutive: healthEvals,
          needsRescan: healthEvals >= 2,
          note: ph.fired
            ? `Realised win rate on ${LOCKED_NAME} has fallen away from its locked baseline (Page–Hinkley ${ph.ph.toFixed(1)}/${ph.threshold}).`
            : cachedRead?.verdict === "refused"
              ? `The locked market's live read has turned negative: ${cachedRead.blockers[0] ?? "expectancy below break-even"}.`
              : "",
        };
        session.needsRescan = session.watch.health.needsRescan;
      }

      if (!cachedRead) {
        session.watch.phase = "watching";
        session.message = `Building history on ${LOCKED_NAME} — ${digits.length}/${MIN_HISTORY} digits before the locked rule can be re-checked.`;
        broadcast();
        await sleep(1500);
        continue;
      }

      // ── THE RESCAN ALERT ───────────────────────────────────────────────────
      // The market is locked, so a market that has changed is handled by holding
      // fire and TELLING THE USER, never by rotating. After enough consecutive
      // flags the session ends and asks for a fresh analysis.
      if (session.watch.health.needsRescan) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        if (healthEvals >= RESCAN_HALT_EVALS) {
          session.running = false;
          session.needsRescan = true;
          session.message =
            `🛑 RESCAN REQUIRED — ${LOCKED_NAME} is no longer the market this session was locked to. ` +
            `${session.watch.health.note} The lock is never moved silently, so the session has ended: re-run the analysis to pick a fresh market.`;
          broadcast();
          return;
        }
        session.message =
          `⚠️ RESCAN REQUIRED — holding fire on ${LOCKED_NAME}. ${session.watch.health.note} ` +
          `No market switching: stop and re-analyse, or wait — if the market recovers the bot resumes on its own (${healthEvals}/${RESCAN_HALT_EVALS}).`;
        broadcast();
        await sleep(2000);
        continue;
      }

      if (!cachedRead.deployable) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        const top = cachedRead.blockers[0] ?? "gathering evidence";
        session.message = inRecovery
          ? `🎯 Recovery armed — holding until the locked market's live read clears. ${top}`
          : `👁 Watching ${LOCKED_NAME} · ${cachedRead.verdict.toUpperCase()} ${cachedRead.confidence}/100 · ${top}`;
        broadcast();
        await sleep(1600);
        continue;
      }

      // ── GATE 2 + 3: EDGE, with the post-loss SHIELD applied ────────────────
      // The shield is the rule the scan simulated: after a loss the bar rises by
      // `postLossTightening` σ per step of the run, and a cool-down is enforced.
      // Recovery shots inherit one extra step of tightening on top — the debt is
      // already geometric, so the last thing it needs is a hurried entry.
      const barBoost = Math.min(
        MAX_BAR_BOOST,
        CARD.postLossTightening * (lossRun + (inRecovery ? 1 : 0)),
      );
      const entry = evaluateLiveEntry(digits, LOCKED_WINSET, CARD, {
        barBoost,
        ticksSinceLoss,
      });
      session.watch.p = entry.p;
      session.watch.z = entry.z;
      session.watch.edgeZ = entry.edgeZ;
      session.watch.bar = entry.bar;
      session.watch.tau = entry.tau;
      session.watch.marginZ = entry.marginZ;
      session.watch.leader = entry.leader;
      session.watch.contextOrder = entry.contextOrder;
      session.watch.contextCount = entry.contextCount;
      session.watch.regimeHot = entry.regimeHot;
      session.watch.experts = entry.experts;
      session.watch.shield = {
        lossRun,
        barBoost: Math.round(barBoost * 100) / 100,
        ticksSinceLoss: Number.isFinite(ticksSinceLoss) ? ticksSinceLoss : 999,
        coolTicks: CARD.postLossCoolTicks,
        active: barBoost > 0,
      };

      if (!entry.ready) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        session.watch.entry = {
          ready: false, score: 0, waitTicks: 0, reason: entry.reason,
          momentumPP: 0, gapRatio: 0, preferredState: "none", stateEdgePP: 0,
        };
        session.watch.setupsRejected++;
        session.message = inRecovery
          ? `🎯 Recovery armed — waiting for a qualifying edge. ${entry.reason}`
          : `👁 Market clear, waiting for the edge — ${entry.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }

      // ── GATE 4: is THIS the tick? ──────────────────────────────────────────
      session.watch.phase = "armed";
      const timing = evaluateTiming({
        digits,
        winSet: LOCKED_WINSET,
        secondsSinceLastTick: tickManager.getTickAgeSeconds(LOCKED_SYMBOL),
        medianTickGapSeconds: LOCKED_SYMBOL.startsWith("1HZ") ? 1 : 2,
        ticksSinceLastShot,
        waitedTicks: timingWaitTicks,
        minSpacing: CARD.minSpacing,
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
          ? `🎯 Recovery armed (edge ${entry.z.toFixed(2)}σ) — ${timing.reason}`
          : `⏳ Armed on ${LOCKED_NAME} · edge ${entry.z.toFixed(2)}σ vs ${entry.bar.toFixed(2)}σ bar — ${timing.reason}`;
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
        logger.error({ LOCKED_SYMBOL, LOCKED_CONTRACT, config }, "Kill-Shot lock violation");
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
      const payout = payoutQuote.payoutMultiplier || shotPayout(LOCKED_CONTRACT);

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
      session.currentContractType = shotLabel(LOCKED_CONTRACT);
      session.message = inRecovery
        ? `🎯 KILL SHOT [Recovery R${sharedStep}] ${shotLabel(LOCKED_CONTRACT)} on ${LOCKED_NAME} · $${stake.toFixed(2)} · edge ${entry.z.toFixed(2)}σ · P ${(entry.p * 100).toFixed(1)}%`
        : `🎯 KILL SHOT ${shotLabel(LOCKED_CONTRACT)} on ${LOCKED_NAME} · $${stake.toFixed(2)} · edge ${entry.z.toFixed(2)}σ vs ${entry.bar.toFixed(2)}σ bar · P ${(entry.p * 100).toFixed(1)}%`;
      broadcast();

      const reason = `[${BOT_NAME}${inRecovery ? " RECOVERY" : ""}] ${shotLabel(LOCKED_CONTRACT)} on ${LOCKED_NAME} · ` +
        `${SPEC.label} · live verdict ${cachedRead.verdict} ${cachedRead.confidence}/100 · ` +
        `edge ${entry.z.toFixed(2)}σ vs bar ${entry.bar.toFixed(2)}σ (τ ${CARD.tau.toFixed(2)}, boost ${barBoost.toFixed(2)}) · ` +
        `P(win|context) ${(entry.p * 100).toFixed(1)}% from ${entry.leader} (order ${entry.contextOrder}, n ${entry.contextCount}), regime hot ${(entry.regimeHot * 100).toFixed(0)}% · ` +
        `out-of-sample rule: ${cachedRead.walk.test.nShots} shots at ${(cachedRead.walk.test.winRate * 100).toFixed(1)}% on ${cachedRead.walk.testTicks} unseen ticks, e-value ${cachedRead.walk.test.evidence.peak.toFixed(1)} · ` +
        `ladder safety ${(cachedRead.ladder.safety * 100).toFixed(1)}% (limit ${cachedRead.ladder.limit}) · ` +
        `entry ${timing.score}/100 (${timing.components.preferredState === "none" ? "state neutral" : timing.components.preferredState}, renewal ${timing.components.gapRatio.toFixed(2)}×) · ` +
        `watched ${session.watch.ticksWatched} ticks, declined ${session.watch.setupsRejected} setups`;

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
            accountId: accounts[0].derivAccountId ?? accounts[0].loginId,
            ...(barrier !== undefined ? { barrier } : {}),
          } as any);
          const result = await waitForContractResult(
            token!, accounts[0].derivAccountId ?? accounts[0].loginId,
            liveResult.contractId, 30_000,
          );
          won = result.won;
          profit = result.profit;
          entryPrice = Number(result.entrySpot) || liveResult.buyPrice;
          exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          logger.warn({ err }, "Kill-Shot live execution error — returning to the watch");
          try {
            await db.update(tradesTable).set({
              status: "error", profit: "0", payout: "0", closedAt: new Date(),
              agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
            }).where(eq(tradesTable.id, journaled.id));
          } catch { /* best-effort */ }
          session.watch.phase = "watching";
          session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}. Back to watching.`;
          broadcast();
          await sleep(2000);
          continue;
        }
      } else {
        // Paper mode settles against the market's REAL next digit — the digit
        // stream is this bot's entire thesis, so a coin flip would be meaningless.
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
        lossRun = 0;
        ticksSinceLoss = Number.POSITIVE_INFINITY;
      } else {
        session.lossCount++;
        session.lastResult = "lost";
        session.currentLossRun++;
        session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun);
        lossRun++;
        ticksSinceLoss = 0;
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
        }).where(eq(tradesTable.id, journaled.id));
      } catch (dbErr) {
        logger.warn({ dbErr }, "Kill-Shot: failed to settle the journaled trade");
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
              .where(eq(accountsTable.id, accounts[0].id));
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
        verdict: cachedRead.verdict,
        tau: CARD.tau,
        health: session.watch.health,
      };
      ticksSinceLastShot = 0;
      timingWaitTicks = 0;
      lastReadAt = 0; // force a fresh market read before the next shot
      session.message = won
        ? `✅ Shot landed — +$${profit.toFixed(2)}. ${session.winCount}/${session.tradeCount} this session, deepest loss run ${session.deepestLossRun}. Back to watching.`
        : `❌ Shot missed — −$${Math.abs(profit).toFixed(2)} (run ${session.currentLossRun}/${cachedRead.ladder.limit}). ` +
          `Post-loss shield engaged: bar +${(CARD.postLossTightening * lossRun).toFixed(2)}σ and a ${CARD.postLossCoolTicks}-tick cool-down before the next shot is even considered.`;
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

      // Cool-down. Deliberately long after a loss: the post-loss protocol needs
      // real ticks to pass, not a token pause.
      await sleep(won ? 2500 : 4000);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Kill-Shot stability catch");
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
