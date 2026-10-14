/**
 * Autonomous engine — 1-tick Nexus cycle (tick-driven).
 *
 *  - TIMING: a cycle runs on every live tick of a watched market (coalesced:
 *    a tick that arrives while a cycle is running is evaluated next, never
 *    dropped). There are no polling timers and no journal-settle waits.
 *  - ANALYSIS: the Nexus ranker over the 4-group contest (see contest.ts).
 *  - EXECUTION: one exposure at a time. A 1-tick buy is stored with its exact
 *    contract id, and the outcome is claimed with a conditional write. The
 *    recovery ledger is updated only by the writer that changes the row.
 *  - LEDGER: a settlement timeout keeps the exposure open. Nothing is dropped
 *    and debt is never understated. The reconciler resolves the row from the
 *    exact contract id, and the engine stays gated until it does.
 *
 * This module is the autonomous engine's own copy of the Nexus logic. It does
 * not import or change the Nexus Hedge Forge bot or the shared agents.
 */

import { db, tradesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../logger";
import { runWithSession } from "../session";
import * as recoveryEngine from "../agents/recovery-engine";
import { computeRiskDecision } from "../agents/risk-manager";
import type { DailyStats, ScanContext, TradingSettings } from "../agents/types";
import type { RiskDecision } from "../agents/risk-manager";
import { resolveRecoveryPayout } from "../recovery-payout";
import {
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  fetchDerivPortfolioContracts,
  fetchDerivProfitTable,
  isAutomatedMarket,
  isLiveOrderInFlight,
  LiveOrderInFlightError,
  TradeOutcomeUnknownError,
  waitForContractResult,
} from "../deriv";
import {
  AUTONOMOUS_HEDGE_PREFIX,
  getRecoveryV2Mode,
  HEDGE_DURATION_TICKS,
  HEDGE_DURATION_UNIT,
  HEDGE_MIN_TICKS,
  HEDGE_V2_MAX_WINDOW,
  HEDGE_WINDOW,
  hedgeGroupIndex,
  HEDGE_GROUP_NAMES,
} from "./constants";
import { buildMarketCandidates, candidateKey, type HedgeCandidate, type HedgeFamilySpec, type HedgeMode } from "./hedge-analysis";
import { recoveryEscalation } from "./recovery-risk";
import { decideHedge, type HedgeDecision, type HedgeV2ScanTelemetry } from "./contest";
import { applySettlement, rankRows, requiredConfirmations, type HedgeMemory } from "./hedge-state";
import { readHedgeTape, type HedgeTape } from "./tape";
import { familySpecsFor } from "./families";
import type { AutonomousContractSets } from "./contract-sets";
import { EvidenceTracker, type MarketTapeInput } from "./evidence";
import { clearLadderOutcomeCache } from "./ladder-outcomes";
import { buildV2RecoveryDecision, scoreV2Candidates, type V2LadderConfig, type V2ScoredCandidate } from "./score-v2";
import {
  describeExecutionTruth,
  realisedMultiplier,
  recordDispatchLatency,
  recordQuoteOutcome,
} from "./execution-truth";
import { isDecisionStale, shouldSwitchCandidateBeforeBuy, TimingV2Controller } from "./timing-v2";
import { livePayoutFor, stopQuotePrefetchTask, syncQuotePrefetchTask } from "./quote-prefetch";
import { defaultShadowLedger, type LatestTickObservation } from "./shadow-ledger";
import { CalibrationGuard } from "./calibration-guard";
import {
  claimOpenRow,
  ledgerEntryPayout,
  loadClaimedContractIds,
  loadOpenAutonomousRows,
  settleAutonomousRow,
} from "./ledger";
import {
  pickUniquePurchase,
  portfolioAsTransaction,
  type DerivTx,
  type ReconRow,
} from "./ledger-match";
import { reconcileUnsettledTrades } from "../trade-reconciler";

// ── Host: the engine instance owned by routes/ai.ts ───────────────────────────

export interface HedgeContext {
  balance: number;
  currency: string;
  token: string | null;
  derivAccountId: string | null;
  settings: TradingSettings;
  consecutiveLossLimit: number;
  cooldownMinutes: number;
  /** False = trade straight through a loss streak (no cooldown pause). */
  cooldownEnabled: boolean;
  allowedMarketSymbols: string[] | null;
  daily: DailyStats;
  /**
   * The normal and recovery contract sets the user chose. Absent means the
   * engine derives them from `settings` (the legacy behaviour).
   */
  contractSets?: AutonomousContractSets;
}

export interface HedgePublish {
  currentMarket?: string | null;
  sessionLossCount?: number;
  tradesExecutedToday?: number;
  lastTradeTime?: Date | null;
  nextScanIn?: number | null;
}

export interface HedgeHost {
  sessionId: string;
  isRunning(): boolean;
  /**
   * True when this engine may trade right now. Claims the session's execution
   * right; if another engine owns it, stops this engine and returns false.
   */
  canExecute(): boolean;
  stop(reason: string, cooldownMinutes?: number): void;
  /**
   * Stop for a breached loss limit and resume at once — used when the user
   * turned the cooldown off in Settings. The streak reset is the same one a
   * cooldown expiry performs, so the guardrail cannot re-fire on every loss.
   */
  stopAndResume(reason: string): void;
  emit(event: string, data: Record<string, unknown>): void;
  publish(patch: HedgePublish): void;
  /** Loads account, settings and today's resolved P&L for this session. */
  loadContext(): Promise<HedgeContext>;
  /** Balance / journal refresh after a live settlement. */
  afterSettlement(ctx: HedgeContext): void;
}

// ── Per-session state ─────────────────────────────────────────────────────────

interface Exposure {
  rowId: number;
  symbol: string;
  contract: string;
  barrier: number;
  key: string;
  decisionSequence: number;
  contractId: number | null;
  stake: number;
  mode?: HedgeMode;
  pTilde?: number;
}

interface HedgeSession {
  memory: HedgeMemory;
  busy: boolean;
  pending: boolean;
  hydrated: boolean;
  exposure: Exposure | null;
  exposureCheckedAt: number;
  /** Epoch ms the current exposure started waiting (0 when no exposure). Shown in the settling hold reason. */
  exposureSince: number;
  lastReconcileAt: number;
  lastEmitAt: number;
  execFailures: number;
  /** One analysed-and-tuned live attempt at a time — see liveAttemptHoldReason. */
  liveGate: LiveAttemptGate;
  ctx: { at: number; value: HedgeContext } | null;
  evidenceTracker: EvidenceTracker;
  timingV2: TimingV2Controller;
  calibrationGuard: CalibrationGuard;
}

const CONTEXT_TTL_MS = 2_000;
const EMIT_THROTTLE_MS = 400;
const EXPOSURE_RECHECK_MS = 1_500;
const RECONCILE_THROTTLE_MS = 5_000;
const CONSECUTIVE_EXEC_FAILURE_LIMIT = 3;

// ── Live attempt gate: one trade, analysed and tuned, per attempt ─────────────
//
// The engine is tick-driven and coalesces ticks, so a buy that Deriv refuses in
// 100 ms used to be retried by the very next coalesced cycle — same tape, same
// decision, same refusal. Three of those inside a second tripped the three-strike
// stop ("Deriv rejected 3 consecutive 1-tick buys"), which looks exactly like the
// engine firing three trades at once. It never was three trades: it was ONE trade
// re-sent three times. This gate makes a re-attempt wait for a fresh analysis and
// a short backoff, so every live buy is a decision the engine reached on its own
// newest tick.
/** How long a refused live buy blocks the next live attempt. */
export const LIVE_REFUSAL_BACKOFF_MS = 5_000;

export interface LiveAttemptGate {
  /** Symbol of the decision the broker refused (null when nothing was refused). */
  refusedSymbol: string | null;
  /** Tick sequence that decision was analysed on. */
  refusedTickSequence: number;
  /** Epoch ms before which no new live buy may be attempted. */
  retryNotBeforeMs: number;
}

export function newLiveAttemptGate(): LiveAttemptGate {
  return { refusedSymbol: null, refusedTickSequence: 0, retryNotBeforeMs: 0 };
}

/**
 * Why this decision may not be bought right now — or null when it may.
 * Pure so the rule is testable without a broker, a tape or a clock.
 */
export function liveAttemptHoldReason(
  gate: LiveAttemptGate,
  decision: { symbol: string; tickSequence: number },
  now: number,
): string | null {
  if (gate.retryNotBeforeMs > now) {
    const seconds = Math.max(1, Math.ceil((gate.retryNotBeforeMs - now) / 1000));
    return (
      `the previous 1-tick buy was refused, so the engine waits ${seconds}s and then buys ` +
      "a freshly analysed tick instead of re-sending the refused trade"
    );
  }
  if (
    gate.refusedSymbol !== null &&
    gate.refusedSymbol === decision.symbol &&
    gate.refusedTickSequence === decision.tickSequence
  ) {
    return (
      `this exact ${decision.symbol} tick was already refused — the engine buys the next ` +
      "analysed tick instead of re-sending the same trade"
    );
  }
  return null;
}

/** Arm the gate after a broker refusal: back off, and never re-buy that tick. */
export function recordRefusedLiveAttempt(
  gate: LiveAttemptGate,
  decision: { symbol: string; tickSequence: number },
  now: number,
  backoffMs = LIVE_REFUSAL_BACKOFF_MS,
): void {
  gate.refusedSymbol = decision.symbol;
  gate.refusedTickSequence = decision.tickSequence;
  gate.retryNotBeforeMs = now + backoffMs;
}

/** The gate is released by a purchase that actually went through. */
export function clearRefusedLiveAttempt(gate: LiveAttemptGate): void {
  gate.refusedSymbol = null;
  gate.refusedTickSequence = 0;
  gate.retryNotBeforeMs = 0;
}
/** A tape with no tick for this long belongs to a closed or stalled market and is not ranked. */
const STALE_TAPE_MS = 15_000;
const MIN_STAKE = 0.35;
/**
 * Longest an unresolved exposure may keep the engine from trading.
 *
 * WHY THIS EXISTS (the bug it fixes): the exposure gate was unbounded. A row
 * Deriv never confirmed stayed `open` in the database, and an open row is the
 * ONLY thing `exposureResolved` waits on — so the engine held forever and the
 * dashboard showed "HOLD: settling previous 1-tick trade … waiting 1109m19s"
 * with no way out but a manual restart. Nothing in the code was wrong "by
 * design" here; the gate simply had no ceiling, so any cause that made the
 * reconciler miss a row (a profit-table page that had moved past it, a token
 * that needed reconnecting, a Deriv outage) became PERMANENT.
 *
 * The hold is now bounded. After this long the GATE is released and the engine
 * resumes ranking and trading, while the row itself is left `open` and stays
 * the reconciler's job for a week — so if Deriv ever reports the contract the
 * outcome is still recorded in the recovery ledger exactly once by the same
 * claim-unique writer. Nothing is dropped, nothing is double-counted, and a
 * single unsettleable row can no longer disable the engine.
 */
const EXPOSURE_MAX_HOLD_MS = 30 * 60 * 1000;

const sessions = new Map<string, HedgeSession>();

function newSession(): HedgeSession {
  return {
    memory: {},
    busy: false,
    pending: false,
    hydrated: false,
    exposure: null,
    exposureCheckedAt: 0,
    exposureSince: 0,
    lastReconcileAt: 0,
    lastEmitAt: 0,
    execFailures: 0,
    liveGate: newLiveAttemptGate(),
    ctx: null,
    evidenceTracker: new EvidenceTracker(),
    timingV2: new TimingV2Controller(),
    calibrationGuard: new CalibrationGuard(),
  };
}

function sessionState(sessionId: string): HedgeSession {
  let s = sessions.get(sessionId);
  if (!s) {
    s = newSession();
    sessions.set(sessionId, s);
  }
  return s;
}

/** Release the exposure gate. The waiting-since clock resets with it. */
function clearExposure(s: HedgeSession): void {
  s.exposure = null;
  s.exposureSince = 0;
}

/** Fresh rescan memory for a new engine start, exactly as a Nexus bot restart. */
export function resetHedgeSession(sessionId: string): void {
  sessions.set(sessionId, newSession());
}

export function getHedgeMemory(sessionId: string): HedgeMemory {
  return sessionState(sessionId).memory;
}

export function hasUnresolvedExposure(sessionId: string): boolean {
  return sessionState(sessionId).exposure !== null;
}

// ── Entry point: called on every tick and on engine start ─────────────────────

export function requestHedgeCycle(host: HedgeHost): void {
  if (!host.isRunning()) return;
  const s = sessionState(host.sessionId);
  if (s.busy) {
    s.pending = true; // coalesce: the newest tick is evaluated after the running cycle
    return;
  }
  s.busy = true;
  runWithSession(host.sessionId, () => {
    recoveryEngine.setPersistenceSession(host.sessionId);
    void runCycleSafely(host, s).finally(() => {
      s.busy = false;
      if (s.pending && host.isRunning()) {
        s.pending = false;
        requestHedgeCycle(host);
      }
    });
  });
}

async function runCycleSafely(host: HedgeHost, s: HedgeSession): Promise<void> {
  try {
    await runCycle(host, s);
  } catch (err) {
    logger.error({ err, sessionId: host.sessionId }, "Autonomous 1-tick cycle failed — will retry on the next tick");
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

async function getContext(host: HedgeHost, s: HedgeSession, fresh: boolean): Promise<HedgeContext> {
  const now = Date.now();
  if (!fresh && s.ctx && now - s.ctx.at < CONTEXT_TTL_MS) return s.ctx.value;
  const value = await host.loadContext();
  s.ctx = { at: now, value };
  return value;
}

function scanContext(ctx: HedgeContext, symbol: string): ScanContext {
  return {
    symbol,
    displayName: symbol,
    category: "synthetic",
    prices: [],
    digits: [],
    balance: ctx.balance,
    settings: ctx.settings,
    daily: ctx.daily,
    token: ctx.token,
    currency: ctx.currency,
  };
}

function riskFor(ctx: HedgeContext, symbol: string) {
  return computeRiskDecision(scanContext(ctx, symbol), null);
}

function watchedMarkets(ctx: HedgeContext) {
  const allowed = ctx.allowedMarketSymbols;
  return allowed && allowed.length > 0
    ? AUTOMATED_DERIV_MARKETS.filter((m) => allowed.includes(m.symbol))
    : AUTOMATED_DERIV_MARKETS;
}

// ── Exposure gate ─────────────────────────────────────────────────────────────

function requestReconcile(s: HedgeSession): void {
  const now = Date.now();
  if (now - s.lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  s.lastReconcileAt = now;
  void reconcileUnsettledTrades();
}

async function hydrateExposure(host: HedgeHost, s: HedgeSession): Promise<void> {
  const open = await loadOpenAutonomousRows(host.sessionId);
  const row = open[0];
  if (!row) return;
  s.exposure = {
    rowId: row.id,
    symbol: row.symbol,
    contract: row.contractType,
    barrier: row.barrier ?? -1,
    key: candidateKey(row.symbol, row.contractType as HedgeCandidate["contract"], row.barrier ?? -1),
    decisionSequence: 0,
    contractId: row.derivContractId ? Number(row.derivContractId) : null,
    stake: Number(row.stake),
  };
  s.exposureSince = row.createdAt ? new Date(row.createdAt).getTime() : Date.now();
  logger.warn({ sessionId: host.sessionId, rowId: row.id }, "Autonomous engine resumed with an unresolved 1-tick exposure — gated until settled");
}

/**
 * Release a gate whose row Deriv has still not confirmed after the maximum
 * hold. The row is deliberately LEFT `open`: the reconciler keeps it (its
 * sweep window now reaches a week) and settles it with the same claim-unique
 * writer if the broker ever reports the contract, so the recovery ledger is
 * corrected rather than guessed. The engine only stops WAITING.
 */
function releaseStaleExposure(host: HedgeHost, s: HedgeSession, waitedMs: number): void {
  const exp = s.exposure;
  if (!exp) return;
  const minutes = Math.round(waitedMs / 60_000);
  logger.warn(
    { rowId: exp.rowId, symbol: exp.symbol, minutesHeld: minutes },
    "Autonomous 1-tick exposure held past the maximum hold — releasing the gate so the engine resumes; the row stays open for reconciliation",
  );
  clearExposure(s);
  s.ctx = null;
  requestReconcile(s);
  // Annotate the row for the journal. Status and ledger are untouched, so a
  // later exact settlement still claims it and records the outcome once.
  void db
    .update(tradesTable)
    .set({
      agentReasoning: sql`coalesce(${tradesTable.agentReasoning}, '') || ${` [GATE RELEASED after ${minutes}m: Deriv had not confirmed the outcome — the engine resumed; the row stays open for reconciliation]`}`,
    })
    .where(eq(tradesTable.id, exp.rowId))
    .catch((err: unknown) => logger.warn({ err, rowId: exp.rowId }, "Could not annotate the released exposure row"));
  host.emit("exposure_released", {
    id: exp.rowId,
    symbol: exp.symbol,
    contract: exp.contract,
    stake: exp.stake,
    heldMinutes: minutes,
    reason: `Exposure on ${exp.symbol} held for ${minutes}m without a Deriv confirmation — the engine resumed; the trade stays open in the journal and is settled automatically if Deriv reports it.`,
  });
}

/** True while the exposure is unresolved. Resolves it from the DB when it has settled. */
async function exposureResolved(host: HedgeHost, s: HedgeSession): Promise<boolean> {
  if (!s.exposure) return true;
  const now = Date.now();
  if (now - s.exposureCheckedAt < EXPOSURE_RECHECK_MS) return false;
  s.exposureCheckedAt = now;
  const [row] = await db.select().from(tradesTable).where(eq(tradesTable.id, s.exposure.rowId)).limit(1);
  if (row?.status === "open") {
    requestReconcile(s);
    // Bounded wait: past the maximum hold the gate opens again. Without this
    // the engine sat in this branch forever (see EXPOSURE_MAX_HOLD_MS).
    const waitedMs = s.exposureSince > 0 ? now - s.exposureSince : 0;
    if (waitedMs >= EXPOSURE_MAX_HOLD_MS) {
      releaseStaleExposure(host, s, waitedMs);
      return true;
    }
    return false;
  }
  if (!row) {
    // The row was removed outside the engine. Nothing can settle it, so release the gate.
    logger.warn({ rowId: s.exposure.rowId }, "Autonomous 1-tick exposure row no longer exists — releasing the gate");
    clearExposure(s);
    return true;
  }
  if (row.status === "won" || row.status === "lost") {
    const won = row.status === "won";
    // The reconciler has already recorded the ledger for this row.
    clearLadderOutcomeCache();
    if (s.exposure.mode === "RECOVERY" && typeof s.exposure.pTilde === "number") {
      s.calibrationGuard.recordRecoveryTrade({ won, pTilde: s.exposure.pTilde });
    }
    applySettlement(s.memory, {
      won,
      key: s.exposure.key,
      lossRun: recoveryEngine.getState().streakLossCount,
      decisionSequence: s.exposure.decisionSequence,
    });
    s.ctx = null;
    host.afterSettlement(await getContext(host, s, true));
  }
  clearExposure(s);
  return true;
}

// ── Hold scans: a running engine must never go silent ───────────────────────────
//
// Two cycle outcomes used to return without emitting anything: the exposure
// gate (previous trade unsettled) and a null contest decision (no market
// produced a ranked row). The dashboard then sat forever on its fallback
// "Scanning markets…" text with no contest blocks and no reason —
// indistinguishable from a dead engine. Every evaluated cycle now publishes a
// throttled `scan_complete` HOLD carrying the exact human-readable cause, so
// the UI always shows either live contest blocks or the reason there are none.

/** Per-cycle classification of every watched market's tape. */
export interface FeedDiagnosis {
  watched: number;
  /** Tapes fresh enough to rank (live, or simulated when paper mode allows it). */
  fresh: number;
  live: number;
  simulated: number;
  /** Fresh tapes still below the ranker's minimum tick count. */
  thin: number;
  stale: number;
  missing: number;
  /** Fresh tapes skipped because they are simulated and paper mode is off. */
  simSkipped: number;
  /** Fresh, thick tapes whose mode set resolved to zero family specs. */
  noSpecs: number;
}

export function emptyFeedDiagnosis(watched: number): FeedDiagnosis {
  return { watched, fresh: 0, live: 0, simulated: 0, thin: 0, stale: 0, missing: 0, simSkipped: 0, noSpecs: 0 };
}

/**
 * The exact user-facing reason no contest could run this cycle. Ordered from
 * most to least specific so the first matching cause is the one reported.
 */
export function describeFeedHold(d: FeedDiagnosis): string {
  const n = d.watched;
  if (n === 0) {
    return "HOLD: no markets are enabled for the autonomous engine — check Settings → Allowed markets.";
  }
  if (d.missing === n) {
    return `HOLD: waiting for market data — no ticks received yet on any of the ${n} watched markets. The tournament starts on the first tick.`;
  }
  if (d.live === 0 && d.simSkipped > 0) {
    return `HOLD: live feed unavailable — ${d.simSkipped}/${n} watched markets are on simulated ticks, which live trading never uses. Turn on Paper Trade Mode in Settings to trade the simulated feed, or wait for the Deriv connection to recover.`;
  }
  if (d.fresh === 0 && d.stale > 0) {
    return `HOLD: waiting for fresh ticks — ${d.stale}/${n} watched markets are stale (no tick for over ${Math.round(STALE_TAPE_MS / 1000)}s). The engine resumes automatically when the feed recovers.`;
  }
  if (d.thin > 0 && d.fresh - d.thin - d.noSpecs <= 0) {
    return `HOLD: warming up — ${d.thin} market${d.thin === 1 ? " has" : "s have"} fewer than ${HEDGE_MIN_TICKS} ticks so far. The tournament starts once the tapes fill.`;
  }
  if (d.noSpecs > 0 && d.fresh - d.thin - d.noSpecs <= 0) {
    return "HOLD: no tradeable contracts resolved for the current mode — check Settings → Autonomous contracts.";
  }
  const parts: string[] = [];
  if (d.stale > 0) parts.push(`${d.stale} stale`);
  if (d.missing > 0) parts.push(`${d.missing} without data`);
  if (d.simSkipped > 0) parts.push(`${d.simSkipped} simulated`);
  if (d.thin > 0) parts.push(`${d.thin} warming up`);
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `HOLD: no candidates ranked this tick — ${d.fresh}/${n} watched markets have fresh data${detail}.`;
}

function formatWait(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
}

function settlingHoldReason(s: HedgeSession): string {
  const exp = s.exposure;
  const waitedMs = s.exposureSince > 0 ? Date.now() - s.exposureSince : 0;
  const waiting = waitedMs > 0 ? formatWait(waitedMs) : null;
  const what = exp ? ` on ${exp.symbol} (#${exp.rowId}${waiting ? `, waiting ${waiting}` : ""})` : "";
  const maxHoldMin = Math.round(EXPOSURE_MAX_HOLD_MS / 60_000);
  const left = EXPOSURE_MAX_HOLD_MS - waitedMs;
  const tail = left > 0 ? ` The engine resumes trading in ${formatWait(left)} even if Deriv has not confirmed.` : "";
  return `HOLD: settling previous 1-tick trade${what} — the engine resumes as soon as Deriv confirms the outcome, and holds at most ${maxHoldMin}m.${tail} Nothing is dropped while it waits.`;
}

/**
 * Throttled HOLD `scan_complete` for cycles that evaluated but produced no
 * contest (feed hold) or that never reached the contest (exposure gate). Shares
 * the publish throttle with `publishScan`, so a tick-driven engine emits at
 * most one scan burst per throttle window however the cycles interleave.
 * `started` pulses `scan_started` first when the cycle actually evaluated the
 * contest (feed holds); the exposure gate emits the HOLD alone (nothing ran).
 */
function emitHoldScan(
  host: HedgeHost,
  s: HedgeSession,
  input: {
    reason: string;
    mode: HedgeMode;
    lossRun: number;
    consecutiveLossLimit: number | null;
    marketsScanned: number;
    feed?: FeedDiagnosis;
    started?: { markets: number; mode: HedgeMode };
  },
): void {
  const now = Date.now();
  if (now - s.lastEmitAt < EMIT_THROTTLE_MS) return;
  s.lastEmitAt = now;
  if (input.started) host.emit("scan_started", { markets: input.started.markets, mode: input.started.mode });
  host.emit("scan_complete", {
    symbol: null,
    quality: 0,
    confidence: 0,
    marketsScanned: input.marketsScanned,
    regime: null,
    shouldTrade: false,
    rejectReason: input.reason,
    sessionLossCount: input.lossRun,
    consecutiveLossLimit: input.consecutiveLossLimit,
    mode: input.mode,
    contract: null,
    barrier: null,
    confirmations: 0,
    requiredConfirmations: requiredConfirmations(input.lossRun),
    rescanInProgress: false,
    feed: input.feed ?? null,
  });
}

function buildV2LadderConfig(
  ctx: HedgeContext,
  ledger: recoveryEngine.RecoveryState,
  risk: RiskDecision,
): V2LadderConfig {
  const base = ledger.baseStake > 0 ? ledger.baseStake : risk.recommendedStake;
  return {
    method: ctx.settings.recoveryMethod,
    autoMode: ctx.settings.recoveryAutoMode,
    multiplier: ctx.settings.recoveryMultiplier,
    step: Math.max(1, ledger.recoveryStep || 1),
    maxRecoverySteps: ctx.settings.maxRecoverySteps,
    debt: ledger.unrecoveredAmount > 0 ? ledger.unrecoveredAmount : base,
    targetRemaining: Math.max(0, ledger.remainingTargetProfit),
    base,
    maxTradeStake: ctx.settings.maxTradeStake,
    balance: ctx.balance,
    consecutiveLossLimit: ctx.consecutiveLossLimit,
    currentLossRun: ledger.streakLossCount,
    hardStop: risk.hardStop,
  };
}

function recomputeV2CandidatesOnFreshestTapes(
  s: HedgeSession,
  ctx: HedgeContext,
  risk: RiskDecision,
): { ranked: V2ScoredCandidate[]; tapes: Map<string, HedgeTape> } {
  const markets = watchedMarkets(ctx);
  const marketInputs: MarketTapeInput[] = [];
  const tickSequenceBySymbol = new Map<string, number>();
  const tapes = new Map<string, HedgeTape>();
  const ledger = recoveryEngine.getState();
  const escalation = recoveryEscalation(ledger.streakLossCount, ledger.recoveryStep);

  for (const market of markets) {
    const tape = readHedgeTape(market.symbol, HEDGE_V2_MAX_WINDOW);
    if (!tape || tape.ageMs > STALE_TAPE_MS) continue;
    // Live only. Simulated prices can never back a real order, and there is no
    // paper mode to back a simulated one (see the HOLD below).
    if (!tape.live) continue;
    const specs = familySpecsFor({
      settings: ctx.settings,
      mode: "RECOVERY",
      digitEnabled: market.digitEnabled,
      sets: ctx.contractSets,
    });
    if (specs.length === 0 || tape.digits.length < HEDGE_MIN_TICKS) continue;
    tapes.set(market.symbol, tape);
    tickSequenceBySymbol.set(market.symbol, tape.tickSequence);
    marketInputs.push({
      symbol: market.symbol,
      digits: tape.digits,
      prices: tape.prices,
      tickSequence: tape.tickSequence,
      specs,
    });
  }

  const evidenceRows = s.evidenceTracker.evaluate({
    markets: marketInputs,
    marketsScanned: marketInputs.length,
    payoutResolver: (symbol, contract, barrier) => livePayoutFor({ symbol, contract, barrier }),
    evidenceWeight: s.calibrationGuard.getEvidenceWeight(),
  });
  const ladder = buildV2LadderConfig(ctx, ledger, risk);
  const ranked = scoreV2Candidates({
    evidenceRows,
    tickSequenceBySymbol,
    ladder,
    escalation,
  });
  return { ranked, tapes };
}

// ── Cycle ─────────────────────────────────────────────────────────────────────

async function runCycle(host: HedgeHost, s: HedgeSession): Promise<void> {
  if (!host.isRunning()) return;
  if (!host.canExecute()) return;

  if (!s.hydrated) {
    await hydrateExposure(host, s);
    s.hydrated = true;
  }
  if (!(await exposureResolved(host, s))) {
    host.publish({ currentMarket: s.exposure?.symbol ?? null, nextScanIn: null });
    // Gated, not dead: tell the dashboard exactly what the engine is waiting
    // for instead of leaving it on a reasonless "Scanning markets…".
    emitHoldScan(host, s, {
      reason: settlingHoldReason(s),
      mode: recoveryEngine.isInRecovery() ? "RECOVERY" : "NORMAL",
      lossRun: recoveryEngine.getState().streakLossCount,
      consecutiveLossLimit: null,
      marketsScanned: 0,
    });
    return;
  }

  const ctx = await getContext(host, s, false);
  const mode: HedgeMode = recoveryEngine.isInRecovery() ? "RECOVERY" : "NORMAL";
  const ledger = recoveryEngine.getState();
  const lossRun = ledger.streakLossCount;
  // Depth of THIS recovery episode. streakLossCount resets on any win and on a
  // cooldown auto-resume; recoveryStep only clears when the debt is repaid, so
  // the maximum keeps the recovery ranking honest across a cooldown.
  const escalation = recoveryEscalation(lossRun, ledger.recoveryStep);

  // 0. Hard limits first. A breached limit stops the engine before anything is ranked.
  const risk = riskFor(ctx, watchedMarkets(ctx)[0]?.symbol ?? "");
  if (risk.hardStop) {
    const consecutive = ctx.daily.consecutiveLosses >= ctx.consecutiveLossLimit;
    if (consecutive) stopForLossLimit(host, ctx, risk.hardStopReason ?? "risk limit reached");
    else host.stop(risk.hardStopReason ?? "risk limit reached");
    return;
  }

  // 1. Read every watched market's 1-tick tape and rank its families.
  //    Every skip is classified into the feed diagnosis so a cycle that ranks
  //    nothing can still report WHY (see the null-decision HOLD below) instead
  //    of returning silently and stranding the dashboard on "Scanning markets…".
  const v2Mode = mode === "RECOVERY" ? getRecoveryV2Mode() : "off";
  const useV2Recovery = mode === "RECOVERY" && v2Mode !== "off";
  const tapeWindow = useV2Recovery ? HEDGE_V2_MAX_WINDOW : HEDGE_WINDOW;

  const markets = watchedMarkets(ctx);
  const feed = emptyFeedDiagnosis(markets.length);
  const tapes: HedgeTape[] = [];
  const rows: HedgeCandidate[] = [];
  const v2MarketInputs: MarketTapeInput[] = [];
  const v2TickSequenceBySymbol = new Map<string, number>();
  const latestObservations = new Map<string, LatestTickObservation>();
  const allRecoverySpecs: HedgeFamilySpec[] = [];

  for (const market of markets) {
    const tape = readHedgeTape(market.symbol, tapeWindow);
    if (!tape) { feed.missing += 1; continue; }
    if (tape.ageMs > STALE_TAPE_MS) { feed.stale += 1; continue; }
    // Live trades never rely on simulated prices. Paper mode may use either.
    if (!tape.live) { feed.simSkipped += 1; continue; }
    feed.fresh += 1;
    if (tape.live) feed.live += 1;
    else feed.simulated += 1;
    const specs = familySpecsFor({
      settings: ctx.settings,
      mode,
      digitEnabled: market.digitEnabled,
      sets: ctx.contractSets,
    });
    if (specs.length === 0) { feed.noSpecs += 1; continue; }
    if (tape.digits.length < HEDGE_MIN_TICKS) { feed.thin += 1; continue; }
    tapes.push(tape);

    const v1Digits = useV2Recovery ? tape.digits.slice(-HEDGE_WINDOW) : tape.digits;
    const v1Prices = useV2Recovery ? tape.prices.slice(-HEDGE_WINDOW) : tape.prices;

    if (v2Mode !== "on") {
      rows.push(...buildMarketCandidates({
        symbol: market.symbol,
        group: hedgeGroupIndex(market.symbol),
        digits: v1Digits,
        prices: v1Prices,
        tickSequence: tape.tickSequence,
        specs,
        mode,
        escalation,
      }));
    } else if (useV2Recovery) {
      // In "on" mode, still build v1 rows for M6 shadow-ledger comparison without mutating v1 memory.
      rows.push(...buildMarketCandidates({
        symbol: market.symbol,
        group: hedgeGroupIndex(market.symbol),
        digits: v1Digits,
        prices: v1Prices,
        tickSequence: tape.tickSequence,
        specs,
        mode,
        escalation,
      }));
    }

    if (useV2Recovery) {
      v2MarketInputs.push({
        symbol: market.symbol,
        digits: tape.digits,
        prices: tape.prices,
        tickSequence: tape.tickSequence,
        specs,
      });
      v2TickSequenceBySymbol.set(market.symbol, tape.tickSequence);
      const len = tape.digits.length;
      latestObservations.set(market.symbol, {
        symbol: market.symbol,
        tickSequence: tape.tickSequence,
        digit: tape.digits[len - 1]!,
        price: tape.prices[len - 1]!,
        prevPrice: len >= 2 ? tape.prices[len - 2]! : tape.prices[len - 1]!,
      });
      if (allRecoverySpecs.length === 0) {
        allRecoverySpecs.push(...specs);
      }
    }
  }

  if (!useV2Recovery) {
    stopQuotePrefetchTask(host.sessionId);
  } else {
    syncQuotePrefetchTask({
      sessionId: host.sessionId,
      active: true,
      symbols: tapes.map((t) => t.symbol),
      specs: allRecoverySpecs,
      currency: ctx.currency,
    });
    s.calibrationGuard.onTick(1);
  }

  // 2. Contest and gate.
  let decision: HedgeDecision | null = null;
  if (!useV2Recovery) {
    // NORMAL mode (byte-for-byte unchanged) or RECOVERY with RECOVERY_V2_MODE === "off"
    decision = decideHedge({ rows, mode, memory: s.memory, lossRun, escalation });
  } else {
    // RECOVERY with RECOVERY_V2_MODE === "shadow" | "on"
    const evidenceRows = s.evidenceTracker.evaluate({
      markets: v2MarketInputs,
      marketsScanned: v2MarketInputs.length,
      payoutResolver: (symbol, contract, barrier) => livePayoutFor({ symbol, contract, barrier }),
      evidenceWeight: s.calibrationGuard.getEvidenceWeight(),
    });
    const ladder = buildV2LadderConfig(ctx, ledger, risk);
    const v2Ranked = scoreV2Candidates({
      evidenceRows,
      tickSequenceBySymbol: v2TickSequenceBySymbol,
      ladder,
      escalation,
    });
    const v1RankedForLedger = rankRows(rows.map((r) => ({ ...r })));

    defaultShadowLedger.stepTick({
      observations: latestObservations,
      v2Ranked,
      v1Ranked: v1RankedForLedger,
    });

    if (v2Ranked.length > 0) {
      const v2Best = v2Ranked[0]!;
      let maxSeq = 0;
      for (const t of tapes) {
        if (t.tickSequence > maxSeq) maxSeq = t.tickSequence;
      }
      let baselineJ = v2Best.nullJ;
      for (const c of v2Ranked) {
        if (c.nullJ < baselineJ) baselineJ = c.nullJ;
      }
      // Value-of-waiting is kept as TELEMETRY only.
      //
      // It used to gate dispatch, but it cannot improve a trade's realised
      // expectancy: the outcome distribution does not change because we waited.
      // It was also measured inert (median/p99 wait 0/0 ticks), so it bought
      // nothing and cost decision->buy latency that the pre-buy revalidation
      // below then had to re-check. Dispatch is now immediate on a gate pass;
      // when the gate does not pass, the engine holds and re-scans next tick.
      const timing = s.timingV2.evaluate({
        bestJ: v2Best.J,
        baselineJ,
        tickSequence: maxSeq,
      });
      const v2Decision = buildV2RecoveryDecision({
        ranked: v2Ranked,
        escalation,
        waitTicks: 0,
        shouldFireNow: true,
      });
      const v2Telemetry: HedgeV2ScanTelemetry = {
        mode: v2Mode,
        pTilde: Math.round(v2Best.pTilde * 10000) / 10000,
        z: Math.round(v2Best.z * 1000) / 1000,
        edgeIndex: Math.round(v2Best.edgeIndex * 1000) / 1000,
        J: Math.round(v2Best.J * 1000) / 1000,
        pStop: Math.round(v2Best.pStop * 10000) / 10000,
        waitTicks: timing.waitTicks,
        skill: Math.round(defaultShadowLedger.getMetrics("v2").brierSkill * 1000) / 1000,
      };

      if (v2Mode === "shadow") {
        const v1Decision = decideHedge({ rows, mode, memory: s.memory, lossRun, escalation });
        if (v1Decision) {
          const v2ContractLabel = v2Best.barrier >= 0 ? `${v2Best.contract} ${v2Best.barrier}` : v2Best.contract;
          const v1ContractLabel =
            v1Decision.best.barrier >= 0
              ? `${v1Decision.best.contract} ${v1Decision.best.barrier}`
              : v1Decision.best.contract;
          const shadowNote = ` [v2 shadow: would trade ${v2Best.symbol} ${v2ContractLabel} J=${v2Best.J.toFixed(3)} | v1 chose ${v1Decision.best.symbol} ${v1ContractLabel}]`;
          v1Decision.reason = `${v1Decision.reason}${shadowNote}`;
          v1Decision.v2 = v2Telemetry;
          decision = v1Decision;
        }
      } else if (v2Decision) {
        v2Decision.v2 = v2Telemetry;
        decision = v2Decision;
      }
    }
  }

  if (!decision) {
    host.publish({ currentMarket: null, nextScanIn: null });
    // Ranked nothing this tick — HOLD with the feed cause, never silence.
    emitHoldScan(host, s, {
      reason: describeFeedHold(feed),
      mode,
      lossRun,
      consecutiveLossLimit: ctx.consecutiveLossLimit,
      marketsScanned: tapes.length,
      feed,
      started: { markets: tapes.length, mode },
    });
    return;
  }

  // 3. Publish the cycle (throttled — the engine may evaluate on every tick).
  //    The 14 advisory agents that used to run here were removed: they only
  //    published cosmetic scores, while the trade decision comes from the Nexus
  //    gate, the rescan memory and the risk hard-stops (see
  //    docs/autonomous-nexus-hedge-plan.md).
  publishScan(host, s, decision, lossRun, ctx, tapes.length);

  if (!decision.eligible) return;

  // 4. Trade. Re-read context on fresh data before any money moves.
  const fresh = await getContext(host, s, true);
  const freshRisk = riskFor(fresh, decision.best.symbol);
  if (freshRisk.hardStop) {
    const consecutive = fresh.daily.consecutiveLosses >= fresh.consecutiveLossLimit;
    if (consecutive) stopForLossLimit(host, fresh, freshRisk.hardStopReason ?? "risk limit reached");
    else host.stop(freshRisk.hardStopReason ?? "risk limit reached");
    return;
  }
  if (!host.canExecute()) return;
  const lastPrice = tapes.find((t) => t.symbol === decision.best.symbol)?.prices.at(-1) ?? 0;
  await executeDecision(host, s, decision, fresh, mode, freshRisk, lastPrice);
}

function publishScan(
  host: HedgeHost,
  s: HedgeSession,
  decision: HedgeDecision,
  lossRun: number,
  ctx: HedgeContext,
  rankedTapes: number,
): void {
  host.publish({
    currentMarket: decision.best.symbol,
    sessionLossCount: lossRun,
    nextScanIn: null,
  });
  const now = Date.now();
  if (now - s.lastEmitAt < EMIT_THROTTLE_MS) return;
  s.lastEmitAt = now;
  // The dashboard's scanning pulse. This event never existed after the 1-tick
  // rewrite, so the UI's "running tournament" state was unreachable until now.
  host.emit("scan_started", { markets: rankedTapes, mode: decision.mode });
  const b = decision.best;
  host.emit("scan_complete", {
    symbol: b.symbol,
    quality: Math.round(b.probability * 100),
    confidence: Math.round(b.lowerBound * 100),
    marketsScanned: rankedTapes,
    regime: null,
    shouldTrade: decision.eligible,
    rejectReason: decision.eligible ? null : decision.reason,
    sessionLossCount: lossRun,
    consecutiveLossLimit: ctx.consecutiveLossLimit,
    mode: decision.mode,
    contract: b.contract,
    barrier: b.barrier,
    confirmations: decision.confirmations,
    requiredConfirmations: decision.requiredConfirmations,
    rescanInProgress: decision.rescanInProgress,
    // Recovery risk model (docs/recovery-trade-mathematical-design.md): the
    // posterior probability the true win rate beats break-even, the three-loss
    // stress indicator, and the loss-streak weight the score used.
    posteriorEdge: Math.round(b.posteriorEdgeProbability * 1000) / 1000,
    lossRunRisk: Math.round(b.lossRunRisk * 1000) / 1000,
    riskWeight: Math.round(b.riskWeight * 100) / 100,
    escalation: decision.escalation,
    ...(decision.v2 ? { v2: decision.v2 } : {}),
  });
  for (const gw of decision.groupWinners) {
    const w = gw.winner;
    host.emit("group_scanned", {
      group: HEDGE_GROUP_NAMES[gw.group],
      totalInGroup: gw.rowsInGroup,
      scanned: gw.rowsInGroup,
      bestSymbol: w.symbol,
      bestDisplayName: w.symbol,
      quality: Math.round(w.probability * 100),
      shouldTrade: decision.eligible && w.key === b.key,
      contract: w.contract,
      confidence: Math.round(w.lowerBound * 100),
      family: w.contract,
      families: [],
      rejectReason: w.eligible ? null : decision.reason,
    });
  }
}

// ── Execution ─────────────────────────────────────────────────────────────────

/**
 * Normal: the risk-adjusted settings stake (computeStake plus soft reduction, no
 * Kelly). Recovery: the unchanged recovery ladder, sized from the same base
 * stake and the payout quote. The quote is used only when it is live, as before.
 */
async function resolveStake(
  decision: HedgeDecision,
  ctx: HedgeContext,
  mode: HedgeMode,
  risk: RiskDecision,
): Promise<{ stake: number; payout: number }> {
  const b = decision.best;
  const base = risk.recommendedStake;
  if (mode === "NORMAL") {
    return { stake: base, payout: b.payout };
  }
  const quote = await resolveRecoveryPayout({
    symbol: b.symbol,
    contractType: b.contract,
    barrier: b.barrier >= 0 ? b.barrier : null,
    duration: HEDGE_DURATION_TICKS,
    durationUnit: HEDGE_DURATION_UNIT,
    currency: ctx.currency,
  });
  const payout = quote.source === "live" || !Number.isFinite(b.payout) || b.payout <= 1 ? quote.payoutMultiplier : b.payout;
  const stake = recoveryEngine.getDynamicRecoveryStake(
    base,
    ctx.settings.maxTradeStake,
    ctx.balance,
    payout,
    b.probability,
    ctx.settings.riskProfile,
    ctx.settings.recoveryMultiplier,
    ctx.settings.recoveryMethod,
    ctx.settings.maxRecoverySteps,
    ctx.settings.recoveryAutoMode,
  );
  return { stake, payout };
}

function barrierFor(row: HedgeCandidate): number | null {
  // Even/Odd and direction carry no barrier. Over/Under, Matches and Differs do.
  if (row.contract === "DIGITEVEN" || row.contract === "DIGITODD" || row.contract === "CALL" || row.contract === "PUT") {
    return null;
  }
  return row.barrier >= 0 ? row.barrier : null;
}

function recordLedger(
  sessionId: string,
  outcome: { won: boolean; profit: number; cost: number; contract: string; payout: number; maxRecoverySteps: number },
): void {
  runWithSession(sessionId, () => {
    recoveryEngine.setPersistenceSession(sessionId);
    if (!recoveryEngine.isTrackedContract(outcome.contract)) return;
    recoveryEngine.recordOutcome(
      outcome.won, outcome.profit, outcome.cost, outcome.maxRecoverySteps, outcome.contract, outcome.payout,
    );
  });
}

async function executeDecision(
  host: HedgeHost,
  s: HedgeSession,
  decision: HedgeDecision,
  ctx: HedgeContext,
  mode: HedgeMode,
  risk: RiskDecision,
  lastPrice: number,
): Promise<void> {
  let activeDecision = decision;
  let activeLastPrice = lastPrice;
  const sessionId = host.sessionId;
  let { stake: rawStake, payout } = await resolveStake(activeDecision, ctx, mode, risk);

  // M8 / M4 pre-dispatch freshness re-evaluation (when RECOVERY_V2_MODE === "on"):
  // AFTER the existing awaits (context refresh, quote) and BEFORE buy, recompute J
  // for the chosen candidate on the freshest tape; if another candidate now beats
  // it by more than 0.02 (or >1 tick elapsed and a better candidate exists), switch once.
  // Runs whenever RECOVERY is deciding through v2 (shadow still lets v1 decide,
  // so re-ranking there would be meaningless).
  if (mode === "RECOVERY" && getRecoveryV2Mode() === "on") {
    const { ranked: freshRanked, tapes: freshTapes } = recomputeV2CandidatesOnFreshestTapes(s, ctx, risk);
    if (freshRanked.length > 0) {
      const chosenFresh = freshRanked.find((r) => r.key === activeDecision.best.key);
      const bestFresh = freshRanked[0]!;
      const chosenJ = chosenFresh ? chosenFresh.J : -activeDecision.best.score;
      const stale =
        chosenFresh !== undefined && isDecisionStale(activeDecision.best.tickSequence, chosenFresh.tickSequence);
      const shouldSwitch =
        bestFresh.eligible &&
        bestFresh.key !== activeDecision.best.key &&
        (shouldSwitchCandidateBeforeBuy(chosenJ, bestFresh.J) || (stale && bestFresh.J < chosenJ));
      if (shouldSwitch) {
        const switchedDecision = buildV2RecoveryDecision({
          ranked: freshRanked,
          escalation: activeDecision.escalation,
          waitTicks: activeDecision.v2?.waitTicks ?? 0,
          shouldFireNow: true,
        });
        if (switchedDecision) {
          switchedDecision.reason = `${switchedDecision.reason} [switched pre-buy from ${activeDecision.best.symbol} ${activeDecision.best.contract} dJ=${(chosenJ - bestFresh.J).toFixed(3)}]`;
          activeDecision = switchedDecision;
          activeLastPrice = freshTapes.get(bestFresh.symbol)?.prices.at(-1) ?? activeLastPrice;
          const resolved = await resolveStake(activeDecision, ctx, mode, risk);
          rawStake = resolved.stake;
          payout = resolved.payout;
        }
      } else if (chosenFresh) {
        // Keep chosen candidate on freshest probability/sequence
        activeDecision = {
          ...activeDecision,
          best: chosenFresh,
        };
        activeLastPrice = freshTapes.get(chosenFresh.symbol)?.prices.at(-1) ?? activeLastPrice;
      }
    }
  }

  // Pre-dispatch STALENESS REFUSAL (recovery, v2 deciding).
  //
  // The decision was formed before the awaits above (context refresh, payout
  // quote). One tick later the evidence it was based on may no longer clear the
  // gate. Sending the order anyway would be trading a signal the engine no longer
  // believes — the exact failure mode that turned a 120-tick transient into a
  // filled contract. Refuse, and let the next fresh tick re-decide.
  if (mode === "RECOVERY" && getRecoveryV2Mode() === "on") {
    const staleBest = activeDecision.best as V2ScoredCandidate;
    if (typeof staleBest.gateEv === "number" && !activeDecision.best.eligible) {
      host.publish({ nextScanIn: null });
      logger.info(
        { symbol: activeDecision.best.symbol, blocker: staleBest.gateBlocker },
        "Autonomous 1-tick: recovery decision no longer clears the gate — holding",
      );
      emitHoldScan(host, s, {
        reason: `RECOVERY HOLD · the entry no longer clears the admissibility gate (${staleBest.gateBlocker ?? "no edge"}) — re-deciding on the next tick`,
        mode: "RECOVERY",
        lossRun: runWithSession(sessionId, () => recoveryEngine.getState().streakLossCount),
        consecutiveLossLimit: ctx.consecutiveLossLimit,
        marketsScanned: 0,
      });
      return;
    }
  }

  const b = activeDecision.best;
  const reasoningBase = `${AUTONOMOUS_HEDGE_PREFIX}${activeDecision.reason}`;
  const stake = Math.round(rawStake * 100) / 100;
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > ctx.balance) {
    host.publish({ nextScanIn: null });
    logger.warn({ stake, balance: ctx.balance }, "Autonomous 1-tick: stake outside the allowed range — holding");
    return;
  }
  const barrier = barrierFor(b);
  const displayName = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === b.symbol)?.displayName ?? b.symbol;
  const direction = b.contract === "CALL" ? "up" : b.contract === "PUT" ? "down" : "neutral";
  const riskScore = Math.round(100 * (1 - risk.riskBudget));

  // ── NO PAPER MODE ───────────────────────────────────────────────────────────
  //
  // This branch used to settle the trade with `Math.random() < b.probability`,
  // i.e. from the engine's OWN belief rather than from the tape. That made the
  // outcome a tautology: a phantom "+45% EV" produced a beautiful paper P&L, so
  // every experiment run through it validated the engine against its own
  // assumptions. It is gone.
  //
  // No live account means no trade. Nothing is journalled, nothing enters the
  // recovery ledger, and no settlement is invented — the engine says why it is
  // waiting and leaves the debt exactly where it is.
  if (!ctx.token) {
    host.publish({ nextScanIn: null });
    logger.info(
      { symbol: b.symbol, contract: b.contract },
      "Autonomous 1-tick: no live Deriv connection — holding (paper mode removed)",
    );
    emitHoldScan(host, s, {
      reason:
        "HOLD · no live Deriv connection. This engine does not simulate trades: " +
        "connect an account in Settings to trade, or leave it stopped.",
      mode: activeDecision.mode,
      lossRun: runWithSession(sessionId, () => recoveryEngine.getState().streakLossCount),
      consecutiveLossLimit: ctx.consecutiveLossLimit,
      marketsScanned: 0,
    });
    return;
  }

  // ── Live: one exposure at a time, exact contract id, conditional claim ──
  if (!isAutomatedMarket(b.symbol)) {
    host.publish({ nextScanIn: null });
    logger.warn({ symbol: b.symbol }, "Autonomous 1-tick: market is not automated — holding");
    return;
  }
  const accountId = ctx.derivAccountId!;
  const token = ctx.token!;

  // ── ONE trade at a time, and only the analysed+tuned decision ───────────────
  // Two gates, both BEFORE a row exists, so a refused or skipped attempt never
  // leaves a phantom "open" trade behind:
  //
  //  1. This exact decision must not be a re-send of one Deriv just refused.
  //     The cycle request coalesces ticks, so a fast broker refusal used to
  //     re-rank the SAME tape and buy again immediately — three refusals inside a
  //     second, three strikes, and the engine stopped with
  //     "Deriv rejected 3 consecutive 1-tick buys". A fresh attempt now needs a
  //     fresh analysed tick PLUS a short backoff.
  //  2. No purchase may already be in flight on the account. `executeLiveTrade`
  //     enforces this too; checking here keeps the journal clean (no row that was
  //     never bought) when a manual trade, another engine, or a cycle whose
  //     session state was reset got there first.
  const holdReason = liveAttemptHoldReason(s.liveGate, b, Date.now());
  if (holdReason) {
    host.publish({ nextScanIn: null });
    logger.warn(
      { symbol: b.symbol, contract: b.contract, tickSequence: b.tickSequence },
      `Autonomous 1-tick: not buying — ${holdReason}`,
    );
    return;
  }
  if (isLiveOrderInFlight(accountId)) {
    host.publish({ nextScanIn: null });
    logger.warn(
      { symbol: b.symbol, accountId },
      "Autonomous 1-tick: another purchase is already in flight on this account — holding instead of placing a second trade",
    );
    return;
  }
  const [openRow] = await db.insert(tradesTable).values({
    sessionId,
    symbol: b.symbol,
    displayName,
    contractType: b.contract,
    barrier,
    stake: String(stake),
    direction,
    status: "open",
    // The quote this trade is sized and recorded on. Kept on the row so the
    // reconciler can settle it with the same target profit if it has to.
    entryPayout: Number.isFinite(payout) && payout > 1 ? String(payout) : null,
    aiConfidence: String(Math.round(b.probability * 10000) / 100),
    aiRiskScore: String(riskScore),
    isAutonomous: true,
    // Snapshot of execution truth so far (quote drift / dispatch latency). The
    // settlement-time alarm below adds the CURRENT contract's observation.
    agentReasoning: (() => {
      const note = describeExecutionTruth();
      return note ? `${reasoningBase} · [truth] ${note}` : reasoningBase;
    })(),
    duration: HEDGE_DURATION_TICKS,
    durationUnit: HEDGE_DURATION_UNIT,
  }).returning();

  s.exposure = {
    rowId: openRow.id,
    symbol: b.symbol,
    contract: b.contract,
    barrier: b.barrier,
    key: b.key,
    decisionSequence: b.tickSequence,
    contractId: null,
    stake,
    mode,
    pTilde: b.probability,
  };
  s.exposureCheckedAt = Date.now();
  s.exposureSince = Date.now();
  host.emit("trade_started", {
    id: openRow.id, symbol: b.symbol, contract: b.contract, barrier, stake,
    duration: HEDGE_DURATION_TICKS, regime: null, confidence: Math.round(b.probability * 100),
    ev: b.ev, mode: activeDecision.mode,
  });

  let contractId: number;
  let buyPrice: number;
  try {
    const bought = await executeLiveTrade(token, {
      symbol: b.symbol,
      contractType: b.contract,
      stake,
      duration: HEDGE_DURATION_TICKS,
      durationUnit: HEDGE_DURATION_UNIT,
      currency: ctx.currency,
      accountId,
      barrier: barrier ?? undefined,
    });
    contractId = Number(bought.contractId);
    buyPrice = Number(bought.buyPrice) > 0 ? Number(bought.buyPrice) : stake;
  } catch (buyErr) {
    if (buyErr instanceof TradeOutcomeUnknownError) {
      // The buy was sent but not acknowledged. Look for this exact trade on the broker's books.
      const found = await findBrokerPurchase(sessionId, token, accountId, openRow, {
        symbol: b.symbol, contract: b.contract, stake,
      });
      if (!found) {
        logger.warn({ rowId: openRow.id, symbol: b.symbol }, "Autonomous 1-tick: buy not acknowledged and not yet on the broker's books — exposure held");
        requestReconcile(s);
        host.emit("trade_completed", { id: openRow.id, symbol: b.symbol, won: false, profit: "0", contract: b.contract, pending: true, error: "Purchase unconfirmed — settling from Deriv records" });
        return;
      }
      contractId = found.contractId;
      buyPrice = found.buyPrice;
    } else {
      // No contract was placed, so nothing enters the ledger. Two different
      // things can land here and they must NOT be counted alike:
      //
      //  - LiveOrderInFlightError: another purchase pipeline on this account got
      //    the order slot first (a manual trade, another engine, a cycle that was
      //    restarted mid-order). Nothing was refused by the broker and this
      //    engine did nothing wrong — it is a SKIP, not a strike.
      //  - anything else: a definite broker refusal. That IS a strike, and three
      //    consecutive ones still stop the engine (a deterministic refusal must
      //    not be retried forever).
      const skipped = buyErr instanceof LiveOrderInFlightError;
      const message = buyErr instanceof Error ? buyErr.message : String(buyErr);
      await claimOpenRow(openRow.id, {
        status: "error",
        profit: "0",
        payout: "0",
        closedAt: new Date(),
        agentReasoning: `${reasoningBase} [${skipped ? "NOT SENT" : "EXECUTION FAILED"}: ${message}]`,
      });
      clearExposure(s);
      if (skipped) {
        logger.warn({ symbol: b.symbol }, "Autonomous 1-tick: purchase skipped — another order was in flight on this account");
        host.emit("trade_completed", { id: openRow.id, symbol: b.symbol, won: false, profit: "0", contract: b.contract, error: message });
        return;
      }
      // A refusal also arms the attempt gate: the next live buy needs a NEW
      // analysed tick and a short backoff, so a coalesced tick can never re-send
      // the trade that was just refused (three rapid re-sends == three strikes).
      recordRefusedLiveAttempt(s.liveGate, b, Date.now());
      s.execFailures += 1;
      logger.warn({ err: message, symbol: b.symbol, failures: s.execFailures }, "Autonomous 1-tick buy rejected by Deriv");
      host.emit("trade_completed", { id: openRow.id, symbol: b.symbol, won: false, profit: "0", contract: b.contract, error: message });
      if (s.execFailures >= CONSECUTIVE_EXEC_FAILURE_LIMIT) {
        host.stop(`Deriv rejected ${CONSECUTIVE_EXEC_FAILURE_LIMIT} consecutive 1-tick buys — last: ${message}`);
      }
      return;
    }
  }

  // Bought: the refusal gate starts clean, and the strike counter resets.
  //
  // EXECUTION TRUTH (before the outcome is known): how stale was the decision we
  // actually sent? A 1-tick contract decided on tape N and bought on tape N+2 is
  // not the trade that was analysed, and this is the only place that is visible.
  try {
    const nowSeq = readHedgeTape(b.symbol, 2)?.tickSequence ?? b.tickSequence;
    recordDispatchLatency({
      decisionTickSequence: b.tickSequence,
      dispatchTickSequence: nowSeq,
      elapsedMs: Date.now() - (s.exposureSince ?? Date.now()),
    });
  } catch {
    // Telemetry must never block or fail an order.
  }
  clearRefusedLiveAttempt(s.liveGate);
  s.execFailures = 0;
  s.exposure.contractId = contractId;
  await db.update(tradesTable).set({
    derivContractId: String(contractId),
    entryPrice: String(buyPrice),
  }).where(eq(tradesTable.id, openRow.id));

  // Wait for settlement. A timeout keeps the exposure open. It is never recorded as a loss.
  let result: { won: boolean; profit: number; sellPrice: number; entrySpot: number };
  try {
    const settled = await waitForContractResult(token, accountId, contractId, (HEDGE_DURATION_TICKS + 30) * 1000);
    result = { won: settled.won, profit: settled.profit, sellPrice: settled.sellPrice ?? 0, entrySpot: buyPrice };
  } catch (waitErr) {
    logger.warn({ err: waitErr instanceof Error ? waitErr.message : String(waitErr), rowId: openRow.id, contractId }, "Autonomous 1-tick settlement not confirmed yet — exposure held, reconciling by contract id");
    requestReconcile(s);
    host.emit("trade_completed", { id: openRow.id, symbol: b.symbol, won: false, profit: "0", contract: b.contract, pending: true, error: "Settlement pending — reconciling from Deriv records" });
    host.publish({ nextScanIn: null });
    return;
  }

  // EXECUTION TRUTH: close the loop on pricing. The stake was sized from
  // `payout` (captured before dispatch); this records what the broker actually
  // returned, so a systematically optimistic quote cannot silently under-recover
  // the ladder forever.
  const quoteTruth = recordQuoteOutcome({
    contract: b.contract,
    barrier: barrier ?? null,
    quotedMultiplier: payout,
    realisedMultiplier: realisedMultiplier(buyPrice, result.profit, result.won),
    won: result.won,
  });
  if (quoteTruth.alarm) {
    logger.warn(
      {
        contract: b.contract,
        barrier,
        painted: payout,
        realisedMean: quoteTruth.meanRealisedOnWin,
        drift: quoteTruth.relativeDriftEwma,
      },
      "Autonomous 1-tick: the quote that sizes recovery is paying less than quoted — check live pricing",
    );
  }
  const truthNote = describeExecutionTruth();

  const actualPayout = result.won ? buyPrice + result.profit : 0;
  const settlement = await settleAutonomousRow(
    sessionId,
    openRow.id,
    {
      status: result.won ? "won" : "lost",
      profit: String(result.profit),
      payout: String(actualPayout),
      entryPrice: String(buyPrice),
      exitPrice: String(result.sellPrice || buyPrice),
      closedAt: new Date(),
    },
    {
      won: result.won, profit: result.profit, cost: buyPrice, contract: b.contract,
      payout: ledgerEntryPayout(payout, b.contract, barrier),
      maxRecoverySteps: ctx.settings.maxRecoverySteps,
    },
  );
  if (settlement === "deferred") {
    // The ledger could not be made durable, so the row stays open and the exposure gate holds.
    requestReconcile(s);
    host.emit("trade_completed", { id: openRow.id, symbol: b.symbol, won: false, profit: "0", contract: b.contract, pending: true, error: "Settlement pending — reconciling from Deriv records" });
    host.publish({ nextScanIn: null });
    return;
  }
  if (settlement === "already") {
    logger.info({ rowId: openRow.id }, "Autonomous 1-tick: settlement already recorded by the reconciler — ledger not updated twice");
  }
  clearExposure(s);
  clearLadderOutcomeCache();
  if (mode === "RECOVERY") {
    s.calibrationGuard.recordRecoveryTrade({ won: result.won, pTilde: b.probability });
  }
  applySettlement(s.memory, {
    won: result.won,
    key: b.key,
    lossRun: runWithSession(sessionId, () => recoveryEngine.getState().streakLossCount),
    decisionSequence: b.tickSequence,
  });
  s.ctx = null;
  finishTrade(host, s, { id: openRow.id, symbol: b.symbol, won: result.won, profit: result.profit, contract: b.contract, barrier, stake, paper: false, live: true, regime: null, reason: activeDecision.reason, ctx });
  host.afterSettlement(ctx);
}

/** After an unacknowledged buy: the one broker contract that is this trade, open or settled. */
async function findBrokerPurchase(
  sessionId: string,
  token: string,
  accountId: string,
  openRow: typeof tradesTable.$inferSelect,
  want: { symbol: string; contract: string; stake: number },
): Promise<{ contractId: number; buyPrice: number } | null> {
  const [portfolio, settled] = await Promise.all([
    fetchDerivPortfolioContracts(token, accountId),
    fetchDerivProfitTable(token, accountId, 100, {
      dateFrom: Math.floor((openRow.createdAt.getTime() - 2 * 60 * 1000) / 1000),
      strict: true,
    }),
  ]);
  const candidates: DerivTx[] = [
    ...portfolio.map(portfolioAsTransaction),
    ...settled.map((t) => t as DerivTx),
  ];
  const claimed = await loadClaimedContractIds(sessionId, new Date(Date.now() - 24 * 60 * 60 * 1000));
  const row: ReconRow = {
    id: openRow.id,
    symbol: want.symbol,
    contractType: want.contract,
    stake: String(want.stake),
    derivContractId: null,
    createdAt: openRow.createdAt,
  };
  const tx = pickUniquePurchase(row, candidates as Array<DerivTx & { contract_id?: unknown }>, claimed);
  if (!tx) return null;
  return { contractId: Number(tx.contract_id), buyPrice: Number(tx.buy_price) };
}

/**
 * Stop for a breached consecutive-loss limit. With the cooldown enabled the
 * engine sits out `cooldownMinutes` and auto-resumes; with it disabled the
 * engine resumes immediately (see HedgeHost.stopAndResume).
 */
function stopForLossLimit(host: HedgeHost, ctx: HedgeContext, reason: string): void {
  if (ctx.cooldownEnabled === false) {
    host.stopAndResume(reason);
    return;
  }
  host.stop(reason, ctx.cooldownMinutes);
}

function finishTrade(
  host: HedgeHost,
  s: HedgeSession,
  t: {
    id?: number; symbol: string; won: boolean; profit: number; contract: string; barrier: number | null;
    stake: number; paper: boolean; live: boolean; regime: string | null; reason: string; ctx: HedgeContext;
  },
): void {
  const streak = runWithSession(host.sessionId, () => recoveryEngine.getState().streakLossCount);
  host.publish({ sessionLossCount: streak, lastTradeTime: new Date() });
  host.emit("trade_completed", {
    id: t.id,
    symbol: t.symbol,
    won: t.won,
    profit: t.profit.toFixed(2),
    contract: t.contract,
    barrier: t.barrier,
    stake: t.stake,
    live: t.live,
    paper: t.paper,
    regime: t.regime,
    reason: t.reason,
  });
  logger.info({ symbol: t.symbol, won: t.won, profit: t.profit.toFixed(2), stake: t.stake, contract: t.contract }, "Trade executed");
  if (!t.won && streak >= t.ctx.consecutiveLossLimit) {
    const limit = t.ctx.consecutiveLossLimit;
    stopForLossLimit(
      host,
      t.ctx,
      t.ctx.cooldownEnabled === false
        ? `${streak} consecutive losses — limit ${limit} reached, cooldown disabled — resuming`
        : `${streak} consecutive losses — limit ${limit} reached, cooling down ${t.ctx.cooldownMinutes}m`,
    );
  }
  void s;
}
