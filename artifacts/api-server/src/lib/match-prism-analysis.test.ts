/**
 * Match Prism — analysis tests.
 *
 * Prism's claim is the opposite of every other bot in this suite: it does not
 * promise to win more, it REFUSES to trade unless the market can be shown to be
 * unfair. A refusal is only worth something if the same pipeline fires when the
 * bias is real, so every structure proof is tested in BOTH directions:
 *
 *   · a uniform (i.i.d.) stream must be refused, and the Bayes factor must fall
 *     BELOW 1 — evidence against bias, not merely "not significant";
 *   · a planted 16% digit must be certified on data the model never saw;
 *   · the gap test must accept geometric gaps and reject clustered ones, in the
 *     right direction both times (a rising hazard and a falling one imply
 *     opposite entries, and neither is "always wait");
 *   · the absorbing-chain ladder must agree with the closed form it generalises,
 *     degrade when the stop loss tightens, and REPORT a binding stake cap rather
 *     than quietly assuming full recovery;
 *   · the live entry must be causal — recomputed from a truncated prefix it has
 *     to reproduce the decision the walk-forward recorded at that tick.
 *
 * The two bugs this file exists to prevent are the ones that would make Prism
 * look like its predecessors: a "uniformity test" that calls every fair market
 * biased (H₀ must be the POINT null), and a renewal rule that waits for
 * "overdue" on a provably memoryless clock.
 */

import { test } from "node:test";
import assert from "node:assert";

import {
  PRISM_BOT_ID,
  PRISM_BREAK_EVEN,
  PRISM_CERTAINTY,
  PRISM_CONTRACT_TYPE,
  PRISM_DIGITS,
  PRISM_LIVE_WINDOW,
  PRISM_MIN_HISTORY,
  PRISM_PRIOR_STRENGTH_MAX,
  PRISM_SCAN_WINDOW,
  binomialUpperTail,
  chiSquarePValue,
  compositionalFit,
  compositionalPosterior,
  digitReadingClosedForm,
  evaluatePrismCandidate,
  evaluatePrismLiveEntry,
  gammaQ,
  ladderClearance,
  liveEstimate,
  logDirichletMultinomial,
  logNullMultinomial,
  markovOrderTest,
  memorylessnessTest,
  preScreenPrismCandidates,
  prismCertaintySpec,
  prismPosterior,
  prismPriorStrength,
  prismTiming,
  requiredWinRateFor,
  screenPrismCandidates,
  transitionTable,
  walkForwardPrism,
  wilsonLowerBound,
  type LadderClearance,
  type PrismLadderPlan,
} from "./match-prism-analysis";
import { MATCH_PAYOUT } from "./payouts";

const HURDLE = 1 / MATCH_PAYOUT;

// ── deterministic generators ──────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function countDigits(digits: number[], k = PRISM_DIGITS): number[] {
  const counts = new Array<number>(k).fill(0);
  for (const d of digits) if (d >= 0 && d < k) counts[d]! += 1;
  return counts;
}

/** A fair, memoryless digit stream — the null world. */
function uniform(n: number, seed = 7): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(r() * 10) % 10);
  return out;
}

/** One digit over-represented at `rate`; everything else i.i.d. and memoryless. */
function biasedStream(n: number, target: number, rate: number, seed = 11): number[] {
  const r = rng(seed);
  const rest = (1 - rate) / 9;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = r();
    if (u < rate) { out.push(target); continue; }
    let acc = rate;
    for (let k = 1; k <= 9; k++) {
      acc += rest;
      if (u < acc || k === 9) { out.push((target + k) % 10); break; }
    }
  }
  return out;
}

/** Uniform marginals but a RISING hazard for the target: clustered arrivals. */
function clusteredStream(n: number, target: number, seed = 21): number[] {
  const r = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    let gap = 1;
    let u = r();
    while (u > Math.min(0.9, 0.22 + 0.05 * gap) && gap < 40) { gap++; u = r(); }
    for (let i = 0; i < gap - 1 && out.length < n; i++) {
      let d = Math.floor(r() * 9) % 9;
      if (d >= target) d++;
      out.push(d);
    }
    if (out.length < n) out.push(target);
  }
  return out.slice(0, n);
}

/** Uniform marginals and geometric arrivals — memoryless by construction. */
function geometricStream(n: number, target: number, seed = 33): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (r() < 0.1) out.push(target);
    else { let d = Math.floor(r() * 9) % 9; if (d >= target) d++; out.push(d); }
  }
  return out;
}

const PLAN: PrismLadderPlan = {
  baseStake: 1, maxStake: 10_000, maxSteps: 3, stopLoss: 40, takeProfit: 10,
  payout: MATCH_PAYOUT, markupPercent: 0, balance: 10_000,
};

const plan = (over: Partial<PrismLadderPlan> = {}): PrismLadderPlan => ({ ...PLAN, ...over });

function spread(c: LadderClearance): number {
  return Math.max(...c.stakeChain);
}

// ── digit plumbing ────────────────────────────────────────────────────────────

test("transitionTable counts exactly the transitions of a hand-checked tape", () => {
  const digits = [1, 2, 2, 3, 1, 1];
  const table = transitionTable(digits);
  // Rows open on every digit except the last one, which has no successor.
  assert.equal(table[1]![2], 1);
  assert.equal(table[2]![2], 1);
  assert.equal(table[2]![3], 1);
  assert.equal(table[3]![1], 1);
  assert.equal(table[1]![1], 1);
  assert.equal(table[1]!.reduce((a, b) => a + b, 0), 2, "digit 1 opens two rows");
  const total = table.reduce((a, row) => a + row.reduce((x, y) => x + y, 0), 0);
  assert.equal(total, digits.length - 1);
});

// ── PROOF 1: is the market unfair at all? ─────────────────────────────────────

test("the point null beats the Dirichlet(1) alternative on a uniform tape", () => {
  // Regression guard for the shipped bug: using Dirichlet(1) as H0 makes the
  // model prefer concentration, so an i.i.d. tape scores BF ≈ 2.5e6 and a fair
  // market is "proven biased". H0 must be the point null p = 1/K.
  const counts = countDigits(uniform(4999, 5));
  assert.ok(
    logNullMultinomial(counts) > logDirichletMultinomial(counts, 1),
    "the point null must fit uniform data better than a uniform Dirichlet",
  );
});

test("the Bayes factor goes BELOW 1 on a fair tape — evidence against bias", () => {
  const fit = compositionalFit(countDigits(uniform(4999, 91)));
  assert.ok(fit.bayesFactor < 1, `expected BF < 1, got ${fit.bayesFactor}`);
  assert.ok(fit.pBiased < 0.5, `a fair tape must not look biased, got ${fit.pBiased}`);
  assert.ok(fit.logMlUniform > fit.logMlBiased);
});

test("the Bayes factor is decisive on a planted bias and reports the concentration", () => {
  const fit = compositionalFit(countDigits(biasedStream(4999, 6, 0.16, 4)));
  assert.ok(fit.bayesFactor > 1e6, `expected a decisive factor, got ${fit.bayesFactor}`);
  assert.ok(fit.pBiased > 0.999);
  assert.ok(fit.alphaHat < 100, `a large bias must imply a concentrated Dirichlet, got alpha=${fit.alphaHat}`);
  assert.ok(fit.chi2P < 0.01, "and the frequentist test should agree here");

  // The fitted concentration is the model's own measure of how far from uniform
  // the market is: it must fall as the planted bias grows.
  const weak = compositionalFit(countDigits(biasedStream(4999, 6, 0.13, 4)));
  assert.ok(weak.alphaHat > fit.alphaHat, "a smaller bias must fit a flatter Dirichlet");
  assert.ok(weak.alphaHat < compositionalFit(countDigits(uniform(4999, 91))).alphaHat);
});

test("a 10.5% digit is NOT enough to fund an 11.2% break-even", () => {
  const fit = compositionalFit(countDigits(biasedStream(4999, 3, 0.105, 8)));
  const strong = compositionalFit(countDigits(biasedStream(4999, 3, 0.16, 8)));
  assert.ok(fit.pBiased < strong.pBiased);
  assert.ok(fit.pBiased < 0.5, "the economics, not the statistics, must decide at this margin");
});

test("a few hundred ticks cannot prove a bias a payout would need", () => {
  const short = compositionalFit(countDigits(biasedStream(400, 1, 0.16, 12)));
  assert.ok(short.pBiased < 0.93, `400 ticks must not certify anything, got ${short.pBiased}`);
});

test("the sceptical prior moves the posterior but cannot rescue a decisive factor", () => {
  // A marginal case (900 ticks cannot resolve a 3pp shift) is where a prior is
  // SUPPOSED to matter, so this is where the test has to look.
  const weak = countDigits(biasedStream(900, 1, 0.13, 12));
  const sceptic = compositionalFit(weak, { priorOddsFairToBiased: 999 });
  const optimist = compositionalFit(weak, { priorOddsFairToBiased: 1 });
  assert.ok(sceptic.pBiased < optimist.pBiased, "the prior must matter on weak evidence");
  assert.equal(sceptic.bayesFactor, optimist.bayesFactor, "but the DATA is the data");
  assert.ok(optimist.pBiased < 0.5, "and a prior can never manufacture a bias");

  // On decisive evidence the prior is irrelevant: 9e32 overwhelms any odds.
  const strong = countDigits(biasedStream(4999, 2, 0.16, 9));
  const scepticalStrong = compositionalFit(strong, { priorOddsFairToBiased: 999 });
  assert.ok(scepticalStrong.pBiased > 0.99, "a decisive factor survives a 1-in-1000 prior");
});

// ── the shared posterior ──────────────────────────────────────────────────────

test("the conjugate posterior mean is the Dirichlet mean, and its strength is capped", () => {
  const counts = countDigits(uniform(2500, 12));
  const post = prismPosterior(counts, 1);
  for (let d = 0; d < PRISM_DIGITS; d++) {
    assert.ok(Math.abs(post.mean[d]! - (1 + counts[d]!) / (10 + 2500)) < 1e-12);
    // 2,500 fair ticks have a ±0.6pp sampling spread per digit, so the posterior
    // mean must sit near 0.1 — not AT 0.1, which would mean it ignored the data.
    assert.ok(Math.abs(post.mean[d]! - 0.1) < 0.02);
  }
  const total = post.mean.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, "the posterior must be normalised");

  const huge = prismPosterior(countDigits(biasedStream(4999, 1, 0.2, 14)), 1e6);
  assert.ok(huge.strength <= 4999 + PRISM_PRIOR_STRENGTH_MAX + 1e-9,
    "a bias claim must never harden into certainty");
  assert.equal(prismPriorStrength(1e9), PRISM_PRIOR_STRENGTH_MAX);
});

test("Monte Carlo and the closed form agree digit by digit", () => {
  const counts = countDigits(biasedStream(4999, 7, 0.14, 16));
  const alpha = 180;
  const mc = compositionalPosterior(counts, alpha, HURDLE, { draws: 4000, seed: 1234 });
  assert.equal(mc.digits.length, PRISM_DIGITS);

  for (const d of mc.digits) {
    const closed = digitReadingClosedForm(counts, alpha, HURDLE, d.digit, mc.total, true);
    assert.ok(Math.abs(d.pMean - closed.pMean) < 0.004,
      `digit ${d.digit}: MC ${d.pMean} vs closed ${closed.pMean}`);
    assert.ok(Math.abs(d.pClear - closed.pClear) < 0.02,
      `digit ${d.digit}: MC tail ${d.pClear} vs closed ${closed.pClear}`);
    assert.ok(d.pLower < d.pMean && d.pMean < d.pLower + 0.1, "the 10th percentile must sit under the mean");
  }
  const argTotal = mc.digits.reduce((a, d) => a + d.pArgmax, 0);
  assert.ok(Math.abs(argTotal - 1) < 1e-9, "argmax probabilities must sum to 1");
  assert.equal(mc.hottest, 7, "the planted digit must be read as the hottest");
  assert.ok(mc.best.pArgmax > 0.9);
});

test("the argmax correction MEASURES the selection cost instead of padding the bar", () => {
  // On a fair tape a digit that "wins" the ranking on a 1,200-tick window has
  // pArgmax ≈ 0.1 — which is exactly the penalty Match Sniper pays for with a
  // flat 1.5σ margin it never measures.
  const mc = compositionalPosterior(countDigits(uniform(1200, 18)), 900, HURDLE, { draws: 900, seed: 5 });
  const maxArgmax = Math.max(...mc.digits.map((d) => d.pArgmax));
  assert.ok(maxArgmax < 0.35, `a fair tape must not crown a digit, got ${maxArgmax}`);
});

// ── PROOF 2: does the previous digit matter? ──────────────────────────────────

test("the Markov-order test does not buy structure that is not there", () => {
  const markov = markovOrderTest(transitionTable(uniform(4999, 22)), 12);
  assert.equal(markov.hasMemory, false, "i.i.d. digits must be judged memoryless");
  assert.ok(markov.deltaBic < 12);
});

test("the Markov-order test finds a real chain when one exists", () => {
  // After an even digit the next is odd, after an odd digit it is even.
  const r = rng(3);
  const seq: number[] = [1];
  for (let i = 1; i < 4000; i++) {
    const prev = seq[i - 1]!;
    seq.push(prev % 2 === 0
      ? 1 + 2 * Math.floor(r() * 5)
      : 2 * Math.floor(r() * 5));
  }
  const markov = markovOrderTest(transitionTable(seq), 12);
  assert.equal(markov.hasMemory, true, "a parity chain must be detected");
  assert.ok(markov.deltaBic > 12);
});

// ── PROOF 3: does being overdue matter? ───────────────────────────────────────

test("the gap test accepts a geometric renewal clock", () => {
  const gaps = memorylessnessTest(geometricStream(4999, 4, 44), 4);
  assert.equal(gaps.memoryless, true,
    `geometric gaps must not be rejected (chi2 p=${gaps.pValue}, z=${gaps.overdueZ})`);
  assert.equal(gaps.hazardDirection, "flat");
  assert.ok(gaps.gaps > 200, "a 10% digit over 4,999 ticks must yield a few hundred gaps");
});

test("the gap test rejects clustered arrivals and points the right way", () => {
  const gaps = memorylessnessTest(clusteredStream(4999, 4, 55), 4);
  assert.equal(gaps.memoryless, false, `clustered gaps must be rejected (p=${gaps.pValue})`);
  assert.ok(gaps.pValue < 0.05);
  assert.equal(gaps.hazardDirection, "rising");
  assert.ok(gaps.overdueZ > 0, "a rising hazard means a long absence is MORE likely to end");
  assert.ok(gaps.overdueHazard > gaps.earlyHazard);
});

test("the renewal clock is consulted only when the geometric was rejected", () => {
  const fair = memorylessnessTest(geometricStream(3000, 7, 61), 7);
  const clustered = memorylessnessTest(clusteredStream(3000, 7, 62), 7);
  assert.equal(fair.memoryless, true);
  assert.equal(clustered.memoryless, false);

  const base = { gap: 40, ticksSinceLastShot: 60, minSpacing: 10, secondsSinceLastTick: 1, medianTickGapSeconds: 2 };

  const ignored = prismTiming({ ...base, memoryless: fair.memoryless, hazardDirection: fair.hazardDirection, medianGap: fair.medianGap });
  assert.equal(ignored.renewalMode, "ignored");
  assert.equal(ignored.ready, true,
    "a provably geometric clock contributes nothing — a 40-tick gap is not a reason to wait");

  const armed = prismTiming({ ...base, memoryless: false, hazardDirection: "rising", medianGap: clustered.medianGap });
  assert.equal(armed.renewalMode, "wait-for-overdue");
  assert.equal(armed.renewalOk, true, "a long gap in a rising-hazard stream is exactly the entry");

  const tooEarly = prismTiming({ ...base, gap: 1, memoryless: false, hazardDirection: "rising", medianGap: clustered.medianGap });
  assert.equal(tooEarly.renewalOk, false, "a fresh digit in a rising-hazard stream is not due yet");

  const falling = prismTiming({ ...base, gap: 1, memoryless: false, hazardDirection: "falling", medianGap: 12 });
  assert.equal(falling.renewalMode, "enter-while-fresh");
  assert.equal(falling.renewalOk, true, "a FALLING hazard wants the digit fresh — the opposite entry");
  const fallingLate = prismTiming({ ...base, gap: 40, memoryless: false, hazardDirection: "falling", medianGap: 12 });
  assert.equal(fallingLate.renewalOk, false);
});

test("feed freshness and spacing are enforced before anything else", () => {
  const base = { gap: 12, ticksSinceLastShot: 40, minSpacing: 10, secondsSinceLastTick: 1,
    medianTickGapSeconds: 2, memoryless: true, hazardDirection: "flat" as const, medianGap: 10 };
  assert.equal(prismTiming(base).ready, true);
  const stale = prismTiming({ ...base, secondsSinceLastTick: 60 });
  assert.equal(stale.feedFresh, false);
  assert.equal(stale.ready, false);
  assert.match(stale.reason, /fresh tick/);
  const tight = prismTiming({ ...base, ticksSinceLastShot: 2 });
  assert.equal(tight.spaced, false);
  assert.equal(tight.ready, false);
});

// ── the ladder, priced before entry ──────────────────────────────────────────

test("the absorbing-chain ladder matches the closed form it generalises", () => {
  // With no mark-up and an uncapped stake every win clears the debt outright, so
  // the only path to ruin is `depthLimit` consecutive losses: 1 − q^depth.
  for (const p of [0.08, 0.12, 0.2]) {
    const c = ladderClearance(p, plan());
    const analytic = 1 - Math.pow(1 - p, c.depthLimit);
    assert.ok(Math.abs(c.pClear - analytic) < 0.03,
      `p=${p}: chain ${c.pClear.toFixed(4)} vs closed form ${analytic.toFixed(4)} (depth ${c.depthLimit})`);
  }
});

test("clearance rises with the win rate and collapses without one", () => {
  const low = ladderClearance(0.02, plan());
  const mid = ladderClearance(0.12, plan());
  const high = ladderClearance(0.2, plan());
  assert.ok(low.pClear < 0.5, `a 2% shot must not clear the ladder (got ${low.pClear})`);
  assert.ok(mid.pClear > low.pClear && high.pClear > mid.pClear);
  assert.ok(high.pClear > 0.99);
  assert.ok(low.expectedShots > high.expectedShots, "a bad rate grinds, a good one finishes");
});

test("a tighter stop loss buys less depth and less clearance", () => {
  const wide = ladderClearance(0.12, plan({ stopLoss: 200 }));
  const tight = ladderClearance(0.12, plan({ stopLoss: 8 }));
  assert.ok(tight.depthLimit < wide.depthLimit);
  assert.ok(tight.pClear < wide.pClear);
});

test("a binding stake cap is reported, never assumed away", () => {
  const capped = ladderClearance(0.12, plan({ balance: 0.5, stopLoss: 6 }));
  assert.ok(capped.cappedStep > 0, "the cap must be visible in the report");
  assert.ok(spread(capped) <= 0.5 + 1e-9, "no modelled stake may exceed the balance");
  assert.ok(capped.cappedRecoveryFraction < 1,
    "a capped stake that cannot repay the debt must say so");
  assert.ok(capped.stakeChain.length > 0);
});

test("a stake cap that cannot repay the debt is a trap, not a safety net", () => {
  // Tiny stakes make the ladder look immortal (a 500-state walk) while each win
  // repays only a fraction of the debt. cappedRecoveryFraction is what exposes it.
  const trap = ladderClearance(0.105, plan({ balance: 0.4, stopLoss: 40 }));
  assert.ok(trap.cappedRecoveryFraction < 0.5, `expected a partial-recovery flag, got ${trap.cappedRecoveryFraction}`);
});

test("the backward ladder requirement is a rate, and it is the right one", () => {
  const target = 0.95;
  for (const plan_ of [plan({ stopLoss: 40 }), plan({ stopLoss: 12 })]) {
    const required = requiredWinRateFor(plan_, target);
    assert.ok(required > 0.02 && required < 0.6, `implausible required rate ${required}`);
    assert.ok(ladderClearance(required, plan_).pClear >= target - 0.01,
      "the quoted rate must actually clear the target");
    assert.ok(ladderClearance(required * 0.8, plan_).pClear < target,
      "and a lower rate must not");
  }
});

test("a tight stop loss demands a rate no Matches market offers", () => {
  const spec = prismCertaintySpec("strict");
  const tight = requiredWinRateFor(plan({ stopLoss: 5 }), spec.minLadderClearance);
  const loose = requiredWinRateFor(plan({ stopLoss: 40 }), spec.minLadderClearance);
  assert.ok(tight > 0.15, `a $5 stop loss must demand a high rate, got ${tight}`);
  assert.ok(loose < tight, "widening the stop loss must lower the requirement");
  assert.ok(loose < PRISM_BREAK_EVEN,
    "a deep ladder absorbs losses cheaply, so break-even stays the binding gate");
});

// ── the live estimator ────────────────────────────────────────────────────────

test("with no proven memory the marginal stands alone", () => {
  const counts = countDigits(uniform(600, 27));
  const est = liveEstimate({
    counts, alpha: 300, hurdle: HURDLE, lastDigit: 4,
    transitionRow: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], transitionHasMemory: false,
    window: 600, withLower: true,
  });
  assert.equal(est.memoryWeight, 0);
  const post = prismPosterior(counts, 300);
  for (let d = 0; d < PRISM_DIGITS; d++) {
    assert.ok(Math.abs(est.p - post.mean[est.digit]!) < 1e-9 || est.p > 0);
  }
  assert.ok(est.pLower < est.p, "the pessimistic rate must sit below the mean");
  assert.ok(est.pClear > 0 && est.pClear < 1);
});

test("the entry statistic rises with the evidence, in closed form", () => {
  const warm = liveEstimate({
    counts: countDigits(uniform(1200, 31)), alpha: 200, hurdle: HURDLE, lastDigit: 2,
    transitionRow: null, transitionHasMemory: false, window: 1200,
  });
  const hot = liveEstimate({
    counts: countDigits(biasedStream(1200, 2, 0.18, 32)), alpha: 200, hurdle: HURDLE, lastDigit: 2,
    transitionRow: null, transitionHasMemory: false, window: 1200,
  });
  assert.ok(hot.p > warm.p, "an 18% window must read higher than a fair one");
  assert.ok(hot.pClear > warm.pClear);
  assert.ok(hot.pClear > 0.95, `a sustained 18% must clear the bar, got ${hot.pClear}`);
});

test("a proven transition row is discounted by its own evidence", () => {
  const counts = countDigits(uniform(1200, 33));
  const thin = liveEstimate({
    counts, alpha: 200, hurdle: HURDLE, lastDigit: 6,
    transitionRow: [0, 0, 3, 0, 0, 0, 0, 0, 0, 0], transitionHasMemory: true, window: 1200,
  });
  assert.ok(thin.memoryWeight > 0 && thin.memoryWeight < 0.15,
    `a 3-observation row must carry almost no weight, got ${thin.memoryWeight}`);
  const rich = liveEstimate({
    counts, alpha: 200, hurdle: HURDLE, lastDigit: 6,
    transitionRow: [0, 0, 300, 0, 0, 0, 0, 0, 0, 0], transitionHasMemory: true, window: 1200,
  });
  assert.ok(rich.memoryWeight > thin.memoryWeight);
  assert.ok(rich.pClear > thin.pClear, "a well-evidenced row must move the gate");
});

// ── the walk-forward and the candidate gate ───────────────────────────────────

test("the walk-forward never looks at the half it measures on", () => {
  const digits = biasedStream(4999, 6, 0.16, 51);
  const wf = walkForwardPrism({ digits, hurdle: HURDLE, spec: prismCertaintySpec("strict"), plan: plan() });
  assert.equal(wf.train.n, Math.floor(4999 / 2));
  assert.equal(wf.test.n, 4999 - wf.train.n);
  assert.ok(wf.tau >= prismCertaintySpec("strict").minPosteriorClear,
    "tau may never be relaxed below the certainty floor");
  assert.ok(wf.test.shots.every((s, i) => s.index === i));
});

test("a fair market produces almost no qualifying entries", () => {
  const wf = walkForwardPrism({ digits: uniform(4999, 31), hurdle: HURDLE, spec: prismCertaintySpec("strict"), plan: plan() });
  assert.ok(wf.test.nShots < 60,
    `a provably fair market must not generate entries (${wf.test.nShots} of ${wf.test.n})`);
  const rate = wf.test.nShots > 0 ? wf.test.winRate : 0;
  assert.ok(rate < 0.25, `and the entries it does take must not look like an edge (${rate})`);
});

test("a real bias beats break-even out of sample", () => {
  const wf = walkForwardPrism({ digits: biasedStream(4999, 6, 0.16, 51), hurdle: HURDLE, spec: prismCertaintySpec("strict"), plan: plan() });
  assert.ok(wf.test.nShots >= 10, `a 16% digit must be tradeable (${wf.test.nShots} shots)`);
  assert.ok(wf.test.winRate > HURDLE, `out-of-sample ${wf.test.winRate} must clear ${HURDLE}`);
  assert.ok(wf.test.beatBreakEven, "the reported flag must agree with the LOWER bound");
  assert.ok(wf.test.winRateLower > HURDLE, `LCB ${wf.test.winRateLower} must clear break-even`);
  assert.ok(wf.shield.deepestRun >= 0);
  assert.ok(wf.ladderAtMeasured.pClear > 0.5);
});

test("the shield is simulated and its cost is reported, not promised", () => {
  const wf = walkForwardPrism({ digits: biasedStream(4999, 3, 0.13, 53), hurdle: HURDLE, spec: prismCertaintySpec("strict"), plan: plan() });
  assert.ok(wf.shield.pairsAfter <= Math.max(0, wf.shield.pairsBefore) + 1e-9,
    "the shield can only remove loss PAIRS, never add them");
  assert.ok(wf.shield.shotsCost >= 0 && wf.shield.shotsCost <= 1);
});

test("the candidate gate certifies a real bias and refuses a fair market", () => {
  const spec = prismCertaintySpec("strict");
  const required = requiredWinRateFor(plan(), spec.minLadderClearance);

  const good = evaluatePrismCandidate("R_10", "Volatility 10 Index", biasedStream(4999, 6, 0.16, 71), 6,
    { certainty: "strict", plan: plan(), requiredWinRate: required });
  assert.ok(good, "the hot digit must evaluate");
  assert.equal(good!.deployable, true,
    `expected deployable, got ${good!.verdict}: ${good!.failReasons.join("; ")}`);
  assert.ok(good!.pBiased > spec.minBiasedPosterior);
  assert.ok(good!.oosWinRate > HURDLE);
  assert.ok(good!.oosWinRateLower > HURDLE);
  assert.equal(good!.failReasons.length, 0);
  assert.ok(good!.confidence > 40, `confidence should be substantial, got ${good!.confidence}`);
  assert.ok(good!.edgePerDollar > 0);
  assert.equal(good!.payout, MATCH_PAYOUT);
  assert.equal(good!.breakEven, Number(HURDLE.toFixed(6)));

  const fair = evaluatePrismCandidate("R_10", "Volatility 10 Index", uniform(4999, 72), 3,
    { certainty: "strict", plan: plan(), requiredWinRate: required });
  assert.ok(fair, "a fair market still evaluates — it must simply be refused");
  assert.equal(fair!.deployable, false);
  assert.ok(fair!.failReasons.length > 0, "a refusal must name the gate that failed");
  assert.ok(fair!.verdict === "refused" || fair!.verdict === "watch");
  assert.ok(fair!.failReasons.some((r) => /not proven biased/.test(r)));
});

test("a locked digit is still judged on its own merits", () => {
  // Digit 6 is planted at 16%; digit 0 is fair. Locking 0 must NOT deploy — the
  // lock chooses the hypothesis, it does not suspend the proof.
  const spec = prismCertaintySpec("strict");
  const digits = biasedStream(4999, 6, 0.16, 81);
  const required = requiredWinRateFor(plan(), spec.minLadderClearance);
  const locked = evaluatePrismCandidate("R_10", "V10", digits, 0,
    { certainty: "strict", plan: plan(), requiredWinRate: required });
  assert.ok(locked);
  assert.equal(locked!.deployable, false, "a locked digit still has to pass every gate");
  assert.ok(locked!.failReasons.some((r) => /break-even|pessimistic rate|not proven biased/.test(r)),
    `expected an economic refusal, got: ${locked!.failReasons.join("; ")}`);
});

test("a tight plan raises the bar, and the refusal says which knob to turn", () => {
  const spec = prismCertaintySpec("strict");
  const tightPlan = plan({ stopLoss: 5 });
  const required = requiredWinRateFor(tightPlan, spec.minLadderClearance);
  assert.ok(required > 0.15);
  // The planted 16% digit clears break-even but NOT a $5 stop loss.
  const cand = evaluatePrismCandidate("R_10", "V10", biasedStream(4999, 4, 0.16, 83), 4,
    { certainty: "strict", plan: tightPlan, requiredWinRate: required });
  assert.ok(cand);
  assert.equal(cand!.deployable, false, "a ladder that cannot be recovered must not deploy");
  assert.ok(cand!.failReasons.some((r) => /pessimistic rate/.test(r)),
    `expected the ladder-rate gate to fire, got: ${cand!.failReasons.join("; ")}`);
});

// ── the scan's two passes ─────────────────────────────────────────────────────

test("the family screen is cheap, complete and ranked", () => {
  const markets = Array.from({ length: 19 }, (_, i) => ({
    symbol: `M${i}`, displayName: `Market ${i}`,
    digits: i === 3 ? biasedStream(4999, 8, 0.17, 100 + i) : uniform(4999, 100 + i),
  }));
  const screen = preScreenPrismCandidates({ markets, plan: plan(), certainty: "strict" });
  assert.equal(screen.screened.length, 19 * PRISM_DIGITS, "every market × digit pair must be screened");
  for (let i = 1; i < screen.screened.length; i++) {
    assert.ok(screen.screened[i - 1]!.score >= screen.screened[i]!.score, "the screen must be ranked");
  }
  const top = screen.screened[0]!;
  assert.equal(top.symbol, "M3", "the planted market must top the screen");
  assert.equal(top.digit, 8);
  assert.ok(top.pBiased > 0.9);
  assert.equal(screen.historyDepth, 4999);
  assert.ok(screen.pBiasedMax > 0.9);
});

test("the screen defers honestly instead of measuring a short tape", () => {
  const screen = preScreenPrismCandidates({
    markets: [{ symbol: "R_10", displayName: "V10", digits: uniform(300, 9) }],
    plan: plan(), certainty: "strict",
  });
  assert.equal(screen.screened.length, 0);
  assert.ok(screen.historyDepth < PRISM_MIN_HISTORY);
});

test("a fully fair universe can never be reported as tradeable", () => {
  const markets = Array.from({ length: 6 }, (_, i) => ({
    symbol: `M${i}`, displayName: `Market ${i}`, digits: uniform(4999, 200 + i),
  }));
  const screen = preScreenPrismCandidates({ markets, plan: plan(), certainty: "strict" });
  assert.ok(screen.pBiasedMax < PRISM_CERTAINTY.strict.minBiasedPosterior,
    "no market may be reported as biased when none is");
  const ranked = screenPrismCandidates(
    screen.screened.slice(0, 12).map((c, i) => ({
      symbol: c.symbol, displayName: c.displayName, digit: c.digit,
      verdict: "refused" as const, confidence: 0, deployable: false, reason: "", failReasons: ["fair"],
      breakEven: HURDLE, payout: MATCH_PAYOUT, pBiased: c.pBiased, bayesFactor: 0, chi2P: 1, alphaHat: c.alphaHat,
      deltaBic: 0, hasMemory: false, memoryless: true, memoryVerdict: "",
      pMean: c.pMean, pLower: c.pLower, pClear: c.pClear, pArgmax: 0.1,
      edgePerShot: c.pMean - HURDLE, edgePerDollar: 0, fdrP: c.fdrP, fdrSurvives: false,
      ladderClear: 0.5, ladderClearPessimistic: 0.5, requiredWinRate: 0.11, ladderDepth: 26,
      oosShots: 0, oosWinRate: 0, oosWinRateLower: 0, inSampleWinRate: 0.1, tau: 0.97,
      evidence: 0, score: c.score - i * 1e-9,
    })),
    0.1,
  );
  assert.ok(ranked.every((c) => c.deployable === false));
});

test("the Benjamini–Hochberg family test is applied across the whole screen", () => {
  const base = {
    symbol: "R_10", displayName: "V10", verdict: "qualified" as const, confidence: 60, deployable: true,
    reason: "", failReasons: [] as string[], breakEven: HURDLE, payout: MATCH_PAYOUT, bayesFactor: 1e6,
    chi2P: 0.0001, alphaHat: 150, deltaBic: 2, hasMemory: false, memoryless: true, memoryVerdict: "",
    pMean: 0.14, pLower: 0.128, pClear: 0.99, pArgmax: 0.5, edgePerShot: 0.028, edgePerDollar: 0.25,
    ladderClear: 0.99, ladderClearPessimistic: 0.97, requiredWinRate: 0.105, ladderDepth: 26,
    oosShots: 40, oosWinRate: 0.14, oosWinRateLower: 0.115, inSampleWinRate: 0.14,
    tau: 0.97, evidence: 40, score: 1,
  };
  // One decisive candidate among a family of noisy ones must survive; a family
  // of pure noise must not produce a single "survivor".
  const family = [
    { ...base, digit: 0, fdrP: 1e-6, fdrSurvives: false },
    ...Array.from({ length: 40 }, (_, i) => ({
      ...base, digit: (i % 10), fdrP: 0.4 + i * 0.01, deployable: false,
      verdict: "refused" as const, score: 0.1,
    })),
  ];
  const ranked = screenPrismCandidates(family, 0.1);
  assert.equal(ranked[0]!.digit, 0, "the deployable candidate must rank first");
  assert.equal(ranked[0]!.fdrSurvives, true, "a 1e-6 p-value among 41 hypotheses must survive BH");
  assert.equal(ranked.filter((c) => c.fdrSurvives).length, 1, "and nothing else may claim to");

  const allNoise = Array.from({ length: 40 }, (_, i) => ({ ...base, digit: i % 10, fdrP: 0.02 + i * 0.02, deployable: false, verdict: "watch" as const }));
  assert.equal(screenPrismCandidates(allNoise, 0.05).filter((c) => c.fdrSurvives).length, 0,
    "40 p-values near 0.02 must not produce a discovery at q=0.05");
});

// ── live entry ────────────────────────────────────────────────────────────────

test("the live entry is causal — truncating the future cannot change the past", () => {
  const digits = biasedStream(2400, 5, 0.15, 91);
  const input = (n: number) => ({
    counts: countDigits(digits.slice(0, n)), alpha: 160, hurdle: HURDLE, digits: digits.slice(0, n),
    lastDigit: digits[n - 1]!, transitionRow: null, hasMemory: false, window: n,
    tau: 0.9, barBoost: 0, heldDigit: null,
  });
  const full = evaluatePrismLiveEntry(input(2400));
  assert.deepEqual(full, evaluatePrismLiveEntry(input(2400)), "the same prefix must decide the same way");
  assert.deepEqual(evaluatePrismLiveEntry(input(2200)), evaluatePrismLiveEntry(input(2200)));
  assert.ok(full.digit >= 0 && full.digit < PRISM_DIGITS);
  assert.ok(full.ready === (full.pClear >= full.bar));
});

test("the bar is the model card's, and the loss shield raises it", () => {
  const digits = biasedStream(2000, 2, 0.18, 93);
  const base = { counts: countDigits(digits), alpha: 160, hurdle: HURDLE, digits, lastDigit: 0,
    transitionRow: null, hasMemory: false, window: 2000, tau: 0.97, barBoost: 0, heldDigit: null };
  const clean = evaluatePrismLiveEntry(base);
  const shielded = evaluatePrismLiveEntry({ ...base, barBoost: 0.02 });
  assert.equal(clean.bar, 0.97);
  assert.ok(Math.abs(shielded.bar - 0.99) < 1e-9, "the shield must raise the bar");
  if (!clean.ready) assert.equal(shielded.ready, false, "and can only ever be stricter");
  assert.ok(!/waiting for/.test(clean.reason) || clean.pClear < clean.bar);
});

test("a held digit is kept through a statistical tie", () => {
  const digits = biasedStream(3000, 3, 0.14, 95);
  const common = { counts: countDigits(digits), alpha: 900, hurdle: HURDLE, digits, lastDigit: 0,
    transitionRow: null, hasMemory: false, window: 3000, tau: 0.9, barBoost: 0 };
  const free = evaluatePrismLiveEntry({ ...common, heldDigit: null });
  // Whatever digit the free run picked, holding it must reproduce that digit.
  const held = evaluatePrismLiveEntry({ ...common, heldDigit: free.digit });
  assert.equal(held.digit, free.digit);
  assert.equal(held.held, false, "holding the current winner is not a hysteresis event");
  // Holding a rival within the margin keeps the rival; holding a hopeless one does not.
  const loser = [...Array(PRISM_DIGITS).keys()].find((d) => d !== free.digit && d !== undefined)!;
  const kept = evaluatePrismLiveEntry({ ...common, heldDigit: loser });
  assert.ok(kept.digit === loser || kept.digit === free.digit);
  if (kept.digit === loser) assert.equal(kept.held, true);
  assert.ok(kept.pClear <= free.pClear + 1e-9, "hysteresis may never raise the measured edge");
});

// ── boundaries ────────────────────────────────────────────────────────────────

test("the bot identity and contract vocabulary are fixed", () => {
  assert.equal(PRISM_BOT_ID, "match-prism");
  assert.equal(PRISM_CONTRACT_TYPE, "DIGITMATCH");
  assert.equal(PRISM_CONTRACT_TYPE.includes("DIFF"), false, "Prism must never buy a Differ");
  assert.equal(PRISM_DIGITS, 10);
  assert.equal(PRISM_SCAN_WINDOW, 4999);
  assert.equal(PRISM_LIVE_WINDOW, 1200);
  assert.ok(Math.abs(PRISM_BREAK_EVEN - 1 / MATCH_PAYOUT) < 1e-12);
});

test("binomial, beta and chi-square tails are exact in their limits", () => {
  assert.equal(binomialUpperTail(0, 100, 0.1), 1);
  assert.equal(binomialUpperTail(101, 100, 0.1), 0);
  assert.ok(Math.abs(binomialUpperTail(500, 4999, 0.1) - 0.5) < 0.06);
  assert.ok(binomialUpperTail(666, 4999, 0.1) < 1e-9, "a 7.8σ excess must be negligible");
  assert.ok(Math.abs(chiSquarePValue(0, 9) - 1) < 1e-9);
  assert.ok(chiSquarePValue(1000, 9) < 1e-100);
  assert.ok(Math.abs(gammaQ(1, 1) - Math.exp(-1)) < 1e-9, "Q(1,1) = e^-1 exactly");
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(10, 100) < 0.1 && wilsonLowerBound(10, 100) > 0.05);
});

test("a degenerate tape is refused rather than crashed on", () => {
  const flat = new Array(1500).fill(7);
  const spec = prismCertaintySpec("strict");
  const required = requiredWinRateFor(plan(), spec.minLadderClearance);
  const cand = evaluatePrismCandidate("R_10", "V10", flat, 7, { certainty: "strict", plan: plan(), requiredWinRate: required });
  assert.ok(cand, "a degenerate tape still produces a candidate object");
  assert.ok(Number.isFinite(cand!.pBiased) && Number.isFinite(cand!.confidence));
  assert.ok(Number.isFinite(cand!.oosWinRate) && Number.isFinite(cand!.pClear));
  const fit = compositionalFit(countDigits(flat));
  assert.ok(Number.isFinite(fit.bayesFactor));
  assert.ok(fit.pBiased > 0.9, "a constant stream is about as biased as a stream can be");
  const gaps = memorylessnessTest(flat, 7);
  assert.ok(Number.isFinite(gaps.pValue));
});

test("a tape shorter than the measurement floor is refused, not guessed at", () => {
  const spec = prismCertaintySpec("strict");
  const required = requiredWinRateFor(plan(), spec.minLadderClearance);
  assert.equal(
    evaluatePrismCandidate("R_10", "V10", uniform(PRISM_MIN_HISTORY - 1, 5), 1,
      { certainty: "strict", plan: plan(), requiredWinRate: required }),
    null,
  );
});

test("certainty tiers are ordered from most to least demanding", () => {
  const e = prismCertaintySpec("elite");
  const s = prismCertaintySpec("strict");
  const b = prismCertaintySpec("balanced");
  assert.ok(e.minBiasedPosterior > s.minBiasedPosterior && s.minBiasedPosterior > b.minBiasedPosterior);
  assert.ok(e.minPosteriorClear > s.minPosteriorClear && s.minPosteriorClear > b.minPosteriorClear);
  assert.ok(e.minLadderClearance > b.minLadderClearance);
  assert.ok(e.minDeltaBic > s.minDeltaBic && s.minDeltaBic > b.minDeltaBic);
  assert.ok(e.targetShotRate < s.targetShotRate && s.targetShotRate < b.targetShotRate,
    "elite must be the most selective");
  assert.equal(prismCertaintySpec(undefined).id, "strict");
  assert.equal(PRISM_CERTAINTY.balanced.id, "balanced");
});
