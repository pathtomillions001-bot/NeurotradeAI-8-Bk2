/**
 * WP7 — the execution and timing agent: unit tests, then wiring tests.
 *
 * The unit half pins the arithmetic of the four layers (spread z, minute-of-week
 * timing, the slippage ledger, the resting entry). The wiring half proves the
 * composition in `evaluate()`:
 *
 *   - with the flag at its shipped default the agent decides NOTHING (absent,
 *     not merely agreeable) and the plan is byte-for-byte the legacy one;
 *   - with the flag on and no measurements the layer has no opinion and still
 *     cannot change the plan;
 *   - with a measurement in hand it refuses by name, and the refusal is a
 *     sentence a human can act on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PENDING_CANCEL_R,
  PENDING_EXPIRY_BARS,
  SLIPPAGE_MEASUREMENT_MIN_SAMPLES,
  SLIPPAGE_PAUSE_R,
  SPREAD_Z_LIMIT,
  SPREAD_Z_MIN_SAMPLES,
  createSlippageLedger,
  createSpreadHistory,
  createTimingLedger,
  executionDecision,
  executionRejections,
  measuredSlippageR,
  minuteOfWeek,
  pendingEntryPlan,
  recordSlippage,
  recordSpread,
  recordTimingOutcome,
  signedSlippageR,
  slippagePause,
  spreadHistoryFor,
  spreadZ,
  timingPermit,
} from "./execution";
import { evaluate, getSlippageLedger, resetExecutionLedgersForTests } from "./agent";
import { DESK_V4_DEFAULTS, setDeskV4ForTests, type DeskV4Config } from "./desk-v4-config";
import { createRiskState } from "./risk";
import { makeRng } from "./math";
import { TIMEFRAMES, type AccountSnapshot, type Bar, type Quote, type SymbolSpec, type Timeframe } from "./types";

/** The clean uptrend the other multiasset tests arm on. */
function trendUp(count: number, start = 1.08, drift = 0.0006, noise = 0.0002, seed = 1): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    price = open * Math.exp(drift + (rng() - 0.5) * noise);
    const high = Math.max(open, price) * (1 + rng() * noise * 0.5);
    const low = Math.min(open, price) * (1 - rng() * noise * 0.5);
    bars.push([i * 60_000, open, high, low, price, 100]);
  }
  return bars;
}

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
  spreadPoints: 8,
  baseCurrency: "EUR",
  quoteCurrency: "USD",
};

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

function run(overrides: { bars?: number; spreadPoints?: number; spreadHistory?: number[] } = {}) {
  const series: Partial<Record<Timeframe, Bar[]>> = {};
  TIMEFRAMES.forEach((tf, i) => {
    series[tf] = trendUp(overrides.bars ?? 220, 1.08, 0.0006, 0.0002, i + 1);
  });
  const bars = series.M5 as Bar[];
  const last = (bars[bars.length - 1] as Bar)[4] as number;
  const spreadPoints = overrides.spreadPoints ?? spec.spreadPoints;
  const half = (spreadPoints * spec.point) / 2;
  const quote: Quote = { symbol: "EURUSD", bid: last - half, ask: last + half, spreadPoints, ts: Date.now() };
  return evaluate({
    symbol: "EURUSD",
    mode: "intraday",
    spec,
    quote,
    series,
    account,
    positions: [],
    specs: new Map([["EURUSD", spec]]),
    riskState: createRiskState(),
    spreadHistory: overrides.spreadHistory,
    now: 1_700_000_000_000,
  });
}

/** A configuration with the master switch on and the execution layer enabled. */
function executionConfig(): DeskV4Config {
  return {
    ...DESK_V4_DEFAULTS,
    enabled: true,
    shadow: true,
    execution: { enabled: true, live: false },
  };
}

// ── The spread z-score ───────────────────────────────────────────────────────

test("W7.1 — the spread z-score is causal, windowed, and silent when it cannot be measured", () => {
  const history = Array.from({ length: 100 }, (_, i) => 8 + (i % 5) * 0.4);
  const reading = spreadZ({ spreadPoints: 12, history });
  assert.ok(reading !== null);
  assert.ok((reading as NonNullable<typeof reading>).z > SPREAD_Z_LIMIT);
  assert.equal((reading as NonNullable<typeof reading>).samples, 100);

  // Too few observations: no z-score at all, rather than one from three points.
  assert.equal(spreadZ({ spreadPoints: 12, history: [8, 9, 8], minSamples: SPREAD_Z_MIN_SAMPLES }), null);
  assert.equal(spreadZ({ spreadPoints: 12, history: [] }), null);
  // A constant history has no scale — dividing by zero is not a measurement.
  assert.equal(spreadZ({ spreadPoints: 12, history: new Array(80).fill(8) }), null);
  // Non-finite inputs are refused rather than propagated.
  assert.equal(spreadZ({ spreadPoints: Number.NaN, history }), null);

  // Only the TRAILING window counts: an ancient quiet regime must not dilute it.
  const ancient = [...new Array(400).fill(1), ...history];
  const windowed = spreadZ({ spreadPoints: 12, history: ancient, window: 100 });
  assert.ok(windowed !== null);
  assert.equal((windowed as NonNullable<typeof windowed>).samples, 100);
  assert.ok(
    Math.abs(
      (windowed as NonNullable<typeof windowed>).mean - (reading as NonNullable<typeof reading>).mean,
    ) < 1e-12,
  );
});

test("W7.2 — the desk's spread history is bounded, per symbol, and copied out", () => {
  const history = createSpreadHistory();
  for (let i = 0; i < 500; i++) recordSpread(history, "EURUSD", 8 + (i % 3) * 0.1);
  recordSpread(history, "XAUUSD", 25);
  assert.equal(spreadHistoryFor(history, "EURUSD").length, 400, "the ledger must not grow without bound");
  assert.deepEqual(spreadHistoryFor(history, "XAUUSD"), [25]);
  // A nonsense spread is not an observation.
  recordSpread(history, "XAUUSD", Number.NaN);
  recordSpread(history, "XAUUSD", 0);
  recordSpread(history, "XAUUSD", -3);
  assert.equal(spreadHistoryFor(history, "XAUUSD").length, 1);
  // The caller gets a copy: mutating it cannot corrupt the desk's record.
  const copy = spreadHistoryFor(history, "XAUUSD");
  copy.push(99);
  assert.equal(spreadHistoryFor(history, "XAUUSD").length, 1);
});

// ── Minute-of-week timing ────────────────────────────────────────────────────

test("W7.3 — a decision is bucketed by its OWN minute of the week", () => {
  const monday = Date.UTC(2024, 0, 1, 0, 0, 0);
  assert.equal(minuteOfWeek(monday), 24 * 60);
  assert.equal(minuteOfWeek(monday + 7 * 24 * 60 * 60 * 1000), 24 * 60, "the same minute next week is the same bucket");
  assert.equal(minuteOfWeek(monday + 60_000), 24 * 60 + 1);
  assert.equal(minuteOfWeek(monday - 60_000), 24 * 60 - 1, "minutes before the epoch anchor still land in-week");
});

test("W7.4 — the timing permit abstains when unmeasured and refuses only on a measured-worse bucket", () => {
  const ledger = createTimingLedger();
  const ts = Date.UTC(2024, 0, 3, 10, 0, 0); // a Wednesday, 10:00 UTC
  const first = timingPermit({ ledger, timestampMs: ts });
  assert.equal(first.permit, true, "an unmeasured bucket must not stop the desk");
  assert.equal(first.measured, false);
  assert.ok(first.codes.includes("TIMING_UNMEASURED"));

  // A losing bucket and a winning one, both measured.
  for (let i = 0; i < 40; i++) recordTimingOutcome(ledger, { timestampMs: ts, rMultiple: -1 });
  for (let i = 0; i < 40; i++) {
    recordTimingOutcome(ledger, { timestampMs: ts + 60 * 60 * 1000, rMultiple: 1.5 });
  }
  const bad = timingPermit({ ledger, timestampMs: ts });
  assert.equal(bad.measured, true);
  assert.equal(bad.permit, false, "a bucket measurably worse than the pooled record must refuse");
  assert.ok(bad.codes.includes("TIMING_BUCKET"));
  assert.ok(bad.samples >= 20);
  assert.ok(bad.meanR < bad.pooledMeanR);

  const good = timingPermit({ ledger, timestampMs: ts + 60 * 60 * 1000 });
  assert.equal(good.permit, true, "a bucket that is not measurably worse must not refuse");

  // The bucket is chosen by the DECISION bar: a trade entered at `ts` and closed
  // hours later is evidence about `ts`, and recording it under the exit minute
  // would smear the answer across the holding window.
  const other = createTimingLedger();
  recordTimingOutcome(other, { timestampMs: ts, rMultiple: -1 });
  recordTimingOutcome(other, { timestampMs: ts, rMultiple: -1 });
  assert.equal(other.buckets.get(minuteOfWeek(ts))?.losses, 2);
  assert.equal(other.buckets.size, 1);
});

// ── The slippage ledger ──────────────────────────────────────────────────────

test("W7.5 — slippage is signed against the trade, EWMA'd, and pauses above 0.15R", () => {
  assert.ok(
    Math.abs((signedSlippageR({ side: "buy", plannedPrice: 100, fillPrice: 100.5, riskPrice: 1 }) as number) - 0.5) < 1e-12,
  );
  assert.ok(
    Math.abs((signedSlippageR({ side: "sell", plannedPrice: 100, fillPrice: 99.5, riskPrice: 1 }) as number) - 0.5) < 1e-12,
  );
  assert.ok((signedSlippageR({ side: "buy", plannedPrice: 100, fillPrice: 99.5, riskPrice: 1 }) as number) < 0);
  assert.equal(signedSlippageR({ side: "buy", plannedPrice: 100, fillPrice: 100.5, riskPrice: 0 }), null);

  const ledger = createSlippageLedger();
  assert.equal(slippagePause(ledger).paused, false, "no observations is not a pause");
  assert.equal(measuredSlippageR(ledger), null, "and it is not a measurement either");
  recordSlippage(ledger, 0.2);
  assert.equal(ledger.ewmaR, 0.2, "the first observation IS the EWMA");
  recordSlippage(ledger, 0);
  assert.ok(Math.abs((ledger.ewmaR as number) - 0.97 * 0.2) < 1e-12);
  recordSlippage(ledger, -0.2);
  assert.ok((ledger.ewmaR as number) < 0.97 * 0.2, "a favourable fill must pull the EWMA down");
  assert.equal(measuredSlippageR(ledger), null, "two fills are not a measurement");
  assert.equal(measuredSlippageR(ledger, 2), ledger.ewmaR);

  const heavy = createSlippageLedger();
  for (let i = 0; i < 40; i++) recordSlippage(heavy, 0.3);
  const pause = slippagePause(heavy);
  assert.equal(pause.paused, true);
  assert.ok((pause.ewmaR as number) > SLIPPAGE_PAUSE_R);
  assert.match(pause.reason, /ceiling/);
  assert.equal(heavy.samples, 40);
  assert.ok(measuredSlippageR(heavy) !== null);
  assert.ok(heavy.samples >= SLIPPAGE_MEASUREMENT_MIN_SAMPLES);
});

test("W7.6 — the ledger keeps only what it can bound, and rejects a non-number", () => {
  const ledger = createSlippageLedger();
  for (let i = 0; i < 600; i++) recordSlippage(ledger, i % 2 === 0 ? 0.1 : -0.1);
  assert.equal(ledger.samples, 600, "the sample count is a running total");
  assert.equal(ledger.observations.length, 500, "but the observation window is bounded");
  const before = ledger.samples;
  recordSlippage(ledger, Number.NaN);
  assert.equal(ledger.samples, before, "a non-finite slippage is not an observation");
});

// ── The resting entry ────────────────────────────────────────────────────────

test("W7.7 — a pullback rests a limit, a breakout stops in, and both carry the brief's rules", () => {
  const pullback = pendingEntryPlan({
    mode: "intraday",
    side: "buy",
    decisionClose: 100,
    atr: 1,
    retraceAtr: 0.12,
    setup: "pullback",
    riskPrice: 1.5,
    slippagePrice: 0.02,
  });
  assert.equal(pullback.style, "limit");
  assert.ok(Math.abs(pullback.trigger - (100 - 0.12)) < 1e-12, "a pullback limit sits BEHIND the market for a buy");
  assert.equal(pullback.expireAfterBars, PENDING_EXPIRY_BARS.intraday);
  assert.equal(pullback.cancelAtR, PENDING_CANCEL_R);
  assert.equal(pullback.confirmOnBarClose, true);

  const breakout = pendingEntryPlan({
    mode: "scalp",
    side: "sell",
    decisionClose: 100,
    atr: 1,
    retraceAtr: 0.08,
    setup: "breakout",
    riskPrice: 1.5,
    slippagePrice: 0.02,
  });
  assert.equal(breakout.style, "stop");
  assert.ok(breakout.trigger < 100, "a breakout stop for a sell sits BELOW the market");
  assert.equal(breakout.expireAfterBars, PENDING_EXPIRY_BARS.scalp);

  // Like for like, on the same side: for a BUY the limit rests BELOW the market
  // and the stop triggers ABOVE it, so the two styles cannot be a relabel of
  // each other.
  const buyBreakout = pendingEntryPlan({
    mode: "intraday",
    side: "buy",
    decisionClose: 100,
    atr: 1,
    retraceAtr: 0.12,
    setup: "breakout",
    riskPrice: 1.5,
    slippagePrice: 0.02,
  });
  assert.ok(pullback.trigger < 100, "the pullback limit rests below the market for a buy");
  assert.ok(buyBreakout.trigger > 100, "the breakout stop triggers above the market for a buy");
  assert.ok(buyBreakout.trigger > pullback.trigger);

  const swing = pendingEntryPlan({
    mode: "swing",
    side: "buy",
    decisionClose: 100,
    atr: 1,
    retraceAtr: 0.12,
    setup: "pullback",
    riskPrice: 1.5,
    slippagePrice: 0.02,
  });
  assert.equal(swing.expireAfterBars, PENDING_EXPIRY_BARS.swing, "a swing plan may wait longer than a scalp");
});

// ── The composition ──────────────────────────────────────────────────────────

function decisionInput(overrides: Partial<Parameters<typeof executionDecision>[0]> = {}) {
  return {
    mode: "intraday" as const,
    side: "buy" as const,
    spec,
    decisionClose: 100,
    atr: 1,
    retraceAtr: 0.12,
    setup: "pullback" as const,
    riskPrice: 1.5,
    slippagePrice: 0.02,
    spreadPoints: 8,
    spreadHistory: Array.from({ length: 100 }, (_, i) => 8 + (i % 5) * 0.4),
    timestampMs: Date.UTC(2024, 0, 3, 10, 0, 0),
    timing: createTimingLedger(),
    slippage: createSlippageLedger(),
    ...overrides,
  };
}

test("W7.8 — the composition refuses by name and is a pure function of its inputs", () => {
  const refused = executionDecision(decisionInput({ spreadPoints: 14 }));
  assert.equal(refused.allowed, false);
  assert.ok(refused.codes.includes("EXEC_SPREAD_Z"));
  const lines = executionRejections(refused);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /^\[EXEC_SPREAD_Z\] /);

  const quiet = executionDecision(decisionInput());
  assert.equal(quiet.allowed, true);
  assert.deepEqual(executionRejections(quiet), []);
  assert.deepEqual(quiet, executionDecision(decisionInput()), "same inputs, same decision");

  const paused = createSlippageLedger();
  for (let i = 0; i < 50; i++) recordSlippage(paused, 0.4);
  const pausing = executionDecision(decisionInput({ slippage: paused }));
  assert.equal(pausing.allowed, false);
  assert.ok(pausing.codes.includes("EXEC_SLIPPAGE_PAUSE"));
  assert.match(executionRejections(pausing)[0] as string, /^\[EXEC_SLIPPAGE_PAUSE\] /);

  // Two independent failures are BOTH reported: a journal that lists only the
  // first objection cannot be audited for the checks that ran.
  const both = executionDecision(decisionInput({ spreadPoints: 14, slippage: paused }));
  assert.equal(executionRejections(both).length, 2);

  // Unmeasured spread history is not a veto, and neither is an unknown ledger.
  const unmeasured = executionDecision(decisionInput({ spreadPoints: 40, spreadHistory: [] }));
  assert.equal(unmeasured.allowed, true, "with no spread history the layer must have no opinion");
  assert.equal(unmeasured.spread, null);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("W7.9 — the shipped flag leaves the decision path untouched", () => {
  const restore = setDeskV4ForTests(null);
  try {
    const decision = run();
    assert.equal(decision.execution, null, "with the flag off the execution agent must decide nothing");
    assert.equal(decision.gatekeeper, null);
  } finally {
    restore();
  }
});

test("W7.10 — switched on with no measurements, the layer cannot change the plan", () => {
  const restoreOff = setDeskV4ForTests(null);
  const baseline = (() => {
    try {
      return run();
    } finally {
      restoreOff();
    }
  })();
  const restore = setDeskV4ForTests(executionConfig());
  try {
    const on = run();
    assert.ok(on.execution, "the layer ran");
    assert.equal(on.armed, baseline.armed);
    assert.equal(on.execution?.timing.permit, true, "an unmeasured bucket must not stop the desk");
    assert.equal(on.execution?.timing.measured, false);
    assert.equal(on.plan?.triggerType, baseline.plan?.triggerType, "a shadow layer may not change the entry style");
    // `id` and `createdAt` are per-decision by construction; every number the
    // trade is actually made of is not.
    const shape = (plan: typeof baseline.plan) =>
      plan
        ? {
            trigger: plan.trigger,
            triggerType: plan.triggerType,
            sl: plan.sl,
            tp: plan.tp,
            lots: plan.lots,
            riskMoney: plan.riskMoney,
            riskPoints: plan.riskPoints,
            maxSpreadPoints: plan.maxSpreadPoints,
            maxSlippagePoints: plan.maxSlippagePoints,
          }
        : null;
    assert.deepEqual(shape(on.plan), shape(baseline.plan), "with no measurements the plan must be exactly the legacy plan");
    assert.deepEqual(on.plan?.rationale.warnings, baseline.plan?.rationale.warnings);
    assert.deepEqual(on.rejections, baseline.rejections);
  } finally {
    restore();
  }
});

test("W7.11 — a spread far above its own trailing distribution refuses the entry, by name", () => {
  const history = Array.from({ length: 120 }, (_, i) => 8 + (i % 5) * 0.4);
  const restore = setDeskV4ForTests(executionConfig());
  try {
    const decision = run({ spreadPoints: 40, spreadHistory: history });
    assert.equal(decision.armed, false);
    assert.ok(decision.execution, "the layer must have run for the refusal to be attributable");
    assert.ok(decision.execution?.codes.includes("EXEC_SPREAD_Z"));
    assert.ok(
      decision.rejections.some((line) => line.startsWith("[EXEC_SPREAD_Z]")),
      decision.rejections.join(" | "),
    );
    assert.equal(decision.plan, null);
  } finally {
    restore();
  }
});

test("W7.12 — a paused slippage ledger stops new entries with a sentence a human can act on", () => {
  const restore = setDeskV4ForTests(executionConfig());
  try {
    const ledger = getSlippageLedger();
    const before = ledger.samples;
    for (let i = 0; i < 60; i++) recordSlippage(ledger, 0.4);
    const decision = run({ spreadHistory: Array.from({ length: 120 }, (_, i) => 8 + (i % 5) * 0.4) });
    assert.equal(decision.armed, false);
    assert.ok(
      decision.rejections.some((line) => line.startsWith("[EXEC_SLIPPAGE_PAUSE]")),
      decision.rejections.join(" | "),
    );
    assert.ok(ledger.samples >= before + 60);
  } finally {
    restore();
  }
});

test("W7.13 — D7: the allowance becomes MEASURED once the desk has watched its own fills, and never becomes optimistic", () => {
  const modelledWarns = (warnings: string[]): boolean => warnings.some((line) => /MEASURED, not assumed/.test(line));

  // Not measured enough to count: the modelled allowance stands, flag or no flag.
  resetExecutionLedgersForTests();
  const restoreOn = setDeskV4ForTests(executionConfig());
  try {
    for (let i = 0; i < 5; i++) recordSlippage(getSlippageLedger(), 0.5);
    const few = run({ spreadHistory: [] });
    assert.equal(modelledWarns(few.warnings), false, "five fills are not a measurement");
    assert.equal(few.plan?.rationale.warnings.some((line) => /MEASURED/.test(line)) ?? false, false);
  } finally {
    restoreOn();
  }

  // Measured, but BETTER than the modelled allowance: the desk must not start
  // pricing its fills as free.
  resetExecutionLedgersForTests();
  const restoreOn2 = setDeskV4ForTests(executionConfig());
  try {
    for (let i = 0; i < 40; i++) recordSlippage(getSlippageLedger(), 0.0005);
    const better = run({ spreadHistory: [] });
    assert.equal(modelledWarns(better.warnings), false, "a measured allowance below the modelled one must not lower it");
  } finally {
    restoreOn2();
  }

  // Measured and WORSE: the allowance is replaced, the fact is recorded, and the
  // number the plan is measured from moves with it.
  resetExecutionLedgersForTests();
  const restoreOn3 = setDeskV4ForTests(executionConfig());
  try {
    for (let i = 0; i < 40; i++) recordSlippage(getSlippageLedger(), 0.1);
    const worse = run({ spreadHistory: [] });
    assert.ok(
      modelledWarns(worse.warnings) ||
        (worse.plan?.rationale.warnings ?? []).some((line) => /MEASURED, not assumed/.test(line)) ||
        worse.rejections.some((line) => /MEASURED, not assumed/.test(line)),
      `the measurement must be reported somewhere: ${worse.warnings.join(" | ")}`,
    );
  } finally {
    restoreOn3();
  }

  // The D7 step belongs to the execution layer's flag: switched off, the
  // allowance is the constant it always was, whatever the ledger holds.
  resetExecutionLedgersForTests();
  const restoreOff = setDeskV4ForTests(null);
  try {
    for (let i = 0; i < 40; i++) recordSlippage(getSlippageLedger(), 0.1);
    const off = run({ spreadHistory: [] });
    assert.equal(modelledWarns(off.warnings), false, "with the flag off the modelled allowance stands");
    assert.equal(off.execution, null);
  } finally {
    restoreOff();
    resetExecutionLedgersForTests();
  }
});
