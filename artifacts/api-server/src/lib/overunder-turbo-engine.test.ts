/**
 * Over/Under Turbo — per-account session isolation.
 *
 * The user requirement this pins: "ensure that this bot is not shared and works
 * independently in the connected user account like other AI Bots in the bot
 * arena currently work without interfering with another user account if they
 * use the same bot at same time."
 *
 * Two connected Deriv accounts are two account-scoped browser sessions. Both may
 * run Over/Under Turbo at the same time; starting or stopping one must never
 * start, stop or read the other. Mirrors bot-session-isolation.test.ts for the
 * NeuroAI FAB.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { schemaReady } from "@workspace/db";
import { runWithSessionId } from "./session.ts";
import {
  TURBO_BOT_ID,
  getOwnerSessionId,
  getStatus,
  isRunning,
  startSession,
  stopSession,
  type TurboConfig,
} from "./overunder-turbo-engine.ts";

// The database DDL runs at module load; wait for it before starting sessions.
await schemaReady;

const SESSION_A = "turboaaaa-0000-4000-8000-00000000000a";
const SESSION_B = "turbobbbb-0000-4000-8000-00000000000b";
const SESSION_C = "turbocccc-0000-4000-8000-00000000000c";

function turboConfig(ownerSessionId: string): TurboConfig {
  return {
    ownerSessionId,
    symbol: "R_10",
    displayName: "Volatility 10 Index",
    normal: { side: "DIGITOVER", barrier: 1 },
    recovery: { side: "DIGITUNDER", barrier: 5 },
    marketMode: "locked",
    stake: 1,
    stopLoss: 5,
    takeProfit: 10,
    maxRecoverySteps: 3,
  };
}

describe("Over/Under Turbo — one engine state per account session", () => {
  it("runs two accounts concurrently and stopping one never stops the other", async () => {
    const a = await runWithSessionId(SESSION_A, () => startSession(turboConfig(SESSION_A)));
    assert.equal(a.ok, true, a.error ?? "account A failed to start");
    try {
      const b = await runWithSessionId(SESSION_B, () => startSession(turboConfig(SESSION_B)));
      assert.equal(b.ok, true, b.error ?? "account B failed to start");
      try {
        // The exact reported failure class: B's start must not have stopped A.
        assert.equal(
          runWithSessionId(SESSION_A, () => isRunning()),
          true,
          "A stopped when B started",
        );
        assert.equal(
          runWithSessionId(SESSION_B, () => isRunning()),
          true,
          "B did not start",
        );
        assert.equal(runWithSessionId(SESSION_A, () => getOwnerSessionId()), SESSION_A);
        assert.equal(runWithSessionId(SESSION_B, () => getOwnerSessionId()), SESSION_B);

        // A third account sees NEITHER session (strict isolation of status too).
        const cView = runWithSessionId(SESSION_C, () => getStatus());
        assert.equal(cView.running, false, "account C must not see another account's session");

        // A stop is scoped to its own account.
        runWithSessionId(SESSION_B, () => stopSession());
        assert.equal(runWithSessionId(SESSION_B, () => isRunning()), false);
        assert.equal(
          runWithSessionId(SESSION_A, () => isRunning()),
          true,
          "stopping B killed A",
        );
      } finally {
        runWithSessionId(SESSION_B, () => stopSession());
      }
    } finally {
      runWithSessionId(SESSION_A, () => stopSession());
    }
    assert.equal(runWithSessionId(SESSION_A, () => isRunning()), false);
  });

  it("refuses a second Turbo for the SAME account instead of silently replacing it", async () => {
    const first = await runWithSessionId(SESSION_A, () => startSession(turboConfig(SESSION_A)));
    assert.equal(first.ok, true, first.error ?? "first start failed");
    try {
      const second = await runWithSessionId(SESSION_A, () => startSession(turboConfig(SESSION_A)));
      assert.equal(second.ok, false);
      assert.match(String(second.error), /already active/i);
      assert.equal(runWithSessionId(SESSION_A, () => isRunning()), true);
    } finally {
      runWithSessionId(SESSION_A, () => stopSession());
    }
  });

  it("rejects contracts outside the fixed barrier sets", async () => {
    const bad = await runWithSessionId(SESSION_C, () =>
      startSession({
        ...turboConfig(SESSION_C),
        normal: { side: "DIGITOVER", barrier: 5 }, // not in Over 1/2, Under 7/8
      }),
    );
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /Over 1, Over 2, Under 7 or Under 8/i);

    const badRecovery = await runWithSessionId(SESSION_C, () =>
      startSession({
        ...turboConfig(SESSION_C),
        recovery: { side: "DIGITUNDER", barrier: 8 }, // not in Over 4/5, Under 4/5
      }),
    );
    assert.equal(badRecovery.ok, false);
    assert.match(String(badRecovery.error), /Over 4, Over 5, Under 4 or Under 5/i);
  });
});
