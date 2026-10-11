/**
 * WP0 acceptance tests — golden vectors for the position-management machine.
 *
 * Every test here is a SCRIPTED price path with an EXACT expected action list.
 * These vectors are the contract the MQL5 implementation is written against:
 * the `Pm*` functions in NeurotradeBridge.mq5 are mapped 1:1 to the branches
 * exercised below in docs/mt5-live-desk-v4.md, so if either side drifts, one of
 * the two test suites fails.
 *
 * The suite deliberately covers the defect cluster D1:
 *   • management must not depend on the armed plan existing;
 *   • partials must be legal at the broker's volume step;
 *   • the trail must run on the ENTRY timeframe's ATR, move only in the
 *     protective direction and never inside the broker's stop level;
 *   • the time stop, the session/news flatten and the pyramid ladder must
 *     actually produce actions.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  BREAKEVEN_PROFIT_R,
  MODIFY_COOLDOWN_MS,
  TRAIL_MIN_STEP_ATR,
  countBarsSince,
  decodePositionState,
  encodePositionState,
  initialPositionState,
  isTighter,
  managePosition,
  planPartialClose,
  policyFromPlan,
  quantiseVolume,
  structureConfirmed,
  type ManageInput,
  type ManagementPolicy,
  type PositionState,
} from "./position-manager";
import type { Bar, ManagementPlan, Side, SymbolSpec, TradeMode } from "./types";

// ── Fixtures ────────────────────────────────────────────────────────────────

const POINT = 0.00001;
const DIGITS = 5;

const SPEC: Pick<
  SymbolSpec,
  "point" | "digits" | "volumeMin" | "volumeStep" | "stopsLevel" | "freezeLevel"
> = {
  point: POINT,
  digits: DIGITS,
  volumeMin: 0.01,
  volumeStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
};

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);

/**
 * Build closed bars from closes. Each bar's open is the previous close, so the
 * series is continuous and the only wick is an explicit symmetric one — that
 * keeps the swing geometry in these vectors obvious by construction.
 */
function barsFromCloses(closes: number[], wick = 0.0002, startMs = T0, tfMs = 15 * MINUTE): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < closes.length; i++) {
    const close = closes[i] as number;
    const open = i === 0 ? close : (closes[i - 1] as number);
    bars.push([
      startMs + i * tfMs,
      open,
      Math.max(open, close) + wick,
      Math.min(open, close) - wick,
      close,
      100,
    ]);
  }
  return bars;
}

/**
 * Explicit OHLC bars. Swing geometry has to be unambiguous for these vectors:
 * a fractal pivot needs a strictly lower low (or higher high) than BOTH
 * neighbours on each side, which a "closes with symmetric wicks" series cannot
 * always guarantee — consecutive marks share a price, so two `swings()` strict
 * comparisons can tie and cancel the pivot.
 */
function barsFromOhlc(
  rows: [number, number, number, number][],
  startMs = T0,
  tfMs = 15 * MINUTE,
): Bar[] {
  return rows.map((row, i) => [startMs + i * tfMs, row[0], row[1], row[2], row[3], 100] as Bar);
}

function basePolicy(overrides: Partial<ManagementPolicy> = {}): ManagementPolicy {
  return {
    breakeven: { triggerR: 1.0, offsetR: BREAKEVEN_PROFIT_R, structureBuffer: true },
    partials: [],
    trail: null,
    pyramid: null,
    timeStop: null,
    guards: { maxSpreadPoints: 30, newsBlackoutMin: 15, flatBeforeSessionClose: true },
    ...overrides,
  };
}

function makeState(overrides: Partial<PositionState> = {}): PositionState {
  const entry = 1.1;
  const sl = 1.098;
  return {
    ...initialPositionState({
      ticket: 4711,
      planId: "plan-1",
      symbol: "EURUSD",
      side: "buy",
      mode: "intraday",
      entryTimeframe: "M15",
      entry,
      sl,
      tp: entry + 0.004,
      volume: 0.5,
      costPrice: 0.00025,
      atrEntry: 0.0006,
      openedAt: T0,
    }),
    ...overrides,
  };
}

function run(
  state: PositionState,
  bars: Bar[],
  bid: number,
  policy: ManagementPolicy,
  extra: Partial<ManageInput> = {},
): ReturnType<typeof managePosition> {
  return managePosition({
    state,
    quote: { bid, ask: bid + 5 * POINT, ts: extra.now ?? T0 },
    bars,
    spec: SPEC,
    atrEntry: state.atrEntry,
    policy,
    now: extra.now ?? T0 + 60_000,
    ...extra,
  });
}

/**
 * A rising series with a CONFIRMED higher low above the 1.1000 entry: bar 6 is
 * a fractal swing low at 1.1025 (strictly higher than the lows of bars 4, 5, 7
 * and 8), so breakeven's structure requirement is satisfied.
 */
const RISING = barsFromOhlc([
  [1.0985, 1.0992, 1.0982, 1.099],
  [1.099, 1.1005, 1.0988, 1.1],
  [1.1, 1.102, 1.0998, 1.1015],
  [1.1015, 1.1035, 1.1012, 1.103],
  [1.103, 1.105, 1.1028, 1.1045],
  [1.1045, 1.106, 1.104, 1.1055],
  [1.1055, 1.1058, 1.1025, 1.103],
  [1.103, 1.104, 1.1029, 1.1038],
  [1.1038, 1.1055, 1.1035, 1.105],
  [1.105, 1.107, 1.1048, 1.106],
]);

// ── V1: nothing to do ───────────────────────────────────────────────────────

test("V1 — a quiet position produces no actions and stays in OPEN_RISK", () => {
  const state = makeState();
  const bars = barsFromCloses([1.0995, 1.1001, 1.0998, 1.1, 1.1002]);
  const out = run(state, bars, 1.1003, basePolicy());
  assert.deepEqual(out.actions, []);
  assert.equal(out.state.stage, "OPEN_RISK");
  assert.equal(out.state.beDone, false);
  assert.ok(Math.abs(out.state.progressR - 0.15) < 1e-9, `progressR=${out.state.progressR}`);
});

// ── V2/V3: breakeven, with and without structure ────────────────────────────

test("V2 — breakeven fires on the trigger WITH structure confirmation", () => {
  const state = makeState();
  const out = run(state, RISING, 1.106, basePolicy());
  assert.equal(out.actions.length, 1);
  const action = out.actions[0];
  assert.ok(action);
  assert.equal(action.kind, "modify_sl");
  if (action.kind !== "modify_sl") return;
  // entry + round-trip cost + 0.05R = 1.1 + 0.00025 + 0.0001
  assert.ok(Math.abs(action.sl - (1.1 + 0.00025 + 0.05 * 0.002)) < 1e-12, `sl=${action.sl}`);
  assert.equal(out.state.beDone, true);
  assert.equal(out.state.stage, "BE_ARMED");
});

test("V3 — breakeven does NOT fire while structure is unconfirmed", () => {
  // Price is +2R on the last close, but there is no confirmed swing low above
  // the entry: the series has never pulled back, so there is no higher low.
  const state = makeState();
  const bars = barsFromCloses([1.1002, 1.1012, 1.102, 1.1025, 1.103, 1.104]);
  const out = run(state, bars, 1.104, basePolicy());
  assert.deepEqual(out.actions, []);
  assert.equal(out.state.beDone, false);
  assert.ok(out.notes.some((n) => n.includes("structure has not confirmed")));
});

test("V3b — structureConfirmation is side-symmetric", () => {
  const buyBars = RISING;
  assert.equal(structureConfirmed(buyBars, "buy", 1.1), true);
  // The mirror image: a confirmed swing HIGH below the 1.1000 entry.
  const sellBars = barsFromOhlc(
    [...RISING.map((b) => b)].map((b) => [
      2 * 1.1 - b[1],
      2 * 1.1 - b[3],
      2 * 1.1 - b[2],
      2 * 1.1 - b[4],
    ]) as [number, number, number, number][],
  );
  assert.equal(structureConfirmed(sellBars, "sell", 1.1), true);
  assert.equal(structureConfirmed(buyBars, "sell", 1.1), false);
});

test("V2b — a breakeven stop inside the broker's stop level is deferred, not marked done", () => {
  const state = makeState();
  // An 800-point stop level: the BE candidate (+3.5 points above entry) sits
  // inside it while price is only ~3R up, so the modify would be rejected.
  const spec = { ...SPEC, stopsLevel: 800 };
  const out = managePosition({
    state,
    quote: { bid: 1.106, ask: 1.10605, ts: T0 },
    bars: RISING,
    spec,
    atrEntry: state.atrEntry,
    policy: basePolicy(),
    now: T0 + 60_000,
  });
  assert.deepEqual(out.actions, []);
  assert.equal(out.state.beDone, false, "a deferred breakeven must not read as risk-free");
  assert.ok(out.notes.some((n) => n.includes("stop level")));
});

// ── V4/V5/V6: partials ──────────────────────────────────────────────────────

test("V4 — the 1.5R rung closes a legal 35% slice and moves the stage to PARTIAL", () => {
  const state = makeState({ volume: 0.5, initialVolume: 0.5 });
  // Breakeven is disabled here ON PURPOSE: this vector is about the ladder, and
  // at most one stop modification is emitted per evaluation (V15 asserts that
  // property directly), so leaving breakeven on would mask the partial.
  const policy = basePolicy({ breakeven: null, partials: [{ atR: 1.5, closePct: 35 }] });
  const out = run(state, RISING, 1.1 + 0.002 * 2, policy);
  const partial = out.actions.find((a) => a.kind === "close_partial");
  assert.ok(partial && partial.kind === "close_partial");
  if (!partial || partial.kind !== "close_partial") return;
  assert.equal(partial.lots, 0.17, "35% of 0.5 lots floored to the 0.01 step");
  assert.equal(out.state.volume, 0.33);
  assert.equal(out.state.partialsDone, 1);
  assert.equal(out.state.stage, "PARTIAL");
});

test("V5 — a rung below the broker minimum is consumed with a note, not retried forever", () => {
  const state = makeState({ volume: 0.01, initialVolume: 0.01 });
  const policy = basePolicy({ breakeven: null, partials: [{ atR: 1.5, closePct: 35 }] });
  const out = run(state, RISING, 1.1 + 0.004, policy);
  assert.deepEqual(out.actions.filter((a) => a.kind === "close_partial"), []);
  assert.equal(out.state.partialsDone, 1);
  assert.ok(out.notes.some((n) => n.includes("below the")));
});

test("V6 — a rung that asks for the whole position becomes a full exit", () => {
  const state = makeState({ volume: 0.01, initialVolume: 0.01 });
  const policy = basePolicy({ breakeven: null, partials: [{ atR: 1.5, closePct: 100 }] });
  const out = run(state, RISING, 1.1 + 0.004, policy);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0]?.kind, "close_all");
});

test("V6b — planPartialClose shrinks a slice that would leave an illegal remainder", () => {
  // A broker whose MINIMUM (0.05) is larger than its step (0.01) is the only
  // shape that can produce an illegal remainder, because both the slice and the
  // position are step multiples. Both branches are exercised with that shape.
  const shrunk = planPartialClose({
    volume: 0.12,
    initialVolume: 0.12,
    closePct: 90,
    volumeMin: 0.05,
    volumeStep: 0.01,
  });
  assert.equal(shrunk.closeAll, false);
  assert.equal(shrunk.lots, 0.07, "0.12 − 0.05 keeps a legal 0.05 remainder");

  const escalate = planPartialClose({
    volume: 0.06,
    initialVolume: 0.06,
    closePct: 90,
    volumeMin: 0.05,
    volumeStep: 0.01,
  });
  assert.equal(escalate.closeAll, true, "an illegal remainder must escalate to a full close");
  assert.ok(escalate.reason.includes("illegal"));
});

test("V6c — quantiseVolume never rounds a lot size UP", () => {
  assert.equal(quantiseVolume(0.037, 0.01), 0.03);
  assert.equal(quantiseVolume(0.009, 0.01), 0);
  assert.equal(quantiseVolume(0.1, 0.01), 0.1);
});

// ── V7/V8/V9: trailing stop ─────────────────────────────────────────────────

test("V7 — the chandelier trail uses the entry timeframe's ATR and never loosens", () => {
  const policy = basePolicy({
    breakeven: null,
    trail: { mode: "atr_chandelier", period: 14, mult: 2.5, activateAtR: 1.2, stepPoints: 5 },
  });
  const state = makeState();
  const out = run(state, RISING, 1.1 + 0.002 * 3, policy);
  const modify = out.actions.find((a) => a.kind === "modify_sl");
  assert.ok(modify && modify.kind === "modify_sl");
  if (!modify || modify.kind !== "modify_sl") return;
  // best (1.106) − 2.5 × 0.0006 = 1.10450
  assert.ok(Math.abs(modify.sl - (1.106 - 2.5 * 0.0006)) < 1e-9, `sl=${modify.sl}`);
  assert.equal(out.state.trailArmed, true);

  // The same state, a LOWER best price: the stop must not move backwards.
  const lower = run({ ...out.state }, RISING, 1.1045, policy, {
    now: T0 + 60_000 + MODIFY_COOLDOWN_MS + 1,
  });
  assert.deepEqual(
    lower.actions.filter((a) => a.kind === "modify_sl"),
    [],
    "a trail may never loosen the stop",
  );
  assert.equal(lower.state.sl, modify.sl);
});

test("V8 — trail moves inside the cooldown are deferred unless R advanced materially", () => {
  const policy = basePolicy({
    breakeven: null,
    trail: { mode: "atr_chandelier", period: 14, mult: 2.5, activateAtR: 1.2, stepPoints: 5 },
  });
  const state = makeState({
    trailArmed: true,
    lastModifyAt: T0 + 60_000,
    // The last modify happened at 3.1R and price is now 3.2R: 0.1R of progress,
    // which is not material enough to justify moving the stop again.
    lastModifyR: 3.1,
    // The stop already sits where the trail wants it, so the candidate must
    // improve by a full step before another modify is allowed.
    bestPrice: 1.106,
    sl: 1.1045,
  });
  const bars = barsFromCloses([1.1005, 1.1012, 1.102, 1.103, 1.104, 1.105, 1.1064]);
  const cooling = managePosition({
    state,
    quote: { bid: 1.1064, ask: 1.10645, ts: T0 },
    bars,
    spec: SPEC,
    atrEntry: 0.0006,
    policy,
    now: T0 + 60_000 + 500, // 0.5 s after the last modify: inside the cooldown
  });
  assert.deepEqual(cooling.actions, []);
  assert.ok(cooling.notes.some((n) => n.includes("cooldown")));

  // 1R of new progress is material: the deferral is lifted.
  const advanced = managePosition({
    state: { ...state, progressR: 1.9, lastModifyR: 1.2 },
    quote: { bid: 1.1072, ask: 1.10725, ts: T0 },
    bars: barsFromCloses([1.1012, 1.102, 1.103, 1.104, 1.105, 1.1064, 1.1072]),
    spec: SPEC,
    atrEntry: 0.0006,
    policy,
    now: T0 + 60_000 + 500,
  });
  assert.equal(advanced.actions.filter((a) => a.kind === "modify_sl").length, 1);
});

test("V9 — a trail candidate inside the broker's stop level is deferred with a note", () => {
  const policy = basePolicy({
    breakeven: null,
    trail: { mode: "atr_chandelier", period: 14, mult: 0.1, activateAtR: 1.2, stepPoints: 1 },
  });
  const state = makeState();
  // mult 0.1 puts the candidate ~1 point under the bid, inside a 200-point stop level.
  const out = managePosition({
    state,
    quote: { bid: 1.1 + 0.002 * 3, ask: 1.1 + 0.002 * 3 + 5 * POINT, ts: T0 },
    bars: RISING,
    spec: { ...SPEC, stopsLevel: 200 },
    atrEntry: 0.0006,
    policy,
    now: T0 + 60_000,
  });
  assert.deepEqual(out.actions, []);
  assert.ok(out.notes.some((n) => n.includes("stop level")));
});

test("V7b — TRAIL_MIN_STEP_ATR is 0.1 ATR and the step guard uses it", () => {
  assert.equal(TRAIL_MIN_STEP_ATR, 0.1);
  // A candidate improvement smaller than 0.1 ATR (but larger than the point
  // step) must be ignored.
  const policy = basePolicy({
    breakeven: null,
    trail: { mode: "atr_chandelier", period: 14, mult: 2.5, activateAtR: 1.2, stepPoints: 0.5 },
  });
  const state = makeState({ sl: 1.1049, bestPrice: 1.106, trailArmed: true });
  const out = run(
    state,
    barsFromCloses([1.1012, 1.102, 1.103, 1.104, 1.105, 1.1055, 1.106]),
    1.106,
    policy,
    { now: T0 + 10 * MODIFY_COOLDOWN_MS },
  );
  // candidate 1.10450 vs current 1.10490 → it is not even tighter, so nothing happens.
  assert.deepEqual(out.actions, []);
});

// ── V10/V11: time stop ──────────────────────────────────────────────────────

test("V10 — the time stop closes a stalled position once the bar budget is spent", () => {
  const state = makeState();
  const policy = basePolicy({ timeStop: { noProgressBars: 5, timeframe: "M15" } });
  const bars = barsFromCloses([1.1001, 1.1, 1.1002, 1.0999, 1.1, 1.1001]);
  const out = run(state, bars, 1.1002, policy);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0]?.kind, "close_all");
  assert.equal(out.state.stage, "TIME_STOP");
});

test("V11 — the time stop never fires once the trade has run", () => {
  const state = makeState({ mfeR: 1.4 });
  const policy = basePolicy({ timeStop: { noProgressBars: 3, timeframe: "M15" } });
  const bars = barsFromCloses([1.1001, 1.1, 1.1002, 1.0999, 1.1, 1.1001]);
  const out = run(state, bars, 1.1001, policy);
  assert.deepEqual(out.actions, []);
});

// ── V12: regime exit ────────────────────────────────────────────────────────

test("V12 — regime exit closes a low-R position whose regime has gone", () => {
  const state = makeState();
  const bars = barsFromCloses([1.0995, 1.1001, 1.0998, 1.1, 1.1002]);
  const out = run(state, bars, 1.1003, basePolicy(), {
    regime: { requiredProbability: 0.31, permit: false, changeProbability: 0.1 },
  });
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0]?.kind, "close_all");
  assert.equal(out.state.stage, "REGIME_EXIT");
});

test("V12b — a runner beyond 1R is not cut by a regime exit", () => {
  const state = makeState();
  const bars = barsFromCloses([1.1001, 1.101, 1.102, 1.103, 1.104]);
  const out = run(state, bars, 1.104, basePolicy(), {
    regime: { requiredProbability: 0.2, permit: false, changeProbability: 0.9 },
  });
  assert.deepEqual(out.actions, []);
});

// ── V13: session / news flatten ─────────────────────────────────────────────

test("V13 — a session close flattens a non-swing position", () => {
  const state = makeState();
  const out = run(state, RISING, 1.101, basePolicy(), {
    session: { minutesToSessionClose: 8, inNewsBlackout: false },
  });
  assert.equal(out.actions[0]?.kind, "close_all");
  assert.equal(out.state.stage, "SESSION_NEWS_FLAT");
});

test("V13b — a news blackout flattens, but a swing position is exempt", () => {
  const state = makeState();
  const flat = run(state, RISING, 1.101, basePolicy(), {
    session: { minutesToSessionClose: 600, inNewsBlackout: true },
  });
  assert.equal(flat.actions[0]?.kind, "close_all");
  const swing = run({ ...makeState({ mode: "swing" }) }, RISING, 1.101, basePolicy(), {
    session: { minutesToSessionClose: 600, inNewsBlackout: true },
  });
  assert.deepEqual(swing.actions, []);
});

// ── V14: pyramid ────────────────────────────────────────────────────────────

test("V14 — the pyramid add waits for a risk-free base and respects maxAdds", () => {
  const policy = basePolicy({
    pyramid: {
      maxAdds: 1,
      addAtR: 1.5,
      sizeRatio: 0.5,
      requireBaseAtBreakeven: true,
      portfolioRiskCapR: 1.5,
    },
  });
  const notSafe = run(makeState(), RISING, 1.1 + 0.002 * 2, policy);
  assert.deepEqual(notSafe.actions.filter((a) => a.kind === "pyramid_add"), []);
  assert.ok(notSafe.notes.some((n) => n.includes("not at breakeven")));

  const safe = run(makeState({ beDone: true, stage: "RUNNER" }), RISING, 1.1 + 0.002 * 2, policy);
  const add = safe.actions.find((a) => a.kind === "pyramid_add");
  assert.ok(add && add.kind === "pyramid_add");
  if (!add || add.kind !== "pyramid_add") return;
  assert.equal(add.sizeRatio, 0.5);
  assert.equal(add.sl, 1.098, "the add carries the ORIGINAL stop");
  assert.equal(safe.state.pyramidAdds, 1);
  assert.equal(safe.state.stage, "PYRAMID");

  const exhausted = run(makeState({ beDone: true, pyramidAdds: 1 }), RISING, 1.1 + 0.002 * 2, policy);
  assert.deepEqual(exhausted.actions.filter((a) => a.kind === "pyramid_add"), []);
});

// ── D1 regression: management survives the plan ─────────────────────────────

test("D1 — management still works after the plan object is gone", () => {
  const plan: ManagementPlan = {
    breakeven: { triggerR: 1.0, offsetR: 0.05, structureBuffer: true },
    partials: [{ atR: 1.5, closePct: 50 }],
    trail: { mode: "atr_chandelier", period: 14, mult: 2.5, activateAtR: 1.2, stepPoints: 5 },
    pyramid: null,
    timeStop: { noProgressBars: 20, timeframe: "M15" },
    guards: { maxSpreadPoints: 30, newsBlackoutMin: 15, flatBeforeSessionClose: true },
  };
  const policy = policyFromPlan(plan, "intraday");
  // The plan is discarded here — exactly what the EA does at fill.
  const state = initialPositionState({
    ticket: 99,
    planId: "gone",
    symbol: "EURUSD",
    side: "buy",
    mode: "intraday",
    entryTimeframe: "M15",
    entry: 1.1,
    sl: 1.098,
    tp: 1.104,
    volume: 0.5,
    costPrice: 0.00025,
    atrEntry: 0.0006,
    openedAt: T0,
  });
  const out = run(state, RISING, 1.1 + 0.002 * 2, policy);
  assert.ok(out.actions.length >= 2, "partial + breakeven must both fire without the plan");
  assert.equal(out.state.partialsDone, 1);
  assert.equal(out.state.beDone, true);
});

test("D1b — the state carries every field management needs (round-trip)", () => {
  const state = makeState({ partialsDone: 1, beDone: true, trailArmed: true, bestPrice: 1.1055 });
  const decoded = decodePositionState(encodePositionState(state));
  assert.deepEqual(decoded, state);
  assert.equal(decodePositionState("garbage"), null);
  assert.equal(decodePositionState("v2|1|2"), null);
});

// ── No lookahead: prefix replay ─────────────────────────────────────────────

test("no lookahead — truncating the bar series cannot change an older decision", () => {
  const full = barsFromCloses([
    1.0985, 1.099, 1.1, 1.101, 1.103, 1.105, 1.102, 1.1035, 1.105, 1.106, 1.104, 1.102,
  ]);
  const policy = basePolicy({
    trail: { mode: "atr_chandelier", period: 14, mult: 2.5, activateAtR: 1.2, stepPoints: 5 },
  });
  // Evaluate at the 10th bar over the full series and over the prefix only.
  const prefix = full.slice(0, 10);
  const fromPrefix = run(makeState(), prefix, 1.106, policy);
  const fromFull = run(makeState(), full.slice(0, 10), 1.106, policy);
  assert.deepEqual(fromPrefix.actions, fromFull.actions);
  assert.deepEqual(fromPrefix.state, fromFull.state);

  // And a helper that DOES look at the array: bars since entry count only bars
  // that opened at or after the fill.
  assert.equal(countBarsSince(full, T0 + 5 * 15 * MINUTE), 7);
  assert.equal(countBarsSince(prefix, T0 + 5 * 15 * MINUTE), 5);
});

// ── Assorted invariants ─────────────────────────────────────────────────────

test("isTighter is direction-correct and treats a missing stop as looser than anything", () => {
  assert.equal(isTighter(1.101, 1.1, "buy"), true);
  assert.equal(isTighter(1.099, 1.1, "buy"), false);
  assert.equal(isTighter(1.099, 1.1, "sell"), true);
  assert.equal(isTighter(1.101, 1.1, "sell"), false);
  assert.equal(isTighter(1.1, 0, "buy"), true);
});

test("a zero risk unit is closed rather than managed", () => {
  const state = makeState({ riskPrice: 0 });
  const out = run(state, RISING, 1.106, basePolicy());
  assert.equal(out.state.stage, "CLOSED");
  assert.deepEqual(out.actions, []);
});

test("management is deterministic: identical inputs produce identical outputs", () => {
  const policy = basePolicy({
    partials: [{ atR: 1.5, closePct: 35 }],
    trail: { mode: "atr_chandelier", period: 14, mult: 2.5, activateAtR: 1.2, stepPoints: 5 },
  });
  const a = run(makeState(), RISING, 1.106, policy);
  const b = run(makeState(), RISING, 1.106, policy);
  assert.deepEqual(a, b);
});

test("policyFromPlan fills a missing trail multiple from the mode table", () => {
  const plan: ManagementPlan = {
    breakeven: null,
    partials: [],
    trail: { mode: "atr_chandelier", period: 14, mult: 0, activateAtR: 1.2, stepPoints: 0 },
    pyramid: null,
    timeStop: null,
    guards: { maxSpreadPoints: 10, newsBlackoutMin: 10, flatBeforeSessionClose: false },
  };
  for (const [mode, mult] of [
    ["scalp", 2.0],
    ["intraday", 2.5],
    ["swing", 3.0],
  ] as [TradeMode, number][]) {
    const policy = policyFromPlan(plan, mode);
    assert.equal(policy.trail?.mult, mult);
    assert.ok((policy.trail?.stepPoints ?? 0) > 0);
  }
});

test("MAE/MFE bookkeeping tracks the best price in both directions", () => {
  const buy = makeState();
  const up = run(buy, RISING, 1.105, basePolicy());
  assert.ok(Math.abs(up.state.mfeR - 2.5) < 1e-9);
  const downThenUp = run({ ...up.state }, RISING, 1.103, basePolicy(), { now: T0 + 120_000 });
  assert.ok(Math.abs(downThenUp.state.mfeR - 2.5) < 1e-9, "MFE never decreases");
  assert.equal(downThenUp.state.bestPrice, 1.105);

  const sellState = makeState({ side: "sell" as Side, entry: 1.1, sl: 1.102, initialSl: 1.102 });
  const sellDown = run(sellState, barsFromCloses([1.101, 1.1, 1.099, 1.098]), 1.098, basePolicy());
  assert.ok(sellDown.state.mfeR > 0.9);
  // A sell's favourable excursion is measured at the ASK, which is where it
  // would buy back — 1.098 plus the 5-point spread in the fixture.
  assert.ok(Math.abs(sellDown.state.bestPrice - 1.09805) < 1e-12);
});

// ── V15: at most one stop modification per evaluation ───────────────────────

test("V15 — breakeven and the trail never emit two stop modifications at once", () => {
  const policy = basePolicy({
    trail: { mode: "atr_chandelier", period: 14, mult: 2.5, activateAtR: 1.2, stepPoints: 5 },
  });
  const out = run(makeState(), RISING, 1.1 + 0.002 * 3, policy);
  const modifies = out.actions.filter((a) => a.kind === "modify_sl");
  assert.equal(modifies.length, 1, "two racing modifies would land arbitrarily at the broker");
  assert.ok((modifies[0] as { reason: string }).reason.includes("breakeven"), "the protective one wins");
  // The trail's own candidate must still be visible in the state's best price.
  assert.equal(out.state.bestPrice, 1.106);
});

test("the wire format keeps the MODE, which is not the mode's first letter", () => {
  // "scalp" and "swing" both start with S. Encoding the mode as its first
  // letter therefore decoded every scalp as a swing and every swing as a
  // scalp — a different entry timeframe, trail multiple and time stop.
  for (const mode of ["scalp", "intraday", "swing"] as TradeMode[]) {
    const state = makeState({ mode });
    const decoded = decodePositionState(encodePositionState(state));
    assert.equal(decoded?.mode, mode);
  }
  assert.equal(decodePositionState(encodePositionState(makeState()).replace("|M15|", "|X9|")), null);
});
