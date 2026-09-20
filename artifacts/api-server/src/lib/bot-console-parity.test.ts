/**
 * Cross-artifact console parity guards.
 *
 * The web bundle and the API are separate deploys. `GET /api/bots` publishes the
 * console ids the catalogue expects (`botConsoleIds()`), and the web bundle can
 * only draw what its own registry implements (`WEB_CONSOLE_IDS`). When the API
 * ships a bot whose console the live web bundle has never heard of, the old Bot
 * Arena silently opened the generic specialist console — the production incident
 * documented in docs/console-release-skew. `consoleSkew()` catches it at runtime
 * and shows an "update available" panel; this test catches it at build time,
 * before the pair is ever deployed mismatched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { botConsoleIds } from "./bot-catalog";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = resolve(here, "../../../trading-platform/src/lib/console-contract.ts");

/** The ids the web bundle claims to implement, read straight from its source. */
function webConsoleIds(): string[] {
  const src = readFileSync(CONTRACT_PATH, "utf8");
  const block = src.slice(src.indexOf("WEB_CONSOLE_IDS"));
  const ids = [...block.matchAll(/"([a-z-]+@\d+)"/g)].map((m) => m[1]!);
  return [...new Set(ids)].sort();
}

describe("console contract parity across artifacts", () => {
  it("parses a non-empty id list out of the web bundle's contract", () => {
    const ids = webConsoleIds();
    assert.ok(ids.length >= 4, "the web console contract should list every shipped console");
    assert.ok(ids.includes("specialist@1"), "the legacy specialist console must stay published");
  });

  it("makes every console the API publishes renderable by the web bundle", () => {
    const web = new Set(webConsoleIds());
    const missing = botConsoleIds().filter((id) => !web.has(id));
    assert.deepEqual(
      missing,
      [],
      `the web bundle cannot render these consoles: ${missing.join(", ")} — add them to WEB_CONSOLE_IDS and CONSOLE_REGISTRY`,
    );
  });
});
