/**
 * Echo Apex routes — the 11th AI bot (Matches only).
 *
 * Mounted at /api/bots/apex (see routes/bots.ts). The bot deploys ONLY from
 * its own console: the generic /:botId/* specialist endpoints refuse it, and
 * every start re-validates pace, digit, market, boundaries and the measured
 * parameter card the scan produced.
 */

import { Router } from "express";
import { logger } from "../lib/logger";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import { sanitizeApexParams, type ApexPace } from "../lib/apex-analysis";
import {
  APEX_BOT_ID,
  getStatus,
  isRunning,
  getOwnerSessionId,
  scanForApex,
  startSession,
  stopSession,
  type ApexCandidate,
} from "../lib/apex-engine";

const router = Router();

const PACES: ApexPace[] = ["brisk", "steady", "patient"];

function parsePace(raw: unknown): ApexPace | null {
  return raw === "brisk" || raw === "steady" || raw === "patient" ? raw : null;
}

function parseDigit(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const d = Number(raw);
  if (!Number.isInteger(d) || d < 0 || d > 9) return null;
  return d;
}

function parseCandidate(raw: any): ApexCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.symbol !== "string" || typeof raw.displayName !== "string") return null;
  if (!Number.isInteger(raw.digit) || raw.digit < 0 || raw.digit > 9) return null;
  if (typeof raw.verdict !== "string" || typeof raw.confidence !== "number") return null;
  if (typeof raw.edgePerDollar !== "number" || typeof raw.hitRate !== "number") return null;
  if (typeof raw.shots !== "number" || typeof raw.fireRate !== "number") return null;
  if (typeof raw.breakEven !== "number" || typeof raw.payout !== "number") return null;
  if (!raw.params || typeof raw.params !== "object") return null;
  if (!raw.diag || typeof raw.diag !== "object") return null;
  return raw as ApexCandidate;
}

router.get("/status", (req, res) => {
  const owner = getOwnerSessionId();
  const status = getStatus();
  if (owner && owner !== req.sessionId) {
    res.json({ ...status, running: false, sessionId: null, config: undefined, apexDeployed: undefined, apexWatch: undefined });
    return;
  }
  res.json(status);
});

router.post("/scan", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const pace = parsePace(body.pace ?? "steady");
  if (!pace) {
    res.status(400).json({ error: "pace must be brisk, steady or patient" });
    return;
  }
  const digit = parseDigit(body.digit);
  if (digit === null) {
    res.status(400).json({ error: "digit must be an integer 0–9" });
    return;
  }
  try {
    const result = await scanForApex(req.sessionId, {
      pace,
      ...(digit !== undefined ? { digit } : {}),
      aiDigit: digit === undefined,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Echo Apex scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const pace = parsePace(body.pace ?? "steady");
  if (!pace) {
    res.status(400).json({ error: "pace must be brisk, steady or patient" });
    return;
  }
  const digit = parseDigit(body.digit);
  if (digit === null) {
    res.status(400).json({ error: "digit must be an integer 0–9" });
    return;
  }
  const marketMode: "locked" | "switching" = body.marketMode === "locked" ? "locked" : "switching";
  const requested = typeof body.symbol === "string" ? body.symbol : undefined;
  if (!requested || !isAutomatedMarket(requested)) {
    res.status(400).json({ error: "Run the scan first — this bot deploys onto a market it has measured" });
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

  // A locked deployment pins the measured market; switching starts there and
  // may migrate. Older bundles may omit lockedSymbol — default to the market.
  let lockedSymbol: string | undefined;
  if (marketMode === "locked") {
    const want = typeof body.lockedSymbol === "string" && body.lockedSymbol ? body.lockedSymbol : requested;
    if (!isAutomatedMarket(want)) {
      res.status(400).json({ error: `${want} cannot be analysed or traded by this bot` });
      return;
    }
    lockedSymbol = want;
  }

  const params = sanitizeApexParams(body.params ?? body.analysis?.params, pace, digit);
  if (!params) {
    res.status(400).json({ error: "Run the scan first — the measured parameter card is required before this bot can deploy" });
    return;
  }
  const analysis = parseCandidate(body.analysis ?? null);
  if (digit !== undefined && analysis && analysis.digit !== digit) {
    res.status(400).json({ error: "The locked digit does not match the measured card — re-scan before deploying" });
    return;
  }

  const existingOwner = getOwnerSessionId();
  if (isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({ error: "Another browser session is running this bot. Your Deriv account was not touched." });
    return;
  }

  const result = await startSession({
    ownerSessionId: req.sessionId,
    spec: { pace, ...(digit !== undefined ? { digit } : {}), aiDigit: digit === undefined },
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
  logger.info({ botId: APEX_BOT_ID, symbol: market.symbol, pace, marketMode }, "Echo Apex deployed");
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
