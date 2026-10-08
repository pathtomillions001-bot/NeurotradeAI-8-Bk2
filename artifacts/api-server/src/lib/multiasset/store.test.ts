/**
 * Desk store / bridge-protocol tests.
 *
 * The invariants here are the ones that prevent money being lost to plumbing
 * rather than to the market: a retried sync must not double-open a position,
 * a reconnecting terminal must not leave phantom positions under management,
 * and one browser session's desk must never be visible to another.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acknowledgeResult,
  applyAccount,
  armPlan,
  cancelPlan,
  candleKey,
  drainOutbox,
  enqueueCommand,
  expirePlans,
  getDesk,
  issueBridgeToken,
  journal,
  reconcilePositions,
  requeueStaleCommands,
  resetDesk,
  revokeBridgeToken,
  seriesFor,
  sessionForToken,
  startNewTradingDay,
  upsertCandles,
} from "./store";
import type { AccountSnapshot, ArmedPlan, Bar, ManagementPlan, Position } from "./types";

let counter = 0;
function freshDesk() {
  const id = `test-session-${counter++}-${Math.random().toString(36).slice(2)}`;
  resetDesk(id);
  return getDesk(id);
}

const management: ManagementPlan = {
  breakeven: null,
  partials: [],
  trail: null,
  pyramid: null,
  timeStop: null,
  guards: { maxSpreadPoints: 20, newsBlackoutMin: 10, flatBeforeSessionClose: false },
};

function plan(id: string, symbol = "EURUSD", expiresAt = Date.now() + 60_000): ArmedPlan {
  return {
    id,
    symbol,
    side: "buy",
    mode: "intraday",
    trigger: 1.085,
    triggerType: "break",
    confirmTicks: 1,
    invalidate: 1.084,
    sl: 1.0838,
    tp: [1.0875],
    lots: 0.1,
    riskMoney: 50,
    riskPoints: 120,
    maxSpreadPoints: 20,
    maxSlippagePoints: 5,
    expiresAt,
    createdAt: Date.now(),
    management,
    rationale: {
      confluenceScore: 75, grade: "A", regime: "M5 trend_up", winProbability: 0.55,
      expectancyR: 0.3, rewardRisk: 2, markovPersistence: 0.6, factors: [], warnings: [],
    },
  };
}

function position(ticket: number, symbol = "EURUSD", profit = 0): Position {
  return {
    ticket, symbol, side: "buy", volume: 0.1, openPrice: 1.085, openTime: 1,
    sl: 1.0838, tp: null, profit, swap: 0, commission: 0,
  };
}

// ── Session isolation ────────────────────────────────────────────────────────

test("each browser session gets an independent desk", () => {
  const a = freshDesk();
  const b = freshDesk();
  a.watchlist = ["XAUUSD"];
  a.autoTrade = true;
  assert.notDeepEqual(b.watchlist, ["XAUUSD"]);
  assert.equal(b.autoTrade, false);
});

test("a desk is stable across lookups within one session", () => {
  const desk = freshDesk();
  desk.mode = "scalp";
  assert.equal(getDesk(desk.sessionId).mode, "scalp");
});

// ── Bridge tokens ────────────────────────────────────────────────────────────

test("a bridge token resolves back to exactly one session", () => {
  const desk = freshDesk();
  const token = issueBridgeToken(desk.sessionId);
  assert.equal(sessionForToken(token), desk.sessionId);
  assert.equal(sessionForToken("nt_not-a-real-token"), null);
});

test("tokens are unguessable and unique", () => {
  const desk = freshDesk();
  const tokens = new Set(Array.from({ length: 50 }, () => issueBridgeToken(desk.sessionId)));
  assert.equal(tokens.size, 50);
  for (const token of tokens) assert.ok(token.length >= 48, "token is too short to be a secret");
});

test("a revoked token stops resolving", () => {
  const desk = freshDesk();
  const token = issueBridgeToken(desk.sessionId);
  revokeBridgeToken(token);
  assert.equal(sessionForToken(token), null);
});

// ── Candles ──────────────────────────────────────────────────────────────────

test("re-sending the forming bar updates it instead of duplicating it", () => {
  const desk = freshDesk();
  const first: Bar[] = [[1000, 1, 1.1, 0.9, 1.05, 10], [2000, 1.05, 1.2, 1.0, 1.15, 12]];
  upsertCandles(desk, { symbol: "EURUSD", timeframe: "M5", bars: first });
  // The EA re-reports the last bar on every sync with a new close.
  upsertCandles(desk, { symbol: "EURUSD", timeframe: "M5", bars: [[2000, 1.05, 1.3, 1.0, 1.25, 20]] });

  const stored = desk.candles.get(candleKey("EURUSD", "M5"))!;
  assert.equal(stored.bars.length, 2, "the forming bar must not be appended twice");
  assert.equal(stored.bars[1][4], 1.25, "the latest close must win");
  assert.equal(stored.bars[1][5], 20);
});

test("replayed history after a reconnect does not create duplicates", () => {
  const desk = freshDesk();
  const bars: Bar[] = Array.from({ length: 50 }, (_, i) => [i * 1000 + 1, 1, 1, 1, 1 + i / 1000, 1]);
  upsertCandles(desk, { symbol: "EURUSD", timeframe: "M1", bars });
  upsertCandles(desk, { symbol: "EURUSD", timeframe: "M1", bars });
  assert.equal(desk.candles.get(candleKey("EURUSD", "M1"))!.bars.length, 50);
});

test("bars stay sorted and bounded", () => {
  const desk = freshDesk();
  // Deliberately out of order.
  upsertCandles(desk, {
    symbol: "EURUSD", timeframe: "M1",
    bars: [[3000, 1, 1, 1, 1.3, 1], [1000, 1, 1, 1, 1.1, 1], [2000, 1, 1, 1, 1.2, 1]],
  });
  const stored = desk.candles.get(candleKey("EURUSD", "M1"))!.bars;
  assert.deepEqual(stored.map((b) => b[0]), [1000, 2000, 3000]);

  const many: Bar[] = Array.from({ length: 900 }, (_, i) => [i * 1000 + 1, 1, 1, 1, 1, 1]);
  upsertCandles(desk, { symbol: "XAUUSD", timeframe: "M1", bars: many });
  assert.ok(desk.candles.get(candleKey("XAUUSD", "M1"))!.bars.length <= 400, "history must be bounded");
});

test("seriesFor returns only the requested symbol's timeframes", () => {
  const desk = freshDesk();
  upsertCandles(desk, { symbol: "EURUSD", timeframe: "M5", bars: [[1, 1, 1, 1, 1, 1]] });
  upsertCandles(desk, { symbol: "EURUSD", timeframe: "H1", bars: [[1, 1, 1, 1, 1, 1]] });
  upsertCandles(desk, { symbol: "XAUUSD", timeframe: "M5", bars: [[1, 1, 1, 1, 1, 1]] });

  const series = seriesFor(desk, "EURUSD");
  assert.deepEqual(Object.keys(series).sort(), ["H1", "M5"]);
});

// ── Command queue & idempotency ──────────────────────────────────────────────

test("draining the outbox moves commands in-flight exactly once", () => {
  const desk = freshDesk();
  enqueueCommand(desk, { id: "cmd-1", type: "close", ticket: 1 });
  enqueueCommand(desk, { id: "cmd-2", type: "close", ticket: 2 });

  const batch = drainOutbox(desk);
  assert.equal(batch.length, 2);
  assert.equal(desk.outbox.length, 0, "a drained command must not be re-sent on the next sync");
  assert.equal(desk.inflight.size, 2, "commands stay in flight until acknowledged");

  assert.equal(drainOutbox(desk).length, 0);
});

test("a duplicate acknowledgement is ignored", () => {
  const desk = freshDesk();
  enqueueCommand(desk, { id: "cmd-1", type: "close", ticket: 1 });
  drainOutbox(desk);

  const result = { commandId: "cmd-1", status: "filled" as const, ts: Date.now() };
  assert.equal(acknowledgeResult(desk, result), true, "first ack is fresh");
  assert.equal(acknowledgeResult(desk, result), false, "a retried ack must not be reprocessed");
  assert.equal(desk.inflight.size, 0);
});

test("the seen-command set is bounded so it cannot grow without limit", () => {
  const desk = freshDesk();
  for (let i = 0; i < 900; i++) {
    acknowledgeResult(desk, { commandId: `cmd-${i}`, status: "done", ts: 1 });
  }
  assert.ok(desk.seenCommandIds.length <= 500);
  // The most recent ids must be the ones retained.
  assert.ok(desk.seenCommandIds.includes("cmd-899"));
});

test("only the safety command is retried when an acknowledgement never arrives", () => {
  const desk = freshDesk();
  enqueueCommand(desk, { id: "cmd-open", type: "close", ticket: 1 });
  enqueueCommand(desk, { id: "cmd-flat", type: "flatten_all", reason: "limit" });
  drainOutbox(desk);

  // Nothing is stale yet.
  assert.equal(requeueStaleCommands(desk, 60_000), 0);

  // Everything is stale now.
  const requeued = requeueStaleCommands(desk, -1);
  assert.equal(requeued, 1, "a stale open must NOT be blindly re-sent");
  assert.equal(desk.outbox.length, 1);
  assert.equal(desk.outbox[0].type, "flatten_all");
  assert.equal(desk.inflight.size, 0);
});

// ── Plans ────────────────────────────────────────────────────────────────────

test("arming a second plan on a symbol cancels the first", () => {
  const desk = freshDesk();
  armPlan(desk, plan("plan-1"));
  armPlan(desk, plan("plan-2"));

  assert.equal(desk.plans.size, 1, "two live plans on one symbol could double the exposure");
  assert.ok(desk.plans.has("plan-2"));
  assert.ok(desk.outbox.some((c) => c.type === "cancel_plan" && c.planId === "plan-1"));
});

test("plans on different symbols coexist", () => {
  const desk = freshDesk();
  armPlan(desk, plan("plan-1", "EURUSD"));
  armPlan(desk, plan("plan-2", "XAUUSD"));
  assert.equal(desk.plans.size, 2);
});

test("cancelling a plan queues the cancellation for the EA", () => {
  const desk = freshDesk();
  armPlan(desk, plan("plan-1"));
  desk.outbox = [];

  assert.equal(cancelPlan(desk, "plan-1"), true);
  assert.equal(desk.plans.size, 0);
  assert.equal(desk.outbox.length, 1);
  assert.equal(cancelPlan(desk, "plan-1"), false, "cancelling twice is a no-op");
});

test("expired plans are dropped", () => {
  const desk = freshDesk();
  armPlan(desk, plan("old", "EURUSD", Date.now() - 1));
  armPlan(desk, plan("live", "XAUUSD", Date.now() + 60_000));

  const expired = expirePlans(desk);
  assert.deepEqual(expired, ["old"]);
  assert.ok(desk.plans.has("live"));
});

// ── Account baselines ────────────────────────────────────────────────────────

const snapshot: AccountSnapshot = {
  balance: 5000, equity: 5000, margin: 0, freeMargin: 5000,
  marginLevel: Number.POSITIVE_INFINITY, currency: "USD", leverage: 500,
  mode: "hedging", isLive: false,
};

test("the day-start baseline is captured once and then held", () => {
  const desk = freshDesk();
  applyAccount(desk, snapshot);
  assert.equal(desk.account!.dayStartEquity, 5000);

  // Equity falls; the baseline the daily limit measures against must not move.
  applyAccount(desk, { ...snapshot, equity: 4800 });
  assert.equal(desk.account!.dayStartEquity, 5000);
});

test("peak equity ratchets up and never down", () => {
  const desk = freshDesk();
  applyAccount(desk, snapshot);
  applyAccount(desk, { ...snapshot, equity: 6000 });
  assert.equal(desk.account!.peakEquity, 6000);
  applyAccount(desk, { ...snapshot, equity: 4000 });
  assert.equal(desk.account!.peakEquity, 6000, "drawdown is measured from the high-water mark");
});

test("a new trading day rebases the daily budget but keeps the peak", () => {
  const desk = freshDesk();
  applyAccount(desk, snapshot);
  applyAccount(desk, { ...snapshot, equity: 6000 });
  applyAccount(desk, { ...snapshot, equity: 5500 });

  startNewTradingDay(desk);
  assert.equal(desk.account!.dayStartEquity, 5500);
  assert.equal(desk.account!.peakEquity, 6000);
  assert.equal(desk.riskState.consecutiveLosses, 0);
});

// ── Reconciliation ───────────────────────────────────────────────────────────

test("the terminal is authoritative: vanished positions are detected as closed", () => {
  const desk = freshDesk();
  reconcilePositions(desk, [position(1), position(2)]);

  const { opened, closed } = reconcilePositions(desk, [position(1)]);
  assert.equal(opened.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].ticket, 2);
  assert.equal(desk.positions.length, 1);
});

test("newly appearing positions are reported as opened", () => {
  const desk = freshDesk();
  reconcilePositions(desk, [position(1)]);
  const { opened } = reconcilePositions(desk, [position(1), position(2)]);
  assert.deepEqual(opened.map((p) => p.ticket), [2]);
});

test("the original risk basis survives a stop being moved to breakeven", () => {
  const desk = freshDesk();
  const initial = { ...position(1), initialRiskMoney: 50, initialRiskPoints: 120 };
  reconcilePositions(desk, [initial]);

  // The terminal re-reports the position after the EA moved the stop; it has
  // no idea what we originally risked.
  reconcilePositions(desk, [{ ...position(1), sl: 1.085 }]);
  assert.equal(desk.positions[0].initialRiskMoney, 50, "R-progress would be unmeasurable without this");
  assert.equal(desk.positions[0].initialRiskPoints, 120);
});

test("a full flat is handled without error", () => {
  const desk = freshDesk();
  reconcilePositions(desk, [position(1), position(2)]);
  const { closed } = reconcilePositions(desk, []);
  assert.equal(closed.length, 2);
  assert.equal(desk.positions.length, 0);
});

// ── Journal ──────────────────────────────────────────────────────────────────

test("the journal is newest-first and bounded", () => {
  const desk = freshDesk();
  for (let i = 0; i < 260; i++) journal(desk, "signal", "EURUSD", `entry ${i}`);
  assert.ok(desk.journal.length <= 200);
  assert.equal(desk.journal[0].message, "entry 259");
});

test("journal entries carry a kind, timestamp and id", () => {
  const desk = freshDesk();
  const entry = journal(desk, "risk", null, "halted", { reason: "test" });
  assert.equal(entry.kind, "risk");
  assert.ok(entry.id.length > 0);
  assert.ok(entry.ts > 0);
  assert.deepEqual(entry.detail, { reason: "test" });
});

test("local plan fills/expiry are recognised by plan id after arm acknowledgement", () => {
  const desk = freshDesk();
  armPlan(desk, plan("execution-plan"));
  const command = drainOutbox(desk)[0]!;
  assert.equal(acknowledgeResult(desk, { commandId: command.id, status: "done", ts: Date.now() }), true);
  assert.equal(desk.plans.has("execution-plan"), true);
  const result = { commandId: "execution-plan", status: "filled" as const, ts: Date.now(), price: 1.085, ticket: 100 };
  assert.equal(acknowledgeResult(desk, result), true);
  assert.equal(desk.plans.has("execution-plan"), false);
  assert.equal(acknowledgeResult(desk, result), false, "duplicate result must not double-journal");
});
