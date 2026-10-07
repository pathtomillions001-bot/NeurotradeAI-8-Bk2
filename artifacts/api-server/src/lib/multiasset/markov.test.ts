/**
 * Markov model tests.
 *
 * The agent uses persistence to decide whether a favourable state is likely
 * to survive long enough for the trade to reach target. If the matrix is
 * wrong — or falsely confident from a handful of bars — the A+ gate lets
 * through trades with no staying power.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { logReturns, makeRng } from "./math";
import {
  MARKOV_STATES,
  classifyReturns,
  directionalPersistence,
  expectedDriftSigma,
  fitMarkov,
  markovFromPrices,
  nStepDistribution,
  sampleConfidence,
  stationaryDistribution,
  type MarkovState,
} from "./markov";

test("every transition matrix row is a probability distribution", () => {
  const sequence: MarkovState[] = ["up", "up", "flat", "down", "up", "strong_up", "flat"];
  const model = fitMarkov(sequence);
  for (const [i, row] of model.matrix.entries()) {
    const total = row.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `row ${i} sums to ${total}`);
    for (const p of row) assert.ok(p >= 0 && p <= 1);
  }
});

test("Laplace smoothing keeps unseen transitions strictly positive", () => {
  // A sequence that only ever goes up→up would otherwise assign probability
  // exactly zero to every other move — false certainty from tiny samples.
  const model = fitMarkov(new Array(12).fill("up") as MarkovState[]);
  const upIndex = MARKOV_STATES.indexOf("up");
  for (const p of model.matrix[upIndex]) assert.ok(p > 0);
  // Still, the observed transition must dominate: (11+1)/(11+5) = 0.75.
  assert.ok(model.matrix[upIndex][upIndex] > 0.5);
  // And an unseen transition stays small rather than merely non-zero.
  assert.ok(model.matrix[upIndex][MARKOV_STATES.indexOf("strong_down")] < 0.1);
});

test("raw counts are preserved alongside the smoothed matrix", () => {
  const model = fitMarkov(["up", "flat", "up", "flat"]);
  const up = MARKOV_STATES.indexOf("up");
  const flat = MARKOV_STATES.indexOf("flat");
  assert.equal(model.counts[up][flat], 2);
  assert.equal(model.counts[flat][up], 1);
  assert.equal(model.samples, 3);
});

test("classification is directional and measured against zero, not the mean", () => {
  // Quiet noise with one large move either side: the outliers must land in
  // the strong buckets and the noise in flat.
  const returns = [
    ...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.0004 : -0.0004)),
    0.01,
    -0.01,
  ];
  const states = classifyReturns(returns);
  assert.equal(states.length, returns.length);
  assert.equal(states[states.length - 2], "strong_up");
  assert.equal(states[states.length - 1], "strong_down");
  assert.equal(states[0], "flat");
});

test("a steady uptrend is classified as rising, not flat", () => {
  // De-meaning would make every return sit at its own mean and report
  // "flat" — the bug that made persistence blind to trends.
  const prices = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(0.002 * i));
  const states = classifyReturns(logReturns(prices));
  // Floating-point noise leaves a vanishing but non-zero sd, so the uniform
  // return can land in either rising bucket. What matters is that NOTHING is
  // classified flat or falling.
  assert.ok(
    states.every((s) => s === "up" || s === "strong_up"),
    `got ${[...new Set(states)].join(",")}`,
  );
});

test("a constant decline is classified as falling", () => {
  const prices = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(-0.002 * i));
  const states = classifyReturns(logReturns(prices));
  assert.ok(
    states.every((s) => s === "down" || s === "strong_down"),
    `got ${[...new Set(states)].join(",")}`,
  );
});

test("a zero-variance series is entirely flat rather than NaN", () => {
  const states = classifyReturns([0, 0, 0, 0]);
  assert.deepEqual(states, ["flat", "flat", "flat", "flat"]);
});

test("the n-step distribution stays normalised at every horizon", () => {
  const model = markovFromPrices([100, 101, 102, 101, 103, 104, 103, 105, 106, 107]);
  for (const steps of [0, 1, 5, 20, 100]) {
    const dist = nStepDistribution(model, steps);
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `steps=${steps} sums to ${total}`);
  }
});

test("zero steps returns the current state with certainty", () => {
  const model = fitMarkov(["flat", "up"]);
  const dist = nStepDistribution(model, 0);
  assert.equal(dist.up, 1);
  assert.equal(dist.flat, 0);
});

test("a persistent uptrend yields high upward persistence", () => {
  // A strongly trending series: most transitions stay in up states.
  const prices = Array.from({ length: 200 }, (_, i) => 100 * Math.exp(0.002 * i));
  const model = markovFromPrices(prices);
  const up = directionalPersistence(model, "up", 12);
  assert.ok(up > 0.6, `expected persistent up, got ${up}`);
});

test("persistence stays bounded, and a driftless random walk favours neither side", () => {
  // A seeded random walk with no drift: over a long horizon the chain
  // forgets its starting state and neither direction looks persistent.
  const rng = makeRng(4242);
  const prices: number[] = [100];
  for (let i = 1; i < 600; i++) prices.push(prices[i - 1] * Math.exp((rng() - 0.5) * 0.004));
  const model = markovFromPrices(prices);
  const up = directionalPersistence(model, "up", 50);
  const down = directionalPersistence(model, "down", 50);
  for (const v of [up, down]) assert.ok(v >= 0 && v <= 1);
  assert.ok(Math.abs(up - down) < 0.2, `up ${up} vs down ${down} should be close`);
});

test("a downtrend yields high downward and low upward persistence", () => {
  const prices = Array.from({ length: 200 }, (_, i) => 100 * Math.exp(-0.002 * i));
  const model = markovFromPrices(prices);
  assert.ok(directionalPersistence(model, "down", 12) > 0.6);
  assert.ok(directionalPersistence(model, "up", 12) < 0.4);
});

test("the stationary distribution is a fixed point of the matrix", () => {
  const model = markovFromPrices(
    Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 7) * 3 + i * 0.01),
  );
  const stationary = stationaryDistribution(model);
  const oneMore = nStepDistribution(model, 201);
  for (const state of MARKOV_STATES) {
    assert.ok(
      Math.abs(stationary[state] - oneMore[state]) < 1e-6,
      `${state} drifted: ${stationary[state]} vs ${oneMore[state]}`,
    );
  }
});

test("expected drift is positive in an uptrend and negative in a downtrend", () => {
  const up = markovFromPrices(Array.from({ length: 200 }, (_, i) => 100 * Math.exp(0.002 * i)));
  const down = markovFromPrices(Array.from({ length: 200 }, (_, i) => 100 * Math.exp(-0.002 * i)));
  assert.ok(expectedDriftSigma(up, 5) > 0);
  assert.ok(expectedDriftSigma(down, 5) < 0);
});

test("sample confidence scales with the amount of evidence", () => {
  const thin = fitMarkov(["up", "up", "flat"]);
  const thick = markovFromPrices(Array.from({ length: 400 }, (_, i) => 100 + i * 0.1));
  assert.ok(sampleConfidence(thin) < 0.1, "three bars must not look authoritative");
  assert.equal(sampleConfidence(thick), 1);
});

test("an empty sequence degrades to a neutral model instead of throwing", () => {
  const model = fitMarkov([]);
  assert.equal(model.current, "flat");
  assert.equal(model.samples, 0);
  const dist = nStepDistribution(model, 10);
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});
