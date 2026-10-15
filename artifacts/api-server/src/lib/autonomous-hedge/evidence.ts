/**
 * M1 — Honest probability estimates for Recovery Quality Pipeline v2.
 *
 * Evaluates candidate win probabilities across multi-horizon windows
 * [120, 500, 1500] using Donoho-Johnstone universal soft-thresholding
 * lambda = sqrt(2 * ln(M_eff)) to eliminate winner's-curse inflation across
 * markets, contract families, windows, and auto-digit searches.
 *
 * Auto-digit families (Matches auto, Differs auto) are strictly out-of-sample:
 * the digit is selected on the older 70% of each window and z is evaluated
 * exclusively on the newest 30%.
 *
 * Maintains incremental O(1)-query prefix sums per market so each tick costs
 * O(markets * specs * windows) rather than O(window).
 */

import { HEDGE_MIN_TICKS, HEDGE_V2_WINDOWS } from "./constants";
import { hedgePayout, type HedgeContractType, type HedgeFamilySpec } from "./hedge-analysis";
import { normalCdf } from "./recovery-risk";

export interface EvidenceRow {
  symbol: string;
  spec: HedgeFamilySpec;
  /** Resolved barrier (0..9 for Matches/Differs after out-of-sample selection, or spec.barrier). */
  resolvedBarrier: number;
  p0: number;
  pTilde: number;
  z: number;
  zTilde: number;
  window: number;
  nEff: number;
  q: number;
  depUsed: boolean;
  edgeIndex: number;
  /**
   * Soft-thresholded z at the LONGEST available window (see
   * `longestWindowTicks`), computed with its own out-of-sample barrier choice.
   *
   * This exists so the admissibility gate can require MULTI-WINDOW
   * CORROBORATION: a deviation that survives the multiplicity threshold only at
   * the shortest window is a transient of that window, while a genuine bias
   * survives at every horizon. Measured motivation: every residual error the
   * gate admitted on edge-free tapes was a 120-tick transient
   * (`z = 4.02 -> z~ = 0.52`, window 120) while the longest window showed
   * nothing — see docs/autonomous-recovery-improvement-plan.md section 4.1.
   *
   * When the selected window IS the longest one, these equal `z` / `zTilde`.
   */
  longestZ: number;
  longestZTilde: number;
  /** Length of the longest window actually available on this tape (120/500/1500). */
  longestWindowTicks: number;
}

export interface MarketTapeInput {
  symbol: string;
  digits: number[];
  prices: number[];
  tickSequence: number;
  specs: HedgeFamilySpec[];
  availableTicks?: number;
}

export interface EvaluateEvidenceInput {
  markets: MarketTapeInput[];
  /** Number of markets scanned (defaults to markets.length). */
  marketsScanned?: number;
  /** Number of specs in the active recovery set (defaults to max specs across markets). */
  specsInSet?: number;
  /** Optional payout resolver (e.g. M5 live quote prefetch). Falls back to canonical table payout. */
  payoutResolver?: (symbol: string, contract: HedgeContractType, barrier: number) => number;
  /** Evidence weight in [0, 1] from M7 calibration guard (1 = normal, 0 = shrunk to p0 on CUSUM alarm). */
  evidenceWeight?: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Base probability p0 for a contract family spec. */
export function baseProbabilityForSpec(spec: HedgeFamilySpec): number | null {
  switch (spec.type) {
    case "DIGITOVER":
      if (spec.barrier < 0 || spec.barrier > 8) return null;
      return (9 - spec.barrier) / 10;
    case "DIGITUNDER":
      if (spec.barrier < 1 || spec.barrier > 9) return null;
      return spec.barrier / 10;
    case "DIGITEVEN":
    case "DIGITODD":
    case "CALL":
    case "PUT":
      return 0.5;
    case "DIGITMATCH":
      return 0.1;
    case "DIGITDIFF":
      return 0.9;
    default:
      return null;
  }
}

export function isAutoDigitSpec(spec: HedgeFamilySpec): boolean {
  return (spec.type === "DIGITMATCH" || spec.type === "DIGITDIFF") && spec.barrier < 0;
}

/** Donoho-Johnstone universal threshold lambda = sqrt(2 * ln(M_eff)). */
export function universalThreshold(marketsScanned: number, specsInSet: number, autoDigit: boolean): {
  mEff: number;
  lambda: number;
} {
  const m = Math.max(1, marketsScanned);
  const s = Math.max(1, specsInSet);
  const windows = HEDGE_V2_WINDOWS.length; // 3
  const base = Math.max(3, m * s * windows);
  const mEff = autoDigit ? base * 10 : base;
  const lambda = Math.sqrt(2 * Math.log(mEff));
  return { mEff, lambda };
}

/** Soft-threshold operator: sign(z) * max(0, |z| - lambda). */
export function softThreshold(z: number, lambda: number): number {
  if (!Number.isFinite(z) || !Number.isFinite(lambda)) return 0;
  const abs = Math.abs(z);
  if (abs <= lambda) return 0;
  return z < 0 ? -(abs - lambda) : abs - lambda;
}

// ── Incremental prefix-sum buffer per market ──────────────────────────────────

const BUFFER_CAPACITY = 4096;
const COMPACT_KEEP = 1600;

interface TransitionPrefix {
  builtTo: number;
  win: Uint8Array;
  ll: Int32Array;
  lw: Int32Array;
  wl: Int32Array;
  ww: Int32Array;
}

interface MarketPrefixCache {
  symbol: string;
  lastSequence: number;
  len: number;
  digits: Int8Array;
  prices: Float64Array;
  digitPrefix: Int32Array[];
  upPrefix: Int32Array;
  downPrefix: Int32Array;
  transitions: Map<string, TransitionPrefix>;
}

function createMarketPrefixCache(symbol: string): MarketPrefixCache {
  const digitPrefix: Int32Array[] = [];
  for (let d = 0; d < 10; d++) {
    digitPrefix.push(new Int32Array(BUFFER_CAPACITY + 1));
  }
  return {
    symbol,
    lastSequence: -1,
    len: 0,
    digits: new Int8Array(BUFFER_CAPACITY),
    prices: new Float64Array(BUFFER_CAPACITY),
    digitPrefix,
    upPrefix: new Int32Array(BUFFER_CAPACITY + 1),
    downPrefix: new Int32Array(BUFFER_CAPACITY + 1),
    transitions: new Map(),
  };
}

function appendTickToCache(cache: MarketPrefixCache, digit: number, price: number): void {
  if (cache.len >= BUFFER_CAPACITY) {
    // Compact by keeping the most recent COMPACT_KEEP ticks.
    const drop = cache.len - COMPACT_KEEP;
    cache.digits.copyWithin(0, drop, cache.len);
    cache.prices.copyWithin(0, drop, cache.len);
    for (let d = 0; d < 10; d++) {
      const dp = cache.digitPrefix[d]!;
      const offset = dp[drop]!;
      for (let i = 0; i <= COMPACT_KEEP; i++) {
        dp[i] = dp[i + drop]! - offset;
      }
    }
    const upOff = cache.upPrefix[drop]!;
    const downOff = cache.downPrefix[drop]!;
    for (let i = 0; i <= COMPACT_KEEP; i++) {
      cache.upPrefix[i] = cache.upPrefix[i + drop]! - upOff;
      cache.downPrefix[i] = cache.downPrefix[i + drop]! - downOff;
    }
    cache.len = COMPACT_KEEP;
    cache.transitions.clear();
  }

  const idx = cache.len;
  cache.digits[idx] = digit;
  cache.prices[idx] = price;
  const nextIdx = idx + 1;
  for (let d = 0; d < 10; d++) {
    const dp = cache.digitPrefix[d]!;
    dp[nextIdx] = dp[idx]! + (digit === d ? 1 : 0);
  }
  if (idx === 0) {
    cache.upPrefix[nextIdx] = 0;
    cache.downPrefix[nextIdx] = 0;
  } else {
    const prevPrice = cache.prices[idx - 1]!;
    cache.upPrefix[nextIdx] = cache.upPrefix[idx]! + (price > prevPrice ? 1 : 0);
    cache.downPrefix[nextIdx] = cache.downPrefix[idx]! + (price < prevPrice ? 1 : 0);
  }
  cache.len = nextIdx;
}

function syncMarketCache(
  cache: MarketPrefixCache,
  digits: number[],
  prices: number[],
  tickSequence: number,
): void {
  const n = digits.length;
  if (n === 0) return;

  // Fast path 1: exact same tick sequence and tail already in cache
  if (
    tickSequence === cache.lastSequence &&
    cache.len >= n &&
    cache.digits[cache.len - 1] === digits[n - 1] &&
    cache.prices[cache.len - 1] === prices[n - 1]
  ) {
    return;
  }

  // Fast path 2: single new tick arrived
  if (
    cache.len >= 1 &&
    n >= 2 &&
    (tickSequence === cache.lastSequence + 1 || cache.lastSequence >= 0) &&
    cache.digits[cache.len - 1] === digits[n - 2] &&
    cache.prices[cache.len - 1] === prices[n - 2]
  ) {
    appendTickToCache(cache, digits[n - 1]!, prices[n - 1]!);
    cache.lastSequence = tickSequence;
    return;
  }

  // Fast path 3: small k-tick advance (2 <= k <= 16)
  if (cache.len >= 2 && n >= 4) {
    for (let k = 2; k <= Math.min(16, n - 1); k++) {
      if (
        cache.digits[cache.len - 1] === digits[n - 1 - k] &&
        cache.prices[cache.len - 1] === prices[n - 1 - k] &&
        cache.digits[cache.len - 2] === digits[n - 2 - k]
      ) {
        for (let j = n - k; j < n; j++) {
          appendTickToCache(cache, digits[j]!, prices[j]!);
        }
        cache.lastSequence = tickSequence;
        return;
      }
    }
  }

  // Cold rebuild (first call for this market or synthetic test fixture jump)
  cache.len = 0;
  cache.transitions.clear();
  for (let i = 0; i < n; i++) {
    appendTickToCache(cache, digits[i]!, prices[i]!);
  }
  cache.lastSequence = tickSequence;
}

function outcomeAt(
  cache: MarketPrefixCache,
  type: HedgeContractType,
  barrier: number,
  idx: number,
): number {
  const d = cache.digits[idx]!;
  switch (type) {
    case "DIGITOVER":
      return d > barrier ? 1 : 0;
    case "DIGITUNDER":
      return d < barrier ? 1 : 0;
    case "DIGITEVEN":
      return (d & 1) === 0 ? 1 : 0;
    case "DIGITODD":
      return (d & 1) === 1 ? 1 : 0;
    case "DIGITMATCH":
      return d === barrier ? 1 : 0;
    case "DIGITDIFF":
      return d !== barrier ? 1 : 0;
    case "CALL":
      return idx > 0 && cache.prices[idx]! > cache.prices[idx - 1]! ? 1 : 0;
    case "PUT":
      return idx > 0 && cache.prices[idx]! < cache.prices[idx - 1]! ? 1 : 0;
  }
}

function getTransitionPrefix(
  cache: MarketPrefixCache,
  type: HedgeContractType,
  barrier: number,
): TransitionPrefix {
  const key = `${type}:${barrier}`;
  let tp = cache.transitions.get(key);
  if (!tp) {
    tp = {
      builtTo: 0,
      win: new Uint8Array(BUFFER_CAPACITY),
      ll: new Int32Array(BUFFER_CAPACITY + 1),
      lw: new Int32Array(BUFFER_CAPACITY + 1),
      wl: new Int32Array(BUFFER_CAPACITY + 1),
      ww: new Int32Array(BUFFER_CAPACITY + 1),
    };
    cache.transitions.set(key, tp);
  }
  while (tp.builtTo < cache.len) {
    const idx = tp.builtTo;
    const w = outcomeAt(cache, type, barrier, idx);
    tp.win[idx] = w;
    const nextIdx = idx + 1;
    if (idx === 0) {
      tp.ll[nextIdx] = 0;
      tp.lw[nextIdx] = 0;
      tp.wl[nextIdx] = 0;
      tp.ww[nextIdx] = 0;
    } else {
      const prev = tp.win[idx - 1]!;
      tp.ll[nextIdx] = tp.ll[idx]! + (prev === 0 && w === 0 ? 1 : 0);
      tp.lw[nextIdx] = tp.lw[idx]! + (prev === 0 && w === 1 ? 1 : 0);
      tp.wl[nextIdx] = tp.wl[idx]! + (prev === 1 && w === 0 ? 1 : 0);
      tp.ww[nextIdx] = tp.ww[idx]! + (prev === 1 && w === 1 ? 1 : 0);
    }
    tp.builtTo = nextIdx;
  }
  return tp;
}

/** O(1) hit count in [start, end) from prefix arrays. */
function hitsInRange(
  cache: MarketPrefixCache,
  type: HedgeContractType,
  barrier: number,
  start: number,
  end: number,
): number {
  if (end <= start) return 0;
  switch (type) {
    case "DIGITOVER": {
      let sum = 0;
      for (let d = barrier + 1; d <= 9; d++) {
        const dp = cache.digitPrefix[d]!;
        sum += dp[end]! - dp[start]!;
      }
      return sum;
    }
    case "DIGITUNDER": {
      let sum = 0;
      for (let d = 0; d < barrier; d++) {
        const dp = cache.digitPrefix[d]!;
        sum += dp[end]! - dp[start]!;
      }
      return sum;
    }
    case "DIGITEVEN": {
      let sum = 0;
      for (let d = 0; d <= 8; d += 2) {
        const dp = cache.digitPrefix[d]!;
        sum += dp[end]! - dp[start]!;
      }
      return sum;
    }
    case "DIGITODD": {
      let sum = 0;
      for (let d = 1; d <= 9; d += 2) {
        const dp = cache.digitPrefix[d]!;
        sum += dp[end]! - dp[start]!;
      }
      return sum;
    }
    case "DIGITMATCH": {
      const dp = cache.digitPrefix[barrier]!;
      return dp[end]! - dp[start]!;
    }
    case "DIGITDIFF": {
      const dp = cache.digitPrefix[barrier]!;
      return end - start - (dp[end]! - dp[start]!);
    }
    case "CALL":
      // If start === 0, index 0 has no prior price in cache; mirror hedgeWinStream where index 0 is false.
      return cache.upPrefix[end]! - cache.upPrefix[start]!;
    case "PUT":
      return cache.downPrefix[end]! - cache.downPrefix[start]!;
  }
}

/** Out-of-sample digit selection on [start, split) using O(1) prefix differences. */
function selectOutOfSampleDigit(
  cache: MarketPrefixCache,
  type: "DIGITMATCH" | "DIGITDIFF",
  start: number,
  split: number,
): number {
  let bestDigit = 0;
  let bestCount = type === "DIGITMATCH" ? -1 : Number.POSITIVE_INFINITY;
  for (let d = 0; d < 10; d++) {
    const dp = cache.digitPrefix[d]!;
    const count = dp[split]! - dp[start]!;
    if (type === "DIGITMATCH" ? count > bestCount : count < bestCount) {
      bestCount = count;
      bestDigit = d;
    }
  }
  return bestDigit;
}

// ── Evidence Tracker (stateful per engine / lab instance) ─────────────────────

const EWMA_HALF_LIFE_TICKS = 600;
const EWMA_ALPHA = 1 - Math.pow(0.5, 1 / EWMA_HALF_LIFE_TICKS);

export class EvidenceTracker {
  private caches = new Map<string, MarketPrefixCache>();
  private ewmaEdgeIndex = 0;
  private initializedEwma = false;

  reset(): void {
    this.caches.clear();
    this.ewmaEdgeIndex = 0;
    this.initializedEwma = false;
  }

  getEdgeIndex(): number {
    return this.ewmaEdgeIndex;
  }

  evaluate(input: EvaluateEvidenceInput): EvidenceRow[] {
    const { markets } = input;
    const marketsScanned = input.marketsScanned ?? Math.max(1, markets.length);
    const maxSpecs = markets.reduce((max, m) => Math.max(max, m.specs.length), 1);
    const specsInSet = input.specsInSet ?? maxSpecs;
    const evidenceWeight = clamp(input.evidenceWeight ?? 1, 0, 1);

    const stdThresh = universalThreshold(marketsScanned, specsInSet, false);
    const autoThresh = universalThreshold(marketsScanned, specsInSet, true);

    interface PendingRow {
      symbol: string;
      spec: HedgeFamilySpec;
      resolvedBarrier: number;
      p0: number;
      pTilde: number;
      z: number;
      zTilde: number;
      window: number;
      nEff: number;
      q: number;
      depUsed: boolean;
      longestWindowZ2: number;
      longestZ: number;
      longestZTilde: number;
      longestWindowTicks: number;
    }

    const pending: PendingRow[] = [];

    for (const market of markets) {
      if (market.digits.length === 0 || market.prices.length === 0) continue;

      let cache = this.caches.get(market.symbol);
      if (!cache) {
        cache = createMarketPrefixCache(market.symbol);
        this.caches.set(market.symbol, cache);
      }
      syncMarketCache(cache, market.digits, market.prices, market.tickSequence);
      const end = cache.len;
      const available =
        market.availableTicks ?? Math.min(market.digits.length, market.prices.length);
      const maxAvail = Math.min(end, available);
      if (maxAvail < HEDGE_MIN_TICKS) continue;

      // Distinct window sizes available on this tape (in ascending order [120, 500, 1500]).
      const windows: number[] = [];
      for (const w of HEDGE_V2_WINDOWS) {
        const nw = Math.min(maxAvail, w);
        if (nw >= HEDGE_MIN_TICKS && (windows.length === 0 || windows[windows.length - 1] !== nw)) {
          windows.push(nw);
        }
      }
      if (windows.length === 0) continue;

      for (const spec of market.specs) {
        const p0 = baseProbabilityForSpec(spec);
        if (p0 === null) continue;
        const autoDigit = isAutoDigitSpec(spec);
        const lambda = autoDigit ? autoThresh.lambda : stdThresh.lambda;

        let bestWindow = windows[windows.length - 1]!;
        let bestAbsZTilde = -1;
        let bestZ = 0;
        let bestZTilde = 0;
        let bestNEff = bestWindow;
        let bestBarrier = spec.barrier;
        let longestZ2 = 0;
        let longestZ = 0;
        let longestZTilde = 0;
        let longestWindowTicks = windows[windows.length - 1]!;

        for (let wi = 0; wi < windows.length; wi++) {
          const nw = windows[wi]!;
          const start = end - nw;
          let barrier = spec.barrier;
          let hits: number;
          let nEff: number;

          if (autoDigit) {
            // Out-of-sample split: older 70% picks the digit, newest 30% evaluates z.
            const trainLen = Math.max(1, Math.floor(0.7 * nw));
            const evalLen = Math.max(1, nw - trainLen);
            const split = start + trainLen;
            barrier = selectOutOfSampleDigit(
              cache,
              spec.type as "DIGITMATCH" | "DIGITDIFF",
              start,
              split,
            );
            hits = hitsInRange(cache, spec.type, barrier, split, end);
            nEff = evalLen;
          } else {
            hits = hitsInRange(cache, spec.type, barrier, start, end);
            nEff = nw;
          }

          const denom = Math.sqrt(nEff * p0 * (1 - p0));
          const z = denom > 0 ? (hits - nEff * p0) / denom : 0;
          const zTilde = softThreshold(z, lambda);
          const absZTilde = Math.abs(zTilde);

          if (wi === windows.length - 1) {
            longestZ2 = z * z;
            longestZ = z;
            longestZTilde = zTilde;
            longestWindowTicks = nw;
          }

          // Use the window with the largest |z~|; ties -> longest window (windows is ascending).
          if (absZTilde > bestAbsZTilde + 1e-12 || Math.abs(absZTilde - bestAbsZTilde) <= 1e-12) {
            bestAbsZTilde = absZTilde;
            bestWindow = nw;
            bestZ = z;
            bestZTilde = zTilde;
            bestNEff = nEff;
            bestBarrier = barrier;
          }
        }

        // Shrunk probability from the selected window
        let rawPTilde = p0 + bestZTilde * Math.sqrt((p0 * (1 - p0)) / Math.max(1, bestNEff));
        let finalZ = bestZ;
        let finalZTilde = bestZTilde;
        let finalNEff = bestNEff;
        let depUsed = false;

        // Dependence check over the longest window (2x2 transition counts)
        const longestW = windows[windows.length - 1]!;
        const longStart = end - longestW;
        let depEvalStart = longStart;
        let depBarrier = bestBarrier;
        if (autoDigit) {
          const trainLen = Math.max(1, Math.floor(0.7 * longestW));
          const split = longStart + trainLen;
          depBarrier = selectOutOfSampleDigit(
            cache,
            spec.type as "DIGITMATCH" | "DIGITDIFF",
            longStart,
            split,
          );
          depEvalStart = split;
        }
        const tp = getTransitionPrefix(cache, spec.type, depBarrier);
        // Transitions within [depEvalStart, end) start at index max(1, depEvalStart + 1)
        const transStart = Math.max(1, depEvalStart + 1);
        if (end > transStart) {
          const ll = tp.ll[end]! - tp.ll[transStart]!;
          const lw = tp.lw[end]! - tp.lw[transStart]!;
          const wl = tp.wl[end]! - tp.wl[transStart]!;
          const ww = tp.ww[end]! - tp.ww[transStart]!;
          const nL = ll + lw;
          const nW = wl + ww;
          if (nL >= 20 && nW >= 20) {
            const a = lw / nL; // P(win | prev loss)
            const b = ww / nW; // P(win | prev win)
            const minVar = 0.5 * p0 * (1 - p0);
            const varA = Math.max(minVar, a * (1 - a));
            const varB = Math.max(minVar, b * (1 - b));
            const seDep = Math.sqrt(varA / nL + varB / nW);
            if (seDep > 0) {
              const zDep = (a - b) / seDep;
              const zDepTilde = softThreshold(zDep, lambda);
              if (zDepTilde !== 0) {
                depUsed = true;
                const lastWin = tp.win[end - 1] === 1;
                const shrunkDiff = zDepTilde * seDep;
                const totalN = nL + nW;
                const condShift = lastWin
                  ? -(nL / totalN) * shrunkDiff
                  : (nW / totalN) * shrunkDiff;
                rawPTilde = rawPTilde + condShift;
                finalNEff = lastWin ? nW : nL;
                finalZ = lastWin ? -zDep : zDep;
                finalZTilde = lastWin ? -zDepTilde : zDepTilde;
                bestWindow = longestW;
                bestBarrier = depBarrier;
              }
            }
          }
        }

        const shrunkP = clamp(p0 + evidenceWeight * (rawPTilde - p0), 0.001, 0.999);
        const effZTilde = evidenceWeight * finalZTilde;
        const payout = input.payoutResolver
          ? input.payoutResolver(market.symbol, spec.type, bestBarrier)
          : hedgePayout(spec.type, bestBarrier);
        const breakEven = payout > 0 ? 1 / payout : 1;
        const sigmaP = Math.sqrt((shrunkP * (1 - shrunkP)) / Math.max(1, finalNEff));
        const q = sigmaP > 0 ? clamp(normalCdf((shrunkP - breakEven) / sigmaP), 0, 1) : 0;

        pending.push({
          symbol: market.symbol,
          spec,
          resolvedBarrier: bestBarrier,
          p0,
          pTilde: shrunkP,
          z: finalZ,
          zTilde: effZTilde,
          window: bestWindow,
          nEff: finalNEff,
          q,
          depUsed,
          longestWindowZ2: longestZ2,
          longestZ,
          longestZTilde,
          longestWindowTicks,
        });
      }
    }

    // Empirical-Bayes diagnostic: tau2 = max(0, mean(z^2) - 1), EWMA half-life 600 ticks
    if (pending.length > 0) {
      const meanZ2 = pending.reduce((sum, r) => sum + r.longestWindowZ2, 0) / pending.length;
      const tau2 = Math.max(0, meanZ2 - 1);
      if (!this.initializedEwma) {
        this.ewmaEdgeIndex = EWMA_ALPHA * tau2;
        this.initializedEwma = true;
      } else {
        this.ewmaEdgeIndex = (1 - EWMA_ALPHA) * this.ewmaEdgeIndex + EWMA_ALPHA * tau2;
      }
    }
    const edgeIndex = Math.max(0, this.ewmaEdgeIndex);

    return pending.map((r) => ({
      symbol: r.symbol,
      spec: r.spec,
      resolvedBarrier: r.resolvedBarrier,
      p0: r.p0,
      pTilde: r.pTilde,
      z: r.z,
      zTilde: r.zTilde,
      window: r.window,
      nEff: r.nEff,
      q: r.q,
      depUsed: r.depUsed,
      edgeIndex,
      longestZ: r.longestZ,
      longestZTilde: r.longestZTilde,
      longestWindowTicks: r.longestWindowTicks,
    }));
  }
}

const defaultTracker = new EvidenceTracker();

export function evaluateRecoveryEvidence(input: EvaluateEvidenceInput): EvidenceRow[] {
  return defaultTracker.evaluate(input);
}

export function resetDefaultEvidenceTracker(): void {
  defaultTracker.reset();
}
