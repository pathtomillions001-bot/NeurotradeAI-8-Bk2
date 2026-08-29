/**
 * Risk Manager Agent
 *
 * RESPONSIBILITY: Professional position sizing and risk gating.
 *
 * Functions:
 * 1. Kelly-fraction position sizing (from EV agent output)
 * 2. Drawdown-based exposure reduction
 * 3. Consecutive-loss circuit breaker
 * 4. Daily loss limit enforcement
 * 5. Stake sizing recommendation
 *
 * Key fix vs old code:
 * - Capital Preservation agent always returned 72 (safeStake always > 0).
 *   This agent actually computes a meaningful score based on current risk state.
 * - Recovery mode no longer bypasses EV requirement.
 * - Stake sizing uses Kelly criterion fraction, not flat % of balance.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import type { EVResult } from "./ev-calculator";
import { computeStake } from "./ev-calculator";

export interface RiskDecision {
  /** Whether the risk manager allows a trade at all */
  allowTrade: boolean;
  /** Recommended stake (may be reduced from EV-optimal due to risk state) */
  recommendedStake: number;
  /** Risk budget remaining as fraction (0=exhausted, 1=full) */
  riskBudget: number;
  /** Current drawdown as fraction of peak balance */
  currentDrawdown: number;
  /** True if any hard limit is breached */
  hardStop: boolean;
  hardStopReason?: string;
  /** Risk level for UI display */
  riskLevel: "low" | "medium" | "high" | "critical";
  /** Stake multiplier applied for risk reduction */
  stakeMultiplier: number;
}

export function computeRiskDecision(
  ctx: ScanContext,
  bestEV: EVResult | null,
): RiskDecision {
  const { balance, settings, daily } = ctx;

  // ── Hard stop conditions ─────────────────────────────────────────────────
  const dailyLossRatio = Math.abs(Math.min(0, daily.profit)) / Math.max(1, settings.dailyLossLimit);

  if (daily.profit <= -settings.dailyLossLimit) {
    return hardStop(`Daily loss limit $${settings.dailyLossLimit} reached (lost $${Math.abs(daily.profit).toFixed(2)} today)`);
  }

  if (daily.consecutiveLosses >= settings.consecutiveLossLimit) {
    return hardStop(`${daily.consecutiveLosses} consecutive losses — mandatory cooldown`);
  }

  if (daily.profit >= settings.dailyTarget) {
    return hardStop(`Daily profit target $${settings.dailyTarget} reached — protect gains`);
  }

  // ── Drawdown calculation ──────────────────────────────────────────────────
  // Estimate current drawdown from daily P&L vs starting balance
  const estimatedPeak = balance - Math.min(0, daily.profit); // if profit is negative, peak was higher
  const drawdown = estimatedPeak > 0 ? Math.abs(Math.min(0, daily.profit)) / estimatedPeak : 0;
  const maxDrawdownFrac = settings.maxDrawdown / 100;

  if (drawdown >= maxDrawdownFrac) {
    return hardStop(`Max drawdown ${(drawdown * 100).toFixed(1)}% reached (limit: ${settings.maxDrawdown}%)`);
  }

  // ── Soft risk reduction ───────────────────────────────────────────────────
  // Scale down stake when approaching limits
  let stakeMultiplier = 1.0;

  // Reduce stake when approaching consecutive loss limit
  if (daily.consecutiveLosses === settings.consecutiveLossLimit - 1) stakeMultiplier *= 0.5;
  else if (daily.consecutiveLosses >= Math.floor(settings.consecutiveLossLimit / 2)) stakeMultiplier *= 0.7;

  // Reduce when approaching daily loss limit (>50% of limit used)
  if (dailyLossRatio > 0.5) stakeMultiplier *= (1 - (dailyLossRatio - 0.5));

  // Reduce when approaching drawdown limit
  const ddRatio = drawdown / Math.max(maxDrawdownFrac, 0.01);
  if (ddRatio > 0.5) stakeMultiplier *= (1 - (ddRatio - 0.5) * 0.8);

  // ── Base stake (from settings + Kelly) ───────────────────────────────────
  const baseStake = computeStake(ctx);
  let recommendedStake = baseStake * stakeMultiplier;

  // Apply Kelly fraction if we have EV data
  if (bestEV && bestEV.kellyFraction > 0) {
    const kellyStake = balance * bestEV.kellyFraction;
    // Use smaller of Kelly stake and settings-based stake
    recommendedStake = Math.min(recommendedStake, kellyStake);
  }

  recommendedStake = Math.max(0.35, Math.min(recommendedStake, settings.maxTradeStake));

  // ── Risk budget ───────────────────────────────────────────────────────────
  const lossUsed = Math.abs(Math.min(0, daily.profit)) / Math.max(0.01, settings.dailyLossLimit);
  const ddUsed = ddRatio;
  const riskBudget = Math.max(0, 1 - Math.max(lossUsed, ddUsed));

  // ── Risk level classification ──────────────────────────────────────────────
  const riskLevel: RiskDecision["riskLevel"] =
    daily.consecutiveLosses >= settings.consecutiveLossLimit - 1 || ddRatio > 0.7 ? "critical"
    : daily.consecutiveLosses >= 2 || dailyLossRatio > 0.5 || ddRatio > 0.4 ? "high"
    : daily.consecutiveLosses >= 1 || dailyLossRatio > 0.25 || ddRatio > 0.2 ? "medium"
    : "low";

  return {
    allowTrade: true,
    recommendedStake: Math.round(recommendedStake * 100) / 100,
    riskBudget,
    currentDrawdown: drawdown,
    hardStop: false,
    riskLevel,
    stakeMultiplier: Math.round(stakeMultiplier * 100) / 100,
  };
}

function hardStop(reason: string): RiskDecision {
  return {
    allowTrade: false,
    recommendedStake: 0,
    riskBudget: 0,
    currentDrawdown: 0,
    hardStop: true,
    hardStopReason: reason,
    riskLevel: "critical",
    stakeMultiplier: 0,
  };
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export function runRiskManagerAgent(
  ctx: ScanContext,
  bestEV: EVResult | null,
): AgentOutput & { riskDecision: RiskDecision } {
  const t0 = Date.now();
  const decision = computeRiskDecision(ctx, bestEV);

  const { daily, settings } = ctx;

  // Score = 100 means full risk budget, 0 means hard stop
  const score = decision.hardStop ? 0
    : Math.round(decision.riskBudget * 60 + (1 - daily.consecutiveLosses / Math.max(1, settings.consecutiveLossLimit)) * 40);

  const reasoning = decision.hardStop
    ? `HARD STOP: ${decision.hardStopReason}`
    : [
        `Risk budget: ${(decision.riskBudget * 100).toFixed(0)}%.`,
        `Consecutive losses: ${daily.consecutiveLosses}/${settings.consecutiveLossLimit}.`,
        `Daily P&L: $${daily.profit.toFixed(2)} (limit: -$${settings.dailyLossLimit}).`,
        `Drawdown: ${(decision.currentDrawdown * 100).toFixed(1)}% (max: ${settings.maxDrawdown}%).`,
        `Stake: $${decision.recommendedStake.toFixed(2)} (×${decision.stakeMultiplier} risk multiplier).`,
        `Risk level: ${decision.riskLevel.toUpperCase()}.`,
      ].join(" ");

  return {
    agentId: "riskManager",
    score: Math.max(0, Math.min(100, score)),
    confidence: 95, // risk decisions are deterministic, not probabilistic
    signal: scoreToSignal(score),
    reasoning,
    data: {
      allowTrade: decision.allowTrade,
      recommendedStake: decision.recommendedStake,
      riskBudget: decision.riskBudget,
      riskLevel: decision.riskLevel,
      hardStop: decision.hardStop,
      hardStopReason: decision.hardStopReason,
      consecutiveLosses: daily.consecutiveLosses,
      dailyProfit: daily.profit,
      drawdown: decision.currentDrawdown,
    },
    executionTimeMs: Date.now() - t0,
    riskDecision: decision,
  };
}
