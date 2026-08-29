import { Router } from "express";
import {
  startSession,
  stopSession,
  getStatus,
  getOwnerSessionId,
  analyzeMarketsForStrategy,
  scanBestMarket,
  type SpeedAIConfig,
  type SpeedContractType,
} from "../lib/speed-ai-engine";
import { logger } from "../lib/logger";
import { isAutomatedMarket } from "../lib/deriv";
const router = Router();

function getVisibleStatus(sessionId: string) {
  const status = getStatus();
  const owner = getOwnerSessionId();
  if (!owner || owner === sessionId) return status;
  return {
    ...status,
    running: false,
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
    message: "NeuroAI is ready",
  };
}

// ── Validation helper ──────────────────────────────────────────────────────────

function validateStartBody(body: any): { ok: true; data: any } | { ok: false; error: string } {
  if (!Array.isArray(body.normalContractTypes) || body.normalContractTypes.length === 0)
    return { ok: false, error: "normalContractTypes must be a non-empty array" };
  if (!Array.isArray(body.recoveryContractTypes) || body.recoveryContractTypes.length === 0)
    return { ok: false, error: "recoveryContractTypes must be a non-empty array" };
  // Strategy split: Differ (cold-digit avoidance, ~96% win) is normal-only; Match
  // (hot-digit, 8.93× payout) is recovery-only — it recovers a Differ loss cheaply.
  if (body.normalContractTypes.includes("DIGITMATCH"))
    return { ok: false, error: "DIGITMATCH (Matches) is recovery-only — use DIGITDIFF in normal mode" };
  if (body.recoveryContractTypes.includes("DIGITDIFF"))
    return { ok: false, error: "DIGITDIFF (Differs) is normal-only — use DIGITMATCH in recovery mode" };
  if (typeof body.stake !== "number" || body.stake < 0.35)
    return { ok: false, error: "stake must be ≥ 0.35" };
  if (typeof body.stopLoss !== "number" || body.stopLoss <= 0)
    return { ok: false, error: "stopLoss must be positive" };
  if (typeof body.takeProfit !== "number" || body.takeProfit <= 0)
    return { ok: false, error: "takeProfit must be positive" };
  if (body.marketMode === "locked" && typeof body.lockedSymbol === "string" && !isAutomatedMarket(body.lockedSymbol))
    return { ok: false, error: "Jump 100 Index is manual-only and cannot be analyzed or traded by NeuroAI" };
  return {
    ok: true,
    data: {
      normalContractTypes:   body.normalContractTypes,
      normalBarriers:        Array.isArray(body.normalBarriers) ? body.normalBarriers : [],
      recoveryContractTypes: body.recoveryContractTypes,
      recoveryBarriers:      Array.isArray(body.recoveryBarriers) ? body.recoveryBarriers : [],
      stake:                 body.stake,
      stopLoss:              body.stopLoss,
      takeProfit:            body.takeProfit,
      recoveryAutoMode:      body.recoveryAutoMode !== false,
      // Manual mode accepts the user's finite multiplier without a hidden floor/ceiling.
      recoveryMultiplier:    typeof body.recoveryMultiplier === "number" && Number.isFinite(body.recoveryMultiplier)
        ? body.recoveryMultiplier
        : 1.62,
      recoveryMethod:        body.recoveryMethod === "instant" ? "instant" : "split",
      maxRecoverySteps:      typeof body.maxRecoverySteps === "number" ? Math.max(1, Math.min(10, body.maxRecoverySteps)) : 3,
      lockedSymbol:          typeof body.lockedSymbol === "string" && body.lockedSymbol ? body.lockedSymbol : undefined,
      marketMode:            body.marketMode === "switching" ? "switching" : "locked",
    },
  };
}

// ── Status ────────────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  res.json(getVisibleStatus(req.sessionId));
});

// ── Analyze markets ────────────────────────────────────────────────────────────

router.get("/analyze", async (req, res): Promise<void> => {
  const rawTypes = req.query["contractTypes"];
  const rawBarriers = req.query["barriers"];

  const contractTypes: SpeedContractType[] = rawTypes
    ? String(rawTypes).split(",").filter(Boolean) as SpeedContractType[]
    : ["DIGITOVER", "DIGITUNDER"];

  const barriers: number[] = rawBarriers
    ? String(rawBarriers).split(",").map(Number).filter(n => !isNaN(n))
    : [1, 2, 7, 8];

  try {
    const results = await analyzeMarketsForStrategy(contractTypes, barriers);
    res.json({ markets: results.slice(0, 12) });
  } catch (err) {
    logger.error({ err }, "SpeedAI analyze failed");
    res.status(500).json({ error: "Analysis failed" });
  }
});

// ── Scan for best market ──────────────────────────────────────────────────────

router.post("/scan", async (req, res): Promise<void> => {
  const parsed = validateStartBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const result = await scanBestMarket({ ...parsed.data, ownerSessionId: req.sessionId } as SpeedAIConfig);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "SpeedAI scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

// ── Start session ──────────────────────────────────────────────────────────────

router.post("/start", async (req, res): Promise<void> => {
  const parsed = validateStartBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const existingOwner = getOwnerSessionId();
  if (getStatus().running && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another isolated browser session is currently using NeuroAI. Your Deriv account was not touched." });
    return;
  }

  const config: SpeedAIConfig = {
    ownerSessionId:        req.sessionId,
    normalContractTypes:   parsed.data.normalContractTypes as SpeedContractType[],
    normalBarriers:        parsed.data.normalBarriers,
    recoveryContractTypes: parsed.data.recoveryContractTypes as SpeedContractType[],
    recoveryBarriers:      parsed.data.recoveryBarriers,
    stake:                 parsed.data.stake,
    stopLoss:              parsed.data.stopLoss,
    takeProfit:            parsed.data.takeProfit,
    recoveryAutoMode:      parsed.data.recoveryAutoMode,
    recoveryMultiplier:    parsed.data.recoveryMultiplier,
    recoveryMethod:        parsed.data.recoveryMethod,
    maxRecoverySteps:      parsed.data.maxRecoverySteps,
    lockedSymbol:          parsed.data.lockedSymbol,
    marketMode:            parsed.data.marketMode,
  };

  const result = await startSession(config);
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status: getVisibleStatus(req.sessionId) });
});

// ── Stop session ──────────────────────────────────────────────────────────────

router.post("/stop", (req, res) => {
  const owner = getOwnerSessionId();
  if (getStatus().running && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's NeuroAI engine." });
    return;
  }
  stopSession();
  res.json({ ok: true, status: getVisibleStatus(req.sessionId) });
});

export default router;
