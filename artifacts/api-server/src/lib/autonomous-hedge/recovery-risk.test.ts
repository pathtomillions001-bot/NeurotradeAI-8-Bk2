import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalCdf,
  posteriorEdgeProbability,
  posteriorVariance,
  recoveryEscalation,
  recoveryRiskWeight,
  threeLossRunRisk,
} from "./recovery-risk";
import { HEDGE_LIMITS } from "./constants";

describe("recovery risk mathematics", () => {
  it("computes a standard normal CDF", () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
    assert.ok(Math.abs(normalCdf(1.282) - 0.9) < 5e-4, "z=1.282 is the 90th percentile");
    assert.ok(Math.abs(normalCdf(-1.282) - 0.1) < 5e-4, "the CDF is symmetric");
    assert.ok(normalCdf(3) > normalCdf(2), "monotonic in z");
    assert.ok(normalCdf(-40) >= 0 && normalCdf(40) <= 1, "bounded to a probability");
  });

  it("returns 0.5 when the posterior mean sits exactly on break-even", () => {
    const atBreakEven = posteriorEdgeProbability({
      probability: 1 / 1.95,
      samples: 120,
      priorStrength: HEDGE_LIMITS.priorStrength,
      breakEven: 1 / 1.95,
    });
    assert.ok(Math.abs(atBreakEven - 0.5) < 1e-9);
  });

  it("grows with the edge and with the evidence behind it", () => {
    const weak = posteriorEdgeProbability({ probability: 0.56, samples: 30, priorStrength: 20, breakEven: 0.5128 });
    const strong = posteriorEdgeProbability({ probability: 0.75, samples: 30, priorStrength: 20, breakEven: 0.5128 });
    const deeper = posteriorEdgeProbability({ probability: 0.56, samples: 600, priorStrength: 20, breakEven: 0.5128 });
    assert.ok(strong > weak, "a bigger edge is more likely to be real");
    assert.ok(deeper > weak, "the same edge is more convincing with more samples");
    assert.ok(weak > 0 && weak < 1);
  });

  it("shrinks the posterior variance as the tape grows", () => {
    const short = posteriorVariance(0.6, 40, HEDGE_LIMITS.priorStrength);
    const long = posteriorVariance(0.6, 400, HEDGE_LIMITS.priorStrength);
    assert.ok(long < short);
    assert.ok(long >= 0);
  });

  it("computes the three-loss stress indicator R3L = (1 − q_L→W)·q_L→L²", () => {
    assert.equal(threeLossRunRisk({ afterLossWin: 1, lossToLoss: 0.9 }), 0, "always winning after a loss carries no stress");
    const expected = (1 - 0.4) * 0.6 * 0.6;
    assert.ok(Math.abs(threeLossRunRisk({ afterLossWin: 0.4, lossToLoss: 0.6 }) - expected) < 1e-12);
    assert.ok(
      threeLossRunRisk({ afterLossWin: 0.4, lossToLoss: 0.8 }) > threeLossRunRisk({ afterLossWin: 0.4, lossToLoss: 0.4 }),
      "more loss→loss clustering means more stress",
    );
    assert.ok(threeLossRunRisk({ afterLossWin: 0.1, lossToLoss: 1 }) <= 1, "bounded to a probability");
  });

  it("takes the escalation from whichever of the run or the step is deeper", () => {
    assert.equal(recoveryEscalation(0, 0), 0);
    assert.equal(recoveryEscalation(4, 2), 4);
    assert.equal(recoveryEscalation(1, 3), 3, "a cooldown zeroes the run but not the recovery step");
    assert.equal(recoveryEscalation(-5, -1), 0);
    assert.equal(recoveryEscalation(Number.NaN, 2), 2, "a missing run falls back to the step");
  });

  it("weights the recovery risk terms from 1 up to the configured cap", () => {
    assert.equal(recoveryRiskWeight(0), 1);
    assert.ok(recoveryRiskWeight(1) > 1);
    assert.ok(recoveryRiskWeight(3) > recoveryRiskWeight(2), "monotonic while the run deepens");
    const cap = HEDGE_LIMITS.recovery.escalationCap;
    const max = 1 + HEDGE_LIMITS.recovery.riskWeightMax;
    assert.ok(Math.abs(recoveryRiskWeight(cap) - max) < 1e-12);
    assert.ok(Math.abs(recoveryRiskWeight(cap * 10) - max) < 1e-12, "never exceeds the cap");
  });
});
