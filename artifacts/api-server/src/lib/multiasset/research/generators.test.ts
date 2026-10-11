/**
 * Generator tests (WP2).
 *
 * A null generator that accidentally contains structure would make every agent
 * look like it has an edge; a positive control that is too easy would make a
 * broken detector look like it works. These tests verify the PROPERTIES each
 * generator claims, because everything downstream depends on them:
 *
 *   driftless      — no drift, no autocorrelation, no trend
 *   block-shuffled — same marginal distribution, no autocorrelation
 *   phase-randomised — same amplitude spectrum (≈ same autocorrelation), no
 *                      non-linear structure, and driftless despite the source
 *   positive control — real, persistent autocorrelation and a drift that
 *                      switches regimes
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  DEFAULT_GENERATOR_SPEC,
  blockShuffle,
  driftlessWalk,
  generate,
  phaseRandomise,
  positiveControl,
  seriesStats,
} from "./generators";
import { mean, stdev } from "../math";

const SPEC = { ...DEFAULT_GENERATOR_SPEC, bars: 1024, seed: 42 };

test("the driftless walk has no drift and no autocorrelation", () => {
  const { returns } = driftlessWalk(SPEC);
  const stats = seriesStats(returns);
  // |mean| within 4 standard errors of zero.
  const se = stats.stdev / Math.sqrt(returns.length);
  assert.ok(Math.abs(stats.mean) < 4 * se, `mean ${stats.mean} vs 4·SE ${4 * se}`);
  assert.ok(Math.abs(stats.lag1) < 0.1, `lag-1 autocorrelation ${stats.lag1}`);
});

test("block shuffling preserves the marginal distribution and destroys order", () => {
  const source = driftlessWalk({ ...SPEC, volatility: 0.001 }).returns;
  const shuffled = blockShuffle({ returns: source, blockSize: 10, seed: 7 });
  assert.equal(shuffled.length, source.length);
  assert.ok(Math.abs(mean(shuffled) - mean(source)) < 1e-9, "mean must be preserved exactly");
  assert.ok(
    Math.abs(stdev(shuffled) - stdev(source)) / stdev(source) < 0.05,
    "dispersion must be preserved to within sampling noise",
  );
  // …but the sequence itself must have changed.
  assert.notDeepEqual(shuffled.slice(0, 20), source.slice(0, 20));
});

test("phase randomisation keeps the spectrum and removes the drift", () => {
  const source = positiveControl({ ...SPEC, bars: 512 }).returns;
  const surrogate = phaseRandomise({ returns: source, seed: 99 });
  assert.equal(surrogate.length, 512);
  const sourceStats = seriesStats(source);
  const surrogateStats = seriesStats(surrogate);
  // Drift is gone even though the source had a strong regime drift.
  assert.ok(Math.abs(sourceStats.mean) > 0, "the source must actually have drift");
  assert.ok(
    Math.abs(surrogateStats.mean) < 0.25 * Math.abs(sourceStats.mean),
    `surrogate mean ${surrogateStats.mean} should be far below source ${sourceStats.mean}`,
  );
  // The variance is preserved (Parseval): a surrogate that shrank the series
  // would make every agent look conservative.
  assert.ok(
    Math.abs(surrogateStats.stdev - sourceStats.stdev) / sourceStats.stdev < 0.15,
    `stdev ${surrogateStats.stdev} vs ${sourceStats.stdev}`,
  );
});

test("the positive control has the structure the nulls do not", () => {
  const control = positiveControl(SPEC);
  const nulls = [
    driftlessWalk(SPEC),
    generate("block-shuffled", SPEC),
    generate("phase-randomised", SPEC),
  ];
  const controlStats = seriesStats(control.returns);
  // 1. A real drift: the high regime is long enough to dominate the sample.
  assert.ok(controlStats.mean > 0, `control drift ${controlStats.mean} must be positive`);
  // 2. Real temporal structure: the AR(1) residual leaves positive lag-1
  //    autocorrelation...
  assert.ok(controlStats.lag1 > 0.005, `control lag-1 ${controlStats.lag1}`);
  // 3. …and the regimes are actually switching, not a constant drift.
  const regimes = control.regime ?? [];
  const switches = regimes.filter((r, i) => i > 0 && r !== regimes[i - 1]).length;
  assert.ok(switches >= 5, `the control must switch regimes (saw ${switches})`);
  const highShare = regimes.filter((r) => r === "high").length / regimes.length;
  assert.ok(highShare > 0.3 && highShare < 0.7, `regime balance ${highShare}`);
  // 4. And it is genuinely distinguishable from the nulls.
  for (const nullSeries of nulls) {
    const nullStats = seriesStats(nullSeries.returns);
    assert.ok(
      Math.abs(nullStats.lag1) < Math.abs(controlStats.lag1),
      `${nullSeries.kind} lag-1 (${nullStats.lag1}) must be smaller than the control's (${controlStats.lag1})`,
    );
  }
});

test("every generator is deterministic for a given seed", () => {
  for (const kind of ["driftless", "block-shuffled", "phase-randomised", "positive-control"] as const) {
    const a = generate(kind, { ...SPEC, seed: 1234 });
    const b = generate(kind, { ...SPEC, seed: 1234 });
    assert.deepEqual(a.returns, b.returns, `${kind} is not deterministic`);
    assert.deepEqual(a.bars, b.bars, `${kind} bars are not deterministic`);
  }
  // …and different seeds give different series.
  const x = generate("driftless", { ...SPEC, seed: 1 }).returns;
  const y = generate("driftless", { ...SPEC, seed: 2 }).returns;
  assert.notDeepEqual(x.slice(0, 10), y.slice(0, 10));
});

test("generated bars are well-formed OHLC with monotone timestamps", () => {
  const { bars } = positiveControl(SPEC);
  assert.equal(bars.length, SPEC.bars + 1);
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i] as [number, number, number, number, number, number];
    const prev = bars[i - 1] as [number, number, number, number, number, number];
    assert.ok(bar[0] > prev[0], "timestamps must be monotone increasing");
    assert.ok(bar[2] >= Math.max(bar[1], bar[4]), `high must bound the body at ${i}`);
    assert.ok(bar[3] <= Math.min(bar[1], bar[4]), `low must bound the body at ${i}`);
    assert.ok(bar[1] > 0 && bar[4] > 0, "prices must stay positive");
    // The bar opens where the previous bar closed: a continuous series.
    assert.ok(Math.abs(bar[1] - prev[4]) < 1e-12);
  }
});
