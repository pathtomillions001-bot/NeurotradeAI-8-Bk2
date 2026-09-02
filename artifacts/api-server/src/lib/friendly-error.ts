/**
 * Friendly error messages for client-visible surfaces.
 *
 * The engines surface errors in the UI status panels (FAB activity panel, bot
 * console, trade journal `agentReasoning`). Raw infrastructure errors must
 * never reach those surfaces: a Cloudflare 502 page dumps an entire HTML
 * document into the panel, and a Deriv JSON envelope like
 * `{"errors":[{"code":"CircuitBreakerBusy", ...}]}` is meaningless to a
 * trader. This module converts raw errors into short, honest, human-readable
 * text, and classifies errors that are transient (safe to retry).
 *
 * Two entry points:
 *  - `friendlyErrorMessage(err)` — sanitize any caught error for display
 *  - `describeDerivHttpFailure(op, status, body)` — build a sanitized message
 *    at the HTTP call site (deriv.ts) so the raw body never enters an Error
 */

// ── Status / code dictionaries ────────────────────────────────────────────────

const HTTP_STATUS_TEXT: Record<number, string> = {
  400: "Rejected the request (invalid parameters)",
  401: "Session expired — please reconnect your Deriv account",
  403: "Access denied — check your API token permissions",
  404: "Endpoint not found",
  408: "Request timed out",
  429: "Rate limited by Deriv — slowing down requests",
  500: "Deriv reported an internal error",
  502: "Deriv's gateway is temporarily unreachable",
  503: "Deriv's service is temporarily unavailable",
  504: "Deriv's gateway timed out",
};

/** Statuses worth silently retrying before surfacing anything to the user. */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Known Deriv API error codes → friendly explanation (shown to traders). */
const DERIV_ERROR_CODE_TEXT: Record<string, string> = {
  CircuitBreakerBusy:
    "Deriv is running a health check on its trading service — it usually recovers within seconds",
  RateLimit: "Rate limited by Deriv — the engine will slow down automatically",
  AuthorizationRequired: "Session expired — please reconnect your Deriv account",
  InvalidToken: "Session expired — please reconnect your Deriv account",
  DisabledClient: "This Deriv account is disabled for API trading",
  InsufficientFund: "Insufficient balance for this stake",
  InputValidationFailed: "Deriv rejected the trade parameters",
};

// ── Parsing helpers ───────────────────────────────────────────────────────────

/** Does the raw text look like an HTML error page (e.g. Cloudflare 5xx)? */
function looksLikeHtml(text: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(text) || /<title>[^<]*(bad gateway|error|unavailable)[^<]*<\/title>/i.test(text);
}

/** Pull the first HTTP status code (4xx/5xx) embedded in a message, if any. */
function extractHttpStatus(text: string): number | null {
  const m = text.match(/\b(4\d{2}|5\d{2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 400 && n <= 599 ? n : null;
}

/** Pull the first Deriv error code out of an embedded JSON envelope, if any. */
function extractDerivErrorCode(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start));
    const code = parsed?.errors?.[0]?.code;
    return typeof code === "string" ? code : null;
  } catch {
    // The body may be truncated JSON — fall back to a regex probe.
    const m = text.slice(start).match(/"code"\s*:\s*"([A-Za-z0-9_]+)"/);
    return m ? m[1]! : null;
  }
}

/** Remove every HTML tag and collapse whitespace into one readable line. */
function stripHtml(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a sanitized message for a failed Deriv REST call.
 * Used at the deriv.ts call sites so raw response bodies (HTML pages, JSON
 * envelopes) never end up inside an Error message.
 */
export function describeDerivHttpFailure(
  operation: string,
  status: number,
  rawBody: string,
): string {
  const code = extractDerivErrorCode(rawBody);
  const known = code ? DERIV_ERROR_CODE_TEXT[code] : undefined;
  const statusText = HTTP_STATUS_TEXT[status] ?? `HTTP ${status}`;

  if (looksLikeHtml(rawBody)) {
    // Cloudflare / edge error page — say what it is without dumping the page.
    return `${operation} failed — Deriv's edge network returned an error page (${statusText}). This is a temporary issue on Deriv's side.`;
  }
  if (known) {
    return `${operation} failed (${statusText}) — ${known}.`;
  }
  if (code) {
    return `${operation} failed (${statusText}) — Deriv reported "${code}".`;
  }
  const cleanBody = truncate(stripHtml(rawBody), 120);
  return cleanBody
    ? `${operation} failed (${statusText}) — ${cleanBody}`
    : `${operation} failed (${statusText}).`;
}

/**
 * Is this failures transient and safe to retry silently (brief backoff)?
 * Covers HTTP 429/5xx, edge error pages, Deriv's CircuitBreakerBusy and
 * transient network failures. Auth/validation failures are NOT transient.
 */
export function isTransientDerivFailure(status: number | null | undefined, rawBody?: string): boolean {
  if (rawBody) {
    const code = extractDerivErrorCode(rawBody);
    if (code && (code === "CircuitBreakerBusy" || code === "RateLimit" || code === "TemporaryUnavailable")) {
      return true;
    }
    if (looksLikeHtml(rawBody)) return true; // edge pages are always transient
  }
  return status != null && TRANSIENT_HTTP_STATUSES.has(status);
}

/**
 * Sanitize ANY caught error into a short, human-readable line for the UI
 * panels and trade journal. Never throws. Result is at most `max` chars.
 */
export function friendlyErrorMessage(err: unknown, opts?: { max?: number }): string {
  const max = opts?.max ?? 160;
  let raw = err == null ? "" : err instanceof Error ? err.message : String(err);
  // Guard against the literal strings "undefined" / "null" leaking through as
  // displayable text (String(undefined) is not empty).
  if (!raw || !raw.trim() || raw === "undefined" || raw === "null") {
    return "An unexpected error occurred — retrying.";
  }

  // Already cleaned by describeDerivHttpFailure (or another producer)? If it
  // contains no HTML/JSON noise and is short, pass it through untouched.
  const noisy = looksLikeHtml(raw) || raw.includes('{"errors"') || raw.length > max;

  if (noisy) {
    const code = extractDerivErrorCode(raw);
    const status = extractHttpStatus(raw);
    if (code && DERIV_ERROR_CODE_TEXT[code]) {
      return truncate(DERIV_ERROR_CODE_TEXT[code]!, max);
    }
    if (code) return truncate(`Deriv reported "${code}" — this is usually temporary; retrying.`, max);
    if (looksLikeHtml(raw)) {
      const statusText = status != null ? (HTTP_STATUS_TEXT[status] ?? `HTTP ${status}`) : "a 5xx error";
      return truncate(
        `Deriv's edge network returned an error page (${statusText}) — a temporary issue on Deriv's side; retrying automatically.`,
        max,
      );
    }
    raw = stripHtml(raw);
  }

  // Common transient network failures → friendly single-liners.
  if (/econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|fetch failed|network\s*error/i.test(raw)) {
    return truncate("Connection to Deriv was interrupted — retrying automatically.", max);
  }
  if (/abnormal closure|ws was closed before the connection was established|websocket/i.test(raw) && /error|closed|fail/i.test(raw)) {
    return truncate("Deriv's trading connection dropped — reconnecting automatically.", max);
  }

  // Strip noisy lib prefixes but keep the meaningful tail.
  raw = raw.replace(/^Error:\s*/i, "").trim();
  return truncate(raw, max);
}
