/**
 * History-seeding requests — the fix for the re-seed loop that stalled the
 * heartbeat and froze the desk on stale data (see history.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { maxStorableBars } from "./integrity";
import {
  computeHistoryNeeded,
  HISTORY_TARGET_BARS,
  LEGACY_HISTORY_MAX_REQUESTS,
  LEGACY_RESEED_MAX_REQUESTS,
  parseBarsAvailable,
  recordLegacyHistoryRequests,
} from "./history";
import { candleKey, getDesk, upsertCandles, type DeskState } from "./store";
import { TIMEFRAMES, type Bar, type Timeframe } from "./types";

function bars(count: number, startMs = 1_700_000_000_000): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) {
    out.push([startMs + i * 60_000, 1, 2, 0.5, 1.5, 10]);
  }
  return out;
}

function seed(desk: DeskState, symbol: string, timeframe: Timeframe, count: number): void {
  upsertCandles(desk, { symbol, timeframe, bars: bars(count) });
}

let deskCounter = 0;
function freshDesk(watchlist: string[]): DeskState {
  const desk = getDesk(`history-test-${deskCounter++}`);
  desk.watchlist = [...watchlist];
  return desk;
}

function reportedFor(desk: DeskState): Set<string> {
  return new Set(desk.specs.keys());
}

/**
 * The EA reports a bar count for EVERY selected symbol|timeframe — set up a
 * fully-reported desk so the precise rule (not the legacy fallback) applies.
 */
function reportCounts(desk: DeskState, symbol: string, counts: Partial<Record<Timeframe, number>>): void {
  for (const timeframe of TIMEFRAMES) {
    desk.historyAvailable.set(candleKey(symbol, timeframe), counts[timeframe] ?? 5_000);
  }
}

/** Seed every timeframe of a symbol with `count` bars. */
function seedAll(desk: DeskState, symbol: string, count: number): void {
  for (const timeframe of TIMEFRAMES) seed(desk, symbol, timeframe, count);
}

// ── parseBarsAvailable ───────────────────────────────────────────────────────

test("parseBarsAvailable reads symbol|timeframe counts and clamps them", () => {
  const parsed = parseBarsAvailable({ "EURUSD|M1": 5231, "XAUUSD|W1": "26", "bad": 5, "EURUSD|D1": 1e12 });
  assert.equal(parsed.get("EURUSD|M1"), 5231);
  assert.equal(parsed.get("XAUUSD|W1"), 26);
  assert.equal(parsed.has("bad"), false);
  assert.equal(parsed.get("EURUSD|D1"), 10_000_000);
});

test("parseBarsAvailable keeps zero counts — an empty series must never be requested", () => {
  const parsed = parseBarsAvailable({ "EURUSD|M2": 0 });
  assert.equal(parsed.get("EURUSD|M2"), 0);
});

test("parseBarsAvailable rejects malformed payloads", () => {
  assert.equal(parseBarsAvailable(null).size, 0);
  assert.equal(parseBarsAvailable("nope").size, 0);
  assert.equal(parseBarsAvailable([1, 2]).size, 0);
  assert.equal(parseBarsAvailable({ "EURUSD|M1": -4 }).size, 0);
  assert.equal(parseBarsAvailable({ "EURUSD|M1": "abc" }).size, 0);
});

// ── precise rule (EA reports bar counts) ─────────────────────────────────────

test("a series the terminal cannot fill is never requested again", () => {
  const desk = freshDesk(["NEWCOIN"]);
  desk.specs.set("NEWCOIN", { symbol: "NEWCOIN" } as never);
  reportCounts(desk, "NEWCOIN", { W1: 26 });
  // The terminal holds only 26 W1 bars — it can never reach the 60-bar
  // target. Every other timeframe is fully seeded.
  for (const timeframe of TIMEFRAMES) {
    seed(desk, "NEWCOIN", timeframe, timeframe === "W1" ? 26 : 220);
  }

  for (let beat = 0; beat < 10; beat++) {
    const keys = computeHistoryNeeded(desk, reportedFor(desk));
    assert.deepEqual(keys.filter((k) => k === "NEWCOIN|W1"), [], `beat ${beat}: W1 must not be requested`);
  }
  assert.deepEqual(computeHistoryNeeded(desk, reportedFor(desk)), []);
});

test("an unsupported timeframe (zero bars in the terminal) is never requested", () => {
  const desk = freshDesk(["EURUSD"]);
  desk.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  reportCounts(desk, "EURUSD", { M2: 0 });
  seedAll(desk, "EURUSD", 220);
  // M2 stays unseeded: the terminal has no bars for it.

  const keys = computeHistoryNeeded(desk, reportedFor(desk));
  assert.deepEqual(keys, []);
});

test("a missing series is requested until the desk holds what the terminal has", () => {
  const desk = freshDesk(["EURUSD"]);
  desk.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  reportCounts(desk, "EURUSD", { M1: 5_000 });

  // Nothing seeded yet — every reported series is requested.
  let keys = computeHistoryNeeded(desk, reportedFor(desk));
  assert.ok(keys.includes("EURUSD|M1"));

  // Partial seed: still short of the 60-bar target → keep asking.
  seed(desk, "EURUSD", "M1", 30);
  keys = computeHistoryNeeded(desk, reportedFor(desk));
  assert.ok(keys.includes("EURUSD|M1"));

  // Full seed: 220 ≥ min(5000, 60) → stop asking.
  seed(desk, "EURUSD", "M1", 220);
  keys = computeHistoryNeeded(desk, reportedFor(desk));
  assert.deepEqual(keys.filter((k) => k === "EURUSD|M1"), []);
});

test("a server restart (empty desk) triggers exactly one re-seed per series", () => {
  const desk = freshDesk(["EURUSD"]);
  desk.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  reportCounts(desk, "EURUSD", { M1: 5_000 });
  seedAll(desk, "EURUSD", 220);
  assert.deepEqual(computeHistoryNeeded(desk, reportedFor(desk)), []);

  // Desk lost its candles (restart) — the terminal still has them.
  desk.candles.clear();
  let keys = computeHistoryNeeded(desk, reportedFor(desk));
  assert.ok(keys.includes("EURUSD|M1"));

  // The EA re-seeds; the desk fills; the request stops.
  seedAll(desk, "EURUSD", 220);
  keys = computeHistoryNeeded(desk, reportedFor(desk));
  assert.deepEqual(keys, []);
});

test("new bars forming in the terminal do not retrigger history requests", () => {
  const desk = freshDesk(["EURUSD"]);
  desk.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  reportCounts(desk, "EURUSD", { M1: 5_000 });
  seedAll(desk, "EURUSD", 220);

  // The terminal gains bars over time; the desk already holds the target.
  desk.historyAvailable.set(candleKey("EURUSD", "M1"), 5_001);
  assert.deepEqual(computeHistoryNeeded(desk, reportedFor(desk)), []);
});

test("symbols without specs are not asked for history", () => {
  const desk = freshDesk(["EURUSD", "GHOST"]);
  desk.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  reportCounts(desk, "GHOST", { M1: 5_000 });

  const keys = computeHistoryNeeded(desk, reportedFor(desk));
  assert.deepEqual(keys.filter((k) => k.startsWith("GHOST")), []);
});

// ── legacy rule (EA reports no bar counts) ───────────────────────────────────

test("legacy EA: a missing series is requested a bounded number of times", () => {
  const desk = freshDesk(["EURUSD"]);
  desk.specs.set("EURUSD", { symbol: "EURUSD" } as never);

  for (let beat = 0; beat < LEGACY_HISTORY_MAX_REQUESTS; beat++) {
    const keys = computeHistoryNeeded(desk, reportedFor(desk));
    assert.ok(keys.includes("EURUSD|M1"), `beat ${beat}: missing series must be requested`);
    recordLegacyHistoryRequests(desk, keys);
  }
  const keys = computeHistoryNeeded(desk, reportedFor(desk));
  assert.deepEqual(keys, [], "after the cap the series must not be requested again");
});

test("legacy EA: a short series is re-asked only a couple of times", () => {
  const desk = freshDesk(["EURUSD"]);
  desk.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  // Interrupted seed: M1 stuck at 26 bars (the terminal will never grow it),
  // every other timeframe fully seeded.
  for (const timeframe of TIMEFRAMES) {
    seed(desk, "EURUSD", timeframe, timeframe === "M1" ? 26 : 220);
  }

  for (let beat = 0; beat < LEGACY_RESEED_MAX_REQUESTS; beat++) {
    const keys = computeHistoryNeeded(desk, reportedFor(desk));
    assert.deepEqual(keys, ["EURUSD|M1"], `beat ${beat}: only the short series must be re-requested`);
    recordLegacyHistoryRequests(desk, keys);
  }
  const keys = computeHistoryNeeded(desk, reportedFor(desk));
  assert.deepEqual(keys, [], "a permanently short series must stop being requested");
});

test("recordLegacyHistoryRequests does not cap series the EA reports counts for", () => {
  const desk = freshDesk(["EURUSD"]);
  desk.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  reportCounts(desk, "EURUSD", { M1: 5_000 });

  for (let beat = 0; beat < LEGACY_HISTORY_MAX_REQUESTS + 5; beat++) {
    const keys = computeHistoryNeeded(desk, reportedFor(desk));
    recordLegacyHistoryRequests(desk, keys);
    assert.ok(keys.includes("EURUSD|M1"), `beat ${beat}: precise series keeps being requested while short`);
  }
  assert.equal(desk.historyRequests.has("EURUSD|M1"), false);
});

test("the 60-bar target is the demand ceiling, not the terminal's history size", () => {
  assert.equal(HISTORY_TARGET_BARS, 60);
  const desk = freshDesk(["EURUSD"]);
  desk.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  reportCounts(desk, "EURUSD", { M1: 100_000 });
  seedAll(desk, "EURUSD", 60);
  assert.deepEqual(computeHistoryNeeded(desk, reportedFor(desk)), []);
});

test("the target is capped by what the desk can store (the ingest gate limits W1)", () => {
  // The ingest gate rejects bars older than 400 days, so a W1 series can
  // hold at most 58 bars. Demanding 60 there would re-seed W1 on every
  // heartbeat, forever — the loop this module exists to kill.
  assert.equal(maxStorableBars("W1"), 58);
  assert.ok(maxStorableBars("M1") >= HISTORY_TARGET_BARS);

  const full = freshDesk(["EURUSD"]);
  full.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  reportCounts(full, "EURUSD", { W1: 5_000 });
  for (const timeframe of TIMEFRAMES) seed(full, "EURUSD", timeframe, timeframe === "W1" ? 58 : 220);
  assert.deepEqual(computeHistoryNeeded(full, reportedFor(full)), []);

  const short = freshDesk(["EURUSD"]);
  short.specs.set("EURUSD", { symbol: "EURUSD" } as never);
  reportCounts(short, "EURUSD", { W1: 5_000 });
  for (const timeframe of TIMEFRAMES) seed(short, "EURUSD", timeframe, timeframe === "W1" ? 57 : 220);
  assert.deepEqual(computeHistoryNeeded(short, reportedFor(short)), ["EURUSD|W1"]);
});
