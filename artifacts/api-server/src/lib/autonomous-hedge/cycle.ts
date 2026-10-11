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
import { prepareRecoveryBuy, resolveRecoveryPayout } from "../recovery-payout";
import { applyRecoveryStakeLimits } from "../recovery-math";
import {
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  fetchDerivPortfolioContracts,
  fetchDerivProfitTable,
  isAutomatedMarket,
  TradeOutcomeUnknownError,
  waitForContractResult,
} from "../deriv";
import {
  AUTONOMOUS_HEDGE_PREFIX,
  HEDGE_DURATION_TICKS,
  HEDGE_DURATION_UNIT,
  HEDGE_MIN_TICKS,
  hedgeGroupIndex,
  HEDGE_GROUP_NAMES,
} from "./constants";
import { buildMarketCandidates, candidateKey, type HedgeCandidate, type HedgeMode } from "./hedge-analysis";
import { computeStake } from "../agents/ev-calculator";
import { recoveryEscalation } from "./recovery-risk";
import { scoreRecoveryCandidates, DEFAULT_RCI_WEIGHTS, type RciCandidateInput } from "./rci";
import { computeRecoveryHeadroom } from "./recovery-headroom";
import {
  computeAdaptiveStake,
  ADAPTIVE_DEFAULT_LAMBDA,
  ADAPTIVE_DEFAULT_BUDGET_BASE,
  ADAPTIVE_DEFAULT_HEADROOM_PCT,
} from "./adaptive-stake";

import { decideHedge, type HedgeDecision } from "./contest";
import { applySettlement, requiredConfirmations, type HedgeMemory } from "./hedge-state";
import { readHedgeTape, type HedgeTape } from "./tape";
import { familySpecsFor } from "./families";
import type { AutonomousContractSets } from "./contract-sets";
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
  /**
   * WP1: how the engine reacts when the consecutive-loss limit is reached.
   *  - "pause"    (default, legacy): stop and run the cooldown timer.
   *  - "sizedown": never pause; instead scale the stake down by half for every
   *                loss beyond the limit and keep trading. A time pause changes
   *                nothing statistically on i.i.d. outcomes, so this expresses
   *                the same caution through exposure instead of waiting.
   */
  cooldownBehavior: "pause" | "sizedown";
  allowedMarketSymbols: string[] | null;
  paperTradeMode: boolean;
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
  ctx: { at: number; value: HedgeContext } | null;
}

const CONTEXT_TTL_MS = 2_000;
const EMIT_THROTTLE_MS = 400;
const EXPOSURE_RECHECK_MS = 1_500;
const RECONCILE_THROTTLE_MS = 5_000;
const CONSECUTIVE_EXEC_FAILURE_LIMIT = 3;
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
    ctx: null,
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

/**
 * WP1 size-down multiplier: 1.0 while the consecutive-loss run is below the
 * limit; halves for every loss at or beyond it. A time pause changes nothing
 * statistically on i.i.d. outcomes — this expresses the same caution through
 * exposure instead of waiting. The daily-loss / drawdown hard stops are
 * untouched and still end the engine.
 */
export function sizeDownMultiplier(losses: number, limit: number): number {
  const over = Math.max(0, Math.floor(losses) - Math.max(1, Math.floor(limit)) + 1);
  return Math.pow(0.5, over);
}

function riskFor(ctx: HedgeContext, symbol: string) {
  return computeRiskDecision(scanContext(ctx, symbol), null);
}

/**
 * Risk decision with the WP1 size-down override: when the ONLY breached hard
 * stop is the consecutive-loss limit and cooldownBehavior is "sizedown", the
 * engine keeps trading at a reduced stake instead of pausing. Every other hard
 * stop (daily loss limit, max drawdown, daily target) passes through as-is.
 */
function riskWithSizeDown(ctx: HedgeContext, symbol: string): { risk: RiskDecision; factor: number } {
  const risk = riskFor(ctx, symbol);
  if (!risk.hardStop) return { risk, factor: 1 };
  const consecutive = ctx.daily.consecutiveLosses >= ctx.consecutiveLossLimit;
  if (!consecutive || ctx.cooldownBehavior !== "sizedown") return { risk, factor: 1 };
  const factor = sizeDownMultiplier(ctx.daily.consecutiveLosses, ctx.consecutiveLossLimit);
  const baseStake = computeStake(scanContext(ctx, symbol));
  const reduced = Math.max(0.35, Math.min(baseStake * factor, ctx.settings.maxTradeStake));
  return {
    risk: {
      ...risk,
      hardStop: false,
      allowTrade: true,
      recommendedStake: Math.round(reduced * 100) / 100,
      riskBudget: Math.max(risk.riskBudget, 0.05),
      hardStopReason: undefined,
    },
    factor,
  };
}

/**
 * WP3 — v2 recovery decision via the Recovery Cost Index.
 *
 * Returns a HedgeDecision that fires on the FIRST tick a feasible contract
 * exists: no confirmations, no rematch penalty, no Markov terms (D8). Used only
 * when settings.recoveryV2Mode is shadow/live AND the engine is in recovery;
 * normal mode keeps the legacy gate. Returns null when no market produced rows
 * or nothing is affordable (a budget fact, reported as a HOLD, not a wait).
 *
 * TODO(WP4): headroomCap currently proxies the drawdown headroom with the
 * per-trade max stake; WP4 replaces it with φ·min(balance−reserve, headroom).
 * TODO(WP5): ruin/clear-time previews are 0 until the Markov-DP preview lands.
 */
function decideRecoveryV2(
  rows: HedgeCandidate[],
  tapes: HedgeTape[],
  ctx: HedgeContext,
  lossRun: number,
  escalation: number,
): HedgeDecision | null {
  if (rows.length === 0) return null;
  const ledger = recoveryEngine.getState();
  const tapeAgeBySymbol = new Map(tapes.map((t) => [t.symbol, t.ageMs]));
  const candidates: RciCandidateInput[] = rows.map((row) => ({
    spec: { type: row.contract, digit: row.barrier },
    payout: row.payout,
    quoteSource: "fallback", // live re-verification happens at buy time (WP2)
    quoteAgeMs: 0,
    tapeAgeMs: tapeAgeBySymbol.get(row.symbol) ?? Number.MAX_SAFE_INTEGER,
    recentRejections: 0,
  }));
  const debt = ledger.unrecoveredAmount;
  const adaptive = ctx.settings.recoveryMethod === "adaptive";
  // D4: the adaptive ladder clears DEBT only (T′ = 0); legacy keeps the sizing target.
  const targetProfit = adaptive ? 0 : ledger.remainingTargetProfit;
  // WP4: feasibility is bounded by the remaining drawdown headroom, not just
  // the per-trade cap (D3). Legacy methods keep the max-trade cap so the
  // shadow comparison stays honest against legacy stakes.
  const headroomCap = adaptive
    ? computeRecoveryHeadroom({
        balance: ctx.balance,
        dailyProfit: ctx.daily.profit,
        maxDrawdownPct: ctx.settings.maxDrawdown,
        headroomPct: ctx.settings.recoveryHeadroomPct ?? ADAPTIVE_DEFAULT_HEADROOM_PCT,
      }).headroomCap
    : ctx.settings.maxTradeStake;
  const decision = scoreRecoveryCandidates({
    candidates,
    debt,
    targetProfit,
    headroomCap,
    weights: DEFAULT_RCI_WEIGHTS,
  });
  if (!decision.chosen) return null;

  // Map the RCI winner back onto the ranked row that produced it.
  const chosenSpec = decision.chosen.spec;
  const best = rows.find(
    (r) => r.contract === chosenSpec.type && r.barrier === chosenSpec.digit,
  );
  if (!best) return null;

  const barrierText = best.barrier >= 0 ? ` ${best.barrier}` : "";
  const reason = `READY ${best.contract}${barrierText} on ${best.symbol} · RCI ${(decision.chosen.rci * 100).toFixed(2)} margin ${(decision.chosen.margin * 100).toFixed(2)}%${decision.partial ? " · partial (headroom-bound)" : ""}`;

  // Group winners for the dashboard, mirroring the legacy contest's layout.
  const rankedByScore = [...rows].sort((a, b) => b.score - a.score);
  const groupWinners = HEDGE_GROUP_NAMES.map((_, g) => {
    const inGroup = rankedByScore.filter((r) => r.group === g);
    return inGroup.length > 0
      ? { group: g, groupName: HEDGE_GROUP_NAMES[g], winner: inGroup[0], rowsInGroup: inGroup.length }
      : null;
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    mode: "RECOVERY",
    best,
    eligible: true,
    confirmations: 0,
    requiredConfirmations: 0,
    rescanInProgress: false,
    escalation,
    blockers: [],
    reason,
    groupWinners,
    rowsRanked: rows.length,
  };
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
    // The reconciler has already recorded the ledger for this row.
    applySettlement(s.memory, {
      won: row.status === "won",
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
export function describeFeedHold(d: FeedDiagnosis, paperTradeMode: boolean): string {
  const n = d.watched;
  if (n === 0) {
    return "HOLD: no markets are enabled for the autonomous engine — check Settings → Allowed markets.";
  }
  if (d.missing === n) {
    return `HOLD: waiting for market data — no ticks received yet on any of the ${n} watched markets. The tournament starts on the first tick.`;
  }
  if (!paperTradeMode && d.live === 0 && d.simSkipped > 0) {
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
  const truthful = recoveryEngine.getState();
  host.emit("scan_complete", {
    symbol: null,
    quality: 0,
    confidence: 0,
    marketsScanned: input.marketsScanned,
    regime: null,
    shouldTrade: false,
    rejectReason: input.reason,
    sessionLossCount: input.lossRun,
    // WP1: the dashboard also gets the run a cooldown can no longer hide.
    trueLossRun: truthful.trueLossRun ?? 0,
    recoveryDepth: truthful.recoveryDepth ?? 0,
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
  // Depth of THIS recovery episode — the TRUTHFUL counters (WP1). trueLossRun
  // is reset only by a win (cooldown resumes never mask it) and recoveryDepth
  // is the uncapped episode depth, so escalation can reach the risk weight's
  // documented cap instead of saturating at maxRecoverySteps. The ranking math
  // (recoveryRiskWeight) clamps at its own cap, so nothing downstream moves a
  // stake — this only keeps the recovery RANKING honest on long runs.
  const escalation = recoveryEscalation(ledger.trueLossRun, ledger.recoveryDepth);

  // 0. Hard limits first. A breached limit stops the engine before anything is
  //    ranked — with one opt-in exception (WP1): when cooldownBehavior is
  //    "sizedown", the CONSECUTIVE-LOSS stop is expressed as halved exposure
  //    (riskWithSizeDown / sizeDownMultiplier) instead of a pause. Daily loss
  //    limit, max drawdown and profit-target hard stops always apply.
  const { risk, factor: sizeDownFactor } = riskWithSizeDown(ctx, watchedMarkets(ctx)[0]?.symbol ?? "");
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
  const markets = watchedMarkets(ctx);
  const feed = emptyFeedDiagnosis(markets.length);
  const tapes: HedgeTape[] = [];
  const rows: HedgeCandidate[] = [];
  for (const market of markets) {
    const tape = readHedgeTape(market.symbol);
    if (!tape) { feed.missing += 1; continue; }
    if (tape.ageMs > STALE_TAPE_MS) { feed.stale += 1; continue; }
    // Live trades never rely on simulated prices. Paper mode may use either.
    if (!tape.live && !ctx.paperTradeMode) { feed.simSkipped += 1; continue; }
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
    rows.push(...buildMarketCandidates({
      symbol: market.symbol,
      group: hedgeGroupIndex(market.symbol),
      digits: tape.digits,
      prices: tape.prices,
      tickSequence: tape.tickSequence,
      specs,
      mode,
      escalation,
    }));
  }

  // 2. Contest and gate.
  let decision = decideHedge({ rows, mode, memory: s.memory, lossRun, escalation });

  // 2b. Recovery v2 (WP3): when the gate is enabled and the engine is in
  //     recovery, the RCI selector either REPLACES the legacy decision (live)
  //     or is logged beside it (shadow). Normal mode is never touched.
  const v2Mode = ctx.settings.recoveryV2Mode ?? "off";
  if (mode === "RECOVERY" && v2Mode !== "off" && rows.length > 0) {
    const v2Decision = decideRecoveryV2(rows, tapes, ctx, lossRun, escalation);
    if (v2Mode === "shadow") {
      logger.info(
        {
          sessionId: host.sessionId,
          legacy: decision ? { eligible: decision.eligible, reason: decision.reason } : null,
          v2: v2Decision ? { reason: v2Decision.reason } : null,
        },
        "Recovery v2 shadow decision (RCI beside legacy)",
      );
    } else if (v2Decision) {
      decision = v2Decision;
    } else if (ctx.settings.recoveryMethod === "adaptive") {
      // Live adaptive with no fundable contract: either re-base (budget/headroom
      // trigger) or hold — never fall back to legacy sizing and never wait on a
      // contract that cannot fit the headroom.
      const why = checkRecoveryRebase(ctx, risk.recommendedStake);
      if (why) {
        await executeRebase(host, decision?.best.symbol ?? rows[0].symbol, ctx, why);
        return;
      }
      host.publish({ currentMarket: null, nextScanIn: null });
      emitHoldScan(host, s, {
        reason: "recovery headroom: no contract fits the remaining drawdown budget",
        mode,
        lossRun,
        consecutiveLossLimit: ctx.consecutiveLossLimit,
        marketsScanned: tapes.length,
        feed,
        started: { markets: tapes.length, mode },
      });
      return;
    }
  }

  if (!decision) {
    host.publish({ currentMarket: null, nextScanIn: null });
    // Ranked nothing this tick — HOLD with the feed cause, never silence.
    emitHoldScan(host, s, {
      reason: describeFeedHold(feed, ctx.paperTradeMode),
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
  const { risk: freshRisk, factor: freshSizeDown } = riskWithSizeDown(fresh, decision.best.symbol);
  if (freshRisk.hardStop) {
    const consecutive = fresh.daily.consecutiveLosses >= fresh.consecutiveLossLimit;
    if (consecutive) stopForLossLimit(host, fresh, freshRisk.hardStopReason ?? "risk limit reached");
    else host.stop(freshRisk.hardStopReason ?? "risk limit reached");
    return;
  }
  if (!host.canExecute()) return;
  const lastPrice = tapes.find((t) => t.symbol === decision.best.symbol)?.prices.at(-1) ?? 0;
  // The size-down factor (WP1) applies to the trade about to be placed. Use the
  // stricter of the scan-time and fresh-context factors so exposure can only
  // shrink as the run deepens between the scan and the buy.
  const sizeDown = Math.min(sizeDownFactor, freshSizeDown);
  await executeDecision(host, s, decision, fresh, mode, freshRisk, lastPrice, sizeDown);
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
    // WP1 truthful counters — never masked by cooldown resumes.
    trueLossRun: recoveryEngine.getState().trueLossRun ?? 0,
    recoveryDepth: recoveryEngine.getState().recoveryDepth ?? 0,
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
 *
 * WP2 (gated by settings.recoveryV2Mode): after the legacy stake is computed,
 * a buy-time proposal re-verifies the payout and re-sizes so one win clears
 * the target at the ACTUAL multiplier (D7). "shadow" logs the plan beside the
 * legacy number without trading it; "live" trades it; "off" (default) is
 * byte-for-byte legacy.
 */
function resolveRecoveryLambda(ctx: HedgeContext): number {
  const raw = ctx.settings.recoveryLambda;
  if (raw === undefined || raw === null || raw === "" || String(raw).toLowerCase() === "auto") {
    // TODO(WP5): "auto" resolves through the Markov-DP optimizer. Until then
    // it falls back to the validated default lambda.
    return ADAPTIVE_DEFAULT_LAMBDA;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0.05, n)) : ADAPTIVE_DEFAULT_LAMBDA;
}

async function resolveStake(
  decision: HedgeDecision,
  ctx: HedgeContext,
  mode: HedgeMode,
  risk: RiskDecision,
): Promise<{ stake: number; payout: number; rebase?: "budget" | "headroom" }> {
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

  // ── WP4 adaptive ladder ──────────────────────────────────────────────────
  if (ctx.settings.recoveryMethod === "adaptive") {
    const ledgerState = recoveryEngine.getState();
    const headroom = computeRecoveryHeadroom({
      balance: ctx.balance,
      dailyProfit: ctx.daily.profit,
      maxDrawdownPct: ctx.settings.maxDrawdown,
      headroomPct: ctx.settings.recoveryHeadroomPct ?? ADAPTIVE_DEFAULT_HEADROOM_PCT,
    });
    const baseStake = base > 0 ? base : ledgerState.baseStake;
    const plan = computeAdaptiveStake({
      debt: ledgerState.unrecoveredAmount,
      baseStake,
      payout,
      lambda: resolveRecoveryLambda(ctx),
      headroomCap: headroom.headroomCap,
      budgetBase: ctx.settings.recoveryBudgetBase ?? ADAPTIVE_DEFAULT_BUDGET_BASE,
    });
    if (plan.rebaseBudget) return { stake: 0, payout, rebase: "budget" };
    if (plan.rebaseHeadroom) return { stake: 0, payout, rebase: "headroom" };
    logger.debug(
      { debt: ledgerState.unrecoveredAmount, payout, lambdaEffective: plan.lambdaEffective, headroomCap: headroom.headroomCap, stake: plan.stake, partial: plan.partial },
      "Adaptive recovery stake plan",
    );
    return { stake: plan.stake, payout };
  }

  // The adaptive method returned above; below this line the method is legacy
  // (TS has narrowed the union accordingly).
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

  const v2Mode = ctx.settings.recoveryV2Mode ?? "off";
  if (v2Mode === "off" || !ctx.settings.recoveryAutoMode) return { stake, payout };

  // ── WP2 buy-time exactness (auto modes only) ─────────────────────────────
  const ledger = recoveryEngine.getState();
  // Legacy semantics: one win is promised to clear debt PLUS the remaining
  // sizing target. (The adaptive method, WP4, drops the target — T′ = 0.)
  const targetClearance = ledger.unrecoveredAmount + ledger.remainingTargetProfit;
  const plan = await prepareRecoveryBuy({
    symbol: b.symbol,
    contractType: b.contract,
    barrier: b.barrier >= 0 ? b.barrier : null,
    duration: HEDGE_DURATION_TICKS,
    durationUnit: HEDGE_DURATION_UNIT,
    currency: ctx.currency,
    targetClearance,
    assumedPayout: payout,
    candidateStake: stake,
  });
  // Split keeps its one-base-stake cap even after a live re-size.
  const baseCap = ctx.settings.recoveryMethod === "split"
    ? Math.max(0.35, ledger.baseStake > 0 ? ledger.baseStake : base)
    : Number.POSITIVE_INFINITY;
  const plannedStake = applyRecoveryStakeLimits(Math.min(plan.stake, baseCap), ctx.settings.maxTradeStake, ctx.balance);
  logger.info(
    {
      symbol: b.symbol, contract: b.contract, v2Mode,
      legacyStake: stake, v2Stake: plannedStake,
      assumedPayout: payout, livePayout: plan.payoutMultiplier,
      source: plan.source, reSized: plan.reSized, safetyMargin: plan.safetyMarginApplied,
      targetClearance,
    },
    "Recovery v2 buy-time quote plan",
  );
  if (v2Mode === "live") {
    return { stake: plannedStake, payout: plan.payoutMultiplier };
  }
  return { stake, payout }; // shadow: legacy trades, v2 only logged
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

/**
 * WP4 — RE-BASE execution. The adaptive ladder's budget rule realised the debt:
 * the recovery state is zeroed durably FIRST (durable-before-claimed, with an
 * in-memory rollback if the flush fails), then the ledger row for the realised
 * loss is written and counted in the daily P&L. Trading resumes immediately at
 * base stake — no pause, no gate, nothing hidden: the loss stays visible in
 * the true counters and the daily stats.
 */
async function executeRebase(
  host: HedgeHost,
  symbol: string,
  ctx: HedgeContext,
  why: "budget" | "headroom",
): Promise<void> {
  const sessionId = host.sessionId;
  const snapshot = { ...recoveryEngine.getState() };
  const realised = runWithSession(sessionId, () => {
    recoveryEngine.setPersistenceSession(sessionId);
    return recoveryEngine.applyRebaseToState();
  });
  if (realised <= 0) return;

  const durable = await recoveryEngine.flushRecoveryState();
  if (!durable) {
    recoveryEngine.restoreStateSnapshot(snapshot);
    logger.warn(
      { sessionId, realised, why },
      "Recovery re-base: durable flush failed — rolled back, retrying next tick",
    );
    return;
  }

  const displayName = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol)?.displayName ?? symbol;
  const [row] = await db.insert(tradesTable).values({
    sessionId,
    symbol,
    displayName,
    contractType: "REBASE",
    stake: "0",
    direction: "neutral",
    status: "lost",
    payout: "0",
    profit: String(Math.round(-realised * 100) / 100),
    entryPrice: "0",
    exitPrice: "0",
    aiConfidence: "0",
    aiRiskScore: "0",
    isAutonomous: true,
    agentReasoning: `${AUTONOMOUS_HEDGE_PREFIX}REBASE(${why}): realised $${realised.toFixed(2)} recovery debt; ladder restarts at base stake`,
    duration: HEDGE_DURATION_TICKS,
    durationUnit: HEDGE_DURATION_UNIT,
    closedAt: new Date(),
  }).returning();

  host.emit("recovery_rebase", {
    symbol,
    debt: realised,
    reason: why,
    rowId: row?.id ?? null,
    budgetBase: ctx.settings.recoveryBudgetBase ?? ADAPTIVE_DEFAULT_BUDGET_BASE,
  });
  logger.warn(
    { sessionId, realised, why, rowId: row?.id },
    "Recovery re-base: debt realised as loss; engine continues at base stake",
  );
}

/**
 * WP4 — pre-selection re-base check. Both triggers are contract-independent:
 * the debt has reached the budget, or the headroom cap can no longer fund even
 * a base stake. Callers run this BEFORE the selector so a headroom-bound
 * recovery never dead-locks waiting for an affordable contract.
 */
function checkRecoveryRebase(ctx: HedgeContext, baseStake: number): "budget" | "headroom" | null {
  const ledgerState = recoveryEngine.getState();
  const debt = ledgerState.unrecoveredAmount;
  if (!ledgerState.inRecovery && debt <= 0) return null;
  const base = baseStake > 0 ? baseStake : ledgerState.baseStake;
  const budgetBase = ctx.settings.recoveryBudgetBase ?? ADAPTIVE_DEFAULT_BUDGET_BASE;
  if (debt >= budgetBase * base) return "budget";
  const headroom = computeRecoveryHeadroom({
    balance: ctx.balance,
    dailyProfit: ctx.daily.profit,
    maxDrawdownPct: ctx.settings.maxDrawdown,
    headroomPct: ctx.settings.recoveryHeadroomPct ?? ADAPTIVE_DEFAULT_HEADROOM_PCT,
  });
  if (base > headroom.headroomCap) return "headroom";
  return null;
}

async function executeDecision(
  host: HedgeHost,
  s: HedgeSession,
  decision: HedgeDecision,
  ctx: HedgeContext,
  mode: HedgeMode,
  risk: RiskDecision,
  lastPrice: number,
  sizeDown: number = 1,
): Promise<void> {
  const b = decision.best;
  const sessionId = host.sessionId;
  const reasoningBase = `${AUTONOMOUS_HEDGE_PREFIX}${decision.reason}`;
  const { stake: resolvedStake, payout, rebase } = await resolveStake(decision, ctx, mode, risk);
  if (rebase) {
    await executeRebase(host, b.symbol, ctx, rebase);
    return;
  }
  // WP1 size-down: the NORMAL stake already carries the reduction through
  // risk.recommendedStake (riskWithSizeDown). The RECOVERY stake is debt-driven
  // and does not, so the factor is applied here — exposure shrinks while the
  // run is at/past the limit; the ledger still records the actual result.
  const rawStake = mode === "RECOVERY" && sizeDown < 1
    ? Math.max(MIN_STAKE, resolvedStake * sizeDown)
    : resolvedStake;
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

  // ── Paper trading: settle immediately, same ledger rules ──
  if (ctx.paperTradeMode || !ctx.token) {
    const won = Math.random() < b.probability;
    const profit = won ? stake * payout - stake : -stake;
    const actualPayout = won ? stake * payout : 0;
    host.emit("trade_started", {
      symbol: b.symbol, contract: b.contract, barrier, stake,
      duration: HEDGE_DURATION_TICKS, paper: true, regime: null,
      confidence: Math.round(b.probability * 100), ev: b.ev, mode: decision.mode,
    });
    const [row] = await db.insert(tradesTable).values({
      sessionId,
      symbol: b.symbol,
      displayName,
      contractType: b.contract,
      barrier,
      stake: String(stake),
      direction,
      status: won ? "won" : "lost",
      payout: String(actualPayout),
      profit: String(profit),
      entryPrice: String(lastPrice),
      exitPrice: String(lastPrice),
      aiConfidence: String(Math.round(b.probability * 10000) / 100),
      aiRiskScore: String(riskScore),
      isAutonomous: true,
      agentReasoning: `${AUTONOMOUS_HEDGE_PREFIX}[PAPER] ${decision.reason}`,
      duration: HEDGE_DURATION_TICKS,
      durationUnit: HEDGE_DURATION_UNIT,
      closedAt: new Date(),
    }).returning();
    recordLedger(sessionId, { won, profit, cost: stake, contract: b.contract, payout, maxRecoverySteps: ctx.settings.maxRecoverySteps });
    applySettlement(s.memory, {
      won,
      key: b.key,
      lossRun: runWithSession(sessionId, () => recoveryEngine.getState().streakLossCount),
      decisionSequence: b.tickSequence,
    });
    s.ctx = null;
    finishTrade(host, s, { id: row?.id, symbol: b.symbol, won, profit, contract: b.contract, barrier, stake, paper: true, live: false, regime: null, reason: decision.reason, ctx });
    return;
  }

  // ── Live: one exposure at a time, exact contract id, conditional claim ──
  if (!isAutomatedMarket(b.symbol)) {
    host.publish({ nextScanIn: null });
    logger.warn({ symbol: b.symbol }, "Autonomous 1-tick: market is not automated — holding");
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
    agentReasoning: reasoningBase,
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
  };
  s.exposureCheckedAt = Date.now();
  s.exposureSince = Date.now();
  host.emit("trade_started", {
    id: openRow.id, symbol: b.symbol, contract: b.contract, barrier, stake,
    duration: HEDGE_DURATION_TICKS, regime: null, confidence: Math.round(b.probability * 100),
    ev: b.ev, mode: decision.mode,
  });

  const accountId = ctx.derivAccountId!;
  const token = ctx.token!;
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
      // Definite rejection: no contract was placed, so nothing enters the ledger.
      const message = buyErr instanceof Error ? buyErr.message : String(buyErr);
      await claimOpenRow(openRow.id, {
        status: "error",
        profit: "0",
        payout: "0",
        closedAt: new Date(),
        agentReasoning: `${reasoningBase} [EXECUTION FAILED: ${message}]`,
      });
      clearExposure(s);
      s.execFailures += 1;
      logger.warn({ err: message, symbol: b.symbol, failures: s.execFailures }, "Autonomous 1-tick buy rejected by Deriv");
      host.emit("trade_completed", { id: openRow.id, symbol: b.symbol, won: false, profit: "0", contract: b.contract, error: message });
      if (s.execFailures >= CONSECUTIVE_EXEC_FAILURE_LIMIT) {
        host.stop(`Deriv rejected ${CONSECUTIVE_EXEC_FAILURE_LIMIT} consecutive 1-tick buys — last: ${message}`);
      }
      return;
    }
  }

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
  applySettlement(s.memory, {
    won: result.won,
    key: b.key,
    lossRun: runWithSession(sessionId, () => recoveryEngine.getState().streakLossCount),
    decisionSequence: b.tickSequence,
  });
  s.ctx = null;
  finishTrade(host, s, { id: openRow.id, symbol: b.symbol, won: result.won, profit: result.profit, contract: b.contract, barrier, stake, paper: false, live: true, regime: null, reason: decision.reason, ctx });
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
    if (t.ctx.cooldownBehavior === "sizedown") {
      // WP1: express the limit through exposure, not a pause. The stake halves
      // for every loss beyond the limit (see riskWithSizeDown); the true loss
      // run keeps counting and the daily-loss / drawdown stops still apply.
      host.emit("loss_limit_sizedown", {
        sessionLossCount: streak,
        consecutiveLossLimit: limit,
        sizeDownMultiplier: sizeDownMultiplier(streak, limit),
      });
      logger.info({ sessionId: host.sessionId, streak, limit }, "Autonomous 1-tick: loss limit reached — sizedown mode keeps trading at reduced stake");
    } else {
      stopForLossLimit(
        host,
        t.ctx,
        t.ctx.cooldownEnabled === false
          ? `${streak} consecutive losses — limit ${limit} reached, cooldown disabled — resuming`
          : `${streak} consecutive losses — limit ${limit} reached, cooling down ${t.ctx.cooldownMinutes}m`,
      );
    }
  }
  void s;
}
