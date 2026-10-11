/**
 * WP5 — purged, embargoed folds and combinatorial paths over EVENTS.
 *
 * ── WHY NOT THE PRICE-SERIES SPLITTER ───────────────────────────────────────
 *
 * `research/walkforward.ts` splits a price series and purges the training
 * WINDOWS that overlap the test window. That is the right thing for a strategy
 * backtest, where a fold is a stretch of tape. A meta-model is not trained on
 * tape: it is trained on labelled events, each of which owns a stretch of tape
 * from its decision bar to its label's resolution. Two events with different
 * decision bars still leak into each other when their LABELS overlap, and no
 * bar-based purge can see that because the bars are not the unit any more.
 *
 * So the folds here are built on events:
 *
 *   • an event belongs to the fold that contains its decision bar;
 *   • the test block is a contiguous span of BARS (so a fold is still a period
 *     of the tape, not a random sample — a random split of overlapping events is
 *     the classic way to report a cross-validated score that is really in-sample);
 *   • training events whose label span [t0, t1] reaches into the test block, the
 *     purge window, or the embargo after it are REMOVED, not just down-weighted.
 *
 * `embargo` exists for the reason the brief gives: a model fitted on data that
 * ends one bar before the test block starts has seen the beginning of the test
 * block's outcomes through volatility clustering even when no label overlaps.
 *
 * The combinatorial variant (CPCV) builds every combination of `testGroups` out
 * of `groups`, which is what makes the PBO estimate in the report mean anything.
 */
import type { EventSpan } from "./uniqueness";
import { overlapsWithPurge } from "./uniqueness";

export interface EventFold {
  /** Index of the fold (0-based, in time order). */
  fold: number;
  /** Bars in the test block, half-open [start, end). */
  testBlock: { start: number; end: number };
  /** Indices (into the event array) used for training. */
  train: number[];
  /** Indices used for testing. */
  test: number[];
  /** Indices dropped because they overlapped the test block or the purge/embargo. */
  purged: number[];
}

export interface PurgedFoldOptions {
  folds: number;
  purgeBars: number;
  embargoBars: number;
}

/**
 * Purged, embargoed k-fold over events ordered by decision bar.
 *
 * `totalBars` is the length of the tape the events live on; folds are equal
 * spans of it, so a fold is a period rather than a count of rows.
 */
export function purgedEventFolds(
  events: { index: number; span: EventSpan }[],
  totalBars: number,
  options: PurgedFoldOptions,
): EventFold[] {
  const { folds, purgeBars, embargoBars } = options;
  const safeFolds = Math.max(2, Math.min(folds, Math.max(2, Math.floor(events.length / 4))));
  const blockSize = Math.max(1, Math.floor(totalBars / safeFolds));
  const out: EventFold[] = [];
  for (let fold = 0; fold < safeFolds; fold++) {
    const start = fold * blockSize;
    const end = fold === safeFolds - 1 ? totalBars : Math.min(totalBars, start + blockSize);
    const train: number[] = [];
    const test: number[] = [];
    const purged: number[] = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as { index: number; span: EventSpan };
      const inTest = event.index >= start && event.index < end;
      if (inTest) {
        test.push(i);
        continue;
      }
      if (overlapsWithPurge(event.span, { start, end }, purgeBars, embargoBars)) {
        purged.push(i);
        continue;
      }
      train.push(i);
    }
    out.push({ fold, testBlock: { start, end }, train, test, purged });
  }
  return out;
}

export interface CombinatorialSplit {
  /** Indices of the groups used for testing. */
  testGroups: number[];
  train: number[];
  test: number[];
}

/**
 * Combinatorial purged cross-validation: every combination of `testGroups`
 * groups out of `groups` is a test set, and the rest is training (purged).
 *
 * With `groups = 6` and `testGroups = 2` this yields 15 paths, each an
 * out-of-sample estimate on a different pair of periods — which is what the PBO
 * calculation needs. The count is reported so a report can never quote a CPCV
 * figure without saying how many paths produced it.
 */
export function combinatorialEventSplits(
  events: { index: number; span: EventSpan }[],
  totalBars: number,
  options: { groups: number; testGroups: number; purgeBars: number; embargoBars: number },
): CombinatorialSplit[] {
  const { groups, testGroups, purgeBars, embargoBars } = options;
  const blockSize = Math.max(1, Math.floor(totalBars / groups));
  const blocks = Array.from({ length: groups }, (_, g) => ({
    start: g * blockSize,
    end: g === groups - 1 ? totalBars : Math.min(totalBars, (g + 1) * blockSize),
  }));
  const combinations = choose(groups, testGroups);
  const splits: CombinatorialSplit[] = [];
  for (const combo of combinations) {
    const train: number[] = [];
    const test: number[] = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as { index: number; span: EventSpan };
      let isTest = false;
      let overlapsTest = false;
      for (const g of combo) {
        const block = blocks[g] as { start: number; end: number };
        if (event.index >= block.start && event.index < block.end) isTest = true;
        if (overlapsWithPurge(event.span, block, purgeBars, embargoBars)) overlapsTest = true;
      }
      if (isTest) test.push(i);
      else if (!overlapsTest) train.push(i);
    }
    splits.push({ testGroups: combo, train, test });
  }
  return splits;
}

function choose(n: number, k: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, picked: number[]): void => {
    if (picked.length === k) {
      out.push([...picked]);
      return;
    }
    for (let i = start; i < n; i++) walk(i + 1, [...picked, i]);
  };
  walk(0, []);
  return out;
}
