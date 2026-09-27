/**
 * Barrier Bastion routes — the 12th AI bot (Over 1 / Under 8 normal,
 * Over 3 / Under 6 recovery).
 *
 * Mounted at /api/bots/bastion (see routes/bots.ts). The bot deploys ONLY from
 * its own console: the generic /:botId/* specialist endpoints refuse it, and
 * every start re-validates the side mode, market, boundaries and the measured
 * card the scan produced. There is deliberately NO pace parameter — one mode.
 */

import { Router } from "express";
import { logger } from "../lib/logger";
import {
  AUTOMATED_DERIV_MARKETS,
  getDeepDigits,
  isAutomatedMarket,
  tickManager,
} from "../lib/deriv";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { resolveRecoveryPayout } from "../lib/recovery-payout";
import {
  BASTION_NORMAL_CONTRACTS,
  BASTION_RECOVERY_CONTRACTS,
  BastionPolicy,
  buildHMMWindows,
  type BastionContract,
  type BastionParams,
  type BastionSideMode,
} from "../lib/bastion-analysis";
import {
  buildBastionDbotStrategy,
  bastionDbotContractFromBastion,
} from "../lib/bastion-dbot";
import {
  BASTION_BOT_ID,
  getStatus,
  isRunning,
  getOwnerSessionId,
  scanForBastion,
  startSession,
  stopSession,
  type BastionCandidate,
} from "../lib/bastion-engine";

const router = Router();

function parseSideMode(raw: unknown): BastionSideMode {
  return raw === "over" || raw === "under" ? raw : "both";
}

function parseParams(raw: any): BastionParams | null {
  if (!raw || typeof raw !== "object") return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const w = Array.isArray(raw.weights) ? raw.weights.map(num) : null;
  const tau = num(raw.tau);
  const normalInitBar = num(raw.normalInitBar);
  // 6-lens weights (current) or legacy 4-lens (old scan cards) accepted.
  if (
    !w ||
    (w.length !== 4 && w.length !== 6) ||
    w.some((v: number | null) => v === null)
  )
    return null;
  if (tau === null || normalInitBar === null) return null;
  if (tau < 0.3 || tau > 3) return null;
  const sum = w.reduce((a: number, v: number | null) => a + (v as number), 0);
  if (!(sum > 0)) return null;
  const expanded = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < w.length; i++) expanded[i] = (w[i] as number) / sum;
  return {
    weights: expanded as BastionParams["weights"],
    tau,
    normalInitBar: Math.min(0.95, Math.max(0, normalInitBar)),
  };
}

function parseCandidate(raw: any): BastionCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.symbol !== "string" || typeof raw.displayName !== "string")
    return null;
  if (typeof raw.verdict !== "string" || typeof raw.confidence !== "number")
    return null;
  if (
    typeof raw.paperEdgePerDollar !== "number" ||
    typeof raw.recoveryHitRate !== "number"
  )
    return null;
  if (
    typeof raw.recoveryShots !== "number" ||
    typeof raw.normalShots !== "number"
  )
    return null;
  if (!raw.params || typeof raw.params !== "object") return null;
  return raw as BastionCandidate;
}

const normalOver = BASTION_NORMAL_CONTRACTS.find(
  (c) => c.contractType === "DIGITOVER",
)!;
const normalUnder = BASTION_NORMAL_CONTRACTS.find(
  (c) => c.contractType === "DIGITUNDER",
)!;
const recoveryOver = BASTION_RECOVERY_CONTRACTS.find(
  (c) => c.contractType === "DIGITOVER",
)!;
const recoveryUnder = BASTION_RECOVERY_CONTRACTS.find(
  (c) => c.contractType === "DIGITUNDER",
)!;

function fallbackNormal(sideMode: BastionSideMode): BastionContract {
  return sideMode === "under" ? normalUnder : normalOver;
}

function fallbackRecovery(normal: BastionContract): BastionContract {
  return normal.contractType === "DIGITUNDER" ? recoveryUnder : recoveryOver;
}

async function pickDbotLock(
  symbol: string,
  params: BastionParams,
  sideMode: BastionSideMode,
): Promise<{
  normal: BastionContract;
  recovery: BastionContract;
  historyDepth: number;
}> {
  let digits: number[] = [];
  try {
    digits = await getDeepDigits(symbol, 1200);
  } catch {
    digits = tickManager.getDigits(symbol, 1200);
  }
  const clean = digits.filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
  if (clean.length < 40) {
    const normal = fallbackNormal(sideMode);
    return {
      normal,
      recovery: fallbackRecovery(normal),
      historyDepth: clean.length,
    };
  }

  const policy = new BastionPolicy(params, buildHMMWindows(clean));
  for (let i = 0; i < clean.length; i += 1) policy.update(clean, i);
  const idx = clean.length - 1;
  const normalDecision = policy.decideNormal(clean, idx, sideMode);
  const normal = normalDecision.side ?? fallbackNormal(sideMode);
  const recoveryDecision = policy.decideRecovery(clean, idx);
  const recovery = recoveryDecision.side ?? fallbackRecovery(normal);
  return { normal, recovery, historyDepth: clean.length };
}

async function sessionRisk(
  sessionId: string,
): Promise<{ markupPercent: number; maxStake: number; currency: string }> {
  let markupPercent = 10;
  let maxStake = 500;
  let currency = "USD";
  try {
    const rows = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.sessionId, sessionId))
      .limit(1);
    if (rows[0]) {
      const markup = Number((rows[0] as any).botRecoveryMarkup);
      const cap = Number((rows[0] as any).maxTradeStake);
      if (Number.isFinite(markup)) markupPercent = Math.max(0, markup);
      if (Number.isFinite(cap) && cap > 0) maxStake = cap;
    }
    let accounts = await db
      .select()
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.sessionId, sessionId),
          eq(accountsTable.isActive, true),
        ),
      )
      .limit(1);
    if (accounts.length === 0)
      accounts = await db
        .select()
        .from(accountsTable)
        .where(eq(accountsTable.sessionId, sessionId))
        .limit(1);
    if (accounts[0]?.currency) currency = accounts[0].currency;
  } catch {
    /* safe defaults */
  }
  return { markupPercent, maxStake, currency };
}

router.get("/status", (req, res) => {
  const owner = getOwnerSessionId();
  const status = getStatus();
  if (owner && owner !== req.sessionId) {
    res.json({
      ...status,
      running: false,
      sessionId: null,
      config: undefined,
      bastionDeployed: undefined,
      bastionWatch: undefined,
    });
    return;
  }
  res.json(status);
});

router.post("/scan", async (req, res): Promise<void> => {
  try {
    const result = await scanForBastion(req.sessionId);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Barrier Bastion scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

router.post("/start", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const sideMode = parseSideMode(body.sideMode);
  const marketMode: "locked" | "switching" =
    body.marketMode === "locked" ? "locked" : "switching";
  const requested = typeof body.symbol === "string" ? body.symbol : undefined;
  if (!requested || !isAutomatedMarket(requested)) {
    res
      .status(400)
      .json({
        error:
          "Run the scan first — this bot deploys onto a market it has measured",
      });
    return;
  }
  const market = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === requested);
  if (!market || !market.digitEnabled) {
    res.status(400).json({ error: "This bot needs a digit-enabled market" });
    return;
  }
  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }

  let lockedSymbol: string | undefined;
  if (marketMode === "locked") {
    const want =
      typeof body.lockedSymbol === "string" && body.lockedSymbol
        ? body.lockedSymbol
        : requested;
    if (!isAutomatedMarket(want)) {
      res
        .status(400)
        .json({ error: `${want} cannot be analysed or traded by this bot` });
      return;
    }
    lockedSymbol = want;
  }

  const params = parseParams(body.params ?? body.analysis?.params);
  if (!params) {
    res
      .status(400)
      .json({
        error:
          "Run the scan first — the measured parameter card is required before this bot can deploy",
      });
    return;
  }
  const analysis = parseCandidate(body.analysis ?? null);

  const existingOwner = getOwnerSessionId();
  if (isRunning() && existingOwner && existingOwner !== req.sessionId) {
    res
      .status(409)
      .json({
        error:
          "Another browser session is running this bot. Your Deriv account was not touched.",
      });
    return;
  }

  const result = await startSession({
    ownerSessionId: req.sessionId,
    spec: { sideMode },
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
    symbol: market.symbol,
    displayName: market.displayName,
    params,
    ...(analysis ? { lockedAnalysis: analysis } : {}),
  });
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  logger.info(
    { botId: BASTION_BOT_ID, symbol: market.symbol, sideMode, marketMode },
    "Barrier Bastion deployed",
  );
  const status = getStatus();
  res.json({ ok: true, status });
});

router.post("/dbot", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const sideMode = parseSideMode(body.sideMode);
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const market =
    symbol && isAutomatedMarket(symbol)
      ? AUTOMATED_DERIV_MARKETS.find((item) => item.symbol === symbol)
      : undefined;
  if (!market?.digitEnabled) {
    res
      .status(400)
      .json({
        error:
          "Run the scan first — a measured Bastion digit market is required",
      });
    return;
  }
  if (typeof body.stake !== "number" || body.stake < 0.35) {
    res.status(400).json({ error: "stake must be ≥ 0.35" });
    return;
  }
  const params = parseParams(body.params ?? body.analysis?.params);
  if (!params) {
    res
      .status(400)
      .json({
        error:
          "Run the scan first — the measured Bastion parameter card is required",
      });
    return;
  }

  try {
    const [{ markupPercent, maxStake, currency }, lock] = await Promise.all([
      sessionRisk(req.sessionId),
      pickDbotLock(market.symbol, params, sideMode),
    ]);
    const [normalQuote, recoveryQuote] = await Promise.all([
      resolveRecoveryPayout({
        symbol: market.symbol,
        contractType: lock.normal.contractType,
        barrier: lock.normal.barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      }),
      resolveRecoveryPayout({
        symbol: market.symbol,
        contractType: lock.recovery.contractType,
        barrier: lock.recovery.barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      }),
    ]);

    const maxRecoverySteps = Math.max(
      1,
      Math.min(10, Number(body.maxRecoverySteps) || 3),
    );
    const strategy = buildBastionDbotStrategy({
      symbol: market.symbol,
      displayName: market.displayName,
      normal: bastionDbotContractFromBastion(
        lock.normal,
        normalQuote.payoutMultiplier,
      ),
      recovery: bastionDbotContractFromBastion(
        lock.recovery,
        recoveryQuote.payoutMultiplier,
      ),
      stake: body.stake,
      takeProfit: Number(body.takeProfit) > 0 ? Number(body.takeProfit) : 10,
      stopLoss: Number(body.stopLoss) > 0 ? Number(body.stopLoss) : 5,
      maxRecoverySteps,
      markupPercent,
      maxStake,
      normalPayout: normalQuote.payoutMultiplier,
      recoveryPayout: recoveryQuote.payoutMultiplier,
      breakerDepth: Math.max(
        4,
        Math.min(12, Number(body.breakerDepth) || maxRecoverySteps + 3),
      ),
      currency,
      entryWindow: Math.max(40, Math.min(300, Number(body.entryWindow) || 120)),
      entryPatience: Math.max(
        3,
        Math.min(40, Number(body.entryPatience) || 12),
      ),
    });
    res.json({
      ok: true,
      ...strategy,
      lock: { historyDepth: lock.historyDepth },
    });
  } catch (err) {
    logger.error({ err }, "Barrier Bastion DBot generation failed");
    res
      .status(400)
      .json({
        error:
          err instanceof Error
            ? err.message
            : "Could not create Barrier Bastion DBot",
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
  res.json({ ok: true, status: getStatus() });
});

export default router;
