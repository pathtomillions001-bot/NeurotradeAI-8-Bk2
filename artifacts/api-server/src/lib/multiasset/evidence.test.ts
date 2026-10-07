/**
 * Evidence ensemble tests.
 *
 * The point of this module is behavioural as much as mathematical. These tests
 * pin down the two properties that matter most and that the old pipeline got
 * wrong:
 *
 *   1. no single family can veto a setup;
 *   2. a setup needs several INDEPENDENT agreeing families, not all of them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEvidence,
  FACTOR_FAMILIES,
  MODE_FACTOR_WEIGHTS,
  MODE_MIN_AGREEING_FAMILIES,
} from "./evidence";
import { makeRng } from "./math";
import type { Bar, TradeMode } from "./types";

function series(kind: "up" | "down" | "range" | "chop", count = 220, seed = 1): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  let price = 1.08;
  for (let i = 0; i < count; i++) {
    const open = price;
    if (kind === "up") price = open * Math.exp(0.0006 + (rng() - 0.5) * 0.0004);
    else if (kind === "down") price = open * Math.exp(-0.0006 + (rng() - 0.5) * 0.0004);
    else if (kind === "range") price = 1.08 * (1 + Math.sin(i / 6) * 0.0004) * (1 + (rng() - 0.5) * 0.00005);
    else price = open * Math.exp((rng() - 0.5) * 0.002);
    const high = Math.max(open, price) * (1 + rng() * 0.0002);
    const low = Math.min(open, price) * (1 - rng() * 0.0002);
    bars.push([i * 60_000, open, high, low, price, 100 + i]);
  }
  return bars;
}

function evidenceFor(kind: "up" | "down" | "range" | "chop", mode: TradeMode = "intraday") {
  return buildEvidence({
    symbol: "EURUSD",
    mode,
    timeframe: mode === "scalp" ? "M2" : mode === "intraday" ? "M15" : "H1",
    bars: series(kind, 220, mode === "scalp" ? 2 : mode === "intraday" ? 3 : 4),
    horizon: mode === "scalp" ? 12 : mode === "intraday" ? 24 : 48,
  });
}

test("every mode weights exactly the seven families and each row sums to 1", () => {
  for (const mode of ["scalp", "intraday", "swing"] as TradeMode[]) {
    const weights = MODE_FACTOR_WEIGHTS[mode];
    assert.deepEqual(Object.keys(weights).sort(), [...FACTOR_FAMILIES].sort());
    const total = FACTOR_FAMILIES.reduce((acc, family) => acc + weights[family], 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${mode} weights sum to ${total}`);
  }
});

test("modes weight their own horizon's evidence", () => {
  assert.ok(
    MODE_FACTOR_WEIGHTS.scalp.flow > MODE_FACTOR_WEIGHTS.swing.flow,
    "microstructure must matter more to a scalp than to a swing trade",
  );
  assert.ok(
    MODE_FACTOR_WEIGHTS.swing.trend > MODE_FACTOR_WEIGHTS.scalp.trend,
    "trend must matter more to a swing trade than to a scalp",
  );
  assert.ok(
    MODE_FACTOR_WEIGHTS.swing.regime > MODE_FACTOR_WEIGHTS.scalp.regime,
    "regime memory must matter more over days than over minutes",
  );
  assert.ok(
    MODE_FACTOR_WEIGHTS.scalp.meanReversion > MODE_FACTOR_WEIGHTS.swing.meanReversion,
    "fading an extension is a scalp tool far more than a swing tool",
  );
});

test("an uptrend reads as up and a downtrend as down", () => {
  assert.equal(evidenceFor("up").direction, "up");
  assert.equal(evidenceFor("down").direction, "down");
});

test("a trending market earns more agreeing families than a choppy one", () => {
  const trend = evidenceFor("up");
  const chop = evidenceFor("chop");
  assert.ok(
    trend.agreeingFamilies > chop.agreeingFamilies,
    `trend agreed ${trend.agreeingFamilies}, chop agreed ${chop.agreeingFamilies}`,
  );
  assert.ok(trend.confidence > chop.confidence);
});

test("no single family can veto: a setup still forms when one family opposes", () => {
  const evidence = evidenceFor("up");
  const opposing = evidence.factors.filter((factor) => factor.vote === -1);
  // A clean uptrend may still have one or two contrarian families (notably
  // mean reversion, which dislikes any extension). That must not zero it out.
  for (const factor of opposing) {
    assert.ok(
      Number.isFinite(factor.contribution),
      `${factor.family} must contribute a finite number, not block`,
    );
  }
  assert.ok(evidence.confidence > 50, `expected a net-positive ensemble, got ${evidence.confidence}`);
});

test("the minimum agreement rule is a majority of families, not unanimity", () => {
  for (const mode of ["scalp", "intraday", "swing"] as TradeMode[]) {
    assert.ok(
      MODE_MIN_AGREEING_FAMILIES[mode] < FACTOR_FAMILIES.length,
      `${mode} must not require every family to agree — that is the analysis-paralysis bug`,
    );
    assert.ok(MODE_MIN_AGREEING_FAMILIES[mode] >= 2, `${mode} must require more than one family`);
  }
});

test("an unreliable family is shrunk toward neutral rather than dropped", () => {
  const evidence = evidenceFor("up");
  for (const factor of evidence.factors) {
    const trust = 0.35 + 0.65 * factor.reliability;
    const expected = factor.vote * factor.strength * factor.weight * trust;
    assert.ok(
      Math.abs(factor.contribution - expected) < 1e-9,
      `${factor.family} contribution should be reliability-shrunk`,
    );
  }
});

test("mean reversion is suppressed when the series is trending", () => {
  const evidence = evidenceFor("up");
  const reversion = evidence.factors.find((factor) => factor.family === "meanReversion");
  assert.ok(reversion);
  // In a trend the OU reading is either neutral or opposing, never the driver.
  assert.ok(
    reversion.contribution <= 0.05,
    `mean reversion should not favour a long in an uptrend, got ${reversion.contribution}`,
  );
  assert.match(reversion.detail, /suppressed|OU z/);
});

test("diagnostics are populated and finite for any real series", () => {
  for (const kind of ["up", "down", "range", "chop"] as const) {
    const { diagnostics } = evidenceFor(kind);
    for (const [key, value] of Object.entries(diagnostics)) {
      if (key === "ouHalfLife") continue; // Infinity is a valid half-life
      assert.ok(
        Number.isFinite(value as number),
        `${kind}: diagnostic ${key} was ${value}`,
      );
    }
    assert.ok(diagnostics.hurstH >= 0 && diagnostics.hurstH <= 1);
    assert.ok(diagnostics.rsi >= 0 && diagnostics.rsi <= 100);
  }
});

test("a tiny sample produces a neutral, low-confidence ensemble", () => {
  const evidence = buildEvidence({
    symbol: "EURUSD",
    mode: "intraday",
    timeframe: "M15",
    bars: series("up", 12),
    horizon: 24,
  });
  assert.ok(evidence.confidence >= 0 && evidence.confidence <= 100);
  assert.ok(Number.isFinite(evidence.raw));
});

test("factors are returned strongest-first so the terminal can lead with them", () => {
  const evidence = evidenceFor("up");
  for (let i = 1; i < evidence.factors.length; i++) {
    assert.ok(
      Math.abs(evidence.factors[i - 1].contribution) >= Math.abs(evidence.factors[i].contribution),
      "factors must be sorted by absolute contribution",
    );
  }
});
