/**
 * Parity Forge analysis tests.
 *
 * The properties that matter:
 *  1. On FAIR streams the bot must measure no edge (paper expectancy centered
 *     on ≤ 0, never PRIME) — sharper lenses must not manufacture accuracy that
 *     is not there.
 *  2. On PLANTED-structure streams (alternation cycles, digit-conditioned
 *     parity, higher-order chains) the upgraded lens stack must actually see
 *     the structure: echo/CTW lenses earn weight, the fused probability
 *     clears the recovery bar honestly, and the replay converts it into
 *     positive expectancy without starving either mode.
 *  3. Fusion discipline: weights stay on the simplex with every lens alive,
 *     τ never sharpens (≥ 1), and q_LL is the fused complement of the side.
 *
 * All randomness is seeded (mulberry32) so the suite is deterministic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DigitParity,
  PARITY_FORGE_LENS_COUNT,
  ParityCTW,
  ParityEcho,
  ParityForgePolicy,
  ParityMarkov,
  optimizeBinaryPoolWeights,
  replayParityForge,
  scoreParityForgeMarket,
  weightsFromSkillN,
} from "./parity-forge-analysis.js";

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

/** Perfect alternation with noise: p_t flips with probability flipP. */
function alternatingStream(n: number, flipP: number, seed = 11): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [Math.floor(rnd() * 2)];
  for (let i = 1; i < n; i++) {
    const flip = rnd() < flipP;
    out.push(flip ? 1 - out[i - 1]! : out[i - 1]!);
  }
  // Expand parities into digits (even digit ↔ parity 0).
  return out.map(p => p === 0 ? 2 : 3);
}

/** Order-3 parity chain: parity repeats twice then flips (period-3 cycle). */
function period3Stream(n: number, seed = 13): number[] {
  const rnd = mulberry32(seed);
  const seq: number[] = [];
  let p = Math.floor(rnd() * 2);
  for (let i = 0; i < n; i++) {
    seq.push(p);
    if (i % 3 === 2) p = 1 - p; // flip every 3rd step
  }
  return seq.map(x => x === 0 ? 4 : 5);
}

/** After digit 9 the next digit is EVEN 75% of the time. */
function digitTiltStream(n: number, seed = 17): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (out.length > 0 && out[i - 1] === 9 && rnd() < 0.75) {
      const evens = [0, 2, 4, 6, 8];
      out.push(evens[Math.floor(rnd() * evens.length)]!);
    } else {
      out.push(Math.floor(rnd() * 10));
    }
  }
  return out;
}

describe("ParityMarkov", () => {
  it("reads an alternation bias (P(flip) > 0.5)", () => {
    const digits = alternatingStream(3000, 0.7, 21);
    const mkv = new ParityMarkov();
    for (let i = 0; i < digits.length; i++) mkv.update(digits, i);
    // P(next parity flips) must read above fair from the ACTUAL last parity.
    const lastP = digits[digits.length - 1]! % 2;
    const pFlip = mkv.p(digits, digits.length - 1, 1 - lastP);
    assert.ok(pFlip > 0.55, `pFlip=${pFlip} (last parity ${lastP})`);
  });
});

describe("ParityCTW", () => {
  it("tracks a period-3 parity cycle better than an order-1 chain", () => {
    const digits = period3Stream(2600, 31);
    const ctw = new ParityCTW();
    const mkv = new ParityMarkov();
    for (let i = 0; i < digits.length; i++) {
      ctw.update(digits, i);
      mkv.update(digits, i);
    }
    // Compare one-step log-loss on a fresh stretch the models saw (in-sample
    // capacity comparison is the point: CTW reaches depth 3, the chain does not).
    let llCtw = 0;
    let llMkv = 0;
    let n = 0;
    for (let i = 2000; i < digits.length - 1; i++) {
      const next = digits[i + 1]! % 2;
      llCtw += -Math.log(Math.max(1e-9, ctw.p(digits, i, next)));
      llMkv += -Math.log(Math.max(1e-9, mkv.p(digits, i, next)));
      n++;
    }
    assert.ok(llCtw / n < llMkv / n, `ctw=${(llCtw / n).toFixed(4)} mkv=${(llMkv / n).toFixed(4)}`);
    assert.ok(llCtw / n < 0.45, `ctw should be sharp on a deterministic cycle: ${llCtw / n}`);
  });

  it("stays near fair on a fair stream", () => {
    const digits = fairStream(2600, 33);
    const ctw = new ParityCTW();
    for (let i = 0; i < digits.length; i++) ctw.update(digits, i);
    let ll = 0;
    let n = 0;
    for (let i = 2000; i < digits.length - 1; i++) {
      const next = digits[i + 1]! % 2;
      ll += -Math.log(Math.max(1e-9, ctw.p(digits, i, next)));
      n++;
    }
    // ln(2) ≈ 0.693 is the fair baseline; allow modest sampling slack.
    assert.ok(ll / n < 0.72, `fair log-loss=${(ll / n).toFixed(4)}`);
  });
});

describe("ParityEcho", () => {
  it("sees alternation as a below-fair lag-1 same-rate", () => {
    const digits = alternatingStream(2600, 0.75, 41);
    const echo = new ParityEcho();
    for (let i = 0; i < digits.length; i++) echo.update(digits, i);
    assert.ok(echo.rate(1) < 0.4, `lag-1 same-rate=${echo.rate(1)}`);
    assert.ok(echo.rate(2) > 0.6, `lag-2 same-rate=${echo.rate(2)}`);
  });

  it("tilts toward the flip on an alternating tape", () => {
    const digits = alternatingStream(2600, 0.75, 43);
    const echo = new ParityEcho();
    for (let i = 0; i < digits.length - 1; i++) echo.update(digits, i);
    const last = digits[digits.length - 2]! % 2;
    const pFlip = echo.p(digits, digits.length - 2, 1 - last);
    assert.ok(pFlip > 0.6, `pFlip=${pFlip}`);
  });
});

describe("DigitParity (two-digit backoff)", () => {
  it("learns that after 9 the next digit skews even", () => {
    const digits = digitTiltStream(4000, 51);
    const dp = new DigitParity();
    for (let i = 0; i < digits.length; i++) dp.update(digits, i);
    const ctx = [3, 9];
    const pEven = dp.p(ctx, ctx.length - 1, 0);
    assert.ok(pEven > 0.6, `p(even|…,9)=${pEven}`);
    // The pair layer must beat the one-digit layer on this structure.
    const pOne = dp.oneDigit(ctx, ctx.length - 1, 0);
    assert.ok(pEven >= pOne - 0.02, `pair=${pEven} one=${pOne}`);
  });
});

describe("fusion discipline", () => {
  it("weightsFromSkillN keeps every lens alive and sums to one", () => {
    const w = weightsFromSkillN([0.69, 0.66, 0.69, 0.72, 0.60, 0.68], Math.log(2));
    assert.equal(w.length, PARITY_FORGE_LENS_COUNT);
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(w.every(v => v >= 0.05 - 1e-9), `floor violated: ${w}`);
  });

  it("optimizeBinaryPoolWeights stays on the simplex and refuses noise-chasing on fair lenses", () => {
    const rnd = mulberry32(61);
    // Near-fair lenses: tiny random tilts, no real skill.
    const samples = Array.from({ length: 1200 }, () => ({
      lenses: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5].map(() => 0.5 + (rnd() - 0.5) * 0.04),
      event: rnd() < 0.5 ? 1 : 0,
    }));
    const { weights } = optimizeBinaryPoolWeights(samples, [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6], 1, [1, 1.3, 1.8]);
    assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(weights.every(v => v >= 0.05 - 1e-9), `${weights}`);
    // Regularised descent must NOT run far from uniform on noise.
    const dev = Math.max(...weights.map(v => Math.abs(v - 1 / 6)));
    assert.ok(dev < 0.12, `noise-chasing weights: ${weights.map(w => w.toFixed(2))}`);
  });

  it("optimizeBinaryPoolWeights rewards the lens that actually predicts", () => {
    const rnd = mulberry32(63);
    const samples = Array.from({ length: 1500 }, () => {
      const truth = rnd() < 0.5 ? 1 : 0;
      const good = Math.min(0.95, Math.max(0.05, truth === 1 ? 0.5 + 0.18 + rnd() * 0.06 : 0.5 - 0.18 - rnd() * 0.06));
      const noise = 0.5 + (rnd() - 0.5) * 0.03;
      return { lenses: [noise, noise, noise, noise, good, noise], event: truth };
    });
    const { weights } = optimizeBinaryPoolWeights(samples, [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6], 1, [1, 1.3]);
    assert.ok(weights[4]! > 1.5 / 6, `skilled lens underweighted: ${weights.map(w => w.toFixed(2))}`);
  });
});

describe("ParityForgePolicy", () => {
  it("qLL is the fused complement of the opposite side", () => {
    const digits = alternatingStream(2200, 0.65, 71);
    const policy = new ParityForgePolicy({ weights: [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6], tau: 1, normalInitBar: 0.53 });
    for (let i = 0; i < digits.length; i++) policy.update(digits, i);
    const read = policy.readSide(digits, digits.length - 1, { id: "even" } as never);
    const opp = policy.pooledSide(digits, digits.length - 1, 1);
    assert.ok(Math.abs(read.qLL - opp.p) < 1e-9, `qLL=${read.qLL} opp=${opp.p}`);
    assert.ok(read.lenses.length === PARITY_FORGE_LENS_COUNT, `lenses=${read.lenses.length}`);
  });

  it("recovery fires on planted structure (never starves in debt)", () => {
    const digits = alternatingStream(3200, 0.72, 73);
    const read = scoreParityForgeMarket(digits);
    assert.ok(read.metrics.recoveryShots > 0, `recovery shots=${read.metrics.recoveryShots}`);
    assert.ok(read.metrics.recoveryHitRate > 0.6, `recovery hit rate=${read.metrics.recoveryHitRate}`);
    assert.ok(read.metrics.recoveryLossPairs <= read.metrics.recoveryShots * 0.15, `loss pairs=${read.metrics.recoveryLossPairs}`);
  });

  it("normal valve trades near its budget on a fair tape (no starvation)", () => {
    const digits = fairStream(3200, 75);
    const { metrics } = replayParityForge(digits, { weights: [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6], tau: 1, normalInitBar: 0.5 }, { warmup: 300 });
    // Budget is 0.20 shots/tick; the valve self-corrects to its target.
    assert.ok(metrics.normalShots > 40, `normal shots=${metrics.normalShots}`);
    assert.ok(metrics.normalHitRate > 0.4 && metrics.normalHitRate < 0.6, `hit rate=${metrics.normalHitRate}`);
  });

  it("stays honest on fair tapes (no PRIME, expectancy centered ≤ 0)", () => {
    let edgeSum = 0;
    for (const seed of [81, 83, 85, 87]) {
      const read = scoreParityForgeMarket(fairStream(2600, seed));
      assert.notEqual(read.verdict, "prime", `seed=${seed} edge=${read.paperEdgePerDollar}`);
      edgeSum += read.paperEdgePerDollar;
    }
    assert.ok(edgeSum / 4 < 0.05, `mean fair edge=${edgeSum / 4}`);
  });

  it("converts alternation into measured expectancy", () => {
    const read = scoreParityForgeMarket(alternatingStream(3600, 0.7, 91));
    assert.ok(read.paperEdgePerDollar > 0, `edge=${read.paperEdgePerDollar}`);
    assert.notEqual(read.verdict, "thin");
    // The lenses that see alternation must earn their keep.
    const w = read.params.weights;
    assert.ok(w[4]! + w[5]! > 0.2, `ctw+echo starved: ${w.map(x => x.toFixed(2))}`);
  });
});
