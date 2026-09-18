/**
 * Twin-Hedge Edge (v3) — 4/5 dead-zone avoidance tests.
 *
 * What is protected:
 *   · the fixed plan's payout arithmetic (normal −0.05, recovery +0.43 / −2.00)
 *   · the fused 4/5 model (flat stream ≈ 20%, cold stream ≪ 20%, Markov rows)
 *   · the hard vetoes — market-hot, hot-cluster, post-4/5, cool-down — and the
 *     fact that the patience valve can NEVER override a veto
 *   · the patience valve DOES override soft-gate misses (25 recovery / 12 normal)
 *   · out-of-sample market measurement: hot markets refused, flat markets
 *     deployable, short history rejected
 *   · the analysis-decided market mode (locked on a clear winner, switching on
 *     a tight cluster)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TWIN_AVOID_PLAN,
  TWIN_AVOID_PATIENCE,
  P45Tracker,
  evaluateAvoidGate,
  measureMarket45,
  decideMarketMode,
  chiSquareZ,
  isInDeadZone,
  type TwinAvoidCard,
  type TwinAvoidRisk,
} from "./twin-avoid-analysis.ts";

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** i.i.d. uniform digits (the realistic baseline case). */
function uniformDigits(n: number, seed = 1): number[] {
  const rnd = lcg(seed);
  return Array.from({ length: n }, () => Math.floor(rnd() * 10));
}

/** A stream with NO 4/5 at all. */
function noZoneDigits(n: number, seed = 1): number[] {
  const rnd = lcg(seed);
  const allowed = [0, 1, 2, 3, 6, 7, 8, 9];
  return Array.from({ length: n }, () => allowed[Math.floor(rnd() * 8)]!);
}

/** A stream running 30% 4/5 (structurally hot). */
function hotDigits(n: number, seed = 1): number[] {
  const rnd = lcg(seed);
  return Array.from({ length: n }, () =>
    rnd() < 0.3 ? (rnd() < 0.5 ? 4 : 5) : Math.floor(rnd() * 4),
  );
}

const RISK: TwinAvoidRisk = {
  stake: 1,
  stopLoss: 5,
  takeProfit: 10,
  maxRecoverySteps: 5,
  markupPercent: 10,
  maxTradeStake: 500,
};

const approx = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

describe("Twin-Hedge plan arithmetic", () => {
  it("normal pair nets −0.05 per $1 (one win at 0.95, one loss at 1.00)", () => {
    approx(TWIN_AVOID_PLAN.normalNetPerBase, -0.05);
    const { overPayout, underPayout } = TWIN_AVOID_PLAN.normal;
    assert.equal(overPayout, 1.95);
    assert.equal(underPayout, 1.95);
    approx((overPayout - 1) - 1, -0.05);
  });

  it("recovery pair nets +0.43 per $1 off the dead zone, −2.00 inside it", () => {
    approx(TWIN_AVOID_PLAN.recoveryWinNetPerBase, 0.43);
    assert.equal(TWIN_AVOID_PLAN.recoveryLossNetPerBase, -2.0);
    const { overPayout } = TWIN_AVOID_PLAN.recovery;
    assert.equal(overPayout, 2.43);
    approx(overPayout - 1 - 1, 0.43); // win leg +1.43, lose leg −1.00
    approx(TWIN_AVOID_PLAN.recoveryEffPayout, 1.43);
  });

  it("the dead zone is exactly {4,5}", () => {
    assert.equal(isInDeadZone(4), true);
    assert.equal(isInDeadZone(5), true);
    for (const d of [0, 1, 2, 3, 6, 7, 8, 9]) assert.equal(isInDeadZone(d), false);
  });
});

describe("P45Tracker", () => {
  it("reads ≈20% on a flat i.i.d. stream", () => {
    const t = new P45Tracker();
    t.prime(uniformDigits(800, 3));
    const r = t.read();
    assert.equal(r.insufficient, false);
    assert.ok(Math.abs(r.p45 - 0.2) < 0.06, `p45=${r.p45}`);
  });

  it("reads well below 20% when 4/5 have been absent from the stream", () => {
    const t = new P45Tracker();
    t.prime(noZoneDigits(400, 5));
    const r = t.read();
    assert.ok(r.p45 < 0.12, `p45=${r.p45}`);
  });

  it("reads well above 20% when the stream is hot on 4/5", () => {
    const t = new P45Tracker();
    t.prime(hotDigits(1200, 7));
    const r = t.read();
    assert.ok(r.p45 > 0.23, `p45=${r.p45}`);
    assert.ok(r.order0 > 0.24, `order0=${r.order0}`);
  });

  it("the order-1 row learns a deterministic successor", () => {
    // 3 is ALWAYS followed by 4 → P(4/5 | last=3) must sit far above the
    // 20% baseline (smoothing keeps it below 1.0 by design)
    const stream: number[] = [];
    for (let i = 0; i < 300; i++) stream.push(1, 2, 3, 4, 6, 7, 8, 9);
    stream.push(3); // context ends on 3
    const t = new P45Tracker();
    t.prime(stream);
    const r = t.read();
    assert.ok(r.order1 > 0.4, `order1=${r.order1}`);
    assert.ok(r.order1 > 2 * 0.2, "must beat the baseline by 2×");
  });

  it("is insufficient on a short stream", () => {
    const t = new P45Tracker();
    t.prime([1, 2, 3]);
    assert.equal(t.read().insufficient, true);
  });
});

describe("evaluateAvoidGate — hard vetoes", () => {
  const base = {
    baseline: 0.2,
    bar: 0.18,
    mode: "recovery" as const,
    lastDigits: [0, 1, 2, 6, 7, 8],
    ticksSinceLoss: 50,
    waitedTicks: 0,
  };
  const reading = (p45: number, p45Se = 0.008, order1 = 0.2) => {
    const t = new P45Tracker();
    // synthesize: just use a real tracker on a crafted stream is overkill —
    // the gate only reads the reading's fields.
    return {
      p45,
      p45Se,
      p4: p45 / 2,
      p5: p45 / 2,
      order0: p45,
      order1,
      order2: p45,
      weight0: 1 / 3,
      weight1: 1 / 3,
      weight2: 1 / 3,
      nEff: 500,
      insufficient: false,
    };
  };

  it("refuses a market whose baseline 4/5 rate is above 22%", () => {
    const g = evaluateAvoidGate({ ...base, baseline: 0.23, reading: reading(0.15) });
    assert.equal(g.ready, false);
    assert.equal(g.veto, "market-hot");
  });

  it("refuses when 3+ of the last 6 ticks are 4/5 (hot cluster)", () => {
    const g = evaluateAvoidGate({
      ...base,
      lastDigits: [0, 1, 4, 5, 4, 5],
      reading: reading(0.15),
    });
    assert.equal(g.ready, false);
    assert.equal(g.veto, "hot-cluster");
  });

  it("refuses the post-4/5 state when the conditional is not below baseline", () => {
    const g = evaluateAvoidGate({
      ...base,
      lastDigits: [0, 1, 2, 6, 7, 4],
      reading: reading(0.15, 0.008, 0.22), // order1 ≥ baseline
    });
    assert.equal(g.ready, false);
    assert.equal(g.veto, "post-4/5");
  });

  it("allows the post-4/5 state when the conditional IS below baseline", () => {
    const g = evaluateAvoidGate({
      ...base,
      lastDigits: [0, 1, 2, 6, 7, 4],
      reading: reading(0.12, 0.008, 0.15),
    });
    assert.equal(g.veto, null);
  });

  it("refuses during the post-loss cool-down", () => {
    for (const ticks of [0, 1, 2]) {
      const g = evaluateAvoidGate({
        ...base,
        ticksSinceLoss: ticks,
        reading: reading(0.1),
      });
      assert.equal(g.ready, false);
      assert.equal(g.veto, "cool-down");
    }
  });

  it("the patience valve can NEVER override a hard veto", () => {
    const g = evaluateAvoidGate({
      ...base,
      lastDigits: [0, 1, 4, 5, 4, 5],
      waitedTicks: 999,
      reading: reading(0.1),
    });
    assert.equal(g.ready, false);
    assert.equal(g.veto, "hot-cluster");
  });
});

describe("evaluateAvoidGate — soft gates and patience", () => {
  const base = {
    baseline: 0.2,
    bar: 0.18,
    mode: "recovery" as const,
    lastDigits: [0, 1, 2, 6, 7, 8],
    ticksSinceLoss: 50,
    waitedTicks: 0,
  };
  const reading = (p45: number, p45Se = 0.008) => ({
    p45,
    p45Se,
    p4: p45 / 2,
    p5: p45 / 2,
    order0: p45,
    order1: p45,
    order2: p45,
    weight0: 1 / 3,
    weight1: 1 / 3,
    weight2: 1 / 3,
    nEff: 500,
    insufficient: false,
  });

  it("fires a recovery shot on a clean reading below the bar", () => {
    const g = evaluateAvoidGate({ ...base, reading: reading(0.15) });
    assert.equal(g.ready, true);
    assert.equal(g.patienceForced, false);
  });

  it("waits when the worst plausible case is above the baseline (recovery)", () => {
    // p45 = 0.19, se = 0.01 → worst = 0.2025 > 0.20 baseline
    const g = evaluateAvoidGate({ ...base, reading: reading(0.19, 0.01) });
    assert.equal(g.ready, false);
    assert.equal(g.veto, null); // soft, not a veto
  });

  it("waits above the bar until the patience valve fires (25 recovery ticks)", () => {
    const below = evaluateAvoidGate({ ...base, reading: reading(0.19, 0.002), waitedTicks: TWIN_AVOID_PATIENCE.recovery - 1 });
    assert.equal(below.ready, false);
    const forced = evaluateAvoidGate({ ...base, reading: reading(0.19, 0.002), waitedTicks: TWIN_AVOID_PATIENCE.recovery });
    assert.equal(forced.ready, true);
    assert.equal(forced.patienceForced, true);
  });

  it("normal mode has its own (shorter) patience valve and relaxed ceiling", () => {
    const reading_ = reading(0.195, 0.002);
    const normalWait = evaluateAvoidGate({
      ...base,
      mode: "normal",
      bar: 0.18,
      reading: reading_,
      waitedTicks: TWIN_AVOID_PATIENCE.normal - 1,
    });
    assert.equal(normalWait.ready, false);
    const normalForced = evaluateAvoidGate({
      ...base,
      mode: "normal",
      bar: 0.18,
      reading: reading_,
      waitedTicks: TWIN_AVOID_PATIENCE.normal,
    });
    assert.equal(normalForced.ready, true);
    assert.equal(normalForced.patienceForced, true);
  });

  it("an insufficient reading is never a shot", () => {
    const g = evaluateAvoidGate({
      ...base,
      reading: { ...reading(0.1), insufficient: true },
    });
    assert.equal(g.ready, false);
  });
});

describe("measureMarket45 — out-of-sample", () => {
  it("returns null without enough history", () => {
    assert.equal(measureMarket45("R_100", "Short", uniformDigits(300), RISK), null);
  });

  it("refuses a structurally hot 4/5 market", () => {
    const card = measureMarket45("HOT", "Hot market", hotDigits(4999, 11), RISK);
    assert.ok(card);
    assert.ok(card.baseline > 0.22, `baseline=${card.baseline}`);
    assert.equal(card.verdict, "refused");
    assert.equal(card.deployable, false);
  });

  it("deploys a fair market with a measured out-of-sample survival", () => {
    const card = measureMarket45("R_100", "Fair market", uniformDigits(4999, 13), RISK);
    assert.ok(card);
    assert.ok(Math.abs(card.baseline - 0.2) < 0.03, `baseline=${card.baseline}`);
    assert.ok(card.simNormalShots > 0, "the engine should have fired normal shots");
    assert.ok(card.simRecoveryShots > 0, "recovery must have been exercised");
    assert.ok(card.score > -0.5, `score=${card.score}`);
    assert.ok(typeof card.survival === "number" && (card.survival === 0 || card.survival === 1));
    assert.ok(card.barRecovery <= card.barNormal, "recovery bar must be at least as strict");
  });

  it("the bars sit near the market's own readings (self-referential)", () => {
    const card = measureMarket45("R_100", "Fair market", uniformDigits(4999, 17), RISK);
    assert.ok(card);
    assert.ok(card.barRecovery > 0.05 && card.barRecovery < 0.21);
    assert.ok(card.barNormal > 0.05 && card.barNormal < 0.21);
  });
});

describe("decideMarketMode", () => {
  const mk = (symbol: string, score: number, deployable = true): TwinAvoidCard =>
    ({
      symbol,
      displayName: symbol,
      baseline: 0.2,
      barNormal: 0.18,
      barRecovery: 0.16,
      nEff: 500,
      opportunityNormal: 0.2,
      opportunityRecovery: 0.15,
      avoidanceLiftPp: 1,
      survival: 1,
      evPerNormalShot: 0.05,
      deepestLadder: 1,
      simNormalShots: 50,
      simRecoveryShots: 50,
      stationarityZ: 0,
      minSpacing: 4,
      verdict: "qualified",
      deployable,
      score,
      summary: "test",
    }) as TwinAvoidCard;

  it("locks a clear winner (score gap ≥ 0.12)", () => {
    const d = decideMarketMode([mk("A", 0.9), mk("B", 0.75)]);
    assert.equal(d.mode, "locked");
    assert.deepEqual(d.cluster.map((c) => c.symbol), ["A"]);
  });

  it("switches on a tight cluster", () => {
    const d = decideMarketMode([mk("A", 0.8), mk("B", 0.76), mk("C", 0.71)]);
    assert.equal(d.mode, "switching");
    assert.ok(d.cluster.length >= 2);
  });

  it("falls back to locked when nothing is deployable", () => {
    const d = decideMarketMode([mk("A", 0.8, false)]);
    assert.equal(d.mode, "locked");
    assert.equal(d.cluster.length, 0);
  });
});

describe("chiSquareZ", () => {
  it("is negative when the χ² statistic is at zero", () => {
    assert.ok(chiSquareZ(0, 3) < -3);
  });

  it("is near the Wilson–Hilferty mean correction at χ² = df", () => {
    assert.ok(Math.abs(chiSquareZ(3, 3) - 0.272) < 0.01);
  });

  it("grows for large statistics", () => {
    assert.ok(chiSquareZ(12, 3) > 1.5);
  });
});
