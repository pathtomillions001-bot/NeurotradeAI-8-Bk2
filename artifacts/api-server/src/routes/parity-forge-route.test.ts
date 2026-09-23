/**
 * Parity Forge route regression tests — the scan→deploy handoff.
 *
 * The live bug this pins: the scan fits SIX lens weights
 * [parityMkv, runHazard, digitPair, suffix, parityCTW, echo] into the
 * candidate card, but /start's param parser only accepted FOUR — every click
 * on "Trade Locked on …" / "Smart Switching" bounced off with
 * "Run the scan first …" and the bot never started. These tests drive the
 * actual HTTP route with the exact card shapes the console sends:
 *
 *  - a fresh 6-lens card MUST deploy;
 *  - a legacy 4-lens card MUST still deploy (migrated to 6);
 *  - malformed lengths (5, 7) MUST be refused with the scan-first error.
 *
 * No Deriv connection, real token or broker call is involved: the engine's
 * loop idles on an empty digit feed until the session is stopped.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { schemaReady } from "@workspace/db";
import { runWithSession } from "../lib/session";
import { PARITY_FORGE_LENS_COUNT } from "../lib/parity-forge-analysis";
import router from "./parity-forge";

const app = express();
let sessionId: string;
app.use(express.json());
app.use((req, _res, next) => {
  req.sessionId = sessionId;
  runWithSession(sessionId, next);
});
app.use("/api/bots/parity-forge", router);
const server = createServer(app);
let baseUrl: string;

/** A measured card exactly as scanForParityForge returns it (6 lenses). */
const sixLensCard = {
  weights: [0.18, 0.16, 0.15, 0.14, 0.19, 0.18],
  tau: 1.05,
  normalInitBar: 0.55,
};

function startBody(params: unknown, extra: Record<string, unknown> = {}) {
  return {
    sideMode: "both",
    stake: 1,
    stopLoss: 5,
    takeProfit: 10,
    maxRecoverySteps: 3,
    marketMode: "locked",
    symbol: "R_10",
    lockedSymbol: "R_10",
    params,
    analysis: {
      symbol: "R_10",
      displayName: "Volatility 10 Index",
      verdict: "viable",
      confidence: 50,
      paperEdgePerDollar: 0.01,
      normalHitRate: 0.55,
      normalShots: 40,
      normalHits: 22,
      recoveryHitRate: 0.58,
      recoveryShots: 60,
      recoveryHits: 35,
      recoveryLossPairs: 2,
      recoveryLosses: 25,
      avgTicksInRecovery: 2.1,
      fireRatePer100: 12,
      breakEven: 0.5128,
      params: sixLensCard,
      diag: {
        weights: sixLensCard.weights,
        tau: sixLensCard.tau,
        normalInitBar: sixLensCard.normalInitBar,
        historyUsed: 4000,
        qLL: { even: 0.69, odd: 0.69 },
        fireRatePer100: 12,
      },
      thinData: false,
    },
    ...extra,
  };
}

async function post(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function stopIfRunning(): Promise<void> {
  const { json } = await post("/stop");
  if (json?.status?.running) {
    await new Promise(r => setTimeout(r, 300));
  }
}

before(async () => {
  await schemaReady;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api/bots/parity-forge`;
});

beforeEach(() => {
  sessionId = `parity-route-test-${randomUUID()}`;
});

after(async () => {
  await stopIfRunning();
  // Let the engine's background loop observe the stop before the process ends.
  await new Promise(r => setTimeout(r, 1200));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

describe("POST /api/bots/parity-forge/start — scan card handoff", () => {
  it("deploys from the exact 6-lens card the scan produced", async () => {
    const { status, json } = await post("/start", startBody(sixLensCard));
    assert.equal(status, 200, `start refused: ${JSON.stringify(json)}`);
    assert.equal(json.ok, true, `not ok: ${JSON.stringify(json)}`);
    assert.equal(json.status?.running, true, `not running: ${JSON.stringify(json)}`);
    assert.equal(json.status?.botId, "parity-forge");
    await stopIfRunning();
  });

  it("still deploys a legacy 4-lens card (migrated to the live lens count)", async () => {
    const legacy = { weights: [0.3, 0.25, 0.25, 0.2], tau: 1, normalInitBar: 0.55 };
    assert.equal(legacy.weights.length, 4);
    assert.notEqual(legacy.weights.length, PARITY_FORGE_LENS_COUNT);
    const { status, json } = await post("/start", startBody(legacy));
    assert.equal(status, 200, `legacy card refused: ${JSON.stringify(json)}`);
    assert.equal(json.ok, true);
    await stopIfRunning();
  });

  it("refuses a malformed 5-lens vector with the scan-first error", async () => {
    const { status, json } = await post("/start", startBody({
      weights: [0.2, 0.2, 0.2, 0.2, 0.2], tau: 1, normalInitBar: 0.55,
    }));
    assert.equal(status, 400);
    assert.match(json.error, /Run the scan first/);
  });

  it("refuses a malformed 7-lens vector", async () => {
    const { status, json } = await post("/start", startBody({
      weights: [0.15, 0.15, 0.15, 0.15, 0.1, 0.15, 0.15], tau: 1, normalInitBar: 0.55,
    }));
    assert.equal(status, 400);
    assert.match(json.error, /Run the scan first/);
  });

  it("refuses a missing parameter card", async () => {
    const body = startBody(sixLensCard) as Record<string, any>;
    delete body.params;
    delete body.analysis.params; // the console also sends the card inside analysis
    const { status, json } = await post("/start", body);
    assert.equal(status, 400);
    assert.match(json.error, /Run the scan first/);
  });

  it("refuses non-finite weights", async () => {
    const { status, json } = await post("/start", startBody({
      weights: [0.2, 0.2, 0.2, 0.2, 0.2, "oops"], tau: 1, normalInitBar: 0.55,
    }));
    assert.equal(status, 400);
    assert.match(json.error, /Run the scan first/);
  });
});
