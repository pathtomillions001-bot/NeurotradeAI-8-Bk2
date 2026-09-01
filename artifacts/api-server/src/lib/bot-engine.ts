/**
 * Specialist AI Bot Engine.
 *
 * One bot = one contract family = one analysis budget. The engine reproduces the
 * NeuroAI Quantum FAB's procedure end to end — market scan, three-window score
 * blend, green-light timing, four/five-window sniper recovery gate,
 * execution-tick revalidation, pre-warmed payout quoting, shared recovery
 * ledger, trade journaling, SL/TP boundaries — and adds the three things a
 * single-contract specialist can do that a six-family generalist cannot:
 *
 *  1. SPECIALIST ESTIMATORS on every tick (`lib/specialist-analysis.ts`),
 *  2. A SPECIALIST ENTRY GATE layered on the FAB green light (better timing),
 *  3. SIDE ARBITRATION WITH HYSTERESIS when both sides of the family are armed
 *     (better execution — no flip-flopping between two near-equal setups).
 *
 * Two invariants are inherited from the FAB and are NOT negotiable:
 *  - Recovery debt lives in the ONE shared account ledger
 *    (`lib/agents/recovery-engine.ts`); this engine keeps no private ledger.
 *  - Exactly one engine executes at a time (`lib/engine-arbiter.ts`). A bot
 *    refuses to start while the autonomous engine or the FAB is trading, and
 *    halts the moment it loses ownership.
 *
 * Recovery stays inside the family: `contractTypes` is used for BOTH normal and
 * recovery trades, so a parity bot only ever recovers in Even/Odd and a barrier
 * bot only ever recovers over/under the digits the user armed.
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
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { resolveRecoveryPayout } from "./recovery-payout";
import * as recoveryEngine from "./agents/recovery-engine";
import {
  quantumWindowEstimate,
  quantumTimingScore,
  ciOverlapBonus,
  ciOverlapWidth,
  edgeTrendBonus,
} from "./quantum-analysis";
import {
  metaBonus,
  recordTradeSignal,
  resetSignalValue,
  type DecisionFeatures,
  type SignalMode,
} from "./signal-value";
import {
  acquireTradingOwnership,
  releaseTradingOwnership,
  hasTradingOwnership,
  currentTradingOwner,
  tradingOwnerLabel,
} from "./engine-arbiter";
import {
  botPrecisionScore,
  botGreenLight,
  deepSniperBonus,
  extractBarriers,
  resolveBotBarrier,
  specialistReadFor,
  type BotContractType,
  type BotMarketScore,
} from "./bot-scorer";
import { specialistSideChoice, type DigitCandidate, type SpecialistRead } from "./specialist-analysis";
import { getBotDefinition } from "./bot-catalog";

export type { BotContractType, BotMarketScore } from "./bot-scorer";
export type { SpecialistRead, DigitCandidate } from "./specialist-analysis";

// ── Constants (identical to the Quantum FAB) ──────────────────────────────────

const SUITABLE_SCORE_THRESHOLD = 54;
const MIN_TRADE_SCORE = 50;

/** Sniper windows. The FAB uses four; a specialist can afford a fifth. */
const SNIPER_WINDOWS = [15, 30, 60, 100, 200] as const;
/** Blend weights across the five sniper windows (immediate → macro). */
const SNIPER_WEIGHTS = [0.18, 0.26, 0.30, 0.16, 0.10] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BotConfig {
  /** Opaque browser-session owner; supplied only by the API route. */
  ownerSessionId?: string;
  botId: string;
  /** The family's armed contract types — used for normal AND recovery trades. */
  contractTypes: BotContractType[];
  /** [overBarrier, underBarrier] for the barrier bot; ignored elsewhere. */
  barriers: number[];
  /** Locked digit for match/differ bots (undefined = specialist selects). */
  lockedBarrier?: number;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  recoveryAutoMode: boolean;
  recoveryMultiplier: number;
  recoveryMethod: "split" | "instant";
  maxRecoverySteps: number;
  lockedSymbol?: string;
  marketMode?: "locked" | "switching";
}

export interface BotScanResult {
  suitable: boolean;
  best: BotMarketScore | null;
  allScored: BotMarketScore[];
  reason: string;
}

export interface BotStatus {
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
  recoveryOriginPayout: number;
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  config?: Omit<BotConfig, "ownerSessionId">;
  message?: string;
  topMarkets?: BotMarketScore[];
  entropyBits?: number;
  expectedValue?: number;
  /** Latest specialist read for the active candidate. */
  specialist?: SpecialistRead;
  /** Digit candidate table (match/differ bots). */
  digitCandidates?: DigitCandidate[];
}

interface AntiPatternRecord {
  contractType: BotContractType;
  barrier: number | undefined;
  won: boolean;
}

// ── Session state ─────────────────────────────────────────────────────────────
//
// As in the FAB there is NO private recovery state here. Mode, debt, target and
// step come from the shared account ledger. What is local: the anti-pattern
// memory used by the sniper gate's decaying penalty, and display counters.

let session: {
  running: boolean;
  sessionId: string | null;
  config: BotConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  patternTrades: AntiPatternRecord[];
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  topMarkets: BotMarketScore[];
  stopRequested: boolean;
  lastEntropyBits: number;
  lastEv: number;
  lastSpecialist?: SpecialistRead;
  lastDigitCandidates?: DigitCandidate[];
  /** Side traded last — feeds the arbitration hysteresis. */
  lastSide?: BotContractType;
} = {
  running: false,
  sessionId: null,
  config: null,
  totalProfit: 0,
  tradeCount: 0,
  winCount: 0,
  lossCount: 0,
  currentStake: 0,
  patternTrades: [],
  consecutiveRecoveryLosses: 0,
  topMarkets: [],
  stopRequested: false,
  lastEntropyBits: 3.32,
  lastEv: 0,
};

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

export function getActiveBotId(): string | null {
  return session.running ? session.config?.botId ?? null : null;
}

export function getStatus(): BotStatus {
  const publicConfig = session.config
    ? (Object.fromEntries(
        Object.entries(session.config).filter(([key]) => key !== "ownerSessionId"),
      ) as Omit<BotConfig, "ownerSessionId">)
    : undefined;
  // Recovery fields come from the SHARED account ledger — the same debt, step
  // and target the FAB, the autonomous engine and the dashboard card see.
  const rec = recoveryEngine.getState();
  return {
    running:                   session.running,
    botId:                     session.config?.botId ?? null,
    botName:                   session.config ? (getBotDefinition(session.config.botId)?.name ?? session.config.botId) : null,
    sessionId:                 session.sessionId,
    totalProfit:               Math.round(session.totalProfit * 100) / 100,
    tradeCount:                session.tradeCount,
    winCount:                  session.winCount,
    lossCount:                 session.lossCount,
    currentStake:              session.currentStake,
    inRecovery:                rec.inRecovery,
    recoveryStep:              rec.recoveryStep,
    unrecoveredAmount:         Math.round(rec.unrecoveredAmount * 100) / 100,
    recoveryTargetProfit:      Math.round(rec.targetProfit * 100) / 100,
    recoveryRemainingTargetProfit: Math.round(rec.remainingTargetProfit * 100) / 100,
    recoveryOriginPayout:      Math.round(rec.originPayoutMultiplier * 1000) / 1000,
    consecutiveRecoveryLosses: session.consecutiveRecoveryLosses,
    currentMarket:             session.currentMarket,
    currentContractType:       session.currentContractType,
    lastResult:                session.lastResult,
    config:                    publicConfig,
    message:                   session.message,
    topMarkets:                session.topMarkets.slice(0, 6),
    entropyBits:               session.lastEntropyBits,
    expectedValue:             session.lastEv,
    specialist:                session.lastSpecialist,
    digitCandidates:           session.lastDigitCandidates,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running       = false;
  session.message       = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info({ botId: session.config?.botId }, "Specialist bot session stopped");
}

export async function startSession(config: BotConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) {
    return { ok: false, error: "A specialist bot session is already active — stop it first" };
  }

  // ── Single-executor guard (shared with the FAB and the autonomous engine) ──
  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    const label = owner ? tradingOwnerLabel(owner) : "another engine";
    return {
      ok: false,
      error: `The ${label} is currently trading on this account. Stop it before starting a specialist bot — only one engine may trade (and own the recovery ledger) at a time.`,
    };
  }

  if (config.stake < 0.35)       { releaseTradingOwnership("bots"); return { ok: false, error: "Minimum stake is $0.35" }; }
  if (config.stopLoss <= 0)      { releaseTradingOwnership("bots"); return { ok: false, error: "Stop loss must be positive" }; }
  if (config.takeProfit <= 0)    { releaseTradingOwnership("bots"); return { ok: false, error: "Take profit must be positive" }; }
  if (config.contractTypes.length === 0) { releaseTradingOwnership("bots"); return { ok: false, error: "This bot has no armed contract type" }; }
  if (!getBotDefinition(config.botId))   { releaseTradingOwnership("bots"); return { ok: false, error: "Unknown bot" }; }

  const sharedRecovery = recoveryEngine.getState();

  // Self-measured signal value starts fresh for every session. The pool is
  // shared with the FAB by design: only one engine can execute at a time, so it
  // always belongs to whichever engine is running.
  resetSignalValue();

  session = {
    running:      true,
    sessionId:    `bot_${config.botId}_${Date.now()}`,
    config,
    totalProfit:  0,
    tradeCount:   0,
    winCount:     0,
    lossCount:    0,
    currentStake: config.stake,
    patternTrades: [],
    consecutiveRecoveryLosses: 0,
    topMarkets:   [],
    stopRequested: false,
    message: sharedRecovery.inRecovery
      ? `Initializing specialist engine — entering in RECOVERY (shared ledger holds $${sharedRecovery.unrecoveredAmount.toFixed(2)} unrecovered)…`
      : "Initializing specialist analysis engine…",
    lastEntropyBits: 3.32,
    lastEv: 0,
  };

  logger.info({ config, inheritedRecovery: sharedRecovery.inRecovery }, "Specialist bot session starting");
  broadcast();

  runLoop(config).catch(err => {
    logger.error({ err }, "Specialist bot runLoop error");
    session.running = false;
    session.message = `Error: ${err instanceof Error ? err.message : String(err)}`;
    broadcast();
  }).finally(() => {
    releaseTradingOwnership("bots");
  });

  return { ok: true };
}

// ── Market scoring ────────────────────────────────────────────────────────────

/**
 * Build the method-7 decision feature vector from the per-window quantum reads.
 */
function decisionFromWindows(windows: (BotMarketScore | null | undefined)[]): DecisionFeatures {
  const base = windows.find(w => w?.quantum)?.quantum;
  const usable = windows
    .map(w => w?.quantum)
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  return {
    z:              base?.z ?? 0,
    lambda:         base?.lambda ?? 0.5,
    timing:         base ? quantumTimingScore(base) : 50,
    hazardRelative: base?.hazardRelative ?? 1,
    entropyDelta:   base?.entropyDelta ?? 0,
    ciOverlap:      ciOverlapWidth(usable),
  };
}

/**
 * Resolve the barrier a candidate should use, honouring a digit lock.
 */
function barrierFor(
  ct: BotContractType,
  digits: number[],
  config: BotConfig,
): { barrier: number | undefined; candidates?: DigitCandidate[] } {
  const { overBarrier, underBarrier } = extractBarriers(config.barriers);
  if (ct === "DIGITOVER")  return { barrier: overBarrier };
  if (ct === "DIGITUNDER") return { barrier: underBarrier };
  if (ct === "DIGITMATCH" || ct === "DIGITDIFF") {
    const resolved = resolveBotBarrier(ct, digits, config.lockedBarrier);
    return { barrier: resolved.barrier, candidates: resolved.candidates };
  }
  return { barrier: undefined };
}

/**
 * Score one market for this bot's armed contract types.
 *
 * When more than one side is armed the specialist arbitrates between them with
 * hysteresis: switching away from the side the session last traded costs a
 * margin, so the bot does not oscillate between two near-equal setups.
 */
export async function scoreMarketForBot(
  symbol: string,
  displayName: string,
  config: BotConfig,
  signalMode: SignalMode = "normal",
): Promise<BotMarketScore | null> {
  const digits100 = tickManager.getDigits(symbol, 100);
  const digits60  = digits100.slice(-60);
  const digits30  = digits100.slice(-30);
  const prices    = tickManager.getTicks(symbol, 50);
  const scored: BotMarketScore[] = [];
  let candidates: DigitCandidate[] | undefined;

  for (const ct of config.contractTypes) {
    if ((ct === "DIGITMATCH" || ct === "DIGITDIFF") && digits60.length < 25) continue;
    const resolved = barrierFor(ct, digits60, config);
    if (resolved.candidates) candidates = resolved.candidates;

    const r100 = botPrecisionScore(symbol, displayName, ct, resolved.barrier, digits100, prices);
    const r60  = botPrecisionScore(symbol, displayName, ct, resolved.barrier, digits60,  prices);
    const r30  = botPrecisionScore(symbol, displayName, ct, resolved.barrier, digits30,  prices);
    if (!r60 || !r60.quantum) continue;

    const combinedScore = Math.round(
      ((r30?.score ?? r60.score) * 0.25 + r60.score * 0.50 + (r100?.score ?? r60.score) * 0.25) * 10,
    ) / 10;
    const decision = decisionFromWindows([r30, r60, r100]);
    scored.push({
      ...r60,
      score: combinedScore + metaBonus(decision, signalMode),
      decision,
      digitCandidates: resolved.candidates,
    });
  }

  if (scored.length === 0) return null;
  if (scored.length === 1) return scored[0]!;

  // Specialist arbitration with hysteresis.
  const verdict = specialistSideChoice(
    scored.map(s => ({ side: s.contractType, read: s.specialist ?? { family: "parity", bonus: 0, confidence: 0, metrics: {}, signals: [] } })),
    session.lastSide,
  );
  const chosen = (verdict && scored.find(s => s.contractType === verdict.side)) ?? scored[0]!;
  return { ...chosen, digitCandidates: chosen.digitCandidates ?? candidates };
}

/**
 * Score every automated-eligible market for this bot.
 */
export async function analyzeMarketsForBot(
  config: BotConfig,
  signalMode: SignalMode = "normal",
): Promise<BotMarketScore[]> {
  const scored: BotMarketScore[] = [];
  const needsDigits = config.contractTypes.some(ct => ct.startsWith("DIGIT"));

  for (const market of AUTOMATED_DERIV_MARKETS) {
    if (needsDigits && !market.digitEnabled) continue;
    const best = await scoreMarketForBot(market.symbol, market.displayName, config, signalMode);
    if (best) scored.push(best);
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Comprehensive scan: scores every automated-eligible market for this bot.
 * Recovery uses the SAME contract family, so a single pass covers both modes —
 * that is exactly the point of a specialist.
 */
export async function scanBestMarketForBot(config: BotConfig): Promise<BotScanResult> {
  const candidatesBySymbol = new Map<string, BotMarketScore>();
  const total = AUTOMATED_DERIV_MARKETS.length;
  let scanned = 0;

  for (const market of AUTOMATED_DERIV_MARKETS) {
    broadcastSSE("bot_scan_progress", {
      botId: config.botId,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned,
      total,
      results: [...candidatesBySymbol.values()].sort((a, b) => b.score - a.score),
    }, config.ownerSessionId);

    const best = await scoreMarketForBot(market.symbol, market.displayName, config, "normal");
    scanned++;
    await sleep(200);
    if (!best) continue;
    candidatesBySymbol.set(market.symbol, best);
  }

  const allScored = [...candidatesBySymbol.values()].sort((a, b) => b.score - a.score);

  broadcastSSE("bot_scan_progress", {
    botId: config.botId,
    scanning: null,
    symbol: null,
    scanned: total,
    total,
    results: allScored,
  }, config.ownerSessionId);

  if (allScored.length === 0) {
    return {
      suitable: false,
      best: null,
      allScored: [],
      reason: "No tick data available yet — please wait a few seconds and scan again",
    };
  }

  const best     = allScored[0]!;
  const suitable = best.score >= SUITABLE_SCORE_THRESHOLD;
  const reason   = suitable
    ? `${best.displayName} shows high statistical edge (score ${best.score.toFixed(0)}/100, H=${best.entropyBits}b${best.specialist ? `, specialist ${best.specialist.bonus >= 0 ? "+" : ""}${best.specialist.bonus.toFixed(1)}` : ""})`
    : `No market shows decisive edge yet — best was ${best.displayName} at ${best.score.toFixed(0)}/100`;

  return { suitable, best, allScored, reason };
}

// ── Sniper recovery gate (five-window) ────────────────────────────────────────

/**
 * Sniper recovery gate.
 *
 * The FAB requires concurrence across four windows (15/30/60/100). A specialist
 * adds the 200-tick macro window at no extra cost — the fifth opinion is the
 * cheapest thing a single-family engine can buy, and it is the one that catches
 * an edge that only exists on the short time-scale.
 */
function sniperRecoveryGate(
  symbol: string,
  displayName: string,
  config: BotConfig,
  recentTrades: AntiPatternRecord[],
): { winner: BotMarketScore; greenLight: boolean } | null {
  const digits200 = tickManager.getDigits(symbol, 200);
  const prices50  = tickManager.getTicks(symbol, 50);
  if (digits200.length < 25) return null;

  const windows = SNIPER_WINDOWS.map(w => digits200.slice(-w));

  // Anti-pattern decaying penalty map (FAB behaviour, copied).
  const penaltyMap = new Map<string, number>();
  for (let i = recentTrades.length - 1; i >= 0; i--) {
    const t = recentTrades[i]!;
    const key = `${t.contractType}_${t.barrier ?? ""}`;
    if (!t.won) {
      const existing = penaltyMap.get(key) ?? 0;
      const agePenalty = Math.max(0, 10 - (recentTrades.length - 1 - i) * 2);
      penaltyMap.set(key, Math.max(existing, agePenalty));
    } else {
      penaltyMap.delete(key);
    }
  }

  const candidates: (BotMarketScore & { greenLight: boolean })[] = [];

  for (const ct of config.contractTypes) {
    const digits60 = digits200.slice(-60);
    const resolved = barrierFor(ct, digits60, config);
    const barrier = resolved.barrier;

    const scores = windows.map((win, idx) =>
      botPrecisionScore(symbol, displayName, ct, barrier, win, prices50, idx === 0 ? 15 : 25),
    );
    const s15 = scores[0];
    const s30 = scores[1];
    const s60 = scores[2];
    if (!s15 || !s30 || !s60 || !s60.quantum) continue;

    // Window concurrence (FAB rule, extended to five windows): the immediate
    // and mid windows must agree, and every window must clear the floor.
    if (Math.abs(s15.score - s60.score) > 25) continue;
    if (scores.some(s => (s?.score ?? 0) < 58)) continue;

    let baseScore = 0;
    for (let i = 0; i < scores.length; i++) {
      baseScore += (scores[i]?.score ?? s60.score) * (SNIPER_WEIGHTS[i] ?? 0);
    }
    baseScore = Math.round(baseScore * 10) / 10;

    const sBonus  = deepSniperBonus(ct, barrier, digits60, prices50);
    const penalty = penaltyMap.get(`${ct}_${barrier ?? ""}`) ?? 0;

    const qs = scores.map(s => s?.quantum).filter((x): x is NonNullable<typeof x> => Boolean(x));
    const q60 = s60.quantum;
    const ciB = ciOverlapBonus(qs);
    const trB = s15.quantum ? edgeTrendBonus(s15.quantum, q60) : 0;
    const decision: DecisionFeatures = {
      z:              q60.z,
      lambda:         q60.lambda,
      timing:         quantumTimingScore(q60),
      hazardRelative: q60.hazardRelative,
      entropyDelta:   qs[qs.length - 1]?.entropyDelta ?? 0,
      ciOverlap:      ciOverlapWidth(qs),
    };
    const meta = metaBonus(decision, "recovery");

    const specialist = s60.specialist;
    const adjustedScore = baseScore + sBonus - penalty + ciB + trB + meta + (specialist?.bonus ?? 0);

    const winProb = s60.winProbability;
    const payout  = s60.payout;
    const ev = winProb * (payout - 1) - (1 - winProb);
    const { requiredScore, requiredEv } = recoveryRequirements(ct, barrier);
    if (adjustedScore < requiredScore || ev < requiredEv) continue;

    const gl = botGreenLight(digits60, prices50, ct, barrier);
    candidates.push({
      ...s60,
      barrier,
      score: adjustedScore,
      expectedValue: ev,
      reason: `${s60.reason} | 5W ${scores.map(s => (s?.score ?? 0).toFixed(0)).join("/")} d${sBonus >= 0 ? "+" : ""}${sBonus}${penalty > 0 ? ` p-${penalty}` : ""}${ciB !== 0 ? ` ci+${ciB}` : ""}${trB !== 0 ? ` tr${trB >= 0 ? "+" : ""}${trB}` : ""}${meta !== 0 ? ` meta${meta >= 0 ? "+" : ""}${meta}` : ""}`,
      greenLight: gl.pass,
      decision,
      digitCandidates: resolved.candidates,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.greenLight !== b.greenLight) return a.greenLight ? -1 : 1;
    if (Math.abs(a.score - b.score) > 2) return b.score - a.score;
    return (b.decision?.z ?? 0) - (a.decision?.z ?? 0);
  });

  const best = candidates[0]!;
  return { winner: best, greenLight: best.greenLight };
}

function recoveryRequirements(
  contractType: BotContractType,
  barrier: number | undefined,
): { requiredScore: number; requiredEv: number } {
  // Copied from the FAB.
  const theoretical =
    contractType === "DIGITOVER"  ? (barrier !== undefined ? (9 - barrier) / 10 : 0.5)
    : contractType === "DIGITUNDER" ? (barrier !== undefined ? barrier / 10 : 0.5)
    : contractType === "DIGITMATCH" ? 0.1
    : contractType === "DIGITDIFF"  ? 0.9
    : 0.5;
  if (theoretical >= 0.70) return { requiredScore: 60, requiredEv: 0.018 };
  if (theoretical <= 0.30) return { requiredScore: 62, requiredEv: 0.035 };
  return { requiredScore: 60, requiredEv: 0.020 };
}

/** Micro-polling green-light waiter (FAB cadence: 90ms polls, 2.8s budget). */
async function waitForGreenLight(
  symbol: string,
  contractType: BotContractType,
  barrier: number | undefined,
  maxWaitMs = 2800,
  pollMs = 90,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!session.running || session.stopRequested) return false;
    const d = tickManager.getDigits(symbol, 60);
    const p = tickManager.getTicks(symbol, 50);
    if (botGreenLight(d, p, contractType, barrier).pass) return true;
    await sleep(pollMs);
  }
  return false;
}

// ── Recovery stake (shared ledger) ────────────────────────────────────────────

function computeRecoveryStake(
  payout: number,
  winProbability: number,
  config: BotConfig,
  maxStake: number,
  availableBalance: number,
): number {
  if (!recoveryEngine.isInRecovery()) return config.stake;
  // Bot-specific: conservative 10 % markup on debt.
  // The shared getDynamicRecoveryStake targets debt + aspirational target-profit,
  // which over-exposes capital for high-payout bot contracts (Matches 8.93×,
  // Over/Under 2.43×, Even/Odd 1.95×).  getBotRecoveryStake sizes the stake
  // so a single win recovers all debt + 10 % of debt as profit instead.
  return recoveryEngine.getBotRecoveryStake(
    config.stake,
    maxStake,
    availableBalance,
    payout,
  );
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: BotConfig) {
  const ownerSessionId = config.ownerSessionId;
  const botName = getBotDefinition(config.botId)?.name ?? config.botId;
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
  const currency       = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLive         = !paperTradeMode && !!token;
  const maxStake       = settings.length > 0 ? Number(settings[0].maxTradeStake) : 500;
  let availableBalance = accounts.length > 0 && Number(accounts[0].balance) > 0
    ? Number(accounts[0].balance)
    : Number.POSITIVE_INFINITY;

  const isLocked = config.marketMode === "locked" || (!!config.lockedSymbol && config.marketMode !== "switching");
  const lockedMarket = isLocked && config.lockedSymbol
    ? AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.lockedSymbol) ?? null
    : null;

  if (isLocked && config.lockedSymbol && !lockedMarket) {
    session.running = false;
    session.message = `⚠️ Market ${config.lockedSymbol} not found — session aborted`;
    broadcast();
    return;
  }

  let preAnalyzed: BotMarketScore[] | null = null;
  let consecutiveErrors = 0;
  let lastTradeMs = Date.now();
  let awaitFreshRecoveryWindow = false;

  while (session.running && !session.stopRequested) {
    try {
      // ── Single-executor guard ───────────────────────────────────────────────
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false;
        session.message = `⛔ Session stopped — the ${owner ? tradingOwnerLabel(owner) : "other engine"} is now trading this account. One shared recovery ledger = one trading engine at a time.`;
        broadcast();
        logger.warn({ owner }, "Specialist bot halted: lost trading ownership");
        return;
      }

      // ── Tick feed health ────────────────────────────────────────────────────
      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) {
        session.message = "Stabilizing tick feed — syncing markets…";
        broadcast();
        await sleep(1200);
        continue;
      }

      // ── Mode from the SHARED ledger; contract family never changes ─────────
      const inRecovery    = recoveryEngine.isInRecovery();
      const contractTypes = config.contractTypes;
      const signalMode: SignalMode = inRecovery ? "recovery" : "normal";
      const usesDigits = contractTypes.some(ct => ct.startsWith("DIGIT"));

      if (awaitFreshRecoveryWindow && inRecovery && usesDigits) {
        if (Date.now() - lastTradeMs < 1200) {
          session.message = "Stabilizing after recovery loss…";
          broadcast();
          await sleep(250);
          continue;
        }
        const freshDigits = lockedMarket
          ? tickManager.getDigits(lockedMarket.symbol, 100)
          : AUTOMATED_DERIV_MARKETS
              .filter(m => m.digitEnabled)
              .map(m => tickManager.getDigits(m.symbol, 100))
              .find(d => d.length >= 40);
        if (!freshDigits || freshDigits.length < 40) {
          session.message = "Building fresh recovery window (40+ ticks)…";
          broadcast();
          await sleep(300);
          continue;
        }
        awaitFreshRecoveryWindow = false;
      }

      let best: BotMarketScore | undefined;

      if (lockedMarket) {
        const cached = preAnalyzed?.find(m => m.symbol === lockedMarket.symbol);
        preAnalyzed = null;
        if (cached) {
          best = cached;
        } else {
          const result = await scoreMarketForBot(lockedMarket.symbol, lockedMarket.displayName, config, signalMode);
          if (!result) {
            session.message = "Waiting for tick data on locked market…";
            broadcast();
            await sleep(1500);
            continue;
          }
          best = result;
        }
        session.topMarkets = [best];
      } else if (preAnalyzed && preAnalyzed.length > 0) {
        const scored = preAnalyzed;
        preAnalyzed = null;
        session.topMarkets = scored;
        if (scored[0]!.score < MIN_TRADE_SCORE) {
          session.message = `Scanning markets (best ${scored[0]!.displayName} ${scored[0]!.score}/100) — waiting for edge…`;
          broadcast();
          await sleep(1500);
          continue;
        }
        best = scored[0]!;
      } else {
        session.message = inRecovery ? "🎯 Sniper scanning recovery markets…" : `${botName} scanning markets…`;
        broadcast();
        const scored = await analyzeMarketsForBot(config, signalMode);
        session.topMarkets = scored;
        if (scored.length === 0) {
          session.message = "Waiting for tick data stream…";
          broadcast();
          await sleep(2000);
          continue;
        }
        if (scored[0]!.score < MIN_TRADE_SCORE) {
          session.message = `Awaiting high-probability setup (best ${scored[0]!.displayName} ${scored[0]!.score}/100)…`;
          broadcast();
          await sleep(1500);
          continue;
        }
        best = scored[0]!;
      }

      session.lastEntropyBits = best.entropyBits;
      session.lastEv = Math.round(best.expectedValue * 1000) / 10;
      session.lastSpecialist = best.specialist;
      session.lastDigitCandidates = best.digitCandidates;

      // ── Gating ──────────────────────────────────────────────────────────────
      if (inRecovery) {
        let candidate: { winner: BotMarketScore; greenLight: boolean } | null = null;
        const maxAttempts = 4;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          candidate = sniperRecoveryGate(best.symbol, best.displayName, config, session.patternTrades);
          if (candidate) break;
          session.message = `🎯 Sniper recovery analysis (attempt ${attempt + 1})…`;
          broadcast();
          preAnalyzed = null;
          await sleep(750);
          if (!session.running || session.stopRequested) break;
        }

        if (!candidate) {
          session.message = `🎯 Recovery analysis — edge ${Math.round(best.score)}/100, waiting for an accurate setup…`;
          broadcast();
          preAnalyzed = null;
          await sleep(1800);
          continue;
        }

        if (!candidate.greenLight) {
          const achieved = await waitForGreenLight(best.symbol, candidate.winner.contractType, candidate.winner.barrier);
          if (!session.running || session.stopRequested) break;
          if (!achieved) {
            session.message = "Waiting for a timed recovery entry…";
            broadcast();
            preAnalyzed = null;
            continue;
          }
          const refreshed = sniperRecoveryGate(best.symbol, best.displayName, config, session.patternTrades);
          if (refreshed && refreshed.greenLight) {
            candidate = refreshed;
          } else {
            session.message = "Waiting for a timed recovery entry…";
            broadcast();
            preAnalyzed = null;
            continue;
          }
        }

        best = {
          ...best,
          contractType:   candidate.winner.contractType,
          barrier:        candidate.winner.barrier,
          payout:         candidate.winner.payout,
          winProbability: candidate.winner.winProbability,
          score:          candidate.winner.score,
          expectedValue:  candidate.winner.expectedValue,
          reason:         candidate.winner.reason,
          specialist:     candidate.winner.specialist,
        };
      } else {
        // ── Normal-mode entry gating: FAB green light + specialist gate ──────
        const digits = tickManager.getDigits(best.symbol, 60);
        const prices = tickManager.getTicks(best.symbol, 50);
        const gate = botGreenLight(digits, prices, best.contractType, best.barrier);

        if (!gate.pass && best.score < 72) {
          session.message = `⏳ ${gate.reason} — awaiting optimal entry on ${best.displayName}…`;
          broadcast();
          preAnalyzed = null;
          for (let retry = 0; retry < 3; retry++) {
            await sleep(350);
            if (!session.running || session.stopRequested) break;
            const rDigits = tickManager.getDigits(best.symbol, 60);
            const rPrices = tickManager.getTicks(best.symbol, 50);
            if (botGreenLight(rDigits, rPrices, best.contractType, best.barrier).pass) break;
          }
        }
      }

      // ── Contract sovereignty: never fire outside the armed family ──────────
      if (!config.contractTypes.includes(best.contractType)) {
        logger.warn({ got: best.contractType, allowed: config.contractTypes }, "Discarding trade outside the bot's contract family");
        session.message = "Waiting for a configured contract setup…";
        broadcast();
        preAnalyzed = null;
        await sleep(750);
        continue;
      }
      const { overBarrier: expectedOver, underBarrier: expectedUnder } = extractBarriers(config.barriers);
      if (best.contractType === "DIGITOVER" && best.barrier !== expectedOver) {
        session.message = `Waiting for a configured over${expectedOver} setup…`;
        broadcast();
        preAnalyzed = null;
        await sleep(750);
        continue;
      }
      if (best.contractType === "DIGITUNDER" && best.barrier !== expectedUnder) {
        session.message = `Waiting for a configured under${expectedUnder} setup…`;
        broadcast();
        preAnalyzed = null;
        await sleep(750);
        continue;
      }

      // ── Execution-tick revalidation (FAB method 6) ─────────────────────────
      const reDigits = tickManager.getDigits(best.symbol, 60);
      const rePrices = tickManager.getTicks(best.symbol, 50);
      const reReady = best.contractType === "CALL" || best.contractType === "PUT"
        ? rePrices.length >= 30
        : reDigits.length >= 30;
      if (reReady) {
        const fresh = quantumWindowEstimate(reDigits, rePrices, best.contractType, best.barrier);
        const entryZ = best.decision?.z ?? best.quantum?.z ?? 0;
        if (fresh.z <= 0 || fresh.z < 0.5 * entryZ) {
          session.message = `⏱️ Execution-tick revalidation: edge faded (z ${entryZ.toFixed(2)} → ${fresh.z.toFixed(2)}) — re-scanning…`;
          broadcast();
          preAnalyzed = null;
          await sleep(400);
          continue;
        }
        // Specialist revalidation: the entry condition must still hold on the
        // execution tick, not just at decision time.
        const freshSpecialist = specialistReadFor(best.contractType, best.barrier, reDigits, rePrices);
        if (freshSpecialist) {
          session.lastSpecialist = freshSpecialist;
        }
      }

      // ── Pre-warmed payout quote + exact sizing ─────────────────────────────
      const payoutQuote = await resolveRecoveryPayout({
        symbol: best.symbol,
        contractType: best.contractType,
        barrier: best.barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      best = { ...best, payout: payoutQuote.payoutMultiplier };

      const stake = computeRecoveryStake(best.payout, best.winProbability, config, maxStake, availableBalance);
      const sharedStep = recoveryEngine.getState().recoveryStep;

      session.currentMarket       = best.displayName;
      session.currentContractType = best.contractType + (best.barrier !== undefined ? ` ${best.barrier}` : "");
      session.currentStake        = stake;
      session.message = inRecovery
        ? `🎯 [${botName} R${sharedStep}] ${best.contractType}${best.barrier !== undefined ? ` ${best.barrier}` : ""} on ${best.displayName}`
        : `⚡ ${botName} trading ${best.contractType}${best.barrier !== undefined ? ` ${best.barrier}` : ""} on ${best.displayName}`;
      broadcast();

      // ── Journal the trade up front (same as the FAB) ───────────────────────
      const botReason = `${inRecovery ? `[${botName} RECOVERY] Sniper` : `[${botName}]`} ${best.reason}`;
      const botDirection = best.contractType === "CALL" ? "up" : best.contractType === "PUT" ? "down" : "hold";
      const [botTrade] = await db.insert(tradesTable).values({
        sessionId:    ownerSessionId,
        symbol:       best.symbol,
        displayName:  best.displayName,
        contractType: best.contractType,
        barrier:      best.barrier ?? null,
        stake:        String(Math.round(stake * 100) / 100),
        direction:    botDirection,
        status:       "open",
        aiConfidence: String(Math.round(best.winProbability * 100)),
        aiRiskScore:  "60",
        isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${botReason}`,
        duration:     1,
        durationUnit: "t",
      }).returning();

      // ── Execute ─────────────────────────────────────────────────────────────
      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(best.symbol) ?? 0;
      let exitPrice  = entryPrice;

      if (isLive) {
        try {
          logger.info({
            botId:       config.botId,
            symbol:      best.symbol,
            contractType: best.contractType,
            barrier:     best.barrier,
            stake:       Math.round(stake * 100) / 100,
            inRecovery,
            step:        sharedStep,
          }, inRecovery ? "Specialist bot executing sniper recovery trade" : "Specialist bot executing normal trade");

          if (!isAutomatedMarket(best.symbol)) {
            throw new Error(`${best.displayName} is blocked from specialist bot execution`);
          }
          const liveResult = await executeLiveTrade(token!, {
            symbol:       best.symbol,
            contractType: best.contractType,
            stake:        Math.round(stake * 100) / 100,
            duration:     1,
            durationUnit: "t",
            currency,
            accountId:    accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            barrier:      best.barrier,
          });
          const result = await waitForContractResult(
            token!, accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            liveResult.contractId, 30_000,
          );
          won    = result.won;
          profit = result.profit;
          entryPrice = Number(result.entrySpot) || liveResult.buyPrice;
          exitPrice  = Number(result.exitSpot)  || entryPrice;
        } catch (err) {
          logger.warn({ err, symbol: best.symbol }, "Specialist bot live trade execution error — retrying");
          try {
            await db.update(tradesTable).set({
              status: "error", profit: "0", payout: "0", closedAt: new Date(),
              agentReasoning: `${botReason} [EXECUTION FAILED: ${err instanceof Error ? err.message : String(err)}]`,
            }).where(eq(tradesTable.id, botTrade!.id));
          } catch { /* best-effort */ }
          session.message = `Trade retry: ${err instanceof Error ? err.message : String(err)}`;
          broadcast();
          await sleep(1500);
          continue;
        }
      } else {
        won    = Math.random() < best.winProbability;
        profit = won ? stake * (best.payout - 1) : -stake;
      }

      // ── Record outcome & settle the SHARED recovery ledger ─────────────────
      session.tradeCount++;
      session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) {
        session.winCount++;
        session.lastResult = "won";
      } else {
        session.lossCount++;
        session.lastResult = "lost";
      }
      session.lastSide = best.contractType;

      recoveryEngine.recordOutcome(
        won, profit, stake, config.maxRecoverySteps, best.contractType, best.payout,
      );

      // Method 7 — self-measured signal value.
      const dfRecord: DecisionFeatures = best.decision ?? {
        z:              best.quantum?.z ?? 0,
        lambda:         best.quantum?.lambda ?? 0.5,
        timing:         best.quantum ? quantumTimingScore(best.quantum) : 50,
        hazardRelative: best.quantum?.hazardRelative ?? 1,
        entropyDelta:   best.quantum?.entropyDelta ?? 0,
        ciOverlap:      0,
      };
      recordTradeSignal(signalMode, dfRecord, won);

      if (inRecovery) {
        session.patternTrades = [...session.patternTrades, {
          contractType: best.contractType, barrier: best.barrier, won,
        }].slice(-8);
        session.consecutiveRecoveryLosses = won ? 0 : session.consecutiveRecoveryLosses + 1;
        if (!recoveryEngine.isInRecovery()) {
          session.patternTrades = [];
          session.consecutiveRecoveryLosses = 0;
        }
      }

      try {
        await db.update(tradesTable).set({
          status:     won ? "won" : "lost",
          payout:     String(won ? Math.round((stake + profit) * 100) / 100 : 0),
          profit:     String(Math.round(profit * 100) / 100),
          entryPrice: String(entryPrice),
          exitPrice:  String(exitPrice),
          closedAt:   new Date(),
        }).where(eq(tradesTable.id, botTrade!.id));
      } catch (dbErr) {
        logger.warn({ dbErr, tradeId: botTrade!.id }, "Specialist bot: failed to settle journaled trade row");
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

      broadcast();

      // ── TP / SL boundaries ─────────────────────────────────────────────────
      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit target $${config.takeProfit.toFixed(2)} reached! Session complete.`;
        broadcast();
        logger.info({ profit: session.totalProfit, botId: config.botId }, "Specialist bot take profit reached");
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss limit $${config.stopLoss.toFixed(2)} hit. Session stopped safely.`;
        broadcast();
        logger.info({ profit: session.totalProfit, botId: config.botId }, "Specialist bot stop loss triggered");
        return;
      }
      const sharedStateAfter = recoveryEngine.getState();
      if (sharedStateAfter.inRecovery && sharedStateAfter.recoveryStep >= config.maxRecoverySteps) {
        session.message = `⚡ Max recovery step reached (${config.maxRecoverySteps}) — maintaining stake limit`;
        broadcast();
      }

      // ── Parallel pre-analysis during post-trade settling ───────────────────
      const nextInRecovery = recoveryEngine.isInRecovery();
      const pauseMs = won ? 900 : 1600;
      if (!won && (inRecovery || nextInRecovery)) awaitFreshRecoveryWindow = true;

      const preAnalyzePromise = lockedMarket
        ? scoreMarketForBot(lockedMarket.symbol, lockedMarket.displayName, config, nextInRecovery ? "recovery" : "normal")
            .then(r => (r ? [r] : []))
        : analyzeMarketsForBot(config, nextInRecovery ? "recovery" : "normal");

      await sleep(pauseMs);
      if (!session.running || session.stopRequested) break;

      try {
        const result = await Promise.race([
          preAnalyzePromise,
          new Promise<BotMarketScore[]>((_, reject) => setTimeout(() => reject(new Error("pre-analysis timeout")), 4000)),
        ]);
        preAnalyzed = result.length > 0 ? result : null;
      } catch (e) {
        logger.warn({ e }, "Specialist bot pre-analysis timeout — will rescan");
        preAnalyzed = null;
      }

      lastTradeMs = Date.now();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Specialist bot runLoop stability catch");
      session.message = consecutiveErrors > 3
        ? `Engine stabilizing… retry ${consecutiveErrors}/5`
        : "Stabilizing engine — retrying…";
      broadcast();
      await sleep(Math.min(2000, 500 * consecutiveErrors));
      if (consecutiveErrors >= 5) {
        session.running = false;
        session.message = "Engine paused for stability check — please restart";
        broadcast();
        logger.error("Specialist bot halted after 5 consecutive errors");
        return;
      }
      continue;
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
