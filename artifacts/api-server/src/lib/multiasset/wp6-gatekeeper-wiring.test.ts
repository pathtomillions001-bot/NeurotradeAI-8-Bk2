/**
 * WP6 wiring tests — the gatekeeper as the desk's final arm decision.
 *
 * The unit tests in `meta/gatekeeper.test.ts` prove the arithmetic. These prove
 * the COMPOSITION, which is the part that can fail silently in production:
 *
 *   - with the flags at their shipped defaults the decision path is untouched
 *     (the gatekeeper is absent, not merely agreeable);
 *   - a missing sub-input refuses rather than passing (no model, no regime
 *     permit, no Monte Carlo);
 *   - the gatekeeper can only ever ADD rejections — a plan the legacy pipeline
 *     refused cannot become armed because a flag was switched on;
 *   - and when it refuses, the decision carries a machine-readable code and a
 *     human sentence for each failing gate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate } from "./agent";
import { DESK_V4_DEFAULTS, setDeskV4ForTests, type DeskV4Config } from "./desk-v4-config";
import { META_FEATURE_NAMES } from "./meta/dataset";
import type { MetaModelSnapshot } from "./meta/model";
import { MODE_HORIZON_BARS } from "./confluence";
import { createRiskState } from "./risk";
import { makeRng } from "./math";
import { TIMEFRAMES, type AccountSnapshot, type Bar, type Quote, type SymbolSpec, type Timeframe } from "./types";

/** The clean uptrend agent.test.ts uses to arm a plan. */
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

/** A fitted-looking snapshot: the shape WP9 will persist, nothing more. */
function snapshot(): MetaModelSnapshot {
  return {
    version: 1,
    mode: "intraday",
    frame: "M5",
    horizonBars: MODE_HORIZON_BARS.intraday,
    targetMultipleR: 2,
    model: {
      featureNames: [...META_FEATURE_NAMES],
      means: new Array(META_FEATURE_NAMES.length).fill(0),
      scales: new Array(META_FEATURE_NAMES.length).fill(1),
      coefficients: new Array(META_FEATURE_NAMES.length).fill(0),
      intercept: 0.5,
      l2: 1,
      iterations: 12,
      converged: true,
      logLikelihood: -100,
      weightSum: 500,
      effectiveSampleSize: 500,
    },
    calibrator: { points: [], samples: 500, effectiveSampleSize: 500, baseRate: 0.25, minBlockWeight: 20, pooledThinBlocks: 0, platt: { a: 0, b: 1 } },
    cohort: {
      label: "intraday:synthetic:wiring-test",
      rows: 900,
      independentObservations: 500,
      breakEvenProbability: 0.25,
      realisedHitRate: 0.31,
    },
    provenance: {
      corpus: "synthetic:wiring-test",
      calibratorKind: "platt",
      folds: 5,
      oosRows: 900,
      brierSkill: 0.12,
      hourEncoding: "cyclic",
      fittedAt: 1_700_000_000_000,
    },
  };
}

/** A tight, directionless range — the market the legacy pipeline refuses. */
function flatRange(count: number, start = 1.08, seed = 3): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const mid = start * (1 + Math.sin(i / 6) * 0.0004);
    const open = mid * (1 + (rng() - 0.5) * 0.00005);
    const close = mid * (1 + (rng() - 0.5) * 0.00005);
    bars.push([i * 60_000, open, Math.max(open, close) * 1.00002, Math.min(open, close) * 0.99998, close, 100]);
  }
  return bars;
}

function run(overrides: { bars?: number; kind?: "trend" | "range"; metaModel?: MetaModelSnapshot | null } = {}) {
  const series: Partial<Record<Timeframe, Bar[]>> = {};
  TIMEFRAMES.forEach((tf, i) => {
    series[tf] = overrides.kind === "range" ? flatRange(overrides.bars ?? 220, 1.08, i + 3) : trendUp(overrides.bars ?? 220, 1.08, 0.0006, 0.0002, i + 1);
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
    account,
    positions: [],
    specs: new Map([["EURUSD", spec]]),
    riskState: createRiskState(),
    metaModel: overrides.metaModel ?? null,
    now: 1_700_000_000_000,
  });
}

/** A configuration with the master switch on and exactly `on` subsystems enabled. */
function configWith(on: Partial<Record<keyof DeskV4Config, unknown>>): DeskV4Config {
  return {
    ...DESK_V4_DEFAULTS,
    enabled: true,
    shadow: true,
    ...on,
  } as DeskV4Config;
}

test("the shipped flags leave the decision path untouched", () => {
  const baseline = run();
  const restore = setDeskV4ForTests(null);
  try {
    const decision = run();
    assert.equal(decision.armed, baseline.armed);
    assert.equal(decision.gatekeeper, null, "the gatekeeper must not decide anything while its flag is off");
    assert.deepEqual(decision.rejections, baseline.rejections);
  } finally {
    restore();
  }
});

test("switching the gatekeeper on without a model refuses, by name", () => {
  const restore = setDeskV4ForTests(configWith({ gatekeeper: { enabled: true, live: false } }));
  try {
    const decision = run();
    assert.equal(decision.armed, false);
    assert.ok(decision.gatekeeper);
    assert.ok(decision.gatekeeper.codes.includes("GK_NO_MODEL"));
    // The specific fact, not just "no model": an audit must not have to read the
    // source to find out which of the several reasons applied.
    assert.ok(
      decision.gatekeeper.reasons.some(
        (reason) => reason.code === "GK_NO_MODEL" && /no fitted meta-model/.test(reason.detail),
      ),
    );
    assert.ok(
      decision.rejections.some((line) => line.startsWith("[GK_NO_MODEL]")),
      decision.rejections.join(" | "),
    );
  } finally {
    restore();
  }
});

test("a missing Monte Carlo refuses even when the model and the regime permit pass", () => {
  // The model is supplied and the WP3 permit is computed for real — on this
  // clean uptrend it GRANTS, which is what makes the test meaningful: the only
  // remaining objection is the unmeasured tail.
  const restore = setDeskV4ForTests(
    configWith({
      gatekeeper: { enabled: true, live: false },
      metaModel: { enabled: true, live: false },
      regimeHmm: { enabled: true, live: false },
    }),
  );
  try {
    const decision = run({ metaModel: snapshot(), bars: 600 });
    assert.equal(decision.armed, false);
    const codes = decision.gatekeeper?.codes ?? [];
    assert.ok(codes.includes("GK_MC_UNAVAILABLE"), codes.join(","));
    assert.ok(!codes.includes("GK_NO_MODEL"), "the model was supplied, so that gate must have passed");
    const regimeReason = decision.gatekeeper?.reasons.find((reason) => reason.code === "GK_REGIME");
    assert.ok(regimeReason, "the permit must be evaluated, not skipped");
    assert.equal(regimeReason.permit, undefined); // the reason carries numbers, not a verdict object
    assert.ok(typeof regimeReason.value === "number", "the permit's probability is recorded either way");
  } finally {
    restore();
  }
});

test("the Monte Carlo runs when it is switched on, and the permit is spent when it is not", () => {
  const restore = setDeskV4ForTests(
    configWith({
      gatekeeper: { enabled: true, live: false },
      metaModel: { enabled: true, live: false },
      monteCarloV2: { enabled: true, live: false },
    }),
  );
  try {
    const decision = run({ metaModel: snapshot(), bars: 600 });
    assert.equal(decision.armed, false);
    const codes = decision.gatekeeper?.codes ?? [];
    assert.ok(!codes.includes("GK_MC_UNAVAILABLE"), `the MC ran, so its gate is measured: ${codes.join(",")}`);
    assert.ok(
      codes.includes("GK_REGIME"),
      "the WP3 flag is off, so the permit could not be computed — and that refuses",
    );
    assert.ok(decision.gatekeeper?.mcP05MeanR !== null, "the tail must be reported");
    assert.ok(decision.rejections.some((line) => line.startsWith("[GK_REGIME]")), decision.rejections.join(" | "));
  } finally {
    restore();
  }
});

test("with every subsystem on, none of the availability gates fire", () => {
  const restore = setDeskV4ForTests(
    configWith({
      gatekeeper: { enabled: true, live: false },
      metaModel: { enabled: true, live: false },
      regimeHmm: { enabled: true, live: false },
      monteCarloV2: { enabled: true, live: false },
    }),
  );
  try {
    const decision = run({ metaModel: snapshot(), bars: 600 });
    const codes = decision.gatekeeper?.codes ?? [];
    assert.ok(!codes.includes("GK_NO_MODEL"), codes.join(","));
    assert.ok(!codes.includes("GK_REGIME"), codes.join(","));
    assert.ok(!codes.includes("GK_MC_UNAVAILABLE"), codes.join(","));
    // Whatever remains is a substantive veto about this market — and the plan is
    // unarmed for exactly that reason.
    assert.equal(decision.armed, codes.length === 0);
  } finally {
    restore();
  }
});

test("the gatekeeper can only add rejections — never remove one", () => {
  // A dead range is a market the legacy pipeline refuses on its own terms. With
  // the gatekeeper on, the decision must still be a refusal AND every legacy
  // sentence must still be present: the composition is an intersection.
  const restore = setDeskV4ForTests(configWith({ gatekeeper: { enabled: true, live: false } }));
  try {
    const restoreOff = setDeskV4ForTests(null);
    const legacy = (() => {
      try {
        return run({ kind: "range" });
      } finally {
        restoreOff();
      }
    })();
    assert.equal(legacy.armed, false, "the fixture must be a market the legacy pipeline refuses");
    const withGate = run({ kind: "range" });
    assert.equal(withGate.armed, false);
    for (const line of legacy.rejections) {
      assert.ok(withGate.rejections.includes(line), `lost a legacy rejection: ${line}`);
    }
    assert.ok(withGate.rejections.length > legacy.rejections.length, "the gatekeeper must have added its own");
  } finally {
    restore();
  }
});

test("a snapshot that does not match the decision refuses rather than guessing", () => {
  const restore = setDeskV4ForTests(
    configWith({ gatekeeper: { enabled: true, live: false }, metaModel: { enabled: true, live: false } }),
  );
  try {
    const swingSnapshot: MetaModelSnapshot = { ...snapshot(), mode: "swing", horizonBars: MODE_HORIZON_BARS.swing };
    const decision = run({ metaModel: swingSnapshot, bars: 600 });
    assert.equal(decision.armed, false);
    assert.ok(decision.gatekeeper?.codes.includes("GK_NO_MODEL"));
    assert.match(decision.gatekeeper?.reason ?? "", /does not match this decision|no calibrated probability/i);
  } finally {
    restore();
  }
});
