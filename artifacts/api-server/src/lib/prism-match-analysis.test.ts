import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  correctPrismEvidence,
  decidePrism,
  evaluatePrism,
  fitPrismCalibration,
  PrismModel,
  PRISM_VERSION,
  simulatePrismRisk,
  type PrismPolicy,
} from "./prism-match-analysis";
import {
  assertPrismTick,
  prismStake,
  parsePrismScan,
  parsePrismStart,
} from "./prism-match-policy";
import { DigitTape, mergeLiveDigitHistory } from "./digit-tape";
import {
  calculateBotRecoveryStake,
  applyRecoveryStakeLimits,
} from "./recovery-math";
import { MATCH_PAYOUT } from "./payouts";

function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const risk = {
  stake: 1,
  stopLoss: 10,
  takeProfit: 10,
  maxStake: 100,
  markupPercent: 10,
};
const policy: PrismPolicy = {
  version: PRISM_VERSION,
  activity: "balanced",
  calibration: 1,
  threshold: 0.002,
  fittedTicks: 1000,
};
const config = { ...risk, activity: "balanced" as const };

describe("Prism causal multiclass model", () => {
  it("starts at a normalized 10% baseline and predict() is read-only", () => {
    const model = new PrismModel();
    const first = model.predict();
    assert.equal(first.samples, 0);
    first.probabilities.forEach((p) => assert.ok(Math.abs(p - 0.1) < 1e-12));
    assert.deepEqual(model.predict(), first);
    first.probabilities[0] = 1;
    first.experts[0]!.probabilities[0] = 1;
    assert.ok(
      Math.abs(model.predict().probabilities[0]! - 0.1) < 1e-12,
      "callers cannot mutate internal expert distributions",
    );
  });
  it("learns a next-digit Markov process, not the digit already observed", () => {
    const model = new PrismModel();
    for (let i = 0; i < 4000; i++) model.observe(i % 10);
    const next = model.predict();
    assert.equal(decidePrism(next, policy).digit, 0);
    model.observe(0);
    assert.equal(decidePrism(model.predict(), policy).digit, 1);
    assert.ok(model.predict().probabilities[1]! > 0.6);
  });
  it("repeated digits are genuine new evidence and a zero gap is NOT an entry veto", () => {
    const model = new PrismModel();
    for (let i = 0; i < 600; i++) model.observe(7);
    const decision = decidePrism(model.predict(), policy);
    assert.equal(model.samples, 600);
    assert.equal(model.predict().gaps[7], 0);
    assert.equal(decision.digit, 7);
    assert.equal(decision.ready, true);
  });
  it("normalizes all ten digits and keeps finite uncertainty after multiple ring rollovers", () => {
    const rng = random(42),
      model = new PrismModel();
    for (let i = 0; i < 10_000; i++) {
      model.observe(Math.floor(rng() * 10));
      if (i % 211 !== 0) continue;
      const pred = model.predict();
      assert.ok(
        Math.abs(pred.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-10,
      );
      assert.ok(
        Math.abs(pred.experts.reduce((a, e) => a + e.weight, 0) - 1) < 1e-10,
      );
      assert.ok(
        pred.probabilities.every((p) => Number.isFinite(p) && p > 0 && p < 1),
      );
      assert.ok(pred.sigma.every((s) => Number.isFinite(s) && s >= 0));
    }
  });
  it("rejects invalid digits instead of joining contexts across missing observations", () => {
    const model = new PrismModel();
    for (const digit of [NaN, Infinity, -1, 10, 2.5])
      assert.throws(() => model.observe(digit), /integers/);
    assert.throws(
      () => evaluatePrism([...Array(500).fill(1), NaN], config),
      /valid/,
    );
  });
  it("is exactly reproducible on identical prefixes", () => {
    const rng = random(8),
      a = new PrismModel(),
      b = new PrismModel();
    for (let i = 0; i < 1000; i++) {
      const digit = Math.floor(rng() * 10);
      a.observe(digit);
      b.observe(digit);
      assert.deepEqual(a.predict(), b.predict());
      assert.deepEqual(
        a.predict(),
        a.predict(),
        "repeated reads do not train on an unseen tick",
      );
    }
  });
});

describe("Prism walk-forward measurement and non-stacked entries", () => {
  it("backs off on a seeded IID tape rather than inventing accuracy or enforcing a trade quota", () => {
    const rng = random(900),
      digits = Array.from({ length: 4999 }, () => Math.floor(rng() * 10));
    const result = evaluatePrism(digits, config);
    assert.equal(result.policy.calibration, 0);
    assert.equal(result.decision.ready, false);
    assert.equal(result.validation.shots, 0);
    assert.equal(result.validation.hitRate, null);
    assert.equal(result.validation.evPerStake, null);
    assert.equal(result.validation.evidence, "unproven");
    assert.ok(Math.abs(result.validation.brierSkill) < 1e-10);
  });
  it("does not call a collection of fair tapes supported", () => {
    const results = Array.from({ length: 8 }, (_, i) => {
      const rng = random(i * 171 + 42);
      return evaluatePrism(
        Array.from({ length: 1600 }, () => Math.floor(rng() * 10)),
        config,
      );
    });
    correctPrismEvidence(results);
    assert.ok(results.every((r) => r.validation.evidence !== "supported"));
  });
  it("finds planted predictive structure without starving entries behind proof/gap gates", () => {
    const rng = random(12);
    let last = 0;
    const digits = Array.from({ length: 4000 }, () => {
      last = rng() < 0.6 ? (last + 1) % 10 : Math.floor(rng() * 10);
      return last;
    });
    const result = evaluatePrism(digits, config);
    assert.ok(result.validation.shots > 200);
    assert.ok(result.validation.hitRate! > 0.4);
    assert.ok(result.validation.brierSkill > 0.1);
    assert.ok(result.validation.lower95! <= result.validation.hitRate!);
    assert.ok(result.validation.upper95! >= result.validation.hitRate!);
  });
  it("fits calibration and entry threshold on the training prefix ONLY", () => {
    const rng = random(123),
      prefix = Array.from({ length: 2400 }, () =>
        rng() < 0.25 ? 7 : Math.floor(rng() * 10),
      );
    const a = evaluatePrism([...prefix, ...Array(1600).fill(7)], config);
    const b = evaluatePrism([...prefix, ...Array(1600).fill(2)], config);
    assert.deepEqual(
      a.policy,
      b.policy,
      "future outcomes must not choose the fitted calibration or threshold",
    );
    assert.equal(a.validation.trainTicks, 2400);
    assert.equal(a.validation.testTicks, 1600);
  });
  it("keeps a named digit sovereign across normal, recovery and model preference", () => {
    const model = new PrismModel();
    for (let i = 0; i < 1000; i++) model.observe(7);
    assert.equal(
      decidePrism(model.predict(), { ...policy, digit: 2 }).digit,
      2,
    );
    assert.equal(
      decidePrism(model.predict(), { ...policy, digit: 2 }).ready,
      false,
    );
  });
  it("activity waiting relaxes only the pacing preference, NEVER the positive-value floor", () => {
    const model = new PrismModel();
    for (let i = 0; i < 1000; i++) model.observe(i % 10);
    const pred = model.predict(0);
    const decision = decidePrism(
      pred,
      { ...policy, threshold: 5 },
      8.93,
      10_000,
    );
    assert.equal(decision.threshold, 0.002);
    assert.equal(decision.ready, false);
    assert.ok(decision.expectedValue < 0);
  });
  it("re-prices the exact same probability against actual payout", () => {
    const model = new PrismModel();
    for (let i = 0; i < 800; i++) model.observe(7);
    const pred = model.predict(0.1);
    assert.equal(decidePrism(pred, policy, 8.93).ready, true);
    assert.equal(decidePrism(pred, policy, 2).ready, false);
    assert.throws(() => decidePrism(pred, policy, NaN), /payout/);
  });
  it("adjusts cross-market evidence without introducing an extra execution gate", () => {
    const rng = random(900),
      result = evaluatePrism(
        Array.from({ length: 600 }, () => Math.floor(rng() * 10)),
        config,
      );
    const rows = Array.from({ length: 3 }, () => ({
      validation: {
        ...result.validation,
        evidenceP: 0.02,
        shots: 50,
        evPerStake: 0.1,
      },
    }));
    correctPrismEvidence(rows);
    assert.equal(rows[0]!.validation.adjustedEvidenceP, 0.06);
    assert.equal(rows[0]!.validation.evidence, "developing");
  });
  it("calibration honestly prefers the uniform model on perfectly uniform outcomes", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      ps: [0.55, ...Array(9).fill(0.05)],
      outcome: i % 10,
    }));
    assert.equal(fitPrismCalibration(rows), 0);
  });
});

describe("Prism recovery and scenario math", () => {
  it("uses the existing Matches debt/markup formula including the $0.35 floor", () => {
    for (const debt of [1, 3.45, 12, 41.23]) {
      const args = {
        baseStake: 1,
        debt,
        payout: MATCH_PAYOUT,
        markupPercent: 10,
        maxStake: 500,
        balance: 1000,
        remainingStop: 500,
      };
      assert.equal(
        prismStake(args),
        applyRecoveryStakeLimits(
          calculateBotRecoveryStake(debt, MATCH_PAYOUT, 10),
          500,
          500,
        ),
      );
    }
    assert.equal(
      prismStake({
        baseStake: 1,
        debt: 1,
        payout: MATCH_PAYOUT,
        markupPercent: 10,
        maxStake: 500,
        balance: 100,
        remainingStop: 50,
      }),
      0.35,
    );
  });
  it("zero balance and sub-minimum stop room can never become unlimited risk", () => {
    const args = {
      baseStake: 1,
      debt: 2,
      payout: 8.93,
      markupPercent: 10,
      maxStake: 500,
      balance: 100,
      remainingStop: 5,
    };
    for (const balance of [0, 0.34, -1, NaN, Infinity])
      assert.throws(() => prismStake({ ...args, balance }));
    assert.throws(() => prismStake({ ...args, remainingStop: 0.349 }));
    assert.throws(() => prismStake({ ...args, debt: 0, remainingStop: 0.5 }));
    assert.equal(prismStake({ ...args, debt: 50, remainingStop: 0.37 }), 0.37);
  });
  it("posterior-predictive risk is deterministic, bounded and labelled as a scenario", () => {
    const shots = Array.from({ length: 100 }, (_, i) => Number(i % 8 === 0));
    const a = simulatePrismRisk(shots, { ...risk, payout: 8.93 }, 7);
    const b = simulatePrismRisk(shots, { ...risk, payout: 8.93 }, 7);
    assert.deepEqual(a, b);
    assert.ok(a.stopProbability >= 0 && a.stopProbability <= 1);
    assert.ok(a.targetProbability + a.stopProbability <= 1);
    assert.ok(a.pnl05 <= a.pnl50 && a.pnl50 <= a.pnl95);
    assert.ok(a.pnl05 >= -risk.stopLoss);
    assert.match(a.note, /not a guarantee/);
    const losses = simulatePrismRisk(
      Array(100).fill(0),
      { ...risk, payout: 8.93 },
      7,
    );
    assert.ok(losses.stopProbability > 0.95);
  });
});

describe("Prism wire and tick authorization", () => {
  const input = {
    activity: "balanced",
    stake: 1,
    stopLoss: 10,
    takeProfit: 10,
    maxRecoverySteps: 3,
    executionMode: "paper",
  };
  it("validates finite risk, integer digits and explicit paper/live mode", () => {
    assert.equal(parsePrismScan(input).ok, true);
    for (const value of [NaN, Infinity, -1, 0, 0.349, 1.001])
      assert.equal(parsePrismScan({ ...input, stake: value }).ok, false);
    for (const value of [-1, 10, 0.5, "7", null])
      assert.equal(parsePrismScan({ ...input, digit: value }).ok, false);
    assert.equal(parsePrismScan({ ...input, digit: 0 }).ok, true);
    assert.equal(parsePrismScan({ ...input, activity: "__proto__" }).ok, false);
    assert.equal(
      parsePrismScan({ ...input, executionMode: undefined }).ok,
      false,
    );
    assert.equal(parsePrismScan({ ...input, stake: 11 }).ok, false);
  });
  it("rejects contract widening, client model cards and pre-scan market modes", () => {
    assert.equal(
      parsePrismScan({ ...input, contractType: "DIGITDIFF" }).ok,
      false,
    );
    assert.equal(parsePrismScan({ ...input, marketMode: "locked" }).ok, false);
    const start = {
      scanId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      symbol: "R_100",
      marketMode: "locked",
    };
    assert.equal(parsePrismStart(start).ok, true);
    for (const key of [
      "card",
      "stake",
      "digit",
      "contractType",
      "lockedSymbol",
      "analysis",
    ])
      assert.equal(parsePrismStart({ ...start, [key]: 1 }).ok, false);
    assert.equal(
      parsePrismStart({ ...start, marketMode: undefined }).ok,
      false,
    );
  });
  it("identifies consecutive equal digits by sequence and never bridges feed provenance", () => {
    const tape = new DigitTape(5);
    const push = (epoch: number, source: "live" | "simulated" = "live") =>
      tape.push({
        symbol: "R_100",
        price: 100.07,
        digit: 7,
        epoch,
        source,
        receivedAt: epoch * 1000,
      });
    push(100);
    push(102);
    push(104);
    assert.equal(tape.snapshot("R_100")!.tick.sequence, 3);
    const tick = tape.snapshot("R_100")!.tick;
    assertPrismTick({
      analysed: tick,
      current: tick,
      now: 104_100,
      periodMs: 2000,
      live: true,
      stopped: false,
      owns: true,
    });
    push(106);
    assert.throws(
      () =>
        assertPrismTick({
          analysed: tick,
          current: tape.snapshot("R_100")!.tick,
          now: 106_100,
          periodMs: 2000,
          live: true,
          stopped: false,
          owns: true,
        }),
      /new tick/,
    );
    push(107, "simulated");
    const fake = tape.snapshot("R_100")!.tick;
    assert.throws(
      () =>
        assertPrismTick({
          analysed: fake,
          current: fake,
          now: 107_100,
          periodMs: 2000,
          live: true,
          stopped: false,
          owns: true,
        }),
      /Simulated/,
    );
  });
  it("re-checks stop, ownership and latency headroom at actual send time", () => {
    const tick = {
      symbol: "R_100",
      sequence: 1,
      generation: 1,
      source: "live" as const,
      epoch: 100,
      receivedAt: 100_000,
      digit: 1,
      price: 100.01,
    };
    const input = {
      analysed: tick,
      current: tick,
      now: 100_100,
      periodMs: 1000,
      live: true,
      stopped: false,
      owns: true,
    };
    assert.throws(
      () => assertPrismTick({ ...input, stopped: true }),
      /stopped/,
    );
    assert.throws(
      () => assertPrismTick({ ...input, owns: false }),
      /ownership/,
    );
    assert.throws(
      () => assertPrismTick({ ...input, now: 100_900 }),
      /headroom/,
    );
    assert.throws(() => assertPrismTick({ ...input, now: 99_000 }), /headroom/);
  });
  it("merges broker and live histories by epoch without losing repeats or duplicating overlap", () => {
    const tape = new DigitTape(5);
    for (const epoch of [102, 104, 106])
      tape.push({
        symbol: "R_100",
        price: 100.07,
        digit: 7,
        epoch,
        source: "live",
        receivedAt: epoch * 1000,
      });
    assert.deepEqual(
      mergeLiveDigitHistory(
        [
          { epoch: 100, digit: 1 },
          { epoch: 102, digit: 7 },
          { epoch: 104, digit: 7 },
        ],
        tape.snapshot("R_100")!,
      ),
      [1, 7, 7, 7],
    );
    assert.throws(
      () =>
        mergeLiveDigitHistory(
          [{ epoch: 102, digit: 2 }],
          tape.snapshot("R_100")!,
        ),
      /disagrees/,
    );
  });
});
