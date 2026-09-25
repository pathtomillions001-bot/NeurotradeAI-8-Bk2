/**
 * Bot Studio bridge — contract tests.
 *
 * What must never regress:
 *   1. A session with no connected Deriv account gets 404 `{connected:false}` —
 *      the builder then shows the host's "connect an account" state instead of a
 *      second login form.
 *   2. `?accountId=` can only ever select an account that belongs to THIS
 *      session. A builder in session A must not be able to mint a trading
 *      connection to session B's account (cross-tenant execution).
 *   3. The bridge answers with account metadata only — never a token. The bearer
 *      token lives server-side and must not be reachable from the browser, which
 *      is the entire reason this bridge exists instead of OAuth-in-the-builder.
 */

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import { db, accountsTable } from "@workspace/db";
import dbotRouter from "./dbot";

const SESSION_A = "session-a-bridge-test";
const SESSION_B = "session-b-bridge-test";

let server: Server;
let baseUrl = "";

async function start() {
  const app = express();
  app.use(express.json());
  // Stand-in for the platform's browserSession middleware.
  app.use((req: any, _res, next) => {
    const header = req.get("x-test-session");
    req.sessionId = header || SESSION_A;
    next();
  });
  app.use("/dbot", dbotRouter);
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

test.before(async () => {
  await start();
  await db.delete(accountsTable);
  await db.insert(accountsTable).values([
    {
      sessionId: SESSION_A,
      loginId: "VRTC90000001",
      derivAccountId: "VRTC90000001",
      currency: "USD",
      balance: "1000.00",
      isVirtual: true,
      isActive: true,
    },
    {
      sessionId: SESSION_B,
      loginId: "CR70000001",
      derivAccountId: "CR70000001",
      currency: "USD",
      balance: "50.00",
      isVirtual: false,
      isActive: true,
    },
  ]);
});

test.after(async () => {
  await db.delete(accountsTable);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("session with no connected account reports not-connected (404)", async () => {
  const res = await fetch(`${baseUrl}/dbot/session`, {
    headers: { "x-test-session": "session-with-nothing" },
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { connected: boolean };
  assert.equal(body.connected, false);
});

test("session reports the ACTIVE account and its demo/real nature", async () => {
  const res = await fetch(`${baseUrl}/dbot/session`, {
    headers: { "x-test-session": SESSION_A },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    connected: boolean;
    accountId: string;
    accountType: string;
    isVirtual: boolean;
    accounts: Array<{ accountId: string }>;
  };
  assert.equal(body.connected, true);
  assert.equal(body.accountId, "VRTC90000001");
  assert.equal(body.accountType, "demo");
  assert.equal(body.isVirtual, true);
  assert.deepEqual(body.accounts.map((a) => a.accountId), ["VRTC90000001"]);
});

test("the bridge never returns a credential", async () => {
  const res = await fetch(`${baseUrl}/dbot/session`, {
    headers: { "x-test-session": SESSION_A },
  });
  const raw = await res.text();
  for (const forbidden of ["bearer", "token", "refresh", "pat_"]) {
    assert.equal(
      raw.toLowerCase().includes(forbidden),
      false,
      `response leaked "${forbidden}"`,
    );
  }
});

test("ws-url refuses another session's account (no cross-tenant execution)", async () => {
  const res = await fetch(`${baseUrl}/dbot/ws-url?accountId=CR70000001`, {
    headers: { "x-test-session": SESSION_A },
  });
  // Either it falls back to this session's own account, or it refuses — what it
  // must never do is mint a connection for CR70000001 (session B's real account).
  if (res.status === 200) {
    const body = (await res.json()) as { accountId: string };
    assert.equal(body.accountId, "VRTC90000001");
    assert.notEqual(body.accountId, "CR70000001");
  } else {
    assert.ok([404, 409, 502].includes(res.status), `unexpected ${res.status}`);
    const raw = await res.text();
    assert.equal(raw.includes("CR70000001"), false);
  }
});

test("ws-url reports not-connected for an unconnected session", async () => {
  const res = await fetch(`${baseUrl}/dbot/ws-url`, {
    headers: { "x-test-session": "session-with-nothing" },
  });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { connected: boolean }).connected, false);
});
