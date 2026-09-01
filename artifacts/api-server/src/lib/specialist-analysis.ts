/**
 * Specialist Analysis Layer — the statistical edge a single-contract
 * specialist can afford and a generalist cannot.
 *
 * The NeuroAI Quantum FAB analyses SIX contract families (Over/Under, Even/Odd,
 * Match, Differ, Rise, Fall) on every tick, so each of its estimators has to
 * stay cheap and generic: one 10×10 digit transition matrix, one lag-1 price
 * autocorrelation, a fixed hazard-bonus table. A bot that trades exactly ONE
 * family can spend the same tick budget on estimators only that family can use:
 *
 *   Parity (Even/Odd)    2-state parity Markov — the same buffer yields ~5× the
 *                        effective samples per state that the 10-state digit
 *                        matrix does, so the conditional estimate carries a
 *                        far smaller σ; a Wald–Wolfowitz runs test that says
 *                        whether the stream CLUSTERS or ALTERNATES (i.e. which
 *                        side the serial dependence favours — information the
 *                        marginal frequency simply does not contain); lag-2/3
 *                        cycle detection; and a marginal parity-bias test with
 *                        a proper confidence interval.
 *   Barrier (Over/Under) 2-state tail-membership chain plus a 2nd-order tail
 *                        chain, digit-mass drift against the barrier, edge
 *                        fragility (how concentrated the winning mass is), and
 *                        barrier-adjacency pressure (near-miss instability).
 *   Match                Dormancy hazard fitted from the digit's OWN gap
 *                        history (censored, Kaplan–Meier style) and a
 *                        Benjamini–Hochberg FDR correction across all ten
 *                        candidate digits. Taking the argmax of ten noisy
 *                        estimates is biased upward; FDR removes that bias.
 *   Differ               Upper-confidence-bound tail risk (at a 1.09× payout
 *                        the loss side is the only thing that matters), hot-run
 *                        veto, and the mirrored FDR correction.
 *   Rise/Fall            Hurst exponent by rescaled-range analysis, a lag-1..3
 *                        autocorrelation vector (a 2-cycle reads as ρ₁<0, ρ₂>0
 *                        and is invisible to a single lag), tick-magnitude
 *                        asymmetry, and a realised-volatility floor that
 *                        refuses dead chop.
 *
 * Design rules, identical to the quantum layer this sits beside:
 *  - pure, stateless, O(n) functions of the tick buffers, sub-millisecond;
 *  - every returned bonus is BOUNDED and additive — a read never gates by
 *    itself, it re-ranks and re-times;
 *  - the two places a specialist read DOES decide are named explicitly
 *    (`specialistEntryGate`, `specialistSideChoice`) because better timing and
 *    better side selection are exactly what the specialisation is for.
 */

import { normalCdf } from "./quantum-analysis";
import { EVEN_ODD_PAYOUT, RISE_FALL_PAYOUT, MATCH_PAYOUT, DIFF_PAYOUT } from "./payouts";

export type SpecialistFamily = "parity" | "barrier" | "match" | "differ" | "momentum";

/**
 * Map a contract type to its specialist family (used for calibration routing).
 */
export function familyForContract(ct: string): SpecialistFamily {
  if (ct === "DIGITEVEN" || ct === "DIGITODD") return "parity";
  if (ct === "DIGITOVER" || ct === "DIGITUNDER") return "barrier";
  if (ct === "DIGITMATCH") return "match";
  if (ct === "DIGITDIFF") return "differ";
  return "momentum";
}

/**
 * Minimum significance margin above break-even the entry gate accepts.
 *
 * z_be ≥ 0.75 means the estimate clears 1/payout by three-quarters of its own
 * standard error — i.e. every trade the specialist releases is positive
 * expected value AT THE ESTIMATE LEVEL, not merely plausible. On a truly
 * random stream this condition fails ~90% of ticks, which is exactly the
 * behaviour a specialist should show: sit out until the math says yes.
 */
export const MIN_ENTRY_Z_BE = 0.75;

/**
 * The MATCH family needs a larger margin.
 *
 * Selection bias: the match bot's p̂ is the ARGMAX of ten noisy per-digit
 * estimates (the best of ten binomial(≈100, 0.10) estimates), and an argmax
 * is optimistically biased upward by roughly half a σ of the individual
 * estimates — the FDR correction fixes digit RANKING but cannot remove the
 * bias in the winning estimate itself. Requiring z_be ≥ 1.5 (instead of 0.75)
 * absorbs that selection inflation: on a fair stream the gate then releases
 * only a small minority of ticks, while a genuinely hot digit (p ≈ 16% vs
 * an 11.2% hurdle) still clears it comfortably.
 */
export const MATCH_ENTRY_Z_BE = 1.5;

/**
 * Barrier entry margin, scaled by tail size.
 *
 * A 1-digit tail (OVER 8 / UNDER 1, 91.7% break-even) is a RARE-EVENT
 * estimate: far noisier, more biased, and closer to the edge of the
 * distribution than a 5-digit tail, where the 0.75σ margin is well
 * calibrated. The margin therefore grows as the tail shrinks:
 *   tail ≥ 5 digits → 0.75σ,  tail 3 → 1.0σ,  tail 2 → 1.125σ,  tail 1 → 1.25σ.
 * An extreme tail needs to prove its edge harder before a trade is released.
 */
export function barrierEntryMargin(tailSize: number): number {
  if (tailSize >= 5) return MIN_ENTRY_Z_BE;
  return MIN_ENTRY_Z_BE + (5 - tailSize) * 0.125;
}

/**
 * Hysteresis for digit targeting (match / differ bots): a newly selected digit
 * must beat the session's current digit by this many z_be (or z-safety) units
 * before the bot will switch. Prevents scan-to-scan target chasing on noise.
 */
export const DIGIT_SWITCH_MARGIN = 0.5;

/** Break-even win rates p* = 1/payout, per family. */
export const BREAK_EVEN = {
  parity: 1 / EVEN_ODD_PAYOUT,    // 1.95× ⇒ 51.28%
  barrier: null,                  // barrier-dependent — resolved at read time
  match: 1 / MATCH_PAYOUT,        // 8.93× ⇒ 11.20%
  differ: 1 / DIFF_PAYOUT,        // 1.09× ⇒ 91.74%
  momentum: 1 / RISE_FALL_PAYOUT, // 1.92× ⇒ 52.08%
} as const;

export interface SpecialistRead {
  family: SpecialistFamily;
  /** Bounded additive score contribution. Never larger than SPECIALIST_BONUS_CAP. */
  bonus: number;
  /** 0–100 — how much evidence stands behind this read. */
  confidence: number;
  /** The side this read's own evidence favours, when it has an opinion. */
  favoured?: string;
  /** Named metrics for the UI's specialist panel. */
  metrics: Record<string, number>;
  /** Short human-readable diagnostics. */
  signals: string[];
}

/** Hard cap on any single specialist bonus, so the layer can never dominate. */
export const SPECIALIST_BONUS_CAP = 14;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function neutralRead(family: SpecialistFamily, reason: string): SpecialistRead {
  return { family, bonus: 0, confidence: 0, metrics: {}, signals: [reason] };
}

// ── Estimator primitives ──────────────────────────────────────────────────────

/**
 * Exponentially-weighted Bernoulli rate with a proper standard error.
 * n_eff = (1+α)/(1−α); α = 0.97 ⇒ ≈ 65 ticks of memory.
 */
export function ewmaRate(series: number[], prior = 0.5, alpha = 0.97): { p: number; sigma: number; nEff: number } {
  let p = prior;
  for (const x of series) p = alpha * p + (1 - alpha) * x;
  const nEff = (1 + alpha) / (1 - alpha);
  const sigma = Math.sqrt(Math.max(1e-6, (p * (1 - p) * (1 - alpha)) / (1 + alpha)));
  return { p: clamp(p, 1e-4, 1 - 1e-4), sigma, nEff };
}

export interface TwoStateChain {
  /** P(target | previous state = 0), Laplace-smoothed */
  pFrom0: number;
  /** P(target | previous state = 1), Laplace-smoothed */
  pFrom1: number;
  /** Unconditional weighted rate */
  pUncond: number;
  /** Effective sample counts backing each conditional */
  n0: number;
  n1: number;
}

/**
 * Exponentially-decayed 2-state Markov chain over a 0/1 series.
 *
 * This is the specialist's workhorse: collapsing ten digit states into the two
 * states that actually decide the contract multiplies the evidence behind each
 * conditional probability, which is precisely the variance reduction a
 * generalist cannot buy.
 */
export function twoStateChain(states: number[], target: number, alpha = 0.985): TwoStateChain {
  let w00 = 0, w01 = 0, w10 = 0, w11 = 0; // wAB = weight of A → B
  let totalTarget = 0;
  let totalWeight = 0;
  for (let i = 0; i < states.length; i++) {
    const weight = Math.pow(alpha, states.length - 1 - i); // most recent = 1
    if (states[i] === target) {
      totalTarget += weight;
    }
    totalWeight += weight;
    if (i === 0) continue;
    const prev = states[i - 1]!;
    const cur = states[i]!;
    if (prev === 0) { if (cur === target) w01 += weight; else w00 += weight; }
    else            { if (cur === target) w11 += weight; else w10 += weight; }
  }
  const n0 = w00 + w01;
  const n1 = w10 + w11;
  return {
    pFrom0:   (w01 + 1) / (n0 + 2),
    pFrom1:   (w11 + 1) / (n1 + 2),
    pUncond:  totalWeight > 0 ? (totalTarget + 1) / (totalWeight + 2) : 0.5,
    n0,
    n1,
  };
}

/**
 * 2nd-order 2-state chain: P(target | last two states) over the four contexts
 * 00/01/10/11. Falls back to the 1st-order conditional when a context is thin.
 */
export function secondOrderTwoState(
  states: number[],
  target: number,
  alpha = 0.99,
): { p: number; n: number; fallbackP: number } {
  const counts = [0, 0, 0, 0]; // index = prev2 * 2 + prev1
  const hits   = [0, 0, 0, 0];
  for (let i = 2; i < states.length; i++) {
    const weight = Math.pow(alpha, states.length - 1 - i);
    const idx = states[i - 2]! * 2 + states[i - 1]!;
    counts[idx] += weight;
    if (states[i] === target) hits[idx] += weight;
  }
  const last = states[states.length - 1]!;
  const prev = states[states.length - 2]!;
  const idx = prev * 2 + last;
  const n = counts[idx] ?? 0;
  const first = twoStateChain(states, target, alpha);
  const fallbackP = last === 1 ? first.pFrom1 : first.pFrom0;
  // Credibility: shrink toward the 1st-order conditional until the context has
  // ~12 effective observations.
  const w = n / (n + 12);
  const pCtx = (hits[idx]! + 1) / (n + 2);
  return { p: w * pCtx + (1 - w) * fallbackP, n, fallbackP };
}

/** Inverse-variance blend of independent probability estimates. */
export function blendEstimates(est: Array<{ p: number; sigma: number }>): { p: number; sigma: number } {
  const usable = est.filter(e => Number.isFinite(e.p) && Number.isFinite(e.sigma) && e.sigma > 1e-6);
  if (usable.length === 0) return { p: 0.5, sigma: 0.35 };
  let wSum = 0;
  let pSum = 0;
  for (const e of usable) {
    const w = 1 / (e.sigma * e.sigma);
    wSum += w;
    pSum += w * e.p;
  }
  return { p: clamp(pSum / wSum, 1e-4, 1 - 1e-4), sigma: Math.sqrt(1 / wSum) };
}

/**
 * Wald–Wolfowitz runs test on a 0/1 series.
 *
 * z < 0 ⇒ fewer runs than random ⇒ CLUSTERING (streaks persist).
 * z > 0 ⇒ more runs than random ⇒ ALTERNATION (the stream flips).
 * This is the serial-independence test; the marginal frequency is blind to it.
 */
export function waldWolfowitz(series: number[]): { runs: number; expected: number; sd: number; z: number } {
  const n = series.length;
  const neutral = { runs: 0, expected: 0, sd: 0, z: 0 };
  if (n < 20) return neutral;
  let n0 = 0;
  let n1 = 0;
  for (const s of series) { if (s === 0) n0++; else n1++; }
  if (n0 === 0 || n1 === 0) return neutral;
  let runs = 1;
  for (let i = 1; i < n; i++) if (series[i] !== series[i - 1]) runs++;
  const expected = (2 * n0 * n1) / n + 1;
  const variance = (2 * n0 * n1 * (2 * n0 * n1 - n)) / (n * n * (n - 1));
  if (!(variance > 0)) return neutral;
  const sd = Math.sqrt(variance);
  return { runs, expected: round(expected), sd: round(sd, 3), z: round((runs - expected) / sd) };
}

/** Autocorrelation of a 0/1 series at a given lag. */
export function lagAutocorr(series: number[], lag: number): number {
  const n = series.length;
  if (n <= lag + 5) return 0;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) den += (series[i]! - mean) ** 2;
  for (let i = lag; i < n; i++) num += (series[i]! - mean) * (series[i - lag]! - mean);
  if (den < 1e-12) return 0;
  return clamp(num / den, -1, 1);
}

/** Current run length of the value at the end of the series. */
export function tailRunLength(series: number[]): { value: number; length: number } {
  if (series.length === 0) return { value: 0, length: 0 };
  const value = series[series.length - 1]!;
  let length = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== value) break;
    length++;
  }
  return { value, length };
}

/**
 * Censored empirical hazard of a run breaking: for every run length k reached,
 * the fraction of those runs that ended on the next observation
 * (Laplace-smoothed; still-open runs count as reached, not broken).
 */
export function runHazard(against: boolean[]): {
  hazard: Map<number, number>;
  kNow: number;
  baseline: number;
} {
  const reached = new Map<number, number>();
  const broke   = new Map<number, number>();
  let run = 0;
  for (const isAgainst of against) {
    if (isAgainst) {
      run++;
      reached.set(run, (reached.get(run) ?? 0) + 1);
    } else if (run > 0) {
      broke.set(run, (broke.get(run) ?? 0) + 1);
      run = 0;
    }
  }
  const hazard = new Map<number, number>();
  for (const [k, r] of reached) hazard.set(k, ((broke.get(k) ?? 0) + 1) / (r + 2));
  const observed = [...hazard.entries()]
    .filter(([k]) => k >= 1 && (reached.get(k) ?? 0) >= 3)
    .map(([, v]) => v)
    .sort((a, b) => a - b);
  let baseline: number;
  if (observed.length >= 2) {
    const mid = Math.floor(observed.length / 2);
    baseline = observed.length % 2 === 1 ? observed[mid]! : (observed[mid - 1]! + observed[mid]!) / 2;
  } else {
    baseline = hazard.size > 0 ? [...hazard.values()].reduce((a, b) => a + b, 0) / hazard.size : 0.5;
  }
  return { hazard, kNow: run, baseline: baseline > 0 ? baseline : 0.5 };
}

/**
 * Hurst exponent by rescaled-range (R/S) analysis.
 * H > 0.5 ⇒ persistent/trending, H < 0.5 ⇒ anti-persistent/mean-reverting.
 * Returns 0.5 (neutral) when the series is too short to regress.
 */
export function hurstExponent(returns: number[]): number {
  const n = returns.length;
  if (n < 32) return 0.5;
  const logN: number[] = [];
  const logRS: number[] = [];
  for (let size = 8; size <= Math.floor(n / 2); size = Math.floor(size * 1.7)) {
    const segments = Math.floor(n / size);
    if (segments < 1) break;
    let acc = 0;
    let used = 0;
    for (let s = 0; s < segments; s++) {
      const seg = returns.slice(s * size, (s + 1) * size);
      const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
      const sd = Math.sqrt(seg.reduce((a, v) => a + (v - mean) ** 2, 0) / seg.length);
      if (sd < 1e-12) continue;
      let cum = 0;
      let maxCum = -Infinity;
      let minCum = Infinity;
      for (const v of seg) {
        cum += v - mean;
        if (cum > maxCum) maxCum = cum;
        if (cum < minCum) minCum = cum;
      }
      acc += (maxCum - minCum) / sd;
      used++;
    }
    if (used === 0) continue;
    logN.push(Math.log(size));
    logRS.push(Math.log(acc / used));
  }
  if (logN.length < 3) return 0.5;
  const meanX = logN.reduce((a, b) => a + b, 0) / logN.length;
  const meanY = logRS.reduce((a, b) => a + b, 0) / logRS.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < logN.length; i++) {
    num += (logN[i]! - meanX) * (logRS[i]! - meanY);
    den += (logN[i]! - meanX) ** 2;
  }
  if (den < 1e-12) return 0.5;
  return clamp(num / den, 0, 1);
}

/**
 * Benjamini–Hochberg FDR selection.
 *
 * `pValues[i]` tests candidate i. Returns the set of candidates that survive at
 * false-discovery rate `q`. Selecting an extreme of m noisy candidates is
 * biased; BH is the standard correction and costs nothing at decision time.
 */
export function benjaminiHochberg(pValues: number[], q = 0.25): boolean[] {
  const m = pValues.length;
  const passes = new Array<boolean>(m).fill(false);
  if (m === 0) return passes;
  const order = pValues
    .map((p, i) => ({ p: Number.isFinite(p) ? clamp(p, 0, 1) : 1, i }))
    .sort((a, b) => a.p - b.p);
  let cutoff = -1;
  for (let rank = 0; rank < m; rank++) {
    if (order[rank]!.p <= ((rank + 1) / m) * q) cutoff = rank;
  }
  if (cutoff < 0) return passes;
  for (let rank = 0; rank <= cutoff; rank++) passes[order[rank]!.i] = true;
  return passes;
}

// ── Parity specialist (Even / Odd) ────────────────────────────────────────────

/**
 * Even/Odd specialist read.
 *
 * Four independent estimators, blended by inverse variance:
 *  1. 2-state parity Markov conditioned on the last parity (low σ),
 *  2. 2nd-order parity chain conditioned on the last two parities,
 *  3. unconditional EWMA parity rate,
 *  4. the marginal bias of the whole buffer (a slow, very stable estimate).
 * The runs test then says WHICH SIDE the serial dependence favours, and the
 * lag-2 term catches a period-2 flip cycle.
 */
export function parityRead(digits: number[], side: "DIGITEVEN" | "DIGITODD"): SpecialistRead {
  const target = side === "DIGITEVEN" ? 0 : 1;
  const parity = digits.filter(d => d >= 0 && d <= 9).map(d => d % 2);
  if (parity.length < 40) return neutralRead("parity", "Collecting parity samples…");

  const targetSeries = parity.map(p => (p === target ? 1 : 0));

  // 1 + 2 — parity chains.
  const chain1 = twoStateChain(parity, target, 0.985);
  const lastParity = parity[parity.length - 1]!;
  const pCond = lastParity === 1 ? chain1.pFrom1 : chain1.pFrom0;
  const nCond = lastParity === 1 ? chain1.n1 : chain1.n0;
  const sigmaCond = Math.sqrt(Math.max(1e-6, (pCond * (1 - pCond)) / Math.max(4, nCond)));
  const chain2 = secondOrderTwoState(parity, target, 0.99);
  const sigma2 = Math.sqrt(Math.max(1e-6, (chain2.p * (1 - chain2.p)) / Math.max(4, chain2.n)));

  // 3 — EWMA rate.
  const ew = ewmaRate(targetSeries, 0.5, 0.97);

  // 4 — marginal bias over the full buffer (binomial σ).
  const hits = targetSeries.reduce((a, b) => a + b, 0);
  const pMarg = hits / targetSeries.length;
  const sigmaMarg = Math.sqrt(Math.max(1e-6, (pMarg * (1 - pMarg)) / targetSeries.length));

  const blended = blendEstimates([
    { p: pCond, sigma: sigmaCond },
    { p: chain2.p, sigma: sigma2 },
    { p: ew.p, sigma: ew.sigma },
    { p: pMarg, sigma: sigmaMarg },
  ]);

  // Serial dependence: runs test → which side the structure favours.
  const ww = waldWolfowitz(parity);
  const run = tailRunLength(parity);
  let favoured: string | undefined;
  let serialStrength = 0;
  if (Math.abs(ww.z) >= 1.2) {
    serialStrength = clamp(Math.abs(ww.z) / 3, 0, 1);
    if (ww.z < 0) {
      // Clustering — the open run tends to continue.
      favoured = run.value === 0 ? "DIGITEVEN" : "DIGITODD";
    } else {
      // Alternation — the stream flips, so favour the opposite of the last tick.
      favoured = run.value === 0 ? "DIGITODD" : "DIGITEVEN";
    }
  }

  // Period-2 / period-3 cycles.
  const rho2 = lagAutocorr(parity, 2);
  const rho3 = lagAutocorr(parity, 3);
  const parity2Ago = parity[parity.length - 3];
  let cycleBonus = 0;
  if (Math.abs(rho2) >= 0.2 && parity2Ago !== undefined) {
    const agrees = (parity2Ago === target) === (rho2 > 0);
    cycleBonus = agrees ? 3 : -3;
  } else if (Math.abs(rho3) >= 0.25) {
    cycleBonus = rho3 > 0 ? 1.5 : -1.5;
  }

  // Bias term — measured against the BREAK-EVEN rate (1/1.95 = 51.28%), not
  // 50%: a parity edge that only beats fair is still negative EV at the
  // 1.95× payout, so it must not earn a positive bonus. Scaled by the
  // estimate's own significance so noise cannot fake an edge.
  const breakEven = BREAK_EVEN.parity;
  const z = (blended.p - 0.5) / Math.max(blended.sigma, 0.005);
  const zBe = (blended.p - breakEven) / Math.max(blended.sigma, 0.005);
  const biasBonus = clamp(zBe * 3.2, -7, 7);

  // Serial-alignment term: does the side we are scoring match the side the
  // runs structure favours?
  const alignBonus = favoured === undefined
    ? 0
    : (favoured === side ? 5 * serialStrength : -5 * serialStrength);

  const bonus = clamp(biasBonus + alignBonus + cycleBonus, -SPECIALIST_BONUS_CAP, SPECIALIST_BONUS_CAP);
  const confidence = clamp(Math.round(Math.min(100, (Math.abs(zBe) / 2.5) * 55 + Math.min(45, parity.length / 4))), 0, 100);
  // 1 when the serial structure actively favours the OTHER side — this is the
  // only thing the parity entry gate blocks on.
  const alignAgainst = favoured !== undefined && favoured !== side ? 1 : 0;

  const signals: string[] = [];
  signals.push(`p̂ ${(blended.p * 100).toFixed(1)}% (σ ${(blended.sigma * 100).toFixed(1)})`);
  signals.push(`z_be ${(zBe >= 0 ? "+" : "")}${zBe.toFixed(2)} vs be ${(breakEven * 100).toFixed(1)}%`);
  if (favoured) {
    signals.push(`${ww.z < 0 ? "clustering" : "alternating"} → ${favoured === "DIGITEVEN" ? "EVEN" : "ODD"} (z_run ${ww.z.toFixed(2)})`);
  } else {
    signals.push(`serially independent (z_run ${ww.z.toFixed(2)})`);
  }
  if (cycleBonus !== 0) signals.push(`cycle ρ₂ ${rho2.toFixed(2)}`);

  return {
    family: "parity",
    bonus: round(bonus, 1),
    confidence,
    favoured,
    metrics: {
      pHat: round(blended.p, 4),
      sigma: round(blended.sigma, 4),
      z: round(z),
      zBe: round(zBe, 3),
      breakEven: round(breakEven, 4),
      runsZ: ww.z,
      alignAgainst,
      rho2: round(rho2),
      rho3: round(rho3),
      openRun: run.length,
      marginal: round(pMarg, 4),
    },
    signals,
  };
}

// ── Barrier specialist (Over / Under) ─────────────────────────────────────────

export interface BarrierReadOptions {
  side: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
}

/**
 * Over/Under specialist read.
 *
 * Works on the TAIL-MEMBERSHIP series (did this digit satisfy the barrier?)
 * rather than the raw digits: a 2-state chain over that series has ~5× the
 * effective samples per state of the 10-state digit matrix, and the 2nd-order
 * version conditions on the last two outcomes. Adds digit-mass drift against
 * the barrier, edge fragility, and barrier-adjacency pressure.
 */
export function barrierRead(digits: number[], opts: BarrierReadOptions): SpecialistRead {
  const { side, barrier } = opts;
  const clean = digits.filter(d => d >= 0 && d <= 9);
  if (clean.length < 40) return neutralRead("barrier", "Collecting barrier samples…");

  const isOver = side === "DIGITOVER";
  const target = clean.map(d => (isOver ? (d > barrier ? 1 : 0) : (d < barrier ? 1 : 0)));
  const tailDigits = isOver
    ? [barrier + 1, barrier + 2, barrier + 3, barrier + 4, barrier + 5, barrier + 6, barrier + 7, barrier + 8, barrier + 9].filter(d => d <= 9)
    : [0, 1, 2, 3, 4, 5, 6, 7, 8].filter(d => d < barrier);
  const tailCount = Math.max(1, tailDigits.length);

  // 1 — 2-state tail-membership chain, conditioned on the last outcome.
  const chain1 = twoStateChain(target, 1, 0.985);
  const last = target[target.length - 1]!;
  const pCond = last === 1 ? chain1.pFrom1 : chain1.pFrom0;
  const nCond = last === 1 ? chain1.n1 : chain1.n0;
  const sigmaCond = Math.sqrt(Math.max(1e-6, (pCond * (1 - pCond)) / Math.max(4, nCond)));

  // 2 — 2nd-order tail chain.
  const chain2 = secondOrderTwoState(target, 1, 0.99);
  const sigma2 = Math.sqrt(Math.max(1e-6, (chain2.p * (1 - chain2.p)) / Math.max(4, chain2.n)));

  // 3 — EWMA rate + 4 — marginal frequency of the tail set.
  const ew = ewmaRate(target, tailCount / 10, 0.97);
  const tailHits = target.reduce((a, b) => a + b, 0);
  const pMarg = tailHits / target.length;
  const sigmaMarg = Math.sqrt(Math.max(1e-6, (pMarg * (1 - pMarg)) / target.length));

  const blended = blendEstimates([
    { p: pCond, sigma: sigmaCond },
    { p: chain2.p, sigma: sigma2 },
    { p: ew.p, sigma: ew.sigma },
    { p: pMarg, sigma: sigmaMarg },
  ]);

  // Digit-mass drift: is the digit distribution migrating toward the tail?
  const ewMean = (() => {
    let m = 4.5;
    for (const d of clean) m = 0.97 * m + 0.03 * d;
    return m;
  })();
  const half = Math.floor(clean.length / 2);
  const meanOld = clean.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half);
  const meanNew = clean.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, clean.length - half);
  const drift = meanNew - meanOld; // + = digits rising
  const driftAligned = isOver ? drift > 0 : drift < 0;
  const driftBonus = clamp((driftAligned ? 1 : -1) * Math.min(4, Math.abs(drift) * 6), -4, 4);

  // Edge fragility: how concentrated the winning mass is INSIDE the tail.
  // A tail edge carried entirely by one digit is far more brittle than one
  // spread across the tail, and brittleness is not priced into the payout.
  const window = clean.slice(-60);
  const tailFreqs = tailDigits.map(d => window.filter(v => v === d).length);
  const tailTotal = tailFreqs.reduce((a, b) => a + b, 0);
  let fragility = 0;
  if (tailTotal > 0 && tailCount > 1) {
    let h = 0;
    for (const c of tailFreqs) {
      if (c > 0) {
        const p = c / tailTotal;
        h -= p * Math.log2(p);
      }
    }
    fragility = clamp(1 - h / Math.log2(tailCount), 0, 1);
  }
  const fragilityBonus = fragility > 0.45 ? -4 : fragility > 0.3 ? -2 : fragility < 0.12 ? 2 : 0;

  // Barrier-adjacency pressure: mass sitting immediately on the losing side of
  // the barrier makes the edge flip-prone (near misses).
  const adjacent = isOver
    ? window.filter(d => d === barrier || d === barrier - 1).length
    : window.filter(d => d === barrier || d === barrier + 1).length;
  const adjacency = window.length > 0 ? adjacent / window.length : 0;
  const adjacencyBonus = adjacency >= 0.28 ? -4 : adjacency >= 0.2 ? -2 : adjacency <= 0.1 ? 2 : 0;

  const breakEven = 1 / payoutForBarrier(side, barrier);
  const z = (blended.p - breakEven) / Math.max(blended.sigma, 0.005);
  const edgeBonus = clamp(z * 3.0, -8, 8);

  // Tail-size-aware entry margin (rare tails must prove their edge harder)
  // and the market's OWN tail-streak breaking point, so the gate can refuse
  // a losing streak that is not yet at its natural breaking point.
  const requiredZBe = barrierEntryMargin(tailCount);
  const streakAgainst = target.map(t => t === 0);
  const streakHazard = runHazard(streakAgainst);
  const hazardBreakProb = streakHazard.hazard.get(streakHazard.kNow) ?? streakHazard.baseline;
  const hazardRelative = streakHazard.baseline > 1e-9 ? hazardBreakProb / streakHazard.baseline : 1;

  const bonus = clamp(edgeBonus + driftBonus + fragilityBonus + adjacencyBonus, -SPECIALIST_BONUS_CAP, SPECIALIST_BONUS_CAP);
  const confidence = clamp(Math.round(Math.min(100, (Math.abs(z) / 2.5) * 55 + Math.min(45, clean.length / 4))), 0, 100);

  const signals: string[] = [];
  signals.push(`p̂ ${(blended.p * 100).toFixed(1)}% vs be ${(breakEven * 100).toFixed(1)}%`);
  signals.push(`z ${z >= 0 ? "+" : ""}${z.toFixed(2)}`);
  signals.push(`mass drift ${drift >= 0 ? "+" : ""}${drift.toFixed(2)} ${driftAligned ? "↦ tail" : "↤ away"}`);
  if (fragilityBonus !== 0) signals.push(`fragility ${(fragility * 100).toFixed(0)}%`);
  if (adjacencyBonus !== 0) signals.push(`adjacency ${(adjacency * 100).toFixed(0)}%`);

  return {
    family: "barrier",
    bonus: round(bonus, 1),
    confidence,
    favoured: side,
    metrics: {
      pHat: round(blended.p, 4),
      sigma: round(blended.sigma, 4),
      z: round(z),
      zBe: round(z, 3),
      breakEven: round(breakEven, 4),
      requiredZBe: round(requiredZBe, 3),
      drift: round(drift, 3),
      ewMean: round(ewMean, 3),
      fragility: round(fragility, 3),
      adjacency: round(adjacency, 3),
      hazardK: streakHazard.kNow,
      hazardRelative: round(hazardRelative, 3),
    },
    signals,
  };
}

/** Barrier payout from the canonical schedule (kept local to avoid a cycle). */
export function payoutForBarrier(side: "DIGITOVER" | "DIGITUNDER", barrier: number): number {
  const OVER: Record<number, number> = { 0: 1.09, 1: 1.23, 2: 1.40, 3: 1.63, 4: 1.95, 5: 2.43, 6: 3.21, 7: 4.72, 8: 8.93 };
  const UNDER: Record<number, number> = { 1: 8.93, 2: 4.72, 3: 3.21, 4: 2.43, 5: 1.95, 6: 1.63, 7: 1.40, 8: 1.23, 9: 1.09 };
  const table = side === "DIGITOVER" ? OVER : UNDER;
  return table[barrier] ?? (side === "DIGITOVER" ? OVER[4]! : UNDER[5]!);
}

// ── Digit-candidate statistics (Match / Differ) ───────────────────────────────

export interface DigitCandidate {
  digit: number;
  /** EWMA occurrence rate */
  p: number;
  /** Standard error of that rate */
  sigma: number;
  /** One-sided upper confidence bound (p + 1.645σ) */
  upper: number;
  /** Ticks since this digit last appeared */
  gap: number;
  /** This digit's own break-hazard at the current gap, relative to its baseline */
  hazardRelative: number;
  /** Occurrences inside the last 6 ticks (hot-run detector) */
  recent6: number;
  /** Survives the FDR correction in the direction this bot cares about */
  significant: boolean;
}

/**
 * Per-digit statistics shared by the Match and Differ specialists.
 *
 * `direction = "hot"` tests "this digit appears MORE than its fair 10%",
 * `direction = "cold"` tests "LESS than fair". Both run the Benjamini–Hochberg
 * correction across all ten candidates, because choosing an extreme of ten
 * noisy estimates is biased in exactly the direction each bot profits from.
 */
export function digitCandidates(digits: number[], direction: "hot" | "cold"): DigitCandidate[] {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  const out: DigitCandidate[] = [];
  const pValues: number[] = [];

  const lastDigit = clean[clean.length - 1];
  const lastTwoDigit = clean[clean.length - 2];

  // Transition-context counts, computed once and reused by all ten
  // candidates:
  //   rowOut[a] / rowHit[a,d]  — how often a → d transitioned (1st order)
  //   ctx2[(a,b)]              — how often the (a,b) pair was followed by d
  const rowOut = new Array<number>(10).fill(0);
  const rowHit = new Array<number>(100).fill(0);
  const ctx2 = new Map<number, { total: number; hits: number[] }>();
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1]!;
    const b = clean[i]!;
    rowOut[a]! += 1;
    rowHit[a * 10 + b]! += 1;
  }
  for (let i = 2; i < clean.length; i++) {
    const a = clean[i - 2]!;
    const b = clean[i - 1]!;
    const c = clean[i]!;
    const key = a * 10 + b;
    let entry = ctx2.get(key);
    if (!entry) { entry = { total: 0, hits: new Array(10).fill(0) }; ctx2.set(key, entry); }
    entry.total++;
    entry.hits[c]! += 1;
  }

  for (let digit = 0; digit < 10; digit++) {
    const series = clean.map(d => (d === digit ? 1 : 0));
    const ew = series.length > 0 ? ewmaRate(series, 0.1, 0.97) : { p: 0.1, sigma: 0.3, nEff: 0 };
    const hits = series.reduce((a, b) => a + b, 0);
    const pMarg = series.length > 0 ? hits / series.length : 0.1;
    const sigmaMarg = Math.sqrt(Math.max(1e-6, (pMarg * (1 - pMarg)) / Math.max(1, series.length)));

    // ── Conditional context estimators ─────────────────────────────────────
    // P(digit | last) and P(digit | last two) from THIS buffer's own
    // transition structure, Laplace-smoothed, each carrying its own binomial
    // σ from the context sample size. These are the strongest per-digit
    // estimators available: the same 10-state context the FAB's Markov uses,
    // now applied to digit SELECTION (which the marginal-frequency picker
    // ignores). Thin contexts drop out automatically via their large σ.
    const estimates: Array<{ p: number; sigma: number }> = [
      { p: ew.p, sigma: ew.sigma },
      { p: pMarg, sigma: sigmaMarg },
    ];
    if (lastDigit !== undefined) {
      const rowTotal = rowOut[lastDigit]!;
      if (rowTotal >= 6) {
        const rowHitCount = rowHit[lastDigit * 10 + digit] ?? 0;
        const p1 = (rowHitCount + 1) / (rowTotal + 10);
        estimates.push({ p: p1, sigma: Math.sqrt(Math.max(1e-6, (p1 * (1 - p1)) / (rowTotal + 10))) });
      }
      if (lastTwoDigit !== undefined) {
        const ctx = ctx2.get(lastTwoDigit * 10 + lastDigit);
        if (ctx && ctx.total >= 4) {
          const p2 = (ctx.hits[digit]! + 1) / (ctx.total + 10);
          estimates.push({ p: p2, sigma: Math.sqrt(Math.max(1e-6, (p2 * (1 - p2)) / (ctx.total + 10))) });
        }
      }
    }
    const blended = blendEstimates(estimates);

    let gap = clean.length;
    for (let i = clean.length - 1; i >= 0; i--) {
      if (clean[i] === digit) { gap = clean.length - 1 - i; break; }
    }

    // This digit's own dormancy hazard: treat "digit appeared" as the event and
    // measure how often a gap of length k ended at k+1 in this very buffer.
    const against: boolean[] = [];
    for (let i = clean.length - 1; i >= 0 && against.length < 200; i--) against.push(clean[i] !== digit);
    against.reverse();
    const rh = runHazard(against);
    const breakProb = rh.hazard.get(rh.kNow) ?? rh.baseline;
    const hazardRelative = rh.baseline > 1e-9 ? breakProb / rh.baseline : 1;

    const recent6 = clean.slice(-6).filter(d => d === digit).length;
    const z = (blended.p - 0.1) / Math.max(blended.sigma, 0.004);
    // One-sided p-value in the direction this bot profits from.
    const pValue = direction === "hot" ? 1 - normalCdf(z) : normalCdf(z);

    pValues.push(pValue);
    out.push({
      digit,
      p: blended.p,
      sigma: blended.sigma,
      upper: clamp(blended.p + 1.645 * blended.sigma, 0, 1),
      gap,
      hazardRelative: round(hazardRelative, 3),
      recent6,
      significant: false,
    });
  }

  const passes = benjaminiHochberg(pValues, 0.25);
  for (let i = 0; i < out.length; i++) out[i]!.significant = passes[i]!;
  return out;
}

// ── Match specialist ──────────────────────────────────────────────────────────

export interface MatchRead {
  /** The digit the specialist would trade (locked digit when supplied). */
  barrier: number;
  read: SpecialistRead;
  candidates: DigitCandidate[];
}

/**
 * Matches specialist read (8.93× payout ⇒ break-even 11.2%).
 *
 * Selection is FDR-gated rather than argmax-of-ten, and the dormancy hazard
 * comes from the chosen digit's OWN gap history rather than a fixed gap table.
 */
export function matchRead(digits: number[], lockedBarrier?: number): MatchRead {
  const candidates = digitCandidates(digits, "hot");
  const clean = digits.filter(d => d >= 0 && d <= 9);
  if (clean.length < 40) {
    return {
      barrier: lockedBarrier ?? 5,
      read: neutralRead("match", "Collecting digit samples…"),
      candidates,
    };
  }

  // Rank significant digits by BREAK-EVEN significance (z vs 11.2%) ×
  // dormancy-hazard support. Ranking on z-vs-fair (10%) was a subtle bug: a
  // digit at 12% looked "2σ hot" while still being worth less than the
  // 8.93× payout demands — the digit the bot should trust is the one whose
  // estimate clears the HURDLE by the widest margin, not the one that beats
  // the population average by the widest margin.
  const breakEven = BREAK_EVEN.match;
  const eligible = candidates.filter(c => c.significant);
  const pool = eligible.length > 0 ? eligible : candidates;
  const scored = pool.map(c => {
    const zBe = (c.p - breakEven) / Math.max(c.sigma, 0.004);
    // Dormancy support: a gap at/after this digit's own typical breaking point
    // is the overshoot entry; a digit that just appeared is the worst entry.
    const dormancy = c.hazardRelative >= 1.25 ? 1.2
      : c.hazardRelative >= 1.0 ? 0.7
      : c.hazardRelative >= 0.8 ? 0
      : -0.8;
    const gapShape = c.gap >= 4 && c.gap <= 12 ? 0.6 : c.gap < 3 ? -0.9 : 0;
    return { candidate: c, zBe, score: zBe + dormancy + gapShape };
  }).sort((a, b) => b.score - a.score);

  const chosen = lockedBarrier !== undefined
    ? candidates[lockedBarrier]!
    : (scored[0]?.candidate ?? candidates[5]!);

  const zChosen = (chosen.p - 0.1) / Math.max(chosen.sigma, 0.004);
  const zVsBreakEven = (chosen.p - breakEven) / Math.max(chosen.sigma, 0.004);

  // The primary bonus term is the break-even significance — the number that
  // decides whether this trade is +EV. (Previously z-vs-fair drove the bonus
  // while the break-even z was computed and discarded.)
  let bonus = 0;
  bonus += clamp(zVsBreakEven * 3.0, -8, 8);
  bonus += chosen.hazardRelative >= 1.25 ? 4 : chosen.hazardRelative >= 1.0 ? 2 : chosen.hazardRelative < 0.8 ? -4 : 0;
  bonus += chosen.gap >= 4 && chosen.gap <= 12 ? 3 : chosen.gap < 3 ? -5 : 0;
  if (lockedBarrier === undefined && eligible.length === 0) bonus -= 4; // no digit survives FDR

  bonus = clamp(bonus, -SPECIALIST_BONUS_CAP, SPECIALIST_BONUS_CAP);
  const confidence = clamp(Math.round(Math.min(100, (Math.max(0, zVsBreakEven) / 3) * 60 + (eligible.length > 0 ? 25 : 0) + Math.min(15, clean.length / 12))), 0, 100);

  const signals: string[] = [];
  signals.push(`digit ${chosen.digit}: p̂ ${(chosen.p * 100).toFixed(1)}% · be ${(breakEven * 100).toFixed(1)}%`);
  signals.push(`z_be ${zVsBreakEven >= 0 ? "+" : ""}${zVsBreakEven.toFixed(2)}${zVsBreakEven < MATCH_ENTRY_Z_BE ? " — below entry margin" : ""}`);
  signals.push(eligible.length > 0 ? `${eligible.length}/10 digits pass FDR` : "no digit passes FDR — low conviction");
  signals.push(`gap ${chosen.gap}t · hazard ×${chosen.hazardRelative.toFixed(2)}`);

  return {
    barrier: chosen.digit,
    read: {
      family: "match",
      bonus: round(bonus, 1),
      confidence,
      favoured: `DIGITMATCH ${chosen.digit}`,
      metrics: {
        pHat: round(chosen.p, 4),
        sigma: round(chosen.sigma, 4),
        z: round(zChosen),
        zVsBreakEven: round(zVsBreakEven, 3),
        zBe: round(zVsBreakEven, 3),
        breakEven: round(breakEven, 4),
        gap: chosen.gap,
        hazardRelative: chosen.hazardRelative,
        significantDigits: eligible.length,
      },
      signals,
    },
    candidates,
  };
}

// ── Differ specialist ─────────────────────────────────────────────────────────

export interface DifferRead {
  barrier: number;
  read: SpecialistRead;
  candidates: DigitCandidate[];
}

/**
 * Differs specialist read (1.09× payout ⇒ break-even 91.7%).
 *
 * At this payout the ONLY thing that matters is the loss side, so the
 * specialist works with the upper confidence bound of the target digit's
 * appearance rate: the trade is taken on the digit whose WORST plausible rate
 * is still cheapest. Hot runs are vetoed outright — a digit repeating inside a
 * 6-tick window is the single most common way a Differ loses.
 */
export function differRead(digits: number[], lockedBarrier?: number): DifferRead {
  const candidates = digitCandidates(digits, "cold");
  const clean = digits.filter(d => d >= 0 && d <= 9);
  if (clean.length < 40) {
    return {
      barrier: lockedBarrier ?? 5,
      read: neutralRead("differ", "Collecting digit samples…"),
      candidates,
    };
  }

  const breakEven = 1 / 1.09; // 0.9174

  // Veto digits showing a hot run, then rank the survivors by upper bound.
  const safe = candidates.filter(c => c.recent6 < 3);
  const pool = safe.length > 0 ? safe : candidates;
  const eligible = pool.filter(c => c.significant);
  const ranked = (eligible.length > 0 ? eligible : pool)
    .slice()
    .sort((a, b) => a.upper - b.upper);

  const chosen = lockedBarrier !== undefined ? candidates[lockedBarrier]! : (ranked[0] ?? candidates[5]!);

  const worstCaseWin = 1 - chosen.upper;
  const zSafety = (worstCaseWin - breakEven) / Math.max(chosen.sigma, 0.004);

  let bonus = 0;
  bonus += clamp(zSafety * 3.0, -8, 8);
  bonus += chosen.recent6 === 0 ? 3 : chosen.recent6 === 1 ? 1 : chosen.recent6 >= 3 ? -6 : -2;
  bonus += chosen.gap <= 1 ? -4 : chosen.gap >= 8 ? 3 : 0;
  if (lockedBarrier === undefined && eligible.length === 0) bonus -= 3;

  bonus = clamp(bonus, -SPECIALIST_BONUS_CAP, SPECIALIST_BONUS_CAP);
  const confidence = clamp(Math.round(Math.min(100, (Math.max(0, zSafety) / 3) * 60 + (eligible.length > 0 ? 20 : 0) + Math.min(20, clean.length / 10))), 0, 100);

  const signals: string[] = [];
  signals.push(`digit ${chosen.digit}: worst-case win ${(worstCaseWin * 100).toFixed(1)}% vs be ${(breakEven * 100).toFixed(1)}%`);
  signals.push(`p̂ ${(chosen.p * 100).toFixed(1)}% · UB ${(chosen.upper * 100).toFixed(1)}%`);
  signals.push(chosen.recent6 >= 3 ? `⚠ hot run (${chosen.recent6}/6t) — vetoed` : `last seen ${chosen.gap}t ago`);
  signals.push(eligible.length > 0 ? `${eligible.length}/10 digits pass cold FDR` : "no cold-significant digit");

  return {
    barrier: chosen.digit,
    read: {
      family: "differ",
      bonus: round(bonus, 1),
      confidence,
      favoured: `DIGITDIFF ${chosen.digit}`,
      metrics: {
        pHat: round(chosen.p, 4),
        upper: round(chosen.upper, 4),
        worstCaseWin: round(worstCaseWin, 4),
        breakEven: round(breakEven, 4),
        zSafety: round(zSafety),
        gap: chosen.gap,
        recent6: chosen.recent6,
        significantDigits: eligible.length,
      },
      signals,
    },
    candidates,
  };
}

// ── Momentum specialist (Rise / Fall) ─────────────────────────────────────────

/**
 * Rise/Fall specialist read.
 *
 * Hurst (R/S) separates a trending stream from a mean-reverting one — the
 * single most important question for a 1-tick direction contract, and one a
 * lone lag-1 autocorrelation answers badly. The lag vector then exposes a
 * 2-cycle (ρ₁ < 0 with ρ₂ > 0) that a single lag reads as plain noise, and the
 * realised-volatility floor refuses the dead-chop regime where a 1-tick
 * direction bet is a coin flip with a fee.
 */
export function momentumRead(prices: number[], side: "CALL" | "PUT"): SpecialistRead {
  if (prices.length < 30) return neutralRead("momentum", "Collecting price samples…");

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) returns.push(prices[i]! - prices[i - 1]!);
  const recent = returns.slice(-80);
  if (recent.length < 25) return neutralRead("momentum", "Collecting price samples…");

  const dirSeries = recent.map(r => (r > 0 ? 1 : 0));
  const target = side === "CALL" ? 1 : 0;

  // 1 — Hurst exponent by R/S analysis.
  const hurst = hurstExponent(recent);
  const trending = hurst > 0.55;
  const meanReverting = hurst < 0.45;

  // 2 — autocorrelation vector.
  const rho1 = lagAutocorr(dirSeries, 1);
  const rho2 = lagAutocorr(dirSeries, 2);
  const rho3 = lagAutocorr(dirSeries, 3);
  const twoCycle = rho1 < -0.2 && rho2 > 0.15;

  // 3 — tick-magnitude asymmetry (drift bias in price units, not just counts).
  const ups = recent.filter(r => r > 0);
  const downs = recent.filter(r => r < 0);
  const meanUp = ups.length > 0 ? ups.reduce((a, b) => a + b, 0) / ups.length : 0;
  const meanDown = downs.length > 0 ? Math.abs(downs.reduce((a, b) => a + b, 0) / downs.length) : 0;
  const asymmetry = meanUp + meanDown > 1e-12 ? (meanUp - meanDown) / (meanUp + meanDown) : 0;

  // 4 — realised volatility regime.
  const meanAbs = recent.reduce((a, b) => a + Math.abs(b), 0) / recent.length;
  const sd = Math.sqrt(recent.reduce((a, b) => a + (b - (recent.reduce((x, y) => x + y, 0) / recent.length)) ** 2, 0) / recent.length);
  const volRatio = meanAbs > 1e-12 ? sd / meanAbs : 0;
  const flatTicks = recent.filter(r => Math.abs(r) < 1e-12).length / recent.length;
  const deadChop = flatTicks > 0.35 || volRatio < 0.75;

  // 5 — conditional chains on direction.
  const chain1 = twoStateChain(dirSeries, target, 0.98);
  const lastDir = dirSeries[dirSeries.length - 1]!;
  const pCond = lastDir === 1 ? chain1.pFrom1 : chain1.pFrom0;
  const nCond = lastDir === 1 ? chain1.n1 : chain1.n0;
  const sigmaCond = Math.sqrt(Math.max(1e-6, (pCond * (1 - pCond)) / Math.max(4, nCond)));
  const chain2 = secondOrderTwoState(dirSeries, target, 0.985);
  const sigma2 = Math.sqrt(Math.max(1e-6, (chain2.p * (1 - chain2.p)) / Math.max(4, chain2.n)));
  const ew = ewmaRate(dirSeries.map(d => (d === target ? 1 : 0)), 0.5, 0.96);
  const blended = blendEstimates([
    { p: pCond, sigma: sigmaCond },
    { p: chain2.p, sigma: sigma2 },
    { p: ew.p, sigma: ew.sigma },
  ]);

  const lastReturn = recent[recent.length - 1]!;
  const alignedWithTrend = side === "CALL" ? lastReturn > 0 : lastReturn < 0;

  // Fair baseline accounting for flat ticks: a flat tick LOSES for both
  // Rise and Fall, so the fair split of up vs down is over the non-flat mass —
  // (1 − P(flat))/2, not 0.5. Measuring z against 0.5 on a stream with flat
  // ticks systematically overstates the direction edge.
  const flatRate = flatTicks;
  const fairBaseline = (1 - flatRate) / 2;
  const breakEven = BREAK_EVEN.momentum;
  const z = (blended.p - fairBaseline) / Math.max(blended.sigma, 0.005);
  const zBe = (blended.p - breakEven) / Math.max(blended.sigma, 0.005);

  // Primary bonus term: significance vs the 1.92× break-even (52.08%) — the
  // 50% fair rate is NOT where the money changes hands.
  let bonus = 0;
  bonus += clamp(zBe * 3.0, -7, 7);

  // Regime alignment: in a trending stream, trade WITH the last move; in a
  // mean-reverting stream, fade it — but only once the move is extended.
  if (trending) {
    bonus += alignedWithTrend ? 4 : -4;
  } else if (meanReverting) {
    const run = tailRunLength(dirSeries);
    const extended = run.length >= 2;
    bonus += (!alignedWithTrend && extended) ? 4 : (alignedWithTrend ? -3 : 0);
  }

  // 2-cycle: the stream flips every other tick.
  if (twoCycle) {
    const parity2Ago = dirSeries[dirSeries.length - 3];
    const expects = parity2Ago === target;
    bonus += expects ? 3 : -3;
  }

  // Magnitude asymmetry is a slow drift bias.
  bonus += clamp(asymmetry * 6, -3, 3) * (side === "CALL" ? 1 : -1);

  // Dead chop: the specialist's explicit refusal regime.
  if (deadChop) bonus -= 6;

  bonus = clamp(bonus, -SPECIALIST_BONUS_CAP, SPECIALIST_BONUS_CAP);
  const confidence = clamp(Math.round(Math.min(100,
    Math.abs(hurst - 0.5) * 220 + (Math.abs(zBe) / 2.5) * 35 + (deadChop ? -30 : 0),
  )), 0, 100);

  const signals: string[] = [];
  signals.push(`H ${hurst.toFixed(2)} ${trending ? "trending" : meanReverting ? "mean-reverting" : "random-walk"}`);
  signals.push(`ρ₁ ${rho1.toFixed(2)} · ρ₂ ${rho2.toFixed(2)}${twoCycle ? " · 2-cycle" : ""}`);
  signals.push(`p̂ ${(blended.p * 100).toFixed(1)}% · be ${(breakEven * 100).toFixed(1)}%`);
  signals.push(`z_be ${zBe >= 0 ? "+" : ""}${zBe.toFixed(2)} (fair ${(fairBaseline * 100).toFixed(1)}%${flatRate > 0.05 ? `, flats ${(flatRate * 100).toFixed(0)}%` : ""})`);
  signals.push(`asym ${(asymmetry * 100).toFixed(0)}%${deadChop ? " · dead chop" : ""}`);

  return {
    family: "momentum",
    bonus: round(bonus, 1),
    confidence,
    favoured: trending
      ? (lastReturn > 0 ? "CALL" : "PUT")
      : meanReverting
        ? (lastReturn > 0 ? "PUT" : "CALL")
        : undefined,
    metrics: {
      hurst: round(hurst, 3),
      rho1: round(rho1),
      rho2: round(rho2),
      rho3: round(rho3),
      pHat: round(blended.p, 4),
      sigma: round(blended.sigma, 4),
      z: round(z),
      zBe: round(zBe, 3),
      breakEven: round(breakEven, 4),
      fairBaseline: round(fairBaseline, 4),
      asymmetry: round(asymmetry, 3),
      volRatio: round(volRatio, 3),
      flatTicks: round(flatTicks, 3),
    },
    signals,
  };
}

// ── Decision helpers (the two places a specialist read decides) ───────────────

export interface EntryVerdict {
  pass: boolean;
  reason: string;
}

/**
 * Specialist entry gate — better TIMING, and the EV floor.
 *
 * Layered on top of the Quantum FAB's green-light check, never replacing it.
 * Every family now enforces TWO things:
 *
 *  1. THE BREAK-EVEN MARGIN (v2): z_be = (p̂ − 1/payout)/σ must clear
 *     MIN_ENTRY_Z_BE (0.75). The estimate has to be positive expected value
 *     by a margin in its own standard errors — this is what makes every
 *     released trade statistical, not hopeful. A neutral read (too few
 *     samples) carries z_be = 0 and is blocked: no evidence, no trade.
 *
 *  2. The family's own timing condition, which only that family's estimators
 *     can justify:
 *  - parity:   the runs structure must not be actively favouring the other side;
 *  - barrier:  the conditional tail probability must clear break-even on the
 *              current tick (implied by the margin, kept for the reason text);
 *  - match:    the chosen digit must be at/after its own dormancy breaking point;
 *  - differ:   the chosen digit must not be in a hot run, and its 1.645σ
 *              worst-case win rate must clear the 91.7% hurdle;
 *  - momentum: the regime must not be dead chop.
 */
export function specialistEntryGate(read: SpecialistRead): EntryVerdict {
  const m = read.metrics;
  switch (read.family) {
    case "parity": {
      const zBe = m["zBe"] ?? 0;
      if (zBe < MIN_ENTRY_Z_BE) {
        return { pass: false, reason: `no positive-EV margin (z_be ${zBe.toFixed(2)} < ${MIN_ENTRY_Z_BE})` };
      }
      const zRun = m["runsZ"] ?? 0;
      const against = m["alignAgainst"] ?? 0;
      // Only block when the serial evidence is significant AND points the other way.
      if (against === 1 && Math.abs(zRun) >= 1.96) {
        return { pass: false, reason: `runs structure favours the other side (z_run ${zRun.toFixed(2)})` };
      }
      return { pass: true, reason: "parity edge above break-even, structure not contradicted" };
    }
    case "barrier": {
      const p = m["pHat"] ?? 0;
      const be = m["breakEven"] ?? 0.5;
      const zBe = m["zBe"] ?? 0;
      if (p <= be) return { pass: false, reason: `conditional p̂ ${(p * 100).toFixed(1)}% ≤ break-even ${(be * 100).toFixed(1)}%` };
      // Tail-size-aware margin: a 1-digit tail must clear break-even harder
      // than a 5-digit tail (rare-event estimates are noisier and more biased).
      const zBeMin = m["requiredZBe"] ?? MIN_ENTRY_Z_BE;
      if (zBe < zBeMin) {
        return { pass: false, reason: `edge margin thin (z_be ${zBe.toFixed(2)} < ${zBeMin})` };
      }
      // Don't catch a falling knife: a losing streak that is at least 4 ticks
      // long AND breaking less often than this market's own baseline is not
      // at its breaking point yet.
      const k = m["hazardK"] ?? 0;
      const hz = m["hazardRelative"] ?? 1;
      if (k >= 4 && hz < 0.7) {
        return { pass: false, reason: `tail streak ${k}t unusually persistent (hazard ×${hz.toFixed(2)}) — not at breaking point` };
      }
      return { pass: true, reason: "tail probability above break-even with margin" };
    }
    case "match": {
      const zBe = m["zBe"] ?? 0;
      // Selection-bias-corrected margin: the match p̂ is an argmax of ten
      // estimates, so it needs a larger clearance to be trusted.
      if (zBe < MATCH_ENTRY_Z_BE) {
        return { pass: false, reason: `p̂ below break-even by only ${zBe.toFixed(2)}σ (needs ${MATCH_ENTRY_Z_BE}) — selection bias` };
      }
      const hazard = m["hazardRelative"] ?? 1;
      const gap = m["gap"] ?? 0;
      if (gap < 3) return { pass: false, reason: `digit ${gap}t dormant — too soon` };
      if (hazard < 0.8) return { pass: false, reason: `dormancy hazard ×${hazard.toFixed(2)} below baseline` };
      return { pass: true, reason: "dormancy at breaking point, p̂ above break-even" };
    }
    case "differ": {
      const recent = m["recent6"] ?? 0;
      if (recent >= 3) return { pass: false, reason: `target digit hot (${recent}/6t)` };
      const worst = m["worstCaseWin"] ?? 0;
      const be = m["breakEven"] ?? 0.917;
      if (worst < be) return { pass: false, reason: `worst-case win ${(worst * 100).toFixed(1)}% < break-even ${(be * 100).toFixed(1)}%` };
      return { pass: true, reason: "loss-side risk inside tolerance" };
    }
    case "momentum": {
      const zBe = m["zBe"] ?? 0;
      if (zBe < MIN_ENTRY_Z_BE) {
        return { pass: false, reason: `no positive-EV margin (z_be ${zBe.toFixed(2)} < ${MIN_ENTRY_Z_BE})` };
      }
      const flat = m["flatTicks"] ?? 0;
      const vol = m["volRatio"] ?? 1;
      if (flat > 0.35 || vol < 0.75) return { pass: false, reason: "dead chop — direction is a coin flip" };
      return { pass: true, reason: "direction edge above break-even, regime tradable" };
    }
    default:
      return { pass: true, reason: "no specialist gate" };
  }
}

export interface SideVerdict {
  side: string;
  margin: number;
  reason: string;
}

/**
 * Specialist side choice — better EXECUTION.
 *
 * When both sides of a family are armed (OVER and UNDER, or RISE and FALL) the
 * specialist arbitrates between them and applies HYSTERESIS: switching sides
 * costs a margin, so the bot does not flip-flop between two near-equal setups
 * on consecutive ticks. `currentSide` is the side the session last traded.
 */
export function specialistSideChoice(
  reads: Array<{ side: string; read: SpecialistRead }>,
  currentSide?: string,
  switchMargin = 6,
): SideVerdict | null {
  if (reads.length === 0) return null;
  if (reads.length === 1) {
    return { side: reads[0]!.side, margin: 0, reason: "single side armed" };
  }
  const sorted = reads.slice().sort((a, b) => b.read.bonus - a.read.bonus);
  const best = sorted[0]!;
  const runnerUp = sorted[1]!;
  const margin = best.read.bonus - runnerUp.read.bonus;
  if (currentSide && currentSide !== best.side && margin < switchMargin) {
    const held = reads.find(r => r.side === currentSide);
    if (held) {
      return {
        side: currentSide,
        margin: round(margin, 1),
        reason: `hysteresis — ${best.side} leads by only ${margin.toFixed(1)}`,
      };
    }
  }
  return { side: best.side, margin: round(margin, 1), reason: `${best.side} leads by ${margin.toFixed(1)}` };
}
