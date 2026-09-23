/**
 * BARRIER BASTION — recovery-first Over/Under analysis core (the 12th AI bot).
 *
 * Frozen contract pair, exactly as specified:
 *
 *   NORMAL    Over 1  (digit ∈ {2..9})  or  Under 8 (digit ∈ {0..7})  — 80% bands
 *   RECOVERY  Over 3  (digit ∈ {4..9})  or  Under 6 (digit ∈ {0..5})  — 60% bands
 *
 * The whole edge of this bot lives in its RECOVERY quality: the ladder dies to
 * loss PAIRS, so everything below is built to pick the recovery side with the
 * highest payoff-weighted probability AND the lowest probability of extending
 * a loss run. Four independent lenses read each band's win event from a
 * different structure of the digit tape:
 *
 *  1. DIGIT MARKOV — order-1..2 chains over the 10 digits with Jeffreys
 *     Dirichlet smoothing and count-mixed order shrinkage; P(win) is the mass
 *     the chain puts on the band. The losing digit of the last trade IS the
 *     conditioning state, which is what makes post-loss side choice sharp.
 *  2. BAND MARKOV — the band's own 2-state win/loss indicator chain (order
 *     1..2). Roughly 5× the effective samples per state of the 10-state digit
 *     matrix, and its q_LL = P(loss | loss) is the clustering estimate the
 *     pair-risk penalty uses. The penalty itself is now CONTEXTUAL: the
 *     order-2 chain's P(loss | last two band states), blended with order-1 by
 *     count — the side/market clustering losses RIGHT NOW loses arbitration.
 *  3. HOLE HAZARD — the band's losing set is a "hole" (e.g. {0,1} for Over 1).
 *     A Kaplan–Meier-style discrete hazard over the hole's censored gap history
 *     says how due the hole is to print; P(win) = 1 − h(age).
 *  4. SUFFIX MEMORY — decayed longest-match continuation (orders 1–5) over
 *     exact digit contexts, Laplace-smoothed: what followed THIS context before.
 *  5. EW DRIFT — recency-weighted win rate shrunk toward the band's fair rate
 *     (Bayesian EWMA, informative Beta prior). The lens that sees slow regime
 *     drift — "this tape has been running hot for five minutes" — which
 *     order-1/2 contexts structurally cannot.
 *  6. REGIME HMM — a 2-state hidden Markov model (Bernoulli emissions) fitted
 *     by Baum–Welch on a rolling window of the band indicator; the forward
 *     filter's posterior predictive Σ γ(s)·B_s is persistence-aware regime
 *     estimation.
 *
 * The lenses fuse through a LOGARITHMIC OPINION POOL in logit space (externally
 * Bayesian for Bernoulli events) with skill-weighted lenses + one temperature
 * calibration — agreement across lenses is what makes a shot safe. Lens skill
 * is averaged over THREE overlapping fit windows (model-averaged weights) so
 * one unlucky window cannot dominate the policy.
 *
 * SELECTION (the recovery-first policy):
 *  - The side is chosen by utility = (p·payout − 1) − λ·P(loss)·min(q_LLctx, .95),
 *    where λ is bigger in recovery: a loss pair is exactly what deepens the
 *    shared recovery ladder, so the penalty targets consecutive recovery losses.
 *  - Normal shots ride a two-way pacing VALVE (budget 0.20 shots/tick,
 *    floored at break-even): selectivity is a budget, never a stack of vetoes.
 *  - Recovery shots use ONE static quality bar: the payout-aware break-even
 *    rate (1/payout) clamped into [fair, fair + 0.02] — a function of the
 *    contract and its payout ONLY. The best available shot fires THE NEXT TICK
 *    it clears the bar — THERE IS NO POST-LOSS TIGHTENING ANYWHERE IN THIS
 *    FILE. No function on the recovery path even accepts a loss-run argument;
 *    the bar cannot harden after a recovery loss because it is a frozen
 *    constant of (contract, payout). The clamp keeps the bar within +2pp of
 *    the legacy combinatorial fair rate, so the fire rate barely moves while
 *    bar-level shots stop leaking stake to the house edge. If no side clears
 *    the bar the bot waits (and, in switching mode, the Market Scout hunts a
 *    better market — by composite live/measured/experienced edge, even before
 *    a bar-clearing setup exists).
 *
 * HONEST MEASUREMENT — `fitBastionParams` fits weights/τ on the first 60% and
 * `replayBastion` replays the EXACT live policy (paper session, normal → loss →
 * recovery → clear) on the final 40%: normal hit rate, RECOVERY hit rate,
 * RECOVERY LOSS PAIRS and ticks spent in debt, per market. Verdicts (PRIME /
 * VIABLE / THIN) describe what was measured — labels only, never a deploy gate.
 *
 * Everything here is pure and synchronous: no Deriv imports, no DB, no clock.
 */

import {
  BandRegimeHMM,
  bandIndicators,
  calibratedRecoveryBar,
  expandPoolWeights,
  ewBandRate,
  fitRegimeHMM,
  type RegimeHMMParams,
} from "./band-regime.js";

// ── Frozen contracts ─────────────────────────────────────────────────────────

export type BastionContractId = "over1" | "under8" | "over3" | "under6";
export type BastionMode = "normal" | "recovery";
export type BastionSideMode = "both" | "over" | "under";
export type BastionVerdict = "prime" | "viable" | "thin";

export interface BastionContract {
  id: BastionContractId;
  mode: BastionMode;
  contractType: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
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

export const BASTION_NORMAL_CONTRACTS: readonly BastionContract[] = Object.freeze([
  {
    id: "over1", mode: "normal", contractType: "DIGITOVER", barrier: 1, label: "Over 1",
    wins: W([2, 3, 4, 5, 6, 7, 8, 9]), fair: 0.8, payout: 1.23,
  },
  {
    id: "under8", mode: "normal", contractType: "DIGITUNDER", barrier: 8, label: "Under 8",
    wins: W([0, 1, 2, 3, 4, 5, 6, 7]), fair: 0.8, payout: 1.23,
  },
]);

export const BASTION_RECOVERY_CONTRACTS: readonly BastionContract[] = Object.freeze([
  {
    id: "over3", mode: "recovery", contractType: "DIGITOVER", barrier: 3, label: "Over 3",
    wins: W([4, 5, 6, 7, 8, 9]), fair: 0.6, payout: 1.63,
  },
  {
    id: "under6", mode: "recovery", contractType: "DIGITUNDER", barrier: 6, label: "Under 6",
    wins: W([0, 1, 2, 3, 4, 5]), fair: 0.6, payout: 1.63,
  },
]);

export const BASTION_ALL_CONTRACTS: readonly BastionContract[] = Object.freeze([
  ...BASTION_NORMAL_CONTRACTS,
  ...BASTION_RECOVERY_CONTRACTS,
]);

export function contractById(id: BastionContractId): BastionContract {
  const c = BASTION_ALL_CONTRACTS.find(x => x.id === id);
  if (!c) throw new Error(`unknown bastion contract: ${id}`);
  return c;
}

/**
 * THE recovery quality bar — the band's combinatorial fair rate. STATIC.
 * Frozen by design: recovery fires the best shot the moment its fused win
 * probability beats a random guess, and NOTHING — least of all the current loss
 * run — is allowed to move this. (It is not even a parameter of `decideRecovery`.)
 */
export const BASTION_RECOVERY_BAR = 0.6;
/** Normal shots ride the pacing valve at this budget (shots per tick). */
export const BASTION_NORMAL_PACE_TARGET = 0.2;
/** Loss-pair penalty weight in the recovery utility (per unit pair-risk). */
export const BASTION_RECOVERY_PAIR_WEIGHT = 0.4;
/** Lighter loss-pair penalty for normal side arbitration. */
export const BASTION_NORMAL_PAIR_WEIGHT = 0.15;

export const BASTION_TRAIN_FRACTION = 0.6;
export const BASTION_MIN_FIT_DIGITS = 600;
export const BASTION_MIN_MEASURE_DIGITS = 300;

/** Rolling window (band-indicator ticks) the regime HMM is fitted on. */
export const BASTION_HMM_WINDOW = 600;

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

// ── Lens 1: digit Markov (order 1–2, Dirichlet + count-mixed shrinkage) ───────

const JEFFREYS = 0.5;
const ORDER2_BLEND = 8; // pseudo-n for order-2 → order-1 shrinkage
const ORDER1_BLEND = 20; // pseudo-n for order-1 → uniform shrinkage

export class DigitMarkov {
  private c1 = new Float64Array(10 * 10);
  private n1 = new Float64Array(10);
  private c2 = new Float64Array(100 * 10);
  private n2 = new Float64Array(100);

  update(history: ArrayLike<number>, idx: number): void {
    const d = history[idx]!;
    if (idx >= 1) {
      const p1 = history[idx - 1]!;
      this.c1[p1 * 10 + d]! += 1;
      this.n1[p1]! += 1;
    }
    if (idx >= 2) {
      const p1 = history[idx - 1]!;
      const p2 = history[idx - 2]!;
      this.c2[(p2 * 10 + p1) * 10 + d]! += 1;
      this.n2[p2 * 10 + p1]! += 1;
    }
  }

  /** P(next digit | last two digits), shrinkage-mixed. */
  dist(history: ArrayLike<number>, idx: number): number[] {
    const p1 = history[idx] ?? 0;
    const p2 = idx >= 1 ? history[idx - 1]! : p1;
    const out = new Array<number>(10).fill(0);

    const n1 = this.n1[p1]!;
    const w1 = n1 / (n1 + ORDER1_BLEND);
    for (let d = 0; d < 10; d++) {
      const e1 = (this.c1[p1 * 10 + d]! + JEFFREYS) / (n1 + 10 * JEFFREYS);
      out[d] = (1 - w1) * 0.1 + w1 * e1;
    }

    const pair = p2 * 10 + p1;
    const n2 = this.n2[pair]!;
    const w2 = n2 / (n2 + ORDER2_BLEND);
    if (w2 > 0) {
      const out2 = new Array<number>(10);
      for (let d = 0; d < 10; d++) {
        const e2 = (this.c2[pair * 10 + d]! + JEFFREYS) / (n2 + 10 * JEFFREYS);
        out2[d] = (1 - w2) * out[d]! + w2 * e2;
      }
      return out2;
    }
    return out;
  }
}

// ── Lens 2: band Markov on the contract's win/loss indicator ──────────────────

export class BandMarkov {
  private c1 = new Float64Array(4); // [prev*2 + next]
  private n1 = new Float64Array(2);
  private c2 = new Float64Array(8); // [prev2*4 + prev1*2 + next]
  private n2 = new Float64Array(4);

  constructor(private readonly wins: readonly boolean[]) {}

  private wAt(history: ArrayLike<number>, idx: number): number {
    return this.wins[history[idx]!] ? 1 : 0;
  }

  update(history: ArrayLike<number>, idx: number): void {
    if (idx < 1) return;
    const a = this.wAt(history, idx - 1);
    const b = this.wAt(history, idx);
    this.c1[a * 2 + b]! += 1;
    this.n1[a]! += 1;
    if (idx >= 2) {
      const z = this.wAt(history, idx - 2);
      this.c2[z * 4 + a * 2 + b]! += 1;
      this.n2[z * 2 + a]! += 1;
    }
  }

  /** P(next tick WINS | win/loss pattern of the last two ticks). */
  p(history: ArrayLike<number>, idx: number): number {
    const a = this.wAt(history, idx);
    const z = idx >= 1 ? this.wAt(history, idx - 1) : a;
    const n1 = this.n1[a]!;
    const e1 = (this.c1[a * 2 + 1]! + JEFFREYS) / (n1 + 2 * JEFFREYS);
    const w1 = n1 / (n1 + 4);
    const mixed1 = (1 - w1) * 0.5 + w1 * e1;

    const pair = z * 2 + a;
    const n2 = this.n2[pair]!;
    const w2 = n2 / (n2 + 4);
    const e2 = (this.c2[pair * 2 + 1]! + JEFFREYS) / (n2 + 2 * JEFFREYS);
    return (1 - w2) * mixed1 + w2 * e2;
  }

  /** q_LL = P(loss | last tick lost) — the loss-clustering estimate. */
  qLL(): number {
    const n = this.n1[0]!;
    return (this.c1[0]! + JEFFREYS) / (n + 2 * JEFFREYS); // P(L|L) with smoothing
  }

  /**
   * CONTEXTUAL pair-risk input: P(next band loss | the last two band states
   * at idx-1, idx), blending the order-2 estimate with the order-1 estimate
   * by count (w = n2/(n2+4)). A function of the TAPE state only — never of
   * the loss run — so it sharpens arbitration without ratcheting.
   */
  pLossGiven(history: ArrayLike<number>, idx: number): number {
    const a = this.wAt(history, idx);
    const z = idx >= 1 ? this.wAt(history, idx - 1) : a;
    const n1 = this.n1[a]!;
    const q1 = (this.c1[a * 2]! + JEFFREYS) / (n1 + 2 * JEFFREYS); // P(L|a)
    const pair = z * 2 + a;
    const n2 = this.n2[pair]!;
    const w2 = n2 / (n2 + 4);
    if (w2 <= 0) return q1;
    const q2 = (this.c2[pair * 2]! + JEFFREYS) / (n2 + 2 * JEFFREYS); // P(L|z,a)
    return (1 - w2) * q1 + w2 * q2;
  }
}

// ── Lens 3: hole hazard (Kaplan–Meier over censored hole gaps) ────────────────

const HAZARD_MAX_AGE = 50;

export class HoleHazard {
  private died = new Float64Array(HAZARD_MAX_AGE + 1); // completed gaps == age
  private atRisk = new Float64Array(HAZARD_MAX_AGE + 1); // completed gaps >= age
  private lastHole = -1;

  constructor(private readonly hole: readonly boolean[]) {}

  update(history: ArrayLike<number>, idx: number): void {
    if (this.hole[history[idx]!]) {
      if (this.lastHole >= 0) {
        const gap = Math.min(HAZARD_MAX_AGE, idx - this.lastHole);
        if (gap >= 1) {
          this.died[gap]! += 1;
          for (let a = 1; a <= gap; a++) this.atRisk[a]! += 1;
        }
      }
      this.lastHole = idx;
    }
  }

  /** P(next tick WINS) = 1 − h(age): the hole's due-ness cuts the win rate. */
  p(history: ArrayLike<number>, idx: number): number {
    const age = this.lastHole >= 0 ? idx - this.lastHole : idx + 1;
    const a = Math.min(HAZARD_MAX_AGE, Math.max(1, age));
    const h = (this.died[a]! + 1) / (this.atRisk[a]! + 2); // Beta(1,1)-smoothed
    return clamp01(1 - h);
  }
}

// ── Lens 4: suffix memory (decayed longest-match, orders 1–5) ────────────────

const SUFFIX_MAX_ORDER = 5;
const SUFFIX_MIN_SAMPLES = 6;
const SUFFIX_MAX_ENTRIES = 4000;
const SUFFIX_HALFLIFE_TICKS = 600;
const SUFFIX_LAPLACE = 2;

export class SuffixMemory {
  private tables = new Map<string, { counts: Float64Array; total: number; stamp: number }>();
  private clock = 0;

  private decay(entry: { counts: Float64Array; total: number; stamp: number }): void {
    const dt = this.clock - entry.stamp;
    if (dt <= 0) return;
    const f = Math.pow(0.5, dt / SUFFIX_HALFLIFE_TICKS);
    for (let d = 0; d < 10; d++) entry.counts[d]! *= f;
    entry.total *= f;
    entry.stamp = this.clock;
  }

  update(history: ArrayLike<number>, idx: number): void {
    this.clock++;
    const next = history[idx]!;
    for (let order = 1; order <= SUFFIX_MAX_ORDER; order++) {
      if (idx < order) continue;
      let key = String(order);
      for (let k = idx - order; k < idx; k++) key += `:${history[k]!}`;
      let entry = this.tables.get(key);
      if (!entry) {
        if (this.tables.size >= SUFFIX_MAX_ENTRIES) continue;
        entry = { counts: new Float64Array(10), total: 0, stamp: this.clock };
        this.tables.set(key, entry);
      }
      this.decay(entry);
      entry.counts[next]! += 1;
      entry.total += 1;
    }
  }

  /** Longest context with mass: P(next digit | exact suffix). */
  dist(history: ArrayLike<number>, idx: number): number[] {
    for (let order = Math.min(SUFFIX_MAX_ORDER, idx); order >= 1; order--) {
      let key = String(order);
      for (let k = idx - order + 1; k <= idx; k++) key += `:${history[k]!}`;
      const entry = this.tables.get(key);
      if (entry) {
        this.decay(entry);
        if (entry.total >= SUFFIX_MIN_SAMPLES) {
          const out = new Array<number>(10);
          for (let d = 0; d < 10; d++) {
            out[d] = (entry.counts[d]! + SUFFIX_LAPLACE * 0.1) / (entry.total + SUFFIX_LAPLACE);
          }
          return out;
        }
      }
    }
    return new Array<number>(10).fill(0.1);
  }
}

// ── Pacing valve (normal shots only — recovery has the static bar) ────────────
// Stochastic-approximation quantile tracker: P(score ≥ bar) → target rate.
// Zero floor: the bar floats to wherever the budget lives in the live score
// distribution. Two-way (nothing ratchets with losses).

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

export type BastionWeightVec = [number, number, number, number, number, number];

export interface BastionParams {
  /**
   * Log-pool weights over the six lenses:
   * [digitMarkov, bandMarkov, holeHazard, suffix, ewDrift, regimeHMM].
   * Legacy 4-lens vectors (old scan cards) are accepted at runtime and mapped
   * to the same four lenses with the regime lenses at zero.
   */
  weights: BastionWeightVec;
  tau: number;
  normalInitBar: number;
}

export interface BastionSideRead {
  contract: BastionContract;
  p: number;
  /** Fused win probability BEFORE temperature calibration. */
  pRaw: number;
  lenses: [number, number, number, number, number, number];
  /** Order-1 loss clustering P(L|L) — display + legacy comparator. */
  qLL: number;
  /** Contextual pair-risk input: P(loss | last two band states). */
  qLL2: number;
  pairRisk: number;
  utility: number;
  breakEven: number;
}

/** Per-contract rolling HMM windows (band indicators) for a warmed policy. */
export type BastionHMMWindows = Partial<Record<BastionContractId, readonly number[]>>;

export interface BastionDecision {
  mode: BastionMode;
  side: BastionContract | null;
  read: BastionSideRead | null;
  /** Runner-up (the other side of the mode) for display. */
  alt: BastionSideRead | null;
  ready: boolean;
  bar: number;
  reason: string;
  /**
   * Normal mode only: true when the pacing valve is pinned at its break-even
   * floor — this tape has offered no fair setup for long enough that the
   * (pre-floor) valve would have started forcing trades. The engine's market
   * scout treats this as STARVATION and looks elsewhere.
   */
  starved?: boolean;
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

export class BastionPolicy {
  private digits = new DigitMarkov();
  private suffix = new SuffixMemory();
  private bands = new Map<BastionContractId, BandMarkov>();
  private holes = new Map<BastionContractId, HoleHazard>();
  private regimes = new Map<BastionContractId, BandRegimeHMM>();
  private normalValve: PacingValve;
  /** Normalized 6-lens weights (legacy 4-lens vectors expand to 6 here). */
  private readonly weights6: [number, number, number, number, number, number];

  /**
   * @param params fitted policy parameters (4- or 6-lens weights accepted).
   * @param hmmWindows optional per-contract rolling windows of PAST band
   *   indicators; each window is Baum–Welch-fitted and forward-initialized so
   *   the regime lens is live from the first read. Omit for a neutral (0.5)
   *   regime lens — e.g. legacy params whose fit predates the lens.
   */
  constructor(
    private readonly params: BastionParams,
    hmmWindows?: BastionHMMWindows,
  ) {
    this.weights6 = expandPoolWeights(params.weights, 6) as [
      number, number, number, number, number, number,
    ];
    for (const c of BASTION_ALL_CONTRACTS) {
      this.bands.set(c.id, new BandMarkov(c.wins));
      this.holes.set(c.id, new HoleHazard(c.wins.map(w => !w)));
      const hmm = new BandRegimeHMM(c.wins);
      const window = hmmWindows?.[c.id];
      if (window && window.length >= 40) {
        hmm.load(fitRegimeHMM(window), window);
      }
      this.regimes.set(c.id, hmm);
    }
    // Floor = the cheapest normal contract's break-even. Below it a "valve
    // open" shot is negative-EV by construction; the legacy zero floor let a
    // dead tape drag the bar down until the bot fired anyway — the forced
    // trade that market switching exists to replace. Pacing above the floor
    // is unchanged.
    this.normalFloor = Math.min(
      ...BASTION_NORMAL_CONTRACTS.map(c => BastionPolicy.normalBreakEven(c)),
    );
    this.normalValve = new PacingValve(
      BASTION_NORMAL_PACE_TARGET,
      params.normalInitBar,
      this.normalFloor,
    );
  }
  private readonly normalFloor: number;

  /** Payout-aware break-even for a normal contract (with a hair of margin). */
  static normalBreakEven(contract: BastionContract): number {
    return Math.min(0.95, 1 / Math.max(1.001, contract.payout) + 0.005);
  }
  /** True when the valve bar is pinned at its break-even floor. */
  get normalStarved(): boolean {
    return this.normalValve.bar <= this.normalFloor + 1e-9;
  }

  get fitted(): BastionParams {
    return this.params;
  }

  get normalBar(): number {
    return this.normalValve.bar;
  }

  /** Regime belief (hot state, 0..1) per contract — diagnostics. */
  regimeBeliefs(): Partial<Record<BastionContractId, number>> {
    const out: Partial<Record<BastionContractId, number>> = {};
    for (const c of BASTION_ALL_CONTRACTS) {
      out[c.id] = this.regimes.get(c.id)!.hotBelief;
    }
    return out;
  }

  /** Feed history[idx] as the newly observed digit. */
  update(history: ArrayLike<number>, idx: number): void {
    const d = history[idx]!;
    this.digits.update(history, idx);
    this.suffix.update(history, idx);
    for (const c of BASTION_ALL_CONTRACTS) {
      this.bands.get(c.id)!.update(history, idx);
      this.holes.get(c.id)!.update(history, idx);
      this.regimes.get(c.id)!.update(d);
    }
  }

  /** Read one contract's fused win probability + its six lens components. */
  readSide(history: ArrayLike<number>, idx: number, contract: BastionContract): BastionSideRead {
    const dDist = this.digits.dist(history, idx);
    const sDist = this.suffix.dist(history, idx);
    let pD = 0;
    let pS = 0;
    for (let d = 0; d < 10; d++) {
      if (contract.wins[d]) {
        pD += dDist[d]!;
        pS += sDist[d]!;
      }
    }
    const band = this.bands.get(contract.id)!;
    const pB = band.p(history, idx);
    const pH = this.holes.get(contract.id)!.p(history, idx);
    // Lens 5 — EW drift: stateless recency-weighted rate on the tape tail.
    const tailStart = Math.max(0, idx - 239);
    const tail: number[] = new Array(idx - tailStart + 1);
    for (let i = 0; i < tail.length; i++) tail[i] = history[tailStart + i]!;
    const pEW = ewBandRate(tail, contract.wins, contract.fair);
    // Lens 6 — regime HMM posterior predictive.
    const pHMM = this.regimes.get(contract.id)!.p();
    const lenses: [number, number, number, number, number, number] = [pD, pB, pH, pS, pEW, pHMM];
    const pRaw = clamp01(logPoolBinary(lenses, this.weights6));
    const p = clamp01(temperatureScaleBinary(pRaw, this.params.tau));
    const qLL = band.qLL();
    // Contextual pair risk: P(loss | last two band states), count-blended.
    const qLL2 = band.pLossGiven(history, idx);
    const pairWeight = contract.mode === "recovery"
      ? BASTION_RECOVERY_PAIR_WEIGHT
      : BASTION_NORMAL_PAIR_WEIGHT;
    const { utility, pairRisk } = sideUtility(p, contract.payout, qLL2, pairWeight);
    return {
      contract, p, pRaw, lenses, qLL, qLL2, pairRisk, utility,
      breakEven: 1 / contract.payout,
    };
  }

  /**
   * THE static recovery bar for a contract: payout-aware break-even clamped
   * into [fair, fair + 0.02]. Depends on the contract and its payout ONLY —
   * never on the loss run (see calibratedRecoveryBar).
   */
  static recoveryBarFor(contract: BastionContract): number {
    return calibratedRecoveryBar(contract.fair, contract.payout);
  }

  private best(
    history: ArrayLike<number>,
    idx: number,
    contracts: readonly BastionContract[],
  ): { best: BastionSideRead | null; alt: BastionSideRead | null } {
    const reads = contracts.map(c => this.readSide(history, idx, c));
    reads.sort((a, b) => b.utility - a.utility);
    return { best: reads[0] ?? null, alt: reads[1] ?? null };
  }

  /**
   * NORMAL tick: pick the better band side by utility and let the pacing valve
   * decide WHEN (budget 0.20/tick, floored at break-even — a tape that cannot
   * meet the floor is reported as STARVED rather than traded anyway).
   */
  decideNormal(
    history: ArrayLike<number>,
    idx: number,
    sideMode: BastionSideMode = "both",
  ): BastionDecision {
    const allowed = BASTION_NORMAL_CONTRACTS.filter(c =>
      sideMode === "both" ||
      (sideMode === "over" && c.contractType === "DIGITOVER") ||
      (sideMode === "under" && c.contractType === "DIGITUNDER"));
    const { best, alt } = this.best(history, idx, allowed.length ? allowed : BASTION_NORMAL_CONTRACTS);
    if (!best) {
      return { mode: "normal", side: null, read: null, alt: null, ready: false, bar: this.normalValve.bar, reason: "no side armed" };
    }
    const timed = this.normalValve.observe(best.p);
    // The chosen side must also clear ITS OWN break-even.
    const be = BastionPolicy.normalBreakEven(best.contract);
    const ready = timed && best.p >= be;
    const starved = this.normalStarved;
    return {
      mode: "normal",
      side: best.contract,
      read: best,
      alt,
      ready,
      bar: Math.max(this.normalValve.bar, timed ? be : 0),
      starved,
      reason: ready
        ? `valve open — ${best.contract.label} at ${(best.p * 100).toFixed(1)}%`
        : timed
          ? `${best.contract.label} below break-even (${(best.p * 100).toFixed(1)}% vs ${(be * 100).toFixed(1)}%) — not forcing it`
          : starved
            ? `no fair setup here — valve at break-even floor (${best.p.toFixed(3)} vs ${this.normalValve.bar.toFixed(3)})`
            : `pacing valve between normal shots (${best.p.toFixed(3)} vs bar ${this.normalValve.bar.toFixed(3)})`,
    };
  }

  /**
   * RECOVERY tick: the BEST available recovery shot in the armed market set —
   * fired the next tick it clears the STATIC bar (payout-aware break-even,
   * clamped to [fair, fair + 0.02]). This function takes NO loss-run / step /
   * debt argument: the bar cannot harden after a recovery loss because nothing
   * here is allowed to depend on one — it is a frozen constant of (contract,
   * payout).
   */
  decideRecovery(history: ArrayLike<number>, idx: number): BastionDecision {
    const { best, alt } = this.best(history, idx, BASTION_RECOVERY_CONTRACTS);
    if (!best) {
      return { mode: "recovery", side: null, read: null, alt: null, ready: false, bar: BASTION_RECOVERY_BAR, reason: "no recovery side armed" };
    }
    // STATIC bar — a function of the contract and its payout ONLY. Frozen.
    const bar = BastionPolicy.recoveryBarFor(best.contract);
    const ready = best.p >= bar;
    return {
      mode: "recovery",
      side: best.contract,
      read: best,
      alt,
      ready,
      bar,
      reason: ready
        ? `best recovery shot — ${best.contract.label} at ${(best.p * 100).toFixed(1)}% (pair-risk ${(best.pairRisk * 100).toFixed(0)}%)`
        : `no tilt yet (${(best.p * 100).toFixed(1)}% vs ${(bar * 100).toFixed(1)}% static bar) — holding for a better recovery opportunity`,
    };
  }
}

// ── Honest replay: the exact live policy, measured on unseen ticks ────────────

export interface BastionReplayMetrics {
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

const TAU_GRID_B = [0.6, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.8, 2.2];

/**
 * Paper session on unseen ticks: normal shots at the valve budget, losses drop
 * into recovery, recovery fires the best shot at the static bar until debt
 * clears. This is the live loop's policy — nothing softer, nothing harder.
 */
export function replayBastion(
  digits: ArrayLike<number>,
  params: BastionParams,
  opts?: { warmup?: number; normalPayout?: number; recoveryPayout?: number; sideMode?: BastionSideMode },
  hmmWindows?: BastionHMMWindows,
): { metrics: BastionReplayMetrics; policy: BastionPolicy } {
  const clean = cleanDigits(digits);
  const n = clean.length;
  const warmup = Math.min(Math.max(0, opts?.warmup ?? 300), Math.max(0, n - 50));
  const nPay = opts?.normalPayout ?? BASTION_NORMAL_CONTRACTS[0]!.payout;
  const rPay = opts?.recoveryPayout ?? BASTION_RECOVERY_CONTRACTS[0]!.payout;
  const sideMode = opts?.sideMode ?? "both";
  const policy = new BastionPolicy(params, hmmWindows);

  for (let i = 0; i < warmup; i++) policy.update(clean, i);

  let normalShots = 0, normalHits = 0;
  let recoveryShots = 0, recoveryHits = 0, recoveryLosses = 0, recoveryLossPairs = 0;
  let paper = 0, sumP = 0;
  let inRecovery = false, prevRecoveryLoss = false;
  let ticksInRec = 0, recEpisodes = 0, episodeTicks = 0;

  for (let i = warmup; i < n - 1; i++) {
    const next = clean[i + 1]!;
    if (inRecovery) episodeTicks++;
    const dec = inRecovery
      ? policy.decideRecovery(clean, i)
      : policy.decideNormal(clean, i, sideMode);
    if (dec.ready && dec.side && dec.read) {
      const hit = dec.side.wins[next] ? 1 : 0;
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
  const metrics: BastionReplayMetrics = {
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

export interface BastionFit {
  params: BastionParams;
  train: BastionReplayMetrics;
  test: BastionReplayMetrics;
}

/**
 * Rolling HMM windows (per contract, the tail of the supplied PAST tape) used
 * to warm a live policy's regime lenses. The engine calls this on the full
 * tape it has at refit time (everything is past — causal); the honest replays
 * call it on the TRAIN segment's tail only.
 */
export function buildHMMWindows(digits: ArrayLike<number>): BastionHMMWindows {
  const out: BastionHMMWindows = {};
  for (const c of BASTION_ALL_CONTRACTS) {
    const w = bandIndicators(digits, c.wins, BASTION_HMM_WINDOW);
    if (w.length >= 40) out[c.id] = w;
  }
  return out;
}

/** HMM windows (per contract, tail of the TRAIN segment) for honest replays. */
function trainHMMWindows(train: number[]): BastionHMMWindows {
  return buildHMMWindows(train);
}

/**
 * MODEL-AVERAGED FIT — per-lens binary log-loss is collected over THREE
 * overlapping training windows ([0,60%), [20%,80%), [40%,100%]); the skill
 * weights are the (renormalized) MEAN of the three window weight vectors, so
 * one unlucky window cannot dominate the policy. τ is selected on the pooled
 * union of all collected lens vectors; the valve seed is the MEDIAN of the
 * three window quantiles. Each window's regime-HMM probe is fitted strictly on
 * that window's first ticks (before the collection region) — causal.
 */
export function fitBastionParams(
  digits: ArrayLike<number>,
  opts?: { normalPayout?: number; recoveryPayout?: number },
): BastionFit {
  const clean = cleanDigits(digits);
  const split = Math.floor(clean.length * BASTION_TRAIN_FRACTION);
  const train = clean.slice(0, split);
  const test = clean.slice(split);

  if (clean.length < BASTION_MIN_FIT_DIGITS || train.length < 250 || test.length < 120) {
    const params: BastionParams = { weights: [0.3, 0.3, 0.2, 0.2, 0, 0] as BastionWeightVec, tau: 1, normalInitBar: 0.81 };
    const { metrics } = replayBastion(clean, params, { warmup: Math.min(200, Math.floor(clean.length / 3)), ...opts });
    return { params, train: metrics, test: metrics };
  }

  const N = clean.length;
  const windowBounds: Array<[number, number]> = [
    [0, split],
    [Math.floor(N * 0.2), Math.floor(N * 0.8)],
    [Math.floor(N * 0.4), N],
  ];

  const pooled: Array<{ lenses: [number, number, number, number, number, number]; event: number }> = [];
  const windowWeights: number[][] = [];
  const windowSeeds: number[] = [];
  const baseline = Math.log(2);

  for (const [ws, we] of windowBounds) {
    const win = clean.slice(ws, we);
    if (win.length < 300) continue;
    const warm = Math.min(600, Math.max(20, win.length - 50));
    // Regime HMM fitted on the window's FIRST ticks only — causal w.r.t. the
    // collection region that starts at `warm`.
    const hmmWin: BastionHMMWindows = {};
    for (const c of BASTION_ALL_CONTRACTS) {
      const w = win.slice(0, warm);
      if (w.length >= 40) hmmWin[c.id] = bandIndicators(w, c.wins, w.length);
    }
    const probe = new BastionPolicy(
      { weights: [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6] as BastionWeightVec, tau: 1, normalInitBar: 0.81 },
      hmmWin,
    );
    for (let i = 0; i < warm; i++) probe.update(win, i);

    const ll = [0, 0, 0, 0, 0, 0];
    const normalScores: number[] = [];
    let llN = 0;

    for (let i = warm; i < win.length - 1; i++) {
      const next = win[i + 1]!;
      for (const c of BASTION_ALL_CONTRACTS) {
        const read = probe.readSide(win, i, c);
        const event = c.wins[next] ? 1 : 0;
        for (let j = 0; j < 6; j++) {
          const pj = Math.min(1 - 1e-9, Math.max(1e-9, read.lenses[j]!));
          ll[j]! += -(event ? Math.log(pj) : Math.log(1 - pj));
        }
        pooled.push({ lenses: read.lenses, event });
        llN++;
      }
      const reads = BASTION_NORMAL_CONTRACTS.map(c => probe.readSide(win, i, c));
      reads.sort((a, b) => b.utility - a.utility);
      if (reads[0]) normalScores.push(reads[0].p);
      probe.update(win, i + 1);
    }

    windowWeights.push(
      weightsFromSkillN(llN > 0 ? ll.map(v => v / llN) : Array.from({ length: 6 }, () => baseline), baseline),
    );
    if (normalScores.length > 0) {
      normalScores.sort((a, b) => a - b);
      windowSeeds.push(quantile(normalScores, 1 - BASTION_NORMAL_PACE_TARGET));
    }
  }

  // Model-averaged lens weights: mean of the window vectors, renormalized.
  const avg = new Array<number>(6).fill(0);
  for (const wv of windowWeights) {
    for (let j = 0; j < 6; j++) avg[j]! += wv[j]! / windowWeights.length;
  }
  const wSum = avg.reduce((a, b) => a + b, 0) || 1;
  const weights = avg.map(v => v / wSum) as BastionWeightVec;

  // ── τ on the skill-weighted pool of ALL collected lens vectors.
  let tau = 1;
  let bestLL = Infinity;
  for (const t of TAU_GRID_B) {
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

  // Valve seed: MEDIAN of the per-window quantiles (robust to one noisy window).
  const normalInitBar = windowSeeds.length
    ? quantile([...windowSeeds].sort((a, b) => a - b), 0.5)
    : 0.81;

  const params: BastionParams = { weights, tau, normalInitBar };
  // Honest replays use regime HMMs fitted on the TRAIN segment only.
  const hmmWindows = trainHMMWindows(train);
  const trainReplay = replayBastion(train, params, { warmup: 250, ...opts }, hmmWindows).metrics;
  const testReplay = replayBastion(test, params, { warmup: Math.min(250, Math.floor(test.length / 3)), ...opts }, hmmWindows).metrics;
  return { params, train: trainReplay, test: testReplay };
}

// ── One-market scan read ──────────────────────────────────────────────────────

export interface BastionDiag {
  weights: BastionWeightVec;
  tau: number;
  normalInitBar: number;
  historyUsed: number;
  /** q_LL per recovery side — the clustering estimates behind pair-risk. */
  qLL: { over3: number; under6: number };
  /** Regime-HMM belief in the hot state per recovery side (0..1). */
  regime: { over3: number; under6: number };
  fireRatePer100: number;
}

export interface BastionMarketRead {
  verdict: BastionVerdict;
  confidence: number;
  paperEdgePerDollar: number;
  normal: BastionReplayMetrics;
  recovery: BastionReplayMetrics;
  /** Alias of test metrics (normal + recovery are slices of one replay). */
  metrics: BastionReplayMetrics;
  params: BastionParams;
  diag: BastionDiag;
  thinData: boolean;
  breakEvenNormal: number;
  breakEvenRecovery: number;
}

export function scoreBastionMarket(
  digits: ArrayLike<number>,
  opts?: { normalPayout?: number; recoveryPayout?: number },
): BastionMarketRead {
  const clean = cleanDigits(digits);
  const nPay = opts?.normalPayout ?? BASTION_NORMAL_CONTRACTS[0]!.payout;
  const rPay = opts?.recoveryPayout ?? BASTION_RECOVERY_CONTRACTS[0]!.payout;
  const thinData = clean.length < BASTION_MIN_MEASURE_DIGITS;

  const fit = fitBastionParams(clean, { normalPayout: nPay, recoveryPayout: rPay });
  const m = fit.test;

  // Live q_LL + regime belief per recovery side on the full warmed state
  // (display + pair-risk). The probe's regime HMMs are fitted on the TRAIN
  // segment's tail and advanced over the whole tape — causal.
  const trainTail = clean.slice(0, Math.floor(clean.length * BASTION_TRAIN_FRACTION));
  const probe = new BastionPolicy(fit.params, trainHMMWindows(trainTail));
  for (let i = 0; i < clean.length; i++) probe.update(clean, i);
  const beliefs = probe.regimeBeliefs();
  const r3 = probe.readSide(clean, clean.length - 1, BASTION_RECOVERY_CONTRACTS[0]!);
  const r6 = probe.readSide(clean, clean.length - 1, BASTION_RECOVERY_CONTRACTS[1]!);

  // Verdict ladder — measurement honesty ONLY, never a deploy gate:
  //   PRIME  = the exact live policy made money on unseen ticks AND its train
  //            edge was not negative (a train-negative / test-positive result
  //            on a ~40% hold-out is overfit noise, not edge) AND the
  //            recovery band held its face-up win rate (the ladder survives)
  //   VIABLE = positive paper expectancy with real recovery mass
  //   THIN   = everything else
  const trainEdge = fit.train.paperEdgePerDollar;
  let verdict: BastionVerdict;
  if (!thinData && m.paperEdgePerDollar >= 0.02 && trainEdge > -0.02 && m.recoveryShots >= 6 && m.recoveryHitRate >= 0.58 && m.normalShots >= 6) {
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
        over3: Math.round(r3.qLL * 1000) / 1000,
        under6: Math.round(r6.qLL * 1000) / 1000,
      },
      regime: {
        over3: Math.round((beliefs["over3"] ?? 0.5) * 1000) / 1000,
        under6: Math.round((beliefs["under6"] ?? 0.5) * 1000) / 1000,
      },
      fireRatePer100: Math.round(m.fireRatePer100 * 100) / 100,
    },
    thinData,
    breakEvenNormal: 1 / nPay,
    breakEvenRecovery: 1 / rPay,
  };
}
