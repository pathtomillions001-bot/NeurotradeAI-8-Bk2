/**
 * MATCH APEX SENTINEL — execution engine.
 *
 * Superior to Match Sniper and Matches/Differs Oracle:
 *  - Deep history, 6-model ensemble, out-of-sample measured
 *  - Entropy + transition-concentration regime filters
 *  - Tick-age, hazard, geometric overdue, FDR gates
 *  - Locked vs switching market mode decided at scan time
 *  - Post-loss shield + patience valve
 *  - Same shared recovery ledger as every other bot
 *  - Single-executor arbiter
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
  getLiveBalance,
  isAutomatedMarket,
  getDeepDigits,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { resolveRecoveryPayout } from "./recovery-payout";
import * as recoveryEngine from "./agents/recovery-engine";
import {
  acquireTradingOwnership,
  releaseTradingOwnership,
  hasTradingOwnership,
  currentTradingOwner,
  tradingOwnerLabel,
} from "./engine-arbiter";
import { createSessionScoped, getBrowserSessionId, runWithSessionId } from "./session";
import {
  MATCH_APEX_SCAN_WINDOW,
  measureMarketApex,
  screenCandidates,
  decideMarketMode,
  evaluateLiveEntry,
  pageHinkley,
  MATCH_PAYOUT,
  MATCH_BREAK_EVEN,
  type MatchApexCard,
  type MatchApexRisk,
} from "./match-apex-analysis";

export const MATCH_APEX_BOT_ID = "match-apex";
export const MATCH_APEX_BOT_NAME = "Match Apex Sentinel";

const REANALYZE_LOCKED_MS = 20_000;
const REANALYZE_SWITCHING_MS = 40_000;
const SWITCH_MARGIN = 0.03;
const HEALTH_WINDOW = 1200;
const MAX_BAR_BOOST = 2.5;

export interface MatchApexScanResult {
  suitable: boolean;
  best: MatchApexCard | null;
  bestAvailable: MatchApexCard | null;
  allScored: MatchApexCard[];
  mode: "locked" | "switching";
  cluster: MatchApexCard[];
  modeReason: string;
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

export interface MatchApexConfig {
  ownerSessionId?: string;
  botId: string;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  cluster: MatchApexCard[];
  symbol: string;
  displayName: string;
  card: MatchApexCard;
  lockedSymbol?: string;
}

export interface MatchApexWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  p: number;
  z: number;
  bar: number;
  gap: number;
  hazard: number;
  entropy: number;
  transEntropy: number;
  reason: string;
  switched: boolean;
  confidence: number;
  verdict: string;
  ticksWatched: number;
  digit: number;
}

export interface MatchApexStatus {
  running: boolean;
  botId: string | null;
  botName: string | null;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  deepestLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: {
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    marketMode: "locked" | "switching";
    digit: number;
  };
  deployed?: {
    symbol: string;
    displayName: string;
    digit: number;
    verdict: string;
    confidence: number;
    edgePerDollar: number;
    winRate: number;
    winRateLower: number;
    nShots: number;
    breakEven: number;
    payout: number;
    entropy: number;
    transEntropy: number;
    hazard: number;
    gap: number;
    marketMode: "locked" | "switching";
  };
  watch?: MatchApexWatch;
}

function freshWatch(): MatchApexWatch {
  return {
    phase: "watching", p: 0, z: 0, bar: 0, gap: 0, hazard: 0, entropy: 0, transEntropy: 0,
    reason: "", switched: false, confidence: 0, verdict: "—", ticksWatched: 0, digit: 5,
  };
}
interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: MatchApexConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  deepestLossRun: number;
  currentLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  stopRequested: boolean;
  watch: MatchApexWatch;
  activeSymbol?: string;
  activeName?: string;
  activeCard?: MatchApexCard;
}
function freshSession(): SessionState {
  return {
    running: false, sessionId: null, config: null,
    totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
    currentStake: 0, deepestLossRun: 0, currentLossRun: 0,
    stopRequested: false, watch: freshWatch(),
  };
}
const { state: session, replace: replaceSession } = createSessionScoped<SessionState>(freshSession);
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

export function getOwnerSessionId(): string | null { return session.config?.ownerSessionId ?? null; }
export function isRunning(): boolean { return session.running; }
export function getStatus(): MatchApexStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const card = session.activeCard ?? cfg?.card;
  return {
    running: session.running,
    botId: cfg?.botId ?? null,
    botName: cfg ? MATCH_APEX_BOT_NAME : null,
    sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    currentStake: session.currentStake,
    inRecovery: rec.inRecovery,
    recoveryStep: rec.recoveryStep,
    unrecoveredAmount: Math.round(rec.unrecoveredAmount * 100) / 100,
    deepestLossRun: session.deepestLossRun,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    config: cfg ? {
      stake: cfg.stake, stopLoss: cfg.stopLoss, takeProfit: cfg.takeProfit,
      maxRecoverySteps: cfg.maxRecoverySteps, marketMode: cfg.marketMode, digit: card?.digit ?? 5,
    } : undefined,
    deployed: card ? {
      symbol: card.symbol, displayName: card.displayName, digit: card.digit,
      verdict: card.verdict, confidence: card.confidence, edgePerDollar: card.edgePerDollar,
      winRate: card.winRate, winRateLower: card.winRateLower, nShots: card.nShots,
      breakEven: card.breakEven, payout: card.payout, entropy: card.entropy,
      transEntropy: card.transEntropy, hazard: card.hazardRelative, gap: card.gap,
      marketMode: cfg?.marketMode ?? "locked",
    } : undefined,
    watch: session.running ? session.watch : undefined,
  };
}
export function stopSession() {
  session.stopRequested = true; session.running = false; session.message = "Session stopped by user";
  releaseTradingOwnership("bots"); broadcast(); logger.info("Match Apex session stopped");
}

// ── Scan ──────────────────────────────────────────────────────────────────────

export async function scanForMatchApex(
  ownerSessionId: string | undefined,
  risk: MatchApexRisk,
): Promise<MatchApexScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const all: MatchApexCard[] = [];
  let deepest = 0;
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", { botId: MATCH_APEX_BOT_ID, scanning: market.displayName, symbol: market.symbol, scanned: i, total: markets.length }, ownerSessionId);
    let digits: number[] = [];
    try { digits = await getDeepDigits(market.symbol, MATCH_APEX_SCAN_WINDOW); } catch { digits = tickManager.getDigits(market.symbol, MATCH_APEX_SCAN_WINDOW); }
    deepest = Math.max(deepest, digits.length);
    const card = measureMarketApex(market.symbol, market.displayName, digits, risk);
    if (card) all.push(card);
    await sleep(5);
  }
  broadcastSSE("bot_scan_progress", { botId: MATCH_APEX_BOT_ID, scanning: null, symbol: null, scanned: markets.length, total: markets.length }, ownerSessionId);
  const ranked = screenCandidates(all);
  const { mode, cluster, reason: modeReason } = decideMarketMode(ranked);
  const best = ranked[0] ?? null;
  if (!best) {
    return { suitable: false, best: null, bestAvailable: null, allScored: [], mode, cluster, modeReason, reason: "Not enough history — warming up", marketsScanned: markets.length, historyDepth: deepest };
  }
  const suitable = best.deployable;
  const reason = suitable
    ? `${best.displayName} · Matches ${best.digit} — measured ${(best.winRate * 100).toFixed(0)}% over ${best.nShots} unseen shots (be ${(best.breakEven * 100).toFixed(1)}%, edge ${(best.edgePerDollar * 100).toFixed(1)}%) · entropy ${best.entropy.toFixed(2)}b`
    : `No Matches setup cleared the bar — best ${best.displayName} digit ${best.digit} (${best.verdict.toUpperCase()}, ${best.confidence}/100): ${best.refusalReason}`;
  return { suitable, best: suitable ? best : null, bestAvailable: best, allScored: ranked.slice(0, 12), mode, cluster, modeReason, reason, marketsScanned: markets.length, historyDepth: deepest };
}

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startSession(config: MatchApexConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A Match Apex bot is already active — stop it first" };
  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return { ok: false, error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account. Stop it first.` };
  }
  const fail = (error: string) => { releaseTradingOwnership("bots"); return { ok: false as const, error }; };
  if (config.stake < 0.35) return fail("Minimum stake is $0.35");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  if (!config.card || !Number.isFinite(Number(config.card.pHat))) return fail("Run the analysis first — this bot only deploys a measured rule");
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  if (!market || !market.digitEnabled) return fail("This bot needs a digit-enabled market");

  replaceSession({
    ...freshSession(),
    running: true,
    sessionId: `bot_matchapex_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    currentContractType: `Matches ${config.card.digit}`,
    activeSymbol: config.symbol,
    activeName: config.displayName,
    activeCard: config.card,
    message: config.marketMode === "locked"
      ? `Locked on ${config.displayName} · Matches ${config.card.digit} — edge may move digit, market will not`
      : `Deployed on ${config.displayName} · Matches ${config.card.digit} — will move to better market when this cools`,
  });
  logger.info({ botId: config.botId, symbol: config.symbol, digit: config.card.digit, marketMode: config.marketMode }, "Match Apex session starting");
  broadcast();
  const loopSessionId = config.ownerSessionId ?? getBrowserSessionId();
  runWithSessionId(loopSessionId, () => runLoop(config).catch(err => {
    logger.error({ err }, "Match Apex runLoop error");
    session.running = false; session.message = `⚠️ ${friendlyErrorMessage(err)}`; broadcast();
  }).finally(() => releaseTradingOwnership("bots")));
  return { ok: true };
}

// ── Loop ──────────────────────────────────────────────────────────────────────

async function runLoop(config: MatchApexConfig) {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) { session.running = false; session.message = "Browser session missing"; releaseTradingOwnership("bots"); broadcast(); return; }

  let accounts = await db.select().from(accountsTable).where(and(eq(accountsTable.sessionId, ownerSessionId), eq(accountsTable.isActive, true))).limit(1);
  if (accounts.length === 0) accounts = await db.select().from(accountsTable).where(eq(accountsTable.sessionId, ownerSessionId)).limit(1);
  const settings = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
  recoveryEngine.setPersistenceSession(ownerSessionId);
  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;
  const token = accounts.length > 0 ? (accounts[0].bearerToken ?? accounts[0].token ?? null) : null;
  const currency = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0].maxTradeStake) : 500;
  let botRecoveryMarkup = settings.length > 0 ? Number((settings[0] as any).botRecoveryMarkup ?? 10) : 10;
  let availableBalance = accounts.length > 0 && Number(accounts[0].balance) > 0 ? Number(accounts[0].balance) : Number.POSITIVE_INFINITY;

  const LOCKED = config.marketMode === "locked";
  const REANALYZE_MS = LOCKED ? REANALYZE_LOCKED_MS : REANALYZE_SWITCHING_MS;
  let activeSymbol = config.symbol;
  let activeName = config.displayName;
  let activeCard: MatchApexCard = { ...config.card };
  let activeDigit = activeCard.digit;

  let ticksSinceLoss = Number.POSITIVE_INFINITY;
  let ticksSinceLastShot = Number.POSITIVE_INFINITY;
  let lossRun = 0;
  let waitedTicks = 0;
  let lastDigitCount = 0;
  let lastReanalyzeAt = 0;
  let consecutiveErrors = 0;

  async function analyzeActive(): Promise<MatchApexCard | null> {
    const markets = LOCKED ? AUTOMATED_DERIV_MARKETS.filter(m => m.symbol === activeSymbol) : AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
    const all: MatchApexCard[] = [];
    for (const market of markets) {
      let digits: number[] = [];
      try { digits = await getDeepDigits(market.symbol, MATCH_APEX_SCAN_WINDOW); } catch { digits = tickManager.getDigits(market.symbol, MATCH_APEX_SCAN_WINDOW); }
      const card = measureMarketApex(market.symbol, market.displayName, digits, {
        stake: config.stake, markupPercent: botRecoveryMarkup, maxStake, stopLoss: config.stopLoss, takeProfit: config.takeProfit, maxRecoverySteps: config.maxRecoverySteps,
      });
      if (card) all.push(card);
    }
    const ranked = screenCandidates(all);
    const positive = ranked.filter(c => c.edgePerDollar > 0);
    if (positive.length === 0) return null;
    const best = positive[0]!;
    if (!LOCKED && best.symbol !== activeSymbol) {
      const currentBest = positive.find(c => c.symbol === activeSymbol);
      if (currentBest && currentBest.edgePerDollar > 0 && best.edgePerDollar - currentBest.edgePerDollar < SWITCH_MARGIN) return currentBest;
    }
    return best;
  }

  while (session.running && !session.stopRequested) {
    try {
      session.watch.switched = false;
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false; session.message = `⛔ Stopped — the ${owner ? tradingOwnerLabel(owner) : "other engine"} took over`; broadcast(); return;
      }
      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) { session.message = "Stabilizing tick feed…"; broadcast(); await sleep(1000); continue; }
      const inRecovery = recoveryEngine.isInRecovery();
      let digits = await getDeepDigits(activeSymbol, MATCH_APEX_SCAN_WINDOW);
      if (digits.length !== lastDigitCount) {
        const delta = Math.max(0, digits.length - lastDigitCount);
        session.watch.ticksWatched += delta;
        if (Number.isFinite(ticksSinceLastShot)) ticksSinceLastShot += delta;
        if (Number.isFinite(ticksSinceLoss)) ticksSinceLoss += delta;
        lastDigitCount = digits.length;
      }
      const wins = digits.slice(-HEALTH_WINDOW).map(d => (d === activeDigit ? 1 : 0));
      const ph = pageHinkley(wins);
      if (ph.fired) lastReanalyzeAt = 0;

      const needsReanalyze = Date.now() - lastReanalyzeAt >= REANALYZE_MS;
      if (needsReanalyze) {
        const pick = await analyzeActive();
        lastReanalyzeAt = Date.now();
        if (pick) {
          const rotated = pick.symbol !== activeSymbol || pick.digit !== activeDigit;
          activeSymbol = pick.symbol; activeName = pick.displayName; activeCard = pick; activeDigit = pick.digit;
          session.activeSymbol = pick.symbol; session.activeName = pick.displayName; session.activeCard = pick;
          session.currentMarket = pick.displayName; session.currentContractType = `Matches ${pick.digit}`;
          session.watch.confidence = pick.confidence; session.watch.verdict = pick.verdict; session.watch.digit = pick.digit;
          if (rotated) {
            session.watch.switched = true;
            session.message = LOCKED ? `🔁 Edge moved on ${pick.displayName} — now Matches ${pick.digit}` : `🔁 Rotated to ${pick.displayName} · Matches ${pick.digit}`;
          }
          digits = await getDeepDigits(activeSymbol, MATCH_APEX_SCAN_WINDOW);
        } else {
          session.watch.phase = "watching"; session.watch.reason = "no positive edge right now";
          session.message = LOCKED ? `Holding on ${activeName} — no positive edge` : `Scanning — no positive edge`;
          broadcast(); await sleep(1500); continue;
        }
      }

      const barBoost = Math.min(MAX_BAR_BOOST, activeCard.modelCard.postLossTightening * (lossRun + (inRecovery ? 1 : 0)));
      const tickAge = tickManager.getTickAgeSeconds(activeSymbol);
      const entry = evaluateLiveEntry(digits, activeCard, { barBoost, ticksSinceLoss, waitedTicks, tickAgeSec: tickAge });
      session.watch.p = entry.p; session.watch.z = entry.z; session.watch.bar = entry.bar;
      session.watch.gap = entry.reading?.gap ?? activeCard.gap;
      session.watch.hazard = entry.reading?.hazardRelative ?? activeCard.hazardRelative;
      session.watch.entropy = entry.reading?.entropy ?? activeCard.entropy;
      session.watch.transEntropy = entry.reading?.transEntropy ?? activeCard.transEntropy;

      if (!entry.ready) {
        session.watch.phase = "watching"; waitedTicks++;
        session.watch.reason = entry.reason;
        session.message = inRecovery ? `🎯 Recovery armed — ${entry.reason}` : `👁 Matches ${activeDigit} on ${activeName} — ${entry.reason}`;
        broadcast(); await sleep(800); continue;
      }
      waitedTicks = 0;
      session.watch.phase = "armed";

      // Execution-tick revalidation: fresh read must still pass
      const reDigits = tickManager.getDigits(activeSymbol, 200);
      const reEntry = evaluateLiveEntry(reDigits, activeCard, { barBoost, ticksSinceLoss, waitedTicks: 0, tickAgeSec: tickManager.getTickAgeSeconds(activeSymbol) });
      if (!reEntry.ready) {
        session.watch.phase = "watching"; session.watch.reason = `edge faded at execution tick — ${reEntry.reason}`;
        session.message = `⏱️ Revalidation failed — ${reEntry.reason}`; broadcast(); await sleep(600); continue;
      }

      if (!isAutomatedMarket(activeSymbol)) { session.running = false; session.message = "⚠️ Market blocked"; broadcast(); return; }

      const payoutQuote = await resolveRecoveryPayout({
        symbol: activeSymbol, contractType: "DIGITMATCH", barrier: activeDigit, duration: 1, durationUnit: "t", currency,
      });
      const payout = payoutQuote.payoutMultiplier || MATCH_PAYOUT;

      if (inRecovery) {
        try {
          const fresh = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
          if (fresh.length > 0) { const v = Number((fresh[0] as any).botRecoveryMarkup); if (Number.isFinite(v)) botRecoveryMarkup = v; }
        } catch { }
      }
      const stake = inRecovery ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, payout, botRecoveryMarkup) : config.stake;
      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing"; session.currentStake = stake; session.currentMarket = activeName; session.currentContractType = `Matches ${activeDigit}`;
      session.message = inRecovery ? `🎯 [Recovery R${sharedStep}] Matches ${activeDigit} on ${activeName} · $${stake.toFixed(2)}` : `🎯 Matches ${activeDigit} on ${activeName} · $${stake.toFixed(2)}`;
      broadcast();

      const reason = `[${MATCH_APEX_BOT_NAME}${inRecovery ? " RECOVERY" : ""}] Matches ${activeDigit} on ${activeName} · measured ${activeCard.nShots} shots at ${(activeCard.winRate * 100).toFixed(1)}% oos · edge ${entry.z.toFixed(2)}σ vs bar ${entry.bar.toFixed(2)}σ · P ${(entry.p * 100).toFixed(1)}% · entropy ${entry.reading?.entropy.toFixed(2)}b`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId, symbol: activeSymbol, displayName: activeName,
        contractType: "DIGITMATCH", barrier: activeDigit, stake: String(Math.round(stake * 100) / 100),
        direction: "hold", status: "open", aiConfidence: String(activeCard.confidence), aiRiskScore: "15",
        isAutonomous: true, agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`, duration: 1, durationUnit: "t",
      }).returning();

      let won: boolean; let profit: number; let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0; let exitPrice = entryPrice;
      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: activeSymbol, contractType: "DIGITMATCH", stake: Math.round(stake * 100) / 100,
            duration: 1, durationUnit: "t", currency, accountId: accounts[0].derivAccountId ?? accounts[0].loginId, barrier: activeDigit,
          } as any);
          const result = await waitForContractResult(token!, accounts[0].derivAccountId ?? accounts[0].loginId, liveResult.contractId, 30_000);
          won = result.won; profit = result.profit; entryPrice = Number(result.entrySpot) || liveResult.buyPrice; exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          logger.warn({ err }, "Match Apex live execution error");
          try { await db.update(tradesTable).set({ status: "error", profit: "0", payout: "0", closedAt: new Date(), agentReasoning: `${reason} [FAILED: ${friendlyErrorMessage(err, { max: 200 })}]` }).where(eq(tradesTable.id, journaled.id)); } catch { }
          session.watch.phase = "watching"; session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}`; broadcast(); await sleep(2000); continue;
        }
      } else {
        session.watch.phase = "settling";
        const before = tickManager.getDigits(activeSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) { await sleep(120); const d = tickManager.getDigits(activeSymbol, 1)[0]; if (d !== undefined && d !== before) { digit = d; break; } digit = d; }
        const d = digit ?? 0; won = d === activeDigit; profit = won ? stake * (payout - 1) : -stake;
      }

      session.tradeCount++; session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) { session.winCount++; session.lastResult = "won"; session.currentLossRun = 0; lossRun = 0; ticksSinceLoss = Number.POSITIVE_INFINITY; }
      else { session.lossCount++; session.lastResult = "lost"; session.currentLossRun++; session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun); lossRun++; ticksSinceLoss = 0; }
      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, "DIGITMATCH", payout);
      try { await db.update(tradesTable).set({ status: won ? "won" : "lost", payout: String(won ? Math.round((stake + profit) * 100) / 100 : 0), profit: String(Math.round(profit * 100) / 100), entryPrice: String(entryPrice), exitPrice: String(exitPrice), closedAt: new Date() }).where(eq(tradesTable.id, journaled.id)); } catch { }
      if (!isLive && Number.isFinite(availableBalance)) availableBalance = Math.max(0, availableBalance + profit);
      if (isLive) { try { const newBal = await getLiveBalance(token!, accounts[0]?.derivAccountId ?? accounts[0]?.loginId); if (newBal !== null && accounts.length > 0) { availableBalance = newBal; await db.update(accountsTable).set({ balance: String(newBal), updatedAt: new Date() }).where(eq(accountsTable.id, accounts[0].id)); } } catch { } }

      session.watch = { ...freshWatch(), ticksWatched: session.watch.ticksWatched, confidence: activeCard.confidence, verdict: activeCard.verdict, digit: activeDigit };
      ticksSinceLastShot = 0; waitedTicks = 0; lastReanalyzeAt = 0;
      session.message = won ? `✅ +$${profit.toFixed(2)} · ${session.winCount}/${session.tradeCount} · next re-measured` : `❌ −$${Math.abs(profit).toFixed(2)} · shield on · ${session.currentLossRun} in a row`;
      broadcast();
      if (session.totalProfit >= config.takeProfit) { session.running = false; session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached in ${session.tradeCount} shots.`; broadcast(); return; }
      if (session.totalProfit <= -config.stopLoss) { session.running = false; session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit after ${session.tradeCount} shots.`; broadcast(); return; }
      await sleep(won ? 2500 : 4000); consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++; logger.error({ err, consecutiveErrors }, "Match Apex stability catch");
      session.message = `Engine stabilizing… retry ${consecutiveErrors}`; broadcast(); await sleep(Math.min(15000, 600 * consecutiveErrors));
    }
  }
  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) { session.message = "Session stopped"; broadcast(); }
}
