/**
 * MATCH PRISM — a Matches-only specialist that refuses to trade structure it
 * cannot prove exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE TWO EXISTING MATCHES BOTS LOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * A Deriv Matches contract pays 8.93× and the fair rate for any single digit is
 * 10%, so the break-even rate is 1/8.93 = 11.20%. The house edge on a FAIR
 * stream is therefore −10.7% per shot, and no amount of staking, gap counting or
 * "hot digit" storytelling changes that: on an i.i.d. uniform stream every
 * Matches strategy ever written loses at exactly that rate.
 *
 * So a Matches bot cannot win by predicting digits better. It can only win by
 * (a) refusing to trade when the stream is indistinguishable from uniform, and
 * (b) when the stream IS measurably non-uniform, betting the digit whose
 *     advantage survives every honest correction for the fact that it was chosen
 *     as the best of ten candidates.
 *
 * Both predecessors skip (a) entirely and get (b) structurally wrong:
 *
 *   Match Sniper (BOT-MATCH) — tests each digit against 1/10 with a binomial z,
 *   picks the largest, and pays for the argmax-of-ten bias with a flat 1.5σ
 *   margin. It never asks whether the MARKET is biased at all, so it happily
 *   deploys the "hottest" digit of a perfectly uniform stream — which is the
 *   single most expensive mistake available in this contract family. It then
 *   times entries from a FIXED 4–12 tick dormancy band, i.e. it trades the
 *   gambler's fallacy unless the gaps happen to be non-geometric (it never
 *   checks).
 *
 *   Matches/Differs Oracle (ks-matchdiff) — a generalist tail-contract ensemble
 *   (Hedge-weighted context trees, quantile entry bar) applied to a 1-in-10
 *   narrow win set. The quantile bar is calibrated for a different base rate and
 *   the same session may switch to Differs, so the recovery ledger can be
 *   recovered in a 1.09× contract after losing in an 8.93× one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PRISM PRINCIPLE — NOTHING IS USED UNTIL IT IS PROVEN
 * ─────────────────────────────────────────────────────────────────────────────
 * Prism runs three independent proofs of structure before it is willing to
 * believe ANY signal, and shrinks every unproven signal to zero:
 *
 *   PROOF 1 — IS THE MARKET BIASED AT ALL?          (compositional Bayes factor)
 *     The ten digit counts are modelled as a Dirichlet–multinomial.
 *       H₀: p is exactly uniform (α = 1 per digit).
 *       H₁: p is a FIXED but unknown distribution — one draw from a symmetric
 *           Dirichlet whose concentration α is fitted.
 *     Both marginal likelihoods are exact and closed-form in log-Γ, so
 *     BF₁₀ = P(data | H₁)/P(data | H₀) is a genuine Bayes factor for "this
 *     market has a persistent digit bias", not a p-value that a 4,999-tick
 *     sample turns significant on a 0.2pp deviation the payout makes worthless.
 *     THIS IS THE POINT: at N = 4,999 a χ² test declares structure significant
 *     for deviations ~10× smaller than the 1.2pp needed to break even. Prism
 *     decides on a posterior probability of BIAS, never on statistical
 *     significance alone.
 *
 *   PROOF 2 — DOES THE PREVIOUS DIGIT MATTER?              (Markov order test)
 *     The 10×10 digit transition table is compared with the memoryless model by
 *     BIC. Only if ΔBIC clears the certainty bar may the transition row
 *     contribute, and then only through an exact conjugate Dirichlet posterior
 *     shrunk toward the marginal. A 10-state chain fitted on 2,500 ticks has
 *     ~250 observations per row; used unconditionally (as both predecessors do)
 *     it injects noise, not signal.
 *
 *   PROOF 3 — DOES BEING "OVERDUE" MATTER?               (memorylessness test)
 *     The chosen digit's own inter-arrival gaps are tested against the fitted
 *     Geometric with a binned χ² goodness-of-fit. If the geometric fits, the
 *     gap process is MEMORYLESS and "this digit is due" is the gambler's
 *     fallacy with a p-value attached; the renewal clock then contributes
 *     exactly nothing. If the geometric is rejected, the empirical hazard is
 *     admitted as evidence. Prism is the only bot in this repo that tests the
 *     premise of its own dormancy logic instead of assuming it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT DECIDES A TRADE
 * ─────────────────────────────────────────────────────────────────────────────
 * Not "is p̂ > 11.2%". Two numbers must BOTH clear their bar:
 *
 *   pClear — P(p_digit > break-even | the digits that just came), an exact
 *            posterior tail probability (regularized incomplete beta, no normal
 *            approximation, correct at 10% rates). Under a fair stream with
 *            4,999 ticks this is ≈ 0.002, so requiring 0.97 is a real filter.
 *
 *   LADDER CLEARANCE — the probability that the USER'S OWN recovery ladder
 *            (base stake, markup, max stake, max steps, stop loss) clears the
 *            debt before the loss run hits the stop loss, at the digit's
 *            PESSIMISTIC rate. Computed by an exact absorbing-chain value
 *            iteration over debt states using the same stake formula the live
 *            engine executes (`calculateBotRecoveryStake` → limits → cents).
 *            `requiredWinRate(plan, target)` then inverts it: "for this ladder
 *            to clear 95% of the time, the digit must truly win at least X%".
 *            A candidate that cannot clear its own ladder is refused no matter
 *            how hot it looks. This is the mechanism that stops the "multiple
 *            losses" the user kept hitting: the ladder is priced BEFORE the
 *            bot is allowed to enter it.
 *
 * Everything is out of sample: the fit sees the FIRST half of each market's
 * history, the frozen rule is then measured on the SECOND half, which the fit
 * never touched. In-sample and out-of-sample are both reported so overfitting is
 * visible rather than hidden.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SPEED
 * ─────────────────────────────────────────────────────────────────────────────
 * The scan is closed-form first: a cheap uniform-BF + count screen over all
 * 190 (market × digit) candidates, Monte Carlo over the Dirichlet posterior only
 * for the few that survive, and the ladder DP (value iteration, ~2k states)
 * only for the refined set. Live, every gate is closed-form arithmetic on a
 * rolling count array — O(1) per tick, no Monte Carlo in the hot loop.
 *
 * This module is pure: no I/O, no session state, no feed. Everything below is a
 * function of digit arrays and numbers, so it is unit-testable without a market.
 */

import { MATCH_PAYOUT } from "./payouts";
import {
  benjaminiHochberg,
  regularizedIncompleteBeta,
} from "./specialist-analysis";
import { applyRecoveryStakeLimits, calculateBotRecoveryStake, toCents } from "./recovery-math";

// ── Identity ──────────────────────────────────────────────────────────────────

export const PRISM_BOT_ID = "match-prism";
export const PRISM_BOT_NAME = "Match Prism";
/** The only contract this bot may ever buy — enforced before every execution. */
export const PRISM_CONTRACT_TYPE = "DIGITMATCH";
/** Digits are 0–9. */
export const PRISM_DIGITS = 10;
/** Break-even rate at the canonical Matches payout (1 / 8.93 = 11.20 %). */
export const PRISM_BREAK_EVEN = 1 / MATCH_PAYOUT;
/** Deep history: Deriv's hard maximum for `ticks_history`. */
export const PRISM_SCAN_WINDOW = 4_999;
/** Live trailing window the entry statistic is computed over. */
export const PRISM_LIVE_WINDOW = 1_200;
/** Minimum digits before any verdict is issued at all. */
export const PRISM_MIN_HISTORY = 900;

// ── Numeric helpers ───────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, d = 4): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** d;
  const scaled = Math.round(v * f) / f;
  // Rounding a value near the double ceiling overflows to Infinity, which
  // JSON-serialises as `null` and would blank the console's Bayes factor. A
  // number that large cannot be rounded meaningfully anyway, so it is returned
  // as it stands.
  return Number.isFinite(scaled) ? scaled : v;
}
function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Lanczos log-Γ (g = 7, n = 9). |error| < 1e-13 for z > 0. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function logGamma(z: number): number {
  if (z < 0.5) {
    // Reflection: Γ(z)Γ(1−z) = π / sin(πz)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zz = z - 1;
  let x = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i++) x += LANCZOS[i]! / (zz + i);
  const t = zz + 7 + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized upper incomplete gamma Q(a, x) — series + Lentz continued fraction. */
export function gammaQ(a: number, x: number): number {
  if (!(x >= 0) || !(a > 0)) return 1;
  if (x === 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    // Series for P(a,x), then Q = 1 − P.
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    const p = sum * Math.exp(-x + a * Math.log(x) - gln);
    return clamp(1 - p, 0, 1);
  }
  // Continued fraction for Q(a,x).
  const fpmin = 1e-300;
  let b = x + 1 - a;
  let c = 1 / fpmin;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = b + an / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return clamp(Math.exp(-x + a * Math.log(x) - gln) * h, 0, 1);
}

/** Upper-tail p-value of a χ² statistic. */
export function chiSquarePValue(chi2: number, df: number): number {
  if (!(chi2 > 0) || df <= 0) return 1;
  return gammaQ(df / 2, chi2 / 2);
}

/**
 * Exact binomial upper tail P(X ≥ k | n, p) via the regularized incomplete
 * beta — the FDR p-value Prism uses for digit selection. No normal
 * approximation: at 10% rates with a few thousand ticks the normal tail is
 * wrong by a factor of two in the region that decides deployment.
 */
export function binomialUpperTail(k: number, n: number, p: number): number {
  if (n <= 0) return 1;
  if (k <= 0) return 1;
  if (k > n) return 0;
  return clamp(regularizedIncompleteBeta(p, k, n - k + 1), 0, 1);
}

/** Seeded PRNG (mulberry32) — the Monte Carlo must be reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gamma sampler — Marsaglia–Tsang, with the k < 1 boost. */
function sampleGamma(k: number, rng: () => number): number {
  if (k < 1) {
    // Γ(k) = Γ(k+1) · U^(1/k)
    const u = Math.max(rng(), 1e-320);
    return sampleGamma(k + 1, rng) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let guard = 0; guard < 1000; guard++) {
    // Standard normal by Box–Muller.
    const u1 = Math.max(rng(), 1e-320);
    const u2 = rng();
    const x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = Math.max(rng(), 1e-320);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
  return d;
}

// ── PROOF 1 — the compositional uniformity test ───────────────────────────────

export interface CompositionalFit {
  /** Uniform-reference concentration (H₀). */
  alpha0: number;
  /** Posterior-weighted mean of the fitted concentration (H₁). */
  alphaHat: number;
  /** Dispersion is 1 at the fitted α — practical shorthand for the console. */
  logMlUniform: number;
  logMlBiased: number;
  /** BF₁₀: evidence that the market's digit distribution is NOT uniform. */
  bayesFactor: number;
  /** P(market biased | data) with the repo's prior that most markets are fair. */
  pBiased: number;
  /** Pearson χ² of uniformity (9 df) and its p-value, for display only. */
  chi2: number;
  chi2P: number;
  counts: number[];
  total: number;
}

/**
 * Log marginal likelihood of the digit counts under a symmetric Dirichlet(α)
 * prior — the Dirichlet–multinomial. The multinomial coefficient is constant in
 * α and therefore cancels in the Bayes factor, so it is omitted (documented here
 * so nobody later "fixes" the missing constant).
 */
export function logDirichletMultinomial(counts: number[], alpha: number): number {
  const k = counts.length;
  const n = counts.reduce((a, b) => a + b, 0);
  const a = Math.max(1e-9, alpha);
  let s = logGamma(k * a) - logGamma(k * a + n);
  const lgA = logGamma(a);
  for (const c of counts) s += logGamma(a + c) - lgA;
  return s;
}

/**
 * Log likelihood of the counts under the POINT null: p is exactly uniform.
 *
 * This is H₀ and getting it right is the whole reason the Bayes factor works.
 *
 * The obvious-looking alternative — averaging a Dirichlet(1) over the simplex —
 * is NOT the uniform hypothesis: Dirichlet(1) is a wildly over-dispersed prior
 * that expects digit rates scattered between 5% and 15%, so on a genuinely
 * uniform tape it fits WORSE than a concentrated Dirichlet, and the "Bayes
 * factor" then reports enormous evidence of bias on a stream that has none. The
 * first draft of this module did exactly that (BF ≈ 2.5e6 on an i.i.d. tape) and
 * the test suite caught it — which is the point of testing the null.
 *
 * The correct null is the multinomial with p = 1/K fixed. The bias model
 * (Dirichlet(α) with α fitted) NESTS it: as α → ∞ the Dirichlet concentrates to
 * a point and the alternative converges to the null, so on uniform data the
 * Bayes factor can never exceed 1 and on biased data it explodes.
 */
export function logNullMultinomial(counts: number[]): number {
  const n = counts.reduce((a, b) => a + b, 0);
  return -n * Math.log(counts.length);
}

const ALPHA_GRID_MIN = 0.05;
const ALPHA_GRID_MAX = 5_000;
const ALPHA_GRID_POINTS = 180;
const ALPHA_GRID = (() => {
  const out: number[] = [];
  const lo = Math.log(ALPHA_GRID_MIN);
  const hi = Math.log(ALPHA_GRID_MAX);
  for (let i = 0; i < ALPHA_GRID_POINTS; i++) {
    out.push(Math.exp(lo + ((hi - lo) * i) / (ALPHA_GRID_POINTS - 1)));
  }
  return out;
})();
/**
 * Prior odds that a random market is biased. Both predecessors implicitly used
 * 1:1 (any deviation counts); Prism starts sceptical and lets the data argue,
 * so a weakly-biased market cannot deploy on a coin-flip posterior.
 */
export const PRISM_PRIOR_ODDS_FAIR_TO_BIASED = 3;

/**
 * Full compositional screen for one market.
 *
 * H₀ = the point null (exactly uniform). H₁ = a symmetric Dirichlet whose
 * concentration α is integrated over a log-uniform prior on [0.05, 5000] — the
 * grid must reach far enough that the bias model can actually collapse onto the
 * null, otherwise Occam's razor is applied to a family that does not contain the
 * truth and the factor is biased toward the alternative.
 */
export function compositionalFit(
  counts: number[],
  opts: { priorOddsFairToBiased?: number } = {},
): CompositionalFit {
  const priorOdds = opts.priorOddsFairToBiased ?? PRISM_PRIOR_ODDS_FAIR_TO_BIASED;
  const total = counts.reduce((a, b) => a + b, 0);
  const alpha0 = 1;
  const logMlUniform = logNullMultinomial(counts);

  // Marginal likelihood of H₁ by log-space quadrature, and the posterior mean of
  // α over the same grid (the Bayes estimate Prism then uses for its draws).
  let maxLog = -Infinity;
  const gridLogs = ALPHA_GRID.map((a) => {
    const v = logDirichletMultinomial(counts, a);
    if (v > maxLog) maxLog = v;
    return v;
  });
  let wSum = 0;
  let acc = 0;
  let alphaAcc = 0;
  for (let i = 0; i < ALPHA_GRID.length; i++) {
    // Log-uniform prior ⇒ equal weight per grid point (w = 1/priorWidth).
    const w = Math.exp(gridLogs[i]! - maxLog);
    wSum += w;
    acc += w * gridLogs[i]!;
    alphaAcc += w * ALPHA_GRID[i]!;
  }
  // The −log(points) term is the prior weight of each grid cell; without it the
  // marginal would be a profile maximum and the factor would be dishonest by
  // roughly the width of the α search.
  const logMlBiased = acc / wSum - Math.log(ALPHA_GRID.length);
  const alphaHat = alphaAcc / wSum;

  const logBf = logMlBiased - logMlUniform;
  // Guard the exponential: a BF beyond e^600 is "as certain as it gets", and
  // the cap is chosen so the value survives the rounding above (a degenerate,
  // near-deterministic stream drives the raw factor to the double ceiling).
  // A NaN factor can only come from a grid that underflowed entirely, and it is
  // reported as "no evidence" rather than propagated into the gate.
  const bayesFactor = Number.isNaN(logBf)
    ? 1
    : logBf > 600
      ? Math.exp(600)
      : Math.exp(logBf);
  const pBiased = (bayesFactor * 1) / (bayesFactor * 1 + priorOdds);

  // Pearson χ², display only.
  const fair = total / counts.length;
  let chi2 = 0;
  if (fair > 0) for (const c of counts) chi2 += ((c - fair) ** 2) / fair;

  return {
    alpha0,
    alphaHat: round(alphaHat, 4),
    logMlUniform: round(logMlUniform, 4),
    logMlBiased: round(logMlBiased, 4),
    bayesFactor: Number.isFinite(bayesFactor) ? round(bayesFactor, 4) : bayesFactor,
    pBiased: round(pBiased, 6),
    chi2: round(chi2, 4),
    chi2P: round(chiSquarePValue(chi2, counts.length - 1), 6),
    counts: [...counts],
    total,
  };
}

/**
 * How many pseudo-observations the fitted concentration is allowed to carry.
 *
 * The fitted α describes how CONCENTRATED the market's digit distribution is; on
 * a uniform market it comes out in the thousands, and using k·α directly as a
 * prior strength would produce a posterior narrower than the sampling noise of a
 * window, turning the probabilistic gate into a hard threshold at break-even and
 * blinding it to a market that drifts. Capping the prior contribution keeps the
 * posterior width anchored to what a finite window can actually resolve.
 */
export const PRISM_PRIOR_STRENGTH_MAX = 200;

/** Prior contribution (pseudo-observations) implied by a fitted concentration. */
export function prismPriorStrength(alphaHat: number, k = PRISM_DIGITS): number {
  return Math.min(k * Math.max(1e-6, alphaHat), PRISM_PRIOR_STRENGTH_MAX);
}

/**
 * THE ONE POSTERIOR — shared by the scan, the walk-forward and the live loop.
 *
 * Mean: the exact Dirichlet–multinomial posterior mean (α̂ + nᵢ)/(k·α̂ + N).
 * Width: the observation count plus at most `PRISM_PRIOR_STRENGTH_MAX` pseudo
 * observations, so the same window always produces the same numbers no matter
 * which of the three callers is asking.
 */
export function prismPosterior(
  counts: number[],
  alphaHat: number,
): { mean: number[]; strength: number; observations: number } {
  const k = counts.length;
  const a = Math.max(1e-6, alphaHat);
  const observations = counts.reduce((x, y) => x + y, 0);
  const denom = k * a + observations;
  const mean = counts.map((c) => clamp((a + c) / denom, 1e-9, 1 - 1e-9));
  const strength = observations + prismPriorStrength(a, k);
  return { mean, strength: Math.max(1, strength), observations };
}

/** Beta-posterior parameters of one digit's rate under the shared posterior. */
function digitBeta(counts: number[], alphaHat: number, digit: number):
  { alphaPost: number; betaPost: number; pMean: number; strength: number } {
  const { mean, strength } = prismPosterior(counts, alphaHat);
  const pMean = mean[digit] ?? 1 / counts.length;
  return {
    pMean,
    strength,
    alphaPost: Math.max(1e-9, pMean * strength),
    betaPost: Math.max(1e-9, (1 - pMean) * strength),
  };
}

// ── PROOF 2 — Markov order (does the previous digit carry information?) ───────

export interface MarkovOrderTest {
  /** ΔBIC = BIC(memoryless) − BIC(order-1). > 0 favours the chain. */
  deltaBic: number;
  /** Rows with enough observations to estimate at all. */
  usableRows: number;
  /** True when the chain's evidence clears the certainty bar. */
  hasMemory: boolean;
  /** Concentration used for the row priors (shared with the marginal fit). */
  rowAlpha: number;
}

/**
 * BIC comparison of "digit is i.i.d." against "digit depends on the previous
 * digit". Cheap, decisive, and it needs no prior on the alternative — which is
 * exactly why it is the right gate BEFORE a conjugate posterior is allowed to
 * move the estimate.
 */
export function markovOrderTest(table: number[][], minDeltaBic: number): MarkovOrderTest {
  const k = table.length;
  const rowTotals = table.map((row) => row.reduce((a, b) => a + b, 0));
  const colTotals = new Array<number>(k).fill(0);
  for (const row of table) for (let j = 0; j < k; j++) colTotals[j] += row[j]!;
  const n = colTotals.reduce((a, b) => a + b, 0);
  if (n <= 0) return { deltaBic: 0, usableRows: 0, hasMemory: false, rowAlpha: 1 };

  const logL = (counts: number[], probs: number[]): number => {
    let s = 0;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i]! > 0) s += counts[i]! * Math.log(Math.max(probs[i]!, 1e-12));
    }
    return s;
  };

  // Memoryless: every row ~ the pooled marginal. (k−1) free parameters.
  const marginal = colTotals.map((c) => c / n);
  let ll0 = 0;
  for (const row of table) ll0 += logL(row, marginal);
  const bic0 = -2 * ll0 + (k - 1) * Math.log(n);

  // Order-1: each row its own distribution. k·(k−1) free parameters.
  let ll1 = 0;
  let usableRows = 0;
  for (const row of table) {
    const tot = row.reduce((a, b) => a + b, 0);
    if (tot === 0) continue;
    usableRows++;
    ll1 += logL(row, row.map((c) => c / tot));
  }
  const bic1 = -2 * ll1 + k * (k - 1) * Math.log(n);

  const deltaBic = bic0 - bic1;
  return {
    deltaBic: round(deltaBic, 4),
    usableRows,
    hasMemory: deltaBic >= minDeltaBic,
    rowAlpha: 1,
  };
}

/** Build the transition table from a digit stream (row = previous digit). */
export function transitionTable(digits: number[], k = PRISM_DIGITS): number[][] {
  const table: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 1; i < digits.length; i++) {
    const from = digits[i - 1]!;
    const to = digits[i]!;
    if (from >= 0 && from < k && to >= 0 && to < k) table[from]![to]! += 1;
  }
  return table;
}

// ── PROOF 3 — memorylessness of the digit's own gaps ──────────────────────────

export interface MemorylessnessTest {
  gaps: number;
  meanGap: number;
  /** Geometric MLE of the per-tick hit rate: 1 / mean gap. */
  pHat: number;
  chi2: number;
  df: number;
  pValue: number;
  /** Pooled hit hazard among gaps SHORTER than the median. */
  earlyHazard: number;
  /** Pooled hit hazard among gaps at/after the median — "does overdue help?". */
  overdueHazard: number;
  /** Bernoulli opportunities behind `overdueHazard`. */
  overdueN: number;
  /** Median inter-arrival gap — the split the hazard comparison used. */
  medianGap: number;
  /**
   * Which way the hazard moves as the digit stays absent. "flat" means the
   * renewal clock is provably useless and must be ignored.
   */
  hazardDirection: "rising" | "falling" | "flat";
  /** One-sided z for (overdueHazard − pHat) in pHat's own standard error. */
  overdueZ: number;
  /** True ⇒ the geometric fits ⇒ "overdue" is NOT evidence (gambler's fallacy). */
  memoryless: boolean;
  verdict: string;
}

/**
 * Binned χ² goodness-of-fit of the digit's inter-arrival gaps against the
 * fitted Geometric distribution, with one estimated parameter (the rate), plus
 * the empirical hazard among the longest 30% of gaps.
 *
 * The trailing (censored) gap is dropped: it has not finished, and including it
 * biases the fit toward memorylessness — the exact kind of silent convenience
 * the two predecessors perform by never testing at all.
 */
export function memorylessnessTest(digits: number[], target: number): MemorylessnessTest {
  const positions: number[] = [];
  for (let i = 0; i < digits.length; i++) if (digits[i] === target) positions.push(i);
  const gaps: number[] = [];
  for (let i = 1; i < positions.length; i++) gaps.push(positions[i]! - positions[i - 1]!);

  if (gaps.length < 12) {
    return {
      gaps: gaps.length,
      meanGap: 0,
      pHat: 1 / PRISM_DIGITS,
      chi2: 0,
      df: 0,
      pValue: 1,
      earlyHazard: 0,
      overdueHazard: 0,
      overdueN: 0,
      medianGap: 0,
      hazardDirection: "flat",
      overdueZ: 0,
      memoryless: true,
      verdict: "Too few gaps to test — dormancy is not used as evidence",
    };
  }

  const n = gaps.length;
  const meanGap = mean(gaps);
  const pHat = clamp(1 / Math.max(meanGap, 1e-6), 1e-4, 1 - 1e-4);
  const maxG = 40;

  // Gap histogram, plus its suffix sums (the number of "opportunities" at each
  // absence length L: every gap of length ≥ L is one opportunity to hit at L).
  const hist = new Array<number>(maxG + 1).fill(0);
  for (const g of gaps) if (g <= maxG) hist[g]! += 1;
  const suffix = new Array<number>(maxG + 2).fill(0);
  for (let L = maxG; L >= 1; L--) suffix[L] = suffix[L + 1]! + hist[L]!;

  // ── Binned goodness-of-fit against the fitted Geometric ────────────────────
  // Cells are pooled until each holds at least 5 EXPECTED observations. The
  // pooled tail cell's expectation comes from the probability the closed cells
  // did not cover — the first draft took it from the OBSERVED residual, which
  // put an expectation of 1 against ~12 observed gaps and produced a χ² of 150
  // on a stream whose gaps are geometric by construction.
  const observed: number[] = [];
  const expected: number[] = [];
  let cumObs = 0;
  let cumExp = 0;
  const cellExp = (g: number): number => n * pHat * Math.pow(1 - pHat, g - 1);
  for (let g = 1; g <= maxG; g++) {
    cumObs += hist[g]!;
    cumExp += cellExp(g);
    const afterNext = cumExp + cellExp(g + 1);
    if (cumExp >= 5 && (afterNext >= 5 || g === maxG)) {
      observed.push(cumObs);
      expected.push(cumExp);
      cumObs = 0;
      cumExp = 0;
    }
  }
  const pooledObs = observed.reduce((a, b) => a + b, 0);
  const pooledExp = expected.reduce((a, b) => a + b, 0);
  // Whatever the closed cells did not cover is the geometric tail.
  if (n - pooledObs > 0 || n - pooledExp > 0.5) {
    observed.push(n - pooledObs);
    expected.push(Math.max(0.5, n - pooledExp));
  }

  let chi2 = 0;
  for (let i = 0; i < observed.length; i++) {
    const e = expected[i]!;
    if (e > 0) chi2 += (observed[i]! - e) ** 2 / e;
  }
  // df = bins − 1 − 1 estimated parameter (the geometric rate).
  const df = Math.max(1, observed.length - 2);
  const pValue = chiSquarePValue(chi2, df);

  // ── Does the hazard depend on how long the digit has been absent? ──────────
  //
  // Under a Geometric every opportunity is an independent Bernoulli(pHat) trial,
  // so the pooled hazard over ANY set of absence lengths equals pHat. Splitting
  // at the median gap and comparing the pooled early hazard against the pooled
  // late hazard is therefore a like-for-like test of the exact premise dormancy
  // logic needs: "the longer it has been gone, the more likely it is now".
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  let earlyHits = 0;
  let earlyOpps = 0;
  let lateHits = 0;
  let lateOpps = 0;
  for (let L = 1; L <= maxG; L++) {
    const opps = suffix[L]!;
    if (L < median) {
      earlyHits += hist[L]!;
      earlyOpps += opps;
    } else {
      lateHits += hist[L]!;
      lateOpps += opps;
    }
  }
  const earlyHazard = earlyOpps > 0 ? earlyHits / earlyOpps : pHat;
  const lateHazard = lateOpps > 0 ? lateHits / lateOpps : pHat;
  const pooled = earlyOpps + lateOpps > 0
    ? (earlyHits + lateHits) / (earlyOpps + lateOpps)
    : pHat;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, earlyOpps) + 1 / Math.max(1, lateOpps)));
  const overdueZ = se > 0 ? (lateHazard - earlyHazard) / se : 0;

  // The flag needs the goodness-of-fit to accept the geometric AND the hazard
  // comparison not to differ strongly. 2.58σ (99%) rather than 1.96σ: a single
  // borderline crossing on an honest stream would otherwise admit dormancy
  // evidence it has not earned.
  const memoryless = pValue > 0.05 && Math.abs(overdueZ) < 2.58;
  const hazardDirection: "rising" | "falling" | "flat" = memoryless
    ? "flat"
    : overdueZ > 0 ? "rising" : "falling";
  const direction = overdueZ > 0 ? "RISING" : "FALLING";
  return {
    gaps: n,
    meanGap: round(meanGap, 4),
    pHat: round(pHat, 6),
    chi2: round(chi2, 4),
    df,
    pValue: round(pValue, 6),
    earlyHazard: round(earlyHazard, 6),
    overdueHazard: round(lateHazard, 6),
    overdueN: lateOpps,
    medianGap: median,
    hazardDirection,
    overdueZ: round(overdueZ, 4),
    memoryless,
    verdict: memoryless
      ? `Gaps fit a memoryless Geometric (χ²=${chi2.toFixed(1)}, df=${df}, p=${pValue.toFixed(2)}; late hazard ${(lateHazard * 100).toFixed(2)}% vs early ${(earlyHazard * 100).toFixed(2)}%, z=${overdueZ.toFixed(2)}) — dormancy carries NO signal and is ignored`
      : `Gap process is NOT memoryless (χ²=${chi2.toFixed(1)}, df=${df}, p=${pValue.toFixed(3)}; ${direction} hazard, late ${(lateHazard * 100).toFixed(2)}% vs early ${(earlyHazard * 100).toFixed(2)}%, z=${overdueZ.toFixed(2)}) — the empirical hazard is admitted as evidence`,
  };
}

// ── The compositional posterior (Monte Carlo over the Dirichlet) ──────────────

export interface DigitPosterior {
  digit: number;
  count: number;
  share: number;
  /** Predictive P(next digit = d) = posterior mean. */
  pMean: number;
  /** 5th percentile of p_d over the posterior — the pessimistic rate. */
  pLower: number;
  /** P(p_d > break-even | data) — the headline entry gate. */
  pClear: number;
  /** P(d is the single most over-represented digit) — the argmax bias, measured. */
  pArgmax: number;
  edgePP: number;
  evPerDollar: number;
}

export interface CompositionalPosterior {
  draws: number;
  digits: DigitPosterior[];
  best: DigitPosterior;
  hottest: number;
  /** Effective sample size of the window. */
  total: number;
}

/**
 * Monte Carlo over the Dirichlet posterior Dir(α̂ + n).
 *
 * The three quantities the selector actually needs are all posterior
 * functionals that the point estimate p̂ CANNOT supply:
 *   · pClear  = P(p_d > break-even)         — a tail probability
 *   · pLower  = the 5th percentile of p_d    — the pessimistic rate the ladder
 *                                              must survive
 *   · pArgmax = P(d is the hottest digit)    — the argmax-of-ten selection bias,
 *                                              measured instead of guessed at
 *
 * The last one is the structural fix. Both predecessors pick argmax(p̂) and then
 * pad the bar with an arbitrary margin to "absorb" the selection bias. Prism
 * computes the bias: a digit that "wins" the ranking on noise has pArgmax ≈ 0.1,
 * and that is visible before any money moves.
 */
export function compositionalPosterior(
  counts: number[],
  alpha: number,
  hurdle: number,
  opts: { draws?: number; seed?: number; evNetRate?: number } = {},
): CompositionalPosterior {
  const draws = Math.max(200, opts.draws ?? 3_000);
  const rng = mulberry32(opts.seed ?? 0x9e3779b9);
  const k = counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  const netRate = opts.evNetRate ?? MATCH_PAYOUT - 1;

  // Draw from the SAME posterior the live gate uses: mean = the Dirichlet
  // posterior mean, total strength = N + min(kα, cap). Monte Carlo and closed
  // form therefore cannot disagree about the same window.
  const { mean, strength } = prismPosterior(counts, alpha);
  const alphaVec = mean.map((m) => Math.max(1e-9, m * strength));

  const clearCount = new Array<number>(k).fill(0);
  const argmaxCount = new Array<number>(k).fill(0);
  const pSum = new Array<number>(k).fill(0);
  const samples: number[][] = Array.from({ length: k }, () => []);

  for (let d = 0; d < draws; d++) {
    let sum = 0;
    const p = new Array<number>(k).fill(0);
    for (let i = 0; i < k; i++) {
      const g = sampleGamma(alphaVec[i]!, rng);
      p[i] = g;
      sum += g;
    }
    if (!(sum > 0)) continue;
    let bestIdx = 0;
    let bestVal = -1;
    for (let i = 0; i < k; i++) {
      p[i] = p[i]! / sum;
      pSum[i]! += p[i]!;
      samples[i]!.push(p[i]!);
      if (p[i]! > bestVal) { bestVal = p[i]!; bestIdx = i; }
    }
    argmaxCount[bestIdx]! += 1;
    for (let i = 0; i < k; i++) if (p[i]! > hurdle) clearCount[i]! += 1;
  }

  const digits: DigitPosterior[] = counts.map((count, digit) => {
    const s = samples[digit]!;
    const sorted = [...s].sort((x, y) => x - y);
    const pMean = pSum[digit]! / Math.max(1, s.length);
    const pLower = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.05))] ?? pMean;
    const pClear = clearCount[digit]! / Math.max(1, s.length);
    const edge = pMean - hurdle;
    return {
      digit,
      count,
      share: total > 0 ? round(count / total, 6) : 0,
      pMean: round(pMean, 6),
      pLower: round(pLower, 6),
      pClear: round(pClear, 6),
      pArgmax: round(argmaxCount[digit]! / Math.max(1, s.length), 6),
      edgePP: round(edge * 100, 4),
      evPerDollar: round(pMean * netRate - (1 - pMean), 6),
    };
  });

  let best = digits[0]!;
  for (const d of digits) {
    if (d.pClear > best.pClear || (d.pClear === best.pClear && d.pMean > best.pMean)) best = d;
  }
  let hottest = 0;
  for (const d of digits) if (d.pArgmax > digits[hottest]!.pArgmax) hottest = d.digit;

  return { draws, digits, best, hottest, total };
}

// ── THE LADDER — exact clearance of the user's own recovery plan ──────────────

export interface PrismLadderPlan {
  baseStake: number;
  maxStake: number;
  /** Hard cap on the recovery ladder depth (the ledger's maxRecoverySteps). */
  maxSteps: number;
  stopLoss: number;
  takeProfit: number;
  payout: number;
  /** The bot's own markup on outstanding debt (settings.botRecoveryMarkup). */
  markupPercent: number;
  balance?: number;
}

export interface LadderClearance {
  pClear: number;
  pRuin: number;
  expectedShots: number;
  /** Stake the ladder opens with after the first normal loss. */
  firstRecoveryStake: number;
  /** Stake at the step where the cap first binds, and that step's index. */
  cappedAt: number;
  cappedStep: number;
  /** Deterministic stake chain of an all-losses run. */
  stakeChain: number[];
  /** The measured win rate the clearance was evaluated at. */
  pWin: number;
  /** Max consecutive losses the ladder absorbs before the stop loss. */
  depthLimit: number;
  /** Debt-recovered fraction at the capped step (1 = full recovery possible). */
  cappedRecoveryFraction: number;
}

/**
 * Exact clearance probability of the shared recovery ladder.
 *
 * State is the outstanding DEBT in cents (which, on an unfruitful run, is also
 * the money the account has lost so far in that run — so the stop loss is simply
 * the debt ceiling). The stake at every state is the SAME formula the live engine
 * executes, via `calculateBotRecoveryStake` → stake limits → whole cents:
 *
 *       normal shot ..... stake = baseStake
 *       recovery shot ... stake = min(debt·(1+markup/100)/(payout−1),
 *                                     maxStake, balance)
 *
 * Value iteration (not a backward recursion) because a WIN moves the chain to a
 * SMALLER debt while a LOSS moves it to a larger one: the dependency graph runs
 * in both directions, and iteration converges geometrically at rate pWin.
 *
 * `pClear` is the probability that the debt is fully repaid before the loss run
 * reaches the stop loss. THIS is the number that answers "will this bot give me
 * multiple losses that blow up the account?" — and it is priced before entry.
 */
export function ladderClearance(
  pWin: number,
  plan: PrismLadderPlan,
  opts: { maxStates?: number } = {},
): LadderClearance {
  const p = clamp(pWin, 1e-6, 1 - 1e-6);
  const q = 1 - p;
  const payout = plan.payout > 1 ? plan.payout : MATCH_PAYOUT;
  const markup = Math.max(0, Number.isFinite(plan.markupPercent) ? plan.markupPercent : 10);
  const maxStake = Number.isFinite(plan.maxStake) && plan.maxStake > 0
    ? plan.maxStake
    : Number.POSITIVE_INFINITY;
  const balance = Number.isFinite(plan.balance ?? Number.POSITIVE_INFINITY) && (plan.balance ?? 0) > 0
    ? plan.balance!
    : Number.POSITIVE_INFINITY;
  const stopCents = Math.max(1, toCents(Math.max(plan.stopLoss, 0.01)));
  const baseCents = Math.max(1, toCents(Math.max(plan.baseStake, 0.35)));

  // The stake at a given debt is the LIVE function, not a re-derivation: the
  // engine's recovery stake is `getBotRecoveryStake` →
  // `applyRecoveryStakeLimits(calculateBotRecoveryStake(...))`. Calling the same
  // exported helpers means the simulated ladder can never drift from the one the
  // bot actually executes.
  const stakeAt = (debtCents: number): number => {
    if (debtCents <= 0) return baseCents;
    const raw = calculateBotRecoveryStake(debtCents / 100, payout, markup);
    const limited = applyRecoveryStakeLimits(raw, maxStake, balance);
    return Math.max(1, Math.round(limited * 100));
  };

  // Adaptive grid: at most `maxStates` debt states, so a $500 stop loss costs the
  // same as a $5 one.
  const maxStates = Math.max(128, opts.maxStates ?? 2_000);
  const stepCents = Math.max(1, Math.ceil(stopCents / maxStates));
  const nStates = Math.floor(stopCents / stepCents) + 2;
  const idxOf = (cents: number): number => Math.min(nStates - 1, Math.floor(cents / stepCents));

  // f[i] = P(clear the debt | debt = i·stepCents). 0 = ruin, 1 = debt repaid.
  const f = new Float64Array(nStates);
  const e = new Float64Array(nStates);
  for (let i = 0; i < nStates; i++) {
    const debt = i * stepCents;
    if (debt >= stopCents) { f[i] = 0; e[i] = 0; continue; }
    const stake = stakeAt(debt);
    const netCents = Math.floor(stake * (payout - 1) + 1e-9);
    f[i] = debt - netCents <= 0 ? p : 0;
    e[i] = 1;
  }

  for (let iter = 0; iter < 260; iter++) {
    let delta = 0;
    for (let i = 0; i < nStates; i++) {
      const debt = i * stepCents;
      if (debt >= stopCents) { f[i] = 0; e[i] = 0; continue; }
      const stake = stakeAt(debt);
      const netCents = Math.floor(stake * (payout - 1) + 1e-9);
      const afterWin = debt - netCents;
      const winValue = afterWin <= 0 ? 1 : f[idxOf(afterWin)]!;
      const winShots = afterWin <= 0 ? 0 : e[idxOf(afterWin)]!;
      const afterLoss = debt + stake;
      const lossValue = afterLoss >= stopCents ? 0 : f[idxOf(afterLoss)]!;
      const lossShots = afterLoss >= stopCents ? 0 : e[idxOf(afterLoss)]!;
      const next = p * winValue + q * lossValue;
      const nextE = 1 + p * winShots + q * lossShots;
      if (Math.abs(next - f[i]!) > delta) delta = Math.abs(next - f[i]!);
      f[i] = next;
      e[i] = nextE;
    }
    if (delta < 1e-14) break;
  }

  // Deterministic all-losses chain: what a fresh, unlucky session actually
  // executes. It runs until the stop loss is reached, however deep that is — the
  // previous version capped the walk at `maxSteps + 6` and therefore reported a
  // depth limit that had nothing to do with the user's stop loss.
  const stakeChain: number[] = [];
  let debtCents = baseCents;
  let depthLimit = 0;
  let cappedAt = 0;
  let cappedStep = 0;
  let lastStakeCents = baseCents;
  let lastDebtBeforeCents = baseCents;
  const walkLimit = 5_000;
  for (let step = 0; step < walkLimit && debtCents < stopCents; step++) {
    const stake = stakeAt(debtCents);
    // The step is "capped" when the placed stake is SHORT of what a full
    // recovery of the outstanding debt would need — i.e. the max-stake or
    // balance limit binds. The $0.35 minimum is not a cap: it over-bets the
    // debt, which is safe for recovery.
    const fullRecoveryStakeCents = Math.ceil(
      (calculateBotRecoveryStake(debtCents / 100, payout, markup)) * 100 - 1e-9,
    );
    if (cappedStep === 0 && stake < fullRecoveryStakeCents - 1) {
      cappedAt = stake / 100;
      cappedStep = step + 1;
    }
    if (stakeChain.length < 12) stakeChain.push(round(stake / 100, 2));
    lastStakeCents = stake;
    lastDebtBeforeCents = debtCents;
    depthLimit = step + 1;
    debtCents += stake;
  }
  const cappedRecoveryFraction = lastDebtBeforeCents > 0
    ? clamp((lastStakeCents * (payout - 1)) / lastDebtBeforeCents, 0, 1)
    : 1;

  const pClear = clamp(f[0]!, 0, 1);
  return {
    pClear: round(pClear, 6),
    pRuin: round(1 - pClear, 6),
    expectedShots: round(e[0]!, 3),
    firstRecoveryStake: round((stakeChain[0] ?? 0), 2),
    cappedAt: round(cappedAt, 2),
    cappedStep,
    stakeChain,
    pWin: round(p, 6),
    depthLimit,
    cappedRecoveryFraction: round(cappedRecoveryFraction, 4),
  };
}

/**
 * Invert the ladder: the minimum TRUE win rate at which this plan clears its debt
 * with probability `targetClearance`.
 *
 * This is the honest per-market hurdle for a Matches bot. 1/payout = 11.20% is
 * only the break-even of a SINGLE bet; it says nothing about whether the user's
 * ladder survives the 89% loss rate between hits. A plan can clear 11.20% with
 * probability 0.62 and 13% with probability 0.96 — and the second number is the
 * one that decides whether "multiple losses" ever become an account event.
 */
export function requiredWinRateFor(
  plan: PrismLadderPlan,
  targetClearance: number,
  opts: { tolerance?: number; maxIterations?: number } = {},
): number {
  const tol = opts.tolerance ?? 5e-5;
  let lo = 0.001;
  let hi = 0.9;
  if (ladderClearance(hi, plan).pClear < targetClearance) return hi;
  if (ladderClearance(lo, plan).pClear >= targetClearance) return lo;
  for (let i = 0; i < (opts.maxIterations ?? 26); i++) {
    const mid = (lo + hi) / 2;
    if (ladderClearance(mid, plan).pClear >= targetClearance) hi = mid;
    else lo = mid;
    if (hi - lo < tol) break;
  }
  return round((lo + hi) / 2, 6);
}

// ── Certainty tiers ───────────────────────────────────────────────────────────

export type PrismCertainty = "elite" | "strict" | "balanced";

export interface PrismCertaintySpec {
  id: PrismCertainty;
  label: string;
  note: string;
  /** P(market is biased at all) required before any candidate is deployable. */
  minBiasedPosterior: number;
  /** Floor under the entry statistic P(p_digit > break-even | trailing window). */
  minPosteriorClear: number;
  /** The ladder must clear the debt this often, at the digit's PESSIMISTIC rate. */
  minLadderClearance: number;
  /** ΔBIC needed before the transition row may move the estimate. */
  minDeltaBic: number;
  /** Out-of-sample shots required before the rule is allowed to deploy. */
  minShots: number;
  /** Design selectivity: top-quantile of the entry statistic on the train half. */
  targetShotRate: number;
  /** Added to the entry bar per loss in the run (in posterior-probability units). */
  shieldTightening: number;
  shieldCoolTicks: number;
  /** Minimum honest entry statistic before the shield may be relaxed. */
  minSpacing: number;
  maxBarBoost: number;
}

export const PRISM_CERTAINTY: Record<PrismCertainty, PrismCertaintySpec> = {
  elite: {
    id: "elite",
    label: "Elite",
    note: "Only trades a market whose bias is proven beyond doubt, at a rate the ladder clears almost surely. Very few shots.",
    minBiasedPosterior: 0.97,
    minPosteriorClear: 0.99,
    minLadderClearance: 0.97,
    minDeltaBic: 20,
    minShots: 14,
    targetShotRate: 0.004,
    shieldTightening: 0.004,
    shieldCoolTicks: 12,
    minSpacing: 14,
    maxBarBoost: 0.03,
  },
  strict: {
    id: "strict",
    label: "Strict",
    note: "The default. Requires proven bias, a proven ladder, and a measurable out-of-sample record before it deploys.",
    minBiasedPosterior: 0.93,
    minPosteriorClear: 0.97,
    minLadderClearance: 0.95,
    minDeltaBic: 12,
    minShots: 18,
    targetShotRate: 0.008,
    shieldTightening: 0.003,
    shieldCoolTicks: 10,
    minSpacing: 10,
    maxBarBoost: 0.025,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    note: "More shots, looser bars. Still refuses any market it cannot prove is biased, and still prices the ladder first.",
    minBiasedPosterior: 0.85,
    minPosteriorClear: 0.93,
    minLadderClearance: 0.9,
    minDeltaBic: 6,
    minShots: 24,
    targetShotRate: 0.015,
    shieldTightening: 0.002,
    shieldCoolTicks: 6,
    minSpacing: 7,
    maxBarBoost: 0.02,
  },
};

export function prismCertaintySpec(id?: string): PrismCertaintySpec {
  if (id && (id === "elite" || id === "strict" || id === "balanced")) {
    return PRISM_CERTAINTY[id];
  }
  return PRISM_CERTAINTY.strict;
}

// ── Live estimate (closed form — the hot loop never runs Monte Carlo) ─────────

export interface PrismLiveEstimate {
  digit: number;
  /** Blended predictive rate. */
  p: number;
  /** Exact posterior tail P(p_digit ≤ break-even) complement — the gate statistic. */
  pClear: number;
  /** Lower credible bound of the true rate (10th percentile). */
  pLower: number;
  sigma: number;
  hurdle: number;
  zBe: number;
  /** Weight the transition row was allowed to carry (0 when memoryless). */
  memoryWeight: number;
  /** Effective observations behind the estimate. */
  nEff: number;
  /** True when the renewal clock was admitted as evidence. */
  renewalAdmitted: boolean;
  gap: number;
}

/**
 * The entry statistic. Closed form, O(window) at most, no Monte Carlo.
 *
 * p is the conjugate blend of the compositional marginal (Dirichlet posterior
 * mean) and, ONLY when the Markov order test proved memory, the transition row
 * posterior — weighted by that row's own evidence, so a thin row shrinks back to
 * the marginal automatically.
 *
 * pClear is then exact: 1 − I_hurdle(α, β) with the blended rate's Beta
 * posterior. At the 10% rates Matches lives at, the normal approximation both
 * predecessors rely on is off by a factor of ~2 in the tail that decides entry.
 */
export function liveEstimate(input: {
  counts: number[];
  alpha: number;
  hurdle: number;
  lastDigit: number | null;
  transitionRow: number[] | null;
  transitionHasMemory: boolean;
  /** Effective window size (trailing ticks actually used). */
  window: number;
  /**
   * Whether to solve for the lower credible bound. The bisection costs ~50
   * incomplete-beta evaluations, and the live statistic only needs `pClear`, so
   * this is off unless a caller actually displays the pessimistic rate. Keeping
   * it off is what makes the 4,999-tick walk-forward fast.
   */
  withLower?: boolean;
}): PrismLiveEstimate {
  const { counts, alpha, hurdle, lastDigit, transitionRow, transitionHasMemory, window } = input;
  const k = counts.length;
  const n = Math.max(1, window);
  const a = Math.max(1e-6, alpha);
  const total = counts.reduce((x, y) => x + y, 0);

  // Marginal posterior mean of each digit's rate.
  const marginalDenom = k * a + total;
  const marginal = counts.map((c) => (a + c) / marginalDenom);

  // Row-level posterior, shrunk toward the marginal when the chain is thin or
  // unproven. `rowEvidence` is the exact conjugate weight n_row/(n_row + k·α).
  let memoryWeight = 0;
  let blended = marginal;
  if (transitionHasMemory && transitionRow && lastDigit !== null) {
    const rowTotal = transitionRow.reduce((x, y) => x + y, 0);
    memoryWeight = rowTotal > 0 ? rowTotal / (rowTotal + k * a) : 0;
    const rowDenom = k * a + rowTotal;
    blended = counts.map((_, i) => {
      const rowP = (a + (transitionRow[i] ?? 0)) / rowDenom;
      return memoryWeight * rowP + (1 - memoryWeight) * marginal[i]!;
    });
  }

  let digit = 0;
  for (let i = 1; i < k; i++) {
    if (blended[i]! > blended[digit]!) digit = i;
  }
  const p = clamp(blended[digit]!, 1e-9, 1 - 1e-9);

  // Beta posterior of this digit's rate, on the SAME width convention as the
  // scan: the window's observations plus at most 200 pseudo-observations of
  // prior. (`prismPosterior` owns that rule so the two paths cannot drift.)
  const priorStrength = prismPriorStrength(a, k);
  const alphaPost = Math.max(1e-9, p * (n + priorStrength));
  const betaPost = Math.max(1e-9, (1 - p) * (n + priorStrength));
  const pBelow = regularizedIncompleteBeta(clamp(hurdle, 1e-9, 1 - 1e-9), alphaPost, betaPost);
  const pClear = clamp(1 - pBelow, 0, 1);
  const pLower = input.withLower ? betaPosteriorQuantile(0.1, alphaPost, betaPost) : 0;
  const sum = alphaPost + betaPost;
  const sigma = Math.sqrt((alphaPost * betaPost) / (sum * sum * (sum + 1)));
  const zBe = sigma > 0 ? (p - hurdle) / sigma : 0;

  return {
    digit,
    p: round(p, 6),
    pClear: round(pClear, 6),
    pLower: round(pLower, 6),
    sigma: round(sigma, 6),
    hurdle: round(hurdle, 6),
    zBe: round(zBe, 4),
    memoryWeight: round(memoryWeight, 4),
    nEff: round(priorStrength + n, 2),
    renewalAdmitted: false,
    gap: 0,
  };
}

/** Exact Beta quantile by bisection (48 steps ≈ 2× double precision on [0,1]). */
export function betaPosteriorQuantile(q: number, alpha: number, beta: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(mid, alpha, beta) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface ClosedFormReading {
  pMean: number;
  pClear: number;
  pLower: number;
  edgePP: number;
}

/**
 * The Monte-Carlo-free reading of one digit — the SCAN's cheap first pass.
 *
 * The Dirichlet posterior mean and the exact tail probability P(p_d > break-even)
 * are both closed form, so a market can be screened without drawing a single
 * sample. Monte Carlo is then spent only where it changes a decision: on the
 * handful of candidates that survive this screen.
 */
export function digitReadingClosedForm(
  counts: number[],
  alpha: number,
  hurdle: number,
  digit: number,
  _total: number,
  withLower = true,
): ClosedFormReading {
  const beta = digitBeta(counts, alpha, digit);
  const pClear = clamp(
    1 - regularizedIncompleteBeta(clamp(hurdle, 1e-9, 1 - 1e-9), beta.alphaPost, beta.betaPost),
    0,
    1,
  );
  return {
    pMean: round(beta.pMean, 6),
    pClear: round(pClear, 6),
    pLower: withLower ? round(betaPosteriorQuantile(0.1, beta.alphaPost, beta.betaPost), 6) : 0,
    edgePP: round((beta.pMean - hurdle) * 100, 4),
  };
}

// ── Timing — Prism waits only for reasons it can prove ────────────────────────

export interface PrismTiming {
  ready: boolean;
  reason: string;
  feedFresh: boolean;
  spaced: boolean;
  renewalOk: boolean;
  /** Which side of the renewal clock the entry is on, for the console. */
  renewalMode: "ignored" | "wait-for-overdue" | "enter-while-fresh";
}

/**
 * Three gates, and a deliberate refusal to invent a fourth.
 *
 *   1. FEED FRESHNESS — a stale tick is not a market observation, it is a
 *      network artefact. Entering on one is trading the outage.
 *   2. SPACING — a floor between shots so the ladder cannot ratchet into a
 *      burst. Prism loses ~89% of shots; the only thing worse than losing one
 *      is losing four in the time it takes to think.
 *   3. RENEWAL — ONLY when PROOF 3 rejected the geometric, and then in the
 *      direction the hazard actually moves. This is where Prism leaves both
 *      predecessors behind: they only ever bet on "overdue", which is a fallacy
 *      on a memoryless stream and the WRONG side on a stream whose hazard falls
 *      (a clustered digit is most likely right after it has just appeared).
 */
export function prismTiming(input: {
  gap: number;
  ticksSinceLastShot: number;
  minSpacing: number;
  secondsSinceLastTick: number;
  medianTickGapSeconds: number;
  memoryless: boolean;
  hazardDirection: "rising" | "falling" | "flat";
  medianGap: number;
}): PrismTiming {
  const feedFresh = input.secondsSinceLastTick <= Math.max(4, input.medianTickGapSeconds * 3);
  const spaced = input.ticksSinceLastShot >= input.minSpacing;

  let renewalOk = true;
  let renewalMode: PrismTiming["renewalMode"] = "ignored";
  if (!input.memoryless && input.hazardDirection === "rising") {
    renewalMode = "wait-for-overdue";
    renewalOk = input.medianGap <= 0 || input.gap >= input.medianGap;
  } else if (!input.memoryless && input.hazardDirection === "falling") {
    renewalMode = "enter-while-fresh";
    renewalOk = input.medianGap <= 0 || input.gap < input.medianGap;
  }

  const ready = feedFresh && spaced && renewalOk;
  const reason = !feedFresh
    ? "waiting for a fresh tick — the feed is lagging"
    : !spaced
      ? `spacing ${input.ticksSinceLastShot}/${input.minSpacing} ticks since the last shot`
      : !renewalOk
        ? renewalMode === "wait-for-overdue"
          ? `the proven renewal clock wants this digit at ${input.medianGap}+ ticks of dormancy (now ${input.gap})`
          : `the proven renewal clock wants this digit FRESH — it clusters (now ${input.gap} ticks old)`
        : "all timing gates clear";
  return { ready, reason, feedFresh, spaced, renewalOk, renewalMode };
}

// ── Walk-forward (fit on the first half, measure on the second) ───────────────

export interface PrismShot {
  index: number;
  digit: number;
  /** Entry statistic at the moment of the shot. */
  pClear: number;
  p: number;
  won: boolean;
}

export interface PrismWalkForward {
  train: { n: number; fits: Record<string, number> };
  test: {
    n: number;
    shots: PrismShot[];
    nShots: number;
    winRate: number;
    /** Wilson lower bound of the out-of-sample win rate. */
    winRateLower: number;
    requiredFor: number;
    breakEven: number;
    beatBreakEven: boolean;
  };
  inSampleWinRate: number;
  /** Entry threshold fitted on the train half, then FROZEN for the test half. */
  tau: number;
  /** Selectivity actually achieved out of sample. */
  shotRate: number;
  shield: {
    /** Loss pairs (LL) before and after the simulated shield. */
    pairsBefore: number;
    pairsAfter: number;
    shotsCost: number;
    /** Deepest simulated consecutive-loss run with the shield on. */
    deepestRun: number;
  };
  /** P(ladder clears) at the out-of-sample LOWER bound — the pessimistic case. */
  ladderClearPessimistic: number;
  ladderAtMeasured: LadderClearance;
  evidence: number;
  brierSkill: number;
}

/**
 * The measurement that gates deployment.
 *
 * Ticks are split 50/50. The FIRST half fits the concentration, the transition
 * test, the calibration and the entry threshold τ. The SECOND half is then
 * replayed with that frozen rule and only its shots are reported as the bot's
 * record. In-sample accuracy is printed next to it so over-fitting is visible
 * instead of hidden — the same disclosure discipline as the Kill-Shot Oracle,
 * applied to the compositional model rather than to a lambda-weighted ensemble.
 */
export function walkForwardPrism(input: {
  digits: number[];
  hurdle: number;
  spec: PrismCertaintySpec;
  plan: PrismLadderPlan;
  /** The plan's required win rate (`requiredWinRateFor`) — supplied by the scan. */
  requiredWinRate?: number;
  /** Trailing window used by the live statistic during the replay. */
  liveWindow?: number;
}): PrismWalkForward {
  const { digits, hurdle, spec, plan } = input;
  const liveWindow = Math.max(200, input.liveWindow ?? PRISM_LIVE_WINDOW);
  const half = Math.floor(digits.length / 2);
  const trainDigits = digits.slice(0, half);
  const testDigits = digits.slice(half);

  // ── Fit on the train half ────────────────────────────────────────────────
  const trainFit = compositionalFit(countDigits(trainDigits));
  const trainTable = transitionTable(trainDigits);
  const markov = markovOrderTest(trainTable, spec.minDeltaBic);

  // ONE pass over the train half yields both the statistic distribution (which
  // sets τ as its own top-q quantile, so the design shot rate is honoured in any
  // regime) and the score/outcome pairs the calibration is fitted on.
  const trainStats: number[] = [];
  const trainScores: number[] = [];
  const trainOutcomes: number[] = [];
  replayPass({
    digits: trainDigits,
    alpha: trainFit.alphaHat,
    hurdle,
    window: liveWindow,
    hasMemory: markov.hasMemory,
    table: trainTable,
    onTick: (est, _i, _rolling, actual) => {
      trainStats.push(est.pClear);
      trainScores.push(est.pClear);
      trainOutcomes.push(est.digit === actual ? 1 : 0);
    },
  });
  const inSampleWinRate = mean(trainOutcomes);

  const sortedStats = [...trainStats].sort((a, b) => a - b);
  const qIdx = Math.min(
    sortedStats.length - 1,
    Math.max(0, Math.floor((1 - spec.targetShotRate) * sortedStats.length)),
  );
  // Self-referential quantile AND a hard economic floor: the design shot rate is
  // a knob, but it can never push the bar below the posterior probability the
  // certainty tier demands.
  const tau = Math.max(spec.minPosteriorClear, sortedStats[qIdx] ?? spec.minPosteriorClear);

  // ── Replay the FROZEN rule on the held-out half ──────────────────────────
  const shots: PrismShot[] = [];
  let ticksSinceLastShot = Number.POSITIVE_INFINITY;
  let ticksSinceLoss = Number.POSITIVE_INFINITY;
  let lossRun = 0;
  let shieldPairsBefore = 0;
  let shieldPairsAfter = 0;
  let deepestRun = 0;
  let prevLost = false;
  let prevLostShield = false;

  replayPass({
    digits: testDigits,
    alpha: trainFit.alphaHat,
    hurdle,
    window: liveWindow,
    hasMemory: markov.hasMemory,
    table: trainTable,
    onTick: (est, _i, _rolling, actual) => {
      if (Number.isFinite(ticksSinceLastShot)) ticksSinceLastShot++;
      if (Number.isFinite(ticksSinceLoss)) ticksSinceLoss++;

      // The post-loss shield: after each loss the bar rises and a cool-down
      // ticks. It is SIMULATED here, so the console can report what it cost
      // rather than promising it works.
      const bar = Math.min(
        spec.minPosteriorClear + spec.maxBarBoost,
        tau + spec.shieldTightening * (lossRun + 1),
      );
      const cooled = ticksSinceLoss >= spec.shieldCoolTicks;
      const spaced = ticksSinceLastShot >= spec.minSpacing;

      // Loss-pair accounting on the SAME tape, shield off — the counterfactual.
      if (est.pClear >= tau && spaced) {
        const won = est.digit === actual;
        shieldPairsBefore += prevLost && !won ? 1 : 0;
        prevLost = !won;
      }

      if (est.pClear >= bar && spaced && cooled) {
        const won = est.digit === actual;
        shots.push({ index: 0, digit: est.digit, pClear: est.pClear, p: est.p, won });
        shieldPairsAfter += prevLostShield && !won ? 1 : 0;
        prevLostShield = !won;
        ticksSinceLastShot = 0;
        ticksSinceLoss = 0;
        if (won) {
          lossRun = 0;
        } else {
          lossRun++;
          deepestRun = Math.max(deepestRun, lossRun);
        }
      }
    },
  });

  const nShots = shots.length;
  const wins = shots.filter((s) => s.won).length;
  const winRate = nShots > 0 ? wins / nShots : 0;
  const winRateLower = wilsonLowerBound(wins, nShots);
  const ladderAtMeasured = ladderClearance(winRate, plan);
  const ladderClearPessimistic = ladderClearance(winRateLower, plan).pClear;
  const firedWithoutShield = shieldPairsBefore;
  const firedWithShield = shieldPairsAfter;

  return {
    train: {
      n: trainDigits.length,
      fits: {
        alphaHat: trainFit.alphaHat,
        pBiased: trainFit.pBiased,
        deltaBic: markov.deltaBic,
        hasMemory: markov.hasMemory ? 1 : 0,
        inSampleRate: round(inSampleWinRate, 4),
      },
    },
    test: {
      n: testDigits.length,
      shots: shots.map((s, i) => ({ ...s, index: i })),
      nShots,
      winRate: round(winRate, 6),
      winRateLower: round(winRateLower, 6),
      requiredFor: round(input.requiredWinRate ?? 0, 6),
      breakEven: round(hurdle, 6),
      beatBreakEven: winRateLower > hurdle,
    },
    inSampleWinRate: round(inSampleWinRate, 6),
    tau: round(tau, 6),
    shotRate: testDigits.length > 0 ? round(nShots / testDigits.length, 6) : 0,
    shield: {
      pairsBefore: firedWithoutShield,
      pairsAfter: firedWithShield,
      // Shots the shield cost, as a fraction of the shots the unshielded rule
      // would have taken on the same tape.
      shotsCost: round(
        clamp(1 - nShots / Math.max(1, nShots + Math.max(0, firedWithoutShield - firedWithShield)), 0, 1),
        4,
      ),
      deepestRun,
    },
    ladderClearPessimistic: round(ladderClearPessimistic, 6),
    ladderAtMeasured,
    evidence: shots.length,
    brierSkill: round(brierSkill(trainScores, trainOutcomes), 6),
  };
}

/**
 * ONE streaming pass over a digit tape with the live statistic, a rolling count
 * array, and a caller-supplied callback. Used for both halves of the
 * walk-forward, so `train` and `test` can never drift into two different
 * implementations of the same rule — the classic way a backtest lies.
 */
function replayPass(input: {
  digits: number[];
  alpha: number;
  hurdle: number;
  window: number;
  hasMemory: boolean;
  table: number[][];
  /** Called per tick with the live reading and the digit that actually printed. */
  onTick: (est: PrismLiveEstimate, index: number, rolling: number[], actual: number) => void;
  /** Ticks skipped before the statistic is considered warm. */
  warmup?: number;
}): void {
  const warmup = input.warmup ?? 200;
  const rolling = new Array<number>(PRISM_DIGITS).fill(0);
  for (let i = 0; i < input.digits.length; i++) {
    const actual = input.digits[i]!;
    if (i >= input.window) {
      const drop = input.digits[i - input.window];
      if (drop !== undefined) rolling[drop]! -= 1;
    }
    rolling[actual]! += 1;
    if (i < warmup) continue;
    const lastDigit = input.digits[i - 1] ?? null;
    const est = liveEstimate({
      counts: rolling,
      alpha: input.alpha,
      hurdle: input.hurdle,
      lastDigit,
      transitionRow: input.hasMemory && lastDigit !== null ? (input.table[lastDigit] ?? null) : null,
      transitionHasMemory: input.hasMemory,
      window: Math.min(i, input.window),
    });
    input.onTick(est, i, rolling, actual);
  }
}

function countDigits(digits: number[], k = PRISM_DIGITS): number[] {
  const counts = new Array<number>(k).fill(0);
  for (const d of digits) if (d >= 0 && d < k) counts[d]! += 1;
  return counts;
}

/** Wilson score lower bound — exact enough at the shot counts Prism produces. */
export function wilsonLowerBound(hits: number, n: number, z = 1.645): number {
  if (n <= 0) return 0;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return clamp((centre - spread) / denom, 0, 1);
}

/** One-step-ahead Brier skill of the live statistic against the base rate. */
function brierSkill(scores: number[], outcomes: number[]): number {
  const n = Math.min(scores.length, outcomes.length);
  if (n < 30) return 0;
  const base = mean(outcomes.slice(0, n));
  let model = 0;
  let reference = 0;
  for (let i = 0; i < n; i++) {
    // The statistic is a probability of EXCEEDING the hurdle, not of winning, so
    // it is compared on its own scale via the fitted base rate.
    const pred = clamp(base + (scores[i]! - 0.5) * 0.1, 1e-6, 1 - 1e-6);
    model += (pred - outcomes[i]!) ** 2;
    reference += (base - outcomes[i]!) ** 2;
  }
  if (reference <= 0) return 0;
  return 1 - model / reference;
}

/** The rolling entry statistic over an entire stream (used to fit τ). */

// ── Candidate evaluation & ranking ────────────────────────────────────────────

export type PrismVerdict = "certified" | "qualified" | "watch" | "refused";

export interface PrismCandidate {
  symbol: string;
  displayName: string;
  digit: number;
  verdict: PrismVerdict;
  confidence: number;
  deployable: boolean;
  /** Why the verdict landed where it did, in one sentence. */
  reason: string;
  /** Reasons the candidate fell short, one per failed gate. */
  failReasons: string[];
  breakEven: number;
  payout: number;
  // ── proof 1 ──
  pBiased: number;
  bayesFactor: number;
  chi2P: number;
  alphaHat: number;
  // ── proof 2 ──
  deltaBic: number;
  hasMemory: boolean;
  // ── proof 3 ──
  memoryless: boolean;
  memoryVerdict: string;
  // ── posterior ──
  pMean: number;
  pLower: number;
  pClear: number;
  pArgmax: number;
  edgePerShot: number;
  edgePerDollar: number;
  /** Exact binomial tail used for the Benjamini–Hochberg family test. */
  fdrP: number;
  fdrSurvives: boolean;
  // ── ladder ──
  ladderClear: number;
  ladderClearPessimistic: number;
  requiredWinRate: number;
  ladderDepth: number;
  // ── out of sample ──
  oosShots: number;
  oosWinRate: number;
  oosWinRateLower: number;
  inSampleWinRate: number;
  tau: number;
  evidence: number;
  /** Composite score used for ranking; higher is better. */
  score: number;
}

export interface PrismEvalOptions {
  certainty: PrismCertainty;
  plan: PrismLadderPlan;
  /** Required ladder clearance for THIS plan (computed once per scan). */
  requiredWinRate: number;
}

export interface PrismPreScreen {
  symbol: string;
  displayName: string;
  digit: number;
  pBiased: number;
  alphaHat: number;
  pMean: number;
  pClear: number;
  pLower: number;
  edgePP: number;
  /** Exact binomial tail of the train-half count — the BH family p-value. */
  fdrP: number;
  /** Cheap ranking key; only the top candidates pay for Monte Carlo. */
  score: number;
}

/**
 * The scan's cheap first pass over every (market × digit) candidate.
 *
 * No Monte Carlo, no walk-forward, no ladder DP — a compositional fit, an exact
 * tail probability and a binomial p-value. This is what makes a 190-candidate
 * scan finish in seconds instead of minutes: the expensive estimators are spent
 * only on candidates this screen says are worth measuring properly.
 */
export function preScreenPrismCandidates(input: {
  markets: Array<{ symbol: string; displayName: string; digits: number[] }>;
  plan: PrismLadderPlan;
  certainty: PrismCertainty;
}): { screened: PrismPreScreen[]; historyDepth: number; alphaHat: number; pBiasedMax: number } {
  const spec = prismCertaintySpec(input.certainty);
  const hurdle = 1 / MATCH_PAYOUT;
  const out: PrismPreScreen[] = [];
  let historyDepth = 0;
  let alphaAcc = 0;
  let alphaN = 0;
  let pBiasedMax = 0;

  for (const market of input.markets) {
    const digits = market.digits;
    historyDepth = Math.max(historyDepth, digits.length);
    if (digits.length < PRISM_MIN_HISTORY) continue;

    const counts = countDigits(digits);
    const fit = compositionalFit(counts);
    alphaAcc += fit.alphaHat;
    alphaN++;
    pBiasedMax = Math.max(pBiasedMax, fit.pBiased);

    const half = Math.floor(digits.length / 2);
    const trainCounts = countDigits(digits.slice(0, half));
    const nTrain = trainCounts.reduce((a, b) => a + b, 0);

    for (let digit = 0; digit < PRISM_DIGITS; digit++) {
      const reading = digitReadingClosedForm(counts, fit.alphaHat, hurdle, digit, fit.total, true);
      const fdrP = binomialUpperTail(trainCounts[digit]!, nTrain, PRISM_DIGITS / 100);
      // Ranking key: proven bias × posterior tail × how far below break-even the
      // pessimistic rate sits. Deliberately monotone in pClear so the refined set
      // is the set that could plausibly pass the real gate.
      const score =
        fit.pBiased * reading.pClear * Math.max(0.0001, reading.pLower / hurdle) +
        Math.max(0, reading.pClear - spec.minPosteriorClear * 0.5) * 0.5;
      out.push({
        symbol: market.symbol,
        displayName: market.displayName,
        digit,
        pBiased: fit.pBiased,
        alphaHat: fit.alphaHat,
        pMean: reading.pMean,
        pClear: reading.pClear,
        pLower: reading.pLower,
        edgePP: reading.edgePP,
        fdrP,
        score: round(score, 6),
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return {
    screened: out,
    historyDepth,
    alphaHat: alphaN > 0 ? round(alphaAcc / alphaN, 4) : 1,
    pBiasedMax: round(pBiasedMax, 6),
  };
}

/**
 * Score ONE (market, digit) candidate against every gate.
 *
 * Returns null only when the history is too short to be worth evaluating; every
 * other shortcoming is reported with a verdict and a reason, so the console can
 * always show the user the best market available and exactly why it fell short.
 */
export function evaluatePrismCandidate(
  symbol: string,
  displayName: string,
  digits: number[],
  digit: number,
  opts: PrismEvalOptions,
): PrismCandidate | null {
  if (digits.length < PRISM_MIN_HISTORY) return null;
  const spec = prismCertaintySpec(opts.certainty);
  const payout = MATCH_PAYOUT;
  const hurdle = 1 / payout;

  const fit = compositionalFit(countDigits(digits));
  const table = transitionTable(digits);
  const markov = markovOrderTest(table, spec.minDeltaBic);
  const gapTest = memorylessnessTest(digits, digit);
  const post = compositionalPosterior(fit.counts, fit.alphaHat, hurdle, {
    draws: 2_400,
    seed: 0x51ed + digit * 7919,
    evNetRate: payout - 1,
  });
  const reading = post.digits[digit]!;

  const walk = walkForwardPrism({
    digits,
    hurdle,
    spec,
    plan: opts.plan,
    requiredWinRate: opts.requiredWinRate,
  });
  const ladderAtMeasured = ladderClearance(reading.pMean, opts.plan);
  const ladderAtPessimistic = ladderClearance(reading.pLower, opts.plan);

  // The FDR p-value for THIS digit: the exact binomial tail of observing at
  // least this many hits under the fair 10% rate. BH runs across every candidate
  // in the scan, so argmax-of-190 selection bias is corrected for real.
  const trainCounts = countDigits(digits.slice(0, Math.floor(digits.length / 2)));
  const nTrain = trainCounts.reduce((a, b) => a + b, 0);
  const fdrP = binomialUpperTail(trainCounts[digit]!, nTrain, PRISM_DIGITS / 100);

  // ── Gates ────────────────────────────────────────────────────────────────
  //
  // The ladder gate is expressed as a RATE REQUIREMENT, not just a clearance
  // probability, because that is the number that makes "multiple losses" a
  // decision instead of a surprise: a $5 stop loss needs a 23.8% digit to clear
  // 95% of the time, which no Matches market on earth offers, so the bot says so
  // instead of quietly entering a ladder that cannot be recovered. A generous
  // stop loss drops the requirement below break-even, and then break-even itself
  // is the binding gate.
  const effectiveRequiredRate = Math.max(opts.requiredWinRate, hurdle);
  const failReasons: string[] = [];
  if (fit.pBiased < spec.minBiasedPosterior) {
    failReasons.push(
      `market is not proven biased — P(biased)=${(fit.pBiased * 100).toFixed(1)}% < ${(spec.minBiasedPosterior * 100).toFixed(0)}% (BF=${fit.bayesFactor.toFixed(2)})`,
    );
  }
  if (reading.pClear < spec.minPosteriorClear) {
    failReasons.push(
      `P(rate > break-even)=${(reading.pClear * 100).toFixed(2)}% < ${(spec.minPosteriorClear * 100).toFixed(0)}%`,
    );
  }
  if (reading.pLower < effectiveRequiredRate) {
    failReasons.push(
      `the pessimistic rate ${(reading.pLower * 100).toFixed(2)}% is below the ${(effectiveRequiredRate * 100).toFixed(2)}% this ladder needs ` +
      `(stop loss $${opts.plan.stopLoss.toFixed(2)} absorbs ${ladderAtPessimistic.depthLimit} consecutive losses) — widen the stop loss or lower the base stake`,
    );
  }
  if (ladderAtPessimistic.pClear < spec.minLadderClearance) {
    failReasons.push(
      `ladder clears only ${(ladderAtPessimistic.pClear * 100).toFixed(1)}% at the pessimistic rate (needs ${(spec.minLadderClearance * 100).toFixed(0)}%)`,
    );
  }
  if (walk.test.nShots < spec.minShots) {
    failReasons.push(`only ${walk.test.nShots} out-of-sample shots (needs ${spec.minShots})`);
  }
  if (walk.test.winRateLower <= hurdle && walk.test.nShots >= spec.minShots) {
    failReasons.push(
      `out-of-sample win rate ${(walk.test.winRate * 100).toFixed(1)}% does not clear break-even ${(hurdle * 100).toFixed(2)}% (LCB ${(walk.test.winRateLower * 100).toFixed(1)}%)`,
    );
  }

  const deployable = failReasons.length === 0;
  const verdict: PrismVerdict = deployable
    ? (reading.pClear >= spec.minPosteriorClear + 0.015 && fit.pBiased >= Math.min(0.999, spec.minBiasedPosterior + 0.04)
        ? "certified"
        : "qualified")
    : (fit.pBiased >= spec.minBiasedPosterior * 0.5 || reading.pClear >= spec.minPosteriorClear * 0.5
        ? "watch"
        : "refused");

  const edgePerShot = reading.pMean - hurdle;
  const confidence = composeConfidence({
    pBiased: fit.pBiased,
    pClear: reading.pClear,
    ladderPessimistic: ladderAtPessimistic.pClear,
    oosWinRate: walk.test.winRate,
    oosWinLower: walk.test.winRateLower,
    hurdle,
    oosShots: walk.test.nShots,
    spec,
    memoryless: gapTest.memoryless,
    deltaBic: markov.deltaBic,
  });
  const score = round(confidence / 100 * Math.max(0, 1 + edgePerShot * 40), 6);

  const reason = deployable
    ? `${displayName} · digit ${digit} — market proven biased (P=${(fit.pBiased * 100).toFixed(1)}%), ` +
      `out-of-sample ${(walk.test.winRate * 100).toFixed(1)}% over ${walk.test.nShots} shots ` +
      `(break-even ${(hurdle * 100).toFixed(2)}%), ladder clears ${(ladderAtPessimistic.pClear * 100).toFixed(1)}% at the pessimistic rate.`
    : `No digit cleared every gate on ${displayName} — best was digit ${digit}: ${failReasons[0]}`;

  return {
    symbol,
    displayName,
    digit,
    verdict,
    confidence,
    deployable,
    reason,
    failReasons,
    breakEven: round(hurdle, 6),
    payout,
    pBiased: fit.pBiased,
    bayesFactor: fit.bayesFactor,
    chi2P: fit.chi2P,
    alphaHat: fit.alphaHat,
    deltaBic: markov.deltaBic,
    hasMemory: markov.hasMemory,
    memoryless: gapTest.memoryless,
    memoryVerdict: gapTest.verdict,
    pMean: reading.pMean,
    pLower: reading.pLower,
    pClear: reading.pClear,
    pArgmax: reading.pArgmax,
    edgePerShot: round(edgePerShot, 6),
    edgePerDollar: reading.evPerDollar,
    fdrP,
    fdrSurvives: false,
    ladderClear: ladderAtMeasured.pClear,
    ladderClearPessimistic: ladderAtPessimistic.pClear,
    requiredWinRate: opts.requiredWinRate,
    ladderDepth: ladderAtMeasured.depthLimit,
    oosShots: walk.test.nShots,
    oosWinRate: walk.test.winRate,
    oosWinRateLower: walk.test.winRateLower,
    inSampleWinRate: walk.inSampleWinRate,
    tau: walk.tau,
    evidence: walk.evidence,
    score,
  };
}

function composeConfidence(input: {
  pBiased: number;
  pClear: number;
  ladderPessimistic: number;
  oosWinRate: number;
  oosWinLower: number;
  hurdle: number;
  oosShots: number;
  spec: PrismCertaintySpec;
  memoryless: boolean;
  deltaBic: number;
}): number {
  const clarity = clamp((input.oosWinRate - input.hurdle) / 0.05, 0, 1);
  const lower = clamp((input.oosWinLower - input.hurdle) / 0.05, 0, 1);
  const shots = clamp(input.oosShots / Math.max(1, input.spec.minShots * 2), 0, 1);
  const raw =
    0.26 * input.pBiased +
    0.22 * input.pClear +
    0.18 * input.ladderPessimistic +
    0.14 * clarity +
    0.12 * lower +
    0.08 * shots;
  return Math.round(clamp(raw, 0, 1) * 100);
}

/**
 * Benjamini–Hochberg across the whole candidate family (markets × digits).
 *
 * The two predecessors correct per-digit or per-20-candidate families. Prism's
 * family is every digit of every market scanned — up to 190 hypotheses — because
 * that is the selection the user actually performs when they read the ranking.
 */
export function screenPrismCandidates(
  candidates: PrismCandidate[],
  q = 0.1,
): PrismCandidate[] {
  const flags = benjaminiHochberg(candidates.map((c) => c.fdrP), q);
  const marked = candidates.map((c, i) => ({ ...c, fdrSurvives: flags[i] === true }));
  return marked.sort((a, b) => {
    if (a.deployable !== b.deployable) return a.deployable ? -1 : 1;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.score !== a.score) return b.score - a.score;
    return b.edgePerShot - a.edgePerShot;
  });
}

// ── Live entry (the hot path) ─────────────────────────────────────────────────

export interface PrismLiveEntry {
  ready: boolean;
  digit: number;
  p: number;
  pClear: number;
  bar: number;
  reason: string;
  memoryWeight: number;
  /** True when the held digit was kept under hysteresis despite a slightly better rival. */
  held: boolean;
}

/**
 * The gate the live loop executes. Closed form, deterministic, and it re-runs on
 * the execution tick — the same numbers the scan measured, never a second opinion.
 */
export function evaluatePrismLiveEntry(input: {
  counts: number[];
  alpha: number;
  hurdle: number;
  digits: number[];
  lastDigit: number | null;
  transitionRow: number[] | null;
  hasMemory: boolean;
  window: number;
  /** Fitted threshold from the model card. */
  tau: number;
  /** Shield already added by the caller (from the loss run). */
  barBoost: number;
  /** Digit currently held — hysteresis keeps it unless clearly beaten. */
  heldDigit: number | null;
  hysteresis?: number;
}): PrismLiveEntry {
  const est = liveEstimate({
    counts: input.counts,
    alpha: input.alpha,
    hurdle: input.hurdle,
    lastDigit: input.lastDigit,
    transitionRow: input.transitionRow,
    transitionHasMemory: input.hasMemory,
    window: input.window,
  });
  const bar = clamp(input.tau + Math.max(0, input.barBoost), 0, 1);

  let digit = est.digit;
  let p = est.p;
  let pClear = est.pClear;
  let held = false;
  const hysteresis = input.hysteresis ?? 0.02;

  if (input.heldDigit !== null && input.heldDigit !== digit) {
    // Hysteresis: keep the held digit unless a rival is BETTER by more than the
    // margin, in the same posterior-probability units the gate uses. Without
    // this the bot re-picks a new digit every time the ranking crosses on noise,
    // which is how a "hot digit" strategy turns into a random digit strategy.
    const a = Math.max(1e-6, input.alpha);
    const k = input.counts.length;
    const total = input.counts.reduce((x, y) => x + y, 0);
    const marginalDenom = k * a + total;
    const marginalP = (a + (input.counts[input.heldDigit] ?? 0)) / marginalDenom;
    const rowTotal = input.transitionRow ? input.transitionRow.reduce((x, y) => x + y, 0) : 0;
    const w = est.memoryWeight;
    const rowP = w > 0 && rowTotal > 0
      ? (a + (input.transitionRow?.[input.heldDigit] ?? 0)) / (k * a + rowTotal)
      : marginalP;
    const heldP = w * rowP + (1 - w) * marginalP;
    const priorStrength = prismPriorStrength(a, k);
    const n = Math.max(1, input.window);
    const aPost = Math.max(1e-9, heldP * (n + priorStrength));
    const bPost = Math.max(1e-9, (1 - heldP) * (n + priorStrength));
    const heldClear = 1 - regularizedIncompleteBeta(clamp(input.hurdle, 1e-9, 1 - 1e-9), aPost, bPost);
    if (heldClear >= pClear - hysteresis) {
      digit = input.heldDigit;
      p = heldP;
      pClear = heldClear;
      held = true;
    }
  }

  const ready = pClear >= bar;
  return {
    ready,
    digit,
    p: round(p, 6),
    pClear: round(pClear, 6),
    bar: round(bar, 6),
    reason: ready
      ? `digit ${digit} clears the bar — P(rate > break-even) = ${(pClear * 100).toFixed(2)}% vs bar ${(bar * 100).toFixed(2)}%`
      : `digit ${digit} at ${(pClear * 100).toFixed(2)}% — waiting for the bar ${(bar * 100).toFixed(2)}%`,
    memoryWeight: est.memoryWeight,
    held,
  };
}
