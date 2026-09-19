/**
 * Bot-console contract — regression tests.
 *
 * Ensures every console id the API can send is implemented by this bundle,
 * and that unknown ids are reported, never guessed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONSOLE_REGISTRY, consoleSkew, implementedConsoleIds, resolveConsole } from "./console-registry.js";
import { WEB_CONSOLE_IDS } from "./console-contract.js";

/**
 * Console ids the API catalogue currently emits (`botConsoleId()` in
 * artifacts/api-server/src/lib/bot-catalog.ts).
 */
const API_CONSOLE_IDS = [
  "specialist@1",
  "dual-lock@1",
  "killshot@1",
  "killshot-family@1",
  "match-apex@1",
  "twin-o4u5@1",
];

describe("web console contract", () => {
  it("implements every console id the API catalogue can ask for", () => {
    for (const id of API_CONSOLE_IDS) {
      assert.ok(
        id in CONSOLE_REGISTRY,
        `bundle has no console for "${id}" — a stale web build would silently render the wrong controls`,
      );
    }
  });

  it("declares exactly the consoles it registers (release.json must not lie)", () => {
    assert.deepEqual(implementedConsoleIds(), [...WEB_CONSOLE_IDS].sort());
  });
});

describe("resolveConsole", () => {
  it("resolves a bot whose console this bundle implements", () => {
    const resolution = resolveConsole({ console: "specialist@1" });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.ok && resolution.Console, CONSOLE_REGISTRY["specialist@1"]);
  });

  it("reports (never falls back for) a console this bundle lacks", () => {
    const resolution = resolveConsole({ console: "unknown@99" });
    assert.equal(resolution.ok, false);
    assert.equal(resolution.ok === false && resolution.id, "unknown@99");
  });

  it("falls back to the specialist console only for an API that sends no id", () => {
    const resolution = resolveConsole({});
    assert.equal(resolution.ok, true);
    assert.equal(resolution.ok && resolution.id, "specialist@1");
  });
});

describe("consoleSkew", () => {
  it("is quiet when the catalogue matches this bundle", () => {
    const skew = consoleSkew(
      [
        { id: "parity", name: "Parity Sentinel", console: "specialist@1" },
        { id: "duallock", name: "Dual-Lock Range Sentinel", console: "dual-lock@1" },
      ],
      API_CONSOLE_IDS,
    );
    assert.equal(skew.skewed, false);
    assert.deepEqual(skew.missing, []);
  });

  it("detects a missing console from a stale bundle", () => {
    const deployedBundleConsoles = [
      "specialist@1",
      "dual-lock@1",
    ];
    const skew = consoleSkew(
      [
        { id: "killshot", name: "Kill-Shot Oracle", console: "killshot@1" },
        { id: "ks-overunder", name: "Over/Under Oracle", console: "killshot-family@1" },
      ],
      API_CONSOLE_IDS,
      deployedBundleConsoles,
    );

    assert.equal(skew.skewed, true);
    assert.deepEqual(skew.missing, ["killshot-family@1", "killshot@1", "match-apex@1", "twin-o4u5@1"]);
  });

  it("detects a contract-only mismatch (no bot of that console in the catalogue yet)", () => {
    const skew = consoleSkew([], ["specialist@1", "killshot@1"], ["specialist@1"]);
    assert.equal(skew.skewed, true);
    assert.deepEqual(skew.missing, ["killshot@1"]);
  });
});
