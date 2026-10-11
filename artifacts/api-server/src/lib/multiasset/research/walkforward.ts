/**
 * Research harness — walk-forward splits with PURGE and EMBARGO (WP2).
 *
 * ── WHY THIS IS NOT A SIMPLE TRAIN/TEST SPLIT ───────────────────────────────
 *
 * A label at time t is decided by what happens between t and t + horizon. If a
 * test window starts immediately after a training window, the last training
 * labels are decided by price action INSIDE the test window: the model has
 * literally been shown part of the future it is then scored on. That is
 * leakage, and on a volatile series it is worth whole percentage points of
 * fake accuracy.
 *
 * Two mechanisms fix it, and both are needed:
 *
 *   PURGE — drop training samples whose label window overlaps the test window.
 *           (`purgeBars` should be ≥ the longest label horizon.)
 *   EMBARGO — drop the first `embargoBars` of the test window, because
 *           features at the start of the test window were computed from data
 *           that overlaps the training tail (serial correlation in the
 *           features themselves, not just the labels).
 *
 * The splits are ROLLING (anchored start, fixed-size training window) so the
 * harness measures a strategy that would have been re-fitted as time passed,
 * not one fitted once on everything.
 */

export interface WalkForwardSplit {
  /** Inclusive start index of the training window. */
  trainStart: number;
  /** Exclusive end index of the training window. */
  trainEnd: number;
  /** Inclusive start index of the test window (after the embargo). */
  testStart: number;
  /** Exclusive end index of the test window. */
  testEnd: number;
}

export interface WalkForwardOptions {
  /** Bars per training window. */
  trainBars: number;
  /** Bars per test window. */
  testBars: number;
  /**
   * Bars purged from the END of the training window (label horizon).
   * Defaults to `testBars / 4`.
   */
  purgeBars?: number;
  /** Bars dropped from the START of the test window. Defaults to 1% of train. */
  embargoBars?: number;
  /** Advance between consecutive windows. Defaults to `testBars`. */
  stepBars?: number;
}

export function walkForwardSplits(total: number, options: WalkForwardOptions): WalkForwardSplit[] {
  const trainBars = Math.max(10, Math.floor(options.trainBars));
  const testBars = Math.max(2, Math.floor(options.testBars));
  const purgeBars = Math.max(0, Math.floor(options.purgeBars ?? Math.floor(testBars / 4)));
  const embargoBars = Math.max(1, Math.floor(options.embargoBars ?? Math.max(1, Math.floor(trainBars * 0.01))));
  const stepBars = Math.max(1, Math.floor(options.stepBars ?? testBars));

  const splits: WalkForwardSplit[] = [];
  for (let start = 0; start + trainBars + embargoBars + 10 <= total; start += stepBars) {
    const trainStart = start;
    // The purge removes the training tail whose labels reach into the test set.
    const trainEnd = trainStart + trainBars - purgeBars;
    const testStart = trainStart + trainBars + embargoBars;
    const testEnd = Math.min(total, testStart + testBars);
    if (testEnd - testStart < 5) break;
    splits.push({ trainStart, trainEnd, testStart, testEnd });
  }
  return splits;
}

/**
 * Every (index, split) pair where the index may be used for training, with the
 * test indices excluded and the purge/embargo applied.
 *
 * Returned as a flat list so a caller cannot accidentally iterate "all bars"
 * and re-introduce the leakage this module exists to prevent.
 */
export function trainIndices(split: WalkForwardSplit): number[] {
  const out: number[] = [];
  for (let i = split.trainStart; i < split.trainEnd; i++) out.push(i);
  return out;
}

export function testIndices(split: WalkForwardSplit): number[] {
  const out: number[] = [];
  for (let i = split.testStart; i < split.testEnd; i++) out.push(i);
  return out;
}

/**
 * CPCV split families: every combination of `testGroups` blocks out of
 * `groups`, as index lists. Used by the PBO metric — the point of CPCV is that
 * it produces a DISTRIBUTION of out-of-sample results rather than one, which
 * is what makes "how often does the in-sample winner lose out of sample?" a
 * measurable question.
 */
export function cpcvSplits(
  total: number,
  groups = 6,
  testGroups = 2,
): { train: number[]; test: number[] }[] {
  const bounds: [number, number][] = [];
  const size = Math.floor(total / groups);
  for (let g = 0; g < groups; g++) {
    bounds.push([g * size, g === groups - 1 ? total : (g + 1) * size]);
  }
  const combos: number[][] = [];
  const walk = (start: number, acc: number[]): void => {
    if (acc.length === testGroups) {
      combos.push([...acc]);
      return;
    }
    for (let i = start; i < groups; i++) {
      acc.push(i);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);

  return combos.map((combo) => {
    const testSet = new Set(combo);
    const train: number[] = [];
    const test: number[] = [];
    for (let g = 0; g < groups; g++) {
      const [from, to] = bounds[g] as [number, number];
      for (let i = from; i < to; i++) (testSet.has(g) ? test : train).push(i);
    }
    return { train, test };
  });
}

/**
 * Assert that no index appears in both halves of a split.
 *
 * A cheap, explicit guard: the failure mode it catches (one overlapping index)
 * is invisible in the results and enormous in the conclusions.
 */
export function splitIsClean(split: WalkForwardSplit): boolean {
  return split.trainEnd <= split.testStart;
}
