import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCUMULATOR_GROWTH_RATES,
  accumulatorEntryGate,
  estimatedBarrierPct,
  estimateAccumulatorRisk,
  evaluateAccumulatorMarket,
  recoveryStakeForAccumulator,
} from "./accumulator-analysis";

function flatPrices(n: number, price = 1000): number[] {
  return Array.from({ length: n }, () => price);
}

function alternatingMovePrices(n: number, move = 0.001): number[] {
  const prices = [1000];
  for (let i = 1; i < n; i++) prices.push(prices[i - 1]! * (i % 2 ? 1 + move : 1 - move));
  return prices;
}

function calmThenHotPrices(n: number): number[] {
  const prices = [1000];
  for (let i = 1; i < n; i++) {
    const move = i < n - 120 ? 0.00001 : 0.001;
    prices.push(prices[i - 1]! * (i % 2 ? 1 + move : 1 - move));
  }
  return prices;
}

test("ACCU growth rate vocabulary is the broker product set", () => {
  assert.deepEqual([...ACCUMULATOR_GROWTH_RATES], [0.01, 0.02, 0.03, 0.04, 0.05]);
  assert.ok(estimatedBarrierPct(0.01) > estimatedBarrierPct(0.05));
});

test("broker-supported growth rates constrain auto selection", () => {
  const rows = evaluateAccumulatorMarket({ symbol: "R_10", displayName: "Calm", prices: flatPrices(300) }, {
    growthRate: "auto",
    growthRates: [0.01, 0.03],
    targetTicks: 8,
    durationTicks: 60,
    bootstrapPaths: 80,
  });
  assert.deepEqual(rows.map((row) => row.growthRate).sort((a, b) => a - b), [0.01, 0.03]);
});

test("compound economics use survival of the whole tick path", () => {
  const risk = estimateAccumulatorRisk(flatPrices(400), 0.01, {
    targetTicks: 8,
    durationTicks: 60,
    bootstrapPaths: 120,
  });
  assert.equal(risk.survivalProbability, 1);
  assert.equal(risk.knockoutProbability, 0);
  assert.ok(Math.abs(risk.compoundedFactor - Math.pow(1.01, 8)) < 1e-12);
  assert.ok(Math.abs(risk.breakEvenSurvival - 1 / Math.pow(1.01, 8)) < 1e-12);
  assert.ok(risk.lowerExpectedNetReturn > 0);
});

test("large price shocks are treated as full-stake knockout hazards", () => {
  const risk = estimateAccumulatorRisk(calmThenHotPrices(500), 0.05, {
    targetTicks: 8,
    durationTicks: 60,
    bootstrapPaths: 160,
  });
  assert.ok(risk.survivalProbability < 0.9);
  assert.ok(risk.knockoutProbability > 0.1);
  assert.equal(risk.regime, "hot");
});

test("market evaluator refuses a hot/high-hazard candidate and accepts a measured calm one", () => {
  const calm = evaluateAccumulatorMarket({ symbol: "R_10", displayName: "Calm", prices: flatPrices(500) }, {
    growthRate: 0.01,
    targetTicks: 8,
    durationTicks: 60,
    bootstrapPaths: 120,
  })[0]!;
  const hot = evaluateAccumulatorMarket({ symbol: "R_100", displayName: "Hot", prices: calmThenHotPrices(500) }, {
    growthRate: 0.05,
    targetTicks: 8,
    durationTicks: 60,
    bootstrapPaths: 120,
  })[0]!;
  assert.equal(calm.deployable, true);
  assert.equal(hot.deployable, false);
  assert.ok(calm.lowerExpectedNetReturn > hot.lowerExpectedNetReturn);
  assert.ok(hot.signals.some((signal) => signal.includes("knockout") || signal.includes("hot")));
});

test("entry gate pauses after a shock and clears for a calm path", () => {
  const calmCandidate = evaluateAccumulatorMarket({ symbol: "R_10", displayName: "Calm", prices: flatPrices(500) }, {
    growthRate: 0.01,
    targetTicks: 8,
    durationTicks: 60,
    bootstrapPaths: 100,
  })[0]!;
  const ready = accumulatorEntryGate(flatPrices(100), calmCandidate);
  assert.equal(ready.ready, true, ready.reason);

  const shocked = flatPrices(100);
  shocked[shocked.length - 1] = shocked[shocked.length - 2]! * 1.001;
  const held = accumulatorEntryGate(shocked, calmCandidate);
  assert.equal(held.ready, false);
  assert.match(held.reason, /barrier|volatility/);
});

test("accumulator recovery stake uses compounded net return and caps risk", () => {
  const stake = recoveryStakeForAccumulator(2, { netReturnMultiplier: 0.0828567 }, 10, 500, 1000);
  assert.ok(Math.abs(stake - (2 * 1.1) / 0.0828567) < 1e-8);
  const capped = recoveryStakeForAccumulator(1000, { netReturnMultiplier: 0.08 }, 10, 50, 100);
  assert.equal(capped, 10); // 10% of the available balance is the tighter cap
});
