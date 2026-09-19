import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

const SESSION_COOKIE = "neurotrade_session";
const RISK_COOKIE = "neurotrade_risk_ack";
/**
 * Durable browser identity.
 *
 * ONE value per browser profile, kept for a year, mirrored in localStorage and
 * sent as `X-Client-Id` on every request. Unlike the session id it is never
 * rotated by connect/disconnect, so it survives the loss of `sessionStorage`
 * (new tab, closed tab, browser restart, mobile eviction) — see session_links.
 */
const CLIENT_COOKIE = "neurotrade_client";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const sessionContext = new AsyncLocalStorage<string>();

/**
 * Per-tab session identity.
 *
 * HttpOnly cookies are shared by every tab in a browser profile, so two tabs
 * connected to two different Deriv accounts cannot be told apart by cookie
 * alone — the second connect would rotate the shared cookie and hijack the
 * first tab's identity. The web app therefore ALSO sends its tab-scoped
 * session id (kept in `sessionStorage`, which is per-tab) on every request:
 *
 *   - `X-Tab-Session` header on every fetch/XHR (see tab-session.ts), and
 *   - `?tabSession=` query param on the SSE EventSource (EventSource cannot
 *     set headers).
 *
 * A tab identity is only the FIRST step of resolution, never the last. It is
 * resolved against `session_links` (see resolveSessionIdentity) so that a tab
 * with no binding of its own inherits the durable browser binding instead of
 * becoming an anonymous visitor — the root cause of "the app logged me out".
 */
export const TAB_SESSION_HEADER = "x-tab-session";
export const TAB_SESSION_QUERY_PARAM = "tabSession";
export const CLIENT_ID_QUERY_PARAM = "clientId";
/** Durable browser identity sent by the web app (localStorage mirror). */
export const CLIENT_ID_HEADER = "x-client-id";
/** Response header telling the client which session id actually served it. */
export const RESOLVED_SESSION_HEADER = "x-session-id";
/** Tab-scoped risk acknowledgment (cookies can't hold one value per tab). */
export const RISK_ACK_HEADER = "x-risk-ack";

const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;

/** Current browser session, propagated through route promises and engine timers. */
export function getBrowserSessionId(): string {
  return sessionContext.getStore() ?? "legacy";
}

/**
 * Run `fn` with `sessionId` as the ambient browser session.
 *
 * Engine loops, cooldown timers and startup resume run outside any request,
 * so without this they would all share the "legacy" fallback bucket in every
 * session-scoped store (recovery ledger, signal pools, adaptive thresholds…
 * — see createSessionScoped). Every background entry point MUST wrap itself
 * so concurrent accounts can never read or write each other's state.
 */
export function runWithSessionId<T>(sessionId: string, fn: () => T): T {
  return sessionContext.run(sessionId, fn);
}

/**
 * Create one piece of session-scoped mutable state, addressed through the
 * ambient browser session (see runWithSessionId / browserSession middleware).
 *
 * Returns a Proxy that routes every property read/write to the calling
 * session's own instance, plus a `replace()` for whole-state resets (a Proxy
 * cannot intercept variable reassignment, so `state = {...}` sites must call
 * `replace({...})` instead — it clears stale keys first, exactly like a
 * reassignment would).
 *
 * This is the same pattern recovery-engine.ts already uses; it lets engine
 * modules keep every `session.foo` line untouched while each connected Deriv
 * account gets a fully independent engine instance.
 */
export function createSessionScoped<T extends object>(factory: () => T): {
  readonly state: T;
  replace(next: T): void;
} {
  const statesBySession = new Map<string, T>();
  const active = (): T => {
    const key = getBrowserSessionId();
    let current = statesBySession.get(key);
    if (!current) {
      current = factory();
      statesBySession.set(key, current);
    }
    return current;
  };
  const state = new Proxy({} as T, {
    get: (_target, property) => Reflect.get(active(), property),
    set: (_target, property, value) => Reflect.set(active(), property, value),
    has: (_target, property) => Reflect.has(active(), property),
    ownKeys: () => Reflect.ownKeys(active()),
    getOwnPropertyDescriptor: (_target, property) => ({
      configurable: true,
      enumerable: true,
      writable: true,
      value: Reflect.get(active(), property),
    }),
    deleteProperty: (_target, property) => Reflect.deleteProperty(active(), property),
  });
  const replace = (next: T): void => {
    const current = active();
    for (const key of Reflect.ownKeys(current)) Reflect.deleteProperty(current, key);
    Object.assign(current, next);
  };
  return { state, replace };
}

// ── Durable identity links ────────────────────────────────────────────────────
//
// `session_links` maps a lasting browser identity (and every tab identity) to
// the account-scoped session that owns the connected Deriv account. Resolution
// order is: tab link → durable client link → cookie link → the tab id itself.
//
// The link table is read on every request, so lookups go through a tiny
// in-memory cache (busted whenever a link is written or cleared).

export type LinkKind = "client" | "cookie" | "tab";

interface LinkCacheEntry {
  sessionId: string | null;
  expiresAt: number;
}

const LINK_CACHE_TTL_MS = 10_000;
const linkCache = new Map<string, LinkCacheEntry>();
/** False until the first successful `session_links` read — skips the query entirely. */
let linksTableReady = false;
let linksTableEmpty = true;

function linkCacheKey(kind: LinkKind, key: string): string {
  return `${kind}:${key}`;
}

function cacheLink(kind: LinkKind, key: string, sessionId: string | null): void {
  linkCache.set(linkCacheKey(kind, key), {
    sessionId,
    expiresAt: Date.now() + LINK_CACHE_TTL_MS,
  });
}

/** Read the account-scoped session a durable identity is bound to (or null). */
export async function resolveLinkedSession(
  kind: LinkKind,
  key: string,
): Promise<string | null> {
  if (!key) return null;
  const cached = linkCache.get(linkCacheKey(kind, key));
  if (cached && cached.expiresAt > Date.now()) return cached.sessionId;
  // Nothing has ever been linked in this process and the table started empty —
  // skip the round trip (the common case for anonymous visitors).
  if (linksTableReady && linksTableEmpty) {
    cacheLink(kind, key, null);
    return null;
  }
  try {
    const { pool } = await import("@workspace/db");
    const result = await pool.query(
      `SELECT session_id FROM session_links WHERE kind = $1 AND key = $2 LIMIT 1`,
      [kind, key],
    );
    linksTableReady = true;
    const sessionId = (result?.rows?.[0] as { session_id?: string } | undefined)?.session_id ?? null;
    cacheLink(kind, key, sessionId);
    return sessionId;
  } catch {
    // Older deployment without the table — behave exactly like before.
    return null;
  }
}

/**
 * Bind a durable identity (and this tab) to an account-scoped session.
 * Called on connect/switch; never on a plain page load.
 */
export async function linkSessionIdentity(args: {
  sessionId: string;
  clientId?: string | null;
  cookieId?: string | null;
  tabId?: string | null;
}): Promise<void> {
  const { sessionId } = args;
  const entries: Array<[LinkKind, string | null | undefined]> = [
    ["client", args.clientId],
    ["cookie", args.cookieId],
    ["tab", args.tabId],
  ];
  const { pool } = await import("@workspace/db");
  for (const [kind, key] of entries) {
    if (!key || !SESSION_ID_PATTERN.test(key)) continue;
    try {
      await pool.query(
        `INSERT INTO session_links (kind, key, session_id, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (kind, key) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = NOW()`,
        [kind, key, sessionId],
      );
      linksTableReady = true;
      linksTableEmpty = false;
      cacheLink(kind, key, sessionId);
    } catch {
      /* table missing on an older deployment — links are an optimisation */
    }
  }
}

/**
 * Remove every identity binding that points at `sessionId`.
 * Only an explicit user disconnect may call this.
 */
export async function clearSessionLinksForSession(sessionId: string): Promise<void> {
  const stale = [...linkCache.entries()]
    .filter(([, entry]) => entry.sessionId === sessionId)
    .map(([key]) => key);
  for (const key of stale) {
    const [kind, ...rest] = key.split(":");
    cacheLink(kind as LinkKind, rest.join(":"), null);
  }
  try {
    const { pool } = await import("@workspace/db");
    await pool.query(`DELETE FROM session_links WHERE session_id = $1`, [sessionId]);
  } catch {
    /* ignore */
  }
}

/**
 * Anonymous browser session used to isolate Deriv credentials and account data.
 *
 * The id itself is deliberately opaque (a server-generated UUID): Deriv
 * bearer/PAT tokens remain server-side and one browser can never select,
 * disconnect, or trade another browser's account.
 */
export async function browserSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tabCandidate = (
    req.get(TAB_SESSION_HEADER) ??
    (typeof req.query?.[TAB_SESSION_QUERY_PARAM] === "string"
      ? (req.query[TAB_SESSION_QUERY_PARAM] as string)
      : "") ??
    ""
  ).trim();
  const headerClient = (
    req.get(CLIENT_ID_HEADER) ??
    (typeof req.query?.[CLIENT_ID_QUERY_PARAM] === "string"
      ? (req.query[CLIENT_ID_QUERY_PARAM] as string)
      : "") ??
    ""
  ).trim();
  const cookieClient =
    typeof req.cookies?.[CLIENT_COOKIE] === "string" ? req.cookies[CLIENT_COOKIE].trim() : "";
  const cookieSession =
    typeof req.cookies?.[SESSION_COOKIE] === "string" ? req.cookies[SESSION_COOKIE].trim() : "";

  const isTabSession = SESSION_ID_PATTERN.test(tabCandidate);
  const clientId = SESSION_ID_PATTERN.test(headerClient)
    ? headerClient
    : SESSION_ID_PATTERN.test(cookieClient)
      ? cookieClient
      : null;

  // The durable client id is a profile-wide constant, so it is safe (and
  // necessary for iframe/third-party-cookie contexts) to always mirror it in a
  // cookie. It is never rotated by connect/disconnect.
  if (clientId && clientId !== cookieClient) {
    res.cookie(CLIENT_COOKIE, clientId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: ONE_YEAR_MS,
      path: "/",
    });
  }

  let sessionId: string;
  let resolvedFromLink = false;

  if (isTabSession) {
    // A tab that has already been bound (connect, or inherited below) keeps it.
    const tabLinked = await resolveLinkedSession("tab", tabCandidate);
    if (tabLinked) {
      sessionId = tabLinked;
      resolvedFromLink = true;
    } else {
      // Brand-new tab, or `sessionStorage` was evicted. Inherit the durable
      // browser binding instead of appearing signed out — and remember it for
      // this tab so the next request takes the fast path.
      const clientLinked = clientId ? await resolveLinkedSession("client", clientId) : null;
      const cookieLinked = cookieSession
        ? await resolveLinkedSession("cookie", cookieSession)
        : null;
      const inherited = clientLinked ?? cookieLinked;
      if (inherited) {
        sessionId = inherited;
        resolvedFromLink = true;
        void linkSessionIdentity({ sessionId: inherited, tabId: tabCandidate });
      } else {
        sessionId = tabCandidate;
      }
    }
  } else {
    const clientLinked = clientId ? await resolveLinkedSession("client", clientId) : null;
    const cookieLinked = cookieSession ? await resolveLinkedSession("cookie", cookieSession) : null;
    if (clientLinked) {
      sessionId = clientLinked;
      resolvedFromLink = true;
    } else if (cookieLinked) {
      sessionId = cookieLinked;
      resolvedFromLink = true;
    } else {
      sessionId = cookieSession;
    }
  }

  const isNewSession = !SESSION_ID_PATTERN.test(sessionId);
  if (isNewSession) sessionId = randomUUID();

  req.sessionId = sessionId;
  req.isTabSession = isTabSession || undefined;
  req.clientId = clientId;
  req.sessionResolvedFromLink = resolvedFromLink;

  // Real (non-tab) requests keep the legacy cookie behaviour so non-browser
  // clients without the header are unchanged. Tab requests never touch the
  // session cookie: the jar is shared, so writing would re-target every other
  // tab still on cookie behaviour.
  if (!isTabSession && (isNewSession || sessionId !== cookieSession)) {
    setBrowserSessionCookie(res, sessionId);
  }

  // Tell the client which identity actually served the request. The web app
  // adopts it when it differs from its own, so a tab that inherited the durable
  // binding (or a user whose storage was lost) self-heals without a reload.
  res.setHeader(RESOLVED_SESSION_HEADER, sessionId);

  sessionContext.run(sessionId, next);
}

function riskSignature(sessionId: string): string {
  const secret = process.env.SESSION_COOKIE_SECRET ?? process.env.DERIV_CLIENT_SECRET ?? "neurotrade-risk-v1";
  return createHmac("sha256", secret).update(`risk:v1:${sessionId}`).digest("base64url");
}

function riskValueMatches(value: unknown, sessionId: string): boolean {
  if (typeof value !== "string") return false;
  const [version, supplied] = value.split(".", 2);
  if (version !== "v1" || !supplied) return false;
  const expected = riskSignature(sessionId);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hasRiskAcknowledgment(req: Request): boolean {
  // Tab sessions carry their acknowledgment in a header: the cookie jar is
  // shared across tabs but the signature is bound to one session id, so a
  // single cookie could never stay valid for two tabs at once.
  if (riskValueMatches(req.get(RISK_ACK_HEADER), req.sessionId)) return true;
  return riskValueMatches(req.cookies?.[RISK_COOKIE], req.sessionId);
}

/** Signed risk-acknowledgment value for a session (returned to tab sessions). */
export function riskAckValue(sessionId: string): string {
  return `v1.${riskSignature(sessionId)}`;
}

export function setRiskAcknowledgment(res: Response, sessionId: string): void {
  res.cookie(RISK_COOKIE, `v1.${riskSignature(sessionId)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ONE_YEAR_MS,
    path: "/",
  });
}

// ── Account-scoped sessions ───────────────────────────────────────────────────
//
// The anonymous browser cookie alone cannot isolate Deriv accounts: two Google
// accounts in one browser shared one session id (one login overwrote the
// other's rows), while the same Deriv account in two browsers/devices/domains
// produced two unrelated session ids (its journal/settings/trades became
// invisible — "lost data"). Account-scoped sessions fix both directions:
//
//   different Deriv logins  → different stable ids  → hard isolation
//   same Deriv login, anywhere → same stable id     → data always follows the account
//
// The id is an HMAC of the login's account-id set keyed by a server secret, so
// it is deterministic across processes yet unguessable without the secret.

let cachedServerSecret: string | null = null;

/**
 * Stable server secret used to derive account-scoped session ids. Persisted in
 * Postgres (survives restarts/redeploys — a per-process random secret would
 * re-orphan every account's data on each deploy). Overridable explicitly via
 * the SESSION_COOKIE_SECRET environment variable.
 */
export async function getServerSecret(): Promise<string> {
  if (process.env.SESSION_COOKIE_SECRET) return process.env.SESSION_COOKIE_SECRET;
  if (cachedServerSecret) return cachedServerSecret;
  const { pool } = await import("@workspace/db");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS server_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  const candidate = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO server_secrets (key, value) VALUES ('account_session_secret', $1)
     ON CONFLICT (key) DO NOTHING`,
    [candidate],
  );
  const result = await pool.query(
    `SELECT value FROM server_secrets WHERE key = 'account_session_secret'`,
  );
  const stored = (result?.rows?.[0] as { value?: string } | undefined)?.value;
  cachedServerSecret = typeof stored === "string" && stored.length > 0 ? stored : candidate;
  return cachedServerSecret;
}

/**
 * Deterministic session id for one Deriv login (its full set of account ids).
 * Shaped as a UUID so the existing browserSession cookie validator accepts it.
 */
export async function accountSessionId(derivAccountIds: string[]): Promise<string> {
  const key = [...new Set(derivAccountIds.filter(Boolean))].sort().join("|");
  const secret = await getServerSecret();
  const hex = createHmac("sha256", secret).update(`account-session:v1:${key}`).digest("hex");
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32),
  ].join("-");
}

/** Overwrite the browser-session cookie (used to rotate onto an account session). */
export function setBrowserSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ONE_YEAR_MS,
    path: "/",
  });
}

export const RISK_ACKNOWLEDGMENT_REQUIRED =
  "Please review and accept the trading risk acknowledgment before connecting a Deriv account.";

declare global {
  namespace Express {
    interface Request {
      sessionId: string;
      /**
       * True when the request carried a per-tab identity (header or SSE query
       * param). Handlers must not rotate cookies for such requests — the client
       * keeps the session id and risk value in per-tab sessionStorage instead.
       */
      isTabSession?: boolean;
      /** Durable browser identity sent by the web client (may be absent). */
      clientId?: string | null;
      /** True when the session id came from a durable link rather than the tab id. */
      sessionResolvedFromLink?: boolean;
    }
  }
}
