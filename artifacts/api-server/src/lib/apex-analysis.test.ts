/**
 * Echo Apex analysis tests.
 *
 * The two properties that matter:
 *  1. On FAIR streams the bot must measure no edge (hit ≈ 10%, expectancy ≤ 0,
 *     never PRIME) — it must not invent accuracy that is not there.
 *  2. On PLANTED-edge streams (repeat rhythm the lenses are built to see) the
 *     full fit → replay pipeline must measure positive expectancy AND keep
 *     firing near its budgeted rate — the pacing valve paces, it never
 *     starves the session the way a hard-gate stack does.
 *
 * All randomness is seeded (mulberry32) so the suite is deterministic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APEX_BREAKEVEN,
  APEX_PACE_TARGET,
  EchoScope,
  HawkesBank,
  PacingValve,
  SuffixMemory,
  argmax,
  fitApexParams,
  fitHawkes,
  logPool,
  replayPolicy,
  scoreMarket,
  temperatureScale,
  weightsFromSkill,
  wilson,
  defaultApexParams,
} from "./apex-analysis.js";

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

/** Digits echo the previous digit with elevated probability — repeat rhythm. */
function echoStream(n: number, echoP: number, seed = 11): number[] {
  const rnd = mulberry32(seed);
  const out = [Math.floor(rnd() * 10)];
  for (let i = 1; i < n; i++) {
    out.push(rnd() < echoP ? out[i - 1] : Math.floor(rnd() * 10));
  }
  return out;
}

/** Lag-3 echo: d_t copies d_{t-3} with elevated probability. */
function lag3Stream(n: number, seed = 13): number[] {
  const rnd = mulberry32(seed);
  const out = [Math.floor(rnd() * 10), Math.floor(rnd() * 10), Math.floor(rnd() * 10)];
  for (let i = 3; i < n; i++) {
    out.push(rnd() < 0.3 ? out[i - 3] : Math.floor(rnd() * 10));
  }
  return out;
}

/** Order-2 pattern: after 4,4 the next digit is 7 half the time. */
function patternStream(n: number, seed = 17): number[] {
  const rnd = mulberry32(seed);
  const out = [Math.floor(rnd() * 10), Math.floor(rnd() * 10)];
  for (let i = 2; i < n; i++) {
    if (out[i - 2] === 4 && out[i - 1] === 4 && rnd() < 0.5) out.push(7);
    else out.push(Math.floor(rnd() * 10));
  }
  return out;
}

describe("wilson", () => {
  it("brackets the true rate on a balanced sample", () => {
    const w = wilson(50, 100);
    assert.ok(w.lower > 0.39 && w.lower < 0.42, `lower=${w.lower}`);
    assert.ok(w.upper > 0.58 && w.upper < 0.61, `upper=${w.upper}`);
  });
});

describe("EchoScope", () => {
  it("detects a planted lag-3 echo and ignores lag-1", () => {
    const digits = lag3Stream(3000);
    const scope = new EchoScope();
    for (let i = 0; i < digits.length; i++) scope.update(digits, i);
    assert.ok(scope.rate(3) > 0.2, `lag-3 rate=${scope.rate(3)}`);
    assert.ok(scope.zScore(3) > 8, `lag-3 z=${scope.zScore(3)}`);
    assert.ok(Math.abs(scope.rate(1) - 0.1) < 0.03, `lag-1 rate=${scope.rate(1)}`);
    const top = scope.topLags(1)[0];
    assert.equal(top.lag, 3);
  });

  it("tilts toward the echoing digit when scoring", () => {
    const digits = echoStream(2000, 0.3);
    const scope = new EchoScope();
    for (let i = 0; i < digits.length - 1; i++) scope.update(digits, i);
    const probs = scope.score(digits, digits.length - 2);
    const last = digits[digits.length - 2];
    assert.ok(probs[last] > 0.2, `p(last=${last})=${probs[last]}`);
    assert.equal(argmax(probs), last);
  });

  it("stays near fair on a fair stream", () => {
    const digits = fairStream(3000);
    const scope = new EchoScope();
    for (let i = 0; i < digits.length; i++) scope.update(digits, i);
    for (let k = 1; k <= 6; k++) {
      assert.ok(Math.abs(scope.rate(k) - 0.1) < 0.04, `lag-${k} rate=${scope.rate(k)}`);
    }
  });
});

describe("HawkesBank", () => {
  it("fits stronger excitation on a clustered stream than on a fair one", () => {
    const clustered = fitHawkes(echoStream(2500, 0.35, 21));
    const fair = fitHawkes(fairStream(2500, 22));
    assert.ok(clustered.alpha > fair.alpha, `clustered α=${clustered.alpha} fair α=${fair.alpha}`);
    assert.ok(Number.isFinite(clustered.beta) && clustered.beta > 0);
  });

  it("heats the digit that just arrived in bursts", () => {
    const bank = new HawkesBank(0.3, 0.2);
    for (let i = 0; i < 40; i++) bank.update(i % 3 === 0 ? 9 : (i % 10));
    const heat = bank.heat();
    assert.equal(heat.digit, 9);
    assert.ok(heat.ratio > 1.2, `heat ratio=${heat.ratio}`);
  });
});

describe("SuffixMemory", () => {
  it("predicts a planted order-2 continuation", () => {
    const digits = patternStream(4000);
    const mem = new SuffixMemory();
    for (let i = 0; i < digits.length; i++) mem.update(digits, i);
    // Query on a fresh context ending in 4,4.
    const ctx = [1, 2, 3, 4, 4];
    const pred = mem.predict(ctx, ctx.length - 1);
    assert.ok(pred.order >= 2, `order=${pred.order}`);
    assert.ok(pred.probs[7] > 0.25, `p(7|4,4)=${pred.probs[7]}`);
  });

  it("backs off to uniform on unseen contexts", () => {
    const mem = new SuffixMemory();
    const pred = mem.predict([0, 1, 2], 2);
    assert.equal(pred.order, 0);
    assert.ok(pred.probs.every(p => Math.abs(p - 0.1) < 1e-9));
  });
});

describe("fusion", () => {
  it("a concentrated weight vector follows that lens", () => {
    const echo = [0.5, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.1];
    const flat = new Array<number>(10).fill(0.1);
    const fused = logPool([echo, flat, flat], [1, 0, 0]);
    assert.equal(argmax(fused), 0);
    assert.ok(Math.abs(fused[0] - 0.5) < 1e-9);
  });

  it("temperature 1 is the identity and lower tau sharpens", () => {
    const p = [0.3, 0.2, 0.1, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
    const same = temperatureScale(p, 1);
    assert.ok(same.every((v, i) => Math.abs(v - p[i]) < 1e-12));
    const sharp = temperatureScale(p, 0.6);
    assert.ok(sharp[0] > p[0], `sharpened=${sharp[0]}`);
    const sum = sharp.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it("weights reward the better lens and always sum to one", () => {
    const w = weightsFromSkill([2.0, 2.3, 2.3]);
    assert.ok(Math.abs(w[0] + w[1] + w[2] - 1) < 1e-9);
    assert.ok(w[0] > w[1] && w[0] > w[2], `w=${w}`);
    assert.ok(w.every(v => v >= 0.04), `floor violated: ${w}`);
  });
});

describe("PacingValve", () => {
  it("converges to its budgeted fire rate without starving", () => {
    const rnd = mulberry32(31);
    for (const pace of ["brisk", "steady", "patient"] as const) {
      const target = APEX_PACE_TARGET[pace];
      const valve = new PacingValve(target, 0.2, APEX_BREAKEVEN);
      const score = () => (rnd() < 0.7 ? 0.1 + rnd() * 0.05 : 0.15 + rnd() * 0.25);
      // Bimodal scores: mostly weak, sometimes strong — like real setups.
      // Warm up past the transient (live trading starts at the scan-seeded
      // bar, so only steady-state behaviour matters).
      for (let i = 0; i < 1500; i++) valve.observe(score());
      let fires = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) {
        if (valve.observe(score())) fires++;
      }
      const rate = fires / n;
      assert.ok(
        Math.abs(rate - target) < 0.4 * target,
        `${pace}: rate=${rate.toFixed(4)} target=${target}`,
      );
    }
  });
});

describe("apex pipeline on fair streams", () => {
  it("grades fair data THIN — lucky hits without mass are not edge", () => {
    for (const seed of [41, 43, 1, 2, 3]) {
      const digits = fairStream(2600, seed);
      const read = scoreMarket(digits, "steady");
      assert.equal(read.verdict, "thin", `seed=${seed} shots=${read.shots} hitRate=${read.hitRate}`);
    }
  });

  it("stands down on fair data (every fired shot would be -EV)", () => {
    const digits = fairStream(2600, 43);
    const read = scoreMarket(digits, "steady");
    // The break-even floor binds: the valve stays armed at the right bar,
    // but nearly every score sits below break-even, so almost nothing fires.
    // Standing down on a -EV stream is discipline, not over-filtering —
    // the scan honestly reports THIN and the user deploys elsewhere.
    assert.ok(read.fireRate < 0.025, `fireRate=${read.fireRate}`);
    assert.ok(read.params.initBar >= APEX_BREAKEVEN, `bar=${read.params.initBar}`);
  });

  it("does not hallucinate persistence (edge in train, fair in test)", () => {
    // First 60% carries echo; the held-out 40% is fair. The honest split
    // must report what the TEST half measured: nothing.
    const digits = [...echoStream(1700, 0.3, 67), ...fairStream(1300, 68)];
    const read = scoreMarket(digits, "steady");
    assert.equal(read.verdict, "thin", `shots=${read.shots} edge=${read.edgePerDollar}`);
  });
});

describe("apex pipeline on planted-edge streams", () => {
  it("measures positive expectancy on repeat rhythm", () => {
    const digits = echoStream(3000, 0.3, 47);
    const read = scoreMarket(digits, "steady");
    assert.ok(read.hitRate > 0.12, `hitRate=${read.hitRate}`);
    assert.ok(read.edgePerDollar > 0, `edge=${read.edgePerDollar}`);
    assert.notEqual(read.verdict, "thin");
  });

  it("releases trades at a healthy rate when edge exists", () => {
    const digits = echoStream(3000, 0.3, 53);
    const read = scoreMarket(digits, "brisk");
    assert.ok(read.shots >= 15, `shots=${read.shots}`);
    assert.ok(read.fireRate > 0.02 && read.fireRate < 0.14, `fireRate=${read.fireRate}`);
  });

  it("the full fit keeps every lens alive and calibrates", () => {
    const digits = echoStream(3000, 0.3, 59);
    const fit = fitApexParams(digits, "steady");
    const w = fit.params.weights;
    assert.ok(Math.abs(w[0] + w[1] + w[2] - 1) < 1e-9);
    assert.ok(w.every(v => v > 0.03), `dead lens: ${w}`);
    assert.ok(fit.params.tau >= 0.6 && fit.params.tau <= 2.6, `tau=${fit.params.tau}`);
    assert.ok(fit.params.initBar >= APEX_BREAKEVEN, `bar=${fit.params.initBar}`);
  });
});

describe("digit lock", () => {
  it("scores only the locked digit end to end", () => {
    const digits = echoStream(2000, 0.25, 61);
    const read = scoreMarket(digits, "steady", { lockedDigit: 7 });
    assert.equal(read.digit, 7);
    assert.equal(read.params.lockedDigit, 7);
    const { metrics } = replayPolicy(digits.slice(1500), read.params, { warmup: 200 });
    assert.ok(metrics.shots >= 0);
  });
});
