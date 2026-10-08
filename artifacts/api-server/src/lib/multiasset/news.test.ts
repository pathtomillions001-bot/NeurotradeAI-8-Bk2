import { strict as assert } from "node:assert";
import test from "node:test";
import { assessNewsGate, upcomingRedFolder } from "./news";
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

// ── The next 24 hours of red-folder events ───────────────────────────────────
//
// The calendar pane is only useful if it shows what is COMING — and only
// believable if it can also explain what ALREADY HAPPENED. The pane used to
// drop everything more than fifteen minutes old, so on a day whose three
// red-folder releases were all in the morning the desk answered "0 red-folder
// events" while the terminal's own calendar showed three. The list therefore
// carries the trading day: releases from the last twelve hours stay, flagged as
// passed, and only the 24-hour forward horizon is enforced.

test("the upcoming window is the next 24 hours, in the order they happen", () => {
  const events = [
    { id: "later", time: now + 20 * 60 * 60_000, currency: "USD", country: "US", name: "FOMC", importance: "high" as const },
    { id: "soon", time: now + 45 * 60_000, currency: "EUR", country: "EU", name: "ECB", importance: "high" as const },
    { id: "tomorrow", time: now + 30 * 60 * 60_000, currency: "USD", country: "US", name: "NFP", importance: "high" as const },
    { id: "justHappened", time: now - 5 * 60_000, currency: "GBP", country: "UK", name: "CPI", importance: "high" as const },
    { id: "thisMorning", time: now - 3 * 60 * 60_000, currency: "JPY", country: "JP", name: "BoJ", importance: "high" as const },
    { id: "yesterday", time: now - 20 * 60 * 60_000, currency: "USD", country: "US", name: "PPI", importance: "high" as const },
  ];

  const upcoming = upcomingRedFolder(events, now);
  assert.deepEqual(upcoming.map((event) => event.id), ["thisMorning", "justHappened", "soon", "later"]);
  // 30 hours out is outside the 24-hour horizon, and yesterday is outside the
  // day this list describes.
  assert.ok(!upcoming.some((event) => event.id === "tomorrow"));
  assert.ok(!upcoming.some((event) => event.id === "yesterday"));
  // Events are stamped with their distance so the UI never recomputes it.
  const soon = upcoming.find((event) => event.id === "soon")!;
  assert.equal(soon.inMs, 45 * 60_000);
  assert.equal(soon.next, true, "the next event is flagged");
  assert.equal(soon.passed, false);
  // Released ones are kept but marked, and never carry the "next" flag.
  const morning = upcoming.find((event) => event.id === "thisMorning")!;
  assert.equal(morning.passed, true);
  assert.equal(morning.next, false);
});

test("an empty calendar yields an empty list, not a fabricated one", () => {
  assert.deepEqual(upcomingRedFolder([], now), []);
});
