import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTurboDbotXml,
  validateTurboDbotSpec,
  TurboDbotSpecError,
  NT_VARS,
  type TurboDbotSpec,
} from "./overunder-turbo-xml";

const sampleSpec: TurboDbotSpec = {
  symbol: "R_100",
  displayName: "Volatility 100 Index",
  currency: "USD",
  normal: { side: "DIGITOVER", barrier: 2 },
  recovery: { side: "DIGITOVER", barrier: 4 },
  baseStake: 1.0,
  takeProfit: 5.0,
  stopLoss: 10.0,
  recoveryMarkupPct: 10,
  maxConsecutiveLosses: 8,
  recoveryPayout: 1.95,
  payoutSource: "live",
};

describe("Over/Under Turbo DBot XML Compiler", () => {
  it("validates valid spec cleanly", () => {
    assert.doesNotThrow(() => validateTurboDbotSpec(sampleSpec));
  });

  it("rejects invalid normal barrier outside vocabulary", () => {
    const bad = { ...sampleSpec, normal: { side: "DIGITOVER" as const, barrier: 5 } };
    assert.throws(() => validateTurboDbotSpec(bad), TurboDbotSpecError);
  });

  it("rejects stake below 0.35", () => {
    const bad = { ...sampleSpec, baseStake: 0.1 };
    assert.throws(() => validateTurboDbotSpec(bad), TurboDbotSpecError);
  });

  it("compiles well-formed XML containing all required blocks", () => {
    const { xml, filename } = buildTurboDbotXml(sampleSpec);
    assert.ok(xml.startsWith("<?xml"));
    assert.ok(xml.includes("<xml"));
    assert.ok(xml.includes("</xml>"));
    assert.ok(xml.includes(sampleSpec.symbol));
    assert.ok(xml.includes("tradeOptions"));
    assert.ok(xml.includes("before_purchase"));
    assert.ok(xml.includes("after_purchase"));
    assert.ok(xml.includes("procedures_defreturn"));
    assert.ok(xml.includes("NT Stake"));
    assert.ok(xml.includes("NT Prediction"));
    assert.ok(xml.includes(NT_VARS.debt));
    assert.ok(xml.includes(NT_VARS.streak));
    assert.ok(filename.includes("r_100"));
    assert.ok(filename.includes("over2"));
    assert.ok(filename.includes("rec-over4"));
  });

  it("generates deterministic XML across multiple runs", () => {
    const run1 = buildTurboDbotXml(sampleSpec);
    const run2 = buildTurboDbotXml(sampleSpec);
    assert.equal(run1.xml, run2.xml);
    assert.equal(run1.filename, run2.filename);
  });
});
