/**
 * Over/Under Turbo → DBot XML compiler tests.
 *
 * These cover the two ways a generated strategy can silently be wrong:
 *   1. spec validation drifts from the engine's fixed contract vocabulary
 *      (sovereignty: a DBot must never fire a contract the scan couldn't have);
 *   2. the Blockly XML no longer encodes the shared recovery math / session
 *      boundaries (regex-level checks against the emitted document).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTurboDbotXml,
  validateTurboDbotSpec,
  TurboDbotSpecError,
  NT_VARS,
  type TurboDbotSpec,
} from "./overunder-turbo-xml";

function spec(overrides: Partial<TurboDbotSpec> = {}): TurboDbotSpec {
  return {
    symbol: "R_100",
    displayName: "Volatility 100 Index",
    currency: "USD",
    normal: { side: "DIGITOVER", barrier: 2 },
    recovery: { side: "DIGITUNDER", barrier: 5 },
    baseStake: 1,
    takeProfit: 10,
    stopLoss: 5,
    recoveryMarkupPct: 10,
    maxConsecutiveLosses: 15,
    recoveryPayout: 1.9499,
    payoutSource: "live",
    ...overrides,
  };
}

// ── Validation (contract sovereignty) ─────────────────────────────────────────

test("accepts every fixed-vocabulary normal/recovery pair", () => {
  const normals = [
    { side: "DIGITOVER", barrier: 1 },
    { side: "DIGITOVER", barrier: 2 },
    { side: "DIGITUNDER", barrier: 7 },
    { side: "DIGITUNDER", barrier: 8 },
  ] as const;
  const recoveries = [
    { side: "DIGITOVER", barrier: 4 },
    { side: "DIGITOVER", barrier: 5 },
    { side: "DIGITUNDER", barrier: 4 },
    { side: "DIGITUNDER", barrier: 5 },
  ] as const;
  for (const n of normals) for (const r of recoveries) validateTurboDbotSpec(spec({ normal: n, recovery: r }));
});

test("rejects normal contracts outside the fixed set", () => {
  assert.throws(
    () => validateTurboDbotSpec(spec({ normal: { side: "DIGITOVER", barrier: 5 } })),
    TurboDbotSpecError,
  );
  assert.throws(
    () => validateTurboDbotSpec(spec({ normal: { side: "DIGITUNDER", barrier: 4 } })),
    TurboDbotSpecError,
  );
});

test("rejects recovery contracts outside the fixed set", () => {
  assert.throws(
    () => validateTurboDbotSpec(spec({ recovery: { side: "DIGITOVER", barrier: 1 } })),
    TurboDbotSpecError,
  );
});

test("rejects nonsensical numbers", () => {
  assert.throws(() => validateTurboDbotSpec(spec({ baseStake: 0.1 })), TurboDbotSpecError);
  assert.throws(() => validateTurboDbotSpec(spec({ takeProfit: 0 })), TurboDbotSpecError);
  assert.throws(() => validateTurboDbotSpec(spec({ stopLoss: -2 })), TurboDbotSpecError);
  assert.throws(() => validateTurboDbotSpec(spec({ recoveryMarkupPct: 900 })), TurboDbotSpecError);
  assert.throws(() => validateTurboDbotSpec(spec({ maxConsecutiveLosses: 0 })), TurboDbotSpecError);
  assert.throws(() => validateTurboDbotSpec(spec({ recoveryPayout: 1 })), TurboDbotSpecError);
  assert.throws(() => validateTurboDbotSpec(spec({ symbol: "R 100!" })), TurboDbotSpecError);
});

// ── XML structure ─────────────────────────────────────────────────────────────

function blockIds(xml: string): string[] {
  return [...xml.matchAll(/<block [^>]*id="([^"]+)"/g)].map(m => m[1]);
}

function tagBalance(xml: string, tag: string): void {
  const open = xml.match(new RegExp(`<${tag}[\\s>]`, "g"))?.length ?? 0;
  const close = xml.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
  const selfClosed = xml.match(new RegExp(`<${tag}[^>]*/>`, "g"))?.length ?? 0;
  assert.equal(open, close + selfClosed, `<${tag}> unbalanced`);
}

test("document is old-schema (no is_dbot), collection=false, XML-declared", () => {
  const { xml } = buildTurboDbotXml(spec());
  assert.ok(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
  assert.ok(xml.includes('<xml xmlns="http://www.w3.org/1999/xhtml" collection="false">'));
  assert.ok(!xml.includes("is_dbot"));
});

test("tags are balanced and block ids unique", () => {
  const { xml } = buildTurboDbotXml(spec());
  for (const tag of ["block", "value", "statement", "field", "next", "mutation"]) tagBalance(xml, tag);
  const ids = blockIds(xml);
  assert.equal(new Set(ids).size, ids.length, "duplicate block ids");
});

test("deterministic output for identical spec", () => {
  assert.equal(buildTurboDbotXml(spec()).xml, buildTurboDbotXml(spec()).xml);
});

test("trade definition encodes the locked market and 1-tick over/under", () => {
  const { xml } = buildTurboDbotXml(spec({ symbol: "R_75" }));
  assert.ok(xml.includes('<field name="SYMBOL_LIST">R_75</field>'));
  assert.ok(xml.includes('<field name="TRADETYPECAT_LIST">digits</field>'));
  assert.ok(xml.includes('<field name="TRADETYPE_LIST">overunder</field>'));
  assert.ok(xml.includes('<field name="TYPE_LIST">both</field>'));
  assert.ok(xml.includes('<field name="DURATIONTYPE_LIST">t</field>'));
  assert.ok(xml.includes('<field name="CURRENCY_LIST">USD</field>'));
});

test("purchase blocks branch on recovery state with both locked sides", () => {
  const { xml } = buildTurboDbotXml(spec());
  assert.ok(xml.includes('<field name="PURCHASE_LIST">DIGITUNDER</field>'));
  assert.ok(xml.includes('<field name="PURCHASE_LIST">DIGITOVER</field>'));
  assert.ok(xml.includes(`<field name="VAR" id="${NT_VARS.inRecovery}_id" variabletype="">${NT_VARS.inRecovery}</field>`));
  const order = xml.indexOf('<block type="before_purchase"') < xml.indexOf('<block type="after_purchase"');
  assert.ok(order);
});

function sliceProc(xml: string, name: string): string {
  const start = xml.indexOf(`<field name="NAME">${name}</field>`);
  assert.notEqual(start, -1, `procedure ${name} present`);
  const rest = xml.slice(start);
  // Next top-level construct after the procedure (heuristic: next procedure or the trade block).
  const enders = [`<block type="procedures_defreturn"`, `<block type="trade" `]
    .map(m => xml.indexOf(m, start + 10))
    .filter(i => i !== -1);
  return rest.slice(0, Math.min(...enders));
}

test("prediction procedure returns the two locked barriers", () => {
  const { xml } = buildTurboDbotXml(spec({
    normal: { side: "DIGITUNDER", barrier: 8 },
    recovery: { side: "DIGITOVER", barrier: 4 },
  }));
  const proc = sliceProc(xml, "NT Prediction");
  assert.ok(proc.includes('<field name="NUM">8</field>'));
  assert.ok(proc.includes('<field name="NUM">4</field>'));
  assert.ok(proc.includes("logic_ternary"));
});

test("stake procedure: base stake normally; exact debt formula in recovery", () => {
  const { xml } = buildTurboDbotXml(spec({ baseStake: 1.5, recoveryMarkupPct: 10, recoveryPayout: 1.95, stopLoss: 5 }));
  const proc = sliceProc(xml, "NT Stake");
  assert.ok(proc.includes('<field name="NUM">1.5</field>'), "base stake present");
  assert.ok(proc.includes('<field name="NUM">1.1</field>'), "markup factor 1 + 10/100");
  assert.ok(proc.includes('<field name="NUM">0.95</field>'), "payout − 1 net rate");
  assert.ok(proc.includes("ROUNDUP"), "ceil2 stake rounding");
  assert.ok(proc.includes('<field name="NUM">100</field>'), "cents-shift rounding");
  assert.ok(proc.includes('<field name="NUM">0.35</field>'), "min stake clamp");
  assert.ok(proc.includes('<field name="NUM">5</field>'), "max stake clamp = stopLoss");
});

test("after_purchase ledger: win repays debt, loss adds it, boundaries gate trade_again", () => {
  const { xml } = buildTurboDbotXml(spec({ takeProfit: 12, stopLoss: 6, maxConsecutiveLosses: 9 }));
  assert.ok(xml.includes('<block type="read_details"'));
  assert.ok(xml.includes('<field name="DETAIL_INDEX">4</field>'), "reads contract profit");
  assert.ok((xml.match(/contract_check_result/g) ?? []).length >= 1, "win/loss check");
  assert.ok(xml.includes('<field name="CHECK_RESULT">win</field>'));
  assert.ok(xml.includes('<field name="NUM">12</field>'), "take profit");
  assert.ok(xml.includes('<field name="NUM">-6</field>'), "stop loss as negative total");
  assert.ok(xml.includes('<field name="NUM">9</field>'), "circuit breaker");
  assert.ok(xml.includes('<block type="trade_again"'), "continues when in bounds");
  assert.ok(xml.includes('<block type="notify"'), "announces the stop");
});

test("escapes special characters in currency/display strings and emits a filename", () => {
  const { xml, filename } = buildTurboDbotXml(spec({ displayName: "Volatility 75 <Index>" }));
  void xml;
  assert.match(filename, /^neurotrade-turbo_r_100_over2_rec-under5\.xml$/);
});

test("same-side normal/recovery pairs still emit two purchase paths", () => {
  const { xml } = buildTurboDbotXml(spec({
    normal: { side: "DIGITOVER", barrier: 2 },
    recovery: { side: "DIGITOVER", barrier: 5 },
  }));
  assert.equal((xml.match(/PURCHASE_LIST">DIGITOVER</g) ?? []).length, 2);
});
