/**
 * WP2 — walk-forward split tests.
 *
 * Purge and embargo are the difference between a study and a sales pitch. The
 * tests are written as properties of the INDICES, because the failure mode
 * (one overlapping index) is invisible in the output statistics and enormous in
 * the conclusions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cpcvSplits, splitIsClean, testIndices, trainIndices, walkForwardSplits } from "./walkforward";

test("every split is clean: training ends before the embargo ends and the test begins", () => {
  const splits = walkForwardSplits(3000, { trainBars: 600, testBars: 200, purgeBars: 50, embargoBars: 6 });
  assert.ok(splits.length > 5, `expected several windows, got ${splits.length}`);
  for (const split of splits) {
    assert.ok(splitIsClean(split), `training leaked into the test window: ${JSON.stringify(split)}`);
    // The purge removes 50 bars of the training tail…
    assert.equal(split.trainEnd, split.trainStart + 600 - 50);
    // …and the embargo opens the test window 6 bars later.
    assert.equal(split.testStart, split.trainStart + 600 + 6);
    assert.ok(split.testEnd - split.testStart >= 5);
  }
});

test("no index is ever both trained on and tested on", () => {
  const splits = walkForwardSplits(2000, { trainBars: 400, testBars: 150 });
  for (const split of splits) {
    const train = new Set(trainIndices(split));
    for (const index of testIndices(split)) assert.equal(train.has(index), false, `index ${index} appears in both halves`);
  }
});

test("windows advance by the step and cover the series", () => {
  const splits = walkForwardSplits(1200, { trainBars: 400, testBars: 200, stepBars: 200, purgeBars: 50, embargoBars: 4 });
  // Windows start every 200 bars while a full window (400 train + 4 embargo +
  // 10 minimum test) still fits inside the 1200-bar series.
  assert.deepEqual(
    splits.map((s) => s.trainStart),
    [0, 200, 400, 600],
  );
  assert.equal(splits[0]?.testEnd, 604);
});

test("a series too short for even one window produces no splits, not a broken one", () => {
  assert.deepEqual(walkForwardSplits(100, { trainBars: 400, testBars: 200 }), []);
});

test("CPCV produces every combination of test groups, and the halves are disjoint", () => {
  const splits = cpcvSplits(600, 6, 2);
  assert.equal(splits.length, 15); // C(6,2)
  for (const { train, test } of splits) {
    assert.equal(train.length + test.length, 600);
    const trainSet = new Set(train);
    for (const index of test) assert.equal(trainSet.has(index), false);
  }
});
