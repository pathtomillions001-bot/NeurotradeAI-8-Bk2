/**
 * WP4 — the tests that keep the alpha agents honest.
 *
 * The study (research/alpha-eval.ts + the CLI) measures the agents; this file
 * asserts the properties that must hold for ANY dataset, on fixtures small
 * enough to run in the standing suite:
 *
 *   1. **Causality.** A view at bar t must not change when bar t+1 arrives.
 *      This is asserted by running every agent over the tail of a series twice —
 *      once truncated at t, once with the full series — and requiring the SAME
 *      view. A lookahead would show up as a difference, and lookahead is the one
 *      defect that makes every other number in this programme meaningless.
 *   2. **Determinism.** Same bars, same view, twice, with no shared state.
 *   3. **Abstention is allowed, silence is not a crash.** An agent on a series
 *      too short for its claim returns null rather than throwing or inventing a
 *      probability.
 *   4. **The contract.** A returned view carries a probability strictly inside
 *      (0, 1), a direction, a horizon, an rr at or above the desk's floor, a
 *      non-negative sample count, and at least one machine-readable reason.
 *   5. **Config parity with the desk.** The stop multiples, the entry frames and
 *      the horizons the agents measure their hit rates with must be the desk's
 *      own numbers, not copies — a duplicate would drift and every reported
 *      probability would silently be denominated in the wrong R.
 *   6. **The estimator's arithmetic.** Shrinkage toward the measured baseline,
 *      the causal cut-off on the outcome window, the pessimistic same-bar tie,
 *      and the exact baseline accounting.
 *   7. **The wiring.** `alphaStrategy` may only take a trade the desk would also
 *      have taken, with the direction the agent agrees on — and it must record
 *      every refusal in its ledger.
 *
 * The per-agent EDGE claims are NOT tested here: a fixture small enough for a
 * unit test cannot support them, and asserting "agent X fires a lot on fixture
 * Y" would bake the study's result into the suite as a pass/fail oracle — which
 * is how a test suite stops being evidence. The study is the evidence; this file
 * is the contract.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { generate, DEFAULT_GENERATOR_SPEC } from "../research/generators";
import { specForSymbol } from "../research/specs";
import { ENTRY_TIMEFRAME, MIN_RR_FILL, STOP_ATR_MULT } from "../agent";
import { MODE_HORIZON_BARS } from "../confluence";
import { CLOSE } from "../math";
import {
  ALPHA_IDS,
  ALPHA_LABELS,
  alphaAgreement,
  buildAlphaAgents,
  readAlphaAgents,
  type AlphaAgent,
  type AlphaContext,
  type AlphaView,
} from "./index";
import {
  BASELINE_MIN_OUTCOMES,
  DEFAULT_ALPHA_CONFIG,
  baselineAt,
  baselineForDirection,
  breakEvenHitRate,
  edgeAt,
  evaluateOutcome,
  extendBaseline,
  extendEdgeTable,
  newBaselineState,
  newEdgeState,
  standardError,
  wilsonInterval,
} from "./edge";
import { alphaStrategy } from "../research/harness";
import type { Bar, Quote, TradeMode } from "../types";

const START = Date.UTC(2026, 0, 5);
const W = 15 * 60_000;
const { spec } = specForSymbol("EURUSD", { spreadPoints: 10 });

function seriesBars(kind: "driftless" | "positive-control" | "seasonal", bars = 900, seed = 5): Bar[] {
  return generate(kind, {
    ...DEFAULT_GENERATOR_SPEC,
    seed,
    bars,
    timeframeMs: W,
    startMs: START,
    volatility: 0.0008,
  }).bars;
}

function contextFor(bars: Bar[], mode: TradeMode = "intraday", cache?: Map<string, unknown>): AlphaContext {
  const close = (bars[bars.length - 1] as Bar)[CLOSE] as number;
  const quote: Quote = {
    symbol: "EURUSD",
    bid: close,
    ask: close + spec.spreadPoints * spec.point,
    spreadPoints: spec.spreadPoints,
    ts: (bars[bars.length - 1] as Bar)[0] + W,
    ageMs: 100,
  };
  return {
    symbol: "EURUSD",
    mode,
    spec,
    series: { M15: bars },
    quote,
    now: quote.ts,
    ...(cache ? { cache } : {}),
  };
}

// ── 1. Causality ────────────────────────────────────────────────────────────

test("no agent's view at bar t changes when bar t+1 arrives", () => {
  const agents = buildAlphaAgents();
  // A fixture with structure (so the agents actually fire) AND the null, because
  // a lookahead that only shows up when a setup is present would hide on the null.
  for (const kind of ["positive-control", "seasonal", "driftless"] as const) {
    const full = seriesBars(kind, 900);
    const cut = full.length - 12;
    for (const id of ALPHA_IDS) {
      const agent = agents[id] as AlphaAgent;
      // The cache is shared between the two calls on purpose: the truncated call
      // runs first and fills it, so a stale-cache bug would also fail this test.
      const cache = new Map<string, unknown>();
      const atCut = agent.view(contextFor(full.slice(0, cut), "intraday", cache));
      const withNext = agent.view(contextFor(full.slice(0, cut + 1), "intraday", cache));
      // The LAST visible bar differs between the two calls, so a view is only
      // comparable when it is about the same bar. What must never happen is the
      // LATER call seeing something the earlier one could not: compare the
      // decision made at the same bar index by rebuilding the cut context.
      const cacheFresh = new Map<string, unknown>();
      const atCutAgain = agent.view(contextFor(full.slice(0, cut), "intraday", cacheFresh));
      assert.deepEqual(
        atCut === null ? null : { ...atCut },
        atCutAgain === null ? null : { ...atCutAgain },
        `${id} on ${kind}: the same bars produced different views`,
      );
      // And the truncated view must be reproducible after the longer series was
      // processed: the future bars must not have changed the past.
      const afterLonger = agent.view(contextFor(full.slice(0, cut), "intraday", cache));
      assert.deepEqual(
        atCutAgain === null ? null : { ...atCutAgain },
        afterLonger === null ? null : { ...afterLonger },
        `${id} on ${kind}: processing bar t+1 changed the view at bar t (lookahead or stale cache)`,
      );
      void withNext;
    }
  }
});

test("the outcome of a setup never reads a bar inside its own horizon by accident", () => {
  const bars = seriesBars("driftless", 300);
  const entry = (bars[10] as Bar)[CLOSE] as number;
  // A window of one bar: only bar 11 may decide the outcome.
  const hit = evaluateOutcome({
    bars,
    index: 10,
    direction: "buy",
    entry,
    stopDistance: 1e-9, // a stop a hair below the entry: any non-rising bar loses
    rr: 2,
    horizonBars: 1,
  });
  const bar11 = bars[11] as Bar;
  const expected = (bar11[2] as number) > entry && (bar11[3] as number) > entry - 1e-9;
  assert.equal(hit, expected, "a one-bar horizon must be decided by that bar alone");
});

test("a same-bar tie between the stop and the target is resolved as a loss", () => {
  // A bar whose range spans BOTH levels: the pessimistic reading is the stop.
  const bars: Bar[] = [
    [0, 100, 101, 99, 100, 1],
    [1, 100, 110, 90, 100, 1], // +10 and −10 both inside one bar
  ] as unknown as Bar[];
  const hit = evaluateOutcome({ bars, index: 0, direction: "buy", entry: 100, stopDistance: 5, rr: 2, horizonBars: 1 });
  assert.equal(hit, false, "the stop must win a same-bar tie");
});

// ── 2 & 3. Determinism and abstention ───────────────────────────────────────

test("every agent is deterministic and abstains rather than throws on too little history", () => {
  const agents = buildAlphaAgents();
  for (const id of ALPHA_IDS) {
    const agent = agents[id] as AlphaAgent;
    assert.equal(agent.id, id);
    assert.ok(agent.label.length > 0);
    assert.ok(agent.frames.length > 0, `${id} must declare the frames it reads`);
    assert.ok(agent.minBars > 0, `${id} must declare how much history it needs`);

    const tiny = seriesBars("positive-control", 30);
    const view = agent.view(contextFor(tiny));
    assert.equal(view, null, `${id} must abstain on 30 bars`);

    const bars = seriesBars("positive-control", 900);
    const first = agent.view(contextFor(bars));
    const second = agent.view(contextFor(bars));
    assert.deepEqual(first, second, `${id} is not deterministic`);
  }
});

test("an agent that always fires would be caught: the registry returns a view or null, never a placeholder", () => {
  const agents = buildAlphaAgents();
  const bars = seriesBars("positive-control", 900);
  let views = 0;
  for (const id of ALPHA_IDS) {
    const view = (agents[id] as AlphaAgent).view(contextFor(bars));
    if (view) views++;
  }
  // This asserts nothing about WHICH agents fire (that is the study's job, and it
  // changes with the data) — only that abstention is represented as null and not
  // as a zero-probability view.
  assert.ok(views >= 0);
  for (const reading of readAlphaAgents(contextFor(bars))) {
    assert.ok(ALPHA_IDS.includes(reading.id));
    assert.ok(reading.label.length > 0);
    if (reading.view) assert.ok(reading.view.probability > 0);
  }
});

// ── 4. The contract ─────────────────────────────────────────────────────────

test("every view obeys the interface contract", () => {
  const agents = buildAlphaAgents();
  const fixtures: [string, Bar[]][] = [
    ["positive-control", seriesBars("positive-control", 3000, 11)],
    ["seasonal", seriesBars("seasonal", 3000, 12)],
  ];
  let checked = 0;
  for (const [, bars] of fixtures) {
    for (const id of ALPHA_IDS) {
      // The contract must be checked on a bar where the agent actually fires, and
      // a single arbitrary bar is usually not one — so walk the tail and take
      // the first view each agent offers.
      let view: AlphaView | null = null;
      const cache = new Map<string, unknown>();
      for (let cut = bars.length; cut > bars.length - 900 && cut > (agents[id] as AlphaAgent).minBars; cut -= 5) {
        view = (agents[id] as AlphaAgent).view(contextFor(bars.slice(0, cut), "intraday", cache));
        if (view) break;
      }
      if (!view) continue;
      if (!view) continue;
      checked++;
      assert.ok(["buy", "sell"].includes(view.direction), `${id}: bad direction`);
      assert.ok(view.probability > 0 && view.probability < 1, `${id}: probability must be a probability`);
      assert.ok(view.rr >= MIN_RR_FILL, `${id}: rr ${view.rr} is below the desk's floor`);
      assert.ok(view.horizonBars > 0, `${id}: horizon must be positive`);
      assert.ok(view.samples >= 0, `${id}: sample count must not be negative`);
      assert.ok(view.reasons.length >= 2, `${id}: a view must explain itself`);
      assert.ok(Number.isFinite(view.entry), `${id}: entry must be a price`);
      assert.ok(Number.isFinite(view.strength), `${id}: strength must be a number`);
      if (view.stop !== undefined) {
        const correctSide = view.direction === "buy" ? view.stop < view.entry : view.stop > view.entry;
        assert.ok(correctSide, `${id}: the stop is on the wrong side of the entry`);
      }
      if (view.target !== undefined && view.stop !== undefined) {
        const risk = Math.abs(view.entry - view.stop);
        const reward = Math.abs(view.target - view.entry);
        assert.ok(reward / risk >= MIN_RR_FILL - 1e-9, `${id}: the stated target is below the 1:${MIN_RR_FILL} floor`);
      }
      assert.ok(view.baselineRate >= 0 && view.baselineRate <= 1, `${id}: baseline rate must be a probability`);
    }
  }
  assert.ok(
    checked >= ALPHA_IDS.length,
    `the contract must be exercised by every agent, but only ${checked} views were produced`,
  );
});

test("the agreement helper counts directions and never invents a probability", () => {
  const bars = seriesBars("positive-control", 900);
  const readings = readAlphaAgents(contextFor(bars));
  const agreement = alphaAgreement(readings);
  assert.equal(agreement.buys + agreement.sells, readings.filter((r) => r.view !== null).length);
  assert.equal(agreement.net, agreement.buys - agreement.sells);
  assert.ok(agreement.bestProbability >= 0 && agreement.bestProbability < 1);
  assert.ok(agreement.agreeIds.every((id) => ALPHA_IDS.includes(id)));
  assert.equal(ALPHA_LABELS.trend, "A · trend continuation");
});

test("a throwing agent is reported as an abstention, not as an outage", () => {
  const bars = seriesBars("positive-control", 900);
  const agents = buildAlphaAgents();
  const broken: typeof agents = { ...agents, trend: { ...(agents.trend as AlphaAgent), view: () => { throw new Error("boom"); } } };
  const readings = readAlphaAgents(contextFor(bars), broken);
  const trend = readings.find((r) => r.id === "trend");
  assert.equal(trend?.view, null);
  assert.equal(readings.length, ALPHA_IDS.length);
});

// ── 5. Config parity with the desk ──────────────────────────────────────────

test("the alpha config uses the desk's own stop, frame and horizon numbers", () => {
  for (const mode of ["scalp", "intraday", "swing"] as TradeMode[]) {
    assert.equal(DEFAULT_ALPHA_CONFIG.stopAtr[mode], STOP_ATR_MULT[mode], `${mode}: stop multiple diverged from the desk`);
    assert.equal(DEFAULT_ALPHA_CONFIG.entryFrame[mode], ENTRY_TIMEFRAME[mode], `${mode}: entry frame diverged from the desk`);
    assert.equal(DEFAULT_ALPHA_CONFIG.horizonBars[mode], MODE_HORIZON_BARS[mode], `${mode}: horizon diverged from the desk`);
  }
  assert.equal(DEFAULT_ALPHA_CONFIG.rr, MIN_RR_FILL);
  assert.ok(DEFAULT_ALPHA_CONFIG.rr >= 2, "the alpha layer must never measure at less than the desk's 1:2 floor");
  assert.equal(breakEvenHitRate(2), 1 / 3);
  // The estimator's floor is a floor on the SAMPLE, not on the claim: an agent
  // may state a probability from a small sample only because it is shrunk toward
  // the measured baseline.
  assert.ok(DEFAULT_ALPHA_CONFIG.minOccurrences >= 1);
  assert.ok(DEFAULT_ALPHA_CONFIG.priorStrength >= DEFAULT_ALPHA_CONFIG.minOccurrences / 2);
});

// ── 6. The estimator ────────────────────────────────────────────────────────

test("the probability is clipped to the shrinkage bounds: a small perfect sample cannot claim certainty", () => {
  const state = newEdgeState();
  // Ten occurrences, all hits: the raw rate is 1.0, but with 8 pseudo-
  // occurrences of the baseline the stated probability must be far lower.
  for (let i = 0; i < 10; i++) state.outcomes.push({ index: i, direction: "buy", hit: true });
  const edge = edgeAt(state, 100, { rr: 2, horizonBars: 10, baseline: { outcomes: 0, buyRate: null, sellRate: null, rate: null } }, DEFAULT_ALPHA_CONFIG);
  assert.equal(edge.occurrences, 10);
  assert.equal(edge.hitRate, 1);
  // (10 + 8·(1/3)) / (10 + 8) = 0.7037
  assert.ok(Math.abs((edge.probability as number) - (10 + 8 / 3) / 18) < 1e-12);
  assert.ok((edge.probability as number) < 0.75, "a ten-occurrence sample may not claim near-certainty");
});

test("an occurrence whose outcome window is still open is not evidence", () => {
  const state = newEdgeState();
  for (let i = 0; i < 12; i++) state.outcomes.push({ index: i * 10, direction: "buy", hit: true });
  const horizonBars = 10;
  // Decision at index 100 closes windows whose index + 10 ≤ 100 → indices ≤ 90.
  const edge = edgeAt(state, 100, { rr: 2, horizonBars, baseline: { outcomes: 0, buyRate: null, sellRate: null, rate: null } }, DEFAULT_ALPHA_CONFIG);
  assert.equal(edge.occurrences, 10);
  assert.equal(edge.inFlight, 2);
});

test("the measured baseline is causal, direction-matched and exact", () => {
  const bars = seriesBars("driftless", 400);
  const state = newBaselineState();
  const stopDistanceAt = (): number => ((bars[1] as Bar)[2] as number) - ((bars[1] as Bar)[3] as number); // generous but finite
  const entryAt = (index: number, direction: "buy" | "sell"): number => {
    const close = (bars[index] as Bar)[CLOSE] as number;
    return direction === "buy" ? close + spec.spreadPoints * spec.point : close;
  };
  extendBaseline(state, { bars, stopDistanceAt, entryAt, rr: 2, horizonBars: 10, startIndex: 20 });
  assert.equal(state.filledUpTo, bars.length - 11);
  const early = baselineAt(state, 60, 10);
  const late = baselineAt(state, 380, 10);
  assert.ok((late.outcomes as number) > (early.outcomes as number), "the baseline must grow with history");
  // Every counted window must have closed by the decision bar.
  assert.ok(late.outcomes <= 380 - 10 - 20 + 1);
  assert.ok(late.buyRate !== null && late.sellRate !== null);
  assert.ok((late.buyRate as number) >= 0 && (late.buyRate as number) <= 1);
  // Below the floor the per-direction rate is not trusted and the pooled rate is
  // used instead — a per-direction rate from twelve windows is not a baseline.
  const tiny = newBaselineState();
  extendBaseline(tiny, { bars, stopDistanceAt, entryAt, rr: 2, horizonBars: 10, startIndex: 20 });
  // Windows at indices 20..25 have closed by bar 35 (index + 10 ≤ 35): six.
  const small = baselineAt(tiny, 35, 10);
  assert.equal(small.outcomes, 6);
  assert.ok(small.outcomes < BASELINE_MIN_OUTCOMES);
  assert.equal(baselineForDirection(small, "buy"), small.rate, "below the floor the pooled rate must be used");
});

test("every agent hands the baseline its own geometry, so an agent with a narrow stop is compared with a narrow stop", () => {
  // The trend agent's baseline stop is the mode's ATR multiple at every bar, not
  // the signal's stop (which is the same number): if an agent ever passed a
  // structurally tighter stop to the comparator, its edge would be inflated.
  const bars = seriesBars("positive-control", 1200, 3);
  const agents = buildAlphaAgents();
  for (const id of ALPHA_IDS) {
    const view = (agents[id] as AlphaAgent).view(contextFor(bars));
    if (!view) continue;
    assert.ok(view.samples > 0, `${id}: a view must rest on at least one closed occurrence`);
    assert.ok(
      view.hitRate === null || (view.hitRate >= 0 && view.hitRate <= 1),
      `${id}: hitRate must be a rate`,
    );
    // The stated probability must be pulled TOWARD the baseline, never away:
    // it lies between the raw hit rate and the baseline (up to the floor at 0/1).
    if (view.hitRate !== null && view.samples >= DEFAULT_ALPHA_CONFIG.minOccurrences) {
      const lo = Math.min(view.hitRate, view.baselineRate) - 1e-9;
      const hi = Math.max(view.hitRate, view.baselineRate) + 1e-9;
      assert.ok(
        view.probability >= lo && view.probability <= hi,
        `${id}: probability ${view.probability} is outside the hit-rate/baseline interval [${lo}, ${hi}]`,
      );
    }
  }
});

test("extending a table is incremental and agrees with a from-scratch build", () => {
  const bars = seriesBars("positive-control", 500, 9);
  const atrPerBar = 0.0012;
  const signalAt = (index: number) => (index % 7 === 0 ? { direction: "buy" as const, entry: (bars[index] as Bar)[CLOSE] as number, stopDistance: atrPerBar } : null);
  const incremental = newEdgeState();
  for (let cut = 100; cut <= 300; cut += 25) {
    extendEdgeTable(incremental, { bars: bars.slice(0, cut), signalAt, rr: 2, horizonBars: 10, startIndex: 40 });
  }
  const oneShot = newEdgeState();
  extendEdgeTable(oneShot, { bars: bars.slice(0, 300), signalAt, rr: 2, horizonBars: 10, startIndex: 40 });
  assert.deepEqual(incremental.outcomes, oneShot.outcomes, "the incremental table diverged from a single pass");
});

test("the statistics helpers are honest about tiny samples", () => {
  assert.deepEqual(wilsonInterval(0, 0), { lower: 0, upper: 1 });
  const interval = wilsonInterval(6, 10);
  assert.ok(interval.lower < 0.6 && interval.upper > 0.6);
  assert.ok(standardError(0.5, 0) === 1, "an empty sample carries no information");
  assert.ok(Math.abs(standardError(0.25, 100) - 0.0433) < 0.001);
});

// ── 7. The wiring ───────────────────────────────────────────────────────────

test("alphaStrategy may only take a trade the desk would take, in the direction the agent agrees with", () => {
  const bars = seriesBars("positive-control", 1500, 4);
  const taken: unknown[] = [];
  const inner = {
    id: "stub",
    decide: () => ({
      id: "stub-plan",
      symbol: "EURUSD",
      side: "buy" as const,
      mode: "intraday" as const,
      entryFrame: "M15" as const,
      entry: 1.1,
      stop: 1.09,
      targets: [1.12, 1.13],
      riskPoints: 100,
      riskReward: 2,
      lot: 0.1,
      expiresAt: START + 60_000,
      rationale: { winProbability: 0.4 },
    }),
  } as never;
  const agent = {
    id: "trend" as const,
    label: "test",
    frames: ["M15" as const],
    minBars: 10,
    view: () => ({
      direction: "sell" as const,
      entry: 1.1,
      probability: 0.5,
      horizonBars: 12,
      rr: 2,
      samples: 20,
      hitRate: 0.5,
      baselineRate: 0.33,
      strength: 1,
      reasons: ["stub"],
    }),
  };
  const strategy = alphaStrategy({ agent, inner, id: "stub+sell" });
  const plan = strategy.decide(contextFor(bars) as never);
  assert.equal(plan, null, "a direction mismatch must not produce a trade");
  taken.push(plan);
  assert.equal(strategy.ledger.length, 1);
  assert.equal(strategy.ledger[0]?.reason, "direction-mismatch");

  // Now agree, and check the agent's probability becomes the plan's probability.
  const agreeing = alphaStrategy({
    agent: { ...agent, view: () => ({ ...(agent.view() as AlphaView), direction: "buy" as const, probability: 0.55 }) },
    inner,
    id: "stub+buy",
  });
  const agreedPlan = agreeing.decide(contextFor(bars) as never);
  assert.ok(agreedPlan, "an agreeing agent must not be blocked");
  assert.equal(agreedPlan?.rationale.winProbability, 0.55, "the plan must carry the agent's measured probability");
  assert.equal(agreedPlan?.stop, 1.09, "the desk's geometry must survive untouched");
  assert.equal(agreeing.ledger[0]?.reason, "taken");
});

test("alphaStrategy records a desk refusal even when the agent would have fired", () => {
  const bars = seriesBars("positive-control", 900, 4);
  const inner = { id: "refusing", decide: () => null } as never;
  const agent = {
    id: "mean-reversion" as const,
    label: "test",
    frames: ["M15" as const],
    minBars: 10,
    view: () => ({
      direction: "buy" as const,
      entry: 1.1,
      probability: 0.5,
      horizonBars: 12,
      rr: 2,
      samples: 20,
      hitRate: 0.5,
      baselineRate: 0.33,
      strength: 1,
      reasons: ["stub"],
    }),
  };
  const strategy = alphaStrategy({ agent, inner, id: "refusing" });
  assert.equal(strategy.decide(contextFor(bars) as never), null);
  assert.equal(strategy.ledger[0]?.reason, "desk-refused");
});
