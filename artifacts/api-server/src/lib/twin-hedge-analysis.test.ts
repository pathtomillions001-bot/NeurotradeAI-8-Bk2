/**
 * Twin-Hedge Edge — analysis unit tests (v2 volume engine).
 *
 * The tests protect the four-region outcome mathematics, the stake-skew plan
 * and the mode-aware always-on contract:
 *   · complementary pair (Over 4 / Under 5) has no dead zone / no both-win zone
 *   · non-covering pair (Over 8 / Under 1) leaves a dead zone the model must see
 *   · the plan places (1+bias) on the favoured side and (1−bias) on the hedge
 *   · the joint break-even win rate is |L| / (W + |L|)
 *   · the edge reading is always defined and tilts with the stream
 *   · Balanced deploys on any warm market (even flat or dead-zone pairs)
 *   · Strict/Elite refuse flat markets but fire on a genuine measured tilt
 *   · the live entry gate refuses before warmup and during cool-down only
 *   · timing paces shots (spacing / freshness / agreement), never vetoes flat
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
  evaluateTwinTiming,
  estimateTwinEdge,
  screenTwinCandidates,
  twinCertaintySpec,
  twinExpectedNet,
  TWIN_MAX_BIAS,
  TWIN_MIN_BIAS,
  TWIN_MIN_HISTORY,
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

/** Perfectly flat stream — every digit exactly 10%. Deterministic, no luck. */
function flatDigits(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i % 10);
  return out;
}

/** Strong over-tilt for Over 4 / Under 5 (every print wins OVER). */
function overTilted(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(5 + (i % 5));
  return out;
}

/** Strong under-tilt for Over 4 / Under 5 (every print wins UNDER). */
function underTilted(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i % 5);
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

describe("Twin-Hedge edge estimator", () => {
  it("is always defined, even on a tiny sample", () => {
    const r = estimateTwinEdge(pseudoDigits(30, 3), BALANCED, { maxBias: 0.22 });
    assert.ok(Number.isFinite(r.pOver));
    assert.ok(Number.isFinite(r.edgePerBase));
    assert.ok(r.conviction >= 0.05 && r.conviction <= 1);
    assert.ok(r.bias >= TWIN_MIN_BIAS && r.bias <= 0.22 + 1e-9);
    assert.ok(r.pOver >= 0 && r.pOver <= 1);
  });

  it("points the primary at the tilted side with a positive edge", () => {
    const over = estimateTwinEdge(overTilted(600), BALANCED, { maxBias: 0.3 });
    assert.equal(over.primary, "over");
    assert.ok(over.tilt > 0);
    assert.ok(over.edgePerBase > 0);
    const under = estimateTwinEdge(underTilted(600), BALANCED, { maxBias: 0.3 });
    assert.equal(under.primary, "under");
    assert.ok(under.tilt < 0);
    assert.ok(under.edgePerBase > 0);
  });

  it("reads a flat stream as flat — small tilt, chop-dampened conviction", () => {
    const r = estimateTwinEdge(flatDigits(600), BALANCED, { maxBias: 0.22 });
    const t = estimateTwinEdge(overTilted(600), BALANCED, { maxBias: 0.22 });
    assert.ok(Math.abs(r.tilt) < 0.1);
    assert.ok(Math.abs(r.pOver - 0.5) < 0.03);
    // Chop dampens, trend amplifies: flat conviction must sit well below tilted.
    assert.ok(r.conviction < t.conviction);
    assert.ok(r.conviction >= 0.05 && r.conviction <= 1);
  });
});

describe("Twin-Hedge walk-forward", () => {
  it("paper-trades a flat stream with finite, bounded numbers", () => {
    const walk = twinWalkForward(flatDigits(1500), BALANCED, {
      spec: twinCertaintySpec("balanced"),
      baseStake: 1,
    });
    assert.equal(typeof walk.tau, "number");
    assert.ok(Number.isFinite(walk.tau));
    assert.ok(walk.test.nShots > 0);
    assert.ok(walk.test.evPerDollar >= -1);
    assert.ok(walk.test.evPerDollar <= 1);
    assert.ok(walk.trainTicks > 0 && walk.testTicks > 0);
  });

  it("fires positively on a tilted stream in Balanced mode", () => {
    const walk = twinWalkForward(overTilted(1500), BALANCED, {
      spec: twinCertaintySpec("balanced"),
      baseStake: 1,
    });
    assert.ok(walk.test.nShots > 0);
    assert.ok(walk.test.evPerDollar > 0);
    assert.ok(walk.test.winRate > 0.5);
  });
});

describe("Twin-Hedge candidate verdicts", () => {
  it("Balanced deploys on a flat market (watch or better, never refused)", () => {
    const cand = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      flatDigits(1500),
      BALANCED,
      { certainty: "balanced", baseStake: 1 },
    );
    assert.ok(cand);
    assert.notEqual(cand.verdict, "refused");
    assert.equal(cand.deployable, true);
    assert.ok(Number.isFinite(cand.card.tau));
    assert.equal(cand.card.certainty, "balanced");
    assert.ok(cand.confidence >= 1 && cand.confidence <= 100);
  });

  it("Balanced deploys a dead-zone pair too — any selected digits work", () => {
    const cand = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      flatDigits(1500),
      DEAD,
      { certainty: "balanced", baseStake: 1 },
    );
    assert.ok(cand);
    assert.notEqual(cand.verdict, "refused");
    assert.equal(cand.deployable, true);
  });

  it("Elite never certifies a flat stream", () => {
    const cand = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      flatDigits(1500),
      BALANCED,
      { certainty: "elite", baseStake: 1 },
    );
    assert.ok(cand);
    assert.notEqual(cand.verdict, "certified");
  });

  it("Strict deploys on a genuinely tilted stream", () => {
    const cand = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      overTilted(1500),
      BALANCED,
      { certainty: "strict", baseStake: 1 },
    );
    assert.ok(cand);
    assert.equal(cand.deployable, true);
    assert.equal(cand.primary, "over");
  });

  it("returns null before the minimum history floor", () => {
    const cand = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      flatDigits(TWIN_MIN_HISTORY - 20),
      BALANCED,
      { certainty: "balanced", baseStake: 1 },
    );
    assert.equal(cand, null);
  });

  it("ranks a deployable candidate above a refused one", () => {
    const good = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      flatDigits(1500),
      BALANCED,
      { certainty: "balanced", baseStake: 1 },
    );
    const bad = evaluateTwinCandidate(
      "R_100",
      "Volatility 100 Index",
      flatDigits(1500),
      BALANCED,
      { certainty: "elite", baseStake: 1 },
    );
    assert.ok(good && bad);
    assert.equal(good.deployable, true);
    assert.equal(bad.deployable, false);
    const ranked = screenTwinCandidates([bad, good]);
    assert.equal(ranked[0]!.symbol, "R_25");
    assert.equal(ranked[1]!.symbol, "R_100");
  });
});

describe("Twin-Hedge live entry", () => {
  it("refuses before enough history for the live gate", () => {
    const cand = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      flatDigits(1500),
      BALANCED,
      { certainty: "balanced", baseStake: 1 },
    );
    assert.ok(cand);
    const entry = evaluateTwinLiveEntry(flatDigits(60), BALANCED, cand.card, {});
    assert.equal(entry.ready, false);
    assert.ok(entry.reason.includes("history"));
  });

  it("Balanced fires on a warm flat stream (cadence carries it)", () => {
    const cand = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      flatDigits(1500),
      BALANCED,
      { certainty: "balanced", baseStake: 1 },
    );
    assert.ok(cand);
    const entry = evaluateTwinLiveEntry(flatDigits(600), BALANCED, cand.card, {
      ticksSinceLoss: 100,
    });
    assert.equal(entry.ready, true);
    assert.ok(entry.conviction >= 0.05 && entry.conviction <= 1);
  });

  it("Strict holds a flat stream but fires a tilted one", () => {
    const flat = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      flatDigits(1500),
      BALANCED,
      { certainty: "strict", baseStake: 1 },
    );
    assert.ok(flat);
    const hold = evaluateTwinLiveEntry(flatDigits(600), BALANCED, flat.card, {
      ticksSinceLoss: 100,
    });
    assert.equal(hold.ready, false);

    const tilted = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      overTilted(1500),
      BALANCED,
      { certainty: "strict", baseStake: 1 },
    );
    assert.ok(tilted);
    const fire = evaluateTwinLiveEntry(overTilted(600), BALANCED, tilted.card, {
      ticksSinceLoss: 100,
    });
    assert.equal(fire.ready, true);
    assert.equal(fire.primary, "over");
  });

  it("honours the post-loss cool-down in every mode", () => {
    const cand = evaluateTwinCandidate(
      "R_25",
      "Volatility 25 Index",
      flatDigits(1500),
      BALANCED,
      { certainty: "balanced", baseStake: 1 },
    );
    assert.ok(cand);
    const entry = evaluateTwinLiveEntry(flatDigits(600), BALANCED, cand.card, {
      ticksSinceLoss: 0,
    });
    assert.equal(entry.ready, false);
    assert.ok(entry.reason.includes("cool-down"));
  });
});

describe("Twin-Hedge timing", () => {
  it("Balanced fires when the feed is fresh and spacing is satisfied", () => {
    const t = evaluateTwinTiming({
      digits: flatDigits(50),
      contract: BALANCED,
      primary: "over",
      secondsSinceLastTick: 1,
      medianTickGapSeconds: 2,
      ticksSinceLastShot: 10,
      minSpacing: 3,
      agreeTicks: 0,
    });
    assert.equal(t.ready, true);
  });

  it("holds when the feed is stale or shots need re-spacing", () => {
    const stale = evaluateTwinTiming({
      digits: flatDigits(50),
      contract: BALANCED,
      primary: "over",
      secondsSinceLastTick: 30,
      medianTickGapSeconds: 2,
      ticksSinceLastShot: 10,
      minSpacing: 3,
      agreeTicks: 0,
    });
    assert.equal(stale.ready, false);
    assert.ok(stale.reason.includes("feed"));

    const spaced = evaluateTwinTiming({
      digits: flatDigits(50),
      contract: BALANCED,
      primary: "over",
      secondsSinceLastTick: 1,
      medianTickGapSeconds: 2,
      ticksSinceLastShot: 1,
      minSpacing: 3,
      agreeTicks: 0,
    });
    assert.equal(spaced.ready, false);
    assert.ok(spaced.reason.includes("re-spacing"));
  });

  it("Strict agreement holds on a disagreeing last print only", () => {
    const disagree = evaluateTwinTiming({
      digits: [...flatDigits(49), 0],
      contract: BALANCED,
      primary: "over",
      secondsSinceLastTick: 1,
      medianTickGapSeconds: 2,
      ticksSinceLastShot: 10,
      minSpacing: 3,
      agreeTicks: 1,
    });
    assert.equal(disagree.ready, false);
    assert.ok(disagree.reason.includes("disagrees"));

    const agree = evaluateTwinTiming({
      digits: [...flatDigits(49), 9],
      contract: BALANCED,
      primary: "over",
      secondsSinceLastTick: 1,
      medianTickGapSeconds: 2,
      ticksSinceLastShot: 10,
      minSpacing: 3,
      agreeTicks: 1,
    });
    assert.equal(agree.ready, true);
  });
});
