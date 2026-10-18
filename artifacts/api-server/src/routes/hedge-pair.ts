/**
 * Pair Forge factory route. This route emits XML only; it cannot execute trades.
 *
 * Markup ownership: `settings.botRecoveryMarkup` (10% by default) belongs to the
 * five single-contract specialist bots. A hedge pair risks TWO premiums at once,
 * so this route ships Hedge Pair Forge's own 40% markup instead and reports both
 * numbers to the console — silently reusing the shared setting would have sized a
 * $2.00 pair debt at $1.54 a leg and taken nine pair wins to clear instead of six.
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { accountsTable, db, settingsTable } from "@workspace/db";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import { logger } from "../lib/logger";
import {
  DEFAULT_ANALYSIS_WINDOW,
  DEFAULT_PAIR_MARKUP_PERCENT,
  DEFAULT_PAIR_RECOVERY_MULTIPLIER,
  MAX_WATCH_MARKETS,
  MIN_REPRESENTABLE_OFFSET,
  buildHedgePairStrategy,
  normalizeWatchMarkets,
  type HedgePairInput,
} from "../lib/hedge-pair-dbot";

const router = Router();

async function userRiskSettings(sessionId: string): Promise<{ sharedMarkupPercent: number; maxStake: number }> {
  let sharedMarkupPercent = 10;
  let maxStake = 500;
  try {
    const rows = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, sessionId)).limit(1);
    if (rows.length > 0) {
      const markup = Number((rows[0] as any).botRecoveryMarkup);
      const cap = Number((rows[0] as any).maxTradeStake);
      if (Number.isFinite(markup) && markup >= 0) sharedMarkupPercent = markup;
      if (Number.isFinite(cap) && cap >= 0.35) maxStake = cap;
    }
  } catch (err) {
    logger.warn({ err }, "hedge-pair settings unavailable; using conservative display defaults");
  }
  return { sharedMarkupPercent, maxStake };
}

/** Only markets this platform automates can be watched, ranked and switched to. */
function parseWatchMarkets(raw: unknown, seedSymbol: string): { markets: string[]; rejected: string[] } {
  const requested = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const markets: string[] = [];
  const rejected: string[] = [];
  for (const entry of requested) {
    const symbol = String(entry ?? "").trim().toUpperCase();
    if (!symbol) continue;
    if (markets.includes(symbol)) continue;
    if (isAutomatedMarket(symbol)) markets.push(symbol);
    else rejected.push(symbol);
  }
  const normalized = normalizeWatchMarkets(markets, seedSymbol);
  return { markets: normalized, rejected: rejected.filter(symbol => !normalized.includes(symbol)) };
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
  const [{ sharedMarkupPercent, maxStake }, currency] = await Promise.all([
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
    /** Shared single-contract setting, shown for comparison only. */
    markupPercent: sharedMarkupPercent,
    /** What this bot actually ships, and why it differs. */
    pairMarkupPercent: DEFAULT_PAIR_MARKUP_PERCENT,
    pairRecoveryMultiplier: DEFAULT_PAIR_RECOVERY_MULTIPLIER,
    analysisWindow: DEFAULT_ANALYSIS_WINDOW,
    maxAnalysisWindow: 5000,
    maxWatchMarkets: MAX_WATCH_MARKETS,
    minRepresentableOffset: MIN_REPRESENTABLE_OFFSET,
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
    const [{ sharedMarkupPercent, maxStake }, currency] = await Promise.all([
      userRiskSettings(req.sessionId),
      accountCurrency(req.sessionId),
    ]);
    if (stake > maxStake) {
      res.status(400).json({ error: `Per-leg stake exceeds your Max Stake Per Trade setting of ${maxStake}` });
      return;
    }

    const { markets: watchMarkets, rejected } = parseWatchMarkets(body.watchMarkets, market.symbol);
    if (rejected.length > 0) {
      res.status(400).json({
        error: `These watch markets are not automated synthetic indices: ${rejected.join(", ")}`,
      });
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
      // Deep tape by default: a 500-tick window cannot produce enough
      // non-overlapping pairs to measure a minute-duration family at all.
      analysisWindow: Number(body.analysisWindow) || DEFAULT_ANALYSIS_WINDOW,
      minSamples: Number(body.minSamples) || 80,
      // 0 = break-even. The runtime enforces this now, so it must not default to
      // a hurdle nobody chose.
      requiredEdge: Number.isFinite(Number(body.requiredEdge)) ? Number(body.requiredEdge) : 0,
      recoveryMultiplier: Number(body.recoveryMultiplier) || DEFAULT_PAIR_RECOVERY_MULTIPLIER,
      maxRecoverySteps: Number(body.maxRecoverySteps) || 3,
      // Pair-local markup (two premiums at risk). Max stake stays server-owned.
      markupPercent: Number.isFinite(Number(body.markupPercent)) && Number(body.markupPercent) >= 0
        ? Number(body.markupPercent)
        : DEFAULT_PAIR_MARKUP_PERCENT,
      maxStake,
      takeProfit: Number(body.takeProfit) || 10,
      stopLoss: Number(body.stopLoss) || 5,
      maxConsecutiveDoubleLosses: Number(body.maxConsecutiveDoubleLosses) || 6,
      entryConfirmations: Number(body.entryConfirmations) || 0,
      recoveryConfirmations: Number(body.recoveryConfirmations) || 0,
      watchMarkets: watchMarkets.join(","),
      forceEntryAfter: Number.isFinite(Number(body.forceEntryAfter)) ? Number(body.forceEntryAfter) : 0,
      currency,
    };
    const strategy = buildHedgePairStrategy(strategyInput);
    logger.info(
      {
        symbol: market.symbol,
        family,
        watchMarkets,
        markupPercent: strategy.summary.markupPercent,
        sharedMarkupPercent,
        analysisWindow: strategy.summary.analysisWindow,
        forceEntryAfter: strategy.summary.forceEntryAfter,
      },
      "hedge-pair DBot generated",
    );
    res.json({ ok: true, ...strategy });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not build the hedge-pair DBot";
    logger.warn({ err, family, symbol }, "hedge-pair DBot build rejected");
    res.status(400).json({ error: message });
  }
});

export default router;
