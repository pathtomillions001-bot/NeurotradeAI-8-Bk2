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
import { BOT_CATALOG, getBotDefinition, type BotSideMode } from "../lib/bot-catalog";
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
import * as killShot from "../lib/killshot-engine";
import { validateKillShotContract, killShotLabel } from "../lib/killshot-analysis";
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
  // Pre-locked bots (Dual-Lock Range Sentinel) have their own endpoints — they
  // are never driven through the generic specialist route.
  if (bot.preLocked) return { ok: false, error: `${bot.name} uses the /duallock endpoints` };
  // Sniper bots (Kill-Shot Precision Sniper) likewise have their own endpoints.
  if (bot.sniper) return { ok: false, error: `${bot.name} uses the /killshot endpoints` };

  const sideMode: BotSideMode = body.sideMode === "primary" || body.sideMode === "secondary"
    ? body.sideMode
    : "both";
  const sideOption = bot.sides.find(s => s.id === sideMode) ?? bot.sides[0]!;
  if (bot.sides.length === 1 && sideMode !== bot.sides[0]!.id) {
    return { ok: false, error: `${bot.name} has a single contract side` };
  }
  const contractTypes = sideOption.contracts as BotContractType[];

  // Barriers (barrier bot only).
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

  // Digit lock (match / differ bots only).
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

/** Status as this browser session may see it (other sessions are blanked). */
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
  const snipe = visibleKillShotStatus(req.sessionId);
  res.json({
    bots: BOT_CATALOG.map(bot => {
      if (bot.id === dualLock.DUAL_LOCK_BOT_ID) {
        return { ...bot, session: dual.running ? dual : null };
      }
      if (bot.id === killShot.KILLSHOT_BOT_ID) {
        return { ...bot, session: snipe.running ? snipe : null };
      }
      return { ...bot, session: status.running && status.botId === bot.id ? status : null };
    }),
    activeBotId: dual.running
      ? dualLock.DUAL_LOCK_BOT_ID
      : snipe.running
        ? killShot.KILLSHOT_BOT_ID
        : (status.running ? status.botId : null),
  });
});

// ── Dual-Lock Range Sentinel (pre-locked bot) ─────────────────────────────────
//
// This bot has its own engine because its lifecycle is different: ALL analysis
// runs once in /scan, the chosen (market, normal, recovery) triple is frozen,
// and /start simply executes it until TP or SL. It shares the account-global
// recovery ledger, the recovery stake formula and the single-executor arbiter
// with the other five bots.

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
  // The Dual-Lock bot commits its risk parameters on the FIRST scan of an
  // engagement and refuses to change them afterwards — a re-scan may move the
  // market and contract pair, never the stake / TP / SL / steps.
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

/**
 * Start a brand-new Dual-Lock engagement — releases the committed risk
 * parameters so the next scan may set fresh ones. Refused while a session runs.
 */
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
      // Echo the parameters the scan ACTUALLY used, plus whether the request
      // tried to change locked ones, so the console can tell the user.
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
  // In hunt mode the market is only the STARTING target — the loop re-selects it
  // continuously — so it may be omitted and the first digit-enabled market is
  // used. In lock mode it is frozen for the session and must be named.
  const targetMode = body.targetMode === "lock" ? "lock" : "hunt";
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

  // Risk parameters are whatever was committed at the first scan of this
  // engagement — the start request cannot widen or change them. This is what
  // guarantees the quoted survival figure applies to the session being run.
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

// ── Kill-Shot Precision Sniper (sniper bot) ───────────────────────────────────
//
// Its own engine because its lifecycle is different again: the user names ONE
// contract, the scan names ONE market, both are frozen, and the engine then
// simply waits — sometimes a long time — until the full evidence stack clears.
// It shares the account-global recovery ledger, the recovery stake formula and
// the single-executor arbiter with every other bot in the section.

function visibleKillShotStatus(sessionId: string) {
  const status = killShot.getStatus();
  const owner = killShot.getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return { ...status, running: false, sessionId: null, config: undefined, killLock: undefined, hunt: undefined };
}

router.get("/killshot/status", (req, res) => {
  res.json(visibleKillShotStatus(req.sessionId));
});

/**
 * Scan every digit-enabled market for the user's ONE chosen contract.
 * When the contract is Matches with no digit, all ten digits are scored too and
 * the SPRT threshold carries a log(#candidates) selection surcharge.
 */
router.post("/killshot/scan", async (req, res): Promise<void> => {
  const parsed = validateKillShotContract(req.body?.contract);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const result = await killShot.scanForTarget(req.sessionId, parsed.contract);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Kill-Shot scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/killshot/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};

  const parsed = validateKillShotContract(body.contract);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  // A Matches digit must be resolved (by the user or by the scan) before the
  // contract can be frozen — the engine will not choose one mid-session.
  if (parsed.contract.kind === "match" && parsed.contract.digit === undefined) {
    res.status(400).json({ error: "Run the scan first so the AI can select the Matches digit" });
    return;
  }

  // In hunt mode the market is only the STARTING target — the loop re-selects it
  // continuously — so it may be omitted and the first digit-enabled market is
  // used. In lock mode it is frozen for the session and must be named.
  const targetMode = body.targetMode === "lock" ? "lock" : "hunt";
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

  const existingOwner = killShot.getOwnerSessionId();
  if (killShot.isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
    return;
  }

  const result = await killShot.startSession({
    ownerSessionId: req.sessionId,
    symbol: market.symbol,
    displayName: market.displayName,
    contract: parsed.contract,
    stake: body.stake,
    stopLoss: typeof body.stopLoss === "number" && body.stopLoss > 0 ? body.stopLoss : 5,
    takeProfit: typeof body.takeProfit === "number" && body.takeProfit > 0 ? body.takeProfit : 10,
    maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
    maxTrades: Math.max(0, Math.min(100, Number(body.maxTrades) || 0)),
    targetMode,
    lockedAnalysis: body.analysis,
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  logger.info({ symbol: market.symbol, contract: killShotLabel(parsed.contract), targetMode }, "Kill-Shot deployed");
  res.json({ ok: true, status: visibleKillShotStatus(req.sessionId) });
});

router.post("/killshot/stop", (req, res) => {
  const owner = killShot.getOwnerSessionId();
  if (killShot.isRunning() && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's bot." });
    return;
  }
  killShot.stopSession();
  res.json({ ok: true, status: visibleKillShotStatus(req.sessionId) });
});

// ── Status ────────────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  const dual = visibleDualStatus(req.sessionId);
  if (dual.running) { res.json(dual); return; }
  const snipe = visibleKillShotStatus(req.sessionId);
  if (snipe.running) { res.json(snipe); return; }
  res.json(visibleStatus(req.sessionId));
});

// ── Scan ──────────────────────────────────────────────────────────────────────

router.post("/:botId/scan", async (req, res): Promise<void> => {
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

// ── Start ─────────────────────────────────────────────────────────────────────

router.post("/:botId/start", async (req, res): Promise<void> => {
  const botId = req.params["botId"]!;
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

// ── Stop ──────────────────────────────────────────────────────────────────────

router.post("/:botId/stop", (req, res) => {
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
