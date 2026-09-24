/**
 * DBot routes — the "scan → build a Deriv bot → run it inside the app" pipeline.
 *
 * Mounted at /api/bots/dbot (see routes/bots.ts).
 *
 *   POST /overunder-turbo/build
 *     Turns an Over/Under Turbo scan lock into a Blockly XML strategy for the
 *     embedded Deriv bot builder (vendored at /dbot). The generated bot trades
 *     the exact locked (market, normal, recovery) triple with the app's shared
 *     debt-driven recovery stake formula, TP/SL and a consecutive-loss breaker.
 *
 *   GET /session
 *     Returns THIS browser session's active Deriv account (login id + PAT) so
 *     the DBot Studio page can hand it to the embedded builder, which then
 *     talks straight to Deriv's WebSocket. The PAT is deliberately exposed to
 *     its owner's browser only — same trust level as the user pasting the
 *     token into Deriv's own DBot (product decision: auto-inject, no re-login).
 *     Never logged, never cached, session-cookie scoped.
 */

import { Router } from "express";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isAutomatedMarket, AUTOMATED_DERIV_MARKETS } from "../lib/deriv";
import {
  isNormalContract,
  isRecoveryContract,
  contractLabel,
  type TurboContract,
  type TurboSide,
} from "../lib/overunder-turbo-analysis";
import { resolveRecoveryPayout } from "../lib/recovery-payout";
import { buildTurboDbotXml, TurboDbotSpecError } from "../lib/dbot/overunder-turbo-xml";

const router: Router = Router();

function parseContract(raw: unknown): TurboContract | null {
  if (!raw || typeof raw !== "object") return null;
  const side = (raw as { side?: unknown }).side;
  const barrier = Number((raw as { barrier?: unknown }).barrier);
  if ((side === "DIGITOVER" || side === "DIGITUNDER") && Number.isInteger(barrier)) {
    return { side: side as TurboSide, barrier };
  }
  return null;
}

router.post("/overunder-turbo/build", async (req, res): Promise<void> => {
  try {
    const body = req.body ?? {};

    const normal = parseContract(body.normal);
    if (!normal || !isNormalContract(normal.side, normal.barrier)) {
      res.status(400).json({
        error: "normal must be one of Over 1, Over 2, Under 7, Under 8 — run the scan first",
      });
      return;
    }
    const recovery = parseContract(body.recovery);
    if (!recovery || !isRecoveryContract(recovery.side, recovery.barrier)) {
      res.status(400).json({
        error: "recovery must be one of Over 4, Over 5, Under 4, Under 5 — run the scan first",
      });
      return;
    }

    const symbol = typeof body.symbol === "string" ? body.symbol : "";
    if (!symbol || !isAutomatedMarket(symbol)) {
      res.status(400).json({ error: "Run the scan first — a measured digit market is required" });
      return;
    }
    const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === symbol);
    if (!market?.digitEnabled) {
      res.status(400).json({ error: "This bot needs a digit-enabled market" });
      return;
    }

    // Session-scoped account + settings (currency, recovery markup, stake cap).
    const [accounts, settings] = await Promise.all([
      db
        .select()
        .from(accountsTable)
        .where(and(eq(accountsTable.sessionId, req.sessionId), eq(accountsTable.isActive, true)))
        .limit(1),
      db.select().from(settingsTable).where(eq(settingsTable.sessionId, req.sessionId)).limit(1),
    ]);
    const currency = accounts[0]?.currency ?? "USD";
    const rawMarkup = Number((settings[0] as { botRecoveryMarkup?: unknown } | undefined)?.botRecoveryMarkup);
    const recoveryMarkupPct = Number.isFinite(rawMarkup) && rawMarkup >= 0 ? rawMarkup : 10;

    const baseStake = Number(body.baseStake ?? body.stake);
    const takeProfit = Number(body.takeProfit);
    const stopLoss = Number(body.stopLoss);
    const maxConsecutiveLosses = Number(body.maxConsecutiveLosses ?? body.maxRecoverySteps ?? 15);

    // The recovery payout drives the stake formula — resolve it the same way
    // the live engine does (fresh public proposal with the canonical fallback).
    const payout = await resolveRecoveryPayout({
      symbol,
      contractType: recovery.side,
      barrier: recovery.barrier,
      duration: 1,
      durationUnit: "t",
      currency,
    });

    const { xml, filename } = buildTurboDbotXml({
      symbol,
      displayName: market.displayName,
      currency,
      normal,
      recovery,
      baseStake,
      takeProfit,
      stopLoss,
      recoveryMarkupPct,
      maxConsecutiveLosses,
      recoveryPayout: payout.payoutMultiplier,
      payoutSource: payout.source,
    });

    logger.info(
      {
        sessionId: req.sessionId,
        symbol,
        normal: contractLabel(normal),
        recovery: contractLabel(recovery),
        payout: payout.payoutMultiplier,
        payoutSource: payout.source,
      },
      "DBot built from Over/Under Turbo lock",
    );

    res.json({
      ok: true,
      filename,
      xml,
      summary: {
        symbol,
        displayName: market.displayName,
        normal: contractLabel(normal),
        recovery: contractLabel(recovery),
        currency,
        baseStake,
        takeProfit,
        stopLoss,
        recoveryMarkupPct,
        maxConsecutiveLosses,
        recoveryPayout: payout.payoutMultiplier,
        payoutSource: payout.source,
      },
    });
  } catch (err) {
    if (err instanceof TurboDbotSpecError) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error({ err }, "DBot build failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "DBot build failed" });
  }
});

router.get("/session", async (req, res): Promise<void> => {
  try {
    const rows = await db
      .select()
      .from(accountsTable)
      .where(and(eq(accountsTable.sessionId, req.sessionId), eq(accountsTable.isActive, true)))
      .limit(1);
    const account = rows[0];
    if (!account?.token) {
      res.json({ connected: false });
      return;
    }
    res.json({
      connected: true,
      loginId: account.loginId,
      token: account.token,
      currency: account.currency,
      isVirtual: account.isVirtual,
    });
  } catch (err) {
    logger.error({ err }, "DBot session lookup failed");
    res.status(500).json({ error: "Session lookup failed" });
  }
});

export default router;
