/**
 * WP8 — settings plumbing for the recovery v2 fields.
 *
 * The new settings must survive the FULL path: HTTP body → orval zod
 * validation (UpdateSettingsBody) → sanitisation → DB → formatSettings →
 * response. Anything silently stripped here would never reach the engine, so
 * this round-trip is the acceptance gate.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { schemaReady } from "@workspace/db";
import { runWithSession } from "../lib/session";
import { sanitizeRecoveryLambda } from "./settings";
import router from "./settings";

const app = express();
let sessionId: string;
app.use(express.json());
app.use((req, _res, next) => {
  req.sessionId = sessionId;
  runWithSession(sessionId, next);
});
app.use("/api/settings", router);
const server = createServer(app);
let baseUrl: string;

before(async () => {
  await schemaReady;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api/settings`;
});

beforeEach(() => {
  sessionId = `wp8-settings-test-${randomUUID()}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

async function put(body: unknown) {
  const res = await fetch(baseUrl, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function get() {
  const res = await fetch(baseUrl);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe("WP8: recovery v2 settings round-trip", () => {
  it("defaults keep legacy behaviour before anything is saved", async () => {
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.recoveryMethod, "split");
    assert.equal(body.recoveryV2Mode, "off");
    assert.equal(Number(body.recoveryBudgetBase), 25);
    assert.equal(body.recoveryLambda, "auto");
    assert.equal(Number(body.recoveryHeadroomPct), 5);
    assert.equal(Number(body.recoveryMarginPreference), 1);
    assert.equal(body.recoveryTiltEnabled, false);
  });

  it("saves the adaptive method + v2 gate and reads them back unchanged", async () => {
    const saved = await put({
      recoveryMethod: "adaptive",
      recoveryV2Mode: "shadow",
      recoveryBudgetBase: 30,
      recoveryLambda: "0.5",
      recoveryHeadroomPct: 8,
      recoveryMarginPreference: 2,
      recoveryTiltEnabled: false,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.recoveryMethod, "adaptive");
    assert.equal(saved.body.recoveryV2Mode, "shadow");
    assert.equal(Number(saved.body.recoveryBudgetBase), 30);
    assert.equal(saved.body.recoveryLambda, "0.5");
    assert.equal(Number(saved.body.recoveryHeadroomPct), 8);
    assert.equal(Number(saved.body.recoveryMarginPreference), 2);
    assert.equal(saved.body.recoveryTiltEnabled, false);

    const reRead = await get();
    assert.equal(reRead.body.recoveryMethod, "adaptive", "adaptive must survive the DB round-trip");
    assert.equal(reRead.body.recoveryV2Mode, "shadow");
    assert.equal(reRead.body.recoveryLambda, "0.5");
  });

  it("sanitises out-of-range values instead of rejecting the whole save", async () => {
    const saved = await put({
      recoveryMethod: "adaptive",
      recoveryV2Mode: "live",
      recoveryBudgetBase: 5000,      // above the 1000 cap
      recoveryLambda: "3",           // above 1
      recoveryHeadroomPct: -4,       // below 0
      recoveryMarginPreference: 99,  // above 10
      recoveryTiltEnabled: true,
    });
    assert.equal(saved.status, 200);
    assert.equal(Number(saved.body.recoveryBudgetBase), 1000);
    assert.equal(saved.body.recoveryLambda, "1");
    assert.equal(Number(saved.body.recoveryHeadroomPct), 0);
    assert.equal(Number(saved.body.recoveryMarginPreference), 10);
    assert.equal(saved.body.recoveryTiltEnabled, true);
  });

  it("unknown recovery methods are rejected by the zod enum (never silently stored)", async () => {
    const saved = await put({ recoveryMethod: "martingale" });
    assert.equal(saved.status, 400);
    const ok = await put({ recoveryLambda: "auto" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.recoveryLambda, "auto");
  });

  it("the tilt kill switch defaults to OFF on a fresh session", async () => {
    const { body } = await get();
    assert.equal(body.recoveryTiltEnabled, false, "the honesty tilt must never be on by default");
  });
});

describe("WP8: lambda sanitiser", () => {
  it("keeps auto, clamps numbers into (0,1], rejects junk", () => {
    assert.equal(sanitizeRecoveryLambda("auto"), "auto");
    assert.equal(sanitizeRecoveryLambda(""), "auto");
    assert.equal(sanitizeRecoveryLambda(undefined), "auto");
    assert.equal(sanitizeRecoveryLambda("junk"), "auto");
    assert.equal(sanitizeRecoveryLambda("0.5"), "0.5");
    assert.equal(sanitizeRecoveryLambda("2"), "1");
    assert.equal(sanitizeRecoveryLambda("0.01"), "0.05");
  });
});
