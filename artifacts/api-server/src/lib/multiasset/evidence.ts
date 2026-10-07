/**
 * Multi-Asset Desk — the evidence ensemble.
 *
 * THE PROBLEM THIS REPLACES
 * -------------------------
 * The previous pipeline ended in a chain of hard vetoes: confluence score,
 * higher-timeframe alignment, and a Markov persistence floor. Each veto was
 * individually reasonable and collectively suffocating — a single unsure
 * estimator could (and routinely did) block a setup every other estimator
 * liked. Users experienced that as "we never take trades".
 *
 * THE REPLACEMENT
 * ---------------
 * A weighted vote across seven deliberately weakly-correlated families. Each
 * family returns three separate numbers instead of one verdict:
 *
 *   vote        ∈ {−1, 0, +1}  which way it points
 *   strength    ∈ [0, 1]       how strongly
 *   reliability ∈ [0, 1]       how much data backs it
 *
 * Reliability is the important addition. It shrinks a factor's influence
 * toward neutral when the sample is thin, rather than dropping the factor
 * (which would make the score explode on one confident number) or ignoring
 * its uncertainty (which is how a 40-bar Hurst estimate ends up driving
 * real money).
 *
 * Rules of the ensemble:
 *   - no single family can veto;
 *   - a family that disagrees reduces the score, it does not zero it;
 *   - a family that has no opinion contributes nothing and costs nothing;
 *   - the trade is taken on the balance of evidence plus a minimum number of
 *     independent agreeing families — never on unanimity.
 *
 * Mode awareness is not cosmetic: scalps weight flow, momentum and breakout
 * (microstructure dominates over minutes), swing weights regime and trend
 * (macro structure dominates over days), and mean-reversion is only allowed
 * to speak when the series is demonstrably anti-persistent.
 */

import { clamp, closes, logReturns, rsi, atr } from "./math";
import {
  betaPosterior,
  efficiencyRatio,
  garchVolatility,
  hurstExponent,
  kalmanTrend,
  lag1Autocorrelation,
  moneyFlow,
  ouFit,
  rangePosition,
  shannonEntropy,
  skewness,
  excessKurtosis,
  varianceRatio,
  volatilityExpansion,
  type OuFit as OuFitResult,
} from "./analytics";
import { directionalPersistence, markovFromPrices, sampleConfidence } from "./markov";
import type { Bar, TradeMode } from "./types";

export type FactorFamily =
  | "trend"
  | "momentum"
  | "meanReversion"
  | "breakout"
  | "flow"
  | "regime"
  | "markov";

export const FACTOR_FAMILIES: readonly FactorFamily[] = [
  "trend",
  "momentum",
  "meanReversion",
  "breakout",
  "flow",
  "regime",
  "markov",
] as const;

export const FACTOR_LABELS: Record<FactorFamily, string> = {
  trend: "Kalman trend",
  momentum: "Momentum",
  meanReversion: "Mean reversion",
  breakout: "Breakout / range",
  flow: "Volume flow",
  regime: "Regime memory",
  markov: "Markov persistence",
};

/**
 * Family weights per trading style. Each row sums to 1.
 *
 * Scalp: microstructure carries the decision — flow, momentum and breakout
 *   dominate; mean-reversion is loud because a scalp is very often a fade of
 *   a oneor two-bar extension.
 * Intraday: trend and regime take over, with flow still meaningful.
 * Swing: trend and regime (Hurst / variance ratio / weekly structure) decide;
 *   flow is nearly worthless over days and is weighted accordingly.
 */
export const MODE_FACTOR_WEIGHTS: Record<TradeMode, Record<FactorFamily, number>> = {
  scalp: { trend: 0.14, momentum: 0.19, meanReversion: 0.14, breakout: 0.17, flow: 0.18, regime: 0.08, markov: 0.1 },
  intraday: { trend: 0.24, momentum: 0.14, meanReversion: 0.08, breakout: 0.13, flow: 0.12, regime: 0.15, markov: 0.14 },
  swing: { trend: 0.28, momentum: 0.1, meanReversion: 0.05, breakout: 0.1, flow: 0.07, regime: 0.22, markov: 0.18 },
};

/**
 * How many independent families must agree before a mode will trade.
 *
 * Deliberately less than the total. Requiring all seven is what produced
 * analysis paralysis; requiring two would let a single strong indicator
 * family take the trade on its own.
 */
export const MODE_MIN_AGREEING_FAMILIES: Record<TradeMode, number> = {
  scalp: 3,
  intraday: 3,
  swing: 3,
};

/** A factor never contributes less than this share of its weight, however unsure. */
const MIN_TRUST = 0.35;

/** Below this |contribution| a family is treated as having no opinion. */
const NEUTRAL_STRENGTH = 0.12;

export interface EvidenceFactor {
  family: FactorFamily;
  label: string;
  vote: -1 | 0 | 1;
  strength: number;
  reliability: number;
  weight: number;
  /** Signed, reliability-shrunk contribution to the weighted mean. */
  contribution: number;
  detail: string;
}

export interface EvidenceDiagnostics {
  hurstH: number;
  hurstReliability: number;
  varianceRatio: number;
  varianceRatioZ: number;
  efficiencyRatio: number;
  entropy: number;
  lag1Autocorrelation: number;
  skew: number;
  excessKurtosis: number;
  garchVolatility: number;
  atrValue: number;
  rsi: number;
  kalmanSlope: number;
  rangePosition: number;
  volatilityExpansion: number;
  ouHalfLife: number;
  ouZ: number;
  markovPersistence: number;
  markovSampleConfidence: number;
}

export interface EvidenceResult {
  symbol: string;
  mode: TradeMode;
  timeframe: string;
  direction: "up" | "down" | "none";
  /** 0–100. The weighted balance of evidence. */
  confidence: number;
  /** The same number on its native [−1, 1] scale. */
  raw: number;
  factors: EvidenceFactor[];
  /** Families that actively (i.e. above the neutral threshold) agree. */
  agreeingFamilies: number;
  totalFamilies: number;
  /** Families that actively disagree — used for warnings, never for vetoes. */
  dissentingFamilies: number;
  diagnostics: EvidenceDiagnostics;
}

export interface EvidenceInput {
  symbol: string;
  mode: TradeMode;
  timeframe: string;
  bars: Bar[];
  /** Bars the trade is expected to need. Drives the Markov horizon. */
  horizon: number;
  /** Force a direction; otherwise it is inferred from the weighted vote. */
  direction?: "up" | "down";
}

/** Turn a signed magnitude into (vote, strength). */
function signed(value: number, scale = 1): { vote: -1 | 0 | 1; strength: number } {
  const normalised = clamp(value / scale, -1, 1);
  if (Math.abs(normalised) < 0.02) return { vote: 0, strength: 0 };
  return { vote: normalised > 0 ? 1 : -1, strength: Math.min(1, Math.abs(normalised)) };
}

/**
 * Score one family against a proposed direction.
 *
 * `favourable` is the factor's own signed reading in the UP direction:
 * positive means it supports a long, negative a short.
 */
function makeFactor(
  family: FactorFamily,
  mode: TradeMode,
  direction: "up" | "down",
  favourable: number,
  scale: number,
  reliability: number,
  detail: string,
): EvidenceFactor {
  const weight = MODE_FACTOR_WEIGHTS[mode][family];
  const { vote, strength } = signed(favourable, scale);
  // Flip into the trade's own frame: a factor reading "up" is favourable for
  // a long and unfavourable for a short.
  const aligned = direction === "up" ? vote : (vote === 0 ? 0 : (-vote as -1 | 1));
  const trust = MIN_TRUST + (1 - MIN_TRUST) * clamp(reliability, 0, 1);
  return {
    family,
    label: FACTOR_LABELS[family],
    vote: aligned,
    strength,
    reliability: clamp(reliability, 0, 1),
    weight,
    contribution: aligned * strength * weight * trust,
    detail,
  };
}

/**
 * Build the evidence ensemble for one symbol/timeframe.
 *
 * `bars` should be the entry timeframe's series — the timeframe the stop and
 * target are actually placed on. Higher-timeframe context is a separate,
 * explicitly non-vetoing layer (see confluence.ts).
 */
export function buildEvidence(input: EvidenceInput): EvidenceResult {
  const { symbol, mode, bars, horizon } = input;
  const price = closes(bars);
  const returns = logReturns(price);
  const atrValue = atr(bars, 14);
  const last = price.length > 0 ? price[price.length - 1] : 0;

  // ── Diagnostics (measured once, reused by every family) ────────────────────
  const hurst = hurstExponent(price, 8);
  const vr = varianceRatio(returns, mode === "scalp" ? 3 : mode === "intraday" ? 4 : 6);
  const er = efficiencyRatio(price, mode === "scalp" ? 12 : 24);
  const entropy = shannonEntropy(returns, 8);
  const lag1 = lag1Autocorrelation(returns);
  const skew = skewness(returns);
  const kurt = excessKurtosis(returns);
  const garch = garchVolatility(returns);
  const rsiValue = rsi(price, 14);
  const kalman = kalmanTrend(price, atrValue);
  const rangePos = rangePosition(bars, mode === "scalp" ? 12 : mode === "intraday" ? 20 : 30);
  const volExpansion = volatilityExpansion(bars);
  const ou = ouFit(price);
  const model = markovFromPrices(price);
  const markovConfidence = sampleConfidence(model);

  // Sample depth gates how loud any statistic estimated from these bars may be.
  const depth = clamp(price.length / 200, 0.15, 1);

  const buildFor = (direction: "up" | "down"): EvidenceFactor[] => {
    const factors: EvidenceFactor[] = [];

    // 1. Trend — Kalman slope plus a slow/fast level comparison.
    const trendFavourable = kalman.normalisedSlope;
    factors.push(
      makeFactor(
        "trend",
        mode,
        direction,
        trendFavourable,
        0.35,
        kalman.confidence * depth,
        `Kalman slope ${kalman.normalisedSlope >= 0 ? "+" : ""}${kalman.normalisedSlope.toFixed(3)} ATR/bar · level ${kalman.level.toFixed(last > 100 ? 2 : 5)}`,
      ),
    );

    // 2. Momentum — RSI as a continuation gauge, with an overextension penalty
    //    so the ensemble does not buy the top of a blow-off.
    const momentum = rsiValue - 50;
    const overextended = (rsiValue - 50) * (vr.ratio > 1 ? 1 : 0.6);
    factors.push(
      makeFactor(
        "momentum",
        mode,
        direction,
        overextended,
        28,
        depth * (1 - Math.min(0.4, Math.max(0, Math.abs(momentum) - 30) / 40)),
        `RSI ${rsiValue.toFixed(0)}${Math.abs(momentum) > 30 ? " (extended — fading risk)" : ""}`,
      ),
    );

    // 3. Mean reversion — ONLY allowed to speak when the series is genuinely
    //    anti-persistent. In a trending market its vote is shrunk to nothing
    //    instead of being allowed to short every uptrend.
    const meanReverting = hurst.H < 0.5 && vr.ratio < 1;
    const reversionStrength = meanReverting ? clamp(1 - hurst.H / 0.5, 0, 1) : 0;
    const ouFavourable = ou.usable ? -ou.z : 0; // stretched high → favours a short
    factors.push(
      makeFactor(
        "meanReversion",
        mode,
        direction,
        ouFavourable,
        2.2,
        ou.usable ? reversionStrength * clamp(ou.r2 * 2, 0, 1) * depth : 0,
        ou.usable && reversionStrength > 0.05
          ? `OU z ${ou.z.toFixed(2)} · half-life ${Number.isFinite(ou.halfLife) ? ou.halfLife.toFixed(1) : "∞"} bars`
          : `suppressed — H ${hurst.H.toFixed(2)} / VR ${vr.ratio.toFixed(2)} indicates trend, not reversion`,
      ),
    );

    // 4. Breakout / range location — near the top of the range favours
    //    continuation up; pinned at the bottom favours continuation down.
    const breakoutFavourable = (rangePos - 0.5) * 2;
    const breakoutReliability = clamp(volExpansion > 1.15 ? 1 : 0.65, 0, 1) * depth;
    factors.push(
      makeFactor(
        "breakout",
        mode,
        direction,
        breakoutFavourable,
        0.7,
        breakoutReliability,
        `${(rangePos * 100).toFixed(0)}% of the ${mode === "scalp" ? "12" : mode === "intraday" ? "20" : "30"}-bar range · ATR ×${volExpansion.toFixed(2)} vs slow ATR`,
      ),
    );

    // 5. Flow — volume-weighted close location.
    const flow = moneyFlow(bars, mode === "scalp" ? 10 : 14);
    factors.push(
      makeFactor(
        "flow",
        mode,
        direction,
        flow.value,
        0.8,
        flow.strength * depth,
        `money flow ${(flow.value * 100).toFixed(0)} (${flow.strength > 0.5 ? "conviction" : "light"})`,
      ),
    );

    // 6. Regime memory — does the series trend (Hurst, VR > 1) or chop?
    //    In a trending regime, momentum/trend evidence is trusted more; this
    //    factor votes with the dominant direction implied by VR and lag-1.
    const regimeFavourable = clamp(vr.ratio - 1, -1, 1) * (kalman.normalisedSlope >= 0 ? 1 : -1) * 3
      + clamp(lag1 * 6, -0.4, 0.4) * (kalman.normalisedSlope >= 0 ? 1 : -1);
    factors.push(
      makeFactor(
        "regime",
        mode,
        direction,
        regimeFavourable,
        0.9,
        clamp(hurst.reliability * 0.6 + (1 - entropy.normalised) * 0.4, 0, 1) * depth,
        `H ${hurst.H.toFixed(2)} · VR ${vr.ratio.toFixed(2)} (z ${vr.z.toFixed(1)}) · efficiency ${er.toFixed(2)} · entropy ${entropy.normalised.toFixed(2)}`,
      ),
    );

    // 7. Markov persistence — the old veto, now one vote among seven.
    const markovUp = directionalPersistence(model, "up", horizon);
    const markovDown = directionalPersistence(model, "down", horizon);
    const markovFavourable = (markovUp - markovDown) * 2;
    factors.push(
      makeFactor(
        "markov",
        mode,
        direction,
        markovFavourable,
        0.5,
        markovConfidence * depth,
        `P(up) ${(markovUp * 100).toFixed(0)}% vs P(down) ${(markovDown * 100).toFixed(0)}% over ${horizon} bars · ${(markovConfidence * 100).toFixed(0)}% sample confidence`,
      ),
    );

    return factors;
  };

  // ── Direction inference ────────────────────────────────────────────────────
  let direction: "up" | "down" | "none" = input.direction ?? "none";
  if (!input.direction) {
    // Vote on the raw (unflipped) readings: run both frames and pick the one
    // with the larger positive balance.
    const upBalance = buildFor("up").reduce((acc, f) => acc + f.contribution, 0);
    const downBalance = buildFor("down").reduce((acc, f) => acc + f.contribution, 0);
    if (Math.abs(upBalance) < 1e-9 && Math.abs(downBalance) < 1e-9) direction = "none";
    else direction = upBalance >= downBalance ? "up" : "down";
  }

  if (direction === "none") {
    const factors = buildFor("up");
    return {
      symbol,
      mode,
      timeframe: input.timeframe,
      direction: "none",
      confidence: 0,
      raw: 0,
      factors,
      agreeingFamilies: 0,
      totalFamilies: factors.length,
      dissentingFamilies: 0,
      diagnostics: diagnosticsOf(),
    };
  }

  const factors = buildFor(direction);
  const weightSum = factors.reduce((acc, f) => {
    const trust = MIN_TRUST + (1 - MIN_TRUST) * f.reliability;
    return acc + f.weight * trust;
  }, 0);
  const raw = weightSum === 0 ? 0 : clamp(factors.reduce((a, f) => a + f.contribution, 0) / weightSum, -1, 1);

  const agreeing = factors.filter((f) => f.vote === 1 && f.strength >= NEUTRAL_STRENGTH).length;
  const dissenting = factors.filter((f) => f.vote === -1 && f.strength >= NEUTRAL_STRENGTH).length;

  function diagnosticsOf(): EvidenceDiagnostics {
    return {
      hurstH: hurst.H,
      hurstReliability: hurst.reliability,
      varianceRatio: vr.ratio,
      varianceRatioZ: vr.z,
      efficiencyRatio: er,
      entropy: entropy.normalised,
      lag1Autocorrelation: lag1,
      skew,
      excessKurtosis: kurt,
      garchVolatility: garch,
      atrValue,
      rsi: rsiValue,
      kalmanSlope: kalman.normalisedSlope,
      rangePosition: rangePos,
      volatilityExpansion: volExpansion,
      ouHalfLife: ou.halfLife,
      ouZ: ou.z,
      markovPersistence: directionalPersistence(model, direction === "down" ? "down" : "up", horizon),
      markovSampleConfidence: markovConfidence,
    };
  }

  return {
    symbol,
    mode,
    timeframe: input.timeframe,
    direction,
    confidence: clamp((raw + 1) * 50, 0, 100),
    raw,
    // Strongest contributors first — the terminal renders this order.
    factors: factors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    agreeingFamilies: agreeing,
    totalFamilies: factors.length,
    dissentingFamilies: dissenting,
    diagnostics: diagnosticsOf(),
  };
}

/**
 * Bayesian view of the win rate for a symbol/mode, blended with whatever the
 * Monte Carlo says. Feeds sizing and the final edge gate.
 */
export function realisedWinRate(
  wins: number,
  losses: number,
): { mean: number; lower: number; weight: number } {
  const posterior = betaPosterior(wins, losses);
  return { mean: posterior.mean, lower: posterior.lower, weight: posterior.weight };
}

export type { OuFitResult };
