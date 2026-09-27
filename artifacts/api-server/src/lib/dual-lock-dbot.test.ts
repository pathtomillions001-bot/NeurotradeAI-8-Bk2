/**
 * Dual-Lock Range Sentinel → Deriv DBot strategy generator.
 *
 * Pins the contract the Dual-Lock "Create DBot" button relies on: the generated
 * workspace is vendored Deriv-Bot Blockly XML that (a) trades exactly the
 * scanned market and barriers, (b) carries the session's stake / TP / SL, (c)
 * implements the shared bot recovery maths, and (d) — the one intentional
 * difference from the Turbo DBot — carries NO in-bot analysis: it uses only
 * stock blocks (including the real `purchase` block) and no `nt_*` analysis
 * blocks, so it fires the locked contracts non-stop until TP/SL/breaker.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DUAL_LOCK_DBOT_BLOCK_TYPES,
  buildDualLockDbotStrategy,
  type DualLockDbotInput,
} from "./dual-lock-dbot.ts";

function baseInput(overrides: Partial<DualLockDbotInput> = {}): DualLockDbotInput {
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

describe("buildDualLockDbotStrategy", () => {
  it("emits a DBot workspace whose every block is registered by the vendored builder", () => {
    const { xml } = buildDualLockDbotStrategy(baseInput());
    assert.ok(xml.startsWith("<xml "), "root must be <xml>");
    assert.match(xml, /is_dbot="true"/);
    const allowed = new Set<string>(DUAL_LOCK_DBOT_BLOCK_TYPES);
    const used = new Set(blockTypes(xml));
    for (const type of used) {
      assert.ok(allowed.has(type), `unexpected block type ${type}`);
    }
    // The three Deriv root blocks are all present exactly once.
    for (const root of ["trade_definition", "before_purchase", "after_purchase"]) {
      assert.equal(blockTypes(xml).filter((t) => t === root).length, 1, root);
    }
  });

  it("carries a real `purchase` block and NO nt_* analysis blocks (the run-button gate is satisfied)", () => {
    const { xml } = buildDualLockDbotStrategy(baseInput());
    // A stock purchase block is what the builder's mandatory-block gate checks.
    assert.ok(blockTypes(xml).includes("purchase"), "must contain a stock purchase block");
    // The whole point: Dual-Lock's DBot does no analysis while it runs.
    assert.doesNotMatch(xml, /nt_analyse/);
    assert.doesNotMatch(xml, /nt_turbo_recovery_decision/);
    assert.doesNotMatch(xml, /nt_purchase_contract/);
    assert.doesNotMatch(xml, /lastDigitList/);
    assert.doesNotMatch(xml, /lists_getSublist/);
    assert.doesNotMatch(xml, /controls_forEach/);
  });

  it("is well-formed: balanced tags and unique block ids", () => {
    const { xml } = buildDualLockDbotStrategy(baseInput());
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
    const { xml, summary } = buildDualLockDbotStrategy(
      baseInput({ symbol: "1HZ100V", displayName: "Volatility 100 (1s) Index" }),
    );
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
    const { xml } = buildDualLockDbotStrategy(baseInput());
    const amount = xml.match(/<value name="AMOUNT">.*?<\/value>/s)![0];
    assert.match(amount, /variables_get/);
    assert.match(amount, />Stake<\/field>/);
    const prediction = xml.match(/<value name="PREDICTION">.*?<\/value>/s)![0];
    assert.match(prediction, /variables_get/);
    assert.match(prediction, />Barrier<\/field>/);
  });

  it("purchases whichever side the current leg says, from the scanned barriers, every tick", () => {
    const { xml } = buildDualLockDbotStrategy(
      baseInput({ normal: { side: "DIGITUNDER", barrier: 7 }, recovery: { side: "DIGITOVER", barrier: 5 } }),
    );
    assert.match(xml, /<field name="PURCHASE_LIST">DIGITOVER<\/field>/);
    assert.match(xml, /<field name="PURCHASE_LIST">DIGITUNDER<\/field>/);
    // Initial leg = normal (Under 7); recovery leg = Over 5.
    assert.match(xml, /<field name="TEXT">DIGITUNDER<\/field>/);
    assert.match(xml, /<field name="TEXT">DIGITOVER<\/field>/);
    assert.match(xml, />Barrier<\/field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">7<\/field>/);
    assert.match(xml, />Barrier<\/field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">5<\/field>/);
  });

  it("carries the session boundaries and the shared recovery formula", () => {
    const { xml, summary } = buildDualLockDbotStrategy(
      baseInput({ stake: 2.5, takeProfit: 25, stopLoss: 12, markupPercent: 15, maxStake: 300, breakerDepth: 7 }),
    );
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

  it("seeds both payout legs from the scan-time quotes", () => {
    const { xml, summary } = buildDualLockDbotStrategy(baseInput({ normalPayout: 1.4, recoveryPayout: 1.95 }));
    assert.match(xml, />Normal Payout<\/field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">1.4<\/field>/);
    assert.match(xml, />Recovery Payout<\/field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">1.95<\/field>/);
    assert.equal(summary.normalPayout, 1.4);
    assert.equal(summary.recoveryPayout, 1.95);
  });

  it("defines the recovery-stake procedure before its callers", () => {
    const { xml } = buildDualLockDbotStrategy(baseInput());
    const def = xml.indexOf('<block type="procedures_defnoreturn"');
    const call = xml.indexOf('<block type="procedures_callnoreturn"');
    assert.ok(def >= 0 && call >= 0);
    assert.ok(def < call, "definition must precede the first call");
    assert.match(xml, /<mutation name="Size recovery stake"><\/mutation>/);
  });

  it("refuses contracts outside the Dual-Lock spec", () => {
    assert.throws(() => buildDualLockDbotStrategy(baseInput({ normal: { side: "DIGITOVER", barrier: 4 } })), /normal/);
    assert.throws(() => buildDualLockDbotStrategy(baseInput({ recovery: { side: "DIGITOVER", barrier: 2 } })), /recovery/);
    assert.throws(() => buildDualLockDbotStrategy(baseInput({ stake: 0.1 })), /stake/);
    assert.throws(() => buildDualLockDbotStrategy(baseInput({ symbol: "R_100; drop" })), /symbol/);
  });

  it("names the strategy after the lock and escapes text safely", () => {
    const { name, xml } = buildDualLockDbotStrategy(baseInput({ displayName: 'Vol <100> & "Co"' }));
    assert.equal(name, "NeuroTrade Dual-Lock R_100 Over 2 to Over 4");
    assert.doesNotMatch(xml, /Vol <100>/);
    assert.match(xml, /Vol &lt;100&gt; &amp; &quot;Co&quot;/);
  });
});

describe("committed builder fixtures", () => {
  it("match the current generator output (regenerate with `tsx src/lib/dual-lock-dbot.fixtures.ts --write`)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { DUAL_LOCK_DBOT_FIXTURES, fixturesDir, renderFixture } = await import("./dual-lock-dbot.fixtures.ts");
    for (const name of Object.keys(DUAL_LOCK_DBOT_FIXTURES)) {
      const file = path.join(fixturesDir(), `${name}.xml`);
      assert.ok(fs.existsSync(file), `${name}.xml is missing — run the fixtures writer`);
      assert.equal(fs.readFileSync(file, "utf8"), renderFixture(name), `${name}.xml is stale`);
    }
  });
});
