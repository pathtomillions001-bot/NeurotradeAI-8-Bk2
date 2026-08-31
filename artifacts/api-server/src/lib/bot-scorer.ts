/**
 * Specialist Bot Scorer.
 *
 * The analysis core of the AI Bots section. Every formula here is COPIED
 * verbatim from the NeuroAI Quantum FAB (`lib/speed-ai-engine.ts`) so a bot
 * scores a market exactly the way the FAB does — same Bayesian Markov
 * synthesis, same Shannon entropy gate, same geometric hazard fatigue, same
 * price kinematics, same quantum layer, same green light, same sniper windows.
 *
 * The FAB file itself is deliberately NOT modified and NOT imported for these
 * functions: the two engines must stay independently reviewable, and the FAB is
 * in production use. If you change a formula here, check whether the FAB needs
 * the same change (and vice-versa).
 *
 * What is NEW, and only possible because each bot trades ONE contract family,
 * is the Specialist Analysis Layer (`lib/specialist-analysis.ts`): a bounded
 * additive bonus, a dedicated entry-timing gate and a side arbitration with
 * hysteresis. A generalist cannot afford these estimators on six families at
 * once; a specialist runs them on every tick for free.
 */

import {
  OVER_PAYOUTS,
  UNDER_PAYOUTS,
  EVEN_ODD_PAYOUT,
  RISE_FALL_PAYOUT,
  MATCH_PAYOUT,
  DIFF_PAYOUT,
} from "./payouts";
import {
  quantumWindowEstimate,
  zEdgeQuality,
  quantumTimingScore,
  hazardTimingBonus,
  entropyOnsetBonus,
  type QuantumFeatures,
} from "./quantum-analysis";
import type { DecisionFeatures } from "./signal-value";
import {
  parityRead,
  barrierRead,
  matchRead,
  differRead,
  momentumRead,
  specialistEntryGate,
  type DigitCandidate,
  type SpecialistRead,
} from "./specialist-analysis";

export type BotContractType =
  | "DIGITOVER" | "DIGITUNDER"
  | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF"
  | "CALL" | "PUT";

/** Minimum entropy (bits) above which the digit stream is treated as white noise. */
const ENTROPY_WHITE_NOISE_LIMIT = 3.275;

export interface BotMarketScore {
  symbol: string;
  displayName: string;
  contractType: BotContractType;
  barrier?: number;
  score: number;
  winProbability: number;
  payout: number;
  expectedValue: number;
  entropyBits: number;
  isStructured: boolean;
  reason: string;
  quantum?: QuantumFeatures;
  decision?: DecisionFeatures;
  /** Specialist layer output for this candidate. */
  specialist?: SpecialistRead;
  /** Digit candidate table (match/differ bots) for the UI. */
  digitCandidates?: DigitCandidate[];
}

// ── Copied verbatim from the NeuroAI Quantum FAB ──────────────────────────────

export function digitFrequency(digits: number[]): number[] {
  const counts = Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) counts[d]++;
  const n = digits.length || 1;
  return counts.map(c => c / n);
}

export function markovNextProb(digits: number[]): number[] {
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

export function markov2ndOrderNextProb(digits: number[]): { probs: number[]; sampleCount: number } {
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

export function bayesianMarkovProb(digits: number[]): number[] {
  const p1 = markovNextProb(digits);
  const p2Data = markov2ndOrderNextProb(digits);
  const w2 = Math.min(0.60, p2Data.sampleCount * 0.15);
  const w1 = 1 - w2;
  return p1.map((val, idx) => val * w1 + p2Data.probs[idx] * w2);
}

export function bayesianMarkovToTarget(digits: number[], targetDigit: number): number {
  const probs = bayesianMarkovProb(digits);
  return probs[targetDigit] ?? 0.1;
}

export interface BotShannonEntropy {
  bits: number;
  ratio: number;
  isWhiteNoise: boolean;
  isStructured: boolean;
  bonus: number;
}

export function computeShannonEntropy(digits: number[], window = 50): BotShannonEntropy {
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
  const maxH = Math.log2(10);
  const ratio = h / maxH;
  const isWhiteNoise = h >= ENTROPY_WHITE_NOISE_LIMIT;
  const isStructured = h <= 3.12;

  let bonus = 0;
  if (isWhiteNoise) {
    bonus = -12;
  } else if (isStructured) {
    bonus = Math.min(15, Math.round((3.15 - h) * 50));
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

export function streakAgainstLength(
  digits: number[],
  contractType: BotContractType,
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

export function calculateStreakFatigue(
  digits: number[],
  contractType: BotContractType,
  barrier: number | undefined,
): { streakAgainst: number; fatigueScore: number; hazardBonus: number; isInflection: boolean } {
  const k = streakAgainstLength(digits, contractType, barrier);
  if (k === 0) return { streakAgainst: 0, fatigueScore: 0, hazardBonus: 0, isInflection: false };

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

export function digitGapSinceLast(digits: number[], targetDigit: number): number {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] === targetDigit) return digits.length - 1 - i;
  }
  return digits.length;
}

export function computePriceKinematics(
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
    bonus = -8;
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

export function momentumRate(
  digits: number[],
  contractType: BotContractType,
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

export function entryTimingScore(
  digits: number[],
  prices: number[],
  contractType: BotContractType,
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

export function theoreticalWinRate(contractType: BotContractType, barrier: number | undefined): number {
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

// ── Barrier / digit selection ─────────────────────────────────────────────────

/**
 * FAB's hot-digit picker, kept for parity with the Quantum FAB.
 * Bots additionally pass the result through the specialist's FDR-gated ranking
 * (see `resolveBotBarrier`), which removes the argmax-of-ten upward bias.
 */
export function pickBestMatchBarrier(digits: number[]): number {
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

/** FAB's cold-digit picker, kept for parity with the Quantum FAB. */
export function pickBestDiffBarrier(digits: number[]): number {
  const bayes = bayesianMarkovProb(digits);
  const freq50 = digitFrequency(digits.slice(-50));
  const coldScore = bayes.map((m, i) => {
    const gap = digitGapSinceLast(digits, i);
    const gapPenalty = Math.max(0, 10 - Math.min(gap, 10)) / 10 * 0.15;
    return m * 0.50 + (freq50[i] ?? 0) * 0.35 + gapPenalty;
  });
  return coldScore.indexOf(Math.min(...coldScore));
}

export function extractBarriers(barriers: number[]): { overBarrier: number; underBarrier: number } {
  const overBarrier  = barriers.length > 0 ? barriers[0] : 1;
  const underBarrier = barriers.length > 1 ? barriers[1] : 8;
  return { overBarrier, underBarrier };
}

// ── Specialist-augmented scorer ───────────────────────────────────────────────

/**
 * PrecisionAI v4 Quantum Market Scorer (copied) + Specialist Analysis Layer.
 *
 * The FAB score is computed exactly as before, then the specialist bonus is
 * added as one more bounded additive term. Nothing in the FAB path is altered
 * or short-circuited: a specialist bonus of 0 reproduces the FAB score.
 */
export function botPrecisionScore(
  symbol: string,
  displayName: string,
  contractType: BotContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
  minDigitSamples = 25,
): BotMarketScore | null {
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

  // ── Bayesian synthesis of win probability (FAB, unchanged) ─────────────────
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
  const timingBonus    = (timing - 50) * 0.20;
  const stabilityBonus = (stabilityRaw - 0.5) * 10;
  const entropyBonus   = entropy.bonus;

  // ── Quantum analysis layer (FAB, unchanged) ────────────────────────────────
  const q             = quantumWindowEstimate(digits, prices, contractType, barrier);
  const zQuality      = zEdgeQuality(q);
  const quantumTiming = quantumTimingScore(q);
  const hazardQ       = hazardTimingBonus(q);
  const onsetQ        = entropyOnsetBonus(q);
  const edgeCommittee = 0.5 * edgeNorm + 0.5 * zQuality;
  const winPfinal     = Math.max(0.01, Math.min(0.99, winP * 0.5 + q.pHat * 0.5));

  // ── SPECIALIST LAYER (new — the single-contract advantage) ─────────────────
  const specialist = specialistReadFor(contractType, barrier, digits, prices);
  const specialistBonus = specialist?.bonus ?? 0;

  const ev = winPfinal * (payout - 1) - (1 - winPfinal);
  const evBonus = ev >= 0.05 ? 8 : ev >= 0.015 ? 3 : ev < 0 ? -12 : 0;

  const score = Math.min(100, Math.max(0,
    50 + edgeCommittee * 45 + timingBonus + (quantumTiming - 50) * 0.15 +
        stabilityBonus + signalBonus + entropyBonus + evBonus + hazardQ + onsetQ +
        specialistBonus,
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
    specialistBonus !== 0 ? `spec${specialistBonus >= 0 ? "+" : ""}${specialistBonus.toFixed(1)}` : "",
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
    specialist,
  };
}

/** Route a contract to its specialist estimator. */
export function specialistReadFor(
  contractType: BotContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
): SpecialistRead | undefined {
  switch (contractType) {
    case "DIGITEVEN":
    case "DIGITODD":
      return parityRead(digits, contractType);
    case "DIGITOVER":
    case "DIGITUNDER":
      return barrier === undefined ? undefined : barrierRead(digits, { side: contractType, barrier });
    case "DIGITMATCH":
      return matchRead(digits, barrier).read;
    case "DIGITDIFF":
      return differRead(digits, barrier).read;
    case "CALL":
    case "PUT":
      return momentumRead(prices, contractType);
    default:
      return undefined;
  }
}

/**
 * Resolve the digit barrier a match/differ bot will trade.
 *
 * A locked digit is respected absolutely. Otherwise the specialist's
 * FDR-gated, hazard-weighted ranking decides — the FAB's argmax picker is the
 * fallback only when the specialist has too little data.
 */
export function resolveBotBarrier(
  contractType: BotContractType,
  digits: number[],
  lockedBarrier?: number,
): { barrier: number; candidates?: DigitCandidate[]; source: "locked" | "specialist" | "fallback" } {
  if (contractType === "DIGITMATCH") {
    if (lockedBarrier !== undefined) {
      return { barrier: lockedBarrier, candidates: matchRead(digits, lockedBarrier).candidates, source: "locked" };
    }
    const read = matchRead(digits);
    return { barrier: read.barrier, candidates: read.candidates, source: digits.length >= 40 ? "specialist" : "fallback" };
  }
  if (contractType === "DIGITDIFF") {
    if (lockedBarrier !== undefined) {
      return { barrier: lockedBarrier, candidates: differRead(digits, lockedBarrier).candidates, source: "locked" };
    }
    const read = differRead(digits);
    return { barrier: read.barrier, candidates: read.candidates, source: digits.length >= 40 ? "specialist" : "fallback" };
  }
  return { barrier: lockedBarrier ?? 0, source: "locked" };
}

// ── Green light (copied) + specialist timing gate ─────────────────────────────

/** Quantum FAB green-light sub-tick validator, copied verbatim. */
export function isGreenLight(
  digits: number[],
  prices: number[],
  contractType: BotContractType,
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
 * Bot entry gate: the FAB green light AND the specialist's own timing
 * condition. The specialist condition is what the specialisation buys — it is
 * computed from estimators that only exist because this bot trades one family.
 */
export function botGreenLight(
  digits: number[],
  prices: number[],
  contractType: BotContractType,
  barrier: number | undefined,
): { pass: boolean; reason: string; fabGreen: boolean; specialistPass: boolean } {
  const fabGreen = isGreenLight(digits, prices, contractType, barrier);
  if (!fabGreen) return { pass: false, reason: "awaiting sub-tick green light", fabGreen, specialistPass: false };
  const read = specialistReadFor(contractType, barrier, digits, prices);
  if (!read) return { pass: true, reason: "green light", fabGreen, specialistPass: true };
  const verdict = specialistEntryGate(read);
  return { pass: verdict.pass, reason: verdict.reason, fabGreen, specialistPass: verdict.pass };
}

// ── Sniper recovery bonus (copied) ────────────────────────────────────────────

export function deepSniperBonus(
  contractType: BotContractType,
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

export function recoveryGateRequirements(
  contractType: BotContractType,
  barrier: number | undefined,
): { requiredScore: number; requiredEv: number } {
  const theoretical = theoreticalWinRate(contractType, barrier);
  if (theoretical >= 0.70) return { requiredScore: 60, requiredEv: 0.018 };
  if (theoretical <= 0.30) return { requiredScore: 62, requiredEv: 0.035 };
  return { requiredScore: 60, requiredEv: 0.020 };
}
