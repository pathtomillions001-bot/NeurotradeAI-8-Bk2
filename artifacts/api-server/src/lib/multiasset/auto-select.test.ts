/**
 * Automatic best-market selection tests.
 *
 * The promise under test is the one the desk is judged on: with auto-trade on,
 * the system looks at the markets the USER selected, ranks the ones that pass
 * every gate, and arms the best — and when nothing qualifies it says why,
 * naming the closest miss, instead of going quiet.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_SELECT_INTERVAL_MS,
  AUTO_SELECT_MAX_CANDIDATES,
  autoSelectCandidates,
  autoSelectDue,
  maybeAutoSelect,
  runAutoSelect,
} from "./auto-select";
import { emptyAvailableNewsFeed } from "./news";
import { getDesk, resetDesk, upsertCandles, type DeskState } from "./store";
import { makeRng } from "./math";
import type { AccountSnapshot, Bar, Position, Quote, SymbolSpec, Timeframe } from "./types";
import { TIMEFRAMES } from "./types";

let counter = 0;
const NOW = 1_800_000_000_000;

/** A clean uptrend, so the agent has something it can actually arm. */
function trendUp(count = 220, start = 1.08, drift = 0.0006, noise = 0.0002, seed = 1): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    price = open * Math.exp(drift + (rng() - 0.5) * noise);
    const high = Math.max(open, price) * (1 + rng() * noise * 0.5);
    const low = Math.min(open, price) * (1 - rng() * noise * 0.5);
    bars.push([NOW - (count - i) * 60_000, open, high, low, price, 100]);
  }
  return bars;
}

/** A dead range — directionless, so it must be refused. */
function flat(count = 220, start = 1.08, seed = 4): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const mid = start * (1 + Math.sin(i / 7) * 0.0002);
    const open = mid * (1 + (rng() - 0.5) * 0.00003);
    const close = mid * (1 + (rng() - 0.5) * 0.00003);
    bars.push([NOW - (count - i) * 60_000, open, Math.max(open, close) * 1.00001, Math.min(open, close) * 0.99999, close, 100]);
  }
  return bars;
}

const account: AccountSnapshot = {
  balance: 10_000,
  equity: 10_000,
  margin: 0,
  freeMargin: 10_000,
  marginLevel: Number.POSITIVE_INFINITY,
  currency: "USD",
  leverage: 500,
  mode: "hedging",
  isLive: false,
  dayStartEquity: 10_000,
  peakEquity: 10_000,
};

function specFor(symbol: string, spreadPoints = 8): SymbolSpec {
  return {
    symbol,
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
    spreadPoints,
    baseCurrency: "EUR",
    quoteCurrency: "USD",
  };
}

function quoteFor(symbol: string, last: number, spreadPoints = 8): Quote {
  const half = (spreadPoints * 0.00001) / 2;
  return { symbol, bid: last - half, ask: last + half, spreadPoints, ts: NOW };
}

/**
 * A desk with a fresh terminal, an account and one streamed market per entry.
 * `steady` builds a plan-able trend, `dead` a market that can never qualify.
 */
function deskWith(markets: { symbol: string; bars?: Bar[]; spreadPoints?: number }[]): DeskState {
  const id = `auto-select-test-${counter++}`;
  resetDesk(id);
  const desk = getDesk(id);
  desk.terminal = {
    accountId: "mt5:1@test",
    login: 1,
    server: "test",
    company: "test",
    bridgeToken: "t",
    pairedAt: NOW,
    lastSyncAt: NOW,
    lastSeq: 1,
    syncIntervalMs: 500,
  };
  desk.account = { ...account };
  desk.news = emptyAvailableNewsFeed(NOW);
  desk.mode = "intraday";
  desk.autoTrade = true;

  for (const market of markets) {
    const bars = market.bars ?? trendUp();
    desk.watchlist.push(market.symbol);
    desk.catalog.set(market.symbol, {
      symbol: market.symbol,
      description: market.symbol,
      path: "",
      assetClass: "forex",
      tradeable: true,
    });
    desk.specs.set(market.symbol, specFor(market.symbol, market.spreadPoints ?? 8));
    desk.quotes.set(market.symbol, quoteFor(market.symbol, bars[bars.length - 1][4], market.spreadPoints ?? 8));
    for (const timeframe of TIMEFRAMES) {
      upsertCandles(desk, { symbol: market.symbol, timeframe: timeframe as Timeframe, bars });
    }
  }
  return desk;
}

test("the best qualifying market is the one armed", () => {
  // Three markets: one dead range, two trends. Both trends qualify; the pass
  // must arm exactly one plan — the better of them — and say so.
  const desk = deskWith([
    { symbol: "AAAUSD", bars: flat() },
    { symbol: "BBBUSD", bars: trendUp(220, 1.08, 0.0006, 0.0002, 2) },
    { symbol: "CCCUSD", bars: trendUp(220, 1.08, 0.0006, 0.0002, 3) },
  ]);

  const outcome = runAutoSelect(desk, NOW);
  assert.ok(outcome);
  assert.equal(outcome.record.scanned, 3);
  assert.ok(outcome.record.qualified >= 1, "at least one trend must qualify");
  assert.ok(outcome.record.chosen, "a market must be chosen");
  assert.notEqual(outcome.record.chosen, "AAAUSD", "the dead range must never win");
  assert.equal(desk.plans.size, 1, "exactly one plan per pass");
  assert.equal([...desk.plans.values()][0]!.symbol, outcome.record.chosen);
  assert.match(outcome.record.reason, /Best of 3 selected markets/);
});

test("the ranking prefers expectancy after costs, not raw quality", () => {
  const desk = deskWith([
    { symbol: "AAAUSD", bars: trendUp(220, 1.08, 0.0006, 0.0002, 5) },
    { symbol: "BBBUSD", bars: trendUp(220, 1.08, 0.0006, 0.0002, 6) },
  ]);
  const outcome = runAutoSelect(desk, NOW);
  assert.ok(outcome);
  const ranked = outcome.record.ranked;
  for (let i = 1; i < ranked.length; i++) {
    const previous = ranked[i - 1]!;
    const current = ranked[i]!;
    const a = previous.expectancyR ?? Number.NEGATIVE_INFINITY;
    const b = current.expectancyR ?? Number.NEGATIVE_INFINITY;
    assert.ok(a >= b, `rank ${i} out of order: ${a} < ${b}`);
  }
});

test("a market that already has a plan or a position is not re-armed", () => {
  const desk = deskWith([{ symbol: "AAAUSD" }]);
  // An open position on the only selected market: nothing left to look at.
  const position: Position = {
    ticket: 5,
    symbol: "AAAUSD",
    side: "buy",
    volume: 0.1,
    openPrice: 1.08,
    openTime: NOW - 1000,
    sl: 1.07,
    tp: 1.09,
    profit: 0,
    swap: 0,
    commission: 0,
  };
  desk.positions = [position];
  assert.deepEqual(autoSelectCandidates(desk), []);
  const outcome = runAutoSelect(desk, NOW);
  assert.ok(outcome);
  assert.equal(outcome.record.chosen, null);
  assert.equal(outcome.record.scanned, 0);
});

test("when nothing qualifies the closest miss is named", () => {
  const desk = deskWith([{ symbol: "AAAUSD", bars: flat() }, { symbol: "BBBUSD", bars: flat(220, 1.08, 9) }]);
  const outcome = runAutoSelect(desk, NOW);
  assert.ok(outcome);
  assert.equal(outcome.record.qualified, 0);
  assert.equal(outcome.record.chosen, null);
  assert.match(outcome.record.reason, /No qualifying setup/);
  assert.match(outcome.record.reason, /Closest: /);
  assert.equal(desk.plans.size, 0);
});

/**
 * THE REPORTED BUG: "the closest market is one that can't trade, while our A+
 * setups sit right there".
 *
 * The desk named `decisions[0]` — the first market in the watchlist order — as
 * the closest miss. That is a statement about the watchlist, not about the
 * market: it can point at a setup that failed the quality gate by twenty points
 * while an A+ setup failed only the economics, which is exactly what the user
 * was shown (EURUSD.m quality 36.9 "closest", US30.std A+ 83 with E -0.71R).
 *
 * The closest miss must be the setup that would trade if ONE gate were relaxed:
 * an analysis survivor first, ranked by the expectancy that stopped it.
 */
test("the closest miss is the best analysis survivor, not the first market scanned", () => {
  const desk = deskWith([
    // Scanned first, and hopeless: a dead range that fails on quality.
    { symbol: "AAAUSD", bars: flat() },
    // Scanned second, A+ on every analysis gate, refused only on economics:
    // the same trend as the arming fixture, quoted with a spread wide enough
    // to make the round trip cost more than the edge it finds.
    { symbol: "BBBUSD", bars: trendUp(220, 1.08, 0.0006, 0.0002, 12), spreadPoints: 2000 },
  ]);
  const outcome = runAutoSelect(desk, NOW);
  assert.ok(outcome);
  assert.equal(outcome.record.chosen, null);

  const bbb = outcome.record.ranked.find((row) => row.symbol === "BBBUSD");
  const aaa = outcome.record.ranked.find((row) => row.symbol === "AAAUSD");
  assert.ok(bbb && aaa);
  assert.ok(bbb.score > aaa.score, "the fixture must have BBB as the better setup");

  assert.match(outcome.record.reason, /Closest: BBBUSD/, outcome.record.reason);
  assert.ok(!/Closest: AAAUSD/.test(outcome.record.reason), outcome.record.reason);
  // And the table the desk shows is ordered the same way, so the named row is
  // the row at the top.
  assert.equal(outcome.record.ranked[0]!.symbol, "BBBUSD");
});

test("a market skipped for bad data is named, not silently dropped", () => {
  const desk = deskWith([
    { symbol: "AAAUSD", bars: trendUp(220, 1.08, 0.0006, 0.0002, 21) },
    { symbol: "BBBUSD", bars: trendUp(220, 1.08, 0.0006, 0.0002, 22) },
  ]);
  // BBBUSD stops ticking long before the pass.
  desk.quotes.get("BBBUSD")!.ts = NOW - 5 * 60_000;
  const outcome = runAutoSelect(desk, NOW);
  assert.ok(outcome);
  assert.deepEqual(outcome.record.skipped, ["BBBUSD"], "the skipped market must be reported by name");
  assert.match(outcome.record.reason, /BBBUSD/);
});

test("auto-trade off means the pass does not run at all", () => {
  const desk = deskWith([{ symbol: "AAAUSD" }]);
  desk.autoTrade = false;
  assert.equal(autoSelectDue(desk, NOW), false);
  assert.equal(runAutoSelect(desk, NOW), null);
  assert.equal(desk.plans.size, 0);
});

/**
 * Two-stage terminal health, and the pass must respect both stages.
 *
 * A terminal that misses a few heartbeats is DEGRADED, not gone: every symbol
 * is still gated on its own quote age, so the desk keeps working and says
 * "reconnecting" instead of "paused". A single 30-second cliff used to stop the
 * whole desk — the user saw it as "the MT5 terminal last synced 39s ago …
 * Quotes and agent entries are paused" on a terminal that was still streaming.
 * The pass only stops when the terminal is genuinely written off.
 */
test("a late heartbeat degrades the desk but does not stop the pass", () => {
  const desk = deskWith([{ symbol: "AAAUSD", bars: trendUp(220, 1.08, 0.0006, 0.0002, 3) }]);
  desk.terminal!.lastSyncAt = NOW - 60_000; // well past the old 30 s cliff
  assert.ok(autoSelectDue(desk, NOW), "a late terminal is still workable");
  assert.ok(runAutoSelect(desk, NOW), "the pass must run while quotes are individually fresh");
});

test("a terminal that has genuinely gone silent stops the pass", () => {
  const desk = deskWith([{ symbol: "AAAUSD" }]);
  desk.terminal!.lastSyncAt = NOW - 10 * 60_000; // past every window, adaptive included
  assert.equal(autoSelectDue(desk, NOW), false);
  assert.equal(runAutoSelect(desk, NOW), null);
});

test("a stale quote skips that market but the pass still runs for the others", () => {
  const desk = deskWith([
    { symbol: "AAAUSD" },
    { symbol: "BBBUSD", bars: trendUp(220, 1.08, 0.0006, 0.0002, 7) },
  ]);
  // AAAUSD stops ticking 30 s before the pass.
  desk.quotes.set("AAAUSD", { ...desk.quotes.get("AAAUSD")!, ts: NOW - 30_000 });
  const outcome = runAutoSelect(desk, NOW);
  assert.ok(outcome);
  assert.equal(outcome.record.scanned, 1, "only the fresh market is analysed");
  assert.notEqual(outcome.record.chosen, "AAAUSD");
});

test("the pass is throttled per mode and respects the auto-trade flag", () => {
  const desk = deskWith([{ symbol: "AAAUSD" }]);
  desk.lastAutoSelectAt = NOW;
  assert.equal(autoSelectDue(desk, NOW), false);
  assert.equal(autoSelectDue(desk, NOW + AUTO_SELECT_INTERVAL_MS.intraday), true);

  desk.mode = "scalp";
  assert.equal(autoSelectDue(desk, NOW + AUTO_SELECT_INTERVAL_MS.scalp), true);
  desk.lastAutoSelectAt = NOW;
  assert.equal(autoSelectDue(desk, NOW + AUTO_SELECT_INTERVAL_MS.scalp - 1), false);

  const dueAt = NOW + AUTO_SELECT_INTERVAL_MS.scalp;
  const outcome = maybeAutoSelect(desk, dueAt);
  assert.ok(outcome, "a due pass runs through maybeAutoSelect");
  assert.equal(maybeAutoSelect(desk, dueAt), null, "the second call in the same window is throttled");
  assert.equal(desk.lastAutoSelect?.chosen, outcome.record.chosen);
});

test("a long watchlist is covered by rotating a bounded window", () => {
  const markets = Array.from({ length: 40 }, (_, i) => ({ symbol: `SYM${String(i).padStart(3, "0")}` }));
  const desk = deskWith(markets);
  const first = autoSelectCandidates(desk);
  assert.equal(first.length, AUTO_SELECT_MAX_CANDIDATES);
  const second = autoSelectCandidates(desk);
  assert.equal(second.length, AUTO_SELECT_MAX_CANDIDATES);
  const overlap = first.filter((symbol) => second.includes(symbol));
  assert.equal(overlap.length, 0, "successive passes must sweep different markets");
});

test("every selected market is eventually swept", () => {
  const markets = Array.from({ length: 33 }, (_, i) => ({ symbol: `SYM${String(i).padStart(3, "0")}` }));
  const desk = deskWith(markets);
  const seen = new Set<string>();
  for (let pass = 0; pass < 4; pass++) {
    for (const symbol of autoSelectCandidates(desk)) seen.add(symbol);
  }
  assert.equal(seen.size, 33, "four passes must cover the whole selection");
});
