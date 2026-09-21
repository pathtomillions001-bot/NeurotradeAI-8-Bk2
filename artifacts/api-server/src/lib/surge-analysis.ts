/**
 * VECTOR SURGE — Rise/Fall momentum specialist with recovery-first intelligence.
 *
 * Normal:   Rise (CALL) / Fall (PUT)  — 1 tick, 1.92× (≈52.08% break-even)
 * Recovery: Rise / Fall               — same contracts, different selection
 *
 * The whole edge lives in RECOVERY quality: the ladder dies to loss PAIRS,
 * so everything below is built to pick the recovery side with the highest
 * payoff-weighted probability AND the lowest probability of extending a loss
 * run. Four independent lenses read the direction win event from a different
 * mathematical structure of the price tape:
 *
 *  1. DIRECTION MARKOV — order-1..2 chains over the 2-state RISE / NOT-RISE
 *     and FALL / NOT-FALL processes with Jeffreys Dirichlet smoothing and
 *     count-mixed order shrinkage. The losing direction of the last trade IS
 *     the conditioning state for the next recovery shot. ~2× independent
 *     chains (rise-chain + fall-chain) so each conditional carries calibrated
 *     evidence.
 *  2. RUN HAZARD — the winning/losing run's age is scored by a Kaplan–Meier
 *     discrete hazard over the censored run-length history;
 *     P(win) = 1 − h(age) or h(age) depending whether the open run is FOR
 *     or AGAINST the target. This is the strongest serial signal for a
 *     1-tick direction — "rises have run 5 — how likely does fall arrive now".
 *  3. HURST-DRIFT — Hurst exponent by rescaled-range (R/S) on the last 80
 *     returns, split-half-agreement filtered, blended with an EMA drift
 *     t-statistic (σ_EMA = σ_resid·√(α/(2−α)), α=0.10). Trending (H>0.55)
 *     ⇒ ride the last move; mean-reverting (H<0.45) ⇒ fade it; ambiguous
 *     (halves disagree) ⇒ no regime claim. Drift magnitude must be
 *     significant (t≥1.5) and multi-scale direction rates must agree before a
 *     trending tilt is trusted — a sign-only trend with no magnitude support
 *     is discounted to 25%. Realised-volatility and flat-rate guards refuse
 *     dead chop where direction is a coin flip minus spread.
 *  4. SUFFIX MEMORY — decayed longest-match continuation (orders 2–5) over
 *     the ternary direction stream (rise / fall / flat) with exponential
 *     half-life 600 ticks and Laplace smoothing: what direction followed THIS
 *     exact micro-pattern before, with recent structure weighing more.
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
 *  - Recovery shots use ONE static quality bar (break-even 1/1.92): the best
 *    available shot fires THE NEXT TICK it clears the bar —
 *    THERE IS NO POST-LOSS TIGHTENING ANYWHERE IN THIS FILE. No function on the
 *    recovery path even accepts a loss-run argument; the bar cannot harden
 *    after a recovery loss because it is a frozen constant. If no side clears
 *    the bar the bot waits (and, in switching mode, hunts a better market).
 *
 * HONEST MEASUREMENT — `fitSurgeParams` fits weights/τ on the first 60%
 * and `replaySurge` replays the EXACT live policy (paper session,
 * normal → loss → recovery → clear) on the final 40%: normal hit rate,
 * RECOVERY hit rate, RECOVERY LOSS PAIRS and ticks spent in debt, per market.
 * Verdicts (PRIME / VIABLE / THIN) describe what was measured — labels only,
 * never a deploy gate.
 *
 * Everything here is pure and synchronous: no Deriv imports, no DB, no clock.
 */

// ── Frozen contracts ─────────────────────────────────────────────────────────

export type SurgeContractId = "rise" | "fall";
export type SurgeMode = "normal" | "recovery";
export type SurgeSideMode = "both" | "rise" | "fall";
export type SurgeVerdict = "prime" | "viable" | "thin";

export interface SurgeContract {
  id: SurgeContractId;
  mode: SurgeMode;
  contractType: "CALL" | "PUT";
  label: string;
  /** Combinatorial fair rate (without flat). Payout drives the bar. */
  fair: number;
  /** Canonical fallback payout (live quotes override at execution). */
  payout: number;
}

export const SURGE_NORMAL_CONTRACTS: readonly SurgeContract[] = Object.freeze([
  { id: "rise", mode: "normal", contractType: "CALL", label: "Rise", fair: 0.5, payout: 1.92 },
  { id: "fall", mode: "normal", contractType: "PUT", label: "Fall", fair: 0.5, payout: 1.92 },
]);

export const SURGE_RECOVERY_CONTRACTS: readonly SurgeContract[] = Object.freeze([
  { id: "rise", mode: "recovery", contractType: "CALL", label: "Rise", fair: 0.5, payout: 1.92 },
  { id: "fall", mode: "recovery", contractType: "PUT", label: "Fall", fair: 0.5, payout: 1.92 },
]);

export const SURGE_ALL_CONTRACTS: readonly SurgeContract[] = Object.freeze([
  ...SURGE_NORMAL_CONTRACTS,
  ...SURGE_RECOVERY_CONTRACTS,
]);

export function surgeContractById(id: SurgeContractId, mode: SurgeMode = "normal"): SurgeContract {
  const pool = mode === "recovery" ? SURGE_RECOVERY_CONTRACTS : SURGE_NORMAL_CONTRACTS;
  const c = pool.find(x => x.id === id);
  if (!c) throw new Error(`unknown surge contract: ${id} (${mode})`);
  return c;
}

/**
 * THE recovery quality bar — break-even 1/1.92 = 52.083% + cushion = 53%.
 * Frozen: recovery fires the best shot the moment its fused win probability
 * beats this, and NOTHING — least of all the current loss run — moves it.
 */
export const SURGE_RECOVERY_BAR = 0.53;
/** Normal shots ride the pacing valve at this budget (shots per tick). */
export const SURGE_NORMAL_PACE_TARGET = 0.2;
/** Loss-pair penalty weight in the recovery utility. */
export const SURGE_RECOVERY_PAIR_WEIGHT = 0.45;
/** Lighter loss-pair penalty for normal side arbitration. */
export const SURGE_NORMAL_PAIR_WEIGHT = 0.15;

export const SURGE_TRAIN_FRACTION = 0.6;
export const SURGE_MIN_FIT_PRICES = 600;
export const SURGE_MIN_MEASURE_PRICES = 300;

// ── Small math helpers ────────────────────────────────────────────────────────

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

export function logit(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
}

/** Logarithmic opinion pool for Bernoulli events (weighted mean of logits). */
export function logPoolBinary(ps: readonly number[], weights: readonly number[]): number {
  let s = 0; let w = 0;
  for (let i = 0; i < ps.length; i++) { const wi = weights[i] ?? 0; s += wi * logit(ps[i]!); w += wi; }
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

function cleanPrices(prices: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < prices.length; i++) { const v = prices[i]!; if (Number.isFinite(v) && v > 0) out.push(v); }
  return out;
}

// direction helpers: 0 flat, 1 rise, 2 fall
function dirAt(prices: ArrayLike<number>, idx: number): number {
  if (idx < 1) return 0;
  const a = prices[idx - 1]!; const b = prices[idx]!;
  if (b > a) return 1;
  if (b < a) return 2;
  return 0;
}
function riseIndicator(prices: ArrayLike<number>, idx: number): number {
  if (idx < 1) return 0; return prices[idx]! > prices[idx - 1]! ? 1 : 0;
}
function fallIndicator(prices: ArrayLike<number>, idx: number): number {
  if (idx < 1) return 0; return prices[idx]! < prices[idx - 1]! ? 1 : 0;
}

// ── Hurst helper (R/S on returns) ───────────────────────────────────────────
function hurstExponent(returns: number[]): number {
  const n = returns.length;
  if (n < 32) return 0.5;
  const logN: number[] = []; const logRS: number[] = [];
  for (let size = 4; size <= Math.floor(n / 2); size = Math.floor(size * 1.5)) {
    const segments = Math.floor(n / size); if (segments < 1) break;
    let acc = 0; let used = 0;
    for (let s = 0; s < segments; s++) {
      const seg = returns.slice(s * size, (s + 1) * size);
      const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
      const sd = Math.sqrt(seg.reduce((a, v) => a + (v - mean) ** 2, 0) / seg.length);
      if (sd < 1e-12) continue;
      let cum = 0; let maxCum = -Infinity; let minCum = Infinity;
      for (const v of seg) { cum += v - mean; if (cum > maxCum) maxCum = cum; if (cum < minCum) minCum = cum; }
      acc += (maxCum - minCum) / sd; used++;
    }
    if (used === 0) continue;
    logN.push(Math.log(size)); logRS.push(Math.log(acc / used));
  }
  if (logN.length < 3) return 0.5;
  const meanX = logN.reduce((a, b) => a + b, 0) / logN.length;
  const meanY = logRS.reduce((a, b) => a + b, 0) / logRS.length;
  let num = 0; let den = 0;
  for (let i = 0; i < logN.length; i++) { num += (logN[i]! - meanX) * (logRS[i]! - meanY); den += (logN[i]! - meanX) ** 2; }
  if (den < 1e-12) return 0.5;
  const h = num / den; return h < 0 ? 0 : h > 1 ? 1 : h;
}

// ── Lens 1: direction Markov (order 1–2) over RISE and FALL binary series ────
const JEFFREYS = 0.5;
const ORDER2_BLEND = 8;
const ORDER1_BLEND = 12;

export class SurgeMarkov {
  // RISE chain: P(rise)
  private rise_c1 = new Float64Array(2 * 2);
  private rise_n1 = new Float64Array(2);
  private rise_c2 = new Float64Array(4 * 2);
  private rise_n2 = new Float64Array(4);
  // FALL chain: P(fall)
  private fall_c1 = new Float64Array(2 * 2);
  private fall_n1 = new Float64Array(2);
  private fall_c2 = new Float64Array(4 * 2);
  private fall_n2 = new Float64Array(4);

  update(prices: ArrayLike<number>, idx: number): void {
    if (idx < 1) return;
    // Rise chain: need two consecutive rise indicators to form a transition
    if (idx >= 2) {
      const prevR = riseIndicator(prices, idx - 1);
      const curR = riseIndicator(prices, idx);
      this.rise_c1[prevR * 2 + curR]! += 1;
      this.rise_n1[prevR]! += 1;
      if (idx >= 3) {
        const prev2R = riseIndicator(prices, idx - 2);
        const ctx = prev2R * 2 + prevR;
        this.rise_c2[ctx * 2 + curR]! += 1;
        this.rise_n2[ctx]! += 1;
      }
      const prevF = fallIndicator(prices, idx - 1);
      const curF = fallIndicator(prices, idx);
      this.fall_c1[prevF * 2 + curF]! += 1;
      this.fall_n1[prevF]! += 1;
      if (idx >= 3) {
        const prev2F = fallIndicator(prices, idx - 2);
        const ctxF = prev2F * 2 + prevF;
        this.fall_c2[ctxF * 2 + curF]! += 1;
        this.fall_n2[ctxF]! += 1;
      }
    }
  }

  /** P(next wins) for target contract given last indicator. */
  p(prices: ArrayLike<number>, idx: number, target: SurgeContractId): number {
    const isRise = target === "rise";
    const last = isRise ? riseIndicator(prices, idx) : fallIndicator(prices, idx);
    const n1 = isRise ? this.rise_n1[last]! : this.fall_n1[last]!;
    const c1 = isRise ? this.rise_c1[last * 2 + 1]! : this.fall_c1[last * 2 + 1]!;
    const e1 = (c1 + JEFFREYS) / (n1 + 2 * JEFFREYS);
    const w1 = n1 / (n1 + ORDER1_BLEND);
    const mixed1 = (1 - w1) * 0.5 + w1 * e1;
    if (idx < 2) return mixed1;
    const prev2 = isRise ? riseIndicator(prices, idx - 1) : fallIndicator(prices, idx - 1);
    const ctx = prev2 * 2 + last;
    const n2 = isRise ? this.rise_n2[ctx]! : this.fall_n2[ctx]!;
    if (n2 === 0) return mixed1;
    const c2 = isRise ? this.rise_c2[ctx * 2 + 1]! : this.fall_c2[ctx * 2 + 1]!;
    const e2 = (c2 + JEFFREYS) / (n2 + 2 * JEFFREYS);
    const w2 = n2 / (n2 + ORDER2_BLEND);
    return (1 - w2) * mixed1 + w2 * e2;
  }

  qLLForSide(target: SurgeContractId): number {
    const isRise = target === "rise";
    // P(loss|loss) where loss = indicator 0
    const n = isRise ? this.rise_n1[0]! : this.fall_n1[0]!;
    const cWinGivenLoss = isRise ? this.rise_c1[0 * 2 + 1]! : this.fall_c1[0 * 2 + 1]!;
    const pWinGivenLoss = (cWinGivenLoss + JEFFREYS) / (n + 2 * JEFFREYS);
    const w = n / (n + ORDER1_BLEND);
    const smoothed = (1 - w) * 0.5 + w * pWinGivenLoss;
    return clamp01(1 - smoothed);
  }
}

// ── Lens 2: run hazard (Kaplan–Meier) for RISE and FALL runs ────────────────
const HAZARD_MAX_AGE = 40;

class SingleHazard {
  died = new Float64Array(HAZARD_MAX_AGE + 1);
  atRisk = new Float64Array(HAZARD_MAX_AGE + 1);
  runStart = 0;
  runState = -1; // 0 not-target, 1 target
}

export class SurgeRunHazard {
  private rise = new SingleHazard();
  private fall = new SingleHazard();

  private updateSingle(s: SingleHazard, indicator: number, idx: number) {
    const state = indicator; // 1 = win for that target
    if (s.runState === -1) { s.runState = state; s.runStart = idx; return; }
    if (state !== s.runState) {
      const len = Math.min(HAZARD_MAX_AGE, idx - s.runStart);
      if (len >= 1) { s.died[len]! += 1; for (let a = 1; a <= len; a++) s.atRisk[a]! += 1; }
      s.runState = state; s.runStart = idx;
    }
  }

  update(prices: ArrayLike<number>, idx: number): void {
    if (idx < 1) return;
    this.updateSingle(this.rise, riseIndicator(prices, idx), idx);
    this.updateSingle(this.fall, fallIndicator(prices, idx), idx);
  }

  p(prices: ArrayLike<number>, idx: number, target: SurgeContractId): number {
    const isRise = target === "rise";
    const s = isRise ? this.rise : this.fall;
    const cur = isRise ? riseIndicator(prices, idx) : fallIndicator(prices, idx);
    // open run length includes current tick
    const age = idx - s.runStart + 1;
    const a = Math.min(HAZARD_MAX_AGE, Math.max(1, age));
    const h = (s.died[a]! + 1) / (s.atRisk[a]! + 2);
    // If current run IS the target (we are in a winning run), next is win iff run continues: 1-h
    // If current run is against target, next is win iff run ends: h
    return cur === 1 ? clamp01(1 - h) : clamp01(h);
  }
}

// ── Lens 3: Hurst-Drift — fractal regime + magnitude drift ──────────────────
export class SurgeHurstDrift {
  // No persistent state: computed on the fly from price window, but we keep
  // last values for diagnostics.
  lastHurst = 0.5;
  lastDriftT = 0;

  p(prices: ArrayLike<number>, idx: number, target: SurgeContractId): number {
    // need at least 35 prices for a meaningful Hurst window
    if (idx < 34) return 0.5;
    const start = Math.max(0, idx - 79);
    const windowPrices = Array.from({ length: idx - start + 1 }, (_, k) => prices[start + k]!);
    const returns: number[] = [];
    for (let i = 1; i < windowPrices.length; i++) returns.push(windowPrices[i]! - windowPrices[i - 1]!);
    if (returns.length < 30) return 0.5;

    const hurst = hurstExponent(returns);
    this.lastHurst = hurst;

    // split-half agreement: trending claim only when both halves agree
    let hurstAgreement = 1;
    let h1 = hurst; let h2 = hurst;
    if (returns.length >= 64) {
      const half = Math.floor(returns.length / 2);
      h1 = hurstExponent(returns.slice(0, half));
      h2 = hurstExponent(returns.slice(half));
      const regime = (h: number) => h > 0.55 ? 1 : h < 0.45 ? -1 : 0;
      hurstAgreement = regime(h1) === regime(h2) ? 1 : 0;
    }
    const trending = hurstAgreement === 1 && hurst > 0.55;
    const meanReverting = hurstAgreement === 1 && hurst < 0.45;
    const noRegime = hurstAgreement === 0;

    // EMA drift t-stat
    const alpha = 0.10;
    let drift = 0;
    const resid: number[] = [];
    for (const r of returns) {
      const prev = drift;
      drift = alpha * r + (1 - alpha) * drift;
      resid.push(r - prev);
    }
    const residMean = resid.reduce((a, b) => a + b, 0) / resid.length;
    const residSd = Math.sqrt(resid.reduce((a, v) => a + (v - residMean) ** 2, 0) / resid.length) || 1e-9;
    const driftSe = residSd * Math.sqrt(alpha / (2 - alpha));
    const driftT = driftSe > 1e-12 ? drift / driftSe : 0;
    this.lastDriftT = driftT;
    const driftSupported = Math.abs(driftT) >= 1.5;

    // multi-scale direction consistency
    const dirRate = (k: number) => returns.slice(-k).filter(r => r > 0).length / Math.max(1, Math.min(k, returns.length));
    const d10 = dirRate(10); const d30 = dirRate(30); const d80 = dirRate(Math.min(80, returns.length));
    const dirAgreement = (d10 > 0.52 && d30 > 0.52 && d80 > 0.52) || (d10 < 0.48 && d30 < 0.48 && d80 < 0.48) ? 1 : 0;

    // realised vol + flat guards
    const meanAbs = returns.reduce((a, b) => a + Math.abs(b), 0) / returns.length;
    const flatRate = returns.filter(r => Math.abs(r) < 1e-12).length / returns.length;
    const sd = Math.sqrt(returns.reduce((a, b) => a + (b - drift) ** 2, 0) / returns.length);
    const volRatio = meanAbs > 1e-12 ? sd / meanAbs : 0;
    const deadChop = flatRate > 0.35 || volRatio < 0.75;

    // Hurst tilt
    const lastReturn = returns[returns.length - 1]!;
    const lastDirSign = lastReturn > 0 ? 1 : lastReturn < 0 ? -1 : 0;
    const regimeStrength = clamp01(Math.abs(hurst - 0.5) / 0.5); // 0..1
    let hurstP = 0.5;
    if (!noRegime) {
      if (trending) {
        // ride: same direction as last move more likely
        const strength = driftSupported && dirAgreement === 1 ? 1 : 0.25;
        const tilt = 0.14 * strength * regimeStrength * lastDirSign;
        hurstP = 0.5 + tilt;
      } else if (meanReverting) {
        // fade: opposite more likely when run extended
        const runLen = (() => { let c = 0; const lastSign = Math.sign(lastReturn); for (let i = returns.length - 1; i >= 0; i--) { if (Math.sign(returns[i]!) === lastSign && lastSign !== 0) c++; else break; } return c; })();
        const extended = runLen >= 2 ? 1 : 0;
        const tilt = 0.12 * regimeStrength * (extended ? 1 : 0.3) * lastDirSign;
        hurstP = 0.5 - tilt; // opposite
      }
    }
    hurstP = clamp01(hurstP);

    // Drift probability via sigmoid of t-stat
    const driftP = sigmoid(driftT * 0.9); // positive drift => high P(Rise)
    // Dead chop pushes toward 0.5
    const adjDriftP = deadChop ? 0.5 + (driftP - 0.5) * 0.3 : driftP;
    const adjHurstP = deadChop ? 0.5 + (hurstP - 0.5) * 0.3 : hurstP;

    // Blend hurst and drift equally inside the lens
    const blended = (adjHurstP + adjDriftP) / 2;

    // Map to target: blended is P(Rise). For Fall, complement with flat compensation
    if (target === "rise") return clamp01(blended);
    // P(Fall) = 1 - P(Rise) - P(flat) ??? For simplicity mirror via drift inversion:
    // driftP for fall is 1 - driftP, hurstP for fall is 1 - hurstP, so avg is 1 - blended
    // But flat mass makes  P(Fall) < 1-P(Rise). We approximate P(Fall)= 1 - blended - flatRate/2
    // and keep >0.12.
    const pFall = clamp01(1 - blended - flatRate * 0.5);
    return pFall;
  }
}

// ── Lens 4: suffix direction memory (decayed longest-match, orders 2–5) ─────
const SUFFIX_MAX_ORDER = 5;
const SUFFIX_MIN_SAMPLES = 6;
const SUFFIX_MAX_ENTRIES = 4000;
const SUFFIX_HALFLIFE_TICKS = 600;
const SUFFIX_LAPLACE = 1.8;

export class SuffixDirectionMemory {
  private tables = new Map<string, { counts: Float64Array; total: number; stamp: number }>();
  private clock = 0;
  private dirHistory: number[] = []; // ternary 0/1/2 per price step (index = price idx)

  private decay(entry: { counts: Float64Array; total: number; stamp: number }): void {
    const dt = this.clock - entry.stamp;
    if (dt <= 0) return;
    const f = Math.pow(0.5, dt / SUFFIX_HALFLIFE_TICKS);
    for (let k = 0; k < 3; k++) entry.counts[k]! *= f;
    entry.total *= f;
    entry.stamp = this.clock;
  }

  update(prices: ArrayLike<number>, idx: number): void {
    this.clock++;
    if (idx < 1) { this.dirHistory[idx] = 0; return; }
    const d = dirAt(prices, idx);
    this.dirHistory[idx] = d;
    const nextDir = d; // direction that just arrived at idx
    // For each order, the context that predicted this nextDir is the o dirs before it
    for (let order = 2; order <= SUFFIX_MAX_ORDER; order++) {
      if (idx < order) continue;
      // context = dirs idx-order .. idx-1
      let key = String(order);
      for (let k = idx - order; k < idx; k++) key += `:${this.dirHistory[k] ?? 0}`;
      let entry = this.tables.get(key);
      if (!entry) {
        if (this.tables.size >= SUFFIX_MAX_ENTRIES) continue;
        entry = { counts: new Float64Array(3), total: 0, stamp: this.clock };
        this.tables.set(key, entry);
      }
      this.decay(entry);
      entry.counts[nextDir]! += 1;
      entry.total += 1;
    }
  }

  /** Longest context with mass: P(next is targetDir | exact direction suffix). */
  p(prices: ArrayLike<number>, idx: number, target: SurgeContractId): number {
    const targetDir = target === "rise" ? 1 : 2;
    if (idx < 1) return 0.5;
    // ensure local dirHistory is populated up to idx for lookups (in replay p may be called before update for same idx? but policy calls read before update for next tick, so history up to idx is available)
    for (let order = Math.min(SUFFIX_MAX_ORDER, idx); order >= 2; order--) {
      let key = String(order);
      for (let k = idx - order + 1; k <= idx; k++) {
        // need dirs for k: direction at k (requires prices[k] vs k-1). If k==0 define 0.
        const d = k < 1 ? 0 : (this.dirHistory[k] ?? dirAt(prices, k));
        key += `:${d}`;
      }
      const entry = this.tables.get(key);
      if (entry) {
        this.decay(entry);
        if (entry.total >= SUFFIX_MIN_SAMPLES) {
          // Laplace: (count + alpha*prior)/(total+alpha) with prior flatRate? use uniform 1/3
          const prior = 1 / 3;
          return (entry.counts[targetDir]! + SUFFIX_LAPLACE * prior) / (entry.total + SUFFIX_LAPLACE);
        }
      }
    }
    return 0.5;
  }
}

// ── Pacing valve (normal shots only — recovery has the static bar) ───────────
export class PacingValve {
  bar: number;
  constructor(private readonly targetRate: number, initBar: number, private readonly floor = 0, private readonly kappa = 0.004) {
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
export interface SurgeParams {
  weights: [number, number, number, number];
  tau: number;
  normalInitBar: number;
}

export interface SurgeSideRead {
  contract: SurgeContract;
  p: number;
  pRaw: number;
  lenses: [number, number, number, number];
  qLL: number;
  pairRisk: number;
  utility: number;
  breakEven: number;
}

export interface SurgeDecision {
  mode: SurgeMode;
  side: SurgeContract | null;
  read: SurgeSideRead | null;
  alt: SurgeSideRead | null;
  ready: boolean;
  bar: number;
  reason: string;
}

export function sideUtility(p: number, payout: number, qLL: number, pairWeight: number): { utility: number; pairRisk: number } {
  const q = 1 - p;
  const pairRisk = q * Math.min(qLL, 0.95);
  const ev = p * payout - 1;
  return { utility: ev - pairWeight * pairRisk, pairRisk };
}

export class SurgePolicy {
  private markov = new SurgeMarkov();
  private runHazard = new SurgeRunHazard();
  private hurstDrift = new SurgeHurstDrift();
  private suffix = new SuffixDirectionMemory();
  private normalValve: PacingValve;

  constructor(private readonly params: SurgeParams) {
    this.normalValve = new PacingValve(SURGE_NORMAL_PACE_TARGET, params.normalInitBar, 0);
  }

  get fitted(): SurgeParams { return this.params; }
  get normalBar(): number { return this.normalValve.bar; }

  update(prices: ArrayLike<number>, idx: number): void {
    this.markov.update(prices, idx);
    this.runHazard.update(prices, idx);
    // hurstDrift has no incremental state
    this.suffix.update(prices, idx);
  }

  readSide(prices: ArrayLike<number>, idx: number, contract: SurgeContract): SurgeSideRead {
    const target = contract.id;
    const pM = this.markov.p(prices, idx, target);
    const pH = this.runHazard.p(prices, idx, target);
    const pD = this.hurstDrift.p(prices, idx, target);
    const pS = this.suffix.p(prices, idx, target);
    const lenses: [number, number, number, number] = [pM, pH, pD, pS];
    const pRaw = clamp01(logPoolBinary(lenses, this.params.weights));
    const p = clamp01(temperatureScaleBinary(pRaw, this.params.tau));
    const qLL = this.markov.qLLForSide(target);
    const pairWeight = contract.mode === "recovery" ? SURGE_RECOVERY_PAIR_WEIGHT : SURGE_NORMAL_PAIR_WEIGHT;
    const { utility, pairRisk } = sideUtility(p, contract.payout, qLL, pairWeight);
    return { contract, p, pRaw, lenses, qLL, pairRisk, utility, breakEven: 1 / contract.payout };
  }

  private best(prices: ArrayLike<number>, idx: number, contracts: readonly SurgeContract[]): { best: SurgeSideRead | null; alt: SurgeSideRead | null } {
    const reads = contracts.map(c => this.readSide(prices, idx, c));
    reads.sort((a, b) => b.utility - a.utility);
    return { best: reads[0] ?? null, alt: reads[1] ?? null };
  }

  decideNormal(prices: ArrayLike<number>, idx: number, sideMode: SurgeSideMode = "both"): SurgeDecision {
    const allowed = SURGE_NORMAL_CONTRACTS.filter(c =>
      sideMode === "both" || (sideMode === "rise" && c.id === "rise") || (sideMode === "fall" && c.id === "fall"));
    const pool = allowed.length ? allowed : SURGE_NORMAL_CONTRACTS;
    const { best, alt } = this.best(prices, idx, pool);
    if (!best) return { mode: "normal", side: null, read: null, alt: null, ready: false, bar: this.normalValve.bar, reason: "no side armed" };
    const ready = this.normalValve.observe(best.p);
    return {
      mode: "normal", side: best.contract, read: best, alt, ready, bar: this.normalValve.bar,
      reason: ready ? `valve open — ${best.contract.label} at ${(best.p * 100).toFixed(1)}%` : `pacing valve between normal shots (${best.p.toFixed(3)} vs bar ${this.normalValve.bar.toFixed(3)})`,
    };
  }

  decideRecovery(prices: ArrayLike<number>, idx: number): SurgeDecision {
    const { best, alt } = this.best(prices, idx, SURGE_RECOVERY_CONTRACTS);
    if (!best) return { mode: "recovery", side: null, read: null, alt: null, ready: false, bar: SURGE_RECOVERY_BAR, reason: "no recovery side armed" };
    const ready = best.p >= SURGE_RECOVERY_BAR;
    return {
      mode: "recovery", side: best.contract, read: best, alt, ready, bar: SURGE_RECOVERY_BAR,
      reason: ready ? `best recovery shot — ${best.contract.label} at ${(best.p * 100).toFixed(1)}% (pair-risk ${(best.pairRisk * 100).toFixed(0)}%)` : `no tilt yet (${(best.p * 100).toFixed(1)}% vs ${(SURGE_RECOVERY_BAR * 100).toFixed(0)}%) — holding for a better recovery opportunity`,
    };
  }
}

// ── Honest replay: the exact live policy, measured on unseen ticks ───────────
export interface SurgeReplayMetrics {
  ticks: number;
  normalShots: number; normalHits: number; normalHitRate: number; normalHitRateLower: number;
  recoveryShots: number; recoveryHits: number; recoveryHitRate: number; recoveryHitRateLower: number;
  recoveryLossPairs: number; recoveryLosses: number;
  avgTicksInRecovery: number;
  paperEdgePerDollar: number;
  fireRatePer100: number;
  avgP: number;
}

const TAU_GRID = [0.6, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.8, 2.2];

export function replaySurge(prices: ArrayLike<number>, params: SurgeParams, opts?: { warmup?: number; normalPayout?: number; recoveryPayout?: number; sideMode?: SurgeSideMode }): { metrics: SurgeReplayMetrics; policy: SurgePolicy } {
  const clean = cleanPrices(prices);
  const n = clean.length;
  const warmup = Math.min(Math.max(0, opts?.warmup ?? 300), Math.max(0, n - 50));
  const nPay = opts?.normalPayout ?? SURGE_NORMAL_CONTRACTS[0]!.payout;
  const rPay = opts?.recoveryPayout ?? SURGE_RECOVERY_CONTRACTS[0]!.payout;
  const sideMode = opts?.sideMode ?? "both";
  const policy = new SurgePolicy(params);
  for (let i = 0; i < warmup; i++) policy.update(clean, i);

  let normalShots = 0, normalHits = 0;
  let recoveryShots = 0, recoveryHits = 0, recoveryLosses = 0, recoveryLossPairs = 0;
  let paper = 0, sumP = 0;
  let inRecovery = false, prevRecoveryLoss = false;
  let ticksInRec = 0, recEpisodes = 0, episodeTicks = 0;

  for (let i = warmup; i < n - 1; i++) {
    const nextUp = clean[i + 1]! > clean[i]!;
    const nextDown = clean[i + 1]! < clean[i]!;
    if (inRecovery) episodeTicks++;
    const dec = inRecovery ? policy.decideRecovery(clean, i) : policy.decideNormal(clean, i, sideMode);
    if (dec.ready && dec.side && dec.read) {
      const hit = dec.side.id === "rise" ? (nextUp ? 1 : 0) : (nextDown ? 1 : 0);
      const payout = dec.mode === "recovery" ? rPay : nPay;
      sumP += dec.read.p;
      paper += hit ? (payout - 1) : -1;
      if (dec.mode === "recovery") {
        recoveryShots++; recoveryHits += hit;
        if (!hit) { recoveryLosses++; if (prevRecoveryLoss) recoveryLossPairs++; prevRecoveryLoss = true; }
        else { prevRecoveryLoss = false; inRecovery = false; ticksInRec += episodeTicks; recEpisodes++; episodeTicks = 0; }
      } else {
        normalShots++; normalHits += hit;
        if (!hit) { inRecovery = true; prevRecoveryLoss = false; episodeTicks = 0; }
      }
    }
    policy.update(clean, i + 1);
  }

  const measured = Math.max(1, n - 1 - warmup);
  const nw = wilson(normalHits, normalShots);
  const rw = wilson(recoveryHits, recoveryShots);
  const shots = normalShots + recoveryShots;
  const metrics: SurgeReplayMetrics = {
    ticks: measured,
    normalShots, normalHits, normalHitRate: normalShots > 0 ? normalHits / normalShots : 0, normalHitRateLower: normalShots > 0 ? nw.lower : 0,
    recoveryShots, recoveryHits, recoveryHitRate: recoveryShots > 0 ? recoveryHits / recoveryShots : 0, recoveryHitRateLower: recoveryShots > 0 ? rw.lower : 0,
    recoveryLossPairs, recoveryLosses,
    avgTicksInRecovery: recEpisodes > 0 ? ticksInRec / recEpisodes : 0,
    paperEdgePerDollar: shots > 0 ? paper / shots : 0,
    fireRatePer100: (shots / measured) * 100,
    avgP: shots > 0 ? sumP / shots : 0,
  };
  return { metrics, policy };
}

// ── Fit on train (pooled lens skill + τ), measure on held-out test ───────────
export interface SurgeFit { params: SurgeParams; train: SurgeReplayMetrics; test: SurgeReplayMetrics; }

export function fitSurgeParams(prices: ArrayLike<number>, opts?: { normalPayout?: number; recoveryPayout?: number }): SurgeFit {
  const clean = cleanPrices(prices);
  const split = Math.floor(clean.length * SURGE_TRAIN_FRACTION);
  const train = clean.slice(0, split);
  const test = clean.slice(split);
  if (clean.length < SURGE_MIN_FIT_PRICES || train.length < 250 || test.length < 120) {
    const params: SurgeParams = { weights: [0.3, 0.25, 0.2, 0.25], tau: 1, normalInitBar: 0.54 };
    const { metrics } = replaySurge(clean, params, { warmup: Math.min(200, Math.floor(clean.length / 3)), ...opts });
    return { params, train: metrics, test: metrics };
  }

  const probe = new SurgePolicy({ weights: [0.25, 0.25, 0.25, 0.25], tau: 1, normalInitBar: 0.54 });
  for (let i = 0; i < 300 && i < train.length; i++) probe.update(train, i);

  const ll = [0, 0, 0, 0];
  const pooled: Array<{ lenses: [number, number, number, number]; event: number }> = [];
  const normalScores: number[] = [];
  let llN = 0;

  for (let i = 300; i < train.length - 1; i++) {
    const nextUp = train[i + 1]! > train[i]!;
    const nextDown = train[i + 1]! < train[i]!;
    for (const c of SURGE_ALL_CONTRACTS) {
      const target = c.id;
      const read = probe.readSide(train, i, c);
      const event = target === "rise" ? (nextUp ? 1 : 0) : (nextDown ? 1 : 0);
      for (let j = 0; j < 4; j++) {
        const pj = Math.min(1 - 1e-9, Math.max(1e-9, read.lenses[j]!));
        ll[j]! += -(event ? Math.log(pj) : Math.log(1 - pj));
      }
      pooled.push({ lenses: read.lenses, event });
      llN++;
    }
    const reads = SURGE_NORMAL_CONTRACTS.map(c => probe.readSide(train, i, c));
    reads.sort((a, b) => b.utility - a.utility);
    if (reads[0]) normalScores.push(reads[0].p);
    probe.update(train, i + 1);
  }

  const baseline = Math.log(2);
  const weightsArr = weightsFromSkillN(llN > 0 ? ll.map(v => v / llN) : [baseline, baseline, baseline, baseline], baseline);
  const weights = [weightsArr[0]!, weightsArr[1]!, weightsArr[2]!, weightsArr[3]!] as [number, number, number, number];

  let tau = 1; let bestLL = Infinity;
  for (const t of TAU_GRID) {
    let l = 0;
    for (const s of pooled) {
      const raw = logPoolBinary(s.lenses, weights);
      const p = temperatureScaleBinary(raw, t);
      l += -(s.event ? Math.log(Math.max(1e-9, p)) : Math.log(Math.max(1e-9, 1 - p)));
    }
    if (l < bestLL) { bestLL = l; tau = t; }
  }

  normalScores.sort((a, b) => a - b);
  const normalInitBar = normalScores.length > 0 ? quantile(normalScores, 1 - SURGE_NORMAL_PACE_TARGET) : 0.54;

  const params: SurgeParams = { weights, tau, normalInitBar };
  const trainReplay = replaySurge(train, params, { warmup: 250, ...opts }).metrics;
  const testReplay = replaySurge(test, params, { warmup: Math.min(250, Math.floor(test.length / 3)), ...opts }).metrics;
  return { params, train: trainReplay, test: testReplay };
}

// ── One-market scan read ──────────────────────────────────────────────────────
export interface SurgeDiag {
  weights: [number, number, number, number];
  tau: number;
  normalInitBar: number;
  historyUsed: number;
  qLL: { rise: number; fall: number };
  fireRatePer100: number;
  hurst: number;
}

export interface SurgeMarketRead {
  verdict: SurgeVerdict;
  confidence: number;
  paperEdgePerDollar: number;
  normal: SurgeReplayMetrics;
  recovery: SurgeReplayMetrics;
  metrics: SurgeReplayMetrics;
  params: SurgeParams;
  diag: SurgeDiag;
  thinData: boolean;
  breakEven: number;
}

export function scoreSurgeMarket(prices: ArrayLike<number>, opts?: { normalPayout?: number; recoveryPayout?: number }): SurgeMarketRead {
  const clean = cleanPrices(prices);
  const nPay = opts?.normalPayout ?? SURGE_NORMAL_CONTRACTS[0]!.payout;
  const rPay = opts?.recoveryPayout ?? SURGE_RECOVERY_CONTRACTS[0]!.payout;
  const thinData = clean.length < SURGE_MIN_MEASURE_PRICES;

  const fit = fitSurgeParams(clean, { normalPayout: nPay, recoveryPayout: rPay });
  const m = fit.test;

  const probe = new SurgePolicy(fit.params);
  for (let i = 0; i < clean.length; i++) probe.update(clean, i);
  const rRise = probe.readSide(clean, clean.length - 1, SURGE_RECOVERY_CONTRACTS[0]!);
  const rFall = probe.readSide(clean, clean.length - 1, SURGE_RECOVERY_CONTRACTS[1]!);
  // hurst for diag
  let hurstDiag = 0.5;
  try {
    if (clean.length >= 80) {
      const returns: number[] = [];
      for (let i = Math.max(1, clean.length - 80); i < clean.length; i++) returns.push(clean[i]! - clean[i - 1]!);
      hurstDiag = hurstExponent(returns);
    }
  } catch { hurstDiag = 0.5; }

  let verdict: SurgeVerdict;
  if (!thinData && m.paperEdgePerDollar >= 0.02 && m.recoveryShots >= 6 && m.recoveryHitRate >= 0.56 && m.normalShots >= 6) verdict = "prime";
  else if (!thinData && m.paperEdgePerDollar > 0 && m.recoveryShots >= 4) verdict = "viable";
  else verdict = "thin";

  let confidence: number;
  if (verdict === "prime") confidence = 70 + Math.min(25, Math.round(m.paperEdgePerDollar * 500));
  else if (verdict === "viable") confidence = 45 + Math.min(20, Math.round(m.paperEdgePerDollar * 500));
  else confidence = Math.max(15, Math.min(44, 30 + Math.round(m.paperEdgePerDollar * 300)));
  if (thinData) confidence = Math.min(confidence, 35);

  return {
    verdict, confidence, paperEdgePerDollar: Math.round(m.paperEdgePerDollar * 10000) / 10000,
    normal: m, recovery: m, metrics: m, params: fit.params,
    diag: {
      weights: fit.params.weights, tau: Math.round(fit.params.tau * 100) / 100,
      normalInitBar: Math.round(fit.params.normalInitBar * 10000) / 10000,
      historyUsed: clean.length,
      qLL: { rise: Math.round(rRise.qLL * 1000) / 1000, fall: Math.round(rFall.qLL * 1000) / 1000 },
      fireRatePer100: Math.round(m.fireRatePer100 * 100) / 100,
      hurst: Math.round(hurstDiag * 1000) / 1000,
    },
    thinData, breakEven: 1 / rPay,
  };
}
