/**
 * Routes for Digit Forge — the DBot factory bot.
 *
 * Digit Forge has NO scan and NO engine: it never analyses anything server-side
 * and it never takes a trade. The console collects settings, this route renders
 * a Deriv Bot (Blockly) strategy that carries its OWN analysis, and the web app
 * hands that XML to the embedded Deriv bot builder. From there Deriv's own Run
 * button owns execution.
 *
 * That makes these endpoints pure functions of the request plus the session's
 * risk settings — there is no session state to isolate, unlike every other bot
 * route here.
 */

import { Router } from "express";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import { logger } from "../lib/logger";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { OVER_PAYOUTS, UNDER_PAYOUTS } from "../lib/payouts";
import {
  buildDigitForgeStrategy,
  fairWinRate,
  ladderRisk,
  type DigitForgeInput,
} from "../lib/digit-forge-dbot";
import {
  TURBO_NORMAL_CONTRACTS,
  TURBO_RECOVERY_CONTRACTS,
} from "../lib/overunder-turbo-engine";
import {
  contractLabel,
  isNormalContract,
  isRecoveryContract,
  type TurboContract,
  type TurboSide,
} from "../lib/overunder-turbo-analysis";

const router = Router();

/** Canonical total-return multiplier for a digit barrier. */
function payoutFor(c: TurboContract): number {
  const table = c.side === "DIGITOVER" ? OVER_PAYOUTS : UNDER_PAYOUTS;
  return table[c.barrier] ?? (c.side === "DIGITOVER" ? OVER_PAYOUTS[4]! : UNDER_PAYOUTS[5]!);
}

function parseContract(raw: any): TurboContract | null {
  if (!raw) return null;
  const side: TurboSide | null =
    raw.side === "DIGITOVER" || raw.side === "DIGITUNDER" ? raw.side : null;
  const barrier = Number(raw.barrier);
  if (!side || !Number.isInteger(barrier)) return null;
  return { side, barrier };
}

/** The user's risk settings — the same two the executors read. */
async function riskSettings(sessionId: string): Promise<{ markupPercent: number; maxStake: number }> {
  let markupPercent = 10;
  let maxStake = 500;
  try {
    const rows = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.sessionId, sessionId))
      .limit(1);
    if (rows.length > 0) {
      const v = Number((rows[0] as any).botRecoveryMarkup);
      if (Number.isFinite(v)) markupPercent = v;
      const m = Number((rows[0] as any).maxTradeStake);
      if (Number.isFinite(m) && m > 0) maxStake = m;
    }
  } catch {
    /* defaults */
  }
  return { markupPercent, maxStake };
}

/** Account currency — the builder's trade options are denominated in it. */
async function accountCurrency(sessionId: string): Promise<string> {
  try {
    let accounts = await db
      .select()
      .from(accountsTable)
      .where(and(eq(accountsTable.sessionId, sessionId), eq(accountsTable.isActive, true)))
      .limit(1);
    if (accounts.length === 0) {
      accounts = await db.select().from(accountsTable).where(eq(accountsTable.sessionId, sessionId)).limit(1);
    }
    if (accounts[0]?.currency) return accounts[0].currency;
  } catch {
    /* default */
  }
  return "USD";
}

/**
 * Everything the console needs to render its form without hardcoding the
 * vocabulary: the legal barriers, the digit markets and the canonical payouts.
 */
router.get("/options", (_req, res) => {
  res.json({
    normal: TURBO_NORMAL_CONTRACTS.map((c) => ({
      ...c,
      label: contractLabel(c),
      payout: payoutFor(c),
      fairWinRate: fairWinRate(c),
      breakEven: Math.round((1 / payoutFor(c)) * 10000) / 10000,
    })),
    recovery: TURBO_RECOVERY_CONTRACTS.map((c) => ({
      ...c,
      label: contractLabel(c),
      payout: payoutFor(c),
      fairWinRate: fairWinRate(c),
      breakEven: Math.round((1 / payoutFor(c)) * 10000) / 10000,
    })),
    markets: AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled).map((m) => ({
      symbol: m.symbol,
      displayName: m.displayName,
    })),
  });
});

/**
 * Build the strategy. Nothing starts here — the web app posts the XML into the
 * embedded Deriv bot builder, the user verifies the blocks and presses Run.
 */
router.post("/dbot", async (req, res): Promise<void> => {
  const body = req.body ?? {};

  const normal = parseContract(body.normal);
  const recovery = parseContract(body.recovery);
  if (!normal || !isNormalContract(normal.side, normal.barrier)) {
    res.status(400).json({ error: "normal must be one of Over 1, Over 2, Under 7, Under 8" });
    return;
  }
  if (!recovery || !isRecoveryContract(recovery.side, recovery.barrier)) {
    res.status(400).json({ error: "recovery must be one of Over 4, Over 5, Under 4, Under 5" });
    return;
  }

  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const market = isAutomatedMarket(symbol)
    ? AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol)
    : undefined;
  if (!market?.digitEnabled) {
    res.status(400).json({ error: "Choose a digit-enabled market" });
    return;
  }

  const stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  // Rotator candidates are validated here so the phase-4 switch can never be
  // handed a market the app does not trade.
  const requestedWatchMarkets = Array.isArray(body.watchMarkets)
    ? (body.watchMarkets as unknown[]).filter((s): s is string => typeof s === "string" && isAutomatedMarket(s))
    : [];
  // Adaptive mode is the default: if the client does not provide a watchlist,
  // seed it from every digit-enabled market (the generator caps subscriptions
  // at eight and always keeps the selected starting market first).
  const watchMarkets = (requestedWatchMarkets.length > 0
    ? requestedWatchMarkets
    : AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled).map((m) => m.symbol))
    .slice(0, 8);

  try {
    const [{ markupPercent, maxStake }, currency] = await Promise.all([
      riskSettings(req.sessionId),
      accountCurrency(req.sessionId),
    ]);

    const input: DigitForgeInput = {
      symbol: market.symbol,
      displayName: market.displayName,
      normal,
      recovery,
      stake,
      takeProfit: Number(body.takeProfit) > 0 ? Number(body.takeProfit) : 10,
      stopLoss: Number(body.stopLoss) > 0 ? Number(body.stopLoss) : 5,
      maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
      markupPercent,
      maxStake,
      normalPayout: payoutFor(normal),
      recoveryPayout: payoutFor(recovery),
      breakerDepth: Math.max(3, Math.min(20, Number(body.breakerDepth) || 6)),
      currency,
      window: Number(body.window) > 0 ? Number(body.window) : undefined,
      minSamples: Number(body.minSamples) > 0 ? Number(body.minSamples) : undefined,
      confidenceZ: Number.isFinite(Number(body.confidenceZ)) ? Number(body.confidenceZ) : undefined,
      forceEntryAfter: Number.isFinite(Number(body.forceEntryAfter)) ? Number(body.forceEntryAfter) : undefined,
      useMarkov: body.useMarkov !== false,
      useStreakCooldown: body.useStreakCooldown !== false,
      watchMarkets,
    };

    const strategy = buildDigitForgeStrategy(input);
    res.json({ ok: true, ...strategy });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not build the strategy";
    logger.warn({ err }, "digit-forge dbot build failed");
    res.status(400).json({ error: message });
  }
});

/**
 * Risk preview for the panel — the same ladder arithmetic the generated bot
 * runs, so the user sees the capital a ladder can consume BEFORE they build it.
 */
router.post("/risk", async (req, res): Promise<void> => {
  const recovery = parseContract(req.body?.recovery);
  if (!recovery || !isRecoveryContract(recovery.side, recovery.barrier)) {
    res.status(400).json({ error: "recovery must be one of Over 4, Over 5, Under 4, Under 5" });
    return;
  }
  const depth = Math.max(1, Math.min(10, Number(req.body?.maxRecoverySteps) || 3));
  const stake = Number(req.body?.stake) > 0 ? Number(req.body.stake) : 1;
  const { markupPercent } = await riskSettings(req.sessionId);
  const payout = payoutFor(recovery);
  const ladder = ladderRisk(payout, markupPercent, depth, fairWinRate(recovery));
  res.json({
    ...ladder,
    payout,
    markupPercent,
    depth,
    stake,
    capitalAtRiskMoney: Math.round(ladder.capitalAtRisk * stake * 100) / 100,
  });
});

export default router;
