/**
 * Multi-Asset Desk — sub-minute candles synthesised from the tick feed.
 *
 * MetaTrader's fastest chart period is M1, so a scalp that is supposed to
 * monitor "three minutes and below, all the way down to ten seconds" cannot be
 * served by `CopyRates` alone. It does not need to be: the EA already streams a
 * tick for EVERY selected symbol on EVERY heartbeat (0.5–1 s), which is 10–20
 * samples inside a ten-second window. This module turns that feed into `S10`
 * and `S30` bars.
 *
 * DESIGN RULES
 *
 * 1. A synthetic bar is only ever offered when it is HONESTLY built. If the
 *    heartbeat slows to 30 s, a "10-second candle" would be one tick wide and
 *    its high/low would be fiction. Every frame therefore records how many
 *    ticks each completed bar received, and a frame is withheld until the
 *    recent bars are dense enough (`MIN_SAMPLES_PER_BAR`). A slow terminal
 *    simply falls back to M1/M2/M3 — the band renormalises — instead of
 *    analysing noise and calling it a ten-second chart.
 *
 * 2. Bars are built from the MID price. A candle built from bids only would
 *    sit a spread below the market and shift every level the agent derives
 *    from it.
 *
 * 3. Bars are keyed by their own bucket boundary, so a repeated or late tick
 *    can never re-open a closed bar. Out-of-order ticks are dropped.
 *
 * 4. Memory is bounded per symbol per frame, and everything is dropped when a
 *    symbol is deselected or the terminal is unlinked.
 */

import type { Bar, Timeframe, Quote } from "./types";
import { SYNTHETIC_TIMEFRAMES, TICK_TIMEFRAME_MS } from "./types";

/** Bars retained per synthetic frame per symbol. */
export const MAX_SYNTHETIC_BARS = 360;

/**
 * Ticks a completed bar needs before its frame counts as trustworthy.
 * Five seconds of a 1 s heartbeat is five ticks; two is the floor at which a
 * bar's high and low are two observations rather than one.
 */
export const MIN_SAMPLES_PER_BAR = 2;

/** How many recently completed bars are checked for density. */
export const DENSITY_WINDOW = 20;

export interface FrameState {
  bars: Bar[];
  /** Bucket start of the bar currently forming. */
  currentBucket: number;
  /** Ticks seen inside the current bucket. */
  currentSamples: number;
  /** Ticks each of the last DENSITY_WINDOW completed bars received. */
  recentSamples: number[];
  /** Timestamp of the newest tick accepted into this frame. */
  lastTickTs: number;
}

export interface SymbolTicks {
  symbol: string;
  frames: Map<Timeframe, FrameState>;
}

export function createSymbolTicks(symbol: string): SymbolTicks {
  return { symbol, frames: new Map() };
}

function createFrame(): FrameState {
  return { bars: [], currentBucket: -1, currentSamples: 0, recentSamples: [], lastTickTs: 0 };
}

/**
 * Fold one tick into every synthetic frame for a symbol.
 *
 * Returns the frames whose bar count changed, so a caller can tell whether the
 * synthetic series actually advanced.
 */
export function recordTick(state: SymbolTicks, quote: Quote): Timeframe[] {
  const mid = (quote.bid + quote.ask) / 2;
  if (!(mid > 0) || !Number.isFinite(mid)) return [];
  if (!Number.isFinite(quote.ts) || quote.ts <= 0) return [];

  const advanced: Timeframe[] = [];
  for (const timeframe of SYNTHETIC_TIMEFRAMES) {
    const width = TICK_TIMEFRAME_MS[timeframe];
    if (!width) continue;

    let frame = state.frames.get(timeframe);
    if (!frame) {
      frame = createFrame();
      state.frames.set(timeframe, frame);
    }

    // Late or duplicated ticks are dropped rather than merged: a tick that
    // belongs to a bucket already closed would rewrite a finished candle.
    if (quote.ts < frame.lastTickTs) continue;
    frame.lastTickTs = quote.ts;

    const bucket = Math.floor(quote.ts / width) * width;

    if (bucket === frame.currentBucket) {
      const bar = frame.bars[frame.bars.length - 1];
      if (bar) {
        if (mid > bar[2]) bar[2] = mid;
        if (mid < bar[3]) bar[3] = mid;
        bar[4] = mid;
        bar[5] += 1;
      }
      frame.currentSamples++;
      continue;
    }

    // A new bucket: close the old bar's density record and open a new one.
    if (frame.currentBucket >= 0) {
      frame.recentSamples.push(frame.currentSamples);
      if (frame.recentSamples.length > DENSITY_WINDOW) frame.recentSamples.shift();
    }

    frame.currentBucket = bucket;
    frame.currentSamples = 1;
    frame.bars.push([bucket, mid, mid, mid, mid, 1]);
    if (frame.bars.length > MAX_SYNTHETIC_BARS) {
      frame.bars.splice(0, frame.bars.length - MAX_SYNTHETIC_BARS);
    }
    advanced.push(timeframe);
  }
  return advanced;
}

/**
 * Is a synthetic frame dense enough to analyse?
 *
 * Requires a full density window of completed bars, each of which received at
 * least MIN_SAMPLES_PER_BAR ticks. Until then the frame is simply absent — the
 * mode's band renormalises over the broker frames it does have.
 */
export function frameIsDense(frame: FrameState | undefined): boolean {
  if (!frame) return false;
  if (frame.recentSamples.length < DENSITY_WINDOW) return false;
  return frame.recentSamples.every((samples) => samples >= MIN_SAMPLES_PER_BAR);
}

/**
 * Live bars for one synthetic frame, or null when the frame is not yet
 * trustworthy. The forming bar is included — it is the one the entry decision
 * is actually made on.
 */
export function syntheticBars(state: SymbolTicks | undefined, timeframe: Timeframe): Bar[] | null {
  const frame = state?.frames.get(timeframe);
  if (!frame || !frameIsDense(frame)) return null;
  if (frame.bars.length === 0) return null;
  return frame.bars;
}

/** Every trustworthy synthetic series for a symbol. */
export function syntheticSeries(state: SymbolTicks | undefined): Partial<Record<Timeframe, Bar[]>> {
  const out: Partial<Record<Timeframe, Bar[]>> = {};
  if (!state) return out;
  for (const timeframe of SYNTHETIC_TIMEFRAMES) {
    const bars = syntheticBars(state, timeframe);
    if (bars) out[timeframe] = bars;
  }
  return out;
}

/**
 * Diagnostic for the desk: how dense the synthetic frames currently are.
 * Surfaced so "why is the ten-second frame missing?" has an answer.
 */
export function tickFeedDiagnostics(state: SymbolTicks | undefined) {
  const frames: Record<string, { bars: number; samplesPerBar: number | null; ready: boolean }> = {};
  if (!state) return { frames, ready: false };
  let anyReady = false;
  for (const timeframe of SYNTHETIC_TIMEFRAMES) {
    const frame = state.frames.get(timeframe);
    const window = frame?.recentSamples ?? [];
    const average = window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : null;
    const ready = frameIsDense(frame);
    anyReady = anyReady || ready;
    frames[timeframe] = {
      bars: frame?.bars.length ?? 0,
      samplesPerBar: average === null ? null : Number(average.toFixed(1)),
      ready,
    };
  }
  return { frames, ready: anyReady };
}
