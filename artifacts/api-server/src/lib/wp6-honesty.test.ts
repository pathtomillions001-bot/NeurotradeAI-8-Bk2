/**
 * WP6 — statistical honesty battery.
 *
 * Acceptance:
 *  - battery tests behave (χ²/normal/runs sanity; catch planted bias);
 *  - BH controls false discoveries on honest tapes;
 *  - the anytime-valid e-process stays small on fair data and lights up on a
 *    planted edge;
 *  - tilt activates on planted edge, is bounded (margin weight ≥ 0.5, never a
 *    stake increase), auto-disables, obeys the kill switch;
 *  - on i.i.d. data tilt is active in ≤ 5 % of runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chiSquareUniformity,
  serialCorrelation,
  transitionChiSquare,
  runsTest,
  riseFallRunsTest,
  digitBattery,
  benjaminiHochberg,
  chiSquarePValue,
  normalTwoSidedP,
  createEProcess,
  stepEProcess,
  tiltGate,
  TILT_EVIDENCE_ON,
  TILT_EVIDENCE_OFF,
  TILT_FLOOR,
} from "../lib/autonomous-hedge/statistical-honesty";
import { HonestyMonitor } from "../lib/autonomous-hedge/honesty-monitor";
import { mulberry32 } from "../lib/autonomous-hedge/research/rng";

function iidDigits(seed: number, n: number, bias?: { digit: number; extra: number }): number[] {
  const rng = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let d = Math.floor(rng.next() * 10);
    if (bias && rng.next() < bias.extra) d = bias.digit;
    out.push(d);
  }
  return out;
}

test("WP6: special functions sanity", () => {
  // χ²(df=9) 95th percentile ≈ 16.92.
  assert.ok(Math.abs(chiSquarePValue(16.919, 9) - 0.05) < 0.003);
  // Normal two-sided: z = 1.96 ≈ 5 %.
  assert.ok(Math.abs(normalTwoSidedP(1.96) - 0.05) < 0.003);
  assert.ok(normalTwoSidedP(0) > 0.99);
});

test("WP6: battery passes on honest i.i.d. tape, fails on planted bias", () => {
  const honest = iidDigits(1, 6000);
  const report = digitBattery(honest);
  assert.ok(report.tests.length >= 8); // uniformity + 5 lags + transition + runs
  const failed = report.tests.filter((t) => !t.pass);
  assert.ok(failed.length <= 1, `honest tape should not fail >1 test, failed: ${failed.map((f) => f.name)}`);

  const biased = iidDigits(2, 6000, { digit: 7, extra: 0.06 });
  const uni = chiSquareUniformity(biased);
  assert.equal(uni.pass, false, "planted digit bias must be caught by uniformity");

  const serial = iidDigits(3, 6000);
  // Force lag-1 correlation: copy the previous digit half the time.
  for (let i = 1; i < serial.length; i++) if (i % 2 === 0) serial[i] = serial[i - 1];
  const lag1 = serialCorrelation(serial)[0];
  assert.equal(lag1.pass, false, "planted serial dependence must be caught");
});

test("WP6: transition matrix catches a Markov-rigged tape", () => {
  // A tape where 9 always follows 0 (transition dependence, still uniform-ish).
  const rng = mulberry32(4);
  const digits: number[] = [Math.floor(rng.next() * 10)];
  for (let i = 1; i < 8000; i++) {
    const prev = digits[i - 1];
    digits.push(prev === 0 ? 9 : Math.floor(rng.next() * 10));
  }
  const t = transitionChiSquare(digits);
  assert.equal(t.pass, false);
});

test("WP6: runs tests reject alternation rigging", () => {
  const alternating: boolean[] = [];
  for (let i = 0; i < 4000; i++) alternating.push(i % 2 === 0);
  assert.equal(runsTest(alternating).pass, false);
  const prices: number[] = [];
  let p = 100;
  for (let i = 0; i < 4000; i++) { p += i % 2 === 0 ? 1 : -0.1; prices.push(p); }
  assert.equal(riseFallRunsTest(prices).pass, false);
});

test("WP6: BH finds nothing on honest p-value batches, finds planted signals", () => {
  const rng = mulberry32(5);
  const honest = Array.from({ length: 40 }, () => Math.max(1e-6, rng.next())); // uniform(0,1)
  const { significant } = benjaminiHochberg(honest, 0.10);
  assert.ok(significant.filter(Boolean).length <= 4, "BH must not over-discover on honest batches");

  const withSignal = [...honest];
  withSignal[7] = 1e-9;
  const s2 = benjaminiHochberg(withSignal, 0.10);
  assert.equal(s2.significant[7], true);
});

test("WP6: e-process stays small on fair data, explodes on planted edge", () => {
  const rng = mulberry32(6);
  const fair = createEProcess(0.5);
  for (let i = 0; i < 2000; i++) stepEProcess(fair, rng.next() < 0.5);
  assert.ok(fair.e < TILT_EVIDENCE_ON, `fair e-value must stay under ${TILT_EVIDENCE_ON}, got ${fair.e}`);

  const rigged = createEProcess(0.5);
  for (let i = 0; i < 2000; i++) stepEProcess(rigged, rng.next() < 0.56);
  assert.ok(rigged.e >= TILT_EVIDENCE_ON, `planted 56% edge must reach e ≥ ${TILT_EVIDENCE_ON}, got ${rigged.e}`);
});

test("WP6: tilt gate — activation, bound, hysteresis, kill switch", () => {
  const off = tiltGate({ eValue: 1000, batterySignificant: true, currentlyActive: false, enabled: false });
  assert.equal(off.active, false, "kill switch must veto tilt");
  assert.equal(off.marginWeightFactor, 1);

  const needsBoth = tiltGate({ eValue: 1000, batterySignificant: false, currentlyActive: false, enabled: true });
  assert.equal(needsBoth.active, false, "e alone must not tilt without a BH-significant battery");

  const on = tiltGate({ eValue: TILT_EVIDENCE_ON, batterySignificant: true, currentlyActive: false, enabled: true });
  assert.equal(on.active, true);
  assert.ok(on.marginWeightFactor >= TILT_FLOOR && on.marginWeightFactor <= 1, "tilt is bounded and never amplifies");

  const hold = tiltGate({ eValue: 0.04, batterySignificant: true, currentlyActive: true, enabled: true });
  assert.equal(hold.active, false, "e < 1/20 must auto-disable an active tilt");
  const hold2 = tiltGate({ eValue: 5, batterySignificant: true, currentlyActive: true, enabled: true });
  assert.equal(hold2.active, true, "hysteresis: between 1/20 and 20 the tilt holds");
  const batteryGone = tiltGate({ eValue: 100, batterySignificant: false, currentlyActive: true, enabled: true });
  assert.equal(batteryGone.active, false, "a clean battery must also release the tilt");
});

test("WP6: on i.i.d. data tilt activates in ≤ 5% of runs", () => {
  let activations = 0;
  const runs = 200;
  for (let r = 0; r < runs; r++) {
    const rng = mulberry32(1000 + r);
    const digits = iidDigits(2000 + r, 5000);
    const report = digitBattery(digits);
    const { significant } = benjaminiHochberg(report.tests.map((t) => t.pValue), 0.10);
    const batterySig = significant.some(Boolean);
    const e = createEProcess(0.5);
    let maxE = 1;
    for (let i = 0; i < 800; i++) { stepEProcess(e, rng.next() < 0.5); maxE = Math.max(maxE, e.e); }
    const gate = tiltGate({ eValue: maxE, batterySignificant: batterySig, currentlyActive: false, enabled: true });
    if (gate.active) activations += 1;
  }
  const rate = activations / runs;
  assert.ok(rate <= 0.05, `tilt active on ${(rate * 100).toFixed(1)}% of i.i.d. runs — must be ≤ 5%`);
});

test("WP6: monitor end-to-end — planted edge activates the bounded tilt", () => {
  const mon = new HonestyMonitor(true);
  // A rigged market: digit 7 over-represented (breaks the battery).
  const digits = iidDigits(9, 6000, { digit: 7, extra: 0.05 });
  mon.ingestTape("RG_TEST", digits, digits.map(Number), digits.length);
  const snap = mon.snapshot("RG_TEST");
  assert.ok(snap && snap.ticks === 6000);
  assert.equal(snap!.batterySignificant, true, "rigged market battery must be BH-significant");

  // Feed the Even-contract outcomes with a planted 60% hit rate (p0 = 0.5).
  const rng = mulberry32(11);
  for (let i = 0; i < 1500; i++) mon.recordOutcome("RG_TEST", "DIGITEVEN", 0.5, rng.next() < 0.6);
  const factor = mon.marginWeightFactor("RG_TEST", "DIGITEVEN");
  assert.ok(factor < 1, "planted edge + significant battery must reduce the margin weight");
  assert.ok(factor >= TILT_FLOOR, "reduction is bounded below by the floor");

  // Kill switch restores factor 1 everywhere.
  mon.setEnabled(false);
  assert.equal(mon.marginWeightFactor("RG_TEST", "DIGITEVEN"), 1);
});

test("WP6: monitor dedupes rolling tape windows", () => {
  const mon = new HonestyMonitor(true);
  const W = 120;
  const stream = iidDigits(12, 600);
  for (let t = W; t <= stream.length; t++) {
    mon.ingestTape("R_DEDUPE", stream.slice(t - W, t), stream.slice(t - W, t).map(Number), t);
  }
  const snap = mon.snapshot("R_DEDUPE");
  assert.ok(snap && snap.ticks === stream.length, `expected ${stream.length} unique ticks, got ${snap?.ticks}`);
});
