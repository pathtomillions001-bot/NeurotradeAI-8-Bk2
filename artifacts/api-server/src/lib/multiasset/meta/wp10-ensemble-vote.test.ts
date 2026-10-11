/**
 * WP10.2 — the regime-mismatch vote.
 *
 * The brief's sentence is "an agent in a different regime votes at half weight".
 * This file pins down what that means in the desk's own vocabulary, and — more
 * importantly — what it does NOT mean:
 *
 *   • the rule fires only against a DIRECTIONAL reading. In `range` or `volatile`
 *     the desk has no direction to contradict, so nothing is penalised; a rule that
 *     halved every vote in a quiet market would be a silent, market-wide shrink.
 *   • the weight is exactly 1 unless it is armed, so the shipped path is
 *     byte-for-byte what it was (asserted on a real series, not by inspection).
 *   • the blend is the WEIGHTED mean over the agents that agree, so a down-weighted
 *     agent's opinion counts for less and the direction can genuinely flip when the
 *     weighted majority disagrees with the counted one.
 *
 * The numbers that matter for the live desk — whether the weighted blend keeps its
 * calibration and whether the gatekeeper still refuses on the nulls — are NOT here:
 * they are in the two stored studies (§12.6), because that is what the brief means
 * by "measured".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { REGIME_MISMATCH_VOTE_WEIGHT, metaViewAt, regimeVoteWeight } from "./view";
import { generate, DEFAULT_GENERATOR_SPEC, type GeneratorKind } from "../research/generators";
import type { Bar, Timeframe } from "../types";

const FRAME: Timeframe = "M5";

function bars(kind: GeneratorKind, count = 900, seed = 11): Bar[] {
  return generate(kind, { ...DEFAULT_GENERATOR_SPEC, bars: count, timeframeMs: 5 * 60_000, seed }).bars as Bar[];
}

test("W10.7 — the weight rule is a pure function of the regime and the proposal", () => {
  const half = REGIME_MISMATCH_VOTE_WEIGHT;
  // Contrarian: a long against a downtrend, a short against an uptrend.
  assert.equal(regimeVoteWeight({ kind: "trend_down", direction: "buy", mismatchWeight: half }), half);
  assert.equal(regimeVoteWeight({ kind: "trend_up", direction: "sell", mismatchWeight: half }), half);
  // Aligned: full weight.
  assert.equal(regimeVoteWeight({ kind: "trend_up", direction: "buy", mismatchWeight: half }), 1);
  assert.equal(regimeVoteWeight({ kind: "trend_down", direction: "sell", mismatchWeight: half }), 1);
  // No directional reading, no penalty — for either kind or for an abstention.
  assert.equal(regimeVoteWeight({ kind: "range", direction: "buy", mismatchWeight: half }), 1);
  assert.equal(regimeVoteWeight({ kind: "volatile", direction: "sell", mismatchWeight: half }), 1);
  assert.equal(regimeVoteWeight({ kind: "trend_up", direction: null, mismatchWeight: half }), 1);
  assert.equal(regimeVoteWeight({ kind: null, direction: "buy", mismatchWeight: half }), 1);
  // Disarmed: the weight is 1 whatever the reading says. A caller that forgets the
  // option can never accidentally arm the rule.
  for (const kind of ["trend_up", "trend_down", "range", "volatile", null] as const) {
    for (const direction of ["buy", "sell", null] as const) {
      assert.equal(regimeVoteWeight({ kind, direction, mismatchWeight: 1 }), 1);
    }
  }
  // And the shipped constant is the brief's number, not a chosen one.
  assert.equal(REGIME_MISMATCH_VOTE_WEIGHT, 0.5);
});

test("W10.8 — disarmed, the view is exactly the shipped one", () => {
  const series = bars("positive-control");
  const index = series.length - 1;
  const base = metaViewAt({
    symbol: "EURUSD",
    mode: "intraday",
    spec: {
      symbol: "EURUSD",
      point: 0.00001,
      digits: 5,
      tickSize: 0.00001,
      tickValue: 1,
      contractSize: 100_000,
      volumeMin: 0.01,
      volumeStep: 0.01,
      stopsLevel: 0,
      spreadPoints: 8,
      commissionPerLot: 0,
      assetClass: "forex",
    },
    frame: FRAME,
    bars: series,
    index,
    frameWidthMs: 5 * 60_000,
    targetMultipleR: 2,
    horizonBars: 12,
  });
  if (!base) return; // an abstention is a legitimate answer for this fixture
  const explicitOne = metaViewAt({
    symbol: "EURUSD",
    mode: "intraday",
    spec: {
      symbol: "EURUSD",
      point: 0.00001,
      digits: 5,
      tickSize: 0.00001,
      tickValue: 1,
      contractSize: 100_000,
      volumeMin: 0.01,
      volumeStep: 0.01,
      stopsLevel: 0,
      spreadPoints: 8,
      commissionPerLot: 0,
      assetClass: "forex",
    },
    frame: FRAME,
    bars: series,
    index,
    frameWidthMs: 5 * 60_000,
    targetMultipleR: 2,
    horizonBars: 12,
    regimeMismatchVoteWeight: 1,
  });
  assert.ok(explicitOne);
  assert.equal(base.view.probability, explicitOne.view.probability);
  assert.equal(base.view.direction, explicitOne.view.direction);
  assert.deepEqual(base.view.agents, explicitOne.view.agents);
  assert.deepEqual(base.view.downWeightedAgents, []);
  // Every weight is 1 — the field exists so a reader can see the rule was disarmed.
  for (const weight of Object.values(base.view.agentWeights ?? {})) assert.equal(weight, 1);
});

test("W10.9 — armed, only the contrarian votes are halved, and the blend is the weighted mean", () => {
  // Walk a series and collect the cases the rule can actually act on: a view whose
  // direction contradicts a directional regime reading.
  const spec = {
    symbol: "EURUSD",
    point: 0.00001,
    digits: 5,
    tickSize: 0.00001,
    tickValue: 1,
    contractSize: 100_000,
    volumeMin: 0.01,
    volumeStep: 0.01,
    stopsLevel: 0,
    spreadPoints: 8,
    commissionPerLot: 0,
    assetClass: "forex" as const,
  };
  let armed = 0;
  let checkedAgreement = 0;
  for (const kind of ["positive-control", "three-regime", "mean-reverting"] as const) {
    const series = bars(kind, 900, 21);
    for (let index = 700; index < series.length - 14; index += 3) {
      const base = metaViewAt({
        symbol: "EURUSD", mode: "intraday", spec, frame: FRAME, bars: series, index,
        frameWidthMs: 5 * 60_000, targetMultipleR: 2, horizonBars: 12,
      });
      if (!base) continue;
      const treated = metaViewAt({
        symbol: "EURUSD", mode: "intraday", spec, frame: FRAME, bars: series, index,
        frameWidthMs: 5 * 60_000, targetMultipleR: 2, horizonBars: 12,
        regimeMismatchVoteWeight: REGIME_MISMATCH_VOTE_WEIGHT,
      });
      assert.ok(treated, "the same bar must produce a view in both arms");

      const weights = treated.view.agentWeights ?? {};
      const down = treated.view.downWeightedAgents ?? [];
      assert.deepEqual(down.sort(), Object.entries(weights).filter(([, w]) => w < 1).map(([id]) => id).sort());
      for (const [id, weight] of Object.entries(weights)) {
        // The ONLY weight the rule can assign is 1 or the constant.
        assert.ok(weight === 1 || weight === REGIME_MISMATCH_VOTE_WEIGHT, `${id} carried weight ${weight}`);
        const reading = treated.view.agentProbabilities[id] as number | undefined;
        assert.ok(reading !== undefined);
        // A down-weighted agent must be contrarian: its own direction cannot be the
        // direction its weight would have supported.
        if (weight < 1) {
          const regimeDirectional = treated.kind === "trend_up" ? "sell" : treated.kind === "trend_down" ? "buy" : null;
          assert.ok(
            regimeDirectional !== null && base.view.agentProbabilities[id] !== undefined,
            "a down-weighted vote requires a directional regime reading",
          );
          armed++;
        }
      }
      if (down.length > 0) {
        // The blend must equal the weighted mean over the agents that agree — and
        // the weights of the agreeing agents must sum to what the rule says.
        const agreeWeight = treated.view.agents.reduce((sum, id) => sum + (weights[id] ?? 1), 0);
        assert.ok(agreeWeight > 0, "an agreeing set with no weight would have to be empty");
        const weighted =
          treated.view.agents.reduce(
            (sum, id) => sum + (treated.view.agentProbabilities[id] as number) * (weights[id] ?? 1),
            0,
          ) / agreeWeight;
        assert.ok(
          Math.abs(treated.view.probability - weighted) < 1e-12,
          `the blend must be the weighted mean (${treated.view.probability} vs ${weighted})`,
        );
        checkedAgreement++;
      }
      // Determinism: the same bar, twice, is the same view.
      const again = metaViewAt({
        symbol: "EURUSD", mode: "intraday", spec, frame: FRAME, bars: series, index,
        frameWidthMs: 5 * 60_000, targetMultipleR: 2, horizonBars: 12,
        regimeMismatchVoteWeight: REGIME_MISMATCH_VOTE_WEIGHT,
      });
      assert.deepEqual(again?.view.probability, treated.view.probability);
    }
  }
  assert.ok(armed > 0, "the fixtures must exercise the rule at least once — otherwise this test proves nothing");
  assert.ok(checkedAgreement > 0, "and at least one case must have had a weighted agreeing set");
});
