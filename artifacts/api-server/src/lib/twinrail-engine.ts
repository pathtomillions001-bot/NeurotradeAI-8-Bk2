/**
 * Over/Under Twin Rail engine.
 *
 * This is a SCANNER bot: it does one deep market scan (the new
 * "Dual-Lock Navigator / Range Sentinel" the user described), returns the
 * single best market, and can then either start a live NeuroTrade session OR
 * hand a ready-made DBot strategy to the embedded Deriv Bot Builder. It does
 * NOT try to re-analyse mid-session — same operating model as Turbo /
 * Dual-Lock.
 *
 * Trading logic (identical to the user's spec):
 *
 *   NORMAL: buy BOTH Over 4 AND Under 5 at the SAME tick for the same
 *           per-leg stake. Exactly one leg wins every tick (≈1.95×). The
 *           pair returns 1.95·s on a 2·s cost → −0.05·s carrier toll per
 *           round. Recovery enters when the net result of a round is a loss.
 *
 *   RECOVERY: buy BOTH Over 5 AND Under 4 at the SAME tick, with each leg's
 *           stake sized so that a single winning leg (≈2.43×) covers the
 *           loser's leg plus the accumulated debt. Digits 4 and 5 are the
 *           ONLY digits that make BOTH recovery legs lose — that is what
 *           the scanner spends its budget avoiding.
 */

import { tickManager, AUTOMATED_DERIV_MARKETS, isAutomatedMarket } from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { registerLiveBot, unregisterLiveBot } from "./live-registry";
import {
  scanAllMarkets,
  scoreMarket,
  TWINRAIL_NORMAL_PAIR,
  TWINRAIL_RECOVERY_PAIR,
  pairLabel,
  contractLabel,
  payoutOf,
  type TwinRailCandidate,
  type TwinRailScanParams,
  marketDisplayName,
} from "./twinrail-analysis";

export const TWINRAIL_BOT_ID = "twinrail";
export const TWINRAIL_BOT_NAME = "Over/Under Twin Rail";
const SCAN_DIGITS = 1500;

export interface TwinRailConfig extends TwinRailScanParams {
  symbol: string;
  analysis: TwinRailCandidate;
  ownerSessionId: string;
}

export async function getScanParams(ownerSessionId: string, body: any): Promise<TwinRailScanParams> {
  let markupPercent = 10;
  let maxStake = 500;
  try {
    const rows = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.sessionId, ownerSessionId))
      .limit(1);
    if (rows.length > 0) {
      const v = Number((rows[0] as any).botRecoveryMarkup);
      if (Number.isFinite(v)) markupPercent = v;
      const m = Number((rows[0] as any).maxTradeStake);
      if (Number.isFinite(m) && m > 0) maxStake = m;
    }
  } catch { /* defaults */ }
  return {
    stake: Number(body?.stake) > 0 ? Number(body.stake) : 1,
    takeProfit: Number(body?.takeProfit) > 0 ? Number(body.takeProfit) : 10,
    stopLoss: Number(body?.stopLoss) > 0 ? Number(body.stopLoss) : 5,
    maxRecoverySteps: Math.max(1, Math.min(10, Number(body?.maxRecoverySteps) || 3)),
    markupPercent,
    maxStake,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function scanForTwinRail(ownerSessionId: string, params: TwinRailScanParams) {
  const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
  const result = await scanAllMarkets(
    (sym, n) => tickManager.getDigits(sym, n),
    params,
    marketDisplayName,
    markets,
    (name, done, total) =>
      broadcastSSE(
        "bot_scan_progress",
        {
          botId: TWINRAIL_BOT_ID,
          scanning: name,
          scanned: done,
          total,
        },
        ownerSessionId,
      ),
  );
  broadcastSSE(
    "bot_scan_progress",
    { botId: TWINRAIL_BOT_ID, scanning: null, scanned: markets.length, total: markets.length },
    ownerSessionId,
  );
  return {
    ...result,
    normal: {
      pair: pairLabel(TWINRAIL_NORMAL_PAIR),
      a: { side: TWINRAIL_NORMAL_PAIR[0].side, barrier: TWINRAIL_NORMAL_PAIR[0].barrier, payout: payoutOf(TWINRAIL_NORMAL_PAIR[0]) },
      b: { side: TWINRAIL_NORMAL_PAIR[1].side, barrier: TWINRAIL_NORMAL_PAIR[1].barrier, payout: payoutOf(TWINRAIL_NORMAL_PAIR[1]) },
    },
    recovery: {
      pair: pairLabel(TWINRAIL_RECOVERY_PAIR),
      a: { side: TWINRAIL_RECOVERY_PAIR[0].side, barrier: TWINRAIL_RECOVERY_PAIR[0].barrier, payout: payoutOf(TWINRAIL_RECOVERY_PAIR[0]) },
      b: { side: TWINRAIL_RECOVERY_PAIR[1].side, barrier: TWINRAIL_RECOVERY_PAIR[1].barrier, payout: payoutOf(TWINRAIL_RECOVERY_PAIR[1]) },
    },
  };
}

/** Minimal session placeholder so the "Open Live Session" path works even though
 * the primary deliverable is the Create DBot button. */
interface TwinRailSession {
  running: boolean;
  config?: TwinRailConfig;
  startedAt?: number;
}
let twinrailSession: TwinRailSession = { running: false };

export function getStatus(ownerSessionId: string) {
  // Session ownership mirrors Turbo: a different browser session sees idle.
  if (twinrailSession.running && twinrailSession.config?.ownerSessionId !== ownerSessionId) {
    return { running: false, botId: TWINRAIL_BOT_ID };
  }
  return {
    running: twinrailSession.running,
    botId: TWINRAIL_BOT_ID,
    botName: TWINRAIL_BOT_NAME,
    config: twinrailSession.config,
  };
}

export function isRunning(): boolean {
  return twinrailSession.running;
}

export async function startSession(config: TwinRailConfig): Promise<{ ok: boolean; error?: string; status?: any }> {
  if (twinrailSession.running) {
    return { ok: false, error: `${TWINRAIL_BOT_NAME} is already active — stop it first` };
  }
  if (!isAutomatedMarket(config.symbol)) {
    return { ok: false, error: "The scanned symbol is no longer tradeable" };
  }
  if (config.stake < 0.35) return { ok: false, error: "Minimum stake is $0.35" };

  twinrailSession = {
    running: true,
    config,
    startedAt: Date.now(),
  };
  registerLiveBot(TWINRAIL_BOT_ID, () => getStatus(config.ownerSessionId));

  broadcastSSE(
    "bot_update",
    {
      running: true,
      botId: TWINRAIL_BOT_ID,
      botName: TWINRAIL_BOT_NAME,
      totalProfit: 0,
      winCount: 0,
      lossCount: 0,
      tradeCount: 0,
      currentMarket: config.analysis.displayName,
      currentContractType: pairLabel(TWINRAIL_NORMAL_PAIR),
      message: `⚡ Twin Rail locked on ${config.analysis.displayName} — ${pairLabel(TWINRAIL_NORMAL_PAIR)} → ${pairLabel(TWINRAIL_RECOVERY_PAIR)} recovery. Use Create DBot for simultaneous-leg execution.`,
      twinLock: {
        symbol: config.symbol,
        displayName: config.analysis.displayName,
        normal: pairLabel(TWINRAIL_NORMAL_PAIR),
        recovery: pairLabel(TWINRAIL_RECOVERY_PAIR),
        survival: config.analysis.survival,
        ruin: config.analysis.ruin,
        clusterRatio: config.analysis.clusterXi,
        normalLcb: 1 - config.analysis.boundaryRate,
        recoveryConditional: config.analysis.recoverySuccessRate,
        expectedMaxLossRun: Math.round(config.analysis.recoveryDepthP95),
        recoveryDepthP95: config.analysis.recoveryDepthP95,
        signals: config.analysis.signals,
        marketMode: "locked",
      },
    },
    config.ownerSessionId,
  );

  return { ok: true, status: getStatus(config.ownerSessionId) };
}

export async function stopSession(ownerSessionId: string): Promise<{ status: any }> {
  if (twinrailSession.config?.ownerSessionId && twinrailSession.config.ownerSessionId !== ownerSessionId) {
    return { status: getStatus(ownerSessionId) };
  }
  const wasRunning = twinrailSession.running;
  twinrailSession = { running: false };
  unregisterLiveBot(TWINRAIL_BOT_ID);
  if (wasRunning) {
    broadcastSSE(
      "bot_update",
      {
        running: false,
        botId: TWINRAIL_BOT_ID,
        botName: TWINRAIL_BOT_NAME,
        message: "Twin Rail session stopped",
      },
      ownerSessionId,
    );
  }
  return { status: getStatus(ownerSessionId) };
}
