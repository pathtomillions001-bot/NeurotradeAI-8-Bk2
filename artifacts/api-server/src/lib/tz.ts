/**
 * Shared timezone-offset store + midnight scheduler.
 *
 * The browser sends its `getTimezoneOffset()` value (UTC − localTime in
 * minutes) via `POST /api/ai/day-reset` on page-load so the server knows
 * when the user's midnight actually is.
 *
 * Convention (matches browser's Date.prototype.getTimezoneOffset):
 *   UTC+5:30 → offset = -330   (local time is 330 min AHEAD of UTC)
 *   UTC-5    → offset = +300   (local time is 300 min BEHIND UTC)
 */

import { logger } from "./logger";

// ── Timezone offset (minutes, browser convention) ─────────────────────────────
let tzOffsetMin = 0;           // default to UTC until client connects
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
let _onMidnight: (() => void) | null = null;

export function getTzOffset(): number {
  return tzOffsetMin;
}

/**
 * Called by the frontend on every page-load.  Updates the offset and
 * immediately reschedules the midnight timer for the new timezone.
 */
export function setTzOffset(offset: number): void {
  tzOffsetMin = offset;
  scheduleNextMidnight();
}

/**
 * Register the callback that fires at every local midnight.
 * Called once from app.ts at server startup.
 */
export function registerMidnightCallback(cb: () => void): void {
  _onMidnight = cb;
}

/**
 * Compute ms until the next local midnight (in the stored timezone)
 * and (re-)schedule the one-shot timer.  Self-reschedules after each fire.
 */
export function scheduleNextMidnight(): void {
  if (midnightTimer) {
    clearTimeout(midnightTimer);
    midnightTimer = null;
  }

  const tzMin = tzOffsetMin;
  const now = new Date();

  // Shift current time into user's local frame
  const localNow = new Date(now.getTime() - tzMin * 60_000);

  // Find the next local midnight
  const nextLocalMidnight = new Date(localNow);
  nextLocalMidnight.setUTCDate(nextLocalMidnight.getUTCDate() + 1);
  nextLocalMidnight.setUTCHours(0, 0, 0, 0);

  // Convert back to UTC wall-clock time
  const nextMidnightUtc = new Date(nextLocalMidnight.getTime() + tzMin * 60_000);
  const msUntil = Math.max(nextMidnightUtc.getTime() - now.getTime(), 1_000);

  midnightTimer = setTimeout(() => {
    logger.info({ tzOffsetMin: tzMin }, "Server midnight reset firing");
    _onMidnight?.();
    scheduleNextMidnight(); // schedule for the next midnight
  }, msUntil);

  logger.info(
    {
      msUntilMinutes: Math.round(msUntil / 60_000),
      nextMidnightUtc: nextMidnightUtc.toISOString(),
      tzOffsetMin: tzMin,
    },
    "Midnight reset scheduled",
  );
}

/** Convenience helper: local midnight timestamp for a given Date. */
export function getLocalTodayStart(tz = tzOffsetMin): Date {
  const now = new Date();
  const localNow = new Date(now.getTime() - tz * 60_000);
  localNow.setUTCHours(0, 0, 0, 0);
  return new Date(localNow.getTime() + tz * 60_000);
}

/** ISO date string (YYYY-MM-DD) in user's local timezone. */
export function getLocalTodayKey(tz = tzOffsetMin): string {
  const now = new Date();
  const localNow = new Date(now.getTime() - tz * 60_000);
  localNow.setUTCHours(0, 0, 0, 0);
  return localNow.toISOString().slice(0, 10);
}
