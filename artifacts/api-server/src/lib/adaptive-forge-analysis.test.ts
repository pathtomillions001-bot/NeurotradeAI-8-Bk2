import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { binaryEntropy, evaluateAdaptive, hasChangePoint, recoveryAllowed, wilsonLowerBound } from "./adaptive-forge-analysis";

const tape = (wins: number, losses: number) => [
  ...Array.from({ length: wins }, () => ({ outcome: "win" as const })),
  ...Array.from({ length: losses }, () => ({ outcome: "loss" as const })),
];

describe("adaptive forge analysis", () => {
  test("shrinks small samples toward fair probability", () => {
    const reading = evaluateAdaptive({ observations: tape(4, 1), payout: 1, minimumSample: 1 });
    assert.ok(reading.posteriorProbability < 0.7);
    assert.equal(reading.eligible, false);
  });
  test("detects distribution changes and blocks the gate", () => {
    const observations = [...tape(2, 22), ...tape(22, 2)];
    assert.equal(hasChangePoint(observations), true);
    assert.equal(evaluateAdaptive({ observations, payout: 1 }).changePoint, true);
  });
  test("requires payout edge, not just a high raw win rate", () => {
    const reading = evaluateAdaptive({ observations: tape(40, 10), payout: 0.2, minimumSample: 1 });
    assert.ok(Math.abs(reading.breakEvenProbability - 1 / 1.2) < 0.0001);
    assert.equal(reading.eligible, false);
  });
  test("exposes stable entropy and conservative confidence math", () => {
    assert.ok(Math.abs(binaryEntropy(50, 50) - 1) < 0.0001);
    assert.equal(binaryEntropy(100, 0), 0);
    assert.equal(wilsonLowerBound(0, 0), 0);
  });
  test("recovery never bypasses the normal quality gate", () => {
    const reading = evaluateAdaptive({ observations: tape(35, 5), payout: 1, minimumSample: 1 });
    assert.equal(recoveryAllowed(reading, 1, 2), false);
    assert.equal(recoveryAllowed(reading, 3, 2), false);
  });
});
