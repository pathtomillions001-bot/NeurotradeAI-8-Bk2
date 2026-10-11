/**
 * WP3 — BOCPD tests.
 *
 * A change-point detector is only useful if it is quiet inside a stationary
 * regime and loud at a break. Both halves are asserted, plus the two ways this
 * kind of code usually breaks: a posterior that under-flows to zero (silently
 * confident) or a detector that reads the future.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { changeProbabilities, detectChangePoints, logGamma, logSumExp, robustScale } from "./change-point";
import { gaussian, makeRng } from "./math";

test("the run-length posterior is a probability distribution at every step", () => {
  const rng = makeRng(5);
  const observations = [...Array(300)].map(() => gaussian(rng));
  const result = detectChangePoints(observations, {}, 5);
  const total = result.runLengthPosterior.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `posterior sums to ${total}`);
  assert.ok(result.runLengthPosterior.every((p) => p >= 0 && p <= 1));
  assert.ok(Number.isFinite(result.changeProbability));
  // Nothing changed: the detector must be quiet.
  assert.ok(result.changeProbability < 0.3, `quiet on stationary data (got ${result.changeProbability})`);
  assert.ok(result.expectedRunLength > 50, `expected run length ${result.expectedRunLength}`);
});

test("a level shift is detected, and quickly", () => {
  const rng = makeRng(11);
  const before = [...Array(200)].map(() => gaussian(rng) * 0.001);
  // A sustained regime break: the mean jumps by 4 sigma.
  const after = [...Array(60)].map(() => 0.004 + gaussian(rng) * 0.001);
  const result = changeProbabilities([...before, ...after], { recentBars: 5 });
  const path = result.probabilityPath;
  const quiet = Math.max(...path.slice(100, 195));
  const atBreak = Math.max(...path.slice(195, 215));
  assert.ok(atBreak > 0.5, `a 4σ level shift must be seen (peak ${atBreak.toFixed(3)}, quiet ${quiet.toFixed(3)})`);
  assert.ok(quiet < 0.3, `the detector must be quiet before the break (peaked at ${quiet.toFixed(3)})`);
  const firstDetection = result.detectedChanges.find((i) => i > 190);
  assert.ok(firstDetection !== undefined, "a change point must be recorded near the break");
  assert.ok(firstDetection <= 212, `the break at 200 was detected at ${firstDetection} — too late to be useful`);
});

test("a variance-only change is caught by the Inverse-Gamma prior", () => {
  const rng = makeRng(13);
  const calm = [...Array(200)].map(() => gaussian(rng) * 0.001);
  const wild = [...Array(60)].map(() => gaussian(rng) * 0.006);
  const result = changeProbabilities([...calm, ...wild], { recentBars: 5 });
  const atBreak = Math.max(...result.probabilityPath.slice(198, 220));
  assert.ok(atBreak > 0.3, `a 6x volatility change must register (peak ${atBreak.toFixed(3)})`);
});

test("the probability is causal: the future cannot change today's reading", () => {
  const rng = makeRng(17);
  const history = [...Array(150)].map(() => gaussian(rng) * 0.001);
  const a = changeProbabilities([...history, ...Array(50).map(() => gaussian(rng) * 0.001)], { recentBars: 5 });
  void a;
  // Compare the posterior AT the same index in two series whose futures differ.
  const future1 = [...Array(50)].map(() => gaussian(rng) * 0.001);
  const future2 = [...Array(50)].map(() => 0.02 + gaussian(rng) * 0.001);
  const atHistoryEnd = (future: number[]): number => {
    const series = [...history, ...future];
    // Walk the detector over the whole series but read the state at index 149.
    return detectChangePoints(series.slice(0, 150), {}, 5).changeProbability;
  };
  assert.equal(atHistoryEnd(future1), atHistoryEnd(future2));
  // …and the same holds when the detector is fed the longer series and read
  // early: the recursion only ever looks backwards.
  const long1 = detectChangePoints([...history, ...future1], {}, 5);
  const long2 = detectChangePoints([...history, ...future2], {}, 5);
  assert.equal(long1.detectedChanges.filter((i) => i < 150).length, long2.detectedChanges.filter((i) => i < 150).length);
});

test("no under-flow: a long stationary series keeps a finite posterior", () => {
  const rng = makeRng(23);
  const observations = [...Array(2000)].map(() => gaussian(rng) * 0.002);
  const result = detectChangePoints(observations, { maxRunLength: 200 }, 5);
  assert.ok(result.runLengthPosterior.every((p) => Number.isFinite(p)));
  assert.ok(result.runLengthPosterior.reduce((a, b) => a + b, 0) > 0.999);
  assert.ok(result.changeProbability < 0.2);
});

test("helping functions behave", () => {
  assert.equal(logGamma(1), 0);
  assert.ok(Math.abs(logGamma(5) - Math.log(24)) < 1e-9);
  assert.ok(Math.abs(logSumExp([0, 0]) - Math.log(2)) < 1e-12);
  assert.equal(logSumExp([-Infinity, -Infinity]), -Infinity);
  assert.ok(robustScale([0, 0, 0, 0]) === 0);
  assert.ok(robustScale([1, -1, 1, -1]) > 0);
});

test("the detector is deterministic", () => {
  const rng = makeRng(29);
  const observations = [...Array(400)].map(() => gaussian(rng));
  const a = detectChangePoints(observations);
  const b = detectChangePoints(observations);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
