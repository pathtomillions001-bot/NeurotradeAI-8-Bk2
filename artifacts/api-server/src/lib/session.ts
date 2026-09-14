import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

const SESSION_COOKIE = "neurotrade_session";
const RISK_COOKIE = "neurotrade_risk_ack";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const sessionContext = new AsyncLocalStorage<string>();

/** Current browser session, propagated through route promises and engine timers. */
export function getBrowserSessionId(): string {
  return sessionContext.getStore() ?? "legacy";
}

/**
 * Anonymous browser session used to isolate Deriv credentials and account data.
 *
 * This is deliberately an opaque server-generated id in an HttpOnly cookie:
 * Deriv bearer/PAT tokens remain server-side and one browser can never select,
 * disconnect, or trade another browser's account.
 */
export function browserSession(req: Request, res: Response, next: NextFunction): void {
  const existing = typeof req.cookies?.[SESSION_COOKIE] === "string"
    ? req.cookies[SESSION_COOKIE].trim()
    : "";
  const sessionId = /^[a-f0-9-]{36}$/i.test(existing) ? existing : randomUUID();

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

export function hasRiskAcknowledgment(req: Request): boolean {
  const value = req.cookies?.[RISK_COOKIE];
  if (typeof value !== "string") return false;
  const [version, supplied] = value.split(".", 2);
  if (version !== "v1" || !supplied) return false;
  const expected = riskSignature(req.sessionId);
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

declare global {
  namespace Express {
    interface Request {
      sessionId: string;
    }
  }
}
