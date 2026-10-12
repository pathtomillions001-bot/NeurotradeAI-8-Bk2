/**
 * WP7 — execution & ledger checks.
 *
 * Covers the seams the earlier work packages rely on:
 *  - re-base is ATOMIC with the durable ledger flush: a failed flush rolls the
 *    recovery state back and writes no REBASE row; a successful flush writes
 *    exactly one REBASE row for the realised debt;
 *  - the shadow-mode logger records legacy-vs-v2 per recovery tick without
 *    ever touching the trading path;
 *  - the exposure gate never lets a second buy fire while one trade is
 *    settling (double-fire guard).
 *
 * No stale-quote sizing and actual-buy-price recording are asserted by
 * recovery-payout.test.ts (WP2) and ledger.test.ts (durable-before-claim,
 * loss debt grows by the ACTUAL stake) respectively.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, schemaReady, tradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { runWithSession } from "./session";
import * as recoveryEngine from "./agents/recovery-engine";
import { executeRebase, requestHedgeCycle, type HedgeContext, type HedgeHost, type HedgePublish } from "./autonomous-hedge/cycle";
import { shadowLog } from "./autonomous-hedge/shadow-log";
import { AUTONOMOUS_HEDGE_PREFIX } from "./autonomous-hedge/constants";

before(async () => {
  await schemaReady;
});

const DAILY = { tradesCount: 0, wins: 0, losses: 0, profit: 0, consecutiveLosses: 0, consecutiveWins: 0 };

function context(): HedgeContext {
  return {
    balance: 1000,
    currency: "USD",
    token: null,
    derivAccountId: null,
    settings: {
      riskAmountType: "fixed", riskAmountValue: 1, maxRiskPerTrade: 2, minConfidenceThreshold: 38,
      riskProfile: "moderate", preferredContractTypes: ["CALL", "PUT"], tradeDurationSec: 5,
      maxTradeStake: 500, dailyLossLimit: 30, dailyTarget: 50, consecutiveLossLimit: 3,
      maxDrawdown: 20, requirePositiveEv: true, paperTradeMode: true, normalOverDigit: 2,
      normalUnderDigit: 7, recoveryOverDigit: 4, recoveryUnderDigit: 5, recoveryMethod: "adaptive",
      recoveryMultiplier: 1.5, recoveryAutoMode: true, maxRecoverySteps: 3,
      recoveryBudgetBase: 25, recoveryHeadroomPct: 5,
    },
    consecutiveLossLimit: 3,
    cooldownMinutes: 30,
    cooldownEnabled: true,
    cooldownBehavior: "pause",
    allowedMarketSymbols: ["R_100"],
    paperTradeMode: true,
    daily: { ...DAILY },
  } as unknown as HedgeContext;
}

function fakeHost(sessionId: string) {
  const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
  const published: HedgePublish[] = [];
  const host: HedgeHost = {
    sessionId,
    isRunning: () => true,
    canExecute: () => true,
    stop: () => undefined,
    emit: (event, data) => { emitted.push({ event, data }); },
    publish: (patch) => { published.push(patch); },
    loadContext: async () => context(),
    afterSettlement: () => undefined,
  };
  return { host, emitted, published };
}

function seedDebt(sessionId: string, losses: number, stake = 1): number {
  return runWithSession(sessionId, () => {
    recoveryEngine.setPersistenceSession(sessionId);
    for (let i = 0; i < losses; i++) {
      recoveryEngine.recordOutcome(false, -stake, stake, 3, "DIGITEVEN", 1.95);
    }
    return recoveryEngine.getState().unrecoveredAmount;
  });
}

function stateOf(sessionId: string) {
  return runWithSession(sessionId, () => recoveryEngine.getState());
}

async function rebaseRows(sessionId: string) {
  return db.select().from(tradesTable).where(
    and(eq(tradesTable.sessionId, sessionId), eq(tradesTable.contractType, "REBASE")),
  );
}

describe("WP7: re-base atomicity", () => {
  it("a failed durable flush rolls the re-base back and writes nothing", async () => {
    const sessionId = randomUUID();
    const debt = seedDebt(sessionId, 4);
    assert.ok(debt > 0);
    const { host, emitted } = fakeHost(sessionId);

    await executeRebase(host, "R_100", context(), "budget", async () => false);

    const after = stateOf(sessionId);
    assert.equal(after.unrecoveredAmount, debt, "failed flush must restore the debt exactly");
    assert.equal(after.inRecovery, true, "failed flush must keep the engine in recovery");
    assert.equal((await rebaseRows(sessionId)).length, 0, "no REBASE row without a durable flush");
    assert.equal(emitted.filter((e) => e.event === "recovery_rebase").length, 0);
  });

  it("a successful flush writes exactly one REBASE row for the realised debt", async () => {
    const sessionId = randomUUID();
    const debt = seedDebt(sessionId, 5);
    const { host, emitted } = fakeHost(sessionId);

    await executeRebase(host, "R_100", context(), "budget", async () => true);

    const after = stateOf(sessionId);
    assert.equal(after.unrecoveredAmount, 0, "re-base clears the debt");
    assert.equal(after.inRecovery, false, "re-base ends the recovery episode");
    const rows = await rebaseRows(sessionId);
    assert.equal(rows.length, 1, "exactly one REBASE ledger row");
    assert.equal(Number(rows[0].profit), -Math.round(debt * 100) / 100, "the row realises the exact debt as a loss");
    assert.equal(Number(rows[0].stake), 0);
    assert.equal(rows[0].direction, "neutral");
    const ev = emitted.find((e) => e.event === "recovery_rebase");
    assert.ok(ev, "the re-base is announced to the dashboard");
    assert.equal(ev!.data["debt"], debt);
  });

  it("re-basing with no debt is a no-op", async () => {
    const sessionId = randomUUID();
    const { host } = fakeHost(sessionId);
    await executeRebase(host, "R_100", context(), "budget", async () => {
      throw new Error("flush must not run when there is nothing to re-base");
    });
    assert.equal((await rebaseRows(sessionId)).length, 0);
  });
});

describe("WP7: shadow logger", () => {
  it("records legacy vs v2 side by side and scores agreement", () => {
    shadowLog.clear();
    const sid = randomUUID();
    shadowLog.record({
      sessionId: sid, mode: "RECOVERY", lossRun: 2,
      legacy: { contract: "DIGITEVEN:-1", symbol: "R_100", eligible: true, reason: "READY legacy" },
      v2: { contract: "DIGITDIFF:4", symbol: "R_100", eligible: true, reason: "READY v2" },
    });
    shadowLog.record({
      sessionId: sid, mode: "RECOVERY", lossRun: 3,
      legacy: { contract: null, symbol: null, eligible: false, reason: "cooldown" },
      v2: { contract: "DIGITEVEN:-1", symbol: "R_100", eligible: true, reason: "READY v2" },
    });
    shadowLog.record({
      sessionId: sid, mode: "RECOVERY", lossRun: 4,
      legacy: null,
      v2: null,
    });
    const s = shadowLog.summary(sid);
    assert.equal(s.ticks, 3);
    assert.equal(s.legacyTrades, 1);
    assert.equal(s.v2Trades, 2);
    assert.equal(s.agrees, 2, "tick 1 (both trade) and tick 3 (neither trades) agree; tick 2 differs");
    const recent = shadowLog.recent(10, sid);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].lossRun, 4, "newest first");
  });

  it("is bounded: the ring never grows past its capacity", () => {
    shadowLog.clear();
    const sid = randomUUID();
    for (let i = 0; i < 1500; i++) {
      shadowLog.record({
        sessionId: sid, mode: "RECOVERY", lossRun: i,
        legacy: { contract: "DIGITEVEN:-1", symbol: "R_100", eligible: true, reason: "x" },
        v2: { contract: "DIGITEVEN:-1", symbol: "R_100", eligible: true, reason: "y" },
      });
    }
    assert.equal(shadowLog.recent(2000, sid).length, 1000);
    assert.equal(shadowLog.summary(sid).ticks, 1500, "counters survive the ring trim");
    shadowLog.clear();
  });

  it("is a pure recorder: recording never returns a tradable object", () => {
    shadowLog.clear();
    const entry = shadowLog.record({
      sessionId: "s", mode: "RECOVERY", lossRun: 0,
      legacy: null,
      v2: { contract: "CALL:-1", symbol: "R_100", eligible: true, reason: "r" },
    });
    assert.equal(entry.agreesOnAction, false);
    assert.ok(!("stake" in entry) && !("execute" in entry), "shadow records carry no execution power");
    shadowLog.clear();
  });
});

describe("WP7: double-fire guard", () => {
  it("an unsettled exposure holds every coalesced cycle — no second row is ever inserted", async () => {
    const sessionId = randomUUID();
    const [row] = await db.insert(tradesTable).values({
      sessionId,
      symbol: "R_100",
      displayName: "Volatility 100 Index",
      contractType: "CALL",
      stake: "1",
      direction: "up",
      status: "open",
      isAutonomous: true,
      agentReasoning: `${AUTONOMOUS_HEDGE_PREFIX}READY CALL on R_100 (test exposure)`,
    }).returning();
    try {
      const { host, emitted } = fakeHost(sessionId);
      runWithSession(sessionId, () => {
        for (let i = 0; i < 6; i++) requestHedgeCycle(host);
      });
      // Wait for the coalesced cycles to drain.
      await new Promise((r) => setTimeout(r, 800));
      const holds = emitted.filter((e) => e.event === "scan_complete");
      assert.ok(holds.length >= 1, "gated cycles still report");
      for (const h of holds) {
        assert.equal(h.data["shouldTrade"], false);
        assert.match(String(h.data["rejectReason"] ?? ""), /settling previous 1-tick trade/);
      }
      assert.equal(emitted.some((e) => e.event === "trade_started"), false, "no second buy fires");
      const rows = await db.select().from(tradesTable).where(eq(tradesTable.sessionId, sessionId));
      assert.equal(rows.length, 1, "exactly the seeded row — no duplicate buy inserted");
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.id, row.id));
    }
  });
});
