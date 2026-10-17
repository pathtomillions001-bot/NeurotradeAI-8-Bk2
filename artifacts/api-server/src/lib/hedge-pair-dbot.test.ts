/**
 * API ↔ Builder parity and committed-XML regression tests for Hedge Pair Forge.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HEDGE_PAIR_BLOCK_TYPES,
  HEDGE_PAIR_DEFINITIONS,
  HEDGE_PAIR_FAMILIES,
  buildHedgePairStrategy,
  type HedgePairInput,
} from "./hedge-pair-dbot";
import { HEDGE_PAIR_FIXTURES, fixturesDir, renderFixture } from "./hedge-pair-dbot.fixtures";

const BASE: HedgePairInput = {
  symbol: "R_50",
  displayName: "Volatility 50 Index",
  family: "HIGHER_LOWER",
  stake: 1,
  requestedDuration: 1,
  upperOffset: 0.5,
  lowerOffset: 0.75,
  analysisWindow: 500,
  minSamples: 80,
  requiredEdge: 0.01,
  recoveryMultiplier: 1.62,
  maxRecoverySteps: 3,
  markupPercent: 10,
  maxStake: 500,
  takeProfit: 10,
  stopLoss: 5,
  maxConsecutiveDoubleLosses: 6,
  currency: "USD",
};

const builderAnalysisUrl = new URL(
  "../../../dbot-builder/src/external/bot-skeleton/services/tradeEngine/trade/hedge-pair-analysis.js",
  import.meta.url,
);
const builderAnalysisSource = readFileSync(fileURLToPath(builderAnalysisUrl), "utf8");
const builderAnalysisModule = await import(
  `data:text/javascript;base64,${Buffer.from(builderAnalysisSource).toString("base64")}`
) as {
  HEDGE_PAIR_FAMILIES: readonly string[];
  HEDGE_PAIR_DEFINITIONS: typeof HEDGE_PAIR_DEFINITIONS;
};

function blockTypes(xml: string): string[] {
  return Array.from(xml.matchAll(/<block\b[^>]*\btype="([^"]+)"/g), match => match[1]!);
}

describe("Hedge Pair Forge API ↔ Builder contract parity", () => {
  it("uses exactly the same seven families, contract legs, barrier counts and timing in both runtimes", () => {
    assert.deepEqual(HEDGE_PAIR_FAMILIES, builderAnalysisModule.HEDGE_PAIR_FAMILIES);
    assert.deepEqual(
      JSON.parse(JSON.stringify(HEDGE_PAIR_DEFINITIONS)),
      JSON.parse(JSON.stringify(builderAnalysisModule.HEDGE_PAIR_DEFINITIONS)),
    );
    for (const family of HEDGE_PAIR_FAMILIES) {
      assert.equal(HEDGE_PAIR_DEFINITIONS[family].legs.length, 2, `${family} must remain a two-leg hedge`);
      assert.ok(HEDGE_PAIR_DEFINITIONS[family].timing.confirmations >= 2);
      assert.ok(HEDGE_PAIR_DEFINITIONS[family].timing.recoveryConfirmations >= 2);
    }
    assert.deepEqual(HEDGE_PAIR_DEFINITIONS.HIGHER_LOWER.legs.map(leg => leg.type), ["CALL", "PUT"]);
    assert.deepEqual(HEDGE_PAIR_DEFINITIONS.HIGHER_LOWER.legs.map(leg => leg.barriers), [1, 1]);
  });

  it("rejects invalid families, stakes, and missing price-barrier offsets", () => {
    assert.throws(() => buildHedgePairStrategy({ ...BASE, family: "not-a-family" }), /supported hedge-pair family/);
    assert.throws(() => buildHedgePairStrategy({ ...BASE, stake: 0.1 }), /between 0.35 and 50000/);
    assert.throws(() => buildHedgePairStrategy({ ...BASE, family: "HIGHER_LOWER", upperOffset: 0 }), /offsets must be positive/);
    assert.throws(() => buildHedgePairStrategy({ ...BASE, family: "TOUCH_UPPER_LOWER", lowerOffset: 0 }), /offsets must be positive/);
    assert.throws(() => buildHedgePairStrategy({ ...BASE, stake: 2, maxStake: 1 }), /cannot exceed/);
    assert.throws(() => buildHedgePairStrategy({ ...BASE, stake: 50001, maxStake: 50001 }), /between 0.35 and 50000/);
  });

  it("generates Builder-native paired blocks and maps Higher/Lower to CALL/PUT barriers", () => {
    const strategy = buildHedgePairStrategy({ ...BASE, requestedDuration: 50 });
    assert.match(strategy.xml, /<field name="TRADETYPECAT_LIST">callput<\/field>/);
    assert.match(strategy.xml, /<field name="TRADETYPE_LIST">higherlower<\/field>/);
    assert.match(strategy.xml, /<block type="nt_hedge_pair_cycle"/);
    assert.match(strategy.xml, /Hedge Pair Forge/);
    assert.match(strategy.warnings.join(" "), /Create DBot only loads blocks/);
    assert.match(strategy.warnings.join(" "), /only when the user presses.*Run/i);
    assert.deepEqual(strategy.summary.contracts, ["CALL", "PUT"]);
    assert.equal(strategy.summary.targetDurationTicks, 1);
    assert.equal(strategy.summary.basePairExposure, 2);
    assert.equal(strategy.summary.entryConfirmations, 2);
    assert.equal(strategy.summary.recoveryConfirmations, 3);
    const generatedTypes = [...new Set(blockTypes(strategy.xml))].sort();
    const permittedTypes = [...HEDGE_PAIR_BLOCK_TYPES].sort();
    assert.deepEqual(generatedTypes.filter(type => !permittedTypes.includes(type)), []);
  });

  it("lets users increase fresh-tick timing but never lowers family safety floors", () => {
    const minimum = buildHedgePairStrategy({
      ...BASE,
      family: "ONLY_UPS_DOWNS",
      entryConfirmations: 1,
      recoveryConfirmations: 1,
    });
    assert.equal(minimum.summary.entryConfirmations, 3);
    assert.equal(minimum.summary.recoveryConfirmations, 4);
    const increased = buildHedgePairStrategy({
      ...BASE,
      family: "ONLY_UPS_DOWNS",
      entryConfirmations: 8,
      recoveryConfirmations: 10,
    });
    assert.equal(increased.summary.entryConfirmations, 8);
    assert.equal(increased.summary.recoveryConfirmations, 10);
    assert.match(increased.xml, /<field name="ENTRY_CONFIRMATIONS">8<\/field>/);
    assert.match(increased.xml, /<field name="RECOVERY_CONFIRMATIONS">10<\/field>/);
  });

  it("keeps all seven committed Blockly XML fixtures equal to current API output", () => {
    assert.equal(Object.keys(HEDGE_PAIR_FIXTURES).length, 7);
    for (const name of Object.keys(HEDGE_PAIR_FIXTURES)) {
      const file = `${fixturesDir()}/${name}.xml`;
      assert.equal(readFileSync(file, "utf8"), renderFixture(name), `${name}.xml has drifted; regenerate it`);
    }
  });

  it("keeps every fixture within the vendored block allowlist and uses the pair purchase alias", () => {
    for (const [name, input] of Object.entries(HEDGE_PAIR_FIXTURES)) {
      const xml = renderFixture(name);
      const unknown = [...new Set(blockTypes(xml))].filter(type => !HEDGE_PAIR_BLOCK_TYPES.includes(type as never));
      assert.deepEqual(unknown, [], `${name} contains block types not registered in the builder allowlist`);
      assert.match(xml, /<block type="nt_hedge_pair_cycle"/);
      assert.doesNotMatch(xml, /<block type="purchase"/);
      assert.match(xml, new RegExp(`<field name="FAMILY">${input.family}<\\/field>`));
    }
  });
});
