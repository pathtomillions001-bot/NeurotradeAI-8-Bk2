/**
 * Multi-Asset Desk — the single live-data gate.
 *
 * Every path that analyses, ranks or arms a symbol goes through these
 * functions. They used to live inside the desk routes, which meant the one
 * consumer that most needs them — the automatic best-market pass, which runs
 * inside a heartbeat with no HTTP request around it — had no way to reuse them
 * and would have had to re-implement the freshness and price-integrity rules.
 * Two implementations of "is this price trustworthy" is exactly the kind of
 * duplication that eventually trades on a stale quote.
 *
 * The rules:
 *   1. The terminal's heartbeat must be fresh (or nothing is analysed at all).
 *   2. The symbol's own feed must be tradeable: fresh tick AND a quote that
 *      agrees with the symbol's candles (see integrity.ts).
 *   3. Only then may a spec + quote + series be handed to the agent.
 */

import { feedHealth, feedIsTradeable } from "./integrity";
import { seriesFor, type DeskState } from "./store";
import type { Bar, Quote, SymbolSpec, Timeframe } from "./types";

/** A terminal that has not heartbeated within this window is stale. */
export const TERMINAL_STALE_MS = 30_000;

export function terminalIsFresh(desk: DeskState, now = Date.now()): boolean {
  return Boolean(desk.terminal && now - desk.terminal.lastSyncAt <= TERMINAL_STALE_MS);
}

/** Why the desk cannot act right now, or null when it can. */
export function connectionProblem(desk: DeskState, now = Date.now()): string | null {
  if (!desk.terminal) return "Link a MetaTrader 5 terminal before requesting live Desk data.";
  if (now - desk.terminal.lastSyncAt > TERMINAL_STALE_MS) {
    return "The MetaTrader 5 terminal heartbeat is stale. New analysis and entries are paused.";
  }
  if (!desk.account) return "Waiting for the paired MetaTrader 5 terminal to send its first account snapshot.";
  return null;
}

export function symbolReadiness(desk: DeskState, symbol: string, now = Date.now()) {
  if (!desk.terminal || !terminalIsFresh(desk, now)) return "stale" as const;
  return feedHealth(desk, symbol, now).status;
}

export function resolveLiveSymbol(
  desk: DeskState,
  symbol: string,
  now = Date.now(),
): { spec: SymbolSpec; quote: Quote; series: Partial<Record<Timeframe, Bar[]>> } | null {
  if (!terminalIsFresh(desk, now)) return null;
  if (!feedIsTradeable(feedHealth(desk, symbol, now).status)) return null;
  const spec = desk.specs.get(symbol);
  const quote = desk.quotes.get(symbol);
  if (!spec || !quote) return null;
  return { spec, quote, series: seriesFor(desk, symbol) };
}
