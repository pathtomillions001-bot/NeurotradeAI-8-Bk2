/**
 * MATCH PRISM ENGINE — the Matches-only console that refuses what it cannot prove.
 *
 * The analysis module (`match-prism-analysis.ts`) owns every statistical claim.
 * This module owns the SESSION: scanning the universe, locking a market, waiting
 * for the gates, buying exactly one contract type, recording the outcome into the
 * shared recovery ledger, and reporting all of it to the console.
 *
 * Invariants it inherits from every other bot in this repo — deliberately, because
 * they are what makes the engines composable:
 *
 *   · ONE EXECUTOR — `engine-arbiter` ownership is acquired on start and checked
 *     before every single shot. Only one engine may own the shared ledger.
 *   · ONE RECOVERY LEDGER — the shared, DB-persisted, debt-driven ladder. The
 *     stake path is `recoveryEngine.getBotRecoveryStake` (debt × (1+markup) /
 *     (payout−1), capped by max stake and balance) and the outcome path is
 *     `recoveryEngine.recordOutcome`. Nothing private, nothing re-derived — which
 *     is exactly why the ladder the scan prices is the ladder the bot runs.
 *   · CONTRACT SOVEREIGNTY — Matches only. Re-asserted immediately before every
 *     buy, so neither a stale card nor a bug can make this bot buy a Differ.
 *   · NEVER SELF-STOP ON A TRANSIENT ERROR — the session ends on take profit,
 *     stop loss, or the user's stop. A flaky socket is a message, not an exit.
 *   · SESSION SCOPE — the whole loop is pinned with `runWithSession`, and the
 *     engine publishes itself to the cross-session live registry so a bot started
 *     in one tab is visible from any other.
 *
 * The one thing that is uniquely Prism: after a loss it does NOT immediately
 * re-enter and it does NOT widen its target. It re-reads the four proofs, adds the
 * shield to the bar, and — critically — re-checks the digit's pessimistic rate
 * against what the user's own ladder now needs, because the debt changed the
 * stakes the ladder will place.
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
import { getBrowserSessionId, runWithSession } from "./session";
import {
  PRISM_BOT_ID,
  PRISM_BOT_NAME,
  PRISM_CONTRACT_TYPE,
  PRISM_LIVE_WINDOW,
  PRISM_MIN_HISTORY,
  PRISM_SCAN_WINDOW,
  evaluatePrismCandidate,
  evaluatePrismLiveEntry,
  memorylessnessTest,
  preScreenPrismCandidates,
  prismCertaintySpec,
  prismTiming,
  requiredWinRateFor,
  screenPrismCandidates,
  transitionTable,
  type PrismCandidate,
  type PrismCertainty,
  type PrismLadderPlan,
  type PrismVerdict,
} from "./match-prism-analysis";
import { MATCH_PAYOUT } from "./payouts";

// ── Identity ──────────────────────────────────────────────────────────────────

export type { PrismCertainty } from "./match-prism-analysis";

export const MATCH_PRISM_BOT_ID = PRISM_BOT_ID;
export const MATCH_PRISM_BOT_NAME = PRISM_BOT_NAME;

/** How long a locked market runs before Prism re-reads its own proofs. */
const REANALYZE_LOCKED_MS = 20_000;
/** Switching mode re-measures the universe less often (it is much more work). */
const REANALYZE_SWITCHING_MS = 60_000;
/** A rival market must beat the incumbent by this much E[dollars/shot] to rotate. */
const SWITCH_MARGIN = 0.02;
/** Digits considered per market in the refinement pass. */
const REFINE_DIGITS_PER_MARKET = 2;
/** Candidates that pay for Monte Carlo + a full walk-forward. */
const REFINE_LIMIT = 14;
const HEALTH_WINDOW = 1_500;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PrismDeploySpec {
  botId: string;
  /** A digit the user locked, or undefined to let Prism choose. */
  digit?: number;
  aiDigit: boolean;
  certainty: PrismCertainty;
}

/**
 * The frozen measurement that authorises a deployment. Shaped so the console can
 * print every number the decision was made on — and so `startSession` can refuse
 * a session that has no measured card at all.
 */
export interface PrismModelCard {
  symbol: string;
  displayName: string;
  digit: number;
  hurdle: number;
  /** Fitted Dirichlet concentration. */
  alphaHat: number;
  /** P(market's digit distribution is not uniform | data). */
  pBiased: number;
  deltaBic: number;
  hasMemory: boolean;
  memoryless: boolean;
  hazardDirection: "rising" | "falling" | "flat";
  medianGap: number;
  /** The frozen live-entry threshold. */
  tau: number;
  pClear: number;
  pLower: number;
  requiredWinRate: number;
  ladderClearPessimistic: number;
  ladderDepth: number;
  oosShots: number;
  oosWinRate: number;
  oosWinRateLower: number;
  inSampleWinRate: number;
  certainty: PrismCertainty;
  plan: PrismLadderPlan;
  verdict: PrismVerdict;
  confidence: number;
}

export interface PrismConfig {
  ownerSessionId?: string;
  botId: string;
  spec: PrismDeploySpec;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  symbol: string;
  displayName: string;
  digit: number;
  card: PrismModelCard;
  /** The scan candidate that produced the card, for the console. */
  analysis?: PrismCandidate;
}

export interface PrismDeployed {
  symbol: string;
  displayName: string;
  contract: string;
  digit: number;
  hurdle: number;
  breakEven: number;
  pClear: number;
  pLower: number;
  requiredWinRate: number;
  ladderClearPessimistic: number;
  ladderDepth: number;
  oosShots: number;
  oosWinRate: number;
  oosWinRateLower: number;
  inSampleWinRate: number;
  pBiased: number;
  bayesFactor: number;
  deltaBic: number;
  hasMemory: boolean;
  memoryless: boolean;
  hazardDirection: "rising" | "falling" | "flat";
  memoryVerdict: string;
  certainty: PrismCertainty;
  verdict: PrismVerdict;
  confidence: number;
  marketMode: "locked" | "switching";
  tau: number;
}

export interface PrismWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  digit: number;
  p: number;
  pClear: number;
  bar: number;
  reason: string;
  switched: boolean;
  confidence: number;
  verdict: string;
  ticksWatched: number;
  memoryWeight: number;
  memoryless: boolean;
  renewalMode: "ignored" | "wait-for-overdue" | "enter-while-fresh";
  gap: number;
  ladderClear: number;
  requiredWinRate: number;
}

export interface PrismStatus {
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
  recoveryTargetProfit: number;
  recoveryRemainingTargetProfit: number;
  consecutiveRecoveryLosses: number;
  currentLossRun: number;
  deepestLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: {
    spec: PrismDeploySpec;
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    marketMode: "locked" | "switching";
    lockedSymbol?: string;
  };
  deployed?: PrismDeployed;
  prismWatch: PrismWatch;
}

export interface PrismScanResult {
  suitable: boolean;
  best: PrismCandidate | null;
  bestAvailable: PrismCandidate | null;
  allScored: PrismCandidate[];
  reason: string;
  certainty: PrismCertainty;
  marketsScanned: number;
  historyDepth: number;
  /** The universe screen, so the console can explain a refusal honestly. */
  universe: {
    candidatesScreened: number;
    candidatesRefined: number;
    pBiasedMax: number;
    alphaHat: number;
    requiredWinRate: number;
    deepHistoryDegraded: boolean;
    /** One-line honest diagnosis of the whole scan. */
    summary: string;
    /**
     * What the user's own ladder demands of a digit, in plain words. This is a
     * property of the PLAN (stake, stop loss, steps, markup), not of any market,
     * which is exactly why it is quoted once — and why a small stop loss can
     * make a market unbeatable at any win rate.
     */
    ladderSummary: string;
  };
  plan: PrismLadderPlan;
}

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  stopRequested: boolean;
  sessionId: string | null;
  config: PrismConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  currentMarket: string;
  currentContractType: string;
  lastResult?: "won" | "lost";
  message: string;
  currentLossRun: number;
  deepestLossRun: number;
  activeSymbol: string;
  activeName: string;
  activeDigit: number;
  activeCard: PrismModelCard | null;
  activeRead: PrismCandidate | null;
  watch: PrismWatch;
}

function freshWatch(): PrismWatch {
  return {
    phase: "watching",
    digit: -1,
    p: 0,
    pClear: 0,
    bar: 0,
    reason: "booting",
    switched: false,
    confidence: 0,
    verdict: "—",
    ticksWatched: 0,
    memoryWeight: 0,
    memoryless: true,
    renewalMode: "ignored",
    gap: 0,
    ladderClear: 0,
    requiredWinRate: 0,
  };
}

function freshSession(): SessionState {
  return {
    running: false,
    stopRequested: false,
    sessionId: null,
    config: null,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    currentStake: 0,
    currentMarket: "",
    currentContractType: "Matches",
    message: "Match Prism is ready",
    currentLossRun: 0,
    deepestLossRun: 0,
    activeSymbol: "",
    activeName: "",
    activeDigit: -1,
    activeCard: null,
    activeRead: null,
    watch: freshWatch(),
  };
}

let session: SessionState = freshSession();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function broadcast() {
  broadcastSSE("bot_update", getStatus(), session.config?.ownerSessionId);
}

function deployed(card: PrismModelCard | null, read: PrismCandidate | null): PrismDeployed | undefined {
  if (!card) return undefined;
  return {
    symbol: card.symbol,
    displayName: card.displayName,
    contract: "DIGITMATCH",
    digit: card.digit,
    hurdle: card.hurdle,
    breakEven: card.hurdle,
    pClear: card.pClear,
    pLower: card.pLower,
    requiredWinRate: card.requiredWinRate,
    ladderClearPessimistic: card.ladderClearPessimistic,
    ladderDepth: card.ladderDepth,
    oosShots: card.oosShots,
    oosWinRate: card.oosWinRate,
    oosWinRateLower: card.oosWinRateLower,
    inSampleWinRate: card.inSampleWinRate,
    pBiased: card.pBiased,
    bayesFactor: read?.bayesFactor ?? 0,
    deltaBic: card.deltaBic,
    hasMemory: card.hasMemory,
    memoryless: card.memoryless,
    hazardDirection: card.hazardDirection,
    memoryVerdict: read?.memoryVerdict ?? "",
    certainty: card.certainty,
    verdict: card.verdict,
    confidence: card.confidence,
    marketMode: session.config?.marketMode ?? "locked",
    tau: card.tau,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): PrismStatus {
  const cfg = session.config;
  return {
    running: session.running,
    botId: MATCH_PRISM_BOT_ID,
    botName: MATCH_PRISM_BOT_NAME,
    sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    currentStake: session.currentStake,
    inRecovery: recoveryEngine.isInRecovery(),
    recoveryStep: recoveryEngine.getState().recoveryStep,
    unrecoveredAmount: recoveryEngine.getState().unrecoveredAmount,
    recoveryTargetProfit: recoveryEngine.getState().targetProfit,
    recoveryRemainingTargetProfit: recoveryEngine.getState().remainingTargetProfit,
    consecutiveRecoveryLosses: recoveryEngine.getState().consecutiveMatchLosses,
    currentLossRun: session.currentLossRun,
    deepestLossRun: session.deepestLossRun,
    currentMarket: session.currentMarket || undefined,
    currentContractType: session.currentContractType || undefined,
    lastResult: session.lastResult,
    message: session.message,
    config: cfg
      ? {
          spec: cfg.spec,
          stake: cfg.stake,
          stopLoss: cfg.stopLoss,
          takeProfit: cfg.takeProfit,
          maxRecoverySteps: cfg.maxRecoverySteps,
          marketMode: cfg.marketMode,
          lockedSymbol: cfg.lockedSymbol,
        }
      : undefined,
    deployed: session.running ? deployed(session.activeCard, session.activeRead) : undefined,
    prismWatch: { ...session.watch },
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info({ botId: session.config?.botId }, "Match Prism session stopped");
}

// ── Pre-deploy scan ───────────────────────────────────────────────────────────

/**
 * Measure the whole universe, cheapest-first.
 *
 * Pass 1 screens every (market × digit) candidate in closed form — no Monte
 * Carlo, no walk-forward, no ladder DP — which is what makes a 190-candidate
 * scan finish in seconds. Pass 2 spends the expensive estimators on the handful
 * that could plausibly pass the real gate.
 *
 * The ladder requirement is computed ONCE, from the user's own plan, because it
 * is a property of the plan rather than of any market: "for this stop loss and
 * this stake, the digit must truly win at least X%".
 */
export async function scanForPrism(
  ownerSessionId: string | undefined,
  spec: PrismDeploySpec,
  risk: { stake: number; stopLoss: number; takeProfit: number; maxStake: number; markupPercent: number; balance: number; maxSteps?: number },
): Promise<PrismScanResult> {
  const certain = prismCertaintySpec(spec.certainty);
  const plan: PrismLadderPlan = {
    baseStake: risk.stake,
    maxStake: risk.maxStake,
    maxSteps: Math.max(1, Math.min(10, Math.round(risk.maxSteps ?? 3))),
    stopLoss: risk.stopLoss,
    takeProfit: risk.takeProfit,
    payout: MATCH_PAYOUT,
    markupPercent: risk.markupPercent,
    balance: risk.balance,
  };

  const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
  const loaded: Array<{ symbol: string; displayName: string; digits: number[] }> = [];
  let deepest = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", {
      botId: spec.botId,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned: i,
      total: markets.length,
    }, ownerSessionId);

    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, PRISM_SCAN_WINDOW);
    } catch {
      digits = tickManager.getDigits(market.symbol, PRISM_SCAN_WINDOW);
    }
    deepest = Math.max(deepest, digits.length);
    loaded.push({ symbol: market.symbol, displayName: market.displayName, digits });
    await sleep(5);
  }

  broadcastSSE("bot_scan_progress", {
    botId: spec.botId, scanning: null, symbol: null, scanned: markets.length, total: markets.length,
  }, ownerSessionId);

  // ── Pass 1: the cheap closed-form screen over the WHOLE family ────────────
  // A locked digit narrows the family to one hypothesis per market: that is the
  // whole point of locking it, and it means a locked scan is 10× cheaper.
  const screenMarkets = spec.aiDigit || spec.digit === undefined
    ? loaded
    : loaded.map((m) => ({ ...m, digits: m.digits }));
  const screen = preScreenPrismCandidates({ markets: screenMarkets, plan, certainty: spec.certainty });

  const screened = spec.aiDigit || spec.digit === undefined
    ? screen.screened
    : screen.screened.filter((c) => c.digit === spec.digit);

  if (screen.historyDepth < PRISM_MIN_HISTORY) {
    return {
      suitable: false,
      best: null,
      bestAvailable: null,
      allScored: [],
      certainty: spec.certainty,
      marketsScanned: markets.length,
      historyDepth: screen.historyDepth,
      reason:
        `Not enough digit history yet — the deepest market has ${screen.historyDepth} digits and ${PRISM_MIN_HISTORY} are needed. ` +
        `Prism will not guess from a short tape; the tick feed is still warming up.`,
      universe: {
        candidatesScreened: screen.screened.length,
        candidatesRefined: 0,
        pBiasedMax: screen.pBiasedMax,
        alphaHat: screen.alphaHat,
        requiredWinRate: 0,
        deepHistoryDegraded: deepHistoryDegraded(),
        summary: `Only ${screen.historyDepth} digits available — measurement deferred rather than faked.`,
        ladderSummary: `A $${plan.baseStake} stake with a $${plan.stopLoss} stop loss could not be priced — there was nothing to measure yet.`,
      },
      plan,
    };
  }

  // ── Pass 2: the expensive estimators on the candidates worth measuring ────
  const byMarket = new Map<string, typeof screened>();
  for (const cand of screened) {
    const list = byMarket.get(cand.symbol) ?? [];
    list.push(cand);
    byMarket.set(cand.symbol, list);
  }
  const refinedKeys: Array<{ symbol: string; digit: number }> = [];
  for (const [, list] of byMarket) {
    for (const cand of list.slice(0, REFINE_DIGITS_PER_MARKET)) {
      refinedKeys.push({ symbol: cand.symbol, digit: cand.digit });
      if (refinedKeys.length >= REFINE_LIMIT) break;
    }
    if (refinedKeys.length >= REFINE_LIMIT) break;
  }

  const requiredWinRate = requiredWinRateFor(plan, certain.minLadderClearance);
  const breakEven = 1 / MATCH_PAYOUT;
  // The honest framing of the same number: the stop loss, not the market, sets
  // the bar when the bar sits above break-even.
  const ladderSummary = requiredWinRate >= breakEven
    ? `Your ladder demands a digit that truly wins ${(requiredWinRate * 100).toFixed(2)}% of the time to clear the debt within a $${plan.stopLoss} stop loss on a $${plan.baseStake} stake (95% of the time). Break-even at 8.93× is ${(breakEven * 100).toFixed(2)}% — the stop loss is the binding constraint here, so widening it is what makes Matches playable.`
    : `Your ladder is cheaper than the payout: a $${plan.stopLoss} stop loss on a $${plan.baseStake} stake clears at any digit above ${(requiredWinRate * 100).toFixed(2)}%, which is BELOW the ${(breakEven * 100).toFixed(2)}% break-even. The payout is the binding constraint, so the proof gate is what protects you here.`;

  const evaluated: PrismCandidate[] = [];
  for (let i = 0; i < refinedKeys.length; i++) {
    const key = refinedKeys[i]!;
    const market = loaded.find((m) => m.symbol === key.symbol);
    if (!market) continue;
    broadcastSSE("bot_scan_progress", {
      botId: spec.botId,
      scanning: `measuring ${market.displayName} · digit ${key.digit}`,
      symbol: market.symbol,
      scanned: i,
      total: refinedKeys.length,
    }, ownerSessionId);
    const cand = evaluatePrismCandidate(market.symbol, market.displayName, market.digits, key.digit, {
      certainty: spec.certainty,
      plan,
      requiredWinRate,
    });
    if (cand) evaluated.push(cand);
    await sleep(5);
  }

  broadcastSSE("bot_scan_progress", {
    botId: spec.botId, scanning: null, symbol: null, scanned: refinedKeys.length, total: refinedKeys.length,
  }, ownerSessionId);

  const ranked = screenPrismCandidates(evaluated, 0.1);
  const best = ranked[0] ?? null;

  const suitable = best?.deployable === true;
  const reason = best
    ? suitable
      ? `${best.displayName} · digit ${best.digit} — bias proven (P=${(best.pBiased * 100).toFixed(1)}%), ` +
        `out-of-sample ${(best.oosWinRate * 100).toFixed(1)}% over ${best.oosShots} shots vs break-even ${(best.breakEven * 100).toFixed(2)}%, ` +
        `ladder clears ${(best.ladderClearPessimistic * 100).toFixed(1)}% at the pessimistic rate.`
      : `No digit cleared every gate — best was ${best.displayName} · digit ${best.digit}: ${best.failReasons[0] ?? best.verdict}`
    : "No candidate could be measured — the digit feed is too short.";

  // A refusal has to explain itself. The Bayes factor is the number that says
  // whether the universe even CONTAINS an exploitable market, and it is the
  // number users most need to see when Prism declines to trade.
  const summary = screen.pBiasedMax < certain.minBiasedPosterior
    ? `No market's digit stream is distinguishable from uniform (best P(biased)=${(screen.pBiasedMax * 100).toFixed(1)}%, needed ${(certain.minBiasedPosterior * 100).toFixed(0)}%). ` +
      `Trading Matches here is a guaranteed −${((1 - 0.1 * MATCH_PAYOUT) * 100).toFixed(1)}% per shot, so Prism stands down.`
    : `A market shows measurable bias (P=${(screen.pBiasedMax * 100).toFixed(1)}%) but did not clear every gate: ${best?.failReasons[0] ?? "measurement incomplete"}.`;

  return {
    suitable,
    best: best && suitable ? best : null,
    bestAvailable: best,
    allScored: ranked.slice(0, 12),
    reason,
    certainty: spec.certainty,
    marketsScanned: markets.length,
    historyDepth: screen.historyDepth,
    universe: {
      candidatesScreened: screen.screened.length,
      candidatesRefined: evaluated.length,
      pBiasedMax: screen.pBiasedMax,
      alphaHat: screen.alphaHat,
      requiredWinRate,
      deepHistoryDegraded: deepHistoryDegraded(),
      summary,
      ladderSummary,
    },
    plan,
  };
}

// ── Session start ─────────────────────────────────────────────────────────────

export async function startSession(config: PrismConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "Match Prism is already active — stop it first" };

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
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  const market = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === config.symbol);
  if (!market || !market.digitEnabled) return fail("Match Prism needs a digit-enabled market");
  if (!config.card || !Number.isFinite(config.card.tau) || !Number.isFinite(config.card.alphaHat)) {
    return fail("Run the analysis first — Match Prism only deploys a rule it has measured");
  }
  if (config.digit < 0 || config.digit > 9 || !Number.isInteger(config.digit)) {
    return fail("The measured digit is missing — re-run the analysis");
  }
  // CONTRACT SOVEREIGNTY: Prism buys DIGITMATCH and nothing else, ever.
  if (config.card.hurdle <= 0) return fail("The measured model card is incomplete");

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_prism_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    currentContractType: "Matches",
    activeSymbol: config.symbol,
    activeName: config.displayName,
    activeDigit: config.digit,
    activeCard: config.card,
    activeRead: config.analysis ?? null,
    watch: {
      ...freshWatch(),
      digit: config.digit,
      pClear: config.card.pClear,
      bar: config.card.tau,
      ladderClear: config.card.ladderClearPessimistic,
      requiredWinRate: config.card.requiredWinRate,
      memoryless: config.card.memoryless,
      confidence: config.card.confidence,
      verdict: config.card.verdict,
    },
    message: config.marketMode === "locked"
      ? `Locked on ${config.displayName} · digit ${config.digit} — the digit may rotate, the market will not.`
      : `Deployed on ${config.displayName} · digit ${config.digit} — Prism will move if another market proves better.`,
  };

  logger.info({
    botId: config.botId,
    symbol: config.symbol,
    digit: config.digit,
    marketMode: config.marketMode,
    certainty: config.spec.certainty,
    pBiased: config.card.pBiased,
    oosWinRate: config.card.oosWinRate,
    requiredWinRate: config.card.requiredWinRate,
  }, "Match Prism session starting");
  broadcast();

  const loopSessionId = config.ownerSessionId ?? getBrowserSessionId();
  runWithSession(loopSessionId, () =>
    runLoop(config)
      .catch((err) => {
        logger.error({ err }, "Match Prism runLoop error");
        session.running = false;
        session.message = `⚠️ ${friendlyErrorMessage(err)}`;
        broadcast();
      })
      .finally(() => releaseTradingOwnership("bots")),
  );

  return { ok: true };
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: PrismConfig) {
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

  const certain = prismCertaintySpec(config.spec.certainty);
  const LOCKED = config.marketMode === "locked";
  const REANALYZE_MS = LOCKED ? REANALYZE_LOCKED_MS : REANALYZE_SWITCHING_MS;
  const HURDLE = config.card.hurdle > 0 ? config.card.hurdle : 1 / MATCH_PAYOUT;

  let activeSymbol = config.symbol;
  let activeName = config.displayName;
  let activeDigit = config.digit;
  let activeCard = { ...config.card };

  let ticksSinceLastShot = Number.POSITIVE_INFINITY;
  let ticksSinceLoss = Number.POSITIVE_INFINITY;
  let lossRun = 0;
  let timingWaitTicks = 0;
  let lastDigitCount = 0;
  let lastReanalyzeAt = 0;
  let consecutiveErrors = 0;

  const planFor = (): PrismLadderPlan => ({
    baseStake: config.stake,
    maxStake,
    maxSteps: Math.max(1, config.maxRecoverySteps),
    stopLoss: config.stopLoss,
    takeProfit: config.takeProfit,
    payout: MATCH_PAYOUT,
    markupPercent: botRecoveryMarkup,
    balance: Number.isFinite(availableBalance) ? availableBalance : undefined,
  });

  /**
   * Re-measure. In locked mode ONLY the locked market is re-read (the digit may
   * rotate inside it — the market never moves). In switching mode every market is
   * re-screened and a rival must beat the incumbent by SWITCH_MARGIN.
   */
  async function analyzeActive(): Promise<PrismCandidate | null> {
    const markets = LOCKED
      ? AUTOMATED_DERIV_MARKETS.filter((m) => m.symbol === activeSymbol)
      : AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);

    const loaded: Array<{ symbol: string; displayName: string; digits: number[] }> = [];
    for (const market of markets) {
      let digits: number[] = [];
      try {
        digits = await getDeepDigits(market.symbol, PRISM_SCAN_WINDOW);
      } catch {
        digits = tickManager.getDigits(market.symbol, PRISM_SCAN_WINDOW);
      }
      if (digits.length >= PRISM_MIN_HISTORY) {
        loaded.push({ symbol: market.symbol, displayName: market.displayName, digits });
      }
    }
    if (loaded.length === 0) return null;

    const screen = preScreenPrismCandidates({ markets: loaded, plan: planFor(), certainty: config.spec.certainty });
    const wanted = config.spec.aiDigit || config.spec.digit === undefined
      ? screen.screened
      : screen.screened.filter((c) => c.digit === config.spec.digit);

    const seen = new Set<string>();
    const picked = wanted.filter((c) => {
      const key = `${c.symbol}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, REFINE_LIMIT);

    const requiredWinRate = requiredWinRateFor(planFor(), certain.minLadderClearance);
    const evaluated: PrismCandidate[] = [];
    for (const cand of picked) {
      const market = loaded.find((m) => m.symbol === cand.symbol);
      if (!market) continue;
      const full = evaluatePrismCandidate(market.symbol, market.displayName, market.digits, cand.digit, {
        certainty: config.spec.certainty,
        plan: planFor(),
        requiredWinRate,
      });
      if (full) evaluated.push(full);
    }

    const ranked = screenPrismCandidates(evaluated, 0.1).filter((c) => c.deployable);
    if (ranked.length === 0) return null;
    const best = ranked[0]!;
    if (!LOCKED && best.symbol !== activeSymbol) {
      const incumbent = ranked.find((c) => c.symbol === activeSymbol);
      if (incumbent && best.edgePerDollar - incumbent.edgePerDollar < SWITCH_MARGIN) return incumbent;
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

      let digits = await getDeepDigits(activeSymbol, PRISM_SCAN_WINDOW);
      if (digits.length < PRISM_MIN_HISTORY) {
        session.message = `Warming up — ${digits.length}/${PRISM_MIN_HISTORY} digits on ${activeName}`;
        broadcast();
        await sleep(1500);
        continue;
      }
      if (digits.length !== lastDigitCount) {
        const delta = Math.max(0, digits.length - lastDigitCount);
        session.watch.ticksWatched += delta;
        if (Number.isFinite(ticksSinceLastShot)) ticksSinceLastShot += delta;
        if (Number.isFinite(ticksSinceLoss)) ticksSinceLoss += delta;
        lastDigitCount = digits.length;
      }

      // ── Market health → force a re-measure (rotation, never a dead end) ────
      const recent = digits.slice(-HEALTH_WINDOW);
      const recentHits = recent.filter((d) => d === activeDigit).length;
      const recentRate = recent.length > 0 ? recentHits / recent.length : 0;
      if (LOCKED) {
        // A locked market whose own digit has stopped printing is a signal to
        // re-read THIS market (the digit may rotate) — never to leave it.
        if (Date.now() - lastReanalyzeAt >= 0 && recentRate < HURDLE / 2) lastReanalyzeAt = 0;
      }

      const needsReanalyze = activeCard === null || Date.now() - lastReanalyzeAt >= REANALYZE_MS;
      if (needsReanalyze) {
        const pick = await analyzeActive();
        lastReanalyzeAt = Date.now();
        if (pick) {
          const rotated = pick.symbol !== activeSymbol || pick.digit !== activeDigit;
          activeSymbol = pick.symbol;
          activeName = pick.displayName;
          activeDigit = pick.digit;
          activeCard = {
            ...activeCard,
            symbol: pick.symbol,
            displayName: pick.displayName,
            digit: pick.digit,
            alphaHat: pick.alphaHat,
            pBiased: pick.pBiased,
            deltaBic: pick.deltaBic,
            hasMemory: pick.hasMemory,
            memoryless: pick.memoryless,
            hazardDirection: pick.memoryless ? "flat" : activeCard.hazardDirection,
            pClear: pick.pClear,
            pLower: pick.pLower,
            requiredWinRate: pick.requiredWinRate,
            ladderClearPessimistic: pick.ladderClearPessimistic,
            ladderDepth: pick.ladderDepth,
            oosShots: pick.oosShots,
            oosWinRate: pick.oosWinRate,
            oosWinRateLower: pick.oosWinRateLower,
            inSampleWinRate: pick.inSampleWinRate,
            verdict: pick.verdict,
            confidence: pick.confidence,
          };
          session.activeSymbol = pick.symbol;
          session.activeName = pick.displayName;
          session.activeDigit = pick.digit;
          session.activeRead = pick;
          session.currentMarket = pick.displayName;
          session.currentContractType = `Matches · digit ${pick.digit}`;
          session.watch.confidence = pick.confidence;
          session.watch.verdict = pick.verdict;
          session.watch.ladderClear = pick.ladderClearPessimistic;
          session.watch.requiredWinRate = pick.requiredWinRate;
          if (rotated) {
            session.watch.switched = true;
            session.message = LOCKED
              ? `🔁 Digit moved on ${pick.displayName} — now targeting digit ${pick.digit}`
              : `🔁 Rotated to ${pick.displayName} · digit ${pick.digit}`;
          }
          digits = await getDeepDigits(activeSymbol, PRISM_SCAN_WINDOW);
        } else {
          session.watch.phase = "watching";
          session.watch.reason = "no digit currently clears every proof";
          session.message = LOCKED
            ? `Holding on ${activeName} — no digit on it clears every proof right now`
            : `Scanning markets — no market's digit stream is provably biased right now`;
          broadcast();
          await sleep(2000);
          continue;
        }
      }

      // ── The four proofs, re-read on live digits ───────────────────────────
      const window = Math.min(digits.length, PRISM_LIVE_WINDOW);
      const windowDigits = digits.slice(-window);
      const windowCounts = new Array<number>(10).fill(0);
      for (const d of windowDigits) windowCounts[d]! += 1;
      const lastDigit = windowDigits[windowDigits.length - 1] ?? null;

      const table = transitionTable(digits.slice(-Math.max(window, 800)));
      const hasMemory = activeCard.hasMemory;
      const gapTest = memorylessnessTest(digits, activeDigit);

      // Digit-target hysteresis: a rival must beat the held digit by a margin.
      const barBoost = Math.min(
        certain.maxBarBoost,
        certain.shieldTightening * (lossRun + (inRecovery ? 1 : 0)),
      );
      const entry = evaluatePrismLiveEntry({
        counts: windowCounts,
        alpha: activeCard.alphaHat,
        hurdle: HURDLE,
        digits: windowDigits,
        lastDigit,
        transitionRow: hasMemory && lastDigit !== null ? (table[lastDigit] ?? null) : null,
        hasMemory,
        window,
        tau: activeCard.tau,
        barBoost,
        heldDigit: activeDigit,
      });

      session.watch.p = entry.p;
      session.watch.pClear = entry.pClear;
      session.watch.bar = entry.bar;
      session.watch.digit = entry.digit;
      session.watch.memoryWeight = entry.memoryWeight;
      session.watch.memoryless = gapTest.memoryless;

      if (!entry.ready) {
        session.watch.phase = "watching";
        session.watch.reason = `digit ${entry.digit} at ${(entry.pClear * 100).toFixed(2)}% vs bar ${(entry.bar * 100).toFixed(2)}%`;
        session.message = inRecovery
          ? `🎯 Recovery armed — ${session.watch.reason}`
          : `👁 Matches on ${activeName} — ${session.watch.reason}`;
        broadcast();
        await sleep(1200);
        continue;
      }

      // ── Timing: only waits for reasons it can prove ───────────────────────
      session.watch.phase = "armed";
      const lastPos = digits.lastIndexOf(entry.digit);
      const gap = lastPos >= 0 ? digits.length - 1 - lastPos : digits.length;
      session.watch.gap = gap;
      const timing = prismTiming({
        gap,
        ticksSinceLastShot,
        minSpacing: certain.minSpacing,
        secondsSinceLastTick: tickManager.getTickAgeSeconds(activeSymbol),
        medianTickGapSeconds: activeSymbol.startsWith("1HZ") ? 1 : 2,
        memoryless: gapTest.memoryless,
        hazardDirection: gapTest.hazardDirection,
        medianGap: gapTest.medianGap,
      });
      session.watch.renewalMode = timing.renewalMode;
      if (!timing.ready) {
        timingWaitTicks++;
        session.watch.reason = timing.reason;
        session.message = inRecovery
          ? `🎯 Recovery armed — ${timing.reason}`
          : `⏳ Armed on ${activeName} · digit ${entry.digit} — ${timing.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }
      timingWaitTicks = 0;

      // ── CONTRACT SOVEREIGNTY — re-asserted immediately before the buy ─────
      if (!isAutomatedMarket(activeSymbol) || PRISM_CONTRACT_TYPE !== "DIGITMATCH") {
        session.running = false;
        session.message = "⚠️ Contract sovereignty check failed — session halted before firing";
        logger.error({ activeSymbol }, "Match Prism sovereignty violation");
        broadcast();
        return;
      }

      const payoutQuote = await resolveRecoveryPayout({
        symbol: activeSymbol,
        contractType: PRISM_CONTRACT_TYPE,
        barrier: entry.digit,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      const payout = payoutQuote.payoutMultiplier > 1 ? payoutQuote.payoutMultiplier : MATCH_PAYOUT;
      const hurdle = 1 / payout;

      if (inRecovery) {
        try {
          const freshSettings = await db.select().from(settingsTable)
            .where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
          if (freshSettings.length > 0) {
            const v = Number((freshSettings[0] as any).botRecoveryMarkup);
            if (Number.isFinite(v)) botRecoveryMarkup = v;
          }
        } catch { /* keep the previous value */ }
      }

      const plan = planFor();
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(config.stake, plan.maxStake, availableBalance, payout, botRecoveryMarkup)
        : config.stake;

      // ── THE LADDER GATE, re-priced at the rate Prism is about to bet ──────
      // The debt changed the stakes the ladder will place, so the rate this plan
      // needs is re-derived before every recovery shot. This is the check that
      // stops "multiple losses" from becoming an account event.
      if (inRecovery) {
        const neededRate = requiredWinRateFor(plan, certain.minLadderClearance);
        if (entry.p < Math.max(neededRate, hurdle)) {
          session.watch.phase = "watching";
          session.watch.reason =
            `ladder now needs ${(neededRate * 100).toFixed(2)}% but the digit reads ${(entry.p * 100).toFixed(2)}%`;
          session.message = `🛑 Recovery held — ${session.watch.reason}. Not adding to the debt.`;
          broadcast();
          await sleep(1500);
          continue;
        }
      }

      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing";
      session.currentStake = stake;
      session.currentMarket = activeName;
      session.currentContractType = `Matches · digit ${entry.digit}`;
      session.message = inRecovery
        ? `🎯 [Recovery R${sharedStep}] Matches ${entry.digit} on ${activeName} · $${stake.toFixed(2)}`
        : `🎯 Matches ${entry.digit} on ${activeName} · $${stake.toFixed(2)}`;
      broadcast();

      const reason = `[${MATCH_PRISM_BOT_NAME}${inRecovery ? " RECOVERY" : ""}] Matches ${entry.digit} on ${activeName} · ` +
        `bias P=${(activeCard.pBiased * 100).toFixed(1)}% (BF=${(activeCard.pBiased >= 0.999 ? ">1000" : (activeCard.pBiased / Math.max(1e-9, 1 - activeCard.pBiased) * 3).toFixed(1))}:1) · ` +
        `out-of-sample ${(activeCard.oosWinRate * 100).toFixed(1)}% over ${activeCard.oosShots} shots vs break-even ${(hurdle * 100).toFixed(2)}% · ` +
        `ladder clears ${(activeCard.ladderClearPessimistic * 100).toFixed(1)}% and needs ${(activeCard.requiredWinRate * 100).toFixed(2)}% · ` +
        `entry P(rate>hurdle)=${(entry.pClear * 100).toFixed(2)}% vs bar ${(entry.bar * 100).toFixed(2)}% · ` +
        `${gapTest.memoryless ? "gaps memoryless (dormancy ignored)" : `renewal ${gapTest.hazardDirection}`}`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: activeSymbol,
        displayName: activeName,
        contractType: PRISM_CONTRACT_TYPE,
        barrier: entry.digit,
        stake: String(Math.round(stake * 100) / 100),
        direction: "hold",
        status: "open",
        aiConfidence: String(activeCard.confidence),
        aiRiskScore: "15",
        isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`,
        duration: 1,
        durationUnit: "t",
      }).returning();

      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: activeSymbol,
            contractType: PRISM_CONTRACT_TYPE,
            stake: Math.round(stake * 100) / 100,
            duration: 1,
            durationUnit: "t",
            currency,
            accountId: accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            barrier: entry.digit,
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
          logger.warn({ err }, "Match Prism live execution error — returning to the watch");
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
        session.watch.phase = "settling";
        const before = tickManager.getDigits(activeSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const d = tickManager.getDigits(activeSymbol, 1)[0];
          if (d !== undefined && d !== before) { digit = d; break; }
          digit = d;
        }
        const printed = digit ?? 0;
        won = printed === entry.digit;
        profit = won ? stake * (payout - 1) : -stake;
      }

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

      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, PRISM_CONTRACT_TYPE, payout);
      activeDigit = entry.digit;

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
        logger.warn({ dbErr }, "Match Prism: failed to settle the journaled trade");
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

      session.watch = {
        ...freshWatch(),
        ticksWatched: session.watch.ticksWatched,
        confidence: activeCard.confidence,
        verdict: activeCard.verdict,
        ladderClear: activeCard.ladderClearPessimistic,
        requiredWinRate: activeCard.requiredWinRate,
      };
      ticksSinceLastShot = 0;
      timingWaitTicks = 0;
      lastReanalyzeAt = 0; // fresh proofs before the next shot
      session.message = won
        ? `✅ +$${profit.toFixed(2)} · ${session.winCount}/${session.tradeCount} · re-measuring before the next shot`
        : `❌ −$${Math.abs(profit).toFixed(2)} · shield on · ${session.currentLossRun} in a row`;
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

      await sleep(won ? 2000 : 1500);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Match Prism stability catch — keeping the session alive");
      // Never self-stop on a transient error: the session ends on TP, SL or the
      // user's stop, so a flaky socket cannot silently abandon an open ladder.
      session.message = `Engine stabilizing… retry ${consecutiveErrors} — the session will keep running`;
      broadcast();
      await sleep(Math.min(15000, 600 * consecutiveErrors));
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
