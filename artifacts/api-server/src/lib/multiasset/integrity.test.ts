/**
 * Feed-integrity tests.
 *
 * These cover the two failure modes that made the Desk show wrong or late
 * prices: terminal clocks that are not UTC, and quotes that have drifted away
 * from the symbol's own candles.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessPrice,
  barTimestampUsable,
  feedHealth,
  quoteTimestampUsable,
  updateClockSkew,
  QUOTE_STALE_MS,
} from "./integrity";
import { sampleEquity, getDesk, resetDesk, upsertCandles } from "./store";
import type { AccountSnapshot, Bar, SymbolSpec, Timeframe } from "./types";

const spec: SymbolSpec = {
  symbol: "XAUUSD",
  assetClass: "metals",
  point: 0.01,
  digits: 2,
  tickSize: 0.01,
  tickValue: 1,
  contractSize: 100,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
  marginInitial: 0,
  swapLong: 0,
  swapShort: 0,
  commissionPerLot: 0,
  spreadPoints: 20,
};

const account: AccountSnapshot = {
  balance: 10_000,
  equity: 10_000,
  margin: 0,
  freeMargin: 10_000,
  marginLevel: Number.POSITIVE_INFINITY,
  currency: "USD",
  leverage: 100,
  mode: "hedging",
  isLive: false,
};

function barsAround(price: number, count = 120, startMs = 1_700_000_000_000): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 9) * 0.4;
    const open = price + drift;
    const close = open + 0.05;
    bars.push([startMs + i * 60_000, open, Math.max(open, close) + 0.2, Math.min(open, close) - 0.2, close, 100]);
  }
  return bars;
}

function deskWith(symbol: string, price: number, quotePrice: number, ts = Date.now()) {
  const desk = getDesk(`integrity-${symbol}-${Math.random()}`);
  desk.specs.set(symbol, { ...spec, symbol });
  desk.quotes.set(symbol, {
    symbol,
    bid: quotePrice,
    ask: quotePrice + 0.5,
    spreadPoints: 20,
    ts,
  });
  upsertCandles(desk, { symbol, timeframe: "M5" as Timeframe, bars: barsAround(price) });
  return desk;
}

// ── Clock ────────────────────────────────────────────────────────────────────

test("a terminal clock three hours fast is corrected, not trusted", () => {
  const desk = getDesk("integrity-clock");
  const now = 1_700_000_000_000;
  // A broker server on UTC+3 reports a "UTC" time three hours in the future.
  const skew = updateClockSkew(desk, now + 3 * 3_600_000, now);
  assert.ok(Math.abs(skew - 3 * 3_600_000) < 1, `expected a +3h skew, got ${skew}`);

  // A quote stamped with that fast clock is actually NOW, not three hours old.
  const health = { quote: { symbol: "X", bid: 1, ask: 1.01, spreadPoints: 1, ts: now + 3 * 3_600_000 } };
  assert.ok(quoteTimestampUsable(desk, health.quote, now));
});

test("clock skew is smoothed, not replaced, across heartbeats", () => {
  const desk = getDesk("integrity-smooth");
  const now = 1_700_000_000_000;
  updateClockSkew(desk, now + 10_000, now);
  const second = updateClockSkew(desk, now + 20_000, now);
  // One beat apart the estimate should not jump the full 10s.
  assert.ok(second < 20_000 && second > 10_000, `expected a smoothed value, got ${second}`);
});

test("a quote timestamped hours away from now is rejected outright", () => {
  const desk = getDesk("integrity-reject");
  const now = 1_700_000_000_000;
  assert.equal(
    quoteTimestampUsable(desk, { symbol: "X", bid: 1, ask: 1.01, spreadPoints: 1, ts: now - 12 * 3_600_000 }, now),
    false,
  );
  assert.equal(quoteTimestampUsable(desk, { symbol: "X", bid: 1, ask: 1.01, spreadPoints: 1, ts: 0 }, now), false);
  assert.equal(quoteTimestampUsable(desk, { symbol: "X", bid: 1, ask: 1.01, spreadPoints: 1, ts: now }, now), true);
});

test("bar timestamps far in the future are rejected", () => {
  const desk = getDesk("integrity-bars");
  const now = 1_700_000_000_000;
  assert.equal(barTimestampUsable(desk, now - 60_000, now), true);
  assert.equal(barTimestampUsable(desk, now + 40 * 24 * 3_600_000, now), false);
});

// ── Price sanity ─────────────────────────────────────────────────────────────

test("a quote consistent with the candles is not flagged", () => {
  const desk = deskWith("XAUUSD", 4105.35, 4105.35);
  const result = assessPrice(desk, "XAUUSD", desk.quotes.get("XAUUSD")!);
  assert.equal(result.mismatch, false);
  assert.equal(result.detail, null);
});

test("a quote far from the candles is flagged as a mismatch", () => {
  // The reported symptom: XAUUSD printing 5898 while the market is at 4105.
  const desk = deskWith("XAUUSD", 4105.35, 5898.46);
  const result = assessPrice(desk, "XAUUSD", desk.quotes.get("XAUUSD")!);
  assert.equal(result.mismatch, true);
  assert.ok(result.deviationPct !== null && result.deviationPct > 15);
  assert.match(result.detail ?? "", /5898|4105|cached/);
});

test("a mismatch blocks the symbol from being traded", () => {
  const desk = deskWith("XAUUSD", 4105.35, 5898.46);
  const health = feedHealth(desk, "XAUUSD");
  assert.equal(health.status, "mismatch");
  assert.ok(health.detail !== null);
});

test("an ordinary intraday move is not mistaken for a mismatch", () => {
  // Gold moving 1.5% intraday is a Tuesday, not a corrupt feed.
  const desk = deskWith("XAUUSD", 4105.35, 4167.0);
  const result = assessPrice(desk, "XAUUSD", desk.quotes.get("XAUUSD")!);
  assert.equal(result.mismatch, false);
});

test("a quote with no candle history is neither flagged nor trusted", () => {
  const desk = getDesk("integrity-nohistory");
  desk.specs.set("XAUUSD", spec);
  desk.quotes.set("XAUUSD", { symbol: "XAUUSD", bid: 5898, ask: 5899, spreadPoints: 20, ts: Date.now() });
  const result = assessPrice(desk, "XAUUSD", desk.quotes.get("XAUUSD")!);
  assert.equal(result.mismatch, false);
  assert.equal(result.deviationPct, null);
});

// ── Freshness ────────────────────────────────────────────────────────────────

test("an old quote is reported as stale with its age", () => {
  const desk = deskWith("XAUUSD", 4105.35, 4105.35, Date.now() - QUOTE_STALE_MS * 3);
  const health = feedHealth(desk, "XAUUSD");
  assert.equal(health.status, "stale");
  assert.ok((health.ageMs ?? 0) > QUOTE_STALE_MS);
  assert.match(health.detail ?? "", /old/);
});

test("a fresh quote is live and carries a small age", () => {
  const desk = deskWith("XAUUSD", 4105.35, 4105.35, Date.now() - 500);
  const health = feedHealth(desk, "XAUUSD");
  assert.equal(health.status, "live");
  assert.ok((health.ageMs ?? 1e9) < QUOTE_STALE_MS);
});

test("a symbol with no quote yet is warming, not stale", () => {
  const desk = getDesk("integrity-warming");
  const health = feedHealth(desk, "XAUUSD");
  assert.equal(health.status, "warming");
  assert.equal(health.ageMs, null);
});

// ── Equity sampling ──────────────────────────────────────────────────────────

test("equity history is throttled so a 1 Hz heartbeat does not flood it", () => {
  const desk = getDesk("integrity-equity");
  desk.equityHistory = [];
  desk.lastEquitySampleAt = 0;
  // 120 heartbeats one second apart span two minutes, so the 30 s throttle
  // should admit a handful of points rather than all 120.
  for (let i = 0; i < 120; i++) sampleEquity(desk, account, 1_700_000_000_000 + i * 1_000);
  assert.ok(desk.equityHistory.length > 0 && desk.equityHistory.length <= 5, `got ${desk.equityHistory.length} samples`);
});

test("equity history is bounded", () => {
  const desk = getDesk("integrity-equity-cap");
  desk.equityHistory = [];
  desk.lastEquitySampleAt = 0;
  for (let i = 0; i < 2_000; i++) sampleEquity(desk, account, 1_700_000_000_000 + i * 60_000);
  assert.ok(desk.equityHistory.length <= 720, `history grew to ${desk.equityHistory.length}`);
});

test("desks are isolated from each other", () => {
  const a = getDesk("integrity-iso-a");
  const b = getDesk("integrity-iso-b");
  a.watchlist = ["EURUSD"];
  assert.equal(b.watchlist.length, 0);
  resetDesk("integrity-iso-a");
});
