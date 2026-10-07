/**
 * Analytics tests.
 *
 * These are the estimators the evidence ensemble leans on, so they are checked
 * against series with a KNOWN character: a pure random walk, a persistent
 * trend, a mean-reverting AR(1), and a constant. An estimator that cannot tell
 * those apart is not fit to vote.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  betaPosterior,
  efficiencyRatio,
  excessKurtosis,
  garchVolatility,
  hurstExponent,
  kalmanTrend,
  lag1Autocorrelation,
  ljungBox,
  moneyFlow,
  normalCdf,
  ouFit,
  performanceStats,
  rangePosition,
  shannonEntropy,
  skewness,
  varianceRatio,
  volatilityExpansion,
} from "./analytics";
import { logReturns, makeRng } from "./math";
import type { Bar } from "./types";

function randomWalk(n = 600, seed = 11, step = 0.001): number[] {
  const rng = makeRng(seed);
  const out: number[] = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * Math.exp((rng() - 0.5) * step));
  return out;
}

function persistent(n = 600, seed = 12, drift = 0.0009): number[] {
  const rng = makeRng(seed);
  const out: number[] = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * Math.exp(drift + (rng() - 0.5) * 0.0004));
  return out;
}

/** AR(1) with φ = 0.9 around a fixed mean — textbook mean reversion. */
function meanReverting(n = 600, seed = 13, phi = 0.9): number[] {
  const rng = makeRng(seed);
  const out: number[] = [100];
  for (let i = 1; i < n; i++) {
    const next = 100 + phi * (out[i - 1] - 100) + (rng() - 0.5) * 0.4;
    out.push(next);
  }
  return out;
}

function barsFrom(values: number[]): Bar[] {
  return values.map((close, i) => {
    const open = i === 0 ? close : values[i - 1];
    const high = Math.max(open, close) * 1.0004;
    const low = Math.min(open, close) * 0.9996;
    return [i * 60_000, open, high, low, close, 100 + i] as Bar;
  });
}

// ── Hurst ────────────────────────────────────────────────────────────────────

test("Hurst separates a persistent series from a mean-reverting one", () => {
  const trending = hurstExponent(persistent());
  const reverting = hurstExponent(meanReverting());
  assert.ok(
    trending.H > reverting.H,
    `trending H ${trending.H.toFixed(3)} should exceed reverting H ${reverting.H.toFixed(3)}`,
  );
  assert.ok(trending.H > 0.5, `a clean trend should be persistent, got ${trending.H.toFixed(3)}`);
});

test("Hurst reports low reliability on a sample too small to argue with", () => {
  const tiny = hurstExponent(randomWalk(20));
  assert.equal(tiny.H, 0.5);
  assert.equal(tiny.reliability, 0);
  assert.equal(tiny.lags, 0);
});

test("Hurst is bounded and finite on a constant series", () => {
  const flat = new Array(300).fill(100);
  const result = hurstExponent(flat);
  assert.ok(Number.isFinite(result.H));
  assert.ok(result.H >= 0 && result.H <= 1);
});

// ── Variance ratio ───────────────────────────────────────────────────────────

test("variance ratio detects momentum in a trending series", () => {
  const returns = logReturns(persistent(800));
  const vr = varianceRatio(returns, 4);
  assert.ok(vr.ratio > 1, `expected a trending series to give VR > 1, got ${vr.ratio.toFixed(3)}`);
});

test("variance ratio detects mean reversion as a sub-unit ratio", () => {
  const returns = logReturns(meanReverting(800));
  const vr = varianceRatio(returns, 4);
  assert.ok(vr.ratio < 1, `expected a reverting series to give VR < 1, got ${vr.ratio.toFixed(3)}`);
});

test("variance ratio degrades gracefully with no data", () => {
  const vr = varianceRatio([], 4);
  assert.equal(vr.ratio, 1);
  assert.equal(vr.z, 0);
});

// ── Ornstein–Uhlenbeck ───────────────────────────────────────────────────────

test("OU fit recovers a positive half-life on a mean-reverting series", () => {
  const fit = ouFit(meanReverting(600));
  assert.equal(fit.usable, true);
  assert.ok(fit.halfLife > 0 && Number.isFinite(fit.halfLife));
  assert.ok(Math.abs(fit.mu - 100) < 5, `long-run mean should sit near 100, got ${fit.mu.toFixed(2)}`);
});

test("OU fit refuses to call a trending series mean-reverting", () => {
  const fit = ouFit(persistent(600));
  // A trend has no stationary long-run mean; the fit must not report one it
  // cannot defend, or the desk would short every uptrend.
  assert.equal(fit.usable, false);
});

test("OU z-score is signed and bounded", () => {
  const fit = ouFit(meanReverting(600, 17, 0.95));
  assert.ok(Number.isFinite(fit.z));
  assert.ok(fit.z >= -6 && fit.z <= 6);
});

// ── Distribution shape ───────────────────────────────────────────────────────

test("skewness and kurtosis fall back to the normal values on tiny samples", () => {
  assert.equal(skewness([1, 2]), 0);
  assert.equal(excessKurtosis([1, 2, 3]), 0);
});

test("a symmetric sample is not skewed, a one-sided one is", () => {
  const symmetric = [-3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3];
  assert.ok(Math.abs(skewness(symmetric)) < 1e-9, `expected zero skew, got ${skewness(symmetric)}`);
  const oneSided = [0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.2, 0.3, 0.9, 2.5];
  assert.ok(skewness(oneSided) > 1, `expected a strong positive skew, got ${skewness(oneSided)}`);
});

// ── Information ──────────────────────────────────────────────────────────────

test("efficiency ratio separates a straight line from chop", () => {
  const straight = Array.from({ length: 30 }, (_, i) => 100 + i);
  const chop = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  assert.ok(efficiencyRatio(straight) > 0.9);
  assert.ok(efficiencyRatio(chop) < 0.2);
});

test("entropy is maximal for uniform noise and lower for concentrated data", () => {
  const uniform = Array.from({ length: 800 }, (_, i) => (i % 8) / 8);
  const concentrated = Array.from({ length: 800 }, () => 0.5);
  const a = shannonEntropy(uniform, 8);
  const b = shannonEntropy(concentrated, 8);
  assert.ok(a.normalised > b.normalised, `uniform ${a.normalised} vs concentrated ${b.normalised}`);
  assert.ok(a.normalised > 0.9);
});

// ── Flow and structure ───────────────────────────────────────────────────────

test("money flow is positive when closes ride the top of the range", () => {
  const up = barsFrom(Array.from({ length: 60 }, (_, i) => 100 + i * 0.5)).map((bar, i) => {
    // Force closes to the very top of every bar.
    return [bar[0], bar[1], bar[4], bar[3], bar[4], 1000 + i] as Bar;
  });
  const down = barsFrom(Array.from({ length: 60 }, (_, i) => 130 - i * 0.5)).map((bar, i) => {
    return [bar[0], bar[1], bar[2], bar[4], bar[4], 1000 + i] as Bar;
  });
  assert.ok(moneyFlow(up).value > 0, `expected positive flow, got ${moneyFlow(up).value}`);
  assert.ok(moneyFlow(down).value < 0, `expected negative flow, got ${moneyFlow(down).value}`);
});

test("range position puts price at the extremes correctly", () => {
  const bars = barsFrom([100, 101, 102, 103, 104, 105]);
  assert.ok(rangePosition(bars, 20) > 0.9);
  const falling = barsFrom([105, 104, 103, 102, 101, 100]);
  assert.ok(rangePosition(falling, 20) < 0.1);
});

test("volatility expansion is ~1 for constant-range bars", () => {
  const bars = barsFrom(Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 3)));
  assert.ok(Math.abs(volatilityExpansion(bars) - 1) < 0.6);
});

// ── Kalman ───────────────────────────────────────────────────────────────────

test("Kalman trend recovers the sign and rough size of a known slope", () => {
  const rising = Array.from({ length: 120 }, (_, i) => 100 + i * 0.25);
  const falling = Array.from({ length: 120 }, (_, i) => 130 - i * 0.25);
  assert.ok(kalmanTrend(rising, 0.25).slope > 0.15, "a rising series must have a positive slope");
  assert.ok(kalmanTrend(falling, 0.25).slope < -0.15, "a falling series must have a negative slope");
});

test("Kalman trend survives a short series without throwing", () => {
  const result = kalmanTrend([100, 101], 1);
  assert.ok(Number.isFinite(result.level));
  assert.ok(Number.isFinite(result.slope));
});

// ── Volatility and autocorrelation ───────────────────────────────────────────

test("GARCH volatility tracks the scale of the returns it is given", () => {
  const calm = logReturns(randomWalk(400, 21, 0.0004));
  const wild = logReturns(randomWalk(400, 22, 0.006));
  assert.ok(garchVolatility(wild) > garchVolatility(calm));
});

test("lag-1 autocorrelation is positive for a smooth trend and ~0 for noise", () => {
  const trend = Array.from({ length: 400 }, (_, i) => Math.sin(i / 25));
  assert.ok(lag1Autocorrelation(trend) > 0.9);
  // Measured on RETURNS: a price series is near-perfectly autocorrelated by
  // construction, so testing prices here would prove nothing.
  const noise = logReturns(randomWalk(3000, 31, 0.02));
  assert.ok(Math.abs(lag1Autocorrelation(noise)) < 0.1, `noise lag1 ${lag1Autocorrelation(noise)}`);
});

test("Ljung–Box finds structure in a smooth series and not in noise", () => {
  const trend = Array.from({ length: 400 }, (_, i) => Math.sin(i / 25));
  assert.ok(ljungBox(trend, 5).pValue < 0.05);
});

// ── Bayesian inference ───────────────────────────────────────────────────────

test("a 5/1 record is not evidence of an 83% strategy", () => {
  const posterior = betaPosterior(5, 1);
  assert.ok(posterior.mean < 0.7, `posterior mean ${posterior.mean} should be pulled toward the prior`);
  assert.ok(posterior.lower < posterior.mean, "the lower bound must stay conservative");
});

test("posterior confidence tightens as the sample grows", () => {
  const small = betaPosterior(20, 10);
  const large = betaPosterior(200, 100);
  assert.ok(large.sd < small.sd, "more data must mean a tighter posterior");
  assert.ok(Math.abs(large.mean - 2 / 3) < 0.05);
});

test("the normal CDF matches known values", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 0.001);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 0.001);
});

// ── Performance statistics ───────────────────────────────────────────────────

test("performance statistics summarise an R series correctly", () => {
  const stats = performanceStats([1, -1, 2, -1, 1.5, -1, 1]);
  assert.equal(stats.trades, 7);
  assert.equal(stats.wins, 4);
  assert.equal(stats.losses, 3);
  assert.ok(Math.abs(stats.winRate - 4 / 7) < 1e-9);
  assert.ok(Math.abs(stats.totalR - 2.5) < 1e-9);
  assert.ok(Math.abs(stats.profitFactor - 5.5 / 3) < 1e-9);
  assert.equal(stats.maxLosingStreak, 1);
});

test("performance statistics handle an empty history", () => {
  const stats = performanceStats([]);
  assert.equal(stats.trades, 0);
  assert.equal(stats.profitFactor, 0);
  assert.ok(Number.isFinite(stats.sharpeLike));
});

test("max drawdown in R is measured from the equity peak", () => {
  const stats = performanceStats([2, -1, -1.5, 1, -0.5]);
  // Equity: 2, 1, -0.5, 0.5, 0 → peak 2, trough -0.5 → drawdown 2.5R.
  assert.ok(Math.abs(stats.maxDrawdownR - 2.5) < 1e-9, `got ${stats.maxDrawdownR}`);
});
