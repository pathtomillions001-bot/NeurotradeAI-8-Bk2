import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

export const RISK_ACKNOWLEDGMENT_REQUIRED =
  "Please review and accept the trading risk acknowledgment before connecting a Deriv account.";

declare global {
  namespace Express {
    interface Request {
      sessionId: string;
    }
  }
}
