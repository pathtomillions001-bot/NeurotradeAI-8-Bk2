/**
 * Performance Feedback Agent
 *
 * RESPONSIBILITY: Track true historical win rates per strategy (symbol × contract type × barrier)
 * and feed that data back to the decision pipeline to:
 *   1. Weight agents that have been accurate recently more heavily
 *   2. Suppress strategies that are consistently underperforming
 *   3. Provide real-time expectancy metrics
 *
 * Critical fix vs old code:
 * - Old win rate store used exponential smoothing starting at 0.55 (fictional baseline).
 *   After 100 trades at 50% actual win rate, the EMA would still show ~0.54.
 * - New system tracks true wins/total per key, with a separate short-window
 *   (last 20 trades) to detect recent drift vs long-term baseline.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";

// ── In-memory performance store ───────────────────────────────────────────────

interface StrategyRecord {
  wins: number;
  losses: number;
  // Short window (last 20 trades) for drift detection
  recentWins: number;
  recentLosses: number;
  recentTotal: number;
  // EV tracking
  totalDollarProfit: number;
  avgStake: number;
  lastUpdated: number;
}

const store = new Map<string, StrategyRecord>();

function strategyKey(symbol: string, contractType: string, barrier?: number | null): string {
  return `${symbol}|${contractType}|${barrier ?? ""}`;
}

export function recordTradeOutcome(
  symbol: string,
  contractType: string,
  barrier: number | null | undefined,
  won: boolean,
  profit: number,
  stake: number,
): void {
  const key = strategyKey(symbol, contractType, barrier);
  const prev = store.get(key) ?? {
    wins: 0, losses: 0,
    recentWins: 0, recentLosses: 0, recentTotal: 0,
    totalDollarProfit: 0, avgStake: stake,
    lastUpdated: Date.now(),
  };

  // Update long-term counters
  const wins = prev.wins + (won ? 1 : 0);
  const losses = prev.losses + (won ? 0 : 1);

  // Update short-window (rolling last 20 via exponential decay with alpha=1/20)
  const alpha = 1 / 20;
  const recentWins = prev.recentWins * (1 - alpha) + (won ? alpha : 0);
  const recentLosses = prev.recentLosses * (1 - alpha) + (won ? 0 : alpha);
  const recentTotal = recentWins + recentLosses;

  store.set(key, {
    wins,
    losses,
    recentWins,
    recentLosses,
    recentTotal,
    totalDollarProfit: prev.totalDollarProfit + profit,
    avgStake: prev.avgStake * 0.9 + stake * 0.1,
    lastUpdated: Date.now(),
  });

  // Also update global symbol aggregate
  const symKey = strategyKey(symbol, "*", null);
  const sym = store.get(symKey) ?? { wins: 0, losses: 0, recentWins: 0, recentLosses: 0, recentTotal: 0, totalDollarProfit: 0, avgStake: stake, lastUpdated: Date.now() };
  store.set(symKey, {
    wins: sym.wins + (won ? 1 : 0),
    losses: sym.losses + (won ? 0 : 1),
    recentWins: sym.recentWins * (1 - alpha) + (won ? alpha : 0),
    recentLosses: sym.recentLosses * (1 - alpha) + (won ? 0 : alpha),
    recentTotal: (sym.recentWins + sym.recentLosses) * (1 - alpha) + alpha,
    totalDollarProfit: sym.totalDollarProfit + profit,
    avgStake: sym.avgStake * 0.9 + stake * 0.1,
    lastUpdated: Date.now(),
  });
}

export interface StrategyStats {
  longTermWinRate: number;   // wins / (wins + losses)
  recentWinRate: number;     // short-window win rate
  totalTrades: number;
  hasEnoughData: boolean;    // need ≥ 10 trades for reliable estimate
  isDrifting: boolean;       // recent WR significantly worse than long-term
  profitFactor: number;      // total profit / (total loss)
  expectancy: number;        // avg profit per trade
}

export function getStrategyStats(
  symbol: string,
  contractType: string,
  barrier?: number | null,
): StrategyStats {
  // Try specific first, then generic, then symbol aggregate
  const specific = store.get(strategyKey(symbol, contractType, barrier));
  const generic = store.get(strategyKey(symbol, contractType, null));
  const symLevel = store.get(strategyKey(symbol, "*", null));

  const rec = specific ?? generic ?? symLevel;

  if (!rec || (rec.wins + rec.losses) === 0) {
    return {
      longTermWinRate: 0.5,   // neutral assumption, not 0.55 fiction
      recentWinRate: 0.5,
      totalTrades: 0,
      hasEnoughData: false,
      isDrifting: false,
      profitFactor: 1,
      expectancy: 0,
    };
  }

  const total = rec.wins + rec.losses;
  const longTermWR = rec.wins / total;
  const recentWR = rec.recentTotal > 0 ? rec.recentWins / rec.recentTotal : longTermWR;
  const isDrifting = total >= 10 && recentWR < longTermWR - 0.10;

  // Profit factor: total wins / total losses (in dollar amounts)
  const avgWin = rec.avgStake * 0.87;  // approx payout - stake
  const avgLoss = rec.avgStake;
  const grossWin = rec.wins * avgWin;
  const grossLoss = rec.losses * avgLoss;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : rec.wins > 0 ? Infinity : 1;

  return {
    longTermWinRate: longTermWR,
    recentWinRate: recentWR,
    totalTrades: total,
    hasEnoughData: total >= 10,
    isDrifting: isDrifting,
    profitFactor,
    expectancy: total > 0 ? rec.totalDollarProfit / total : 0,
  };
}

/** Load win rates from DB into the in-memory store on startup */
export function seedFromDb(rows: Array<{
  symbol: string;
  contractType: string;
  barrier: number | null;
  winRate: number;
  tradeCount: number;
}>): void {
  for (const row of rows) {
    const total = row.tradeCount;
    const wins = Math.round(row.winRate * total);
    const key = strategyKey(row.symbol, row.contractType, row.barrier);
    store.set(key, {
      wins,
      losses: total - wins,
      recentWins: row.winRate,     // initial estimate
      recentLosses: 1 - row.winRate,
      recentTotal: 1,
      totalDollarProfit: 0,
      avgStake: 1,
      lastUpdated: Date.now(),
    });
  }
}

export function getAllStrategyStats(): Map<string, StrategyStats & { key: string }> {
  const result = new Map<string, StrategyStats & { key: string }>();
  for (const [key, rec] of store) {
    const total = rec.wins + rec.losses;
    if (total === 0) continue;
    const longTermWR = rec.wins / total;
    const recentWR = rec.recentTotal > 0 ? rec.recentWins / rec.recentTotal : longTermWR;
    result.set(key, {
      key,
      longTermWinRate: longTermWR,
      recentWinRate: recentWR,
      totalTrades: total,
      hasEnoughData: total >= 10,
      isDrifting: total >= 10 && recentWR < longTermWR - 0.10,
      profitFactor: 1,
      expectancy: rec.totalDollarProfit / Math.max(1, total),
    });
  }
  return result;
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export function runPerformanceFeedbackAgent(
  ctx: ScanContext,
  contractType: string,
  barrier?: number | null,
): AgentOutput & { stats: StrategyStats } {
  const t0 = Date.now();
  const stats = getStrategyStats(ctx.symbol, contractType, barrier);

  // Score: how good is the historical performance of this strategy?
  let score: number;
  if (!stats.hasEnoughData) {
    // Not enough data — neutral
    score = 50;
  } else {
    // Scale: 50% WR = 50 score, 60% WR = 70 score, 70% WR = 90 score
    score = Math.round(Math.min(95, 50 + (stats.longTermWinRate - 0.5) * 200));
    // Penalize drifting strategies
    if (stats.isDrifting) score = Math.round(score * 0.8);
  }

  const reasoning = stats.hasEnoughData
    ? [
        `Strategy ${ctx.symbol}/${contractType}${barrier != null ? `@${barrier}` : ""}:`,
        `long-term WR=${(stats.longTermWinRate * 100).toFixed(1)}%,`,
        `recent WR=${(stats.recentWinRate * 100).toFixed(1)}%,`,
        `${stats.totalTrades} trades,`,
        `expectancy $${stats.expectancy.toFixed(3)}/trade.`,
        stats.isDrifting ? "⚠ DRIFTING — recent WR significantly below long-term." : "",
      ].join(" ")
    : `Insufficient history (${stats.totalTrades}/${10} trades). Using neutral prior.`;

  return {
    agentId: "performanceFeedback",
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
    },
    executionTimeMs: Date.now() - t0,
    stats,
  };
}
