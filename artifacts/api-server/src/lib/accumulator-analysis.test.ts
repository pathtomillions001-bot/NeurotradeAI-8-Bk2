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
import {
  ACCUMULATOR_HEAL_LIMIT,
  planAccumulatorDurationHeal,
  type AccuDurationHealState,
} from "./accumulator-engine";
import { discoverAccumulatorContractSpec, tickManager } from "./deriv";

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

// ── Broker duration limits & self-heal ───────────────────────────────────────
//
// The exchange rejects an ACCU buy with "Invalid input (duration or
// date_expiry)" when the duration is outside the growth-rate-specific tick
// window. Max allowable ticks SHRINK as growth rises, so the analysis must
// clamp per growth rate, discovery must read the REAL contracts_for field
// names, and the engine must self-heal on the rejection instead of stopping.

test("per-growth-rate tick cap clamps the analysed duration", () => {
  const caps = { "0.01": 230, "0.02": 170, "0.03": 110, "0.04": 80, "0.05": 60 };
  // A requested 60-tick duration is fine at 1% growth but must be clamped
  // at the tighter cap for higher growth rates.
  const at1 = estimateAccumulatorRisk(flatPrices(300), 0.01, {
    targetTicks: 8, durationTicks: 60, brokerMaxTicksByGrowth: caps, bootstrapPaths: 40,
  });
  assert.equal(at1.durationTicks, 60);
  const at5 = estimateAccumulatorRisk(flatPrices(300), 0.05, {
    targetTicks: 8, durationTicks: 60, brokerMaxTicksByGrowth: caps, bootstrapPaths: 40,
  });
  assert.ok(at5.durationTicks <= 60);
  // And a longer requested duration is clamped to the per-rate cap, not the
  // (looser) global broker max.
  const longAt5 = estimateAccumulatorRisk(flatPrices(300), 0.05, {
    targetTicks: 8, durationTicks: 230, brokerMaxTicks: 230, brokerMaxTicksByGrowth: caps, bootstrapPaths: 40,
  });
  assert.equal(longAt5.durationTicks, 60);
  // The target never exceeds the (clamped) duration.
  assert.ok(longAt5.targetTicks < longAt5.durationTicks);
});

test("evaluateAccumulatorMarket applies the per-growth cap per row", () => {
  const caps = { "0.01": 230, "0.05": 60 };
  const rows = evaluateAccumulatorMarket(
    { symbol: "R_10", displayName: "Calm", prices: flatPrices(300), brokerMaxTicks: 230, brokerMaxTicksByGrowth: caps },
    { growthRate: "auto", growthRates: [0.01, 0.05], targetTicks: 8, durationTicks: 230, bootstrapPaths: 40 },
  );
  const byRate = new Map(rows.map((r) => [r.growthRate, r.durationTicks]));
  assert.equal(byRate.get(0.05), 60);
  assert.equal(byRate.get(0.01), 230);
});

test("contract discovery reads the real contracts_for duration fields", async (t) => {
  // The Deriv payload uses `min_contract_duration` / `max_contract_duration`
  // (tick counts for ACCU). One row per growth rate, each with its own cap.
  const mock = t.mock.method(tickManager, "request", (async () => ({
    contracts_for: {
      available: [
        { contract_type: "CALL", min_contract_duration: "1", max_contract_duration: "500" },
        { contract_type: "ACCU", growth_rate: 0.01, min_contract_duration: "1", max_contract_duration: "230", barrier: "0.0005" },
        { contract_type: "ACCU", growth_rate: 0.05, min_contract_duration: "1", max_contract_duration: "60" },
      ],
    },
  })) as any);
  const spec = await discoverAccumulatorContractSpec("R_10");
  assert.equal(spec.source, "broker");
  assert.equal(spec.available, true);
  assert.equal(spec.minDurationTicks, 1);
  // The global max is the TIGHTEST observed cap (conservative ceiling).
  assert.equal(spec.maxDurationTicks, 60);
  assert.ok(spec.maxTicksByGrowth, "per-growth caps must be captured");
  assert.equal(spec.maxTicksByGrowth!["0.01"], 230);
  assert.equal(spec.maxTicksByGrowth!["0.05"], 60);
  assert.equal(spec.barrierPct, 0.0005);
  mock.mock.restore();
});

test("contract discovery still accepts the legacy single-row payload", async (t) => {
  const mock = t.mock.method(tickManager, "request", (async () => ({
    contracts_for: {
      available: [
        { contract_type: "ACCU", growth_rate: [0.01, 0.02, 0.03, 0.04, 0.05], min_contract_duration: "1", max_contract_duration: "230" },
      ],
    },
  })) as any);
  const spec = await discoverAccumulatorContractSpec("R_10");
  assert.equal(spec.source, "broker");
  assert.equal(spec.maxDurationTicks, 230);
  assert.equal(spec.maxTicksByGrowth, undefined, "a single row has no per-rate spread");
  assert.deepEqual(spec.growthRates, [0.01, 0.02, 0.03, 0.04, 0.05]);
  mock.mock.restore();
});

test("duration self-heal ladder shortens, then lowers growth, then exhausts", () => {
  const heal: AccuDurationHealState = { maxTicksByGrowth: new Map(), healCount: 0 };

  // Step 1: shrink the duration (40% off 60 → 36).
  const step1 = planAccumulatorDurationHeal(heal, 0.05, 60)!;
  assert.equal(step1.growthRate, 0.05);
  assert.equal(step1.maxTicks, 36);

  // Step 2: shrink again (36 → 22).
  const step2 = planAccumulatorDurationHeal(heal, 0.05, 36)!;
  assert.equal(step2.maxTicks, 22);

  // Walk the ladder down until the duration hits the floor.
  let duration = step2.maxTicks!;
  let guard = 0;
  while (guard++ < 20) {
    const plan = planAccumulatorDurationHeal(heal, 0.05, duration)!;
    if (plan.growthRate !== 0.05) break; // growth got lowered
    duration = plan.maxTicks!;
  }
  // Once the floor is reached, the NEXT step must lower the growth rate.
  const lowerGrowth = planAccumulatorDurationHeal(heal, 0.05, duration)!;
  assert.ok(lowerGrowth.growthRate < 0.05, "the ladder lowers growth at the duration floor");
  assert.equal(lowerGrowth.maxTicks, undefined, "the (floor) duration stays under the looser growth");

  // A fresh ladder at the LOWEST growth rate with the duration at the floor
  // is exhausted — the caller then falls back to counting a strike.
  const stuck: AccuDurationHealState = { maxTicksByGrowth: new Map(), healCount: 0 };
  let floor = 15;
  let steps = 0;
  while (steps++ < 20) {
    const plan = planAccumulatorDurationHeal(stuck, 0.01, floor);
    if (!plan) break;
    if (plan.maxTicks !== undefined) floor = plan.maxTicks;
    if (plan.growthRate !== 0.01) break;
  }
  assert.ok(steps <= ACCUMULATOR_HEAL_LIMIT + 2, "exhaustion must be bounded");
});
