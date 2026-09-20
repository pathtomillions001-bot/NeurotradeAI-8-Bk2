/**
 * "Which bot is mine?" — the account scope of a running bot, from the web side.
 *
 * The API stamps every live entry with the Deriv account its engine is trading
 * and with a `scope` judged against the account THIS browser is connected to.
 * These tests pin the browser's half of the contract: which entry may be
 * presented as the user's live bot, which one must be shown as foreign (still
 * visible, still stoppable), and which one is another session's masked marker.
 *
 * Getting this wrong is not cosmetic — it is how a bot trading account A ends
 * up under account B's balance on screen.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { otherAccountBot, otherSessionBot, ownAccountBot, stopPathForBot, type LiveBot } from "./live-bots";

function bot(partial: Partial<LiveBot> & { botId: string; scope: LiveBot["scope"] }): LiveBot {
  return {
    botName: partial.botId,
    console: "specialist@1",
    status: { running: true, botId: partial.botId },
    ...partial,
  } as LiveBot;
}

describe("account-scoped live bots", () => {
  it("picks this account's bot", () => {
    const bots = [
      bot({ botId: "ks-matchdiff", scope: "other-account", account: "CR999" }),
      bot({ botId: "match-prism", scope: "this-account", account: "CR777" }),
    ];
    assert.equal(ownAccountBot(bots)?.botId, "match-prism");
    assert.equal(otherAccountBot(bots)?.botId, "ks-matchdiff");
  });

  it("treats an unstamped engine as the user's own (never hides a running bot)", () => {
    const bots = [bot({ botId: "killshot", scope: "unattributed", account: null })];
    assert.equal(ownAccountBot(bots)?.botId, "killshot");
  });

  it("never returns another account's bot as the user's own", () => {
    const bots = [bot({ botId: "killshot", scope: "other-account", account: "CR999" })];
    assert.equal(ownAccountBot(bots), null);
    assert.equal(ownAccountBot(bots)?.botId, undefined);
  });

  it("separates another browser session's masked marker", () => {
    const bots = [bot({ botId: "specialist", scope: "other-session", account: null, status: { running: true, masked: true } })];
    assert.equal(otherSessionBot(bots)?.botId, "specialist");
    assert.equal(ownAccountBot(bots), null);
  });

  it("returns null when nothing is running", () => {
    assert.equal(ownAccountBot([]), null);
    assert.equal(otherAccountBot([]), null);
    assert.equal(otherSessionBot([]), null);
  });

  it("stops each engine family through its own endpoint", () => {
    assert.equal(stopPathForBot("duallock"), "/api/bots/duallock/stop");
    assert.equal(stopPathForBot("killshot"), "/api/bots/killshot/stop");
    assert.equal(stopPathForBot("ks-overunder"), "/api/bots/family/stop");
    assert.equal(stopPathForBot("ks-parity"), "/api/bots/family/stop");
    assert.equal(stopPathForBot("ks-matchdiff"), "/api/bots/family/stop");
    assert.equal(stopPathForBot("match-prism"), "/api/bots/prism/stop");
    assert.equal(stopPathForBot("parity"), "/api/bots/parity/stop");
  });
});
