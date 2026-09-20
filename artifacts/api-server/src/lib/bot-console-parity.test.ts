/**
 * Cross-artifact console parity + Match Prism wiring guards.
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

import { botConsoleIds, getBotDefinition } from "./bot-catalog";
import { MATCH_PAYOUT } from "./payouts";
import * as prism from "./match-prism-engine";
import { PRISM_BREAK_EVEN, PRISM_BOT_ID, PRISM_CONTRACT_TYPE } from "./match-prism-analysis";

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

describe("match prism wiring", () => {
  it("is a catalogue bot on its own console", () => {
    const def = getBotDefinition(PRISM_BOT_ID);
    assert.ok(def, "Match Prism must be in BOT_CATALOG");
    assert.equal(def.prism, true);
    assert.equal(def.oneShot, undefined);
    assert.equal(def.preLocked, undefined);
    assert.equal(def.killShotFamily, undefined);
  });

  it("cannot reach a Differs contract from its catalogue entry", () => {
    const def = getBotDefinition(PRISM_BOT_ID)!;
    const contracts = def.sides.flatMap((s) => s.contracts);
    assert.deepEqual(contracts, [PRISM_CONTRACT_TYPE]);
    for (const c of contracts) {
      assert.ok(!c.includes("DIFF"), `Match Prism must never be able to buy ${c}`);
    }
  });

  it("prices its break-even off the live Match payout, not a copied number", () => {
    assert.ok(Math.abs(PRISM_BREAK_EVEN - 1 / MATCH_PAYOUT) < 1e-9);
  });

  it("exposes the route surface routes/bots.ts calls", () => {
    for (const fn of ["startSession", "stopSession", "getStatus", "scanForPrism", "isRunning", "getOwnerSessionId"] as const) {
      assert.equal(typeof (prism as Record<string, unknown>)[fn], "function", `prism.${fn} must be exported`);
    }
    assert.equal(prism.MATCH_PRISM_BOT_ID, PRISM_BOT_ID);
  });

  it("reports a stopped, ownerless status before any session exists", () => {
    if (prism.isRunning()) return;
    const status = prism.getStatus();
    assert.equal(status.running, false);
    assert.equal(status.botId, PRISM_BOT_ID, "the idle status still names the bot so /live can label it");
    assert.equal(status.sessionId, null);
    assert.equal(status.tradeCount, 0);
    assert.equal(status.deployed, undefined, "an idle engine must not advertise a deployed card");
  });
});
