/**
 * WP5 — sample uniqueness and weights.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 *
 * Overlapping labels are not independent observations, and treating them as if
 * they were is the quiet way a backtest learns nothing.
 *
 * One agent's setup fires repeatedly on the same tape: two views 3 bars apart
 * over a 24-bar horizon share 21 of their bars, so their outcomes are largely
 * the same outcome. A logistic regression fitted on 400 such rows believes it
 * has 400 pieces of evidence when it has closer to 40, its standard errors are
 * far too small, and its coefficient on "the agent said yes" is inflated by the
 * label leakage between neighbours. The same defect makes a purged fold leaky
 * even after purging the bars: the *labels* still overlap.
 *
 * The fix is López de Prado's: attach to each event the inverse of how
 * concurrent it was with others over its own life, and use that as its weight:
 *
 *   uniqueness_i = mean over bars t in [t0_i, t1_i] of 1 / concurrency(t)
 *   weight_i     = uniqueness_i, normalised so the weights sum to the number of
 *                  EFFECTIVE observations rather than the number of rows
 *
 * An event that stands alone gets weight 1. Two events sharing their whole life
 * each get about 0.5, so their combined weight is 1 — one observation's worth of
 * evidence, which is what they are. The WP5 study feeds these weights to the fit
 * and reports the effective sample size (Kish) beside the row count, and the
 * probability lower bound in `pcb.ts` is computed from the effective size, so
 * the gatekeeper cannot be fooled by double-counted rows either.
 */
import type { Bar } from "../types";

export interface EventSpan {
  /** First bar the observation owns. */
  t0: number;
  /** Last bar it owns (the label's resolution, inclusive). */
  t1: number;
}

/**
 * How many observations own each bar, from the first to the last event.
 *
 * Returns an array indexed by bar index (absolute), so callers can pass it to
 * `uniquenessOf` without rebuilding it per event.
 */
export function concurrency(spans: EventSpan[]): { perBar: number[]; firstBar: number } {
  if (spans.length === 0) return { perBar: [], firstBar: 0 };
  let firstBar = Infinity;
  let lastBar = -Infinity;
  for (const span of spans) {
    firstBar = Math.min(firstBar, span.t0);
    lastBar = Math.max(lastBar, span.t1);
  }
  const perBar = new Array(Math.max(0, lastBar - firstBar + 1)).fill(0) as number[];
  for (const span of spans) {
    for (let t = span.t0; t <= span.t1; t++) {
      const offset = t - firstBar;
      if (offset >= 0 && offset < perBar.length) perBar[offset] = (perBar[offset] as number) + 1;
    }
  }
  return { perBar, firstBar };
}

/** Mean of 1/concurrency over the bars an event owns: its uniqueness. */
export function uniquenessOf(span: EventSpan, counts: { perBar: number[]; firstBar: number }): number {
  const len = span.t1 - span.t0 + 1;
  if (len <= 0) return 0;
  let sum = 0;
  for (let t = span.t0; t <= span.t1; t++) {
    const offset = t - counts.firstBar;
    const c = offset >= 0 && offset < counts.perBar.length ? (counts.perBar[offset] as number) : 1;
    sum += c > 0 ? 1 / c : 1;
  }
  return sum / len;
}

export interface WeightedSpan extends EventSpan {
  uniqueness: number;
  /** Uniqueness normalised so the weights sum to the effective sample count. */
  weight: number;
}

/**
 * Weights for a set of spans, plus the diagnostics a report needs to be honest
 * about how much evidence there really is.
 */
export function eventWeights(spans: EventSpan[]): {
  items: WeightedSpan[];
  /**
   * The evidence the corpus actually carries: the SUM of the uniquenesses.
   *
   * Ten events that share their whole life sum to 1, which is what they are
   * worth. Note that the Kish effective size CANNOT be used here and this is the
   * reason the two numbers are both reported: Kish is invariant to a common scale
   * factor, so ten identical events each weighted 0.1 give a Kish size of 10 —
   * it measures how UNEVEN the weights are, not how much independent evidence
   * there is.
   */
  independentObservations: number;
  /** Kish effective sample size: (Σw)² / Σw² — weight concentration. */
  kishEffectiveSampleSize: number;
  totalSpan: number;
  meanUniqueness: number;
} {
  const counts = concurrency(spans);
  const raw = spans.map((span) => uniquenessOf(span, counts));
  // The weight IS the uniqueness. Scaling them so they sum to the ROW COUNT — the
  // obvious-looking normalisation — cancels the discount exactly where it matters
  // most: ten identical events would each come back with a weight of 1, and the
  // effective sample size would read as ten. Left as they are, the weights sum to
  // the number of independent observations they actually represent, which is the
  // number the confidence bound in `pcb.ts` is built from.
  const items: WeightedSpan[] = spans.map((span, i) => {
    const uniqueness = raw[i] as number;
    return { ...span, uniqueness, weight: uniqueness };
  });
  let sumSq = 0;
  let sumW = 0;
  for (const item of items) {
    sumSq += item.weight ** 2;
    sumW += item.weight;
  }
  const covered = counts.perBar.reduce((a, c) => a + (c > 0 ? 1 : 0), 0);
  return {
    items,
    independentObservations: sumW,
    kishEffectiveSampleSize: sumSq > 0 ? (sumW * sumW) / sumSq : 0,
    totalSpan: covered,
    meanUniqueness: items.length > 0 ? sumW / items.length : 0,
  };
}

/**
 * Whether two spans overlap, allowing for a purge and an embargo.
 *
 * Used by the WP5 folds. `purgeBars` removes training events whose label starts
 * before the test block ends (their outcome is partly known to the test), and
 * `embargoBars` removes the ones that start shortly after it.
 */
export function overlapsWithPurge(
  span: EventSpan,
  block: { start: number; end: number },
  purgeBars = 0,
  embargoBars = 0,
): boolean {
  const blockStart = block.start - purgeBars;
  const blockEnd = block.end + embargoBars;
  return span.t1 >= blockStart && span.t0 <= blockEnd;
}

/** Bars the events cover in total (their union) — the report's honest span count. */
export function coveredBars(spans: EventSpan[]): number {
  return concurrency(spans).perBar.reduce((a, c) => a + (c > 0 ? 1 : 0), 0);
}

/** Convenience for the dataset builder: events come with bar indices and horizons. */
export function spanOf(bar: Bar, index: number, horizonBars: number): EventSpan {
  void bar;
  return { t0: index, t1: index + horizonBars };
}
