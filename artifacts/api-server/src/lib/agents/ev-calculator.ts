/**
 * Expected Value Calculator Agent
 *
 * RESPONSIBILITY: Compute the true expected value for each potential trade,
 * using calibrated win probabilities and actual (not estimated) payout multipliers.
 *
 * EV = P(win) × net_payout - P(lose) × stake
 *    = P(win) × (payout_multiplier - 1) - (1 - P(win))
 *    per $1 stake
 *
 * Breakeven win rate = 1 / payout_multiplier
 *
 * RISE/FALL uses the canonical 1.92× fallback when a live proposal is unavailable.
 * This is a total-return multiplier, so its net profit rate is 0.92 per $1 stake.
 *
 * Task 2 fix: Direction trades need achievable thresholds.
 * With 1.92x payout, about 52.1% win probability is needed — achievable by the
 * direction model when market regime and momentum strongly agree.
 */

import type { AgentOutput, ProductType, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import type { DirectionResult } from "./direction-agent";
import type { BarrierOption } from "./digit-probability";
import { DIGIT_TIERS } from "./digit-probability";
import { DEFAULT_CONTRACT_PAYOUTS } from "../payouts";

// ── Default payout table ──────────────────────────────────────────────────────
// Live proposals take precedence. These canonical total-return multipliers are
// used only when pricing is unavailable (the original stake is included).
export const DEFAULT_PAYOUTS: Record<string, number> = { ...DEFAULT_CONTRACT_PAYOUTS };

// Minimum EV threshold for "near-breakeven" classification.
// Widened to -0.05 so direction trades at ~50% win rate are still returned as
// candidates (EV ≈ -4.5%) rather than null. The master-decision gate then decides
// whether to execute; returning null here permanently kills the engine.
export const MIN_POSITIVE_EV = -0.05; // -5% lower bound for near-breakeven

// ── EV calculation ────────────────────────────────────────────────────────────

export interface EVResult {
  product: ProductType;
  barrier?: number;
  winProbability: number;
  payoutMultiplier: number;
  expectedValue: number;      // per $1 stake
  breakevenWinRate: number;
  edge: number;               // winProbability - breakevenWinRate
  isPositiveEV: boolean;
  isNearBreakeven: boolean;   // EV within ±1% — marginal opportunity
  stake: number;
  dollarEV: number;
  kellyFraction: number;
}

export function computeEV(
  winProbability: number,
  payoutMultiplier: number,
): EVResult["expectedValue"] {
  return winProbability * (payoutMultiplier - 1) - (1 - winProbability);
}

export function kellyFraction(winProbability: number, payoutMultiplier: number): number {
  const b = payoutMultiplier - 1;
  const p = winProbability;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  return Math.max(0, Math.min(0.25, kelly * 0.5));
}

export function buildEVResult(
  product: ProductType,
  winProbability: number,
  payoutMultiplier: number,
  stake: number,
  barrier?: number,
): EVResult {
  const ev = computeEV(winProbability, payoutMultiplier);
  const breakeven = 1 / payoutMultiplier;
  return {
    product,
    barrier,
    winProbability,
    payoutMultiplier,
    expectedValue: ev,
    breakevenWinRate: breakeven,
    edge: winProbability - breakeven,
    isPositiveEV: ev > 0,
    isNearBreakeven: ev >= MIN_POSITIVE_EV && ev <= 0.015,
    stake,
    dollarEV: ev * stake,
    kellyFraction: kellyFraction(winProbability, payoutMultiplier),
  };
}

// ── Direction products ────────────────────────────────────────────────────────

function evForDirectionProducts(
  dirResult: DirectionResult,
  payouts: { rise: number; fall: number },
  stake: number,
  preferredTypes: string[],
): EVResult[] {
  const results: EVResult[] = [];
  const probUp = dirResult.probUp;
  const probDown = dirResult.probDown;

  // Accept both CALL/PUT (canonical) and RISE/FALL (legacy alias)
  if (preferredTypes.some((t) => ["RISE", "FALL", "CALL", "PUT"].includes(t))) {
    results.push(buildEVResult("CALL", probUp, payouts.rise, stake));
    results.push(buildEVResult("PUT", probDown, payouts.fall, stake));
  }

  return results;
}

// ── Digit products ────────────────────────────────────────────────────────────

function evForDigitProducts(
  barrierOptions: BarrierOption[],
  stake: number,
): EVResult[] {
  // Sort by adjustedEvScore (tier preference already applied by the digit agent —
  // preferred-tier barriers with positive edge get score × 10, so they rank first).
  // This preserves OVER 2 / UNDER 7 as the top option when the market is skewed,
  // even though their raw EV is negative (low payout by Deriv design).
  return barrierOptions
    .sort((a, b) => b.adjustedEvScore - a.adjustedEvScore)
    .map((opt) => ({
      product: opt.contractType,
      barrier: opt.barrier,
      winProbability: opt.winProbability,
      payoutMultiplier: opt.payout,
      expectedValue: opt.expectedValue,
      breakevenWinRate: 1 / opt.payout,
      edge: opt.edge,
      isPositiveEV: opt.expectedValue > 0,
      isNearBreakeven: opt.expectedValue >= MIN_POSITIVE_EV && opt.expectedValue <= 0.015,
      stake,
      dollarEV: opt.expectedValue * stake,
      kellyFraction: kellyFraction(opt.winProbability, opt.payout),
    }));
}

// ── Even / Odd products ───────────────────────────────────────────────────────
// evenProb = fraction of recent digits that were even (0,2,4,6,8).
// Both products always use payout ~1.95x (50/50 contract on Deriv).

function evForEvenOddProducts(
  evenProb: number,
  stake: number,
  livePayouts: Record<string, number> | null,
): EVResult[] {
  const evenPayout = livePayouts?.["DIGITEVEN"] ?? DEFAULT_PAYOUTS["DIGITEVEN"];
  const oddPayout  = livePayouts?.["DIGITODD"]  ?? DEFAULT_PAYOUTS["DIGITODD"];
  const oddProb    = 1 - evenProb;
  return [
    buildEVResult("DIGITEVEN", evenProb, evenPayout, stake),
    buildEVResult("DIGITODD",  oddProb,  oddPayout,  stake),
  ];
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export interface EVAgentOutput extends AgentOutput {
  allEVResults: EVResult[];
  bestEVResult: EVResult | null;
  payoutsSource: "live" | "default";
}

export function runEVCalculatorAgent(
  ctx: ScanContext,
  dirResult: DirectionResult | null,
  barrierOptions: BarrierOption[],
  livePayouts: Record<string, number> | null,
  evenProb?: number,
): EVAgentOutput {
  const t0 = Date.now();
  const stake = computeStake(ctx);
  const preferred = ctx.settings.preferredContractTypes;

  const payoutsSource = livePayouts ? "live" : "default";
  const payouts = {
    rise:  livePayouts?.["CALL"]  ?? livePayouts?.["RISE"]  ?? DEFAULT_PAYOUTS["CALL"],
    fall:  livePayouts?.["PUT"]   ?? livePayouts?.["FALL"]  ?? DEFAULT_PAYOUTS["PUT"],
  };

  const allEV: EVResult[] = [];

  if (dirResult) {
    allEV.push(...evForDirectionProducts(dirResult, payouts, stake, preferred));
  }

  if (preferred.some((t) => t === "DIGITOVER" || t === "DIGITUNDER" || t === "DIGITMATCH" || t === "DIGITDIFF") && barrierOptions.length > 0) {
    allEV.push(...evForDigitProducts(barrierOptions, stake));
  }

  // EVEN/ODD: compute when preferred and we have a valid probability
  if (
    evenProb !== undefined &&
    preferred.some((t) => t === "DIGITEVEN" || t === "DIGITODD")
  ) {
    allEV.push(...evForEvenOddProducts(evenProb, stake, livePayouts));
  }

  // Best result: prefer strictly positive EV → near-breakeven → any result (best EV overall).
  // Never return null when there are candidates — a null bestEV permanently kills the engine
  // because master-decision blocks with "No EV calculation available".
  const strictPositiveEV = allEV.filter((r) => r.isPositiveEV).sort((a, b) => b.dollarEV - a.dollarEV);
  const nearBreakevenAny = allEV
    .filter((r) => r.isNearBreakeven)
    .sort((a, b) => b.dollarEV - a.dollarEV);
  const anySorted = [...allEV].sort((a, b) => b.expectedValue - a.expectedValue);

  const bestEVResult = strictPositiveEV[0] ?? nearBreakevenAny[0] ?? anySorted[0] ?? null;

  // For low-tier digit barriers (safest — lowest payout), positive EV is
  // impossible at Deriv's fixed payouts. Score by edge instead so these
  // options don't drag the consensus into the floor. Tier is looked up
  // dynamically from DIGIT_TIERS so this works for ANY user-configured
  // normal/recovery barrier, not just a hardcoded pair.
  const isDigitTier1Result = !!bestEVResult && bestEVResult.barrier !== undefined &&
    (DIGIT_TIERS[bestEVResult.product]?.[bestEVResult.barrier] ?? 2) <= 1;

  // Scale digit EV scores by sample size to prevent small-sample inflation.
  // A 5% edge computed from 30 digits is mostly statistical noise — the same
  // edge from 100+ digits is a genuine signal. Blend toward neutral (50) for
  // small samples so marginal setups don't look stronger than they really are.
  const isDigitResult = bestEVResult ? bestEVResult.product.startsWith("DIGIT") : false;
  const digitSampleSize = isDigitResult ? (ctx.digits?.length ?? 0) : 100;
  const sampleFactor = Math.min(1, Math.sqrt(digitSampleSize / 100));

  const rawScore = bestEVResult
    ? isDigitTier1Result
      ? Math.min(95, Math.round(50 + bestEVResult.edge * 500))
      : Math.min(95, Math.round(50 + bestEVResult.expectedValue * 300))
    : 10;
  // At 25 digits: sampleFactor≈0.5 → score halfway between neutral and rawScore.
  // At 100+ digits: sampleFactor=1.0 → full rawScore used unchanged.
  const score = (isDigitResult && bestEVResult)
    ? Math.round(rawScore * sampleFactor + 50 * (1 - sampleFactor))
    : rawScore;

  const allEVCount = allEV.length;
  const positiveEVCount = strictPositiveEV.length;

  const reasoning = bestEVResult
    ? `Best EV: ${bestEVResult.product}${bestEVResult.barrier !== undefined ? ` barrier=${bestEVResult.barrier}` : ""} — EV=${(bestEVResult.expectedValue * 100).toFixed(1)}% per $1 stake ($${bestEVResult.dollarEV.toFixed(3)}/trade). P(win)=${(bestEVResult.winProbability * 100).toFixed(1)}%, breakeven=${(bestEVResult.breakevenWinRate * 100).toFixed(1)}%. Payouts from ${payoutsSource}.${bestEVResult.isNearBreakeven ? " [Near-breakeven — marginal edge]" : ""}`
    : `No positive-EV opportunity found among ${allEVCount} options. Best was ${allEV.length > 0 ? (Math.max(...allEV.map(r => r.expectedValue)) * 100).toFixed(1) + "%" : "N/A"}`;

  return {
    agentId: "evCalculator",
    score,
    confidence: bestEVResult ? Math.min(95, Math.round(Math.abs(bestEVResult.edge) * 500)) : 0,
    signal: scoreToSignal(score),
    reasoning,
    data: {
      bestEVResult,
      allEVCount,
      positiveEVCount,
      payoutsSource,
    },
    executionTimeMs: Date.now() - t0,
    allEVResults: allEV,
    bestEVResult,
    payoutsSource,
  };
}

/** Compute initial stake based on risk settings. Guards against NaN/zero values.
 *  When riskAmountType="fixed" the riskAmountValue is used directly (after
 *  applying the riskProfile multiplier). When riskAmountType="percentage" the
 *  legacy percentage-of-balance path is used. Both paths respect maxTradeStake. */
export function computeStake(ctx: ScanContext): number {
  const { balance, settings } = ctx;
  const riskMult = settings.riskProfile === "conservative" ? 0.4
    : settings.riskProfile === "aggressive" ? 1.0 : 0.7;

  let rawStake: number;
  if (settings.riskAmountType === "fixed") {
    const fixedAmount = Number(settings.riskAmountValue);
    rawStake = (!isFinite(fixedAmount) || fixedAmount <= 0) ? 1 : fixedAmount;
    // riskProfile still scales fixed stakes (conservative trades smaller, aggressive larger)
    rawStake = rawStake * riskMult;
  } else {
    // Percentage mode — riskAmountValue holds the % figure (e.g. 0.5 = 0.5% of balance).
    // Do NOT use maxRiskPerTrade: that column is not updated by the settings form.
    const riskPct = Number(settings.riskAmountValue);
    const effectiveRiskPct = (!isFinite(riskPct) || riskPct <= 0) ? 1 : riskPct;
    rawStake = balance * (effectiveRiskPct / 100) * riskMult;
  }

  return Math.max(0.35, Math.min(rawStake, settings.maxTradeStake));
}
