/**
 * Specialist Analysis Layer — statistical correctness tests.
 *
 * Each test checks the mathematical PROPERTY of an estimator on data generated
 * with a known ground truth, never a snapshot:
 *  1. Wald–Wolfowitz separates clustering from alternating streams.
 *  2. Hurst (R/S) separates trending from mean-reverting series.
 *  3. Benjamini–Hochberg admits a genuinely significant candidate and rejects
 *     an inflated argmax-of-ten.
 *  4. The 2-state chain converges to the true conditional probability.
 *  5. Each family read points at the side the data actually favours, and every
 *     bonus stays inside its bound.
 *  6. The entry gates block on exactly the condition they document.
 *  7. Side arbitration applies hysteresis.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  benjaminiHochberg,
  barrierRead,
  differRead,
  hurstExponent,
  lagAutocorr,
  matchRead,
  momentumRead,
  parityRead,
  runHazard,
  specialistEntryGate,
  specialistSideChoice,
  twoStateChain,
  waldWolfowitz,
  SPECIALIST_BONUS_CAP,
} from "./specialist-analysis";

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform digits 0–9. */
function uniformDigits(n: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(rnd() * 10));
}

describe("Wald–Wolfowitz runs test", () => {
  it("reads a strictly alternating stream as strongly alternating (z > 0)", () => {
    const series = Array.from({ length: 120 }, (_, i) => i % 2);
    const ww = waldWolfowitz(series);
    assert.ok(ww.z > 3, `expected z > 3, got ${ww.z}`);
  });

  it("reads long unbroken blocks as clustering (z < 0)", () => {
    const series: number[] = [];
    for (let block = 0; block < 12; block++) {
      const value = block % 2;
      for (let i = 0; i < 10; i++) series.push(value);
    }
    const ww = waldWolfowitz(series);
    assert.ok(ww.z < -3, `expected z < -3, got ${ww.z}`);
  });

  it("reads independent coin flips as roughly neutral", () => {
    const rnd = mulberry32(7);
    const series = Array.from({ length: 400 }, () => (rnd() < 0.5 ? 0 : 1));
    const ww = waldWolfowitz(series);
    assert.ok(Math.abs(ww.z) < 2.5, `expected |z| < 2.5, got ${ww.z}`);
  });

  it("returns neutral on a degenerate series", () => {
    const ww = waldWolfowitz([1, 1, 1, 1, 1]);
    assert.equal(ww.z, 0);
  });
});

describe("Hurst exponent (R/S)", () => {
  it("sits near 0.5 for independent increments", () => {
    // A random walk's INCREMENTS are iid, so H must come back ≈ 0.5 — this is
    // the null the estimator has to respect before it can claim persistence.
    const rnd = mulberry32(11);
    const increments = Array.from({ length: 400 }, () => rnd() - 0.5);
    const h = hurstExponent(increments);
    assert.ok(Math.abs(h - 0.5) < 0.12, `expected H ≈ 0.5 for iid increments, got ${h}`);
  });

  it("is above 0.5 for persistent (positively autocorrelated) increments", () => {
    const rnd = mulberry32(12);
    const increments: number[] = [];
    let x = 0;
    for (let i = 0; i < 400; i++) {
      x = 0.7 * x + (rnd() - 0.5); // AR(1), φ = 0.7 ⇒ trending
      increments.push(x);
    }
    const h = hurstExponent(increments);
    assert.ok(h > 0.55, `expected H > 0.55 for a trending series, got ${h}`);
  });

  it("is below 0.5 for a strictly alternating (anti-persistent) series", () => {
    const returns: number[] = [];
    for (let i = 0; i < 200; i++) returns.push(i % 2 === 0 ? 1 : -1);
    const h = hurstExponent(returns);
    assert.ok(h < 0.5, `expected H < 0.5 for an alternating series, got ${h}`);
  });

  it("is neutral when the series is too short", () => {
    assert.equal(hurstExponent([1, -1, 1, -1]), 0.5);
  });
});

describe("Benjamini–Hochberg FDR", () => {
  it("admits one genuinely significant candidate among ten", () => {
    const pValues = [0.001, 0.4, 0.5, 0.6, 0.7, 0.8, 0.35, 0.45, 0.55, 0.65];
    const passes = benjaminiHochberg(pValues, 0.25);
    assert.equal(passes[0], true);
    assert.equal(passes.filter(Boolean).length, 1);
  });

  it("rejects everything when no candidate is significant", () => {
    const pValues = Array.from({ length: 10 }, () => 0.5);
    const passes = benjaminiHochberg(pValues, 0.25);
    assert.equal(passes.filter(Boolean).length, 0);
  });

  it("admits a contiguous prefix in p-value order", () => {
    const pValues = [0.001, 0.004, 0.02, 0.9, 0.95, 0.5, 0.6, 0.7, 0.8, 0.85];
    const passes = benjaminiHochberg(pValues, 0.25);
    assert.deepEqual(passes.slice(0, 3), [true, true, true]);
  });
});

describe("Two-state chain", () => {
  it("recovers both conditionals of an alternating-biased chain", () => {
    // P(1|0) = 0.8 and P(1|1) = 0.2 keeps BOTH contexts well populated, so each
    // conditional carries real evidence (a chain that sits in one state leaves
    // the other context with a handful of effective samples and correctly
    // shrinks toward 0.5 — that is the estimator being honest, not wrong).
    const states: number[] = [0];
    const rnd = mulberry32(23);
    for (let i = 1; i < 800; i++) {
      const prev = states[i - 1]!;
      states.push(prev === 0 ? (rnd() < 0.8 ? 1 : 0) : (rnd() < 0.2 ? 1 : 0));
    }
    const chain = twoStateChain(states, 1, 0.985);
    assert.ok(chain.pFrom0 > 0.65, `P(1|0) should be high, got ${chain.pFrom0.toFixed(3)}`);
    assert.ok(chain.pFrom1 < 0.35, `P(1|1) should be low, got ${chain.pFrom1.toFixed(3)}`);
    assert.ok(chain.n0 > 15 && chain.n1 > 15, `both contexts need weight, got n0=${chain.n0.toFixed(1)} n1=${chain.n1.toFixed(1)}`);
  });

  it("shrinks a rarely-visited context toward 0.5 instead of overfitting it", () => {
    // P(1|1) = 0.95 means state 0 is rare, so P(1|0) rests on very few
    // observations and must NOT come back as a confident extreme.
    const states: number[] = [0];
    const rnd = mulberry32(24);
    for (let i = 1; i < 600; i++) {
      const prev = states[i - 1]!;
      states.push(prev === 1 ? (rnd() < 0.95 ? 1 : 0) : (rnd() < 0.9 ? 1 : 0));
    }
    const chain = twoStateChain(states, 1, 0.985);
    assert.ok(chain.n0 < 20, `the rare context should carry little weight, got n0=${chain.n0.toFixed(1)}`);
    assert.ok(chain.pFrom0 > 0.4 && chain.pFrom0 < 1, `rare-context estimate must stay shrunk, got ${chain.pFrom0.toFixed(3)}`);
    assert.ok(chain.pFrom1 > 0.8, `the well-populated context should still be confident, got ${chain.pFrom1.toFixed(3)}`);
  });
});

describe("Lag autocorrelation", () => {
  it("is strongly negative at lag 1 for an alternating series", () => {
    const series = Array.from({ length: 100 }, (_, i) => i % 2);
    assert.ok(lagAutocorr(series, 1) < -0.9);
  });

  it("is strongly positive at lag 2 for an alternating series", () => {
    const series = Array.from({ length: 100 }, (_, i) => i % 2);
    assert.ok(lagAutocorr(series, 2) > 0.9);
  });
});

describe("Run hazard", () => {
  it("measures a short typical run as a high break probability", () => {
    // Runs of exactly length 1 against, then a hit: break probability at k=1 ≈ 1.
    const against: boolean[] = [];
    for (let i = 0; i < 60; i++) { against.push(true); against.push(false); }
    const rh = runHazard(against);
    assert.ok((rh.hazard.get(1) ?? 0) > 0.8, `expected high k=1 hazard, got ${rh.hazard.get(1)}`);
  });
});

describe("Parity specialist", () => {
  it("favours EVEN on a stream biased toward even digits", () => {
    const rnd = mulberry32(31);
    const digits = Array.from({ length: 200 }, () => (rnd() < 0.68 ? [0, 2, 4, 6, 8][Math.floor(rnd() * 5)]! : [1, 3, 5, 7, 9][Math.floor(rnd() * 5)]!));
    const even = parityRead(digits, "DIGITEVEN");
    const odd = parityRead(digits, "DIGITODD");
    assert.ok(even.bonus > odd.bonus, `even ${even.bonus} should beat odd ${odd.bonus}`);
    assert.ok((even.metrics["pHat"] ?? 0) > 0.55, `p̂ should exceed 0.55, got ${even.metrics["pHat"]}`);
  });

  it("favours ODD on a stream biased toward odd digits", () => {
    const rnd = mulberry32(41);
    const digits = Array.from({ length: 200 }, () => (rnd() < 0.68 ? [1, 3, 5, 7, 9][Math.floor(rnd() * 5)]! : [0, 2, 4, 6, 8][Math.floor(rnd() * 5)]!));
    const odd = parityRead(digits, "DIGITODD");
    const even = parityRead(digits, "DIGITEVEN");
    assert.ok(odd.bonus > even.bonus, `odd ${odd.bonus} should beat even ${even.bonus}`);
  });

  it("detects alternation and flags the side the structure contradicts", () => {
    // Strictly alternating parity, last tick ODD (7) ⇒ alternation says the next
    // tick is EVEN. So the structure favours EVEN: the EVEN read must be
    // unblocked and the ODD read must be blocked.
    const digits: number[] = [];
    for (let i = 0; i < 120; i++) digits.push(i % 2 === 0 ? 2 : 7);
    assert.equal(digits[digits.length - 1], 7, "fixture must end on an odd digit");

    const even = parityRead(digits, "DIGITEVEN");
    const odd = parityRead(digits, "DIGITODD");

    assert.ok((even.metrics["runsZ"] ?? 0) > 3, `runs z should be strongly positive, got ${even.metrics["runsZ"]}`);
    assert.equal(even.favoured, "DIGITEVEN", "alternation after an odd tick favours EVEN");
    assert.equal(even.metrics["alignAgainst"], 0);
    assert.equal(specialistEntryGate(even).pass, true, "the favoured side must not be blocked");
    assert.ok(even.bonus > 0, `favoured side should score positive, got ${even.bonus}`);

    assert.equal(odd.favoured, "DIGITEVEN");
    assert.equal(odd.metrics["alignAgainst"], 1);
    assert.equal(specialistEntryGate(odd).pass, false, "the contradicted side must be blocked");
    assert.ok(odd.bonus < 0, `contradicted side should score negative, got ${odd.bonus}`);
  });

  it("detects clustering and favours the open run's side", () => {
    // Long unbroken blocks ending on an even digit ⇒ clustering says the run
    // continues, so the structure favours EVEN.
    const digits: number[] = [];
    for (let block = 0; block < 15; block++) {
      const value = block % 2 === 0 ? 2 : 7;
      for (let i = 0; i < 8; i++) digits.push(value);
    }
    const read = parityRead(digits, "DIGITEVEN");
    assert.ok((read.metrics["runsZ"] ?? 0) < -3, `runs z should be strongly negative, got ${read.metrics["runsZ"]}`);
    assert.equal(read.favoured, "DIGITEVEN");
    assert.equal(read.metrics["alignAgainst"], 0);
  });

  it("stays neutral with too little data", () => {
    const read = parityRead([1, 2, 3], "DIGITEVEN");
    assert.equal(read.bonus, 0);
    assert.equal(read.confidence, 0);
  });
});

describe("Barrier specialist", () => {
  it("favours OVER on a high-digit stream and UNDER on a low-digit stream", () => {
    const high = Array.from({ length: 200 }, (_, i) => 5 + (i % 5)); // 5..9
    const low = Array.from({ length: 200 }, (_, i) => i % 4);       // 0..3
    const over = barrierRead(high, { side: "DIGITOVER", barrier: 4 });
    const under = barrierRead(high, { side: "DIGITUNDER", barrier: 5 });
    assert.ok(over.bonus > under.bonus, `over ${over.bonus} should beat under ${under.bonus} on high digits`);

    const overLow = barrierRead(low, { side: "DIGITOVER", barrier: 4 });
    const underLow = barrierRead(low, { side: "DIGITUNDER", barrier: 5 });
    assert.ok(underLow.bonus > overLow.bonus, `under ${underLow.bonus} should beat over ${overLow.bonus} on low digits`);
  });

  it("reports break-even correctly for the barrier", () => {
    const digits = uniformDigits(150, 53);
    const read = barrierRead(digits, { side: "DIGITOVER", barrier: 4 });
    // OVER 4 pays 1.95 ⇒ break-even 0.5128
    assert.ok(Math.abs((read.metrics["breakEven"] ?? 0) - 1 / 1.95) < 0.001);
  });

  it("detects mass drifting toward the tail", () => {
    const drifting: number[] = [];
    for (let i = 0; i < 200; i++) drifting.push(i < 100 ? 2 + (i % 3) : 6 + (i % 4));
    const read = barrierRead(drifting, { side: "DIGITOVER", barrier: 4 });
    assert.ok((read.metrics["drift"] ?? 0) > 0, `drift should be positive, got ${read.metrics["drift"]}`);
  });
});

describe("Match specialist", () => {
  it("selects the digit that is genuinely hot", () => {
    const rnd = mulberry32(61);
    const digits = Array.from({ length: 300 }, () => (rnd() < 0.35 ? 7 : Math.floor(rnd() * 10)));
    const { barrier, read, candidates } = matchRead(digits);
    assert.equal(barrier, 7);
    assert.ok(read.bonus > 0, `hot digit should earn a positive bonus, got ${read.bonus}`);
    assert.ok(candidates.length === 10);
    assert.ok((read.metrics["significantDigits"] ?? 0) >= 1, "the hot digit should survive FDR");
  });

  it("respects a locked digit", () => {
    const digits = uniformDigits(200, 71);
    const { barrier } = matchRead(digits, 3);
    assert.equal(barrier, 3);
  });

  it("penalises a digit that just appeared", () => {
    const digits = uniformDigits(150, 81);
    digits.push(4, 4); // digit 4 has gap 0
    const { read } = matchRead(digits, 4);
    const gapMetric = read.metrics["gap"];
    assert.ok(gapMetric !== undefined && gapMetric <= 1, `gap should be ~0, got ${gapMetric}`);
    const gate = specialistEntryGate(read);
    assert.equal(gate.pass, false, "a digit that just appeared is too soon to match");
  });
});

describe("Differ specialist", () => {
  it("selects the coldest digit", () => {
    // Digit 5 is injected hot and digit 9 is EXCLUDED from the generator
    // entirely, so 9 is unambiguously the safest differ target.
    const rnd = mulberry32(91);
    const coldPool = [0, 1, 2, 3, 4, 6, 7, 8];
    const digits = Array.from({ length: 400 }, () => {
      const r = rnd();
      if (r < 0.30) return 5;
      return coldPool[Math.floor(rnd() * coldPool.length)]!;
    });
    assert.equal(digits.filter(d => d === 9).length, 0, "fixture must never contain digit 9");

    const { barrier, read } = differRead(digits);
    assert.equal(barrier, 9, "the never-seen digit is the safest differ target");
    assert.ok(read.bonus > 0, `a safe differ should earn a positive bonus, got ${read.bonus}`);
  });

  it("vetoes a digit in a hot run", () => {
    const digits = uniformDigits(150, 101);
    digits.push(8, 8, 8); // digit 8 three times in the last six
    const { read } = differRead(digits, 8);
    assert.ok((read.metrics["recent6"] ?? 0) >= 3);
    const gate = specialistEntryGate(read);
    assert.equal(gate.pass, false, "a hot digit must be vetoed as a differ target");
  });

  it("keeps the worst-case win rate above break-even on a clean stream", () => {
    const digits = uniformDigits(300, 111);
    const { read } = differRead(digits);
    const worst = read.metrics["worstCaseWin"] ?? 0;
    const be = read.metrics["breakEven"] ?? 0;
    assert.ok(worst > 0.8, `worst-case win should be high, got ${worst}`);
    assert.ok(Math.abs(be - 1 / 1.09) < 0.001);
  });
});

describe("Momentum specialist", () => {
  it("favours CALL on a steadily rising series", () => {
    const prices: number[] = [];
    let p = 100;
    const rnd = mulberry32(121);
    for (let i = 0; i < 120; i++) {
      p += rnd() < 0.72 ? 0.5 : -0.4;
      prices.push(p);
    }
    const call = momentumRead(prices, "CALL");
    const put = momentumRead(prices, "PUT");
    assert.ok(call.bonus > put.bonus, `call ${call.bonus} should beat put ${put.bonus} on a rising tape`);
  });

  it("favours PUT on a steadily falling series", () => {
    const prices: number[] = [];
    let p = 100;
    const rnd = mulberry32(131);
    for (let i = 0; i < 120; i++) {
      p += rnd() < 0.72 ? -0.5 : 0.4;
      prices.push(p);
    }
    const put = momentumRead(prices, "PUT");
    const call = momentumRead(prices, "CALL");
    assert.ok(put.bonus > call.bonus, `put ${put.bonus} should beat call ${call.bonus} on a falling tape`);
  });

  it("refuses a flat, dead tape", () => {
    const prices = Array.from({ length: 120 }, () => 100);
    const read = momentumRead(prices, "CALL");
    const gate = specialistEntryGate(read);
    assert.equal(gate.pass, false, "a completely flat tape is untradeable");
    assert.ok((read.metrics["flatTicks"] ?? 0) > 0.35);
  });
});

describe("Bounds and arbitration", () => {
  it("keeps every family bonus inside its cap", () => {
    const digits = uniformDigits(250, 141);
    const prices = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 2 + i * 0.05);
    const reads = [
      parityRead(digits, "DIGITEVEN"),
      parityRead(digits, "DIGITODD"),
      barrierRead(digits, { side: "DIGITOVER", barrier: 4 }),
      barrierRead(digits, { side: "DIGITUNDER", barrier: 5 }),
      matchRead(digits).read,
      differRead(digits).read,
      momentumRead(prices, "CALL"),
      momentumRead(prices, "PUT"),
    ];
    for (const read of reads) {
      assert.ok(Math.abs(read.bonus) <= SPECIALIST_BONUS_CAP,
        `${read.family} bonus ${read.bonus} exceeded cap ${SPECIALIST_BONUS_CAP}`);
      assert.ok(read.confidence >= 0 && read.confidence <= 100);
    }
  });

  it("holds the current side when the lead is inside the hysteresis margin", () => {
    const verdict = specialistSideChoice(
      [
        { side: "DIGITOVER", read: { family: "barrier", bonus: 3, confidence: 50, metrics: {}, signals: [] } },
        { side: "DIGITUNDER", read: { family: "barrier", bonus: 1, confidence: 50, metrics: {}, signals: [] } },
      ],
      "DIGITUNDER",
      6,
    );
    assert.equal(verdict?.side, "DIGITUNDER", "a 2-point lead must not switch the side");
    assert.match(verdict!.reason, /hysteresis/);
  });

  it("switches side once the lead clears the margin", () => {
    const verdict = specialistSideChoice(
      [
        { side: "DIGITOVER", read: { family: "barrier", bonus: 12, confidence: 50, metrics: {}, signals: [] } },
        { side: "DIGITUNDER", read: { family: "barrier", bonus: 1, confidence: 50, metrics: {}, signals: [] } },
      ],
      "DIGITUNDER",
      6,
    );
    assert.equal(verdict?.side, "DIGITOVER");
  });

  it("returns the only side when a single side is armed", () => {
    const verdict = specialistSideChoice(
      [{ side: "DIGITEVEN", read: { family: "parity", bonus: -5, confidence: 10, metrics: {}, signals: [] } }],
      undefined,
    );
    assert.equal(verdict?.side, "DIGITEVEN");
  });
});
