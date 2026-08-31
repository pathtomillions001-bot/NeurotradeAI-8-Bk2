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
  res.json({
    bots: BOT_CATALOG.map(bot => ({
      ...bot,
      session: status.running && status.botId === bot.id ? status : null,
    })),
    activeBotId: status.running ? status.botId : null,
  });
});

// ── Status ────────────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
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
