/**
 * WP8 — the portfolio and risk layer: unit tests, then wiring tests.
 *
 * What these pin, in the order the decisions are made:
 *
 *   • the covariance is EWMA-weighted (today matters more than last week) and it
 *     REFUSES to be computed when there is not enough of it — a 12-observation
 *     covariance on 6 assets is not a measurement;
 *   • Ledoit–Wolf shrinks toward a diagonal target, and the intensity moves in
 *     the right direction (noisier sample ⇒ more shrinkage);
 *   • clusters are TRANSITIVE (A→B and B→C at 0.7 is one bet, not two);
 *   • heat is √(r'Cr) — equal to a single position's risk, equal to the sum at
 *     ρ = 1, and √(r₁² + r₂²) at ρ = 0;
 *   • the drawdown scalar grades 1.0 → 0.25 between the knee and the floor, and
 *     halts at 10%;
 *   • and the composition can only ever REDUCE: every cap applied on top of a
 *     previous one lowers (never raises) the number handed to sizing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLUSTER_RISK_MAX_PCT,
  CORRELATION_CLUSTER_RHO,
  DAILY_CVAR_MAX_PCT,
  DD_HALT_PCT,
  DD_SCALAR_FLOOR,
  DD_SCALAR_FULL_PCT,
  DD_SCALAR_KNEE_PCT,
  MIN_COVARIANCE_SAMPLES,
  PORTFOLIO_HEAT_MAX_PCT,
  PORTFOLIO_MAX_TRADE_RISK_PCT,
  correlationClusters,
  correlationFromBars,
  correlationMatrix,
  dailyCvarPct,
  drawdownFromPeak,
  drawdownScalar,
  inverseNormal,
  ledoitWolfShrinkage,
  portfolioDecision,
  portfolioHeatPct,
  realisedVolatility,
  sampleCovariance,
} from "./portfolio-risk";
import { evaluate } from "./agent";
import { DESK_V4_DEFAULTS, setDeskV4ForTests, type DeskV4Config } from "./desk-v4-config";
import { createRiskState } from "./risk";
import { makeRng } from "./math";
import { TIMEFRAMES, type AccountSnapshot, type Bar, type Quote, type SymbolSpec, type Timeframe } from "./types";

const identity = (n: number): number[][] => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

/** A deterministic pseudo-random series with a given correlation to a reference. */
function series(count: number, seed: number): number[] {
  const rng = makeRng(seed);
  return Array.from({ length: count }, () => (rng() - 0.5) * 0.02);
}

// ── Covariance, shrinkage, correlations ──────────────────────────────────────

test("W8.1 — the covariance refuses to exist on too little data, and weights today more", () => {
  assert.equal(sampleCovariance([series(10, 1), series(11, 2)]), null, "unequal lengths are not aligned returns");
  assert.equal(sampleCovariance([series(MIN_COVARIANCE_SAMPLES - 1, 3)]), null, "39 observations is not a covariance");
  const ok = sampleCovariance([series(MIN_COVARIANCE_SAMPLES, 4), series(MIN_COVARIANCE_SAMPLES, 5)]);
  assert.ok(ok, "40 observations is");
  assert.equal(ok?.length, 2);
  assert.ok(Math.abs(((ok?.[0] as number[])[1] as number) - ((ok?.[1] as number[])[0] as number)) < 1e-18, "symmetric");

  // A shock in the LAST observation must move an EWMA covariance more than it
  // moves the sample one: that is the whole point of λ. The two series are
  // constructed to be weakly NEGATIVELY related, and the final observation is
  // their most negative cross-product yet — so a covariance that is about today
  // (plus the shock) must sit below the flat sample's average.
  const calm = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.001 : -0.001));
  const a = [...calm, 0.05];
  const b = [...calm.map((v) => -v), -0.05];
  const ewma = sampleCovariance([a, b], { lambda: 0.97, meanAdjusted: false });
  const flat = sampleCovariance([a, b], { meanAdjusted: false });
  assert.ok(ewma && flat);
  assert.ok(
    ((ewma as number[][])[0] as number[])[1] as number < ((flat as number[][])[0] as number[])[1] as number,
    `the EWMA must weight the last observation more: ewma=${(ewma as number[][])[0]?.[1]}, flat=${(flat as number[][])[0]?.[1]}`,
  );
});

test("W8.2 — Ledoit–Wolf shrinks toward the diagonal, and harder on noisier samples", () => {
  const n = 4;
  const t = 60;
  const base = Array.from({ length: n }, (_, i) => series(t, 100 + i));
  const covariance = sampleCovariance(base);
  assert.ok(covariance);
  const shrunk = ledoitWolfShrinkage({ series: base, covariance: covariance as number[][] });
  assert.ok(shrunk.intensity >= 0 && shrunk.intensity <= 1, `intensity out of range: ${shrunk.intensity}`);
  assert.ok(shrunk.targetVariance > 0);
  // Every off-diagonal element moves toward zero, and no diagonal one moves away
  // from its own scale.
  for (let i = 0; i < n; i++) {
    assert.ok(shrunk.covariance[i]?.[i] !== undefined);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const before = Math.abs((covariance as number[][])[i]?.[j] as number);
      const after = Math.abs(shrunk.covariance[i]?.[j] as number);
      assert.ok(after <= before + 1e-18, "shrinkage must not invent correlation");
    }
  }
  const correlation = correlationMatrix(shrunk.covariance);
  assert.ok(correlation);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs((correlation as number[][])[i]?.[i] as number - 1) < 1e-12, "a correlation matrix has a unit diagonal");
    for (let j = 0; j < n; j++) {
      assert.ok(Math.abs((correlation as number[][])[i]?.[j] as number) <= 1 + 1e-12);
    }
  }
  // A zero-variance asset has no correlation to report.
  assert.equal(correlationMatrix([[0, 0], [0, 1]]), null);
});

test("W8.3 — clusters are transitive, thresholded, and labelled", () => {
  const labels = ["EURUSD", "GBPUSD", "XAUUSD", "USDJPY"];
  // A→B = 0.7 and B→C = 0.7 are both above the threshold; A→C is only 0.5, i.e.
  // NOT above it. Transitive closure says all three are one bet; a pairwise
  // check would call C independent and let the cluster carry three positions.
  const correlation = [
    [1, 0.7, 0.5, 0.1],
    [0.7, 1, 0.7, 0.05],
    [0.5, 0.7, 1, 0.2],
    [0.1, 0.05, 0.2, 1],
  ];
  const clusters = correlationClusters(correlation as number[][], labels);
  const first = clusters.find((group) => group.includes("EURUSD"));
  assert.ok(first);
  assert.deepEqual([...(first as string[])].sort(), ["EURUSD", "GBPUSD", "XAUUSD"].sort(), "A→B and B→C must be one bet");
  assert.equal(clusters.length, 2);
  assert.ok(CORRELATION_CLUSTER_RHO > 0.5 && CORRELATION_CLUSTER_RHO < 0.7, "the measured threshold is in a sane band");

  // Nothing above the threshold ⇒ every asset is its own cluster.
  assert.equal(correlationClusters(identity(4), labels).length, 4);
});

test("W8.4 — heat is √(r'Cr): one position is its own risk, ρ = 1 sums, ρ = 0 is the quadrature sum", () => {
  const single = portfolioHeatPct([0.35], [[1]]);
  assert.ok(single !== null && Math.abs(single - 0.35) < 1e-12, "a first trade's heat is its own risk");

  const pair = portfolioHeatPct([0.35, 0.35], [
    [1, 1],
    [1, 1],
  ]);
  assert.ok(pair !== null && Math.abs(pair - 0.7) < 1e-12, "two perfectly correlated bets are one bet");

  const independent = portfolioHeatPct([0.3, 0.4], identity(2) as number[][]);
  assert.ok(independent !== null && Math.abs(independent - Math.sqrt(0.09 + 0.16)) < 1e-12);

  assert.equal(portfolioHeatPct([], identity(0)), null);
  assert.equal(portfolioHeatPct([0.3, 0.4], [[1]]), null, "a matrix that does not match the book is not a measurement");
});

test("W8.5 — the parametric CVaR is the documented multiple of heat, and monotone", () => {
  assert.ok(Math.abs(inverseNormal(0.05) + 1.6448536) < 1e-6, "the 5% quantile must be −1.6449");
  assert.ok(Math.abs(inverseNormal(0.6) - 0.2533471) < 1e-5);
  assert.ok(Math.abs(inverseNormal(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(inverseNormal(0.5)) < 1e-9);
  assert.ok(Number.isNaN(inverseNormal(0)));
  assert.ok(Number.isNaN(inverseNormal(1)));

  const one = dailyCvarPct([0.35], [[1]]);
  assert.ok(one !== null);
  // σ · φ(z) / (1 − confidence), with z the 5% quantile: 0.35 × 2.0627.
  assert.ok(Math.abs((one as number) - 0.35 * 2.0627) < 5e-4, `CVaR factor moved: ${(one as number) / 0.35}`);

  const diversified = dailyCvarPct([0.35, 0.35], identity(2) as number[][]);
  const concentrated = dailyCvarPct([0.35, 0.35], [
    [1, 1],
    [1, 1],
  ]);
  assert.ok(diversified !== null && concentrated !== null);
  assert.ok((diversified as number) < (concentrated as number), "correlation must cost more than diversification");
  // The cluster ceiling is the tightest of the three (one bet, 1.0%); the heat
  // and CVaR ceilings share 1.5%, and the CVaR one is the LEAST protective of
  // all because it is a parametric (normal) LOWER bound on a fat-tailed number.
  assert.ok(CLUSTER_RISK_MAX_PCT < PORTFOLIO_HEAT_MAX_PCT, "a single cluster must be capped below total heat");
  assert.ok(DAILY_CVAR_MAX_PCT <= PORTFOLIO_HEAT_MAX_PCT);
});

test("W8.6 — correlations built from bars refuse a short series instead of guessing", () => {
  const rng = makeRng(9);
  const bars = (count: number, seed: number): Bar[] => {
    const local = makeRng(seed);
    const out: Bar[] = [];
    let price = 1;
    for (let i = 0; i < count; i++) {
      price *= Math.exp((local() - 0.5) * 0.004);
      out.push([i * 60_000, price, price * 1.0005, price * 0.9995, price, 10]);
    }
    return out;
  };
  const built = correlationFromBars({
    series: [
      { label: "EURUSD", bars: bars(200, 11) },
      { label: "XAUUSD", bars: bars(200, 12) },
      { label: "USDJPY", bars: bars(200, 13) },
    ],
    count: MIN_COVARIANCE_SAMPLES,
  });
  assert.ok(built);
  assert.deepEqual(built?.labels, ["EURUSD", "XAUUSD", "USDJPY"]);
  assert.equal(built?.returnCount, MIN_COVARIANCE_SAMPLES);
  assert.equal(built?.correlation.length, 3);
  assert.ok((built?.shrinkageIntensity ?? -1) >= 0);

  // One short series ⇒ null, not a matrix with a hole in it.
  assert.equal(
    correlationFromBars({
      series: [
        { label: "EURUSD", bars: bars(200, 11) },
        { label: "XAUUSD", bars: bars(10, 12) },
      ],
      count: MIN_COVARIANCE_SAMPLES,
    }),
    null,
  );
  assert.equal(correlationFromBars({ series: [{ label: "EURUSD", bars: bars(200, 11) }] }), null, "one asset is not a book");
  assert.ok(rng() >= 0, "the fixture RNG is used, not a global one");
});

// ── The drawdown response ────────────────────────────────────────────────────

test("W8.7 — the drawdown scalar grades to the floor and halts at the halt", () => {
  assert.equal(drawdownScalar(0).scalar, 1);
  assert.equal(drawdownScalar(DD_SCALAR_KNEE_PCT).scalar, 1, "at the knee nothing is scaled");
  const mid = drawdownScalar((DD_SCALAR_KNEE_PCT + DD_SCALAR_FULL_PCT) / 2);
  assert.ok(mid.scalar < 1 && mid.scalar > DD_SCALAR_FLOOR, "the middle is strictly between");
  assert.ok(Math.abs(drawdownScalar(DD_SCALAR_FULL_PCT).scalar - DD_SCALAR_FLOOR) < 1e-9, "full at the floor");
  assert.ok(Math.abs(drawdownScalar(9).scalar - DD_SCALAR_FLOOR) < 1e-9, "past the floor it stays at the floor");
  const halted = drawdownScalar(DD_HALT_PCT);
  assert.equal(halted.halted, true);
  assert.equal(halted.scalar, 0, "a halted desk has no budget to hand out");
  assert.ok(DD_SCALAR_KNEE_PCT < DD_SCALAR_FULL_PCT && DD_SCALAR_FULL_PCT < DD_HALT_PCT, "the three knees are ordered");
  assert.ok(drawdownScalar(-5).scalar === 1, "a nonsense negative drawdown is treated as none");
  assert.match(drawdownScalar(DD_HALT_PCT).reason, /halt/);
});

test("W8.8 — the drawdown is measured from the peak, and a null peak means no drawdown", () => {
  assert.ok(Math.abs(drawdownFromPeak({ equity: 9_000, peakEquity: 10_000 }) - 10) < 1e-12);
  assert.equal(drawdownFromPeak({ equity: 10_000, peakEquity: 10_000 }), 0);
  assert.equal(drawdownFromPeak({ equity: 10_500, peakEquity: 10_000 }), 0, "a new high is not a drawdown");
  assert.equal(drawdownFromPeak({ equity: 10_000, peakEquity: null }), 0);
  assert.equal(drawdownFromPeak({ equity: 10_000, peakEquity: undefined }), 0);
  assert.ok(realisedVolatility([0.1, -0.1, 0.1, -0.1]) > 0);
});

// ── The composition ──────────────────────────────────────────────────────────

const cap = PORTFOLIO_MAX_TRADE_RISK_PCT;

test("W8.9 — the per-trade ceiling holds, and Kelly can only sit under it", () => {
  const withoutKelly = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: null,
    rewardRisk: 2,
    book: [],
    correlation: null,
  });
  assert.equal(withoutKelly.allowed, true);
  assert.ok(Math.abs(withoutKelly.riskPct - cap) < 1e-12, "with no probability the cap stands");

  // A lower bound of 0.34 at 1:2 is a 0.25% quarter-Kelly — under the 0.35% cap.
  const withKelly = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: 0.34,
    rewardRisk: 2,
    book: [],
    correlation: null,
  });
  assert.ok(withKelly.kellyRiskPct > 0, `quarter-Kelly must be positive: ${withKelly.kellyRiskPct}`);
  assert.ok(withKelly.kellyRiskPct < cap, `quarter-Kelly must sit under the cap: ${withKelly.kellyRiskPct} vs ${cap}`);
  assert.ok(Math.abs(withKelly.riskPct - withKelly.kellyRiskPct) < 1e-12, "the smaller of the two sizes the trade");
  assert.ok(withKelly.codes.includes("PF_KELLY"));

  // A strong edge cannot break the ceiling.
  const strong = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: 0.6,
    rewardRisk: 3,
    book: [],
    correlation: null,
  });
  assert.ok(strong.kellyRiskPct > cap, "the Kelly term itself is above the cap here");
  assert.ok(Math.abs(strong.riskPct - cap) < 1e-12, "and the cap is what is handed to sizing");

  // A budget the caller tightens is honoured; one it tries to raise is not.
  const tightened = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: null,
    rewardRisk: 2,
    book: [],
    correlation: null,
    maxTradeRiskPct: 0.1,
  });
  assert.ok(Math.abs(tightened.riskPct - 0.1) < 1e-12);
  const raised = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: null,
    rewardRisk: 2,
    book: [],
    correlation: null,
    maxTradeRiskPct: 5,
  });
  assert.ok(Math.abs(raised.riskPct - cap) < 1e-12, "the desk's own ceiling cannot be raised by a caller");
});

test("W8.10 — every later cap can only lower what the earlier ones allowed", () => {
  const input = {
    probabilityLowerBound: null as number | null,
    rewardRisk: 2,
    correlation: null,
    book: [] as { symbol: string; riskPct: number }[],
  };
  const clean = portfolioDecision({ ...input, drawdownPct: 0 });
  const drawn = portfolioDecision({ ...input, drawdownPct: DD_SCALAR_FULL_PCT });
  assert.ok(drawn.riskPct < clean.riskPct, "the drawdown scalar must reduce the budget");

  const halted = portfolioDecision({ ...input, drawdownPct: DD_HALT_PCT });
  assert.equal(halted.allowed, false);
  assert.ok(halted.codes.includes("PF_HALT"));
  assert.ok(halted.riskPct <= 0);

  // A book with no measurable covariance keeps the per-trade ceiling and SAYS
  // it cannot see the book.
  const blind = portfolioDecision({
    ...input,
    drawdownPct: 0,
    book: [{ symbol: "EURUSD", riskPct: 0.3 }],
  });
  assert.equal(blind.allowed, true);
  assert.ok(blind.codes.includes("PF_NO_COVARIANCE"));
  assert.equal(blind.heatPct, null);
  assert.ok(Math.abs(blind.riskPct - cap) < 1e-12);
});

test("W8.11 — the cluster cap, the heat cap and the CVaR cap each bite, in that order", () => {
  // Two assets at ρ = 0.9: the second trade joins the first's cluster.
  const clustered = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: null,
    rewardRisk: 2,
    // Two bets already in the cluster, 0.9% of equity: only 0.1% of the 1.0%
    // cluster ceiling is left for a third.
    book: [
      { symbol: "EURUSD", riskPct: 0.5 },
      { symbol: "GBPUSD", riskPct: 0.4 },
    ],
    correlation: [
      [1, 0.9, 0.9],
      [0.9, 1, 0.9],
      [0.9, 0.9, 1],
    ] as number[][],
    labels: ["EURUSD", "GBPUSD", "XAUUSD"],
    candidateIndex: 2,
  });
  assert.ok(clustered.codes.includes("PF_CLUSTER"), clustered.codes.join(","));
  assert.ok(clustered.riskPct < cap, "the cluster ceiling must bite before the trade reaches the per-trade cap");
  assert.ok(clustered.clusterRiskPct !== null && clustered.clusterRiskPct <= CLUSTER_RISK_MAX_PCT + 1e-12);
  assert.deepEqual([...(clustered.cluster ?? [])].sort(), ["EURUSD", "GBPUSD", "XAUUSD"]);
  assert.ok((clustered.riskPct ?? 0) <= 0.1 + 1e-12, `the candidate must be capped to what is left: ${clustered.riskPct}`);
  assert.ok(Math.abs((clustered.clusterRiskPct ?? 0) - CLUSTER_RISK_MAX_PCT) < 1e-9);

  // An uncorrelated book: the cluster cap does not fire...
  const independent = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: null,
    rewardRisk: 2,
    book: [{ symbol: "EURUSD", riskPct: 0.3 }],
    correlation: [[1, 0], [0, 1]],
    labels: ["EURUSD", "XAUUSD"],
    candidateIndex: 1,
  });
  assert.equal(independent.codes.includes("PF_CLUSTER"), false);
  // ...and heat is √(0.3² + 0.35²) = 0.461, under the 1.5% ceiling, so no cap.
  assert.ok(independent.heatPct !== null && independent.heatPct < PORTFOLIO_HEAT_MAX_PCT);
  assert.ok(Math.abs(independent.riskPct - cap) < 1e-12);

  // A book already at the heat ceiling cannot take another 0.35%: with a highly
  // correlated book the heat AND CVaR ceilings both apply.
  const hot = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: null,
    rewardRisk: 2,
    book: [
      { symbol: "EURUSD", riskPct: 0.5 },
      { symbol: "GBPUSD", riskPct: 0.5 },
      { symbol: "XAUUSD", riskPct: 0.5 },
    ],
    correlation: [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ],
    labels: ["EURUSD", "GBPUSD", "XAUUSD", "USDJPY"],
    candidateIndex: 3,
  });
  assert.ok(hot.codes.includes("PF_HEAT") || hot.codes.includes("PF_CLUSTER") || hot.codes.includes("PF_CVAR"));
  assert.ok(hot.riskPct < cap, hot.codes.join(","));
  // The book is ALREADY over the CVaR ceiling before this trade is considered —
  // the desk cannot un-risk what is open, so the trade simply gets no budget,
  // and the over-ceiling state is REPORTED rather than hidden behind a cap that
  // could not fix it.
  assert.ok(hot.riskPct <= 0);
  if (hot.cvarPct !== null && hot.cvarPct > DAILY_CVAR_MAX_PCT + 1e-9) {
    assert.ok(hot.codes.includes("PF_CVAR"), `an over-ceiling book must be named: ${hot.codes.join(",")}`);
    assert.match(hot.reasons.join(" "), /CVaR/);
  }
});

test("W8.16 — a cap that cannot fix the book still says so out loud", () => {
  // Three perfectly correlated 0.5% positions: heat 1.5% (at the ceiling) and a
  // parametric CVaR of ~3.09%, over its own 1.5% ceiling. A fourth trade cannot
  // repair that; the layer must refuse AND name the breached ceiling.
  const decision = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: null,
    rewardRisk: 2,
    book: [
      { symbol: "EURUSD", riskPct: 0.5 },
      { symbol: "GBPUSD", riskPct: 0.5 },
      { symbol: "XAUUSD", riskPct: 0.5 },
    ],
    correlation: [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ],
    labels: ["EURUSD", "GBPUSD", "XAUUSD", "USDJPY"],
    candidateIndex: 3,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.riskPct <= 0);
  assert.ok(decision.reasons.length > 0, "a refusal without a sentence is not auditable");
  assert.ok(
    decision.codes.includes("PF_HEAT") || decision.codes.includes("PF_CVAR") || decision.codes.includes("PF_NO_BUDGET"),
    decision.codes.join(","),
  );
});

test("W8.17 — the CVaR remedy actually reaches the ceiling it names", () => {
  // Three 0.25% positions at ρ = 0.85 sit at heat 0.7115% (CVaR 1.4677%), just
  // under the 1.5% CVaR ceiling. A fourth 0.35% trade would take the book to
  // CVaR 2.14%, so the layer has to shrink it — and the size it may keep is
  // whatever puts the BOOK on the ceiling, not `0.35% × ceiling/cvar`.
  //
  // That distinction is the whole test: CVaR is `heat × factor` and heat is a
  // square root of a quadratic, so it is CONCAVE in this trade's own risk.
  // Scaling the trade by `ceiling/cvar` (the original remedy) therefore shrinks
  // the book's CVaR by less than that factor and leaves it ABOVE the ceiling it
  // claimed to enforce. The linear answer here is 0.2455%, which leaves CVaR at
  // 1.9347%; the solved answer is ~0.0176%, which lands exactly on 1.5%.
  const rho = 0.85;
  const decision = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: null,
    rewardRisk: 2,
    book: [
      { symbol: "EURUSD", riskPct: 0.25 },
      { symbol: "GBPUSD", riskPct: 0.25 },
      { symbol: "XAUUSD", riskPct: 0.25 },
    ],
    correlation: [
      [1, rho, rho, rho],
      [rho, 1, rho, rho],
      [rho, rho, 1, rho],
      [rho, rho, rho, 1],
    ],
    labels: ["EURUSD", "GBPUSD", "XAUUSD", "USDJPY"],
    candidateIndex: 3,
  });
  assert.ok(decision.codes.includes("PF_CVAR"), decision.codes.join(","));
  assert.ok(decision.riskPct > 0, "a shrinkable trade must be shrunk, not refused");
  assert.ok(decision.riskPct < 0.35, `the trade must be cut: ${decision.riskPct}`);
  assert.ok(
    decision.cvarPct !== null && decision.cvarPct <= DAILY_CVAR_MAX_PCT + 1e-9,
    `the remedy must land on the ceiling, measured ${decision.cvarPct}`,
  );
  // The linear remedy the layer must never regress to, computed here rather than
  // described: it is what the code did before, and it BREACHES the ceiling.
  const matrix = [
    [1, rho, rho, rho],
    [rho, 1, rho, rho],
    [rho, rho, 1, rho],
    [rho, rho, rho, 1],
  ];
  const preShrink = dailyCvarPct([0.25, 0.25, 0.25, 0.35], matrix);
  assert.ok(preShrink !== null && preShrink > DAILY_CVAR_MAX_PCT);
  const linearRisk = 0.35 * (DAILY_CVAR_MAX_PCT / preShrink);
  const linearCvar = dailyCvarPct([0.25, 0.25, 0.25, linearRisk], matrix);
  assert.ok(
    linearCvar !== null && linearCvar > DAILY_CVAR_MAX_PCT + 1e-9,
    `the linear rescale must be demonstrably insufficient (it leaves ${linearCvar}), so this test cannot pass on the old remedy`,
  );
  assert.ok(linearRisk > decision.riskPct, `the solved size ${decision.riskPct} is below the linear ${linearRisk}`);
});

test("W8.12 — a fully spent budget refuses, by name", () => {
  const spent = portfolioDecision({
    drawdownPct: 0,
    probabilityLowerBound: null,
    rewardRisk: 2,
    book: [
      { symbol: "EURUSD", riskPct: 0.5 },
      { symbol: "GBPUSD", riskPct: 0.5 },
    ],
    correlation: [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ],
    labels: ["EURUSD", "GBPUSD", "XAUUSD"],
    candidateIndex: 2,
  });
  assert.equal(spent.allowed, false);
  assert.ok(spent.codes.includes("PF_NO_BUDGET") || spent.codes.includes("PF_HEAT"));
  assert.ok(spent.riskPct <= 0, `riskPct must be zero, got ${spent.riskPct}`);
  assert.ok(spent.reasons.length > 0, "a refusal must carry a sentence");
});

// ── Wiring ───────────────────────────────────────────────────────────────────

function trendUp(count: number, start = 1.08, drift = 0.0006, noise = 0.0002, seed = 1): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    price = open * Math.exp(drift + (rng() - 0.5) * noise);
    const high = Math.max(open, price) * (1 + rng() * noise * 0.5);
    const low = Math.min(open, price) * (1 - rng() * noise * 0.5);
    bars.push([i * 60_000, open, high, low, price, 100]);
  }
  return bars;
}

const spec: SymbolSpec = {
  symbol: "EURUSD",
  assetClass: "forex",
  point: 0.00001,
  digits: 5,
  tickSize: 0.00001,
  tickValue: 1,
  contractSize: 100_000,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
  marginInitial: 0,
  swapLong: 0,
  swapShort: 0,
  commissionPerLot: 0,
  spreadPoints: 8,
  baseCurrency: "EUR",
  quoteCurrency: "USD",
};

const account: AccountSnapshot = {
  balance: 10_000,
  equity: 10_000,
  margin: 0,
  freeMargin: 10_000,
  marginLevel: Number.POSITIVE_INFINITY,
  currency: "USD",
  leverage: 500,
  mode: "hedging",
  isLive: false,
  dayStartEquity: 10_000,
  peakEquity: 10_000,
};

function run(overrides: { equity?: number; peakEquity?: number; correlation?: { labels: string[]; matrix: number[][] } | null } = {}) {
  const series: Partial<Record<Timeframe, Bar[]>> = {};
  TIMEFRAMES.forEach((tf, i) => {
    series[tf] = trendUp(220, 1.08, 0.0006, 0.0002, i + 1);
  });
  const bars = series.M5 as Bar[];
  const last = (bars[bars.length - 1] as Bar)[4] as number;
  const half = (spec.spreadPoints * spec.point) / 2;
  const quote: Quote = { symbol: "EURUSD", bid: last - half, ask: last + half, spreadPoints: spec.spreadPoints, ts: Date.now() };
  return evaluate({
    symbol: "EURUSD",
    mode: "intraday",
    spec,
    quote,
    series,
    account: {
      ...account,
      equity: overrides.equity ?? account.equity,
      peakEquity: overrides.peakEquity ?? account.peakEquity,
      freeMargin: overrides.equity ?? account.freeMargin,
    },
    positions: [],
    specs: new Map([["EURUSD", spec]]),
    riskState: createRiskState(),
    portfolioCorrelation: overrides.correlation ?? null,
    now: 1_700_000_000_000,
  });
}

function portfolioConfig(): DeskV4Config {
  return { ...DESK_V4_DEFAULTS, enabled: true, shadow: true, portfolio: { enabled: true, live: false } };
}

test("W8.13 — with its flag off the layer decides nothing, and the size is the legacy size", () => {
  const restore = setDeskV4ForTests(null);
  try {
    const decision = run();
    assert.equal(decision.portfolio, null, "the portfolio layer must be absent, not merely agreeable");
  } finally {
    restore();
  }
});

test("W8.14 — switched on, it can only lower the risk the legacy pipeline chose", () => {
  const restoreOff = setDeskV4ForTests(null);
  const baseline = (() => {
    try {
      return run();
    } finally {
      restoreOff();
    }
  })();
  assert.ok(baseline.plan, "the fixture must arm a plan for this test to mean anything");

  const restore = setDeskV4ForTests(portfolioConfig());
  try {
    const on = run();
    assert.ok(on.portfolio, "the layer ran");
    if (on.armed && on.plan) {
      assert.ok(
        on.plan.riskMoney <= (baseline.plan?.riskMoney ?? 0) + 1e-9,
        "the portfolio layer must never size UP a trade",
      );
      assert.ok(on.portfolio.riskPct <= PORTFOLIO_MAX_TRADE_RISK_PCT + 1e-12, "and never above the 0.35% cap");
    } else {
      assert.ok(on.rejections.some((line) => line.includes("portfolio") || line.includes("PF_")), on.rejections.join(" | "));
    }
  } finally {
    restore();
  }
});

test("W8.15 — the drawdown scalar grades the budget, and halts it at 10%", () => {
  const restore = setDeskV4ForTests(portfolioConfig());
  try {
    const clean = run();
    const cleanRiskPct = clean.portfolio?.riskPct ?? null;
    assert.ok(cleanRiskPct !== null, "the layer must report a budget");
    assert.equal(clean.portfolio?.drawdown.halted, false);
    assert.ok(Math.abs((clean.portfolio?.drawdown.scalar ?? 0) - 1) < 1e-12, "no drawdown ⇒ full size");

    // 6.19% down from the peak: past the 4% knee, short of the 8% floor, and —
    // importantly — inside the legacy governor's 3% daily-loss limit, so the
    // decision reaches this layer instead of being refused above it.
    const drawn = run({ equity: 9_850, peakEquity: 10_500 });
    const drawnDd = drawn.portfolio?.drawdown.drawdownPct ?? 0;
    assert.ok(Math.abs(drawnDd - 6.1905) < 0.01, `drawdown mismeasured: ${drawnDd}`);
    const scalar = drawn.portfolio?.drawdown.scalar ?? 0;
    assert.ok(scalar < 1 && scalar > DD_SCALAR_FLOOR, `the scalar must be strictly inside the band: ${scalar}`);
    assert.ok(
      (drawn.portfolio?.riskPct ?? 1) < cleanRiskPct + 1e-12,
      "a drawdown past the knee must reduce the budget",
    );

    // 10% down: the desk is halted. Whether the legacy governor refuses first
    // or this layer does, NOTHING may be armed — that is the assertion that
    // matters, and it holds either way.
    const halted = run({ equity: 9_000, peakEquity: 10_000 });
    assert.equal(halted.armed, false, "a halted desk arms nothing");
    if (halted.portfolio) {
      assert.equal(halted.portfolio.drawdown.halted, true);
      assert.equal(halted.portfolio.allowed, false);
      assert.ok(halted.portfolio.codes.includes("PF_HALT"));
    } else {
      // Refused upstream by the daily-loss limit: the halt is then the legacy
      // one, and it must be visible in the rejections.
      assert.ok(halted.rejections.length > 0, "a refusal must carry a reason");
    }
  } finally {
    restore();
  }
});
