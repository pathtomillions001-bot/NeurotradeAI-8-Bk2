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
import { fillSpreadGuard, slippageAllowancePoints } from "./asset-costs";
import {
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
  ALL_TIMEFRAMES,
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
  /**
   * The frame the stop, the volatility and the horizon were measured on, and
   * that horizon in minutes. Reported so the terminal can never print a horizon
   * the analysis did not use (it used to print 12 x M2 = 24 min while the
   * simulation ran on S10 bars).
   */
  entryTimeframe: Timeframe | null;
  horizonMinutes: number | null;
  /** Round-trip cost as a fraction of the risk unit: `cost / |entry - sl|`. */
  costR: number | null;
  /** True when the structural stop was widened to keep the risk unit real. */
  stopWidened: boolean;
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
 * The stop may never be smaller than this many times the round-trip cost.
 *
 * THIS IS THE FIX FOR "the expectancy is always below 0.15R".
 *
 * Every gate in the desk is measured in R — the distance to the stop. If R is
 * about the same size as the spread, then "one R" of edge can never cover "one
 * R" of cost, and the expectancy is structurally negative no matter how good
 * the setup is. That is exactly what a 0.8 × ATR stop on a one-minute FX frame
 * produces on a broker quoting a 0.8-pip spread: an 8-point spread against a
 * 10-point stop is 0.8R of cost before the trade has any edge at all.
 *
 * Four is a deliberate number: it caps the round-trip cost at 25% of the money
 * risked, which still leaves room for a 0.15R+ net edge on a genuine setup.
 * The spread is *not* filtered out anywhere — it is priced here, inside the
 * risk the trade is taking.
 */
export const MIN_COST_COVERAGE = 4;

/**
 * ...and the stop may never be smaller than this many ATRs of the entry frame,
 * because a stop inside one average bar's range is taken out by noise rather
 * than by the market disagreeing with the idea.
 */
const MIN_RISK_ATR = 0.8;

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
 * THE ENTRY FRAME COMES FIRST, AND THAT IS THE POINT.
 *
 * This used to prefer the frames the confluence had scored — fastest first — so
 * a scalp resolved its stop and its volatility off S10/S30 and an intraday book
 * off M5. The horizon, meanwhile, was always counted in bars of the mode's own
 * entry frame (M2 / M15 / H1). Two different clocks were therefore used to
 * build one trade:
 *
 *   stop      = 0.8 × ATR(S10)          → a few points on EURUSD
 *   horizon   = 12 bars of M2           → 24 minutes of price action
 *
 * so the stop sat inside the noise of the very horizon the trade was planned
 * over, the Monte Carlo resolved it as a near-certain loss, and the target
 * search then picked the least-bad multiple of a hopeless geometry (which is
 * how "A+ setup, R:R 4.0, win 11%" got printed). Worse, on FX it made the stop
 * smaller than the spread: the expectancy could never be anything but deeply
 * negative.
 *
 * Now the entry frame is the anchor. Missing or too-short frames are replaced
 * by their nearest neighbours — slower first, so a substitution widens the
 * stop rather than tightening it — and the frame actually used is reported on
 * the decision (`entryTimeframe`) with its horizon, so the terminal can never
 * claim a horizon the analysis did not use.
 */
function resolveEntrySeries(
  series: Partial<Record<Timeframe, Bar[]>>,
  mode: TradeMode,
): { timeframe: Timeframe; bars: Bar[] } | null {
  const preferred = ENTRY_TIMEFRAME[mode];
  const anchor = ALL_TIMEFRAMES.indexOf(preferred);
  const order = [...ALL_TIMEFRAMES]
    .map((timeframe, index) => ({ timeframe, index, distance: Math.abs(index - anchor) }))
    // Nearest first; on a tie take the SLOWER frame (a wider stop is safer).
    .sort((a, b) => a.distance - b.distance || b.index - a.index)
    .map((entry) => entry.timeframe);

  for (const timeframe of order) {
    const bars = series[timeframe];
    if (bars && bars.length >= MIN_ENTRY_BARS) return { timeframe, bars };
  }
  return null;
}

/** Bars the entry frame needs before a stop may be placed on it. */
const MIN_ENTRY_BARS = 30;

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
  /** Set once the entry frame is resolved; reported on every decision. */
  let resolvedEntryFrame: Timeframe | null = null;

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
      // A no-trade decision still names the frame and horizon it would have
      // measured on, so the desk can explain itself.
      entryTimeframe: resolvedEntryFrame,
      horizonMinutes: resolvedEntryFrame
        ? MODE_HORIZON_BARS[input.mode] * TIMEFRAME_MINUTES[resolvedEntryFrame]
        : null,
      costR: null,
      stopWidened: false,
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
  // The ensemble needs the entry series, so resolve it before scoring — and it
  // resolves to the MODE'S OWN ENTRY FRAME (M2 / M15 / H1), never to the
  // fastest frame the confluence happened to score. The stop, the volatility
  // and the horizon must all be measured on the same clock; see
  // `resolveEntrySeries`.
  const entrySeries = resolveEntrySeries(input.series, input.mode);
  if (!entrySeries) {
    return fail(["No timeframe has the 30+ bars needed to place a stop on this market."]);
  }
  resolvedEntryFrame = entrySeries.timeframe;
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

  const side = effectiveDirection === "up" ? "buy" : "sell";
  // Enter at the price we would actually pay, not the mid.
  const entry = side === "buy" ? input.quote.ask : input.quote.bid;
  if (!(entry > 0)) return fail(["No live quote for this symbol."]);

  // ── Cost, in price units, BEFORE the stop is accepted ─────────────────────
  //
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

  const pointValue = pointValuePerLot(input.spec);
  const slippagePoints = slippageAllowancePoints(input.spec, input.mode);
  const commissionPoints = pointValue > 0 ? input.spec.commissionPerLot / pointValue : 0;
  // Spread crossed once, commission converted via point value, plus an
  // allowance for slippage. Slippage is scaled by asset class — a crypto CFD
  // does not fill like a major FX pair.
  const costPrice = (liveSpreadPoints + commissionPoints + slippagePoints) * input.spec.point;

  // ── 3d. Regime and stop ───────────────────────────────────────────────────
  const regime = assessRegime(entrySeries.bars);
  if (!isRegimeTradeable(regime.kind, input.mode)) {
    rejections.push(
      `${entrySeries.timeframe} regime is ${regime.kind} — not tradeable in ${input.mode} mode.`,
    );
  }

  const stop = structuralStop(entrySeries.bars, side, entry, input.mode);
  if (!(Math.abs(entry - stop.sl) > 0)) {
    return fail(["Stop placement produced a zero-distance stop (flat market)."]);
  }

  /**
   * THE RISK UNIT IS ENFORCED HERE, NOT ASSUMED.
   *
   * A stop closer than the round-trip cost makes "one R" smaller than the price
   * of getting in: the expectancy gate can then never be satisfied, on any
   * setup, however good — which is precisely what the desk was reporting on
   * every FX symbol. The stop is therefore widened to the larger of the two
   * floors below, and the widening is reported so it is never a silent change
   * of plan.
   *
   * Note what this does NOT do: it does not remove the spread from the trade.
   * The spread is still charged in the expectancy, in the sizing explanation and
   * at fill time. It simply stops being larger than the trade's own risk unit —
   * and, because the cost is now bounded inside R, the spread-ratio vetoes that
   * used to block these setups have nothing left to do (they are gone).
   */
  const minimumRiskPrice = Math.max(
    costPrice * MIN_COST_COVERAGE,
    stop.atrValue * MIN_RISK_ATR,
  );
  const structuralRiskPrice = Math.abs(entry - stop.sl);
  let sl = stop.sl;
  const riskWidened = structuralRiskPrice < minimumRiskPrice;
  if (riskWidened) {
    sl = side === "buy" ? entry - minimumRiskPrice : entry + minimumRiskPrice;
    warnings.push(
      `Stop widened from ${priceToPoints(input.spec, structuralRiskPrice).toFixed(0)} to ` +
        `${priceToPoints(input.spec, minimumRiskPrice).toFixed(0)} pts: a stop inside the ` +
        `${priceToPoints(input.spec, costPrice).toFixed(1)}-pt round-trip cost (or inside one ${entrySeries.timeframe} bar) ` +
        `is not a risk unit — it is the spread, charged twice.`,
    );
  }
  const riskPrice = Math.abs(entry - sl);
  const costR = riskPrice > 0 ? costPrice / riskPrice : 0;

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
    // The RISK UNIT the gate is measured in — the widened stop, not the raw
    // structural one. Target multiples are searched off this distance.
    sl,
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

  /**
   * Expectancy recomputed on the blended probability — WITHOUT THROWING AWAY
   * THE TIMEOUT PATHS.
   *
   * This used to be `p·RR − (1−p) − costR`, which treats every path that is
   * neither a win nor a loss as a full −1R. It is not: a plan with a stop and a
   * target both wider than the horizon closes at the horizon, at whatever the
   * market is then worth (`timeoutMeanR`), and with a wide stop — the normal
   * case once the risk unit is real — the majority of paths end that way. The
   * old formula therefore *manufactured* a negative expectancy: a setup the
   * simulation scored at +2.20R gross was reported as −0.25R, and the desk
   * refused it. This is the second half of "the expectancy is always below the
   * 0.15R minimum".
   *
   * Only `p(win)` is re-estimated by the blend, so the fix is to re-normalise
   * the remaining probability between loss and timeout in the SAME PROPORTION
   * the simulation found, and to keep the payoff those timeout paths actually
   * have. When no realised history is blended in, this reduces exactly to the
   * simulation's own expectancy — which is the property a gate should have.
   */
  const timeoutProbability = monteCarlo.timeoutProbability;
  const blendedLossProbability = clamp(
    1 - blendedWinProbability - timeoutProbability,
    0,
    1,
  );
  const costRFromModel = Math.max(0, monteCarlo.grossExpectancyR - monteCarlo.expectancyR);
  const effectiveExpectancyR =
    blendedWinProbability * monteCarlo.rewardRisk -
    blendedLossProbability +
    timeoutProbability * monteCarlo.timeoutMeanR -
    costRFromModel;

  if (effectiveExpectancyR < minEdgeR) {
    rejections.push(
      `Expectancy after costs is ${effectiveExpectancyR.toFixed(2)}R (model ${monteCarlo.expectancyR.toFixed(2)}R, ` +
        `gross ${monteCarlo.grossExpectancyR.toFixed(2)}R, ${(monteCarlo.lossProbability * 100).toFixed(0)}% stop / ` +
        `${(monteCarlo.timeoutProbability * 100).toFixed(0)}% time-stop paths), below the ${minEdgeR}R minimum.`,
    );
  }

  // ── 6. Spread: priced, and ONLY priced ────────────────────────────────────
  //
  // There is exactly one cost decision in this desk, and this is it: the spread
  // (plus commission and slippage) is charged inside the expectancy above, and
  // `minEdgeR` is the single gate that judges it. The two ratio vetoes that used
  // to sit here and in sizing — "spread is more than 35% of the stop" and
  // "(spread + commission) is more than 35% of the risk" — are gone. They were
  // blocking A+ setups on the strength of a ratio, while the number that
  // actually decides whether a trade pays was already computed one step above.
  //
  // What replaces them is arithmetic, not a threshold: the risk unit itself may
  // not be smaller than the cost of entering (see MIN_COST_COVERAGE above), so
  // a wide spread widens the stop instead of vetoing the idea. The spread is
  // still visible on the plan — `costR` states it in R, which is the only unit
  // in which it is comparable between a forex scalp and an index swing.
  //
  // Fill-time guard sent to the EA: how far the spread may widen between arming
  // and firing. Expressed against the STOP, not in absolute points, because a
  // point means something different on every asset class — and floored above
  // the spread we actually measured so a normal tick cannot block the fill.
  const stopPoints = input.spec.point > 0 ? riskPrice / input.spec.point : 0;
  const maxSpreadPoints = fillSpreadGuard(input.spec, stopPoints, liveSpreadPoints);

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
  //
  // No cost ceilings are passed any more: sizing's job is to convert a risk
  // budget into a legal lot size, not to re-litigate the edge. The spread is
  // already inside `expectancyR` (the gate) and inside the widened risk unit.
  const sizing = sizePosition({
    spec: specForSizing,
    side,
    entry: trigger,
    sl,
    tp: search.tp,
    equity: input.account.equity,
    freeMargin: input.account.freeMargin,
    usedMargin: input.account.margin,
    riskPct,
    leverage: input.account.leverage,
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
      entryTimeframe: entrySeries.timeframe,
      horizonMinutes: horizon * TIMEFRAME_MINUTES[entrySeries.timeframe],
      costR: Number(costR.toFixed(3)),
      stopWidened: riskWidened,
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
          detail:
            `${(blendedWinProbability * 100).toFixed(0)}% win (${posterior.source}) over ${horizon} ${entrySeries.timeframe} bars ` +
            `at ${monteCarlo.rewardRisk.toFixed(1)}R, E=${effectiveExpectancyR.toFixed(2)}R after costs`,
          weight: 1,
          aligned: true,
        },
        {
          label: "Cost & risk unit",
          detail:
            `cost ${(costR * 100).toFixed(0)}% of the ${sizing.riskPoints.toFixed(0)}-pt risk unit ` +
            `(${liveSpreadPoints}-pt spread + ${slippagePoints} pt slippage)` +
            (riskWidened ? ` — stop widened from the structural ${structuralRiskPrice / input.spec.point} pts to keep the risk unit real` : ""),
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
    entryTimeframe: entrySeries.timeframe,
    horizonMinutes: horizon * TIMEFRAME_MINUTES[entrySeries.timeframe],
    costR: Number(costR.toFixed(3)),
    stopWidened: riskWidened,
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
