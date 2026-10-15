import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import express from "express";
import { db, schemaReady } from "@workspace/db";
import { tradesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { tickManager } from "../lib/deriv";
import { runWithSession } from "../lib/session";
import router from "./trades";

// Exercise the actual HTTP route using an isolated paper account. No connected
// account, real token or broker calls are involved in these regression tests.
const app = express();
let sessionId: string;
app.use(express.json());
app.use((req, _res, next) => {
  req.sessionId = sessionId;
  runWithSession(sessionId, next);
});
app.use("/api/trades", router);
const server = createServer(app);
let baseUrl: string;

const singleOrder = {
  symbol: "R_10",
  contractType: "DIGITOVER",
  direction: "up",
  stake: 1,
  duration: 1,
  durationUnit: "t",
  barrier: 3,
};

before(async () => {
  await schemaReady;
  mock.method(tickManager, "request", async () => ({
    msg_type: "proposal",
    proposal: { id: "paper-quote", ask_price: 1, payout: 1.63 },
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api/trades`;
});

beforeEach(() => {
  sessionId = `manual-route-test-${randomUUID()}`;
});

after(async () => {
  mock.restoreAll();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

function post(body: unknown, suffix = "") {
  return fetch(`${baseUrl}${suffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

function journalRows() {
  return db.select().from(tradesTable).where(eq(tradesTable.sessionId, sessionId));
}

describe("one-order manual trading API", () => {
  // ── PAPER MODE REMOVED ─────────────────────────────────────────────────────
  //
  // These two cases originally asserted that a manual submission with no
  // connected account simulated a trade and journalled it. That simulation drew
  // its outcome from `Math.random() < winProbability` and then moved the account
  // balance by the invented result, so the journal recorded a P&L that never
  // happened. Paper/demo simulation is gone: without a live account the request
  // is refused and NOTHING is written.
  //
  // The invariant these tests protect — one intentional submission can never
  // produce more than one trade — is preserved and is now checked from the other
  // side: no submission can produce a trade at all without a live account.
  it("refuses a manual submission with no live account, writing nothing", async () => {
    const response = await post(singleOrder);
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "NO_LIVE_ACCOUNT");
    assert.match(String(body.error), /Paper\/demo simulation has been removed/);
    const rows = await journalRows();
    assert.equal(rows.length, 0, "a refused manual trade must never reach the journal");
  });

  it("never fabricates a journal entry across repeated submissions without a live account", async () => {
    assert.equal((await post(singleOrder)).status, 409);
    assert.equal((await post(singleOrder)).status, 409);
    assert.equal((await post(singleOrder)).status, 409);
    assert.equal((await journalRows()).length, 0);
  });

  it("returns 404 for the retired multi-order endpoint without placing a trade", async () => {
    const response = await post({ ...singleOrder, count: 4 }, "/bulk");
    assert.equal(response.status, 404);
    assert.equal((await journalRows()).length, 0);
  });

  for (const [name, body] of [
    ["a quantity field", { ...singleOrder, count: 4 }],
    ["an alternate quantity field", { ...singleOrder, quantity: 4 }],
    ["an array of orders", [singleOrder, singleOrder]],
    ["an orders envelope", { orders: [singleOrder, singleOrder] }],
  ] as const) {
    it(`rejects ${name} instead of interpreting it as manual execution`, async () => {
      const response = await post(body);
      assert.equal(response.status, 400);
      assert.equal((await journalRows()).length, 0);
    });
  }
});
