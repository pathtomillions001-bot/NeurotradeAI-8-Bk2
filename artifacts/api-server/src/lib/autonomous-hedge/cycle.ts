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
 * This module is the autonomous engine's own copy of the Nexus logic. Its
 * tournament selection is independent of the legacy analysis-agent suite and
 * leaves every Bot Arena console and engine untouched.
 */

import { db, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { runWithSession } from "../session";
import * as recoveryEngine from "../agents/recovery-engine";
import { computeRiskDecision } from "../agents/risk-manager";
import type { DailyStats, ScanContext, TradingSettings } from "../agents/types";
import type { RiskDecision } from "../agents/risk-manager";
import { resolveRecoveryPayout } from "../recovery-payout";
import {
  AUTOMATED_DERIV_MARKETS,
  DerivTradeError,
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
  hedgeGroupIndex,
  HEDGE_GROUP_NAMES,
} from "./constants";
import { buildMarketCandidates, candidateKey, type HedgeCandidate, type HedgeMode } from "./hedge-analysis";
import { recoveryEscalation } from "./recovery-risk";
import { decideHedge, type HedgeDecision } from "./contest";
import { applyRematch, applySettlement, rankRows, type HedgeMemory } from "./hedge-state";
import { readHedgeTape, type HedgeTape } from "./tape";
import { familySpecsFor } from "./families";
import { contractSpecLabel } from "./contract-sets";
import type { AutonomousContractSets } from "./contract-sets";
import { decideExecutionFailure } from "./execution-failure";
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
  lastReconcileAt: number;
  lastEmitAt: number;
  execFailures: number;
  /**
   * Quote→purchase handoff refusals ("Unknown contract proposal", throttling).
   * Kept apart from `execFailures` because they place nothing and say nothing
   * about the account: they must not stop the engine after three ticks.
   */
  quoteFailures: number;
  /**
   * Candidates this Deriv account refused as untradeable (contract not offered,
   * market closed, unsupported barrier). They are skipped for the rest of this
   * run so the engine trades the rest of the user's set instead of re-hammering
   * the same rejected contract every tick. Cleared by `resetHedgeSession`, so a
   * restart re-probes them.
   */
  blocked: Set<string>;
  ctx: { at: number; value: HedgeContext } | null;
}

const CONTEXT_TTL_MS = 2_000;
const EMIT_THROTTLE_MS = 400;
const EXPOSURE_RECHECK_MS = 1_500;
const RECONCILE_THROTTLE_MS = 5_000;
/** A tape with no tick for this long belongs to a closed or stalled market and is not ranked. */
const STALE_TAPE_MS = 15_000;
const MIN_STAKE = 0.35;

const sessions = new Map<string, HedgeSession>();

function newSession(): HedgeSession {
  return {
    memory: {},
    busy: false,
    pending: false,
    hydrated: false,
    exposure: null,
    exposureCheckedAt: 0,
    lastReconcileAt: 0,
    lastEmitAt: 0,
    execFailures: 0,
    quoteFailures: 0,
    blocked: new Set<string>(),
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

function collectMarketCandidates(
  ctx: HedgeContext,
  markets: ReturnType<typeof watchedMarkets>,
  mode: HedgeMode,
  escalation: number,
  /** Candidate keys this account already refused — skipped, never re-bought. */
  blocked: ReadonlySet<string> = new Set<string>(),
): { tapes: HedgeTape[]; rows: HedgeCandidate[]; blockedKeys: string[] } {
  const tapes: HedgeTape[] = [];
  const rows: HedgeCandidate[] = [];
  const blockedKeys: string[] = [];
  for (const market of markets) {
    const tape = readHedgeTape(market.symbol);
    if (!tape || tape.ageMs > STALE_TAPE_MS) continue;
    // Live trades never rely on simulated prices. Paper mode may use either.
    if (!tape.live && !ctx.paperTradeMode) continue;
    tapes.push(tape);
    const specs = familySpecsFor({
      settings: ctx.settings,
      mode,
      digitEnabled: market.digitEnabled,
      sets: ctx.contractSets,
    });
    for (const row of buildMarketCandidates({
      symbol: market.symbol,
      group: hedgeGroupIndex(market.symbol),
      digits: tape.digits,
      prices: tape.prices,
      tickSequence: tape.tickSequence,
      specs,
      mode,
      escalation,
    })) {
      if (blocked.has(row.key)) {
        blockedKeys.push(row.key);
        continue;
      }
      rows.push(row);
    }
  }
  return { tapes, rows, blockedKeys };
}

function copyHedgeMemory(memory: HedgeMemory): HedgeMemory {
  return {
    ...(memory.rematch ? { rematch: { ...memory.rematch } } : {}),
    ...(memory.confirmation ? { confirmation: { ...memory.confirmation } } : {}),
  };
}

export interface HedgePreview {
  mode: HedgeMode;
  decision: HedgeDecision | null;
  rankedRows: HedgeCandidate[];
  marketsScanned: number;
  risk: RiskDecision;
}

/**
 * Read-only snapshot for Quick Strike. It uses the same tape collection,
 * candidate scoring, risk gate and tournament ranker as an autonomous cycle,
 * but clones rescan memory so merely viewing the card cannot change engine state.
 */
export function buildHedgePreview(
  ctx: HedgeContext,
  mode: HedgeMode,
  memory: HedgeMemory,
  lossRun: number,
  escalation: number,
): HedgePreview {
  const markets = watchedMarkets(ctx);
  const risk = riskFor(ctx, markets[0]?.symbol ?? "");
  if (risk.hardStop) {
    return { mode, decision: null, rankedRows: [], marketsScanned: 0, risk };
  }

  const { tapes, rows } = collectMarketCandidates(ctx, markets, mode, escalation);
  const decision = decideHedge({
    rows,
    mode,
    memory: copyHedgeMemory(memory),
    lossRun,
    escalation,
  });
  const rankRowsMemory = copyHedgeMemory(memory);
  const rowsForRanking = rows.map((row) => ({ ...row }));
  applyRematch(rowsForRanking, rankRowsMemory);

  return {
    mode,
    decision,
    rankedRows: rankRows(rowsForRanking),
    marketsScanned: tapes.length,
    risk,
  };
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
  logger.warn({ sessionId: host.sessionId, rowId: row.id }, "Autonomous engine resumed with an unresolved 1-tick exposure — gated until settled");
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
    return false;
  }
  if (!row) {
    // The row was removed outside the engine. Nothing can settle it, so release the gate.
    logger.warn({ rowId: s.exposure.rowId }, "Autonomous 1-tick exposure row no longer exists — releasing the gate");
    s.exposure = null;
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
  s.exposure = null;
  return true;
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
    const consecutive = ctx.settings.cooldownEnabled !== false && ctx.daily.consecutiveLosses >= ctx.consecutiveLossLimit;
    host.stop(risk.hardStopReason ?? "risk limit reached", consecutive ? ctx.cooldownMinutes : undefined);
    return;
  }

  // 1. Read every watched market's 1-tick tape and rank its families.
  const markets = watchedMarkets(ctx);
  const { tapes, rows, blockedKeys } = collectMarketCandidates(ctx, markets, mode, escalation, s.blocked);

  // 1b. Everything Deriv offered this tick is a contract this account has
  // already refused. Say so instead of holding silently: this is the case that
  // looks like "the engine will not start" from the outside.
  if (rows.length === 0 && blockedKeys.length > 0) {
    host.publish({ currentMarket: null, nextScanIn: null });
    host.stop(
      `Stopped: this Deriv account refused every contract it was offered (${blockedKeys.length} blocked: ` +
        `${blockedKeys.slice(0, 3).join(", ")}${blockedKeys.length > 3 ? ", …" : ""}). ` +
        "Choose different contracts or markets, or connect an account that can trade synthetic indices.",
    );
    return;
  }

  // 2. Contest and gate.
  const decision = decideHedge({ rows, mode, memory: s.memory, lossRun, escalation });
  if (!decision) {
    host.publish({ currentMarket: null, nextScanIn: null });
    return;
  }

  // 3. Publish the current contest result (throttled — the engine may evaluate on every tick).
  publishScan(host, s, decision, lossRun, ctx, tapes.length);

  if (!decision.eligible) return;

  // 4. Trade. Re-read context on fresh data before any money moves.
  const fresh = await getContext(host, s, true);
  const freshRisk = riskFor(fresh, decision.best.symbol);
  if (freshRisk.hardStop) {
    const consecutive = fresh.settings.cooldownEnabled !== false && fresh.daily.consecutiveLosses >= fresh.consecutiveLossLimit;
    host.stop(freshRisk.hardStopReason ?? "risk limit reached", consecutive ? fresh.cooldownMinutes : undefined);
    return;
  }
  if (!host.canExecute()) return;
  const lastPrice = tapes.find((t) => t.symbol === decision.best.symbol)?.prices.at(-1) ?? 0;
  await executeDecision(host, s, decision, fresh, mode, freshRisk, lastPrice, rows.map((row) => row.key));
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
  /** Every candidate key ranked this tick — what the account could trade instead. */
  candidateKeys: string[] = [],
): Promise<void> {
  const b = decision.best;
  const sessionId = host.sessionId;
  const reasoningBase = `${AUTONOMOUS_HEDGE_PREFIX}${decision.reason}`;
  const { stake: rawStake, payout } = await resolveStake(decision, ctx, mode, risk);
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
      // WHAT Deriv refused decides what happens next (see
      // lib/autonomous-hedge/execution-failure.ts): a stale quote→purchase
      // handoff is held and re-quoted next tick, a contract this account is not
      // offered is skipped for the rest of the run, and an account-level refusal
      // stops the engine on the spot with the way out.
      const rawMessage = buyErr instanceof Error ? buyErr.message : String(buyErr);
      const rejected = buyErr instanceof DerivTradeError ? buyErr : null;
      const action = decideExecutionFailure({
        code: rejected?.code ?? null,
        message: rejected ? rejected.brokerMessage : rawMessage,
        stage: rejected?.stage ?? "unknown",
        kind: rejected?.kind,
        symbol: b.symbol,
        contractType: b.contract,
        barrier: b.barrier,
        candidateKey: b.key,
        contractLabel: contractSpecLabel({ type: b.contract, digit: b.barrier }),
        state: {
          execFailures: s.execFailures,
          quoteFailures: s.quoteFailures,
          blocked: [...s.blocked],
          candidateKeys,
        },
      });
      await claimOpenRow(openRow.id, {
        status: "error",
        profit: "0",
        payout: "0",
        closedAt: new Date(),
        agentReasoning: `${reasoningBase} [EXECUTION FAILED: ${action.held}]`,
      });
      s.exposure = null;
      if (action.countAsExecFailure) s.execFailures += 1;
      if (action.countAsQuoteFailure) s.quoteFailures += 1;
      if (action.quarantine) s.blocked.add(b.key);
      logger.warn(
        {
          err: rawMessage,
          code: rejected?.code ?? null,
          stage: rejected?.stage ?? "unknown",
          kind: action.kind,
          symbol: b.symbol,
          contract: b.contract,
          barrier: b.barrier,
          execFailures: s.execFailures,
          quoteFailures: s.quoteFailures,
          quarantined: action.quarantine,
          blockedCount: s.blocked.size,
        },
        "Autonomous 1-tick buy rejected by Deriv",
      );
      host.emit("trade_completed", {
        id: openRow.id,
        symbol: b.symbol,
        won: false,
        profit: "0",
        contract: b.contract,
        barrier,
        stake,
        error: action.held,
        errorKind: action.kind,
        errorCode: rejected?.code ?? null,
        // A held handoff/throttle is retried on the next tick; a quarantined
        // contract is skipped for the rest of this run.
        retryable: action.kind === "unknown-proposal" || action.kind === "transient",
        quarantined: action.quarantine,
      });
      if (action.stop) {
        host.stop(action.reason ?? `Deriv rejected this trade — ${action.held}`);
      }
      return;
    }
  }

  // A placed purchase clears both failure budgets: the counters measure
  // CONSECUTIVE refusals, and the broker has just accepted one of ours.
  s.execFailures = 0;
  s.quoteFailures = 0;
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
  s.exposure = null;
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
  if (!t.won && t.ctx.settings.cooldownEnabled !== false && streak >= t.ctx.consecutiveLossLimit) {
    host.stop(
      `${streak} consecutive losses — limit ${t.ctx.consecutiveLossLimit} reached, cooling down ${t.ctx.cooldownMinutes}m`,
      t.ctx.cooldownMinutes,
    );
  }
  void s;
}
