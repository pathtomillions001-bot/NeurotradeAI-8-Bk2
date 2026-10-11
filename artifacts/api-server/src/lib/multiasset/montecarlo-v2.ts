/**
 * WP6 — the executed-policy Monte Carlo: GARCH-filtered historical simulation
 * with a stationary block bootstrap.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * The gatekeeper's primary number is `EV_LCB`, which rests on a calibrated
 * probability and a cost. This file answers a different question, from a
 * different direction: **if the desk traded this plan repeatedly in this
 * volatility regime, what does the distribution of its mean R look like — tail
 * included?** The two answers have to agree in sign before the desk arms.
 *
 * ── WHY GARCH-FILTERED HISTORICAL SIMULATION ────────────────────────────────
 *
 * Plain historical resampling reproduces the *average* volatility of the sample
 * and therefore lies exactly when it matters: after a quiet week it hands back
 * the shocks of a busy month, and after a busy week it forgets them. Volatility
 * clusters, and the size of the next few bars depends on the size of the last
 * few.
 *
 * FHS fixes that in the standard three steps:
 *
 *   1. fit a GARCH(1,1) to the recent returns and filter them into
 *      **standardised residuals** `z_t = r_t / σ_t` — a series with (by
 *      construction) roughly constant scale;
 *   2. resample the residual/bar SHAPES with a **stationary block bootstrap**
 *      (Politis–Romano: geometric block lengths, so temporal dependence inside a
 *      block survives and the resample is not i.i.d.);
 *   3. re-scale the resampled shapes by **today's** σ from the same fit.
 *
 * The result is a distribution of forward paths whose volatility level is the
 * current one and whose shapes are real. It is deterministic (a seeded RNG),
 * it uses no external dependency, and the GARCH parameters are fitted here
 * rather than imported from a library so that the report can print them.
 *
 * ── WHY A BLOCK BOOTSTRAP AND NOT AN i.i.d. ONE ─────────────────────────────
 *
 * Draw individual bars independently and every run of consecutive pressure —
 * the thing the desk's stops actually die to — disappears. Blocks of geometric
 * mean length keep stretches of tape together: the same property that makes the
 * WP5 nulls honest makes this tail honest.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * It is not a forecast and it is not a guarantee. It is a resampling of the past
 * under today's volatility. When there is not enough history to fit a GARCH
 * model the function says so (`pathsUsingGarch: false`) and the caller must
 * decide — the gatekeeper refuses, because "we could not measure the tail" is
 * not "the tail is fine".
 */
import { makeRng } from "./math";
import type { Bar } from "./types";
import { tripleBarrier } from "./meta/labels";

/** Grid the GARCH fit searches. Deliberately coarse: a fine grid on 500 points is noise. */
const GARCH_ALPHA_GRID = [0.02, 0.05, 0.08, 0.12, 0.18, 0.25] as const;
const GARCH_BETA_GRID = [0.6, 0.7, 0.78, 0.84, 0.88, 0.92] as const;
/** Below this many returns a GARCH fit is not attempted. */
export const MIN_GARCH_RETURNS = 120;
/** Residuals outside this magnitude are clipped before resampling. */
export const MAX_ABS_RESIDUAL = 6;

export interface GarchParams {
  omega: number;
  alpha: number;
  beta: number;
  /** Gaussian log-likelihood of the fitted recursion. */
  logLikelihood: number;
  /** Unconditional volatility implied by the fit: sqrt(omega / (1 - alpha - beta)). */
  unconditionalVolatility: number;
  /** Today's filtered volatility: the level the resampled shapes are scaled to. */
  currentVolatility: number;
  /**
   * The sample mean of the returns the fit saw.
   *
   * The GARCH conditional mean is zero by assumption, so a series with a
   * drift has to be DEMEANED before the recursion — otherwise the drift is read
   * as one enormous shock: `α·r̄²` dwarfs the variance, the filtered σ comes out
   * an order of magnitude above the sample's, and every simulated trade is
   * stopped by a volatility the market does not have. That is not a modelling
   * nicety; it is the difference between a distribution that is resampled at
   * today's volatility and one that is resampled at a hallucinated one.
   */
  meanReturn: number;
  /** Returns the fit saw. */
  observations: number;
}

/**
 * Fit GARCH(1,1) by variance targeting plus a grid search on (α, β).
 *
 * Variance targeting is the honest shortcut: the sample variance pins ω once α
 * and β are chosen (`ω = σ̄²(1 − α − β)`), which removes the parameter that is
 * least identified from a short sample and leaves a two-dimensional search. The
 * Gaussian log-likelihood then ranks the grid. Nothing here is tuned to a
 * fixture; the grid covers the range GARCH(1,1) fits land in on financial
 * returns, and the chosen parameters are printed in the report.
 */
export function fitGarch11(returns: number[]): GarchParams | null {
  const n = returns.length;
  if (n < MIN_GARCH_RETURNS) return null;
  let sum = 0;
  for (const r of returns) sum += r;
  const m = sum / n;
  // Demean first, and fit the demeaned series: see `meanReturn` above for what
  // happens when a drift is left in.
  const y = returns.map((r) => r - m);
  let ss = 0;
  for (const r of y) ss += r * r;
  const variance = ss / Math.max(1, n - 1);
  if (!(variance > 0)) return null;

  let best: GarchParams | null = null;
  for (const alpha of GARCH_ALPHA_GRID) {
    for (const beta of GARCH_BETA_GRID) {
      if (alpha + beta >= 0.995) continue;
      const omega = variance * (1 - alpha - beta);
      if (!(omega > 0)) continue;
      let sigma2 = variance;
      let logLikelihood = 0;
      for (let i = 0; i < n; i++) {
        const previous = i === 0 ? 0 : (y[i - 1] as number);
        sigma2 = omega + alpha * previous * previous + beta * sigma2;
        if (!(sigma2 > 0)) {
          logLikelihood = Number.NEGATIVE_INFINITY;
          break;
        }
        logLikelihood += -0.5 * (Math.log(2 * Math.PI * sigma2) + ((y[i] as number) ** 2) / sigma2);
      }
      if (!Number.isFinite(logLikelihood)) continue;
      if (best === null || logLikelihood > best.logLikelihood) {
        best = {
          omega,
          alpha,
          beta,
          logLikelihood,
          unconditionalVolatility: Math.sqrt(omega / (1 - alpha - beta)),
          currentVolatility: Math.sqrt(sigma2),
          meanReturn: m,
          observations: n,
        };
      }
    }
  }
  return best;
}

/**
 * The filtered standardised residuals, one per return, clipped at ±6σ.
 *
 * The clipping is not cosmetic: a single 30σ print (a bad tick, a rollover, a
 * fat finger) resampled into the tail would dominate every path and turn the
 * distribution into a statement about that one bar.
 */
export function standardisedResiduals(returns: number[], params: GarchParams): number[] {
  const out: number[] = [];
  let sigma2 = params.unconditionalVolatility ** 2;
  const y = returns.map((r) => r - params.meanReturn);
  for (let i = 0; i < returns.length; i++) {
    const previous = i === 0 ? 0 : (y[i - 1] as number);
    sigma2 = params.omega + params.alpha * previous * previous + params.beta * sigma2;
    const sigma = Math.sqrt(Math.max(1e-18, sigma2));
    const z = (y[i] as number) / sigma;
    out.push(Math.max(-MAX_ABS_RESIDUAL, Math.min(MAX_ABS_RESIDUAL, z)));
  }
  return out;
}

/**
 * Stationary block bootstrap (Politis–Romano): geometric block lengths with
 * mean `meanBlockLength`, sampled with replacement from the source array.
 */
export function stationaryBlockBootstrap(
  values: number[],
  count: number,
  rng: () => number,
  meanBlockLength = 20,
): number[] {
  const n = values.length;
  if (n === 0 || count <= 0) return [];
  const p = 1 / Math.max(1, meanBlockLength);
  const out: number[] = [];
  let index = Math.floor(rng() * n);
  while (out.length < count) {
    out.push(values[index % n] as number);
    if (rng() < p) index = Math.floor(rng() * n);
    else index += 1;
  }
  return out;
}

export interface ExecutedMcInput {
  /** The entry frame's recent CLOSE prices, oldest first — the causal sample. */
  closes: number[];
  /** The trade geometry, in price units. */
  entry: number;
  riskPrice: number;
  targetMultipleR: number;
  side: "buy" | "sell";
  costPrice: number;
  horizonBars: number;
  /** Trades per bootstrap path (a "path" is a run of the policy). */
  tradesPerPath: number;
  paths: number;
  seed: number;
  meanBlockLength?: number;
}

export interface ExecutedMcResult {
  /** Mean R per trade, averaged over every simulated trade. */
  meanR: number;
  /** 5th percentile of the per-path mean R — the tail of the policy, not of one trade. */
  p05MeanR: number;
  /** Per-path mean R values (ascending), for the report. */
  pathMeanR: number[];
  paths: number;
  tradesPerPath: number;
  trades: number;
  garch: GarchParams | null;
  /** False when the GARCH fit was refused and the paths used the raw sample. */
  pathsUsingGarch: boolean;
  /** Diagnostics: how often each barrier resolved the simulated trades. */
  outcomes: { target: number; stop: number; timeout: number };
}

/**
 * Simulate the executed policy and report the distribution of its mean R.
 *
 * Each path draws `tradesPerPath × horizonBars` standardised bar shapes from the
 * stationary block bootstrap, re-scales them by today's filtered volatility,
 * rebuilds bars, and labels each trade with the SAME triple-barrier code the
 * WP5 corpus uses (`meta/labels.ts`) — including its pessimistic same-bar tie.
 * The trade's realised R is therefore produced by one label implementation, not
 * two, which is what stops the MC and the calibration from disagreeing by
 * accident.
 */
export function executedPolicyMonteCarlo(input: ExecutedMcInput): ExecutedMcResult {
  const rng = makeRng(input.seed);
  const garch = fitGarch11(logReturnsOf(input.closes));
  const returns = logReturnsOf(input.closes);
  const usableGarch =
    garch !== null && Number.isFinite(garch.currentVolatility) && garch.currentVolatility > 0 ? garch : null;
  const scaleToday = usableGarch ? usableGarch.currentVolatility : stdevOf(returns);
  const shapes = usableGarch
    ? standardisedResiduals(returns, usableGarch)
    : demean(returns).map((r) => r / Math.max(1e-12, scaleToday));

  const pathMeanR: number[] = [];
  const outcomes = { target: 0, stop: 0, timeout: 0 };
  let total = 0;
  let totalR = 0;
  const meanBlockLength = input.meanBlockLength ?? Math.max(5, Math.min(40, input.horizonBars));

  if (!(scaleToday > 0)) {
    // A series with no measurable per-bar volatility cannot be resampled into a
    // tail. Say so rather than returning a distribution of zeros.
    return {
      meanR: 0,
      p05MeanR: 0,
      pathMeanR: [],
      paths: input.paths,
      tradesPerPath: input.tradesPerPath,
      trades: 0,
      garch: null,
      pathsUsingGarch: false,
      outcomes: { target: 0, stop: 0, timeout: 0 },
    };
  }

  for (let path = 0; path < input.paths; path++) {
    let pathSum = 0;
    for (let trade = 0; trade < input.tradesPerPath; trade++) {
      const drawn = stationaryBlockBootstrap(shapes, input.horizonBars, rng, meanBlockLength);
      const bars = barsFromShapes(drawn, input.closes[input.closes.length - 1] as number, scaleToday);
      const labelled = tripleBarrier({
        bars,
        index: -1, // the synthetic series starts AT the entry: bar 0 is the first forward bar
        side: input.side,
        entry: input.entry,
        riskPrice: input.riskPrice,
        rr: input.targetMultipleR,
        horizonBars: input.horizonBars,
        costPrice: input.costPrice,
      });
      const r = labelled ? labelled.rMultiple : 0;
      if (!labelled) outcomes.timeout++;
      else if (labelled.label === 1) outcomes.target++;
      else if (labelled.label === -1) outcomes.stop++;
      else outcomes.timeout++;
      pathSum += r;
      totalR += r;
      total++;
    }
    pathMeanR.push(pathSum / Math.max(1, input.tradesPerPath));
  }
  pathMeanR.sort((a, b) => a - b);
  const p05 = pathMeanR[Math.max(0, Math.floor(0.05 * pathMeanR.length) - 1)] ?? 0;
  return {
    meanR: total > 0 ? totalR / total : 0,
    p05MeanR: p05,
    pathMeanR,
    paths: input.paths,
    tradesPerPath: input.tradesPerPath,
    trades: total,
    garch: usableGarch,
    pathsUsingGarch: usableGarch !== null,
    outcomes,
  };
}

function logReturnsOf(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1] as number;
    const b = closes[i] as number;
    out.push(a > 0 && b > 0 ? Math.log(b / a) : 0);
  }
  return out;
}

/** The returns with their own sample mean removed. */
function demean(values: number[]): number[] {
  if (values.length === 0) return [];
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return values.map((v) => v - m);
}

function stdevOf(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Rebuild bars from standardised shapes.
 *
 * `index: -1` in the label call above means bar 0 of this array is the first bar
 * AFTER the entry — which is how a label must see a trade: the decision bar's own
 * range must never resolve it.
 */
function barsFromShapes(shapes: number[], lastClose: number, scale: number): Bar[] {
  const bars: Bar[] = [];
  let price = lastClose;
  for (let i = 0; i < shapes.length; i++) {
    const open = price;
    const ret = (shapes[i] as number) * scale;
    const close = open * Math.exp(ret);
    // The intrabar range scales with the size of the step: a quiet bar has a
    // narrow range whatever the shape says, and the label's same-bar tie makes
    // the assumption conservative either way.
    const wick = Math.abs(close - open) * 0.6 + open * scale * 0.25;
    bars.push([i, open, Math.max(open, close) + wick, Math.min(open, close) - wick, close, 1] as Bar);
    price = close;
  }
  return bars;
}
