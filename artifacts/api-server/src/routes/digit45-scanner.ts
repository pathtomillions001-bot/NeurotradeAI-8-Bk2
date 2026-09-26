import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db, accountsTable, settingsTable } from "@workspace/db";
import {
  AUTOMATED_DERIV_MARKETS, extractLastDigit, tickManager, tickSecondsFor,
} from "../lib/deriv";
import { mergeLiveDigitHistory } from "../lib/digit-tape";
import { logger } from "../lib/logger";
import {
  DIGIT45_MIN_SAMPLES, DIGIT45_SCAN_TTL_MS, DIGIT45_WINDOW,
  evaluateDigit45Market, rankDigit45Markets, type Digit45Candidate,
} from "../lib/digit45-scanner";
import { buildDigit45DbotStrategy } from "../lib/digit45-dbot";

const router = Router();
const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
const MAX_TICK_AGE_MS = (symbol: string) => Math.max(10_000, tickSecondsFor(symbol) * 4000);
function currentBrokerTick(tick: { epoch: number; receivedAt: number; source: string }, symbol: string) {
  const brokerTime = tick.epoch > 1e11 ? tick.epoch : tick.epoch * 1000;
  const age = Date.now() - brokerTime;
  const receiptAge = Date.now() - tick.receivedAt;
  const limit = MAX_TICK_AGE_MS(symbol);
  return tick.source === "live" && Number.isFinite(brokerTime) &&
    age >= -limit && age <= limit && receiptAge >= -limit && receiptAge <= limit;
}

type ScanEntry = { generation: number; sequence: number; digits: number[]; candidate: Digit45Candidate };
const scans = new Map<string, { id: string; expiresAt: number; markets: Map<string, ScanEntry> }>();

/** Never merge cached/simulated getDigits() into a broker-backed scan. */
async function readLiveMarket(market: typeof markets[number]): Promise<ScanEntry | null> {
  let snapshot = tickManager.getDigitSnapshot(market.symbol, DIGIT45_WINDOW);
  if (!snapshot || !currentBrokerTick(snapshot.tick, market.symbol)) return null;
  let digits = snapshot.ticks.map(t => t.digit);
  if (digits.length < DIGIT45_MIN_SAMPLES) {
    try {
      const reply = await tickManager.request({
        ticks_history: market.symbol, count: DIGIT45_WINDOW, end: "latest", style: "ticks",
      }, 3500);
      const current = tickManager.getDigitSnapshot(market.symbol, DIGIT45_WINDOW);
      const prices = reply?.history?.prices;
      const times = reply?.history?.times;
      if (current && currentBrokerTick(current.tick, market.symbol) &&
          current.tick.generation === snapshot.tick.generation &&
          Array.isArray(prices) && Array.isArray(times) && prices.length === times.length) {
        const history = times.map((time: unknown, i: number) => ({
          epoch: Number(time), digit: extractLastDigit(Number(prices[i]), market.pipSize),
        }));
        digits = mergeLiveDigitHistory(history, current, DIGIT45_WINDOW);
        snapshot = current;
      }
    } catch {
      // An unavailable or inconsistent broker history is NOT replaced by the
      // simulated ring buffer. The short live tape remains watch-only.
    }
  }
  const candidate = evaluateDigit45Market(market.symbol, market.displayName, digits, snapshot.tick.epoch);
  return candidate ? {
    candidate, generation: snapshot.tick.generation,
    sequence: snapshot.tick.sequence, digits,
  } : null;
}

// No /start, /run, /buy or automation toggle. Scanning never places an order.
router.post("/scan", async (req, res): Promise<void> => {
  const health = tickManager.getTickHealth();
  if (!health.connected || health.usingSimulated) {
    scans.delete(req.sessionId);
    res.json({
      scanId: null, expiresAt: null, markets: [], eligible: 0, marketsChecked: 0,
      dataSource: "unavailable",
      reason: "Verified live Deriv digits are unavailable. Simulated prices cannot qualify a market or create a DBot.",
    });
    return;
  }
  try {
    const measured = (await Promise.all(markets.map(readLiveMarket))).filter(
      (entry): entry is ScanEntry => entry !== null,
    );
    const ranked = rankDigit45Markets(measured.map(entry => entry.candidate));
    const scanId = randomUUID();
    const expiresAt = Date.now() + DIGIT45_SCAN_TTL_MS;
    // Each tab/account gets its own short-lived scan. No candidate can be
    // forged or re-used by a different browser session in /dbot.
    for (const [owner, scan] of scans) if (scan.expiresAt < Date.now()) scans.delete(owner);
    scans.set(req.sessionId, {
      id: scanId, expiresAt,
      markets: new Map(measured.map(entry => [entry.candidate.symbol, entry])),
    });
    res.json({
      scanId, expiresAt, markets: ranked, eligible: ranked.filter(c => c.eligible).length,
      marketsChecked: markets.length, dataSource: "broker-live",
      reason: ranked.some(c => c.eligible)
        ? "Historical weakness observed, not a promise about the next tick. Verify broker payouts before Run."
        : "No market currently passes both-digit confidence and recent-weakness checks. No DBot can be created from this scan.",
    });
  } catch (err) {
    scans.delete(req.sessionId);
    logger.error({ err }, "Digit 4/5 scanner failed");
    res.status(500).json({ error: "Could not scan verified broker digits. Try again later." });
  }
});

router.post("/dbot", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const scan = scans.get(req.sessionId);
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const selected = scan?.markets.get(symbol);
  const current = tickManager.getDigitSnapshot(symbol, DIGIT45_WINDOW);
  const fresh = current?.tick;
  if (!scan || body.scanId !== scan.id || scan.expiresAt < Date.now() ||
      !selected?.candidate.eligible || !fresh || !currentBrokerTick(fresh, symbol) ||
      fresh.generation !== selected.generation || fresh.sequence < selected.sequence ||
      !tickManager.getConnectionStatus() || tickManager.getTickHealth().usingSimulated) {
    res.status(409).json({ error: "This live market qualification has expired or changed. Scan again before creating a DBot." });
    return;
  }
  // Refresh the measured window with every broker tick since Scan. A 90-second
  // credential cannot qualify a market whose 4/5 frequency has since spiked.
  const newTicks = current.ticks.filter(t => t.sequence > selected.sequence);
  if (newTicks.some(t => t.source !== "live" || t.generation !== selected.generation) ||
      (fresh.sequence > selected.sequence && newTicks.at(-1)?.sequence !== fresh.sequence) ||
      !evaluateDigit45Market(symbol, selected.candidate.displayName,
        [...selected.digits, ...newTicks.map(t => t.digit)].slice(-DIGIT45_WINDOW), fresh.epoch)?.eligible) {
    res.status(409).json({ error: "Digits 4/5 no longer qualify on the latest broker ticks. Scan again before creating a DBot." });
    return;
  }

  try {
    const settings = await db.select().from(settingsTable)
      .where(eq(settingsTable.sessionId, req.sessionId)).limit(1);
    const account = await db.select().from(accountsTable)
      .where(and(eq(accountsTable.sessionId, req.sessionId), eq(accountsTable.isActive, true))).limit(1);
    const accountCap = Number(settings[0]?.maxTradeStake ?? 500);
    const markup = Number(settings[0]?.botRecoveryMarkup ?? 10);
    const cap = Number(body.maxStake ?? Math.min(accountCap, 20));
    if (!Number.isFinite(cap) || cap > accountCap) {
      res.status(400).json({ error: "Max stake per leg exceeds your account's configured trade limit" });
      return;
    }
    // parse strictly: don't silently convert NaN, strings, 0 or an out-of-range
    // loss cap into a different live-trading strategy than the user configured.
    const strategy = buildDigit45DbotStrategy({
      symbol, displayName: selected.candidate.displayName,
      stake: body.stake, takeProfit: body.takeProfit, stopLoss: body.stopLoss,
      maxRecoverySteps: body.maxRecoverySteps, markupPercent: markup,
      maxStake: cap, currency: account[0]?.currency ?? "USD",
    });
    res.json({ ok: true, ...strategy,
      warning: "This is a paired strategy for NeuroTrade's embedded Bot Builder. Two buys are submitted together but are NOT atomic; broker fills may settle on different ticks. Recovery stakes use actual live proposals and BOTH legs' net P/L. No order has been placed.",
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid strategy settings" });
  }
});

export default router;
