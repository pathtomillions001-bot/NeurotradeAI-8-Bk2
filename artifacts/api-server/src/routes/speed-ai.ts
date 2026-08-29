import { Router } from "express";
import {
  startSession,
  stopSession,
  getStatus,
  analyzeMarketsForStrategy,
  scanBestMarket,
  type SpeedAIConfig,
  type SpeedContractType,
} from "../lib/speed-ai-engine";
import { logger } from "../lib/logger";
const router = Router();

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

router.get("/status", (_req, res) => {
  res.json(getStatus());
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
    const result = await scanBestMarket(parsed.data as SpeedAIConfig);
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

  const config: SpeedAIConfig = {
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
  res.json({ ok: true, status: getStatus() });
});

// ── Stop session ──────────────────────────────────────────────────────────────

router.post("/stop", (_req, res) => {
  stopSession();
  res.json({ ok: true, status: getStatus() });
});

export default router;
