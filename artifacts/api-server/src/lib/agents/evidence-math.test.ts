/**
 * Tests for the evidence mathematics.
 *
 * Every assertion here checks against an INDEPENDENTLY KNOWN value (published
 * critical values, closed-form identities, or exact analytic results) rather
 * than against a previous run of this code — so a regression in the numerics
 * shows up as a failure instead of a snapshot change.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  betaTailProbability,
  chiSquareUpperTail,
  combineEvidence,
  digitEdgePosterior,
  logGamma,
  markovDependenceTest,
  MAX_TERM_LOG_ODDS,
  probabilityToLogOdds,
  regularizedGammaQ,
  regularizedIncompleteBeta,
  requiredEvidence,
  sprtBoundaries,
  DIRICHLET_PRIOR_ALPHA,
} from "./evidence-math";

const close = (actual: number, expected: number, tol: number, msg?: string) => {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? "value"}: got ${actual}, expected ${expected} ±${tol}`,
  );
};

// ── Gamma / beta primitives ───────────────────────────────────────────────────

test("logGamma matches exact factorials", () => {
  // Γ(n) = (n-1)! for positive integers.
  close(logGamma(1), 0, 1e-12, "Γ(1)");
  close(logGamma(2), 0, 1e-12, "Γ(2)");
  close(logGamma(5), Math.log(24), 1e-10, "Γ(5)=4!");
  close(logGamma(10), Math.log(362880), 1e-9, "Γ(10)=9!");
  close(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10, "Γ(0.5)=√π");
});

test("regularizedIncompleteBeta is exact for integer parameters", () => {
  // I_x(1,1) = x  (uniform)
  close(regularizedIncompleteBeta(1, 1, 0.3), 0.3, 1e-12, "I_0.3(1,1)");
  // I_x(2,1) = x²
  close(regularizedIncompleteBeta(2, 1, 0.4), 0.16, 1e-12, "I_0.4(2,1)");
  // I_x(1,2) = 1-(1-x)²
  close(regularizedIncompleteBeta(1, 2, 0.4), 1 - 0.36, 1e-12, "I_0.4(1,2)");
  // Symmetry: I_x(a,b) = 1 - I_{1-x}(b,a)
  close(
    regularizedIncompleteBeta(3, 7, 0.42),
    1 - regularizedIncompleteBeta(7, 3, 0.58),
    1e-12,
    "symmetry",
  );
  // Edges
  assert.equal(regularizedIncompleteBeta(2, 2, 0), 0);
  assert.equal(regularizedIncompleteBeta(2, 2, 1), 1);
});

test("betaTailProbability is 0.5 at the symmetric mean", () => {
  close(betaTailProbability(2, 2, 0.5), 0.5, 1e-12, "Beta(2,2) median");
  close(betaTailProbability(10, 10, 0.5), 0.5, 1e-12, "Beta(10,10) median");
  // A tight posterior far from the threshold gives a near-certain answer.
  assert.ok(betaTailProbability(500, 100, 0.5) > 0.9999, "confident above");
  assert.ok(betaTailProbability(100, 500, 0.5) < 0.0001, "confident below");
});

test("chiSquareUpperTail matches published critical values", () => {
  // Standard tables: χ²_{0.05} for df=1, 9, 81.
  close(chiSquareUpperTail(3.8415, 1), 0.05, 2e-4, "df=1 @ 0.05");
  close(chiSquareUpperTail(16.919, 9), 0.05, 2e-4, "df=9 @ 0.05");
  close(chiSquareUpperTail(103.01, 81), 0.05, 5e-4, "df=81 @ 0.05");
  // Degenerate inputs.
  assert.equal(chiSquareUpperTail(0, 81), 1);
  assert.equal(chiSquareUpperTail(-5, 81), 1);
});

test("regularizedGammaQ is complementary to P", () => {
  close(regularizedGammaQ(1, 1), Math.exp(-1), 1e-12, "Q(1,1)=e⁻¹");
  close(regularizedGammaQ(2, 3), Math.exp(-3) * (1 + 3), 1e-12, "Q(2,3)");
});

// ── Dirichlet–multinomial edge posterior ──────────────────────────────────────

test("edge posterior collapses to a prior-only Beta with no observations", () => {
  const counts = new Array(10).fill(0);
  // OVER 4 → 5 winning digits (5..9), 5 losing (0..4), α₀=2 each.
  const post = digitEdgePosterior(counts, 4, "over", 2);
  close(post.alpha, 10, 1e-12, "alpha");
  close(post.beta, 10, 1e-12, "beta");
  close(post.meanWinProbability, 0.5, 1e-12, "mean");
  close(post.sampleSize, 0, 1e-12, "sampleSize");
  // No data ⇒ the edge question is a coin flip, regardless of payout.
  close(post.edgeProbability, 0.5, 1e-12, "no evidence ⇒ 0.5");
});

test("edge posterior counts digits on the correct side", () => {
  // All digits land on 7 → OVER 6 wins (7>6), OVER 7 loses (7 is not > 7).
  const counts = new Array(10).fill(0);
  counts[7] = 100;
  const over6 = digitEdgePosterior(counts, 6, "over", 1.9);
  const over7 = digitEdgePosterior(counts, 7, "over", 1.9);
  assert.ok(over6.edgeProbability > 0.99, "OVER 6 should be near-certain");
  assert.ok(over7.edgeProbability < 0.5, "OVER 7 should not be favoured");

  // UNDER mirrors it. Every observed digit is 7, so UNDER 8 (7 < 8) wins and
  // UNDER 7 (7 < 7 is false) loses.
  const under8 = digitEdgePosterior(counts, 8, "under", 1.9);
  assert.ok(under8.edgeProbability > 0.99, "UNDER 8 wins when the digit is 7");
  const under7 = digitEdgePosterior(counts, 7, "under", 1.9);
  assert.ok(under7.edgeProbability < 0.5, "UNDER 7 excludes the digit 7");
});

test("edge posterior is sample-size aware — the core fix over a flat threshold", () => {
  // Same +5pp observed deviation from the 50% baseline, two sample sizes.
  const small = new Array(10).fill(0);
  for (let d = 5; d <= 9; d++) small[d] = 6; // 30 wins / 50 total = 60%
  for (let d = 0; d <= 4; d++) small[d] = 4; // 20 losses

  const large = new Array(10).fill(0);
  for (let d = 5; d <= 9; d++) large[d] = 600; // 3000 / 5000 = 60%
  for (let d = 0; d <= 4; d++) large[d] = 400;

  // Breakeven for a 1.9× payout ≈ 52.6%, so both are above breakeven.
  const pSmall = digitEdgePosterior(small, 4, "over", 1.9).edgeProbability;
  const pLarge = digitEdgePosterior(large, 4, "over", 1.9).edgeProbability;

  assert.ok(pLarge > pSmall, "larger sample ⇒ more confidence the edge is real");
  // The old flat "deviation > 0.005" rule treated these identically.
  assert.ok(
    pLarge - pSmall > 0.15,
    `sample size must materially change confidence (small=${pSmall.toFixed(3)}, large=${pLarge.toFixed(3)})`,
  );
});

test("edge posterior respects the payout breakeven", () => {
  // 52% win rate. Breakeven at 1.92× is 52.08% → essentially a coin flip.
  const counts = new Array(10).fill(0);
  for (let d = 5; d <= 9; d++) counts[d] = 520;
  for (let d = 0; d <= 4; d++) counts[d] = 480;
  const generous = digitEdgePosterior(counts, 4, "over", 2.5).edgeProbability; // breakeven 40%
  const harsh = digitEdgePosterior(counts, 4, "over", 1.5).edgeProbability;    // breakeven 66.7%
  assert.ok(generous > harsh, "a more generous payout makes the same win rate more valuable");
});

// ── Markov dependence test ────────────────────────────────────────────────────

test("markov test does not flag an independence-generated matrix", () => {
  // Construct a transition matrix that is EXACTLY row-conditional-independent:
  // every row is proportional to the same marginal ⇒ H₀ is true by construction.
  const marginal = [0.16, 0.04, 0.16, 0.04, 0.16, 0.04, 0.16, 0.04, 0.16, 0.04];
  const transitions: number[][] = [];
  for (let i = 0; i < 10; i++) {
    transitions.push(marginal.map((p) => Math.round(p * 1000)));
  }
  const result = markovDependenceTest(transitions);
  assert.ok(
    result.pValue > 0.05,
    `exactly-independent matrix must not be significant (p=${result.pValue})`,
  );
  assert.equal(result.significant, false);
});

test("markov test flags a strongly dependent matrix", () => {
  // Deterministic successor: digit i always followed by (i+1) mod 10.
  const transitions: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
  for (let i = 0; i < 10; i++) transitions[i][(i + 1) % 10] = 50;
  const result = markovDependenceTest(transitions);
  assert.ok(result.significant, "perfect determinism must be significant");
  assert.ok(result.pValue < 1e-6, `p-value should be tiny (got ${result.pValue})`);
  close(result.g2, 2 * 10 * 50 * Math.log(10), 1e-6, "G² closed form");
});

test("markov test handles empty and degenerate input safely", () => {
  const empty = markovDependenceTest(Array.from({ length: 10 }, () => new Array(10).fill(0)));
  assert.equal(empty.significant, false);
  assert.equal(empty.observations, 0);
  assert.equal(empty.pValue, 1);
  // Ragged rows must not throw.
  const ragged = Array.from({ length: 10 }, () => []);
  assert.doesNotThrow(() => markovDependenceTest(ragged));
});

// ── Evidence fusion ───────────────────────────────────────────────────────────

test("probabilityToLogOdds is 0 at 0.5 and clamped at the extremes", () => {
  close(probabilityToLogOdds(0.5), 0, 1e-12, "p=0.5");
  close(probabilityToLogOdds(0), -MAX_TERM_LOG_ODDS, 1e-12, "p→0 clamps");
  close(probabilityToLogOdds(1), MAX_TERM_LOG_ODDS, 1e-12, "p→1 clamps");
  assert.ok(probabilityToLogOdds(0.62) > 0, "p>0.5 is positive evidence");
  assert.ok(probabilityToLogOdds(0.62) < MAX_TERM_LOG_ODDS);
});

test("combineEvidence normalises by present weight only", () => {
  const withAll = combineEvidence([
    { id: "a", weight: 1, logOdds: 1 },
    { id: "b", weight: 1, logOdds: 1 },
  ]);
  close(withAll.total, 1, 1e-12, "mean of equal terms");

  // Dropping a term must not silently rescale the score.
  const withOne = combineEvidence([{ id: "a", weight: 1, logOdds: 1 }]);
  close(withOne.total, 1, 1e-12, "single term");
});

test("combineEvidence ignores zero/negative/non-finite weights", () => {
  const result = combineEvidence([
    { id: "real", weight: 2, logOdds: 1 },
    { id: "zero", weight: 0, logOdds: 999 },
    { id: "negative", weight: -5, logOdds: 999 },
    { id: "nan", weight: Number.NaN, logOdds: 1 },
  ]);
  close(result.total, 1, 1e-12, "only the valid term counts");
  assert.equal(result.contributions.length, 1);
});

test("combineEvidence clamps each term to the bounded range", () => {
  const result = combineEvidence([{ id: "extreme", weight: 1, logOdds: 1e9 }]);
  close(result.total, MAX_TERM_LOG_ODDS, 1e-12, "clamped");
});

test("SAFETY INVARIANT: a maximally bad edge cannot be outvoted", () => {
  // Weights mirror the SHIPPED EVIDENCE_WEIGHTS in master-decision.ts.
  const edgeWeight = 0.55;
  const secondaryWeight = 1 - edgeWeight; // 0.45

  const worstEdge = combineEvidence([
    { id: "edge", weight: edgeWeight, logOdds: -MAX_TERM_LOG_ODDS },
    { id: "everythingElse", weight: secondaryWeight, logOdds: MAX_TERM_LOG_ODDS },
  ]);

  // Closed form: 2 - 4·w = 2 - 2.2 = -0.2. Even with every secondary signal
  // maxed out in favour, the fused score must stay NEGATIVE — so no threshold
  // above zero can admit a trade with no real statistical edge.
  close(worstEdge.total, 2 - 4 * edgeWeight, 1e-12, "worst-case edge bound");
  assert.ok(
    worstEdge.total < 0,
    `worst-case edge must keep the score negative (got ${worstEdge.total.toFixed(4)})`,
  );

  // The invariant requires w > 0.5. Guard the shipped weight against a future
  // edit that would silently break it.
  assert.ok(edgeWeight > 0.5, "edge weight must exceed 0.5 for the invariant to hold");

  // Conversely, a maximally GOOD edge survives maximally BAD secondary signals:
  // 4·w − 2 = +0.2. This is the substitutability that AND-gates could not express.
  const bestEdgeWorstRest = combineEvidence([
    { id: "edge", weight: edgeWeight, logOdds: MAX_TERM_LOG_ODDS },
    { id: "everythingElse", weight: secondaryWeight, logOdds: -MAX_TERM_LOG_ODDS },
  ]);
  close(bestEdgeWorstRest.total, 4 * edgeWeight - 2, 1e-12, "best-case edge bound");
  assert.ok(bestEdgeWorstRest.total > 0, "a real edge survives hostile secondary signals");
});

test("SAFETY INVARIANT: weak secondary signals can be carried by a strong edge", () => {
  // This is the property AND-gates could not express: timing is actively bad,
  // but a genuinely strong statistical edge still admits the trade.
  const result = combineEvidence([
    { id: "edge", weight: 0.55, logOdds: 1.5 },   // strong edge
    { id: "timing", weight: 0.12, logOdds: -2 },  // worst possible timing
    { id: "regime", weight: 0.10, logOdds: -2 },
    { id: "drift", weight: 0.08, logOdds: -1 },
    { id: "streak", weight: 0.06, logOdds: -1 },
    { id: "markov", weight: 0.05, logOdds: 0 },
    { id: "dataQuality", weight: 0.04, logOdds: 0 },
  ]);
  assert.ok(
    result.total > 0,
    `a real edge should survive bad timing (got ${result.total.toFixed(4)})`,
  );
});

test("RECOVERY SCENARIO: a genuine edge is admitted once the threshold decays", () => {
  // Worked end-to-end example of the intended recovery behaviour.
  // A real edge (P(edge real) ≈ 77%) sitting in a hostile market: worst-case
  // timing, worst-case regime, a deep loss streak, and a failing recent WR —
  // i.e. exactly the conditions the old hard gates vetoed indefinitely.
  const terms = [
    { id: "edge", weight: 0.55, logOdds: 1.2 },
    { id: "timing", weight: 0.12, logOdds: -2 },
    { id: "regime", weight: 0.10, logOdds: -2 },
    { id: "drift", weight: 0.08 * 0.4, logOdds: -2 },   // damped: tautological in recovery
    { id: "streak", weight: 0.06 * 0.4, logOdds: -2 },  // damped
    { id: "markov", weight: 0.05, logOdds: -1 },
    { id: "dataQuality", weight: 0.04, logOdds: 0 },
  ];
  const { total } = combineEvidence(terms);

  // Demanding bar at t=0 → the engine waits for a better setup.
  const atStart = requiredEvidence({
    elapsedMs: 0, startThreshold: 0.30, floorThreshold: 0.03, tauMs: 120_000,
  });
  assert.ok(total < atStart, `t=0 should still wait (evidence ${total.toFixed(3)} < ${atStart})`);

  // But the bar DECAYS, so the same evidence is eventually admitted — this is
  // the property that removes the indefinite stall. The old implementation had
  // no such mechanism: the thresholds were constant.
  const later = requiredEvidence({
    elapsedMs: 300_000, startThreshold: 0.30, floorThreshold: 0.03, tauMs: 120_000,
  });
  assert.ok(
    total > later,
    `after 5min the same setup should clear the decayed bar (evidence ${total.toFixed(3)} > ${later.toFixed(3)})`,
  );

  // And the floor still demands positive evidence — never a coin flip.
  const atInfinity = requiredEvidence({
    elapsedMs: Number.MAX_SAFE_INTEGER, startThreshold: 0.30, floorThreshold: 0.03, tauMs: 120_000,
  });
  assert.ok(atInfinity > 0, "floor stays positive");
});

// ── SPRT ──────────────────────────────────────────────────────────────────────

test("sprtBoundaries match the Wald closed form", () => {
  const b = sprtBoundaries(0.05, 0.05);
  close(b.upper, Math.log(0.95 / 0.05), 1e-12, "upper");
  close(b.lower, Math.log(0.05 / 0.95), 1e-12, "lower");
  assert.ok(b.upper > 0 && b.lower < 0, "boundaries straddle zero");

  // Asymmetric error rates must respect the direction of the trade-off.
  const strict = sprtBoundaries(0.01, 0.05);
  assert.ok(strict.upper > b.upper, "smaller α demands more evidence");
});

test("sprtBoundaries clamps invalid inputs to defaults", () => {
  const b = sprtBoundaries(0, 5);
  close(b.alpha, 0.05, 1e-12, "alpha defaulted");
  close(b.beta, 0.05, 1e-12, "beta defaulted");
});

// ── Time-decayed admission ────────────────────────────────────────────────────

test("requiredEvidence equals the start threshold at t=0", () => {
  close(
    requiredEvidence({ elapsedMs: 0, startThreshold: 0.3, floorThreshold: 0.02, tauMs: 120_000 }),
    0.3,
    1e-12,
    "t=0",
  );
});

test("requiredEvidence decays monotonically toward the floor and never below it", () => {
  const opts = { startThreshold: 0.3, floorThreshold: 0.02, tauMs: 120_000 };
  let previous = Number.POSITIVE_INFINITY;
  for (let t = 0; t <= 1_800_000; t += 30_000) {
    const value = requiredEvidence({ ...opts, elapsedMs: t });
    assert.ok(value <= previous + 1e-12, `threshold must not rise (t=${t})`);
    assert.ok(value >= opts.floorThreshold - 1e-12, `threshold must not fall below floor (t=${t})`);
    previous = value;
  }
  // Long after τ the threshold has effectively reached the floor.
  close(
    requiredEvidence({ ...opts, elapsedMs: 120_000 * 20 }),
    opts.floorThreshold,
    1e-6,
    "asymptote",
  );
});

test("requiredEvidence halves the gap after one time constant", () => {
  const opts = { startThreshold: 1.0, floorThreshold: 0.0, tauMs: 60_000 };
  // After exactly one τ the remaining gap is e⁻¹ of the original:
  //   L_req(τ) = 0 + (1 − 0)·e^(−60_000/60_000) = e⁻¹ ≈ 0.3679
  close(
    requiredEvidence({ ...opts, elapsedMs: 60_000 }),
    Math.exp(-1),
    1e-12,
    "one τ ⇒ 1/e of the gap remains",
  );
  // Two τ ⇒ e⁻² of the gap.
  close(
    requiredEvidence({ ...opts, elapsedMs: 120_000 }),
    Math.exp(-2),
    1e-12,
    "two τ ⇒ e⁻² of the gap remains",
  );
});

test("requiredEvidence is robust to hostile inputs", () => {
  assert.ok(Number.isFinite(requiredEvidence({ elapsedMs: -1, startThreshold: 0.3, floorThreshold: 0.02, tauMs: 120_000 })));
  assert.ok(Number.isFinite(requiredEvidence({ elapsedMs: 1000, startThreshold: 0.3, floorThreshold: 0.02, tauMs: 0 })));
  assert.ok(Number.isFinite(requiredEvidence({ elapsedMs: Number.NaN, startThreshold: 0.3, floorThreshold: 0.02, tauMs: 120_000 })));
});

test("a positive floor is always required for admission", () => {
  // Guards the documented safety property: the floor must stay above zero so
  // waiting can never reduce the bar to 'trade on a coin flip'.
  const floor = 0.02;
  const atInfinity = requiredEvidence({
    elapsedMs: Number.MAX_SAFE_INTEGER,
    startThreshold: 0.30,
    floorThreshold: floor,
    tauMs: 120_000,
  });
  assert.ok(atInfinity > 0, "the asymptotic bar stays positive");
  close(atInfinity, floor, 1e-9, "reaches the floor");
});

test("the alpha=2 prior matches the shipped digit-probability prior", () => {
  // digit-probability.ts uses (c + 2) / (n + 20); this module must agree.
  assert.equal(DIRICHLET_PRIOR_ALPHA, 2);
  const counts = new Array(10).fill(0);
  counts[0] = 8;
  const posterior = digitEdgePosterior(counts, 8, "under", 1.09);
  // UNDER 8 wins on digits 0..7 → 8 winning digits × α₀=2 = 16, +8 observations
  // on digit 0 = 24. Losing side is digits 8,9 → 2 × 2 = 4.
  close(posterior.alpha, 24, 1e-12, "alpha");
  close(posterior.beta, 4, 1e-12, "beta");
});
