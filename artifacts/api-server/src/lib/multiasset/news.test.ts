import { strict as assert } from "node:assert";
import test from "node:test";
import { assessNewsGate } from "./news";
import type { NewsFeed, SymbolSpec } from "./types";

const spec: SymbolSpec = {
  symbol: "EURUSD",
  assetClass: "forex",
  point: 0.00001,
  digits: 5,
  tickSize: 0.00001,
  tickValue: 1,
  contractSize: 100_000,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
  marginInitial: 0,
  swapLong: 0,
  swapShort: 0,
  commissionPerLot: 0,
  spreadPoints: 10,
  baseCurrency: "EUR",
  quoteCurrency: "USD",
};

const now = 1_800_000_000_000;

function feed(events: NewsFeed["events"], checkedAt = now): NewsFeed {
  return { available: true, checkedAt, events };
}

test("news gate fails closed when the MT5 calendar is unavailable", () => {
  const result = assessNewsGate(spec, { available: false, checkedAt: 0, events: [] }, "intraday", now);
  assert.equal(result.blocked, true);
  assert.equal(result.status, "unavailable");
  assert.match(result.reason ?? "", /unavailable/i);
});

test("news gate pauses EURUSD before a relevant USD red-folder release", () => {
  const result = assessNewsGate(spec, feed([{
    id: "usd-cpi",
    time: now + 10 * 60_000,
    currency: "USD",
    country: "United States",
    name: "Consumer Price Index",
    importance: "high",
  }]), "intraday", now);
  assert.equal(result.blocked, true);
  assert.equal(result.status, "blackout");
  assert.match(result.reason ?? "", /Consumer Price Index/);
});

test("news gate leaves an unrelated currency event clear", () => {
  const result = assessNewsGate(spec, feed([{
    id: "jpy-event",
    time: now + 10 * 60_000,
    currency: "JPY",
    country: "Japan",
    name: "BoJ statement",
    importance: "high",
  }]), "intraday", now);
  assert.equal(result.blocked, false);
  assert.equal(result.status, "clear");
});

test("news gate fails closed when a formerly available feed becomes stale", () => {
  const result = assessNewsGate(spec, feed([], now - 5 * 60_000 - 1), "swing", now);
  assert.equal(result.blocked, true);
  assert.equal(result.status, "unavailable");
  assert.match(result.reason ?? "", /stale/i);
});
