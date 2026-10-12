/**
 * WP5 — Markov-chain DP on the debt grid.
 *
 * Acceptance:
 *  - DP vs Monte-Carlo (1e6 episodes, same stake function, i.i.d. outcomes):
 *    P(clear), P(rebase), E[trades] agree within 1 %.
 *  - Cached preview answers in < 5 ms (cycle scan payload budget).
 *  - The λ optimizer stays on the validated grid, honours P(rebase) ≤ tol and
 *    never invents an out-of-grid lambda.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recoveryDpPreview,
  chooseOptimalLambda,
  clearRecoveryDpCache,
  LAMBDA_GRID,
} from "../lib/autonomous-hedge/markov-dp";
import { computeAdaptiveStake } from "../lib/autonomous-hedge/adaptive-stake";
import { mulberry32 } from "../lib/autonomous-hedge/research/rng";

const INPUT = {
  debt: 1,
  baseStake: 1,
  payout: 1.95,
  p0: 0.5,
  lambda: 0.5,
  budgetBase: 25,
  headroomCap: 10,
};

/** Exact Monte-Carlo replica of the DP's debt random walk (no cooldowns). */
function monteCarlo(seed: number, episodes: number, input: typeof INPUT) {
  const rng = mulberry32(seed);
  let cleared = 0;
  let rebased = 0;
  let tradesSum = 0;
  let runGe10 = 0;
  for (let e = 0; e < episodes; e++) {
    let debt = input.debt;
    let run = 0;
    let sawRun10 = false;
    let trades = 0;
    let outcome: "cleared" | "rebased" | "open" = "open";
    while (trades < 100_000) {
      const plan = computeAdaptiveStake({ ...input, debt });
      if (plan.rebaseBudget || plan.rebaseHeadroom) { outcome = "rebased"; break; }
      const s = plan.stake;
      trades += 1;
      if (rng.next() < input.p0) {
        debt = Math.max(0, debt - s * (input.payout - 1));
        run = 0;
        if (debt <= 0) { outcome = "cleared"; break; }
      } else {
        debt += s;
        run += 1;
        if (run >= 10) sawRun10 = true;
      }
    }
    if (outcome === "cleared") cleared++;
    else if (outcome === "rebased") rebased++;
    tradesSum += trades;
    if (sawRun10) runGe10++;
  }
  return {
    pClear: cleared / episodes,
    pRebase: rebased / episodes,
    eTrades: tradesSum / episodes,
    pRunGe10: runGe10 / episodes,
  };
}

test("WP5: DP matches 1e6-episode Monte-Carlo within 1% (Even/Odd geometry)", () => {
  clearRecoveryDpCache();
  const dp = recoveryDpPreview(INPUT);
  const mc = monteCarlo(1, 1_000_000, INPUT);
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));
  assert.ok(rel(dp.pClear, mc.pClear) <= 0.01, `P(clear): DP ${dp.pClear} vs MC ${mc.pClear}`);
  assert.ok(rel(dp.pRebase, mc.pRebase) <= 0.01, `P(rebase): DP ${dp.pRebase} vs MC ${mc.pRebase}`);
  assert.ok(rel(dp.expectedTrades, mc.eTrades) <= 0.01, `E[trades]: DP ${dp.expectedTrades} vs MC ${mc.eTrades}`);
  assert.ok(rel(dp.pRunGe10, mc.pRunGe10) <= 0.10, `P(run≥10): DP ${dp.pRunGe10} vs MC ${mc.pRunGe10}`);
});

test("WP5: DP sanity — budget bounds the tail, clearance dominates at λ=0.5", () => {
  const dp = recoveryDpPreview(INPUT);
  assert.ok(dp.pClear > 0.9 && dp.pClear < 1);
  assert.ok(dp.pRebase > 0 && dp.pRebase < 0.1);
  assert.ok(Math.abs(dp.pClear + dp.pRebase - 1) < 1e-9);
  // Re-bases realise ≈ the budget, never past budget + one stake.
  assert.ok(dp.rebaseDebtMean >= INPUT.budgetBase * INPUT.baseStake);
  assert.ok(dp.rebaseDebtMean <= INPUT.budgetBase * INPUT.baseStake * 1.5);
  // Clearance wins the debt back; rebase loses ~budget ⇒ E[cash] strongly negative tail.
  assert.ok(dp.cvar99 < -INPUT.budgetBase * INPUT.baseStake * 0.9);
});

test("WP5: lambda monotonicity — larger λ clears faster (fewer trades)", () => {
  const low = recoveryDpPreview({ ...INPUT, lambda: 0.25 });
  const high = recoveryDpPreview({ ...INPUT, lambda: 1 });
  // λ=1 stakes the exact clearance: every win ends the episode.
  assert.ok(high.expectedTrades < low.expectedTrades);
  // Shorter episodes (high λ) give a long loss run fewer chances to form.
  assert.ok(high.pRunGe10 <= low.pRunGe10 + 1e-12);
});

test("WP5: cached preview answers in < 5 ms", () => {
  clearRecoveryDpCache();
  recoveryDpPreview(INPUT); // cold solve populates the cache
  const samples: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    recoveryDpPreview(INPUT);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  assert.ok(median < 5, `median cached preview ${median.toFixed(3)} ms exceeds the 5 ms scan budget`);
});

test("WP5: optimizer stays on the grid and respects the rebase tolerance", () => {
  clearRecoveryDpCache();
  const loose = chooseOptimalLambda({ ...INPUT, capital: 200 });
  assert.ok((LAMBDA_GRID as readonly number[]).includes(loose.lambda));
  assert.equal(loose.feasible, true);
  for (const c of loose.candidates) {
    assert.ok((LAMBDA_GRID as readonly number[]).includes(c.lambda));
  }
  // A tol of 0 makes every candidate infeasible: the optimizer must pick the
  // lowest-P(rebase) candidate instead of inventing a lambda.
  const tight = chooseOptimalLambda({ ...INPUT, capital: 200, rebaseTol: 0 });
  assert.ok((LAMBDA_GRID as readonly number[]).includes(tight.lambda));
  assert.equal(tight.feasible, false);
  const minRebase = Math.min(...tight.candidates.map((c) => c.pRebase));
  assert.ok(tight.preview.pRebase <= minRebase + 1e-12);
});

test("WP5: preview is deterministic and debt-monotone in the tail", () => {
  const a = recoveryDpPreview(INPUT);
  const b = recoveryDpPreview(INPUT);
  assert.deepEqual(a, b);
  const small = recoveryDpPreview({ ...INPUT, debt: 0.5 });
  const big = recoveryDpPreview({ ...INPUT, debt: 5 });
  assert.ok(big.pRebase > small.pRebase);
  assert.ok(big.expectedTrades > small.expectedTrades);
});
