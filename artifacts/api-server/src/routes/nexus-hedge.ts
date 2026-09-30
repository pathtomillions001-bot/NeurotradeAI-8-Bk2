/**
 * Routes for Nexus Hedge Forge — the universal super-hedge DBot factory.
 *
 * Like Omni Forge, it never analyses server-side and never takes a trade.
 * The console collects the user's OWN contract sets — any mix of Over/Under,
 * Even/Odd, Matches/Differs, Rise/Fall for normal and independent mix for
 * recovery — this route renders a Deriv Bot (Blockly) strategy that carries
 * its own hedge-aware analysis, and the web app hands that XML to the embedded
 * builder.
 */

import { Router } from "express";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import { logger } from "../lib/logger";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  buildNexusHedgeStrategy,
  normaliseNexusSet,
  nexusPayout,
  nexusFairRate,
  nexusLabel,
  NEXUS_FORGE_CONTRACT_TYPES,
  type NexusForgeContractSpec,
  type NexusForgeContractType,
  type NexusHedgeInput,
} from "../lib/nexus-hedge-dbot";
import { ladderRisk } from "../lib/digit-forge-dbot";

const router = Router();

function parseSpecs(raw: unknown): NexusForgeContractSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any): NexusForgeContractSpec | null => {
      const type = (NEXUS_FORGE_CONTRACT_TYPES as readonly string[]).includes(entry?.type)
        ? (entry.type as NexusForgeContractType)
        : null;
      if (!type) return null;
      const digit = Number.isFinite(Number(entry?.digit)) ? Math.trunc(Number(entry.digit)) : -1;
      return { type, digit };
    })
    .filter((s): s is NexusForgeContractSpec => s !== null);
}

async function riskSettings(sessionId: string): Promise<{ markupPercent: number; maxStake: number }> {
  let markupPercent = 10;
  let maxStake = 500;
  try {
    const rows = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, sessionId)).limit(1);
    if (rows.length > 0) {
      const v = Number((rows[0] as any).botRecoveryMarkup);
      if (Number.isFinite(v)) markupPercent = v;
      const m = Number((rows[0] as any).maxTradeStake);
      if (Number.isFinite(m) && m > 0) maxStake = m;
    }
  } catch {}
  return { markupPercent, maxStake };
}

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
  } catch {}
  return "USD";
}

router.get("/options", (_req, res) => {
  const describe = (type: NexusForgeContractType) => {
    switch (type) {
      case "DIGITOVER":
        return { label: "Digits Over", digitLabel: "Barrier", digitMin: 0, digitMax: 8, allowsAuto: false, needsDigit: true };
      case "DIGITUNDER":
        return { label: "Digits Under", digitLabel: "Barrier", digitMin: 1, digitMax: 9, allowsAuto: false, needsDigit: true };
      case "DIGITEVEN":
        return { label: "Even", digitLabel: null, digitMin: null, digitMax: null, allowsAuto: false, needsDigit: false };
      case "DIGITODD":
        return { label: "Odd", digitLabel: null, digitMin: null, digitMax: null, allowsAuto: false, needsDigit: false };
      case "DIGITMATCH":
        return { label: "Matches", digitLabel: "Digit", digitMin: 0, digitMax: 9, allowsAuto: true, needsDigit: false };
      case "DIGITDIFF":
        return { label: "Differs", digitLabel: "Digit", digitMin: 0, digitMax: 9, allowsAuto: true, needsDigit: false };
      case "CALL":
        return { label: "Rise", digitLabel: null, digitMin: null, digitMax: null, allowsAuto: false, needsDigit: false };
      case "PUT":
        return { label: "Fall", digitLabel: null, digitMin: null, digitMax: null, allowsAuto: false, needsDigit: false };
    }
  };
  res.json({
    contractTypes: NEXUS_FORGE_CONTRACT_TYPES.map((type) => ({
      type,
      ...describe(type),
      payout: nexusPayout({ type, digit: type === "DIGITOVER" ? 4 : type === "DIGITUNDER" ? 5 : type === "CALL" ? -1 : -1 }),
      fairWinRate: nexusFairRate({ type, digit: type === "DIGITOVER" ? 4 : type === "DIGITUNDER" ? 5 : -1 }),
    })),
    overPayouts: Object.fromEntries(Array.from({ length: 9 }, (_, b) => [b, nexusPayout({ type: "DIGITOVER", digit: b })])),
    underPayouts: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, nexusPayout({ type: "DIGITUNDER", digit: i + 1 })])),
    markets: AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled).map((m) => ({
      symbol: m.symbol,
      displayName: m.displayName,
    })),
  });
});

router.post("/dbot", async (req, res): Promise<void> => {
  const body = req.body ?? {};

  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const market = isAutomatedMarket(symbol) ? AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol) : undefined;
  if (!market?.digitEnabled && !market) {
    // Allow synthetic but prefer digit-enabled; Rise/Fall works on any.
    const anyMarket = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol);
    if (!anyMarket) {
      res.status(400).json({ error: "Choose a valid market" });
      return;
    }
  }
  const resolvedMarket = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol);
  if (!resolvedMarket) {
    res.status(400).json({ error: "Unknown market" });
    return;
  }

  const stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  const requestedWatchMarkets = Array.isArray(body.watchMarkets)
    ? (body.watchMarkets as unknown[]).filter((s): s is string => typeof s === "string" && isAutomatedMarket(s))
    : [];
  const watchMarkets = (requestedWatchMarkets.length > 0
    ? requestedWatchMarkets
    : AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled).map((m) => m.symbol)
  ).slice(0, 8);

  try {
    const [{ markupPercent, maxStake }, currency] = await Promise.all([riskSettings(req.sessionId), accountCurrency(req.sessionId)]);

    const input: NexusHedgeInput = {
      symbol: resolvedMarket.symbol,
      displayName: resolvedMarket.displayName,
      normal: parseSpecs(body.normal),
      recovery: parseSpecs(body.recovery),
      stake,
      takeProfit: Number(body.takeProfit) > 0 ? Number(body.takeProfit) : 10,
      stopLoss: Number(body.stopLoss) > 0 ? Number(body.stopLoss) : 5,
      maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
      markupPercent,
      maxStake,
      breakerDepth: Math.max(3, Math.min(20, Number(body.breakerDepth) || 6)),
      currency,
      window: Number(body.window) > 0 ? Number(body.window) : undefined,
      forceEntryAfter: Number.isFinite(Number(body.forceEntryAfter)) ? Number(body.forceEntryAfter) : undefined,
      watchMarkets,
    };

    const strategy = buildNexusHedgeStrategy(input);
    res.json({ ok: true, ...strategy });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not build the strategy";
    logger.warn({ err }, "nexus-hedge dbot build failed");
    res.status(400).json({ error: message });
  }
});

router.post("/risk", async (req, res): Promise<void> => {
  let recovery: NexusForgeContractSpec[];
  try {
    recovery = normaliseNexusSet(parseSpecs(req.body?.recovery), "recovery");
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "invalid recovery set" });
    return;
  }
  const depth = Math.max(1, Math.min(10, Number(req.body?.maxRecoverySteps) || 3));
  const stake = Number(req.body?.stake) > 0 ? Number(req.body.stake) : 1;
  const { markupPercent } = await riskSettings(req.sessionId);
  const worstPayout = Math.min(...recovery.map(nexusPayout));
  const worstRate = Math.min(...recovery.map(nexusFairRate));
  const ladder = ladderRisk(worstPayout, markupPercent, depth, worstRate);
  res.json({
    ...ladder,
    payout: worstPayout,
    markupPercent,
    depth,
    stake,
    labels: recovery.map(nexusLabel),
    capitalAtRiskMoney: Math.round(ladder.capitalAtRisk * stake * 100) / 100,
  });
});

export default router;
