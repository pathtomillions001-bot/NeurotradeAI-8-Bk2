import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  schemaReady,
  settingsTable,
  tradesTable,
  accountsTable,
} from "@workspace/db";
import { browserSession, runWithSessionId } from "./session";
import * as recovery from "./agents/recovery-engine";
import { createPrismRuntime, paperOutcome } from "./prism-match-engine";
import { PRISM_PENDING, PRISM_SCAN_TTL_MS } from "./prism-match-policy";
import { AUTOMATED_DERIV_MARKETS, tickManager } from "./deriv";
import { DigitTape } from "./digit-tape";
import { type PrismOrder } from "./prism-match-runner";
import { addSSEClient, removeSSEClient } from "./sse";
import prismRouter from "../routes/prism-match";
import botsRouter from "../routes/bots";
import { findTransaction } from "./trade-reconciler";

const A = "aaaaaaaa-2222-3333-4444-555555555555";
const B = "bbbbbbbb-2222-3333-4444-555555555555";
const config = {
  activity: "balanced" as const,
  stake: 1,
  stopLoss: 10,
  takeProfit: 20,
  maxRecoverySteps: 3,
  executionMode: "paper" as const,
};
const risk = { ...config, maxStake: 100, markupPercent: 10 };
let server: Server,
  base = "";
// Only the local tape is injected; the production engine/router/storage run unchanged.
const tape = (tickManager as unknown as { digitTape: DigitTape }).digitTape;
function tick(symbol: string, digit = 7) {
  const now = Date.now();
  tape.push({
    symbol,
    price: 100 + digit / 100,
    digit,
    epoch: Math.floor(now / 1000),
    receivedAt: now,
    source: "simulated",
  });
  tickManager.emit("tick", {
    symbol,
    price: 100 + digit / 100,
    lastDigit: digit,
    epoch: Math.floor(now / 1000),
  });
}
async function api(path: string, body?: unknown, session = A) {
  const response = await fetch(`${base}${path}`, {
    headers: {
      Cookie: `neurotrade_session=${session}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
async function waitFor(check: (status: any) => boolean, session = A) {
  for (let i = 0; i < 80; i++) {
    const { data } = await api("/prism/status", undefined, session);
    if (check(data)) return data;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Engine did not reach expected state");
}

before(async () => {
  await schemaReady;
  for (const market of AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled)) {
    for (let i = 0; i < 400; i++)
      tape.push({
        symbol: market.symbol,
        digit: 7,
        price: 100.07,
        source: "simulated",
        epoch: Math.floor(Date.now() / 1000),
        receivedAt: Date.now(),
      });
  }
  const app = express();
  app.use(express.json(), cookieParser(), browserSession);
  app.use("/prism", prismRouter);
  app.use("/bots", botsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await api("/prism/stop", {}, A);
  await api("/prism/stop", {}, B);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Prism real routes + account-scoped scan capability", () => {
  it("publishes its dedicated catalogue console and forbids client cards/other contracts", async () => {
    const catalogue = await api("/bots");
    const bot = catalogue.data.bots.find((b: any) => b.id === "prism-match");
    assert.equal(bot.console, "prism-match@1");
    assert.deepEqual(bot.sides[0].contracts, ["DIGITMATCH"]);
    assert.equal(
      (await api("/prism/scan", { ...config, contractType: "DIGITDIFF" }))
        .status,
      400,
    );
    assert.equal(
      (
        await api("/prism/start", {
          card: { tau: -100 },
          symbol: "R_100",
          marketMode: "locked",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api("/prism/start", {
          scanId: A,
          symbol: "R_100",
          marketMode: "locked",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await api("/bots/prism-match/start", {
          ...config,
          contractType: "CALL",
        })
      ).status,
      400,
    );
  });
  it("returns source-labelled measured results, broadcasts only to owner, and never returns an executable card", async () => {
    const mine: string[] = [],
      foreign: string[] = [];
    const a = { write: (s: string) => mine.push(s) },
      b = { write: (s: string) => foreign.push(s) };
    addSSEClient(a, A);
    addSSEClient(b, B);
    try {
      const result = await api("/prism/scan", config);
      assert.equal(result.status, 200);
      assert.ok(result.data.markets.length > 0);
      assert.equal(result.data.markets[0].source, "simulated");
      assert.equal(result.data.markets[0].historySource, "simulated");
      assert.equal(result.data.markets[0].card, undefined);
      assert.equal(result.data.markets[0].model, undefined);
      assert.equal(result.data.markets[0].policy, undefined);
      assert.ok(result.data.markets[0].validation.testTicks > 0);
      assert.ok(mine.length > 0);
      assert.equal(foreign.length, 0);
      const wrongOwner = await api(
        "/prism/start",
        {
          scanId: result.data.scanId,
          symbol: result.data.markets[0].symbol,
          marketMode: "locked",
        },
        B,
      );
      assert.equal(wrongOwner.status, 409);
      const changed = await api("/prism/start", {
        scanId: result.data.scanId,
        symbol: result.data.markets[0].symbol,
        marketMode: "locked",
        stake: 500,
      });
      assert.equal(changed.status, 400);
      const unscanned = await api("/prism/start", {
        scanId: result.data.scanId,
        symbol: "UNSCANNED",
        marketMode: "locked",
      });
      assert.equal(unscanned.status, 400);
    } finally {
      removeSSEClient(a);
      removeSSEClient(b);
    }
  });
  it("expires deployment capabilities without trusting the browser's timestamps", async () => {
    const scan = (await api("/prism/scan", config)).data;
    const original = Date.now;
    Date.now = () => scan.createdAt + PRISM_SCAN_TTL_MS + 1;
    try {
      const result = await api("/prism/start", {
        scanId: scan.scanId,
        symbol: scan.markets[0].symbol,
        marketMode: "locked",
      });
      assert.equal(result.status, 409);
      assert.match(result.data.error, /expired/);
    } finally {
      Date.now = original;
    }
  });
  it("blocks simulated-data live deployment even with explicit confirmation", async () => {
    const scan = (
      await api("/prism/scan", { ...config, executionMode: "live" })
    ).data;
    assert.ok(scan.markets.every((m: any) => !m.deployable));
    const result = await api("/prism/start", {
      scanId: scan.scanId,
      symbol: scan.markets[0].symbol,
      marketMode: "switching",
      confirmLive: true,
    });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /live-data/);
  });
  it("runs end-to-end paper on the first NEXT tick, is visible globally, and leaves account debt untouched", async () => {
    runWithSessionId(A, () =>
      recovery.seedState({
        ...recovery.createRecoveryState(),
        inRecovery: true,
        unrecoveredAmount: 5,
      }),
    );
    const scan = (await api("/prism/scan", config)).data;
    const symbol = scan.markets[0].symbol;
    const started = await api("/prism/start", {
      scanId: scan.scanId,
      symbol,
      marketMode: "locked",
    });
    assert.equal(started.status, 200);
    assert.equal(started.data.status.tradeCount, 0);
    assert.equal(
      started.data.status.inRecovery,
      false,
      "paper has its own ledger",
    );
    assert.equal((await api("/bots/status")).data.botId, "prism-match");
    assert.equal((await api("/bots")).data.activeBotId, "prism-match");
    assert.equal(
      (await api("/bots/live")).data.bots[0].console,
      "prism-match@1",
    );
    assert.equal((await api("/bots/live", undefined, B)).data.bots.length, 0);
    assert.equal(
      (
        await api("/prism/start", {
          scanId: scan.scanId,
          symbol,
          marketMode: "locked",
        })
      ).status,
      409,
    );
    await api("/prism/stop", {}, B);
    assert.equal(
      (await api("/prism/status")).data.running,
      true,
      "another account's stop is harmless",
    );
    tick(symbol, 7); // same digit, new sequence: authorize one PAPER entry
    await waitFor((s) => s?.prism.phase === "settling");
    tick(symbol, 7); // same digit again: this is the settlement tick, not a timeout
    const settled = await waitFor((s) => s?.tradeCount === 1);
    assert.equal(settled.winCount, 1);
    assert.equal(settled.totalProfit, 7.93);
    assert.equal(
      runWithSessionId(A, () => recovery.getState().unrecoveredAmount),
      5,
    );
    const journal = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.sessionId, A));
    assert.equal(
      journal.length,
      0,
      "paper entries do not pollute the real account journal",
    );
    const stopped = await api("/prism/stop", {});
    assert.equal(stopped.data.status.running, false);
    assert.equal((await api("/bots/live")).data.bots.length, 0);
  });
});

describe("Prism durable journal + SAME Matches recovery reducer", () => {
  const C = "cccccccc-2222-3333-4444-555555555555";
  it("hydrates cold persisted debt after a status read, but preserves warm debt and an explicit reset", async () => {
    const session = "dddddddd-2222-3333-4444-555555555555";
    const saved = {
      ...recovery.createRecoveryState(),
      inRecovery: true,
      unrecoveredAmount: 4,
      baseStake: 1,
      recoveryStep: 2,
    };
    await db
      .insert(settingsTable)
      .values({ sessionId: session, recoveryStateJson: JSON.stringify(saved) });
    await db
      .insert(accountsTable)
      .values({
        sessionId: session,
        loginId: "PRISM-HYDRATION-ONLY",
        token: "fake-unused-token",
        isActive: true,
      });
    assert.equal(
      runWithSessionId(session, () => recovery.getState().unrecoveredAmount),
      0,
      "a cold status read allocated an empty ledger",
    );
    const now = Date.now();
    // This fixture labels a local tape as live, but never emits a trade tick.
    // No authenticated broker request is made: deploy itself is watch-only.
    for (let i = 0; i < 400; i++)
      tape.push({
        symbol: "R_100",
        price: 100.07,
        digit: 7,
        source: "live",
        epoch: Math.floor(now / 1000) - (399 - i) * 2,
        receivedAt: now - (399 - i) * 2000,
      });
    async function deploy() {
      const scan = (
        await api("/prism/scan", { ...config, executionMode: "live" }, session)
      ).data;
      const result = await api(
        "/prism/start",
        {
          scanId: scan.scanId,
          symbol: "R_100",
          marketMode: "locked",
          confirmLive: true,
        },
        session,
      );
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.status.tradeCount, 0);
      await api("/prism/stop", {}, session);
      return result.data.status;
    }
    try {
      assert.equal((await deploy()).unrecoveredAmount, 4);
      runWithSessionId(session, () =>
        recovery.seedState({ ...saved, unrecoveredAmount: 2 }),
      );
      assert.equal(
        (await deploy()).unrecoveredAmount,
        2,
        "stale persisted debt must not replace the warm ledger",
      );
      runWithSessionId(session, () => recovery.resetAll());
      assert.equal(
        (await deploy()).unrecoveredAmount,
        0,
        "an explicit reset is authoritative even though it is empty",
      );
    } finally {
      await api("/prism/stop", {}, session);
    }
  });
  it("honours an explicit zero maximum stake instead of silently restoring a large default", async () => {
    const session = "eeeeeeee-2222-3333-4444-555555555555";
    await db
      .insert(settingsTable)
      .values({ sessionId: session, maxTradeStake: "0" });
    assert.equal((await api("/prism/scan", config, session)).status, 400);
    const runtime = createPrismRuntime(session, config, risk, null);
    assert.equal((await runtime.risk()).maxStake, 0);
  });
  it("atomically settles debt once, even if a journal reconciler already populated won/lost", async () => {
    await db
      .insert(settingsTable)
      .values({ sessionId: C })
      .onConflictDoNothing();
    runWithSessionId(C, () => recovery.resetAll());
    const runtime = createPrismRuntime(
      C,
      { ...config, executionMode: "live" },
      risk,
      null,
    );
    const [row] = await db
      .insert(tradesTable)
      .values({
        sessionId: C,
        symbol: "R_100",
        displayName: "V100",
        contractType: "DIGITMATCH",
        barrier: 7,
        stake: "1",
        direction: "hold",
        status: "lost",
        profit: "-1",
        derivContractId: "1234",
        agentReasoning: `${PRISM_PENDING} [Prism Match]`,
      })
      .returning();
    await runtime.commit(row!.id, { won: false, profit: -1 }, 1, 8.93);
    await runtime.commit(row!.id, { won: false, profit: -1 }, 1, 8.93);
    assert.equal(
      runWithSessionId(C, () => recovery.getState().unrecoveredAmount),
      1,
    );
    const [stored] = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.id, row!.id));
    const [setting] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.sessionId, C));
    assert.equal(stored!.status, "lost");
    assert.match(stored!.agentReasoning!, /PRISM_SETTLED/);
    assert.equal(JSON.parse(setting!.recoveryStateJson!).unrecoveredAmount, 1);
    assert.equal(stored!.derivContractId, "1234");
    const [win] = await db
      .insert(tradesTable)
      .values({
        sessionId: C,
        symbol: "R_100",
        displayName: "V100",
        contractType: "DIGITMATCH",
        barrier: 7,
        stake: "0.35",
        direction: "hold",
        status: "open",
        derivContractId: "1235",
        agentReasoning: `${PRISM_PENDING} [Prism Match]`,
      })
      .returning();
    await runtime.commit(win!.id, { won: true, profit: 2.78 }, 0.35, 8.93);
    assert.equal(
      runWithSessionId(C, () => recovery.getState().inRecovery),
      false,
    );
    assert.equal(
      runWithSessionId(C, () => recovery.getState().unrecoveredAmount),
      0,
    );
  });
  it("never settles an unknown contract or a different account's journal row", async () => {
    const runtime = createPrismRuntime(
      C,
      { ...config, executionMode: "live" },
      risk,
      null,
    );
    const [row] = await db
      .insert(tradesTable)
      .values({
        sessionId: C,
        symbol: "R_100",
        displayName: "V100",
        contractType: "DIGITMATCH",
        barrier: 7,
        stake: "1",
        direction: "hold",
        status: "open",
        agentReasoning: `${PRISM_PENDING} [Prism Match]`,
      })
      .returning();
    await assert.rejects(
      () => runtime.commit(row!.id, { won: false, profit: -1 }, 1, 8.93),
      /contract ID/,
    );
    const outsider = createPrismRuntime(
      B,
      { ...config, executionMode: "live" },
      risk,
      null,
    );
    await assert.rejects(
      () => outsider.commit(row!.id, { won: false, profit: -1 }, 1, 8.93),
      /contract ID/,
    );
    const [stored] = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.id, row!.id), eq(tradesTable.sessionId, C)));
    assert.equal(stored!.profit, null);
    assert.equal(stored!.status, "open");
  });
  it("paper marks repeated next digits correctly and never guesses across missing ticks", () => {
    const stream = new DigitTape(5);
    const first = stream.push({
      symbol: "R_100",
      digit: 7,
      price: 100.07,
      epoch: 10,
      receivedAt: 10_000,
      source: "simulated",
    })!;
    const order = {
      symbol: "R_100",
      barrier: 7,
      stake: 1,
      tick: first,
    } as PrismOrder;
    assert.equal(paperOutcome(order, 8.93, stream.snapshot("R_100")), null);
    stream.push({
      symbol: "R_100",
      digit: 7,
      price: 100.07,
      epoch: 12,
      receivedAt: 12_000,
      source: "simulated",
    });
    assert.equal(
      paperOutcome(order, 8.93, stream.snapshot("R_100"))!.won,
      true,
    );
    const snapshot = stream.snapshot("R_100")!;
    const missing = { ...snapshot.tick, sequence: first.sequence + 2 };
    assert.throws(
      () => paperOutcome(order, 8.93, { tick: missing, ticks: [missing] }),
      /missed/,
    );
    assert.throws(
      () =>
        paperOutcome(order, 8.93, {
          tick: { ...snapshot.tick, generation: 2 },
          ticks: snapshot.ticks,
        }),
      /changed/,
    );
  });
});

describe("Prism reconciliation identity guard", () => {
  const row = {
    id: 1,
    sessionId: A,
    symbol: "R_100",
    contractType: "DIGITMATCH",
    stake: "1",
    derivContractId: "42",
    createdAt: new Date(),
    agentReasoning: PRISM_PENDING,
  };
  const transaction = {
    contract_id: 43,
    underlying_symbol: row.symbol,
    contract_type: row.contractType,
    buy_price: 1,
    purchase_time: Math.floor(row.createdAt.getTime() / 1000),
  };
  it("only accepts a known exact contract ID and never fuzzy-matches an uncertain Prism send", () => {
    assert.equal(findTransaction(row, [transaction]), null);
    assert.equal(
      findTransaction({ ...row, derivContractId: null }, [transaction]),
      null,
    );
    const exact = { ...transaction, contract_id: 42 };
    assert.equal(findTransaction(row, [transaction, exact]), exact);
  });
  it("retains the existing family/time/stake fallback only for legacy rows without IDs", () => {
    const legacy = {
      ...row,
      derivContractId: null,
      agentReasoning: null,
      contractType: "CALL",
    };
    const rise = { ...transaction, contract_type: "RISE" };
    assert.equal(findTransaction(legacy, [rise]), rise);
    assert.equal(
      findTransaction({ ...legacy, derivContractId: "99" }, [rise]),
      null,
    );
  });
});
