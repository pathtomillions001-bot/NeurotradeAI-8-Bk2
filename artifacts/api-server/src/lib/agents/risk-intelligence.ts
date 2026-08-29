/**
 * Agent 9: Risk Intelligence Agent
 *
 * RESPONSIBILITY: Multi-layer risk assessment before every trade.
 * Checks daily loss limits, drawdown limits, Kelly-based sizing,
 * ruin probability estimation, and position concentration.
 * Acts as the primary hard-stop authority — any critical risk breach
 * blocks the trade regardless of other agent signals.
 */

import type { AgentOutput, ScanContext } from "./types";
import { RISE_FALL_PAYOUT } from "../payouts";
import { scoreToSignal } from "./types";

export interface RiskAssessment {
  allowTrade: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
  recommendedStake: number;
  kellyStake: number;
  ruinProbability: number;     // P(ruin) over next 100 trades
  dailyLossRemaining: number;
  drawdownBuffer: number;      // % remaining before drawdown limit
  blockers: string[];
  warnings: string[];
}

// Gambler's ruin probability approximation
function ruinProbability(
  winRate: number,
  edgePerTrade: number,
  capital: number,
  stake: number,
): number {
  if (winRate <= 0 || winRate >= 1 || stake <= 0 || capital <= 0) return 1;
  // Simplified: P(ruin) ≈ ((q/p)^(capital/stake)) where p=winP, q=1-p
  // Extended to include expected value
  const p = winRate;
  const q = 1 - p;
  if (p <= q) return 1; // negative edge — ruin certain eventually
  const ratio = q / p;
  const n = capital / stake; // number of stakes of capital
  return Math.pow(ratio, n) / (1 - Math.pow(ratio, n) + 1e-10);
}

// Full Kelly fraction (capped at 25% to prevent catastrophic sizing)
function kellyFraction(winRate: number, payoutMult: number): number {
  const b = payoutMult - 1;
  const p = winRate;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  return Math.max(0, Math.min(0.25, kelly * 0.5)); // half-Kelly
}

export function runRiskIntelligenceAgent(
  ctx: ScanContext,
  winProbability = 0.5,
  payoutMultiplier = RISE_FALL_PAYOUT,
  currentDrawdown = 0, // as fraction 0-1
): AgentOutput & { riskAssessment: RiskAssessment } {
  const t0 = Date.now();
  const { balance, daily, settings } = ctx;
  // daily.profit is the authoritative daily P&L (negative = loss)
  const dailyPnl = daily?.profit ?? 0;

  const blockers: string[] = [];
  const warnings: string[] = [];

  // ── 1. Daily loss limit ────────────────────────────────────────────────────
  const dailyLossLimit = settings.dailyLossLimit ?? (balance * 0.05);
  const dailyLoss = Math.abs(Math.min(0, dailyPnl));
  const dailyLossRemaining = Math.max(0, dailyLossLimit - dailyLoss);

  if (dailyLoss >= dailyLossLimit) {
    blockers.push(`Daily loss limit reached (${dailyLoss.toFixed(2)} / ${dailyLossLimit.toFixed(2)})`);
  } else if (dailyLoss >= dailyLossLimit * 0.8) {
    warnings.push(`Near daily loss limit: ${dailyLossRemaining.toFixed(2)} remaining`);
  }

  // ── 2. Max drawdown check ──────────────────────────────────────────────────
  // settings.maxDrawdown is stored as a PERCENTAGE (e.g. 20 = 20%), but
  // currentDrawdown is a fraction (0–1). Convert to fraction for comparison.
  const maxDrawdown = (settings.maxDrawdown ?? 20) / 100;
  const drawdownBuffer = maxDrawdown - currentDrawdown;

  if (currentDrawdown >= maxDrawdown) {
    blockers.push(`Max drawdown breached: ${(currentDrawdown * 100).toFixed(1)}% ≥ ${(maxDrawdown * 100).toFixed(0)}%`);
  } else if (currentDrawdown >= maxDrawdown * 0.85) {
    warnings.push(`Approaching drawdown limit: ${((maxDrawdown - currentDrawdown) * 100).toFixed(1)}% buffer`);
  }

  // ── 3. Kelly stake calculation ─────────────────────────────────────────────
  const kf = kellyFraction(winProbability, payoutMultiplier);
  const kellyStake = balance * kf;

  // ── 4. Ruin probability ────────────────────────────────────────────────────
  const stake = computeRecommendedStake(ctx, kf, winProbability);
  const ruinP = ruinProbability(winProbability, (winProbability * (payoutMultiplier - 1) - (1 - winProbability)), balance, stake);

  if (ruinP > 0.3) {
    blockers.push(`Ruin probability too high: ${(ruinP * 100).toFixed(0)}%`);
  } else if (ruinP > 0.15) {
    warnings.push(`Elevated ruin risk: ${(ruinP * 100).toFixed(0)}%`);
  }

  // ── 5. Minimum balance check ───────────────────────────────────────────────
  const minBalance = settings.maxTradeStake * 5;
  if (balance < minBalance) {
    warnings.push(`Low balance ($${balance.toFixed(2)}) — risk of forced stop`);
  }

  // ── 6. Risk level classification ──────────────────────────────────────────
  const riskLevel: RiskAssessment["riskLevel"] = blockers.length > 0 ? "critical"
    : warnings.length >= 2 ? "high"
    : warnings.length === 1 ? "medium"
    : "low";

  const allowTrade = blockers.length === 0;

  // ── 7. Score ───────────────────────────────────────────────────────────────
  const score = blockers.length > 0 ? 5
    : riskLevel === "high" ? 40
    : riskLevel === "medium" ? 65
    : Math.min(95, Math.round(70 + (1 - ruinP) * 25));

  const reasoning = [
    `Risk level: ${riskLevel.toUpperCase()}.`,
    `Kelly stake: $${kellyStake.toFixed(2)}, Recommended: $${stake.toFixed(2)}.`,
    `Daily loss: $${dailyLoss.toFixed(2)} / $${dailyLossLimit.toFixed(2)} (${dailyLossRemaining.toFixed(2)} left).`,
    `Ruin probability: ${(ruinP * 100).toFixed(1)}%. Drawdown buffer: ${(drawdownBuffer * 100).toFixed(1)}%.`,
    blockers.length > 0 ? `🚫 Blockers: ${blockers.join("; ")}.` : "",
    warnings.length > 0 ? `⚠ Warnings: ${warnings.join("; ")}.` : "",
  ].filter(Boolean).join(" ");

  const riskAssessment: RiskAssessment = {
    allowTrade, riskLevel, recommendedStake: stake, kellyStake,
    ruinProbability: ruinP, dailyLossRemaining, drawdownBuffer, blockers, warnings,
  };

  return {
    agentId: "riskIntelligence",
    score,
    confidence: 95,
    signal: scoreToSignal(score),
    reasoning,
    data: { riskAssessment },
    executionTimeMs: Date.now() - t0,
    riskAssessment,
  };
}

function computeRecommendedStake(ctx: ScanContext, kf: number, _winP: number): number {
  const { balance, settings } = ctx;
  const riskMult = settings.riskProfile === "conservative" ? 0.4
    : settings.riskProfile === "aggressive" ? 1.0 : 0.7;

  let settingsBased: number;
  if (settings.riskAmountType === "fixed") {
    // Fixed mode: use the exact dollar amount the user set
    const fixedAmount = Number(settings.riskAmountValue);
    settingsBased = (!isFinite(fixedAmount) || fixedAmount <= 0) ? 1 : fixedAmount * riskMult;
  } else {
    // Percentage mode: riskAmountValue holds the % figure — do NOT use maxRiskPerTrade
    const riskPct = Number(settings.riskAmountValue);
    const effectiveRiskPct = (!isFinite(riskPct) || riskPct <= 0) ? 1 : riskPct;
    settingsBased = balance * (effectiveRiskPct / 100) * riskMult;
  }
  const kellyBased    = balance * kf;

  // When Kelly fraction is positive AND large enough to produce a meaningful stake,
  // cap by Kelly; otherwise always honour the user's own risk settings.
  // This prevents near-zero Kelly fractions from pulling the stake below $0.35.
  const stake = (kf > 0.001 && kellyBased >= 0.35)
    ? Math.min(kellyBased, settingsBased)
    : settingsBased;

  return Math.max(0.35, Math.min(stake, settings.maxTradeStake));
}
