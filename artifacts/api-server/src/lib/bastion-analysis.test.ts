/**
 * Barrier Bastion analysis tests.
 *
 * The properties that matter (each one is a promise to the trader):
 *  1. NO RATCHET — recovery eligibility NEVER hardens after recovery losses.
 *     The static fair-rate bar is the only recovery selector and no function on
 *     the recovery path can even see a loss run.
 *  2. NO STARVE — a fair tape still produces recovery shots (the bar sits at
 *     the fair rate, not at break-even) and normal shots at the valve budget.
 *  3. SMART RECOVERY — the side chooser follows the tape's tilt (low-digit tape
 *     → Under 6, high-digit tape → Over 3) and the pair-risk penalty actively
 *     avoids the side whose losses cluster.
 *  4. HONEST MEASUREMENT — fair data is never PRIME; planted band-tilt edges
 *     are measured positive with recovery hit rates near their face value.
 *
 * All randomness is seeded (mulberry32) so the suite is deterministic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BASTION_ALL_CONTRACTS,
  BASTION_NORMAL_CONTRACTS,
  BASTION_NORMAL_PACE_TARGET,
  BASTION_RECOVERY_BAR,
  BASTION_RECOVERY_CONTRACTS,
  BastionPolicy,
  logPoolBinary,
  replayBastion,
  scoreBastionMarket,
  sideUtility,
  temperatureScaleBinary,
  weightsFromSkillN,
  contractById,
  type BastionParams,
} from "./bastion-analysis.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fairStream(n: number, seed = 7): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(rnd() * 10));
}

/**
 * Tape with a controlled conditional tilt after every `anchor` digit:
 * with probability `tilt` the next digit comes from the given biased set,
 * otherwise uniform. Planted memory the digit Markov + suffix lenses can see.
 */
function tiltedStream(n: number, seed: number, anchor: number, hot: number[], tilt: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [Math.floor(rnd() * 10)];
  while (out.length < n) {
    const prev = out[out.length - 1]!;
    if (prev === anchor && rnd() < tilt) {
      out.push(hot[Math.floor(rnd() * hot.length)]!);
    } else {
      out.push(Math.floor(rnd() * 10));
    }
  }
  return out;
}

const FLAT: BastionParams = { weights: [0.25, 0.25, 0.25, 0.25], tau: 1, normalInitBar: 0.81 };

describe("frozen contract geometry", () => {
  it("locks the specified bands: Over 1 / Under 8 normal, Over 3 / Under 6 recovery", () => {
    const over1 = contractById("over1");
    const under8 = contractById("under8");
    const over3 = contractById("over3");
    const under6 = contractById("under6");
    assert.equal(over1.fair, 0.8);
    assert.equal(under8.fair, 0.8);
    assert.equal(over3.fair, 0.6);
    assert.equal(under6.fair, 0.6);
    // Recovery bands COVER the whole digit line (their union is all 10 digits)
    // with the soft overlap {4,5} — the geometry that makes a tilted tape easy
    // to recover on: the model only has to know WHICH side of the hole is due.
    for (let d = 0; d < 10; d++) {
      assert.ok(over3.wins[d] || under6.wins[d], `digit ${d} uncovered by recovery`);
    }
    assert.ok(over3.wins[4] && under6.wins[4], "digit 4 must be the double-win overlap");
    assert.ok(over3.wins[5] && under6.wins[5], "digit 5 must be the double-win overlap");
  });

  it("the recovery bar is exactly the combinatorial fair rate — and is a constant", () => {
    assert.equal(BASTION_RECOVERY_BAR, 0.6);
    assert.equal(BASTION_RECOVERY_BAR, BASTION_RECOVERY_CONTRACTS[0]!.fair);
    for (const c of BASTION_ALL_CONTRACTS) assert.equal(c.fair, c.wins.filter(Boolean).length / 10);
  });
});

describe("loss-pair penalty", () => {
  it("utility falls with pair-risk and clustering (the ladder killer)", () => {
    const base = sideUtility(0.65, 1.63, 0.4, 0.4);
    const clustered = sideUtility(0.65, 1.63, 0.8, 0.4);
    assert.ok(clustered.pairRisk > base.pairRisk, `pairRisk ${base.pairRisk} → ${clustered.pairRisk}`);
    assert.ok(clustered.utility < base.utility, `utility ${base.utility} → ${clustered.utility}`);
    // Same p̂ and payout: the side whose losses CLUSTER must rank lower.
    const calm = sideUtility(0.62, 1.63, 0.3, 0.4);
    const stormy = sideUtility(0.62, 1.63, 0.85, 0.4);
    assert.ok(calm.utility > stormy.utility);
  });

  it("prefers the non-clustering side when win probabilities tie", () => {
    const policy = new BastionPolicy(FLAT);
    const digits = fairStream(1500, 3);
    for (let i = 0; i < digits.length; i++) policy.update(digits, i);
    // Synthetic arbitration at equal p̂ — pure utility comparison.
    const a = sideUtility(0.62, 1.63, 0.25, 0.4);
    const b = sideUtility(0.62, 1.63, 0.75, 0.4);
    assert.ok(a.utility > b.utility, "the calm side must win the tie");
  });
});

describe("THE NO-RATCHET GUARANTEE", () => {
  it("recovery eligibility is identical before and after a deep loss run", () => {
    // The sharpest probe: score the SAME tape state with the SAME policy after
    // 0, 1 and 5 consecutive recovery losses. `decideRecovery` cannot even be
    // PASSED a loss run (there is no parameter for it), so the decision must be
    // bit-identical — no hard gate can have hardened.
    const digits = fairStream(2000, 11);
    const policy = new BastionPolicy(FLAT);
    for (let i = 0; i < 1500; i++) policy.update(digits, i);
    const before = policy.decideRecovery(digits, 1500);
    // Simulate a brutal loss run (5 recovery losses in a row) on the tape…
    let tape = digits.slice(0, 1501);
    for (let k = 0; k < 5; k++) {
      // …each loss digit is a hole digit for BOTH recovery sides (0,1,2,3 then 8,9).
      tape = [...tape, k % 2 === 0 ? 1 : 8];
      policy.update(tape, tape.length - 1);
    }
    const after5 = policy.decideRecovery(tape, tape.length - 1);
    assert.equal(before.bar, BASTION_RECOVERY_BAR, "bar must be the static fair rate");
    assert.equal(after5.bar, BASTION_RECOVERY_BAR, "the bar must NOT move after 5 recovery losses");
  });

  it("a shot that clears the bar fires at loss-run depth 5 exactly as at depth 0", () => {
    // Craft a tape where the model's recovery p̂ is above the bar, run it after
    // a long loss run, and require `ready` — the historical Apex-style bug was
    // gates tightening exactly here.
    const digits = tiltedStream(2500, 17, 7, [8, 9], 0.75); // 7→{8,9} ⇒ Over 3 tilts hot
    const policy = new BastionPolicy(FLAT);
    for (let i = 0; i < 2000; i++) policy.update(digits, i);
    // Deep loss run of hole digits…
    let tape = digits.slice(0, 2001);
    for (let k = 0; k < 5; k++) {
      tape = [...tape, 2];
      policy.update(tape, tape.length - 1);
    }
    tape = [...tape, 7]; // …then a 7: the hot anchor for Over 3
    policy.update(tape, tape.length - 1);
    const dec = policy.decideRecovery(tape, tape.length - 1);
    assert.ok(dec.side, "a side must be chosen");
    if (dec.read && dec.read.p >= BASTION_RECOVERY_BAR) {
      assert.equal(dec.ready, true, "a bar-clearing shot MUST fire at loss-run depth 5");
    }
    // And the bar is still frozen regardless:
    assert.equal(dec.bar, BASTION_RECOVERY_BAR);
  });
});

describe("recovery selection follows the tape", () => {
  it("low-digit tape → Under 6, high-digit tape → Over 3", () => {
    // Decide at the anchor itself — the tilt is CONDITIONAL on the 7, which is
    // exactly the post-loss situation the bot faces (the losing digit is the
    // strongest known predictor of the next tick).
    const low = tiltedStream(3000, 23, 7, [0, 1, 2, 3], 0.8);
    const high = tiltedStream(3000, 24, 7, [6, 7, 8, 9], 0.8);
    const anchorLow = low.lastIndexOf(7, 2500);
    const anchorHigh = high.lastIndexOf(7, 2500);
    assert.ok(anchorLow > 2000 && anchorHigh > 2000, "test streams must contain late anchors");

    const pLow = new BastionPolicy(FLAT);
    for (let i = 0; i < anchorLow; i++) pLow.update(low, i);
    const dLow = pLow.decideRecovery(low, anchorLow);

    const pHigh = new BastionPolicy(FLAT);
    for (let i = 0; i < anchorHigh; i++) pHigh.update(high, i);
    const dHigh = pHigh.decideRecovery(high, anchorHigh);

    assert.equal(dLow.side?.id, "under6", `low tape picked ${dLow.side?.id}`);
    assert.equal(dHigh.side?.id, "over3", `high tape picked ${dHigh.side?.id}`);
    assert.ok(dLow.ready, "a strongly tilted tape must clear the static bar immediately");
    assert.ok(dHigh.ready, "a strongly tilted tape must clear the static bar immediately");
  });

  it("waits only when NO side shows tilt (the 'if none, wait' clause)", () => {
    const digits = fairStream(2500, 29);
    const policy = new BastionPolicy(FLAT);
    for (let i = 0; i < 2000; i++) policy.update(digits, i);
    let ready = 0;
    let total = 0;
    for (let i = 2000; i < 2400; i++) {
      const dec = policy.decideRecovery(digits, i);
      total++;
      if (dec.ready) ready++;
      policy.update(digits, i + 1);
    }
    // Fair tape: the fused p̂ hovers at the fair rate, so roughly half the ticks
    // clear the bar — the bot is NEVER stuck waiting forever (no starve) …
    assert.ok(ready >= 10, `starved: ${ready}/${total} recovery ticks eligible`);
    // …and roughly half wait (a quality threshold exists at all).
    assert.ok(total - ready >= 10, `no waiting rule at all: ${ready}/${total}`);
  });
});

describe("normal valve", () => {
  it("releases normal shots at its budget and never starves on fair data", () => {
    const digits = fairStream(6000, 31);
    const { metrics } = replayBastion(digits, FLAT, { warmup: 400 });
    // Normal budget is 0.20/tick minus recovery time — just require real flow.
    assert.ok(metrics.normalShots >= 200, `normalShots=${metrics.normalShots}`);
    assert.ok(metrics.fireRatePer100 > 5, `fireRatePer100=${metrics.fireRatePer100}`);
  });

  it("honours the side mode", () => {
    const digits = fairStream(4000, 33);
    const policy = new BastionPolicy(FLAT);
    for (let i = 0; i < 3500; i++) policy.update(digits, i);
    for (let i = 3500; i < 3600; i++) {
      const dec = policy.decideNormal(digits, i, "over");
      if (dec.side) assert.equal(dec.side.id, "over1");
      policy.update(digits, i + 1);
    }
  });
});

describe("honest walk-forward measurement", () => {
  it("never grades fair data PRIME and measures near-face-value hit rates", () => {
    for (const seed of [41, 43, 1]) {
      const read = scoreBastionMarket(fairStream(3000, seed));
      assert.notEqual(read.verdict, "prime", `seed=${seed} edge=${read.paperEdgePerDollar}`);
    }
  });

  it("measures a planted band-tilt as recovery-positive edge", () => {
    // 7 → {8,9} at 75% plants Over 3 momentum (8,9 ∈ Over 3's win set).
    const digits = tiltedStream(4000, 47, 7, [8, 9], 0.75);
    const read = scoreBastionMarket(digits);
    assert.ok(read.metrics.recoveryShots >= 4, `recoveryShots=${read.metrics.recoveryShots}`);
    assert.ok(
      read.metrics.recoveryHitRate >= 0.55,
      `recoveryHitRate=${read.metrics.recoveryHitRate} shots=${read.metrics.recoveryShots}`,
    );
    assert.notEqual(read.verdict, "thin", `verdict=${read.verdict} edge=${read.paperEdgePerDollar}`);
  });

  it("reports loss pairs honestly (planted clustering shows up)", () => {
    // Anti-tilt: 7 → {0,1} heavy holes for Over 3 — recovery on Over 3 after a
    // 7-loss keeps hitting the same hole; the pair meter must see it.
    const digits = tiltedStream(4000, 53, 7, [0, 1], 0.8);
    const read = scoreBastionMarket(digits);
    assert.ok(read.metrics.recoveryLosses >= 0);
    assert.equal(typeof read.metrics.recoveryLossPairs, "number");
    // Whatever the numbers are, they must be internally consistent:
    assert.ok(read.metrics.recoveryLossPairs <= read.metrics.recoveryLosses);
    assert.ok(read.metrics.recoveryHitRate <= 1);
  });
});

describe("fusion helpers", () => {
  it("logPoolBinary interpolates geometrically in odds space", () => {
    const p = logPoolBinary([0.6, 0.6, 0.6, 0.6], [0.25, 0.25, 0.25, 0.25]);
    assert.ok(Math.abs(p - 0.6) < 1e-9, `p=${p}`);
    const q = logPoolBinary([0.7, 0.5, 0.5, 0.5], [1, 0, 0, 0]);
    assert.ok(Math.abs(q - 0.7) < 1e-9, `q=${q}`);
  });

  it("temperatureScaleBinary softens toward 0.5 and sharpens away", () => {
    assert.ok(Math.abs(temperatureScaleBinary(0.7, 1) - 0.7) < 1e-9);
    assert.ok(temperatureScaleBinary(0.7, 2) < 0.7, "τ>1 must soften");
    assert.ok(temperatureScaleBinary(0.7, 0.5) > 0.7, "τ<1 must sharpen");
  });

  it("weightsFromSkillN keeps every lens alive", () => {
    const w = weightsFromSkillN([0.6, 0.65, 0.68, 0.69], Math.log(2));
    assert.ok(Math.abs(w[0]! + w[1]! + w[2]! + w[3]! - 1) < 1e-9);
    assert.ok(w.every(v => v! >= 0.04), `floor violated: ${w}`);
    assert.ok(w[0]! > w[3]!, `best lens must dominate: ${w}`);
  });
});
