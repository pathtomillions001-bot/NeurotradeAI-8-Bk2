/**
 * Duration Optimizer
 *
 * RESPONSIBILITY: Select the optimal tick duration for each potential trade
 * based on current market conditions rather than using a fixed number.
 *
 * Evaluated durations: [1, 3, 5, 7, 10, 15] ticks
 *
 * Scoring factors:
 *   1. Volatility  — high vol → shorter (less time for random walk to overwhelm signal)
 *   2. Hurst exponent — trending (H>0.55) → longer; mean-reverting (H<0.45) → shorter
 *   3. Market regime — choppy/volatile → shorter; trending → longer
 *   4. Momentum persistence — strong momentum → longer for directional bets
 *   5. Historical win rate per duration (if enough data)
 *   6. Contract type — DIGIT contracts only care about the Nth tick → prefer 5
 */

import type { MarketRegime, ScanContext } from "./types";
import type { FeatureSet } from "./feature-engineering";
import { getStrategyStats } from "./performance-feedback";

export interface DurationScore {
  duration: number;
  score: number;           // 0-100
  reasoning: string[];
  expectedEdge: number;    // marginal EV improvement vs default
}

export interface OptimalDuration {
  duration: number;        // chosen tick count
  confidence: number;      // 0-100 confidence in this choice
  reasoning: string;       // human-readable explanation
  allScores: DurationScore[];
}

const CANDIDATE_DURATIONS = [1, 3, 5, 7, 10, 15];
// Digit contracts only care about the FINAL tick's last digit — durations beyond
// 5 ticks add time exposure without improving odds.
// 1 tick is valid for DIGITOVER/DIGITUNDER/DIGITMATCH/DIGITDIFF and is the
// optimal choice in high/extreme volatility (minimum time for the distribution
// to shift before settlement). 3t and 5t remain for normal/low vol.
const DIGIT_CANDIDATE_DURATIONS = [1, 3, 5];

/**
 * Score a given tick duration for a contract type in the current market conditions.
 */
function scoreDuration(
  duration: number,
  features: FeatureSet,
  regime: MarketRegime,
  contractType: string,
  symbol: string,
): DurationScore {
  const pf = features.price;
  const isDigit = contractType.startsWith("DIGIT");
  const isDirection = !isDigit;

  let score = 50; // neutral baseline
  const reasoning: string[] = [];

  // ── Factor 1: Volatility ────────────────────────────────────────────────
  // High vol → shorter duration (signal degrades faster)
  const vol = pf.vol20;
  if (vol > 0.008) {
    // Extreme volatility: prefer very short durations
    if (duration <= 3) { score += 12; reasoning.push(`High vol (${(vol*100).toFixed(3)}%) favours short ${duration}t`); }
    else if (duration >= 10) { score -= 18; reasoning.push(`High vol penalises long ${duration}t`); }
    else { score -= 6; }
  } else if (vol < 0.001) {
    // Very low volatility: prefer medium-long durations
    if (duration >= 7) { score += 10; reasoning.push(`Low vol (${(vol*100).toFixed(3)}%) supports ${duration}t`); }
    else if (duration === 1) { score -= 10; reasoning.push("Too short for low-vol market"); }
  } else {
    // Normal volatility: moderate preference for 5-7t
    if (duration === 5 || duration === 7) { score += 5; }
  }

  // ── Factor 2: Hurst Exponent (trending vs mean-reverting) ──────────────
  const hurst = pf.hurst;
  if (isDirection) {
    if (hurst > 0.58) {
      // Trending market: longer durations allow the trend to play out
      if (duration >= 7) { score += 15; reasoning.push(`Trending (H=${hurst.toFixed(2)}) — longer ${duration}t lets trend develop`); }
      else if (duration <= 2) { score -= 10; reasoning.push("Trend needs more ticks to realize"); }
    } else if (hurst < 0.45) {
      // Mean-reverting: shorter durations better (exit before reversion cancels edge)
      if (duration <= 3) { score += 12; reasoning.push(`Mean-reverting (H=${hurst.toFixed(2)}) — short ${duration}t avoids reversion`); }
      else if (duration >= 10) { score -= 12; reasoning.push("Mean-reverting penalises long duration"); }
    }
  } else {
    // Digit contracts: only the FINAL tick's last digit matters.
    // Scoring logic for 1t / 3t / 5t based on volatility and market regime:
    //
    //  1t — optimal when extreme/high vol: minimum time-exposure means the digit
    //       distribution has the least chance to shift between analysis and settlement.
    //       Also best when we want a tight, precise entry during recovery.
    //
    //  3t — default for moderately high vol: balances tick-count variance with
    //       reduced exposure compared to 5t.
    //
    //  5t — best in low/medium vol: the digit distribution is stable enough that
    //       more ticks produce a more reliable probability estimate at settlement.
    if (pf.vol20 > 0.010) {
      // Extreme volatility: 1 tick minimises time-exposure; 5t is actively risky
      if (duration === 1)      { score += 16; reasoning.push(`Extreme vol (${(pf.vol20*100).toFixed(3)}%): 1t minimises digit time-exposure`); }
      else if (duration === 3) { score += 4; }
      else                     { score -= 10; reasoning.push(`Extreme vol penalises long digit duration`); }
    } else if (pf.vol20 > 0.006) {
      // High volatility: 1t is good, 3t is solid, 5t loses edge
      if (duration === 1)      { score += 10; reasoning.push(`High vol: 1t tight digit entry reduces distribution drift`); }
      else if (duration === 3) { score += 8;  reasoning.push(`High vol: 3t reduces digit exposure`); }
      else                     { score -= 4; }
    } else if (pf.vol20 < 0.002) {
      // Very low volatility: distribution is stable — more ticks = more reliable
      if (duration === 5)      { score += 8;  reasoning.push(`Low vol: 5t allows digit distribution to stabilise`); }
      else if (duration === 1) { score -= 8;  reasoning.push(`Low vol: 1t too noisy for digit`); }
    } else {
      // Normal volatility (0.002–0.006): moderate preference for 3t and 5t
      if (duration === 5)      { score += 4; }
      else if (duration === 3) { score += 3; }
      // 1-tick neutral in normal conditions
    }
    // Regime overlay: volatile/choppy markets — 1t further rewarded for digits
    if (regime === "volatile" || regime === "choppy") {
      if (duration === 1)      { score += 6;  reasoning.push(`${regime} regime: 1t for digits cuts noise exposure`); }
      else if (duration === 5) { score -= 5; }
    }
  }

  // ── Factor 3: Market Regime ─────────────────────────────────────────────
  if (regime === "trending_up" || regime === "trending_down") {
    if (isDirection) {
      if (duration >= 5 && duration <= 10) { score += 10; reasoning.push(`Trend regime: ${duration}t optimal window`); }
    }
  } else if (regime === "choppy" || regime === "volatile") {
    // Short durations reduce exposure time
    if (duration <= 3) { score += 8; reasoning.push(`${regime} regime: short ${duration}t reduces noise exposure`); }
    else if (duration >= 10) { score -= 15; reasoning.push(`${regime} regime: ${duration}t too long`); }
  } else if (regime === "mean_reverting") {
    if (duration <= 5) { score += 8; reasoning.push("Mean-reverting: quick exits better"); }
  } else if (regime === "quiet") {
    // Quiet market: slightly longer durations OK
    if (duration >= 5) { score += 5; }
  }

  // ── Factor 4: Momentum Persistence ──────────────────────────────────────
  if (isDirection) {
    const mom5 = pf.momentum5;
    const mom1 = pf.momentum1;
    const momentumAligned = Math.sign(mom1) === Math.sign(mom5);
    const momentumStrong = Math.abs(mom5) > 0.0003;

    if (momentumAligned && momentumStrong) {
      // Strong aligned momentum → medium-long durations can ride it
      if (duration >= 5 && duration <= 10) { score += 8; reasoning.push(`Strong momentum supports ${duration}t`); }
    } else if (!momentumAligned) {
      // Conflicting momentum → shorter durations to avoid whipsaw
      if (duration <= 3) { score += 5; }
      else if (duration >= 10) { score -= 10; }
    }
  }

  // ── Factor 5: Autocorrelation alignment ──────────────────────────────────
  if (isDirection) {
    const ac1 = pf.autocorr1;
    if (ac1 > 0.15 && duration <= 5) {
      // Positive autocorrelation (momentum) → shorter durations capture it
      score += 6; reasoning.push(`Positive AC1 (${ac1.toFixed(2)}) suits ${duration}t`);
    } else if (ac1 < -0.15 && duration <= 3) {
      // Negative autocorrelation (mean-reverting) → very short
      score += 8;
    }
  }

  // ── Factor 6: Historical win rate per duration ────────────────────────────
  // Check if we have enough data to know which duration performs better
  const stratKey = `${contractType}_${duration}t`;
  const stats = getStrategyStats(symbol, stratKey, null);
  if (stats.hasEnoughData) {
    const historicalBonus = (stats.longTermWinRate - 0.5) * 60; // ±30 bonus/penalty
    score += Math.round(historicalBonus);
    if (Math.abs(historicalBonus) > 5) {
      reasoning.push(`Historical WR at ${duration}t: ${(stats.longTermWinRate*100).toFixed(0)}% (${stats.totalTrades} trades)`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    duration,
    score,
    reasoning,
    expectedEdge: (score - 50) / 1000, // marginal EV improvement estimate
  };
}

/**
 * Select the optimal tick duration for the current market and contract type.
 */
export function selectOptimalDuration(
  ctx: ScanContext,
  features: FeatureSet,
  regime: MarketRegime,
  contractType: string,
): OptimalDuration {
  // Digit contracts: only consider 3t or 5t — longer durations add exposure
  // without improving the digit distribution odds (outcome depends on final tick only).
  // DIGITEVEN and DIGITODD require minimum 5 ticks on Deriv — never use 3t for them.
  const isDigit = contractType.startsWith("DIGIT");
  const isEvenOdd = contractType === "DIGITEVEN" || contractType === "DIGITODD";
  const candidates = !isDigit ? CANDIDATE_DURATIONS : isEvenOdd ? [5] : DIGIT_CANDIDATE_DURATIONS;

  const allScores: DurationScore[] = candidates.map((d) =>
    scoreDuration(d, features, regime, contractType, ctx.symbol)
  );

  // Sort by score descending
  allScores.sort((a, b) => b.score - a.score);

  const best = allScores[0];
  const runnerUp = allScores[1];

  // Confidence: how much better is the winner vs runner-up?
  const margin = best.score - (runnerUp?.score ?? 0);
  const confidence = Math.min(90, Math.round(40 + margin * 5));

  const reasonParts = best.reasoning.length > 0
    ? best.reasoning.slice(0, 2).join("; ")
    : `Balanced conditions favour ${best.duration}t`;

  return {
    duration: best.duration,
    confidence,
    reasoning: `Optimal: ${best.duration} ticks (score ${best.score}/100). ${reasonParts}.`,
    allScores,
  };
}
