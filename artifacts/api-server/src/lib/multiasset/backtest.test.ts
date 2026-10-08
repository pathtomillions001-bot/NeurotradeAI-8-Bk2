/**
 * Walk-forward harness. The most important test here is the no-look-ahead one:
 * if the future cannot change the past, the replay's numbers mean something.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main as runCli } from "./backtest-cli";
import {
  aggregateBars,
  exitForBar,
  parseCsv,
  runBacktest,
  TIMEFRAME_MINUTES,
  trendStillFavourable,
  visibleCount,
  type BacktestConfig,
  type OpenTrade,
} from "./backtest";
import { makeRng } from "./math";
import type { Bar, ManagementPlan, SymbolSpec } from "./types";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 0); // a Monday

const spec = {
  symbol: "EURUSD", digits: 5, point: 0.00001, tickSize: 0.00001, tickValue: 1, contractSize: 100_000,
  volumeMin: 0.01, volumeStep: 0.01, volumeMax: 100, spreadPoints: 8, stopsLevel: 0, freezeLevel: 0,
  marginInitial: 0, swapLong: 0, swapShort: 0, commissionPerLot: 0, currency: "USD", assetClass: "forex",
} as unknown as SymbolSpec;

/** A deterministic random walk with a constant per-bar drift. */
function walk(count: number, drift: number, seed: number, start = 1.08): Bar[] {
  const rng = makeRng(seed);
  const sigma = 0.0003;
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
    price = open * Math.exp(drift + sigma * z);
    const high = Math.max(open, price) * (1 + sigma * rng() * 0.3);
    const low = Math.min(open, price) * (1 - sigma * rng() * 0.3);
    bars.push([T0 + i * MIN, open, high, low, price, 100]);
  }
  return bars;
}

const baseConfig: BacktestConfig = {
  symbol: "EURUSD",
  mode: "intraday",
  spec,
  balance: 10_000,
  spreadPoints: 8,
  slippagePoints: 2,
  commissionPerLot: 3,
  decisionEvery: 15,
};

// ── Data ─────────────────────────────────────────────────────────────────────

test("parseCsv reads MT5-style, ISO and epoch times, and sorts them", () => {
  const csv = [
    "time,open,high,low,close,tick_volume",
    "2026.01.05 00:02,1.1,1.2,1.0,1.15,10",
    "2026-01-05T00:00:00Z,1.0,1.1,0.9,1.05,12",
    `${T0 + MIN},1.05,1.1,1.0,1.02,8`,
  ].join("\n");
  const bars = parseCsv(csv);
  assert.equal(bars.length, 3);
  assert.deepEqual(bars.map((b) => b[0]), [T0, T0 + MIN, T0 + 2 * MIN]);
  assert.equal(bars[2]![5], 10, "tick_volume is read as volume");
});

test("parseCsv rejects a corrupt bar and names its line", () => {
  // high below the close: the bar cannot be real.
  const csv = ["time,open,high,low,close", "2026-01-05T00:00:00Z,1.0,1.1,0.9,1.05", "2026-01-05T00:01:00Z,1.0,1.02,0.9,1.05"].join("\n");
  assert.throws(() => parseCsv(csv), /line 3: high\/low do not bracket/);
});

test("parseCsv needs the price columns", () => {
  assert.throws(() => parseCsv("time,open,close\n2026-01-05T00:00:00Z,1,1"), /must include time, open, high, low and close/);
});

test("aggregateBars builds OHLCV, and weeks start on Monday", () => {
  const m1: Bar[] = [
    [T0, 1.0, 1.3, 0.9, 1.1, 5],
    [T0 + MIN, 1.1, 1.4, 1.05, 1.2, 6],
    [T0 + 2 * MIN, 1.2, 1.25, 0.8, 1.0, 7],
    [T0 + 3 * MIN, 1.0, 1.1, 0.95, 1.05, 8],
    [T0 + 4 * MIN, 1.05, 1.2, 1.0, 1.15, 9],
  ];
  const m5 = aggregateBars(m1, 5);
  assert.equal(m5.length, 1);
  assert.deepEqual(m5[0], [T0, 1.0, 1.4, 0.8, 1.15, 35]);

  const weekly = aggregateBars(walk(3 * 24 * 60, 0, 1), 10080);
  assert.equal((weekly[0] as Bar)[0] % (7 * 86_400_000), 4 * 86_400_000 % (7 * 86_400_000), "week opens on a Monday 00:00 UTC");
});

test("a higher-timeframe bar is not visible until its period has closed", () => {
  // The M5 bar that starts at T0 closes at T0 + 5 min. Before that it must not be used.
  const m5 = aggregateBars(walk(20, 0, 2), 5);
  const span = 5 * MIN;
  assert.equal(visibleCount(m5, span, T0 + 4 * MIN), 0, "the forming bar is excluded at 00:04");
  assert.equal(visibleCount(m5, span, T0 + 5 * MIN), 1, "it becomes visible exactly at its close");
});

// ── Trade mechanics ──────────────────────────────────────────────────────────

const management: ManagementPlan = {
  breakeven: { triggerR: 1, offsetR: 0.1 },
  extension: null,
  timeStop: { maxHoldMinutes: 10 },
  guards: { maxSpreadPoints: 20, newsBlackoutMin: 30, flatBeforeSessionClose: false },
};

function longTrade(overrides: Partial<OpenTrade> = {}): OpenTrade {
  return {
    planId: "p", mode: "intraday", symbol: "EURUSD", isBuy: true, lots: 0.1,
    entry: 1.1, sl: 1.09, tp: 1.12, openTime: T0, riskPrice: 0.01, riskMoney: 50,
    management, beDone: false, extendState: 0, mfeR: 0, maeR: 0, ...overrides,
  };
}

const COSTS = { halfSpread: 0, slippage: 0 };

test("when a bar touches both the stop and the target, the stop wins", () => {
  // A wide bar that reaches 1.085 and 1.125 in the same minute. Path unknown: assume the stop.
  const hit = exitForBar(longTrade(), [T0 + MIN, 1.1, 1.125, 1.085, 1.1, 1], COSTS);
  assert.equal(hit?.reason, "sl");
  assert.equal(hit?.price, 1.09);
});

test("a target touched alone is taken at the target price", () => {
  const hit = exitForBar(longTrade(), [T0 + MIN, 1.1, 1.121, 1.099, 1.12, 1], COSTS);
  assert.equal(hit?.reason, "tp");
  assert.equal(hit?.price, 1.12);
});

test("a stop moved to breakeven is reported as breakeven, not as a loss", () => {
  const hit = exitForBar(longTrade({ beDone: true, sl: 1.1 + 0.001 }), [T0 + MIN, 1.1, 1.1, 1.0, 1.0, 1], COSTS);
  assert.equal(hit?.reason, "breakeven_stop");
});

test("the time stop closes at the bar that completes the hold, net of costs", () => {
  const tradeOpen = longTrade({ sl: 1.05, tp: 1.2 });
  // Hold of 10 minutes ends with the bar that starts at T0 + 9 min.
  const bar: Bar = [T0 + 9 * MIN, 1.1, 1.101, 1.099, 1.1005, 1];
  const hit = exitForBar(tradeOpen, bar, { halfSpread: 0.00004, slippage: 0.00002 });
  assert.equal(hit?.reason, "time_stop");
  assert.equal(hit?.time, T0 + 10 * MIN);
  assert.ok(Math.abs((hit?.price ?? 0) - (1.1005 - 0.00006)) < 1e-12, "sold at the close less spread and slippage");
});

test("the trend filter needs an EMA that is rising, with price on the trade's side", () => {
  const rising = Array.from({ length: 300 }, (_, i) => 1 + i * 0.0005);
  const falling = Array.from({ length: 300 }, (_, i) => 2 - i * 0.0005);
  const flat = Array.from({ length: 300 }, () => 1.1);
  assert.equal(trendStillFavourable(rising, true, 50), true);
  assert.equal(trendStillFavourable(rising, false, 50), false);
  assert.equal(trendStillFavourable(falling, false, 50), true);
  assert.equal(trendStillFavourable(flat, true, 50), false, "a flat market is not a trend");
  assert.equal(trendStillFavourable(rising.slice(0, 40), true, 50), false, "too little history cannot confirm a trend");
});

// ── Replay ───────────────────────────────────────────────────────────────────

test("the replay arms and fills on a trending series, and records costs", () => {
  const bars = walk(6000, 0.0001, 11);
  const result = runBacktest(bars, baseConfig);
  assert.equal(result.counts.errors, 0, result.firstError ?? "");
  assert.ok(result.counts.armed > 0, "a clear trend arms plans");
  assert.ok(result.trades.length > 0, "armed plans fill");
  for (const trade of result.trades) {
    assert.ok(trade.closeTime >= trade.openTime, "a trade cannot close before it opens");
    assert.ok(Number.isFinite(trade.rMultiple));
  }
});

test("costs are charged: the same series is worth less net of spread and commission", () => {
  const bars = walk(6000, 0.0001, 11);
  const free = runBacktest(bars, { ...baseConfig, spreadPoints: 0, slippagePoints: 0, commissionPerLot: 0 });
  const costly = runBacktest(bars, { ...baseConfig, spreadPoints: 25, slippagePoints: 5, commissionPerLot: 6 });
  assert.ok(free.trades.length > 0 && costly.trades.length > 0);
  const sum = (rs: number[]) => rs.reduce((a, b) => a + b, 0);
  const perTradeFree = sum(free.trades.map((t) => t.rMultiple)) / free.trades.length;
  const perTradeCosty = sum(costly.trades.map((t) => t.rMultiple)) / costly.trades.length;
  assert.ok(perTradeCosty < perTradeFree, `costs must lower the average R (${perTradeCosty} vs ${perTradeFree})`);
});

test("every bar handed to the desk had closed by the decision time", () => {
  // Checked on the inputs themselves: a leak of a forming bar into the desk's view
  // would fail here even if it happened not to change any decision.
  const spans = new Map<string, number>(TIMEFRAME_MINUTES.map(([tf, minutes]) => [tf, minutes * MIN]));
  let checked = 0;
  const result = runBacktest(walk(3000, 0.0001, 5), {
    ...baseConfig,
    onDecisionInput: (at, series) => {
      for (const [tf, bars] of Object.entries(series)) {
        for (const bar of bars ?? []) {
          checked++;
          assert.ok(bar[0] + (spans.get(tf) as number) <= at,
            `${tf} bar starting ${new Date(bar[0]).toISOString()} is not closed at ${new Date(at).toISOString()}`);
        }
      }
    },
  });
  assert.equal(result.counts.errors, 0);
  assert.ok(checked > 0, "the check ran on real inputs");
});

test("NO LOOK-AHEAD: changing every bar after a cut-off cannot change anything decided before it", () => {
  const cut = 4000;
  const history = walk(6000, 0.0001, 11);
  const cutTime = history[cut]![0];

  // The same history up to the cut, then a completely different future.
  const future = walk(6000 - cut - 1, -0.0004, 99, history[cut]![4]);
  const rewritten = [...history.slice(0, cut + 1), ...future.map((b, i) => [cutTime + (i + 1) * MIN, ...b.slice(1)] as Bar)];

  const original = runBacktest(history, baseConfig);
  const altered = runBacktest(rewritten, baseConfig);

  const before = (decisions: typeof original.decisions) => decisions.filter((d) => d.t <= cutTime + MIN);
  assert.deepEqual(before(altered.decisions), before(original.decisions),
    "every decision made at or before the cut-off is identical");

  // planId is a random UUID minted by the agent, so it is excluded from the comparison.
  const closedBefore = (trades: typeof original.trades) =>
    trades.filter((t) => t.closeTime <= cutTime).map(({ planId: _id, ...rest }) => rest);
  assert.deepEqual(closedBefore(altered.trades), closedBefore(original.trades),
    "every trade that closed before the cut-off is identical");
  assert.ok(closedBefore(original.trades).length > 0, "the check covers real trades, not an empty set");
});

test("the command-line runner replays a CSV and writes the full result", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nt-backtest-"));
  const csvPath = path.join(dir, "EURUSD_M1.csv");
  const specPath = path.join(dir, "spec.json");
  const outPath = path.join(dir, "result.json");
  const rows = walk(3000, 0.0001, 21).map((b) => `${new Date(b[0]).toISOString()},${b[1]},${b[2]},${b[3]},${b[4]},${b[5]}`);
  writeFileSync(csvPath, ["time,open,high,low,close,volume", ...rows].join("\n"));
  writeFileSync(specPath, JSON.stringify(spec));

  const printed: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
  try {
    runCli(["--csv", csvPath, "--spec", specPath, "--mode", "intraday", "--every", "15", "--out", outPath]);
  } finally {
    console.log = original;
  }
  const report = printed.join("\n");
  assert.match(report, /Backtest EURUSD · intraday/);
  assert.match(report, /expectancy/);
  const written = JSON.parse(readFileSync(outPath, "utf8")) as { metrics: { trades: number }; counts: { errors: number } };
  assert.equal(written.counts.errors, 0);
  assert.ok("metrics" in written);
});

test("the command-line runner refuses a run without its inputs", () => {
  assert.throws(() => runCli(["--mode", "scalp"]), /Both --csv and --spec are required/);
  assert.throws(() => runCli(["--csv", "x.csv", "--spec", "s.json", "--mode", "hodl"]), /--mode must be one of/);
});

