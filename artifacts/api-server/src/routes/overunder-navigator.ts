/** Routes for the configurable Over/Under Navigator bot. */

import { Router } from "express";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import { logger } from "../lib/logger";
import {
  NAVIGATOR_BOT_ID,
  getOwnerSessionId,
  getStatus,
  isRunning,
  scanForNavigator,
  startSession,
  stopSession,
  type NavigatorCandidate,
} from "../lib/overunder-navigator-engine";
import {
  validateNavigatorPlan,
  type NavigatorPlan,
  type NavigatorParams,
} from "../lib/overunder-navigator-analysis";

const router = Router();

function parseDigit(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}
function parseSide(raw: unknown): "both" | "over" | "under" {
  return raw === "over" || raw === "under" ? raw : "both";
}
function parsePlan(
  body: any,
): { ok: true; plan: NavigatorPlan } | { ok: false; error: string } {
  const plan: NavigatorPlan = {
    normalOver: parseDigit(body?.normalOver) ?? -1,
    normalUnder: parseDigit(body?.normalUnder) ?? -1,
    recoveryOver: parseDigit(body?.recoveryOver) ?? -1,
    recoveryUnder: parseDigit(body?.recoveryUnder) ?? -1,
    normalSide: parseSide(body?.normalSide),
    recoverySide: parseSide(body?.recoverySide),
  };
  const error = validateNavigatorPlan(plan);
  return error ? { ok: false, error } : { ok: true, plan };
}
function parseParams(raw: any): NavigatorParams | null {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray(raw.weights) ||
    (raw.weights.length !== 4 && raw.weights.length !== 6)
  )
    return null;
  const weights: number[] = raw.weights.map((value: unknown) => Number(value));
  const tau = Number(raw.tau);
  const normalInitBar = Number(raw.normalInitBar);
  if (
    weights.some((v: number) => !Number.isFinite(v)) ||
    !Number.isFinite(tau) ||
    !Number.isFinite(normalInitBar)
  )
    return null;
  const sum = weights.reduce((a: number, b: number) => a + b, 0);
  if (!(sum > 0) || tau < 0.3 || tau > 3) return null;
  // 6-lens weights (current) or legacy 4-lens (old scan cards) accepted.
  const expanded: number[] = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < weights.length; i++) expanded[i] = weights[i]! / sum;
  return {
    weights: expanded as unknown as NavigatorParams["weights"],
    tau,
    normalInitBar: Math.min(0.95, Math.max(0, normalInitBar)),
  };
}
function parseCandidate(raw: any): NavigatorCandidate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.symbol !== "string" || typeof raw.displayName !== "string")
    return undefined;
  if (!parseParams(raw.params)) return undefined;
  return raw as NavigatorCandidate;
}

router.get("/status", (req, res) => {
  const status = getStatus();
  const owner = getOwnerSessionId();
  if (owner && owner !== req.sessionId) {
    res.json({
      ...status,
      running: false,
      sessionId: null,
      config: undefined,
      navigatorDeployed: undefined,
      navigatorWatch: undefined,
    });
    return;
  }
  res.json(status);
});

router.post("/scan", async (req, res): Promise<void> => {
  const parsed = parsePlan(req.body ?? {});
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    res.json(await scanForNavigator(req.sessionId, parsed.plan));
  } catch (err) {
    logger.error({ err }, "Over/Under Navigator scan failed");
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Scan failed" });
  }
});

router.post("/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const parsed = parsePlan(body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  if (!symbol || !isAutomatedMarket(symbol)) {
    res.status(400).json({
      error: "Run the scan first — a measured digit market is required",
    });
    return;
  }
  const market = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol);
  if (!market?.digitEnabled) {
    res.status(400).json({ error: "This bot needs a digit-enabled market" });
    return;
  }
  const marketMode: "locked" | "switching" =
    body.marketMode === "locked" ? "locked" : "switching";
  const lockedSymbol =
    marketMode === "locked"
      ? typeof body.lockedSymbol === "string" && body.lockedSymbol
        ? body.lockedSymbol
        : symbol
      : undefined;
  if (
    lockedSymbol &&
    (!isAutomatedMarket(lockedSymbol) ||
      !AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === lockedSymbol)
        ?.digitEnabled)
  ) {
    res.status(400).json({
      error: "The locked market must be a digit-enabled synthetic market",
    });
    return;
  }
  const params = parseParams(body.params ?? body.analysis?.params);
  if (!params) {
    res.status(400).json({
      error: "Run the scan first — the measured model card is required",
    });
    return;
  }
  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }
  const existingOwner = getOwnerSessionId();
  if (isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({
      error:
        "Another browser session is running this bot. Your account was not touched.",
    });
    return;
  }
  const result = await startSession({
    ownerSessionId: req.sessionId,
    plan: parsed.plan,
    stake: body.stake,
    stopLoss:
      typeof body.stopLoss === "number" && body.stopLoss > 0
        ? body.stopLoss
        : 5,
    takeProfit:
      typeof body.takeProfit === "number" && body.takeProfit > 0
        ? body.takeProfit
        : 10,
    maxRecoverySteps: Math.max(
      1,
      Math.min(10, Number(body.maxRecoverySteps) || 3),
    ),
    marketMode,
    ...(lockedSymbol ? { lockedSymbol } : {}),
    symbol,
    displayName: market.displayName,
    params,
    ...(parseCandidate(body.analysis)
      ? { lockedAnalysis: parseCandidate(body.analysis) }
      : {}),
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status: getStatus() });
});

router.post("/stop", (req, res) => {
  const owner = getOwnerSessionId();
  if (isRunning() && owner && owner !== req.sessionId) {
    res
      .status(409)
      .json({ error: "You cannot stop another browser session's bot." });
    return;
  }
  stopSession();
  res.json({ ok: true, status: getStatus() });
});

export default router;
