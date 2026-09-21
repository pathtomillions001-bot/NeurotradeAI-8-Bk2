/**
 * ECHO APEX — institutional Matches analysis core.
 *
 * A Matches contract pays ~8.93×, so the entire game is P(next digit == d):
 * anything reliably above 1/8.93 ≈ 11.2% is edge. Three independent lenses
 * measure that probability from three different structures in the digit stream:
 *
 *  1. ECHO SPECTRUM — for lags 1..48, the recency-weighted probability that a
 *     digit repeats exactly k ticks later, plus a per-digit affinity prior.
 *     A digit that "echoes" at its characteristic lags is tilted up; lags
 *     running below fair tilt down. A full 48-lag spectrum, not a lag-1..3
 *     vector, and every lag carries its own effective sample size.
 *  2. HAWKES HEAT — each digit's arrivals drive a self-exciting point process
 *     (λ_d = μ + Σ α·e^(−β·Δt)) with (α, β) fitted per market by grid
 *     maximum-likelihood. It answers "how hot is this digit RIGHT NOW" from
 *     its own arrival times, including how fast heat decays on this market.
 *  3. SUFFIX MEMORY — a decayed longest-match continuation table over contexts
 *     of length 1..5: "every time THESE exact digits just printed, what came
 *     next?" Hard longest-match with lazy exponential decay and Laplace
 *     smoothing — no fixed window, no Bayesian order-mixing.
 *
 * The lenses fuse through a LOGARITHMIC OPINION POOL (externally Bayesian: the
 * pool stays coherent when every lens observes the same new tick) with weights
 * from each lens's measured log-loss skill on the scan's training half, then a
 * single temperature scale calibrates the fused distribution.
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

  constructor(
    private alpha: number,
    private beta: number,
    private mu = 0.1,
  ) {
    this.lam = new Float64Array(10).fill(mu);
  }

  update(d: number): void {
    if (!Number.isInteger(d) || d < 0 || d > 9) return;
    const f = Math.exp(-this.beta);
    for (let i = 0; i < 10; i++) this.lam[i] = this.mu + (this.lam[i] - this.mu) * f;
    this.lam[d] += this.alpha;
  }

  /** Current heat, normalised to a distribution over the next digit. */
  probs(): number[] {
    const out = Array.from(this.lam);
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
        const p = bank.probs();
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
   * P(next digit) from the longest context of history[0..idx] with enough
   * (decayed) samples. Laplace α=1 keeps unseen continuations honest.
   */
  predict(history: ArrayLike<number>, idx: number): { probs: number[]; order: number; samples: number } {
    for (let o = this.maxOrder; o >= 1; o--) {
      if (idx - o + 1 < 0) continue;
      const e = this.tables.get(SuffixMemory.key(history, idx + 1, o));
      if (!e) continue;
      const f = Math.pow(this.decayPerTick, Math.max(0, this.tick - e.seen));
      const total = e.total * f;
      if (total < this.minSamples) continue;
      const probs = new Array<number>(10);
      let s = 0;
      for (let d = 0; d < 10; d++) {
        probs[d] = e.counts[d] * f + 0.1;
        s += probs[d];
      }
      for (let d = 0; d < 10; d++) probs[d] /= s;
      return { probs, order: o, samples: total };
    }
    return { probs: uniform10(), order: 0, samples: 0 };
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

/**
 * Lens weights from measured log-loss skill (nats saved vs the uniform
 * baseline), soft-maxed with a 5% floor so no lens ever dies completely.
 */
export function weightsFromSkill(logLosses: number[], baseline = Math.log(10)): [number, number, number] {
  const skills = logLosses.map(ll => baseline - ll);
  const w = softmax(skills.map(s => s / 0.05));
  const floored = w.map(v => 0.05 + 0.85 * v);
  const s = floored.reduce((a, b) => a + b, 0) || 1;
  return [floored[0] / s, floored[1] / s, floored[2] / s];
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
  weights: [number, number, number];
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
  fused: number[];
  memoryOrder: number;
  memorySamples: number;
  heatDigit: number;
  heatRatio: number;
}

export function defaultApexParams(pace: ApexPace, lockedDigit?: number): ApexParams {
  return {
    alpha: 0.1,
    beta: 0.25,
    weights: [0.4, 0.3, 0.3],
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
  if (!w || w.length !== 3 || w.some((v: number | null) => v === null)) return null;
  if (alpha < 0 || alpha > 2 || beta <= 0 || beta > 5) return null;
  if (tau < 0.3 || tau > 3 || initBar < 0 || initBar > 1) return null;
  const sum = (w[0] as number) + (w[1] as number) + (w[2] as number);
  if (!(sum > 0)) return null;
  return {
    alpha,
    beta,
    weights: [(w[0] as number) / sum, (w[1] as number) / sum, (w[2] as number) / sum],
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
  private valve: PacingValve;
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
  }

  get fitted(): ApexParams {
    return this.params;
  }

  /** Feed history[idx] as the newly observed digit. */
  update(history: ArrayLike<number>, idx: number): void {
    this.echo.update(history, idx);
    this.memory.update(history, idx);
    const d = history[idx];
    if (Number.isInteger(d) && d >= 0 && d <= 9) this.hawkes.update(d);
  }

  /**
   * Score the next digit after history[0..idx]. Call EXACTLY once per new
   * tick — the valve adapts its bar on every call.
   */
  decide(history: ArrayLike<number>, idx: number, opts?: { recovery?: boolean }): ApexDecision {
    const echo = this.echo.score(history, idx);
    const hawkes = this.hawkes.probs();
    const mem = this.memory.predict(history, idx);
    const fused = temperatureScale(logPool([echo, hawkes, mem.probs], this.params.weights), this.params.tau);
    const locked = this.params.lockedDigit;
    const digit = locked !== undefined ? locked : argmax(fused);
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
      echo,
      hawkes,
      suffix: mem.probs,
      fused,
      memoryOrder: mem.order,
      memorySamples: Math.round(mem.samples * 10) / 10,
      heatDigit: heat.digit,
      heatRatio: Math.round(heat.ratio * 100) / 100,
    };
  }

  /** Read-only score for display (does NOT move the valve). */
  peek(history: ArrayLike<number>, idx: number): { digit: number; p: number; fused: number[] } {
    const echo = this.echo.score(history, idx);
    const hawkes = this.hawkes.probs();
    const mem = this.memory.predict(history, idx);
    const fused = temperatureScale(logPool([echo, hawkes, mem.probs], this.params.weights), this.params.tau);
    const locked = this.params.lockedDigit;
    const digit = locked !== undefined ? locked : argmax(fused);
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
  brierSkill: number;
  avgP: number;
  lensLogLoss: [number, number, number];
}

export function replayPolicy(
  digits: ArrayLike<number>,
  params: ApexParams,
  opts?: { warmup?: number; payout?: number; collect?: boolean },
): { metrics: ApexReplayMetrics; fused?: number[][]; actual?: number[]; scores?: number[] } {
  const clean = cleanDigits(digits);
  const payout = opts?.payout ?? APEX_MATCH_PAYOUT;
  const n = clean.length;
  const warmup = Math.min(Math.max(0, opts?.warmup ?? 300), Math.max(0, n - 50));
  const policy = new ApexPolicy(params);

  for (let i = 0; i < warmup; i++) policy.update(clean, i);

  let shots = 0;
  let hits = 0;
  let brierModel = 0;
  let brierBase = 0;
  let sumP = 0;
  const ll = [0, 0, 0];
  let llN = 0;
  const fused: number[][] = [];
  const actual: number[] = [];
  const scores: number[] = [];

  for (let i = warmup; i < n - 1; i++) {
    const dec = policy.decide(clean, i);
    const next = clean[i + 1];
    ll[0] += -Math.log(Math.max(1e-9, dec.echo[next]));
    ll[1] += -Math.log(Math.max(1e-9, dec.hawkes[next]));
    ll[2] += -Math.log(Math.max(1e-9, dec.suffix[next]));
    llN++;
    if (opts?.collect) {
      fused.push(dec.fused);
      actual.push(next);
      scores.push(params.lockedDigit !== undefined ? dec.fused[params.lockedDigit] : dec.p);
    }
    if (dec.ready) {
      shots++;
      sumP += dec.p;
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
  const edgePerDollar = shots > 0 ? hitRate * (payout - 1) - (1 - hitRate) : 0;
  const metrics: ApexReplayMetrics = {
    ticks: measured,
    shots,
    hits,
    hitRate,
    hitRateLower: shots > 0 ? w.lower : 0,
    hitRateUpper: shots > 0 ? w.upper : 1,
    fireRate: shots / measured,
    edgePerDollar,
    brierSkill: brierBase > 0 ? 1 - brierModel / brierBase : 0,
    avgP: shots > 0 ? sumP / shots : 0,
    lensLogLoss: llN > 0 ? [ll[0] / llN, ll[1] / llN, ll[2] / llN] : [Math.log(10), Math.log(10), Math.log(10)],
  };
  return { metrics, fused: opts?.collect ? fused : undefined, actual: opts?.collect ? actual : undefined, scores: opts?.collect ? scores : undefined };
}

// ── Fit on train, measure on held-out test ────────────────────────────────────

export interface ApexFit {
  params: ApexParams;
  train: ApexReplayMetrics;
  test: ApexReplayMetrics;
}

const TAU_GRID = [0.6, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.8, 2.2, 2.6];

export function fitApexParams(
  digits: ArrayLike<number>,
  pace: ApexPace,
  opts?: { lockedDigit?: number; payout?: number },
): ApexFit {
  const clean = cleanDigits(digits);
  const payout = opts?.payout ?? APEX_MATCH_PAYOUT;
  const lockedDigit = opts?.lockedDigit;
  const split = Math.floor(clean.length * APEX_TRAIN_FRACTION);
  const train = clean.slice(0, split);
  const test = clean.slice(split);

  if (clean.length < APEX_MIN_FIT_DIGITS || train.length < 200 || test.length < 100) {
    // Too thin to fit — measure defaults honestly on everything available.
    const params = defaultApexParams(pace, lockedDigit);
    const { metrics } = replayPolicy(clean, params, { warmup: Math.min(200, Math.floor(clean.length / 3)), payout });
    return { params, train: metrics, test: metrics };
  }

  const { alpha, beta } = fitHawkes(train);

  // One equal-weight train pass: per-lens log-loss + stored fused dists.
  const probe = defaultApexParams(pace, lockedDigit);
  probe.alpha = alpha;
  probe.beta = beta;
  const collected = replayPolicy(train, probe, { warmup: 300, payout, collect: true });
  const weights = weightsFromSkill(collected.metrics.lensLogLoss);

  // Temperature on the stored fused distributions (no re-simulation needed).
  let tau = 1;
  let bestLL = Infinity;
  const fused = collected.fused ?? [];
  const actual = collected.actual ?? [];
  for (const t of TAU_GRID) {
    let ll = 0;
    for (let i = 0; i < fused.length; i++) {
      const cal = temperatureScale(fused[i], t);
      ll += -Math.log(Math.max(1e-9, cal[actual[i]]));
    }
    if (ll < bestLL) {
      bestLL = ll;
      tau = t;
    }
  }

  // Valve seed: the (1 − target) quantile of the FINAL policy's scores —
  // temperature-scaled at the chosen τ with the chosen digit (locked or the
  // calibrated argmax). The old seed took that quantile from the PROBE's
  // uncalibrated scores; whenever τ > 1 softened the pool the bar landed ABOVE
  // the live score mass, and the 20–45s re-fit kept resetting the valve back
  // to that unreachable seed — a perpetual cold start that starved the bot of
  // every trade no matter which pace was selected.
  const target = APEX_PACE_TARGET[pace] ?? 0.035;
  const finalScores: number[] = [];
  for (let i = 0; i < fused.length; i++) {
    const cal = temperatureScale(fused[i], tau);
    finalScores.push(lockedDigit !== undefined ? cal[lockedDigit] : cal[argmax(cal)]);
  }
  finalScores.sort((a, b) => a - b);
  const initBar = finalScores.length > 0
    ? quantile(finalScores, 1 - target)
    : APEX_FAIR_RATE + 0.005;

  const params: ApexParams = { alpha, beta, weights, tau, initBar, pace, ...(lockedDigit !== undefined ? { lockedDigit } : {}) };
  const { metrics: testMetrics } = replayPolicy(test, params, { warmup: Math.min(300, Math.floor(test.length / 3)), payout });
  return { params, train: collected.metrics, test: testMetrics };
}

// ── One-market scan read ──────────────────────────────────────────────────────

export interface ApexDiag {
  echoLags: Array<{ lag: number; rate: number; z: number }>;
  heatDigit: number;
  heatRatio: number;
  memoryOrder: number;
  memorySamples: number;
  weights: [number, number, number];
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
  params: ApexParams;
  train: ApexReplayMetrics;
  diag: ApexDiag;
  thinData: boolean;
}

export function scoreMarket(
  digits: ArrayLike<number>,
  pace: ApexPace,
  opts?: { lockedDigit?: number; payout?: number },
): ApexMarketRead {
  const clean = cleanDigits(digits);
  const payout = opts?.payout ?? APEX_MATCH_PAYOUT;
  const breakEven = 1 / payout;
  const lockedDigit = opts?.lockedDigit;
  const thinData = clean.length < APEX_MIN_MEASURE_DIGITS;

  const fit = fitApexParams(clean, pace, { lockedDigit, payout });
  const m = fit.test;

  // AI digit pick: the fused argmax on the full warmed state (or the lock).
  let digit = lockedDigit ?? 0;
  let memOrder = 0;
  let memSamples = 0;
  let heatDigit = 0;
  let heatRatio = 1;
  let echoLags: Array<{ lag: number; rate: number; z: number }> = [];
  if (lockedDigit === undefined && clean.length > 60) {
    const policy = new ApexPolicy(fit.params);
    for (let i = 0; i < clean.length; i++) policy.update(clean, i);
    const peek = policy.peek(clean, clean.length - 1);
    digit = peek.digit;
    const dec = policy.decide(clean, clean.length - 1);
    memOrder = dec.memoryOrder;
    memSamples = dec.memorySamples;
    heatDigit = dec.heatDigit;
    heatRatio = dec.heatRatio;
    echoLags = policy.echoLags(3);
  } else if (clean.length > 60) {
    const policy = new ApexPolicy(fit.params);
    for (let i = 0; i < clean.length; i++) policy.update(clean, i);
    const dec = policy.decide(clean, clean.length - 1);
    digit = lockedDigit as number;
    memOrder = dec.memoryOrder;
    memSamples = dec.memorySamples;
    heatDigit = dec.heatDigit;
    heatRatio = dec.heatRatio;
    echoLags = policy.echoLags(3);
  }

  // Verdict ladder — measurement honesty, not trade gating (the live valve
  // paces regardless; these labels only describe what was MEASURED):
  //   PRIME  = statistical proof of edge (95% lower bound clears break-even)
  //   VIABLE = positive measured expectancy with real mass (12+ shots)
  //   THIN   = everything else — including lucky 2-hits-in-5 noise.
  let verdict: ApexVerdict;
  if (!thinData && m.edgePerDollar >= 0.01 && m.shots >= 8 && m.hitRateLower >= breakEven) verdict = "prime";
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
    payout,
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
