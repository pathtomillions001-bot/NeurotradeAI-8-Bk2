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
  clearSessionLinksForSession,
  getBrowserSessionId,
  hasRiskAcknowledgment,
  linkSessionIdentity,
  riskAckValue,
} from "./session.ts";
import { closeAccountConnections, getAccountConnection } from "./deriv.ts";

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
  const headers: Record<string, string> = {};
  return {
    cookies,
    headers,
    cookie(name: string, value: string) {
      cookies.push({ name, value });
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
  };
}

async function runMiddleware(req: any) {
  const res = fakeRes();
  let ambient: string | null = null;
  // Identity resolution consults the durable link table (session_links), so the
  // middleware is async. Without a database in tests the lookups degrade to
  // "no link" and behaviour stays exactly as before.
  await browserSession(req, res as any, () => {
    ambient = getBrowserSessionId();
  });
  return { req, res, ambient };
}

describe("browserSession tab identity", () => {
  it("prefers the X-Tab-Session header over the shared cookie", async () => {
    const { req, res, ambient } = await runMiddleware(
      fakeReq({
        headers: { "x-tab-session": TAB_A },
        cookies: { neurotrade_session: COOKIE_ID },
      }),
    );
    assert.equal(req.sessionId, TAB_A);
    assert.equal(req.isTabSession, true);
    assert.equal(ambient, TAB_A);
    // Tabs must never clobber the shared SESSION cookie — or each other.
    assert.equal(
      res.cookies.filter((c) => c.name === "neurotrade_session").length,
      0,
    );
  });

  it("accepts ?tabSession= for SSE EventSources (which cannot set headers)", async () => {
    const { req, ambient } = await runMiddleware(
      fakeReq({
        query: { tabSession: TAB_B },
        cookies: { neurotrade_session: COOKIE_ID },
      }),
    );
    assert.equal(req.sessionId, TAB_B);
    assert.equal(req.isTabSession, true);
    assert.equal(ambient, TAB_B);
  });

  it("falls back to the cookie when the tab identity is malformed", async () => {
    const { req } = await runMiddleware(
      fakeReq({
        headers: { "x-tab-session": "not-a-uuid" },
        cookies: { neurotrade_session: COOKIE_ID },
      }),
    );
    assert.equal(req.sessionId, COOKIE_ID);
    assert.equal(req.isTabSession, undefined);
  });

  it("keeps two tabs on one cookie fully independent", async () => {
    const a = await runMiddleware(
      fakeReq({
        headers: { "x-tab-session": TAB_A },
        cookies: { neurotrade_session: COOKIE_ID },
      }),
    );
    const b = await runMiddleware(
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

  it("issues a fresh cookie id when nothing identifies the browser", async () => {
    const { req, res } = await runMiddleware(fakeReq({}));
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

describe("durable identity links", () => {
  it("resolves an unbound tab to the durable client binding (never signs the user out)", async () => {
    const clientId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const accountSession = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const freshTab = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    await linkSessionIdentity({ sessionId: accountSession, clientId });

    // A brand-new tab (empty sessionStorage) sends only the durable client id.
    const { req } = await runMiddleware(
      fakeReq({
        headers: { "x-tab-session": freshTab, "x-client-id": clientId },
      }),
    );
    assert.equal(req.sessionId, accountSession);
    assert.equal(req.isTabSession, true);
  });

  it("clears the binding on explicit disconnect only", async () => {
    const clientId = "12121212-1212-4121-8121-121212121212";
    const accountSession = "13131313-1313-4131-8131-131313131313";
    await linkSessionIdentity({ sessionId: accountSession, clientId });
    await clearSessionLinksForSession(accountSession);

    const { req } = await runMiddleware(
      fakeReq({
        headers: {
          "x-tab-session": "14141414-1414-4141-8141-141414141414",
          "x-client-id": clientId,
        },
      }),
    );
    // No binding left → the tab falls back to its own fresh identity.
    assert.notEqual(req.sessionId, accountSession);
  });
});

describe("pooled Deriv connections", () => {
  it("returns one shared connection per account (no per-trade OTP sockets)", () => {
    const first = getAccountConnection("token-abcdef123456", "CR12345");
    const second = getAccountConnection("token-abcdef123456", "CR12345");
    assert.equal(first, second, "same account must reuse one socket");
    const other = getAccountConnection("token-abcdef123456", "VR54321");
    assert.notEqual(first, other, "different accounts get their own socket");
    closeAccountConnections();
  });
});
