import test from "node:test";
import assert from "node:assert/strict";
import {
  contractsForPlan,
  NavigatorPolicy,
  validateNavigatorPlan,
  type NavigatorParams,
} from "./overunder-navigator-analysis";

test("Navigator accepts independently selected and same-digit plans", () => {
  const plan = {
    normalOver: 1,
    normalUnder: 8,
    recoveryOver: 6,
    recoveryUnder: 3,
    normalSide: "both" as const,
    recoverySide: "both" as const,
  };
  assert.equal(validateNavigatorPlan(plan), null);
  const contracts = contractsForPlan(plan);
  assert.deepEqual(contracts.normal.map(c => c.label), ["Over 1", "Under 8"]);
  assert.deepEqual(contracts.recovery.map(c => c.label), ["Over 6", "Under 3"]);
  assert.equal(contracts.recovery[0]!.fair, 0.3);

  const same = contractsForPlan({ ...plan, recoveryOver: 1, recoveryUnder: 8 });
  assert.deepEqual(same.recovery.map(c => c.label), ["Over 1", "Under 8"]);
});

test("Navigator recovery bars are contract-specific and do not depend on loss run", () => {
  const plan = {
    normalOver: 1,
    normalUnder: 8,
    recoveryOver: 6,
    recoveryUnder: 3,
    normalSide: "both" as const,
    recoverySide: "both" as const,
  };
  const contracts = contractsForPlan(plan);
  // Legacy-shaped params: 4 classic lenses, the two regime lenses at zero.
  const params: NavigatorParams = {
    weights: [0.25, 0.25, 0.25, 0.25, 0, 0],
    tau: 1,
    normalInitBar: 0,
  };
  const policy = new NavigatorPolicy(params, contracts.normal, contracts.recovery);
  let digits = Array.from({ length: 80 }, (_, i) => (i * 3 + 7) % 10);
  for (let i = 0; i < digits.length; i++) policy.update(digits, i);
  const first = policy.decideRecovery(digits, digits.length - 1);
  const second = policy.decideRecovery(digits, digits.length - 1);
  assert.equal(first.bar, second.bar, "the bar must be a constant across decisions");
  const side = contracts.recovery.find(c => c.id === first.side?.id);
  assert.ok(side, "a recovery side must be chosen");
  // The bar is the payout-aware break-even clamped to [fair, fair + 0.02] —
  // contract-specific (Over 6 and Under 3 differ) and never of the loss run.
  assert.equal(first.bar, NavigatorPolicy.recoveryBarFor(side!));
  assert.ok(first.bar >= side!.fair && first.bar <= side!.fair + 0.02 + 1e-12);
  // Simulate a recovery loss run on the tape — the bar must not move.
  for (let k = 0; k < 5; k++) {
    digits = [...digits, 8]; // hole digit for Under 3
    policy.update(digits, digits.length - 1);
  }
  const after = policy.decideRecovery(digits, digits.length - 1);
  const afterSide = contracts.recovery.find(c => c.id === after.side?.id);
  assert.ok(afterSide, "a recovery side must still be chosen");
  assert.equal(after.bar, NavigatorPolicy.recoveryBarFor(afterSide!));
});

test("Navigator normal valve floors at break-even and reports starvation instead of forcing a trade", () => {
  const plan = {
    normalOver: 1,
    normalUnder: 8,
    recoveryOver: 6,
    recoveryUnder: 3,
    normalSide: "both" as const,
    recoverySide: "both" as const,
  };
  const contracts = contractsForPlan(plan);
  const params: NavigatorParams = {
    weights: [0.25, 0.25, 0.25, 0.25, 0, 0],
    tau: 1,
    normalInitBar: 0.9,
  };
  const policy = new NavigatorPolicy(params, contracts.normal, contracts.recovery);
  const floor = Math.min(...contracts.normal.map(c => NavigatorPolicy.normalBreakEven(c)));
  // A tape that is hostile to BOTH normal sides (Over 1 loses on 0/1, Under 8
  // loses on 8/9): random draws from {0,1,8,9} only, so neither side can get
  // above ~50% however the lenses read it. Pre-fix the valve would sink to 0
  // and eventually "time" a shot here; now it must pin at break-even and
  // flag starvation, never firing below the floor.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const hostile = [0, 1, 8, 9];
  const digits: number[] = [];
  let firedBelowFloor = 0;
  let starvedSeen = false;
  for (let i = 0; i < 1500; i++) {
    digits.push(hostile[Math.floor(rnd() * 4)]!);
    policy.update(digits, i);
    if (i < 40) continue;
    const d = policy.decideNormal(digits, i);
    if (d.ready && (d.read?.p ?? 0) < floor) firedBelowFloor++;
    if (d.starved) starvedSeen = true;
    assert.ok(policy.normalBar >= floor - 1e-12, `bar ${policy.normalBar} sank below floor ${floor}`);
  }
  assert.equal(firedBelowFloor, 0, "must never fire below break-even");
  assert.ok(starvedSeen, "a hostile tape must surface as starvation");
  assert.ok(policy.normalStarved, "the valve should be pinned at the floor by now");
});
