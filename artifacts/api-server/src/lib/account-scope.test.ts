/**
 * A running bot belongs to ONE Deriv account.
 *
 * A browser session can hold several linked Deriv accounts and switch between
 * them, while an engine reads the active account once when it starts and then
 * trades that account's token. Before account scoping the Bot Arena answered
 * "is a bot running?" but never "…on which account?", so a bot started on one
 * account was rendered as the live bot of whatever account was connected next
 * — with that bot's P&L next to the other account's balance.
 *
 * These tests pin the three-state classification, the registry stamp that the
 * start routes write, and the two structural invariants that keep the fix from
 * rotting: every `startSession` is preceded by `stampActiveAccount`, and the
 * app has exactly ONE bot-status popup (the layout's and the Bot Arena's used
 * to be two different elements reading two different endpoints).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  botAccountScope, isOwnAccountScope, noteBotAccount,
} from "./account-scope";
import { listLiveBots, registerLiveBot, unregisterLiveBot } from "./live-registry";
import { runWithSessionId } from "./session";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES_SRC = readFileSync(resolve(here, "../routes/bots.ts"), "utf8");
const WEB = resolve(here, "../../../trading-platform/src");

describe("botAccountScope", () => {
  it("treats the connected account's own bot as this-account", () => {
    assert.equal(botAccountScope("CR777", "CR777"), "this-account");
  });

  it("ignores case and surrounding whitespace on both sides", () => {
    assert.equal(botAccountScope(" cr777 ", "CR777"), "this-account");
    assert.equal(botAccountScope("VRTC1234", "vrtc1234"), "this-account");
  });

  it("reports another linked account's bot as other-account", () => {
    assert.equal(botAccountScope("CR777", "CR999"), "other-account");
  });

  it("never claims an unstamped bot is another account's", () => {
    // No stamp means no contradicting identity (paper trading, or a start that
    // predates account linking). Hiding a running engine is the one failure
    // this subsystem exists to prevent, so it stays "ours".
    assert.equal(botAccountScope(null, "CR777"), "unattributed");
    assert.equal(botAccountScope(undefined, "CR777"), "unattributed");
    assert.equal(botAccountScope("   ", "CR777"), "unattributed");
  });

  it("treats an unknown connected account as NOT own (never assumes)", () => {
    // When nothing is connected there is no account to be the bot's, so a
    // stamped bot is foreign until the account is known again.
    assert.equal(botAccountScope("CR777", null), "other-account");
    assert.equal(botAccountScope("CR777", undefined), "other-account");
    assert.equal(botAccountScope("CR777", ""), "other-account");
  });

  it("keeps both unknown states unattributed (nothing to disagree about)", () => {
    assert.equal(botAccountScope(null, null), "unattributed");
  });

  it("marks exactly other-account as not-own", () => {
    assert.equal(isOwnAccountScope("this-account"), true);
    assert.equal(isOwnAccountScope("unattributed"), true);
    assert.equal(isOwnAccountScope("other-account"), false);
  });
});

describe("live registry account stamp", () => {
  const status = () => ({ running: true, botId: "match-prism", botName: "Match Prism" });
  // The registry is keyed by ENGINE, not by session, so each simulated browser
  // needs its own key to coexist with the others.
  const keyFor = (sessionId: string) => `test-account-scope-${sessionId}`;

  const withRegistration = (sessionId: string, stamp: string | null, fn: () => void) => {
    runWithSessionId(sessionId, () => {
      noteBotAccount(stamp);
      registerLiveBot(keyFor(sessionId), status);
    });
    try {
      fn();
    } finally {
      runWithSessionId(sessionId, () => unregisterLiveBot(keyFor(sessionId)));
    }
  };

  const entryFor = (sessionId: string) =>
    listLiveBots().find((b) => b.ownerSessionId === sessionId && String(b.status.botId) === "match-prism");

  it("captures the account the bot was started on", () => {
    withRegistration("acct-scope-a", "CR777", () => {
      assert.equal(entryFor("acct-scope-a")?.accountLoginId, "CR777");
    });
  });

  it("leaves the stamp empty when no account was noted", () => {
    withRegistration("acct-scope-b", null, () => {
      assert.equal(entryFor("acct-scope-b")?.accountLoginId, null);
    });
  });

  it("keeps the stamp per session, so one browser's note cannot leak", () => {
    withRegistration("acct-scope-c", "CR777", () => {
      withRegistration("acct-scope-d", null, () => {
        // Registered second, with no note of its own: it must NOT inherit the
        // first session's account.
        assert.equal(entryFor("acct-scope-d")?.accountLoginId, null);
        assert.equal(entryFor("acct-scope-c")?.accountLoginId, "CR777");
      });
    });
  });

  it("freezes the stamp at start — a later switch cannot re-attribute it", () => {
    withRegistration("acct-scope-e", "CR777", () => {
      // The user switches accounts while the bot keeps trading the old one.
      runWithSessionId("acct-scope-e", () => noteBotAccount("CR999"));
      assert.equal(
        entryFor("acct-scope-e")?.accountLoginId,
        "CR777",
        "a running bot must stay attributed to the account it is trading",
      );
    });
  });
});

describe("routes stamp the account on every start", () => {
  it("stamps before each engine startSession call", () => {
    const starts = [...ROUTES_SRC.matchAll(/await\s+(\w+)\.startSession\(/g)];
    assert.ok(starts.length >= 4, "the arena starts several engines; the guard must cover them");
    for (const [index, match] of starts.entries()) {
      const before = ROUTES_SRC.slice(Math.max(0, match.index! - 700), match.index!);
      assert.match(
        before,
        /await stampActiveAccount\(req\.sessionId\)/,
        `${match[1]}.startSession (#${index + 1}) must be preceded by stampActiveAccount()`,
      );
    }
  });

  it("stamps before the generic specialist start as well", () => {
    const at = ROUTES_SRC.indexOf("await startSession(config)");
    assert.ok(at > 0, "the generic specialist route must still call startSession");
    const before = ROUTES_SRC.slice(Math.max(0, at - 700), at);
    assert.match(before, /await stampActiveAccount\(req\.sessionId\)/);
  });

  it("reports a scope for every live entry and masks other sessions", () => {
    assert.match(ROUTES_SRC, /scope:\s*botAccountScope\(accountLoginId,\s*activeAccount\)/);
    assert.match(ROUTES_SRC, /scope:\s*"other-session"/);
    // A foreign session's entry must never carry that session's login id.
    assert.match(ROUTES_SRC, /account:\s*null,\s*scope:\s*"other-session"/);
  });

  it("scopes the catalogue and /status to the connected account", () => {
    assert.match(ROUTES_SRC, /const activeAccount = await activeAccountLoginId\(req\.sessionId\)/);
    assert.match(ROUTES_SRC, /isOwnAccountScope\(botAccountScope\(b\.accountLoginId, activeAccount\)\)/);
    assert.match(ROUTES_SRC, /ownedByThisAccount/);
  });
});

describe("exactly one bot-status popup", () => {
  it("has a single component, driven by the account-scoped live registry", () => {
    const popup = readFileSync(resolve(WEB, "components/bot-status-popup.tsx"), "utf8");
    for (const helper of ["ownAccountBot", "otherAccountBot", "otherSessionBot"]) {
      assert.match(popup, new RegExp(helper), `the popup must classify bots with ${helper}()`);
    }
    assert.match(popup, /No bot running/, "the popup owns the idle state");
    assert.match(popup, /useLiveBotsState/, "the popup must read the shared live poll");
  });

  it("removed the old separate floating indicator", () => {
    assert.equal(
      existsSync(resolve(WEB, "components/live-bot-indicator.tsx")),
      false,
      "live-bot-indicator.tsx was replaced by bot-status-popup.tsx — do not reintroduce a second popup",
    );
  });

  it("renders the SAME popup in the layout and in the Bot Arena", () => {
    const layout = readFileSync(resolve(WEB, "components/layout.tsx"), "utf8");
    const bots = readFileSync(resolve(WEB, "pages/bots.tsx"), "utf8");
    assert.match(layout, /<BotStatusPopup\s*\/>/, "the desktop popup must be the shared component");
    assert.match(layout, /<BotStatusPopup\s+compact\s*\/>/, "the mobile popup must be the shared component");
    assert.match(bots, /<BotStatusPopup\s+showIdle\s*\/>/, "the arena must use the shared popup (idle state included)");
    assert.doesNotMatch(bots, /No bot running/, "the arena must not keep a second, separate idle chip");
  });

  it("polls the live registry once for the whole app", () => {
    const app = readFileSync(resolve(WEB, "App.tsx"), "utf8");
    const layout = readFileSync(resolve(WEB, "components/layout.tsx"), "utf8");
    const live = readFileSync(resolve(WEB, "lib/live-bots.tsx"), "utf8");
    assert.match(app, /<LiveBotsProvider>/, "one poll must feed both the layout and the arena");
    assert.match(layout, /useLiveBotsState\(\)/);
    assert.doesNotMatch(layout, /useLiveBots\(\)/, "the layout must read the provider's poll, not start its own");
    assert.match(live, /\/api\/bots\/live/, "the one poll must hit the account-scoped endpoint");
  });
});
