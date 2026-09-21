/**
 * Vector Surge routes — Rise/Fall momentum specialist with recovery-first intelligence.
 *
 * Mounted at /api/bots/surge (see routes/bots.ts). Deploys ONLY from its own
 * console: the generic /:botId/* specialist endpoints refuse it, and every start
 * re-validates the side mode, market and the measured card the scan produced.
 * No pace parameter — one mode, pacing valve for normal, static bar for recovery.
 */

import { Router } from "express";
import { logger } from "../lib/logger";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import type { SurgeParams, SurgeSideMode } from "../lib/surge-analysis";
import {
  SURGE_BOT_ID,
  getStatus,
  isRunning,
  getOwnerSessionId,
  scanForSurge,
  startSession,
  stopSession,
  type SurgeCandidate,
} from "../lib/surge-engine";

const router = Router();

function parseSideMode(raw: unknown): SurgeSideMode {
  if (raw === "rise") return "rise";
  if (raw === "fall") return "fall";
  return "both";
}

function parseParams(raw: any): SurgeParams | null {
  if (!raw || typeof raw !== "object") return null;
  const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
  const w = Array.isArray(raw.weights) ? raw.weights.map(num) : null;
  const tau = num(raw.tau);
  const normalInitBar = num(raw.normalInitBar);
  if (!w || w.length !== 4 || w.some((v: number | null) => v === null)) return null;
  if (tau === null || normalInitBar === null) return null;
  if (tau < 0.3 || tau > 3) return null;
  const sum = (w[0] as number) + (w[1] as number) + (w[2] as number) + (w[3] as number);
  if (!(sum > 0)) return null;
  return {
    weights: [(w[0] as number) / sum, (w[1] as number) / sum, (w[2] as number) / sum, (w[3] as number) / sum],
    tau,
    normalInitBar: Math.min(0.95, Math.max(0, normalInitBar)),
  };
}

function parseCandidate(raw: any): SurgeCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.symbol !== "string" || typeof raw.displayName !== "string") return null;
  if (typeof raw.verdict !== "string" || typeof raw.confidence !== "number") return null;
  if (typeof raw.paperEdgePerDollar !== "number" || typeof raw.recoveryHitRate !== "number") return null;
  if (typeof raw.recoveryShots !== "number" || typeof raw.normalShots !== "number") return null;
  if (!raw.params || typeof raw.params !== "object") return null;
  return raw as SurgeCandidate;
}

router.get("/status", (req, res) => {
  const owner = getOwnerSessionId();
  const status = getStatus();
  if (owner && owner !== req.sessionId) {
    res.json({ ...status, running: false, sessionId: null, config: undefined, surgeDeployed: undefined, surgeWatch: undefined });
    return;
  }
  res.json(status);
});

router.post("/scan", async (req, res): Promise<void> => {
  try {
    const result = await scanForSurge(req.sessionId);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Vector Surge scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const sideMode = parseSideMode(body.sideMode);
  const marketMode: "locked" | "switching" = body.marketMode === "locked" ? "locked" : "switching";
  const requested = typeof body.symbol === "string" ? body.symbol : undefined;
  if (!requested || !isAutomatedMarket(requested)) {
    res.status(400).json({ error: "Run the scan first — this bot deploys onto a market it has measured" });
    return;
  }
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === requested);
  if (!market) {
    res.status(400).json({ error: "This bot needs a price-enabled market" });
    return;
  }
  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  let lockedSymbol: string | undefined;
  if (marketMode === "locked") {
    const want = typeof body.lockedSymbol === "string" && body.lockedSymbol ? body.lockedSymbol : requested;
    if (!isAutomatedMarket(want)) {
      res.status(400).json({ error: `${want} cannot be analysed or traded by this bot` });
      return;
    }
    lockedSymbol = want;
  }

  const params = parseParams(body.params ?? body.analysis?.params);
  if (!params) {
    res.status(400).json({ error: "Run the scan first — the measured parameter card is required before this bot can deploy" });
    return;
  }
  const analysis = parseCandidate(body.analysis ?? null);

  const existingOwner = getOwnerSessionId();
  if (isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
    return;
  }

  const result = await startSession({
    ownerSessionId: req.sessionId,
    spec: { sideMode },
    stake: body.stake,
    stopLoss: typeof body.stopLoss === "number" && body.stopLoss > 0 ? body.stopLoss : 5,
    takeProfit: typeof body.takeProfit === "number" && body.takeProfit > 0 ? body.takeProfit : 10,
    maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
    marketMode,
    ...(lockedSymbol ? { lockedSymbol } : {}),
    symbol: market.symbol,
    displayName: market.displayName,
    params,
    ...(analysis ? { lockedAnalysis: analysis } : {}),
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  logger.info({ botId: SURGE_BOT_ID, symbol: market.symbol, sideMode, marketMode }, "Vector Surge deployed");
  const status = getStatus();
  res.json({ ok: true, status });
});

router.post("/stop", (req, res) => {
  const owner = getOwnerSessionId();
  if (isRunning() && owner && owner !== req.sessionId) {
    res.status(409).json({ error: "You cannot stop another browser session's bot." });
    return;
  }
  stopSession();
  res.json({ ok: true, status: getStatus() });
});

export default router;
