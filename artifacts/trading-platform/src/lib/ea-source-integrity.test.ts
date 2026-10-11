/**
 * The EA the Desk hands out must be a file MetaEditor can COMPILE.
 *
 * WHY THIS TEST EXISTS: v3.05 shipped an EA that compiled nowhere. The
 * position-management state machine was appended to `NeurotradeBridge.mq5` at
 * the position its FUNCTIONS belong in — after `ArmPlanFromJson()` and the
 * command handlers — while the macros, the `PositionState` struct and the
 * arrays those functions share were appended with it. MQL5's preprocessor is
 * single-pass and its compiler resolves names in TEXT ORDER, so every one of
 * those uses was an error ("declaration without type", "undeclared identifier
 * 'PM_TRAIL_MULT_SCALP'", "cannot convert parameter 'PositionState' to 'int'")
 * and a user who downloaded the EA from the Desk could not compile it at all.
 *
 * The existing EA tests could not catch that: they assert that the published
 * file CONTAINS the v3.05 markers (`PositionState`, `PsRestoreAll`, …), and a
 * file that mentions a name seventeen times passes that check whether or not
 * the name is declared before its first use. So the ordering itself is pinned
 * here, mechanically:
 *
 *   • every macro, struct and global is declared before its first use;
 *   • no name is declared twice (a re-splice that duplicates the block);
 *   • braces and parentheses balance (a splice that loses a closing line);
 *   • the heartbeat timer does not narrow `GetTickCount64()` (ulong) into a
 *     `long`, which MetaEditor reports as "possible loss of data".
 *
 * This is a static check, not a compiler: it cannot prove the EA builds. It
 * proves the specific failure mode that shipped, at the point where a machine
 * can still read it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const eaSourcePath = path.join(repoRoot, "artifacts", "mt5-ea", "NeurotradeBridge.mq5");
const eaSource = fs.readFileSync(eaSourcePath, "utf8");
const rawLines = eaSource.split("\n");

/** Keywords that can start a statement and would otherwise look like a type. */
const NOT_A_TYPE = new Set([
  "return", "else", "case", "if", "for", "while", "switch", "struct", "class",
  "enum", "union", "typedef", "template", "break", "continue", "delete", "new",
  "do", "default", "public", "private", "protected", "static", "const", "input",
]);

/**
 * The source with comments and string literals blanked out, line numbering
 * kept. Everything below parses THIS, so a name mentioned inside a comment
 * ("that is what `PsRestoreAll()` does") is never mistaken for a use, and a
 * brace inside a string never breaks the balance count.
 */
function codeOnly(text: string): string[] {
  const out: string[] = [];
  let inBlockComment = false;

  for (const rawLine of text.split("\n")) {
    let line = "";
    let i = 0;
    while (i < rawLine.length) {
      if (inBlockComment) {
        const end = rawLine.indexOf("*/", i);
        if (end === -1) {
          i = rawLine.length;
          break;
        }
        inBlockComment = false;
        i = end + 2;
        continue;
      }
      const rest = rawLine.slice(i);
      if (rest.startsWith("//")) break;
      if (rest.startsWith("/*")) {
        inBlockComment = true;
        i += 2;
        continue;
      }
      // Character literals come FIRST: MQL5 writes comparisons against a
      // delimiter as 'c' ("if(ch != '\"')"), and treating that inner quote as a
      // string opener would blank the rest of the line and invent a paren.
      if (rawLine[i] === "'" || rawLine[i] === '"') {
        const quote = rawLine[i];
        let j = i + 1;
        while (j < rawLine.length) {
          if (rawLine[j] === "\\") {
            j += 2;
            continue;
          }
          if (rawLine[j] === quote) {
            j += 1;
            break;
          }
          j += 1;
        }
        line += " ".repeat(j - i);
        i = j;
        continue;
      }
      line += rawLine[i];
      i += 1;
    }
    out.push(line);
  }
  return out;
}

type Declaration = { name: string; line: number; kind: "macro" | "type" | "global" };

/**
 * Top-level declarations whose ORDER MQL5 cares about. Function definitions are
 * deliberately absent: MQL5 resolves a call to a function defined later, so
 * only macros, types and variables must precede their first use.
 */
function declaredSymbols(lines: string[]): Declaration[] {
  const found: Declaration[] = [];
  lines.forEach((line, index) => {
    const at = index + 1;

    let match = /^#define\s+([A-Za-z_]\w*)/.exec(line);
    if (match) {
      found.push({ name: match[1], line: at, kind: "macro" });
      return;
    }

    match = /^(?:struct|class|enum)\s+([A-Za-z_]\w*)/.exec(line);
    if (match) {
      found.push({ name: match[1], line: at, kind: "type" });
      return;
    }

    // `[input|static] type name[array][= init];` at column 0 — inputs, CTrade,
    // the plan array, the link state, the v3.05 position arrays.
    match = /^(?:input\s+|static\s+)?([A-Za-z_]\w*(?:\s*\*)?)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*(=|;)/.exec(line);
    if (match && !NOT_A_TYPE.has(match[1])) {
      found.push({ name: match[2], line: at, kind: "global" });
    }
  });
  return found;
}

test("every macro, struct and global is declared before its first use", () => {
  const lines = codeOnly(eaSource);
  const offenders: string[] = [];

  for (const declaration of declaredSymbols(lines)) {
    const use = new RegExp(`\\b${declaration.name}\\b`);
    for (let i = 0; i < lines.length; i++) {
      if (i + 1 === declaration.line) continue;
      // A #define body is expanded at the USE site, so a macro named inside
      // another macro's body is not itself a use at that line.
      if (lines[i].trimStart().startsWith("#define")) continue;
      if (!use.test(lines[i])) continue;
      if (i + 1 < declaration.line) {
        offenders.push(
          `${declaration.name} (${declaration.kind}) is used on line ${i + 1} ` +
            `but declared on line ${declaration.line}: "${rawLines[i].trim()}"`,
        );
      }
      break;
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `MQL5 resolves names in text order — a use above the declaration fails to ` +
      `compile with "undeclared identifier" / "declaration without type":\n` +
      offenders.join("\n"),
  );
});

test("no macro, type or global is declared twice", () => {
  const lines = codeOnly(eaSource);
  const seen = new Map<string, Declaration>();

  for (const declaration of declaredSymbols(lines)) {
    const previous = seen.get(declaration.name);
    assert.equal(
      previous,
      undefined,
      `${declaration.name} is declared twice (line ${previous?.line} and line ` +
        `${declaration.line}) — a re-spliced block must not duplicate the state ` +
        `it shares with the rest of the EA`,
    );
    seen.set(declaration.name, declaration);
  }
});

test("the EA's braces and parentheses balance", () => {
  const lines = codeOnly(eaSource);
  let braces = 0;
  let parens = 0;
  for (const line of lines) {
    for (const character of line) {
      if (character === "{") braces += 1;
      if (character === "}") braces -= 1;
      if (character === "(") parens += 1;
      if (character === ")") parens -= 1;
    }
  }
  assert.equal(braces, 0, "unbalanced braces — a splice dropped or duplicated a line");
  assert.equal(parens, 0, "unbalanced parentheses — a splice dropped or duplicated a line");
});

test("the heartbeat timer keeps GetTickCount64() unsigned", () => {
  // GetTickCount64() returns `ulong`. Storing it in a `long` is the narrowing
  // conversion MetaEditor reports as "possible loss of data due to type
  // conversion from 'ulong' to 'long'" — and a wrapped counter would read as a
  // huge negative duration in the Experts log.
  assert.doesNotMatch(
    eaSource,
    /\blong\s+\w+\s*=\s*GetTickCount64\s*\(/,
    "GetTickCount64() must be held in a `ulong`, not a `long`",
  );
  assert.match(
    eaSource,
    /\bulong\s+beatStart\s*=\s*GetTickCount64\s*\(\)/,
    "the heartbeat timer must still measure the beat",
  );
});

test("the EA reports one version, and it is the one it declares", () => {
  // The Desk stores the version the HEARTBEAT body reports and compares it to
  // EXPECTED_EA_VERSION to decide whether to show "your EA is out of date".
  // v3.05 shipped with the pairing body at 3.05 and the heartbeat body at 3.04,
  // so that check could never see a v3.05 terminal.
  const declared = /#property\s+version\s+"([^"]+)"/.exec(eaSource)?.[1];
  assert.ok(declared, "the EA must declare #property version");

  const wire = /#define\s+EA_VERSION\s+"([^"]+)"/.exec(eaSource)?.[1];
  assert.equal(wire, declared, "EA_VERSION must match the #property version");

  // Both bodies build their JSON by string concatenation, so the version is
  // either a literal (\"version\":\"3.05\") or the EA_VERSION macro.
  const versionLines = rawLines.filter((line) => line.includes('\\"version\\":'));
  assert.ok(versionLines.length >= 2, "the pairing and heartbeat bodies both report a version");

  const literal = /\\"version\\":\\"(\d+\.\d+)\\"/;
  const macro = /\\"version\\":\\""\s*\+\s*([A-Za-z_]\w*)/;
  for (const line of versionLines) {
    const found = literal.exec(line)?.[1] ?? macro.exec(line)?.[1];
    assert.ok(found, `unparsable version on the wire: ${line.trim()}`);
    assert.equal(
      found === "EA_VERSION" ? wire : found,
      declared,
      `the wire version must be ${declared}, found ${found} — one literal per body is how v3.05 drifted`,
    );
  }
});

test("the position-manager state is declared with the shared EA state", () => {
  const lines = codeOnly(eaSource);
  const declarations = declaredSymbols(lines);
  const lineOf = (name: string): number => {
    const found = declarations.find((declaration) => declaration.name === name);
    assert.ok(found, `${name} must be declared`);
    return found.line;
  };

  // The first user of the position state is ArmPlanFromJson() (it builds a
  // `PositionState policyCarrier`), and ParsePartials() is the declaration the
  // compiler could not read. Both must sit BELOW the state.
  const firstUser = lines.findIndex((line) => line.includes("ParsePartials"));
  const positionState = lineOf("PositionState");
  const trailScalp = lineOf("PM_TRAIL_MULT_SCALP");
  assert.ok(
    positionState < firstUser + 1,
    `PositionState (line ${positionState}) must be declared above its first use (line ${firstUser + 1})`,
  );
  assert.ok(
    trailScalp < firstUser + 1,
    `PM_TRAIL_MULT_SCALP (line ${trailScalp}) must be declared above its first use (line ${firstUser + 1})`,
  );
});
