/**
 * Multi-Asset Desk — multi-timeframe confluence scoring.
 *
 * Every timeframe from M1 to D1 is assessed independently, then combined with
 * weights that depend on how the user is trading: a scalper cares most about
 * M1–M15 but must not fight H4, while a swing trader inverts that emphasis.
 *
 * The output is a 0–100 score, a grade, and — importantly — the per-factor
 * breakdown that the terminal renders so the user can see *why* the agent
 * does or does not like a trade.
 */

import { assessRegime, regimeBias, type RegimeAssessment } from "./regime";
import { closes, clamp, lastSwing, linreg, rsi } from "./math";
import { directionalPersistence, markovFromPrices, sampleConfidence } from "./markov";
import type { Bar, Timeframe, TradeMode } from "./types";

export interface TimeframeView {
  timeframe: Timeframe;
  regime: RegimeAssessment;
  bias: "up" | "down" | "neutral";
  /** Wilder RSI on closes. */
  rsi: number;
  /** Markov persistence of the dominant direction over the mode's horizon. */
  persistence: number;
  /** How much history backs the Markov estimate, in [0,1]. */
  sampleConfidence: number;
  /** Distance to the nearest structural level, in ATR units. */
  structureDistanceAtr: number;
  weight: number;
  /** Signed contribution to the final score. */
  contribution: number;
}

export interface ConfluenceResult {
  symbol: string;
  mode: TradeMode;
  direction: "up" | "down" | "none";
  /** 0–100. */
  score: number;
  grade: "A+" | "A" | "B" | "C" | "no-trade";
  views: TimeframeView[];
  /** True when no higher timeframe opposes the proposed direction. */
  higherTimeframeAligned: boolean;
  factors: { label: string; detail: string; weight: number; aligned: boolean }[];
  warnings: string[];
}

/**
 * Timeframe weights per style. They sum to 1 within each mode.
 *
 * Note that even the scalp profile gives H1/H4 real weight — not to pick the
 * entry, but to veto entries taken straight into a higher-timeframe wall.
 */
export const MODE_WEIGHTS: Record<TradeMode, Partial<Record<Timeframe, number>>> = {
  scalp: { M1: 0.26, M5: 0.26, M15: 0.2, M30: 0.12, H1: 0.1, H4: 0.06 },
  intraday: { M5: 0.14, M15: 0.22, M30: 0.2, H1: 0.22, H4: 0.16, D1: 0.06 },
  swing: { M15: 0.06, M30: 0.1, H1: 0.2, H4: 0.3, D1: 0.34 },
};

/** Bars ahead a trade of each style is expected to need. */
export const MODE_HORIZON_BARS: Record<TradeMode, number> = {
  scalp: 12,
  intraday: 24,
  swing: 30,
};

/** Score needed to be considered an A+ setup. */
export const MODE_SCORE_THRESHOLD: Record<TradeMode, number> = {
  scalp: 72,
  intraday: 68,
  swing: 65,
};

/** Timeframes that may veto a lower-timeframe entry, per style. */
const VETO_TIMEFRAMES: Record<TradeMode, Timeframe[]> = {
  scalp: ["H1", "H4"],
  intraday: ["H4", "D1"],
  swing: ["D1"],
};

function gradeFor(score: number, mode: TradeMode): ConfluenceResult["grade"] {
  const threshold = MODE_SCORE_THRESHOLD[mode];
  if (score >= threshold + 10) return "A+";
  if (score >= threshold) return "A";
  if (score >= threshold - 10) return "B";
  if (score >= threshold - 20) return "C";
  return "no-trade";
}

/** Build a single timeframe's view. */
export function buildTimeframeView(
  timeframe: Timeframe,
  bars: Bar[],
  mode: TradeMode,
  weight: number,
): TimeframeView {
  const regime = assessRegime(bars);
  const price = closes(bars);
  const bias = regimeBias(regime.kind);
  const model = markovFromPrices(price);
  const persistence = directionalPersistence(
    model,
    bias === "down" ? "down" : "up",
    MODE_HORIZON_BARS[mode],
  );

  // Distance to the nearest structure, in ATR — a trade entered right under a
  // swing high has far less room than the same signal in open space.
  const last = price[price.length - 1] ?? 0;
  const swingHigh = lastSwing(bars, "high");
  const swingLow = lastSwing(bars, "low");
  const reference = bias === "down" ? swingLow : swingHigh;
  const structureDistanceAtr =
    reference && regime.atr > 0 ? Math.abs(reference.price - last) / regime.atr : 0;

  return {
    timeframe,
    regime,
    bias,
    rsi: rsi(price),
    persistence,
    sampleConfidence: sampleConfidence(model),
    structureDistanceAtr,
    weight,
    contribution: 0,
  };
}

/**
 * Score the alignment of a single timeframe with a proposed direction.
 * Returns a value in [-1, 1].
 */
function scoreView(view: TimeframeView, direction: "up" | "down"): number {
  const { regime } = view;
  let score = 0;

  // 1. Regime agreement, weighted by how confident the classification is.
  if (view.bias === direction) score += 0.45 * regime.confidence;
  else if (view.bias === "neutral") score += 0.05;
  else score -= 0.45 * regime.confidence;

  // 2. Trend quality in the trade's direction.
  const slopeAligned = direction === "up" ? regime.normalisedSlope : -regime.normalisedSlope;
  score += clamp(slopeAligned * 2, -0.25, 0.25);

  // 3. Momentum. RSI is read as a continuation gauge, but overextension in
  //    the trade's own direction is penalised — chasing is not confluence.
  const momentum = direction === "up" ? view.rsi - 50 : 50 - view.rsi;
  score += clamp(momentum / 100, -0.15, 0.15);
  if ((direction === "up" && view.rsi > 78) || (direction === "down" && view.rsi < 22)) {
    score -= 0.1;
  }

  // 4. Markov persistence, discounted by how much data backs it.
  const persistenceAligned = view.bias === direction ? view.persistence : 1 - view.persistence;
  score += (persistenceAligned - 0.5) * 0.3 * view.sampleConfidence;

  // 5. Room to the next structural level.
  score += clamp((view.structureDistanceAtr - 0.5) * 0.08, -0.1, 0.1);

  return clamp(score, -1, 1);
}

export function scoreConfluence(input: {
  symbol: string;
  mode: TradeMode;
  series: Partial<Record<Timeframe, Bar[]>>;
  /** Force a direction (e.g. a manual bias); otherwise it is inferred. */
  direction?: "up" | "down";
}): ConfluenceResult {
  const { symbol, mode, series } = input;
  const weights = MODE_WEIGHTS[mode];
  const warnings: string[] = [];

  const views: TimeframeView[] = [];
  let totalWeight = 0;
  for (const [timeframe, weight] of Object.entries(weights) as [Timeframe, number][]) {
    const bars = series[timeframe];
    if (!bars || bars.length < 30) {
      if (bars) warnings.push(`${timeframe}: only ${bars.length} bars — excluded from scoring.`);
      else warnings.push(`${timeframe}: no data — excluded from scoring.`);
      continue;
    }
    views.push(buildTimeframeView(timeframe, bars, mode, weight));
    totalWeight += weight;
  }

  if (views.length === 0 || totalWeight === 0) {
    return {
      symbol,
      mode,
      direction: "none",
      score: 0,
      grade: "no-trade",
      views: [],
      higherTimeframeAligned: false,
      factors: [],
      warnings: [...warnings, "No timeframe had enough history to score."],
    };
  }

  // Infer direction from the weighted bias vote when not supplied.
  let direction = input.direction;
  if (!direction) {
    let vote = 0;
    for (const view of views) {
      if (view.bias === "up") vote += view.weight * view.regime.confidence;
      else if (view.bias === "down") vote -= view.weight * view.regime.confidence;
    }
    if (Math.abs(vote) < 1e-6) {
      return {
        symbol,
        mode,
        direction: "none",
        score: 0,
        grade: "no-trade",
        views,
        higherTimeframeAligned: false,
        factors: [],
        warnings: [...warnings, "No directional bias — every timeframe is neutral."],
      };
    }
    direction = vote > 0 ? "up" : "down";
  }

  // Weighted mean of per-view alignment, renormalised over the timeframes that
  // actually had data, then mapped from [-1,1] to [0,100].
  let weighted = 0;
  for (const view of views) {
    const raw = scoreView(view, direction);
    view.contribution = (raw * view.weight) / totalWeight;
    weighted += view.contribution;
  }
  const score = clamp((weighted + 1) * 50, 0, 100);

  // Higher-timeframe veto.
  const vetoList = VETO_TIMEFRAMES[mode];
  let higherTimeframeAligned = true;
  for (const view of views) {
    if (!vetoList.includes(view.timeframe)) continue;
    const opposed = view.bias !== "neutral" && view.bias !== direction;
    // Only a *confident* higher-timeframe regime is allowed to veto; a weak
    // classification would block almost every counter-pullback entry.
    if (opposed && view.regime.confidence >= 0.5) {
      higherTimeframeAligned = false;
      warnings.push(
        `${view.timeframe} is ${view.regime.kind} (confidence ${(view.regime.confidence * 100).toFixed(0)}%), opposing a ${direction} trade.`,
      );
    }
  }

  const factors = views
    .slice()
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .map((view) => ({
      label: `${view.timeframe} ${view.regime.kind}`,
      detail:
        `conf ${(view.regime.confidence * 100).toFixed(0)}% · RSI ${view.rsi.toFixed(0)} · ` +
        `persist ${(view.persistence * 100).toFixed(0)}% · ${view.structureDistanceAtr.toFixed(1)} ATR to structure`,
      weight: Number(view.weight.toFixed(3)),
      aligned: view.bias === direction,
    }));

  return {
    symbol,
    mode,
    direction,
    score,
    grade: gradeFor(score, mode),
    views,
    higherTimeframeAligned,
    factors,
    warnings,
  };
}
