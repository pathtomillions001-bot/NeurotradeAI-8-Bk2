/**
 * PARITY FORGE — Even/Odd parity specialist with recovery-first intelligence.
 *
 * Normal:   Even (DIGITEVEN) / Odd (DIGITODD)  — 50% each, 1.95×
 * Recovery: Even / Odd                         — same contracts, different selection
 *
 * The whole edge of this bot lives in its RECOVERY quality: the ladder dies to
 * loss PAIRS, so everything below is built to pick the recovery side with the
 * highest payoff-weighted probability AND the lowest probability of extending
 * a loss run. Four independent lenses read the parity win event from a
 * different structure of the digit tape:
 *
 *  1. PARITY MARKOV — order-1..2 chains over the 2-state parity process with
 *     Jeffreys Dirichlet smoothing and count-mixed order shrinkage; P(Even) is
 *     the parity transition mass. Roughly 5× the samples/state of a 10-state
 *     digit matrix, which is what funds the edge on a 50/50 contract.
 *  2. RUN HAZARD — the parity losing run's age is scored by a Kaplan–Meier
 *     discrete hazard over the censored run-length history; P(win) = 1 − h(age).
 *     This is the strongest serial signal for a parity bet ("odds have run 5
 *     — how likely does even arrive now").
 *  3. DIGIT-PARITY — P(parity | last digit) via Jeffreys Dirichlet: the 10
 *     digits collapse into parity, so the 2×10 table sees which last digits
 *     tilt the NEXT parity (a digit-conditioned bias invisible to the pure
 *     parity chain).
 *  4. SUFFIX MEMORY — decayed longest-match continuation (orders 2–5) over
 *     exact digit contexts, Laplace-smoothed: what parity followed THIS
 *     suffix before, with exponential half-life so recent structure weighs more.
 *
 * The lenses fuse through a LOGARITHMIC OPINION POOL in logit space (externally
 * Bayesian for Bernoulli events). Weights START from each lens's measured
 * log-loss skill and are then REFINED by coordinate descent on the simplex —
 * direct minimisation of the pooled train log-loss (the logarithmic score, a
 * proper scoring rule) with a KL-to-uniform complexity penalty so the fit can
 * never pay for noise it discovered — plus one temperature calibration
 * (τ ≥ 1: honest calibration may soften, never sharpen). Agreement across
 * lenses is what makes a shot safe.
 *
 * SIX lenses now feed the pool (the original four plus two universal
 * predictors):
 *  5. PARITY CTW — a binary Context-Tree-Weighting mixture over EVERY parity
 *     chain of order 0..12 (KT node estimators, ½/½ tree prior, proven
 *     per-sequence log-loss regret bounds). Where the Markov lens hard-codes
 *     orders 1–2, CTW softly blends all depths at once — the principled
 *     "which order is right?" answer: you never pick.
 *  6. PARITY ECHO SPECTRUM — recency-weighted P(p_t == p_{t−k}) for lags
 *     1..24. Cyclic alternation ("even, odd, even, odd…" with period k) is
 *     invisible to order-1/2 chains and only crudely caught by the run
 *     hazard; the echo spectrum reads it directly, per lag, with its own
 *     effective sample size.
 * The digit lens also deepened: P(parity | last TWO digits) with backoff
 * through P(parity | last digit) to fair — 100 contexts, Jeffreys-smoothed,
 * so digit-conditioned parity flips (9→even runs, 1→odd runs…) register.
 * And q_LL — the loss-pair risk price — is no longer a bare order-1 chain
 * estimate: it is the FUSED probability of the opposite side, i.e. the full
 * six-lens model's own belief about the loss repeating.
 *
 * SELECTION (the recovery-first policy):
 *  - The side is chosen by utility = (p·payout − 1) − λ·P(loss)·min(q_LL, .95),
 *    where λ is bigger in recovery: a loss pair is exactly what deepens the
 *    shared recovery ladder, so the penalty targets consecutive recovery losses.
 *  - Normal shots ride a two-way pacing VALVE (budget 0.20 shots/tick, zero
 *    floor): selectivity is a budget, never a stack of vetoes.
 *  - Recovery shots use ONE static quality bar (the break-even rate 1/1.95):
 *    the best available shot fires THE NEXT TICK it clears the bar —
 *    THERE IS NO POST-LOSS TIGHTENING ANYWHERE IN THIS FILE. No function on the
 *    recovery path even accepts a loss-run argument; the bar cannot harden
 *    after a recovery loss because it is a frozen constant. If no side clears
 *    the bar the bot waits (and, in switching mode, hunts a better market).
 *
 * HONEST MEASUREMENT — `fitParityForgeParams` fits weights/τ on the first 60%
 * and `replayParityForge` replays the EXACT live policy (paper session,
 * normal → loss → recovery → clear) on the final 40%: normal hit rate,
 * RECOVERY hit rate, RECOVERY LOSS PAIRS and ticks spent in debt, per market.
 * Verdicts (PRIME / VIABLE / THIN) describe what was measured — labels only,
 * never a deploy gate.
 *
 * Everything here is pure and synchronous: no Deriv imports, no DB, no clock.
 */

// ── Frozen contracts ─────────────────────────────────────────────────────────

export type ParityForgeContractId = "even" | "odd";
export type ParityForgeMode = "normal" | "recovery";
export type ParityForgeSideMode = "both" | "even" | "odd";
export type ParityForgeVerdict = "prime" | "viable" | "thin";

export interface ParityForgeContract {
  id: ParityForgeContractId;
  mode: ParityForgeMode;
  contractType: "DIGITEVEN" | "DIGITODD";
  label: string;
  /** Win-set membership by digit. */
  wins: readonly boolean[];
  /** Combinatorial fair rate (wins / 10). */
  fair: number;
  /** Canonical fallback payout (live quotes override at execution). */
  payout: number;
}

const W = (win: readonly number[]): readonly boolean[] =>
  Object.freeze(Array.from({ length: 10 }, (_, d) => win.includes(d)));

// Even wins on 0,2,4,6,8 — Odd wins on 1,3,5,7,9
export const PARITY_FORGE_NORMAL_CONTRACTS: readonly ParityForgeContract[] = Object.freeze([
  {
    id: "even", mode: "normal", contractType: "DIGITEVEN", label: "Even",
    wins: W([0, 2, 4, 6, 8]), fair: 0.5, payout: 1.95,
  },
  {
    id: "odd", mode: "normal", contractType: "DIGITODD", label: "Odd",
    wins: W([1, 3, 5, 7, 9]), fair: 0.5, payout: 1.95,
  },
]);

export const PARITY_FORGE_RECOVERY_CONTRACTS: readonly ParityForgeContract[] = Object.freeze([
  {
    id: "even", mode: "recovery", contractType: "DIGITEVEN", label: "Even",
    wins: W([0, 2, 4, 6, 8]), fair: 0.5, payout: 1.95,
  },
  {
    id: "odd", mode: "recovery", contractType: "DIGITODD", label: "Odd",
    wins: W([1, 3, 5, 7, 9]), fair: 0.5, payout: 1.95,
  },
]);

export const PARITY_FORGE_ALL_CONTRACTS: readonly ParityForgeContract[] = Object.freeze([
  ...PARITY_FORGE_NORMAL_CONTRACTS,
  ...PARITY_FORGE_RECOVERY_CONTRACTS,
]);

export function parityForgeContractById(id: ParityForgeContractId, mode: ParityForgeMode = "normal"): ParityForgeContract {
  const pool = mode === "recovery" ? PARITY_FORGE_RECOVERY_CONTRACTS : PARITY_FORGE_NORMAL_CONTRACTS;
  const c = pool.find(x => x.id === id);
  if (!c) throw new Error(`unknown parity-forge contract: ${id} (${mode})`);
  return c;
}

/**
 * THE recovery quality bar — the parity break-even rate. STATIC.
 * Frozen by design: recovery fires the best shot the moment its fused win
 * probability beats break-even (1/1.95 = 51.28%), and NOTHING — least of all
 * the current loss run — is allowed to move this. For a 50/50 fair contract
 * the fair rate (0.5) would be loss-making at the 1.95× payout, so the bar
 * sits at break-even with a tiny cushion. It is not even a parameter of
 * `decideRecovery`.
 */
export const PARITY_FORGE_RECOVERY_BAR = 0.52;
/** Normal shots ride the pacing valve at this budget (shots per tick). */
export const PARITY_FORGE_NORMAL_PACE_TARGET = 0.2;
/** Loss-pair penalty weight in the recovery utility (per unit pair-risk). */
export const PARITY_FORGE_RECOVERY_PAIR_WEIGHT = 0.45;
/** Lighter loss-pair penalty for normal side arbitration. */
export const PARITY_FORGE_NORMAL_PAIR_WEIGHT = 0.15;

export const PARITY_FORGE_TRAIN_FRACTION = 0.6;
export const PARITY_FORGE_MIN_FIT_DIGITS = 600;
export const PARITY_FORGE_MIN_MEASURE_DIGITS = 300;

/** Binary CTW context depth (mixture over ALL parity chain orders 0..this). */
export const PARITY_FORGE_CTW_DEPTH = 12;
export const PARITY_FORGE_CTW_MAX_NODES = 60_000;
/** Parity echo spectrum length. */
export const PARITY_FORGE_ECHO_LAGS = 24;
export const PARITY_FORGE_ECHO_HALFLIFE_TICKS = 420;
/** Lens fusion: floor per lens and the lens count/names. */
export const PARITY_FORGE_LENS_FLOOR = 0.05;
export const PARITY_FORGE_LENS_COUNT = 6;
export const PARITY_FORGE_LENS_NAMES = [
  "parityMkv", "runHazard", "digitPair", "suffix", "parityCTW", "echo",
] as const;

// ── Small math helpers ────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

export function logit(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
}

/** Logarithmic opinion pool for Bernoulli events (weighted mean of logits). */
export function logPoolBinary(ps: readonly number[], weights: readonly number[]): number {
  let s = 0;
  let w = 0;
  for (let i = 0; i < ps.length; i++) {
    const wi = weights[i] ?? 0;
    s += wi * logit(ps[i]!);
    w += wi;
  }
  return w > 0 ? sigmoid(s / w) : 0.5;
}

/** Softmax skill → lens weights with a 5% floor so no lens ever dies. */
export function weightsFromSkillN(logLosses: readonly number[], baseline: number): number[] {
  const skills = logLosses.map(ll => baseline - ll);
  const mx = Math.max(...skills);
  const exps = skills.map(s => Math.exp((s - mx) / 0.05));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const L = logLosses.length;
  const floored = exps.map(v => PARITY_FORGE_LENS_FLOOR + (1 - PARITY_FORGE_LENS_FLOOR * L) * (v / sum));
  const s2 = floored.reduce((a, b) => a + b, 0) || 1;
  return floored.map(v => v / s2);
}

/** Binary event temperature scaling: soften/sharpen around 0.5 via logit/τ. */
export function temperatureScaleBinary(p: number, tau: number): number {
  const t = Number.isFinite(tau) && tau > 0 ? tau : 1;
  return t === 1 ? p : sigmoid(logit(p) / t);
}

/** Project weights onto the simplex with a hard floor per lens. */
function projectSimplexBinary(w: number[], floor: number): number[] {
  const clamped = w.map(v => Math.max(floor, Number.isFinite(v) ? v : floor));
  const s = clamped.reduce((a, b) => a + b, 0);
  return s > 0 ? clamped.map(v => v / s) : w.map(() => 1 / w.length);
}

/**
 * COORDINATE DESCENT ON THE SIMPLEX for the binary pool — direct minimisation
 * of the pooled train log-loss (logarithmic score) over lens weights, with a
 * KL-to-uniform complexity penalty so the fit cannot pay for train noise
 * (measured: unregularised descent manufactures fake expectancy on fair
 * tapes). Alternates with the τ grid (τ ≥ 1 only: honest calibration may
 * soften, never sharpen). A fit-time capacity control — never a trade gate.
 */
export function optimizeBinaryPoolWeights(
  samples: Array<{ lenses: number[]; event: number }>,
  weights0: number[],
  tau0: number,
  tauGrid: number[],
  opts?: { reg?: number },
): { weights: number[]; tau: number } {
  const L = weights0.length;
  const floor = PARITY_FORGE_LENS_FLOOR;
  const reg = opts?.reg ?? 0.04;
  let weights = projectSimplexBinary([...weights0], floor);
  let tau = tau0;
  const klToUniform = (w: number[]): number => {
    let kl = 0;
    for (const v of w) kl += v > 1e-12 ? v * Math.log(v * L) : 0;
    return Math.max(0, kl);
  };
  const pooledLoss = (w: number[], t: number): number => {
    let ll = 0;
    for (const s of samples) {
      const p = temperatureScaleBinary(logPoolBinary(s.lenses, w), t);
      ll += -(s.event ? Math.log(Math.max(1e-9, p)) : Math.log(Math.max(1e-9, 1 - p)));
    }
    return ll + reg * samples.length * klToUniform(w);
  };
  let best = pooledLoss(weights, tau);
  const factors = [0.5, 0.7, 0.85, 1.18, 1.45, 2.0];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < L; i++) {
      for (const f of factors) {
        const cand = [...weights];
        cand[i] = Math.max(floor, weights[i] * f);
        const proj = projectSimplexBinary(cand, floor);
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

export function wilson(k: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = Math.min(1, Math.max(0, k / n));
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lower: Math.min(1, Math.max(0, center - half)), upper: Math.min(1, Math.max(0, center + half)) };
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)));
  return sortedAsc[idx]!;
}

function cleanDigits(digits: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < digits.length; i++) {
    const d = digits[i]!;
    if (Number.isInteger(d) && d >= 0 && d <= 9) out.push(d);
  }
  return out;
}

function parityOf(d: number): number { return d % 2; } // 0 even, 1 odd

/** log Γ(x) — Lanczos, doubles only; accurate to ~1e-13 over the needed range. */
function lgamma(x: number): number {
  if (x < 0.5) {
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

// ── Lens 1: parity Markov (order 1–2, Dirichlet + count-mixed shrinkage) ───────

const JEFFREYS = 0.5;
const ORDER2_BLEND = 8;
const ORDER1_BLEND = 12;

export class ParityMarkov {
  // counts for P(next parity | last parity)
  private c1 = new Float64Array(2 * 2);
  private n1 = new Float64Array(2);
  // P(next parity | last two parities) — 4 contexts × 2 outcomes
  private c2 = new Float64Array(4 * 2);
  private n2 = new Float64Array(4);

  update(history: ArrayLike<number>, idx: number): void {
    if (idx < 1) return;
    const prevP = parityOf(history[idx - 1]!);
    const curP = parityOf(history[idx]!);
    this.c1[prevP * 2 + curP]! += 1;
    this.n1[prevP]! += 1;
    if (idx >= 2) {
      const prev2P = parityOf(history[idx - 2]!);
      const ctx = prev2P * 2 + prevP;
      this.c2[ctx * 2 + curP]! += 1;
      this.n2[ctx]! += 1;
    }
  }

  /** P(next parity = target | last parities), shrinkage-mixed. */
  p(history: ArrayLike<number>, idx: number, targetParity: number): number {
    const lastP = parityOf(history[idx] ?? 0);
    const n1 = this.n1[lastP]!;
    const e1 = (this.c1[lastP * 2 + targetParity]! + JEFFREYS) / (n1 + 2 * JEFFREYS);
    const w1 = n1 / (n1 + ORDER1_BLEND);
    const mixed1 = (1 - w1) * 0.5 + w1 * e1;

    if (idx < 1) return mixed1;
    const prev2P = parityOf(history[idx - 1]!);
    const ctx = prev2P * 2 + lastP;
    const n2 = this.n2[ctx]!;
    if (n2 === 0) return mixed1;
    const e2 = (this.c2[ctx * 2 + targetParity]! + JEFFREYS) / (n2 + 2 * JEFFREYS);
    const w2 = n2 / (n2 + ORDER2_BLEND);
    return (1 - w2) * mixed1 + w2 * e2;
  }

  /** q_LL = P(loss | last tick lost) for a given side's win condition. */
  qLL(history: ArrayLike<number>, idx: number, winParity: number): number {
    // P(next parity == winParity | last parity == losing parity)
    // For parity contracts, losing parity = 1 - winParity.
    // We estimate P(win | last = loss) then q_LL = 1 - that.
    const losingParity = 1 - winParity;
    const n = this.n1[losingParity]!;
    const pWinGivenLoss = (this.c1[losingParity * 2 + winParity]! + JEFFREYS) / (n + 2 * JEFFREYS);
    const smoothed = (1 - n / (n + ORDER1_BLEND)) * 0.5 + (n / (n + ORDER1_BLEND)) * pWinGivenLoss;
    // q_LL is probability next is LOSS given last was LOSS = 1 - P(win|loss)
    return clamp01(1 - smoothed);
  }

  /** General q_LL accessor for the 2-state parity loss clustering. */
  qLLForSide(winParity: number): number {
    const losingParity = 1 - winParity;
    const n = this.n1[losingParity]!;
    const pWinGivenLoss = (this.c1[losingParity * 2 + winParity]! + JEFFREYS) / (n + 2 * JEFFREYS);
    const w = n / (n + ORDER1_BLEND);
    const smoothed = (1 - w) * 0.5 + w * pWinGivenLoss;
    return clamp01(1 - smoothed);
  }
}

// ── Lens 2: parity run hazard (Kaplan–Meier over censored run lengths) ───────

const HAZARD_MAX_AGE = 40;

export class ParityRunHazard {
  private died = new Float64Array(HAZARD_MAX_AGE + 1);
  private atRisk = new Float64Array(HAZARD_MAX_AGE + 1);
  private runStart = 0; // index where current run started
  private runParity = -1;

  update(history: ArrayLike<number>, idx: number): void {
    const p = parityOf(history[idx]!);
    if (this.runParity === -1) {
      this.runParity = p;
      this.runStart = idx;
      return;
    }
    if (p !== this.runParity) {
      // run of runParity ended with length = idx - runStart
      const len = Math.min(HAZARD_MAX_AGE, idx - this.runStart);
      if (len >= 1) {
        this.died[len]! += 1;
        for (let a = 1; a <= len; a++) this.atRisk[a]! += 1;
      }
      this.runParity = p;
      this.runStart = idx;
    }
  }

  /** P(next parity = target) via run hazard: if current run is `target`, hazard says it ends; else it continues. */
  p(history: ArrayLike<number>, idx: number, targetParity: number): number {
    const curP = parityOf(history[idx] ?? 0);
    const age = idx - this.runStart + 1; // length of open run including current tick
    const a = Math.min(HAZARD_MAX_AGE, Math.max(1, age));
    const h = (this.died[a]! + 1) / (this.atRisk[a]! + 2); // Beta(1,1)-smoothed hazard = P(run ends at age)
    if (targetParity === curP) {
      // Probability the run CONTINUES = 1 - h
      return clamp01(1 - h);
    } else {
      // Probability the run ENDS = h
      return clamp01(h);
    }
  }
}

// ── Lens 3: digit-conditioned parity (P(parity | last digit)) ────────────────

export class DigitParity {
  // P(parity | last digit): c[ lastDigit * 2 + nextParity ]
  private c = new Float64Array(10 * 2);
  private n = new Float64Array(10);
  // P(parity | last TWO digits): c2[ pair * 2 + nextParity ]
  private c2 = new Float64Array(100 * 2);
  private n2 = new Float64Array(100);

  update(history: ArrayLike<number>, idx: number): void {
    if (idx < 1) return;
    const lastD = history[idx - 1]!;
    const curP = parityOf(history[idx]!);
    this.c[lastD * 2 + curP]! += 1;
    this.n[lastD]! += 1;
    if (idx >= 2) {
      const prevD = history[idx - 2]!;
      const pair = prevD * 10 + lastD;
      this.c2[pair * 2 + curP]! += 1;
      this.n2[pair]! += 1;
    }
  }

  /** P(next parity = target | last digit), Jeffreys-smoothed toward fair. */
  oneDigit(history: ArrayLike<number>, idx: number, targetParity: number): number {
    const lastD = history[idx] ?? 0;
    const n = this.n[lastD]!;
    const e = (this.c[lastD * 2 + targetParity]! + JEFFREYS) / (n + 2 * JEFFREYS);
    const w = n / (n + 8);
    return (1 - w) * 0.5 + w * e;
  }

  /**
   * P(next parity = target | last TWO digits) with hierarchical backoff:
   * pair evidence shrinks into the one-digit estimate, which shrinks into
   * fair. Two digits of context see digit-conditioned parity FLIPS (e.g. a
   * 9 followed by anything skewing even) that a single digit cannot express.
   */
  p(history: ArrayLike<number>, idx: number, targetParity: number): number {
    const lastD = history[idx] ?? 0;
    if (idx < 1) return this.oneDigit(history, idx, targetParity);
    const prevD = history[idx - 1] ?? 0;
    const pair = prevD * 10 + lastD;
    const n2 = this.n2[pair]!;
    const fallback = this.oneDigit(history, idx, targetParity);
    if (n2 === 0) return fallback;
    const e2 = (this.c2[pair * 2 + targetParity]! + JEFFREYS) / (n2 + 2 * JEFFREYS);
    const w2 = n2 / (n2 + 16);
    return (1 - w2) * fallback + w2 * e2;
  }
}

// ── Lens 4: suffix parity memory (decayed longest-match, orders 2–5) ──────────

const SUFFIX_MAX_ORDER = 5;
const SUFFIX_MIN_SAMPLES = 6;
const SUFFIX_MAX_ENTRIES = 4000;
const SUFFIX_HALFLIFE_TICKS = 550;
const SUFFIX_LAPLACE = 2;

export class SuffixParityMemory {
  private tables = new Map<string, { counts: Float64Array; total: number; stamp: number }>();
  private clock = 0;

  private decay(entry: { counts: Float64Array; total: number; stamp: number }): void {
    const dt = this.clock - entry.stamp;
    if (dt <= 0) return;
    const f = Math.pow(0.5, dt / SUFFIX_HALFLIFE_TICKS);
    for (let p = 0; p < 2; p++) entry.counts[p]! *= f;
    entry.total *= f;
    entry.stamp = this.clock;
  }

  update(history: ArrayLike<number>, idx: number): void {
    this.clock++;
    const nextP = parityOf(history[idx]!);
    for (let order = 2; order <= SUFFIX_MAX_ORDER; order++) {
      if (idx < order) continue;
      let key = String(order);
      for (let k = idx - order; k < idx; k++) key += `:${history[k]!}`;
      let entry = this.tables.get(key);
      if (!entry) {
        if (this.tables.size >= SUFFIX_MAX_ENTRIES) continue;
        entry = { counts: new Float64Array(2), total: 0, stamp: this.clock };
        this.tables.set(key, entry);
      }
      this.decay(entry);
      entry.counts[nextP]! += 1;
      entry.total += 1;
    }
  }

  /** Longest context with mass: P(next parity = target | exact digit suffix). */
  p(history: ArrayLike<number>, idx: number, targetParity: number): number {
    for (let order = Math.min(SUFFIX_MAX_ORDER, idx); order >= 2; order--) {
      let key = String(order);
      for (let k = idx - order + 1; k <= idx; k++) key += `:${history[k]!}`;
      const entry = this.tables.get(key);
      if (entry) {
        this.decay(entry);
        if (entry.total >= SUFFIX_MIN_SAMPLES) {
          return (entry.counts[targetParity]! + SUFFIX_LAPLACE * 0.5) / (entry.total + SUFFIX_LAPLACE);
        }
      }
    }
    return 0.5;
  }
}

// ── Lens 5: parity CTW order mixture (universal blend over ALL chain orders) ──
// A Bayesian mixture of per-order Krichevsky–Trofimov context predictors for
// every parity-chain order 0..12 at once: each depth keeps its own context-
// conditioned KT counts and a cumulative sequential log-score, and the
// predictive blends the depths with posterior weights ∝ e^(log-score). The
// mixture's cumulative log-loss sits within log(13) nats of the BEST single
// order and concentrates on it exponentially fast — parity structure at any
// depth up to 12 is read at its true depth, with no order to pick.

interface BinaryCtwNode {
  c0: number;
  c1: number;
  logKT: number;
}

export class ParityCTW {
  private nodes = new Map<number, BinaryCtwNode>();
  private depth: number;
  private maxNodes: number;
  /** Cumulative sequential log-score per ORDER — the mixture weights. */
  private orderScore: Float64Array;

  constructor(depth = PARITY_FORGE_CTW_DEPTH, maxNodes = PARITY_FORGE_CTW_MAX_NODES) {
    this.depth = depth;
    this.maxNodes = maxNodes;
    this.orderScore = new Float64Array(depth + 1);
    this.nodes.set(0, { c0: 0, c1: 0, logKT: 0 });
  }

  /**
   * Node key: depth in the high bits, parity context packed as bits below —
   * most recent parity in the lowest context bit. The depth tag is NOT
   * cosmetic: "1" at depth 1 and "0001" at depth 4 pack to the same bits, and
   * without the tag they would share one node's counts.
   */
  private static key(history: ArrayLike<number>, endExclusive: number, d: number): number {
    let k = 0;
    for (let i = endExclusive - d; i < endExclusive; i++) k = (k << 1) | (history[i]! & 1);
    return (d << 13) | k;
  }

  private static parentKeyOf(key: number): number {
    const d = (key >> 13) - 1;
    const bits = (key & 0x1fff) >> 1;
    return (d << 13) | bits;
  }

  private static depthOf(key: number): number {
    return key >> 13;
  }

  private ensure(key: number): BinaryCtwNode {
    let n = this.nodes.get(key);
    if (!n) {
      if (this.nodes.size >= this.maxNodes) this.prune();
      n = { c0: 0, c1: 0, logKT: 0 };
      this.nodes.set(key, n);
    }
    return n;
  }

  /** Feed history[idx] as the newly observed digit (parity taken mod 2). */
  update(history: ArrayLike<number>, idx: number): void {
    const x = parityOf(history[idx]!);
    for (let d = Math.min(this.depth, idx); d >= 0; d--) {
      const node = this.ensure(ParityCTW.key(history, idx, d));
      const n = node.c0 + node.c1;
      // Pre-update KT predictive of THIS order's context node scores the symbol.
      this.orderScore[d]! += Math.log(Math.max(1e-9, (x === 1 ? node.c1 + 0.5 : node.c0 + 0.5) / (n + 1)));
      if (x === 0) node.c0 += 1; else node.c1 += 1;
      node.logKT = this.orderScore[d]!;
    }
  }

  /**
   * P(next parity = target) — posterior-weighted blend of every order's KT
   * predictive, weights ∝ e^(cumulative log-score), with each order first
   * PPM-interpolated toward the shallower blend by data mass (a context seen
   * once inherits the shallower view instead of shouting). The best order
   * still takes over exponentially fast once its evidence dwarfs shrinkage.
   */
  p(history: ArrayLike<number>, idx: number, targetParity: number): number {
    const maxScore = Math.max(...this.orderScore);
    const shrink = 8;
    let shallower = 0.5;
    let p1 = 0;
    let wSum = 0;
    for (let d = 0; d <= this.depth; d++) {
      const node = this.nodes.get(ParityCTW.key(history, idx + 1, d));
      if (!node || node.c0 + node.c1 === 0) continue;
      const n = node.c0 + node.c1;
      const raw = (node.c1 + 0.5) / (n + 1);
      const k = n / (n + shrink);
      const blended = k * raw + (1 - k) * shallower;
      const w = Math.exp(Math.max(-60, this.orderScore[d]! - maxScore));
      p1 += w * blended;
      wSum += w;
      shallower = blended;
    }
    const out = wSum > 0 ? p1 / wSum : 0.5;
    return Math.min(1 - 1e-9, Math.max(1e-9, targetParity === 1 ? out : 1 - out));
  }

  /** Deepest parity order carrying data right now — display only. */
  effectiveOrder(history: ArrayLike<number>, idx: number): number {
    for (let d = Math.min(this.depth, idx + 1); d >= 1; d--) {
      const n = this.nodes.get(ParityCTW.key(history, idx + 1, d));
      if (n && n.c0 + n.c1 > 0) return d;
    }
    return 0;
  }

  private prune(): void {
    // Drop the thinnest contexts first (deepest first among ties). Order
    // scores live per-depth, so pruning contexts never corrupts the mixture.
    const rootKey = 0; // depth 0, no bits
    const victims: Array<{ key: number; total: number; d: number }> = [];
    for (const [key, n] of this.nodes) {
      if (key === rootKey) continue;
      victims.push({ key, total: n.c0 + n.c1, d: ParityCTW.depthOf(key) });
    }
    victims.sort((a, b) => a.total - b.total || b.d - a.d);
    const drop = Math.max(1, Math.floor(victims.length * 0.3));
    for (let i = 0; i < drop; i++) this.nodes.delete(victims[i].key);
  }
}

// ── Lens 6: parity echo spectrum (recency-weighted repeat rates per lag) ──────
// For lags 1..24, the recency-weighted P(p_t == p_{t−k}). Scoring tilts the
// lag-k trailing parity by its measured lift over fair — cyclic alternation
// with any period shows up as above-fair lags at k and k+1 (one for "same",
// one for "flip") that the order-1/2 chain and the run hazard miss.

export class ParityEcho {
  private n: Float64Array;
  private h: Float64Array;
  private decay: number;

  constructor(
    private lags = PARITY_FORGE_ECHO_LAGS,
    halfLife = PARITY_FORGE_ECHO_HALFLIFE_TICKS,
  ) {
    this.n = new Float64Array(lags);
    this.h = new Float64Array(lags);
    this.decay = Math.pow(0.5, 1 / Math.max(1, halfLife));
  }

  /** Feed history[idx] as the newly observed digit. */
  update(history: ArrayLike<number>, idx: number): void {
    const x = parityOf(history[idx]!);
    for (let k = 0; k < this.lags; k++) {
      this.n[k] *= this.decay;
      this.h[k] *= this.decay;
    }
    const m = Math.min(this.lags, idx);
    for (let k = 1; k <= m; k++) {
      this.n[k - 1] += 1;
      if (parityOf(history[idx - k]!) === x) this.h[k - 1] += 1;
    }
  }

  /** Posterior-mean same-parity rate at 1-based lag k (prior: 50%). */
  rate(k: number): number {
    if (k < 1 || k > this.lags) return 0.5;
    return (this.h[k - 1]! + 5) / (this.n[k - 1]! + 10); // Beta(5,5) prior = fair
  }

  /** P(next parity = target) from the lag tilts pointing at each parity. */
  p(history: ArrayLike<number>, idx: number, targetParity: number): number {
    let tiltSame = 0;
    let tiltFlip = 0;
    const m = Math.min(this.lags, idx + 1);
    for (let k = 1; k <= m; k++) {
      const pastP = parityOf(history[idx + 1 - k]!);
      const lift = this.rate(k) / 0.5;
      const w = Math.exp(-k / 10);
      const t = w * Math.log(Math.max(0.4, Math.min(2.5, lift)));
      if (pastP === 0) tiltSame += t; // evidence about parity 0 (tilt of its own echo rate)
      else tiltFlip += t;
    }
    // tiltSame accumulates evidence from lags whose TRAILING parity is 0:
    // if parity-0's echo rate at that lag is above fair, parity 0 is tilted up.
    const logit0 = tiltSame - tiltFlip;
    const p0 = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, logit0))));
    const out = targetParity === 0 ? p0 : 1 - p0;
    return Math.min(1 - 1e-9, Math.max(1e-9, out));
  }

  /** Strongest same-parity lags — display only. */
  topLags(count = 3): Array<{ lag: number; rate: number }> {
    const rows: Array<{ lag: number; rate: number }> = [];
    for (let k = 1; k <= this.lags; k++) rows.push({ lag: k, rate: this.rate(k) });
    rows.sort((a, b) => Math.abs(b.rate - 0.5) - Math.abs(a.rate - 0.5));
    return rows.slice(0, Math.max(1, count));
  }
}

// ── Pacing valve (normal shots only — recovery has the static bar) ────────────

export class PacingValve {
  bar: number;

  constructor(
    private readonly targetRate: number,
    initBar: number,
    private readonly floor = 0,
    private readonly kappa = 0.004,
  ) {
    this.bar = Math.min(0.95, Math.max(initBar, floor));
  }

  observe(score: number): boolean {
    const fire = score >= this.bar;
    if (fire) this.bar += this.kappa * (1 - this.targetRate);
    else this.bar -= this.kappa * this.targetRate;
    if (this.bar < this.floor) this.bar = this.floor;
    if (this.bar > 0.95) this.bar = 0.95;
    return fire;
  }
}

// ── Policy: four lenses + fusion + the recovery-first selection ───────────────

export interface ParityForgeParams {
  /** Log-pool weights over [parityMarkov, runHazard, digitPair, suffix, parityCTW, echo]. */
  weights: number[];
  tau: number;
  normalInitBar: number;
}

export interface ParityForgeSideRead {
  contract: ParityForgeContract;
  p: number;
  /** Fused win probability BEFORE temperature calibration. */
  pRaw: number;
  lenses: number[];
  qLL: number;
  pairRisk: number;
  utility: number;
  breakEven: number;
}

export interface ParityForgeDecision {
  mode: ParityForgeMode;
  side: ParityForgeContract | null;
  read: ParityForgeSideRead | null;
  /** Runner-up (the other side of the mode) for display. */
  alt: ParityForgeSideRead | null;
  ready: boolean;
  bar: number;
  reason: string;
}

/**
 * The recovery utility — the "don't lose the ladder to pairs" math.
 *
 *   utility = (p·payout − 1)  −  λ · P(loss) · min(q_LL, 0.95)
 *
 * First term is the edge of the shot; second prices the probability this shot
 * BOTH loses and lands on a previous loss (the loss-pair that deepens the
 * recovery ladder). λ is fixed at construction — it never depends on the
 * current loss run, so the ranking cannot harden as debt grows.
 */
export function sideUtility(
  p: number,
  payout: number,
  qLL: number,
  pairWeight: number,
): { utility: number; pairRisk: number } {
  const q = 1 - p;
  const pairRisk = q * Math.min(qLL, 0.95);
  const ev = p * payout - 1;
  return { utility: ev - pairWeight * pairRisk, pairRisk };
}

export class ParityForgePolicy {
  private parityMarkov = new ParityMarkov();
  private runHazard = new ParityRunHazard();
  private digitParity = new DigitParity();
  private suffix = new SuffixParityMemory();
  private parityCTW = new ParityCTW();
  private echo = new ParityEcho();
  private normalValve: PacingValve;

  constructor(private readonly params: ParityForgeParams) {
    this.normalValve = new PacingValve(
      PARITY_FORGE_NORMAL_PACE_TARGET,
      params.normalInitBar,
      0,
    );
  }

  get fitted(): ParityForgeParams {
    return this.params;
  }

  get normalBar(): number {
    return this.normalValve.bar;
  }

  /** Feed history[idx] as the newly observed digit. */
  update(history: ArrayLike<number>, idx: number): void {
    this.parityMarkov.update(history, idx);
    this.digitParity.update(history, idx);
    this.runHazard.update(history, idx);
    this.suffix.update(history, idx);
    this.parityCTW.update(history, idx);
    this.echo.update(history, idx);
  }

  /** The six lens probabilities for one side's win event. */
  lensVector(history: ArrayLike<number>, idx: number, targetParity: number): number[] {
    return [
      this.parityMarkov.p(history, idx, targetParity),
      this.runHazard.p(history, idx, targetParity),
      this.digitParity.p(history, idx, targetParity),
      this.suffix.p(history, idx, targetParity),
      this.parityCTW.p(history, idx, targetParity),
      this.echo.p(history, idx, targetParity),
    ];
  }

  /** Calibrated fused probability for one side (pool + temperature). */
  pooledSide(history: ArrayLike<number>, idx: number, targetParity: number): { p: number; pRaw: number; lenses: number[] } {
    const lenses = this.lensVector(history, idx, targetParity);
    const pRaw = clamp01(logPoolBinary(lenses, this.params.weights));
    const p = clamp01(temperatureScaleBinary(pRaw, this.params.tau));
    return { p, pRaw, lenses };
  }

  /**
   * Read one contract's fused win probability + its six lens components.
   * q_LL — the loss-pair risk price — is the FULL model's probability of the
   * OPPOSITE (losing) side, not a bare order-1 chain estimate: when the whole
   * lens stack believes the losing parity persists, pair-risk rises together
   * with the evidence, exactly as loss-pair pricing should.
   */
  readSide(history: ArrayLike<number>, idx: number, contract: ParityForgeContract): ParityForgeSideRead {
    const targetParity = contract.id === "even" ? 0 : 1;
    const mine = this.pooledSide(history, idx, targetParity);
    const opposite = this.pooledSide(history, idx, 1 - targetParity);
    const qLL = clamp01(opposite.p);
    const pairWeight = contract.mode === "recovery"
      ? PARITY_FORGE_RECOVERY_PAIR_WEIGHT
      : PARITY_FORGE_NORMAL_PAIR_WEIGHT;
    const { utility, pairRisk } = sideUtility(mine.p, contract.payout, qLL, pairWeight);
    return {
      contract, p: mine.p, pRaw: mine.pRaw, lenses: mine.lenses, qLL, pairRisk, utility,
      breakEven: 1 / contract.payout,
    };
  }

  /** Parity echo lags for the console's rhythm panel — display only. */
  echoLags(count = 3): Array<{ lag: number; rate: number }> {
    return this.echo.topLags(count);
  }

  /** Deepest parity order the CTW mixture is currently exercising. */
  ctwOrder(history: ArrayLike<number>, idx: number): number {
    return this.parityCTW.effectiveOrder(history, idx);
  }

  private best(
    history: ArrayLike<number>,
    idx: number,
    contracts: readonly ParityForgeContract[],
  ): { best: ParityForgeSideRead | null; alt: ParityForgeSideRead | null } {
    const reads = contracts.map(c => this.readSide(history, idx, c));
    reads.sort((a, b) => b.utility - a.utility);
    return { best: reads[0] ?? null, alt: reads[1] ?? null };
  }

  /**
   * NORMAL tick: pick the better parity side by utility and let the pacing valve
   * decide WHEN (budget 0.20/tick, zero floor — never starved).
   */
  decideNormal(
    history: ArrayLike<number>,
    idx: number,
    sideMode: ParityForgeSideMode = "both",
  ): ParityForgeDecision {
    const allowed = PARITY_FORGE_NORMAL_CONTRACTS.filter(c =>
      sideMode === "both" ||
      (sideMode === "even" && c.contractType === "DIGITEVEN") ||
      (sideMode === "odd" && c.contractType === "DIGITODD"));
    const pool = allowed.length ? allowed : PARITY_FORGE_NORMAL_CONTRACTS;
    const { best, alt } = this.best(history, idx, pool);
    if (!best) {
      return { mode: "normal", side: null, read: null, alt: null, ready: false, bar: this.normalValve.bar, reason: "no side armed" };
    }
    const ready = this.normalValve.observe(best.p);
    return {
      mode: "normal",
      side: best.contract,
      read: best,
      alt,
      ready,
      bar: this.normalValve.bar,
      reason: ready
        ? `valve open — ${best.contract.label} at ${(best.p * 100).toFixed(1)}%`
        : `pacing valve between normal shots (${best.p.toFixed(3)} vs bar ${this.normalValve.bar.toFixed(3)})`,
    };
  }

  /**
   * RECOVERY tick: the BEST available recovery shot in the armed market set —
   * fired the next tick it clears the STATIC break-even bar. This function takes
   * NO loss-run / step / debt argument: the bar cannot harden after a recovery
   * loss because nothing here is allowed to depend on one.
   */
  decideRecovery(history: ArrayLike<number>, idx: number): ParityForgeDecision {
    const { best, alt } = this.best(history, idx, PARITY_FORGE_RECOVERY_CONTRACTS);
    if (!best) {
      return { mode: "recovery", side: null, read: null, alt: null, ready: false, bar: PARITY_FORGE_RECOVERY_BAR, reason: "no recovery side armed" };
    }
    // STATIC bar — PARITY_FORGE_RECOVERY_BAR, the break-even + cushion. Frozen.
    const ready = best.p >= PARITY_FORGE_RECOVERY_BAR;
    return {
      mode: "recovery",
      side: best.contract,
      read: best,
      alt,
      ready,
      bar: PARITY_FORGE_RECOVERY_BAR,
      reason: ready
        ? `best recovery shot — ${best.contract.label} at ${(best.p * 100).toFixed(1)}% (pair-risk ${(best.pairRisk * 100).toFixed(0)}%)`
        : `no tilt yet (${(best.p * 100).toFixed(1)}% vs ${(PARITY_FORGE_RECOVERY_BAR * 100).toFixed(0)}%) — holding for a better recovery opportunity`,
    };
  }
}

// ── Honest replay: the exact live policy, measured on unseen ticks ────────────

export interface ParityForgeReplayMetrics {
  ticks: number;
  normalShots: number;
  normalHits: number;
  normalHitRate: number;
  normalHitRateLower: number;
  recoveryShots: number;
  recoveryHits: number;
  recoveryHitRate: number;
  recoveryHitRateLower: number;
  /** Two consecutive recovery losses — the ladder killer. */
  recoveryLossPairs: number;
  recoveryLosses: number;
  /** Mean ticks spent in debt per recovery episode (timeliness). */
  avgTicksInRecovery: number;
  paperEdgePerDollar: number;
  fireRatePer100: number;
  avgP: number;
}

const TAU_GRID_PF = [0.6, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.8, 2.2];

/**
 * Paper session on unseen ticks: normal shots at the valve budget, losses drop
 * into recovery, recovery fires the best shot at the static bar until debt
 * clears. This is the live loop's policy — nothing softer, nothing harder.
 */
export function replayParityForge(
  digits: ArrayLike<number>,
  params: ParityForgeParams,
  opts?: { warmup?: number; normalPayout?: number; recoveryPayout?: number; sideMode?: ParityForgeSideMode },
): { metrics: ParityForgeReplayMetrics; policy: ParityForgePolicy } {
  const clean = cleanDigits(digits);
  const n = clean.length;
  const warmup = Math.min(Math.max(0, opts?.warmup ?? 300), Math.max(0, n - 50));
  const nPay = opts?.normalPayout ?? PARITY_FORGE_NORMAL_CONTRACTS[0]!.payout;
  const rPay = opts?.recoveryPayout ?? PARITY_FORGE_RECOVERY_CONTRACTS[0]!.payout;
  const sideMode = opts?.sideMode ?? "both";
  const policy = new ParityForgePolicy(params);

  for (let i = 0; i < warmup; i++) policy.update(clean, i);

  let normalShots = 0, normalHits = 0;
  let recoveryShots = 0, recoveryHits = 0, recoveryLosses = 0, recoveryLossPairs = 0;
  let paper = 0, sumP = 0;
  let inRecovery = false, prevRecoveryLoss = false;
  let ticksInRec = 0, recEpisodes = 0, episodeTicks = 0;

  for (let i = warmup; i < n - 1; i++) {
    const next = clean[i + 1]!;
    const nextParity = parityOf(next);
    if (inRecovery) episodeTicks++;
    const dec = inRecovery
      ? policy.decideRecovery(clean, i)
      : policy.decideNormal(clean, i, sideMode);
    if (dec.ready && dec.side && dec.read) {
      const targetParity = dec.side.id === "even" ? 0 : 1;
      const hit = nextParity === targetParity ? 1 : 0;
      const payout = dec.mode === "recovery" ? rPay : nPay;
      sumP += dec.read.p;
      paper += hit ? (payout - 1) : -1;
      if (dec.mode === "recovery") {
        recoveryShots++;
        recoveryHits += hit;
        if (!hit) {
          recoveryLosses++;
          if (prevRecoveryLoss) recoveryLossPairs++;
          prevRecoveryLoss = true;
        } else {
          prevRecoveryLoss = false;
          inRecovery = false;
          ticksInRec += episodeTicks;
          recEpisodes++;
          episodeTicks = 0;
        }
      } else {
        normalShots++;
        normalHits += hit;
        if (!hit) {
          inRecovery = true;
          prevRecoveryLoss = false;
          episodeTicks = 0;
        }
      }
    }
    policy.update(clean, i + 1);
  }

  const measured = Math.max(1, n - 1 - warmup);
  const nw = wilson(normalHits, normalShots);
  const rw = wilson(recoveryHits, recoveryShots);
  const shots = normalShots + recoveryShots;
  const metrics: ParityForgeReplayMetrics = {
    ticks: measured,
    normalShots,
    normalHits,
    normalHitRate: normalShots > 0 ? normalHits / normalShots : 0,
    normalHitRateLower: normalShots > 0 ? nw.lower : 0,
    recoveryShots,
    recoveryHits,
    recoveryHitRate: recoveryShots > 0 ? recoveryHits / recoveryShots : 0,
    recoveryHitRateLower: recoveryShots > 0 ? rw.lower : 0,
    recoveryLossPairs,
    recoveryLosses,
    avgTicksInRecovery: recEpisodes > 0 ? ticksInRec / recEpisodes : 0,
    paperEdgePerDollar: shots > 0 ? paper / shots : 0,
    fireRatePer100: (shots / measured) * 100,
    avgP: shots > 0 ? sumP / shots : 0,
  };
  return { metrics, policy };
}

// ── Fit on train (pooled lens skill + τ), measure on held-out test ────────────

export interface ParityForgeFit {
  params: ParityForgeParams;
  train: ParityForgeReplayMetrics;
  test: ParityForgeReplayMetrics;
}

export function fitParityForgeParams(
  digits: ArrayLike<number>,
  opts?: { normalPayout?: number; recoveryPayout?: number },
): ParityForgeFit {
  const clean = cleanDigits(digits);
  const split = Math.floor(clean.length * PARITY_FORGE_TRAIN_FRACTION);
  const train = clean.slice(0, split);
  const test = clean.slice(split);

  if (clean.length < PARITY_FORGE_MIN_FIT_DIGITS || train.length < 250 || test.length < 120) {
    const params: ParityForgeParams = { weights: [0.2, 0.18, 0.16, 0.14, 0.18, 0.14], tau: 1, normalInitBar: 0.53 };
    const { metrics } = replayParityForge(clean, params, { warmup: Math.min(200, Math.floor(clean.length / 3)), ...opts });
    return { params, train: metrics, test: metrics };
  }

  // ── Train pass: per-lens binary log-loss (pooled over both parity sides).
  const probe = new ParityForgePolicy({ weights: [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6], tau: 1, normalInitBar: 0.53 });
  for (let i = 0; i < 300 && i < train.length; i++) probe.update(train, i);

  const L = PARITY_FORGE_LENS_COUNT;
  const ll = new Array<number>(L).fill(0);
  const pooled: Array<{ lenses: number[]; event: number }> = [];
  const normalScores: number[] = [];
  let llN = 0;

  for (let i = 300; i < train.length - 1; i++) {
    const next = train[i + 1]!;
    const nextParity = parityOf(next);
    for (const c of PARITY_FORGE_ALL_CONTRACTS) {
      const targetParity = c.id === "even" ? 0 : 1;
      const lens = probe.lensVector(train, i, targetParity);
      const event = nextParity === targetParity ? 1 : 0;
      for (let j = 0; j < L; j++) {
        const pj = Math.min(1 - 1e-9, Math.max(1e-9, lens[j]!));
        ll[j]! += -(event ? Math.log(pj) : Math.log(1 - pj));
      }
      pooled.push({ lenses: lens, event });
      llN++;
    }
    probe.update(train, i + 1);
  }

  const baseline = Math.log(2);
  const skillWeights = weightsFromSkillN(
    llN > 0 ? ll.map(v => v / llN) : new Array<number>(L).fill(baseline),
    baseline,
  );

  // ── Stage 2: regularised coordinate descent on the simplex, τ ∈ [1, 1.5].
  // Sub-1 temperatures sharpen (how train noise masquerades as skill — the
  // recovery bar must stay meaningful); runaway τ > 1.5 over-softens until the
  // pool is near-uniform and the replay trades noise spikes instead of reads.
  const CAL_TAU_GRID_PF = TAU_GRID_PF.filter(t => t >= 1 && t <= 1.5);
  const refined = pooled.length > 200
    ? optimizeBinaryPoolWeights(pooled, skillWeights, 1, CAL_TAU_GRID_PF)
    : { weights: skillWeights, tau: 1 };
  const weights = refined.weights;
  let tau = refined.tau;

  // Valve seed: the train quantile of BEST normal-side scores at (1 − budget),
  // computed at the FINAL pool so the live valve starts converged.
  for (let i = 300; i < train.length - 1; i++) {
    const reads = PARITY_FORGE_NORMAL_CONTRACTS.map(c => {
      const mine = probe.pooledSide(train, i, c.id === "even" ? 0 : 1);
      return temperatureScaleBinary(mine.pRaw, tau);
    });
    reads.sort((a, b) => b - a);
    if (reads[0] !== undefined) normalScores.push(reads[0]!);
  }
  normalScores.sort((a, b) => a - b);
  const normalInitBar = normalScores.length > 0
    ? quantile(normalScores, 1 - PARITY_FORGE_NORMAL_PACE_TARGET)
    : 0.53;

  const params: ParityForgeParams = { weights, tau, normalInitBar };
  const trainReplay = replayParityForge(train, params, { warmup: 250, ...opts }).metrics;
  const testReplay = replayParityForge(test, params, { warmup: Math.min(250, Math.floor(test.length / 3)), ...opts }).metrics;
  return { params, train: trainReplay, test: testReplay };
}

// ── One-market scan read ──────────────────────────────────────────────────────

export interface ParityForgeDiag {
  weights: number[];
  tau: number;
  normalInitBar: number;
  historyUsed: number;
  /** q_LL per recovery side — the clustering estimates behind pair-risk. */
  qLL: { even: number; odd: number };
  fireRatePer100: number;
}

export interface ParityForgeMarketRead {
  verdict: ParityForgeVerdict;
  confidence: number;
  paperEdgePerDollar: number;
  normal: ParityForgeReplayMetrics;
  recovery: ParityForgeReplayMetrics;
  /** Alias of test metrics (normal + recovery are slices of one replay). */
  metrics: ParityForgeReplayMetrics;
  params: ParityForgeParams;
  diag: ParityForgeDiag;
  thinData: boolean;
  breakEven: number;
}

export function scoreParityForgeMarket(
  digits: ArrayLike<number>,
  opts?: { normalPayout?: number; recoveryPayout?: number },
): ParityForgeMarketRead {
  const clean = cleanDigits(digits);
  const nPay = opts?.normalPayout ?? PARITY_FORGE_NORMAL_CONTRACTS[0]!.payout;
  const rPay = opts?.recoveryPayout ?? PARITY_FORGE_RECOVERY_CONTRACTS[0]!.payout;
  const thinData = clean.length < PARITY_FORGE_MIN_MEASURE_DIGITS;

  const fit = fitParityForgeParams(clean, { normalPayout: nPay, recoveryPayout: rPay });
  const m = fit.test;

  // Live q_LL per recovery side on the full warmed state (display + pair-risk).
  const probe = new ParityForgePolicy(fit.params);
  for (let i = 0; i < clean.length; i++) probe.update(clean, i);
  const rEven = probe.readSide(clean, clean.length - 1, PARITY_FORGE_RECOVERY_CONTRACTS[0]!);
  const rOdd = probe.readSide(clean, clean.length - 1, PARITY_FORGE_RECOVERY_CONTRACTS[1]!);

  // Verdict ladder — measurement honesty ONLY, never a deploy gate:
  //   PRIME  = the exact live policy made money on unseen ticks AND the
  //            recovery band PROVED its win rate statistically: the Wilson
  //            95% LOWER bound clears break-even, so a lucky 7-of-12 run on a
  //            fair tape can never wear the top badge (parity with Echo
  //            Apex's honesty bar)
  //   VIABLE = positive paper expectancy with real recovery mass
  //   THIN   = everything else
  const recoveryProven = m.recoveryShots > 0 && m.recoveryHitRateLower >= 1 / rPay;
  let verdict: ParityForgeVerdict;
  if (!thinData && m.paperEdgePerDollar >= 0.02 && m.recoveryShots >= 6 && recoveryProven && m.normalShots >= 6) {
    verdict = "prime";
  } else if (!thinData && m.paperEdgePerDollar > 0 && m.recoveryShots >= 4) {
    verdict = "viable";
  } else {
    verdict = "thin";
  }

  let confidence: number;
  if (verdict === "prime") confidence = 70 + Math.min(25, Math.round(m.paperEdgePerDollar * 500));
  else if (verdict === "viable") confidence = 45 + Math.min(20, Math.round(m.paperEdgePerDollar * 500));
  else confidence = Math.max(15, Math.min(44, 30 + Math.round(m.paperEdgePerDollar * 300)));
  if (thinData) confidence = Math.min(confidence, 35);

  return {
    verdict,
    confidence,
    paperEdgePerDollar: Math.round(m.paperEdgePerDollar * 10000) / 10000,
    normal: m,
    recovery: m,
    metrics: m,
    params: fit.params,
    diag: {
      weights: fit.params.weights,
      tau: Math.round(fit.params.tau * 100) / 100,
      normalInitBar: Math.round(fit.params.normalInitBar * 10000) / 10000,
      historyUsed: clean.length,
      qLL: {
        even: Math.round(rEven.qLL * 1000) / 1000,
        odd: Math.round(rOdd.qLL * 1000) / 1000,
      },
      fireRatePer100: Math.round(m.fireRatePer100 * 100) / 100,
    },
    thinData,
    breakEven: 1 / rPay,
  };
}
