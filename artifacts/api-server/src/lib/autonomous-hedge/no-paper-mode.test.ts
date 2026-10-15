/**
 * G9 — paper mode cannot come back.
 *
 * The product requirement is absolute: **no code path may write a simulated trade
 * row.** Removing the `paperTradeMode` flag was not sufficient — the audit below
 * found simulation branches that survived the flag's deletion because they were
 * guarded by `isLive` (or by a per-engine `executionMode`), not by the flag:
 *
 *   - `bot-engine`       : `won = Math.random() < best.winProbability`
 *   - `speed-ai-engine`  : `won = Math.random() < best.winProbability`
 *   - 9 further engines  : settled the trade against the market's NEXT REAL tick
 *                          and journalled the result
 *   - `accumulator`      : `paperSettlement(...)`
 *
 * Every one of those outcomes was then recorded into the SHARED recovery ledger
 * via `recoveryEngine.recordOutcome`, i.e. a simulated trade moved the debt that
 * the real recovery ladder is later sized from. That is contamination, not
 * observation.
 *
 * This test makes the removal permanent in two ways:
 *   1. STATIC — every engine that journals a trade must hold when there is no live
 *      account, and no engine may contain an outcome-simulation idiom.
 *   2. The behavioural half lives in `cycle.test.ts` (a full cycle with no live
 *      account writes no row and moves no ledger) and in
 *      `routes/manual-trades.test.ts` (a manual submission is refused with 409).
 *
 * `omni-engine` is the single documented exception: its paper path is a
 * deterministic test harness that BOTH production routes refuse at the schema
 * level (`omniConnectedConfigSchema`/`omniStartSchema` require
 * `executionMode === "live"`, pinned in `omni-analysis.test.ts`). It is excluded
 * from the guard check below and named here so the exception cannot be forgotten.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url)); // src/lib/autonomous-hedge
const libDir = resolve(here, ".."); // src/lib

/** Engines that write journal rows, and are therefore able to fabricate a trade. */
function engineFiles(): string[] {
  return readdirSync(libDir).filter((f) => f.endsWith("-engine.ts"));
}

/** Drop `//` and block-comment content so explanatory prose cannot trip the scan. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("G9 — no simulated trade can be journalled", () => {
  it("every engine that journals a trade holds BEFORE the insert when there is no live account", () => {
    const offenders: string[] = [];
    for (const file of engineFiles()) {
      if (file === "omni-engine.ts") continue; // documented exception, see header
      const code = codeOnly(readFileSync(join(libDir, file), "utf8"));
      const journal = code.search(/insert\(\s*tradesTable/);
      if (journal === -1) continue; // journals nothing, cannot fabricate a row
      const guard = code.search(/if \(!isLive\)/);
      if (guard === -1) {
        offenders.push(`${file}: journals a trade with NO no-live-account guard`);
      } else if (guard > journal) {
        offenders.push(`${file}: the no-live-account guard runs AFTER the journal insert`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "A session without a live account could still write a fabricated row:\n  " +
        offenders.join("\n  "),
    );
  });

  it("no engine contains an outcome-simulation idiom", () => {
    const offenders: string[] = [];
    for (const file of engineFiles()) {
      const code = codeOnly(readFileSync(join(libDir, file), "utf8"));
      if (/Math\.random\(\)\s*</.test(code)) offenders.push(`${file}: Math.random() comparison`);
      if (/paperSettlement\s*\(/.test(code)) offenders.push(`${file}: paperSettlement(...)`);
    }
    assert.deepEqual(
      offenders,
      [],
      "An outcome is being invented rather than observed:\n  " + offenders.join("\n  "),
    );
  });

  it("the autonomous hedge engine needs a live token before it can journal anything", () => {
    const cycle = readFileSync(resolve(here, "cycle.ts"), "utf8");
    const guard = cycle.indexOf("if (!ctx.token) {");
    const journal = cycle.indexOf("insert(tradesTable)");
    assert.notEqual(guard, -1, "the no-live-account guard is missing from cycle.ts");
    assert.notEqual(journal, -1, "cycle.ts no longer journals trades — has the flow moved?");
    assert.ok(
      guard < journal,
      "the no-live-account guard must run BEFORE any journal insert, otherwise a row " +
        "exists for a contract that was never bought",
    );
  });

  it("no simulated-trade label can be rendered from a live engine prefix", () => {
    const offenders: string[] = [];
    for (const file of engineFiles()) {
      const code = codeOnly(readFileSync(join(libDir, file), "utf8"));
      if (/\[PAPER\]/.test(code)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `Stale [PAPER] labels remain:\n  ${offenders.join("\n  ")}`);
  });
});
