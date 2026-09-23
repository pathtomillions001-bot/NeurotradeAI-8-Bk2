/**
 * Band Regime — unit tests for the new statistical toolkit shared by the
 * Over/Under family (Barrier Bastion + Over/Under Navigator):
 *
 *   - EW drift rate (recency-weighted, fair-rate prior)
 *   - 2-state regime HMM (Baum–Welch fit + forward filter)
 *   - contextual pair risk (order-2 band chain)
 *   - the calibrated STATIC recovery bar (payout-aware, clamped to
 *     [fair, fair+0.02], never of the loss run)
 *   - pool-weight compatibility (4 legacy lenses → 6)
 *   - the Market Scout (composite scoring, hysteresis, flee clause)
 *
 * All streams are seeded (mulberry32) — the suite is deterministic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bandIndicators,
  BandRegimeHMM,
  calibratedRecoveryBar,
  expandPoolWeights,
  ewBandRate,
  fitRegimeHMM,
  MarketScout,
} from "./band-regime.js";
import { BandMarkov } from "./bastion-analysis.js";

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

const WINS_80 = Array.from({ length: 10 }, (_, d) => d >= 2); // Over 1
const WINS_60 = Array.from({ length: 10 }, (_, d) => d >= 4); // Over 3

describe("EW drift rate", () => {
  it("returns the fair prior with no evidence", () => {
    assert.equal(ewBandRate([], WINS_80, 0.8), 0.8);
    const one: number[] = [2];
    // One win: (1 + 4*0.8) / (1 + 4) = 4.2/5 = 0.84
    assert.ok(Math.abs(ewBandRate(one, WINS_80, 0.8) - 0.84) < 1e-12);
  });

  it("tracks a regime shift toward the recent tail", () => {
    const rnd = mulberry32(7);
    const cold: number[] = [];
    for (let i = 0; i < 240; i++) {
      // ~30% wins for the 80% band (digits mostly in {0,1})
      cold.push(rnd() < 0.3 ? 3 : 0);
    }
    const hot: number[] = [];
    for (let i = 0; i < 240; i++) {
      // ~95% wins (digits mostly in {2..9})
      hot.push(rnd() < 0.95 ? 7 : 1);
    }
    const pCold = ewBandRate(cold, WINS_80, 0.8);
    const pShift = ewBandRate([...cold, ...hot], WINS_80, 0.8);
    assert.ok(pCold < 0.7, `cold p=${pCold}`);
    assert.ok(pShift > 0.85, `shifted p=${pShift}`);
    assert.ok(pShift - pCold > 0.15, "the drift lens must feel the shift");
  });
});

describe("2-state regime HMM", () => {
  it("recovers a planted two-regime structure and tracks it forward", () => {
    const rnd = mulberry32(11);
    const blockA: number[] = []; // hot regime: 75% wins
    for (let i = 0; i < 400; i++) blockA.push(rnd() < 0.75 ? 1 : 0);
    const blockB: number[] = []; // cold regime: 40% wins
    for (let i = 0; i < 400; i++) blockB.push(rnd() < 0.4 ? 1 : 0);
    const tape = [...blockA, ...blockB];

    const params = fitRegimeHMM(tape);
    assert.ok(params, "fit must succeed on 800 ticks");
    // State 1 is the hotter state by identifiability convention.
    assert.ok(params!.B[1]! > params!.B[0]!, `B=${params!.B}`);
    assert.ok(params!.B[1]! - params!.B[0]! > 0.12, `regime gap=${params!.B[1]! - params!.B[0]!}`);
    // The hot state must be clearly above a coin flip, the cold one below.
    assert.ok(params!.B[1]! > 0.6 && params!.B[0]! < 0.65, `B=${params!.B}`);

    const hmm = new BandRegimeHMM(WINS_60);
    // Unfitted → neutral.
    hmm.load(null);
    assert.equal(hmm.p(), 0.5);
    assert.equal(hmm.isFitted, false);

    // Fit on the full tape, warm the filter on block A only (causal), then
    // advance through the rest of A and into B — the posterior predictive
    // must track the regime: high in the hot block, dropped in the cold one.
    hmm.load(params, tape.slice(0, 400));
    assert.ok(hmm.isFitted);
    const midA: number[] = [];
    for (let i = 200; i < 400; i++) {
      hmm.update(tape[i]! === 1 ? 5 : 0); // digit 5 wins, digit 0 loses
      midA.push(hmm.p());
    }
    const midB: number[] = [];
    for (let i = 400; i < 600; i++) {
      hmm.update(tape[i]! === 1 ? 5 : 0);
      midB.push(hmm.p());
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(mean(midA) > 0.6, `hot-regime posterior predictive=${mean(midA)}`);
    assert.ok(mean(midB) < mean(midA) - 0.05, `cold must drop: ${mean(midA)} → ${mean(midB)}`);
  });

  it("bandIndicators extracts the tail correctly", () => {
    const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const ind = bandIndicators(digits, WINS_60, 5); // last 5: 5,6,7,8,9 all win
    assert.deepEqual(ind, [1, 1, 1, 1, 1]);
    const ind3 = bandIndicators(digits, WINS_60, 3); // 7,8,9
    assert.deepEqual(ind3, [1, 1, 1]);
  });
});

describe("contextual pair risk (order-2 band chain)", () => {
  it("sees loss clustering after two losses, not after two wins", () => {
    // 60% band; plant strong L→L clustering: after a loss, lose again 85%.
    const rnd = mulberry32(21);
    const digits: number[] = [];
    let prevLoss = false;
    for (let i = 0; i < 1500; i++) {
      let loss: boolean;
      if (i === 0) loss = rnd() < 0.5;
      else loss = prevLoss ? rnd() < 0.85 : rnd() < 0.25;
      digits.push(loss ? 1 : 8); // 1 ∈ lose set, 8 ∈ win set for Over 3
      prevLoss = loss;
    }
    const band = new BandMarkov(WINS_60);
    for (let i = 0; i < digits.length; i++) band.update(digits, i);
    // Force a (L,L) state and read the contextual risk there.
    digits.push(1, 1);
    band.update(digits, digits.length - 2);
    band.update(digits, digits.length - 1);
    const atLoss = band.pLossGiven(digits, digits.length - 1);
    // Force a (W,W) state and read there.
    digits.push(8, 8);
    band.update(digits, digits.length - 2);
    band.update(digits, digits.length - 1);
    const atWin = band.pLossGiven(digits, digits.length - 1);
    assert.ok(atLoss > 0.6, `P(L|L,L)=${atLoss}`);
    assert.ok(atWin < 0.3, `P(L|W,W)=${atWin}`);
    assert.ok(atLoss > atWin + 0.3, "contextual pair risk must separate states");
    // Order-1 qLL stays a global blend — the contextual read is sharper.
    assert.ok(band.qLL() < atLoss + 0.1);
  });
});

describe("calibrated static recovery bar", () => {
  it("is the payout-aware break-even clamped to [fair, fair+0.02]", () => {
    // 1/1.63 = 0.6135 ∈ [0.6, 0.62]
    assert.ok(Math.abs(calibratedRecoveryBar(0.6, 1.63) - 1 / 1.63) < 1e-12);
    // 1/1.5 = 0.6667 above the clamp → fair + 0.02
    assert.ok(Math.abs(calibratedRecoveryBar(0.6, 1.5) - 0.62) < 1e-12);
    // 1/2.0 = 0.5 below fair → the fair floor (never more aggressive)
    assert.equal(calibratedRecoveryBar(0.6, 2.0), 0.6);
    // Monotone in payout within the clamp (better payout → lower bar).
    const lo = calibratedRecoveryBar(0.4, 2.4); // 1/2.4 = 0.4167
    const hi = calibratedRecoveryBar(0.4, 2.6); // 1/2.6 = 0.3846
    assert.ok(lo > hi + 0.001, `payout 2.4 → ${lo}, payout 2.6 → ${hi}`);
    // A function of (fair, payout) ONLY — same inputs, same bar, forever.
    assert.equal(calibratedRecoveryBar(0.6, 1.63), calibratedRecoveryBar(0.6, 1.63));
  });
});

describe("pool-weight compatibility", () => {
  it("keeps 6-lens vectors and expands legacy 4-lens vectors", () => {
    const six = expandPoolWeights([0.2, 0.2, 0.2, 0.2, 0.1, 0.1], 6);
    assert.deepEqual(six, [0.2, 0.2, 0.2, 0.2, 0.1, 0.1]);
    const legacy = expandPoolWeights([0.25, 0.25, 0.25, 0.25], 6);
    assert.deepEqual(legacy, [0.25, 0.25, 0.25, 0.25, 0, 0]);
    assert.ok(Math.abs(legacy.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    const unnormalized = expandPoolWeights([1, 1, 1, 1], 6);
    assert.deepEqual(unnormalized, [0.25, 0.25, 0.25, 0.25, 0, 0]);
  });
});

// ── Market Scout ──────────────────────────────────────────────────────────────

const HOT80 = (() => {
  // Last 240 digits: ~90% in {2..9} → live edge ≈ 0.9·1.23 − 1 ≈ +0.107
  const rnd = mulberry32(31);
  return Array.from({ length: 240 }, () => (rnd() < 0.9 ? 7 : 0));
})();
const DEAD80 = (() => {
  const rnd = mulberry32(32);
  return Array.from({ length: 240 }, () => (rnd() < 0.3 ? 7 : 0)); // ~30% wins
})();
const NEUTRAL80 = (() => {
  // ~81.5% in {2..9} → edge ≈ 0
  const rnd = mulberry32(33);
  return Array.from({ length: 240 }, () => (rnd() < 0.815 ? 7 : 0));
})();

function makeScout(reader: Record<string, number[]>) {
  const scout = new MarketScout(
    [
      { symbol: "HOT", displayName: "Hot Index" },
      { symbol: "DEAD", displayName: "Dead Index" },
      { symbol: "NEUTRAL", displayName: "Neutral Index" },
    ],
    {
      normal: [{ wins: WINS_80, fair: 0.8, payout: 1.23 }],
      recovery: [{ wins: WINS_60, fair: 0.6, payout: 1.63 }],
    },
    { cooldownMs: 60_000, minDwellMs: 90_000, margin: 0.012 },
  );
  return { scout, read: (s: string) => reader[s]! };
}

describe("Market Scout", () => {
  it("scores live EW edge per market", () => {
    const { scout, read } = makeScout({ HOT: HOT80, DEAD: DEAD80, NEUTRAL: NEUTRAL80 });
    const scores = scout.scores("normal", read, Date.now());
    const by = Object.fromEntries(scores.map(s => [s.symbol, s]));
    assert.ok(by["HOT"]!.live > 0.05, `hot live=${by["HOT"]!.live}`);
    assert.ok(by["DEAD"]!.live < -0.3, `dead live=${by["DEAD"]!.live}`);
    assert.ok(Math.abs(by["NEUTRAL"]!.live) < 0.05, `neutral live=${by["NEUTRAL"]!.live}`);
    assert.equal(scores[0]!.symbol, "HOT");
    assert.equal(scores[2]!.symbol, "DEAD");
  });

  it("does not switch from a strong market, does switch from a dead one (flee)", () => {
    const { scout, read } = makeScout({ HOT: HOT80, DEAD: DEAD80, NEUTRAL: NEUTRAL80 });
    const t0 = Date.now();
    scout.enter("HOT", t0);
    // 5 minutes in, no switch yet: HOT is the best tape — stay.
    assert.equal(scout.bestChallenger("normal", read, "HOT", t0 + 5 * 60_000), null);
    // Now on the DEAD tape (entered earlier): the flee clause relaxes the
    // margin and the scout points at the HOT market.
    scout.enter("DEAD", t0 - 5 * 60_000);
    const ch = scout.bestChallenger("normal", read, "DEAD", t0 + 5 * 60_000);
    assert.ok(ch, "a dead tape must yield a challenger");
    assert.equal(ch!.symbol, "HOT");
    assert.equal(ch!.flee, true);
  });

  it("enforces the anti-flap hysteresis (cooldown + minimum dwell)", () => {
    const { scout, read } = makeScout({ HOT: HOT80, DEAD: DEAD80, NEUTRAL: NEUTRAL80 });
    const t0 = Date.now();
    scout.enter("DEAD", t0 - 5 * 60_000);
    scout.markSwitch(t0); // just switched 0s ago
    assert.equal(
      scout.bestChallenger("normal", read, "DEAD", t0 + 1_000),
      null,
      "cooldown must block an immediate re-switch",
    );
    // Fresh market, not yet dwelled on:
    scout.enter("HOT", t0 + 2_000);
    assert.equal(
      scout.bestChallenger("normal", read, "HOT", t0 + 3_000),
      null,
      "minimum dwell must block abandoning a market after 1s",
    );
    // After cooldown AND dwell, a genuinely better tape wins:
    scout.markSwitch(t0 - 2 * 60_000); // last switch was 2 min ago
    scout.enter("DEAD", t0 - 5 * 60_000); // re-seed DEAD's dwell in the past
    const ch = scout.bestChallenger("normal", read, "DEAD", t0 + 4 * 60_000);
    assert.ok(ch && ch.symbol === "HOT", "after hysteresis, the better tape wins");
  });

  it("Beta-shrinks the experienced-edge term and stays silent below 4 shots", () => {
    const { scout, read } = makeScout({ HOT: HOT80, DEAD: DEAD80, NEUTRAL: NEUTRAL80 });
    const t0 = Date.now();
    // 3 outcomes → proven term must be silent.
    scout.recordOutcome("HOT", "normal", true);
    scout.recordOutcome("HOT", "normal", true);
    scout.recordOutcome("HOT", "normal", false);
    const s3 = scout.scores("normal", read, t0).find(s => s.symbol === "HOT")!;
    assert.equal(s3.proven, 0);
    // 14 more wins → 16W/1L, n=17 → (16+2)/(17+4) = 0.857 → 0.857·1.23 − 1 ≈ +0.054
    for (let i = 0; i < 14; i++) scout.recordOutcome("HOT", "normal", true);
    const s17 = scout.scores("normal", read, t0).find(s => s.symbol === "HOT")!;
    assert.ok(s17.proven > 0.03, `proven=${s17.proven}`);
    // Recovery outcomes are tracked separately.
    scout.recordOutcome("HOT", "recovery", false);
    const sr = scout.scores("recovery", read, t0).find(s => s.symbol === "HOT")!;
    assert.equal(sr.proven, 0); // only 1 recovery outcome → silent
  });

  it("age-decays measured cards", () => {
    const { scout, read } = makeScout({ HOT: HOT80, DEAD: DEAD80, NEUTRAL: NEUTRAL80 });
    const t0 = Date.now();
    scout.setCard("DEAD", { edge: 0.1, recoveryHitRate: 0.7, recoveryShots: 10, at: t0 });
    scout.setCard("HOT", { edge: 0.1, recoveryHitRate: 0.7, recoveryShots: 10, at: t0 });
    const fresh = scout.scores("normal", read, t0).find(s => s.symbol === "DEAD")!;
    assert.ok(Math.abs(fresh.card - 0.1) < 1e-9, `fresh card=${fresh.card}`);
    // 15 minutes old → halved.
    scout.setCard("DEAD", { edge: 0.1, recoveryHitRate: 0.7, recoveryShots: 10, at: t0 - 15 * 60_000 });
    const aged = scout.scores("normal", read, t0).find(s => s.symbol === "DEAD")!;
    assert.ok(Math.abs(aged.card - 0.05) < 1e-9, `aged card=${aged.card}`);
  });
});
