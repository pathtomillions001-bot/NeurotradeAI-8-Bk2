import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

const SESSION_COOKIE = "neurotrade_session";
const RISK_COOKIE = "neurotrade_risk_ack";
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
 * When either is present and well-formed it wins over the cookie, and the
 * server never writes cookies for that request — tabs stay fully independent
 * even in the same profile. Clients without the header (older cached JS,
 * non-browser API users) keep the legacy cookie behaviour unchanged.
 */
export const TAB_SESSION_HEADER = "x-tab-session";
export const TAB_SESSION_QUERY_PARAM = "tabSession";
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

/**
 * Anonymous browser session used to isolate Deriv credentials and account data.
 *
 * This is deliberately an opaque server-generated id in an HttpOnly cookie:
 * Deriv bearer/PAT tokens remain server-side and one browser can never select,
 * disconnect, or trade another browser's account.
 */
export function browserSession(req: Request, res: Response, next: NextFunction): void {
  // Per-tab identity wins over the shared cookie (see TAB_SESSION_HEADER).
  // Cookie reads/writes are skipped entirely so tabs can never clobber the
  // shared jar — or each other — even in the same browser profile.
  const tabCandidate = (
    req.get(TAB_SESSION_HEADER) ??
    (typeof req.query?.[TAB_SESSION_QUERY_PARAM] === "string"
      ? (req.query[TAB_SESSION_QUERY_PARAM] as string)
      : "") ??
    ""
  ).trim();
  if (SESSION_ID_PATTERN.test(tabCandidate)) {
    req.sessionId = tabCandidate;
    req.isTabSession = true;
    sessionContext.run(tabCandidate, next);
    return;
  }

  const existing = typeof req.cookies?.[SESSION_COOKIE] === "string"
    ? req.cookies[SESSION_COOKIE].trim()
    : "";
  const sessionId = SESSION_ID_PATTERN.test(existing) ? existing : randomUUID();

  req.sessionId = sessionId;
  if (sessionId !== existing) {
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: ONE_YEAR_MS,
      path: "/",
    });
  }
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
       * True when the session came from the per-tab header/query identity
       * rather than the shared cookie. Handlers must not rotate cookies (or
       * re-sign the cookie risk value) for such requests — the client keeps
       * the session id and risk value in per-tab sessionStorage instead.
       */
      isTabSession?: boolean;
    }
  }
}
