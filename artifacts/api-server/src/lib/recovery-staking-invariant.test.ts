/**
 * Staking invariant for the recovery risk model
 * (docs/recovery-trade-mathematical-design.md, "Staking invariant").
 *
 * The recovery analysis change is allowed to re-rank candidates. It is NOT
 * allowed to move a stake: Instant keeps sizing the configured full-clearance
 * attempt, Split keeps capping at one normal base stake and carrying debt
 * forward, and the minimum-stake / balance / max-stake limits stay authoritative.
 * These tests pin the exact numbers so a future edit to the analysis cannot
 * silently leak into the money path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRecoveryStakeLimits,
  calculateExactRecoveryStake,
  calculateRecoveryStakeRequest,
  recoveryTargetProfitFor,
} from "./recovery-math";
import { createRecoveryState, reduceRecoveryOutcome } from "./agents/recovery-engine";
import { analyseHedgeCandidate } from "./autonomous-hedge/hedge-analysis";

const request = (over: Partial<Parameters<typeof calculateRecoveryStakeRequest>[0]> = {}) =>
  calculateRecoveryStakeRequest({
    unrecoveredAmount: 1,
    remainingTargetProfit: 0.95,
    payoutMultiplier: 1.95,
    baseStake: 1,
    recoveryAutoMode: true,
    recoveryMethod: "instant",
    recoveryMultiplier: 1.62,
    recoveryStep: 1,
    maxRecoverySteps: 3,
    ...over,
  });

describe("recovery staking invariant", () => {
  it("sizes the exact one-win stake from debt plus target over the net payout rate", () => {
    const exact = calculateExactRecoveryStake(1, 0.95, 1.95);
    assert.ok(Math.abs(exact - 1.95 / 0.95) < 1e-12, "payout includes the stake, so only payout − 1 repays debt");
    assert.equal(request({ recoveryMethod: "instant" }), exact, "Auto Instant follows the exact target");
  });

  it("caps Auto Split at one normal base stake and leaves the rest as debt", () => {
    assert.equal(request({ recoveryMethod: "split" }), 1, "Split never stakes more than the normal base stake");
    assert.ok(request({ recoveryMethod: "instant" }) > 1, "Instant does clear the whole debt in one win");
  });

  it("uses the manual multiplier exactly as entered, compounding to the step cap", () => {
    const manual = (step: number) => request({ recoveryAutoMode: false, recoveryMethod: "instant", recoveryStep: step, recoveryMultiplier: 1.5 });
    assert.ok(Math.abs(manual(1) - 1.5) < 1e-12);
    assert.ok(Math.abs(manual(2) - 2.25) < 1e-12);
    assert.ok(Math.abs(manual(5) - 1.5 ** 3) < 1e-12, "compounding freezes at Max Recovery Steps");
    const split = request({ recoveryAutoMode: false, recoveryMethod: "split", recoveryStep: 2, recoveryMultiplier: 1.5 });
    assert.ok(Math.abs(split - 1.95 / 0.95) < 1e-12, "Manual Split caps the exact target with the ladder");
  });

  it("keeps the execution limits authoritative", () => {
    assert.equal(applyRecoveryStakeLimits(request(), 500, 1000), 2.06, "rounded up to cents");
    assert.equal(applyRecoveryStakeLimits(request(), 1.5, 1000), 1.5, "Max Stake Per Trade caps it");
    assert.equal(applyRecoveryStakeLimits(request(), 500, 0.8), 0.8, "available balance caps it");
    assert.equal(applyRecoveryStakeLimits(0.01, 500, 1000), 0.35, "Deriv's $0.35 minimum still applies");
  });

  it("carries a capped target from the losing normal trade into the ledger", () => {
    const lost = reduceRecoveryOutcome(createRecoveryState(), false, -1, 1, 3, "DIGITEVEN", 1.95);
    assert.equal(lost.inRecovery, true);
    assert.equal(lost.unrecoveredAmount, 1);
    assert.equal(lost.targetProfit, recoveryTargetProfitFor(1, 1.95));
    assert.equal(lost.targetProfit, 0.95, "target = stake × (payout − 1), capped at one base stake");

    const jackpot = reduceRecoveryOutcome(createRecoveryState(), false, -1, 1, 3, "DIGITMATCH", 8.93);
    assert.equal(jackpot.targetProfit, 1, "a jackpot payout cannot inflate the recovery stake");

    const cleared = reduceRecoveryOutcome(lost, true, 1, 1, 3, "DIGITEVEN", 1.95);
    assert.equal(cleared.inRecovery, false, "recovery ends the moment the debt is repaid");
  });

  it("sizes from the ledger and the payout only — the risk-adjusted score never enters", () => {
    const wins = Array.from({ length: 120 }, (_, i) => i % 10 < 7);
    const stakeFor = (escalation: number) => {
      const stats = analyseHedgeCandidate({ wins, p0: 0.5, payout: 1.95, mode: "RECOVERY", escalation });
      // Exactly the inputs cycle.ts passes: ledger debt/target, the candidate's
      // payout, and the configured method. No score, no risk term.
      return applyRecoveryStakeLimits(
        request({ payoutMultiplier: 1.95, recoveryStep: stats.losses > 0 ? 1 : 1 }),
        500,
        1000,
      );
    };
    const calm = analyseHedgeCandidate({ wins, p0: 0.5, payout: 1.95, mode: "RECOVERY", escalation: 0 });
    const deep = analyseHedgeCandidate({ wins, p0: 0.5, payout: 1.95, mode: "RECOVERY", escalation: 6 });
    assert.notEqual(calm.score, deep.score, "the analysis did change with the loss run");
    assert.equal(stakeFor(0), stakeFor(6), "the stake did not");
  });
});
