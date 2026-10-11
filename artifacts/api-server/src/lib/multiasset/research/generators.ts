/**
 * Desk v4 research harness — data generators (WP2).
 *
 * An edge claim is only meaningful next to the same measurement performed on
 * data that CANNOT contain the edge. This module produces those datasets.
 *
 * ── THE NULLS ────────────────────────────────────────────────────────────────
 *
 *   driftlessRandomWalk   The plainest null: a geometric random walk with zero
 *                         drift. Any strategy that arms here is trading noise,
 *                         and any "profit" is a sample artefact.
 *
 *   blockShuffled         Real returns, resampled in contiguous blocks. Keeps
 *                         the real marginal distribution (fat tails, the actual
 *                         vol level) and the local autocorrelation inside a
 *                         block, destroys anything longer than the block. This
 *                         is the "what if the market had the same texture but
 *                         no exploitable structure" counterfactual.
 *
 *   phaseRandomised       Real returns, Fourier phases randomised. Preserves the
 *                         power spectrum exactly — so every second-order
 *                         statistic (volatility, autocorrelation of magnitude,
 *                         long memory in |r|) is identical — while destroying
 *                         every phase-dependent structure. If a strategy's edge
 *                         survives phase randomisation it was a volatility
 *                         artefact, not an entry signal.
 *
 * ── THE POSITIVE CONTROL ─────────────────────────────────────────────────────
 *
 *   positiveControl       A market with a KNOWN, deliberate edge: a persistent
 *                         regime chain that alternates between a trending state
 *                         (drift in one direction for a long while) and a
 *                         mean-reverting state (an AR(1) residual pulled back to
 *                         a slowly moving level). A pipeline that cannot find
 *                         THIS is broken, and its failure to arm on the nulls
 *                         above proves nothing. This is the single most
 *                         important control in the harness: it separates "the
 *                         desk is cautious" from "the desk is blind".
 *
 * Every generator is driven by the seeded RNG from `math.ts`, so a dataset is
 * reproducible from (kind, seed, parameters) alone — which is what the report
 * stores instead of the bars.
 */

import { gaussian, makeRng } from "../math";
import { fft, nextPowerOfTwo } from "./numerics";
import type { Bar } from "../types";
import type { Dataset } from "./types";
import { specFromPreset } from "./spec";

export type GeneratorKind =
  | "driftless"
  | "block_shuffle"
  | "phase_random"
  | "positive_control";

export const GENERATOR_KINDS: readonly GeneratorKind[] = [
  "driftless",
  "block_shuffle",
  "phase_random",
  "positive_control",
] as const;

export interface GeneratorOptions {
  symbol: string;
  /** Number of M1 bars to produce. */
  bars: number;
  seed: number;
  startPrice: number;
  /** Epoch ms of the first bar. */
  startTs: number;
  /**
   * Per-bar log-return standard deviation, in the same units as a real M1
   * series. 1e-4 is roughly 10 pips of EURUSD range per minute at 1.10 — the
   * defaults below are chosen to sit in the range a real FX feed occupies so
   * the desk's thresholds are exercised at realistic distances.
   */
  barVol: number;
  spreadPoints: number;
  /** Sub-steps per bar used to synthesise the intrabar high/low. */
  subSteps: number;
  /** Continuity: the bar-to-bar drift the desk may (or may not) find. */
  driftPerBar?: number;
}

export const DEFAULT_GENERATOR_OPTIONS: Omit<GeneratorOptions, "symbol" | "seed"> = {
  bars: 60 * 24 * 120, // 120 days of M1, enough for walk-forward folds.
  startPrice: 1.1,
  startTs: Date.UTC(2024, 0, 2, 0, 0),
  barVol: 1e-4,
  spreadPoints: 8,
  subSteps: 6,
  driftPerBar: 0,
};

/** Assemble a Dataset from a close path, synthesising OHLC per bar. */
function datasetFromCloses(input: {
  kind: GeneratorKind;
  closes: number[];
  options: GeneratorOptions;
  notes: string[];
  /** Per-bar absolute price noise for the intrabar path, in price units. */
  stepPrice: number;
  seed: number;
}): Dataset {
  const { closes, options, kind, notes } = input;
  const rng = makeRng(input.seed ^ 0x9e3779b9);
  const bars: Bar[] = [];
  let previousClose = closes[0] ?? options.startPrice;

  for (let i = 0; i < closes.length; i++) {
    const ts = options.startTs + i * 60_000;
    const open = previousClose;
    const close = closes[i]!;
    // Synthesise an intrabar path so high/low are consistent with a real bar:
    // a Brownian bridge from open to close with `subSteps` intermediate points.
    let high = Math.max(open, close);
    let low = Math.min(open, close);
    let current = open;
    const drift = (close - open) / options.subSteps;
    for (let k = 1; k <= options.subSteps; k++) {
      current = current + drift + gaussian(rng) * input.stepPrice;
      if (current > high) high = current;
      if (current < low) low = current;
    }
    // Never let the synthesised range invert the OHLC identities.
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    const digits = Math.max(0, Math.round(-Math.log10(options.spreadPoints * 1e-5)) + 5);
    const round = (value: number) => Number(value.toFixed(Math.min(8, digits)));
    bars.push([
      ts,
      round(open),
      round(high),
      round(low),
      round(close),
      // Tick volume: a plausible constant with mild variation. Only used by the
      // flow agent (WP4-D), which does not run on synthetic data.
      60 + Math.floor(rng() * 40),
    ]);
    previousClose = close;
  }

  const spec = specFromPreset(options.symbol, options.spreadPoints);
  return {
    source: `${kind}:seed=${options.seed}:bars=${options.bars}:vol=${options.barVol}:spread=${options.spreadPoints}`,
    symbol: spec.symbol,
    bars,
    spreadPointsAt: () => options.spreadPoints,
    spec,
    clock: { kind: "utc" },
    notes,
  };
}

/** Log returns of a bar series, computed on closes. */
export function returnsFromBars(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1]![4];
    const b = bars[i]![4];
    out.push(a > 0 && b > 0 ? Math.log(b / a) : 0);
  }
  return out;
}

/** Turn a return series into a close path starting at `startPrice`. */
export function closesFromReturns(returns: number[], startPrice: number): number[] {
  const out: number[] = [startPrice];
  let price = startPrice;
  for (const r of returns) {
    price *= Math.exp(r);
    out.push(price);
  }
  return out;
}

/**
 * THE PRIMARY NULL: a driftless geometric random walk.
 *
 * `driftPerBar` defaults to 0 and should stay there for null testing. Passing a
 * non-zero value turns this into a "random walk with a known constant drift",
 * which is a useful sanity check on its own (the desk should find a large,
 * persistent drift and arm) but is NOT a null.
 */
export function driftlessRandomWalk(options: Partial<GeneratorOptions> & { symbol: string; seed: number }): Dataset {
  const merged: GeneratorOptions = { ...DEFAULT_GENERATOR_OPTIONS, ...options };
  const rng = makeRng(merged.seed);
  const returns: number[] = [];
  for (let i = 0; i < merged.bars; i++) {
    returns.push((merged.driftPerBar ?? 0) + gaussian(rng) * merged.barVol);
  }
  const closes = closesFromReturns(returns, merged.startPrice);
  return datasetFromCloses({
    kind: "driftless",
    closes,
    options: merged,
    seed: merged.seed,
    stepPrice: (merged.startPrice * merged.barVol) / Math.sqrt(merged.subSteps),
    notes: [
      merged.driftPerBar
        ? `Drift per bar ${merged.driftPerBar} (NOT a null — a known-drift sanity check).`
        : "Driftless random walk: zero drift by construction.",
      `barVol ${merged.barVol}, ${merged.subSteps} sub-steps per bar.`,
    ],
  });
}

/**
 * NULL 2: block-shuffled real returns.
 *
 * Blocks of the source series are re-emitted in a random order. Inside a block
 * everything real is preserved — the actual return values, so the tails and the
 * clustering over short windows are exact — while any structure that spans more
 * than `blockLength` bars is destroyed.
 */
export function blockShuffledReturns(input: {
  returns: number[];
  options: Partial<GeneratorOptions> & { symbol: string; seed: number };
  blockLength?: number;
  startPrice?: number;
}): Dataset {
  const merged: GeneratorOptions = { ...DEFAULT_GENERATOR_OPTIONS, ...input.options };
  const blockLength = Math.max(1, input.blockLength ?? 60);
  const rng = makeRng(merged.seed);
  const source = input.returns;
  if (source.length < blockLength * 2) {
    throw new Error(
      `blockShuffledReturns: source has ${source.length} returns, too few for blocks of ${blockLength}`,
    );
  }
  const blockStarts: number[] = [];
  for (let i = 0; i + blockLength <= source.length; i += blockLength) blockStarts.push(i);
  // Fisher-Yates on the block order, driven by the seeded RNG.
  for (let i = blockStarts.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [blockStarts[i], blockStarts[j]] = [blockStarts[j]!, blockStarts[i]!];
  }
  const shuffled: number[] = [];
  for (const start of blockStarts) {
    for (let k = 0; k < blockLength; k++) shuffled.push(source[start + k]!);
  }
  const limited = shuffled.slice(0, merged.bars);
  const startPrice = input.startPrice ?? merged.startPrice;
  const closes = closesFromReturns(limited, startPrice);
  return datasetFromCloses({
    kind: "block_shuffle",
    closes,
    options: { ...merged, bars: limited.length },
    seed: merged.seed,
    stepPrice: (startPrice * merged.barVol) / Math.sqrt(merged.subSteps),
    notes: [
      `Block-shuffled real returns, block length ${blockLength} bars.`,
      "Marginal distribution and short-range clustering preserved; longer structure destroyed.",
    ],
  });
}

/**
 * NULL 3: phase-randomised real returns (the IAAFT-free "surrogate" null).
 *
 * The Fourier transform of the return series is kept in magnitude and given
 * uniform random phases, then inverted. The autocorrelation function is
 * unchanged by construction — so any statistic based on second moments,
 * including volatility clustering measured by ACF of squared returns, matches
 * the real series exactly — while any phase-dependent (i.e. genuinely
 * predictive, direction-aware) structure is removed.
 */
export function phaseRandomisedReturns(input: {
  returns: number[];
  options: Partial<GeneratorOptions> & { symbol: string; seed: number };
  startPrice?: number;
}): Dataset {
  const merged: GeneratorOptions = { ...DEFAULT_GENERATOR_OPTIONS, ...input.options };
  const rng = makeRng(merged.seed);
  const source = input.returns.slice(0, merged.bars);
  if (source.length < 16) {
    throw new Error("phaseRandomisedReturns: need at least 16 returns");
  }

  // Zero-mean the series so the DC term does not pin the phases.
  const m = source.reduce((acc, v) => acc + v, 0) / source.length;
  const centred = source.map((v) => v - m);
  const size = nextPowerOfTwo(centred.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < centred.length; i++) re[i] = centred[i]!;
  fft(re, im, false);

  // Randomise phases, keeping magnitudes. Nyquist and DC are left real.
  const half = size / 2;
  const phases: number[] = [];
  for (let k = 0; k <= half; k++) phases.push(rng() * 2 * Math.PI);
  for (let k = 0; k <= half; k++) {
    const magnitude = Math.hypot(re[k]!, im[k]!);
    const angle = phases[k]!;
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    re[k] = magnitude * cosAngle;
    im[k] = magnitude * sinAngle;
    if (k > 0 && k < half) {
      // Hermitian symmetry keeps the inverse transform real.
      re[size - k] = magnitude * cosAngle;
      im[size - k] = -magnitude * sinAngle;
    }
  }
  im[0] = 0;
  im[half] = 0;
  fft(re, im, true);

  const randomised: number[] = [];
  for (let i = 0; i < centred.length; i++) randomised.push(re[i]! + m);
  const startPrice = input.startPrice ?? merged.startPrice;
  const closes = closesFromReturns(randomised, startPrice);
  return datasetFromCloses({
    kind: "phase_random",
    closes,
    options: { ...merged, bars: randomised.length },
    seed: merged.seed,
    stepPrice: (startPrice * merged.barVol) / Math.sqrt(merged.subSteps),
    notes: [
      "Phase-randomised real returns: power spectrum preserved, phases uniform.",
      "Any edge found here is a second-moment artefact, not a directional signal.",
    ],
  });
}

export interface PositiveControlOptions extends Partial<GeneratorOptions> {
  symbol: string;
  seed: number;
  /**
   * Probability of leaving the current regime per bar. 1/900 gives an expected
   * episode of 900 M1 bars (15 hours) — long enough that a strategy needs real
   * persistence detection rather than a momentum blip, short enough that a
   * 120-day sample contains ~190 episodes.
   */
  regimeSwitchProbability?: number;
  /** Trend-state drift per bar, in log-return units. */
  trendDriftPerBar?: number;
  /** AR(1) coefficient of the mean-reverting residual. */
  ar1Phi?: number;
}

/**
 * THE POSITIVE CONTROL: a market with a known, exploitable edge.
 *
 * Two persistent regimes:
 *
 *   trend  — a constant drift whose sign persists for the whole episode. A
 *            trend-following entry with a wide stop should make money here.
 *   range  — the price is pulled back toward a slowly moving level by an AR(1)
 *            residual. A mean-reversion entry should make money here.
 *
 * The point of the control is NOT that the desk must profit — it is that a
 * pipeline which arms at ≤3% on the nulls must still arm ≥10% here, or its
 * caution is indistinguishable from blindness.
 */
export function positiveControl(
  options: PositiveControlOptions,
): Dataset & { regimeLabels: number[] } {
  const merged: GeneratorOptions = { ...DEFAULT_GENERATOR_OPTIONS, ...options };
  const rng = makeRng(merged.seed ^ 0x5bd1e995);
  const switchProbability = options.regimeSwitchProbability ?? 1 / 900;
  const trendDrift = options.trendDriftPerBar ?? merged.barVol * 0.6;
  const phi = options.ar1Phi ?? 0.9;

  const returns: number[] = [];
  const labels: number[] = [];
  let regime: 0 | 1 = 1; // start in the range state
  let trendSign = 1;
  let residual = 0;
  // Stationary standard deviation of an AR(1): sigma / sqrt(1 - phi^2).
  const ar1Sigma = merged.barVol * Math.sqrt(1 - phi * phi);

  for (let i = 0; i < merged.bars; i++) {
    if (rng() < switchProbability) {
      regime = regime === 1 ? 0 : 1;
      if (regime === 0) trendSign = rng() < 0.5 ? -1 : 1;
    }
    labels.push(regime);
    const shock = gaussian(rng) * merged.barVol;
    if (regime === 0) {
      // Trend: persistent drift, the residual is just the shock.
      residual = shock;
      returns.push(trendSign * trendDrift + shock * 0.8);
    } else {
      // Range: AR(1) residual around the current level, no drift.
      residual = phi * residual + ar1Sigma * gaussian(rng);
      returns.push(shock * 0.5 - residual * (1 - phi));
    }
  }

  const closes = closesFromReturns(returns, merged.startPrice);
  const dataset = datasetFromCloses({
    kind: "positive_control",
    closes,
    options: merged,
    seed: merged.seed,
    stepPrice: (merged.startPrice * merged.barVol) / Math.sqrt(merged.subSteps),
    notes: [
      `Positive control: regime-switching drift (${trendDrift.toExponential(2)}/bar, persistent sign)`,
      `plus AR(1) mean reversion (phi=${phi}) in the range state.`,
      `Switch probability ${switchProbability.toExponential(2)} per bar.`,
      "A pipeline that cannot arm here must not be trusted to reject the nulls.",
    ],
  });
  return { ...dataset, regimeLabels: labels };
}

/** Build the requested generator from a CLI-style identifier. */
export function generate(
  kind: GeneratorKind,
  options: Partial<GeneratorOptions> & { symbol: string; seed: number },
  sourceReturns?: number[],
): Dataset {
  switch (kind) {
    case "driftless":
      return driftlessRandomWalk(options);
    case "block_shuffle":
      if (!sourceReturns) {
        throw new Error("block_shuffle requires real returns (--returns <csv> or --data <bars.csv>)");
      }
      return blockShuffledReturns({ returns: sourceReturns, options });
    case "phase_random":
      if (!sourceReturns) {
        throw new Error("phase_random requires real returns (--returns <csv> or --data <bars.csv>)");
      }
      return phaseRandomisedReturns({ returns: sourceReturns, options });
    case "positive_control":
      return positiveControl(options);
  }
}
