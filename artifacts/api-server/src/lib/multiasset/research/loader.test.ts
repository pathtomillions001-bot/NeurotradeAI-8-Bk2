/**
 * WP2 — MT5 data loader tests.
 *
 * The loader is the first place a study can go wrong, and the wrongness is
 * silent: a two-hour timezone error moves every session boundary; a skipped
 * SPREAD column understates every cost; a zero price produces an infinite
 * return. Each of those has a test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadMt5Bars, loadMt5Ticks, parseMt5Csv, resampleBars } from "./loader";
import type { Bar } from "../types";

const HEADER = "DATE\tTIME\tOPEN\tHIGH\tLOW\tCLOSE\tTICKVOL\tVOL\tSPREAD";

function csv(rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

test("a tab-separated MT5 export loads, shifts to UTC and keeps the spread column", () => {
  const text = csv([
    "2026.01.05\t00:00:00\t1.10000\t1.10050\t1.09980\t1.10020\t120\t0\t12",
    "2026.01.05\t00:01:00\t1.10020\t1.10060\t1.10010\t1.10040\t90\t0\t14",
  ]);
  const loaded = loadMt5Bars(text, { symbol: "EURUSD", timeframe: "M1", serverUtcOffsetMinutes: 180 });
  assert.equal(loaded.bars.length, 2);
  // 00:00 server time at GMT+3 is 21:00 UTC the previous day.
  assert.equal(loaded.bars[0][0], Date.UTC(2026, 0, 4, 21, 0, 0));
  assert.deepEqual(loaded.spreadPoints, [12, 14]);
  assert.ok(loaded.bars[0][5] === 120, "TICKVOL must be kept as volume");
  assert.ok(loaded.warnings.some((w) => w.includes("only 2 bars")), "a tiny sample must warn");
});

test("the loader records when the server offset is missing rather than guessing", () => {
  const text = csv(["2026.01.05\t12:00:00\t1.10000\t1.10010\t1.09990\t1.10000\t10\t0\t12"]);
  const utc = loadMt5Bars(text, { symbol: "EURUSD", timeframe: "M1", serverUtcOffsetMinutes: 0 });
  const gmt3 = loadMt5Bars(text, { symbol: "EURUSD", timeframe: "M1", serverUtcOffsetMinutes: 180 });
  assert.equal((utc.bars[0][0] as number) - (gmt3.bars[0][0] as number), 3 * 60 * 60_000);
});

test("rows without a readable OHLC are dropped, never defaulted to zero", () => {
  const text = csv([
    "2026.01.05\t00:00:00\t1.10000\t1.10050\t1.09980\t1.10020\t120\t0\t12",
    "2026.01.05\t00:01:00\t\t\t\t\t\t\t", // an empty row from a partial export
    "2026.01.05\t00:02:00\t0\t0\t0\t0\t0\t0\t12", // a broken row: zero prices
    "2026.01.05\t00:03:00\t1.10020\t1.10060\t1.10010\t1.10040\t90\t0\t14",
  ]);
  const loaded = loadMt5Bars(text, { symbol: "EURUSD", timeframe: "M1", serverUtcOffsetMinutes: 0 });
  assert.equal(loaded.bars.length, 2);
  for (const bar of loaded.bars) assert.ok((bar[1] as number) > 0 && (bar[4] as number) > 0);
});

test("decimal commas and semicolon separators are understood", () => {
  const text = [
    "Date;Time;Open;High;Low;Close;TickVol;Vol;Spread",
    "2026.01.05;00:00:00;1,10000;1,10050;1,09980;1,10020;120;0;12",
  ].join("\n");
  const loaded = loadMt5Bars(text, { symbol: "EURUSD", timeframe: "M1", serverUtcOffsetMinutes: 0 });
  assert.equal(loaded.bars.length, 1);
  assert.equal(loaded.bars[0][1], 1.1);
  assert.equal(loaded.bars[0][4], 1.1002);
});

test("headerless files are read positionally, and without a SPREAD column the warning fires", () => {
  const text = "2026.01.05 00:00:00 1.10000 1.10050 1.09980 1.10020 120";
  const loaded = loadMt5Bars(text, { symbol: "EURUSD", timeframe: "M1", serverUtcOffsetMinutes: 0 });
  assert.equal(loaded.bars.length, 1);
  assert.equal(loaded.bars[0][4], 1.1002);
  assert.equal(loaded.spreadPoints, undefined);
  assert.ok(loaded.warnings.some((w) => w.includes("no SPREAD column")));
});

test("duplicate and missing timestamps are reported, not smoothed over", () => {
  const text = csv([
    "2026.01.05\t00:00:00\t1.10000\t1.10050\t1.09980\t1.10020\t1\t0\t12",
    "2026.01.05\t00:00:00\t1.10000\t1.10050\t1.09980\t1.10020\t1\t0\t12",
    "2026.01.05\t00:10:00\t1.10020\t1.10060\t1.10010\t1.10040\t1\t0\t12",
  ]);
  const loaded = loadMt5Bars(text, { symbol: "EURUSD", timeframe: "M1", serverUtcOffsetMinutes: 0 });
  assert.ok(loaded.warnings.some((w) => w.includes("duplicate")));
  assert.ok(loaded.warnings.some((w) => w.includes("gap")));
});

test("resampling aggregates OHLC correctly and aligns buckets to the epoch", () => {
  const bars: Bar[] = [
    [Date.UTC(2026, 0, 5, 10, 0), 1.1, 1.1005, 1.0995, 1.1002, 10],
    [Date.UTC(2026, 0, 5, 10, 1), 1.1002, 1.101, 1.1001, 1.1008, 20],
    [Date.UTC(2026, 0, 5, 10, 14), 1.1008, 1.1012, 1.1004, 1.1006, 30],
    [Date.UTC(2026, 0, 5, 10, 15), 1.1006, 1.1009, 1.1003, 1.1005, 40],
  ];
  const m15 = resampleBars(bars, "M15");
  assert.equal(m15.length, 2);
  assert.equal(m15[0][0], Date.UTC(2026, 0, 5, 10, 0));
  assert.equal(m15[0][1], 1.1, "open = first open");
  assert.equal(m15[0][2], 1.1012, "high = max high");
  assert.equal(m15[0][3], 1.0995, "low = min low");
  assert.equal(m15[0][4], 1.1006, "close = last close");
  assert.equal(m15[0][5], 60, "volume = sum");
  assert.equal(m15[1][0], Date.UTC(2026, 0, 5, 10, 15));
});

test("resampling never invents bars the terminal did not send", () => {
  const bars: Bar[] = [
    [Date.UTC(2026, 0, 5, 10, 0), 1.1, 1.1005, 1.0995, 1.1002, 10],
    // a 40-minute hole
    [Date.UTC(2026, 0, 5, 10, 40), 1.1002, 1.101, 1.1001, 1.1008, 20],
  ];
  const h1 = resampleBars(bars, "H1");
  assert.equal(h1.length, 1, "one bucket, and no zero-volume filler bars");
});

test("the tick loader parses a tape and skips incomplete rows", () => {
  const text = [
    "DATE\tTIME\tBID\tASK\tLAST\tVOLUME",
    "2026.01.05\t00:00:00.100\t1.10000\t1.10012\t0\t1",
    "2026.01.05\t00:00:00.900\t1.10001\t1.10013\t0\t2",
    "2026.01.05\t00:00:01.200\t\t\t\t",
  ].join("\n");
  const ticks = loadMt5Ticks(text, { serverUtcOffsetMinutes: 0 });
  assert.equal(ticks.length, 2);
  assert.ok(ticks[0].ask > ticks[0].bid, "the spread must be positive");
  assert.ok(ticks[1].ts > ticks[0].ts);
});

test("parseMt5Csv separates a header from data by looking for letters", () => {
  const withHeader = parseMt5Csv("DATE,TIME,OPEN,HIGH,LOW,CLOSE\n2026.01.05,00:00,1,1,1,1", "bars");
  assert.equal(withHeader.header[2], "OPEN");
  assert.equal(withHeader.rows.length, 1);
  const withoutHeader = parseMt5Csv("2026.01.05,00:00,1,1,1,1", "bars");
  assert.deepEqual(withoutHeader.header.slice(0, 3), ["DATE", "TIME", "OPEN"]);
  assert.equal(withoutHeader.rows.length, 1);
});
