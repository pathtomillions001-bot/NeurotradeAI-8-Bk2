/**
 * Recovery parity: the specialist AI bots must recover EXACTLY like the main
 * autonomous engine and the NeuroAI Quantum FAB.
 *
 * Reported divergence: a $1.00 loss recovered in Matches opened a $0.35 stake
 * in the main app / FAB, but $1.13 in the AI Bot Arena. Root cause was the
 * aspirational target profit — it was derived from the LOSING contract's
 * payout, and a Matches bot's normal trade is itself an 8.93× contract, so the
 * recovery stake ballooned ~9×. The target is now capped at one base stake
 * (recovery-math.recoveryTargetProfitFor), which makes recovery debt-driven and
 * identical for every engine and every contract family.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as recoveryEngine from "./agents/recovery-engine.ts";
import { recordRecoveryOutcome, type SpeedRecoveryState } from "./speed-recovery-state.ts";
import { recoveryTargetProfitFor, calculateRecoveryStakeRequest } from "./recovery-math.ts";
import {
  MATCH_PAYOUT, DIFF_PAYOUT, EVEN_ODD_PAYOUT, RISE_FALL_PAYOUT, OVER_PAYOUTS, UNDER_PAYOUTS,
} from "./payouts.ts";

const MAX_STEPS = 3;
const BASE_STAKE = 1;

function emptyFab(): SpeedRecoveryState {
  return {
    inRecovery: false,
    recoveryStep: 0,
    unrecoveredAmount: 0,
    baseStake: 0,
    targetProfit: 0,
    remainingTargetProfit: 0,
    originPayoutMultiplier: 1,
    consecutiveRecoveryLosses: 0,
    recentRecoveryTrades: [],
  };
}

/** Stake the shared ledger returns for the next recovery attempt. */
function nextStake(payout: number, method: "split" | "instant" = "instant"): number {
  return recoveryEngine.getDynamicRecoveryStake(
    BASE_STAKE, 500, Number.POSITIVE_INFINITY, payout, 0.5,
    "moderate", 1.62, method, MAX_STEPS, true,
  );
}

describe("bot ↔ main-app recovery parity", () => {
  beforeEach(() => recoveryEngine.resetAll());

  it("a $1 Matches loss is recovered with a $0.35 Matches stake (was $1.13)", () => {
    const state = recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITMATCH", MATCH_PAYOUT);
    assert.equal(state.unrecoveredAmount, 1);
    assert.equal(state.remainingTargetProfit, 1); // capped at one base stake
    assert.equal(nextStake(MATCH_PAYOUT, "instant"), 0.35);
    assert.equal(nextStake(MATCH_PAYOUT, "split"), 0.35);
  });

  it("main-app path (DIFF loss → Matches recovery) is unchanged at $0.35", () => {
    const state = recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITDIFF", DIFF_PAYOUT);
    assert.equal(state.remainingTargetProfit, 0.09); // 1 × (1.09 − 1), below the cap
    assert.equal(nextStake(MATCH_PAYOUT, "instant"), 0.35);
  });

  it("the same $1 debt produces the same stake regardless of which family lost it", () => {
    const recoveryPayout = MATCH_PAYOUT;
    const stakes = [
      ["DIGITMATCH", MATCH_PAYOUT],
      ["DIGITDIFF", DIFF_PAYOUT],
      ["DIGITEVEN", EVEN_ODD_PAYOUT],
      ["DIGITODD", EVEN_ODD_PAYOUT],
      ["CALL", RISE_FALL_PAYOUT],
      ["PUT", RISE_FALL_PAYOUT],
      ["DIGITOVER", OVER_PAYOUTS[8]!],
      ["DIGITUNDER", UNDER_PAYOUTS[1]!],
    ].map(([contractType, payout]) => {
      recoveryEngine.resetAll();
      recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, contractType as string, payout as number);
      return nextStake(recoveryPayout, "instant");
    });

    assert.deepEqual(stakes, stakes.map(() => 0.35));
  });

  it("every bot family sizes its own in-family recovery off the debt, not the origin payout", () => {
    // Uncapped, a Matches bot needed 1.13 and an Over-8 bot 1.13 as well; both
    // now size purely from the $1 debt plus one base stake of target.
    const perFamily = [
      ["DIGITEVEN", EVEN_ODD_PAYOUT, 2.06],  // (1 + 0.95) / 0.95 — target below the cap
      ["CALL", RISE_FALL_PAYOUT, 2.09],      // (1 + 0.92) / 0.92 — target below the cap
      ["DIGITMATCH", MATCH_PAYOUT, 0.35],    // (1 + 1) / 7.93 → below the $0.35 floor
      ["DIGITOVER", OVER_PAYOUTS[8]!, 0.35], // (1 + 1) / 7.93 → below the $0.35 floor
    ] as const;

    for (const [contractType, payout, expected] of perFamily) {
      recoveryEngine.resetAll();
      recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, contractType, payout);
      assert.equal(nextStake(payout, "instant"), expected, `${contractType} instant recovery stake`);
    }
  });

  it("the FAB ledger records the identical capped target", () => {
    const fab = recordRecoveryOutcome(emptyFab(), false, -1, 1, MAX_STEPS, MATCH_PAYOUT);
    const shared = recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITMATCH", MATCH_PAYOUT);
    assert.equal(fab.targetProfit, shared.targetProfit);
    assert.equal(fab.remainingTargetProfit, shared.remainingTargetProfit);
    assert.equal(fab.unrecoveredAmount, shared.unrecoveredAmount);
  });

  it("target profit is capped at one base stake and never negative", () => {
    assert.equal(recoveryTargetProfitFor(1, MATCH_PAYOUT), 1);
    assert.equal(recoveryTargetProfitFor(1, DIFF_PAYOUT), 0.09);
    assert.equal(recoveryTargetProfitFor(0.35, EVEN_ODD_PAYOUT), 0.33);
    assert.equal(recoveryTargetProfitFor(1, 0.5), 0);
    assert.equal(recoveryTargetProfitFor(-1, MATCH_PAYOUT), 0);
  });

  it("split mode still caps each attempt at one base stake for every family", () => {
    recoveryEngine.resetAll();
    recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITEVEN", EVEN_ODD_PAYOUT);
    assert.equal(nextStake(EVEN_ODD_PAYOUT, "split"), 1);
    assert.equal(
      calculateRecoveryStakeRequest({
        unrecoveredAmount: 1,
        remainingTargetProfit: 1,
        payoutMultiplier: EVEN_ODD_PAYOUT,
        baseStake: BASE_STAKE,
        recoveryAutoMode: true,
        recoveryMethod: "split",
        recoveryMultiplier: 1.62,
        recoveryStep: 1,
        maxRecoverySteps: MAX_STEPS,
      }),
      1,
    );
  });
});
