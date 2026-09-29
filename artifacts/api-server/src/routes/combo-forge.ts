/**
 * Routes for Combo Forge — the evidence-gated, user-configurable DBot factory.
 *
 * Like Omni Forge, Combo Forge has NO scan and NO engine: it never analyses
 * anything live server-side and never takes a trade. The console collects the
 * user's OWN contract sets — digits (Over/Under, Even/Odd, Matches/Differs)
 * AND Rise/Fall, for normal trades and an independent set for recovery — this
 * route renders a Deriv Bot (Blockly) strategy that carries its own evidence
 * analysis, and the web app hands that XML to the embedded builder. Deriv's
 * Run button owns execution from there.
 */

import { Router } from "express";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import { logger } from "../lib/logger";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  buildComboForgeStrategy,
  normaliseComboSet,
  comboPayout,
  comboFairRate,
  comboLabel,
  COMBO_FORGE_TYPES,
  COMBO_MAX_SET,
  COMBO_MAX_MARKETS,
  COMBO_MIN_WINDOW,
  COMBO_MAX_WINDOW,
  COMBO_DEFAULT_WINDOW,
  COMBO_DEFAULT_RECOVERY_PATIENCE,
  type ComboForgeSpec,
  type ComboForgeType,
  type ComboForgeInput,
} from "../lib/combo-forge-dbot";
import { normaliseStrictness } from "../lib/combo-forge-analysis";
import { ladderRisk } from "../lib/digit-forge-dbot";

const router = Router();

function parseSpecs(raw: unknown): ComboForgeSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any): ComboForgeSpec | null => {
      const type = (COMBO_FORGE_TYPES as readonly string[]).includes(entry?.type)
        ? (entry.type as ComboForgeType)
        : null;
      if (!type) return null;
      const digit = Number.isFinite(Number(entry?.digit)) ? Math.trunc(Number(entry.digit)) : -1;
      return { type, digit };
    })
    .filter((s): s is ComboForgeSpec => s !== null);
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

/** Shared request → generator input mapping, used by /dbot and /preview. */
async function buildInput(req: { body?: any; sessionId: string }): Promise<ComboForgeInput> {
  const body = req.body ?? {};
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const market = isAutomatedMarket(symbol) ? AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol) : undefined;
  if (!market?.digitEnabled) throw new BadRequest("Choose a market Combo Forge can trade");

  const stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake < 0.35) throw new BadRequest("stake must be ≥ 0.35");

  const requestedWatchMarkets = Array.isArray(body.watchMarkets)
    ? (body.watchMarkets as unknown[]).filter((s): s is string => typeof s === "string" && isAutomatedMarket(s))
    : [];
  const watchMarkets = (requestedWatchMarkets.length > 0
    ? requestedWatchMarkets
    : AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled).map((m) => m.symbol))
    .slice(0, COMBO_MAX_MARKETS);

  const [{ markupPercent, maxStake }, currency] = await Promise.all([
    riskSettings(req.sessionId),
    accountCurrency(req.sessionId),
  ]);
  const count = (v: unknown): number | undefined =>
    Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : undefined;

  return {
    symbol: market.symbol,
    displayName: market.displayName,
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
    strictness: normaliseStrictness(body.strictness),
    normalPatience: count(body.normalPatience),
    recoveryPatience: count(body.recoveryPatience),
    watchMarkets,
  };
}

class BadRequest extends Error {}

/**
 * The console's vocabulary: every contract type with its digit rules and
 * canonical payout, plus the markets — so the panel can never offer a
 * combination the generator rejects.
 */
router.get("/options", (_req, res) => {
  const describe = (type: ComboForgeType) => {
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
  const sample = (type: ComboForgeType): ComboForgeSpec => ({
    type,
    digit: type === "DIGITOVER" ? 4 : type === "DIGITUNDER" ? 5 : -1,
  });
  res.json({
    contractTypes: COMBO_FORGE_TYPES.map((type) => ({
      type,
      ...describe(type),
      payout: comboPayout(sample(type)),
      fairWinRate: comboFairRate(sample(type)),
    })),
    overPayouts: Object.fromEntries(Array.from({ length: 9 }, (_, b) => [b, comboPayout({ type: "DIGITOVER", digit: b })])),
    underPayouts: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, comboPayout({ type: "DIGITUNDER", digit: i + 1 })])),
    markets: AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled).map((m) => ({
      symbol: m.symbol,
      displayName: m.displayName,
    })),
    strictness: ["strict", "balanced", "always"],
    defaults: {
      strictness: "strict",
      window: COMBO_DEFAULT_WINDOW,
      recoveryPatience: COMBO_DEFAULT_RECOVERY_PATIENCE,
      normalPatience: 0,
    },
    limits: {
      maxSet: COMBO_MAX_SET,
      maxMarkets: COMBO_MAX_MARKETS,
      minWindow: COMBO_MIN_WINDOW,
      maxWindow: COMBO_MAX_WINDOW,
    },
  });
});

/**
 * Build the strategy. Nothing starts here — the web app posts the XML into
 * the embedded Deriv bot builder, the user verifies the blocks and presses Run.
 */
router.post("/dbot", async (req, res): Promise<void> => {
  try {
    const strategy = buildComboForgeStrategy(await buildInput(req));
    res.json({ ok: true, ...strategy });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not build the strategy";
    if (!(err instanceof BadRequest)) logger.warn({ err }, "combo-forge dbot build failed");
    res.status(400).json({ error: message });
  }
});

/**
 * Honest forge-time preview: margins, how many ticks a real edge needs to be
 * detected, the simulated false-fire rate on a FAIR tape, ladder risk, and
 * warnings — the same numbers the generator embeds in its summary, without the
 * XML. Lets the console show what Strict can and cannot do BEFORE "Create DBot".
 */
router.post("/preview", async (req, res): Promise<void> => {
  try {
    const { xml: _xml, ...rest } = buildComboForgeStrategy(await buildInput(req));
    res.json({ ok: true, ...rest });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not preview the strategy" });
  }
});

/**
 * Risk preview for the panel — the worst-case ladder over the CHOSEN recovery
 * set, so the user sees the capital a ladder can consume BEFORE they build it.
 */
router.post("/risk", async (req, res): Promise<void> => {
  let recovery: ComboForgeSpec[];
  try {
    recovery = normaliseComboSet(parseSpecs(req.body?.recovery), "recovery");
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "invalid recovery set" });
    return;
  }
  const depth = Math.max(1, Math.min(10, Number(req.body?.maxRecoverySteps) || 3));
  const stake = Number(req.body?.stake) > 0 ? Number(req.body.stake) : 1;
  const { markupPercent } = await riskSettings(req.sessionId);
  const worstPayout = Math.min(...recovery.map(comboPayout));
  const worstRate = Math.min(...recovery.map(comboFairRate));
  const ladder = ladderRisk(worstPayout, markupPercent, depth, worstRate);
  res.json({
    ...ladder,
    payout: worstPayout,
    markupPercent,
    depth,
    stake,
    labels: recovery.map(comboLabel),
    capitalAtRiskMoney: Math.round(ladder.capitalAtRisk * stake * 100) / 100,
  });
});

export default router;
