/**
 * Feature Engineering Agent
 *
 * RESPONSIBILITY: Centralize ALL feature extraction so no other agent
 * recomputes prices, returns, autocorrelations, or digit stats.
 * Every downstream agent reads from the FeatureSet produced here.
 *
 * Fixes vs old code:
 * - Single source of truth for features (old code had 3+ separate extraction paths)
 * - Multi-horizon returns (1, 3, 5, 10, 20 ticks) to match actual contract durations
 * - No RSI / EMA / SMA — purely statistical features
 * - Separate price features and digit features clearly
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";

// ── Math utilities ────────────────────────────────────────────────────────────

export function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

export function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

export function autocorr(arr: number[], lag: number): number {
  if (arr.length <= lag) return 0;
  const m = mean(arr);
  let num = 0, den = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    den += d * d;
    if (i >= lag) num += (arr[i] - m) * (arr[i - lag] - m);
  }
  return den > 0 ? num / den : 0;
}

export function shannonEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  let h = 0;
  for (const c of counts) {
    if (c > 0) { const p = c / total; h -= p * Math.log2(p); }
  }
  return h;
}

/** Hurst exponent approximation (R/S method). 0.5 = random walk, >0.5 = trending, <0.5 = mean-reverting */
export function hurstExponent(returns: number[]): number {
  if (returns.length < 20) return 0.5;
  const n = returns.length;
  const m = mean(returns);
  let cum = 0, maxC = -Infinity, minC = Infinity;
  for (const r of returns) { cum += r - m; maxC = Math.max(maxC, cum); minC = Math.min(minC, cum); }
  const R = maxC - minC;
  const S = stddev(returns) || 1e-10;
  const rs = R / S;
  return Math.max(0.05, Math.min(0.95, Math.log(rs) / Math.log(n) * 0.5 + 0.5));
}

/** Simple DFT energy in low-frequency bands (dominant cycle detection) */
export function spectralEnergy(returns: number[], maxK = 3): number {
  const n = Math.min(returns.length, 32);
  const slice = returns.slice(-n);
  let energy = 0;
  for (let k = 1; k <= maxK; k++) {
    let re = 0, im = 0;
    for (let t = 0; t < slice.length; t++) {
      const angle = (2 * Math.PI * k * t) / slice.length;
      re += slice[t] * Math.cos(angle);
      im += slice[t] * Math.sin(angle);
    }
    energy += Math.sqrt(re * re + im * im) / slice.length;
  }
  return energy;
}

// ── Feature set produced by this agent ────────────────────────────────────────

export interface PriceFeatures {
  // Multi-horizon returns (aligned to typical Deriv contract durations)
  returns1: number[];   // tick-by-tick
  returns5: number[];   // 5-tick lookahead — matches default contract duration
  returns10: number[];  // 10-tick lookahead

  // Directional momentum at each horizon
  momentum1: number;    // mean 1-tick return (recent 20 ticks)
  momentum5: number;    // mean 5-tick return
  momentum10: number;   // mean 10-tick return

  // Autocorrelations
  autocorr1: number;
  autocorr3: number;
  autocorr5: number;

  // Statistical properties
  hurst: number;          // trend strength (>0.5 = trending)
  returnEntropy: number;  // Shannon entropy of return signs
  spectralE: number;      // low-frequency spectral energy
  zScoreLast: number;     // z-score of last return

  // Volatility
  vol20: number;          // realized vol over last 20 ticks
  vol5: number;           // realized vol over last 5 ticks (regime check)
  volRatio: number;       // vol5/vol20 — expanding (>1) or contracting (<1)

  // Tick velocity (price movement speed)
  tickVelocity: number;   // mean absolute 1-tick return, last 5 ticks

  // Win probabilities at each horizon (fraction of up moves)
  upFrac1: number;        // P(next 1 tick is up)
  upFrac5: number;        // P(next 5 ticks net positive)
  upFrac10: number;       // P(next 10 ticks net positive)

  // Raw last prices
  lastPrice: number;
  priceN: number;         // sample count
}

export interface DigitFeatures {
  digits: number[];
  counts: number[];           // raw count per digit 0-9
  frequencies: number[];      // fraction per digit
  chiSquare: number;          // deviation from uniform (higher = more biased)
  entropy: number;            // Shannon entropy (lower = more concentrated)
  lastDigit: number;
  hotDigits: number[];        // appearing > 12%
  coldDigits: number[];       // appearing < 8%
  overFrac: number;           // P(digit > barrier) empirical
  underFrac: number;          // P(digit < barrier) empirical
  // Markov transition matrix (last 10 from last digit)
  markovNext: number[];       // P(next digit = d | last digit)
  windowSize: number;
}

export interface FeatureSet {
  price: PriceFeatures;
  digit: DigitFeatures | null;  // null for non-digit markets
}

// ── Feature extraction ────────────────────────────────────────────────────────

function buildMultiHorizonReturns(prices: number[]): {
  r1: number[]; r5: number[]; r10: number[];
} {
  const r1: number[] = [];
  const r5: number[] = [];
  const r10: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    r1.push((prices[i] - prices[i - 1]) / (prices[i - 1] || 1));
  }
  for (let i = 5; i < prices.length; i++) {
    r5.push((prices[i] - prices[i - 5]) / (prices[i - 5] || 1));
  }
  for (let i = 10; i < prices.length; i++) {
    r10.push((prices[i] - prices[i - 10]) / (prices[i - 10] || 1));
  }

  return { r1, r5, r10 };
}

function buildTransitionRow(digits: number[], lastDigit: number): number[] {
  const counts = Array(10).fill(0);
  for (let i = 1; i < digits.length; i++) {
    if (digits[i - 1] === lastDigit) counts[digits[i]]++;
  }
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return counts.map((c) => (c + 0.5) / (total + 5)); // Laplace smoothed
}

export function extractFeatures(ctx: ScanContext): FeatureSet {
  const prices = ctx.prices;
  const n = prices.length;

  if (n < 5) {
    // Minimal fallback
    const empty: PriceFeatures = {
      returns1: [], returns5: [], returns10: [], momentum1: 0, momentum5: 0,
      momentum10: 0, autocorr1: 0, autocorr3: 0, autocorr5: 0, hurst: 0.5,
      returnEntropy: 1, spectralE: 0, zScoreLast: 0, vol20: 0, vol5: 0,
      volRatio: 1, tickVelocity: 0, upFrac1: 0.5, upFrac5: 0.5, upFrac10: 0.5,
      lastPrice: prices[n - 1] ?? 0, priceN: n,
    };
    return { price: empty, digit: null };
  }

  const { r1, r5, r10 } = buildMultiHorizonReturns(prices);

  const recent1 = r1.slice(-20);
  const recent5 = r5.slice(-20);
  const recent10 = r10.slice(-20);

  const vol20 = stddev(r1.slice(-20));
  const vol5 = stddev(r1.slice(-5));
  const m1 = mean(recent1);
  const sd1 = stddev(recent1) || 1e-10;

  const upFrac1 = recent1.length > 0 ? recent1.filter((r) => r > 0).length / recent1.length : 0.5;
  const upFrac5 = recent5.length > 0 ? recent5.filter((r) => r > 0).length / recent5.length : 0.5;
  const upFrac10 = recent10.length > 0 ? recent10.filter((r) => r > 0).length / recent10.length : 0.5;

  const pf: PriceFeatures = {
    returns1: r1,
    returns5: r5,
    returns10: r10,
    momentum1: mean(recent1),
    momentum5: mean(recent5),
    momentum10: mean(recent10),
    autocorr1: autocorr(r1, 1),
    autocorr3: autocorr(r1, 3),
    autocorr5: autocorr(r1, 5),
    hurst: hurstExponent(r1.slice(-60)),
    returnEntropy: shannonEntropy([
      r1.filter((r) => r > 0).length,
      r1.filter((r) => r < 0).length,
      r1.filter((r) => r === 0).length,
    ]),
    spectralE: spectralEnergy(r1),
    zScoreLast: r1.length > 0 ? (r1[r1.length - 1] - m1) / sd1 : 0,
    vol20,
    vol5,
    volRatio: vol20 > 0 ? vol5 / vol20 : 1,
    tickVelocity: mean(r1.slice(-5).map(Math.abs)),
    upFrac1,
    upFrac5,
    upFrac10,
    lastPrice: prices[n - 1],
    priceN: n,
  };

  // Digit features
  let digitF: DigitFeatures | null = null;
  if (ctx.digits.length >= 10) {
    const d = ctx.digits.slice(-Math.min(200, ctx.digits.length));
    const counts = Array(10).fill(0);
    for (const dg of d) counts[dg]++;
    const total = d.length;
    const frequencies = counts.map((c) => c / total);
    const expected = total / 10;
    const chiSq = counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
    const lastDigit = d[d.length - 1];

    const overCount = d.filter((x) => x > 5).length;
    const underCount = d.filter((x) => x < 5).length;

    digitF = {
      digits: d,
      counts,
      frequencies,
      chiSquare: chiSq,
      entropy: shannonEntropy(counts),
      lastDigit,
      hotDigits: counts.map((c, i) => ({ d: i, pct: c / total })).filter((x) => x.pct > 0.12).map((x) => x.d),
      coldDigits: counts.map((c, i) => ({ d: i, pct: c / total })).filter((x) => x.pct < 0.08).map((x) => x.d),
      overFrac: overCount / total,
      underFrac: underCount / total,
      markovNext: buildTransitionRow(d, lastDigit),
      windowSize: d.length,
    };
  }

  return { price: pf, digit: digitF };
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export function runFeatureEngineeringAgent(ctx: ScanContext): AgentOutput & { featureSet: FeatureSet } {
  const t0 = Date.now();
  const featureSet = extractFeatures(ctx);
  const pf = featureSet.price;

  // Score: how "feature-rich" is this market? More data + more volatility = better for ML
  const dataQuality = Math.min(100, pf.priceN * 0.5); // 200 ticks = perfect
  const hasDigit = featureSet.digit !== null ? 10 : 0;
  const score = Math.round(Math.min(100, dataQuality * 0.7 + hasDigit + (pf.vol20 > 0 ? 20 : 0)));

  return {
    agentId: "featureEngineering",
    score,
    confidence: Math.min(100, pf.priceN),
    signal: scoreToSignal(score),
    reasoning: `${pf.priceN} price ticks, ${featureSet.digit?.windowSize ?? 0} digit ticks. Vol20=${(pf.vol20 * 100).toFixed(4)}%, Hurst=${pf.hurst.toFixed(2)}, entropy=${pf.returnEntropy.toFixed(2)}.`,
    data: { featureSet },
    executionTimeMs: Date.now() - t0,
    featureSet,
  };
}
