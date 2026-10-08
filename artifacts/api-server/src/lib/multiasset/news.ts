/**
 * High-impact economic-calendar safety gate.
 *
 * MT5's local calendar is the source of these events. We deliberately do not
 * substitute a public-web scrape or a guessed schedule: if the terminal cannot
 * confirm the calendar is available, new entries fail closed.
 */

import type { HighImpactNewsEvent, NewsFeed, SymbolSpec, TradeMode } from "./types";

export type NewsGateStatus = "clear" | "blackout" | "unavailable";

export interface NewsGate {
  status: NewsGateStatus;
  blocked: boolean;
  /** Human-readable reason suitable for the desk and journal. */
  reason: string | null;
  relevantEvents: HighImpactNewsEvent[];
  checkedAt: number | null;
}

const NEWS_MAX_AGE_MS = 5 * 60_000;

/**
 * How far ahead the desk's red-folder panel looks.
 *
 * Twenty-four hours, deliberately: it is the window the EA itself fetches from
 * the MT5 calendar (`CalendarValueHistory(now - 15 min, now + 24 h)`), and it is
 * the horizon over which a trader can actually act on an event — a swing entry
 * planned today must know what releases tomorrow. Events are never dropped for
 * being "too far away"; anything beyond the window is simply not fetched.
 */
export const NEWS_LOOKAHEAD_MS = 24 * 60 * 60_000;

/**
 * How long after an event it remains listed.
 *
 * Twelve hours, not fifteen minutes. The pane is the user's evidence that the
 * news gate is doing its job, and "0 red-folder events" reads as a bug when the
 * terminal's own calendar shows three releases earlier the same day. A release
 * that has already passed is not actionable, but it IS the explanation for a
 * quiet session — so it stays on the list, marked as passed, for the rest of the
 * trading day.
 */
export const NEWS_LOOKBEHIND_MS = 12 * 60 * 60_000;

export interface UpcomingNewsEvent {
  id: string;
  time: number;
  currency: string;
  country: string;
  name: string;
  importance: "high";
  actual?: number | null;
  forecast?: number | null;
  previous?: number | null;
  /** Milliseconds from `now` to the event. Negative once it has started. */
  inMs: number;
  /** True for the very next event that has not started yet. */
  next: boolean;
  /** True once the release is behind us — listed for context, not actionable. */
  passed: boolean;
}

/**
 * Red-folder events from the last 12 hours through the next 24, in order.
 *
 * The calendar PANE must not have to guess which events are in scope, and it
 * must not silently disagree with the gate that blocks entries — the gate looks
 * at the same event list, so both are derived here. Events already released are
 * included (flagged `passed`) so a quiet session can be read against the day's
 * releases instead of against an empty list.
 */
export function upcomingRedFolder(
  events: HighImpactNewsEvent[],
  now = Date.now(),
  horizonMs = NEWS_LOOKAHEAD_MS,
): UpcomingNewsEvent[] {
  const window = events
    .filter((event) => event.importance === "high")
    .filter((event) => event.time >= now - NEWS_LOOKBEHIND_MS && event.time <= now + horizonMs)
    .sort((a, b) => a.time - b.time);

  const firstUpcoming = window.find((event) => event.time >= now)?.id ?? null;
  return window.map((event) => ({
    ...event,
    inMs: event.time - now,
    next: event.id === firstUpcoming,
    passed: event.time < now,
  }));
}

/** New entries are paused ahead of a red-folder event and shortly after it. */
function blackoutWindow(mode: TradeMode): { beforeMs: number; afterMs: number } {
  switch (mode) {
    case "scalp":
      return { beforeMs: 30 * 60_000, afterMs: 20 * 60_000 };
    case "swing":
      return { beforeMs: 20 * 60_000, afterMs: 10 * 60_000 };
    default:
      return { beforeMs: 30 * 60_000, afterMs: 15 * 60_000 };
  }
}

/**
 * Currency relevance comes from the broker's specification, never a guessed
 * symbol spelling. Metals, indices and CFDs normally expose their profit
 * currency, so an imminent USD release still pauses a USD-denominated market.
 */
export function currenciesForNews(spec: SymbolSpec): string[] {
  return [...new Set([spec.baseCurrency, spec.quoteCurrency]
    .map((value) => value?.trim().toUpperCase())
    .filter((value): value is string => Boolean(value && /^[A-Z]{3}$/.test(value))))];
}

function isRelevant(event: HighImpactNewsEvent, currencies: string[]): boolean {
  const currency = event.currency.trim().toUpperCase();
  // If the broker does not identify an instrument currency, conservatively
  // treat every red-folder event as relevant instead of silently trading it.
  return currencies.length === 0 || !currency || currencies.includes(currency);
}

/**
 * Decide whether a new entry is allowed. Existing positions are still managed
 * by the EA during a blackout; this gate only prevents fresh risk from being
 * opened around a high-impact release.
 */
export function assessNewsGate(
  spec: SymbolSpec,
  feed: NewsFeed | null | undefined,
  mode: TradeMode,
  now = Date.now(),
): NewsGate {
  if (!feed?.available) {
    return {
      status: "unavailable",
      blocked: true,
      reason: "High-impact economic-calendar status is unavailable; new entries are paused.",
      relevantEvents: [],
      checkedAt: feed?.checkedAt ?? null,
    };
  }

  if (!Number.isFinite(feed.checkedAt) || now - feed.checkedAt > NEWS_MAX_AGE_MS) {
    return {
      status: "unavailable",
      blocked: true,
      reason: "High-impact economic-calendar feed is stale; new entries are paused.",
      relevantEvents: [],
      checkedAt: feed.checkedAt,
    };
  }

  const currencies = currenciesForNews(spec);
  const { beforeMs, afterMs } = blackoutWindow(mode);
  const relevantEvents = feed.events
    .filter((event) => event.importance === "high" && isRelevant(event, currencies))
    .filter((event) => now >= event.time - beforeMs && now <= event.time + afterMs)
    .sort((a, b) => a.time - b.time);

  if (relevantEvents.length === 0) {
    return { status: "clear", blocked: false, reason: null, relevantEvents: [], checkedAt: feed.checkedAt };
  }

  const event = relevantEvents[0] as HighImpactNewsEvent;
  const minutes = Math.round((event.time - now) / 60_000);
  const timing = minutes > 0 ? `in ${minutes} min` : minutes < 0 ? `${Math.abs(minutes)} min ago` : "now";
  return {
    status: "blackout",
    blocked: true,
    reason: `High-impact ${event.currency || "market"} event: ${event.name} (${timing}). New entries are paused.`,
    relevantEvents,
    checkedAt: feed.checkedAt,
  };
}

/** Fresh, empty calendars are valid; absent calendars are not. */
export function emptyAvailableNewsFeed(now = Date.now()): NewsFeed {
  return { available: true, checkedAt: now, events: [] };
}
