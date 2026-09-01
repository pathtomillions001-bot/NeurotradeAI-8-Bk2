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
 *  8. Exact-probability helpers (Beta posterior, one-sided posterior p-values,
 *     run-conditioned hazard, Dirichlet last-digit transitions) agree with
 *     closed forms and detect planted structure.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  benjaminiHochberg,
  barrierRead,
  betaPosterior,
  betaQuantile,
  differRead,
  dirichletTailProbability,
  hurstExponent,
  lagAutocorr,
  matchRead,
  momentumRead,
  parityRead,
  posteriorRateProbability,
  regularizedIncompleteBeta,
  runConditionedProbability,
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

describe("Beta-Binomial posterior (exact, no normal approximation)", () => {
  it("recovers the closed form for a small sample", () => {
    // Prior: κ=10 pseudo-draws at 10% ⇒ Beta(1, 9). One hit in 5 real draws
    // ⇒ Beta(2, 13). Mean = 2/15, variance = 2·13/(15²·16).
    const post = betaPosterior(1, 5, 0.1, 10);
    assert.ok(Math.abs(post.mean - 2 / 15) < 1e-9, `mean ${post.mean} ≠ 2/15`);
    assert.ok(Math.abs(post.sigma - Math.sqrt((2 * 13) / (15 * 15 * 16))) < 1e-9, `sigma ${post.sigma}`);
  });

  it("shrinks a 1-in-5 digit towards the fair 10% (it is not a 20% digit)", () => {
    const post = betaPosterior(1, 5, 0.1, 10);
    assert.ok(post.mean > 0.1 && post.mean < 0.2, `expected 0.1 < mean < 0.2, got ${post.mean}`);
  });

  it("concentrates around the empirical rate once the sample dominates the prior", () => {
    const post = betaPosterior(30, 200, 0.1, 10);
    assert.ok(Math.abs(post.mean - 30 / 200) < 0.01, `mean ${post.mean} should approach 0.15`);
    assert.ok(post.sigma < 0.03, `sigma ${post.sigma} should shrink with n`);
  });

  it("computes the regularized incomplete Beta correctly at known points", () => {
    assert.ok(Math.abs(regularizedIncompleteBeta(0.5, 1, 1) - 0.5) < 1e-6);
    assert.ok(Math.abs(regularizedIncompleteBeta(0.1, 2, 13) - 0.4153708594843323) < 1e-6);
  });

  it("one-sided posterior p-value: a hot digit yields a small p, a cold digit a large one", () => {
    const hot = posteriorRateProbability(30, 200, 0.1, "hot", 0.1, 10);
    const cold = posteriorRateProbability(30, 200, 0.1, "cold", 0.1, 10);
    assert.ok(hot < 0.05, `expected hot p < 0.05, got ${hot}`);
    assert.ok(cold > 0.95, `expected cold p > 0.95, got ${cold}`);
  });

  it("is exact for tiny counts where a normal approximation would lie", () => {
    // 0 hits in 3 draws, prior Beta(1, 9) ⇒ posterior Beta(1, 12):
    // P(p ≥ 0.1) = 1 − I_0.1(1, 12) = 1 − (1 − 0.1)^12 = 0.9^12 exactly.
    // A normal approximation on the raw 0/3 rate would collapse to σ = 0.
    const p = posteriorRateProbability(0, 3, 0.1, "cold", 0.1, 10);
    assert.ok(Math.abs(p - 0.9 ** 12) < 1e-9, `expected 0.9^12 = ${0.9 ** 12}, got ${p}`);
  });

  it("stays neutral when there is no data", () => {
    assert.equal(posteriorRateProbability(0, 0, 0.1, "hot"), 0.5);
  });
});

describe("Run-conditioned probability (censored open-run hazard)", () => {
  it("favours continuing a long run when the stream clusters", () => {
    const rnd = mulberry32(1234);
    const states: number[] = [];
    let even = rnd() < 0.5;
    for (let i = 0; i < 300; i++) {
      even = rnd() < (even ? 0.9 : 0.5); // P(same) = 0.9 clustering
      states.push(even ? 0 : 1);
    }
    for (let i = 0; i < 5; i++) states.push(0); // open even-run of 5
    const rc = runConditionedProbability(states, 0);
    assert.ok(rc.p > 0.7, `expected P(even | run of ${rc.k}) > 0.7, got ${rc.p}`);
    assert.ok(rc.k >= 5, `run length ${rc.k}`);
    assert.ok(rc.reached >= 4, `needs hazard history, got reached=${rc.reached}`);
  });

  it("downgrades a run against the target below fair", () => {
    const rnd = mulberry32(1234);
    const states: number[] = [];
    let even = rnd() < 0.5;
    for (let i = 0; i < 300; i++) {
      even = rnd() < (even ? 0.9 : 0.5);
      states.push(even ? 0 : 1);
    }
    for (let i = 0; i < 5; i++) states.push(1); // open odd-run of 5, target = even
    const rc = runConditionedProbability(states, 0);
    assert.ok(rc.p <= 0.5, `expected P(even | odd run) ≤ 0.5, got ${rc.p}`);
  });

  it("is neutral without enough history", () => {
    const rc = runConditionedProbability([0, 1, 0, 1, 0], 0);
    assert.equal(rc.p, 0.5);
  });
});

describe("Dirichlet last-digit transition", () => {
  it("detects a planted digit → tail bias", () => {
    const rnd = mulberry32(99);
    const digits: number[] = [];
    let last = Math.floor(rnd() * 10);
    for (let i = 0; i < 500; i++) {
      let d: number;
      if (last === 6 && rnd() < 0.5) d = 7 + Math.floor(rnd() * 3);
      else d = Math.floor(rnd() * 10);
      digits.push(d);
      last = d;
    }
    digits.push(6, 6, 6); // guarantee the conditioning digit is last
    const dt = dirichletTailProbability(digits, new Set([7, 8, 9]));
    assert.ok(dt.n >= 30, `expected a populated transition row, got n=${dt.n}`);
    assert.ok(dt.p > 0.4, `expected P(tail | 6) > 0.4, got ${dt.p}`);
  });

  it("returns the fair rate with zero sample when history is missing", () => {
    const dt = dirichletTailProbability([0, 1, 2], new Set([7, 8, 9]));
    assert.equal(dt.p, 0.3);
    assert.equal(dt.n, 0);
  });
});

describe("Specialist fusion metrics (v3)", () => {
  it("parityRead exposes run-conditioned and Dirichlet metrics on a clustering stream", () => {
    const rnd = mulberry32(1234);
    const digits: number[] = [];
    let even = rnd() < 0.5;
    for (let i = 0; i < 120; i++) {
      even = rnd() < (even ? 0.9 : 0.5);
      digits.push(Math.floor(rnd() * 10) % 2 === (even ? 0 : 1) ? (even ? 0 : 1) : (even ? 0 : 1));
      // keep parity deterministic: push the parity bit we decided
      digits[digits.length - 1] = even ? 0 : 1;
    }
    const read = parityRead(digits, "DIGITEVEN");
    assert.ok(read.metrics.runCondP !== undefined, "runCondP missing");
    assert.ok(read.metrics.runCondK !== undefined, "runCondK missing");
    assert.ok(read.metrics.dirTailP !== undefined, "dirTailP missing");
  });

  it("barrierRead exposes the Dirichlet tail probability from the last digit", () => {
    const rnd = mulberry32(99);
    const digits: number[] = [];
    let last = Math.floor(rnd() * 10);
    for (let i = 0; i < 300; i++) {
      let d: number;
      if (last === 6 && rnd() < 0.5) d = 7 + Math.floor(rnd() * 3);
      else d = Math.floor(rnd() * 10);
      digits.push(d);
      last = d;
    }
    digits.push(6, 6, 6);
    const read = barrierRead(digits, { side: "DIGITOVER", barrier: 6 });
    assert.ok((read.metrics.dirTailN ?? 0) >= 30, `expected dirTail sample, got ${read.metrics.dirTailN}`);
    assert.ok((read.metrics.dirTailP ?? 0) > 0.4, `expected raised tail, got ${read.metrics.dirTailP}`);
  });

  it("differRead exposes σ so the specialist win probability can be fused", () => {
    const rnd = mulberry32(91);
    const coldPool = [0, 1, 2, 3, 4, 6, 7, 8];
    const digits = Array.from({ length: 400 }, () => {
      const r = rnd();
      if (r < 0.30) return 5;
      return coldPool[Math.floor(rnd() * coldPool.length)]!;
    });
    const { read } = differRead(digits);
    assert.ok(Number.isFinite(read.metrics.sigma ?? NaN), "differ read must carry sigma");
    assert.ok((read.metrics.sigma ?? 0) > 0, `sigma ${read.metrics.sigma} must be positive`);
  });

  it("momentumRead requires BOTH split halves to agree before claiming a regime", () => {
    // A regime flip exactly at the split midpoint: returns 0..39 are an AR(1)
    // trend, returns 40..79 are noisy alternation. The halves must disagree.
    const rnd = mulberry32(7);
    const rets: number[] = [];
    let x = 0;
    for (let i = 0; i < 40; i++) {
      x = 0.65 * x + (rnd() - 0.42) * 0.6;
      rets.push(x);
    }
    const rnd2 = mulberry32(8);
    let sgn = 1;
    for (let i = 0; i < 40; i++) {
      rets.push(sgn * (0.8 + rnd2() * 0.4));
      sgn = -sgn;
    }
    const prices: number[] = [100];
    for (const r of rets) prices.push(prices[prices.length - 1]! + r);
    const read = momentumRead(prices, "CALL");
    assert.equal(read.metrics.hurstAgreement, 0, "split halves disagree on regime");
    assert.ok((read.metrics.hurst1 ?? 0) > 0.55, `first half should be trending, got ${read.metrics.hurst1}`);
    assert.ok((read.metrics.hurst2 ?? 0) < 0.5, `second half should not be trending, got ${read.metrics.hurst2}`);
  });

  it("momentumRead trusts a regime both halves agree on", () => {
    const prices: number[] = [100];
    let x = 0;
    const rnd = mulberry32(7);
    for (let i = 0; i < 140; i++) {
      x = 0.65 * x + (rnd() - 0.42) * 0.6;
      prices.push(prices[prices.length - 1]! + x);
    }
    const read = momentumRead(prices, "CALL");
    assert.equal(read.metrics.hurstAgreement, 1, "halves agree on a persistent regime");
    assert.ok((read.metrics.hurst1 ?? 0) > 0.55 && (read.metrics.hurst2 ?? 0) > 0.55, "both halves trending");
  });
});

describe("Beta quantile (posterior upper bound for Differ)", () => {
  it("returns the median of a symmetric Beta", () => {
    assert.ok(Math.abs(betaQuantile(0.5, 2, 2) - 0.5) < 1e-3);
  });

  it("matches the closed form for Beta(1, β): q = 1 − (1−q)ᵝ", () => {
    // Beta(1, 409) has CDF I_q = 1 − (1−q)^409; the 90th percentile is
    // q = 1 − 0.1^(1/409) exactly.
    const q = betaQuantile(0.9, 1, 409);
    const expected = 1 - 0.1 ** (1 / 409);
    assert.ok(Math.abs(q - expected) < 1e-5, `got ${q}, expected ${expected}`);
  });

  it("the posterior quantile is asymmetric near the boundary (unlike p̂ + 1.645σ)", () => {
    // 0 hits in 400 draws, prior Beta(1,9): the 90% quantile sits far above
    // the raw normal bound because the Beta is right-skewed near zero.
    const { alpha, beta } = betaPosterior(0, 400, 0.1, 10);
    const quantile = betaQuantile(0.9, alpha, beta);
    assert.ok(quantile > 0.004 && quantile < 0.02, `quantile ${quantile}`);
  });
});

describe("Match geometric waiting-time gate (4.2)", () => {
  function fakeMatchRead(metrics: Record<string, number>): SpecialistRead {
    return { family: "match", bonus: 0, confidence: 50, metrics, signals: [] };
  }

  it("blocks a gap that is ordinary for the digit's own rate", () => {
    // pHat 14%: a 3-gap happens with (0.86)^3 ≈ 64% probability — not overdue.
    const gate = specialistEntryGate(fakeMatchRead({ zBe: 1.5, pHat: 0.14, gap: 3, hazardRelative: 1.2 }));
    assert.equal(gate.pass, false);
    assert.match(gate.reason, /geometric/);
  });

  it("admits a gap that is overdue for a genuinely hot digit", () => {
    // pHat 40%: a 3-gap happens with (0.60)^3 = 21.6% probability — overdue.
    const gate = specialistEntryGate(fakeMatchRead({ zBe: 1.5, pHat: 0.4, gap: 3, hazardRelative: 1.2 }));
    assert.equal(gate.pass, true);
  });

  it("the existing too-soon guard still fires first", () => {
    const gate = specialistEntryGate(fakeMatchRead({ zBe: 1.5, pHat: 0.4, gap: 1, hazardRelative: 1.2 }));
    assert.equal(gate.pass, false);
  });
});

describe("Momentum drift EMA & multi-scale direction (6.2 / 6.3)", () => {
  it("exposes drift t-statistic and direction-agreement metrics", () => {
    // Strong signed drift with small noise: every scale agrees, drift is huge.
    const rnd = mulberry32(17);
    const prices: number[] = [100];
    for (let i = 0; i < 140; i++) prices.push(prices[prices.length - 1]! + 0.5 + (rnd() - 0.5) * 0.4);
    const read = momentumRead(prices, "CALL");
    assert.ok((read.metrics.driftT ?? 0) >= 1.5, `driftT ${read.metrics.driftT} should be significant`);
    assert.ok(read.metrics.dirRate10 !== undefined && read.metrics.dirRate30 !== undefined && read.metrics.dirRate80 !== undefined, "dir rates present");
    assert.equal(read.metrics.dirAgreement, 1, "persistent drift agrees at all three scales");
    assert.equal(read.metrics.driftSupported, 1, "drift EMA supports the trend claim");
  });

  it("marks direction disagreement when the stream flips regime", () => {
    // recent = last 80 returns: 40 trending + 40 alternating ⇒ the short
    // direction rate sits at 0.5 and agrees with neither side.
    const rets: number[] = [];
    for (let i = 0; i < 40; i++) rets.push(0.5);
    let sgn = 1;
    for (let i = 0; i < 40; i++) {
      rets.push(sgn * 1.0);
      sgn = -sgn;
    }
    const prices: number[] = [100];
    for (const r of rets) prices.push(prices[prices.length - 1]! + r);
    const read = momentumRead(prices, "CALL");
    assert.equal(read.metrics.dirAgreement, 0, "short and long direction rates disagree");
  });
});
