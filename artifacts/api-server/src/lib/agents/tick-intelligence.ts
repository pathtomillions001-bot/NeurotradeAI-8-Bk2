/**
 * Agent 2: Tick Intelligence Agent
 *
 * RESPONSIBILITY: Deep analysis of tick-by-tick price dynamics.
 * Produces momentum vectors, velocity profiling, entropy measures,
 * clustering analysis, and streak detection — all regime-aware.
 * This replaces the ad-hoc tick analysis scattered across feature-engineering
 * and provides a single authoritative tick signal for downstream agents.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import { mean, stddev } from "./feature-engineering";

export interface TickIntelligenceResult {
  // Momentum
  momentum1: number;
  momentum3: number;
  momentum5: number;
  momentum10: number;
  momentumAlignment: number;   // 0-1 — how aligned multi-horizon momentums are

  // Velocity
  tickVelocity: number;        // mean |Δprice| / tick
  velocityAcceleration: number; // is velocity increasing or decreasing?
  velocityZScore: number;      // z-score of current velocity vs recent history

  // Entropy & clustering
  entropy: number;             // Shannon entropy of return signs (0=all same, 1=random)
  clusteringIndex: number;     // 0=no clustering, 1=extreme clustering

  // Streaks
  currentStreak: number;       // +N = N consecutive ups, -N = N consecutive downs
  streakProbability: number;   // probability this streak continues (geometric decay)
  maxStreakLast50: number;      // longest streak in last 50 ticks

  // Summary signal
  directionalBias: number;     // -1 to +1: negative = bearish bias, positive = bullish
  signalStrength: number;      // 0-100: how strong / reliable the signal is
}

function shannonEntropy(values: number[]): number {
  if (values.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const v of values) {
    const sign = Math.sign(v);
    counts.set(sign, (counts.get(sign) ?? 0) + 1);
  }
  let entropy = 0;
  for (const cnt of counts.values()) {
    const p = cnt / values.length;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy; // max 1 for binary (up/down)
}

function clusteringIndex(returns: number[]): number {
  // Measure runs: ratio of actual run length to expected for iid sequence
  if (returns.length < 4) return 0;
  const signs = returns.map(Math.sign);
  let runs = 1;
  for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) runs++;
  const n = signs.length;
  const expectedRuns = (2 * n - 1) / 3; // iid expected runs
  // Fewer runs than expected = clustering. Normalize to 0-1.
  return Math.max(0, Math.min(1, (expectedRuns - runs) / (expectedRuns)));
}

function detectStreak(prices: number[]): { streak: number; maxStreak: number } {
  if (prices.length < 2) return { streak: 0, maxStreak: 0 };
  let streak = 0;
  let maxStreak = 0;
  let currentRun = 1;
  let currentDir = Math.sign(prices[prices.length - 1] - prices[prices.length - 2]);

  // Current streak from the most recent tick backwards
  for (let i = prices.length - 1; i >= 1; i--) {
    const dir = Math.sign(prices[i] - prices[i - 1]);
    if (dir === currentDir && dir !== 0) {
      streak++;
    } else {
      break;
    }
  }
  streak = streak * currentDir; // sign encodes direction

  // Max streak in last 50 ticks
  const slice = prices.slice(-51);
  currentRun = 1;
  for (let i = 1; i < slice.length; i++) {
    const dir = Math.sign(slice[i] - slice[i - 1]);
    const prevDir = Math.sign(slice[i - 1] - (slice[i - 2] ?? slice[i - 1]));
    if (dir === prevDir && dir !== 0) {
      currentRun++;
      maxStreak = Math.max(maxStreak, currentRun);
    } else {
      currentRun = 1;
    }
  }

  return { streak, maxStreak };
}

export function runTickIntelligenceAgent(
  ctx: ScanContext,
): AgentOutput & { tickResult: TickIntelligenceResult } {
  const t0 = Date.now();
  const prices = ctx.prices;

  if (prices.length < 5) {
    const empty: TickIntelligenceResult = {
      momentum1: 0, momentum3: 0, momentum5: 0, momentum10: 0, momentumAlignment: 0,
      tickVelocity: 0, velocityAcceleration: 0, velocityZScore: 0,
      entropy: 1, clusteringIndex: 0,
      currentStreak: 0, streakProbability: 0.5, maxStreakLast50: 0,
      directionalBias: 0, signalStrength: 0,
    };
    return {
      agentId: "tickIntelligence", score: 50, confidence: 0, signal: "neutral",
      reasoning: "Insufficient tick data for analysis.",
      data: { tickResult: empty }, executionTimeMs: Date.now() - t0, tickResult: empty,
    };
  }

  // Returns
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / (prices[i - 1] || 1));
  }

  // Momentum at multiple horizons
  const last = prices[prices.length - 1];
  const momentum1  = prices.length >= 2  ? (last - prices[prices.length - 2])  / (prices[prices.length - 2]  || 1) : 0;
  const momentum3  = prices.length >= 4  ? (last - prices[prices.length - 4])  / (prices[prices.length - 4]  || 1) : 0;
  const momentum5  = prices.length >= 6  ? (last - prices[prices.length - 6])  / (prices[prices.length - 6]  || 1) : 0;
  const momentum10 = prices.length >= 11 ? (last - prices[prices.length - 11]) / (prices[prices.length - 11] || 1) : 0;

  // Momentum alignment: do they all point the same direction?
  const moms = [momentum1, momentum3, momentum5, momentum10].filter(m => m !== 0);
  const allUp = moms.every(m => m > 0);
  const allDown = moms.every(m => m < 0);
  const momentumAlignment = moms.length === 0 ? 0
    : (allUp || allDown) ? 1.0
    : moms.filter(m => m > 0).length / moms.length;

  // Velocity — absolute mean return magnitude
  const absReturns = returns.map(Math.abs);
  const recent30 = absReturns.slice(-30);
  const older30 = absReturns.slice(-60, -30);
  const tickVelocity = mean(recent30);

  // Velocity acceleration: are we speeding up or slowing down?
  const velocityAcceleration = older30.length > 0
    ? (mean(recent30) - mean(older30)) / (mean(older30) || 1)
    : 0;

  // Velocity z-score (recent vs rolling window)
  const velSd = stddev(absReturns.slice(-100)) || 1e-10;
  const velMean = mean(absReturns.slice(-100));
  const velocityZScore = velSd > 0 ? (tickVelocity - velMean) / velSd : 0;

  // Entropy of recent 20 returns
  const entropy = shannonEntropy(returns.slice(-20));

  // Clustering
  const clustering = clusteringIndex(returns.slice(-50));

  // Streak detection
  const { streak, maxStreak } = detectStreak(prices.slice(-51));

  // Streak continuation probability — P(streak continues for iid) = 0.5, longer streaks = lower
  const absStreak = Math.abs(streak);
  const streakProbability = absStreak <= 1 ? 0.5 : Math.pow(0.5, absStreak - 1) * 0.5;

  // Directional bias: combine momentum alignment + upFrac
  const upFrac = returns.filter(r => r > 0).length / Math.max(1, returns.length);
  const dirSign = allDown ? -1 : allUp ? 1 : upFrac > 0.55 ? 0.5 : upFrac < 0.45 ? -0.5 : 0;
  const directionalBias = Math.max(-1, Math.min(1,
    (upFrac - 0.5) * 2 * 0.6 + dirSign * 0.4
  ));

  // Signal strength: combination of alignment, low entropy, clustering, velocity
  const alignScore = momentumAlignment * 30;
  const entropyScore = (1 - entropy) * 25;    // low entropy = directional
  const clusterScore = clustering * 20;        // clustering = mean-reverting or trending
  const velOk = tickVelocity > 0 && tickVelocity < 0.02 ? 25 : 5;
  const signalStrength = Math.min(100, Math.round(alignScore + entropyScore + clusterScore + velOk));

  // Agent score: strength of the tick signal
  const edgeMagnitude = Math.abs(directionalBias);
  const score = Math.round(50 + edgeMagnitude * 30 + signalStrength * 0.2);

  const tickResult: TickIntelligenceResult = {
    momentum1, momentum3, momentum5, momentum10, momentumAlignment,
    tickVelocity, velocityAcceleration, velocityZScore,
    entropy, clusteringIndex: clustering,
    currentStreak: streak, streakProbability, maxStreakLast50: maxStreak,
    directionalBias, signalStrength,
  };

  const reasoning = [
    `Momentum [1t=${(momentum1 * 10000).toFixed(1)}bp, 5t=${(momentum5 * 10000).toFixed(1)}bp, 10t=${(momentum10 * 10000).toFixed(1)}bp].`,
    `Alignment: ${(momentumAlignment * 100).toFixed(0)}%. Velocity: ${(tickVelocity * 10000).toFixed(2)}bp.`,
    `Entropy: ${entropy.toFixed(2)}/1. Clustering: ${(clustering * 100).toFixed(0)}%.`,
    `Current streak: ${streak > 0 ? "+" : ""}${streak}. Max(50): ${maxStreak}.`,
    `Directional bias: ${directionalBias > 0 ? "+" : ""}${(directionalBias * 100).toFixed(0)}%.`,
  ].join(" ");

  return {
    agentId: "tickIntelligence",
    score: Math.min(95, Math.max(10, score)),
    confidence: signalStrength,
    signal: scoreToSignal(score),
    reasoning,
    data: { tickResult },
    executionTimeMs: Date.now() - t0,
    tickResult,
  };
}
