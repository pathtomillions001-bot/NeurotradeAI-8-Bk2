import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, schemaReady } from "@workspace/db";
import { tradesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { runWithSession } from "../session";
import * as recoveryEngine from "../agents/recovery-engine";
import { settleAutonomousRows } from "../trade-reconciler";
import { claimOpenRow, loadOpenAutonomousRows, settleAutonomousRow } from "./ledger";
import { settingsTable } from "@workspace/db/schema";
import { AUTONOMOUS_HEDGE_PREFIX } from "./constants";

before(async () => {
  await schemaReady;
});

async function insertAutonomousRow(sessionId: string, opts: { createdAgoMs: number; derivContractId?: string | null; stake?: number }) {
  const createdAt = new Date(Date.now() - opts.createdAgoMs);
  const [row] = await db.insert(tradesTable).values({
    sessionId,
    symbol: "R_100",
    displayName: "Volatility 100 Index",
    contractType: "CALL",
    stake: String(opts.stake ?? 1),
    direction: "up",
    status: "open",
    isAutonomous: true,
    agentReasoning: `${AUTONOMOUS_HEDGE_PREFIX}test row`,
    derivContractId: opts.derivContractId ?? null,
    createdAt,
  }).returning();
  return row;
}

function ledgerOf(sessionId: string) {
  return runWithSession(sessionId, () => {
    recoveryEngine.setPersistenceSession(sessionId);
    return recoveryEngine.getState();
  });
}

function rowsFor(sessionId: string, row: { id: number }) {
  return db.select().from(tradesTable).where(eq(tradesTable.id, row.id)).then((r) => r[0]);
}

function toReconRow(row: any) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    symbol: row.symbol,
    contractType: row.contractType,
    stake: String(row.stake),
    derivContractId: row.derivContractId,
    agentReasoning: row.agentReasoning,
    createdAt: row.createdAt,
  };
}

function lossFor(row: any, contractId: number) {
  return {
    contract_id: contractId,
    contract_type: "CALL",
    underlying_symbol: "R_100",
    buy_price: Number(row.stake),
    sell_price: 0,
    purchase_time: Math.floor(row.createdAt.getTime() / 1000) + 1,
    sell_time: Math.floor(row.createdAt.getTime() / 1000) + 3,
  };
}

describe("autonomous 1-tick ledger", () => {
  it("claims an open row exactly once", async () => {
    const sessionId = randomUUID();
    const row = await insertAutonomousRow(sessionId, { createdAgoMs: 1000 });
    assert.equal(await claimOpenRow(row.id, { status: "won", profit: "0.9", payout: "1.9", closedAt: new Date() }), true);
    assert.equal(await claimOpenRow(row.id, { status: "lost", profit: "-1", payout: "0", closedAt: new Date() }), false, "a second writer must not change it");
    const after = await rowsFor(sessionId, row);
    assert.equal(after.status, "won");
  });

  it("lists only this session's open autonomous rows", async () => {
    const sessionId = randomUUID();
    const open = await insertAutonomousRow(sessionId, { createdAgoMs: 1000 });
    const settled = await insertAutonomousRow(sessionId, { createdAgoMs: 1000 });
    await claimOpenRow(settled.id, { status: "lost", profit: "-1", payout: "0", closedAt: new Date() });
    const listed = await loadOpenAutonomousRows(sessionId);
    assert.deepEqual(listed.map((r) => r.id), [open.id]);
    assert.equal((await loadOpenAutonomousRows(randomUUID())).length, 0);
  });

  it("a settlement timeout keeps the trade open and does not touch the recovery ledger", async () => {
    const sessionId = randomUUID();
    const row = await insertAutonomousRow(sessionId, { createdAgoMs: 60_000 });
    const settled = await settleAutonomousRows(sessionId, [toReconRow(row)], [], 3);
    assert.equal(settled, 0);
    assert.equal((await rowsFor(sessionId, row)).status, "open", "the exposure stays open");
    const ledger = ledgerOf(sessionId);
    assert.equal(ledger.inRecovery, false);
    assert.equal(ledger.unrecoveredAmount, 0);
  });

  it("a timed-out trade that Deriv later reports is recorded in the ledger exactly once", async () => {
    const sessionId = randomUUID();
    const row = await insertAutonomousRow(sessionId, { createdAgoMs: 60_000, stake: 1 });
    // Timeout first: nothing on the books yet.
    assert.equal(await settleAutonomousRows(sessionId, [toReconRow(row)], [], 3), 0);
    // Deriv now reports the loss.
    const tx = lossFor(row, 4242);
    assert.equal(await settleAutonomousRows(sessionId, [toReconRow(row)], [tx], 3), 1);
    const after = await rowsFor(sessionId, row);
    assert.equal(after.status, "lost");
    assert.equal(after.derivContractId, "4242");
    const ledger = ledgerOf(sessionId);
    assert.equal(ledger.inRecovery, true, "a loss outside recovery starts recovery");
    assert.ok(Math.abs(ledger.unrecoveredAmount - 1) < 1e-9, "debt equals the actual stake lost");
    // Running the reconciler again must not double count.
    assert.equal(await settleAutonomousRows(sessionId, [toReconRow(after)], [tx], 3), 0);
    assert.ok(Math.abs(ledgerOf(sessionId).unrecoveredAmount - 1) < 1e-9);
  });

  it("an unresolved row with no broker record is released as error without changing the ledger", async () => {
    const sessionId = randomUUID();
    const row = await insertAutonomousRow(sessionId, { createdAgoMs: 11 * 60 * 1000 });
    await settleAutonomousRows(sessionId, [toReconRow(row)], [], 3);
    const after = await rowsFor(sessionId, row);
    assert.equal(after.status, "error");
    assert.match(after.agentReasoning ?? "", /UNRESOLVED/);
    assert.equal(ledgerOf(sessionId).unrecoveredAmount, 0);
  });

  it("a row that already holds its contract id is never released by the timeout", async () => {
    const sessionId = randomUUID();
    const row = await insertAutonomousRow(sessionId, { createdAgoMs: 11 * 60 * 1000, derivContractId: "777" });
    await settleAutonomousRows(sessionId, [toReconRow(row)], [], 3);
    assert.equal((await rowsFor(sessionId, row)).status, "open");
  });

  it("a settled loss in recovery grows the debt by the actual stake and never understates it", async () => {
    const sessionId = randomUUID();
    const first = await insertAutonomousRow(sessionId, { createdAgoMs: 60_000, stake: 1 });
    await settleAutonomousRows(sessionId, [toReconRow(first)], [lossFor(first, 10)], 3);
    const second = await insertAutonomousRow(sessionId, { createdAgoMs: 30_000, stake: 2 });
    const tx2 = { ...lossFor(second, 11), buy_price: 2, sell_price: 0 };
    await settleAutonomousRows(sessionId, [toReconRow(second)], [tx2], 3);
    const ledger = ledgerOf(sessionId);
    assert.ok(Math.abs(ledger.unrecoveredAmount - 3) < 1e-9, "debt is the sum of both lost stakes");
    assert.equal(ledger.recoveryStep >= 2, true);
  });

  it("the recovery debt is durable before the row is marked settled", async () => {
    const sessionId = randomUUID();
    await db.insert(settingsTable).values({ sessionId });
    const row = await insertAutonomousRow(sessionId, { createdAgoMs: 60_000, stake: 1 });
    const outcome = { won: false, profit: -1, cost: 1, contract: "CALL", payout: 1, maxRecoverySteps: 3 };
    const result = await settleAutonomousRow(sessionId, row.id, { status: "lost", profit: "-1", payout: "0", closedAt: new Date() }, outcome);
    assert.equal(result, "settled");
    assert.equal((await rowsFor(sessionId, row)).status, "lost");
    const [stored] = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, sessionId));
    const persisted = JSON.parse(stored.recoveryStateJson ?? "{}");
    assert.ok(Math.abs(Number(persisted.unrecoveredAmount) - 1) < 1e-9, "the stored ledger already includes the loss");
  });

  it("a second settlement of the same row reports already and records nothing", async () => {
    const sessionId = randomUUID();
    const row = await insertAutonomousRow(sessionId, { createdAgoMs: 60_000, stake: 1 });
    const outcome = { won: false, profit: -1, cost: 1, contract: "CALL", payout: 1, maxRecoverySteps: 3 };
    const patch = { status: "lost" as const, profit: "-1", payout: "0", closedAt: new Date() };
    assert.equal(await settleAutonomousRow(sessionId, row.id, patch, outcome), "settled");
    assert.equal(await settleAutonomousRow(sessionId, row.id, patch, outcome), "already");
    assert.ok(Math.abs(ledgerOf(sessionId).unrecoveredAmount - 1) < 1e-9, "debt counted once");
  });
});
