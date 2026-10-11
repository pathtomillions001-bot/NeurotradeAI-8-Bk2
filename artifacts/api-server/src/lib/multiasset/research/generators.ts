/**
 * Research harness — the null and positive-control generators (WP2).
 *
 * ── WHY THIS FILE IS THE FOUNDATION ─────────────────────────────────────────
 *
 * A backtest on real data answers "did this make money in the past". It does
 * NOT answer the only question that matters before arming a live plan: "is the
 * thing I am measuring actually an edge, or is it a property of my own
 * pipeline?" The v3 desk failed that question comprehensively — on 600 windows
 * of pure noise it reported a median confidence of 65.6 (the bar was 60), 90%
 * of windows had ≥3 of 7 "agreeing" families, and it predicted E = +0.46R
 * while a forward simulation of what the EA actually did realised −0.50R.
 *
 * So every agent and every threshold in v4 is judged on THREE families of data:
 *
 *   NULL — driftless random walk, block-shuffled returns, phase-randomised
 *          returns. There is no exploitable structure by construction, so any
 *          "edge" the desk reports on them is a MEASUREMENT ERROR in the desk.
 *          The gates are absolute: arm rate ≤ 3%, mean realised R ≥ −(cost+0.05),
 *          and at most 5% of runs may look DSR-significant.
 *
 *   REAL — real broker history (MT5 M1/tick export). Answers "does this exist
 *          in this market", and is the only place parameters are ever tuned.
 *
 *   POSITIVE CONTROL — regime-switching drift plus an AR(1) mean-reverting
 *          residual: a series with a KNOWN, persistent, exploitable edge. An
 *          agent that cannot find THIS has a broken detector, and its silence
 *          on real data proves nothing.
 *
 * Both directions matter. A detector that fires on noise is dangerous; a
 * detector that never fires at all is a very expensive way to do nothing, and
 * without the positive control the two are indistinguishable.
 *
 * Everything here is deterministic (seeded `makeRng` only).
 */

import { gaussian, makeRng, mean, stdev } from "../math";
import type { Bar, Timeframe } from "../types";

export type GeneratorKind =
  | "driftless"
  | "block-shuffled"
  | "phase-randomised"
  | "positive-control"
  | "three-regime";

export interface GeneratorSpec {
  /** Bars to produce. */
  bars: number;
  seed: number;
  /** Starting price of the series. */
  startPrice: number;
  /** Per-bar volatility of log returns (e.g. 0.001 = 10 bp). */
  volatility: number;
  /** Epoch ms of the first bar's OPEN. */
  startMs: number;
  /** Bar width in ms. */
  timeframeMs: number;
  /** Historical returns to shuffle/phase-randomise (null generators). */
  returns?: number[];
  /**
   * Positive control: per-bar drift in each regime, and the AR(1) coefficient
   * of the mean-reverting residual. The defaults are deliberately modest — a
   * control that is trivially detectable proves nothing about a detector's
   * sensitivity.
   */
  driftHigh?: number;
  driftLow?: number;
  ar1?: number;
  /** Volatility of the range regime, as a multiple of `volatility`. */
  rangeVolScale?: number;
  /** Persistence of the three-regime chain (per bar). */
  regimePStay?: number;
}

export interface SyntheticSeries {
  kind: GeneratorKind;
  bars: Bar[];
  /** The log returns the bars were built from (length = bars − 1). */
  returns: number[];
  /** Regime label per bar, for the positive control. */
  regime?: ("high" | "low")[];
  /**
   * Ground-truth regime label per bar, for generators that have one.
   *
   * A labelled series is the only way to measure a regime detector's accuracy
   * honestly: without it, "the model found three clusters" is unfalsifiable.
   */
  regimeLabels?: ThreeRegimeLabel[];
}

/** The three regimes of the labelled control: an up-trend, a down-trend, a range. */
export type ThreeRegimeLabel = "bull" | "bear" | "range";

/** Symmetric wick as a fraction of the bar's own body plus a volatility floor. */
const WICK_FRACTION = 0.35;

/** Build OHLC bars from a log-return series. Deterministic, no RNG. */
export function barsFromReturns(input: {
  returns: number[];
  startPrice: number;
  startMs: number;
  timeframeMs: number;
  volatility: number;
}): Bar[] {
  const { returns, startPrice, startMs, timeframeMs, volatility } = input;
  const bars: Bar[] = [];
  let price = startPrice;
  // Bar 0 is the seed bar (the first log return applies to bar 1).
  bars.push([startMs, price, price, price, price, 100]);
  for (let i = 0; i < returns.length; i++) {
    const open = price;
    const close = open * Math.exp(returns[i] as number);
    const body = Math.abs(close - open);
    const wick = body * WICK_FRACTION + Math.max(open, close) * volatility * 0.5;
    bars.push([
      startMs + (i + 1) * timeframeMs,
      open,
      Math.max(open, close) + wick,
      Math.min(open, close) - wick,
      close,
      100,
    ]);
    price = close;
  }
  return bars;
}

/** A driftless random walk: the canonical null. */
export function driftlessWalk(spec: GeneratorSpec): SyntheticSeries {
  const rng = makeRng(spec.seed);
  const returns: number[] = [];
  for (let i = 0; i < spec.bars; i++) returns.push(spec.volatility * gaussian(rng));
  return {
    kind: "driftless",
    returns,
    bars: barsFromReturns({ ...spec, returns }),
  };
}

/**
 * Block-shuffled returns.
 *
 * Permuting the ORDER of real returns destroys every form of temporal
 * dependence (momentum, mean reversion, volatility clustering) while keeping
 * the marginal distribution — the fat tails, the skew, the scale — exactly.
 * An agent that works on the ordered series and also on the shuffled one is
 * exploiting the marginal distribution, not time.
 */
export function blockShuffle(input: {
  returns: number[];
  blockSize: number;
  seed: number;
}): number[] {
  const { returns, blockSize, seed } = input;
  const rng = makeRng(seed);
  const blocks: number[][] = [];
  for (let i = 0; i < returns.length; i += blockSize) {
    blocks.push(returns.slice(i, i + blockSize));
  }
  // Fisher–Yates, driven by the seeded RNG.
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = blocks[i] as number[];
    blocks[i] = blocks[j] as number[];
    blocks[j] = a;
  }
  return blocks.flat();
}

/**
 * Phase-randomised returns (the surrogate-data null of Theiler et al.).
 *
 * The amplitude spectrum is preserved exactly and the Fourier phases are
 * randomised, so the autocorrelation function — and therefore any LINEAR
 * temporal structure — survives, while non-linear structure does not. It is
 * the strictest of the three nulls for a momentum or regime detector: those
 * look at the shape of a move, not just its variance, and shape is what this
 * removes.
 *
 * Implemented with an in-repo radix-2 FFT (no dependencies) on the first
 * power-of-two-length prefix of the series, with the DC term zeroed so the
 * surrogate is driftless.
 */
export function phaseRandomise(input: { returns: number[]; seed: number }): number[] {
  const { returns, seed } = input;
  const n = 1 << Math.floor(Math.log2(Math.max(2, returns.length)));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const drift = mean(returns.slice(0, n));
  for (let i = 0; i < n; i++) {
    re[i] = (returns[i] as number) - drift;
    im[i] = 0;
  }
  fft(re, im, false);

  const rng = makeRng(seed);
  // Randomise phases of the positive-frequency bins, mirror for Hermitian
  // symmetry so the inverse transform is real.
  for (let k = 1; k < n / 2; k++) {
    const magnitude = Math.hypot(re[k] as number, im[k] as number);
    const phase = 2 * Math.PI * rng();
    re[k] = magnitude * Math.cos(phase);
    im[k] = magnitude * Math.sin(phase);
    re[n - k] = magnitude * Math.cos(phase);
    im[n - k] = -magnitude * Math.sin(phase);
  }
  // Nyquist bin must stay real.
  im[n / 2] = 0;
  // Zero the DC term: a surrogate with the original's mean would carry drift,
  // and drift is exactly what a trend agent is allowed to detect.
  re[0] = 0;
  im[0] = 0;

  fft(re, im, true);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(re[i] as number);
  return out;
}

/** In-place radix-2 FFT. `inverse` divides by n. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k] as number;
        const ui = im[i + k] as number;
        const vr = (re[i + k + len / 2] as number) * cr - (im[i + k + len / 2] as number) * ci;
        const vi = (re[i + k + len / 2] as number) * ci + (im[i + k + len / 2] as number) * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] as number) / n;
      im[i] = (im[i] as number) / n;
    }
  }
}

/**
 * The POSITIVE CONTROL: a series with a known, persistent edge.
 *
 * Two mechanisms, both of which the v4 pipeline claims to detect:
 *
 *   1. a two-state regime-switching drift (a Markov chain between a strong
 *      positive drift and a mild negative one) — this is what the HMM regime
 *      agent and the trend agent are for;
 *   2. an AR(1) mean-reverting residual — this is what the mean-reversion agent
 *      is for, and it is deliberately sized so its half-life is a handful of
 *      bars.
 *
 * A detector that cannot arm on this, or cannot make money on it, is broken.
 */
export function positiveControl(spec: GeneratorSpec): SyntheticSeries {
  const driftHigh = spec.driftHigh ?? spec.volatility * 0.35;
  const driftLow = spec.driftLow ?? -spec.volatility * 0.1;
  const ar1 = spec.ar1 ?? 0.75;
  const rng = makeRng(spec.seed);
  const returns: number[] = [];
  const regime: ("high" | "low")[] = [];
  let state: "high" | "low" = "high";
  let residual = 0;
  // Mean dwell ~40 bars in each regime: long enough for a trend agent to be
  // able to measure it, short enough that it must adapt.
  const pStayHigh = 0.975;
  const pStayLow = 0.94;
  for (let i = 0; i < spec.bars; i++) {
    state = state === "high"
      ? (rng() < pStayHigh ? "high" : "low")
      : (rng() < pStayLow ? "low" : "high");
    regime.push(state);
    // AR(1) mean-reverting component (stationary, so it is NOT a random walk).
    residual = ar1 * residual + spec.volatility * 0.6 * gaussian(rng);
    const drift = state === "high" ? driftHigh : driftLow;
    returns.push(drift + residual - ar1 * residual + spec.volatility * 0.8 * gaussian(rng));
  }
  return {
    kind: "positive-control",
    returns,
    regime,
    bars: barsFromReturns({ ...spec, returns }),
  };
}

/**
 * The LABELLED three-regime series — the ground truth for WP3's accuracy gate.
 *
 * Three states with a realistic dwell (p_stay 0.99 ⇒ ~100 bars) and moderate
 * separation: a +0.6σ drift in the bull, −0.6σ in the bear, and a range that
 * drifts nowhere but is half as volatile. Deliberately not trivially separable
 * — a detector that only notices "big move up" or "big move down" confuses the
 * range with whichever trend it sits next to — but separable enough that a
 * competent causal detector can clear the 80% gate. The regime tests measure
 * the SUPERVISED ceiling of the same series alongside the fitted accuracy, so a
 * failure of identifiability can never be disguised as a modelling failure (or
 * the other way round).
 */
export function threeRegime(spec: GeneratorSpec): SyntheticSeries & { regimeLabels: ThreeRegimeLabel[] } {
  const rng = makeRng(spec.seed);
  const bullDrift = spec.driftHigh ?? spec.volatility * 0.6;
  const bearDrift = spec.driftLow ?? -spec.volatility * 0.6;
  const rangeVolScale = spec.rangeVolScale ?? 0.5;
  // p_stay 0.99 ⇒ a ~100-bar regime: on 15-minute bars that is a day-long
  // character, which is what "regime" means in practice. It also keeps the
  // test FAIR: a causal detector needs several bars of evidence to notice a
  // switch, so a 33-bar regime makes ~20% of bars unrecoverable by ANY causal
  // filter and the 80% accuracy gate would measure the generator, not the
  // detector. The tests report the supervised ceiling next to the fitted
  // accuracy so that distinction can never be blurred.
  const pStay = spec.regimePStay ?? 0.99;
  const returns: number[] = [];
  const regimeLabels: ThreeRegimeLabel[] = [];
  let state: ThreeRegimeLabel = "bull";
  for (let i = 0; i < spec.bars; i++) {
    if (rng() >= pStay) {
      // Move to one of the other two, equally likely.
      const others = (["bull", "bear", "range"] as ThreeRegimeLabel[]).filter((s) => s !== state);
      state = rng() < 0.5 ? (others[0] as ThreeRegimeLabel) : (others[1] as ThreeRegimeLabel);
    }
    regimeLabels.push(state);
    const drift = state === "bull" ? bullDrift : state === "bear" ? bearDrift : 0;
    const scale = state === "range" ? rangeVolScale : 1;
    returns.push(drift + spec.volatility * scale * gaussian(rng));
  }
  return {
    kind: "three-regime",
    returns,
    regimeLabels,
    bars: barsFromReturns({ ...spec, returns }),
  };
}

/**
 * Build any generator by name. Real data is loaded by loader.ts instead.
 *
 * The spec is merged over `DEFAULT_GENERATOR_SPEC` and then VALIDATED: a spec
 * missing `startPrice` (or `volatility`) produced a series of NaN bars, which
 * is the most dangerous possible study input — every statistic comes out
 * finite-looking or silently zero, and the run "passes". A generator that
 * cannot produce a usable series must throw, not shrug.
 */
export function generate(kind: GeneratorKind, spec: Partial<GeneratorSpec> & { seed: number }): SyntheticSeries {
  const full: GeneratorSpec = { ...DEFAULT_GENERATOR_SPEC, ...spec };
  if (!Number.isFinite(full.startPrice) || full.startPrice <= 0) {
    throw new Error(`generate(${kind}): startPrice must be a positive number (got ${String(full.startPrice)})`);
  }
  if (!Number.isFinite(full.volatility) || full.volatility <= 0) {
    throw new Error(`generate(${kind}): volatility must be a positive number (got ${String(full.volatility)})`);
  }
  if (!Number.isFinite(full.startMs)) throw new Error(`generate(${kind}): startMs must be an epoch ms number`);
  if (!Number.isFinite(full.timeframeMs) || full.timeframeMs <= 0) {
    throw new Error(`generate(${kind}): timeframeMs must be positive (got ${String(full.timeframeMs)})`);
  }
  if (!Number.isFinite(full.bars) || full.bars < 2) {
    throw new Error(`generate(${kind}): bars must be at least 2 (got ${String(full.bars)})`);
  }
  const series = generateUnchecked(kind, full);
  for (const bar of series.bars) {
    if (!Number.isFinite(bar[4]) || !Number.isFinite(bar[1]) || (bar[4] as number) <= 0) {
      throw new Error(`generate(${kind}): produced a non-finite bar — refusing to return a series that cannot be studied`);
    }
  }
  return series;
}

function generateUnchecked(kind: GeneratorKind, full: GeneratorSpec): SyntheticSeries {
  const spec = full;
  switch (kind) {
    case "driftless":
      return driftlessWalk(spec);
    case "positive-control":
      return positiveControl(spec);
    case "block-shuffled": {
      const source = spec.returns ?? driftlessWalk(spec).returns;
      const returns = blockShuffle({ returns: source, blockSize: 10, seed: spec.seed ^ 0x9e3779b9 });
      return { kind, returns, bars: barsFromReturns({ ...spec, returns }) };
    }
    case "phase-randomised": {
      const source = spec.returns ?? driftlessWalk(spec).returns;
      const returns = phaseRandomise({ returns: source, seed: spec.seed ^ 0x85ebca6b });
      return { kind, returns, bars: barsFromReturns({ ...spec, returns }) };
    }
    case "three-regime":
      return threeRegime(spec);
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown generator: ${String(exhaustive)}`);
    }
  }
}

/** Defaults used by the CLI and the tests, so they measure the same thing. */
export const DEFAULT_GENERATOR_SPEC: Omit<GeneratorSpec, "seed"> = {
  bars: 1200,
  startPrice: 1.1,
  volatility: 0.0008,
  startMs: Date.UTC(2026, 0, 5, 0, 0, 0),
  timeframeMs: 15 * 60_000,
};

/** A convenience shape for tests: a series plus the timeframe it is on. */
export interface NamedSeries extends SyntheticSeries {
  symbol: string;
  timeframe: Timeframe;
}

export function namedSeries(
  kind: GeneratorKind,
  symbol: string,
  timeframe: Timeframe,
  spec: GeneratorSpec,
): NamedSeries {
  return { ...generate(kind, spec), symbol, timeframe };
}

/** Sanity statistics used by the generator tests. */
export function seriesStats(returns: number[]): {
  mean: number;
  stdev: number;
  lag1: number;
} {
  const m = mean(returns);
  const sd = stdev(returns);
  let num = 0;
  let den = 0;
  for (let i = 1; i < returns.length; i++) {
    num += ((returns[i] as number) - m) * ((returns[i - 1] as number) - m);
  }
  for (let i = 0; i < returns.length; i++) den += ((returns[i] as number) - m) ** 2;
  return { mean: m, stdev: sd, lag1: den === 0 ? 0 : num / den };
}
