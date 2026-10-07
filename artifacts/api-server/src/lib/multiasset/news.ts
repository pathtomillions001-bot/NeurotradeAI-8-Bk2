/**
 * Fail-closed handling for high-impact events from the attached MT5 calendar.
 * The terminal feed is the source of truth; timestamps alone are not enough —
 * a recent, successful snapshot must cover the active window and near future.
 */

import type { HighImpactNewsEvent, NewsCalendarSnapshot, SymbolSpec } from "./types";

export const NEWS_CALENDAR_MAX_AGE_MS = 10 * 60_000;
export const NEWS_BLACKOUT_BEFORE_MS = 30 * 60_000;
export const NEWS_BLACKOUT_AFTER_MS = 15 * 60_000;
export const NEWS_REQUIRED_LOOKBACK_MS = NEWS_BLACKOUT_AFTER_MS;
export const NEWS_REQUIRED_LOOKAHEAD_MS = 60 * 60_000;

export type NewsCalendarStatus = "unknown" | "ready" | "stale" | "unavailable";

export interface NewsGuardInput {
  ready: boolean;
  error: string | null;
  events: HighImpactNewsEvent[];
  blackoutBeforeMs: number;
  blackoutAfterMs: number;
}

export interface NewsGateResult {
  allowed: boolean;
  reason: string | null;
  event: HighImpactNewsEvent | null;
}

export function getNewsCalendarStatus(
  snapshot: NewsCalendarSnapshot,
  now = Date.now(),
): NewsCalendarStatus {
  if (snapshot.status === "unknown") return "unknown";
  if (snapshot.status === "unavailable") return "unavailable";
  if (!isNewsCalendarReady(snapshot, now)) return "stale";
  return "ready";
}

export function isNewsCalendarReady(snapshot: NewsCalendarSnapshot, now = Date.now()): boolean {
  if (snapshot.status !== "ready" || snapshot.error) return false;
  const fetchedAt = snapshot.fetchedAt;
  const coverageStart = snapshot.coverageStart;
  const coverageEnd = snapshot.coverageEnd;
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(coverageStart) || !Number.isFinite(coverageEnd)) {
    return false;
  }
  if (fetchedAt! > now + 30_000 || now - fetchedAt! > NEWS_CALENDAR_MAX_AGE_MS) return false;
  if (coverageStart! > now - NEWS_REQUIRED_LOOKBACK_MS) return false;
  if (coverageEnd! < now + NEWS_REQUIRED_LOOKAHEAD_MS) return false;
  return true;
}

/**
 * Resolve the currencies whose releases can materially affect an instrument.
 * For broker CFDs without usable currency metadata we treat every high-impact
 * release as relevant rather than guessing that one is safe to ignore.
 */
export function eventMatchesSpec(event: HighImpactNewsEvent, spec: SymbolSpec | undefined): boolean {
  const currency = event.currency.trim().toUpperCase();
  if (!currency || currency === "*") return true;
  if (!spec) return true;

  const instrumentCurrencies = [spec.baseCurrency, spec.quoteCurrency]
    .map((value) => String(value ?? "").trim().toUpperCase())
    .filter((value) => /^[A-Z]{3}$/.test(value));
  if (instrumentCurrencies.length === 0) return true;
  return instrumentCurrencies.includes(currency);
}

export function relevantNewsEvents(
  events: HighImpactNewsEvent[],
  spec: SymbolSpec | undefined,
): HighImpactNewsEvent[] {
  return events.filter((event) => eventMatchesSpec(event, spec));
}

export function assessNewsEntry(
  news: NewsGuardInput,
  spec: SymbolSpec | undefined,
  now = Date.now(),
): NewsGateResult {
  if (!news.ready) {
    const detail = news.error ? ` (${news.error})` : "";
    return {
      allowed: false,
      reason: `High-impact MT5 news calendar is unavailable, stale, or lacks coverage${detail}; new entries are blocked until a complete current snapshot is confirmed.`,
      event: null,
    };
  }

  const active = relevantNewsEvents(news.events, spec)
    .filter((event) => now >= event.ts - news.blackoutBeforeMs && now <= event.ts + news.blackoutAfterMs)
    .sort((a, b) => a.ts - b.ts)[0];
  if (active) {
    const start = new Date(active.ts - news.blackoutBeforeMs).toISOString();
    const end = new Date(active.ts + news.blackoutAfterMs).toISOString();
    return {
      allowed: false,
      reason: `${active.currency} high-impact news blackout${active.title ? `: ${active.title}` : ""} (${start} to ${end} UTC).`,
      event: active,
    };
  }
  return { allowed: true, reason: null, event: null };
}

export function newsGuardFromSnapshot(
  snapshot: NewsCalendarSnapshot,
  now = Date.now(),
): NewsGuardInput {
  const status = getNewsCalendarStatus(snapshot, now);
  return {
    ready: status === "ready",
    error: status === "ready" ? null : snapshot.error ?? (status === "stale" ? "snapshot stale or coverage incomplete" : null),
    events: snapshot.events,
    blackoutBeforeMs: NEWS_BLACKOUT_BEFORE_MS,
    blackoutAfterMs: NEWS_BLACKOUT_AFTER_MS,
  };
}
