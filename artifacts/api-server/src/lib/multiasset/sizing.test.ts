/**
 * Sizing engine tests.
 *
 * These encode docs/multi-asset-architecture.md §2.1 verbatim. The whole
 * premise of the desk is that the same risk percentage produces a correct —
 * and very different — lot size on every asset class, and that an unsafe
 * trade is refused rather than quietly shrunk or rounded up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateExposure,
  costForLots,
  currencyLegs,
  kellyFraction,
  pointValuePerLot,
  quantiseVolume,
  sizePosition,
  type SizingRequest,
} from "./sizing";
import type { Position, SymbolSpec } from "./types";

// ── Fixtures: realistic broker specs, account currency USD ───────────────────

const EURUSD: SymbolSpec = {
  symbol: "EURUSD",
  assetClass: "forex",
  point: 0.00001,
  digits: 5,
  tickSize: 0.00001,
  tickValue: 1.0, // 100_000 units × 0.00001 = $1.00 per point per lot
  contractSize: 100_000,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
  marginInitial: 0,
  swapLong: -2,
  swapShort: -0.5,
  commissionPerLot: 0,
  spreadPoints: 10,
  baseCurrency: "EUR",
  quoteCurrency: "USD",
};

const XAUUSD: SymbolSpec = {
  ...EURUSD,
  symbol: "XAUUSD",
  assetClass: "metals",
  point: 0.01,
  digits: 2,
  tickSize: 0.01,
  tickValue: 1.0, // 100 oz × 0.01 = $1.00 per point per lot
  contractSize: 100,
  spreadPoints: 20,
  baseCurrency: "XAU",
  quoteCurrency: "USD",
};

const US30: SymbolSpec = {
  ...EURUSD,
  symbol: "US30",
  assetClass: "indices",
  point: 0.1,
  digits: 1,
  tickSize: 0.1,
  tickValue: 0.1, // 1 contract × 0.1 = $0.10 per point per lot
  contractSize: 1,
  volumeMin: 0.1,
  volumeStep: 0.1,
  spreadPoints: 20,
  baseCurrency: undefined,
  quoteCurrency: undefined,
};

function request(overrides: Partial<SizingRequest> & Pick<SizingRequest, "spec" | "entry" | "sl">): SizingRequest {
  return {
    side: "buy",
    equity: 5000,
    freeMargin: 5000,
    usedMargin: 0,
    riskPct: 1,
    leverage: 500,
    ...overrides,
  };
}

// ── Point value: the conversion everything else depends on ───────────────────

test("point value is derived from the broker's tick economics, per asset class", () => {
  assert.equal(pointValuePerLot(EURUSD), 1.0);
  assert.equal(pointValuePerLot(XAUUSD), 1.0);
  assert.ok(Math.abs(pointValuePerLot(US30) - 0.1) < 1e-9);
});

test("point value honours a tick size coarser than the point", () => {
  // Several indices and futures CFDs quote a tick size larger than a point.
  // Treating tickValue as per-point there would overstate value by the ratio.
  const coarse: SymbolSpec = { ...US30, point: 0.1, tickSize: 0.5, tickValue: 0.5 };
  assert.ok(Math.abs(pointValuePerLot(coarse) - 0.1) < 1e-9);
});

// ── The headline promise: same risk, different lots ──────────────────────────

test("1% of $5,000 produces the documented lot size on EURUSD", () => {
  // 12.0 pips = 120 points × $1.00/pt/lot = $120 per lot; $50 / $120 = 0.4166…
  const result = sizePosition(request({ spec: EURUSD, entry: 1.0845, sl: 1.0833 }));
  assert.equal(result.ok, true);
  assert.equal(result.lots, 0.41);
  assert.ok(Math.abs(result.riskPoints - 120) < 1e-6);
  assert.ok(result.riskMoney <= 50, "risk must never exceed the budget");
  assert.ok(Math.abs(result.riskMoney - 49.2) < 0.01);
});

test("1% of $5,000 produces the documented lot size on XAUUSD", () => {
  // $3.50 = 350 points × $1.00/pt/lot = $350 per lot; $50 / $350 = 0.1428…
  const result = sizePosition(request({ spec: XAUUSD, entry: 2338.5, sl: 2335.0 }));
  assert.equal(result.ok, true);
  assert.equal(result.lots, 0.14);
  assert.ok(Math.abs(result.riskMoney - 49) < 0.01);
});

test("1% of $5,000 produces the documented lot size on US30", () => {
  // 45 index points = 450 broker points × $0.10/pt/lot = $45 per lot.
  const result = sizePosition(request({ spec: US30, entry: 39250, sl: 39205 }));
  assert.equal(result.ok, true);
  assert.equal(result.lots, 1.1); // volumeStep 0.1 → 1.111 floors to 1.1
  assert.ok(result.riskMoney <= 50);
});

test("identical risk across three asset classes stays within the budget", () => {
  const specs = [EURUSD, XAUUSD, US30];
  const entries = [
    { spec: EURUSD, entry: 1.0845, sl: 1.0833 },
    { spec: XAUUSD, entry: 2338.5, sl: 2335.0 },
    { spec: US30, entry: 39250, sl: 39205 },
  ];
  const results = entries.map((e) => sizePosition(request(e)));
  for (const [i, result] of results.entries()) {
    assert.equal(result.ok, true, `${specs[i].symbol} should size`);
    assert.ok(
      result.riskMoney <= 50 + 1e-9,
      `${specs[i].symbol} risked ${result.riskMoney}, above the $50 budget`,
    );
    // And it must not be absurdly under-risked either — floor quantisation
    // should cost less than one volume step's worth of budget.
    const stepRisk = specs[i].volumeStep * result.riskPoints * result.pointValue;
    assert.ok(result.riskMoney > 50 - stepRisk - 1e-9, `${specs[i].symbol} under-risked`);
  }
});

test("lots scale inversely with stop distance, not with price", () => {
  const tight = sizePosition(request({ spec: EURUSD, entry: 1.0845, sl: 1.0839 })); // 60 pts
  const wide = sizePosition(request({ spec: EURUSD, entry: 1.0845, sl: 1.0827 })); // 180 pts
  assert.equal(tight.ok, true);
  assert.equal(wide.ok, true);
  // Three times the stop → one third the size. The tolerance absorbs lot
  // quantisation: 0.833→0.83 and 0.277→0.27 give a ratio of 3.07, not 3.00.
  assert.ok(
    Math.abs(tight.lots / wide.lots - 3) < 0.12,
    `expected ~3x, got ${(tight.lots / wide.lots).toFixed(3)}`,
  );
  // Both must still respect the same risk budget.
  assert.ok(tight.riskMoney <= 50 && wide.riskMoney <= 50);
});

// ── Quantisation ─────────────────────────────────────────────────────────────

test("volume is floored to the step, never rounded up", () => {
  assert.equal(quantiseVolume(EURUSD, 0.4199), 0.41);
  assert.equal(quantiseVolume(US30, 1.19), 1.1);
  // Exactly-on-step values must not be pushed down by float error.
  assert.equal(quantiseVolume(EURUSD, 0.3), 0.3);
  assert.equal(quantiseVolume(US30, 0.3), 0.3);
});

test("quantisation never emits a float-artefact volume", () => {
  for (let i = 1; i <= 50; i++) {
    const lots = quantiseVolume(EURUSD, i * 0.07);
    assert.equal(lots, Number(lots.toFixed(2)), `${lots} is not a clean 2dp volume`);
  }
});

test("volume is capped at the broker maximum", () => {
  assert.equal(quantiseVolume({ ...EURUSD, volumeMax: 5 }, 12), 5);
});

// ── Refusals: the rules that protect the account ─────────────────────────────

test("rejects rather than rounds up when the minimum lot exceeds the budget", () => {
  // A 10-point stop on US30 risks $0.10 × 10 × 0.1 lots = $0.10 … so instead
  // use a tiny equity where even volumeMin is too much.
  const result = sizePosition(
    request({ spec: US30, entry: 39250, sl: 39205, equity: 100 }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.rejection, "below_min_lot");
  assert.equal(result.lots, 0);
  assert.match(result.explanation, /Minimum 0\.1 lots/);
});

test("widens a stop that violates the broker's stops level and re-sizes", () => {
  const spec: SymbolSpec = { ...EURUSD, stopsLevel: 200 };
  // Requested 120-point stop is illegal; broker minimum is 200 points.
  const result = sizePosition(request({ spec, entry: 1.0845, sl: 1.0833 }));
  assert.equal(result.ok, true);
  assert.equal(result.slAdjusted, true);
  assert.ok(Math.abs(result.riskPoints - 200) < 1e-6);
  assert.ok(Math.abs(result.sl - 1.0825) < 1e-9);
  // Re-sized down so the wider stop still risks no more than the budget.
  assert.equal(result.lots, 0.25);
  assert.ok(result.riskMoney <= 50);
});

test("rejects when widening the stop destroys the reward:risk", () => {
  const spec: SymbolSpec = { ...EURUSD, stopsLevel: 300 };
  const result = sizePosition(
    request({ spec, entry: 1.0845, sl: 1.0833, tp: 1.0865 }), // 200 pt target
  );
  assert.equal(result.ok, false);
  assert.equal(result.rejection, "reward_risk_too_low");
});

/**
 * THE COST GATES ARE GONE — AND MUST NOT COME BACK.
 *
 * Sizing used to refuse twice on a ratio: `spread / stop > 35%` for forex, and
 * `(spread + commission) / money risked > 35%`. Both fired on A+ setups the rest
 * of the desk had approved, and both were redundant: the spread is charged
 * inside the agent's expectancy (measured net of spread, commission and
 * slippage) and the risk unit is floored above the round-trip cost there, so a
 * market whose edge cannot pay for its own spread fails one gate — the one that
 * prices it — instead of three.
 *
 * These tests pin the new contract: sizing REPORTS the cost and never refuses
 * on it. A refusal here may only ever be about the size of the position, never
 * about how wide the market quotes.
 */
test("a spread that used to be vetoed is now sized and charged, not refused", () => {
  const spec: SymbolSpec = { ...EURUSD, spreadPoints: 40 };
  // 40-point spread against a 100-point stop was 40% — over the old 35% ceiling.
  const result = sizePosition(request({ spec, entry: 1.0845, sl: 1.0835 }));
  assert.equal(result.ok, true, result.explanation);
  assert.ok(result.costMoney > 0, "the spread is still paid for");
  assert.ok(result.costMoney / result.riskMoney > 0.35, "and it is still 40% of the risk — reported, not refused");
});

test("the same spread is charged identically in R on every asset class", () => {
  // A 40-point spread against a 100-point stop is the same fraction of the risk
  // on both instruments. Cost is unit-free once expressed in R, so no asset
  // class needs its own ceiling — the number is comparable by construction.
  const forex: SymbolSpec = { ...EURUSD, spreadPoints: 40 };
  const sized = sizePosition(request({ spec: forex, entry: 1.0845, sl: 1.0835 }));
  assert.equal(sized.ok, true, sized.explanation);
  assert.ok(Math.abs(sized.riskPoints - 100) < 1e-6, `${sized.riskPoints}`);

  const crypto: SymbolSpec = {
    ...EURUSD,
    symbol: "BTCUSD",
    assetClass: "crypto",
    point: 0.01,
    tickSize: 0.01,
    tickValue: 0.01,
    contractSize: 1,
    spreadPoints: 40,
    baseCurrency: "BTC",
  };
  const allowed = sizePosition(request({ spec: crypto, entry: 20_000, sl: 19_999 }));
  assert.equal(allowed.rejection, null, allowed.explanation);
  assert.equal(allowed.ok, true);
  assert.ok(allowed.riskPoints >= 100, "same 100-point stop");
});

test("an explicit cost limit has no gate left to tighten", () => {
  // The field is gone from SizingLimits; a caller passing it is ignored rather
  // than silently re-enabling a veto (extra properties are dropped by the
  // literal spread below). What must NOT happen is a refusal.
  const crypto: SymbolSpec = { ...EURUSD, symbol: "BTCUSD", assetClass: "crypto", spreadPoints: 40 };
  const result = sizePosition({
    ...request({ spec: crypto, entry: 1.0845, sl: 1.0835 }),
    limits: { minMarginLevelPct: 500, maxRiskPct: 2, minRewardRisk: 1 },
  });
  assert.equal(result.rejection, null, result.explanation);
});

test("punitive commission is charged, never refused", () => {
  const spec: SymbolSpec = { ...EURUSD, commissionPerLot: 60, spreadPoints: 2 };
  const result = sizePosition(request({ spec, entry: 1.0845, sl: 1.0833 }));
  assert.equal(result.ok, true, result.explanation);
  // 60 per lot on a symbol whose point value is 1 is 60 points of commission,
  // against a 120-point stop: half the risk, and still only reported.
  assert.ok(result.costMoney / result.riskMoney >= 0.5, `${result.costMoney} / ${result.riskMoney}`);
});

test("shrinks before refusing when margin is tight, and refuses when it cannot", () => {
  // 0.41 lots of EURUSD at 1:500 needs ~$89 margin. Allow only $40 free.
  const shrunk = sizePosition(
    request({ spec: EURUSD, entry: 1.0845, sl: 1.0833, freeMargin: 40, equity: 5000 }),
  );
  assert.equal(shrunk.ok, true);
  assert.ok(shrunk.lots < 0.41, "should have reduced size to fit margin");
  assert.ok(shrunk.marginRequired <= 40);

  const refused = sizePosition(
    request({ spec: EURUSD, entry: 1.0845, sl: 1.0833, freeMargin: 1, equity: 5000 }),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.rejection, "insufficient_margin");
});

test("enforces the post-trade margin level floor, not just free margin", () => {
  // Plenty of free margin, but existing positions already consume most of it.
  const result = sizePosition(
    request({
      spec: EURUSD,
      entry: 1.0845,
      sl: 1.0833,
      equity: 5000,
      freeMargin: 5000,
      usedMargin: 900, // equity/margin would fall under 500%
    }),
  );
  if (result.ok) {
    assert.ok(result.projectedMarginLevel >= 500);
  } else {
    assert.equal(result.rejection, "insufficient_margin");
  }
});

test("rejects a stop on the wrong side of entry", () => {
  const long = sizePosition(request({ spec: EURUSD, entry: 1.0845, sl: 1.0855 }));
  assert.equal(long.ok, false);
  assert.equal(long.rejection, "invalid_input");

  const short = sizePosition(
    request({ spec: EURUSD, side: "sell", entry: 1.0845, sl: 1.0835 }),
  );
  assert.equal(short.ok, false);
  assert.equal(short.rejection, "invalid_input");
});

test("risk percentage is hard-capped regardless of what is requested", () => {
  const result = sizePosition(request({ spec: EURUSD, entry: 1.0845, sl: 1.0833, riskPct: 50 }));
  assert.equal(result.ok, true);
  // Capped at the 2% default → $100 of $5,000, not $2,500.
  assert.ok(result.riskMoney <= 100 + 1e-9, `risked ${result.riskMoney}`);
  assert.ok(result.effectiveRiskPct <= 2 + 1e-9);
});

test("a short sizes identically to the mirrored long", () => {
  const long = sizePosition(request({ spec: XAUUSD, entry: 2338.5, sl: 2335.0 }));
  const short = sizePosition(
    request({ spec: XAUUSD, side: "sell", entry: 2338.5, sl: 2342.0 }),
  );
  assert.equal(long.lots, short.lots);
});

// ── Costs ────────────────────────────────────────────────────────────────────

test("cost combines spread and commission at the traded size", () => {
  const spec: SymbolSpec = { ...EURUSD, spreadPoints: 10, commissionPerLot: 7 };
  // 0.5 lots: spread 10 pts × $1 × 0.5 = $5, commission $3.50 → $8.50.
  assert.ok(Math.abs(costForLots(spec, 0.5) - 8.5) < 1e-9);
});

// ── Portfolio exposure ───────────────────────────────────────────────────────

test("currency legs split FX pairs and group other classes", () => {
  assert.deepEqual(currencyLegs(EURUSD), ["EUR", "USD"]);
  assert.deepEqual(currencyLegs(XAUUSD), ["XAU", "USD"]);
  assert.deepEqual(currencyLegs(US30), ["#indices"]);
});

test("correlated positions aggregate into one currency exposure", () => {
  const specs = new Map<string, SymbolSpec>([
    ["EURUSD", EURUSD],
    ["GBPUSD", { ...EURUSD, symbol: "GBPUSD", baseCurrency: "GBP" }],
  ]);
  const positions: Position[] = [
    {
      ticket: 1, symbol: "EURUSD", side: "buy", volume: 0.4, openPrice: 1.0845,
      openTime: 0, sl: 1.0833, tp: null, profit: 0, swap: 0, commission: 0,
      initialRiskMoney: 50,
    },
    {
      ticket: 2, symbol: "GBPUSD", side: "buy", volume: 0.4, openPrice: 1.27,
      openTime: 0, sl: 1.2688, tp: null, profit: 0, swap: 0, commission: 0,
      initialRiskMoney: 50,
    },
  ];

  const exposure = aggregateExposure(positions, specs, 5000);
  const usd = exposure.find((e) => e.key === "USD");
  assert.ok(usd, "USD leg must be present");
  // Two long-vs-USD trades at $50 each are a single $100 short-USD bet.
  assert.ok(Math.abs(usd.riskMoney - 100) < 1e-9);
  assert.ok(Math.abs(usd.riskPct - 2) < 1e-9);
});

test("opposing positions net off instead of inflating exposure", () => {
  const specs = new Map<string, SymbolSpec>([
    ["EURUSD", EURUSD],
    ["USDCHF", { ...EURUSD, symbol: "USDCHF", baseCurrency: "USD", quoteCurrency: "CHF" }],
  ]);
  const positions: Position[] = [
    {
      ticket: 1, symbol: "EURUSD", side: "buy", volume: 0.4, openPrice: 1.0845,
      openTime: 0, sl: 1.0833, tp: null, profit: 0, swap: 0, commission: 0,
      initialRiskMoney: 50,
    },
    {
      ticket: 2, symbol: "USDCHF", side: "buy", volume: 0.4, openPrice: 0.9,
      openTime: 0, sl: 0.8988, tp: null, profit: 0, swap: 0, commission: 0,
      initialRiskMoney: 50,
    },
  ];
  const exposure = aggregateExposure(positions, specs, 5000);
  const usd = exposure.find((e) => e.key === "USD");
  // Short USD via EURUSD and long USD via USDCHF cancel.
  assert.equal(usd, undefined);
});

// ── Kelly ────────────────────────────────────────────────────────────────────

test("fractional Kelly is zero for a negative edge and positive for a real one", () => {
  assert.equal(kellyFraction(0.4, 1), 0);
  assert.ok(kellyFraction(0.6, 2) > 0);
  // Quarter Kelly of a 60%/2R edge: full = (0.6*2 − 0.4)/2 = 0.4 → 0.10.
  assert.ok(Math.abs(kellyFraction(0.6, 2, 0.25) - 0.1) < 1e-9);
});

test("Kelly grows with edge — size follows measured advantage, not losses", () => {
  const weak = kellyFraction(0.52, 1.5);
  const strong = kellyFraction(0.65, 1.5);
  assert.ok(strong > weak);
});
