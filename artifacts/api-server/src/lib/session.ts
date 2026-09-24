import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

const SESSION_COOKIE = "neurotrade_session";
const RISK_COOKIE = "neurotrade_risk_ack";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const sessionContext = new AsyncLocalStorage<string>();

// ── Per-tab / durable identity transport ──────────────────────────────────────
// Two tabs in one browser profile share one cookie jar, so the shared session
// cookie alone can never isolate them: the second tab to connect a Deriv account
// would re-point (and hijack) the first tab's engine, journal and trades. The web
// client therefore sends a PER-TAB id (sessionStorage) and a DURABLE id
// (localStorage) on every request — as headers, and as query params for SSE
// EventSources, which cannot set headers.
//
// Precedence, exactly as specified by lib/session-isolation.test.ts:
//   valid `x-tab-session` / `?tabSession=`  → this tab's identity (no cookie write)
//   else valid `x-client-id`   / `?clientId=` → durable identity
//   else the legacy `neurotrade_session` cookie
// A stored link (session_links) for that tab/client identity resolves to the
// account-scoped session that owns the connected Deriv account, so a new tab or
// a reopened browser comes back to the SAME account instead of looking signed
// out — while two tabs with two accounts stay fully isolated.
const TAB_SESSION_HEADER = "x-tab-session";
const TAB_SESSION_QUERY = "tabSession";
const CLIENT_ID_HEADER = "x-client-id";
const CLIENT_ID_QUERY = "clientId";
const RESOLVED_SESSION_HEADER = "x-session-id";
const RISK_ACK_HEADER = "x-risk-ack";
const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;

function readIdentity(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value.trim())
    ? value.trim()
    : null;
}

function headerValue(req: Request, name: string): string | null {
  try {
    const viaGet = typeof req.get === "function" ? req.get(name) : undefined;
    if (typeof viaGet === "string" && viaGet.length > 0) return viaGet;
  } catch {
    /* synthetic request without .get() — fall through to the raw headers map */
  }
  const raw = (req.headers as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" ? raw : null;
}

function queryValue(req: Request, name: string): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" ? raw : null;
}

function cookieValue(req: Request, name: string): string | null {
  const raw = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" ? raw.trim() : null;
}

// ── Durable identity links (session_links) ────────────────────────────────────
// Reads are cached in-process: the middleware runs on every request and a link
// never changes except through the two functions below, which bust the cache.
// Every lookup degrades to "no link" when the database is unavailable, so the
// middleware can never fail a request.
const linkCache = new Map<string, string>();

function linkKey(kind: string, key: string): string {
  return `${kind}:${key}`;
}

async function readLink(kind: "client" | "cookie" | "tab", key: string): Promise<string | null> {
  const cacheKey = linkKey(kind, key);
  const cached = linkCache.get(cacheKey);
  if (cached) return cached;
  try {
    const { pool } = await import("@workspace/db");
    const result = await pool.query(
      `SELECT session_id FROM session_links WHERE kind = $1 AND key = $2 LIMIT 1`,
      [kind, key],
    );
    const stored = (result?.rows?.[0] as { session_id?: unknown } | undefined)?.session_id;
    if (typeof stored === "string" && SESSION_ID_PATTERN.test(stored)) {
      linkCache.set(cacheKey, stored);
      return stored;
    }
  } catch {
    /* no database (tests / cold start) — behave exactly like an unlinked browser */
  }
  return null;
}

async function writeLink(kind: "client" | "cookie" | "tab", key: string, sessionId: string): Promise<void> {
  if (!SESSION_ID_PATTERN.test(key) || !SESSION_ID_PATTERN.test(sessionId)) return;
  linkCache.set(linkKey(kind, key), sessionId);
  try {
    const { pool } = await import("@workspace/db");
    await pool.query(
      `INSERT INTO session_links (kind, key, session_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (kind, key) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = NOW()`,
      [kind, key, sessionId],
    );
  } catch {
    /* in-memory cache still holds this process's answer */
  }
}

/** Current browser session, propagated through route promises and engine timers. */
export function getBrowserSessionId(): string {
  return sessionContext.getStore() ?? "legacy";
}

/**
 * Run `fn` with `sessionId` bound as the active browser session (AsyncLocalStorage).
 * Used by the per-account engine loops so recovery-engine persistence, the
 * trading arbiter and journal helpers inside timer callbacks always resolve
 * THEIR OWN account session — never another account's, even when several
 * engines run concurrently in this process.
 */
export function runWithSession<T>(sessionId: string, fn: () => T): T {
  return sessionContext.run(sessionId, fn);
}

// Backward-compat alias — older modules import runWithSessionId
export const runWithSessionId = runWithSession;

/**
 * Anonymous browser session used to isolate Deriv credentials and account data.
 *
 * This is deliberately an opaque server-generated id in an HttpOnly cookie:
 * Deriv bearer/PAT tokens remain server-side and one browser can never select,
 * disconnect, or trade another browser's account.
 */
export async function browserSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookie = readIdentity(cookieValue(req, SESSION_COOKIE));
  const tab = readIdentity(headerValue(req, TAB_SESSION_HEADER) ?? queryValue(req, TAB_SESSION_QUERY));
  const client = readIdentity(headerValue(req, CLIENT_ID_HEADER) ?? queryValue(req, CLIENT_ID_QUERY));

  // A per-tab identity always wins over the shared cookie jar. A stored link for
  // that tab — or, for a brand-new tab, for the durable client id — resolves to
  // the account-scoped session that owns the connected Deriv account, so a new
  // tab / reopened browser lands back on the same account instead of looking
  // signed out, while two tabs with two accounts stay fully isolated.
  let sessionId: string;
  let isTabSession = false;
  if (tab) {
    isTabSession = true;
    const tabLink = await readLink("tab", tab);
    if (tabLink) {
      sessionId = tabLink;
    } else {
      const clientLink = client ? await readLink("client", client) : null;
      if (clientLink) {
        sessionId = clientLink;
      } else if (client && cookie) {
        // ONE-TIME MIGRATION for browsers that connected their Deriv account
        // BEFORE per-tab identity existed: `session_links` is still empty, but
        // the shared cookie already holds this browser's account-scoped session
        // id (the pre-fix middleware always wrote it). Adopt that session and
        // bind both identities to it, so the existing account, journal, settings
        // and any running engine stay attached instead of looking signed out on
        // the first request after this deploy. Runs at most once per tab: both
        // links are written, so later requests resolve straight from the cache.
        sessionId = (await readLink("cookie", cookie)) ?? cookie;
        await writeLink("client", client, sessionId);
        await writeLink("tab", tab, sessionId);
      } else {
        sessionId = tab;
      }
    }
  } else if (client) {
    sessionId = (await readLink("client", client)) ?? cookie ?? randomUUID();
  } else {
    sessionId = (cookie ? await readLink("cookie", cookie) : null) ?? cookie ?? randomUUID();
  }

  req.sessionId = sessionId;
  req.isTabSession = isTabSession || undefined;
  req.clientId = client;
  try {
    res.setHeader(RESOLVED_SESSION_HEADER, sessionId);
  } catch {
    /* synthetic response object (tests) — the header is advisory */
  }

  // Tab / durable identities never write the shared cookie: the jar is shared by
  // every tab in the profile, and re-targeting it would hijack the others.
  if (!tab && sessionId !== cookie) {
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

export function hasRiskAcknowledgment(req: Request): boolean {
  // Per-tab acknowledgment travels in the header: the cookie jar is shared by
  // every tab, so one cookie value could never stay valid for two tabs at once.
  if (matchesRiskSignature(req.sessionId, headerValue(req, RISK_ACK_HEADER))) return true;
  // Legacy cookie clients keep working unchanged.
  return matchesRiskSignature(req.sessionId, req.cookies?.[RISK_COOKIE]);
}

function matchesRiskSignature(sessionId: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const [version, supplied] = value.split(".", 2);
  if (version !== "v1" || !supplied) return false;
  const expected = riskSignature(sessionId);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
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

/** Signed risk-acknowledgment value for a session (returned to tab sessions). */
export function riskAckValue(sessionId: string): string {
  return `v1.${riskSignature(sessionId)}`;
}

/**
 * Bind a lasting browser identity (durable `clientId`, legacy `cookieId`, and/or
 * this tab's `tabId`) to the account-scoped session that owns the connected
 * Deriv account. Called by the connect / switch / OAuth-callback paths so that
 * any later request carrying that identity resolves straight back to the same
 * account — while an explicit disconnect clears the bindings.
 */
export async function linkSessionIdentity(args: {
  sessionId: string;
  clientId?: string | null;
  cookieId?: string | null;
  tabId?: string | null;
  /** Legacy field, kept so older call sites still compile. */
  derivAccountIds?: string[];
}): Promise<void> {
  const { sessionId, clientId, cookieId, tabId } = args;
  if (clientId) await writeLink("client", clientId, sessionId);
  if (cookieId) await writeLink("cookie", cookieId, sessionId);
  if (tabId) await writeLink("tab", tabId, sessionId);
}

/** Drop every stored link for `sessionId` (explicit user disconnect). */
export async function clearSessionLinksForSession(sessionId: string): Promise<void> {
  for (const [key, value] of [...linkCache.entries()]) {
    if (value === sessionId) linkCache.delete(key);
  }
  try {
    const { pool } = await import("@workspace/db");
    await pool.query(`DELETE FROM session_links WHERE session_id = $1`, [sessionId]);
  } catch {
    /* the in-memory cache is already clear — the next request re-resolves */
  }
}

/**
 * Create one piece of session-scoped mutable state, addressed through the
 * ambient browser session (AsyncLocalStorage).
 *
 * Returns a Proxy that routes every property read/write to the calling
 * session's own instance, plus a `replace()` for whole-state resets.
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

declare global {
  namespace Express {
    interface Request {
      sessionId: string;
      /** True when the per-tab identity (not the shared cookie) was used. */
      isTabSession?: boolean;
      /** Durable browser identity (`x-client-id` / `?clientId=`), when supplied. */
      clientId?: string | null;
    }
  }
}
