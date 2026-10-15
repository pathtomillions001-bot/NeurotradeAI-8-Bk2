import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, schemaReady, tradesTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  clearRefusedLiveAttempt,
  describeFeedHold,
  emptyFeedDiagnosis,
  liveAttemptHoldReason,
  LIVE_REFUSAL_BACKOFF_MS,
  newLiveAttemptGate,
  recordRefusedLiveAttempt,
  requestHedgeCycle,
  resetHedgeSession,
  type HedgeContext,
  type HedgeHost,
  type HedgePublish,
} from "./cycle";
import { AUTONOMOUS_HEDGE_PREFIX, mulberry32, setRecoveryV2ModeOverride } from "./constants";
import { runWithSession } from "../session";
import { tickManager, getAccountConnection, closeAccountConnections } from "../deriv";
import { DigitTape } from "../digit-tape";
import { EvidenceTracker } from "./evidence";
import { clearPrefetchedQuotes } from "./quote-prefetch";
import * as recoveryEngine from "../agents/recovery-engine";

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
      maxDrawdown: 20, requirePositiveEv: true, normalOverDigit: 2,
      normalUnderDigit: 7, recoveryOverDigit: 4, recoveryUnderDigit: 5, recoveryMethod: "split",
      recoveryMultiplier: 1.5, recoveryAutoMode: true, maxRecoverySteps: 3,
    },
    consecutiveLossLimit: 3,
    cooldownMinutes: 30,
    cooldownEnabled: true,
    allowedMarketSymbols: ["R_100"],
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
    stopAndResume: (reason) => { stops.push(reason); },
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
    const { host, emitted, published } = fakeHost(sessionId);
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
      // The hold announces its own ceiling, so the wait is never open-ended.
      assert.match(String(holds[0].data["rejectReason"]), /holds at most 30m/);
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.id, row.id));
    }
  });

  it("releases a gate held past the maximum and resumes evaluating (never deadlocks)", async () => {
    const sessionId = randomUUID();
    // A row Deriv never confirmed, ~31 minutes old: exactly the production
    // deadlock (a held exposure whose contract the reconciler could not see).
    const createdAt = new Date(Date.now() - 31 * 60 * 1000);
    const [row] = await db.insert(tradesTable).values({
      sessionId,
      symbol: "R_100",
      displayName: "Volatility 100 Index",
      contractType: "CALL",
      stake: "1",
      direction: "up",
      status: "open",
      derivContractId: "99112233",
      isAutonomous: true,
      agentReasoning: `${AUTONOMOUS_HEDGE_PREFIX}READY CALL on R_100 (stale exposure)`,
      createdAt,
    }).returning({ id: tradesTable.id });
    try {
      const { host, emitted } = fakeHost(sessionId);
      runWithSession(sessionId, () => requestHedgeCycle(host));
      await settle(() => emitted.some((e) => e.event === "scan_started"), 5000);

      const released = emitted.find((e) => e.event === "exposure_released");
      assert.ok(released, "the gate announces its release instead of holding forever");
      assert.equal(released.data["id"], row.id);
      assert.ok(
        Number(released.data["heldMinutes"]) >= 30,
        "the release names how long the exposure was held",
      );

      // The engine is TRADING again: it evaluated the contest this cycle.
      assert.equal(
        emitted.some((e) => e.event === "scan_started"),
        true,
        "a released gate lets the cycle reach the contest instead of returning early",
      );

      // The row itself is untouched: still open, still the reconciler's job, so
      // a late Deriv confirmation is still recorded exactly once in the ledger.
      const [after] = await db.select().from(tradesTable).where(eq(tradesTable.id, row.id)).limit(1);
      assert.equal(after.status, "open", "the row is released from the gate, not dropped from the ledger");
      assert.match(String(after.agentReasoning), /GATE RELEASED after 31m/);
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.id, row.id));
    }
  });
});

// A refused 1-tick buy used to be re-attempted by the very next coalesced tick —
// same tape, same decision, same refusal — so three refusals landed inside a
// second and the engine stopped with "Deriv rejected 3 consecutive 1-tick buys".
// That looks like three simultaneous trades; it was ONE trade re-sent three
// times. The gate makes every attempt a newly analysed, newly timed decision.
describe("live attempt gate (one analysed trade per attempt)", () => {
  const decision = { symbol: "R_100", tickSequence: 42 };

  it("lets the first attempt through", () => {
    assert.equal(liveAttemptHoldReason(newLiveAttemptGate(), decision, 1_000), null);
  });

  it("refuses to re-send the exact tick the broker just refused", () => {
    const gate = newLiveAttemptGate();
    recordRefusedLiveAttempt(gate, decision, 1_000);
    // Backoff elapsed, but the tape has not produced a new tick: the same
    // analysed decision must not be bought again.
    const reason = liveAttemptHoldReason(gate, decision, 1_000 + LIVE_REFUSAL_BACKOFF_MS + 1);
    assert.match(String(reason), /already refused/);
  });

  it("holds every attempt during the backoff, and says how long it waits", () => {
    const gate = newLiveAttemptGate();
    recordRefusedLiveAttempt(gate, decision, 1_000);
    const reason = liveAttemptHoldReason(gate, { symbol: "R_50", tickSequence: 7 }, 1_500);
    assert.match(String(reason), /refused.*waits \d+s/);
  });

  it("allows the next freshly analysed tick once the backoff has passed", () => {
    const gate = newLiveAttemptGate();
    recordRefusedLiveAttempt(gate, decision, 1_000);
    const now = 1_000 + LIVE_REFUSAL_BACKOFF_MS + 1;
    assert.equal(
      liveAttemptHoldReason(gate, { symbol: "R_100", tickSequence: 43 }, now),
      null,
      "a new tick is a new decision — that attempt is allowed",
    );
  });

  it("releases the gate after a purchase that went through", () => {
    const gate = newLiveAttemptGate();
    recordRefusedLiveAttempt(gate, decision, 1_000);
    clearRefusedLiveAttempt(gate);
    assert.equal(liveAttemptHoldReason(gate, decision, 1_100), null);
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

// ── G9: paper mode is gone, and cannot come back ──────────────────────────────
describe("G9 — no simulated trade without a live account", () => {
  it("a full cycle with a usable live feed but no connected account journals nothing", async () => {
    const sessionId = randomUUID();
    const { host, emitted, published } = fakeHost(sessionId);

    // A real, usable LIVE feed: the tape checks pass, so the cycle runs all the way
    // to the money path. This is what makes the assertion meaningful — the engine
    // is not stopped early by a missing-feed HOLD.
    const tape = new DigitTape();
    for (let i = 0; i < 1600; i++) {
      tape.push({
        symbol: "R_100",
        digit: i % 10,
        price: 1000 + (i % 7) * 0.01,
        source: "live",
        epoch: 1_700_000_000 + i * 2,
        receivedAt: Date.now(),
      });
    }
    mock.method(tickManager, "getDigitSnapshot", (symbol: string, count?: number) =>
      tape.snapshot(symbol, count),
    );

    try {
      const ledgerBefore = runWithSession(sessionId, () => JSON.stringify(recoveryEngine.getState()));

      runWithSession(sessionId, () => requestHedgeCycle(host));
      await settle(() => emitted.some((e) => e.event === "scan_complete"), 5000);

      const rows = await db.select().from(tradesTable).where(eq(tradesTable.sessionId, sessionId));
      assert.equal(
        rows.length,
        0,
        "a cycle without a connected account must not create ANY trade row — the row used " +
          "to be the paper trade, settled from the engine's own belief or the next real tick",
      );

      const ledgerAfter = runWithSession(sessionId, () => JSON.stringify(recoveryEngine.getState()));
      assert.equal(
        ledgerAfter,
        ledgerBefore,
        "the shared recovery ledger must not move: a simulated outcome would corrupt the " +
          "debt the real ladder is later sized from",
      );

      // And it must say why it is waiting rather than going silent.
      const holds = emitted.filter((e) => e.event === "scan_complete");
      assert.ok(holds.length >= 1, "the cycle still reports a HOLD");
      assert.equal(
        emitted.some((e) => e.event === "trade_started" || e.event === "trade_completed"),
        false,
        "no trade events may be emitted without a live account",
      );

      // This deterministic tape is genuinely structured, so the analysis often DOES
      // say "should trade" — which is exactly the case that used to become a paper
      // trade. When it does, the no-live-account HOLD must be the thing that stops
      // it, and the loop must be parked rather than re-fired.
      const decisionWasEligible = holds.some((hold) => hold.data["shouldTrade"] === true);
      if (decisionWasEligible) {
        assert.ok(
          holds.some((hold) => /no live Deriv connection/i.test(String(hold.data["rejectReason"]))),
          "an eligible decision with no connected account must publish the no-live-account HOLD",
        );
        assert.ok(
          published.some((patch) => patch.nextScanIn === null),
          "the engine parks the scan instead of re-firing into a wall",
        );
      }
    } finally {
      mock.restoreAll();
    }
  });
});


// Exercise the real journal -> proposal -> buy -> settlement -> recovery ledger
// path. Only broker transports are mocked: no credentials, no actual money.
describe("recovery dispatch through a full autonomous cycle", () => {
  for (const scenario of ["structured edge", "replacement with worse J", "replacement expires during quote", "lost fresh tape", "no connected account"] as const) {
    it(scenario, async () => {
      const sessionId = randomUUID();
      const accountId = randomUUID();
      const token = "recovery-test-only-token";
      const { host, emitted, stops } = fakeHost(sessionId);
      const ctx = context();
      ctx.token = scenario === "no connected account" ? null : token;
      ctx.derivAccountId = accountId;
      ctx.contractSets = {
        normal: [{ type: "DIGITEVEN", digit: -1 }],
        recovery: scenario.startsWith("replacement")
          ? [{ type: "DIGITEVEN", digit: -1 }, { type: "DIGITMATCH", digit: 7 }]
          : [{ type: "DIGITEVEN", digit: -1 }],
      };
      const tape = new DigitTape();
      const rng = mulberry32(12345);
      for (let i = 0; i < 1500; i++) tape.push({
        symbol: "R_100", digit: rng() < 0.8 ? 2 : 1, price: 1000 + i * 0.01,
        source: "live", epoch: 1_700_000_000 + i * 2, receivedAt: Date.now(),
      });
      let contextReads = 0;
      host.loadContext = async () => { contextReads++; return ctx; };
      mock.method(tickManager, "getDigitSnapshot", (symbol: string, count?: number) =>
        scenario === "lost fresh tape" && contextReads >= 2 ? null : tape.snapshot(symbol, count));
      mock.method(tickManager, "request", async (m: any) => ({
        msg_type: "proposal", proposal: { id: "public-quote", ask_price: 1,
          payout: m.contract_type === "DIGITMATCH" ? 8.93 : 1.95 },
      }));
      const sent: any[] = [];
      let buyStake = 0;
      const connection = getAccountConnection(token, accountId);
      mock.method(connection, "request", async (m: any) => {
        sent.push(m);
        if (m.proposal) {
          buyStake = Number(m.amount);
          return { msg_type: "proposal", proposal: { id: "recovery-proposal", ask_price: buyStake,
            payout: buyStake * (m.contract_type === "DIGITMATCH" ? 8.93 : 1.95) } };
        }
        if (m.buy) return { msg_type: "buy", buy: { contract_id: 789123, buy_price: buyStake } };
        return { profit_table: { transactions: [{ contract_id: 789123, buy_price: buyStake,
          sell_price: buyStake * (scenario.startsWith("replacement") ? 8.93 : 1.95),
          purchase_time: 1_750_000_000, sell_time: 1_750_000_002 }] } };
      });
      if (scenario.startsWith("replacement")) {
        let evaluations = 0;
        mock.method(EvidenceTracker.prototype, "evaluate", () => {
          evaluations++;
          // Scan admits EVEN. During the quote await it loses its minimum edge,
          // while MATCH becomes admissible but still has a worse episode cost J.
          return (["DIGITEVEN", "DIGITMATCH"] as const).map(type => ({
            symbol: "R_100", spec: { type, barrier: type === "DIGITMATCH" ? 7 : -1 },
            resolvedBarrier: type === "DIGITMATCH" ? 7 : -1,
            p0: type === "DIGITMATCH" ? 0.1 : 0.5,
            pTilde: type === "DIGITMATCH" ? (evaluations === 1 || (scenario === "replacement expires during quote" && evaluations >= 3) ? 0.1 : 0.12)
              : (evaluations === 1 ? 0.65 : 0.514),
            z: 8, zTilde: 4, window: 1500, nEff: 1500, q: 0.99,
            depUsed: false, edgeIndex: 1, longestZ: 8, longestZTilde: 4, longestWindowTicks: 1500,
          }));
        });
      }
      setRecoveryV2ModeOverride("on");
      await db.insert(settingsTable).values({ sessionId });
      runWithSession(sessionId, () => {
        recoveryEngine.setPersistenceSession(sessionId);
        recoveryEngine.recordOutcome(false, -1, 1, 3, "DIGITEVEN", 1.95);
      });
      try {
        runWithSession(sessionId, () => requestHedgeCycle(host));
        await settle(() => emitted.some(e => e.event === "trade_completed" ||
          /RECOVERY HOLD|no live Deriv connection/.test(String(e.data.rejectReason))), 10000);
        const rows = await db.select().from(tradesTable).where(eq(tradesTable.sessionId, sessionId));
        assert.deepEqual(stops, []);
        if (scenario === "lost fresh tape" || scenario === "replacement expires during quote" || scenario === "no connected account") {
          assert.equal(rows.length, 0);
          assert.equal(sent.filter(m => m.buy).length, 0);
          const reason = scenario === "lost fresh tape" ? /no fresh live recovery candidates/
            : scenario === "no connected account" ? /no live Deriv connection/ : /RECOVERY HOLD/;
          assert.ok(emitted.some(e => reason.test(String(e.data.rejectReason))));
          assert.equal(runWithSession(sessionId, () => recoveryEngine.getState().unrecoveredAmount), 1);
        } else {
          assert.equal(sent.filter(m => m.buy).length, 1, "exactly one real buy dispatch");
          assert.equal(rows.length, 1);
          assert.equal(rows[0].status, "won", "broker settlement claims the real journal row");
          assert.equal(rows[0].derivContractId, "789123");
          assert.match(String(rows[0].agentReasoning), /READY \[v2\]/);
          const started = emitted.find(e => e.event === "trade_started")!;
          assert.equal(started.data.mode, "RECOVERY");
          if (scenario === "replacement with worse J") {
            assert.equal(rows[0].contractType, "DIGITMATCH");
            assert.equal(rows[0].barrier, 7);
            assert.match(String(rows[0].agentReasoning), /switched pre-buy/);
          }
          assert.ok(runWithSession(sessionId, () => recoveryEngine.getState().unrecoveredAmount) < 1,
            "the broker-reported profit actually repays recovery debt");
        }
      } finally {
        mock.restoreAll();
        resetHedgeSession(sessionId);
        setRecoveryV2ModeOverride(null);
        closeAccountConnections();
        clearPrefetchedQuotes();
        await db.delete(tradesTable).where(eq(tradesTable.sessionId, sessionId));
        await db.delete(settingsTable).where(eq(settingsTable.sessionId, sessionId));
      }
    });
  }
});
