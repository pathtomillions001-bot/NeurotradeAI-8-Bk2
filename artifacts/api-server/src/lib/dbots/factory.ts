/**
 * DBot factory — ONE call turns a scanner's decision into a tradeable bot.
 *
 * WHY THIS EXISTS
 * ───────────────
 * "Create Deriv DBot" has to work for every scanner this app will ever ship
 * (Over/Under Turbo today; Kill-Shot, Dual-Lock, … next). So the scanner-facing
 * entry point is deliberately small — `createDbot({ source, market, normal,
 * recovery, … })` — and everything scanner-specific (which contracts a scan may
 * hand over, where the numbers come from) lives in a thin adapter beside it.
 *
 * What the factory guarantees, for every caller:
 *   - the spec is seeded from the SAME shared recovery ledger the server
 *     engines use (`recovery-engine.getState()`), never a private one,
 *   - the recovery payout multiplier comes from the app's own resolver
 *     (live proposal when available, the canonical schedule otherwise),
 *   - the bot is compiled (strategy-xml.ts) and registered for THIS browser
 *     session and THIS account — a DBot can never be built for another one,
 *   - the compiled program's name, contracts and seed are stored so the Bot
 *     Studio page and the run panel can show exactly what will trade.
 */

import { randomUUID } from "node:crypto";
import { db, settingsTable, accountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getMarketInfo, isAutomatedMarket } from "../deriv";
import { resolveRecoveryPayout } from "../recovery-payout";
import { getState as getRecoveryState } from "../agents/recovery-engine";
import { logger } from "../logger";
import { runWithSessionId } from "../session";
import { compileStrategyXml, type DbotContract, type DbotStrategySpec } from "./strategy-xml";
import { saveDbot, type DbotRecord } from "./registry";

/** Console contract id this factory's first adapter produces. */
export const TURBO_DBOT_CONSOLE = "overunder-turbo@2";

/**
 * Where a symbol lives in the builder's market → submarket → symbol dropdowns.
 *
 * The builder's trade_definition_market block groups symbols by Deriv's
 * submarket, and a saved bot that names a symbol outside its submarket would
 * show up in the wrong place in the UI. Every synthetic this app trades is
 * `synthetic_index`; the submarket follows the family:
 *   R_* / 1HZ* (Volatility)      → random_index  ("Continuous Indices")
 *   RDBULL / RDBEAR (Bull/Bear)  → random_daily  ("Daily Reset Indices")
 *   JD* (Jump)                   → jump_index
 */
export function derivMarketLocation(symbol: string): { market: string; submarket: string } {
  if (symbol.startsWith("JD")) return { market: "synthetic_index", submarket: "jump_index" };
  if (symbol === "RDBULL" || symbol === "RDBEAR") return { market: "synthetic_index", submarket: "random_daily" };
  return { market: "synthetic_index", submarket: "random_index" };
}

export interface DbotSettingsSnapshot {
  stake: number;
  maxTradeStake: number | null;
  markupPercent: number;
  maxRecoverySteps: number;
  takeProfit: number;
  stopLoss: number;
}

/**
 * The payout resolver the ladder is calibrated on (live proposal first, the
 * canonical schedule as fallback). Injectable so tests never wait on a Deriv
 * round-trip — production always uses `resolveRecoveryPayout`.
 */
type PayoutResolver = typeof resolveRecoveryPayout;
let resolvePayout: PayoutResolver = resolveRecoveryPayout;

export function __setRecoveryPayoutResolverForTests(resolver: PayoutResolver | null): void {
  resolvePayout = resolver ?? resolveRecoveryPayout;
}

/** The account's risk/recovery settings, with the app's documented defaults. */
export async function readDbotSettings(sessionId: string): Promise<DbotSettingsSnapshot> {
  const fallback: DbotSettingsSnapshot = {
    stake: 1,
    maxTradeStake: null,
    markupPercent: 10,
    maxRecoverySteps: 3,
    takeProfit: 10,
    stopLoss: 5,
  };
  try {
    const rows = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, sessionId)).limit(1);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return fallback;
    const num = (value: unknown, fallbackValue: number): number => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : fallbackValue;
    };
    const maxTradeStake = Number(row["maxTradeStake"]);
    return {
      stake: num(row["riskAmountValue"], fallback.stake),
      maxTradeStake: Number.isFinite(maxTradeStake) && maxTradeStake > 0 ? maxTradeStake : null,
      markupPercent: Number.isFinite(Number(row["botRecoveryMarkup"])) ? Number(row["botRecoveryMarkup"]) : fallback.markupPercent,
      maxRecoverySteps: Math.max(1, Math.round(num(row["maxRecoverySteps"], fallback.maxRecoverySteps))),
      takeProfit: fallback.takeProfit,
      stopLoss: fallback.stopLoss,
    };
  } catch (err) {
    logger.warn({ err, sessionId }, "dbots: could not read settings — using defaults");
    return fallback;
  }
}

/** The session's active account (the only account a DBot may be built for). */
export async function activeAccountForSession(sessionId: string) {
  const active = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.sessionId, sessionId), eq(accountsTable.isActive, true)))
    .limit(1);
  if (active.length > 0) return active[0]!;
  const any = await db.select().from(accountsTable).where(eq(accountsTable.sessionId, sessionId)).limit(1);
  return any[0] ?? null;
}

/** Scanner-agnostic creation input. */
export interface CreateDbotInput {
  /** Which console asked for this bot (provenance + the console contract id). */
  source: { console: string; botId: string };
  /** Deriv symbol the bot must trade. */
  symbol: string;
  /** Human market name for the run panel. */
  displayName?: string;
  normal: DbotContract;
  recovery: DbotContract;
  /** Optional overrides; anything missing comes from the account's settings. */
  stake?: number;
  takeProfit?: number;
  stopLoss?: number;
  maxRecoverySteps?: number;
  /** Trade-type category/type; the Over/Under adapter passes digits/overunder. */
  tradeType?: { category: string; type: string };
}

export type CreateDbotResult =
  | { ok: true; record: DbotRecord }
  | { ok: false; status: number; error: string };

/**
 * Build + register a DBot for the session's ACTIVE account.
 *
 * Demo vs real is not an argument: it is whatever the platform has active, and
 * the builder is handed an OTP for that account when it runs.
 */
export async function createDbot(
  sessionId: string,
  input: CreateDbotInput,
  /** Overridable for tests — defaults to the account's saved settings. */
  settingsOverride?: DbotSettingsSnapshot,
): Promise<CreateDbotResult> {
  if (!isAutomatedMarket(input.symbol)) {
    return { ok: false, status: 400, error: `${input.symbol} is not an automatically tradeable market` };
  }
  const marketInfo = getMarketInfo(input.symbol);
  const displayName = input.displayName ?? marketInfo?.displayName ?? input.symbol;

  const account = await activeAccountForSession(sessionId);
  if (!account) {
    return { ok: false, status: 409, error: "Connect a Deriv account before creating a DBot." };
  }

  const settings = settingsOverride ?? (await readDbotSettings(sessionId));
  const stake = input.stake && input.stake > 0 ? input.stake : settings.stake;
  const takeProfit = input.takeProfit && input.takeProfit > 0 ? input.takeProfit : settings.takeProfit;
  const stopLoss = input.stopLoss && input.stopLoss > 0 ? input.stopLoss : settings.stopLoss;
  const maxRecoverySteps = input.maxRecoverySteps && input.maxRecoverySteps > 0
    ? Math.round(input.maxRecoverySteps)
    : settings.maxRecoverySteps;

  // Seed from the app's single shared recovery ledger — the same state the
  // server engines read, so a DBot started after server losses recovers THAT
  // debt instead of pretending the account is flat.
  // Read the shared ledger AS THIS SESSION, and read the NUMBER inside that
  // context: the ledger is an AsyncLocalStorage-routed proxy, so touching a
  // field after the callback returns would silently read another session's
  // (usually empty) state — and every DBot would build as debt-free.
  const debt = runWithSessionId(sessionId, () => {
    const ledger = getRecoveryState();
    return Math.max(0, Number(ledger.unrecoveredAmount ?? 0));
  });

  // The ladder's multiplier: the app's own recovery payout resolver (live
  // proposal first, canonical schedule as fallback) for the recovery leg.
  let payoutMultiplier = 1.95;
  try {
    const quote = await resolvePayout({
      symbol: input.symbol,
      contractType: input.recovery.contractType,
      barrier: input.recovery.prediction,
      duration: 1,
      durationUnit: "t",
      currency: account.currency ?? "USD",
    });
    if (Number.isFinite(quote.payoutMultiplier) && quote.payoutMultiplier > 1.01) {
      payoutMultiplier = quote.payoutMultiplier;
    }
  } catch (err) {
    logger.warn({ err, symbol: input.symbol }, "dbots: payout quote failed — using fallback multiplier");
  }

  const { market, submarket } = derivMarketLocation(input.symbol);
  const id = `dbot_${randomUUID()}`;
  const spec: DbotStrategySpec = {
    id,
    name: `NeuroTrade · ${displayName}`,
    source: {
      console: input.source.console,
      botId: input.source.botId,
      accountId: account.derivAccountId || account.loginId,
      isVirtual: Boolean(account.isVirtual),
    },
    market: { symbol: input.symbol, displayName, market, submarket },
    tradeType: input.tradeType ?? { category: "digits", type: "overunder" },
    contractTypes: [input.normal.contractType, input.recovery.contractType],
    stake: { initial: stake, max: settings.maxTradeStake },
    duration: { value: 1, unit: "t" },
    normal: input.normal,
    recovery: input.recovery,
    recoveryState: {
      debt,
      markupPercent: settings.markupPercent,
      maxSteps: maxRecoverySteps,
      payoutMultiplier,
    },
    limits: { takeProfit, stopLoss },
    currency: account.currency ?? "USD",
  };

  const compiled = compileStrategyXml(spec);
  const record: DbotRecord = {
    id,
    sessionId,
    accountId: spec.source.accountId,
    isVirtual: spec.source.isVirtual,
    name: compiled.name,
    symbol: spec.market.symbol,
    displayName: spec.market.displayName,
    contractTypes: spec.contractTypes,
    xml: compiled.xml,
    spec,
    createdAt: Date.now(),
    live: false,
    liveSince: null,
    lastSeenAt: null,
    lastMirroredAt: null,
    stoppedAt: null,
    stopReason: null,
    fills: [],
    stopRequestedAt: null,
  };
  saveDbot(record);
  logger.info(
    { sessionId, dbotId: id, symbol: spec.market.symbol, debt, stake, markupPercent: settings.markupPercent },
    "dbots: created Deriv DBot from scan",
  );
  return { ok: true, record };
}
