/**
 * WP5 unit tests — the meta-model's own machinery.
 *
 * These test the pieces a report can be wrong about without anything looking
 * broken: a label that looks forward, a weight that silently counts overlapping
 * events twice, a calibrator that memorises a singleton step, a confidence bound
 * that reports a probability from no evidence, and an embargo that does not
 * actually embargo. Each of those has a test that would catch it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bar } from "../types";
import { buildMetaDataset } from "./dataset";
import { combinatorialEventSplits, purgedEventFolds } from "./folds";
import {
  MIN_ISOTONIC_BLOCK_WEIGHT,
  applyIsotonic,
  fitCohortCalibrators,
  fitIsotonic,
  reliability,
} from "./isotonic";
import { tripleBarrier, labelHorizonFits } from "./labels";
import { brierScore, fitLogistic, logLoss, predictLogistic, solveLinearSystem } from "./logistic";
import { effectiveSampleSize, expectedValueLowerBound, probabilityLowerBound } from "./pcb";
import { concurrency, eventWeights, overlapsWithPurge, spanOf, uniquenessOf } from "./uniqueness";

/** A bar with an explicit high/low so a barrier touch is unambiguous. */
function bar(ts: number, open: number, high: number, low: number, close: number): Bar {
  return [ts, open, high, low, close, 100];
}

/** Flat bars, then a scripted move. */
function series(bars: Array<[number, number, number, number, number]>): Bar[] {
  return bars.map((values, i) => [1_700_000_000_000 + i * 300_000, ...values, 100] as Bar);
}

describe("meta/labels", () => {
  const entry = 100;
  const risk = 1;

  it("labels a target touch as +1 and a stop touch as −1", () => {
    const bars = series([
      [100, 100.2, 99.9, 100],
      [100, 100.2, 99.95, 100.05],
      [100, 102.5, 99.9, 102], // reaches 2R first
    ]);
    const hit = tripleBarrier({ bars, index: 0, side: "buy", entry, riskPrice: risk, rr: 2, horizonBars: 2 });
    assert.equal(hit?.label, 1);
    assert.equal(hit?.t1, 2);
    assert.ok((hit?.rMultiple ?? 0) > 1.9);
  });

  it("gives the stop a same-bar tie — the pessimistic resolution", () => {
    const bars = series([
      [100, 100.1, 99.9, 100],
      [100, 102.5, 98.5, 100], // both barriers inside one bar
    ]);
    const outcome = tripleBarrier({ bars, index: 0, side: "buy", entry, riskPrice: risk, rr: 2, horizonBars: 1 });
    assert.equal(outcome?.label, -1);
  });

  it("never labels a horizon that has not finished", () => {
    const bars = series([
      [100, 100.1, 99.9, 100],
      [100, 100.1, 99.9, 100],
    ]);
    assert.equal(tripleBarrier({ bars, index: 0, side: "buy", entry, riskPrice: risk, rr: 2, horizonBars: 5 }), null);
    assert.equal(labelHorizonFits(bars, 0, 1), true);
    assert.equal(labelHorizonFits(bars, 0, 5), false);
  });

  it("charges the round-trip cost inside the realised R", () => {
    const bars = series([
      [100, 100.1, 99.9, 100],
      [100, 102.5, 99.9, 102],
    ]);
    const gross = tripleBarrier({ bars, index: 0, side: "buy", entry, riskPrice: 1, rr: 2, horizonBars: 1 });
    const net = tripleBarrier({ bars, index: 0, side: "buy", entry, riskPrice: 1, rr: 2, horizonBars: 1, costPrice: 0.1 });
    assert.ok(Math.abs((gross?.rMultiple ?? 0) - (net?.rMultiple ?? 0) - 0.1) < 1e-9);
  });

  it("times out to a 0 label at the horizon's last bar", () => {
    const bars = series([
      [100, 100.2, 99.9, 100],
      [100, 100.4, 99.9, 100.3],
      [100, 100.4, 99.9, 100.1],
    ]);
    const outcome = tripleBarrier({ bars, index: 0, side: "buy", entry, riskPrice: 1, rr: 2, horizonBars: 2 });
    assert.equal(outcome?.label, 0);
    assert.equal(outcome?.timedOut, true);
    assert.equal(outcome?.t1, 2);
  });
});

describe("meta/uniqueness", () => {
  it("counts concurrency per bar and down-weights overlapping events", () => {
    const spans = [spanOf([] as never as Bar, 0, 4), spanOf([] as never as Bar, 2, 4)];
    const counts = concurrency(spans);
    // spanOf(index, horizon) owns [index, index + horizon]: the second event's
    // span reaches bar 6, so the concurrency array runs to 6 inclusive.
    assert.equal(counts.perBar.length, 7);
    assert.equal(counts.perBar[0], 1);
    assert.equal(counts.perBar[2], 2);
    const first = uniquenessOf(spans[0] as { t0: number; t1: number }, counts);
    const second = uniquenessOf(spans[1] as { t0: number; t1: number }, counts);
    assert.ok(first < 1 && first > 0.5, `expected overlap discount, got ${first}`);
    assert.ok(Math.abs(first - second) < 1e-9);
  });

  it("counts overlapping events as less than one independent observation each", () => {
    const identical = Array.from({ length: 10 }, () => ({ t0: 0, t1: 5 }));
    const weighted = eventWeights(identical);
    assert.equal(weighted.items.length, 10);
    // Ten events sharing their whole life are worth ONE observation, and the
    // number that says so is the SUM of the uniquenesses. Kish cannot say it: it
    // is invariant to a common scale, so it reads ten for the same input — which
    // is exactly why it is reported separately, as a concentration measure.
    assert.ok(Math.abs(weighted.independentObservations - 1) < 1e-9, `got ${weighted.independentObservations}`);
    assert.ok(Math.abs(weighted.kishEffectiveSampleSize - 10) < 1e-6);
  });

  it("leaves disjoint events at a weight of one", () => {
    const disjoint = [
      { t0: 0, t1: 2 },
      { t0: 5, t1: 8 },
      { t0: 20, t1: 21 },
    ];
    const weighted = eventWeights(disjoint);
    for (const item of weighted.items) assert.ok(Math.abs(item.uniqueness - 1) < 1e-9);
    assert.equal(weighted.independentObservations, 3);
  });

  it("purges on overlap BEFORE the block and embargoes after it", () => {
    const block = { start: 100, end: 200 };
    assert.equal(overlapsWithPurge({ t0: 90, t1: 99 }, block, 5, 5), true, "label ends inside the purge window");
    assert.equal(overlapsWithPurge({ t0: 80, t1: 94 }, block, 5, 5), false, "stops 5 bars before the purge");
    assert.equal(overlapsWithPurge({ t0: 200, t1: 210 }, block, 5, 5), true, "starts inside the embargo");
    assert.equal(overlapsWithPurge({ t0: 206, t1: 210 }, block, 5, 5), false, "starts after the embargo");
  });
});

describe("meta/logistic", () => {
  it("solves a small linear system", () => {
    const solution = solveLinearSystem(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    assert.ok(solution);
    assert.ok(Math.abs((solution as number[])[0] - 1) < 1e-9);
    assert.ok(Math.abs((solution as number[])[1] - 3) < 1e-9);
  });

  it("returns null rather than NaN for a singular system", () => {
    assert.equal(
      solveLinearSystem(
        [
          [1, 1],
          [2, 2],
        ],
        [1, 2],
      ),
      null,
    );
  });

  it("fits a separable problem and stays inside [0,1] when predicting", () => {
    const X: number[][] = [];
    const y: boolean[] = [];
    // Deliberately NON-separable: a perfectly separable problem has no finite MLE
    // under a fixed L2 penalty, and asserting convergence there would be
    // asserting that the solver failed.
    let seed = 3;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 400; i++) {
      const x = (rnd() - 0.5) * 4;
      X.push([x]);
      y.push(rnd() < 1 / (1 + Math.exp(-1.2 * x)));
    }
    const model = fitLogistic({ X, y, featureNames: ["x"], l2: 0.1 });
    assert.equal(model.converged, true);
    assert.ok((model.coefficients[0] as number) > 0, "the coefficient must follow the label");
    for (const value of [-5, 0, 5]) {
      const p = predictLogistic(model, [value]);
      assert.ok(p >= 0 && p <= 1, `probability out of range: ${p}`);
    }
  });

  it("respects sample weights strongly enough to move the intercept", () => {
    const X = Array.from({ length: 100 }, () => [0]);
    const y = X.map((_, i) => i < 20);
    const heavy = fitLogistic({ X, y, featureNames: ["const"], weights: y.map((hit) => (hit ? 1 : 20)), l2: 0.01 });
    const plain = fitLogistic({ X, y, featureNames: ["const"], weights: y.map(() => 1), l2: 0.01 });
    // 20 positives at weight 1 and 80 negatives at weight 20 must not predict the
    // same thing as an unweighted fit of the same labels.
    assert.ok(Math.abs(heavy.intercept - plain.intercept) > 0.5);
  });

  it("reports finite loss metrics", () => {
    const predictions = [0.2, 0.7, 0.9];
    const outcomes = [false, true, true];
    assert.ok(brierScore(predictions, outcomes) >= 0 && brierScore(predictions, outcomes) <= 1);
    assert.ok(Number.isFinite(logLoss(predictions, outcomes)));
  });
});

describe("meta/isotonic", () => {
  it("returns a non-decreasing map", () => {
    const p = [0.1, 0.2, 0.3, 0.5, 0.6, 0.8, 0.9, 0.95, 0.4, 0.45, 0.55, 0.85];
    const y = [false, false, true, false, true, true, false, true, false, true, true, true];
    const map = fitIsotonic({ p, y });
    for (let i = 1; i < map.points.length; i++) {
      assert.ok((map.points[i] as { y: number }).y >= (map.points[i - 1] as { y: number }).y - 1e-12);
    }
    for (const value of [0, 0.3, 0.75, 1]) {
      const calibrated = applyIsotonic(map, value);
      assert.ok(calibrated >= 0 && calibrated <= 1);
    }
  });

  it("pools a singleton step instead of promising 100% from one observation", () => {
    const p = [0.1, 0.2, 0.3, 0.4, 0.5, 0.99];
    const y = [false, false, false, false, false, true];
    const map = fitIsotonic({ p, y }); // one observation each: every step is a singleton
    const top = map.points[map.points.length - 1] as { y: number; w: number };
    assert.ok(top.y < 0.5, `a single observation must not become a confident map (got ${top.y})`);
    assert.ok(map.pooledThinBlocks >= 1, "the singletons must have been pooled");
    // With nothing above the floor the map collapses to the base rate, which is
    // the honest answer: the sample cannot support a curve.
    assert.equal(map.points.length, 1);
    assert.ok(Math.abs(top.y - 1 / 6) < 1e-9);
    assert.ok(MIN_ISOTONIC_BLOCK_WEIGHT > 6, "the fixture must sit below the block floor to test this");
  });

  it("pools equal inputs so the map is a function", () => {
    const p = [0.5, 0.5, 0.5, 0.9];
    const y = [true, false, true, true];
    const map = fitIsotonic({ p, y, minBlockWeight: 1 });
    const atHalf = map.points.filter((point) => Math.abs(point.x - 0.5) < 1e-12);
    assert.equal(atHalf.length, 1, "duplicate raw scores must share one calibrated value");
    assert.ok(Math.abs((atHalf[0] as { y: number }).y - 2 / 3) < 1e-9);
  });

  it("reports the sample's effective size, not the map's block count", () => {
    const p = Array.from({ length: 400 }, (_, i) => i / 400);
    const y = p.map((value) => value > 0.5);
    const map = fitIsotonic({ p, y, weights: p.map(() => 2) });
    assert.equal(map.effectiveSampleSize, 400);
    assert.equal(map.samples, 800);
  });

  it("falls back to the pooled map below the per-regime floor", () => {
    const p: number[] = [];
    const y: boolean[] = [];
    const keys: string[] = [];
    for (let i = 0; i < 300; i++) {
      p.push((i % 10) / 10);
      y.push(i % 3 === 0);
      keys.push(i < 150 ? "trending" : "range");
    }
    const fitted = fitCohortCalibrators({ p, y, keys, minSamples: 200 });
    assert.equal(Object.keys(fitted.byKey).length, 0, "no cohort reaches the floor, so none may be fitted");
    assert.deepEqual(fitted.skipped.sort(), ["range", "trending"]);
    assert.ok(fitted.pooled.points.length > 0);
  });

  it("measures an overconfident model with a slope below one", () => {
    // True rate is a gentle function of the score; the predictions claim a steep one.
    const predictions: number[] = [];
    const y: boolean[] = [];
    let seed = 11;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      const honest = 0.3 + 0.4 * rnd();
      const claimed = Math.min(0.99, Math.max(0.01, 0.5 + (honest - 0.5) * 2.5));
      predictions.push(claimed);
      y.push(rnd() < honest);
    }
    const fit = reliability(predictions, y);
    assert.equal(fit.identifiable, true);
    assert.ok((fit.slope ?? 1) < 0.8, `expected an overconfident slope, got ${fit.slope}`);
  });

  it("refuses to report a slope when the predictions do not move", () => {
    const fit = reliability([0.5, 0.5, 0.5, 0.5], [true, false, true, false]);
    assert.equal(fit.identifiable, false);
    assert.equal(fit.slope, null);
  });
});

describe("meta/pcb", () => {
  it("bounds the probability from below, and never above the point estimate", () => {
    const bound = probabilityLowerBound(0.42, 500);
    assert.ok(bound < 0.42 && bound > 0.35, `bound ${bound}`);
  });

  it("returns zero when there is no evidence", () => {
    assert.equal(probabilityLowerBound(0.9, 0), 0);
    assert.equal(probabilityLowerBound(0.9, 0.4), 0);
  });

  it("computes the Kish effective size of a weighted sample", () => {
    assert.equal(effectiveSampleSize([1, 1, 1, 1]), 4);
    assert.ok(effectiveSampleSize([10, 0, 0, 0]) < 1.01);
  });

  it("computes EV_LCB with the desk's own R arithmetic", () => {
    const ev = expectedValueLowerBound({ pLcb: 0.4, targetMultipleR: 2, costR: 0.05 });
    assert.ok(Math.abs(ev - (0.4 * 3 - 1 - 0.05)) < 1e-12);
    assert.ok(expectedValueLowerBound({ pLcb: 0.3, targetMultipleR: 2, costR: 0.05 }) < 0);
  });
});

describe("meta/folds", () => {
  it("purges and embargoes training events around each test block", () => {
    const events = Array.from({ length: 40 }, (_, i) => ({ index: i * 10, span: { t0: i * 10, t1: i * 10 + 6 } }));
    const folds = purgedEventFolds(events, 400, { folds: 4, purgeBars: 6, embargoBars: 2 });
    assert.equal(folds.length, 4);
    for (const fold of folds) {
      for (const index of fold.test) {
        const event = events[index] as { index: number };
        assert.ok(event.index >= fold.testBlock.start && event.index < fold.testBlock.end);
      }
      for (const index of fold.purged) {
        const event = events[index] as { index: number; span: { t0: number; t1: number } };
        assert.equal(
          overlapsWithPurge(event.span, fold.testBlock, 6, 2),
          true,
          "a purged event must actually overlap the block, its purge or its embargo",
        );
      }
      // Nothing may appear on both sides of the wall.
      const testSet = new Set(fold.test);
      for (const index of fold.train) assert.equal(testSet.has(index), false);
    }
  });

  it("builds every combination of test groups for CPCV", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ index: i * 5, span: { t0: i * 5, t1: i * 5 + 3 } }));
    const splits = combinatorialEventSplits(events, 300, { groups: 6, testGroups: 2, purgeBars: 3, embargoBars: 1 });
    assert.equal(splits.length, 15);
    for (const split of splits) {
      assert.equal(split.testGroups.length, 2);
      const testSet = new Set(split.test);
      for (const index of split.train) assert.equal(testSet.has(index), false);
    }
  });
});

describe("meta/dataset", () => {
  const spec = { point: 0.0001, spreadPoints: 10, commissionPerLot: 0, assetClass: "forex" as const };
  const bars = series(
    Array.from({ length: 60 }, (_, i) => [100 + i * 0.01, 100.2 + i * 0.01, 99.9 + i * 0.01, 100.1 + i * 0.01]),
  );
  const atr = bars.map(() => 0.05);
  const rangeMean = bars.map(() => 0.3);

  const view = (index: number, horizonBars: number) => ({
    index,
    direction: 1 as const,
    probability: 0.6,
    agents: ["sweep"],
    agentProbabilities: { sweep: 0.6, seasonality: 0.55 },
    emitted: true,
    mode: "intraday" as const,
    regimeKind: "trend_up" as const,
    regimeStreakBars: 12,
    changeProbability: null,
    targetMultipleR: 2,
    horizonBars,
  });

  it("drops views whose horizon has not finished instead of labelling them", () => {
    const dataset = buildMetaDataset({
      views: [view(5, 10), view(55, 10)],
      bars,
      mode: "intraday",
      atr,
      rangeMean,
      spec,
      pointValuePerLot: 1,
    });
    assert.equal(dataset.offered, 2);
    assert.equal(dataset.labelled, 1, "the second view's horizon runs past the data");
    assert.equal(dataset.unfinished, 1);
  });

  it("drops views with no usable ATR and says how many", () => {
    const holed = atr.map((value, i) => (i === 5 ? null : value));
    const dataset = buildMetaDataset({
      views: [view(5, 10), view(6, 10)],
      bars,
      mode: "intraday",
      atr: holed,
      rangeMean,
      spec,
      pointValuePerLot: 1,
    });
    assert.equal(dataset.missingAtr, 1);
    assert.equal(dataset.labelled, 1);
  });

  it("keeps the emitted flag and the feature count in step with the names", () => {
    const dataset = buildMetaDataset({
      views: [view(5, 10), view(8, 10)],
      bars,
      mode: "intraday",
      atr,
      rangeMean,
      spec,
      pointValuePerLot: 1,
    });
    assert.equal(dataset.emittedCount, 2);
    for (const row of dataset.x) assert.equal(row.length, dataset.featureNames.length);
    assert.equal(new Set(dataset.featureNames).size, dataset.featureNames.length, "feature names must be unique");
  });

  it("carries the round-trip cost as a fraction of R", () => {
    const dataset = buildMetaDataset({
      views: [view(5, 10)],
      bars,
      mode: "intraday",
      atr,
      rangeMean,
      spec,
      pointValuePerLot: 1,
    });
    const costR = dataset.costR[0] as number;
    assert.ok(costR > 0 && costR < 0.5, `costR ${costR}`);
  });
});
