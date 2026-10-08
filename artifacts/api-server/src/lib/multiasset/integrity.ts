/**
 * Multi-Asset Desk — feed integrity.
 *
 * Two classes of failure make a live desk lie to its user, and both are silent
 * unless they are actively looked for:
 *
 *  1. CLOCK PROBLEMS. MetaTrader timestamps ticks, bars and calendar events in
 *     the broker's trade-server timezone, not UTC. Consumed as epoch
 *     milliseconds they are off by the server's GMT offset — commonly two or
 *     three hours. A quote stamped three hours in the future never ages out
 *     (so a dead price keeps looking live), and one stamped three hours in the
 *     past is permanently "stale" (so nothing ever trades). We normalise at
 *     the source and re-check here.
 *
 *  2. PRICE PROBLEMS. A broker can rename a symbol, change a contract, or feed
 *     a symbol the EA never subscribed to; the terminal then returns a cached
 *     tick from another session. The number is well-formed and plausible-looking
 *     and completely wrong — which is how XAUUSD ends up printing 5898 when
 *     the market is at 4105. The only defence available to us is a cross-check
 *     against the symbol's own recent candles.
 *
 * Nothing here substitutes data. When a feed fails a check we mark it and
 * refuse to trade it; we never invent a price.
 */

import { atr, closes } from "./math";
import { seriesFor, type DeskState } from "./store";
import { TIMEFRAMES, type Bar, type Quote, type SymbolSpec } from "./types";

/** How old a quote may be before the desk refuses to analyse or trade it. */
export const QUOTE_STALE_MS = 8_000;
/** Above this age the symbol is shown as warming rather than stale. */
export const QUOTE_WARMING_MS = 20_000;

/** A terminal clock more than this far from the server's is worth reporting. */
const CLOCK_SKEW_WARN_MS = 5_000;
/** Hard reject: a quote timestamp this far from now cannot be a real tick. */
const MAX_CLOCK_DEVIATION_MS = 6 * 60 * 60_000;

/**
 * A quote is only called a mismatch when it is extreme on BOTH scales:
 * far from the last close in absolute percentage terms, AND far from it
 * relative to the instrument's own volatility.
 *
 * Requiring both is what keeps the check useful. An instrument whose M5 ATR is
 * 0.3% of price can legitimately print a 10% move on news; requiring only the
 * ATR test would pause that symbol every time it did something interesting.
 * Requiring only the percentage test would flag any fast market on a
 * low-priced instrument. Neither alone is evidence of a broken feed — both
 * together are.
 */
const ATR_MISMATCH_MULT = 25;
/** Absolute deviation from the last candle close that counts as a mismatch. */
const ABSOLUTE_MISMATCH_PCT = 25;

export type FeedStatus = "live" | "warming" | "stale" | "mismatch";

export interface FeedHealth {
  status: FeedStatus;
  /** Milliseconds since the tick was taken, corrected for clock skew. */
  ageMs: number | null;
  /** Signed offset of the terminal's clock from the server's, in ms. */
  clockSkewMs: number | null;
  /** Deviation of the quote mid from the last bar close, in ATRs. */
  deviationAtr: number | null;
  /** Deviation as a percentage of the last bar close. */
  deviationPct: number | null;
  /** Human-readable explanation, present whenever status is not "live". */
  detail: string | null;
}

/**
 * Update the desk's measured clock skew from a terminal heartbeat.
 *
 * Smoothed rather than replaced: a single WebRequest round trip is not a
 * precision time measurement, and jitter on one sample should not move the
 * correction the desk applies to every subsequent quote.
 *
 * The convergence uses an adaptive alpha: when the new sample is far from the
 * current estimate (large initial skew or a sudden clock step) the filter
 * responds quickly (α ≈ 0.6), so the desk stops rejecting good quotes within
 * two or three heartbeats. Once the estimate has settled it tightens back to
 * the normal smoothing (α = 0.2) so routine RTT jitter does not ripple into
 * the staleness gate.
 */
export function updateClockSkew(desk: DeskState, terminalUtcMs: number, now = Date.now()): number {
  const sample = terminalUtcMs - now;
  if (!Number.isFinite(sample)) return desk.clockSkewMs ?? 0;
  const previous = desk.clockSkewMs;
  if (previous === null) {
    // First sample — take it as-is.
    desk.clockSkewMs = Math.round(sample);
    return desk.clockSkewMs;
  }
  // Adaptive alpha: converge fast when the sample is far from the current
  // estimate (initial skew, clock step), slowly when it is close (jitter).
  const delta = Math.abs(sample - previous);
  // 5-second threshold: within that, we assume normal network jitter.
  const alpha = delta > 5_000 ? 0.6 : 0.2;
  const next = previous * (1 - alpha) + sample * alpha;
  desk.clockSkewMs = Math.round(next);
  return desk.clockSkewMs;
}

/** Apply the measured skew so terminal timestamps are comparable to `Date.now()`. */
export function toServerTime(desk: DeskState, terminalUtcMs: number): number {
  return terminalUtcMs - (desk.clockSkewMs ?? 0);
}

export function clockSkewWarning(desk: DeskState): string | null {
  const skew = desk.clockSkewMs;
  if (skew === null || Math.abs(skew) < CLOCK_SKEW_WARN_MS) return null;
  const seconds = Math.round(skew / 1000);
  return (
    `The MT5 terminal's clock is ${Math.abs(seconds)}s ${seconds > 0 ? "ahead of" : "behind"} this server. ` +
    `Timestamps are being corrected, so quote ages shown are accurate. ` +
    `${Math.abs(seconds) > 30 ? "Check the VPS or machine running MT5 — a clock this far off will also affect pending-order triggers and economic-calendar times inside the terminal." : ""}`
  );
}

/** Reject a quote whose timestamp cannot describe a real tick. */
export function quoteTimestampUsable(desk: DeskState, quote: Quote, now = Date.now()): boolean {
  if (!Number.isFinite(quote.ts) || quote.ts <= 0) return false;
  return Math.abs(toServerTime(desk, quote.ts) - now) <= MAX_CLOCK_DEVIATION_MS;
}

/** Reject a bar whose timestamp cannot describe a real candle. */
export function barTimestampUsable(desk: DeskState, time: number, now = Date.now()): boolean {
  if (!Number.isFinite(time) || time <= 0) return false;
  // Bars may legitimately be slightly ahead of the server (a forming candle on
  // a fast broker clock), but not days out.
  const corrected = toServerTime(desk, time);
  return corrected <= now + MAX_CLOCK_DEVIATION_MS && corrected >= now - 400 * 24 * 60 * 60_000;
}

function lastCloses(desk: DeskState, symbol: string): { bars: Bar[] | null; timeframe: string | null } {
  const series = seriesFor(desk, symbol);
  for (const timeframe of TIMEFRAMES) {
    const bars = series[timeframe];
    if (bars && bars.length >= 5) return { bars, timeframe };
  }
  return { bars: null, timeframe: null };
}

/**
 * Cross-check a quote against the symbol's own recent candles.
 *
 * A live tick in a quiet market sits within a fraction of an ATR of the last
 * close. A cached or wrong-symbol tick does not. This cannot prove a price is
 * right — it can only catch the failures that are gross enough to matter.
 */
export function assessPrice(desk: DeskState, symbol: string, quote: Quote): {
  deviationAtr: number | null;
  deviationPct: number | null;
  mismatch: boolean;
  detail: string | null;
} {
  const { bars, timeframe } = lastCloses(desk, symbol);
  if (!bars || !timeframe) {
    return { deviationAtr: null, deviationPct: null, mismatch: false, detail: null };
  }

  const price = closes(bars);
  const lastClose = price[price.length - 1];
  const mid = (quote.bid + quote.ask) / 2;
  if (!(lastClose > 0) || !(mid > 0)) {
    return { deviationAtr: null, deviationPct: null, mismatch: false, detail: null };
  }

  const atrValue = atr(bars, 14);
  const delta = Math.abs(mid - lastClose);
  const deviationAtr = atrValue > 0 ? delta / atrValue : null;
  const deviationPct = (delta / lastClose) * 100;

  // A symbol with no history or a genuinely gapping market is not a mismatch;
  // only a deviation that no plausible move explains is flagged.
  const mismatch =
    (deviationAtr !== null && deviationAtr > ATR_MISMATCH_MULT) &&
    deviationPct > ABSOLUTE_MISMATCH_PCT;

  const detail = mismatch
    ? `Quote ${mid.toFixed(5)} is ${deviationPct.toFixed(1)}% (${(deviationAtr ?? 0).toFixed(1)} ATR) away from the last ${timeframe} close of ${lastClose.toFixed(5)}. ` +
      `This usually means the broker symbol changed, the EA is not subscribed to it, or the terminal returned a cached tick. ` +
      `Trading on this symbol is blocked until the quote and the candles agree.`
    : null;

  return { deviationAtr, deviationPct, mismatch, detail };
}

/**
 * The single place that decides whether a symbol's data may be analysed,
 * armed or traded.
 */
export function feedHealth(desk: DeskState, symbol: string, now = Date.now()): FeedHealth {
  const quote = desk.quotes.get(symbol);
  const clockSkewMs = desk.clockSkewMs;
  if (!quote) {
    return { status: "warming", ageMs: null, clockSkewMs, deviationAtr: null, deviationPct: null, detail: "Waiting for the MT5 EA to stream this symbol's first tick." };
  }

  const ageMs = Math.max(0, now - toServerTime(desk, quote.ts));
  const price = assessPrice(desk, symbol, quote);
  const skewWarning = clockSkewWarning(desk);

  if (price.mismatch) {
    return {
      status: "mismatch",
      ageMs,
      clockSkewMs,
      deviationAtr: price.deviationAtr,
      deviationPct: price.deviationPct,
      detail: price.detail,
    };
  }

  if (ageMs > QUOTE_STALE_MS) {
    return {
      status: "stale",
      ageMs,
      clockSkewMs,
      deviationAtr: price.deviationAtr,
      deviationPct: price.deviationPct,
      detail: `Last tick is ${(ageMs / 1000).toFixed(1)}s old (limit ${QUOTE_STALE_MS / 1000}s).${skewWarning ? ` ${skewWarning}` : ""}`,
    };
  }

  if (ageMs > QUOTE_WARMING_MS * 0.4 && skewWarning) {
    return { status: "warming", ageMs, clockSkewMs, deviationAtr: price.deviationAtr, deviationPct: price.deviationPct, detail: skewWarning };
  }

  return {
    status: "live",
    ageMs,
    clockSkewMs,
    deviationAtr: price.deviationAtr,
    deviationPct: price.deviationPct,
    detail: null,
  };
}

/** True when the desk may analyse, arm or execute on this symbol. */
export function feedIsTradeable(status: FeedStatus): boolean {
  return status === "live";
}

/** Convert a raw spec's spread into points the same way the EA reports it. */
export function spreadTolerance(spec: SymbolSpec, quote: Quote): { maxPoints: number; actual: number } {
  return {
    maxPoints: Math.max(spec.spreadPoints * 2, 8),
    actual: quote.spreadPoints,
  };
}
