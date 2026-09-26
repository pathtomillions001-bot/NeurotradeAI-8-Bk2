import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { AUTOMATED_DERIV_MARKETS, getDeepDigits } from "../lib/deriv";
import { broadcastSSE } from "../lib/sse";
import { logger } from "../lib/logger";
import { analysePairedEdge, rankPairedEdges, type PairedEdgeCandidate } from "../lib/paired-edge-analysis";
import { buildPairedEdgeDbot } from "../lib/paired-edge-dbot";
import { resolveRecoveryPayout } from "../lib/recovery-payout";

const router = Router();
const locks = new Map<string, { candidate: PairedEdgeCandidate; at: number }>();
const LOCK_TTL = 10 * 60_000;

async function accountConfig(sessionId: string) {
  let currency = "USD";
  let markupPercent = 10;
  let maxStake = 500;
  try {
    let accounts = await db.select().from(accountsTable).where(and(eq(accountsTable.sessionId, sessionId), eq(accountsTable.isActive, true))).limit(1);
    if (!accounts.length) accounts = await db.select().from(accountsTable).where(eq(accountsTable.sessionId, sessionId)).limit(1);
    if (accounts[0]?.currency) currency = accounts[0].currency;
    const settings = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, sessionId)).limit(1);
    const markup = Number((settings[0] as any)?.botRecoveryMarkup);
    const cap = Number((settings[0] as any)?.maxTradeStake);
    if (Number.isFinite(markup) && markup >= 0) markupPercent = markup;
    if (Number.isFinite(cap) && cap > 0) maxStake = cap;
  } catch { /* DB is optional in preview/paper mode. */ }
  return { currency, markupPercent, maxStake };
}

router.post("/scan", async (req, res): Promise<void> => {
  try {
    const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
    const candidates: PairedEdgeCandidate[] = [];
    for (let i = 0; i < markets.length; i++) {
      const market = markets[i]!;
      broadcastSSE("bot_scan_progress", { botId: "paired-edge", scanning: market.displayName, scanned: i, total: markets.length }, req.sessionId);
      const digits = await getDeepDigits(market.symbol, 1200);
      candidates.push(analysePairedEdge(market.symbol, market.displayName, digits));
    }
    const ranked = rankPairedEdges(candidates);
    const best = ranked[0] ?? null;
    if (best) locks.set(req.sessionId, { candidate: best, at: Date.now() });
    broadcastSSE("bot_scan_progress", { botId: "paired-edge", scanning: null, scanned: markets.length, total: markets.length }, req.sessionId);
    res.json({
      suitable: best?.suitable ?? false,
      best,
      allScored: ranked,
      marketsScanned: markets.length,
      reason: best?.reason ?? "No digit-enabled market supplied enough history.",
      invariant: "Over 4 + Under 5 are complements and cannot both lose on one synchronized terminal digit. Recovery is driven by exact combined basket P&L, never a fabricated two-stake loss.",
    });
  } catch (error) {
    logger.error({ error }, "Paired Edge scan failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Scan failed" });
  }
});

router.post("/dbot", async (req, res): Promise<void> => {
  const lock = locks.get(req.sessionId);
  if (!lock || Date.now() - lock.at > LOCK_TTL) {
    res.status(409).json({ error: "The measured lock expired. Re-scan before creating a DBot." });
    return;
  }
  const body = req.body ?? {};
  if (body.symbol !== lock.candidate.symbol) {
    res.status(400).json({ error: "The requested market does not match this session's scan winner." });
    return;
  }
  if (!lock.candidate.suitable) {
    res.status(409).json({ error: "The scan did not prove a stable side edge. Re-scan later; a noise-only DBot will not be created." });
    return;
  }
  const stake = Number(body.stake);
  const takeProfit = Number(body.takeProfit);
  const stopLoss = Number(body.stopLoss);
  if (!Number.isFinite(stake) || stake < 0.35 || !Number.isFinite(takeProfit) || takeProfit <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0) {
    res.status(400).json({ error: "Stake must be at least 0.35 per rail and TP/SL must be positive." });
    return;
  }

  try {
    const account = await accountConfig(req.sessionId);
    const q = async (contractType: string, barrier: number) => (await resolveRecoveryPayout({
      symbol: lock.candidate.symbol, contractType, barrier, duration: 1, durationUnit: "t", currency: account.currency,
    })).payoutMultiplier;
    const [normalOverPayout, normalUnderPayout, recoveryOverPayout, recoveryUnderPayout] = await Promise.all([
      q("DIGITOVER", 4), q("DIGITUNDER", 5), q("DIGITOVER", 5), q("DIGITUNDER", 4),
    ]);
    const strategy = buildPairedEdgeDbot({
      symbol: lock.candidate.symbol, displayName: lock.candidate.displayName,
      stake, takeProfit, stopLoss,
      maxRecoverySteps: Math.max(1, Math.min(10, Number(body.maxRecoverySteps) || 3)),
      ...account, normalOverPayout, normalUnderPayout, recoveryOverPayout, recoveryUnderPayout,
    });
    res.json({ ...strategy, analysis: lock.candidate });
  } catch (error) {
    logger.error({ error }, "Paired Edge DBot build failed");
    res.status(422).json({ error: error instanceof Error ? error.message : "Could not build paired DBot" });
  }
});

export default router;
