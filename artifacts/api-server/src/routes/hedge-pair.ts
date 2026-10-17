/** Pair Forge factory route. This route emits XML only; it cannot execute trades. */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { accountsTable, db, settingsTable } from "@workspace/db";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import { logger } from "../lib/logger";
import { buildHedgePairStrategy, type HedgePairInput } from "../lib/hedge-pair-dbot";

const router = Router();

async function userRiskSettings(sessionId: string): Promise<{ markupPercent: number; maxStake: number }> {
  let markupPercent = 10;
  let maxStake = 500;
  try {
    const rows = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, sessionId)).limit(1);
    if (rows.length > 0) {
      const markup = Number((rows[0] as any).botRecoveryMarkup);
      const cap = Number((rows[0] as any).maxTradeStake);
      if (Number.isFinite(markup) && markup >= 0) markupPercent = markup;
      if (Number.isFinite(cap) && cap >= 0.35) maxStake = cap;
    }
  } catch (err) {
    logger.warn({ err }, "hedge-pair settings unavailable; using conservative display defaults");
  }
  return { markupPercent, maxStake };
}

async function accountCurrency(sessionId: string): Promise<string> {
  try {
    let rows = await db.select().from(accountsTable)
      .where(and(eq(accountsTable.sessionId, sessionId), eq(accountsTable.isActive, true))).limit(1);
    if (rows.length === 0) rows = await db.select().from(accountsTable)
      .where(eq(accountsTable.sessionId, sessionId)).limit(1);
    if (rows[0]?.currency && /^[A-Z]{3}$/.test(rows[0].currency)) return rows[0].currency;
  } catch (err) {
    logger.warn({ err }, "hedge-pair account currency unavailable; using USD fallback");
  }
  return "USD";
}

router.get("/options", async (req, res): Promise<void> => {
  const [{ markupPercent, maxStake }, currency] = await Promise.all([
    userRiskSettings(req.sessionId),
    accountCurrency(req.sessionId),
  ]);
  res.json({
    markets: AUTOMATED_DERIV_MARKETS.map(market => ({
      symbol: market.symbol,
      displayName: market.displayName,
      pipSize: market.pipSize,
      digitEnabled: market.digitEnabled,
    })),
    markupPercent,
    maxStake,
    currency,
  });
});

router.post("/dbot", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const market = isAutomatedMarket(symbol) ? AUTOMATED_DERIV_MARKETS.find(candidate => candidate.symbol === symbol) : undefined;
  if (!market) {
    res.status(400).json({ error: "Choose an available synthetic index" });
    return;
  }

  const family = String(body.family ?? "").toUpperCase();
  const stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake < 0.35) {
    res.status(400).json({ error: "Per-leg stake must be at least 0.35" });
    return;
  }

  try {
    const [{ markupPercent, maxStake }, currency] = await Promise.all([
      userRiskSettings(req.sessionId),
      accountCurrency(req.sessionId),
    ]);
    if (stake > maxStake) {
      res.status(400).json({ error: `Per-leg stake exceeds your Max Stake Per Trade setting of ${maxStake}` });
      return;
    }

    const strategyInput: HedgePairInput = {
      symbol: market.symbol,
      displayName: market.displayName,
      family,
      stake,
      requestedDuration: Number(body.requestedDuration) || 1,
      upperOffset: Number(body.upperOffset) || 0,
      lowerOffset: Number(body.lowerOffset) || 0,
      analysisWindow: Number(body.analysisWindow) || 500,
      minSamples: Number(body.minSamples) || 80,
      requiredEdge: Number.isFinite(Number(body.requiredEdge)) ? Number(body.requiredEdge) : 0.01,
      recoveryMultiplier: Number(body.recoveryMultiplier) || 1.62,
      maxRecoverySteps: Number(body.maxRecoverySteps) || 3,
      // Markup and max stake are server-owned Risk Management settings.
      markupPercent,
      maxStake,
      takeProfit: Number(body.takeProfit) || 10,
      stopLoss: Number(body.stopLoss) || 5,
      maxConsecutiveDoubleLosses: Number(body.maxConsecutiveDoubleLosses) || 6,
      entryConfirmations: Number(body.entryConfirmations) || 0,
      recoveryConfirmations: Number(body.recoveryConfirmations) || 0,
      currency,
    };
    const strategy = buildHedgePairStrategy(strategyInput);
    res.json({ ok: true, ...strategy });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not build the hedge-pair DBot";
    logger.warn({ err, family, symbol }, "hedge-pair DBot build rejected");
    res.status(400).json({ error: message });
  }
});

export default router;
