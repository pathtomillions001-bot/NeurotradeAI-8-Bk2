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
  const params: NavigatorParams = { weights: [0.25, 0.25, 0.25, 0.25], tau: 1, normalInitBar: 0 };
  const policy = new NavigatorPolicy(params, contracts.normal, contracts.recovery);
  const digits = Array.from({ length: 80 }, (_, i) => (i * 3 + 7) % 10);
  for (let i = 0; i < digits.length; i++) policy.update(digits, i);
  const first = policy.decideRecovery(digits, digits.length - 1);
  const second = policy.decideRecovery(digits, digits.length - 1);
  assert.equal(first.bar, second.bar);
  assert.equal(first.bar, contracts.recovery.find(c => c.id === first.side?.id)?.fair ?? first.bar);
});
