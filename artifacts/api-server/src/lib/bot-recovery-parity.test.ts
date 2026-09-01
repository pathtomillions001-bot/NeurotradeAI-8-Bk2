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
import {
  recoveryTargetProfitFor,
  calculateRecoveryStakeRequest,
  calculateBotRecoveryStake,
} from "./recovery-math.ts";
import { getLocalTodayKey } from "./tz.ts";
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

  it("a pre-cap persisted target is re-capped on load (no $1.13 Matches stake after a restart)", () => {
    recoveryEngine.resetAll();
    // Simulate a row persisted before the one-base-stake cap: a $1 Matches loss
    // recorded an aspirational target of 1 × (8.93 − 1) = $7.93.
    const stale = JSON.stringify({
      inRecovery: true,
      recoveryStep: 1,
      unrecoveredAmount: 1,
      baseStake: 1,
      streakLossCount: 1,
      streakStartAmount: 1,
      targetProfit: 7.93,
      remainingTargetProfit: 7.93,
      originPayoutMultiplier: MATCH_PAYOUT,
      resetDate: getLocalTodayKey(),
      consecutiveMatchLosses: 0,
    });
    recoveryEngine.loadState(stale);

    const state = recoveryEngine.getState();
    assert.equal(state.targetProfit, 1);
    assert.equal(state.remainingTargetProfit, 1);
    // Instant mode is where the uncapped target used to surface as $1.13.
    assert.equal(nextStake(MATCH_PAYOUT, "instant"), 0.35);
    assert.equal(nextStake(MATCH_PAYOUT, "split"), 0.35);
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

// ── Bot-specific conservative recovery (10 % markup on debt) ─────────────────
//
// The five specialist AI bots use `getBotRecoveryStake` instead of the shared
// `getDynamicRecoveryStake`.  The shared formula targets debt + aspirational
// target-profit (derived from the losing contract's payout), which for bots
// over-exposes capital.  The bot formula sizes the stake so a single win
// recovers all debt + 10 % of debt as profit.
//
// Example: Even/Odd bot, $1 stake, payout 1.95×
//   Shared:  (1 + 0.95) / 0.95 = $2.06  → win $1.96 on a $1 loss ❌
//   Bot:     (1 × 1.10) / 0.95 = $1.16  → win $1.10 on a $1 loss ✓

/** Bot-specific recovery stake via the shared ledger. */
function botNextStake(payout: number): number {
  return recoveryEngine.getBotRecoveryStake(
    BASE_STAKE, 500, Number.POSITIVE_INFINITY, payout,
  );
}

describe("bot-specific recovery (10 % markup)", () => {
  beforeEach(() => recoveryEngine.resetAll());

  it("calculateBotRecoveryStake: $1 debt, 1.95× payout → $1.16", () => {
    // (1 × 1.10) / 0.95 = 1.157… → rounded up by applyRecoveryStakeLimits
    const raw = calculateBotRecoveryStake(1, EVEN_ODD_PAYOUT);
    assert.ok(Math.abs(raw - 1.1579) < 0.001, `raw ${raw}`);
  });

  it("Even/Odd bot: $1 loss → recovery stake ~$1.16 (not $2.06)", () => {
    recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITEVEN", EVEN_ODD_PAYOUT);
    const stake = botNextStake(EVEN_ODD_PAYOUT);
    // 1.10 / 0.95 = 1.1579… → ceil to $1.16
    assert.equal(stake, 1.16);
    // Verify the shared engine would have given $2.06 (the old behaviour)
    const sharedStake = recoveryEngine.getDynamicRecoveryStake(
      BASE_STAKE, 500, Number.POSITIVE_INFINITY, EVEN_ODD_PAYOUT, 0.5,
      "moderate", 1.62, "instant", MAX_STEPS, true,
    );
    assert.equal(sharedStake, 2.06);
  });

  it("Over/Under bot (over 5, payout 2.43×): $1 loss → ~$0.77", () => {
    recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITOVER", OVER_PAYOUTS[5]!);
    const stake = botNextStake(OVER_PAYOUTS[5]!);
    // 1.10 / 1.43 = 0.7692… → ceil to $0.77
    assert.equal(stake, 0.77);
  });

  it("Over/Under two consecutive losses compound correctly", () => {
    // Loss 1: $1
    recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITOVER", OVER_PAYOUTS[5]!);
    assert.equal(botNextStake(OVER_PAYOUTS[5]!), 0.77);

    // Loss 2: $0.77 → unrecoveredAmount = $1.77
    recoveryEngine.recordOutcome(false, -0.77, 0.77, MAX_STEPS, "DIGITOVER", OVER_PAYOUTS[5]!);
    const stake = botNextStake(OVER_PAYOUTS[5]!);
    // 1.77 × 1.10 / 1.43 = 1.947 / 1.43 = 1.3615… → ceil to $1.37
    assert.equal(stake, 1.37);
  });

  it("Matches bot: $1 loss → $0.35 floor (payout so high the formula undershoots)", () => {
    recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITMATCH", MATCH_PAYOUT);
    const stake = botNextStake(MATCH_PAYOUT);
    // 1.10 / 7.93 = 0.1387… → clamped to $0.35 minimum
    assert.equal(stake, 0.35);
  });

  it("Differs bot: $1 loss → $12.22 (low payout requires large stake)", () => {
    recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITDIFF", DIFF_PAYOUT);
    const stake = botNextStake(DIFF_PAYOUT);
    // 1.10 / 0.09 = 12.222… → ceil to $12.23
    assert.equal(stake, 12.23);
  });

  it("Rise/Fall bot: $1 loss → ~$1.17", () => {
    recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "CALL", RISE_FALL_PAYOUT);
    const stake = botNextStake(RISE_FALL_PAYOUT);
    // 1.10 / 0.92 = 1.1956… → ceil to $1.20
    assert.equal(stake, 1.2);
  });

  it("bot recovery win exits recovery normally", () => {
    recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITEVEN", EVEN_ODD_PAYOUT);
    assert.equal(recoveryEngine.isInRecovery(), true);

    // Win with profit $1.10 ≥ $1 debt → recovery complete
    const state = recoveryEngine.recordOutcome(true, 1.10, 1.16, MAX_STEPS, "DIGITEVEN", EVEN_ODD_PAYOUT);
    assert.equal(state.inRecovery, false);
    assert.equal(state.unrecoveredAmount, 0);
  });

  it("bot recovery partial win stays in recovery", () => {
    recoveryEngine.recordOutcome(false, -2, 2, MAX_STEPS, "DIGITEVEN", EVEN_ODD_PAYOUT);
    // Win only $1.50 against $2 debt → partial
    const state = recoveryEngine.recordOutcome(true, 1.50, 2.32, MAX_STEPS, "DIGITEVEN", EVEN_ODD_PAYOUT);
    assert.equal(state.inRecovery, true);
    assert.equal(state.unrecoveredAmount, 0.50);
  });

  it("shared engine is NOT affected by the bot formula", () => {
    recoveryEngine.recordOutcome(false, -1, 1, MAX_STEPS, "DIGITEVEN", EVEN_ODD_PAYOUT);
    // Shared engine still uses the old formula
    const shared = recoveryEngine.getDynamicRecoveryStake(
      BASE_STAKE, 500, Number.POSITIVE_INFINITY, EVEN_ODD_PAYOUT, 0.5,
      "moderate", 1.62, "instant", MAX_STEPS, true,
    );
    assert.equal(shared, 2.06);
    // Bot engine uses the new conservative formula
    const bot = botNextStake(EVEN_ODD_PAYOUT);
    assert.equal(bot, 1.16);
  });
});
