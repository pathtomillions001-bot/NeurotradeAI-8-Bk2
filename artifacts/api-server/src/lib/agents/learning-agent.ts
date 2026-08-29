/**
 * Agent 11: Learning Agent
 *
 * RESPONSIBILITY: Track true historical win rates per strategy and feed
 * calibrated performance metrics back to the decision pipeline. Includes
 * shadow evaluation (simulates trades not taken) and drift detection.
 * Enhanced replacement for performance-feedback.ts.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";

interface StrategyRecord {
  wins: number;
  losses: number;
  recentWins: number;
  recentLosses: number;
  recentTotal: number;
  totalDollarProfit: number;
  avgStake: number;
  shadowWins: number;    // simulated trades not taken (shadow evaluation)
  shadowLosses: number;
  lastUpdated: number;
}

const store = new Map<string, StrategyRecord>();

function key(symbol: string, contractType: string, barrier?: number | null): string {
  return `${symbol}|${contractType}|${barrier ?? ""}`;
}

export function recordTradeOutcome(
  symbol: string,
  contractType: string,
  barrier: number | null | undefined,
  won: boolean,
  profit: number,
  stake: number,
  isShadow = false,
): void {
  const k = key(symbol, contractType, barrier);
  const prev = store.get(k) ?? {
    wins: 0, losses: 0,
    recentWins: 0, recentLosses: 0, recentTotal: 0,
    totalDollarProfit: 0, avgStake: stake,
    shadowWins: 0, shadowLosses: 0, lastUpdated: Date.now(),
  };

  const alpha = 1 / 20;

  if (isShadow) {
    store.set(k, {
      ...prev,
      shadowWins: prev.shadowWins + (won ? 1 : 0),
      shadowLosses: prev.shadowLosses + (won ? 0 : 1),
      lastUpdated: Date.now(),
    });
    return;
  }

  store.set(k, {
    wins: prev.wins + (won ? 1 : 0),
    losses: prev.losses + (won ? 0 : 1),
    recentWins: prev.recentWins * (1 - alpha) + (won ? alpha : 0),
    recentLosses: prev.recentLosses * (1 - alpha) + (won ? 0 : alpha),
    recentTotal: (prev.recentWins + prev.recentLosses) * (1 - alpha) + alpha,
    totalDollarProfit: prev.totalDollarProfit + profit,
    avgStake: prev.avgStake * 0.9 + stake * 0.1,
    shadowWins: prev.shadowWins,
    shadowLosses: prev.shadowLosses,
    lastUpdated: Date.now(),
  });

  // Also update symbol-level aggregate
  const symK = key(symbol, "*", null);
  const sym = store.get(symK) ?? { wins: 0, losses: 0, recentWins: 0, recentLosses: 0, recentTotal: 0, totalDollarProfit: 0, avgStake: stake, shadowWins: 0, shadowLosses: 0, lastUpdated: Date.now() };
  store.set(symK, {
    wins: sym.wins + (won ? 1 : 0),
    losses: sym.losses + (won ? 0 : 1),
    recentWins: sym.recentWins * (1 - alpha) + (won ? alpha : 0),
    recentLosses: sym.recentLosses * (1 - alpha) + (won ? 0 : alpha),
    recentTotal: (sym.recentWins + sym.recentLosses) * (1 - alpha) + alpha,
    totalDollarProfit: sym.totalDollarProfit + profit,
    avgStake: sym.avgStake * 0.9 + stake * 0.1,
    shadowWins: sym.shadowWins,
    shadowLosses: sym.shadowLosses,
    lastUpdated: Date.now(),
  });
}

export interface StrategyStats {
  longTermWinRate: number;
  recentWinRate: number;
  totalTrades: number;
  hasEnoughData: boolean;
  isDrifting: boolean;
  profitFactor: number;
  expectancy: number;
  shadowWinRate: number;
  hasShadowData: boolean;
}

export function getStrategyStats(
  symbol: string,
  contractType: string,
  barrier?: number | null,
): StrategyStats {
  const rec = store.get(key(symbol, contractType, barrier))
    ?? store.get(key(symbol, contractType, null))
    ?? store.get(key(symbol, "*", null));

  if (!rec || (rec.wins + rec.losses) === 0) {
    return {
      longTermWinRate: 0.5, recentWinRate: 0.5,
      totalTrades: 0, hasEnoughData: false, isDrifting: false,
      profitFactor: 1, expectancy: 0,
      shadowWinRate: 0.5, hasShadowData: false,
    };
  }

  const total = rec.wins + rec.losses;
  const longTermWR = rec.wins / total;
  const recentWR = rec.recentTotal > 0 ? rec.recentWins / rec.recentTotal : longTermWR;
  const isDrifting = total >= 10 && recentWR < longTermWR - 0.10;

  const avgWin = rec.avgStake * 0.87;
  const avgLoss = rec.avgStake;
  const pf = rec.losses > 0 ? (rec.wins * avgWin) / (rec.losses * avgLoss) : (rec.wins > 0 ? 99 : 1);

  const shadowTotal = rec.shadowWins + rec.shadowLosses;
  const shadowWinRate = shadowTotal > 0 ? rec.shadowWins / shadowTotal : 0.5;

  return {
    longTermWinRate: longTermWR,
    recentWinRate: recentWR,
    totalTrades: total,
    hasEnoughData: total >= 10,
    isDrifting,
    profitFactor: pf,
    expectancy: total > 0 ? rec.totalDollarProfit / total : 0,
    shadowWinRate,
    hasShadowData: shadowTotal >= 5,
  };
}

export function seedFromDb(rows: Array<{
  symbol: string; contractType: string; barrier: number | null; winRate: number; tradeCount: number;
}>): void {
  for (const row of rows) {
    const total = row.tradeCount;
    const wins = Math.round(row.winRate * total);
    store.set(key(row.symbol, row.contractType, row.barrier), {
      wins, losses: total - wins,
      recentWins: row.winRate, recentLosses: 1 - row.winRate, recentTotal: 1,
      totalDollarProfit: 0, avgStake: 1,
      shadowWins: 0, shadowLosses: 0, lastUpdated: Date.now(),
    });
  }
}

export function getAllStrategyStats(): Map<string, StrategyStats & { key: string }> {
  const result = new Map<string, StrategyStats & { key: string }>();
  for (const [k, rec] of store) {
    const total = rec.wins + rec.losses;
    if (total === 0) continue;
    const stats = getStrategyStats(k.split("|")[0], k.split("|")[1], null);
    result.set(k, { ...stats, key: k });
  }
  return result;
}

export function runLearningAgent(
  ctx: ScanContext,
  contractType: string,
  barrier?: number | null,
): AgentOutput & { stats: StrategyStats } {
  const t0 = Date.now();
  const stats = getStrategyStats(ctx.symbol, contractType, barrier);

  let score: number;
  if (!stats.hasEnoughData) {
    score = 50;
  } else {
    score = Math.round(Math.min(95, 50 + (stats.longTermWinRate - 0.5) * 200));
    if (stats.isDrifting) score = Math.round(score * 0.8);
  }

  // Shadow evaluation insight
  const shadowInsight = stats.hasShadowData
    ? `Shadow WR: ${(stats.shadowWinRate * 100).toFixed(1)}%.`
    : "";

  const reasoning = stats.hasEnoughData
    ? [
        `${ctx.symbol}/${contractType}${barrier != null ? `@${barrier}` : ""}:`,
        `Long-term WR=${(stats.longTermWinRate * 100).toFixed(1)}%`,
        `Recent WR=${(stats.recentWinRate * 100).toFixed(1)}%`,
        `${stats.totalTrades} trades`,
        `Expectancy $${stats.expectancy.toFixed(3)}/trade.`,
        stats.isDrifting ? "⚠ DRIFTING — reduce position." : "",
        shadowInsight,
      ].filter(Boolean).join(" ")
    : `Insufficient history (${stats.totalTrades}/10 trades). ${shadowInsight}`;

  return {
    agentId: "learningAgent",
    score,
    confidence: stats.hasEnoughData ? Math.min(90, stats.totalTrades * 2) : 20,
    signal: scoreToSignal(score),
    reasoning: reasoning.trim(),
    data: {
      longTermWinRate: stats.longTermWinRate,
      recentWinRate: stats.recentWinRate,
      totalTrades: stats.totalTrades,
      hasEnoughData: stats.hasEnoughData,
      isDrifting: stats.isDrifting,
      expectancy: stats.expectancy,
      shadowWinRate: stats.shadowWinRate,
    },
    executionTimeMs: Date.now() - t0,
    stats,
  };
}
