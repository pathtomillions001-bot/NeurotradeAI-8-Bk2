/**
 * WP10 — alerts the desk sends when it does something a human should know about.
 *
 * ── WHY THIS IS SMALL, AND WHY IT IS FLAGGED ────────────────────────────────
 *
 * An alert channel is not a trading feature, so it must not be able to affect a
 * trade. Three rules make that true:
 *
 *   1. **Never on the decision path.** `deskAlert` returns immediately and the
 *      send happens after; nothing awaits it. A Telegram outage cannot delay an
 *      arm, a close, or a heartbeat.
 *   2. **Never throws.** Every failure — no token, HTTP 500, a network that hangs —
 *      is swallowed and reported in the return value for the caller's journal.
 *   3. **Off unless asked for, and off without credentials.** `DESK_V4_ALERTS`
 *      defaults to OFF, and with no `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` the
 *      module is inert even when the flag is on: a desk with no channel configured
 *      simply does not have one.
 *
 * ── THE TWO THINGS THAT MAKE AN ALERT CHANNEL USELESS ───────────────────────
 *
 * A storm and a leak. The desk de-duplicates on a KEY within a window (the same
 * halt is one message, not one per heartbeat) and caps the send rate (a token
 * bucket), because a channel that fills with repeats gets muted, and a muted
 * channel is worse than none. Nothing here prints an account number or a token:
 * the message carries the session, the symbol and the desk's own numbers.
 */
import { deskV4, v4On } from "./desk-v4-config";

export type AlertKind = "governance" | "risk" | "execution" | "session";

export interface AlertRequest {
  kind: AlertKind;
  /** The one-line headline. */
  title: string;
  /** Extra lines, printed as-is. */
  body?: string[];
  /** De-duplication key: the same key inside the window is one message. */
  dedupeKey: string;
  sessionId: string;
  nowMs?: number;
  /** Telegram chat override; defaults to the configured chat. */
  chatId?: string;
}

export interface AlertResult {
  sent: boolean;
  /** Why not, when `sent` is false. Machine-readable. */
  reason?: "flag_off" | "no_transport" | "duplicate" | "rate_limited" | "failed";
  detail?: string;
}

/** One message per key per 10 minutes: a halt is not news every heartbeat. */
export const ALERT_DEDUPE_MS = 10 * 60_000;
/** At most this many sends per minute, across every kind. */
export const ALERT_RATE_PER_MINUTE = 12;
/** Requests are abandoned after this long — a slow channel must not pile up. */
export const ALERT_TIMEOUT_MS = 5_000;

export type AlertTransport = (input: {
  text: string;
  chatId: string;
  token: string;
  timeoutMs: number;
}) => Promise<{ ok: boolean; detail?: string }>;

const lastSentByKey = new Map<string, number>();
const recentSends: number[] = [];

/** Test-only: forget the de-dupe window and the rate bucket. */
export function resetAlertsForTests(): void {
  lastSentByKey.clear();
  recentSends.length = 0;
  transport = defaultTransport;
}

let transport: AlertTransport = defaultTransport;

/** Test-only (and embedding) transport injection. */
export function setAlertTransportForTests(next: AlertTransport | null): void {
  transport = next ?? defaultTransport;
}

/** The transport the desk ships: one HTTPS POST to the Bot API. */
async function defaultTransport(input: {
  text: string;
  chatId: string;
  token: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${input.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        // No Markdown: a plan id or a symbol containing an underscore would
        // otherwise be rejected by Telegram's parser and the alert lost.
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // The body is bounded and never contains the token; keep the first line.
      const text = await response.text().catch(() => "");
      return { ok: false, detail: `HTTP ${response.status} ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function credentials(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

/**
 * Send one alert. Never throws, never blocks on anything the caller needs.
 *
 * The promise resolves to a result so the caller can journal "sent" or "suppressed
 * (duplicate)" — an alert that failed silently in the logs would otherwise look
 * exactly like an alert that was never needed.
 */
export async function deskAlert(request: AlertRequest): Promise<AlertResult> {
  const nowMs = request.nowMs ?? Date.now();
  if (!v4On(deskV4().alerts)) return { sent: false, reason: "flag_off" };

  const previous = lastSentByKey.get(`${request.sessionId}|${request.dedupeKey}`);
  if (previous !== undefined && nowMs - previous < ALERT_DEDUPE_MS) {
    return { sent: false, reason: "duplicate" };
  }
  // Drop sends that have fallen out of the rate window before counting this one.
  while (recentSends.length > 0 && nowMs - (recentSends[0] as number) > 60_000) recentSends.shift();
  if (recentSends.length >= ALERT_RATE_PER_MINUTE) return { sent: false, reason: "rate_limited" };

  const creds = credentials();
  if (!creds) return { sent: false, reason: "no_transport" };

  const chatId = request.chatId ?? creds.chatId;
  const header = `[${request.kind.toUpperCase()}] ${request.title}`;
  const session = request.sessionId.length > 12 ? `${request.sessionId.slice(0, 12)}…` : request.sessionId;
  const text = [header, ...(request.body ?? []), `session ${session}`].join("\n");

  // Count the attempt before it is made: a channel that is down must still be
  // rate-limited, or a retry storm would hit it exactly when it is weakest.
  recentSends.push(nowMs);
  lastSentByKey.set(`${request.sessionId}|${request.dedupeKey}`, nowMs);

  // A transport is code, and code throws: an injected one, a future one, or this
  // one if a runtime's fetch is missing. The contract of `deskAlert` is that the
  // CALLER never sees an exception, so the boundary is enforced here rather than
  // assumed of the transport.
  let result: { ok: boolean; detail?: string };
  try {
    result = await transport({ text, chatId, token: creds.token, timeoutMs: ALERT_TIMEOUT_MS });
  } catch (error) {
    result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) {
    // A failed send must not suppress the next real one for ten minutes.
    lastSentByKey.delete(`${request.sessionId}|${request.dedupeKey}`);
    return { sent: false, reason: "failed", detail: result.detail };
  }
  return { sent: true };
}

/**
 * Fire-and-forget wrapper for the trading paths: identical semantics, and the
 * caller never has a promise to handle.
 */
export function deskAlertNow(request: AlertRequest): void {
  void deskAlert(request).catch(() => {});
}
