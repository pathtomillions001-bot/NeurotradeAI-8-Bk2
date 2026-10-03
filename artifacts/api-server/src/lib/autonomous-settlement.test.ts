import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, before } from "node:test";
import { db, schemaReady, tradesTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { settleAutonomousTrade } from "./autonomous-settlement";
import { runWithSession } from "./session";
import * as recovery from "./agents/recovery-engine";
before(async () => {
  await schemaReady;
});
async function fixture() {
  const sessionId = randomUUID();
  await db.insert(settingsTable).values({ sessionId });
  const [row] = await db
    .insert(tradesTable)
    .values({
      sessionId,
      symbol: "R_10",
      displayName: "Test",
      contractType: "DIGITOVER",
      stake: "1",
      direction: "hold",
      status: "open",
      isAutonomous: true,
      derivContractId: "123",
      agentReasoning: "[AUTONOMOUS PENDING] test",
    })
    .returning();
  return {
    sessionId,
    tradeId: row.id,
    won: false,
    profit: -1,
    stake: 1,
    payout: 0,
    payoutMultiplier: 1.63,
    contractType: "DIGITOVER",
    entryPrice: 100,
    exitPrice: 101,
  };
}
describe("atomic autonomous settlement", () => {
  it("applies a loss and persists the journal/ledger once, even with concurrent duplicate settlement", async () => {
    const input = await fixture();
    const results = await Promise.all([
      settleAutonomousTrade(input),
      settleAutonomousTrade(input),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const [trade] = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.id, input.tradeId));
    const [settings] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.sessionId, input.sessionId));
    assert.equal(trade.status, "lost");
    assert.equal(JSON.parse(settings.recoveryStateJson!).unrecoveredAmount, 1);
    runWithSession(input.sessionId, () =>
      assert.equal(recovery.getState().unrecoveredAmount, 1),
    );
  });
  it("a foreign session cannot settle another accounts trade", async () => {
    const input = await fixture();
    assert.equal(
      await settleAutonomousTrade({ ...input, sessionId: randomUUID() }),
      false,
    );
    const [trade] = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.id, input.tradeId));
    assert.equal(trade.status, "open");
  });
  it("repays debt from actual net profit and stops at zero, not an optional target", async () => {
    const input = await fixture();
    await settleAutonomousTrade(input);
    const [win] = await db
      .insert(tradesTable)
      .values({
        sessionId: input.sessionId,
        symbol: "R_10",
        displayName: "Test",
        contractType: "DIGITOVER",
        stake: "1",
        direction: "hold",
        status: "open",
        isAutonomous: true,
      })
      .returning();
    await settleAutonomousTrade({
      ...input,
      tradeId: win.id,
      won: true,
      profit: 1,
      payout: 2,
    });
    const [settings] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.sessionId, input.sessionId));
    const state = JSON.parse(settings.recoveryStateJson!);
    assert.equal(state.unrecoveredAmount, 0);
    assert.equal(state.inRecovery, false);
  });
});

it("does not turn a refunded contract into a recovery loss", async () => {
  const input = await fixture();
  await settleAutonomousTrade({ ...input, profit: 0, payout: 1 });
  const [settings] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.sessionId, input.sessionId));
  assert.equal(JSON.parse(settings.recoveryStateJson!).unrecoveredAmount, 0);
  const [trade] = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.id, input.tradeId));
  assert.equal(trade.status, "refunded");
});
it("rejects malformed broker settlement without closing the order", async () => {
  const input = await fixture();
  await assert.rejects(
    settleAutonomousTrade({ ...input, profit: NaN }),
    /Invalid broker/,
  );
  const [trade] = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.id, input.tradeId));
  assert.equal(trade.status, "open");
});

it("uses the locked persisted same-day debt rather than a stale warm ledger", async () => {
  const input = await fixture();
  const persisted = runWithSession(input.sessionId, () => ({
    ...recovery.getState(),
    inRecovery: true,
    unrecoveredAmount: 3,
    baseStake: 1,
    recoveryStep: 1,
  }));
  await db
    .update(settingsTable)
    .set({ recoveryStateJson: JSON.stringify(persisted) })
    .where(eq(settingsTable.sessionId, input.sessionId));
  await settleAutonomousTrade(input);
  const [settings] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.sessionId, input.sessionId));
  assert.equal(JSON.parse(settings.recoveryStateJson!).unrecoveredAmount, 4);
});
