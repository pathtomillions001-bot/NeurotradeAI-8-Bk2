/**
 * Desk v4 research harness — timeframe view over an M1 series (WP2).
 *
 * The desk analyses several timeframes at once (a mode's whole band, plus the
 * entry frame). Aggregating on demand inside the evaluation loop would be both
 * slow and — much worse — an easy place for a lookahead bug to hide.
 *
 * So every aggregation is built ONCE, up front, and the only thing the harness
 * ever asks is "how many of those buckets exist as of bar i". Two counters per
 * timeframe answer that, and both are monotone in i by construction:
 *
 *   `bucketCountAt[i]`        buckets whose bucket-start is <= bars[i].ts.
 *                             The last of these may be FORMING — it contains
 *                             bars up to and including i, and nothing later.
 *                             This is what a live terminal sees.
 *
 *   `closedBucketCountAt[i]`  buckets that are provably complete by bar i, i.e.
 *                             every M1 bar of the bucket is present. Never
 *                             includes the bar i sits in. This is what an ATR
 *                             or a "closed bar confirmed" test must use.
 *
 * Using the wrong one of these two is the classic way an intraday backtest
 * accidentally reads the future, so they are named differently, computed
 * separately, and the simulator only ever consumes the closed counter for
 * anything that feeds a decision.
 */

import type { Bar, Timeframe } from "../types";
import { aggregateBars, timeframeMs } from "./data";
import { ALL_TIMEFRAMES } from "../types";
import type { Dataset } from "./types";

export interface MarketView {
  dataset: Dataset;
  /** Aggregated bars per timeframe, index-aligned to the bucket grid. */
  aggregated: Partial<Record<Timeframe, Bar[]>>;
  /** Number of buckets (forming included) available at M1 index i. */
  bucketCountAt: Partial<Record<Timeframe, Int32Array>>;
  /** Number of provably CLOSED buckets available at M1 index i. */
  closedBucketCountAt: Partial<Record<Timeframe, Int32Array>>;
}

/**
 * Build the view. `timeframes` defaults to every frame the desk can analyse,
 * which is what `ALL_TIMEFRAMES` is for — M1 is included as a pass-through so
 * a caller never has to special-case it.
 */
export function buildMarketView(
  dataset: Dataset,
  timeframes: readonly Timeframe[] = ALL_TIMEFRAMES,
): MarketView {
  const bars = dataset.bars;
  const aggregated: Partial<Record<Timeframe, Bar[]>> = {};
  const bucketCountAt: Partial<Record<Timeframe, Int32Array>> = {};
  const closedBucketCountAt: Partial<Record<Timeframe, Int32Array>> = {};

  for (const timeframe of timeframes) {
    const width = timeframeMs(timeframe);
    const series = timeframe === "M1" ? bars : aggregateBars(bars, timeframe);
    aggregated[timeframe] = series;

    const forming = new Int32Array(bars.length);
    const closed = new Int32Array(bars.length);
    // Index of the bucket each M1 bar belongs to, so both counters are a walk
    // rather than a search.
    let bucketIndex = 0;
    for (let i = 0; i < bars.length; i++) {
      const ts = bars[i]![0]!;
      const bucketStart = Math.floor(ts / width) * width;
      // Advance the bucket pointer to the bucket containing this bar.
      while (
        bucketIndex + 1 < series.length &&
        series[bucketIndex + 1]![0]! <= bucketStart
      ) {
        bucketIndex += 1;
      }
      forming[i] = bucketIndex + 1;
      const bucketEnd = bucketStart + width;
      // The bucket is closed once a later bar exists outside it.
      const nextTs = i + 1 < bars.length ? bars[i + 1]![0]! : Infinity;
      closed[i] = nextTs >= bucketEnd ? bucketIndex + 1 : bucketIndex;
    }
    bucketCountAt[timeframe] = forming;
    closedBucketCountAt[timeframe] = closed;
  }

  return { dataset, aggregated, bucketCountAt, closedBucketCountAt };
}

/** The bars of `timeframe` visible at M1 index `i`, forming bucket included. */
export function seriesAt(view: MarketView, timeframe: Timeframe, i: number): Bar[] {
  const series = view.aggregated[timeframe];
  const counts = view.bucketCountAt[timeframe];
  if (!series || !counts) return [];
  const count = counts[Math.max(0, Math.min(i, counts.length - 1))] ?? 0;
  return series.slice(0, count);
}

/** The bars of `timeframe` provably closed by M1 index `i`. */
export function closedSeriesAt(view: MarketView, timeframe: Timeframe, i: number): Bar[] {
  const series = view.aggregated[timeframe];
  const counts = view.closedBucketCountAt[timeframe];
  if (!series || !counts) return [];
  const count = counts[Math.max(0, Math.min(i, counts.length - 1))] ?? 0;
  return series.slice(0, count);
}

/**
 * Every frame a decision may look at, sliced at index `i`.
 *
 * This is the ONLY function the harness uses to produce `AgentInput.series`,
 * which is what makes the prefix-replay test meaningful: if a decision ever
 * depended on a bar after `i`, this function could not have supplied it.
 */
export function seriesBundleAt(
  view: MarketView,
  i: number,
  timeframes: readonly Timeframe[],
): Partial<Record<Timeframe, Bar[]>> {
  const out: Partial<Record<Timeframe, Bar[]>> = {};
  for (const timeframe of timeframes) {
    const series = seriesAt(view, timeframe, i);
    if (series.length > 0) out[timeframe] = series;
  }
  return out;
}
