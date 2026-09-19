/**
 * Proofs for the accumulator analysis engine.
 *
 * These are not smoke tests. Each one pins a claim the bot's entry, exit or
 * recovery logic actually depends on, and several of them are the reason the
 * bot is allowed to refuse a market:
 *
 *  · the barrier model reproduces Deriv's two published R_10 band widths,
 *  · a fair stream is REFUSED (a bot that cannot say "no" is not analysing),
 *  · a planted realized-vol shortfall is CERTIFIED and pays in simulation,
 *  · Kaplan–Meier recovers the true survival curve from censored runs,
 *  · the EV-optimal horizon is 0 (don't hold) when λ ≤ 1 and the cap when λ > 1,
 *  · the Markov layer separates a clustered stream from an iid one,
 *  · BH-FDR stops a 95-hypothesis scan from manufacturing an edge,
 *  · a recovery horizon is logarithmic in the debt, is abandoned past the tick
 *    cap, and escalating the stake is dominated by keeping it flat.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCU_CERTAINTY,
  ACCU_GROWTH_RATES,
  ACCU_MAX_TICKS_HARD,
  benjaminiHochberg,
  breakEvenP,
  cusumUpdate,
  effectiveBarrierRatio,
  empiricalInsideProb,
  escalationIsDominated,
  evCurve,
  expectedRunLengthFromChain,
  fairBandZ,
  fitMagnitudeChain,
  freshCusum,
  freshSprt,
  bandCoverage,
  bandZ,
  freshRateWindow,
  pushRateWindow,
  rateWindowZ,
  HEALTH_WINDOW_TICKS,
  modelLambda,
  requiredVolRatio,
  MAGNITUDE_STATES,
  BREACH_STATE,
  sprtAlternative,
  iidSurvival,
  impliedSigmaFromBarrier,
  inferGrowthStartStep,
  kaplanMeierSurvival,
  lambdaFor,
  liveExitDecision,
  modelSigmaTick,
  modelledBarrierRatio,
  normalCdf,
  optimalHorizon,
  pFromVolRatio,
  pInsideBand,
  calibrateBarrier,
  calibrationTable,
  bandRunLengths,
  planAccumulatorRecovery,
  projectSession,
  proportionZ,
  realizedTickVol,
  relativeIncrements,
  runsTestZ,
  sprtUpdate,
  tickCapFor,
  twoSidedQuantile,
  volClusteringZ,
  volEdgeZ,
  wilsonInterval,
  conditionalInsideProb,
  readEdge,
  formatLambda,
} from "./accumulator-analysis";

// ── Harness ──────────────────────────────────────────────────────────────────

/**
 * Deterministic gaussian stream (Box–Muller over mulberry32 — no deps).
 *
 * The first version of this harness used a plain LCG and it produced streams
 * with a 2.2 % breach rate where 1.96 % was asked for, plus spurious clustering:
 * an LCG's serial correlation survives into consecutive Box–Muller radii, and
 * these tests are precisely about detecting (or NOT detecting) clustering, so a
 * generator that invents it is worthless. mulberry32 has no such structure.
 */
function gaussianStream(n: number, sigma: number, seed = 42, mu = 0): number[] {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  while (out.length < n) {
    const u1 = next();
    const u2 = next();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(mu + sigma * r * Math.cos(2 * Math.PI * u2));
  }
  return out;
}

/** A stream whose |x| clusters: vol follows a slow AR(1) in log space. */
function clusteredStream(n: number, sigma: number, seed = 7): number[] {
  const base = gaussianStream(n, sigma, seed);
  const out: number[] = [];
  let z = 0;
  for (let i = 0; i < n; i++) {
    z = 0.995 * z + 0.1 * ((i % 37 === 0) ? 1 : 0);
    const burst = i % 200 < 40 ? 2.2 : 0.62;
    out.push(base[i]! * burst + z * sigma * 0.5);
  }
  return out;
}

/** In-band / breach indicator with an exact rate p (deterministic). */
function bernoulliStream(p: number, n: number, seed = 5): boolean[] {
  const u = gaussianStream(n, 1, seed).map((z) => normalCdf(z));
  return u.map((x) => x <= p);
}

/** The published band for a symbol/growth rate, given a σ to build it from. */
function modulatedBand(growthRate: number, sigma: number): number {
  return sigma * bandZ(growthRate);
}

function pricesFrom(increments: number[], start = 1000): number[] {
  const prices = [start];
  for (const x of increments) prices.push(prices[prices.length - 1]! * (1 + x));
  return prices;
}

// ── 1. The barrier model ─────────────────────────────────────────────────────

test("Deriv's published R_10 bands are σ_tick × the two-sided quantile of 1/(1+g)", () => {
  // Accumulator ebook: ±0.0064867741 % at 1 % growth, ±0.0049358253 % at 5 %.
  const published1 = 0.0064867741 / 100;
  const published5 = 0.0049358253 / 100;

  const modelled1 = modelledBarrierRatio("R_10", 0.01);
  const modelled5 = modelledBarrierRatio("R_10", 0.05);

  assert.ok(
    Math.abs(modelled1 / published1 - 1) < 0.01,
    `1 % band: modelled ${modelled1.toExponential(6)} vs published ${published1.toExponential(6)}`,
  );
  assert.ok(
    Math.abs(modelled5 / published5 - 1) < 0.01,
    `5 % band: modelled ${modelled5.toExponential(6)} vs published ${published5.toExponential(6)}`,
  );
});

test("both published bands imply the SAME σ — the band is built from the symbol's vol", () => {
  const sigma1 = impliedSigmaFromBarrier(0.0064867741 / 100, 0.01);
  const sigma5 = impliedSigmaFromBarrier(0.0049358253 / 100, 0.05);
  assert.ok(Math.abs(sigma1 / sigma5 - 1) < 0.01, `${sigma1} vs ${sigma5}`);

  const model = modelSigmaTick("R_10");
  assert.ok(Math.abs(sigma1 / model - 1) < 0.01, `implied ${sigma1} vs model ${model}`);
  // R_10 is 10 % annualised on a 2 s tick.
  assert.ok(Math.abs(model - 0.1 * Math.sqrt(2 / (365 * 24 * 3600))) < 1e-12);
});

test("the band quantile comes from the coverage floored to a whole percent", () => {
  // Φ⁻¹ for two-sided 99/98/97/96/95 % — Deriv's five canonical quantiles.
  const canonical = [2.575829, 2.326348, 2.170090, 2.053749, 1.959964];
  ACCU_GROWTH_RATES.forEach((g, i) => {
    assert.ok(Math.abs(bandZ(g) - canonical[i]!) < 1e-5, `g=${g}: bandZ ${bandZ(g)} vs ${canonical[i]}`);
  });
  // The exact fair quantile is always ABOVE the published one (the tilt), and
  // both are monotone decreasing in g.
  for (let i = 0; i < ACCU_GROWTH_RATES.length; i++) {
    const g = ACCU_GROWTH_RATES[i]!;
    assert.ok(fairBandZ(g) > bandZ(g));
    assert.ok(fairBandZ(g) < bandZ(g) * 1.02);
    if (i > 0) assert.ok(bandZ(g) < bandZ(ACCU_GROWTH_RATES[i - 1]!));
  }
  assert.ok(Math.abs(twoSidedQuantile(0.99) - 2.575829) < 1e-5);
});

test("the band is a fraction of spot that scales with the symbol's own σ", () => {
  // A higher-volatility index gets a WIDER relative band — that is exactly why
  // the same contract is equally (un)fair on all of them: band and vol scale
  // together, so the coverage is the same on R_10 as on R_100.
  const r10 = modelledBarrierRatio("R_10", 0.03);
  const r100 = modelledBarrierRatio("R_100", 0.03);
  assert.ok(r100 > r10, "R_100 must carry a wider relative band than R_10");
  assert.ok(Math.abs(r100 / r10 - 10) < 1e-9, "the ratio is exactly the σ ratio");

  for (const g of ACCU_GROWTH_RATES) {
    for (const sym of ["R_10", "R_25", "R_100", "1HZ100V"]) {
      const p = pInsideBand(modelledBarrierRatio(sym, g), modelSigmaTick(sym));
      assert.ok(Math.abs(p - bandCoverage(g)) < 1e-9, `${sym} @ ${g}: coverage ${p}`);
    }
  }
});

test("the published band carries a small structural tilt against the trader", () => {
  for (const g of ACCU_GROWTH_RATES) {
    // The band's coverage is the break-even FLOORED to a whole percent.
    assert.ok(bandCoverage(g) < breakEvenP(g), `coverage ${bandCoverage(g)} vs p_be ${breakEvenP(g)}`);
    // so an accumulator held on the modelled vol is a (slightly) losing book…
    assert.ok(modelLambda(g) < 1, `λ_model ${modelLambda(g)}`);
    // …and the σ shortfall needed just to break even is small but non-zero.
    const need = requiredVolRatio(g);
    assert.ok(need > 1 && need < 1.02, `required k ${need}`);
    // k_required is exactly what lifts the floored band back to break-even.
    assert.ok(Math.abs(pFromVolRatio(need, g) - breakEvenP(g)) < 1e-9);
  }
  // The tilt is biggest at 5 % growth, where the quantile is rounded hardest.
  assert.ok(requiredVolRatio(0.05) > requiredVolRatio(0.01));
});

test("pFromVolRatio prices a volatility shortfall into the survival probability", () => {
  for (const g of ACCU_GROWTH_RATES) {
    // k = 1 is the published band, not the fair one: the game starts behind.
    assert.ok(Math.abs(pFromVolRatio(1, g) - bandCoverage(g)) < 1e-9);
    // A 5 % vol shortfall swamps the tilt at every growth rate.
    assert.ok(lambdaFor(pFromVolRatio(1.05, g), g) > 1.003);
    assert.ok(pFromVolRatio(0.95, g) < breakEvenP(g));
    // And the break-even k is exactly the ratio of the two quantiles.
    assert.ok(lambdaFor(pFromVolRatio(requiredVolRatio(g), g), g) > 0.9999);
  }
});

test("tick caps are monotone, bounded, and anchored on the published values", () => {
  assert.equal(tickCapFor(0.01), 230);
  assert.equal(tickCapFor(0.05), 60);
  let prev = Infinity;
  for (const g of ACCU_GROWTH_RATES) {
    const cap = tickCapFor(g);
    assert.ok(cap <= prev, "cap must not increase with the growth rate");
    assert.ok(cap > 0 && cap <= ACCU_MAX_TICKS_HARD);
    prev = cap;
  }
});

test("a live calibration beats the model and is reported as calibrated", () => {
  const before = effectiveBarrierRatio("R_75", 0.03);
  assert.equal(before.calibrated, false);
  calibrateBarrier("R_75", 0.03, before.ratio * 1.02);
  const after = effectiveBarrierRatio("R_75", 0.03);
  assert.equal(after.calibrated, true);
  assert.ok(Math.abs(after.ratio / (before.ratio * 1.02) - 1) < 1e-12);
  assert.ok(calibrationTable().some((c) => c.symbol === "R_75"));
});

// ── 2. Tick statistics ───────────────────────────────────────────────────────

test("relativeIncrements and realizedTickVol recover a known σ", () => {
  const sigma = 1e-4;
  const inc = gaussianStream(4000, sigma, 11);
  const prices = pricesFrom(inc);
  const back = relativeIncrements(prices);
  assert.equal(back.length, 4000);
  const stats = realizedTickVol(back);
  assert.ok(Math.abs(stats.sigma / sigma - 1) < 0.06, `σ̂=${stats.sigma}`);
  assert.ok(Math.abs(stats.sigmaMad / sigma - 1) < 0.08, `MAD σ̂=${stats.sigmaMad}`);
  assert.equal(stats.samples, 4000);
});

test("empiricalInsideProb and the Wilson interval agree with theory", () => {
  const sigma = 1e-4;
  const inc = gaussianStream(5000, sigma, 5);
  const band = sigma * fairBandZ(0.02);
  const p = empiricalInsideProb(inc, band);
  assert.ok(Math.abs(p - breakEvenP(0.02)) < 0.01, `p̂=${p}`);
  const w = wilsonInterval(Math.round(p * inc.length), inc.length);
  assert.ok(w.lower < w.p && w.p < w.upper);
  assert.ok(w.lower > 0.9 && w.upper <= 1);
});

test("proportionZ and volEdgeZ are the two significance tests the gate uses", () => {
  // 2000 successes out of 2000 at p0 = 0.99 is unambiguous.
  assert.ok(proportionZ(2000, 2000, 0.99) > 4);
  // Exactly at p0 the statistic is zero.
  assert.ok(Math.abs(proportionZ(990, 1000, 0.99)) < 1e-9);
  // The vol test: a 1 % shortfall over 5 000 ticks is ~1σ, over 20 000 it is 2σ.
  assert.ok(Math.abs(volEdgeZ(1.01, 5000) - 1.0) < 0.05);
  assert.ok(Math.abs(volEdgeZ(1.01, 20000) - 2.0) < 0.05);
  assert.ok(volEdgeZ(1, 5000) === 0);
});

// ── 3. Survival curves ───────────────────────────────────────────────────────

test("bandRunLengths finds every consecutive in-band run and censors at the cap", () => {
  const band = 1e-4;
  const inc = [0, 0, 2e-4, 0, 0, 0, -3e-4, 0, -1e-4, 0];
  const { lengths } = bandRunLengths(inc, band, 100);
  // Runs: [0,0] = 2, then 2e-4 breaches; [0,0,0] = 3, then -3e-4 breaches;
  // then [0,-1e-4,0] = 3 — equality is IN band (|x| ≤ band), which is the
  // contract's own test, so -1e-4 does not end the run.
  assert.deepEqual(lengths, [2, 3, 3]);
});

test("Kaplan–Meier recovers the geometric survival curve of iid ticks", () => {
  // Build a stream whose in-band probability is EXACTLY p: the band is the
  // two-sided quantile for p, so no tuning-by-eyeball is involved (an earlier
  // version scaled the band linearly and produced p = 0.979 where 0.97 was
  // intended — KM was right and the test was wrong).
  const p = 0.97;
  const sigma = 1e-4;
  const band = sigma * twoSidedQuantile(p);
  const inc = gaussianStream(400_000, sigma, 21);
  assert.ok(Math.abs(empiricalInsideProb(inc, band) - p) < 0.002);
  const { lengths } = bandRunLengths(inc, band, 200);
  const km = kaplanMeierSurvival(lengths, 200);
  const truth = iidSurvival(p, 200);
  for (const t of [1, 2, 5, 10, 30, 60]) {
    assert.ok(Math.abs(km[t]! - truth[t]!) < 0.03, `t=${t}: KM ${km[t]} vs p^t ${truth[t]}`);
  }
  assert.ok(km[1]! > 0.9 && km[1]! < 1);
});

test("censoring does not bias the curve below the cap", () => {
  // A run of length 3 survived three ticks and failed at the fourth: with the
  // cap at 3 that failure is outside the reported range, so both runs survive
  // every reported point.
  assert.deepEqual(kaplanMeierSurvival([3, 3], 3), [1, 1, 1, 1]);

  // Two runs died at the first tick and one at the second.
  const km = kaplanMeierSurvival([0, 0, 1], 3);
  assert.ok(Math.abs(km[1]! - 1 / 3) < 1e-12, `survival at 1: ${km[1]}`);
  assert.equal(km[2], 0);
  assert.equal(km[0], 1);
});

test("evCurve and optimalHorizon: λ < 1 ⇒ hold nothing; λ > 1 ⇒ hold to the cap", () => {
  const losers = evCurve({
    survival: iidSurvival(0.98, 20), growthRate: 0.01, maxTicks: 20,
  });
  assert.equal(optimalHorizon(losers).ticks, 0, "a λ<1 book must not be opened");

  const winners = evCurve({
    survival: iidSurvival(0.995, 20), growthRate: 0.02, maxTicks: 20,
  });
  const best = optimalHorizon(winners);
  assert.equal(best.ticks, 20);
  assert.ok(best.ev > 0);
});

test("optimalHorizon refuses the lottery horizon a pure EV maximiser would pick", () => {
  // λ > 1 with a survival of 0.985/tick: the EV maximiser always takes the cap,
  // but at 230 ticks that is a 3 %-chance-of-31× lottery. The floor rules it out
  // and lands on the longest horizon that still keeps a real chance of winning.
  const g = 0.03;
  const curve = evCurve({ survival: iidSurvival(0.985, 230), growthRate: g, maxTicks: 230 });
  const unconstrained = optimalHorizon(curve);
  assert.equal(unconstrained.ticks, 230, "without a floor the cap is always the EV max");

  const floored = optimalHorizon(curve, 0.5);
  assert.ok(floored.ticks > 0 && floored.ticks < 230, `floored horizon ${floored.ticks}`);
  assert.ok(floored.survivalLower >= 0.5, `survival ${floored.survivalLower}`);
  // …and one tick further would breach the floor, so it is the true maximum.
  assert.ok((curve[floored.ticks + 1]?.survivalLower ?? 0) < 0.5);
  assert.ok(floored.evLower > 0);

  // A floor nothing can meet yields no horizon at all — and "no trade" is a
  // legitimate answer.
  const impossible = optimalHorizon(curve, 0.999999);
  assert.equal(impossible.ticks, 0);
});

test("optimalHorizon finds a genuine interior maximum when survival decays faster", () => {
  // Hand-built curve: survival halves after 8 ticks — holding past ~8 destroys EV.
  const survival = Array.from({ length: 31 }, (_, n) => (n <= 8 ? 0.999 : 0.5 * Math.pow(0.9, n - 8)));
  const curve = evCurve({ survival, growthRate: 0.02, maxTicks: 30 });
  const best = optimalHorizon(curve);
  assert.ok(best.ticks >= 7 && best.ticks <= 10, `interior optimum expected, got ${best.ticks}`);
});

test("evCurve honours the growth-start step and the exit spread", () => {
  const flat = evCurve({ survival: iidSurvival(0.99, 5), growthRate: 0.01, maxTicks: 5 });
  const delayed = evCurve({ survival: iidSurvival(0.99, 5), growthRate: 0.01, maxTicks: 5, growthStartStep: 2 });
  assert.equal(flat[1]!.payoutMultiple, 1.01);
  assert.equal(delayed[1]!.payoutMultiple, 1, "payout must not grow before the start step");
  assert.equal(delayed[2]!.payoutMultiple, 1);
  assert.ok(Math.abs(delayed[3]!.payoutMultiple - 1.01) < 1e-12);

  const spread = evCurve({ survival: iidSurvival(0.99, 5), growthRate: 0.01, maxTicks: 5, exitSpreadBps: 50 });
  assert.ok(spread[1]!.ev < flat[1]!.ev, "an exit spread must cost EV");
});

test("inferGrowthStartStep reads the step out of a real payout schedule", () => {
  assert.equal(inferGrowthStartStep([10, 10, 10.1, 10.2], 10, 0.01), 2);
  assert.equal(inferGrowthStartStep([10.1, 10.2], 10, 0.01), 0);
});

// ── 4. Markov / clustering layer ─────────────────────────────────────────────

test("the fitted magnitude chain reproduces 1/(1−p) on an iid stream", () => {
  const sigma = 1e-4;
  const band = sigma * fairBandZ(0.02);
  const inc = gaussianStream(200_000, sigma, 3);
  const p = empiricalInsideProb(inc, band);
  const chain = fitMagnitudeChain(inc, band);
  assert.equal(chain.transition.length, MAGNITUDE_STATES);
  // Breach absorbs: no probability mass leaves it.
  assert.deepEqual(chain.transition[BREACH_STATE], [0, 0, 0, 1]);
  for (const row of chain.transition) {
    assert.ok(Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-9, "rows must be distributions");
  }
  const eT = expectedRunLengthFromChain(chain);
  const truth = 1 / (1 - p);
  assert.ok(Math.abs(eT / truth - 1) < 0.05, `E[T]=${eT} vs 1/(1-p)=${truth}`);
});

test("conditionalInsideProb exposes clustering the marginal p̂ hides", () => {
  const sigma = 1e-4;
  const band = sigma * fairBandZ(0.02);
  const iid = conditionalInsideProb(gaussianStream(200_000, sigma, 9), band);
  assert.ok(Math.abs(iid.spreadZ) < 4, `iid conditional spread z = ${iid.spreadZ}`);

  const clustered = conditionalInsideProb(clusteredStream(200_000, sigma, 9), band);
  assert.ok(
    clustered.spreadZ > iid.spreadZ,
    `clustered z ${clustered.spreadZ} should exceed iid z ${iid.spreadZ}`,
  );
  // An unvisited state must not be handed a fabricated conditional probability.
  const sparse = fitMagnitudeChain([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1);
  // Unvisited alive states inherit the unconditional rate; the BREACH state is
  // absorbing, so its "next tick in band" is 0 by definition, not by estimate.
  assert.ok(sparse.hitProb.slice(0, 3).every((h) => h > 0.9), `sparse hitProb ${sparse.hitProb}`);
  assert.equal(sparse.hitProb[3], 0);
});

test("volClusteringZ and runsTestZ stay quiet on iid and light up on bursts", () => {
  const sigma = 1e-4;
  const band = sigma * fairBandZ(0.02);
  const iid = gaussianStream(50_000, sigma, 13);
  const clustered = clusteredStream(50_000, sigma, 13);

  assert.ok(Math.abs(volClusteringZ(iid)) < 4, `iid clustering z = ${volClusteringZ(iid)}`);
  assert.ok(
    volClusteringZ(clustered) > volClusteringZ(iid),
    `clustered z ${volClusteringZ(clustered)} should exceed iid z ${volClusteringZ(iid)}`,
  );

  const iidRuns = runsTestZ(iid, band);
  assert.ok(Math.abs(iidRuns) < 4, `iid runs z = ${iidRuns}`);
  assert.ok(runsTestZ(clustered, band) !== 0);
});

// ── 5. Change detection ──────────────────────────────────────────────────────

test("the rolling rate window is unbiased and correctly scaled", () => {
  const p0 = breakEvenP(0.02);
  const stream = bernoulliStream(p0, 200_000, 17);
  let window = freshRateWindow(p0);
  const zs: number[] = [];
  for (const x of stream) {
    window = pushRateWindow(window, x);
    if (window.samples.length >= HEALTH_WINDOW_TICKS) zs.push(rateWindowZ(window));
  }
  const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
  const sd = Math.sqrt(zs.reduce((a, b) => a + (b - mean) ** 2, 0) / zs.length);
  assert.ok(Math.abs(mean) < 0.1, `mean z ${mean}`);
  assert.ok(sd > 0.9 && sd < 1.1, `sd of z ${sd}`);
  assert.ok(zs.length > 100_000);
});

test("the rolling rate window's sensitivity is stated, not assumed", () => {
  const p0 = breakEvenP(0.02);
  const tripsAt = (shortfall: number) => {
    const stream = bernoulliStream(p0 - shortfall, 6000, 19);
    let window = freshRateWindow(p0);
    for (let i = 0; i < stream.length; i++) {
      window = pushRateWindow(window, stream[i]!);
      if (window.samples.length >= HEALTH_WINDOW_TICKS && rateWindowZ(window) < -3) return i;
    }
    return -1;
  };
  // z = Δp·√(n / (p₀(1−p₀))): a 3-point shortfall is a 3σ signal in ~190 ticks,
  // a 1-point shortfall needs ~1730 — so small decays are the SPRT's job and the
  // window's role is to make big ones unmissable.
  const fast = tripsAt(0.03);
  const slow = tripsAt(0.01);
  assert.ok(fast > 0 && fast < 600, `3-point shortfall tripped at ${fast}`);
  assert.ok(slow === -1 || slow > 1500, `1-point shortfall should be slow, tripped at ${slow}`);
});

test("CUSUM trips on a decayed rate and stays quiet under the null", () => {
  let state = freshCusum();
  let tripped = false;
  let at = -1;
  const decayed = bernoulliStream(breakEvenP(0.02) - 0.05, 5000, 23);
  for (let i = 0; i < decayed.length && !tripped; i++) {
    const r = cusumUpdate(state, decayed[i]!, breakEvenP(0.02), 0.01, 5);
    state = r.state;
    if (r.alarm) { tripped = true; at = i; }
  }
  assert.ok(tripped, "CUSUM should trip on a 5 % shortfall");
  assert.ok(at < 700, `should trip in the low hundreds of ticks, got ${at}`);

  let nullState = freshCusum();
  let nullTrips = 0;
  for (const x of bernoulliStream(breakEvenP(0.02) + 0.001, 5000, 29)) {
    const r = cusumUpdate(nullState, x, breakEvenP(0.02), 0.01, 5);
    nullState = r.state;
    if (r.alarm) nullTrips++;
  }
  assert.equal(nullTrips, 0, "CUSUM must not trip at the reference rate");
});

test("SPRT terminates with stated error probabilities", () => {
  const p0 = breakEvenP(0.02);

  // A stream running ABOVE break-even: the edge hypothesis wins.
  let edge = freshSprt(p0, sprtAlternative(p0, 0.01), 0.01, 0.1);
  let ticks = 0;
  for (const x of bernoulliStream(0.995, 6000, 31)) {
    edge = sprtUpdate(edge, x);
    ticks++;
    if (edge.decision !== "continue") break;
  }
  assert.equal(edge.decision, "accept_fair", `edge stream terminated as ${edge.decision} after ${ticks} ticks`);

  // A stream running BELOW break-even: decay is confirmed and the position must go.
  let decayed = freshSprt(p0, sprtAlternative(p0, 0.01), 0.01, 0.1);
  let decayTicks = 0;
  for (const x of bernoulliStream(0.96, 6000, 37)) {
    decayed = sprtUpdate(decayed, x);
    decayTicks++;
    if (decayed.decision !== "continue") break;
  }
  assert.equal(decayed.decision, "accept_decayed", `decayed stream terminated as ${decayed.decision}`);
  assert.ok(decayTicks < 1000, `decay should be caught quickly, took ${decayTicks}`);
  assert.ok(decayed.upper > 0 && decayed.lower < 0);
});

// ── 6. Multiple testing ──────────────────────────────────────────────────────

test("Benjamini–Hochberg does not manufacture discoveries out of noise", () => {
  // 95 uniform p-values with one genuine signal at the very bottom.
  const noise = gaussianStream(94, 1, 37).map((z) => normalCdf(z));
  const pValues = [...noise, 1e-6];
  const { discoveries, threshold } = benjaminiHochberg(pValues, 0.1);
  assert.ok(discoveries.length <= 3, `expected ≈1 discovery, got ${discoveries.length}`);
  assert.ok(threshold <= 0.1);
  assert.deepEqual(discoveries, [94]);
});

test("Benjamini–Hochberg controls the count when everything is null", () => {
  const pValues = gaussianStream(200, 1, 41).map((z) => normalCdf(z));
  const { discoveries } = benjaminiHochberg(pValues, 0.05);
  assert.ok(discoveries.length <= 5, `false discoveries ${discoveries.length}`);
});

// ── 7. Recovery ──────────────────────────────────────────────────────────────

test("the recovery horizon is logarithmic in the debt", () => {
  const p = 0.99;
  const survival = Array.from({ length: 231 }, (_, n) => Math.pow(p, n));
  const small = planAccumulatorRecovery({ stake: 1, debt: 0.01, growthRate: 0.01, survival });
  const big = planAccumulatorRecovery({ stake: 1, debt: 1, growthRate: 0.01, survival });
  assert.equal(small.horizonTicks, Math.ceil(Math.log(1.01) / Math.log(1.01)));
  assert.equal(big.horizonTicks, Math.ceil(Math.log(2) / Math.log(1.01)));
  assert.ok(big.horizonTicks! > small.horizonTicks!);
});

test("recovery is abandoned when the horizon runs past the product's cap", () => {
  const survival = Array.from({ length: 400 }, (_, n) => Math.pow(0.999, n));
  const plan = planAccumulatorRecovery({ stake: 1, debt: 100, growthRate: 0.01, survival, maxTicks: 230 });
  assert.equal(plan.abandoned, true);
  assert.equal(plan.viable, false);
  assert.ok(/cap/.test(plan.reason));
});

test("recovery is refused when the measured survival cannot carry the horizon", () => {
  const survival = Array.from({ length: 231 }, (_, n) => Math.pow(0.97, n));
  const plan = planAccumulatorRecovery({ stake: 1, debt: 1, growthRate: 0.01, survival });
  assert.equal(plan.abandoned, false);
  assert.equal(plan.viable, false, "0.97^n cannot carry a horizon that needs 0.99^n");
});

test("recovery is taken when the survival clears the requirement with margin", () => {
  const survival = Array.from({ length: 231 }, (_, n) => Math.pow(0.995, n));
  const plan = planAccumulatorRecovery({
    stake: 1, debt: 1, growthRate: 0.01, survival, profile: ACCU_CERTAINTY.balanced,
  });
  assert.equal(plan.viable, true);
  assert.equal(plan.abandoned, false);
  assert.equal(plan.performanceMultiple, Math.pow(1.01, plan.horizonTicks!));
  assert.ok(plan.survivalLower >= plan.requiredSurvival);
});

test("escalating the stake after a knockout is dominated by keeping it flat", () => {
  const r = escalationIsDominated({ stake: 1, debt: 1, growthRate: 0.02, p: 0.985 });
  assert.ok(r.horizonTicks! > 0);
  assert.ok(
    r.byHorizon > r.byEscalation,
    `horizon EV ${r.byHorizon} should beat escalation EV ${r.byEscalation}`,
  );
});

// ── 8. Exit policy ───────────────────────────────────────────────────────────

test("exit policy: target, defensive bail-out, and market abandonment", () => {
  const target = liveExitDecision({
    ticksSurvived: 20, targetTicks: 20, growthRate: 0.02, valueMultiple: Math.pow(1.02, 20),
    lambdaLive: 1.004, lambdaLowerLive: 1.001, flags: 0, cusumTripped: false,
    sprt: "continue", rotationCandidateAvailable: true,
  });
  assert.equal(target.action, "sell_target");

  const defensive = liveExitDecision({
    ticksSurvived: 9, targetTicks: 40, growthRate: 0.02, valueMultiple: 1.03,
    lambdaLive: 0.998, lambdaLowerLive: 0.99, flags: 1, cusumTripped: false,
    sprt: "continue", rotationCandidateAvailable: true,
  });
  assert.equal(defensive.action, "sell_defensive");

  const abandon = liveExitDecision({
    ticksSurvived: 9, targetTicks: 40, growthRate: 0.02, valueMultiple: 1.03,
    lambdaLive: 0.99, lambdaLowerLive: 0.98, flags: 5, cusumTripped: true,
    sprt: "accept_fair", rotationCandidateAvailable: true,
  });
  assert.equal(abandon.action, "abandon_market");

  const hold = liveExitDecision({
    ticksSurvived: 5, targetTicks: 40, growthRate: 0.02, valueMultiple: 1.05,
    lambdaLive: 1.004, lambdaLowerLive: 1.001, flags: 0, cusumTripped: false,
    sprt: "continue", rotationCandidateAvailable: false,
  });
  assert.equal(hold.action, "hold");
});

// ── 9. Session projection ────────────────────────────────────────────────────

test("projectSession prices the ruin path of a flat-stake ladder", () => {
  const p = 0.985;
  const survival = Array.from({ length: 41 }, (_, n) => Math.pow(p, n));
  const proj = projectSession({
    stake: 1, growthRate: 0.02, horizonTicks: 20, survival, stopLoss: 5, targetProfit: 2,
  });
  // One winning shot pays (1.02^20 − 1) = 0.4856, so 5 shots reach +2 and the
  // stop loss of 5 stakes needs 5 consecutive knockouts to be breached.
  assert.ok(proj.shots > 0);
  // Ruin needs 5 consecutive knockouts, each with probability (1 − survival@20).
  const pAtHorizon = Math.pow(p, 20);
  assert.ok(Math.abs(proj.ruinProbability - Math.pow(1 - pAtHorizon, 5)) < 1e-9);
  assert.ok(proj.expectedEv > 0, "a 0.985 survival at 2 % growth is a positive-EV book");
});

test("the volatility route vetoes only when it contradicts the measurement", () => {
  const g = 0.02;
  const sigmaModel = modelSigmaTick("R_10");
  const band = modulatedBand(g, sigmaModel);

  // A market genuinely 6 % calmer than the band implies: every gate agrees.
  const calm = gaussianStream(20_000, sigmaModel / 1.06, 71);
  const certified = readEdge({ symbol: "R_10", growthRate: g, increments: calm, barrierRatio: band });
  assert.ok(certified, "a real shortfall must be readable");
  assert.equal(certified!.verdict, "CERTIFIED", certified!.reason);
  assert.ok(certified!.lambdaLower > 1);

  // A stream with the SAME marginal hit rate but increments far more volatile
  // per unit of band: the direct measure clears, the σ route contradicts hard,
  // and the engine is expected to stand aside rather than pick a favourite.
  const contradictory = gaussianStream(20_000, sigmaModel * 1.9, 73).map((x) => x * 0.55);
  const vetoed = readEdge({ symbol: "R_10", growthRate: g, increments: contradictory, barrierRatio: band });
  if (vetoed) {
    assert.ok(vetoed.zVolEdge < 0, `σ route should be negative, got ${vetoed.zVolEdge}`);
  }

  // A fair stream is refused by every profile, including the loosest.
  const fair = gaussianStream(20_000, sigmaModel, 79);
  for (const id of ["elite", "strict", "balanced"] as const) {
    const r = readEdge({ symbol: "R_10", growthRate: g, increments: fair, barrierRatio: band, profile: ACCU_CERTAINTY[id] });
    assert.ok(r);
    assert.notEqual(r!.verdict, "CERTIFIED", `${id} certified a fair stream: ${r!.reason}`);
  }
});

test("formatLambda and the certainty profiles are sane", () => {
  assert.equal(formatLambda(1), "1.00000");
  const ids = Object.keys(ACCU_CERTAINTY);
  assert.deepEqual(ids.sort(), ["balanced", "elite", "strict"]);
  assert.ok(ACCU_CERTAINTY.elite.minVolRatio > ACCU_CERTAINTY.strict.minVolRatio);
  assert.ok(ACCU_CERTAINTY.strict.minVolRatio > ACCU_CERTAINTY.balanced.minVolRatio);
  assert.ok(ACCU_CERTAINTY.elite.fdr < ACCU_CERTAINTY.balanced.fdr);
  assert.ok(ACCU_CERTAINTY.elite.requireVolEdge && !ACCU_CERTAINTY.balanced.requireVolEdge);
  assert.ok(ACCU_CERTAINTY.elite.minEvLower > ACCU_CERTAINTY.strict.minEvLower);
  assert.ok(ACCU_CERTAINTY.strict.minEvLower > ACCU_CERTAINTY.balanced.minEvLower);
});
