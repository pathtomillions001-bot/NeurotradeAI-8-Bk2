/**
 * Regression: the autonomous engine must record a LOSS with the payout quoted
 * at entry, exactly as the NeuroAI FAB and the specialist bots do. Recording it
 * with 1 erased the lost normal trade's target profit, so the first recovery
 * stake was smaller than the shared ladder's.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ledgerEntryPayout } from "./ledger";
import { createRecoveryState, reduceRecoveryOutcome } from "../agents/recovery-engine";
import { calculateRecoveryStakeRequest } from "../recovery-math";

function firstRecoveryStake(lossPayout: number, contract = "DIGITEVEN"): number {
  const afterLoss = reduceRecoveryOutcome(createRecoveryState(), false, -1, 1, 3, contract, lossPayout);
  return calculateRecoveryStakeRequest({
    unrecoveredAmount: afterLoss.unrecoveredAmount,
    remainingTargetProfit: afterLoss.remainingTargetProfit,
    payoutMultiplier: 1.95,
    baseStake: 1,
    recoveryAutoMode: true,
    recoveryMethod: "instant",
    recoveryMultiplier: 1.62,
    recoveryStep: 1,
    maxRecoverySteps: 3,
  });
}

describe("autonomous ledger entry payout", () => {
  it("uses the quoted entry payout when one is stored", () => {
    assert.equal(ledgerEntryPayout(1.953, "DIGITEVEN", null), 1.953);
  });

  it("falls back to the canonical schedule, never to 1, when no quote is stored", () => {
    assert.equal(ledgerEntryPayout(null, "DIGITEVEN", null), 1.95);
    assert.equal(ledgerEntryPayout(undefined, "CALL", null), 1.92);
    assert.equal(ledgerEntryPayout(Number.NaN, "DIGITOVER", 1), 1.23);
    assert.equal(ledgerEntryPayout(0.5, "DIGITEVEN", null), 1.95);
  });

  it("keeps the lost normal trade's target profit when the loss carries the entry quote", () => {
    const afterLoss = reduceRecoveryOutcome(createRecoveryState(), false, -1, 1, 3, "DIGITEVEN", 1.95);
    assert.equal(afterLoss.targetProfit, 0.95);
    assert.equal(afterLoss.remainingTargetProfit, 0.95);
    assert.equal(afterLoss.unrecoveredAmount, 1);
  });

  it("the regression: recording a loss with payout 1 erases the target", () => {
    const broken = reduceRecoveryOutcome(createRecoveryState(), false, -1, 1, 3, "DIGITEVEN", 1);
    assert.equal(broken.targetProfit, 0);
  });

  it("the first recovery stake matches the shared ladder (debt + target) / (payout − 1)", () => {
    // ($1 debt + $0.95 target) / 0.95 ≈ 2.0526 — the broken path gave ($1 debt) / 0.95 ≈ 1.0526.
    assert.ok(Math.abs(firstRecoveryStake(1.95) - 1.95 / 0.95) < 1e-9);
    assert.ok(Math.abs(firstRecoveryStake(1) - 1 / 0.95) < 1e-9);
  });

  it("the entry quote carries through the ledger for every contract family", () => {
    for (const contract of ["DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF", "CALL", "PUT"]) {
      const payout = ledgerEntryPayout(null, contract, null);
      assert.ok(payout > 1, `${contract} fallback payout must exceed 1`);
      const afterLoss = reduceRecoveryOutcome(createRecoveryState(), false, -1, 1, 3, contract, payout);
      assert.ok(afterLoss.targetProfit > 0, `${contract} loss must keep a target profit`);
    }
  });
});
