/**
 * Over/Under Navigator execution engine.
 *
 * This is a dedicated engine rather than a generic barrier preset. The plan
 * carries four user-selected barriers: normal Over/Under and recovery
 * Over/Under. The recovery selector is always evaluated against both armed
 * recovery contracts and uses a frozen fair-rate bar; the loss-run is never
 * used to make the bar stricter. In switching mode, a recovery hunt can move
 * to another digit market when the current tape has no good setup.
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
import { runWithSession } from "./session";
import { registerLiveBot, unregisterLiveBot } from "./live-registry";
import {
  contractsForPlan,
  scoreNavigatorMarket,
  NavigatorPolicy,
  type NavigatorContract,
  type NavigatorDecision,
  type NavigatorMarketRead,
  type NavigatorParams,
  type NavigatorPlan,
  type NavigatorSideMode,
  type NavigatorVerdict,
  validateNavigatorPlan,
  NAVIGATOR_MIN_MEASURE_DIGITS,
} from "./overunder-navigator-analysis";

export const NAVIGATOR_BOT_ID = "overunder-navigator";
export const NAVIGATOR_BOT_NAME = "Over/Under Navigator";
const DURATION = 1;
const DURATION_UNIT = "t";
const SCAN_DIGITS = 4500;
const HUNT_DIGITS = 2200;
const REFIT_MS = 30_000;
const HUNT_MS = 3_000;

export interface NavigatorCandidate {
  symbol: string;
  displayName: string;
  verdict: NavigatorVerdict;
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
  breakEvenNormal: number;
  breakEvenRecovery: number;
  params: NavigatorParams;
  diag: NavigatorMarketRead["diag"];
  thinData: boolean;
  metrics: NavigatorMarketRead["metrics"];
}

export interface NavigatorScanResult {
  suitable: boolean;
  best: NavigatorCandidate | null;
  bestAvailable: NavigatorCandidate | null;
  allScored: NavigatorCandidate[];
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

export interface NavigatorConfig {
  ownerSessionId?: string;
  plan: NavigatorPlan;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  symbol: string;
  displayName: string;
  params: NavigatorParams;
  lockedAnalysis?: NavigatorCandidate;
}

export interface NavigatorDeployed {
  symbol: string;
  displayName: string;
  verdict: string;
  confidence: number;
  paperEdgePerDollar: number;
  normalLabel: string;
  recoveryLabel: string;
  normalHitRate: number;
  normalShots: number;
  recoveryHitRate: number;
  recoveryShots: number;
  recoveryLossPairs: number;
  breakEvenNormal: number;
  breakEvenRecovery: number;
}

export interface NavigatorWatch {
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
  recoveryRadar: Array<{
    label: string;
    p: number;
    utility: number;
    bar: number;
    ready: boolean;
  }>;
  reason: string;
  switched: boolean;
  ticksWatched: number;
  confidence: number;
  verdict: string;
}

export interface NavigatorStatus {
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
  config?: Omit<
    NavigatorConfig,
    "ownerSessionId" | "params" | "lockedAnalysis"
  > & { params?: NavigatorParams };
  navigatorDeployed?: NavigatorDeployed;
  navigatorWatch?: NavigatorWatch;
}

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: NavigatorConfig | null;
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
  watch: NavigatorWatch;
  activeRead?: NavigatorCandidate | null;
}

function freshWatch(): NavigatorWatch {
  return {
    phase: "watching",
    mode: "normal",
    sideLabel: "—",
    altLabel: "—",
    p: 0,
    altP: 0,
    bar: 0,
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
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function broadcast() {
  const owner = session.config?.ownerSessionId;
  if (owner) broadcastSSE("bot_update", getStatus(), owner);
}

export function getOwnerSessionId() {
  return session.config?.ownerSessionId ?? null;
}
export function isRunning() {
  return session.running;
}
registerBotEngine(NAVIGATOR_BOT_ID, () => ({
  running: session.running,
  name: NAVIGATOR_BOT_NAME,
}));

function deployed(
  read: NavigatorCandidate | null | undefined,
  plan?: NavigatorPlan,
): NavigatorDeployed | undefined {
  if (!read) return undefined;
  const n = (v: unknown, fallback = 0) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    symbol: read.symbol,
    displayName: read.displayName,
    verdict: read.verdict,
    confidence: n(read.confidence),
    paperEdgePerDollar: n(read.paperEdgePerDollar),
    normalLabel: plan
      ? `Over ${plan.normalOver} / Under ${plan.normalUnder}`
      : "configured normal",
    recoveryLabel: plan
      ? `Over ${plan.recoveryOver} / Under ${plan.recoveryUnder}`
      : "configured recovery",
    normalHitRate: n(read.normalHitRate),
    normalShots: n(read.normalShots),
    recoveryHitRate: n(read.recoveryHitRate),
    recoveryShots: n(read.recoveryShots),
    recoveryLossPairs: n(read.recoveryLossPairs),
    breakEvenNormal: n(read.breakEvenNormal),
    breakEvenRecovery: n(read.breakEvenRecovery),
  };
}

export function getStatus(): NavigatorStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  return {
    running: session.running,
    botId: cfg ? NAVIGATOR_BOT_ID : null,
    botName: cfg ? NAVIGATOR_BOT_NAME : null,
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
          plan: cfg.plan,
          stake: cfg.stake,
          stopLoss: cfg.stopLoss,
          takeProfit: cfg.takeProfit,
          maxRecoverySteps: cfg.maxRecoverySteps,
          marketMode: cfg.marketMode,
          ...(cfg.lockedSymbol ? { lockedSymbol: cfg.lockedSymbol } : {}),
          symbol: cfg.symbol,
          displayName: cfg.displayName,
          params: cfg.params,
        }
      : undefined,
    navigatorDeployed: session.running
      ? deployed(session.activeRead, cfg?.plan)
      : undefined,
    navigatorWatch: session.running ? session.watch : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  unregisterLiveBot(NAVIGATOR_BOT_ID);
  broadcast();
  logger.info(
    { botId: NAVIGATOR_BOT_ID },
    "Over/Under Navigator session stopped",
  );
}

function toCandidate(
  symbol: string,
  displayName: string,
  read: NavigatorMarketRead,
): NavigatorCandidate {
  const m = read.metrics;
  const normal = read.normalContracts[0];
  const recovery = read.recoveryContracts[0];
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
    breakEvenNormal: normal?.payout ? 1 / normal.payout : 0,
    breakEvenRecovery: recovery?.payout ? 1 / recovery.payout : 0,
    params: read.params,
    diag: read.diag,
    thinData: read.thinData,
    metrics: m,
  };
}

export async function scanForNavigator(
  ownerSessionId: string | undefined,
  plan: NavigatorPlan,
): Promise<NavigatorScanResult> {
  const planError = validateNavigatorPlan(plan);
  if (planError) throw new Error(planError);
  const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
  const all: NavigatorCandidate[] = [];
  let deepest = 0;
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE(
      "bot_scan_progress",
      {
        botId: NAVIGATOR_BOT_ID,
        scanning: market.displayName,
        symbol: market.symbol,
        scanned: i,
        total: markets.length,
      },
      ownerSessionId,
    );
    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, SCAN_DIGITS);
    } catch {
      digits = tickManager.getDigits(market.symbol, SCAN_DIGITS);
    }
    deepest = Math.max(deepest, digits.length);
    if (digits.length >= NAVIGATOR_MIN_MEASURE_DIGITS)
      all.push(
        toCandidate(
          market.symbol,
          market.displayName,
          scoreNavigatorMarket(digits, plan),
        ),
      );
    await sleep(5);
  }
  const ranked = all.sort(
    (a, b) =>
      b.paperEdgePerDollar - a.paperEdgePerDollar ||
      b.recoveryHitRate - a.recoveryHitRate,
  );
  broadcastSSE(
    "bot_scan_progress",
    {
      botId: NAVIGATOR_BOT_ID,
      scanning: null,
      symbol: null,
      scanned: markets.length,
      total: markets.length,
    },
    ownerSessionId,
  );
  const best = ranked[0] ?? null;
  if (!best)
    return {
      suitable: false,
      best: null,
      bestAvailable: null,
      allScored: [],
      reason:
        "Not enough digit history yet — keep the page open for a moment and scan again.",
      marketsScanned: markets.length,
      historyDepth: deepest,
    };
  const reason = `${best.displayName} measured ${(best.recoveryHitRate * 100).toFixed(0)}% recovery hits over ${best.recoveryShots} shots, ${(best.normalHitRate * 100).toFixed(0)}% normal over ${best.normalShots} shots; recovery loss pairs ${best.recoveryLossPairs}.`;
  return {
    suitable: best.verdict !== "thin",
    best: best.verdict !== "thin" ? best : null,
    bestAvailable: best,
    allScored: ranked.slice(0, 12),
    reason,
    marketsScanned: markets.length,
    historyDepth: deepest,
  };
}

export async function startSession(
  config: NavigatorConfig,
): Promise<{ ok: boolean; error?: string }> {
  if (session.running)
    return {
      ok: false,
      error: `${NAVIGATOR_BOT_NAME} is already active — stop it first`,
    };
  const other = runningOtherEngines(NAVIGATOR_BOT_ID);
  if (other.length)
    return {
      ok: false,
      error: `${other[0]!.name} is already trading on this account. Stop it first — one engine owns the recovery ledger.`,
    };
  if (!acquireTradingOwnership("bots", config.ownerSessionId)) {
    const owner = currentTradingOwner(config.ownerSessionId);
    return {
      ok: false,
      error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account.`,
    };
  }
  const fail = (error: string) => {
    releaseTradingOwnership("bots", config.ownerSessionId);
    return { ok: false as const, error };
  };
  const planError = validateNavigatorPlan(config.plan);
  if (planError) return fail(planError);
  if (config.stake < 0.35 || config.stopLoss <= 0 || config.takeProfit <= 0)
    return fail(
      "Stake, take profit and stop loss must be positive; minimum stake is $0.35",
    );
  if (!isAutomatedMarket(config.symbol))
    return fail(`${config.symbol} cannot be traded by this bot`);
  if (config.marketMode === "locked" && config.lockedSymbol !== config.symbol)
    return fail("Locked mode pins the market that was scanned");
  if (!config.params || !Array.isArray(config.params.weights))
    return fail(
      "Run the Navigator scan first — deployment requires its measured model card",
    );
  const market = AUTOMATED_DERIV_MARKETS.find(
    (m) => m.symbol === config.symbol,
  );
  if (!market?.digitEnabled)
    return fail("This bot needs a digit-enabled market");
  const contracts = contractsForPlan(config.plan);
  if (!contracts.normal.length || !contracts.recovery.length)
    return fail("At least one normal and one recovery side must be armed");

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_navigator_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    activeRead: config.lockedAnalysis ?? null,
    message:
      config.marketMode === "locked"
        ? `Locked on ${config.displayName} — recovery uses your selected digits.`
        : `Deployed on ${config.displayName} — recovery may hunt other markets.`,
  };
  if (session.activeRead) {
    session.watch.confidence = session.activeRead.confidence;
    session.watch.verdict = session.activeRead.verdict;
  }
  registerLiveBot(NAVIGATOR_BOT_ID, () => getStatus());
  broadcast();
  runWithSession(config.ownerSessionId ?? "legacy", () =>
    runLoop(config)
      .catch((err) => {
        logger.error({ err }, "Over/Under Navigator runLoop error");
        session.running = false;
        session.message = `⚠️ ${friendlyErrorMessage(err)}`;
        broadcast();
      })
      .finally(() => releaseTradingOwnership("bots", config.ownerSessionId)),
  );
  return { ok: true };
}

function radarOf(policy: NavigatorPolicy, digits: number[], idx: number) {
  return policy.recoveryContracts
    .map((c) => {
      const r = policy.readSide(digits, idx, c);
      return {
        label: c.label,
        p: r.p,
        utility: r.utility,
        bar: c.fair,
        ready: r.p >= c.fair,
      };
    })
    .sort((a, b) => b.utility - a.utility);
}
function applyDecision(
  dec: NavigatorDecision,
  radar: NavigatorWatch["recoveryRadar"],
) {
  session.watch.mode = dec.mode;
  session.watch.sideLabel = dec.side?.label ?? "—";
  session.watch.altLabel = dec.alt?.contract.label ?? "—";
  session.watch.p = dec.read?.p ?? 0;
  session.watch.altP = dec.alt?.p ?? 0;
  session.watch.bar = dec.bar;
  session.watch.ready = dec.ready;
  session.watch.pairRisk = dec.read?.pairRisk ?? 0;
  session.watch.qLL = dec.read?.qLL ?? 0;
  session.watch.lenses = dec.read?.lenses ?? [0, 0, 0, 0];
  session.watch.recoveryRadar = radar;
  session.watch.reason = dec.reason;
}

async function readDigits(symbol: string, count = SCAN_DIGITS) {
  try {
    return await getDeepDigits(symbol, count);
  } catch {
    return tickManager.getDigits(symbol, count);
  }
}

async function runLoop(config: NavigatorConfig) {
  const owner = config.ownerSessionId;
  if (!owner) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely";
    releaseTradingOwnership("bots", owner);
    broadcast();
    return;
  }
  let accounts = await db
    .select()
    .from(accountsTable)
    .where(
      and(eq(accountsTable.sessionId, owner), eq(accountsTable.isActive, true)),
    )
    .limit(1);
  if (!accounts.length)
    accounts = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.sessionId, owner))
      .limit(1);
  const settings = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.sessionId, owner))
    .limit(1);
  recoveryEngine.setPersistenceSession(owner);
  const paper =
    settings.length > 0
      ? ((settings[0] as any).paperTradeMode ?? false)
      : false;
  const token = accounts[0]?.bearerToken ?? accounts[0]?.token ?? null;
  const currency = accounts[0]?.currency ?? "USD";
  const isLive = !paper && !!token;
  const maxStake =
    settings.length > 0 ? Number(settings[0]!.maxTradeStake) : 500;
  let markup =
    settings.length > 0
      ? Number((settings[0] as any).botRecoveryMarkup ?? 10)
      : 10;
  let balance =
    accounts[0] && Number(accounts[0].balance) > 0
      ? Number(accounts[0].balance)
      : Number.POSITIVE_INFINITY;
  const contracts = contractsForPlan(config.plan);
  const locked = config.marketMode === "locked";
  let activeSymbol = config.symbol;
  let activeName = config.displayName;
  let policy: NavigatorPolicy | null = null;
  let candidate: NavigatorCandidate | null = config.lockedAnalysis ?? null;
  let digits: number[] = [];
  let fedLen = 0;
  let lastDecision: NavigatorDecision | null = null;
  let lastRefit = 0;
  let lastHunt = 0;
  let consecutiveErrors = 0;
  let lastDigitCount = 0;

  async function refit() {
    const next = await readDigits(activeSymbol);
    if (next.length < NAVIGATOR_MIN_MEASURE_DIGITS) return false;
    const read = scoreNavigatorMarket(next, config.plan);
    candidate = toCandidate(activeSymbol, activeName, read);
    policy = new NavigatorPolicy(
      read.params,
      contracts.normal,
      contracts.recovery,
    );
    for (let i = 0; i < next.length; i++) policy.update(next, i);
    digits = next;
    fedLen = next.length;
    lastDigitCount = next.length;
    lastDecision = null;
    session.activeRead = candidate;
    session.currentMarket = activeName;
    session.watch.confidence = candidate.confidence;
    session.watch.verdict = candidate.verdict;
    return true;
  }
  async function huntRecovery() {
    let best: {
      symbol: string;
      name: string;
      decision: NavigatorDecision;
    } | null = null;
    for (const m of AUTOMATED_DERIV_MARKETS.filter((x) => x.digitEnabled)) {
      const d = await readDigits(m.symbol, HUNT_DIGITS);
      if (d.length < 150) continue;
      const read = scoreNavigatorMarket(d, config.plan);
      const p = new NavigatorPolicy(
        read.params,
        contracts.normal,
        contracts.recovery,
      );
      for (let i = 0; i < d.length; i++) p.update(d, i);
      const dec = p.decideRecovery(d, d.length - 1);
      if (
        dec.ready &&
        dec.read &&
        (!best || dec.read.utility > best.decision.read!.utility)
      )
        best = { symbol: m.symbol, name: m.displayName, decision: dec };
    }
    return best;
  }

  while (session.running && !session.stopRequested) {
    try {
      if (!hasTradingOwnership("bots", owner)) {
        const who = currentTradingOwner(owner);
        session.running = false;
        session.message = `⛔ Stopped — ${who ? tradingOwnerLabel(who) : "another engine"} owns this account`;
        broadcast();
        return;
      }
      const inRecovery = recoveryEngine.isInRecovery();
      if (!policy || Date.now() - lastRefit >= REFIT_MS) {
        if (!(await refit())) {
          session.message = "Collecting digit history for the Navigator model…";
          broadcast();
          await sleep(1200);
          continue;
        }
        lastRefit = Date.now();
      }
      const latest = await readDigits(activeSymbol, SCAN_DIGITS);
      if (latest.length > digits.length) {
        for (let i = digits.length; i < latest.length; i++)
          policy!.update(latest, i);
        digits = latest;
        fedLen = latest.length;
        session.watch.ticksWatched += latest.length - lastDigitCount;
        lastDigitCount = latest.length;
        const idx = latest.length - 1;
        lastDecision = inRecovery
          ? policy!.decideRecovery(latest, idx)
          : policy!.decideNormal(latest, idx);
      }
      if (!lastDecision || !policy) {
        session.watch.phase = "watching";
        session.watch.reason = "waiting for the next digit tick";
        session.message = `👁 ${activeName} — timing the next setup`;
        broadcast();
        await sleep(500);
        continue;
      }
      applyDecision(lastDecision, radarOf(policy, digits, digits.length - 1));
      if (!lastDecision.ready) {
        if (inRecovery && !locked && Date.now() - lastHunt >= HUNT_MS) {
          lastHunt = Date.now();
          session.watch.phase = "hunting";
          session.watch.reason =
            "hunting every allowed market for a better recovery setup";
          session.message =
            "🔎 Recovery hunt — checking other markets without hardening the bar";
          broadcast();
          const hunt = await huntRecovery();
          if (hunt && hunt.symbol !== activeSymbol) {
            activeSymbol = hunt.symbol;
            activeName = hunt.name;
            session.watch.switched = true;
            await refit();
            lastRefit = Date.now();
            session.message = `🔁 Recovery setup found on ${activeName}`;
            broadcast();
            await sleep(250);
            continue;
          }
        }
        session.watch.phase = "watching";
        session.watch.reason = lastDecision.reason;
        session.message = inRecovery
          ? `🛡 Recovery waiting — ${lastDecision.reason}`
          : `👁 ${activeName} — ${lastDecision.reason}`;
        broadcast();
        await sleep(500);
        continue;
      }

      const fire = lastDecision.side!;
      const expected = inRecovery ? contracts.recovery : contracts.normal;
      if (
        !expected.some((c) => c.id === fire.id) ||
        !isAutomatedMarket(activeSymbol)
      ) {
        session.running = false;
        session.message =
          "⚠️ Contract sovereignty check failed — stopped safely";
        broadcast();
        return;
      }
      const quote = await resolveRecoveryPayout({
        symbol: activeSymbol,
        contractType: fire.contractType,
        barrier: fire.barrier,
        duration: DURATION,
        durationUnit: DURATION_UNIT,
        currency,
      });
      const payout = quote.payoutMultiplier || fire.payout;
      if (inRecovery) {
        try {
          const fresh = await db
            .select()
            .from(settingsTable)
            .where(eq(settingsTable.sessionId, owner))
            .limit(1);
          const value = Number((fresh[0] as any)?.botRecoveryMarkup);
          if (Number.isFinite(value)) markup = value;
        } catch {
          /* keep */
        }
      }
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(
            config.stake,
            maxStake,
            balance,
            payout,
            markup,
          )
        : config.stake;
      const step = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing";
      session.watch.reason = `firing ${fire.label} on ${activeName}`;
      session.currentStake = stake;
      session.currentMarket = activeName;
      session.currentContractType = fire.contractType;
      session.message = inRecovery
        ? `🎯 [Recovery R${step}] ${fire.label} · $${stake.toFixed(2)}`
        : `🎯 ${fire.label} · $${stake.toFixed(2)}`;
      broadcast();
      const reason = `[Over/Under Navigator${inRecovery ? " RECOVERY" : ""}] ${fire.label} on ${activeName} · p ${(lastDecision.read!.p * 100).toFixed(1)}% · static bar ${(lastDecision.bar * 100).toFixed(1)}% · pair-risk ${(lastDecision.read!.pairRisk * 100).toFixed(0)}%`;
      const [journaled] = await db
        .insert(tradesTable)
        .values({
          sessionId: owner,
          symbol: activeSymbol,
          displayName: activeName,
          contractType: fire.contractType,
          barrier: fire.barrier,
          stake: String(Math.round(stake * 100) / 100),
          direction: "hold",
          status: "open",
          aiConfidence: String(Math.round(lastDecision.read!.p * 100)),
          aiRiskScore: "15",
          isAutonomous: true,
          agentReasoning: `${paper ? "[PAPER] " : ""}${reason}`,
          duration: DURATION,
          durationUnit: DURATION_UNIT,
        })
        .returning();
      let won = false;
      let profit = 0;
      let entryPrice = tickManager.getLatestPrice(activeSymbol) ?? 0;
      let exitPrice = entryPrice;
      if (isLive) {
        try {
          const live = await executeLiveTrade(token!, {
            symbol: activeSymbol,
            contractType: fire.contractType,
            stake: Math.round(stake * 100) / 100,
            duration: DURATION,
            durationUnit: DURATION_UNIT,
            currency,
            accountId: accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            barrier: fire.barrier,
          } as any);
          const result = await waitForContractResult(
            token!,
            accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            live.contractId,
            30_000,
          );
          won = result.won;
          profit = result.profit;
          entryPrice = Number(result.entrySpot) || live.buyPrice;
          exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          await db
            .update(tradesTable)
            .set({
              status: "error",
              profit: "0",
              payout: "0",
              closedAt: new Date(),
              agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
            })
            .where(eq(tradesTable.id, journaled.id));
          session.watch.phase = "watching";
          session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}; back to timing`;
          lastDecision = null;
          broadcast();
          await sleep(1200);
          continue;
        }
      } else {
        session.watch.phase = "settling";
        const before = digits[digits.length - 1];
        let d = before;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const next = tickManager.getDigits(activeSymbol, 1)[0];
          if (next !== undefined && next !== before) {
            d = next;
            break;
          }
          d = next;
        }
        won = fire.wins[d ?? 0] === true;
        profit = won ? stake * (payout - 1) : -stake;
      }
      session.tradeCount++;
      session.totalProfit =
        Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) {
        session.winCount++;
        session.lastResult = "won";
        session.currentLossRun = 0;
      } else {
        session.lossCount++;
        session.lastResult = "lost";
        session.currentLossRun++;
        session.deepestLossRun = Math.max(
          session.deepestLossRun,
          session.currentLossRun,
        );
      }
      recoveryEngine.recordOutcome(
        won,
        profit,
        stake,
        config.maxRecoverySteps,
        fire.contractType,
        payout,
      );
      try {
        await db
          .update(tradesTable)
          .set({
            status: won ? "won" : "lost",
            payout: String(won ? Math.round((stake + profit) * 100) / 100 : 0),
            profit: String(Math.round(profit * 100) / 100),
            entryPrice: String(entryPrice),
            exitPrice: String(exitPrice),
            closedAt: new Date(),
          })
          .where(eq(tradesTable.id, journaled.id));
      } catch {
        /* best effort */
      }
      if (!isLive && Number.isFinite(balance))
        balance = Math.max(0, balance + profit);
      if (isLive) {
        try {
          const nextBalance = await getLiveBalance(
            token!,
            accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
          );
          if (nextBalance !== null) balance = nextBalance;
        } catch {
          /* best effort */
        }
      }
      session.watch = {
        ...freshWatch(),
        ticksWatched: session.watch.ticksWatched,
        confidence: session.activeRead?.confidence ?? 0,
        verdict: session.activeRead?.verdict ?? "—",
      };
      lastDecision = null;
      lastRefit = 0;
      session.message = won
        ? `✅ +$${profit.toFixed(2)} · recovery ledger re-evaluating`
        : `❌ −$${Math.abs(profit).toFixed(2)} · recovery stays available; bar unchanged`;
      broadcast();
      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached.`;
        broadcast();
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit.`;
        broadcast();
        return;
      }
      await sleep(won ? 300 : 400);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error(
        { err, consecutiveErrors },
        "Over/Under Navigator stability catch",
      );
      session.message = `Engine stabilizing… retry ${consecutiveErrors}`;
      broadcast();
      await sleep(Math.min(10_000, 500 * consecutiveErrors));
    }
  }
  if (
    !session.running &&
    !session.message?.startsWith("✅") &&
    !session.message?.startsWith("🛑") &&
    !session.message?.startsWith("⚠️")
  ) {
    session.message = "Session stopped";
    broadcast();
  }
}
