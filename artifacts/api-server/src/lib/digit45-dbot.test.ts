import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DIGIT45_DBOT_FIXTURES, digit45FixturesDir, renderDigit45Fixture } from "./digit45-dbot.fixtures";
import { buildDigit45DbotStrategy, type Digit45DbotInput } from "./digit45-dbot";

const base: Digit45DbotInput = {
  symbol: "R_100", displayName: "Volatility 100 Index", stake: 1,
  takeProfit: 10, stopLoss: 30, maxRecoverySteps: 3, markupPercent: 10,
  maxStake: 20, currency: "USD",
};

describe("scanner → paired DBot XML", () => {
  it("keeps all builder-loaded fixtures byte-for-byte in sync with the API generator", () => {
    for (const name of Object.keys(DIGIT45_DBOT_FIXTURES)) {
      assert.equal(fs.readFileSync(path.join(digit45FixturesDir, `${name}.xml`), "utf8"), renderDigit45Fixture(name));
    }
  });

  it("pins the market, 1-tick duration, fixed barriers and one block per pair mode", () => {
    const { xml, summary } = buildDigit45DbotStrategy(base);
    assert.match(xml, /is_dbot="true"/);
    assert.match(xml, /<field name="SYMBOL_LIST">R_100<\/field>/);
    assert.match(xml, /<field name="TRADETYPE_LIST">overunder<\/field>/);
    assert.match(xml, /<field name="TYPE_LIST">both<\/field>/);
    assert.match(xml, /<field name="DURATIONTYPE_LIST">t<\/field>/);
    assert.match(xml, /<field name="RESTARTONERROR">FALSE<\/field>/);
    assert.equal((xml.match(/<block type="purchase_digit45_pair"/g) ?? []).length, 2);
    assert.equal((xml.match(/<block type="purchase"/g) ?? []).length, 0);
    assert.match(xml, /<field name="MODE">normal<\/field>/);
    assert.match(xml, /<field name="MODE">recovery<\/field>/);
    assert.equal((xml.match(/<field name="EXPECTED_CURRENCY">USD<\/field>/g) ?? []).length, 2);
    assert.equal(summary.pairExposure, 2);
    assert.deepEqual(summary.normal, ["Over 4", "Under 5"]);
    assert.deepEqual(summary.recovery, ["Over 5", "Under 4"]);
  });

  it("uses two-leg combined P/L for debt and has bounded recovery and session risk", () => {
    const { xml } = buildDigit45DbotStrategy(base);
    assert.match(xml, /Pair Recovery Debt/);
    assert.match(xml, /Session Pair PnL/);
    assert.match(xml, /Recovery Pairs Used/);
    assert.match(xml, /<field name="DETAIL">profit<\/field>/);
    assert.match(xml, /<field name="DETAIL">bothLost<\/field>/);
    assert.match(xml, /<field name="DETAIL">partial<\/field>/);
    assert.match(xml, /<field name="NUM">30<\/field>/);
  });

  it("escapes broker/display strings and refuses unsafe or malformed settings", () => {
    const { xml } = buildDigit45DbotStrategy({ ...base, displayName: "Vol <100> & Co" });
    assert.match(xml, /Vol &lt;100&gt; &amp; Co/);
    assert.doesNotMatch(xml, /Vol <100>/);
    for (const patch of [
      { symbol: "R_100' ); buy()" }, { currency: "BTC" },
      { stake: 0.1 }, { stake: Number.NaN }, { stake: 1.333 },
      { maxStake: 0.35 }, { stopLoss: 1 }, { markupPercent: -10 },
      { maxRecoverySteps: 11 }, { takeProfit: Infinity },
    ]) {
      assert.throws(() => buildDigit45DbotStrategy({ ...base, ...patch }), JSON.stringify(patch));
    }
  });
});
