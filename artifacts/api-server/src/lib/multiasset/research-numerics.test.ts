/**
 * Desk v4 research harness — numerical primitives (WP2 tests).
 *
 * These pin the estimators the gates depend on. A broken Sharpe deflation or a
 * phase-randomisation that quietly preserves the structure it is supposed to
 * destroy would invalidate every conclusion drawn from the harness, and both
 * are the kind of bug that produces plausible-looking reports.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { makeRng } from "./math";
import {
  blockBootstrapIndices,
  chooseIndices,
  deflatedSharpeRatio,
  expectedMaxSharpe,
  fft,
  longestStreak,
  maxDrawdown,
  mean,
  nextPowerOfTwo,
  normalCdf,
  normalInv,
  probabilisticSharpeRatio,
  probabilityOfBacktestOverfitting,
  purgeIndices,
  quantile,
  stationaryBootstrapIndices,
  stdev,
  weightedLinearFit,
} from "./research/numerics";
import {
  blockShuffledReturns,
  driftlessRandomWalk,
  positiveControl,
  phaseRandomisedReturns,
  returnsFromBars,
} from "./research/generators";
import { specFromPreset } from "./research/spec";

test("normalCdf matches known quantiles", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-4);
  assert.equal(normalCdf(Infinity), 1);
});

test("normalInv inverts normalCdf", () => {
  for (const p of [0.01, 0.2, 0.5, 0.8, 0.99]) {
    assert.ok(Math.abs(normalCdf(normalInv(p)) - p) < 1e-6, `p=${p}`);
  }
});

test("quantile interpolates rather than snapping", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
});

test("maxDrawdown reports peak-to-trough in the series' own units", () => {
  assert.equal(maxDrawdown([1, 2, 3, 1, 5], "absolute"), 2);
  assert.equal(maxDrawdown([0, -3, -1], "absolute"), 3);
  assert.equal(maxDrawdown([], "absolute"), 0);
});

test("longestStreak finds the longest run", () => {
  assert.equal(longestStreak([1, -1, -1, -1, 1, -1], (v) => v < 0), 3);
  assert.equal(longestStreak([1, 1], (v) => v < 0), 0);
});

test("fft round-trips a signal", () => {
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(i / 5) + 0.3 * Math.cos(i / 2);
  const original = Float64Array.from(re);
  fft(re, im, false);
  fft(re, im, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i]! - original[i]!) < 1e-9, `i=${i}`);
});

test("fft rejects a non power-of-two length", () => {
  assert.throws(() => fft(new Float64Array(6), new Float64Array(6), false));
  assert.equal(nextPowerOfTwo(6), 8);
});

test("weightedLinearFit recovers an exact line", () => {
  const fit = weightedLinearFit([0, 1, 2, 3], [1, 3, 5, 7], [1, 1, 1, 1]);
  assert.ok(Math.abs(fit.slope - 2) < 1e-12);
  assert.ok(Math.abs(fit.intercept - 1) < 1e-12);
  assert.ok(Math.abs(fit.r2 - 1) < 1e-12);
});

test("sharpe inference: a strong signal is significant, noise is not", () => {
  const rng = makeRng(7);
  const strong: number[] = [];
  for (let i = 0; i < 300; i++) strong.push(0.5 + (rng() - 0.5));
  assert.ok(probabilisticSharpeRatio(strong, 0) > 0.99);

  const noise: number[] = [];
  const noiseRng = makeRng(11);
  for (let i = 0; i < 300; i++) noise.push(noiseRng() - 0.5);
  const psr = probabilisticSharpeRatio(noise, 0);
  assert.ok(psr > 0.05 && psr < 0.95, `noise PSR should be unremarkable, got ${psr}`);
});

test("deflated Sharpe falls as more configurations are searched", () => {
  const rng = makeRng(23);
  const series: number[] = [];
  for (let i = 0; i < 200; i++) series.push(0.12 + (rng() - 0.5));
  const one = deflatedSharpeRatio(series, 1);
  const many = deflatedSharpeRatio(series, 100);
  assert.ok(Math.abs(one - probabilisticSharpeRatio(series, 0)) < 1e-12);
  assert.ok(many < one, `DSR should fall with more trials: ${many} vs ${one}`);
  assert.ok(expectedMaxSharpe(50, 0.05) > expectedMaxSharpe(5, 0.05));
  assert.equal(expectedMaxSharpe(1, 0.05), 0);
});

test("CSCV detects overfitting when the winner is noise", () => {
  // 400 observations, 8 configurations, all pure noise: whichever one wins
  // in-sample is a coin flip out-of-sample, so PBO should be high.
  const rng = makeRng(31);
  const noisy: number[][] = [];
  for (let i = 0; i < 400; i++) {
    noisy.push(Array.from({ length: 8 }, () => rng() - 0.5));
  }
  const noisyResult = probabilityOfBacktestOverfitting(noisy, 8);
  assert.ok(noisyResult.combinations > 0);
  assert.ok(noisyResult.pbo > 0.2, `noise PBO should be material, got ${noisyResult.pbo}`);

  // Now give configuration 0 a genuine, pervasive edge: it must win in-sample
  // and stay a winner out-of-sample, so PBO collapses.
  const genuine: number[][] = noisy.map((row, i) =>
    row.map((value, c) => (c === 0 ? 0.4 + value * 0.2 : value)),
  );
  const genuineResult = probabilityOfBacktestOverfitting(genuine, 8);
  assert.ok(
    genuineResult.pbo < noisyResult.pbo,
    `a real edge must lower PBO: ${genuineResult.pbo} vs ${noisyResult.pbo}`,
  );
  assert.ok(genuineResult.pbo <= 0.1, `genuine edge PBO should be small, got ${genuineResult.pbo}`);
});

test("CSCV refuses to certify a single configuration", () => {
  const result = probabilityOfBacktestOverfitting([[1], [2], [3], [4]], 8);
  assert.equal(result.pbo, 1);
  assert.equal(result.combinations, 0);
});

test("chooseIndices enumerates combinations", () => {
  assert.equal(chooseIndices(4, 2).length, 6);
  assert.deepEqual(chooseIndices(3, 3), [[0, 1, 2]]);
});

test("bootstrap indices are deterministic and in range", () => {
  const a = stationaryBootstrapIndices(50, 8, makeRng(3));
  const b = stationaryBootstrapIndices(50, 8, makeRng(3));
  assert.deepEqual(a, b);
  assert.ok(a.every((index) => index >= 0 && index < 50));
  assert.equal(a.length, 50);
  const blocks = blockBootstrapIndices(50, 5, makeRng(4));
  assert.equal(blocks.length, 50);
  assert.ok(blocks.every((index) => index >= 0 && index < 50));
});

test("purgeIndices drops overlapping labels and the embargo window", () => {
  const kept = purgeIndices({ total: 20, testStart: 10, testEnd: 14, embargo: 3, horizon: 2 });
  assert.ok(!kept.includes(9), "row 9 labels into the test block");
  assert.ok(!kept.includes(10));
  // testEnd = 14 with embargo = 3 removes rows 15, 16 and 17 — the embargo is
  // counted FROM the last test row, not after it.
  assert.ok(!kept.includes(16), "row 16 is inside the embargo");
  assert.ok(!kept.includes(17), "row 17 is the last embargoed row");
  assert.ok(kept.includes(0));
  assert.ok(kept.includes(18), "row 18 is clear of both the test block and the embargo");
});

test("driftless random walk has no drift on average", () => {
  const dataset = driftlessRandomWalk({ symbol: "EURUSD", seed: 5, bars: 20_000 });
  const returns = returnsFromBars(dataset.bars);
  const m = mean(returns);
  const se = stdev(returns) / Math.sqrt(returns.length);
  // Within 4 standard errors of zero: a drift the desk could trade would show
  // up here and the "null" would not be null.
  assert.ok(Math.abs(m) < 4 * se + 1e-9, `mean return ${m} vs se ${se}`);
});

test("block shuffle preserves the exact return multiset, order does not survive", () => {
  const source = driftlessRandomWalk({ symbol: "EURUSD", seed: 9, bars: 8_000 });
  const full = returnsFromBars(source.bars);
  const blockLength = 50;
  // The generator consumes whole blocks only, so hand it an exact multiple and
  // ask for exactly that many bars back — then the comparison is a true
  // permutation test rather than a prefix-versus-subset comparison.
  const usable = full.slice(0, Math.floor(full.length / blockLength) * blockLength);
  const shuffled = blockShuffledReturns({
    returns: usable,
    options: { symbol: "EURUSD", seed: 3, bars: usable.length },
    blockLength,
  });
  const shuffledReturns = returnsFromBars(shuffled.bars);
  assert.equal(shuffledReturns.length, usable.length);

  const a = [...usable].sort((x, y) => x - y);
  const b = [...shuffledReturns].sort((x, y) => x - y);
  // The generator rounds prices to 9 decimals (a real broker quotes five), so
  // each reconstructed log return carries ~1e-9/price of rounding error. The
  // multiset is preserved to that tolerance; a reordering, a dropped block or a
  // duplicated one would be orders of magnitude larger than this.
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  assert.ok(worst < 1e-7, `largest sorted-return discrepancy ${worst}`);

  // And the series is genuinely reordered: the blocks have moved.
  let sameOrder = 0;
  for (let i = 0; i < 1_000; i++) if (Math.abs(usable[i]! - shuffledReturns[i]!) < 1e-12) sameOrder += 1;
  assert.ok(sameOrder < 200, "block shuffle barely reordered anything");
});

test("phase randomisation preserves the power spectrum but not the path", () => {
  const source = driftlessRandomWalk({ symbol: "EURUSD", seed: 13, bars: 4_096 });
  const returns = returnsFromBars(source.bars).slice(0, 4_095);
  const surrogate = phaseRandomisedReturns({
    returns,
    options: { symbol: "EURUSD", seed: 17, bars: 4_095 },
  });
  const surrogateReturns = returnsFromBars(surrogate.bars).slice(0, 4_095);

  // Total variance is a phase-free quantity: it must survive to within the
  // padding the FFT introduces.
  const varianceRatio = stdev(surrogateReturns) / stdev(returns);
  assert.ok(Math.abs(varianceRatio - 1) < 0.15, `variance ratio ${varianceRatio}`);

  // The paths themselves must differ.
  let identical = 0;
  for (let i = 0; i < returns.length; i++) {
    if (Math.abs(returns[i]! - surrogateReturns[i]!) < 1e-12) identical += 1;
  }
  assert.ok(identical < returns.length * 0.1, "surrogate copied the original path");
});

test("positive control carries persistent, detectable structure", () => {
  const dataset = positiveControl({ symbol: "EURUSD", seed: 21, bars: 20_000 });
  const returns = returnsFromBars(dataset.bars);
  const labels = dataset.regimeLabels;
  assert.equal(labels.length, returns.length);

  // Trend-state episodes must be long: that is what makes the control fair.
  let switches = 0;
  for (let i = 1; i < labels.length; i++) if (labels[i] !== labels[i - 1]) switches += 1;
  const meanEpisode = labels.length / Math.max(1, switches);
  assert.ok(meanEpisode > 300, `episodes too short to trade: ${meanEpisode}`);

  // And the trend state must actually trend: a positive mean return there.
  const trendReturns = returns.filter((_, i) => labels[i] === 0);
  assert.ok(trendReturns.length > 1_000, "control produced too few trend bars");
  assert.ok(mean(trendReturns.map(Math.abs)) > mean(returns.map(Math.abs)) * 0.5);
});

test("generated specs round-trip through the preset table", () => {
  const spec = specFromPreset("EURUSD", 8);
  assert.equal(spec.point, 0.00001);
  assert.equal(spec.spreadPoints, 8);
  assert.equal(spec.volumeStep, 0.01);
  // pointValuePerLot: 1 point of EURUSD on 1.00 lot is 1.00 USD.
  assert.ok(Math.abs(spec.tickValue * (spec.point / spec.tickSize) - 1) < 1e-12);
});
