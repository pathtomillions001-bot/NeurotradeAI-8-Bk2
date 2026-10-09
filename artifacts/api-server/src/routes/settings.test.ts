import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { schemaReady } from "@workspace/db";
import { runWithSession } from "../lib/session";
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
  sessionId = `settings-cooldown-test-${randomUUID()}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

async function getSettings() {
  const response = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ cooldownEnabled: boolean }>;
}

async function setCooldownEnabled(cooldownEnabled: boolean) {
  const response = await fetch(baseUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cooldownEnabled }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ cooldownEnabled: boolean }>;
}

describe("persisted cooldown preference", () => {
  it("defaults on and persists both enabled and disabled updates", async () => {
    assert.equal((await getSettings()).cooldownEnabled, true);
    assert.equal((await setCooldownEnabled(false)).cooldownEnabled, false);
    assert.equal((await getSettings()).cooldownEnabled, false);
    assert.equal((await setCooldownEnabled(true)).cooldownEnabled, true);
    assert.equal((await getSettings()).cooldownEnabled, true);
  });
});
