/**
 * Routes for Universal Forge — a user-composed DBot factory that can mix
 * digit contracts and Rise/Fall in independent normal/recovery sets.
 *
 * The server still does not trade here: it validates the user's selected
 * contracts and renders a Blockly DBot whose own runtime ranker analyses,
 * times, switches markets safely and executes after Deriv's Run button is
 * pressed in the Bot Builder.
 */

import { Router } from "express";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import { logger } from "../lib/logger";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  buildOmniForgeStrategy,
  normaliseForgeSet,
  forgePayout,
  forgeFairRate,
  forgeLabel,
  FORGE_CONTRACT_TYPES,
  type ForgeContractSpec,
  type ForgeContractType,
  type OmniForgeInput,
} from "../lib/omni-forge-dbot";
import { ladderRisk } from "../lib/digit-forge-dbot";

const router = Router();

function parseSpecs(raw: unknown): ForgeContractSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any): ForgeContractSpec | null => {
      const type = (FORGE_CONTRACT_TYPES as readonly string[]).includes(
        entry?.type,
      )
        ? (entry.type as ForgeContractType)
        : null;
      if (!type) return null;
      const digit = Number.isFinite(Number(entry?.digit))
        ? Math.trunc(Number(entry.digit))
        : -1;
      return { type, digit };
    })
    .filter((s): s is ForgeContractSpec => s !== null);
}

async function riskSettings(
  sessionId: string,
): Promise<{ markupPercent: number; maxStake: number }> {
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

async function accountCurrency(sessionId: string): Promise<string> {
  try {
    let accounts = await db
      .select()
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.sessionId, sessionId),
          eq(accountsTable.isActive, true),
        ),
      )
      .limit(1);
    if (accounts.length === 0) {
      accounts = await db
        .select()
        .from(accountsTable)
        .where(eq(accountsTable.sessionId, sessionId))
        .limit(1);
    }
    if (accounts[0]?.currency) return accounts[0].currency;
  } catch {
    /* default */
  }
  return "USD";
}

function describeContract(type: ForgeContractType) {
  switch (type) {
    case "CALL":
      return {
        label: "Rise",
        digitLabel: null,
        digitMin: null,
        digitMax: null,
        allowsAuto: false,
        needsDigit: false,
      };
    case "PUT":
      return {
        label: "Fall",
        digitLabel: null,
        digitMin: null,
        digitMax: null,
        allowsAuto: false,
        needsDigit: false,
      };
    case "DIGITOVER":
      return {
        label: "Digits Over",
        digitLabel: "Barrier",
        digitMin: 0,
        digitMax: 8,
        allowsAuto: false,
        needsDigit: true,
      };
    case "DIGITUNDER":
      return {
        label: "Digits Under",
        digitLabel: "Barrier",
        digitMin: 1,
        digitMax: 9,
        allowsAuto: false,
        needsDigit: true,
      };
    case "DIGITEVEN":
      return {
        label: "Even",
        digitLabel: null,
        digitMin: null,
        digitMax: null,
        allowsAuto: false,
        needsDigit: false,
      };
    case "DIGITODD":
      return {
        label: "Odd",
        digitLabel: null,
        digitMin: null,
        digitMax: null,
        allowsAuto: false,
        needsDigit: false,
      };
    case "DIGITMATCH":
      return {
        label: "Matches",
        digitLabel: "Digit",
        digitMin: 0,
        digitMax: 9,
        allowsAuto: true,
        needsDigit: false,
      };
    case "DIGITDIFF":
      return {
        label: "Differs",
        digitLabel: "Digit",
        digitMin: 0,
        digitMax: 9,
        allowsAuto: true,
        needsDigit: false,
      };
  }
}

router.get("/options", (_req, res) => {
  res.json({
    contractTypes: FORGE_CONTRACT_TYPES.map((type) => ({
      type,
      ...describeContract(type),
      payout: forgePayout({
        type,
        digit: type === "DIGITOVER" ? 4 : type === "DIGITUNDER" ? 5 : -1,
      }),
      fairWinRate: forgeFairRate({
        type,
        digit: type === "DIGITOVER" ? 4 : type === "DIGITUNDER" ? 5 : -1,
      }),
    })),
    overPayouts: Object.fromEntries(
      Array.from({ length: 9 }, (_, b) => [
        b,
        forgePayout({ type: "DIGITOVER", digit: b }),
      ]),
    ),
    underPayouts: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        i + 1,
        forgePayout({ type: "DIGITUNDER", digit: i + 1 }),
      ]),
    ),
    markets: AUTOMATED_DERIV_MARKETS.map((m) => ({
      symbol: m.symbol,
      displayName: m.displayName,
      digitEnabled: m.digitEnabled,
    })),
  });
});

router.post("/dbot", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const market = isAutomatedMarket(symbol)
    ? AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol)
    : undefined;
  if (!market) {
    res.status(400).json({ error: "Choose a supported automated market" });
    return;
  }

  const stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  const requestedWatchMarkets = Array.isArray(body.watchMarkets)
    ? (body.watchMarkets as unknown[]).filter(
        (s): s is string => typeof s === "string" && isAutomatedMarket(s),
      )
    : [];
  const watchMarkets = (
    requestedWatchMarkets.length > 0
      ? requestedWatchMarkets
      : AUTOMATED_DERIV_MARKETS.map((m) => m.symbol)
  ).slice(0, 8);

  try {
    const [{ markupPercent, maxStake }, currency] = await Promise.all([
      riskSettings(req.sessionId),
      accountCurrency(req.sessionId),
    ]);

    const input: OmniForgeInput = {
      symbol: market.symbol,
      displayName: market.displayName,
      normal: parseSpecs(body.normal),
      recovery: parseSpecs(body.recovery),
      stake,
      takeProfit: Number(body.takeProfit) > 0 ? Number(body.takeProfit) : 10,
      stopLoss: Number(body.stopLoss) > 0 ? Number(body.stopLoss) : 5,
      maxRecoverySteps: Math.max(
        1,
        Math.min(10, Number(body.maxRecoverySteps) || 3),
      ),
      markupPercent,
      maxStake,
      breakerDepth: Math.max(3, Math.min(20, Number(body.breakerDepth) || 6)),
      currency,
      window: Number(body.window) > 0 ? Number(body.window) : undefined,
      forceEntryAfter: Number.isFinite(Number(body.forceEntryAfter))
        ? Number(body.forceEntryAfter)
        : undefined,
      watchMarkets,
      strategyName: "Universal Forge",
    };

    const strategy = buildOmniForgeStrategy(input);
    res.json({ ok: true, ...strategy });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Could not build the Universal Forge strategy";
    logger.warn({ err }, "universal-forge dbot build failed");
    res.status(400).json({ error: message });
  }
});

router.post("/risk", async (req, res): Promise<void> => {
  let recovery: ForgeContractSpec[];
  try {
    recovery = normaliseForgeSet(parseSpecs(req.body?.recovery), "recovery");
  } catch (err) {
    res
      .status(400)
      .json({
        error: err instanceof Error ? err.message : "invalid recovery set",
      });
    return;
  }
  const depth = Math.max(
    1,
    Math.min(10, Number(req.body?.maxRecoverySteps) || 3),
  );
  const stake = Number(req.body?.stake) > 0 ? Number(req.body.stake) : 1;
  const { markupPercent } = await riskSettings(req.sessionId);
  const worstPayout = Math.min(...recovery.map(forgePayout));
  const worstRate = Math.min(...recovery.map(forgeFairRate));
  const ladder = ladderRisk(worstPayout, markupPercent, depth, worstRate);
  res.json({
    ...ladder,
    payout: worstPayout,
    markupPercent,
    depth,
    stake,
    labels: recovery.map(forgeLabel),
    capitalAtRiskMoney: Math.round(ladder.capitalAtRisk * stake * 100) / 100,
  });
});

export default router;
