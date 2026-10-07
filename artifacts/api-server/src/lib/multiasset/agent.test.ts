/**
 * Agent tests — the end-to-end decision path.
 *
 * These drive the agent with synthetic markets whose character is known in
 * advance (clean trend, dead range, violent chop) and assert that the gates
 * behave the way docs/multi-asset-architecture.md §3.1 promises: a plan is
 * armed only when direction, regime, persistence, expectancy, cost, spread
 * and risk ALL agree, and a refusal always carries its reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildManagementPlan, evaluate, horizonMinutes, structuralStop } from "./agent";
import { createRiskState, recordOutcome, type RiskState } from "./risk";
import { makeRng } from "./math";
import { TIMEFRAMES, type AccountSnapshot, type Bar, type Quote, type SymbolSpec, type Timeframe } from "./types";
import type { NewsGuardInput } from "./news";

// ── Market builders ──────────────────────────────────────────────────────────

/** Clean, orderly uptrend with mild noise — the textbook long setup. */
function trendUp(count = 220, start = 1.08, drift = 0.0006, noise = 0.0002, seed = 1): Bar[] {
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

function trendDown(count = 220, start = 1.08, seed = 2): Bar[] {
  return trendUp(count, start, -0.0006, 0.0002, seed);
}

/** A tight, directionless range. */
function range(count = 220, start = 1.08, seed = 3): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const mid = start * (1 + Math.sin(i / 6) * 0.0004);
    const open = mid * (1 + (rng() - 0.5) * 0.00005);
    const close = mid * (1 + (rng() - 0.5) * 0.00005);
    bars.push([i * 60_000, open, Math.max(open, close) * 1.00002, Math.min(open, close) * 0.99998, close, 100]);
  }
  return bars;
}

function allTimeframes(builder: (seed: number) => Bar[]): Partial<Record<Timeframe, Bar[]>> {
  const series: Partial<Record<Timeframe, Bar[]>> = {};
  TIMEFRAMES.forEach((tf, i) => {
    series[tf] = builder(i + 1);
  });
  return series;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

function quoteFrom(series: Partial<Record<Timeframe, Bar[]>>, spreadPoints = 8): Quote {
  const bars = series.M5 ?? series.M1 ?? [];
  const last = bars.length > 0 ? bars[bars.length - 1][4] : 1.08;
  const half = (spreadPoints * spec.point) / 2;
  return { symbol: "EURUSD", bid: last - half, ask: last + half, spreadPoints, ts: Date.now() };
}

function run(overrides: {
  series?: Partial<Record<Timeframe, Bar[]>>;
  spec?: SymbolSpec;
  quote?: Quote;
  account?: Partial<AccountSnapshot>;
  riskState?: RiskState;
  mode?: "scalp" | "intraday" | "swing";
  minEdgeR?: number;
  minPersistence?: number;
  news?: NewsGuardInput;
} = {}) {
  const series = overrides.series ?? allTimeframes((s) => trendUp(220, 1.08, 0.0006, 0.0002, s));
  const useSpec = overrides.spec ?? spec;
  return evaluate({
    symbol: "EURUSD",
    mode: overrides.mode ?? "intraday",
    spec: useSpec,
    quote: overrides.quote ?? quoteFrom(series, useSpec.spreadPoints),
    series,
    account: { ...account, ...(overrides.account ?? {}) },
    positions: [],
    specs: new Map([["EURUSD", useSpec]]),
    riskState: overrides.riskState ?? createRiskState(),
    minEdgeR: overrides.minEdgeR,
    minPersistence: overrides.minPersistence,
    news: overrides.news,
    now: 1_700_000_000_000,
  });
}

// ── Structural stops ─────────────────────────────────────────────────────────

test("a long's stop sits below entry and a short's above", () => {
  const bars = trendUp();
  const entry = bars[bars.length - 1][4];
  const long = structuralStop(bars, "buy", entry, "intraday");
  const short = structuralStop(bars, "sell", entry, "intraday");
  assert.ok(long.sl < entry, "long stop must be below entry");
  assert.ok(short.sl > entry, "short stop must be above entry");
  assert.ok(long.atrValue > 0);
});

test("stop distance widens with the trade horizon", () => {
  const bars = trendUp();
  const entry = bars[bars.length - 1][4];
  const scalp = structuralStop(bars, "buy", entry, "scalp");
  const swing = structuralStop(bars, "buy", entry, "swing");
  // Both are valid placements; the swing stop must never be the tighter one.
  assert.ok(entry - swing.sl >= entry - scalp.sl - 1e-12);
});

test("a flat market still yields a finite stop", () => {
  const bars = range();
  const entry = bars[bars.length - 1][4];
  const stop = structuralStop(bars, "buy", entry, "intraday");
  assert.ok(Number.isFinite(stop.sl));
  assert.ok(stop.sl < entry);
});

// ── Direction ────────────────────────────────────────────────────────────────

test("an uptrend produces a long bias, a downtrend a short bias", () => {
  const up = run();
  assert.equal(up.confluence.direction, "up");

  const downSeries = allTimeframes((s) => trendDown(220, 1.08, s));
  const down = run({ series: downSeries, quote: quoteFrom(downSeries) });
  assert.equal(down.confluence.direction, "down");
});

test("a trending market scores far above a dead range", () => {
  const rangeSeries = allTimeframes((s) => range(220, 1.08, s));
  const trendScore = run().confluence.score;
  const rangeScore = run({ series: rangeSeries, quote: quoteFrom(rangeSeries) }).confluence.score;
  assert.ok(trendScore > rangeScore, `trend ${trendScore} vs range ${rangeScore}`);
});

test("a clean aligned trend arms a plan", () => {
  const decision = run();
  assert.equal(decision.armed, true, decision.rejections.join(" | "));
  assert.ok(decision.plan);
  assert.equal(decision.rejections.length, 0);
});

test("the agent fails closed when the MT5 high-impact calendar is unavailable", () => {
  const decision = run({
    news: {
      ready: false,
      error: "calendar stale",
      events: [],
      blackoutBeforeMs: 30 * 60_000,
      blackoutAfterMs: 15 * 60_000,
    },
  });
  assert.equal(decision.armed, false);
  assert.match(decision.rejections.join(" "), /calendar is unavailable, stale, or lacks coverage/i);
});

test("the agent blocks matching high-impact news but allows an unrelated currency event", () => {
  const now = 1_700_000_000_000;
  const makeNews = (currency: string): NewsGuardInput => ({
    ready: true,
    error: null,
    events: [{ id: `event-${currency}`, currency, title: "Scheduled release", impact: "high", ts: now }],
    blackoutBeforeMs: 30 * 60_000,
    blackoutAfterMs: 15 * 60_000,
  });
  const blocked = run({ news: makeNews("USD") });
  assert.equal(blocked.armed, false);
  assert.match(blocked.rejections.join(" "), /USD high-impact news blackout/i);

  const unrelated = run({ news: makeNews("JPY") });
  assert.equal(unrelated.armed, true, unrelated.rejections.join(" | "));
});

// ── Plan integrity — the properties that must hold for every armed plan ──────

test("an armed long plan is internally consistent", () => {
  const decision = run();
  const plan = decision.plan!;
  assert.equal(plan.side, "buy");
  assert.ok(plan.sl < plan.trigger, "stop must sit below the trigger for a long");
  assert.ok(plan.tp[0] > plan.trigger, "target must sit above the trigger for a long");
  assert.ok(plan.invalidate < plan.trigger, "invalidation must be below the trigger");
  assert.ok(plan.lots > 0);
  assert.ok(plan.riskMoney > 0);
  assert.ok(plan.expiresAt > plan.createdAt, "a plan must expire");
  assert.ok(plan.maxSpreadPoints > 0 && plan.maxSlippagePoints > 0);
});

test("an armed short plan mirrors the long", () => {
  const series = allTimeframes((s) => trendDown(220, 1.08, s));
  const decision = run({ series, quote: quoteFrom(series) });
  if (!decision.armed) return; // a legitimate no-trade is acceptable here
  const plan = decision.plan!;
  assert.equal(plan.side, "sell");
  assert.ok(plan.sl > plan.trigger);
  assert.ok(plan.tp[0] < plan.trigger);
  assert.ok(plan.invalidate > plan.trigger);
});

test("risk on an armed plan never exceeds the policy ceiling", () => {
  const decision = run();
  const plan = decision.plan!;
  const riskPct = (plan.riskMoney / account.equity) * 100;
  assert.ok(riskPct <= 2 + 1e-9, `plan risked ${riskPct}%`);
});

test("the rationale explains the decision", () => {
  const plan = run().plan!;
  assert.ok(plan.rationale.factors.length > 0);
  assert.ok(plan.rationale.confluenceScore > 0);
  assert.ok(plan.rationale.winProbability > 0 && plan.rationale.winProbability <= 1);
  assert.ok(plan.rationale.rewardRisk > 0);
  assert.ok(plan.rationale.factors.some((f) => f.label === "Monte Carlo"));
  assert.ok(plan.rationale.factors.some((f) => f.label === "Sizing"));
});

test("evaluation is deterministic for identical input", () => {
  const a = run();
  const b = run();
  assert.equal(a.armed, b.armed);
  assert.equal(a.confluence.score, b.confluence.score);
  assert.equal(a.monteCarlo?.winProbability, b.monteCarlo?.winProbability);
  assert.equal(a.sizing?.lots, b.sizing?.lots);
});

// ── The gates ────────────────────────────────────────────────────────────────

test("a directionless range is refused with a reason", () => {
  const series = allTimeframes((s) => range(220, 1.08, s));
  const decision = run({ series, quote: quoteFrom(series) });
  assert.equal(decision.armed, false);
  assert.ok(decision.rejections.length > 0);
  assert.match(decision.summary, /no trade/);
});

test("an impossible edge requirement refuses every setup", () => {
  const decision = run({ minEdgeR: 99 });
  assert.equal(decision.armed, false);
  assert.ok(decision.rejections.some((r) => /Expectancy after costs/.test(r)));
});

test("an impossible persistence requirement refuses every setup", () => {
  const decision = run({ minPersistence: 0.999 });
  assert.equal(decision.armed, false);
  assert.ok(decision.rejections.some((r) => /Markov persistence/.test(r)));
});

test("a blown-out spread blocks execution", () => {
  const series = allTimeframes((s) => trendUp(220, 1.08, 0.0006, 0.0002, s));
  const decision = run({ series, quote: quoteFrom(series, 400) });
  assert.equal(decision.armed, false);
  assert.ok(
    decision.rejections.some((r) => /[Ss]pread/.test(r)),
    decision.rejections.join(" | "),
  );
});

test("punitive commission blocks the trade on cost grounds", () => {
  const decision = run({ spec: { ...spec, commissionPerLot: 400 } });
  assert.equal(decision.armed, false);
  assert.ok(
    decision.rejections.some((r) => /cost|Expectancy/i.test(r)),
    decision.rejections.join(" | "),
  );
});

test("an account too small for the minimum lot is refused, not over-risked", () => {
  const decision = run({ account: { equity: 40, balance: 40, freeMargin: 40, dayStartEquity: 40, peakEquity: 40 } });
  assert.equal(decision.armed, false);
  assert.ok(decision.sizing && !decision.sizing.ok);
});

test("a halted desk is refused before any analysis cost is paid", () => {
  let state = createRiskState();
  for (let i = 0; i < 5; i++) {
    state = recordOutcome(state, { symbol: "EURUSD", profit: -10, closedAt: 1 });
  }
  const decision = run({ riskState: state });
  assert.equal(decision.armed, false);
  assert.ok(decision.rejections.some((r) => /consecutive losses/.test(r)));
});

test("a live account without the live flag is refused", () => {
  const decision = run({ account: { isLive: true } });
  assert.equal(decision.armed, false);
  assert.ok(decision.rejections.some((r) => /Live trading is disabled/.test(r)));
});

test("de-escalation shrinks the armed size after losses", () => {
  const clean = run();
  assert.equal(clean.armed, true);

  let state = createRiskState();
  state = recordOutcome(state, { symbol: "GBPUSD", profit: -10, closedAt: 1 });
  state = recordOutcome(state, { symbol: "GBPUSD", profit: -10, closedAt: 2 });
  const after = run({ riskState: state });

  if (after.armed) {
    assert.ok(
      after.plan!.riskMoney < clean.plan!.riskMoney,
      `risk rose from ${clean.plan!.riskMoney} to ${after.plan!.riskMoney} after losses`,
    );
  } else {
    // Also acceptable: the raised quality bar rejected the setup entirely.
    assert.ok(after.rejections.length > 0);
  }
});

// ── Management plan ──────────────────────────────────────────────────────────

test("trending markets trail and allow pyramiding; ranges do neither", () => {
  const trending = buildManagementPlan({
    spec, mode: "intraday", lots: 1, regimeKind: "trend_up",
    atrPoints: 200, retraceProbability: 0.2,
  });
  assert.ok(trending.trail, "a trend must trail so winners can run");
  assert.ok(trending.pyramid, "a trend may add");

  const ranging = buildManagementPlan({
    spec, mode: "intraday", lots: 1, regimeKind: "range",
    atrPoints: 200, retraceProbability: 0.2,
  });
  assert.equal(ranging.trail, null, "a range should bank at the band edge");
  assert.equal(ranging.pyramid, null, "never pyramid into a range");
});

test("breakeven is deferred when a retrace is likely", () => {
  const safe = buildManagementPlan({
    spec, mode: "intraday", lots: 1, regimeKind: "trend_up",
    atrPoints: 200, retraceProbability: 0.1,
  });
  const risky = buildManagementPlan({
    spec, mode: "intraday", lots: 1, regimeKind: "trend_up",
    atrPoints: 200, retraceProbability: 0.8,
  });
  assert.ok(
    risky.breakeven!.triggerR > safe.breakeven!.triggerR,
    "a likely retrace must push breakeven further out, not scratch the trade",
  );
});

test("partials are dropped when the broker's volume step cannot honour them", () => {
  // 0.01 lots is the minimum: no legal way to close half of it.
  const tiny = buildManagementPlan({
    spec, mode: "intraday", lots: 0.01, regimeKind: "trend_up",
    atrPoints: 200, retraceProbability: 0.2,
  });
  assert.equal(tiny.partials.length, 0, "an unachievable ladder must not be sent");

  const large = buildManagementPlan({
    spec, mode: "intraday", lots: 2, regimeKind: "trend_up",
    atrPoints: 200, retraceProbability: 0.2,
  });
  assert.ok(large.partials.length > 0);
});

test("pyramiding always requires a risk-free base and decreasing size", () => {
  const plan = buildManagementPlan({
    spec, mode: "swing", lots: 1, regimeKind: "trend_up",
    atrPoints: 200, retraceProbability: 0.2,
  });
  assert.equal(plan.pyramid!.requireBaseAtBreakeven, true);
  assert.ok(plan.pyramid!.sizeRatio < 1, "adds must be smaller than the base");
  assert.ok(plan.pyramid!.portfolioRiskCapR <= 1.5);
});

test("every management plan carries a time stop and execution guards", () => {
  for (const regimeKind of ["trend_up", "range", "trend_down"]) {
    const plan = buildManagementPlan({
      spec, mode: "scalp", lots: 1, regimeKind, atrPoints: 100, retraceProbability: 0.3,
    });
    assert.ok(plan.timeStop, `${regimeKind} needs a time stop`);
    assert.ok(plan.guards.maxSpreadPoints > 0);
  }
});

// ── Modes ────────────────────────────────────────────────────────────────────

test("scalp, intraday and swing have increasing horizons", () => {
  assert.ok(horizonMinutes("scalp") < horizonMinutes("intraday"));
  assert.ok(horizonMinutes("intraday") < horizonMinutes("swing"));
});

test("every mode returns a well-formed decision", () => {
  for (const mode of ["scalp", "intraday", "swing"] as const) {
    const decision = run({ mode });
    assert.equal(decision.mode, mode);
    assert.ok(decision.summary.length > 0);
    assert.ok(Array.isArray(decision.rejections));
    if (decision.armed) assert.ok(decision.plan);
    else assert.ok(decision.rejections.length > 0, `${mode} refused without a reason`);
  }
});

test("missing market data is refused rather than guessed", () => {
  const decision = evaluate({
    symbol: "EURUSD",
    mode: "intraday",
    spec,
    quote: { symbol: "EURUSD", bid: 1.08, ask: 1.0801, spreadPoints: 10, ts: Date.now() },
    series: {},
    account,
    positions: [],
    specs: new Map([["EURUSD", spec]]),
    riskState: createRiskState(),
  });
  assert.equal(decision.armed, false);
  assert.ok(decision.rejections.length > 0);
});
