/**
 * ECHO APEX — institutional Matches analysis core.
 *
 * A Matches contract pays ~8.93×, so the entire game is P(next digit == d):
 * anything reliably above 1/8.93 ≈ 11.2% is edge. Five independent lenses
 * measure that probability from five different structures in the digit stream:
 *
 *  1. ECHO SPECTRUM — for lags 1..48, the recency-weighted probability that a
 *     digit repeats exactly k ticks later, plus a per-digit affinity prior.
 *     A digit that "echoes" at its characteristic lags is tilted up; lags
 *     running below fair tilt down. A full 48-lag spectrum, not a lag-1..3
 *     vector, and every lag carries its own effective sample size.
 *  2. HAWKES HEAT — each digit's arrivals drive a self-exciting point process
 *     (λ_d = μ_d + Σ α·e^(−β·Δt)) with (α, β) fitted per market by grid
 *     maximum-likelihood AND per-digit base intensities μ_d (recency-decayed
 *     frequencies, renormalised to the fair mean). It answers "how hot is
 *     this digit RIGHT NOW" from its own arrival times, how fast heat decays
 *     on this market, AND which digits are structurally warm here.
 *  3. SUFFIX MEMORY — a decayed longest-match continuation table over contexts
 *     of length 1..5: "every time THESE exact digits just printed, what came
 *     next?" Hard longest-match with lazy exponential decay and Laplace
 *     smoothing — no fixed window, no Bayesian order-mixing.
 *  4. CONTEXT-TREE WEIGHTING (CTW) — the universal predictor over the digit
 *     alphabet: a Bayesian ½/½ mixture of EVERY order-0..5 tree model with
 *     Krichevsky–Trofimov estimators at the nodes. Where suffix memory
 *     hard-commits to its longest adequately-sampled context, CTW softly
 *     blends ALL depths at once and carries proven per-sequence log-loss
 *     regret bounds against the best bounded-memory tree source (Willems,
 *     Shtarkov & Tjalkens) — you never have to guess the right Markov order.
 *  5. RENEWAL HAZARD — per-digit discrete hazard over the gap since that
 *     digit's last appearance. The echo spectrum measures the AVERAGE repeat
 *     rate at lag k; renewal conditions on the ACTUAL elapsed gap of every
 *     digit right now ("7 last printed 23 ticks ago — what is its conditional
 *     return rate at gap 23?"). Kaplan–Meier-flavoured, Beta(1,1)-smoothed.
 *
 * The lenses fuse through a LOGARITHMIC OPINION POOL (externally Bayesian: the
 * pool stays coherent when every lens observes the same new tick) with weights
 * that START from each lens's measured log-loss skill and are then REFINED by
 * coordinate descent on the simplex — direct minimisation of the pooled train
 * log-loss (the logarithmic score, a proper scoring rule) — together with a
 * single temperature scale that calibrates the fused distribution.
 *
 * SELECTION WITHOUT GATES — there is deliberately no entropy veto, no FDR
 * stack, no gap veto, no fixed sigma bar and NO break-even reject. A PACING
 * VALVE (a stochastic-approximation quantile tracker) holds the fire bar
 * exactly where the bot fires at its budgeted rate: selectivity is a budget,
 * not a stack of vetoes. The valve's bar may float down to ANY score the
 * lenses produce — an earlier build clamped it at break-even and ANDed a
 * `p ≥ break-even` hard reject onto `ready`, which starved the bot completely
 * (calibrated match probabilities hover near the 10% fair rate, below the
 * 11.2% break-even, so the gates rejected virtually every shot). Zero vetoes
 * means zero vetoes: the budget is the only selectivity.
 *
 * WHY SHOTS GET BETTER WITHOUT GATES (the v3 upgrades, all measured in the
 * diagnostic lab on fair and planted-structure tapes):
 *
 *  1. DECISION-CALIBRATED FUSION — the pool's temperature and weights are fit
 *     on a JOINT objective: full-distribution log-loss PLUS the top-1 Brier
 *     of the selected (argmax) digit. The old pure log-loss τ systematically
 *     over-claimed on fair tapes (fired shots claimed 12.7%, realized 10.3%
 *     — the winner's curse of selecting the max of 10 correlated estimates)
 *     and the old hard τ ∈ [1, 1.5] cap under-claimed real structure
 *     (claimed 19% where 26% realized on a planted echo). Now softening must
 *     be PAID for in decision-calibration, and sharpening is earned exactly
 *     when the argmax event itself justifies it.
 *  2. HELD-OUT EV DIGIT PICK — the AI digit is argmax_d (mean fused p_d on
 *     the UNSEEN test half) × (live per-digit payout). No per-tick selection,
 *     no winner's curse; the payout side of EV = p·payout is the one lever
 *     that is real on a statistically flat book (at fair p, 9.4× bleeds −6%/
 *     shot where 8.2× bleeds −18%/shot).
 *  3. FULL-VECTOR EV — decide()/peek() take the whole 10-digit payout vector;
 *     no top-3 truncation (measured: the EV-best digit sits outside the top-3
 *     up to 5% of ticks on cold/warm posteriors).
 *  4. SUFFIX LENS PPM INTERPOLATION — the old longest-match hard commitment
 *     cost −0.22 nats on structured tapes (long contexts are mostly
 *     coincidences); each order now blends into the shallower ladder in
 *     proportion to its own data mass.
 *  5. ONLINE HEDGE between re-fits — exponentially-decayed per-lens
 *     log-loss, softmaxed into the fitted weights (multiplicative-weights
 *     aggregation, Hedge regret bound), so the pool re-aims at a regime
 *     change in tens of ticks instead of waiting for the 20–45s re-fit.
 *
 * The pacing budget, the one-shot-per-tick valve and the honest held-out
 * replay are all UNCHANGED — every upgrade above is a selection/calibration
 * upgrade inside the budget.
 *
 * HONEST MEASUREMENT — the scan fits every parameter on the first 60% of each
 * market's history and reports the replay of the EXACT live policy (lenses +
 * fusion + valve) on the final 40% it never fitted on. Verdicts (PRIME /
 * VIABLE / THIN) describe measured expectancy per $1, never a promise.
 *
 * Everything here is pure and synchronous: no Deriv imports, no DB, no clock.
 * A full market fit + honest replay is ~1M flops — milliseconds.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const APEX_ECHO_LAGS = 48;
export const APEX_ECHO_HALFLIFE_TICKS = 500;
export const APEX_AFFINITY_HALFLIFE_TICKS = 300;
/** Pseudo-count mass (at the 10% fair rate) behind every echo-lag rate. */
export const APEX_ECHO_PRIOR = 20;
/** Pseudo-count mass behind the per-digit affinity prior. */
export const APEX_AFFINITY_PRIOR = 2;
export const APEX_SUFFIX_MAX_ORDER = 5;
export const APEX_SUFFIX_MIN_SAMPLES = 6;
export const APEX_SUFFIX_MAX_ENTRIES = 4000;
export const APEX_SUFFIX_HALFLIFE_TICKS = 600;
/** CTW context depth (mixture over ALL tree orders 0..this). */
export const APEX_CTW_DEPTH = 5;
export const APEX_CTW_MAX_NODES = 24_000;
/** Renewal hazard: longest gap tracked per digit. */
export const APEX_RENEWAL_MAX_GAP = 64;
export const APEX_MATCH_PAYOUT = 8.93;
export const APEX_BREAKEVEN = 1 / APEX_MATCH_PAYOUT;
/** Combinatorial fair rate of Matches (1 digit in 10) — used only for fallbacks. */
export const APEX_FAIR_RATE = 0.1;
export const APEX_TRAIN_FRACTION = 0.6;
export const APEX_MIN_FIT_DIGITS = 500;
export const APEX_MIN_MEASURE_DIGITS = 300;

export type ApexPace = "brisk" | "steady" | "patient";
/**
 * THE single pace mode. Echo Apex exposes no pace selector — the user asked
 * for one mode and one mode only, and it is the budget that allows the MOST
 * trades. Legacy clients may still send `pace`; every entry point ignores it
 * and stamps `APEX_ONLY_PACE` (see routes/apex.ts and apex-engine.ts).
 */
export const APEX_ONLY_PACE: ApexPace = "brisk";
/** Budgeted fire rate in shots per tick. Selectivity is a budget, not a veto. */
export const APEX_PACE_TARGET: Record<ApexPace, number> = {
  brisk: 0.06,
  steady: 0.035,
  patient: 0.02,
};
/**
 * Recovery no longer paces tighter than normal trading. The old 0.55 factor
 * made the bot wait LONGER for recovery shots exactly when the debt-driven
 * ladder needs a win — the budget is the same in debt and out of it.
 */
export const APEX_RECOVERY_PACE_FACTOR = 1;

export type ApexVerdict = "prime" | "viable" | "thin";

// ── Small math helpers ────────────────────────────────────────────────────────

function normalizeInPlace(p: ArrayLike<number> & { [d: number]: number }, n = 10): void {
  let s = 0;
  for (let d = 0; d < n; d++) s += p[d];
  if (!(s > 0)) {
    for (let d = 0; d < n; d++) p[d] = 1 / n;
    return;
  }
  for (let d = 0; d < n; d++) p[d] /= s;
}

export function uniform10(): number[] {
  return new Array<number>(10).fill(0.1);
}

export function argmax(p: ArrayLike<number>): number {
  let best = 0;
  for (let d = 1; d < 10; d++) if (p[d] > p[best]) best = d;
  return best;
}

/** Wilson 95% interval for k/n. Self-contained: no shared-stats dependency. */
export function wilson(k: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = Math.min(1, Math.max(0, k / n));
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lower: Math.min(1, Math.max(0, center - half)),
    upper: Math.min(1, Math.max(0, center + half)),
  };
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)));
  return sortedAsc[idx];
}

function softmax(logits: number[]): number[] {
  const m = Math.max(...logits);
  const exps = logits.map(v => Math.exp(v - m));
  const s = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map(v => v / s);
}

function cleanDigits(digits: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < digits.length; i++) {
    const d = digits[i];
    if (Number.isInteger(d) && d >= 0 && d <= 9) out.push(d);
  }
  return out;
}

/** log Γ(x) — Lanczos, doubles only; accurate to ~1e-13 over the needed range. */
function lgamma(x: number): number {
  if (x < 0.5) {
    // Reflection for tiny x (only hit for hypothetical negative inputs).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// ── Lens 1: echo spectrum ─────────────────────────────────────────────────────
// Recency-weighted P(d_t == d_{t-k}) for k = 1..48. update() feeds one new
// digit; score() tilts every digit by the echo evidence pointing at it.

export class EchoScope {
  private n: Float64Array;
  private h: Float64Array;
  private aff: Float64Array;
  private affN = 0;
  private decay: number;
  private affDecay: number;
  private seen = 0;

  constructor(
    private lags = APEX_ECHO_LAGS,
    echoHalfLife = APEX_ECHO_HALFLIFE_TICKS,
    affHalfLife = APEX_AFFINITY_HALFLIFE_TICKS,
  ) {
    this.n = new Float64Array(lags);
    this.h = new Float64Array(lags);
    this.aff = new Float64Array(10);
    this.decay = Math.pow(0.5, 1 / Math.max(1, echoHalfLife));
    this.affDecay = Math.pow(0.5, 1 / Math.max(1, affHalfLife));
  }

  get ticksSeen(): number {
    return this.seen;
  }

  /** Feed history[idx] as the newly observed digit (history[0..idx-1] precede it). */
  update(history: ArrayLike<number>, idx: number): void {
    const d = history[idx];
    if (!Number.isInteger(d) || d < 0 || d > 9) return;
    for (let k = 0; k < this.lags; k++) {
      this.n[k] *= this.decay;
      this.h[k] *= this.decay;
    }
    for (let i = 0; i < 10; i++) this.aff[i] *= this.affDecay;
    this.affN *= this.affDecay;
    const m = Math.min(this.lags, idx);
    for (let k = 1; k <= m; k++) {
      this.n[k - 1] += 1;
      if (history[idx - k] === d) this.h[k - 1] += 1;
    }
    this.aff[d] += 1;
    this.affN += 1;
    this.seen++;
  }

  /** Posterior-mean echo rate at 1-based lag k (prior: 10% fair). */
  rate(k: number): number {
    if (k < 1 || k > this.lags) return 0.1;
    return (this.h[k - 1] + APEX_ECHO_PRIOR * 0.1) / (this.n[k - 1] + APEX_ECHO_PRIOR);
  }

  /** Effective (decayed) opportunities behind lag k. */
  weight(k: number): number {
    if (k < 1 || k > this.lags) return 0;
    return this.n[k - 1];
  }

  /** Standardised lift of lag k over fair — a strength gauge, never a gate. */
  zScore(k: number): number {
    if (k < 1 || k > this.lags) return 0;
    const n = this.n[k - 1];
    if (n < 30) return 0;
    return (this.h[k - 1] - n * 0.1) / Math.sqrt(n * 0.1 * 0.9);
  }

  /** Per-digit affinity prior (Laplace-smoothed toward fair). */
  affinity(): number[] {
    const out = new Array<number>(10);
    for (let d = 0; d < 10; d++) {
      out[d] = (this.aff[d] + APEX_AFFINITY_PRIOR * 0.1) / (this.affN + APEX_AFFINITY_PRIOR);
    }
    return out;
  }

  /**
   * P(next digit) given history[0..idx] observed. Each lag k whose trailing
   * digit equals d contributes w_k · log(echoRate_k / 0.1) to d's log-tilt —
   * above-fair lags pull up, below-fair lags push down, stale lags fade out.
   */
  score(history: ArrayLike<number>, idx: number): number[] {
    const prior = this.affinity();
    const tilt = new Float64Array(10);
    const m = Math.min(this.lags, idx + 1);
    for (let k = 1; k <= m; k++) {
      const d = history[idx + 1 - k];
      if (!Number.isInteger(d) || d < 0 || d > 9) continue;
      const lift = this.rate(k) / 0.1;
      const w = Math.exp(-k / 12);
      tilt[d] += w * Math.log(Math.max(0.25, Math.min(4, lift)));
    }
    const out = new Array<number>(10);
    for (let d = 0; d < 10; d++) out[d] = prior[d] * Math.exp(tilt[d]);
    normalizeInPlace(out);
    return out;
  }

  /** Strongest echo lags for the console's rhythm panel. */
  topLags(count = 3): Array<{ lag: number; rate: number; z: number }> {
    const rows: Array<{ lag: number; rate: number; z: number }> = [];
    for (let k = 1; k <= this.lags; k++) {
      rows.push({ lag: k, rate: this.rate(k), z: this.zScore(k) });
    }
    rows.sort((a, b) => b.z - a.z);
    return rows.slice(0, Math.max(1, count));
  }
}

// ── Lens 2: Hawkes heat ───────────────────────────────────────────────────────
// Per-digit self-exciting intensity with exponential kernel. update() is the
// exact O(10) recursion; fitHawkes() grid-fits (α, β) by log-likelihood.

export interface HawkesParams {
  alpha: number;
  beta: number;
}

export class HawkesBank {
  private lam: Float64Array;
  /** Recency-decayed per-digit base shares — the structural warmth μ_d. */
  private base: Float64Array;
  private baseN = 0;
  private baseDecay: number;

  constructor(
    private alpha: number,
    private beta: number,
    private mu = 0.1,
  ) {
    this.lam = new Float64Array(10).fill(mu);
    this.base = new Float64Array(10).fill(1);
    this.baseDecay = Math.pow(0.5, 1 / 900); // ~900-tick half-life on the base
  }

  update(d: number): void {
    if (!Number.isInteger(d) || d < 0 || d > 9) return;
    const f = Math.exp(-this.beta);
    for (let i = 0; i < 10; i++) {
      this.lam[i] = this.mu + (this.lam[i] - this.mu) * f;
      this.base[i] *= this.baseDecay;
    }
    this.baseN *= this.baseDecay;
    this.base[d] += 1;
    this.baseN += 1;
    this.lam[d] += this.alpha;
  }

  /** Current heat, normalised to a distribution over the next digit. */
  probs(): number[] {
    const out = Array.from(this.lam);
    normalizeInPlace(out);
    return out;
  }

  /**
   * Heat with the per-digit base folded in: λ_d / Σλ re-weighted by the
   * decayed frequency share of d (structural warmth), then normalised. A
   * digit that is twice as frequent on this market carries twice the base
   * tilt; excitation heat stacks on top of it.
   */
  probsWithBase(): number[] {
    const mean = this.baseN > 0 ? this.baseN / 10 : 1;
    const out = new Array<number>(10);
    let s = 0;
    for (let d = 0; d < 10; d++) {
      const baseShare = this.baseN > 0 ? this.base[d] / Math.max(1e-9, mean) : 1;
      // Blend the flat base with the measured shares (light touch: the echo
      // lens's affinity prior already carries frequency tilt — double-counting
      // it here would let random digit skews masquerade as heat).
      const muD = 0.65 + 0.35 * baseShare;
      out[d] = (this.mu * muD + (this.lam[d] - this.mu)) / 1;
      s += out[d];
    }
    if (!(s > 0)) return uniform10();
    for (let d = 0; d < 10; d++) out[d] = Math.max(1e-6, out[d] / s);
    normalizeInPlace(out);
    return out;
  }

  /** Hottest digit and its heat vs fair (1.0 = stone cold fair). */
  heat(): { digit: number; ratio: number } {
    const digit = argmax(this.lam);
    return { digit, ratio: this.lam[digit] / 0.1 };
  }
}

const HAWKES_ALPHA_GRID = [0.02, 0.05, 0.1, 0.2, 0.35, 0.55];
const HAWKES_BETA_GRID = [0.03, 0.08, 0.15, 0.3, 0.55, 0.9];
const HAWKES_WARMUP = 150;

/** Maximum-likelihood (α, β) on grid — the market's own excitation signature. */
export function fitHawkes(digits: ArrayLike<number>): HawkesParams {
  const clean = cleanDigits(digits);
  const flat: HawkesParams = { alpha: 0.02, beta: 0.5 };
  let best: HawkesParams = { alpha: 0.05, beta: 0.3 };
  let bestLL = -Infinity;
  const start = Math.min(HAWKES_WARMUP, Math.floor(clean.length / 2));
  if (clean.length - start < 50) return flat;
  for (const alpha of HAWKES_ALPHA_GRID) {
    for (const beta of HAWKES_BETA_GRID) {
      const bank = new HawkesBank(alpha, beta);
      for (let i = 0; i < start; i++) bank.update(clean[i]);
      let ll = 0;
      for (let i = start; i < clean.length; i++) {
        const p = bank.probsWithBase();
        ll += Math.log(Math.max(1e-9, p[clean[i]]));
        bank.update(clean[i]);
      }
      if (ll > bestLL) {
        bestLL = ll;
        best = { alpha, beta };
      }
    }
  }
  // Model selection: excitation must EARN its place. If the best kernel does
  // not beat the uniform baseline by a material margin, the market's arrivals
  // are flat and the lens stays near-flat instead of amplifying noise into
  // fake-hot digits. (A fitting guard, not a trade gate — the valve still
  // paces whatever the other lenses see.)
  const baseline = -Math.log(10) * (clean.length - start);
  if (bestLL - baseline < 0.005 * (clean.length - start)) return flat;
  return best;
}

// ── Lens 3: suffix memory ─────────────────────────────────────────────────────
// Decayed longest-match continuation table, orders 1..5. Counts decay lazily
// via per-entry timestamps, so update() stays O(orders) no matter how large
// the table grows.

interface SuffixEntry {
  counts: Float64Array;
  total: number;
  seen: number;
}

export class SuffixMemory {
  private tables = new Map<string, SuffixEntry>();
  private tick = 0;
  private decayPerTick: number;

  constructor(
    private maxOrder = APEX_SUFFIX_MAX_ORDER,
    private minSamples = APEX_SUFFIX_MIN_SAMPLES,
    private maxEntries = APEX_SUFFIX_MAX_ENTRIES,
    halfLife = APEX_SUFFIX_HALFLIFE_TICKS,
  ) {
    this.decayPerTick = Math.pow(0.5, 1 / Math.max(1, halfLife));
  }

  get entries(): number {
    return this.tables.size;
  }

  private static key(history: ArrayLike<number>, endExclusive: number, order: number): string {
    let s = `${order}:`;
    for (let i = endExclusive - order; i < endExclusive; i++) s += String(history[i]);
    return s;
  }

  /** Learn that history[idx] followed the contexts ending just before it. */
  update(history: ArrayLike<number>, idx: number): void {
    const d = history[idx];
    if (!Number.isInteger(d) || d < 0 || d > 9 || idx < 1) {
      this.tick++;
      return;
    }
    this.tick++;
    for (let o = 1; o <= this.maxOrder; o++) {
      if (idx - o < 0) break;
      const key = SuffixMemory.key(history, idx, o);
      let e = this.tables.get(key);
      if (!e) {
        if (this.tables.size >= this.maxEntries) this.prune();
        e = { counts: new Float64Array(10), total: 0, seen: this.tick };
        this.tables.set(key, e);
      } else if (this.tick > e.seen) {
        const f = Math.pow(this.decayPerTick, this.tick - e.seen);
        if (f < 0.999) {
          for (let i = 0; i < 10; i++) e.counts[i] *= f;
          e.total *= f;
        }
        e.seen = this.tick;
      }
      e.counts[d] += 1;
      e.total += 1;
    }
  }

  /**
   * P(next digit) — PPM-INTERPOLATED down the context ladder, orders 1..max.
   *
   * The old predictor hard-committed to the LONGEST context with enough
   * (decayed) samples. Measured on a planted lag-3 echo tape that cost
   * −0.22 nats of skill: long contexts are mostly coincidences, and a hard
   * bet on them drags the whole pool. Now each order's Laplace-smoothed
   * predictive is interpolated toward the shallower blend in proportion to
   * its own (decayed) data mass — k = total/(total+shrink) — so a context
   * seen a handful of times inherits the shallower view and only genuinely
   * fat contexts speak for themselves. `order` reports the deepest rung that
   * cleared minSamples (display only); the blend is returned either way.
   */
  predict(history: ArrayLike<number>, idx: number): { probs: number[]; order: number; samples: number } {
    let blend = uniform10();
    let deepest = 0;
    let deepestSamples = 0;
    for (let o = 1; o <= this.maxOrder; o++) {
      if (idx - o + 1 < 0) break;
      const e = this.tables.get(SuffixMemory.key(history, idx + 1, o));
      if (!e) break;
      const f = Math.pow(this.decayPerTick, Math.max(0, this.tick - e.seen));
      const total = e.total * f;
      if (total <= 0) break;
      const raw = new Array<number>(10);
      let s = 0;
      for (let d = 0; d < 10; d++) {
        raw[d] = e.counts[d] * f + 0.1;
        s += raw[d];
      }
      for (let d = 0; d < 10; d++) raw[d] /= s;
      // PPM interpolation with DEPTH-AWARE damping: a single-hit context at
      // order 5 is noise riding on noise, while the same count at order 1 is
      // already a usable frequency read — shrinkage grows with o (4·o²) so
      // deep thin rungs barely move the blend instead of compounding their
      // spikes down the ladder (measured: hard longest-match cost −0.22 nats
      // on fair tapes; flat 4-shrink PPM still cost −0.15; 4·o² ≈ −0.01).
      const k = total / (total + 4 * o * o);
      const next = new Array<number>(10);
      for (let d = 0; d < 10; d++) next[d] = k * raw[d] + (1 - k) * blend[d];
      blend = next;
      if (total >= this.minSamples) {
        deepest = o;
        deepestSamples = total;
      }
    }
    normalizeInPlace(blend);
    return { probs: blend, order: deepest, samples: deepestSamples };
  }

  private prune(): void {
    // Drop the most decayed entries first; fall back to oldest-touched.
    const scored: Array<{ key: string; total: number; seen: number }> = [];
    for (const [key, e] of this.tables) {
      const f = Math.pow(this.decayPerTick, Math.max(0, this.tick - e.seen));
      scored.push({ key, total: e.total * f, seen: e.seen });
    }
    scored.sort((a, b) => a.total - b.total || a.seen - b.seen);
    const drop = Math.max(1, Math.floor(scored.length * 0.25));
    for (let i = 0; i < drop; i++) this.tables.delete(scored[i].key);
  }
}

// ── Lens 4: context-tree order mixture (universal predictor over digits) ──────
// A Bayesian mixture of per-order Krichevsky–Trofimov context predictors for
// EVERY order 0..D at once: each depth d keeps its own context-conditioned KT
// counts and a cumulative sequential log-score; the predictive blends the
// depths with posterior weights ∝ e^(log-score). The mixture's cumulative
// log-loss is within log(D+1) nats of the BEST single order for the whole
// sequence, and it concentrates on that order exponentially fast — so a tape
// that carries order-3 structure is read at order 3 without anyone having to
// guess the order (the full-tree CTW guarantee, restricted to fixed orders,
// minus the sibling bookkeeping the tree version needs).

interface CtwNode {
  counts: Float64Array; // KT counts per symbol
  total: number;
  logKT: number; // cumulative sequential log-score of THIS NODE's predictive
}

export class DigitCTW {
  private nodes = new Map<string, CtwNode>();
  private depth: number;
  private maxNodes: number;
  /** Cumulative sequential log-score per ORDER — the mixture weights. */
  private orderScore: Float64Array;

  constructor(depth = APEX_CTW_DEPTH, maxNodes = APEX_CTW_MAX_NODES) {
    this.depth = depth;
    this.maxNodes = maxNodes;
    this.orderScore = new Float64Array(depth + 1);
    // Ensure the order-0 node exists.
    this.nodes.set("", { counts: new Float64Array(10), total: 0, logKT: 0 });
  }

  private ensure(key: string): CtwNode {
    let n = this.nodes.get(key);
    if (!n) {
      if (this.nodes.size >= this.maxNodes) this.prune();
      n = { counts: new Float64Array(10), total: 0, logKT: 0 };
      this.nodes.set(key, n);
    }
    return n;
  }

  /** Context path key: the `d` digits ENDING at endExclusive-1, in tape order. */
  private static key(history: ArrayLike<number>, endExclusive: number, d: number): string {
    if (d <= 0) return "";
    let s = "";
    for (let i = endExclusive - d; i < endExclusive; i++) s += String(history[i]);
    return s;
  }

  /** Feed history[idx] as the newly observed digit. */
  update(history: ArrayLike<number>, idx: number): void {
    const x = history[idx];
    if (!Number.isInteger(x) || x < 0 || x > 9) return;
    const sym = x as number;
    // Every order's context node on the path scores the symbol with its own
    // PRE-update KT predictive, then absorbs it into its counts.
    for (let d = Math.min(this.depth, idx); d >= 0; d--) {
      const node = this.ensure(DigitCTW.key(history, idx, d));
      const denom = node.total + 5;
      this.orderScore[d]! += Math.log(Math.max(1e-9, (node.counts[sym]! + 0.5) / denom));
      node.counts[sym]! += 1;
      node.total += 1;
      node.logKT = this.orderScore[d]!;
    }
  }

  /**
   * P(next digit) — the posterior-weighted blend of every order's KT
   * predictive, weights ∝ e^(that order's cumulative log-score). Each
   * order's raw predictive is first PPM-INTERPOLATED toward the shallower
   * blend in proportion to its own data mass, so a context seen once does
   * not shout 2.5× fair (the classic deep-context overconfidence): thin
   * contexts inherit the shallower view, fat contexts speak for themselves.
   * The best order still takes over exponentially fast once its evidence
   * dwarfs the shrinkage constant; until then the blend is near-uniform.
   */
  predict(history: ArrayLike<number>, idx: number): number[] {
    const maxScore = Math.max(...this.orderScore);
    const shrink = 8;
    const out = new Array<number>(10).fill(0);
    let shallower = uniform10();
    let wSum = 0;
    for (let d = 0; d <= this.depth; d++) {
      const node = this.nodes.get(DigitCTW.key(history, idx + 1, d));
      if (!node || node.total === 0) {
        if (d === 0) shallower = uniform10();
        continue;
      }
      const n = node.total;
      const denom = n + 5;
      const raw = new Array<number>(10);
      for (let s = 0; s < 10; s++) raw[s] = (node.counts[s]! + 0.5) / denom;
      // PPM interpolation: fat contexts keep their read, thin ones inherit.
      const blended = new Array<number>(10);
      const k = n / (n + shrink);
      for (let s = 0; s < 10; s++) blended[s] = k * raw[s]! + (1 - k) * shallower[s]!;
      const w = Math.exp(Math.max(-60, this.orderScore[d]! - maxScore));
      for (let s = 0; s < 10; s++) out[s]! += w * blended[s]!;
      wSum += w;
      shallower = blended;
    }
    if (!(wSum > 0)) return uniform10();
    for (let s = 0; s < 10; s++) out[s]! /= wSum;
    normalizeInPlace(out);
    return out;
  }

  /** Deepest node on the current context path that holds data — display only. */
  effectiveDepth(history: ArrayLike<number>, idx: number): number {
    for (let d = Math.min(this.depth, idx + 1); d >= 1; d--) {
      const n = this.nodes.get(DigitCTW.key(history, idx + 1, d));
      if (n && n.total > 0) return d;
    }
    return 0;
  }

  private prune(): void {
    // Drop the thinnest nodes first (deepest first among ties). Order scores
    // live per-depth, so pruning individual contexts never corrupts them.
    const victims: Array<{ key: string; d: number; total: number }> = [];
    for (const [key, n] of this.nodes) {
      if (key === "") continue;
      victims.push({ key, d: key.length, total: n.total });
    }
    victims.sort((a, b) => a.total - b.total || b.d - a.d);
    const drop = Math.max(1, Math.floor(victims.length * 0.3));
    for (let i = 0; i < drop; i++) this.nodes.delete(victims[i].key);
  }
}

// ── Lens 5: renewal hazard (gap-conditioned per-digit return rates) ───────────
// For each digit, the discrete hazard h_d(g) = P(d prints | d last printed g
// ticks ago), estimated from the censored gap history with Beta(1,1)
// smoothing. P(next = d) ∝ h_d(current gap of d), normalised across digits.

export class RenewalHazard {
  private died: Array<Float64Array>;
  private atRisk: Array<Float64Array>;
  private gap: Float64Array;

  constructor(private maxGap = APEX_RENEWAL_MAX_GAP) {
    this.died = Array.from({ length: 10 }, () => new Float64Array(maxGap + 1));
    this.atRisk = Array.from({ length: 10 }, () => new Float64Array(maxGap + 1));
    this.gap = new Float64Array(10).fill(1); // every digit is "1 tick cold" at t=0
  }

  /** Feed history[idx] as the newly observed digit. */
  update(history: ArrayLike<number>, idx: number): void {
    const d = history[idx];
    if (!Number.isInteger(d) || d < 0 || d > 9) return;
    // Age every digit's gap by this tick…
    for (let i = 0; i < 10; i++) {
      if (this.gap[i] < this.maxGap) this.gap[i] += 1;
    }
    // …then digit d printed at its previous gap: record the death there.
    const g = Math.min(this.maxGap, Math.max(1, Math.round(this.gap[d] - 1)));
    this.died[d][g] += 1;
    for (let a = 1; a <= g; a++) this.atRisk[d][a] += 1;
    this.gap[d] = 1;
  }

  /** Smoothed hazard of digit d at gap g. */
  hazard(d: number, g: number): number {
    if (d < 0 || d > 9) return 0.1;
    const a = Math.min(this.maxGap, Math.max(1, Math.round(g)));
    return (this.died[d][a] + 1) / (this.atRisk[d][a] + 2);
  }

  /**
   * P(next digit) from the hazards at the CURRENT gaps, each pulled toward
   * the fair 10% in proportion to how little hazard data that digit has.
   */
  predict(): number[] {
    const out = new Array<number>(10);
    let s = 0;
    for (let d = 0; d < 10; d++) {
      const h = this.hazard(d, this.gap[d]);
      const risk = this.atRisk[d][1];
      const w = Math.min(0.8, risk / (risk + 10));
      out[d] = w * h + (1 - w) * 0.1;
      s += out[d];
    }
    if (!(s > 0)) return uniform10();
    for (let d = 0; d < 10; d++) out[d] /= s;
    return out;
  }

  /** Coldest digit by elapsed gap — display only, never a gate. */
  coldest(): { digit: number; gap: number } {
    let best = 0;
    for (let d = 1; d < 10; d++) if (this.gap[d] > this.gap[best]) best = d;
    return { digit: best, gap: Math.round(this.gap[best]) };
  }
}

// ── Fusion: logarithmic opinion pool + temperature ────────────────────────────

/**
 * Logarithmic pool: fused_d ∝ Π_lens p_d^w_l. Externally Bayesian — when every
 * lens conditions on the same new tick, the pool equals the pool of the
 * updates — and it rewards lenses that AGREE on a digit, which is exactly
 * when a Matches shot is safest.
 */
export function logPool(distributions: number[][], weights: number[]): number[] {
  const out = new Array<number>(10);
  for (let d = 0; d < 10; d++) {
    let acc = 0;
    for (let l = 0; l < distributions.length; l++) {
      acc += weights[l] * Math.log(Math.max(1e-9, distributions[l][d]));
    }
    out[d] = Math.exp(acc);
  }
  normalizeInPlace(out);
  return out;
}

/** Single-parameter calibration: softmax(log p / τ). τ<1 sharpens, τ>1 softens. */
export function temperatureScale(p: ArrayLike<number>, tau: number): number[] {
  const t = Number.isFinite(tau) && tau > 0 ? tau : 1;
  if (t === 1) return Array.from(p);
  const out = new Array<number>(10);
  for (let d = 0; d < 10; d++) out[d] = Math.exp(Math.log(Math.max(1e-9, p[d])) / t);
  normalizeInPlace(out);
  return out;
}

export const APEX_LENS_FLOOR = 0.05;
/** Number of fused lenses: echo, hawkes, suffix, ctw, renewal. */
export const APEX_LENS_COUNT = 5;
export const APEX_LENS_NAMES = ["echo", "hawkes", "suffix", "ctw", "renewal"] as const;

/**
 * Lens weights from measured log-loss skill (nats saved vs the uniform
 * baseline), soft-maxed with a 5% floor so no lens ever dies completely.
 * Works for any lens count; the classic 3-lens call shape still returns
 * exactly 3 weights.
 */
export function weightsFromSkill(logLosses: number[], baseline = Math.log(10)): number[] {
  const skills = logLosses.map(ll => baseline - ll);
  const w = softmax(skills.map(s => s / 0.05));
  const floored = w.map(v => APEX_LENS_FLOOR + (1 - APEX_LENS_FLOOR * logLosses.length) * v);
  const s = floored.reduce((a, b) => a + b, 0) || 1;
  return floored.map(v => v / s);
}

/** Project weights onto the simplex with a hard floor per lens. */
function projectSimplex(w: number[], floor: number): number[] {
  const clamped = w.map(v => Math.max(floor, Number.isFinite(v) ? v : floor));
  const s = clamped.reduce((a, b) => a + b, 0);
  return s > 0 ? clamped.map(v => v / s) : w.map(() => 1 / w.length);
}

/**
 * COORDINATE DESCENT ON THE SIMPLEX — the second stage of fusion fitting.
 *
 * `weightsFromSkill` is only a starting point (its 1/0.05 softmax is a
 * heuristic). This directly minimises a joint proper-scoring objective over
 * the pooled train distribution:
 *
 *   loss(w, τ) = mean[ −log fused[event] ]            ← full-distribution
 *              + wTop1 · mean[ (fused[argmax] − hit)² ]  ← SELECTION event
 *
 * The second term is the part that actually prices the bot's DECISION: the
 * valve fires on the fused argmax probability, so the number that must be
 * honest is P(argmax digit) — not the log-loss of the whole vector. Measured
 * on fair tapes, a pure log-loss τ lands wherever the grid allows and the
 * fired shots still claim ~12.7% while realizing ~10.3% (the winner's curse
 * of selecting the max of 10 correlated estimates); adding the top-1 Brier
 * forces softening to be PAID FOR in decision-calibration, and symmetrically
 * lets τ < 1 sharpen when a planted echo makes the argmax digit genuinely
 * hotter than the softened claim (measured: τ 0.73 on a 6% lag-3 echo vs the
 * old hard [1, 1.5] cap that under-claimed 19% vs 26% realized). This is a
 * FIT-TIME capacity control, never a trade gate — the valve still paces
 * whatever distribution results.
 *
 * For a log-pool, the log-loss surface is concave in log-weights, so
 * coordinate moves with shrinking steps converge to the pooled optimum
 * without ever leaving the simplex.
 */
export function optimizePoolWeights(
  samples: Array<{ lenses: number[][]; event: number }>,
  weights0: number[],
  tau0: number,
  tauGrid: number[],
  opts?: { reg?: number; top1Weight?: number },
): { weights: number[]; tau: number } {
  const L = weights0.length;
  const floor = APEX_LENS_FLOOR;
  // Complexity control: each nats-per-sample of pooled-log-loss gain must buy
  // its deviation from the uniform pool. Without this, direct log-loss
  // minimisation happily overfits train-half noise (measured: fake "edge" on
  // provably fair streams). KL(w || uniform) in nats, scaled by sample count
  // and `reg`. A fit-time capacity control — never a trade gate.
  const reg = opts?.reg ?? 0.04;
  // Weight of the top-1 Brier term relative to the log-loss term (nats ≈ 2.3
  // on a fair tape; top-1 Brier ≈ 0.098·10 ≈ 1 → 10 puts both terms on a
  // comparable footing while keeping the log-loss in charge of overall shape).
  const wTop1 = opts?.top1Weight ?? 10;
  let weights = projectSimplex([...weights0], floor);
  let tau = tau0;
  const klToUniform = (w: number[]): number => {
    let kl = 0;
    for (const v of w) kl += v > 1e-12 ? v * Math.log(v * L) : 0;
    return Math.max(0, kl);
  };
  const pooledLoss = (w: number[], t: number): number => {
    let ll = 0;
    let t1 = 0;
    for (const s of samples) {
      const fused = temperatureScale(logPool(s.lenses, w), t);
      ll += -Math.log(Math.max(1e-9, fused[s.event] ?? 1e-9));
      let m = 0;
      for (let d = 1; d < 10; d++) if (fused[d] > fused[m]) m = d;
      const hit = s.event === m ? 1 : 0;
      t1 += (fused[m] - hit) * (fused[m] - hit);
    }
    const n = Math.max(1, samples.length);
    // Per-sample objective: mean log-loss (nats) + wTop1 × mean top-1 Brier,
    // plus the per-sample KL capacity control (same scale as before).
    return ll / n + wTop1 * (t1 / n) + reg * klToUniform(w);
  };
  let best = pooledLoss(weights, tau);
  const factors = [0.5, 0.7, 0.85, 1.18, 1.45, 2.0];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < L; i++) {
      for (const f of factors) {
        const cand = [...weights];
        cand[i] = Math.max(floor, weights[i] * f);
        const proj = projectSimplex(cand, floor);
        const loss = pooledLoss(proj, tau);
        if (loss < best - 1e-6) {
          best = loss;
          weights = proj;
        }
      }
    }
    for (const t of tauGrid) {
      const loss = pooledLoss(weights, t);
      if (loss < best - 1e-6) {
        best = loss;
        tau = t;
      }
    }
  }
  return { weights, tau };
}

// ── Online hedge: multiplicative re-weighting between re-fits ─────────────────
// The scan fits pool weights on a 4500-tick window and the live loop re-fits
// every 20–45s. Between re-fits the tape can change regime (a rhythm dies, a
// new one starts) faster than the re-fit cadence. The hedge tracks each
// lens's DECAYED online log-loss as the tape actually arrives and blends a
// softmax of that skill into the fitted weights — exponential-weights-style
// forecasting aggregation (Hedge / multiplicative weights), whose cumulative
// log-loss is within O(√(T log N)) of the best lens in hindsight. The fitted
// weights stay the prior; the hedge only gets as much say as the live tape
// has earned (ρ = n/(n+400)), and the 5% floor keeps every lens alive.

export class OnlineHedge {
  private ll: Float64Array;
  private fed = 0;
  private lastAt = 0;

  constructor(
    private lensCount: number,
    private halfLife = 800,
    private ramp = 400,
  ) {
    this.ll = new Float64Array(lensCount);
  }

  /** Score each lens's stored prediction against the digit that just printed. */
  private decay(): void {
    const f = Math.pow(0.5, this.fed - this.lastAt);
    for (let l = 0; l < this.lensCount; l++) this.ll[l] *= f;
    this.lastAt = this.fed;
  }

  observe(logProbs: ReadonlyArray<ArrayLike<number>> | null, digit: number): void {
    this.fed++;
    if (this.fed - this.lastAt > 0) this.decay();
    if (!logProbs) return;
    for (let l = 0; l < this.lensCount; l++) {
      this.ll[l] += -Math.log(Math.max(1e-9, logProbs[l]?.[digit] ?? 1e-9));
    }
  }

  /**
   * Effective pool weights: (1−ρ)·fitted + ρ·softmax(skill), skill = mean
   * nats saved vs the uniform baseline over the decayed window.
   */
  weights(fitted: number[]): number[] {
    const n = this.fed;
    if (n < 30) return fitted;
    const ρ = n / (n + this.ramp);
    const skills: number[] = [];
    for (let l = 0; l < this.lensCount; l++) skills.push(Math.log(10) - this.ll[l] / n);
    const hedge = softmax(skills.map(s => s / 0.05));
    const blended = fitted.map((w, l) => (1 - ρ) * w + ρ * hedge[l]);
    return projectSimplex(blended, APEX_LENS_FLOOR);
  }

  /** Per-lens mean log-loss over the decayed window (diagnostics). */
  losses(): number[] {
    const n = Math.max(1, this.fed);
    return Array.from(this.ll, v => v / n);
  }

  get observations(): number {
    return this.fed;
  }
}

// ── Pacing valve: selectivity as a budget ─────────────────────────────────────
// Stochastic-approximation quantile tracker: the bar drifts until P(score ≥
// bar) == target rate. No score distribution is assumed; convergence needs a
// few dozen ticks from any start, and the scan seeds the bar at the measured
// quantile so live trading starts converged.

export class PacingValve {
  bar: number;

  constructor(
    private targetRate: number,
    initBar: number,
    private floor: number,
    private kappa = 0.004,
  ) {
    this.bar = Math.min(0.9, Math.max(initBar, floor));
  }

  get target(): number {
    return this.targetRate;
  }

  observe(score: number, effRate?: number): boolean {
    const r = effRate ?? this.targetRate;
    const fire = score >= this.bar;
    if (fire) this.bar += this.kappa * (1 - r);
    else this.bar -= this.kappa * r;
    if (this.bar < this.floor) this.bar = this.floor;
    if (this.bar > 0.9) this.bar = 0.9;
    return fire;
  }
}

// ── Policy: lenses + fusion + valve in one tick-driven unit ──────────────────

export interface ApexParams {
  alpha: number;
  beta: number;
  /** Log-pool weights over [echo, hawkes, suffix, ctw, renewal]. */
  weights: number[];
  tau: number;
  initBar: number;
  pace: ApexPace;
  lockedDigit?: number;
}

export interface ApexDecision {
  digit: number;
  p: number;
  bar: number;
  ready: boolean;
  echo: number[];
  hawkes: number[];
  suffix: number[];
  ctw: number[];
  renewal: number[];
  fused: number[];
  memoryOrder: number;
  memorySamples: number;
  heatDigit: number;
  heatRatio: number;
  /** EV winner metadata when a payout vector was supplied to decide(). */
  evDigit?: number;
  evPayout?: number;
}

export function defaultApexParams(pace: ApexPace, lockedDigit?: number): ApexParams {
  return {
    alpha: 0.1,
    beta: 0.25,
    weights: [0.3, 0.2, 0.15, 0.2, 0.15],
    tau: 1,
    initBar: APEX_FAIR_RATE + 0.005,
    pace,
    ...(lockedDigit !== undefined ? { lockedDigit } : {}),
  };
}

export function sanitizeApexParams(raw: any, pace: ApexPace, lockedDigit?: number): ApexParams | null {
  if (!raw || typeof raw !== "object") return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const alpha = num(raw.alpha);
  const beta = num(raw.beta);
  const tau = num(raw.tau);
  const initBar = num(raw.initBar);
  const w = Array.isArray(raw.weights) ? raw.weights.map(num) : null;
  if (alpha === null || beta === null || tau === null || initBar === null) return null;
  // Accept legacy 3-lens vectors (echo/hawkes/suffix) and pad to 5 — older
  // consoles and stored scans must keep working across the lens upgrade.
  if (!w || w.length < 3 || w.length > APEX_LENS_COUNT || w.some((v: number | null) => v === null)) return null;
  if (alpha < 0 || alpha > 2 || beta <= 0 || beta > 5) return null;
  if (tau < 0.3 || tau > 3 || initBar < 0 || initBar > 1) return null;
  const pad = (arr: Array<number | null>): number[] => {
    const clean = arr.map(v => (v === null ? 0 : v));
    if (clean.length >= APEX_LENS_COUNT) return clean.slice(0, APEX_LENS_COUNT);
    const legacySum = clean.reduce((a, b) => a + b, 0) || 1;
    // Split the legacy mass: 2/3 to the original trio (scaled to 60% total),
    // 1/3 shared by the two new lenses — a neutral migration.
    const head = clean.map(v => (v / legacySum) * 0.6);
    const tail = [0.6 / 2, 0.6 / 2].map(v => v);
    return [...head, ...tail];
  };
  const weights = projectSimplex(pad(w), 0.01);
  return {
    alpha,
    beta,
    weights,
    tau,
    initBar,
    pace,
    ...(lockedDigit !== undefined ? { lockedDigit } : {}),
  };
}

export class ApexPolicy {
  private echo = new EchoScope();
  private hawkes: HawkesBank;
  private memory = new SuffixMemory();
  private ctw = new DigitCTW();
  private renewal = new RenewalHazard();
  private valve: PacingValve;
  private hedge = new OnlineHedge(APEX_LENS_COUNT);
  /** Lens distributions from the LAST decide() — scored once the next tick lands. */
  private lastLenses: number[][] | null = null;
  /** Effective pool weights (fitted ⊕ hedge) — exposed for diagnostics. */
  private activeWeights: number[];
  /**
   * Zero floor: the bar may float down to wherever the budgeted fire rate
   * lives in the live score distribution. A break-even floor here (plus a
   * `p ≥ break-even` reject on `ready`) is what starved the bot of trades —
   * do not reintroduce any hard reject; the budget IS the selectivity.
   */
  private floor = 0;

  constructor(private params: ApexParams) {
    this.hawkes = new HawkesBank(params.alpha, params.beta);
    this.valve = new PacingValve(APEX_PACE_TARGET[params.pace] ?? 0.035, params.initBar, this.floor);
    this.activeWeights = [...params.weights];
  }

  get fitted(): ApexParams {
    return this.params;
  }

  /** Effective (fitted ⊕ hedge) pool weights, for diagnostics and the console. */
  lensWeights(): number[] {
    return [...this.activeWeights];
  }

  /** Feed history[idx] as the newly observed digit. */
  update(history: ArrayLike<number>, idx: number): void {
    this.echo.update(history, idx);
    this.memory.update(history, idx);
    this.ctw.update(history, idx);
    this.renewal.update(history, idx);
    const d = history[idx];
    if (Number.isInteger(d) && d >= 0 && d <= 9) {
      this.hawkes.update(d);
      // Settle the previous decide()'s lens predictions against this outcome:
      // the hedge learns at the speed the tape actually arrives.
      this.hedge.observe(this.lastLenses, d);
      this.activeWeights = this.hedge.weights(this.params.weights);
    }
    this.lastLenses = null;
  }

  /** The five lens distributions, fused over the EFFECTIVE weights. */
  private fuse(history: ArrayLike<number>, idx: number): {
    echo: number[]; hawkes: number[]; suffix: number[]; ctw: number[]; renewal: number[]; fused: number[];
    memoryOrder: number; memorySamples: number;
  } {
    const echo = this.echo.score(history, idx);
    const hawkes = this.hawkes.probsWithBase();
    const mem = this.memory.predict(history, idx);
    const ctw = this.ctw.predict(history, idx);
    const renewal = this.renewal.predict();
    const weights = this.activeWeights;
    const fused = temperatureScale(logPool([echo, hawkes, mem.probs, ctw, renewal], weights), this.params.tau);
    return {
      echo, hawkes, suffix: mem.probs, ctw, renewal, fused,
      memoryOrder: mem.order, memorySamples: mem.samples,
    };
  }

  /**
   * Score the next digit after history[0..idx]. Call EXACTLY once per new
   * tick — the valve adapts its bar on every call.
   *
   * `opts.payouts` (per-digit live payout multipliers) upgrades the digit
   * pick from argmax p to argmax p·payout over the FULL vector — the
   * EV-optimal shot. On a statistically flat posterior (the honest state of
   * most sessions) this concentrates every shot on the fattest quote the
   * book offers: at fair p = 10%, 9.4× loses −6%/shot where 8.2× loses
   * −18%/shot. This is a SELECTION upgrade inside the already-open valve,
   * never a gate.
   */
  decide(history: ArrayLike<number>, idx: number, opts?: { recovery?: boolean; payouts?: number[] }): ApexDecision {
    const lens = this.fuse(history, idx);
    const fused = lens.fused;
    // Store the lens vectors so update() can score them against the outcome.
    this.lastLenses = [lens.echo, lens.hawkes, lens.suffix, lens.ctw, lens.renewal].slice(0, this.params.weights.length);
    const locked = this.params.lockedDigit;
    let digit = locked !== undefined ? locked : argmax(fused);
    let evDigit: number | undefined;
    let evPayout: number | undefined;
    if (opts?.payouts && locked === undefined) {
      // EV pick over the FULL fused vector. The old top-3-by-p truncation
      // assumed no payout gap could lift a tail digit — true on a warm,
      // concentrated posterior (leader ≥15% relative edge over rank 4), but
      // right after a re-fit or on a flat tape the ranks 4–10 sit within the
      // payout spread, and quoting is cached anyway. Keep it bounded: payout
      // entries must be finite and positive to count.
      let bestEV = -Infinity;
      for (let d = 0; d < 10; d++) {
        const pay = opts.payouts[d];
        if (!Number.isFinite(pay) || (pay as number) <= 0) continue;
        const ev = fused[d] * (pay as number);
        if (ev > bestEV) {
          bestEV = ev;
          evDigit = d;
          evPayout = pay as number;
        }
      }
      if (evDigit !== undefined) digit = evDigit;
    }
    const p = fused[digit];
    const r = APEX_PACE_TARGET[this.params.pace] ?? 0.035;
    // ONE condition, and it is the pacing valve: when the valve opens, the
    // shot fires — full stop. No break-even reject, no other hard gate.
    // (Recovery uses the SAME budget; `opts.recovery` is accepted for call-site
    // compatibility and deliberately does not tighten anything.)
    const ready = this.valve.observe(p, opts?.recovery ? r * APEX_RECOVERY_PACE_FACTOR : r);
    const heat = this.hawkes.heat();
    return {
      digit,
      p,
      bar: this.valve.bar,
      ready,
      echo: lens.echo,
      hawkes: lens.hawkes,
      suffix: lens.suffix,
      ctw: lens.ctw,
      renewal: lens.renewal,
      fused,
      memoryOrder: lens.memoryOrder,
      memorySamples: Math.round(lens.memorySamples * 10) / 10,
      heatDigit: heat.digit,
      heatRatio: Math.round(heat.ratio * 100) / 100,
      ...(evDigit !== undefined ? { evDigit, evPayout } : {}),
    };
  }

  /** Read-only score for display (does NOT move the valve). */
  peek(history: ArrayLike<number>, idx: number, opts?: { payouts?: number[] }): { digit: number; p: number; fused: number[] } {
    const fused = this.fuse(history, idx).fused;
    const locked = this.params.lockedDigit;
    let digit = locked !== undefined ? locked : argmax(fused);
    if (opts?.payouts && locked === undefined) {
      let bestEV = -Infinity;
      for (let d = 0; d < 10; d++) {
        const pay = opts.payouts[d];
        if (!Number.isFinite(pay) || (pay as number) <= 0) continue;
        const ev = fused[d] * (pay as number);
        if (ev > bestEV) {
          bestEV = ev;
          digit = d;
        }
      }
    }
    return { digit, p: fused[digit], fused };
  }

  echoLags(count = 3): Array<{ lag: number; rate: number; z: number }> {
    return this.echo.topLags(count);
  }

  get bar(): number {
    return this.valve.bar;
  }
}

// ── Honest replay: the exact live policy, measured on unseen ticks ───────────

export interface ApexReplayMetrics {
  ticks: number;
  shots: number;
  hits: number;
  hitRate: number;
  hitRateLower: number;
  hitRateUpper: number;
  fireRate: number;
  edgePerDollar: number;
  /** Mean break-even rate across the fired shots (per-digit payouts). */
  breakEven: number;
  /** Mean payout multiplier actually carried by the fired shots. */
  meanPayout: number;
  brierSkill: number;
  avgP: number;
  lensLogLoss: number[];
}

export function replayPolicy(
  digits: ArrayLike<number>,
  params: ApexParams,
  opts?: { warmup?: number; payout?: number; payouts?: number[]; collect?: boolean },
): {
  metrics: ApexReplayMetrics;
  fused?: number[][];
  actual?: number[];
  scores?: number[];
  lensDists?: Array<{ lenses: number[][]; event: number }>;
  /** Mean fused probability per digit over every evaluated tick (test-half EV pick). */
  digitP?: number[];
} {
  const clean = cleanDigits(digits);
  const payout = opts?.payout ?? APEX_MATCH_PAYOUT;
  const payouts = opts?.payouts;
  const perDigitPay = (d: number): number => {
    const p = payouts?.[d];
    return Number.isFinite(p) && (p as number) > 0 ? (p as number) : payout;
  };
  const n = clean.length;
  const warmup = Math.min(Math.max(0, opts?.warmup ?? 300), Math.max(0, n - 50));
  const policy = new ApexPolicy(params);

  for (let i = 0; i < warmup; i++) policy.update(clean, i);

  let shots = 0;
  let hits = 0;
  let brierModel = 0;
  let brierBase = 0;
  let sumP = 0;
  const L = params.weights.length;
  const ll = new Array<number>(L).fill(0);
  let llN = 0;
  const fused: number[][] = [];
  const actual: number[] = [];
  const scores: number[] = [];
  const lensDists: Array<{ lenses: number[][]; event: number }> = [];
  // Mean fused probability per digit across ALL evaluated ticks — the raw
  // material for the held-out EV digit pick (each digit's average claimed
  // probability, unaffected by the argmax winner's curse because no
  // per-tick selection happens: every digit is measured on every tick).
  const digitP = new Array<number>(10).fill(0);
  let digitPN = 0;
  let shotPayoutSum = 0;

  for (let i = warmup; i < n - 1; i++) {
    const dec = policy.decide(clean, i, {
      // Live/replay parity: when the session quotes per-digit payouts, the
      // replayed policy must pick its digit with the SAME vector — otherwise
      // the measured shots describe a policy the live loop never runs.
      ...(payouts ? { payouts } : {}),
    });
    const next = clean[i + 1];
    const allLenses = [dec.echo, dec.hawkes, dec.suffix, dec.ctw, dec.renewal];
    for (let j = 0; j < L; j++) {
      ll[j] += -Math.log(Math.max(1e-9, allLenses[j]?.[next] ?? 1e-9));
    }
    llN++;
    for (let d = 0; d < 10; d++) digitP[d] += dec.fused[d];
    digitPN++;
    if (opts?.collect) {
      fused.push(dec.fused);
      actual.push(next);
      scores.push(params.lockedDigit !== undefined ? dec.fused[params.lockedDigit] : dec.p);
      lensDists.push({ lenses: allLenses.slice(0, L), event: next });
    }
    if (dec.ready) {
      shots++;
      sumP += dec.p;
      shotPayoutSum += perDigitPay(dec.digit);
      const hit = next === dec.digit ? 1 : 0;
      hits += hit;
      brierModel += hit ? (1 - dec.p) * (1 - dec.p) : dec.p * dec.p;
      brierBase += hit ? 0.9 * 0.9 : 0.1 * 0.1;
    }
    policy.update(clean, i + 1);
  }

  const measured = Math.max(1, n - 1 - warmup);
  const hitRate = shots > 0 ? hits / shots : 0;
  const w = wilson(hits, shots);
  // Per-shot EV with the live payout schedule: each fired shot is priced at
  // its OWN digit's multiplier (fallback `payout` when no schedule given).
  const meanPayout = shots > 0 ? Math.round((shotPayoutSum / shots) * 1000) / 1000 : payout;
  const breakEvenEffective = 1 / meanPayout;
  const edgePerDollar = shots > 0 ? hitRate * meanPayout - 1 : 0;
  const metrics: ApexReplayMetrics = {
    ticks: measured,
    shots,
    hits,
    hitRate,
    hitRateLower: shots > 0 ? w.lower : 0,
    hitRateUpper: shots > 0 ? w.upper : 1,
    fireRate: shots / measured,
    edgePerDollar,
    breakEven: breakEvenEffective,
    meanPayout,
    brierSkill: brierBase > 0 ? 1 - brierModel / brierBase : 0,
    avgP: shots > 0 ? sumP / shots : 0,
    lensLogLoss: llN > 0 ? ll.map(v => v / llN) : new Array<number>(L).fill(Math.log(10)),
  };
  return {
    metrics,
    fused: opts?.collect ? fused : undefined,
    actual: opts?.collect ? actual : undefined,
    scores: opts?.collect ? scores : undefined,
    lensDists: opts?.collect ? lensDists : undefined,
    digitP: digitPN > 0 ? digitP.map(v => v / digitPN) : undefined,
  };
}

// ── Fit on train, measure on held-out test ────────────────────────────────────

export interface ApexFit {
  params: ApexParams;
  train: ApexReplayMetrics;
  test: ApexReplayMetrics;
  /** Mean fused probability per digit over the held-out test half. */
  digitP?: number[];
}

const TAU_GRID = [0.6, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.8, 2.2, 2.6];

export function fitApexParams(
  digits: ArrayLike<number>,
  pace: ApexPace,
  opts?: { lockedDigit?: number; payout?: number; payouts?: number[] },
): ApexFit {
  const clean = cleanDigits(digits);
  const payout = opts?.payout ?? APEX_MATCH_PAYOUT;
  const payouts = opts?.payouts;
  const lockedDigit = opts?.lockedDigit;
  const split = Math.floor(clean.length * APEX_TRAIN_FRACTION);
  const train = clean.slice(0, split);
  const test = clean.slice(split);

  if (clean.length < APEX_MIN_FIT_DIGITS || train.length < 200 || test.length < 100) {
    // Too thin to fit — measure defaults honestly on everything available.
    const params = defaultApexParams(pace, lockedDigit);
    const { metrics } = replayPolicy(clean, params, {
      warmup: Math.min(200, Math.floor(clean.length / 3)), payout, payouts,
    });
    return { params, train: metrics, test: metrics };
  }

  const { alpha, beta } = fitHawkes(train);

  // One equal-weight train pass: per-lens log-loss + stored lens dists.
  const probe = defaultApexParams(pace, lockedDigit);
  probe.alpha = alpha;
  probe.beta = beta;
  const collected = replayPolicy(train, probe, { warmup: 300, payout, payouts, collect: true });
  const skillWeights = weightsFromSkill(collected.metrics.lensLogLoss);

  // Stage 2: coordinate descent on the simplex — joint minimisation of the
  // pooled train log-loss AND the top-1 (selection-event) Brier over
  // (weights, τ). Starts from the skill weights, keeps every lens alive at
  // the floor, and re-sweeps the temperature grid between rounds.
  const samples = (collected.lensDists ?? []).map(s => ({ lenses: s.lenses, event: s.event }));
  // The FULL τ grid is in play again (0.6–2.6). The old hard [1, 1.5] cap
  // existed because a pure log-loss τ could not be trusted below 1 — measured
  // on fair tapes it sharpened noise into fake skill. The top-1 Brier term in
  // the objective now prices exactly that risk: on fair tapes the optimiser
  // drifts to the soft end (the argmax claim must be honest), and on a
  // planted-echo tape it earns τ ≈ 0.73 and claims the structure at its true
  // strength. Sharpening has to PAY for itself in decision-calibration.
  const refined = samples.length > 200
    ? optimizePoolWeights(samples, skillWeights, 1, TAU_GRID)
    : { weights: skillWeights, tau: 1 };
  const weights = refined.weights;
  let tau = refined.tau;

  // Reference fused/actual collections (kept for the valve seed below).
  const fused = collected.fused ?? [];
  const actual = collected.actual ?? [];

  // Valve seed: the (1 − target) quantile of the FINAL policy's scores —
  // temperature-scaled at the chosen τ with the chosen digit (locked or the
  // calibrated argmax). The old seed took that quantile from the PROBE's
  // uncalibrated scores; whenever τ > 1 softened the pool the bar landed ABOVE
  // the live score mass, and the 20–45s re-fit kept resetting the valve back
  // to that unreachable seed — a perpetual cold start that starved the bot of
  // every trade no matter which pace was selected.
  const target = APEX_PACE_TARGET[pace] ?? 0.035;
  const seedDists = (collected.lensDists ?? []).length === fused.length
    ? (collected.lensDists ?? []).map(s => temperatureScale(logPool(s.lenses, weights), tau))
    : fused.map(d => temperatureScale(d, tau));
  const finalScores: number[] = [];
  for (let i = 0; i < seedDists.length; i++) {
    finalScores.push(lockedDigit !== undefined ? seedDists[i][lockedDigit] : seedDists[i][argmax(seedDists[i])]);
  }
  finalScores.sort((a, b) => a - b);
  const initBar = finalScores.length > 0
    ? quantile(finalScores, 1 - target)
    : APEX_FAIR_RATE + 0.005;

  const params: ApexParams = { alpha, beta, weights, tau, initBar, pace, ...(lockedDigit !== undefined ? { lockedDigit } : {}) };
  const { metrics: testMetrics, digitP } = replayPolicy(test, params, { warmup: Math.min(300, Math.floor(test.length / 3)), payout, payouts });
  return { params, train: collected.metrics, test: testMetrics, digitP };
}

// ── One-market scan read ──────────────────────────────────────────────────────

export interface ApexDiag {
  echoLags: Array<{ lag: number; rate: number; z: number }>;
  heatDigit: number;
  heatRatio: number;
  memoryOrder: number;
  memorySamples: number;
  weights: number[];
  tau: number;
  fireRate: number;
  brierSkill: number;
  historyUsed: number;
}

export interface ApexMarketRead {
  digit: number;
  verdict: ApexVerdict;
  confidence: number;
  edgePerDollar: number;
  hitRate: number;
  hitRateLower: number;
  shots: number;
  fireRate: number;
  breakEven: number;
  payout: number;
  /** Live per-digit payout schedule used for the EV pick, when quoted. */
  payouts?: number[];
  params: ApexParams;
  train: ApexReplayMetrics;
  diag: ApexDiag;
  thinData: boolean;
}

export function scoreMarket(
  digits: ArrayLike<number>,
  pace: ApexPace,
  opts?: { lockedDigit?: number; payout?: number; payouts?: number[] },
): ApexMarketRead {
  const clean = cleanDigits(digits);
  const payout = opts?.payout ?? APEX_MATCH_PAYOUT;
  const payouts = opts?.payouts;
  const perDigitPay = (d: number): number => {
    const p = payouts?.[d];
    return Number.isFinite(p) && (p as number) > 0 ? (p as number) : payout;
  };
  const lockedDigit = opts?.lockedDigit;
  const thinData = clean.length < APEX_MIN_MEASURE_DIGITS;

  const fit = fitApexParams(clean, pace, { lockedDigit, payout, payouts });
  const m = fit.test;

  // ── AI digit pick — HELD-OUT EV, not the full-data argmax ──
  // The old pick ran the fitted lenses over the ENTIRE tape and took the
  // fused argmax: the max of 10 correlated in-sample estimates, which is
  // exactly the winner's curse (measured: claims 12.7% on fair tapes,
  // realizes 10.3%). The honest replay has ALREADY measured every digit's
  // mean fused probability on the unseen test half (fit.digitP) — combining
  // that with the live payout schedule picks argmax E[p_d]·pay_d with no
  // per-tick selection bias. Falls back to the warmed full-data peek only
  // when the test half was too thin to accumulate.
  let digit = lockedDigit ?? 0;
  let memOrder = 0;
  let memSamples = 0;
  let heatDigit = 0;
  let heatRatio = 1;
  let echoLags: Array<{ lag: number; rate: number; z: number }> = [];
  const policy = clean.length > 60 ? new ApexPolicy(fit.params) : null;
  if (policy) {
    for (let i = 0; i < clean.length; i++) policy.update(clean, i);
    if (lockedDigit === undefined) {
      const payVec = Array.from({ length: 10 }, (_, d) => perDigitPay(d));
      let bestEV = -Infinity;
      if (fit.digitP) {
        for (let d = 0; d < 10; d++) {
          const ev = fit.digitP[d] * payVec[d];
          if (ev > bestEV) {
            bestEV = ev;
            digit = d;
          }
        }
      } else {
        digit = policy.peek(clean, clean.length - 1, { payouts: payVec }).digit;
      }
    } else {
      digit = lockedDigit;
    }
    const dec = policy.decide(clean, clean.length - 1, { payouts: Array.from({ length: 10 }, (_, d) => perDigitPay(d)) });
    memOrder = dec.memoryOrder;
    memSamples = dec.memorySamples;
    heatDigit = dec.heatDigit;
    heatRatio = dec.heatRatio;
    echoLags = policy.echoLags(3);
  }

  // The break-even that matters is the one the CHOSEN digit must clear at
  // its quoted multiplier; the replay's effective break-even (mean over the
  // fired shots' payouts) backs the verdict ladder.
  const breakEven = 1 / perDigitPay(digit);

  // Verdict ladder — measurement honesty, not trade gating (the live valve
  // paces regardless; these labels only describe what was MEASURED):
  //   PRIME  = statistical proof of edge (95% lower bound clears break-even)
  //   VIABLE = positive measured expectancy with real mass (12+ shots)
  //   THIN   = everything else — including lucky 2-hits-in-5 noise.
  let verdict: ApexVerdict;
  if (!thinData && m.edgePerDollar >= 0.01 && m.shots >= 8 && m.hitRateLower >= m.breakEven) verdict = "prime";
  else if (!thinData && m.edgePerDollar > 0 && m.shots >= 12) verdict = "viable";
  else verdict = "thin";

  let confidence: number;
  if (verdict === "prime") confidence = 72 + Math.min(23, Math.round(m.edgePerDollar * 400));
  else if (verdict === "viable") confidence = 48 + Math.min(20, Math.round(m.edgePerDollar * 400));
  else confidence = Math.max(15, Math.min(44, 30 + Math.round(m.edgePerDollar * 300)));
  if (thinData) confidence = Math.min(confidence, 35);

  return {
    digit,
    verdict,
    confidence,
    edgePerDollar: Math.round(m.edgePerDollar * 10000) / 10000,
    hitRate: Math.round(m.hitRate * 10000) / 10000,
    hitRateLower: Math.round(m.hitRateLower * 10000) / 10000,
    shots: m.shots,
    fireRate: Math.round(m.fireRate * 10000) / 10000,
    breakEven: Math.round(breakEven * 10000) / 10000,
    payout: perDigitPay(digit),
    ...(payouts ? { payouts: [...payouts] } : {}),
    params: fit.params,
    train: fit.train,
    diag: {
      echoLags,
      heatDigit,
      heatRatio,
      memoryOrder: memOrder,
      memorySamples: memSamples,
      weights: fit.params.weights,
      tau: Math.round(fit.params.tau * 100) / 100,
      fireRate: Math.round(m.fireRate * 10000) / 10000,
      brierSkill: Math.round(m.brierSkill * 1000) / 1000,
      historyUsed: clean.length,
    },
    thinData,
  };
}
