/**
 * WP4 — adaptive ladder, headroom cap and recovery budget (unit tests).
 *
 * Pins the pure math: stake clamps, λ soft descent, headroom cap, rebase
 * triggers, and the rebase reducer semantics (debt → 0, ladder restarts at
 * base stake, true loss run preserved).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAdaptiveStake,
  descentScale,
  adaptiveDebtAfter,
} from "./autonomous-hedge/adaptive-stake";
import { computeRecoveryHeadroom } from "./autonomous-hedge/recovery-headroom";
import {
  reduceRecoveryRebase,
  createRecoveryState,
  reduceRecoveryOutcome,
} from "./agents/recovery-engine";

const base = {
  debt: 10,
  baseStake: 1,
  payout: 1.95,
  lambda: 0.5,
  headroomCap: 100,
  budgetBase: 25,
};

test("adaptive: λ=1 stakes the exact one-win clearance (T′ = 0)", () => {
  const r = computeAdaptiveStake({ ...base, lambda: 1 });
  // exact = 10 / 0.95 = 10.526…; win repays the full debt.
  assert.ok(Math.abs(r.stake - 10 / 0.95) < 1e-9);
  assert.equal(r.partial, false);
  assert.ok(Math.abs(r.winRepayment - 10) < 1e-9);
});

test("adaptive: λ=0.5 halves the exact stake but never undercuts the base floor", () => {
  const r = computeAdaptiveStake(base);
  assert.ok(Math.abs(r.stake - 0.5 * (10 / 0.95)) < 1e-9);
  // A win repays half the debt — progress without a one-win promise.
  assert.ok(Math.abs(r.winRepayment - 5) < 1e-9);
  const tiny = computeAdaptiveStake({ ...base, debt: 0.4 });
  // Debt below one base-stake profit: stake the exact amount, never more.
  assert.ok(Math.abs(tiny.stake - 0.4 / 0.95) < 1e-9);
});

test("adaptive: min-stake clamp applies", () => {
  const r = computeAdaptiveStake({ ...base, debt: 0.1, baseStake: 0.2, lambda: 0.1 });
  assert.equal(r.stake, 0.35);
});

test("adaptive: headroomCap truncates the stake and marks it partial", () => {
  const r = computeAdaptiveStake({ ...base, headroomCap: 2 });
  assert.equal(r.stake, 2);
  assert.equal(r.partial, true);
});

test("adaptive: debt at/over budget re-bases instead of staking", () => {
  const at = computeAdaptiveStake({ ...base, debt: 25, headroomCap: 1000 });
  assert.equal(at.rebaseBudget, true);
  assert.equal(at.stake, 0);
  const over = computeAdaptiveStake({ ...base, debt: 40, headroomCap: 1000 });
  assert.equal(over.rebaseBudget, true);
  const below = computeAdaptiveStake({ ...base, debt: 24.99, headroomCap: 1000 });
  assert.equal(below.rebaseBudget, false);
});

test("adaptive: headroom too small for even the base stake re-bases", () => {
  const r = computeAdaptiveStake({ ...base, debt: 5, headroomCap: 0.5 });
  assert.equal(r.rebaseHeadroom, true);
  assert.equal(r.stake, 0);
});

test("adaptive: soft descent zeroes λ growth in the top half of the budget", () => {
  assert.equal(descentScale(10, 25), 1);   // ≤ 50% of budget
  assert.equal(descentScale(12.5, 25), 1); // exactly half
  assert.ok(Math.abs(descentScale(18.75, 25) - 0.5) < 1e-9);
  assert.equal(descentScale(25, 25), 0);
  // At 75% of budget the stake stops growing with λ halved.
  const r = computeAdaptiveStake({ ...base, debt: 18.75, headroomCap: 1000 });
  assert.ok(Math.abs(r.lambdaEffective - 0.25) < 1e-9);
});

test("adaptiveDebtAfter: win shrinks debt by stake·(payout−1), loss adds stake", () => {
  assert.ok(Math.abs(adaptiveDebtAfter(10, 2, 1.95, true) - 8.1) < 1e-9);
  assert.equal(adaptiveDebtAfter(10, 2, 1.95, false), 12);
  assert.equal(adaptiveDebtAfter(1, 2, 1.95, true), 0); // never negative
});

test("headroom: fresh account caps a stake at φ·balance, bounded by the DD limit", () => {
  const h = computeRecoveryHeadroom({
    balance: 200, dailyProfit: 0, maxDrawdownPct: 10, headroomPct: 5,
  });
  // limit = 20, headroom = 20, cap = min(0.05·200, 20) = 10.
  assert.equal(h.drawdownLimit, 20);
  assert.equal(h.drawdownHeadroom, 20);
  assert.equal(h.headroomCap, 10);
});

test("headroom: consumed drawdown shrinks the cap; at the limit it is zero", () => {
  const mid = computeRecoveryHeadroom({
    balance: 190, dailyProfit: -10, maxDrawdownPct: 10, headroomPct: 5,
  });
  // peak 200, used 10, headroom 10 → cap = min(0.05·190, 10) = 9.5
  assert.equal(mid.peakBalance, 200);
  assert.equal(mid.drawdownUsed, 10);
  assert.equal(mid.headroomCap, 9.5);
  const atLimit = computeRecoveryHeadroom({
    balance: 180, dailyProfit: -20, maxDrawdownPct: 10, headroomPct: 5,
  });
  assert.equal(atLimit.drawdownHeadroom, 0);
  assert.equal(atLimit.headroomCap, 0);
});

test("headroom: reserve reduces the balance side of the cap", () => {
  const h = computeRecoveryHeadroom({
    balance: 200, dailyProfit: 0, maxDrawdownPct: 50, headroomPct: 5, reserve: 150,
  });
  // headroom = 100 (big), cap = 0.05·min(200−150, 100) = 2.5
  assert.equal(h.headroomCap, 2.5);
});

test("rebase reducer: zeroes debt and exits recovery, keeps base stake and true run", () => {
  let s = createRecoveryState();
  s.baseStake = 2.5;
  // Two losses into recovery: debt 5.94 (2·1.62·stake ladder semantics aside).
  s = reduceRecoveryOutcome(s, false, -2.5, 2.5, 3, "DIGITEVEN", 1.95);
  s = reduceRecoveryOutcome(s, false, -3.44, 3.44, 3, "DIGITEVEN", 1.95);
  assert.equal(s.inRecovery, true);
  assert.ok(s.unrecoveredAmount > 0);
  assert.ok((s.trueLossRun ?? 0) >= 2);
  const rebased = reduceRecoveryRebase(s);
  assert.equal(rebased.inRecovery, false);
  assert.equal(rebased.unrecoveredAmount, 0);
  assert.equal(rebased.recoveryStep, 0);
  assert.equal(rebased.baseStake, 2.5);
  assert.equal(rebased.trueLossRun, s.trueLossRun); // a rebase is a loss, not a win
});
