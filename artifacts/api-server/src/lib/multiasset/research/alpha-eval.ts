/**
 * WP4 — how an alpha agent is judged.
 *
 * ── THE TWO QUESTIONS, AND WHY BOTH ─────────────────────────────────────────
 *
 *   1. **Is the claim true?** Every view states a probability. This module takes
 *      the view, evaluates the outcome STRUCTURALLY — did the move reach
 *      `rr` × the structural stop before the stop, with a same-bar tie resolved
 *      as a loss — and compares the realised hit rate against the claim.
 *   2. **Is the claim worth anything?** A stated probability that merely tracks
 *      the break-even rate (1/3 at 1:2) is honest and useless. The Brier skill
 *      against the break-even forecast is the number that says whether the
 *      probability carries information, and the "hit rate > break-even" test is
 *      the one that says whether the setup carries an edge at all.
 *
 * ── WHAT IS MEASURED, EXACTLY ───────────────────────────────────────────────
 *
 * Decisions walk the series bar by bar (every `stride` bars), each one seeing
 * ONLY the bars that have closed — the same `closedBarsAt` rule the harness uses
 * — and each agent is measured against its own fixture, the three nulls, and the
 * shipped desk's positive control. The outcome of a decision is evaluated on the
 * bars that FOLLOW it, so a decision at bar *i* is a genuine forecast; what the
 * agent cannot be given credit for is the fact that its own probability was
 * fitted on earlier decisions in the same series, which is why the study also
 * reports the FIRST and LAST third separately: an edge that lives only in the
 * second half of a series is a different (and much weaker) claim.
 *
 * Nothing in this file is on the live path. It is the measurement.
 */
import type { Bar, Side, SymbolSpec, Timeframe, TradeMode } from "../types";
import {
  DEFAULT_ALPHA_CONFIG,
  breakEvenHitRate,
  evaluateOutcome,
  standardError,
  wilsonInterval,
  type AlphaConfig,
} from "../alpha/edge";
import { ALPHA_LABELS, type AlphaAgent, type AlphaId, type AlphaView } from "../alpha";
import { atrSeries } from "../math";

/** Bars between decisions. Every 3 bars is fine-grained without being wasteful. */
export const DEFAULT_ALPHA_STRIDE = 3;

export interface AlphaSample {
  /** Index of the decision bar. */
  index: number;
  direction: Side;
  /** The probability the agent stated. */
  probability: number;
  /** Occurrences the agent's own estimate rested on. */
  samples: number;
  /** The random-entry baseline the agent was shrunk toward at this decision. */
  baseline: number;
  /** Did the move reach rr × the structural stop before the stop? */
  hit: boolean;
}

export interface AlphaMeasurement {
  agent: AlphaId;
  label: string;
  /** What this measurement was taken on. */
  series: string;
  kind: string;
  symbol: string;
  mode: TradeMode;
  frame: Timeframe;
  evaluations: number;
  /** Decisions where the agent had a view AND enough samples to state one. */
  views: number;
  viewRate: number;
  hits: number;
  hitRate: number;
  /** Wilson 95% interval for the hit rate — the honest bound. */
  hitRateLower: number;
  hitRateUpper: number;
  breakEven: number;
  /**
   * The MEASURED random-entry hit rate for the identical geometry AND the same
   * direction — the number a setup has to beat. `breakEven` is only a stand-in
   * for it when there is no history to measure.
   */
  baselineRate: number;
  baselineOutcomes: number;
  /** Views taken long and short (the mix the baseline is matched against). */
  buyViews: number;
  sellViews: number;
  /** hitRate − baselineRate. */
  edgeOverBaseline: number;
  /** The reward:risk the hit rate is denominated in (the desk's floor). */
  rr: number;
  meanProbability: number;
  /** meanProbability − hitRate: positive means the agent over-promises. */
  probabilityGap: number;
  brier: number;
  /** Skill against the constant break-even forecast (not the base rate). */
  brierSkill: number;
  meanSamples: number;
  meanStrength: number;
  /** The same three numbers split by third of the series. */
  byThird: { third: 0 | 1 | 2; views: number; hitRate: number; meanProbability: number }[];
  elapsedMs: number;
}

export function emptyAlphaMeasurement(
  agent: AlphaId,
  meta: { series: string; kind: string; symbol: string; mode: TradeMode; frame: Timeframe; evaluations: number },
): AlphaMeasurement {
  return {
    agent,
    label: ALPHA_LABELS[agent],
    series: meta.series,
    kind: meta.kind,
    symbol: meta.symbol,
    mode: meta.mode,
    frame: meta.frame,
    evaluations: meta.evaluations,
    views: 0,
    viewRate: 0,
    hits: 0,
    hitRate: 0,
    hitRateLower: 0,
    hitRateUpper: 1,
    breakEven: breakEvenHitRate(DEFAULT_ALPHA_CONFIG.rr),
    baselineRate: 0,
    baselineOutcomes: 0,
    buyViews: 0,
    sellViews: 0,
    edgeOverBaseline: 0,
    rr: DEFAULT_ALPHA_CONFIG.rr,
    meanProbability: 0,
    probabilityGap: 0,
    brier: 1,
    brierSkill: -1,
    meanSamples: 0,
    meanStrength: 0,
    byThird: [
      { third: 0, views: 0, hitRate: 0, meanProbability: 0 },
      { third: 1, views: 0, hitRate: 0, meanProbability: 0 },
      { third: 2, views: 0, hitRate: 0, meanProbability: 0 },
    ],
    elapsedMs: 0,
  };
}

export interface MeasureAlphaInput {
  agent: AlphaAgent;
  bars: Bar[];
  frame: Timeframe;
  symbol: string;
  spec: SymbolSpec;
  mode: TradeMode;
  series: string;
  kind: string;
  stride?: number;
  warmupBars?: number;
  cfg?: AlphaConfig;
  /**
   * How long each decision bar is (ms). A bar is only visible once its own width
   * has elapsed, exactly as `closedBarsAt` decides in the harness.
   */
  frameWidthMs: number;
}

/**
 * Walk the series once and measure one agent.
 *
 * The agent keeps its own edge table across decisions (the cache), which is what
 * makes a view possible at all — and it is causal by construction: the table
 * only ever contains setups whose outcome window closed strictly before the
 * decision bar (`edge.ts`).
 */
export function measureAlpha(input: MeasureAlphaInput): AlphaMeasurement {
  const started = Date.now();
  const { agent, bars, frame, symbol, spec, mode } = input;
  const stride = Math.max(1, input.stride ?? DEFAULT_ALPHA_STRIDE);
  const cfg = input.cfg ?? DEFAULT_ALPHA_CONFIG;
  const horizonBars = cfg.horizonBars[mode];
  const warmup = Math.max(60, input.warmupBars ?? Math.max(120, agent.minBars));
  const meta = { series: input.series, kind: input.kind, symbol, mode, frame, evaluations: 0 };
  const measurement = emptyAlphaMeasurement(agent.id, meta);

  const cache = new Map<string, unknown>();
  const atrValues = atrSeries(bars, 14);
  const lastDecision = bars.length - horizonBars - 2;
  if (lastDecision <= warmup) return measurement;

  const samples: AlphaSample[] = [];
  let evaluations = 0;
  for (let i = warmup; i <= lastDecision; i += stride) {
    evaluations++;
    const visible = bars.slice(0, i + 1);
    const now = (bars[i] as Bar)[0] + input.frameWidthMs;
    const close = (bars[i] as Bar)[4] as number;
    const view: AlphaView | null = agent.view({
      symbol,
      mode,
      spec,
      series: { [frame]: visible } as Partial<Record<Timeframe, Bar[]>>,
      quote: {
        symbol,
        bid: close,
        ask: close + spec.spreadPoints * spec.point,
        spreadPoints: spec.spreadPoints,
        ts: now,
        ageMs: 100,
      },
      now,
      cache,
    });
    if (!view) continue;
    const stopDistance = Math.abs(view.entry - (view.stop ?? view.entry - cfg.stopAtr[mode] * (atrValues[i] as number)));
    const hit = evaluateOutcome({
      bars,
      index: i,
      direction: view.direction,
      entry: view.entry,
      stopDistance,
      rr: view.rr,
      horizonBars: view.horizonBars,
    });
    samples.push({
      index: i,
      direction: view.direction,
      probability: view.probability,
      samples: view.samples,
      baseline: view.baselineRate,
      hit,
    });
  }

  measurement.evaluations = evaluations;
  measurement.views = samples.length;
  measurement.viewRate = evaluations === 0 ? 0 : samples.length / evaluations;
  measurement.hits = samples.filter((s) => s.hit).length;
  measurement.hitRate = samples.length === 0 ? 0 : measurement.hits / samples.length;
  const interval = wilsonInterval(measurement.hits, samples.length);
  measurement.hitRateLower = interval.lower;
  measurement.hitRateUpper = interval.upper;
  measurement.breakEven = breakEvenHitRate(cfg.rr);
  measurement.rr = cfg.rr;
  measurement.baselineRate =
    samples.length === 0 ? 0 : samples.reduce((a, s) => a + s.baseline, 0) / samples.length;
  measurement.buyViews = samples.filter((s) => s.direction === "buy").length;
  measurement.sellViews = samples.length - measurement.buyViews;
  measurement.edgeOverBaseline = measurement.hitRate - measurement.baselineRate;
  measurement.meanProbability =
    samples.length === 0 ? 0 : samples.reduce((a, s) => a + s.probability, 0) / samples.length;
  measurement.probabilityGap = measurement.meanProbability - measurement.hitRate;
  measurement.meanSamples = samples.length === 0 ? 0 : samples.reduce((a, s) => a + s.samples, 0) / samples.length;
  measurement.meanStrength =
    samples.length === 0 ? 0 : samples.reduce((a, s) => a + (s.probability - measurement.breakEven), 0) / samples.length;

  // Brier score of the stated probability, against the constant break-even
  // forecast — the forecast a desk that knows nothing would make.
  if (samples.length > 0) {
    const brier = samples.reduce((a, s) => a + (s.probability - (s.hit ? 1 : 0)) ** 2, 0) / samples.length;
    const reference = samples.reduce((a, s) => a + (measurement.breakEven - (s.hit ? 1 : 0)) ** 2, 0) / samples.length;
    measurement.brier = brier;
    measurement.brierSkill = reference > 0 ? 1 - brier / reference : 0;
  }

  const thirdOf = (index: number): 0 | 1 | 2 => {
    const fraction = index / Math.max(1, bars.length - 1);
    return fraction < 1 / 3 ? 0 : fraction < 2 / 3 ? 1 : 2;
  };
  const buckets = [0, 1, 2].map((third) => samples.filter((s) => thirdOf(s.index) === third));
  measurement.byThird = buckets.map((bucket, third) => ({
    third: third as 0 | 1 | 2,
    views: bucket.length,
    hitRate: bucket.length === 0 ? 0 : bucket.filter((s) => s.hit).length / bucket.length,
    meanProbability: bucket.length === 0 ? 0 : bucket.reduce((a, s) => a + s.probability, 0) / bucket.length,
  }));
  measurement.elapsedMs = Date.now() - started;
  return measurement;
}

/**
 * Pool several series into one measurement.
 *
 * A single 3000-bar series is not enough decisions to test a hit rate: a
 * detector that fires on 1% of bars produces ~30 views per series, and a 95%
 * interval on 30 views is ±16 points — wider than any edge worth having. The
 * study therefore runs several independent series per fixture and the GATES are
 * decided on the pool, while every series is still reported on its own so a
 * result that lives in one seed cannot hide in an average.
 */
export function poolAlphaMeasurements(measurements: AlphaMeasurement[]): AlphaMeasurement {
  const first = measurements[0] as AlphaMeasurement;
  const pooled: AlphaMeasurement = {
    ...first,
    series: measurements.map((m) => m.series).join(", "),
    kind: [...new Set(measurements.map((m) => m.kind))].join(","),
    evaluations: measurements.reduce((a, m) => a + m.evaluations, 0),
    views: measurements.reduce((a, m) => a + m.views, 0),
    hits: measurements.reduce((a, m) => a + m.hits, 0),
    buyViews: measurements.reduce((a, m) => a + m.buyViews, 0),
    sellViews: measurements.reduce((a, m) => a + m.sellViews, 0),
    elapsedMs: measurements.reduce((a, m) => a + m.elapsedMs, 0),
  };
  pooled.viewRate = pooled.evaluations === 0 ? 0 : pooled.views / pooled.evaluations;
  pooled.hitRate = pooled.views === 0 ? 0 : pooled.hits / pooled.views;
  const interval = wilsonInterval(pooled.hits, pooled.views);
  pooled.hitRateLower = interval.lower;
  pooled.hitRateUpper = interval.upper;
  const weight = pooled.views === 0 ? 0 : 1 / pooled.views;
  pooled.meanProbability = measurements.reduce((a, m) => a + m.meanProbability * m.views, 0) * weight;
  pooled.baselineRate = measurements.reduce((a, m) => a + m.baselineRate * m.views, 0) * weight;
  pooled.meanSamples = measurements.reduce((a, m) => a + m.meanSamples * m.views, 0) * weight;
  pooled.meanStrength = measurements.reduce((a, m) => a + m.meanStrength * m.views, 0) * weight;
  pooled.probabilityGap = pooled.meanProbability - pooled.hitRate;
  pooled.edgeOverBaseline = pooled.hitRate - pooled.baselineRate;
  // Brier is pooled on the same weights; the skill reference is recomputed from
  // the pooled hit rate so the two numbers describe one sample, not several.
  pooled.brier = measurements.reduce((a, m) => a + m.brier * m.views, 0) * weight;
  const p = pooled.hitRate;
  const reference = pooled.views === 0 ? 0 : p * (1 - pooled.breakEven) ** 2 + (1 - p) * pooled.breakEven ** 2;
  pooled.brierSkill = reference > 0 ? 1 - pooled.brier / reference : 0;
  const viewsByThird = [0, 1, 2].map((third) =>
    measurements.reduce(
      (acc, m) => {
        const bucket = m.byThird[third] as { views: number; hitRate: number; meanProbability: number };
        return {
          third: third as 0 | 1 | 2,
          views: acc.views + bucket.views,
          hits: acc.hits + bucket.views * bucket.hitRate,
          probability: acc.probability + bucket.views * bucket.meanProbability,
        };
      },
      { third: third as 0 | 1 | 2, views: 0, hits: 0, probability: 0 },
    ),
  );
  pooled.byThird = viewsByThird.map((b) => ({
    third: b.third,
    views: b.views,
    hitRate: b.views === 0 ? 0 : b.hits / b.views,
    meanProbability: b.views === 0 ? 0 : b.probability / b.views,
  }));
  return pooled;
}

// ── The gates ───────────────────────────────────────────────────────────────

export interface AlphaGateResult {
  gate: string;
  pass: boolean;
  measured: number;
  threshold: number;
  detail: string;
}

export interface AlphaGateReport {
  pass: boolean;
  gates: AlphaGateResult[];
}

/** Decisions an agent needs before an edge claim may be judged at all. */
export const ALPHA_MIN_VIEWS = 60;
/**
 * The edge a fixture must show, in points, before it counts as demonstrable.
 *
 * Two conditions must BOTH hold: a floor (three points of hit rate is the
 * smallest edge that survives a retail spread) and statistical separation
 * (`≥ 2 standard errors above the measured random-entry baseline`). An agent
 * cannot pass on a large sample of a one-point edge, nor on a tiny sample of a
 * large one.
 */
export const ALPHA_EDGE_FLOOR = 0.03;
/** How far the stated probability may sit from the realised rate. */
export const ALPHA_PROBABILITY_GAP_MAX = 0.15;
/** On structureless data: the share of decisions an agent may fire on. */
export const ALPHA_NULL_VIEW_RATE_MAX = 0.15;
/**
 * The DRIFTLESS selectivity bar the brief sets for an agent: on a fair coin the
 * detector must fire on no more than 3% of decisions.
 *
 * Deliberately much stricter than the pooled-null bar above, and the gate an
 * agent fails most often. A pattern that occurs on 9% of pure-noise bars is a
 * pattern the market produces for free; a desk arming on it pays the spread nine
 * times as often for the same edge. The WP3 regime gate shows the bar is
 * reachable: it permitted 0.18% of null decisions.
 */
export const ALPHA_DRIFTLESS_VIEW_RATE_MAX = 0.03;
/** Standard errors above baseline that count as "a demonstrable edge" on noise. */
export const ALPHA_NULL_SIGMA = 2;
/** Views below which the null hit-rate test is not decidable. */
export const ALPHA_NULL_MIN_VIEWS = 30;

/**
 * The gate an agent must clear on its own labelled fixture.
 *
 * Three separate claims, each failing in its own way: too little evidence to
 * judge (UNIDENTIFIABLE — a failure, not a pass), an edge that is not
 * demonstrably better than the MEASURED random-entry baseline, and a stated
 * probability that does not describe the hit rate it claims to describe.
 */
export function alphaFixtureGates(measurement: AlphaMeasurement): AlphaGateReport {
  const gates: AlphaGateResult[] = [];
  const enough = measurement.views >= ALPHA_MIN_VIEWS;
  const se = standardError(measurement.hitRate, measurement.views);
  const required = Math.max(ALPHA_EDGE_FLOOR, 2 * se);
  gates.push({
    gate: `alpha: at least ${ALPHA_MIN_VIEWS} views on the fixture (else UNIDENTIFIABLE)`,
    pass: enough,
    measured: measurement.views,
    threshold: ALPHA_MIN_VIEWS,
    detail: `${measurement.views} views in ${measurement.evaluations} decisions (${(measurement.viewRate * 100).toFixed(1)}%) on ${measurement.series}`,
  });
  gates.push({
    gate: "alpha: hit rate beats the measured random-entry baseline (floor 3 points and 2 SE)",
    pass: enough && measurement.edgeOverBaseline >= required,
    measured: measurement.edgeOverBaseline,
    threshold: required,
    detail:
      `${(measurement.hitRate * 100).toFixed(1)}% hit rate on ${measurement.views} views vs a ${(measurement.baselineRate * 100).toFixed(1)}% ` +
      `random-entry baseline in the same direction (edge ${(measurement.edgeOverBaseline * 100).toFixed(1)} points, 95% CI ` +
      `${(measurement.hitRateLower * 100).toFixed(1)}–${(measurement.hitRateUpper * 100).toFixed(1)}%; ${measurement.buyViews} long / ${measurement.sellViews} short)`,
  });
  gates.push({
    gate: `alpha: stated probability within ${(ALPHA_PROBABILITY_GAP_MAX * 100).toFixed(0)} points of the realised hit rate`,
    pass: enough && Math.abs(measurement.probabilityGap) <= ALPHA_PROBABILITY_GAP_MAX,
    measured: measurement.probabilityGap,
    threshold: ALPHA_PROBABILITY_GAP_MAX,
    detail: `states ${(measurement.meanProbability * 100).toFixed(1)}%, realises ${(measurement.hitRate * 100).toFixed(1)}% (gap ${(measurement.probabilityGap * 100).toFixed(1)} points)`,
  });
  gates.push({
    gate: "alpha: Brier skill ≥ 0 against the break-even forecast",
    pass: enough && measurement.brierSkill >= 0,
    measured: measurement.brierSkill,
    threshold: 0,
    detail: `Brier ${measurement.brier.toFixed(4)} (skill ${measurement.brierSkill.toFixed(4)} against the 1:${measurement.rr} constant)`,
  });
  return { pass: gates.every((g) => g.pass), gates };
}

/**
 * The brief's selectivity gate: on a driftless walk, fire on ≤ 3% of decisions.
 *
 * The generator is a fair coin, so any firing is a false positive by
 * construction, and the only question is how often the detector mistakes noise
 * for a setup.
 */
export function alphaDriftlessGates(measurement: AlphaMeasurement): AlphaGateReport {
  const gate: AlphaGateResult = {
    gate: `alpha: fires on ≤ ${(ALPHA_DRIFTLESS_VIEW_RATE_MAX * 100).toFixed(0)}% of driftless decisions`,
    pass: measurement.viewRate <= ALPHA_DRIFTLESS_VIEW_RATE_MAX + 1e-12,
    measured: measurement.viewRate,
    threshold: ALPHA_DRIFTLESS_VIEW_RATE_MAX,
    detail: `${measurement.views} views in ${measurement.evaluations} driftless decisions (${(measurement.viewRate * 100).toFixed(2)}%)`,
  };
  return { pass: gate.pass, gates: [gate] };
}

/**
 * The null gate: what the agent must NOT do on data with no structure.
 *
 * Two things are wrong on the null — firing often (a detector that sees setups
 * everywhere) and being right too often when it does fire (an edge that cannot
 * exist). The second test is `edge ≤ 2 standard errors`, which is sample-size
 * aware: with 60 views a two-point edge is nothing, and with 600 views it is
 * borderline. A fixed margin would have been a different test at every sample
 * size, which is how a gate becomes theatre.
 */
export function alphaNullGates(measurements: AlphaMeasurement[]): AlphaGateReport {
  const pooled = poolAlphaMeasurements(measurements);
  const se = standardError(pooled.hitRate, pooled.views);
  const gates: AlphaGateResult[] = [
    {
      gate: `alpha: fires on ≤ ${(ALPHA_NULL_VIEW_RATE_MAX * 100).toFixed(0)}% of structureless decisions`,
      pass: pooled.viewRate <= ALPHA_NULL_VIEW_RATE_MAX + 1e-12,
      measured: pooled.viewRate,
      threshold: ALPHA_NULL_VIEW_RATE_MAX,
      detail: `${pooled.views} views in ${pooled.evaluations} decisions over ${measurements.length} structureless series`,
    },
  ];
  if (pooled.views >= ALPHA_NULL_MIN_VIEWS) {
    const margin = ALPHA_NULL_SIGMA * se;
    gates.push({
      gate: "alpha: no demonstrable edge on noise (within 2 standard errors of the baseline)",
      pass: pooled.edgeOverBaseline <= margin + 1e-12,
      measured: pooled.edgeOverBaseline,
      threshold: margin,
      detail:
        `${(pooled.hitRate * 100).toFixed(1)}% hit rate on ${pooled.views} null views vs a ${(pooled.baselineRate * 100).toFixed(1)}% baseline ` +
        `(edge ${(pooled.edgeOverBaseline * 100).toFixed(1)} points, 2 SE = ${(margin * 100).toFixed(1)} points)`,
    });
  } else {
    gates.push({
      gate: "alpha: no demonstrable edge on noise — UNIDENTIFIABLE (too few null views); passes only if it barely fired",
      pass: pooled.viewRate <= 0.03 + 1e-12,
      measured: pooled.viewRate,
      threshold: 0.03,
      detail: `${pooled.views} null views is below the ${ALPHA_NULL_MIN_VIEWS} needed to test a hit rate, so the evidence here is the firing rate alone`,
    });
  }
  return { pass: gates.every((g) => g.pass), gates };
}
