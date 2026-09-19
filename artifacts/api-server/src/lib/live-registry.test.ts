import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listLiveBots,
  registerLiveBot,
  unregisterLiveBot,
} from "./live-registry";
import { runWithSessionId } from "./session";

// The registry closes the "invisible background bot" gap: engine state is
// session-scoped (createSessionScoped resolves against the ambient session),
// so an engine running for session A is invisible to a request from session
// B. Registrations are probed under the OWNING session's context, so a poll
// from any session sees every engine that is actually running.

test("listLiveBots sees a bot registered under another session's context", () => {
  const key = "unit-test-bot-1";
  let running = true;

  runWithSessionId("session-A", () =>
    registerLiveBot(key, () => ({ running, botId: "unitbot", botName: "Unit Bot" })),
  );

  try {
    // Polled from the ambient "legacy" context (no request) — it must still
    // be visible, and attributed to its owning session.
    const live = listLiveBots();
    const mine = live.find(e => e.status.botId === "unitbot");
    assert.ok(mine, "the bot must be visible from a non-owning context");
    assert.equal(mine!.ownerSessionId, "session-A");
    assert.equal(mine!.status.running, true);
  } finally {
    unregisterLiveBot(key);
  }
});

test("a bot whose status stops running is cleaned up on the next poll", () => {
  const key = "unit-test-bot-2";
  let running = true;

  runWithSessionId("session-B", () =>
    registerLiveBot(key, () => ({ running, botId: "unitbot2", botName: "Unit Bot 2" })),
  );

  try {
    assert.equal(listLiveBots().find(e => e.status.botId === "unitbot2")?.ownerSessionId, "session-B");
    running = false; // the engine's stop path
    const after = listLiveBots();
    assert.equal(after.find(e => e.status.botId === "unitbot2"), undefined, "stopped bots must not stay listed");
    // And the stale registration is dropped — registering the same key
    // again with a live status must work.
    running = true;
    runWithSessionId("session-B", () =>
      registerLiveBot(key, () => ({ running, botId: "unitbot2", botName: "Unit Bot 2" })),
    );
    assert.ok(listLiveBots().find(e => e.status.botId === "unitbot2"));
  } finally {
    unregisterLiveBot(key);
  }
});

test("unregisterLiveBot removes the entry immediately", () => {
  const key = "unit-test-bot-3";
  runWithSessionId("session-C", () =>
    registerLiveBot(key, () => ({ running: true, botId: "unitbot3", botName: "Unit Bot 3" })),
  );
  runWithSessionId("session-C", () => unregisterLiveBot(key));
  assert.equal(listLiveBots().find(e => e.status.botId === "unitbot3"), undefined);
});
