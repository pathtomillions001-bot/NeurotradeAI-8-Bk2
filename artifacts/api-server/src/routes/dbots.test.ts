/**
 * Deriv DBot routes — the contract the app depends on when a user runs a bot
 * built from a scan.
 *
 * What must never regress:
 *   1. A DBot is created for the session's ACTIVE account and nothing else, and
 *      every subsequent call is scoped to the session that owns it.
 *   2. Only contracts a scan could itself deploy can be compiled (the DBot path
 *      must not become a way to hand-build a tradable program).
 *   3. While a DBot runs it holds the account's SINGLE execution lock — a server
 *      engine cannot start next to it and double-trade the shared ledger — and
 *      STOPPING it releases that lock.
 *   4. Every settled fill reaches the app's journal exactly once (mirroring is
 *      idempotent) and exactly once reaches the shared recovery ledger.
 *   5. Switching demo ↔ real (or to another linked account) STOPS the bot: a
 *      DBot must never keep trading the account it was not built for.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

import dbotsRouter from "./dbots.ts";
import botsRouter from "./bots.ts";
import { runWithSessionId } from "../lib/session.ts";
import { acquireTradingOwnership, releaseTradingOwnership, currentTradingOwner } from "../lib/engine-arbiter.ts";
import { __resetDbotsForTests, getDbot, isDbotRunning, type DbotRecord } from "../lib/dbots/registry.ts";
import { __setProfitTableFetcherForTests, dbotContractIds, DBOT_SOURCE_TAG } from "../lib/dbots/mirror.ts";
import { __setRecoveryPayoutResolverForTests } from "../lib/dbots/factory.ts";
import * as recoveryEngine from "../lib/agents/recovery-engine.ts";

const SESSION_A = "session-a-dbots-route";
const SESSION_B = "session-b-dbots-route";

let server: Server;
let baseUrl = "";

function api(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "x-test-session": session, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

async function start() {
  const app = express();
  app.use(express.json());
  // Stand-in for the platform's browserSession middleware — including the
  // AsyncLocalStorage binding, because the recovery ledger and the arbiter are
  // resolved from it (that is how per-account isolation works in production).
  app.use((req: any, _res, next) => {
    const sessionId = req.get("x-test-session") || SESSION_A;
    req.sessionId = sessionId;
    runWithSessionId(sessionId, next);
  });
  app.use("/dbots", dbotsRouter);
  app.use("/bots", botsRouter);
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

const TURBO_BODY = {
  source: "overunder-turbo",
  symbol: "R_100",
  displayName: "Volatility 100 Index",
  normal: { side: "DIGITOVER", barrier: 1 },
  // Recovery legs are the scan's OWN recovery contracts (Dual-Lock recovery set:
  // Over 4/5, Under 5/4) — the route rejects anything else.
  recovery: { side: "DIGITUNDER", barrier: 5 },
  stake: 1,
  takeProfit: 10,
  stopLoss: 5,
};

/** A profit_table row that can only belong to a DBot on R_100. */
function fillRow(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    contract_id: 900001,
    transaction_id: 800001,
    contract_type: "DIGITOVER",
    underlying_symbol: "R_100",
    buy_price: 1,
    sell_price: 1.95,
    purchase_time: now,
    sell_time: now + 1,
    longcode: "Win payout if the last digit of Volatility 100 Index is strictly higher than 0.",
    ...overrides,
  };
}

let profitRows: any[] = [];

async function createBot(session = SESSION_A, body: Record<string, unknown> = {}) {
  const res = await api("/dbots", session, { method: "POST", body: JSON.stringify({ ...TURBO_BODY, ...body }) });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  return data.bot as { id: string; name: string; accountId: string; isVirtual: boolean };
}

async function botRecord(id: string, session = SESSION_A): Promise<DbotRecord> {
  const record = getDbot(session, id);
  assert.ok(record, `bot ${id} should exist for ${session}`);
  return record;
}

describe("dbot routes", () => {
  before(async () => {
    // Touch the database first: pglite applies its DDL on first use, and the
    // harness binds each request to a session through the real middleware shape.
    await db.delete(accountsTable);
    await start();
  });

  beforeEach(async () => {
    profitRows = [];
    await db.delete(accountsTable);
    await db.delete(settingsTable);
    await db.delete(tradesTable);
    __resetDbotsForTests();
    recoveryEngine.resetAll();
    releaseTradingOwnership("dbot", SESSION_A);
    releaseTradingOwnership("autonomous", SESSION_A);
    __setProfitTableFetcherForTests(async () => profitRows);
    __setRecoveryPayoutResolverForTests(async () => ({ payoutMultiplier: 1.95, source: "fallback" as const }));
    await db.insert(accountsTable).values([
      {
        sessionId: SESSION_A,
        loginId: "VRTC90000041",
        derivAccountId: "VRTC90000041",
        bearerToken: "test-bearer-a",
        currency: "USD",
        balance: "1000.00",
        isVirtual: true,
        isActive: true,
      },
      {
        sessionId: SESSION_A,
        loginId: "CR90000042",
        derivAccountId: "CR90000042",
        bearerToken: "test-bearer-real",
        currency: "USD",
        balance: "500.00",
        isVirtual: false,
        isActive: false,
      },
      {
        sessionId: SESSION_B,
        loginId: "VRTC90000043",
        derivAccountId: "VRTC90000043",
        bearerToken: "test-bearer-b",
        currency: "USD",
        balance: "100.00",
        isVirtual: true,
        isActive: true,
      },
    ]);
  });

  after(async () => {
    __setProfitTableFetcherForTests(null);
    __setRecoveryPayoutResolverForTests(null);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects anything a scan could not itself deploy", async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["missing symbol", { symbol: "" }, /symbol/i],
      ["normal barrier outside the scan's normal set", { normal: { side: "DIGITOVER", barrier: 5 } }, /normal contract/i],
      ["recovery barrier outside the scan's recovery set", { recovery: { side: "DIGITUNDER", barrier: 8 } }, /recovery contract/i],
      ["recovery barrier that is only a normal contract", { recovery: { side: "DIGITOVER", barrier: 2 } }, /recovery contract/i],
      ["non-digit contract type", { normal: { side: "RISE", barrier: 1 } }, /only digit Over\/Under/i],
      ["unknown scan source", { source: "killshot" }, /unknown DBot source/i],
    ];
    for (const [label, body, pattern] of cases) {
      const res = await api("/dbots", SESSION_A, { method: "POST", body: JSON.stringify({ ...TURBO_BODY, ...body }) });
      const data = await res.json();
      assert.equal(res.status, 400, `${label}: ${JSON.stringify(data)}`);
      assert.match(String(data.error), pattern, label);
    }
  });

  it("refuses to build without a connected account", async () => {
    await db.delete(accountsTable);
    const res = await api("/dbots", SESSION_A, { method: "POST", body: JSON.stringify(TURBO_BODY) });
    assert.equal(res.status, 409);
    assert.match(String((await res.json()).error), /connect a deriv account/i);
  });

  it("builds a bot from the console's payload, on the ACTIVE account", async () => {
    const res = await api("/dbots", SESSION_A, { method: "POST", body: JSON.stringify(TURBO_BODY) });
    const data = await res.json();
    assert.equal(res.status, 201);
    assert.equal(data.bot.accountId, "VRTC90000041");
    assert.equal(data.bot.isVirtual, true);
    assert.equal(data.bot.symbol, "R_100");
    assert.equal(data.bot.displayName, "Volatility 100 Index");
    assert.deepEqual(data.bot.contractTypes, ["DIGITOVER", "DIGITUNDER"]);
    assert.equal(data.bot.live, false);
    assert.equal(data.bot.tradeCount, 0);
    assert.equal(data.bot.program.stake.initial, 1);
    assert.deepEqual(data.bot.program.limits, { takeProfit: 10, stopLoss: 5 });
    assert.deepEqual(data.bot.normal ?? data.bot.program.normal, { contractType: "DIGITOVER", prediction: 1 });
    assert.deepEqual(data.bot.program.recovery, { contractType: "DIGITUNDER", prediction: 5 });
    assert.match(String(data.xml), /is_dbot="true"/);
  });

  it("serves the compiled program as no-store XML, only to its own session", async () => {
    const bot = await createBot();
    const res = await api(`/dbots/${bot.id}/xml`, SESSION_A);
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get("content-type")), /application\/xml/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const xml = await res.text();
    assert.match(xml, /^<xml /);
    assert.match(xml, /<field name="SYMBOL_LIST">R_100<\/field>/);

    // Another session cannot read, run, stop or delete it.
    assert.equal((await api(`/dbots/${bot.id}`, SESSION_B)).status, 404);
    assert.equal((await api(`/dbots/${bot.id}/xml`, SESSION_B)).status, 404);
    assert.equal((await api(`/dbots/${bot.id}/live`, SESSION_B, { method: "POST" })).status, 404);
    assert.equal((await api(`/dbots/${bot.id}/heartbeat`, SESSION_B, { method: "POST" })).status, 409);
    assert.equal((await api(`/dbots/${bot.id}/stop`, SESSION_B, { method: "POST" })).status, 404);
    assert.equal((await api(`/dbots/${bot.id}`, SESSION_B, { method: "DELETE" })).status, 404);
  });

  it("takes the account's single engine lock while the bot runs", async () => {
    const bot = await createBot();
    // A server-side engine already trades this account.
    assert.equal(acquireTradingOwnership("autonomous", SESSION_A), true);

    const blocked = await api(`/dbots/${bot.id}/live`, SESSION_A, { method: "POST" });
    assert.equal(blocked.status, 409);
    const blockedData = await blocked.json();
    assert.equal(blockedData.blockingBotId, "autonomous");
    assert.equal(isDbotRunning(await botRecord(bot.id)), false);

    // The engine stops → the DBot takes the lock.
    releaseTradingOwnership("autonomous", SESSION_A);
    const live = await api(`/dbots/${bot.id}/live`, SESSION_A, { method: "POST" });
    assert.equal(live.status, 200);
    assert.equal(currentTradingOwner(SESSION_A), "dbot");
    assert.equal(isDbotRunning(await botRecord(bot.id)), true);
  });

  it("hands the lock over between DBots instead of refusing", async () => {
    const first = await createBot();
    const second = await createBot();
    assert.equal((await api(`/dbots/${first.id}/live`, SESSION_A, { method: "POST" })).status, 200);
    assert.equal((await api(`/dbots/${second.id}/live`, SESSION_A, { method: "POST" })).status, 200);

    const firstAfter = await botRecord(first.id);
    assert.equal(isDbotRunning(firstAfter), false);
    assert.equal(firstAfter.stopReason, "killed");
    assert.equal(isDbotRunning(await botRecord(second.id)), true);
  });

  it("mirrors every settled fill once — into the journal and the shared ledger", async () => {
    const bot = await createBot();
    const nowSec = Math.floor(Date.now() / 1000);
    profitRows = [
      // Older first: the loss opens the debt, the later win pays it down.
      fillRow({
        contract_id: 900012,
        contract_type: "DIGITUNDER",
        buy_price: 2,
        sell_price: 0,
        purchase_time: nowSec - 10,
        sell_time: nowSec - 9,
        longcode: "Win payout if the last digit of Volatility 100 Index is strictly lower than 8 after 1 tick.",
      }),
      fillRow({ contract_id: 900011, contract_type: "DIGITOVER", buy_price: 1, sell_price: 1.95, purchase_time: nowSec }),
      // Not this bot's fill: a different market.
      fillRow({ contract_id: 900013, underlying_symbol: "R_50" }),
      // Not this bot's fill: a contract type the bot never buys.
      fillRow({ contract_id: 900014, contract_type: "DIGITEVEN" }),
    ];

    const live = await api(`/dbots/${bot.id}/live`, SESSION_A, { method: "POST" });
    const liveData = await live.json();
    assert.equal(live.status, 200);
    assert.equal(liveData.newFills, 2);

    // Heartbeats are cheap and idempotent — nothing is ever counted twice.
    const beat1 = await (await api(`/dbots/${bot.id}/heartbeat`, SESSION_A, { method: "POST" })).json();
    assert.equal(beat1.stopRequested, false);
    assert.equal(beat1.newFills, 0);

    const one = await (await api(`/dbots/${bot.id}`, SESSION_A)).json();
    assert.equal(one.bot.tradeCount, 2);
    assert.equal(one.bot.totalProfit, -1.05); // +0.95 win, −2.00 loss
    assert.equal(one.fills.length, 2);
    assert.equal(one.bot.lastFill.contractId, "900011"); // newest settle wins the "last fill" slot

    // Journal rows, tagged as DBot fills (never autonomous).
    const rows = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.sessionId, SESSION_A), eq(tradesTable.displayName, "Volatility 100 Index")));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.isAutonomous, false);
      assert.match(String(row.agentReasoning), new RegExp(`^\\[${DBOT_SOURCE_TAG}\\]`));
      assert.equal(row.durationUnit, "t");
      assert.ok(["DIGITOVER", "DIGITUNDER"].includes(row.contractType!));
    }
    const win = rows.find((row) => row.contractType === "DIGITOVER")!;
    const loss = rows.find((row) => row.contractType === "DIGITUNDER")!;
    assert.equal(win.direction, "up");
    assert.equal(loss.direction, "down");
    assert.equal(win.status, "won");
    assert.equal(loss.status, "lost");
    assert.equal(win.derivContractId, "900011");

    // The SHARED ledger saw the loss (+the win's offset), in settle order.
    const state = runWithSessionId(SESSION_A, () => ({ ...recoveryEngine.getState() }));
    assert.equal(state.unrecoveredAmount, 1.05);
    assert.equal(state.inRecovery, true);

    // The journal can tag exactly these contracts as DBot fills.
    const ids = await dbotContractIds(SESSION_A);
    assert.deepEqual([...ids].sort(), ["900011", "900012"]);

    // A second bot on another market is unaffected by the first one's rows.
    const other = await createBot(SESSION_A, { symbol: "R_10", displayName: "Volatility 10 Index" });
    const otherLive = await (await api(`/dbots/${other.id}/live`, SESSION_A, { method: "POST" })).json();
    assert.equal(otherLive.newFills, 0);
  });

  it("stops on request and refuses heartbeats afterwards", async () => {
    const bot = await createBot();
    await api(`/dbots/${bot.id}/live`, SESSION_A, { method: "POST" });

    const stopped = await (await api(`/dbots/${bot.id}/stop`, SESSION_A, { method: "POST", body: JSON.stringify({ reason: "user" }) })).json();
    assert.equal(stopped.bot.live, false);
    assert.equal(currentTradingOwner(SESSION_A), null);
    assert.equal(isDbotRunning(await botRecord(bot.id)), false);

    const beat = await api(`/dbots/${bot.id}/heartbeat`, SESSION_A, { method: "POST" });
    assert.equal(beat.status, 409);
    const beatData = await beat.json();
    assert.equal(beatData.stopRequested, true);

    // The history survives the stop, and the bot is no longer "current".
    const list = await (await api("/dbots", SESSION_A)).json();
    assert.equal(list.bots.find((b: any) => b.id === bot.id).tradeCount, 0);
    assert.equal((await (await api("/dbots/live/current", SESSION_A)).json()).bot, null);

    // ...and it can be deleted entirely.
    assert.equal((await api(`/dbots/${bot.id}`, SESSION_A, { method: "DELETE" })).status, 200);
    assert.equal((await api(`/dbots/${bot.id}`, SESSION_A)).status, 404);
  });

  it("stops the bot when the account selection changes", async () => {
    const bot = await createBot();
    assert.equal((await api(`/dbots/${bot.id}/live`, SESSION_A, { method: "POST" })).status, 200);

    // The user flips demo → real. The bot was built for the demo account.
    await db.update(accountsTable).set({ isActive: false }).where(and(eq(accountsTable.sessionId, SESSION_A), eq(accountsTable.loginId, "VRTC90000041")));
    await db.update(accountsTable).set({ isActive: true }).where(and(eq(accountsTable.sessionId, SESSION_A), eq(accountsTable.loginId, "CR90000042")));

    // The heartbeat is what notices it: the mirror refuses to attribute the new
    // account's fills to this bot, stops it, and tells Bot Studio to stop the
    // engine in the browser (stopRequested) — demo ↔ real can never keep trading.
    const beat = await api(`/dbots/${bot.id}/heartbeat`, SESSION_A, { method: "POST" });
    assert.equal(beat.status, 200);
    const beatData = await beat.json();
    assert.equal(beatData.stopRequested, true);
    assert.equal(beatData.bot.live, false);
    const record = await botRecord(bot.id);
    assert.equal(isDbotRunning(record), false);
    assert.equal(record.stopReason, "account-switch");
    assert.equal(currentTradingOwner(SESSION_A), null);
  });

  it("keeps stopped bots out of the live list", async () => {
    const bot = await createBot();
    assert.equal((await api(`/dbots/${bot.id}/live`, SESSION_A, { method: "POST" })).status, 200);
    const current = await (await api("/dbots/live/current", SESSION_A)).json();
    assert.equal(current.bot.id, bot.id);
    assert.equal(current.bot.live, true);

    // A stale heartbeat (tab closed) is reconciled away by the next read.
    const record = await botRecord(bot.id);
    record.lastSeenAt = Date.now() - 10 * 60_000;
    assert.equal((await (await api("/dbots", SESSION_A)).json()).bots[0].live, false);
    assert.equal(isDbotRunning(record), false);
    assert.equal((await (await api("/dbots/live/current", SESSION_A)).json()).bot, null);
  });

  it("publishes the DBot to the live badge as console dbot@1", async () => {
    const bot = await createBot();
    assert.equal((await api(`/dbots/${bot.id}/live`, SESSION_A, { method: "POST" })).status, 200);

    // GET /api/bots/live is what the layout's live indicator polls; a DBot has
    // to appear there (with a console id this bundle implements) or the user
    // could not see — or stop — a bot that is trading.
    const live = await (await api("/bots/live", SESSION_A)).json();
    assert.equal(live.bots.length, 1);
    assert.equal(live.bots[0].botId, "dbot");
    assert.equal(live.bots[0].console, "dbot@1");
    assert.equal(live.bots[0].status.dbotId, bot.id);
    assert.equal(live.bots[0].status.symbol, "R_100");
    assert.equal(live.bots[0].status.tradeCount, 0);

    // Another account's session sees nothing of it (strict account isolation).
    const other = await (await api("/bots/live", SESSION_B)).json();
    assert.deepEqual(other.bots, []);
    assert.equal(other.activeBotId, null);
  });
});
