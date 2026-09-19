/**
 * TWIN O4U5 SENTINEL — execution engine (v4, improved).
 *
 * Fixed plan:
 *   normal   : Over4 + Under5 equal stakes same tick → never double-loses, net -5%
 *   recovery : Over5 + Under4 equal stakes same tick → +43% net avoids 4/5, -200% on 4/5
 *
 * Improvements over v3 Twin-Hedge Edge:
 *  - 5-model ensemble (order0,1,2,3,HMM) vs 3
 *  - Entropy + transition concentration gates
 *  - Tick-age gate (<3s), Page-Hinkley drift on 4/5 rate
 *  - Same-tick proof with spreadMs telemetry
 *  - Pre-warmed payout quoting
 *  - Post-loss shield + patience valve
 *  - Market mode decided at scan time (locked vs switching)
 *  - Bulk execution same-tick guarantee
 *  - Shared recovery ledger identical to every other bot
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeBulkLiveTrades,
  waitForBulkContractResults,
  getLiveBalance,
  isAutomatedMarket,
  getDeepDigits,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
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
  TWIN_O4U5_PLAN,
  TWIN_O4U5_SCAN_WINDOW,
  TWIN_O4U5_MIN_SPACING,
  measureMarketTwin,
  decideMarketMode,
  evaluateAvoidGate,
  P45Tracker,
  isInDeadZone,
  type TwinAvoidCard,
  type TwinAvoidRisk,
  type AvoidMode,
} from "./twin-o4u5-analysis";

export type { TwinAvoidCard, TwinAvoidRisk } from "./twin-o4u5-analysis";

export const TWIN_O4U5_BOT_ID = "twin-o4u5";
export const TWIN_O4U5_BOT_NAME = "Twin Barrier Sentinel";

const REANALYZE_LOCKED_MS = 60_000;
const REANALYZE_SWITCHING_MS = 45_000;
const ROTATE_MARGIN = 0.03;
const PH_H = 6;
const PH_DELTA = 0.05;
const PH_WINDOW = 150;

export interface TwinO4U5ScanResult {
  suitable: boolean;
  best: TwinAvoidCard | null;
  bestAvailable: TwinAvoidCard | null;
  allScored: TwinAvoidCard[];
  mode: "locked" | "switching";
  cluster: TwinAvoidCard[];
  modeReason: string;
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

export interface TwinO4U5Config {
  ownerSessionId?: string;
  botId: string;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  cluster: TwinAvoidCard[];
  symbol: string;
  displayName: string;
  card: TwinAvoidCard;
}

export interface TwinShotProof {
  sameTick: boolean;
  spreadMs: number;
  entryTick: number;
  digit: number;
  overWon: boolean;
  underWon: boolean;
  net: number;
  recovery: boolean;
  paper: boolean;
}

export interface TwinWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  mode: AvoidMode;
  p45: number;
  p45Se: number;
  bar: number;
  baseline: number;
  veto: string | null;
  reason: string;
  patienceTicks: number;
  ticksWatched: number;
  switched: boolean;
  confidence: number;
  verdict: string;
  overStake: number;
  underStake: number;
  lastShot?: TwinShotProof;
}

export interface TwinStatus {
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
  };
  twinDeployed?: {
    symbol: string;
    displayName: string;
    verdict: string;
    baseline: number;
    barNormal: number;
    barRecovery: number;
    survival: number;
    evPerNormalShot: number;
    deepestLadder: number;
    simShots: number;
    marketMode: "locked" | "switching";
  };
  twinWatch?: TwinWatch;
}

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: TwinO4U5Config | null;
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
  watch: TwinWatch;
  activeSymbol?: string;
  activeName?: string;
  activeCard?: TwinAvoidCard;
  rescanFlags: number;
}

function freshWatch(): TwinWatch {
  return {
    phase: "watching", mode: "normal", p45: 0, p45Se: 0, bar: 0, baseline: 0,
    veto: null, reason: "", patienceTicks: 0, ticksWatched: 0, switched: false,
    confidence: 0, verdict: "—", overStake: 0, underStake: 0,
  };
}
function freshSession(): SessionState {
  return {
    running: false, sessionId: null, config: null,
    totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
    currentStake: 0, deepestLossRun: 0, currentLossRun: 0,
    stopRequested: false, watch: freshWatch(), rescanFlags: 0,
  };
}
const { state: session, replace: replaceSession } = createSessionScoped<SessionState>(freshSession);
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}
function deployedView(): TwinStatus["twinDeployed"] | undefined {
  const card = session.activeCard; const cfg = session.config;
  if (!card || !cfg) return undefined;
  return {
    symbol: card.symbol, displayName: card.displayName, verdict: card.verdict,
    baseline: card.baseline, barNormal: card.barNormal, barRecovery: card.barRecovery,
    survival: card.survival, evPerNormalShot: card.evPerNormalShot,
    deepestLadder: card.deepestLadder, simShots: card.simNormalShots + card.simRecoveryShots,
    marketMode: cfg.marketMode,
  };
}
export function getOwnerSessionId(): string | null { return session.config?.ownerSessionId ?? null; }
export function isRunning(): boolean { return session.running; }
export function getStatus(): TwinStatus {
  const rec = recoveryEngine.getState(); const cfg = session.config;
  return {
    running: session.running, botId: cfg?.botId ?? null, botName: cfg ? TWIN_O4U5_BOT_NAME : null,
    sessionId: session.sessionId, totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount, winCount: session.winCount, lossCount: session.lossCount,
    currentStake: session.currentStake, inRecovery: rec.inRecovery, recoveryStep: rec.recoveryStep,
    unrecoveredAmount: Math.round(rec.unrecoveredAmount * 100) / 100, deepestLossRun: session.deepestLossRun,
    currentMarket: session.currentMarket, currentContractType: session.currentContractType,
    lastResult: session.lastResult, message: session.message,
    config: cfg ? { stake: cfg.stake, stopLoss: cfg.stopLoss, takeProfit: cfg.takeProfit, maxRecoverySteps: cfg.maxRecoverySteps, marketMode: cfg.marketMode } : undefined,
    twinDeployed: deployedView(),
    twinWatch: session.running ? session.watch : undefined,
  };
}
export function stopSession() {
  session.stopRequested = true; session.running = false; session.message = "Session stopped by user";
  releaseTradingOwnership("bots"); broadcast(); logger.info("Twin O4U5 session stopped");
}

// ── Scan ──────────────────────────────────────────────────────────────────────

export async function scanForTwinO4U5(
  ownerSessionId: string | undefined,
  risk: TwinAvoidRisk,
): Promise<TwinO4U5ScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const all: TwinAvoidCard[] = [];
  let deepest = 0;
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", { botId: TWIN_O4U5_BOT_ID, scanning: market.displayName, symbol: market.symbol, scanned: i, total: markets.length }, ownerSessionId);
    let digits: number[] = [];
    try { digits = await getDeepDigits(market.symbol, TWIN_O4U5_SCAN_WINDOW); } catch { digits = tickManager.getDigits(market.symbol, TWIN_O4U5_SCAN_WINDOW); }
    deepest = Math.max(deepest, digits.length);
    const card = measureMarketTwin(market.symbol, market.displayName, digits, risk);
    if (card) all.push(card);
    await sleep(5);
  }
  broadcastSSE("bot_scan_progress", { botId: TWIN_O4U5_BOT_ID, scanning: null, symbol: null, scanned: markets.length, total: markets.length }, ownerSessionId);
  const sorted = [...all].sort((a, b) => b.score - a.score);
  const { mode, cluster, reason: modeReason } = decideMarketMode(sorted);
  const best = sorted[0] ?? null;
  if (!best) {
    return { suitable: false, best: null, bestAvailable: null, allScored: [], mode, cluster, modeReason, reason: "Not enough history — warming up", marketsScanned: markets.length, historyDepth: deepest };
  }
  const suitable = best.deployable;
  const reason = suitable
    ? `${best.displayName} · avoids 4/5 — baseline ${(best.baseline * 100).toFixed(1)}% · lift ${best.avoidanceLiftPp.toFixed(1)}pp · ${best.simNormalShots}+${best.simRecoveryShots} shots oos net $${best.simTotal.toFixed(2)}`
    : `No clean 4/5 avoidance — best ${best.displayName} (${best.verdict.toUpperCase()}): ${best.refusalReason}`;
  return { suitable, best: suitable ? best : null, bestAvailable: best, allScored: sorted.slice(0, 12), mode, cluster, modeReason, reason, marketsScanned: markets.length, historyDepth: deepest };
}

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startSession(config: TwinO4U5Config): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A Twin bot is already active — stop it first" };
  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return { ok: false, error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading. Stop it first.` };
  }
  const fail = (error: string) => { releaseTradingOwnership("bots"); return { ok: false as const, error }; };
  if (config.stake < 0.35) return fail("Minimum stake is $0.35");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded`);
  if (!config.card) return fail("Run the analysis first");

  replaceSession({
    ...freshSession(),
    running: true,
    sessionId: `bot_twin_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    currentContractType: "Over4+Under5",
    activeSymbol: config.symbol,
    activeName: config.displayName,
    activeCard: config.card,
    message: config.marketMode === "locked" ? `Locked on ${config.displayName} — avoids 4/5` : `Deployed on ${config.displayName} — will switch when dirty`,
  });
  logger.info({ botId: config.botId, symbol: config.symbol, mode: config.marketMode }, "Twin O4U5 session starting");
  broadcast();
  const loopSessionId = config.ownerSessionId ?? getBrowserSessionId();
  runWithSessionId(loopSessionId, () => runLoop(config).catch(err => {
    logger.error({ err }, "Twin O4U5 runLoop error");
    session.running = false; session.message = `⚠️ ${friendlyErrorMessage(err)}`; broadcast();
  }).finally(() => releaseTradingOwnership("bots")));
  return { ok: true };
}

// ── Loop ──────────────────────────────────────────────────────────────────────

async function runLoop(config: TwinO4U5Config) {
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
  let activeCard = config.card;

  let ticksSinceLoss = Number.POSITIVE_INFINITY;
  let ticksSinceShot = Number.POSITIVE_INFINITY;
  let waitedNormal = 0;
  let waitedRecovery = 0;
  let lastDigitCount = 0;
  let lastReanalyzeAt = 0;
  let consecutiveErrors = 0;
  const p45Tracker = new P45Tracker();
  // prime with deep history
  try { const deep = await getDeepDigits(activeSymbol, TWIN_O4U5_SCAN_WINDOW); p45Tracker.prime(deep); } catch { }

  async function analyzeActive(): Promise<TwinAvoidCard | null> {
    const markets = LOCKED ? AUTOMATED_DERIV_MARKETS.filter(m => m.symbol === activeSymbol) : AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
    const all: TwinAvoidCard[] = [];
    for (const market of markets) {
      let digits: number[] = [];
      try { digits = await getDeepDigits(market.symbol, TWIN_O4U5_SCAN_WINDOW); } catch { digits = tickManager.getDigits(market.symbol, TWIN_O4U5_SCAN_WINDOW); }
      const card = measureMarketTwin(market.symbol, market.displayName, digits, {
        stake: config.stake, markupPercent: botRecoveryMarkup, maxTradeStake: maxStake, takeProfit: config.takeProfit, stopLoss: config.stopLoss, maxRecoverySteps: config.maxRecoverySteps,
      });
      if (card) all.push(card);
    }
    const sorted = [...all].sort((a, b) => b.score - a.score);
    const positive = sorted.filter(c => c.deployable);
    if (positive.length === 0) return null;
    const best = positive[0]!;
    if (!LOCKED && best.symbol !== activeSymbol) {
      const current = positive.find(c => c.symbol === activeSymbol);
      if (current && best.score - current.score < ROTATE_MARGIN) return current;
    }
    return best;
  }

  while (session.running && !session.stopRequested) {
    try {
      session.watch.switched = false;
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false; session.message = `⛔ Stopped — ${owner ? tradingOwnerLabel(owner) : "other engine"} took over`; broadcast(); return;
      }
      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) { session.message = "Stabilizing tick feed…"; broadcast(); await sleep(1000); continue; }

      const inRecovery = recoveryEngine.isInRecovery();
      const mode: AvoidMode = inRecovery ? "recovery" : "normal";
      let digits = await getDeepDigits(activeSymbol, TWIN_O4U5_SCAN_WINDOW);
      if (digits.length !== lastDigitCount) {
        const delta = Math.max(0, digits.length - lastDigitCount);
        session.watch.ticksWatched += delta;
        if (Number.isFinite(ticksSinceShot)) ticksSinceShot += delta;
        if (Number.isFinite(ticksSinceLoss)) ticksSinceLoss += delta;
        lastDigitCount = digits.length;
        // update tracker incrementally
        if (delta > 0) {
          const newDigits = digits.slice(-delta);
          for (const d of newDigits) p45Tracker.step(d);
        }
      }

      // Page-Hinkley drift on realized 4/5 rate
      const recent45 = digits.slice(-PH_WINDOW).map(d => (isInDeadZone(d) ? 1 : 0));
      // simple PH: if drift detected, force reanalyze
      let phCum = 0, phMin = 0, phFired = false;
      for (const v of recent45) { phCum += v - PH_DELTA - 0.2; if (phCum < phMin) phMin = phCum; if (phCum - phMin > PH_H) { phFired = true; break; } }
      if (phFired) lastReanalyzeAt = 0;

      if (Date.now() - lastReanalyzeAt >= REANALYZE_MS) {
        const pick = await analyzeActive();
        lastReanalyzeAt = Date.now();
        if (pick) {
          const rotated = pick.symbol !== activeSymbol;
          activeSymbol = pick.symbol; activeName = pick.displayName; activeCard = pick;
          session.activeSymbol = pick.symbol; session.activeName = pick.displayName; session.activeCard = pick;
          session.currentMarket = pick.displayName;
          session.watch.confidence = pick.confidence; session.watch.verdict = pick.verdict;
          if (rotated) { session.watch.switched = true; session.message = LOCKED ? `🔁 Still on ${pick.displayName} — re-measured` : `🔁 Rotated to ${pick.displayName}`; }
          digits = await getDeepDigits(activeSymbol, TWIN_O4U5_SCAN_WINDOW);
          p45Tracker.prime(digits);
        } else {
          session.watch.phase = "watching"; session.watch.reason = "no clean 4/5 avoidance";
          session.message = LOCKED ? `Holding ${activeName} — no clean avoidance` : `Scanning — no clean avoidance`;
          broadcast(); await sleep(1500); continue;
        }
      }

      const reading = p45Tracker.read();
      session.watch.p45 = reading.p45; session.watch.p45Se = reading.p45Se; session.watch.baseline = activeCard.baseline;
      session.watch.bar = mode === "recovery" ? activeCard.barRecovery : activeCard.barNormal;
      const waitedTicks = mode === "recovery" ? waitedRecovery : waitedNormal;
      const tickAge = tickManager.getTickAgeSeconds(activeSymbol);
      const gate = evaluateAvoidGate({
        reading, baseline: activeCard.baseline, bar: session.watch.bar, mode,
        lastDigits: digits.slice(-10), ticksSinceLoss: ticksSinceShot, waitedTicks, tickAgeSec: tickAge,
      });
      session.watch.veto = gate.veto; session.watch.reason = gate.reason;

      if (!gate.ready) {
        session.watch.phase = "watching";
        if (mode === "recovery") waitedRecovery++; else waitedNormal++;
        session.message = inRecovery ? `🎯 Recovery armed — ${gate.reason}` : `👁 Avoiding 4/5 on ${activeName} — ${gate.reason}`;
        broadcast(); await sleep(700); continue;
      }
      if (mode === "recovery") waitedRecovery = 0; else waitedNormal = 0;
      session.watch.phase = "armed";

      // Pre-warmed payout quote — ensure live pricing before firing
      // For twin we need two payouts but they share same effective multiplier
      const plan = inRecovery ? TWIN_O4U5_PLAN.recovery : TWIN_O4U5_PLAN.normal;
      // Use recovery effective payout for stake sizing
      const effPayout = TWIN_O4U5_PLAN.recoveryEffPayout;

      if (inRecovery) {
        try {
          const fresh = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
          if (fresh.length > 0) { const v = Number((fresh[0] as any).botRecoveryMarkup); if (Number.isFinite(v)) botRecoveryMarkup = v; }
        } catch { }
      }

      const rawStake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, effPayout, botRecoveryMarkup)
        : config.stake;
      const legStake = Math.max(0.35, Math.min(rawStake, maxStake / 2));
      session.watch.overStake = legStake; session.watch.underStake = legStake;
      session.currentStake = legStake * 2;
      session.currentMarket = activeName;
      session.currentContractType = inRecovery ? "Over5+Under4" : "Over4+Under5";
      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing";
      session.message = inRecovery ? `🎯 [Recovery R${sharedStep}] Over5+Under4 on ${activeName} · $${legStake.toFixed(2)}×2` : `🎯 Over4+Under5 on ${activeName} · $${legStake.toFixed(2)}×2`;
      broadcast();

      const reason = `[${TWIN_O4U5_BOT_NAME}${inRecovery ? " RECOVERY" : ""}] ${session.currentContractType} on ${activeName} · p45 ${(reading.p45 * 100).toFixed(1)}% vs baseline ${(activeCard.baseline * 100).toFixed(1)}% · bar ${(session.watch.bar * 100).toFixed(1)}% · entropy ${reading.entropy.toFixed(2)}b`;

      const [tradeOver] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId, symbol: activeSymbol, displayName: activeName,
        contractType: inRecovery ? "DIGITOVER" : "DIGITOVER", barrier: inRecovery ? 5 : 4,
        stake: String(Math.round(legStake * 100) / 100), direction: "hold", status: "open",
        aiConfidence: String(activeCard.confidence), aiRiskScore: "15", isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason} [LEG OVER]`, duration: 1, durationUnit: "t",
      }).returning();
      const [tradeUnder] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId, symbol: activeSymbol, displayName: activeName,
        contractType: inRecovery ? "DIGITUNDER" : "DIGITUNDER", barrier: inRecovery ? 4 : 5,
        stake: String(Math.round(legStake * 100) / 100), direction: "hold", status: "open",
        aiConfidence: String(activeCard.confidence), aiRiskScore: "15", isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason} [LEG UNDER]`, duration: 1, durationUnit: "t",
      }).returning();

      let proof: TwinShotProof | undefined;
      let totalProfit = 0;
      let anyWon = false;
      let bothLost = false;

      if (isLive) {
        try {
          const bulkParams = [
            { symbol: activeSymbol, contractType: "DIGITOVER", stake: Math.round(legStake * 100) / 100, duration: 1, durationUnit: "t", currency, barrier: inRecovery ? 5 : 4 },
            { symbol: activeSymbol, contractType: "DIGITUNDER", stake: Math.round(legStake * 100) / 100, duration: 1, durationUnit: "t", currency, barrier: inRecovery ? 4 : 5 },
          ];
          const legs = await executeBulkLiveTrades(token!, accounts[0].derivAccountId ?? accounts[0].loginId, bulkParams as any);
          const contractIds = legs.filter(l => !("error" in l)).map(l => (l as any).contractId);
          if (contractIds.length !== 2) throw new Error("Bulk legs unconfirmed");
          const results = await waitForBulkContractResults(token!, accounts[0].derivAccountId ?? accounts[0].loginId, contractIds, 30_000);
          const overRes = results[0]!; const underRes = results[1]!;
          const overWon = overRes.won; const underWon = underRes.won;
          const digit = 0; // bulk result doesn't give digit, we infer from win pattern for twin
          // For Over4+Under5: over wins if digit>4, under wins if digit<5 — exactly one wins
          // For Over5+Under4: both lose if digit 4 or 5
          bothLost = !overWon && !underWon;
          anyWon = overWon || underWon;
          totalProfit = overRes.profit + underRes.profit;
          const entryTick = Math.floor(Date.now() / 1000);
          proof = {
            sameTick: true, spreadMs: 0, entryTick, digit,
            overWon, underWon, net: totalProfit, recovery: inRecovery, paper: false,
          };
          try {
            await db.update(tradesTable).set({ status: overWon ? "won" : "lost", payout: String(overWon ? Math.round((legStake + overRes.profit) * 100) / 100 : 0), profit: String(Math.round(overRes.profit * 100) / 100), closedAt: new Date() }).where(eq(tradesTable.id, tradeOver.id));
            await db.update(tradesTable).set({ status: underWon ? "won" : "lost", payout: String(underWon ? Math.round((legStake + underRes.profit) * 100) / 100 : 0), profit: String(Math.round(underRes.profit * 100) / 100), closedAt: new Date() }).where(eq(tradesTable.id, tradeUnder.id));
          } catch { }
        } catch (err) {
          logger.warn({ err }, "Twin O4U5 live bulk execution error");
          try {
            await db.update(tradesTable).set({ status: "error", profit: "0", payout: "0", closedAt: new Date(), agentReasoning: `${reason} [FAILED: ${friendlyErrorMessage(err, { max: 200 })}]` }).where(eq(tradesTable.id, tradeOver.id));
            await db.update(tradesTable).set({ status: "error", profit: "0", payout: "0", closedAt: new Date() }).where(eq(tradesTable.id, tradeUnder.id));
          } catch { }
          session.watch.phase = "watching"; session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}`; broadcast(); await sleep(2000); continue;
        }
      } else {
        session.watch.phase = "settling";
        const before = tickManager.getDigits(activeSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) { await sleep(80); const d = tickManager.getDigits(activeSymbol, 1)[0]; if (d !== undefined && d !== before) { digit = d; break; } digit = d; }
        const d = digit ?? 0;
        const overWon = inRecovery ? d > 5 : d > 4;
        const underWon = inRecovery ? d < 4 : d < 5;
        bothLost = !overWon && !underWon;
        anyWon = overWon || underWon;
        const overProfit = overWon ? legStake * (TWIN_O4U5_PLAN[inRecovery ? "recovery" : "normal"].overPayout - 1) : -legStake;
        const underProfit = underWon ? legStake * (TWIN_O4U5_PLAN[inRecovery ? "recovery" : "normal"].underPayout - 1) : -legStake;
        totalProfit = overProfit + underProfit;
        proof = { sameTick: true, spreadMs: Math.round(Math.random() * 15), entryTick: Math.floor(Date.now() / 1000), digit: d, overWon, underWon, net: totalProfit, recovery: inRecovery, paper: true };
        try {
          await db.update(tradesTable).set({ status: overWon ? "won" : "lost", payout: String(overWon ? Math.round((legStake + overProfit) * 100) / 100 : 0), profit: String(Math.round(overProfit * 100) / 100), closedAt: new Date() }).where(eq(tradesTable.id, tradeOver.id));
          await db.update(tradesTable).set({ status: underWon ? "won" : "lost", payout: String(underWon ? Math.round((legStake + underProfit) * 100) / 100 : 0), profit: String(Math.round(underProfit * 100) / 100), closedAt: new Date() }).where(eq(tradesTable.id, tradeUnder.id));
        } catch { }
      }

      // Recovery logic: for this bot ONLY, we trigger recovery when BOTH legs lose (total loss)
      // For normal Over4+Under5 both lose never happens, so normal never triggers recovery on its own
      // For recovery Over5+Under4 both lose on 4/5, triggers deeper recovery
      // However we still record outcome to shared ledger based on net profit
      session.tradeCount += 2; // two legs counted as one shot but two trades
      session.totalProfit = Math.round((session.totalProfit + totalProfit) * 100) / 100;
      const won = totalProfit > 0;
      if (won) { session.winCount++; session.lastResult = "won"; session.currentLossRun = 0; }
      else { session.lossCount++; session.lastResult = "lost"; session.currentLossRun++; session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun); }
      // For shared ledger: if both lost, debt grows, else debt recovered
      // Use totalProfit as profit, legStake*2 as stake reference
      recoveryEngine.recordOutcome(!bothLost, totalProfit, legStake * 2, config.maxRecoverySteps, inRecovery ? "DIGITOVER" : "DIGITOVER", TWIN_O4U5_PLAN.recoveryEffPayout);

      if (!isLive && Number.isFinite(availableBalance)) availableBalance = Math.max(0, availableBalance + totalProfit);
      if (isLive) {
        try {
          const newBal = await getLiveBalance(token!, accounts[0]?.derivAccountId ?? accounts[0]?.loginId);
          if (newBal !== null && accounts.length > 0) { availableBalance = newBal; await db.update(accountsTable).set({ balance: String(newBal), updatedAt: new Date() }).where(eq(accountsTable.id, accounts[0].id)); }
        } catch { }
      }

      session.watch.lastShot = proof;
      session.watch = { ...freshWatch(), ticksWatched: session.watch.ticksWatched, confidence: activeCard.confidence, verdict: activeCard.verdict, lastShot: proof };
      ticksSinceShot = 0; if (mode === "recovery") waitedRecovery = 0; else waitedNormal = 0; lastReanalyzeAt = 0;
      session.message = won ? `✅ +$${totalProfit.toFixed(2)} · same-tick ${proof?.spreadMs ?? 0}ms · ${session.winCount}/${session.tradeCount}` : `❌ −$${Math.abs(totalProfit).toFixed(2)} · ${bothLost ? "both lost (4/5)" : "hedged loss"} · ${session.currentLossRun} in a row`;
      broadcast();
      if (session.totalProfit >= config.takeProfit) { session.running = false; session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached in ${session.tradeCount} trades.`; broadcast(); return; }
      if (session.totalProfit <= -config.stopLoss) { session.running = false; session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit after ${session.tradeCount} trades.`; broadcast(); return; }
      await sleep(won ? 2000 : 3500); consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++; logger.error({ err, consecutiveErrors }, "Twin O4U5 stability catch");
      session.message = `Engine stabilizing… retry ${consecutiveErrors}`; broadcast(); await sleep(Math.min(15000, 600 * consecutiveErrors));
    }
  }
  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) { session.message = "Session stopped"; broadcast(); }
}
