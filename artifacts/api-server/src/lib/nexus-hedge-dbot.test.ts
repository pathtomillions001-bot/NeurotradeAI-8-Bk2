import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildNexusHedgeStrategy,
  normaliseNexusSet,
  nexusCsv,
  nexusPayout,
  nexusFairRate,
  nexusLabel,
  analyseNexusGate,
  nexusBinomialTail,
  NEXUS_HEDGE_BLOCK_TYPES,
  type NexusHedgeInput,
} from "./nexus-hedge-dbot";
import {
  NEXUS_HEDGE_FIXTURES,
  fixtureFileName,
  fixturesDir,
  fixtureXml,
  renderFixture,
} from "./nexus-hedge-dbot.fixtures";

const BASE: NexusHedgeInput = {
  symbol: "R_50",
  displayName: "Volatility 50 Index",
  normal: [{ type: "DIGITOVER", digit: 1 }],
  recovery: [{ type: "DIGITUNDER", digit: 6 }],
  stake: 1,
  takeProfit: 10,
  stopLoss: 5,
  maxRecoverySteps: 3,
  markupPercent: 10,
  maxStake: 500,
  breakerDepth: 6,
  currency: "USD",
  window: 120,
  watchMarkets: ["R_10"],
};

describe("nexus-hedge input validation", () => {
  it("rejects empty normal", () => {
    assert.throws(() => buildNexusHedgeStrategy({ ...BASE, normal: [] }), /at least one contract/);
  });
  it("rejects empty recovery", () => {
    assert.throws(() => buildNexusHedgeStrategy({ ...BASE, recovery: [] }), /at least one contract/);
  });
  it("rejects out-of-range barrier", () => {
    assert.throws(() => normaliseNexusSet([{ type: "DIGITOVER", digit: 9 }], "normal"), /Over needs/);
  });
  it("rejects unknown type", () => {
    assert.throws(() => normaliseNexusSet([{ type: "UNKNOWN" as any }], "normal"), /unknown contract/);
  });
  it("deduplicates", () => {
    const s = normaliseNexusSet([{ type: "DIGITOVER", digit: 1 }, { type: "DIGITOVER", digit: 1 }], "normal");
    assert.equal(s.length, 1);
  });
  it("handles CALL/PUT without digit", () => {
    const s = normaliseNexusSet([{ type: "CALL" }, { type: "PUT" }], "normal");
    assert.equal(s.length, 2);
    assert.equal(nexusPayout(s[0]!), 1.92);
    assert.equal(nexusFairRate(s[0]!), 0.5);
  });
  it("builds strategy with valid input", () => {
    const strat = buildNexusHedgeStrategy(BASE);
    assert.ok(strat.xml.includes('is_dbot="true"'));
    assert.ok(strat.xml.includes("nt_analyse_hedge"));
    assert.ok(strat.xml.includes("nt_hedge_decision"));
    assert.ok(strat.xml.includes("nt_purchase_hedge"));
  });
  it("only uses allowed block types", () => {
    const strat = buildNexusHedgeStrategy(BASE);
    const used = [...strat.xml.matchAll(/type="([^"]+)"/g)].map(m => m[1]);
    const allowed = new Set(NEXUS_HEDGE_BLOCK_TYPES as readonly string[]);
    for (const t of used) {
      if (t.startsWith("nt_") || t.startsWith("trade_definition") || t.includes("math_") || t.includes("logic_") || t.includes("variables_") || t.includes("controls_") || t.includes("text") || t.includes("notify") || t.includes("procedures_") || t === "contract_check_result" || t === "read_details" || t === "total_profit" || t === "balance" || t === "trade_again" || t === "before_purchase" || t === "after_purchase" || t === "trade_definition_market" || t === "trade_definition_tradetype" || t === "trade_definition_contracttype" || t === "trade_definition_candleinterval" || t === "trade_definition_restartbuysell" || t === "trade_definition_restartonerror" || t === "trade_definition_tradeoptions") continue;
      assert.ok(allowed.has(t), `block type ${t} not allowed`);
    }
  });
  it("force entry (patience) is a normal-mode privilege — it can never fire a recovery", () => {
    const strat = buildNexusHedgeStrategy({ ...BASE, forceEntryAfter: 5 });
    const forceIdx = strat.xml.indexOf(`Patience limit ${5}`);
    assert.ok(forceIdx > 0, "a strategy forged with forceEntryAfter must carry the patience branch");
    // The patience branch must sit behind an AND gate whose first leg is
    // `In Recovery == FALSE`: debt-sized recovery stakes always earn their
    // entry through the rescan + fresh-tick confirmation gate instead.
    const before = strat.xml.slice(0, forceIdx);
    const andIdx = before.lastIndexOf("logic_operation");
    const inRecoveryIdx = before.lastIndexOf("In Recovery");
    assert.ok(andIdx > 0, "patience branch is gated by logic_operation");
    assert.ok(inRecoveryIdx > andIdx, "the AND gate's first leg is the In Recovery == FALSE check");
    // Without forceEntryAfter nothing emits logic_operation (guard the guard).
    assert.ok(!buildNexusHedgeStrategy(BASE).xml.includes("logic_operation"));
  });
  it("fixtures are stable", () => {
    for (const f of NEXUS_HEDGE_FIXTURES) {
      const a = renderFixture(f.input);
      const b = renderFixture(f.input);
      assert.equal(a.xml, b.xml);
    }
  });
  it("binomial tail correct", () => {
    assert.equal(nexusBinomialTail(10, 0, 0.5), 1);
    assert.ok(nexusBinomialTail(10, 8, 0.5) < 0.06);
  });
});

describe("committed builder fixtures", () => {
  it("match the current generator output for every fixture", () => {
    for (const fixture of NEXUS_HEDGE_FIXTURES) {
      const committed = readFileSync(join(fixturesDir(), fixtureFileName(fixture.name)), "utf8");
      assert.equal(
        committed,
        fixtureXml(fixture.name),
        `${fixtureFileName(fixture.name)} is stale — regenerate with: npx tsx src/lib/nexus-hedge-dbot.fixtures.ts --write`,
      );
    }
  });

  it("buy through nt_purchase_hedge, which the builder's Run-button gate accepts", () => {
    // The generated strategies carry no stock `purchase` block, so Deriv's
    // mandatory-block gate only lets them run while `nt_purchase_hedge` stays
    // listed in the builder's MANDATORY_BLOCK_ALIASES.purchase. When it was
    // missing, Run failed with "The Purchase block is mandatory and cannot be
    // deleted/disabled." — the builder's nexus-hedge-strategy.spec.js proves the
    // gate itself; this keeps the alias list honest from the API side too.
    const aliases = readFileSync(
      join(fixturesDir(), "..", "..", "..", "external", "bot-skeleton", "utils", "mandatory-block-aliases.js"),
      "utf8",
    );
    const purchase = /purchase:\s*\[([^\]]*)\]/.exec(aliases)?.[1] ?? "";
    for (const fixture of NEXUS_HEDGE_FIXTURES) {
      const xml = fixtureXml(fixture.name);
      assert.ok(xml.includes('type="nt_purchase_hedge"'), `${fixture.name} must buy through nt_purchase_hedge`);
      assert.ok(!xml.includes('type="purchase"'), `${fixture.name} must not carry a stock purchase block`);
      assert.ok(
        purchase.includes("'nt_purchase_hedge'"),
        "mandatory-block-aliases.js no longer accepts nt_purchase_hedge — the Run button will refuse every Nexus strategy",
      );
    }
  });
});
