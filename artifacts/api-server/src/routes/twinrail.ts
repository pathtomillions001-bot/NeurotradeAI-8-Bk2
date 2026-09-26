/**
 * Routes for the Over/Under Twin Rail scanner bot.
 *
 *   POST /api/bots/twinrail/scan  — one deep scan, returns best market
 *   POST /api/bots/twinrail/start — start a locked NeuroTrade session
 *   POST /api/bots/twinrail/stop  — stop the session
 *   GET  /api/bots/twinrail/status
 *   POST /api/bots/twinrail/dbot  — build a Deriv DBot strategy XML for
 *                                   the scanned lock (same-tick dual legs)
 */

import { Router } from "express";
import { isAutomatedMarket, AUTOMATED_DERIV_MARKETS } from "../lib/deriv";
import { logger } from "../lib/logger";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildTwinRailDbotStrategy } from "../lib/twinrail-dbot";
import {
  TWINRAIL_BOT_ID,
  getScanParams,
  scanForTwinRail,
  startSession,
  stopSession,
  getStatus,
  isRunning,
} from "../lib/twinrail-engine";

const router = Router();

router.get("/status", (req, res) => {
  res.json(getStatus(req.sessionId));
});

router.post("/scan", async (req, res): Promise<void> => {
  try {
    const params = await getScanParams(req.sessionId, req.body ?? {});
    const result = await scanForTwinRail(req.sessionId, params);
    res.json({ ...result, sessionParams: params });
  } catch (err) {
    logger.error({ err }, "Twin Rail scan failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Scan failed" });
  }
});

function parseNumber(v: any, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

router.post("/start", async (req, res): Promise<void> => {
  try {
    const body = req.body ?? {};
    const symbol = typeof body.symbol === "string" ? body.symbol : "";
    if (!symbol || !isAutomatedMarket(symbol)) {
      res.status(400).json({ error: "Run the scan first — a measured digit market is required" });
      return;
    }
    const market = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol);
    if (!market?.digitEnabled) {
      res.status(400).json({ error: "This bot needs a digit-enabled market" });
      return;
    }
    const params = await getScanParams(req.sessionId, body);
    const analysis = body.analysis;
    if (!analysis || typeof analysis !== "object" || analysis.symbol !== symbol) {
      res.status(400).json({ error: "Pass the scanned analysis object back with the request" });
      return;
    }
    const out = await startSession({
      symbol,
      analysis,
      ownerSessionId: req.sessionId,
      ...params,
    });
    if (!out.ok) {
      res.status(409).json({ error: out.error });
      return;
    }
    res.json({ status: out.status });
  } catch (err) {
    logger.error({ err }, "Twin Rail start failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Start failed" });
  }
});

router.post("/stop", async (req, res): Promise<void> => {
  try {
    const out = await stopSession(req.sessionId);
    res.json(out);
  } catch (err) {
    logger.error({ err }, "Twin Rail stop failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Stop failed" });
  }
});

router.post("/dbot", async (req, res): Promise<void> => {
  try {
    const body = req.body ?? {};
    const symbol = typeof body.symbol === "string" ? body.symbol : "";
    if (!symbol || !isAutomatedMarket(symbol)) {
      res.status(400).json({ error: "Run the scan first — a measured digit market is required" });
      return;
    }
    const analysis = body.analysis;
    if (!analysis || typeof analysis !== "object") {
      res.status(400).json({ error: "Pass the scanned analysis with the request" });
      return;
    }
    const params = await getScanParams(req.sessionId, body);

    let currency = "USD";
    try {
      const rows = await db
        .select()
        .from(accountsTable)
        .where(eq(accountsTable.sessionId, req.sessionId))
        .limit(1);
      if (rows.length > 0) {
        const c = (rows[0] as any).currency;
        if (typeof c === "string" && c.length >= 3) currency = c.toUpperCase();
      }
    } catch { /* default */ }

    const market = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol);
    const strategy = buildTwinRailDbotStrategy({
      symbol,
      displayName: market?.displayName ?? symbol,
      analysis,
      stake: params.stake,
      takeProfit: params.takeProfit,
      stopLoss: params.stopLoss,
      maxRecoverySteps: params.maxRecoverySteps,
      markupPercent: params.markupPercent,
      maxStake: params.maxStake,
      currency,
    });
    res.json({ name: strategy.name, xml: strategy.xml, summary: strategy.summary });
  } catch (err) {
    logger.error({ err }, "Twin Rail dbot build failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "DBot build failed" });
  }
});

export default router;
