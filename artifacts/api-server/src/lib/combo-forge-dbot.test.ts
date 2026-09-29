/**
 * Combo Forge → DBot generator tests.
 *
 *   1. The generator is a pure function that REFUSES illegal input loudly.
 *   2. The emitted XML only uses block types the vendored builder registers
 *      (the builder's `load()` rejects a whole workspace on ONE unknown type).
 *   3. The committed builder fixtures equal the current generator output, so
 *      the builder's jest suite (which loads them into the REAL Blockly and
 *      runs them against the REAL analyser on scripted tapes) cannot drift.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildComboForgeStrategy,
  normaliseComboSet,
  comboCsv,
  comboPayout,
  COMBO_FORGE_BLOCK_TYPES,
  COMBO_MIN_WINDOW,
  type ComboForgeInput,
} from "./combo-forge-dbot";
import { COMBO_FORGE_FIXTURES, fixturesDir, renderFixture } from "./combo-forge-dbot.fixtures";

const BASE: ComboForgeInput = {
  symbol: "R_50",
  displayName: "Volatility 50 Index",
  normal: [
    { type: "DIGITOVER", digit: 1 },
    { type: "DIGITUNDER", digit: 8 },
    { type: "CALL", digit: -1 },
  ],
  recovery: [
    { type: "DIGITEVEN", digit: -1 },
    { type: "DIGITOVER", digit: 4 },
    { type: "PUT", digit: -1 },
  ],
  stake: 1,
  takeProfit: 10,
  stopLoss: 5,
  maxRecoverySteps: 3,
  markupPercent: 10,
  maxStake: 500,
  breakerDepth: 6,
  currency: "USD",
  window: 500,
  watchMarkets: ["R_10", "R_25", "R_75"],
};

describe("combo-forge input validation", () => {
  it("rejects empty sets, bad barriers, unknown types and oversized sets", () => {
    assert.throws(() => buildComboForgeStrategy({ ...BASE, normal: [] }), /at least one contract/);
    assert.throws(() => buildComboForgeStrategy({ ...BASE, recovery: [] }), /at least one contract/);
    assert.throws(() => normaliseComboSet([{ type: "DIGITOVER", digit: 9 }], "normal"), /Over needs a barrier 0–8/);
    assert.throws(() => normaliseComboSet([{ type: "DIGITUNDER", digit: 0 }], "normal"), /Under needs a barrier 1–9/);
    assert.throws(() => normaliseComboSet([{ type: "TICKHIGH" as never, digit: -1 }], "normal"), /unknown contract type/);
    const many = Array.from({ length: 9 }, (_, i) => ({ type: "DIGITOVER" as const, digit: Math.min(8, i) }));
    assert.throws(() => normaliseComboSet(many, "normal"), /at most 8/);
  });
  it("deduplicates, and strips digits from parity and Rise/Fall contracts", () => {
    const set = normaliseComboSet(
      [
        { type: "DIGITEVEN", digit: 3 },
        { type: "DIGITEVEN", digit: -1 },
        { type: "CALL", digit: 7 },
        { type: "PUT", digit: -1 },
      ],
      "recovery",
    );
    assert.deepEqual(set, [
      { type: "DIGITEVEN", digit: -1 },
      { type: "CALL", digit: -1 },
      { type: "PUT", digit: -1 },
    ]);
  });
  it("accepts auto digits for Matches/Differs only", () => {
    assert.doesNotThrow(() => normaliseComboSet([{ type: "DIGITMATCH", digit: -1 }, { type: "DIGITDIFF", digit: 4 }], "normal"));
    assert.throws(() => normaliseComboSet([{ type: "DIGITMATCH", digit: 10 }], "normal"), /Matches\/Differs digit/);
  });
  it("rejects a sub-minimum stake, a bad symbol and non-positive boundaries", () => {
    assert.throws(() => buildComboForgeStrategy({ ...BASE, stake: 0.1 }), /stake must be ≥ 0.35/);
    assert.throws(() => buildComboForgeStrategy({ ...BASE, symbol: "R 50; drop" }), /symbol/);
    assert.throws(() => buildComboForgeStrategy({ ...BASE, takeProfit: 0 }), /takeProfit/);
    assert.throws(() => buildComboForgeStrategy({ ...BASE, stopLoss: -1 }), /stopLoss/);
  });
});

describe("combo-forge maths and wire format", () => {
  it("prices every contract type from the canonical tables", () => {
    assert.equal(comboPayout({ type: "DIGITOVER", digit: 1 }), 1.23);
    assert.equal(comboPayout({ type: "DIGITEVEN", digit: -1 }), 1.95);
    assert.equal(comboPayout({ type: "DIGITMATCH", digit: -1 }), 8.93);
    assert.equal(comboPayout({ type: "DIGITDIFF", digit: -1 }), 1.09);
    assert.equal(comboPayout({ type: "CALL", digit: -1 }), 1.92);
    assert.equal(comboPayout({ type: "PUT", digit: -1 }), 1.92);
  });
  it("emits the runtime CSV the vendored block parses", () => {
    assert.equal(
      comboCsv(normaliseComboSet(BASE.normal, "normal")),
      "DIGITOVER:1:1.23,DIGITUNDER:8:1.23,CALL:-1:1.92",
    );
  });
});

describe("combo-forge strategy shape", () => {
  it("emits only block types the vendored builder registers", () => {
    for (const input of Object.values(COMBO_FORGE_FIXTURES).concat(BASE)) {
      const { xml } = buildComboForgeStrategy(input);
      const types = [...xml.matchAll(/<(?:block|shadow) type="([^"]+)"/g)].map((m) => m[1]!);
      const allowed = new Set<string>(COMBO_FORGE_BLOCK_TYPES);
      const unknown = [...new Set(types.filter((t) => !allowed.has(t)))];
      assert.deepEqual(unknown, [], `unexpected block types: ${unknown.join(", ")}`);
    }
  });

  it("every allowlisted custom block is actually registered in the vendored builder", () => {
    const dir = join(fixturesDir(), "../../../external/bot-skeleton/scratch/blocks/Binary/Tick Analysis");
    const src = readFileSync(join(dir, "neurotrade_combo_forge.js"), "utf8");
    for (const type of ["nt_analyse_combo", "nt_combo_decision"]) {
      assert.ok(COMBO_FORGE_BLOCK_TYPES.includes(type as never));
      assert.ok(src.includes(`window.Blockly.Blocks.${type} =`), `${type} has no block definition`);
      assert.ok(src.includes(`forBlock.${type} =`), `${type} has no code generator`);
    }
    const index = readFileSync(join(dir, "index.js"), "utf8");
    assert.match(index, /import '\.\/neurotrade_combo_forge';/);
  });

  it("declares the trade type of the first normal contract", () => {
    assert.match(buildComboForgeStrategy(BASE).xml, /<field name="TRADETYPE_LIST">overunder<\/field>/);
    const rise = buildComboForgeStrategy({ ...BASE, normal: [{ type: "CALL", digit: -1 }] });
    assert.match(rise.xml, /<field name="TRADETYPE_LIST">callput<\/field>/);
    assert.match(rise.xml, /<field name="TRADETYPECAT_LIST">callput<\/field>/);
    assert.ok(!rise.xml.includes('<value name="PREDICTION">'));
    const parity = buildComboForgeStrategy({ ...BASE, normal: [{ type: "DIGITODD", digit: -1 }] });
    assert.match(parity.xml, /<field name="TRADETYPE_LIST">evenodd<\/field>/);
    const auto = buildComboForgeStrategy({ ...BASE, normal: [{ type: "DIGITDIFF", digit: -1 }] });
    assert.equal(auto.summary.normalCsv, "DIGITDIFF:-1:1.09");
    // Deriv must never be seeded with barrier −1.
    assert.doesNotMatch(auto.xml, /id="cfprd"><field name="NUM">-1<\/field>/);
  });

  it("carries both CSVs, the strictness and the window in the analyser blocks", () => {
    const { xml } = buildComboForgeStrategy(BASE);
    assert.match(xml, /DIGITOVER:1:1.23,DIGITUNDER:8:1.23,CALL:-1:1.92/);
    assert.match(xml, /DIGITEVEN:-1:1.95,DIGITOVER:4:1.95,PUT:-1:1.92/);
    assert.match(xml, /<field name="STRICTNESS">strict<\/field>/);
    assert.match(xml, /<field name="WINDOW">500<\/field>/);
  });

  it("defaults to STRICT with recovery patience 20 and normal patience 0", () => {
    const { summary } = buildComboForgeStrategy(BASE);
    assert.equal(summary.strictness, "strict");
    assert.equal(summary.recoveryPatience, 20);
    assert.equal(summary.normalPatience, 0);
    assert.equal(buildComboForgeStrategy({ ...BASE, strictness: "nonsense" }).summary.strictness, "strict");
  });

  it("omits the patience branch entirely when patience is 0 (never force)", () => {
    const never = buildComboForgeStrategy({ ...BASE, normalPatience: 0, recoveryPatience: 0 }).xml;
    assert.doesNotMatch(never, /Patience limit/);
    const forced = buildComboForgeStrategy({ ...BASE, normalPatience: 7, recoveryPatience: 12 }).xml;
    assert.match(forced, /Patience limit 7/);
    assert.match(forced, /Patience limit 12/);
  });

  it("floors a sub-minimum window loudly, and keeps the start market first (≤ 8 markets)", () => {
    const low = buildComboForgeStrategy({ ...BASE, window: 20 });
    assert.equal(low.summary.window, COMBO_MIN_WINDOW);
    assert.ok(low.warnings.some((w) => /raised to/.test(w)));
    const { summary, warnings } = buildComboForgeStrategy({
      ...BASE,
      watchMarkets: ["R_10", "R_25", "R_75", "R_100", "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"],
    });
    assert.equal(summary.watchMarkets[0], "R_50");
    assert.equal(summary.watchMarkets.length, 8);
    assert.ok(warnings.some((w) => /Only 8 markets/.test(w)));
  });

  it("is honest in its warnings: Always has no edge, Strict under-powered windows are flagged", () => {
    const always = buildComboForgeStrategy({ ...BASE, strictness: "always" });
    assert.ok(always.warnings.some((w) => /WITHOUT demanding evidence/.test(w)));
    const weak = buildComboForgeStrategy({ ...BASE, normal: [{ type: "CALL", digit: -1 }], window: 200 });
    assert.ok(weak.warnings.some((w) => /takes about \d+ ticks, beyond your 200-tick window/.test(w)));
  });

  it("uses the WORST recovery payout and fair rate for the ladder disclosure", () => {
    const { summary } = buildComboForgeStrategy(BASE);
    const worst = buildComboForgeStrategy({ ...BASE, recovery: [{ type: "DIGITOVER", digit: 1 }] }).summary;
    assert.ok(worst.ladder.debtGrowthPerStep > summary.ladder.debtGrowthPerStep);
    assert.ok(summary.gate.recovery.every((r) => r.costPerDebt > 0));
  });

  it("puts the gate diagnostics in the summary with a fair-tape false-fire rate", () => {
    const { summary } = buildComboForgeStrategy(BASE);
    assert.equal(summary.gate.normal.length, 3);
    for (const r of summary.gate.normal) assert.ok(r.fairFalseFire >= 0 && r.fairFalseFire <= 1);
    assert.equal(summary.candidates.normal, 3 * 4);
  });

  it("wires the shared recovery formula verbatim", () => {
    const { xml } = buildComboForgeStrategy(BASE);
    // 1 + 10/100 = 1.1 multiplier; floor 0.35; max stake 500.
    assert.match(xml, /<field name="NUM">1.1<\/field>/);
    assert.match(xml, /<field name="NUM">0.35<\/field>/);
    assert.match(xml, /<field name="NUM">500<\/field>/);
    assert.match(xml, /Size recovery stake/);
  });

  it("is deterministic and well-formed", () => {
    const a = buildComboForgeStrategy(BASE).xml;
    const b = buildComboForgeStrategy(BASE).xml;
    assert.equal(a, b);
    assert.equal((a.match(/<block /g) ?? []).length, (a.match(/<\/block>/g) ?? []).length, "unbalanced <block> tags");
    assert.match(a, /^<xml xmlns="https:\/\/developers.google.com\/blockly\/xml" is_dbot="true"/);
    assert.ok(!/NaN|undefined|Infinity/.test(a), "XML must not contain NaN/undefined/Infinity");
  });
});

describe("committed builder fixtures", () => {
  it("match the current generator output for every fixture", () => {
    for (const name of Object.keys(COMBO_FORGE_FIXTURES)) {
      const committed = readFileSync(join(fixturesDir(), `${name}.xml`), "utf8");
      assert.equal(
        committed,
        renderFixture(name),
        `${name}.xml is stale — regenerate with: npx tsx src/lib/combo-forge-dbot.fixtures.ts --write`,
      );
    }
  });
});
