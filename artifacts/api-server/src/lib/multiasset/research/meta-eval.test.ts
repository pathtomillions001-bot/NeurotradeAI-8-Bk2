/**
 * WP5 study tests — the gates themselves.
 *
 * The study's decision rule is a function of out-of-sample rows, so it can be
 * tested without generating a single series: feed it rows whose calibration is
 * known by construction and check that it says so. What matters here is that
 * every way a meta-model can lie has a gate that fails:
 *
 *   • a model whose probabilities are right but whose confidence is too high
 *   • a model that ranks well and still promises more than it delivers (p_LCB)
 *   • a model that finds "edge" on a series where there is none
 *   • a model that refuses to trade at all (a pass on the null, a fail on the home)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bar } from "../types";
import type { MetaOosRow } from "./meta-eval";
import {
  META_MIN_LABELLED,
  buildMetaViewStream,
  decileBuckets,
  metaCalibrationGates,
  metaNullGates,
  summariseMetaRows,
  trailingRangeMean,
} from "./meta-eval";

let seed = 5;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

/** Rows whose true hit rate is exactly their stated probability. */
function honestRows(count: number, shrink = 1): MetaOosRow[] {
  const rows: MetaOosRow[] = [];
  for (let i = 0; i < count; i++) {
    const p = 0.1 + 0.8 * ((i % 20) / 20);
    const calibrated = 0.5 + (p - 0.5) * shrink;
    const hit = rnd() < p;
    rows.push({
      series: "fixture#1",
      index: i,
      fold: i % 5,
      pRaw: calibrated,
      pHat: calibrated,
      pLcb: Math.max(0, calibrated - 0.08),
      hit,
      rMultiple: hit ? 2 : -1,
      emitted: i % 3 === 0,
      armed: calibrated >= 0.35,
      targetMultipleR: 2,
      weight: 1,
    });
  }
  return rows;
}

describe("research/meta-eval", () => {
  it("passes a well-calibrated model, and reports the fitted policy's edge", () => {
    const stats = summariseMetaRows(honestRows(1200));
    const gates = metaCalibrationGates(stats);
    assert.equal(stats.rows, 1200);
    assert.ok(stats.brierSkill > 0, "a model with real information must beat the constant forecast");
    assert.ok(stats.reliability.identifiable);
    assert.ok(
      Math.abs((stats.reliability.slope ?? 0) - 1) < 0.25,
      `expected a slope near 1, got ${stats.reliability.slope}`,
    );
    assert.equal(stats.violationBuckets.length, 0, "the bound must not be broken by a calibrated model");
    const byName = new Map(gates.gates.map((gate) => [gate.name, gate.pass]));
    assert.equal(byName.get("labelled rows"), true);
    assert.equal(byName.get("reliability slope"), true);
    assert.equal(byName.get("Brier skill"), true);
    assert.equal(byName.get("p_LCB coverage"), true);
    assert.equal(byName.get("fitted beats corpus"), true);
    assert.equal(gates.pass, true);
  });

  it("fails the slope gate when the same ranking is claimed with twice the confidence", () => {
    // The same ranking, claimed with 1.6× the confidence ON THE LOGIT SCALE, so
    // every probability stays strictly inside (0,1) and the fit is ordinary: the
    // slope it reports is the overconfidence itself, not a clipping artefact.
    const rows = honestRows(1200).map((row) => {
      const p = Math.min(1 - 1e-6, Math.max(1e-6, row.pHat));
      const stretched = 1 / (1 + Math.exp(-1.6 * Math.log(p / (1 - p))));
      return { ...row, pHat: stretched, pRaw: stretched };
    });
    const stats = summariseMetaRows(rows);
    assert.ok(
      (stats.reliability.slope ?? 1) < 0.8,
      `an overconfident model must show a slope below 1, got ${stats.reliability.slope}`,
    );
    assert.equal(metaCalibrationGates(stats).pass, false);
  });

  it("fails the coverage gate when a decile's realised rate lands below its own bound", () => {
    const rows = honestRows(1200).map((row, i) => (i < 300 ? { ...row, pLcb: 0.9, hit: false } : row));
    const stats = summariseMetaRows(rows);
    assert.ok(stats.violationBuckets.length > 0, "a broken promise must be caught by name");
    const coverage = metaCalibrationGates(stats).gates.find((gate) => gate.name === "p_LCB coverage");
    assert.equal(coverage?.pass, false);
  });

  it("refuses a claim built on too few labelled events", () => {
    const stats = summariseMetaRows(honestRows(META_MIN_LABELLED - 20));
    const gate = metaCalibrationGates(stats).gates.find((entry) => entry.name === "labelled rows");
    assert.equal(gate?.pass, false);
    assert.equal(metaCalibrationGates(stats).pass, false);
  });

  it("passes the null gate when the model refuses to trade, and fails it when it arms into noise", () => {
    const quiet = summariseMetaRows(honestRows(600).map((row) => ({ ...row, armed: false })));
    assert.equal(metaNullGates(quiet).pass, true, "not trading is not a claim");

    const noisy = honestRows(600).map((row, i) => ({
      ...row,
      armed: true,
      // A model that arms everywhere on a no-edge series shows a positive mean R
      // by luck; the gate must read the LOWER bound, not the point estimate.
      rMultiple: i % 2 === 0 ? 2.05 : -1,
      hit: i % 2 === 0,
    }));
    const loud = summariseMetaRows(noisy);
    assert.ok(loud.fitted.armed >= 10);
    assert.ok(loud.fitted.meanR > 0, "the sample must look profitable for the gate to be tested");
    assert.equal(metaNullGates(loud).pass, false, "a positive lower bound on a null series must fail");
  });

  it("keeps deciles ordered and hides nothing", () => {
    const buckets = decileBuckets(honestRows(400));
    assert.equal(buckets.length, 10);
    for (let i = 1; i < buckets.length; i++) {
      assert.ok(
        (buckets[i] as { meanPredicted: number }).meanPredicted >=
          (buckets[i - 1] as { meanPredicted: number }).meanPredicted - 1e-12,
      );
    }
    assert.equal(buckets.reduce((a, bucket) => a + bucket.rows, 0), 400);
  });

  it("computes the trailing range mean from finished bars only", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 10; i++) bars.push([1_700_000_000_000 + i * 60_000, 100, 100 + (i + 1), 99, 100, 1] as Bar);
    const mean = trailingRangeMean(bars, 4);
    assert.equal(mean[0], null);
    assert.equal(mean[2], null);
    // Bars 0..3 have ranges 2,3,4,5 → mean 3.5, and nothing later may enter it.
    assert.ok(Math.abs((mean[3] as number) - 3.5) < 1e-9);
    assert.ok(mean[4] !== null && (mean[4] as number) > 3.5);
  });

  it("builds a view stream whose views never look past the decision bar", () => {
    const bars: Bar[] = [];
    let price = 100;
    for (let i = 0; i < 500; i++) {
      const drift = Math.sin(i / 12) * 0.05;
      price += drift;
      bars.push([1_700_000_000_000 + i * 300_000, price, price + 0.08, price - 0.08, price, 10] as Bar);
    }
    const stream = buildMetaViewStream({
      bars,
      mode: "intraday",
      spec: {
        symbol: "EURUSD",
        assetClass: "forex",
        point: 0.00001,
        digits: 5,
        tickSize: 0.00001,
        tickValue: 1,
        contractSize: 100_000,
        spreadPoints: 12,
        commissionPerLot: 0,
      } as never,
      symbol: "EURUSD",
      frame: "M5",
      frameWidthMs: 300_000,
      stride: 3,
      warmupBars: 150,
      targetMultipleR: 2,
      horizonBars: 24,
    });
    assert.ok(stream.views.length > 0, "the agents must find something on a waving series");
    for (const view of stream.views) {
      assert.ok(view.index >= 150 && view.index <= bars.length - 26, `view at ${view.index} is outside the causal range`);
      assert.equal(view.direction === 1 || view.direction === -1, true);
      assert.ok(view.probability >= 0 && view.probability <= 1);
      assert.equal(view.changeProbability, null, "without the WP3 model the change reading is unknown, not zero");
      // The reference policy may only act on agents the measured allowlist names.
      if (view.emitted) assert.ok(view.agents.length > 0);
    }
  });
});
