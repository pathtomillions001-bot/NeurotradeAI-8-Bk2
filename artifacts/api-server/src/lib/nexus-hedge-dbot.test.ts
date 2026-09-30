import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
import { NEXUS_HEDGE_FIXTURES, renderFixture } from "./nexus-hedge-dbot.fixtures";

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
