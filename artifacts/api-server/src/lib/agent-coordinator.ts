/**
 * Agent Coordinator — 13-Agent Institutional System
 *
 * Orchestrates the complete 13-agent pipeline for every market scan.
 *
 * Pipeline (stages run in dependency order, parallel where possible):
 *
 *   Stage 1:       Feature Engineering (data pipeline)
 *   Stage 2 (∥):  Market Scanner + Tick Intelligence + Market Regime
 *   Stage 3 (∥):  Digit Probability + Rise/Fall + Portfolio Manager + Recovery Intelligence
 *   Stage 3.5:    Duration Optimizer (needs regime + features)
 *   Stage 4:      EV Calculator (needs direction + digit + duration)
 *   Stage 5 (∥):  Risk Intelligence + Execution Timing + Learning Agent
 *   Stage 6 (∥):  Pattern Discovery + Confidence Fusion
 *   Stage 7:      Trade Explainability
 *   Stage 8:      Master Decision → CoordinatorOutput
 *
 * Backward compatible: same CoordinatorOutput shape, same API contract.
 */

import type { ScanContext, CoordinatorOutput, TradingSettings, DailyStats } from "./agents/types";

// ── Stage 1: Data pipeline ────────────────────────────────────────────────────
import { runFeatureEngineeringAgent } from "./agents/feature-engineering";

// ── Stage 2: Market evaluation ────────────────────────────────────────────────
import { runMarketScannerAgent } from "./agents/market-scanner";
import { runTickIntelligenceAgent } from "./agents/tick-intelligence";
import { runMarketRegimeAgent } from "./agents/market-regime";

// ── Stage 3: Contract-specific analysis ───────────────────────────────────────
import { runDigitProbabilityAgent } from "./agents/digit-probability";
import { runRiseFallAgent } from "./agents/rise-fall-agent";
import { runPortfolioManagerAgent } from "./agents/portfolio-manager";
import { runRecoveryIntelligenceAgent } from "./agents/recovery-intelligence";

// ── Stage 3.5: Duration optimization ──────────────────────────────────────────
import { selectOptimalDuration } from "./agents/duration-optimizer";

// ── Stage 4: Expected value ────────────────────────────────────────────────────
import { runEVCalculatorAgent, computeStake } from "./agents/ev-calculator";

// ── Stage 5: Risk, timing, learning ───────────────────────────────────────────
import { runRiskIntelligenceAgent } from "./agents/risk-intelligence";
import { runExecutionTimingAgent } from "./agents/execution-timing";
import { runLearningAgent, recordTradeOutcome as learningRecordOutcome, getStrategyStats } from "./agents/learning-agent";

// ── Stage 6: Pattern + Fusion ─────────────────────────────────────────────────
import { runPatternDiscoveryAgent, recordSnapshot } from "./agents/pattern-discovery";
import { runConfidenceFusionAgent } from "./agents/confidence-fusion";
import type { FusionInput } from "./agents/confidence-fusion";

// ── Stage 7: Explainability ────────────────────────────────────────────────────
import { runTradeExplainabilityAgent } from "./agents/trade-explainability";

// ── Stage 8: Master decision (CoordinatorOutput builder) ──────────────────────
import { makeFinalDecision } from "./agents/master-decision";

// ── Utilities ─────────────────────────────────────────────────────────────────
import { analyzeDigits, getContractProposal } from "./deriv";
import { logger } from "./logger";
import { MATCH_PAYOUT, DIFF_PAYOUT, RISE_FALL_PAYOUT } from "./payouts";

// ── Re-exports for backward compatibility ─────────────────────────────────────
export type { CoordinatorOutput } from "./agents/types";
export { getStrategyStats } from "./agents/learning-agent";

/** Re-export: called from ai.ts after every completed trade */
export function recordTradeOutcome(
  symbol: string,
  contractType: string,
  barrier: number | null | undefined,
  won: boolean,
  profit: number,
  stake: number,
): void {
  learningRecordOutcome(symbol, contractType, barrier, won, profit, stake);
}


// ── Payout cache (20-min TTL) ─────────────────────────────────────────────────
const payoutCache = new Map<string, { value: number; ts: number }>();
const PAYOUT_TTL_MS = 20 * 60 * 1000;

async function fetchLivePayouts(
  symbol: string,
  contractTypes: string[],
  token: string | null,
  currency: string,
  stake: number,
  duration: number,
  barrier?: number,
): Promise<Record<string, number>> {
  if (!token) return {};
  const now = Date.now();
  const result: Record<string, number> = {};

  await Promise.all(
    contractTypes.map(async (ct) => {
      const cacheKey = `${symbol}:${ct}:${barrier ?? ""}`;
      const hit = payoutCache.get(cacheKey);
      if (hit && now - hit.ts < PAYOUT_TTL_MS) {
        result[ct] = hit.value;
        return;
      }
      try {
        const proposal = await Promise.race([
          getContractProposal(token, {
            symbol,
            contractType: ct,
            stake,
            duration,
            durationUnit: "t",
            currency,
            barrier: ct.startsWith("DIGIT") ? barrier : undefined,
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        if (proposal?.payoutMultiplier) {
          result[ct] = proposal.payoutMultiplier;
          payoutCache.set(cacheKey, { value: proposal.payoutMultiplier, ts: now });
        }
      } catch { /* fall through to defaults */ }
    }),
  );

  return result;
}

// ── Main coordinator function ─────────────────────────────────────────────────

export async function runCoordinator(ctx: ScanContext): Promise<CoordinatorOutput> {
  const t0 = Date.now();
  const preferred = ctx.settings.preferredContractTypes;

  const wantDirection = preferred.some(t => ["RISE", "FALL", "CALL", "PUT"].includes(t));
  const wantDigit = preferred.some(t => ["DIGITOVER", "DIGITUNDER"].includes(t));
  const wantEvenOdd = preferred.some(t => ["DIGITEVEN", "DIGITODD"].includes(t));
  const wantMatchDiff = preferred.some(t => ["DIGITMATCH", "DIGITDIFF"].includes(t));

  // ── Stage 1: Feature Engineering (data pipeline) ──────────────────────────
  const feAgent = runFeatureEngineeringAgent(ctx);
  const features = feAgent.featureSet;

  // ── Stage 2: Market Scanner + Tick Intelligence + Market Regime (parallel) ─
  const [scannerAgent, tickAgent, regimeAgent] = await Promise.all([
    Promise.resolve(runMarketScannerAgent(ctx)),
    Promise.resolve(runTickIntelligenceAgent(ctx)),
    Promise.resolve(runMarketRegimeAgent(ctx, features)),
  ]);

  const scannerResult = scannerAgent.scannerResult;
  const tickResult = tickAgent.tickResult;
  const regime = regimeAgent.regimeOutput.regime;

  // ── Stage 3: Contract-specific analysis (parallel) ─────────────────────────
  const [digitAgent, riseFallAgentOut, portfolioAgent, recoveryAgent] = await Promise.all([
    Promise.resolve(runDigitProbabilityAgent(ctx)),
    Promise.resolve(runRiseFallAgent(ctx, features, ctx.settings.tradeDurationSec)),
    Promise.resolve(runPortfolioManagerAgent(ctx)),
    Promise.resolve(runRecoveryIntelligenceAgent(ctx)),
  ]);

  const dirResult = riseFallAgentOut.directionResult;
  const barrierOptions = digitAgent.barrierOptions;
  const bestBarrier = digitAgent.bestBarrier;

  // ── Stage 3.5: Duration Optimizer ─────────────────────────────────────────
  const preferredDigitProduct = preferred.includes("DIGITOVER")
    ? "DIGITOVER"
    : preferred.includes("DIGITUNDER")
      ? "DIGITUNDER"
      : "DIGITOVER";
  const candidateProduct = wantDigit
    ? (bestBarrier && preferred.includes(bestBarrier.contractType)
      ? bestBarrier.contractType
      : preferredDigitProduct)
    : wantMatchDiff
      // Normal mode → DIGITDIFF (coldest digit, ~96% win); recovery → DIGITMATCH (8.93× payout).
      // Use whichever type is actually in the preferred list for this family scan.
      ? (preferred.includes("DIGITDIFF") ? "DIGITDIFF" : "DIGITMATCH")
      : wantDirection
        ? (dirResult.direction === "up" ? "CALL" : "PUT")
        : wantEvenOdd ? "DIGITEVEN" : "DIGITOVER";

  const durationOpt = selectOptimalDuration(ctx, features, regime, candidateProduct);
  const optimizedDuration = durationOpt.duration;

  // ── Stage 4: EV Calculator ────────────────────────────────────────────────
  const payoutStake = computeStake(ctx);
  const contractTypesToFetch = [
    ...(wantDirection ? ["CALL", "PUT"] : []),
    ...(wantDigit ? ["DIGITOVER", "DIGITUNDER"] : []),
    ...(wantEvenOdd ? ["DIGITEVEN", "DIGITODD"] : []),
    ...(wantMatchDiff ? ["DIGITMATCH", "DIGITDIFF"] : []),
  ];

  let livePayouts: Record<string, number> | null = null;
  if (contractTypesToFetch.length > 0 && ctx.token && !ctx.settings.paperTradeMode) {
    try {
      livePayouts = await fetchLivePayouts(
        ctx.symbol, contractTypesToFetch, ctx.token, ctx.currency,
        payoutStake, optimizedDuration, bestBarrier?.barrier,
      );
    } catch { livePayouts = null; }
  }

  let evenProb: number | undefined;
  if (wantEvenOdd && ctx.digits.length >= 20) {
    evenProb = ctx.digits.slice(-100).filter(d => d % 2 === 0).length / Math.min(100, ctx.digits.length);
  }

  // Extend barrier options with DIGITMATCH/DIGITDIFF when preferred.
  // The matchRecommended/diffRecommended flags required positive EV which is extremely
  // rare for these contracts (DIFF needs >91.7% win rate; MATCH needs >11% frequency).
  // Remove those gates — always include the options and let the EV calculator + confidence
  // fusion decide. DIGITMATCH is added in recovery mode (8.93× payout covers losses cheaply);
  // DIGITDIFF is added in normal mode (coldest digit gives ~96% win rate, near-certain win).
  //
  // IMPORTANT: only seed the list with OVER/UNDER barrier options when the user actually
  // wants OVER/UNDER. If this is a pure matchdiff-family scan (wantDigit = false), start
  // empty so that OVER/UNDER options can never "win" the EV tournament and hijack the
  // recommendation away from DIGITDIFF/DIGITMATCH.
  //
  // STRICT PREFERRED FILTER: only include barrier options for contract types the user
  // has actually enabled. If the user enables ONLY DIGITOVER (not DIGITUNDER), digit-
  // probability still produces both options (at the user-configured barriers) — we must
  // filter here so the EV tournament never recommends the disabled type.
  const allBarrierOptions = wantDigit
    ? [...barrierOptions].filter(b => preferred.includes(b.contractType as string))
    : [];
  if (wantMatchDiff && digitAgent.matchDiffersAnalysis && ctx.digits.length >= 30) {
    const md = digitAgent.matchDiffersAnalysis;
    if (preferred.includes("DIGITMATCH")) {
      allBarrierOptions.push({
        contractType: "DIGITMATCH" as import("./agents/types").ProductType,
        barrier: md.matchDigit,
        winProbability: md.matchWinProbability,
        payout: livePayouts?.["DIGITMATCH"] ?? MATCH_PAYOUT,
        expectedValue: md.matchExpectedValue,
        edge: md.matchEdge,
        tier: 2,
        adjustedEvScore: md.matchEdge > 0 ? md.matchExpectedValue * 10 : md.matchExpectedValue,
      });
    }
    if (preferred.includes("DIGITDIFF")) {
      allBarrierOptions.push({
        contractType: "DIGITDIFF" as import("./agents/types").ProductType,
        barrier: md.diffDigit,
        winProbability: md.diffWinProbability,
        payout: livePayouts?.["DIGITDIFF"] ?? DIFF_PAYOUT,
        expectedValue: md.diffExpectedValue,
        edge: md.diffEdge,
        tier: 1,
        // DIGITDIFF EV is typically slightly negative (needs >91.7% win to be +EV) but the
        // near-certain win rate provides a different kind of edge. Boost the adjustedEvScore
        // so it competes fairly against other options in the EV tournament.
        adjustedEvScore: md.diffWinProbability > 0.9 ? md.diffExpectedValue + 0.08 : md.diffExpectedValue,
      });
    }
  }

  const evAgent = runEVCalculatorAgent(
    ctx,
    wantDirection ? dirResult : null,
    (wantDigit || wantMatchDiff) ? allBarrierOptions : [],
    livePayouts && Object.keys(livePayouts).length > 0 ? livePayouts : null,
    evenProb,
  );
  const bestEV = evAgent.bestEVResult;

  const effectiveContractType = bestEV?.product ?? candidateProduct;
  const configuredBarrier = effectiveContractType === "DIGITOVER"
    ? ctx.recoveryBarrierOverride?.DIGITOVER ?? ctx.settings.normalOverDigit
    : effectiveContractType === "DIGITUNDER"
      ? ctx.recoveryBarrierOverride?.DIGITUNDER ?? ctx.settings.normalUnderDigit
      : undefined;
  // Keep the exact user-configured barrier attached even if a low-data scan has
  // no EV result to supply one. Never substitute a neighboring barrier.
  const effectiveBarrier = bestEV?.barrier ?? configuredBarrier;

  // ── Stage 5: Risk Intelligence + Execution Timing + Learning Agent (parallel) ─
  const currentDrawdown = Math.max(0, -ctx.daily.profit / (ctx.balance || 1));

  const [riskAgent, timingAgent, learningAgentOut] = await Promise.all([
    Promise.resolve(runRiskIntelligenceAgent(
      ctx,
      bestEV?.winProbability ?? 0.5,
      bestEV?.payoutMultiplier ?? RISE_FALL_PAYOUT,
      currentDrawdown,
    )),
    Promise.resolve(runExecutionTimingAgent(ctx, features, regime, effectiveContractType)),
    Promise.resolve(runLearningAgent(ctx, effectiveContractType, effectiveBarrier)),
  ]);

  const riskAssessment = riskAgent.riskAssessment;
  const timingResult = timingAgent.timingResult;
  const strategyStats = learningAgentOut.stats;

  // ── Stage 6: Pattern Discovery + Confidence Fusion (parallel) ─────────────
  const patternState = {
    hurst: features.price.hurst,
    volatility: features.price.vol20,
    momentum: features.price.momentum5,
    entropy: features.price.returnEntropy,
  };

  const fusionInput: FusionInput = {
    marketScannerScore:       scannerAgent.score,
    tickIntelligenceScore:    tickAgent.score,
    digitProbabilityScore:    digitAgent.score,
    riseFallScore:            riseFallAgentOut.score,
    marketRegimeScore:        regimeAgent.score,
    executionTimingScore:     timingAgent.score,
    recoveryIntelligenceScore: recoveryAgent.score,
    riskIntelligenceScore:    riskAgent.score,
    portfolioManagerScore:    portfolioAgent.score,
    learningAgentScore:       learningAgentOut.score,
    patternDiscoveryScore:    50, // placeholder — computed in next step
    directionResult:          dirResult,
    bestBarrier:              bestBarrier ?? null,
    bestEVResult:             bestEV,
    preferredTypes:           preferred as any,
    contractType:             (effectiveContractType as any) ?? null,
    barrier:                  effectiveBarrier ?? null,
    regime,
  };

  const [patternAgent, fusionAgentPrelim] = await Promise.all([
    Promise.resolve(runPatternDiscoveryAgent(ctx, effectiveContractType, patternState)),
    Promise.resolve(runConfidenceFusionAgent(ctx, fusionInput)),
  ]);

  // Re-run fusion with actual pattern score
  fusionInput.patternDiscoveryScore = patternAgent.score;
  const fusionAgent = runConfidenceFusionAgent(ctx, fusionInput);
  const fusionResult = fusionAgent.fusionResult;

  // ── Stage 7: Trade Explainability ─────────────────────────────────────────
  const agentScores: Record<string, number> = {
    marketScanner:       scannerAgent.score,
    tickIntelligence:    tickAgent.score,
    digitProbability:    digitAgent.score,
    riseFallAgent:       riseFallAgentOut.score,
    marketRegime:        regimeAgent.score,
    executionTiming:     timingAgent.score,
    confidenceFusion:    fusionAgent.score,
    recoveryIntelligence: recoveryAgent.score,
    riskIntelligence:    riskAgent.score,
    portfolioManager:    portfolioAgent.score,
    learningAgent:       learningAgentOut.score,
    patternDiscovery:    patternAgent.score,
  };

  const agentReasonings: Record<string, string> = {
    marketScanner:       scannerAgent.reasoning,
    tickIntelligence:    tickAgent.reasoning,
    digitProbability:    digitAgent.reasoning,
    riseFallAgent:       riseFallAgentOut.reasoning,
    marketRegime:        regimeAgent.reasoning,
    executionTiming:     timingAgent.reasoning,
    confidenceFusion:    fusionAgent.reasoning,
    recoveryIntelligence: recoveryAgent.reasoning,
    riskIntelligence:    riskAgent.reasoning,
    portfolioManager:    portfolioAgent.reasoning,
    learningAgent:       learningAgentOut.reasoning,
    patternDiscovery:    patternAgent.reasoning,
  };

  const explainabilityInput = {
    contractType:    (fusionResult.recommendedContractType ?? (effectiveContractType as any)) ?? null,
    barrier:         fusionResult.recommendedBarrier ?? effectiveBarrier ?? null,
    stake:           riskAssessment.recommendedStake,
    duration:        optimizedDuration,
    symbol:          ctx.symbol,
    agentScores,
    agentReasonings,
    shouldTrade:     fusionResult.shouldTrade,
    blockers:        fusionResult.blockers,
    winProbability:  bestEV?.winProbability ?? 0.5,
    expectedValue:   bestEV?.expectedValue ?? 0,
  };

  const explainAgent = runTradeExplainabilityAgent(ctx, explainabilityInput);

  // ── Stage 8: Master Decision → CoordinatorOutput ─────────────────────────
  // Build all agent outputs dict (both old-compat keys + new 13-agent keys)
  const allAgentOutputs: Record<string, any> = {
    // New 13-agent keys
    marketScanner:       scannerAgent,
    tickIntelligence:    tickAgent,
    digitProbability:    digitAgent,
    riseFallAgent:       riseFallAgentOut,
    marketRegime:        regimeAgent,
    executionTiming:     timingAgent,
    confidenceFusion:    fusionAgent,
    recoveryIntelligence: recoveryAgent,
    riskIntelligence:    riskAgent,
    portfolioManager:    portfolioAgent,
    learningAgent:       learningAgentOut,
    patternDiscovery:    patternAgent,
    tradeExplainability: explainAgent,

    // Backward-compat keys (for old code paths that expect these keys)
    featureEngineering:  feAgent,
    direction:           riseFallAgentOut,
    digitDistribution:   digitAgent,
    riskManager:         riskAgent,
    performanceFeedback: learningAgentOut,
    evCalculator:        evAgent,
    durationOptimizer: {
      agentId: "durationOptimizer",
      score: durationOpt.confidence,
      confidence: durationOpt.confidence,
      signal: "neutral" as const,
      reasoning: durationOpt.reasoning,
      data: { duration: durationOpt.duration, allScores: durationOpt.allScores },
      executionTimeMs: 0,
    },
  };

  // Build digit stats for the UI
  const digitStats = ctx.digits.length >= 10 ? analyzeDigits(ctx.digits.slice(-100)) : undefined;

  // Pass to master decision — it produces the final CoordinatorOutput shape
  // Map risk-intelligence output to the legacy RiskDecision shape master-decision expects
  const riskDecision = {
    allowTrade:          riskAssessment.allowTrade,
    recommendedStake:    riskAssessment.recommendedStake,
    riskBudget:          1 - currentDrawdown,
    currentDrawdown,
    hardStop:            !riskAssessment.allowTrade,
    hardStopReason:      riskAssessment.blockers[0],
    riskLevel:           riskAssessment.riskLevel,
    stakeMultiplier:     1.0,
  };

  const { output } = makeFinalDecision({
    ctx,
    agents: allAgentOutputs,
    bestEV,
    riskDecision: riskDecision as any,
    timingResult,
    strategyStats,
    regimeOutput: regimeAgent.regimeOutput,
    probUp: dirResult.probUp,
    vol20: features.price.vol20,
    digitStats,
    optimizedDuration,
  });

  // Override shouldTrade with 13-agent consensus (stronger signal)
  const fusionShouldTrade = fusionResult.shouldTrade;
  output.shouldTrade = fusionShouldTrade;
  output.agents = allAgentOutputs;

  if (!fusionShouldTrade && fusionResult.blockers.length > 0) {
    output.rejectReason = fusionResult.blockers[0];
    output.reasoning = explainAgent.explanation.rationale;
  }

  // Record a pattern snapshot for future learning (win/loss unknown at this point — will be shadow)
  recordSnapshot({
    symbol: ctx.symbol,
    contractType: effectiveContractType,
    barrier: effectiveBarrier,
    hurst: features.price.hurst,
    volatility: features.price.vol20,
    momentum: features.price.momentum5,
    entropy: features.price.returnEntropy,
    won: false, // placeholder; ai.ts calls recordTradeOutcome after settlement
    timestamp: Date.now(),
  });

  logger.debug({
    symbol: ctx.symbol,
    shouldTrade: output.shouldTrade,
    quality: output.qualityScore,
    fusion: fusionResult.overallConfidence,
    ev: bestEV?.expectedValue,
    regime,
    duration: optimizedDuration,
    ms: Date.now() - t0,
  }, "13-agent coordinator scan complete");

  return output;
}

// ── Backward-compatible legacy analysis builder ───────────────────────────────

export function buildLegacyAnalysis(output: CoordinatorOutput): LegacyAnalysis {
  const rec = output.recommendation;
  const agents = output.agents;

  // Map 13 agents to the 8 legacy display score slots
  // Weights add up to 1.0
  const agentScores = {
    marketScanner:        toAgentScore(agents["marketScanner"]       ?? agents["featureEngineering"], 0.08),
    tickIntelligence:     toAgentScore(agents["tickIntelligence"]    ?? agents["direction"],           0.08),
    digitProbability:     toAgentScore(agents["digitProbability"]    ?? agents["digitDistribution"],  0.10),
    riseFallModel:        toAgentScore(agents["riseFallAgent"]       ?? agents["direction"],           0.12),
    marketRegime:         toAgentScore(agents["marketRegime"],                                         0.10),
    riskIntelligence:     toAgentScore(agents["riskIntelligence"]    ?? agents["riskManager"],        0.12),
    executionTiming:      toAgentScore(agents["executionTiming"],                                      0.08),
    confidenceFusion:     toAgentScore(agents["confidenceFusion"]    ?? agents["performanceFeedback"], 0.10),
    recoveryIntelligence: toAgentScore(agents["recoveryIntelligence"],                                0.06),
    portfolioManager:     toAgentScore(agents["portfolioManager"],                                    0.06),
    learningAgent:        toAgentScore(agents["learningAgent"]       ?? agents["performanceFeedback"], 0.06),
    patternDiscovery:     toAgentScore(agents["patternDiscovery"],                                    0.04),
    tradeExplainability:  toAgentScore(agents["tradeExplainability"],                                 0.00),
  };

  const isDigit = rec.product.startsWith("DIGIT");

  return {
    symbol: output.symbol,
    qualityScore: output.qualityScore,
    confidenceScore: output.confidenceScore,
    riskScore: output.riskScore,
    trend: output.trend,
    volatility: output.volatility,
    recommendedContractType: rec.product,
    direction: output.direction,
    recommendedStake: rec.stake,
    profitability: Math.round((output.qualityScore * 0.6 + output.confidenceScore * 0.4) * 0.95),
    agentScores,
    shouldTrade: output.shouldTrade,
    reasoning: output.reasoning,
    warnings: output.warnings,
    suggestedContractTypes: buildContractOptions(output),
    digitStats: output.digitStats,
    digitBarrier: rec.barrier,
    digitConfidence: isDigit ? rec.winProbability : undefined,
    recommendedDuration: rec.duration,
    winProbability: rec.winProbability,
    mlModels: undefined,
    calibratedConfidence: rec.winProbability,
    expectedValue: rec.expectedValue,
    breakevenWinRate: rec.breakevenWinRate,
    payoutMultiplier: rec.payoutMultiplier,
    agentOutputs: output.agents,
    regime: output.regime,
  };
}

function toAgentScore(agent: any, weight: number) {
  if (!agent) return { score: 50, weight, signal: "neutral" as const, reasoning: "N/A" };
  return { score: agent.score ?? 50, weight, signal: agent.signal ?? "neutral", reasoning: agent.reasoning ?? "" };
}

function buildContractOptions(output: CoordinatorOutput) {
  const opts: any[] = [];
  const rec = output.recommendation;
  const evData = output.agents["evCalculator"]?.data as any;
  const allEV = (evData?.allEVResults ?? []) as any[];

  for (const ev of allEV.slice(0, 4)) {
    opts.push({
      contractType: ev.product,
      label: `${ev.product}${ev.barrier !== undefined ? ` ${ev.barrier}` : ""}`,
      description: `EV=${(ev.expectedValue * 100).toFixed(1)}%, P(win)=${(ev.winProbability * 100).toFixed(0)}%`,
      suitable: ev.isPositiveEV,
      confidence: Math.round(ev.winProbability * 100),
      recommendedStake: rec.stake,
      riskLevel: ev.winProbability > 0.65 ? "low" : ev.winProbability > 0.55 ? "medium" : "high",
    });
  }
  return opts;
}

export interface LegacyAnalysis {
  symbol: string;
  qualityScore: number;
  confidenceScore: number;
  riskScore: number;
  trend: CoordinatorOutput["trend"];
  volatility: CoordinatorOutput["volatility"];
  recommendedContractType: string;
  direction: "up" | "down";
  recommendedStake: number;
  profitability: number;
  agentScores: Record<string, { score: number; weight: number; signal: string; reasoning: string }>;
  shouldTrade: boolean;
  reasoning: string;
  warnings: string[];
  suggestedContractTypes: any[];
  digitStats?: any;
  digitBarrier?: number;
  digitConfidence?: number;
  recommendedDuration: number;
  winProbability: number;
  mlModels?: any;
  calibratedConfidence: number;
  expectedValue: number;
  breakevenWinRate: number;
  payoutMultiplier: number;
  agentOutputs: Record<string, any>;
  regime: string;
  tickWindow?: number;
}
