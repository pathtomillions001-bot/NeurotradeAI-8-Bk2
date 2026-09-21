/**
 * Vector Surge — Rise/Fall momentum specialist with recovery-first intelligence.
 *
 * Normal:   Rise (CALL) / Fall (PUT) 1-tick, 1.92× (≈52.08% break-even)
 * Recovery: Rise / Fall              (same contracts — recovery is about WHEN)
 *
 * The brain lives in `./surge-analysis` (four momentum lenses, log-pool
 * fusion, loss-pair-aware side utility, STATIC recovery bar). This module is
 * the session shell and deliberately reuses the same proven infrastructure as
 * the other dedicated bots with zero behaviour changes:
 *
 * - price + execution: `tickManager` / `getDeepPrices` / `executeLiveTrade` /
 *   `waitForContractResult` from `./deriv` (1-tick CALL/PUT)
 * - the ONE shared debt-driven recovery ledger (`./agents/recovery-engine`,
 *   sized by `getBotRecoveryStake` — the identical formula every bot uses)
 * - the ONE single-executor arbiter (`./engine-arbiter`, owner `"bots"`)
 * - live payouts from `./recovery-payout`
 * - one owner-scoped SSE broadcast (`./sse`)
 *
 * RECOVERY-FIRST LOOP:
 *   - a normal loss drops straight into recovery mode;
 *   - recovery evaluates BOTH sides every tick and fires the BEST shot the
 *     moment its fused win probability clears the STATIC break-even bar —
 *     there is NO post-loss tightening, NO cool-down ladder, NO gate that
 *     hardens as debt grows (see surge-analysis: the bar is a frozen const
 *     and `decideRecovery` cannot even receive a loss run);
 *   - if no side shows tilt the bot waits — and in SWITCHING mode it HUNTS
 *     across every market and migrates to the first/best market with a
 *     bar-clearing recovery shot. LOCKED mode stays and waits on its market.
 *
 * Deploy flow (scan-first): `scanForSurge` measures all markets with an honest
 * walk-forward of the exact live policy (including recovery episode metrics) and
 * returns ranked cards. The user picks LOCKED or SWITCHING and deploys; verdicts
 * are labels, never gates.
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
  getLiveBalance,
  isAutomatedMarket,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { registerBotEngine, runningOtherEngines } from "./engine-registry";
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
import { registerLiveBot, unregisterLiveBot } from "./live-registry";
import {
  SURGE_NORMAL_CONTRACTS,
  SURGE_RECOVERY_BAR,
  SURGE_RECOVERY_CONTRACTS,
  SurgePolicy,
  scoreSurgeMarket,
  type SurgeContract,
  type SurgeDecision,
  type SurgeParams,
  type SurgeReplayMetrics,
  type SurgeSideMode,
  type SurgeVerdict,
} from "./surge-analysis";

export const SURGE_BOT_ID = "surge";
export const SURGE_BOT_NAME = "Vector Surge";
const SURGE_DURATION = 1;
const SURGE_DURATION_UNIT = "t";

/** Prices re-read from the feed every scan/refit pass. */
const SCAN_PRICES = 4500;
/** Warm prices for a cross-market recovery hunt (fast + sufficient). */
const HUNT_PRICES = 2500;
/** Re-measure cadence — live never trusts a stale fit for long. */
const REFIT_LOCKED_MS = 25_000;
const REFIT_SWITCHING_MS = 45_000;
/** Switching migrates only for a MEANINGFULLY better edge (anti-flip). */
const SWITCH_MARGIN = 0.015;
/** In recovery (switching mode) hunt a better market this often. */
const RECOVERY_HUNT_MS = 3_000;
/** Minimum prices before the live policy is allowed to exist. */
const MIN_LIVE_PRICES = 150;

// ── Types ───────────────────────────────────────────────────────────────────

export interface SurgeDeploySpec {
  sideMode: SurgeSideMode;
}

export interface SurgeCandidate {
  symbol: string;
  displayName: string;
  verdict: SurgeVerdict;
  confidence: number;
  paperEdgePerDollar: number;
  normalHitRate: number;
  normalShots: number;
  normalHits: number;
  recoveryHitRate: number;
  recoveryShots: number;
  recoveryHits: number;
  recoveryLossPairs: number;
  recoveryLosses: number;
  avgTicksInRecovery: number;
  fireRatePer100: number;
  breakEven: number;
  params: SurgeParams;
  diag: {
    weights: [number, number, number, number];
    tau: number;
    normalInitBar: number;
    historyUsed: number;
    qLL: { rise: number; fall: number };
    fireRatePer100: number;
    hurst: number;
  };
  thinData: boolean;
  metrics: SurgeReplayMetrics;
}

export interface SurgeScanResult {
  suitable: boolean;
  best: SurgeCandidate | null;
  bestAvailable: SurgeCandidate | null;
  allScored: SurgeCandidate[];
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

export interface SurgeConfig {
  ownerSessionId?: string;
  spec: SurgeDeploySpec;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  symbol: string;
  displayName: string;
  params: SurgeParams;
  lockedAnalysis?: SurgeCandidate;
}

export interface SurgeDeployed {
  symbol: string;
  displayName: string;
  verdict: string;
  confidence: number;
  paperEdgePerDollar: number;
  normalHitRate: number;
  normalShots: number;
  recoveryHitRate: number;
  recoveryShots: number;
  recoveryLossPairs: number;
  breakEven: number;
}

export interface SurgeWatch {
  phase: "watching" | "armed" | "firing" | "settling" | "hunting";
  mode: "normal" | "recovery";
  sideLabel: string;
  altLabel: string;
  p: number;
  altP: number;
  bar: number;
  ready: boolean;
  pairRisk: number;
  qLL: number;
  lenses: [number, number, number, number];
  recoveryRadar: Array<{ label: string; p: number; utility: number; ready: boolean }>;
  reason: string;
  switched: boolean;
  ticksWatched: number;
  confidence: number;
  verdict: string;
}

export interface SurgeStatus {
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
  currentLossRun: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: {
    sideMode: SurgeSideMode;
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    marketMode: "locked" | "switching";
    lockedSymbol?: string;
  };
  surgeDeployed?: SurgeDeployed;
  surgeWatch?: SurgeWatch;
}

// ── Session state ───────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: SurgeConfig | null;
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
  watch: SurgeWatch;
  activeSymbol?: string;
  activeName?: string;
  activeRead?: SurgeCandidate | null;
}

function freshWatch(): SurgeWatch {
  return {
    phase: "watching",
    mode: "normal",
    sideLabel: "—",
    altLabel: "—",
    p: 0,
    altP: 0,
    bar: SURGE_RECOVERY_BAR,
    ready: false,
    pairRisk: 0,
    qLL: 0,
    lenses: [0, 0, 0, 0],
    recoveryRadar: [],
    reason: "",
    switched: false,
    ticksWatched: 0,
    confidence: 0,
    verdict: "—",
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

export function getOwnerSessionId(): string | null { return session.config?.ownerSessionId ?? null; }

registerBotEngine("surge", () => ({ running: session.running, name: "Vector Surge" }));

export function isRunning(): boolean { return session.running; }

function deployed(read: SurgeCandidate | null | undefined): SurgeDeployed | undefined {
  if (!read) return undefined;
  const num = (v: unknown, fallback = 0): number => typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    symbol: read.symbol, displayName: read.displayName, verdict: read.verdict,
    confidence: num(read.confidence), paperEdgePerDollar: num(read.paperEdgePerDollar),
    normalHitRate: num(read.normalHitRate), normalShots: num(read.normalShots),
    recoveryHitRate: num(read.recoveryHitRate), recoveryShots: num(read.recoveryShots),
    recoveryLossPairs: num(read.recoveryLossPairs), breakEven: num(read.breakEven, 1 / 1.92),
  };
}

export function getStatus(): SurgeStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  return {
    running: session.running, botId: cfg ? SURGE_BOT_ID : null, botName: cfg ? SURGE_BOT_NAME : null, sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100, tradeCount: session.tradeCount, winCount: session.winCount, lossCount: session.lossCount,
    currentStake: session.currentStake, inRecovery: rec.inRecovery, recoveryStep: rec.recoveryStep,
    unrecoveredAmount: Math.round(rec.unrecoveredAmount * 100) / 100, deepestLossRun: session.deepestLossRun, currentLossRun: session.currentLossRun,
    currentMarket: session.currentMarket, currentContractType: session.currentContractType, lastResult: session.lastResult, message: session.message,
    config: cfg ? { sideMode: cfg.spec.sideMode, stake: cfg.stake, stopLoss: cfg.stopLoss, takeProfit: cfg.takeProfit, maxRecoverySteps: cfg.maxRecoverySteps, marketMode: cfg.marketMode, ...(cfg.lockedSymbol ? { lockedSymbol: cfg.lockedSymbol } : {}) } : undefined,
    surgeDeployed: session.running ? deployed(session.activeRead) : undefined,
    surgeWatch: session.running ? session.watch : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true; session.running = false; session.message = "Session stopped by user";
  releaseTradingOwnership("bots"); unregisterLiveBot(SURGE_BOT_ID); broadcast();
  logger.info({ botId: SURGE_BOT_ID }, "Vector Surge session stopped");
}

// ── Deep price helper (tick buffer + history request) ───────────────────────

async function readPrices(symbol: string, count = SCAN_PRICES): Promise<number[]> {
  // Prefer live buffer, top up via ticks_history if buffer is shallow.
  const buffered = tickManager.getTicks(symbol, count);
  if (buffered.length >= Math.min(count, 800)) return buffered.slice(-count);
  try {
    const msg = await tickManager.request({ ticks_history: symbol, count: Math.min(5000, Math.max(100, count)), end: "latest", style: "ticks" }, 6000);
    const prices: unknown[] | undefined = msg?.history?.prices;
    if (Array.isArray(prices) && prices.length > 5) {
      const arr = prices.map(Number).filter(n => Number.isFinite(n) && n > 0);
      // merge with live buffer tail that arrived since the pull (live is fresher)
      if (buffered.length > 0) {
        const tailNeed = Math.max(0, buffered.length - Math.max(0, arr.length - buffered.length));
        // Simple: append any buffered prices beyond the history length
        return [...arr, ...buffered.slice(-Math.max(0, buffered.length - arr.length))].slice(-count);
      }
      return arr.slice(-count);
    }
  } catch { /* fall through */ }
  return buffered.slice(-count);
}

// ── Pre-deploy scan ─────────────────────────────────────────────────────────

const VERDICT_RANK: Record<SurgeVerdict, number> = { prime: 0, viable: 1, thin: 2 };

function toCandidate(symbol: string, displayName: string, read: ReturnType<typeof scoreSurgeMarket>): SurgeCandidate {
  const m = read.metrics;
  return {
    symbol, displayName, verdict: read.verdict, confidence: read.confidence, paperEdgePerDollar: read.paperEdgePerDollar,
    normalHitRate: m.normalHitRate, normalShots: m.normalShots, normalHits: m.normalHits,
    recoveryHitRate: m.recoveryHitRate, recoveryShots: m.recoveryShots, recoveryHits: m.recoveryHits,
    recoveryLossPairs: m.recoveryLossPairs, recoveryLosses: m.recoveryLosses, avgTicksInRecovery: m.avgTicksInRecovery,
    fireRatePer100: m.fireRatePer100, breakEven: read.breakEven, params: read.params, diag: read.diag, thinData: read.thinData, metrics: m,
  };
}

export async function scanForSurge(ownerSessionId: string | undefined): Promise<SurgeScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS;
  const all: SurgeCandidate[] = []; let deepest = 0;
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", { botId: SURGE_BOT_ID, scanning: market.displayName, symbol: market.symbol, scanned: i, total: markets.length }, ownerSessionId);
    let prices: number[] = [];
    try { prices = await readPrices(market.symbol, SCAN_PRICES); } catch { prices = tickManager.getTicks(market.symbol, SCAN_PRICES); }
    deepest = Math.max(deepest, prices.length);
    all.push(toCandidate(market.symbol, market.displayName, scoreSurgeMarket(prices)));
    await sleep(5);
  }
  const ranked = all.sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.paperEdgePerDollar - a.paperEdgePerDollar || b.recoveryHitRate - a.recoveryHitRate);
  broadcastSSE("bot_scan_progress", { botId: SURGE_BOT_ID, scanning: null, symbol: null, scanned: markets.length, total: markets.length }, ownerSessionId);
  const best = ranked[0];
  if (!best || best.thinData) {
    return { suitable: false, best: null, bestAvailable: null, allScored: [], reason: "Not enough price history yet — the tick feed is still warming up. Wait a moment and re-scan.", marketsScanned: markets.length, historyDepth: deepest };
  }
  const suitable = best.verdict !== "thin";
  const reason = suitable
    ? `${best.displayName} — measured ${(best.recoveryHitRate * 100).toFixed(0)}% recovery hits over ${best.recoveryShots} recovery shots (${best.recoveryLossPairs} loss pair${best.recoveryLossPairs === 1 ? "" : "s"}), ${(best.normalHitRate * 100).toFixed(0)}% normal over ${best.normalShots} shots.`
    : `${best.displayName} is the best available (${best.verdict.toUpperCase()}) — measured ${(best.recoveryHitRate * 100).toFixed(0)}% recovery over ${best.recoveryShots} shots. Starting it is a deliberate choice; the bar never hardens after losses.`;
  return { suitable, best: suitable ? best : null, bestAvailable: best, allScored: ranked.filter(c => !c.thinData).slice(0, 12), reason, marketsScanned: markets.length, historyDepth: deepest };
}

// ── Session start ───────────────────────────────────────────────────────────

export async function startSession(config: SurgeConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "Vector Surge is already active — stop it first" };
  const otherEngines = runningOtherEngines("surge");
  if (otherEngines.length > 0) return { ok: false, error: `${otherEngines[0].name} is already trading on this account. Stop it first — one engine at a time owns the shared recovery ledger.` };
  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return { ok: false, error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account. Stop it first — only one engine may own the shared recovery ledger.` };
  }
  const fail = (error: string) => { releaseTradingOwnership("bots"); return { ok: false as const, error }; };
  if (config.stake < 0.35) return fail("Minimum stake is $0.35");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  if (config.marketMode === "locked" && config.lockedSymbol !== config.symbol) return fail("Locked mode pins the market you scanned — refusing a mismatched lock");
  if (!config.params || !Number.isFinite(config.params.tau) || !Array.isArray(config.params.weights)) return fail("Run the scan first — this bot only deploys a measurement it has made");
  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  if (!market) return fail("This market cannot be traded by this bot");

  session = {
    ...freshSession(), running: true, sessionId: `bot_surge_${Date.now()}`, config,
    currentStake: config.stake, currentMarket: config.displayName, activeSymbol: config.symbol, activeName: config.displayName, activeRead: config.lockedAnalysis ?? null,
    message: config.marketMode === "locked" ? `Locked on ${config.displayName} — Rise/Fall, recovery holds this market.` : `Deployed on ${config.displayName} — Rise/Fall, recovery hunts best market.`,
  };
  if (session.activeRead) { session.watch.confidence = session.activeRead.confidence; session.watch.verdict = session.activeRead.verdict; }

  logger.info({ botId: SURGE_BOT_ID, sideMode: config.spec.sideMode, marketMode: config.marketMode, symbol: config.symbol }, "Vector Surge session starting");
  registerLiveBot(SURGE_BOT_ID, () => getStatus()); broadcast();

  runWithSession(config.ownerSessionId ?? "legacy", () =>
    runLoop(config).catch(err => {
      logger.error({ err }, "Vector Surge runLoop error"); session.running = false; session.message = `⚠️ ${friendlyErrorMessage(err)}`; broadcast();
    }).finally(() => releaseTradingOwnership("bots")),
  );
  return { ok: true };
}

// ── Execution loop ──────────────────────────────────────────────────────────

function radarOf(policy: SurgePolicy, prices: number[], idx: number) {
  return SURGE_RECOVERY_CONTRACTS.map(c => {
    const r = policy.readSide(prices, idx, c);
    return { label: c.label, p: r.p, utility: r.utility, ready: r.p >= SURGE_RECOVERY_BAR };
  }).sort((a, b) => b.utility - a.utility);
}

function applyDecisionToWatch(dec: SurgeDecision, radar: SurgeWatch["recoveryRadar"]) {
  session.watch.mode = dec.mode; session.watch.sideLabel = dec.side?.label ?? "—"; session.watch.altLabel = dec.alt?.contract.label ?? "—";
  session.watch.p = dec.read?.p ?? 0; session.watch.altP = dec.alt?.p ?? 0; session.watch.bar = dec.bar; session.watch.ready = dec.ready;
  session.watch.pairRisk = dec.read?.pairRisk ?? 0; session.watch.qLL = dec.read?.qLL ?? 0; session.watch.lenses = dec.read?.lenses ?? [0, 0, 0, 0];
  session.watch.recoveryRadar = radar; session.watch.reason = dec.reason;
}

async function runLoop(config: SurgeConfig) {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) { session.running = false; session.message = "Browser session missing — session aborted safely"; releaseTradingOwnership("bots"); broadcast(); return; }

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

  const SPEC = config.spec;
  const LOCKED = config.marketMode === "locked";
  const REANALYZE_MS = LOCKED ? REFIT_LOCKED_MS : REFIT_SWITCHING_MS;

  let activeSymbol = config.symbol;
  let activeName = config.displayName;

  let policy: SurgePolicy | null = null;
  let lastPriceCount = 0;
  let fedLen = 0;
  let fedTail = "";
  let lastEntry: SurgeDecision | null = null;
  let lastRadar: SurgeWatch["recoveryRadar"] = [];
  let lastReanalyzeAt = 0;
  let lastHuntAt = 0;
  let consecutiveErrors = 0;

  async function refitActive(): Promise<SurgeCandidate | null> {
    const prices = await readPrices(activeSymbol);
    if (prices.length < MIN_LIVE_PRICES) return null;
    const read = scoreSurgeMarket(prices);
    const candidate = toCandidate(activeSymbol, activeName, read);
    const prevBar = policy?.normalBar;
    policy = new SurgePolicy(prevBar !== undefined ? { ...read.params, normalInitBar: prevBar } : read.params);
    for (let i = 0; i < prices.length; i++) policy.update(prices, i);
    lastPriceCount = prices.length; fedLen = prices.length; fedTail = prices.slice(-3).join(",");
    lastEntry = null;
    session.activeSymbol = activeSymbol; session.activeName = activeName; session.activeRead = candidate; session.currentMarket = activeName;
    session.watch.confidence = candidate.confidence; session.watch.verdict = candidate.verdict;
    return candidate;
  }

  async function maybeMigrate(): Promise<{ migrated: boolean }> {
    if (LOCKED) { await refitActive(); return { migrated: false }; }
    const markets = AUTOMATED_DERIV_MARKETS;
    let best: SurgeCandidate | null = null; let incumbentEdge = Number.NEGATIVE_INFINITY;
    for (const m of markets) {
      const prices = await readPrices(m.symbol);
      if (prices.length < MIN_LIVE_PRICES) continue;
      const c = toCandidate(m.symbol, m.displayName, scoreSurgeMarket(prices));
      if (m.symbol === activeSymbol) incumbentEdge = c.paperEdgePerDollar;
      if (!best || VERDICT_RANK[c.verdict] < VERDICT_RANK[best.verdict] || (c.verdict === best.verdict && c.paperEdgePerDollar > best.paperEdgePerDollar)) best = c;
    }
    if (best && best.symbol !== activeSymbol && best.verdict !== "thin" && best.paperEdgePerDollar - incumbentEdge > SWITCH_MARGIN) {
      activeSymbol = best.symbol; activeName = best.displayName; await refitActive(); return { migrated: true };
    }
    await refitActive(); return { migrated: false };
  }

  async function huntRecoveryShot(): Promise<{ symbol: string; name: string; dec: SurgeDecision } | null> {
    const markets = AUTOMATED_DERIV_MARKETS;
    let best: { symbol: string; name: string; dec: SurgeDecision } | null = null;
    for (const m of markets) {
      const prices = await readPrices(m.symbol, HUNT_PRICES);
      if (prices.length < MIN_LIVE_PRICES) continue;
      let scan: SurgePolicy;
      if (policy && m.symbol === activeSymbol) scan = policy;
      else { scan = new SurgePolicy(config.params); for (let i = 0; i < prices.length; i++) scan.update(prices, i); }
      const dec = scan.decideRecovery(prices, prices.length - 1);
      if (dec.ready && dec.side && dec.read && (!best || (dec.read.utility > best.dec.read!.utility))) best = { symbol: m.symbol, name: m.displayName, dec };
    }
    return best;
  }

  while (session.running && !session.stopRequested) {
    try {
      session.watch.switched = false;
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner(); session.running = false;
        session.message = `⛔ Stopped — the ${owner ? tradingOwnerLabel(owner) : "other engine"} took over this account. One ledger = one engine.`; broadcast(); return;
      }
      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) { session.message = "Stabilizing tick feed…"; broadcast(); await sleep(1000); continue; }
      const inRecovery = recoveryEngine.isInRecovery();

      const needsReanalyze = policy === null || Date.now() - lastReanalyzeAt >= REANALYZE_MS;
      if (needsReanalyze) {
        const before = activeSymbol;
        const { migrated } = await maybeMigrate();
        lastReanalyzeAt = Date.now();
        if (!policy) {
          session.watch.phase = "watching"; session.watch.reason = "collecting price history for the live policy";
          session.message = `Holding on ${activeName} — collecting price history for the live policy`; broadcast(); await sleep(1500); continue;
        }
        if (migrated && before !== activeSymbol) { session.watch.switched = true; session.message = `🔁 Migrated to ${activeName} — it measured better`; }
      }

      const prices = await readPrices(activeSymbol);
      if (prices.length !== lastPriceCount) {
        const delta = Math.max(0, prices.length - lastPriceCount);
        session.watch.ticksWatched += delta; lastPriceCount = prices.length;
      }
      const tailIdx = prices.length - 1;

      const medianGap = activeSymbol.startsWith("1HZ") ? 1 : 2;
      const age = tickManager.getTickAgeSeconds(activeSymbol);
      if (!Number.isFinite(age) || age > medianGap * 6) {
        session.watch.phase = "watching"; session.watch.reason = "tick feed lagging — holding fire until it catches up";
        session.message = `⏳ Holding on ${activeName} — tick feed lagging`; broadcast(); await sleep(900); continue;
      }

      const live = policy as SurgePolicy | null;
      let newTicks = 0;
      if (live && tailIdx >= 0) {
        const junction = fedLen > 0 ? prices.slice(Math.max(0, fedLen - 3), fedLen).join(",") : "";
        if (prices.length > fedLen && (fedLen === 0 || junction === fedTail)) {
          for (let i = fedLen; i <= tailIdx; i++) live.update(prices, i);
          newTicks = prices.length - fedLen; fedLen = prices.length; fedTail = prices.slice(-3).join(",");
        } else if (prices.length >= fedLen && prices.slice(-3).join(",") !== fedTail) {
          live.update(prices, tailIdx); newTicks = 1; fedLen = prices.length; fedTail = prices.slice(-3).join(",");
        }
      }

      if (live && newTicks > 0) {
        const dec = inRecovery ? live.decideRecovery(prices, tailIdx) : live.decideNormal(prices, tailIdx, SPEC.sideMode);
        lastEntry = dec; lastRadar = radarOf(live, prices, tailIdx);
      }

      const entry = lastEntry;
      if (!live || !entry) {
        session.watch.phase = "watching"; session.watch.reason = "waiting for the first live tick";
        session.message = `👁 ${activeName} — waiting for the first live tick`; broadcast(); await sleep(900); continue;
      }

      session.watch.phase = "armed"; applyDecisionToWatch(entry, lastRadar);

      if (!entry.ready) {
        if (inRecovery && !LOCKED && Date.now() - lastHuntAt >= RECOVERY_HUNT_MS) {
          lastHuntAt = Date.now(); session.watch.phase = "hunting"; session.watch.reason = "hunting all markets for a bar-clearing recovery shot…";
          session.message = `🔎 Recovery hunt — scanning all markets for a clean Rise/Fall shot`; broadcast();
          const hunt = await huntRecoveryShot();
          if (hunt && hunt.symbol !== activeSymbol) {
            activeSymbol = hunt.symbol; activeName = hunt.name; session.watch.switched = true;
            await refitActive(); session.message = `🔁 Recovery shot found on ${activeName} — firing ${hunt.dec.side!.label}`; broadcast(); await sleep(300); continue;
          }
          if (hunt) { session.watch.reason = hunt.dec.reason; await sleep(300); continue; }
        }
        session.watch.phase = "watching"; session.watch.reason = entry.reason;
        session.message = inRecovery ? `🛡 Recovery armed — ${entry.reason}` : `👁 ${entry.side?.label ?? "Rise/Fall"} on ${activeName} — ${entry.reason}`;
        broadcast(); await sleep(900); continue;
      }

      const fireContract: SurgeContract = entry.side!;
      const expectSet = inRecovery ? SURGE_RECOVERY_CONTRACTS : SURGE_NORMAL_CONTRACTS;
      if (!isAutomatedMarket(activeSymbol) || !expectSet.some(c => c.id === fireContract.id)) {
        session.running = false; session.message = "⚠️ Sovereignty check failed — session halted before firing";
        logger.error({ activeSymbol, fireContract, inRecovery }, "Vector Surge sovereignty violation"); broadcast(); return;
      }

      const payoutQuote = await resolveRecoveryPayout({ symbol: activeSymbol, contractType: fireContract.contractType, duration: SURGE_DURATION, durationUnit: SURGE_DURATION_UNIT, currency });
      const payout = payoutQuote.payoutMultiplier || fireContract.payout;

      if (inRecovery) {
        try {
          const fresh = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
          if (fresh.length > 0) { const v = Number((fresh[0] as any).botRecoveryMarkup); if (Number.isFinite(v)) botRecoveryMarkup = v; }
        } catch { /* keep */ }
      }

      const stake = inRecovery ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, payout, botRecoveryMarkup) : config.stake;
      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing"; session.watch.reason = `firing ${fireContract.label} on ${activeName}`;
      session.currentStake = stake; session.currentMarket = activeName; session.currentContractType = fireContract.contractType;
      session.message = inRecovery ? `🎯 [Recovery R${sharedStep}] ${fireContract.label} on ${activeName} · $${stake.toFixed(2)}` : `🎯 ${fireContract.label} on ${activeName} · $${stake.toFixed(2)}`;
      broadcast();

      const reason = `[Vector Surge${inRecovery ? " RECOVERY" : ""}] ${fireContract.label} on ${activeName} · P(${(entry.read!.p * 100).toFixed(1)}%) vs bar(${(entry.bar * 100).toFixed(1)}%) · pair-risk ${(entry.read!.pairRisk * 100).toFixed(0)}% · qLL ${(entry.read!.qLL * 100).toFixed(0)}% · no-ratchet bar`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId, symbol: activeSymbol, displayName: activeName, contractType: fireContract.contractType,
        stake: String(Math.round(stake * 100) / 100), direction: "hold", status: "open",
        aiConfidence: String(Math.round(entry.read!.p * 100)), aiRiskScore: "15", isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`, duration: SURGE_DURATION, durationUnit: SURGE_DURATION_UNIT,
      }).returning();

      let won = false; let profit = 0;
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, { symbol: activeSymbol, contractType: fireContract.contractType, stake: Math.round(stake * 100) / 100, duration: SURGE_DURATION, durationUnit: SURGE_DURATION_UNIT, currency, accountId: accounts[0].derivAccountId ?? accounts[0].loginId } as any);
          const result = await waitForContractResult(token!, accounts[0].derivAccountId ?? accounts[0].loginId, liveResult.contractId, 30_000);
          won = result.won; profit = result.profit; entryPrice = Number(result.entrySpot) || liveResult.buyPrice; exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          logger.warn({ err }, "Vector Surge live execution error — returning to the watch");
          try { await db.update(tradesTable).set({ status: "error", profit: "0", payout: "0", closedAt: new Date(), agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]` }).where(eq(tradesTable.id, journaled.id)); } catch { /* best-effort */ }
          session.watch.phase = "watching"; session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}. Back to watching.`; broadcast(); await sleep(2000); continue;
        }
      } else {
        session.watch.phase = "settling";
        const beforePrice = tickManager.getLatestPrice(activeSymbol) ?? entryPrice;
        let lastPrice = beforePrice;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const cur = tickManager.getLatestPrice(activeSymbol);
          if (cur !== null && cur !== beforePrice) { lastPrice = cur; break; }
          if (cur !== null) lastPrice = cur;
        }
        exitPrice = lastPrice;
        if (fireContract.id === "rise") won = exitPrice > beforePrice;
        else won = exitPrice < beforePrice;
        // flat is a loss for both: won stays false when equal
        if (exitPrice === beforePrice) won = false;
        profit = won ? stake * (payout - 1) : -stake;
        entryPrice = beforePrice;
      }

      session.tradeCount++; session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) { session.winCount++; session.lastResult = "won"; session.currentLossRun = 0; }
      else { session.lossCount++; session.lastResult = "lost"; session.currentLossRun++; session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun); }

      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, fireContract.contractType, payout);

      try {
        await db.update(tradesTable).set({ status: won ? "won" : "lost", payout: String(won ? Math.round((stake + profit) * 100) / 100 : 0), profit: String(Math.round(profit * 100) / 100), entryPrice: String(entryPrice), exitPrice: String(exitPrice), closedAt: new Date() }).where(eq(tradesTable.id, journaled.id));
      } catch (dbErr) { logger.warn({ dbErr }, "Vector Surge: failed to settle the journaled trade"); }

      if (!isLive && Number.isFinite(availableBalance)) availableBalance = Math.max(0, availableBalance + profit);
      if (isLive) {
        try {
          const newBal = await getLiveBalance(token!, accounts[0]?.derivAccountId ?? accounts[0]?.loginId);
          if (newBal !== null && accounts.length > 0) { availableBalance = newBal; await db.update(accountsTable).set({ balance: String(newBal), updatedAt: new Date() }).where(eq(accountsTable.id, accounts[0].id)); }
        } catch { /* best-effort */ }
      }

      session.watch = { ...freshWatch(), ticksWatched: session.watch.ticksWatched, confidence: session.activeRead?.confidence ?? 0, verdict: session.activeRead?.verdict ?? "—" };
      lastEntry = null; lastReanalyzeAt = 0;
      session.message = won ? `✅ +$${profit.toFixed(2)} · ${session.winCount}/${session.tradeCount}${inRecovery ? " · debt cleared — back to Rise/Fall" : " · next shot re-measured"}` : `❌ −$${Math.abs(profit).toFixed(2)} · ${session.currentLossRun} in a row · bar frozen, recovery hunts the best Rise/Fall`;
      broadcast();

      if (session.totalProfit >= config.takeProfit) { session.running = false; session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached in ${session.tradeCount} shots.`; broadcast(); return; }
      if (session.totalProfit <= -config.stopLoss) { session.running = false; session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit after ${session.tradeCount} shots. Session stopped safely.`; broadcast(); return; }

      await sleep(won ? (inRecovery ? 400 : 2500) : 1500);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++; logger.error({ err, consecutiveErrors }, "Vector Surge stability catch — keeping the session alive");
      session.message = `Engine stabilizing… retry ${consecutiveErrors} — the session will keep running`; broadcast(); await sleep(Math.min(15000, 600 * consecutiveErrors));
    }
  }
  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) { session.message = "Session stopped"; broadcast(); }
}
