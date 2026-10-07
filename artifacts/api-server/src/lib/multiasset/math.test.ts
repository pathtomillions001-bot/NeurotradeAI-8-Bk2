/**
 * Primitive statistics tests — checked against hand-computed values, not
 * against other code in this package. Everything downstream (regime, Markov,
 * Monte Carlo, sizing) inherits these, so an error here is invisible and
 * systemic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  atr,
  bandWidth,
  clamp,
  ewmaVolatility,
  gaussian,
  hashSeed,
  lastSwing,
  linreg,
  logReturns,
  makeRng,
  mean,
  percentileRank,
  rsi,
  sma,
  stdev,
  swings,
  zscore,
} from "./math";
import type { Bar } from "./types";

function bar(ts: number, o: number, h: number, l: number, c: number): Bar {
  return [ts, o, h, l, c, 100];
}

test("mean and sample standard deviation match hand calculation", () => {
  assert.equal(mean([2, 4, 6]), 4);
  // Sample sd of [2,4,6]: sqrt(((−2)²+0²+2²)/2) = sqrt(4) = 2
  assert.equal(stdev([2, 4, 6]), 2);
  assert.equal(stdev([5]), 0, "a single point has no dispersion");
  assert.equal(stdev([]), 0);
});

test("sma averages the trailing window only", () => {
  assert.equal(sma([1, 2, 3, 10, 20], 2), 15);
  // Shorter than the period falls back to the full mean rather than NaN.
  assert.equal(sma([4, 6], 10), 5);
});

test("linear regression recovers a known line exactly", () => {
  // y = 3x + 1
  const reg = linreg([1, 4, 7, 10, 13]);
  assert.ok(Math.abs(reg.slope - 3) < 1e-9);
  assert.ok(Math.abs(reg.intercept - 1) < 1e-9);
  assert.ok(Math.abs(reg.r2 - 1) < 1e-9, "a perfect line has R² = 1");
});

test("linear regression reports no trend for a flat series", () => {
  const reg = linreg([5, 5, 5, 5, 5]);
  assert.equal(reg.slope, 0);
  assert.equal(reg.r2, 0);
});

test("R² falls as a trend becomes ragged", () => {
  const clean = linreg([1, 2, 3, 4, 5, 6, 7, 8]);
  const noisy = linreg([1, 5, 2, 7, 3, 8, 4, 9]);
  assert.ok(clean.r2 > noisy.r2);
});

test("ATR equals the mean true range on a constant-range series", () => {
  // Every bar: high−low = 2, and no gaps, so TR = 2 throughout.
  const bars: Bar[] = [];
  for (let i = 0; i < 20; i++) bars.push(bar(i, 10, 11, 9, 10));
  assert.ok(Math.abs(atr(bars, 14) - 2) < 1e-9);
});

test("ATR counts gaps through the previous close", () => {
  const bars: Bar[] = [bar(0, 10, 10.5, 9.5, 10), bar(1, 20, 20.5, 19.5, 20)];
  // TR = max(1, |20.5−10|, |19.5−10|) = 10.5
  assert.ok(Math.abs(atr(bars, 14) - 10.5) < 1e-9);
});

test("ATR is zero-safe on insufficient data", () => {
  assert.equal(atr([], 14), 0);
  assert.equal(atr([bar(0, 1, 1, 1, 1)], 14), 0);
});

test("RSI saturates at 100 for an unbroken advance and 50 when flat", () => {
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(rising, 14), 100);
  const flat = new Array(30).fill(50);
  assert.equal(rsi(flat, 14), 50);
  assert.equal(rsi([1, 2], 14), 50, "not enough data returns neutral");
});

test("RSI of a decline is the mirror of the advance", () => {
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
  const falling = [...rising].reverse();
  assert.ok(Math.abs(rsi(rising, 14) + rsi(falling, 14) - 100) < 1e-6);
});

test("log returns invert to the original ratios", () => {
  const r = logReturns([100, 110]);
  assert.ok(Math.abs(Math.exp(r[0]) - 1.1) < 1e-12);
  assert.equal(logReturns([100]).length, 0);
});

test("EWMA volatility reacts to a volatility burst faster than plain stdev", () => {
  const calm = new Array(60).fill(0.0001);
  const burst = [...calm, 0.02, -0.022, 0.019];
  const ewmaCalm = ewmaVolatility(calm);
  const ewmaBurst = ewmaVolatility(burst);
  assert.ok(ewmaBurst > ewmaCalm * 5, "recent shock must dominate");
});

test("z-score is zero at the mean and 1 at one sd above", () => {
  const values = [2, 4, 6];
  assert.equal(zscore(values, 4), 0);
  assert.equal(zscore(values, 6), 1);
  assert.equal(zscore([5, 5, 5], 5), 0, "no dispersion cannot divide by zero");
});

test("swing detection finds the obvious pivot and nothing else", () => {
  const bars: Bar[] = [
    bar(0, 10, 10.2, 9.8, 10),
    bar(1, 10, 10.4, 9.9, 10.2),
    bar(2, 10, 12.0, 10.0, 11.5), // clear high
    bar(3, 11, 11.0, 10.1, 10.4),
    bar(4, 10, 10.5, 9.7, 10.0),
  ];
  const found = swings(bars, 2);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "high");
  assert.equal(found[0].price, 12.0);
  assert.equal(lastSwing(bars, "high", 2)?.price, 12.0);
  assert.equal(lastSwing(bars, "low", 2), null);
});

test("band width widens with dispersion", () => {
  const tight = new Array(30).fill(100).map((v, i) => v + (i % 2));
  const wide = new Array(30).fill(100).map((v, i) => v + (i % 2) * 20);
  assert.ok(bandWidth(wide) > bandWidth(tight));
});

test("percentile rank orders correctly at the extremes", () => {
  const values = [1, 2, 3, 4];
  assert.equal(percentileRank(values, 0), 0);
  assert.equal(percentileRank(values, 5), 1);
  assert.equal(percentileRank(values, 3), 0.5);
});

test("clamp bounds on both sides", () => {
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(clamp(5, 0, 10), 5);
});

// ── Determinism: the property the whole Monte Carlo layer relies on ──────────

test("the RNG is reproducible for a given seed and differs across seeds", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  const c = makeRng(43);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  const seqC = Array.from({ length: 5 }, () => c());
  assert.deepEqual(seqA, seqB, "same seed must replay exactly");
  assert.notDeepEqual(seqA, seqC);
});

test("RNG output stays in [0,1)", () => {
  const rng = makeRng(7);
  for (let i = 0; i < 5000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test("gaussian draws are approximately standard normal", () => {
  const rng = makeRng(123);
  const draws = Array.from({ length: 20000 }, () => gaussian(rng));
  assert.ok(Math.abs(mean(draws)) < 0.05, `mean ${mean(draws)}`);
  assert.ok(Math.abs(stdev(draws) - 1) < 0.05, `sd ${stdev(draws)}`);
});

test("hashSeed is stable and collision-free across the demo symbols", () => {
  assert.equal(hashSeed("EURUSD|M5"), hashSeed("EURUSD|M5"));
  const seeds = new Set(
    ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "US30", "NAS100", "BTCUSD"].map((s) =>
      hashSeed(`${s}|M5`),
    ),
  );
  assert.equal(seeds.size, 7);
});
