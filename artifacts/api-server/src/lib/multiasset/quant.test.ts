/**
 * Quantitative measurement tests.
 *
 * Each estimator is checked against a case whose answer is known by hand, so
 * a sign error or an off-by-one in the downside deviation fails loudly instead
 * of printing a plausible-looking Sharpe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  annualisedSharpe,
  bootstrapInterval,
  maxDrawdownPct,
  shrinkDrift,
  sortinoRatio,
  tradeMetrics,
  tStatistic,
} from "./quant";
import { mean, stdev } from "./math";

test("drift shrinkage: noise-level drift is almost entirely discarded", () => {
  // t = 0.3 → weight 0.09 / (0.09 + 9) ≈ 1%.
  const sigma = 0.001;
  const n = 100;
  const drift = (0.3 * sigma) / Math.sqrt(n);
  const kept = shrinkDrift(drift, sigma, n);
  assert.ok(kept > 0 && kept < drift * 0.02, `kept ${kept} of ${drift}`);
});

test("drift shrinkage: a pure-noise t of one keeps about a tenth, never half", () => {
  // The bug this guards against: at t = 1 an earlier constant kept 50% of noise.
  const sigma = 0.001;
  const n = 400;
  const drift = (1 * sigma) / Math.sqrt(n);
  const weight = shrinkDrift(drift, sigma, n) / drift;
  assert.ok(Math.abs(weight - 0.1) < 1e-9, `weight was ${weight}`);
});

test("drift shrinkage: a clearly significant trend keeps most of its drift", () => {
  const sigma = 0.001;
  const n = 400;
  const drift = (9 * sigma) / Math.sqrt(n); // t = 9 → weight 81 / 90 = 0.9
  const kept = shrinkDrift(drift, sigma, n);
  assert.ok(Math.abs(kept / drift - 0.9) < 1e-9, `weight was ${kept / drift}`);
});

test("drift shrinkage keeps the sign and never inflates the drift", () => {
  const sigma = 0.002;
  for (const drift of [0.0004, -0.0004, 0.01, -0.01]) {
    const kept = shrinkDrift(drift, sigma, 200);
    assert.equal(Math.sign(kept), Math.sign(drift));
    assert.ok(Math.abs(kept) <= Math.abs(drift));
  }
});

test("drift shrinkage degrades to zero when it cannot be measured", () => {
  assert.equal(shrinkDrift(0.01, 0, 100), 0, "no volatility, no measurement");
  assert.equal(shrinkDrift(0.01, 0.001, 1), 0, "one observation measures nothing");
  assert.equal(shrinkDrift(Number.NaN, 0.001, 100), 0);
});

test("the same drift is kept more as the sample grows", () => {
  const sigma = 0.001;
  const drift = 0.00005;
  const short = shrinkDrift(drift, sigma, 50) / drift;
  const long = shrinkDrift(drift, sigma, 5000) / drift;
  assert.ok(long > short, `long-sample weight ${long} should exceed short ${short}`);
});

test("t-statistic of a constant-sign sample is positive and of a flat one is zero", () => {
  assert.ok(tStatistic([1, 2, 3, 2, 1.5]) > 0);
  assert.equal(tStatistic([0.5, 0.5, 0.5]), 0, "zero spread has no t-statistic");
  assert.equal(tStatistic([1]), 0);
});

test("Sortino uses the downside deviation over every observation", () => {
  // mean 0.5; downside terms are (-1)² twice over four observations → sqrt(0.5).
  assert.ok(Math.abs(sortinoRatio([2, -1, 2, -1]) - 0.5 / Math.sqrt(0.5)) < 1e-12);
  assert.equal(sortinoRatio([1, 2, 3]), 0, "no losses means no downside to divide by");
  assert.equal(sortinoRatio([1, -1]), 0, "a zero mean is a zero ratio");
});

test("annualised Sharpe scales the per-trade Sharpe by the square root of the trade count", () => {
  const values = [2, -1, 2, -1];
  const perTrade = mean(values) / stdev(values);
  assert.ok(Math.abs(annualisedSharpe(values, 100) - perTrade * Math.sqrt(100)) < 1e-9);
  assert.equal(annualisedSharpe(values, 0), 0);
});

test("max drawdown in percent follows the compounded equity path", () => {
  // 1.00 → 1.10 → 0.88: a fall of 0.22 from a peak of 1.10 is 20%.
  // Recovering to 0.968 is still short of the peak, and the worst fall stays 20%.
  assert.ok(Math.abs(maxDrawdownPct([0.1, -0.2, 0.1]) - 20) < 1e-9);
  assert.equal(maxDrawdownPct([0.01, 0.02]), 0, "a rising curve never draws down");
  assert.equal(maxDrawdownPct([-1.5]), 100, "a loss past zero is a total loss");
});

test("bootstrap intervals are seeded: the same trades give the same interval", () => {
  const values = [1.2, -1, 0.8, -1, 2, -1, 0.5, 1.5, -1, 0.9];
  const a = bootstrapInterval(values, mean, { seed: 42, iterations: 500 });
  const b = bootstrapInterval(values, mean, { seed: 42, iterations: 500 });
  assert.deepEqual(a, b);
  assert.ok(a.low <= a.estimate && a.estimate <= a.high, "the interval must bracket the estimate");
});

test("a constant sample has a degenerate interval at its own value", () => {
  const interval = bootstrapInterval([0.5, 0.5, 0.5, 0.5], mean);
  assert.deepEqual(interval, { estimate: 0.5, low: 0.5, high: 0.5 });
});

test("trade metrics reproduce hand-computed values", () => {
  // Wins +2, losses −1, alternating: win rate 50%, expectancy +0.5R, profit factor 2.
  const m = tradeMetrics([2, -1, 2, -1], { years: 1, riskPct: 1 });
  assert.equal(m.trades, 4);
  assert.equal(m.winRate, 0.5);
  assert.equal(m.expectancyR, 0.5);
  assert.equal(m.profitFactor, 2);
  // Equity in R: 0 → 2 → 1 → 3 → 2. Both falls are one R from a peak.
  assert.equal(m.maxDrawdownR, 1);
  assert.ok(m.maxDrawdownPct !== null && Math.abs(m.maxDrawdownPct - 1) < 0.05, `dd% ${m.maxDrawdownPct}`);
  assert.ok(m.sharpeAnnualised !== null && m.sharpeAnnualised > 0);
  assert.ok(m.expectancyCI95.low <= m.expectancyR && m.expectancyR <= m.expectancyCI95.high);
});

test("trade metrics report unknowns as null rather than zero", () => {
  const m = tradeMetrics([1, -1, 0.5]);
  assert.equal(m.sharpeAnnualised, null, "no span, no annualisation");
  assert.equal(m.maxDrawdownPct, null, "no risk fraction, no drawdown in percent");

  const empty = tradeMetrics([]);
  assert.equal(empty.trades, 0);
  assert.equal(empty.expectancyR, 0);
  assert.equal(empty.maxDrawdownPct, null);
});
