/**
 * WP4 — the measurement every alpha agent's probability comes from.
 *
 * ── THE PROBLEM WITH A HAND-WRITTEN PROBABILITY ─────────────────────────────
 *
 * The v3 desk reported a "win probability" assembled from weights somebody
 * chose: it said ~50% where the truth on a real control was 85%, and its
 * reliability slope was −0.24 (WP2 baseline). A number that is not measured is
 * a mood, and a mood compounds through sizing into money.
 *
 * So no agent in v4 carries a magic constant. Every view's probability comes
 * from the only evidence an agent can honestly have about itself: **how the
 * identical setup resolved the last time it appeared, on the data it can see.**
 *
 *   P̂ = (hits + k · p₀) / (occurrences + k),  p₀ = 1 / (1 + rr)
 *
 *   • `occurrences` counts setups whose outcome window has FULLY CLOSED by the
 *     decision bar — a setup still in flight is not evidence yet, and counting
 *     it would be lookahead dressed as statistics;
 *   • `p₀` is the break-even hit rate at the required reward:risk (1/3 at 1:2),
 *     so the prior is "this agent has no edge", and `k = 6` pseudo-occurrences
 *     is how much evidence it takes to move away from that prior;
 *   • `hit` is defined structurally and identically for every agent: **the move
 *     reaches `rr` × the structural stop before the stop**. That is the question
 *     the desk's R:R floor asks, so it is the question the agent must answer.
 *
 * The claim is then checkable, and WP4 checks it (`research/alpha-eval.ts`): on
 * a labelled fixture the realised hit rate must beat break-even, on
 * structureless data it must not, and the stated probability must track the
 * realised rate. A better probability is WP5's job — isotonic calibration with
 * sample-uniqueness weights — and it calibrates THIS number, not a constant.
 *
 * ── WHY THE TABLE IS INCREMENTAL ────────────────────────────────────────────
 *
 * An outcome window is `horizonBars` long, so a naive build is O(n · horizon) on
 * every decision point — and a study takes a decision every few bars, which
 * makes the whole thing O(n² · horizon). `EdgeTableState` extends itself: the
 * outcomes for bars that have already dropped out of the horizon never change,
 * so each call only evaluates the newly completed ones. The total cost of a
 * study becomes one pass, and the live desk (which has no cache) still pays only
 * O(history × horizon) on the few hundred bars it actually keeps.
 */
import { CLOSE, HIGH, LOW, atrSeries, mean, stdev } from "../math";
import type { AlphaContext } from "./types";
import { ENTRY_TIMEFRAME, MIN_RR_FILL, STOP_ATR_MULT } from "../desk-constants";
import { MODE_HORIZON_BARS } from "../confluence";
import type { Bar, Side, Timeframe, TradeMode } from "../types";

// ── Structural constants (one place, with the argument for each) ─────────────

export interface AlphaConfig {
  /**
   * Structural stop in ATR — the SAME number the desk places its stop with, so
   * the agent's measured hit rate is denominated in the same R as the trade it
   * will produce. Imported from `agent.ts` rather than restated, and asserted
   * equal in the tests: two copies of this number would eventually disagree, and
   * the disagreement would be invisible in every report.
   */
  stopAtr: Record<TradeMode, number>;
  /** The frame each mode's stop, ATR and R are measured on (also the desk's). */
  entryFrame: Record<TradeMode, Timeframe>;
  /** Reward:risk the hit rate is measured at; never below the desk's floor. */
  rr: number;
  /**
   * Pseudo-occurrences of the no-edge prior (see the header).
   *
   * The prior is no longer the textbook 1/(1+rr): with a TIME horizon, the
   * probability that a random entry reaches +2R before −1R inside `horizonBars`
   * is nothing like 1/3 — on a driftless M15 walk it measures around 0.15–0.20,
   * because most setups simply expire. The prior is therefore the MEASURED
   * random-entry baseline for the identical geometry (see `BaselineState`), and
   * this weight is how much of it a small sample is worth.
   */
  priorStrength: number;
  /**
   * Minimum closed occurrences before an agent may state a probability.
   *
   * Deliberately low, and that is only safe because the prior is the measured
   * baseline: an estimate from four occurrences is dominated by the baseline it
   * is shrunk toward, so it cannot promise much. The `minOccurrences` that
   * matters for an EDGE claim lives in the gate (`research/alpha-eval.ts`), not
   * here — a gate is the right place to demand evidence.
   */
  minOccurrences: number;
  /** Bar-count holding horizon per mode (the desk's). */
  horizonBars: Record<TradeMode, number>;
}

export const DEFAULT_ALPHA_CONFIG: AlphaConfig = {
  stopAtr: STOP_ATR_MULT,
  entryFrame: ENTRY_TIMEFRAME,
  rr: MIN_RR_FILL,
  // Eight pseudo-occurrences of the measured no-edge prior: a four-occurrence
  // sample moves the estimate by at most an eighth of its own excess over the
  // baseline, which is why a small sample cannot promise much.
  priorStrength: 8,
  minOccurrences: 4,
  horizonBars: MODE_HORIZON_BARS,
};

/** The break-even hit rate at a reward:risk, ignoring costs. */
export function breakEvenHitRate(rr: number): number {
  return 1 / (1 + rr);
}

// ── Causal geometry, shared by the agents ───────────────────────────────────

export { atrSeries };

/** Robust scale of the bar-to-bar log returns: the σ the agents standardise by. */
export function returnScale(bars: Bar[], window = 100): number {
  const tail = bars.slice(-window);
  const returns: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    const prev = (tail[i - 1] as Bar)[CLOSE] as number;
    const now = (tail[i] as Bar)[CLOSE] as number;
    if (prev > 0 && now > 0) returns.push(Math.log(now / prev));
  }
  const scale = stdev(returns);
  if (Number.isFinite(scale) && scale > 0) return scale;
  // A flat line has no measurable scale; fall back to the ATR per bar so a
  // caller gets a positive denominator rather than an Infinity.
  const a = tail.length > 15 ? atrSeries(tail, 14)[tail.length - 1] : 0;
  return a && a > 0 ? a : Number.EPSILON;
}

/** Exponential moving average over a whole array, causal at every index. */
export function emaArray(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let current = values[0] as number;
  for (let i = 0; i < values.length; i++) {
    current = i === 0 ? (values[0] as number) : (values[i] as number) * k + current * (1 - k);
    out.push(current);
  }
  return out;
}

/** Log-return series of the closes (index i is the return INTO bar i). */
export function returnSeries(bars: Bar[]): number[] {
  const out: number[] = new Array(bars.length).fill(0) as number[];
  for (let i = 1; i < bars.length; i++) {
    const prev = (bars[i - 1] as Bar)[CLOSE] as number;
    const now = (bars[i] as Bar)[CLOSE] as number;
    out[i] = prev > 0 && now > 0 ? Math.log(now / prev) : 0;
  }
  return out;
}

/** Mean of a window of a numeric array, or null when the window is not there. */
export function meanAt(values: number[], index: number, window: number): number | null {
  if (index + 1 < window) return null;
  return mean(values.slice(index + 1 - window, index + 1));
}

/** The entry price a setup would actually face (the ask for a buy). */
export function entryPriceOf(close: number, direction: Side, spreadPrice: number): number {
  return direction === "buy" ? close + spreadPrice : close;
}

// ── The self-measured edge ──────────────────────────────────────────────────

export interface EdgeOutcome {
  /** Bar index the setup appeared on. */
  index: number;
  direction: Side;
  hit: boolean;
}

export interface EdgeTableState {
  /** Highest bar index whose outcome has been evaluated. */
  filledUpTo: number;
  outcomes: EdgeOutcome[];
}

export interface EdgeEstimate {
  /** Occurrences whose outcome window had closed by the decision bar. */
  occurrences: number;
  hits: number;
  /** Raw hit rate, or null with no occurrences. */
  hitRate: number | null;
  /** P̂: the shrunk probability the agent may state. Null below `minOccurrences`. */
  probability: number | null;
  /** Setups whose outcome window is still open at the decision bar. */
  inFlight: number;
  /** The random-entry hit rate this agent is judged and shrunk against. */
  baselineRate: number;
  /** Closed random-entry outcomes behind `baselineRate`. */
  baselineOutcomes: number;
  /** Hit rate minus baseline: the edge, as the agent's own history sees it. */
  edgeOverBaseline: number | null;
}

/**
 * Evaluate one setup's outcome window.
 *
 * A hit is: the favourable excursion reaches `rr` × stopDistance before the
 * adverse excursion reaches stopDistance. Ties inside one bar are resolved
 * PESSIMISTICALLY (the stop is assumed first) — the same convention as the
 * executed-policy simulator, because a study that is optimistic about intrabar
 * order is not measuring anything.
 */
export function evaluateOutcome(input: {
  bars: Bar[];
  index: number;
  direction: Side;
  entry: number;
  stopDistance: number;
  rr: number;
  horizonBars: number;
}): boolean {
  const { bars, index, direction, entry, stopDistance, rr, horizonBars } = input;
  if (!(stopDistance > 0) || !Number.isFinite(entry)) return false;
  const stop = direction === "buy" ? entry - stopDistance : entry + stopDistance;
  const target = direction === "buy" ? entry + rr * stopDistance : entry - rr * stopDistance;
  const end = Math.min(bars.length, index + 1 + horizonBars);
  for (let j = index + 1; j < end; j++) {
    const bar = bars[j] as Bar;
    const high = bar[HIGH] as number;
    const low = bar[LOW] as number;
    const stopHit = direction === "buy" ? low <= stop : high >= stop;
    const targetHit = direction === "buy" ? high >= target : low <= target;
    if (stopHit) return false; // pessimistic: the stop wins a same-bar tie
    if (targetHit) return true;
  }
  return false; // neither level touched inside the horizon: not a hit
}

export interface SignalAt {
  direction: Side;
  entry: number;
  /** Distance from the entry to the structural stop, in price units. */
  stopDistance: number;
}

/**
 * Extend a table by evaluating every bar that has newly dropped out of the
 * horizon. Deterministic; each outcome reads only bars after its own index.
 */
export function extendEdgeTable(
  state: EdgeTableState,
  input: {
    bars: Bar[];
    signalAt: (index: number) => SignalAt | null;
    rr: number;
    horizonBars: number;
    startIndex: number;
  },
): void {
  const { bars, signalAt, rr, horizonBars, startIndex } = input;
  const lastEvaluable = bars.length - horizonBars - 1;
  for (let i = Math.max(Math.max(1, startIndex), state.filledUpTo + 1); i <= lastEvaluable; i++) {
    const signal = signalAt(i);
    if (!signal) continue;
    state.outcomes.push({
      index: i,
      direction: signal.direction,
      hit: evaluateOutcome({
        bars,
        index: i,
        direction: signal.direction,
        entry: signal.entry,
        stopDistance: signal.stopDistance,
        rr,
        horizonBars,
      }),
    });
  }
  if (lastEvaluable > state.filledUpTo) state.filledUpTo = lastEvaluable;
}

/** A fresh table state for one (agent, frame) pair. */
export function newEdgeState(): EdgeTableState {
  return { filledUpTo: -1, outcomes: [] };
}

/**
 * The causal reading of a table: everything that closed before `decisionIndex`.
 *
 * A setup at index `i` counts only when `i + horizonBars ≤ decisionIndex`.
 */
export function edgeAt(
  state: EdgeTableState,
  decisionIndex: number,
  input: {
    rr: number;
    horizonBars: number;
    /**
     * The measured random-entry rates. The one used is the direction of the
     * setup being measured (see the direction-matched note in the header).
     */
    baseline?: BaselineRates;
    /** The setup's direction — selects which baseline rate applies. */
    direction?: Side;
  },
  cfg: AlphaConfig = DEFAULT_ALPHA_CONFIG,
): EdgeEstimate {
  let occurrences = 0;
  let hits = 0;
  let inFlight = 0;
  for (const outcome of state.outcomes) {
    if (outcome.index + input.horizonBars <= decisionIndex) {
      occurrences++;
      if (outcome.hit) hits++;
    } else {
      inFlight++;
    }
  }
  const hitRate = occurrences > 0 ? hits / occurrences : null;
  // The direction-matched baseline. `input.direction` is always supplied by
  // `selfMeasured`, which is the only caller that has a setup to compare.
  const matched = input.baseline
    ? input.direction
      ? baselineForDirection(input.baseline, input.direction)
      : input.baseline.rate
    : null;
  const baselineRate = matched ?? breakEvenHitRate(input.rr);
  const k = cfg.priorStrength;
  const probability = occurrences >= cfg.minOccurrences ? (hits + k * baselineRate) / (occurrences + k) : null;
  return {
    occurrences,
    hits,
    hitRate,
    probability,
    inFlight,
    baselineRate,
    baselineOutcomes: input.baseline?.outcomes ?? 0,
    edgeOverBaseline: hitRate === null ? null : hitRate - baselineRate,
  };
}

// ── The random-entry baseline ───────────────────────────────────────────────

/**
 * What a coin flip would have achieved with the SAME geometry.
 *
 * This is the honest reference for a setup, and the reason it exists: the
 * textbook break-even hit rate 1/(1+rr) assumes a position that is held until
 * one of the two levels is touched. Real setups time out — the desk closes the
 * trade at its holding horizon whether or not the target was reached — and with
 * a 24-bar horizon on M15 the probability that a DRIFTLESS walk reaches +2R
 * before −1R measures nearer 0.17 than 0.33. Judging an agent against 0.33 would
 * have failed every agent for a property of the calendar, and (worse) judging one
 * against 0.33 on a quiet series and calling it "no edge" would hide a real one.
 *
 * So the baseline is measured, both directions, at every bar, with the same stop
 * distance and the same horizon: the hit rate of entering at random. An agent's
 * edge is its hit rate MINUS this number, and the probability it states is shrunk
 * toward it rather than toward a constant that does not apply.
 *
 * ── AND IT IS DIRECTION-MATCHED, WHICH IS THE SUBTLE PART ───────────────────
 *
 * A two-sided baseline is not a fair comparator for an agent that is not
 * direction-neutral, and this was measured rather than assumed: the driftless
 * fixture is driftless in EXPECTATION, but a realised 3000-bar path ends 25–35σ
 * from where it started, and on a path like that buys simply do better than
 * sells (measured: 15.5–17.2% for buys against 13.9–16.2% for sells). An agent
 * that happens to be long on that path would therefore "beat the coin flip"
 * with no skill at all — the seasonality agent showed a +8.6 point "edge" on
 * pure noise for exactly this reason, because the hour means it measures on a
 * trending path are nearly all positive.
 *
 * The fix is that the comparator is the SAME DIRECTION as the view: a buy is
 * compared against random buys, a sell against random sells, both measured
 * causally on the windows that had closed by the decision bar. Skill then means
 * "this setup's bar is better than a random bar in this direction", which is the
 * claim the agents are actually making.
 */
export interface BaselineState {
  filledUpTo: number;
  /** Outcome of both coin-flip entries at each already-evaluated bar. */
  bars: { index: number; buyHit: boolean; sellHit: boolean }[];
}

export function newBaselineState(): BaselineState {
  return { filledUpTo: -1, bars: [] };
}

export function extendBaseline(
  state: BaselineState,
  input: {
    bars: Bar[];
    stopDistanceAt: (index: number) => number;
    entryAt: (index: number, direction: Side) => number;
    rr: number;
    horizonBars: number;
    startIndex: number;
  },
): void {
  const { bars, stopDistanceAt, entryAt, rr, horizonBars, startIndex } = input;
  const lastEvaluable = bars.length - horizonBars - 1;
  for (let i = Math.max(Math.max(1, startIndex), state.filledUpTo + 1); i <= lastEvaluable; i++) {
    const stopDistance = stopDistanceAt(i);
    if (!(stopDistance > 0)) continue;
    const evaluate = (direction: Side): boolean =>
      evaluateOutcome({
        bars,
        index: i,
        direction,
        entry: entryAt(i, direction),
        stopDistance,
        rr,
        horizonBars,
      });
    state.bars.push({ index: i, buyHit: evaluate("buy"), sellHit: evaluate("sell") });
  }
  if (lastEvaluable > state.filledUpTo) state.filledUpTo = lastEvaluable;
}

/**
 * The CAUSAL reading of the baseline: only windows that have fully closed.
 *
 * Exact rather than approximate — an earlier version subtracted "outcomes in
 * flight" from a running total while still counting their hits, which biases the
 * rate upward, and a baseline that is wrong in the flattering direction is worse
 * than no baseline at all.
 */
export function baselineAt(
  state: BaselineState,
  decisionIndex: number,
  horizonBars: number,
): BaselineRates {
  let buyHits = 0;
  let sellHits = 0;
  let closed = 0;
  for (const bar of state.bars) {
    if (bar.index + horizonBars > decisionIndex) continue;
    if (bar.buyHit) buyHits++;
    if (bar.sellHit) sellHits++;
    closed++;
  }
  return {
    outcomes: closed,
    buyRate: closed > 0 ? buyHits / closed : null,
    sellRate: closed > 0 ? sellHits / closed : null,
    rate: closed > 0 ? (buyHits + sellHits) / (2 * closed) : null,
  };
}

export interface BaselineRates {
  /** Closed random-entry windows per direction. */
  outcomes: number;
  /** Random-entry hit rate for a LONG, causally. */
  buyRate: number | null;
  /** Random-entry hit rate for a SHORT, causally. */
  sellRate: number | null;
  /** Both directions pooled — the shrinkage target when neither is available. */
  rate: number | null;
}

/** The direction-matched baseline rate, with the pooled rate as a fallback. */
export function baselineForDirection(rates: BaselineRates, direction: Side): number | null {
  if (rates.outcomes >= BASELINE_MIN_OUTCOMES) {
    return direction === "buy" ? rates.buyRate : rates.sellRate;
  }
  return rates.rate;
}

/** Minimum closed baseline outcomes before the measured rate is trusted. */
export const BASELINE_MIN_OUTCOMES = 40;

export interface MeasuredSignal {
  direction: Side;
  entry: number;
  /** Distance from the entry to the structural stop, in price units. */
  stopDistance: number;
  /** Setup magnitude in σ or ATR units — carried into the view for ranking. */
  strength: number;
  /** Reference level the setup was measured against, when it has one. */
  level?: number;
}

export interface SelfMeasured {
  signal: MeasuredSignal;
  edge: EdgeEstimate;
  frame: Timeframe;
  /** The bars the decision was taken on (the visible tail). */
  bars: Bar[];
  /** Index of the decision bar inside `bars`. */
  index: number;
}

/**
 * The one call every agent makes: "what does this setup look like here, and how
 * has it resolved before?" — with the outcome window closed strictly before the
 * decision bar, and a probability only when the sample can support one.
 *
 * Factored out of the agents deliberately: the causality rule, the horizon and
 * the shrinkage must be identical across the five, or a study would be comparing
 * five different measurements and calling it five agents.
 */
export function selfMeasured(input: {
  ctx: AlphaContext;
  agent: string;
  frame: Timeframe;
  bars: Bar[];
  signalAt: (index: number) => MeasuredSignal | null;
  startIndex: number;
  cfg?: AlphaConfig;
  /**
   * The stop distance the random-entry baseline uses at a bar. Defaults to the
   * signal's own stop where it has one, and to the pass-through stop elsewhere.
   */
  baselineStopAt?: (index: number) => number;
  /** The entry price the baseline pays — the same convention as the agent's. */
  baselineEntryAt?: (index: number, direction: Side) => number;
}): SelfMeasured | null {
  const cfg = input.cfg ?? DEFAULT_ALPHA_CONFIG;
  const { bars } = input;
  const index = bars.length - 1;
  const horizonBars = cfg.horizonBars[input.ctx.mode];

  const key = edgeCacheKey(input.agent, input.frame);
  let state = input.ctx.cache?.get(key) as EdgeTableState | undefined;
  if (!state) {
    state = newEdgeState();
    input.ctx.cache?.set(key, state);
  }
  const baselineKey = `baseline:${input.agent}:${input.frame}`;
  let baseline = input.ctx.cache?.get(baselineKey) as BaselineState | undefined;
  if (!baseline) {
    baseline = newBaselineState();
    input.ctx.cache?.set(baselineKey, baseline);
  }
  // Without a cache (the live desk) both tables are rebuilt from scratch over the
  // few hundred bars the store keeps — still only O(bars × horizon).
  extendEdgeTable(state, {
    bars,
    signalAt: input.signalAt,
    rr: cfg.rr,
    horizonBars,
    startIndex: input.startIndex,
  });
  const spreadPrice = input.ctx.spec.spreadPoints * input.ctx.spec.point;
  const fallbackStop = (i: number): number => {
    const signal = input.signalAt(i);
    return signal ? signal.stopDistance : 0;
  };
  extendBaseline(baseline, {
    bars,
    // The comparator is "enter at random with the SAME geometry": the stop the
    // desk would place for this mode at this bar, and the same side-dependent
    // entry price the agent pays.
    stopDistanceAt: input.baselineStopAt ?? fallbackStop,
    entryAt:
      input.baselineEntryAt ??
      ((i: number, direction: Side) =>
        entryPriceOf((bars[i] as Bar)[CLOSE] as number, direction, spreadPrice)),
    rr: cfg.rr,
    horizonBars,
    startIndex: input.startIndex,
  });

  const signal = input.signalAt(index);
  if (!signal) return null;
  const edge = edgeAt(
    state,
    index,
    {
      rr: cfg.rr,
      horizonBars,
      baseline: baselineAt(baseline, index, horizonBars),
      direction: signal.direction,
    },
    cfg,
  );
  if (edge.probability === null) return null;
  return { signal, edge, frame: input.frame, bars, index };
}

/** The cache key for one agent's table over one frame's current bars. */
export function edgeCacheKey(agent: string, frame: Timeframe): string {
  // Deliberately NOT keyed by length: the table extends itself, so the same key
  // must survive the series growing. A different series reuses a stale table
  // only if it shares the agent+frame, which cannot happen inside one study run
  // (each series gets its own cache map) — see `runAlphaStudy`.
  return `edge:${agent}:${frame}`;
}

/** Standard error of a proportion — what "demonstrable" is measured against. */
export function standardError(p: number, n: number): number {
  if (n <= 0) return 1;
  return Math.sqrt(Math.max(0, p) * (1 - Math.max(0, Math.min(1, p))) / n);
}

/** Wilson 95% interval for a hit rate — the honest bound in every report. */
export function wilsonInterval(hits: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lower: Math.max(0, (centre - spread) / denom), upper: Math.min(1, (centre + spread) / denom) };
}
