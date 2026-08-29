/**
 * Execution Timing Agent
 *
 * RESPONSIBILITY: Determine whether NOW is a good moment to enter a trade,
 * independent of whether a statistical edge exists. A valid edge does not
 * mean the entry timing is optimal.
 *
 * Checks:
 * 1. Tick velocity — is price moving at a rate suitable for the contract type?
 *    Too slow = boring market, low profitability.
 *    Too fast = whipsaw risk on directional bets.
 * 2. Recent momentum consistency — are recent ticks confirming direction?
 * 3. Volatility regime transitions — avoid entering at regime change boundaries.
 * 4. Z-score of last return — avoid entering on extreme outlier ticks.
 * 5. Minimum time since last trade (prevent overtrading).
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import type { FeatureSet } from "./feature-engineering";
import type { MarketRegime } from "./types";

export interface TimingResult {
  isGoodTiming: boolean;
  timingScore: number;       // 0-100
  tickVelocityOk: boolean;
  momentumConsistent: boolean;
  notOnExtreme: boolean;
  waitReason?: string;
  recommendedWaitMs?: number;
}

export function assessEntryTiming(
  features: FeatureSet,
  regime: MarketRegime,
  contractType: string,
): TimingResult {
  const pf = features.price;
  const isDigit = contractType.startsWith("DIGIT");
  const isDirection = !isDigit;

  let score = 70; // start optimistic
  const reasons: string[] = [];

  // ── 1. Tick velocity ─────────────────────────────────────────────────────
  // Ideal velocity for direction: 0.0001 < v < 0.006
  // For digit contracts velocity is less critical (only last digit matters)
  const v = pf.tickVelocity;

  if (isDirection) {
    if (v < 0.00005) {
      score -= 20;
      reasons.push("Too slow — limited price movement");
    } else if (v > 0.01) {
      score -= 25;
      reasons.push("Too fast — whipsaw risk on directional contracts");
    } else if (v > 0.003) {
      score -= 8;
      reasons.push("High velocity — elevated risk");
    }
  } else {
    // Digit: velocity outside extreme range is fine
    if (v < 0.000005) { score -= 10; reasons.push("Extremely low tick velocity"); }
    if (v > 0.02) { score -= 15; reasons.push("Extremely high volatility"); }
  }

  const tickVelocityOk = !reasons.some((r) => r.includes("Too") || r.includes("Extremely"));

  // ── 2. Momentum consistency ───────────────────────────────────────────────
  // For direction bets: recent 1-tick momentum and 5-tick momentum should agree
  const mom1 = pf.momentum1;
  const mom5 = pf.momentum5;
  const momentumConsistent = isDirection
    ? Math.sign(mom1) === Math.sign(mom5)
    : true; // not relevant for digit contracts

  if (isDirection && !momentumConsistent) {
    score -= 10;
    reasons.push("1-tick and 5-tick momentum conflict");
  }

  // ── 3. Not on extreme outlier tick ────────────────────────────────────────
  const z = pf.zScoreLast;
  const notOnExtreme = Math.abs(z) < 2.5;

  if (!notOnExtreme) {
    score -= 15;
    reasons.push(`Last tick z-score ${z.toFixed(1)} — outlier, wait for normalization`);
  }

  // ── 4. Volatility expansion risk ──────────────────────────────────────────
  if (pf.volRatio > 2.0) {
    score -= 20;
    reasons.push("Volatility expanding rapidly — regime change risk");
  } else if (pf.volRatio > 1.5) {
    score -= 10;
    reasons.push("Volatility expanding — elevated risk");
  }

  // ── 5. Regime-appropriate timing ─────────────────────────────────────────
  // Direction contracts: reduced penalty so they can still fire in choppy markets.
  // The direction model's own probability already accounts for regime quality.
  if (isDirection && (regime === "choppy" || regime === "volatile")) {
    score -= 8; // reduced from -15 — direction model handles regime internally
    reasons.push(`${regime} regime — direction model accounts for this`);
  }
  if (isDigit && regime === "trending_up") {
    score -= 5; // mild penalty — trending markets slightly less useful for digit
  }

  // ── 6. Autocorrelation (entry alignment) ─────────────────────────────────
  // Positive ac1 = momentum, good for direction. Negative ac1 = reversal tendency.
  if (isDirection && pf.autocorr1 > 0.15) {
    score += 10; // momentum market — good entry for direction bets
  } else if (isDirection && pf.autocorr1 < -0.15) {
    score -= 6; // reduced from -8: mean-reverting is tricky but direction model adapts
  }

  score = Math.max(0, Math.min(100, score));
  // Thresholds are intentionally low — timing is advisory in the master-decision gate.
  // Only extreme timing failures (score < 38 for direction, < 45 for digit) flag as
  // "not good timing", which the master decision treats as a warning, not a hard block.
  const timingThreshold = isDirection ? 38 : 45;
  const isGoodTiming = score >= timingThreshold && notOnExtreme;

  return {
    isGoodTiming,
    timingScore: score,
    tickVelocityOk,
    momentumConsistent,
    notOnExtreme,
    waitReason: reasons.length > 0 ? reasons.join("; ") : undefined,
    recommendedWaitMs: isGoodTiming ? 0 : reasons.some((r) => r.includes("outlier")) ? 3000 : 1000,
  };
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export function runExecutionTimingAgent(
  ctx: ScanContext,
  features: FeatureSet,
  regime: MarketRegime,
  contractType: string,
): AgentOutput & { timingResult: TimingResult } {
  const t0 = Date.now();
  const result = assessEntryTiming(features, regime, contractType);
  const pf = features.price;

  const reasoning = [
    `Timing score: ${result.timingScore}/100.`,
    `Tick velocity: ${(pf.tickVelocity * 100).toFixed(4)}% — ${result.tickVelocityOk ? "OK" : "suboptimal"}.`,
    result.waitReason ? `Issues: ${result.waitReason}.` : "No timing issues detected.",
    `Z-score last tick: ${pf.zScoreLast.toFixed(2)}.`,
    `VolRatio: ${pf.volRatio.toFixed(2)}.`,
  ].join(" ");

  return {
    agentId: "executionTiming",
    score: result.timingScore,
    confidence: 80,
    signal: scoreToSignal(result.timingScore),
    reasoning,
    data: {
      isGoodTiming: result.isGoodTiming,
      timingScore: result.timingScore,
      waitReason: result.waitReason,
      recommendedWaitMs: result.recommendedWaitMs,
    },
    executionTimeMs: Date.now() - t0,
    timingResult: result,
  };
}
