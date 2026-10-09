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
  classifyDerivRejection,
  executeLiveTrade,
  fetchDerivPortfolioContracts,
  fetchDerivProfitTable,
  getAccountStakeBounds,
  getMarketInfo,
  isAutomatedMarket,
  probeAccountContract,
  TradeOutcomeUnknownError,
  waitForContractResult,
  type AccountStakeBounds,
  type DerivRejectionKind,
} from "../deriv";
import {
  filterQuarantined,
  hasTradeableContract,
  inferQuarantineScope,
  rememberQuarantined,
  summarizeQuarantine,
  type RejectionEvidence,
} from "./contract-availability";
import { friendlyErrorMessage } from "../friendly-error";
import { clampStakeToBounds, isTwoDecimalCurrency, roundStake } from "./stake-bounds";
import {
  AUTONOMOUS_HEDGE_PREFIX,
  HEDGE_DURATION_TICKS,
  HEDGE_DURATION_UNIT,
  hedgeGroupIndex,
  HEDGE_GROUP_NAMES,
} from "./constants";
import { buildMarketCandidates, candidateKey, type HedgeCandidate, type HedgeContractType, type HedgeMode } from "./hedge-analysis";
import { recoveryEscalation } from "./recovery-risk";
import { decideHedge, type HedgeDecision } from "./contest";
import { applyRematch, applySettlement, rankRows, type HedgeMemory } from "./hedge-state";
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
  /** Contracts Deriv already rejected as unavailable for this account. The
   *  candidate they were rejected on is quarantined so the same rejection is
   *  never spent from the 3-strike budget twice (see contract-availability.ts). */
  quarantineAttempts: number;
  /** Broker stake bounds per symbol, read from the account's own currency. */
  stakeBounds: Map<string, { at: number; bounds: AccountStakeBounds | null }>;
  ctx: { at: number; value: HedgeContext } | null;
}

const CONTEXT_TTL_MS = 2_000;
const EMIT_THROTTLE_MS = 400;
const EXPOSURE_RECHECK_MS = 1_500;
const RECONCILE_THROTTLE_MS = 5_000;
/**
 * Consecutive DEFINITIVE broker failures before the engine gives up. Only
 * failures that are not a capability verdict count: a contract this account
 * cannot quote is quarantined instead (contract-availability.ts), because
 * spending a strike on it makes an account-wide configuration problem look
 * like a broker outage and stops the engine three buys into every restart.
 */
const CONSECUTIVE_EXEC_FAILURE_LIMIT = 3;
/** Capability rejections cost a follow-up probe each; cap the probing. */
const MAX_QUARANTINE_PROBES = 12;
/** A tape with no tick for this long belongs to a closed or stalled market and is not ranked. */
const STALE_TAPE_MS = 15_000;
/**
 * Fallback minimum stake when the broker does not report one. It is a USD
 * figure: the authoritative minimum comes from `contracts_for` for the
 * account's own currency (see getAccountStakeBounds), because 0.35 means
 * something entirely different in BTC, and a stake below the account's minimum
 * is rejected by every proposal on that login.
 */
const MIN_STAKE = 0.35;
/** Broker stake bounds are re-read at most this often per symbol. */
const STAKE_BOUNDS_TTL_MS = 5 * 60_000;

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
    quarantineAttempts: 0,
    stakeBounds: new Map(),
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
  // NOTE: the contract quarantine is deliberately NOT cleared here. It is
  // re-verified by the pre-flight that runs before a start
  // (autonomous-hedge/preflight.ts), and a cooldown auto-resume continues the
  // same session — losing the broker's verdicts there would just repeat the
  // rejected quotes.
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
): { tapes: HedgeTape[]; rows: HedgeCandidate[] } {
  const tapes: HedgeTape[] = [];
  const rows: HedgeCandidate[] = [];
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
  return { tapes, rows };
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
  /** Pass the session id so quarantined contracts stay out of Quick Strike too. */
  sessionId?: string,
): HedgePreview {
  const markets = watchedMarkets(ctx);
  const risk = riskFor(ctx, markets[0]?.symbol ?? "");
  if (risk.hardStop) {
    return { mode, decision: null, rankedRows: [], marketsScanned: 0, risk };
  }

  const collected = collectMarketCandidates(ctx, markets, mode, escalation);
  const tapes = collected.tapes;
  const rows = sessionId ? filterQuarantined(sessionId, collected.rows) : collected.rows;
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
  const collected = collectMarketCandidates(ctx, markets, mode, escalation);
  const tapes = collected.tapes;
  // Contracts this account cannot quote never reach the ranker, so they can
  // never be picked and rejected again.
  const rows = filterQuarantined(host.sessionId, collected.rows);
  if (rows.length === 0 && collected.rows.length > 0) {
    host.stop(
      "Deriv will not quote any contract this account selected — " +
      `${summarizeQuarantine(host.sessionId).join("; ")}. ` +
      "Check this Deriv account's market access and currency, or choose different contracts.",
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

/**
 * This account's broker-reported stake range for a symbol, cached per session.
 * Returns null when the broker did not answer, which callers must treat as
 * "unknown", never as "no limit".
 */
async function stakeBoundsFor(
  s: HedgeSession,
  ctx: HedgeContext,
  symbol: string,
): Promise<AccountStakeBounds | null> {
  if (!ctx.token || !ctx.derivAccountId) return null;
  const cached = s.stakeBounds.get(symbol);
  if (cached && Date.now() - cached.at < STAKE_BOUNDS_TTL_MS) return cached.bounds;
  const bounds = await getAccountStakeBounds(ctx.token, ctx.derivAccountId, symbol, ctx.currency);
  s.stakeBounds.set(symbol, { at: Date.now(), bounds });
  if (bounds?.minStake) {
    logger.debug({ symbol, currency: ctx.currency, minStake: bounds.minStake, maxStake: bounds.maxStake }, "Broker stake bounds for this account");
  }
  return bounds;
}

/** Digit contracts need a market that offers digits; direction contracts do not. */
function familySupportedOn(market: { digitEnabled?: boolean }, contract: string): boolean {
  return contract.startsWith("DIGIT") ? market.digitEnabled === true : true;
}

/** A valid probe barrier for a family the user selected (auto digits get a real one). */
function probeBarrierFor(contract: HedgeContractType, barrier: number): number | null {
  switch (contract) {
    case "DIGITOVER": return barrier >= 0 && barrier <= 8 ? barrier : 4;
    case "DIGITUNDER": return barrier >= 1 && barrier <= 9 ? barrier : 5;
    case "DIGITMATCH":
    case "DIGITDIFF": return barrier >= 0 && barrier <= 9 ? barrier : 5;
    default: return null;
  }
}

/** Every contract family in the user's normal + recovery selection. */
function selectedContractTypes(ctx: HedgeContext): HedgeContractType[] {
  const types = new Set<HedgeContractType>();
  for (const mode of ["NORMAL", "RECOVERY"] as const) {
    for (const spec of familySpecsFor({ settings: ctx.settings, mode, digitEnabled: true, sets: ctx.contractSets })) {
      types.add(spec.type);
    }
  }
  return [...types];
}

/** Probe stake: the broker's own minimum for this account, or the USD fallback. */
async function probeStakeFor(s: HedgeSession, ctx: HedgeContext, symbol: string): Promise<number> {
  const bounds = await stakeBoundsFor(s, ctx, symbol);
  if (bounds?.minStake && bounds.minStake > 0) return roundStake(bounds.minStake, ctx.currency);
  return isTwoDecimalCurrency(ctx.currency) ? MIN_STAKE : roundStake(MIN_STAKE, ctx.currency);
}

function probeOutcome(ok: boolean, kind: DerivRejectionKind): "ok" | "rejected" | "unknown" {
  if (ok) return "ok";
  // Only a capability verdict widens the quarantine. A throttled or unanswered
  // probe says nothing about what the account can trade.
  return kind === "contract-unavailable" ? "rejected" : "unknown";
}

/**
 * Find how wide a capability rejection really is, then quarantine it there.
 *
 * Two follow-up quotes, each changing exactly ONE variable, locate the fault:
 *  - same contract, different market  → the family is unavailable
 *  - same market, different contract  → the market is unavailable
 *  - both                             → the account cannot trade these at all
 *  - neither                          → only this exact combination is out
 * Both probes are quotes only — no money moves — and they are capped per start.
 */
async function quarantineRejectedContract(
  host: HedgeHost,
  s: HedgeSession,
  ctx: HedgeContext,
  b: HedgeCandidate,
  reason: string,
  code: string,
  kind: DerivRejectionKind,
): Promise<void> {
  const sessionId = host.sessionId;
  const evidence: RejectionEvidence = { sameContractOtherMarket: "unknown", sameMarketOtherContract: "unknown" };

  if (ctx.token && ctx.derivAccountId && s.quarantineAttempts < MAX_QUARANTINE_PROBES) {
    const markets = watchedMarkets(ctx);
    const barrier = probeBarrierFor(b.contract, b.barrier);

    const otherMarket = markets.find((m) => m.symbol !== b.symbol && familySupportedOn(m, b.contract));
    if (otherMarket) {
      s.quarantineAttempts += 1;
      const probe = await probeAccountContract(ctx.token, ctx.derivAccountId, {
        symbol: otherMarket.symbol,
        contractType: b.contract,
        stake: await probeStakeFor(s, ctx, otherMarket.symbol),
        duration: HEDGE_DURATION_TICKS,
        durationUnit: HEDGE_DURATION_UNIT,
        currency: ctx.currency,
        barrier,
      });
      evidence.sameContractOtherMarket = probeOutcome(probe.ok, probe.kind);
      logger.info(
        { contract: b.contract, otherMarket: otherMarket.symbol, result: evidence.sameContractOtherMarket, code: probe.code },
        "Autonomous 1-tick: probed the rejected contract on another market",
      );
    }

    const otherContract = selectedContractTypes(ctx)
      .find((type) => type !== b.contract && familySupportedOn(getMarketInfo(b.symbol) ?? { digitEnabled: true }, type));
    if (otherContract) {
      s.quarantineAttempts += 1;
      const probe = await probeAccountContract(ctx.token, ctx.derivAccountId, {
        symbol: b.symbol,
        contractType: otherContract,
        stake: await probeStakeFor(s, ctx, b.symbol),
        duration: HEDGE_DURATION_TICKS,
        durationUnit: HEDGE_DURATION_UNIT,
        currency: ctx.currency,
        barrier: probeBarrierFor(otherContract, -1),
      });
      evidence.sameMarketOtherContract = probeOutcome(probe.ok, probe.kind);
      logger.info(
        { symbol: b.symbol, otherContract, result: evidence.sameMarketOtherContract, code: probe.code },
        "Autonomous 1-tick: probed another contract on the rejected market",
      );
    }
  } else if (s.quarantineAttempts >= MAX_QUARANTINE_PROBES) {
    logger.warn({ symbol: b.symbol, contract: b.contract }, "Autonomous 1-tick: probe budget spent — quarantining this combination only");
  }

  const scope = inferQuarantineScope(evidence);
  rememberQuarantined(sessionId, { scope, symbol: b.symbol, contract: b.contract, code, reason, kind });
  logger.warn(
    { sessionId, symbol: b.symbol, contract: b.contract, barrier: b.barrier, scope, code, reason, evidence },
    "Autonomous 1-tick: contract quarantined — this Deriv account cannot quote it",
  );
  host.emit("contract_quarantined", {
    symbol: b.symbol, contract: b.contract, barrier: b.barrier, scope, code, reason,
  });
  host.publish({ nextScanIn: null });

  const symbols = watchedMarkets(ctx).map((m) => m.symbol);
  if (!hasTradeableContract(sessionId, { symbols, contracts: selectedContractTypes(ctx) })) {
    host.stop(
      "Deriv will not quote anything this account selected — " +
      `${summarizeQuarantine(sessionId).join("; ")}. ` +
      "Check this Deriv account's market access and currency, or choose different contracts.",
    );
  }
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
  const b = decision.best;
  const sessionId = host.sessionId;
  const reasoningBase = `${AUTONOMOUS_HEDGE_PREFIX}${decision.reason}`;
  const { stake: rawStake, payout } = await resolveStake(decision, ctx, mode, risk);
  // Stake limits are the broker's, denominated in THIS account's currency. The
  // hard-coded USD fallback only applies when the broker reports no bounds.
  const bounds = await stakeBoundsFor(s, ctx, b.symbol);
  const stake = clampStakeToBounds({
    amount: rawStake,
    currency: ctx.currency,
    minStake: bounds?.minStake,
    maxStake: bounds?.maxStake,
    balance: ctx.balance,
    // The USD fallback only applies to currencies that take 2 decimals; for a
    // crypto account an invented floor would itself be an invalid stake.
    fallbackMin: isTwoDecimalCurrency(ctx.currency) ? MIN_STAKE : 0,
  });
  if (stake === null) {
    host.publish({ nextScanIn: null });
    logger.warn(
      { rawStake, minStake: bounds?.minStake ?? null, maxStake: bounds?.maxStake ?? null, currency: ctx.currency, balance: ctx.balance },
      "Autonomous 1-tick: stake outside the broker's allowed range for this account — holding",
    );
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
      const message = friendlyErrorMessage(buyErr);
      const verdict = classifyDerivRejection(buyErr);
      const brokerCode = verdict.code ? ` (Deriv code ${verdict.code})` : "";
      await claimOpenRow(openRow.id, {
        status: "error",
        profit: "0",
        payout: "0",
        closedAt: new Date(),
        agentReasoning: `${reasoningBase} [EXECUTION FAILED: ${message}${brokerCode}]`,
      });
      s.exposure = null;
      host.emit("trade_completed", {
        id: openRow.id, symbol: b.symbol, won: false, profit: "0", contract: b.contract,
        error: `${message}${brokerCode}`,
      });

      // A contract this account cannot quote is a property of the ACCOUNT, not
      // of this tick: the same request fails again on the next tick and on
      // every restart. Quarantine it at the narrowest scope the evidence
      // supports and keep trading what the account CAN quote, instead of
      // spending the 3-strike budget and stopping the whole engine.
      if (verdict.kind === "contract-unavailable") {
        await quarantineRejectedContract(host, s, ctx, b, message, verdict.code, verdict.kind);
        return;
      }

      s.execFailures += 1;
      logger.warn(
        { err: message, code: verdict.code, kind: verdict.kind, symbol: b.symbol, contract: b.contract, failures: s.execFailures },
        "Autonomous 1-tick buy rejected by Deriv",
      );
      if (s.execFailures >= CONSECUTIVE_EXEC_FAILURE_LIMIT) {
        host.stop(
          `Deriv rejected ${CONSECUTIVE_EXEC_FAILURE_LIMIT} consecutive 1-tick buys — last: ${message}` +
          (verdict.code ? ` — ${verdict.hint}` : ""),
        );
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
