/**
 * API ↔ Builder parity and committed-XML regression tests for Hedge Pair Forge.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ANALYSIS_WINDOW,
  DEFAULT_PAIR_MARKUP_PERCENT,
  DEFAULT_PAIR_RECOVERY_MULTIPLIER,
  HEDGE_PAIR_BLOCK_TYPES,
  HEDGE_PAIR_DEFINITIONS,
  HEDGE_PAIR_FAMILIES,
  MAX_ANALYSIS_WINDOW,
  MAX_WATCH_MARKETS,
  MIN_REPRESENTABLE_OFFSET,
  buildHedgePairStrategy,
  normalizeWatchMarkets,
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

  it("keeps every committed Blockly XML fixture equal to current API output", () => {
    // Seven families, plus the console's real one-pip R_50 offsets, which the
    // Builder loads into the vendored Blockly to prove the field precision fix.
    assert.equal(Object.keys(HEDGE_PAIR_FIXTURES).length, 8);
    for (const name of Object.keys(HEDGE_PAIR_FIXTURES)) {
      const file = `${fixturesDir()}/${name}.xml`;
      assert.equal(readFileSync(file, "utf8"), renderFixture(name), `${name}.xml has drifted; regenerate it`);
    }
  });

  it("defaults to the deep tape, a break-even hurdle and this bot's own recovery numbers", () => {
    const strategy = buildHedgePairStrategy({
      ...BASE,
      analysisWindow: undefined as unknown as number,
      requiredEdge: undefined as unknown as number,
      recoveryMultiplier: undefined as unknown as number,
      markupPercent: undefined as unknown as number,
    });
    assert.equal(strategy.summary.analysisWindow, DEFAULT_ANALYSIS_WINDOW);
    assert.equal(DEFAULT_ANALYSIS_WINDOW, 4999);
    assert.equal(MAX_ANALYSIS_WINDOW, 5000);
    assert.equal(strategy.summary.requiredEdge, 0);
    assert.equal(strategy.summary.recoveryMultiplier, DEFAULT_PAIR_RECOVERY_MULTIPLIER);
    assert.equal(strategy.summary.markupPercent, DEFAULT_PAIR_MARKUP_PERCENT);
    assert.equal(DEFAULT_PAIR_MARKUP_PERCENT, 40);
    assert.match(strategy.xml, /<field name="WINDOW">4999<\/field>/);
    assert.match(strategy.xml, /<field name="EDGE_HURDLE">0<\/field>/);
    assert.match(strategy.xml, /<field name="RECOVERY_MULTIPLIER">2.43<\/field>/);
    assert.match(strategy.xml, /<field name="MARKUP_PERCENT">40<\/field>/);
    // Deriv rejects 5000, so the window is clamped rather than passed through.
    assert.equal(buildHedgePairStrategy({ ...BASE, analysisWindow: 99999 }).summary.analysisWindow, MAX_ANALYSIS_WINDOW);
  });

  it("keeps a one-pip barrier offset representable and refuses anything smaller", () => {
    assert.equal(MIN_REPRESENTABLE_OFFSET, 1e-8);
    const onePip = buildHedgePairStrategy({ ...BASE, family: "HIGHER_LOWER", upperOffset: 0.0001, lowerOffset: 0.0001 });
    assert.match(onePip.xml, /<field name="UPPER_OFFSET">0\.0001<\/field>/);
    assert.match(onePip.xml, /<field name="LOWER_OFFSET">0\.0001<\/field>/);
    // Never exponent notation inside a Blockly field.
    const tiny = buildHedgePairStrategy({ ...BASE, family: "HIGHER_LOWER", upperOffset: 1e-8, lowerOffset: 1e-8 });
    assert.match(tiny.xml, /<field name="UPPER_OFFSET">0\.00000001<\/field>/);
    assert.throws(
      () => buildHedgePairStrategy({ ...BASE, family: "TOUCH_UPPER_LOWER", upperOffset: 1e-12, lowerOffset: 0.5 }),
      /at least 1e-8/,
    );
  });

  it("normalizes a watch list: seed first, deduplicated, capped at the socket budget", () => {
    assert.deepEqual(normalizeWatchMarkets("R_50,R_100,r_25,R_50", "R_50"), ["R_50", "R_100", "R_25"]);
    assert.deepEqual(normalizeWatchMarkets("R_100,R_25", "R_50"), ["R_50", "R_100", "R_25"]);
    assert.deepEqual(normalizeWatchMarkets("", "R_50"), ["R_50"]);
    assert.deepEqual(normalizeWatchMarkets("bad symbol,R_50,1HZ15V", "R_50"), ["R_50", "1HZ15V"]);
    assert.equal(normalizeWatchMarkets(Array.from({ length: 40 }, (_, i) => `R_${i + 1}`).join(","), "R_50").length, MAX_WATCH_MARKETS);

    const single = buildHedgePairStrategy({ ...BASE });
    assert.deepEqual(single.summary.watchMarkets, ["R_50"]);
    assert.match(single.xml, /<field name="MARKETS">R_50<\/field>/);

    const many = buildHedgePairStrategy({ ...BASE, watchMarkets: "R_50,R_100,R_25,1HZ15V" });
    assert.deepEqual(many.summary.watchMarkets, ["R_50", "R_100", "R_25", "1HZ15V"]);
    assert.match(many.xml, /<field name="MARKETS">R_50,R_100,R_25,1HZ15V<\/field>/);
    assert.match(many.warnings.join(" "), /ranks R_50, R_100, R_25, 1HZ15V/);
    assert.match(many.warnings.join(" "), /never on assumed payouts/);
    assert.match(single.warnings.join(" "), /no market-to-market switching can occur/);
  });

  it("appends the watch list and patience valve last, so older workspaces still compile", () => {
    const { xml } = buildHedgePairStrategy({ ...BASE, watchMarkets: "R_50,R_100", forceEntryAfter: 120 });
    const cycleBlock = xml.slice(xml.indexOf('<block type="nt_hedge_pair_cycle"'), xml.indexOf("</block>", xml.indexOf('<block type="nt_hedge_pair_cycle"')));
    const cycleFields = [...cycleBlock.matchAll(/<field name="([A-Z_0-9]+)">/g)].map(match => match[1]!);
    // The runtime signature is positional: new arguments go at the END, so a
    // workspace saved with fourteen of them still means exactly what it meant.
    assert.deepEqual(cycleFields, [
      "FAMILY", "DURATION", "UPPER_OFFSET", "LOWER_OFFSET", "WINDOW", "MIN_SAMPLES", "EDGE_HURDLE",
      "RECOVERY_MULTIPLIER", "MAX_RECOVERY_STEPS", "MARKUP_PERCENT", "MAX_STAKE", "TAKE_PROFIT",
      "STOP_LOSS", "LOSS_BREAKER", "ENTRY_CONFIRMATIONS", "RECOVERY_CONFIRMATIONS", "MARKETS", "FORCE_ENTRY_AFTER",
    ]);
    assert.match(cycleBlock, /<field name="MARKETS">R_50,R_100<\/field>/);
    assert.match(cycleBlock, /<field name="FORCE_ENTRY_AFTER">120<\/field>/);
    assert.match(xml, /<field name="FORCE_ENTRY_AFTER">120<\/field>/);
    assert.match(buildHedgePairStrategy({ ...BASE, watchMarkets: "R_50,R_100", forceEntryAfter: 120 }).warnings.join(" "), /patience valve is ON/);
    assert.equal(buildHedgePairStrategy({ ...BASE, forceEntryAfter: 99999 }).summary.forceEntryAfter, 3600);
    assert.equal(buildHedgePairStrategy({ ...BASE, forceEntryAfter: -5 }).summary.forceEntryAfter, 0);
  });

  it("projects the pair recovery ladder from a two-premium debt and labels the assumption", () => {
    const { recoveryProjection } = buildHedgePairStrategy({ ...BASE, stake: 1, markupPercent: 40, recoveryMultiplier: 2.43 }).summary;
    assert.equal(recoveryProjection.debt, 2);
    assert.equal(recoveryProjection.target, 2.8);
    assert.equal(recoveryProjection.stakePerLeg, 1.96);
    assert.equal(recoveryProjection.pairStake, 3.92);
    assert.equal(recoveryProjection.netOnPairWin, 0.84);
    assert.equal(recoveryProjection.residualAfterWin, 1.16);
    assert.equal(recoveryProjection.pairsToClear, 6);
    assert.equal(recoveryProjection.capBinding, "none");
    assert.match(recoveryProjection.caveat, /no live quote exists at build time/);
    assert.equal(recoveryProjection.ladder[0]!.stakePerLeg, 1.96);
    // A double loss mid-recovery is what escalates the ladder.
    assert.ok(recoveryProjection.ladder.length >= 2);
    assert.ok(recoveryProjection.ladder[1]!.debt > recoveryProjection.debt);

    // At a payout of 2.00x or lower a split win cannot repay anything, and the
    // projection says so instead of printing a plan that cannot work. The old
    // 1.62 ladder ceiling is exactly that case, which is one more reason this
    // bot's default moved to 2.43.
    const weak = buildHedgePairStrategy({ ...BASE, stake: 1, recoveryMultiplier: 1.62 }).summary.recoveryProjection;
    assert.ok(weak.netOnPairWin < 0);
    assert.equal(weak.pairsToClear, 0);
    assert.equal(weak.capBinding, "ladder ceiling / max stake");
    assert.equal(weak.stakePerLeg, 1.62);
    assert.match(weak.caveat, /no live quote exists at build time/);
    const weakXml = buildHedgePairStrategy({ ...BASE, stake: 1, recoveryMultiplier: 1.62 }).xml;
    assert.match(weakXml, /REFUSES to size a recovery until the live legs pay above 2\.00×/);
    assert.doesNotMatch(weakXml, /cleared by \d+ consecutive split wins/);
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
