/**
 * Bot-console contract — regression tests.
 *
 * The 2026-09-19 production incident: the web service kept serving a bundle
 * older than the API. The catalogue advertised consoles the page did not
 * have, and the old dispatch chain quietly fell through to the generic
 * specialist console. Nothing failed, so nobody could see it.
 *
 * These tests pin both halves:
 *   - every console id the API can send is implemented by this bundle,
 *   - an id this bundle does not implement is REPORTED, never guessed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONSOLE_REGISTRY, consoleSkew, implementedConsoleIds, resolveConsole } from "./console-registry.js";
import { WEB_CONSOLE_IDS } from "./console-contract.js";

/**
 * Console ids the API catalogue currently emits (`botConsoleId()` in
 * artifacts/api-server/src/lib/bot-catalog.ts). Hard-coded on purpose: if the
 * API starts asking for a console this bundle does not ship, this test fails
 * here — in the web build that would render it — rather than in production.
 */
const API_CONSOLE_IDS = [
  "specialist@1",
  "dual-lock@1",
  "killshot@1",
  "killshot-family@1",
  "twin-hedge@1",
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
    const resolution = resolveConsole({ console: "dual-lock@1" });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.ok && resolution.Console, CONSOLE_REGISTRY["dual-lock@1"]);
  });

  it("reports (never falls back for) a console this bundle lacks", () => {
    const resolution = resolveConsole({ console: "dual-lock@2" });
    assert.equal(resolution.ok, false);
    assert.equal(resolution.ok === false && resolution.id, "dual-lock@2");
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
        { id: "duallock", name: "Dual-Lock Range Sentinel", console: "dual-lock@1" },
        { id: "killshot", name: "Kill-Shot Oracle", console: "killshot@1" },
        { id: "parity", name: "Parity Sentinel", console: "specialist@1" },
      ],
      API_CONSOLE_IDS,
    );
    assert.equal(skew.skewed, false);
    assert.deepEqual(skew.missing, []);
  });

  it("names every bot a stale bundle cannot render", () => {
    // A bundle one revision behind on the Dual-Lock console.
    const deployedBundleConsoles = [
      "specialist@1",
      "killshot@1",
      "killshot-family@1",
      "twin-hedge@1",
    ];
    const skew = consoleSkew(
      [
        { id: "duallock", name: "Dual-Lock Range Sentinel", console: "dual-lock@1" },
        { id: "killshot", name: "Kill-Shot Oracle", console: "killshot@1" },
      ],
      API_CONSOLE_IDS,
      deployedBundleConsoles,
    );

    assert.equal(skew.skewed, true);
    assert.deepEqual(
      skew.bots.map(entry => entry.name),
      ["Dual-Lock Range Sentinel"],
    );
    assert.deepEqual(skew.missing, ["dual-lock@1"]);
  });

  it("detects a contract-only mismatch (no bot of that console in the catalogue yet)", () => {
    const skew = consoleSkew([], ["specialist@1", "dual-lock@1"], ["specialist@1"]);
    assert.equal(skew.skewed, true);
    assert.deepEqual(skew.missing, ["dual-lock@1"]);
  });
});
