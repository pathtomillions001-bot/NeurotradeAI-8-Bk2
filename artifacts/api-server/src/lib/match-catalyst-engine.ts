/**
 * MATCH CATALYST ENGINE — Precision Decay Engine for Matches
 *
 * Execution engine for the Match Catalyst bot. Shares the same trading loop
 * pattern as the Match Nexus engine but uses the Catalyst analysis layer
 * with its 7 experts, Weibull survival model, multi-scale convergence,
 * and adaptive post-loss protocol.
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
  getLiveBalance,
  isAutomatedMarket,
  getDeepDigits,
  deepHistoryDegraded,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
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
import { registerLiveBot } from "./live-registry";
import {
  evaluateCatalystCandidate,
  screenCatalystCandidates,
  evaluateCatalystLiveEntry,
  catalystCertaintySpec,
  SCAN_WINDOW_CATALYST,
  type CatalystCandidate,
  type CatalystCertainty,
  type CatalystModelCard,
} from "./match-catalyst-analysis";
import { evaluateTiming } from "./killshot-timing";
import { pageHinkley } from "./killshot-analysis";

export const MATCH_CATALYST_BOT_ID = "match-catalyst";
export const MATCH_CATALYST_BOT_NAME = "Match Catalyst";

const MAX_BAR_BOOST = 2.8;
const REANALYZE_LOCKED_MS = 18_000;
const REANALYZE_SWITCHING_MS = 40_000;
const SWITCH_MARGIN = 0.015;

export interface CatalystDeploySpec {
  botId: string;
  digit?: number;
  aiDigit: boolean;
  certainty: CatalystCertainty;
}

export interface CatalystConfig {
  ownerSessionId?: string;
  botId: string;
  spec: CatalystDeploySpec;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  symbol: string;
  displayName: string;
  digit: number;
  card: CatalystModelCard;
  lockedAnalysis?: CatalystCandidate;
}

export interface CatalystDeployed {
  symbol: string;
  displayName: string;
  contract: string;
  digit: number;
  verdict: string;
  confidence: number;
  edgePerDollar: number;
  oosWinRate: number;
  oosShots: number;
  breakEven: number;
  payout: number;
  gap: number;
  hazardRelative: number;
  percentile: number;
}

export interface CatalystWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  p: number;
  z: number;
  bar: number;
  reason: string;
  switched: boolean;
  confidence: number;
  verdict: string;
  ticksWatched: number;
  gap: number;
  hazardRelative: number;
  percentile: number;
  geoOverdue: number;
  leader: string;
  contextOrder: number;
  contextCount: number;
  regimeHot: number;
  experts: Array<{ name: string; p: number; n: number; weight: number }>;
  // Catalyst-specific
  scaleAgreement: number;
  zTrend: number;
}

export interface CatalystStatus {
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
    digit?: number;
    aiDigit: boolean;
    certainty: CatalystCertainty;
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    marketMode: "locked" | "switching";
    lockedSymbol?: string;
  };
  deployed?: CatalystDeployed;
  familyWatch?: CatalystWatch;
  specialist?: any;
  digitCandidates?: any[];
  topMarkets?: any[];
}

interface CandidateLite {
  symbol: string;
  displayName: string;
  digit: number;
  label: string;
  verdict: string;
  confidence: number;
  edgePerDollar: number;
  winRate: number;
  winRateLower: number;
  nShots: number;
  breakEven: number;
  payout: number;
  deployable: boolean;
  card: CatalystModelCard;
  gap: number;
  hazardRelative: number;
  percentile: number;
}

export interface CatalystScanResult {
  suitable: boolean;
  best: CandidateLite | null;
  bestAvailable: CandidateLite | null;
  allScored: CandidateLite[];
  reason: string;
  certainty: CatalystCertainty;
  marketsScanned: number;
  historyDepth: number;
}

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: CatalystConfig | null;
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
  watch: CatalystWatch;
  activeSymbol?: string;
  activeName?: string;
  activeDigit?: number;
  activeCard?: CatalystModelCard;
  activeRead?: CatalystCandidate | null;
  digitLossMemory: Map<number, number>;
  recentDigitTrades: Array<{ digit: number; won: boolean; gap: number }>;
}

function freshWatch(): CatalystWatch {
  return {
    phase: "watching",
    p: 0, z: 0, bar: 0, reason: "", switched: false, confidence: 0, verdict: "—",
    ticksWatched: 0, gap: 0, hazardRelative: 1, percentile: 0, geoOverdue: 1,
    leader: "—", contextOrder: 0, contextCount: 0, regimeHot: 0.5, experts: [],
    scaleAgreement: 0, zTrend: 0,
  };
}

function freshSession(): SessionState {
  return {
    running: false, sessionId: null, config: null, totalProfit: 0, tradeCount: 0,
    winCount: 0, lossCount: 0, currentStake: 0, deepestLossRun: 0, currentLossRun: 0,
    stopRequested: false, watch: freshWatch(), digitLossMemory: new Map(), recentDigitTrades: [],
  };
}

const { state: session, replace: replaceSession } = createSessionScoped<SessionState>(freshSession);
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

function deployedFrom(activeDigit: number | undefined, activeSymbol: string | undefined, activeName: string | undefined, read: CatalystCandidate | null | undefined, card: CatalystModelCard | undefined): CatalystDeployed | undefined {
  if (activeDigit === undefined || !card) return undefined;
  return {
    symbol: read?.symbol ?? activeSymbol ?? "",
    displayName: read?.displayName ?? activeName ?? "",
    contract: `Matches ${activeDigit}`,
    digit: activeDigit,
    verdict: read?.verdict ?? "—",
    confidence: read?.confidence ?? 0,
    edgePerDollar: read?.edgePerDollar ?? 0,
    oosWinRate: read?.walk?.test?.winRate ?? (read as any)?.winRate ?? 0,
    oosShots: read?.walk?.test?.nShots ?? (read as any)?.nShots ?? 0,
    breakEven: read?.breakEven ?? 0.112,
    payout: read?.payout ?? 8.93,
    gap: read?.walk?.gapStats?.currentGap ?? (read as any)?.gap ?? card.gapStats?.currentGap ?? 0,
    hazardRelative: read?.walk?.gapStats?.hazardRelative ?? (read as any)?.hazardRelative ?? card.gapStats?.hazardRelative ?? 0,
    percentile: read?.walk?.gapStats?.percentile ?? (read as any)?.percentile ?? card.gapStats?.percentile ?? 0,
  };
}

export function getOwnerSessionId(): string | null { return session.config?.ownerSessionId ?? null; }
export function isRunning(): boolean { return session.running; }

export function getStatus(): CatalystStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  return {
    running: session.running,
    botId: cfg?.botId ?? null,
    botName: cfg ? MATCH_CATALYST_BOT_NAME : null,
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
      digit: cfg.digit, aiDigit: cfg.spec.aiDigit, certainty: cfg.spec.certainty,
      stake: cfg.stake, stopLoss: cfg.stopLoss, takeProfit: cfg.takeProfit,
      maxRecoverySteps: cfg.maxRecoverySteps, marketMode: cfg.marketMode, lockedSymbol: cfg.lockedSymbol,
    } : undefined,
    deployed: session.running ? deployedFrom(session.activeDigit, session.activeSymbol, session.activeName, session.activeRead, session.activeCard) : undefined,
    familyWatch: session.running ? session.watch : undefined,
    specialist: session.activeRead ? {
      family: "match-catalyst",
      bonus: session.activeRead.confidence - 50,
      confidence: session.activeRead.confidence,
      favoured: `DIGITMATCH ${session.activeDigit}`,
      metrics: {
        pHat: session.watch.p, sigma: 0, z: session.watch.z, zBe: session.watch.z,
        breakEven: 0.112, gap: session.watch.gap, hazardRelative: session.watch.hazardRelative,
        percentile: session.watch.percentile, geoOverdue: session.watch.geoOverdue,
        regimeHot: session.watch.regimeHot, contextOrder: session.watch.contextOrder,
        scaleAgreement: session.watch.scaleAgreement, zTrend: session.watch.zTrend,
      },
      signals: (Array.isArray((session.activeRead as any).signals)
        ? (session.activeRead as any).signals
        : []).slice(0, 6),
    } : undefined,
    digitCandidates: [],
    topMarkets: [],
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info({ botId: session.config?.botId }, "Match Catalyst session stopped");
}

function simplify(c: CatalystCandidate): CandidateLite {
  return {
    symbol: c.symbol, displayName: c.displayName, digit: c.digit, label: c.label,
    verdict: c.verdict, confidence: c.confidence, edgePerDollar: c.edgePerDollar,
    winRate: c.walk.test.winRate, winRateLower: c.walk.test.winRateLower,
    nShots: c.walk.test.nShots, breakEven: c.breakEven, payout: c.payout,
    deployable: c.deployable, card: c.card,
    gap: c.walk.gapStats.currentGap, hazardRelative: c.walk.gapStats.hazardRelative, percentile: c.walk.gapStats.percentile,
  };
}

async function fastDigits(symbol: string, want: number): Promise<number[]> {
  const health = tickManager.getTickHealth();
  if (health.usingSimulated || deepHistoryDegraded()) {
    return tickManager.getDigits(symbol, want);
  }
  try {
    const d = await getDeepDigits(symbol, want);
    if (d.length >= 200) return d;
    return tickManager.getDigits(symbol, want);
  } catch {
    return tickManager.getDigits(symbol, want);
  }
}

export async function scanForCatalyst(
  ownerSessionId: string | undefined,
  spec: CatalystDeploySpec,
  risk: { stake: number; markupPercent: number; maxStake: number; stopLoss: number },
): Promise<CatalystScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const all: CatalystCandidate[] = [];
  let deepest = 0;

  const { computeGapStats } = await import("./match-catalyst-analysis");

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", {
      botId: spec.botId, scanning: market.displayName, symbol: market.symbol, scanned: i, total: markets.length,
    }, ownerSessionId);

    const digits = await fastDigits(market.symbol, SCAN_WINDOW_CATALYST);
    deepest = Math.max(deepest, digits.length);
    if (digits.length < 200) { await sleep(5); continue; }

    let digitsToScan: number[];
    if (!spec.aiDigit && spec.digit !== undefined) {
      digitsToScan = [spec.digit];
    } else {
      const gapInfos = Array.from({ length: 10 }, (_, d) => {
        const gs = computeGapStats(digits, d);
        const score = (gs.hazardRelative * 0.6 + gs.percentile * 0.4) * (gs.currentGap >= 3 ? 1 : 0.1);
        return { d, gs, score };
      });
      gapInfos.sort((a, b) => b.score - a.score);
      const keep = spec.certainty === "elite" ? 3 : spec.certainty === "strict" ? 2 : 1;
      digitsToScan = gapInfos.slice(0, keep).map(x => x.d);
    }

    for (const d of digitsToScan) {
      const cand = evaluateCatalystCandidate(market.symbol, market.displayName, digits, d, {
        certainty: spec.certainty, baseStake: risk.stake, markupPercent: risk.markupPercent, maxStake: risk.maxStake, stopLoss: risk.stopLoss,
      });
      if (cand) all.push(cand);
    }
    await sleep(0);
  }

  const ranked = screenCatalystCandidates(all);

  broadcastSSE("bot_scan_progress", {
    botId: spec.botId, scanning: null, symbol: null, scanned: markets.length, total: markets.length,
  }, ownerSessionId);

  const best = ranked[0];
  if (!best) {
    return {
      suitable: false, best: null, bestAvailable: null, allScored: [], certainty: spec.certainty,
      marketsScanned: markets.length, historyDepth: deepest,
      reason: "Not enough history yet — digit feed warming up. Wait and re-measure.",
    };
  }

  const suitable = best.deployable;
  const reason = suitable
    ? `${best.displayName} · ${best.label} — measured ${(best.walk.test.winRate * 100).toFixed(1)}% over ${best.walk.test.nShots} unseen shots (BE ${(best.breakEven * 100).toFixed(1)}%) · Weibull k=${best.walk.gapStats.weibull.k.toFixed(2)} · gap ${best.walk.gapStats.currentGap}t · hazard ×${best.walk.gapStats.hazardRelative.toFixed(2)}`
    : `No ${best.label} setup cleared ${spec.certainty} bar — best was ${best.displayName} ${best.label} (${best.verdict.toUpperCase()}, ${best.confidence}/100) · gap ${best.walk.gapStats.currentGap}t · hazard ×${best.walk.gapStats.hazardRelative.toFixed(2)}`;

  return {
    suitable,
    best: suitable ? simplify(best) : null,
    bestAvailable: simplify(best),
    allScored: ranked.slice(0, 15).map(simplify),
    reason,
    certainty: spec.certainty,
    marketsScanned: markets.length,
    historyDepth: deepest,
  };
}

export async function startSession(config: CatalystConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "Match Catalyst is already active — stop it first" };
  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return { ok: false, error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is trading. Stop it first — one ledger, one engine.` };
  }
  const fail = (e: string) => { releaseTradingOwnership("bots"); return { ok: false as const, error: e }; };
  if (config.stake < 0.35) return fail("Minimum stake $0.35");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  if (!config.card || !Number.isFinite(Number(config.card.tau))) return fail("Run analysis first — this bot only deploys a measured rule");
  const cardInput = config.card as any;
  if (!cardInput.platt || !Number.isFinite(Number(cardInput.platt.n))
    || !cardInput.hmm || !Number.isFinite(Number(cardInput.hmm.pHot))
    || !cardInput.gapStats || !Number.isFinite(Number(cardInput.gapStats.currentGap))) {
    return fail("The measured Catalyst card is incomplete or stale — run the analysis again");
  }
  if (config.digit < 0 || config.digit > 9) return fail("Digit must be 0-9");

  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  if (!market || !market.digitEnabled) return fail("Needs digit-enabled market");

  replaceSession({
    ...freshSession(),
    running: true,
    sessionId: `bot_catalyst_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    currentContractType: `Matches ${config.digit}`,
    activeSymbol: config.symbol,
    activeName: config.displayName,
    activeDigit: config.digit,
    activeCard: config.card,
    activeRead: config.lockedAnalysis ?? null,
    message: `⚡ Match Catalyst live — ${config.marketMode === "locked" ? `locked on ${config.displayName}` : "switching mode"} · Matches ${config.digit} · Weibull k=${config.card.gapStats.weibull.k.toFixed(2)} · adaptive cooldown ${config.card.adaptiveCooldown}t`,
  });

  registerLiveBot("match-catalyst", () => getStatus());

  const loopSessionId = config.ownerSessionId ?? getBrowserSessionId();
  runWithSessionId(loopSessionId, () => runLoop(config).catch(err => {
    logger.error({ err }, "Match Catalyst runLoop error");
    session.running = false;
    session.message = `⚠️ ${friendlyErrorMessage(err)}`;
    broadcast();
  }).finally(() => { releaseTradingOwnership("bots"); }));

  return { ok: true };
}

async function runLoop(config: CatalystConfig) {
  const ownerSessionId = config.ownerSessionId;
  const botName = MATCH_CATALYST_BOT_NAME;
  if (!ownerSessionId) {
    session.running = false;
    session.message = "Browser session missing — aborted safely";
    releaseTradingOwnership("bots");
    broadcast();
    return;
  }

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

  const SPEC = catalystCertaintySpec(config.spec.certainty);
  const isLocked = config.marketMode === "locked";

  let activeSymbol = config.symbol;
  let activeName = config.displayName;
  let activeDigit = config.digit;
  let activeCard = config.card;
  let activeRead: CatalystCandidate | null = config.lockedAnalysis ?? null;

  let ticksWatched = 0;
  let ticksSinceLoss = Number.POSITIVE_INFINITY;
  let lossRun = 0;
  let lastLossDigit: number | null = null;
  let consecutiveErrors = 0;
  let lastReanalyzeAt = 0;

  session.watch = { ...freshWatch(), confidence: activeRead?.confidence ?? 0, verdict: activeRead?.verdict ?? "—", bar: activeCard.tau };

  while (session.running && !session.stopRequested) {
    try {
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false;
        session.message = `⛔ Stopped — ${owner ? tradingOwnerLabel(owner) : "other engine"} is now trading. One ledger = one engine.`;
        broadcast(); return;
      }

      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) {
        session.message = "Stabilizing tick feed — syncing markets…";
        broadcast(); await sleep(1200); continue;
      }

      const now = Date.now();
      const reanalyzeInterval = isLocked ? REANALYZE_LOCKED_MS : REANALYZE_SWITCHING_MS;
      if (now - lastReanalyzeAt >= reanalyzeInterval && ticksWatched > 50) {
        lastReanalyzeAt = now;
        try {
          if (isLocked) {
            const digits = await fastDigits(activeSymbol, SCAN_WINDOW_CATALYST);
            const candidates: CatalystCandidate[] = [];
            for (let d = 0; d < 10; d++) {
              const recentLosses = session.recentDigitTrades.filter(t => t.digit === d && !t.won).length;
              if (recentLosses >= 2 && session.digitLossMemory.has(d)) {
                const lastLoss = session.digitLossMemory.get(d)!;
                if (Date.now() - lastLoss < 20000) continue;
              }
              const cand = evaluateCatalystCandidate(activeSymbol, activeName, digits, d, {
                certainty: SPEC.id, baseStake: config.stake, markupPercent: botRecoveryMarkup, maxStake, stopLoss: config.stopLoss,
              });
              if (cand) candidates.push(cand);
            }
            const ranked = screenCatalystCandidates(candidates);
            const bestInside = ranked.find(c => c.deployable);
            if (bestInside && bestInside.digit !== activeDigit && bestInside.edgePerDollar > (activeRead?.edgePerDollar ?? 0) + SWITCH_MARGIN) {
              activeDigit = bestInside.digit; activeCard = bestInside.card; activeRead = bestInside;
              session.activeDigit = activeDigit; session.activeCard = activeCard; session.activeRead = activeRead;
              session.watch.switched = true;
              session.message = `🔄 Edge rotated inside ${activeName} → Matches ${activeDigit} · EV ${(bestInside.edgePerDollar * 100).toFixed(2)}% · Weibull k=${bestInside.walk.gapStats.weibull.k.toFixed(2)}`;
              broadcast(); await sleep(1500); session.watch.switched = false;
            }
          } else {
            const all: CatalystCandidate[] = [];
            for (const m of AUTOMATED_DERIV_MARKETS.filter(mm => mm.digitEnabled)) {
              const digits = await fastDigits(m.symbol, SCAN_WINDOW_CATALYST);
              for (let d = 0; d < 10; d++) {
                const cand = evaluateCatalystCandidate(m.symbol, m.displayName, digits, d, {
                  certainty: SPEC.id, baseStake: config.stake, markupPercent: botRecoveryMarkup, maxStake, stopLoss: config.stopLoss,
                });
                if (cand) all.push(cand);
              }
            }
            const ranked = screenCatalystCandidates(all);
            const bestAny = ranked.find(c => c.deployable);
            if (bestAny && (bestAny.symbol !== activeSymbol || bestAny.digit !== activeDigit) && bestAny.edgePerDollar > (activeRead?.edgePerDollar ?? 0) + SWITCH_MARGIN) {
              activeSymbol = bestAny.symbol; activeName = bestAny.displayName; activeDigit = bestAny.digit; activeCard = bestAny.card; activeRead = bestAny;
              session.activeSymbol = activeSymbol; session.activeName = activeName; session.activeDigit = activeDigit; session.activeCard = activeCard; session.activeRead = activeRead;
              session.watch.switched = true;
              session.message = `🔁 Market switched → ${activeName} · Matches ${activeDigit} · EV ${(bestAny.edgePerDollar * 100).toFixed(2)}%`;
              broadcast(); await sleep(2000); session.watch.switched = false;
            }
          }
        } catch (e) { logger.warn({ err: e }, "Match Catalyst re-measure failed — continuing"); }
      }

      const liveDigits = await fastDigits(activeSymbol, SCAN_WINDOW_CATALYST);

      const inRecovery = recoveryEngine.isInRecovery();
      const barBoost = Math.min(MAX_BAR_BOOST, lossRun * SPEC.postLossTightening);

      const recentLossesSameDigit = session.recentDigitTrades.filter(t => t.digit === activeDigit && !t.won).length;
      if (recentLossesSameDigit >= 2) {
        const lastLossTime = session.digitLossMemory.get(activeDigit);
        if (lastLossTime && Date.now() - lastLossTime < 25000) {
          session.watch.phase = "watching";
          session.watch.reason = `digit ${activeDigit} vetoed — lost ${recentLossesSameDigit} of last 5, cooling 25s`;
          session.watch.p = 0;
          session.message = `🛡️ Anti-pattern: digit ${activeDigit} lost ${recentLossesSameDigit}/5 recently — vetoed, searching next edge…`;
          broadcast(); await sleep(2000); lastReanalyzeAt = 0; continue;
        }
      }

      const entry = evaluateCatalystLiveEntry(liveDigits, activeCard, { barBoost, ticksSinceLoss });

      ticksWatched++;
      session.watch = {
        phase: entry.ready ? "armed" : "watching",
        p: entry.p, z: entry.z, bar: entry.bar,
        reason: entry.reason || `watching · P ${(entry.p * 100).toFixed(1)}% vs BE ${(activeCard.breakEven * 100).toFixed(1)}% · gap ${entry.gap}t · Weibull hazard ×${entry.hazardRelative.toFixed(2)} · scales ${entry.scaleAgreement}/3`,
        switched: false, confidence: activeRead?.confidence ?? 0, verdict: activeRead?.verdict ?? "—",
        ticksWatched, gap: entry.gap, hazardRelative: entry.hazardRelative, percentile: entry.percentile,
        geoOverdue: entry.geoOverdue, leader: entry.leader, contextOrder: entry.contextOrder, contextCount: entry.contextCount,
        regimeHot: entry.regimeHot, experts: entry.experts,
        scaleAgreement: entry.scaleAgreement, zTrend: entry.zTrend,
      };

      if (!entry.ready) {
        session.message = entry.reason ? `⏳ ${entry.reason}` : `👁️ Watching ${activeName} · Matches ${activeDigit} · P ${(entry.p * 100).toFixed(1)}% · gap ${entry.gap}t · scales ${entry.scaleAgreement}/3`;
        broadcast(); await sleep(600); continue;
      }

      const timing = evaluateTiming({
        digits: liveDigits, winSet: new Set([activeDigit]),
        secondsSinceLastTick: tickManager.getTickAgeSeconds(activeSymbol),
        medianTickGapSeconds: activeSymbol.startsWith("1HZ") ? 1 : 2,
        ticksSinceLastShot: 0,
        minSpacing: activeCard.minSpacing,
      });

      if (!timing.ready) {
        session.watch.phase = "watching"; session.watch.reason = timing.reason;
        session.message = `⏳ Timing: ${timing.reason}`; broadcast(); await sleep(700); continue;
      }

      const winsForPH = liveDigits.map(d => (d === activeDigit ? 1 : 0));
      const ph = pageHinkley(winsForPH, 0.03, 10, 60);
      if (ph.fired) {
        session.message = `⚠️ Regime change detected on ${activeName} (PH ${ph.ph.toFixed(1)}/${ph.threshold}) — re-measuring…`;
        broadcast(); lastReanalyzeAt = 0; await sleep(2000); continue;
      }

      const payoutQuote = await resolveRecoveryPayout({
        symbol: activeSymbol, contractType: "DIGITMATCH", barrier: activeDigit, duration: 1, durationUnit: "t", currency,
      });
      const payout = payoutQuote.payoutMultiplier || 8.93;

      if (inRecovery) {
        try {
          const fresh = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
          if (fresh.length > 0) { const v = Number((fresh[0] as any).botRecoveryMarkup); if (Number.isFinite(v)) botRecoveryMarkup = v; }
        } catch {}
      }
      const stake = inRecovery ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, payout, botRecoveryMarkup) : config.stake;

      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing"; session.currentStake = stake;
      session.currentMarket = activeName; session.currentContractType = `Matches ${activeDigit}`;
      session.message = inRecovery ? `🎯 [R${sharedStep}] Matches ${activeDigit} on ${activeName} · $${stake.toFixed(2)} · gap ${entry.gap}t · Weibull ×${entry.hazardRelative.toFixed(2)}` : `🎯 Matches ${activeDigit} on ${activeName} · $${stake.toFixed(2)} · P ${(entry.p * 100).toFixed(1)}% · gap ${entry.gap}t`;
      broadcast();

      const measuredShots = activeRead?.walk?.test?.nShots ?? (activeRead as any)?.nShots ?? 0;
      const measuredWinRate = activeRead?.walk?.test?.winRate ?? (activeRead as any)?.winRate ?? 0;
      const reason = `[${botName}${inRecovery ? " RECOVERY" : ""}] Matches ${activeDigit} on ${activeName} · measured: ${measuredShots} shots at ${(measuredWinRate * 100).toFixed(1)}% OOS · edge ${entry.z.toFixed(2)}σ vs bar ${entry.bar.toFixed(2)}σ · P ${(entry.p * 100).toFixed(1)}% vs BE ${(activeCard.breakEven * 100).toFixed(1)}% · gap ${entry.gap}t · Weibull k=${activeCard.gapStats.weibull.k.toFixed(2)} · scales ${entry.scaleAgreement}/3`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId, symbol: activeSymbol, displayName: activeName, contractType: "DIGITMATCH", barrier: activeDigit,
        stake: String(Math.round(stake * 100) / 100), direction: "hold", status: "open",
        aiConfidence: String(activeRead?.confidence ?? Math.round(entry.p * 100)), aiRiskScore: "18", isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`, duration: 1, durationUnit: "t",
      }).returning();

      let won: boolean; let profit: number;
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0; let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: activeSymbol, contractType: "DIGITMATCH", barrier: activeDigit, stake: Math.round(stake * 100) / 100,
            duration: 1, durationUnit: "t", currency, accountId: accounts[0].derivAccountId ?? accounts[0].loginId,
          } as any);
          const result = await waitForContractResult(token!, accounts[0].derivAccountId ?? accounts[0].loginId, liveResult.contractId, 30_000);
          won = result.won; profit = result.profit;
          entryPrice = Number(result.entrySpot) || liveResult.buyPrice; exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          logger.warn({ err }, "Match Catalyst live execution error");
          try {
            await db.update(tradesTable).set({
              status: "error", profit: "0", payout: "0", closedAt: new Date(),
              agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
            }).where(eq(tradesTable.id, journaled.id));
          } catch {}
          session.watch.phase = "watching"; session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}. Back to watching.`; broadcast(); await sleep(2000); continue;
        }
      } else {
        const before = tickManager.getDigits(activeSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) { await sleep(120); const d = tickManager.getDigits(activeSymbol, 1)[0]; if (d !== undefined && d !== before) { digit = d; break; } digit = d; }
        const d = digit ?? 0; won = d === activeDigit; profit = won ? stake * (payout - 1) : -stake;
      }

      session.tradeCount++; session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) { session.winCount++; session.lastResult = "won"; session.currentLossRun = 0; lossRun = 0; ticksSinceLoss = Number.POSITIVE_INFINITY; lastLossDigit = null; }
      else { session.lossCount++; session.lastResult = "lost"; session.currentLossRun++; session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun); lossRun++; ticksSinceLoss = 0; lastLossDigit = activeDigit; session.digitLossMemory.set(activeDigit, Date.now()); }

      session.recentDigitTrades.push({ digit: activeDigit, won, gap: entry.gap });
      if (session.recentDigitTrades.length > 20) session.recentDigitTrades.shift();

      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, "DIGITMATCH", payout);

      try {
        await db.update(tradesTable).set({
          status: won ? "won" : "lost", payout: String(won ? Math.round((stake + profit) * 100) / 100 : 0),
          profit: String(Math.round(profit * 100) / 100), entryPrice: String(entryPrice), exitPrice: String(exitPrice), closedAt: new Date(),
        }).where(eq(tradesTable.id, journaled.id));
      } catch (dbErr) { logger.warn({ dbErr }, "Match Catalyst: failed to settle journaled trade"); }

      if (!isLive && Number.isFinite(availableBalance)) availableBalance = Math.max(0, availableBalance + profit);
      if (isLive) {
        try {
          const newBal = await getLiveBalance(token!, accounts[0]?.derivAccountId ?? accounts[0]?.loginId);
          if (newBal !== null && accounts.length > 0) { availableBalance = newBal; await db.update(accountsTable).set({ balance: String(newBal), updatedAt: new Date() }).where(eq(accountsTable.id, accounts[0].id)); }
        } catch {}
      }

      session.watch = { ...freshWatch(), ticksWatched, confidence: activeRead?.confidence ?? 0, verdict: activeRead?.verdict ?? "—" };
      session.message = won ? `✅ +$${profit.toFixed(2)} · ${session.winCount}/${session.tradeCount} (${Math.round((session.winCount / Math.max(1, session.tradeCount)) * 100)}%) · gap was ${entry.gap}t · next edge re-measured` : `❌ −$${Math.abs(profit).toFixed(2)} · gap was ${entry.gap}t · adaptive shield on (cooldown ${activeCard.adaptiveCooldown}t) · ${session.currentLossRun} in row · digit ${activeDigit} cooling`;
      broadcast();

      if (session.totalProfit >= config.takeProfit) { session.running = false; session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached in ${session.tradeCount} shots — Match Catalyst achieved target.`; broadcast(); return; }
      if (session.totalProfit <= -config.stopLoss) { session.running = false; session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit after ${session.tradeCount} shots. Session stopped safely.`; broadcast(); return; }

      await sleep(won ? 2500 : 4000);
      consecutiveErrors = 0; ticksSinceLoss = won ? Number.POSITIVE_INFINITY : 0; lastReanalyzeAt = 0;
    } catch (err) {
      consecutiveErrors++; logger.error({ err, consecutiveErrors }, "Match Catalyst stability catch — keeping alive");
      session.message = `Engine stabilizing… retry ${consecutiveErrors} — session will keep running`; broadcast();
      await sleep(Math.min(15000, 600 * consecutiveErrors));
    }
  }

  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped"; broadcast();
  }
}