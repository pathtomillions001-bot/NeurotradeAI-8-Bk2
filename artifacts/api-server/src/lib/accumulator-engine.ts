/**
 * Live/paper execution engine for Deriv ACCU contracts.
 *
 * This is intentionally a separate executor from the digit engines. ACCU has a
 * compounded value path and a full-stake knockout, so its scan, entry gate,
 * early-close monitor, and recovery stake all use accumulator economics.
 */

import {
  AUTOMATED_DERIV_MARKETS,
  discoverAccumulatorContractSpec,
  executeLiveTrade,
  getAccumulatorOpenContract,
  getLiveBalance,
  getTickHistory,
  sellAccumulatorContract,
  tickManager,
  waitForContractResult,
  type AccumulatorContractSpec,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import * as recoveryEngine from "./agents/recovery-engine";
import {
  ACCUMULATOR_DEFAULT_DURATION_TICKS,
  ACCUMULATOR_DEFAULT_TARGET_TICKS,
  ACCUMULATOR_MAX_DURATION_TICKS,
  ACCUMULATOR_MIN_DURATION_TICKS,
  ACCUMULATOR_MIN_HISTORY,
  ACCUMULATOR_MIN_STAKE,
  ACCUMULATOR_SCAN_HISTORY,
  ACCUMULATOR_GROWTH_RATES,
  accumulatorEntryGate,
  evaluateAccumulatorMarket,
  normalizeGrowthRate,
  rankAccumulatorCandidates,
  recoveryStakeForAccumulator,
  type AccumulatorCandidate,
  type AccumulatorGrowthRate,
} from "./accumulator-analysis";
import {
  acquireTradingOwnership,
  currentTradingOwner,
  hasTradingOwnership,
  releaseTradingOwnership,
  tradingOwnerLabel,
} from "./engine-arbiter";
import { createSessionScoped, getBrowserSessionId, runWithSessionId } from "./session";
import { registerLiveBot } from "./live-registry";

export const ACCUMULATOR_BOT_ID = "accumulators";
export const ACCUMULATOR_BOT_NAME = "Accumulator Edge Navigator";

export interface AccumulatorConfig {
  ownerSessionId?: string;
  symbol: string;
  displayName: string;
  marketMode: "locked" | "switching";
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  growthRate: number | "auto";
  targetTicks: number;
  durationTicks: number;
  /** The scan card is required: no unmeasured ACCU entry is accepted. */
  analysis: AccumulatorCandidate;
  rankedCandidates?: AccumulatorCandidate[];
}

export interface AccumulatorStatus {
  running: boolean;
  botId: string;
  botName: string;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  recoveryTargetProfit: number;
  recoveryRemainingTargetProfit: number;
  consecutiveRecoveryLosses: number;
  deepestLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  lastTrade?: {
    profit: number;
    ticks: number;
    closedEarly: boolean;
    knockedOut: boolean;
    market: string;
    growthRate: number;
    at: number;
  };
  marketMode?: "locked" | "switching";
  gate?: {
    ready: boolean;
    reason: string;
    shockRatio: number;
    recentMove: number;
  };
  accumulatorGate?: {
    ready: boolean;
    reason: string;
    shockRatio: number;
    recentMove: number;
  };
  lastAccumulatorTrade?: {
    profit: number;
    ticks: number;
    closedEarly: boolean;
    knockedOut: boolean;
    market: string;
    growthRate: number;
    at: number;
  };
  accumulator?: {
    symbol: string;
    displayName: string;
    growthRate: number;
    targetTicks: number;
    durationTicks: number;
    compoundedFactor: number;
    barrierPct: number;
    barrierSource: string;
    survival: number;
    survivalLower: number;
    breakEvenSurvival: number;
    expectedNetReturn: number;
    lowerExpectedNetReturn: number;
    knockoutProbability: number;
    regime: string;
    score: number;
    signals: string[];
  };
  config?: Omit<AccumulatorConfig, "ownerSessionId" | "analysis" | "rankedCandidates"> & { analysis?: AccumulatorCandidate };
  topMarkets?: AccumulatorCandidate[];
  message?: string;
}

export interface AccumulatorScanParams {
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  growthRate: number | "auto";
  targetTicks: number;
  durationTicks: number;
  minEdge?: number;
  minSurvivalMargin?: number;
}

export interface AccumulatorScanResult {
  suitable: boolean;
  best: AccumulatorCandidate | null;
  bestAvailable: AccumulatorCandidate | null;
  allScored: AccumulatorCandidate[];
  reason: string;
  marketsScanned: number;
  historyDepth: number;
  brokerDiscovery: "live" | "screening-fallback";
}

interface AccumulatorScanCache {
  expiresAt: number;
  candidates: AccumulatorCandidate[];
}

/**
 * Deployment is bound to a recent server-side scan. Keeping the cache keyed by
 * browser session prevents a client from changing the barrier/EV fields in a
 * JSON card and bypassing the measured-edge gate between Scan and Start.
 */
const ACCUMULATOR_SCAN_TTL_MS = 15 * 60 * 1000;
const scanCacheBySession = new Map<string, AccumulatorScanCache>();

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: AccumulatorConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  currentLossRun: number;
  deepestLossRun: number;
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  lastTrade?: AccumulatorStatus["lastTrade"];
  marketMode?: "locked" | "switching";
  gate?: AccumulatorStatus["accumulatorGate"];
  message?: string;
  stopRequested: boolean;
  activeCandidate: AccumulatorCandidate | null;
  rankedCandidates: AccumulatorCandidate[];
}

function freshSession(): SessionState {
  return {
    running: false,
    sessionId: null,
    config: null,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    currentStake: 0,
    currentLossRun: 0,
    deepestLossRun: 0,
    consecutiveRecoveryLosses: 0,
    stopRequested: false,
    activeCandidate: null,
    rankedCandidates: [],
  };
}

const { state: session, replace: replaceSession } = createSessionScoped<SessionState>(freshSession);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function nextPriceFor(symbol: string, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (price: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      tickManager.off("tick", onTick);
      resolve(price);
    };
    const onTick = (tick: { symbol: string; price: number }) => {
      if (tick.symbol === symbol && Number.isFinite(tick.price)) finish(tick.price);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    tickManager.on("tick", onTick);
  });
}

function candidateForStatus(candidate: AccumulatorCandidate | null): AccumulatorStatus["accumulator"] {
  if (!candidate) return undefined;
  return {
    symbol: candidate.symbol,
    displayName: candidate.displayName,
    growthRate: candidate.growthRate,
    targetTicks: candidate.targetTicks,
    durationTicks: candidate.durationTicks,
    compoundedFactor: roundMoney(candidate.compoundedFactor),
    barrierPct: candidate.barrierPct,
    barrierSource: candidate.barrierSource,
    survival: candidate.survivalProbability,
    survivalLower: candidate.survivalLower,
    breakEvenSurvival: candidate.breakEvenSurvival,
    expectedNetReturn: candidate.expectedNetReturn,
    lowerExpectedNetReturn: candidate.lowerExpectedNetReturn,
    knockoutProbability: candidate.knockoutProbability,
    regime: candidate.regime,
    score: candidate.score,
    signals: candidate.signals.slice(0, 8),
  };
}

function broadcast(): void {
  const owner = session.config?.ownerSessionId;
  if (owner) broadcastSSE("bot_update", getStatus(), owner);
}

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): AccumulatorStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const publicConfig = cfg
    ? {
        symbol: cfg.symbol,
        displayName: cfg.displayName,
        marketMode: cfg.marketMode,
        stake: cfg.stake,
        stopLoss: cfg.stopLoss,
        takeProfit: cfg.takeProfit,
        maxRecoverySteps: cfg.maxRecoverySteps,
        growthRate: cfg.growthRate,
        targetTicks: cfg.targetTicks,
        durationTicks: cfg.durationTicks,
        analysis: cfg.analysis,
      }
    : undefined;
  return {
    running: session.running,
    botId: ACCUMULATOR_BOT_ID,
    botName: ACCUMULATOR_BOT_NAME,
    sessionId: session.sessionId,
    totalProfit: roundMoney(session.totalProfit),
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    currentStake: roundMoney(session.currentStake),
    inRecovery: rec.inRecovery,
    recoveryStep: rec.recoveryStep,
    unrecoveredAmount: roundMoney(rec.unrecoveredAmount),
    recoveryTargetProfit: roundMoney(rec.targetProfit),
    recoveryRemainingTargetProfit: roundMoney(rec.remainingTargetProfit),
    consecutiveRecoveryLosses: session.consecutiveRecoveryLosses,
    deepestLossRun: session.deepestLossRun,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    lastTrade: session.lastTrade,
    marketMode: session.marketMode,
    gate: undefined,
    accumulatorGate: session.gate,
    accumulator: candidateForStatus(session.activeCandidate),
    lastAccumulatorTrade: session.lastTrade,
    config: publicConfig,
    topMarkets: session.rankedCandidates.slice(0, 8),
    message: session.message,
  };
}

function fallbackCandidate(symbol: string, displayName: string, params: AccumulatorScanParams): AccumulatorCandidate | null {
  const prices = tickManager.getTicks(symbol, ACCUMULATOR_SCAN_HISTORY);
  const rows = evaluateAccumulatorMarket({ symbol, displayName, prices }, {
    growthRate: params.growthRate,
    targetTicks: params.targetTicks,
    durationTicks: params.durationTicks,
    minEdge: params.minEdge,
    minSurvivalMargin: params.minSurvivalMargin,
    bootstrapPaths: 160,
  });
  return rows[0] ?? null;
}

async function pricesForScan(symbol: string): Promise<number[]> {
  const buffered = tickManager.getTicks(symbol, ACCUMULATOR_SCAN_HISTORY);
  if (buffered.length >= ACCUMULATOR_MIN_HISTORY) return buffered;
  return getTickHistory(symbol, ACCUMULATOR_SCAN_HISTORY);
}

export async function scanAccumulatorMarkets(
  ownerSessionId: string | undefined,
  params: AccumulatorScanParams,
): Promise<AccumulatorScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS;
  const all: AccumulatorCandidate[] = [];
  let historyDepth = 0;
  let usedBrokerDiscovery = false;
  const health = tickManager.getTickHealth();

  // Account-scoped discovery: contracts_for on an authenticated socket
  // returns the limits that apply to THIS account's buys.
  let token: string | undefined;
  let accountId: string | undefined;
  let currency = "USD";
  if (ownerSessionId) {
    const accounts = await db.select().from(accountsTable)
      .where(eq(accountsTable.sessionId, ownerSessionId)).limit(1).catch(() => [] as any[]);
    token = accounts[0]?.bearerToken ?? accounts[0]?.token ?? null;
    accountId = accounts[0]?.derivAccountId ?? accounts[0]?.loginId ?? undefined;
    currency = accounts[0]?.currency ?? "USD";
  }

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", {
      botId: ACCUMULATOR_BOT_ID,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned: i,
      total: markets.length,
    }, ownerSessionId);

    const prices = await pricesForScan(market.symbol);
    historyDepth = Math.max(historyDepth, prices.length);
    if (prices.length < ACCUMULATOR_MIN_HISTORY) {
      await sleep(0);
      continue;
    }

    let spec: AccumulatorContractSpec = {
      symbol: market.symbol,
      available: true,
      source: "fallback",
      growthRates: [...ACCUMULATOR_GROWTH_RATES],
    };
    // In simulated mode there is no reason to spend 10 seconds per market on
    // a public broker metadata request. Live mode discovers account/broker
    // limits and the engine clamps to them before it can deploy. The account
    // credentials are passed through so account-scoped duration limits are
    // read, not just the public catalogue view.
    if (!health.usingSimulated) {
      spec = await discoverAccumulatorContractSpec(market.symbol, currency, token, accountId);
      if (spec.source === "broker") usedBrokerDiscovery = true;
    }
    if (!spec.available) {
      continue;
    }

    const rows = evaluateAccumulatorMarket({
      symbol: market.symbol,
      displayName: market.displayName,
      prices,
      brokerBarrierPct: spec.barrierPct,
      brokerMaxTicks: spec.maxDurationTicks,
      brokerMinTicks: spec.minDurationTicks,
      brokerMaxTicksByGrowth: spec.maxTicksByGrowth,
    }, {
      growthRate: params.growthRate,
      growthRates: spec.growthRates,
      targetTicks: params.targetTicks,
      durationTicks: params.durationTicks,
      minEdge: params.minEdge,
      minSurvivalMargin: params.minSurvivalMargin,
      bootstrapPaths: 180,
    });
    all.push(...rows);
    await sleep(0);
  }

  const ranked = rankAccumulatorCandidates(all);
  const bestAvailable = ranked[0] ?? null;
  const best = ranked.find((candidate) => candidate.deployable) ?? null;
  const suitable = best !== null;
  const reason = suitable
    ? `${best!.displayName} · ${(best!.growthRate * 100).toFixed(0)}% growth · ${Math.round(best!.survivalLower * 100)}% conservative survival vs ${Math.round(best!.breakEvenSurvival * 100)}% break-even · lower EV ${(best!.lowerExpectedNetReturn * 100).toFixed(2)}%`
    : bestAvailable
      ? `No ACCU candidate cleared the conservative survival and lower-EV gates. Best available: ${bestAvailable.displayName} · ${bestAvailable.reason}`
      : "No market has enough price history or ACCU availability yet — keep the feed warm and re-scan.";

  broadcastSSE("bot_scan_progress", {
    botId: ACCUMULATOR_BOT_ID,
    scanning: null,
    symbol: null,
    scanned: markets.length,
    total: markets.length,
  }, ownerSessionId);

  if (ownerSessionId) {
    scanCacheBySession.set(ownerSessionId, {
      expiresAt: Date.now() + ACCUMULATOR_SCAN_TTL_MS,
      candidates: ranked,
    });
  }

  return {
    suitable,
    best,
    bestAvailable,
    allScored: ranked.slice(0, 24),
    reason,
    marketsScanned: markets.length,
    historyDepth,
    brokerDiscovery: usedBrokerDiscovery ? "live" : "screening-fallback",
  };
}

function validCandidate(candidate: AccumulatorCandidate | undefined, symbol: string): boolean {
  if (!candidate || candidate.symbol !== symbol || !candidate.deployable) return false;
  return ACCUMULATOR_GROWTH_RATES.some((g) => Math.abs(g - Number(candidate.growthRate)) < 1e-9)
    && Number(candidate.targetTicks) >= 1
    && Number(candidate.durationTicks) >= Number(candidate.targetTicks);
}

export async function startSession(config: AccumulatorConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "An Accumulator session is already active — stop it first" };
  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return { ok: false, error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is trading this account. Stop it first — one ledger, one executor.` };
  }
  const fail = (error: string) => {
    releaseTradingOwnership("bots");
    return { ok: false as const, error };
  };
  if (!isFinitePositive(config.stake) || config.stake < ACCUMULATOR_MIN_STAKE) return fail("Minimum ACCU stake is $0.35");
  if (!isFinitePositive(config.stopLoss) || !isFinitePositive(config.takeProfit)) return fail("Take profit and stop loss must be positive");
  if (config.marketMode !== "locked" && config.marketMode !== "switching") return fail("marketMode must be locked or switching");
  if (!AUTOMATED_DERIV_MARKETS.some((market) => market.symbol === config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  if (!validCandidate(config.analysis, config.symbol)) return fail("Run the ACCU analysis first — only a measured positive-edge candidate may deploy");
  if (config.durationTicks < ACCUMULATOR_MIN_DURATION_TICKS || config.durationTicks > ACCUMULATOR_MAX_DURATION_TICKS) return fail("durationTicks is outside the broker-safe 1–230 tick range");
  if (config.targetTicks < 1 || config.targetTicks >= config.durationTicks) return fail("targetTicks must be shorter than the contract duration");

  const scan = config.ownerSessionId ? scanCacheBySession.get(config.ownerSessionId) : undefined;
  if (!scan || scan.expiresAt < Date.now()) {
    if (config.ownerSessionId) scanCacheBySession.delete(config.ownerSessionId);
    return fail("Run the ACCU analysis in this browser session before deploying");
  }
  const measured = scan.candidates.find((candidate) =>
    candidate.symbol === config.analysis.symbol
    && Math.abs(candidate.growthRate - config.analysis.growthRate) < 1e-9
    && candidate.targetTicks === config.analysis.targetTicks
    && candidate.durationTicks === config.analysis.durationTicks,
  );
  if (!measured || !validCandidate(measured, config.symbol)) {
    return fail("The deployment card is not the measured candidate from the latest scan — re-scan before starting");
  }

  // Ignore client-supplied telemetry/ranked rows after the identity match. The
  // engine trades the server's own candidate and server-ranked universe.
  const trustedConfig: AccumulatorConfig = {
    ...config,
    analysis: measured,
    rankedCandidates: scan.candidates,
  };
  const ranked = rankAccumulatorCandidates(scan.candidates);
  replaceSession({
    ...freshSession(),
    running: true,
    sessionId: `bot_accu_${Date.now()}`,
    config: trustedConfig,
    currentStake: trustedConfig.stake,
    currentMarket: trustedConfig.displayName,
    marketMode: trustedConfig.marketMode,
    activeCandidate: measured,
    rankedCandidates: ranked.length ? ranked : [measured],
    message: `🧮 ${trustedConfig.marketMode === "locked" ? "Locked" : "Switching"} on ${trustedConfig.displayName} · ${(measured.growthRate * 100).toFixed(0)}% growth · ${measured.targetTicks} target ticks · broker duration ${measured.durationTicks} ticks`,
  });
  broadcast();

  // Publish to the cross-session live registry (lib/live-registry.ts).
  registerLiveBot("accumulator", () => getStatus());

  const loopSessionId = trustedConfig.ownerSessionId ?? getBrowserSessionId();
  runWithSessionId(loopSessionId, () => runLoop({ ...trustedConfig, ownerSessionId: loopSessionId }).catch((err) => {
    logger.error({ err }, "Accumulator runLoop error");
    session.running = false;
    session.message = `⚠️ ${friendlyErrorMessage(err)}`;
    broadcast();
  }).finally(() => releaseTradingOwnership("bots")));

  return { ok: true };
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

interface Settlement {
  profit: number;
  won: boolean;
  ticks: number;
  closedEarly: boolean;
  knockedOut: boolean;
  entryPrice: number;
  exitPrice: number;
  contractId?: number;
}

function paperSettlement(
  symbol: string,
  stake: number,
  candidate: AccumulatorCandidate,
): Promise<Settlement> {
  return new Promise(async (resolve) => {
    const entry = tickManager.getLatestPrice(symbol) ?? 0;
    let previous = entry;
    let ticks = 0;
    let closedEarly = false;
    const barrier = Math.max(1e-9, Math.abs(Math.log1p(candidate.barrierPct)));
    while (session.running && !session.stopRequested && ticks < candidate.durationTicks) {
      const price = await nextPriceFor(symbol, 12_000);
      if (price === null) continue;
      const move = Math.abs(Math.log(Math.max(1e-12, price) / Math.max(1e-12, previous)));
      previous = price;
      ticks++;
      if (move >= barrier) {
        resolve({
          profit: -stake,
          won: false,
          ticks,
          closedEarly: false,
          knockedOut: true,
          entryPrice: entry,
          exitPrice: price,
        });
        return;
      }
      const livePrices = tickManager.getTicks(symbol, 120);
      const gate = accumulatorEntryGate(livePrices, candidate);
      if (!gate.ready && (gate.shockRatio > 1.75 || gate.recentMove >= barrier * 0.65) && ticks >= 2) {
        closedEarly = true;
        const value = stake * Math.pow(1 + candidate.growthRate, ticks);
        resolve({
          profit: value - stake,
          won: value > stake,
          ticks,
          closedEarly,
          knockedOut: false,
          entryPrice: entry,
          exitPrice: price,
        });
        return;
      }
      if (ticks >= candidate.targetTicks) {
        const value = stake * Math.pow(1 + candidate.growthRate, ticks);
        resolve({
          profit: value - stake,
          won: value > stake,
          ticks,
          closedEarly: false,
          knockedOut: false,
          entryPrice: entry,
          exitPrice: price,
        });
        return;
      }
    }
    // A stop request cannot leave a paper trade hanging; settle at the last
    // observed compounded value, as a local early close would.
    const value = stake * Math.pow(1 + candidate.growthRate, ticks);
    resolve({
      profit: value - stake,
      won: value > stake,
      ticks,
      closedEarly: true,
      knockedOut: false,
      entryPrice: entry,
      exitPrice: previous,
    });
  });
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function liveSettlement(
  token: string,
  accountId: string,
  currency: string,
  symbol: string,
  stake: number,
  candidate: AccumulatorCandidate,
  buyParams: { growthRate?: number; durationTicks?: number } = {},
): Promise<Settlement> {
  // Self-healed params win over the scan-time candidate: the broker is the
  // ground truth for what it accepts.
  const effDuration = Math.max(1, Math.round(buyParams.durationTicks ?? candidate.durationTicks));
  const effGrowth = buyParams.growthRate ?? candidate.growthRate;
  // A contract shortened by the heal compounds for fewer ticks, so it earns
  // proportionally less — scale the early-close target to stay reachable
  // (otherwise the monitor would only ever see a natural expiry).
  const scale = Math.min(1, effDuration / candidate.durationTicks);
  const targetProfit = stake * candidate.netReturnMultiplier * scale;
  const opened = await executeLiveTrade(token, {
    symbol,
    contractType: "ACCU",
    stake: roundMoney(stake),
    duration: effDuration,
    durationUnit: "t",
    currency,
    accountId,
    growthRate: effGrowth,
    // Exchange-side TP is a first line of defence. The local monitor repeats
    // the check because broker fills can race the quote and the live gate.
    takeProfit: roundMoney(targetProfit),
  });
  const deadline = Date.now() + Math.max(45_000, effDuration * 3_000 + 15_000);
  let ticks = 0;
  let lastPrice = opened.buyPrice;
  while (Date.now() < deadline && session.running && !session.stopRequested) {
    const price = await nextPriceFor(symbol, 12_000);
    if (price !== null) {
      lastPrice = price;
      ticks++;
    }
    const state = await getAccumulatorOpenContract(token, accountId, opened.contractId);
    if (state) {
      const rawStatus = String(state.status ?? "").toLowerCase();
      const isSold = Boolean(state.is_sold) || ["sold", "won", "lost", "expired"].includes(rawStatus);
      const profitNow = numberOr(state.profit, Number.NaN);
      const gate = accumulatorEntryGate(tickManager.getTicks(symbol, 160), candidate);
      const barrierNear = gate.recentMove >= Math.abs(Math.log1p(candidate.barrierPct)) * 0.65;
      const shouldClose = !isSold && (
        (Number.isFinite(profitNow) && profitNow >= targetProfit && state.is_valid_to_sell !== false)
        || (!gate.ready && (gate.shockRatio > 1.8 || barrierNear) && state.is_valid_to_sell !== false)
      );
      if (shouldClose) {
        const sold = await sellAccumulatorContract(token, accountId, opened.contractId);
        const soldState = sold?.sold_contract ?? sold ?? state;
        const soldProfit = numberOr(soldState?.profit, Number.isFinite(profitNow) ? profitNow : 0);
        const sellPrice = numberOr(soldState?.sell_price ?? soldState?.bid_price, opened.buyPrice + soldProfit);
        return {
          profit: soldProfit,
          won: soldProfit > 0,
          ticks,
          closedEarly: true,
          knockedOut: soldProfit <= -stake + 1e-8,
          entryPrice: opened.buyPrice,
          exitPrice: sellPrice,
          contractId: opened.contractId,
        };
      }
      if (isSold) {
        const finalProfit = numberOr(state.profit, numberOr(state.sell_price, 0) - numberOr(state.buy_price, opened.buyPrice));
        return {
          profit: finalProfit,
          won: finalProfit > 0,
          ticks: numberOr(state.tick_passed ?? state.tick_count, ticks),
          closedEarly: numberOr(state.tick_passed, effDuration) < effDuration,
          knockedOut: finalProfit <= -stake + 1e-8,
          entryPrice: opened.buyPrice,
          exitPrice: numberOr(state.sell_price ?? state.bid_price, opened.buyPrice + finalProfit),
          contractId: opened.contractId,
        };
      }
    }
    await sleep(100);
  }

  // Settlement fallback uses the same pooled account socket and is idempotent
  // if the exchange-side TP or a knockout settled while we were polling.
  const result = await waitForContractResult(token, accountId, opened.contractId, 15_000);
  return {
    profit: result.profit,
    won: result.won,
    ticks,
    closedEarly: ticks < candidate.durationTicks,
    knockedOut: result.profit <= -stake + 1e-8,
    entryPrice: result.entrySpot || opened.buyPrice,
    exitPrice: result.sellPrice,
    contractId: result.contractId,
  };
}

async function trySwitch(
  config: AccumulatorConfig,
  current: AccumulatorCandidate,
  ownerSessionId: string,
): Promise<AccumulatorCandidate | null> {
  if (config.marketMode !== "switching") return null;
  const alternatives = session.rankedCandidates.filter((c) => c.symbol !== current.symbol && c.deployable).slice(0, 10);
  if (!alternatives.length) return null;

  const scored: AccumulatorCandidate[] = [];
  for (const option of alternatives) {
    const prices = tickManager.getTicks(option.symbol, ACCUMULATOR_SCAN_HISTORY);
    if (prices.length < 40) continue;
    const refreshed = evaluateAccumulatorMarket({
      symbol: option.symbol,
      displayName: option.displayName,
      prices,
      brokerBarrierPct: option.barrierPct,
      brokerMaxTicks: option.durationTicks,
      brokerMinTicks: ACCUMULATOR_MIN_DURATION_TICKS,
    }, {
      growthRate: option.growthRate,
      growthRates: [option.growthRate],
      targetTicks: option.targetTicks,
      durationTicks: option.durationTicks,
      minEdge: 0.01,
      minSurvivalMargin: 0.015,
      bootstrapPaths: 120,
    })[0];
    if (refreshed) scored.push(refreshed);
  }
  const best = rankAccumulatorCandidates(scored).find((c) => c.deployable && c.regime !== "hot");
  const currentFresh = evaluateAccumulatorMarket({
    symbol: current.symbol,
    displayName: current.displayName,
    prices: tickManager.getTicks(current.symbol, ACCUMULATOR_SCAN_HISTORY),
    brokerBarrierPct: current.barrierPct,
    brokerMaxTicks: current.durationTicks,
    brokerMinTicks: ACCUMULATOR_MIN_DURATION_TICKS,
  }, {
    growthRate: current.growthRate,
    growthRates: [current.growthRate],
    targetTicks: current.targetTicks,
    durationTicks: current.durationTicks,
    minEdge: 0.01,
    minSurvivalMargin: 0.015,
    bootstrapPaths: 120,
  })[0] ?? current;
  if (!best || best.lowerExpectedNetReturn <= currentFresh.lowerExpectedNetReturn + 0.015) return null;

  session.message = `🔀 Switching ${current.displayName} → ${best.displayName}: lower-bound ACCU edge ${Math.round(currentFresh.lowerExpectedNetReturn * 100)}% → ${Math.round(best.lowerExpectedNetReturn * 100)}%`;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
  return best;
}

/** Mutable state of the broker duration self-heal ladder (per session). */
export interface AccuDurationHealState {
  /** Healed growth rate, once the ladder had to drop below the candidate's. */
  growthRate?: number;
  /** Per-growth-rate tick caps learned from broker rejections. */
  maxTicksByGrowth: Map<string, number>;
  /** How many rejections this ladder has absorbed. */
  healCount: number;
}

/** After this many absorbed rejections the ladder is exhausted and the
 *  failure falls through to the normal execution-strike handling. 10 covers
 *  a full 40%-step shrink from the 230-tick maximum (10 steps) plus the
 *  growth-rate drop. */
export const ACCUMULATOR_HEAL_LIMIT = 10;

/**
 * One step of the broker duration self-heal ladder.
 *
 * The exchange rejects an ACCU buy with "Invalid input (duration or
 * date_expiry) for this contract type (ACCU)" when the duration is outside
 * the growth-rate-specific tick window. The max ALLOWABLE ticks SHRINK as
 * the growth rate rises (5% allows far fewer ticks than 1%), and the public
 * contracts_for view does not always publish the per-rate cap — the buy
 * itself is the ground truth. Ladder:
 *   1. shorten the duration by 40% (floored at the broker minimum);
 *   2. if already at the floor, drop the growth rate one step (its cap is
 *      looser); the current — already minimal — duration stays.
 * Pure on purpose: the session loop owns the state and applies the plan.
 * Returns null when the ladder is exhausted (duration at the floor AND
 * growth at the lowest step), so the caller can fall back to counting a
 * strike — a genuinely unbuyable configuration still stops the session.
 */
export function planAccumulatorDurationHeal(
  heal: AccuDurationHealState,
  currentGrowthRate: number,
  currentDurationTicks: number,
): { growthRate: number; maxTicks?: number } | null {
  if (heal.healCount >= ACCUMULATOR_HEAL_LIMIT) return null;
  heal.healCount++;
  const minD = Math.max(1, ACCUMULATOR_MIN_DURATION_TICKS);
  const shrunken = Math.round(currentDurationTicks * 0.6);
  if (shrunken >= minD && shrunken < currentDurationTicks) {
    return { growthRate: currentGrowthRate, maxTicks: shrunken };
  }
  const ladder = [...ACCUMULATOR_GROWTH_RATES].sort((a, b) => b - a);
  const idx = ladder.findIndex((g) => Math.abs(g - currentGrowthRate) < 1e-9);
  if (idx >= 0 && idx < ladder.length - 1) {
    return { growthRate: ladder[idx + 1]! };
  }
  return null;
}

async function runLoop(config: AccumulatorConfig): Promise<void> {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely";
    broadcast();
    return;
  }

  let accounts = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, ownerSessionId),
    eq(accountsTable.isActive, true),
  )).limit(1);
  if (!accounts.length) accounts = await db.select().from(accountsTable).where(eq(accountsTable.sessionId, ownerSessionId)).limit(1);
  const settings = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
  recoveryEngine.setPersistenceSession(ownerSessionId);
  const paperTradeMode = settings.length ? Boolean((settings[0] as any).paperTradeMode ?? false) : true;
  const token = accounts[0]?.bearerToken ?? accounts[0]?.token ?? null;
  const accountId = accounts[0]?.derivAccountId ?? accounts[0]?.loginId ?? "";
  const currency = accounts[0]?.currency ?? "USD";
  const isLive = !paperTradeMode && Boolean(token) && Boolean(accountId);
  const maxStake = numberOr(settings[0] ? (settings[0] as any).maxTradeStake : 500, 500);
  const markup = numberOr(settings[0] ? (settings[0] as any).botRecoveryMarkup : 10, 10);
  let availableBalance = numberOr(accounts[0]?.balance, Number.POSITIVE_INFINITY);
  let candidate = config.analysis;
  let symbol = candidate.symbol;
  let displayName = candidate.displayName;
  let waits = 0;
  let executionErrors = 0;

  // ── Broker duration self-heal ────────────────────────────────────────────
  // The exchange rejects an ACCU buy with "Invalid input (duration or
  // date_expiry) for this contract type (ACCU)" when the duration is outside
  // the growth-rate-specific tick window: the max ALLOWABLE ticks shrink as
  // the growth rate rises (5% allows far fewer ticks than 1%), and the
  // public contracts_for view does not always publish the per-rate cap. The
  // buy itself is the ground truth, so on that rejection we re-clamp —
  // shorter duration first, then a lower growth rate (whose cap is looser) —
  // and RETRY without counting a strike. Healed caps persist for the rest
  // of the session (and are remembered per growth rate), so the first heal
  // is the only expensive one.
  const heal: AccuDurationHealState = { maxTicksByGrowth: new Map(), healCount: 0 };

  const effectiveBuyParams = () => {
    const growthRate = heal.growthRate ?? candidate.growthRate;
    const known = heal.maxTicksByGrowth.get(String(growthRate));
    const durationTicks = known !== undefined
      ? Math.max(1, Math.min(candidate.durationTicks, Math.round(known)))
      : candidate.durationTicks;
    return { growthRate, durationTicks };
  };
  const applyDurationHeal = (): boolean => {
    const { growthRate, durationTicks } = effectiveBuyParams();
    const plan = planAccumulatorDurationHeal(heal, growthRate, durationTicks);
    if (!plan) return false;
    if (plan.growthRate !== growthRate) heal.growthRate = plan.growthRate;
    if (plan.maxTicks !== undefined) heal.maxTicksByGrowth.set(String(plan.growthRate), plan.maxTicks);
    return true;
  };

  while (session.running && !session.stopRequested) {
    try {
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false;
        session.message = `⛔ Stopped — ${owner ? tradingOwnerLabel(owner) : "another engine"} owns this account's ledger`;
        broadcast();
        return;
      }
      session.activeCandidate = candidate;
      session.currentMarket = displayName;
      const health = tickManager.getTickHealth();
      if (!health.usingSimulated && health.liveSymbols === 0) {
        session.message = "Stabilizing price feed — no ACCU decision made";
        broadcast();
        await sleep(1000);
        continue;
      }

      const price = await nextPriceFor(symbol, 12_000);
      if (price === null) {
        session.message = `Feed stalled on ${displayName} — refusing a blind accumulator entry`;
        broadcast();
        continue;
      }
      void price;
      const prices = tickManager.getTicks(symbol, ACCUMULATOR_SCAN_HISTORY);
      const gate = accumulatorEntryGate(prices, candidate);
      session.gate = gate;
      if (!gate.ready) {
        waits++;
        if (config.marketMode === "switching" && waits >= 12) {
          const moved = await trySwitch(config, candidate, ownerSessionId);
          if (moved) {
            candidate = moved;
            symbol = moved.symbol;
            displayName = moved.displayName;
            waits = 0;
            session.message = `🔀 Switched to ${displayName}; waiting for a clean ACCU entry`;
            broadcast();
            continue;
          }
        }
        // A locked market is allowed to pause, never to average into a hot
        // regime indefinitely. If no alternative has a measured lower-bound
        // edge, stop and require a fresh scan rather than silently waiting
        // while the original survival estimate becomes stale.
        if (waits >= 36) {
          session.running = false;
          session.message = `🛑 ${displayName}: ACCU entry health stayed degraded for ${waits} ticks — session stopped; re-scan before redeploying`;
          broadcast();
          return;
        }
        session.message = `⏸️ ${displayName}: ${gate.reason}${config.marketMode === "locked" ? " · locked, no rotation" : ""}`;
        broadcast();
        continue;
      }
      waits = 0;

      const rec = recoveryEngine.getState();
      const recovery = rec.inRecovery;
      const recoveryStake = recoveryStakeForAccumulator(rec.unrecoveredAmount, candidate, markup, maxStake, availableBalance);
      const stake = recovery
        ? Math.max(ACCUMULATOR_MIN_STAKE, Math.min(maxStake, recoveryStake || config.stake))
        : config.stake;
      if (!Number.isFinite(stake) || stake < ACCUMULATOR_MIN_STAKE || (Number.isFinite(maxStake) && stake > maxStake)) {
        session.running = false;
        session.message = "🛑 ACCU stake cannot satisfy broker minimum/cap while preserving the recovery ledger";
        broadcast();
        return;
      }
      // What the exchange will actually be asked for (scan candidate, clamped
      // by any broker duration heal from earlier rounds of this session).
      const buyParams = effectiveBuyParams();
      session.currentStake = stake;
      session.currentContractType = `ACCU ${(buyParams.growthRate * 100).toFixed(0)}% · ${buyParams.durationTicks}t`;
      session.message = `${recovery ? "🎯 Recovery" : "⚡ Entry"} ${displayName} · ${(buyParams.growthRate * 100).toFixed(0)}% growth · $${stake.toFixed(2)} · survival floor ${Math.round(candidate.survivalLower * 100)}%`;
      broadcast();

      const journal = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol,
        displayName,
        contractType: "ACCU",
        stake: String(roundMoney(stake)),
        direction: "hold",
        status: "open",
        aiConfidence: String(Math.round(candidate.survivalLower * 100)),
        aiRiskScore: String(Math.round(candidate.knockoutProbability * 100)),
        isAutonomous: true,
        agentReasoning: `${isLive ? "" : "[PAPER] "}[ACCUMULATOR] ${recovery ? "RECOVERY " : ""}${candidate.reason} · target ${candidate.targetTicks} ticks · duration ${buyParams.durationTicks} ticks @ ${(buyParams.growthRate * 100).toFixed(0)}% growth · compounded ${candidate.compoundedFactor.toFixed(3)}× · full-stake knockout risk ${Math.round(candidate.knockoutProbability * 100)}%`,
        duration: buyParams.durationTicks,
        durationUnit: "t",
      }).returning();
      const row = journal[0];

      let settlement: Settlement;
      try {
        settlement = isLive
          ? await liveSettlement(token!, accountId, currency, symbol, stake, candidate, buyParams)
          : await paperSettlement(symbol, stake, candidate);
      } catch (err) {
        const rawErrText = err instanceof Error ? err.message : String(err);
        // "Invalid input (duration or date_expiry) for this contract type
        // (ACCU)." — the broker's per-growth-rate tick window. This is
        // RECOVERABLE: re-clamp and retry; it must not burn a strike or
        // stop a session (that is exactly the failure the bot died from).
        if (isLive && /invalid input\s*\(duration|duration or date_expiry/i.test(rawErrText) && applyDurationHeal()) {
          const { growthRate, durationTicks } = effectiveBuyParams();
          session.message = `🔁 ACCU broker duration heal #${heal.healCount} → retry at ${durationTicks} ticks @ ${(growthRate * 100).toFixed(0)}% growth (${friendlyErrorMessage(err, { max: 120 })})`;
          broadcast();
          await sleep(500);
          continue;
        }
        await db.update(tradesTable).set({
          status: "error",
          profit: "0",
          payout: "0",
          closedAt: new Date(),
          agentReasoning: `${isLive ? "" : "[PAPER] "}[ACCUMULATOR] execution failed safely: ${friendlyErrorMessage(err, { max: 220 })}`,
        }).where(eq(tradesTable.id, row!.id)).catch(() => {});
        executionErrors++;
        if (executionErrors >= 3) {
          const failedAttempts = executionErrors;
          if (config.marketMode === "switching") {

            const moved = await trySwitch(config, candidate, ownerSessionId);
            if (moved) {
              candidate = moved;
              symbol = moved.symbol;
              displayName = moved.displayName;
              executionErrors = 0;
              session.message = `🔀 Broker rejected ${failedAttempts} ACCU attempts; switched to ${displayName}`;
              broadcast();
              await sleep(250);
              continue;
            }
          }
          session.running = false;
          session.message = `🛑 ACCU execution failed ${executionErrors} times (${friendlyErrorMessage(err)}). Session stopped; re-scan or verify broker limits.`;
          broadcast();
          return;
        }
        session.message = `🔁 ACCU execution retry ${executionErrors}/3 — ${friendlyErrorMessage(err)}`;
        broadcast();
        await sleep(1500);
        continue;
      }

      executionErrors = 0;
      const profit = roundMoney(settlement.profit);
      const won = profit > 0;
      const knockout = settlement.knockedOut || profit <= -stake + 1e-8;
      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, "ACCU", candidate.compoundedFactor);
      session.tradeCount++;
      session.totalProfit = roundMoney(session.totalProfit + profit);
      if (won) {
        session.winCount++;
        session.currentLossRun = 0;
        session.consecutiveRecoveryLosses = 0;
        session.lastResult = "won";
      } else {
        session.lossCount++;
        session.currentLossRun++;
        session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun);
        if (recovery) session.consecutiveRecoveryLosses++;
        session.lastResult = "lost";
      }
      session.lastTrade = {
        profit,
        ticks: settlement.ticks,
        closedEarly: settlement.closedEarly,
        knockedOut: knockout,
        market: displayName,
        growthRate: candidate.growthRate,
        at: Date.now(),
      };
      await db.update(tradesTable).set({
        status: won ? "won" : "lost",
        profit: String(profit),
        payout: String(roundMoney(stake + profit)),
        entryPrice: String(settlement.entryPrice),
        exitPrice: String(settlement.exitPrice),
        closedAt: new Date(),
        agentReasoning: `${isLive ? "" : "[PAPER] "}[ACCUMULATOR] ${knockout ? "KNOCKOUT — full stake lost" : settlement.closedEarly ? "EARLY CLOSE — current compounded value locked" : "TARGET TICKS SETTLED"} · ${(candidate.growthRate * 100).toFixed(0)}% · ${settlement.ticks} ticks · net ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}`,
      }).where(eq(tradesTable.id, row!.id)).catch(() => {});

      if (!isLive && Number.isFinite(availableBalance)) availableBalance = Math.max(0, availableBalance + profit);
      if (isLive) {
        try {
          const balance = await getLiveBalance(token!, accountId);
          if (balance !== null) {
            availableBalance = balance;
            if (accounts[0]) await db.update(accountsTable).set({ balance: String(balance), updatedAt: new Date() }).where(eq(accountsTable.id, accounts[0].id));
          }
        } catch { /* balance telemetry is best-effort */ }
      }
      broadcast();

      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Accumulator take-profit reached: +$${session.totalProfit.toFixed(2)} — session stopped safely`;
        broadcast();
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Accumulator stop-loss reached: $${session.totalProfit.toFixed(2)} — session stopped before another knockout risk`;
        broadcast();
        return;
      }
      if (session.consecutiveRecoveryLosses > config.maxRecoverySteps) {
        session.running = false;
        session.message = `🛑 Recovery breaker: ${session.consecutiveRecoveryLosses} consecutive ACCU losses exceed the ${config.maxRecoverySteps}-step budget`;
        broadcast();
        return;
      }

      if (config.marketMode === "switching") {
        const moved = await trySwitch(config, candidate, ownerSessionId);
        if (moved) {
          candidate = moved;
          symbol = moved.symbol;
          displayName = moved.displayName;
        }
      }
    } catch (err) {
      logger.warn({ err }, "Accumulator loop iteration failed");
      session.message = `⚠️ ACCU paused safely — ${friendlyErrorMessage(err)}`;
      broadcast();
      await sleep(1200);
    }
  }
}

export function stopSession(): void {
  session.stopRequested = true;
  session.running = false;
  session.message = "Accumulator session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
}

export function validateAccumulatorConfig(body: any): { ok: true; params: AccumulatorScanParams } | { ok: false; error: string } {
  const growthRate = body?.growthRate === "auto" || body?.growthRate === undefined
    ? "auto"
    : Number(body.growthRate);
  if (growthRate !== "auto" && !ACCUMULATOR_GROWTH_RATES.some((g) => Math.abs(g - growthRate) < 1e-9)) {
    return { ok: false, error: "growthRate must be auto or one of 0.01, 0.02, 0.03, 0.04, 0.05" };
  }
  const stake = Number(body?.stake);
  const takeProfit = Number(body?.takeProfit);
  const stopLoss = Number(body?.stopLoss);
  if (!Number.isFinite(stake) || stake < ACCUMULATOR_MIN_STAKE) return { ok: false, error: "stake must be ≥ 0.35" };
  if (!Number.isFinite(takeProfit) || takeProfit <= 0) return { ok: false, error: "takeProfit must be positive" };
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) return { ok: false, error: "stopLoss must be positive" };
  const durationTicks = Math.max(ACCUMULATOR_MIN_DURATION_TICKS, Math.min(ACCUMULATOR_MAX_DURATION_TICKS, Math.round(Number(body?.durationTicks) || ACCUMULATOR_DEFAULT_DURATION_TICKS)));
  const targetTicks = Math.max(1, Math.min(durationTicks - 1, Math.round(Number(body?.targetTicks) || ACCUMULATOR_DEFAULT_TARGET_TICKS)));
  return {
    ok: true,
    params: {
      stake,
      takeProfit,
      stopLoss,
      maxRecoverySteps: Math.max(1, Math.min(10, Math.round(Number(body?.maxRecoverySteps) || 3))),
      growthRate: normalizeGrowthRate(growthRate),
      targetTicks,
      durationTicks,
      minEdge: Number.isFinite(Number(body?.minEdge)) ? Number(body.minEdge) : 0.01,
      minSurvivalMargin: Number.isFinite(Number(body?.minSurvivalMargin)) ? Number(body.minSurvivalMargin) : 0.02,
    },
  };
}

export { ACCUMULATOR_GROWTH_RATES };
