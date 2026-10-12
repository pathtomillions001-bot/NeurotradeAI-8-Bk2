/**
 * The expert must never index TF_NAMES[] / TF_LIST[] out of range.
 *
 * WHY THIS TEST EXISTS: the MT5 journal showed
 *   "array out of range in 'NeurotradeBridge.mq5' (2641,24)"
 * 0.5 s after a "FILLED" line. MQL5 stops an expert on that runtime error and
 * the chart shows it as removed, so the bridge "detached itself" after every
 * trade. Line 2641 was PsEncode() reading TF_NAMES[ps.entryTfIndex]. The
 * reconcile pass that adopts a fresh fill never set entryTfIndex or mode, and
 * PsEnsure() reused slots without clearing them, so the index was stale.
 *
 * No MetaEditor runs in CI, so this is a static check on the source. It pins
 * the specific failure mode that shipped:
 *   • every timeframe-array lookup is a loop index or goes through SafeTfIndex;
 *   • PsInitBlank() assigns EVERY field of PositionState (no stale slot data);
 *   • PsEnsure() creates states only through PsInitBlank();
 *   • the reconcile pass sets mode and entryTfIndex before it saves;
 *   • PsDecode() repairs an unknown timeframe instead of storing -1;
 *   • the EA version agrees in #property, EA_VERSION and the Desk's expectation.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const eaSource = fs.readFileSync(
  path.join(repoRoot, "artifacts", "mt5-ea", "NeurotradeBridge.mq5"),
  "utf8",
);
const bridgeSource = fs.readFileSync(
  path.join(repoRoot, "artifacts", "api-server", "src", "routes", "bridge.ts"),
  "utf8",
);

/** Source with block and line comments removed (strings are left intact). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

const code = stripComments(eaSource);

/** The body of the function whose signature starts with `signature`. */
function functionBody(signature: string): string {
  const start = code.indexOf(signature);
  assert.ok(start >= 0, `function not found: ${signature}`);
  const open = code.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated function: ${signature}`);
}

/** Field names of `struct PositionState`, in declaration order. */
function positionStateFields(): string[] {
  const start = code.indexOf("struct PositionState");
  assert.ok(start >= 0, "struct PositionState not found");
  const body = code.slice(code.indexOf("{", start) + 1, code.indexOf("};", start));
  const fields: string[] = [];
  for (const statement of body.split(";")) {
    const m = statement.match(/([A-Za-z_]\w*)\s*(\[\s*\d+\s*\])?\s*$/);
    if (m && m[1] !== "struct") fields.push(m[1]);
  }
  return fields;
}

test("every TF_NAMES[] / TF_LIST[] lookup is a loop index or goes through SafeTfIndex", () => {
  const lookups = [...code.matchAll(/TF_(?:NAMES|LIST)\[([^\]]*)\]/g)].map((m) => m[1].trim());
  assert.ok(lookups.length > 0, "expected timeframe lookups in the EA");
  for (const index of lookups) {
    const allowed =
      index === "i" ||
      index === "t" ||
      /^SafeTfIndex\(/.test(index) ||
      index === "TF_COUNT"; // the declaration itself
    assert.ok(allowed, `unguarded timeframe lookup with index "${index}"`);
  }
});

test("TfNameAt and SafeTfIndex clamp into [0, TF_COUNT)", () => {
  const safe = functionBody("int SafeTfIndex(");
  assert.match(safe, /index >= 0 && index < TF_COUNT/);
  const named = functionBody("string TfNameAt(");
  assert.match(named, /TF_NAMES\[SafeTfIndex\(index\)\]/);
});

test("PsInitBlank assigns every PositionState field, so a reused slot holds no stale data", () => {
  const fields = positionStateFields();
  assert.ok(fields.includes("entryTfIndex") && fields.includes("mode"), "struct fields not parsed");
  const body = functionBody("void PsInitBlank(");
  const missing = fields.filter((f) => !new RegExp(`\\bps\\.${f}\\b`).test(body));
  assert.deepEqual(missing, [], `PsInitBlank does not initialise: ${missing.join(", ")}`);
});

test("PsEnsure creates new states only through PsInitBlank", () => {
  const body = functionBody("int PsEnsure(");
  assert.match(body, /PsInitBlank\(blank, ticket\)/);
  assert.doesNotMatch(body, /blank\.(?!ticket)\w+\s*=/, "PsEnsure must not set fields ad hoc");
});

test("the reconcile pass sets mode and timeframe before it saves", () => {
  const body = functionBody("void ReconcileFilledPositions(");
  const tfAt = body.indexOf("ps.entryTfIndex = TfIndexForMode(ps.mode)");
  const modeAt = body.indexOf("ps.mode = 1;");
  const saveAt = body.indexOf("PsSave(ps)");
  assert.ok(tfAt >= 0 && modeAt >= 0, "reconcile does not set mode/timeframe");
  assert.ok(tfAt < saveAt && modeAt < saveAt, "reconcile saves before setting mode/timeframe");
});

test("PsDecode repairs an unknown timeframe instead of storing -1", () => {
  const body = functionBody("bool PsDecode(");
  assert.doesNotMatch(body, /ps\.entryTfIndex\s*=\s*TfIndexFromName/);
  assert.match(body, /decodedTf >= 0 \? decodedTf : TfIndexForMode\(ps\.mode\)/);
});

test("PsApplyDefaults leaves a valid mode and timeframe behind", () => {
  const body = functionBody("void PsApplyDefaults(");
  assert.match(body, /ps\.mode < 0 \|\| ps\.mode > 2/);
  assert.match(body, /ps\.entryTfIndex = TfIndexForMode\(ps\.mode\)/);
});

test("PsEncode writes the timeframe name through the safe lookup only", () => {
  const body = functionBody("string PsEncode(");
  assert.match(body, /f\[6\]\s*=\s*TfNameAt\(ps\.entryTfIndex\)/);
  assert.doesNotMatch(body, /TF_NAMES\[/);
});

test("the EA version agrees across #property, EA_VERSION and the Desk expectation", () => {
  const property = eaSource.match(/#property version\s+"([\d.]+)"/)?.[1];
  const define = eaSource.match(/#define EA_VERSION\s+"([\d.]+)"/)?.[1];
  const expected = bridgeSource.match(/export const EXPECTED_EA_VERSION = "([\d.]+)"/)?.[1];
  assert.equal(property, "3.07");
  assert.equal(define, property);
  assert.equal(expected, property);
});

test("the v3.07 changelog entry documents the detach fix", () => {
  assert.match(eaSource, /WHAT CHANGED IN v3\.07/);
  assert.match(eaSource, /array out of range/);
});
