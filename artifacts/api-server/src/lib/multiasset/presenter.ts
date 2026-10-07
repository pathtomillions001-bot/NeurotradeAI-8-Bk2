/**
 * Multi-Asset Desk — presentation helpers shared by the HTTP routes and the
 * live stream.
 *
 * The browser and the SSE channel must never disagree about a symbol's
 * status, so both are built from the same functions here. Anything that needs
 * to know whether a quote is fresh, sane or stale goes through feedHealth().
 */

import { closes } from "./math";
import { feedHealth, type FeedStatus } from "./integrity";
import { seriesFor, type DeskState } from "./store";
import type { AssetClass, Timeframe } from "./types";

/** Timeframe used for the 24-hour high/low and the change percentage. */
const REFERENCE_TIMEFRAME: Timeframe = "M5";
/** Bars of reference timeframe that make up roughly 24 hours. */
const DAY_BARS = 288;
/** Points in the mini sparkline shown on compact layouts. */
const SPARKLINE_POINTS = 40;

export interface DeskInstrument {
  symbol: string;
  description: string;
  assetClass: AssetClass;
  digits: number | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
  changePct: number | null;
  watched: true;
  dataStatus: FeedStatus;
  lastQuoteAt: number | null;
  /** Milliseconds since this tick was taken, skew-corrected. */
  quoteAgeMs: number | null;
  /** Non-null when the quote disagrees with the symbol's own candles. */
  priceWarning: string | null;
  /** How far the quote sits from the last bar close, as a percentage. */
  deviationPct: number | null;
  /** Rolling 24h extremes from the broker's own bars. */
  sessionHigh: number | null;
  sessionLow: number | null;
  /** Recent closes for a sparkline. Empty when there is no history yet. */
  sparkline: number[];
  contractSize: number | null;
  point: number | null;
}

function pickSeries(desk: DeskState, symbol: string, timeframe: Timeframe) {
  return seriesFor(desk, symbol)[timeframe] ?? [];
}

export function quoteSnapshot(desk: DeskState, now = Date.now()): DeskInstrument[] {
  return desk.watchlist.map((symbol) => {
    const catalog = desk.catalog.get(symbol);
    const spec = desk.specs.get(symbol);
    const quote = desk.quotes.get(symbol);
    const health = feedHealth(desk, symbol, now);

    const bars = pickSeries(desk, symbol, REFERENCE_TIMEFRAME);
    const day = bars.slice(-DAY_BARS);
    let sessionHigh: number | null = null;
    let sessionLow: number | null = null;
    for (const bar of day) {
      const high = bar[2];
      const low = bar[3];
      if (high > 0 && (sessionHigh === null || high > sessionHigh)) sessionHigh = high;
      if (low > 0 && (sessionLow === null || low < sessionLow)) sessionLow = low;
    }

    const series = day.length > 0 ? day : bars;
    const first = series.length > 0 ? series[0][4] : null;
    const last = series.length > 0 ? series[series.length - 1][4] : null;
    const changePct = first && last ? ((last - first) / first) * 100 : null;

    return {
      symbol,
      description: catalog?.description ?? symbol,
      assetClass: catalog?.assetClass ?? spec?.assetClass ?? "other",
      digits: spec?.digits ?? null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      spreadPoints: quote?.spreadPoints ?? null,
      changePct,
      watched: true as const,
      dataStatus: health.status,
      lastQuoteAt: quote?.ts ?? null,
      quoteAgeMs: health.ageMs,
      priceWarning: health.status === "mismatch" ? health.detail : null,
      deviationPct: health.deviationPct,
      sessionHigh,
      sessionLow,
      sparkline: closes(bars).slice(-SPARKLINE_POINTS),
      contractSize: spec?.contractSize ?? null,
      point: spec?.point ?? null,
    };
  });
}

/**
 * The compact payload pushed over SSE on every heartbeat.
 *
 * Deliberately small: it is sent once per second per browser, so it carries
 * prices, status and warnings — nothing that can be fetched on demand.
 */
export function deskSummary(desk: DeskState, now = Date.now()) {
  return {
    serverTime: now,
    mode: desk.mode,
    autoTrade: desk.autoTrade,
    terminal: desk.terminal
      ? { login: desk.terminal.login, lastSyncAt: desk.terminal.lastSyncAt, stale: now - desk.terminal.lastSyncAt > 30_000 }
      : null,
    account: desk.account,
    instruments: quoteSnapshot(desk, now),
    positions: desk.positions,
    plans: [...desk.plans.values()],
    clockSkewMs: desk.clockSkewMs,
    lastQuoteAgeMs: desk.lastQuoteAgeMs,
  };
}
