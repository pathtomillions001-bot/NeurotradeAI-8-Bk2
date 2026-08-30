/**
 * Quantum Analysis Layer — the statistical core of the NeuroAI FAB.
 *
 * An ADDITIVE statistical layer on top of the existing Quantum scorer. It
 * answers the questions the raw-frequency blend structurally cannot:
 *
 *   1. HOW CONFIDENT is the current edge estimate?
 *      Exponentially-weighted estimators with a proper standard error σ —
 *      adaptive memory, no fixed window, confidence for free.
 *   2. Is this stream actually STRUCTURED, or random noise?
 *      A likelihood-ratio structure detector (weighted G-test against the
 *      uniform null) mapped to a smooth confidence λ ∈ [0,1].
 *   3. Is the edge statistically REAL vs the break-even probability?
 *      z = (p̂ − p*)/σ where p* = 1/payout — the unified significance test.
 *   4. Is this the right TIME?
 *      Edge-crossing recency, edge slope in probability space, the market's
 *      OWN streak-break hazard distribution, and entropy-onset (ΔH).
 *
 * Everything here is a pure function of the tick buffers — stateless, O(n),
 * sub-millisecond — and every exported quantity is bounded. No gating is
 * introduced: these values become bounded additive score terms, ranking
 * signals, and an execution-tick revalidation. The existing thresholds,
 * green-light logic, payouts, stakes, and recovery ledger are untouched.
 */

import { getFallbackPayout } from "./payouts";

export type QuantumContractType =
  | "DIGITOVER" | "DIGITUNDER"
  | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF"
  | "CALL" | "PUT";

// ── Tuning constants ──────────────────────────────────────────────────────────

/** EWMA memory of the Bernoulli edge filter — n_eff = (1+α)/(1−α) ≈ 65 ticks. */
const EWMA_ALPHA = 0.97;
/** EWMA memory of the digit-transition matrix — total effective ticks ≈ 200. */
const TRANS_ALPHA = 0.995;
/** Virtual samples before the blended estimate is fully trusted (credibility). */
const N0_CREDIBILITY = 40;
/** Minimum states before a full estimate (fewer → neutral, high-σ features). */
const MIN_STATES = 12;
/** EWMA burn-in steps before the trajectory is recorded (crossing/slope). */
const BURN_IN = 3;
/** Ticks used by the structure detector. */
const STRUCTURE_WINDOW = 60;
/** Exponential weight (most recent = 1) inside the structure detector. */
const STRUCTURE_WEIGHT = 0.99;
/** Slope look-back (ticks) in probability space. */
const SLOPE_WINDOW = 5;

// ── Shared output types ───────────────────────────────────────────────────────

/**
 * Full statistical read of one analysis window for one market+contract+barrier.
 * `pHat` is the confidence-weighted estimate of the probability the NEXT tick
 * satisfies the contract's target event; `sigma` is its standard error.
 */
export interface QuantumFeatures {
  pHat: number;
  sigma: number;
  ciLow: number;
  ciHigh: number;
  /** Break-even probability p* = 1/payout (EV = 0 at this win rate). */
  breakEven: number;
  /** z = (p̂ − p*)/σ — significance of the edge vs break-even. */
  z: number;
  /** λ ∈ [0,1] — confidence that the stream is structured (not uniform noise). */
  lambda: number;
  /** Effective sample size of the edge filter. */
  nEff: number;
  /** Ticks since p̂ crossed ABOVE break-even (−1 = never in the trajectory). */
  crossedTicksAgo: number;
  /** Δp̂ over the last SLOPE_WINDOW ticks (+ = edge building, − = fading). */
  edgeSlope: number;
  /** Current "against" streak length for this contract. */
  hazardK: number;
  /** Market-specific probability this streak breaks on the next tick. */
  hazardBreakProb: number;
  /** This market's own baseline break probability (median across streak lengths). */
  hazardBaseline: number;
  /** breakProb / baseline — >1 means the streak is at a market-typical breaking point. */
  hazardRelative: number;
  /** H(short) − H(long) — negative = structure just appeared, positive = dissolving. */
  entropyDelta: number;
  /** True when the window was too short for a full estimate (features are neutral). */
  neutral: boolean;
}

// ── Small math helpers ────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, max error 7.5e-8). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/**
 * χ² survival function P(χ²_dof > x) via the Wilson–Hilferty transformation
 * (accurate to well under 1% for dof ≥ 1).
 */
export function chi2Survival(x: number, dof: number): number {
  if (x <= 0) return 1;
  const z = (Math.cbrt(x / dof) - (1 - 2 / (9 * dof))) / Math.sqrt(2 / (9 * dof));
  return 1 - normalCdf(z);
}

/**
 * Structure confidence λ from a weighted G-test likelihood ratio.
 *
 * G = 2·Σ wᵢs·ln(wᵢs / expected) is the likelihood-ratio statistic for
 * "weighted digit distribution ≠ uniform". Under the null (uniform) G is
 * χ²(stateCount−1), so the BIC bridge Bayes factor BF ≈ exp((G − dof)/2)
 * (≈1 at the null median, growing for real structure) gives the posterior
 * confidence λ = sigmoid((G − dof)/2) under a uniform H0/H1 prior:
 *
 *   - G = 0 (no evidence)        → λ = 0.5  (neutral — neither boost nor cut)
 *   - G at the null median       → λ ≈ 0.42 (typically random → edge damped)
 *   - G far above dof (structure) → λ → 1   (edge contributes at full strength)
 *
 * Smooth, monotone, bounded — a confidence scaler, never a gate.
 */
export function structureConfidence(states: number[], stateCount: number): number {
  const w = states.slice(-STRUCTURE_WINDOW);
  const n = w.length;
  if (n < 20) return 0.5; // underpowered — neutral
  const counts = new Array<number>(stateCount).fill(0);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const weight = Math.pow(STRUCTURE_WEIGHT, n - 1 - i); // most recent = 1
    counts[w[i]] += weight;
    total += weight;
  }
  let g = 0;
  for (let s = 0; s < stateCount; s++) {
    const expected = total / stateCount;
    if (counts[s] > 0 && expected > 0) g += 2 * counts[s] * Math.log(counts[s] / expected);
  }
  const sigmoid = 1 / (1 + Math.exp(-(g - (stateCount - 1)) / 2));
  return clamp01(sigmoid);
}

/** Shannon entropy (bits) of a state stream. */
function shannonEntropy(states: number[], stateCount: number): number {
  const n = states.length;
  if (n === 0) return 0;
  const counts = new Array<number>(stateCount).fill(0);
  for (const s of states) counts[s]++;
  let h = 0;
  for (const c of counts) {
    if (c > 0) {
      const p = c / n;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

/**
 * Fair (theoretical) win rate — kept in sync with the engine's
 * theoreticalWinRate(): the prior for the edge filter.
 */
function fairWinRate(contractType: QuantumContractType, barrier: number | undefined): number {
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

/** Does one state satisfy the contract's target event? */
function targetSatisfied(contractType: QuantumContractType, barrier: number | undefined, state: number): boolean {
  switch (contractType) {
    case "DIGITOVER":  return barrier !== undefined && state > barrier;
    case "DIGITUNDER": return barrier !== undefined && state < barrier;
    case "DIGITEVEN":  return state % 2 === 0;
    case "DIGITODD":   return state % 2 !== 0;
    case "DIGITMATCH": return barrier !== undefined && state === barrier;
    case "DIGITDIFF":  return barrier !== undefined && state !== barrier;
    case "CALL":       return state === 1;
    case "PUT":        return state === 0;
    default:           return false;
  }
}

/**
 * Unify digits and rise/fall into a single state stream:
 * digit contracts → states 0–9 (last price digit); CALL/PUT → 1 = up tick, 0 = down/flat.
 */
function extractStates(
  digits: number[],
  prices: number[],
  contractType: QuantumContractType,
): { states: number[]; stateCount: number } {
  if (contractType === "CALL" || contractType === "PUT") {
    const states: number[] = [];
    for (let i = 1; i < prices.length; i++) states.push(prices[i] > prices[i - 1] ? 1 : 0);
    return { states, stateCount: 2 };
  }
  const states = digits.filter(d => d >= 0 && d <= 9);
  return { states, stateCount: 10 };
}

/**
 * Fit the market's OWN streak-break hazard distribution for the "against"
 * streak of this contract: for every streak length k reached, the fraction
 * of those streaks that broke on the very next tick (Laplace-smoothed;
 * still-open streaks are censored — counted as reached, not broken, exactly
 * like Kaplan–Meier survival data).
 */
function fitStreakHazard(against: boolean[]): {
  h: Map<number, number>;
  kNow: number;
  baseline: number;
} {
  const reached = new Map<number, number>();
  const broke = new Map<number, number>();
  let run = 0;
  const bump = (k: number, which: "reached" | "broke") => {
    if (which === "reached") reached.set(k, (reached.get(k) ?? 0) + 1);
    else broke.set(k, (broke.get(k) ?? 0) + 1);
  };
  for (let i = 0; i < against.length; i++) {
    if (against[i]) {
      run++;
      bump(run, "reached");
    } else if (run > 0) {
      // streak broke at length run
      bump(run, "broke");
      run = 0;
    }
  }
  // kNow = the still-open against streak at the end of the stream
  const kNow = run;
  // (an open streak is already counted as "reached" by the loop above)

  const h = new Map<number, number>();
  for (const [k, r] of reached) {
    const b = broke.get(k) ?? 0;
    h.set(k, (b + 1) / (r + 2)); // Laplace
  }

  // Baseline: median break probability across well-observed streak lengths.
  const observed = [...h.entries()]
    .filter(([k, v]) => k >= 1 && (reached.get(k) ?? 0) >= 3)
    .map(([, v]) => v)
    .sort((a, b) => a - b);
  let baseline: number;
  if (observed.length >= 2) {
    const mid = Math.floor(observed.length / 2);
    baseline = observed.length % 2 === 1 ? observed[mid]! : (observed[mid - 1]! + observed[mid]!) / 2;
  } else {
    baseline = h.size > 0 ? [...h.values()].reduce((a, b) => a + b, 0) / h.size : 0.5;
  }
  return { h, kNow, baseline: baseline > 0 ? baseline : 0.5 };
}

/**
 * One full statistical read of an analysis window. Pure function of the
 * buffers — call it per window, per candidate, as often as needed.
 */
export function quantumWindowEstimate(
  digits: number[],
  prices: number[],
  contractType: QuantumContractType,
  barrier: number | undefined,
): QuantumFeatures {
  const payout = getFallbackPayout(contractType, barrier);
  const breakEven = payout > 1 ? 1 / payout : 0.5;
  const prior = fairWinRate(contractType, barrier);

  const neutral: QuantumFeatures = {
    pHat: prior, sigma: 0.35, ciLow: 0, ciHigh: 1,
    breakEven, z: 0, lambda: 0.5, nEff: 0,
    crossedTicksAgo: -1, edgeSlope: 0,
    hazardK: 0, hazardBreakProb: 0.5, hazardBaseline: 0.5, hazardRelative: 1,
    entropyDelta: 0, neutral: true,
  };

  const { states, stateCount } = extractStates(digits, prices, contractType);
  if (states.length < MIN_STATES) return neutral;

  // ── 1. Exponentially-weighted Bernoulli filter on the target event ────────
  //    p̂ₜ = α·p̂ₜ₋₁ + (1−α)·xₜ — adaptive memory, recent ticks dominate.
  const target = states.map(s => (targetSatisfied(contractType, barrier, s) ? 1 : 0));
  let pHatF = prior;
  const trajectory: number[] = [];
  for (let i = 0; i < target.length; i++) {
    pHatF = EWMA_ALPHA * pHatF + (1 - EWMA_ALPHA) * target[i]!;
    if (i >= BURN_IN) trajectory.push(pHatF);
  }
  const nEffF = (1 + EWMA_ALPHA) / (1 - EWMA_ALPHA); // ≈ 65
  const varF = Math.max(1e-6, (pHatF * (1 - pHatF) * (1 - EWMA_ALPHA)) / (1 + EWMA_ALPHA));

  // ── 2. Exponentially-weighted transition matrix (1-step context) ──────────
  //    P(next state | last state) with decayed counts; Laplace-smoothed.
  const M: number[][] = Array.from({ length: stateCount }, () => new Array<number>(stateCount).fill(0));
  let lastRowTotal = 0;
  const rowTotals = new Array<number>(stateCount).fill(0);
  for (let i = 1; i < states.length; i++) {
    const weight = Math.pow(TRANS_ALPHA, states.length - 1 - i); // most recent pair = 1
    const a = states[i - 1]!, b = states[i]!;
    M[a]![b]! += weight;
    rowTotals[a]! += weight;
  }
  const lastState = states[states.length - 1]!;
  lastRowTotal = rowTotals[lastState]!;
  const smoothedRow = M[lastState]!.map(v => v + 1);
  const smoothedTotal = smoothedRow.reduce((a, b) => a + b, 0) + stateCount; // +1 per cell
  let markovP = 0;
  for (let s = 0; s < stateCount; s++) {
    if (targetSatisfied(contractType, barrier, s)) markovP += smoothedRow[s]! / smoothedTotal;
  }
  const nEffM = Math.max(4, lastRowTotal); // smoothed effective row count
  const varM = Math.max(1e-6, (markovP * (1 - markovP)) / nEffM);

  // ── 3. Inverse-variance blend → p̂, σ; credibility toward the fair prior ──
  const wF = 1 / varF;
  const wM = 1 / varM;
  const pHatBlend = (wF * pHatF + wM * markovP) / (wF + wM);
  const varBlend = 1 / (wF + wM);
  const nUsed = states.length;
  const cred = nUsed / (nUsed + N0_CREDIBILITY);
  const priorVar = 0.025; // diffuse prior variance (binomial at p=0.5, n=1)
  const pHat = clamp01(cred * pHatBlend + (1 - cred) * prior);
  const sigma = Math.sqrt(cred * varBlend + (1 - cred) * priorVar);

  // ── 4. Structure detector λ (weighted G-test vs uniform) ──────────────────
  const lambda = structureConfidence(states, stateCount);

  // ── 5. z vs break-even (the unified significance test) ────────────────────
  const z = (pHat - breakEven) / Math.max(sigma, 0.005);
  const ciLow = clamp01(pHat - 1.96 * sigma);
  const ciHigh = clamp01(pHat + 1.96 * sigma);

  // ── 6. Timing: crossing recency + slope in probability space ──────────────
  let crossedTicksAgo = -1;
  for (let i = trajectory.length - 1; i >= 1; i--) {
    const prev = trajectory[i - 1]!;
    const cur = trajectory[i]!;
    if (prev < breakEven && cur >= breakEven) {
      crossedTicksAgo = trajectory.length - 1 - i;
      break;
    }
  }
  const back = Math.min(SLOPE_WINDOW, Math.max(0, trajectory.length - 1));
  const edgeSlope = trajectory.length > back ? trajectory[trajectory.length - 1]! - trajectory[trajectory.length - 1 - back]! : 0;

  // ── 7. Market-specific streak-break hazard (overshoot timing) ─────────────
  const against = target.map(x => x === 0);
  const { h, kNow, baseline } = fitStreakHazard(against);
  const hazardBreakProb = h.get(kNow) ?? baseline;
  const hazardRelative = baseline > 1e-9 ? hazardBreakProb / baseline : 1;

  // ── 8. Entropy onset: structure appearing (ΔH < 0) or dissolving (ΔH > 0) ─
  const entropyDelta = states.length >= 50
    ? shannonEntropy(states.slice(-15), stateCount) - shannonEntropy(states.slice(-50), stateCount)
    : 0;

  return {
    pHat, sigma, ciLow, ciHigh,
    breakEven, z, lambda,
    nEff: nUsed,
    crossedTicksAgo, edgeSlope,
    hazardK: kNow, hazardBreakProb, hazardBaseline: baseline, hazardRelative,
    entropyDelta, neutral: false,
  };
}

// ── Bounded score terms (all additive, none of them gates) ───────────────────

/**
 * Method 3 — significance-weighted, structure-gated edge quality in [−1, 1],
 * the same range as the original edgeNorm term. z is damped by λ so noise
 * streams (λ ≈ 0.4) contribute far less than structured ones (λ ≈ 1), and by
 * σ so small samples can never fake a pass.
 */
export function zEdgeQuality(f: QuantumFeatures): number {
  if (f.neutral) return 0;
  return Math.max(-1, Math.min(1, (f.z * f.lambda) / 2.5));
}

/**
 * Method 5 — probabilistic entry timing on a 0–100 scale (50 = neutral, the
 * same convention as the engine's entryTimingScore). Fresh break-even crossing
 * and a rising edge in probability space score high; a stale, fading edge
 * scores low.
 */
export function quantumTimingScore(f: QuantumFeatures): number {
  if (f.neutral) return 50;
  let s = 50;
  if (f.crossedTicksAgo === 0) s += 20;
  else if (f.crossedTicksAgo >= 1 && f.crossedTicksAgo <= 5) s += 15;
  else if (f.crossedTicksAgo >= 6 && f.crossedTicksAgo <= 15) s += 8;
  else if (f.crossedTicksAgo < 0) s -= 10; // never above break-even in the trajectory
  if (f.edgeSlope > 0.02) s += 15;
  else if (f.edgeSlope > 0) s += 8;
  else if (f.edgeSlope < -0.02) s -= 15;
  else if (f.edgeSlope < 0) s -= 8;
  return Math.max(0, Math.min(100, s));
}

/**
 * Method 5 — overshoot timing via the market's OWN streak-break hazard:
 * a streak whose break probability is at/above this market's own baseline is
 * at its natural breaking point (the overshoot entry); an unusually
 * persistent long streak is fading. Bounded ±6.
 */
export function hazardTimingBonus(f: QuantumFeatures): number {
  if (f.neutral || f.hazardK < 2) return 0;
  const r = f.hazardRelative;
  if (r >= 1.5) return 6;
  if (r >= 1.2) return 3;
  if (r <= 0.8 && f.hazardK >= 6) return -4;
  return 0;
}

/**
 * Method 5 — entropy onset: short-window entropy well below long-window =
 * structure just appeared (best entry window); the reverse = dissolving.
 * Linear across the ±0.08-bit band, bounded ±5.
 */
export function entropyOnsetBonus(f: QuantumFeatures): number {
  if (f.neutral) return 0;
  const d = f.entropyDelta;
  if (d <= -0.08) return 5;
  if (d >= 0.08) return -5;
  return Math.round(-d * 62.5 * 10) / 10;
}

/**
 * Method 4 — temporal stability as confidence-interval overlap across the
 * analysis windows. A shared CI region ABOVE break-even means every
 * time-scale independently sees a statistically real edge (pure bonus 0..8 —
 * disagreement never rejects; the existing thresholds still decide).
 */
export function ciOverlapBonus(estimates: QuantumFeatures[]): number {
  if (estimates.length < 2) return 0;
  const usable = estimates.filter(e => !e.neutral);
  if (usable.length < 2) return 0;
  const low = Math.max(...usable.map(e => e.ciLow));
  const high = Math.min(...usable.map(e => e.ciHigh));
  if (high <= low) return 0;
  const be = usable[0]!.breakEven;
  return high > be ? 8 : 4;
}

/** Width of the shared CI region (0 when there is none) — for journaling. */
export function ciOverlapWidth(estimates: QuantumFeatures[]): number {
  if (estimates.length < 2) return 0;
  const usable = estimates.filter(e => !e.neutral);
  if (usable.length < 2) return 0;
  const low = Math.max(...usable.map(e => e.ciLow));
  const high = Math.min(...usable.map(e => e.ciHigh));
  return Math.max(0, high - low);
}

/**
 * Method 4 — edge direction across time-scales: short-window estimate above
 * the long-window = improving edge; clearly below = fading. Bounded ±3.
 */
export function edgeTrendBonus(short: QuantumFeatures, long: QuantumFeatures): number {
  if (short.neutral || long.neutral) return 0;
  const diff = short.pHat - long.pHat;
  if (diff >= 0.02) return 3;   // improving
  if (diff >= -0.03) return 0;  // stable
  if (diff >= -0.08) return -2; // softening
  return -3;                    // clearly fading
}
