import { test } from "node:test";
import assert from "node:assert/strict";
import { inferAssetClass, normalizeAssetClass } from "./catalog";

test("broker catalog categories cover the supported asset classes", () => {
  assert.equal(inferAssetClass({ symbol: "EURUSD.a", calculationMode: "FOREX" }), "forex");
  assert.equal(inferAssetClass({ symbol: "XAUUSD", baseCurrency: "XAU" }), "metals");
  assert.equal(inferAssetClass({ symbol: "US30", path: "CFD\\Indices" }), "indices");
  assert.equal(inferAssetClass({ symbol: "WTI", path: "Commodities\\Energy" }), "commodities");
  assert.equal(inferAssetClass({ symbol: "BTCUSD", path: "Crypto" }), "crypto");
  assert.equal(inferAssetClass({ symbol: "ESZ6", path: "Futures", calculationMode: "EXCH_FUTURES" }), "futures");
  assert.equal(inferAssetClass({ symbol: "AAPL", path: "Shares", calculationMode: "EXCH_STOCKS" }), "stocks");
});

test("unknown MT5 classes fall back safely instead of being mislabelled", () => {
  assert.equal(inferAssetClass({ symbol: "CUSTOM-RATES" }), "other");
  assert.equal(normalizeAssetClass("crypto"), "crypto");
  assert.equal(normalizeAssetClass("stocks "), null);
});
