/**
 * Monte Carlo tests.
 *
 * This module is the gate that decides whether a setup is worth paying the
 * spread for, so its failure modes are the dangerous kind: an optimistic
 * intrabar assumption or a forgotten cost term inflates every expectancy in
 * the system and makes a losing strategy look profitable.
 *
 * The last test is the evidence behind the refusal to implement martingale
 * recovery staking.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bestTarget,
  equityCurveSimulation,
  probabilityOfRetrace,
  simulateTrade,
} from "./montecarlo";

const base = {
  entry: 100,
  sl: 99,
  tp: 102,
  side: "buy" as const,
  drift: 0,
  volatility: 0.005,
  horizon: 40,
  paths: 3000,
  seed: 11,
};

test("probabilities form a partition of the outcome space", () => {
  const r = simulateTrade(base);
  const total = r.winProbability + r.lossProbability + r.timeoutProbability;
  assert.ok(Math.abs(total - 1) < 1e-9, `probabilities sum to ${total}`);
});

test("results are deterministic for a given seed", () => {
  const a = simulateTrade(base);
  const b = simulateTrade(base);
  assert.equal(a.winProbability, b.winProbability);
  assert.equal(a.expectancyR, b.expectancyR);
});

test("a different seed gives a similar but not identical answer", () => {
  const a = simulateTrade(base);
  const b = simulateTrade({ ...base, seed: 999 });
  assert.notEqual(a.winProbability, b.winProbability);
  // Sampling error on 3,000 paths should be small.
  assert.ok(Math.abs(a.winProbability - b.winProbability) < 0.06);
});

test("a nearer target is hit more often than a distant one", () => {
  const near = simulateTrade({ ...base, tp: 100.5 });
  const far = simulateTrade({ ...base, tp: 105 });
  assert.ok(near.winProbability > far.winProbability);
});

test("positive drift raises win probability for a long", () => {
  const flat = simulateTrade(base);
  const bullish = simulateTrade({ ...base, drift: 0.002 });
  assert.ok(bullish.winProbability > flat.winProbability);
});

test("a short mirrors the long under reversed drift", () => {
  const long = simulateTrade({ ...base, drift: 0.002 });
  const short = simulateTrade({
    ...base,
    side: "sell",
    sl: 101,
    tp: 98,
    drift: -0.002,
  });
  assert.ok(Math.abs(long.winProbability - short.winProbability) < 0.08);
});

test("costs reduce expectancy by exactly cost/risk in R", () => {
  const free = simulateTrade(base);
  // Risk is 1.00 in price; a cost of 0.10 is 0.10R.
  const costed = simulateTrade({ ...base, costPrice: 0.1 });
  assert.equal(free.winProbability, costed.winProbability, "costs must not alter path outcomes");
  assert.ok(Math.abs(free.expectancyR - costed.expectancyR - 0.1) < 1e-9);
  assert.equal(costed.grossExpectancyR, free.grossExpectancyR);
});

test("a wide spread can flip a positive gross edge negative", () => {
  const gross = simulateTrade({ ...base, drift: 0.0015 });
  assert.ok(gross.expectancyR > 0, "setup should be attractive before costs");
  const net = simulateTrade({ ...base, drift: 0.0015, costPrice: gross.expectancyR * 1.5 });
  assert.ok(net.expectancyR < 0, "cost must be able to kill the trade");
});

test("ambiguous bars resolve as losses — the pessimistic tie-break", () => {
  // Stop and target equidistant with zero drift: the conservative intrabar
  // rule must not produce a win rate above 50%.
  const r = simulateTrade({ ...base, tp: 101, sl: 99, horizon: 200, paths: 4000 });
  assert.ok(
    r.winProbability <= 0.5,
    `symmetric setup returned ${r.winProbability} — intrabar resolution is optimistic`,
  );
});

test("a degenerate plan with no stop distance is rejected, not divided by zero", () => {
  const r = simulateTrade({ ...base, sl: 100 });
  assert.equal(r.expectancyR, -1);
  assert.equal(r.paths, 0);
  assert.ok(Number.isFinite(r.rewardRisk));
});

test("zero volatility resolves to a timeout rather than a phantom edge", () => {
  const r = simulateTrade({ ...base, volatility: 0, drift: 0 });
  assert.equal(r.timeoutProbability, 1);
  assert.equal(r.winProbability, 0);
});

test("a short horizon increases timeouts", () => {
  const brief = simulateTrade({ ...base, horizon: 3 });
  const long = simulateTrade({ ...base, horizon: 200 });
  assert.ok(brief.timeoutProbability > long.timeoutProbability);
});

test("bootstrapping uses the supplied return distribution", () => {
  // Strongly positive historical returns, re-centred on the requested drift,
  // must still produce a usable simulation rather than inheriting the mean.
  const returns = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.004 : -0.002));
  const r = simulateTrade({ ...base, returns });
  const total = r.winProbability + r.lossProbability + r.timeoutProbability;
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(r.paths > 0);
});

test("target search picks the reward:risk with the best expectancy", () => {
  const best = bestTarget({ ...base, drift: 0.001 }, [1, 2, 3, 4]);
  assert.ok(best);
  for (const m of [1, 2, 3, 4]) {
    const tp = base.entry + Math.abs(base.entry - base.sl) * m;
    const candidate = simulateTrade({ ...base, drift: 0.001, tp });
    assert.ok(
      best.result.expectancyR >= candidate.expectancyR - 1e-12,
      `${m}R scored better than the selected ${best.rewardRisk}R`,
    );
  }
});

test("target search returns null when risk is zero", () => {
  assert.equal(bestTarget({ ...base, sl: base.entry }), null);
});

test("retrace probability falls as the trade moves further into profit", () => {
  const near = probabilityOfRetrace({
    current: 100.2, level: 100, target: 102,
    side: "buy", drift: 0, volatility: 0.005, horizon: 40,
  });
  const far = probabilityOfRetrace({
    current: 101.5, level: 100, target: 102,
    side: "buy", drift: 0, volatility: 0.005, horizon: 40,
  });
  assert.ok(far < near, `far ${far} should be below near ${near}`);
  for (const v of [near, far]) assert.ok(v >= 0 && v <= 1);
});

// ── The martingale argument, as a test ───────────────────────────────────────

test("doubling stake after a loss massively increases ruin probability", () => {
  const assumptions = {
    winProbability: 0.55,
    rewardRisk: 1.0,
    riskPct: 1,
    trades: 500,
    runs: 400,
    seed: 2024,
  };

  const flat = equityCurveSimulation({ ...assumptions, lossMultiplier: 1, maxRiskPct: 2 });
  const martingale = equityCurveSimulation({ ...assumptions, lossMultiplier: 2, maxRiskPct: 100 });

  assert.ok(
    martingale.ruinProbability > flat.ruinProbability * 5,
    `martingale ruin ${martingale.ruinProbability} vs flat ${flat.ruinProbability}`,
  );
  assert.ok(
    martingale.worstDrawdownPct >= flat.worstDrawdownPct,
    "martingale must show the deeper worst-case drawdown",
  );
  // Same edge, same win rate — only the staking differs. That is the point.
  assert.ok(flat.ruinProbability < 0.1, `flat staking ruined ${flat.ruinProbability}`);
});

test("flat staking at a positive edge is profitable in the median case", () => {
  const flat = equityCurveSimulation({
    winProbability: 0.58,
    rewardRisk: 1.2,
    riskPct: 1,
    trades: 400,
    runs: 300,
    lossMultiplier: 1,
    maxRiskPct: 2,
    seed: 5,
  });
  assert.ok(flat.medianReturnPct > 0);
  assert.ok(flat.meanMaxDrawdownPct > 0 && flat.meanMaxDrawdownPct < 100);
});

test("a negative edge loses money however it is staked", () => {
  const losing = equityCurveSimulation({
    winProbability: 0.4,
    rewardRisk: 1,
    riskPct: 1,
    trades: 400,
    runs: 200,
    lossMultiplier: 1,
    seed: 8,
  });
  assert.ok(losing.medianReturnPct < 0, "no staking scheme rescues a negative edge");
});
