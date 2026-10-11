/**
 * Desk v4 research harness — walk-forward and CPCV splits (WP2).
 *
 * A single train/test split answers one question about one period. Walk-forward
 * answers "does this hold up repeatedly, on data it had not seen", which is the
 * only version of the question that transfers to live trading.
 *
 * Two things are non-negotiable in the split construction:
 *
 *   PURGE  — a training observation whose label window (the horizon it is
 *            labelled over) overlaps the test block is REMOVED, not just
 *            down-weighted. With a 30-bar horizon, the last 30 training rows
 *            before a test block are literally labelled with test-period
 *            prices; leaving them in is the most common form of leakage in
 *            financial ML and it flatters every model it touches.
 *
 *   EMBARGO — a gap after the test block, because a trader's features and the
 *            market's response are serially correlated: the bars immediately
 *            after a test window are contaminated by it.
 *
 * Both are deliberately conservative (they throw away data). The harness is not
 * trying to win a data-efficiency contest; it is trying not to fool itself.
 */

export interface Fold {
  /** Index of the fold, for reporting. */
  index: number;
  /** Observation indices usable for training (already purged and embargoed). */
  train: number[];
  /**
   * The exact held-out blocks, each inclusive of `from` and exclusive of `to`.
   *
   * A walk-forward fold has one; a CPCV fold has `testGroups` of them, and they
   * are NOT contiguous — representing that union as a single range would tell a
   * caller that everything between the first and last held-out group was
   * out-of-sample when most of it was training data. Use this field.
   */
  testRanges: { from: number; to: number }[];
  /**
   * Bounding span of the held-out blocks: the smallest `from` and the largest
   * `to`. Convenient for logging and for sizing, and NOT the test set for a
   * non-contiguous fold.
   */
  testFrom: number;
  testTo: number;
}

export interface WalkForwardOptions {
  total: number;
  trainSize: number;
  testSize: number;
  /** Label horizon in observations; drives the purge width. */
  horizon: number;
  /** Observations dropped after each test block. */
  embargo: number;
  /** Advance between folds. Defaults to `testSize` (non-overlapping tests). */
  step?: number;
  /** Cap on the number of folds, keeping the most recent. */
  maxFolds?: number;
}

/** Rolling purged, embargoed walk-forward folds. */
export function purgedWalkForward(options: WalkForwardOptions): Fold[] {
  const { total, trainSize, testSize, horizon, embargo } = options;
  const step = options.step ?? testSize;
  if (trainSize <= 0 || testSize <= 0 || total < trainSize + testSize) return [];

  const folds: Fold[] = [];
  let index = 0;
  for (let trainEnd = trainSize; trainEnd + testSize <= total; trainEnd += step) {
    const testFrom = trainEnd;
    const testTo = Math.min(total, trainEnd + testSize);
    const train: number[] = [];
    for (let i = 0; i < trainEnd; i++) {
      // Purge anything whose label window reaches into the test block.
      if (i + horizon >= testFrom) continue;
      train.push(i);
    }
    folds.push({ index, train, testRanges: [{ from: testFrom, to: testTo }], testFrom, testTo });
    index += 1;
  }
  const capped = options.maxFolds ? folds.slice(-options.maxFolds) : folds;
  return capped.map((fold, position) => ({ ...fold, index: position }));
}

export interface CpcvOptions {
  total: number;
  /** Number of contiguous groups to split the series into. */
  groups: number;
  /** Groups held out per split. Defaults to `groups / 2`. */
  testGroups?: number;
  horizon: number;
  embargo: number;
  /** Cap on the number of combinations, sampled deterministically if exceeded. */
  maxSplits?: number;
}

/**
 * Combinatorially Purged Cross-Validation splits.
 *
 * Every combination of `testGroups` groups is held out once, so each
 * observation is tested several times and the result is a DISTRIBUTION of
 * out-of-sample outcomes rather than a single path. That distribution is what
 * the Probability of Backtest Overfitting consumes: a strategy whose OOS
 * performance depends on which slice was held out has no edge, only a
 * favourable slice.
 */
export function combinatorialPurgedCV(options: CpcvOptions): Fold[] {
  const { total, horizon, embargo } = options;
  const groups = Math.max(2, Math.floor(options.groups));
  const testGroups = Math.max(1, Math.min(options.testGroups ?? Math.floor(groups / 2), groups - 1));
  if (total < groups * 2) return [];

  const bounds: { from: number; to: number }[] = [];
  const size = Math.floor(total / groups);
  for (let g = 0; g < groups; g++) {
    const from = g * size;
    const to = g === groups - 1 ? total : from + size;
    bounds.push({ from, to });
  }

  const combinations = combinationsOf(groups, testGroups);
  const capped =
    options.maxSplits && combinations.length > options.maxSplits
      ? // Deterministic thinning: keep every k-th combination so the choice of
        // splits does not itself depend on a random draw.
        combinations.filter((_, position) => position % Math.ceil(combinations.length / options.maxSplits!) === 0)
      : combinations;

  return capped.map((testGroupIndices, index) => {
    const testSet = new Set(testGroupIndices);
    const testBlocks = testGroupIndices.map((g) => bounds[g]!);
    const testFrom = Math.min(...testBlocks.map((block) => block.from));
    const testTo = Math.max(...testBlocks.map((block) => block.to));

    const train: number[] = [];
    for (let g = 0; g < groups; g++) {
      if (testSet.has(g)) continue;
      const block = bounds[g]!;
      for (let i = block.from; i < block.to; i++) {
        // Purge a training row whose label horizon reaches ANY test block, and
        // drop the embargo window that follows one.
        const leaks = testBlocks.some((test) => i + horizon >= test.from && i <= test.to);
        const inEmbargo = testBlocks.some((test) => i > test.to && i <= test.to + embargo);
        if (!leaks && !inEmbargo) train.push(i);
      }
    }
    return { index, train, testRanges: testBlocks.map((block) => ({ from: block.from, to: block.to })), testFrom, testTo };
  });
}

function combinationsOf(n: number, k: number): number[][] {
  const out: number[][] = [];
  const current: number[] = [];
  const walk = (start: number) => {
    if (current.length === k) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < n; i++) {
      current.push(i);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}
