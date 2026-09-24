/**
 * Bot-engine session isolation — regression tests for the reported bug:
 *
 *   "If user A enables the NeuroAI Quantum FAB and, while it is still running,
 *    user B enables the same bot, the FAB stops in A's account and starts running
 *    in B's account."
 *
 * Two connected Deriv accounts are two account-scoped browser sessions. Every bot
 * engine keeps its state through createSessionScoped() (lib/session.ts), the
 * trading arbiter is per session, and so is the shared recovery ledger. These
 * tests pin that contract for the FAB's engine state and for the recovery ledger
 * (the "recovery journal" the FAB must read before it trades).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { schemaReady } from "@workspace/db";
import { runWithSessionId } from "./session.ts";
import {
  getOwnerSessionId,
  getStatus,
  startSession,
  stopSession,
  type SpeedAIConfig,
} from "./speed-ai-engine.ts";
import * as recoveryEngine from "./agents/recovery-engine.ts";

// The database DDL runs at module load; the engine loops read accounts/settings
// rows, so wait for the schema before starting a session.
await schemaReady;

const SESSION_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const SESSION_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const SESSION_C = "cccccccc-0000-4000-8000-00000000000c";

function fabConfig(ownerSessionId: string): SpeedAIConfig {
  return {
    ownerSessionId,
    normalContractTypes: ["DIGITOVER", "DIGITUNDER"],
    normalBarriers: [1, 8],
    recoveryContractTypes: ["DIGITOVER", "DIGITUNDER"],
    recoveryBarriers: [4, 5],
    stake: 1,
    stopLoss: 5,
    takeProfit: 10,
    recoveryAutoMode: true,
    recoveryMultiplier: 1.62,
    recoveryMethod: "instant",
    maxRecoverySteps: 3,
    marketMode: "switching",
  };
}

describe("NeuroAI FAB — one engine state per account session", () => {
  it("runs two accounts concurrently and stopping one never stops the other", async () => {
    const a = await runWithSessionId(SESSION_A, () => startSession(fabConfig(SESSION_A)));
    assert.equal(a.ok, true, a.error ?? "account A failed to start");

    const b = await runWithSessionId(SESSION_B, () => startSession(fabConfig(SESSION_B)));
    assert.equal(b.ok, true, b.error ?? "account B failed to start");

    // The exact reported failure: B's start must not have stopped A.
    assert.equal(runWithSessionId(SESSION_A, () => getStatus().running), true, "A stopped when B started");
    assert.equal(runWithSessionId(SESSION_B, () => getStatus().running), true, "B did not start");
    assert.equal(runWithSessionId(SESSION_A, () => getOwnerSessionId()), SESSION_A);
    assert.equal(runWithSessionId(SESSION_B, () => getOwnerSessionId()), SESSION_B);

    // And a stop must be scoped to its own account too.
    runWithSessionId(SESSION_B, () => stopSession());
    assert.equal(runWithSessionId(SESSION_B, () => getStatus().running), false);
    assert.equal(runWithSessionId(SESSION_A, () => getStatus().running), true, "stopping B killed A");

    runWithSessionId(SESSION_A, () => stopSession());
    assert.equal(runWithSessionId(SESSION_A, () => getStatus().running), false);
  });

  it("refuses a second FAB for the SAME account instead of silently replacing it", async () => {
    const first = await runWithSessionId(SESSION_A, () => startSession(fabConfig(SESSION_A)));
    assert.equal(first.ok, true, first.error ?? "first start failed");

    const second = await runWithSessionId(SESSION_A, () => startSession(fabConfig(SESSION_A)));
    assert.equal(second.ok, false);
    assert.match(String(second.error), /already active/i);
    // The running session survived the rejected start untouched.
    assert.equal(runWithSessionId(SESSION_A, () => getStatus().running), true);

    runWithSessionId(SESSION_A, () => stopSession());
  });
});

describe("shared recovery ledger — one ledger per account", () => {
  it("hydrates a persisted ledger for the trading account only", async () => {
    const persisted = runWithSessionId(SESSION_A, () => {
      // A $5 loss puts account A into recovery with $5 of debt.
      recoveryEngine.recordOutcome(false, -5, 5, 3, "DIGITOVER", 2);
      const json = recoveryEngine.serializeState();
      recoveryEngine.resetAll();
      return json;
    });
    assert.match(persisted, /"inRecovery":true/);
    assert.match(persisted, /"unrecoveredAmount":5/);

    // A brand-new session (a fresh engine start / restart) restores it…
    // NOTE: the ledger is addressed by the AMBIENT session, so every read must
    // happen inside that session's context — that is exactly the guarantee under
    // test.
    const restored = runWithSessionId(SESSION_B, () => {
      recoveryEngine.hydrateStateIfNeeded(persisted);
      const state = recoveryEngine.getState();
      return { inRecovery: state.inRecovery, unrecoveredAmount: state.unrecoveredAmount };
    });
    assert.equal(restored.inRecovery, true, "persisted debt was not restored");
    assert.equal(restored.unrecoveredAmount, 5);

    // …and sizes the recovery stake off that debt, not the base stake.
    const stake = runWithSessionId(SESSION_B, () =>
      recoveryEngine.getDynamicRecoveryStake(1, 100, 100, 2, 0.5, "moderate", 1.62, "instant", 3, true),
    );
    assert.ok(stake > 1, `expected a debt-driven recovery stake, got ${stake}`);

    // A third account's ledger never sees any of it.
    const untouched = runWithSessionId(SESSION_C, () => {
      const state = recoveryEngine.getState();
      return { inRecovery: state.inRecovery, unrecoveredAmount: state.unrecoveredAmount };
    });
    assert.equal(untouched.inRecovery, false);
    assert.equal(untouched.unrecoveredAmount, 0);

    runWithSessionId(SESSION_A, () => recoveryEngine.resetAll());
    runWithSessionId(SESSION_B, () => recoveryEngine.resetAll());
  });
});
