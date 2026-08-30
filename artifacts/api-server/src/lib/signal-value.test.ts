/**
 * Self-Measured Signal Value (method 7) — tests.
 *
 * The engine pools its own decision-time features + realized outcomes per
 * mode (normal / recovery separately), and only features whose top tercile
 * beat their bottom tercile by ≥ 10pp earn bounded score weight.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  metaBonus,
  recordTradeSignal,
  resetSignalValue,
  signalPoolSize,
  valuedSignals,
  type DecisionFeatures,
} from "./signal-value.ts";

function feats(z: number, over: Partial<DecisionFeatures> = {}): DecisionFeatures {
  return {
    z,
    lambda: 0.8,
    timing: 60,
    hazardRelative: 1,
    entropyDelta: 0,
    ciOverlap: 0,
    ...over,
  };
}

/** i ∈ 0..n-1 with a spread of z-values (1..n). */
function zFor(i: number, n: number): number {
  return i + 1;
}

beforeEach(() => resetSignalValue());

describe("signal value pool", () => {
  it("starts empty — no valued signals, zero bonus", () => {
    assert.equal(signalPoolSize("normal"), 0);
    assert.equal(signalPoolSize("recovery"), 0);
    assert.deepEqual(valuedSignals("normal"), []);
    assert.equal(metaBonus(feats(5), "normal"), 0);
    assert.equal(metaBonus(feats(5), "recovery"), 0);
  });

  it("caps the pool at 60 records per mode", () => {
    for (let i = 0; i < 70; i++) recordTradeSignal("normal", feats(zFor(i, 70)), true);
    assert.equal(signalPoolSize("normal"), 60);
  });
});

describe("feature valuation (top vs bottom tercile)", () => {
  it("values a feature that predicts wins (z high ⇒ wins)", () => {
    // 15 records, z = 1..15 (increases with i). Terciles of 5.
    // Wins: z ≥ 11 (top tercile, 5 wins), z = 3, z = 8 → z lift = 1.0 − 0.2.
    // Every OTHER feature is strictly DECREASING in i (anti-correlated with
    // z): each of their top terciles is the low-z (losing) end and their
    // bottom tercile is the high-z (winning) end → lift −0.8 → NOT valued.
    // Only z should earn weight.
    for (let i = 0; i < 15; i++) {
      const z = zFor(i, 15);
      const won = z >= 11 || z === 3 || z === 8;
      recordTradeSignal("normal", {
        z,
        lambda:         1 - z / 20,
        timing:         100 - z * 3,
        hazardRelative: 2 - z / 10,
        entropyDelta:   0.2 - z / 50,
        ciOverlap:      1 - z / 20,
      }, won);
    }

    const valued = valuedSignals("normal");
    const zSig = valued.find(v => v.key === "z");
    assert.ok(zSig, "z should be a valued signal");
    assert.ok(zSig!.lift > 0.5, `lift = ${zSig!.lift}`);

    // Candidate in the top tercile (z ≥ topCutoff) earns the bonus…
    assert.equal(metaBonus(feats(14), "normal"), 2);
    // …in the bottom tercile it earns the penalty…
    assert.equal(metaBonus(feats(2), "normal"), -2);
    // …and the middle earns nothing.
    assert.equal(metaBonus(feats(8), "normal"), 0);
  });

  it("values nothing when features are independent of outcomes", () => {
    // 18 records (6 per tercile); wins alternate → 3/6 win-rate in every
    // tercile for every monotonic feature layout → lift exactly 0.
    for (let i = 0; i < 18; i++) {
      recordTradeSignal("normal", feats(zFor(i, 18)), i % 2 === 0);
    }
    assert.deepEqual(valuedSignals("normal"), []);
    assert.equal(metaBonus(feats(18), "normal"), 0);
    assert.equal(metaBonus(feats(1), "normal"), 0);
  });

  it("needs the minimum pool size (12) before valuing anything", () => {
    for (let i = 0; i < 11; i++) {
      recordTradeSignal("normal", feats(zFor(i, 11)), i >= 6);
    }
    assert.deepEqual(valuedSignals("normal"), []);
    assert.equal(metaBonus(feats(11), "normal"), 0);
  });
});

describe("mode separation & bounds", () => {
  it("learns normal and recovery trades separately", () => {
    // Recovery pool: lambda high ⇒ wins. Normal pool: empty.
    for (let i = 0; i < 15; i++) {
      const lambda = 0.5 + i / 20; // 0.5 .. 1.2 → clamp at 1 irrelevant for ranking
      recordTradeSignal("recovery", feats(5, { lambda: Math.min(1, lambda) }), i >= 5);
    }

    const recValued = valuedSignals("recovery");
    assert.ok(recValued.length > 0, "recovery pool should value lambda");
    assert.ok(recValued.some(v => v.key === "lambda"));

    // The normal pool saw nothing — its bonus stays exactly 0.
    assert.deepEqual(valuedSignals("normal"), []);
    assert.equal(metaBonus(feats(5, { lambda: 1 }), "normal"), 0);
  });

  it("clamps the total bonus to ±6 even if every feature is valued", () => {
    // All six features perfectly predict: win ⟺ value in top tercile.
    for (let i = 0; i < 18; i++) {
      const top = i >= 6;
      recordTradeSignal("normal", {
        z: i + 1,
        lambda: 0.5 + i / 40,
        timing: 40 + i,
        hazardRelative: 0.8 + i / 50,
        entropyDelta: -0.1 + i / 100,
        ciOverlap: i / 10,
      }, top);
    }
    const valued = valuedSignals("normal");
    assert.ok(valued.length >= 3, `valued features = ${valued.length}`);

    const topCandidate: DecisionFeatures = {
      z: 18, lambda: 1, timing: 57, hazardRelative: 1.34, entropyDelta: 0.07, ciOverlap: 1.7,
    };
    const bottomCandidate: DecisionFeatures = {
      z: 1, lambda: 0.52, timing: 41, hazardRelative: 0.84, entropyDelta: -0.09, ciOverlap: 0.1,
    };
    assert.equal(metaBonus(topCandidate, "normal"), 6);   // clamped from higher
    assert.equal(metaBonus(bottomCandidate, "normal"), -6);
  });
});
