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
import { scoreConfluence, MODE_HORIZON_BARS, MODE_SCORE_THRESHOLD, type ConfluenceResult } from "./confluence";
import { markovFromPrices, directionalPersistence, sampleConfidence } from "./markov";
import { assessRegime, isRegimeTradeable } from "./regime";
import { bestTarget, simulateTrade, type MonteCarloResult } from "./montecarlo";
import { evaluateRisk, type RiskDecision, type RiskPolicy, type RiskState } from "./risk";
import { kellyFraction, pointValuePerLot, priceToPoints, sizePosition, type SizingResult } from "./sizing";
import { assessNewsGate, type NewsGate } from "./news";
import {
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
  /** Minimum Markov persistence of the favourable state over the horizon. */
  minPersistence?: number;
}

export interface AgentDecision {
  symbol: string;
  mode: TradeMode;
  armed: boolean;
  plan: ArmedPlan | null;
  confluence: ConfluenceResult;
  monteCarlo: MonteCarloResult | null;
  sizing: SizingResult | null;
  risk: RiskDecision;
  /** Red-folder calendar gate evaluated with this decision. */
  news: NewsGate;
  /** Every gate that failed, in evaluation order. Shown verbatim in the UI. */
  rejections: string[];
  /** Short machine-readable summary for the signal log. */
  summary: string;
  evaluatedAt: number;
}

/** Entry timeframe used for stop placement and horizons, per style. */
const ENTRY_TIMEFRAME: Record<TradeMode, Timeframe> = {
  scalp: "M5",
  intraday: "M15",
  swing: "H1",
};

/** ATR multiple for the initial structural stop, per style. */
const STOP_ATR_MULT: Record<TradeMode, number> = {
  scalp: 1.1,
  intraday: 1.5,
  swing: 2.0,
};

/** How long an armed plan stays valid, per style. */
const PLAN_TTL_MS: Record<TradeMode, number> = {
  scalp: 90_000,
  intraday: 10 * 60_000,
  swing: 60 * 60_000,
};

export const DEFAULT_MIN_EDGE_R = 0.15;
export const DEFAULT_MIN_PERSISTENCE = 0.55;

function firstAvailable(
  series: Partial<Record<Timeframe, Bar[]>>,
  preferred: Timeframe,
): { timeframe: Timeframe; bars: Bar[] } | null {
  const order: Timeframe[] = [preferred, "M5", "M15", "M1", "M30", "H1", "H4", "D1"];
  for (const tf of order) {
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
    const distance = Math.abs(entry - candidate);
    // Reject a swing that is implausibly close or far; fall back to ATR.
    if (distance >= atrValue * 0.5 && distance <= atrValue * mult * 2.5) {
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
      maxSpreadPoints: Math.max(spec.spreadPoints * 2.5, 10),
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

  // ── 3. Confluence ─────────────────────────────────────────────────────────
  const confluence = scoreConfluence({
    symbol: input.symbol,
    mode: input.mode,
    series: input.series,
  });

  const threshold = MODE_SCORE_THRESHOLD[input.mode] + risk.scoreBump;

  const fail = (extra: string[] = []): AgentDecision => ({
    symbol: input.symbol,
    mode: input.mode,
    armed: false,
    plan: null,
    confluence,
    monteCarlo: null,
    sizing: null,
    risk,
    news,
    rejections: [...rejections, ...extra],
    summary: `${input.symbol} ${input.mode}: no trade (score ${confluence.score.toFixed(0)}/${threshold.toFixed(0)}).`,
    evaluatedAt: now,
  });

  if (confluence.direction === "none") {
    return fail(["No directional bias across the scored timeframes."]);
  }
  if (confluence.score < threshold) {
    // One decimal place: rounding both sides to integers produced the
    // nonsensical "Confluence 68 is below the 68 required".
    rejections.push(
      `Confluence ${confluence.score.toFixed(1)} is below the ${threshold.toFixed(1)} required for a ${input.mode} entry.`,
    );
  }
  if (!confluence.higherTimeframeAligned) {
    rejections.push("A higher timeframe opposes this direction.");
  }

  // ── 3. Entry timeframe, regime, stop ──────────────────────────────────────
  const entrySeries = firstAvailable(input.series, ENTRY_TIMEFRAME[input.mode]);
  if (!entrySeries) {
    return fail(["No timeframe has the 30+ bars needed to place a stop."]);
  }

  const regime = assessRegime(entrySeries.bars);
  if (!isRegimeTradeable(regime.kind, input.mode)) {
    rejections.push(
      `${entrySeries.timeframe} regime is ${regime.kind} — not tradeable in ${input.mode} mode.`,
    );
  }

  const side = confluence.direction === "up" ? "buy" : "sell";
  // Enter at the price we would actually pay, not the mid.
  const entry = side === "buy" ? input.quote.ask : input.quote.bid;
  if (!(entry > 0)) return fail(["No live quote for this symbol."]);

  const stop = structuralStop(entrySeries.bars, side, entry, input.mode);
  if (!(Math.abs(entry - stop.sl) > 0)) {
    return fail(["Stop placement produced a zero-distance stop (flat market)."]);
  }

  // ── 4. Markov persistence ─────────────────────────────────────────────────
  const price = closes(entrySeries.bars);
  const model = markovFromPrices(price);
  const horizon = MODE_HORIZON_BARS[input.mode];
  const persistence = directionalPersistence(model, confluence.direction, horizon);
  const modelConfidence = sampleConfidence(model);

  if (persistence < minPersistence) {
    rejections.push(
      `Markov persistence of the favourable state is ${(persistence * 100).toFixed(0)}% over ${horizon} bars, below the ${(minPersistence * 100).toFixed(0)}% floor.`,
    );
  }

  // ── 5. Monte Carlo target search ──────────────────────────────────────────
  const returns = logReturns(price);
  const pointValue = pointValuePerLot(input.spec);
  const riskPrice = Math.abs(entry - stop.sl);

  // Cost expressed in PRICE units so it can be compared with the stop
  // distance: spread crossed once, commission converted via point value, plus
  // an allowance for slippage.
  const slippageAllowancePoints = input.mode === "scalp" ? 1.5 : 1;
  const commissionPoints = pointValue > 0 ? input.spec.commissionPerLot / pointValue : 0;
  const costPrice =
    (input.spec.spreadPoints + commissionPoints + slippageAllowancePoints) * input.spec.point;

  const seed = hashSeed(`${input.symbol}|${input.mode}|${entrySeries.timeframe}|${entrySeries.bars.length}`);
  const search = bestTarget({
    entry,
    sl: stop.sl,
    side,
    // Blend the measured drift with the Markov view, scaled by how much data
    // backs the model. With little history the simulation leans on raw drift.
    drift: regime.drift * (0.5 + 0.5 * modelConfidence),
    volatility: regime.stepVolatility,
    horizon,
    returns,
    costPrice,
    paths: 3000,
    seed,
  });

  if (!search) return fail(["Monte Carlo could not evaluate this setup."]);
  const monteCarlo = search.result;

  if (monteCarlo.expectancyR < minEdgeR) {
    rejections.push(
      `Expectancy after costs is ${monteCarlo.expectancyR.toFixed(2)}R (gross ${monteCarlo.grossExpectancyR.toFixed(2)}R), below the ${minEdgeR}R minimum.`,
    );
  }

  // ── 6. Spread gate ────────────────────────────────────────────────────────
  const maxSpreadPoints = Math.max(input.spec.spreadPoints * 2, 8);
  if (input.quote.spreadPoints > maxSpreadPoints) {
    rejections.push(
      `Spread ${input.quote.spreadPoints} pts exceeds the ${maxSpreadPoints.toFixed(0)} pt execution gate.`,
    );
  }

  // ── 7. Edge-aware sizing ──────────────────────────────────────────────────
  // Risk scales with measured edge (fractional Kelly) and with how confident
  // the regime call is — never with recent losses.
  const kelly = kellyFraction(monteCarlo.winProbability, monteCarlo.rewardRisk, 0.25);
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
    spec: input.spec,
    side,
    entry: trigger,
    sl: stop.sl,
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
      monteCarlo,
      sizing,
      risk,
      news,
      rejections,
      summary:
        `${input.symbol} ${input.mode}: no trade — ${rejections[0] ?? "gate failed"} ` +
        `(score ${confluence.score.toFixed(0)}, E ${monteCarlo.expectancyR.toFixed(2)}R).`,
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
    volatility: regime.stepVolatility,
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
      confluenceScore: Number(confluence.score.toFixed(1)),
      grade: confluence.grade,
      regime: `${entrySeries.timeframe} ${regime.kind}`,
      winProbability: Number(monteCarlo.winProbability.toFixed(3)),
      expectancyR: Number(monteCarlo.expectancyR.toFixed(3)),
      rewardRisk: Number(monteCarlo.rewardRisk.toFixed(2)),
      markovPersistence: Number(persistence.toFixed(3)),
      factors: [
        ...confluence.factors,
        {
          label: "Monte Carlo",
          detail: `${(monteCarlo.winProbability * 100).toFixed(0)}% win over ${horizon} bars at ${monteCarlo.rewardRisk.toFixed(1)}R, E=${monteCarlo.expectancyR.toFixed(2)}R after costs`,
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
      ],
    },
  };

  return {
    symbol: input.symbol,
    mode: input.mode,
    armed: true,
    plan,
    confluence,
    monteCarlo,
    sizing,
    risk,
    news,
    rejections: [],
    summary:
      `${input.symbol} ${input.mode}: ${side.toUpperCase()} ${sizing.lots} lots armed — ` +
      `score ${confluence.score.toFixed(0)} (${confluence.grade}), ` +
      `${(monteCarlo.winProbability * 100).toFixed(0)}% win, E ${monteCarlo.expectancyR.toFixed(2)}R, ` +
      `risk ${sizing.riskMoney.toFixed(2)}.`,
    evaluatedAt: now,
  };
}

/** Horizon of a mode expressed in minutes, for display. */
export function horizonMinutes(mode: TradeMode): number {
  return MODE_HORIZON_BARS[mode] * TIMEFRAME_MINUTES[ENTRY_TIMEFRAME[mode]];
}
