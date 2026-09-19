/**
 * Accumulator analytics — the mathematics behind the Compounding Range Sentinel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 1. WHAT AN ACCUMULATOR ACTUALLY IS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * An ACCU contract is a two-sided discrete knockout, re-centred every tick.
 * You pay a stake S. At every tick the platform places a symmetric band
 * ±b around the PREVIOUS spot. If the new print lands inside, the contract's
 * value multiplies by (1 + g); if it lands outside, the contract dies and the
 * ENTIRE stake is lost — there is no partial payout and no payout ratio to
 * invert. You may sell the position at its current value on any tick.
 *
 * Therefore, holding it to tick n is worth:
 *
 *      V(n) = S · (1 + g)^n            [contractual — exactly this, not random]
 *      P(die) at each tick = 1 − p
 *      EV(n) = S · p^n · (1 + g)^n = S · λ^n       with  λ = p(1 + g)
 *
 * Everything else in this file is a consequence of that one line:
 *
 *   λ > 1  ⇒ EV grows with n  ⇒ hold to the cap.
 *   λ ≤ 1  ⇒ no horizon rescues it ⇒ the only correct play is not to open.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 2. WHERE p COMES FROM — THE BARRIER IS BUILT TO BE FAIR
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Deriv does not pick the band arbitrarily and it is NOT a house-set payout
 * ratio: the band is set from the symbol's OWN modelled tick volatility so that
 * the probability of staying inside equals exactly the break-even
 *
 *      p_be(g) = 1 / (1 + g)            [0.990099 … 0.952381 for g = 1 % … 5 %]
 *
 * Proof from Deriv's own published numbers: the Accumulator ebook quotes the
 * Volatility 10 Index band as ±0.0064867741 % at 1 % growth and ±0.0049358253 %
 * at 5 % growth. σ_tick(R_10) is 10 % annualised on a 2-second tick, i.e.
 * 0.10·√(2/31 536 000) = 2.5183e−5. Dividing the two bands by the two-sided
 * Gaussian quantiles that correspond to p_be — 2.575829 at 1 %, 1.959964 at 5 %
 * — gives 2.5183e−5 and 2.5183e−5. The same σ. Two growth rates, one symbol,
 * exact to five significant figures. So:
 *
 *      b(symbol, g) = σ_tick(symbol) · z(g),   z(g) = Φ⁻¹(1 − 1/(2(1+g)))
 *
 * ⇒ Under the modelled volatility the gross game is EXACTLY fair (λ = 1). The
 * house is paid by the markup (ask price vs stake, the bid it pays when you
 * sell early, the payout ceiling, and the tick cap) — not by a rigged band.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 3. THEREFORE THE ONLY HONEST EDGE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * λ = 1 by construction, so there is exactly one way to be profitable: the
 * REALISED tick volatility must be lower than the volatility the band was
 * computed from. With k = σ_model / σ_real > 1 the band covers
 *
 *      p_real = 2Φ(k·z) − 1  >  1/(1+g)   ⇒   λ = p_real(1+g) > 1
 *
 * k = 1.05 at g = 1 % gives p = 0.99329 vs p_be = 0.99010, λ = 1.00322; over
 * 100 ticks that compounds to +38 %. k = 0.95 gives λ = 0.9968 → −28 % over the
 * same 100 ticks. So the sign of the whole trade rests on a ratio of two
 * volatilities, and the job of this module is to measure that ratio honestly:
 *
 *   · σ_model comes from the live barrier itself (barrierRatio / z(g)), so the
 *     answer never depends on trusting a published constant;
 *   · σ_real comes from the tick stream (robust: RMS plus a MAD estimator);
 *   · the difference is tested, not assumed — with an FDR gate across the whole
 *     symbol × growth-rate family, because scanning 19 markets × 5 growth rates
 *     and keeping the best one is exactly how you fool yourself.
 *
 * A σ̂ from n ticks has relative standard error ≈ 1/√(2n); with the 4 999-tick
 * history this engine reads, that is ~1 %, which is the same order as the edge
 * being hunted. Hence the minimum-sample and z gates, and hence a REFUSED
 * verdict when the data cannot separate the two volatilities.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 4. WHY THE HORIZON, NOT THE STAKE, IS THE RISK LEVER
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A knockout loses the whole stake, so escalating the stake to "recover" a loss
 * multiplies the amount at risk without improving the per-tick odds at all.
 * The only lever the product offers is TIME: to turn a stake S into S + D you
 * need
 *
 *      n*(D) = ⌈ ln(1 + D/S) / ln(1 + g) ⌉
 *
 * and that horizon is only worth taking if the measured survival still clears
 * its own break-even there: Ŝ(n*) ≥ (1+g)^−n*. If n* runs past the tick cap the
 * product cannot deliver it and the debt must be written down, not chased.
 * `planAccumulatorRecovery` implements exactly that, and it is the reason the
 * accumulator's recovery path is structurally different from the payout-based
 * bots': nothing here is inverted from a payout multiplier.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Product constants
// ─────────────────────────────────────────────────────────────────────────────

/** Growth rates the product accepts, in decimal form (Deriv: 1 %–5 %). */
export const ACCU_GROWTH_RATES = [0.01, 0.02, 0.03, 0.04, 0.05] as const;

/** Seconds in the year Deriv's volatility definitions use (365 d). */
export const YEAR_SECONDS = 365 * 24 * 3600;

/** Hard product ceiling on duration, in ticks. */
export const ACCU_MAX_TICKS_HARD = 230;

/**
 * Tick cap per growth rate.
 *
 * The two published anchors disagree: the 2025 Accumulator ebook says a
 * contract may last up to 230 ticks (and that the cap depends on the growth
 * rate), while the older trader material quotes 60 ticks at 5 %. Where sources
 * conflict this engine takes the CONSERVATIVE number, because over-holding a
 * λ < 1 book is the single most expensive mistake available here. The live
 * proposal is authoritative and `calibrateTickCap` raises this at runtime when
 * Deriv accepts a longer duration.
 */
export const ACCU_TICK_CAP_ANCHORS: Record<number, number> = {
  0.01: ACCU_MAX_TICKS_HARD,
  0.05: 60,
};

/** Tick cap for a growth rate, log-interpolated between the documented anchors. */
export function tickCapFor(growthRate: number, maxTicksOverride?: number | null): number {
  const g = clamp(growthRate, 0.01, 0.05);
  const hi = ACCU_TICK_CAP_ANCHORS[0.05]!;
  const lo = ACCU_TICK_CAP_ANCHORS[0.01]!;
  const t = (g - 0.01) / 0.04;
  const interpolated = Math.round(lo * Math.pow(hi / lo, t));
  const capped = Math.min(ACCU_MAX_TICKS_HARD, interpolated);
  if (maxTicksOverride && maxTicksOverride > 0) return Math.min(maxTicksOverride, ACCU_MAX_TICKS_HARD);
  return capped;
}

/**
 * Runtime-raised tick caps. Populated when a live proposal accepts a duration
 * beyond the conservative default — the product's own answer beats a blog's.
 */
const tickCapCalibrations = new Map<number, number>();
export function calibrateTickCap(growthRate: number, maxTicks: number): void {
  if (!(maxTicks > 0)) return;
  const prev = tickCapCalibrations.get(growthRate);
  if (prev === undefined || maxTicks > prev) tickCapCalibrations.set(growthRate, Math.min(maxTicks, ACCU_MAX_TICKS_HARD));
}
export function tickCapCalibrationsTable(): Array<{ growthRate: number; maxTicks: number }> {
  return ACCU_GROWTH_RATES.map((g) => ({
    growthRate: g,
    maxTicks: tickCapCalibrations.get(g) ?? tickCapFor(g),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol specifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Published annualised volatility (as a fraction) of Deriv's synthetic indices.
 * These are the numbers Deriv uses to generate the series, so they double as the
 * prior for the barrier's implied σ.
 */
const ANNUAL_VOL: Record<string, number> = {
  R_10: 0.10, R_25: 0.25, R_50: 0.50, R_75: 0.75, R_100: 1.00,
  "1HZ10V": 0.10, "1HZ15V": 0.15, "1HZ25V": 0.25, "1HZ30V": 0.30,
  "1HZ50V": 0.50, "1HZ75V": 0.75, "1HZ90V": 0.90, "1HZ100V": 1.00,
  JD10: 0.10, JD25: 0.25, JD50: 0.50, JD75: 0.75, JD100: 1.00,
  RDBULL: 0.40, RDBEAR: 0.40,
};

/** Every Volatility-family index ticks every 2 s; the 1-second family every 1 s. */
export function tickSecondsFor(symbol: string): number {
  return symbol.startsWith("1HZ") ? 1 : 2;
}

export function annualVolFor(symbol: string): number {
  return ANNUAL_VOL[symbol] ?? 0.25;
}

/** Per-tick σ of the symbol's modelled process: σ_annual·√(tick / year). */
export function modelSigmaTick(symbol: string): number {
  return annualVolFor(symbol) * Math.sqrt(tickSecondsFor(symbol) / YEAR_SECONDS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normal distribution helpers (self-contained — this module imports nothing)
// ─────────────────────────────────────────────────────────────────────────────

/** Standard normal CDF (Zelen & Severo, 5-term; |error| < 7.5e−8). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (1.330274429 * Math.pow(t, 4) - 1.821255978 * Math.pow(t, 3)
    + 1.781477937 * t * t - 0.356563782 * t + 0.319381530);
  return z >= 0 ? 1 - p : p;
}

/** Two-sided quantile: z with P(−z ≤ Z ≤ z) = coverage. Bisection on the CDF. */
export function twoSidedQuantile(coverage: number): number {
  if (coverage <= 0) return 0;
  if (coverage >= 1) return 8;
  let lo = 0;
  let hi = 8;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (2 * normalCdf(mid) - 1 < coverage) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Probability that |X| ≤ |b| for X ~ N(0, σ²) — i.e. P(stay inside the band). */
export function pInsideBand(band: number, sigma: number): number {
  if (sigma <= 0) return band >= 0 ? 1 : 0;
  return 2 * normalCdf(Math.abs(band) / sigma) - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// The band
// ─────────────────────────────────────────────────────────────────────────────

/** Break-even per-tick survival: p_be = 1/(1+g). */
export function breakEvenP(growthRate: number): number {
  return 1 / (1 + growthRate);
}

/**
 * The coverage Deriv rounds DOWN to before building the band.
 *
 * Derived, not tabulated: coverage is published in whole percent, so
 * 1/(1+g) = 99.01 % reads as 99 %, 98.04 % as 98 %, 97.09 % as 97 %, 96.15 % as
 * 96 % and 95.24 % as 95 %. Those five floors reproduce the five canonical
 * two-sided quantiles exactly — 2.575829, 2.326348, 2.170090, 2.053749,
 * 1.959964 — and those are precisely the z values the published R_10 bands are
 * built from (verified in the test suite against both published figures).
 */
export function bandCoverage(growthRate: number): number {
  return Math.floor(breakEvenP(growthRate) * 100 + 1e-9) / 100;
}

/** The two-sided Gaussian quantile the band is actually built from. */
export function bandZ(growthRate: number): number {
  return twoSidedQuantile(bandCoverage(growthRate));
}

/**
 * The quantile that would make the band exactly fair: coverage = 1/(1+g).
 *
 * Always LARGER than `bandZ`, and that gap is the house's structural tilt: the
 * published band is 0.1 %–1.06 % narrower than break-even, so an accumulator
 * opened on the modelled volatility is a slightly losing book before any
 * measurement is taken. It is small — but it is the drift a measured edge has to
 * beat, and assuming it away is how a losing strategy gets to look profitable.
 */
export function fairBandZ(growthRate: number): number {
  return twoSidedQuantile(breakEvenP(growthRate));
}

/** k = σ_model/σ_real needed just to reach break-even against the floored band. */
export function requiredVolRatio(growthRate: number): number {
  return fairBandZ(growthRate) / bandZ(growthRate);
}

/** λ of the band exactly as published, under the modelled volatility (< 1). */
export function modelLambda(growthRate: number): number {
  return bandCoverage(growthRate) * (1 + growthRate);
}

/**
 * The band width Deriv is expected to publish for (symbol, g), as a fraction of
 * spot: σ_tick(symbol)·bandZ(g). Reproduces both published R_10 figures to
 * within 0.002 % (±0.0064867741 % at 1 %, ±0.0049358253 % at 5 %).
 */
export function modelledBarrierRatio(symbol: string, growthRate: number): number {
  return modelSigmaTick(symbol) * bandZ(growthRate);
}

/**
 * Learn bands from live proposals. A proposal is ground truth; the model above
 * is only a prior, and every reading taken from a calibrated band says so.
 */
const barrierCalibrations = new Map<string, number>();
export function calibrateBarrier(symbol: string, growthRate: number, ratio: number): void {
  if (!(ratio > 0)) return;
  barrierCalibrations.set(`${symbol}|${growthRate.toFixed(4)}`, ratio);
}
export function calibratedBarrier(symbol: string, growthRate: number): number | null {
  return barrierCalibrations.get(`${symbol}|${growthRate.toFixed(4)}`) ?? null;
}
export function clearBarrierCalibration(symbol?: string): void {
  if (!symbol) { barrierCalibrations.clear(); return; }
  for (const key of [...barrierCalibrations.keys()]) if (key.startsWith(`${symbol}|`)) barrierCalibrations.delete(key);
}
export function calibrationTable(): Array<{ symbol: string; growthRate: number; barrierRatio: number }> {
  return [...barrierCalibrations.entries()].map(([key, barrierRatio]) => {
    const [symbol, g] = key.split("|");
    return { symbol: symbol!, growthRate: Number(g), barrierRatio };
  });
}

/** Barrier ratio to use: a live calibration if we have one, else the model. */
export function effectiveBarrierRatio(symbol: string, growthRate: number): {
  ratio: number;
  calibrated: boolean;
} {
  const live = calibratedBarrier(symbol, growthRate);
  if (live !== null) return { ratio: live, calibrated: true };
  return { ratio: modelledBarrierRatio(symbol, growthRate), calibrated: false };
}

/** The σ the band implies: σ_implied = b / bandZ(g) — inverted with the band's own z. */
export function impliedSigmaFromBarrier(barrierRatio: number, growthRate: number): number {
  const z = bandZ(growthRate);
  return z > 0 ? barrierRatio / z : 0;
}

/** p implied by a band and a REAL volatility. p = 2Φ(k·z) − 1 with k = σ_m/σ_r. */
export function pFromVolRatio(volRatio: number, growthRate: number): number {
  if (volRatio <= 0) return 0;
  return 2 * normalCdf(volRatio * bandZ(growthRate)) - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick statistics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple (not log) relative increments (S_t − S_{t−1}) / S_{t−1}.
 *
 * The knockout test is on the price itself, not on a log transform, so the
 * statistic the band is compared against must be the same quantity the band is
 * measured in. At these band widths (≈5e−5) the difference is invisible, but
 * matching the contract's own definition keeps the arithmetic honest.
 */
export function relativeIncrements(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    const cur = prices[i]!;
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) continue;
    out.push((cur - prev) / prev);
  }
  return out;
}

/**
 * Per-tick σ̂: the RMS increment (the natural estimator for a zero-mean
 * increment process), plus the MAD estimator as a robustness cross-check
 * against the fat-tailed prints real feeds occasionally deliver.
 */
export function realizedTickVol(increments: readonly number[]): {
  sigma: number; sigmaMad: number; sigmaAnnual: number; samples: number; mean: number;
} {
  const n = increments.length;
  if (n === 0) return { sigma: 0, sigmaMad: 0, sigmaAnnual: 0, samples: 0, mean: 0 };
  let sumsq = 0;
  let sum = 0;
  for (const x of increments) { sumsq += x * x; sum += x; }
  const sigma = Math.sqrt(sumsq / n);
  const sorted = [...increments].map(Math.abs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  // σ = median(|x|)/0.6745 for a normal sample.
  const sigmaMad = median / 0.6744897501960817;
  return { sigma, sigmaMad, sigmaAnnual: sigma, samples: n, mean: sum / n };
}

/** Fraction of increments inside ±band. This is p̂, the measured survival. */
export function empiricalInsideProb(increments: readonly number[], band: number): number {
  if (increments.length === 0) return 0;
  let hits = 0;
  for (const x of increments) if (Math.abs(x) <= band) hits++;
  return hits / increments.length;
}

/** Wilson score interval for a binomial proportion (better than normal at p→1). */
export function wilsonInterval(successes: number, n: number, z = 1.959964): {
  p: number; lower: number; upper: number;
} {
  if (n <= 0) return { p: 0, lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

// ─────────────────────────────────────────────────────────────────────────────
// λ — the single number the whole strategy turns on
// ─────────────────────────────────────────────────────────────────────────────

/** λ = p(1+g): the per-tick growth factor of expected value. */
export function lambdaFor(p: number, growthRate: number): number {
  return p * (1 + growthRate);
}

/** Break-even λ is exactly 1: λ > 1 grows EV with every tick held. */
export const LAMBDA_BREAK_EVEN = 1;

/** Expected multiple of stake from holding n ticks at λ. */
export function evMultipleFor(lambda: number, ticks: number): number {
  return Math.pow(lambda, ticks);
}

/** The exit bid bites into the theoretical value; express it in bps of stake. */
export function exitSpreadCost(stake: number, spreadBps: number): number {
  return (stake * spreadBps) / 10_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Survival curves — Kaplan–Meier over consecutive in-band runs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lengths of every run of consecutive in-band ticks, censored at `maxTicks`.
 *
 * This is the estimator Deriv's own "Stats" panel exposes, and it is the right
 * object for an accumulator: the trade lives or dies on consecutive survival,
 * so run lengths — not the marginal hit rate — determine the payout distribution.
 */
export function bandRunLengths(
  increments: readonly number[],
  band: number,
  maxTicks: number,
): { lengths: number[]; censored: number } {
  const lengths: number[] = [];
  let run = 0;
  let censored = 0;
  for (const x of increments) {
    if (Math.abs(x) <= band) {
      run++;
      if (run >= maxTicks) { lengths.push(run); censored++; run = 0; }
    } else {
      lengths.push(run);
      run = 0;
    }
  }
  if (run > 0) { lengths.push(run); censored++; }
  return { lengths, censored };
}

/**
 * Kaplan–Meier survival over run lengths, evaluated at every tick to `maxTicks`.
 *
 * The indexing is the part that is easy to get wrong, so it is spelled out: a
 * run of length L means L consecutive in-band ticks and then a breach, so it
 * FAILS at t = L + 1. `survival[t]` is therefore P(a run survives at least t
 * ticks) and must satisfy survival[1] = p and survival[t] = p^t on iid data —
 * which is exactly what the library test pins. A run censored at the product cap
 * has not failed, so it stays in the risk set for every t ≤ maxTicks; it simply
 * contributes no event, and the curve needs no correction for it.
 */
export function kaplanMeierSurvival(lengths: readonly number[], maxTicks: number): number[] {
  const n = lengths.length;
  const out: number[] = new Array(maxTicks + 1).fill(1);
  if (n === 0) return out;
  const events = new Map<number, number>();
  for (const L of lengths) {
    const failAt = Math.min(L + 1, maxTicks + 1);
    if (failAt > maxTicks) continue; // survived past every point we report
    events.set(failAt, (events.get(failAt) ?? 0) + 1);
  }
  let atRisk = n;
  let surv = 1;
  for (let t = 1; t <= maxTicks; t++) {
    const d = events.get(t) ?? 0;
    if (d > 0 && atRisk > 0) {
      surv *= 1 - d / atRisk;
      atRisk -= d;
    }
    out[t] = surv;
  }
  return out;
}

/** iid survival at p: p^n. The null the measured curve is compared against. */
export function iidSurvival(p: number, maxTicks: number): number[] {
  const out: number[] = new Array(maxTicks + 1).fill(1);
  for (let t = 1; t <= maxTicks; t++) out[t] = out[t - 1]! * p;
  return out;
}

/**
 * The strategy object: expected value of holding to each horizon n.
 *
 *      EV(n)/stake = Ŝ(n)·(1+g)^n − 1 − spread(n)
 *
 * where Ŝ is the MEASURED survival. The band is the same expression evaluated
 * at the lower and upper Wilson/KM bounds, so the caller can demand that the
 * trade still clears zero when the measurement is at its pessimistic end.
 */
export interface EvCurvePoint {
  ticks: number;
  survival: number;
  survivalLower: number;
  survivalUpper: number;
  payoutMultiple: number;
  ev: number;
  evLower: number;
  evUpper: number;
}

export function evCurve(params: {
  survival: number[];
  iidLower?: number[];
  /** Optional per-tick lower/upper survival bands (length ≥ maxTicks+1). */
  survivalLower?: number[];
  survivalUpper?: number[];
  growthRate: number;
  maxTicks: number;
  /** Tick at which the payout starts compounding (Deriv's growth start step). */
  growthStartStep?: number;
  /** Exit cost in bps of stake, charged once (early exit only). */
  exitSpreadBps?: number;
  /** Cap on the payout multiple the product will honour, if any. */
  payoutCapMultiple?: number;
}): EvCurvePoint[] {
  const { growthRate, maxTicks } = params;
  const step = Math.max(0, params.growthStartStep ?? 0);
  const spread = (params.exitSpreadBps ?? 0) / 10_000;
  const out: EvCurvePoint[] = [];
  for (let n = 0; n <= maxTicks; n++) {
    const grown = Math.pow(1 + growthRate, Math.max(0, n - step));
    const capped = params.payoutCapMultiple ? Math.min(grown, params.payoutCapMultiple) : grown;
    const s = params.survival[n] ?? params.survival[params.survival.length - 1] ?? 0;
    const sLo = params.survivalLower?.[n] ?? (params.iidLower?.[n] ?? s);
    const sHi = params.survivalUpper?.[n] ?? s;
    const cost = n > 0 ? spread : 0;
    out.push({
      ticks: n,
      survival: s,
      survivalLower: sLo,
      survivalUpper: sHi,
      payoutMultiple: capped,
      ev: s * capped - 1 - cost,
      evLower: sLo * capped - 1 - cost,
      evUpper: sHi * capped - 1 - cost,
    });
  }
  return out;
}

/**
 * The horizon the bot will actually hold to.
 *
 * Objective: the argmax of the CONSERVATIVE (lower-bound) EV curve, subject to a
 * floor on the probability of getting there.
 *
 * Both halves matter, and the floor is the part that is easy to leave out. On a
 * λ > 1 book the EV-maximising horizon is ALWAYS the tick cap, because the
 * payout compounds exponentially while the survival decay is only exponential
 * in the opposite direction — so a pure EV maximiser happily chooses "8 % chance
 * of 31× , 92 % chance of losing the whole stake". The expected value of that
 * ticket is genuinely positive, and it is still a terrible thing to run on a
 * finite bankroll: the whole stake is lost on 92 of every 100 attempts, so the
 * wins do not arrive often enough to survive the swing, and a recovery ladder
 * built on it is a ladder into the floor.
 *
 * The floor therefore trades a little expected value for an outcome distribution
 * the session can actually execute: every profile states the minimum survival it
 * will accept at the horizon it deploys, and honouring it is what makes the
 * recovery maths (which assumes wins ARRIVE) meaningful.
 */
export function optimalHorizon(curve: readonly EvCurvePoint[], minSurvivalLower = 0): {
  ticks: number; ev: number; evLower: number; payoutMultiple: number; survival: number; survivalLower: number;
} {
  let best = { ticks: 0, ev: 0, evLower: 0, payoutMultiple: 1, survival: 1, survivalLower: 1 };
  for (const p of curve) {
    if (p.ticks === 0) continue;
    if (p.survivalLower < minSurvivalLower) continue;
    if (p.evLower > best.evLower) {
      best = {
        ticks: p.ticks, ev: p.ev, evLower: p.evLower,
        payoutMultiple: p.payoutMultiple, survival: p.survival, survivalLower: p.survivalLower,
      };
    }
  }
  return best;
}

/**
 * Deriv's growth-start step: the number of ticks that must pass before the
 * payout begins to compound. Read live from the proposal's payout schedule when
 * available; 1 (grow after the first surviving tick) is the documented default.
 */
export function inferGrowthStartStep(payouts: readonly number[], stake: number, growthRate: number): number {
  for (let i = 0; i < payouts.length; i++) {
    const expected = stake;
    if ((payouts[i] ?? 0) > expected * 1.0000001) return i;
  }
  void growthRate;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markov structure — is survival iid, or does it cluster?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Magnitude states for the tick-to-tick chain.
 *
 *   0 calm      |x| ≤ q⅓ of |x|
 *   1 normal    q⅓ < |x| ≤ q⅔
 *   2 elevated  q⅔ < |x| ≤ band
 *   3 BREACH    |x| > band      ← absorbing: the contract is dead
 *
 * The fourth state is not decoration. A wide-but-in-band tick is NOT the end of
 * a run, so treating the widest bucket as death — the tempting short cut —
 * understates survival badly. Breach is the only terminal state and the only row
 * with no outgoing probability mass.
 */
export const MAGNITUDE_STATES = 4;

/**
 * Observations a magnitude state needs before its own row is trusted. Below it
 * the row is replaced by the unconditional rate — a fabricated conditional
 * probability is worse than an uninformative one.
 */
export const MIN_STATE_OBSERVATIONS = 20;
/** The transient (alive) block of the chain: calm / normal / elevated. */
export const TREND_STATES = 3;
export const BREACH_STATE = 3;

export interface MagnitudeChain {
  /** Full 4×4 transition matrix (rows sum to 1). */
  transition: number[][];
  /** P(breach next tick | current state). */
  breachProb: number[];
  /** P(still in band next tick | current state) = 1 − breachProb. */
  hitProb: number[];
  /** Observations seen in each state. */
  counts: number[];
  /** Stationary distribution over the alive states, normalised to 1. */
  stationaryAlive: number[];
}

export function fitMagnitudeChain(increments: readonly number[], band: number): MagnitudeChain {
  const abs = increments.map(Math.abs);
  const sorted = [...abs].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const t1 = Math.min(q(1 / 3), band);
  const t2 = Math.min(q(2 / 3), band);

  const stateOf = (x: number): number => {
    const a = Math.abs(x);
    if (a > band) return BREACH_STATE;
    if (a <= t1) return 0;
    if (a <= t2) return 1;
    return 2;
  };

  const counts = new Array(MAGNITUDE_STATES).fill(0);
  let transition: number[][] = Array.from({ length: MAGNITUDE_STATES }, () => new Array(MAGNITUDE_STATES).fill(0));

  for (let i = 1; i < increments.length; i++) {
    const prev = stateOf(increments[i - 1]!);
    const next = stateOf(increments[i]!);
    counts[prev] = (counts[prev] ?? 0) + 1;
    transition[prev]![next] = transition[prev]![next]! + 1;
  }

  // Fall back to the unconditional rate for states the sample never visited: a
  // smoothed empty row would otherwise invent a confident hit probability (the
  // KT prior alone reports 0.75) for a state there is no evidence about.
  const empiricalHit = increments.length
    ? increments.filter((x) => Math.abs(x) <= band).length / increments.length
    : 0;
  const fallbackRow = [0, 0, 0, 0] as number[];
  transition = transition.map((row, i) => {
    const total = row.reduce((x, y) => x + y, 0);
    if (total === 0) return i === BREACH_STATE ? [0, 0, 0, 1] : [...fallbackRow];
    return row.map((c) => c / total);
  });
  for (let i = 0; i < TREND_STATES; i++) {
    const visits = counts[i] ?? 0;
    if (visits < MIN_STATE_OBSERVATIONS) {
      transition[i] = [0, 0, 0, 1 - empiricalHit];
      const alive = empiricalHit / TREND_STATES;
      transition[i] = [alive, alive, alive, 1 - empiricalHit];
    }
  }
  // Breach absorbs by construction, whatever the sample happened to do.
  transition[BREACH_STATE] = [0, 0, 0, 1];

  const breachProb = transition.map((row) => row[BREACH_STATE] ?? 0);
  return {
    transition,
    breachProb,
    hitProb: breachProb.map((b) => 1 - b),
    counts,
    stationaryAlive: stationaryDistribution(transition),
  };
}

/** Stationary distribution over the alive block, renormalised so it sums to 1. */
function stationaryDistribution(transition: number[][]): number[] {
  let pi = new Array(TREND_STATES).fill(1 / TREND_STATES);
  for (let iter = 0; iter < 500; iter++) {
    const next = new Array(TREND_STATES).fill(0);
    for (let i = 0; i < TREND_STATES; i++) {
      for (let j = 0; j < TREND_STATES; j++) next[j] += pi[i]! * (transition[i]?.[j] ?? 0);
    }
    const total = next.reduce((x, y) => x + y, 0);
    if (total <= 0) return new Array(TREND_STATES).fill(1 / TREND_STATES);
    pi = next.map((v) => v / total);
  }
  return pi;
}

/**
 * Markov direction: P(in-band on the NEXT tick) conditioned on the magnitude
 * state of the last one. Under iid every one of these equals p̂; a spread that is
 * large against its OWN standard error is real structure (and means an iid p is
 * the wrong number to plan a horizon with).
 */
export function conditionalInsideProb(increments: readonly number[], band: number): {
  states: number[]; overall: number; spread: number; spreadZ: number; chain: MagnitudeChain;
} {
  const chain = fitMagnitudeChain(increments, band);
  const states = chain.hitProb.slice(0, TREND_STATES);
  const overall = increments.length
    ? increments.filter((x) => Math.abs(x) <= band).length / increments.length
    : 0;

  let spread = 0;
  let spreadZ = 0;
  for (let i = 0; i < TREND_STATES; i++) {
    for (let j = i + 1; j < TREND_STATES; j++) {
      const ni = chain.counts[i] ?? 0;
      const nj = chain.counts[j] ?? 0;
      if (ni < 20 || nj < 20) continue;
      const gap = Math.abs(states[i]! - states[j]!);
      const se = Math.sqrt((states[i]! * (1 - states[i]!)) / ni + (states[j]! * (1 - states[j]!)) / nj);
      if (se > 0 && gap / se > spreadZ) { spread = gap; spreadZ = gap / se; }
    }
  }
  return { states, overall, spread, spreadZ, chain };
}

/**
 * E[T] = π̃ (I − Q)⁻¹ 1 — expected run length in ticks under the fitted chain.
 *
 * Q is the transient-to-transient block, so (I−Q)⁻¹1 counts expected visits to
 * each alive state; the answer is that count averaged over the entry
 * distribution (the stationary distribution of the alive block, or a specific
 * start state when the caller knows the tick it is sitting on). On iid data this
 * reproduces 1/(1−p) exactly, which is the test that pins it.
 */
export function expectedRunLengthFromChain(
  chain: Pick<MagnitudeChain, "transition" | "stationaryAlive"> | number[][],
  startState?: number,
): number {
  const transition = Array.isArray(chain) ? chain : chain.transition;
  const entry = Array.isArray(chain) ? new Array(TREND_STATES).fill(1 / TREND_STATES) : chain.stationaryAlive;
  const IminusQ = Array.from({ length: TREND_STATES }, (_, i) =>
    Array.from({ length: TREND_STATES }, (_, j) => (i === j ? 1 : 0) - (transition[i]?.[j] ?? 0)),
  );
  const visits = solveLinear(IminusQ, new Array(TREND_STATES).fill(1));
  if (!visits) return 0;
  if (startState !== undefined) return visits[startState] ?? 0;
  let e = 0;
  for (let i = 0; i < TREND_STATES; i++) e += (entry[i] ?? 0) * (visits[i] ?? 0);
  return e;
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c] = M[r]![c]! - f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Lag-1 autocorrelation of |x| — the vol-clustering diagnostic, with a z-score. */
export function volClusteringZ(increments: readonly number[]): number {
  const n = increments.length;
  if (n < 30) return 0;
  const abs = increments.map(Math.abs);
  const mean = abs.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 1; i < n; i++) num += (abs[i]! - mean) * (abs[i - 1]! - mean);
  for (let i = 0; i < n; i++) den += (abs[i]! - mean) ** 2;
  const rho = den > 0 ? num / den : 0;
  return rho * Math.sqrt(n); // ~N(0,1) under iid
}

/** Wald–Wolfowitz runs test on the in/out indicator (+z ⇒ clustering). */
export function runsTestZ(increments: readonly number[], band: number): number {
  const seq = increments.map((x) => (Math.abs(x) <= band ? 1 : 0));
  const n = seq.length;
  if (n < 30) return 0;
  let n1 = 0;
  let runs = 0;
  for (let i = 0; i < n; i++) {
    if (seq[i]) n1++;
    if (i === 0 || seq[i] !== seq[i - 1]) runs++;
  }
  const n0 = n - n1;
  if (n0 === 0 || n1 === 0) return 0;
  const expected = (2 * n0 * n1) / n + 1;
  const variance = (2 * n0 * n1 * (2 * n0 * n1 - n)) / (n * n * (n - 1));
  if (variance <= 0) return 0;
  return (runs - expected) / Math.sqrt(variance);
}

// ─────────────────────────────────────────────────────────────────────────────
// Change detection — the exit and market-rotation trigger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rolling-window z-test on the live in-band rate.
 *
 * This replaces the Page–Hinkley detector that the first draft of this engine
 * used, and the reason is worth recording. PH is a mean-shift detector for
 * CONTINUOUS data: on a Bernoulli indicator a single breach moves the cumulative
 * sum by (1 − p₀) ≈ 0.98 while the walk's own σ per tick is only
 * √(p₀(1−p₀)) ≈ 0.14, so one ordinary breach is a 7σ event — a threshold low
 * enough to catch a genuine decay (measured at 196 false alarms in 20 000 fair
 * ticks, and 15 445 with the slack set to the break-even) cannot be made quiet,
 * and one high enough to be quiet cannot see the decay that matters. The
 * windowed rate test has an interpretable false-positive rate instead, and the
 * CUSUM below covers the cumulative view.
 *
 *   z = (p̂_window − p₀) / √(p₀(1−p₀)/window)
 *
 * The arithmetic is unforgiving and worth stating plainly, because it shapes the
 * whole exit policy: with p₀ ≈ 0.98, z = Δp·√(n / (p₀(1−p₀))), so a ONE-point
 * shortfall needs ~1 730 ticks to reach 3σ while a THREE-point shortfall needs
 * only ~190. A survival rate this close to 1 is intrinsically hard to monitor
 * tick-by-tick — which is exactly why the SPRT (optimal in the KL sense) is the
 * primary detector and why the defensive exit keys off the position's VALUE
 * being at or above par rather than off a confident failure verdict.
 */
export const HEALTH_WINDOW_TICKS = 250;

export interface RateWindow {
  /** Rolling in-band indicators, newest last. */
  samples: number[];
  p0: number;
  size: number;
}

export function freshRateWindow(p0: number, size = HEALTH_WINDOW_TICKS): RateWindow {
  return { samples: [], p0, size };
}

export function pushRateWindow(window: RateWindow, inBand: boolean): RateWindow {
  const samples = [...window.samples, inBand ? 1 : 0];
  if (samples.length > window.size) samples.splice(0, samples.length - window.size);
  return { ...window, samples };
}

/** One-sided z of the windowed survival rate against the rate it was priced at. */
export function rateWindowZ(window: RateWindow): number {
  const n = window.samples.length;
  if (n < 30) return 0;
  const p = window.samples.reduce((acc, x) => acc + x, 0) / n;
  const se = Math.sqrt((window.p0 * (1 - window.p0)) / n);
  if (se <= 0) return 0;
  return (p - window.p0) / se;
}

export interface CusumState {
  /** One-sided statistic for a DECAY in the survival rate. */
  s: number;
  n: number;
}

/**
 * One-sided Bernoulli CUSUM for a drop in the survival rate.
 *
 * Choose the rate we want to catch, q* = p0 − tolerance. The increment is +q*
 * on a breach and −(1 − q*) while in band, so the statistic drift per tick is
 * exactly q* − p_live: flat at q*, and growing at the rate of the shortfall
 * below it. With tolerance 0.01 on a 2 % break-even that is a drift of
 * (0.9804 − p_live) per tick, so an h = 5 threshold trips after roughly
 * 5/(shortfall) ticks — 500 ticks for a 1 % shortfall, ~90 for a 5.5 % one.
 *
 * The definition is inverted from the usual "increase" form on purpose: what
 * costs money here is the breach rate going UP, i.e. survival going DOWN.
 */
export function cusumUpdate(
  state: CusumState,
  inBand: boolean,
  reference: number,
  tolerance = 0.01,
  threshold = 5,
): { state: CusumState; alarm: boolean; statistic: number } {
  const qStar = Math.max(1e-6, reference - Math.max(0, tolerance));
  const increment = inBand ? -(1 - qStar) : qStar;
  const s = Math.max(0, state.s + increment);
  return { state: { s, n: state.n + 1 }, alarm: s > threshold, statistic: s };
}

export function freshCusum(): CusumState {
  return { s: 0, n: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wald SPRT — the detector the live loop actually trusts
// ─────────────────────────────────────────────────────────────────────────────

export const SPRT_DEFAULT_ALPHA = 0.01;
export const SPRT_DEFAULT_BETA = 0.1;

export interface SprtState {
  /** Accumulated log-likelihood ratio in favour of H1 (the rate has decayed). */
  logLikelihood: number;
  decision: "continue" | "accept_fair" | "accept_decayed";
  upper: number;
  lower: number;
  n: number;
  p0: number;
  p1: number;
}

/**
 * Wald's sequential probability ratio test on the in-band indicator.
 *
 *   H0: p = p0 (survival is still what the trade was priced at)
 *   H1: p = p1 (survival has decayed to the detector's alternative)
 *
 * Both error probabilities are STATED, not tuned: α is the chance of declaring a
 * decay that is not there, β the chance of missing one that is, and the decision
 * boundaries are log((1−β)/α) and log(β/(1−α)). Because it is a ratio test it
 * stops as early as the evidence allows and its stopping time has a known
 * expectation, which is what makes it usable as a live exit trigger.
 */
export function freshSprt(p0: number, p1: number, alpha = SPRT_DEFAULT_ALPHA, beta = SPRT_DEFAULT_BETA): SprtState {
  return {
    logLikelihood: 0,
    decision: "continue",
    upper: Math.log((1 - beta) / alpha),
    lower: Math.log(beta / (1 - alpha)),
    n: 0,
    p0,
    p1,
  };
}

export function sprtUpdate(state: SprtState, inBand: boolean): SprtState {
  const p0 = clamp(state.p0, 1e-6, 1 - 1e-6);
  const p1 = clamp(state.p1, 1e-6, 1 - 1e-6);
  const increment = inBand ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
  const logLikelihood = state.logLikelihood + increment;
  let decision: SprtState["decision"] = "continue";
  if (logLikelihood >= state.upper) decision = "accept_decayed";
  else if (logLikelihood <= state.lower) decision = "accept_fair";
  return { ...state, logLikelihood, decision, n: state.n + 1 };
}

/** The detector's alternative: how far below break-even counts as "decayed". */
export function sprtAlternative(p0: number, tolerance = 0.01): number {
  return clamp(p0 - Math.max(0.001, tolerance), 0.5, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Multiple testing — the reason the scan can be trusted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Benjamini–Hochberg step-up. Scanning 19 markets × 5 growth rates and taking
 * the best λ is a guaranteed way to find a phantom edge in noise; the FDR gate
 * makes "the best of 95 tests" mean something.
 */
export function benjaminiHochberg(pValues: readonly number[], q = 0.1): { threshold: number; discoveries: number[] } {
  const m = pValues.length;
  if (m === 0) return { threshold: 0, discoveries: [] };
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let k = 0;
  for (let i = 0; i < m; i++) if (order[i]!.p <= ((i + 1) / m) * q) k = i + 1;
  if (k === 0) return { threshold: 0, discoveries: [] };
  const threshold = order[k - 1]!.p;
  const discoveries = order.slice(0, k).map((o) => o.i);
  return { threshold, discoveries };
}

/** One-sided z of p̂ against p0 (normal approx; n ≥ 100 in every caller). */
export function proportionZ(successes: number, n: number, p0: number): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  if (se <= 0) return 0;
  return (p - p0) / se;
}

/**
 * z of the claim σ_real < σ_model. σ̂ has relative standard error 1/√(2n), so
 * the test is on the ratio and its own sampling error — no distributional
 * assumption beyond finite fourth moments.
 */
export function volEdgeZ(volRatio: number, samples: number): number {
  if (samples < 10 || volRatio <= 0) return 0;
  const seRel = 1 / Math.sqrt(2 * samples);
  return (volRatio - 1) / seRel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Certainty profiles
// ─────────────────────────────────────────────────────────────────────────────

export interface CertaintyProfile {
  id: "elite" | "strict" | "balanced";
  label: string;
  description: string;
  /**
   * Minimum σ_model/σ_real ratio. Only the elite profile DEMANDS this: for
   * strict and balanced it is a diagnostic, and any profile treats a strongly
   * contradictory ratio (z < VOL_EDGE_VETO_Z) as a veto.
   */
  minVolRatio: number;
  /** Minimum one-sided z of that ratio. */
  minVolZ: number;
  /** True when the volatility route must confirm the measure before deploying. */
  requireVolEdge: boolean;
  /** Minimum conservative EV (lower bound) at the chosen horizon. */
  minEvLower: number;
  /**
   * Minimum lower-bound survival the deployed horizon must keep. See
   * `optimalHorizon`: without this the EV maximiser always picks the cap, which
   * is a positive-EV lottery and an un-runnable bankroll policy.
   */
  minSurvivalLower: number;
  /** Minimum lower-bound λ (the whole trade rests on this). */
  minLambdaLower: number;
  /** Minimum increments behind the reading. */
  minSamples: number;
  /** BH false-discovery rate for the scan. */
  fdr: number;
  /** Extra survival margin demanded at the recovery horizon. */
  recoveryMargin: number;
}

export const ACCU_CERTAINTY: Record<CertaintyProfile["id"], CertaintyProfile> = {
  elite: {
    id: "elite",
    label: "Elite",
    description: "k ≥ 1.03 at z ≥ 3 AND λ lower ≥ 1.003, conservative EV ≥ 5 %, 1 500 ticks, FDR 5 %. Few trades, each measured hard.",
    minVolRatio: 1.03,
    minVolZ: 3,
    requireVolEdge: true,
    minLambdaLower: 1.003,
    minSamples: 1500,
    fdr: 0.05,
    recoveryMargin: 0.02,
    minEvLower: 0.05,
    minSurvivalLower: 0.65,
  },
  strict: {
    id: "strict",
    label: "Strict (default)",
    description: "λ lower ≥ 1.0015 with a conservative EV ≥ 2 %, 800 ticks, FDR 10 %. The σ ratio is checked, not demanded.",
    minVolRatio: 1.015,
    minVolZ: 2,
    requireVolEdge: false,
    minLambdaLower: 1.0015,
    minSamples: 800,
    fdr: 0.1,
    recoveryMargin: 0.01,
    minEvLower: 0.02,
    minSurvivalLower: 0.5,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "λ lower > 1 with a conservative EV ≥ 0.5 %, 400 ticks, FDR 20 %.",
    minVolRatio: 1.005,
    minVolZ: 1.3,
    requireVolEdge: false,
    minLambdaLower: 1.0001,
    minSamples: 400,
    fdr: 0.2,
    recoveryMargin: 0.005,
    minEvLower: 0.005,
    minSurvivalLower: 0.35,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Reading a market
// ─────────────────────────────────────────────────────────────────────────────

export type AccumulatorVerdict = "CERTIFIED" | "QUALIFIED" | "WATCH" | "REFUSED";

/**
 * How decisively the volatility route may veto a positive direct measurement.
 *
 * The direct test — is P(stay inside the band) above 1/(1+g)? — is what the
 * payout actually depends on, and its Wilson interval is valid whatever the
 * shape of the increments. The σ ratio is a model-based view of the SAME claim
 * (it assumes Gaussian increments), so it is a cross-check, not the verdict:
 * a mild disagreement is ignored and only a decisive one (3σ against the
 * measurement) stops the trade.
 */
export const VOL_EDGE_VETO_Z = -3;

export interface EdgeReading {
  symbol: string;
  growthRate: number;
  barrierRatio: number;
  barrierCalibrated: boolean;
  pBreakEven: number;
  p: number;
  pHatLower: number;
  pHatUpper: number;
  lambda: number;
  lambdaLower: number;
  lambdaUpper: number;
  zBreakEven: number;
  sigmaModel: number;
  sigmaReal: number;
  volRatio: number;
  zVolEdge: number;
  samples: number;
  /** Expected run length under the fitted magnitude chain (ticks). */
  markovRunLength: number;
  /** P(stay in band next tick | the magnitude state the last tick left us in). */
  markovHitProb: number[];
  /** z of the biggest gap between those conditional rates. */
  markovSpreadZ: number;
  /** Lag-1 |x| clustering z; |z| > 3 means the iid assumption is shaky. */
  clusteringZ: number;
  verdict: AccumulatorVerdict;
  reason: string;
}

/**
 * Read one (symbol, growth-rate) pair out of a tick history.
 *
 * Returns the measured p̂, the λ it implies, and — critically — the LOWER bound
 * of λ, which is what the deploy gate uses. A reading whose lower bound does not
 * clear 1 is not an edge; it is a coincidence with an error bar through it.
 */
export function readEdge(params: {
  symbol: string;
  growthRate: number;
  increments: readonly number[];
  barrierRatio?: number;
  barrierCalibrated?: boolean;
  profile?: CertaintyProfile;
  /** Live p̂ when the feed can measure it directly; falls back to the band test. */
  maxTicks?: number;
}): EdgeReading | null {
  const { symbol, growthRate, increments } = params;
  const profile = params.profile ?? ACCU_CERTAINTY.strict;
  if (increments.length < 50) return null;

  const ratio = params.barrierRatio ?? modelledBarrierRatio(symbol, growthRate);
  const sigmaModel = impliedSigmaFromBarrier(ratio, growthRate);
  const stats = realizedTickVol(increments);
  const sigmaReal = stats.sigma > 0 ? stats.sigma : 1e-12;
  const volRatio = sigmaModel / sigmaReal;
  const zVol = volEdgeZ(volRatio, increments.length);

  const successes = increments.filter((x) => Math.abs(x) <= ratio).length;
  const wilson = wilsonInterval(successes, increments.length, 1.959964);
  const p = wilson.p;
  const pBe = breakEvenP(growthRate);

  const lambda = lambdaFor(p, growthRate);
  const lambdaLower = lambdaFor(wilson.lower, growthRate);
  const lambdaUpper = lambdaFor(wilson.upper, growthRate);
  const zBe = proportionZ(successes, increments.length, pBe);

  const maxTicks = params.maxTicks ?? tickCapFor(growthRate);
  const chain = fitMagnitudeChain(increments, ratio);
  const markovRunLength = expectedRunLengthFromChain(chain);
  const conditional = conditionalInsideProb(increments, ratio);
  const clusteringZ = volClusteringZ(increments);

  let verdict: AccumulatorVerdict = "REFUSED";
  let reason = "";

  if (increments.length < profile.minSamples) {
    reason = `Only ${increments.length} ticks measured — ${profile.label} needs ${profile.minSamples}.`;
  } else if (lambdaLower <= 1) {
    reason =
      `λ lower bound ${lambdaLower.toFixed(5)} ≤ 1: at this sample size the trade cannot be shown to beat break-even ` +
      `(p̂ ${p.toFixed(5)} vs break-even ${pBe.toFixed(5)}, z ${zBe.toFixed(2)}).`;
  } else if (zVol < VOL_EDGE_VETO_Z) {
    // The direct measurement says survival is above break-even, but the
    // volatility route — the same claim seen through σ — says the opposite, and
    // hard. When two estimators of one quantity disagree, the trade is not
    // understood well enough to open, whatever the p-value says.
    reason =
      `Estimators contradict: p̂ ${p.toFixed(5)} clears break-even ${pBe.toFixed(5)} but the band-implied σ is ` +
      `${volRatio.toFixed(4)}× the realised σ at z = ${zVol.toFixed(2)} — the increments are not the shape this band ` +
      `was cut for. Standing aside until the two agree.`;
  } else if (profile.requireVolEdge && (volRatio < profile.minVolRatio || zVol < profile.minVolZ)) {
    reason =
      `The ${profile.label} profile demands the volatility route to confirm the measure ` +
      `(k = ${volRatio.toFixed(4)} at z = ${zVol.toFixed(2)}; needs k ≥ ${profile.minVolRatio}, z ≥ ${profile.minVolZ}).`;
  } else if (lambdaLower < profile.minLambdaLower) {
    reason = `λ lower bound ${lambdaLower.toFixed(5)} below the ${profile.label} floor ${profile.minLambdaLower}.`;
  } else {
    verdict = "CERTIFIED";
    reason =
      `Realised σ ${sigmaReal.toExponential(3)} vs barrier-implied ${sigmaModel.toExponential(3)} (k = ${volRatio.toFixed(4)}, z = ${zVol.toFixed(2)}): ` +
      `p̂ ${p.toFixed(5)} > break-even ${pBe.toFixed(5)}, λ = ${lambda.toFixed(5)} (lower ${lambdaLower.toFixed(5)}). ` +
      `Holding to the ${maxTicks}-tick cap is worth ${Math.pow(lambda, maxTicks).toFixed(3)}× expected.`;
    if (Math.abs(clusteringZ) > 3) {
      verdict = "QUALIFIED";
      reason += ` Caution: |x| clustering z = ${clusteringZ.toFixed(2)} — survival is not iid, horizon trimmed.`;
    }
  }

  return {
    symbol, growthRate,
    barrierRatio: ratio,
    barrierCalibrated: params.barrierCalibrated ?? false,
    pBreakEven: pBe,
    p, pHatLower: wilson.lower, pHatUpper: wilson.upper,
    lambda, lambdaLower, lambdaUpper,
    zBreakEven: zBe,
    sigmaModel, sigmaReal,
    volRatio, zVolEdge: zVol,
    samples: increments.length,
    markovRunLength,
    markovHitProb: conditional.states,
    markovSpreadZ: conditional.spreadZ,
    clusteringZ,
    verdict,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery — accumulator-native, and structurally different
// ─────────────────────────────────────────────────────────────────────────────

export interface AccumulatorRecoveryPlan {
  stake: number;
  debt: number;
  growthRate: number;
  /** Ticks needed to compound the stake into stake + debt. */
  horizonTicks: number | null;
  /** Survival the horizon needs: (1+g)^−n. */
  requiredSurvival: number;
  /** Measured survival at that horizon. */
  survival: number;
  survivalLower: number;
  performanceMultiple: number;
  viable: boolean;
  abandoned: boolean;
  reason: string;
}

/**
 * Accumulator recovery: buy TIME, never stake.
 *
 * A knockout loses the stake in full, so raising the stake raises the amount at
 * risk without touching the per-tick odds — it is strictly dominated by keeping
 * the stake and extending the horizon, which is free (the product sells time,
 * not risk). `planAccumulatorRecovery` therefore computes
 *
 *      n*(D) = ⌈ ln(1 + D/S) / ln(1 + g) ⌉
 *
 * and accepts it only when (a) it fits inside the product's tick cap and (b) the
 * measured survival at n* still clears the break-even for that horizon with the
 * profile's margin. Otherwise the debt is abandoned rather than doubled.
 */
export function planAccumulatorRecovery(params: {
  stake: number;
  debt: number;
  growthRate: number;
  survival: readonly number[];
  survivalLower?: readonly number[];
  maxTicks?: number;
  profile?: CertaintyProfile;
}): AccumulatorRecoveryPlan {
  const profile = params.profile ?? ACCU_CERTAINTY.strict;
  const { stake, debt, growthRate } = params;
  const maxTicks = params.maxTicks ?? tickCapFor(growthRate);

  if (!(stake > 0) || !(debt > 0)) {
    return {
      stake, debt, growthRate, horizonTicks: null, requiredSurvival: 1, survival: 1, survivalLower: 1,
      performanceMultiple: 1, viable: false, abandoned: true,
      reason: "Nothing to recover.",
    };
  }

  const horizon = Math.ceil(Math.log(1 + debt / stake) / Math.log(1 + growthRate));
  const requiredSurvival = Math.pow(1 + growthRate, -horizon);

  if (horizon > maxTicks || horizon > ACCU_MAX_TICKS_HARD) {
    return {
      stake, debt, growthRate, horizonTicks: horizon, requiredSurvival, survival: 0, survivalLower: 0,
      performanceMultiple: Math.pow(1 + growthRate, Math.min(horizon, maxTicks)),
      viable: false, abandoned: true,
      reason:
        `Recovering $${debt.toFixed(2)} at ${(growthRate * 100).toFixed(0)} % needs ${horizon} ticks, past the ` +
        `${maxTicks}-tick cap. The product cannot sell that much time — debt written down instead of chased.`,
    };
  }

  const at = (arr?: readonly number[]) =>
    arr?.[horizon] ?? params.survival[horizon] ?? params.survival[params.survival.length - 1] ?? 0;
  const survival = at(params.survival);
  const survivalLower = at(params.survivalLower ?? params.survival);
  const need = requiredSurvival * (1 + profile.recoveryMargin);
  const viable = survivalLower >= need;

  return {
    stake, debt, growthRate, horizonTicks: horizon, requiredSurvival,
    survival, survivalLower,
    performanceMultiple: Math.pow(1 + growthRate, horizon),
    viable,
    abandoned: false,
    reason: viable
      ? `Hold ${horizon} ticks: measured survival ${(survivalLower * 100).toFixed(2)} % (conservative) clears the ` +
        `${(need * 100).toFixed(2)} % the horizon needs. Stake stays at $${stake.toFixed(2)} — recovery buys time, not size.`
      : `Hold ${horizon} ticks needs ${(need * 100).toFixed(2)} % survival but the conservative measurement gives ` +
        `${(survivalLower * 100).toFixed(2)} %. The odds do not pay for the debt — not taking the shot.`,
  };
}

/**
 * Stake escalation, priced. Used only to *demonstrate* that it is dominated:
 * the recovery ladder tries stake·m for m = 1, 2, 3 … and compares the expected
 * profit with the same money spent buying horizon at the base stake.
 */
export function escalationIsDominated(params: {
  stake: number; debt: number; growthRate: number; p: number; maxTicks?: number;
}): { byHorizon: number; byEscalation: number; horizonTicks: number | null } {
  const { stake, debt, growthRate, p } = params;
  const plan = planAccumulatorRecovery({
    stake, debt, growthRate,
    survival: Array.from({ length: (params.maxTicks ?? tickCapFor(growthRate)) + 1 }, (_, n) => Math.pow(p, n)),
    maxTicks: params.maxTicks,
  });
  const byHorizon = plan.viable
    ? Math.pow(p, plan.horizonTicks!) * (stake + debt) - stake
    : 0;
  // Escalating to stake·m risks m·stake to win the same debt.
  let byEscalation = -Infinity;
  for (let m = 1; m <= 5; m++) {
    const ev = Math.pow(p, 1) * (m * stake * (1 + growthRate) - m * stake) - (1 - p) * m * stake;
    byEscalation = Math.max(byEscalation, ev);
  }
  return { byHorizon, byEscalation, horizonTicks: plan.horizonTicks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live exit policy
// ─────────────────────────────────────────────────────────────────────────────

export type ExitAction = "hold" | "sell_target" | "sell_defensive" | "abandon_market";

export interface ExitDecision {
  action: ExitAction;
  reason: string;
}

/**
 * What to do with an open position, tick by tick.
 *
 * The accumulator offers something no fixed-odds contract does: you can leave at
 * any moment for the value it has accumulated. That makes the exit policy a
 * first-class part of the edge:
 *
 *   · target reached                       → take the profit (the contract's own
 *                                            take-profit closes it server-side);
 *   · λ_live < 1 while the value is ≥ par  → the premise is gone but the trade
 *                                            is not yet a loss: leave at par
 *                                            ("sell at par") instead of riding
 *                                            it into a knockout;
 *   · health flags ≥ 2 while still healthy → defensive exit at the bid;
 *   · health flags ≥ 5 OR λ_live < 1 with
 *     the value below par for a sustained
 *     stretch AND another market certified → abandon the market entirely and
 *                                            rotate.
 */
export function liveExitDecision(params: {
  ticksSurvived: number;
  targetTicks: number;
  growthRate: number;
  valueMultiple: number;
  lambdaLive: number;
  lambdaLowerLive: number;
  flags: number;
  cusumTripped: boolean;
  sprt: SprtState["decision"];
  rotationCandidateAvailable: boolean;
}): ExitDecision {
  const profitMultiple = params.valueMultiple - 1;

  if (profitMultiple >= Math.pow(1 + params.growthRate, params.targetTicks) - 1 - 1e-9) {
    return { action: "sell_target", reason: `Target horizon reached at ${params.valueMultiple.toFixed(4)}× — take the profit.` };
  }
  if (params.flags >= 5) {
    return {
      action: "abandon_market",
      reason: `Health flags ${params.flags}: survival on this market no longer matches the reading it was opened on.`,
    };
  }
  if (params.lambdaLive < 1 && params.valueMultiple >= 1) {
    return {
      action: "sell_defensive",
      reason: `Live λ ${params.lambdaLive.toFixed(5)} < 1 while the position is at ${params.valueMultiple.toFixed(4)}× — leave at par rather than ride it into a knockout.`,
    };
  }
  if (params.flags >= 2 && params.valueMultiple >= 1) {
    return {
      action: "sell_defensive",
      reason: `${params.flags} health flag(s) with the position still above par — take the exit while it is free.`,
    };
  }
  if (params.sprt === "accept_decayed" && params.valueMultiple >= 1) {
    return {
      action: "sell_defensive",
      reason: `SPRT has accepted the decayed-survival hypothesis (α-bounded) with the position at ${params.valueMultiple.toFixed(4)}× — banking the accumulated value instead of defending it.`,
    };
  }
  if (params.cusumTripped && params.valueMultiple < 1 && params.rotationCandidateAvailable) {
    return {
      action: "abandon_market",
      reason: `CUSUM tripped with the position below par — closing this market and re-scanning.`,
    };
  }
  return { action: "hold", reason: `Holding: λ_live ${params.lambdaLive.toFixed(5)}, ${params.valueMultiple.toFixed(4)}× at tick ${params.ticksSurvived}/${params.targetTicks}.` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session projection
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionProjection {
  shots: number;
  expectedProfit: number;
  expectedEv: number;
  ruinProbability: number;
  expectedDebt: number;
}

/**
 * How many consecutive shots a session can afford. A knockout costs exactly the
 * stake, so the ruin path is short and exact: the session dies when the
 * accumulated debt reaches the user's stop loss.
 */
export function projectSession(params: {
  stake: number;
  growthRate: number;
  horizonTicks: number;
  survival: readonly number[];
  stopLoss: number;
  targetProfit: number;
}): SessionProjection {
  const { stake, growthRate, horizonTicks, stopLoss, targetProfit } = params;
  const p = params.survival[horizonTicks] ?? 0;
  const winProfit = stake * (Math.pow(1 + growthRate, horizonTicks) - 1);
  const shotsToTarget = winProfit > 0 ? Math.ceil(targetProfit / winProfit) : Infinity;
  const shotsToRuin = stake > 0 ? Math.ceil(stopLoss / stake) : Infinity;
  const shots = Math.min(shotsToTarget, shotsToRuin);
  const evPerShot = p * winProfit - (1 - p) * stake;
  return {
    shots: Number.isFinite(shots) ? shots : 0,
    expectedProfit: Number.isFinite(shots) ? evPerShot * shots : 0,
    expectedEv: evPerShot,
    ruinProbability: Number.isFinite(shotsToRuin) ? Math.pow(1 - p, shotsToRuin) : 0,
    expectedDebt: (1 - p) * stake,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Format λ for the UI/reason strings without lying about the precision. */
export function formatLambda(lambda: number): string {
  return lambda.toFixed(5);
}
