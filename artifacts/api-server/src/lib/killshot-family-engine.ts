/**
 * KILL-SHOT FAMILY ORACLES — three specialist bots that borrow the Kill-Shot
 * Oracle's analysis engine unchanged and apply it to a whole contract FAMILY.
 *
 * The Kill-Shot Oracle measures ONE contract and locks ONE market, then waits —
 * and when that market degrades it halts and asks the user to rescan. These
 * three bots keep the exact same measurement (five-model ensemble, walk-forward
 * out-of-sample ledger, anytime-valid e-value, ladder safety, post-loss shield)
 * but answer a different question after the measurement: WHERE NEXT?
 *
 *   · Over/Under Oracle   — the user picks a digit and Over only, Under only,
 *                           or both.
 *   · Even/Odd Oracle     — Even only, Odd only, or both.
 *   · Matches/Differs     — Matches, Differs, or both, with an optional digit
 *                           (or the AI picks).
 *
 * MARKET MODES — the twist the user asked for
 * ─────────────────────────────────────────
 *   · LOCKED  — the market is frozen for the whole session, but the EDGE may
 *               rotate inside it: trading Matches 5 on Volatility 25 and
 *               Matches 5 goes cold → the bot re-measures every contract in the
 *               family on Volatility 25 and moves to the next best digit/side.
 *   · SWITCHING — when the current market's edge degrades, the bot re-measures
 *               every market and moves to the best one (with hysteresis so it
 *               does not thrash). Either way it keeps running until TP, SL, the
 *               shot limit or the user stops it — never a dead-end rescan.
 *
 * SHARED RECOVERY — identical to every other bot: the ONE account-global ledger
 * (`lib/agents/recovery-engine.ts`), the ONE debt-driven stake formula
 * (`getBotRecoveryStake`) and the ONE single-executor arbiter (`engine-arbiter`,
 * owner `bots`). The analysis functions in `lib/killshot-analysis.ts` are
 * imported and used as-is — this module changes none of their behaviour.
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
import {
  evaluateCandidate,
  evaluateLiveEntry,
  screenCandidates,
  shotLabel,
  shotWinSet,
  shotPayout,
  certaintySpec,
  pageHinkley,
  KILLSHOT_CONTRACT_TYPE,
  SCAN_WINDOW,
  type KillShotCandidate,
  type Certainty,
  type ShotContract,
  type ModelCard,
} from "./killshot-analysis";
import { evaluateTiming } from "./killshot-timing";

// ── Bot identity ──────────────────────────────────────────────────────────────

export type FamilyKind = "overunder" | "parity" | "matchdiffer";
export type FamilySide = "over" | "under" | "both" | "even" | "odd" | "match" | "differ";

export const FAMILY_BOT_IDS = ["ks-overunder", "ks-parity", "ks-matchdiff"] as const;
export type FamilyBotId = (typeof FAMILY_BOT_IDS)[number];

export const FAMILY_BOT_NAME: Record<FamilyBotId, string> = {
  "ks-overunder": "Over/Under Oracle",
  "ks-parity": "Even/Odd Oracle",
  "ks-matchdiff": "Matches/Differs Oracle",
};

export function familyForBot(botId: string): FamilyKind | null {
  if (botId === "ks-overunder") return "overunder";
  if (botId === "ks-parity") return "parity";
  if (botId === "ks-matchdiff") return "matchdiffer";
  return null;
}

const MAX_BAR_BOOST = 2.5;
/** Full re-measure cadence: every market (switching) or the locked market only. */
const REANALYZE_LOCKED_MS = 15_000;
const REANALYZE_SWITCHING_MS = 45_000;
/** Minimum expectancy gap before a switching bot abandons a still-positive market. */
const SWITCH_MARGIN = 0.02;
const HEALTH_WINDOW = 1500;

// ── Config / status ───────────────────────────────────────────────────────────

export interface FamilyDeploySpec {
  botId: FamilyBotId;
  family: FamilyKind;
  side: FamilySide;
  /** Match/differ only: a locked digit (optional — the AI may pick). */
  digit?: number;
  /** Over/Under only: the digit traded for Over. */
  overDigit?: number;
  /** Over/Under only: the digit traded for Under. */
  underDigit?: number;
  /** Match/differ only: let the AI pick the best digit(s). */
  aiDigit: boolean;
  certainty: Certainty;
}

export interface FamilyConfig {
  ownerSessionId?: string;
  botId: FamilyBotId;
  spec: FamilyDeploySpec;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  /** Required when marketMode is locked. */
  lockedSymbol?: string;
  /** The starting lock chosen at scan time. */
  symbol: string;
  displayName: string;
  contract: ShotContract;
  card: ModelCard;
  lockedAnalysis?: KillShotCandidate;
}

export interface FamilyDeployed {
  symbol: string;
  displayName: string;
  contract: string;
  verdict: string;
  confidence: number;
  edgePerDollar: number;
  oosWinRate: number;
  oosShots: number;
  breakEven: number;
  payout: number;
}

export interface FamilyWatch {
  phase: "watching" | "armed" | "firing" | "settling";
  /** Calibrated P(win) at the live context. */
  p: number;
  /** Decision statistic vs the frozen bar. */
  z: number;
  bar: number;
  /** Short, human one-liner: what the bot is waiting for. */
  reason: string;
  /** True on the broadcast immediately after a market/contract rotation. */
  switched: boolean;
  confidence: number;
  verdict: string;
  ticksWatched: number;
}

export interface FamilyStatus {
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
    family: FamilyKind;
    side: FamilySide;
    digit?: number;
    overDigit?: number;
    underDigit?: number;
    aiDigit: boolean;
    certainty: Certainty;
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    marketMode: "locked" | "switching";
    lockedSymbol?: string;
  };
  deployed?: FamilyDeployed;
  familyWatch?: FamilyWatch;
}

/** Compact candidate shape returned by the scan — no walls of text. */
export interface FamilyCandidate {
  symbol: string;
  displayName: string;
  contract: ShotContract;
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
  card: ModelCard;
}

export interface FamilyScanResult {
  suitable: boolean;
  best: FamilyCandidate | null;
  bestAvailable: FamilyCandidate | null;
  allScored: FamilyCandidate[];
  reason: string;
  certainty: Certainty;
  marketsScanned: number;
  historyDepth: number;
}

// ── Contract building (family → candidate contracts) ──────────────────────────

/** Cheap digit pre-screen so a Matches/Differs scan never pays for 380 walk-forwards. */
function preScreenDigits(digits: number[], kind: "match" | "differ", k = 3): number[] {
  const counts = new Array<number>(10).fill(0);
  for (const d of digits) if (Number.isInteger(d) && d >= 0 && d <= 9) counts[d]++;
  const order = Array.from({ length: 10 }, (_, i) => i).sort((a, b) =>
    kind === "match" ? counts[b] - counts[a] : counts[a] - counts[b],
  );
  return order.slice(0, k);
}

/** The contracts this bot may trade, given its family + side + digit config. */
export function contractsFor(spec: FamilyDeploySpec, digits: number[]): ShotContract[] {
  const out: ShotContract[] = [];
  if (spec.family === "overunder") {
    const overD = spec.overDigit ?? spec.digit;
    const underD = spec.underDigit ?? spec.digit;
    if ((spec.side === "over" || spec.side === "both") && overD !== undefined) {
      out.push({ kind: "over", digit: overD });
    }
    if ((spec.side === "under" || spec.side === "both") && underD !== undefined) {
      out.push({ kind: "under", digit: underD });
    }
  } else if (spec.family === "parity") {
    if (spec.side === "even" || spec.side === "both") out.push({ kind: "even" });
    if (spec.side === "odd" || spec.side === "both") out.push({ kind: "odd" });
  } else if (spec.family === "matchdiffer") {
    const wantMatch = spec.side === "match" || spec.side === "both";
    const wantDiffer = spec.side === "differ" || spec.side === "both";
    if (spec.digit !== undefined) {
      if (wantMatch) out.push({ kind: "match", digit: spec.digit });
      if (wantDiffer) out.push({ kind: "differ", digit: spec.digit });
    } else {
      if (wantMatch) for (const d of preScreenDigits(digits, "match")) out.push({ kind: "match", digit: d });
      if (wantDiffer) for (const d of preScreenDigits(digits, "differ")) out.push({ kind: "differ", digit: d });
    }
  }
  return out;
}

/** Contract sovereignty: may this session fire this contract, regardless of digits? */
function allowedContract(spec: FamilyDeploySpec, c: ShotContract): boolean {
  switch (spec.family) {
    case "overunder": {
      if (c.kind !== "over" && c.kind !== "under") return false;
      if (spec.side === "over" && c.kind !== "over") return false;
      if (spec.side === "under" && c.kind !== "under") return false;
      const want = c.kind === "over" ? (spec.overDigit ?? spec.digit) : (spec.underDigit ?? spec.digit);
      return want === undefined || c.digit === want;
    }
    case "parity":
      if (c.kind !== "even" && c.kind !== "odd") return false;
      if (spec.side === "even") return c.kind === "even";
      if (spec.side === "odd") return c.kind === "odd";
      return true;
    case "matchdiffer":
      if (c.kind !== "match" && c.kind !== "differ") return false;
      if (spec.digit !== undefined && c.digit !== undefined && c.digit !== spec.digit) return false;
      if (spec.side === "match") return c.kind === "match";
      if (spec.side === "differ") return c.kind === "differ";
      return true;
  }
}

function simplifyCandidate(c: KillShotCandidate): FamilyCandidate {
  return {
    symbol: c.symbol,
    displayName: c.displayName,
    contract: c.contract,
    label: c.label,
    verdict: c.verdict,
    confidence: c.confidence,
    edgePerDollar: c.edgePerDollar,
    winRate: c.walk.test.winRate,
    winRateLower: c.walk.test.winRateLower,
    nShots: c.walk.test.nShots,
    breakEven: c.breakEven,
    payout: c.payout,
    deployable: c.deployable,
    card: c.card,
  };
}

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: FamilyConfig | null;
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
  watch: FamilyWatch;
  /** The ACTIVE lock — mutates on rotation, so the console shows where the bot is. */
  activeSymbol?: string;
  activeName?: string;
  activeContract?: ShotContract;
  activeRead?: KillShotCandidate | null;
}

function freshWatch(): FamilyWatch {
  return {
    phase: "watching",
    p: 0,
    z: 0,
    bar: 0,
    reason: "",
    switched: false,
    confidence: 0,
    verdict: "—",
    ticksWatched: 0,
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

function deployed(contract: ShotContract | undefined, read: KillShotCandidate | null | undefined): FamilyDeployed | undefined {
  if (!contract) return undefined;
  const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    symbol: read?.symbol ?? session.activeSymbol ?? "",
    displayName: read?.displayName ?? session.activeName ?? "",
    contract: shotLabel(contract),
    verdict: read?.verdict ?? "—",
    confidence: num(read?.confidence),
    edgePerDollar: num(read?.edgePerDollar),
    oosWinRate: num(read?.walk?.test?.winRate),
    oosShots: num(read?.walk?.test?.nShots),
    breakEven: num(read?.breakEven, 1 / shotPayout(contract)),
    payout: num(read?.payout, shotPayout(contract)),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

registerBotEngine("killshot-family", () => ({ running: session.running, name: "Kill-Shot family bot" }));

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): FamilyStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const familyWatch = session.running ? session.watch : undefined;
  return {
    running: session.running,
    botId: cfg?.botId ?? null,
    botName: cfg ? FAMILY_BOT_NAME[cfg.botId] : null,
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
          family: cfg.spec.family,
          side: cfg.spec.side,
          digit: cfg.spec.digit,
          overDigit: cfg.spec.overDigit,
          underDigit: cfg.spec.underDigit,
          aiDigit: cfg.spec.aiDigit,
          certainty: cfg.spec.certainty,
          stake: cfg.stake,
          stopLoss: cfg.stopLoss,
          takeProfit: cfg.takeProfit,
          maxRecoverySteps: cfg.maxRecoverySteps,
          marketMode: cfg.marketMode,
          lockedSymbol: cfg.lockedSymbol,
        }
      : undefined,
    deployed: session.running ? deployed(session.activeContract, session.activeRead) : undefined,
    familyWatch,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info({ botId: session.config?.botId }, "Kill-Shot family session stopped");
}

// ── Pre-deploy scan ───────────────────────────────────────────────────────────

export async function scanForFamily(
  ownerSessionId: string | undefined,
  spec: FamilyDeploySpec,
  risk: { stake: number; markupPercent: number; maxStake: number; stopLoss: number },
): Promise<FamilyScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
  const all: KillShotCandidate[] = [];
  let deepest = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    broadcastSSE("bot_scan_progress", {
      botId: spec.botId,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned: i,
      total: markets.length,
    }, ownerSessionId);

    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, SCAN_WINDOW);
    } catch {
      digits = tickManager.getDigits(market.symbol, SCAN_WINDOW);
    }
    deepest = Math.max(deepest, digits.length);

    for (const c of contractsFor(spec, digits)) {
      const cand = evaluateCandidate(market.symbol, market.displayName, digits, c, {
        certainty: spec.certainty,
        baseStake: risk.stake,
        markupPercent: risk.markupPercent,
        maxStake: risk.maxStake,
        stopLoss: risk.stopLoss,
      });
      if (cand) all.push(cand);
    }
    await sleep(5);
  }

  const ranked = screenCandidates(all);

  broadcastSSE("bot_scan_progress", {
    botId: spec.botId,
    scanning: null,
    symbol: null,
    scanned: markets.length,
    total: markets.length,
  }, ownerSessionId);

  const best = ranked[0];
  if (!best) {
    return {
      suitable: false, best: null, bestAvailable: null, allScored: [], certainty: spec.certainty,
      marketsScanned: markets.length, historyDepth: deepest,
      reason: "Not enough history yet — the digit feed is still warming up. Wait a moment and re-measure.",
    };
  }

  const suitable = best.deployable;
  const reason = suitable
    ? `${best.displayName} · ${best.label} — measured ${(best.walk.test.winRate * 100).toFixed(0)}% over ${best.walk.test.nShots} unseen shots (break-even ${(best.breakEven * 100).toFixed(1)}%).`
    : `No ${best.label} setup cleared the bar — best was ${best.displayName} (${best.verdict.toUpperCase()}, ${best.confidence}/100).`;

  return {
    suitable,
    best: suitable ? simplifyCandidate(best) : null,
    bestAvailable: simplifyCandidate(best),
    allScored: ranked.slice(0, 12).map(simplifyCandidate),
    reason,
    certainty: spec.certainty,
    marketsScanned: markets.length,
    historyDepth: deepest,
  };
}

// ── Session start ─────────────────────────────────────────────────────────────

export async function startSession(config: FamilyConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A Kill-Shot family bot is already active — stop it first" };

  // ── One executing bot engine at a time (protects the single ledger) ──
  const otherEngines = runningOtherEngines("killshot-family");
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
  if (!config.card || !Number.isFinite(Number(config.card.tau))) {
    return fail("Run the analysis first — this bot only deploys a rule it has measured");
  }
  if (!allowedContract(config.spec, config.contract)) {
    return fail("The chosen contract is outside this bot's family — refusing to deploy");
  }

  const market = AUTOMATED_DERIV_MARKETS.find(m => m.symbol === config.symbol);
  if (!market || !market.digitEnabled) return fail("This bot needs a digit-enabled market");

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_family_${Date.now()}`,
    config,
    currentStake: config.stake,
    currentMarket: config.displayName,
    currentContractType: shotLabel(config.contract),
    activeSymbol: config.symbol,
    activeName: config.displayName,
    activeContract: config.contract,
    activeRead: null,
    message: config.marketMode === "locked"
      ? `Locked on ${config.displayName} — the edge may move, the market will not.`
      : `Deployed on ${config.displayName} — will move to a better market when this one cools.`,
  };

  logger.info({
    botId: config.botId,
    family: config.spec.family,
    side: config.spec.side,
    marketMode: config.marketMode,
    symbol: config.symbol,
    contract: shotLabel(config.contract),
  }, "Kill-Shot family session starting");
  broadcast();

  // Bind this engine's account session into AsyncLocalStorage — see engine-arbiter.
  runWithSession(config.ownerSessionId ?? "legacy", () =>
    runLoop(config).catch(err => {
      logger.error({ err }, "Kill-Shot family runLoop error");
      session.running = false;
      session.message = `⚠️ ${friendlyErrorMessage(err)}`;
      broadcast();
    }).finally(() => releaseTradingOwnership("bots"))
  );

  return { ok: true };
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: FamilyConfig) {
  const ownerSessionId = config.ownerSessionId;
  const botName = FAMILY_BOT_NAME[config.botId];
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
  const REANALYZE_MS = LOCKED ? REANALYZE_LOCKED_MS : REANALYZE_SWITCHING_MS;

  // Mutable lock — the market may change (switching) and the contract may change
  // (either mode). Re-asserted against the spec before every buy.
  let activeSymbol: string = config.symbol;
  let activeName: string = config.displayName;
  let activeContract: ShotContract = { ...config.contract };
  let activeCard: ModelCard = { ...config.card };
  let activeWinset = shotWinSet(activeContract);
  let activeType = KILLSHOT_CONTRACT_TYPE[activeContract.kind];
  let activeRead: KillShotCandidate | null = null;

  let ticksSinceLoss = Number.POSITIVE_INFINITY;
  let ticksSinceLastShot = Number.POSITIVE_INFINITY;
  let lossRun = 0;
  let timingWaitTicks = 0;
  let lastDigitCount = 0;
  let lastReanalyzeAt = 0;
  let consecutiveErrors = 0;

  /** Re-measure and pick the best positive candidate (with hysteresis when switching). */
  async function analyzeActive(): Promise<KillShotCandidate | null> {
    const markets = LOCKED
      ? AUTOMATED_DERIV_MARKETS.filter(m => m.symbol === activeSymbol)
      : AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);
    const all: KillShotCandidate[] = [];
    for (const market of markets) {
      let digits: number[] = [];
      try {
        digits = await getDeepDigits(market.symbol, SCAN_WINDOW);
      } catch {
        digits = tickManager.getDigits(market.symbol, SCAN_WINDOW);
      }
      for (const c of contractsFor(SPEC, digits)) {
        const cand = evaluateCandidate(market.symbol, market.displayName, digits, c, {
          certainty: SPEC.certainty,
          baseStake: config.stake,
          markupPercent: botRecoveryMarkup,
          maxStake,
          stopLoss: config.stopLoss,
        });
        if (cand) all.push(cand);
      }
    }
    const ranked = screenCandidates(all);
    const positive = ranked.filter(c => c.edgePerDollar > 0);
    if (positive.length === 0) return null;
    const best = positive[0]!;
    // Hysteresis for the switching mode: only leave a still-positive market for
    // one that is meaningfully better — otherwise the bot flips on noise.
    if (!LOCKED && best.symbol !== activeSymbol) {
      const currentBest = positive.find(c => c.symbol === activeSymbol);
      if (currentBest && currentBest.edgePerDollar > 0
          && best.edgePerDollar - currentBest.edgePerDollar < SWITCH_MARGIN) {
        return currentBest;
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

      let digits = await getDeepDigits(activeSymbol, SCAN_WINDOW);
      if (digits.length !== lastDigitCount) {
        const delta = Math.max(0, digits.length - lastDigitCount);
        session.watch.ticksWatched += delta;
        if (Number.isFinite(ticksSinceLastShot)) ticksSinceLastShot += delta;
        if (Number.isFinite(ticksSinceLoss)) ticksSinceLoss += delta;
        lastDigitCount = digits.length;
      }

      // ── MARKET HEALTH → triggers a re-measure (rotation, never a dead-end) ──
      const wins = digits.slice(-HEALTH_WINDOW).map(d => (activeWinset.has(d) ? 1 : 0));
      const ph = pageHinkley(wins);
      if (ph.fired) lastReanalyzeAt = 0;

      // ── PERIODIC RE-MEASURE: pick the best positive (market, contract) ─────
      const needsReanalyze = activeRead === null || Date.now() - lastReanalyzeAt >= REANALYZE_MS;
      if (needsReanalyze) {
        const pick = await analyzeActive();
        lastReanalyzeAt = Date.now();
        if (pick) {
          const rotated = pick.symbol !== activeSymbol
            || pick.contract.kind !== activeContract.kind
            || pick.contract.digit !== activeContract.digit;
          activeSymbol = pick.symbol;
          activeName = pick.displayName;
          activeContract = pick.contract;
          activeCard = pick.card;
          activeWinset = shotWinSet(pick.contract);
          activeType = KILLSHOT_CONTRACT_TYPE[pick.contract.kind];
          activeRead = pick;
          session.activeSymbol = pick.symbol;
          session.activeName = pick.displayName;
          session.activeContract = pick.contract;
          session.activeRead = pick;
          session.currentMarket = pick.displayName;
          session.currentContractType = shotLabel(pick.contract);
          session.watch.confidence = pick.confidence;
          session.watch.verdict = pick.verdict;
          if (rotated) {
            session.watch.switched = true;
            session.message = LOCKED
              ? `🔁 Edge moved on ${pick.displayName} — now targeting ${shotLabel(pick.contract)}`
              : `🔁 Rotated to ${pick.displayName} · ${shotLabel(pick.contract)}`;
          }
          digits = await getDeepDigits(activeSymbol, SCAN_WINDOW);
        } else {
          activeRead = null;
          session.watch.phase = "watching";
          session.watch.reason = "no positive edge measured right now";
          session.message = LOCKED
            ? `Holding on ${activeName} — no positive edge in the family right now`
            : `Scanning markets — no positive edge measured right now`;
          broadcast();
          await sleep(1500);
          continue;
        }
      }

      // ── EDGE gate + post-loss shield (same rule the scan simulated) ────────
      const barBoost = Math.min(
        MAX_BAR_BOOST,
        activeCard.postLossTightening * (lossRun + (inRecovery ? 1 : 0)),
      );
      const entry = evaluateLiveEntry(digits, activeWinset, activeCard, {
        barBoost,
        ticksSinceLoss,
      });
      session.watch.p = entry.p;
      session.watch.z = entry.z;
      session.watch.bar = entry.bar;

      if (!entry.ready) {
        session.watch.phase = "watching";
        timingWaitTicks = 0;
        session.watch.reason = shortWaitReason(entry.reason, digits.length, barBoost, ticksSinceLoss, activeCard.postLossCoolTicks);
        session.message = inRecovery
          ? `🎯 Recovery armed — ${session.watch.reason}`
          : `👁 ${shotLabel(activeContract)} on ${activeName} — ${session.watch.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }

      // ── TICK gate ───────────────────────────────────────────────────────────
      session.watch.phase = "armed";
      const timing = evaluateTiming({
        digits,
        winSet: activeWinset,
        secondsSinceLastTick: tickManager.getTickAgeSeconds(activeSymbol),
        medianTickGapSeconds: activeSymbol.startsWith("1HZ") ? 1 : 2,
        ticksSinceLastShot,
        waitedTicks: timingWaitTicks,
        minSpacing: activeCard.minSpacing,
      });
      if (!timing.ready) {
        timingWaitTicks++;
        session.watch.reason = shortTimingReason(timing.reason);
        session.message = inRecovery
          ? `🎯 Recovery armed — ${session.watch.reason}`
          : `⏳ Armed on ${activeName} · ${shotLabel(activeContract)} — ${session.watch.reason}`;
        broadcast();
        await sleep(900);
        continue;
      }
      timingWaitTicks = 0;

      // ── Contract sovereignty — re-asserted immediately before every buy ────
      if (!allowedContract(SPEC, activeContract) || !isAutomatedMarket(activeSymbol)) {
        session.running = false;
        session.message = "⚠️ Contract sovereignty check failed — session halted before firing";
        logger.error({ activeSymbol, activeContract, spec: SPEC }, "Kill-Shot family sovereignty violation");
        broadcast();
        return;
      }

      const barrier = activeContract.kind === "even" || activeContract.kind === "odd"
        ? undefined
        : activeContract.digit;

      const payoutQuote = await resolveRecoveryPayout({
        symbol: activeSymbol,
        contractType: activeType,
        barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      const payout = payoutQuote.payoutMultiplier || shotPayout(activeContract);

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

      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, payout, botRecoveryMarkup)
        : config.stake;

      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.watch.phase = "firing";
      session.currentStake = stake;
      session.currentMarket = activeName;
      session.currentContractType = shotLabel(activeContract);
      session.message = inRecovery
        ? `🎯 [Recovery R${sharedStep}] ${shotLabel(activeContract)} on ${activeName} · $${stake.toFixed(2)}`
        : `🎯 ${shotLabel(activeContract)} on ${activeName} · $${stake.toFixed(2)}`;
      broadcast();

      const reason = `[${botName}${inRecovery ? " RECOVERY" : ""}] ${shotLabel(activeContract)} on ${activeName} · ` +
        `measured rule: ${activeRead?.walk.test.nShots ?? 0} shots at ${((activeRead?.walk.test.winRate ?? 0) * 100).toFixed(1)}% on unseen ticks · ` +
        `edge ${entry.z.toFixed(2)}σ vs bar ${entry.bar.toFixed(2)}σ · P(win|context) ${(entry.p * 100).toFixed(1)}%`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: activeSymbol,
        displayName: activeName,
        contractType: activeType,
        barrier: barrier ?? null,
        stake: String(Math.round(stake * 100) / 100),
        direction: "hold",
        status: "open",
        aiConfidence: String(activeRead?.confidence ?? Math.round(entry.p * 100)),
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
            contractType: activeType,
            stake: Math.round(stake * 100) / 100,
            duration: 1,
            durationUnit: "t",
            currency,
            accountId: accounts[0].derivAccountId ?? accounts[0].loginId,
            ...(barrier !== undefined ? { barrier } : {}),
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
          logger.warn({ err }, "Kill-Shot family live execution error — returning to the watch");
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
        won = activeWinset.has(d);
        profit = won ? stake * (payout - 1) : -stake;
      }

      session.tradeCount++;
      session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) {
        session.winCount++;
        session.lastResult = "won";
        session.currentLossRun = 0;
        lossRun = 0;
        ticksSinceLoss = Number.POSITIVE_INFINITY;
      } else {
        session.lossCount++;
        session.lastResult = "lost";
        session.currentLossRun++;
        session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun);
        lossRun++;
        ticksSinceLoss = 0;
      }

      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, activeType, payout);

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
        logger.warn({ dbErr }, "Kill-Shot family: failed to settle the journaled trade");
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
        confidence: activeRead?.confidence ?? 0,
        verdict: activeRead?.verdict ?? "—",
      };
      ticksSinceLastShot = 0;
      timingWaitTicks = 0;
      lastReanalyzeAt = 0; // fresh measurement before the next shot
      session.message = won
        ? `✅ +$${profit.toFixed(2)} · ${session.winCount}/${session.tradeCount} · next shot re-measured`
        : `❌ −$${Math.abs(profit).toFixed(2)} · shield on · ${session.currentLossRun} in a row`;
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
      logger.error({ err, consecutiveErrors }, "Kill-Shot family stability catch — keeping the session alive");
      // Never self-stop on transient errors — the session only stops on TP,
      // SL, or a manual stop. Back off (capped) and keep retrying.
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

// ── Short display reasons (simplicity for the user) ───────────────────────────

function shortWaitReason(
  full: string,
  digitCount: number,
  barBoost: number,
  ticksSinceLoss: number,
  coolTicks: number,
): string {
  if (digitCount < 300) return `collecting history — ${digitCount}/300 digits`;
  if (barBoost > 0 && Number.isFinite(ticksSinceLoss) && ticksSinceLoss < coolTicks) {
    return `post-loss cool-down ${Math.min(ticksSinceLoss, coolTicks)}/${coolTicks} ticks`;
  }
  if (full.includes("calibrating")) return "calibrating the live scale";
  return "waiting for the edge to clear the bar";
}

function shortTimingReason(full: string): string {
  if (full.includes("re-spacing")) return "spacing out shots";
  if (full.includes("feed")) return "tick feed lagging";
  if (full.includes("colder")) return "momentum cooling";
  if (full.includes("favoured state")) return "waiting for the favoured state";
  if (full.includes("renewal clock")) return "renewal clock just reset";
  if (full.includes("drought")) return "drought — regime may have broken";
  if (full.includes("below the")) return "entry quality below the bar";
  return "holding for a better entry";
}
