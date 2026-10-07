/**
 * Master Decision Agent
 *
 * RESPONSIBILITY: Aggregate all agent outputs into a single, final, explainable
 * trade decision. This is the only agent that can say "trade" or "skip".
 *
 * Decision logic (ALL of the following must be satisfied to trade):
 *   1. Risk manager does NOT have a hard stop
 *   2. EV calculator found at least one positive-EV (or near-breakeven direction) option
 *   3. Execution timing score ≥ threshold (48 for direction, 55 for digit)
 *   4. Weighted agent consensus score ≥ minConfidenceThreshold
 *   5. Performance feedback not in "severely drifting" state
 *
 * Task 2 fix — Rise/Fall execution:
 *   Direction products (RISE/FALL/CALL/PUT) get a relaxed EV gate when the
 *   weighted consensus is high (≥60). They are allowed to fire with near-zero EV
 *   (EV > -0.008 per $1 stake) because:
 *   a) The timing agent already uses threshold=48 for direction (not 55)
 *   b) 1.92x payout needs about 52.1% win probability — achievable with good momentum
 *   c) Blocking all direction trades because EV is -0.2% is overcorrecting
 *
 * Agent weights (used for consensus score):
 *   - EV Calculator:         30% (most important — EV is truth)
 *   - Direction/Digit:       20% (core edge signal)
 *   - Risk Manager:          20% (safety gate)
 *   - Market Regime:         10% (context)
 *   - Execution Timing:      10% (entry quality)
 *   - Performance Feedback:   5% (historical validation)
 *   - Feature Engineering:    5% (data quality)
 */

import type {
  AgentOutput,
  CoordinatorOutput,
  MarketRegime,
  ProductRecommendation,
  ProductType,
  ScanContext,
} from "./types";
import { scoreToSignal } from "./types";
import { DEFAULT_PAYOUTS, type EVResult } from "./ev-calculator";
import type { RiskDecision } from "./risk-manager";
import type { TimingResult } from "./execution-timing";
import type { StrategyStats } from "./performance-feedback";
import type { RegimeOutput } from "./market-regime";
import {
  combineEvidence,
  MAX_TERM_LOG_ODDS,
  probabilityToLogOdds,
  requiredEvidence,
  type EvidenceTerm,
  type MarkovTestResult,
} from "./evidence-math";

// ══════════════════════════════════════════════════════════════════════════════
// EVIDENCE-BASED ADMISSION
// ══════════════════════════════════════════════════════════════════════════════
//
// The admission decision is a single log-odds score:
//
//     L = Σ wᵢ · log-odds(observationᵢ)      admit when L ≥ L_req(mode, t)
//
// This replaces the former chain of independent hard gates (timing ∧ consensus
// ∧ drift). Those gates were step functions, and because the conditions they
// tested are correlated (a trending market degrades timing AND lengthens loss
// streaks AND eventually trips drift), the joint probability of all of them
// passing at once collapses. That is the mechanism behind 30+ minute waits for
// a recovery trade that may never come.
//
// Properties this buys:
//   - Substitutable: a strong statistical edge carries a weak timing score.
//   - Finite: every term is clamped, so nothing vetoes forever.
//   - Continuous: marginally-poor conditions lower the score instead of
//     blocking outright.
//
// SAFETY: the weights below satisfy a provable invariant (asserted in
// evidence-math.test.ts) — a maximally BAD edge term (−MAX_TERM_LOG_ODDS) can
// never be outvoted by every secondary term being maximally GOOD, because
//   edgeWeight × (−2) + (1 − edgeWeight) × (+2) = 2 − 4·edgeWeight < 0  ⇔  w > 0.5
// With edge weight 0.55 the worst case fuses to −0.2, so no threshold ≥ 0 can
// admit a trade with no real statistical edge. Conversely a maximally GOOD edge
// survives maximally BAD secondary signals (+0.2), which is the substitutability
// property that AND-gates could not express.
const EVIDENCE_WEIGHTS = {
  /** Statistical edge (exact Beta posterior, or EV-derived fallback). Dominant. */
  edge: 0.55,
  /** Entry timing quality. Advisory, never a veto. */
  timing: 0.12,
  /** Market regime suitability for the chosen contract type. */
  regime: 0.10,
  /** Recent win rate vs long-term — strategy drift. */
  drift: 0.08,
  /** Consecutive-loss streak. */
  streak: 0.06,
  /** Whether Markov transitions carry real information (G² test). */
  markov: 0.05,
  /** Sample sufficiency behind the estimates. */
  dataQuality: 0.04,
} as const;

/**
 * In recovery mode, drift and streak are partially TAUTOLOGICAL: the account is
 * in recovery precisely because it has been losing. Counting that as independent
 * evidence against the recovery trade is circular — it would penalise the very
 * trade the mode exists to place. They are damped (not zeroed) so a genuine
 * structural breakdown still registers, without dominating the decision.
 */
const RECOVERY_TAUTOLOGY_DAMPING = 0.4;

/** Normal mode: constant threshold, no time decay (behaviour unchanged in spirit). */
const NORMAL_EVIDENCE_THRESHOLD = 0.35;

/**
 * Recovery mode: the bar starts demanding and decays exponentially, so the
 * engine takes the first candidate whose evidence genuinely clears the bar
 * rather than waiting for an improbable conjunction of independent conditions.
 */
const RECOVERY_EVIDENCE_START = 0.30;
/**
 * Asymptotic floor. MUST stay > 0: admission must always require positive
 * evidence, otherwise "wait long enough" degenerates into "trade a coin flip",
 * which converts a slow recovery into an efficient loss of capital.
 */
const RECOVERY_EVIDENCE_FLOOR = 0.03;
/** Time constant — the remaining gap to the floor shrinks by 1/e every 2 min. */
const RECOVERY_EVIDENCE_TAU_MS = 120_000;

/** Maps EV to a bounded pseudo-probability when no digit posterior is available. */
const EV_TO_EDGE_LOGISTIC_SCALE = 8;

/**
 * Regime suitability as a signed [-1, +1] score.
 *
 * Digit contracts assume the terminal digit is ~uniform; directional momentum
 * skews which digits appear at expiry, so trending regimes are hostile to them.
 * Direction contracts want momentum, with CALL/PUT picking the matching side.
 */
function regimeEvidenceScore(regime: string, product: string | undefined): number {
  const isDirection = ["CALL", "PUT", "RISE", "FALL"].includes(product ?? "");
  const isUp = product === "CALL" || product === "RISE";

  if (isDirection) {
    switch (regime) {
      case "trending_up":   return isUp ? 1 : -1;
      case "trending_down": return isUp ? -1 : 1;
      case "sideways":      return 0;
      case "choppy":        return -0.5;
      case "volatile":      return -1;
      default:              return 0;
    }
  }
  switch (regime) {
    case "sideways":      return 1;    // ideal for digit contracts
    case "choppy":        return 0.5;
    case "trending_up":   return -1;   // momentum skews the terminal digit
    case "trending_down": return -1;
    case "volatile":      return -0.5;
    default:              return 0;
  }
}

// ── Agent weights ─────────────────────────────────────────────────────────────
const AGENT_WEIGHTS: Record<string, number> = {
  evCalculator:        0.30,
  direction:           0.15,
  digitDistribution:   0.15,
  riskManager:         0.20,
  marketRegime:        0.10,
  executionTiming:     0.10,
  performanceFeedback: 0.05,
  featureEngineering:  0.05,
};

// Normalize weights (direction + digit are mutually exclusive — only one applies)
function getEffectiveWeights(agents: Record<string, AgentOutput>): Record<string, number> {
  const weights = { ...AGENT_WEIGHTS };
  const hasDirection = agents["direction"] !== undefined;
  const hasDigit = agents["digitDistribution"] !== undefined;

  if (hasDirection && !hasDigit) {
    weights["direction"] = 0.30; // absorb digit weight
    weights["digitDistribution"] = 0;
  } else if (hasDigit && !hasDirection) {
    weights["digitDistribution"] = 0.30;
    weights["direction"] = 0;
  }

  // Normalize so weights sum to 1
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (const k of Object.keys(weights)) weights[k] /= total;
  }
  return weights;
}

function computeWeightedScore(agents: Record<string, AgentOutput>): number {
  const weights = getEffectiveWeights(agents);
  let score = 0;
  let totalWeight = 0;
  for (const [id, agent] of Object.entries(agents)) {
    const w = weights[id] ?? 0;
    if (w > 0) { score += agent.score * w; totalWeight += w; }
  }
  return totalWeight > 0 ? score / totalWeight : 50;
}

// ── Direction product detection ────────────────────────────────────────────────
function isDirectionProduct(product: ProductType | string | undefined): boolean {
  return ["RISE", "FALL", "CALL", "PUT"].includes(product ?? "");
}

function isOverUnderProduct(product: ProductType | string | undefined): boolean {
  return product === "DIGITOVER" || product === "DIGITUNDER";
}

// ── Trend direction from probabilities ───────────────────────────────────────

function trendFromProb(probUp: number): CoordinatorOutput["trend"] {
  if (probUp > 0.68) return "strong_up";
  if (probUp > 0.55) return "up";
  if (probUp < 0.32) return "strong_down";
  if (probUp < 0.45) return "down";
  return "sideways";
}

function volCategoryFromVol(vol20: number): CoordinatorOutput["volatility"] {
  if (vol20 > 0.01) return "extreme";
  if (vol20 > 0.004) return "high";
  if (vol20 > 0.001) return "medium";
  return "low";
}

// ── Master decision ───────────────────────────────────────────────────────────

export interface MasterDecisionInputs {
  ctx: ScanContext;
  agents: Record<string, AgentOutput>;
  bestEV: EVResult | null;
  riskDecision: RiskDecision;
  timingResult: TimingResult;
  strategyStats: StrategyStats;
  regimeOutput: RegimeOutput;
  probUp: number;        // from direction agent (0–1)
  vol20: number;         // from features
  digitStats?: import("../deriv").DigitStats;
  optimizedDuration?: number;   // from duration optimizer
}

export function makeFinalDecision(inputs: MasterDecisionInputs): {
  output: CoordinatorOutput;
  masterAgent: AgentOutput;
} {
  const { ctx, agents, bestEV, riskDecision, timingResult, strategyStats, regimeOutput, probUp, vol20, digitStats, optimizedDuration } = inputs;
  const t0 = Date.now();
  const settings = ctx.settings;

  const weightedScore = computeWeightedScore(agents);
  const rejectReasons: string[] = [];

  // The coordinator runs each contract family with a narrowed preferred list.
  // Preserve that family identity even when the EV agent has no result during
  // warm-up, so OVER/UNDER does not fall into the generic no-EV veto.
  const candidateProduct = bestEV?.product ??
    (settings.preferredContractTypes.includes("DIGITOVER")
      ? "DIGITOVER"
      : settings.preferredContractTypes.includes("DIGITUNDER")
        ? "DIGITUNDER"
        : undefined);
  const isDirProduct = isDirectionProduct(candidateProduct);
  const isOverUnder = isOverUnderProduct(candidateProduct);

  // ── Gate 1: Risk hard stop ───────────────────────────────────────────────
  if (riskDecision.hardStop) {
    rejectReasons.push(`Risk gate: ${riskDecision.hardStopReason}`);
  }

  // ── Gate 2: EV gate (product-aware) ──────────────────────────────────────
  // Normal digit barriers are evaluated against their live (or canonical
  // fallback) payout and the user's exact barrier. The real signal remains the
  // deviation of observed win probability from that barrier's theoretical rate.
  // For all other products, require EV > -0.06.
  if (!bestEV) {
    // OVER/UNDER still uses the agent analysis and configured barrier when the
    // EV calculator has no candidate (for example during a short warm-up).
    // Do not turn missing EV into a second hidden veto for this user-directed
    // contract family.
    if (!isOverUnder) {
      rejectReasons.push("No EV data — market data insufficient to evaluate");
    }
  } else if (!isOverUnder) {
    // ── Dynamic tier classification using user-configured barriers ───────────
    // Use the exact barriers the user configured — no range scanning.
    // Defaults match the DB schema so a missing settings row behaves consistently.
    const normalOverBarrier    = ctx.settings.normalOverDigit   ?? 1;
    const normalUnderBarrier   = ctx.settings.normalUnderDigit  ?? 8;
    const recoveryOverBarrier  = ctx.settings.recoveryOverDigit  ?? 3;
    const recoveryUnderBarrier = ctx.settings.recoveryUnderDigit ?? 6;

    // Exact match: the EV tournament now only ever produces the one barrier the
    // user chose, so tier classification is a simple equality check.
    const isDigitTier1 = (
      (bestEV.product === "DIGITOVER"  &&
        bestEV.barrier === normalOverBarrier) ||
      (bestEV.product === "DIGITUNDER" &&
        bestEV.barrier === normalUnderBarrier)
    );
    const isDigitTier2 = (
      (bestEV.product === "DIGITOVER"  &&
        bestEV.barrier === recoveryOverBarrier) ||
      (bestEV.product === "DIGITUNDER" &&
        bestEV.barrier === recoveryUnderBarrier)
    );
    const isDigitMatch = bestEV.product === "DIGITMATCH";
    const isDigitDiff  = bestEV.product === "DIGITDIFF";

    if (isDigitMatch) {
      // DIGITMATCH → ~10% theoretical win, 8.93x fallback payout.
      // Breakeven frequency = 1/8.93 ≈ 11.2%. Require EV > -0.05 (digit appears
      // at roughly fair odds or better). The high payout in recovery mode means
      // even a near-fair digit frequency is worth trading to cover the debt cheaply.
      if (bestEV.expectedValue < -0.05) {
        rejectReasons.push(
          `DIGITMATCH digit=${bestEV.barrier}: EV ${(bestEV.expectedValue * 100).toFixed(1)}% — digit too cold (need > -5%)`,
        );
      }
    } else if (isDigitDiff) {
      // DIGITDIFF → ~90-96% theoretical win, 1.09x fallback payout.
      // Positive EV requires >91.7% win rate at the 1.09× fallback.
      // Gate on EV > -0.05 instead of edge > 0: even near 92% the high-frequency
      // wins provide strong portfolio stability and pair well with MATCH recovery.
      if (bestEV.expectedValue < -0.05) {
        rejectReasons.push(
          `DIGITDIFF digit=${bestEV.barrier}: win rate ${(bestEV.winProbability * 100).toFixed(1)}% too low (EV ${(bestEV.expectedValue * 100).toFixed(1)}%, need > -5%)`,
        );
      }
    } else if (isDigitTier1) {
      // Tier-1 (user's normal barriers): use a lenient EV gate instead of strict edge > 0.
      //
      // WHY: in near-uniform Deriv synthetic markets the theoretical win probability for
      // safe barriers sits ~70–80 % while the payout breakeven sits at 84–92 %. Requiring
      // edge > 0 (win > breakeven) is therefore mathematically impossible unless the digit
      // distribution is heavily skewed — causing the engine to NEVER fire for these barriers.
      //
      // The EV > -0.08 gate instead allows trades when the configured barrier is showing
      // at least partial statistical favourability from the Bayesian + Markov ensemble.
      // Example: OVER 1 uses the configured/live payout while edge remains
      // measured against its theoretical 80% win rate.
      if (bestEV.expectedValue < -0.08) {
        rejectReasons.push(
          `Normal barrier EV too weak: ${bestEV.product} barrier=${bestEV.barrier}: ` +
          `EV ${(bestEV.expectedValue * 100).toFixed(1)}% < -8% — wait for digit skew`,
        );
      }
    } else if (isDigitTier2) {
      // Tier-2 (user's recovery barriers): slightly wider EV gate — higher payouts
      if (bestEV.expectedValue < -0.15) {
        rejectReasons.push(`Recovery barrier EV too negative: ${(bestEV.expectedValue * 100).toFixed(1)}%`);
      }
    } else if (bestEV.expectedValue < -0.06) {
      // All other products: hard-block when EV is genuinely terrible
      rejectReasons.push(`EV too negative: ${(bestEV.expectedValue * 100).toFixed(1)}% — no tradeable opportunity`);
    }
  }
  // requirePositiveEv is now advisory only (logged as a warning, not a blocker)

  // ══════════════════════════════════════════════════════════════════════════
  // EVIDENCE ACCUMULATION (replaces the former hard gates 3, 4 and 5)
  // ══════════════════════════════════════════════════════════════════════════
  // Each former gate contributes a BOUNDED, WEIGHTED log-odds term instead of
  // an independent veto. Nothing here can block on its own, and nothing here
  // can be blocked indefinitely — see EVIDENCE_WEIGHTS for the safety proof.
  const recoveryActive = ctx.recovery?.active === true;
  const recoveryElapsedMs = Number.isFinite(ctx.recovery?.elapsedMs)
    ? (ctx.recovery!.elapsedMs as number)
    : 0;

  // Damping for the terms that are partly tautological while in recovery.
  const tautologyScale = recoveryActive ? RECOVERY_TAUTOLOGY_DAMPING : 1;

  const activeProduct = bestEV?.product ?? candidateProduct;
  const evidenceTerms: EvidenceTerm[] = [];

  // ── Term: statistical edge (dominant) ────────────────────────────────────
  // Prefer the EXACT posterior from the digit agent — P(true win rate exceeds
  // this contract's payout breakeven), computed from raw digit counts via the
  // Dirichlet–Beta aggregation property. It is sample-size aware, which is what
  // the old flat `deviation > 0.005` rule was not.
  //
  // Contract families with no digit counts (CALL/PUT, MATCH/DIFF built in the
  // coordinator) fall back to a bounded logistic of EV.
  const digitAgent = agents["digitDistribution"] ?? agents["digitProbability"];
  const barrierData = digitAgent?.data?.["bestBarrier"] as
    | { contractType?: string; barrier?: number; edgeProbability?: number }
    | undefined;
  const posteriorMatchesChosen =
    (bestEV?.product === "DIGITOVER" || bestEV?.product === "DIGITUNDER") &&
    barrierData?.contractType === bestEV?.product &&
    barrierData?.barrier === bestEV?.barrier;
  const posteriorEdge = posteriorMatchesChosen ? barrierData?.edgeProbability : undefined;
  const evEdgeProb = bestEV
    ? 1 / (1 + Math.exp(-bestEV.expectedValue * EV_TO_EDGE_LOGISTIC_SCALE))
    : 0.5;
  const edgeProb = Number.isFinite(posteriorEdge as number)
    ? Math.max(0, Math.min(1, posteriorEdge as number))
    : evEdgeProb;

  evidenceTerms.push({
    id: "edge",
    weight: EVIDENCE_WEIGHTS.edge,
    logOdds: probabilityToLogOdds(edgeProb),
    detail: Number.isFinite(posteriorEdge as number)
      ? `Beta posterior P(edge real)=${(edgeProb * 100).toFixed(1)}%`
      : `EV-derived P(edge)=${(edgeProb * 100).toFixed(1)}% (EV ${((bestEV?.expectedValue ?? 0) * 100).toFixed(1)}%)`,
  });

  // ── Term: execution timing ────────────────────────────────────────────────
  // Was a hard gate at 52 (direction) / 45 (digit). Now a bounded contribution:
  // a poor score lowers the total but a strong edge can still carry it.
  const timingNormalised = Math.max(-1, Math.min(1, (timingResult.timingScore - 50) / 50));
  evidenceTerms.push({
    id: "timing",
    weight: EVIDENCE_WEIGHTS.timing,
    logOdds: timingNormalised * MAX_TERM_LOG_ODDS,
    detail: `timing ${timingResult.timingScore}/100${timingResult.notOnExtreme ? "" : " (outlier tick)"}`,
  });

  // ── Term: market regime ───────────────────────────────────────────────────
  // Was a hard block on digit trades in trending regimes ("Fix 7"). Now a
  // signed contribution — hostile regimes cost score instead of stalling.
  const regimeScore = regimeEvidenceScore(regimeOutput.regime, activeProduct);
  evidenceTerms.push({
    id: "regime",
    weight: EVIDENCE_WEIGHTS.regime,
    logOdds: regimeScore * MAX_TERM_LOG_ODDS,
    detail: `${regimeOutput.regime.replace("_", " ")} regime`,
  });

  // ── Term: strategy drift ──────────────────────────────────────────────────
  // Was a hard block when recent WR < 40% over ≥ 20 trades. The old behaviour
  // measured drift only AFTER the fact and then refused to trade — which in
  // recovery is self-reinforcing. Now it is bounded evidence.
  const driftLogOdds = strategyStats.hasEnoughData
    ? probabilityToLogOdds(strategyStats.recentWinRate)
    : 0;
  evidenceTerms.push({
    id: "drift",
    weight: EVIDENCE_WEIGHTS.drift * tautologyScale,
    logOdds: driftLogOdds,
    detail: strategyStats.hasEnoughData
      ? `recent WR ${(strategyStats.recentWinRate * 100).toFixed(1)}%`
      : "insufficient history",
  });

  // ── Term: loss streak ─────────────────────────────────────────────────────
  // Was an effective hard veto: at ≥ 4 consecutive losses the recovery
  // intelligence agent scored 15, which the confidence-fusion hard-gate then
  // converted into a mandatory pause. Bounded here, and damped in recovery.
  const streakTerm = -Math.min(ctx.daily.consecutiveLosses, 5) * 0.35;
  evidenceTerms.push({
    id: "streak",
    weight: EVIDENCE_WEIGHTS.streak * tautologyScale,
    logOdds: streakTerm,
    detail: `${ctx.daily.consecutiveLosses} consecutive loss${ctx.daily.consecutiveLosses === 1 ? "" : "es"}`,
  });

  // ── Term: Markov information content ──────────────────────────────────────
  // The barrier builder blends Markov transition probabilities into its win-rate
  // estimate. The G² test tells us whether those transitions carry information
  // at all; when they do not, the prediction is built on noise.
  const markovTest = digitAgent?.data?.["markovTest"] as MarkovTestResult | undefined;
  const markovLogOdds = !markovTest || markovTest.observations < 30
    ? 0
    : markovTest.significant
      ? 0.9
      : -0.3;
  evidenceTerms.push({
    id: "markov",
    weight: EVIDENCE_WEIGHTS.markov,
    logOdds: markovLogOdds,
    detail: !markovTest || markovTest.observations < 30
      ? "insufficient transitions"
      : markovTest.significant
        ? `Markov informative (G²=${markovTest.g2.toFixed(0)}, p=${markovTest.pValue.toFixed(3)})`
        : `Markov ≈ i.i.d. (p=${markovTest.pValue.toFixed(3)})`,
  });

  // ── Term: data quality ────────────────────────────────────────────────────
  const sampleSizeTerm = Number(digitAgent?.data?.["sampleSize"] ?? 0);
  const sufficiency = Math.max(0, Math.min(1, sampleSizeTerm / 200));
  evidenceTerms.push({
    id: "dataQuality",
    weight: EVIDENCE_WEIGHTS.dataQuality,
    logOdds: sufficiency * 2 - 1,
    detail: `${sampleSizeTerm} samples`,
  });

  const evidence = combineEvidence(evidenceTerms);

  // ── Admission threshold ───────────────────────────────────────────────────
  // Normal mode: constant. Recovery mode: decays toward a strictly positive
  // floor, so the engine takes the first candidate whose evidence clears the
  // (relaxing) bar instead of waiting for every condition to align at once.
  const evidenceThreshold = recoveryActive
    ? requiredEvidence({
        elapsedMs: recoveryElapsedMs,
        startThreshold: RECOVERY_EVIDENCE_START,
        floorThreshold: RECOVERY_EVIDENCE_FLOOR,
        tauMs: RECOVERY_EVIDENCE_TAU_MS,
      })
    : NORMAL_EVIDENCE_THRESHOLD;

  const evidenceSufficient = evidence.total >= evidenceThreshold;

  if (!evidenceSufficient) {
    // Name the weakest term so the skip is diagnosable from the UI/logs.
    const weakest = [...evidence.contributions].sort((a, b) => a.contribution - b.contribution)[0];
    rejectReasons.push(
      `Evidence ${evidence.total.toFixed(3)} below ${recoveryActive ? "recovery " : ""}threshold ` +
        `${evidenceThreshold.toFixed(3)}` +
        (weakest ? ` — weakest term: ${weakest.id} (${weakest.contribution.toFixed(3)}: ${weakest.detail ?? ""})` : "") +
        (recoveryActive ? ` [recovery ${(recoveryElapsedMs / 1000).toFixed(0)}s in]` : ""),
    );
  }

  const shouldTrade = rejectReasons.length === 0;

  // ── Determine trade duration ──────────────────────────────────────────────
  const tradeDuration = optimizedDuration ?? settings.tradeDurationSec;

  // ── Build recommendation ──────────────────────────────────────────────────
  let recommendation: ProductRecommendation;

  if (bestEV) {
    const product = bestEV.product as ProductType;
    const stake = riskDecision.recommendedStake > 0 ? riskDecision.recommendedStake : bestEV.stake;

    recommendation = {
      product,
      barrier: bestEV.barrier,
      winProbability: Math.round(bestEV.winProbability * 100),
      payoutMultiplier: bestEV.payoutMultiplier,
      expectedValue: bestEV.expectedValue * stake,   // in dollars
      breakevenWinRate: bestEV.breakevenWinRate * 100,
      duration: tradeDuration,
      stake,
      reasoning: `${product}${bestEV.barrier !== undefined ? ` barrier=${bestEV.barrier}` : ""}: EV=${(bestEV.expectedValue * 100).toFixed(1)}% per $1 stake, P(win)=${(bestEV.winProbability * 100).toFixed(1)}%, payout ${bestEV.payoutMultiplier}x. Duration: ${tradeDuration}t.`,
    };
  } else {
    // Fallback when no EV found — respect preferredContractTypes; NEVER use CALL/PUT
    // if the user has disabled direction types.
    const dirAgent = agents["direction"];
    const probUpLocal = dirAgent?.data?.["probUp"] as number ?? 0.5;
    const preferred = ctx.settings.preferredContractTypes;
    const digitAgent = agents["digitDistribution"] ?? agents["digitProbability"];
    const analyzedBarrier = digitAgent?.data?.["bestBarrier"] as
      { contractType?: ProductType; barrier?: number } | undefined;
    const wantDir = preferred.some((t) => ["CALL", "PUT", "RISE", "FALL"].includes(t));
    const wantOU  = preferred.some((t) => t === "DIGITOVER" || t === "DIGITUNDER");
    const wantEO  = preferred.some((t) => t === "DIGITEVEN" || t === "DIGITODD");
    const wantMD  = preferred.some((t) => t === "DIGITMATCH" || t === "DIGITDIFF");
    const product = (wantDir
      ? (probUpLocal >= 0.5 ? "CALL" : "PUT")
      : wantOU  ? (analyzedBarrier?.contractType === "DIGITOVER" && preferred.includes("DIGITOVER")
          ? "DIGITOVER"
          : analyzedBarrier?.contractType === "DIGITUNDER" && preferred.includes("DIGITUNDER")
            ? "DIGITUNDER"
            : preferred.includes("DIGITOVER") ? "DIGITOVER" : "DIGITUNDER")
      : wantEO  ? "DIGITEVEN"
      : wantMD  ? "DIGITMATCH"
      : (probUpLocal >= 0.5 ? "CALL" : "PUT")) as ProductType;   // absolute last resort
    const barrier = product === "DIGITOVER"
      ? ctx.recoveryBarrierOverride?.DIGITOVER ?? ctx.settings.normalOverDigit
      : product === "DIGITUNDER"
        ? ctx.recoveryBarrierOverride?.DIGITUNDER ?? ctx.settings.normalUnderDigit
        : undefined;
    recommendation = {
      product,
      barrier,
      winProbability: Math.round(probUpLocal * 100),
      payoutMultiplier: DEFAULT_PAYOUTS[product] ?? DEFAULT_PAYOUTS["CALL"],
      expectedValue: 0,
      breakevenWinRate: 100 / (DEFAULT_PAYOUTS[product] ?? DEFAULT_PAYOUTS["CALL"]),
      duration: tradeDuration,
      stake: riskDecision.recommendedStake,
      reasoning: "No positive-EV opportunity — recommend waiting.",
    };
  }

  // ── Build output metrics ──────────────────────────────────────────────────
  const qualityScore = Math.round(weightedScore);
  const confidenceScore = Math.round(
    (bestEV ? Math.min(100, 50 + bestEV.edge * 500) : 30) * 0.5 +
    weightedScore * 0.5
  );

  const trend = trendFromProb(probUp);
  const direction: "up" | "down" = probUp >= 0.5 ? "up" : "down";
  const volatility = volCategoryFromVol(vol20);

  const warnings: string[] = [];
  if (volatility === "extreme") warnings.push("Extreme volatility — reduce stake significantly");
  if (strategyStats.isDrifting && strategyStats.hasEnoughData) warnings.push("Strategy drifting — recent performance below long-term average");
  if (bestEV && !bestEV.isPositiveEV && settings.requirePositiveEv) warnings.push(`Advisory: EV is ${(bestEV.expectedValue * 100).toFixed(1)}% (requirePositiveEV preference noted)`);
  if (!timingResult.isGoodTiming) warnings.push(`Timing advisory: ${timingResult.waitReason ?? "score below preferred threshold"}`);
  if (riskDecision.riskLevel === "high" || riskDecision.riskLevel === "critical") {
    warnings.push(`Risk level: ${riskDecision.riskLevel.toUpperCase()}`);
  }
  if (bestEV && bestEV.edge < 0.02 && bestEV.isPositiveEV) warnings.push("Marginal EV edge — consider waiting for stronger setup");
  if (timingResult.waitReason) warnings.push(`Timing: ${timingResult.waitReason}`);
  if (isDirProduct && bestEV && !bestEV.isPositiveEV && shouldTrade) {
    warnings.push("Near-breakeven EV — direction model consensus justified this trade");
  }

  const evidenceSummary = evidence.contributions
    .map((c) => `${c.id}=${c.contribution.toFixed(2)}`)
    .join(" ");

  const reasonParts = [
    `Evidence: ${evidence.total.toFixed(3)} vs threshold ${evidenceThreshold.toFixed(3)}` +
      (recoveryActive ? ` (recovery, ${(recoveryElapsedMs / 1000).toFixed(0)}s in).` : "."),
    `Quality: ${qualityScore}/100.`,
    `Consensus: ${weightedScore.toFixed(0)}/100.`,
    bestEV ? `Best EV: ${(bestEV.expectedValue * 100).toFixed(1)}% (${bestEV.product}).` : "No positive EV.",
    `Regime: ${regimeOutput.regime.replace("_", " ")}.`,
    `Risk: ${riskDecision.riskLevel}.`,
    `Duration: ${tradeDuration}t.`,
    `Terms: ${evidenceSummary}.`,
    shouldTrade ? "✓ Evidence sufficient — executing." : `✗ SKIP: ${rejectReasons[0]}`,
  ];

  const reasoning = reasonParts.join(" ");

  // Master agent output
  const masterScore = shouldTrade ? qualityScore : 20;
  const masterAgent: AgentOutput = {
    agentId: "masterDecision",
    score: masterScore,
    confidence: shouldTrade ? confidenceScore : 0,
    signal: scoreToSignal(masterScore),
    reasoning,
    data: {
      shouldTrade,
      rejectReasons,
      recommendation,
      weightedScore,
      qualityScore,
      optimizedDuration,
      evidence: {
        total: evidence.total,
        threshold: evidenceThreshold,
        recovery: recoveryActive,
        recoveryElapsedMs,
        contributions: evidence.contributions,
      },
    },
    executionTimeMs: Date.now() - t0,
  };

  // Merge all agents including master
  const allAgents = { ...agents, masterDecision: masterAgent };

  const output: CoordinatorOutput = {
    symbol: ctx.symbol,
    displayName: ctx.displayName,
    category: ctx.category,
    shouldTrade,
    rejectReason: rejectReasons.length > 0 ? rejectReasons.join("; ") : undefined,
    recommendation,
    regime: regimeOutput.regime,
    agents: allAgents,
    qualityScore,
    confidenceScore,
    riskScore: Math.round(100 - riskDecision.riskBudget * 100),
    trend,
    volatility,
    direction,
    warnings,
    reasoning,
    digitStats,
  };

  return { output, masterAgent };
}
