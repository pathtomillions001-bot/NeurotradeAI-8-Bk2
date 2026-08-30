/**
 * NeuroAI FAB Engine (SpeedAI Engine v4 — Institutional Quantum Edition)
 *
 * Ultra-fast 1-tick algorithmic trading engine with:
 *  1. 2nd-Order Bayesian Markov Tensor Transitions with Laplace Dirichlet prior
 *  2. Geometric Run-Length Hazard Rate & Fatigue Inflection Point Detection
 *  3. Shannon Information Entropy (H(X)) Noise Gating & Structural Clustering
 *  4. Discrete Lag-1 Autocorrelation (ρ₁) & Micro-Tick Acceleration (Kinematics)
 *  5. Net Expected Value (+EV) Micro-Gating
 *  6. Sniper Recovery Protocol with 4-Window Concurrence (15t / 30t / 60t / 100t)
 *  7. Multi-Loss Anti-Pattern Memory & Exponential Decay Penalisers
 *  8. Pre-Warmed Proposal Quote Caching (Zero-Lag Execution Path)
 *  9. Strict User Contract Sovereignty (Zero deviation from user contract family)
 * 10. Explicit User Market Mode: Locked Single Asset vs Smart Strategy Switching
 */

import {
  tickManager,
  DERIV_MARKETS,
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
import {
  OVER_PAYOUTS,
  UNDER_PAYOUTS,
  EVEN_ODD_PAYOUT,
  RISE_FALL_PAYOUT,
  MATCH_PAYOUT,
  DIFF_PAYOUT,
} from "./payouts";
import { resolveRecoveryPayout } from "./recovery-payout";
import * as recoveryEngine from "./agents/recovery-engine";
import {
  quantumWindowEstimate,
  zEdgeQuality,
  quantumTimingScore,
  hazardTimingBonus,
  entropyOnsetBonus,
  ciOverlapBonus,
  ciOverlapWidth,
  edgeTrendBonus,
  type QuantumFeatures,
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
import type { RecoveryTradeRecord } from "./speed-recovery-state";

export { recordRecoveryOutcome } from "./speed-recovery-state";
export type { SpeedRecoveryState } from "./speed-recovery-state";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum score (0–100) for a market to be deemed "suitable" during initial scan */
const SUITABLE_SCORE_THRESHOLD = 54;

/** Minimum score for a normal trade to execute */
const MIN_TRADE_SCORE = 50;

/** Minimum EV for normal trade execution (+1.5% edge) */
const MIN_NORMAL_EV = 0.015;

/** Maximum entropy threshold (bits): above this is pure white noise */
const ENTROPY_WHITE_NOISE_LIMIT = 3.275;

// ── Types ─────────────────────────────────────────────────────────────────────

export type SpeedContractType =
  | "DIGITOVER" | "DIGITUNDER"
  | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF"
  | "CALL" | "PUT";

export interface SpeedAIConfig {
  /** Opaque browser-session owner; supplied only by the API route. */
  ownerSessionId?: string;
  normalContractTypes: SpeedContractType[];
  normalBarriers: number[];       // For OVER/UNDER — e.g. [1,2] for OVER, [7,8] for UNDER
  recoveryContractTypes: SpeedContractType[];
  recoveryBarriers: number[];     // For OVER/UNDER recovery
  stake: number;
  stopLoss: number;
  takeProfit: number;
  recoveryAutoMode: boolean;
  recoveryMultiplier: number;
  recoveryMethod: "split" | "instant";
  maxRecoverySteps: number;
  /** When set, the loop trades ONLY this symbol — no per-trade market re-scanning */
  lockedSymbol?: string;
  marketMode?: "locked" | "switching";
}

export interface ScanResult {
  suitable: boolean;
  best: MarketScore | null;
  allScored: MarketScore[];
  reason: string;
}

export interface MarketScore {
  symbol: string;
  displayName: string;
  contractType: SpeedContractType;
  barrier?: number;
  score: number;
  normalScore?: number;
  recoveryScore?: number;
  recoveryContractType?: SpeedContractType;
  recoveryBarrier?: number;
  winProbability: number;
  payout: number;
  expectedValue: number;
  entropyBits: number;
  isStructured: boolean;
  reason: string;
  /** Quantum statistical read of the scoring window (methods 1–5) */
  quantum?: QuantumFeatures;
  /** Decision-time feature vector for self-measured signal value (method 7) */
  decision?: DecisionFeatures;
}



export interface SpeedAIStatus {
  running: boolean;
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
  config?: SpeedAIConfig;
  message?: string;
  topMarkets?: MarketScore[];
  entropyBits?: number;
  expectedValue?: number;
}

// ── Session state ─────────────────────────────────────────────────────────────
//
// IMPORTANT: there is deliberately NO private recovery state here anymore.
// Recovery mode / debt / target / step live in the ONE shared account ledger
// (lib/agents/recovery-engine.ts, DB-persisted) which the main autonomous
// engine also uses. This FAB previously kept its own SpeedRecoveryState, which
// let it trade the same account with a different view of the debt — the direct
// cause of "normal trades while in recovery / recovery trades after recovery
// completed" mix-ups whenever both engines were active.
//
// What remains FAB-local: the anti-pattern memory (recent recovery trade types
// for the sniper gate's decaying penalty) and a display counter. Neither of
// these decides normal-vs-recovery mode or stake size.

let session: {
  running: boolean;
  sessionId: string | null;
  config: SpeedAIConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  /** FAB-local anti-pattern memory for fastRecoveryGate (never drives mode/debt) */
  patternTrades: RecoveryTradeRecord[];
  /** FAB-local display counter — mirrors shared ledger recovery losses */
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  topMarkets: MarketScore[];
  stopRequested: boolean;
  lastEntropyBits: number;
  lastEv: number;
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

// ── Mathematical & Statistical Subsystems ─────────────────────────────────────

/**
 * Digit frequency histogram (0–9) over a tick buffer.
 */
function digitFrequency(digits: number[]): number[] {
  const counts = Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) counts[d]++;
  const n = digits.length || 1;
  return counts.map(c => c / n);
}

/**
 * 1st-Order Laplace-Smoothed Markov Chain Transitions.
 * P(D_t = 0..9 | D_{t-1} = last)
 */
function markovNextProb(digits: number[]): number[] {
  if (digits.length < 2) return Array(10).fill(0.1);
  const last = digits[digits.length - 1];
  const mat = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < digits.length; i++) {
    const f = digits[i - 1], t = digits[i];
    if (f >= 0 && f <= 9 && t >= 0 && t <= 9) mat[f][t]++;
  }
  const row = mat[last ?? 5];
  const total = row.reduce((a, b) => a + b, 0);
  return row.map(v => (v + 1) / (total + 10));
}

/**
 * 2nd-Order Bayesian Markov Transitions.
 * P(D_t = 0..9 | D_{t-1} = d_{n-1}, D_{t-2} = d_{n-2})
 */
function markov2ndOrderNextProb(digits: number[]): { probs: number[]; sampleCount: number } {
  if (digits.length < 3) return { probs: Array(10).fill(0.1), sampleCount: 0 };
  const prev1 = digits[digits.length - 2];
  const prev2 = digits[digits.length - 1];
  if (prev1 < 0 || prev1 > 9 || prev2 < 0 || prev2 > 9) {
    return { probs: Array(10).fill(0.1), sampleCount: 0 };
  }

  const counts = Array(10).fill(0);
  let total = 0;
  for (let i = 2; i < digits.length; i++) {
    if (digits[i - 2] === prev1 && digits[i - 1] === prev2) {
      const target = digits[i];
      if (target >= 0 && target <= 9) {
        counts[target]++;
        total++;
      }
    }
  }

  const probs = counts.map(c => (c + 1) / (total + 10));
  return { probs, sampleCount: total };
}

/**
 * Bayesian Combined Markov Posterior (1st + 2nd Order Synthesis)
 */
function bayesianMarkovProb(digits: number[]): number[] {
  const p1 = markovNextProb(digits);
  const p2Data = markov2ndOrderNextProb(digits);
  // Dynamic credibility weighting: 2nd-order weight scales with pair sample size
  const w2 = Math.min(0.60, p2Data.sampleCount * 0.15);
  const w1 = 1 - w2;
  return p1.map((val, idx) => val * w1 + p2Data.probs[idx] * w2);
}

/**
 * Specific Bayesian Markov Transition to Target Digit (for MATCH / DIFF)
 */
function bayesianMarkovToTarget(digits: number[], targetDigit: number): number {
  const probs = bayesianMarkovProb(digits);
  return probs[targetDigit] ?? 0.1;
}

/**
 * Shannon Information Entropy Filter (Noise Gating & Structural Asymmetry)
 * Evaluates whether digits are behaving as pure chaotic white noise (H ≈ 3.32 bits)
 * or showing structured clustering / statistical bias (H ≤ 3.12 bits).
 */
export interface ShannonEntropyResult {
  bits: number;
  ratio: number;
  isWhiteNoise: boolean;
  isStructured: boolean;
  bonus: number;
}

export function computeShannonEntropy(digits: number[], window = 50): ShannonEntropyResult {
  const d = digits.slice(-window);
  if (d.length < 15) {
    return { bits: 3.32, ratio: 1, isWhiteNoise: false, isStructured: false, bonus: 0 };
  }
  const counts = Array(10).fill(0);
  for (const v of d) if (v >= 0 && v <= 9) counts[v]++;
  const n = d.length;
  let h = 0;
  for (const c of counts) {
    if (c > 0) {
      const p = c / n;
      h -= p * Math.log2(p);
    }
  }
  const maxH = Math.log2(10); // ~3.321928 bits
  const ratio = h / maxH;
  const isWhiteNoise = h >= ENTROPY_WHITE_NOISE_LIMIT;
  const isStructured = h <= 3.12;

  let bonus = 0;
  if (isWhiteNoise) {
    bonus = -12; // Penalise chaotic white noise
  } else if (isStructured) {
    bonus = Math.min(15, Math.round((3.15 - h) * 50)); // Reward structured patterns
  } else {
    bonus = Math.round((3.22 - h) * 20);
  }

  return {
    bits: Math.round(h * 1000) / 1000,
    ratio: Math.round(ratio * 100) / 100,
    isWhiteNoise,
    isStructured,
    bonus: Math.max(-15, Math.min(15, bonus)),
  };
}

/**
 * Streak Against Length: count consecutive unbroken ticks against condition
 */
function streakAgainstLength(
  digits: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): number {
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i];
    let satisfies: boolean;
    switch (contractType) {
      case "DIGITOVER":  satisfies = barrier !== undefined && d > barrier; break;
      case "DIGITUNDER": satisfies = barrier !== undefined && d < barrier; break;
      case "DIGITEVEN":  satisfies = d % 2 === 0; break;
      case "DIGITODD":   satisfies = d % 2 !== 0; break;
      case "DIGITMATCH": satisfies = barrier !== undefined && d === barrier; break;
      case "DIGITDIFF":  satisfies = barrier !== undefined && d !== barrier; break;
      default:           satisfies = false;
    }
    if (!satisfies) count++;
    else break;
  }
  return count;
}

/**
 * Geometric Run-Length Hazard Rate & Streak Fatigue Analysis
 */
function calculateStreakFatigue(
  digits: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): { streakAgainst: number; fatigueScore: number; hazardBonus: number; isInflection: boolean } {
  const k = streakAgainstLength(digits, contractType, barrier);
  if (k === 0) return { streakAgainst: 0, fatigueScore: 0, hazardBonus: 0, isInflection: false };

  // Calculate empirical streak lengths in buffer
  let histStreak = 0;
  const streakLengths: number[] = [];
  for (let i = 0; i < digits.length; i++) {
    const d = digits[i];
    let satisfies = false;
    switch (contractType) {
      case "DIGITOVER":  satisfies = barrier !== undefined && d > barrier; break;
      case "DIGITUNDER": satisfies = barrier !== undefined && d < barrier; break;
      case "DIGITEVEN":  satisfies = d % 2 === 0; break;
      case "DIGITODD":   satisfies = d % 2 !== 0; break;
      case "DIGITMATCH": satisfies = barrier !== undefined && d === barrier; break;
      case "DIGITDIFF":  satisfies = barrier !== undefined && d !== barrier; break;
    }
    if (!satisfies) {
      histStreak++;
    } else {
      if (histStreak > 0) streakLengths.push(histStreak);
      histStreak = 0;
    }
  }

  const avgStreak = streakLengths.length > 0
    ? streakLengths.reduce((a, b) => a + b, 0) / streakLengths.length
    : 1.6;

  const fatigueScore = Math.min(100, Math.round((k / Math.max(1, avgStreak)) * 50));
  const isInflection = k >= 2;
  const hazardBonus = k === 1 ? 4 : k === 2 ? 9 : k === 3 ? 14 : Math.min(15, 12 + Math.floor(k / 2));

  return { streakAgainst: k, fatigueScore, hazardBonus, isInflection };
}

/**
 * Tick gap analysis: ticks since specific digit appeared
 */
function digitGapSinceLast(digits: number[], targetDigit: number): number {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] === targetDigit) return digits.length - 1 - i;
  }
  return digits.length;
}

/**
 * Discrete Lag-1 Autocorrelation (ρ₁) & Micro-Tick Kinematics (for Rise/Fall)
 */
function computePriceKinematics(
  prices: number[],
  direction: "CALL" | "PUT",
  window = 20,
): { lag1Autocorr: number; velocity: number; acceleration: number; isPersistent: boolean; isMeanReverting: boolean; signalBonus: number } {
  const p = prices.slice(-window);
  if (p.length < 5) {
    return { lag1Autocorr: 0, velocity: 0, acceleration: 0, isPersistent: false, isMeanReverting: false, signalBonus: 0 };
  }

  const returns: number[] = [];
  for (let i = 1; i < p.length; i++) returns.push(p[i] - p[i - 1]);

  const n = returns.length;
  const meanR = returns.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let t = 1; t < n; t++) num += (returns[t] - meanR) * (returns[t - 1] - meanR);
  for (let t = 0; t < n; t++) den += Math.pow(returns[t] - meanR, 2);

  const rho1 = den > 1e-12 ? Math.max(-1, Math.min(1, num / den)) : 0;
  const lastReturn = returns[returns.length - 1] ?? 0;
  const prevReturn = returns[returns.length - 2] ?? 0;
  const acceleration = lastReturn - prevReturn;
  const isPersistent = rho1 > 0.25;
  const isMeanReverting = rho1 < -0.25;

  let bonus = 0;
  const isCall = direction === "CALL";
  const upAligned = lastReturn > 0;
  const accAligned = isCall ? acceleration > 0 : acceleration < 0;

  if (isPersistent) {
    if ((isCall && upAligned) || (!isCall && !upAligned)) {
      bonus = accAligned ? 15 : 10;
    } else {
      bonus = -10;
    }
  } else if (isMeanReverting) {
    const last3 = returns.slice(-3);
    const consecutiveAdverse = isCall
      ? last3.filter(r => r < 0).length
      : last3.filter(r => r > 0).length;
    if (consecutiveAdverse >= 2) bonus = 12;
    else bonus = -5;
  } else {
    bonus = -8; // Chop / Dead zone penalty
  }

  return {
    lag1Autocorr: Math.round(rho1 * 100) / 100,
    velocity: lastReturn,
    acceleration,
    isPersistent,
    isMeanReverting,
    signalBonus: bonus,
  };
}

/**
 * Short-term hit rate within window
 */
function momentumRate(
  digits: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
  window = 15,
): number {
  if (contractType === "CALL" || contractType === "PUT") return 0.5;
  const recent = digits.slice(-window);
  if (recent.length < 5) return 0.5;
  let hits = 0;
  for (const d of recent) {
    switch (contractType) {
      case "DIGITOVER":  if (barrier !== undefined && d > barrier)  hits++; break;
      case "DIGITUNDER": if (barrier !== undefined && d < barrier)  hits++; break;
      case "DIGITEVEN":  if (d % 2 === 0)                          hits++; break;
      case "DIGITODD":   if (d % 2 !== 0)                          hits++; break;
      case "DIGITMATCH": if (barrier !== undefined && d === barrier) hits++; break;
      case "DIGITDIFF":  if (barrier !== undefined && d !== barrier) hits++; break;
    }
  }
  return hits / recent.length;
}

/**
 * Entry timing score (0–100) based on recent sub-ticks
 */
function entryTimingScore(
  digits: number[],
  prices: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): number {
  if (contractType === "CALL" || contractType === "PUT") {
    const recent = prices.slice(-8);
    if (recent.length < 3) return 50;
    let aligned = 0;
    for (let i = 1; i < recent.length; i++) {
      const up = recent[i] > recent[i - 1];
      if ((contractType === "CALL" && up) || (contractType === "PUT" && !up)) aligned++;
    }
    return Math.round((aligned / (recent.length - 1)) * 100);
  }

  const last3 = digits.slice(-3);
  if (last3.length < 2) return 50;

  let against = 0;
  for (const d of last3) {
    switch (contractType) {
      case "DIGITOVER":  if (barrier !== undefined && d <= barrier) against++; break;
      case "DIGITUNDER": if (barrier !== undefined && d >= barrier) against++; break;
      case "DIGITEVEN":  if (d % 2 !== 0) against++; break;
      case "DIGITODD":   if (d % 2 === 0) against++; break;
      case "DIGITMATCH": if (barrier !== undefined && d !== barrier) against++; break;
      case "DIGITDIFF":  if (barrier !== undefined && d === barrier) against++; break;
    }
  }
  return ([20, 50, 80, 100][against]) ?? 50;
}

/**
 * Theoretical baseline win rate
 */
function theoreticalWinRate(contractType: SpeedContractType, barrier: number | undefined): number {
  switch (contractType) {
    case "DIGITOVER":  return barrier !== undefined ? (9 - barrier) / 10 : 0.5;
    case "DIGITUNDER": return barrier !== undefined ? barrier / 10 : 0.5;
    case "DIGITEVEN":
    case "DIGITODD":
    case "CALL":
    case "PUT":        return 0.5;
    case "DIGITMATCH": return 0.1;
    case "DIGITDIFF":  return 0.9;
    default:           return 0.5;
  }
}

/**
 * Pick optimal barrier for DIGITMATCH
 */
function pickBestMatchBarrier(digits: number[]): number {
  const bayes = bayesianMarkovProb(digits);
  const freq30 = digitFrequency(digits.slice(-30));
  const hotScore = bayes.map((m, i) => {
    const gap = digitGapSinceLast(digits, i);
    const gapBonus = gap >= 3 && gap <= 9 ? 0.15
                   : gap >= 10 && gap <= 18 ? 0.05
                   : gap < 3 ? -0.10 : -0.04;
    return m * 0.55 + (freq30[i] ?? 0) * 0.25 + gapBonus;
  });
  return hotScore.indexOf(Math.max(...hotScore));
}

/**
 * Pick top N candidates for DIGITMATCH in Sniper Recovery
 */
function pickTopMatchBarriers(digits: number[], topN = 3): number[] {
  if (digits.length < 15) return [pickBestMatchBarrier(digits)];
  const bayes = bayesianMarkovProb(digits);
  const freq30 = digitFrequency(digits.slice(-30));
  const scored = bayes.map((m, i) => {
    const gap = digitGapSinceLast(digits, i);
    const gapQ = gap >= 4 && gap <= 9 ? 0.16
               : gap >= 3 && gap <= 12 ? 0.08
               : gap < 3 ? -0.14 : -0.04;
    return { digit: i, score: m * 0.55 + (freq30[i] ?? 0) * 0.25 + gapQ };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(s => s.digit);
}

/**
 * Pick optimal barrier for DIGITDIFF (Cold Dormancy Index)
 */
function pickBestDiffBarrier(digits: number[]): number {
  const bayes = bayesianMarkovProb(digits);
  const freq50 = digitFrequency(digits.slice(-50));
  const coldScore = bayes.map((m, i) => {
    const gap = digitGapSinceLast(digits, i);
    const gapPenalty = Math.max(0, 10 - Math.min(gap, 10)) / 10 * 0.15;
    return m * 0.50 + (freq50[i] ?? 0) * 0.35 + gapPenalty;
  });
  return coldScore.indexOf(Math.min(...coldScore));
}

/**
 * Extract OVER and UNDER barriers from the barriers array
 */
function extractBarriers(barriers: number[]): { overBarrier: number; underBarrier: number } {
  const overBarrier  = barriers.length > 0 ? barriers[0] : 1;
  const underBarrier = barriers.length > 1 ? barriers[1] : 8;
  return { overBarrier, underBarrier };
}

// ── Quantum Scorer (PrecisionAI v4) ──────────────────────────────────────────

/**
 * PrecisionAI v4 Quantum Market Scorer
 * Integrates 2nd-Order Bayesian Markov + Shannon Entropy + Geometric Hazard Fatigue + Kinematics + EV Gating
 */
function precisionScore(
  symbol: string,
  displayName: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
  minDigitSamples = 25,
): MarketScore | null {
  if (contractType.startsWith("DIGIT") && digits.length < minDigitSamples) return null;
  if ((contractType === "CALL" || contractType === "PUT") && prices.length < 15) return null;

  const winLen        = Math.min(50, digits.length);
  const freq50        = digitFrequency(digits.slice(-winLen));
  const bayesMarkov   = bayesianMarkovProb(digits);
  const momentum      = momentumRate(digits, contractType, barrier, 15);
  const timing        = entryTimingScore(digits, prices, contractType, barrier);
  const mom30         = momentumRate(digits, contractType, barrier, Math.min(30, digits.length));
  const stabilityRaw  = Math.max(0, 1 - Math.abs(mom30 - momentum) / 0.30);
  const entropy       = computeShannonEntropy(digits, 50);

  let empirical: number;
  let markovWin: number;
  let payout: number;
  let signalBonus = 0;

  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return null;
      empirical = freq50.slice(barrier + 1).reduce((a, b) => a + b, 0);
      markovWin = bayesMarkov.slice(barrier + 1).reduce((a, b) => a + b, 0);
      payout    = OVER_PAYOUTS[barrier] ?? OVER_PAYOUTS[4];
      const fatigue = calculateStreakFatigue(digits, "DIGITOVER", barrier);
      signalBonus = fatigue.hazardBonus;
      break;
    }
    case "DIGITUNDER": {
      if (barrier === undefined) return null;
      empirical = freq50.slice(0, barrier).reduce((a, b) => a + b, 0);
      markovWin = bayesMarkov.slice(0, barrier).reduce((a, b) => a + b, 0);
      payout    = UNDER_PAYOUTS[barrier] ?? UNDER_PAYOUTS[5];
      const fatigue = calculateStreakFatigue(digits, "DIGITUNDER", barrier);
      signalBonus = fatigue.hazardBonus;
      break;
    }
    case "DIGITEVEN": {
      empirical = [0, 2, 4, 6, 8].reduce((s, d) => s + (freq50[d] ?? 0), 0);
      markovWin = [0, 2, 4, 6, 8].reduce((s, d) => s + (bayesMarkov[d] ?? 0), 0);
      payout    = EVEN_ODD_PAYOUT;
      const fatigue = calculateStreakFatigue(digits, "DIGITEVEN", undefined);
      signalBonus = fatigue.hazardBonus;
      break;
    }
    case "DIGITODD": {
      empirical = [1, 3, 5, 7, 9].reduce((s, d) => s + (freq50[d] ?? 0), 0);
      markovWin = [1, 3, 5, 7, 9].reduce((s, d) => s + (bayesMarkov[d] ?? 0), 0);
      payout    = EVEN_ODD_PAYOUT;
      const fatigue = calculateStreakFatigue(digits, "DIGITODD", undefined);
      signalBonus = fatigue.hazardBonus;
      break;
    }
    case "DIGITMATCH": {
      if (barrier === undefined) return null;
      empirical = freq50[barrier] ?? 0.1;
      markovWin = bayesianMarkovToTarget(digits, barrier);
      payout    = MATCH_PAYOUT;
      const matchGap = digitGapSinceLast(digits, barrier);
      signalBonus = matchGap >= 3 && matchGap <= 9 ? 12
                  : matchGap >= 10 && matchGap <= 18 ? 4
                  : matchGap < 3 ? -10 : -5;
      break;
    }
    case "DIGITDIFF": {
      if (barrier === undefined) return null;
      empirical = 1 - (freq50[barrier] ?? 0.1);
      markovWin = 1 - bayesianMarkovToTarget(digits, barrier);
      payout    = DIFF_PAYOUT;
      const diffGap = digitGapSinceLast(digits, barrier);
      signalBonus = diffGap >= 10 ? 12 : diffGap >= 6 ? 6 : diffGap <= 1 ? -12 : -4;
      break;
    }
    case "CALL": {
      let ups = 0;
      for (let i = 1; i < prices.length; i++) if (prices[i] > prices[i - 1]) ups++;
      empirical = ups / Math.max(1, prices.length - 1);
      markovWin = empirical;
      payout    = RISE_FALL_PAYOUT;
      const kinematics = computePriceKinematics(prices, "CALL", 15);
      signalBonus = kinematics.signalBonus;
      break;
    }
    case "PUT": {
      let downs = 0;
      for (let i = 1; i < prices.length; i++) if (prices[i] < prices[i - 1]) downs++;
      empirical = downs / Math.max(1, prices.length - 1);
      markovWin = empirical;
      payout    = RISE_FALL_PAYOUT;
      const kinematics = computePriceKinematics(prices, "PUT", 15);
      signalBonus = kinematics.signalBonus;
      break;
    }
    default: return null;
  }

  // ── Bayesian Synthesis of Win Probability ─────────────────────────────────
  let winP: number;
  switch (contractType) {
    case "DIGITOVER":
    case "DIGITUNDER":
      winP = empirical * 0.35 + markovWin * 0.40 + momentum * 0.25;
      break;
    case "DIGITEVEN":
    case "DIGITODD":
      winP = empirical * 0.35 + momentum * 0.35 + markovWin * 0.30;
      break;
    case "DIGITMATCH":
      winP = markovWin * 0.60 + empirical * 0.25 + momentum * 0.15;
      break;
    case "DIGITDIFF":
      winP = empirical * 0.40 + markovWin * 0.45 + momentum * 0.15;
      break;
    case "CALL":
    case "PUT":
      winP = momentum * 0.50 + empirical * 0.30 + markovWin * 0.20;
      break;
    default:
      winP = empirical * 0.50 + markovWin * 0.25 + momentum * 0.25;
  }

  const theoretical    = theoreticalWinRate(contractType, barrier);
  const edgeNorm       = Math.max(-1, Math.min(1, (winP - theoretical) / 0.15));
  const timingBonus    = (timing - 50) * 0.20;       // ±10 pts
  const stabilityBonus = (stabilityRaw - 0.5) * 10;  // ±5 pts
  const entropyBonus   = entropy.bonus;              // ±15 pts

  // ── Quantum analysis layer (additive statistical core, methods 1–5) ────────
  // The engine's edge judgment becomes a two-expert committee:
  //   50% the original raw-edge voice (unchanged),
  //   50% the significance-weighted, structure-gated z-edge (z·λ — honest
  //        about sample size σ and about whether the stream is structured).
  // The win probability is likewise blended with the confidence-weighted
  // estimator p̂, and three bounded timing terms are added (probabilistic
  // entry timing, market-specific streak-break hazard, entropy onset).
  // Every original term above stays exactly as it was.
  const q             = quantumWindowEstimate(digits, prices, contractType, barrier);
  const zQuality      = zEdgeQuality(q);
  const quantumTiming = quantumTimingScore(q);
  const hazardQ       = hazardTimingBonus(q);
  const onsetQ        = entropyOnsetBonus(q);
  const edgeCommittee = 0.5 * edgeNorm + 0.5 * zQuality;
  const winPfinal     = Math.max(0.01, Math.min(0.99, winP * 0.5 + q.pHat * 0.5));

  // Calculate Net Expected Value (on the committee win probability)
  const ev = winPfinal * (payout - 1) - (1 - winPfinal);
  const evBonus = ev >= 0.05 ? 8 : ev >= MIN_NORMAL_EV ? 3 : ev < 0 ? -12 : 0;

  const score = Math.min(100, Math.max(0,
    50 + edgeCommittee * 45 + timingBonus + (quantumTiming - 50) * 0.15 +
        stabilityBonus + signalBonus + entropyBonus + evBonus + hazardQ + onsetQ,
  ));

  const reason = [
    `${(winPfinal * 100).toFixed(1)}% win-p`,
    `EV ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`,
    `H ${entropy.bits}b`,
    `timing ${timing.toFixed(0)}`,
    signalBonus !== 0 ? `sig${signalBonus >= 0 ? "+" : ""}${signalBonus}` : "",
    q.neutral ? "" : `z${q.z >= 0 ? "+" : ""}${q.z.toFixed(1)}/λ${q.lambda.toFixed(2)}`,
    hazardQ !== 0 ? `hz${hazardQ >= 0 ? "+" : ""}${hazardQ}` : "",
    onsetQ !== 0 ? `onset${onsetQ >= 0 ? "+" : ""}${onsetQ.toFixed(1)}` : "",
  ].filter(Boolean).join(" · ");

  return {
    symbol,
    displayName,
    contractType,
    barrier,
    score,
    winProbability: winPfinal,
    payout,
    expectedValue: ev,
    entropyBits: entropy.bits,
    isStructured: entropy.isStructured,
    reason,
    quantum: q,
  };
}

/**
 * Green-Light Sub-Tick Entry Validator
 */
function isGreenLight(
  digits: number[],
  prices: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): boolean {
  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return true;
      const last5 = digits.slice(-5);
      const reversalCount = last5.filter(d => d <= barrier).length;
      const streak = streakAgainstLength(digits, "DIGITOVER", barrier);
      const highMomentum = momentumRate(digits, "DIGITOVER", barrier, 10) >= 0.65;
      return reversalCount >= 2 || streak >= 2 || highMomentum;
    }
    case "DIGITUNDER": {
      if (barrier === undefined) return true;
      const last5 = digits.slice(-5);
      const reversalCount = last5.filter(d => d >= barrier).length;
      const streak = streakAgainstLength(digits, "DIGITUNDER", barrier);
      const highMomentum = momentumRate(digits, "DIGITUNDER", barrier, 10) >= 0.65;
      return reversalCount >= 2 || streak >= 2 || highMomentum;
    }
    case "DIGITEVEN": {
      const oddStreak = streakAgainstLength(digits, "DIGITEVEN", undefined);
      const highFreq  = momentumRate(digits, "DIGITEVEN", undefined, 10) >= 0.60;
      return oddStreak >= 1 || highFreq;
    }
    case "DIGITODD": {
      const evenStreak = streakAgainstLength(digits, "DIGITODD", undefined);
      const highFreq   = momentumRate(digits, "DIGITODD", undefined, 10) >= 0.60;
      return evenStreak >= 1 || highFreq;
    }
    case "CALL": {
      if (prices.length < 3) return true;
      const k = computePriceKinematics(prices, "CALL", 12);
      const lastUp = prices[prices.length - 1] > prices[prices.length - 2];
      return (lastUp && k.isPersistent) || (k.isMeanReverting && k.signalBonus > 0);
    }
    case "PUT": {
      if (prices.length < 3) return true;
      const k = computePriceKinematics(prices, "PUT", 12);
      const lastDown = prices[prices.length - 1] < prices[prices.length - 2];
      return (lastDown && k.isPersistent) || (k.isMeanReverting && k.signalBonus > 0);
    }
    case "DIGITMATCH": {
      if (barrier === undefined) return true;
      const gap = digitGapSinceLast(digits, barrier);
      const bayesProb = bayesianMarkovToTarget(digits, barrier);
      return (gap >= 3 && gap <= 10) || bayesProb >= 0.15;
    }
    case "DIGITDIFF": {
      if (barrier === undefined) return true;
      return digitGapSinceLast(digits, barrier) >= 5;
    }
    default: return true;
  }
}

/**
 * Sniper Recovery Deep Signal Divergence (+20 / -15 pts)
 */
function deepSniperBonus(
  contractType: SpeedContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
): number {
  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return 0;
      const d = digits.slice(-50);
      if (d.length < 10) return 0;
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      const variance = d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length;
      const z = (mean - 4.5) / (Math.sqrt(variance / d.length) || 0.1);
      // Extreme negative Z = digits running low = OVER sniper edge
      const zB = z < -1.85 ? 14 : z < -1.4 ? 8 : z < -1.0 ? 4 : z > 1.5 ? -12 : z > 1.0 ? -6 : 0;
      const d20 = digits.slice(-20);
      const aboveRate = d20.length > 0 ? d20.filter(v => v > barrier).length / d20.length : 0;
      const fB = aboveRate >= 0.65 ? 6 : aboveRate >= 0.55 ? 2 : aboveRate <= 0.25 ? -8 : 0;
      return Math.max(-15, Math.min(20, zB + fB));
    }
    case "DIGITUNDER": {
      if (barrier === undefined) return 0;
      const d = digits.slice(-50);
      if (d.length < 10) return 0;
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      const variance = d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length;
      const z = (mean - 4.5) / (Math.sqrt(variance / d.length) || 0.1);
      const zB = z > 1.85 ? 14 : z > 1.4 ? 8 : z > 1.0 ? 4 : z < -1.5 ? -12 : z < -1.0 ? -6 : 0;
      const d20 = digits.slice(-20);
      const belowRate = d20.length > 0 ? d20.filter(v => v < barrier).length / d20.length : 0;
      const fB = belowRate >= 0.65 ? 6 : belowRate >= 0.55 ? 2 : belowRate <= 0.25 ? -8 : 0;
      return Math.max(-15, Math.min(20, zB + fB));
    }
    case "DIGITEVEN": {
      const d = digits.slice(-40);
      if (d.length < 10) return 0;
      const evenCnt = d.filter(v => v % 2 === 0).length;
      const oddRate = (d.length - evenCnt) / d.length;
      const bB = oddRate >= 0.65 ? 15 : oddRate >= 0.58 ? 8 : oddRate >= 0.52 ? 3
               : oddRate <= 0.35 ? -12 : oddRate <= 0.42 ? -6 : 0;
      const exp = d.length / 2;
      const chi2 = (evenCnt - exp) ** 2 / exp + ((d.length - evenCnt) - exp) ** 2 / exp;
      const cB = chi2 > 3.84 && evenCnt < exp ? 5 : chi2 > 3.84 && evenCnt > exp ? -5 : 0;
      return Math.max(-15, Math.min(20, bB + cB));
    }
    case "DIGITODD": {
      const d = digits.slice(-40);
      if (d.length < 10) return 0;
      const evenCnt = d.filter(v => v % 2 === 0).length;
      const evenRate = evenCnt / d.length;
      const bB = evenRate >= 0.65 ? 15 : evenRate >= 0.58 ? 8 : evenRate >= 0.52 ? 3
               : evenRate <= 0.35 ? -12 : evenRate <= 0.42 ? -6 : 0;
      const exp = d.length / 2;
      const chi2 = (evenCnt - exp) ** 2 / exp + ((d.length - evenCnt) - exp) ** 2 / exp;
      const cB = chi2 > 3.84 && evenCnt > exp ? 5 : chi2 > 3.84 && evenCnt < exp ? -5 : 0;
      return Math.max(-15, Math.min(20, bB + cB));
    }
    case "DIGITMATCH": {
      if (barrier === undefined) return 0;
      const gap = digitGapSinceLast(digits, barrier);
      const gB = gap >= 4 && gap <= 9 ? 14 : gap >= 3 && gap <= 11 ? 7 : gap < 3 ? -14 : -5;
      const d30 = digits.slice(-30);
      const freq = d30.length > 0 ? d30.filter(v => v === barrier).length / d30.length : 0;
      const fB = freq >= 0.08 && freq <= 0.18 ? 6 : freq > 0.25 ? -10 : 0;
      return Math.max(-15, Math.min(20, gB + fB));
    }
    case "DIGITDIFF": {
      if (barrier === undefined) return 0;
      const gap = digitGapSinceLast(digits, barrier);
      const gB = gap >= 12 ? 15 : gap >= 8 ? 8 : gap <= 2 ? -15 : -4;
      const d50 = digits.slice(-50);
      const freq = d50.length > 0 ? d50.filter(v => v === barrier).length / d50.length : 0;
      const fB = freq <= 0.04 ? 8 : freq <= 0.08 ? 3 : freq >= 0.18 ? -12 : 0;
      return Math.max(-15, Math.min(20, gB + fB));
    }
    case "CALL":
    case "PUT": {
      const k = computePriceKinematics(prices, contractType, 15);
      return k.signalBonus;
    }
    default: return 0;
  }
}

function recoveryGateRequirements(
  contractType: SpeedContractType,
  barrier: number | undefined,
): { requiredScore: number; requiredEv: number } {
  const theoretical = theoreticalWinRate(contractType, barrier);

  if (theoretical >= 0.70) {
    return { requiredScore: 60, requiredEv: 0.018 };
  }
  if (theoretical <= 0.30) {
    return { requiredScore: 62, requiredEv: 0.035 };
  }
  return { requiredScore: 60, requiredEv: 0.020 };
}

/**
 * FastRecoveryGate v4 (Sniper Protocol)
 * 4-Window Analysis (15t, 30t, 60t, 100t) with Window Concurrence + Anti-Pattern Decaying Penalty
 */
function fastRecoveryGate(
  symbol: string,
  displayName: string,
  contractTypes: SpeedContractType[],
  barriers: number[],
  _consecutiveLosses: number,
  recentRecoveryTrades: RecoveryTradeRecord[],
): { winner: MarketScore; greenLight: boolean } | null {
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  const digits100 = tickManager.getDigits(symbol, 100);
  const prices50  = tickManager.getTicks(symbol, 50);
  if (digits100.length < 25) return null;

  const digits60 = digits100.slice(-60);
  const digits30 = digits100.slice(-30);
  const digits15 = digits100.slice(-15);

  // Anti-pattern decaying penalty map
  const penaltyMap = new Map<string, number>();
  for (let i = recentRecoveryTrades.length - 1; i >= 0; i--) {
    const t = recentRecoveryTrades[i];
    const key = `${t.contractType}_${t.barrier ?? ""}`;
    if (!t.won) {
      const existing = penaltyMap.get(key) ?? 0;
      const agePenalty = Math.max(0, 10 - (recentRecoveryTrades.length - 1 - i) * 2);
      penaltyMap.set(key, Math.max(existing, agePenalty));
    } else {
      penaltyMap.delete(key);
    }
  }

  // Expand candidates: MATCH gets top-3 barriers
  const expandedEntries: Array<{ ct: SpeedContractType; barrier: number | undefined }> = [];
  for (const ct of contractTypes) {
    if      (ct === "DIGITOVER")  { expandedEntries.push({ ct, barrier: overBarrier }); }
    else if (ct === "DIGITUNDER") { expandedEntries.push({ ct, barrier: underBarrier }); }
    else if (ct === "DIGITMATCH") {
      for (const b of pickTopMatchBarriers(digits60, 3)) {
        expandedEntries.push({ ct, barrier: b });
      }
    }
    else if (ct === "DIGITDIFF")  { expandedEntries.push({ ct, barrier: pickBestDiffBarrier(digits60) }); }
    else                          { expandedEntries.push({ ct, barrier: undefined }); }
  }

  const candidates: (MarketScore & { greenLight: boolean })[] = [];

  for (const { ct, barrier } of expandedEntries) {
    const r100 = precisionScore(symbol, displayName, ct, barrier, digits100, prices50);
    const r60  = precisionScore(symbol, displayName, ct, barrier, digits60,  prices50);
    const r30  = precisionScore(symbol, displayName, ct, barrier, digits30,  prices50);
    const r15  = digits15.length >= 15
      ? precisionScore(symbol, displayName, ct, barrier, digits15, prices50, 15)
      : null;
    if (!r60 || !r30 || !r15 || !r60.quantum) continue;

    const s100 = r100?.score ?? r60.score;
    const s60  = r60.score;
    const s30  = r30.score;
    const s15  = r15.score;

    // Moderate window concurrence: immediate and macro windows should align,
    // while every active window must independently show a usable edge.
    if (Math.abs(s15 - s60) > 25) continue;
    if (s15 < 58 || s30 < 58 || s60 < 58) continue;

    // 4-Window Weighted Blend: Immediate(20%) + Short(30%) + Mid(35%) + Macro(15%)
    const baseScore = Math.round((s15 * 0.20 + s30 * 0.30 + s60 * 0.35 + s100 * 0.15) * 10) / 10;
    const sBonus    = deepSniperBonus(ct, barrier, digits60, prices50);
    const penalty   = penaltyMap.get(`${ct}_${barrier ?? ""}`) ?? 0;

    // ── Quantum layer (methods 4 + 7): temporal stability & self-measurement ─
    // Each window carries its own (p̂, σ) from precisionScore. The shared-CI
    // check asks whether ALL time-scales independently see a real edge, and
    // the trend check asks which direction the edge is heading. Pure
    // bonus/penalty terms — disagreement never rejects (the thresholds above
    // and below still decide); it only re-ranks the recovery candidates.
    const q15  = r15.quantum ?? r60.quantum;
    const q30  = r30.quantum ?? r60.quantum;
    const q60  = r60.quantum;
    const q100 = r100?.quantum ?? q60;
    const ciB  = ciOverlapBonus([q15, q30, q60, q100]);
    const trB  = edgeTrendBonus(q60, q100);
    const decision: DecisionFeatures = {
      z:              q60.z,
      lambda:         q60.lambda,
      timing:         quantumTimingScore(q60),
      hazardRelative: q60.hazardRelative,
      entropyDelta:   q100.entropyDelta,
      ciOverlap:      ciOverlapWidth([q15, q30, q60, q100]),
    };
    const meta = metaBonus(decision, "recovery");

    const adjustedScore = baseScore + sBonus - penalty + ciB + trB + meta;
    const { requiredScore, requiredEv } = recoveryGateRequirements(ct, barrier);
    if (adjustedScore < requiredScore || r60.expectedValue < requiredEv) continue;

    const gl = isGreenLight(digits60, prices50, ct, barrier);
    candidates.push({
      ...r60,
      barrier,
      score: adjustedScore,
      reason: `${r60.reason} | 4W ${s15.toFixed(0)}/${s30.toFixed(0)}/${s60.toFixed(0)}/${s100.toFixed(0)} d${sBonus >= 0 ? "+" : ""}${sBonus}${penalty > 0 ? ` p-${penalty}` : ""}${ciB !== 0 ? ` ci+${ciB}` : ""}${trB !== 0 ? ` tr${trB >= 0 ? "+" : ""}${trB}` : ""}${meta !== 0 ? ` meta${meta >= 0 ? "+" : ""}${meta}` : ""}`,
      greenLight: gl,
      decision,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.greenLight !== b.greenLight) return a.greenLight ? -1 : 1;
    if (Math.abs(a.score - b.score) > 2) return b.score - a.score;
    // Near-ties: rank by the statistical significance of the edge (z vs
    // break-even) — "best recovery trade" = most significant edge.
    return (b.decision?.z ?? 0) - (a.decision?.z ?? 0);
  });

  const best = candidates[0]!;
  return { winner: best, greenLight: best.greenLight };
}

/**
 * Micro-Polling Green-Light Waiter (90ms intervals, max 2.8s)
 */
async function waitForGreenLight(
  symbol: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  maxWaitMs = 2800,
  pollMs    = 90,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!session.running || session.stopRequested) return false;
    const d = tickManager.getDigits(symbol, 60);
    const p = tickManager.getTicks(symbol, 50);
    if (isGreenLight(d, p, contractType, barrier)) return true;
    await sleep(pollMs);
  }
  return false;
}

// ── Manual Assist Evaluation (for manual trading) ─────────────────────────────
// Uses same Quantum scorer but simplified to Ready/Wait for the user's exact
// contract + barrier + duration. Hides technical metrics from the UI layer.
export function evaluateManualAssist(
  symbol: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  duration: number,
): { ready: boolean; score: number; winProbability: number; expectedValue: number; reason: string; greenLight: boolean; entropyBits: number } {
  const digits = tickManager.getDigits(symbol, 100);
  const prices = tickManager.getTicks(symbol, 50);
  const displayName = DERIV_MARKETS.find(m => m.symbol === symbol)?.displayName ?? symbol;

  if (contractType.startsWith("DIGIT") && digits.length < 25) {
    return { ready: false, score: 0, winProbability: 0, expectedValue: -1, reason: "Collecting digit data…", greenLight: false, entropyBits: 3.32 };
  }
  if ((contractType === "CALL" || contractType === "PUT") && prices.length < 15) {
    return { ready: false, score: 0, winProbability: 0, expectedValue: -1, reason: "Collecting price data…", greenLight: false, entropyBits: 3.32 };
  }

  const scoredRaw = precisionScore(symbol, displayName, contractType, barrier, digits, prices);
  if (!scoredRaw) {
    return { ready: false, score: 0, winProbability: 0, expectedValue: -1, reason: "Insufficient data for this contract", greenLight: false, entropyBits: 3.32 };
  }

  // Method 7 — self-measured signal value (normal pool, bounded ±6)
  const scored = {
    ...scoredRaw,
    score: scoredRaw.score + metaBonus(decisionFromWindows([scoredRaw]), "normal"),
  };

  const greenLight = isGreenLight(digits, prices, contractType, barrier);
  const entropy = computeShannonEntropy(digits, 50);

  // Duration-aware thresholds: 1 tick is noisiest, require higher quality
  let requiredScore = 56;
  let requiredEv = 0.015;
  if (duration === 1) {
    requiredScore = 62;
    requiredEv = 0.02;
  } else if (duration >= 2 && duration <= 3) {
    requiredScore = 58;
    requiredEv = 0.015;
  } else if (duration >= 4 && duration <= 6) {
    requiredScore = 54;
    requiredEv = 0.012;
  } else if (duration >= 7) {
    requiredScore = 52;
    requiredEv = 0.01;
  }

  // White noise entropy gate: if digits are pure noise, force wait regardless of score
  if (entropy.isWhiteNoise) {
    return { ready: false, score: scored.score, winProbability: scored.winProbability, expectedValue: scored.expectedValue, reason: "Market is choppy — waiting for clearer structure", greenLight, entropyBits: entropy.bits };
  }

  // Green light is critical for 1-tick, important for others but not absolute
  const greenOk = duration === 1 ? greenLight : (greenLight || scored.score >= 68);

  const ready = scored.score >= requiredScore && scored.expectedValue >= requiredEv && greenOk && !entropy.isWhiteNoise;

  let reason: string;
  if (!ready) {
    if (scored.score < requiredScore) {
      reason = `AI quality ${scored.score.toFixed(0)}/100 not yet optimal for ${duration} ticks — holding…`;
    } else if (scored.expectedValue < requiredEv) {
      reason = "No positive edge detected — waiting for better entry…";
    } else if (!greenOk) {
      reason = duration === 1 ? "Waiting for green-light tick — extreme precision needed for 1 tick…" : "Timing not yet optimal — hold for better entry…";
    } else {
      reason = "AI is analyzing timing — hold for better entry…";
    }
  } else {
    reason = `Good timing — AI confirms ${contractType}${barrier !== undefined ? ` ${barrier}` : ""} for ${duration} ticks.`;
  }

  return { ready, score: scored.score, winProbability: scored.winProbability, expectedValue: scored.expectedValue, reason, greenLight, entropyBits: entropy.bits };
}


// ── Market Strategy Analysis ──────────────────────────────────────────────────

/**
 * Score all markets for the given contract types and barriers (Three-window blend).
 */
export async function analyzeMarketsForStrategy(
  contractTypes: SpeedContractType[],
  barriers: number[],
  /** Method 7 — which self-measurement pool the meta-bonus draws from. */
  signalMode: SignalMode = "normal",
): Promise<MarketScore[]> {
  const scored: MarketScore[] = [];
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  for (const market of AUTOMATED_DERIV_MARKETS) {
    if (!market.digitEnabled && contractTypes.some(ct => ct.startsWith("DIGIT"))) continue;

    const digits100 = tickManager.getDigits(market.symbol, 100);
    const digits60  = digits100.slice(-60);
    const digits30  = digits100.slice(-30);
    const prices    = tickManager.getTicks(market.symbol, 50);

    for (const ct of contractTypes) {
      let barrier: number | undefined;
      if      (ct === "DIGITOVER")  barrier = overBarrier;
      else if (ct === "DIGITUNDER") barrier = underBarrier;
      else if (ct === "DIGITMATCH") {
        if (digits60.length < 25) continue;
        barrier = pickBestMatchBarrier(digits60);
      }
      else if (ct === "DIGITDIFF") {
        if (digits60.length < 25) continue;
        barrier = pickBestDiffBarrier(digits60);
      }

      const r100 = precisionScore(market.symbol, market.displayName, ct, barrier, digits100, prices);
      const r60  = precisionScore(market.symbol, market.displayName, ct, barrier, digits60,  prices);
      const r30  = precisionScore(market.symbol, market.displayName, ct, barrier, digits30,  prices);
      if (!r60 || !r60.quantum) continue;

      const combinedScore = Math.round(
        ((r30?.score ?? r60.score) * 0.25 + r60.score * 0.50 + (r100?.score ?? r60.score) * 0.25) * 10,
      ) / 10;
      // Method 7 — self-measured signal value: only features that have
      // actually predicted wins in this mode so far earn a bounded bonus.
      const decision: DecisionFeatures = decisionFromWindows([r30, r60, r100]);
      scored.push({
        ...r60,
        score: combinedScore + metaBonus(decision, signalMode),
        decision,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Build the method-7 decision-time feature vector from the per-window
 * quantum reads attached by precisionScore (r30/r60/r100).
 */
function decisionFromWindows(windows: (MarketScore | null | undefined)[]): DecisionFeatures {
  const base = windows.find(w => w?.quantum)?.quantum;
  const usable = windows
    .map(w => w?.quantum)
    .filter((x): x is QuantumFeatures => Boolean(x));
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
 * Score a single locked market across strategy contract types.
 */
export async function scoreSingleMarket(
  symbol: string,
  displayName: string,
  contractTypes: SpeedContractType[],
  barriers: number[],
  /** Method 7 — which self-measurement pool the meta-bonus draws from. */
  signalMode: SignalMode = "normal",
): Promise<MarketScore | null> {
  const digits100 = tickManager.getDigits(symbol, 100);
  const digits60  = digits100.slice(-60);
  const digits30  = digits100.slice(-30);
  const prices    = tickManager.getTicks(symbol, 50);
  const { overBarrier, underBarrier } = extractBarriers(barriers);
  const scored: MarketScore[] = [];

  for (const ct of contractTypes) {
    let barrier: number | undefined;
    if      (ct === "DIGITOVER")  barrier = overBarrier;
    else if (ct === "DIGITUNDER") barrier = underBarrier;
    else if (ct === "DIGITMATCH") barrier = pickBestMatchBarrier(digits60);
    else if (ct === "DIGITDIFF")  barrier = pickBestDiffBarrier(digits60);

    const r100 = precisionScore(symbol, displayName, ct, barrier, digits100, prices);
    const r60  = precisionScore(symbol, displayName, ct, barrier, digits60,  prices);
    const r30  = precisionScore(symbol, displayName, ct, barrier, digits30,  prices);
    if (!r60 || !r60.quantum) continue;

    const combinedScore = Math.round(
      ((r30?.score ?? r60.score) * 0.25 + r60.score * 0.50 + (r100?.score ?? r60.score) * 0.25) * 10,
    ) / 10;
    // Method 7 — self-measured signal value (bounded ±6, evidence only).
    const decision: DecisionFeatures = decisionFromWindows([r30, r60, r100]);
    scored.push({
      ...r60,
      score: combinedScore + metaBonus(decision, signalMode),
      decision,
    });
  }

  return scored.sort((a, b) => b.score - a.score)[0] ?? null;
}

/**
 * Comprehensive Market Scan: scores every automated-eligible market for normal and recovery modes.
 */
export async function scanBestMarket(config: SpeedAIConfig): Promise<ScanResult> {
  const candidatesBySymbol = new Map<string, MarketScore>();
  const total = AUTOMATED_DERIV_MARKETS.length;
  let scanned = 0;

  for (const market of AUTOMATED_DERIV_MARKETS) {
    broadcastSSE("speed_ai_scan_progress", {
      scanning: market.displayName,
      symbol: market.symbol,
      scanned,
      total,
      results: [...candidatesBySymbol.values()].sort((a, b) => b.score - a.score),
    }, config.ownerSessionId);

    const normalBest   = await scoreSingleMarket(market.symbol, market.displayName, config.normalContractTypes,   config.normalBarriers);
    const recoveryBest = await scoreSingleMarket(market.symbol, market.displayName, config.recoveryContractTypes, config.recoveryBarriers);

    scanned++;
    await sleep(240);

    if (!normalBest && !recoveryBest) continue;

    const normalScore   = normalBest?.score   ?? 0;
    const recoveryScore = recoveryBest?.score ?? 0;
    const combinedScore = Math.round((normalScore * 0.4 + recoveryScore * 0.6) * 10) / 10;

    const base = normalBest ?? recoveryBest!;
    candidatesBySymbol.set(market.symbol, {
      ...base,
      score:                combinedScore,
      normalScore:          Math.round(normalScore   * 10) / 10,
      recoveryScore:        Math.round(recoveryScore * 10) / 10,
      recoveryContractType: recoveryBest?.contractType,
      recoveryBarrier:      recoveryBest?.barrier,
    });
  }

  const allScored = [...candidatesBySymbol.values()].sort((a, b) => b.score - a.score);

  broadcastSSE("speed_ai_scan_progress", {
    scanning: null, symbol: null,
    scanned: total, total,
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

  const best     = allScored[0];
  const suitable = best.score >= SUITABLE_SCORE_THRESHOLD;
  const reason   = suitable
    ? `${best.displayName} shows high statistical edge (score ${best.score.toFixed(0)}/100, H=${best.entropyBits}b)`
    : `No market shows decisive edge yet — best was ${best.displayName} at ${best.score.toFixed(0)}/100`;

  return { suitable, best, allScored, reason };
}

// ── Recovery Stake Calculation ────────────────────────────────────────────────
//
// Sizing is delegated to the SHARED recovery ledger (recovery-engine.ts) so the
// FAB and the main autonomous engine always agree on debt, target, and the
// exact instant/split stake for the same account. The old per-session copy of
// this math is gone (it duplicated the formula against a private ledger).

function computeRecoveryStake(
  payout: number,
  winProbability: number,
  config: SpeedAIConfig,
  maxStake: number,
  availableBalance: number,
): number {
  if (!recoveryEngine.isInRecovery()) return config.stake;

  return recoveryEngine.getDynamicRecoveryStake(
    config.stake,
    maxStake,
    availableBalance,
    payout,
    winProbability,
    "moderate", // risk profile is not a FAB input — unused by the stake math
    config.recoveryMultiplier,
    config.recoveryMethod,
    config.maxRecoverySteps,
    config.recoveryAutoMode,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("speed_ai_update", getStatus(), ownerSessionId);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function getStatus(): SpeedAIStatus {
  const publicConfig = session.config
    ? Object.fromEntries(Object.entries(session.config).filter(([key]) => key !== "ownerSessionId")) as SpeedAIConfig
    : undefined;
  // Recovery fields come from the SHARED account ledger — the exact same debt,
  // step and target the dashboard card and the main autonomous engine see.
  const rec = recoveryEngine.getState();
  return {
    running:                   session.running,
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
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running       = false;
  session.message       = "Session stopped by user";
  releaseTradingOwnership("neuroai");
  broadcast();
  logger.info("NeuroAI FAB session stopped");
}

export async function startSession(config: SpeedAIConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A NeuroAI session is already active" };

  // ── Single-executor guard ──────────────────────────────────────────────────
  // Recovery debt is account-level and lives in one shared ledger. If the main
  // autonomous engine is currently executing trades, a second executor here
  // would race that ledger (two engines sizing stakes off the same debt at the
  // same time) — this was the root cause of the normal/recovery trade mix-up.
  if (!acquireTradingOwnership("neuroai")) {
    const owner = currentTradingOwner();
    const label = owner ? tradingOwnerLabel(owner) : "another engine";
    return {
      ok: false,
      error: `The ${label} is currently trading on this account. Stop it before starting NeuroAI — only one engine may trade (and own the recovery ledger) at a time.`,
    };
  }

  if (config.stake < 0.35)    { releaseTradingOwnership("neuroai"); return { ok: false, error: "Minimum stake is $0.35" }; }
  if (config.stopLoss <= 0)   { releaseTradingOwnership("neuroai"); return { ok: false, error: "Stop loss must be positive" }; }
  if (config.takeProfit <= 0) { releaseTradingOwnership("neuroai"); return { ok: false, error: "Take profit must be positive" }; }
  if (config.normalContractTypes.length   === 0) { releaseTradingOwnership("neuroai"); return { ok: false, error: "Select at least one normal contract type" }; }
  if (config.recoveryContractTypes.length === 0) { releaseTradingOwnership("neuroai"); return { ok: false, error: "Select at least one recovery contract type" }; }

  // FAB sessions inherit the account's current recovery state — if the shared
  // ledger still holds unrecovered debt (e.g. from autonomous or manual
  // trading), this session opens on recovery sizing, not the normal stake.
  const sharedRecovery = recoveryEngine.getState();

  // Method 7 — self-measured signal value starts fresh each session: the
  // engine re-learns which of its own features predict wins on this account's
  // markets as it trades.
  resetSignalValue();

  session = {
    running:      true,
    sessionId:    `neuro_${Date.now()}`,
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
      ? `Initializing Quantum Analysis Engine — entering in RECOVERY (shared ledger holds $${sharedRecovery.unrecoveredAmount.toFixed(2)} unrecovered)…`
      : "Initializing Quantum Analysis Engine…",
    lastEntropyBits: 3.32,
    lastEv: 0,
  };

  logger.info({ config, inheritedRecovery: sharedRecovery.inRecovery, inheritedDebt: sharedRecovery.unrecoveredAmount }, "NeuroAI FAB session starting");
  broadcast();

  runLoop(config).catch(err => {
    logger.error({ err }, "NeuroAI FAB runLoop error");
    session.running = false;
    session.message = `Error: ${err instanceof Error ? err.message : String(err)}`;
    broadcast();
  }).finally(() => {
    releaseTradingOwnership("neuroai");
  });

  return { ok: true };
}

// ── Quantum Execution Loop ────────────────────────────────────────────────────

async function runLoop(config: SpeedAIConfig) {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely";
    releaseTradingOwnership("neuroai");
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
  const lockedDerivsMarket = isLocked && config.lockedSymbol
    ? AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.lockedSymbol) ?? null
    : null;

  if (isLocked && config.lockedSymbol && !lockedDerivsMarket) {
    session.running = false;
    session.message = `⚠️ Market ${config.lockedSymbol} not found — session aborted`;
    broadcast();
    return;
  }

  let avgExecLatencyMs = 800;
  let preAnalyzedScored: MarketScore[] | null = null;
  let consecutiveErrors = 0;
  let lastTradeMs = Date.now();
  let awaitFreshRecoveryWindow = false;

  while (session.running && !session.stopRequested) {
    try {
    // ── Single-executor guard ────────────────────────────────────────────────
    // If the main autonomous engine has taken over trading, stop instead of
    // racing it against the same shared recovery ledger.
    if (!hasTradingOwnership("neuroai")) {
      const owner = currentTradingOwner();
      session.running = false;
      session.message = `⛔ Session stopped — the ${owner ? tradingOwnerLabel(owner) : "other engine"} is now trading this account. One shared recovery ledger = one trading engine at a time.`;
      broadcast();
      logger.warn({ owner }, "NeuroAI FAB halted: lost trading ownership");
      return;
    }

    // ── Stability: ensure tick stream is alive ───────────────────────────────
    const health = tickManager.getTickHealth();
    if (health.liveSymbols === 0 && !health.usingSimulated) {
      session.message = "Stabilizing tick feed — syncing markets…";
      broadcast();
      await sleep(1200);
      continue;
    }

    // ── Mode: Normal vs Recovery ──────────────────────────────────────────────
    // Mode comes from the SHARED account recovery ledger — the same source the
    // main autonomous engine, manual trades, and the dashboard card use. When
    // the ledger says the account is in recovery, this engine ONLY opens
    // recovery trades (recovery contract types + barriers); otherwise it ONLY
    // opens normal trades. No second opinion.
    const inRecovery    = recoveryEngine.isInRecovery();
    const contractTypes = inRecovery ? config.recoveryContractTypes : config.normalContractTypes;
    const barriers      = inRecovery ? config.recoveryBarriers      : config.normalBarriers;

    const usesDigitRecovery = contractTypes.some(ct => ct.startsWith("DIGIT"));

    if (awaitFreshRecoveryWindow && inRecovery && usesDigitRecovery) {
      const cooldownMs = 1200;
      if (Date.now() - lastTradeMs < cooldownMs) {
        session.message = "Stabilizing after recovery loss…";
        broadcast();
        await sleep(250);
        continue;
      }

      const freshDigits = lockedDerivsMarket
        ? tickManager.getDigits(lockedDerivsMarket.symbol, 100)
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

    let best: MarketScore | undefined;

    if (lockedDerivsMarket) {
      const cached = preAnalyzedScored?.find(m => m.symbol === lockedDerivsMarket.symbol);
      preAnalyzedScored = null;

      if (cached) {
        best = cached;
      } else {
        const result = await scoreSingleMarket(lockedDerivsMarket.symbol, lockedDerivsMarket.displayName, contractTypes, barriers, inRecovery ? "recovery" : "normal");
        if (!result) {
          session.message = "Waiting for tick data on locked market…";
          broadcast();
          await sleep(1500);
          continue;
        }
        best = result;
      }
      session.topMarkets = [best];
    } else {
      // Smart Market Switching Mode (strictly within user's configured contractTypes & barriers)
      if (preAnalyzedScored && preAnalyzedScored.length > 0) {
        const scored      = preAnalyzedScored;
        preAnalyzedScored = null;
        session.topMarkets = scored;

        if (scored[0].score < MIN_TRADE_SCORE) {
          session.message = `Scanning markets (best ${scored[0].displayName} ${scored[0].score}/100) — waiting for edge…`;
          broadcast();
          preAnalyzedScored = null;
          await sleep(1500);
          continue;
        }
        best = scored[0];
      } else {
        session.message = inRecovery ? "🎯 Sniper Scanning Recovery Markets…" : "Scanning Strategy Markets…";
        broadcast();
        const scored = await analyzeMarketsForStrategy(contractTypes, barriers, inRecovery ? "recovery" : "normal");
        session.topMarkets = scored;

        if (scored.length === 0) {
          session.message = "Waiting for tick data stream…";
          broadcast();
          await sleep(2000);
          continue;
        }
        if (scored[0].score < MIN_TRADE_SCORE) {
          session.message = `Awaiting high-probability setup (best ${scored[0].displayName} ${scored[0].score}/100)…`;
          broadcast();
          await sleep(1500);
          continue;
        }
        best = scored[0];
      }
    }

    session.lastEntropyBits = best.entropyBits;
    session.lastEv = Math.round(best.expectedValue * 1000) / 10;

    // ── Gating: Recovery Sniper vs Normal Trade ──────────────────────────────
    if (inRecovery) {
      const consLosses  = session.consecutiveRecoveryLosses;
      const maxAttempts = 4;
      let candidate: { winner: MarketScore; greenLight: boolean } | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        candidate = fastRecoveryGate(
          best.symbol, best.displayName,
          config.recoveryContractTypes, barriers, consLosses,
          session.patternTrades,
        );
        if (candidate) break;

        session.message = `🎯 Sniper Recovery Analysis (Attempt ${attempt + 1})…`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(750);
        if (!session.running || session.stopRequested) break;
      }

      if (!candidate) {
        const { overBarrier: recOver, underBarrier: recUnder } = extractBarriers(barriers);
        session.message = `🎯 Recovery analysis — over${recOver}/under${recUnder} edge ${Math.round(best.score)}/100, waiting for accurate setup…`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(1800);
        continue;
      }

      // Mandatory, moderate green-light timing gate. No weak fallback: if the
      // exact recovery barrier does not align, retry on the next cycle.
      if (!candidate.greenLight) {
        const glAchieved = await waitForGreenLight(
          best.symbol, candidate.winner.contractType, candidate.winner.barrier,
        );
        if (!session.running || session.stopRequested) break;
        if (!glAchieved) {
          const { overBarrier: recOver, underBarrier: recUnder } = extractBarriers(barriers);
          session.message = `Waiting for timed entry on over${recOver}/under${recUnder}…`;
          broadcast();
          preAnalyzedScored = null;
          continue;
        }
        const refreshed = fastRecoveryGate(
          best.symbol, best.displayName,
          config.recoveryContractTypes, barriers, consLosses,
          session.patternTrades,
        );
        if (refreshed && refreshed.greenLight) {
          candidate = refreshed;
        } else {
          const { overBarrier: recOver, underBarrier: recUnder } = extractBarriers(barriers);
          session.message = `Waiting for timed entry on over${recOver}/under${recUnder}…`;
          broadcast();
          preAnalyzedScored = null;
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
      };

    } else {
      // ── Normal Mode Entry Gating ───────────────────────────────────────────
      const normalDigits = tickManager.getDigits(best.symbol, 60);
      const normalPrices = tickManager.getTicks(best.symbol, 50);
      const gl = isGreenLight(normalDigits, normalPrices, best.contractType, best.barrier);

      if (!gl && best.score < 72) {
        session.message = `⏳ Awaiting optimal entry setup on ${best.displayName}…`;
        broadcast();
        preAnalyzedScored = null;
        for (let retry = 0; retry < 3; retry++) {
          await sleep(350);
          if (!session.running || session.stopRequested) break;
          const rDigits = tickManager.getDigits(best.symbol, 60);
          const rPrices = tickManager.getTicks(best.symbol, 50);
          if (isGreenLight(rDigits, rPrices, best.contractType, best.barrier)) break;
        }
      }
    }

    // Strict user contract sovereignty: never silently fire a wrong digit/contract.
    const allowedContracts = inRecovery ? config.recoveryContractTypes : config.normalContractTypes;
    if (!allowedContracts.includes(best.contractType)) {
      logger.warn({ got: best.contractType, allowed: allowedContracts, mode: inRecovery ? "recovery" : "normal" }, "Discarding trade outside configured contract family");
      session.message = "Waiting for configured contract setup…";
      broadcast();
      preAnalyzedScored = null;
      await sleep(750);
      continue;
    }
    const { overBarrier: expectedOver, underBarrier: expectedUnder } = extractBarriers(barriers);
    if (best.contractType === "DIGITOVER" && best.barrier !== expectedOver) {
      logger.warn({ expected: expectedOver, got: best.barrier, mode: inRecovery ? "recovery" : "normal" }, "Discarding DIGITOVER with wrong barrier");
      session.message = `Waiting for configured over${expectedOver} setup…`;
      broadcast();
      preAnalyzedScored = null;
      await sleep(750);
      continue;
    }
    if (best.contractType === "DIGITUNDER" && best.barrier !== expectedUnder) {
      logger.warn({ expected: expectedUnder, got: best.barrier, mode: inRecovery ? "recovery" : "normal" }, "Discarding DIGITUNDER with wrong barrier");
      session.message = `Waiting for configured under${expectedUnder} setup…`;
      broadcast();
      preAnalyzedScored = null;
      await sleep(750);
      continue;
    }

    // ── Method 6 — Execution-Tick Revalidation ────────────────────────────────
    // Re-read the decision's edge on the CURRENT tick, right before buy. The
    // green-light wait can hold a setup for up to ~28 ticks on 1-second
    // markets — an edge that was statistically significant at decision time
    // may have fully decayed by now. If the edge is gone (z ≤ 0, or less than
    // half of what it was at decision), the setup is stale: skip this cycle
    // and re-analyze. This is the analysis itself choosing the execution
    // moment — one sub-millisecond O(n) pass, no added thresholds on the
    // system, no extra latency on the execution path.
    const reDigits = tickManager.getDigits(best.symbol, 60);
    const rePrices = tickManager.getTicks(best.symbol, 50);
    const reReady = best.contractType === "CALL" || best.contractType === "PUT"
      ? rePrices.length >= 30
      : reDigits.length >= 30;
    if (reReady) {
      const fresh = quantumWindowEstimate(reDigits, rePrices, best.contractType, best.barrier);
      const entryZ = best.decision?.z ?? best.quantum?.z ?? 0;
      if (fresh.z <= 0 || fresh.z < 0.5 * entryZ) {
        session.message = `⏱️ Execution-tick revalidation: edge faded (z ${entryZ.toFixed(2)} → ${fresh.z.toFixed(2)}) — re-scanning for a live edge…`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(400);
        continue;
      }
    }

    // ── Pre-Warmed Proposal Quoting & Exact Sizing ─────────────────────────────
    const payoutQuote = await resolveRecoveryPayout({
      symbol: best.symbol,
      contractType: best.contractType,
      barrier: best.barrier,
      duration: 1,
      durationUnit: "t",
      currency,
    });
    best = { ...best, payout: payoutQuote.payoutMultiplier };

    // Recovery stake from the shared ledger: instant/split, multiplier, step
    // cap and debt amount all resolved in one shared code path (recovery-math)
    // that the main autonomous engine uses too.
    const stake = computeRecoveryStake(best.payout, best.winProbability, config, maxStake, availableBalance);
    const sharedStep = recoveryEngine.getState().recoveryStep;

    session.currentMarket       = best.displayName;
    session.currentContractType = best.contractType + (best.barrier !== undefined ? ` ${best.barrier}` : "");
    session.currentStake        = stake;
    session.message = inRecovery
      ? `🎯 [Sniper R${sharedStep}] ${best.contractType}${best.barrier !== undefined ? ` ${best.barrier}` : ""} on ${best.displayName}`
      : `⚡ Trading ${best.contractType}${best.barrier !== undefined ? ` ${best.barrier}` : ""} on ${best.displayName}`;
    broadcast();

    // ── Journaling: every FAB trade is a real account trade ──────────────────
    // FAB trades previously never reached the trades table, which hid them from
    // the journal AND from the main engine's open-trade guards (contributing to
    // the recovery mix-up confusion). Insert the row up-front, settle it after.
    const fabReason = `${inRecovery ? "[NEUROAI FAB RECOVERY] Sniper" : "[NEUROAI FAB]"} ${best.reason}`;
    const fabDirection = best.contractType === "CALL" ? "up" : best.contractType === "PUT" ? "down" : "hold";
    const actualPayoutForWin = stake * best.payout;
    const [fabTrade] = await db.insert(tradesTable).values({
      sessionId:    ownerSessionId,
      symbol:       best.symbol,
      displayName:  best.displayName,
      contractType: best.contractType,
      barrier:      best.barrier ?? null,
      stake:        String(Math.round(stake * 100) / 100),
      direction:    fabDirection,
      status:       "open",
      aiConfidence: String(Math.round(best.winProbability * 100)),
      aiRiskScore:  "60",
      isAutonomous: true,
      agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${fabReason}`,
      duration:     1,
      durationUnit: "t",
    }).returning();

    // ── Execute Trade ──────────────────────────────────────────────────────────
    const execStart = Date.now();
    let won: boolean;
    let profit: number;
    let entryPrice = tickManager.getLatestPrice(best.symbol) ?? 0;
    let exitPrice  = entryPrice;

    if (isLive) {
      try {
        logger.info({
          symbol:       best.symbol,
          contractType: best.contractType,
          barrier:      best.barrier,
          stake:        Math.round(stake * 100) / 100,
          inRecovery,
          step:         sharedStep,
        }, inRecovery ? "NeuroAI executing sniper recovery trade" : "NeuroAI executing normal trade");

        if (!isAutomatedMarket(best.symbol)) {
          throw new Error(`${best.displayName} is blocked from NeuroAI execution`);
        }
        const liveResult = await executeLiveTrade(token!, {
          symbol:       best.symbol,
          contractType: best.contractType,
          stake:        Math.round(stake * 100) / 100,
          duration:     1,
          durationUnit: "t",
          currency,
          accountId:    accounts[0].derivAccountId ?? accounts[0].loginId,
          barrier:      best.barrier,
        });
        const result = await waitForContractResult(
          token!, accounts[0].derivAccountId ?? accounts[0].loginId,
          liveResult.contractId, 30_000,
        );
        won    = result.won;
        profit = result.profit;
        entryPrice = Number(result.entrySpot) || liveResult.buyPrice;
        exitPrice  = Number(result.exitSpot)  || entryPrice;
      } catch (err) {
        // Outcome unknown — mark the journaled row as error, never as a loss.
        logger.warn({ err, symbol: best.symbol }, "NeuroAI live trade execution error — retrying");
        try {
          await db.update(tradesTable).set({
            status: "error", profit: "0", payout: "0", closedAt: new Date(),
            agentReasoning: `${fabReason} [EXECUTION FAILED: ${err instanceof Error ? err.message : String(err)}]`,
          }).where(eq(tradesTable.id, fabTrade.id));
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

    const execLatencyMs = Date.now() - execStart;
    avgExecLatencyMs    = Math.round(avgExecLatencyMs * 0.7 + execLatencyMs * 0.3);

    // ── Record Outcome & Settle Recovery State ────────────────────────────────
    // THE shared account ledger (same as the main autonomous engine + manual
    // trades + dashboard card). Instant vs split completion, debt-only exit,
    // and step counting are all decided there — once — so a covering win set by
    // ANY engine moves the WHOLE account back to normal mode, and any loss
    // moves it INTO recovery for every engine.
    session.tradeCount++;
    session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
    if (won) {
      session.winCount++;
      session.lastResult = "won";
    } else {
      session.lossCount++;
      session.lastResult = "lost";
    }

    recoveryEngine.recordOutcome(
      won, profit, stake, config.maxRecoverySteps, best.contractType, best.payout,
    );

    // ── Method 7 — Self-Measured Signal Value (the engine tunes itself) ──────
    // The features captured AT DECISION TIME plus this trade's realized
    // outcome feed the session's own signal valuation. Over the session, each
    // feature's top-tercile win-rate is compared with its bottom tercile and
    // only features with demonstrated lift earn bounded score weight. The
    // system literally measures, on these markets, which of its own signals
    // predict wins — normal and recovery trades pool separately.
    const dfRecord: DecisionFeatures = best.decision ?? {
      z:              best.quantum?.z ?? 0,
      lambda:         best.quantum?.lambda ?? 0.5,
      timing:         best.quantum ? quantumTimingScore(best.quantum) : 50,
      hazardRelative: best.quantum?.hazardRelative ?? 1,
      entropyDelta:   best.quantum?.entropyDelta ?? 0,
      ciOverlap:      0,
    };
    recordTradeSignal(inRecovery ? "recovery" : "normal", dfRecord, won);

    // FAB-local anti-pattern memory (sniper gate penalty decay). Mode/debt are
    // never derived from this — only from the shared ledger above.
    if (inRecovery) {
      const rec: RecoveryTradeRecord = { contractType: best.contractType, barrier: best.barrier, won };
      session.patternTrades = [...session.patternTrades, rec].slice(-8);
      session.consecutiveRecoveryLosses = won ? 0 : session.consecutiveRecoveryLosses + 1;
      if (!recoveryEngine.isInRecovery()) {
        // The win just cleared the shared debt — reset anti-pattern memory,
        // mirroring the old per-session state completion behaviour.
        session.patternTrades = [];
        session.consecutiveRecoveryLosses = 0;
      }
    }

    // Settle the journaled trade row.
    try {
      await db.update(tradesTable).set({
        status:     won ? "won" : "lost",
        payout:     String(won ? Math.round((stake + profit) * 100) / 100 : 0),
        profit:     String(Math.round(profit * 100) / 100),
        entryPrice: String(entryPrice),
        exitPrice:  String(exitPrice),
        closedAt:   new Date(),
      }).where(eq(tradesTable.id, fabTrade.id));
    } catch (dbErr) {
      logger.warn({ dbErr, tradeId: fabTrade.id }, "NeuroAI: failed to settle journaled trade row (stale-open guard will recover it)");
    }

    if (!isLive && Number.isFinite(availableBalance)) {
      availableBalance = Math.max(0, availableBalance + profit);
    }

    if (isLive) {
      try {
        const newBal = await getLiveBalance(
          token!, accounts[0]?.derivAccountId ?? accounts[0]?.loginId,
        );
        if (newBal !== null && accounts.length > 0) {
          availableBalance = newBal;
          await db.update(accountsTable)
            .set({ balance: String(newBal), updatedAt: new Date() })
            .where(eq(accountsTable.id, accounts[0].id));
        }
      } catch { /* best-effort */ }
    }

    broadcast();

    // ── TP / SL Boundary Checks ───────────────────────────────────────────────
    if (session.totalProfit >= config.takeProfit) {
      session.running = false;
      session.message = `✅ Take profit target $${config.takeProfit.toFixed(2)} reached! Session complete.`;
      broadcast();
      logger.info({ profit: session.totalProfit }, "NeuroAI take profit reached");
      return;
    }
    if (session.totalProfit <= -config.stopLoss) {
      session.running = false;
      session.message = `🛑 Stop loss limit $${config.stopLoss.toFixed(2)} hit. Session stopped safely.`;
      broadcast();
      logger.info({ profit: session.totalProfit }, "NeuroAI stop loss triggered");
      return;
    }
    const sharedStateAfter = recoveryEngine.getState();
    if (sharedStateAfter.inRecovery && sharedStateAfter.recoveryStep >= config.maxRecoverySteps) {
      session.message = `⚡ Max recovery step reached (${config.maxRecoverySteps}) — maintaining stake limit`;
      broadcast();
    }

    // ── Parallel Pre-Analysis During Post-Trade Settling ──────────────────────
    const nextInRecovery    = recoveryEngine.isInRecovery();
    const nextContractTypes = nextInRecovery ? config.recoveryContractTypes : config.normalContractTypes;
    const nextBarriers      = nextInRecovery ? config.recoveryBarriers      : config.normalBarriers;

    // Moderate stabilization after execution: accuracy/timing > raw speed.
    const pauseMs = won ? 900 : 1600;
    if (!won && (inRecovery || nextInRecovery)) {
      awaitFreshRecoveryWindow = true;
    }

    const preAnalyzePromise = lockedDerivsMarket
      ? scoreSingleMarket(lockedDerivsMarket.symbol, lockedDerivsMarket.displayName, nextContractTypes, nextBarriers, nextInRecovery ? "recovery" : "normal")
          .then(r => r ? [r] : [])
      : analyzeMarketsForStrategy(nextContractTypes, nextBarriers, nextInRecovery ? "recovery" : "normal");

    await sleep(pauseMs);
    if (!session.running || session.stopRequested) break;

    try {
      const result = await Promise.race([
        preAnalyzePromise,
        new Promise<MarketScore[]>((_, reject) => setTimeout(() => reject(new Error("pre-analysis timeout")), 4000))
      ]);
      preAnalyzedScored = result.length > 0 ? result : null;
    } catch (e) {
      logger.warn({ e }, "Pre-analysis timeout or error — will rescan");
      preAnalyzedScored = null;
    }

    // Throttle: prevent hammering on rapid losses
    const now = Date.now();
    const sinceLast = now - lastTradeMs;
    lastTradeMs = now;
    consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "NeuroAI runLoop stability catch");
      session.message = consecutiveErrors > 3
        ? `Engine stabilizing… retry ${consecutiveErrors}/5`
        : "Stabilizing engine — retrying…";
      broadcast();
      await sleep(Math.min(2000, 500 * consecutiveErrors));
      if (consecutiveErrors >= 5) {
        session.running = false;
        session.message = "Engine paused for stability check — please restart";
        broadcast();
        logger.error("NeuroAI halted after 5 consecutive errors");
        return;
      }
      continue;
    }
  }

  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}
