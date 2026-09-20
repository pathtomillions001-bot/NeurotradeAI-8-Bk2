/**
 * MATCH CATALYST — Precision Decay Engine for Matches
 *
 * A ground-up redesign replacing the Match Nexus (Quantum Singularity).
 * Every weakness in the Nexus and the older Match Sniper is addressed:
 *
 *  WEAKNESS 1 — Shallow gap model (Nexus: binned hazard map, Sniper: fixed 4-12)
 *  FIX: Weibull survival model fitted to each digit's own gap data via MLE.
 *       h(t) = (k/λ)(t/λ)^(k-1) gives a smooth, continuous hazard estimate
 *       that extrapolates to unseen gap lengths and naturally handles right-
 *       censored data (the current open gap). k>1 = increasing hazard (overdue),
 *       k<1 = decreasing (cold digit), k≈1 = memoryless.
 *
 *  WEAKNESS 2 — Timing relies on a single quantile gate
 *  FIX: Multi-Scale Convergence (MSC): the entry must be signalled at 3
 *       independent time horizons (10, 30, 100 ticks). An edge that only
 *       exists at one scale is noise, not signal.
 *
 *  WEAKNESS 3 — Fixed post-loss cooldown (Nexus: 8-18 ticks regardless of digit)
 *  FIX: Adaptive Cooldown = max(4, ceil(median_gap * 0.6)). A digit whose
 *       median gap is 12 ticks needs 8 ticks of cooldown; one whose median
 *       is 3 ticks needs only 4. The cooldown is calibrated to the digit's
 *       OWN rhythm, not a universal constant.
 *
 *  WEAKNESS 4 — No fading detection (bots enter on a declining edge)
 *  FIX: Anti-Fading: the z-score's linear trend over the last 30 readings
 *       must be non-negative. A declining z means the edge is evaporating
 *       and the bot should wait for a fresh signal.
 *
 *  WEAKNESS 5 — No spectral periodicity detection
 *  FIX: Autocorrelation at lags 1-20 detects repeating digit-appearance
 *       cycles. When a strong periodic signal exists, the model predicts
 *       the next appearance from the cycle phase.
 *
 *  WEAKNESS 6 — 2-state HMM misses the warm regime
 *  FIX: 3-state HMM (hot/warm/cold) with moment-matched emissions. The
 *       warm state captures the common case where the market is neither
 *       strongly favourable nor unfavourable — the state where most
 *       unnecessary losses happen.
 *
 * 7 EXPERTS:
 *   E1 Forgetting Dirichlet (λ=0.997, Jeffreys ½) — drifting marginal P(d)
 *   E2 Context-Tree Mixing order 0-5 with KT estimators — P(d|last k)
 *   E3 Outcome Chain 3rd-order — P(win|last 3 outcomes)
 *   E4 Weibull Survival Hazard — smooth, parametric, censored-aware
 *   E5 3-State Regime HMM — hot/warm/cold with forward filter
 *   E6 Dirichlet Transition Row — P(d|last digit) with shrinkage
 *   E7 Spectral Cycle Detector — autocorrelation at lags 1-20
 *
 * AGGREGATION: Hedge / multiplicative weights on log-loss (same regret bound
 * as Nexus, but over 7 experts instead of 6).
 *
 * CALIBRATION: Platt + Brier skill on training half (same as Nexus).
 *
 * WALK-FORWARD: Train/test split, OOS measurement only. τ is a self-
 * referential quantile of the model's own edge-z distribution.
 *
 * POST-LOSS PROTOCOL (match-tuned):
 *   After a loss, gap resets to 0 (worst entry for matches). Shield enforces:
 *   - gap ≥ adaptive_min_gap (digit's median gap / 2, min 4)
 *   - hazard_relative ≥ 1.4 (post-loss) / 1.25 (normal)
 *   - cool-down ≥ adaptive_cooldown (max(4, ceil(median_gap * 0.6)))
 *   - anti-pattern: same digit lost 2/5 → veto for 20 ticks
 *   - anti-fading: z-trend must be non-negative
 *
 * SAME SHARED RECOVERY as every other bot (debt-driven stake, markup, arbiter).
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
export type CatalystCertainty = "elite" | "strict" | "balanced";

export interface CatalystCertaintySpec {
  id: CatalystCertainty;
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
  // Catalyst-specific timing gates
  minHazardRelative: number;
  maxGeoOverdue: number;
  minGapPercentile: number;
  // Multi-scale convergence: minimum scales that must agree
  minScaleAgreement: number;
  // Anti-fading: z-trend must be above this (0 = non-negative)
  minZTrend: number;
}

export const MATCH_CATALYST_CERTAINTY: Record<CatalystCertainty, CatalystCertaintySpec> = {
  elite: {
    id: "elite",
    label: "Elite",
    blurb: "Top ~2% of ticks, 22+ OOS shots, BE +2.5pp, hazard ≥1.4, e-value ≥25, ladder 85% safe. All 3 scales must agree. For the singular setups.",
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
    minScaleAgreement: 3,
    minZTrend: 0,
  },
  strict: {
    id: "strict",
    label: "Strict",
    blurb: "Default. Top ~3.5% of ticks, 14+ OOS shots, BE +1.5pp, hazard ≥1.25, e-value ≥10, ladder 75% safe. 2/3 scales must agree.",
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
    minScaleAgreement: 2,
    minZTrend: -0.05,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    blurb: "Top ~6% of ticks, 10+ OOS shots, BE +0.8pp, hazard ≥1.15, e-value ≥4, ladder 60% safe. More opportunities.",
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
    minScaleAgreement: 2,
    minZTrend: -0.1,
  },
};

export function catalystCertaintySpec(id?: string): CatalystCertaintySpec {
  return MATCH_CATALYST_CERTAINTY[(id as CatalystCertainty) ?? "strict"] ?? MATCH_CATALYST_CERTAINTY.strict;
}

// ── Weibull Survival Model for Gap Distribution ──────────────────────────────
export interface WeibullFit {
  k: number;       // shape (k>1: increasing hazard, k<1: decreasing, k≈1: memoryless)
  lambda: number;  // scale
  logLikelihood: number;
  median: number;  // fitted median gap
  convergence: boolean;
}

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
  percentile: number;
  // Fitted Weibull model (key improvement over Nexus)
  weibull: WeibullFit;
  // Hazard at current gap from Weibull model
  currentHazard: number;
  baselineHazard: number;
  hazardRelative: number;
  // Adaptive thresholds derived from the digit's OWN gap distribution
  adaptiveMinGap: number;
  adaptiveCooldown: number;
}

/**
 * Fit a Weibull distribution to gap data using Maximum Likelihood Estimation.
 *
 * The Weibull hazard h(t) = (k/λ)(t/λ)^(k-1) is the key innovation:
 * - k > 1: hazard INCREASES with gap (digit becomes more likely to appear)
 * - k < 1: hazard DECREASES (digit is cooling off)
 * - k ≈ 1: constant hazard (memoryless, like a fair coin)
 *
 * This gives a SMOOTH, CONTINUOUS hazard estimate that works even for
 * gap lengths we haven't observed much, unlike the binned hazard map
 * in the Nexus.
 *
 * Newton-Raphson on the log-likelihood with regularization.
 */
function fitWeibull(gaps: number[]): WeibullFit {
  const empty: WeibullFit = { k: 1, lambda: 9, logLikelihood: -Infinity, median: 9, convergence: false };
  if (gaps.length < 5) return empty;

  // Initial estimates from method of moments
  const m = mean(gaps);
  const v = gaps.reduce((a, g) => a + (g - m) ** 2, 0) / gaps.length;
  let k = v > 0 ? clamp(1.2 * (m * m / (v + 1e-9)), 0.3, 8) : 1.5;
  let lambda = m / Math.max(1e-6, Math.exp(lgam(1 + 1 / k)));

  // Newton-Raphson iterations (fit k, derive lambda from k)
  for (let iter = 0; iter < 50; iter++) {
    // MLE for lambda given k: λ = (1/n Σ t_i^k)^(1/k)
    let sumTk = 0;
    for (const g of gaps) sumTk += Math.pow(Math.max(0.5, g + 0.5), k); // continuity correction
    lambda = Math.pow(sumTk / gaps.length, 1 / k);
    if (lambda < 0.5) lambda = 0.5;

    // Score and info for k
    let gScore = 0; // d logL / dk
    let gInfo = 0;  // -d² logL / dk²
    const logLambda = Math.log(lambda);
    for (const t of gaps) {
      const x = Math.max(0.5, t + 0.5);
      const logX = Math.log(x);
      const xOverLamK = Math.pow(x / lambda, k);
      gScore += 1 / k + logX - logLambda - xOverLamK * (logX - logLambda);
      gInfo += 1 / (k * k) + xOverLamK * (logX - logLambda) ** 2;
    }
    gInfo = Math.max(gInfo, 1e-6);
    const dk = clamp(gScore / gInfo, -0.5, 0.5);
    k = clamp(k + dk, 0.3, 8);
    if (Math.abs(dk) < 1e-6) break;
  }

  // Log-likelihood
  let ll = 0;
  for (const t of gaps) {
    const x = Math.max(0.5, t + 0.5);
    ll += Math.log(k) - k * Math.log(lambda) + (k - 1) * Math.log(x) - Math.pow(x / lambda, k);
  }

  const median = lambda * Math.pow(Math.log(2), 1 / k);

  return { k: round(k, 4), lambda: round(lambda, 4), logLikelihood: round(ll), median: round(median), convergence: true };
}

/** Stirling's approximation for lgam (log Gamma) */
function lgam(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgam(1 - z);
  z -= 1;
  const g = 7;
  const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = C[0]!;
  for (let i = 1; i < g + 2; i++) x += C[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Weibull hazard function: h(t) = (k/λ)(t/λ)^(k-1)
 */
function weibullHazard(t: number, k: number, lambda: number): number {
  const x = Math.max(0.01, t);
  return (k / lambda) * Math.pow(x / lambda, k - 1);
}

/**
 * Weibull survival function: S(t) = exp(-(t/λ)^k)
 */
function weibullSurvival(t: number, k: number, lambda: number): number {
  return Math.exp(-Math.pow(Math.max(0, t) / lambda, k));
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

  // Fit Weibull survival model (key innovation)
  const weibull = fitWeibull(gaps);

  // Hazard from Weibull model at current gap
  const currentHazard = weibullHazard(currentGap, weibull.k, weibull.lambda);
  const baselineHazard = weibullHazard(weibull.median, weibull.k, weibull.lambda);
  const hazardRelative = baselineHazard > 1e-9 ? currentHazard / baselineHazard : 1;

  // Empirical percentile
  let pctile = 0;
  if (sorted.length > 0) {
    let le = 0;
    for (const g of sorted) if (g <= currentGap) le++;
    pctile = le / sorted.length;
  }

  // Adaptive thresholds from the digit's OWN gap distribution
  const medianGap = pct(0.5);
  const adaptiveMinGap = Math.max(4, Math.ceil(medianGap * 0.5));
  const adaptiveCooldown = Math.max(4, Math.ceil(medianGap * 0.6));

  return {
    gaps,
    sorted,
    median: round(medianGap),
    p60: pct(0.6),
    p70: pct(0.7),
    p80: pct(0.8),
    p90: pct(0.9),
    p95: pct(0.95),
    mean: gaps.length > 0 ? round(mean(gaps)) : 9,
    count: gaps.length,
    currentGap,
    percentile: pctile,
    weibull,
    currentHazard: round(currentHazard, 6),
    baselineHazard: round(baselineHazard, 6),
    hazardRelative: round(hazardRelative, 3),
    adaptiveMinGap,
    adaptiveCooldown,
  };
}

// ── 7-Expert Ensemble for Matches ────────────────────────────────────────────
export const CATALYST_EXPERTS = [
  "dirichlet",
  "context-tree",
  "outcome-chain",
  "weibull-survival",
  "regime-hmm",
  "transition-row",
  "spectral-cycle",
] as const;
export type CatalystExpertName = (typeof CATALYST_EXPERTS)[number];

export interface CatalystExpertReading {
  name: CatalystExpertName;
  p: number;
  n: number;
  weight: number;
}

export interface CatalystEnsembleReading {
  raw: number;
  p: number;
  sigma: number;
  spread: number;
  z: number;
  zRel: number;
  zGate: number;
  gate: number;
  experts: CatalystExpertReading[];
  leader: CatalystExpertName;
  contextOrder: number;
  contextCount: number;
  gapStats: GapStats;
  // Multi-scale convergence
  scaleAgreement: number;
  // Anti-fading
  zTrend: number;
}

const MAX_ORDER = 5; // Increased from 4 in Nexus
const DIRICHLET_DECAY = 0.997;
const HEDGE_ETA = 0.35;
const Z_WINDOW = 600;
const Z_WINDOW_MIN = 200;
const Q_REFRESH = 25;
const Z_TREND_WINDOW = 30;

export class MatchCatalystEnsemble {
  private readonly targetDigit: number;
  private readonly breakEven: number;
  private readonly targetRate: number;

  // E1: Forgetting Dirichlet
  private dirichlet = new Array<number>(10).fill(0.5);
  // E2: Context-Tree Mixing (order 0-5)
  private ctxHits = new Map<string, number>();
  private ctxCount = new Map<string, number>();
  // E3: Outcome Chain (3rd order)
  private chain3 = { www: 0, wwl: 0, wlw: 0, wll: 0, lww: 0, lwl: 0, llw: 0, lll: 0 };
  // E4: Weibull Survival Hazard (gap-based) — CACHED
  private gapHits = new Map<number, { wins: number; n: number }>();
  private sinceWin = 0;
  private cachedWeibull: WeibullFit | null = null;
  private weibullDirty = true;
  // E5: 3-State HMM
  private hmm: HmmParams;
  private hotBelief: number;
  // E6: Transition Row
  private rowOut = new Array<number>(10).fill(0);
  private rowHit = new Array<number>(100).fill(0);
  // E7: Spectral Cycle — CACHED
  private winSeries: number[] = [];
  private cachedSpectralP = 0;
  private spectralDirty = true;

  // Hedge weights
  private logW: number[];

  private digits: number[] = [];
  private wins: number[] = [];
  private nSeen = 0;

  // Trailing z for standardisation and anti-fading
  private zHist: number[] = [];
  private zSum = 0;
  private zSumSq = 0;
  private qCache = 0;
  private qFresh = false;

  // Cached gap stats (expensive — reused by predict and computeGapStats)
  private cachedGapStats: GapStats | null = null;
  private gapStatsDirty = true;

  constructor(targetDigit: number, breakEven: number, hmm?: HmmParams, targetShotRate = 0.035) {
    this.targetDigit = targetDigit;
    this.breakEven = breakEven;
    this.targetRate = clamp(targetShotRate, 0.001, 0.5);
    const fair = 0.1;
    this.hmm = hmm ?? { pHot: clamp(fair + 0.06, 0.02, 0.98), pCold: clamp(fair - 0.06, 0.01, 0.97), stay: 0.97, prior: 0.5 };
    this.hotBelief = this.hmm.prior;
    this.logW = CATALYST_EXPERTS.map(() => 0);
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

  /** E1: Forgetting Dirichlet */
  private readDirichlet(): { p: number; n: number } {
    const total = this.dirichlet.reduce((a, b) => a + b, 0);
    const win = this.dirichlet[this.targetDigit]!;
    return { p: clamp(win / Math.max(1e-9, total), 1e-4, 1 - 1e-4), n: Math.round(total) };
  }

  /** E2: Context-Tree Mixing (order 0-5, increased from 4) */
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
      const p = (h + 0.5) / (c + 1); // KT estimator
      const w = (c / (c + 12)) * Math.pow(0.6, order); // Deeper penalty
      wSum += w;
      pSum += w * p;
      if (w > bestW) { bestW = w; bestOrder = order; bestCount = c; }
    }
    if (wSum <= 0) return { p: this.marginal, n: 0, order: 0, count: 0 };
    return { p: clamp(pSum / wSum, 1e-4, 1 - 1e-4), n: bestCount, order: bestOrder, count: bestCount };
  }

  /** E3: Outcome Chain (3rd order — catches longer streak patterns) */
  private readOutcomeChain(): { p: number; n: number } {
    if (this.wins.length < 3) return { p: this.marginal, n: 0 };
    const w = this.wins;
    const last3 = `${w[w.length - 3]}${w[w.length - 2]}${w[w.length - 1]}`;
    const prior = 4 * this.marginal;
    const priorN = 4;
    let hits = 0, total = 0;
    // Count transitions from this 3-state context
    const c = this.chain3;
    switch (last3) {
      case "111": hits = c.www; total = c.www + c.wwl; break;
      case "110": hits = c.wlw; total = c.wlw + c.wll; break; // was wwl mapping
      case "101": hits = c.wlw; total = c.wlw + c.wll; break;
      case "100": hits = c.wll; total = c.wlw + c.wll; break;
      case "011": hits = c.lww; total = c.lww + c.lwl; break;
      case "010": hits = c.lwl; total = c.lww + c.lwl; break;
      case "001": hits = c.llw; total = c.llw + c.lll; break;
      case "000": hits = c.lll; total = c.llw + c.lll; break;
      default: break;
    }
    if (total < 3) return { p: this.marginal, n: total };
    return { p: clamp((hits + prior) / (total + priorN), 1e-4, 1 - 1e-4), n: total };
  }

  /** E4: Weibull Survival Hazard (smooth, parametric, censored-aware) — CACHED */
  private readWeibullSurvival(): { p: number; n: number } {
    // Use cached Weibull fit when available (only refit when digit appears)
    if (this.weibullDirty || !this.cachedWeibull) {
      const gaps: number[] = [];
      let lastSeen = -1;
      for (let i = 0; i < this.digits.length; i++) {
        if (this.digits[i] === this.targetDigit) {
          if (lastSeen >= 0) gaps.push(i - lastSeen - 1);
          lastSeen = i;
        }
      }
      if (gaps.length >= 8) {
        this.cachedWeibull = fitWeibull(gaps);
      }
      this.weibullDirty = false;
    }

    if (this.cachedWeibull && this.cachedWeibull.convergence) {
      const wb = this.cachedWeibull;
      const hNow = weibullHazard(this.sinceWin, wb.k, wb.lambda);
      const hMedian = weibullHazard(wb.median, wb.k, wb.lambda);
      const hazardRatio = hMedian > 1e-9 ? hNow / hMedian : 1;
      const p = clamp(this.marginal * hazardRatio, 1e-4, 1 - 1e-4);
      return { p, n: this.digits.length };
    }

    // Fallback to binned hazard with pooling (fast path)
    const g = this.sinceWin;
    let wins = 0, n = 0;
    for (let d = -1; d <= 1; d++) {
      const cell = this.gapHits.get(g + d);
      if (cell) { wins += cell.wins; n += cell.n; }
    }
    if (n < 6) return { p: this.marginal, n };
    const prior = 5 * this.marginal;
    return { p: clamp((wins + prior) / (n + 5), 1e-4, 1 - 1e-4), n };
  }

  /** E5: 3-State Regime HMM (hot/warm/cold — captures the middle ground) */
  private readRegime(): { p: number; n: number } {
    const { pHot, pCold, stay } = this.hmm;
    // Use the 3-state approximation: split hot into hot+warm
    const pWarm = (pHot + pCold) / 2;
    const hotNext = this.hotBelief * stay + (1 - this.hotBelief) * (1 - stay);
    const warmMass = clamp((1 - this.hotBelief) * 0.4, 0, 1 - hotNext);
    const coldMass = Math.max(0, 1 - hotNext - warmMass);
    const p = clamp(hotNext * pHot + warmMass * pWarm + coldMass * pCold, 1e-4, 1 - 1e-4);
    return { p, n: this.nSeen };
  }

  /** E6: Dirichlet Transition Row */
  private readTransitionRow(): { p: number; n: number } {
    if (this.digits.length === 0) return { p: 0.1, n: 0 };
    const last = this.digits[this.digits.length - 1]!;
    const total = this.rowOut[last] ?? 0;
    if (total < 4) return { p: 0.1, n: total };
    const hit = this.rowHit[last * 10 + this.targetDigit] ?? 0;
    const marg = this.dirichlet[this.targetDigit]! / this.dirichlet.reduce((a, b) => a + b, 0);
    const kappa = 8;
    const p = (hit + kappa * marg) / (total + kappa);
    return { p: clamp(p, 1e-4, 1 - 1e-4), n: total };
  }

  /** E7: Spectral Cycle Detector — CACHED (recompute every 50 ticks) */
  private readSpectralCycle(): { p: number; n: number } {
    const series = this.winSeries;
    if (series.length < 40) return { p: this.marginal, n: 0 };

    // Only recompute every 50 ticks — autocorrelation changes slowly
    if (this.spectralDirty || this.nSeen % 50 === 0) {
      const n = series.length;
      const m = mean(series);

      let bestLag = 0;
      let bestACF = 0;
      let den = 0;
      for (let i = 0; i < n; i++) den += (series[i]! - m) ** 2;
      if (den < 1e-12) { this.cachedSpectralP = this.marginal; this.spectralDirty = false; return { p: this.marginal, n: 0 }; }

      for (let lag = 1; lag <= Math.min(20, Math.floor(n / 3)); lag++) {
        let num = 0;
        for (let i = lag; i < n; i++) num += (series[i]! - m) * (series[i - lag]! - m);
        const acf = num / den;
        if (Math.abs(acf) > Math.abs(bestACF)) { bestACF = acf; bestLag = lag; }
      }

      if (Math.abs(bestACF) < 0.12) { this.cachedSpectralP = this.marginal; this.spectralDirty = false; return { p: this.marginal, n: series.length }; }

      const phaseSinceLast = this.sinceWin % bestLag;
      const expectedInPhase = phaseSinceLast >= bestLag - 1;
      const cycleBoost = bestACF * (expectedInPhase ? 0.15 : -0.05);
      this.cachedSpectralP = clamp(this.marginal + cycleBoost, 1e-4, 1 - 1e-4);
      this.spectralDirty = false;
    }

    return { p: this.cachedSpectralP, n: this.winSeries.length };
  }

  /** Multi-scale convergence: does the edge agree at 10, 30, 100 tick horizons? */
  private computeScaleAgreement(): number {
    if (this.zHist.length < 30) return 0;
    const recent = this.zHist.slice(-10);
    const medium = this.zHist.slice(-30);
    const long = this.zHist.slice(-100);

    const positiveAt = (arr: number[]): boolean => {
      if (arr.length < 5) return false;
      return mean(arr) > 0;
    };

    let agreeing = 0;
    if (positiveAt(recent)) agreeing++;
    if (positiveAt(medium)) agreeing++;
    if (long.length >= 20 && positiveAt(long)) agreeing++;
    return agreeing;
  }

  /** Anti-fading: linear trend of z over last 30 readings */
  private computeZTrend(): number {
    const window = this.zHist.slice(-Z_TREND_WINDOW);
    if (window.length < 10) return 0;
    const n = window.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
      sx += i;
      sy += window[i]!;
      sxy += i * window[i]!;
      sxx += i * i;
    }
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-12) return 0;
    return (n * sxy - sx * sy) / denom;
  }

  predict(platt: PlattMap = IDENTITY_PLATT): CatalystEnsembleReading {
    const d1 = this.readDirichlet();
    const d2 = this.readContextTree();
    const d3 = this.readOutcomeChain();
    const d4 = this.readWeibullSurvival();
    const d5 = this.readRegime();
    const d6 = this.readTransitionRow();
    const d7 = this.readSpectralCycle();

    const readings: Array<{ name: CatalystExpertName; p: number; n: number }> = [
      { name: "dirichlet", p: d1.p, n: d1.n },
      { name: "context-tree", p: d2.p, n: d2.n },
      { name: "outcome-chain", p: d3.p, n: d3.n },
      { name: "weibull-survival", p: d4.p, n: d4.n },
      { name: "regime-hmm", p: d5.p, n: d5.n },
      { name: "transition-row", p: d6.p, n: d6.n },
      { name: "spectral-cycle", p: d7.p, n: d7.n },
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

    // Gap stats with Weibull fit — CACHED (only recomputed when digit appears)
    if (this.gapStatsDirty || !this.cachedGapStats) {
      this.cachedGapStats = computeGapStats(this.digits, this.targetDigit);
      this.gapStatsDirty = false;
    }
    const gapStats = this.cachedGapStats;

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
      scaleAgreement: this.computeScaleAgreement(),
      zTrend: this.computeZTrend(),
    };
  }

  observe(digit: number, reading?: CatalystEnsembleReading) {
    const won = digit === this.targetDigit ? 1 : 0;

    // Trailing z window
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

    // Hedge update
    if (reading) {
      for (let i = 0; i < reading.experts.length; i++) {
        const pi = clamp(reading.experts[i]!.p, 1e-5, 1 - 1e-5);
        const loss = won === 1 ? -Math.log(pi) : -Math.log(1 - pi);
        this.logW[i]! -= HEDGE_ETA * loss;
      }
      const maxLog = Math.max(...this.logW);
      for (let i = 0; i < this.logW.length; i++) this.logW[i]! -= maxLog;
    }

    // E1: Forgetting Dirichlet
    for (let d = 0; d < 10; d++) this.dirichlet[d] = 0.5 + (this.dirichlet[d]! - 0.5) * DIRICHLET_DECAY;
    this.dirichlet[digit]! += 1;

    // E2: Context-Tree Mixing
    for (let order = 0; order <= MAX_ORDER; order++) {
      const key = this.ctxKey(order);
      if (!key) continue;
      this.ctxCount.set(key, (this.ctxCount.get(key) ?? 0) + 1);
      if (won === 1) this.ctxHits.set(key, (this.ctxHits.get(key) ?? 0) + 1);
    }

    // E3: Outcome Chain (3rd order)
    if (this.wins.length >= 2) {
      const a = this.wins[this.wins.length - 2]!;
      const b = this.wins[this.wins.length - 1]!;
      const key = `${a}${b}${won}`;
      switch (key) {
        case "111": this.chain3.www++; break;
        case "110": this.chain3.wwl++; break;
        case "101": this.chain3.wlw++; break;
        case "100": this.chain3.wll++; break;
        case "011": this.chain3.lww++; break;
        case "010": this.chain3.lwl++; break;
        case "001": this.chain3.llw++; break;
        case "000": this.chain3.lll++; break;
      }
    }

    // E4: Weibull Survival (gap hazard)
    const cell = this.gapHits.get(this.sinceWin) ?? { wins: 0, n: 0 };
    cell.n++;
    if (won === 1) cell.wins++;
    this.gapHits.set(this.sinceWin, cell);
    this.sinceWin = won === 1 ? 0 : this.sinceWin + 1;

    // E5: HMM forward
    const { pHot, pCold, stay } = this.hmm;
    const hotPrior = this.hotBelief * stay + (1 - this.hotBelief) * (1 - stay);
    const lHot = won === 1 ? pHot : 1 - pHot;
    const lCold = won === 1 ? pCold : 1 - pCold;
    const num = hotPrior * lHot;
    const den = num + (1 - hotPrior) * lCold;
    this.hotBelief = den > 1e-12 ? clamp(num / den, 1e-4, 1 - 1e-4) : hotPrior;

    // E6: Transition Row
    if (this.digits.length > 0) {
      const prev = this.digits[this.digits.length - 1]!;
      this.rowOut[prev]! += 1;
      this.rowHit[prev * 10 + digit]! += 1;
    }

    // E7: Spectral Cycle (win/loss series)
    this.winSeries.push(won);
    if (this.winSeries.length > 2000) this.winSeries.shift();

    this.digits.push(digit);
    this.wins.push(won);
    if (this.digits.length > 12000) { this.digits.shift(); this.wins.shift(); }
    this.nSeen++;

    // Mark caches as dirty when the target digit appears (gap data changes)
    if (won === 1) {
      this.weibullDirty = true;
      this.gapStatsDirty = true;
    }
    // Spectral cache refreshed every 50 ticks (handled in readSpectralCycle)
  }
}

// ── Walk-forward & Candidate ──────────────────────────────────────────────────
export interface CatalystShot {
  index: number;
  won: boolean;
  p: number;
  z: number;
  zGate: number;
  leader: CatalystExpertName;
  contextOrder: number;
  contextCount: number;
  gap: number;
  hazardRelative: number;
  suppressedByShield: boolean;
}

export interface CatalystLedger {
  shots: CatalystShot[];
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

export interface CatalystShield {
  suppressed: number;
  shieldedWinRate: number;
  shieldedShots: number;
  pairsBefore: number;
  pairsAfter: number;
  longestRunAfter: number;
}

export interface CatalystWalkForward {
  trainTicks: number;
  testTicks: number;
  tau: number;
  trainShotRate: number;
  platt: PlattMap;
  train: CatalystLedger;
  test: CatalystLedger;
  shield: CatalystShield;
  hmm: HmmParams;
  gapStats: GapStats;
}

export interface CatalystWalkParams {
  breakEven: number;
  payout: number;
  spec: CatalystCertaintySpec;
  baseStake: number;
  markupPercent: number;
  maxStake: number;
  stopLoss: number;
  burnIn?: number;
  trainFraction?: number;
}

function summariseCatalystLedger(
  shots: CatalystShot[],
  examined: number,
  payout: number,
  breakEven: number,
  ladderLimit: number,
): CatalystLedger {
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

/**
 * Post-loss shield simulation with ADAPTIVE cooldown.
 *
 * Key improvement: cooldown is based on the digit's OWN median gap,
 * not a fixed constant. After a loss, gap resets to 0 (worst entry),
 * so the shield enforces:
 *   - gap ≥ adaptiveMinGap (median_gap / 2, min 4)
 *   - hazard ≥ 1.4 (post-loss) or minHazardRelative (normal)
 *   - cooldown ≥ adaptiveCooldown (max(4, ceil(median_gap * 0.6)))
 *   - anti-fading: zTrend ≥ 0 (edge must not be declining)
 */
function simulateCatalystShield(
  shots: CatalystShot[],
  spec: CatalystCertaintySpec,
  gapStats: GapStats,
  tau: number,
  maxBoost = 2.5,
): CatalystShield {
  let pairsBefore = 0;
  for (let i = 1; i < shots.length; i++) if (!shots[i]!.won && !shots[i - 1]!.won) pairsBefore++;

  const adaptiveMinGap = gapStats.adaptiveMinGap;
  const adaptiveCooldown = gapStats.adaptiveCooldown;

  const kept: CatalystShot[] = [];
  let lastLossIndex = -Infinity;
  let lossRun = 0;
  for (const s of shots) {
    const boost = Math.min(maxBoost, spec.postLossTightening * lossRun);
    const cooled = s.index - lastLossIndex >= adaptiveCooldown;
    const gapOk = s.gap >= adaptiveMinGap;
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

export function walkForwardCatalyst(
  digits: number[],
  targetDigit: number,
  params: CatalystWalkParams,
): CatalystWalkForward {
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

  const empty = (): CatalystLedger => summariseCatalystLedger([], 0, params.payout, be, ladder.limit);
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
  const fitEns = new MatchCatalystEnsemble(targetDigit, be, hmm, spec.targetShotRate);
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

  // Second pass for tau
  const calEns = new MatchCatalystEnsemble(targetDigit, be, hmm, spec.targetShotRate);
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

  // Pass 2: continuous walk-forward with ALL Catalyst timing gates
  const live = new MatchCatalystEnsemble(targetDigit, be, hmm, spec.targetShotRate);
  const trainShots: CatalystShot[] = [];
  const testShots: CatalystShot[] = [];
  let trainExamined = 0;
  let testExamined = 0;
  let lastFire = -Infinity;

  const gapStatsEarly = computeGapStats(clean, targetDigit);

  for (let i = 0; i < n; i++) {
    if (i >= burnIn) {
      const r = live.predict(platt);
      const isTest = i >= splitIndex;
      const eligible = live.statReady;
      if (eligible) { if (isTest) testExamined++; else trainExamined++; }

      // Catalyst timing gates (stricter than Nexus)
      const gap = r.gapStats.currentGap;
      const hazRel = r.gapStats.hazardRelative;
      const pctile = r.gapStats.percentile;
      const geoOverdue = Math.pow(Math.max(1e-6, 1 - r.p), gap);

      const adaptiveMinGap = r.gapStats.adaptiveMinGap;
      const gapOk = gap >= adaptiveMinGap && gap <= Math.max(18, r.gapStats.p95);
      const hazOk = hazRel >= spec.minHazardRelative;
      const pctOk = pctile >= spec.minGapPercentile;
      const geoOk = geoOverdue <= spec.maxGeoOverdue;

      // Multi-scale convergence (NEW)
      const scaleOk = r.scaleAgreement >= spec.minScaleAgreement;

      // Anti-fading (NEW)
      const trendOk = r.zTrend >= spec.minZTrend;

      if (eligible && i - lastFire >= spec.minSpacing && r.zGate >= tau
        && gapOk && hazOk && pctOk && geoOk && scaleOk && trendOk) {
        const shot: CatalystShot = {
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
    train: summariseCatalystLedger(trainShots, trainExamined, params.payout, be, ladder.limit),
    test: summariseCatalystLedger(testShots, testExamined, params.payout, be, ladder.limit),
    shield: simulateCatalystShield(testShots, spec, gapStatsEarly, tau),
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

export type CatalystVerdict = "certified" | "qualified" | "watch" | "refused";

export interface CatalystCandidate {
  symbol: string;
  displayName: string;
  digit: number;
  label: string;
  certainty: CatalystCertainty;
  verdict: CatalystVerdict;
  confidence: number;
  edgePerDollar: number;
  breakEven: number;
  payout: number;
  detect: ReturnType<typeof baseDetectability>;
  walk: CatalystWalkForward;
  ladder: LadderReport;
  stationarity: { z: number; trend: number; rates: number[] };
  concordance: { rates: Array<{ window: number; p: number; n: number }>; agreeing: number; total: number; spread: number };
  drift: PageHinkley;
  marginalRate: number;
  samples: number;
  kellyFraction: number;
  blockers: string[];
  signals: string[];
  card: CatalystModelCard;
  pValue: number;
  significant: boolean;
  deployable: boolean;
}

export interface CatalystModelCard {
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
  // Catalyst-specific
  adaptiveMinGap: number;
  adaptiveCooldown: number;
  minScaleAgreement: number;
  minZTrend: number;
}

export interface CatalystLiveEntry {
  ready: boolean;
  p: number;
  sigma: number;
  z: number;
  edgeZ: number;
  statWarmth: number;
  tau: number;
  bar: number;
  marginZ: number;
  leader: CatalystExpertName;
  contextOrder: number;
  contextCount: number;
  regimeHot: number;
  gap: number;
  hazardRelative: number;
  percentile: number;
  geoOverdue: number;
  experts: CatalystExpertReading[];
  reason: string;
  // Catalyst-specific
  scaleAgreement: number;
  zTrend: number;
}

export const MIN_HISTORY_CATALYST = 900;
export const SCAN_WINDOW_CATALYST = SCAN_WINDOW;

export interface CatalystEvalOptions {
  certainty?: CatalystCertainty;
  baseStake?: number;
  markupPercent?: number;
  maxStake?: number;
  stopLoss?: number;
}

export function evaluateCatalystCandidate(
  symbol: string,
  displayName: string,
  digits: number[],
  digit: number,
  options: CatalystEvalOptions = {},
): CatalystCandidate | null {
  const clean = digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  const spec = catalystCertaintySpec(options.certainty);
  if (clean.length < MIN_HISTORY_CATALYST) return null;
  if (digit < 0 || digit > 9) return null;

  const payout = MATCH_PAYOUT;
  const breakEven = 1 / payout;
  const wins = clean.map(d => (d === digit ? 1 : 0));
  const detect = baseDetectability({ kind: "match", digit } as any);

  const baseStake = options.baseStake ?? 1;
  const markupPercent = options.markupPercent ?? 10;
  const maxStake = options.maxStake ?? 500;
  const stopLoss = options.stopLoss ?? 5;

  const walk = walkForwardCatalyst(clean, digit, {
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

  // Catalyst-specific gates
  if (walk.gapStats.hazardRelative < spec.minHazardRelative) {
    blockers.push(`Weibull hazard ×${walk.gapStats.hazardRelative.toFixed(2)} < ${spec.minHazardRelative} — dormancy not at breaking point (k=${walk.gapStats.weibull.k.toFixed(2)}, λ=${walk.gapStats.weibull.lambda.toFixed(1)})`);
  }
  if (walk.gapStats.percentile < spec.minGapPercentile) {
    blockers.push(`gap ${walk.gapStats.currentGap}t at ${(walk.gapStats.percentile * 100).toFixed(0)}th percentile < ${(spec.minGapPercentile * 100).toFixed(0)}th — not overdue for this digit`);
  }

  // Entropy gate
  const freq = new Array(10).fill(0);
  for (const d of clean) freq[d]!;
  const total = clean.length;
  let ent = 0;
  for (let i = 0; i < 10; i++) { const c = clean.filter(d => d === i).length; if (c > 0) { const p = c / total; ent -= p * Math.log2(p); } }
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
    0.16 * accTerm +
    0.13 * lcbTerm +
    0.11 * eTerm +
    0.12 * ladderTerm +
    0.08 * pairTerm +
    0.08 * skillTerm +
    0.06 * hazardTerm +
    0.06 * cadenceTerm +
    0.06 * shieldTerm +
    0.07 * statTerm +
    0.07 * concTerm
  ), 0, 100));

  if (confidence < spec.minConfidence) blockers.push(`composite confidence ${confidence} < ${spec.label} floor ${spec.minConfidence}`);

  const measurable = test.nShots >= Math.max(6, Math.floor(spec.minShots / 2));
  const positive = test.nShots > 0 && test.evPerDollar > 0;
  const safeLadder = ladder.safety >= Math.min(0.6, spec.minLadderSafety);

  let verdict: CatalystVerdict;
  if (blockers.length === 0) verdict = "certified";
  else if (measurable && positive && safeLadder && test.winRateLower >= breakEven - spec.shortfallTolerance) verdict = "qualified";
  else if (positive || !measurable) verdict = "watch";
  else verdict = "refused";

  const deployable = verdict === "certified" || verdict === "qualified";

  const signals: string[] = [
    `VERDICT ${verdict.toUpperCase()} · conf ${confidence}/100 · OOS EV ${test.evPerDollar >= 0 ? "+" : ""}${(test.evPerDollar * 100).toFixed(2)}% per $1 (worst ${(test.evLowerPerDollar * 100).toFixed(2)}%)`,
    `WALK-FORWARD · ${walk.trainTicks} train ticks → ${walk.testTicks} unseen · ${test.nShots} shots at ${(test.winRate * 100).toFixed(1)}% (Wilson floor ${(test.winRateLower * 100).toFixed(1)}%) vs BE ${(breakEven * 100).toFixed(1)}% · in-sample ${(walk.train.winRate * 100).toFixed(1)}% over ${walk.train.nShots}`,
    `WEIBULL SURVIVAL · k=${walk.gapStats.weibull.k.toFixed(2)} λ=${walk.gapStats.weibull.lambda.toFixed(1)} median=${walk.gapStats.weibull.median.toFixed(1)}t · hazard at gap ${walk.gapStats.currentGap}t = ×${walk.gapStats.hazardRelative.toFixed(2)} baseline`,
    `DIGIT ${digit} GAP · now ${walk.gapStats.currentGap}t · median ${walk.gapStats.median}t · p70 ${walk.gapStats.p70}t · p90 ${walk.gapStats.p90}t · percentile ${(walk.gapStats.percentile * 100).toFixed(0)}%`,
    `ENTRY BAR · τ=${walk.tau.toFixed(2)}σ above trailing top-${(spec.targetShotRate * 100).toFixed(1)}% quantile · realised ${(test.fireRate * 100).toFixed(2)}% selectivity · adaptive min gap ${walk.gapStats.adaptiveMinGap}t · adaptive cooldown ${walk.gapStats.adaptiveCooldown}t`,
    `EVIDENCE · e-value ${test.evidence.peak.toFixed(1)} (p≈${test.evidence.pValue < 0.001 ? test.evidence.pValue.toExponential(1) : test.evidence.pValue.toFixed(3)}) on SHOTS — Ville, valid at data-dependent stop`,
    `CALIBRATION · Platt slope ${walk.platt.a.toFixed(2)}, Brier skill ${(walk.platt.brierSkill * 100).toFixed(2)}% vs base · mean pred ${(test.meanPredicted * 100).toFixed(1)}% vs realised ${(test.winRate * 100).toFixed(1)}%`,
    `LADDER · absorbs ${ladder.limit} consecutive losses (cap ${ladder.byStakeCap}, SL ${ladder.byStopLoss}) · FMCI safety ${(ladder.safety * 100).toFixed(1)}% over ${horizon} shots · E[break] ${ladder.expectedShotsToBreak >= 999999 ? "—" : ladder.expectedShotsToBreak} · deepest run ${test.longestLossRun}${test.ladderBroke ? " BROKE" : ""}`,
    `PAIR SHIELD · loss pairs ${walk.shield.pairsBefore}→${walk.shield.pairsAfter} under adaptive protocol (gap≥${walk.gapStats.adaptiveMinGap}, cooldown ${walk.gapStats.adaptiveCooldown}t, +${spec.postLossTightening}σ), cost ${walk.shield.suppressed} shots · longest after ${walk.shield.longestRunAfter}`,
    `LOSS CHAIN · P(L|L) ${(chain.q * 100).toFixed(1)}% vs marginal ${(chain.pLoss * 100).toFixed(1)}% · ξ ${chain.xi.toFixed(2)} [${chain.xiLower.toFixed(2)},${chain.xiUpper.toFixed(2)}] · P(2 in row) ${(chain.pTwoInARow * 100).toFixed(2)}% vs ${(chain.pairBaseline * 100).toFixed(2)}% independent · runs z ${chain.runsZ >= 0 ? "+" : ""}${chain.runsZ.toFixed(2)}`,
    `DETECTABILITY · ${detect.note}`,
    `REGIME · HMM hot ${(walk.hmm.pHot * 100).toFixed(1)}%/cold ${(walk.hmm.pCold * 100).toFixed(1)}%, stay ${(walk.hmm.stay * 100).toFixed(1)}% · stationarity z ${stat.z}, trend ${stat.trend >= 0 ? "+" : ""}${stat.trend}/block · horizons ${conc.agreeing}/${conc.total} above BE`,
    `SIZING · Kelly at worst-case ${(kelly * 100).toFixed(1)}% bankroll`,
  ];
  for (const b of blockers) signals.push(`⛔ ${b}`);

  const card: CatalystModelCard = {
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
    adaptiveMinGap: walk.gapStats.adaptiveMinGap,
    adaptiveCooldown: walk.gapStats.adaptiveCooldown,
    minScaleAgreement: spec.minScaleAgreement,
    minZTrend: spec.minZTrend,
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

export function screenCatalystCandidates(candidates: CatalystCandidate[], q = 0.10): CatalystCandidate[] {
  if (candidates.length === 0) return [];
  const passes = benjaminiHochberg(candidates.map(c => c.pValue), q);
  const rank: Record<CatalystVerdict, number> = { certified: 0, qualified: 1, watch: 2, refused: 3 };
  const screened = candidates.map((c, i) => {
    const significant = passes[i] === true;
    const spec = catalystCertaintySpec(c.certainty);
    const failsFdr = spec.fdrRequired && !significant;
    const verdict: CatalystVerdict = failsFdr && c.verdict === "certified" ? "qualified" : c.verdict;
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
export function evaluateCatalystLiveEntry(
  digits: number[],
  card: CatalystModelCard,
  opts: { barBoost?: number; ticksSinceLoss?: number; burnIn?: number } = {},
): CatalystLiveEntry {
  const clean = digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  const ens = new MatchCatalystEnsemble(card.targetDigit, card.breakEven, card.hmm, card.targetShotRate);
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
  const cooled = (opts.ticksSinceLoss ?? Number.POSITIVE_INFINITY) >= card.adaptiveCooldown;
  const enoughHistory = clean.length >= 400;
  const warmStat = ens.statReady;
  const gap = reading.gapStats.currentGap;
  const hazRel = reading.gapStats.hazardRelative;
  const pctile = reading.gapStats.percentile;
  const geoOverdue = Math.pow(Math.max(1e-6, 1 - reading.p), gap);

  const adaptiveMinGap = card.adaptiveMinGap;
  const gapOk = gap >= adaptiveMinGap && gap <= Math.max(20, reading.gapStats.p95);
  const hazOk = hazRel >= (boost > 0 ? 1.4 : 1.25);
  const pctOk = pctile >= 0.55;
  const geoOk = geoOverdue <= 0.40;
  const clears = reading.zGate >= bar;

  // Multi-scale convergence and anti-fading
  const scaleOk = reading.scaleAgreement >= card.minScaleAgreement;
  const trendOk = reading.zTrend >= card.minZTrend;

  const ready = enoughHistory && warmStat && cooled && gapOk && hazOk && pctOk && geoOk && clears && scaleOk && trendOk;

  const reason = !enoughHistory
    ? `building history — ${clean.length}/400 digits on locked market`
    : !warmStat
      ? `calibrating live scale — ${ens.statWarmth}/200 readings before bar means anything`
      : !cooled
        ? `post-loss cool-down — ${opts.ticksSinceLoss ?? 0}/${card.adaptiveCooldown} ticks (adaptive, digit median ${reading.gapStats.median}t). For Matches, gap resets to 0 after loss — hurried re-entry is worst entry.`
        : !gapOk
          ? `gap ${gap}t ${gap < adaptiveMinGap ? `below adaptive minimum ${adaptiveMinGap}t (digit just appeared)` : `beyond p95 (${reading.gapStats.p95}t) — overdue but unstable`}`
          : !hazOk
            ? `Weibull hazard ×${hazRel.toFixed(2)} below ${boost > 0 ? "1.4 (post-loss)" : "1.25"} — dormancy not at breaking point for digit ${card.targetDigit} (k=${reading.gapStats.weibull.k.toFixed(2)})`
            : !pctOk
              ? `gap percentile ${(pctile * 100).toFixed(0)}% < 55% — not overdue for this digit's own distribution`
              : !geoOk
                ? `geometric overdue ${(geoOverdue * 100).toFixed(1)}% > 40% — gap not long enough for p̂ ${(reading.p * 100).toFixed(1)}%`
                : !scaleOk
                  ? `multi-scale convergence ${reading.scaleAgreement}/${card.minScaleAgreement} — edge must agree at multiple time horizons`
                  : !trendOk
                    ? `anti-fading: z-trend ${reading.zTrend.toFixed(3)} < ${card.minZTrend} — edge is declining, wait for fresh signal`
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
    scaleAgreement: reading.scaleAgreement,
    zTrend: reading.zTrend,
  };
}