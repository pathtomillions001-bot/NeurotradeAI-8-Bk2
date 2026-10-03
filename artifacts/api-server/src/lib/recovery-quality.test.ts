import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DigitSnapshot } from "./digit-tape";
import {
  analyseRecoveryCandidate as analyse,
  effectiveSampleSize,
  feedProblem,
  lowerBound,
  recoveryDuration,
  sizeRecovery,
} from "./recovery-quality";
import { mergeRecoveryHistory } from "./recovery-history";

function random(seed = 42) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function snapshot(digits: number[], prices?: number[]): DigitSnapshot {
  const now = Math.floor(Date.now() / 1000);
  const ticks = digits.map((digit, i) => ({
    symbol: "R_10",
    digit,
    price: prices?.[i] ?? 100 + digit / 1000,
    epoch: now - (digits.length - 1 - i) * 2,
    receivedAt: (now - (digits.length - 1 - i) * 2) * 1000,
    sequence: i + 1,
    generation: 1,
    source: "live" as const,
  }));
  return { tick: { ...ticks.at(-1)! }, ticks };
}
function biased(seed = 42) {
  const r = random(seed);
  return snapshot(
    Array.from({ length: 4000 }, () =>
      r() < 0.92 ? 4 + Math.floor(r() * 6) : Math.floor(r() * 4),
    ),
  );
}
const args = {
  contractType: "DIGITOVER",
  barrier: 3,
  duration: 5,
  candidateCount: 100,
};

describe("recovery quality: exact candidate, chronology and uncertainty", () => {
  it("rejects uniform fair streams across multiple seeds and contract families", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = random(seed),
        data = snapshot(
          Array.from({ length: 4000 }, () => Math.floor(r() * 10)),
        );
      for (const contractType of [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITEVEN",
        "DIGITODD",
        "DIGITMATCH",
        "DIGITDIFF",
      ]) {
        const c = analyse({
          ...args,
          snapshot: data,
          contractType,
          barrier:
            contractType === "DIGITMATCH" || contractType === "DIGITDIFF"
              ? null
              : 3,
        });
        assert.equal(
          c.qualified,
          false,
          `${seed}: ${contractType} ${c.conservativeEV}`,
        );
      }
    }
  });
  it("releases a sufficiently supported planted advantage", () => {
    const c = analyse({ ...args, snapshot: biased() });
    assert.equal(c.qualified, true, c.reason);
    assert.ok(c.lowerProbability < c.probability);
    assert.ok(c.conservativeEV >= 0.01);
    assert.equal(c.duration, 5);
  });
  it("a worse exact quote disqualifies the same signal", () => {
    const c = analyse({ ...args, snapshot: biased(), payoutMultiplier: 1.05 });
    assert.equal(c.qualified, false);
  });
  it("does not learn a match target from held-out observations", () => {
    const digits = Array.from({ length: 4000 }, (_, i) => (i < 2000 ? 2 : 7));
    const c = analyse({
      snapshot: snapshot(digits),
      contractType: "DIGITMATCH",
      duration: 1,
      candidateCount: 10,
    });
    assert.equal(c.barrier, 2);
    assert.equal(c.qualified, false);
    assert.ok(c.probability < 0.1);
  });
  it("scores an explicitly selected digit, not each windows own winner", () => {
    const r = random();
    const data = snapshot(
      Array.from({ length: 4000 }, () =>
        r() < 0.5 ? 7 : Math.floor(r() * 10),
      ),
    );
    const cold = analyse({
      snapshot: data,
      contractType: "DIGITMATCH",
      barrier: 2,
      duration: 1,
      candidateCount: 10,
    });
    const hot = analyse({
      snapshot: data,
      contractType: "DIGITMATCH",
      barrier: 7,
      duration: 1,
      candidateCount: 10,
    });
    assert.equal(cold.qualified, false);
    assert.equal(hot.qualified, true);
  });
  it("uses expiry-specific directional labels, including ties as losses", () => {
    const data = snapshot(Array(4000).fill(2), Array(4000).fill(100));
    for (const contractType of ["CALL", "PUT"])
      assert.equal(
        analyse({ ...args, snapshot: data, contractType }).qualified,
        false,
      );
    const up = snapshot(
      Array(4000).fill(2),
      Array.from({ length: 4000 }, (_, i) => 100 + i),
    );
    assert.equal(
      analyse({ ...args, snapshot: up, contractType: "CALL" }).qualified,
      true,
    );
    assert.equal(
      analyse({ ...args, snapshot: up, contractType: "PUT" }).qualified,
      false,
    );
  });
  it("cannot use a next-tick Markov advantage at a different expiry", () => {
    const data = snapshot(Array.from({ length: 4000 }, (_, i) => i % 2));
    const one = analyse({
      snapshot: data,
      contractType: "DIGITMATCH",
      barrier: 0,
      duration: 1,
      candidateCount: 10,
    });
    const two = analyse({
      snapshot: data,
      contractType: "DIGITMATCH",
      barrier: 0,
      duration: 2,
      candidateCount: 10,
    });
    assert.equal(one.model, "validated-markov");
    assert.equal(one.qualified, true, one.reason);
    assert.equal(two.qualified, false);
  });
  it("warm-up is explicit, invalid barriers cannot qualify", () => {
    assert.match(
      analyse({ ...args, snapshot: snapshot(Array(40).fill(9)) }).reason,
      /Gathering/,
    );
    for (const barrier of [-1, 9, NaN])
      assert.equal(
        analyse({ ...args, snapshot: biased(), barrier }).qualified,
        false,
      );
    assert.equal(recoveryDuration("DIGITEVEN", 1), 5);
    assert.equal(recoveryDuration("DIGITMATCH", 15), 5);
  });
  it("penalizes serial dependence, scan breadth and late deterioration", () => {
    const r = random();
    const independent = Array.from({ length: 1000 }, () => +(r() > 0.5));
    const clustered = Array.from(
      { length: 1000 },
      (_, i) => +(Math.floor(i / 20) % 2 === 0),
    );
    assert.ok(
      effectiveSampleSize(clustered) < effectiveSampleSize(independent),
    );
    assert.ok(lowerBound(0.7, 500, 200) < lowerBound(0.7, 500, 1));
    const data = biased();
    for (const t of data.ticks.slice(-400)) t.digit = 0;
    data.tick = { ...data.ticks.at(-1)! };
    assert.equal(analyse({ ...args, snapshot: data }).qualified, false);
  });
});
describe("recovery risk limits and feed integrity", () => {
  const candidate = analyse({ ...args, snapshot: biased() });
  const budget = {
    candidate,
    balance: 1000,
    debt: 100,
    baseStake: 2,
    maxStake: 100,
    dailyRemaining: 20,
    drawdownRemaining: 50,
  };
  it("caps debt repayment at base stake, quarter Kelly, balance fraction and remaining budget", () => {
    assert.ok(sizeRecovery(budget) <= 2);
    assert.equal(sizeRecovery({ ...budget, dailyRemaining: 0.349 }), 0);
    assert.equal(sizeRecovery({ ...budget, balance: 20 }), 0);
    assert.equal(sizeRecovery({ ...budget, debt: 0 }), 0);
    assert.equal(sizeRecovery({ ...budget, balance: NaN }), 0);
    assert.equal(sizeRecovery({ ...budget, drawdownRemaining: 0.359 }), 0.35);
    assert.equal(
      sizeRecovery({ ...budget, debt: 10000 }),
      sizeRecovery(budget),
    );
    // A small final debt may be overpaid, but never by exceeding the risk cap.
    assert.equal(sizeRecovery({ ...budget, debt: 0.01 }), 0.35);
  });
  it("rejects stale, simulated and discontinuous live data", () => {
    const s = biased();
    assert.equal(feedProblem(s, 2000, true), null);
    assert.match(feedProblem(s, 2000, true, Date.now() + 20000)!, /stale/);
    s.tick.source = "simulated";
    assert.match(feedProblem(s, 2000, true)!, /live data/);
    s.tick.source = "live";
    s.ticks[10].generation = 2;
    assert.match(feedProblem(s, 2000, true)!, /Invalid/);
  });
  it("merges verified broker history without duplicating ticks or mixing conflicting prices", () => {
    const full = biased();
    const live = { tick: full.tick, ticks: full.ticks.slice(-10) };
    const combined = mergeRecoveryHistory(live, full.ticks.slice(0, -5), 2000);
    assert.equal(combined.ticks.length, 4000);
    assert.equal(feedProblem(combined, 2000, true), null);
    const bad = full.ticks.slice(0, -5).map((t) => ({ ...t }));
    bad.at(-1)!.price = 999;
    assert.equal(mergeRecoveryHistory(live, bad, 2000).ticks.length, 10);
  });
});
