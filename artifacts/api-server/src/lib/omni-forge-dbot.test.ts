/**
 * Omni Forge → DBot generator tests.
 *
 * Three layers, mirroring the Digit Forge suite:
 *   1. The generator is a pure function that REFUSES illegal input loudly.
 *   2. The emitted XML only uses block types the vendored builder registers
 *      (the builder's `load()` rejects a whole workspace on ONE unknown type).
 *   3. The committed builder fixtures equal the current generator output, so
 *      the API and the builder suite can never drift apart silently — the
 *      builder's jest side then loads those same files into the REAL Blockly
 *      and executes them against a scripted market.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildOmniForgeStrategy,
  normaliseForgeSet,
  forgeCsv,
  forgePayout,
  forgeFairRate,
  forgeLabel,
  analyseForgeGate,
  binomialTail,
  rareEntrySentence,
  MIN_GATE_WINDOW,
  OMNI_FORGE_BLOCK_TYPES,
  type OmniForgeInput,
} from "./omni-forge-dbot";
import {
  OMNI_FORGE_FIXTURES,
  fixturesDir,
  renderFixture,
} from "./omni-forge-dbot.fixtures";

const BASE: OmniForgeInput = {
  symbol: "R_50",
  displayName: "Volatility 50 Index",
  normal: [
    { type: "DIGITOVER", digit: 1 },
    { type: "DIGITUNDER", digit: 8 },
  ],
  recovery: [
    { type: "DIGITEVEN", digit: -1 },
    { type: "DIGITOVER", digit: 4 },
  ],
  stake: 1,
  takeProfit: 10,
  stopLoss: 5,
  maxRecoverySteps: 3,
  markupPercent: 10,
  maxStake: 500,
  breakerDepth: 6,
  currency: "USD",
  window: 120,
  watchMarkets: ["R_10", "R_25", "R_75"],
};

describe("omni-forge input validation", () => {
  it("rejects an empty normal set", () => {
    assert.throws(
      () => buildOmniForgeStrategy({ ...BASE, normal: [] }),
      /at least one contract/,
    );
  });
  it("rejects an empty recovery set", () => {
    assert.throws(
      () => buildOmniForgeStrategy({ ...BASE, recovery: [] }),
      /at least one contract/,
    );
  });
  it("rejects out-of-range Over/Under barriers", () => {
    assert.throws(
      () => normaliseForgeSet([{ type: "DIGITOVER", digit: 9 }], "normal"),
      /Over needs a barrier 0–8/,
    );
    assert.throws(
      () => normaliseForgeSet([{ type: "DIGITUNDER", digit: 0 }], "normal"),
      /Under needs a barrier 1–9/,
    );
  });
  it("rejects unknown contract types", () => {
    assert.throws(
      () => normaliseForgeSet([{ type: "ACCU" as never, digit: -1 }], "normal"),
      /unknown contract type/,
    );
  });
  it("rejects more than six contracts per set", () => {
    const overMany = Array.from({ length: 7 }, (_, i) => ({
      type: "DIGITOVER" as const,
      digit: Math.min(8, i),
    }));
    assert.throws(() => normaliseForgeSet(overMany, "normal"), /at most 6/);
  });
  it("deduplicates repeated specs and strips digits from parity contracts", () => {
    const set = normaliseForgeSet(
      [
        { type: "DIGITEVEN", digit: 4 },
        { type: "DIGITEVEN", digit: 7 },
        { type: "DIGITOVER", digit: 2 },
        { type: "DIGITOVER", digit: 2 },
      ],
      "normal",
    );
    assert.deepEqual(set, [
      { type: "DIGITEVEN", digit: -1 },
      { type: "DIGITOVER", digit: 2 },
    ]);
  });
  it("accepts auto digits for Matches/Differs only", () => {
    const set = normaliseForgeSet(
      [
        { type: "DIGITMATCH", digit: -1 },
        { type: "DIGITDIFF", digit: 3 },
      ],
      "recovery",
    );
    assert.equal(set.length, 2);
    assert.throws(
      () => normaliseForgeSet([{ type: "DIGITMATCH", digit: 12 }], "recovery"),
      /0–9 or auto/,
    );
  });
  it("rejects a sub-minimum stake and a bad symbol", () => {
    assert.throws(
      () => buildOmniForgeStrategy({ ...BASE, stake: 0.1 }),
      /stake/,
    );
    assert.throws(
      () => buildOmniForgeStrategy({ ...BASE, symbol: "R_50; DROP" }),
      /symbol/,
    );
  });
});

describe("omni-forge forge-time maths", () => {
  it("prices every contract type from the canonical tables", () => {
    assert.equal(forgePayout({ type: "DIGITOVER", digit: 1 }), 1.23);
    assert.equal(forgePayout({ type: "DIGITUNDER", digit: 8 }), 1.23);
    assert.equal(forgePayout({ type: "DIGITEVEN", digit: -1 }), 1.95);
    assert.equal(forgePayout({ type: "DIGITODD", digit: -1 }), 1.95);
    assert.equal(forgePayout({ type: "DIGITMATCH", digit: 5 }), 8.93);
    assert.equal(forgePayout({ type: "DIGITDIFF", digit: 5 }), 1.09);
    assert.equal(forgePayout({ type: "CALL", digit: -1 }), 1.92);
    assert.equal(forgePayout({ type: "PUT", digit: -1 }), 1.92);
  });
  it("knows every contract's fair win rate", () => {
    assert.equal(forgeFairRate({ type: "DIGITOVER", digit: 1 }), 0.8);
    assert.equal(forgeFairRate({ type: "DIGITUNDER", digit: 8 }), 0.8);
    assert.equal(forgeFairRate({ type: "DIGITEVEN", digit: -1 }), 0.5);
    assert.equal(forgeFairRate({ type: "DIGITMATCH", digit: 3 }), 0.1);
    assert.equal(forgeFairRate({ type: "DIGITDIFF", digit: 3 }), 0.9);
    assert.equal(forgeFairRate({ type: "CALL", digit: -1 }), 0.5);
    assert.equal(forgeFairRate({ type: "PUT", digit: -1 }), 0.5);
  });
  it("labels specs the way the console shows them", () => {
    assert.equal(forgeLabel({ type: "DIGITOVER", digit: 1 }), "Over 1");
    assert.equal(forgeLabel({ type: "DIGITMATCH", digit: -1 }), "Matches auto");
    assert.equal(forgeLabel({ type: "DIGITDIFF", digit: 7 }), "Differs 7");
    assert.equal(forgeLabel({ type: "CALL", digit: -1 }), "Rise");
    assert.equal(forgeLabel({ type: "PUT", digit: -1 }), "Fall");
  });
  it("emits the runtime CSV wire format the vendored block parses", () => {
    const csv = forgeCsv([
      { type: "DIGITOVER", digit: 1 },
      { type: "DIGITEVEN", digit: -1 },
      { type: "DIGITMATCH", digit: -1 },
    ]);
    assert.equal(csv, "DIGITOVER:1:1.23,DIGITEVEN:-1:1.95,DIGITMATCH:-1:8.93");
  });
});

describe("omni-forge gate diagnostics — the Over 0 / Under 9 dead zone, measured", () => {
  it("Over 0 CAN qualify post-fix, but only on hot tapes — and is flagged tight", () => {
    const [reading] = analyseForgeGate(
      [{ type: "DIGITOVER", digit: 0 }],
      120,
      "NORMAL",
    );
    assert.ok(reading);
    // The runtime's EV + Wilson bounds first pass at 113/120 wins.
    assert.equal(reading.minQualifyingWinRate, 113 / 120);
    // The whole point of the runtime clustering guard: qualification is now
    // possible at all (it was 0.0 — mathematically unreachable — before).
    assert.ok(
      reading.qualificationChance > 0.03,
      `expected > 3%, got ${reading.qualificationChance}`,
    );
    assert.ok(
      reading.qualificationChance < 0.2,
      `expected < 20%, got ${reading.qualificationChance}`,
    );
    assert.equal(reading.tight, true); // 91.7% break-even vs 90% natural
    assert.equal(reading.sparse, false); // rare, but real: ~8% of fair tapes
  });

  it("Under 9 is the symmetric trap; Differs shares the 1.09× price", () => {
    const [under9] = analyseForgeGate(
      [{ type: "DIGITUNDER", digit: 9 }],
      120,
      "NORMAL",
    );
    const [differs] = analyseForgeGate(
      [{ type: "DIGITDIFF", digit: -1 }],
      120,
      "NORMAL",
    );
    assert.equal(under9?.tight, true);
    assert.equal(differs?.tight, true);
    assert.ok(
      under9 &&
        differs &&
        Math.abs(under9.qualificationChance - differs.qualificationChance) <
          1e-12,
    );
  });

  it("ordinary barriers keep comfortable headroom and are NOT flagged", () => {
    for (const spec of [
      { type: "DIGITOVER", digit: 1 },
      { type: "DIGITUNDER", digit: 8 },
      { type: "DIGITEVEN", digit: -1 },
      { type: "DIGITMATCH", digit: -1 },
    ] as const) {
      const [reading] = analyseForgeGate([spec], 120, "NORMAL");
      assert.equal(
        reading?.tight,
        false,
        `${spec.type} ${spec.digit} should have headroom`,
      );
      assert.ok(reading && reading.qualificationChance > 0.05);
    }
  });

  it("recovery's looser gate admits Over 0 far more often — matching observed behaviour", () => {
    const [normalReading] = analyseForgeGate(
      [{ type: "DIGITOVER", digit: 0 }],
      120,
      "NORMAL",
    );
    const [recoveryReading] = analyseForgeGate(
      [{ type: "DIGITOVER", digit: 0 }],
      120,
      "RECOVERY",
    );
    assert.ok(normalReading && recoveryReading);
    assert.ok(
      recoveryReading.qualificationChance >
        normalReading.qualificationChance * 3,
    );
    assert.equal(recoveryReading.tight, true); // flagged for expectation setting either way
  });

  it("marks a leg unreachable below the gate's sample floor", () => {
    const [reading] = analyseForgeGate(
      [{ type: "DIGITOVER", digit: 4 }],
      20,
      "NORMAL",
    );
    assert.equal(reading?.minQualifyingWinRate, null);
    assert.equal(reading?.qualificationChance, 0);
    assert.equal(reading?.sparse, true);
  });

  it("binomialTail is exact at the edges and sane in the middle", () => {
    assert.equal(binomialTail(120, 0, 0.9), 1);
    assert.equal(binomialTail(120, 121, 0.9), 0);
    assert.ok(
      Math.abs(binomialTail(120, 120, 0.9) - Math.pow(0.9, 120)) < 1e-18,
    );
    assert.ok(Math.abs(binomialTail(120, 113, 0.9) - 0.0784) < 0.005);
  });

  it("forge warnings + a journal notice ride every rare-entry normal leg", () => {
    const strategy = buildOmniForgeStrategy({
      ...BASE,
      normal: [
        { type: "DIGITOVER", digit: 0 },
        { type: "DIGITUNDER", digit: 9 },
      ],
    });
    assert.equal(strategy.warnings.length, 2);
    assert.match(strategy.warnings[0]!, /Over 0 pays 1\.09×/);
    assert.match(strategy.warnings[0]!, /recovery set|Force entry after/);
    assert.match(strategy.xml, /Rare-entry notice: Over 0, Under 9/);
    assert.match(strategy.xml, /91\.7% tapes/);
    // The diagnostics are also on the summary for the console's Last forge panel.
    assert.equal(strategy.summary.gate.normal.length, 2);
    assert.equal(strategy.summary.gate.normal[0]?.tight, true);
    assert.equal(strategy.summary.gate.recovery.length, 2);

    // The default mixed set keeps comfortable headroom: no warnings, no notice.
    const baseline = buildOmniForgeStrategy(BASE);
    assert.deepEqual(baseline.warnings, []);
    assert.doesNotMatch(baseline.xml, /Rare-entry notice/);
  });

  it("the rare-entry sentence carries the contract's own numbers, not model jargon", () => {
    const [reading] = analyseForgeGate(
      [{ type: "DIGITOVER", digit: 0 }],
      120,
      "NORMAL",
    );
    assert.ok(reading);
    const sentence = rareEntrySentence(reading);
    assert.match(sentence, /91\.7%/);
    assert.doesNotMatch(
      sentence,
      /lower bound|LCB|Wilson|Markov|clustering|EV /i,
    );
  });

  it("floors a sub-minimum tick window at the runtime's sample floor, loudly", () => {
    const strategy = buildOmniForgeStrategy({ ...BASE, window: 20 });
    assert.equal(strategy.summary.window, MIN_GATE_WINDOW);
    assert.ok(strategy.warnings.some((w) => /Tick window 20/.test(w)));
    assert.equal(strategy.summary.gate.window, MIN_GATE_WINDOW);
    // A sane window is left untouched and silent.
    assert.ok(
      !buildOmniForgeStrategy({ ...BASE, window: 120 }).warnings.some((w) =>
        /Tick window/.test(w),
      ),
    );
  });
});

describe("omni-forge strategy shape", () => {
  it("emits only block types the vendored builder registers", () => {
    const { xml } = buildOmniForgeStrategy(BASE);
    const types = [...xml.matchAll(/<(?:block|shadow) type="([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    const allowed = new Set<string>(OMNI_FORGE_BLOCK_TYPES);
    const unknown = [...new Set(types.filter((t) => !allowed.has(t)))];
    assert.deepEqual(
      unknown,
      [],
      `unexpected block types: ${unknown.join(", ")}`,
    );
  });

  it("declares the trade type of the first normal contract and carries both CSVs", () => {
    const mixed = buildOmniForgeStrategy(BASE);
    assert.match(mixed.xml, /<field name="TRADETYPE_LIST">overunder<\/field>/);
    assert.match(mixed.xml, /DIGITOVER:1:1.23,DIGITUNDER:8:1.23/);
    assert.match(mixed.xml, /DIGITEVEN:-1:1.95,DIGITOVER:4:1.95/);

    const parity = buildOmniForgeStrategy({
      ...BASE,
      normal: [{ type: "DIGITODD", digit: -1 }],
    });
    assert.match(parity.xml, /<field name="TRADETYPE_LIST">evenodd<\/field>/);
    // Even/Odd trade options must not carry a prediction input.
    assert.ok(!parity.xml.includes('<value name="PREDICTION">'));

    const md = buildOmniForgeStrategy({
      ...BASE,
      normal: [{ type: "DIGITMATCH", digit: 5 }],
    });
    assert.match(
      md.xml,
      /<field name="TRADETYPE_LIST">matchesdiffers<\/field>/,
    );
    assert.ok(md.xml.includes('<value name="PREDICTION">'));

    const direction = buildOmniForgeStrategy({
      ...BASE,
      normal: [{ type: "CALL", digit: -1 }],
    });
    assert.match(
      direction.xml,
      /<field name="TRADETYPECAT_LIST">callput<\/field>/,
    );
    assert.match(
      direction.xml,
      /<field name="TRADETYPE_LIST">callput<\/field>/,
    );
    assert.ok(!direction.xml.includes('<value name="PREDICTION">'));
    assert.equal(direction.summary.normalCsv, "CALL:-1:1.92");

    const autoDiff = buildOmniForgeStrategy({
      ...BASE,
      normal: [{ type: "DIGITDIFF", digit: -1 }],
    });
    // -1 remains in the analyser CSV as the intentional "auto" sentinel, but
    // live Trade Definition is seeded with legal digit 0 until analysis picks
    // the coldest concrete digit. Deriv must never receive barrier -1.
    assert.equal(autoDiff.summary.normalCsv, "DIGITDIFF:-1:1.09");
    assert.match(autoDiff.xml, /id="ofprd"><field name="NUM">0<\/field>/);
    assert.doesNotMatch(
      autoDiff.xml,
      /id="ofprd"><field name="NUM">-1<\/field>/,
    );
  });

  it("keeps the starting market first in the watchlist and caps it at eight", () => {
    const { summary } = buildOmniForgeStrategy({
      ...BASE,
      watchMarkets: [
        "R_10",
        "R_25",
        "R_75",
        "R_100",
        "1HZ10V",
        "1HZ25V",
        "1HZ50V",
        "1HZ75V",
        "1HZ100V",
      ],
    });
    assert.equal(summary.watchMarkets[0], "R_50");
    assert.equal(summary.watchMarkets.length, 8);
  });

  it("uses the WORST recovery payout and fair rate for the ladder disclosure", () => {
    const { summary } = buildOmniForgeStrategy(BASE);
    // Recovery set: Even (1.95, 50%) and Over 4 (1.95, 50%) → both 1.95/0.5.
    assert.equal(summary.ladder.debtGrowthPerStep, 2.158);
    const withMatch = buildOmniForgeStrategy({
      ...BASE,
      recovery: [
        { type: "DIGITEVEN", digit: -1 },
        { type: "DIGITMATCH", digit: -1 },
      ],
    });
    // Matches pays 8.93 but wins 10% — failure odds must reflect the 10%.
    assert.ok(
      withMatch.summary.ladder.failureProbability >
        summary.ladder.failureProbability,
    );
  });

  it("can brand the generated DBot as Universal Forge", () => {
    const strategy = buildOmniForgeStrategy({
      ...BASE,
      strategyName: "Universal Forge",
      normal: [
        { type: "CALL", digit: -1 },
        { type: "DIGITOVER", digit: 2 },
      ],
      recovery: [
        { type: "PUT", digit: -1 },
        { type: "DIGITEVEN", digit: -1 },
      ],
    });
    assert.match(strategy.name, /NeuroTrade Universal Forge/);
    assert.match(strategy.xml, /NeuroTrade Universal Forge/);
    assert.equal(strategy.summary.normalCsv, "CALL:-1:1.92,DIGITOVER:2:1.4");
    assert.equal(strategy.summary.recoveryCsv, "PUT:-1:1.92,DIGITEVEN:-1:1.95");
  });

  it("is deterministic and well-formed", () => {
    const a = buildOmniForgeStrategy(BASE).xml;
    const b = buildOmniForgeStrategy(BASE).xml;
    assert.equal(a, b);
    const opens = (a.match(/<block /g) ?? []).length;
    const closes = (a.match(/<\/block>/g) ?? []).length;
    assert.equal(opens, closes, "unbalanced <block> tags");
    assert.match(
      a,
      /^<xml xmlns="https:\/\/developers.google.com\/blockly\/xml" is_dbot="true"/,
    );
  });
});

describe("committed builder fixtures", () => {
  it("match the current generator output for every fixture", () => {
    for (const name of Object.keys(OMNI_FORGE_FIXTURES)) {
      const committed = readFileSync(
        join(fixturesDir(), `${name}.xml`),
        "utf8",
      );
      assert.equal(
        committed,
        renderFixture(name),
        `${name}.xml is stale — regenerate with: npx tsx src/lib/omni-forge-dbot.fixtures.ts --write`,
      );
    }
  });
});
