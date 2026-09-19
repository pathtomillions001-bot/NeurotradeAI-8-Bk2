/**
 * Bot-activity + console-contract tests.
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
      pickActiveBotId([idle, { running: true, botId: "duallock" }, { running: true, botId: "ks-overunder" }]),
      "duallock",
    );
  });

  it("ignores a running engine that reports no bot id", () => {
    assert.equal(pickActiveBotId([{ running: true, botId: null }, { running: true, botId: "parity" }]), "parity");
  });
});

describe("bot console contract", () => {
  it("gives every catalogue bot a console id", () => {
    for (const bot of BOT_CATALOG) {
      assert.match(botConsoleId(bot), /^[a-z0-9-]+@\d+$/, `${bot.id} has no console id`);
    }
  });

  it("uses the dedicated console for pre-locked and killshot bots", () => {
    assert.equal(botConsoleId(getBotDefinition("duallock")!), "dual-lock@1");
    assert.equal(botConsoleId(getBotDefinition("killshot")!), "killshot@1");
    assert.equal(botConsoleId(getBotDefinition("ks-overunder")!), "killshot-family@1");
    assert.equal(botConsoleId(getBotDefinition("match-apex")!), "match-apex@1");
    assert.equal(botConsoleId(getBotDefinition("twin-o4u5")!), "twin-o4u5@1");
  });

  it("falls back to the specialist console for family bots with no dedicated UI", () => {
    assert.equal(botConsoleId(getBotDefinition("parity")!), "specialist@1");
    assert.equal(botConsoleId(getBotDefinition("match")!), "specialist@1");
  });

  it("publishes the exact set of consoles the web bundle must implement", () => {
    assert.deepEqual(botConsoleIds(), [
      "dual-lock@1",
      "killshot-family@1",
      "killshot@1",
      "match-apex@1",
      "specialist@1",
      "twin-o4u5@1",
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
