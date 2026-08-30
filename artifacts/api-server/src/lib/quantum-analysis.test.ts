/**
 * Quantum Analysis Layer — statistical correctness tests.
 *
 * Every method is tested for its mathematical property, not a snapshot:
 *  1. EWMA edge estimator converges to the true event rate and carries a
 *     proper standard error (σ shrinks with evidence, z separates from 0).
 *  2. Structure detector λ separates biased (structured) streams from
 *     uniform (random) ones.
 *  3. z vs break-even: significant on real edge, ~0 on random data.
 *  4. CI-overlap & edge-direction stability terms.
 *  5. Timing: crossing recency, probability-space slope, the market's OWN
 *     streak-break hazard, entropy onset.
 *  6. (Execution-tick revalidation is the same estimator re-run live —
 *     covered by the estimator tests.)
 *  7. Self-measured signal value lives in signal-value.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chi2Survival,
  entropyOnsetBonus,
  edgeTrendBonus,
  hazardTimingBonus,
  normalCdf,
  quantumTimingScore,
  quantumWindowEstimate,
  ciOverlapBonus,
  ciOverlapWidth,
  structureConfidence,
  zEdgeQuality,
  type QuantumFeatures,
} from "./quantum-analysis.ts";

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294966464;
  };
}

function randomDigits(seed: number, n: number): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(rnd() * 10));
}

/** Digits where `p` of them are > barrier (the rest ≤ barrier). */
function biasedDigits(seed: number, n: number, p: number, barrier: number): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () =>
    rnd() < p
      ? barrier + 1 + Math.floor(rnd() * (9 - barrier))
      : Math.floor(rnd() * (barrier + 1)),
  );
}

const FEAT_DEFAULTS: QuantumFeatures = {
  pHat: 0.5, sigma: 0.05, ciLow: 0.4, ciHigh: 0.6,
  breakEven: 0.51, z: 0, lambda: 1, nEff: 100,
  crossedTicksAgo: -1, edgeSlope: 0,
  hazardK: 0, hazardBreakProb: 0.5, hazardBaseline: 0.5, hazardRelative: 1,
  entropyDelta: 0, neutral: false,
};
const mk = (over: Partial<QuantumFeatures>): QuantumFeatures => ({ ...FEAT_DEFAULTS, ...over });

// ── 0. Numerical primitives ──────────────────────────────────────────────────

describe("numerical primitives", () => {
  it("normal CDF is symmetric and matches known quantiles", () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
    assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 5e-4);
    assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 5e-4);
    assert.ok(Math.abs(normalCdf(1) + normalCdf(-1) - 1) < 1e-9);
  });

  it("χ² survival: P(χ²₁ > 3.84) ≈ 0.05", () => {
    const s = chi2Survival(3.841, 1);
    assert.ok(s > 0.03 && s < 0.07, `got ${s}`);
    assert.ok(chi2Survival(0, 1) === 1);
  });
});

// ── 2. Structure detector λ ──────────────────────────────────────────────────

describe("structure detector λ (method 2)", () => {
  it("uniform random streams sit at or below the 0.5 neutral line on average", () => {
    const lambdas = Array.from({ length: 30 }, (_, i) =>
      structureConfidence(randomDigits(1000 + i, 300), 10),
    );
    const mean = lambdas.reduce((a, b) => a + b, 0) / lambdas.length;
    assert.ok(mean < 0.52, `mean λ over random streams = ${mean.toFixed(3)}`);
  });

  it("a 70/30 high-vs-low digit split is read as at least mildly structured", () => {
    // Honest note: the bias is spread over 5 digits on each side, so each
    // digit deviates only ~40% from uniform — the G-test must (and does)
    // stay in the 0.7–0.95 confidence band, well above the random baseline.
    const lambdas = Array.from({ length: 10 }, (_, i) =>
      structureConfidence(biasedDigits(2000 + i, 300, 0.7, 4), 10),
    );
    const mean = lambdas.reduce((a, b) => a + b, 0) / lambdas.length;
    assert.ok(mean > 0.7, `mean λ over 70/30 streams = ${mean.toFixed(3)}`);
  });

  it("concentrated digit bias is read as strongly structured (λ → 1)", () => {
    // 80% of ticks from just {7, 8}: each of those digits is 4× expected —
    // overwhelming evidence against uniform.
    const rnd = mulberry32(3000);
    const digits = Array.from({ length: 300 }, () =>
      rnd() < 0.8 ? (rnd() < 0.5 ? 7 : 8) : Math.floor(rnd() * 10),
    );
    assert.ok(structureConfidence(digits, 10) > 0.95);
  });

  it("underpowered windows are neutral (0.5)", () => {
    assert.equal(structureConfidence([1, 2, 3], 10), 0.5);
  });
});

// ── 1 + 3. Edge estimator, σ, and z ──────────────────────────────────────────

describe("online edge estimator (method 1) & z vs break-even (method 3)", () => {
  it("converges to the true event rate on a 70% edge and reports a significant z", () => {
    const digits = biasedDigits(7, 1000, 0.7, 4); // 70% of digits > 4
    const f = quantumWindowEstimate(digits, [], "DIGITOVER", 4);
    assert.equal(f.neutral, false);
    // break-even for OVER 4 at fallback payout 1.95
    assert.ok(Math.abs(f.breakEven - 1 / 1.95) < 1e-9);
    assert.ok(f.pHat > 0.60 && f.pHat < 0.78, `pHat = ${f.pHat.toFixed(3)}`);
    assert.ok(f.sigma > 0.01 && f.sigma < 0.09, `σ = ${f.sigma.toFixed(4)}`);
    assert.ok(f.z > 2.0, `z = ${f.z.toFixed(2)}`);
    assert.ok(f.ciLow < f.pHat && f.pHat < f.ciHigh);
  });

  it("sits near neutral on a uniform random stream (|z| small)", () => {
    const maxAbsZ = Array.from({ length: 20 }, (_, i) => {
      const f = quantumWindowEstimate(randomDigits(5000 + i, 500), [], "DIGITOVER", 4);
      return { f, az: Math.abs(f.z) };
    });
    const meanAbsZ = maxAbsZ.reduce((a, b) => a + b.az, 0) / maxAbsZ.length;
    assert.ok(meanAbsZ < 1.5, `mean |z| over random streams = ${meanAbsZ.toFixed(3)}`);
    assert.ok(Math.abs(maxAbsZ[0]!.f.pHat - 0.5) < 0.1, `pHat = ${maxAbsZ[0]!.f.pHat.toFixed(3)}`);
  });

  it("σ shrinks with evidence (600 ticks tighter than 20 ticks)", () => {
    const longF = quantumWindowEstimate(biasedDigits(7, 600, 0.6, 4), [], "DIGITOVER", 4);
    const shortF = quantumWindowEstimate(biasedDigits(7, 20, 0.6, 4), [], "DIGITOVER", 4);
    assert.ok(longF.sigma < shortF.sigma, `${longF.sigma} vs ${shortF.sigma}`);
  });

  it("returns a neutral, fair-rate read for too-short windows", () => {
    const f = quantumWindowEstimate([1, 2, 3, 4], [], "DIGITOVER", 4);
    assert.equal(f.neutral, true);
    assert.equal(f.pHat, 0.5);
    assert.equal(f.z, 0);
  });

  it("exponentially-weighted transitions exploit known 1-step structure", () => {
    // Strict alternation 1,9,1,9,… (odd count → last tick is 1). The next
    // tick after a 1 is virtually certainly 9 — the transition matrix must
    // pull the estimate strongly in that direction.
    const digits: number[] = [];
    for (let i = 0; i < 299; i++) digits.push(i % 2 === 0 ? 1 : 9);
    assert.equal(digits[digits.length - 1], 1);
    const over = quantumWindowEstimate(digits, [], "DIGITOVER", 4);
    assert.ok(over.pHat > 0.7, `alternating (last=1) → over4 pHat = ${over.pHat.toFixed(3)}`);
    const under = quantumWindowEstimate(digits, [], "DIGITUNDER", 4);
    assert.ok(under.pHat < 0.35, `alternating (last=1) → under4 pHat = ${under.pHat.toFixed(3)}`);
  });

  it("handles rise/fall (CALL/PUT) price state streams", () => {
    const prices: number[] = [];
    let p = 100;
    for (let i = 0; i < 150; i++) {
      p += 0.05;
      prices.push(p);
    }
    const call = quantumWindowEstimate([], prices, "CALL", undefined);
    assert.ok(call.pHat > 0.85, `steady uptrend → CALL pHat = ${call.pHat.toFixed(3)}`);
    const put = quantumWindowEstimate([], prices, "PUT", undefined);
    assert.ok(put.pHat < 0.15, `steady uptrend → PUT pHat = ${put.pHat.toFixed(3)}`);
  });
});

// ── Bounded score terms ──────────────────────────────────────────────────────

describe("z-edge quality (method 3 scoring)", () => {
  it("is bounded in [-1, 1] and neutral when the estimate is weak", () => {
    assert.equal(zEdgeQuality(mk({ neutral: true, z: 9 })), 0);
    assert.equal(zEdgeQuality(mk({ z: 10, lambda: 1 })), 1);
    assert.equal(zEdgeQuality(mk({ z: -10, lambda: 1 })), -1);
    // structure gate: same z, low λ → much smaller contribution
    const structured = zEdgeQuality(mk({ z: 2, lambda: 0.95 }));
    const noisy = zEdgeQuality(mk({ z: 2, lambda: 0.4 }));
    assert.ok(structured > noisy, `${structured} vs ${noisy}`);
  });
});

describe("probabilistic entry timing (method 5)", () => {
  it("rewards a fresh break-even crossing with a rising edge", () => {
    const s = quantumTimingScore(mk({ crossedTicksAgo: 0, edgeSlope: 0.06 }));
    assert.ok(s >= 80, `got ${s}`); // 50 + 20 (fresh cross) + 15 (rising)
  });

  it("penalises an edge that never crossed above break-even and is fading", () => {
    const s = quantumTimingScore(mk({ crossedTicksAgo: -1, edgeSlope: -0.06 }));
    assert.ok(s <= 25, `got ${s}`); // 50 − 10 − 15
  });

  it("is neutral without evidence", () => {
    assert.equal(quantumTimingScore(mk({ neutral: true })), 50);
  });

  it("is always bounded 0–100", () => {
    const cases = [
      mk({ crossedTicksAgo: 0, edgeSlope: 1 }),
      mk({ crossedTicksAgo: 100, edgeSlope: -1 }),
      mk({ crossedTicksAgo: 1, edgeSlope: 0.01 }),
    ];
    for (const c of cases) {
      const s = quantumTimingScore(c);
      assert.ok(s >= 0 && s <= 100, `got ${s}`);
    }
  });
});

describe("market-specific streak-break hazard (method 5)", () => {
  it("fits the market's own break distribution and rewards streaks at their natural breaking point", () => {
    // T = target hit (digit 7 > 4), A = against (digit 2 ≤ 4).
    // Completed runs: [1, 2, 2, 3, 3, 3, 2, 1]; then T + OPEN run of 3.
    // → reached: r1=9, r2=6, r3=3; broke: b1=2, b2=3, b3=3
    // → h(3) = 4/5 = 0.8 vs baseline 0.524 → relative ≈ 1.53 → +6
    const seq: number[] = [];
    const runs = [1, 2, 2, 3, 3, 3, 2, 1];
    for (const r of runs) {
      seq.push(7); // break
      for (let i = 0; i < r; i++) seq.push(2);
    }
    seq.push(7); // break the last completed run, start the open one
    for (let i = 0; i < 3; i++) seq.push(2); // open run of 3

    const f = quantumWindowEstimate(seq, [], "DIGITOVER", 4);
    assert.equal(f.hazardK, 3);
    const bonus = hazardTimingBonus(f);
    assert.ok(bonus >= 3, `hazard bonus = ${bonus} (k=${f.hazardK}, rel=${f.hazardRelative.toFixed(2)})`);
  });

  it("returns 0 for fresh streaks and neutral estimates", () => {
    assert.equal(hazardTimingBonus(mk({ neutral: true })), 0);
    assert.equal(hazardTimingBonus(mk({ hazardK: 1, hazardRelative: 2 })), 0);
  });

  it("penalises unusually persistent long streaks", () => {
    const s = hazardTimingBonus(mk({ hazardK: 8, hazardRelative: 0.7 }));
    assert.ok(s < 0, `got ${s}`);
  });
});

describe("entropy onset (method 5)", () => {
  it("rewards structure appearing (recent entropy well below long-window)", () => {
    const f = quantumWindowEstimate(
      [...randomDigits(99, 35), ...Array(15).fill(7)],
      [], "DIGITEVEN", undefined,
    );
    const bonus = entropyOnsetBonus(f);
    assert.ok(bonus > 0, `ΔH=${f.entropyDelta.toFixed(3)} → bonus ${bonus}`);
  });

  it("penalises structure dissolving (recent entropy well above long-window)", () => {
    const f = quantumWindowEstimate(
      [...Array(35).fill(7), ...randomDigits(99, 15)],
      [], "DIGITEVEN", undefined,
    );
    const bonus = entropyOnsetBonus(f);
    assert.ok(bonus < 0, `ΔH=${f.entropyDelta.toFixed(3)} → bonus ${bonus}`);
  });

  it("is bounded to ±5", () => {
    assert.equal(entropyOnsetBonus(mk({ entropyDelta: -1 })), 5);
    assert.equal(entropyOnsetBonus(mk({ entropyDelta: 1 })), -5);
  });
});

// ── 4. Temporal stability: CI overlap & edge direction ───────────────────────

describe("temporal stability (method 4)", () => {
  it("rewards a shared CI region ABOVE break-even across windows", () => {
    const bonus = ciOverlapBonus([
      mk({ ciLow: 0.60, ciHigh: 0.75, breakEven: 0.51 }),
      mk({ ciLow: 0.55, ciHigh: 0.70, breakEven: 0.51 }),
    ]);
    assert.equal(bonus, 8);
    assert.ok(ciOverlapWidth([mk({ ciLow: 0.60, ciHigh: 0.75 }), mk({ ciLow: 0.55, ciHigh: 0.70 })]) > 0);
  });

  it("gives only the neutral bonus when CIs overlap BELOW break-even", () => {
    const bonus = ciOverlapBonus([
      mk({ ciLow: 0.30, ciHigh: 0.45, breakEven: 0.51 }),
      mk({ ciLow: 0.35, ciHigh: 0.50, breakEven: 0.51 }),
    ]);
    assert.equal(bonus, 4);
  });

  it("gives nothing when the windows disagree (no shared CI)", () => {
    const bonus = ciOverlapBonus([
      mk({ ciLow: 0.30, ciHigh: 0.40, breakEven: 0.51 }),
      mk({ ciLow: 0.55, ciHigh: 0.70, breakEven: 0.51 }),
    ]);
    assert.equal(bonus, 0);
    assert.equal(ciOverlapWidth([mk({ ciLow: 0.30, ciHigh: 0.40 }), mk({ ciLow: 0.55, ciHigh: 0.70 })]), 0);
  });

  it("gives nothing with a single window or neutral windows", () => {
    assert.equal(ciOverlapBonus([mk({ ciLow: 0.6, ciHigh: 0.8 })]), 0);
    assert.equal(ciOverlapBonus([mk({ neutral: true, ciLow: 0, ciHigh: 1 }), mk({ ciLow: 0.6, ciHigh: 0.8 })]), 0);
  });

  it("edge direction: improving vs fading", () => {
    assert.equal(edgeTrendBonus(mk({ pHat: 0.65 }), mk({ pHat: 0.55 })), 3);   // improving
    assert.equal(edgeTrendBonus(mk({ pHat: 0.55 }), mk({ pHat: 0.60 })), -2);  // softening
    assert.equal(edgeTrendBonus(mk({ pHat: 0.50 }), mk({ pHat: 0.60 })), -3);  // fading
    assert.equal(edgeTrendBonus(mk({ pHat: 0.57 }), mk({ pHat: 0.58 })), 0);   // stable
    assert.equal(edgeTrendBonus(mk({ neutral: true, pHat: 0.9 }), mk({ pHat: 0.5 })), 0);
  });
});
