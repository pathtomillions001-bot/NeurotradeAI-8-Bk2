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
import * as killshot from "../lib/killshot-engine";
import * as killshotFamily from "../lib/killshot-family-engine";
import * as twinAvoid from "../lib/twin-avoid-engine";
import { validateShotContract, validateShotPlan, shotLabel, shotPlanLabel, type Certainty } from "../lib/killshot-analysis";
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
  // One-shot bots (Kill-Shot Oracle) likewise have their own endpoints.
  if (bot.oneShot) return { ok: false, error: `${bot.name} uses the /killshot endpoints` };

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
  const shot = visibleKillShotStatus(req.sessionId);
  const fam = visibleFamilyStatus(req.sessionId);
  const twin = visibleTwinStatus(req.sessionId);
  res.json({
    bots: BOT_CATALOG.map(bot => {
      if (bot.id === dualLock.DUAL_LOCK_BOT_ID) {
        return { ...bot, session: dual.running ? dual : null };
      }
      if (bot.id === killshot.KILLSHOT_BOT_ID) {
        return { ...bot, session: shot.running ? shot : null };
      }
      if (bot.killShotFamily) {
        return { ...bot, session: fam.running && fam.botId === bot.id ? fam : null };
      }
      if (bot.twinHedge) {
        return { ...bot, session: twin.running ? twin : null };
      }
      return { ...bot, session: status.running && status.botId === bot.id ? status : null };
    }),
    activeBotId: dual.running
      ? dualLock.DUAL_LOCK_BOT_ID
      : shot.running
        ? killshot.KILLSHOT_BOT_ID
        : fam.running
          ? (fam.botId ?? null)
          : twin.running
            ? (twin.botId ?? null)
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

// ── Kill-Shot Oracle (one-shot bot) ───────────────────────────────────────────
//
// Its own engine because its lifecycle is different again: the user names ONE
// contract, the scan pulls deep history for every digit market, fits its model
// on half of it and MEASURES the entry rule on the other half, then names ONE
// market. Both the market and the model card are frozen, and the engine waits —
// sometimes a long time — until health, edge, the post-loss shield and the tick
// all agree. There is no hunt mode and no rotation. It shares the account-global
// recovery ledger, the recovery stake formula and the single-executor arbiter
// with every other bot in the section.

function visibleKillShotStatus(sessionId: string) {
  const status = killshot.getStatus();
  const owner = killshot.getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return { ...status, running: false, sessionId: null, config: undefined, killshotLock: undefined, watch: undefined, needsRescan: false };
}

router.get("/killshot/status", (req, res) => {
  res.json(visibleKillShotStatus(req.sessionId));
});

/** Read the bot-recovery markup + stake cap the ladder projection must use. */
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

/**
 * Analyse every digit-enabled market for the user's PLAN — any combination of
 * contracts (both sides of a pair allowed) — and return the full ranking, the
 * per-market deployments, and the best market available even when nothing is
 * CERTIFIED, so the client can offer a deliberate lock instead of a dead end.
 *
 * An AI Matches/Differs fans out to all ten digits in every market and
 * Benjamini–Hochberg runs across the whole plan × market × digit family.
 */
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
  // An AI Matches/Differs digit is NOT resolved before deployment: the bot is
  // allowed to change it live with the market. Only the market is locked.

  // The market must be named, and it must be one the scan is allowed to look at.
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
  // The measured model cards are what make the live rule identical to the
  // measured one. Without them there is nothing to deploy — the analysis IS the
  // product. Accept the per-contract `cards` map (a plan) or a single `card`.
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

// ── Kill-Shot Family Oracles (Over/Under · Even/Odd · Matches/Differs) ────────
//
// Three bots that borrow the Kill-Shot Oracle's measurement unchanged and apply
// it to a whole contract family. Unlike the one-shot Oracle they never dead-end:
// in locked mode the EDGE rotates inside the frozen market, in switching mode the
// MARKET rotates to the next best — either way the session runs to TP/SL/stop.

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

  // matchdiffer
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

/** Measure every market for this bot's family and return a compact ranking. */
router.post("/family/scan", async (req, res): Promise<void> => {
  const parsed = parseFamilySpec(String(req.body?.botId ?? ""), req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const risk = await killshotRisk(req.sessionId, req.body);
    const result = await killshotFamily.scanForFamily(req.sessionId, parsed.spec, risk);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Kill-Shot family scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/family/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const parsed = parseFamilySpec(String(body.botId ?? ""), body);
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
  killshotFamily.stopSession();
  res.json({ ok: true, status: visibleFamilyStatus(req.sessionId) });
});

// ── Twin-Hedge Edge (auto-configured twin pair) ──────────────────────────────
//
// The contract plan is fixed (normal Over 4 + Under 5, recovery Over 5 +
// Under 4) — the request body carries risk settings and the scan's measured
// card, never contract choices. Its own lifecycle because a pair, not a
// single contract, is the unit being analysed and executed.

function visibleTwinStatus(sessionId: string) {
  const status = twinAvoid.getStatus();
  const owner = twinAvoid.getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return { ...status, running: false, sessionId: null, config: undefined, twinDeployed: undefined, twinWatch: undefined };
}

/** Risk settings shared by scan (to size the out-of-sample simulation) and start. */
function parseTwinRisk(body: any): twinAvoid.TwinAvoidRisk {
  const stake = Number(body?.stake);
  const stopLoss = Number(body?.stopLoss);
  const takeProfit = Number(body?.takeProfit);
  const maxRecoverySteps = Math.max(1, Math.min(10, Number(body?.maxRecoverySteps) || 3));
  const markup = Number(body?.botRecoveryMarkup);
  const maxTradeStake = Number(body?.maxTradeStake);
  return {
    stake: Number.isFinite(stake) && stake >= 0.35 ? stake : 1,
    stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : 5,
    takeProfit: Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : 10,
    maxRecoverySteps,
    markupPercent: Number.isFinite(markup) && markup >= 0 ? markup : 10,
    maxTradeStake: Number.isFinite(maxTradeStake) && maxTradeStake > 0 ? maxTradeStake : 500,
  };
}

router.get("/twin/status", (req, res) => {
  res.json(visibleTwinStatus(req.sessionId));
});

router.post("/twin/scan", async (req, res): Promise<void> => {
  // The settings row supplies the recovery markup / max stake when the
  // console does not pass them, so the simulation prices recovery exactly
  // like the live session will.
  let risk = parseTwinRisk(req.body);
  try {
    const rows = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, req.sessionId)).limit(1);
    if (rows.length > 0) {
      const s = rows[0] as any;
      if (!Number.isFinite(Number(req.body?.botRecoveryMarkup)) && Number.isFinite(Number(s.botRecoveryMarkup))) {
        risk.markupPercent = Number(s.botRecoveryMarkup);
      }
      if (!Number.isFinite(Number(req.body?.maxTradeStake)) && Number.isFinite(Number(s.maxTradeStake))) {
        risk.maxTradeStake = Number(s.maxTradeStake);
      }
    }
  } catch {
    /* defaults are fine */
  }
  try {
    const result = await twinAvoid.scanForTwinAvoid(req.sessionId, risk);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Twin-Hedge scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/twin/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
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
  const risk = parseTwinRisk(body);

  // The measured card is the analysis's receipt — without it the bot refuses
  // to deploy (it only trades markets it has measured out of sample).
  const card = body.card ?? body.analysis;
  if (!card || typeof card.baseline !== "number" || !Number.isFinite(card.baseline) ||
      typeof card.barNormal !== "number" || typeof card.barRecovery !== "number" ||
      typeof card.score !== "number" || typeof card.survival !== "number") {
    res.status(400).json({ error: "Run the analysis first — the measured market card is required before this bot can deploy" });
    return;
  }

  // Market mode comes from the analysis (the scan's decision), not the user.
  const marketMode: "locked" | "switching" =
    body.marketMode === "switching" || body.marketMode === "locked"
      ? body.marketMode
      : (typeof body.mode === "string" && body.mode === "switching" ? "switching" : "locked");
  const cluster: twinAvoid.TwinAvoidCard[] = Array.isArray(body.cluster) ? body.cluster : [];

  const existingOwner = twinAvoid.getOwnerSessionId();
  if (twinAvoid.isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
    return;
  }

  const result = await twinAvoid.startSession({
    ownerSessionId: req.sessionId,
    botId: twinAvoid.TWIN_AVOID_BOT_ID,
    stake: risk.stake,
    stopLoss: risk.stopLoss,
    takeProfit: risk.takeProfit,
    maxRecoverySteps: risk.maxRecoverySteps,
    marketMode,
    cluster,
    symbol: market.symbol,
    displayName: market.displayName,
    card,
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status: visibleTwinStatus(req.sessionId) });
});

router.post("/twin/stop", (req, res) => {
  const owner = twinAvoid.getOwnerSessionId();
  if (twinAvoid.isRunning() && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's bot." });
    return;
  }
  twinAvoid.stopSession();
  res.json({ ok: true, status: visibleTwinStatus(req.sessionId) });
});

// ── Status ────────────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  const dual = visibleDualStatus(req.sessionId);
  if (dual.running) { res.json(dual); return; }
  const shot = visibleKillShotStatus(req.sessionId);
  if (shot.running) { res.json(shot); return; }
  const fam = visibleFamilyStatus(req.sessionId);
  if (fam.running) { res.json(fam); return; }
  const twin = visibleTwinStatus(req.sessionId);
  if (twin.running) { res.json(twin); return; }
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
