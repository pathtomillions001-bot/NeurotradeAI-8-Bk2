/**
 * WP1 — truthful counters and telemetry.
 *
 * Pins the counter defects D6 fixes:
 *  - trueLossRun counts every consecutive settled loss and is reset ONLY by a
 *    win — a cooldown auto-resume (the seedState(...streakLossCount: 0) path)
 *    can never hide it;
 *  - recoveryDepth is uncapped while recoveryStep stays capped for legacy
 *    staking, so escalation can reach the risk weight's documented cap (1.5);
 *  - the size-down option halves exposure per loss beyond the limit instead of
 *    pausing; it never weakens another hard stop.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRecoveryState,
  reduceRecoveryOutcome,
  loadState,
  getState,
  setPersistenceSession,
  type RecoveryState,
} from "./agents/recovery-engine";
import { recoveryEscalation, recoveryRiskWeight } from "./autonomous-hedge/recovery-risk";
import { sizeDownMultiplier } from "./autonomous-hedge/cycle";

/** Simulate a cooldown auto-resume exactly as routes/ai.ts does it. */
function cooldownResume(state: RecoveryState): RecoveryState {
  return { ...state, streakLossCount: 0 };
}

describe("WP1 truthful counters", () => {
  it("trueLossRun survives cooldown resumes; streakLossCount does not", () => {
    setPersistenceSession("wp1-test");
    let s = createRecoveryState();
    // Five losses in a row.
    for (let i = 0; i < 5; i++) {
      s = reduceRecoveryOutcome(s, false, -1, 1, 3, "DIGITEVEN", 1.95);
    }
    assert.equal(s.streakLossCount, 5);
    assert.equal(s.trueLossRun, 5);

    // Cooldown fires and auto-resumes: the gate counter resets…
    s = cooldownResume(s);
    assert.equal(s.streakLossCount, 0, "legacy gate counter resets on cooldown");
    assert.equal(s.trueLossRun, 5, "the TRUE run must survive the cooldown");

    // …and the next loss keeps counting from 6, not from 1.
    s = reduceRecoveryOutcome(s, false, -1, 1, 3, "DIGITEVEN", 1.95);
    assert.equal(s.trueLossRun, 6, "losses after a cooldown extend the true run");
    assert.equal(s.streakLossCount, 1);

    // Only a win resets it.
    s = reduceRecoveryOutcome(s, true, 5, 5.13, 3, "DIGITEVEN", 1.95);
    assert.equal(s.trueLossRun, 0, "a win is the ONLY reset");
  });

  it("recoveryDepth is uncapped while recoveryStep stays capped (legacy staking unchanged)", () => {
    setPersistenceSession("wp1-test-depth");
    let s = createRecoveryState();
    for (let i = 0; i < 10; i++) {
      s = reduceRecoveryOutcome(s, false, -1, 1, 3, "DIGITEVEN", 1.95);
    }
    assert.equal(s.recoveryStep, 3, "recoveryStep saturates at maxRecoverySteps (pinned invariant)");
    assert.equal(s.recoveryDepth, 10, "recoveryDepth reports the true episode depth");
    assert.equal(s.trueLossRun, 10);
  });

  it("escalation reaches the documented risk-weight cap on long runs", () => {
    // Before WP1: escalation = max(cooldown-reset streak, capped step) ≤ 3,
    // so the weight never left 1.25 although the design documents 1.5.
    const legacyEscalation = recoveryEscalation(0, 3);
    assert.ok(recoveryRiskWeight(legacyEscalation) <= 1.25 + 1e-9);
    // After WP1: the truthful counters feed the escalation.
    const truthfulEscalation = recoveryEscalation(10, 10);
    assert.equal(truthfulEscalation, 10);
    assert.ok(Math.abs(recoveryRiskWeight(truthfulEscalation) - 1.5) < 1e-9, "the documented cap 1 + riskWeightMax");
  });

  it("state round-trips through persistence hydration", () => {
    setPersistenceSession("wp1-test-hydrate");
    let s = createRecoveryState();
    s = reduceRecoveryOutcome(s, false, -1, 1, 3, "DIGITEVEN", 1.95);
    s = reduceRecoveryOutcome(s, false, -1, 1, 3, "DIGITEVEN", 1.95);
    // Simulate serialize → hydrate on a fresh process (loadState replaces state).
    loadState(JSON.stringify(s));
    const hydrated = getState();
    assert.equal(hydrated.trueLossRun, 2, "trueLossRun survives a restart");
    assert.equal(hydrated.recoveryDepth, 2, "recoveryDepth survives a restart");
    // A pre-WP1 row (fields absent) hydrates with zero counters, not NaN.
    const legacyJson = JSON.stringify({ inRecovery: true, recoveryStep: 1, unrecoveredAmount: 1, baseStake: 1, streakLossCount: 1, streakStartAmount: 1, targetProfit: 0.95, remainingTargetProfit: 0.95, originPayoutMultiplier: 1.95, resetDate: new Date().toISOString().slice(0, 10), recoveryStartedAt: 0 });
    loadState(legacyJson);
    const legacy = getState();
    assert.equal(legacy.trueLossRun, 0, "pre-WP1 rows start the counters at zero");
    assert.equal(legacy.recoveryDepth, 0);
  });

  it("sizeDownMultiplier halves per loss at and beyond the limit, never below zero", () => {
    assert.equal(sizeDownMultiplier(0, 4), 1);
    assert.equal(sizeDownMultiplier(3, 4), 1, "below the limit: full exposure");
    assert.equal(sizeDownMultiplier(4, 4), 0.5, "at the limit: half");
    assert.equal(sizeDownMultiplier(5, 4), 0.25);
    assert.equal(sizeDownMultiplier(10, 4), Math.pow(0.5, 7));
    assert.ok(sizeDownMultiplier(1000, 4) > 0, "never zero — the floor is the min stake");
  });

  it("a clearing win exits recovery and breaks the true run", () => {
    setPersistenceSession("wp1-test-normal-win");
    let s = createRecoveryState();
    s = reduceRecoveryOutcome(s, false, -1, 1, 3, "DIGITEVEN", 1.95);
    // A win whose net profit (1.05) covers the $1 debt clears recovery.
    s = reduceRecoveryOutcome(s, true, 1.05, 1.11, 3, "DIGITEVEN", 1.95);
    assert.equal(s.inRecovery, false);
    assert.equal(s.trueLossRun, 0);
    // Loss → win → loss: the run restarts at 1.
    s = reduceRecoveryOutcome(s, false, -1, 1, 3, "DIGITEVEN", 1.95);
    assert.equal(s.trueLossRun, 1);
  });
});
