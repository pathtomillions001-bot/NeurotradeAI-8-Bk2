/**
 * Desk v4 research harness — runner and gates (WP2 tests).
 *
 * The most important test in this file is the prefix-replay check. Everything
 * else in the programme rests on the claim that a decision at time *t* cannot
 * depend on data after *t*; a harness without that property produces impressive
 * reports about the past and nothing about the future.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { decisionDigest, framesForMode, prefixReplayCheck, runHarness } from "./research/harness";
import { computeMetrics } from "./research/metrics";
import { driftlessRandomWalk, positiveControl } from "./research/generators";
import { evaluateNullGate, evaluatePositiveControlGate, GATE_THRESHOLDS } from "./research/gates";
import { purgedWalkForward, combinatorialPurgedCV } from "./research/walkforward";
import { probabilityOfBacktestOverfitting } from "./research/numerics";
import type { RunReport } from "./research/types";

/** A small but non-trivial dataset, evaluated quickly. */
function smallDataset(seed: number) {
  return driftlessRandomWalk({ symbol: "EURUSD", seed, bars: 4_000 });
}

const FAST_OPTIONS = { mode: "intraday" as const, seed: 1, stepBars: 40, warmupBars: 400 };

test("prefix replay: truncating the data does not change earlier decisions", () => {
  const dataset = smallDataset(101);
  const result = prefixReplayCheck({
    dataset,
    options: FAST_OPTIONS,
    truncateIndex: 2_500,
  });
  assert.equal(
    result.mismatches.length,
    0,
    `decisions changed under truncation: ${JSON.stringify(result.mismatches.slice(0, 3))}`,
  );
  // And the check actually compared something, or it would pass vacuously.
  assert.ok(result.checked >= 5, `only ${result.checked} decisions were comparable`);
});

test("the harness is deterministic apart from the plan id", () => {
  const dataset = smallDataset(202);
  const first = runHarness(dataset, FAST_OPTIONS);
  const second = runHarness(dataset, FAST_OPTIONS);

  assert.equal(first.decisions.length, second.decisions.length);
  for (let i = 0; i < first.decisions.length; i++) {
    assert.equal(
      decisionDigest(first.decisions[i]!),
      decisionDigest(second.decisions[i]!),
      `decision ${i} differs between identical runs`,
    );
  }
  // The UUID differs, which is exactly why it is excluded from the digest.
  const armedFirst = first.decisions.find((decision) => decision.armed);
  const armedSecond = second.decisions.find((decision) => decision.armed);
  if (armedFirst && armedSecond) {
    assert.notEqual(armedFirst.plan!.id, armedSecond.plan!.id);
  }
});

test("every decision is evaluated on a bar that exists, and the report agrees", () => {
  const dataset = smallDataset(303);
  const { report, decisions } = runHarness(dataset, FAST_OPTIONS);
  assert.equal(report.metrics.evaluations, decisions.length);
  for (const decision of decisions) {
    assert.ok(decision.evaluatedAt >= dataset.bars[0]![0]!);
    assert.ok(decision.evaluatedAt <= dataset.bars[dataset.bars.length - 1]![0]!);
  }
  assert.ok(report.metrics.evaluations > 0);
  assert.equal(report.metrics.arms, decisions.filter((decision) => decision.armed).length);
});

test("the simulator is only ever handed an already-armed plan", () => {
  const dataset = smallDataset(404);
  const { report } = runHarness(dataset, FAST_OPTIONS);
  // Every replay must correspond to a decision that armed.
  const armedIds = new Set(report.decisions.filter((decision) => decision.armed).map((d) => d.plan!.id));
  for (const trade of report.trades) {
    assert.ok(armedIds.has(trade.planId), `replayed a plan that was never armed: ${trade.planId}`);
  }
});

test("scalp runs exclude the synthetic tick frames an M1 export cannot build", () => {
  assert.deepEqual(framesForMode("scalp"), ["M1", "M2", "M3"]);
  assert.deepEqual(framesForMode("intraday"), ["M5", "M15", "M30"]);
  assert.deepEqual(framesForMode("swing"), ["H1", "H4", "D1", "W1"]);
});

test("metrics are internally consistent", () => {
  const dataset = smallDataset(505);
  const { report } = runHarness(dataset, FAST_OPTIONS);
  const m = report.metrics;
  assert.ok(m.armRate >= 0 && m.armRate <= 1);
  assert.ok(m.fillRate >= 0 && m.fillRate <= 1);
  assert.ok(m.hitRate >= 0 && m.hitRate <= 1);
  assert.equal(m.trades, report.trades.filter((trade) => trade.filled).length);
  assert.ok(m.meanRStdError >= 0);
  assert.ok(m.maxDrawdownR >= 0);
  if (m.trades > 0) {
    const mean = m.totalR / m.trades;
    assert.ok(Math.abs(mean - m.meanR) < 1e-9);
  }
});

test("a dataset shorter than the warm-up evaluates nothing and says so", () => {
  const dataset = driftlessRandomWalk({ symbol: "EURUSD", seed: 606, bars: 300 });
  const { report } = runHarness(dataset, { mode: "intraday", seed: 606, warmupBars: 500 });
  assert.equal(report.metrics.evaluations, 0);
  assert.ok(report.notes.some((note) => note.includes("warm-up")), report.notes.join(" | "));
});

// ── Gate logic ───────────────────────────────────────────────────────────────

function reportStub(overrides: Partial<RunReport["metrics"]> = {}, trades: RunReport["trades"] = []): RunReport {
  return {
    generatedAt: "2024-01-01T00:00:00.000Z",
    harness: "test",
    dataset: "stub",
    symbol: "EURUSD",
    mode: "intraday",
    seed: 1,
    bars: 1_000,
    evaluatedFrom: 0,
    evaluatedTo: 1,
    metrics: {
      evaluations: 100,
      arms: 0,
      fills: 0,
      armRate: 0,
      fillRate: 0,
      trades: 0,
      wins: 0,
      hitRate: 0,
      meanR: 0,
      medianR: 0,
      totalR: 0,
      meanRStdError: 0,
      cvar5R: 0,
      maeMeanR: 0,
      mfeMeanR: 0,
      longestLosingStreak: 0,
      maxDrawdownR: 0,
      costRMean: 0,
      brierScore: null,
      brierSkill: null,
      reliabilityBins: [],
      reliabilitySlope: null,
      probabilisticSharpe: 0,
      deflatedSharpe: 0,
      dsrTrials: 1,
      ...overrides,
    },
    trades,
    decisions: [],
    notes: [],
  };
}

test("the null gate passes a restrained run and fails a trigger-happy one", () => {
  const restrained = evaluateNullGate([reportStub({ armRate: 0.01, evaluations: 1_000, arms: 10 })]);
  assert.equal(restrained.verdict!.passed, true, JSON.stringify(restrained.verdict!.checks));

  const triggerHappy = evaluateNullGate([reportStub({ armRate: 0.2, evaluations: 1_000, arms: 200 })]);
  assert.equal(triggerHappy.verdict!.passed, false);

  // And a run that arms rarely but loses heavily on noise still fails: restraint
  // is not the only requirement.
  const losing = evaluateNullGate([
    reportStub(
      { armRate: 0.02, evaluations: 1_000, arms: 20, trades: 3, costRMean: 0.05 },
      [1, 2, 3].map((n) => ({
        planId: `p${n}`,
        filled: true,
        unfilledReason: null,
        fillTs: n,
        fillPrice: 1,
        realisedR: -0.85,
        exitReason: "stop_loss" as const,
        exitTs: n,
        exitPrice: 1,
        maeR: -1,
        mfeR: 0.1,
        barsHeld: 3,
        actions: [],
        bankedR: 0,
        costR: 0.05,
        costFlipped: false,
      })),
    ),
  ]);
  assert.equal(losing.verdict!.passed, false);
  assert.ok(losing.verdict!.checks.some((check) => check.name === "null_mean_realised_r" && !check.passed));
});

test("the null gate fails a run that manufactures significance", () => {
  const runs = [reportStub({ deflatedSharpe: 0.99 }), reportStub({ deflatedSharpe: 0.5 })];
  const gate = evaluateNullGate(runs);
  assert.equal(gate.verdict!.passed, false);
  assert.ok(
    gate.verdict!.checks.some(
      (check) => check.name === "null_dsr_significant_share" && check.observed === 0.5,
    ),
  );
});

test("the positive-control gate requires both arming AND making money", () => {
  const trade = {
    planId: "p1",
    filled: true,
    unfilledReason: null,
    fillTs: 1,
    fillPrice: 1,
    realisedR: 0.5,
    exitReason: "take_profit" as const,
    exitTs: 2,
    exitPrice: 1,
    maeR: -0.2,
    mfeR: 1,
    barsHeld: 5,
    actions: [],
    bankedR: 0,
    costR: 0.05,
    costFlipped: false,
  };

  // Arms plenty, makes money, and predicts what it gets.
  const passing = evaluatePositiveControlGate([
    {
      ...reportStub({ armRate: 0.2, trades: 1, fills: 1 }),
      decisions: [
        {
          barIndex: 0,
          ts: 1,
          symbol: "EURUSD",
          mode: "intraday",
          armed: true,
          predictedProbability: 0.6,
          predictedExpectancyR: 0.55,
          rewardRiskAtFill: 2.2,
          qualityScore: 70,
          qualityThreshold: 60,
          rejection: null,
          costR: 0.05,
          entryTimeframe: "M15",
          plan: {
            id: "p1",
            side: "buy",
            trigger: 1,
            triggerType: "break",
            sl: 0.99,
            tp: 1.02,
            lots: 0.1,
            riskPoints: 100,
            expiresAt: 10,
            management: {},
            maxSpreadPoints: 10,
          },
        },
      ],
      trades: [trade],
    },
  ]);
  assert.equal(passing.verdict!.passed, true, JSON.stringify(passing.verdict!.checks));

  // The failure mode the null gate alone would reward: never trades.
  const blind = evaluatePositiveControlGate([reportStub({ armRate: 0 })]);
  assert.equal(blind.verdict!.passed, false);
  assert.ok(blind.verdict!.checks.some((check) => check.name === "control_arm_rate" && !check.passed));
});

test("walk-forward folds are purged and embargoed", () => {
  const folds = purgedWalkForward({
    total: 500,
    trainSize: 200,
    testSize: 50,
    horizon: 10,
    embargo: 5,
  });
  assert.ok(folds.length > 0);
  for (const fold of folds) {
    assert.ok(fold.train.every((index) => index + 10 < fold.testFrom), "a training row leaks into the test block");
    assert.ok(fold.train.every((index) => index < fold.testFrom));
    assert.ok(fold.testTo > fold.testFrom);
  }
});

test("CPCV produces several out-of-sample paths and never overlaps a test block", () => {
  const folds = combinatorialPurgedCV({ total: 600, groups: 6, horizon: 5, embargo: 3 });
  assert.equal(folds.length, 20); // C(6,3)
  for (const fold of folds) {
    assert.ok(fold.train.length > 0);
    assert.equal(fold.testRanges.length, 3, "half of six groups are held out");
    // Training rows must not sit inside ANY held-out block. Checking the
    // bounding span instead would be wrong here: the held-out groups are
    // disjoint, and the groups between them are legitimately training data.
    for (const range of fold.testRanges) {
      assert.ok(
        !fold.train.some((index) => index >= range.from && index < range.to),
        `a training row sits inside held-out block ${range.from}-${range.to}`,
      );
    }
  }
});

test("PBO consumes a per-configuration performance matrix", () => {
  const rows: number[][] = [];
  for (let i = 0; i < 240; i++) rows.push([Math.sin(i / 10) * 0.1, Math.cos(i / 7) * 0.1, (i % 5) * 0.01]);
  const result = probabilityOfBacktestOverfitting(rows, 8);
  assert.ok(result.combinations > 0);
  assert.ok(result.pbo >= 0 && result.pbo <= 1);
  assert.equal(result.logits.length, result.combinations);
});

test("computeMetrics counts streaks and drawdown on the R series", () => {
  const trades = [1, -1, -1, -1, 2, -1].map((r, index) => ({
    planId: `p${index}`,
    filled: true,
    unfilledReason: null,
    fillTs: index,
    fillPrice: 1,
    realisedR: r,
    exitReason: "stop_loss" as const,
    exitTs: index,
    exitPrice: 1,
    maeR: 0,
    mfeR: 0,
    barsHeld: 1,
    actions: [],
    bankedR: 0,
    costR: 0,
    costFlipped: false,
  }));
  const metrics = computeMetrics({ decisions: [], trades, dsrTrials: 1 });
  assert.equal(metrics.trades, 6);
  assert.equal(metrics.longestLosingStreak, 3);
  assert.equal(metrics.totalR, -1);
  assert.equal(metrics.wins, 2);
  assert.ok(metrics.maxDrawdownR >= 3);
});

test("gate thresholds are the ones the spec states", () => {
  assert.equal(GATE_THRESHOLDS.nullMaxArmRate, 0.03);
  assert.equal(GATE_THRESHOLDS.nullCostSlackR, 0.05);
  assert.equal(GATE_THRESHOLDS.controlMinArmRate, 0.1);
  assert.equal(GATE_THRESHOLDS.controlMinMeanR, 0.3);
  assert.equal(GATE_THRESHOLDS.controlMaxExpectancyGapR, 0.15);
  assert.equal(GATE_THRESHOLDS.calibrationSlopeMin, 0.8);
  assert.equal(GATE_THRESHOLDS.calibrationSlopeMax, 1.2);
});

test("the positive control is detectable by the harness at all", () => {
  // Not a gate — a liveness check on the harness itself. If the desk cannot arm
  // on a dataset built to contain a persistent edge, then the harness is not
  // measuring what the control gate thinks it is measuring.
  const dataset = positiveControl({ symbol: "EURUSD", seed: 707, bars: 12_000 });
  const { report } = runHarness(dataset, { mode: "intraday", seed: 707, stepBars: 40, warmupBars: 600 });
  assert.ok(report.metrics.arms > 0, "the desk did not arm once on the positive control");
});
