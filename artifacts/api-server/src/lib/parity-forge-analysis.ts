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
 * Bayesian for Bernoulli events) with skill-weighted lenses + one temperature
 * calibration — agreement across lenses is what makes a shot safe.
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
  const floored = exps.map(v => 0.05 + 0.85 * (v / sum));
  const s2 = floored.reduce((a, b) => a + b, 0) || 1;
  return floored.map(v => v / s2);
}

/** Binary event temperature scaling: soften/sharpen around 0.5 via logit/τ. */
export function temperatureScaleBinary(p: number, tau: number): number {
  const t = Number.isFinite(tau) && tau > 0 ? tau : 1;
  return t === 1 ? p : sigmoid(logit(p) / t);
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
  // c[ lastDigit * 2 + nextParity ]
  private c = new Float64Array(10 * 2);
  private n = new Float64Array(10);

  update(history: ArrayLike<number>, idx: number): void {
    if (idx < 1) return;
    const lastD = history[idx - 1]!;
    const curP = parityOf(history[idx]!);
    this.c[lastD * 2 + curP]! += 1;
    this.n[lastD]! += 1;
  }

  /** P(next parity = target | last digit). */
  p(history: ArrayLike<number>, idx: number, targetParity: number): number {
    const lastD = history[idx] ?? 0;
    const n = this.n[lastD]!;
    const e = (this.c[lastD * 2 + targetParity]! + JEFFREYS) / (n + 2 * JEFFREYS);
    const w = n / (n + 8);
    return (1 - w) * 0.5 + w * e;
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
  /** Log-pool weights over [parityMarkov, runHazard, digitParity, suffix]. */
  weights: [number, number, number, number];
  tau: number;
  normalInitBar: number;
}

export interface ParityForgeSideRead {
  contract: ParityForgeContract;
  p: number;
  /** Fused win probability BEFORE temperature calibration. */
  pRaw: number;
  lenses: [number, number, number, number];
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
  }

  /** Read one contract's fused win probability + its four lens components. */
  readSide(history: ArrayLike<number>, idx: number, contract: ParityForgeContract): ParityForgeSideRead {
    const targetParity = contract.id === "even" ? 0 : 1;
    const pM = this.parityMarkov.p(history, idx, targetParity);
    const pH = this.runHazard.p(history, idx, targetParity);
    const pD = this.digitParity.p(history, idx, targetParity);
    const pS = this.suffix.p(history, idx, targetParity);
    const lenses: [number, number, number, number] = [pM, pH, pD, pS];
    const pRaw = clamp01(logPoolBinary(lenses, this.params.weights));
    const p = clamp01(temperatureScaleBinary(pRaw, this.params.tau));
    const qLL = this.parityMarkov.qLLForSide(targetParity);
    const pairWeight = contract.mode === "recovery"
      ? PARITY_FORGE_RECOVERY_PAIR_WEIGHT
      : PARITY_FORGE_NORMAL_PAIR_WEIGHT;
    const { utility, pairRisk } = sideUtility(p, contract.payout, qLL, pairWeight);
    return {
      contract, p, pRaw, lenses, qLL, pairRisk, utility,
      breakEven: 1 / contract.payout,
    };
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
    const params: ParityForgeParams = { weights: [0.3, 0.25, 0.2, 0.25], tau: 1, normalInitBar: 0.53 };
    const { metrics } = replayParityForge(clean, params, { warmup: Math.min(200, Math.floor(clean.length / 3)), ...opts });
    return { params, train: metrics, test: metrics };
  }

  // ── Train pass: per-lens binary log-loss (pooled over both parity sides) + τ.
  const probe = new ParityForgePolicy({ weights: [0.25, 0.25, 0.25, 0.25], tau: 1, normalInitBar: 0.53 });
  for (let i = 0; i < 300 && i < train.length; i++) probe.update(train, i);

  const ll = [0, 0, 0, 0];
  const pooled: Array<{ lenses: [number, number, number, number]; event: number }> = [];
  const normalScores: number[] = [];
  let llN = 0;

  for (let i = 300; i < train.length - 1; i++) {
    const next = train[i + 1]!;
    const nextParity = parityOf(next);
    for (const c of PARITY_FORGE_ALL_CONTRACTS) {
      const targetParity = c.id === "even" ? 0 : 1;
      const read = probe.readSide(train, i, c);
      const event = nextParity === targetParity ? 1 : 0;
      for (let j = 0; j < 4; j++) {
        const pj = Math.min(1 - 1e-9, Math.max(1e-9, read.lenses[j]!));
        ll[j]! += -(event ? Math.log(pj) : Math.log(1 - pj));
      }
      pooled.push({ lenses: read.lenses, event });
      llN++;
    }
    // Normal side best score (both sides, utility order) for the valve seed.
    const reads = PARITY_FORGE_NORMAL_CONTRACTS.map(c => probe.readSide(train, i, c));
    reads.sort((a, b) => b.utility - a.utility);
    if (reads[0]) normalScores.push(reads[0].p);
    probe.update(train, i + 1);
  }

  const baseline = Math.log(2);
  const weightsArr = weightsFromSkillN(
    llN > 0 ? ll.map(v => v / llN) : [baseline, baseline, baseline, baseline],
    baseline,
  );
  const weights = [weightsArr[0]!, weightsArr[1]!, weightsArr[2]!, weightsArr[3]!] as [number, number, number, number];

  // ── τ on the skill-weighted pool of the collected lens vectors.
  let tau = 1;
  let bestLL = Infinity;
  for (const t of TAU_GRID_PF) {
    let l = 0;
    for (const s of pooled) {
      const raw = logPoolBinary(s.lenses, weights);
      const p = temperatureScaleBinary(raw, t);
      l += -(s.event ? Math.log(Math.max(1e-9, p)) : Math.log(Math.max(1e-9, 1 - p)));
    }
    if (l < bestLL) {
      bestLL = l;
      tau = t;
    }
  }

  // Valve seed: the train quantile of BEST normal-side scores at (1 − budget).
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
  weights: [number, number, number, number];
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
  //            recovery band held its face-up win rate (the ladder survives)
  //   VIABLE = positive paper expectancy with real recovery mass
  //   THIN   = everything else
  let verdict: ParityForgeVerdict;
  if (!thinData && m.paperEdgePerDollar >= 0.02 && m.recoveryShots >= 6 && m.recoveryHitRate >= 0.56 && m.normalShots >= 6) {
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
