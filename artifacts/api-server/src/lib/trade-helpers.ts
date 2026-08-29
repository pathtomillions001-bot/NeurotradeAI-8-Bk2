import { db } from "@workspace/db";
import { tradeFeaturesTable } from "@workspace/db";
import type { MarketAnalysis } from "./ai-engine";
import { getContractProposal } from "./deriv";
import { calibrateConfidence, computeBreakevenWinRate, computeExpectedValue } from "./calibration";
import { logger } from "./logger";
import { getFallbackPayout } from "./payouts";

export interface FinalizedAnalysis extends MarketAnalysis {
  calibratedConfidence: number;
  winProbability: number;
  expectedValue: number;
  breakevenWinRate: number;
  payoutMultiplier: number;
  recommendedDuration: number;
}

// ── Payout multiplier cache (avoids slow WS round-trip on every scan) ─────────
const payoutCache = new Map<string, { value: number; ts: number }>();
const PAYOUT_TTL_MS = 20 * 60 * 1000;

function payoutKey(symbol: string, contractType: string, barrier?: number): string {
  return `${symbol}:${contractType}:${barrier ?? ""}`;
}

function getCachedPayout(symbol: string, contractType: string, barrier?: number): number | null {
  const key = payoutKey(symbol, contractType, barrier);
  const hit = payoutCache.get(key);
  if (hit && Date.now() - hit.ts < PAYOUT_TTL_MS) return hit.value;
  return null;
}

function setCachedPayout(symbol: string, contractType: string, barrier: number | undefined, value: number) {
  payoutCache.set(payoutKey(symbol, contractType, barrier), { value, ts: Date.now() });
}

export async function finalizeAnalysis(
  analysis: MarketAnalysis,
  opts: {
    symbol: string;
    currency: string;
    token: string | null;
    defaultDuration: number;
    barrier?: number;
    skipProposal?: boolean;
  },
): Promise<FinalizedAnalysis> {
  const duration = analysis.recommendedDuration ?? opts.defaultDuration;
  const barrier = analysis.digitBarrier ?? opts.barrier;
  const isDigit = analysis.recommendedContractType.includes("DIGIT");

  let payoutMultiplier: number;
  const cached = getCachedPayout(opts.symbol, analysis.recommendedContractType, isDigit ? barrier : undefined);

  if (cached !== null) {
    payoutMultiplier = cached;
  } else if (opts.skipProposal) {
    payoutMultiplier = getFallbackPayout(analysis.recommendedContractType, barrier);
  } else {
    try {
      const proposal = await Promise.race([
        getContractProposal(opts.token, {
          symbol: opts.symbol,
          contractType: analysis.recommendedContractType,
          stake: analysis.recommendedStake,
          duration,
          durationUnit: "t",
          currency: opts.currency,
          barrier: isDigit ? barrier : undefined,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      payoutMultiplier = proposal?.payoutMultiplier ?? getFallbackPayout(analysis.recommendedContractType, barrier);
      setCachedPayout(opts.symbol, analysis.recommendedContractType, isDigit ? barrier : undefined, payoutMultiplier);
    } catch {
      payoutMultiplier = getFallbackPayout(analysis.recommendedContractType, barrier);
    }
  }

  const calibratedConfidence = await calibrateConfidence(analysis.confidenceScore, analysis.recommendedContractType);
  const winProbability = isDigit
    ? (analysis.digitConfidence ?? calibratedConfidence)
    : Math.round(analysis.winProbability ?? calibratedConfidence);

  const expectedValue = computeExpectedValue(winProbability, analysis.recommendedStake, payoutMultiplier);
  const breakevenWinRate = computeBreakevenWinRate(payoutMultiplier);

  return {
    ...analysis,
    calibratedConfidence,
    winProbability,
    expectedValue: Math.round(expectedValue * 100) / 100,
    breakevenWinRate,
    payoutMultiplier: Math.round(payoutMultiplier * 1000) / 1000,
    recommendedDuration: duration,
  };
}

export async function logTradeFeatures(
  tradeId: number,
  analysis: FinalizedAnalysis,
  opts: {
    symbol: string;
    barrier?: number | null;
    tickWindow?: number | null;
    duration: number;
    featuresJson?: Record<string, unknown>;
    isPaperTrade?: boolean;
  },
): Promise<void> {
  try {
    await db.insert(tradeFeaturesTable).values({
      tradeId,
      symbol: opts.symbol,
      contractType: analysis.recommendedContractType,
      barrier: opts.barrier ?? analysis.digitBarrier ?? null,
      tickWindow: opts.tickWindow ?? analysis.tickWindow ?? null,
      duration: opts.duration,
      featuresJson: JSON.stringify(opts.featuresJson ?? {}),
      rfProb: analysis.mlModels ? String(analysis.mlModels.randomForest) : null,
      gbProb: analysis.mlModels ? String(analysis.mlModels.gradientBoosting) : null,
      lrProb: analysis.mlModels ? String(analysis.mlModels.logistic) : null,
      rawConfidence: String(analysis.confidenceScore),
      calibratedConfidence: String(analysis.calibratedConfidence),
      expectedValue: String(analysis.expectedValue),
      payoutMultiplier: String(analysis.payoutMultiplier),
      breakevenWinRate: String(analysis.breakevenWinRate),
      isPaperTrade: opts.isPaperTrade ? 1 : 0,
    });
  } catch {
    // table may not exist until schema push
  }
}

export function shouldExecuteTrade(
  analysis: FinalizedAnalysis,
  opts: { minConfidence: number; requirePositiveEv: boolean },
): { execute: boolean; reason?: string } {
  if (!analysis.shouldTrade) {
    return { execute: false, reason: "ML risk gates failed (shouldTrade=false)" };
  }
  if (analysis.calibratedConfidence < opts.minConfidence) {
    return { execute: false, reason: `Calibrated confidence ${analysis.calibratedConfidence}% below threshold ${opts.minConfidence}%` };
  }
  if (opts.requirePositiveEv && analysis.expectedValue <= 0) {
    return { execute: false, reason: `Negative EV ($${analysis.expectedValue.toFixed(2)}) — breakeven ${analysis.breakevenWinRate}%` };
  }
  return { execute: true };
}
