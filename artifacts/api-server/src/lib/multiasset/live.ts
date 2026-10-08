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
 *
 * ── WHY THE TERMINAL TIMEOUT IS TWO-STAGE ────────────────────────────────────
 *
 * A single 30-second cliff meant that one slow WebRequest — MT5 copying history
 * on a busy chart, a VPS hiccup, a broker server restart — flipped the whole
 * desk into "Quotes and agent entries are paused", which is what the terminal
 * showed the user as "the MT5 terminal last synced 39s ago". Nothing is gained
 * by it: the freshness that actually protects the account is PER SYMBOL
 * (`QUOTE_STALE_MS` = 8s in integrity.ts), and that check is not relaxed by a
 * single millisecond here. The terminal-level timer is a circuit breaker, and a
 * circuit breaker that trips on every hiccup just teaches the user to ignore
 * it.
 *
 * So there are two bands:
 *   • DEGRADED (after TERMINAL_DEGRADED_MS): the desk keeps analysing and
 *     arming; every symbol is still individually gated on its own 8-second
 *     quote, so a genuinely frozen feed cannot be traded. The desk reports the
 *     state so the UI can say "reconnecting" instead of "paused".
 *   • STALE (after TERMINAL_STALE_MS): the terminal is considered gone. New
 *     analysis stops until it comes back.
 *
 * The band is sized from the terminal's OWN heartbeat contract when it reports
 * one (`clock.syncIntervalMs`), so a user who sets a slower heartbeat is not
 * punished for it — with a floor of a few missed beats and a hard ceiling.
 */

import { feedHealth, feedIsTradeable } from "./integrity";
import { seriesFor, type DeskState } from "./store";
import type { Bar, Quote, SymbolSpec, Timeframe } from "./types";

/** A terminal silent for this long is treated as gone: analysis pauses. */
export const TERMINAL_STALE_MS = 120_000;

/**
 * A terminal silent for this long is DEGRADED — still usable, worth saying out
 * loud, but not a reason to stop working.
 */
export const TERMINAL_DEGRADED_MS = 20_000;

/** Hard ceiling on the adaptive window, so a huge interval cannot disable it. */
const MAX_ADAPTIVE_STALE_MS = 300_000;

/**
 * The effective stale window for this desk.
 *
 * Twelve missed beats of the terminal's own reported interval, clamped into
 * [TERMINAL_STALE_MS, MAX_ADAPTIVE_STALE_MS]. A desk whose EA reports no
 * interval uses the constants as they are.
 */
export function terminalStaleWindowMs(desk: DeskState): number {
  const interval = desk.terminal?.syncIntervalMs ?? 0;
  if (!(interval > 0)) return TERMINAL_STALE_MS;
  return Math.min(MAX_ADAPTIVE_STALE_MS, Math.max(TERMINAL_STALE_MS, interval * 12));
}

/** Milliseconds since the terminal last heartbeated, or null when unlinked. */
export function terminalSilenceMs(desk: DeskState, now = Date.now()): number | null {
  if (!desk.terminal) return null;
  return Math.max(0, now - desk.terminal.lastSyncAt);
}

export function terminalIsFresh(desk: DeskState, now = Date.now()): boolean {
  const silence = terminalSilenceMs(desk, now);
  if (silence === null) return false;
  return silence <= terminalStaleWindowMs(desk);
}

/** True when the terminal is late, but not yet written off. */
export function terminalIsDegraded(desk: DeskState, now = Date.now()): boolean {
  const silence = terminalSilenceMs(desk, now);
  if (silence === null) return false;
  return silence > TERMINAL_DEGRADED_MS && terminalIsFresh(desk, now);
}

/** Why the desk cannot act right now, or null when it can. */
export function connectionProblem(desk: DeskState, now = Date.now()): string | null {
  if (!desk.terminal) return "Link a MetaTrader 5 terminal before requesting live Desk data.";
  if (!terminalIsFresh(desk, now)) {
    const silence = terminalSilenceMs(desk, now) ?? 0;
    return (
      `The MetaTrader 5 terminal has not heartbeated for ${Math.round(silence / 1000)}s ` +
      `(limit ${Math.round(terminalStaleWindowMs(desk) / 1000)}s). New analysis and entries are paused.`
    );
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
