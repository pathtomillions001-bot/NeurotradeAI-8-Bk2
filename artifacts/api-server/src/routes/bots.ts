/**
 * Specialist AI Bot routes.
 *
 * One bot = one contract family. The contract family is decided by the bot, not
 * by the request body — a client can pick a SIDE (over/under, rise/fall,
 * even/odd) or lock a digit, but it can never widen a bot into another family.
 * Recovery uses the same family as normal trading, so a parity bot only ever
 * recovers in Even/Odd.
 */

import { Router } from "express";
import { BOT_CATALOG, botConsoleId, botConsoleIds, getBotDefinition, type BotSideMode } from "../lib/bot-catalog";
import { pickActiveBotId } from "../lib/bot-activity";
import { API_RELEASE } from "../lib/release";
import {
  startSession,
  stopSession,
  getStatus,
  getOwnerSessionId,
  scanBestMarketForBot,
  type BotConfig,
  type BotContractType,
} from "../lib/bot-engine";
import { isAutomatedMarket, AUTOMATED_DERIV_MARKETS } from "../lib/deriv";
import * as dualLock from "../lib/dual-lock-engine";
import * as twinHedge from "../lib/twin-hedge-engine";
import * as killshot from "../lib/killshot-engine";
import * as killshotFamily from "../lib/killshot-family-engine";
import * as matchNexus from "../lib/match-nexus-engine";
import {
  TWIN_NORMAL_LEGS,
  TWIN_RECOVERY_LEGS,
  recoveryBreakEvenGapRate,
} from "../lib/twin-hedge-analysis";
import { validateShotContract, validateShotPlan, shotLabel, shotPlanLabel, type Certainty } from "../lib/killshot-analysis";
import { type NexusCertainty } from "../lib/match-nexus-analysis";
import {
  DUAL_LOCK_NORMAL_CONTRACTS,
  DUAL_LOCK_RECOVERY_CONTRACTS,
  isNormalContract,
  isRecoveryContract,
  type DualLockContract,
} from "../lib/dual-lock-analysis";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

interface ParsedBotBody {
  contractTypes: BotContractType[];
  barriers: number[];
  lockedBarrier?: number;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  recoveryAutoMode: boolean;
  recoveryMultiplier: number;
  recoveryMethod: "split" | "instant";
  maxRecoverySteps: number;
  lockedSymbol?: string;
  marketMode: "locked" | "switching";
}

function validateBotBody(botId: string, body: any): { ok: true; data: ParsedBotBody } | { ok: false; error: string } {
  const bot = getBotDefinition(botId);
  if (!bot) return { ok: false, error: "Unknown bot" };
  if (bot.preLocked) return { ok: false, error: `${bot.name} uses the /duallock endpoints` };
  if (bot.oneShot) return { ok: false, error: `${bot.name} uses the /killshot endpoints` };
  if (bot.twinHedge) return { ok: false, error: `${bot.name} uses the /twin endpoints` };
  // match-nexus uses its own engine, not the generic specialist route
  if (botId === "match-nexus") return { ok: false, error: `${bot.name} uses the /nexus endpoints` };

  const sideMode: BotSideMode = body.sideMode === "primary" || body.sideMode === "secondary"
    ? body.sideMode
    : "both";
  const sideOption = bot.sides.find(s => s.id === sideMode) ?? bot.sides[0]!;
  if (bot.sides.length === 1 && sideMode !== bot.sides[0]!.id) {
    return { ok: false, error: `${bot.name} has a single contract side` };
  }
  const contractTypes = sideOption.contracts as BotContractType[];

  const overBarrier = Number(body.overBarrier);
  const underBarrier = Number(body.underBarrier);
  const barriers: number[] = [];
  if (contractTypes.includes("DIGITOVER")) {
    if (!Number.isFinite(overBarrier) || overBarrier < 0 || overBarrier > 8) {
      return { ok: false, error: "overBarrier must be an integer 0–8" };
    }
    barriers.push(Math.trunc(overBarrier));
  }
  if (contractTypes.includes("DIGITUNDER")) {
    if (!Number.isFinite(underBarrier) || underBarrier < 1 || underBarrier > 9) {
      return { ok: false, error: "underBarrier must be an integer 1–9" };
    }
    barriers.push(Math.trunc(underBarrier));
  }

  let lockedBarrier: number | undefined;
  if (bot.hasDigitLock) {
    if (body.lockedBarrier !== undefined && body.lockedBarrier !== null && body.lockedBarrier !== "") {
      const lb = Number(body.lockedBarrier);
      if (!Number.isInteger(lb) || lb < 0 || lb > 9) {
        return { ok: false, error: "lockedBarrier must be an integer 0–9" };
      }
      lockedBarrier = lb;
    }
  }

  if (typeof body.stake !== "number" || body.stake < 0.35) return { ok: false, error: "stake must be ≥ 0.35" };
  if (typeof body.stopLoss !== "number" || body.stopLoss <= 0) return { ok: false, error: "stopLoss must be positive" };
  if (typeof body.takeProfit !== "number" || body.takeProfit <= 0) return { ok: false, error: "takeProfit must be positive" };

  const marketMode: "locked" | "switching" = body.marketMode === "locked" ? "locked" : "switching";
  let lockedSymbol: string | undefined;
  if (marketMode === "locked") {
    if (typeof body.lockedSymbol !== "string" || !body.lockedSymbol) {
      return { ok: false, error: "lockedSymbol is required when marketMode is locked" };
    }
    if (!isAutomatedMarket(body.lockedSymbol)) {
      return { ok: false, error: `${body.lockedSymbol} cannot be analysed or traded by a specialist bot` };
    }
    const needsDigits = contractTypes.some(ct => ct.startsWith("DIGIT"));
    const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === body.lockedSymbol);
    if (needsDigits && market && !market.digitEnabled) {
      return { ok: false, error: `${market.displayName} has no digit stream — this bot needs a digit-enabled market` };
    }
    lockedSymbol = body.lockedSymbol;
  }

  return {
    ok: true,
    data: {
      contractTypes,
      barriers,
      lockedBarrier,
      stake:             body.stake,
      stopLoss:          body.stopLoss,
      takeProfit:        body.takeProfit,
      recoveryAutoMode:  body.recoveryAutoMode !== false,
      recoveryMultiplier: typeof body.recoveryMultiplier === "number" && Number.isFinite(body.recoveryMultiplier)
        ? body.recoveryMultiplier
        : 1.62,
      recoveryMethod:    body.recoveryMethod === "instant" ? "instant" : "split",
      maxRecoverySteps:  typeof body.maxRecoverySteps === "number" ? Math.max(1, Math.min(10, body.maxRecoverySteps)) : 3,
      lockedSymbol,
      marketMode,
    },
  };
}

function visibleStatus(sessionId: string) {
  const status = getStatus();
  const owner = getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return {
    ...status,
    running: false,
    botId: null,
    botName: null,
    sessionId: null,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    currentStake: 0,
    inRecovery: false,
    recoveryStep: 0,
    unrecoveredAmount: 0,
    recoveryTargetProfit: 0,
    recoveryRemainingTargetProfit: 0,
    consecutiveRecoveryLosses: 0,
    currentMarket: undefined,
    currentContractType: undefined,
    lastResult: undefined,
    config: undefined,
    topMarkets: [],
    specialist: undefined,
    digitCandidates: undefined,
    message: "Specialist bots are ready",
  };
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

router.get("/", (req, res) => {
  const status = visibleStatus(req.sessionId);
  const dual = visibleDualStatus(req.sessionId);
  const twin = visibleTwinStatus(req.sessionId);
  const shot = visibleKillShotStatus(req.sessionId);
  const fam = visibleFamilyStatus(req.sessionId);
  const nexus = visibleNexusStatus(req.sessionId);
  res.json({
    release: API_RELEASE,
    consoles: botConsoleIds(),
    bots: BOT_CATALOG.map(bot => {
      const console_ = botConsoleId(bot);
      if (bot.id === dualLock.DUAL_LOCK_BOT_ID) {
        return { ...bot, console: console_, session: dual.running ? dual : null };
      }
      if (bot.id === twinHedge.TWIN_HEDGE_BOT_ID) {
        return { ...bot, console: console_, session: twin.running ? twin : null };
      }
      if (bot.id === killshot.KILLSHOT_BOT_ID) {
        return { ...bot, console: console_, session: shot.running ? shot : null };
      }
      if (bot.id === matchNexus.MATCH_NEXUS_BOT_ID) {
        return { ...bot, console: console_, session: nexus.running ? nexus : null };
      }
      if (bot.killShotFamily) {
        // For family bots, show whichever family engine is running that matches this bot id
        if (bot.id === "match-nexus") {
          return { ...bot, console: console_, session: nexus.running ? nexus : null };
        }
        return { ...bot, console: console_, session: fam.running && fam.botId === bot.id ? fam : null };
      }
      return { ...bot, console: console_, session: status.running && status.botId === bot.id ? status : null };
    }),
    activeBotId: pickActiveBotId([
      { botId: dualLock.DUAL_LOCK_BOT_ID, running: dual.running },
      { botId: twinHedge.TWIN_HEDGE_BOT_ID, running: twin.running },
      { botId: killshot.KILLSHOT_BOT_ID, running: shot.running },
      { botId: matchNexus.MATCH_NEXUS_BOT_ID, running: nexus.running },
      { botId: fam.botId ?? null, running: fam.running },
      { botId: status.botId, running: status.running },
    ]),
  });
});

// ── Dual-Lock ─────────────────────────────────────────────────────────────────

function visibleDualStatus(sessionId: string) {
  const status = dualLock.getStatus();
  const owner = dualLock.getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return { ...status, running: false, sessionId: null, config: undefined, lock: undefined };
}

async function dualSimParams(sessionId: string, body: any) {
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
  } catch { /* defaults */ }
  const requested = {
    stake: Number(body?.stake) > 0 ? Number(body.stake) : 1,
    takeProfit: Number(body?.takeProfit) > 0 ? Number(body.takeProfit) : 10,
    stopLoss: Number(body?.stopLoss) > 0 ? Number(body.stopLoss) : 5,
    maxRecoverySteps: Math.max(1, Math.min(10, Number(body?.maxRecoverySteps) || 3)),
  };
  const { params, committed, overridden } = dualLock.commitSessionParams(sessionId, requested);
  return { ...params, markupPercent, maxStake, committed, overridden };
}

router.get("/duallock/contracts", (_req, res) => {
  res.json({
    normal: DUAL_LOCK_NORMAL_CONTRACTS,
    recovery: DUAL_LOCK_RECOVERY_CONTRACTS,
  });
});

router.get("/duallock/status", (req, res) => {
  res.json(visibleDualStatus(req.sessionId));
});

router.post("/duallock/reset", (req, res): void => {
  if (dualLock.isRunning() && dualLock.getOwnerSessionId() === req.sessionId) {
    res.status(409).json({ error: "Stop the running session before starting a new engagement." });
    return;
  }
  dualLock.resetSessionParams(req.sessionId);
  res.json({ ok: true });
});

router.get("/duallock/params", (req, res) => {
  res.json({ params: dualLock.getCommittedParams(req.sessionId) ?? null });
});

router.post("/duallock/scan", async (req, res): Promise<void> => {
  try {
    const { markupPercent, maxStake, committed, overridden, ...params } =
      await dualSimParams(req.sessionId, req.body);
    const result = await dualLock.scanForLock(req.sessionId, { ...params, markupPercent, maxStake });
    res.json({
      ...result,
      sessionParams: params,
      paramsCommittedNow: committed,
      paramsOverridden: overridden,
    });
  } catch (err) {
    logger.error({ err }, "Dual-Lock scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/duallock/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const parseContract = (raw: any): DualLockContract | null => {
    if (!raw) return null;
    const side = raw.side === "DIGITOVER" || raw.side === "DIGITUNDER" ? raw.side : null;
    const barrier = Number(raw.barrier);
    if (!side || !Number.isInteger(barrier)) return null;
    return { side, barrier };
  };

  const normal = parseContract(body.normal);
  const recovery = parseContract(body.recovery);
  if (!normal || !isNormalContract(normal.side, normal.barrier)) {
    res.status(400).json({ error: "normal must be one of Over 1, Under 8, Over 2, Under 7" });
    return;
  }
  if (!recovery || !isRecoveryContract(recovery.side, recovery.barrier)) {
    res.status(400).json({ error: "recovery must be one of Over 4, Over 5, Under 5, Under 4" });
    return;
  }
  const requested = typeof body.symbol === "string" ? body.symbol : undefined;
  const fallback = AUTOMATED_DERIV_MARKETS.find(m => m.digitEnabled);
  const symbol = requested ?? fallback?.symbol;
  if (!symbol || !isAutomatedMarket(symbol)) {
    res.status(400).json({ error: "A valid market symbol is required" });
    return;
  }
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === symbol);
  if (!market || !market.digitEnabled) {
    res.status(400).json({ error: "This bot needs a digit-enabled market" });
    return;
  }
  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  const committed = dualLock.getCommittedParams(req.sessionId);
  if (!committed) {
    res.status(409).json({ error: "Run the Dual-Lock analysis first — this bot may only deploy a scanned lock." });
    return;
  }
  if (committed.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  const existingOwner = dualLock.getOwnerSessionId();
  if (dualLock.isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
    return;
  }

  const result = await dualLock.startSession({
    ownerSessionId: req.sessionId,
    symbol: market.symbol,
    displayName: market.displayName,
    normal,
    recovery,
    stake: committed.stake,
    stopLoss: committed.stopLoss,
    takeProfit: committed.takeProfit,
    maxRecoverySteps: committed.maxRecoverySteps,
    lockedAnalysis: body.analysis,
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status: visibleDualStatus(req.sessionId) });
});

router.post("/duallock/stop", (req, res) => {
  const owner = dualLock.getOwnerSessionId();
  if (dualLock.isRunning() && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's bot." });
    return;
  }
  dualLock.stopSession();
  res.json({ ok: true, status: visibleDualStatus(req.sessionId) });
});

// ── Twin-Lock Hedge Sentinel ──────────────────────────────────────────────────

function visibleTwinStatus(sessionId: string) {
  const status = twinHedge.getStatus();
  const owner = twinHedge.getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return { ...status, running: false, sessionId: null, config: undefined, lock: undefined };
}

/**
 * The pair is HARD-WIRED. This endpoint exists so the console can render and
 * validate exactly what the bot will trade — a client can never widen, narrow
 * or re-point the contracts; there is no contract choice to make.
 */
router.get("/twin/contracts", (_req, res) => {
  res.json({
    normal: TWIN_NORMAL_LEGS,
    recovery: TWIN_RECOVERY_LEGS,
    simultaneous: true,
    perLegPayouts: {
      over4: 1.95,
      under5: 1.95,
      over5: 2.43,
      under4: 2.43,
    },
    recoveryBreakEvenGapRate: recoveryBreakEvenGapRate(2.43),
    bothLoseArmsRecovery: true,
    splitIgnored: true,
  });
});

router.get("/twin/status", (req, res) => {
  res.json(visibleTwinStatus(req.sessionId));
});

async function twinSimParams(sessionId: string, body: any) {
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
  } catch { /* defaults */ }
  return {
    stake: Number(body?.stake) > 0 ? Number(body.stake) : 1,
    takeProfit: Number(body?.takeProfit) > 0 ? Number(body.takeProfit) : 10,
    stopLoss: Number(body?.stopLoss) > 0 ? Number(body.stopLoss) : 5,
    maxRecoverySteps: Math.max(1, Math.min(10, Number(body?.maxRecoverySteps) || 3)),
    markupPercent,
    maxStake,
  };
}

router.post("/twin/scan", async (req, res): Promise<void> => {
  try {
    const params = await twinSimParams(req.sessionId, req.body);
    const result = await twinHedge.scanTwinMarkets(req.sessionId, params);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Twin-Lock scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/twin/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const requestedSymbol = typeof body.symbol === "string" ? body.symbol : undefined;
  const fallback = AUTOMATED_DERIV_MARKETS.find(m => m.digitEnabled);
  const symbol = requestedSymbol ?? fallback?.symbol;
  if (!symbol || !isAutomatedMarket(symbol)) {
    res.status(400).json({ error: "A valid digit-enabled market symbol is required" });
    return;
  }
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === symbol);
  if (!market || !market.digitEnabled) {
    res.status(400).json({ error: "This bot needs a digit-enabled market" });
    return;
  }
  const stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }
  const marketMode = body.marketMode === "switching" ? "switching" : "locked";
  const takeProfit = Number(body.takeProfit) > 0 ? Number(body.takeProfit) : 10;
  const stopLoss = Number(body.stopLoss) > 0 ? Number(body.stopLoss) : 5;
  const maxRecoverySteps = Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3));

  const existingOwner = twinHedge.getOwnerSessionId();
  if (twinHedge.isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
    return;
  }

  const result = await twinHedge.startSession({
    ownerSessionId: req.sessionId,
    symbol: market.symbol,
    displayName: market.displayName,
    marketMode,
    stake,
    stopLoss,
    takeProfit,
    maxRecoverySteps,
    lockedAnalysis: body.analysis,
    rankedCandidates: Array.isArray(body.ranked) ? body.ranked : undefined,
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status: visibleTwinStatus(req.sessionId) });
});

router.post("/twin/stop", (req, res) => {
  const owner = twinHedge.getOwnerSessionId();
  if (twinHedge.isRunning() && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's bot." });
    return;
  }
  twinHedge.stopSession();
  res.json({ ok: true, status: visibleTwinStatus(req.sessionId) });
});

// ── Kill-Shot Oracle ──────────────────────────────────────────────────────────

function visibleKillShotStatus(sessionId: string) {
  const status = killshot.getStatus();
  const owner = killshot.getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return { ...status, running: false, sessionId: null, config: undefined, killshotLock: undefined, watch: undefined, needsRescan: false };
}

router.get("/killshot/status", (req, res) => {
  res.json(visibleKillShotStatus(req.sessionId));
});

async function killshotRisk(sessionId: string, body: any) {
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
  } catch { /* defaults */ }
  return {
    stake: Number(body?.stake) > 0 ? Number(body.stake) : 1,
    stopLoss: Number(body?.stopLoss) > 0 ? Number(body.stopLoss) : 5,
    markupPercent,
    maxStake,
  };
}

function parseCertainty(raw: unknown): Certainty {
  return raw === "elite" || raw === "balanced" ? raw : "strict";
}
function parseNexusCertainty(raw: unknown): NexusCertainty {
  return raw === "elite" || raw === "balanced" ? raw as NexusCertainty : "strict";
}

router.post("/killshot/scan", async (req, res): Promise<void> => {
  const parsed = validateShotPlan(req.body?.contracts ?? req.body?.contract);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const risk = await killshotRisk(req.sessionId, req.body);
    const result = await killshot.scanForMarket(req.sessionId, parsed.contracts, parseCertainty(req.body?.certainty), risk);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Kill-Shot scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/killshot/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};

  const parsed = validateShotPlan(body.contracts ?? body.contract);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const requested = typeof body.symbol === "string" ? body.symbol : undefined;
  if (!requested || !isAutomatedMarket(requested)) {
    res.status(400).json({ error: "Run the analysis first — this bot deploys only onto a market it has measured" });
    return;
  }
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === requested);
  if (!market || !market.digitEnabled) {
    res.status(400).json({ error: "This bot needs a digit-enabled market" });
    return;
  }
  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }
  const cards = (body.cards && typeof body.cards === "object") ? body.cards : {};

  const marketMode: "locked" | "switching" = body.marketMode === "switching" ? "switching" : "locked";

  const existingOwner = killshot.getOwnerSessionId();
  if (killshot.isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
    return;
  }

  const result = await killshot.startSession({
    ownerSessionId: req.sessionId,
    symbol: market.symbol,
    displayName: market.displayName,
    contracts: parsed.contracts,
    certainty: parseCertainty(body.certainty),
    stake: body.stake,
    stopLoss: typeof body.stopLoss === "number" && body.stopLoss > 0 ? body.stopLoss : 5,
    takeProfit: typeof body.takeProfit === "number" && body.takeProfit > 0 ? body.takeProfit : 10,
    maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
    maxShots: Math.max(0, Math.min(100, Number(body.maxShots) || 0)),
    marketMode,
    cards,
    lockedAnalysis: body.analysis,
    forced: body.forced === true,
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  logger.info(
    { symbol: market.symbol, contracts: shotPlanLabel(parsed.contracts), certainty: parseCertainty(body.certainty), marketMode, forced: body.forced === true },
    "Kill-Shot deployed",
  );
  res.json({ ok: true, status: visibleKillShotStatus(req.sessionId) });
});

router.post("/killshot/stop", (req, res) => {
  const owner = killshot.getOwnerSessionId();
  if (killshot.isRunning() && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's bot." });
    return;
  }
  killshot.stopSession();
  res.json({ ok: true, status: visibleKillShotStatus(req.sessionId) });
});

// ── Kill-Shot Family Oracles ──────────────────────────────────────────────────

function visibleFamilyStatus(sessionId: string) {
  const status = killshotFamily.getStatus();
  const owner = killshotFamily.getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return { ...status, running: false, sessionId: null, config: undefined, deployed: undefined, familyWatch: undefined };
}

function parseFamilySpec(botId: string, body: any):
  { ok: true; spec: killshotFamily.FamilyDeploySpec } | { ok: false; error: string } {
  const family = killshotFamily.familyForBot(botId);
  if (!family) return { ok: false, error: "Unknown bot" };
  const side = body?.side;

  if (family === "overunder") {
    if (!["over", "under", "both"].includes(side)) return { ok: false, error: "side must be over, under or both" };
    const num = (raw: unknown): number | undefined => {
      if (raw === undefined || raw === null || raw === "") return undefined;
      const n = Number(raw);
      return Number.isInteger(n) ? n : undefined;
    };
    const overD = num(body?.overDigit) ?? num(body?.digit);
    const underD = num(body?.underDigit) ?? num(body?.digit);
    if (side === "over" || side === "both") {
      if (overD === undefined || overD < 0 || overD > 8) {
        return { ok: false, error: "overDigit must be an integer 0–8 (Over 9 can never win)" };
      }
    }
    if (side === "under" || side === "both") {
      if (underD === undefined || underD < 1 || underD > 9) {
        return { ok: false, error: "underDigit must be an integer 1–9 (Under 0 can never win)" };
      }
    }
    return {
      ok: true,
      spec: {
        botId: botId as killshotFamily.FamilyBotId,
        family,
        side,
        overDigit: overD,
        underDigit: underD,
        aiDigit: false,
        certainty: parseCertainty(body?.certainty),
      },
    };
  }

  if (family === "parity") {
    if (!["even", "odd", "both"].includes(side)) return { ok: false, error: "side must be even, odd or both" };
    return { ok: true, spec: { botId: botId as killshotFamily.FamilyBotId, family, side, aiDigit: false, certainty: parseCertainty(body?.certainty) } };
  }

  if (!["match", "differ", "both"].includes(side)) return { ok: false, error: "side must be match, differ or both" };
  const hasDigit = body?.digit !== undefined && body?.digit !== null && body?.digit !== "";
  let digit: number | undefined;
  if (hasDigit) {
    const d = Number(body?.digit);
    if (!Number.isInteger(d) || d < 0 || d > 9) return { ok: false, error: "digit must be an integer 0–9" };
    digit = d;
  }
  return {
    ok: true,
    spec: { botId: botId as killshotFamily.FamilyBotId, family, side, digit, aiDigit: !hasDigit, certainty: parseCertainty(body?.certainty) },
  };
}

router.get("/family/status", (req, res) => {
  res.json(visibleFamilyStatus(req.sessionId));
});

router.post("/family/scan", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const botId = String(body?.botId ?? "");
  // Match Nexus has its own superior engine — intercept here so the generic family engine is not used
  if (botId === "match-nexus") {
    const parsed = parseNexusSpec(botId, body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const risk = await killshotRisk(req.sessionId, body);
      const result = await matchNexus.scanForNexus(req.sessionId, parsed.spec, risk);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Match Nexus scan failed");
      res.status(500).json({ error: "Scan failed" });
    }
    return;
  }

  const parsed = parseFamilySpec(botId, body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const risk = await killshotRisk(req.sessionId, body);
    const result = await killshotFamily.scanForFamily(req.sessionId, parsed.spec, risk);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Kill-Shot family scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/family/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const botId = String(body.botId ?? "");

  if (botId === "match-nexus") {
    const parsed = parseNexusSpec(botId, body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const marketMode: "locked" | "switching" = body.marketMode === "locked" ? "locked" : "switching";
    const requested = typeof body.symbol === "string" ? body.symbol : undefined;
    if (!requested || !isAutomatedMarket(requested)) {
      res.status(400).json({ error: "Run the analysis first — this bot deploys onto a market it has measured" });
      return;
    }
    const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === requested);
    if (!market || !market.digitEnabled) {
      res.status(400).json({ error: "This bot needs a digit-enabled market" });
      return;
    }
    if (typeof body.stake !== "number" || body.stake < 0.35) {
      res.status(400).json({ error: "stake must be ≥ 0.35" });
      return;
    }
    let lockedSymbol: string | undefined;
    if (marketMode === "locked") {
      if (typeof body.lockedSymbol !== "string" || !body.lockedSymbol) {
        res.status(400).json({ error: "lockedSymbol is required in locked-market mode" });
        return;
      }
      if (!isAutomatedMarket(body.lockedSymbol)) {
        res.status(400).json({ error: `${body.lockedSymbol} cannot be analysed or traded by this bot` });
        return;
      }
      lockedSymbol = body.lockedSymbol;
    }
    const card = body.card ?? body.analysis?.card;
    if (!card || typeof card.tau !== "number" || !Number.isFinite(card.tau)) {
      res.status(400).json({ error: "Run the analysis first — the measured model card is required" });
      return;
    }
    const existingOwner = matchNexus.getOwnerSessionId();
    if (matchNexus.isRunning() && existingOwner && existingOwner !== req.sessionId) {
      res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
      return;
    }
    const result = await matchNexus.startSession({
      ownerSessionId: req.sessionId,
      botId: parsed.spec.botId,
      spec: parsed.spec,
      stake: body.stake,
      stopLoss: typeof body.stopLoss === "number" && body.stopLoss > 0 ? body.stopLoss : 5,
      takeProfit: typeof body.takeProfit === "number" && body.takeProfit > 0 ? body.takeProfit : 10,
      maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
      marketMode,
      lockedSymbol,
      symbol: market.symbol,
      displayName: market.displayName,
      digit: Number.isInteger(body.digit) ? Number(body.digit) : (body.contract?.digit ?? parsed.spec.digit ?? 5),
      card,
      lockedAnalysis: body.analysis,
    });
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true, status: visibleNexusStatus(req.sessionId) });
    return;
  }

  const parsed = parseFamilySpec(botId, body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const marketMode: "locked" | "switching" = body.marketMode === "locked" ? "locked" : "switching";
  const requested = typeof body.symbol === "string" ? body.symbol : undefined;
  if (!requested || !isAutomatedMarket(requested)) {
    res.status(400).json({ error: "Run the analysis first — this bot deploys onto a market it has measured" });
    return;
  }
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === requested);
  if (!market || !market.digitEnabled) {
    res.status(400).json({ error: "This bot needs a digit-enabled market" });
    return;
  }
  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  const contract = validateShotContract(body.contract);
  if (!contract.ok) {
    res.status(400).json({ error: contract.error });
    return;
  }

  let lockedSymbol: string | undefined;
  if (marketMode === "locked") {
    if (typeof body.lockedSymbol !== "string" || !body.lockedSymbol) {
      res.status(400).json({ error: "lockedSymbol is required in locked-market mode" });
      return;
    }
    if (!isAutomatedMarket(body.lockedSymbol)) {
      res.status(400).json({ error: `${body.lockedSymbol} cannot be analysed or traded by this bot` });
      return;
    }
    lockedSymbol = body.lockedSymbol;
  }

  const card = body.card ?? body.analysis?.card;
  if (!card || typeof card.tau !== "number" || !Number.isFinite(card.tau)) {
    res.status(400).json({ error: "Run the analysis first — the measured model card is required before this bot can deploy" });
    return;
  }

  const existingOwner = killshotFamily.getOwnerSessionId();
  if (killshotFamily.isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
    return;
  }

  const result = await killshotFamily.startSession({
    ownerSessionId: req.sessionId,
    botId: parsed.spec.botId,
    spec: parsed.spec,
    stake: body.stake,
    stopLoss: typeof body.stopLoss === "number" && body.stopLoss > 0 ? body.stopLoss : 5,
    takeProfit: typeof body.takeProfit === "number" && body.takeProfit > 0 ? body.takeProfit : 10,
    maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
    marketMode,
    lockedSymbol,
    symbol: market.symbol,
    displayName: market.displayName,
    contract: contract.contract,
    card,
    lockedAnalysis: body.analysis,
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status: visibleFamilyStatus(req.sessionId) });
});

router.post("/family/stop", (req, res) => {
  const owner = killshotFamily.getOwnerSessionId();
  if (killshotFamily.isRunning() && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's bot." });
    return;
  }
  const nexusOwner = matchNexus.getOwnerSessionId();
  if (matchNexus.isRunning() && nexusOwner && nexusOwner === req.sessionId) {
    matchNexus.stopSession();
    res.json({ ok: true, status: visibleNexusStatus(req.sessionId) });
    return;
  }
  killshotFamily.stopSession();
  res.json({ ok: true, status: visibleFamilyStatus(req.sessionId) });
});

// ── Match Nexus — Quantum Singularity ────────────────────────────────────────

function visibleNexusStatus(sessionId: string) {
  const status = matchNexus.getStatus();
  const owner = matchNexus.getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return { ...status, running: false, sessionId: null, config: undefined, deployed: undefined, familyWatch: undefined };
}

function parseNexusSpec(botId: string, body: any):
  { ok: true; spec: matchNexus.NexusDeploySpec } | { ok: false; error: string } {
  if (botId !== "match-nexus") return { ok: false, error: "Unknown bot" };
  const certainty = parseNexusCertainty(body?.certainty);
  const hasDigit = body?.digit !== undefined && body?.digit !== null && body?.digit !== "";
  let digit: number | undefined;
  if (hasDigit) {
    const d = Number(body?.digit);
    if (!Number.isInteger(d) || d < 0 || d > 9) return { ok: false, error: "digit must be 0–9" };
    digit = d;
  }
  return {
    ok: true,
    spec: {
      botId,
      digit,
      aiDigit: !hasDigit,
      certainty,
    },
  };
}

router.get("/nexus/status", (req, res) => {
  res.json(visibleNexusStatus(req.sessionId));
});

router.post("/nexus/scan", async (req, res): Promise<void> => {
  const parsed = parseNexusSpec(String(req.body?.botId ?? "match-nexus"), req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const risk = await killshotRisk(req.sessionId, req.body);
    const result = await matchNexus.scanForNexus(req.sessionId, parsed.spec, risk);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Match Nexus scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/nexus/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const parsed = parseNexusSpec(String(body.botId ?? "match-nexus"), body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const marketMode: "locked" | "switching" = body.marketMode === "locked" ? "locked" : "switching";
  const requested = typeof body.symbol === "string" ? body.symbol : undefined;
  if (!requested || !isAutomatedMarket(requested)) {
    res.status(400).json({ error: "Run the analysis first — this bot deploys onto a market it has measured" });
    return;
  }
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === requested);
  if (!market || !market.digitEnabled) {
    res.status(400).json({ error: "This bot needs a digit-enabled market" });
    return;
  }
  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }
  let lockedSymbol: string | undefined;
  if (marketMode === "locked") {
    if (typeof body.lockedSymbol !== "string" || !body.lockedSymbol) {
      res.status(400).json({ error: "lockedSymbol is required in locked-market mode" });
      return;
    }
    if (!isAutomatedMarket(body.lockedSymbol)) {
      res.status(400).json({ error: `${body.lockedSymbol} cannot be analysed or traded by this bot` });
      return;
    }
    lockedSymbol = body.lockedSymbol;
  }
  const card = body.card ?? body.analysis?.card;
  if (!card || typeof card.tau !== "number" || !Number.isFinite(card.tau)) {
    res.status(400).json({ error: "Run the analysis first — the measured model card is required" });
    return;
  }
  const existingOwner = matchNexus.getOwnerSessionId();
  if (matchNexus.isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
    return;
  }
  const result = await matchNexus.startSession({
    ownerSessionId: req.sessionId,
    botId: parsed.spec.botId,
    spec: parsed.spec,
    stake: body.stake,
    stopLoss: typeof body.stopLoss === "number" && body.stopLoss > 0 ? body.stopLoss : 5,
    takeProfit: typeof body.takeProfit === "number" && body.takeProfit > 0 ? body.takeProfit : 10,
    maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
    marketMode,
    lockedSymbol,
    symbol: market.symbol,
    displayName: market.displayName,
    digit: Number.isInteger(body.digit) ? Number(body.digit) : (body.contract?.digit ?? parsed.spec.digit ?? 5),
    card,
    lockedAnalysis: body.analysis,
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status: visibleNexusStatus(req.sessionId) });
});

router.post("/nexus/stop", (req, res) => {
  const owner = matchNexus.getOwnerSessionId();
  if (matchNexus.isRunning() && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's bot." });
    return;
  }
  matchNexus.stopSession();
  res.json({ ok: true, status: visibleNexusStatus(req.sessionId) });
});

// ── Status ────────────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  const dual = visibleDualStatus(req.sessionId);
  if (dual.running) { res.json(dual); return; }
  const shot = visibleKillShotStatus(req.sessionId);
  if (shot.running) { res.json(shot); return; }
  const nexus = visibleNexusStatus(req.sessionId);
  if (nexus.running) { res.json(nexus); return; }
  const fam = visibleFamilyStatus(req.sessionId);
  if (fam.running) { res.json(fam); return; }
  res.json(visibleStatus(req.sessionId));
});

// ── Scan (specialist) ─────────────────────────────────────────────────────────

router.post("/:botId/scan", async (req, res): Promise<void> => {
  if (req.params["botId"] === "match-nexus") {
    const parsed = parseNexusSpec("match-nexus", req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const risk = await killshotRisk(req.sessionId, req.body);
      const result = await matchNexus.scanForNexus(req.sessionId, parsed.spec, risk);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Match Nexus scan failed");
      res.status(500).json({ error: "Scan failed" });
    }
    return;
  }

  const parsed = validateBotBody(req.params["botId"]!, req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const result = await scanBestMarketForBot({
      botId: req.params["botId"]!,
      ownerSessionId: req.sessionId,
      ...parsed.data,
    } as BotConfig);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Specialist bot scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

// ── Start (specialist) ────────────────────────────────────────────────────────

router.post("/:botId/start", async (req, res): Promise<void> => {
  const botId = req.params["botId"]!;
  if (botId === "match-nexus") {
    const body = req.body ?? {};
    const parsed = parseNexusSpec(botId, body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const marketMode: "locked" | "switching" = body.marketMode === "locked" ? "locked" : "switching";
    const requested = typeof body.symbol === "string" ? body.symbol : undefined;
    if (!requested || !isAutomatedMarket(requested)) {
      res.status(400).json({ error: "Run the analysis first — this bot deploys onto a market it has measured" });
      return;
    }
    const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === requested);
    if (!market || !market.digitEnabled) {
      res.status(400).json({ error: "This bot needs a digit-enabled market" });
      return;
    }
    if (typeof body.stake !== "number" || body.stake < 0.35) {
      res.status(400).json({ error: "stake must be ≥ 0.35" });
      return;
    }
    let lockedSymbol: string | undefined;
    if (marketMode === "locked") {
      if (typeof body.lockedSymbol !== "string" || !body.lockedSymbol) {
        res.status(400).json({ error: "lockedSymbol is required in locked-market mode" });
        return;
      }
      if (!isAutomatedMarket(body.lockedSymbol)) {
        res.status(400).json({ error: `${body.lockedSymbol} cannot be analysed or traded by this bot` });
        return;
      }
      lockedSymbol = body.lockedSymbol;
    }
    const card = body.card ?? body.analysis?.card;
    if (!card || typeof card.tau !== "number" || !Number.isFinite(card.tau)) {
      res.status(400).json({ error: "Run the analysis first — the measured model card is required" });
      return;
    }
    const existingOwner = matchNexus.getOwnerSessionId();
    if (matchNexus.isRunning() && existingOwner && existingOwner !== req.sessionId) {
      res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
      return;
    }
    const result = await matchNexus.startSession({
      ownerSessionId: req.sessionId,
      botId: parsed.spec.botId,
      spec: parsed.spec,
      stake: body.stake,
      stopLoss: typeof body.stopLoss === "number" && body.stopLoss > 0 ? body.stopLoss : 5,
      takeProfit: typeof body.takeProfit === "number" && body.takeProfit > 0 ? body.takeProfit : 10,
      maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
      marketMode,
      lockedSymbol,
      symbol: market.symbol,
      displayName: market.displayName,
      digit: Number.isInteger(body.digit) ? Number(body.digit) : (body.contract?.digit ?? parsed.spec.digit ?? 5),
      card,
      lockedAnalysis: body.analysis,
    });
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true, status: visibleNexusStatus(req.sessionId) });
    return;
  }

  const parsed = validateBotBody(botId, req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const existingOwner = getOwnerSessionId();
  const status = getStatus();
  if (status.running && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another isolated browser session is currently running a specialist bot. Your Deriv account was not touched." });
    return;
  }

  const config: BotConfig = {
    ownerSessionId: req.sessionId,
    botId,
    ...parsed.data,
  };

  const result = await startSession(config);
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status: visibleStatus(req.sessionId) });
});

// ── Stop (specialist) ─────────────────────────────────────────────────────────

router.post("/:botId/stop", (req, res) => {
  const botId = req.params["botId"]!;
  if (botId === "match-nexus") {
    const owner = matchNexus.getOwnerSessionId();
    if (matchNexus.isRunning() && owner && owner !== req.sessionId) {
      res.status(409).json({ error: "You cannot stop another browser session's specialist bot." });
      return;
    }
    matchNexus.stopSession();
    res.json({ ok: true, status: visibleNexusStatus(req.sessionId) });
    return;
  }

  const owner = getOwnerSessionId();
  const status = getStatus();
  if (status.running && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's specialist bot." });
    return;
  }
  stopSession();
  res.json({ ok: true, status: visibleStatus(req.sessionId) });
});

export default router;
