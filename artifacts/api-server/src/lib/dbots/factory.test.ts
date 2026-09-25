/**
 * DBot factory — one call from a scan to a tradeable, account-bound bot.
 *
 * What must never regress:
 *   1. A DBot is built for the session's ACTIVE account only — never another
 *      session's, never an account the user did not select. Demo stays demo.
 *   2. The bot is SEEDED from the app's single shared recovery ledger (the same
 *      state the server engines read), so a DBot started after server-side
 *      losses recovers that debt instead of pretending the account is flat.
 *   3. Only markets the app may trade automatically and only contracts the scan
 *      could itself deploy can become a DBot.
 *   4. The compiled program carries the scan's decision: symbol, both legs, the
 *      stake, the markup and the SL/TP.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  createDbot,
  derivMarketLocation,
  readDbotSettings,
  __setRecoveryPayoutResolverForTests,
  TURBO_DBOT_CONSOLE,
} from "./factory.ts";
import { __resetDbotsForTests, getDbot } from "./registry.ts";
import * as recoveryEngine from "../agents/recovery-engine.ts";
import { runWithSessionId } from "../session.ts";

const SESSION_A = "session-a-dbot-factory";
const SESSION_B = "session-b-dbot-factory";

const TURBO_INPUT = {
  source: { console: TURBO_DBOT_CONSOLE, botId: "overunder-turbo" },
  symbol: "R_100",
  displayName: "Volatility 100 Index",
  normal: { contractType: "DIGITOVER", prediction: 1 },
  recovery: { contractType: "DIGITUNDER", prediction: 5 },
};

/** Deterministic payout: 1.95× for every recovery leg. */
const FIXED_PAYOUT = async () => ({ payoutMultiplier: 1.95, source: "fallback" as const });

async function resetAccounts() {
  await db.delete(accountsTable);
  await db.delete(settingsTable);
  __resetDbotsForTests();
  recoveryEngine.resetAll();
  __setRecoveryPayoutResolverForTests(FIXED_PAYOUT);
}

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_A,
    loginId: "VRTC90000011",
    derivAccountId: "VRTC90000011",
    currency: "USD",
    balance: "1000.00",
    isVirtual: true,
    isActive: true,
    ...overrides,
  };
}

describe("dbot factory", () => {
  beforeEach(resetAccounts);
  after(() => __setRecoveryPayoutResolverForTests(null));

  it("maps every synthetic family to its builder submarket", () => {
    assert.deepEqual(derivMarketLocation("R_100"), { market: "synthetic_index", submarket: "random_index" });
    assert.deepEqual(derivMarketLocation("1HZ100V"), { market: "synthetic_index", submarket: "random_index" });
    assert.deepEqual(derivMarketLocation("RDBULL"), { market: "synthetic_index", submarket: "random_daily" });
    assert.deepEqual(derivMarketLocation("JD10"), { market: "synthetic_index", submarket: "jump_index" });
  });

  it("refuses to build without a connected account", async () => {
    const result = await createDbot(SESSION_A, TURBO_INPUT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 409);
    assert.match(result.error, /Connect a Deriv account/i);
  });

  it("refuses a manual-only market", async () => {
    await db.insert(accountsTable).values(accountRow());
    const result = await createDbot(SESSION_A, { ...TURBO_INPUT, symbol: "JD100" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.error, /not an automatically tradeable market/i);
  });

  it("binds the bot to the session's ACTIVE account", async () => {
    // Two linked accounts: the demo one is active, the real one is not.
    await db.insert(accountsTable).values([
      accountRow(),
      accountRow({ loginId: "CR90000022", derivAccountId: "CR90000022", isVirtual: false, isActive: false }),
    ]);

    const result = await createDbot(SESSION_A, TURBO_INPUT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.accountId, "VRTC90000011");
    assert.equal(result.record.isVirtual, true);
    assert.equal(result.record.spec.source.isVirtual, true);
    assert.equal(result.record.spec.source.console, TURBO_DBOT_CONSOLE);
    assert.equal(result.record.spec.currency, "USD");
  });

  it("uses another session's account only for that session's bot", async () => {
    await db.insert(accountsTable).values([
      accountRow(),
      accountRow({
        sessionId: SESSION_B,
        loginId: "CR90000033",
        derivAccountId: "CR90000033",
        isVirtual: false,
        isActive: true,
      }),
    ]);

    const a = await createDbot(SESSION_A, TURBO_INPUT);
    const b = await createDbot(SESSION_B, TURBO_INPUT);
    assert.equal(a.ok && a.record.accountId, "VRTC90000011");
    assert.equal(b.ok && b.record.accountId, "CR90000033");
    assert.equal(b.ok && b.record.isVirtual, false);
    // The two sessions' bots are separate records, not a shared one.
    assert.notEqual(a.ok && a.record.id, b.ok && b.record.id);
  });

  it("reads the account's risk settings, with the app's defaults as fallback", async () => {
    const defaults = await readDbotSettings(SESSION_A);
    assert.deepEqual(defaults, {
      stake: 1,
      maxTradeStake: null,
      markupPercent: 10,
      maxRecoverySteps: 3,
      takeProfit: 10,
      stopLoss: 5,
    });

    await db.insert(settingsTable).values({
      sessionId: SESSION_A,
      riskAmountValue: "2.50",
      maxTradeStake: "25.00",
      botRecoveryMarkup: "25",
      maxRecoverySteps: 4,
      riskAmountType: "fixed",
    } as never);
    const saved = await readDbotSettings(SESSION_A);
    assert.equal(saved.stake, 2.5);
    assert.equal(saved.maxTradeStake, 25);
    assert.equal(saved.markupPercent, 25);
    assert.equal(saved.maxRecoverySteps, 4);
  });

  it("seeds the ladder from the SHARED ledger and compiles the scan's decision", async () => {
    await db.insert(accountsTable).values(accountRow());
    await db.insert(settingsTable).values({
      sessionId: SESSION_A,
      riskAmountValue: "2.00",
      botRecoveryMarkup: "20",
      maxRecoverySteps: 5,
      riskAmountType: "fixed",
    } as never);

    // A server-side engine lost $3 on this account: the DBot must recover it.
    runWithSessionId(SESSION_A, () => recoveryEngine.recordOutcome(false, -3, 3, 3, "DIGITOVER", 1.95));
    const debt = runWithSessionId(SESSION_A, () => recoveryEngine.getState().unrecoveredAmount);
    assert.equal(debt, 3);

    const result = await createDbot(SESSION_A, TURBO_INPUT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const spec = result.record.spec;

    assert.equal(spec.recoveryState.debt, 3);
    assert.equal(spec.recoveryState.markupPercent, 20);
    assert.equal(spec.recoveryState.maxSteps, 5);
    assert.equal(spec.recoveryState.payoutMultiplier, 1.95);
    assert.equal(spec.stake.initial, 2);
    // The settings table's own default cap ($500) is part of the bot: the
    // builder's ladder never sizes a stake above it.
    assert.equal(spec.stake.max, 500);
    assert.deepEqual(spec.contractTypes, ["DIGITOVER", "DIGITUNDER"]);
    assert.deepEqual(spec.limits, { takeProfit: 10, stopLoss: 5 });

    // The generated program names the market, carries the scan's legs and holds
    // the ladder's seed values.
    const xml = result.record.xml;
    assert.match(xml, /is_dbot="true"/);
    assert.match(xml, /collection="false"/);
    assert.match(xml, /<field name="SYMBOL_LIST">R_100<\/field>/);
    assert.match(xml, /<field name="PURCHASE_LIST">DIGITOVER<\/field>/);
    assert.match(xml, /<field name="PURCHASE_LIST">DIGITUNDER<\/field>/);
    assert.match(xml, /has_prediction="true"/);
    assert.match(xml, /<block type="trade_definition"/);
    assert.match(xml, /NeuroTrade Ladder/);
    assert.match(xml, /nt_dbot_debt/);
    // The seed is the ledger's debt, and the markup is the user's setting.
    assert.match(xml, /<field name="NUM">3<\/field>/);
    assert.match(xml, /<field name="NUM">20<\/field>/);
    assert.match(xml, /<field name="NUM">1.95<\/field>/);

    // Stored under the requesting session only.
    assert.ok(getDbot(SESSION_A, result.record.id));
    assert.equal(getDbot(SESSION_B, result.record.id), null);
  });

  it("lets explicit overrides win over saved settings", async () => {
    await db.insert(accountsTable).values(accountRow());
    const result = await createDbot(SESSION_A, {
      ...TURBO_INPUT,
      stake: 7.5,
      takeProfit: 40,
      stopLoss: 12,
      maxRecoverySteps: 2,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.spec.stake.initial, 7.5);
    assert.deepEqual(result.record.spec.limits, { takeProfit: 40, stopLoss: 12 });
    assert.equal(result.record.spec.recoveryState.maxSteps, 2);
  });

  it("marks the record's account fields from the spec", async () => {
    await db.insert(accountsTable).values(accountRow());
    const result = await createDbot(SESSION_A, TURBO_INPUT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.sessionId, SESSION_A);
    assert.equal(result.record.name.startsWith("NeuroTrade · "), true);
    assert.equal(result.record.live, false);
    assert.deepEqual(result.record.fills, []);
    assert.equal(result.record.symbol, "R_100");
  });
});
