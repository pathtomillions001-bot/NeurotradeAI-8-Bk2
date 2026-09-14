/**
 * Per-tab session identity.
 *
 * HttpOnly cookies are shared by every tab in a browser profile, so two tabs
 * connected to two DIFFERENT Deriv accounts cannot be told apart by cookie
 * alone — the second connect would rotate the shared cookie and hijack the
 * first tab's identity (its engine toggles, journal and trades would suddenly
 * target the other account).
 *
 * Each tab therefore ALSO carries its own session id, kept in `sessionStorage`
 * (which is per-tab by design):
 *
 *   - `X-Tab-Session` header on every fetch/XHR (installed once globally by
 *     installTabSessionFetchPatch — every orval hook and every raw fetch call
 *     is covered with no per-call-site changes), and
 *   - `?tabSession=` query param on SSE EventSources (EventSource cannot set
 *     headers — see withTabSession).
 *
 * The server prefers the tab identity over the cookie and never writes cookies
 * for tab-identified requests, so tabs stay fully independent even in the same
 * profile. When the server rotates the session (connect → account session,
 * disconnect → fresh anonymous id) it returns the new id in the response body
 * and the tab adopts it via adoptTabSessionId.
 *
 * The risk acknowledgment travels the same way (`X-Risk-Ack` header, value in
 * sessionStorage): the acknowledgment is signed over one session id, so a
 * single shared cookie could never stay valid for two tabs at once.
 */

const TAB_SESSION_KEY = "neurotrade_tab_session";
const RISK_ACK_KEY = "neurotrade_risk_ack";

export const TAB_SESSION_HEADER = "x-tab-session";
export const TAB_SESSION_QUERY_PARAM = "tabSession";
export const RISK_ACK_HEADER = "x-risk-ack";

const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;

function newSessionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (http on a LAN IP): Math.random UUIDv4.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** This tab's session id, minted once and kept in per-tab sessionStorage. */
export function getTabSessionId(): string {
  let id: string | null = null;
  try {
    id = sessionStorage.getItem(TAB_SESSION_KEY);
  } catch {
    id = null;
  }
  if (!id || !SESSION_ID_PATTERN.test(id)) {
    id = newSessionId();
    try {
      sessionStorage.setItem(TAB_SESSION_KEY, id);
    } catch {
      /* storage unavailable — the id still identifies this page lifetime */
    }
  }
  return id;
}

/**
 * Adopt a server-issued session id (connect/disconnect rotation). Invalid
 * values are ignored so a malformed response can never desync the tab.
 */
export function adoptTabSessionId(sessionId: unknown): void {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId))
    return;
  try {
    sessionStorage.setItem(TAB_SESSION_KEY, sessionId);
  } catch {
    /* ignore */
  }
}

/** Signed risk-acknowledgment value for this tab (if it accepted). */
export function getTabRiskAck(): string | null {
  try {
    return sessionStorage.getItem(RISK_ACK_KEY);
  } catch {
    return null;
  }
}

export function setTabRiskAck(value: unknown): void {
  if (typeof value !== "string" || !value) return;
  try {
    sessionStorage.setItem(RISK_ACK_KEY, value);
  } catch {
    /* ignore */
  }
}

export function clearTabRiskAck(): void {
  try {
    sessionStorage.removeItem(RISK_ACK_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Append the tab identity to an SSE/EventSource URL (EventSource cannot set
 * headers, so the server also accepts `?tabSession=`).
 */
export function withTabSession(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${TAB_SESSION_QUERY_PARAM}=${encodeURIComponent(getTabSessionId())}`;
}

function isSameOriginApi(url: string): boolean {
  if (typeof window === "undefined") return false;
  const sameOrigin =
    url.startsWith("/") || url.startsWith(window.location.origin);
  return sameOrigin && url.includes("/api");
}

let fetchPatchInstalled = false;

/**
 * Install a one-time global fetch patch that attaches the tab identity (and
 * the tab's risk acknowledgment, when present) to every same-origin /api
 * request. Covers orval hooks (customFetch calls global fetch) and every raw
 * fetch call site with zero per-call changes. External requests pass through
 * untouched; explicitly-set headers are never overwritten.
 */
export function installTabSessionFetchPatch(): void {
  if (
    fetchPatchInstalled ||
    typeof window === "undefined" ||
    typeof window.fetch !== "function"
  )
    return;
  fetchPatchInstalled = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!isSameOriginApi(url)) return originalFetch(input, init);
    const baseHeaders =
      init?.headers ??
      (typeof input !== "string" && !(input instanceof URL)
        ? input.headers
        : undefined);
    const headers = new Headers(baseHeaders);
    if (!headers.has(TAB_SESSION_HEADER))
      headers.set(TAB_SESSION_HEADER, getTabSessionId());
    const ack = getTabRiskAck();
    if (ack && !headers.has(RISK_ACK_HEADER)) headers.set(RISK_ACK_HEADER, ack);
    return originalFetch(input, { ...init, headers });
  }) as typeof fetch;
}
