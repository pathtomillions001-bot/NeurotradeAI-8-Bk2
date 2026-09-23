/**
 * SIX-LENS UPGRADE — A/B validation that the two new lenses (EW drift +
 * regime HMM) make the Over/Under family take BETTER trades WITHOUT
 * introducing gates that minimize trades:
 *
 *   1. FIRE-RATE PRESERVATION — on a fair tape, the six-lens policy fires
 *      normal shots at (essentially) the legacy valve budget and recovery
 *      shots at ~the legacy rate (the payout-aware bar moves the fire point
 *      by ≤2pp, not by a stack of vetoes).
 *   2. BETTER PROBABILITIES AFTER A REGIME SHIFT — when the market level
 *      steps and the bot re-fits (as the live engine does on every refit),
 *      the six-lens fused win probability tracks the NEW level materially
 *      closer than the legacy four-lens fusion, which is anchored to the
 *      stale pre-shift context tables. Better p → better side arbitration
 *      → better normal shots at the same fire budget.
 *
 * A = fitted six-lens weights; B = the same fit with the two regime lenses
 * zeroed (the legacy four-lens fusion — bit-for-bit the old behaviour).
 * All streams seeded — deterministic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BastionPolicy,
  buildHMMWindows,
  contractById,
  fitBastionParams,
  replayBastion,
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
 * Step-shift tape: the probability that a digit lands in {2..9} (Over 1
 * wins) is `r1` for the first `cut` ticks and `r2` after. Given the rate,
 * each digit is drawn i.i.d. from its set — a clean persistent-regime
 * shift, the regime HMM + EW drift's home turf.
 */
function stepTape(seed: number, r1: number, r2: number, cut: number): number[] {
  const rnd = mulberry32(seed);
  const HOT = [2, 3, 4, 5, 6, 7, 8, 9];
  const COLD = [0, 1];
  const out: number[] = [];
  for (let t = 0; t < 6000; t++) {
    const r = t < cut ? r1 : r2;
    const set = rnd() < r ? HOT : COLD;
    out.push(set[Math.floor(rnd() * set.length)]!);
  }
  return out;
}

function legacyParams(fit: BastionParams): BastionParams {
  return {
    weights: [fit.weights[0]!, fit.weights[1]!, fit.weights[2]!, fit.weights[3]!, 0, 0],
    tau: fit.tau,
    normalInitBar: fit.normalInitBar,
  };
}

/**
 * Mean |fused p − true rate| of the Over-1 side over the post-shift
 * evaluation window, for a policy that was re-fitted (HMM windows rebuilt
 * from a window that INCLUDES the new regime) 500 ticks after the shift —
 * exactly what the live engine does on its refit cadence.
 */
function trackError(
  params: BastionParams,
  digits: number[],
  refitAt: number,
  refitWindow: readonly number[],
  truePost: number,
): number {
  const pre = buildHMMWindows(digits.slice(0, refitAt - 500));
  let pol = new BastionPolicy(params, pre);
  for (let i = 0; i < refitAt; i++) pol.update(digits, i);
  // Re-fit: the live engine rebuilds the regime windows here.
  const post = buildHMMWindows(digits.slice(refitWindow[0], refitWindow[1]));
  pol = new BastionPolicy(params, post);
  for (let i = 0; i < digits.length; i++) pol.update(digits, i);
  const over1 = contractById("over1");
  let err = 0;
  let n = 0;
  for (let idx = 4500; idx < digits.length; idx++) {
    err += Math.abs(pol.readSide(digits, idx, over1).p - truePost);
    n++;
  }
  return err / n;
}

describe("six-lens upgrade: no gates, better trades", () => {
  it("keeps the fire rate at the legacy budget on a fair tape", () => {
    const digits = fairStream(6000, 41);
    const fit = fitBastionParams(digits);
    const hmm = buildHMMWindows(digits.slice(0, Math.floor(digits.length * 0.6)));
    const A = replayBastion(digits, fit.params, { warmup: 400 }, hmm).metrics;
    const B = replayBastion(digits, legacyParams(fit.params), { warmup: 400 }, hmm).metrics;
    assert.ok(B.normalShots >= 100, `legacy normalShots=${B.normalShots}`);
    // The valve is a budget, not a veto — six lenses must not starve it.
    assert.ok(
      A.normalShots >= 0.95 * B.normalShots,
      `normal starvation: A=${A.normalShots} vs B=${B.normalShots}`,
    );
    // The payout-aware bar moves the fire point ≤2pp — recovery flow holds.
    assert.ok(
      A.recoveryShots >= 0.85 * Math.max(1, B.recoveryShots),
      `recovery starvation: A=${A.recoveryShots} vs B=${B.recoveryShots}`,
    );
    // And neither regime should make the fair tape look profitable.
    assert.ok(A.paperEdgePerDollar < 0.03, `A edge=${A.paperEdgePerDollar}`);
  });

  it("tracks a shifted market level closer than the legacy fusion", () => {
    const over1 = contractById("over1");
    assert.deepEqual([...over1.wins], [false, false, true, true, true, true, true, true, true, true]);

    // Three shift directions/seeds; the six-lens p must land at least 0.01
    // closer to the true post-shift rate than the legacy four-lens p.
    const cases: Array<[string, number[], number]> = [
      ["up 0.40→0.75 s57", stepTape(57, 0.40, 0.75, 2500), 0.75],
      ["down 0.75→0.40 s57", stepTape(57, 0.75, 0.40, 2500), 0.40],
      ["down 0.75→0.40 s91", stepTape(91, 0.75, 0.40, 2500), 0.40],
    ];
    for (const [name, digits, truePost] of cases) {
      const fit = fitBastionParams(digits);
      const refitAt = 3000; // 500 ticks after the shift
      const eA = trackError(fit.params, digits, refitAt, [600, 3000], truePost);
      const eB = trackError(legacyParams(fit.params), digits, refitAt, [600, 3000], truePost);
      assert.ok(
        eA <= eB - 0.01,
        `${name}: six-lens |p−r|=${eA.toFixed(4)} must beat legacy ${eB.toFixed(4)}`,
      );
    }

    // And the fit must actually be paying for the new lenses on regime
    // tapes (skill weighting found them useful) — not silently ignoring
    // them or forcing them.
    const digits = stepTape(57, 0.40, 0.75, 2500);
    const fit = fitBastionParams(digits);
    const W = fit.params.weights;
    assert.ok(
      W[4]! + W[5]! >= 0.25,
      `new-lens pool mass=${(W[4]! + W[5]!).toFixed(3)} — the skill fit must find the regime structure`,
    );
  });
});
