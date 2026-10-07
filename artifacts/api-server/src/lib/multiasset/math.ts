/**
 * Multi-Asset Desk — primitive statistics and indicators.
 *
 * Pure, dependency-free, deterministic. Every consumer (regime, Markov, Monte
 * Carlo, confluence) builds on these, so they are tested directly against
 * hand-computed values rather than against each other.
 */

import type { Bar } from "./types";

export const OPEN = 1;
export const HIGH = 2;
export const LOW = 3;
export const CLOSE = 4;

export function closes(bars: Bar[]): number[] {
  return bars.map((b) => b[CLOSE]);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample standard deviation (n−1). Returns 0 for fewer than 2 points. */
export function stdev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (n - 1));
}

export function sma(values: number[], period: number): number {
  if (period <= 0 || values.length < period) return mean(values);
  return mean(values.slice(values.length - period));
}

/**
 * Exponential moving average seeded with the SMA of the first `period` points,
 * which is the convention MetaTrader and most charting packages use.
 */
export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (period <= 1) return values[values.length - 1];
  if (values.length < period) return mean(values);
  const k = 2 / (period + 1);
  let acc = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) acc = values[i] * k + acc * (1 - k);
  return acc;
}

/** Full EMA series (same length as input, first `period−1` entries seeded). */
export function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let acc = values[0];
  for (let i = 0; i < values.length; i++) {
    acc = i === 0 ? values[0] : values[i] * k + acc * (1 - k);
    out.push(acc);
  }
  return out;
}

/** Wilder's Average True Range, in price units. */
export function atr(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i][HIGH];
    const low = bars[i][LOW];
    const prevClose = bars[i - 1][CLOSE];
    trs.push(
      Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)),
    );
  }
  if (trs.length === 0) return 0;
  const p = Math.min(period, trs.length);
  // Wilder smoothing seeded with the simple average of the first p true ranges.
  let acc = mean(trs.slice(0, p));
  for (let i = p; i < trs.length; i++) acc = (acc * (p - 1) + trs[i]) / p;
  return acc;
}

/** Wilder RSI in [0,100]. Returns 50 when there is not enough data. */
export function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface Regression {
  /** Price change per bar. */
  slope: number;
  intercept: number;
  /** Coefficient of determination in [0,1] — how clean the trend is. */
  r2: number;
}

/** Ordinary least squares of value against bar index. */
export function linreg(values: number[]): Regression {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 };
  const xs = values.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(values);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (values[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i] + intercept;
    ssRes += (values[i] - pred) * (values[i] - pred);
    ssTot += (values[i] - my) * (values[i] - my);
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, Math.min(1, 1 - ssRes / ssTot));
  return { slope, intercept, r2 };
}

export function zscore(values: number[], value: number): number {
  const sd = stdev(values);
  if (sd === 0) return 0;
  return (value - mean(values)) / sd;
}

/** Log returns, length n−1. Non-positive prices are skipped defensively. */
export function logReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
    else out.push(0);
  }
  return out;
}

/**
 * EWMA volatility of returns (RiskMetrics λ=0.94 by default).
 *
 * Preferred over a flat standard deviation because volatility clusters: a
 * stop sized on last month's calm is the stop that gets hit today.
 */
export function ewmaVolatility(returns: number[], lambda = 0.94): number {
  if (returns.length === 0) return 0;
  let variance = returns[0] * returns[0];
  for (let i = 1; i < returns.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] * returns[i];
  }
  return Math.sqrt(Math.max(variance, 0));
}

export interface Swing {
  index: number;
  price: number;
  kind: "high" | "low";
}

/**
 * Fractal swing points: a bar whose high (low) exceeds `lookback` bars either
 * side. Used for structure-aware stops and breakeven buffers.
 */
export function swings(bars: Bar[], lookback = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j][HIGH] >= bars[i][HIGH]) isHigh = false;
      if (bars[j][LOW] <= bars[i][LOW]) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: bars[i][HIGH], kind: "high" });
    if (isLow) out.push({ index: i, price: bars[i][LOW], kind: "low" });
  }
  return out;
}

/** Most recent swing of a kind, or null. */
export function lastSwing(bars: Bar[], kind: "high" | "low", lookback = 2): Swing | null {
  const all = swings(bars, lookback);
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === kind) return all[i];
  return null;
}

/** Bollinger band width as a fraction of the mean — a squeeze/expansion gauge. */
export function bandWidth(values: number[], period = 20, mult = 2): number {
  const slice = values.slice(-period);
  const m = mean(slice);
  if (m === 0) return 0;
  return (2 * mult * stdev(slice)) / Math.abs(m);
}

/** Percentile rank of `value` within `values`, in [0,1]. */
export function percentileRank(values: number[], value: number): number {
  if (values.length === 0) return 0.5;
  let below = 0;
  for (const v of values) if (v < value) below++;
  return below / values.length;
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * Monte Carlo output must be reproducible: the same market state has to
 * produce the same probability every time, or the terminal would show a
 * flickering edge and backtests would be unrepeatable.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal from a uniform generator. */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Stable string → 32-bit seed, so each symbol/timeframe has its own stream. */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
