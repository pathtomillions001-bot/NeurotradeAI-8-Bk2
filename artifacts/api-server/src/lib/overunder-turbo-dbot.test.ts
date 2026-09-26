/**
 * Over/Under Turbo → Deriv DBot strategy generator.
 *
 * Pins the contract the "Create DBot" button relies on: the generated workspace
 * is stock Deriv-Bot Blockly XML that (a) trades exactly the scanned market and
 * barriers, (b) carries the session's stake / TP / SL, (c) implements the shared
 * bot recovery maths, and (d) uses only block types the vendored builder ships,
 * so it loads through the builder's unmodified `load()` path.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TURBO_DBOT_BLOCK_TYPES,
  buildTurboDbotStrategy,
  marketPathForSymbol,
  type TurboDbotInput,
} from "./overunder-turbo-dbot.ts";

function baseInput(overrides: Partial<TurboDbotInput> = {}): TurboDbotInput {
  return {
    symbol: "R_100",
    displayName: "Volatility 100 Index",
    normal: { side: "DIGITOVER", barrier: 2 },
    recovery: { side: "DIGITOVER", barrier: 4 },
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    normalPayout: 1.4,
    recoveryPayout: 1.95,
    breakerDepth: 6,
    currency: "USD",
    ...overrides,
  };
}

function blockTypes(xml: string): string[] {
  return [...xml.matchAll(/<block type="([^"]+)"/g)].map((m) => m[1]!);
}

function attr(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]!);
}

describe("buildTurboDbotStrategy", () => {
  it("emits a Deriv-Bot workspace whose every block is a stock builder block", () => {
    const { xml } = buildTurboDbotStrategy(baseInput());
    assert.ok(xml.startsWith("<xml "), "root must be <xml>");
    assert.match(xml, /is_dbot="true"/);
    const allowed = new Set<string>(TURBO_DBOT_BLOCK_TYPES);
    const used = new Set(blockTypes(xml));
    for (const type of used) {
      assert.ok(allowed.has(type), `unexpected block type ${type}`);
    }
    // The four Deriv root blocks are all present exactly once.
    for (const root of ["trade_definition", "before_purchase", "after_purchase"]) {
      assert.equal(blockTypes(xml).filter((t) => t === root).length, 1, root);
    }
  });

  it("is well-formed: balanced tags and unique block ids", () => {
    const { xml } = buildTurboDbotStrategy(baseInput());
    const opens = (xml.match(/<block\b/g) ?? []).length;
    const closes = (xml.match(/<\/block>/g) ?? []).length;
    assert.equal(opens, closes, "every <block> must close");
    for (const tag of ["value", "statement", "next", "field", "mutation", "shadow", "variables"]) {
      const o = (xml.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
      const c = (xml.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      assert.equal(o, c, `<${tag}> must balance`);
    }
    const ids = attr(xml, "id").filter((id) => !id.startsWith("ntv"));
    assert.equal(new Set(ids).size, ids.length, "block ids must be unique");
  });

  it("locks the trade definition to the scanned market as 1-tick Over/Under (both sides)", () => {
    const { xml, summary } = buildTurboDbotStrategy(baseInput({ symbol: "1HZ100V", displayName: "Volatility 100 (1s) Index" }));
    assert.match(xml, /<field name="MARKET_LIST">synthetic_index<\/field>/);
    assert.match(xml, /<field name="SUBMARKET_LIST">random_index<\/field>/);
    assert.match(xml, /<field name="SYMBOL_LIST">1HZ100V<\/field>/);
    assert.match(xml, /<field name="TRADETYPECAT_LIST">digits<\/field>/);
    assert.match(xml, /<field name="TRADETYPE_LIST">overunder<\/field>/);
    assert.match(xml, /<field name="TYPE_LIST">both<\/field>/);
    assert.match(xml, /<field name="DURATIONTYPE_LIST">t<\/field>/);
    assert.match(xml, /has_prediction="true"/);
    assert.equal(summary.market, "synthetic_index");
    assert.equal(summary.submarket, "random_index");
  });

  it("wires stake and prediction to variables so the recovery leg can retarget them", () => {
    const { xml } = buildTurboDbotStrategy(baseInput());
    const amount = xml.match(/<value name="AMOUNT">.*?<\/value>/s)![0];
    assert.match(amount, /variables_get/);
    assert.match(amount, />Stake<\/field>/);
    const prediction = xml.match(/<value name="PREDICTION">.*?<\/value>/s)![0];
    assert.match(prediction, /variables_get/);
    assert.match(prediction, />Barrier<\/field>/);
  });

  it("purchases whichever side the current leg says, from the scanned barriers", () => {
    const { xml } = buildTurboDbotStrategy(
      baseInput({ normal: { side: "DIGITUNDER", barrier: 7 }, recovery: { side: "DIGITOVER", barrier: 5 } }),
    );
    assert.match(xml, /<field name="PURCHASE_LIST">DIGITOVER<\/field>/);
    assert.match(xml, /<field name="PURCHASE_LIST">DIGITUNDER<\/field>/);
    // Initial leg = normal (Under 7); recovery leg = Over 5.
    assert.match(xml, /<field name="TEXT">DIGITUNDER<\/field>/);
    assert.match(xml, /<field name="TEXT">DIGITOVER<\/field>/);
    assert.match(xml, />Barrier<\/field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">7<\/field>/);
    assert.match(xml, />Barrier<\/field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">5<\/field>/);
    // Arming counts UNDER hits with a strict less-than on the normal barrier.
    assert.match(xml, /<field name="OP">LT<\/field><value name="A"><block type="variables_get"[^>]*><field name="VAR"[^>]*>Digit<\/field><\/block><\/value><value name="B"><block type="math_number"[^>]*><field name="NUM">7<\/field>/);
  });

  it("carries the session boundaries and the shared recovery formula", () => {
    const { xml, summary } = buildTurboDbotStrategy(
      baseInput({ stake: 2.5, takeProfit: 25, stopLoss: 12, markupPercent: 15, maxStake: 300, breakerDepth: 7 }),
    );
    // Base stake + TP / SL against Deriv's own total-profit counter.
    assert.match(xml, />Base Stake<\/field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">2.5<\/field>/);
    assert.match(xml, /total_profit.*?<field name="NUM">25<\/field>/s);
    assert.match(xml, /total_profit.*?<field name="NUM">-12<\/field>/s);
    // debt × (1 + markup) / (payout − 1) — markup 15 % → 1.15 factor.
    assert.match(xml, /<field name="NUM">1.15<\/field>/);
    assert.match(xml, />Recovery Payout<\/field><\/block><\/value><value name="B"><block type="math_number" id="[^"]+"><field name="NUM">1<\/field>/);
    // Clamp to [0.35, maxStake], round UP to cents, never above balance.
    assert.match(xml, /math_constrain.*?<field name="NUM">0.35<\/field>.*?<field name="NUM">300<\/field>/s);
    assert.match(xml, /<field name="OP">ROUNDUP<\/field>/);
    assert.match(xml, /<block type="balance"/);
    // Circuit breaker depth and recovery exit on cleared debt.
    assert.match(xml, />Loss Run<\/field><\/block><\/value><value name="B"><block type="math_number" id="[^"]+"><field name="NUM">7<\/field>/);
    assert.match(xml, /<field name="OP">LTE<\/field>.*?<field name="NUM">0.005<\/field>/s);
    assert.match(xml, /<block type="trade_again"/);
    assert.equal(summary.breakerDepth, 7);
    assert.equal(summary.markupPercent, 15);
  });

  it("arms once on the normal leg's break-even and seeds both payout legs", () => {
    const { xml, summary } = buildTurboDbotStrategy(baseInput({ normalPayout: 1.4, recoveryPayout: 1.95 }));
    assert.match(xml, /<block type="lastDigitList"/);
    assert.match(xml, /<field name="WHERE1">FROM_END<\/field><field name="WHERE2">LAST<\/field>/);
    assert.match(xml, /<field name="NUM">40<\/field>/);
    assert.match(xml, />Normal Payout<\/field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">1.4<\/field>/);
    assert.match(xml, />Recovery Payout<\/field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">1.95<\/field>/);
    assert.equal(summary.armWindow, 40);
    assert.equal(summary.armTimeoutTicks, 30);
  });

  it("defines the recovery-stake procedure before its callers", () => {
    const { xml } = buildTurboDbotStrategy(baseInput());
    const def = xml.indexOf('<block type="procedures_defnoreturn"');
    const call = xml.indexOf('<block type="procedures_callnoreturn"');
    assert.ok(def >= 0 && call >= 0);
    assert.ok(def < call, "definition must precede the first call");
    assert.match(xml, /<mutation name="Size recovery stake"><\/mutation>/);
  });

  it("refuses contracts outside the Turbo spec", () => {
    assert.throws(() => buildTurboDbotStrategy(baseInput({ normal: { side: "DIGITOVER", barrier: 4 } })), /normal/);
    assert.throws(() => buildTurboDbotStrategy(baseInput({ recovery: { side: "DIGITOVER", barrier: 2 } })), /recovery/);
    assert.throws(() => buildTurboDbotStrategy(baseInput({ stake: 0.1 })), /stake/);
    assert.throws(() => buildTurboDbotStrategy(baseInput({ symbol: "R_100; drop" })), /symbol/);
  });

  it("names the strategy after the lock and escapes text safely", () => {
    const { name, xml } = buildTurboDbotStrategy(baseInput({ displayName: "Vol <100> & \"Co\"" }));
    assert.equal(name, "NeuroTrade Turbo R_100 Over 2 to Over 4");
    assert.doesNotMatch(xml, /Vol <100>/);
    assert.match(xml, /Vol &lt;100&gt; &amp; &quot;Co&quot;/);
  });
});

describe("marketPathForSymbol", () => {
  it("maps every Turbo synthetic to its Deriv market path", () => {
    assert.deepEqual(marketPathForSymbol("R_10"), { market: "synthetic_index", submarket: "random_index" });
    assert.deepEqual(marketPathForSymbol("1HZ75V"), { market: "synthetic_index", submarket: "random_index" });
    assert.deepEqual(marketPathForSymbol("RDBULL"), { market: "synthetic_index", submarket: "random_daily" });
    assert.deepEqual(marketPathForSymbol("JD25"), { market: "synthetic_index", submarket: "jump_index" });
  });
});

describe("committed builder fixtures", () => {
  it("match the current generator output (regenerate with `tsx src/lib/overunder-turbo-dbot.fixtures.ts --write`)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { TURBO_DBOT_FIXTURES, fixturesDir, renderFixture } = await import("./overunder-turbo-dbot.fixtures.ts");
    for (const name of Object.keys(TURBO_DBOT_FIXTURES)) {
      const file = path.join(fixturesDir(), `${name}.xml`);
      assert.ok(fs.existsSync(file), `${file} is missing`);
      assert.equal(fs.readFileSync(file, "utf8"), renderFixture(name), `${name}.xml is stale`);
    }
  });
});
