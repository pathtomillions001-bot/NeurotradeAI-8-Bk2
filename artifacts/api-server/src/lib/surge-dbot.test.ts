import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSurgeDbotStrategy, SURGE_DBOT_BLOCK_TYPES, type SurgeDbotInput } from "./surge-dbot";
import { SURGE_DBOT_FIXTURES, surgeFixturesDir, renderSurgeFixture } from "./surge-dbot.fixtures";

const BASE: SurgeDbotInput = {
  symbol: "R_50",
  displayName: "Volatility 50 Index",
  watchMarkets: ["R_10", "R_25", "R_75", "R_100"],
  stake: 1,
  takeProfit: 10,
  stopLoss: 5,
  maxRecoverySteps: 3,
  markupPercent: 10,
  maxStake: 500,
  payout: 1.92,
  breakerDepth: 5,
  currency: "USD",
  window: 240,
  weights: [0.3, 0.25, 0.2, 0.25],
  tau: 1,
};

describe("Vector Surge DBot generator", () => {
  it("emits a valid Rise/Fall trade definition and only registered blocks", () => {
    const { xml } = buildSurgeDbotStrategy(BASE);
    assert.match(xml, /<field name="TRADETYPECAT_LIST">callput<\/field>/);
    assert.match(xml, /<field name="TRADETYPE_LIST">callput<\/field>/);
    assert.match(xml, /<field name="TYPE_LIST">both<\/field>/);
    const types = [...xml.matchAll(/<(?:block|shadow) type="([^"]+)"/g)].map(match => match[1]!);
    const allowed = new Set<string>(SURGE_DBOT_BLOCK_TYPES);
    assert.deepEqual([...new Set(types.filter(type => !allowed.has(type)))], []);
    assert.equal((xml.match(/<block /g) ?? []).length, (xml.match(/<\/block>/g) ?? []).length);
  });

  it("carries both normal/recovery analysers, market switching and both purchase sides", () => {
    const { xml, summary } = buildSurgeDbotStrategy(BASE);
    assert.match(xml, /<field name="MODE">NORMAL<\/field>/);
    assert.match(xml, /<field name="MODE">RECOVERY<\/field>/);
    assert.match(xml, /nt_switch_market/);
    assert.deepEqual(summary.watchMarkets, ["R_50", "R_10", "R_25", "R_75", "R_100"]);
    const purchases = [...xml.matchAll(/<field name="PURCHASE_LIST">([^<]+)<\/field>/g)].map(match => match[1]);
    assert.deepEqual(new Set(purchases), new Set(["CALL", "PUT"]));
  });

  it("uses the shared debt ledger, account caps and cent-up rounding", () => {
    const { xml } = buildSurgeDbotStrategy(BASE);
    assert.match(xml, /Recovery Debt/);
    assert.match(xml, /<field name="OP">ROUNDUP<\/field>/);
    assert.match(xml, /<block type="balance"/);
    assert.match(xml, /<field name="NUM">1\.1<\/field>/);
    assert.match(xml, /Circuit breaker: 5 consecutive losses/);
  });

  it("normalizes fitted parameters and validates unsafe input", () => {
    const strategy = buildSurgeDbotStrategy({ ...BASE, weights: [3, 2, 1, 4], tau: 99, window: 5000 });
    assert.equal(strategy.summary.weights.reduce((a, b) => a + b, 0), 1);
    assert.equal(strategy.summary.tau, 2.5);
    assert.equal(strategy.summary.window, 500);
    assert.throws(() => buildSurgeDbotStrategy({ ...BASE, stake: 0.1 }), /stake/);
    assert.throws(() => buildSurgeDbotStrategy({ ...BASE, symbol: "R 50" }), /symbol/);
  });

  it("matches every committed real-builder fixture", () => {
    for (const name of Object.keys(SURGE_DBOT_FIXTURES)) {
      assert.equal(readFileSync(join(surgeFixturesDir(), `${name}.xml`), "utf8"), renderSurgeFixture(name));
    }
  });
});
