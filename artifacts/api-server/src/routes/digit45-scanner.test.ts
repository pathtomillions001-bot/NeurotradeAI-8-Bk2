/** HTTP-level scan → Create DBot handoff. No live socket, accounts or buys. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it, type TestContext } from "node:test";
import express from "express";
import { schemaReady } from "@workspace/db";
import { AUTOMATED_DERIV_MARKETS, tickManager } from "../lib/deriv";
import type { DigitSnapshot, DigitTick } from "../lib/digit-tape";
import { DIGIT45_SCAN_TTL_MS, DIGIT45_WINDOW } from "../lib/digit45-scanner";
import { runWithSession } from "../lib/session";
import router from "./digit45-scanner";

const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === "R_100")!;
const weak = Array.from({ length: DIGIT45_WINDOW }, (_, i) =>
  i % 50 === 4 ? 4 : i % 50 === 15 ? 5 : [0, 1, 2, 3, 6, 7, 8, 9][i % 8]!);
const even = Array.from({ length: DIGIT45_WINDOW }, (_, i) => i % 10);
const app = express();
let owner = randomUUID();
app.use(express.json());
app.use((req, _res, next) => {
  req.sessionId = owner;
  runWithSession(owner, next);
});
app.use("/api/scanners/digit-45", router);
const server = createServer(app);
let url: string;

function tape(digits = weak, source: "live" | "simulated" = "live"): DigitSnapshot {
  const end = Math.floor(Date.now() / 1000);
  const ticks: DigitTick[] = digits.map((digit, i) => ({
    symbol: market.symbol, digit, sequence: i + 1, generation: 1,
    source, epoch: end - digits.length + i + 1, receivedAt: Date.now(),
    price: 100 + digit / 100,
  }));
  return { tick: ticks.at(-1)!, ticks };
}

function fakeFeed(t: TestContext, snapshot: DigitSnapshot | null, simulated = false) {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(tickManager, "getTickHealth", () => ({
    connected: true, usingSimulated: simulated, liveSymbols: 1, totalSymbols: 1, invalidSymbols: 0,
  }));
  t.mock.method(tickManager, "getConnectionStatus", () => true);
  t.mock.method(tickManager, "getDigitSnapshot", (symbol: string, count: number) =>
    symbol === "R_100" && snapshot ? { tick: snapshot.tick, ticks: snapshot.ticks.slice(-count) } : null);
  t.mock.method(tickManager, "request", async (msg: Record<string, unknown>) => {
    requests.push(msg);
    return null;
  });
  return requests;
}

async function post(path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}
const config = (scan: any) => ({
  scanId: scan.scanId, symbol: "R_100", stake: 1, takeProfit: 10, stopLoss: 30,
  maxRecoverySteps: 3, maxStake: 20,
});

before(async () => {
  await schemaReady;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}/api/scanners/digit-45`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
    server.closeAllConnections();
  });
});

describe("Digit 4/5 HTTP scanner and Create DBot", () => {
  it("is scan-only, requires verified broker ticks, and never sends buy/proposal requests", async t => {
    owner = randomUUID();
    const requests = fakeFeed(t, tape());
    const scan = (await post("/scan")).json;
    assert.equal(scan.dataSource, "broker-live");
    assert.equal(scan.markets.length, 1);
    assert.equal(scan.markets[0].eligible, true);
    assert.equal(scan.eligible, 1);
    assert.equal(scan.markets[0].samples, 600);
    assert.equal(scan.markets[0].digit4.count, 12);
    assert.equal(scan.markets[0].digit5.count, 12);
    assert.ok(scan.expiresAt - Date.now() <= DIGIT45_SCAN_TTL_MS);
    assert.deepEqual(requests, []); // full live tape: no history and no trading

    const dbot = await post("/dbot", config(scan));
    assert.equal(dbot.status, 200, JSON.stringify(dbot.json));
    assert.equal(dbot.json.ok, true);
    assert.equal(dbot.json.summary.pairExposure, 2);
    assert.match(dbot.json.xml, /purchase_digit45_pair/);
    assert.deepEqual(requests, []); // creating XML CANNOT place an order
  });

  it("rejects simulated feeds even if their digits would score well", async t => {
    owner = randomUUID();
    fakeFeed(t, tape(weak, "simulated"), true);
    const scan = (await post("/scan")).json;
    assert.equal(scan.dataSource, "unavailable");
    assert.equal(scan.scanId, null);
    assert.equal(scan.eligible, 0);
    assert.equal((await post("/dbot", config(scan))).status, 409);
  });

  it("rejects a delayed broker timestamp even when the network receipt appears fresh", async t => {
    owner = randomUUID();
    const delayed = tape();
    delayed.tick.epoch -= 120;
    fakeFeed(t, delayed);
    const scan = (await post("/scan")).json;
    assert.equal(scan.eligible, 0);
    assert.deepEqual(scan.markets, []);
  });

  it("never creates from an ineligible uniform tape or a forged symbol", async t => {
    owner = randomUUID();
    fakeFeed(t, tape(even));
    const scan = (await post("/scan")).json;
    assert.equal(scan.eligible, 0);
    assert.equal(scan.markets[0].eligible, false);
    assert.equal((await post("/dbot", config(scan))).status, 409);
    assert.equal((await post("/dbot", { ...config(scan), symbol: "JD100" })).status, 409);
  });

  it("rejects another session's scan id, changed generation, stale tick and expired scan", async t => {
    owner = randomUUID();
    const snap = tape();
    fakeFeed(t, snap);
    const scan = (await post("/scan")).json;
    owner = randomUUID();
    assert.equal((await post("/dbot", config(scan))).status, 409);
    owner = randomUUID();
    const own = (await post("/scan")).json;
    snap.tick.generation++;
    assert.equal((await post("/dbot", config(own))).status, 409);
    snap.tick.generation--;
    snap.tick.receivedAt = Date.now() - 100_000;
    assert.equal((await post("/dbot", config(own))).status, 409);
    snap.tick.receivedAt = Date.now();
    t.mock.method(Date, "now", () => own.expiresAt + 1);
    assert.equal((await post("/dbot", config(own))).status, 409);
  });

  it("blocks creation when the broker timestamp stalls but receipt timestamps keep moving", async t => {
    owner = randomUUID();
    const initialTime = Date.now();
    let elapsed = 0;
    t.mock.method(Date, "now", () => initialTime + elapsed);
    const snap = tape();
    fakeFeed(t, snap);
    const scan = (await post("/scan")).json;
    assert.equal(scan.eligible, 1);
    elapsed = 10_000;
    assert.ok(initialTime + elapsed < scan.expiresAt);
    snap.tick = { ...snap.tick, receivedAt: initialTime + elapsed };
    const created = await post("/dbot", config(scan));
    assert.equal(created.status, 409);
    assert.match(created.json.error, /expired or changed/);
  });

  it("re-checks every new live tick: a sudden spike of 4s invalidates a still-unexpired scan", async t => {
    owner = randomUUID();
    const initialTime = Date.now();
    let elapsed = 0;
    t.mock.method(Date, "now", () => initialTime + elapsed);
    const snap = tape();
    fakeFeed(t, snap);
    const scan = (await post("/scan")).json;
    assert.equal(scan.eligible, 1);
    for (let i = 1; i <= 30; i++) {
      snap.ticks.push({ ...snap.tick, sequence: snap.tick.sequence + 1,
        epoch: snap.tick.epoch + 2, receivedAt: initialTime + i * 2000, digit: 4, price: 100.04 });
      snap.tick = snap.ticks.at(-1)!;
    }
    elapsed = 60_000;
    assert.ok(initialTime + elapsed < scan.expiresAt);
    const created = await post("/dbot", config(scan));
    assert.equal(created.status, 409);
    assert.match(created.json.error, /no longer qualify/);
  });

  it("refuses missing and unsafe risk settings rather than guessing numeric defaults", async t => {
    owner = randomUUID();
    fakeFeed(t, tape());
    const scan = (await post("/scan")).json;
    for (const changes of [
      { stake: undefined }, { stake: "1" }, { stake: 1.005 },
      { stopLoss: 1 }, { maxRecoverySteps: 0 },
      { maxStake: 9999 }, { maxStake: 0.5 },
    ]) {
      const result = await post("/dbot", { ...config(scan), ...changes });
      assert.equal(result.status, 400, `${JSON.stringify(changes)} ${JSON.stringify(result.json)}`);
    }
  });

  it("merges ONLY consistent broker history into a short live tape", async t => {
    owner = randomUUID();
    const full = tape();
    const short = { tick: full.tick, ticks: full.ticks.slice(-40) };
    const requests = fakeFeed(t, short);
    const history = {
      history: { times: full.ticks.map(x => x.epoch), prices: full.ticks.map(x => x.price) },
    };
    t.mock.method(tickManager, "request", async (msg: Record<string, unknown>) => {
      requests.push(msg);
      return history;
    });
    const scan = (await post("/scan")).json;
    assert.equal(scan.markets[0].samples, DIGIT45_WINDOW);
    assert.equal(scan.markets[0].eligible, true);
    assert.deepEqual(requests, [{ ticks_history: "R_100", count: DIGIT45_WINDOW, end: "latest", style: "ticks" }]);
    // A disagreeing history must NEVER be used to qualify a short tape.
    owner = randomUUID();
    t.mock.method(tickManager, "request", async () => ({
      history: { times: full.ticks.map(x => x.epoch), prices: full.ticks.map(() => 100.04) },
    }));
    const bad = (await post("/scan")).json;
    assert.equal(bad.eligible, 0);
    assert.equal(bad.markets[0].samples, 40);
  });
});
