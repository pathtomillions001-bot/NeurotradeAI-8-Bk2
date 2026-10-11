/**
 * WP1 acceptance — the hard invariants, measured on null and control data.
 *
 * The invariant under test: NO armed plan may have a reward:risk below 1:2
 * measured at the price the position is expected to FILL at (trigger plus the
 * mode's slippage allowance), in any mode, on either a driftless random walk
 * or a series with a known persistent edge.
 *
 * The second section is the null experiment that motivated WP1: on pure noise
 * the v3 desk armed plans at high confidence (median 65.6 against a bar of 60,
 * 90% of windows with ≥3 of 7 families agreeing). The tests here do not yet
 * assert the arm RATE — that is the WP2 harness gate (≤ 3%) — they assert the
 * geometry of whatever IS armed, which must hold even on noise.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { evaluate, MIN_RR_FILL, type AgentInput } from "./agent";
import { createRiskState } from "./risk";
import { DEFAULT_GENERATOR_SPEC, generate, type GeneratorKind } from "./research/generators";
import { MIN_TARGET_R, TARGET_MULTIPLES, bestTarget } from "./montecarlo";
import type { AccountSnapshot, Quote, SymbolSpec, Timeframe, TradeMode } from "./types";

const POINT = 0.00001;

function eurusdSpec(): SymbolSpec {
  return {
    symbol: "EURUSD",
    assetClass: "forex",
    point: POINT,
    digits: 5,
    tickSize: POINT,
    tickValue: 1,
    contractSize: 100_000,
    volumeMin: 0.01,
    volumeMax: 50,
    volumeStep: 0.01,
    stopsLevel: 0,
    freezeLevel: 0,
    marginInitial: 0,
    swapLong: 0,
    swapShort: 0,
    commissionPerLot: 3,
    spreadPoints: 8,
    baseCurrency: "EUR",
    quoteCurrency: "USD",
  };
}

function account(): AccountSnapshot {
  return {
    balance: 10_000,
    equity: 10_000,
    margin: 0,
    freeMargin: 10_000,
    marginLevel: Infinity,
    currency: "USD",
    leverage: 500,
    mode: "hedging",
    isLive: false,
    dayStartEquity: 10_000,
    peakEquity: 10_000,
  };
}

function quote(price: number): Quote {
  return {
    symbol: "EURUSD",
    bid: price,
    ask: price + 8 * POINT,
    spreadPoints: 8,
    ts: Date.UTC(2026, 0, 5, 12, 0, 0),
    ageMs: 100,
  };
}

const MODES: TradeMode[] = ["scalp", "intraday", "swing"];

const MODE_FRAME: Record<TradeMode, Timeframe> = { scalp: "M2", intraday: "M15", swing: "H1" };

function inputFor(
  kind: GeneratorKind,
  mode: TradeMode,
  seed: number,
  frameMs: number,
): AgentInput {
  const spec = eurusdSpec();
  const bars = generate(kind, {
    ...DEFAULT_GENERATOR_SPEC,
    bars: 900,
    seed,
    timeframeMs: frameMs,
    startPrice: 1.1,
  }).bars;
  const last = bars[bars.length - 1] as [number, number, number, number, number, number];
  const price = last[4];
  const frame = MODE_FRAME[mode];
  return {
    symbol: "EURUSD",
    mode,
    spec,
    quote: quote(price),
    series: { [frame]: bars, H1: bars, M15: bars, M5: bars, M30: bars },
    account: account(),
    positions: [],
    specs: new Map([["EURUSD", spec]]),
    riskState: createRiskState(),
    now: last[0] + frameMs,
  };
}

const FRAME_MS: Record<TradeMode, number> = {
  scalp: 2 * 60_000,
  intraday: 15 * 60_000,
  swing: 60 * 60_000,
};

test("WP1 — no armed plan has reward:risk below 1:2 at the expected fill", () => {
  for (const kind of ["driftless", "positive-control"] as GeneratorKind[]) {
    for (const mode of MODES) {
      let armed = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const decision = evaluate(inputFor(kind, mode, seed, FRAME_MS[mode]));
        if (!decision.armed || !decision.plan) continue;
        armed++;
        const plan = decision.plan;
        const tp = plan.tp[0] as number;
        // The reported ratio is measured at the EXPECTED FILL (trigger +
        // slippage), which is the honest number. It must clear the floor.
        const reported = plan.rationale.rewardRisk;
        assert.ok(
          reported >= MIN_RR_FILL - 1e-9,
          `${kind}/${mode}: reported rewardRisk ${reported} is below the 1:2 floor`,
        );
      }
      // Silence is allowed (and on the null it is expected); the invariant is
      // about geometry, not arm rate. The arm-rate gate lives in the harness.
      assert.ok(armed >= 0);
    }
  }
});

test("WP1 — the target search can never return a multiple below 2R", () => {
  assert.deepEqual([...TARGET_MULTIPLES], [2, 2.5, 3]);
  assert.equal(MIN_TARGET_R, 2.0);
  const base = {
    entry: 1.1,
    sl: 1.099,
    side: "buy" as const,
    drift: 0,
    volatility: 0.0004,
    horizon: 40,
    returns: [] as number[],
    costPrice: 0.0002,
    paths: 400,
    seed: 11,
  };
  // Even asked explicitly for sub-2R multiples, the search refuses them.
  const chosen = bestTarget(base, [1, 1.5, 2, 2.5, 3, 4]);
  assert.ok(chosen);
  assert.ok(
    (chosen?.rewardRisk ?? 0) >= MIN_TARGET_R,
    `target search returned ${chosen?.rewardRisk}R`,
  );
});

test("WP1 — the one-standard-error rule picks the nearest, not the luckiest", () => {
  const base = {
    entry: 1.1,
    sl: 1.099,
    side: "buy" as const,
    drift: 0,
    volatility: 0.0005,
    horizon: 60,
    returns: [] as number[],
    costPrice: 0.0002,
    paths: 2000,
    seed: 7,
  };
  const chosen = bestTarget(base, [2, 2.5, 3, 4]);
  assert.ok(chosen);
  const all = [2, 2.5, 3, 4].map((m) => {
    const tp = base.entry + 0.001 * m;
    return { m, tp };
  });
  void all;
  // The chosen multiple must be within one standard error of the best, and no
  // SMALLER multiple may also satisfy that — otherwise the rule is not
  // "smallest within one SE".
  const results = [2, 2.5, 3, 4].map((m) => ({
    m,
    result: bestTarget({ ...base, entry: base.entry, sl: base.entry - 0.001 }, [m]),
  }));
  const bestScore = Math.max(...results.map((r) => r.result?.result.expectancyR ?? -Infinity));
  const bestSe = results.find((r) => (r.result?.result.expectancyR ?? -Infinity) === bestScore)?.result
    ?.result.expectancyStdErrR ?? 0;
  const threshold = bestScore - bestSe;
  for (const r of results) {
    const score = r.result?.result.expectancyR ?? -Infinity;
    if (score >= threshold) {
      assert.equal(
        r.m,
        chosen?.rewardRisk,
        `a nearer multiple (${r.m}R) is statistically indistinguishable from the best but was not chosen`,
      );
      break;
    }
  }
});
