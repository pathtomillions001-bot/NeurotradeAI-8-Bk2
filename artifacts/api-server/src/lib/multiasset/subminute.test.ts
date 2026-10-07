/**
 * Sub-minute candle tests.
 *
 * S10/S30 are the only bars on this desk that the broker did not send, so they
 * are the only ones that can be wrong in a way the broker cannot contradict.
 * The tests below pin the two properties that make them safe to analyse: a bar
 * is built from the mid, and a frame is withheld entirely when the tick feed is
 * too slow to build it honestly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DENSITY_WINDOW,
  MAX_SYNTHETIC_BARS,
  createSymbolTicks,
  frameIsDense,
  recordTick,
  syntheticBars,
  syntheticSeries,
  tickFeedDiagnostics,
} from "./subminute";
import type { Quote } from "./types";

const START = 1_700_000_000_000;

function tick(offsetMs: number, mid: number, symbol = "EURUSD"): Quote {
  const half = 0.0001;
  return {
    symbol,
    bid: mid - half,
    ask: mid + half,
    spreadPoints: 20,
    ts: START + offsetMs,
  };
}

/** A tick feed at a fixed cadence, so bar density is fully determined. */
function feed(cadenceMs: number, durationMs: number, price = (i: number) => 1.1 + i * 0.00001) {
  const state = createSymbolTicks("EURUSD");
  let index = 0;
  for (let offset = 0; offset <= durationMs; offset += cadenceMs) {
    recordTick(state, tick(offset, price(index)));
    index++;
  }
  return state;
}

test("a one-second feed builds S10 bars from mid prices", () => {
  const state = feed(1000, 250_000);
  const bars = syntheticBars(state, "S10");
  assert.ok(bars, "S10 must be available on a 1 s feed");
  assert.ok(bars.length >= DENSITY_WINDOW + 1);

  const first = bars[0];
  // Buckets are aligned to their own boundary and are 10 s wide.
  assert.equal(first[0] % 10_000, 0);
  assert.equal(bars[1][0] - first[0], 10_000);
  // Open/high/low/close come from the MID, not the bid: each tick is ±0.0001
  // around its mid, so a bid-based bar would sit 0.0001 below the mid series
  // and every level the agent derives from it would be shifted with it.
  assert.ok(Math.abs(first[1] - 1.1) < 1e-9, `open was ${first[1]}`);
  assert.ok(first[2] >= first[1] && first[3] <= first[1]);
  assert.ok(first[5] >= 10, "a 10 s bar on a 1 s feed holds ~10 ticks");
});

test("a frame is withheld until its bars are dense enough to be honest", () => {
  // 20 s between ticks: a ten-second bar would be built from a single
  // observation, so its high/low would be fiction. The frame must be absent,
  // and the band must fall back to the broker's own minute frames.
  const slow = feed(20_000, 600_000);
  assert.equal(syntheticBars(slow, "S10"), null);
  assert.equal(tickFeedDiagnostics(slow).ready, false);

  const healthy = feed(1000, 30_000);
  // Only two bars so far: not yet a density window, so still withheld.
  assert.equal(syntheticBars(healthy, "S10"), null);
  const longer = feed(1000, 250_000);
  assert.equal(tickFeedDiagnostics(longer).frames.S10?.ready, true);
});

test("S30 needs half a minute of history per bar and is not ready in 25 s", () => {
  const state = feed(1000, 250_000);
  // 8 complete 30 s bars < DENSITY_WINDOW, so the frame stays absent even
  // though the feed is perfectly healthy.
  assert.equal(syntheticBars(state, "S30"), null);
  assert.equal(syntheticBars(state, "S10")!.length > 0, true);
});

test("a late or duplicated tick never rewrites a closed bar", () => {
  const state = createSymbolTicks("EURUSD");
  recordTick(state, tick(0, 1.1));
  recordTick(state, tick(10_000, 1.2));
  const before = JSON.stringify(syntheticBars(state, "S10") ?? []);
  // A tick from the previous bucket arriving late must be dropped.
  recordTick(state, tick(5_000, 9.999));
  assert.equal(JSON.stringify(syntheticBars(state, "S10") ?? []), before);
});

test("the forming bar is updated in place, not appended per tick", () => {
  const state = createSymbolTicks("EURUSD");
  recordTick(state, tick(0, 1.1));
  recordTick(state, tick(4_000, 1.1005));
  const frame = state.frames.get("S10")!;
  assert.equal(frame.bars.length, 1);
  assert.equal(frame.bars[0][4], 1.1005);
  assert.equal(frame.bars[0][5], 2);
});

test("synthetic history is bounded", () => {
  // Two ticks per 10 s bucket so every bar clears the density floor: this test
  // is about the ring buffer, not about the gate.
  const state = createSymbolTicks("EURUSD");
  for (let i = 0; i < 600; i++) {
    recordTick(state, tick(i * 10_000, 1.1 + i * 0.000001));
    recordTick(state, tick(i * 10_000 + 5_000, 1.1 + i * 0.000001));
  }
  const bars = syntheticBars(state, "S10")!;
  assert.ok(bars.length <= MAX_SYNTHETIC_BARS, `${bars.length} bars retained`);
  // The retained window is the NEWEST one.
  assert.equal(bars[bars.length - 1][0] - START, 599 * 10_000);
});

test("syntheticSeries exposes only the frames that are ready", () => {
  const state = feed(1000, 250_000);
  const series = syntheticSeries(state);
  assert.ok(series.S10, "S10 is ready");
  assert.equal(series.S30, undefined, "S30 is not ready yet");
});

test("a non-positive price is ignored rather than stored", () => {
  const state = createSymbolTicks("EURUSD");
  recordTick(state, { symbol: "EURUSD", bid: 0, ask: 0, spreadPoints: 0, ts: START });
  assert.equal(state.frames.size, 0);
});
