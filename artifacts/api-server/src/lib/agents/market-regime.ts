/**
 * Market Regime Agent
 *
 * RESPONSIBILITY: Classify the current market state so other agents can
 * apply regime-appropriate strategies. Different contract types perform
 * better in different regimes:
 *
 *   trending_up / trending_down  → RISE/FALL/CALL/PUT with trend
 *   mean_reverting               → fade extremes, RISE after FALL streak
 *   choppy                       → OVER/UNDER preferred (direction unclear)
 *   volatile                     → reduce stakes, avoid direction bets
 *   quiet                        → wider barriers for OVER/UNDER
 *
 * Uses Hurst exponent + autocorrelation + volatility ratio (NO EMA/RSI).
 */

import type { AgentOutput, MarketRegime, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import type { FeatureSet } from "./feature-engineering";

export interface RegimeOutput {
  regime: MarketRegime;
  /** Probability estimate for each regime (sums to 1) */
  regimeProbabilities: Record<MarketRegime, number>;
  /** Which product classes are favored in this regime */
  favoredProducts: string[];
  /** Which product classes are penalized in this regime */
  penalizedProducts: string[];
  hurstExponent: number;
  isExpanding: boolean;   // vol expanding vs contracting
  trendStrength: number;  // 0-100
}

export function classifyRegime(features: FeatureSet): RegimeOutput {
  const pf = features.price;

  const hurst = pf.hurst;
  const volRatio = pf.volRatio;
  const ac1 = pf.autocorr1;
  const ac3 = pf.autocorr3;
  const momentum = pf.momentum5;
  const vol = pf.vol20;

  // Regime probability scoring (soft classification, not hard cutoffs)
  let pTrendUp = 0, pTrendDown = 0, pMeanRev = 0, pChoppy = 0, pVolatile = 0, pQuiet = 0;

  // Trending signals: high Hurst + positive autocorrelation + consistent momentum
  if (hurst > 0.6) {
    pTrendUp += (hurst - 0.5) * 2;
    pTrendDown += (hurst - 0.5) * 2;
  }
  if (ac1 > 0.1) { pTrendUp += ac1; pTrendDown += ac1; }
  if (momentum > 0.0002) pTrendUp += Math.min(0.4, momentum * 2000);
  if (momentum < -0.0002) pTrendDown += Math.min(0.4, Math.abs(momentum) * 2000);

  // Mean-reverting: Hurst < 0.45, negative autocorrelation
  if (hurst < 0.45) pMeanRev += (0.5 - hurst) * 2;
  if (ac1 < -0.05) pMeanRev += Math.abs(ac1);
  if (ac3 < -0.05) pMeanRev += Math.abs(ac3) * 0.5;

  // Choppy: near-random Hurst, low spectral energy, entropy near max
  if (hurst > 0.45 && hurst < 0.55) pChoppy += 0.4;
  if (pf.returnEntropy > 0.9) pChoppy += 0.3;
  if (Math.abs(ac1) < 0.05) pChoppy += 0.2;

  // Volatile: vol expanding, high absolute vol
  if (volRatio > 1.5) pVolatile += (volRatio - 1) * 0.4;
  if (vol > 0.005) pVolatile += 0.4;

  // Quiet: low vol, contracting
  if (volRatio < 0.6 && vol < 0.001) pQuiet += 0.5;
  if (vol < 0.0005) pQuiet += 0.4;

  // Normalize
  const total = pTrendUp + pTrendDown + pMeanRev + pChoppy + pVolatile + pQuiet + 0.01;
  const probs: Record<MarketRegime, number> = {
    trending_up: pTrendUp / total,
    trending_down: pTrendDown / total,
    mean_reverting: pMeanRev / total,
    choppy: pChoppy / total,
    volatile: pVolatile / total,
    quiet: pQuiet / total,
  };

  // Pick dominant regime
  const regime = (Object.entries(probs) as [MarketRegime, number][])
    .sort((a, b) => b[1] - a[1])[0][0];

  const trendStrength = Math.round(Math.max(pTrendUp, pTrendDown) / (total) * 100);

  // Product favorability by regime
  const favoredMap: Record<MarketRegime, string[]> = {
    trending_up: ["CALL"],
    trending_down: ["PUT"],
    mean_reverting: ["DIGITOVER", "DIGITUNDER", "CALL", "PUT"],
    choppy: ["DIGITOVER", "DIGITUNDER"],
    volatile: ["DIGITOVER", "DIGITUNDER"],
    quiet: ["DIGITOVER", "DIGITUNDER"],
  };
  const penalizedMap: Record<MarketRegime, string[]> = {
    trending_up: ["DIGITOVER", "DIGITUNDER"],
    trending_down: ["DIGITOVER", "DIGITUNDER"],
    mean_reverting: [],
    choppy: ["CALL", "PUT"],
    volatile: ["CALL", "PUT"],
    quiet: [],
  };

  return {
    regime,
    regimeProbabilities: probs,
    favoredProducts: favoredMap[regime],
    penalizedProducts: penalizedMap[regime],
    hurstExponent: hurst,
    isExpanding: volRatio > 1.2,
    trendStrength,
  };
}

export function runMarketRegimeAgent(ctx: ScanContext, features: FeatureSet): AgentOutput & { regimeOutput: RegimeOutput } {
  const t0 = Date.now();
  const out = classifyRegime(features);

  const pf = features.price;

  // Agent score: how clear / useful is the regime classification?
  // High confidence when one regime dominates. Low confidence in ambiguous states.
  const maxProb = Math.max(...Object.values(out.regimeProbabilities));
  const clarity = maxProb; // 0.33 = uniform, 1.0 = definitive
  const score = Math.round(40 + clarity * 60);

  const regimeDesc: Record<MarketRegime, string> = {
    trending_up:    "Strong uptrend — momentum trades preferred",
    trending_down:  "Strong downtrend — momentum trades preferred",
    mean_reverting: "Mean-reverting — fade extremes, OVER/UNDER viable",
    choppy:         "Choppy/directionless — OVER/UNDER preferred over direction bets",
    volatile:       "Volatile expansion — reduce stakes, avoid directional bets",
    quiet:          "Low volatility — OVER/UNDER at wider barriers",
  };

  const reasoning = `${regimeDesc[out.regime]}. Hurst=${pf.hurst.toFixed(2)}, ac1=${pf.autocorr1.toFixed(2)}, volRatio=${pf.volRatio.toFixed(2)}. Regime confidence: ${(maxProb * 100).toFixed(0)}%.`;

  return {
    agentId: "marketRegime",
    score,
    confidence: Math.round(maxProb * 100),
    signal: scoreToSignal(score),
    reasoning,
    data: { regimeOutput: out, favored: out.favoredProducts, penalized: out.penalizedProducts },
    executionTimeMs: Date.now() - t0,
    regimeOutput: out,
  };
}
