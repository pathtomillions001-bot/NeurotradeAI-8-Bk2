/**
 * Browser identity — durable + per-tab.
 *
 * TWO identities travel on every same-origin /api request:
 *
 *  1. `X-Client-Id` — a DURABLE id kept in `localStorage` (and mirrored in a
 *     1-year HttpOnly cookie). It is minted once per browser profile and is
 *     never rotated by connect/disconnect. It is what makes a connected Deriv
 *     account stay connected across new tabs, closed tabs, browser restarts and
 *     mobile tab eviction — the server links it to the account-scoped session
 *     and re-binds any tab that lost its own identity (see session_links).
 *
 *  2. `X-Tab-Session` — a PER-TAB id kept in `sessionStorage`, so two tabs in
 *     one profile can hold two different Deriv accounts without the second
 *     connect hijacking the first (the account cookie is shared across tabs).
 *
 * The server resolves these against its link table and returns the identity it
 * actually used in the `x-session-id` response header; `adoptTabSessionId`
 * stores it, so a tab that inherited the durable binding self-heals without a
 * reload. SSE EventSources cannot set headers, so both ids also travel as query
 * params via `withTabSession`.
 *
 * The risk acknowledgment travels the same way (`X-Risk-Ack` header, value in
 * sessionStorage): the acknowledgment is signed over one session id, so a
 * single shared cookie could never stay valid for two tabs at once.
 */

const TAB_SESSION_KEY = "neurotrade_tab_session";
const CLIENT_ID_KEY = "neurotrade_client_id";
const RISK_ACK_KEY = "neurotrade_risk_ack";

export const TAB_SESSION_HEADER = "x-tab-session";
export const TAB_SESSION_QUERY_PARAM = "tabSession";
export const CLIENT_ID_HEADER = "x-client-id";
export const CLIENT_ID_QUERY_PARAM = "clientId";
export const RESOLVED_SESSION_HEADER = "x-session-id";
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

function readStorage(store: "local" | "session", key: string): string | null {
  try {
    const value = (store === "local" ? localStorage : sessionStorage).getItem(key);
    return value && SESSION_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStorage(store: "local" | "session", key: string, value: string): void {
  try {
    (store === "local" ? localStorage : sessionStorage).setItem(key, value);
  } catch {
    /* storage unavailable (private mode / blocked cookies) — id still works this page life */
  }
}

/**
 * DURABLE browser identity — survives new tabs, tab close, browser restart.
 * Deliberately in localStorage (NOT sessionStorage): sessionStorage is cleared
 * the moment the tab closes, which is exactly when users expect to still be
 * signed in.
 */
export function getClientId(): string {
  let id = readStorage("local", CLIENT_ID_KEY);
  if (!id) {
    // One-time migration from the legacy per-tab id so an already-connected
    // visitor keeps their account after this deploy.
    id = readStorage("session", TAB_SESSION_KEY) ?? newSessionId();
    writeStorage("local", CLIENT_ID_KEY, id);
  }
  return id;
}

/** This tab's session id, minted once and kept in per-tab sessionStorage. */
export function getTabSessionId(): string {
  let id = readStorage("session", TAB_SESSION_KEY);
  if (!id) {
    id = newSessionId();
    writeStorage("session", TAB_SESSION_KEY, id);
  }
  return id;
}

/**
 * Adopt a server-issued session id (connect/disconnect rotation, or the
 * resolved identity returned in `x-session-id`). Invalid values are ignored so
 * a malformed response can never desync the tab.
 */
export function adoptTabSessionId(sessionId: unknown): void {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId))
    return;
  writeStorage("session", TAB_SESSION_KEY, sessionId);
  actions.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must never break identity handling */
    }
  });
}

// ── Session-change notifications ──────────────────────────────────────────────
// Pages cache Deriv-account data keyed by nothing (react-query keys are plain
// URLs), so when the server switches the session under them (a new tab
// inheriting the durable binding, or a connect/disconnect rotation) they must
// refetch. Listeners are notified only on an actual change.
const actions = new Set<() => void>();

export function onSessionChange(listener: () => void): () => void {
  actions.add(listener);
  return () => actions.delete(listener);
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
 * Append tab + durable identity to an SSE/EventSource URL (EventSource cannot
 * set headers, and a cross-site iframe may hide the cookies from the server).
 */
export function withTabSession(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return (
    `${url}${sep}${TAB_SESSION_QUERY_PARAM}=${encodeURIComponent(getTabSessionId())}` +
    `&${CLIENT_ID_QUERY_PARAM}=${encodeURIComponent(getClientId())}`
  );
}

function isSameOriginApi(url: string): boolean {
  if (typeof window === "undefined") return false;
  const sameOrigin =
    url.startsWith("/") || url.startsWith(window.location.origin);
  return sameOrigin && url.includes("/api");
}

let fetchPatchInstalled = false;

/**
 * Install a one-time global fetch patch that attaches both identities (and the
 * tab's risk acknowledgment, when present) to every same-origin /api request.
 * Covers orval hooks (customFetch calls global fetch) and every raw fetch call
 * site with zero per-call changes. External requests pass through untouched;
 * explicitly-set headers are never overwritten.
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
    if (!headers.has(CLIENT_ID_HEADER))
      headers.set(CLIENT_ID_HEADER, getClientId());
    const ack = getTabRiskAck();
    if (ack && !headers.has(RISK_ACK_HEADER)) headers.set(RISK_ACK_HEADER, ack);
    const response = await originalFetch(input, { ...init, headers });
    // Server-resolved identity: keep this tab pointed at the session that
    // actually served it (durable-binding inheritance, connect rotation…).
    const resolved = response.headers.get(RESOLVED_SESSION_HEADER);
    if (resolved && resolved !== readStorage("session", TAB_SESSION_KEY)) {
      adoptTabSessionId(resolved);
    }
    return response;
  }) as typeof fetch;
}
