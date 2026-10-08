/**
 * Multi-Asset Desk — market regime classification.
 *
 * The same setup is a good trade in one regime and a losing trade in another:
 * a breakout is edge in a trending market and a trap in a range. Classifying
 * the regime first is what lets the agent choose between "trail it" and "bank
 * it at the band edge", and what lets it decline to scalp a market that is
 * only moving because volatility exploded.
 */

import {
  atr,
  bandWidth,
  closes,
  ewmaVolatility,
  linreg,
  logReturns,
  percentileRank,
  clamp,
} from "./math";
import type { Bar } from "./types";

export type RegimeKind = "trend_up" | "trend_down" | "range" | "volatile";

export interface RegimeAssessment {
  kind: RegimeKind;
  /** How confident the classification is, in [0,1]. */
  confidence: number;
  /** Trend slope normalised by ATR — direction strength per bar. */
  normalisedSlope: number;
  /** R² of the regression — how orderly the move is. */
  trendQuality: number;
  /** Current ATR divided by its own longer-run average. */
  volatilityRatio: number;
  /** Percentile of current Bollinger width vs history (squeeze detection). */
  bandWidthPercentile: number;
  atr: number;
  /** EWMA volatility of log returns, per bar, over the volatility window. */
  stepVolatility: number;
  /** Mean log return per bar over the same window as stepVolatility. */
  drift: number;
  /**
   * How many returns the drift and stepVolatility were measured over. The drift's
   * t-statistic needs this count; using the full history instead overstates it.
   */
  driftSamples: number;
}

export interface RegimeOptions {
  regressionPeriod: number;
  atrPeriod: number;
  /** Window used to judge whether current ATR is high or low for this market. */
  volatilityLookback: number;
  /** ATR ratio above which the market is classified `volatile`. */
  volatileRatio: number;
  /** |slope|/ATR below which the market is classified `range`. */
  rangeSlopeThreshold: number;
  /** Minimum R² for a move to count as an orderly trend. */
  minTrendQuality: number;
}

export const DEFAULT_REGIME_OPTIONS: RegimeOptions = {
  regressionPeriod: 50,
  atrPeriod: 14,
  volatilityLookback: 100,
  volatileRatio: 1.8,
  rangeSlopeThreshold: 0.08,
  minTrendQuality: 0.35,
};

export function assessRegime(bars: Bar[], options: Partial<RegimeOptions> = {}): RegimeAssessment {
  const opts = { ...DEFAULT_REGIME_OPTIONS, ...options };
  const price = closes(bars);

  // Too little history: report a neutral range with zero confidence rather
  // than inventing a classification the agent would then trade on.
  if (bars.length < 10) {
    return {
      kind: "range",
      confidence: 0,
      normalisedSlope: 0,
      trendQuality: 0,
      volatilityRatio: 1,
      bandWidthPercentile: 0.5,
      atr: 0,
      stepVolatility: 0,
      drift: 0,
      driftSamples: 0,
    };
  }

  const window = price.slice(-opts.regressionPeriod);
  const reg = linreg(window);
  const currentAtr = atr(bars.slice(-Math.max(opts.atrPeriod * 3, 30)), opts.atrPeriod);
  const referenceAtr = atr(bars.slice(-opts.volatilityLookback), opts.atrPeriod);

  const volatilityRatio = referenceAtr > 0 ? currentAtr / referenceAtr : 1;
  const normalisedSlope = currentAtr > 0 ? reg.slope / currentAtr : 0;

  // Band-width percentile across a rolling history detects squeezes, which
  // precede expansion and make range-fading dangerous.
  const widths: number[] = [];
  const step = Math.max(1, Math.floor(bars.length / 60));
  for (let end = 20; end <= price.length; end += step) {
    widths.push(bandWidth(price.slice(0, end), 20, 2));
  }
  const currentWidth = bandWidth(price, 20, 2);
  const bandWidthPercentile = percentileRank(widths, currentWidth);

  const returns = logReturns(price.slice(-Math.max(opts.volatilityLookback, 30)));
  const stepVolatility = ewmaVolatility(returns);
  const drift = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

  let kind: RegimeKind;
  let confidence: number;

  const trending =
    Math.abs(normalisedSlope) >= opts.rangeSlopeThreshold && reg.r2 >= opts.minTrendQuality;

  if (volatilityRatio >= opts.volatileRatio && !trending) {
    // Expansion without direction — the most expensive market to scalp.
    kind = "volatile";
    confidence = clamp((volatilityRatio - opts.volatileRatio) / opts.volatileRatio + 0.5, 0, 1);
  } else if (trending) {
    kind = normalisedSlope > 0 ? "trend_up" : "trend_down";
    // Confidence blends how steep the move is with how orderly it is; a steep
    // but ragged move is not a trend you can hold through.
    const steepness = clamp(Math.abs(normalisedSlope) / (opts.rangeSlopeThreshold * 4), 0, 1);
    confidence = clamp(0.35 * steepness + 0.65 * reg.r2, 0, 1);
  } else {
    kind = "range";
    const flatness = clamp(1 - Math.abs(normalisedSlope) / opts.rangeSlopeThreshold, 0, 1);
    confidence = clamp(0.5 * flatness + 0.5 * (1 - reg.r2), 0, 1);
  }

  return {
    kind,
    confidence,
    normalisedSlope,
    trendQuality: reg.r2,
    volatilityRatio,
    bandWidthPercentile,
    atr: currentAtr,
    stepVolatility,
    drift,
    driftSamples: returns.length,
  };
}

/** Directional bias of a regime, for timeframe-agreement checks. */
export function regimeBias(kind: RegimeKind): "up" | "down" | "neutral" {
  if (kind === "trend_up") return "up";
  if (kind === "trend_down") return "down";
  return "neutral";
}

/**
 * Whether a regime is tradeable for a given style.
 *
 * Scalping a `volatile` regime is how accounts die: stops that were sized for
 * normal conditions get swept by noise. Swing entries tolerate it because
 * their stops are proportionally wider.
 */
export function isRegimeTradeable(kind: RegimeKind, mode: "scalp" | "intraday" | "swing"): boolean {
  if (kind === "volatile") return mode === "swing";
  return true;
}
