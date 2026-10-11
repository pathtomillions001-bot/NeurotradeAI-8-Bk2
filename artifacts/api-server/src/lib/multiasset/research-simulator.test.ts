/**
 * Desk v4 research harness — executed-policy simulator (WP2 tests).
 *
 * These pin the conventions the harness's numbers depend on. Every one of them
 * is a place where a plausible-looking implementation would flatter the
 * strategy: filling at the trigger instead of at the ask, letting a plan fill
 * after its invalidation, ignoring the spread guard, or reporting a partial
 * exit without weighting it against the volume it actually closed.
 *
 * Prices below are EURUSD: point 0.00001, digits 5, 8-point spread,
 * 1-point slippage, 7 USD/lot round-trip commission (1 point of 1.00 lot is
 * 1.00 USD, so commission is 7 points).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Bar, ManagementPlan, SymbolSpec } from "./types";
import { replayPlan, type ReplayablePlan } from "./research/simulator";
import { specFromPreset } from "./research/spec";
import type { Dataset } from "./research/types";

const POINT = 0.00001;
const START_TS = Date.UTC(2024, 0, 2, 0, 0);

/** Build M1 bars from [open, high, low, close] rows. */
function bars(rows: [number, number, number, number][]): Bar[] {
  return rows.map(([open, high, low, close], index) => [
    START_TS + index * 60_000,
    open,
    high,
    low,
    close,
    100,
  ]);
}

function datasetFrom(series: Bar[], spreadPoints = 8, spec?: SymbolSpec): Dataset {
  const resolved = spec ?? specFromPreset("EURUSD", spreadPoints);
  return {
    source: "unit-test",
    symbol: resolved.symbol,
    bars: series,
    spreadPointsAt: () => spreadPoints,
    spec: { ...resolved, spreadPoints },
    clock: { kind: "utc" },
    notes: [],
  };
}

function management(overrides: Partial<ManagementPlan> = {}): ManagementPlan {
  return {
    breakeven: null,
    partials: [],
    trail: null,
    pyramid: null,
    timeStop: null,
    guards: { maxSpreadPoints: 100, newsBlackoutMin: 15, flatBeforeSessionClose: false },
    ...overrides,
  };
}

/** A buy `break` plan with the given trigger/stop/target. */
function plan(overrides: Partial<ReplayablePlan> = {}): ReplayablePlan {
  return {
    id: "plan-1",
    symbol: "EURUSD",
    side: "buy",
    mode: "intraday",
    trigger: 1.1005,
    triggerType: "break",
    invalidate: 1.0985,
    sl: 1.0985,
    tp: 1.104,
    lots: 0.1,
    riskPoints: 200,
    expiresAt: START_TS + 60 * 60_000,
    maxSpreadPoints: 15,
    entryTimeframe: "M1",
    costPoints: 8,
    management: management(),
    ...overrides,
  };
}

test("a stop order fills at the ask, not at its trigger", () => {
  const data = datasetFrom(
    bars([
      [1.1, 1.1001, 1.0999, 1.1],
      [1.1, 1.1015, 1.09995, 1.1014],
      [1.1014, 1.105, 1.1012, 1.1048],
    ]),
  );
  const outcome = replayPlan(data, plan(), 0);

  assert.equal(outcome.filled, true);
  // max(open, trigger) + spread + slippage = 1.10050 + 0.00008 + 0.00001.
  assert.ok(Math.abs(outcome.fillPrice! - 1.10059) < 1e-12, `fill ${outcome.fillPrice}`);
  assert.equal(outcome.exitReason, "take_profit");
  assert.ok(Math.abs(outcome.exitPrice! - 1.104) < 1e-12);

  // R is measured from the fill, and the commission is charged on top.
  const gross = (1.104 - outcome.fillPrice!) / (outcome.fillPrice! - 1.0985);
  assert.ok(Math.abs(outcome.realisedR! - (gross - outcome.costR)) < 1e-9);
  // 7 USD/lot round-trip commission against a 209-point risk unit (1 point of
  // 1.00 lot is 1.00 USD on EURUSD at these prices).
  assert.ok(Math.abs(outcome.costR - 7 / 209) < 1e-9, `costR ${outcome.costR}`);
});

test("a stop-out realises about -1R, and the slippage makes it worse than -1", () => {
  const data = datasetFrom(
    bars([
      [1.1, 1.1001, 1.0999, 1.1],
      [1.1, 1.1015, 1.09995, 1.1014],
      [1.1014, 1.1016, 1.098, 1.0982],
    ]),
  );
  const outcome = replayPlan(data, plan(), 0);

  assert.equal(outcome.filled, true);
  assert.equal(outcome.exitReason, "stop_loss");
  // The stop is a market order: it is filled a slippage allowance beyond the level.
  assert.ok(Math.abs(outcome.exitPrice! - (1.0985 - POINT)) < 1e-12);
  assert.ok(outcome.realisedR! < -1, `should be worse than -1R, got ${outcome.realisedR}`);
  assert.ok(outcome.realisedR! > -1.1, `should not be catastrophic, got ${outcome.realisedR}`);
});

test("an invalidation in the same bar beats the trigger", () => {
  // The bar touches both the trigger AND the invalidation. Bars cannot resolve
  // intrabar order, so the simulator must not assume the favourable one.
  const data = datasetFrom(
    bars([
      [1.1, 1.1001, 1.0999, 1.1],
      [1.1, 1.1015, 1.0994, 1.1012],
    ]),
  );
  const outcome = replayPlan(data, plan({ invalidate: 1.0995 }), 0);
  assert.equal(outcome.filled, false);
  assert.equal(outcome.unfilledReason, "invalidated");
});

test("a plan that never triggers expires", () => {
  const data = datasetFrom(
    bars([
      [1.1, 1.1001, 1.0999, 1.1],
      [1.1, 1.1002, 1.0998, 1.1001],
      [1.1001, 1.1003, 1.0999, 1.1],
      [1.1, 1.1004, 1.0998, 1.1002],
    ]),
  );
  const outcome = replayPlan(data, plan({ expiresAt: START_TS + 2 * 60_000 }), 0);
  assert.equal(outcome.filled, false);
  assert.equal(outcome.unfilledReason, "expired");
});

test("the fill-time spread guard refuses a runaway quote", () => {
  const data = datasetFrom(
    bars([
      [1.1, 1.1001, 1.0999, 1.1],
      [1.1, 1.1015, 1.09995, 1.1014],
    ]),
    30,
  );
  const outcome = replayPlan(data, plan({ maxSpreadPoints: 15 }), 0);
  assert.equal(outcome.filled, false);
  assert.equal(outcome.unfilledReason, "spread_guard");
});

test("partials are weighted by the volume they close, not by their own R", () => {
  const data = datasetFrom(
    bars([
      [1.1, 1.1001, 1.0999, 1.1],
      [1.1, 1.1015, 1.09995, 1.1014],
      // 1R is 1.10268; this bar's high clears it and the machine banks half.
      [1.1014, 1.103, 1.1013, 1.1029],
      [1.1029, 1.106, 1.1027, 1.1055],
    ]),
  );
  const outcome = replayPlan(
    data,
    plan({ management: management({ partials: [{ atR: 1, closePct: 50 }] }) }),
    0,
  );

  assert.equal(outcome.filled, true);
  assert.equal(outcome.exitReason, "take_profit");
  const partial = outcome.actions.find((action) => action.type === "close_partial");
  assert.ok(partial, "the partial must have been emitted");

  const risk = outcome.fillPrice! - 1.0985;
  const partialR = (1.103 - outcome.fillPrice!) / risk; // acted on the bar's high
  const remainderR = (1.104 - outcome.fillPrice!) / risk;
  const expectedGross = 0.5 * partialR + 0.5 * remainderR;
  assert.ok(Math.abs(outcome.bankedR - 0.5 * partialR) < 1e-9, `banked ${outcome.bankedR}`);
  assert.ok(Math.abs(outcome.realisedR! - (expectedGross - outcome.costR)) < 1e-9);
});

test("break-even runs from the machine and scratch-trades the position", () => {
  // WP0's whole point: the management plan must survive the fill. A long that
  // reaches 1R and comes back must exit at break-even (entry + cost + buffer),
  // NOT at the original stop.
  const data = datasetFrom(
    bars([
      [1.1, 1.1001, 1.0999, 1.1],
      [1.1, 1.1015, 1.09995, 1.1014],
      [1.1014, 1.1035, 1.1013, 1.1032],
      // Pulls back through the raised stop: 1R was cleared at 1.1035, so the
      // stop sits at entry + cost + 0.05R ≈ 1.10077.
      [1.1032, 1.1034, 1.1003, 1.1006],
    ]),
  );
  const outcome = replayPlan(
    data,
    plan({
      management: management({
        breakeven: { triggerR: 1, offsetR: 0.05, structureBuffer: false },
      }),
    }),
    0,
  );

  const modify = outcome.actions.find((action) => action.type === "modify_sl");
  assert.ok(modify, "break-even must emit a stop modification");
  assert.equal(outcome.exitReason, "break_even");
  // The risk unit frozen at fill is 209 points, so break-even is
  // entry + 8pt cost + 0.05 x 209pt buffer, and a stop is a market order that
  // pays one slippage allowance on the way out.
  // The raised stop is rounded to the symbol's price granularity before it is
  // sent, which is what the broker would receive.
  const rawStop = outcome.fillPrice! + (8 + 0.05 * 209) * POINT;
  const sentStop = Number(rawStop.toFixed(5));
  assert.ok(
    Math.abs(outcome.exitPrice! - (sentStop - POINT)) < 1e-9,
    `exit ${outcome.exitPrice} vs ${sentStop - POINT}`,
  );
  assert.ok(outcome.realisedR! > -0.2, `a break-even exit is a scratch, got ${outcome.realisedR}`);
});

test("a stop never loosens, whatever the path does", () => {
  // The trail needs a real ATR, so this path runs long enough for the entry
  // frame to have 20 closed bars, and the target is placed far away so the
  // test measures the trail rather than an early take-profit.
  const rows: [number, number, number, number][] = [
    [1.1, 1.1001, 1.0999, 1.1],
    [1.1, 1.1015, 1.09995, 1.1014],
  ];
  for (let k = 2; k <= 40; k++) {
    const high = 1.101 + k * 0.0004;
    rows.push([high - 0.0002, high, high - 0.0006, high - 0.0002]);
  }
  // Then a hard pullback that must be stopped out by a raised stop, not by the
  // original one.
  rows.push([1.1166, 1.1168, 1.112, 1.1122]);
  const data = datasetFrom(bars(rows));

  const outcome = replayPlan(
    data,
    plan({
      tp: 1.15,
      management: management({
        breakeven: { triggerR: 1, offsetR: 0.05, structureBuffer: false },
        trail: { mode: "atr_chandelier", period: 14, mult: 2, activateAtR: 1, stepPoints: 1 },
      }),
    }),
    0,
  );

  const stops = outcome.actions
    .filter((action) => action.type === "modify_sl")
    .map((action) => Number(action.detail.match(/Stop → ([\d.]+)/)?.[1] ?? Number.NaN));
  assert.ok(stops.length >= 1, "at least one stop modification expected");
  assert.ok(stops.every((stop) => Number.isFinite(stop)), "every modification names its level");
  for (let i = 1; i < stops.length; i++) {
    assert.ok(stops[i]! >= stops[i - 1]!, `stop loosened: ${stops[i - 1]} → ${stops[i]}`);
  }
  for (const stop of stops) {
    assert.ok(stop > outcome.fillPrice!, `stop ${stop} must stay above entry for a long`);
  }
  assert.equal(outcome.exitReason, "trail");
  assert.ok(outcome.realisedR! > 0, `a trailed stop should bank something, got ${outcome.realisedR}`);
});

test("the time stop closes a trade that has not worked", () => {
  const rows: [number, number, number, number][] = [[1.1, 1.1001, 1.0999, 1.1], [1.1, 1.1015, 1.09995, 1.1014]];
  // Drift sideways well above the stop and well below the target.
  for (let i = 0; i < 12; i++) rows.push([1.1014, 1.1016, 1.1008, 1.1013]);
  const data = datasetFrom(bars(rows));
  const outcome = replayPlan(
    data,
    plan({
      management: management({ timeStop: { noProgressBars: 5, timeframe: "M1" } }),
    }),
    0,
  );

  assert.equal(outcome.filled, true);
  assert.equal(outcome.exitReason, "time_stop");
  assert.ok(outcome.realisedR! < 0.5, "a time-stopped trade made no progress");
});

test("the same inputs always produce the same replay", () => {
  const data = datasetFrom(
    bars([
      [1.1, 1.1001, 1.0999, 1.1],
      [1.1, 1.1015, 1.09995, 1.1014],
      [1.1014, 1.103, 1.1013, 1.1029],
      [1.1029, 1.106, 1.1027, 1.1055],
    ]),
  );
  const options = {
    management: management({
      partials: [{ atR: 1, closePct: 50 }],
      breakeven: { triggerR: 1.2, offsetR: 0.05, structureBuffer: false },
    }),
  };
  const first = replayPlan(data, plan(options), 0);
  const second = replayPlan(data, plan(options), 0);
  assert.deepEqual(first, second);
});

test("a sell plan mirrors the conventions: fills on the bid, exits on the ask", () => {
  const data = datasetFrom(
    bars([
      [1.1, 1.1001, 1.0999, 1.1],
      [1.1, 1.1001, 1.0985, 1.0988],
      [1.0988, 1.1, 1.095, 1.0954],
    ]),
  );
  const outcome = replayPlan(
    data,
    // A sell is invalidated by price rising, so its invalidation sits ABOVE the
    // market — the default (below) would cancel it on the first tick.
    plan({ side: "sell", trigger: 1.0995, sl: 1.1015, tp: 1.0955, invalidate: 1.1025 }),
    0,
  );
  assert.equal(outcome.filled, true);
  // A sell receives the bid: min(open, trigger) − slippage.
  assert.ok(Math.abs(outcome.fillPrice! - (1.0995 - POINT)) < 1e-12, `fill ${outcome.fillPrice}`);
  assert.equal(outcome.exitReason, "take_profit");
});
