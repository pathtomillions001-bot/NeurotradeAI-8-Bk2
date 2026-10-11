/**
 * Desk v4 research harness — performance and calibration metrics (WP2).
 *
 * Two families of number, and the distinction matters:
 *
 *   PERFORMANCE — mean R, hit rate, streaks, drawdown, PSR/DSR. These answer
 *   "did it work". On their own they are the numbers that lie, because a
 *   strategy selected after looking at a hundred of them will show a good one
 *   by construction, which is what the DSR and PBO deflation exist to expose.
 *
 *   CALIBRATION — Brier score, Brier skill and the reliability slope. These
 *   answer "did the probability it printed mean anything", which is a SEPARATE
 *   question from profitability and the one the whole v4 programme is built on:
 *   a model that says 62% and delivers 45% cannot be used to size a position
 *   however well the equity curve happens to look.
 */

import type { Bar } from "../types";
import {
  deflatedSharpeRatio,
  longestStreak,
  maxDrawdown,
  mean,
  median,
  probabilisticSharpeRatio,
  quantile,
  stdev,
  weightedLinearFit,
} from "./numerics";
import type { HarnessDecision, ReplayResult, RunMetrics } from "./types";

export interface MetricsInput {
  decisions: HarnessDecision[];
  trades: ReplayResult[];
  /**
   * Number of configurations the search actually covered. Used to deflate the
   * Sharpe ratio; understating it is the easiest way to manufacture a false
   * positive, so the harness reports it next to every DSR.
   */
  dsrTrials: number;
  /** Bins used for the reliability plot. 10 is the usual decile reading. */
  reliabilityBins?: number;
}

/**
 * Build the full metric set for one run.
 *
 * Trades here are FILLED plans only; the arm rate and fill rate carry the
 * information about what was declined, so mixing unfilled plans into the R
 * statistics would silently treat "did not trade" as "traded for zero".
 */
export function computeMetrics(input: MetricsInput): RunMetrics {
  const { decisions, trades } = input;
  const bins = input.reliabilityBins ?? 10;
  const evaluations = decisions.length;
  const arms = decisions.filter((decision) => decision.armed).length;
  const filled = trades.filter((trade) => trade.filled);
  const rSeries = filled.map((trade) => trade.realisedR ?? 0);

  const wins = rSeries.filter((value) => value > 0).length;
  const hitRate = rSeries.length > 0 ? wins / rSeries.length : 0;
  const meanR = rSeries.length > 0 ? mean(rSeries) : 0;
  const sd = stdev(rSeries);
  const meanRStdError = rSeries.length > 1 ? sd / Math.sqrt(rSeries.length) : 0;

  // 5% CVaR: the mean of the worst 5% of outcomes, expressed as a positive loss.
  const tail = quantile(rSeries, 0.05);
  const tailValues = rSeries.filter((value) => value <= tail);
  const cvar5R = tailValues.length > 0 ? -mean(tailValues) : 0;

  const cumulative: number[] = [];
  let running = 0;
  for (const value of rSeries) {
    running += value;
    cumulative.push(running);
  }

  // ── Calibration ────────────────────────────────────────────────────────────
  const predictions = filled
    .map((trade, index) => ({
      predicted: decisions.find((decision) => decision.plan?.id === trade.planId)?.predictedProbability,
      realised: (trade.realisedR ?? 0) > 0 ? 1 : 0,
      index,
    }))
    .filter((row): row is { predicted: number; realised: number; index: number } =>
      typeof row.predicted === "number" && Number.isFinite(row.predicted),
    );

  let brierScore: number | null = null;
  let brierSkill: number | null = null;
  let reliabilityBinsOut: RunMetrics["reliabilityBins"] = [];
  let reliabilitySlope: number | null = null;

  if (predictions.length >= 10) {
    brierScore = mean(predictions.map((row) => (row.predicted - row.realised) ** 2));
    const baseRate = mean(predictions.map((row) => row.realised));
    const reference = baseRate * (1 - baseRate);
    // Brier skill against the climatology forecast. Zero means "no better than
    // always predicting the base rate", which is the bar the gate sets.
    brierSkill = reference > 0 ? 1 - brierScore / reference : null;

    reliabilityBinsOut = calibrationBins(
      predictions.map((row) => ({ predicted: row.predicted, realised: row.realised })),
      bins,
    );
    const usable = reliabilityBinsOut.filter((bin) => bin.count >= 5);
    if (usable.length >= 3) {
      reliabilitySlope = weightedLinearFit(
        usable.map((bin) => bin.predicted),
        usable.map((bin) => bin.observed),
        usable.map((bin) => bin.count),
      ).slope;
    }
  }

  return {
    evaluations,
    arms,
    fills: trades.filter((trade) => trade.filled).length,
    armRate: evaluations > 0 ? arms / evaluations : 0,
    fillRate: arms > 0 ? trades.filter((trade) => trade.filled).length / arms : 0,
    trades: rSeries.length,
    wins,
    hitRate,
    meanR,
    medianR: rSeries.length > 0 ? median(rSeries) : 0,
    totalR: running,
    meanRStdError,
    cvar5R,
    maeMeanR: filled.length > 0 ? mean(filled.map((trade) => trade.maeR)) : 0,
    mfeMeanR: filled.length > 0 ? mean(filled.map((trade) => trade.mfeR)) : 0,
    longestLosingStreak: longestStreak(rSeries, (value) => value <= 0),
    maxDrawdownR: maxDrawdown(cumulative, "absolute"),
    costRMean: filled.length > 0 ? mean(filled.map((trade) => trade.costR)) : 0,
    brierScore,
    brierSkill,
    reliabilityBins: reliabilityBinsOut,
    reliabilitySlope,
    probabilisticSharpe: rSeries.length >= 3 ? probabilisticSharpeRatio(rSeries, 0) : 0,
    deflatedSharpe: rSeries.length >= 3 ? deflatedSharpeRatio(rSeries, input.dsrTrials) : 0,
    dsrTrials: input.dsrTrials,
  };
}

/**
 * Reliability bins: predicted probability against observed frequency.
 *
 * Equal-count bins rather than fixed edges, because a strategy that only ever
 * predicts 55–65% would otherwise put every trade in two of ten fixed bins and
 * the middle of the plot would be empty — which reads as "no calibration data"
 * rather than "the model is narrow".
 */
export function calibrationBins(
  rows: { predicted: number; realised: number }[],
  binCount: number,
): { predicted: number; observed: number; count: number }[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.predicted - b.predicted);
  const perBin = Math.max(1, Math.floor(sorted.length / binCount));
  const out: { predicted: number; observed: number; count: number }[] = [];
  for (let start = 0; start < sorted.length; start += perBin) {
    const slice = sorted.slice(start, start + perBin);
    if (slice.length === 0) continue;
    out.push({
      predicted: mean(slice.map((row) => row.predicted)),
      observed: mean(slice.map((row) => row.realised)),
      count: slice.length,
    });
  }
  return out;
}

/** Per-trade return series of a run, in R. */
export function rSeriesOf(trades: ReplayResult[]): number[] {
  return trades.filter((trade) => trade.filled).map((trade) => trade.realisedR ?? 0);
}

/**
 * Equity-curve series in R, for plotting and for the drawdown statistics.
 * Compounded at a fixed fractional risk would need an account size, which the
 * harness deliberately does not assume; R units are the honest common currency.
 */
export function equityCurve(trades: ReplayResult[]): number[] {
  const out: number[] = [];
  let running = 0;
  for (const value of rSeriesOf(trades)) {
    running += value;
    out.push(running);
  }
  return out;
}

/**
 * Trade-level statistics grouped by an exit reason, for attribution: knowing
 * that a strategy's entire loss comes from time stops is worth more than
 * knowing its total.
 */
export function attributionByExit(trades: ReplayResult[]): Record<string, { count: number; meanR: number; totalR: number }> {
  const groups = new Map<string, number[]>();
  for (const trade of trades) {
    if (!trade.filled) continue;
    const key = trade.exitReason ?? "unknown";
    const list = groups.get(key);
    if (list) list.push(trade.realisedR ?? 0);
    else groups.set(key, [trade.realisedR ?? 0]);
  }
  const out: Record<string, { count: number; meanR: number; totalR: number }> = {};
  for (const [key, values] of groups) {
    out[key] = { count: values.length, meanR: mean(values), totalR: values.reduce((a, b) => a + b, 0) };
  }
  return out;
}

/** Bar count helper used by the report to describe the evaluated window. */
export function windowDescription(bars: Bar[]): { from: number; to: number; days: number } {
  if (bars.length === 0) return { from: 0, to: 0, days: 0 };
  const from = bars[0]![0]!;
  const to = bars[bars.length - 1]![0]!;
  return { from, to, days: (to - from) / 86_400_000 };
}
