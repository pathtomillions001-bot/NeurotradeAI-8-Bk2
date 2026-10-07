/** High-impact economic-calendar freshness and fail-closed entry gate tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessNewsEntry,
  eventMatchesSpec,
  getNewsCalendarStatus,
  isNewsCalendarReady,
  NEWS_BLACKOUT_AFTER_MS,
  NEWS_BLACKOUT_BEFORE_MS,
} from "./news";
import type { HighImpactNewsEvent, NewsCalendarSnapshot, SymbolSpec } from "./types";

const now = 1_700_000_000_000;
const snapshot = (overrides: Partial<NewsCalendarSnapshot> = {}): NewsCalendarSnapshot => ({
  status: "ready",
  fetchedAt: now,
  coverageStart: now - 60 * 60_000,
  coverageEnd: now + 48 * 60 * 60_000,
  error: null,
  events: [],
  ...overrides,
});

const eurUsd = {
  symbol: "EURUSD.a",
  baseCurrency: "EUR",
  quoteCurrency: "USD",
} as SymbolSpec;

const usdEvent: HighImpactNewsEvent = {
  id: "usd-cpi",
  currency: "USD",
  title: "US CPI",
  impact: "high",
  ts: now + 20 * 60_000,
};

test("calendar readiness requires freshness and enough past/future coverage", () => {
  assert.equal(isNewsCalendarReady(snapshot(), now), true);
  assert.equal(getNewsCalendarStatus(snapshot(), now), "ready");
  assert.equal(isNewsCalendarReady(snapshot({ fetchedAt: now - 11 * 60_000 }), now), false);
  assert.equal(getNewsCalendarStatus(snapshot({ fetchedAt: now - 11 * 60_000 }), now), "stale");
  assert.equal(isNewsCalendarReady(snapshot({ coverageStart: now }), now), false);
  assert.equal(isNewsCalendarReady(snapshot({ coverageEnd: now + 30 * 60_000 }), now), false);
  assert.equal(isNewsCalendarReady(snapshot({ status: "unavailable" }), now), false);
});

test("currency matching is exact and uncertain instrument metadata fails conservatively", () => {
  assert.equal(eventMatchesSpec(usdEvent, eurUsd), true);
  assert.equal(eventMatchesSpec({ ...usdEvent, currency: "JPY" }, eurUsd), false);
  assert.equal(eventMatchesSpec(usdEvent, undefined), true);
  assert.equal(eventMatchesSpec({ ...usdEvent, currency: "*" }, eurUsd), true);
});

test("entry gate blocks stale calendars and matching pre/post-news windows", () => {
  const base = {
    error: null,
    events: [usdEvent],
    blackoutBeforeMs: NEWS_BLACKOUT_BEFORE_MS,
    blackoutAfterMs: NEWS_BLACKOUT_AFTER_MS,
  };
  const unavailable = assessNewsEntry({ ...base, ready: false, error: "stale" }, eurUsd, now);
  assert.equal(unavailable.allowed, false);
  assert.match(unavailable.reason ?? "", /calendar is unavailable, stale, or lacks coverage/i);

  const beforeRelease = assessNewsEntry({ ...base, ready: true }, eurUsd, now);
  assert.equal(beforeRelease.allowed, false);
  assert.match(beforeRelease.reason ?? "", /USD high-impact news blackout: US CPI/i);

  const afterWindow = assessNewsEntry({ ...base, ready: true }, eurUsd, usdEvent.ts + NEWS_BLACKOUT_AFTER_MS + 1);
  assert.equal(afterWindow.allowed, true);
});
