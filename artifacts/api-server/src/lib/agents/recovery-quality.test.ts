import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adjustRecoveryEstimateForSelection,
  estimateRecoveryProbability,
  evaluateRecoveryEconomics,
  isUsableRecoverySnapshot,
  recoveryDurationFor,
  wilsonLowerBound,
} from "./recovery-quality.ts";

describe("recovery probability and payout quality", () => {
  it("estimates digit-contract outcomes at the requested expiry horizon", () => {
    const estimate = estimateRecoveryProbability({
      contractType: "DIGITOVER",
      barrier: 3,
      duration: 2,
      digits: [0, 1, 2, 3, 4, 5],
      prices: [],
    });
    assert.ok(estimate);
    assert.equal(estimate.observations, 4);
    assert.equal(estimate.wins, 2);
    assert.equal(estimate.probability, 0.5);
  });

  it("estimates CALL/PUT outcomes using price movement at expiry", () => {
    const call = estimateRecoveryProbability({
      contractType: "CALL",
      barrier: null,
      duration: 2,
      digits: [],
      prices: [2, 1, 3, 2, 1],
    });
    assert.ok(call);
    assert.equal(call.observations, 3);
    assert.equal(call.wins, 2);

    const put = estimateRecoveryProbability({
      contractType: "PUT",
      barrier: null,
      duration: 2,
      digits: [],
      prices: [2, 1, 3, 2, 1],
    });
    assert.ok(put);
    assert.equal(put.wins, 1);
  });

  it("uses stricter uncertainty bounds when selecting Match/Diff digits", () => {
    const match = estimateRecoveryProbability({
      contractType: "DIGITMATCH",
      barrier: 7,
      duration: 1,
      digits: Array.from({ length: 100 }, (_, i) => i % 10 === 7 ? 7 : i % 10),
      prices: [],
    });
    const over = estimateRecoveryProbability({
      contractType: "DIGITOVER",
      barrier: 3,
      duration: 1,
      digits: Array.from({ length: 100 }, (_, i) => i % 10),
      prices: [],
    });
    assert.ok(match && over);
    assert.equal(match.confidenceZ, 2.576);
    assert.equal(over.confidenceZ, 1.96);
    assert.ok(match.lowerWinProbability < match.probability);
  });

  it("does not treat a constant run as many independent observations", () => {
    const estimate = estimateRecoveryProbability({
      contractType: "DIGITMATCH",
      barrier: 4,
      duration: 1,
      digits: Array(80).fill(4),
      prices: [],
    });
    assert.ok(estimate);
    assert.equal(estimate.effectiveSampleSize, 1);
    assert.equal(estimate.lowerWinProbability, wilsonLowerBound(1, 1, 2.576));
  });

  it("requires conservative lower-bound EV to exceed break-even", () => {
    const estimate = {
      wins: 90,
      observations: 100,
      probability: 0.9,
      effectiveSampleSize: 100,
      lowerWinProbability: 0.84,
      confidenceZ: 1.96,
    };
    const positive = evaluateRecoveryEconomics(estimate, 1.25);
    assert.equal(positive.breakEvenProbability, 0.8);
    assert.ok(positive.expectedValueLowerBound > 0);
    assert.equal(positive.acceptable, true);

    const negative = evaluateRecoveryEconomics(estimate, 1.15);
    assert.ok(negative.expectedValueLowerBound < 0);
    assert.equal(negative.acceptable, false);
  });

  it("rejects insufficient data or invalid payouts", () => {
    const small = {
      wins: 20,
      observations: 20,
      probability: 1,
      effectiveSampleSize: 10,
      lowerWinProbability: 0.5,
      confidenceZ: 1.96,
    };
    assert.equal(evaluateRecoveryEconomics(small, 3).rejectionReason, "insufficient_effective_sample");
    assert.equal(evaluateRecoveryEconomics(small, 1).rejectionReason, "invalid_payout");
  });

  it("adjusts confidence for selecting among multiple candidates and digits", () => {
    const estimate = {
      wins: 80,
      observations: 100,
      probability: 0.8,
      effectiveSampleSize: 100,
      lowerWinProbability: 0.7,
      confidenceZ: 1.96,
    };
    const one = adjustRecoveryEstimateForSelection(estimate, 1);
    const many = adjustRecoveryEstimateForSelection(estimate, 12);
    const digitSearch = adjustRecoveryEstimateForSelection(estimate, 12, 10);
    assert.ok(Math.abs(one.confidenceZ - 1.96) < 0.01);
    assert.ok(many.confidenceZ > one.confidenceZ);
    assert.ok(digitSearch.confidenceZ > many.confidenceZ);
    assert.ok(digitSearch.lowerWinProbability < many.lowerWinProbability);
  });

  it("preserves current recovery duration rules", () => {
    assert.equal(recoveryDurationFor("DIGITEVEN", 2), 5);
    assert.equal(recoveryDurationFor("DIGITMATCH", 9), 5);
    assert.equal(recoveryDurationFor("DIGITMATCH", 2), 2);
    assert.equal(recoveryDurationFor("CALL", 4), 4);
  });
});

describe("recovery feed snapshot validation", () => {
  const snapshot = {
    tick: { source: "live" as const, generation: 3, sequence: 12, receivedAt: 990, digit: 7, price: 100 },
    ticks: Array.from({ length: 5 }, (_, i) => ({
      source: "live" as const, generation: 3, sequence: 8 + i, receivedAt: 950 + i * 10, digit: i, price: 100 + i,
    })),
  };

  it("accepts fresh homogeneous provenance", () => {
    assert.equal(isUsableRecoverySnapshot(snapshot, {
      expectedSource: "live", minTicks: 5, maxAgeMs: 100, nowMs: 1000,
      expectedGeneration: 3, minimumSequence: 12,
    }), true);
  });

  it("rejects simulated, stale, short, or mixed-generation history", () => {
    assert.equal(isUsableRecoverySnapshot(snapshot, {
      expectedSource: "simulated", minTicks: 5, maxAgeMs: 100, nowMs: 1000,
    }), false);
    assert.equal(isUsableRecoverySnapshot(snapshot, {
      expectedSource: "live", minTicks: 5, maxAgeMs: 5, nowMs: 1000,
    }), false);
    assert.equal(isUsableRecoverySnapshot(snapshot, {
      expectedSource: "live", minTicks: 6, maxAgeMs: 100, nowMs: 1000,
    }), false);
    const mixed = { ...snapshot, ticks: [...snapshot.ticks.slice(0, 4), { ...snapshot.ticks[4], generation: 2 }] };
    assert.equal(isUsableRecoverySnapshot(mixed, {
      expectedSource: "live", minTicks: 5, maxAgeMs: 100, nowMs: 1000,
    }), false);
    const unordered = { ...snapshot, ticks: [...snapshot.ticks.slice(0, 3), snapshot.ticks[2]!, ...snapshot.ticks.slice(4)] };
    assert.equal(isUsableRecoverySnapshot(unordered, {
      expectedSource: "live", minTicks: 5, maxAgeMs: 100, nowMs: 1000,
    }), false);
  });
});
