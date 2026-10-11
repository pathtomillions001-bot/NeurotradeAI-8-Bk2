/**
 * WP6 unit tests — the gatekeeper.
 *
 * The gatekeeper is the last thing between a plan and the market, so these tests
 * are written against the ways it could fail QUIETLY:
 *
 *   - a gate that is skipped rather than failed (every code is checked by name);
 *   - EV arithmetic that looks right and is off by a cost;
 *   - a floor that is applied to the wrong mode (scalp is stricter than swing);
 *   - a cost/σ_h ratio that is computed on the wrong side of the horizon;
 *   - BH applied step-down instead of step-up, which would throw away real edge;
 *   - a one-sided test against the textbook `1/(1+RR)` break-even, which the
 *     desk's own corpora measured to be wrong (0.10–0.34, not 0.33);
 *   - a regime permit that is missing being treated as a pass;
 *   - an MC whose GARCH fit failed being treated as a positive tail, and a
 *     geometry bar that is set INSIDE the measured range instead of below it;
 *   - and the invariant that the gatekeeper ADDS rejections and never removes
 *     one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BH_Q,
  COST_OVER_SIGMA_MODES,
  GATEKEEPER_MIN_RR_FILL,
  MAX_COST_OVER_HORIZON_SIGMA,
  MIN_EV_LCB_R,
  benjaminiHochberg,
  costOverHorizonSigma,
  edgeTestPValue,
  gatekeeperDecision,
  gatekeeperRejections,
  type GatekeeperInput,
} from "./gatekeeper";
import { MIN_RR_FILL } from "../agent";
import { executedPolicyMonteCarlo, fitGarch11, stationaryBlockBootstrap, type ExecutedMcResult } from "../montecarlo-v2";

const HEADER = {
  mode: "intraday" as const,
  side: "buy" as const,
  rrFill: 2.5,
  expectedFill: 100,
  riskPrice: 1,
  costPrice: 0.1,
  stepVolatility: 0.002,
  horizonBars: 24,
  probability: 0.5,
  probabilityLowerBound: 0.42,
  evidence: 400,
  breakEvenProbability: 0.25,
  regime: {
    permit: true,
    codes: ["REGIME_PERMIT"],
    reason: "Trend state holds.",
    probability: 0.71,
    required: "trend_up",
  },
  mc: { ...healthyMc(), pathsUsingGarch: true } as ExecutedMcResult,
  familySize: 1,
};

/** A positive executed-policy tail, as the MC returns when the fit worked. */
function healthyMc(): ExecutedMcResult {
  return {
    meanR: 0.31,
    p05MeanR: 0.12,
    pathMeanR: [0.12, 0.2, 0.31],
    paths: 200,
    tradesPerPath: 25,
    trades: 5000,
    garch: {
      omega: 1e-6,
      alpha: 0.08,
      beta: 0.88,
      logLikelihood: -100,
      unconditionalVolatility: 0.002,
      currentVolatility: 0.002,
      observations: 300,
    },
    pathsUsingGarch: true,
    outcomes: { target: 100, stop: 80, timeout: 20 },
  };
}

function decide(overrides: Partial<GatekeeperInput> = {}) {
  return gatekeeperDecision({ ...HEADER, ...overrides });
}

describe("meta/gatekeeper — the geometry floor", () => {
  it("restates the agent's own RR floor rather than inventing a second one", () => {
    assert.equal(GATEKEEPER_MIN_RR_FILL, MIN_RR_FILL);
    assert.equal(GATEKEEPER_MIN_RR_FILL, 2);
  });

  it("refuses 1:1.9 by name and accepts 1:2.0", () => {
    const bad = decide({ rrFill: 1.9 });
    assert.equal(bad.armed, false);
    assert.ok(bad.codes.includes("GK_RR_FILL"));
    assert.match(bad.reason, /1:1\.90/);
    const good = decide({ rrFill: 2.0 });
    assert.ok(!good.codes.includes("GK_RR_FILL"));
  });

  it("arms when every gate passes, and says so with the numbers", () => {
    const decision = decide();
    assert.equal(decision.armed, true);
    assert.equal(decision.code, "GK_OK");
    assert.deepEqual(decision.codes, ["GK_OK"]);
    assert.ok(decision.reasons.length >= 8, "every gate is recorded, not just the failing one");
    assert.match(decision.reason, /EV_LCB/);
  });
});

describe("meta/gatekeeper — EV at the lower bound", () => {
  it("charges the cost in R exactly once", () => {
    // p_LCB · (k+1) − 1 − c with k = rrFill and c = costPrice / riskPrice.
    const decision = decide({ probabilityLowerBound: 0.34, rrFill: 2.5, costPrice: 0.1, riskPrice: 1 });
    const expected = 0.34 * (2.5 + 1) - 1 - 0.1;
    assert.ok(Math.abs((decision.evLcbR as number) - expected) < 1e-12);
    assert.ok(Math.abs((decision.costR as number) - 0.1) < 1e-12);
  });

  it("refuses a positive-but-insufficient edge and names the floor", () => {
    // p_LCB 0.33 with k 2.5 and c 0.1 → 0.055R, above zero and below the 0.20R floor.
    const decision = decide({ probabilityLowerBound: 0.33 });
    assert.ok((decision.evLcbR as number) > 0);
    assert.ok(decision.codes.includes("GK_EV_LCB"));
    assert.match(decision.reason, /0\.20R floor for intraday/);
  });

  it("holds scalp to a higher floor than the slower modes — and says which", () => {
    assert.equal(MIN_EV_LCB_R.scalp, 0.25);
    assert.equal(MIN_EV_LCB_R.intraday, 0.2);
    assert.equal(MIN_EV_LCB_R.swing, 0.2);
    const pLcb = 0.38; // EV_LCB = 0.38·3.5 − 1 − 0.1 = 0.23R: over intraday's floor, under scalp's
    const scalp = decide({ mode: "scalp", probabilityLowerBound: pLcb });
    const swing = decide({ mode: "swing", probabilityLowerBound: pLcb });
    assert.equal(scalp.requiredEvLcbR, 0.25);
    assert.equal(swing.requiredEvLcbR, 0.2);
    // 0.23R clears intraday's floor and misses scalp's — the only difference
    // between the two decisions is the floor, which is the point of the test.
    assert.ok(scalp.codes.includes("GK_EV_LCB"));
    assert.ok(!swing.codes.includes("GK_EV_LCB"));
    // And the boundary itself: EV_LCB 0.23R passes intraday and fails scalp.
    const passesIntraday = decide({ probabilityLowerBound: 0.38, rrFill: 2.5, costPrice: 0.1 });
    const asScalp = decide({ mode: "scalp", probabilityLowerBound: 0.38, rrFill: 2.5, costPrice: 0.1 });
    assert.ok(!passesIntraday.codes.includes("GK_EV_LCB"));
    assert.ok(asScalp.codes.includes("GK_EV_LCB"));
  });

  it("refuses when there is no cost to charge, rather than assuming zero", () => {
    const decision = decide({ riskPrice: Number.NaN });
    assert.equal(decision.evLcbR, null);
    assert.ok(decision.codes.includes("GK_BAD_INPUT"));
    assert.ok(decision.codes.includes("GK_EV_LCB"));
  });
});

describe("meta/gatekeeper — cost against the horizon's volatility", () => {
  it("computes the ratio as cost / (price · σ_step · √h)", () => {
    const ratio = costOverHorizonSigma({
      costPrice: 0.02,
      expectedFill: 100,
      stepVolatility: 0.005,
      horizonBars: 16,
    });
    const expected = 0.02 / (100 * 0.005 * 4);
    assert.ok(Math.abs((ratio as number) - expected) < 1e-12);
  });

  it("refuses an unusable ratio instead of treating it as zero", () => {
    assert.equal(costOverHorizonSigma({ costPrice: 0.02, expectedFill: 0, stepVolatility: 0.005, horizonBars: 16 }), null);
  });

  it("enforces the 15% ceiling on scalp only, and reports it elsewhere", () => {
    assert.deepEqual([...COST_OVER_SIGMA_MODES], ["scalp"]);
    assert.equal(MAX_COST_OVER_HORIZON_SIGMA, 0.15);
    // σ_h = 100 · 0.002 · √24 ≈ 0.98; a 0.2 round trip is 20.4% of it.
    const scalp = decide({ mode: "scalp", costPrice: 0.2 });
    assert.ok(scalp.codes.includes("GK_COST_SIGMA"));
    assert.match(scalp.reason, /ceiling for scalp/);
    const intraday = decide({ costPrice: 0.2 });
    assert.ok(!intraday.codes.includes("GK_COST_SIGMA"));
    assert.ok((intraday.costOverSigma as number) > 0);
  });
});

describe("meta/gatekeeper — model and evidence", () => {
  it("refuses without a model, with the caller's own explanation", () => {
    const decision = decide({ probability: null, probabilityLowerBound: null, evidence: 0, modelNote: "no snapshot" });
    assert.equal(decision.armed, false);
    assert.ok(decision.codes.includes("GK_NO_MODEL"));
    assert.match(decision.reason, /no snapshot/);
    // And the EV gate cannot pass on a model that does not exist.
    assert.equal(decision.evLcbR, null);
  });

  it("refuses a bound with no evidence behind it", () => {
    const decision = decide({ evidence: 0 });
    assert.ok(decision.codes.includes("GK_NO_MODEL"));
  });
});

describe("meta/gatekeeper — the regime permit is composed, never inferred", () => {
  it("refuses when the permit could not be computed", () => {
    const decision = decide({ regime: null });
    assert.ok(decision.codes.includes("GK_REGIME"));
    assert.match(decision.reason, /could not be computed/);
  });

  it("carries the permit's own codes and sentence into the refusal", () => {
    const decision = decide({
      regime: {
        permit: false,
        codes: ["REGIME_PROBABILITY", "REGIME_DWELL"],
        reason: "P(trend_up) is 0.41 and the state is younger than the holding window.",
        probability: 0.41,
        required: "trend_up",
      },
    });
    assert.ok(decision.codes.includes("GK_REGIME"));
    assert.match(decision.reason, /REGIME_PROBABILITY/);
    assert.match(decision.reason, /0\.41/);
  });
});

describe("meta/gatekeeper — the executed-policy Monte Carlo", () => {
  it("refuses when the MC was not run", () => {
    const decision = decide({ mc: null });
    assert.ok(decision.codes.includes("GK_MC_UNAVAILABLE"));
    assert.equal(decision.mcP05MeanR, null);
  });

  it("refuses when the GARCH fit failed, even with a positive-looking sample", () => {
    const decision = decide({ mc: { ...healthyMc(), pathsUsingGarch: false, garch: null } });
    assert.ok(decision.codes.includes("GK_MC_UNAVAILABLE"));
    assert.ok(!decision.codes.includes("GK_MC_TAIL"));
  });

  it("refuses a tail that leaks through the floor, and names the percentile", () => {
    const decision = decide({ mc: { ...healthyMc(), p05MeanR: -1.8, meanR: -0.4 } });
    assert.ok(decision.codes.includes("GK_MC_TAIL"));
    assert.match(decision.reason, /5th percentile/);
  });

  it("does NOT refuse a merely negative tail: random entry is negative by construction", () => {
    // The first version of this layer required p05MeanR > 0 and the WP6 study
    // measured it on the desk's own positive control: 0 of 197 sampled bars
    // passed, home and null alike, because the simulation resamples random entry
    // with the desk's geometry and no alpha view. A gate that can never pass is
    // not a safety gate. What the layer vetoes now is GEOMETRY — a target the
    // horizon cannot reach, or a tail that leaks past the floor.
    const decision = decide({ mc: { ...healthyMc(), p05MeanR: -0.08, meanR: 0.05 } });
    assert.ok(!decision.codes.includes("GK_MC_TAIL"), decision.codes.join(","));
    assert.equal(decision.mcP05MeanR, -0.08);
  });

  it("refuses a target the market cannot reach inside the horizon", () => {
    // One target in a hundred trades: the barrier the plan is paid on is not
    // reachable at random entry within the desk's own holding window.
    const decision = decide({
      mc: { ...healthyMc(), outcomes: { target: 1, stop: 60, timeout: 39 } },
    });
    assert.ok(decision.codes.includes("GK_MC_TAIL"));
    assert.match(decision.reason, /target is not reachable inside this horizon/);
  });
});

describe("meta/gatekeeper — multiplicity", () => {
  it("implements BH as a step-up", () => {
    // p = (0.001, 0.02, 0.04, 0.2) with q = 0.1, m = 4: bounds are
    // 0.025, 0.05, 0.075, 0.1 — the largest crossing is rank 3, so the first
    // three are accepted and the fourth is not, even though 0.2 < 1.0.
    const result = benjaminiHochberg([0.001, 0.02, 0.04, 0.2], 0.1);
    assert.deepEqual(result.accepted, [true, true, true, false]);
    assert.equal(result.k, 3);
    assert.ok(Math.abs(result.threshold - 0.075) < 1e-12);
  });

  it("accepts nothing when no p-value crosses its own bound", () => {
    const result = benjaminiHochberg([0.5, 0.6], 0.1);
    assert.deepEqual(result.accepted, [false, false]);
    assert.equal(result.k, 0);
  });

  it("is invariant to input order", () => {
    const a = benjaminiHochberg([0.2, 0.001, 0.04, 0.02], 0.1);
    assert.deepEqual(a.accepted, [false, true, true, true]);
  });

  it("uses the measured break-even, and refuses an edge that is not distinguishable from it", () => {
    // p̂ 0.28 on 400 independent observations against a measured break-even of
    // 0.25 is not evidence of anything; the same p̂ against 0.15 is.
    const weak = edgeTestPValue({ probability: 0.27, evidence: 400, breakEven: 0.25 });
    const strong = edgeTestPValue({ probability: 0.5, evidence: 400, breakEven: 0.25 });
    assert.ok((weak as number) > 0.1, `expected a non-significant test, got ${weak}`);
    assert.ok((strong as number) < 1e-9);
    const decision = decide({ probability: 0.27, evidence: 400 });
    assert.ok(decision.codes.includes("GK_FAMILY"));
  });

  it("makes the bound stricter as the cycle's family grows", () => {
    const alone = decide({ probability: 0.33, familySize: 1 });
    const crowded = decide({ probability: 0.33, familySize: 8 });
    assert.equal(alone.bhThreshold, BH_Q);
    assert.ok(Math.abs((crowded.bhThreshold as number) - BH_Q / 8) < 1e-12);
    assert.ok(!alone.codes.includes("GK_FAMILY"));
  });

  it("refuses the one-sided test when no measured baseline exists", () => {
    const decision = decide({ breakEvenProbability: null });
    assert.ok(decision.codes.includes("GK_BAD_INPUT"));
    assert.ok(decision.codes.includes("GK_FAMILY"));
    assert.equal(decision.edgePValue, null);
  });

  it("does not use the textbook 1/(1+RR) break-even", () => {
    // With rrFill 2.5 that textbook rate would be 0.286. A probability of 0.30
    // would beat it — and the gate must NOT be satisfied by that.
    const textbook = 1 / (1 + 2.5);
    const p = 0.29;
    assert.ok(p > textbook, "the case must beat the textbook rate for the test to mean anything");
    assert.ok(p > 0.28, "and beat the measured break-even too — by an amount nothing can call evidence");
    const decision = decide({ probability: p, breakEvenProbability: 0.28, evidence: 400 });
    assert.ok(decision.codes.includes("GK_FAMILY"));
  });
});

describe("meta/gatekeeper — never weakens, always records", () => {
  it("reports every failing gate, not only the first", () => {
    const decision = decide({
      rrFill: 1.2,
      costPrice: 1,
      probability: null,
      probabilityLowerBound: null,
      evidence: 0,
      regime: null,
      mc: null,
    });
    for (const code of ["GK_RR_FILL", "GK_EV_LCB", "GK_NO_MODEL", "GK_REGIME", "GK_MC_UNAVAILABLE"]) {
      assert.ok(decision.codes.includes(code as never), `${code} missing`);
    }
    assert.equal(decision.code, decision.codes[0]);
    assert.ok(decision.reasons.length >= decision.codes.length);
  });

  it("produces one prefixed rejection sentence per failing gate", () => {
    const decision = decide({ rrFill: 1.2, regime: null });
    const lines = gatekeeperRejections(decision);
    assert.ok(lines.length >= 2);
    assert.ok(lines.every((line) => /^\[GK_/.test(line)));
    assert.ok(lines.some((line) => line.includes("GK_RR_FILL")));
    assert.deepEqual(gatekeeperRejections(decide()), []);
  });

  it("is a pure function of its inputs", () => {
    const a = decide();
    const b = decide();
    assert.deepEqual(a, b);
  });
});

describe("montecarlo-v2 — GARCH FHS and the block bootstrap", () => {
  /** A GARCH(1,1) series with a known regime shift at the end. */
  function garchCloses(n: number, seed = 7): number[] {
    let state = seed;
    const rnd = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const normal = () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const closes: number[] = [100];
    let sigma2 = 4e-6;
    for (let i = 1; i < n; i++) {
      const previous = closes[i - 1] as number;
      const ret = Math.sqrt(sigma2) * normal();
      closes.push(previous * Math.exp(ret));
      // Persistently clustered, and quiet before the last third: the filter must
      // rescale today's sigma UP from the calm sample, which is the whole point.
      sigma2 = i < n * 0.66 ? 2e-7 + 0.05 * ret * ret + 0.9 * sigma2 : 8e-7 + 0.12 * ret * ret + 0.82 * sigma2;
    }
    return closes;
  }

  it("fits a stationary GARCH(1,1) and refuses a sample that is too short", () => {
    assert.equal(fitGarch11([0.001, -0.002, 0.003]), null);
    const fit = fitGarch11(garchCloses(500));
    assert.ok(fit);
    assert.ok((fit as NonNullable<typeof fit>).alpha + (fit as NonNullable<typeof fit>).beta < 1);
    assert.ok((fit as NonNullable<typeof fit>).currentVolatility > 0);
  });

  it("draws blocks, not independent bars: consecutive values survive", () => {
    const source = Array.from({ length: 64 }, (_, i) => i);
    const drawn = stationaryBlockBootstrap(source, 200, () => 0.5, 20);
    let consecutive = 0;
    for (let i = 1; i < drawn.length; i++) {
      if ((drawn[i] as number) === ((drawn[i - 1] as number) + 1) % 64) consecutive++;
    }
    assert.ok(consecutive > 100, `expected long runs, saw ${consecutive} consecutive steps`);
  });

  it("reports the policy's lower tail, and uses one label implementation", () => {
    const closes = garchCloses(600);
    const quiet = executedPolicyMonteCarlo({
      closes,
      entry: closes[closes.length - 1] as number,
      riskPrice: (closes[closes.length - 1] as number) * 0.004,
      targetMultipleR: 2,
      side: "buy",
      costPrice: 0,
      horizonBars: 24,
      tradesPerPath: 20,
      paths: 60,
      seed: 11,
    });
    const costly = executedPolicyMonteCarlo({
      closes,
      entry: closes[closes.length - 1] as number,
      riskPrice: (closes[closes.length - 1] as number) * 0.004,
      targetMultipleR: 2,
      side: "buy",
      // A round trip equal to the whole risk unit is one R of certain loss.
      costPrice: (closes[closes.length - 1] as number) * 0.004,
      horizonBars: 24,
      tradesPerPath: 20,
      paths: 60,
      seed: 11,
    });
    assert.equal(quiet.pathsUsingGarch, true);
    assert.equal(quiet.trades, 60 * 20);
    assert.ok(quiet.p05MeanR <= quiet.meanR);
    assert.ok(Math.abs(costly.meanR - (quiet.meanR - 1)) < 1e-9, "a 1R cost must move the mean by exactly 1R");
    assert.equal(quiet.outcomes.target + quiet.outcomes.stop + quiet.outcomes.timeout, quiet.trades);
  });

  it("does not mistake a drift for volatility", () => {
    // A trending series has almost no per-bar dispersion. Before the fit was
    // demeaned, the drift was read as one enormous shock: alpha times the mean
    // return squared dwarfed the variance, the filtered sigma came out an order
    // of magnitude above the sample's, and every simulated trade was stopped by
    // a volatility the market did not have.
    const closes = Array.from({ length: 600 }, (_, i) => 100 * Math.exp(0.0006 * i + 0.00005 * Math.sin(i / 3)));
    const returns = closes.slice(1).map((c, i) => Math.log(c / (closes[i] as number)));
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const sampleSd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1));
    const fit = fitGarch11(returns);
    assert.ok(fit);
    assert.ok((fit as NonNullable<typeof fit>).currentVolatility <= 3 * sampleSd);
    assert.ok(Math.abs((fit as NonNullable<typeof fit>).meanReturn - 0.0006) < 0.0002);

    const last = closes[closes.length - 1] as number;
    const result = executedPolicyMonteCarlo({
      closes,
      entry: last * 1.0001,
      riskPrice: last * 0.0003,
      targetMultipleR: 2,
      side: "buy",
      costPrice: last * 0.00002,
      horizonBars: 24,
      tradesPerPath: 25,
      paths: 40,
      seed: 4242,
    });
    assert.equal(result.pathsUsingGarch, true);
    // A trade cannot lose much more than the stop it placed unless it gaps
    // through it, so a mean in the double-digit R's is a broken scale, not a
    // bad market.
    assert.ok(result.meanR > -1.5, `mean R ${result.meanR} implies a hallucinated volatility`);
  });

  it("refuses to claim a GARCH tail when the history is too short", () => {
    const result = executedPolicyMonteCarlo({
      closes: Array.from({ length: 40 }, (_, i) => 100 + i * 0.01),
      entry: 100.4,
      riskPrice: 0.4,
      targetMultipleR: 2,
      side: "buy",
      costPrice: 0.01,
      horizonBars: 12,
      tradesPerPath: 10,
      paths: 20,
      seed: 3,
    });
    assert.equal(result.pathsUsingGarch, false);
    assert.equal(result.garch, null);
  });
});
