/**
 * Bot-console contract — regression tests.
 *
 * The 2026-09-19 production incident: the web service kept serving the bundle
 * from commit 39300a9 (Match Pulse absent, Compounding Range Sentinel absent,
 * pre-rebuild Twin-Hedge console) while the API was on 1d7b39f. The catalogue
 * advertised Match Pulse and the accumulator, the page had no console for them,
 * and the old dispatch chain quietly fell through to the generic specialist
 * console. Nothing failed, so nobody could see it.
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
  "match-pulse@1",
  "accumulator@1",
  "twin-hedge@2",
  "dual-lock@1",
  "killshot@1",
  "killshot-family@1",
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
    const resolution = resolveConsole({ console: "match-pulse@1" });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.ok && resolution.Console, CONSOLE_REGISTRY["match-pulse@1"]);
  });

  it("reports (never falls back for) a console this bundle lacks", () => {
    const resolution = resolveConsole({ console: "accumulator@2" });
    assert.equal(resolution.ok, false);
    assert.equal(resolution.ok === false && resolution.id, "accumulator@2");
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
        { id: "match-pulse", name: "Match Pulse", console: "match-pulse@1" },
        { id: "twin-hedge", name: "Twin-Hedge Edge", console: "twin-hedge@2" },
        { id: "accumulator", name: "Compounding Range Sentinel", console: "accumulator@1" },
      ],
      API_CONSOLE_IDS,
    );
    assert.equal(skew.skewed, false);
    assert.deepEqual(skew.missing, []);
  });

  it("names the three bots a pre-2026-09-18 bundle could not render (the production case)", () => {
    // Exactly the deployed-bundle registry from the incident: no Match Pulse
    // console, no accumulator console, and the superseded twin console (v1).
    const deployedBundleConsoles = [
      "specialist@1",
      "twin-hedge@1",
      "dual-lock@1",
      "killshot@1",
      "killshot-family@1",
    ];
    const skew = consoleSkew(
      [
        { id: "match-pulse", name: "Match Pulse", console: "match-pulse@1" },
        { id: "twin-hedge", name: "Twin-Hedge Edge", console: "twin-hedge@2" },
        { id: "accumulator", name: "Compounding Range Sentinel", console: "accumulator@1" },
      ],
      API_CONSOLE_IDS,
      deployedBundleConsoles,
    );

    assert.equal(skew.skewed, true);
    assert.deepEqual(
      skew.bots.map(entry => entry.name),
      ["Match Pulse", "Twin-Hedge Edge", "Compounding Range Sentinel"],
    );
    assert.deepEqual(skew.missing, ["accumulator@1", "match-pulse@1", "twin-hedge@2"]);
  });

  it("detects a contract-only mismatch (no bot of that console in the catalogue yet)", () => {
    const skew = consoleSkew([], ["specialist@1", "accumulator@1"], ["specialist@1", "twin-hedge@1"]);
    assert.equal(skew.skewed, true);
    assert.deepEqual(skew.missing, ["accumulator@1"]);
  });
});
