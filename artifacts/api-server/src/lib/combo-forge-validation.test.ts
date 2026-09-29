/**
 * Small-scale version of the Combo Forge validation harness (the full 10⁶-tick
 * report lives in validation/combo-forge-validation.md and is regenerated with
 * `npx tsx src/lib/combo-forge-validation.ts --report`). This guards the three
 * properties the console promises, in seconds, on every test run.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  loadValidationRuntime,
  comboGate,
  omniGate,
  runNull,
  runPower,
  runLadderSessions,
  ladderStake,
  marginOf,
} from "./combo-forge-validation";
import type { ComboSpec } from "./combo-forge-analysis";

const SET: ComboSpec[] = [
  { type: "DIGITOVER", digit: 1 },
  { type: "DIGITUNDER", digit: 8 },
  { type: "DIGITEVEN", digit: -1 },
  { type: "DIGITODD", digit: -1 },
  { type: "CALL", digit: -1 },
  { type: "PUT", digit: -1 },
];
const DIGITS = SET.filter((s) => s.type !== "CALL" && s.type !== "PUT");

describe("combo-forge validation (small scale)", () => {
  before(async () => { await loadValidationRuntime(); });

  it("NULL: strict and balanced never fire more often than their nominal α on i.i.d. ticks", () => {
    const cfg = { markets: 4, ticks: 40_000, every: 100, window: 500, seed: 2024 };
    const strict = runNull("strict", comboGate(SET, { strictness: "strict", window: 500 }), cfg);
    const balanced = runNull("balanced", comboGate(SET, { strictness: "balanced", window: 500 }), cfg);
    assert.ok(strict.fireRateUpper95 <= 0.05 + 0.06, `strict fire rate ${strict.fireRate}`);
    assert.ok(strict.fireRate <= 0.05, `strict fire rate ${strict.fireRate} exceeds α=5%`);
    assert.ok(balanced.fireRate <= 0.25, `balanced fire rate ${balanced.fireRate} exceeds α=25%`);
  });

  it("NULL: Always-mode P&L equals −margin within sampling error (no hidden edge or leak)", () => {
    const r = runNull("always", comboGate(SET, { strictness: "always", window: 200 }), { markets: 3, ticks: 40_000, every: 20, window: 200, seed: 77 });
    assert.ok(r.trades > 1000);
    assert.ok(Math.abs(r.zScore) < 3.5, `z=${r.zScore}`);
    assert.ok(r.expectedReturnPerDollar < 0 && r.expectedReturnPerDollar > -0.05);
  });

  it("NULL: Omni's gate fires on a fair tape far more often than Combo strict (head-to-head)", () => {
    const cfg = { markets: 4, ticks: 30_000, every: 100, window: 500, seed: 11 };
    const combo = runNull("combo", comboGate(DIGITS, { strictness: "strict", window: 500 }), cfg);
    const omni = runNull("omni", omniGate(DIGITS, { window: 120 }), cfg);
    assert.ok(omni.fireRate > 0.4, `omni ${omni.fireRate}`);
    assert.ok(combo.fireRate < 0.05, `combo ${combo.fireRate}`);
  });

  it("POWER: a +10-point planted edge is found within 1000 ticks on (nearly) every replicate, on the right contract", () => {
    const target: ComboSpec = { type: "DIGITOVER", digit: 1 };
    const r = runPower("strict", (w) => comboGate(SET, { strictness: "strict", window: Math.min(1000, w) }), target, 0.1, {
      replicates: 12, seed: 5, markets: 3, maxTicks: 1000, minTicks: 100, every: 50, windowFor: (t) => t,
    });
    assert.ok(r.detectedWithin1000 >= 0.9, `detected ${r.detectedWithin1000}`);
    assert.equal(r.falseContractFires, 0);
    assert.ok(r.medianTicksToDetect !== null && r.medianTicksToDetect <= 500);
  });

  it("LADDER: stake math is the shared formula and sessions on a fair tape lose ≈ margin per $ staked", () => {
    assert.equal(ladderStake(0.5, 1.92, 10, 500, 1000), 0.6);
    assert.equal(ladderStake(1.1, 1.92, 10, 500, 1000), 1.32);
    assert.equal(ladderStake(0.01, 1.95, 10, 500, 1000), 0.35);
    assert.ok(ladderStake(9999, 1.95, 10, 500, 100000) === 500);
    assert.ok(ladderStake(300, 1.23, 10, 10000, 50) <= 50);
    const r = runLadderSessions({
      normal: SET, recovery: [{ type: "DIGITEVEN", digit: -1 }, { type: "DIGITOVER", digit: 4 }], strictness: "always",
      sessions: 20, markets: 3, seed: 3, stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, breakerDepth: 6,
      window: 200, recoveryPatience: 20, normalPatience: 1, maxTicks: 1200, waitStep: 10,
    });
    assert.ok(r.trades > 100);
    assert.ok(Math.abs(r.zScore) < 3.5, `z=${r.zScore}`);
    assert.ok(r.minStakeSeen >= 0.35 && r.maxStakeSeen <= 500);
    assert.ok(marginOf({ type: "CALL", digit: -1 }) > marginOf({ type: "DIGITOVER", digit: 1 }));
  });
});
