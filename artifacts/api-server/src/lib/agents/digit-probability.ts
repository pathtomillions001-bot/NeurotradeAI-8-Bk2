/**
 * Agent 3: Digit Probability Engine
 *
 * RESPONSIBILITY: Full statistical analysis of the digit distribution.
 * Markov chain transition probabilities, Bayesian frequency estimation,
 * chi-square goodness-of-fit, streak/reversal analysis, and optimal
 * barrier selection for OVER/UNDER/EVEN/ODD contracts.
 *
 * This is an enhanced replacement for the original digit-agent.ts.
 */

import type { AgentOutput, ProductType, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import { DIGIT_PAYOUTS, MATCH_PAYOUT, DIFF_PAYOUT } from "../payouts";

// Re-export the canonical table for existing consumers (ai.ts and tests).
// Values are total winning returns, including the original stake.
export { DIGIT_PAYOUTS } from "../payouts";

// Tier 1 = safest barriers; Tier 2 = medium-risk; Tier 3 = high risk
export const DIGIT_TIERS: Record<string, Record<number, number>> = {
  DIGITOVER:  { 0: 0, 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 3, 8: 3 },
  DIGITUNDER: { 9: 0, 8: 1, 7: 1, 6: 1, 5: 2, 4: 2, 3: 2, 2: 3, 1: 3 },
};

export interface BarrierOption {
  contractType: ProductType;
  barrier: number;
  winProbability: number;
  payout: number;
  expectedValue: number;
  edge: number;
  tier: number;
  adjustedEvScore: number;
}

// ── Markov chain ───────────────────────────────────────────────────────────────

interface MarkovMatrix {
  transitions:  number[][];    // 10×10 first-order transition counts
  transitions2: number[][][];  // 10×10×10 second-order transition counts
  nextProb:     number[];      // P(next | last digit) — 1st-order with Laplace smoothing
  nextProb2:    number[];      // P(next | last 2 digits) — 2nd-order with Laplace smoothing
}

function buildMarkov(digits: number[]): MarkovMatrix {
  // 1st-order: transitions[from][to] = count of (from → to)
  const mat = Array.from({ length: 10 }, () => Array(10).fill(0));
  // 2nd-order: transitions2[prev2][prev1][to] = count of (prev2,prev1 → to)
  // 10×10×10 = 1000 states, trivially small in memory, captures multi-digit patterns.
  const mat2: number[][][] = Array.from({ length: 10 }, () =>
    Array.from({ length: 10 }, () => Array(10).fill(0))
  );

  for (let i = 1; i < digits.length; i++) {
    const from = digits[i - 1];
    const to   = digits[i];
    if (from >= 0 && from <= 9 && to >= 0 && to <= 9) {
      mat[from][to]++;
      if (i >= 2) {
        const prev2 = digits[i - 2];
        if (prev2 >= 0 && prev2 <= 9) mat2[prev2][from][to]++;
      }
    }
  }

  const last = digits[digits.length - 1] ?? 5;
  const row  = mat[last];
  // Laplace smoothing (α=1 per digit): add 1 to every count before normalising.
  // This prevents zero-probability on unseen transitions — without smoothing the
  // old code defaulted to a flat 10% for any unobserved row, which is wrong for
  // transitions that ARE possible but just haven't appeared in the sample window.
  const rowRaw = row.reduce((a, b) => a + b, 0);
  const nextProb = row.map(v => (v + 1) / (rowRaw + 10));

  // 2nd-order: P(next | last two digits) with the same Laplace smoothing.
  let nextProb2: number[];
  if (digits.length >= 2) {
    const prev2   = digits[digits.length - 2] ?? 5;
    const row2    = mat2[prev2][last] as number[];
    const row2Raw = row2.reduce((a, b) => a + b, 0);
    nextProb2 = row2.map(v => (v + 1) / (row2Raw + 10));
  } else {
    nextProb2 = Array(10).fill(0.1);  // uniform fallback when history is too short
  }

  return { transitions: mat, transitions2: mat2, nextProb, nextProb2 };
}

// ── Chi-square test for uniform distribution ───────────────────────────────────

function chiSquareUniformP(digitCounts: number[]): number {
  const n = digitCounts.reduce((a, b) => a + b, 0);
  if (n === 0) return 1;
  const expected = n / 10;
  const chi2 = digitCounts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  // Approximate p-value from chi2 with df=9 (Wilson-Hilferty approximation)
  const df = 9;
  const k = 2 / (9 * df);
  const z = (Math.pow(chi2 / df, 1 / 3) - (1 - k)) / Math.sqrt(k);
  // Abramowitz & Stegun erfc approximation (max error ≈ 1.5e-7) — Math.erfc is not in Node.js
  function erfc(x: number): number {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const result = poly * Math.exp(-x * x);
    return x >= 0 ? result : 2 - result;
  }
  const pValue = 0.5 * erfc(z / Math.sqrt(2));
  return Math.max(0, Math.min(1, pValue));
}

// ── Digit frequency analysis ───────────────────────────────────────────────────

export function analyzeDigits(digits: number[]): {
  frequency: number[];    // Frequency of each digit 0-9 (0-1)
  bayesianProb: number[]; // Smoothed Bayesian estimate
  evenProbability: number;
  oddProbability: number;
  markov: MarkovMatrix;
  chiSquarePValue: number;
  isUniform: boolean;
  hotDigits: number[];
  coldDigits: number[];
  lastDigit: number;
  recentStreakDigit: number;
  recentStreakLength: number;
} {
  const counts = Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) counts[d]++;
  const n = counts.reduce((a, b) => a + b, 0) || 1;

  // Raw frequency
  const frequency = counts.map(c => c / n);

  // Bayesian smoothing: Dirichlet prior with alpha=2 per digit (mild uniform prior)
  const alpha = 2;
  const bayesianProb = counts.map(c => (c + alpha) / (n + 10 * alpha));

  const evenProbability = [0, 2, 4, 6, 8].reduce((s, d) => s + bayesianProb[d], 0);
  const oddProbability = 1 - evenProbability;

  const markov = buildMarkov(digits);
  const chiSquarePValue = chiSquareUniformP(counts);
  const isUniform = chiSquarePValue > 0.05; // can't reject uniform

  const avgFreq = 0.1;
  // Scale hot/cold thresholds with sample size: at low n the variance is huge
  // so we require a larger deviation from 10% to call a digit genuinely hot/cold.
  //   n < 50:  hot > 15% (1.50×), cold < 5%  (0.50×) — stringent (noisy data)
  //   n < 100: hot > 13% (1.30×), cold < 7%  (0.70×) — moderate
  //   n ≥ 100: hot > 11.5%(1.15×), cold < 8.5%(0.85×) — standard (data sufficient)
  const hotMult  = n < 50 ? 1.50 : n < 100 ? 1.30 : 1.15;
  const coldMult = n < 50 ? 0.50 : n < 100 ? 0.70 : 0.85;
  const hotDigits  = frequency.map((f, i) => ({ d: i, f })).filter(x => x.f > avgFreq * hotMult).map(x => x.d);
  const coldDigits = frequency.map((f, i) => ({ d: i, f })).filter(x => x.f < avgFreq * coldMult).map(x => x.d);

  // Recent streak
  const lastDigit = digits[digits.length - 1] ?? -1;
  let streakLen = 0;
  let streakDigit = lastDigit;
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] === lastDigit) streakLen++;
    else { streakDigit = digits[i + 1] ?? lastDigit; break; }
  }

  return {
    frequency, bayesianProb, evenProbability, oddProbability,
    markov, chiSquarePValue, isUniform,
    hotDigits, coldDigits,
    lastDigit, recentStreakDigit: streakDigit, recentStreakLength: streakLen,
  };
}

// ── Win probability for barriers using Markov + Bayesian ensemble ─────────────

function winProbForBarrier(
  contractType: "DIGITOVER" | "DIGITUNDER",
  barrier: number,
  analysis: ReturnType<typeof analyzeDigits>,
  sampleSize: number,
): number {
  // Bayesian base probability (always reliable — Dirichlet α=2 smoothing handles small n)
  let bayesianWinP = 0;
  if (contractType === "DIGITOVER") {
    for (let d = barrier + 1; d <= 9; d++) bayesianWinP += analysis.bayesianProb[d];
  } else {
    for (let d = 0; d < barrier; d++) bayesianWinP += analysis.bayesianProb[d];
  }

  // 1st-order Markov (now Laplace-smoothed — no zero-probability on unseen transitions)
  let markov1WinP = 0;
  if (contractType === "DIGITOVER") {
    for (let d = barrier + 1; d <= 9; d++) markov1WinP += analysis.markov.nextProb[d];
  } else {
    for (let d = 0; d < barrier; d++) markov1WinP += analysis.markov.nextProb[d];
  }

  // 2nd-order Markov — captures multi-digit sequence patterns, but needs more data
  let markov2WinP = 0;
  if (contractType === "DIGITOVER") {
    for (let d = barrier + 1; d <= 9; d++) markov2WinP += analysis.markov.nextProb2[d];
  } else {
    for (let d = 0; d < barrier; d++) markov2WinP += analysis.markov.nextProb2[d];
  }

  // Sample-size-dependent weights. Markov predictions are unreliable at low n —
  // at 30 digits a 10×10 transition matrix has mostly empty cells, so Laplace
  // smoothing dominates and the Markov contribution is noise. Weight it down.
  //   < 50 samples:  Bayesian 95%, Markov1  5%, Markov2  0%
  //   < 100 samples: Bayesian 80%, Markov1 15%, Markov2  5%
  //   ≥ 100 samples: Bayesian 65%, Markov1 25%, Markov2 10%
  const m1w = sampleSize < 50 ? 0.05 : sampleSize < 100 ? 0.15 : 0.25;
  const m2w = sampleSize < 50 ? 0.00 : sampleSize < 100 ? 0.05 : 0.10;
  const bw  = 1 - m1w - m2w;

  return bayesianWinP * bw + markov1WinP * m1w + markov2WinP * m2w;
}

// ── Barrier option builder ─────────────────────────────────────────────────────
//
// STRICT BARRIER POLICY:
//
//   Only the exact barrier the user has configured in Settings is used.
//   No range scanning, no "riskier neighbours" — the engine trades the digit
//   the user chose, nothing else.
//
//   Normal mode  → normalOverDigit  / normalUnderDigit   (defaults: OVER 1 / UNDER 8)
//   Recovery mode→ recoveryOverDigit / recoveryUnderDigit (defaults: OVER 3 / UNDER 6)
//
//   The correct values are always passed in from ai.ts via activeBarrierOverride.
//   The fallback here matches the DB schema defaults so a cold-start with no
//   settings row behaves consistently with a freshly created settings row.

const ALLOWED_BARRIERS: Record<"DIGITOVER" | "DIGITUNDER", number> = {
  DIGITOVER:  1,
  DIGITUNDER: 8,
};

function buildBarrierOptions(
  analysis: ReturnType<typeof analyzeDigits>,
  sampleSize: number,
  allowedBarriers: Record<"DIGITOVER" | "DIGITUNDER", number> = ALLOWED_BARRIERS,
): BarrierOption[] {
  const options: BarrierOption[] = [];

  for (const [ct, payoutMap] of Object.entries(DIGIT_PAYOUTS)) {
    const contractType = ct as "DIGITOVER" | "DIGITUNDER";
    const exactBarrier = allowedBarriers[contractType];

    for (const [bStr, payout] of Object.entries(payoutMap)) {
      const barrier = Number(bStr);

      // Accept ONLY the exact barrier the user configured. No range scanning.
      if (barrier !== exactBarrier) continue;

      const winP = winProbForBarrier(contractType, barrier, analysis, sampleSize);
      const ev = winP * (payout - 1) - (1 - winP);
      const edge = winP - (1 / payout);
      const tier = DIGIT_TIERS[contractType]?.[barrier] ?? 2;
      const adjustedEvScore = edge > 0 ? ev * 10 : ev;

      options.push({ contractType, barrier, winProbability: winP, payout, expectedValue: ev, edge, tier, adjustedEvScore });
    }
  }

  return options;
}

// ── Matches / Differs analysis ────────────────────────────────────────────────
//
// DIGITMATCH: win if last digit = chosen digit. Best choice: the "hot" digit
//   (highest frequency). Positive EV when that digit's frequency > 1/payout = ~11.1%.
//
// DIGITDIFF:  win if last digit ≠ chosen digit. Best choice: the "hot" digit
//   (differ from the most frequent one gives LOWEST win rate — actually we want
//   to differ from the COLDEST digit so we almost always win). EV positive when
//   frequency of chosen digit < (1 - 1/1.09) = ~8.3%.
//
// The agent returns the best match digit and best diff digit along with their
// estimated win probabilities.

export interface MatchDiffersAnalysis {
  // DIGITMATCH: pick the digit predicted most likely to appear next
  matchDigit: number;           // 0-9: best digit to match
  matchWinProbability: number;  // estimated P(last digit = matchDigit)
  matchExpectedValue: number;   // EV per $1 stake
  matchEdge: number;            // winP - 1/payout
  matchRecommended: boolean;    // true if EV > 0

  // DIGITDIFF: pick the digit predicted least likely to appear next
  diffDigit: number;            // 0-9: best digit to differ from
  diffWinProbability: number;   // estimated P(last digit ≠ diffDigit)
  diffExpectedValue: number;    // EV per $1 stake
  diffEdge: number;             // winP - 1/payout
  diffRecommended: boolean;     // true if EV > 0
}

export function analyzeMatchDiffers(
  digits: number[],
  analysis: ReturnType<typeof analyzeDigits>,
): MatchDiffersAnalysis {
  // Canonical total-return multipliers (the original stake is included).
  const matchPayout = MATCH_PAYOUT;
  const diffPayout  = DIFF_PAYOUT;

  // For DIGITMATCH: use ensemble of Bayesian + Markov next-digit probability
  // Sample-size-dependent ensemble: same tiered weighting as winProbForBarrier —
  // lean on Bayesian at low n, add Markov weight progressively as sample grows.
  const n = digits.length;
  const m1w = n < 50 ? 0.05 : n < 100 ? 0.15 : 0.25;
  const m2w = n < 50 ? 0.00 : n < 100 ? 0.05 : 0.10;
  const bw  = 1 - m1w - m2w;

  const ensembleProb = analysis.bayesianProb.map((bayP, d) => {
    const markov1P = analysis.markov.nextProb[d]  ?? 0.1;
    const markov2P = analysis.markov.nextProb2[d] ?? 0.1;
    return bayP * bw + markov1P * m1w + markov2P * m2w;
  });

  // Best DIGITMATCH: digit with highest ensemble probability
  let matchDigit = 0;
  let matchWinP = 0;
  for (let d = 0; d <= 9; d++) {
    if (ensembleProb[d] > matchWinP) { matchWinP = ensembleProb[d]; matchDigit = d; }
  }
  const matchEV   = matchWinP * (matchPayout - 1) - (1 - matchWinP);
  const matchEdge = matchWinP - 1 / matchPayout;

  // Best DIGITDIFF: differ from the digit with the LOWEST ensemble probability
  // (we are predicting "not that digit", so pick the rarest one to differ from
  // so that P(win) = 1 - P(rarest digit) is maximised).
  let diffDigit = 0;
  let diffTargetP = 1;   // probability of the digit we'll differ FROM (want this LOW)
  for (let d = 0; d <= 9; d++) {
    if (ensembleProb[d] < diffTargetP) { diffTargetP = ensembleProb[d]; diffDigit = d; }
  }
  const diffWinP  = 1 - diffTargetP;
  const diffEV    = diffWinP * (diffPayout - 1) - (1 - diffWinP);
  const diffEdge  = diffWinP - 1 / diffPayout;

  return {
    matchDigit, matchWinProbability: matchWinP,
    matchExpectedValue: matchEV, matchEdge,
    matchRecommended: matchEV > 0 && digits.length >= 30,
    diffDigit, diffWinProbability: diffWinP,
    diffExpectedValue: diffEV, diffEdge,
    diffRecommended: diffEV > 0 && digits.length >= 30,
  };
}

// ── Even/Odd analysis ──────────────────────────────────────────────────────────

export function analyzeEvenOdd(digits: number[]): {
  evenProb: number;
  oddProb: number;
  markovEvenGivenEven: number;
  markovEvenGivenOdd: number;
  markovNextEvenProb: number;
  streakReversalSignal: boolean;
  recommendation: "even" | "odd" | "none";
} {
  if (digits.length < 10) {
    return {
      evenProb: 0.5, oddProb: 0.5,
      markovEvenGivenEven: 0.5, markovEvenGivenOdd: 0.5,
      markovNextEvenProb: 0.5,
      streakReversalSignal: false,
      recommendation: "none",
    };
  }

  const analysis = analyzeDigits(digits);
  const evenProb = analysis.evenProbability;

  // Markov E/O transitions
  const isEven = (d: number) => d % 2 === 0;
  let eeCount = 0, eoCount = 0, oeCount = 0, ooCount = 0;
  for (let i = 1; i < digits.length; i++) {
    const prev = isEven(digits[i - 1]);
    const curr = isEven(digits[i]);
    if (prev && curr) eeCount++;
    else if (prev && !curr) eoCount++;
    else if (!prev && curr) oeCount++;
    else ooCount++;
  }

  const eTotal = eeCount + eoCount || 1;
  const oTotal = oeCount + ooCount || 1;
  const markovEvenGivenEven = eeCount / eTotal;
  const markovEvenGivenOdd = oeCount / oTotal;

  const lastIsEven = isEven(digits[digits.length - 1] ?? 1);
  const markovNextEvenProb = lastIsEven ? markovEvenGivenEven : markovEvenGivenOdd;

  // Streak reversal signal: if the last 3 digits are all even or all odd
  const last3 = digits.slice(-3).map(isEven);
  const streakReversalSignal = (last3.every(Boolean) || last3.every(v => !v));

  // Need at least 2 corroborating signals AND a minimum probability edge to trade.
  // Thresholds raised from 0.52 → 0.54 to reduce false positives on near-50/50 markets.
  let signals = 0;
  const signalForEven = evenProb > 0.54 ? 1 : evenProb < 0.46 ? -1 : 0;
  const markovSignal = markovNextEvenProb > 0.54 ? 1 : markovNextEvenProb < 0.46 ? -1 : 0;
  const reversalSignal = streakReversalSignal ? (lastIsEven ? -1 : 1) : 0; // expect reversal
  signals = signalForEven + markovSignal + reversalSignal;

  // Additional guard: the dominant probability must show clear edge (> 0.54) for both
  // the Bayesian estimate AND the Markov estimate to agree. If they disagree, skip.
  const bayesMarkovAgree = (evenProb > 0.54 && markovNextEvenProb > 0.50) ||
                           (evenProb < 0.46 && markovNextEvenProb < 0.50);

  const recommendation: "even" | "odd" | "none" = (Math.abs(signals) < 2 || !bayesMarkovAgree) ? "none"
    : signals > 0 ? "even" : "odd";

  return {
    evenProb, oddProb: 1 - evenProb,
    markovEvenGivenEven, markovEvenGivenOdd, markovNextEvenProb,
    streakReversalSignal, recommendation,
  };
}

// ── Agent runner ───────────────────────────────────────────────────────────────

export interface DigitProbabilityOutput extends AgentOutput {
  barrierOptions: BarrierOption[];
  evenAnalysis: ReturnType<typeof analyzeEvenOdd>;
  matchDiffersAnalysis: MatchDiffersAnalysis | null;
  bestBarrier: BarrierOption | null;
  frequency: number[];
  hotDigits: number[];
  coldDigits: number[];
  isUniform: boolean;
  evenProbability: number;
  chiSquarePValue: number;
}

export function runDigitProbabilityAgent(ctx: ScanContext): DigitProbabilityOutput {
  const t0 = Date.now();
  const digits = ctx.digits;

  if (digits.length < 10) {
    return {
      agentId: "digitProbability", score: 50, confidence: 0, signal: "neutral",
      reasoning: `Insufficient digit data (${digits.length} samples — need ≥30).`,
      data: {}, executionTimeMs: Date.now() - t0,
      barrierOptions: [], evenAnalysis: analyzeEvenOdd([]),
      matchDiffersAnalysis: null,
      bestBarrier: null, frequency: Array(10).fill(0.1),
      hotDigits: [], coldDigits: [], isUniform: true,
      evenProbability: 0.5, chiSquarePValue: 1,
    };
  }

  const analysis = analyzeDigits(digits);
  const barrierOptions = buildBarrierOptions(analysis, digits.length, ctx.recoveryBarrierOverride);
  const evenAnalysis = analyzeEvenOdd(digits);
  const matchDiffersAnalysis = analyzeMatchDiffers(digits, analysis);

  // Sort by adjustedEvScore
  const sorted = [...barrierOptions].sort((a, b) => b.adjustedEvScore - a.adjustedEvScore);
  const bestBarrier = sorted[0] ?? null;

  // ── Score based on win-rate deviation from theoretical (uniform) baseline ──
  //
  // WHY NOT EDGE: "edge" = winP - 1/payout is always deeply negative for safe
  // low-payout OVER/UNDER barriers (e.g. OVER 1 has edge ≈ -0.13 even when the
  // digit distribution is perfectly normal). Using edge * 300 as a score produced
  // values of 10–15 for ALL safe barriers, making the consensus gate impossible to
  // pass and blocking every OVER/UNDER trade regardless of digit skew.
  //
  // CORRECT APPROACH: score the deviation of the ACTUAL win probability from the
  // THEORETICAL win probability in a perfectly uniform market.
  //
  //   theoreticalWinP for OVER N = (9 - N) / 10  (fraction of digits > N)
  //   theoreticalWinP for UNDER N = N / 10        (fraction of digits < N)
  //
  // A deviation of +5pp (digits skewing cold) → score 75. Uniform → score 50.
  // A deviation of -5pp (digits skewing hot) → score 25.  Clean and intuitive.
  const dataSufficiency = Math.min(1, digits.length / 100);

  let theoreticalWinP = 0.5;
  if (bestBarrier) {
    theoreticalWinP = bestBarrier.contractType === "DIGITOVER"
      ? (9 - bestBarrier.barrier) / 10
      : bestBarrier.barrier / 10;
  }
  const winDeviation = bestBarrier ? (bestBarrier.winProbability - theoreticalWinP) : 0;
  // Scale: ±10pp deviation maps to ±50 score points.
  const edgeScore = bestBarrier
    ? Math.min(95, Math.round(50 + winDeviation * 500))
    : 50;
  let score = Math.round(edgeScore * dataSufficiency + 50 * (1 - dataSufficiency));

  // During a loss streak, demand above-theoretical win probability.
  // The AI should only repeat OVER/UNDER after consecutive losses when digits
  // are genuinely skewing in the trade's favour.
  const sessionLosses = ctx.daily.consecutiveLosses;
  if (sessionLosses >= 2 && bestBarrier) {
    if (winDeviation < 0) {
      // Digits skewing against the barrier — strong penalty during a streak
      score = Math.max(10, score - 20);
    } else if (sessionLosses >= 3 && winDeviation < 0.02) {
      // Weak advantage during a deeper streak — need at least 2pp positive deviation
      score = Math.max(10, score - 12);
    }
  }

  const isUniform = analysis.isUniform;

  const reasoning = [
    `${digits.length} digits. Chi-sq p=${analysis.chiSquarePValue.toFixed(3)} (${isUniform ? "uniform" : "skewed"}).`,
    `Hot: [${analysis.hotDigits.join(",")}]. Cold: [${analysis.coldDigits.join(",")}].`,
    bestBarrier
      ? `Best barrier: ${bestBarrier.contractType} ${bestBarrier.barrier} | P(win)=${(bestBarrier.winProbability * 100).toFixed(1)}% | EV=${(bestBarrier.expectedValue * 100).toFixed(1)}%.`
      : "No suitable barrier found.",
    `Even prob: ${(analysis.evenProbability * 100).toFixed(1)}% | Markov recommendation: ${evenAnalysis.recommendation}.`,
    matchDiffersAnalysis.matchRecommended
      ? `MATCH digit=${matchDiffersAnalysis.matchDigit} P=${(matchDiffersAnalysis.matchWinProbability * 100).toFixed(1)}%.`
      : "",
    matchDiffersAnalysis.diffRecommended
      ? `DIFF digit=${matchDiffersAnalysis.diffDigit} P(win)=${(matchDiffersAnalysis.diffWinProbability * 100).toFixed(1)}%.`
      : "",
  ].filter(Boolean).join(" ");

  return {
    agentId: "digitProbability",
    score: Math.min(95, Math.max(10, score)),
    confidence: Math.round(dataSufficiency * 90),
    signal: scoreToSignal(score),
    reasoning,
    data: {
      bestBarrier,
      hotDigits: analysis.hotDigits,
      coldDigits: analysis.coldDigits,
      isUniform,
      evenProbability: analysis.evenProbability,
      chiSquarePValue: analysis.chiSquarePValue,
      matchDiffersAnalysis,
    },
    executionTimeMs: Date.now() - t0,
    barrierOptions,
    evenAnalysis,
    matchDiffersAnalysis,
    bestBarrier,
    frequency: analysis.frequency,
    hotDigits: analysis.hotDigits,
    coldDigits: analysis.coldDigits,
    isUniform,
    evenProbability: analysis.evenProbability,
    chiSquarePValue: analysis.chiSquarePValue,
  };
}
