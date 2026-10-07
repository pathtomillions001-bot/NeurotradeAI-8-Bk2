/**
 * Evidence Mathematics — statistical primitives for trade admission.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous decision layer used a chain of independent HARD gates
 * (drift ∧ regime ∧ timing ∧ recovery-intelligence). Each gate is a step
 * function: it either passes or vetoes. Because the conditions are correlated
 * (a trending market degrades entry timing AND lengthens loss streaks AND
 * eventually trips drift), the joint probability of all four passing
 * simultaneously collapses — which is why recovery trades could wait 30+
 * minutes for a conjunction that may never arrive.
 *
 * This module replaces that with EVIDENCE ACCUMULATION in log-odds space:
 *
 *     L = Σ wᵢ · log-odds(observationᵢ)
 *
 * Properties that matter:
 *
 *  1. SUBSTITUTABLE — a strong Markov/edge signal can carry a mediocre timing
 *     signal. Independent AND-gates cannot express this.
 *  2. FINITE — every term is bounded, so no single observation can veto
 *     forever (the old gates were effectively infinite negative evidence).
 *  3. CONTINUOUS — the decision boundary is a threshold, not a cliff, so
 *     marginally-worse conditions degrade the score instead of blocking it.
 *  4. AUDITABLE — the final number is a single scalar with interpretable
 *     units, and each term's contribution can be printed.
 *
 * This module is deliberately PURE: no imports, no I/O, no state. Every
 * function is a closed-form numerical routine, so the whole decision layer is
 * unit-testable against known distributions.
 *
 * Everything here is standard, well-established statistics:
 *  - Dirichlet-multinomial conjugacy (Beta aggregation property)
 *  - Regularized incomplete beta / gamma functions (Lentz continued fraction)
 *  - G² likelihood-ratio test for first-order Markov dependence
 *  - Wald sequential probability ratio boundaries
 */

// ── Numerical primitives ──────────────────────────────────────────────────────

/** Lanczos approximation of ln Γ(x) for x > 0 (g=7, n=9). */
export function logGamma(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula keeps the series valid below 0.5.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < c.length; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Continued fraction for the incomplete beta function (modified Lentz
 * algorithm, Numerical Recipes §6.4). Converges in <10 iterations for the
 * parameter ranges this system uses.
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITER = 200;
  const EPS = 3e-16;
  const FPMIN = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;

    // Even step.
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    // Odd step.
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b) — the CDF of Beta(a,b) at x. */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 0;
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 1) return 1;

  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  // The continued fraction converges fast only on one side of the mean; use the
  // symmetry I_x(a,b) = 1 - I_{1-x}(b,a) to always take the fast branch.
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Beta(a,b) tail probability P(X > threshold).
 *
 * This is the decision quantity for recovery/normal edge: given a posterior on
 * the true win probability, "what is the probability the edge is real?" —
 * i.e. that the true win rate exceeds the payout breakeven.
 */
export function betaTailProbability(a: number, b: number, threshold: number): number {
  if (!Number.isFinite(threshold)) return 0;
  if (threshold <= 0) return 1;
  if (threshold >= 1) return 0;
  const cdf = regularizedIncompleteBeta(a, b, threshold);
  const tail = 1 - cdf;
  if (!Number.isFinite(tail)) return 0;
  return Math.max(0, Math.min(1, tail));
}

// ── Dirichlet–multinomial edge posterior ──────────────────────────────────────

/** Mild uniform Dirichlet prior per digit — matches digit-probability.ts α=2. */
export const DIRICHLET_PRIOR_ALPHA = 2;

export interface DigitEdgePosterior {
  /** Posterior shape parameters of the aggregated Beta(alpha, beta). */
  alpha: number;
  beta: number;
  /** P(true win probability > breakeven) — the "is the edge real?" answer. */
  edgeProbability: number;
  /** Posterior mean win probability. */
  meanWinProbability: number;
  /** Payout breakeven win rate = 1 / payoutMultiplier. */
  breakeven: number;
  /** Effective sample size behind the estimate (informational). */
  sampleSize: number;
}

/**
 * Exact posterior for "over/under" style contracts using the Dirichlet
 * AGGREGATION PROPERTY.
 *
 * If digit counts follow Dirichlet(α_0 + n_0, …, α_9 + n_9), then the
 * probability mass on any SUBSET of digits is Beta-distributed with shape
 * parameters equal to the summed α over that subset and its complement. So the
 * win probability of `DIGITOVER b` is exactly
 *
 *     p_win = Σ_{d>b} θ_d  ~  Beta( Σ_{d>b}(α_0+n_d),  Σ_{d≤b}(α_0+n_d) )
 *
 * and the quantity we actually care about — "is this edge real?" — is a
 * closed-form tail probability:
 *
 *     P(edge real) = P(p_win > 1/payout)
 *
 * WHY THIS REPLACES A FIXED DEVIATION THRESHOLD
 * ---------------------------------------------
 * The old rule was `deviation > 0.005` (a flat 0.5pp cutoff) regardless of
 * sample size. That is statistically blind: +0.5pp from 50 digits is noise,
 * while +0.5pp from 5,000 digits is highly significant. The Beta posterior is
 * self-calibrating — a small sample yields a wide posterior (low
 * edgeProbability even for a large observed deviation), and a large sample
 * yields a tight one. No separate sample-size heuristic is needed.
 *
 * @param counts    Observed digit counts, index = digit 0..9.
 * @param barrier   The Over/Under barrier digit.
 * @param side      "over" → win when digit > barrier; "under" → digit < barrier.
 * @param payoutMultiplier Total return multiplier (includes stake).
 */
export function digitEdgePosterior(
  counts: number[],
  barrier: number,
  side: "over" | "under",
  payoutMultiplier: number,
): DigitEdgePosterior {
  const alpha0 = DIRICHLET_PRIOR_ALPHA;
  let a = 0;
  let b = 0;

  for (let d = 0; d <= 9; d++) {
    const n = Number.isFinite(counts[d]) && counts[d] > 0 ? counts[d] : 0;
    const win = side === "over" ? d > barrier : d < barrier;
    if (win) a += alpha0 + n;
    else b += alpha0 + n;
  }
  // Guard against degenerate prior mass (e.g. barrier outside 0..9).
  if (a <= 0) a = alpha0;
  if (b <= 0) b = alpha0;

  const total = a + b;
  const mean = a / total;
  const payout = Number.isFinite(payoutMultiplier) && payoutMultiplier > 0
    ? payoutMultiplier
    : 1;
  const breakeven = payout > 0 ? 1 / payout : 1;

  return {
    alpha: a,
    beta: b,
    edgeProbability: betaTailProbability(a, b, breakeven),
    meanWinProbability: mean,
    breakeven,
    sampleSize: Math.max(0, Math.round(total - 10 * alpha0)),
  };
}

// ── Regularized incomplete gamma (for chi-square tails) ───────────────────────

/** P(a,x) — regularized lower incomplete gamma, via series expansion. */
export function regularizedGammaP(a: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(x) || a <= 0 || x < 0) return 0;
  if (x === 0) return 0;

  const ITMAX = 300;
  const EPS = 3e-16;
  let sum = 1 / a;
  let del = sum;
  let ap = a;
  for (let n = 1; n <= ITMAX; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  const result = sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  return Math.max(0, Math.min(1, result));
}

/** Q(a,x) — regularized upper incomplete gamma, via continued fraction. */
export function regularizedGammaQ(a: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(x) || a <= 0 || x < 0) return 0;
  if (x < a + 1) return 1 - regularizedGammaP(a, x);

  const ITMAX = 300;
  const EPS = 3e-16;
  const FPMIN = 1e-300;

  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  const result = Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  return Math.max(0, Math.min(1, result));
}

/**
 * Upper-tail p-value of a chi-square statistic: P(X² > chi2 | df).
 *
 * Used instead of the Wilson–Hilferty approximation elsewhere in the codebase
 * because the Markov test has df=81, where that approximation loses accuracy
 * exactly in the tail region the test lives in.
 */
export function chiSquareUpperTail(chi2: number, df: number): number {
  if (!Number.isFinite(chi2) || chi2 <= 0) return 1;
  if (!Number.isFinite(df) || df <= 0) return 1;
  return regularizedGammaQ(df / 2, chi2 / 2);
}

// ── Markov dependence test ────────────────────────────────────────────────────

export interface MarkovTestResult {
  /** G² likelihood-ratio statistic. */
  g2: number;
  df: number;
  /** Upper-tail p-value. Small ⇒ transitions carry real information. */
  pValue: number;
  /** True when the transition structure is statistically distinguishable from i.i.d. */
  significant: boolean;
  /** Effective number of transitions observed. */
  observations: number;
}

/**
 * G² (likelihood-ratio) test of first-order Markov dependence.
 *
 * H₀: the next digit is independent of the current digit (i.i.d. uniform-ish).
 * H₁: the row-conditional distribution differs from the marginal.
 *
 *     G² = 2 Σᵢⱼ n_ij · ln( n_ij / e_ij ),   e_ij = n_i· · n_·j / n
 *     df = (10−1)(10−1) = 81
 *
 * WHY IT MATTERS: the barrier builder already sums Markov transition
 * probabilities into `markov1WinP` / `markov2WinP`. If the transition matrix is
 * NOT significant, those sums are predictions derived from noise — the apparent
 * "pattern" is indistinguishable from an i.i.d. draw. This test is what lets
 * the evidence layer decide whether to trust the Markov signal or discount it
 * toward the unconditional estimate, instead of trusting it unconditionally.
 *
 * @param transitions 10×10 count matrix, transitions[from][to].
 */
export function markovDependenceTest(transitions: number[][]): MarkovTestResult {
  let n = 0;
  const rowSums = new Array(10).fill(0);
  const colSums = new Array(10).fill(0);

  for (let i = 0; i < 10; i++) {
    const row = transitions[i] ?? [];
    for (let j = 0; j < 10; j++) {
      const c = Number.isFinite(row[j]) && row[j] > 0 ? row[j] : 0;
      rowSums[i] += c;
      colSums[j] += c;
      n += c;
    }
  }

  if (n <= 0) {
    return { g2: 0, df: 81, pValue: 1, significant: false, observations: 0 };
  }

  let g2 = 0;
  for (let i = 0; i < 10; i++) {
    const row = transitions[i] ?? [];
    for (let j = 0; j < 10; j++) {
      const observed = Number.isFinite(row[j]) && row[j] > 0 ? row[j] : 0;
      if (observed === 0) continue;
      const expected = (rowSums[i] * colSums[j]) / n;
      if (expected <= 0) continue;
      g2 += observed * Math.log(observed / expected);
    }
  }
  g2 *= 2;

  const df = 81;
  const pValue = chiSquareUpperTail(g2, df);
  return {
    g2,
    df,
    pValue,
    // Standard 5% level. With df=81 the critical value is ≈103.0.
    significant: pValue < 0.05,
    observations: n,
  };
}

// ── Log-odds evidence fusion ──────────────────────────────────────────────────

/**
 * Per-term clamp. ln(P/(1−P)) = ±2 corresponds to P ∈ [0.119, 0.881], which is
 * a deliberately strong-but-finite range: no single observation, however
 * extreme, can dominate the sum or veto forever.
 *
 * This bound is what makes the "no hard gates" property safe — see
 * MAX_TERM_LOG_ODDS usage in combineEvidence.
 */
export const MAX_TERM_LOG_ODDS = 2;

/** Convert a probability in (0,1) to log-odds, clamped to ±MAX_TERM_LOG_ODDS. */
export function probabilityToLogOdds(p: number): number {
  if (!Number.isFinite(p)) return 0;
  const clamped = Math.max(1e-6, Math.min(1 - 1e-6, p));
  const lo = Math.log(clamped / (1 - clamped));
  return Math.max(-MAX_TERM_LOG_ODDS, Math.min(MAX_TERM_LOG_ODDS, lo));
}

export interface EvidenceTerm {
  id: string;
  /** Relative importance; terms are normalised internally. */
  weight: number;
  /** Signed log-odds contribution before weighting. Positive supports trading. */
  logOdds: number;
  /** Human-readable explanation surfaced in reasoning strings. */
  detail?: string;
}

export interface EvidenceBreakdown {
  /** Weighted, normalised total in log-odds units. */
  total: number;
  /** Per-term weighted contribution, for auditability. */
  contributions: Array<{ id: string; contribution: number; detail?: string }>;
  /** Weight actually used (excludes non-finite/zero-weight terms). */
  weightUsed: number;
}

/**
 * Fuse independent evidence terms into a single log-odds score.
 *
 * Contributions are weighted and normalised by the total weight present, so a
 * missing term cannot silently shift the scale.
 *
 * SAFETY INVARIANT (asserted in tests): with the default weighting used by
 * master-decision.ts, a maximally BAD edge term (−MAX_TERM_LOG_ODDS) can never
 * be outvoted by every other term being maximally GOOD. A trade with no real
 * statistical edge therefore cannot be admitted by the remaining terms alone.
 * That property is emergent from the weights, not enforced by a hard gate —
 * which is exactly why it still allows a strong edge to carry weak secondary
 * signals.
 */
export function combineEvidence(terms: EvidenceTerm[]): EvidenceBreakdown {
  let weighted = 0;
  let weightUsed = 0;
  const contributions: Array<{ id: string; contribution: number; detail?: string }> = [];

  for (const term of terms) {
    const w = Number.isFinite(term.weight) && term.weight > 0 ? term.weight : 0;
    if (w === 0) continue;
    const lo = Number.isFinite(term.logOdds)
      ? Math.max(-MAX_TERM_LOG_ODDS, Math.min(MAX_TERM_LOG_ODDS, term.logOdds))
      : 0;
    weighted += w * lo;
    weightUsed += w;
    contributions.push({
      id: term.id,
      contribution: w * lo,
      detail: term.detail,
    });
  }

  return {
    total: weightUsed > 0 ? weighted / weightUsed : 0,
    contributions,
    weightUsed,
  };
}

// ── Wald sequential boundaries ────────────────────────────────────────────────

export interface SprtBoundaries {
  /** Accept-H₁ (trade) boundary, ln((1−β)/α). */
  upper: number;
  /** Accept-H₀ (skip) boundary, ln(β/(1−α)). */
  lower: number;
  alpha: number;
  beta: number;
}

/**
 * Wald sequential probability ratio test boundaries.
 *
 * For target error rates α (false positive) and β (false negative):
 *
 *     A = ln((1−β)/α)      accept H₁ when cumulative LLR ≥ A
 *     B = ln(β/(1−α))      accept H₀ when cumulative LLR ≤ B
 *
 * Wald's theorem: for given α and β this test achieves the MINIMUM expected
 * sample size of any test with those error rates. That is the formal reason a
 * sequential scheme answers "fire as soon as the evidence is sufficient"
 * without sacrificing error control — the fixed 50/100/150-window conjunction
 * is not optimal in that sense.
 */
export function sprtBoundaries(alpha = 0.05, beta = 0.05): SprtBoundaries {
  const a = Number.isFinite(alpha) && alpha > 0 && alpha < 1 ? alpha : 0.05;
  const b = Number.isFinite(beta) && beta > 0 && beta < 1 ? beta : 0.05;
  return {
    upper: Math.log((1 - b) / a),
    lower: Math.log(b / (1 - a)),
    alpha: a,
    beta: b,
  };
}

// ── Time-decayed admission threshold ──────────────────────────────────────────

export interface AdmissionThresholdInput {
  /** Milliseconds since recovery began (0 in normal mode). */
  elapsedMs: number;
  /** Threshold demanded at t=0. */
  startThreshold: number;
  /** Asymptotic floor the threshold decays toward. */
  floorThreshold: number;
  /** Exponential time constant in ms — smaller relaxes faster. */
  tauMs: number;
}

/**
 * Required evidence at time t:
 *
 *     L_req(t) = floor + (start − floor) · e^(−t/τ)
 *
 * This is the honest, continuous replacement for the old hard gates. It encodes
 * "I want a strong setup, and I am willing to accept progressively weaker ones
 * as the wait lengthens" without ever becoming infinitely permissive:
 *
 *   - t = 0        → L_req = startThreshold  (demanding)
 *   - t >> τ       → L_req → floorThreshold  (never below the floor)
 *
 * The FLOOR is the safety-critical parameter: it must stay above zero so that
 * admission always requires positive evidence. Setting it to zero would mean
 * "trade on a coin flip if we wait long enough", which converts a slow recovery
 * into an efficient loss of capital.
 *
 * Note the threshold is MONOTONE in time: waiting never makes the test harder,
 * so a setup rejected at t=0 can be accepted later at the same evidence level.
 * That is the property that removes the "waits for 30 minutes for a conjunction
 * that may never come" failure mode.
 */
export function requiredEvidence(input: AdmissionThresholdInput): number {
  const start = Number.isFinite(input.startThreshold) ? input.startThreshold : 0;
  const floor = Number.isFinite(input.floorThreshold) ? input.floorThreshold : 0;
  const tau = Number.isFinite(input.tauMs) && input.tauMs > 0 ? input.tauMs : 1;
  const t = Number.isFinite(input.elapsedMs) && input.elapsedMs > 0 ? input.elapsedMs : 0;

  if (t === 0) return start;
  return floor + (start - floor) * Math.exp(-t / tau);
}
