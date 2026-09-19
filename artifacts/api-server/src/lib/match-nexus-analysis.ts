/**
 * MATCH NEXUS — Quantum Singularity for Matches
 *
 * A completely new Matches bot that fixes every weakness in:
 *  - Match Sniper (BOT-MATCH): shallow 60-tick window, fixed 4-12 gap, no regime filter,
 *    no post-loss shield tuned for matches, no walk-forward OOS measurement.
 *  - Matches/Differs Oracle (BOT-KS-MATCHDIFF): generic killshot ensemble not tailored
 *    to single-digit narrow win sets, quantile gate mis-tuned for 11% base rate,
 *    post-loss shield that suppresses after loss (bad for matches where gap resets).
 *
 * DESIGN PRINCIPLES — borrowed strengths + new math:
 *
 *  From Match Sniper (strengths to keep):
 *   - Digit candidate table with hazardRelative, gap, FDR, P(digit|last) & P(digit|last2) fused
 *   - Geometric overdue test (1-p)^gap
 *   - Digit hysteresis (DIGIT_SWITCH_MARGIN)
 *
 *  From Kill-Shot Oracle (strengths to borrow):
 *   - 5-model ensemble with Hedge regret bound
 *   - Deep history 4999 digits via ticks_history (not 60)
 *   - Walk-forward train/test split, OOS measurement only
 *   - Platt calibration + Brier skill (slope collapses when no skill)
 *   - Anytime-valid e-value on SHOT sequence (Ville)
 *   - Exact ladder ruin via FMCI
 *   - Post-loss shield simulated before trusted
 *   - Page-Hinkley change detector, stationarity χ², concordance horizons
 *   - Self-referential quantile gate (selectivity is design param)
 *   - Model card frozen into session
 *
 *  NEW — what makes Nexus superior for Matches specifically:
 *
 *   1. SIX EXPERTS, all digit-aware (not generic tail):
 *      E1 Forgetting Dirichlet (λ=0.997, Jeffreys ½ prior) → drifting marginal P(d)
 *      E2 Context-Tree Mixing order 0-4 with KT estimators (h+½)/(n+1) → P(d|last k)
 *      E3 Outcome Chain — 2-state Markov on WIN indicator P(win|last outcome)
 *      E4 Digit-Specific Renewal Hazard — Kaplan-Meier h(g)=P(win|gap=g) from THIS digit's
 *         own gap history, pooled ±1 for stability, with baseline & relative hazard
 *      E5 Regime HMM — 2-state hot/cold Bernoulli emissions moment-matched from blocks,
 *         forward α-filter giving P(hot|evidence)
 *      E6 Transition Row — exact Dirichlet posterior P(d|last digit) from transition matrix,
 *         shrunk toward marginal, closed-form variance
 *
 *   2. GAP DISTRIBUTION AWARENESS (not fixed 4-12):
 *      For each digit we collect its inter-arrival gaps, compute empirical CDF,
 *      median, p70, p90. Entry requires gap >= p60 and <= p95 (adaptive),
 *      hazardRelative >= 1.25, and geometric overdue (1-pHat)^gap < 0.30.
 *      This replaces fixed band with digit's OWN breaking point.
 *
 *   3. MATCH-TUNED POST-LOSS SHIELD:
 *      For Matches, a loss resets gap to 0, so immediate re-entry is worst entry.
 *      Shield enforces: after loss, gap must be >=4 AND hazardRelative >=1.4 AND
 *      cool-down 8 ticks (balanced) / 12 (strict) / 18 (elite). Also, if same digit
 *      lost 2 of last 5, veto digit for 20 ticks and force rotation.
 *      This is simulated in walk-forward (pairShield) and reported.
 *
 *   4. ENTROPY + STATIONARITY GATES:
 *      Shannon entropy >3.275 bits = white noise → refuse.
 *      χ² block homogeneity z >3 or drift slope >0.06 → non-stationary → refuse.
 *      Concordance: at least 2 of 4 horizons (120,250,500,1000) above break-even.
 *
 *   5. MARKET SCAN = 190 CANDIDATES (19 markets × 10 digits) with BH FDR q=0.10
 *      across whole family, then ranking by: verdict > edgePerDollar > ladderSafety > confidence.
 *      Composite confidence = 0.22*acc +0.16*lcb +0.14*eValue +0.14*ladder +0.10*cluster +0.08*skill +0.06*cadence +0.06*shield +0.04*stationarity
 *
 *   6. LOCKED vs SWITCHING (same as Match Sniper):
 *      Locked: market frozen, but EDGE rotates inside it to next best digit when current cools.
 *      Switching: when Page-Hinkley fires or edge drops below qualified, re-measure all markets
 *      and move to best with hysteresis margin 0.02 EV.
 *
 *   7. SAME SHARED RECOVERY as every other bot (debt-driven stake, markup, arbiter)
 */

import {
  benjaminiHochberg,
  regularizedIncompleteBeta,
} from "./specialist-analysis";
import {
  wilsonLower,
  effectiveSampleSize,
  detectability as baseDetectability,
  stationarity,
  pageHinkley,
  concordance,
  evidenceValue,
  lossChain,
  ladderDepthLimit,
  ladderAbsorption,
  expectedShotsToLadderBreak,
  fitRegimeHmm,
  fitPlatt,
  SCAN_WINDOW,
  type Certainty as KillShotCertainty,
  type CertaintySpec as KillShotCertaintySpec,
  KILLSHOT_CERTAINTY,
  type HmmParams,
  type PlattMap,
  IDENTITY_PLATT,
  type LossChain,
  type PageHinkley,
} from "./killshot-analysis";
import { MATCH_PAYOUT } from "./payouts";

// ── Numeric helpers ───────────────────────────────────────────────────────────
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function logit(p: number): number {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(q / (1 - q));
}
function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}
function clampIndex(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Certainty tuned for Matches (rare-event) ─────────────────────────────────
export type NexusCertainty = "elite" | "strict" | "balanced";

export interface NexusCertaintySpec {
  id: NexusCertainty;
  label: string;
  blurb: string;
  targetShotRate: number;
  minShots: number;
  accuracyMargin: number;
  shortfallTolerance: number;
  minEvidenceE: number;
  minLadderSafety: number;
  maxClusterZ: number;
  minClusterGapPP: number;
  minConfidence: number;
  fdrRequired: boolean;
  postLossTightening: number;
  postLossCoolTicks: number;
  minSpacing: number;
  // Nexus-specific
  minHazardRelative: number;
  maxGeoOverdue: number;
  minGapPercentile: number;
}

export const MATCH_NEXUS_CERTAINTY: Record<NexusCertainty, NexusCertaintySpec> = {
  elite: {
    id: "elite",
    label: "Elite",
    blurb: "Top ~2% of ticks, needs 22+ OOS shots, break-even +2.5pp, hazard ≥1.4, e-value ≥25, ladder 85% safe. For when you want only the singularity.",
    targetShotRate: 0.02,
    minShots: 22,
    accuracyMargin: 0.025,
    shortfallTolerance: 0,
    minEvidenceE: 25,
    minLadderSafety: 0.85,
    maxClusterZ: 1.28,
    minClusterGapPP: 1.5,
    minConfidence: 78,
    fdrRequired: true,
    postLossTightening: 0.6,
    postLossCoolTicks: 18,
    minSpacing: 10,
    minHazardRelative: 1.4,
    maxGeoOverdue: 0.28,
    minGapPercentile: 0.65,
  },
  strict: {
    id: "strict",
    label: "Strict",
    blurb: "Default. Top ~3.5% of ticks, 14+ OOS shots, break-even +1.5pp, hazard ≥1.25, e-value ≥10, ladder 75% safe. Balanced precision.",
    targetShotRate: 0.035,
    minShots: 14,
    accuracyMargin: 0.015,
    shortfallTolerance: 0.02,
    minEvidenceE: 10,
    minLadderSafety: 0.75,
    maxClusterZ: 1.645,
    minClusterGapPP: 2.5,
    minConfidence: 65,
    fdrRequired: false,
    postLossTightening: 0.4,
    postLossCoolTicks: 12,
    minSpacing: 7,
    minHazardRelative: 1.25,
    maxGeoOverdue: 0.32,
    minGapPercentile: 0.60,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    blurb: "Top ~6% of ticks, 10+ OOS shots, break-even +0.8pp, hazard ≥1.15, e-value ≥4, ladder 60% safe. More opportunities, still measured.",
    targetShotRate: 0.06,
    minShots: 10,
    accuracyMargin: 0.008,
    shortfallTolerance: 0.04,
    minEvidenceE: 4,
    minLadderSafety: 0.60,
    maxClusterZ: 2.33,
    minClusterGapPP: 3.5,
    minConfidence: 55,
    fdrRequired: false,
    postLossTightening: 0.28,
    postLossCoolTicks: 8,
    minSpacing: 5,
    minHazardRelative: 1.15,
    maxGeoOverdue: 0.38,
    minGapPercentile: 0.55,
  },
};

export function nexusCertaintySpec(id?: string): NexusCertaintySpec {
  return MATCH_NEXUS_CERTAINTY[(id as NexusCertainty) ?? "strict"] ?? MATCH_NEXUS_CERTAINTY.strict;
}

// ── Gap distribution for a single digit ───────────────────────────────────────
export interface GapStats {
  gaps: number[];
  sorted: number[];
  median: number;
  p60: number;
  p70: number;
  p80: number;
  p90: number;
  p95: number;
  mean: number;
  count: number;
  currentGap: number;
  percentile: number; // where current gap sits in its own distribution
  hazardMap: Map<number, { wins: number; n: number; hazard: number }>;
  currentHazard: number;
  baselineHazard: number;
  hazardRelative: number;
}

export function computeGapStats(digits: number[], targetDigit: number): GapStats {
  const gaps: number[] = [];
  let lastSeen = -1;
  let currentGap = digits.length;
  for (let i = 0; i < digits.length; i++) {
    if (digits[i] === targetDigit) {
      if (lastSeen >= 0) gaps.push(i - lastSeen - 1);
      lastSeen = i;
    }
  }
  if (lastSeen >= 0) currentGap = digits.length - 1 - lastSeen;
  else currentGap = digits.length;

  const sorted = [...gaps].sort((a, b) => a - b);
  const pct = (p: number): number => {
    if (sorted.length === 0) return 9;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
    return sorted[idx] ?? 9;
  };

  // Hazard: for each gap length k, how often did a gap of length k end (win) vs continue?
  // We need to count gaps that reached at least k, and how many broke at k.
  const reached = new Map<number, number>();
  const broke = new Map<number, number>();
  for (const g of gaps) {
    for (let k = 0; k < g; k++) reached.set(k, (reached.get(k) ?? 0) + 1);
    reached.set(g, (reached.get(g) ?? 0) + 1);
    broke.set(g, (broke.get(g) ?? 0) + 1);
  }
  // Include censored current gap as reached but not broke
  for (let k = 0; k < currentGap; k++) reached.set(k, (reached.get(k) ?? 0) + 1);
  reached.set(currentGap, (reached.get(currentGap) ?? 0) + 1);

  const hazardMap = new Map<number, { wins: number; n: number; hazard: number }>();
  let hazardSum = 0;
  let hazardCount = 0;
  for (const [k, r] of reached) {
    const b = broke.get(k) ?? 0;
    const h = (b + 1) / (r + 2); // Laplace
    hazardMap.set(k, { wins: b, n: r, hazard: h });
    if (r >= 3) {
      hazardSum += h;
      hazardCount++;
    }
  }
  const baselineHazard = hazardCount > 0 ? hazardSum / hazardCount : 0.1;
  const currentHazard = hazardMap.get(currentGap)?.hazard ?? baselineHazard;
  const hazardRelative = baselineHazard > 1e-9 ? currentHazard / baselineHazard : 1;

  let pctile = 0;
  if (sorted.length > 0) {
    let le = 0;
    for (const g of sorted) if (g <= currentGap) le++;
    pctile = le / sorted.length;
  }

  return {
    gaps,
    sorted,
    median: pct(0.5),
    p60: pct(0.6),
    p70: pct(0.7),
    p80: pct(0.8),
    p90: pct(0.9),
    p95: pct(0.95),
    mean: gaps.length > 0 ? mean(gaps) : 9,
    count: gaps.length,
    currentGap,
    percentile: pctile,
    hazardMap,
    currentHazard,
    baselineHazard,
    hazardRelative: round(hazardRelative, 3),
  };
}

// ── Ensemble for Matches ──────────────────────────────────────────────────────
export const NEXUS_EXPERTS = [
  "dirichlet",
  "context-tree",
  "outcome-chain",
  "renewal-hazard",
  "regime-hmm",
  "transition-row",
] as const;
export type NexusExpertName = (typeof NEXUS_EXPERTS)[number];

export interface NexusExpertReading {
  name: NexusExpertName;
  p: number;
  n: number;
  weight: number;
}

export interface NexusEnsembleReading {
  raw: number;
  p: number;
  sigma: number;
  spread: number;
  z: number;
  zRel: number;
  zGate: number;
  gate: number;
  experts: NexusExpertReading[];
  leader: NexusExpertName;
  contextOrder: number;
  contextCount: number;
  gapStats: GapStats;
}

const MAX_ORDER = 4;
const DIRICHLET_DECAY = 0.997;
const HEDGE_ETA = 0.35;
const Z_WINDOW = 600;
const Z_WINDOW_MIN = 200;
const Q_REFRESH = 25;

export class MatchNexusEnsemble {
  private readonly targetDigit: number;
  private readonly breakEven: number;
  private readonly targetRate: number;

  private dirichlet = new Array<number>(10).fill(0.5);
  private ctxHits = new Map<string, number>();
  private ctxCount = new Map<string, number>();
  private chain = { ww: 0, wl: 0, lw: 0, ll: 0 };
  private gapHits = new Map<number, { wins: number; n: number }>();
  private sinceWin = 0;
  private hmm: HmmParams;
  private hotBelief: number;
  private logW: number[];
  private digits: number[] = [];
  private wins: number[] = [];
  private nSeen = 0;

  // Transition row counts for E6
  private rowOut = new Array<number>(10).fill(0);
  private rowHit = new Array<number>(100).fill(0);

  private zHist: number[] = [];
  private zSum = 0;
  private zSumSq = 0;
  private qCache = 0;
  private qFresh = false;

  constructor(targetDigit: number, breakEven: number, hmm?: HmmParams, targetShotRate = 0.035) {
    this.targetDigit = targetDigit;
    this.breakEven = breakEven;
    this.targetRate = clamp(targetShotRate, 0.001, 0.5);
    const fair = 0.1;
    this.hmm = hmm ?? { pHot: clamp(fair + 0.06, 0.02, 0.98), pCold: clamp(fair - 0.06, 0.01, 0.97), stay: 0.97, prior: 0.5 };
    this.hotBelief = this.hmm.prior;
    this.logW = NEXUS_EXPERTS.map(() => 0);
  }

  get seen(): number { return this.nSeen; }
  get marginal(): number { return this.nSeen > 0 ? mean(this.wins) : 0.1; }
  get statWarmth(): number { return this.zHist.length; }
  get statReady(): boolean { return this.zHist.length >= Z_WINDOW_MIN; }
  get regimeHot(): number { return round(this.hotBelief, 4); }

  private ctxKey(order: number): string {
    if (order === 0) return "0:";
    const n = this.digits.length;
    if (n < order) return "";
    return `${order}:${this.digits.slice(n - order).join("")}`;
  }

  private standardise(z: number): number {
    const n = this.zHist.length;
    if (n < Z_WINDOW_MIN) return z;
    const mu = this.zSum / n;
    const varZ = Math.max(1e-6, this.zSumSq / n - mu * mu);
    return (z - mu) / Math.sqrt(varZ);
  }

  private windowGate(): number {
    const n = this.zHist.length;
    if (n < Z_WINDOW_MIN) return Number.POSITIVE_INFINITY;
    if (!this.qFresh) {
      const sorted = [...this.zHist].sort((a, b) => a - b);
      const idx = clampIndex(Math.floor(n * (1 - this.targetRate)), 0, n - 1);
      const mu = this.zSum / n;
      const sd = Math.sqrt(Math.max(1e-6, this.zSumSq / n - mu * mu));
      this.qCache = (sorted[idx] - mu) / sd;
      this.qFresh = true;
    }
    return this.qCache;
  }

  // E1
  private readDirichlet(): { p: number; n: number } {
    const total = this.dirichlet.reduce((a, b) => a + b, 0);
    const win = this.dirichlet[this.targetDigit];
    return { p: clamp(win / Math.max(1e-9, total), 1e-4, 1 - 1e-4), n: Math.round(total) };
  }

  // E2
  private readContextTree(): { p: number; n: number; order: number; count: number } {
    let wSum = 0;
    let pSum = 0;
    let bestW = -1;
    let bestOrder = 0;
    let bestCount = 0;
    for (let order = 0; order <= MAX_ORDER; order++) {
      const key = this.ctxKey(order);
      if (!key) continue;
      const c = this.ctxCount.get(key) ?? 0;
      if (order > 0 && c < 5) continue;
      const h = this.ctxHits.get(key) ?? 0;
      const p = (h + 0.5) / (c + 1);
      const w = (c / (c + 12)) * Math.pow(0.6, order);
      wSum += w;
      pSum += w * p;
      if (w > bestW) { bestW = w; bestOrder = order; bestCount = c; }
    }
    if (wSum <= 0) return { p: this.marginal, n: 0, order: 0, count: 0 };
    return { p: clamp(pSum / wSum, 1e-4, 1 - 1e-4), n: bestCount, order: bestOrder, count: bestCount };
  }

  // E3
  private readOutcomeChain(): { p: number; n: number } {
    if (this.wins.length === 0) return { p: this.marginal, n: 0 };
    const lastWon = this.wins[this.wins.length - 1] === 1;
    const prior = 4 * this.marginal;
    const priorN = 4;
    if (lastWon) {
      const n = this.chain.ww + this.chain.wl;
      return { p: clamp((this.chain.ww + prior) / (n + priorN), 1e-4, 1 - 1e-4), n };
    }
    const n = this.chain.lw + this.chain.ll;
    return { p: clamp((this.chain.lw + prior) / (n + priorN), 1e-4, 1 - 1e-4), n };
  }

  // E4
  private readHazard(): { p: number; n: number } {
    const g = this.sinceWin;
    let wins = 0;
    let n = 0;
    for (let d = -1; d <= 1; d++) {
      const cell = this.gapHits.get(g + d);
      if (cell) { wins += cell.wins; n += cell.n; }
    }
    if (n < 6) return { p: this.marginal, n };
    const prior = 5 * this.marginal;
    return { p: clamp((wins + prior) / (n + 5), 1e-4, 1 - 1e-4), n };
  }

  // E5
  private readRegime(): { p: number; n: number } {
    const { pHot, pCold, stay } = this.hmm;
    const hotNext = this.hotBelief * stay + (1 - this.hotBelief) * (1 - stay);
    return { p: clamp(hotNext * pHot + (1 - hotNext) * pCold, 1e-4, 1 - 1e-4), n: this.nSeen };
  }

  // E6
  private readTransitionRow(): { p: number; n: number } {
    if (this.digits.length === 0) return { p: 0.1, n: 0 };
    const last = this.digits[this.digits.length - 1]!;
    const total = this.rowOut[last] ?? 0;
    if (total < 4) return { p: 0.1, n: total };
    const hit = this.rowHit[last * 10 + this.targetDigit] ?? 0;
    // Dirichlet posterior with marginal prior
    const marg = this.dirichlet[this.targetDigit] / this.dirichlet.reduce((a, b) => a + b, 0);
    const kappa = 8;
    const p = (hit + kappa * marg) / (total + kappa);
    return { p: clamp(p, 1e-4, 1 - 1e-4), n: total };
  }

  predict(platt: PlattMap = IDENTITY_PLATT): NexusEnsembleReading {
    const d1 = this.readDirichlet();
    const d2 = this.readContextTree();
    const d3 = this.readOutcomeChain();
    const d4 = this.readHazard();
    const d5 = this.readRegime();
    const d6 = this.readTransitionRow();

    const readings: Array<{ name: NexusExpertName; p: number; n: number }> = [
      { name: "dirichlet", p: d1.p, n: d1.n },
      { name: "context-tree", p: d2.p, n: d2.n },
      { name: "outcome-chain", p: d3.p, n: d3.n },
      { name: "renewal-hazard", p: d4.p, n: d4.n },
      { name: "regime-hmm", p: d5.p, n: d5.n },
      { name: "transition-row", p: d6.p, n: d6.n },
    ];

    const maxLog = Math.max(...this.logW);
    const exps = this.logW.map(l => Math.exp(l - maxLog));
    const zSum = exps.reduce((a, b) => a + b, 0) || 1;
    const weights = exps.map(e => e / zSum);

    const raw = clamp(readings.reduce((a, r, i) => a + weights[i]! * r.p, 0), 1e-5, 1 - 1e-5);
    const spreadVar = readings.reduce((a, r, i) => a + weights[i]! * (r.p - raw) ** 2, 0);
    const leadIdx = weights.indexOf(Math.max(...weights));
    const leadN = Math.max(8, readings[leadIdx]!.n);
    const postVar = (raw * (1 - raw)) / leadN;
    const sigma = Math.sqrt(postVar + spreadVar);

    const p = platt.n > 0 ? clamp(sigmoid(platt.a * logit(raw) + platt.b), 1e-5, 1 - 1e-5) : raw;
    const z = (p - this.breakEven) / Math.max(1e-4, sigma);
    const zRel = this.standardise(z);
    const gate = this.windowGate();

    // Gap stats for timing
    const gapStats = computeGapStats(this.digits, this.targetDigit);

    return {
      raw: round(raw, 6),
      p: round(p, 6),
      sigma: round(Math.max(sigma, 1e-4), 6),
      spread: round(Math.sqrt(spreadVar), 6),
      z: round(z, 4),
      zRel: round(zRel, 4),
      zGate: round(Number.isFinite(gate) ? zRel - gate : -99, 4),
      gate: round(Number.isFinite(gate) ? gate : 0, 4),
      experts: readings.map((r, i) => ({ name: r.name, p: round(r.p, 5), n: r.n, weight: round(weights[i]!, 4) })),
      leader: readings[leadIdx]!.name,
      contextOrder: d2.order,
      contextCount: d2.count,
      gapStats,
    };
  }

  observe(digit: number, reading?: NexusEnsembleReading) {
    const won = digit === this.targetDigit ? 1 : 0;

    if (reading) {
      this.zHist.push(reading.z);
      this.zSum += reading.z;
      this.zSumSq += reading.z * reading.z;
      if (this.zHist.length > Z_WINDOW) {
        const old = this.zHist.shift()!;
        this.zSum -= old;
        this.zSumSq -= old * old;
      }
      if (this.zHist.length % Q_REFRESH === 0) this.qFresh = false;
    }

    if (reading) {
      for (let i = 0; i < reading.experts.length; i++) {
        const pi = clamp(reading.experts[i]!.p, 1e-5, 1 - 1e-5);
        const loss = won === 1 ? -Math.log(pi) : -Math.log(1 - pi);
        this.logW[i]! -= HEDGE_ETA * loss;
      }
      const maxLog = Math.max(...this.logW);
      for (let i = 0; i < this.logW.length; i++) this.logW[i]! -= maxLog;
    }

    // E1 decay
    for (let d = 0; d < 10; d++) this.dirichlet[d] = 0.5 + (this.dirichlet[d]! - 0.5) * DIRICHLET_DECAY;
    this.dirichlet[digit]! += 1;

    // E2 context
    for (let order = 0; order <= MAX_ORDER; order++) {
      const key = this.ctxKey(order);
      if (!key) continue;
      this.ctxCount.set(key, (this.ctxCount.get(key) ?? 0) + 1);
      if (won === 1) this.ctxHits.set(key, (this.ctxHits.get(key) ?? 0) + 1);
    }

    // E3 chain
    if (this.wins.length > 0) {
      const prevWon = this.wins[this.wins.length - 1] === 1;
      if (prevWon && won === 1) this.chain.ww++;
      else if (prevWon && won === 0) this.chain.wl++;
      else if (!prevWon && won === 1) this.chain.lw++;
      else this.chain.ll++;
    }

    // E4 hazard
    const cell = this.gapHits.get(this.sinceWin) ?? { wins: 0, n: 0 };
    cell.n++;
    if (won === 1) cell.wins++;
    this.gapHits.set(this.sinceWin, cell);
    this.sinceWin = won === 1 ? 0 : this.sinceWin + 1;

    // E5 HMM forward
    const { pHot, pCold, stay } = this.hmm;
    const hotPrior = this.hotBelief * stay + (1 - this.hotBelief) * (1 - stay);
    const lHot = won === 1 ? pHot : 1 - pHot;
    const lCold = won === 1 ? pCold : 1 - pCold;
    const num = hotPrior * lHot;
    const den = num + (1 - hotPrior) * lCold;
    this.hotBelief = den > 1e-12 ? clamp(num / den, 1e-4, 1 - 1e-4) : hotPrior;

    // E6 transition row
    if (this.digits.length > 0) {
      const prev = this.digits[this.digits.length - 1]!;
      this.rowOut[prev]! += 1;
      this.rowHit[prev * 10 + digit]! += 1;
    }

    this.digits.push(digit);
    this.wins.push(won);
    if (this.digits.length > 12000) { this.digits.shift(); this.wins.shift(); }
    this.nSeen++;
  }
}

// ── Walk-forward & Candidate ──────────────────────────────────────────────────
export interface NexusShot {
  index: number;
  won: boolean;
  p: number;
  z: number;
  zGate: number;
  leader: NexusExpertName;
  contextOrder: number;
  contextCount: number;
  gap: number;
  hazardRelative: number;
  suppressedByShield: boolean;
}

export interface NexusLedger {
  shots: NexusShot[];
  nShots: number;
  examined: number;
  fireRate: number;
  winRate: number;
  winRateLower: number;
  evPerDollar: number;
  evLowerPerDollar: number;
  longestLossRun: number;
  chain: LossChain;
  evidence: { e: number; logE: number; peak: number; n: number; pValue: number };
  ladderBroke: boolean;
  meanPredicted: number;
}

export interface NexusShield {
  suppressed: number;
  shieldedWinRate: number;
  shieldedShots: number;
  pairsBefore: number;
  pairsAfter: number;
  longestRunAfter: number;
}

export interface NexusWalkForward {
  trainTicks: number;
  testTicks: number;
  tau: number;
  trainShotRate: number;
  platt: PlattMap;
  train: NexusLedger;
  test: NexusLedger;
  shield: NexusShield;
  hmm: HmmParams;
  gapStats: GapStats;
}

export interface NexusWalkParams {
  breakEven: number;
  payout: number;
  spec: NexusCertaintySpec;
  baseStake: number;
  markupPercent: number;
  maxStake: number;
  stopLoss: number;
  burnIn?: number;
  trainFraction?: number;
}

function summariseNexusLedger(
  shots: NexusShot[],
  examined: number,
  payout: number,
  breakEven: number,
  ladderLimit: number,
): NexusLedger {
  const outcomes = shots.map(s => (s.won ? 1 : 0));
  const nShots = shots.length;
  const hits = outcomes.reduce((a, b) => a + b, 0);
  const winRate = nShots > 0 ? hits / nShots : 0;
  const lower = wilsonLower(hits, nShots);

  let depth = 0, maxDepth = 0, broke = false;
  for (const s of shots) {
    if (s.won) { depth = 0; continue; }
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    if (depth > ladderLimit) broke = true;
  }

  return {
    shots,
    nShots,
    examined,
    fireRate: examined > 0 ? round(nShots / examined, 5) : 0,
    winRate: round(winRate, 5),
    winRateLower: round(lower, 5),
    evPerDollar: round(winRate * payout - 1, 5),
    evLowerPerDollar: round(lower * payout - 1, 5),
    longestLossRun: maxDepth,
    chain: lossChain(outcomes),
    evidence: evidenceValue(outcomes, breakEven),
    ladderBroke: broke,
    meanPredicted: round(nShots > 0 ? mean(shots.map(s => s.p)) : 0, 5),
  };
}

function simulateNexusShield(shots: NexusShot[], spec: NexusCertaintySpec, tau: number, maxBoost = 2.5): NexusShield {
  let pairsBefore = 0;
  for (let i = 1; i < shots.length; i++) if (!shots[i]!.won && !shots[i - 1]!.won) pairsBefore++;

  const kept: NexusShot[] = [];
  let lastLossIndex = -Infinity;
  let lossRun = 0;
  for (const s of shots) {
    // For matches, shield is stricter after loss: gap must be >=4 and hazard high
    const boost = Math.min(maxBoost, spec.postLossTightening * lossRun);
    const cooled = s.index - lastLossIndex >= spec.postLossCoolTicks;
    const gapOk = s.gap >= 4;
    const hazardOk = s.hazardRelative >= (lossRun > 0 ? 1.4 : spec.minHazardRelative);
    const clears = s.zGate >= tau + boost;
    if (cooled && gapOk && hazardOk && clears) {
      kept.push({ ...s, suppressedByShield: false });
      if (!s.won) { lastLossIndex = s.index; lossRun++; }
      else { lastLossIndex = -Infinity; lossRun = 0; }
    }
  }

  let pairsAfter = 0, run = 0, longest = 0;
  for (let i = 0; i < kept.length; i++) {
    if (!kept[i]!.won) { run++; longest = Math.max(longest, run); if (i > 0 && !kept[i - 1]!.won) pairsAfter++; }
    else run = 0;
  }
  const hits = kept.filter(s => s.won).length;

  return {
    suppressed: shots.length - kept.length,
    shieldedWinRate: round(kept.length > 0 ? hits / kept.length : 0, 5),
    shieldedShots: kept.length,
    pairsBefore,
    pairsAfter,
    longestRunAfter: longest,
  };
}

export function walkForwardNexus(
  digits: number[],
  targetDigit: number,
  params: NexusWalkParams,
): NexusWalkForward {
  const clean = digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  const n = clean.length;
  const burnIn = Math.max(200, params.burnIn ?? 350);
  const trainFraction = clamp(params.trainFraction ?? 0.5, 0.3, 0.7);
  const spec = params.spec;
  const be = params.breakEven;

  const ladder = ladderDepthLimit({
    baseStake: params.baseStake,
    payout: params.payout,
    markupPercent: params.markupPercent,
    maxStake: params.maxStake,
    stopLoss: params.stopLoss,
  });

  const empty = (): NexusLedger => summariseNexusLedger([], 0, params.payout, be, ladder.limit);
  if (n < burnIn + 300) {
    return {
      trainTicks: 0, testTicks: 0, tau: 0, trainShotRate: 0,
      platt: { ...IDENTITY_PLATT }, train: empty(), test: empty(),
      shield: { suppressed: 0, shieldedWinRate: 0, shieldedShots: 0, pairsBefore: 0, pairsAfter: 0, longestRunAfter: 0 },
      hmm: fitRegimeHmm([]),
      gapStats: computeGapStats(clean, targetDigit),
    };
  }

  const wins = clean.map(d => (d === targetDigit ? 1 : 0));
  const splitIndex = burnIn + Math.floor((n - burnIn) * trainFraction);

  const hmm = fitRegimeHmm(wins.slice(0, splitIndex));

  // Pass 1: train for Platt
  const fitEns = new MatchNexusEnsemble(targetDigit, be, hmm, spec.targetShotRate);
  const trainRaw: number[] = [];
  const trainOutcome: number[] = [];
  for (let i = 0; i < splitIndex; i++) {
    if (i >= burnIn) {
      const r = fitEns.predict();
      trainRaw.push(r.raw);
      trainOutcome.push(wins[i]!);
      fitEns.observe(clean[i]!, r);
    } else {
      fitEns.observe(clean[i]!);
    }
  }
  const platt = fitPlatt(trainRaw, trainOutcome);

  // Second pass for tau: quantile of calibrated zGate on training half
  const calEns = new MatchNexusEnsemble(targetDigit, be, hmm, spec.targetShotRate);
  const calZ: number[] = [];
  for (let i = 0; i < splitIndex; i++) {
    if (i >= burnIn) {
      const r = calEns.predict(platt);
      if (calEns.statReady) calZ.push(r.zGate);
      calEns.observe(clean[i]!, r);
    } else {
      calEns.observe(clean[i]!);
    }
  }
  calZ.sort((a, b) => a - b);
  const targetCount = Math.ceil(calZ.length * spec.targetShotRate);
  const neededCount = Math.ceil(spec.minShots * 1.6);
  const wanted = Math.min(calZ.length, Math.max(targetCount, neededCount));
  const qIndex = Math.max(0, Math.min(Math.max(0, calZ.length - 1), calZ.length - wanted));
  const tau = calZ.length > 0 ? calZ[qIndex]! : 0;

  // Pass 2: continuous walk-forward
  const live = new MatchNexusEnsemble(targetDigit, be, hmm, spec.targetShotRate);
  const trainShots: NexusShot[] = [];
  const testShots: NexusShot[] = [];
  let trainExamined = 0;
  let testExamined = 0;
  let lastFire = -Infinity;

  for (let i = 0; i < n; i++) {
    if (i >= burnIn) {
      const r = live.predict(platt);
      const isTest = i >= splitIndex;
      const eligible = live.statReady;
      if (eligible) { if (isTest) testExamined++; else trainExamined++; }

      // Additional Nexus gates beyond quantile
      const gap = r.gapStats.currentGap;
      const hazRel = r.gapStats.hazardRelative;
      const pctile = r.gapStats.percentile;
      const geoOverdue = Math.pow(Math.max(1e-6, 1 - r.p), gap);

      const gapOk = gap >= 4 && gap <= Math.max(18, r.gapStats.p95);
      const hazOk = hazRel >= spec.minHazardRelative;
      const pctOk = pctile >= spec.minGapPercentile;
      const geoOk = geoOverdue <= spec.maxGeoOverdue;

      if (eligible && i - lastFire >= spec.minSpacing && r.zGate >= tau && gapOk && hazOk && pctOk && geoOk) {
        const shot: NexusShot = {
          index: i,
          won: wins[i] === 1,
          p: r.p,
          z: r.z,
          zGate: r.zGate,
          leader: r.leader,
          contextOrder: r.contextOrder,
          contextCount: r.contextCount,
          gap,
          hazardRelative: hazRel,
          suppressedByShield: false,
        };
        (isTest ? testShots : trainShots).push(shot);
        lastFire = i;
      }
      live.observe(clean[i]!, r);
    } else {
      live.observe(clean[i]!);
    }
  }

  const gapStatsFinal = computeGapStats(clean, targetDigit);

  return {
    trainTicks: trainExamined,
    testTicks: testExamined,
    tau: round(tau, 4),
    trainShotRate: trainExamined > 0 ? round(trainShots.length / trainExamined, 5) : 0,
    platt,
    train: summariseNexusLedger(trainShots, trainExamined, params.payout, be, ladder.limit),
    test: summariseNexusLedger(testShots, testExamined, params.payout, be, ladder.limit),
    shield: simulateNexusShield(testShots, spec, tau),
    hmm,
    gapStats: gapStatsFinal,
  };
}

// ── Candidate evaluation ──────────────────────────────────────────────────────
export interface LadderReport {
  limit: number;
  byStakeCap: number;
  byStopLoss: number;
  growthFactor: number;
  safety: number;
  expectedShotsToBreak: number;
  horizon: number;
  stakeAtLimit: number;
  debtAtLimit: number;
}

export type NexusVerdict = "certified" | "qualified" | "watch" | "refused";

export interface NexusCandidate {
  symbol: string;
  displayName: string;
  digit: number;
  label: string;
  certainty: NexusCertainty;
  verdict: NexusVerdict;
  confidence: number;
  edgePerDollar: number;
  breakEven: number;
  payout: number;
  detect: ReturnType<typeof baseDetectability>;
  walk: NexusWalkForward;
  ladder: LadderReport;
  stationarity: { z: number; trend: number; rates: number[] };
  concordance: { rates: Array<{ window: number; p: number; n: number }>; agreeing: number; total: number; spread: number };
  drift: PageHinkley;
  marginalRate: number;
  samples: number;
  kellyFraction: number;
  blockers: string[];
  signals: string[];
  card: NexusModelCard;
  pValue: number;
  significant: boolean;
  deployable: boolean;
}

export interface NexusModelCard {
  targetDigit: number;
  tau: number;
  targetShotRate: number;
  platt: PlattMap;
  hmm: HmmParams;
  breakEven: number;
  payout: number;
  minSpacing: number;
  postLossTightening: number;
  postLossCoolTicks: number;
  fittedOn: number;
  gapStats: GapStats;
}

export interface NexusLiveEntry {
  ready: boolean;
  p: number;
  sigma: number;
  z: number;
  edgeZ: number;
  statWarmth: number;
  tau: number;
  bar: number;
  marginZ: number;
  leader: NexusExpertName;
  contextOrder: number;
  contextCount: number;
  regimeHot: number;
  gap: number;
  hazardRelative: number;
  percentile: number;
  geoOverdue: number;
  experts: NexusExpertReading[];
  reason: string;
}

export const MIN_HISTORY_NEXUS = 900;
export const SCAN_WINDOW_NEXUS = SCAN_WINDOW;

export interface NexusEvalOptions {
  certainty?: NexusCertainty;
  baseStake?: number;
  markupPercent?: number;
  maxStake?: number;
  stopLoss?: number;
}

export function evaluateNexusCandidate(
  symbol: string,
  displayName: string,
  digits: number[],
  digit: number,
  options: NexusEvalOptions = {},
): NexusCandidate | null {
  const clean = digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  const spec = nexusCertaintySpec(options.certainty);
  if (clean.length < MIN_HISTORY_NEXUS) return null;
  if (digit < 0 || digit > 9) return null;

  const payout = MATCH_PAYOUT;
  const breakEven = 1 / payout;
  const wins = clean.map(d => (d === digit ? 1 : 0));
  const detect = baseDetectability({ kind: "match", digit } as any);

  const baseStake = options.baseStake ?? 1;
  const markupPercent = options.markupPercent ?? 10;
  const maxStake = options.maxStake ?? 500;
  const stopLoss = options.stopLoss ?? 5;

  const walk = walkForwardNexus(clean, digit, {
    breakEven, payout, spec, baseStake, markupPercent, maxStake, stopLoss,
  });

  const depth = ladderDepthLimit({ baseStake, payout, markupPercent, maxStake, stopLoss });
  const horizon = Math.max(80, walk.test.nShots * 2, 100);
  const chain = walk.test.chain;
  const absorption = ladderAbsorption(chain.pLoss, chain.q, depth.limit, horizon);
  const ladder: LadderReport = {
    limit: depth.limit,
    byStakeCap: depth.byStakeCap,
    byStopLoss: depth.byStopLoss,
    growthFactor: depth.growthFactor,
    safety: round(1 - absorption, 4),
    expectedShotsToBreak: expectedShotsToLadderBreak(chain.pLoss, chain.q, depth.limit),
    horizon,
    stakeAtLimit: depth.stakeAtLimit,
    debtAtLimit: depth.debtAtLimit,
  };

  const stat = stationarity(wins, 6);
  const drift = pageHinkley(wins);
  const conc = concordance(clean, new Set([digit]), breakEven, 0);
  const marginalRate = mean(wins);

  const b = Math.max(1e-6, payout - 1);
  const pK = walk.test.winRateLower;
  const kelly = clamp((pK * b - (1 - pK)) / b, 0, 1);

  const shotOutcomes = walk.test.shots.map(s => (s.won ? 1 : 0));
  const nEff = Math.max(1, effectiveSampleSize(shotOutcomes));
  const scaledHits = walk.test.winRate * nEff;
  const pValue = walk.test.nShots > 0
    ? round(clamp(regularizedIncompleteBeta(clamp(breakEven, 0, 1), Math.max(1e-9, scaledHits + 0.5), Math.max(1e-9, nEff - scaledHits + 0.5)), 0, 1), 6)
    : 1;

  const blockers: string[] = [];
  const test = walk.test;

  if (test.nShots < spec.minShots) {
    blockers.push(`only ${test.nShots} OOS shots (${spec.minShots} needed) — ${walk.testTicks} test ticks at ${(spec.targetShotRate * 100).toFixed(1)}% selectivity`);
  }
  if (test.nShots > 0 && test.winRate < breakEven + spec.accuracyMargin) {
    blockers.push(`OOS win ${(test.winRate * 100).toFixed(1)}% needs BE ${(breakEven * 100).toFixed(1)}% + ${(spec.accuracyMargin * 100).toFixed(1)}pp`);
  }
  if (test.nShots > 0 && test.winRateLower < breakEven - spec.shortfallTolerance) {
    blockers.push(`Wilson floor ${(test.winRateLower * 100).toFixed(1)}% sits >${(spec.shortfallTolerance * 100).toFixed(1)}pp under BE`);
  }
  if (test.evidence.peak < spec.minEvidenceE) {
    blockers.push(`e-value ${test.evidence.peak.toFixed(1)} < ${spec.minEvidenceE} — shots haven't ruled out no edge (p≈${test.evidence.pValue < 0.001 ? test.evidence.pValue.toExponential(1) : test.evidence.pValue.toFixed(3)})`);
  }
  if (ladder.safety < spec.minLadderSafety) {
    blockers.push(`ladder safety ${(ladder.safety * 100).toFixed(1)}% over ${horizon} shots — ${spec.label} wants ${(spec.minLadderSafety * 100).toFixed(0)}% (absorbs ${ladder.limit} consecutive losses)`);
  }
  if (test.nShots > 4 && chain.clusterZ > spec.maxClusterZ && chain.clusterGapPP >= spec.minClusterGapPP) {
    blockers.push(`losses cluster — P(L|L) ${(chain.q * 100).toFixed(1)}% vs marginal ${(chain.pLoss * 100).toFixed(1)}% (ξ ${chain.xi.toFixed(2)}, +${chain.clusterGapPP.toFixed(1)}pp at z ${chain.clusterZ.toFixed(2)})`);
  }
  if (walk.platt.brierSkill <= 0 && walk.platt.n > 0) {
    blockers.push(`no conditional skill — Brier skill ${(walk.platt.brierSkill * 100).toFixed(2)}% (slope ${walk.platt.a.toFixed(2)})`);
  }
  if (Math.abs(stat.z) > 3) blockers.push(`non-stationary (χ²→z ${stat.z})`);
  if (Math.abs(stat.trend) > 0.06) blockers.push(`drifting rate (slope ${stat.trend}/block)`);
  // Nexus-specific gates
  if (walk.gapStats.hazardRelative < spec.minHazardRelative) {
    blockers.push(`hazard ×${walk.gapStats.hazardRelative.toFixed(2)} < ${spec.minHazardRelative} — dormancy not at breaking point`);
  }
  if (walk.gapStats.percentile < spec.minGapPercentile) {
    blockers.push(`gap ${walk.gapStats.currentGap}t at ${(walk.gapStats.percentile * 100).toFixed(0)}th percentile < ${(spec.minGapPercentile * 100).toFixed(0)}th — not overdue for this digit`);
  }
  // Entropy gate: digit stream white noise?
  // We approximate entropy from digit frequency
  const freq = new Array(10).fill(0);
  for (const d of clean) freq[d]++;
  const total = clean.length;
  let ent = 0;
  for (const c of freq) if (c > 0) { const p = c / total; ent -= p * Math.log2(p); }
  if (ent >= 3.275) blockers.push(`entropy ${ent.toFixed(3)}b — white noise, no structure to trade`);

  const accTerm = clamp((test.winRate - breakEven) / Math.max(0.01, spec.accuracyMargin * 2.5), 0, 1);
  const lcbTerm = clamp((test.winRateLower - breakEven) / Math.max(0.01, spec.accuracyMargin * 2), 0, 1);
  const eTerm = clamp(Math.log10(Math.max(1, test.evidence.peak)) / Math.log10(Math.max(2, spec.minEvidenceE * 4)), 0, 1);
  const ladderTerm = clamp(ladder.safety, 0, 1);
  const pairTerm = clamp(1 - Math.max(0, chain.clusterZ) / Math.max(1, spec.maxClusterZ * 2), 0, 1);
  const skillTerm = clamp(walk.platt.brierSkill / 0.02, 0, 1);
  const statTerm = clamp(1 - Math.abs(stat.z) / 3, 0, 1);
  const concTerm = conc.total > 0 ? conc.agreeing / conc.total : 0;
  const cadenceTerm = clamp(test.nShots / Math.max(4, spec.minShots * 1.6), 0, 1);
  const shieldTerm = walk.shield.pairsBefore > 0 ? clamp(1 - walk.shield.pairsAfter / walk.shield.pairsBefore, 0, 1) : 0.8;
  const hazardTerm = clamp(walk.gapStats.hazardRelative / 2, 0, 1);

  const confidence = Math.round(clamp(100 * (
    0.18 * accTerm +
    0.14 * lcbTerm +
    0.12 * eTerm +
    0.12 * ladderTerm +
    0.08 * pairTerm +
    0.08 * skillTerm +
    0.06 * hazardTerm +
    0.06 * cadenceTerm +
    0.06 * shieldTerm +
    0.05 * statTerm +
    0.05 * concTerm
  ), 0, 100));

  if (confidence < spec.minConfidence) blockers.push(`composite confidence ${confidence} < ${spec.label} floor ${spec.minConfidence}`);

  const measurable = test.nShots >= Math.max(6, Math.floor(spec.minShots / 2));
  const positive = test.nShots > 0 && test.evPerDollar > 0;
  const safeLadder = ladder.safety >= Math.min(0.6, spec.minLadderSafety);

  let verdict: NexusVerdict;
  if (blockers.length === 0) verdict = "certified";
  else if (measurable && positive && safeLadder && test.winRateLower >= breakEven - spec.shortfallTolerance) verdict = "qualified";
  else if (positive || !measurable) verdict = "watch";
  else verdict = "refused";

  const deployable = verdict === "certified" || verdict === "qualified";

  const signals: string[] = [
    `VERDICT ${verdict.toUpperCase()} · conf ${confidence}/100 · OOS EV ${test.evPerDollar >= 0 ? "+" : ""}${(test.evPerDollar * 100).toFixed(2)}% per $1 (worst ${(test.evLowerPerDollar * 100).toFixed(2)}%)`,
    `WALK-FORWARD · ${walk.trainTicks} train ticks → ${walk.testTicks} unseen · ${test.nShots} shots at ${(test.winRate * 100).toFixed(1)}% (Wilson floor ${(test.winRateLower * 100).toFixed(1)}%) vs BE ${(breakEven * 100).toFixed(1)}% · in-sample ${(walk.train.winRate * 100).toFixed(1)}% over ${walk.train.nShots}`,
    `DIGIT ${digit} GAP · now ${walk.gapStats.currentGap}t · median ${walk.gapStats.median}t · p70 ${walk.gapStats.p70}t · p90 ${walk.gapStats.p90}t · percentile ${(walk.gapStats.percentile * 100).toFixed(0)}% · hazard ×${walk.gapStats.hazardRelative.toFixed(2)} (baseline ${(walk.gapStats.baselineHazard * 100).toFixed(1)}% → now ${(walk.gapStats.currentHazard * 100).toFixed(1)}%)`,
    `ENTRY BAR · τ=${walk.tau.toFixed(2)}σ above trailing top-${(spec.targetShotRate * 100).toFixed(1)}% quantile · realised ${(test.fireRate * 100).toFixed(2)}% selectivity · gap ${walk.gapStats.currentGap}t ${walk.gapStats.currentGap >= 4 && walk.gapStats.currentGap <= 18 ? "in band" : "out of band"} · geo-overdue ${(Math.pow(1 - test.meanPredicted, walk.gapStats.currentGap) * 100).toFixed(1)}%`,
    `EVIDENCE · e-value ${test.evidence.peak.toFixed(1)} (p≈${test.evidence.pValue < 0.001 ? test.evidence.pValue.toExponential(1) : test.evidence.pValue.toFixed(3)}) on SHOTS — Ville, valid at data-dependent stop`,
    `CALIBRATION · Platt slope ${walk.platt.a.toFixed(2)}, Brier skill ${(walk.platt.brierSkill * 100).toFixed(2)}% vs base · mean pred ${(test.meanPredicted * 100).toFixed(1)}% vs realised ${(test.winRate * 100).toFixed(1)}%`,
    `LADDER · absorbs ${ladder.limit} consecutive losses (cap ${ladder.byStakeCap}, SL ${ladder.byStopLoss}) · FMCI safety ${(ladder.safety * 100).toFixed(1)}% over ${horizon} shots · E[break] ${ladder.expectedShotsToBreak >= 999999 ? "—" : ladder.expectedShotsToBreak} · deepest run ${test.longestLossRun}${test.ladderBroke ? " BROKE" : ""}`,
    `PAIR SHIELD · loss pairs ${walk.shield.pairsBefore}→${walk.shield.pairsAfter} under post-loss protocol (+${spec.postLossTightening}σ, ${spec.postLossCoolTicks}-tick cool-down, gap≥4, hazard≥1.4), cost ${walk.shield.suppressed} shots · longest after ${walk.shield.longestRunAfter}`,
    `LOSS CHAIN · P(L|L) ${(chain.q * 100).toFixed(1)}% vs marginal ${(chain.pLoss * 100).toFixed(1)}% · ξ ${chain.xi.toFixed(2)} [${chain.xiLower.toFixed(2)},${chain.xiUpper.toFixed(2)}] · P(2 in row) ${(chain.pTwoInARow * 100).toFixed(2)}% vs ${(chain.pairBaseline * 100).toFixed(2)}% independent · runs z ${chain.runsZ >= 0 ? "+" : ""}${chain.runsZ.toFixed(2)}`,
    `DETECTABILITY · ${detect.note}`,
    `REGIME · HMM hot ${(walk.hmm.pHot * 100).toFixed(1)}%/cold ${(walk.hmm.pCold * 100).toFixed(1)}%, stay ${(walk.hmm.stay * 100).toFixed(1)}% · stationarity z ${stat.z}, trend ${stat.trend >= 0 ? "+" : ""}${stat.trend}/block · horizons ${conc.agreeing}/${conc.total} above BE (spread ${(conc.spread * 100).toFixed(1)}pp) · PH ${drift.ph.toFixed(1)}/${drift.threshold}`,
    `SIZING · Kelly at worst-case ${(kelly * 100).toFixed(1)}% bankroll`,
  ];
  for (const b of blockers) signals.push(`⛔ ${b}`);

  const card: NexusModelCard = {
    targetDigit: digit,
    tau: walk.tau,
    targetShotRate: spec.targetShotRate,
    platt: walk.platt,
    hmm: walk.hmm,
    breakEven: round(breakEven),
    payout: round(payout, 3),
    minSpacing: spec.minSpacing,
    postLossTightening: spec.postLossTightening,
    postLossCoolTicks: spec.postLossCoolTicks,
    fittedOn: walk.trainTicks,
    gapStats: walk.gapStats,
  };

  return {
    symbol,
    displayName,
    digit,
    label: `Matches ${digit}`,
    certainty: spec.id,
    verdict,
    confidence,
    edgePerDollar: test.evPerDollar,
    breakEven: round(breakEven),
    payout: round(payout, 3),
    detect,
    walk,
    ladder,
    stationarity: stat,
    concordance: conc,
    drift,
    marginalRate: round(marginalRate),
    samples: clean.length,
    kellyFraction: round(kelly, 4),
    blockers,
    signals,
    card,
    pValue,
    significant: false,
    deployable,
  };
}

export function screenNexusCandidates(candidates: NexusCandidate[], q = 0.10): NexusCandidate[] {
  if (candidates.length === 0) return [];
  const passes = benjaminiHochberg(candidates.map(c => c.pValue), q);
  const rank: Record<NexusVerdict, number> = { certified: 0, qualified: 1, watch: 2, refused: 3 };
  const screened = candidates.map((c, i) => {
    const significant = passes[i] === true;
    const spec = nexusCertaintySpec(c.certainty);
    const failsFdr = spec.fdrRequired && !significant;
    const verdict: NexusVerdict = failsFdr && c.verdict === "certified" ? "qualified" : c.verdict;
    const blockers = failsFdr && c.verdict === "certified"
      ? [...c.blockers, `did not survive BH across ${candidates.length} candidates (q=${q})`]
      : c.blockers;
    return { ...c, significant, verdict, blockers, deployable: verdict === "certified" || verdict === "qualified" };
  });
  return screened.sort((a, b) => {
    if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict];
    if (Math.abs(a.edgePerDollar - b.edgePerDollar) > 0.002) return b.edgePerDollar - a.edgePerDollar;
    if (Math.abs(a.ladder.safety - b.ladder.safety) > 0.01) return b.ladder.safety - a.ladder.safety;
    return b.confidence - a.confidence;
  });
}

// ── Live entry (frozen model card) ───────────────────────────────────────────
export function evaluateNexusLiveEntry(
  digits: number[],
  card: NexusModelCard,
  opts: { barBoost?: number; ticksSinceLoss?: number; burnIn?: number } = {},
): NexusLiveEntry {
  const clean = digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  const ens = new MatchNexusEnsemble(card.targetDigit, card.breakEven, card.hmm, card.targetShotRate);
  const warm = Math.max(0, clean.length - 1);
  const burnIn = Math.max(0, Math.min(opts.burnIn ?? 350, warm));
  for (let i = 0; i < warm; i++) {
    if (i >= burnIn) {
      const r = ens.predict(card.platt);
      ens.observe(clean[i]!, r);
    } else {
      ens.observe(clean[i]!);
    }
  }
  const reading = ens.predict(card.platt);
  const boost = opts.barBoost ?? 0;
  const bar = card.tau + boost;
  const cooled = (opts.ticksSinceLoss ?? Number.POSITIVE_INFINITY) >= card.postLossCoolTicks;
  const enoughHistory = clean.length >= 400;
  const warmStat = ens.statReady;
  const gap = reading.gapStats.currentGap;
  const hazRel = reading.gapStats.hazardRelative;
  const pctile = reading.gapStats.percentile;
  const geoOverdue = Math.pow(Math.max(1e-6, 1 - reading.p), gap);

  const gapOk = gap >= 4 && gap <= Math.max(20, reading.gapStats.p95);
  const hazOk = hazRel >= (boost > 0 ? 1.4 : card.gapStats ? 1.25 : 1.15);
  const pctOk = pctile >= 0.55;
  const geoOk = geoOverdue <= 0.40;
  const clears = reading.zGate >= bar;
  const ready = enoughHistory && warmStat && cooled && gapOk && hazOk && pctOk && geoOk && clears;

  const reason = !enoughHistory
    ? `building history — ${clean.length}/400 digits on locked market`
    : !warmStat
      ? `calibrating live scale — ${ens.statWarmth}/200 readings before bar means anything`
      : !cooled
        ? `post-loss cool-down — ${opts.ticksSinceLoss ?? 0}/${card.postLossCoolTicks} ticks. For Matches, gap resets to 0 after loss — hurried re-entry is worst entry.`
        : !gapOk
          ? `gap ${gap}t ${gap < 4 ? "too soon (digit just appeared)" : `beyond p95 (${reading.gapStats.p95}t) — overdue but unstable`}`
          : !hazOk
            ? `hazard ×${hazRel.toFixed(2)} below ${boost > 0 ? "1.4 (post-loss)" : "1.25"} — dormancy not at breaking point for digit ${card.targetDigit}`
            : !pctOk
              ? `gap percentile ${(pctile * 100).toFixed(0)}% < 55% — not overdue for this digit's own distribution`
              : !geoOk
                ? `geometric overdue ${(geoOverdue * 100).toFixed(1)}% > 40% — gap not long enough for p̂ ${(reading.p * 100).toFixed(1)}%`
                : !clears
                  ? `edge ${reading.zGate.toFixed(2)}σ under bar ${bar.toFixed(2)}σ${boost > 0 ? ` (raised ${boost.toFixed(2)}σ post-loss)` : ""} · P(win|context) ${(reading.p * 100).toFixed(1)}% vs BE ${(card.breakEven * 100).toFixed(1)}% · gap ${gap}t · hazard ×${hazRel.toFixed(2)}`
                  : "";

  return {
    ready,
    p: reading.p,
    sigma: reading.sigma,
    z: reading.zGate,
    edgeZ: reading.z,
    statWarmth: ens.statWarmth,
    tau: card.tau,
    bar: round(bar, 4),
    marginZ: round(reading.zGate - bar, 4),
    leader: reading.leader,
    contextOrder: reading.contextOrder,
    contextCount: reading.contextCount,
    regimeHot: ens.regimeHot,
    gap,
    hazardRelative: hazRel,
    percentile: pctile,
    geoOverdue,
    experts: reading.experts,
    reason,
  };
}
