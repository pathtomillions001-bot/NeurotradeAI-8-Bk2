/**
 * Agent 7: Confidence Fusion Agent
 *
 * RESPONSIBILITY: Fuse the signals from all upstream agents into a single,
 * calibrated confidence score and trade recommendation. Replaces the scoring
 * portion of master-decision.ts with a per-market adaptive threshold system.
 * Uses Bayesian model averaging weighted by each agent's historical accuracy.
 */

import type { AgentOutput, ScanContext, ProductType } from "./types";
import { scoreToSignal } from "./types";
import type { DirectionResult } from "./rise-fall-agent";
import type { BarrierOption } from "./digit-probability";
import type { EVResult } from "./ev-calculator";
import { getDynamicWeights, getAdaptiveConfidenceThreshold, getAdaptiveEvThreshold, getAdaptiveTimingThreshold } from "./dynamic-confidence";
import { getStructuralLossPattern } from "./recovery-intelligence";

export interface FusionInput {
  marketScannerScore: number;
  tickIntelligenceScore: number;
  digitProbabilityScore: number;
  riseFallScore: number;
  marketRegimeScore: number;
  executionTimingScore: number;
  recoveryIntelligenceScore: number;
  riskIntelligenceScore: number;
  portfolioManagerScore: number;
  learningAgentScore: number;
  patternDiscoveryScore: number;

  // Domain data
  directionResult: DirectionResult | null;
  bestBarrier: BarrierOption | null;
  bestEVResult: EVResult | null;
  preferredTypes: ProductType[];
  contractType: ProductType | null;
  barrier: number | null;
  regime: string | null;
}

export interface FusionResult {
  shouldTrade: boolean;
  overallConfidence: number;   // 0-100
  recommendedAction: "buy" | "wait" | "skip";
  recommendedContractType: ProductType | null;
  recommendedBarrier: number | null;
  blockers: string[];
  enhancers: string[];
  agentWeightedScore: number;
  evGated: boolean;
  timingGated: boolean;
}

// Base per-agent weights — used when dynamic-confidence hasn't accumulated
// enough data yet. Once ≥5 trades per agent are recorded, getDynamicWeights()
// blends these with accuracy-driven multipliers automatically.
// NOTE: Keep in sync with dynamic-confidence.ts BASE_WEIGHTS.
const BASE_AGENT_WEIGHTS: Record<string, number> = {
  marketScanner:        1.5,  // hard gate — ineligible market kills the trade
  tickIntelligence:     0.8,
  digitProbability:     1.2,  // direct EV predictor for digit contracts
  riseFallAgent:        1.2,  // direct EV predictor for direction contracts
  marketRegime:         1.0,
  executionTiming:      0.7,  // advisory
  recoveryIntelligence: 1.2,  // raised: must carry real veto weight during loss streaks
  riskIntelligence:     1.3,  // hard-stop authority
  portfolioManager:     1.1,
  learningAgent:        1.1,  // raised: historical calibration steers trade selection
  patternDiscovery:     0.5,  // enhancement only
};

export function runConfidenceFusionAgent(
  ctx: ScanContext,
  input: FusionInput,
): AgentOutput & { fusionResult: FusionResult } {
  const t0 = Date.now();

  const blockers: string[] = [];
  const enhancers: string[] = [];
  const preferred = input.preferredTypes;
  const isOverUnder = input.contractType === "DIGITOVER" || input.contractType === "DIGITUNDER";
  const sessionLosses = ctx.daily.consecutiveLosses;

  // ── 1. Hard gates ────────────────────────────────────────────────────────────
  if (input.marketScannerScore < 20 && !isOverUnder) {
    blockers.push("Market scanner: market ineligible");
  }
  if (input.riskIntelligenceScore < 20) {
    blockers.push("Risk intelligence: hard risk stop");
  }
  if (input.portfolioManagerScore < 20) {
    blockers.push("Portfolio manager: position limit reached");
  }
  // Recovery intelligence hard-gate: at ≥4 consecutive losses the recovery agent
  // drops to score 15, triggering this explicit block (weighted averaging alone
  // is not enough — we need a guaranteed veto to protect capital during severe streaks).
  if (input.recoveryIntelligenceScore < 20) {
    blockers.push("Recovery intelligence: consecutive loss limit — mandatory pause before next trade");
  }

  // Structural loss pattern gate: if ≥2 of the last 4 losses on this symbol
  // share the same contractType + market regime, suppress that exact combo for
  // one more scan. A win on ANY contract type on this symbol clears the pattern.
  // This prevents the engine from blindly re-entering a proven losing setup
  // (e.g. DIGITOVER in trending_up twice in a row) without raising the bar globally.
  const structuralPattern = getStructuralLossPattern(ctx.symbol);
  const candidateType = input.contractType ?? "";
  if (
    structuralPattern &&
    structuralPattern.contractType === candidateType &&
    structuralPattern.regime === input.regime &&
    sessionLosses >= 2
  ) {
    blockers.push(
      `Structural loss pattern: ${candidateType} in ${structuralPattern.regime} regime has lost ≥2 times — waiting for regime shift`,
    );
  }

  // ── Resolve dynamic weights (accuracy-driven, falls back to base) ────────────
  const AGENT_WEIGHTS = getDynamicWeights();
  const TOTAL_WEIGHT = Object.values(AGENT_WEIGHTS).reduce((a, b) => a + b, 0);

  // ── 2. EV gate ───────────────────────────────────────────────────────────────
  // EV is always a semi-hard gate — the engine never trades on genuinely terrible EV.
  // A baseline floor of -0.04 applies in all conditions (normal: some house-edge tolerated,
  // e.g. DIGITDIFF is structurally -3%). During loss streaks the bar tightens further.
  //
  // 0 losses  → EV ≥ max(adaptive, -0.04)  — baseline always enforced
  // 2 losses  → EV ≥ -0.02                 — tighter: edge required
  // 3+ losses → EV > 0                     — strictly positive (capital protection)
  const adaptiveMinEV = getAdaptiveEvThreshold();
  const baselineMinEV = Math.max(adaptiveMinEV, -0.04);   // -4% floor, always applied
  const minEV = sessionLosses >= 3 ? 0.001 : sessionLosses >= 2 ? -0.02 : baselineMinEV;
  // OVER/UNDER barriers are user-directed contracts. Their low fixed payouts make
  // raw EV negative in most statistically normal markets, so EV must inform the
  // analysis without vetoing the configured contract after the agents agree.
  const evPasses = isOverUnder || (input.bestEVResult !== null && input.bestEVResult.expectedValue >= minEV);
  const evGated = evPasses;
  if (!isOverUnder && !evPasses && input.bestEVResult !== null) {
    const streakNote = sessionLosses >= 3 ? ` (${sessionLosses} losses — strictly positive EV required)`
      : sessionLosses >= 2 ? ` (${sessionLosses} losses — tighter EV gate)` : "";
    blockers.push(`EV gate: ${(input.bestEVResult.expectedValue * 100).toFixed(1)}% < ${(minEV * 100).toFixed(0)}% required${streakNote}`);
  }

  // ── 3. Timing gate ───────────────────────────────────────────────────────────
  const adaptiveTimingThreshold = getAdaptiveTimingThreshold();
  const minTimingScore = sessionLosses >= 3 ? 50 : sessionLosses >= 2 ? 44 : adaptiveTimingThreshold;
  const timingGated = isOverUnder || input.executionTimingScore >= minTimingScore;
  if (!isOverUnder && !timingGated) {
    blockers.push(`Timing score ${input.executionTimingScore} < ${minTimingScore} — suboptimal entry`);
  }

  // ── 4. Weighted score aggregation ────────────────────────────────────────────
  const scores: Record<string, number> = {
    marketScanner: input.marketScannerScore,
    tickIntelligence: input.tickIntelligenceScore,
    digitProbability: input.digitProbabilityScore,
    riseFallAgent: input.riseFallScore,
    marketRegime: input.marketRegimeScore,
    executionTiming: input.executionTimingScore,
    recoveryIntelligence: input.recoveryIntelligenceScore,
    riskIntelligence: input.riskIntelligenceScore,
    portfolioManager: input.portfolioManagerScore,
    learningAgent: input.learningAgentScore,
    patternDiscovery: input.patternDiscoveryScore,
  };

  let weightedSum = 0;
  for (const [agentId, weight] of Object.entries(AGENT_WEIGHTS)) {
    weightedSum += (scores[agentId] ?? 50) * weight;
  }
  const agentWeightedScore = Math.round(weightedSum / TOTAL_WEIGHT);

  // ── 5. Per-market adaptive threshold ─────────────────────────────────────────
  // Uses the Dynamic Confidence Engine's learned threshold (calibrated from historical
  // outcomes) instead of a fixed value. The learning engine adjusts this ±0.5 per trade
  // based on recent win-rate, keeping it within [MIN_THRESHOLD, MAX_THRESHOLD].
  const historyAdjust = (input.learningAgentScore - 50) * 0.1; // ±5 adjustment
  const adaptiveBase = getAdaptiveConfidenceThreshold(ctx.settings.minConfidenceThreshold ?? 50);
  // During a loss streak, raise the bar aggressively: each consecutive loss adds 6 points,
  // capped at +30. Floor raised from 44 → 50 so the engine only trades when at least
  // half the agents agree — this is the main lever for avoiding low-quality trades.
  const lossStreakBoost = Math.min(sessionLosses * 6, 30);
  const effectiveThreshold = Math.max(50, Math.min(82, adaptiveBase + historyAdjust + lossStreakBoost));

  // ── 6. Enhancement signals ────────────────────────────────────────────────────
  if (input.patternDiscoveryScore > 70) enhancers.push("Pattern discovery: recognized profitable pattern");
  if (input.learningAgentScore > 75) enhancers.push("Learning agent: strategy historically profitable");
  if (input.tickIntelligenceScore > 75) enhancers.push("Tick intelligence: strong directional bias");
  if (input.marketRegimeScore > 70) enhancers.push("Market regime: favorable conditions");

  // ── 7. Contract type selection ────────────────────────────────────────────────
  let recommendedContractType: ProductType | null = input.contractType;
  let recommendedBarrier: number | null = input.barrier;

  if (!recommendedContractType && input.bestEVResult) {
    recommendedContractType = input.bestEVResult.product;
    recommendedBarrier = input.bestEVResult.barrier ?? null;
  }

  if (!recommendedContractType && input.directionResult) {
    const wantCall = preferred.some(t => t === "CALL" || t === "RISE");
    const wantPut = preferred.some(t => t === "PUT" || t === "FALL");
    if (wantCall && input.directionResult.direction === "up") recommendedContractType = "CALL";
    else if (wantPut && input.directionResult.direction === "down") recommendedContractType = "PUT";
  }

  if (!recommendedContractType && input.bestBarrier) {
    recommendedContractType = input.bestBarrier.contractType;
    recommendedBarrier = input.bestBarrier.barrier;
  }

  // ── 8. Final decision ─────────────────────────────────────────────────────────
  const hardBlocked = blockers.some(b =>
    b.includes("ineligible") || b.includes("hard risk") || b.includes("position limit")
  );

  const overallConfidence = agentWeightedScore;
  const meetsThreshold = isOverUnder || overallConfidence >= effectiveThreshold;

  // During a loss streak (≥2 consecutive losses) timing becomes a hard gate, not advisory.
  // In normal conditions timing is advisory so the engine keeps trading; during recovery
  // we want the most favourable entry, so we block poor-timing setups.
  const timingRequired = sessionLosses >= 2 && !isOverUnder;
  const timingPass = !timingRequired || timingGated;

  const shouldTrade = !hardBlocked && meetsThreshold && evGated && timingPass && !!recommendedContractType;
  const recommendedAction: FusionResult["recommendedAction"] = hardBlocked ? "skip"
    : !meetsThreshold ? "wait" : shouldTrade ? "buy" : "wait";

  const score = overallConfidence;

  const reasoning = [
    `Weighted consensus: ${agentWeightedScore}/100 (threshold: ${effectiveThreshold}).`,
    `EV gate: ${evGated ? "pass" : "fail"}. Timing: ${timingGated ? "OK" : "suboptimal"}.`,
    enhancers.length > 0 ? `Enhancers: ${enhancers.slice(0, 2).join("; ")}.` : "",
    blockers.length > 0 ? `Blockers: ${blockers.join("; ")}.` : "",
    `Decision: ${recommendedAction.toUpperCase()} ${recommendedContractType ?? "?"}${recommendedBarrier != null ? ` @${recommendedBarrier}` : ""}.`,
  ].filter(Boolean).join(" ");

  const fusionResult: FusionResult = {
    shouldTrade, overallConfidence, recommendedAction,
    recommendedContractType, recommendedBarrier,
    blockers, enhancers, agentWeightedScore, evGated, timingGated,
  };

  return {
    agentId: "confidenceFusion",
    score,
    confidence: overallConfidence,
    signal: scoreToSignal(score),
    reasoning,
    data: { fusionResult },
    executionTimeMs: Date.now() - t0,
    fusionResult,
  };
}
