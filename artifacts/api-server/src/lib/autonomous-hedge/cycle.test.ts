import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { schemaReady } from "@workspace/db";
import { requestHedgeCycle, type HedgeContext, type HedgeHost, type HedgePublish } from "./cycle";
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

function fakeHost(sessionId: string, suppliedContext: HedgeContext = context()) {
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
    loadContext: async () => { counters.loadContext++; await new Promise((r) => setTimeout(r, 30)); return suppliedContext; },
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

  it("lets the cooldown setting bypass only the consecutive-loss pause", async () => {
    const disabledSession = randomUUID();
    const disabledContext = context();
    disabledContext.settings.cooldownEnabled = false;
    disabledContext.daily.consecutiveLosses = disabledContext.consecutiveLossLimit;
    const disabled = fakeHost(disabledSession, disabledContext);
    runWithSession(disabledSession, () => requestHedgeCycle(disabled.host));
    await settle(() => disabled.counters.loadContext > 0);
    assert.deepEqual(disabled.stops, [], "disabling cooldown should not stop on the streak threshold");

    const enabledSession = randomUUID();
    const enabledContext = context();
    // Omitted settings preserve the historical default: cooldown enabled.
    enabledContext.daily.consecutiveLosses = enabledContext.consecutiveLossLimit;
    const enabled = fakeHost(enabledSession, enabledContext);
    runWithSession(enabledSession, () => requestHedgeCycle(enabled.host));
    await settle(() => enabled.stops.length > 0);
    assert.match(enabled.stops[0], /consecutive losses/i, "the default-enabled cooldown still stops at the limit");

    const dailyStopSession = randomUUID();
    const dailyStopContext = context();
    dailyStopContext.settings.cooldownEnabled = false;
    dailyStopContext.daily.profit = -dailyStopContext.settings.dailyLossLimit;
    const dailyStop = fakeHost(dailyStopSession, dailyStopContext);
    runWithSession(dailyStopSession, () => requestHedgeCycle(dailyStop.host));
    await settle(() => dailyStop.stops.length > 0);
    assert.match(dailyStop.stops[0], /daily loss limit/i, "disabling cooldown must not disable other hard risk stops");
  });
});
