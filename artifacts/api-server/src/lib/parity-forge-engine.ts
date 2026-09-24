/**
 * Parity Forge — Even/Odd parity specialist with recovery-first intelligence.
 *
 * Normal:   Even / Odd  (DIGITEVEN / DIGITODD, 1.95×, 50% fair)
 * Recovery: Even / Odd  (same contracts — recovery is about WHEN, not what)
 *
 * The brain lives in `./parity-forge-analysis` (four parity lenses, log-pool
 * fusion, loss-pair-aware side utility, STATIC recovery bar). This module is
 * the session shell and deliberately reuses the same proven infrastructure as
 * the other dedicated bots with zero behaviour changes:
 *
 * - digits + execution: `tickManager` / `getDeepDigits` / `executeLiveTrade` /
 *   `waitForContractResult` from `./deriv` (1-tick DIGITEVEN/DIGITODD)
 * - the ONE shared debt-driven recovery ledger (`./agents/recovery-engine`,
 *   sized by `getBotRecoveryStake` — the identical formula every bot uses)
 * - the ONE single-executor arbiter (`./engine-arbiter`, owner `"bots"`)
 * - live payouts from `./recovery-payout`
 * - one owner-scoped SSE broadcast (`./sse`)
 *
 * RECOVERY-FIRST LOOP (the whole point of this bot):
 *   - a normal loss drops straight into recovery mode;
 *   - recovery evaluates BOTH sides every tick and fires the BEST shot the
 *     moment its fused win probability clears the STATIC break-even bar —
 *     there is NO post-loss tightening, NO cool-down ladder, NO gate that
 *     hardens as debt grows (see parity-forge-analysis: the bar is a frozen
 *     const and `decideRecovery` cannot even receive a loss run);
 *   - if no side shows tilt the bot waits — and in SWITCHING mode it HUNTS
 *     across every digit market and migrates to the first/best market with a
 *     bar-clearing recovery shot. LOCKED mode stays and waits on its market.
 *
 * Deploy flow (scan-first): `scanForParityForge` measures all digit markets
 * with an honest walk-forward of the exact live policy (including the recovery
 * episode metrics — recovery hit rate and loss pairs) and returns ranked
 * cards. The user picks LOCKED or SWITCHING and deploys; verdicts are labels,
 * never gates.
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
import { createSessionScoped, runWithSession } from "./session";
import { registerLiveBot, unregisterLiveBot } from "./live-registry";
import {
  PARITY_FORGE_NORMAL_CONTRACTS,
  PARITY_FORGE_RECOVERY_BAR,
  PARITY_FORGE_RECOVERY_CONTRACTS,
  type ParityForgeDiag,
  ParityForgePolicy,
  scoreParityForgeMarket,
  type ParityForgeContract,
  type ParityForgeDecision,
  type ParityForgeParams,
  type ParityForgeReplayMetrics,
  type ParityForgeSideMode,
  type ParityForgeVerdict,
} from "./parity-forge-analysis";

export const PARITY_FORGE_BOT_ID = "parity-forge";
export const PARITY_FORGE_BOT_NAME = "Parity Forge";
const PARITY_FORGE_DURATION = 1;
const PARITY_FORGE_DURATION_UNIT = "t";

/** Digits re-read from the feed every scan/refit pass. */
const SCAN_DIGITS = 4500;
/** Warm digits for a cross-market recovery hunt (fast + sufficient). */
const HUNT_DIGITS = 2500;
/** Re-measure cadence — live never trusts a stale fit for long. */
const REFIT_LOCKED_MS = 25_000;
const REFIT_SWITCHING_MS = 45_000;
/** Switching migrates only for a MEANINGFULLY better edge (anti-flip). */
const SWITCH_MARGIN = 0.015;
/** In recovery (switching mode) hunt a better market this often. */
const RECOVERY_HUNT_MS = 3_000;
/** Minimum digits before the live policy is allowed to exist. */
const MIN_LIVE_DIGITS = 150;

// ── Types ───────────────────────────────────────────────────────────────────

export interface ParityForgeDeploySpec {
  sideMode: ParityForgeSideMode;
}

export interface ParityForgeCandidate {
  symbol: string;
  displayName: string;
  verdict: ParityForgeVerdict;
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
  params: ParityForgeParams;
  diag: ParityForgeDiag;
  thinData: boolean;
  metrics: ParityForgeReplayMetrics;
}

export interface ParityForgeScanResult {
  suitable: boolean;
  best: ParityForgeCandidate | null;
  bestAvailable: ParityForgeCandidate | null;
  allScored: ParityForgeCandidate[];
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

export interface ParityForgeConfig {
  ownerSessionId?: string;
  spec: ParityForgeDeploySpec;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  symbol: string;
  displayName: string;
  params: ParityForgeParams;
  lockedAnalysis?: ParityForgeCandidate;
}

export interface ParityForgeDeployed {
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

export interface ParityForgeWatch {
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
  lenses: number[];
  /** Always-on recovery radar: the best recovery shot right now. */
  recoveryRadar: Array<{ label: string; p: number; utility: number; ready: boolean }>;
  reason: string;
  switched: boolean;
  ticksWatched: number;
  confidence: number;
  verdict: string;
}

export interface ParityForgeStatus {
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
    sideMode: ParityForgeSideMode;
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    marketMode: "locked" | "switching";
    lockedSymbol?: string;
  };
  parityForgeDeployed?: ParityForgeDeployed;
  parityForgeWatch?: ParityForgeWatch;
}

// ── Session state ───────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: ParityForgeConfig | null;
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
  watch: ParityForgeWatch;
  activeSymbol?: string;
  activeName?: string;
  activeRead?: ParityForgeCandidate | null;
}

function freshWatch(): ParityForgeWatch {
  return {
    phase: "watching",
    mode: "normal",
    sideLabel: "—",
    altLabel: "—",
    p: 0,
    altP: 0,
    bar: PARITY_FORGE_RECOVERY_BAR,
    ready: false,
    pairRisk: 0,
    qLL: 0,
    lenses: [0, 0, 0, 0, 0, 0],
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

// ── ONE STATE PER ACCOUNT SESSION ─────────────────────────────────────────────
// This was previously a module-level singleton, so starting this engine for one
// account silently overwrote every other account's session — its stake,
// counters, config and running flag (and a stop in one account killed the other
// account's bot). Every read and write of `session` now resolves through
// AsyncLocalStorage to the CALLING account's own state, so two connected Deriv
// accounts can run this engine concurrently without interference.
// `replaceSession()` (used by startSession) resets only this account's state.
const { state: session, replace: replaceSession } =
  createSessionScoped<SessionState>(freshSession);

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

registerBotEngine("parity-forge", () => ({ running: session.running, name: "Parity Forge" }));

export function isRunning(): boolean {
  return session.running;
}

function deployed(read: ParityForgeCandidate | null | undefined): ParityForgeDeployed | undefined {
  if (!read) return undefined;
  const num = (v: unknown, fallback = 0): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    symbol: read.symbol,
    displayName: read.displayName,
    verdict: read.verdict,
    confidence: num(read.confidence),
    paperEdgePerDollar: num(read.paperEdgePerDollar),
    normalHitRate: num(read.normalHitRate),
    normalShots: num(read.normalShots),
    recoveryHitRate: num(read.recoveryHitRate),
    recoveryShots: num(read.recoveryShots),
    recoveryLossPairs: num(read.recoveryLossPairs),
    breakEven: num(read.breakEven, 1 / 1.95),
  };
}

export function getStatus(): ParityForgeStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  return {
    running: session.running,
    botId: cfg ? PARITY_FORGE_BOT_ID : null,
    botName: cfg ? PARITY_FORGE_BOT_NAME : null,
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
    currentLossRun: session.currentLossRun,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    config: cfg
      ? {
          sideMode: cfg.spec.sideMode,
          stake: cfg.stake,
          stopLoss: cfg.stopLoss,
          takeProfit: cfg.takeProfit,
          maxRecoverySteps: cfg.maxRecoverySteps,
          marketMode: cfg.marketMode,
          ...(cfg.lockedSymbol ? { lockedSymbol: cfg.lockedSymbol } : {}),
        }
      : undefined,
    parityForgeDeployed: session.running ? deployed(session.activeRead) : undefined,
    parityForgeWatch: session.running ? session.watch : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  unregisterLiveBot(PARITY_FORGE_BOT_ID);
  broadcast();
  logger.info({ botId: PARITY_FORGE_BOT_ID }, "Parity Forge session stopped");
}

// ── Pre-deploy scan ─────────────────────────────────────────────────────────

const VERDICT_RANK: Record<ParityForgeVerdict, number> = { prime: 0, viable: 1, thin: 2 };

function toCandidate(symbol: string, displayName: string, read: ReturnType<typeof scoreParityForgeMarket>): ParityForgeCandidate {
  const m = read.metrics;
  return {
    symbol,
    displayName,
    verdict: read.verdict,
    confidence: read.confidence,
    paperEdgePerDollar: read.paperEdgePerDollar,
    normalHitRate: m.normalHitRate,
    normalShots: m.normalShots,
    normalHits: m.normalHits,
    recoveryHitRate: m.recoveryHitRate,
    recoveryShots: m.recoveryShots,
    recoveryHits: m.recoveryHits,
    recoveryLossPairs: m.recoveryLossPairs,
    recoveryLosses: m.recoveryLosses,
    avgTicksInRecovery: m.avgTicksInRecovery,
    fireRatePer100: m.fireRatePer100,
    breakEven: read.breakEven,
    params: read.params,
    diag: read.diag,
    thinData: read.thinData,
    metrics: m,
  };
}

export async function scanForParityForge(
  ownerSessionId: string | undefined,
): Promise<ParityForgeScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const all: ParityForgeCandidate[] = [];
  let deepest = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", {
      botId: PARITY_FORGE_BOT_ID,
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
    all.push(toCandidate(market.symbol, market.displayName, scoreParityForgeMarket(digits)));
    await sleep(5);
  }

  const ranked = all.sort(
    (a, b) =>
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      b.paperEdgePerDollar - a.paperEdgePerDollar ||
      b.recoveryHitRate - a.recoveryHitRate,
  );

  broadcastSSE("bot_scan_progress", {
    botId: PARITY_FORGE_BOT_ID,
    scanning: null,
    symbol: null,
    scanned: markets.length,
    total: markets.length,
  }, ownerSessionId);

  const best = ranked[0];
  if (!best || best.thinData) {
    return {
      suitable: false, best: null, bestAvailable: null, allScored: [],
      reason: "Not enough history yet — the digit feed is still warming up. Wait a moment and re-scan.",
      marketsScanned: markets.length, historyDepth: deepest,
    };
  }

  const suitable = best.verdict !== "thin";
  const reason = suitable
    ? `${best.displayName} — measured ${(best.recoveryHitRate * 100).toFixed(0)}% recovery hits over ${best.recoveryShots} recovery shots (${best.recoveryLossPairs} loss pair${best.recoveryLossPairs === 1 ? "" : "s"}), ${(best.normalHitRate * 100).toFixed(0)}% normal over ${best.normalShots} shots.`
    : `${best.displayName} is the best available (${best.verdict.toUpperCase()}) — measured ${(best.recoveryHitRate * 100).toFixed(0)}% recovery over ${best.recoveryShots} shots. Starting it is a deliberate choice; the bar never hardens after losses.`;

  return {
    suitable,
    best: suitable ? best : null,
    bestAvailable: best,
    allScored: ranked.filter(c => !c.thinData).slice(0, 12),
    reason,
    marketsScanned: markets.length,
    historyDepth: deepest,
  };
}

// ── Session start ───────────────────────────────────────────────────────────

export async function startSession(config: ParityForgeConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "Parity Forge is already active — stop it first" };

  // ── One executing bot engine at a time (protects the single ledger) ──
  const otherEngines = runningOtherEngines("parity-forge");
  if (otherEngines.length > 0) {
    return {
      ok: false,
      error: `${otherEngines[0].name} is already trading on this account. Stop it first — one engine at a time owns the shared recovery ledger.`,
    };
  }


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
  if (!config.params || !Number.isFinite(config.params.tau) || !Array.isArray(config.params.weights)) {
    return fail("Run the scan first — this bot only deploys a measurement it has made");
  }

  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  if (!market || !market.digitEnabled) return fail("This bot needs a digit-enabled market");

  replaceSession({
    ...freshSession(),
    running: true,
    sessionId: `bot_parityforge_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    activeSymbol: config.symbol,
    activeName: config.displayName,
    activeRead: config.lockedAnalysis ?? null,
    message: config.marketMode === "locked"
      ? `Locked on ${config.displayName} — Even/Odd parity, recovery holds this market.`
      : `Deployed on ${config.displayName} — Even/Odd parity, recovery hunts best market.`,
  });
  if (session.activeRead) {
    session.watch.confidence = session.activeRead.confidence;
    session.watch.verdict = session.activeRead.verdict;
  }

  logger.info({
    botId: PARITY_FORGE_BOT_ID,
    sideMode: config.spec.sideMode,
    marketMode: config.marketMode,
    symbol: config.symbol,
  }, "Parity Forge session starting");
  // Publish to the cross-session live registry so the layout's live indicator
  // can see (and open/stop) this engine from any page after a refresh.
  registerLiveBot(PARITY_FORGE_BOT_ID, () => getStatus());
  broadcast();

  runWithSession(config.ownerSessionId ?? "legacy", () =>
    runLoop(config).catch(err => {
      logger.error({ err }, "Parity Forge runLoop error");
      session.running = false;
      session.message = `⚠️ ${friendlyErrorMessage(err)}`;
      broadcast();
    }).finally(() => releaseTradingOwnership("bots")),
  );

  return { ok: true };
}

// ── Execution loop ──────────────────────────────────────────────────────────

function radarOf(policy: ParityForgePolicy, digits: number[], idx: number) {
  return PARITY_FORGE_RECOVERY_CONTRACTS.map(c => {
    const r = policy.readSide(digits, idx, c);
    return { label: c.label, p: r.p, utility: r.utility, ready: r.p >= PARITY_FORGE_RECOVERY_BAR };
  }).sort((a, b) => b.utility - a.utility);
}

function applyDecisionToWatch(dec: ParityForgeDecision, radar: ParityForgeWatch["recoveryRadar"]) {
  session.watch.mode = dec.mode;
  session.watch.sideLabel = dec.side?.label ?? "—";
  session.watch.altLabel = dec.alt?.contract.label ?? "—";
  session.watch.p = dec.read?.p ?? 0;
  session.watch.altP = dec.alt?.p ?? 0;
  session.watch.bar = dec.bar;
  session.watch.ready = dec.ready;
  session.watch.pairRisk = dec.read?.pairRisk ?? 0;
  session.watch.qLL = dec.read?.qLL ?? 0;
  session.watch.lenses = dec.read?.lenses ?? [0, 0, 0, 0, 0, 0];
  session.watch.recoveryRadar = radar;
  session.watch.reason = dec.reason;
}

async function runLoop(config: ParityForgeConfig) {
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

  // Read THIS account's persisted recovery ledger (the recovery journal) before
  // the first trade. Without this, a restart/redeploy left the engine blind to
  // debt another engine had already recorded: it re-opened normal trades and
  // repeated the same recovery stake while the journal still showed the loss.
  const persistedRecovery = (settings[0] as any)?.recoveryStateJson;
  if (persistedRecovery) {
    try { recoveryEngine.hydrateStateIfNeeded(persistedRecovery); }
    catch { /* malformed row — this account's ledger starts fresh */ }
  }

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

  let activeSymbol = config.symbol;
  let activeName = config.displayName;

  let policy: ParityForgePolicy | null = null;
  let lastDigitCount = 0;
  /** Absolute index the lenses have been fed through (end-append verified). */
  let fedLen = 0;
  let fedTail = "";
  let lastEntry: ParityForgeDecision | null = null;
  let lastRadar: ParityForgeWatch["recoveryRadar"] = [];
  let lastReanalyzeAt = 0;
  let lastHuntAt = 0;
  let consecutiveErrors = 0;

  async function readDigits(symbol: string, count = SCAN_DIGITS): Promise<number[]> {
    try {
      return await getDeepDigits(symbol, count);
    } catch {
      return tickManager.getDigits(symbol, count);
    }
  }

  /** Re-measure the ACTIVE market; the adapted normal valve survives refits. */
  async function refitActive(): Promise<ParityForgeCandidate | null> {
    const digits = await readDigits(activeSymbol);
    if (digits.length < MIN_LIVE_DIGITS) return null;
    const read = scoreParityForgeMarket(digits);
    const candidate = toCandidate(activeSymbol, activeName, read);
    const prevBar = policy?.normalBar;
    policy = new ParityForgePolicy(
      prevBar !== undefined
        ? { ...read.params, normalInitBar: prevBar }
        : read.params,
    );
    for (let i = 0; i < digits.length; i++) policy.update(digits, i);
    lastDigitCount = digits.length;
    fedLen = digits.length;
    fedTail = digits.slice(-3).join(",");
    lastEntry = null;

    session.activeSymbol = activeSymbol;
    session.activeName = activeName;
    session.activeRead = candidate;
    session.currentMarket = activeName;
    session.watch.confidence = candidate.confidence;
    session.watch.verdict = candidate.verdict;
    return candidate;
  }

  /** Switching only: re-measure every market; migrate past the margin. */
  async function maybeMigrate(): Promise<{ migrated: boolean }> {
    if (LOCKED) {
      await refitActive();
      return { migrated: false };
    }
    const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
    let best: ParityForgeCandidate | null = null;
    let incumbentEdge = Number.NEGATIVE_INFINITY;
    for (const m of markets) {
      const digits = await readDigits(m.symbol);
      if (digits.length < MIN_LIVE_DIGITS) continue;
      const c = toCandidate(m.symbol, m.displayName, scoreParityForgeMarket(digits));
      if (m.symbol === activeSymbol) incumbentEdge = c.paperEdgePerDollar;
      if (!best || VERDICT_RANK[c.verdict] < VERDICT_RANK[best.verdict]
          || (c.verdict === best.verdict && c.paperEdgePerDollar > best.paperEdgePerDollar)) best = c;
    }
    if (best && best.symbol !== activeSymbol
        && best.verdict !== "thin"
        && best.paperEdgePerDollar - incumbentEdge > SWITCH_MARGIN) {
      activeSymbol = best.symbol;
      activeName = best.displayName;
      await refitActive();
      return { migrated: true };
    }
    await refitActive();
    return { migrated: false };
  }

  /**
   * RECOVERY HUNT (switching mode): find the best bar-clearing recovery shot
   * ACROSS markets right now. The active market reads the live policy; every
   * other market gets a transient warmed on its own tape. The shot that exists
   * somewhere is the shot this bot takes.
   */
  async function huntRecoveryShot(): Promise<{ symbol: string; name: string; dec: ParityForgeDecision } | null> {
    const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
    let best: { symbol: string; name: string; dec: ParityForgeDecision } | null = null;
    for (const m of markets) {
      const digits = await readDigits(m.symbol, HUNT_DIGITS);
      if (digits.length < MIN_LIVE_DIGITS) continue;
      let scan: ParityForgePolicy;
      if (policy && m.symbol === activeSymbol) {
        scan = policy;
      } else {
        scan = new ParityForgePolicy(config.params);
        for (let i = 0; i < digits.length; i++) scan.update(digits, i);
      }
      const dec = scan.decideRecovery(digits, digits.length - 1);
      if (dec.ready && dec.side && dec.read && (!best || (dec.read.utility > best.dec.read!.utility))) {
        best = { symbol: m.symbol, name: m.displayName, dec };
      }
    }
    return best;
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

      // ── PERIODIC RE-MEASURE ──
      const needsReanalyze = policy === null || Date.now() - lastReanalyzeAt >= REANALYZE_MS;
      if (needsReanalyze) {
        const before = activeSymbol;
        const { migrated } = await maybeMigrate();
        lastReanalyzeAt = Date.now();
        if (!policy) {
          session.watch.phase = "watching";
          session.watch.reason = "collecting history for the live policy";
          session.message = `Holding on ${activeName} — collecting history for the live policy`;
          broadcast();
          await sleep(1500);
          continue;
        }
        if (migrated && before !== activeSymbol) {
          session.watch.switched = true;
          session.message = `🔁 Migrated to ${activeName} — it measured better`;
        }
      }

      // ── Feed ONLY genuinely new ticks, exactly once each ──
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

      const live = policy as ParityForgePolicy | null;
      let newTicks = 0;
      if (live && tailIdx >= 0) {
        const junction = fedLen > 0 ? digits.slice(Math.max(0, fedLen - 3), fedLen).join(",") : "";
        if (digits.length > fedLen && (fedLen === 0 || junction === fedTail)) {
          for (let i = fedLen; i <= tailIdx; i++) live.update(digits, i);
          newTicks = digits.length - fedLen;
          fedLen = digits.length;
          fedTail = digits.slice(-3).join(",");
        } else if (digits.length >= fedLen && digits.slice(-3).join(",") !== fedTail) {
          live.update(digits, tailIdx);
          newTicks = 1;
          fedLen = digits.length;
          fedTail = digits.slice(-3).join(",");
        }
      }

      if (live && newTicks > 0) {
        // ONE decision per tick. Recovery and normal have separate selectors;
        // neither of them can see the loss run (see parity-forge-analysis).
        const dec = inRecovery
          ? live.decideRecovery(digits, tailIdx)
          : live.decideNormal(digits, tailIdx, SPEC.sideMode);
        lastEntry = dec;
        lastRadar = radarOf(live, digits, tailIdx);
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
      applyDecisionToWatch(entry, lastRadar);

      if (!entry.ready) {
        // Recovery has ONE wait reason: no tilt anywhere armed. In switching
        // mode that triggers the cross-market HUNT instead of a passive wait.
        if (inRecovery && !LOCKED && Date.now() - lastHuntAt >= RECOVERY_HUNT_MS) {
          lastHuntAt = Date.now();
          session.watch.phase = "hunting";
          session.watch.reason = "hunting all markets for a bar-clearing recovery shot…";
          session.message = `🔎 Recovery hunt — scanning all markets for a clean Even/Odd shot`;
          broadcast();
          const hunt = await huntRecoveryShot();
          if (hunt && hunt.symbol !== activeSymbol) {
            activeSymbol = hunt.symbol;
            activeName = hunt.name;
            session.watch.switched = true;
            await refitActive();
            session.message = `🔁 Recovery shot found on ${activeName} — firing ${hunt.dec.side!.label}`;
            broadcast();
            await sleep(300);
            continue; // next pass fires with the migrated, fitted policy
          }
          if (hunt) {
            // Same market had it after all (or hunt confirmed local) — loop will fire.
            session.watch.reason = hunt.dec.reason;
            await sleep(300);
            continue;
          }
        }
        session.watch.phase = "watching";
        session.watch.reason = entry.reason;
        session.message = inRecovery
          ? `🛡 Recovery armed — ${entry.reason}`
          : `👁 ${entry.side?.label ?? "Even/Odd"} on ${activeName} — ${entry.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }

      // ── SOVEREIGNTY — re-asserted immediately before every buy ──
      let fireContract: ParityForgeContract = entry.side!;
      const expectSet = inRecovery ? PARITY_FORGE_RECOVERY_CONTRACTS : PARITY_FORGE_NORMAL_CONTRACTS;
      if (!isAutomatedMarket(activeSymbol) || !expectSet.some(c => c.id === fireContract.id)) {
        session.running = false;
        session.message = "⚠️ Sovereignty check failed — session halted before firing";
        logger.error({ activeSymbol, fireContract, inRecovery }, "Parity Forge sovereignty violation");
        broadcast();
        return;
      }

      // ── EV-AWARE SIDE CHOICE (selection upgrade, never a gate) ──
      // The selector already committed to firing this tick — this block only
      // points the shot. Even/Odd payouts are quoted separately and drift
      // apart (1.90×–2.00×), so the same fused probability buys different
      // edge on different sides: quote BOTH sides in parallel and fire the
      // one with the highest p·payout. Only when the user armed BOTH sides —
      // a one-sided deployment keeps its sovereign side.
      let firedRead = entry.read;
      let sideQuotes: Array<{ c: ParityForgeContract; pay: number }> = [];
      if (SPEC.sideMode === "both") {
        sideQuotes = await Promise.all(expectSet.map(c =>
          resolveRecoveryPayout({
            symbol: activeSymbol,
            contractType: c.contractType,
            duration: PARITY_FORGE_DURATION,
            durationUnit: PARITY_FORGE_DURATION_UNIT,
            currency,
          }).then(q => ({ c, pay: q.payoutMultiplier || c.payout }))
            .catch(() => ({ c, pay: c.payout }))
        ));
        const pOf = (id: string): number =>
          entry.side && entry.side.id === id ? (entry.read?.p ?? 0)
          : entry.alt && entry.alt.contract.id === id ? entry.alt.p
          : 0;
        let best = sideQuotes.find(q => q.c.id === fireContract.id);
        for (const q of sideQuotes) {
          if (pOf(q.c.id) * q.pay > pOf(best!.c.id) * best!.pay) best = q;
        }
        if (best && best.c.id !== fireContract.id) {
          logger.info({ from: fireContract.id, to: best.c.id, pay: best.pay }, "Parity Forge EV side upgrade");
          fireContract = best.c;
          firedRead = fireContract.id === entry.side?.id ? entry.read : entry.alt;
        }
      }
      if (!sideQuotes.some(q => q.c.id === fireContract.id)) {
        const payoutQuote = await resolveRecoveryPayout({
          symbol: activeSymbol,
          contractType: fireContract.contractType,
          duration: PARITY_FORGE_DURATION,
          durationUnit: PARITY_FORGE_DURATION_UNIT,
          currency,
        });
        sideQuotes = [{ c: fireContract, pay: payoutQuote.payoutMultiplier || fireContract.payout }];
      }
      const payout = sideQuotes.find(q => q.c.id === fireContract.id)!.pay;

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
      session.watch.reason = `firing ${fireContract.label} on ${activeName} (EV-quoted ${payout.toFixed(2)}×)`;
      session.currentStake = stake;
      session.currentMarket = activeName;
      session.currentContractType = fireContract.contractType;
      session.message = inRecovery
        ? `🎯 [Recovery R${sharedStep}] ${fireContract.label} on ${activeName} · $${stake.toFixed(2)}`
        : `🎯 ${fireContract.label} on ${activeName} · $${stake.toFixed(2)}`;
      broadcast();

      const reason = `[Parity Forge${inRecovery ? " RECOVERY" : ""}] ${fireContract.label} on ${activeName} · ` +
        `P(${((firedRead?.p ?? 0) * 100).toFixed(1)}%) vs bar(${(entry.bar * 100).toFixed(1)}%) · ` +
        `EV-quoted payout ${payout.toFixed(2)}× · ` +
        `pair-risk ${((firedRead?.pairRisk ?? 0) * 100).toFixed(0)}% · qLL ${((firedRead?.qLL ?? 0) * 100).toFixed(0)}% · ` +
        `no-ratchet bar`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: activeSymbol,
        displayName: activeName,
        contractType: fireContract.contractType,
        stake: String(Math.round(stake * 100) / 100),
        direction: "hold",
        status: "open",
        aiConfidence: String(Math.round((firedRead?.p ?? 0) * 100)),
        aiRiskScore: "15",
        isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`,
        duration: PARITY_FORGE_DURATION,
        durationUnit: PARITY_FORGE_DURATION_UNIT,
      }).returning();

      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: activeSymbol,
            contractType: fireContract.contractType,
            stake: Math.round(stake * 100) / 100,
            duration: PARITY_FORGE_DURATION,
            durationUnit: PARITY_FORGE_DURATION_UNIT,
            currency,
            accountId: accounts[0].derivAccountId ?? accounts[0].loginId,
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
          logger.warn({ err }, "Parity Forge live execution error — returning to the watch");
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
        const isEven = (digit ?? 0) % 2 === 0;
        won = (fireContract.id === "even" && isEven) || (fireContract.id === "odd" && !isEven);
        profit = won ? stake * (payout - 1) : -stake;
      }

      session.tradeCount++;
      session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) {
        session.winCount++;
        session.lastResult = "won";
        session.currentLossRun = 0;
      } else {
        session.lossCount++;
        session.lastResult = "lost";
        session.currentLossRun++;
        session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun);
      }

      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, fireContract.contractType, payout);

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
        logger.warn({ dbErr }, "Parity Forge: failed to settle the journaled trade");
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
      lastEntry = null;
      lastReanalyzeAt = 0; // fresh measurement before the next shot
      session.message = won
        ? `✅ +$${profit.toFixed(2)} · ${session.winCount}/${session.tradeCount}${inRecovery ? " · debt cleared — back to Even/Odd" : " · next shot re-measured"}`
        : `❌ −$${Math.abs(profit).toFixed(2)} · ${session.currentLossRun} in a row · bar frozen, recovery hunts the best Even/Odd`;
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

      // Recovery re-arms IMMEDIATELY (no cool-down) — only a feed pause.
      await sleep(won ? (inRecovery ? 400 : 2500) : 1500);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Parity Forge stability catch — keeping the session alive");
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
