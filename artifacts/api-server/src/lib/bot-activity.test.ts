/**
 * Bot-activity + console-contract tests.
 *
 * Covers the two backend defects found while investigating "Match Pulse,
 * Twin-Hedge Edge and Compounding Range Sentinel look different in production":
 *
 *  1. `/api/bots` forgot the accumulator in its active-bot priority list, so a
 *     running Compounding Range Sentinel reported `activeBotId: null` (and got
 *     no session attached to its card) while `/api/bots/status` — which does
 *     include it — said otherwise.
 *  2. Neither service declared which console a bot needs, so an out-of-date web
 *     bundle could not tell that it was out of date; it silently rendered the
 *     generic specialist console instead.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickActiveBotId } from "./bot-activity.js";
import { BOT_CATALOG, botConsoleId, botConsoleIds, getBotDefinition } from "./bot-catalog.js";
import { API_RELEASE } from "./release.js";

const idle = { running: false, botId: null };

describe("pickActiveBotId", () => {
  it("returns null when nothing is running", () => {
    assert.equal(pickActiveBotId([idle, idle, idle]), null);
  });

  it("returns the first running candidate in the order it was given", () => {
    assert.equal(
      pickActiveBotId([idle, { running: true, botId: "duallock" }, { running: true, botId: "twin-hedge" }]),
      "duallock",
    );
  });

  it("reports a running accumulator (the bug this replaced the inline chain for)", () => {
    const active = pickActiveBotId([
      { running: false, botId: "match-pulse" },
      { running: false, botId: "duallock" },
      { running: false, botId: "killshot" },
      { running: false, botId: null },
      { running: false, botId: null },
      { running: true, botId: "accumulator" },
      { running: false, botId: null },
    ]);
    assert.equal(active, "accumulator");
  });

  it("ignores a running engine that reports no bot id", () => {
    assert.equal(pickActiveBotId([{ running: true, botId: null }, { running: true, botId: "match-pulse" }]), "match-pulse");
  });
});

describe("bot console contract", () => {
  it("gives every catalogue bot a console id", () => {
    for (const bot of BOT_CATALOG) {
      assert.match(botConsoleId(bot), /^[a-z-]+@\d+$/, `${bot.id} has no console id`);
    }
  });

  it("uses the dedicated console for the three bots from the incident", () => {
    assert.equal(botConsoleId(getBotDefinition("match-pulse")!), "match-pulse@1");
    assert.equal(botConsoleId(getBotDefinition("twin-hedge")!), "twin-hedge@2");
    assert.equal(botConsoleId(getBotDefinition("accumulator")!), "accumulator@1");
  });

  it("falls back to the specialist console for family bots with no dedicated UI", () => {
    assert.equal(botConsoleId(getBotDefinition("parity")!), "specialist@1");
    assert.equal(botConsoleId(getBotDefinition("match")!), "specialist@1");
  });

  it("publishes the exact set of consoles the web bundle must implement", () => {
    assert.deepEqual(botConsoleIds(), [
      "accumulator@1",
      "dual-lock@1",
      "killshot-family@1",
      "killshot@1",
      "match-pulse@1",
      "specialist@1",
      "twin-hedge@2",
    ]);
  });
});

describe("api release stamp", () => {
  it("identifies the service and commit for the release handshake", () => {
    assert.equal(API_RELEASE.service, "api");
    assert.ok(API_RELEASE.sha.length > 0);
    assert.equal(API_RELEASE.shortSha, API_RELEASE.sha.slice(0, 7));
  });
});
