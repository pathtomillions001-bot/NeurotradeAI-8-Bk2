/**
 * Echo Apex — session engine (the 11th AI bot, Matches only).
 *
 * Institutional-grade repeat-rhythm trader. The brain lives in
 * `./apex-analysis` (echo spectrum, Hawkes heat, suffix memory, log-pool
 * fusion, pacing valve, honest held-out walk-forward). This module is the
 * session shell and deliberately reuses the same proven infrastructure as the
 * other bots with zero behaviour changes:
 *
 * - digits + execution: `tickManager` / `getDeepDigits` / `executeLiveTrade` /
 *   `waitForContractResult` from `./deriv` (1-tick DIGITMATCH contracts)
 * - the ONE shared debt-driven recovery ledger (`./agents/recovery-engine`,
 *   sized by `getBotRecoveryStake` — the identical formula every bot uses)
 * - the ONE single-executor arbiter (`./engine-arbiter`, owner `"bots"`)
 * - live payouts from `./recovery-payout`
 * - one owner-scoped SSE broadcast (`./sse`)
 *
 * Deploy flow (scan-first, like every dedicated bot):
 *   1. `scanForApex` measures all 19 automated digit markets and returns a
 *      ranked parameter card per market (verdict PRIME / VIABLE / THIN).
 *   2. the user picks LOCKED (this market, digit follows the fused argmax)
 *      or SWITCHING (migrate to whichever market measures best).
 *   3. `startSession` pins the measured card — no scan, no deploy.
 *
 * Live policy == simulated policy: the scan replayed `ApexPolicy.decide`
 * tick-by-tick on held-out data, and this loop calls that SAME method on each
 * genuinely new tick, exactly once per tick (the pacing valve adapts on every
 * call, so double-calling would mis-pace it). Anything that would make live
 * diverge from the scan (stale feed, starving history) is handled by waiting,
 * never by trading through it.
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
import { runWithSession } from "./session";
import {
  APEX_BREAKEVEN,
  APEX_MATCH_PAYOUT,
  ApexPolicy,
  scoreMarket,
  type ApexDecision,
  type ApexDiag,
  type ApexPace,
  type ApexParams,
  type ApexVerdict,
} from "./apex-analysis";

export const APEX_BOT_ID = "apex";
export const APEX_BOT_NAME = "Echo Apex";
const APEX_CONTRACT_TYPE = "DIGITMATCH";

/** Digits re-read from the feed every scan/refit pass. */
const SCAN_DIGITS = 4500;
/** Re-measure cadence — live never trusts a stale fit for long. */
const REFIT_LOCKED_MS = 20_000;
const REFIT_SWITCHING_MS = 45_000;
/** Switching only migrates for a MEANINGFULLY better edge (anti-flip). */
const SWITCH_MARGIN = 0.01;
/** Rolling live health window (ticks). */
const HEALTH_WINDOW = 30;
/** Minimum digits before the live policy is allowed to exist. */
const MIN_LIVE_DIGITS = 120;

// ── Types ───────────────────────────────────────────────────────────────────

export interface ApexDeploySpec {
  pace: ApexPace;
  /** User-locked digit, when the AI is not picking. */
  digit?: number;
  aiDigit: boolean;
}

export interface ApexCandidate {
  symbol: string;
  displayName: string;
  digit: number;
  verdict: ApexVerdict;
  confidence: number;
  edgePerDollar: number;
  hitRate: number;
  hitRateLower: number;
  shots: number;
  fireRate: number;
  breakEven: number;
  payout: number;
  params: ApexParams;
  diag: ApexDiag;
  thinData: boolean;
}

export interface ApexScanResult {
  suitable: boolean;
  best: ApexCandidate | null;
  bestAvailable: ApexCandidate | null;
  allScored: ApexCandidate[];
  reason: string;
  pace: ApexPace;
  marketsScanned: number;
  historyDepth: number;
}

export interface ApexConfig {
  ownerSessionId?: string;
  spec: ApexDeploySpec;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  symbol: string;
  displayName: string;
  params: ApexParams;
  lockedAnalysis?: ApexCandidate;
}

export interface ApexDeployed {
  symbol: string;
  displayName: string;
  digit: number;
  verdict: string;
  confidence: number;
  edgePerDollar: number;
  hitRate: number;
  shots: number;
  breakEven: number;
  payout: number;
  fireRate: number;
}

export interface ApexWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  digit: number;
  p: number;
  bar: number;
  reason: string;
  switched: boolean;
  confidence: number;
  verdict: string;
  ticksWatched: number;
  fireRate: number;
  topDigits: Array<{ digit: number; p: number }>;
  echoLags: Array<{ lag: number; rate: number }>;
  heatDigit: number;
  heatRatio: number;
  memoryOrder: number;
}

export interface ApexStatus {
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
    pace: ApexPace;
    digit?: number;
    aiDigit: boolean;
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    marketMode: "locked" | "switching";
    lockedSymbol?: string;
  };
  apexDeployed?: ApexDeployed;
  apexWatch?: ApexWatch;
}

// ── Session state ───────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: ApexConfig | null;
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
  watch: ApexWatch;
  activeSymbol?: string;
  activeName?: string;
  activeRead?: ApexCandidate | null;
}

function freshWatch(): ApexWatch {
  return {
    phase: "watching",
    digit: 0,
    p: 0,
    bar: 0,
    reason: "",
    switched: false,
    confidence: 0,
    verdict: "—",
    ticksWatched: 0,
    fireRate: 0,
    topDigits: [],
    echoLags: [],
    heatDigit: 0,
    heatRatio: 1,
    memoryOrder: 0,
  };
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
    deepestLossRun: 0,
    currentLossRun: 0,
    stopRequested: false,
    watch: freshWatch(),
  };
}

let session: SessionState = freshSession();

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

function deployed(read: ApexCandidate | null | undefined): ApexDeployed | undefined {
  if (!read) return undefined;
  const num = (v: unknown, fallback = 0): number =>
    (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    symbol: read.symbol,
    displayName: read.displayName,
    digit: read.digit,
    verdict: read.verdict,
    confidence: num(read.confidence),
    edgePerDollar: num(read.edgePerDollar),
    hitRate: num(read.hitRate),
    shots: num(read.shots),
    breakEven: num(read.breakEven, APEX_BREAKEVEN),
    payout: num(read.payout, APEX_MATCH_PAYOUT),
    fireRate: num(read.fireRate),
  };
}

export function getStatus(): ApexStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  return {
    running: session.running,
    botId: cfg ? APEX_BOT_ID : null,
    botName: cfg ? APEX_BOT_NAME : null,
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
    config: cfg
      ? {
          pace: cfg.spec.pace,
          ...(cfg.spec.digit !== undefined ? { digit: cfg.spec.digit } : {}),
          aiDigit: cfg.spec.aiDigit,
          stake: cfg.stake,
          stopLoss: cfg.stopLoss,
          takeProfit: cfg.takeProfit,
          maxRecoverySteps: cfg.maxRecoverySteps,
          marketMode: cfg.marketMode,
          ...(cfg.lockedSymbol ? { lockedSymbol: cfg.lockedSymbol } : {}),
        }
      : undefined,
    apexDeployed: session.running ? deployed(session.activeRead) : undefined,
    apexWatch: session.running ? session.watch : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info({ botId: APEX_BOT_ID }, "Echo Apex session stopped");
}

// ── Pre-deploy scan ─────────────────────────────────────────────────────────

const VERDICT_RANK: Record<ApexVerdict, number> = { prime: 0, viable: 1, thin: 2 };

export async function scanForApex(
  ownerSessionId: string | undefined,
  spec: ApexDeploySpec,
): Promise<ApexScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const all: ApexCandidate[] = [];
  let deepest = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", {
      botId: APEX_BOT_ID,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned: i,
      total: markets.length,
    }, ownerSessionId);

    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, SCAN_DIGITS);
    } catch {
      digits = tickManager.getDigits(market.symbol, SCAN_DIGITS);
    }
    deepest = Math.max(deepest, digits.length);

    const read = scoreMarket(digits, spec.pace, {
      ...(spec.digit !== undefined ? { lockedDigit: spec.digit } : {}),
    });
    all.push({
      symbol: market.symbol,
      displayName: market.displayName,
      digit: read.digit,
      verdict: read.verdict,
      confidence: read.confidence,
      edgePerDollar: read.edgePerDollar,
      hitRate: read.hitRate,
      hitRateLower: read.hitRateLower,
      shots: read.shots,
      fireRate: read.fireRate,
      breakEven: read.breakEven,
      payout: read.payout,
      params: read.params,
      diag: read.diag,
      thinData: read.thinData,
    });
    await sleep(5);
  }

  const ranked = all.sort(
    (a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.edgePerDollar - a.edgePerDollar,
  );

  broadcastSSE("bot_scan_progress", {
    botId: APEX_BOT_ID,
    scanning: null,
    symbol: null,
    scanned: markets.length,
    total: markets.length,
  }, ownerSessionId);

  const best = ranked[0];
  if (!best || best.thinData) {
    return {
      suitable: false, best: null, bestAvailable: null, allScored: [], pace: spec.pace,
      marketsScanned: markets.length, historyDepth: deepest,
      reason: "Not enough history yet — the digit feed is still warming up. Wait a moment and re-scan.",
    };
  }

  const suitable = best.verdict !== "thin";
  const reason = suitable
    ? `${best.displayName} · Matches ${best.digit} — measured ${(best.hitRate * 100).toFixed(0)}% over ${best.shots} unseen shots (break-even ${(best.breakEven * 100).toFixed(1)}%).`
    : `No rhythm cleared the bar — best was ${best.displayName} (${best.verdict.toUpperCase()}, ${best.confidence}/100, ${(best.hitRate * 100).toFixed(0)}% over ${best.shots} unseen shots).`;

  return {
    suitable,
    best: suitable ? best : null,
    bestAvailable: best,
    allScored: ranked.filter(c => !c.thinData).slice(0, 12),
    reason,
    pace: spec.pace,
    marketsScanned: markets.length,
    historyDepth: deepest,
  };
}

// ── Session start ───────────────────────────────────────────────────────────

export async function startSession(config: ApexConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "Echo Apex is already active — stop it first" };

  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return {
      ok: false,
      error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account. Stop it first — only one engine may own the shared recovery ledger.`,
    };
  }

  const fail = (error: string) => { releaseTradingOwnership("bots"); return { ok: false as const, error }; };

  if (config.stake < 0.35) return fail("Minimum stake is $0.35");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  if (config.marketMode === "locked" && config.lockedSymbol !== config.symbol) {
    return fail("Locked mode pins the market you scanned — refusing a mismatched lock");
  }
  if (!config.params || !Number.isFinite(config.params.initBar) || !Number.isFinite(config.params.tau)) {
    return fail("Run the scan first — this bot only deploys a rhythm it has measured");
  }

  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  if (!market || !market.digitEnabled) return fail("This bot needs a digit-enabled market");

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_apex_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    currentContractType: APEX_CONTRACT_TYPE,
    activeSymbol: config.symbol,
    activeName: config.displayName,
    activeRead: config.lockedAnalysis ?? null,
    message: config.marketMode === "locked"
      ? `Locked on ${config.displayName} — the digit follows the fused rhythm.`
      : `Deployed on ${config.displayName} — will migrate when another market measures better.`,
  };
  if (session.activeRead) {
    session.watch.confidence = session.activeRead.confidence;
    session.watch.verdict = session.activeRead.verdict;
  }

  logger.info({
    botId: APEX_BOT_ID,
    pace: config.spec.pace,
    digit: config.spec.digit,
    marketMode: config.marketMode,
    symbol: config.symbol,
  }, "Echo Apex session starting");
  broadcast();

  runWithSession(config.ownerSessionId ?? "legacy", () =>
    runLoop(config).catch(err => {
      logger.error({ err }, "Echo Apex runLoop error");
      session.running = false;
      session.message = `⚠️ ${friendlyErrorMessage(err)}`;
      broadcast();
    }).finally(() => releaseTradingOwnership("bots")),
  );

  return { ok: true };
}

// ── Execution loop ──────────────────────────────────────────────────────────

/** Short, human one-liner for the console from a live decision. */
function waitReason(entry: ApexDecision, ticksWatched: number): string {
  if (ticksWatched < 30) return `warming the live lenses — ${ticksWatched}/30 ticks`;
  if (entry.p < APEX_BREAKEVEN) {
    return `below break-even (${(entry.p * 100).toFixed(1)}% vs ${(APEX_BREAKEVEN * 100).toFixed(1)}%) — valve standing down`;
  }
  return `waiting for the edge to clear the bar (${(entry.p * 100).toFixed(1)}% vs ${(entry.bar * 100).toFixed(1)}%)`;
}

function topDigitsOf(fused: number[], k = 3): Array<{ digit: number; p: number }> {
  return fused
    .map((p, digit) => ({ digit, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, k);
}

async function runLoop(config: ApexConfig) {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely";
    releaseTradingOwnership("bots");
    broadcast();
    return;
  }

  let accounts = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, ownerSessionId),
    eq(accountsTable.isActive, true),
  )).limit(1);
  if (accounts.length === 0) {
    accounts = await db.select().from(accountsTable)
      .where(eq(accountsTable.sessionId, ownerSessionId)).limit(1);
  }

  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
  recoveryEngine.setPersistenceSession(ownerSessionId);

  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;
  const token = accounts.length > 0 ? (accounts[0].bearerToken ?? accounts[0].token ?? null) : null;
  const currency = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0].maxTradeStake) : 500;
  let botRecoveryMarkup = settings.length > 0 ? Number((settings[0] as any).botRecoveryMarkup ?? 10) : 10;
  let availableBalance = accounts.length > 0 && Number(accounts[0].balance) > 0
    ? Number(accounts[0].balance)
    : Number.POSITIVE_INFINITY;

  const SPEC = config.spec;
  const LOCKED = config.marketMode === "locked";
  const REANALYZE_MS = LOCKED ? REFIT_LOCKED_MS : REFIT_SWITCHING_MS;

  // Mutable deployment — the market may migrate (switching); the digit is the
  // fused argmax each tick, exactly as the scan replayed it.
  let activeSymbol = config.symbol;
  let activeName = config.displayName;
  let activeEdge = config.lockedAnalysis?.edgePerDollar ?? 0;

  let policy: ApexPolicy | null = null;
  let lastDigitCount = 0;
  /** Absolute index the lenses have been fed through (end-append verified). */
  let fedLen = 0;
  let fedTail = "";
  let lastEntry: ApexDecision | null = null;
  let decidedTicks = 0;
  let lastReanalyzeAt = 0;
  let lossRun = 0;
  let consecutiveErrors = 0;
  const healthRing: number[] = [];

  async function readDigits(symbol: string): Promise<number[]> {
    try {
      return await getDeepDigits(symbol, SCAN_DIGITS);
    } catch {
      return tickManager.getDigits(symbol, SCAN_DIGITS);
    }
  }

  /** Re-measure the ACTIVE market, rebuild the live policy on the fresh fit. */
  async function refitActive(): Promise<ApexCandidate | null> {
    const digits = await readDigits(activeSymbol);
    if (digits.length < MIN_LIVE_DIGITS) return null;
    // One pass: honest walk-forward fit, then the live policy IS the fitted
    // card. What the scan measured is what now trades.
    const read = scoreMarket(digits, SPEC.pace, {
      ...(SPEC.digit !== undefined ? { lockedDigit: SPEC.digit } : {}),
    });
    const candidate: ApexCandidate = {
      symbol: activeSymbol,
      displayName: activeName,
      digit: read.digit,
      verdict: read.verdict,
      confidence: read.confidence,
      edgePerDollar: read.edgePerDollar,
      hitRate: read.hitRate,
      hitRateLower: read.hitRateLower,
      shots: read.shots,
      fireRate: read.fireRate,
      breakEven: read.breakEven,
      payout: read.payout,
      params: read.params,
      diag: read.diag,
      thinData: read.thinData,
    };
    policy = new ApexPolicy({ ...candidate.params, pace: SPEC.pace });
    for (let i = 0; i < digits.length; i++) policy.update(digits, i);
    lastDigitCount = digits.length;
    fedLen = digits.length;
    fedTail = digits.slice(-3).join(",");
    lastEntry = null;
    activeEdge = candidate.edgePerDollar;

    session.activeSymbol = activeSymbol;
    session.activeName = activeName;
    session.activeRead = candidate;
    session.currentMarket = activeName;
    session.watch.confidence = candidate.confidence;
    session.watch.verdict = candidate.verdict;
    return candidate;
  }

  /** Switching only: re-measure EVERY market, migrate past the margin. */
  async function maybeMigrate(): Promise<{ migrated: boolean }> {
    if (LOCKED) {
      await refitActive();
      return { migrated: false };
    }
    const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
    let best: ApexCandidate | null = null;
    let incumbentEdge = Number.NEGATIVE_INFINITY;
    for (const m of markets) {
      const digits = await readDigits(m.symbol);
      if (digits.length < MIN_LIVE_DIGITS) continue;
      const read = scoreMarket(digits, SPEC.pace, {
        ...(SPEC.digit !== undefined ? { lockedDigit: SPEC.digit } : {}),
      });
      const c: ApexCandidate = {
        symbol: m.symbol, displayName: m.displayName, digit: read.digit,
        verdict: read.verdict, confidence: read.confidence, edgePerDollar: read.edgePerDollar,
        hitRate: read.hitRate, hitRateLower: read.hitRateLower, shots: read.shots,
        fireRate: read.fireRate, breakEven: read.breakEven, payout: read.payout,
        params: read.params, diag: read.diag, thinData: read.thinData,
      };
      if (m.symbol === activeSymbol) incumbentEdge = c.edgePerDollar;
      if (!best || VERDICT_RANK[c.verdict] < VERDICT_RANK[best.verdict]
          || (c.verdict === best.verdict && c.edgePerDollar > best.edgePerDollar)) best = c;
    }
    if (best && best.symbol !== activeSymbol
        && best.verdict !== "thin"
        && best.edgePerDollar - incumbentEdge > SWITCH_MARGIN) {
      activeSymbol = best.symbol;
      activeName = best.displayName;
      await refitActive();
      return { migrated: true };
    }
    await refitActive();
    return { migrated: false };
  }

  while (session.running && !session.stopRequested) {
    try {
      session.watch.switched = false;
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false;
        session.message = `⛔ Stopped — the ${owner ? tradingOwnerLabel(owner) : "other engine"} took over this account. One ledger = one engine.`;
        broadcast();
        return;
      }

      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) {
        session.message = "Stabilizing tick feed…";
        broadcast();
        await sleep(1000);
        continue;
      }

      const inRecovery = recoveryEngine.isInRecovery();

      // ── Rolling live health: a cold run forces a fresh measurement ──
      if (healthRing.length >= HEALTH_WINDOW && session.tradeCount > 0) {
        const hits = healthRing.reduce((a, b) => a + b, 0);
        const n = healthRing.length;
        const center = (hits + 2) / (n + 4);
        const lower = center - 2 * Math.sqrt(center * (1 - center) / (n + 4));
        if (lower < APEX_BREAKEVEN) lastReanalyzeAt = 0;
      }

      // ── PERIODIC RE-MEASURE ──
      const needsReanalyze = policy === null || Date.now() - lastReanalyzeAt >= REANALYZE_MS;
      if (needsReanalyze) {
        const before = activeSymbol;
        const { migrated } = await maybeMigrate();
        lastReanalyzeAt = Date.now();
        if (!policy) {
          session.watch.phase = "watching";
          session.watch.reason = "collecting history for the live policy";
          session.message = LOCKED
            ? `Holding on ${activeName} — collecting history for the live policy`
            : `Scanning markets — collecting history for the live policy`;
          broadcast();
          await sleep(1500);
          continue;
        }
        if (migrated && before !== activeSymbol) {
          session.watch.switched = true;
          session.message = `🔁 Migrated to ${activeName} — it measured better`;
        }
      }

      // ── Feed + score ONLY genuinely new ticks, exactly once each ──
      const digits = await readDigits(activeSymbol);
      if (digits.length !== lastDigitCount) {
        const delta = Math.max(0, digits.length - lastDigitCount);
        session.watch.ticksWatched += delta;
        lastDigitCount = digits.length;
      }
      const tailIdx = digits.length - 1;

      // Freshness: a stale feed means wait, never trade blind.
      const medianGap = activeSymbol.startsWith("1HZ") ? 1 : 2;
      const age = tickManager.getTickAgeSeconds(activeSymbol);
      if (!Number.isFinite(age) || age > medianGap * 6) {
        session.watch.phase = "watching";
        session.watch.reason = "tick feed lagging — holding fire until it catches up";
        session.message = `⏳ Holding on ${activeName} — tick feed lagging`;
        broadcast();
        await sleep(900);
        continue;
      }

      // Verify the array still end-appends onto what the lenses were fed
      // (a WS backfill can grow the FRONT and shift absolute indices).
      // Capture to a const: `policy` is reassigned inside refit closures, so
      // the mutable binding carries stale narrowing here. The cast restores
      // the DECLARED type (no lie — it is the same runtime value) and const
      // narrowing below is then bulletproof.
      const live = policy as ApexPolicy | null;
      let newTicks = 0;
      if (live && tailIdx >= 0) {
        const junction = fedLen > 0 ? digits.slice(Math.max(0, fedLen - 3), fedLen).join(",") : "";
        if (digits.length > fedLen && (fedLen === 0 || junction === fedTail)) {
          for (let i = fedLen; i <= tailIdx; i++) live.update(digits, i);
          newTicks = digits.length - fedLen;
          fedLen = digits.length;
          fedTail = digits.slice(-3).join(",");
        } else if (digits.length >= fedLen && digits.slice(-3).join(",") !== fedTail) {
          // Front-shifted or gapped: feed just the newest tick once rather
          // than double-feeding history into the Hawkes state. The next refit
          // (≤45s) re-warms the lenses fully anyway.
          live.update(digits, tailIdx);
          newTicks = 1;
          fedLen = digits.length;
          fedTail = digits.slice(-3).join(",");
        }
      }
      if (live && newTicks > 0) {
        // ONE valve observation per tick — exactly as the scan replayed it.
        const entry = live.decide(digits, tailIdx, { recovery: inRecovery });
        lastEntry = entry;
        decidedTicks++;
      }

      const entry = lastEntry;
      if (!live || !entry) {
        session.watch.phase = "watching";
        session.watch.reason = "waiting for the first live tick";
        session.message = `👁 ${activeName} — waiting for the first live tick`;
        broadcast();
        await sleep(900);
        continue;
      }

      session.watch.phase = "armed";
      session.watch.digit = entry.digit;
      session.watch.p = entry.p;
      session.watch.bar = entry.bar;
      session.watch.echoLags = live.echoLags(3).map((l: { lag: number; rate: number }) => ({ lag: l.lag, rate: l.rate }));
      session.watch.heatDigit = entry.heatDigit;
      session.watch.heatRatio = entry.heatRatio;
      session.watch.memoryOrder = entry.memoryOrder;
      session.watch.topDigits = topDigitsOf(entry.fused);
      session.watch.fireRate = decidedTicks > 0 ? session.tradeCount / decidedTicks : 0;

      if (!entry.ready) {
        session.watch.phase = "watching";
        session.watch.reason = waitReason(entry, session.watch.ticksWatched);
        session.message = inRecovery
          ? `🎯 Recovery armed — ${session.watch.reason}`
          : `👁 Matches ${entry.digit} on ${activeName} — ${session.watch.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }

      // ── DIGITMATCH sovereignty — re-asserted immediately before every buy ──
      const fireDigit = entry.digit;
      if (!isAutomatedMarket(activeSymbol) || fireDigit < 0 || fireDigit > 9
          || (SPEC.digit !== undefined && fireDigit !== SPEC.digit)) {
        session.running = false;
        session.message = "⚠️ Sovereignty check failed — session halted before firing";
        logger.error({ activeSymbol, fireDigit, spec: SPEC }, "Echo Apex sovereignty violation");
        broadcast();
        return;
      }

      const payoutQuote = await resolveRecoveryPayout({
        symbol: activeSymbol,
        contractType: APEX_CONTRACT_TYPE,
        barrier: fireDigit,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      const payout = payoutQuote.payoutMultiplier || APEX_MATCH_PAYOUT;

      if (inRecovery) {
        try {
          const fresh = await db.select().from(settingsTable)
            .where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
          if (fresh.length > 0) {
            const v = Number((fresh[0] as any).botRecoveryMarkup);
            if (Number.isFinite(v)) botRecoveryMarkup = v;
          }
        } catch { /* keep the previous value */ }
      }

      // The shared debt-driven stake — the IDENTICAL formula every bot uses.
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, payout, botRecoveryMarkup)
        : config.stake;

      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing";
      session.watch.reason = `firing Matches ${fireDigit} on ${activeName}`;
      session.currentStake = stake;
      session.currentMarket = activeName;
      session.currentContractType = APEX_CONTRACT_TYPE;
      session.message = inRecovery
        ? `🎯 [Recovery R${sharedStep}] Matches ${fireDigit} on ${activeName} · $${stake.toFixed(2)}`
        : `🎯 Matches ${fireDigit} on ${activeName} · $${stake.toFixed(2)}`;
      broadcast();

      const reason = `[Echo Apex${inRecovery ? " RECOVERY" : ""}] Matches ${fireDigit} on ${activeName} · ` +
        `measured ${(activeEdge * 100).toFixed(1)}% edge/$1 · ` +
        `P(${(entry.p * 100).toFixed(1)}%) vs bar(${(entry.bar * 100).toFixed(1)}%) · ` +
        `${SPEC.pace} pace · memory ord-${entry.memoryOrder} · heat ${entry.heatDigit}×${entry.heatRatio}`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: activeSymbol,
        displayName: activeName,
        contractType: APEX_CONTRACT_TYPE,
        barrier: fireDigit,
        stake: String(Math.round(stake * 100) / 100),
        direction: "hold",
        status: "open",
        aiConfidence: String(Math.round(entry.p * 100)),
        aiRiskScore: "15",
        isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`,
        duration: 1,
        durationUnit: "t",
      }).returning();

      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: activeSymbol,
            contractType: APEX_CONTRACT_TYPE,
            stake: Math.round(stake * 100) / 100,
            duration: 1,
            durationUnit: "t",
            currency,
            accountId: accounts[0].derivAccountId ?? accounts[0].loginId,
            barrier: fireDigit,
          } as any);
          const result = await waitForContractResult(
            token!, accounts[0].derivAccountId ?? accounts[0].loginId,
            liveResult.contractId, 30_000,
          );
          won = result.won;
          profit = result.profit;
          entryPrice = Number(result.entrySpot) || liveResult.buyPrice;
          exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          logger.warn({ err }, "Echo Apex live execution error — returning to the watch");
          try {
            await db.update(tradesTable).set({
              status: "error", profit: "0", payout: "0", closedAt: new Date(),
              agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
            }).where(eq(tradesTable.id, journaled.id));
          } catch { /* best-effort */ }
          session.watch.phase = "watching";
          session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}. Back to watching.`;
          broadcast();
          await sleep(2000);
          continue;
        }
      } else {
        session.watch.phase = "settling";
        const before = tickManager.getDigits(activeSymbol, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const d = tickManager.getDigits(activeSymbol, 1)[0];
          if (d !== undefined && d !== before) { digit = d; break; }
          digit = d;
        }
        const d = digit ?? 0;
        won = d === fireDigit;
        profit = won ? stake * (payout - 1) : -stake;
      }

      session.tradeCount++;
      session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) {
        session.winCount++;
        session.lastResult = "won";
        session.currentLossRun = 0;
        lossRun = 0;
      } else {
        session.lossCount++;
        session.lastResult = "lost";
        session.currentLossRun++;
        session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun);
        lossRun++;
      }
      healthRing.push(won ? 1 : 0);
      if (healthRing.length > HEALTH_WINDOW * 2) healthRing.shift();

      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, APEX_CONTRACT_TYPE, payout);

      try {
        await db.update(tradesTable).set({
          status: won ? "won" : "lost",
          payout: String(won ? Math.round((stake + profit) * 100) / 100 : 0),
          profit: String(Math.round(profit * 100) / 100),
          entryPrice: String(entryPrice),
          exitPrice: String(exitPrice),
          closedAt: new Date(),
        }).where(eq(tradesTable.id, journaled.id));
      } catch (dbErr) {
        logger.warn({ dbErr }, "Echo Apex: failed to settle the journaled trade");
      }

      if (!isLive && Number.isFinite(availableBalance)) {
        availableBalance = Math.max(0, availableBalance + profit);
      }
      if (isLive) {
        try {
          const newBal = await getLiveBalance(token!, accounts[0]?.derivAccountId ?? accounts[0]?.loginId);
          if (newBal !== null && accounts.length > 0) {
            availableBalance = newBal;
            await db.update(accountsTable)
              .set({ balance: String(newBal), updatedAt: new Date() })
              .where(eq(accountsTable.id, accounts[0].id));
          }
        } catch { /* best-effort */ }
      }

      session.watch = {
        ...freshWatch(),
        ticksWatched: session.watch.ticksWatched,
        confidence: session.activeRead?.confidence ?? 0,
        verdict: session.activeRead?.verdict ?? "—",
      };
      lastReanalyzeAt = 0; // fresh measurement before the next shot
      session.message = won
        ? `✅ +$${profit.toFixed(2)} · ${session.winCount}/${session.tradeCount} · next shot re-measured`
        : `❌ −$${Math.abs(profit).toFixed(2)} · valve tightening · ${session.currentLossRun} in a row`;
      broadcast();

      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached in ${session.tradeCount} shots.`;
        broadcast();
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit after ${session.tradeCount} shots. Session stopped safely.`;
        broadcast();
        return;
      }

      await sleep(won ? 2500 : 4000);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Echo Apex stability catch — keeping the session alive");
      session.message = `Engine stabilizing… retry ${consecutiveErrors} — the session will keep running`;
      broadcast();
      await sleep(Math.min(15000, 600 * consecutiveErrors));
    }
  }

  if (!session.running
      && !session.message?.startsWith("✅")
      && !session.message?.startsWith("🛑")
      && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}
