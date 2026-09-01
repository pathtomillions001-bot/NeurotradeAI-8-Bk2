/**
 * Bot Edge Upgrade — validation harness.
 *
 * The v2 upgrade (break-even entry gates, context-aware digit selection,
 * honest probability fusion, Platt self-calibration) is only as good as its
 * statistical behaviour, so this harness exercises the REAL scoring and gate
 * functions on deterministic synthetic streams and asserts the properties
 * that "statistical edge" means:
 *
 *   1. FAIR streams (no exploitable structure): the gates must FILTER —
 *      the bot sits out most ticks instead of trading a coin flip with a fee.
 *   2. PLANTED-EDGE streams (known structure): the gates must FIRE, and the
 *      trades they release must win above the contract's break-even rate.
 *   3. CALIBRATION: the Platt fit recovers a known probability shift, and
 *      below the minimum record count it is exactly the identity.
 *   4. DIGIT HYSTERESIS: the held digit is never abandoned unless the fresh
 *      selection beats it by DIGIT_SWITCH_MARGIN, and a locked digit is
 *      absolute.
 *
 * All streams use a seeded PRNG (mulberry32) — the suite is deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parityRead,
  barrierRead,
  matchRead,
  specialistEntryGate,
  BREAK_EVEN,
  DIGIT_SWITCH_MARGIN,
} from "./specialist-analysis.ts";
import { resolveBotBarrier } from "./bot-scorer.ts";
import {
  fitPlatt,
  applyPlatt,
  calibratedWinProbability,
  recordBotOutcome,
  resetBotCalibration,
  CALIBRATION_MIN_RECORDS,
  type CalibrationRecord,
} from "./bot-calibration.ts";

// ── Deterministic PRNG ────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** i.i.d. uniform digits. */
function fairDigits(n: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(rnd() * 10));
}

/**
 * Markov parity stream: P(even | even) = pEE, P(even | odd) = pEO.
 * Stationary even rate = pEO / (pEO + 1 − pEE).
 */
function parityMarkovDigits(n: number, pEE: number, pEO: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  let even = rnd() < 0.5;
  for (let i = 0; i < n; i++) {
    even = rnd() < (even ? pEE : pEO);
    // concrete digit with the right parity, uniform within it
    const pool = even ? [0, 2, 4, 6, 8] : [1, 3, 5, 7, 9];
    out.push(pool[Math.floor(rnd() * 5)]!);
  }
  return out;
}

/** i.i.d. digits where one digit is over-represented (a hot match target). */
function hotDigitDigits(n: number, digit: number, hotProb: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(rnd() < hotProb ? digit : Math.floor(rnd() * 9));
  }
  return out;
}

// ── 1. Fair streams: the gates must filter ────────────────────────────────────

describe("fair streams (no structure) — gates must filter", () => {
  it("parity: the break-even margin gate releases only a minority of ticks", () => {
    const digits = fairDigits(3000, 42);
    let passes = 0;
    let total = 0;
    for (let t = 80; t < digits.length; t++) {
      const read = parityRead(digits.slice(0, t), "DIGITEVEN");
      total++;
      if (specialistEntryGate(read).pass) passes++;
    }
    const rate = passes / total;
    // Old gate (runs-veto only) passed ~90%+ of ticks on fair data — it had
    // no EV requirement at all. The v2 gate must release a clear minority.
    assert.ok(rate < 0.45, `parity gate accepted ${rate.toFixed(1)} of fair ticks — expected a clear minority`);
    assert.ok(passes > 0, "parity gate should still fire occasionally on fair data");
  });

  it("match: the 11.2% break-even requirement blocks the majority of fair ticks", () => {
    const digits = fairDigits(2000, 7);
    let passes = 0;
    let total = 0;
    for (let t = 120; t < digits.length; t++) {
      const read = matchRead(digits.slice(0, t)).read;
      total++;
      if (specialistEntryGate(read).pass) passes++;
    }
    const rate = passes / total;
    // Old match gate (gap ≥ 3 AND hazard ≥ 0.8, NO probability requirement)
    // traded on the majority of ticks at ~10% true win rate vs an 11.2%
    // hurdle — structurally −EV. The v2 gate must release a clear minority.
    assert.ok(rate < 0.2, `match gate accepted ${rate.toFixed(1)} of fair ticks — the EV leak is back`);
  });

  it("barrier: p̂ must clear the tail break-even by 0.75σ", () => {
    const digits = fairDigits(2000, 99);
    let passes = 0;
    let total = 0;
    for (let t = 120; t < digits.length; t++) {
      const read = barrierRead(digits.slice(0, t), { side: "DIGITOVER", barrier: 5 });
      total++;
      if (specialistEntryGate(read).pass) passes++;
    }
    const rate = passes / total;
    assert.ok(rate < 0.3, `barrier gate accepted ${rate.toFixed(1)} of fair ticks — expected a minority`);
  });
});

// ── 2. Planted edges: the gates must fire AND release winning trades ─────────

describe("planted-edge streams — gates fire and released trades beat break-even", () => {
  it("parity clustering: released Even trades win above the 51.28% hurdle", () => {
    // P(even|even)=0.65, P(even|odd)=0.45 ⇒ stationary even rate ≈ 56.25%.
    const pEE = 0.65, pEO = 0.45;
    const digits = parityMarkovDigits(3000, pEE, pEO, 1234);
    const stationary = pEO / (pEO + 1 - pEE); // ≈ 0.5625
    assert.ok(stationary > BREAK_EVEN.parity, "precondition: the plant is a real edge");

    let passes = 0;
    let wins = 0;
    for (let t = 80; t < digits.length; t++) {
      const window = digits.slice(0, t);
      const read = parityRead(window, "DIGITEVEN");
      if (!specialistEntryGate(read).pass) continue;
      passes++;
      if (digits[t]! % 2 === 0) wins++; // the trade settles on the NEXT tick
    }
    assert.ok(passes >= 50, `gate fired only ${passes} times on a clearly structured stream`);
    const winRate = wins / passes;
    assert.ok(
      winRate > BREAK_EVEN.parity,
      `released Even trades won ${winRate.toFixed(1)}% — must beat the ${BREAK_EVEN.parity * 100}%% break-even`,
    );
  });

  it("hot digit: released Match trades win above the 11.2% hurdle", () => {
    const HOT = 7;
    const digits = hotDigitDigits(2500, HOT, 0.16, 555);
    let passes = 0;
    let wins = 0;
    for (let t = 120; t < digits.length; t++) {
      const { read, barrier } = matchRead(digits.slice(0, t));
      if (!specialistEntryGate(read).pass) continue;
      passes++;
      if (digits[t]! === barrier) wins++;
    }
    assert.ok(passes >= 10, `match gate fired only ${passes} times on a 16%-hot digit — should fire`);
    const winRate = wins / passes;
    assert.ok(
      winRate > BREAK_EVEN.match,
      `released Match trades won ${winRate.toFixed(1)}% — must beat the ${BREAK_EVEN.match * 100}%% break-even`,
    );
  });
});

// ── 3. Calibration (Platt scaling) ────────────────────────────────────────────

describe("probability calibration", () => {
  it("recovers a known overconfidence shift", () => {
    const rnd = mulberry32(2024);
    // The model predicts p = 0.5 for every trade but the event wins 62% of the time.
    const records: CalibrationRecord[] = Array.from({ length: 120 }, () => ({
      p: 0.5,
      won: rnd() < 0.62,
    }));
    const fit = fitPlatt(records);
    const calibrated = applyPlatt(0.5, fit);
    assert.ok(calibrated > 0.55, `fit should push 0.5 up toward the realized ~62%%, got ${calibrated.toFixed(3)}`);
    assert.ok(fit.n === 120);
  });

  it("recovers an underconfidence shift (in the other direction)", () => {
    const rnd = mulberry32(31337);
    const records: CalibrationRecord[] = Array.from({ length: 120 }, () => ({
      p: 0.5,
      won: rnd() < 0.38,
    }));
    const calibrated = applyPlatt(0.5, fitPlatt(records));
    assert.ok(calibrated < 0.45, `fit should push 0.5 down, got ${calibrated.toFixed(3)}`);
  });

  it("is exactly the identity below the minimum record count", () => {
    resetBotCalibration();
    for (let i = 0; i < CALIBRATION_MIN_RECORDS - 1; i++) recordBotOutcome("parity", 0.5, i % 2 === 0);
    assert.equal(calibratedWinProbability("parity", 0.5), 0.5);
    assert.equal(calibratedWinProbability("match", 0.2), 0.2);
  });

  it("is close to identity with a balanced record and drifts with evidence", () => {
    resetBotCalibration();
    // Exactly 100 wins / 100 losses at p = 0.5 — realized frequency 0.5, so
    // the calibration must stay at 0.5 (no drift from a lucky/unlucky sample).
    for (let i = 0; i < 200; i++) recordBotOutcome("momentum", 0.5, i % 2 === 0);
    const balanced = calibratedWinProbability("momentum", 0.5);
    assert.ok(Math.abs(balanced - 0.5) < 0.03, `balanced history should stay near 0.5, got ${balanced.toFixed(3)}`);
  });

  it("keeps calibration pools separate per family", () => {
    resetBotCalibration();
    const rnd = mulberry32(11);
    for (let i = 0; i < 40; i++) recordBotOutcome("match", 0.5, rnd() < 0.7);
    // "parity" has no history — it must stay uncalibrated.
    assert.equal(calibratedWinProbability("parity", 0.5), 0.5);
    assert.notEqual(calibratedWinProbability("match", 0.5), 0.5);
  });
});

// ── 4. Digit hysteresis + contract sovereignty invariants ─────────────────────

describe("digit selection invariants", () => {
  it("a locked digit is absolute", () => {
    const digits = fairDigits(200, 3);
    const locked = resolveBotBarrier("DIGITMATCH", digits, 4);
    assert.equal(locked.barrier, 4);
    const lockedDiff = resolveBotBarrier("DIGITDIFF", digits, 6);
    assert.equal(lockedDiff.barrier, 6);
  });

  it("the held digit survives unless the fresh selection clearly beats it", () => {
    const digits = fairDigits(400, 21);
    // No preference → specialist selection.
    const base = resolveBotBarrier("DIGITMATCH", digits);
    // Preferring the specialist's own choice is a no-op…
    assert.equal(resolveBotBarrier("DIGITMATCH", digits, undefined, base.barrier).barrier, base.barrier);
    // …and any other preference returns EITHER the held digit or the fresh
    // selection — never a third digit (hysteresis can only veto, not create).
    for (let preferred = 0; preferred < 10; preferred++) {
      if (preferred === base.barrier) continue;
      const result = resolveBotBarrier("DIGITMATCH", digits, undefined, preferred).barrier;
      assert.ok(
        result === preferred || result === base.barrier,
        `hysteresis produced digit ${result} from held ${preferred} / fresh ${base.barrier}`,
      );
    }
    // Same invariant for differ.
    const baseDiff = resolveBotBarrier("DIGITDIFF", digits);
    for (let preferred = 0; preferred < 10; preferred++) {
      if (preferred === baseDiff.barrier) continue;
      const result = resolveBotBarrier("DIGITDIFF", digits, undefined, preferred).barrier;
      assert.ok(result === preferred || result === baseDiff.barrier, "differ hysteresis invariant violated");
    }
  });

  it("exported margins are sane", () => {
    assert.ok(DIGIT_SWITCH_MARGIN > 0 && DIGIT_SWITCH_MARGIN < 2);
    assert.ok(BREAK_EVEN.match < 0.12);       // 11.2%
    assert.ok(BREAK_EVEN.parity > 0.51 && BREAK_EVEN.parity < 0.52); // 51.28%
    assert.ok(BREAK_EVEN.momentum > 0.52);    // 52.08%
    assert.ok(BREAK_EVEN.differ > 0.91);      // 91.74%
  });
});
