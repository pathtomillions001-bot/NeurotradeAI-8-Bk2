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
  IDENTITY_PLATT,
  expandPlan,
  shotKey,
  shotPlanLabel,
  planAnchor,
  type KillShotCandidate,
  type Certainty,
  type ShotContract,
  type ShotPlan,
  type ModelCard,
  type ExpertReading,
  type LiveEntry,
} from "./killshot-analysis";
import { evaluateTiming } from "./killshot-timing";

export const KILLSHOT_BOT_ID = "killshot";
const BOT_NAME = "Kill-Shot Oracle";

/**
 * HEALTH ESCALATION.
 *
 * A locked bot that abandons its market at the first bad read is no better than
 * one that never fires: a re-read is a fresh measurement on a fresh window, so a
 * marginal market flips verdict on sampling noise alone. Degradation therefore
 * has to be SUSTAINED before it means anything — the alert wants ~45 seconds of
 * agreement and ending the session wants ~3 minutes.
 */
const RESCAN_ALERT_EVALS = 3;
const RESCAN_HALT_EVALS = 12;
/** How often the expensive market-level re-read runs, in ms. */
const REREAD_INTERVAL_MS = 15_000;
/** Ticks the drift detector looks back over — the recent past, not all history. */
const HEALTH_WINDOW = 1500;
/** Ceiling on the post-loss bar boost, in σ. */
const MAX_BAR_BOOST = 2.5;

// ── Config / status ───────────────────────────────────────────────────────────

export type KillShotMarketMode = "locked" | "switching";

export interface KillShotConfig {
  ownerSessionId?: string;
  /** The market the scan locked — the starting point, frozen unless switching. */
  symbol: string;
  displayName: string;
  /**
   * The user's PLAN — any combination of contracts. Both sides of a pair are
   * legal now (Even+Odd, Over A+Under B, a mix, or a single contract). The bot
   * trades BETWEEN them in the same locked market, firing the strongest ready
   * setup each tick. A Matches/Differs left to the AI re-resolves its digit
   * live — the lock is on the MARKET, never on the digit.
   */
  contracts: ShotPlan;
  certainty: Certainty;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  /** Stop after this many shots (0 = until TP/SL). */
  maxShots: number;
  /** Locked (default) — the market never moves — or user-allowed switching. */
  marketMode: KillShotMarketMode;
  /**
   * Measured model cards for the starting market, keyed by `shotKey` of each
   * EXPANDED digit contract. For an AI Matches/Differs this is all ten digits —
   * that is what lets the AI change the digit live without re-measuring.
   */
  cards: Record<string, ModelCard>;
  /** Pre-deploy analysis (the plan's strongest read), kept for the UI/journal. */
  lockedAnalysis?: KillShotCandidate;
  /** True when the user deliberately locked a market that was only WATCH. */
  forced?: boolean;
}

/** One runnable contract inside a plan: an expanded digit contract + its card. */
interface ActiveContract {
  contract: ShotContract;
  card: ModelCard;
}
/** A leg of the plan: the contract the user chose, with its measured digits. */
interface ActiveLeg {
  planContract: ShotContract;
  /** True when the AI resolves the digit live (Matches/Differs without a digit). */
  isAI: boolean;
  contracts: ActiveContract[];
}

export interface KillShotLockInfo {
  symbol: string;
  displayName: string;
  /** The plan, as a single label (every contract the bot may trade between). */
  contract: string;
  /** The plan's contracts, individually labelled. */
  contracts: string[];
  /** Locked (default) or user-allowed market switching. */
  marketMode: string;
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
  config?: Omit<KillShotConfig, "ownerSessionId" | "lockedAnalysis" | "cards">;
  killshotLock?: KillShotLockInfo;
  watch?: KillShotWatch;
}

/** A market's deployment of the plan: its best read + every measured card. */
export interface KillShotMarketView {
  symbol: string;
  displayName: string;
  /** This market's strongest (market, contract) read — for the UI list. */
  best: KillShotCandidate;
  /** Measured cards for every expanded contract on this market (for /start). */
  cards: Record<string, ModelCard>;
  deployable: boolean;
  /** Best out-of-sample expectancy on this market (drives the ranking). */
  edgePerDollar: number;
}

export interface KillShotScanResult {
  suitable: boolean;
  /** The single strongest (market, contract) read across the whole plan. */
  best: KillShotCandidate | null;
  /** The best market available even when nothing is CERTIFIED. Never null when any market could be judged. */
  bestAvailable: KillShotCandidate | null;
  allScored: KillShotCandidate[];
  reason: string;
  certainty: Certainty;
  marketsScanned: number;
  /** Digits actually available per market — makes data starvation visible. */
  historyDepth: number;
  /** Contract-level facts that do not depend on any market (the plan's anchor). */
  detect: ReturnType<typeof detectability>;
  /** The user's plan, echoed back. */
  contracts: ShotPlan;
  /** Per-market deployments — the UI's market list and what /start consumes. */
  markets: KillShotMarketView[];
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

/**
 * The frozen lock, as the console renders it.
 *
 * `lockedAnalysis` arrives from the client, so every field is read defensively:
 * the session's INTEGRITY comes from the model card and the locked symbol, which
 * the engine validates itself, while the analysis is only what gets displayed.
 * A caller that posts a partial analysis must get a session with blank numbers,
 * never a crashed status endpoint.
 */
function lockInfo(cfg: KillShotConfig | null): KillShotLockInfo | undefined {
  if (!cfg) return undefined;
  const a = cfg.lockedAnalysis as Partial<KillShotCandidate> | undefined;
  const walk = a?.walk;
  const test = walk?.test;
  const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const anchor = planAnchor(cfg.contracts);
  return {
    symbol: cfg.symbol,
    displayName: cfg.displayName,
    contract: shotPlanLabel(cfg.contracts),
    contracts: cfg.contracts.map(shotLabel),
    marketMode: cfg.marketMode,
    certainty: cfg.certainty,
    verdict: a?.verdict ?? "—",
    confidence: num(a?.confidence),
    payout: num(a?.payout, shotPayout(anchor)),
    breakEven: num(a?.breakEven, 1 / shotPayout(anchor)),
    oosWinRate: num(test?.winRate),
    oosWinRateLower: num(test?.winRateLower),
    oosShots: num(test?.nShots),
    oosTicks: num(walk?.testTicks),
    edgePerDollar: num(a?.edgePerDollar),
    evidenceE: num(test?.evidence?.peak, 1),
    brierSkill: num(walk?.platt?.brierSkill),
    tau: num(a?.card?.tau),
    ladderSafety: num(a?.ladder?.safety),
    ladderLimit: num(a?.ladder?.limit),
    expectedShotsToBreak: num(a?.ladder?.expectedShotsToBreak),
    xi: num(test?.chain?.xi, 1),
    pairsBefore: num(walk?.shield?.pairsBefore),
    pairsAfter: num(walk?.shield?.pairsAfter),
    forced: cfg.forced === true,
    signals: Array.isArray(a?.signals) ? a!.signals.slice(0, 12) : [],
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
        contracts: cfg.contracts,
        certainty: cfg.certainty,
        marketMode: cfg.marketMode,
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

/** One market's measurement of the whole plan. */
interface PlanMarketMeasurement {
  symbol: string;
  displayName: string;
  /** Measured cards for every expanded contract on this market (keyed by shotKey). */
  cards: Record<string, ModelCard>;
  /** This market's ranked (market, contract) candidates, BH-screened globally. */
  candidates: KillShotCandidate[];
  best: KillShotCandidate | null;
  deployable: boolean;
  /** This market's best out-of-sample expectancy (−∞ when it could not be judged). */
  edgePerDollar: number;
}

/**
 * Measure the user's PLAN on every digit-enabled market.
 *
 * DEPTH FIRST — each market is pulled to 4999 digits before anything is
 * computed. Every contract in the plan is scored on every market (an AI
 * Matches/Differs fans out to all ten digits), and Benjamini–Hochberg runs
 * across the WHOLE plan × market × digit family, so the winner cannot be a
 * lucky argmax. This is the single routine both the pre-deploy scan and the
 * in-session market switching re-use, so a rotation is a fresh, honest
 * measurement — never a drift of a stale rule.
 */
async function measurePlanMarkets(
  ownerSessionId: string | undefined,
  contracts: ShotPlan,
  certainty: Certainty,
  risk: { stake: number; markupPercent: number; maxStake: number; stopLoss: number },
  broadcast: boolean,
): Promise<{ markets: PlanMarketMeasurement[]; ranked: KillShotCandidate[]; best: KillShotCandidate | null; deepest: number }> {
  const spec = certaintySpec(certainty);
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const expanded = expandPlan(contracts);
  const all: KillShotCandidate[] = [];
  let deepest = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    if (broadcast) {
      broadcastSSE("bot_scan_progress", {
        botId: KILLSHOT_BOT_ID,
        scanning: market.displayName,
        symbol: market.symbol,
        scanned: i,
        total: markets.length,
        results: screenCandidates(all).slice(0, 8),
      }, ownerSessionId);
    }
    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, SCAN_WINDOW);
    } catch {
      digits = tickManager.getDigits(market.symbol, SCAN_WINDOW);
    }
    deepest = Math.max(deepest, digits.length);

    for (const c of expanded) {
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
  if (broadcast) {
    broadcastSSE("bot_scan_progress", {
      botId: KILLSHOT_BOT_ID,
      scanning: null, symbol: null,
      scanned: markets.length, total: markets.length,
      results: ranked.slice(0, 8),
    }, ownerSessionId);
  }

  // Group the globally-screened candidates by market, keeping the original
  // market order, and build each market's card map + best read.
  const byMarket = new Map<string, KillShotCandidate[]>();
  for (const c of ranked) {
    const arr = byMarket.get(c.symbol) ?? [];
    arr.push(c);
    byMarket.set(c.symbol, arr);
  }
  const perMarket: PlanMarketMeasurement[] = markets.map(m => {
    const cands = byMarket.get(m.symbol) ?? [];
    const best = cands[0] ?? null;
    const cards: Record<string, ModelCard> = {};
    for (const c of cands) cards[shotKey(c.contract)] = c.card;
    return {
      symbol: m.symbol,
      displayName: m.displayName,
      cards,
      candidates: cands,
      best,
      deployable: best?.deployable ?? false,
      edgePerDollar: best?.edgePerDollar ?? Number.NEGATIVE_INFINITY,
    };
  });

  return { markets: perMarket, ranked, best: ranked[0] ?? null, deepest };
}

/**
 * Score every digit-enabled market for the user's PLAN. Returns the plan's
 * strongest single read, the best market available even when nothing is
 * CERTIFIED, and a per-market deployment (cards + best) the client can lock.
 */
export async function scanForMarket(
  ownerSessionId: string | undefined,
  contracts: ShotPlan,
  certainty: Certainty,
  risk: { stake: number; markupPercent: number; maxStake: number; stopLoss: number },
): Promise<KillShotScanResult> {
  const spec = certaintySpec(certainty);
  const detect = detectability(planAnchor(contracts));
  const { markets, ranked, best, deepest } = await measurePlanMarkets(ownerSessionId, contracts, certainty, risk, true);

  const verdictRank: Record<string, number> = { certified: 0, qualified: 1, watch: 2, refused: 3 };
  const marketViews: KillShotMarketView[] = markets
    .filter(m => m.best)
    .map(m => ({
      symbol: m.symbol,
      displayName: m.displayName,
      best: m.best!,
      cards: m.cards,
      deployable: m.deployable,
      edgePerDollar: m.edgePerDollar,
    }))
    .sort((a, b) => {
      const ra = verdictRank[a.best.verdict] ?? 3;
      const rb = verdictRank[b.best.verdict] ?? 3;
      if (ra !== rb) return ra - rb;
      if (Math.abs(a.edgePerDollar - b.edgePerDollar) > 0.002) return b.edgePerDollar - a.edgePerDollar;
      if (Math.abs(a.best.ladder.safety - b.best.ladder.safety) > 0.01) return b.best.ladder.safety - a.best.ladder.safety;
      return b.best.confidence - a.best.confidence;
    });

  if (!best) {
    return {
      suitable: false, best: null, bestAvailable: null, allScored: [], certainty: spec.id,
      marketsScanned: markets.length, historyDepth: deepest, detect, contracts, markets: [],
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

  const suitable = best.deployable;
  const reason = suitable
    ? describeLock(best, spec.label)
    : explainRefusal(best, spec.label, ranked.length);

  return {
    suitable,
    best: suitable ? best : null,
    bestAvailable: best,
    allScored: ranked.slice(0, 40),
    reason,
    certainty: spec.id,
    marketsScanned: markets.length,
    historyDepth: deepest,
    detect,
    contracts,
    markets: marketViews,
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

/**
 * Coerce a client-supplied model card into one the engine can run.
 *
 * Only τ and the calibration are genuinely the analysis's to give; the timing
 * constants belong to the certainty level the user picked, and the payout and
 * break-even are properties of the contract itself, so a card that disagrees
 * with either is corrected rather than trusted.
 */
function sanitiseCard(raw: ModelCard, contract: ShotContract, spec: ReturnType<typeof certaintySpec>): ModelCard {
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const payout = shotPayout(contract);
  const platt = raw?.platt ?? IDENTITY_PLATT;
  const hmm = raw?.hmm;
  const fair = shotWinSet(contract).size / 10;
  return {
    tau: num(raw?.tau, 0),
    targetShotRate: Math.min(0.5, Math.max(0.001, num(raw?.targetShotRate, spec.targetShotRate))),
    platt: {
      a: num(platt.a, 1),
      b: num(platt.b, 0),
      brierSkill: num(platt.brierSkill, 0),
      logLossSkill: num(platt.logLossSkill, 0),
      n: num(platt.n, 0),
    },
    hmm: {
      pHot: num(hmm?.pHot, Math.min(0.98, fair + 0.06)),
      pCold: num(hmm?.pCold, Math.max(0.01, fair - 0.06)),
      stay: num(hmm?.stay, 0.97),
      prior: num(hmm?.prior, 0.5),
    },
    breakEven: 1 / payout,
    payout,
    minSpacing: Math.round(num(raw?.minSpacing, spec.minSpacing)),
    postLossTightening: num(raw?.postLossTightening, spec.postLossTightening),
    postLossCoolTicks: Math.round(num(raw?.postLossCoolTicks, spec.postLossCoolTicks)),
    fittedOn: Math.round(num(raw?.fittedOn, 0)),
  };
}

/**
 * Build the runnable legs of a plan from its measured cards. Each leg is the
 * contract the user chose; an AI Matches/Differs carries all ten measured
 * digit contracts so the AI can change the digit live. A leg with no measured
 * cards is dropped (it would have no rule to run).
 */
function buildLegs(contracts: ShotPlan, cards: Record<string, ModelCard>): ActiveLeg[] {
  const legs: ActiveLeg[] = [];
  for (const planContract of contracts) {
    const isAI = (planContract.kind === "match" || planContract.kind === "differ") && planContract.digit === undefined;
    const expanded = isAI
      ? Array.from({ length: 10 }, (_, d) => ({ kind: planContract.kind as "match" | "differ", digit: d }))
      : [planContract];
    const acs: ActiveContract[] = [];
    for (const ec of expanded) {
      const card = cards[shotKey(ec)];
      if (card && Number.isFinite(card.tau)) acs.push({ contract: ec, card });
    }
    if (acs.length > 0) legs.push({ planContract, isAI, contracts: acs });
  }
  return legs;
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
  if (!Array.isArray(config.contracts) || config.contracts.length === 0) {
    return fail("Choose at least one contract to trade");
  }
  // Every contract in the plan must carry a measured card for the starting
  // market (an AI Matches/Differs needs all ten digit cards). No card means
  // there is no measured rule to run for that contract.
  const spec = certaintySpec(config.certainty);
  const expanded = expandPlan(config.contracts);
  for (const c of expanded) {
    const card = config.cards?.[shotKey(c)];
    if (!card || !Number.isFinite(Number(card.tau))) {
      return fail("Run the analysis first — every contract in your plan needs a measured model card for the locked market");
    }
  }
  // Each card decides what the live rule DOES for its contract, so it is
  // normalised before it is frozen: a malformed field would otherwise surface
  // as a crashed loop rather than a refusal, and the session's own spec is the
  // right fallback.
  const cards: Record<string, ModelCard> = {};
  for (const c of expanded) cards[shotKey(c)] = sanitiseCard(config.cards[shotKey(c)]!, c, spec);
  config = { ...config, cards };

  const switching = config.marketMode === "switching";
  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_killshot_${Date.now()}`,
    config,
    currentStake: config.stake,
    message:
      `${switching ? "🔁 Deployed" : "🔒 Locked"} on ${config.displayName} · ${shotPlanLabel(config.contracts)} · ${spec.label}. ` +
      `${switching ? "The AI may rotate markets to chase the strongest setup." : "The market will not change."} ` +
      `No trade on deploy — the bot holds until health, edge, shield and tick all agree.`,
  };

  logger.info({
    symbol: config.symbol,
    contracts: shotPlanLabel(config.contracts),
    certainty: config.certainty,
    marketMode: config.marketMode,
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

  // ── WHAT IS ACTIVE ─────────────────────────────────────────────────────────
  // The PLAN (the user's set of contracts) and the market it starts on. In
  // locked mode the market never moves — the one rule this bot is known for. In
  // switching mode, and only because the user allowed it, the market may rotate
  // to chase the strongest setup. Either way, an AI Matches/Differs re-resolves
  // its digit LIVE. The per-contract rule, timing and execution are the SAME
  // primitives the scan measured; only the selection layer is new.
  const SPEC = certaintySpec(config.certainty);
  const ANCHOR: ShotContract = planAnchor(config.contracts);
  const ANCHOR_WINSET = shotWinSet(ANCHOR);
  const ANCHOR_BREAK_EVEN = 1 / shotPayout(ANCHOR);
  const SWITCHING = config.marketMode === "switching";
  const PLAN_LABEL = shotPlanLabel(config.contracts);

  let activeSymbol: string = config.symbol;
  let activeName: string = config.displayName;
  let legs: ActiveLeg[] = buildLegs(config.contracts, config.cards);

  let timingWaitTicks = 0;
  let ticksSinceLastShot = Number.POSITIVE_INFINITY;
  let ticksSinceLoss = Number.POSITIVE_INFINITY;
  let lossRun = 0;
  let lastDigitCount = 0;
  let rebaseline = false;
  let lastReadAt = 0;
  let lastReanalyzeAt = Date.now();
  // The live read is always the SERVER's own, never the client's copy of the
  // scan: the first pass through the loop re-evaluates the market before
  // anything can fire. The posted analysis is display material only.
  let cachedRead: KillShotCandidate | null = null;
  let healthEvals = 0;
  let consecutiveErrors = 0;

  const REANALYZE_MS = 30_000; // switching re-measure cadence
  const SWITCH_MARGIN = 0.01;  // $/base edge advantage that justifies rotating

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

      // ── SWITCHING: re-measure the plan and rotate to a clearly better market ─
      // A rotation is a fresh, honest measurement of the whole plan (not a drift
      // of a stale rule). It only moves to a market that is clearly better on
      // out-of-sample edge, or when the current market's edge has gone negative.
      if (SWITCHING && Date.now() - lastReanalyzeAt >= REANALYZE_MS) {
        lastReanalyzeAt = Date.now();
        try {
          const re = await measurePlanMarkets(undefined, config.contracts, config.certainty, {
            stake: config.stake,
            markupPercent: botRecoveryMarkup,
            maxStake,
            stopLoss: config.stopLoss,
          }, false);
          const target = re.best;
          if (target) {
            const targetMkt = re.markets.find(m => m.symbol === target.symbol);
            const activeMkt = re.markets.find(m => m.symbol === activeSymbol);
            const activeEdge = activeMkt?.edgePerDollar ?? Number.NEGATIVE_INFINITY;
            const shouldRotate = target.symbol !== activeSymbol &&
              (target.edgePerDollar - activeEdge > SWITCH_MARGIN || activeEdge <= 0);
            if (shouldRotate && targetMkt && Object.keys(targetMkt.cards).length > 0) {
              activeSymbol = targetMkt.symbol;
              activeName = targetMkt.displayName;
              legs = buildLegs(config.contracts, targetMkt.cards);
              session.currentMarket = targetMkt.displayName;
              session.message = `🔁 Rotated to ${targetMkt.displayName} — chasing the strongest setup (${(target.edgePerDollar * 100).toFixed(2)}% per $1).`;
              healthEvals = 0;
              cachedRead = null;
              lastReadAt = 0;
              rebaseline = true;
              broadcast();
            }
          }
        } catch { /* rotation is best-effort; the session keeps the current market */ }
      }

      // ── Tick accounting ────────────────────────────────────────────────────
      const digits = await getDeepDigits(activeSymbol, SCAN_WINDOW);
      if (rebaseline || digits.length !== lastDigitCount) {
        if (!rebaseline && digits.length > lastDigitCount) {
          const delta = digits.length - lastDigitCount;
          session.watch.ticksWatched += delta;
          if (Number.isFinite(ticksSinceLastShot)) ticksSinceLastShot += delta;
          if (Number.isFinite(ticksSinceLoss)) ticksSinceLoss += delta;
        }
        lastDigitCount = digits.length;
        rebaseline = false;
      }

      // ── GATE 1: HEALTH — is this still the market that was analysed? ───────
      // Pinned to the plan's ANCHOR contract: the market moved away from the
      // regime it was measured in when the anchor's realised win rate falls (a
      // Page–Hinkley regime break) or its live expectancy turns clearly negative.
      if (Date.now() - lastReadAt >= REREAD_INTERVAL_MS) {
        lastReadAt = Date.now();
        const read = evaluateCandidate(activeSymbol, activeName, digits, ANCHOR, {
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
        const wins = digits.slice(-HEALTH_WINDOW).map(d => (ANCHOR_WINSET.has(d) ? 1 : 0));
        const ph = pageHinkley(wins);

        const test = cachedRead?.walk.test;
        const measurable = (test?.nShots ?? 0) >= 8;
        const expectancyGone = measurable
          && (cachedRead?.edgePerDollar ?? 0) < 0
          && (test?.winRateLower ?? 0) < ANCHOR_BREAK_EVEN - SPEC.shortfallTolerance;
        const degraded = ph.fired || expectancyGone;
        healthEvals = degraded ? healthEvals + 1 : 0;
        const alerting = healthEvals >= RESCAN_ALERT_EVALS;
        session.watch.health = {
          ph: ph.ph,
          threshold: ph.threshold,
          fired: ph.fired,
          consecutive: healthEvals,
          needsRescan: alerting,
          note: ph.fired
            ? `Realised win rate on ${activeName} has fallen away from its baseline (Page–Hinkley ${ph.ph.toFixed(1)}/${ph.threshold} over the last ${Math.min(HEALTH_WINDOW, digits.length)} ticks).`
            : expectancyGone
              ? `The market's live re-measurement has turned negative: ${test!.nShots} shots at ${(test!.winRate * 100).toFixed(1)}% (floor ${(test!.winRateLower * 100).toFixed(1)}%) against a ${(ANCHOR_BREAK_EVEN * 100).toFixed(1)}% break-even.`
              : "",
        };
        // Locked: the market is held and the user is TOLD, then the session ends.
        // Switching: the rotation above already handles a better market, so a
        // drift here is surfaced but never hard-stops the session.
        if (!SWITCHING) session.needsRescan = alerting;
      }

      if (!cachedRead) {
        session.watch.phase = "watching";
        session.message = `Building history on ${activeName} — ${digits.length}/${MIN_HISTORY} digits before the plan can be re-checked.`;
        broadcast();
        await sleep(1500);
        continue;
      }

      // ── THE RESCAN ALERT (locked mode only) ────────────────────────────────
      if (!SWITCHING && session.watch.health.needsRescan) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        if (healthEvals >= RESCAN_HALT_EVALS) {
          session.running = false;
          session.needsRescan = true;
          session.message =
            `🛑 RESCAN REQUIRED — ${activeName} is no longer the market this session was locked to. ` +
            `${session.watch.health.note} The lock is never moved silently, so the session has ended: re-run the analysis to pick a fresh market.`;
          broadcast();
          return;
        }
        session.message =
          `⚠️ RESCAN REQUIRED — holding fire on ${activeName}. ${session.watch.health.note} ` +
          `No market switching: stop and re-analyse, or wait — if the market recovers the bot resumes on its own (${healthEvals}/${RESCAN_HALT_EVALS}).`;
        broadcast();
        await sleep(2000);
        continue;
      }

      // NOTE ON WHAT IS *NOT* A GATE HERE.
      //
      // The live re-read's verdict is displayed, never re-imposed. Certification
      // is a DEPLOYMENT decision the user already made on measured evidence; if
      // it were re-run as a live gate, every marginal market would spend its life
      // flickering across the bar. What the re-read is for is detecting that the
      // market has CHANGED (handled above), and everything else is left to the
      // measured rule: the edge bar, the post-loss shield and the tick.

      // ── GATE 2 + 3: EDGE + SHIELD — pick the strongest ready setup ─────────
      // Every contract in the plan (every digit for an AI Matches/Differs) is
      // measured with its OWN frozen card and the SAME post-loss shield. The bot
      // fires the single strongest ready setup — so it trades BETWEEN the
      // user's contracts, and an AI digit re-resolves live, tick by tick.
      const barBoost = Math.min(
        MAX_BAR_BOOST,
        SPEC.postLossTightening * (lossRun + (inRecovery ? 1 : 0)),
      );
      let lead: { ac: ActiveContract; entry: LiveEntry } | null = null;
      let ready: { ac: ActiveContract; entry: LiveEntry } | null = null;
      for (const leg of legs) {
        for (const ac of leg.contracts) {
          const e = evaluateLiveEntry(digits, shotWinSet(ac.contract), ac.card, { barBoost, ticksSinceLoss });
          if (!lead || e.marginZ > lead.entry.marginZ) lead = { ac, entry: e };
          if (e.ready && (!ready || e.marginZ > ready.entry.marginZ)) ready = { ac, entry: e };
        }
      }
      if (lead) {
        session.watch.p = lead.entry.p;
        session.watch.z = lead.entry.z;
        session.watch.edgeZ = lead.entry.edgeZ;
        session.watch.bar = lead.entry.bar;
        session.watch.tau = lead.entry.tau;
        session.watch.marginZ = lead.entry.marginZ;
        session.watch.leader = lead.entry.leader;
        session.watch.contextOrder = lead.entry.contextOrder;
        session.watch.contextCount = lead.entry.contextCount;
        session.watch.regimeHot = lead.entry.regimeHot;
        session.watch.experts = lead.entry.experts;
      }
      session.watch.shield = {
        lossRun,
        barBoost: Math.round(barBoost * 100) / 100,
        ticksSinceLoss: Number.isFinite(ticksSinceLoss) ? ticksSinceLoss : 999,
        coolTicks: SPEC.postLossCoolTicks,
        active: barBoost > 0,
      };
      session.currentContractType = lead ? shotLabel(lead.ac.contract) : PLAN_LABEL;

      if (!ready) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        session.watch.entry = {
          ready: false, score: 0, waitTicks: 0, reason: lead?.entry.reason ?? "measuring the plan",
          momentumPP: 0, gapRatio: 0, preferredState: "none", stateEdgePP: 0,
        };
        session.watch.setupsRejected++;
        session.message = inRecovery
          ? `🎯 Recovery armed — waiting for a qualifying edge. ${lead?.entry.reason ?? ""}`
          : `👁 Watching ${activeName} · live read ${cachedRead.verdict.toUpperCase()} ${cachedRead.confidence}/100 · ${lead?.entry.reason ?? "measuring"}`;
        broadcast();
        await sleep(900);
        continue;
      }
      const FIRE = ready.ac;
      const entry = ready.entry;

      // ── GATE 4: is THIS the tick? (for the chosen contract) ────────────────
      session.watch.phase = "armed";
      const FIRE_WINSET = shotWinSet(FIRE.contract);
      const timing = evaluateTiming({
        digits,
        winSet: FIRE_WINSET,
        secondsSinceLastTick: tickManager.getTickAgeSeconds(activeSymbol),
        medianTickGapSeconds: activeSymbol.startsWith("1HZ") ? 1 : 2,
        ticksSinceLastShot,
        waitedTicks: timingWaitTicks,
        minSpacing: FIRE.card.minSpacing,
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
          : `⏳ Armed on ${activeName} · ${shotLabel(FIRE.contract)} · edge ${entry.z.toFixed(2)}σ vs ${entry.bar.toFixed(2)}σ bar — ${timing.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }
      timingWaitTicks = 0;
      broadcast();

      // Lock integrity — re-asserted immediately before every buy: the market
      // must still be tradeable, and the chosen contract must be one the user
      // actually put in the plan (a resolved AI digit belongs to its plan entry).
      const inPlan = config.contracts.some(c =>
        c.kind === FIRE.contract.kind && (c.digit === undefined || c.digit === FIRE.contract.digit));
      if (!isAutomatedMarket(activeSymbol) || !inPlan) {
        session.running = false;
        session.message = "⚠️ Lock integrity check failed — session halted before firing";
        logger.error({ activeSymbol, fire: FIRE.contract, config }, "Kill-Shot lock violation");
        broadcast();
        return;
      }

      const FIRE_TYPE = KILLSHOT_CONTRACT_TYPE[FIRE.contract.kind];
      const barrier = FIRE.contract.kind === "even" || FIRE.contract.kind === "odd"
        ? undefined
        : FIRE.contract.digit;

      const payoutQuote = await resolveRecoveryPayout({
        symbol: activeSymbol,
        contractType: FIRE_TYPE,
        barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      const payout = payoutQuote.payoutMultiplier || shotPayout(FIRE.contract);

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
      session.currentMarket = activeName;
      session.currentContractType = shotLabel(FIRE.contract);
      session.message = inRecovery
        ? `🎯 KILL SHOT [Recovery R${sharedStep}] ${shotLabel(FIRE.contract)} on ${activeName} · $${stake.toFixed(2)} · edge ${entry.z.toFixed(2)}σ · P ${(entry.p * 100).toFixed(1)}%`
        : `🎯 KILL SHOT ${shotLabel(FIRE.contract)} on ${activeName} · $${stake.toFixed(2)} · edge ${entry.z.toFixed(2)}σ vs ${entry.bar.toFixed(2)}σ bar · P ${(entry.p * 100).toFixed(1)}%`;
      broadcast();

      const reason = `[${BOT_NAME}${inRecovery ? " RECOVERY" : ""}] ${shotLabel(FIRE.contract)} on ${activeName} · ` +
        `${SPEC.label} · ${SWITCHING ? "switching" : "locked"} · live read ${cachedRead.verdict} ${cachedRead.confidence}/100 · ` +
        `edge ${entry.z.toFixed(2)}σ vs bar ${entry.bar.toFixed(2)}σ (τ ${entry.tau.toFixed(2)}, boost ${barBoost.toFixed(2)}) · ` +
        `P(win|context) ${(entry.p * 100).toFixed(1)}% from ${entry.leader} (order ${entry.contextOrder}, n ${entry.contextCount}), regime hot ${(entry.regimeHot * 100).toFixed(0)}% · ` +
        `plan ${PLAN_LABEL} · out-of-sample rule: ${cachedRead.walk.test.nShots} shots at ${(cachedRead.walk.test.winRate * 100).toFixed(1)}% on ${cachedRead.walk.testTicks} unseen ticks, e-value ${cachedRead.walk.test.evidence.peak.toFixed(1)} · ` +
        `ladder safety ${(cachedRead.ladder.safety * 100).toFixed(1)}% (limit ${cachedRead.ladder.limit}) · ` +
        `entry ${timing.score}/100 (${timing.components.preferredState === "none" ? "state neutral" : timing.components.preferredState}, renewal ${timing.components.gapRatio.toFixed(2)}×) · ` +
        `watched ${session.watch.ticksWatched} ticks, declined ${session.watch.setupsRejected} setups`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: activeSymbol,
        displayName: activeName,
        contractType: FIRE_TYPE,
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
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: activeSymbol,
            contractType: FIRE_TYPE,
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
        const before = tickManager.getDigits(activeSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const d = tickManager.getDigits(activeSymbol, 1)[0];
          if (d !== undefined && d !== before) { digit = d; break; }
          digit = d;
        }
        const d = digit ?? 0;
        won = FIRE_WINSET.has(d);
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
      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, FIRE_TYPE, payout);

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
      // shot clock. Only the evidence is discarded — the plan and the market stay.
      session.watch = {
        ...freshWatch(),
        ticksWatched: session.watch.ticksWatched,
        setupsRejected: session.watch.setupsRejected,
        confidence: cachedRead.confidence,
        verdict: cachedRead.verdict,
        tau: entry.tau,
        health: session.watch.health,
      };
      ticksSinceLastShot = 0;
      timingWaitTicks = 0;
      lastReadAt = 0; // force a fresh market read before the next shot
      session.message = won
        ? `✅ ${shotLabel(FIRE.contract)} landed — +$${profit.toFixed(2)}. ${session.winCount}/${session.tradeCount} this session, deepest loss run ${session.deepestLossRun}. Back to watching.`
        : `❌ ${shotLabel(FIRE.contract)} missed — −$${Math.abs(profit).toFixed(2)} (run ${session.currentLossRun}/${cachedRead.ladder.limit}). ` +
          `Post-loss shield engaged: bar +${(SPEC.postLossTightening * lossRun).toFixed(2)}σ and a ${SPEC.postLossCoolTicks}-tick cool-down before the next shot is even considered.`;
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
      logger.error({ err, consecutiveErrors }, "Kill-Shot stability catch — keeping the session alive");
      // Never self-stop on transient errors — the session only stops on TP,
      // SL, or a manual stop. Back off (capped) and keep retrying.
      session.message = `Engine stabilizing… retry ${consecutiveErrors} — the session will keep running`;
      broadcast();
      await sleep(Math.min(15000, 600 * consecutiveErrors));
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
