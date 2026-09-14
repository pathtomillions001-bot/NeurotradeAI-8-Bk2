/**
 * Browser/tab session isolation — tests.
 *
 * Two tabs in the SAME browser profile share one cookie jar, so per-tab
 * identity (`X-Tab-Session` header, `?tabSession=` on SSE) must win over the
 * cookie — otherwise the second tab to connect a Deriv account hijacks the
 * first tab's identity (its engine toggles, journal and trades would suddenly
 * target the other account).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accountSessionId,
  browserSession,
  getBrowserSessionId,
  hasRiskAcknowledgment,
  riskAckValue,
} from "./session.ts";

process.env.SESSION_COOKIE_SECRET ??= "session-isolation-test-secret";

const TAB_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TAB_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const COOKIE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function fakeReq(opts: {
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  cookies?: Record<string, string>;
}): any {
  const headers = opts.headers ?? {};
  return {
    headers,
    query: opts.query ?? {},
    cookies: opts.cookies ?? {},
    get(name: string): string | undefined {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  };
}

function fakeRes() {
  const cookies: Array<{ name: string; value: string }> = [];
  return {
    cookies,
    cookie(name: string, value: string) {
      cookies.push({ name, value });
      return this;
    },
  };
}

function runMiddleware(req: any) {
  const res = fakeRes();
  let ambient: string | null = null;
  browserSession(req, res as any, () => {
    ambient = getBrowserSessionId();
  });
  return { req, res, ambient };
}

describe("browserSession tab identity", () => {
  it("prefers the X-Tab-Session header over the shared cookie", () => {
    const { req, res, ambient } = runMiddleware(
      fakeReq({
        headers: { "x-tab-session": TAB_A },
        cookies: { neurotrade_session: COOKIE_ID },
      }),
    );
    assert.equal(req.sessionId, TAB_A);
    assert.equal(req.isTabSession, true);
    assert.equal(ambient, TAB_A);
    // Tabs must never clobber the shared cookie jar — or each other.
    assert.equal(res.cookies.length, 0);
  });

  it("accepts ?tabSession= for SSE EventSources (which cannot set headers)", () => {
    const { req, ambient } = runMiddleware(
      fakeReq({
        query: { tabSession: TAB_B },
        cookies: { neurotrade_session: COOKIE_ID },
      }),
    );
    assert.equal(req.sessionId, TAB_B);
    assert.equal(req.isTabSession, true);
    assert.equal(ambient, TAB_B);
  });

  it("falls back to the cookie when the tab identity is malformed", () => {
    const { req } = runMiddleware(
      fakeReq({
        headers: { "x-tab-session": "not-a-uuid" },
        cookies: { neurotrade_session: COOKIE_ID },
      }),
    );
    assert.equal(req.sessionId, COOKIE_ID);
    assert.equal(req.isTabSession, undefined);
  });

  it("keeps two tabs on one cookie fully independent", () => {
    const a = runMiddleware(
      fakeReq({
        headers: { "x-tab-session": TAB_A },
        cookies: { neurotrade_session: COOKIE_ID },
      }),
    );
    const b = runMiddleware(
      fakeReq({
        headers: { "x-tab-session": TAB_B },
        cookies: { neurotrade_session: COOKIE_ID },
      }),
    );
    assert.equal(a.req.sessionId, TAB_A);
    assert.equal(b.req.sessionId, TAB_B);
    assert.equal(a.ambient, TAB_A);
    assert.equal(b.ambient, TAB_B);
  });

  it("issues a fresh cookie id when nothing identifies the browser", () => {
    const { req, res } = runMiddleware(fakeReq({}));
    assert.match(req.sessionId, /^[a-f0-9-]{36}$/i);
    assert.equal(res.cookies.length, 1);
    assert.equal(res.cookies[0]!.name, "neurotrade_session");
  });
});

describe("per-tab risk acknowledgment", () => {
  it("accepts the signed value via the X-Risk-Ack header", () => {
    const req = fakeReq({
      headers: { "x-tab-session": TAB_A, "x-risk-ack": riskAckValue(TAB_A) },
    });
    req.sessionId = TAB_A;
    assert.equal(hasRiskAcknowledgment(req), true);
  });

  it("rejects a value signed for a different tab", () => {
    const req = fakeReq({
      headers: { "x-tab-session": TAB_A, "x-risk-ack": riskAckValue(TAB_B) },
    });
    req.sessionId = TAB_A;
    assert.equal(hasRiskAcknowledgment(req), false);
  });

  it("still accepts the legacy cookie value", () => {
    const req = fakeReq({
      cookies: { neurotrade_risk_ack: riskAckValue(COOKIE_ID) },
    });
    req.sessionId = COOKIE_ID;
    assert.equal(hasRiskAcknowledgment(req), true);
  });
});

describe("accountSessionId", () => {
  it("is deterministic, order-independent and distinct per login", async () => {
    const a = await accountSessionId(["CR111", "VR222"]);
    const b = await accountSessionId(["VR222", "CR111"]);
    const c = await accountSessionId(["CR999"]);
    assert.match(a, /^[a-f0-9-]{36}$/i);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});
