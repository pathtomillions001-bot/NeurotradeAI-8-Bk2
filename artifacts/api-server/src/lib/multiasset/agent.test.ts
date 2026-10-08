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

import { buildManagementPlan, evaluate, horizonMinutes, RR_POLICY, structuralStop, structureTarget } from "./agent";
import { createRiskState, recordOutcome, type RiskState } from "./risk";
import { makeRng } from "./math";
import { TIMEFRAMES, type AccountSnapshot, type Bar, type Quote, type SymbolSpec, type Timeframe } from "./types";

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

/**
 * THE SPREAD IS PRICED, NEVER VETOED.
 *
 * A blown-out quote used to be refused on a ratio ("Spread 8 pts is 83% of the
 * 10-pt stop — above the 35% ceiling for forex") — a rule that rejected exactly
 * the setups whose risk unit was small, while the number that decides whether a
 * trade pays (the expectancy, net of cost) was already computed one step above.
 * The gate is gone. What replaces it is arithmetic: `costR` states how much of
 * the risk unit the round trip costs, the risk unit is floored above that cost,
 * and the expectancy gate — with the same input for every asset class — is the
 * only thing that can refuse on economics.
 */
test("a blown-out spread is priced into the risk unit, not vetoed by a ratio", () => {
  const series = allTimeframes((s) => trendUp(220, 1.08, 0.0006, 0.0002, s));
  const calm = run({ series, quote: quoteFrom(series, 8) });
  const wild = run({ series, quote: quoteFrom(series, 400) });

  // The spread is never the reason for a refusal any more.
  for (const rejection of wild.rejections) {
    assert.ok(!/spread/i.test(rejection), `a ratio veto slipped back in: ${rejection}`);
  }
  assert.ok(wild.costR !== null && wild.costR > 0.2, "a 400-point spread must show up in R");
  // …and it visibly costs more than a calm quote on the same market.
  assert.ok((wild.costR ?? 0) > (calm.costR ?? 0));

  // A quote that wide needs a real risk unit: the stop is widened until the
  // cost is a minority of it, and the widening is reported, never silent.
  const widened = [...wild.warnings, ...calm.warnings].some((warning) => /Stop widened/.test(warning));
  assert.ok(widened, "the stop must be widened rather than the trade blocked");
  assert.ok(wild.plan === null || wild.plan.maxSpreadPoints > 400, "the fill guard must clear the measured spread");
});

test("punitive commission is charged inside the expectancy, not vetoed", () => {
  const decision = run({ spec: { ...spec, commissionPerLot: 400 } });
  assert.ok(decision.costR !== null && decision.costR > 0.2, "commission must appear in the cost term");
  for (const rejection of decision.rejections) {
    assert.ok(!/ceiling for forex/i.test(rejection), `cost veto slipped back in: ${rejection}`);
  }
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

// ── The per-trade risk budget ────────────────────────────────────────────────
// The desk allows 0.5% of equity per trade. It is a CEILING, not the size: the
// sizer still decides, from edge and de-escalation, how much of it to use — and
// the broker's indivisible minimum lot is judged against the ceiling rather than
// against the (possibly much smaller) adaptive target.
//
// This is the reported failure: on a ~$760 account, 0.01 lots risked 0.17% of
// equity and the old code refused the trade because the adaptive target was
// 0.15%. An account that could afford 0.17% was told it could not trade at all.

test("the reported minimum-lot refusal no longer blocks an affordable account", () => {
  const decision = run({
    account: { equity: 760, freeMargin: 760, dayStartEquity: 760, peakEquity: 760 },
  });

  assert.equal(decision.armed, true, decision.rejections[0]);
  assert.ok(
    decision.sizing!.lots >= spec.volumeMin,
    `expected at least the broker minimum, got ${decision.sizing!.lots} lots`,
  );
  assert.ok(
    !decision.rejections.some((r) => /Minimum .*lots/.test(r)),
    `minimum-lot refusal resurfaced: ${decision.rejections.join("; ")}`,
  );
  assert.ok(
    decision.sizing!.effectiveRiskPct <= 0.5 + 1e-9,
    `risk ${decision.sizing!.effectiveRiskPct}% breached the 0.50% budget`,
  );
});

test("the per-trade budget is enforced end to end, and named when it binds", () => {
  // $200 of equity: the smallest legal lot risks $1.35 = 0.67%, which is inside
  // the loose 2% policy ceiling but ABOVE the desk's 0.50% per-trade budget.
  // The refusal must therefore come from the budget, and say so.
  const decision = run({
    account: { equity: 200, freeMargin: 200, dayStartEquity: 200, peakEquity: 200 },
  });

  assert.equal(decision.armed, false);
  assert.equal(decision.sizing!.ok, false);
  assert.equal(decision.sizing!.rejection, "below_min_lot");
  assert.match(decision.rejections.join(" "), /above the 0\.50% per-trade risk budget/);
});

test("the budget caps risk without fixing it — the ladder still decides the size", () => {
  const clean = run();
  assert.equal(clean.armed, true);
  assert.equal(clean.risk.riskCeilingPct, 0.5);
  assert.ok(clean.sizing!.effectiveRiskPct <= 0.5 + 1e-9);

  // Three consecutive losses: the governor de-escalates and the same market,
  // with the same edge, must be taken SMALLER — well inside the budget. That is
  // only possible because the budget is a ceiling rather than a fixed size.
  let state = createRiskState();
  for (let i = 0; i < 3; i++) {
    state = recordOutcome(state, { symbol: "EURUSD", profit: -20, closedAt: i + 1 });
  }
  const after = run({ riskState: state });

  assert.equal(after.armed, true, after.rejections[0]);
  assert.ok(
    after.risk.riskPct < clean.risk.riskPct,
    `governor did not de-escalate: ${clean.risk.riskPct}% -> ${after.risk.riskPct}%`,
  );
  assert.ok(
    after.sizing!.effectiveRiskPct < 0.5 - 1e-9,
    `de-escalated risk ${after.sizing!.effectiveRiskPct}% still filled the budget`,
  );
  assert.ok(
    after.sizing!.effectiveRiskPct < clean.sizing!.effectiveRiskPct,
    `size did not shrink: ${clean.sizing!.effectiveRiskPct}% -> ${after.sizing!.effectiveRiskPct}%`,
  );
});

// ── Management plan ──────────────────────────────────────────────────────────

// ── Target policy (RR_POLICY) ────────────────────────────────────────────────

/**
 * A flat tape at `price`, with one spike reaching `spikePrice` at `spikeAt`.
 * The spike is the only confirmed swing, so it is the only structure the scalp
 * target can see. `kind` picks which side of the bar the spike lives on.
 */
function tapeWithSpike(count: number, price: number, spikeAt: number | null, spikePrice: number, kind: "high" | "low"): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) bars.push([i * 60_000, price, price + 0.1, price - 0.1, price, 100]);
  if (spikeAt !== null) {
    const bar = bars[spikeAt]!;
    if (kind === "high") bar[2] = spikePrice;
    else bar[3] = spikePrice;
  }
  return bars;
}

test("a scalp target is the nearest opposing structure, clamped to [1R, 2R]", () => {
  const base = { side: "buy" as const, trigger: 100, riskPrice: 1, atrValue: 0.5 };

  // Structure 1.5R ahead: the target sits a tenth of an ATR short of it.
  const inside = structureTarget({ ...base, bars: tapeWithSpike(60, 100, 40, 101.5, "high") });
  assert.equal(inside.blocked, false);
  assert.ok(Math.abs(inside.rewardRisk - 1.45) < 1e-9, `rr was ${inside.rewardRisk}`);

  // Structure beyond the cap: the cap itself, not the structure.
  const far = structureTarget({ ...base, bars: tapeWithSpike(60, 100, 40, 104, "high") });
  assert.equal(far.rewardRisk, RR_POLICY.scalpMax);

  // No structure at all: the cap.
  const none = structureTarget({ ...base, bars: tapeWithSpike(60, 100, null, 0, "high") });
  assert.equal(none.rewardRisk, RR_POLICY.scalpMax);
});

test("a scalp with structure inside 1R has no room for the minimum and is refused with the reason", () => {
  const near = structureTarget({
    side: "buy", trigger: 100, riskPrice: 1, atrValue: 0.5,
    bars: tapeWithSpike(60, 100, 40, 100.6, "high"),
  });
  assert.equal(near.blocked, true);
  assert.match(near.reason ?? "", /no room for the minimum reward/);
});

test("the structure search reads only the side it trades toward", () => {
  const sell = structureTarget({
    side: "sell", trigger: 100, riskPrice: 1, atrValue: 0.5,
    bars: tapeWithSpike(60, 100, 40, 98.5, "low"),
  });
  assert.ok(Math.abs(sell.rewardRisk - 1.45) < 1e-9, `short rr was ${sell.rewardRisk}`);

  const wrongSide = structureTarget({
    side: "sell", trigger: 100, riskPrice: 1, atrValue: 0.5,
    bars: tapeWithSpike(60, 100, 40, 101.5, "high"),
  });
  assert.equal(wrongSide.rewardRisk, RR_POLICY.scalpMax, "a swing high above is no obstacle to a short");
});

test("intraday targets sit at exactly the fixed 2R, measured from the trigger", () => {
  const decision = run({ mode: "intraday" });
  assert.ok(decision.plan, decision.rejections.join(" | "));
  const plan = decision.plan!;
  const rr = Math.abs(plan.tp[0] - plan.trigger) / Math.abs(plan.trigger - plan.sl);
  assert.ok(Math.abs(rr - RR_POLICY.fixed) < 1e-9, `intraday RR was ${rr}`);
});

test("a scalp target lands inside the policy band, and scalps do arm on a real trend", () => {
  // The earlier version returned early whenever nothing armed, so it could pass
  // having checked nothing. This one counts the armed scalps and insists on some.
  let checked = 0;
  for (let seed = 1; seed <= 40 && checked < 5; seed++) {
    const bars = randomWalk(400, 1.08, 0.0005, seed * 7 + 3, 0.00025);
    const series = allTimeframes(() => bars);
    const decision = run({ series, quote: quoteFrom(series), mode: "scalp" });
    if (!decision.armed || !decision.plan) continue;
    checked++;
    const rr = Math.abs(decision.plan.tp[0] - decision.plan.trigger) / Math.abs(decision.plan.trigger - decision.plan.sl);
    assert.ok(
      rr >= RR_POLICY.scalpMin - 1e-9 && rr <= RR_POLICY.scalpMax + 1e-9,
      `scalp RR ${rr.toFixed(3)} outside [1, 2] (seed ${seed})`,
    );
  }
  assert.ok(checked >= 3, `only ${checked} scalps armed, so the band was barely tested`);
});

test("the management plan enforces breakeven, extension and a time stop — and nothing it does not enforce", () => {
  const plan = buildManagementPlan({ spec, mode: "intraday", atrPoints: 200, costR: 0.2 });
  assert.equal(plan.breakeven!.triggerR, 1);
  assert.ok(Math.abs(plan.breakeven!.offsetR - 0.25) < 1e-9);
  assert.equal(plan.extension!.checkAtR, RR_POLICY.checkAtR);
  assert.equal(plan.extension!.extendToR, RR_POLICY.extendToR);
  assert.equal(plan.timeStop!.maxHoldMinutes, horizonMinutes("intraday"));
  for (const dead of ["partials", "trail", "pyramid"]) {
    assert.equal(dead in plan, false, `${dead} was never executed, so it must not be sent`);
  }
});

test("the breakeven offset covers the trade's own cost, clamped to [0.1R, 0.3R]", () => {
  const offset = (costR: number) =>
    buildManagementPlan({ spec, mode: "intraday", atrPoints: 200, costR }).breakeven!.offsetR;
  assert.ok(Math.abs(offset(0) - 0.1) < 1e-9, "a free trade still keeps a small margin");
  assert.ok(Math.abs(offset(0.2) - 0.25) < 1e-9);
  assert.ok(Math.abs(offset(5) - 0.3) < 1e-9, "a punitive cost cannot push breakeven past 0.3R");
});

test("scalps never extend, and their hold is five minutes", () => {
  const plan = buildManagementPlan({ spec, mode: "scalp", atrPoints: 100, costR: 0.2 });
  assert.equal(plan.extension, null);
  assert.equal(plan.timeStop!.maxHoldMinutes, 5);
});

test("every management plan carries a time stop and execution guards", () => {
  for (const mode of ["scalp", "intraday", "swing"] as const) {
    const plan = buildManagementPlan({ spec, mode, atrPoints: 100, costR: 0.3 });
    assert.ok(plan.timeStop, `${mode} needs a time stop`);
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

// ── The stop is on the correct side of entry, always ─────────────────────────
//
// This is the regression that produced "Stop loss 31163.55 is on the wrong side
// of entry 31151.36 for a buy" on the desk. After a breakdown the most recent
// confirmed swing LOW sits above the live price; the old placement guard only
// compared |distance|, so it accepted a buy stop above the entry and the plan
// died in sizing instead of being placed from the ATR.

test("a buy stop stays below entry even when the last swing low is above it", () => {
  // A staircase down: every confirmed swing low is above the price that
  // follows it, which is exactly the breakdown case.
  const bars: Bar[] = [];
  let price = 1.2;
  for (let i = 0; i < 60; i++) {
    const open = price;
    price = open - 0.0004;
    bars.push([i * 60_000, open, open + 0.00005, price - 0.00005, price, 100]);
  }
  const entry = bars[bars.length - 1][4] + 0.00005; // ask above the last close
  const stop = structuralStop(bars, "buy", entry, "scalp");
  assert.ok(stop.sl < entry, `buy stop ${stop.sl} must sit below entry ${entry}`);
  assert.equal(stop.usedSwing, false, "a swing above the market cannot be a long's stop");
});

test("a sell stop stays above entry even when the last swing high is below it", () => {
  const bars: Bar[] = [];
  let price = 1.0;
  for (let i = 0; i < 60; i++) {
    const open = price;
    price = open + 0.0004;
    bars.push([i * 60_000, open, price + 0.00005, open - 0.00005, price, 100]);
  }
  const entry = bars[bars.length - 1][4] - 0.00005;
  const stop = structuralStop(bars, "sell", entry, "scalp");
  assert.ok(stop.sl > entry, `sell stop ${stop.sl} must sit above entry ${entry}`);
});

test("no evaluated plan ever carries a stop on the wrong side of its own trigger", () => {
  const series = allTimeframes((s) => trendDown(220, 1.08, s));
  for (const mode of ["scalp", "intraday", "swing"] as const) {
    const decision = run({ series, quote: quoteFrom(series), mode });
    if (!decision.armed || !decision.plan) continue;
    const plan = decision.plan;
    if (plan.side === "buy") assert.ok(plan.sl < plan.trigger, "long stop below trigger");
    else assert.ok(plan.sl > plan.trigger, "short stop above trigger");
    assert.ok(
      !decision.rejections.some((reason) => /wrong side of entry/.test(reason)),
      decision.rejections.join(" | "),
    );
  }
});

// ── Mode bands are exclusive, and a data gap is not a bad market ─────────────

test("a scalp is scored on the sub-3-minute band only", () => {
  // Every frame except M5/M15/M30 is missing: the scalp band is untouched, so
  // the scalp must still be scored from S10/M1/M2/M3 data, and the slower
  // frames must not influence it.
  const scalpSeries: Partial<Record<Timeframe, Bar[]>> = {};
  for (const tf of ["S10", "S30", "M1", "M2", "M3"] as Timeframe[]) {
    scalpSeries[tf] = trendUp(220, 1.08, 0.0006, 0.0002, tf.length);
  }
  const decision = run({ series: scalpSeries, quote: quoteFrom(scalpSeries), mode: "scalp" });
  assert.ok(decision.confluence.score > 0, "the band must be scored");
  assert.ok(decision.confluence.scoredTimeframes.length >= 4, decision.confluence.scoredTimeframes.join(","));
  for (const timeframe of decision.confluence.scoredTimeframes) {
    assert.ok(
      ["S10", "S30", "M1", "M2", "M3"].includes(timeframe),
      `${timeframe} is outside the scalp band`,
    );
  }
  assert.equal(decision.confluence.substituted, false);
});

test("an empty band substitutes the nearest frames instead of scoring zero", () => {
  // Only M5 and M15 streamed: the scalp band has nothing, and the old code
  // returned confluence 0 — which is what produced "Quality 31.8 … (confluence
  // 0.0, evidence 57.9)" on the desk for a market whose sub-minute frames had
  // simply not been seeded yet.
  const partial: Partial<Record<Timeframe, Bar[]>> = {
    M5: trendUp(220, 1.08, 0.0006, 0.0002, 11),
    M15: trendUp(220, 1.08, 0.0006, 0.0002, 12),
  };
  const decision = run({ series: partial, quote: quoteFrom(partial), mode: "scalp" });
  assert.equal(decision.confluence.substituted, true);
  assert.ok(decision.confluence.score > 0, "a substitutable band must not score zero");
  assert.ok(
    decision.confluence.warnings.some((warning) => /nearest available frames were scored instead/.test(warning)),
    decision.confluence.warnings.join(" | "),
  );
});

// ── Costs are charged in R, identically on every asset class ─────────────────
//
// The desk used to hold every instrument to its own pair of spread ratios, and
// refused the ones that exceeded them. That is gone: the spread is charged
// inside the expectancy, the risk unit is floored above it, and the same 0.15R
// gate judges a forex scalp and a crypto CFD on the same unit — R.

test("a spread that was 43% of the stop no longer refuses the trade", () => {
  const series = allTimeframes((s) => trendUp(220, 1.08, 0.0006, 0.0002, s));
  // The intraday stop on this series is ~140 points, so 60 points of spread is
  // ~43% of the stop. Under the old rule that was a forex refusal.
  const wide = 60;
  const decision = run({ series, quote: quoteFrom(series, wide) });

  assert.ok(
    !decision.rejections.some((reason) => /ceiling/.test(reason)),
    `no asset-class ceiling may refuse this: ${decision.rejections.join(" | ")}`,
  );
  assert.ok(decision.costR !== null && decision.costR > 0.2, "the spread must be visible in R");

  // Crypto is not a special case any more — same rule, same unit.
  const cryptoSpec: SymbolSpec = { ...spec, symbol: "BTCUSD", assetClass: "crypto" };
  const cryptoSeries = allTimeframes((s) => trendUp(220, 20_000, 12, 4, s));
  const last = cryptoSeries.M15![cryptoSeries.M15!.length - 1][4];
  const crypto = run({
    series: cryptoSeries,
    spec: cryptoSpec,
    quote: {
      symbol: "BTCUSD",
      bid: last - (wide * cryptoSpec.point) / 2,
      ask: last + (wide * cryptoSpec.point) / 2,
      spreadPoints: wide,
      ts: Date.now(),
    },
  });
  assert.ok(
    !crypto.rejections.some((reason) => /ceiling/.test(reason)),
    `crypto must not inherit a forex ceiling: ${crypto.rejections.join(" | ")}`,
  );
});

test("a wide spread is charged in the simulation it gated on, and the widening is named", () => {
  const series = allTimeframes((s) => trendUp(220, 1.08, 0.0006, 0.0002, s));
  const decision = run({ series, quote: quoteFrom(series, 40) });
  // The cost is really charged in the simulation the gate read.
  assert.ok(decision.monteCarlo);
  assert.ok(
    decision.monteCarlo.expectancyR < decision.monteCarlo.grossExpectancyR,
    "expectancy after costs must be below the gross figure",
  );
  // 40 points of spread against a 140-point structural stop cannot be a risk
  // unit, so it is widened — out loud, with both distances in the message.
  assert.ok(
    decision.warnings.some((warning) => /Stop widened/.test(warning)),
    decision.warnings.join(" | "),
  );
  assert.ok(decision.costR !== null && decision.costR <= 0.25 + 1e-9, `costR ${decision.costR}`);
  assert.equal(decision.stopWidened, true);
});

// ── The risk unit, the horizon, and the number the gate actually reads ───────
//
// Three arithmetic faults stacked up behind the user's report — an A+ scalp on
// EURUSD.m refused with "Expectancy after costs is -1.55R (model -1.14R, gross
// -0.05R)" and "Spread 8 pts is 83% of the 10-pt stop":
//
//   1. the stop was resolved from the FASTEST frame the confluence happened to
//      score (S10) while the horizon was counted in the mode's own entry frame
//      (12 × M2 = 24 min), so the stop sat inside the noise of the trade;
//   2. the same stop could be smaller than the round-trip spread, which makes
//      "one R" smaller than the price of getting in — expectancy can then never
//      clear any positive threshold, on any setup;
//   3. the blended expectancy was recomputed as p·RR − (1−p) − costR, charging
//      every path that ends at the time stop as a FULL −1R. A plan whose stop
//      and target are both wider than the horizon resolves at the horizon, so
//      most of its paths end that way, and the formula manufactured the
//      negative number the gate then refused.

test("a scalp's stop, horizon and report all describe the SAME frame", () => {
  const series = allTimeframes((s) => trendDown(220, 1.08, s));
  const decision = run({ series, quote: quoteFrom(series), mode: "scalp" });

  // The mode's own entry frame, never the fastest scored one.
  assert.equal(decision.entryTimeframe, "M1", "a scalp is measured on its entry frame");
  assert.equal(decision.horizonMinutes, 5, "five M1 bars is the five-minute hold the pane shows");
});

test("the risk unit is never smaller than the round trip that pays for it", () => {
  const series = allTimeframes((s) => trendDown(220, 1.08, s));
  const decision = run({ series, quote: quoteFrom(series), mode: "scalp" });

  assert.ok(decision.costR !== null);
  assert.ok(decision.costR > 0, "a real market has a real cost");
  assert.ok(decision.costR <= 0.25 + 1e-9, `cost must fit inside the risk unit, costR ${decision.costR}`);
  if (decision.plan) {
    const riskPoints = Math.abs(decision.plan.trigger - decision.plan.sl) / spec.point;
    // 4 × cost, EXACTLY the floor MIN_COST_COVERAGE promises.
    const costPoints = (decision.costR ?? 0) * riskPoints;
    assert.ok(riskPoints >= 4 * costPoints - 1e-6, `${riskPoints} pts of risk against ${costPoints} pts of cost`);
    assert.ok(riskPoints > 10, "the 8-point spread must not be the whole stop");
  }
  // A stop that had to be widened says so — it is never a silent change of plan.
  if (decision.stopWidened) {
    assert.ok(
      decision.warnings.some((warning) => /Stop widened/.test(warning)),
      decision.warnings.join(" | "),
    );
  }
});

test("the expectancy the gate reads IS the simulation's expectancy", () => {
  // With no realised history blended in (the fixtures pass none), the gate must
  // agree with the Monte Carlo it just ran. The old re-derivation disagreed by
  // design, and that disagreement was always in the pessimistic direction.
  for (const mode of ["scalp", "intraday", "swing"] as const) {
    const series = allTimeframes((s) => trendDown(220, 1.08, s));
    const decision = run({ series, quote: quoteFrom(series), mode });
    assert.ok(decision.monteCarlo, `${mode} must reach the simulation`);
    assert.ok(decision.expectancyR !== null);
    assert.ok(
      Math.abs(decision.expectancyR - decision.monteCarlo.expectancyR) < 0.02,
      `${mode}: gate read ${decision.expectancyR}, simulation said ${decision.monteCarlo.expectancyR}`,
    );
  }
});

test("paths that end at the time stop are priced, not written off as losses", () => {
  const series = allTimeframes((s) => trendDown(220, 1.08, s));
  const decision = run({ series, quote: quoteFrom(series), mode: "scalp" });
  const mc = decision.monteCarlo!;
  // The old formula assumed every non-win is a −1R. Whenever timed-out paths
  // end in profit on average, the true expectancy must be BETTER than that.
  if (mc.timeoutProbability > 0.05 && mc.timeoutMeanR > 0) {
    const naive = mc.winProbability * mc.rewardRisk - (1 - mc.winProbability);
    assert.ok(
      decision.expectancyR! > naive,
      `timeouts were written off: E ${decision.expectancyR} vs naive ${naive}`,
    );
  }
  // …and the split is reported, so a refusal can be read rather than guessed at.
  assert.ok(mc.lossProbability + mc.winProbability + mc.timeoutProbability > 0.999);
});

// ── Noise and unmeasurable inputs ────────────────────────────────────────────

/** A random walk with an optional per-bar drift. With no drift, the market has no edge by construction. */
function randomWalk(count: number, start: number, sigma: number, seed: number, drift = 0): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const u1 = Math.max(1e-12, rng());
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
    price = open * Math.exp(drift + sigma * z);
    const high = Math.max(open, price) * (1 + sigma * rng() * 0.5);
    const low = Math.min(open, price) * (1 - sigma * rng() * 0.5);
    bars.push([i * 60_000, open, high, low, price, 100]);
  }
  return bars;
}

test("an unmeasurable trading cost is refused, never armed", () => {
  // NaN compares false against everything, so a NaN cost used to slip past the
  // expectancy gate. It must be named and refused instead.
  const decision = run({ spec: { ...spec, commissionPerLot: Number.NaN } });
  assert.equal(decision.armed, false);
  assert.ok(
    decision.rejections.some((r) => /cannot be measured/.test(r)),
    decision.rejections.join(" | "),
  );
});

test("noise does not manufacture an edge: driftless walks arm almost nothing", () => {
  let armed = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const bars = randomWalk(400, 1.08, 0.0005, seed * 7 + 3);
    const series = allTimeframes(() => bars);
    if (run({ series, quote: quoteFrom(series), mode: "intraday" }).armed) armed++;
  }
  assert.ok(armed <= 2, `${armed}/20 driftless windows armed a plan`);
});
