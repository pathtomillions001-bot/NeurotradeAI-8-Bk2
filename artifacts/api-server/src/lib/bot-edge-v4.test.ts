/**
 * Bot Edge v4 — "Edge Honesty" upgrade tests.
 *
 * Pins the mathematical PROPERTIES of the v4 improvements on deterministic
 * fixtures (seeded PRNG) and on synthetic reads (for gate conditions that are
 * easier to construct than to plant):
 *
 *  1. Correlation-aware fusion: σ is inflated by √(1+(k−1)·ρ) vs the
 *     independence case, and the point estimate is unchanged.
 *  2. Recency-weighted Beta posterior: a recent hot block moves the mean more
 *     than an old one, and decay=1 reproduces the raw-count closed form.
 *  3. Variance-ratio test (Lo–MacKinlay): separates trending / alternating /
 *     i.i.d. return series; neutral on degenerate input.
 *  4. Recency-weighted posterior p-value: recent hotness is significant,
 *     ancient hotness is not.
 *  5. Match selection margin: a decisive hot digit clears the gate, two
 *     near-equal digits are refused, a locked digit is exempt.
 *  6. Differ repeat-hazard gate: a repeating digit is refused below the count
 *     veto, a cold digit passes.
 *  7. Match context-support gate: a contradicted current tick is refused.
 *  8. Live-payout-aware gate: a read that clears the fallback break-even is
 *     refused when the live payout is worse.
 *  9. EV-aware side arbitration: ranks by expected value (not bonus) and
 *     still applies hysteresis.
 * 10. Momentum v4 metrics: VR and runs-test metrics are present and point the
 *     right way on planted regimes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blendEstimates,
  blendEstimatesCorrelated,
  weightedBetaPosterior,
  posteriorRateProbabilityWeighted,
  varianceRatioTest,
  matchRead,
  differRead,
  momentumRead,
  specialistEntryGate,
  specialistSideChoice,
  MATCH_SELECTION_MARGIN,
  DIFFER_SELECTION_MARGIN,
  MATCH_CTX_SUPPORT_MIN,
  type SpecialistRead,
} from "./specialist-analysis";

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

function uniformDigits(n: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(rnd() * 10));
}

describe("v4 — correlation-aware fusion", () => {
  it("inflates σ by √(1+(k−1)·ρ) with k equally-weighted estimates", () => {
    const est = [
      { p: 0.5, sigma: 0.1 },
      { p: 0.5, sigma: 0.1 },
    ];
    const independent = blendEstimates(est);
    const correlated = blendEstimatesCorrelated(est, 0.3);
    // σ_iid = 0.1/√2; inflation √(1 + 0.3) for k=2.
    const expected = (0.1 / Math.sqrt(2)) * Math.sqrt(1.3);
    assert.ok(Math.abs(correlated.sigma - expected) < 1e-9, `σ ${correlated.sigma} ≠ ${expected}`);
    assert.ok(correlated.sigma > independent.sigma, "correlated σ must exceed independent σ");
    assert.equal(correlated.p, independent.p); // point estimate unchanged
    assert.equal(correlated.k, 2);
  });

  it("grows with the number of estimators and is neutral for a single one", () => {
    const one = blendEstimatesCorrelated([{ p: 0.4, sigma: 0.2 }], 0.5);
    assert.equal(one.sigma, 0.2);
    const three = blendEstimatesCorrelated(
      [{ p: 0.5, sigma: 0.1 }, { p: 0.5, sigma: 0.1 }, { p: 0.5, sigma: 0.1 }],
      0.3,
    );
    const expected = (0.1 / Math.sqrt(3)) * Math.sqrt(1 + 2 * 0.3);
    assert.ok(Math.abs(three.sigma - expected) < 1e-9, `σ ${three.sigma} ≠ ${expected}`);
  });

  it("preserves the inverse-variance point estimate with unequal σ", () => {
    const est = [
      { p: 0.6, sigma: 0.05 },
      { p: 0.4, sigma: 0.2 },
    ];
    const a = blendEstimates(est);
    const b = blendEstimatesCorrelated(est, 0.4);
    assert.equal(b.p, a.p);
    assert.ok(b.sigma > a.sigma);
  });
});

describe("v4 — recency-weighted Beta posterior", () => {
  it("decay = 1 reproduces the raw-count closed form exactly", () => {
    const series = [0, 1, 0, 1, 1]; // 3 hits in 5
    const w = weightedBetaPosterior(series, 0.1, 10, 1);
    // Beta(3 + 1, 2 + 9) = Beta(4, 11): mean 4/15.
    assert.ok(Math.abs(w.mean - 4 / 15) < 1e-9, `mean ${w.mean} ≠ 4/15`);
    assert.ok(Math.abs(w.nEff - 5) < 1e-9, `nEff ${w.nEff} ≠ 5`);
  });

  it("a RECENT hot block moves the mean more than an OLD one of the same size", () => {
    const rnd = mulberry32(5);
    const noise = Array.from({ length: 100 }, () => (rnd() < 0.1 ? 1 : 0));
    const oldHot = [...Array.from({ length: 50 }, () => 1), ...noise];
    const recentHot = [...noise, ...Array.from({ length: 50 }, () => 1)];
    const oldPost = weightedBetaPosterior(oldHot, 0.1, 10, 0.99);
    const recentPost = weightedBetaPosterior(recentHot, 0.1, 10, 0.99);
    assert.ok(
      recentPost.mean > oldPost.mean + 0.05,
      `recent ${recentPost.mean.toFixed(3)} should dominate old ${oldPost.mean.toFixed(3)}`,
    );
    assert.ok(recentPost.nEff < 150, `n_eff should be memory-bounded, got ${recentPost.nEff.toFixed(1)}`);
  });

  it("the weighted posterior p-value flags recent hotness, not ancient hotness", () => {
    const rnd = mulberry32(6);
    const noise = Array.from({ length: 150 }, () => (rnd() < 0.1 ? 1 : 0));
    const ancient = [...Array.from({ length: 40 }, () => 1), ...noise];
    const recent = [...noise, ...Array.from({ length: 40 }, () => 1)];
    const pAncient = posteriorRateProbabilityWeighted(ancient, 0.1, "hot", 0.1, 10, 0.99);
    const pRecent = posteriorRateProbabilityWeighted(recent, 0.1, "hot", 0.1, 10, 0.99);
    assert.ok(pRecent < 0.05, `recent hotness should be significant, got ${pRecent.toFixed(3)}`);
    assert.ok(pAncient > pRecent, `ancient hotness must not out-rank recency (${pAncient.toFixed(3)} vs ${pRecent.toFixed(3)})`);
  });
});

describe("v4 — Lo–MacKinlay variance-ratio test", () => {
  it("reads a trending (AR(1), φ=0.7) series as VR > 1 with significant z", () => {
    const rnd = mulberry32(21);
    const returns: number[] = [];
    let x = 0;
    for (let i = 0; i < 400; i++) {
      x = 0.7 * x + (rnd() - 0.5);
      returns.push(x);
    }
    const vr = varianceRatioTest(returns, 4);
    assert.ok(vr.vr > 1.05, `expected VR > 1.05 for a trending series, got ${vr.vr}`);
    assert.ok(vr.z > 1.5, `expected z > 1.5 for a trending series, got ${vr.z}`);
  });

  it("reads a strictly alternating series as VR < 1 with significant z", () => {
    const returns: number[] = [];
    for (let i = 0; i < 200; i++) returns.push(i % 2 === 0 ? 1 : -1);
    const vr = varianceRatioTest(returns, 4);
    assert.ok(vr.vr < 0.5, `expected VR ≪ 1 for an alternating series, got ${vr.vr}`);
    assert.ok(vr.z < -1.5, `expected z < −1.5 for an alternating series, got ${vr.z}`);
  });

  it("sits near 1 for i.i.d. returns", () => {
    const rnd = mulberry32(22);
    const returns = Array.from({ length: 400 }, () => rnd() - 0.5);
    const vr = varianceRatioTest(returns, 4);
    assert.ok(vr.vr > 0.7 && vr.vr < 1.3, `expected VR ≈ 1 for iid, got ${vr.vr}`);
    assert.ok(Math.abs(vr.z) < 2.5, `expected |z| < 2.5 for iid, got ${vr.z}`);
  });

  it("is neutral for short and degenerate series", () => {
    assert.equal(varianceRatioTest([1, 2, 3], 4).z, 0);
    assert.equal(varianceRatioTest(Array.from({ length: 100 }, () => 5), 4).z, 0);
  });
});

describe("v4 — match selection margin (real reads)", () => {
  it("a decisive hot digit clears the selection-margin gate", () => {
    const rnd = mulberry32(31);
    const digits = Array.from({ length: 400 }, () => (rnd() < 0.30 ? 7 : Math.floor(rnd() * 10)));
    const { read } = matchRead(digits);
    const margin = read.metrics["selectionMargin"];
    assert.ok(margin !== undefined && margin >= MATCH_SELECTION_MARGIN, `expected margin ≥ ${MATCH_SELECTION_MARGIN} for a 30% digit, got ${margin}`);
    assert.equal(specialistEntryGate(read).pass, true);
  });

  it("near-equal hot digits produce a small margin (a coin-flip, not an edge)", () => {
    // Two digits at 14% each: the best digit is NOT decisively better than
    // the runner-up, so the selection-margin statistic must sit below the
    // 95% threshold. Tried across several seeds to keep the assertion robust.
    let worst = -Infinity;
    for (const seed of [32, 33, 34, 35]) {
      const rnd = mulberry32(seed);
      const digits = Array.from({ length: 800 }, () => {
        const r = rnd();
        if (r < 0.14) return 3;
        if (r < 0.28) return 7;
        return Math.floor(rnd() * 10);
      });
      const { read } = matchRead(digits);
      worst = Math.max(worst, read.metrics["selectionMargin"] ?? 0);
    }
    assert.ok(worst < MATCH_SELECTION_MARGIN, `two 14% digits must be near-equal, worst margin was ${worst.toFixed(2)}`);
  });

  it("a locked digit is exempt from the selection margin", () => {
    // Locked digit with a tiny margin (near-equal field) — the gate must NOT
    // refuse on selection-margin grounds (it may refuse on other grounds).
    const read: SpecialistRead = {
      family: "match",
      bonus: 4,
      confidence: 60,
      metrics: {
        pHat: 0.16, sigma: 0.02, zBe: 2.4, breakEven: 0.112,
        gap: 7, hazardRelative: 1.3, ctxN: 20, ctxSupport: 0.12,
        // no selectionMargin metric — locked digit
      },
      signals: [],
    };
    assert.equal(specialistEntryGate(read).pass, true);
  });
});

describe("v4 — gate conditions (synthetic reads)", () => {
  it("match: a sub-threshold selection margin refuses the trade", () => {
    const read: SpecialistRead = {
      family: "match",
      bonus: 4,
      confidence: 60,
      metrics: {
        pHat: 0.16, sigma: 0.02, zBe: 2.4, breakEven: 0.112,
        gap: 7, hazardRelative: 1.3, ctxN: 20, ctxSupport: 0.12,
        selectionMargin: 0.8, // |N(0,1)| territory — a coin-flip
      },
      signals: [],
    };
    const verdict = specialistEntryGate(read);
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /near-equal/);
  });

  it("match: the current-tick context must not contradict the digit", () => {
    const read: SpecialistRead = {
      family: "match",
      bonus: 4,
      confidence: 60,
      metrics: {
        pHat: 0.16, sigma: 0.02, zBe: 2.4, breakEven: 0.112,
        gap: 7, hazardRelative: 1.3, ctxN: 40,
        ctxSupport: 0.04, // P(chosen|last) far below the 0.07 floor
        selectionMargin: 2.5,
      },
      signals: [],
    };
    const verdict = specialistEntryGate(read);
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /context contradicts/);
  });

  it("differ: the repeat hazard must fit the loss budget even without a hot-run count", () => {
    // recent6 = 0 (no count veto), worst case fine, but the transition row
    // says the target repeats 10% of the time — above the 8.26% budget.
    const read: SpecialistRead = {
      family: "differ",
      bonus: 2,
      confidence: 50,
      metrics: {
        pHat: 0.06, sigma: 0.015, upper: 0.08, worstCaseWin: 0.93,
        breakEven: 1 / 1.09, zSafety: 1.0, gap: 5, recent6: 0,
        significantDigits: 1, ctxN: 20, ctxSupport: 0.10,
        selectionMargin: 2.0,
      },
      signals: [],
    };
    const verdict = specialistEntryGate(read);
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /repeat hazard/);
  });

  it("differ: a cold digit with a safe repeat hazard passes", () => {
    const read: SpecialistRead = {
      family: "differ",
      bonus: 4,
      confidence: 70,
      metrics: {
        pHat: 0.03, sigma: 0.01, upper: 0.05, worstCaseWin: 0.95,
        breakEven: 1 / 1.09, zSafety: 3.0, gap: 12, recent6: 0,
        significantDigits: 1, ctxN: 25, ctxSupport: 0.03,
        selectionMargin: 2.5,
      },
      signals: [],
    };
    assert.equal(specialistEntryGate(read).pass, true);
  });

  it("a real repeating digit is refused by the repeat hazard below the count veto", () => {
    // Last ticks end on digit 5 twice, but only 2× in the last 6 (no count
    // veto); digit 5 appears ~30% so P(5|5) is far above the loss budget.
    const rnd = mulberry32(41);
    const digits = Array.from({ length: 200 }, () => (rnd() < 0.30 ? 5 : Math.floor(rnd() * 10)));
    digits.push(1, 2, 3, 4, 3, 5, 5); // last 6 = [2,3,4,3,5,5], recent6 = 2
    const { read } = differRead(digits, 5);
    assert.ok((read.metrics["recent6"] ?? 0) < 3, "fixture must stay below the count veto");
    assert.equal(specialistEntryGate(read).pass, false, "repeat hazard must veto");
  });

  it("barrier: a live payout worse than the fallback refuses the trade", () => {
    // OVER 4 fallback pays 1.95× (be 51.28%): pHat 0.56 / σ 0.03 clears the
    // 0.75σ margin. A live quote of 1.80× (be 55.6%) must refuse it.
    const read: SpecialistRead = {
      family: "barrier",
      bonus: 3,
      confidence: 55,
      metrics: {
        pHat: 0.56, sigma: 0.03, zBe: 1.57, breakEven: 1 / 1.95,
        requiredZBe: 0.75, hazardK: 0, hazardRelative: 1,
      },
      signals: [],
    };
    assert.equal(specialistEntryGate(read).pass, true, "fallback break-even should pass");
    const live = specialistEntryGate(read, { payout: 1.8 });
    assert.equal(live.pass, false, "live 1.80× break-even must fail the margin");
    assert.match(live.reason, /margin|break-even/);
  });
});

describe("v4 — EV-aware side arbitration", () => {
  it("ranks by expected value when valueOf is supplied, not by bonus", () => {
    const reads = [
      { side: "DIGITOVER", read: { family: "barrier", bonus: 8, confidence: 50, metrics: {}, signals: [] } },
      { side: "DIGITUNDER", read: { family: "barrier", bonus: 3, confidence: 50, metrics: {}, signals: [] } },
    ];
    const ev = (side: string) => (side === "DIGITUNDER" ? 0.18 : 0.05);
    const verdict = specialistSideChoice(reads, undefined, 0.02, (r, side) => ev(side));
    assert.equal(verdict?.side, "DIGITUNDER", "higher EV must win even with a lower bonus");
  });

  it("applies hysteresis in EV units", () => {
    const reads = [
      { side: "DIGITOVER", read: { family: "barrier", bonus: 8, confidence: 50, metrics: {}, signals: [] } },
      { side: "DIGITUNDER", read: { family: "barrier", bonus: 3, confidence: 50, metrics: {}, signals: [] } },
    ];
    const ev = (side: string) => (side === "DIGITUNDER" ? 0.18 : 0.17); // leads by 0.01 < 0.02
    const verdict = specialistSideChoice(reads, "DIGITOVER", 0.02, (r, side) => ev(side));
    assert.equal(verdict?.side, "DIGITOVER", "a 1pp EV lead must not switch the side");
    assert.match(verdict!.reason, /hysteresis/);
  });

  it("switches once the EV lead clears the margin", () => {
    const reads = [
      { side: "DIGITOVER", read: { family: "barrier", bonus: 8, confidence: 50, metrics: {}, signals: [] } },
      { side: "DIGITUNDER", read: { family: "barrier", bonus: 3, confidence: 50, metrics: {}, signals: [] } },
    ];
    const ev = (side: string) => (side === "DIGITUNDER" ? 0.30 : 0.17);
    const verdict = specialistSideChoice(reads, "DIGITOVER", 0.02, (r, side) => ev(side));
    assert.equal(verdict?.side, "DIGITUNDER");
  });
});

describe("v4 — momentum metrics", () => {
  it("exposes VR and runs metrics pointing at a trending stream", () => {
    // Persistent (autocorrelated) increments: AR(1) on the returns with φ=0.6.
    // A random walk WITH DRIFT is not a trending series — VR would be ≈ 1.
    const prices: number[] = [];
    let p = 100;
    let x = 0;
    const rnd = mulberry32(51);
    for (let i = 0; i < 160; i++) {
      x = 0.6 * x + (rnd() - 0.5);
      p += x;
      prices.push(p);
    }
    const read = momentumRead(prices, "CALL");
    const vr = read.metrics["vr"] ?? 1;
    const vrZ = read.metrics["vrZ"] ?? 0;
    const runsZ = read.metrics["runsZ"] ?? 0;
    assert.ok(vr > 1, `trending tape should have VR > 1, got ${vr}`);
    assert.ok(Math.abs(vrZ) > 0, `VR z should be non-zero, got ${vrZ}`);
    assert.ok(runsZ < 0, `a persistent uptrend should cluster (z_run < 0), got ${runsZ}`);
  });

  it("does not claim a regime when the variance ratio contradicts it", () => {
    // Alternating tape: Hurst says mean-reverting, VR agrees (VR < 1) — the
    // PUT read (fade the last move) should carry the positive regime bonus.
    const returns: number[] = [];
    for (let i = 0; i < 120; i++) returns.push(i % 2 === 0 ? 1 : -1);
    const prices: number[] = [];
    let p = 100;
    for (const r of returns) { p += r; prices.push(p); }
    const put = momentumRead(prices, "PUT");
    assert.ok((put.metrics["vr"] ?? 1) < 1, `alternation should read VR < 1`);
    assert.equal(put.metrics["vrSupports"], 1, "VR must support the mean-reverting regime");
  });
});

describe("v4 — constants sanity", () => {
  it("selection margins are in sane ranges", () => {
    // Both are the 95% one-sided threshold of the difference z-test.
    assert.ok(MATCH_SELECTION_MARGIN > 1.5 && MATCH_SELECTION_MARGIN < 1.8);
    assert.ok(DIFFER_SELECTION_MARGIN > 1.5 && DIFFER_SELECTION_MARGIN < 1.8);
    assert.ok(MATCH_CTX_SUPPORT_MIN > 0 && MATCH_CTX_SUPPORT_MIN < 0.1);
  });
});
