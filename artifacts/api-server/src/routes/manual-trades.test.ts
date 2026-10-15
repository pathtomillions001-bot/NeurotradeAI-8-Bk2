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
  it("creates exactly one journal entry for one manual submission", async () => {
    const response = await post(singleOrder);
    assert.equal(response.status, 201);
    const trade = await response.json();
    assert.equal(Array.isArray(trade), false);
    assert.equal(trade.symbol, singleOrder.symbol);
    assert.equal(trade.contractType, singleOrder.contractType);
    assert.equal(trade.stake, singleOrder.stake);
    assert.equal(trade.isAutonomous, false);
    const rows = await journalRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, trade.id);
    assert.equal(rows[0].barrier, 3);
  });

  it("allows the next intentional submission as a separate single trade", async () => {
    assert.equal((await post(singleOrder)).status, 201);
    assert.equal((await journalRows()).length, 1);
    assert.equal((await post(singleOrder)).status, 201);
    assert.equal((await journalRows()).length, 2);
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
