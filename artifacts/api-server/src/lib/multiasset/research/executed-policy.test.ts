/**
 * WP2 — executed-policy simulator tests.
 *
 * The simulator is the part of the harness that decides whether a claim about
 * a strategy is a claim about the market or a claim about arithmetic. Three
 * properties are load-bearing and are tested directly:
 *
 *   1. NO LOOKAHEAD — a decision at time t is byte-identical when the future is
 *      replaced with something else entirely (prefix replay).
 *   2. THE PESSIMISTIC RESOLUTION — when a stop and a target are both inside
 *      one bar, the stop is taken. Assuming the target is how a backtest
 *      manufactures a win rate the live account then fails to reproduce.
 *   3. THE PLAN IS WHAT IS SIMULATED — the real position-manager state machine
 *      runs on every bar close, and its partials/breakeven/time stop change the
 *      realised R accordingly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEntry, simulatePlan, causalAtrSeries } from "./executed-policy";
import { closedBarsAt, legacyDeskStrategy, runHarness, type Strategy } from "./harness";
import { generate } from "./generators";
import { specForSymbol } from "./specs";
import { evaluate, type AgentInput } from "../agent";
import { createRiskState } from "../risk";
import type { ArmedPlan, Bar, ManagementPlan, SymbolSpec } from "../types";

const { spec } = specForSymbol("EURUSD", { spreadPoints: 10, commissionPerLot: 0 });

function bar(ts: number, o: number, h: number, l: number, c: number): Bar {
  return [ts, o, h, l, c, 100];
}

function basePlan(overrides: Partial<ArmedPlan> = {}): ArmedPlan {
  return {
    id: "plan-1",
    symbol: "EURUSD",
    side: "buy",
    mode: "intraday",
    trigger: 1.10000,
    triggerType: "market",
    confirmTicks: 1,
    invalidate: 1.09500,
    sl: 1.09800,
    tp: [1.10400],
    lots: 0.1,
    riskMoney: 100,
    riskPoints: 200,
    maxSpreadPoints: 20,
    maxSlippagePoints: 5,
    expiresAt: Number.MAX_SAFE_INTEGER,
    createdAt: 0,
    management: managementPlan(),
    rationale: {
      confluenceScore: 70,
      grade: "A",
      regime: "trending",
      winProbability: 0.5,
      expectancyR: 0.3,
      rewardRisk: 2,
      markovPersistence: 0.5,
      factors: [],
      warnings: [],
    },
    ...overrides,
  };
}

function managementPlan(overrides: Partial<ManagementPlan> = {}): ManagementPlan {
  return {
    breakeven: null,
    partials: [],
    trail: null,
    pyramid: null,
    timeStop: null,
    guards: { maxSpreadPoints: 20, newsBlackoutMin: 15, flatBeforeSessionClose: false },
    ...overrides,
  };
}

const START = Date.UTC(2026, 0, 5, 0, 0, 0);
const W = 15 * 60_000;

// ── 1. Prefix replay: no lookahead ──────────────────────────────────────────

test("a decision at time t is identical when every later bar is replaced", () => {
  const full = generate("driftless", { seed: 4242, bars: 400, timeframeMs: W, startMs: START }).bars;
  const cut = 220;
  // The prefix is the SAME bars; everything after `cut` is different data.
  const mutated: Bar[] = full.slice(0, cut + 1).concat(
    generate("driftless", { seed: 999, bars: 180, timeframeMs: W, startMs: full[cut][0] + W }).bars,
  );

  const frameOf = (bars: Bar[]): Partial<Record<"M15", Bar[]>> => ({ M15: bars });
  const first = probeDecisions(frameOf(full));
  const second = probeDecisions(frameOf(mutated));

  assert.ok(first.size > 20, `expected a meaningful number of decisions, got ${first.size}`);
  for (const [now, decision] of first) {
    if (now > full[cut][0]) continue; // past the cut, the two series ARE different
    assert.equal(
      second.get(now),
      decision,
      `the decision at ${new Date(now).toISOString()} changed when the FUTURE changed — that is lookahead`,
    );
  }
});

test("closed bars only: a bar becomes visible when its own width has elapsed", () => {
  const bars = [bar(START, 1, 1, 1, 1), bar(START + W, 2, 2, 2, 2), bar(START + 2 * W, 3, 3, 3, 3)];
  // Mid-way through the second bar: only the first has closed.
  assert.equal(closedBarsAt(bars, W, START + W + 5 * 60_000).length, 1);
  // Exactly at the close of the second bar it becomes visible.
  assert.equal(closedBarsAt(bars, W, START + 2 * W).length, 2);
  assert.equal(closedBarsAt(bars, W, START).length, 0);
});

/** Arm decisions per decision time, with the risk state reset each time. */
function probeDecisions(frames: Partial<Record<"M15", Bar[]>>): Map<number, string> {
  const seen = new Map<number, string>();
  const probe: Strategy = {
    id: "probe",
    decide(ctx) {
      const input: AgentInput = {
        symbol: ctx.symbol,
        mode: ctx.mode,
        spec: ctx.spec,
        quote: ctx.quote,
        series: ctx.series,
        account: ctx.account,
        positions: [],
        specs: new Map([[ctx.symbol, ctx.spec]]),
        // Reset per decision: this test isolates the price pipeline, so the
        // only channel that may carry information across decisions is the bars.
        riskState: createRiskState(),
        now: ctx.now,
      };
      const decision = evaluate(input);
      // The plan id is a fresh UUID on every call (by design — two decisions are
      // two plans); everything else must be identical when the future is not.
      seen.set(
        ctx.now,
        decision.armed && decision.plan ? JSON.stringify({ ...decision.plan, id: "id" }) : "-",
      );
      return null;
    },
  };
  runHarness({ frames, symbol: "EURUSD", strategy: probe, options: { spec, mode: "intraday", stride: 5, warmupBars: 80 } });
  return seen;
}

// ── 2. Entry resolution ─────────────────────────────────────────────────────

test("a break entry fills at the worse of the trigger and the bar's open, plus the spread", () => {
  const trigger = 1.10000;
  const plan = basePlan({ trigger, triggerType: "break", sl: 1.09800, tp: [1.10500] });
  // The bar gaps 30 points through the trigger: the fill is the OPEN, not the
  // level the plan was hoping for.
  const gapped = [bar(START, 1.10000, 1.10010, 1.09990, 1.10000), bar(START + W, 1.10030, 1.10090, 1.10020, 1.10080)];
  const resolved = resolveEntry({ plan, bars: gapped, decisionIndex: 0, spec, options: { spec } });
  const spread = spec.spreadPoints * spec.point;
  assert.equal(resolved?.index, 1);
  assert.ok(Math.abs(((resolved?.price as number) - (1.10030 + spread))) < 1e-9, `got ${resolved?.price}`);

  // A bar that only touches the trigger from below fills AT the trigger.
  const touched = [bar(START, 1.09990, 1.09995, 1.09985, 1.09990), bar(START + W, 1.09995, 1.10005, 1.09990, 1.10002)];
  const second = resolveEntry({ plan, bars: touched, decisionIndex: 0, spec, options: { spec } });
  assert.ok(Math.abs(((second?.price as number) - (trigger + spread))) < 1e-9, `got ${second?.price}`);
});

test("an unfilled plan that never trades through its trigger returns nothing", () => {
  const plan = basePlan({ trigger: 1.20000, triggerType: "break", sl: 1.19500, invalidate: 1.19000 });
  const bars = [...Array(20)].map((_, i) => bar(START + i * W, 1.10000, 1.10050, 1.09950, 1.10000));
  assert.equal(resolveEntry({ plan, bars, decisionIndex: 0, spec, options: { spec } }), null);
});

// ── 3. Stop wins the tie ────────────────────────────────────────────────────

test("when one bar contains both the stop and the target, the STOP is taken", () => {
  // Risk 20 points, target 40 points. The second bar spans both.
  const plan = basePlan({ triggerType: "market", sl: 1.09800, tp: [1.10500], management: managementPlan() });
  const bars = [
    bar(START, 1.10000, 1.10000, 1.10000, 1.10000),
    bar(START + W, 1.10000, 1.10600, 1.09700, 1.10000),
    bar(START + 2 * W, 1.10000, 1.10300, 1.10000, 1.10200),
  ];
  const atrSeries = causalAtrSeries(bars, 14);
  const result = simulatePlan({ plan, bars, decisionIndex: 0, spec, options: { spec, spreadPoints: [0, 0, 0] }, atrSeries, horizonBars: 5 });
  assert.ok(result.trade);
  assert.equal(result.trade.exitReason, "stop");
  // 20 points of risk given up, with no slippage configured.
  assert.ok(result.trade.r < -0.9 && result.trade.r > -1.1, `expected about −1R, got ${result.trade.r}`);
});

test("mark-to-market at the horizon is charged the spread, never the mid", () => {
  const plan = basePlan({ triggerType: "market", sl: 1.09800, tp: [1.20000] });
  const bars = [...Array(10)].map((_, i) => bar(START + i * W, 1.10000, 1.10010, 1.09990, 1.10000));
  const result = simulatePlan({
    plan,
    bars,
    decisionIndex: 0,
    spec,
    options: { spec, spreadPoints: bars.map(() => 10) },
    atrSeries: causalAtrSeries(bars, 14),
    horizonBars: 5,
  });
  assert.ok(result.trade);
  assert.equal(result.trade.exitReason, "horizon");
  // A flat market must cost the spread, not break even.
  assert.ok(result.trade.r < 0, `a flat market with a spread must lose (got ${result.trade.r})`);
});

// ── 4. Management actually runs ─────────────────────────────────────────────

test("the plan's time stop closes a position that made no progress", () => {
  const plan = basePlan({
    triggerType: "market",
    sl: 1.09600,
    tp: [1.11000],
    management: managementPlan({ timeStop: { noProgressBars: 6, timeframe: "M15" } }),
  });
  // 20 flat bars: the stop is never threatened, the target never approached.
  const bars = [...Array(20)].map((_, i) => bar(START + i * W, 1.10000, 1.10020, 1.09980, 1.10000));
  const result = simulatePlan({
    plan,
    bars,
    decisionIndex: 0,
    spec,
    options: { spec, spreadPoints: bars.map(() => 10) },
    atrSeries: causalAtrSeries(bars, 14),
    horizonBars: 30,
  });
  assert.ok(result.trade);
  assert.equal(result.trade.exitReason, "time_stop");
  assert.ok(result.trade.bars <= 8, `the time stop fired after ${result.trade.bars} bars`);
  assert.ok(result.trade.r < 0, "a trade that went nowhere pays the spread");
});

test("a rung that gets hit closes part of the position, and the rest keeps running", () => {
  const plan = basePlan({
    triggerType: "market",
    sl: 1.09800,
    tp: [1.10800],
    management: managementPlan({ partials: [{ atR: 1, closePct: 50 }] }),
  });
  // The decision is taken on bar 0; a market order fills on bar 1's OPEN, so
  // the R unit is measured from that fill (|1.10000 − 1.09800|), not from the
  // decision bar's close.
  const bars = [
    bar(START, 1.10000, 1.10000, 1.10000, 1.10000),
    bar(START + W, 1.10000, 1.10300, 1.09990, 1.10260), // closes at +1.3R: the rung fires
    bar(START + 2 * W, 1.10260, 1.10850, 1.10200, 1.10800), // then runs to the target
  ];
  const result = simulatePlan({
    plan,
    bars,
    decisionIndex: 0,
    spec,
    options: { spec, spreadPoints: bars.map(() => 0) },
    atrSeries: causalAtrSeries(bars, 14),
    horizonBars: 5,
  });
  assert.ok(result.trade);
  assert.equal(result.trade.partialFills, 1, "one rung must have been closed");
  assert.equal(result.trade.exitReason, "target");
  // Half at the rung price (+1.3R) and half at the target (+4R).
  assert.ok(
    Math.abs(result.trade.r - (0.5 * 1.3 + 0.5 * 4)) < 1e-9,
    `expected 2.65R (half at +1.3R, half at +4R), got ${result.trade.r}`,
  );
});

// ── 5. Costs ────────────────────────────────────────────────────────────────

test("commission is charged in R, exactly", () => {
  // A commission-bearing contract: 7 account-currency units per lot round trip.
  const commissioned = specForSymbol("EURUSD", { spreadPoints: 0, commissionPerLot: 7 }).spec;
  const bars = [
    bar(START, 1.10000, 1.10000, 1.10000, 1.10000),
    bar(START + W, 1.10000, 1.10060, 1.09990, 1.10050),
  ];
  const plan = basePlan({ triggerType: "market", sl: 1.09800, tp: [1.10400] });
  const costs = simulatePlan({
    plan,
    bars,
    decisionIndex: 0,
    spec: commissioned,
    options: { spec: commissioned, spreadPoints: bars.map(() => 0) },
    atrSeries: causalAtrSeries(bars, 14),
    horizonBars: 3,
  });
  // riskPrice = 0.00200 in a 5-digit symbol; 7 account-currency units per lot
  // round trip on a 100,000-unit contract is 7 / (200 points x $1 per point).
  const expected = (7 * commissioned.tickSize) / (0.002 * commissioned.tickValue);
  assert.ok(Number.isFinite(expected) && expected > 0);
  assert.ok(
    Math.abs((costs.trade?.costR as number) - expected) < 1e-12,
    `costR ${costs.trade?.costR} should equal ${expected}`,
  );
  // And a commission-free run of the same trade must differ by exactly that.
  // An explicit commissionPrice of 0 overrides the contract's commission, and
  // the two runs must then differ by exactly costR.
  const free = simulatePlan({
    plan,
    bars,
    decisionIndex: 0,
    spec: commissioned,
    options: { spec: commissioned, spreadPoints: bars.map(() => 0), commissionPrice: 0 },
    atrSeries: causalAtrSeries(bars, 14),
    horizonBars: 3,
  });
  assert.ok(Number.isFinite(free.trade?.r));
  assert.ok(
    Math.abs((free.trade?.r as number) - (costs.trade?.r as number) - expected) < 1e-12,
    `free ${free.trade?.r} vs charged ${costs.trade?.r}, expected a difference of ${expected}`,
  );
});

test("slippage is charged at entry and again when the stop is filled", () => {
  const slip = 2 * spec.point;
  const bars = [
    bar(START, 1.10000, 1.10000, 1.10000, 1.10000),
    bar(START + W, 1.10000, 1.10050, 1.09750, 1.09800), // runs through the stop
  ];
  const plan = basePlan({ triggerType: "market", sl: 1.09800, tp: [1.10400] });
  const result = simulatePlan({
    plan,
    bars,
    decisionIndex: 0,
    spec,
    options: { spec, spreadPoints: bars.map(() => 0), slippagePrice: slip },
    atrSeries: causalAtrSeries(bars, 14),
    horizonBars: 3,
  });
  // The fill is 2 points worse (1.10020), so the stop distance is 22 points and
  // the R unit is measured from the FILL — that is the whole point of measuring
  // reward:risk at the expected fill. The stop itself then slips another 2
  // points, so the loss is (22 + 2)/22 = 1.0909R rather than a tidy −1R.
  const fill = 1.10000 + slip;
  const riskPrice = fill - 1.09800;
  const expected = -((riskPrice + slip) / riskPrice);
  assert.ok(result.trade);
  assert.equal(result.trade.exitReason, "stop");
  assert.ok(
    Math.abs((result.trade.r as number) - expected) < 1e-9,
    `expected ${expected.toFixed(4)}R, got ${result.trade.r}`,
  );
  assert.ok(Math.abs((result.trade.entryPrice as number) - fill) < 1e-12);
});

// ── 6. Determinism ──────────────────────────────────────────────────────────

test("the simulator is deterministic: same inputs, same trade", () => {
  const generated = generate("positive-control", { seed: 77, bars: 500, timeframeMs: W, startMs: START }).bars;
  const options = { spec, mode: "intraday" as const, stride: 20, warmupBars: 100, horizonBars: 25 };
  const a = runHarness({ frames: { M15: generated }, symbol: "EURUSD", strategy: legacyDeskStrategy("desk-v3"), options });
  const b = runHarness({ frames: { M15: generated }, symbol: "EURUSD", strategy: legacyDeskStrategy("desk-v3"), options });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.evaluations > 10);
});
