import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analysePairedEdge, rankPairedEdges } from "./paired-edge-analysis.ts";
import { buildPairedEdgeDbot } from "./paired-edge-dbot.ts";

const digits = (highRate: number, n = 1200) => {
  // Deterministic xorshift stream: reproducible without periodic serial runs.
  let state = 0x9e3779b9;
  return Array.from({ length: n }, (_, i) => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const u = (state >>> 0) / 0x100000000;
    return u < highRate ? 5 + (i % 5) : i % 5;
  });
};

describe("Paired Edge analysis", () => {
  it("finds a conservative Over 4 edge and rejects a fair tape", () => {
    const hot = analysePairedEdge("R_100", "V100", digits(0.57));
    assert.equal(hot.favoredSide, "over4");
    assert.ok(hot.edgeLowerBound > 0);
    assert.ok(hot.zScore > 1.65);
    assert.equal(hot.suitable, true);

    const fair = analysePairedEdge("R_50", "V50", digits(0.5));
    assert.ok(fair.edgeLowerBound < 0.01);
    assert.equal(fair.suitable, false);
    assert.equal(rankPairedEdges([fair, hot])[0]?.symbol, "R_100");
  });

  it("finds the Under 5 side symmetrically", () => {
    const candidate = analysePairedEdge("1HZ50V", "1s V50", digits(0.43));
    assert.equal(candidate.favoredSide, "under5");
    assert.ok(candidate.underProbability > 0.5);
  });
});

describe("Paired Edge DBot XML", () => {
  const build = () => buildPairedEdgeDbot({
    symbol: "R_100", displayName: "Volatility 100 Index", stake: 1,
    takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, markupPercent: 10,
    maxStake: 100, currency: "USD", normalOverPayout: 1.95,
    normalUnderPayout: 1.95, recoveryOverPayout: 2.43, recoveryUnderPayout: 2.43,
  });

  it("emits balanced XML with one paired purchase per normal/recovery branch", () => {
    const { xml } = build();
    assert.match(xml, /is_dbot="true"/);
    assert.equal((xml.match(/<block type="purchase_pair"/g) ?? []).length, 2);
    assert.match(xml, /<field name="NUM">4<\/field>/);
    assert.match(xml, /<field name="NUM">5<\/field>/);
    assert.match(xml, />Recovery Debt<\/field>/);
    assert.match(xml, />Pair Net Profit<\/field>/);
    assert.match(xml, /<block type="trade_again"/);
    assert.equal((xml.match(/<block\b/g) ?? []).length, (xml.match(/<\/block>/g) ?? []).length);
  });

  it("sizes recovery from pair net return and refuses an unrecoverable quote", () => {
    const { xml, summary } = build();
    assert.equal(summary.recoveryNetFactor, 0.43000000000000016);
    assert.match(xml, /<field name="NUM">0\.43000000000000016<\/field>/);
    assert.throws(() => buildPairedEdgeDbot({ ...summary, recoveryOverPayout: 1.9, recoveryUnderPayout: 1.9 }), /cannot repay debt/);
  });
});
