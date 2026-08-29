/**
 * Agent 12: Pattern Discovery Agent
 *
 * RESPONSIBILITY: Identify statistical patterns in recent win/loss sequences
 * and market conditions at trade entry. Clusters similar market states to
 * detect which conditions consistently produce wins vs losses.
 * Purely additive — enhances confidence but never hard-blocks.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";

interface MarketSnapshot {
  symbol: string;
  contractType: string;
  barrier?: number;
  hurst: number;
  volatility: number;
  momentum: number;
  entropy: number;
  won: boolean;
  timestamp: number;
}

// Rolling window of last 200 trade snapshots
const snapshots: MarketSnapshot[] = [];
const MAX_SNAPSHOTS = 200;

export function recordSnapshot(snapshot: MarketSnapshot): void {
  snapshots.push(snapshot);
  if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
}

interface PatternResult {
  patternScore: number;        // 0-100 how bullish the current pattern is
  similarHistoricWinRate: number;
  similarTradeCount: number;
  clusterLabel: string;
  dominantPattern: string;
}

// Euclidean distance between two market states
function stateDistance(a: MarketSnapshot, b: MarketSnapshot): number {
  return Math.sqrt(
    (a.hurst - b.hurst) ** 2 +
    (a.volatility - b.volatility) ** 2 * 4 +
    (a.momentum - b.momentum) ** 2 * 2 +
    (a.entropy - b.entropy) ** 2
  );
}

function discoverPattern(
  symbol: string,
  contractType: string,
  currentState: { hurst: number; volatility: number; momentum: number; entropy: number },
): PatternResult {
  const relevant = snapshots.filter(s => s.symbol === symbol && s.contractType === contractType);

  // Require 20 historical trades for this symbol/contractType before generating any signal.
  // At < 20 trades there is not enough data to distinguish a real pattern from random variance.
  if (relevant.length < 20) {
    return {
      patternScore: 50,
      similarHistoricWinRate: 0.5,
      similarTradeCount: 0,
      clusterLabel: "insufficient_data",
      dominantPattern: "Insufficient history — neutral signal",
    };
  }

  const SIMILARITY_THRESHOLD = 0.3;
  const current = { ...currentState, symbol, contractType, won: false, barrier: undefined, timestamp: Date.now() };
  const similar = relevant.filter(s => stateDistance(s, current) < SIMILARITY_THRESHOLD);

  // Require 15 similar states minimum — 3 was statistically insignificant
  // (e.g. 2/3 wins = 66% score = 66 on the pattern score, pure noise at 3 samples).
  // At 15 similar trades, a 2/3 win rate is still not significant, but outlier wins
  // can't inflate the score to the degree they could at n=3.
  if (similar.length < 15) {
    return {
      patternScore: 50,
      similarHistoricWinRate: 0.5,
      similarTradeCount: similar.length,
      clusterLabel: "novel_state",
      dominantPattern: "Novel market state — insufficient similar historical setups",
    };
  }

  const wins = similar.filter(s => s.won).length;
  const winRate = wins / similar.length;

  // Cluster label based on Hurst + momentum
  let clusterLabel: string;
  if (currentState.hurst > 0.55 && currentState.momentum > 0) clusterLabel = "trending_up";
  else if (currentState.hurst > 0.55 && currentState.momentum < 0) clusterLabel = "trending_down";
  else if (currentState.hurst < 0.45) clusterLabel = "mean_reverting";
  else if (currentState.volatility > 0.005) clusterLabel = "volatile";
  else clusterLabel = "neutral";

  const patternScore = Math.round(50 + (winRate - 0.5) * 100);

  const dominantPattern = [
    `Cluster: ${clusterLabel}.`,
    `${similar.length} similar setups found — WR=${(winRate * 100).toFixed(0)}%.`,
    winRate >= 0.6 ? "Pattern historically profitable." : winRate <= 0.4 ? "Pattern historically unprofitable." : "Pattern mixed.",
  ].join(" ");

  return { patternScore, similarHistoricWinRate: winRate, similarTradeCount: similar.length, clusterLabel, dominantPattern };
}

export function runPatternDiscoveryAgent(
  ctx: ScanContext,
  contractType: string,
  currentState: { hurst: number; volatility: number; momentum: number; entropy: number },
): AgentOutput & { patternResult: PatternResult } {
  const t0 = Date.now();
  const result = discoverPattern(ctx.symbol, contractType, currentState);

  const reasoning = [
    `Pattern agent: ${result.dominantPattern}`,
    result.similarTradeCount > 0 ? `Historical win rate in similar conditions: ${(result.similarHistoricWinRate * 100).toFixed(1)}%.` : "",
  ].filter(Boolean).join(" ");

  return {
    agentId: "patternDiscovery",
    score: Math.min(95, Math.max(10, result.patternScore)),
    // Confidence grows gradually from the minimum threshold (15 trades) upward.
    // At exactly 15 similar trades: confidence = 5. At 29 trades: ~75. At 30+: capped at 80.
    confidence: Math.min(80, Math.max(0, (result.similarTradeCount - 14) * 5)),
    signal: scoreToSignal(result.patternScore),
    reasoning,
    data: { patternResult: result },
    executionTimeMs: Date.now() - t0,
    patternResult: result,
  };
}
