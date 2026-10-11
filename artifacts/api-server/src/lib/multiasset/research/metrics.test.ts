/**
 * WP2 — metrics tests.
 *
 * These tests exist because every one of these statistics is used to decide
 * whether real money is risked, and each of them has a specific, well-known way
 * of lying: the Sharpe ratio prices neither its own sampling error nor
 * non-normality (PSR/DSR do), a reliability slope is undefined when the
 * forecasts do not vary, and a "best of N" backtest is not evidence until it
 * has been deflated for N. Each test pins the correction, not the formula's
 * decoration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calibrationReport,
  deflatedSharpeRatio,
  inverseNormalCdf,
  lowerBoundMeanR,
  moments,
  normalCdf,
  probabilisticSharpeRatio,
  probabilityOfBacktestOverfitting,
  sharpeRatio,
  tradeStats,
  type TradeRecord,
} from "./metrics";
import { makeRng } from "../math";

function record(r: number, extra: Partial<TradeRecord> = {}): TradeRecord {
  return { r, maeR: Math.abs(Math.min(0, r)), mfeR: Math.max(0, r), bars: 10, ...extra };
}

// ── Trade statistics ────────────────────────────────────────────────────────

test("tradeStats reports the distribution, not just the average", () => {
  const records = [record(2), record(-1), record(2), record(-1), record(-1), record(2), record(-1)];
  const stats = tradeStats(records);
  assert.equal(stats.trades, 7);
  assert.equal(stats.hitRate, 3 / 7);
  // 3 wins of +2R, 4 losses of −1R → +2R over 7 trades.
  assert.equal(Number(stats.meanR.toFixed(4)), Number((2 / 7).toFixed(4)));
  // Best streak of losses in this sequence is 2 (indices 3-4 and 6).
  assert.equal(stats.longestLosingStreak, 2);
  assert.equal(Number(stats.profitFactor.toFixed(3)), 1.5);
  assert.equal(stats.bestR, 2);
  assert.equal(stats.worstR, -1);
  // The equity curve peaks at +3R and gives back to +1R: the drawdown is 2R.
  assert.equal(stats.maxDrawdownR, 2);
});

test("tradeStats on an empty set is all zeros, not NaN", () => {
  const stats = tradeStats([]);
  assert.equal(stats.trades, 0);
  assert.equal(stats.hitRate, 0);
  assert.ok(Number.isFinite(stats.meanR));
  assert.ok(Number.isFinite(stats.rStdDev));
});

test("a high hit rate at a bad reward:risk still loses — that is why hit rate travels with E[R]", () => {
  // 70% winners at +0.4R, 30% losers at −1R: a losing configuration.
  const records = [...Array(70)].map(() => record(0.4)).concat([...Array(30)].map(() => record(-1)));
  const stats = tradeStats(records);
  assert.equal(Number(stats.hitRate.toFixed(2)), 0.7);
  assert.ok(stats.meanR < 0, `70% wins at 1:0.4 must lose money (got ${stats.meanR})`);
});

test("the lower-80% bound is below the mean and tightens as the sample grows", () => {
  // Same two-point distribution at the same hit rate, so the two samples share
  // a mean: the ONLY difference is how much evidence stands behind it.
  const short = [...Array(25)].map((_, i) => record(i % 25 < 11 ? 2 : -1));
  const long = [...Array(200)].map((_, i) => record(i % 25 < 11 ? 2 : -1));
  const a = lowerBoundMeanR(tradeStats(short));
  const b = lowerBoundMeanR(tradeStats(long));
  assert.equal(Number(tradeStats(short).meanR.toFixed(9)), Number(tradeStats(long).meanR.toFixed(9)));
  assert.ok(a < tradeStats(short).meanR, "the bound must sit below the point estimate");
  assert.ok(b > a, `more evidence must raise the lower bound (${a.toFixed(3)} → ${b.toFixed(3)})`);
});

// ── Sharpe / PSR / DSR ──────────────────────────────────────────────────────

test("normalCdf and inverseNormalCdf agree with the textbook values", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 5e-4);
  assert.ok(Math.abs(inverseNormalCdf(0.975) - 1.959964) < 1e-3);
  assert.ok(Math.abs(inverseNormalCdf(0.5)) < 1e-6);
  for (const p of [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
    assert.ok(Math.abs(normalCdf(inverseNormalCdf(p)) - p) < 1e-4, `round trip at ${p}`);
  }
});

test("PSR prices the sampling error that the raw Sharpe ratio ignores", () => {
  const rng = makeRng(11);
  const strong = [...Array(200)].map(() => 0.1 + (rng() - 0.5) * 0.5);
  const noisy = [...Array(20)].map(() => 0.1 + (rng() - 0.5) * 0.5);
  assert.ok(sharpeRatio(strong) > 0 && sharpeRatio(noisy) > 0);
  const psrStrong = probabilisticSharpeRatio(strong);
  const psrNoisy = probabilisticSharpeRatio(noisy);
  assert.ok(psrStrong > psrNoisy, "the same edge on more data must be more probable");
  assert.ok(psrStrong > 0.95, `a Sharpe of ${sharpeRatio(strong).toFixed(2)} over 200 bars should be believable`);
});

test("PSR falls for a fat-tailed, negatively skewed series with the same mean", () => {
  const gaussian = [...Array(200)].map((_, i) => (i % 2 === 0 ? 0.5 : -0.3));
  const crashy = [...Array(200)].map((_, i) => (i % 40 === 0 ? -8 : 0.62));
  assert.ok(Math.abs(sharpeRatio(gaussian) - sharpeRatio(crashy)) < 0.2);
  assert.ok(probabilisticSharpeRatio(crashy) < probabilisticSharpeRatio(gaussian));
  assert.ok(moments(crashy).skew < 0 && moments(crashy).kurtosis > 3);
});

test("DSR deflates for the number of trials, and never exceeds PSR", () => {
  const rng = makeRng(3);
  const series = [...Array(150)].map(() => 0.08 + (rng() - 0.5) * 0.4);
  const psr = probabilisticSharpeRatio(series);
  const dsr1 = deflatedSharpeRatio(series, 1);
  const dsr50 = deflatedSharpeRatio(series, 50);
  const dsr5000 = deflatedSharpeRatio(series, 5000);
  assert.equal(Number(dsr1.toFixed(6)), Number(psr.toFixed(6)));
  assert.ok(dsr50 < dsr1, "searching 50 configurations must lower the probability");
  assert.ok(dsr5000 <= dsr50);
});

test("a 'best of many' result on pure noise is not significant after deflation", () => {
  // The exact trap the brief calls out: 40 configurations on a random series,
  // take the best, and ask whether it is real.
  const rng = makeRng(99);
  let best: number[] = [];
  let bestSharpe = -Infinity;
  for (let c = 0; c < 40; c++) {
    const series = [...Array(120)].map(() => (rng() - 0.5) * 0.4);
    const sr = sharpeRatio(series);
    if (sr > bestSharpe) {
      bestSharpe = sr;
      best = series;
    }
  }
  const raw = probabilisticSharpeRatio(best);
  const deflated = deflatedSharpeRatio(best, 40);
  assert.ok(raw > deflated, "the deflated number must be the harsher one");
  assert.ok(deflated < 0.95, `best-of-40 on noise must not be significant (raw ${raw.toFixed(3)}, deflated ${deflated.toFixed(3)})`);
});

// ── PBO ─────────────────────────────────────────────────────────────────────

test("PBO is low when one configuration is genuinely better in every block", () => {
  const rng = makeRng(5);
  const good = [...Array(120)].map(() => 0.2 + (rng() - 0.5) * 0.3);
  const bad = [...Array(120)].map(() => -0.2 + (rng() - 0.5) * 0.3);
  const { pbo, splits } = probabilityOfBacktestOverfitting({ returnsByConfig: [good, bad], groups: 6, testGroups: 2 });
  assert.ok(splits > 0);
  assert.ok(pbo < 0.2, `a real difference must not look like overfitting (PBO ${pbo})`);
});

test("PBO is high when the configurations are indistinguishable noise", () => {
  const rng = makeRng(17);
  const configs = [...Array(6)].map(() => [...Array(120)].map(() => (rng() - 0.5) * 0.3));
  const { pbo } = probabilityOfBacktestOverfitting({ returnsByConfig: configs, groups: 6, testGroups: 2 });
  assert.ok(pbo > 0.3, `six equivalent noise configurations must look overfitted (PBO ${pbo})`);
});

// ── Calibration ─────────────────────────────────────────────────────────────

test("calibrationReport recovers a known reliability slope", () => {
  // The outcomes are drawn from logit(q) = 0.6 x logit(p): the forecaster is
  // over-confident, and the fitted slope must come out near 0.6 — the direction
  // a real desk reads as "shrink your probabilities".
  const rng = makeRng(23);
  const samples: { p: number; outcome: 0 | 1 }[] = [];
  for (let i = 0; i < 4000; i++) {
    const p = 0.15 + rng() * 0.7;
    const logit = Math.log(p / (1 - p));
    const q = 1 / (1 + Math.exp(-0.6 * logit));
    samples.push({ p, outcome: rng() < q ? 1 : 0 });
  }
  const report = calibrationReport(samples);
  assert.equal(report.samples, 4000);
  assert.ok(report.slopeIdentifiable);
  assert.ok(
    Math.abs(report.reliabilitySlope - 0.6) < 0.15,
    `the fitted slope must recover the 0.6 that generated the data (got ${report.reliabilitySlope.toFixed(3)})`,
  );
});

test("calibrationReport rewards honest probabilities with a positive Brier skill", () => {
  const rng = makeRng(29);
  const samples: { p: number; outcome: 0 | 1 }[] = [];
  for (let i = 0; i < 2000; i++) {
    const p = 0.2 + rng() * 0.6;
    samples.push({ p, outcome: rng() < p ? 1 : 0 });
  }
  const report = calibrationReport(samples);
  assert.ok(report.brierSkill > 0.1, `honest forecasts must beat the base rate (skill ${report.brierSkill.toFixed(4)})`);
  assert.ok(Math.abs(report.reliabilitySlope - 1) < 0.2, `slope should be ~1 (got ${report.reliabilitySlope.toFixed(3)})`);
  assert.equal(report.bins.length > 0, true);
});

test("a constant prediction has no measurable slope — and must not be reported as calibrated", () => {
  const samples: { p: number; outcome: 0 | 1 }[] = [...Array(200)].map((_, i) => ({ p: 0.18, outcome: i % 3 === 0 ? 1 : 0 }));
  const report = calibrationReport(samples);
  assert.equal(report.slopeIdentifiable, false);
  assert.ok(report.logitStdDev < 1e-9, `constant logits, got ${report.logitStdDev}`);
});
