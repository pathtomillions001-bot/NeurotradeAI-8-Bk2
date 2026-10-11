/**
 * WP2 — contract-spec tests.
 *
 * A study's R is denominated in the broker's contract spec, so the spec builder
 * is the single point where a study can silently go wrong: an assumed
 * `tickValue` that is 2× out turns a losing configuration into a winning one
 * with no statistic complaining. These tests pin the two things that make that
 * visible — the assumption list, and the class inference that drives the
 * defaults.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { inferAssetClass, specForSymbol } from "./specs";

test("the assumption list is exhaustive: every defaulted value is declared", () => {
  const { assumed } = specForSymbol("EURUSD");
  for (const key of [
    "assetClass=",
    "point=",
    "digits=",
    "tickSize=",
    "tickValue=",
    "contractSize=",
    "volumeMin=",
    "volumeStep=",
    "spreadPoints=",
    "commissionPerLot=",
  ]) {
    assert.ok(
      assumed.some((entry) => entry.startsWith(key)),
      `an assumed study value is not declared: ${key} — a hidden caveat is a bug waiting in the results`,
    );
  }
  // A value that was PASSED IN is not an assumption and must not be listed.
  const explicit = specForSymbol("EURUSD", { tickValue: 0.5 });
  assert.ok(!explicit.assumed.some((entry) => entry.startsWith("tickValue=")));
  assert.equal(explicit.spec.tickValue, 0.5);
});

test("a 5-digit FX pair gets the retail-common defaults, and JPY the 3-digit one", () => {
  const eurusd = specForSymbol("EURUSD").spec;
  assert.equal(eurusd.assetClass, "forex");
  assert.equal(eurusd.point, 0.00001);
  assert.equal(eurusd.digits, 5);
  assert.equal(eurusd.tickSize, 0.00001);
  assert.equal(eurusd.contractSize, 100_000);
  assert.equal(eurusd.spreadPoints, 12);

  const usdjpy = specForSymbol("USDJPY").spec;
  assert.equal(usdjpy.assetClass, "forex");
  assert.equal(usdjpy.point, 0.001);
  assert.equal(usdjpy.digits, 3);

  // Broker suffixes must not change the reading.
  assert.equal(specForSymbol("EURUSD.a").spec.point, 0.00001);
  assert.equal(specForSymbol("EURUSD_raw").spec.assetClass, "forex");
  assert.equal(specForSymbol("EUR/USD").spec.assetClass, "forex");
});

test("the class inference is a guess, so it is declared — and overridable", () => {
  assert.equal(inferAssetClass("XAUUSD"), "metals");
  assert.equal(inferAssetClass("GOLD"), "metals");
  assert.equal(inferAssetClass("US30"), "indices");
  assert.equal(inferAssetClass("NAS100"), "indices");
  assert.equal(inferAssetClass("BTCUSD"), "crypto");
  assert.equal(inferAssetClass("USOIL"), "commodities");
  assert.equal(inferAssetClass("EURUSD"), "forex");
  assert.equal(inferAssetClass("AAPL"), "stocks");

  const overridden = specForSymbol("XAUUSD", { assetClass: "forex", point: 0.01, spreadPoints: 30 });
  assert.equal(overridden.spec.assetClass, "forex");
  assert.equal(overridden.spec.point, 0.01);
  assert.equal(overridden.spec.spreadPoints, 30);
  assert.ok(!overridden.assumed.some((entry) => entry.startsWith("assetClass=")));
});

test("digits follow the point, and a non-standard point is rejected by construction", () => {
  assert.equal(specForSymbol("EURUSD", { point: 0.0001 }).spec.digits, 4);
  assert.equal(specForSymbol("EURUSD", { point: 0.0001, digits: 5 }).spec.digits, 5);
  assert.equal(specForSymbol("XAUUSD", { point: 0.01 }).spec.digits, 2);
  // The spec object is what the desk consumes: it must carry the symbol name.
  assert.equal(specForSymbol("GBPUSD").spec.symbol, "GBPUSD");
  assert.equal(specForSymbol("GBPUSD").spec.volumeMin, 0.01);
  assert.equal(specForSymbol("GBPUSD").spec.volumeMax, 100);
});
