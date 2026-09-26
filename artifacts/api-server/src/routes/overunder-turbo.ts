/**
 * Routes for the Over/Under Turbo bot — the continuous-fire Over/Under
 * specialist. Scan once → pick the best market + normal/recovery barriers →
 * deploy LOCKED or SWITCHING → arm on the best entry → trade non-stop to TP/SL.
 *
 * Account isolation mirrors the Navigator route exactly: every status read is
 * scoped to the requesting session, and start/stop refuse to touch a session
 * owned by a different browser/account.
 */

import { Router } from "express";
import { AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "../lib/deriv";
import { logger } from "../lib/logger";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { resolveRecoveryPayout } from "../lib/recovery-payout";
import { buildTurboDbotStrategy } from "../lib/overunder-turbo-dbot";
import {
  TURBO_BOT_ID,
  getOwnerSessionId,
  getStatus,
  isRunning,
  scanForTurbo,
  startSession,
  stopSession,
  TURBO_NORMAL_CONTRACTS,
  TURBO_RECOVERY_CONTRACTS,
} from "../lib/overunder-turbo-engine";
import {
  contractLabel,
  isNormalContract,
  isRecoveryContract,
  type TurboContract,
  type TurboSide,
} from "../lib/overunder-turbo-analysis";

const router = Router();

/** The status this session is allowed to see (never another account's). */
function visibleStatus(sessionId: string) {
  const status = getStatus();
  const owner = getOwnerSessionId();
  if (owner && owner !== sessionId) {
    return {
      ...status,
      running: false,
      sessionId: null,
      config: undefined,
      turboLock: undefined,
      turboWatch: undefined,
    };
  }
  return status;
}

function parseContract(raw: any): TurboContract | null {
  if (!raw) return null;
  const side: TurboSide | null =
    raw.side === "DIGITOVER" || raw.side === "DIGITUNDER" ? raw.side : null;
  const barrier = Number(raw.barrier);
  if (!side || !Number.isInteger(barrier)) return null;
  return { side, barrier };
}

/** Read this account's recovery markup + max stake for the survival simulation. */
async function simParams(sessionId: string, body: any) {
  let markupPercent = 10;
  let maxStake = 500;
  try {
    const rows = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.sessionId, sessionId))
      .limit(1);
    if (rows.length > 0) {
      const v = Number((rows[0] as any).botRecoveryMarkup);
      if (Number.isFinite(v)) markupPercent = v;
      const m = Number((rows[0] as any).maxTradeStake);
      if (Number.isFinite(m) && m > 0) maxStake = m;
    }
  } catch {
    /* defaults */
  }
  return {
    stake: Number(body?.stake) > 0 ? Number(body.stake) : 1,
    takeProfit: Number(body?.takeProfit) > 0 ? Number(body.takeProfit) : 10,
    stopLoss: Number(body?.stopLoss) > 0 ? Number(body.stopLoss) : 5,
    maxRecoverySteps: Math.max(1, Math.min(10, Number(body?.maxRecoverySteps) || 3)),
    markupPercent,
    maxStake,
  };
}

router.get("/contracts", (_req, res) => {
  res.json({
    normal: TURBO_NORMAL_CONTRACTS.map((c) => ({ ...c, label: contractLabel(c) })),
    recovery: TURBO_RECOVERY_CONTRACTS.map((c) => ({ ...c, label: contractLabel(c) })),
  });
});

router.get("/status", (req, res) => {
  res.json(visibleStatus(req.sessionId));
});

router.post("/scan", async (req, res): Promise<void> => {
  try {
    const params = await simParams(req.sessionId, req.body ?? {});
    const result = await scanForTurbo(req.sessionId, params);
    res.json({ ...result, sessionParams: params });
  } catch (err) {
    logger.error({ err }, "Over/Under Turbo scan failed");
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Scan failed" });
  }
});

router.post("/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};

  const normal = parseContract(body.normal);
  const recovery = parseContract(body.recovery);
  if (!normal || !isNormalContract(normal.side, normal.barrier)) {
    res.status(400).json({
      error: "normal must be one of Over 1, Over 2, Under 7, Under 8 — run the scan first",
    });
    return;
  }
  if (!recovery || !isRecoveryContract(recovery.side, recovery.barrier)) {
    res.status(400).json({
      error: "recovery must be one of Over 4, Over 5, Under 4, Under 5 — run the scan first",
    });
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

  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  // A different browser/account already running this bot is never touched.
  const existingOwner = getOwnerSessionId();
  if (isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res.status(409).json({
      error:
        "Another browser session is running this bot. Your Deriv account was not touched.",
    });
    return;
  }

  const params = await simParams(req.sessionId, body);
  const result = await startSession({
    ownerSessionId: req.sessionId,
    symbol: market.symbol,
    displayName: market.displayName,
    normal,
    recovery,
    marketMode,
    stake: body.stake,
    stopLoss: Number(body.stopLoss) > 0 ? Number(body.stopLoss) : params.stopLoss,
    takeProfit: Number(body.takeProfit) > 0 ? Number(body.takeProfit) : params.takeProfit,
    maxRecoverySteps: Math.max(
      1,
      Math.min(10, Number(body.maxRecoverySteps) || params.maxRecoverySteps),
    ),
    lockedAnalysis:
      body.analysis && typeof body.analysis === "object" ? body.analysis : undefined,
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status: visibleStatus(req.sessionId) });
});

/**
 * Build a stock Deriv Bot strategy for the scanned lock. Nothing starts here —
 * the web app hands the XML to the embedded Deriv bot builder, the user checks
 * the blocks and presses Deriv's Run. Validation mirrors /start exactly so a
 * DBot can only ever be built for a triple the scan is allowed to deploy.
 */
router.post("/dbot", async (req, res): Promise<void> => {
  const body = req.body ?? {};

  const normal = parseContract(body.normal);
  const recovery = parseContract(body.recovery);
  if (!normal || !isNormalContract(normal.side, normal.barrier)) {
    res.status(400).json({
      error: "normal must be one of Over 1, Over 2, Under 7, Under 8 — run the scan first",
    });
    return;
  }
  if (!recovery || !isRecoveryContract(recovery.side, recovery.barrier)) {
    res.status(400).json({
      error: "recovery must be one of Over 4, Over 5, Under 4, Under 5 — run the scan first",
    });
    return;
  }

  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const market = symbol && isAutomatedMarket(symbol)
    ? AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol)
    : undefined;
  if (!market?.digitEnabled) {
    res.status(400).json({
      error: "Run the scan first — a measured digit market is required",
    });
    return;
  }

  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  try {
    const params = await simParams(req.sessionId, body);

    // Account currency — the builder's trade options are denominated in it.
    let currency = "USD";
    try {
      let accounts = await db
        .select()
        .from(accountsTable)
        .where(and(eq(accountsTable.sessionId, req.sessionId), eq(accountsTable.isActive, true)))
        .limit(1);
      if (accounts.length === 0) {
        accounts = await db
          .select()
          .from(accountsTable)
          .where(eq(accountsTable.sessionId, req.sessionId))
          .limit(1);
      }
      if (accounts[0]?.currency) currency = accounts[0].currency;
    } catch {
      /* default currency */
    }

    // Seed payout multipliers exactly the way the engine quotes them before a
    // fire (live $1 proposal, canonical schedule as fallback). The generated bot
    // refreshes each leg from its realised payout after every win.
    const [normalQuote, recoveryQuote] = await Promise.all([
      resolveRecoveryPayout({
        symbol: market.symbol,
        contractType: normal.side,
        barrier: normal.barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      }),
      resolveRecoveryPayout({
        symbol: market.symbol,
        contractType: recovery.side,
        barrier: recovery.barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      }),
    ]);

    const analysis = body.analysis && typeof body.analysis === "object" ? body.analysis : undefined;
    const predictedDepth = Math.max(
      3,
      Math.round(Number(analysis?.metrics?.recoveryDepthP95) || 4),
    );

    const strategy = buildTurboDbotStrategy({
      symbol: market.symbol,
      displayName: market.displayName,
      normal,
      recovery,
      stake: body.stake,
      takeProfit: Number(body.takeProfit) > 0 ? Number(body.takeProfit) : params.takeProfit,
      stopLoss: Number(body.stopLoss) > 0 ? Number(body.stopLoss) : params.stopLoss,
      maxRecoverySteps: Math.max(
        1,
        Math.min(10, Number(body.maxRecoverySteps) || params.maxRecoverySteps),
      ),
      markupPercent: params.markupPercent,
      maxStake: params.maxStake,
      normalPayout: normalQuote.payoutMultiplier,
      recoveryPayout: recoveryQuote.payoutMultiplier,
      breakerDepth: predictedDepth + 2,
      currency,
    });

    res.json({
      ok: true,
      ...strategy,
      payoutSource: { normal: normalQuote.source, recovery: recoveryQuote.source },
    });
  } catch (err) {
    logger.error({ err }, "Over/Under Turbo DBot build failed");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Could not build the DBot strategy",
    });
  }
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
  res.json({ ok: true, status: visibleStatus(req.sessionId) });
});

export { TURBO_BOT_ID };
export default router;
