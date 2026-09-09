/**
 * Twin-Hedge Edge — analysis unit tests.
 *
 * The tests protect the four-region outcome mathematics, the stake-skew plan and
 * the walk-forward/live-entry contract:
 *   · complementary pair (Over 4 / Under 5) has no dead zone / no both-win zone
 *   · non-covering pair (Over 8 / Under 1) leaves a dead zone the model must see
 *   · the plan places (1+bias) on the favoured side and (1−bias) on the hedge
 *   · the joint break-even win rate is |L| / (W + |L|)
 *   · a fair stream is measured out of sample, not promised in sample
 *   · the live entry gate refuses before the stat window is warm
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  twinOutcome,
  buildTwinPlan,
  twinRegionNet,
  twinBreakEvenWinRate,
  twinWalkForward,
  evaluateTwinCandidate,
  evaluateTwinLiveEntry,
  twinCertaintySpec,
  twinExpectedNet,
  TWIN_MAX_BIAS,
  TWIN_MIN_BIAS,
} from "./twin-hedge-analysis.ts";

function pseudoDigits(n: number, seedBase = 1): number[] {
  let seed = seedBase;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out.push(seed % 10);
  }
  return out;
}

const BALANCED = { overDigit: 4, underDigit: 5 };
const DEAD = { overDigit: 8, underDigit: 1 };

describe("Twin-Hedge pair outcome", () => {
  it("Over 4 / Under 5 is complementary: exactly one leg always wins", () => {
    const o = twinOutcome(BALANCED);
    assert.equal(o.bothCount, 0);
    assert.equal(o.noneCount, 0);
    assert.equal(o.complementary, true);
    assert.equal(o.covering, true);
    assert.equal(o.overOnly.length + o.underOnly.length, 10);
  });

  it("Over 8 / Under 1 leaves eight dead digits outside both legs", () => {
    const o = twinOutcome(DEAD);
    assert.equal(o.complementary, false);
    assert.equal(o.noneCount, 8);
    assert.equal(o.overOnly.length, 1);
    assert.equal(o.underOnly.length, 1);
  });

  it("the stake skew puts (1+bias) on the favoured side", () => {
    const plan = buildTwinPlan(BALANCED, "over", 0.1, 1);
    assert.ok(Math.abs(plan.overStake - 1.1) < 1e-9);
    assert.ok(Math.abs(plan.underStake - 0.9) < 1e-9);
  });

  it("region nets satisfy the closed form for a balanced pair", () => {
    const plan = buildTwinPlan(BALANCED, "over", 0.1, 1);
    const overNet = twinRegionNet(BALANCED, plan, "overOnly");
    const underNet = twinRegionNet(BALANCED, plan, "underOnly");
    // over wins: 1.1*(1.95−1) − 0.9 = 0.145 ; under wins: 0.9*0.95 − 1.1 = −0.245
    assert.ok(Math.abs(overNet - 0.145) < 1e-9);
    assert.ok(Math.abs(underNet - -0.245) < 1e-9);
  });

  it("the joint break-even win rate is |L| / (W + |L|)", () => {
    const be = twinBreakEvenWinRate(BALANCED, "over", 0.1);
    const expected = 0.245 / (0.145 + 0.245);
    assert.ok(Math.abs(be - expected) < 1e-9);
  });

  it("the bias bounds keep the hedge a hedge", () => {
    assert.ok(TWIN_MIN_BIAS > 0);
    assert.ok(TWIN_MAX_BIAS < 0.5);
    assert.ok(TWIN_MIN_BIAS < TWIN_MAX_BIAS);
  });

  it("twinExpectedNet is linear in the state mass and equals region-sum", () => {
    const plan = buildTwinPlan(BALANCED, "over", 0.1, 1);
    const p = { overOnly: 0.6, underOnly: 0.4, both: 0, none: 0 };
    const net = twinExpectedNet(BALANCED, plan, p);
    const expected = 0.6 * 0.145 + 0.4 * -0.245;
    assert.ok(Math.abs(net - expected) < 1e-9);
  });
});

describe("Twin-Hedge walk-forward", () => {
  it("a fair digit stream is measured out of sample with finite numbers", () => {
    const digits = pseudoDigits(3000);
    const walk = twinWalkForward(digits, BALANCED, {
      spec: twinCertaintySpec("balanced"),
      baseStake: 1,
    });
    assert.equal(typeof walk.tau, "number");
    assert.ok(Number.isFinite(walk.tau));
    assert.ok(walk.test.nShots >= 0);
    assert.ok(walk.test.evPerDollar >= -1);
    assert.ok(walk.test.evPerDollar <= 1);
    assert.ok(walk.trainTicks <= walk.testTicks + walk.trainTicks);
  });

  it("it never certifies a random stream as deployable", () => {
    const digits = pseudoDigits(3000, 7);
    const cand = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      digits,
      BALANCED,
      {
        certainty: "balanced",
        baseStake: 1,
      },
    );
    assert.ok(cand);
    // Random digits have no conditional edge; the honest gate must not certify.
    assert.notEqual(cand.verdict, "certified");
  });
});

describe("Twin-Hedge live entry", () => {
  it("refuses before enough history for the live gate", () => {
    const digits = pseudoDigits(150, 3);
    const walk = twinWalkForward(digits, BALANCED, {
      spec: twinCertaintySpec("strict"),
      baseStake: 1,
    });
    const card = {
      tau: walk.tau,
      targetShotRate: 0.05,
      hmm: walk.hmm,
      overDigit: BALANCED.overDigit,
      underDigit: BALANCED.underDigit,
      overPayout: 1.95,
      underPayout: 1.95,
      minSpacing: 10,
      postLossTightening: 0.5,
      postLossCoolTicks: 16,
      targetEvPerDollar: 0.01,
      fittedOn: walk.trainTicks,
    };
    const entry = evaluateTwinLiveEntry(digits, BALANCED, card, {});
    assert.equal(entry.ready, false);
    assert.ok(
      entry.reason.includes("history") || entry.reason.includes("scale"),
    );
  });
});
