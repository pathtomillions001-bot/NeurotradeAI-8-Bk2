/**
 * Multi-Asset Desk — the agent.
 *
 * Pipeline, in order, with a veto at every stage:
 *
 *   candles ──▶ regime (per timeframe)
 *           ──▶ Markov persistence
 *           ──▶ multi-timeframe confluence  ─── direction + score
 *           ──▶ structural stop placement
 *           ──▶ Monte Carlo target search   ─── P(win), expectancy after costs
 *           ──▶ risk governor               ─── allowed? how much?
 *           ──▶ sizing engine               ─── lots from the broker's spec
 *           ──▶ ArmedPlan + ManagementPlan
 *
 * The output is never "buy now" — it is a plan with a trigger the EA watches
 * locally, so the decision survives the network round trip. And a no-trade is
 * a first-class result: it carries the reasons, which the terminal displays.
 */

import { randomUUID } from "node:crypto";
import { atr, clamp, closes, hashSeed, lastSwing, logReturns } from "./math";
import { costPolicyFor, fillSpreadGuard, slippageAllowancePoints, spreadIsNotable } from "./asset-costs";
import {
  resolveScoringFrames,
  scoreConfluence,
  MODE_HORIZON_BARS,
  MODE_SCORE_THRESHOLD,
  type ConfluenceResult,
} from "./confluence";
import { buildEvidence, MODE_MIN_AGREEING_FAMILIES, type EvidenceResult } from "./evidence";
import { markovFromPrices, directionalPersistence, sampleConfidence } from "./markov";
import { betaPosterior, blendProbability, garchVolatility } from "./analytics";
import { assessRegime, isRegimeTradeable } from "./regime";
import { bestTarget, simulateTrade, type MonteCarloResult } from "./montecarlo";
import { evaluateRisk, type RiskDecision, type RiskPolicy, type RiskState } from "./risk";
import { kellyFraction, pointValuePerLot, priceToPoints, sizePosition, type SizingResult } from "./sizing";
import { assessNewsGate, type NewsGate } from "./news";
import {
  MODE_ANALYSIS_TIMEFRAMES,
  TIMEFRAME_MINUTES,
  type AccountSnapshot,
  type ArmedPlan,
  type Bar,
  type ManagementPlan,
  type NewsFeed,
  type Position,
  type Quote,
  type SymbolSpec,
  type Timeframe,
  type TradeMode,
} from "./types";

export interface AgentInput {
  symbol: string;
  mode: TradeMode;
  spec: SymbolSpec;
  quote: Quote;
  series: Partial<Record<Timeframe, Bar[]>>;
  account: AccountSnapshot;
  positions: Position[];
  specs: Map<string, SymbolSpec>;
  riskState: RiskState;
  policy?: Partial<RiskPolicy>;
  /** MT5 high-impact calendar status. Missing/unavailable fails new entries closed. */
  news?: NewsFeed | null;
  now?: number;
  /** Minimum expectancy (in R, after costs) required to arm. */
  minEdgeR?: number;
  /**
   * Minimum Markov persistence of the favourable state over the horizon.
   * Defaults to 0 (advisory only) — see DEFAULT_MIN_PERSISTENCE.
   */
  minPersistence?: number;
  /**
   * Realised win/loss counts for this symbol and mode, used as the Beta prior
   * when blending the simulated win probability with what actually happens on
   * this desk. Absent means "no history yet", which leans entirely on the
   * simulation.
   */
  outcomes?: { wins: number; losses: number };
  /** Force the evidence ensemble's direction instead of inferring it. */
  direction?: "up" | "down";
}

export interface AgentDecision {
  symbol: string;
  mode: TradeMode;
  armed: boolean;
  plan: ArmedPlan | null;
  confluence: ConfluenceResult;
  /** The statistical evidence ensemble. Present whenever bars were available. */
  evidence: EvidenceResult | null;
  /** Blended confluence/evidence quality score actually gated on. */
  qualityScore: number;
  qualityThreshold: number;
  /**
   * Blended win probability and expectancy after costs, in R.
   *
   * These are the numbers the edge gate actually enforces (simulation blended
   * with the desk's realised history on this symbol). They are surfaced on the
   * decision so ranking engines — the automatic best-market pass and the
   * scanner — rank on precisely what was gated on, instead of re-deriving an
   * approximation from the raw simulation.
   */
  expectancyR: number | null;
  winProbability: number | null;
  monteCarlo: MonteCarloResult | null;
  sizing: SizingResult | null;
  risk: RiskDecision;
  /** Red-folder calendar gate evaluated with this decision. */
  news: NewsGate;
  /** Every gate that failed, in evaluation order. Shown verbatim in the UI. */
  rejections: string[];
  /** Non-blocking cautions that were recorded but did not stop the trade. */
  warnings: string[];
  /** Short machine-readable summary for the signal log. */
  summary: string;
  evaluatedAt: number;
}

/**
 * Entry timeframe used for stop placement and horizons, per style.
 *
 * These sit inside each mode's analysis band by construction:
 *   scalp → M2 (inside S10–M3; the 2-minute frame is where a scalp stop has
 *            enough range to survive a spread but is still a scalp's stop)
 *   intraday → M15 (the middle of M5–M30)
 *   swing → H1 (the fast end of H1–W1, where a swing stop belongs)
 */
const ENTRY_TIMEFRAME: Record<TradeMode, Timeframe> = {
  scalp: "M2",
  intraday: "M15",
  swing: "H1",
};

/**
 * ATR multiple for the initial structural stop, per style.
 *
 * A scalp's stop must be reachable in minutes or the trade is not a scalp, so
 * it is the tightest; a swing stop has to survive a full session of noise.
 */
const STOP_ATR_MULT: Record<TradeMode, number> = {
  scalp: 0.8,
  intraday: 1.5,
  swing: 2.0,
};

/**
 * How long an armed plan stays valid, per style.
 *
 * A scalp that has not filled in 60 seconds is no longer the setup that was
 * analysed — the micro-structure it depended on has already moved on.
 */
const PLAN_TTL_MS: Record<TradeMode, number> = {
  scalp: 60_000,
  intraday: 10 * 60_000,
  swing: 60 * 60_000,
};

/**
 * How much of the final quality score comes from the evidence ensemble rather
 * than from multi-timeframe confluence. The two measure different things —
 * confluence measures agreement across horizons, the ensemble measures the
 * balance of independent statistical evidence on the entry timeframe — so
 * neither alone should decide.
 */
const MODE_EVIDENCE_BLEND: Record<TradeMode, number> = {
  scalp: 0.55,
  intraday: 0.45,
  swing: 0.4,
};

export const DEFAULT_MIN_EDGE_R = 0.15;

/**
 * Markov persistence floor.
 *
 * ZERO BY DEFAULT — and that is the point. This used to be 0.55 and acted as a
 * hard veto, which meant a five-state chain fitted to a couple of hundred bars
 * could (and constantly did) overrule every other estimator in the pipeline.
 * Persistence is now one weighted vote among seven in evidence.ts; its
 * uncertainty is handled by shrinking its influence, not by letting it block.
 *
 * A caller that explicitly raises this value still gets the hard floor — that
 * is how the offline research harness isolates price logic from regime logic.
 */
export const DEFAULT_MIN_PERSISTENCE = 0;

/** Below this, persistence is surfaced as a caution rather than a failure. */
const PERSISTENCE_ADVISORY = 0.45;

/**
 * Resolve the series the evidence ensemble and the structural stop are built on.
 *
 * Preference order: the frames the confluence actually scored (so the two
 * halves of the quality score describe the same market), then the entry frame,
 * then the mode's band, then outward to the slower frames the terminal is most
 * likely to have seeded. Substitution is normal and is reported by the caller.
 */
function firstAvailable(
  series: Partial<Record<Timeframe, Bar[]>>,
  preferred: Timeframe,
  mode: TradeMode,
  scoredFrames: Timeframe[] = [],
): { timeframe: Timeframe; bars: Bar[] } | null {
  const band = MODE_ANALYSIS_TIMEFRAMES[mode];
  const order: Timeframe[] = [
    ...scoredFrames,
    preferred,
    ...band,
    "M5",
    "M15",
    "M30",
    "M1",
    "M2",
    "M3",
    "H1",
    "H4",
    "D1",
  ];
  const seen = new Set<Timeframe>();
  for (const tf of order) {
    if (seen.has(tf)) continue;
    seen.add(tf);
    const bars = series[tf];
    if (bars && bars.length >= 30) return { timeframe: tf, bars };
  }
  return null;
}

/**
 * Structural stop: beyond the last swing against the trade, with an ATR
 * buffer so ordinary noise does not reach it. Falls back to a pure ATR stop
 * when no swing is visible.
 *
 * Stops are placed where the idea is *wrong*, never at a round number of pips
 * chosen to make the lot size comfortable.
 */
export function structuralStop(
  bars: Bar[],
  side: "buy" | "sell",
  entry: number,
  mode: TradeMode,
): { sl: number; atrValue: number; usedSwing: boolean } {
  const atrValue = atr(bars, 14);
  const mult = STOP_ATR_MULT[mode];
  const buffer = atrValue * 0.25;

  const swing = lastSwing(bars, side === "buy" ? "low" : "high");
  if (swing && atrValue > 0) {
    const candidate = side === "buy" ? swing.price - buffer : swing.price + buffer;
    // THE SIDE IS CHECKED, NOT JUST THE DISTANCE.
    //
    // The last confirmed swing is not always on the correct side of the live
    // price: after a breakdown the most recent swing LOW sits ABOVE the market,
    // and for a buy that produced a "stop" above the entry. Because the guard
    // below only looked at |distance|, that placement passed and the plan was
    // handed to sizing, which refused it with "Stop loss … is on the wrong side
    // of entry … for a buy" — a whole analysis window thrown away on a stop
    // that could never have protected anything.
    //
    // `signed` is the distance in the direction the stop is supposed to be:
    // positive means the candidate is genuinely beyond the entry.
    const signed = side === "buy" ? entry - candidate : candidate - entry;
    const distance = Math.abs(signed);
    // Reject a swing that is on the wrong side, implausibly close, or far;
    // fall back to the ATR stop, which is correct by construction.
    if (signed > 0 && distance >= atrValue * 0.5 && distance <= atrValue * mult * 2.5) {
      return { sl: candidate, atrValue, usedSwing: true };
    }
  }

  const fallback = side === "buy" ? entry - atrValue * mult : entry + atrValue * mult;
  return { sl: fallback, atrValue, usedSwing: false };
}

/**
 * Build the management plan.
 *
 * Thresholds are regime-dependent, not fixed: a trending market is given room
 * and a trailing stop, a range is banked earlier at the band edge. Partial
 * ladders are feasibility-checked against the broker's volume step, because a
 * 50% close of 0.01 lots is not a legal order.
 */
export function buildManagementPlan(input: {
  spec: SymbolSpec;
  mode: TradeMode;
  lots: number;
  regimeKind: string;
  atrPoints: number;
  retraceProbability: number;
}): ManagementPlan {
  const { spec, mode, lots, regimeKind, atrPoints, retraceProbability } = input;
  const trending = regimeKind === "trend_up" || regimeKind === "trend_down";

  // A partial is only real if the remaining and closed slices are both legal
  // volumes. Otherwise the ladder silently fails at the broker.
  const step = spec.volumeStep > 0 ? spec.volumeStep : 0.01;
  const canSplit = (pct: number) => {
    const slice = lots * (pct / 100);
    const quantised = Math.floor(slice / step + 1e-9) * step;
    return quantised >= spec.volumeMin && lots - quantised >= spec.volumeMin;
  };

  const desired = trending
    ? [
        { atR: 1.5, closePct: 35 },
        { atR: 3.0, closePct: 25 },
      ]
    : [
        { atR: 1.0, closePct: 50 },
        { atR: 1.8, closePct: 25 },
      ];
  const partials = desired.filter((p) => canSplit(p.closePct));

  // Breakeven is only scheduled once the simulated probability of coming back
  // to entry is low. Blind BE-at-1R scratches winners on volatile symbols.
  const breakeven =
    retraceProbability <= 0.35
      ? { triggerR: trending ? 1.2 : 1.0, offsetR: 0.2, structureBuffer: true }
      : { triggerR: trending ? 1.8 : 1.5, offsetR: 0.1, structureBuffer: true };

  return {
    breakeven,
    partials,
    // Trail in trends (let winners run); hard TP in ranges.
    trail: trending
      ? {
          mode: "atr_chandelier",
          period: 14,
          mult: mode === "scalp" ? 2.0 : 2.5,
          activateAtR: 1.2,
          stepPoints: Math.max(5, Math.round(atrPoints * 0.1)),
        }
      : null,
    // Pyramiding is allowed only in a confirmed trend, only once the base is
    // risk-free, and never above the original portfolio risk budget.
    pyramid: trending
      ? {
          maxAdds: mode === "swing" ? 2 : 1,
          addAtR: 1.5,
          sizeRatio: 0.5,
          requireBaseAtBreakeven: true,
          portfolioRiskCapR: 1.5,
        }
      : null,
    timeStop: {
      noProgressBars: mode === "scalp" ? 15 : 25,
      timeframe: ENTRY_TIMEFRAME[mode],
    },
    guards: {
      // Derived from the asset class and the stop, exactly like the plan-level
      // guard the EA enforces, so the two can never disagree.
      maxSpreadPoints: fillSpreadGuard(spec, atrPoints * (STOP_ATR_MULT[mode] ?? 1), spec.spreadPoints),
      newsBlackoutMin: mode === "scalp" ? 10 : 15,
      flatBeforeSessionClose: mode !== "swing",
    },
  };
}

export function evaluate(input: AgentInput): AgentDecision {
  const now = input.now ?? Date.now();
  const minEdgeR = input.minEdgeR ?? DEFAULT_MIN_EDGE_R;
  const minPersistence = input.minPersistence ?? DEFAULT_MIN_PERSISTENCE;
  const rejections: string[] = [];
  const warnings: string[] = [];

  /**
   * Build a no-trade decision.
   *
   * Declared as a hoisted function so the early exits can use it before the
   * evidence ensemble exists. `ev`/`score` are only resolved when supplied,
   * which keeps the pre-ensemble paths from touching values that are not
   * initialised yet.
   */
  function fail(
    extra: string[] = [],
    ev?: EvidenceResult | null,
    score?: number,
  ): AgentDecision {
    const usedEvidence = ev ?? null;
    const blend = MODE_EVIDENCE_BLEND[input.mode];
    const usedScore =
      score ??
      (usedEvidence && usedEvidence.direction !== "none"
        ? (1 - blend) * confluence.score + blend * usedEvidence.confidence
        : confluence.score);
    const usedThreshold = MODE_SCORE_THRESHOLD[input.mode] + risk.scoreBump;
    return {
      symbol: input.symbol,
      mode: input.mode,
      armed: false,
      plan: null,
      confluence,
      evidence: usedEvidence,
      qualityScore: usedScore,
      qualityThreshold: usedThreshold,
      expectancyR: null,
      winProbability: null,
      monteCarlo: null,
      sizing: null,
      risk,
      news,
      rejections: [...rejections, ...extra],
      warnings,
      summary: `${input.symbol} ${input.mode}: no trade (quality ${usedScore.toFixed(0)}/${usedThreshold.toFixed(0)}).`,
      evaluatedAt: now,
    };
  }

  // ── 1. Risk governor first ────────────────────────────────────────────────
  // Running it before the analysis avoids burning CPU on a symbol that is
  // halted, suspended or over-exposed — and makes the reason the FIRST thing
  // the user sees rather than a footnote under a signal they cannot take.
  const risk = evaluateRisk({
    symbol: input.symbol,
    spec: input.spec,
    account: input.account,
    positions: input.positions,
    specs: input.specs,
    state: input.riskState,
    policy: input.policy,
    now,
  });
  rejections.push(...risk.breaches);

  // ── 2. Red-folder calendar ────────────────────────────────────────────────
  // The terminal's MT5 economic calendar is authoritative. An unavailable or
  // stale calendar is a safety failure, not a green light, so fresh entries
  // are paused until the terminal can confirm the event schedule again.
  // Pure-agent callers (unit tests and offline research) can omit `news` to
  // evaluate price logic in isolation. The live Desk always supplies its MT5
  // feed; an explicitly unavailable feed then fails closed below.
  const news = input.news === undefined
    ? { status: "clear" as const, blocked: false, reason: null, relevantEvents: [], checkedAt: now }
    : assessNewsGate(input.spec, input.news, input.mode, now);
  if (news.blocked && news.reason) rejections.push(news.reason);

  // ── 3. Multi-timeframe confluence ─────────────────────────────────────────
  const confluence = scoreConfluence({
    symbol: input.symbol,
    mode: input.mode,
    series: input.series,
    direction: input.direction,
  });

  // ── 3b. Entry timeframe, evidence ensemble ────────────────────────────────
  // The ensemble needs the entry series, so resolve it before scoring. The
  // frames the confluence scored come first so both halves of the quality
  // score describe the same market.
  const entrySeries = firstAvailable(
    input.series,
    ENTRY_TIMEFRAME[input.mode],
    input.mode,
    confluence.scoredTimeframes,
  );
  if (!entrySeries) {
    return fail(["No timeframe has the 30+ bars needed to place a stop on this market."]);
  }
  const horizon = MODE_HORIZON_BARS[input.mode];
  const direction = confluence.direction === "none" ? undefined : confluence.direction;
  const evidence = buildEvidence({
    symbol: input.symbol,
    mode: input.mode,
    timeframe: entrySeries.timeframe,
    bars: entrySeries.bars,
    horizon,
    direction,
  });

  // Blend the two quality views. When the ensemble could not form a direction
  // we fall back to confluence alone rather than scoring zero evidence twice.
  const blendWeight = MODE_EVIDENCE_BLEND[input.mode];
  const evidenceUsable = evidence.direction !== "none";
  const effectiveDirection = confluence.direction !== "none" ? confluence.direction : evidence.direction;
  const qualityScore = evidenceUsable
    ? (1 - blendWeight) * confluence.score + blendWeight * evidence.confidence
    : confluence.score;
  const threshold = MODE_SCORE_THRESHOLD[input.mode] + risk.scoreBump;

  if (effectiveDirection === "none") {
    return fail(["No directional bias from either the timeframe band or the evidence ensemble."]);
  }

  // ── 3c. Quality gate ──────────────────────────────────────────────────────
  // Two independent conditions, neither of them a single-model veto:
  //   1. the blended score must clear the bar;
  //   2. enough *independent* families must agree — not all of them.
  if (qualityScore < threshold) {
    rejections.push(
      `Quality ${qualityScore.toFixed(1)} is below the ${threshold.toFixed(1)} required for a ${input.mode} entry ` +
        `(confluence ${confluence.score.toFixed(1)}, evidence ${evidenceUsable ? evidence.confidence.toFixed(1) : "n/a"}).`,
    );
  }

  if (evidenceUsable && evidence.agreeingFamilies < MODE_MIN_AGREEING_FAMILIES[input.mode]) {
    rejections.push(
      `Only ${evidence.agreeingFamilies} of ${evidence.totalFamilies} evidence families agree on ${effectiveDirection}; ` +
        `${MODE_MIN_AGREEING_FAMILIES[input.mode]} independent confirmations are required.`,
    );
  }

  // Higher-timeframe context is a WARNING now, never a block.
  if (!confluence.higherTimeframeAligned) {
    warnings.push(
      `Trading against context (${confluence.contextPenalty.toFixed(0)} point penalty applied): ` +
        `${confluence.warnings.filter((w) => w.includes("opposing")).join(" ") || "a higher timeframe leans the other way"}.`,
    );
  }

  // ── 3d. Regime and stop ───────────────────────────────────────────────────
  const regime = assessRegime(entrySeries.bars);
  if (!isRegimeTradeable(regime.kind, input.mode)) {
    rejections.push(
      `${entrySeries.timeframe} regime is ${regime.kind} — not tradeable in ${input.mode} mode.`,
    );
  }

  const side = effectiveDirection === "up" ? "buy" : "sell";
  // Enter at the price we would actually pay, not the mid.
  const entry = side === "buy" ? input.quote.ask : input.quote.bid;
  if (!(entry > 0)) return fail(["No live quote for this symbol."]);

  const stop = structuralStop(entrySeries.bars, side, entry, input.mode);
  if (!(Math.abs(entry - stop.sl) > 0)) {
    return fail(["Stop placement produced a zero-distance stop (flat market)."]);
  }

  // ── 4. Markov persistence — one vote, not a veto ──────────────────────────
  const price = closes(entrySeries.bars);
  const model = markovFromPrices(price);
  const persistence = directionalPersistence(model, effectiveDirection, horizon);
  const modelConfidence = sampleConfidence(model);

  if (persistence < minPersistence) {
    rejections.push(
      `Markov persistence of the favourable state is ${(persistence * 100).toFixed(0)}% over ${horizon} bars, below the ${(minPersistence * 100).toFixed(0)}% floor.`,
    );
  } else if (persistence < PERSISTENCE_ADVISORY) {
    // Surfaced, not enforced: the ensemble already priced this in.
    warnings.push(
      `Markov persistence is only ${(persistence * 100).toFixed(0)}% over ${horizon} bars — carried by ${evidence.agreeingFamilies} other agreeing families.`,
    );
  }

  // ── 5. Monte Carlo target search ──────────────────────────────────────────
  const returns = logReturns(price);
  const pointValue = pointValuePerLot(input.spec);
  const riskPrice = Math.abs(entry - stop.sl);
  const costPolicy = costPolicyFor(input.spec);

  // THE LIVE SPREAD IS THE TRUTH, NOT THE SPEC'S CACHED COPY.
  //
  // `spec.spreadPoints` is refreshed on every heartbeat, so in the live Desk the
  // two agree — but the spread the fill will actually pay is the one on the
  // quote being analysed, and a plan armed on a calm tick must not be costed at
  // yesterday's spread. Anywhere the two differ, the quote wins.
  const liveSpreadPoints =
    input.quote.spreadPoints > 0 ? input.quote.spreadPoints : input.spec.spreadPoints;
  const specForSizing =
    liveSpreadPoints === input.spec.spreadPoints
      ? input.spec
      : { ...input.spec, spreadPoints: liveSpreadPoints };

  // Cost expressed in PRICE units so it can be compared with the stop
  // distance: spread crossed once, commission converted via point value, plus
  // an allowance for slippage. Slippage is scaled by asset class — a crypto
  // CFD does not fill like a major FX pair.
  const slippagePoints = slippageAllowancePoints(input.spec, input.mode);
  const commissionPoints = pointValue > 0 ? input.spec.commissionPerLot / pointValue : 0;
  const costPrice = (liveSpreadPoints + commissionPoints + slippagePoints) * input.spec.point;

  const seed = hashSeed(`${input.symbol}|${input.mode}|${entrySeries.timeframe}|${entrySeries.bars.length}`);

  // Volatility for the simulation: the regime's own step volatility, widened
  // toward the GARCH one-step-ahead estimate. Volatility clusters, and a
  // target searched on a calm day's sigma is a target that gets run over.
  const garchSigma = garchVolatility(returns);
  const simulationVolatility = Math.max(
    regime.stepVolatility,
    garchSigma > 0 ? Math.min(garchSigma, regime.stepVolatility * 2.5) : regime.stepVolatility,
  );

  const search = bestTarget({
    entry,
    sl: stop.sl,
    side,
    // Blend the measured drift with the Markov view, scaled by how much data
    // backs the model. With little history the simulation leans on raw drift.
    drift: regime.drift * (0.5 + 0.5 * modelConfidence),
    volatility: simulationVolatility,
    horizon,
    returns,
    costPrice,
    paths: 3000,
    seed,
  });

  if (!search) return fail(["Monte Carlo could not evaluate this setup."]);
  const monteCarlo = search.result;

  // ── 5b. Bayesian blend of simulated and realised win probability ──────────
  // The simulation assumes the model is right. The desk's own history is the
  // only evidence about whether it is right *on this symbol*, so the two are
  // combined with a Beta–Binomial posterior that only earns influence once
  // there are enough trades to mean something.
  const posterior = input.outcomes
    ? blendProbability(
        monteCarlo.winProbability,
        betaPosterior(input.outcomes.wins, input.outcomes.losses),
        0.35,
      )
    : { probability: monteCarlo.winProbability, source: "model" };
  const blendedWinProbability = posterior.probability;
  if (posterior.source === "model+realised") {
    warnings.push(
      `Win probability blended with realised history (${input.outcomes?.wins ?? 0}W/${input.outcomes?.losses ?? 0}L): ` +
        `model ${(monteCarlo.winProbability * 100).toFixed(0)}% → ${(blendedWinProbability * 100).toFixed(0)}%.`,
    );
  }

  // Expectancy recomputed on the blended probability: this is the number the
  // edge gate actually enforces, so a symbol that under-delivers live stops
  // passing on a simulation that flatters it.
  const effectiveExpectancyR =
    blendedWinProbability * monteCarlo.rewardRisk -
    (1 - blendedWinProbability) +
    (monteCarlo.expectancyR - monteCarlo.grossExpectancyR);

  if (effectiveExpectancyR < minEdgeR) {
    rejections.push(
      `Expectancy after costs is ${effectiveExpectancyR.toFixed(2)}R (model ${monteCarlo.expectancyR.toFixed(2)}R, gross ${monteCarlo.grossExpectancyR.toFixed(2)}R), below the ${minEdgeR}R minimum.`,
    );
  }

  // ── 6. Spread: measured, priced, and judged against its own asset class ───
  //
  // The old gate here compared the live spread with `spec.spreadPoints * 2` —
  // and `spec.spreadPoints` IS the live spread (the heartbeat writes it on
  // every tick), so the ceiling could never be crossed. It was dead code that
  // looked like a safety check.
  //
  // There is now exactly one cost decision, and it is asset-class aware:
  //   • the spread is priced into the Monte-Carlo cost term above, so the
  //     expectancy gate (minEdgeR) is measured net of it;
  //   • sizing refuses when spread + commission exceed the asset class's
  //     fraction of the money risked, and when the spread alone exceeds the
  //     class's fraction of the stop distance;
  //   • here, a spread that is wide *for its own asset class* is recorded as a
  //     caution with the number that matters, so it is visible without being a
  //     second, arbitrary veto stacked on top of those two.
  const spreadPoints = liveSpreadPoints;
  const stopPoints = input.spec.point > 0 ? riskPrice / input.spec.point : 0;
  if (stopPoints > 0 && spreadPoints > 0) {
    const spreadFraction = spreadPoints / stopPoints;
    if (spreadIsNotable(input.spec, spreadFraction)) {
      warnings.push(
        `Spread ${spreadPoints} pts is ${(spreadFraction * 100).toFixed(0)}% of the ${stopPoints.toFixed(0)}-pt stop — ` +
          `wide for ${input.spec.assetClass} (ceiling ${(costPolicy.maxSpreadFractionOfStop * 100).toFixed(0)}%). ` +
          `It is charged in the expectancy above rather than blocking the trade on its own.`,
      );
    }
  }

  // Fill-time guard sent to the EA: how far the spread may widen between arming
  // and firing. Expressed against the STOP, not in absolute points, because a
  // point means something different on every asset class — and floored above
  // the spread we actually measured so a normal tick cannot block the fill.
  const maxSpreadPoints = fillSpreadGuard(input.spec, stopPoints, spreadPoints);

  // ── 7. Edge-aware sizing ──────────────────────────────────────────────────
  // Risk scales with measured edge (fractional Kelly) and with how confident
  // the regime call is — never with recent losses.
  //
  // Kelly is driven by the BLENDED win probability: a strategy that looks
  // great in simulation but has been losing on this desk must shrink, and one
  // that has been delivering may grow — within the policy ceiling.
  const kelly = kellyFraction(blendedWinProbability, monteCarlo.rewardRisk, 0.25);
  const edgeScale = clamp(kelly * 10, 0.35, 1.5);
  const riskPct = clamp(
    risk.riskPct * edgeScale * clamp(0.6 + 0.4 * regime.confidence, 0.6, 1),
    0.05,
    risk.riskPct * 1.5,
  );

  // The trigger is a small displacement beyond the current price in the trade
  // direction: the EA fires when the market confirms the move rather than at
  // whatever price happened to exist when the server finished thinking.
  const triggerOffset = stop.atrValue * (input.mode === "scalp" ? 0.08 : 0.12);
  const trigger = side === "buy" ? entry + triggerOffset : entry - triggerOffset;
  const invalidate =
    side === "buy" ? entry - stop.atrValue * 0.6 : entry + stop.atrValue * 0.6;

  // Size against the TRIGGER, not the current quote.
  //
  // The stop is structural and fixed, so firing at the trigger puts the fill
  // `triggerOffset` further from it than the quote was. Sizing off `entry`
  // therefore under-states the real stop distance and silently risks more than
  // the budget — ~8% more on an intraday plan, and up to ~16% on a scalp where
  // a 0.08 ATR offset sits against a 0.5 ATR minimum stop. Risk has to be
  // measured from the price we actually expect to pay.
  const sizing = sizePosition({
    spec: specForSizing,
    side,
    entry: trigger,
    sl: stop.sl,
    tp: search.tp,
    equity: input.account.equity,
    freeMargin: input.account.freeMargin,
    usedMargin: input.account.margin,
    riskPct,
    leverage: input.account.leverage,
    // Cost ceilings come from the symbol's own asset class. A crypto CFD is
    // not held to a major-FX spread standard.
    limits: {
      maxCostFractionOfRisk: costPolicy.maxCostFractionOfRisk,
      maxSpreadFractionOfStop: costPolicy.maxSpreadFractionOfStop,
    },
  });

  if (!sizing.ok) rejections.push(sizing.explanation);

  // ── 8. Arm, or explain ────────────────────────────────────────────────────
  if (rejections.length > 0 || !sizing.ok) {
    return {
      symbol: input.symbol,
      mode: input.mode,
      armed: false,
      plan: null,
      confluence,
      evidence,
      qualityScore,
      qualityThreshold: threshold,
      expectancyR: Number(effectiveExpectancyR.toFixed(3)),
      winProbability: Number(blendedWinProbability.toFixed(3)),
      monteCarlo,
      sizing,
      risk,
      news,
      rejections,
      warnings,
      summary:
        `${input.symbol} ${input.mode}: no trade — ${rejections[0] ?? "gate failed"} ` +
        `(quality ${qualityScore.toFixed(0)}/${threshold.toFixed(0)}, E ${effectiveExpectancyR.toFixed(2)}R).`,
      evaluatedAt: now,
    };
  }

  // Probability of coming back to entry before the target, used to decide how
  // early breakeven may be scheduled.
  const retrace = simulateTrade({
    entry: search.tp > entry ? entry + riskPrice : entry - riskPrice,
    sl: entry,
    tp: search.tp,
    side,
    drift: regime.drift,
    volatility: simulationVolatility,
    horizon,
    returns,
    paths: 1500,
    seed: seed ^ 0x5bf03635,
  }).lossProbability;

  const atrPoints = priceToPoints(input.spec, stop.atrValue);
  const management = buildManagementPlan({
    spec: input.spec,
    mode: input.mode,
    lots: sizing.lots,
    regimeKind: regime.kind,
    atrPoints,
    retraceProbability: retrace,
  });

  const plan: ArmedPlan = {
    id: randomUUID(),
    symbol: input.symbol,
    side,
    mode: input.mode,
    trigger,
    triggerType: "break",
    confirmTicks: input.mode === "scalp" ? 2 : 1,
    invalidate,
    sl: sizing.sl,
    tp: [search.tp],
    lots: sizing.lots,
    riskMoney: sizing.riskMoney,
    riskPoints: sizing.riskPoints,
    maxSpreadPoints,
    maxSlippagePoints: input.mode === "scalp" ? 3 : 6,
    expiresAt: now + PLAN_TTL_MS[input.mode],
    createdAt: now,
    management,
    rationale: {
      confluenceScore: Number(qualityScore.toFixed(1)),
      grade: confluence.grade,
      regime: `${entrySeries.timeframe} ${regime.kind}`,
      winProbability: Number(blendedWinProbability.toFixed(3)),
      expectancyR: Number(effectiveExpectancyR.toFixed(3)),
      rewardRisk: Number(monteCarlo.rewardRisk.toFixed(2)),
      markovPersistence: Number(persistence.toFixed(3)),
      factors: [
        // The evidence ensemble first: it is the part of the decision with the
        // most independent statistical content, and the part the user most
        // often needs to audit when a trade surprises them.
        ...evidence.factors.map((factor) => ({
          label: factor.label,
          detail: `${factor.vote === 1 ? "agrees" : factor.vote === -1 ? "opposes" : "neutral"} · ${factor.detail}`,
          weight: Number((factor.weight * (0.35 + 0.65 * factor.reliability)).toFixed(3)),
          aligned: factor.vote === 1,
        })),
        ...confluence.factors,
        {
          label: "Monte Carlo",
          detail: `${(blendedWinProbability * 100).toFixed(0)}% win (${posterior.source}) over ${horizon} bars at ${monteCarlo.rewardRisk.toFixed(1)}R, E=${effectiveExpectancyR.toFixed(2)}R after costs`,
          weight: 1,
          aligned: true,
        },
        {
          label: "Sizing",
          detail: sizing.explanation,
          weight: 1,
          aligned: true,
        },
      ],
      warnings: [
        ...confluence.warnings,
        ...risk.reasons,
        ...(news.reason ? [news.reason] : []),
        ...warnings,
      ],
    },
  };

  return {
    symbol: input.symbol,
    mode: input.mode,
    armed: true,
    plan,
    confluence,
    evidence,
    qualityScore,
    qualityThreshold: threshold,
    expectancyR: Number(effectiveExpectancyR.toFixed(3)),
    winProbability: Number(blendedWinProbability.toFixed(3)),
    monteCarlo,
    sizing,
    risk,
    news,
    rejections: [],
    warnings,
    summary:
      `${input.symbol} ${input.mode}: ${side.toUpperCase()} ${sizing.lots} lots armed — ` +
      `quality ${qualityScore.toFixed(0)} (${confluence.grade}), ` +
      `${evidence.agreeingFamilies}/${evidence.totalFamilies} families agree, ` +
      `${(blendedWinProbability * 100).toFixed(0)}% win, E ${effectiveExpectancyR.toFixed(2)}R, ` +
      `risk ${sizing.riskMoney.toFixed(2)}.`,
    evaluatedAt: now,
  };
}

/** Horizon of a mode expressed in minutes, for display. */
export function horizonMinutes(mode: TradeMode): number {
  return MODE_HORIZON_BARS[mode] * TIMEFRAME_MINUTES[ENTRY_TIMEFRAME[mode]];
}
