/**
 * Agent 8: Recovery Intelligence Agent
 *
 * RESPONSIBILITY: Track win/loss streaks, session P&L, and structural loss
 * patterns so downstream agents can avoid repeating the exact same losing
 * setup. The engine always runs in normal mode — no recovery stake adjustments,
 * no mode switching, no cooldown triggers from this agent.
 * Cooldown is handled externally by the consecutive-loss limit in settings.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";

export type RecoveryMode = "normal";

export interface RecoveryState {
  consecutiveLosses: number;
  consecutiveWins: number;
  sessionPnl: number;
  totalTrades: number;
  mode: RecoveryMode;
  recommendedStakeMultiplier: number;
  cooldownUntil: number;
}

// ── Structural loss pattern detection ────────────────────────────────────────
//
// Records the last N loss contexts (contractType + market regime) per symbol.
// When ≥2 consecutive losses share the same contractType+regime combination,
// `getStructuralLossPattern` returns that combo so the fusion engine can apply
// a targeted penalty — blocking that specific setup rather than raising the bar
// globally for all contract types.

interface LossContext {
  contractType: string;
  regime: string;
  timestamp: number;
}

// Session-scoped: keyed by symbol, stores last 4 loss contexts
const lossPatternStore = new Map<string, LossContext[]>();

/**
 * Called from ai.ts immediately after a confirmed loss outcome.
 * Stores the loss context so pattern detection can fire on the next scan.
 */
export function recordLossForPattern(
  symbol: string,
  contractType: string,
  regime: string,
): void {
  const existing = lossPatternStore.get(symbol) ?? [];
  // Keep last 4 only (sufficient for 2-match detection, bounded memory)
  const updated = [...existing, { contractType, regime, timestamp: Date.now() }].slice(-4);
  lossPatternStore.set(symbol, updated);
}

/**
 * Called from ai.ts after a confirmed win (any contract type on that symbol).
 * Clears the pattern — a win breaks the structural repeat cycle.
 */
export function clearLossPattern(symbol: string): void {
  lossPatternStore.delete(symbol);
}

/**
 * Returns the blocked {contractType, regime} combo if ≥2 of the last 4 losses
 * on this symbol share the same pair, otherwise null.
 *
 * Only patterns within the last 30 minutes are considered — stale patterns
 * from earlier in the session shouldn't suppress trades indefinitely.
 */
export function getStructuralLossPattern(
  symbol: string,
): { contractType: string; regime: string } | null {
  const contexts = lossPatternStore.get(symbol);
  if (!contexts || contexts.length < 2) return null;

  const cutoff = Date.now() - 30 * 60 * 1000; // 30-minute window
  const recent = contexts.filter(c => c.timestamp >= cutoff);
  if (recent.length < 2) return null;

  // Count occurrences of each contractType+regime combination
  const counts = new Map<string, { contractType: string; regime: string; count: number }>();
  for (const c of recent) {
    const key = `${c.contractType}|${c.regime}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { contractType: c.contractType, regime: c.regime, count: 1 });
  }

  // Return the first combo that appears ≥2 times
  for (const entry of counts.values()) {
    if (entry.count >= 2) return { contractType: entry.contractType, regime: entry.regime };
  }
  return null;
}

// In-memory state per session (resets on server restart)
const recoveryStates = new Map<string, RecoveryState>();

function getKey(ctx: ScanContext): string {
  return `${ctx.symbol}|${ctx.settings.riskProfile}`;
}

export function getRecoveryState(ctx: ScanContext): RecoveryState {
  return recoveryStates.get(getKey(ctx)) ?? {
    consecutiveLosses: 0,
    consecutiveWins: 0,
    sessionPnl: 0,
    totalTrades: 0,
    mode: "normal",
    recommendedStakeMultiplier: 1.0,
    cooldownUntil: 0,
  };
}

export function recordTradeOutcomeRecovery(
  ctx: ScanContext,
  won: boolean,
  profit: number,
): void {
  const key = getKey(ctx);
  const prev = getRecoveryState(ctx);

  const consecutiveLosses = won ? 0 : prev.consecutiveLosses + 1;
  const consecutiveWins = won ? prev.consecutiveWins + 1 : 0;
  const sessionPnl = prev.sessionPnl + profit;
  const totalTrades = prev.totalTrades + 1;

  // Always normal mode — no recovery or cooldown triggers from this agent.
  // The engine continues trading normally after any loss.
  recoveryStates.set(key, {
    consecutiveLosses, consecutiveWins,
    sessionPnl, totalTrades,
    mode: "normal",
    recommendedStakeMultiplier: 1.0,
    cooldownUntil: 0,
  });
}

export function runRecoveryIntelligenceAgent(ctx: ScanContext): AgentOutput & { recoveryState: RecoveryState } {
  const t0 = Date.now();
  const state = getRecoveryState(ctx);

  // Use the authoritative session consecutive-loss count from the daily context.
  // This counts all losses (across all families) since the last win or cooldown,
  // giving every downstream agent accurate loss-streak awareness.
  const sessionLosses = ctx.daily.consecutiveLosses;

  // Score reflects how cautious the AI should be. A loss streak demands that every
  // other agent produces a much stronger signal before the engine takes the next trade.
  // Thresholds are deliberately aggressive:
  //   score < 20 → confidence-fusion hard-blocks the trade entirely
  //   score 20-44 → heavy weight penalty in the fusion sum, typically pushes below threshold
  // At ≥4 consecutive losses the hard-block fires, forcing a full wait for the
  // mandatory consecutive-loss cooldown to activate via the loop-level check.
  const score =
    sessionLosses >= 4 ? 15   // Hard-block: 4 losses → confidence-fusion vetoes trade
    : sessionLosses >= 3 ? 25  // Near-veto: only very high conviction all-agent consensus passes
    : sessionLosses >= 2 ? 40  // Strong caution — tighten gates, demand real edge
    : sessionLosses >= 1 ? 58  // Mild caution — slightly below normal
    : state.consecutiveWins >= 3 ? 82
    : 72;

  const cautionLabel =
    sessionLosses >= 4 ? "HARD STOP (recovery intelligence veto)"
    : sessionLosses >= 3 ? "SEVERE CAUTION"
    : sessionLosses >= 2 ? "ELEVATED CAUTION"
    : sessionLosses >= 1 ? "CAUTION"
    : "NORMAL";

  const reasoning = [
    `Mode: ${cautionLabel}.`,
    `Session consecutive losses: ${sessionLosses}. Consecutive wins: ${state.consecutiveWins}.`,
    `Session P&L: ${state.sessionPnl.toFixed(2)}. Trades: ${state.totalTrades}.`,
    sessionLosses >= 2
      ? `⚠ Raising bar for all agents — require stronger edge to trade (score=${score}).`
      : `Stake: base (no adjustment).`,
  ].join(" ");

  return {
    agentId: "recoveryIntelligence",
    score: Math.max(0, Math.min(95, score)),
    confidence: 90,
    signal: scoreToSignal(score),
    reasoning,
    data: {
      mode: state.mode,
      consecutiveLosses: state.consecutiveLosses,
      consecutiveWins: state.consecutiveWins,
      sessionPnl: state.sessionPnl,
      stakeMultiplier: 1.0,
      inCooldown: false,
      remainingCooldownSec: 0,
    },
    executionTimeMs: Date.now() - t0,
    recoveryState: state,
  };
}
