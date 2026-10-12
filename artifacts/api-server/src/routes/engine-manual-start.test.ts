import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import express from "express";
import { db, schemaReady, settingsTable } from "@workspace/db";
import { runWithSession } from "../lib/session";
import * as recoveryEngine from "../lib/agents/recovery-engine";
import router from "./ai";

// Regression: after a consecutive-loss stop, pressing Start (or "Resume now")
// must actually start the engine. The toggle left the loss counter at the limit,
// so the first cycle re-tripped the same hard stop and the engine bounced
// straight back into a fresh cooldown — the button looked dead.

const app = express();
let sessionId: string;
app.use(express.json());
app.use((req, _res, next) => {
  req.sessionId = sessionId;
  runWithSession(sessionId, next);
});
app.use("/api/ai", router);
const server = createServer(app);
let baseUrl: string;

before(async () => {
  await schemaReady;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api/ai`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function toggle(running: boolean) {
  const res = await fetch(`${baseUrl}/engine/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ running }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function status() {
  const res = await fetch(`${baseUrl}/engine/status`, { signal: AbortSignal.timeout(10_000) });
  return (await res.json()) as any;
}

describe("manual Start after a consecutive-loss stop", () => {
  it("starts, keeps running, clears only the streak counter and preserves the debt", async () => {
    sessionId = `engine-manual-start-${randomUUID()}`;
    const stuck = {
      ...recoveryEngine.createRecoveryState(),
      inRecovery: true,
      recoveryStep: 3,
      baseStake: 1,
      unrecoveredAmount: 7.5,
      streakLossCount: 4,
      streakStartAmount: 7.5,
      trueLossRun: 4,
      recoveryDepth: 4,
      recoveryStartedAt: Date.now(),
      resetDate: new Date().toLocaleDateString("en-CA"),
    };
    await db.insert(settingsTable).values({
      sessionId,
      consecutiveLossLimit: 4,
      paperTradeMode: true,
      recoveryStateJson: JSON.stringify(stuck),
    } as any);

    const started = await toggle(true);
    assert.equal(started.status, 200);
    assert.equal(started.body.isRunning, true);

    // Give the first tick-driven cycle time to run: before the fix it tripped the
    // hard stop here and flipped isRunning back to false with a new cooldown.
    await sleep(600);
    const after = await status();
    assert.equal(after.isRunning, true, `engine stopped itself: ${JSON.stringify(after.stopReasons)}`);
    assert.equal(after.cooldownUntil, null);
    assert.equal(after.recovery.totalStreakLosses, 0, "loss-streak counter is cleared");
    assert.equal(after.recovery.totalUnrecovered, 7.5, "recovery debt must survive the restart");
    assert.equal(after.recovery.trueLossRun, 4, "truthful run counter must survive the restart");

    await toggle(false);
  });
});
