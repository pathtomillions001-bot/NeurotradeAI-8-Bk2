/**
 * WP2 — harness and gate tests.
 *
 * The gates are the part of this project that decides whether a configuration
 * is allowed out of shadow mode, so their DIRECTION is tested as carefully as
 * their arithmetic: a gate that cannot fail is worse than no gate at all,
 * because it produces a green light that means nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { generate } from "./generators";
import {
  calibrationGates,
  controlGates,
  legacyDeskStrategy,
  nullGates,
  nullSignificanceRate,
  runHarness,
  type HarnessRun,
  type Strategy,
} from "./harness";
import { framesForMode, parseArgs } from "./cli";
import { specForSymbol } from "./specs";
import { tradeStats } from "./metrics";
import type { Bar } from "../types";

const W = 15 * 60_000;
const START = Date.UTC(2026, 0, 5);
const { spec } = specForSymbol("EURUSD", { spreadPoints: 10 });

/** A strategy that never arms — the null behavioural baseline. */
const silent: Strategy = { id: "silent", decide: () => null };

function runNaive(frames: Partial<Record<"M15", Bar[]>>, strategy: Strategy): HarnessRun {
  return runHarness({
    frames,
    symbol: "EURUSD",
    strategy,
    options: { spec, mode: "intraday", stride: 25, warmupBars: 100, horizonBars: 25 },
  });
}

function flatRun(overrides: Partial<HarnessRun> = {}): HarnessRun {
  const stats = tradeStats([]);
  return {
    strategy: "silent",
    symbol: "EURUSD",
    mode: "intraday",
    evaluations: 100,
    arms: 0,
    armRate: 0,
    fills: 0,
    fillRate: 0,
    trades: [],
    stats,
    lowerBoundMeanR: 0,
    dsr: 0,
    meanPredicted: 0,
    predictedVsRealised: 0,
    ...overrides,
  };
}

// ── Gate direction ──────────────────────────────────────────────────────────

test("a strategy that never arms passes every null gate — and fails the control", () => {
  const run = flatRun();
  const nulls = nullGates(run, 0.05);
  assert.ok(nulls.pass, "doing nothing must not fail the null gates");
  assert.ok(nulls.gates.every((g) => g.pass));

  const control = controlGates(run);
  assert.equal(control.pass, false, "doing nothing must fail the positive control");
  assert.equal(control.gates.find((g) => g.gate.includes("arm rate"))?.pass, false);
});

test("an armed strategy losing more than the cost of trading fails the null gate", () => {
  // 40 arms in 100 evaluations, mean −0.45R: exactly the v3 desk's null result.
  const stats = tradeStats([...Array(20)].map(() => ({ r: -0.45, maeR: 1, mfeR: 0.4, bars: 10 })));
  const run = flatRun({ arms: 40, armRate: 0.4, fills: 20, stats, lowerBoundMeanR: -0.9 });
  const nulls = nullGates(run, 0.05);
  assert.equal(nulls.pass, false);
  const armGate = nulls.gates.find((g) => g.gate.includes("arm rate"));
  const edgeGate = nulls.gates.find((g) => g.gate.includes("mean realised R"));
  assert.equal(armGate?.pass, false);
  assert.equal(edgeGate?.pass, false);
  assert.ok((edgeGate?.threshold as number) < 0);
});

test("a DSR-significant result on noise fails the 'not significant' gate", () => {
  const run = flatRun({ arms: 30, armRate: 0.05, fills: 10, dsr: 0.97 });
  assert.equal(nullGates(run, 0.05).pass, false);
  assert.ok(nullSignificanceRate([run]) === 1);
  assert.equal(nullSignificanceRate([]), 0);
});

test("calibration gates fail when the slope cannot be measured", () => {
  // "We could not measure it" must never read as "it is calibrated".
  const unidentifiable = calibrationGates({ reliabilitySlope: 128_000, brierSkill: -1.2, samples: 300, slopeIdentifiable: false });
  assert.equal(unidentifiable.pass, false);
  assert.ok(unidentifiable.gates[0]?.detail.includes("UNIDENTIFIABLE"));

  const tooFew = calibrationGates({ reliabilitySlope: 1.0, brierSkill: 0.2, samples: 29, slopeIdentifiable: true });
  assert.equal(tooFew.pass, false);
  assert.ok(tooFew.gates[0]?.detail.includes("not enough"));

  const calibrated = calibrationGates({ reliabilitySlope: 0.95, brierSkill: 0.12, samples: 300, slopeIdentifiable: true });
  assert.ok(calibrated.pass);

  const overconfident = calibrationGates({ reliabilitySlope: 0.55, brierSkill: 0.12, samples: 300, slopeIdentifiable: true });
  assert.equal(overconfident.pass, false, "a slope of 0.55 is outside the acceptance band");

  const noSkill = calibrationGates({ reliabilitySlope: 1.0, brierSkill: -0.01, samples: 300, slopeIdentifiable: true });
  assert.equal(noSkill.pass, false, "a negative Brier skill must fail even with a perfect slope");
});

// ── Harness mechanics ───────────────────────────────────────────────────────

test("an empty frame band produces an empty run rather than throwing", () => {
  const run = runHarness({ frames: {}, symbol: "EURUSD", strategy: silent, options: { spec, mode: "intraday" } });
  assert.equal(run.evaluations, 0);
  assert.equal(run.arms, 0);
  assert.equal(run.stats.trades, 0);
});

test("the arm rate is measured against evaluations, and every arm is simulated", () => {
  const bars = generate("positive-control", { seed: 8, bars: 500, timeframeMs: W, startMs: START }).bars;
  const run = runNaive({ M15: bars }, legacyDeskStrategy("desk-v3"));
  assert.ok(run.evaluations > 10);
  assert.ok(run.arms >= 1, `the positive control should arm at least once (got ${run.arms})`);
  assert.ok(run.fills <= run.arms, "fills can never exceed arms");
  assert.equal(run.armRate, run.arms / run.evaluations);
  assert.ok(Number.isFinite(run.stats.meanR));
});

test("a decision strategy sees no bar that has not closed yet", () => {
  const bars = generate("driftless", { seed: 12, bars: 300, timeframeMs: W, startMs: START }).bars;
  let checked = 0;
  const inspector: Strategy = {
    id: "inspector",
    decide(ctx) {
      // The rule: every visible bar must have closed at or before now.
      const t = ctx.now;
      for (const frame of Object.values(ctx.series)) {
        for (const bar of frame as Bar[]) {
          assert.ok((bar[0] as number) < t + 1, `bar at ${bar[0]} was visible at ${t} — lookahead`);
          checked++;
        }
      }
      return null;
    },
  };
  runNaive({ M15: bars }, inspector);
  assert.ok(checked > 100);
});

// ── CLI plumbing ────────────────────────────────────────────────────────────

test("parseArgs: defaults, overrides and refusal of an unknown mode", () => {
  const defaults = parseArgs(["--mode", "intraday", "--data", "synthetic:null"]);
  assert.equal(defaults.mode, "intraday");
  assert.equal(defaults.seed, 1);
  assert.equal(defaults.runs, 8);
  assert.equal(defaults.symbol, "EURUSD");
  assert.equal(defaults.spec.spec.assetClass, "forex");

  const overridden = parseArgs([
    "--mode", "swing", "--data", "./EURUSD_M1.csv", "--symbol", "XAUUSD",
    "--server-offset-minutes", "180", "--seed", "7", "--spread", "35", "--commission", "7",
  ]);
  assert.equal(overridden.mode, "swing");
  assert.equal(overridden.serverOffsetMinutes, 180);
  assert.equal(overridden.seed, 7);
  assert.equal(overridden.spec.spec.assetClass, "metals");
  assert.equal(overridden.spec.spec.spreadPoints, 35);
  assert.equal(overridden.spec.spec.commissionPerLot, 7);

  assert.throws(() => parseArgs(["--mode", "turbo"]), /--mode must be/);
});

test("framesForMode builds the mode's own band, never a faster invented one", () => {
  // Fifteen hours of M1 bars — enough for the band's slowest frame (M30) to
  // have the 30 bars a frame needs before it may be scored.
  const m1: Bar[] = [...Array(900)].map((_, i) => [START + i * 60_000, 1.1, 1.1001, 1.0999, 1.1, 1]);
  const intraday = framesForMode("intraday", m1, "M1");
  assert.deepEqual(Object.keys(intraday).sort(), ["M15", "M5", "M30"].sort());
  assert.equal(intraday.M5?.length, 180);
  assert.equal(intraday.M15?.length, 60);
  assert.equal(intraday.M30?.length, 30);

  // A scalp band is S10…M3. From a MINUTE file the sub-minute frames cannot be
  // built — nothing faster than the source is ever fabricated — so S10 and S30
  // are absent and the band is covered as far as the data honestly allows.
  const scalp = framesForMode("scalp", m1, "M1");
  assert.deepEqual(Object.keys(scalp).sort(), ["M1", "M2", "M3"]);
  assert.equal(Object.keys(scalp).includes("S10"), false, "sub-minute bars must never be invented from minute bars");
  assert.equal(Object.keys(scalp).includes("S30"), false);
});
