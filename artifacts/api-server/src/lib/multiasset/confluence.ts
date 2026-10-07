/**
 * Multi-Asset Desk — multi-timeframe confluence scoring.
 *
 * Each timeframe in the mode's own analysis band is assessed independently and
 * combined with mode-specific weights: a scalper is judged on M1–M3, an
 * intraday book on M5–M30, a swing book on H1–W1.
 *
 * Timeframes OUTSIDE the band are measured as bounded *context*, not scored.
 * Trading against a confidently-opposing higher timeframe costs a capped
 * number of points; it no longer blocks the trade. That change is deliberate:
 * requiring every timeframe to agree meant a scalp could only be taken when
 * the weekly candle happened to be pointing the same way, which is close to
 * never.
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
  /**
   * `analysis` timeframes carry weight in the score. `context` timeframes are
   * measured and displayed but never scored — they frame the trade and can
   * apply a bounded penalty, not a veto.
   */
  role: "analysis" | "context";
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
  /** Signed contribution to the final score. Zero for context timeframes. */
  contribution: number;
}

export interface ConfluenceResult {
  symbol: string;
  mode: TradeMode;
  direction: "up" | "down" | "none";
  /** 0–100, after any higher-timeframe context penalty. */
  score: number;
  /** The score before the context penalty — useful for explaining the split. */
  baseScore: number;
  grade: "A+" | "A" | "B" | "C" | "no-trade";
  views: TimeframeView[];
  /**
   * True when no *confident* context timeframe opposes the direction.
   *
   * This is reported for transparency and is NO LONGER a veto. A
   * counter-trend setup against a weakly-classified weekly candle is a
   * legitimate trade with a smaller position, not a forbidden one.
   */
  higherTimeframeAligned: boolean;
  /** Points deducted for trading against context timeframes. Bounded. */
  contextPenalty: number;
  factors: { label: string; detail: string; weight: number; aligned: boolean }[];
  warnings: string[];
}

/**
 * Timeframe weights per style. They sum to 1 within each mode.
 *
 * The bands are the ones the desk actually trades:
 *
 *   scalp    → M1–M3.  A scalp is opened and closed on sub-3-minute
 *              structure; M5 is already the intraday entry frame.
 *   intraday → M5–M30. Held for hours, not minutes.
 *   swing    → H1–W1.  Held for days, so the weekly candle is part of the
 *              analysis, not an afterthought.
 *
 * Timeframes outside a mode's band are not scored at all — they are measured
 * as bounded *context* (see MODE_CONTEXT_TIMEFRAMES).
 */
export const MODE_WEIGHTS: Record<TradeMode, Partial<Record<Timeframe, number>>> = {
  scalp: { M1: 0.32, M2: 0.36, M3: 0.32 },
  intraday: { M5: 0.28, M15: 0.4, M30: 0.32 },
  swing: { H1: 0.24, H4: 0.3, D1: 0.28, W1: 0.18 },
};

/**
 * Timeframes that frame a trade without scoring it.
 *
 * Context frames apply a bounded penalty when they confidently oppose the
 * direction — enough to make the desk prefer trading with the bigger picture,
 * never enough to block a setup single-handedly.
 */
export const MODE_CONTEXT_TIMEFRAMES: Record<TradeMode, readonly Timeframe[]> = {
  scalp: ["M5", "M15", "H1"],
  intraday: ["H1", "H4", "D1"],
  swing: ["W1"],
};

/** Penalty per confidently opposing context timeframe, and the total cap. */
const CONTEXT_PENALTY_PER_FRAME = 5;
const CONTEXT_PENALTY_CAP = 12;

/**
 * Bars ahead a trade of each style is expected to need, counted on that mode's
 * entry timeframe (M2 / M15 / H1 respectively):
 *
 *   scalp    → 12 × M2  ≈ 25 minutes
 *   intraday → 24 × M15 ≈ 6 hours
 *   swing    → 48 × H1  ≈ 2 days
 */
export const MODE_HORIZON_BARS: Record<TradeMode, number> = {
  scalp: 12,
  intraday: 24,
  swing: 48,
};

/**
 * Score needed to be considered an A+ setup.
 *
 * Lowered from 72/68/65. Those numbers were calibrated when the score was the
 * ONLY quality gate; the desk then piled three hard vetoes on top of it
 * (higher-timeframe alignment, a Markov persistence floor and an expectancy
 * floor), so the effective bar was far higher than any single number suggested
 * and almost nothing got through.
 *
 * Quality is now enforced by the combination — this score, the evidence
 * ensemble's confidence, and the minimum-count-of-independent-agreeing-
 * families rule in agent.ts — which rejects bad setups without requiring
 * unanimity from estimators that are only ever weakly confident.
 */
export const MODE_SCORE_THRESHOLD: Record<TradeMode, number> = {
  scalp: 62,
  intraday: 60,
  swing: 60,
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
  role: "analysis" | "context" = "analysis",
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
    role,
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
      ...emptyResult(symbol, mode, views, warnings, "No timeframe in this mode's band had enough history to score."),
    };
  }

  // ── Context timeframes ────────────────────────────────────────────────────
  // Measured and displayed, never scored. A missing context frame costs
  // nothing: absence of a weekly candle must not be read as a warning.
  const context: TimeframeView[] = [];
  for (const timeframe of MODE_CONTEXT_TIMEFRAMES[mode]) {
    const bars = series[timeframe];
    if (!bars || bars.length < 30) continue;
    context.push(buildTimeframeView(timeframe, bars, mode, 0, "context"));
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
        ...emptyResult(
          symbol,
          mode,
          [...views, ...context],
          warnings,
          "No directional bias — every timeframe in this mode's band is neutral.",
        ),
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
  const baseScore = clamp((weighted + 1) * 50, 0, 100);

  // ── Context penalty (NOT a veto) ──────────────────────────────────────────
  // Trading against a confidently-opposing higher timeframe is *worse*, so it
  // costs points. It is capped so that it can demote a setup but never
  // disqualify one that the mode's own analysis band likes.
  let higherTimeframeAligned = true;
  let contextPenalty = 0;
  for (const view of context) {
    const opposed = view.bias !== "neutral" && view.bias !== direction;
    if (!opposed) continue;
    higherTimeframeAligned = false;
    if (view.regime.confidence >= 0.5) {
      contextPenalty += CONTEXT_PENALTY_PER_FRAME;
      warnings.push(
        `${view.timeframe} is ${view.regime.kind} (confidence ${(view.regime.confidence * 100).toFixed(0)}%), opposing a ${direction} trade — ${CONTEXT_PENALTY_PER_FRAME} point context penalty, not a block.`,
      );
    } else {
      warnings.push(
        `${view.timeframe} leans against this ${direction} trade, but only at ${(view.regime.confidence * 100).toFixed(0)}% confidence — noted, not penalised.`,
      );
    }
  }
  contextPenalty = Math.min(contextPenalty, CONTEXT_PENALTY_CAP);
  const score = clamp(baseScore - contextPenalty, 0, 100);

  const allViews = [...views, ...context];
  const factors = allViews
    .slice()
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .map((view) => ({
      label: view.role === "context" ? `${view.timeframe} ${view.regime.kind} (context)` : `${view.timeframe} ${view.regime.kind}`,
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
    baseScore,
    grade: gradeFor(score, mode),
    views: allViews,
    higherTimeframeAligned,
    contextPenalty,
    factors,
    warnings,
  };
}

function emptyResult(
  symbol: string,
  mode: TradeMode,
  views: TimeframeView[],
  warnings: string[],
  reason: string,
): ConfluenceResult {
  return {
    symbol,
    mode,
    direction: "none",
    score: 0,
    baseScore: 0,
    grade: "no-trade",
    views,
    higherTimeframeAligned: false,
    contextPenalty: 0,
    factors: [],
    warnings: [...warnings, reason],
  };
}
