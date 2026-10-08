/**
 * Multi-Asset Desk — history seeding requests.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The desk wants ~60 bars per symbol/timeframe before it analyses a market.
 * It used to ask the EA for history on EVERY heartbeat until every selected
 * series held 60 bars:
 *
 *   needsHistory = some(symbol, timeframe => !series || series.bars.length < 60)
 *
 * and the EA answered `needsHistory: 1` by re-seeding its whole batch —
 * 220 bars × 10 timeframes × 12 symbols, a multi-megabyte JSON built by MQL5
 * string concatenation — on every beat. For a series that can never reach 60
 * bars (a young symbol's W1, an unsupported timeframe, a halted contract, a
 * series whose bars the timestamp sanity check rejects) that loop never ended:
 * every heartbeat took seconds, quotes aged past the 8-second freshness gate,
 * the desk showed every selected market as STALE, and beats that exceeded the
 * EA's WebRequest timeout produced the "Reconnecting — last heartbeat 33s ago"
 * banner. One thin series froze the whole desk.
 *
 * The rule now is exact. The EA (v3.04+) reports how many bars the terminal
 * actually holds per series (`barsAvailable`); the desk asks for a series only
 * while the terminal holds bars the desk lacks:
 *
 *   ask(symbol, tf) ⟺ have < min(available, 60)
 *
 * A series the terminal cannot fill is never asked for again, a server restart
 * (empty desk) is re-seeded once, and an interrupted seed catches up. Legacy
 * EAs that report no counts fall back to a bounded rule — ask while a series
 * is missing (rotation-sized cap) or short (two re-asks) — so they cannot loop
 * forever either.
 */

import { maxStorableBars } from "./integrity";
import { candleKey, type DeskState } from "./store";
import { TIMEFRAMES } from "./types";

/** Bars the desk wants per series before it stops asking the terminal. */
export const HISTORY_TARGET_BARS = 60;

/**
 * Legacy EA (no bar counts): how many heartbeats a series that never appears
 * may be requested for. Sized to cover the EA's rotating candle batch for
 * watchlists of roughly 190 symbols (16 beats × 12 symbols), while still
 * bounding an unseedable series to a finite number of heavy re-seed beats.
 */
export const LEGACY_HISTORY_MAX_REQUESTS = 16;

/** Legacy EA: re-asks for a series that exists but is short (interrupted seed). */
export const LEGACY_RESEED_MAX_REQUESTS = 2;

/**
 * Parse the EA's `barsAvailable` map (`{"EURUSD|M1": 5231, ...}`). Counts are
 * clamped to a sane maximum; zero counts are kept — a series the terminal has
 * no bars for must never be requested.
 */
export function parseBarsAvailable(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.includes("|")) continue;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) continue;
    out.set(key, Math.min(Math.trunc(parsed), 10_000_000));
  }
  return out;
}

/**
 * The `symbol|timeframe` keys the desk still needs history for.
 *
 * `reported` is the set of symbols the EA has sent specs for this session —
 * asking for history on a symbol the terminal has not described is pointless.
 */
export function computeHistoryNeeded(desk: DeskState, reported: Set<string>): string[] {
  const keys: string[] = [];
  for (const symbol of desk.watchlist) {
    if (!reported.has(symbol)) continue;
    for (const timeframe of TIMEFRAMES) {
      const key = candleKey(symbol, timeframe);
      const have = desk.candles.get(key)?.bars.length ?? 0;
      const available = desk.historyAvailable.get(key);
      if (available !== undefined) {
        // Precise rule: ask only while the terminal holds bars the desk
        // lacks. The target is also capped by what the desk can STORE — the
        // ingest gate rejects bars older than 400 days, so W1 can never hold
        // 60 bars; demanding 60 there would re-seed that one series on every
        // heartbeat, forever.
        const target = Math.min(available, HISTORY_TARGET_BARS, maxStorableBars(timeframe));
        if (have < target) keys.push(key);
        continue;
      }
      // Legacy EA without bar counts: bound every demand so no series can
      // keep a full re-seed alive forever.
      const asked = desk.historyRequests.get(key) ?? 0;
      if (have === 0) {
        if (asked < LEGACY_HISTORY_MAX_REQUESTS) keys.push(key);
      } else if (have < HISTORY_TARGET_BARS && asked < LEGACY_RESEED_MAX_REQUESTS) {
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * Count one more heartbeat asking a legacy EA for these keys. Keys the EA
 * reports bar counts for are exact and need no cap.
 */
export function recordLegacyHistoryRequests(desk: DeskState, keys: string[]): void {
  for (const key of keys) {
    if (desk.historyAvailable.has(key)) continue;
    desk.historyRequests.set(key, (desk.historyRequests.get(key) ?? 0) + 1);
  }
}
