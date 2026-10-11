/**
 * WP3 — regime agent tests.
 *
 * The acceptance criterion for this work package is "≥ 80% accuracy on
 * simulated 3-regime data", and the honest way to test that is with a series
 * that has GROUND TRUTH and a measured CEILING:
 *
 *   • the labelled three-regime generator emits the regime it was in at every
 *     bar, so accuracy is a comparison against the truth rather than against
 *     another model;
 *   • the same test also fits a SUPERVISED filter (the true generative
 *     parameters, given the labels) and reports its accuracy as the ceiling for
 *     that series. A causal detector needs a few bars of evidence to notice a
 *     switch, so even a perfect model misclassifies the bars right after one;
 *     if the ceiling itself were below 80% the test would be measuring the
 *     generator, not the detector, and that distinction is asserted, not
 *     assumed.
 *
 * The rest of the file pins the properties the live desk relies on: causality
 * (the future cannot change a past posterior), determinism, sensible labels,
 * and the three-condition permission with its reason codes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_REGIME_HMM_CONFIG,
  expectedDwellBars,
  featuresFromBars,
  FEATURE_NAMES,
  filterPosterior,
  fitHmm,
  labelStates,
  linearSlope,
  trendScore,
  regimePermit,
  requiredRegimeFor,
  viterbiPath,
  type HmmModel,
  type RegimeState,
} from "./regime-hmm";
import { DEFAULT_GENERATOR_SPEC, generate, type ThreeRegimeLabel } from "./research/generators";
import { gaussian, makeRng } from "./math";
import type { Bar } from "./types";

const START = Date.UTC(2026, 0, 5);
const W = 15 * 60_000;
const TRUTH_LABELS: ThreeRegimeLabel[] = ["bull", "bear", "range"];

function threeRegimeSeries(seed: number, bars = 3000, overrides: Record<string, number> = {}) {
  const series = generate("three-regime", {
    ...DEFAULT_GENERATOR_SPEC,
    seed,
    bars,
    timeframeMs: W,
    startMs: START,
    volatility: 0.0008,
    ...overrides,
  });
  return { bars: series.bars, labels: series.regimeLabels as ThreeRegimeLabel[] };
}

/**
 * Fit on the first half, filter the second half causally, and score against the
 * truth. The state→truth mapping is learned on the TRAINING half only.
 */
function heldOutAccuracy(seed: number, config: Partial<typeof DEFAULT_REGIME_HMM_CONFIG> = {}) {
  const { bars, labels } = threeRegimeSeries(seed);
  const features = featuresFromBars(bars, config);
  const split = Math.floor(features.matrix.length * 0.5);
  const model = fitHmm(features.matrix.slice(0, split), config);

  const mapping = new Map<ThreeRegimeLabel, number>();
  const train = filterPosterior(model, features.matrix.slice(0, split));
  for (const truth of TRUTH_LABELS) {
    const histogram = new Array(model.states).fill(0);
    for (let j = 0; j < split; j++) {
      if (labels[features.startIndex + j] !== truth) continue;
      const posterior = train.posteriors[j] as number[];
      histogram[posterior.indexOf(Math.max(...posterior))]++;
    }
    mapping.set(truth, histogram.indexOf(Math.max(...histogram)));
  }

  const test = filterPosterior(model, features.matrix.slice(split));
  let correct = 0;
  let total = 0;
  for (let j = 0; j < test.posteriors.length; j++) {
    const truth = labels[features.startIndex + split + j];
    if (!truth) continue;
    const posterior = test.posteriors[j] as number[];
    total++;
    if (posterior.indexOf(Math.max(...posterior)) === mapping.get(truth)) correct++;
  }
  return { accuracy: total === 0 ? 0 : correct / total, model, features, labels, mapping, split };
}

/**
 * The SUPERVISED ceiling for the same series: the true generative parameters,
 * estimated from the labels on the training half, filtered causally forward.
 */
function supervisedCeiling(seed: number): number {
  const { bars, labels } = threeRegimeSeries(seed);
  const features = featuresFromBars(bars, {});
  const rows = features.matrix;
  const split = Math.floor(rows.length * 0.5);
  const dims = (rows[0] as number[]).length;

  const means: number[][] = [];
  const variances: number[][] = [];
  for (const truth of TRUTH_LABELS) {
    const subset = rows.slice(0, split).filter((_, j) => labels[features.startIndex + j] === truth);
    const m = new Array<number>(dims).fill(0);
    for (const row of subset) for (let d = 0; d < dims; d++) (m[d] as number) += (row[d] as number) / subset.length;
    const v = new Array<number>(dims).fill(0);
    for (const row of subset) {
      for (let d = 0; d < dims; d++) (v[d] as number) += ((row[d] as number) - (m[d] as number)) ** 2 / subset.length;
    }
    means.push(m);
    variances.push(v);
  }

  const pStay = 0.99;
  const transition = Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) => (i === j ? pStay : (1 - pStay) / 2)),
  );
  let alpha = [1 / 3, 1 / 3, 1 / 3].map((p) => Math.log(p));
  let correct = 0;
  let total = 0;
  const logAdd = (a: number, b: number): number => {
    if (a === -Infinity) return b;
    if (b === -Infinity) return a;
    const m = Math.max(a, b);
    return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
  };
  for (let j = split; j < rows.length; j++) {
    const row = rows[j] as number[];
    const next = new Array<number>(3).fill(-Infinity);
    for (let s = 0; s < 3; s++) {
      let logPrior = -Infinity;
      for (let p = 0; p < 3; p++) logPrior = logAdd(logPrior, (alpha[p] as number) + Math.log(transition[p]?.[s] as number));
      let emission = 0;
      for (let d = 0; d < dims; d++) {
        const variance = Math.max(1e-12, (variances[s] as number[])[d] as number);
        const delta = (row[d] as number) - ((means[s] as number[])[d] as number);
        emission += -0.5 * (Math.log(2 * Math.PI * variance) + (delta * delta) / variance);
      }
      next[s] = logPrior + emission;
    }
    let totalLog = -Infinity;
    for (const v of next) totalLog = logAdd(totalLog, v);
    alpha = next.map((v) => v - totalLog);
    const truth = labels[features.startIndex + j];
    if (!truth) continue;
    total++;
    if (alpha.indexOf(Math.max(...alpha)) === TRUTH_LABELS.indexOf(truth)) correct++;
  }
  return total === 0 ? 0 : correct / total;
}

// ── The accuracy gate ───────────────────────────────────────────────────────

test("the labelled generator is not the limiting factor: the supervised ceiling clears 80%", () => {
  for (const seed of [1, 2, 3]) {
    const ceiling = supervisedCeiling(seed);
    assert.ok(
      ceiling >= 0.8,
      `seed ${seed}: the true parameters only recover ${(ceiling * 100).toFixed(1)}% of the regimes — the 80% gate would be measuring the generator, not the detector`,
    );
  }
});

test("the fitted model recovers the regimes causally at ≥ 80%, within 10 points of the ceiling", () => {
  const results = [1, 2, 3, 4].map((seed) => ({ seed, ...heldOutAccuracy(seed) }));
  for (const result of results) {
    const ceiling = supervisedCeiling(result.seed);
    const accuracy = result.accuracy;
    assert.ok(
      accuracy >= 0.8,
      `seed ${result.seed}: causal accuracy ${(accuracy * 100).toFixed(1)}% (ceiling ${(ceiling * 100).toFixed(1)}%)`,
    );
    assert.ok(
      accuracy >= ceiling - 0.1,
      `seed ${result.seed}: the fitted model (${(accuracy * 100).toFixed(1)}%) is far below what the data allows (${(ceiling * 100).toFixed(1)}%) — that is a fitting failure, not a detection limit`,
    );
  }
});

test("the fitted labels are a permutation of the three regimes, ordered by mean drift", () => {
  const { model } = heldOutAccuracy(2);
  assert.equal(model.labels.filter((l) => l === "trend_up").length, 1);
  assert.equal(model.labels.filter((l) => l === "trend_down").length, 1);
  const up = model.labels.indexOf("trend_up");
  const down = model.labels.indexOf("trend_down");
  // Feature 1 is the cumulative drift: up must out-drift down, and both must be
  // separated from the range state.
  assert.ok((model.means[up] as number[])[1]! > (model.means[down] as number[])[1]!);
  assert.ok((model.means[up] as number[])[1]! > 0);
  assert.ok((model.means[down] as number[])[1]! < 0);
});

test("the range state is the quiet one", () => {
  const { model } = heldOutAccuracy(3);
  const rangeIndex = model.labels.indexOf("range");
  if (rangeIndex >= 0) {
    const trendVol = [model.labels.indexOf("trend_up"), model.labels.indexOf("trend_down")].map(
      (i) => (model.means[i] as number[])[2] as number,
    );
    const rangeVol = (model.means[rangeIndex] as number[])[2] as number;
    assert.ok(rangeVol <= Math.max(...trendVol), `range vol ${rangeVol.toFixed(2)} vs trends ${trendVol.join("/")}`);
  }
});

// ── Properties the live desk depends on ────────────────────────────────────

test("inference is causal: replacing the future cannot change a past posterior", () => {
  const { bars } = threeRegimeSeries(9, 800);
  const features = featuresFromBars(bars, {});
  const model = fitHmm(features.matrix.slice(0, 300), {});
  const cut = 400;
  const truncated = filterPosterior(model, features.matrix.slice(0, cut));

  // Mutate every row after `cut` and re-filter: the past must be untouched.
  const mutated = features.matrix.map((row, j) =>
    j <= cut ? row : row.map((v, d) => (d === 1 ? 50 : v * 4)),
  );
  const full = filterPosterior(model, mutated);
  for (let j = 0; j < cut; j++) {
    assert.equal(
      JSON.stringify(full.posteriors[j]),
      JSON.stringify(truncated.posteriors[j]),
      `posterior at row ${j} changed when the FUTURE changed — lookahead`,
    );
  }
  // …and the future really was different.
  assert.notEqual(JSON.stringify(full.posteriors[cut + 5]), JSON.stringify(truncated.posteriors[cut + 5]));
});

test("the model is deterministic: identical input, identical parameters", () => {
  const { bars } = threeRegimeSeries(4, 900);
  const features = featuresFromBars(bars, {});
  const a = fitHmm(features.matrix.slice(0, 400), {});
  const b = fitHmm(features.matrix.slice(0, 400), {});
  assert.equal(JSON.stringify(a.means), JSON.stringify(b.means));
  assert.equal(JSON.stringify(a.variances), JSON.stringify(b.variances));
  assert.equal(JSON.stringify(a.transition), JSON.stringify(b.transition));
  assert.equal(a.logLikelihood, b.logLikelihood);
});

test("EM improves the likelihood, and the variance floor prevents a degenerate fit", () => {
  const { bars } = threeRegimeSeries(5, 900);
  const features = featuresFromBars(bars, {});
  const rows = features.matrix.slice(0, 400);
  const quick = fitHmm(rows, { maxIter: 1, restarts: 1 });
  const converged = fitHmm(rows, { maxIter: 25, restarts: 1 });
  assert.ok(converged.logLikelihood >= quick.logLikelihood, "more EM iterations must not lower the likelihood");
  for (const state of converged.variances) {
    for (const variance of state) {
      assert.ok(Number.isFinite(variance) && variance >= DEFAULT_REGIME_HMM_CONFIG.minVariance);
    }
  }
  for (const row of converged.transition) {
    const total = row.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `transition row sums to ${total}`);
  }
});

test("the expected dwell matches the fitted self-transition, and the three-regime fit is persistent", () => {
  const { model } = heldOutAccuracy(1);
  for (let s = 0; s < model.states; s++) {
    const stay = (model.transition[s] as number[])[s] as number;
    assert.ok(Math.abs(expectedDwellBars(model, s) - 1 / (1 - stay)) < 1e-6);
  }
  const up = model.labels.indexOf("trend_up");
  assert.ok(
    expectedDwellBars(model, up) > 30,
    `a p_stay-0.99 series must show a persistent state (got ${expectedDwellBars(model, up).toFixed(0)} bars)`,
  );
});

test("features are finite and complete, and one-bar windows do not divide by zero", () => {
  const { bars } = threeRegimeSeries(6, 400);
  const features = featuresFromBars(bars, {});
  assert.equal(features.matrix.length, bars.length - features.startIndex);
  for (const row of features.matrix) {
    assert.equal(row.length, 5);
    for (const value of row) assert.ok(Number.isFinite(value), `non-finite feature: ${JSON.stringify(row)}`);
  }
  assert.equal(linearSlope([1, 2, 3]), 1);
  assert.equal(linearSlope([5]), 0);
  // Too little history: an empty matrix, not a crash.
  const tiny = featuresFromBars(bars.slice(0, 20), {});
  assert.equal(tiny.matrix.length, 0);
});

test("viterbi returns a valid state path over the whole series", () => {
  const { bars } = threeRegimeSeries(7, 700);
  const features = featuresFromBars(bars, {});
  const model = fitHmm(features.matrix.slice(0, 300), {});
  const path = viterbiPath(model, features.matrix);
  assert.equal(path.length, features.matrix.length);
  for (const state of path) assert.ok(state >= 0 && state < model.states);
});

// ── The permission ──────────────────────────────────────────────────────────

test("a persistent up-trend permits buys and never permits sells", () => {
  // Walk the tape the way the desk does — always the bars up to the decision
  // point — across the bull runs of four seeds and count the permits. The
  // classifier is what the 80% accuracy gate measures; this test measures the
  // PERMISSION, which is the number the desk actually acts on.
  let buys = 0;
  let total = 0;
  let sells = 0;
  for (const seed of [1, 2, 4, 5]) {
    const { bars, labels } = threeRegimeSeries(seed, 1500);
    let runStart = bars.length - 1;
    while (runStart > 100 && labels[runStart] !== "bull") runStart--;
    while (runStart > 0 && labels[runStart - 1] === "bull") runStart--;
    let runEnd = runStart;
    while (runEnd < bars.length - 1 && labels[runEnd + 1] === "bull") runEnd++;
    // 20 bars is the model's detection lag: it must SEE the new regime before it
    // may permit it, and it may not permit anything before that.
    for (let cut = runStart + 20; cut <= runEnd; cut += 4) {
      const window = bars.slice(0, cut);
      total++;
      if (regimePermit({ bars: window, mode: "intraday", side: "buy" }).permit) buys++;
      if (regimePermit({ bars: window, mode: "intraday", side: "sell" }).permit) sells++;
    }
  }
  // Measured 87–100% per seed; the floor is deliberately below every one of them.
  assert.ok(buys / total >= 0.75, `only ${buys}/${total} bull-regime bars permitted a buy`);
  assert.equal(sells, 0, "a short was permitted inside a bull regime");
});

test("nothing is permitted on a driftless tape", () => {
  // The WP2 baseline armed on 4–17% of pure noise. This is the property that
  // makes the regime layer worth its cost: on data with no trend, the model
  // does not label a trend (the drift of every state stays inside a random
  // walk's own noise — see trendScore), so no direction is ever permitted.
  for (const kind of ["driftless", "block-shuffled"] as const) {
    for (const seed of [1, 2]) {
      const series = generate(kind, {
        ...DEFAULT_GENERATOR_SPEC,
        seed,
        bars: 700,
        timeframeMs: W,
        startMs: START,
        volatility: 0.0008,
      });
      for (let cut = 620; cut <= 700; cut += 20) {
        const bars = series.bars.slice(0, cut);
        for (const side of ["buy", "sell"] as const) {
          const permit = regimePermit({ bars, mode: "intraday", side });
          assert.equal(permit.permit, false, `${kind} seed ${seed} cut ${cut} ${side}: ${permit.reason}`);
        }
      }
    }
  }
});

test("too little history refuses with REGIME_UNAVAILABLE rather than guessing", () => {
  const { bars } = threeRegimeSeries(3, 300);
  const permit = regimePermit({ bars: bars.slice(0, 40), mode: "intraday", side: "buy" });
  assert.equal(permit.permit, false);
  assert.deepEqual(permit.codes, ["REGIME_UNAVAILABLE"]);
  assert.match(permit.reason, /unavailable/i);
});

test("the dwell condition bites on a short-lived regime", () => {
  // p_stay 0.95 ⇒ ~20-bar regimes, which cannot cover a 36-bar intraday hold.
  const { bars } = threeRegimeSeries(2, 1200, { regimePStay: 0.95 });
  const permit = regimePermit({
    bars,
    mode: "intraday",
    side: "buy",
    // Isolate the dwell condition: the other two are switched off.
    config: { minStateProbability: 0, maxChangeProbability: 1 },
  });
  assert.equal(permit.permit, false, permit.reason);
  assert.ok(permit.codes.includes("DWELL_TOO_SHORT"), permit.codes.join(","));
  assert.match(permit.reason, /expected dwell/);
});

test("the change-point veto fires after a fresh break", () => {
  // 400 quiet bars, then a violent break: whatever the model was, it no longer is.
  const rng = makeRng(31);
  const quiet: Bar[] = [...Array(400)].map((_, i) => {
    const price = 1.1 + gaussian(rng) * 0.0002;
    return [START + i * W, price, price + 0.0002, price - 0.0002, price, 100];
  });
  // Two bars is what "recent" means here: the veto asks whether a change point
  // happened within the last `changeRecentBars`, and a BOCPD run length that has
  // already aged past the window is correctly no longer recent.
  const broken: Bar[] = [...Array(2)].map((_, i) => {
    const price = 1.1 + (i + 1) * 0.004;
    return [START + (400 + i) * W, price, price + 0.0004, price - 0.0002, price + 0.0003, 100];
  });
  const permit = regimePermit({
    bars: [...quiet, ...broken],
    mode: "intraday",
    side: "buy",
    config: { minStateProbability: 0, maxChangeProbability: 0.3 },
  });
  assert.equal(permit.permit, false, permit.reason);
  assert.ok(permit.codes.includes("CHANGEPOINT_RECENT"), permit.codes.join(","));
  assert.match(permit.reason, /change point/);
});

test("requiredRegimeFor matches the direction, and the config overrides it", () => {
  assert.equal(requiredRegimeFor("buy", "intraday"), "trend_up");
  assert.equal(requiredRegimeFor("sell", "swing"), "trend_down");
  const { bars } = threeRegimeSeries(2, 1500);
  const overridden = regimePermit({ bars, mode: "intraday", side: "buy", requiredState: "range" });
  assert.equal(overridden.required, "range");
});

test("the posterior is reported by label, sums to one, and agrees with the headline state", () => {
  const { bars } = threeRegimeSeries(4, 1500);
  const permit = regimePermit({ bars, mode: "intraday", side: "buy" });
  const total = Object.values(permit.posterior).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `posterior sums to ${total}`);
  for (const [label, probability] of Object.entries(permit.posterior)) {
    assert.ok((["trend_up", "trend_down", "range", "volatile"] as const).includes(label as RegimeState));
    assert.ok(probability >= 0 && probability <= 1, `${label} = ${probability}`);
  }
  const best = Object.entries(permit.posterior).sort((a, b) => b[1] - a[1])[0] as [string, number];
  assert.equal(permit.state, best[0], "the reported state must be the most probable label");
  assert.ok(
    permit.fit.bars > 100 && permit.fit.bars <= DEFAULT_REGIME_HMM_CONFIG.fitBars,
    `fit saw ${permit.fit.bars} bars`,
  );
  assert.ok(Number.isFinite(permit.fit.logLikelihood), `log-likelihood ${permit.fit.logLikelihood}`);
  assert.ok(permit.fit.iterations >= 1 && permit.fit.iterations <= DEFAULT_REGIME_HMM_CONFIG.maxIter);
});

test("labels are derived from the fitted parameters, not from the state index", () => {
  // ret_z is feature 0, vol_ratio is feature 2. With a self-transition of 0.98
  // the dwell is 50 bars, so a mean return of 0.35σ/bar scores 0.35 × √50 ≈ 2.5
  // — a significant drift — while 0.05σ/bar scores 0.35 and is just noise.
  const sticky = [
    [0.98, 0.01, 0.01],
    [0.01, 0.98, 0.01],
    [0.01, 0.01, 0.98],
  ];
  const base: HmmModel = {
    states: 3,
    means: [
      [0.35, 1.75, 1, 1.5, 0],
      [0.05, 0.25, 0.6, 0, 0],
      [-0.35, -1.75, 1, -1.5, 0],
    ],
    variances: [
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ],
    transition: sticky,
    initial: [1 / 3, 1 / 3, 1 / 3],
    labels: [],
    logLikelihood: -100,
    iterations: 5,
    observations: 500,
    featureNames: FEATURE_NAMES,
  };
  assert.deepEqual(labelStates(base), ["trend_up", "range", "trend_down"]);
  const mirrored: HmmModel = { ...base, means: [...base.means].reverse() };
  assert.deepEqual(labelStates(mirrored), ["trend_down", "range", "trend_up"]);
  // The quiet middle state becomes "volatile" when it is the most volatile one.
  const volatileRange: HmmModel = {
    ...base,
    means: [
      [0.35, 1.75, 1, 1.5, 0],
      [0.05, 0.25, 2.5, 0, 0],
      [-0.35, -1.75, 1, -1.5, 0],
    ],
  };
  assert.deepEqual(labelStates(volatileRange), ["trend_up", "volatile", "trend_down"]);
});

test("a drift that a random walk could produce is NOT called a trend", () => {
  // Two quiet states and one mildly persistent one: 0.4σ of drift over a
  // 50-bar dwell is squarely inside a random walk's own noise (√50 ≈ 7σ), so
  // nothing here is a trend and every state must be labelled range/volatile.
  const model: HmmModel = {
    states: 3,
    means: [
      [0.04, 0.2, 1, 0, 0],
      [0.02, 0.1, 0.6, 0, 0],
      [-0.03, -0.15, 1.4, 0, 0],
    ],
    variances: [
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ],
    transition: [
      [0.98, 0.01, 0.01],
      [0.01, 0.98, 0.01],
      [0.01, 0.01, 0.98],
    ],
    initial: [1 / 3, 1 / 3, 1 / 3],
    labels: [],
    logLikelihood: -100,
    iterations: 5,
    observations: 500,
    featureNames: FEATURE_NAMES,
  };
  const labels = labelStates(model);
  assert.ok(!labels.includes("trend_up"), `labelled a noise state as an up-trend: ${labels.join(",")}`);
  assert.ok(!labels.includes("trend_down"), `labelled a noise state as a down-trend: ${labels.join(",")}`);
  assert.deepEqual([...labels].sort(), ["range", "range", "volatile"]);
});

test("a dwell longer than the sample cannot inflate the trend score", () => {
  // A degenerate fit can push a self-transition to 0.999999 (a 10^6-bar dwell).
  // The score caps the dwell at the number of observations, so a 0.05σ/bar drift
  // cannot become a "trend" through an unmeasurable persistence.
  const model: HmmModel = {
    states: 3,
    means: [
      [0.05, 0.25, 1, 0, 0],
      [0.04, 0.2, 0.6, 0, 0],
      [0.03, 0.15, 1.4, 0, 0],
    ],
    variances: [
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ],
    transition: [
      [0.999999, 5e-7, 5e-7],
      [5e-7, 0.999999, 5e-7],
      [5e-7, 5e-7, 0.999999],
    ],
    initial: [1 / 3, 1 / 3, 1 / 3],
    labels: [],
    logLikelihood: -100,
    iterations: 5,
    observations: 120,
    featureNames: FEATURE_NAMES,
  };
  assert.ok(trendScore(model, 0) < DEFAULT_REGIME_HMM_CONFIG.trendScoreThreshold);
  assert.ok(!labelStates(model).includes("trend_up"));
});
