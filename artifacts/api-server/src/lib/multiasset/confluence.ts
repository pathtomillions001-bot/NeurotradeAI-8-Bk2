/**
 * Multi-Asset Desk — multi-timeframe confluence scoring.
 *
 * Each timeframe in the mode's own analysis band is assessed independently and
 * combined with mode-specific weights.
 *
 * THE BAND IS THE WHOLE MONITORING WINDOW (and it is exclusive)
 *
 *   scalp    → S10 … M3    ten seconds up to three minutes
 *   intraday → M5 … M30    five minutes to half an hour
 *   swing    → H1 … W1     one hour to the weekly candle
 *
 * Nothing outside a mode's band is scored, required or penalised. That is a
 * deliberate change from the previous design, which scored the band but
 * measured the frames *outside* it as "context" and deducted up to 12 points
 * when a slower frame leaned the other way. Two things were wrong with that:
 *
 *   1. A scalp is not a slower decision with a penalty attached. Letting an
 *      hourly candle demote a ten-second setup meant the mode was quietly
 *      trading its own band *minus* an opinion it was never supposed to hold.
 *   2. For swing the context frame was W1 — which is already inside the swing
 *      band, so the weekly candle was scored AND penalised. The same frame
 *      counted twice.
 *
 * If the band has no usable history (a terminal that has not seeded every
 * frame yet), the score is computed from the NEAREST available frames instead
 * of collapsing to zero, and the substitution is named in `warnings` and
 * flagged on the result. A data gap must read as a data gap, not as a
 * catastrophically bad market.
 *
 * The output is a 0–100 score, a grade, and — importantly — the per-factor
 * breakdown that the terminal renders so the user can see *why* the agent
 * does or does not like a trade.
 */

import { assessRegime, regimeBias, type RegimeAssessment } from "./regime";
import { closes, clamp, lastSwing, linreg, rsi } from "./math";
import { directionalPersistence, markovFromPrices, sampleConfidence } from "./markov";
import { ALL_TIMEFRAMES, MODE_ANALYSIS_TIMEFRAMES, type Bar, type Timeframe, type TradeMode } from "./types";

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
  /** Points deducted for trading against frames outside the band. Now always 0. */
  contextPenalty: number;
  /**
   * True when the mode's own band had no scorable history and the score was
   * computed from the nearest available frames instead. Named in `warnings`.
   */
  substituted: boolean;
  /** Frames actually weighted in the score, fastest first. */
  scoredTimeframes: Timeframe[];
  factors: { label: string; detail: string; weight: number; aligned: boolean }[];
  warnings: string[];
}

/**
 * Timeframe weights per style. They sum to 1 within each mode.
 *
 *   scalp    → S10, S30, M1, M2, M3.  A scalp lives inside three minutes. The
 *              sub-minute frames carry the most weight because they are the
 *              structure the entry and the stop are actually placed against;
 *              M3 is the slowest frame that may still influence it. M5 is NOT
 *              part of a scalp — it is the intraday entry frame.
 *   intraday → M5–M30. Held for hours, not minutes.
 *   swing    → H1–W1.  Held for days, so the weekly candle is part of the
 *              analysis, not an afterthought.
 */
export const MODE_WEIGHTS: Record<TradeMode, Partial<Record<Timeframe, number>>> = {
  scalp: { S10: 0.24, S30: 0.24, M1: 0.22, M2: 0.18, M3: 0.12 },
  intraday: { M5: 0.28, M15: 0.4, M30: 0.32 },
  swing: { H1: 0.24, H4: 0.3, D1: 0.28, W1: 0.18 },
};

/**
 * Frames outside a mode's band. Intentionally empty for every mode.
 *
 * Kept as a named constant — rather than deleted — because the *pipeline* for
 * out-of-band frames is still exercised by the type and by the result shape,
 * and because "no context frames" is a decision worth stating rather than an
 * absence someone has to infer. See the module header for why.
 */
export const MODE_CONTEXT_TIMEFRAMES: Record<TradeMode, readonly Timeframe[]> = {
  scalp: [],
  intraday: [],
  swing: [],
};

/** Penalty per confidently opposing context timeframe, and the total cap. */
const CONTEXT_PENALTY_PER_FRAME = 5;
const CONTEXT_PENALTY_CAP = 12;

/** Bars a frame needs before it may be scored. */
export const MIN_BARS_PER_FRAME = 30;

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

/**
 * Frames to score, in priority order.
 *
 * The mode's own band first. When the band cannot be scored at all — the EA has
 * not seeded those frames yet, or (for S10/S30) the tick feed is not dense
 * enough to build them honestly — the NEAREST frames by timeframe distance are
 * used instead, so a missing frame degrades the score's precision rather than
 * zeroing it. Using a substituted frame is always recorded.
 *
 * Order within the band is fastest-first (the band arrays are ordered that
 * way), so the returned list is also the order the terminal shows.
 */
export function resolveScoringFrames(
  mode: TradeMode,
  series: Partial<Record<Timeframe, Bar[]>>,
): { frames: Timeframe[]; substituted: boolean; excluded: Timeframe[] } {
  const band = MODE_ANALYSIS_TIMEFRAMES[mode];
  const usable = (timeframe: Timeframe) => {
    const bars = series[timeframe];
    return Boolean(bars && bars.length >= MIN_BARS_PER_FRAME);
  };

  const inBand = band.filter(usable);
  if (inBand.length > 0) {
    return { frames: [...inBand], substituted: false, excluded: band.filter((tf) => !inBand.includes(tf)) };
  }

  // Nothing in the band: borrow the nearest frames that do have history.
  const anchor = ALL_TIMEFRAMES.indexOf(band[0] as Timeframe);
  const borrowed = ALL_TIMEFRAMES
    .map((timeframe, index) => ({ timeframe, distance: Math.abs(index - anchor) }))
    .filter((entry) => usable(entry.timeframe))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(1, band.length))
    .map((entry) => entry.timeframe)
    .sort((a, b) => ALL_TIMEFRAMES.indexOf(a) - ALL_TIMEFRAMES.indexOf(b));

  return { frames: borrowed, substituted: borrowed.length > 0, excluded: [...band] };
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

  const resolution = resolveScoringFrames(mode, series);
  if (resolution.substituted) {
    warnings.push(
      `No frame in this mode's band (${MODE_ANALYSIS_TIMEFRAMES[mode].join(", ")}) had ${MIN_BARS_PER_FRAME}+ bars, ` +
        `so the nearest available frames were scored instead: ${resolution.frames.join(", ")}. ` +
        `This is a data-coverage gap on the terminal, not a property of the market.`,
    );
  }
  for (const timeframe of resolution.excluded) {
    const bars = series[timeframe];
    if (bars) warnings.push(`${timeframe}: only ${bars.length} bars — excluded from scoring.`);
    else warnings.push(`${timeframe}: no data — excluded from scoring.`);
  }

  const views: TimeframeView[] = [];
  let totalWeight = 0;
  for (const timeframe of resolution.frames) {
    const bars = series[timeframe];
    if (!bars || bars.length < MIN_BARS_PER_FRAME) continue;
    // Renormalise the mode's weights over the frames that are actually present,
    // so a missing frame lowers precision rather than the whole score.
    const weight = weights[timeframe] ?? 1 / resolution.frames.length;
    views.push(buildTimeframeView(timeframe, bars, mode, weight));
    totalWeight += weight;
  }

  if (views.length === 0 || totalWeight === 0) {
    return {
      ...emptyResult(
        symbol,
        mode,
        views,
        warnings,
        `${MODE_ANALYSIS_TIMEFRAMES[mode].join("/")} has no history at all yet — the terminal has not seeded this market.`,
      ),
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
    substituted: resolution.substituted,
    scoredTimeframes: views.map((view) => view.timeframe),
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
    substituted: false,
    scoredTimeframes: [],
    factors: [],
    warnings: [...warnings, reason],
  };
}
