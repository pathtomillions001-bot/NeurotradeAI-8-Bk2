/** Regression tests for broker-catalog snapshots and live-only MT5 pairing data. */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { runWithSession } from "../lib/session";
import { getDesk, resetDesk } from "../lib/multiasset/store";
import type { ArmedPlan, Position, SymbolSpec } from "../lib/multiasset/types";
import bridgeRouter, { __testing, parseCatalogEntry } from "./bridge";

let sequence = 0;
function freshDesk() {
  const sessionId = `bridge-catalog-test-${sequence++}`;
  resetDesk(sessionId);
  return getDesk(sessionId);
}

test("MT5 catalog entries retain broker metadata and infer a known asset class", () => {
  assert.deepEqual(parseCatalogEntry({
    symbol: "BTCUSD.a",
    path: "Crypto\\Majors",
    description: "Bitcoin / US Dollar",
  }), {
    symbol: "BTCUSD.a",
    assetClass: "crypto",
    path: "Crypto\\Majors",
    description: "Bitcoin / US Dollar",
  });
  assert.equal(parseCatalogEntry({ symbol: "  " }), null);
});

test("a full broker-catalog refresh removes unavailable symbols and their armed plans", () => {
  const desk = freshDesk();
  desk.universe.set("EURUSD", { symbol: "EURUSD", assetClass: "forex" });
  desk.universe.set("OLDCOIN", { symbol: "OLDCOIN", assetClass: "crypto" });
  desk.watchlist = ["EURUSD", "OLDCOIN"];
  desk.specs.set("OLDCOIN", { symbol: "OLDCOIN" } as unknown as SymbolSpec);
  desk.quotes.set("OLDCOIN", { symbol: "OLDCOIN", bid: 1, ask: 2, spreadPoints: 1, ts: Date.now() });
  desk.candles.set("OLDCOIN|M1", { symbol: "OLDCOIN", timeframe: "M1", bars: [] });
  const oldPlan = { id: "plan-old", symbol: "OLDCOIN" } as unknown as ArmedPlan;
  desk.plans.set(oldPlan.id, oldPlan);
  const unrelatedPosition = {
    ticket: 7, symbol: "EURUSD", side: "buy", volume: 0.1, openPrice: 1,
    openTime: Date.now(), sl: null, tp: null, profit: 0, swap: 0, commission: 0,
  } satisfies Position;
  desk.positions = [unrelatedPosition];

  __testing.replaceBrokerUniverse(desk, [{ symbol: "EURUSD", assetClass: "forex" }]);

  assert.deepEqual([...desk.universe.keys()], ["EURUSD"]);
  assert.deepEqual(desk.watchlist, ["EURUSD"]);
  assert.equal(desk.specs.has("OLDCOIN"), false);
  assert.equal(desk.quotes.has("OLDCOIN"), false);
  assert.equal(desk.candles.has("OLDCOIN|M1"), false);
  assert.equal(desk.plans.has(oldPlan.id), false);
  assert.ok(desk.outbox.some((command) => command.type === "cancel_plan" && command.planId === oldPlan.id));
  assert.deepEqual(desk.positions, [unrelatedPosition]);

  resetDesk(desk.sessionId);
});

test("a transient empty catalog does not erase the last valid broker universe", () => {
  const desk = freshDesk();
  desk.universe.set("EURUSD", { symbol: "EURUSD", assetClass: "forex" });
  __testing.replaceBrokerUniverse(desk, []);
  assert.deepEqual([...desk.universe.keys()], ["EURUSD"]);
  resetDesk(desk.sessionId);
});

test("bridge sync disables trading when the attached terminal has no verified news calendar", async () => {
  const sessionId = `bridge-news-route-test-${sequence++}`;
  resetDesk(sessionId);
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runWithSession(sessionId, next));
  app.use("/api/bridge", bridgeRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/api/bridge`;
  const post = (path: string, body: unknown, token?: string) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  try {
    const pairingResponse = await fetch(`${baseUrl}/pairing-code`, { method: "POST" });
    const { pairingCode } = await pairingResponse.json() as { pairingCode: string };
    const pairResponse = await post("/pair", { pairingCode, terminal: { login: 999123, server: "Demo" } });
    assert.equal(pairResponse.status, 201);
    const { bridgeToken } = await pairResponse.json() as { bridgeToken: string };
    getDesk(sessionId).autoTrade = true;

    const syncResponse = await post("/sync", {
      seq: 1,
      account: {
        balance: 1_000, equity: 1_000, margin: 0, freeMargin: 1_000,
        currency: "USD", leverage: 100, mode: "hedging", isLive: false,
      },
      newsCalendar: {
        source: "mt5", available: false, fetchedAt: Date.now(),
        coverageStart: 0, coverageEnd: 0, error: "calendar unavailable", events: [],
      },
    }, bridgeToken);
    assert.equal(syncResponse.status, 200);
    const payload = await syncResponse.json() as { limits: { tradingEnabled: boolean }; newsCalendar: { ready: boolean } };
    assert.equal(payload.newsCalendar.ready, false);
    assert.equal(payload.limits.tradingEnabled, false);
  } finally {
    await post("/unpair", {});
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetDesk(sessionId);
  }
});

test("only a complete MT5 high-impact calendar snapshot is accepted", () => {
  const now = 1_700_000_000_000;
  const parsed = __testing.parseNewsCalendar({
    source: "mt5",
    available: true,
    fetchedAt: now,
    coverageStart: now - 60 * 60_000,
    coverageEnd: now + 48 * 60 * 60_000,
    error: null,
    events: [{ id: "calendar-7", currency: "usd", title: "US CPI", impact: "high", ts: now + 90 * 60_000 }],
  }, now);
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.events[0].currency, "USD");
  assert.equal(parsed.events[0].title, "US CPI");

  const invalid = __testing.parseNewsCalendar({
    source: "external",
    available: true,
    fetchedAt: now,
    coverageStart: now - 60 * 60_000,
    coverageEnd: now + 48 * 60 * 60_000,
    events: [],
  }, now);
  assert.equal(invalid.status, "unavailable");
});

test("the bridge cancels already-armed plans when calendar confidence is lost or a matching blackout begins", () => {
  const desk = freshDesk();
  const now = 1_700_000_000_000;
  const plan = { id: "news-plan", symbol: "EURUSD" } as unknown as ArmedPlan;
  desk.plans.set(plan.id, plan);

  __testing.cancelNewsUnsafePlans(desk, now);
  assert.equal(desk.plans.has(plan.id), false);
  assert.ok(desk.outbox.some((command) => command.type === "cancel_plan" && command.planId === plan.id));

  const active = { id: "news-plan-active", symbol: "EURUSD" } as unknown as ArmedPlan;
  desk.plans.set(active.id, active);
  desk.specs.set("EURUSD", {
    symbol: "EURUSD", baseCurrency: "EUR", quoteCurrency: "USD",
  } as unknown as SymbolSpec);
  desk.newsCalendar = {
    status: "ready",
    fetchedAt: now,
    coverageStart: now - 60 * 60_000,
    coverageEnd: now + 48 * 60 * 60_000,
    error: null,
    events: [{ id: "cpi", currency: "USD", title: "US CPI", impact: "high", ts: now }],
  };
  __testing.cancelNewsUnsafePlans(desk, now);
  assert.equal(desk.plans.has(active.id), false);
  assert.ok(desk.outbox.some((command) => command.type === "cancel_plan" && command.planId === active.id));
  resetDesk(desk.sessionId);
});
