import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, schemaReady, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  describeFeedHold,
  emptyFeedDiagnosis,
  requestHedgeCycle,
  type HedgeContext,
  type HedgeHost,
  type HedgePublish,
} from "./cycle";
import { AUTONOMOUS_HEDGE_PREFIX } from "./constants";
import { runWithSession } from "../session";

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
      normalUnderDigit: 7, recoveryOverDigit: 4, recoveryUnderDigit: 5, recoveryMethod: "split",
      recoveryMultiplier: 1.5, recoveryAutoMode: true, maxRecoverySteps: 3,
    },
    consecutiveLossLimit: 3,
    cooldownMinutes: 30,
    allowedMarketSymbols: ["R_100"],
    paperTradeMode: true,
    daily: { ...DAILY },
  };
}

function fakeHost(sessionId: string) {
  const counters = { canExecute: 0, loadContext: 0 };
  const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
  const published: HedgePublish[] = [];
  const stops: string[] = [];
  const host: HedgeHost = {
    sessionId,
    isRunning: () => true,
    canExecute: () => { counters.canExecute++; return true; },
    stop: (reason) => { stops.push(reason); },
    emit: (event, data) => { emitted.push({ event, data }); },
    publish: (patch) => { published.push(patch); },
    loadContext: async () => { counters.loadContext++; await new Promise((r) => setTimeout(r, 30)); return context(); },
    afterSettlement: () => undefined,
  };
  return { host, counters, emitted, published, stops };
}

async function settle(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  // Give a coalesced follow-up cycle time to start and finish.
  await new Promise((r) => setTimeout(r, 300));
}

describe("autonomous 1-tick cycle (tick-driven, coalesced)", () => {
  it("coalesces ticks that arrive while a cycle is running into exactly one follow-up cycle", async () => {
    const sessionId = randomUUID();
    const { host, counters } = fakeHost(sessionId);
    runWithSession(sessionId, () => {
      for (let i = 0; i < 5; i++) requestHedgeCycle(host);
    });
    await settle(() => counters.canExecute >= 2);
    assert.equal(counters.canExecute, 2, "one running cycle plus one coalesced follow-up, not five");
  });

  it("does not run a cycle when the engine is stopped", async () => {
    const sessionId = randomUUID();
    const { host, counters } = fakeHost(sessionId);
    host.isRunning = () => false;
    runWithSession(sessionId, () => requestHedgeCycle(host));
    await settle(() => false, 100);
    assert.equal(counters.canExecute, 0);
    assert.equal(counters.loadContext, 0);
  });

  it("stops ranking when the ownership check fails", async () => {
    const sessionId = randomUUID();
    const { host, counters } = fakeHost(sessionId);
    host.canExecute = () => { counters.canExecute++; return false; };
    runWithSession(sessionId, () => requestHedgeCycle(host));
    await settle(() => counters.canExecute >= 1, 500);
    assert.equal(counters.loadContext, 0, "no context is read when this engine may not execute");
  });

  it("never trades without a usable feed: no candidates, no trade events", async () => {
    const sessionId = randomUUID();
    const { host, emitted, stops } = fakeHost(sessionId);
    runWithSession(sessionId, () => requestHedgeCycle(host));
    await settle(() => emitted.length > 0 || stops.length > 0, 1000);
    assert.equal(emitted.some((e) => e.event === "trade_started" || e.event === "trade_completed"), false);
  });

  it("never goes silent without a usable feed: HOLD scan_complete names the feed cause", async () => {
    const sessionId = randomUUID();
    const { host, emitted } = fakeHost(sessionId);
    runWithSession(sessionId, () => requestHedgeCycle(host));
    await settle(() => emitted.some((e) => e.event === "scan_complete"), 5000);
    // The scanning pulse the dashboard's tournament view runs on.
    assert.equal(emitted.some((e) => e.event === "scan_started"), true, "a cycle that evaluates the contest emits scan_started");
    const holds = emitted.filter((e) => e.event === "scan_complete");
    assert.ok(holds.length >= 1, "a cycle that ranks nothing still emits scan_complete");
    for (const hold of holds) {
      assert.equal(hold.data["shouldTrade"], false);
      assert.equal(typeof hold.data["rejectReason"], "string");
      assert.match(
        String(hold.data["rejectReason"]),
        /no ticks received|simulated|stale|warming up|no tradeable contracts|no candidates ranked/i,
        "the HOLD names the feed cause instead of leaving the UI reasonless",
      );
    }
    assert.equal(emitted.some((e) => e.event === "trade_started" || e.event === "trade_completed"), false);
  });

  it("exposure gate emits a settling HOLD instead of going silent", async () => {
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
    }).returning({ id: tradesTable.id });
    try {
      const { host, emitted } = fakeHost(sessionId);
      runWithSession(sessionId, () => requestHedgeCycle(host));
      await settle(() => emitted.some((e) => e.event === "scan_complete"), 5000);
      const holds = emitted.filter((e) => e.event === "scan_complete");
      assert.ok(holds.length >= 1, "a gated cycle still emits scan_complete");
      for (const hold of holds) {
        assert.equal(hold.data["shouldTrade"], false);
        assert.match(
          String(hold.data["rejectReason"] ?? ""),
          /settling previous 1-tick trade on R_100/,
          "the HOLD names the unsettled exposure instead of leaving the UI reasonless",
        );
      }
      // Nothing was evaluated while gated, so no scanning pulse is claimed.
      assert.equal(emitted.some((e) => e.event === "scan_started"), false);
      assert.equal(emitted.some((e) => e.event === "trade_started" || e.event === "trade_completed"), false);
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.id, row.id));
    }
  });
});

describe("describeFeedHold", () => {
  it("names each feed failure distinctly", () => {
    assert.match(describeFeedHold(emptyFeedDiagnosis(0), false), /no markets are enabled/);
    assert.match(
      describeFeedHold({ ...emptyFeedDiagnosis(19), missing: 19 }, false),
      /no ticks received yet on any of the 19 watched markets/,
    );
    assert.match(
      describeFeedHold({ ...emptyFeedDiagnosis(19), simSkipped: 19 }, false),
      /simulated ticks.*Paper Trade Mode/,
    );
    // Paper mode consumes the simulated feed, so it must never blame it.
    assert.doesNotMatch(
      describeFeedHold({ ...emptyFeedDiagnosis(19), simSkipped: 0, stale: 19 }, true),
      /Paper Trade Mode/,
    );
    assert.match(
      describeFeedHold({ ...emptyFeedDiagnosis(19), stale: 19 }, true),
      /waiting for fresh ticks/,
    );
    assert.match(
      describeFeedHold({ ...emptyFeedDiagnosis(19), fresh: 5, simulated: 5, thin: 5 }, true),
      /warming up/,
    );
    assert.match(
      describeFeedHold({ ...emptyFeedDiagnosis(19), fresh: 5, live: 5, noSpecs: 5 }, true),
      /no tradeable contracts/,
    );
  });
});
