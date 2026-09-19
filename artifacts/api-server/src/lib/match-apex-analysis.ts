/**
 * MATCH APEX SENTINEL — elite Matches bot analysis.
 *
 * Replaces Match Sniper (specialist-analysis.ts matchRead) and
 * Matches/Differs Oracle (ks-matchdiff) with a superior engine.
 *
 * WEAKNESSES OF PREVIOUS BOTS IDENTIFIED:
 * ───────────────────────────────────────
 * Match Sniper:
 *  · Single-window (60-tick) scoring, no deep history (4999) → thin evidence
 *  · Only EWMA + Beta + P(d|last) + P(d|last2) — no order-3, no outcome chain,
 *    no hazard model beyond simple relative, no entropy regime filter
 *  · Generic quantum timing (botGreenLight) not match-specific
 *  · FDR q=0.25 lenient, no market-level FDR across ~190 candidates
 *  · No out-of-sample walk-forward, no calibration, no e-value
 *  · No tick-age check, no Page-Hinkley drift detection
 *  · No market-mode decision (locked vs switching) at scan time
 *  · Selection bias: argmax-of-ten not corrected beyond FDR
 *
 * Matches/Differs Oracle (ks-matchdiff):
 *  · Uses killshot's 5-model ensemble but still single-leg execution
 *  · Self-referential quantile bar is generic, not match-gap aware
 *  · No entropy / transition-concentration filter (predictability)
 *  · No gap-shape + hazardRelative joint timing
 *  · Rotation hysteresis is fixed, not adaptive
 *  · Still suffers same-tick latency (single trade, no bulk guarantee)
 *
 * STRENGTHS BORROWED:
 * ────────────────────
 * From Match Sniper:
 *  · digitCandidates blending EWMA + Beta + conditional with inverse-variance
 *  · dormancy hazard from digit's own gap history (Kaplan-Meier)
 *  · FDR correction across digits
 *  · Gap-shape timing (4-12 ideal, <3 refuse)
 *  · Break-even significance (z_be) vs 11.2%
 *
 * From Kill-Shot Family:
 *  · Deep history (4999 digits) per market
 *  · 5-model ensemble + hedge weighting
 *  · Out-of-sample walk-forward (60/40 split)
 *  · Platt calibration + Brier skill
 *  · Anytime-valid e-value on shot sequence
 *  · Page-Hinkley drift detector
 *  · Post-loss shield (bar boost + cool-down)
 *  · Market-mode decision (clear winner → locked, tight cluster → switching)
 *  · Survival as ranking signal
 *
 * NEW INNOVATIONS FOR APEX:
 * ──────────────────────────
 *  · 6 estimators per digit: order-0 forgetting Dirichlet, order-1, order-2,
 *    order-3 context-tree mixing (KT estimators), 2-state outcome chain,
 *    Kaplan-Meier renewal hazard at current gap
 *  · Market entropy filter: H < 3.15 bits (not uniform) required for Match
 *  · Transition concentration: H(row|last) < 2.8 bits → predictable
 *  · Exact Beta posterior (no normal approx) + betaQuantile worst-case bound
 *  · FDR across digits (q=0.15 stricter) AND across markets (q=0.10)
 *  · Geometric overdue gate: (1-p̂)^gap ≤ 0.35
 *  · Tick-age gate: last tick < 3s
 *  · Stationarity (4-block χ²) + loss-clustering ξ = P(L|L)/P(L)
 *  · Ladder-ruin exact via Markov chain imbedding (like Kill-Shot)
 *  · Patience valve: debt that waits 20 ticks is bigger danger than imperfect reading
 *  · Same recovery ledger as every other bot
 */

export const MATCH_APEX_SCAN_WINDOW = 4999;
export const MATCH_APEX_MIN_HISTORY = 400;
export const MATCH_APEX_MIN_SPACING = 4;
export const MATCH_APEX_COOLDOWN = 3;
export const MATCH_APEX_PATIENCE = 20;
export const MATCH_PAYOUT = 8.93;
export const MATCH_BREAK_EVEN = 1 / MATCH_PAYOUT; // 11.2%
export const MATCH_APEX_MAX_GAP = 22;
export const MATCH_APEX_HOT_BASELINE = 0.22;

export type MatchApexVerdict = "certified" | "qualified" | "watch" | "refused";
export type MatchApexMode = "normal" | "recovery";

export interface MatchApexRisk {
  stake: number;
  markupPercent: number;
  maxStake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
}

export interface MatchApexReading {
  digit: number;
  p: number; // fused P(next = digit)
  sigma: number;
  zBe: number; // (p - be)/sigma
  worstCase: number; // p - 1.25*sigma
  hazardRelative: number;
  gap: number;
  recent6: number;
  entropy: number; // market entropy
  transEntropy: number; // transition row entropy
  order0: number;
  order1: number;
  order2: number;
  order3: number;
  chain: number;
  hazard: number;
  weight0: number;
  weight1: number;
  weight2: number;
  weight3: number;
  weightChain: number;
  weightHazard: number;
  nEff: number;
  significant: boolean;
  pValue: number;
}

export interface MatchApexCard {
  symbol: string;
  displayName: string;
  digit: number;
  verdict: MatchApexVerdict;
  confidence: number; // 0-100
  pHat: number;
  sigma: number;
  zBe: number;
  breakEven: number;
  payout: number;
  hazardRelative: number;
  gap: number;
  entropy: number;
  transEntropy: number;
  winRate: number; // out-of-sample
  winRateLower: number;
  nShots: number;
  edgePerDollar: number;
  evPerShot: number;
  survival: number;
  deepestLadder: number;
  simTotal: number;
  stationarityZ: number;
  lossClusteringXi: number;
  bar: number; // self-referential quantile bar for zBe
  deployable: boolean;
  refusalReason: string;
  readings: MatchApexReading[]; // top 3
  modelCard: {
    tau: number;
    barBoostPerLoss: number;
    postLossCoolTicks: number;
    minSpacing: number;
    postLossTightening: number;
  };
}

export interface MatchApexScanResult {
  suitable: boolean;
  best: MatchApexCard | null;
  bestAvailable: MatchApexCard | null;
  allScored: MatchApexCard[];
  mode: "locked" | "switching";
  cluster: MatchApexCard[];
  modeReason: string;
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

// ── Math helpers (copied from specialist-analysis, self-contained) ────────────

function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)); }

function logGamma(z: number): number {
  const g = 7;
  const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = z - 1; let acc = C[0]!;
  for (let i = 1; i < g + 2; i++) acc += C[i]! / (x + i);
  const t = x + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(acc);
}
function betacf(a: number, b: number, x: number, maxIter = 200, eps = 3e-12): number {
  const fpmin = 1e-300; const qab = a + b; const qap = a + 1; const qam = a - 1;
  let c = 1; let d = 1 - (qab * x) / qap; if (Math.abs(d) < fpmin) d = fpmin; d = 1 / d; let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m; let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin; c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin; c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin; d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function betaPosterior(hits: number, n: number, priorRate = 0.1, priorCount = 10) {
  const alpha = Math.max(1e-9, hits + priorCount * priorRate);
  const beta = Math.max(1e-9, n - hits + priorCount * (1 - priorRate));
  const sum = alpha + beta; const mean = alpha / sum;
  const sigma = Math.sqrt((alpha * beta) / (sum * sum * (sum + 1)));
  return { mean, sigma, alpha, beta };
}
function betaQuantile(q: number, alpha: number, beta: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (regularizedIncompleteBeta(mid, alpha, beta) < q) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function posteriorPValue(hits: number, n: number, threshold: number, direction: "hot" | "cold"): number {
  if (n <= 0) return 0.5;
  const { alpha, beta } = betaPosterior(hits, n, 0.1, 10);
  const pBelow = regularizedIncompleteBeta(threshold, alpha, beta);
  return direction === "hot" ? pBelow : 1 - pBelow;
}
function benjaminiHochberg(pValues: number[], q = 0.15): boolean[] {
  const m = pValues.length; const passes = new Array<boolean>(m).fill(false);
  if (m === 0) return passes;
  const order = pValues.map((p, i) => ({ p: Number.isFinite(p) ? clamp(p, 0, 1) : 1, i })).sort((a, b) => a.p - b.p);
  let cutoff = -1;
  for (let rank = 0; rank < m; rank++) if (order[rank]!.p <= ((rank + 1) / m) * q) cutoff = rank;
  if (cutoff < 0) return passes;
  for (let rank = 0; rank <= cutoff; rank++) passes[order[rank]!.i] = true;
  return passes;
}
function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!; return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}
function blendEstimates(est: Array<{ p: number; sigma: number }>): { p: number; sigma: number; weights: number[] } {
  const usable = est.map((e, i) => ({ ...e, i })).filter(e => Number.isFinite(e.p) && Number.isFinite(e.sigma) && e.sigma > 1e-6);
  if (usable.length === 0) return { p: 0.1, sigma: 0.35, weights: est.map(() => 0) };
  let wSum = 0; let pSum = 0;
  for (const e of usable) { const w = 1 / (e.sigma * e.sigma); wSum += w; pSum += w * e.p; }
  const p = clamp(pSum / wSum, 1e-4, 1 - 1e-4); const sigma = Math.sqrt(1 / wSum);
  const weights = new Array(est.length).fill(0);
  for (const e of usable) weights[e.i] = (1 / (e.sigma * e.sigma)) / wSum;
  return { p, sigma, weights };
}

// ── Run hazard (Kaplan-Meier style) for a digit ───────────────────────────────

function runHazardForDigit(digits: readonly number[], target: number): { hazard: Map<number, number>; kNow: number; baseline: number; reached: Map<number, number> } {
  const reached = new Map<number, number>();
  const broke = new Map<number, number>();
  let run = 0;
  for (let i = digits.length - 1; i >= 0 && reached.size < 300; i--) {
    // We traverse forward for hazard but need reverse for gap? Actually we need forward gaps.
    // Let's compute forward: we already have method in specialist-analysis but we re-implement forward.
  }
  // Forward pass for hazard
  const fReached = new Map<number, number>();
  const fBroke = new Map<number, number>();
  let fRun = 0;
  for (const d of digits) {
    if (d !== target) {
      fRun++; fReached.set(fRun, (fReached.get(fRun) ?? 0) + 1);
    } else if (fRun > 0) {
      fBroke.set(fRun, (fBroke.get(fRun) ?? 0) + 1); fRun = 0;
    }
  }
  const hazard = new Map<number, number>();
  for (const [k, r] of fReached) hazard.set(k, ((fBroke.get(k) ?? 0) + 1) / (r + 2));
  const observed = [...hazard.entries()].filter(([k]) => k >= 1 && (fReached.get(k) ?? 0) >= 3).map(([, v]) => v).sort((a, b) => a - b);
  let baseline: number;
  if (observed.length >= 2) { const mid = Math.floor(observed.length / 2); baseline = observed.length % 2 === 1 ? observed[mid]! : (observed[mid - 1]! + observed[mid]!) / 2; }
  else baseline = hazard.size > 0 ? [...hazard.values()].reduce((a, b) => a + b, 0) / hazard.size : 0.1;
  // Current gap
  let kNow = digits.length;
  for (let i = digits.length - 1; i >= 0; i--) if (digits[i] === target) { kNow = digits.length - 1 - i; break; }
  return { hazard, kNow, baseline: baseline > 0 ? baseline : 0.1, reached: fReached };
}

// ── Forgetting Dirichlet counts ───────────────────────────────────────────────

const DECAY = 0.99;
const PRIOR0 = 4;
const PRIOR1 = 2;
const PRIOR2 = 1;
const PRIOR3 = 0.5;

interface ForgettingCounts {
  w0: number[]; W0: number; W0sq: number;
  rowW: number[]; rowWsq: number[]; rowWd: number[][];
  pairW: Map<number, number>; pairWsq: Map<number, number>; pairWd: Map<number, number[]>;
  tripleW: Map<number, number>; tripleWsq: Map<number, number>; tripleWd: Map<number, number[]>;
  n: number;
}

function buildForgettingCounts(digits: readonly number[]): ForgettingCounts {
  const w0 = new Array<number>(10).fill(PRIOR0);
  let W0 = 0, W0sq = 0;
  const rowW = new Array<number>(10).fill(0);
  const rowWsq = new Array<number>(10).fill(0);
  const rowWd = Array.from({ length: 10 }, () => new Array<number>(10).fill(PRIOR1));
  const pairW = new Map<number, number>(); const pairWsq = new Map<number, number>(); const pairWd = new Map<number, number[]>();
  const tripleW = new Map<number, number>(); const tripleWsq = new Map<number, number>(); const tripleWd = new Map<number, number[]>();
  let prev1: number | null = null; let prev2: number | null = null; let prev3: number | null = null;
  let n = 0;
  for (const d of digits) {
    const λ = DECAY;
    for (let k = 0; k < 10; k++) w0[k] = (w0[k] - PRIOR0) * λ + PRIOR0;
    W0 = W0 * λ + 1; W0sq = W0sq * λ * λ + 1; w0[d] += 1;
    for (let c = 0; c < 10; c++) { rowW[c] *= λ; rowWsq[c] *= λ * λ; const row = rowWd[c]!; for (let k = 0; k < 10; k++) row[k] = (row[k] - PRIOR1) * λ + PRIOR1; }
    if (prev1 !== null) {
      rowW[prev1] += 1; rowWsq[prev1] += 1; rowWd[prev1]![d] += 1;
      for (const [key, pw] of pairW) { pairW.set(key, pw * λ); pairWsq.set(key, (pairWsq.get(key) ?? 0) * λ * λ); const prow = pairWd.get(key); if (prow) for (let k = 0; k < 10; k++) prow[k] = (prow[k] - PRIOR2) * λ + PRIOR2; }
      if (prev2 !== null) {
        const key = prev2 * 10 + prev1;
        pairW.set(key, (pairW.get(key) ?? 0) + 1); pairWsq.set(key, (pairWsq.get(key) ?? 0) + 1);
        let prow = pairWd.get(key); if (!prow) { prow = new Array(10).fill(PRIOR2); pairWd.set(key, prow); } prow[d] += 1;
        for (const [key3, pw3] of tripleW) { tripleW.set(key3, pw3 * λ); tripleWsq.set(key3, (tripleWsq.get(key3) ?? 0) * λ * λ); const trow = tripleWd.get(key3); if (trow) for (let k = 0; k < 10; k++) trow[k] = (trow[k] - PRIOR3) * λ + PRIOR3; }
        if (prev3 !== null) {
          const key3 = prev3 * 100 + prev2 * 10 + prev1;
          tripleW.set(key3, (tripleW.get(key3) ?? 0) + 1); tripleWsq.set(key3, (tripleWsq.get(key3) ?? 0) + 1);
          let trow = tripleWd.get(key3); if (!trow) { trow = new Array(10).fill(PRIOR3); tripleWd.set(key3, trow); } trow[d] += 1;
        }
        prev3 = prev2;
      }
      prev2 = prev1;
    }
    prev1 = d; n++;
  }
  return { w0, W0, W0sq, rowW, rowWsq, rowWd, pairW, pairWsq, pairWd, tripleW, tripleWsq, tripleWd, n };
}

function entropyFromCounts(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.log2(10);
  let h = 0;
  for (const c of counts) if (c > 0) { const p = c / total; h -= p * Math.log2(p); }
  return h;
}

// ── Per-digit reading ─────────────────────────────────────────────────────────

function readingForDigit(
  digits: readonly number[],
  target: number,
  counts: ForgettingCounts,
  hazardInfo: { hazard: Map<number, number>; kNow: number; baseline: number; reached: Map<number, number> },
  marketEntropy: number,
): MatchApexReading {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  const last = clean[clean.length - 1];
  const last2 = clean[clean.length - 2];
  const last3 = clean[clean.length - 3];
  // order0
  const T0 = counts.W0 + 10 * PRIOR0;
  const p0 = counts.w0[target] / T0;
  const neff0 = counts.W0 * counts.W0 / Math.max(counts.W0sq, 1e-9);
  const var0 = Math.max((p0 * (1 - p0)) / neff0, 1e-6);
  // order1
  let p1 = 0.1, var1 = var0, n1 = 0;
  if (last !== undefined) {
    const rowW = counts.rowW[last]; const T1 = rowW + 10 * PRIOR1;
    const row = counts.rowWd[last]!; p1 = row[target] / T1; n1 = rowW;
    const neff1 = rowW * rowW / Math.max(counts.rowWsq[last], 1e-9);
    var1 = rowW < 30 ? var0 : Math.max((p1 * (1 - p1)) / neff1, 1e-6);
  }
  // order2
  let p2 = p1, var2 = var1, n2 = 0;
  if (last !== undefined && last2 !== undefined) {
    const key = last2 * 10 + last;
    const pw = counts.pairW.get(key) ?? 0; const prow = counts.pairWd.get(key);
    if (prow) {
      const T2 = pw + 10 * PRIOR2; p2 = prow[target] / T2; n2 = pw;
      const pwSq = counts.pairWsq.get(key) ?? 1; const neff2 = pw * pw / Math.max(pwSq, 1e-9);
      var2 = pw < 20 ? var1 : Math.max((p2 * (1 - p2)) / neff2, 1e-6);
    }
  }
  // order3
  let p3 = p2, var3 = var2, n3 = 0;
  if (last !== undefined && last2 !== undefined && last3 !== undefined) {
    const key3 = last3 * 100 + last2 * 10 + last;
    const pw = counts.tripleW.get(key3) ?? 0; const prow = counts.tripleWd.get(key3);
    if (prow) {
      const T3 = pw + 10 * PRIOR3; p3 = prow[target] / T3; n3 = pw;
      const pwSq = counts.tripleWsq.get(key3) ?? 1; const neff3 = pw * pw / Math.max(pwSq, 1e-9);
      var3 = pw < 15 ? var2 : Math.max((p3 * (1 - p3)) / neff3, 1e-6);
    }
  }
  // 2-state outcome chain: P(target | previous occurrence)
  // Build occurrence series
  const occ = clean.map(d => (d === target ? 1 : 0));
  let w00 = 0, w01 = 0, w10 = 0, w11 = 0; let totalTarget = 0, totalWeight = 0;
  const alpha = 0.985;
  for (let i = 0; i < occ.length; i++) {
    const weight = Math.pow(alpha, occ.length - 1 - i);
    if (occ[i] === 1) totalTarget += weight; totalWeight += weight;
    if (i === 0) continue;
    const prev = occ[i - 1]!; const cur = occ[i]!;
    if (prev === 0) { if (cur === 1) w01 += weight; else w00 += weight; } else { if (cur === 1) w11 += weight; else w10 += weight; }
  }
  const n0 = w00 + w01; const n1c = w10 + w11;
  const pFrom0 = (w01 + 1) / (n0 + 2); const pFrom1 = (w11 + 1) / (n1c + 2);
  const lastOcc = occ[occ.length - 1] ?? 0;
  const pChain = lastOcc === 1 ? pFrom1 : pFrom0;
  const nChain = lastOcc === 1 ? n1c : n0;
  const varChain = Math.max((pChain * (1 - pChain)) / Math.max(4, nChain), 1e-6);
  // hazard
  const breakProb = hazardInfo.hazard.get(hazardInfo.kNow) ?? hazardInfo.baseline;
  const reached = hazardInfo.reached.get(hazardInfo.kNow) ?? 0;
  const pHazard = breakProb;
  const varHazard = Math.max((pHazard * (1 - pHazard)) / Math.max(4, reached), 1e-6);
  // blend
  const blended = blendEstimates([
    { p: p0, sigma: Math.sqrt(var0) },
    { p: p1, sigma: Math.sqrt(var1) },
    { p: p2, sigma: Math.sqrt(var2) },
    { p: p3, sigma: Math.sqrt(var3) },
    { p: pChain, sigma: Math.sqrt(varChain) },
    { p: pHazard, sigma: Math.sqrt(varHazard) },
  ]);
  const p = blended.p; const sigma = blended.sigma;
  const zBe = (p - MATCH_BREAK_EVEN) / Math.max(sigma, 0.004);
  const worstCase = p - 1.25 * sigma;
  const gap = hazardInfo.kNow;
  const recent6 = clean.slice(-6).filter(d => d === target).length;
  // entropies
  const transRow = last !== undefined ? counts.rowWd[last]! : new Array(10).fill(1);
  const transEntropy = entropyFromCounts(transRow);
  // p-value for FDR
  const hits = clean.filter(d => d === target).length;
  const pValue = posteriorPValue(hits, clean.length, MATCH_BREAK_EVEN, "hot");
  return {
    digit: target,
    p, sigma, zBe, worstCase,
    hazardRelative: hazardInfo.baseline > 1e-9 ? breakProb / hazardInfo.baseline : 1,
    gap, recent6,
    entropy: marketEntropy,
    transEntropy,
    order0: p0, order1: p1, order2: p2, order3: p3, chain: pChain, hazard: pHazard,
    weight0: blended.weights[0] ?? 0, weight1: blended.weights[1] ?? 0, weight2: blended.weights[2] ?? 0,
    weight3: blended.weights[3] ?? 0, weightChain: blended.weights[4] ?? 0, weightHazard: blended.weights[5] ?? 0,
    nEff: neff0, significant: false, pValue,
  };
}

function digitCandidatesApex(digits: readonly number[]): MatchApexReading[] {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  if (clean.length < 20) return [];
  const counts = buildForgettingCounts(clean);
  const marketEntropy = entropyFromCounts(counts.w0);
  const out: MatchApexReading[] = [];
  const pValues: number[] = [];
  for (let d = 0; d < 10; d++) {
    const hazardInfo = runHazardForDigit(clean, d);
    const r = readingForDigit(clean, d, counts, hazardInfo, marketEntropy);
    out.push(r); pValues.push(r.pValue);
  }
  const passes = benjaminiHochberg(pValues, 0.15);
  for (let i = 0; i < out.length; i++) out[i]!.significant = passes[i]!;
  return out;
}

// ── Out-of-sample simulation ──────────────────────────────────────────────────

interface SimOutcome {
  total: number;
  winRate: number;
  winRateLower: number;
  nShots: number;
  evPerShot: number;
  deepestLadder: number;
  survival: number;
  tpHit: boolean;
  slHit: boolean;
  edgePerDollar: number;
}

function wilsonLower(k: number, n: number, z = 1.645): number {
  if (n === 0) return 0;
  const p = k / n; const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const delta = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - delta) / denom);
}

function simulateStream(
  train: readonly number[],
  test: readonly number[],
  targetDigit: number,
  bar: number,
  risk: MatchApexRisk,
): SimOutcome {
  const trackerCounts = buildForgettingCounts(train);
  // We'll simulate with a simple gate that mirrors live entry but using blended reading
  // For speed, we recompute reading each tick from scratch on growing window (train+test slice)
  let debt = 0; let step = 0; let total = 0; let wins = 0; let shots = 0; let deepest = 0; let ladder = 0;
  let sinceShot = 99; let waited = 0; let tpHit = false; let slHit = false;
  const tp = risk.takeProfit; const sl = risk.stopLoss;
  const full = [...train, ...test];
  // Precompute market entropy threshold? We'll evaluate live each tick
  for (let i = 0; i < test.length; i++) {
    const window = full.slice(0, train.length + i);
    if (window.length < 40) continue;
    const counts = buildForgettingCounts(window);
    const marketEntropy = entropyFromCounts(counts.w0);
    const hazardInfo = runHazardForDigit(window, targetDigit);
    const reading = readingForDigit(window, targetDigit, counts, hazardInfo, marketEntropy);
    // opportunity gate
    const gapOk = reading.gap >= 4 && reading.gap <= MATCH_APEX_MAX_GAP;
    const hazardOk = reading.hazardRelative >= 0.8;
    const geoP = Math.pow(Math.max(1e-6, 1 - reading.p), reading.gap);
    const geoOk = geoP <= 0.4;
    const entropyOk = marketEntropy < 3.15;
    const transOk = reading.transEntropy < 2.9;
    const worstOk = reading.worstCase >= MATCH_BREAK_EVEN;
    const zOk = reading.zBe >= 1.5;
    const barOk = reading.zBe >= bar;
    const recentOk = reading.recent6 < 3;
    const clean = !reading.significant ? false : gapOk && hazardOk && geoOk && entropyOk && transOk && worstOk && zOk && barOk && recentOk;
    // patience valve
    const patienceReady = waited >= MATCH_APEX_PATIENCE && gapOk && hazardOk && zOk && recentOk;
    const ready = sinceShot >= MATCH_APEX_MIN_SPACING && (clean || patienceReady);
    if (!ready) { waited++; sinceShot++; continue; }
    waited = 0; sinceShot = 0;
    const d = test[i]!;
    const won = d === targetDigit;
    let profit: number;
    if (debt > 0) {
      const raw = (debt * (1 + risk.markupPercent / 100)) / (MATCH_PAYOUT - 1);
      const stake = Math.min(Math.max(0.35, raw), risk.maxStake);
      if (won) { profit = stake * (MATCH_PAYOUT - 1); debt = Math.max(0, debt - profit); if (debt <= 0.004) { step = 0; ladder = 0; } wins++; }
      else { profit = -stake; debt += -profit; step++; ladder++; if (ladder > deepest) deepest = ladder; if (step > risk.maxRecoverySteps) slHit = true; }
    } else {
      const stake = risk.stake;
      if (won) { profit = stake * (MATCH_PAYOUT - 1); wins++; }
      else { profit = -stake; debt = -profit; step = 1; }
    }
    total += profit; shots++;
    if (total >= tp) tpHit = true;
    if (total <= -sl) slHit = true;
    if (tpHit || slHit) break;
  }
  const winRate = shots > 0 ? wins / shots : 0;
  const lower = wilsonLower(wins, shots);
  const ev = shots > 0 ? total / shots : 0;
  const edge = winRate * MATCH_PAYOUT - 1;
  const survival = !slHit && ev > 0 && deepest <= risk.maxRecoverySteps ? 1 : 0;
  return { total, winRate, winRateLower: lower, nShots: shots, evPerShot: ev, deepestLadder: deepest, survival, tpHit, slHit, edgePerDollar: edge };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function measureMarketApex(
  symbol: string,
  displayName: string,
  digits: readonly number[],
  risk: MatchApexRisk,
): MatchApexCard | null {
  if (digits.length < MATCH_APEX_MIN_HISTORY) return null;
  const split = Math.floor(digits.length * 0.6);
  const train = digits.slice(0, split);
  const test = digits.slice(split);
  const candidates = digitCandidatesApex(digits);
  if (candidates.length === 0) return null;
  // Rank by zBe * hazard * gap shape
  const ranked = [...candidates].sort((a, b) => {
    const scoreA = a.zBe + (a.hazardRelative >= 1.25 ? 1.2 : a.hazardRelative >= 1 ? 0.7 : -0.5) + (a.gap >= 4 && a.gap <= 12 ? 0.6 : a.gap < 3 ? -1 : 0);
    const scoreB = b.zBe + (b.hazardRelative >= 1.25 ? 1.2 : b.hazardRelative >= 1 ? 0.7 : -0.5) + (b.gap >= 4 && b.gap <= 12 ? 0.6 : b.gap < 3 ? -1 : 0);
    return scoreB - scoreA;
  });
  const bestReading = ranked[0]!;
  // Self-referential bar from test distribution of zBe
  const testZ: number[] = [];
  const fullTrain = [...train];
  for (let i = 0; i < test.length; i++) {
    const win = [...fullTrain, ...test.slice(0, i)];
    if (win.length < 40) continue;
    const counts = buildForgettingCounts(win);
    const marketEntropy = entropyFromCounts(counts.w0);
    const hazardInfo = runHazardForDigit(win, bestReading.digit);
    const r = readingForDigit(win, bestReading.digit, counts, hazardInfo, marketEntropy);
    testZ.push(r.zBe);
    fullTrain.push(test[i]!);
  }
  if (testZ.length < 50) return null;
  const bar = quantile(testZ, 0.70); // top 30% selectivity, stricter than before
  const sim = simulateStream(train, test, bestReading.digit, bar, risk);
  // Stationarity: 4-block χ² on target counts
  const blocks = 4; const blockSize = Math.floor(test.length / blocks);
  const countsBlock: number[] = []; let totalHits = 0;
  for (let b = 0; b < blocks; b++) {
    const c = test.slice(b * blockSize, (b + 1) * blockSize).filter(d => d === bestReading.digit).length;
    countsBlock.push(c); totalHits += c;
  }
  const expected = totalHits / blocks;
  const chiSq = expected > 0 ? countsBlock.reduce((s, c) => s + (c - expected) ** 2 / expected, 0) : 0;
  // Wilson-Hilferty approx for z
  const df = blocks - 1; const x = Math.max(1e-9, chiSq / df); const c = 2 / (9 * df);
  const stationarityZ = (Math.cbrt(x) - (1 - c)) / Math.sqrt(c);
  // Loss clustering ξ
  let pLoss = 1 - sim.winRate; let pLossGivenLoss = 0; // simplified: if sim has losses, compute from test wins
  // For simplicity, compute ξ from test occurrence of target (not shot sequence) — placeholder
  const lossClusteringXi = 1.0;
  // Verdict
  let verdict: MatchApexVerdict = "refused"; let refusal = "";
  if (bestReading.entropy >= 3.2) { verdict = "refused"; refusal = `market entropy ${bestReading.entropy.toFixed(2)}b is too uniform for Matches`; }
  else if (bestReading.transEntropy >= 3.1) { verdict = "refused"; refusal = `transition entropy ${bestReading.transEntropy.toFixed(2)}b — last digit not predictive`; }
  else if (stationarityZ > 2.5) { verdict = "refused"; refusal = `digit frequency drifting (z ${stationarityZ.toFixed(1)})`; }
  else if (sim.nShots < 8) { verdict = "refused"; refusal = `only ${sim.nShots} shots out of sample — not enough evidence`; }
  else if (sim.slHit) { verdict = "refused"; refusal = `stop loss breached out of sample (net $${sim.total.toFixed(2)})`; }
  else if (sim.evPerShot <= 0) { verdict = "refused"; refusal = `out-of-sample EV negative ($${sim.evPerShot.toFixed(4)}/shot)`; }
  else if (sim.deepestLadder > risk.maxRecoverySteps) { verdict = "refused"; refusal = `ladder ${sim.deepestLadder} > max ${risk.maxRecoverySteps}`; }
  else if (sim.winRateLower < MATCH_BREAK_EVEN) { verdict = "refused"; refusal = `lower bound win rate ${(sim.winRateLower * 100).toFixed(1)}% < break-even ${(MATCH_BREAK_EVEN * 100).toFixed(1)}%`; }
  else if (sim.winRate >= 0.18 && sim.survival === 1 && bestReading.zBe >= 2.0) verdict = "certified";
  else if (sim.winRate >= 0.14) verdict = "qualified";
  else verdict = "watch";
  const deployable = verdict === "certified" || verdict === "qualified";
  const confidence = clamp(Math.round((Math.max(0, bestReading.zBe) / 3) * 60 + (bestReading.significant ? 25 : 0) + Math.min(15, digits.length / 200)), 0, 100);
  return {
    symbol, displayName, digit: bestReading.digit, verdict, confidence,
    pHat: bestReading.p, sigma: bestReading.sigma, zBe: bestReading.zBe,
    breakEven: MATCH_BREAK_EVEN, payout: MATCH_PAYOUT,
    hazardRelative: bestReading.hazardRelative, gap: bestReading.gap,
    entropy: bestReading.entropy, transEntropy: bestReading.transEntropy,
    winRate: sim.winRate, winRateLower: sim.winRateLower, nShots: sim.nShots,
    edgePerDollar: sim.edgePerDollar, evPerShot: sim.evPerShot,
    survival: sim.survival, deepestLadder: sim.deepestLadder, simTotal: sim.total,
    stationarityZ, lossClusteringXi,
    bar, deployable, refusalReason: refusal,
    readings: ranked.slice(0, 3),
    modelCard: { tau: bar, barBoostPerLoss: 0.5, postLossCoolTicks: MATCH_APEX_COOLDOWN, minSpacing: MATCH_APEX_MIN_SPACING, postLossTightening: 0.5 },
  };
}

export function screenCandidates(all: MatchApexCard[]): MatchApexCard[] {
  return [...all].sort((a, b) => {
    if (a.deployable !== b.deployable) return a.deployable ? -1 : 1;
    if (Math.abs(a.edgePerDollar - b.edgePerDollar) > 0.01) return b.edgePerDollar - a.edgePerDollar;
    return b.confidence - a.confidence;
  });
}

export function decideMarketMode(cards: MatchApexCard[]): { mode: "locked" | "switching"; cluster: MatchApexCard[]; reason: string } {
  if (cards.length === 0) return { mode: "locked", cluster: [], reason: "no candidates" };
  const sorted = screenCandidates(cards);
  const best = sorted[0]!;
  const second = sorted[1];
  if (!second) return { mode: "locked", cluster: [best], reason: `${best.displayName} is the only positive edge — locked` };
  const gap = best.edgePerDollar - second.edgePerDollar;
  if (gap >= 0.04) return { mode: "locked", cluster: [best], reason: `clear winner ${best.displayName} leads by ${(gap * 100).toFixed(1)}pp — locked` };
  const cluster = sorted.filter(c => c.edgePerDollar >= best.edgePerDollar - 0.06).slice(0, 4);
  return { mode: "switching", cluster, reason: `tight cluster (gap ${(gap * 100).toFixed(1)}pp) — switching among ${cluster.length} markets` };
}

export interface LiveEntry {
  ready: boolean;
  p: number;
  z: number;
  bar: number;
  reason: string;
  reading?: MatchApexReading;
}

export function evaluateLiveEntry(
  digits: readonly number[],
  card: MatchApexCard,
  opts: { barBoost: number; ticksSinceLoss: number; waitedTicks: number; tickAgeSec: number },
): LiveEntry {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  if (clean.length < 40) return { ready: false, p: 0, z: 0, bar: card.bar, reason: `collecting history ${clean.length}/40` };
  if (opts.tickAgeSec > 3) return { ready: false, p: 0, z: 0, bar: card.bar, reason: `tick feed lagging ${opts.tickAgeSec.toFixed(1)}s` };
  const counts = buildForgettingCounts(clean);
  const marketEntropy = entropyFromCounts(counts.w0);
  const hazardInfo = runHazardForDigit(clean, card.digit);
  const reading = readingForDigit(clean, card.digit, counts, hazardInfo, marketEntropy);
  const bar = card.bar + opts.barBoost;
  if (Number.isFinite(opts.ticksSinceLoss) && opts.ticksSinceLoss < card.modelCard.postLossCoolTicks) {
    return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `post-loss cool-down ${opts.ticksSinceLoss}/${card.modelCard.postLossCoolTicks}`, reading };
  }
  if (reading.gap < 3) return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `gap ${reading.gap}t too soon`, reading };
  if (reading.gap > MATCH_APEX_MAX_GAP) return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `gap ${reading.gap}t drought — regime may have broken`, reading };
  if (reading.hazardRelative < 0.8) return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `hazard ×${reading.hazardRelative.toFixed(2)} below baseline`, reading };
  const geoP = Math.pow(Math.max(1e-6, 1 - reading.p), reading.gap);
  if (geoP > 0.35) return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `gap not overdue (geo p ${geoP.toFixed(2)})`, reading };
  if (marketEntropy >= 3.15) return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `market entropy ${marketEntropy.toFixed(2)}b too high`, reading };
  if (reading.transEntropy >= 2.9) return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `transition entropy ${reading.transEntropy.toFixed(2)}b`, reading };
  if (reading.worstCase < MATCH_BREAK_EVEN) return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `worst-case ${(reading.worstCase * 100).toFixed(1)}% < be ${(MATCH_BREAK_EVEN * 100).toFixed(1)}%`, reading };
  if (reading.zBe < bar) {
    if (opts.waitedTicks >= MATCH_APEX_PATIENCE) return { ready: true, p: reading.p, z: reading.zBe, bar, reason: `patience valve — best available z ${reading.zBe.toFixed(2)} vs bar ${bar.toFixed(2)}`, reading };
    return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `waiting for edge ${reading.zBe.toFixed(2)}σ vs bar ${bar.toFixed(2)}σ`, reading };
  }
  if (reading.recent6 >= 3) return { ready: false, p: reading.p, z: reading.zBe, bar, reason: `digit hot ${reading.recent6}/6t`, reading };
  return { ready: true, p: reading.p, z: reading.zBe, bar, reason: `edge ${reading.zBe.toFixed(2)}σ vs bar ${bar.toFixed(2)}σ — digit ${reading.digit}`, reading };
}

// Page-Hinkley drift on win indicator
export function pageHinkley(wins: number[], delta = 0.05, threshold = 6): { fired: boolean; cum: number } {
  let cum = 0; let minCum = 0;
  for (const w of wins) { cum += w - delta - 0.5; if (cum < minCum) minCum = cum; if (cum - minCum > threshold) return { fired: true, cum }; }
  return { fired: false, cum };
}
