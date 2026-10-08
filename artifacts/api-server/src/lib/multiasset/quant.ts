/**
 * Quantitative primitives for measuring the Desk's edge.
 *
 * Everything here is deterministic and dependency-free: the same trade history
 * always yields the same numbers, which is the property a backtest and a
 * journal review both need. The bootstrap is seeded for the same reason.
 *
 * What these do NOT do: they cannot make a strategy profitable. They make it
 * possible to tell a real edge from a lucky run — a sample Sharpe of 1.2 over
 * 30 trades carries a confidence interval that usually spans zero, and the
 * interval, not the point estimate, is what this module is for reporting.
 */

import { makeRng, mean, stdev } from "./math";
import { performanceStats, type PerformanceStats } from "./analytics";

/**
 * The t-statistic at which half of a measured drift is kept.
 *
 * Under no drift at all, a window's drift t-statistic is itself noise, roughly
 * standard normal. Keeping half the drift at t = 1 would give half-weight to
 * pure noise, so the constant is set at 3. At 3, a t of 1 keeps about 10%, a t
 * of 2 about 31%, and a clear trend (t of 9 or more) about 90%.
 *
 * Measured with the complete gate on zero-drift walks (40 windows per mode): the
 * intraday gate arms 1 window, the swing gate 3, and the scalp gate 0. A stronger
 * drift arms more, as it should (0.2σ per bar: 14 and 18 of 40).
 */
export const DRIFT_HALF_KEEP_T = 3;

/**
 * Shrink a measured per-bar drift toward zero by how clearly it stands out.
 *
 * The drift is the mean of `sampleSize` per-bar log returns, with per-bar
 * volatility `sigma`, so its t-statistic is t = drift·√n / σ. The weight kept
 * is t² / (t² + c²), with c = DRIFT_HALF_KEEP_T: the drift is kept only in
 * proportion to how far it clears its own noise.
 *
 * `sampleSize` must be the number of returns the drift was measured over, which
 * is `RegimeAssessment.driftSamples` (the regime's own window). Passing the length
 * of the whole history overstates t by √(history / window), and the gate then
 * trusts noise. That exact error was in the first version of this change.
 *
 * Why this exists: the desk used to project the recent trend forward at full
 * strength. Over a few hundred bars that projection is almost always too
 * optimistic, and the gate then reads optimism as an edge.
 */
export function shrinkDrift(
  drift: number,
  sigma: number,
  sampleSize: number,
  halfKeepT: number = DRIFT_HALF_KEEP_T,
): number {
  if (!Number.isFinite(drift) || !(sigma > 0) || sampleSize < 2) return 0;
  const t = (drift * Math.sqrt(sampleSize)) / sigma;
  const weight = (t * t) / (t * t + halfKeepT * halfKeepT);
  return drift * weight;
}

/** t-statistic of the mean of `values` (0 when it cannot be measured). */
export function tStatistic(values: number[]): number {
  if (values.length < 2) return 0;
  const sd = stdev(values);
  return sd === 0 ? 0 : (mean(values) * Math.sqrt(values.length)) / sd;
}

/**
 * Sortino ratio with a zero target: mean return over the downside deviation.
 *
 * The downside deviation is taken over ALL observations (wins contribute zero),
 * which is the standard definition; dividing by the losers alone overstates it.
 */
export function sortinoRatio(values: number[]): number {
  if (values.length < 2) return 0;
  const downside = Math.sqrt(values.reduce((acc, v) => acc + Math.min(0, v) ** 2, 0) / values.length);
  return downside > 0 ? mean(values) / downside : 0;
}

/** Per-trade Sharpe, scaled to a year by the number of trades that year. */
export function annualisedSharpe(values: number[], tradesPerYear: number): number {
  const sd = stdev(values);
  if (values.length < 2 || !(sd > 0) || !(tradesPerYear > 0)) return 0;
  return (mean(values) / sd) * Math.sqrt(tradesPerYear);
}

/**
 * Worst peak-to-trough fall of a compounded equity curve, in percent.
 *
 * `returns` are fractional account returns per trade (for example R × riskPct).
 * A return that takes equity to zero or below is treated as a total loss.
 */
export function maxDrawdownPct(returns: number[]): number {
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    equity = Math.max(0, equity * (1 + r));
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? (peak - equity) / peak : 1;
    if (drawdown > worst) worst = drawdown;
  }
  return worst * 100;
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

/**
 * Percentile bootstrap confidence interval of `statistic` over `values`.
 *
 * Seeded, so the same trades give the same interval on every run. `statistic`
 * must not retain the array it is handed: the buffer is reused between draws.
 */
export function bootstrapInterval(
  values: number[],
  statistic: (sample: number[]) => number,
  opts: { iterations?: number; confidence?: number; seed?: number } = {},
): Interval {
  const estimate = values.length > 0 ? statistic(values) : 0;
  if (values.length < 2) return { estimate, low: estimate, high: estimate };

  const iterations = opts.iterations ?? 2000;
  const confidence = opts.confidence ?? 0.95;
  const rng = makeRng(opts.seed ?? 1);
  const draws: number[] = [];
  const sample = new Array<number>(values.length).fill(0);
  for (let b = 0; b < iterations; b++) {
    for (let i = 0; i < values.length; i++) {
      sample[i] = values[Math.floor(rng() * values.length)] ?? 0;
    }
    draws.push(statistic(sample));
  }
  draws.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const at = (q: number) =>
    draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * (draws.length - 1))))] ?? estimate;
  return { estimate, low: at(alpha), high: at(1 - alpha) };
}

export interface TradeMetrics extends PerformanceStats {
  /** Mean R per trade. */
  expectancyR: number;
  /** 95% bootstrap interval for the expectancy. Wide on small samples, and that is the point. */
  expectancyCI95: Interval;
  tStat: number;
  sortino: number;
  /** Per-trade Sharpe (mean / sd). Not annualised. */
  sharpePerTrade: number;
  /** Sharpe scaled to a year. Null when the sample span is unknown. */
  sharpeAnnualised: number | null;
  /** Worst equity drawdown in percent at `riskPct` per trade. Null when riskPct is unknown. */
  maxDrawdownPct: number | null;
}

/**
 * Full metric set for a list of realised trade results in R.
 *
 * `years` is the span the trades cover (for annualising). `riskPct` is the
 * fraction of equity risked per trade in percent (for the drawdown in %).
 * Either can be omitted; the corresponding field is then null.
 */
export function tradeMetrics(
  rMultiples: number[],
  opts: { years?: number; riskPct?: number; seed?: number } = {},
): TradeMetrics {
  const base = performanceStats(rMultiples);
  const n = rMultiples.length;
  const sd = stdev(rMultiples);
  const sharpePerTrade = n >= 2 && sd > 0 ? mean(rMultiples) / sd : 0;
  const sharpeAnnualised =
    opts.years && opts.years > 0 ? annualisedSharpe(rMultiples, n / opts.years) : null;
  const maxDrawdown =
    opts.riskPct && opts.riskPct > 0 && n > 0
      ? maxDrawdownPct(rMultiples.map((r) => (r * opts.riskPct!) / 100))
      : null;

  return {
    ...base,
    expectancyR: n > 0 ? mean(rMultiples) : 0,
    expectancyCI95: bootstrapInterval(rMultiples, mean, { seed: opts.seed ?? 7 }),
    tStat: tStatistic(rMultiples),
    sortino: sortinoRatio(rMultiples),
    sharpePerTrade,
    sharpeAnnualised,
    maxDrawdownPct: maxDrawdown,
  };
}
