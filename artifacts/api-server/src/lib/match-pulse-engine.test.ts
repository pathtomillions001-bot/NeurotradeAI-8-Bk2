/** Offline lifecycle/account fixtures on injected tapes and an isolated database. No real broker calls. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { db, schemaReady, tradesTable, settingsTable, accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { parsePulseAccountConfig, parsePulseAccountScan } from "./match-pulse-config.ts";
import { DigitTape } from "./digit-tape.ts";
import { tickManager, AUTOMATED_DERIV_MARKETS } from "./deriv.ts";
import { runWithSessionId } from "./session.ts";
import { currentTradingOwner, acquireTradingOwnership, releaseTradingOwnership } from "./engine-arbiter.ts";
import * as recovery from "./agents/recovery-engine.ts";
import { scanMatchPulse, startMatchPulse, stopMatchPulse, getMatchPulseStatus, restoreMatchPulseHolds, reconcileMatchPulse } from "./match-pulse-engine.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(`Timed out: ${JSON.stringify(getMatchPulseStatus())}`);
    await delay(10);
  }
}

it("paper lifecycle: scan receipt → distinct-tick entry → repeated-digit settlement → safe stop; real debt untouched", async () => {
  await schemaReady;
  const tape = new DigitTape();
  for (const market of AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled)) {
    // Deliberately obvious synthetic plant, never advertised as live accuracy.
    for (let i = 0; i < 2400; i++) tape.push({ symbol: market.symbol, price: 100.07,
      digit: 7, epoch: i, receivedAt: Date.now(), source: "simulated" });
  }
  const original = tickManager.getDigitSnapshot;
  tickManager.getDigitSnapshot = (symbol, count) => tape.snapshot(symbol, count);
  const owner = "f0000000-0000-0000-0000-000000000001";
  try {
    await runWithSessionId(owner, async () => {
      recovery.seedState(recovery.reduceRecoveryOutcome(recovery.createRecoveryState(), false, -3, 3, 3, "DIGITMATCH", 8.93));
      const realLedger = { ...recovery.getState() };
      const scan = await scanMatchPulse({ executionMode: "paper" });
      assert.ok(scan.qualifiedCount > 0);
      assert.ok(scan.candidates.every(c => c.source === "simulated"));
      const selectedSymbol = scan.candidates[0]!.symbol;
      const config = { scanId: scan.scanId, selectedSymbol, executionMode: "paper" as const,
        marketMode: "locked" as const, stake: 1, stopLoss: 5, takeProfit: 20,
        maxRecoverySteps: 3, maxConsecutiveLosses: 6 };
      await runWithSessionId("f0000000-0000-0000-0000-000000000002", async () => {
        await assert.rejects(() => startMatchPulse(config), /receipt/);
        assert.equal(getMatchPulseStatus().running, false);
      });
      await startMatchPulse(config);
      assert.equal(getMatchPulseStatus().running, true);
      assert.equal(getMatchPulseStatus().tradeCount, 0); // never fires on deploy
      assert.equal(currentTradingOwner(), "match-pulse");
      await assert.rejects(() => startMatchPulse(config), /already active/);
      const push = (digit: number) => {
        const before = tape.snapshot(selectedSymbol)!.tick;
        tape.push({ symbol: selectedSymbol, price: 100 + digit / 100, digit,
          epoch: before.epoch + 2, receivedAt: Date.now(), source: "simulated" });
        tickManager.emit("tick", { symbol: selectedSymbol });
      };
      for (let i = 0; i < 3; i++) push(7);
      await delay(20);
      assert.equal(getMatchPulseStatus().pulse.pending, null);
      push(7);
      await until(() => getMatchPulseStatus().pulse.phase === "settling");
      const journalId = getMatchPulseStatus().pulse.pending!.journalId;
      assert.equal(getMatchPulseStatus().tradeCount, 0);
      stopMatchPulse();
      assert.equal(getMatchPulseStatus().running, true, "the outstanding paper tick still needs settlement");
      assert.equal(acquireTradingOwnership("bots"), false, "stop cannot release an in-flight order's lease");
      push(7); // IDENTICAL digit, but a distinct next tick — this MUST settle a win.
      await until(() => !getMatchPulseStatus().running);
      const status = getMatchPulseStatus();
      assert.equal(status.tradeCount, 1);
      assert.equal(status.winCount, 1);
      assert.equal(status.totalProfit, 7.93);
      assert.equal(currentTradingOwner(), null);
      assert.deepEqual({ ...recovery.getState() }, realLedger, "paper does not alter live recovery debt");
      push(7);
      push(7);
      await delay(30);
      assert.equal(getMatchPulseStatus().tradeCount, 1, "stopped sessions cannot execute or settle twice");
      const [row] = await db.select().from(tradesTable).where(eq(tradesTable.id, journalId));
      assert.equal(row!.status, "won");
      assert.equal(row!.contractType, "DIGITMATCH");
      assert.equal(row!.barrier, 7);
      assert.equal(Number(row!.profit), 7.93);
      const liveScan = await scanMatchPulse({ executionMode: "live" });
      assert.equal(liveScan.qualifiedCount, 0, "even a perfect simulated sequence cannot qualify live funds");
      assert.ok(liveScan.candidates.every(c => c.reasons.includes("Simulated data cannot qualify a live order")));
    });
  } finally {
    runWithSessionId(owner, () => stopMatchPulse());
    tickManager.getDigitSnapshot = original;
  }
});


const interruptedConfig = {
  scanId: "f1000000-0000-0000-0000-000000000001", selectedSymbol: "R_100",
  executionMode: "live", marketMode: "locked", stake: 1, stopLoss: 5, takeProfit: 20,
  maxRecoverySteps: 3, maxConsecutiveLosses: 6,
};
function interruptedMeta() {
  return JSON.stringify({ bot: "match-pulse", botSession: "interrupted-session", mode: "live",
    config: interruptedConfig, accountId: "fake-broker-account", payout: 8.93, reference: "interrupted-order",
    decision: { symbol: "R_100", sequence: 2400, generation: 1, source: "live", epoch: 100,
      receivedAt: 100_000, price: 100.07, digit: 7 } });
}
async function interruptedRow(owner: string, metadata = interruptedMeta(), contractId: string | null = "123") {
  return (await db.insert(tradesTable).values({ sessionId: owner, symbol: "R_100", displayName: "Volatility 100",
    contractType: "DIGITMATCH", barrier: 7, stake: "1", direction: "hold", duration: 1, durationUnit: "t",
    status: contractId ? "mp-open" : "mp-pending", derivContractId: contractId, agentReasoning: metadata }).returning())[0]!;
}
async function cleanInterrupted(owner: string) {
  await db.delete(tradesTable).where(eq(tradesTable.sessionId, owner));
  await db.delete(settingsTable).where(eq(settingsTable.sessionId, owner));
  runWithSessionId(owner, () => releaseTradingOwnership("match-pulse"));
}

it("restores a known live contract and its persisted account debt, without auto-resuming or re-buying", async () => {
  await schemaReady;
  const owner = "f1000000-0000-0000-0000-000000000002";
  const debt = recovery.reduceRecoveryOutcome(recovery.createRecoveryState(), false, -3, 3, 3, "DIGITMATCH", 8.93);
  await db.insert(settingsTable).values({ sessionId: owner, recoveryStateJson: JSON.stringify(debt) });
  const row = await interruptedRow(owner);
  try {
    await restoreMatchPulseHolds();
    await runWithSessionId(owner, async () => {
      const status = getMatchPulseStatus();
      assert.equal(status.running, true);
      assert.equal(status.pulse.executionMode, "live");
      assert.equal(status.pulse.stopRequested, true);
      assert.equal(status.pulse.phase, "reconciling");
      assert.equal(status.pulse.pending!.contractId, 123);
      assert.equal(status.pulse.reconciliationIssue, null);
      assert.equal(status.unrecoveredAmount, 3);
      stopMatchPulse();
      await reconcileMatchPulse(); // no broker credentials in this fixture: retain the hold
      assert.equal(currentTradingOwner(), "match-pulse");
      assert.equal(getMatchPulseStatus().tradeCount, 0);
      assert.equal(acquireTradingOwnership("bots"), false);
      const [stillPending] = await db.select().from(tradesTable).where(eq(tradesTable.id, row.id));
      assert.equal(stillPending!.status, "mp-open");
    });
  } finally { await cleanInterrupted(owner); }
});

it("malformed interrupted journals create a visible live hold that stop/reconcile cannot release", async () => {
  await schemaReady;
  const owner = "f1000000-0000-0000-0000-000000000003";
  await interruptedRow(owner, "{not-json");
  try {
    await restoreMatchPulseHolds();
    await runWithSessionId(owner, async () => {
      const status = getMatchPulseStatus();
      assert.equal(status.running, true);
      assert.equal(status.pulse.executionMode, "live");
      assert.match(status.pulse.reconciliationIssue!, /invalid interrupted-order metadata/);
      assert.equal(status.pulse.pending, null);
      stopMatchPulse();
      await reconcileMatchPulse();
      assert.equal(getMatchPulseStatus().running, true);
      assert.equal(acquireTradingOwnership("bots"), false);
      assert.equal(currentTradingOwner(), "match-pulse");
    });
  } finally { await cleanInterrupted(owner); }
});

it("multiple interrupted buys cannot restore only the first and then release over unresolved exposure", async () => {
  await schemaReady;
  const owner = "f1000000-0000-0000-0000-000000000004";
  await interruptedRow(owner);
  await interruptedRow(owner, interruptedMeta(), "124");
  try {
    await restoreMatchPulseHolds();
    await runWithSessionId(owner, async () => {
      assert.match(getMatchPulseStatus().pulse.reconciliationIssue!, /multiple interrupted live orders/);
      assert.equal(getMatchPulseStatus().pulse.pending, null);
      stopMatchPulse();
      await reconcileMatchPulse();
      assert.equal(currentTradingOwner(), "match-pulse");
      assert.equal(getMatchPulseStatus().tradeCount, 0);
      assert.equal(getMatchPulseStatus().running, true);
    });
  } finally { await cleanInterrupted(owner); }
});


function brokerFixtureTape() {
  const tape = new DigitTape();
  for (let i = 0; i < 2400; i++) tape.push({ symbol: "R_100", price: 100.07,
    digit: 7, epoch: i * 2, receivedAt: Date.now(), source: "live" });
  return tape;
}
for (const isVirtual of [true, false]) {
  it(`selected ${isVirtual ? "demo" : "real"} account arms broker execution automatically, never a local paper session`, async () => {
    await schemaReady;
    const owner = isVirtual ? "f2000000-0000-0000-0000-000000000001" : "f2000000-0000-0000-0000-000000000002";
    const accountId = isVirtual ? "fixture-demo" : "fixture-real";
    const loginId = isVirtual ? "VRTC-FIXTURE" : "CR-FIXTURE";
    await db.insert(accountsTable).values({ sessionId: owner, loginId, derivAccountId: accountId,
      bearerToken: `offline-fixture-${accountId}`, isVirtual, isActive: true, currency: "USD" });
    const tape = brokerFixtureTape();
    const originalSnapshot = tickManager.getDigitSnapshot;
    const originalFetch = globalThis.fetch;
    let balanceRequests = 0;
    tickManager.getDigitSnapshot = (symbol, count) => tape.snapshot(symbol, count);
    globalThis.fetch = async input => {
      assert.ok(String(input).endsWith("/trading/v1/options/accounts"), "No order/OTP calls are permitted in this fixture");
      balanceRequests++;
      return new Response(JSON.stringify({ data: [{ account_id: accountId, account_type: isVirtual ? "demo" : "real", status: "active", balance: 1000, currency: "USD" }] }), { status: 200 });
    };
    try {
      await runWithSessionId(owner, async () => {
        const scan = await scanMatchPulse(parsePulseAccountScan({}));
        assert.equal(scan.account?.isVirtual, isVirtual);
        assert.equal(scan.account?.loginId, loginId);
        assert.equal(scan.qualifiedCount, 1);
        assert.equal("executionMode" in scan, false);
        assert.equal("lockedDigit" in scan, false);
        const config = parsePulseAccountConfig({ scanId: scan.scanId, selectedSymbol: "R_100", marketMode: "locked", stake: 1, stopLoss: 5, takeProfit: 10 });
        await startMatchPulse(config);
        const status = getMatchPulseStatus();
        assert.equal(status.pulse.executionMode, "live");
        assert.equal(status.pulse.account?.id, accountId);
        assert.equal(status.pulse.account?.isVirtual, isVirtual);
        assert.match(status.message, isVirtual ? /Demo account armed/ : /Real account armed/);
        assert.equal(status.pulse.config?.lockedDigit, undefined);
        assert.equal(status.tradeCount, 0, "arming never buys at deployment time");
        assert.equal(balanceRequests, 1, "demo and real both verify a broker balance");
        stopMatchPulse();
        assert.equal(currentTradingOwner(), null);
      });
    } finally {
      runWithSessionId(owner, () => stopMatchPulse());
      tickManager.getDigitSnapshot = originalSnapshot;
      globalThis.fetch = originalFetch;
      await db.delete(accountsTable).where(eq(accountsTable.sessionId, owner));
      await cleanInterrupted(owner);
    }
  });
}

it("changing the selected demo/real account after a scan requires a new receipt", async () => {
  await schemaReady;
  const owner = "f2000000-0000-0000-0000-000000000003";
  await db.insert(accountsTable).values({ sessionId: owner, loginId: "VRTC-OLD", derivAccountId: "fixture-old-account",
    bearerToken: "offline-fixture-switch", isVirtual: true, isActive: true });
  const tape = brokerFixtureTape();
  const original = tickManager.getDigitSnapshot;
  tickManager.getDigitSnapshot = (symbol, count) => tape.snapshot(symbol, count);
  try {
    await runWithSessionId(owner, async () => {
      const scan = await scanMatchPulse(parsePulseAccountScan({}));
      await db.update(accountsTable).set({ loginId: "CR-NEW", derivAccountId: "fixture-new-account", isVirtual: false }).where(eq(accountsTable.sessionId, owner));
      await assert.rejects(() => startMatchPulse(parsePulseAccountConfig({ scanId: scan.scanId, selectedSymbol: "R_100", marketMode: "switching", stake: 1, stopLoss: 5, takeProfit: 10 })), /connected account changed/);
      assert.equal(getMatchPulseStatus().running, false);
      assert.equal(currentTradingOwner(), null);
    });
  } finally {
    tickManager.getDigitSnapshot = original;
    await db.delete(accountsTable).where(eq(accountsTable.sessionId, owner));
    await cleanInterrupted(owner);
  }
});
