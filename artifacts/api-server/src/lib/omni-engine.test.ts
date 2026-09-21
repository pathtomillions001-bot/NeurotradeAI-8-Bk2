import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { db, schemaReady, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { tickManager } from "./deriv";
import { DigitTape } from "./digit-tape";
import { runWithSession } from "./session";
import { currentTradingOwner } from "./engine-arbiter";
import { registerBotEngine } from "./engine-registry";
import { listLiveBots } from "./live-registry";
import * as recovery from "./agents/recovery-engine";
import {
  getStatus,
  isRunning,
  mergeOmniHistory,
  scanForOmni,
  startSession,
  stopSession,
} from "./omni-engine";
import type { OmniConfig } from "./omni-config";

const config: OmniConfig = {
  enabledContracts: ["DIGITMATCH", "DIGITOVER"],
  stake: 1,
  stopLoss: 50,
  takeProfit: 100,
  executionMode: "paper",
  marketMode: "locked",
};
let tape: DigitTape;
let owners: string[] = [];
let fakeOther = false;
registerBotEngine("omni-test-other", () => ({
  running: fakeOther,
  name: "Other test engine",
}));
const owner = () => {
  const id = randomUUID();
  owners.push(id);
  return id;
};
const scoped = <T>(id: string, fn: () => T) => runWithSession(id, fn);
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, message: string, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await pause(15);
  }
  assert.fail(message);
}
function push(symbol: string, digit: number) {
  tape.push({
    symbol,
    digit,
    price: 100 + digit / 1000,
    source: "simulated",
    epoch: Date.now() / 1000,
    receivedAt: Date.now(),
  });
}

before(async () => {
  await schemaReady;
});
beforeEach(() => {
  tape = new DigitTape();
  owners = [];
  for (const symbol of ["R_10", "R_25"])
    for (let i = 0; i < 600; i++) push(symbol, symbol === "R_10" ? 8 : 7);
  mock.method(
    tickManager,
    "getDigitSnapshot",
    (symbol: string, count?: number) => tape.snapshot(symbol, count),
  );
});
afterEach(async () => {
  fakeOther = false;
  for (const id of owners) scoped(id, stopSession);
  for (const id of owners)
    await until(
      () => !scoped(id, isRunning),
      "engine must drain before cleanup",
    );
  mock.restoreAll();
});

describe("Omni trusted deployment and account isolation", () => {
  it("requires the owner's unexpired scan and exact config; no client analysis is trusted", async () => {
    const a = owner();
    const b = owner();
    const scan = await scoped(a, () => scanForOmni(config));
    assert.equal(scan.markets.length, 2);
    assert.equal(
      (
        await scoped(b, () =>
          startSession({ config, scanId: scan.scanId, symbol: "R_10" }),
        )
      ).ok,
      false,
    );
    assert.equal(
      (
        await scoped(a, () =>
          startSession({
            config: { ...config, enabledContracts: ["DIGITDIFF"] },
            scanId: scan.scanId,
            symbol: "R_10",
          }),
        )
      ).ok,
      false,
    );
    assert.equal(
      (
        await scoped(a, () =>
          startSession({ config, scanId: scan.scanId, symbol: "JD100" }),
        )
      ).ok,
      false,
    );
    scan.expiresAt = Date.now() - 1;
    assert.equal(
      (
        await scoped(a, () =>
          startSession({ config, scanId: scan.scanId, symbol: "R_10" }),
        )
      ).ok,
      false,
    );
    assert.equal(scoped(a, currentTradingOwner), null);
  });
  for (const marketMode of ["locked", "switching"] as const) {
    it(`accepts ${marketMode} chosen after a scan in the other mode`, async () => {
      const a = owner();
      const scan = await scoped(a, () =>
        scanForOmni({
          ...config,
          marketMode: marketMode === "locked" ? "switching" : "locked",
        }),
      );
      const result = await scoped(a, () =>
        startSession({
          config: { ...config, marketMode },
          scanId: scan.scanId,
          symbol: "R_10",
        }),
      );
      assert.ok(result.ok, result.error);
      const status = scoped(a, getStatus);
      assert.equal(status.omni?.config.marketMode, marketMode);
      assert.equal(
        status.omni?.lockedSymbol,
        marketMode === "locked" ? "R_10" : null,
      );
    });
  }
  it("admits only one simultaneous start and prevents another bot from taking the slot", async () => {
    const a = owner();
    const scan = await scoped(a, () => scanForOmni(config));
    fakeOther = true;
    assert.equal(
      (
        await scoped(a, () =>
          startSession({ config, scanId: scan.scanId, symbol: "R_10" }),
        )
      ).ok,
      false,
    );
    fakeOther = false;
    const starts = await scoped(a, () =>
      Promise.all([
        startSession({ config, scanId: scan.scanId, symbol: "R_10" }),
        startSession({ config, scanId: scan.scanId, symbol: "R_10" }),
      ]),
    );
    assert.equal(starts.filter((s) => s.ok).length, 1);
    assert.equal(scoped(a, currentTradingOwner), "bots");
  });
  it("does not disclose or stop another account's session, and publishes its own live indicator", async () => {
    const a = owner();
    const b = owner();
    const scan = await scoped(a, () => scanForOmni(config));
    assert.ok(
      (
        await scoped(a, () =>
          startSession({ config, scanId: scan.scanId, symbol: "R_10" }),
        )
      ).ok,
    );
    const hidden = scoped(b, getStatus);
    assert.equal(hidden.running, false);
    assert.equal(hidden.omni, undefined);
    assert.equal(hidden.totalProfit, 0);
    scoped(b, stopSession);
    assert.equal(scoped(a, isRunning), true);
    const live = listLiveBots().filter((entry) => entry.ownerSessionId === a);
    assert.equal(live.length, 1);
    assert.equal(live[0]!.status.botId, "omni");
    assert.equal(
      listLiveBots().filter((entry) => entry.ownerSessionId === b).length,
      0,
    );
  });
});

describe("Omni paper execution uses next-tick identity and isolated debt", () => {
  it("keeps locked-market + contract restrictions through a loss and recovery; live debt is untouched", async () => {
    const a = owner();
    scoped(a, () =>
      recovery.seedState({
        ...recovery.createRecoveryState(),
        inRecovery: true,
        unrecoveredAmount: 9,
        baseStake: 1,
        recoveryStep: 2,
      }),
    );
    const scan = await scoped(a, () => scanForOmni(config));
    assert.ok(
      (
        await scoped(a, () =>
          startSession({ config, scanId: scan.scanId, symbol: "R_10" }),
        )
      ).ok,
    );
    await until(
      () => scoped(a, getStatus).omni?.pendingOrder === true,
      "normal paper order prepared",
    );
    assert.equal(
      scoped(a, getStatus).inRecovery,
      false,
      "paper must not inherit live debt",
    );
    push("R_10", 0); // Lose the biased Matches 8 normal entry.
    await until(
      () => scoped(a, getStatus).tradeCount === 1,
      "normal result settled",
    );
    assert.equal(scoped(a, getStatus).inRecovery, true);
    assert.equal(scoped(a, getStatus).unrecoveredAmount, 1);
    await until(
      () => scoped(a, getStatus).omni?.pendingOrder === true,
      "recovery order prepared",
    );
    const inRecovery = scoped(a, getStatus);
    assert.ok(
      inRecovery.omni!.watch.candidates.every(
        (c) =>
          c.symbol === "R_10" &&
          config.enabledContracts.includes(c.contract.contractType),
      ),
    );
    assert.equal(inRecovery.omni!.watch.utilityFloor, 0);
    push("R_10", 8);
    await until(
      () => scoped(a, getStatus).tradeCount === 2,
      "recovery result settled",
    );
    scoped(a, stopSession);
    await until(() => !scoped(a, isRunning), "paper bot stopped");
    const status = scoped(a, getStatus);
    assert.equal(status.unrecoveredAmount, 0);
    assert.equal(status.inRecovery, false);
    assert.equal(
      scoped(a, () => recovery.getState().unrecoveredAmount),
      9,
    );
    const trades = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.sessionId, a));
    const settled = trades.filter(
      (t) => t.status === "won" || t.status === "lost",
    );
    assert.equal(settled.length, 2);
    assert.ok(
      settled.every(
        (t) =>
          t.symbol === "R_10" &&
          config.enabledContracts.includes(t.contractType as any),
      ),
    );
    assert.ok(
      settled.every((t) => t.agentReasoning?.includes('"accounted":true')),
    );
    assert.equal(status.tradeCount, 2, "a settlement is never counted twice");
  });
  it("settles identical-valued consecutive ticks instead of waiting for a price change", async () => {
    const a = owner();
    const smallTarget = { ...config, takeProfit: 1 };
    const scan = await scoped(a, () => scanForOmni(smallTarget));
    assert.ok(
      (
        await scoped(a, () =>
          startSession({
            config: smallTarget,
            scanId: scan.scanId,
            symbol: "R_10",
          }),
        )
      ).ok,
    );
    await until(
      () => scoped(a, getStatus).omni?.pendingOrder === true,
      "paper order prepared",
    );
    push("R_10", 8); // Same price AND digit, but a new tick identity.
    await until(() => !scoped(a, isRunning), "take profit stops after the win");
    assert.equal(scoped(a, getStatus).tradeCount, 1);
    assert.equal(scoped(a, getStatus).winCount, 1);
    assert.equal(scoped(a, currentTradingOwner), null);
  });
  it("drains Stop without releasing early or manufacturing a win/loss without an exit tick", async () => {
    const a = owner();
    const scan = await scoped(a, () => scanForOmni(config));
    assert.ok(
      (
        await scoped(a, () =>
          startSession({ config, scanId: scan.scanId, symbol: "R_10" }),
        )
      ).ok,
    );
    await until(
      () => scoped(a, getStatus).omni?.pendingOrder === true,
      "paper order prepared",
    );
    scoped(a, stopSession);
    assert.equal(
      scoped(a, currentTradingOwner),
      "bots",
      "lease held until the prepared order is drained",
    );
    await until(() => !scoped(a, isRunning), "stop finishes");
    assert.equal(scoped(a, getStatus).tradeCount, 0);
    assert.equal(scoped(a, currentTradingOwner), null);
    const rows = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.sessionId, a));
    assert.ok(rows.length > 0 && rows.every((r) => r.status === "cancelled"));
    const count = rows.length;
    push("R_10", 8);
    await pause(200);
    assert.equal(
      (await db.select().from(tradesTable).where(eq(tradesTable.sessionId, a)))
        .length,
      count,
      "no post-stop buy",
    );
  });
  it("preserves debt and P&L when the database commits but its acknowledgement is lost", async () => {
    const a = owner();
    const limited = { ...config, stopLoss: 1 };
    const scan = await scoped(a, () => scanForOmni(limited));
    const realTransaction = db.transaction.bind(db);
    let lostAcknowledgement = false;
    mock.method(
      db,
      "transaction",
      async (...args: Parameters<typeof db.transaction>) => {
        const result = await realTransaction(...args);
        if (!lostAcknowledgement) {
          lostAcknowledgement = true;
          throw new Error("Injected post-commit connection loss");
        }
        return result;
      },
    );
    assert.ok(
      (
        await scoped(a, () =>
          startSession({
            config: limited,
            scanId: scan.scanId,
            symbol: "R_10",
          }),
        )
      ).ok,
    );
    await until(
      () => scoped(a, getStatus).omni?.pendingOrder === true,
      "order prepared",
    );
    push("R_10", 0);
    await until(
      () => !scoped(a, isRunning),
      "idempotent settlement must recover then stop",
      8000,
    );
    const status = scoped(a, getStatus);
    assert.ok(lostAcknowledgement);
    assert.equal(status.tradeCount, 1);
    assert.equal(status.totalProfit, -1);
    assert.equal(status.unrecoveredAmount, 1);
    const rows = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.sessionId, a));
    assert.equal(rows.filter((row) => row.status === "lost").length, 1);
  });

  it("a prospective stop-loss cap stops trading without forgiving recovery debt", async () => {
    const a = owner();
    const limited = { ...config, stopLoss: 1 };
    const scan = await scoped(a, () => scanForOmni(limited));
    assert.ok(
      (
        await scoped(a, () =>
          startSession({
            config: limited,
            scanId: scan.scanId,
            symbol: "R_10",
          }),
        )
      ).ok,
    );
    await until(
      () => scoped(a, getStatus).omni?.pendingOrder === true,
      "normal order prepared",
    );
    push("R_10", 0);
    await until(() => !scoped(a, isRunning), "stop-loss stops the engine");
    const status = scoped(a, getStatus);
    assert.equal(status.tradeCount, 1);
    assert.equal(status.unrecoveredAmount, 1);
    assert.equal(status.totalProfit, -1);
  });
});

describe("Omni history alignment", () => {
  it("merges repeated quotes by broker timestamp, and refuses mixed provenance or conflicts", () => {
    const live = new DigitTape();
    live.push({
      symbol: "R_10",
      price: 100.008,
      digit: 8,
      epoch: 10,
      receivedAt: 10_000,
      source: "live",
    });
    live.push({
      symbol: "R_10",
      price: 100.008,
      digit: 8,
      epoch: 12,
      receivedAt: 12_000,
      source: "live",
    });
    const snapshot = live.snapshot("R_10")!;
    const history = mergeOmniHistory([100.007, 100.008], [8, 10], snapshot, 3);
    assert.deepEqual(
      history.map((t) => t.digit),
      [7, 8, 8],
    );
    assert.throws(
      () => mergeOmniHistory([100.009], [10], snapshot, 3),
      /disagrees/,
    );
    assert.throws(
      () => mergeOmniHistory([100.008, 100.008], [10, 10], snapshot, 3),
      /Malformed/,
    );
    assert.throws(
      () =>
        mergeOmniHistory(
          [],
          [],
          { ...snapshot, tick: { ...snapshot.tick, source: "simulated" } },
          3,
        ),
      /Incompatible/,
    );
  });
});
