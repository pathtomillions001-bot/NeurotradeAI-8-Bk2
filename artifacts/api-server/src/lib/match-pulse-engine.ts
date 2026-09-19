/**
 * Match Pulse lifecycle: server scan receipt → fresh tick → guarded quote/buy →
 * confirmed settlement. One order in flight; an unknown result is NOT a loss,
 * a zero-profit error or permission to buy again.
 */
import { randomUUID } from "node:crypto";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { and, eq, inArray } from "drizzle-orm";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import {
  AUTOMATED_DERIV_MARKETS, tickManager, getAccountConnection,
  waitForContractResult, getLiveBalance,
} from "./deriv";
import { tickSecondsFor } from "./accumulator-analysis";
import { createSessionScoped, getBrowserSessionId, runWithSessionId } from "./session";
import { acquireTradingOwnership, currentTradingOwner, hasTradingOwnership, releaseTradingOwnership } from "./engine-arbiter";
import * as recovery from "./agents/recovery-engine";
import { calculateBotRecoveryStake, applyRecoveryStakeLimits } from "./recovery-math";
import { MATCH_PAYOUT } from "./payouts";
import { broadcastSSE } from "./sse";
import { logger } from "./logger";
import { friendlyErrorMessage } from "./friendly-error";
import { type DigitTick, type DigitSource, sameDigitTick } from "./digit-tape";
import { primePulseHistory, pulseHistoryNow, type PulseHistory } from "./match-pulse-history";
import { assertPulseTick, buyPulseMatch, capPulseStake, readPulseBuyConfirmation, PulseOrderError, type PulseQuote } from "./match-pulse-execution";
import {
  PULSE, evaluatePulseMarket, qualifyPulseReport, selectPulseMarket, readPulse,
  freshPulseCadence, pulseCadenceReady, recordPulseShot, recordPulseResult,
  type PulseReport, type PulseReading, type PulseCadence,
} from "./match-pulse-analysis";
import { parsePulseConfig, type PulseScanConfig, type PulseConfig } from "./match-pulse-config";

export const MATCH_PULSE_ID = "match-pulse";
const NAME = "Match Pulse";
const RECEIPT_TTL_MS = 120_000;
const RESCAN_MS = 90_000;
const PENDING_STATUSES = ["mp-pending", "mp-open"];
const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);

interface Measured {
  report: PulseReport;
  source: DigitSource;
  generation: number;
}
interface PulseAccount {
  id: string;
  loginId: string;
  currency: string;
  isVirtual: boolean;
}
function publicAccount(account: typeof accountsTable.$inferSelect): PulseAccount {
  return { id: account.derivAccountId ?? account.loginId, loginId: account.loginId,
    currency: account.currency, isVirtual: account.isVirtual };
}
interface Receipt {
  account: PulseAccount | null;
  id: string;
  createdAt: number;
  expiresAt: number;
  spec: PulseScanConfig;
  round: number;
  marketsTested: number;
  measured: Measured[];
}
const { state: scans } = createSessionScoped(() => ({ round: 0, busy: false, receipt: null as Receipt | null }));

export function publicPulseReport(measured: Measured) {
  const { replay: _replay, ...report } = measured.report;
  return { ...report, source: measured.source };
}
function publicReceipt(receipt: Receipt) {
  return {
    scanId: receipt.id, createdAt: receipt.createdAt, expiresAt: receipt.expiresAt,
    account: receipt.account,
    marketsTested: receipt.marketsTested, scanRound: receipt.round,
    qualifiedCount: receipt.measured.filter(m => m.report.qualified).length,
    candidates: receipt.measured.map(publicPulseReport),
    note: "Historical evidence, not a promise. Fair Matches win about 10% of the time; losing streaks remain possible. No qualified market means no trade.",
  };
}

async function measure(spec: PulseScanConfig, onlySymbol?: string): Promise<Receipt> {
  if (scans.busy) throw new Error("A Match Pulse scan is already running for this account");
  scans.busy = true;
  const round = ++scans.round;
  const createdAt = Date.now();
  try {
    const account = spec.executionMode === "live" ? await activeAccount() : undefined;
    const scope = onlySymbol ? markets.filter(m => m.symbol === onlySymbol) : markets;
    const measured: Measured[] = [];
    for (const [index, market] of scope.entries()) {
      broadcastSSE("match_pulse_scan", { scanned: index, total: scope.length, symbol: market.symbol, displayName: market.displayName }, getBrowserSessionId());
      // The request never trusts client-supplied probabilities, cards or payouts.
      let history: PulseHistory | null = null;
      try { history = await primePulseHistory(market.symbol); } catch (error) {
        logger.warn({ symbol: market.symbol, error: friendlyErrorMessage(error) }, "Match Pulse excluded inconsistent tick history");
      }
      if (!history) continue;
      const report = evaluatePulseMarket(market.symbol, market.displayName, history.digits, {
        lockedDigit: spec.lockedDigit, marketsTested: scope.length, scanRound: round,
      });
      if (spec.executionMode === "live" && history.source !== "live") {
        report.qualified = false;
        report.reasons.unshift("Simulated data cannot qualify a live order");
      }
      measured.push({ report, source: history.source, generation: history.tick.generation });
      broadcastSSE("match_pulse_scan", { scanned: index + 1, total: scope.length, symbol: market.symbol, displayName: market.displayName }, getBrowserSessionId());
      await yieldLoop();
    }
    measured.sort((a, b) => Number(b.report.qualified) - Number(a.report.qualified) || b.report.lowerEv - a.report.lowerEv);
    // Age is measured from the BEGINNING of the scan, not the last market.
    // All histories were fetched within the bounded scan; execution checks the
    // source generation again and refreshes an expired receipt before trading.
    const receipt: Receipt = { account: account ? publicAccount(account) : null, id: randomUUID(), createdAt, expiresAt: createdAt + RECEIPT_TTL_MS, spec, round, marketsTested: scope.length, measured };
    scans.receipt = receipt;
    return receipt;
  } finally { scans.busy = false; }
}

export async function scanMatchPulse(spec: PulseScanConfig) {
  if (session.running) throw new Error("Stop Match Pulse before a manual scan; a running session re-measures automatically");
  return publicReceipt(await measure(spec));
}

interface Pending {
  journalId: number;
  accountId: string | null;
  tick: DigitTick;
  digit: number;
  stake: number;
  payout: number;
  mode: "paper" | "live";
  contractId?: number;
  sent: boolean;
  reference: string;
  startTime?: number | null;
  /** Broker has definitively rejected / guard aborted before send. */
  cancelled?: boolean;
}
interface Session {
  running: boolean;
  id: string | null;
  config: PulseConfig | null;
  accountId: string | null;
  account: PulseAccount | null;
  receipt: Receipt | null;
  active: Measured | null;
  phase: "idle" | "starting" | "watching" | "cooldown" | "quoting" | "settling" | "reconciling" | "stopping" | "stopped";
  message: string;
  stopRequested: boolean;
  /** Corrupt/ambiguous startup journal: visible, fail-closed operator hold. */
  restorationHold: string | null;
  busy: boolean;
  listener: ((tick: { symbol: string }) => void) | null;
  unlistenPurchase: (() => void) | null;
  timer: ReturnType<typeof setInterval> | null;
  pending: Pending | null;
  reading: PulseReading | null;
  cadence: PulseCadence;
  armAfter: number;
  lastEvaluated: number;
  ticksWatched: number;
  rejectedEntries: number;
  nextScanAt: number;
  nextReconcileAt: number;
  lastSwitchAt: number;
  cooldownUntil: number;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  lossRun: number;
  deepestLossRun: number;
  currentStake: number;
  lastResult?: "won" | "lost";
  balance: number;
  markup: number;
  paperLedger: recovery.RecoveryState;
  settledIds: Set<number>;
  quoteRatios: Map<string, number>;
}
function freshSession(): Session {
  return {
    running: false, id: null, config: null, accountId: null, account: null, receipt: null, active: null,
    phase: "idle", message: "Scan first. Only independently measured Matches setups can deploy.",
    stopRequested: false, restorationHold: null, busy: false, listener: null, unlistenPurchase: null, timer: null, pending: null,
    reading: null, cadence: freshPulseCadence(), armAfter: 0, lastEvaluated: 0,
    ticksWatched: 0, rejectedEntries: 0, nextScanAt: 0, nextReconcileAt: 0,
    lastSwitchAt: 0, cooldownUntil: 0, totalProfit: 0, tradeCount: 0, winCount: 0,
    lossCount: 0, lossRun: 0, deepestLossRun: 0, currentStake: 0,
    balance: 10_000, markup: 10, paperLedger: recovery.createRecoveryState(),
    settledIds: new Set(), quoteRatios: new Map(),
  };
}
const { state: session, replace } = createSessionScoped<Session>(freshSession);

function ledger(): recovery.RecoveryState {
  return session.config?.executionMode === "paper" ? session.paperLedger : recovery.getState();
}
export function getMatchPulseStatus() {
  const rec = ledger();
  return {
    running: session.running, botId: MATCH_PULSE_ID, botName: NAME, sessionId: session.id,
    totalProfit: session.totalProfit, tradeCount: session.tradeCount, winCount: session.winCount,
    lossCount: session.lossCount, currentStake: session.currentStake,
    inRecovery: rec.inRecovery, recoveryStep: rec.recoveryStep, unrecoveredAmount: rec.unrecoveredAmount,
    recoveryTargetProfit: rec.targetProfit, recoveryRemainingTargetProfit: rec.remainingTargetProfit,
    consecutiveRecoveryLosses: session.lossRun, deepestLossRun: session.deepestLossRun,
    currentMarket: session.active?.report.displayName ?? session.pending?.tick.symbol,
    currentContractType: session.reading ? `DIGITMATCH ${session.reading.digit}` : undefined,
    lastResult: session.lastResult, message: session.message,
    pulse: {
      phase: session.phase, executionMode: session.config?.executionMode ?? "live", account: session.account,
      config: session.config, reading: session.reading,
      active: session.active ? publicPulseReport(session.active) : null,
      ticksWatched: session.ticksWatched, rejectedEntries: session.rejectedEntries,
      source: session.active?.source ?? null,
      stopRequested: session.stopRequested, reconciliationIssue: session.restorationHold,
      cooldownTicks: Math.max(0, Math.max(session.cadence.blockedUntil, session.armAfter) - session.lastEvaluated),
      markupPercent: session.markup,
      pending: session.pending ? { journalId: session.pending.journalId, contractId: session.pending.contractId ?? null,
        mode: session.pending.mode, sent: session.pending.sent } : null,
    },
  };
}
function broadcast(): void { broadcastSSE("bot_update", getMatchPulseStatus(), getBrowserSessionId()); }
function say(phase: Session["phase"], message: string): void {
  session.phase = phase;
  session.message = message;
  broadcast();
}
function finish(): void {
  // Keep the executor lease until every asynchronous action and position is resolved.
  if (session.busy || session.pending || session.restorationHold) return;
  session.unlistenPurchase?.();
  session.unlistenPurchase = null;
  if (session.listener) tickManager.off("tick", session.listener);
  if (session.timer) clearInterval(session.timer);
  session.listener = null;
  session.timer = null;
  session.running = false;
  session.phase = "stopped";
  releaseTradingOwnership("match-pulse");
  broadcast();
}
export function stopMatchPulse(): void {
  session.stopRequested = true;
  if (session.restorationHold) { say("reconciling", session.restorationHold); return; }
  say(session.pending ? "reconciling" : "stopping", session.pending
    ? "No more entries. Waiting for the outstanding position to be confirmed; execution remains locked."
    : "Stop requested — cancelling any unsent entry.");
  finish();
}

async function settings() {
  await db.insert(settingsTable).values({ sessionId: getBrowserSessionId() }).onConflictDoNothing();
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, getBrowserSessionId())).limit(1);
  if (!row) throw new Error("Account risk settings are unavailable");
  return row;
}
async function activeAccount() {
  const [row] = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, getBrowserSessionId()), eq(accountsTable.isActive, true),
  )).limit(1);
  return row;
}

function activate(measured: Measured): void {
  const tick = tickManager.getDigitSnapshot(measured.report.symbol, 1)?.tick;
  session.active = measured;
  session.reading = null;
  session.lastEvaluated = tick?.sequence ?? 0;
  // A rotation never buys the scan's final tick or erases a post-loss shield.
  session.armAfter = (tick?.sequence ?? 0) + Math.max(4, session.lossRun >= 3 ? PULSE.clusterCooldown : 4);
  session.cadence = { ...freshPulseCadence(), lossRun: session.lossRun, blockedUntil: session.armAfter };
  session.lastSwitchAt = Date.now();
}

export async function startMatchPulse(input: PulseConfig): Promise<void> {
  const config = parsePulseConfig(input);
  if (session.running || session.busy || session.pending) throw new Error("Match Pulse is already active or awaiting settlement");
  const receipt = scans.receipt;
  if (!receipt || receipt.id !== config.scanId || receipt.expiresAt <= Date.now()) throw new Error("Scan receipt is missing or expired; run a new scan");
  if (receipt.spec.executionMode !== config.executionMode || receipt.spec.lockedDigit !== config.lockedDigit) throw new Error("Digit or execution mode changed; scan again");
  const chosen = receipt.measured.find(m => m.report.symbol === config.selectedSymbol && m.report.qualified);
  if (!chosen) throw new Error("This market did not qualify. There is no force-deploy override");
  if (currentTradingOwner() !== null || !acquireTradingOwnership("match-pulse")) throw new Error("Another engine owns execution on this account; stop it first");
  replace({ ...freshSession(), running: true, busy: true, id: randomUUID(), config, receipt });
  say("starting", "Verifying account, risk limits and the server-held measurement…");
  try {
    const unresolved = await db.select({ id: tradesTable.id }).from(tradesTable).where(and(
      eq(tradesTable.sessionId, getBrowserSessionId()), inArray(tradesTable.status, ["open", ...PENDING_STATUSES]),
    )).limit(1);
    if (unresolved.length) throw new Error("An existing order is unresolved. Confirm its settlement before deploying");
    const [risk, account] = await Promise.all([settings(), activeAccount()]);
    session.markup = Number(risk.botRecoveryMarkup);
    if (config.stake > Number(risk.maxTradeStake)) throw new Error("Base stake exceeds Max Stake Per Trade in Settings");
    if (config.executionMode === "live") {
      // A cold server must not silently start with zero debt. Use the existing
      // account checkpoint and its canonical daily-reset/completion policy.
      if (risk.recoveryStateJson) recovery.loadState(risk.recoveryStateJson);
      if (risk.paperTradeMode) throw new Error("Settings has Paper Trade Mode enabled; live deployment is blocked");
      const token = account?.bearerToken ?? account?.token;
      if (!account || !token) throw new Error("Connect an active Deriv demo or real account before deploying");
      if (!receipt.account || receipt.account.id !== (account.derivAccountId ?? account.loginId) || receipt.account.isVirtual !== account.isVirtual) {
        throw new Error("The connected account changed after scanning; scan again before deploying");
      }
      session.account = publicAccount(account);
      if (chosen.source !== "live") throw new Error("Simulated history cannot arm a live bot");
      session.accountId = account.derivAccountId ?? account.loginId;
      const balance = await getLiveBalance(token, session.accountId);
      if (balance === null || !Number.isFinite(balance) || balance < config.stake) throw new Error("A sufficient broker-confirmed balance is required");
      session.balance = balance;
    }
    if (session.stopRequested) return;
    activate(chosen);
    session.nextScanAt = Date.now() + RESCAN_MS;
    const owner = getBrowserSessionId();
    session.listener = ({ symbol }) => {
      runWithSessionId(owner, () => { void onTick(symbol).catch(handleFailure); });
    };
    tickManager.on("tick", session.listener);
    session.timer = setInterval(() => {
      runWithSessionId(owner, () => { void maintenance().catch(handleFailure); });
    }, 1000);
    session.timer.unref?.();
    say("watching", `${config.executionMode === "paper" ? "Offline test" : session.account?.isVirtual ? "Demo account" : "Real account"} armed on ${chosen.report.displayName}. Waiting for fresh ticks, not firing on deploy.`);
  } catch (error) {
    session.stopRequested = true;
    session.message = friendlyErrorMessage(error);
    throw error;
  } finally {
    session.busy = false;
    if (session.stopRequested) finish();
  }
}

function handleFailure(error: unknown): void {
  logger.error({ error: friendlyErrorMessage(error) }, "Match Pulse stopped safely");
  session.stopRequested = true;
  say(session.pending ? "reconciling" : "stopping", `Held safely: ${friendlyErrorMessage(error)}`);
  finish();
}

async function maintenance(): Promise<void> {
  if (!session.running || session.busy) return;
  if (session.pending) {
    if (session.pending.mode === "paper") {
      await onTick(session.pending.tick.symbol);
      if (session.pending && Date.now() - session.pending.tick.receivedAt > 15_000) {
        session.busy = true;
        try { await cancelPending("Paper tick was never observed; no outcome was invented"); }
        finally { session.busy = false; }
        session.stopRequested = true;
        finish();
      }
    } else if (Date.now() >= session.nextReconcileAt) await reconcileMatchPulse();
    return;
  }
  if (session.stopRequested) { finish(); return; }
  if (Date.now() >= session.nextScanAt) {
    session.busy = true;
    try {
      const config = session.config!;
      say("watching", config.marketMode === "locked" ? "Re-measuring the locked market; no orders during analysis." : "Re-measuring markets; no orders during analysis.");
      const receipt = await measure(config, config.marketMode === "locked" ? config.selectedSymbol : undefined);
      if (session.stopRequested) return;
      session.receipt = receipt;
      session.nextScanAt = Date.now() + RESCAN_MS;
      const currentSymbol = session.active?.report.symbol;
      let pick = selectPulseMarket(receipt.measured.map(m => m.report), config.marketMode, config.selectedSymbol, currentSymbol);
      if (currentSymbol && Date.now() - session.lastSwitchAt < 45_000) {
        pick = receipt.measured.find(m => m.report.symbol === currentSymbol && m.report.qualified)?.report ?? pick;
      }
      if (!pick) {
        session.active = null;
        say("watching", "No market currently qualifies. Recovery debt is preserved; no forced trade.");
      } else {
        const measured = receipt.measured.find(m => m.report.symbol === pick!.symbol)!;
        if (currentSymbol !== pick.symbol || session.active?.generation !== measured.generation) activate(measured);
        else session.active = measured;
        say("watching", `Measurement refreshed on ${pick.displayName}; waiting for a fresh eligible tick.`);
      }
    } finally {
      session.busy = false;
      if (session.stopRequested) finish();
    }
    return;
  }
  if (session.active && tickManager.getTickAgeSeconds(session.active.report.symbol) > 5) {
    say("watching", "Tick feed is stale. Waiting is mandatory; there is no patience override.");
  }
}

async function onTick(symbol: string): Promise<void> {
  if (!session.running || session.busy) return;
  if (session.pending?.mode === "paper" && session.pending.tick.symbol === symbol) {
    session.busy = true;
    try { await settlePaper(); } finally { session.busy = false; if (session.stopRequested) finish(); }
    return;
  }
  if (session.stopRequested || session.pending || !session.active || session.active.report.symbol !== symbol) return;
  const history = pulseHistoryNow(symbol);
  if (!history || history.tick.sequence <= session.lastEvaluated) return;
  session.ticksWatched += history.tick.sequence - session.lastEvaluated;
  session.lastEvaluated = history.tick.sequence;
  if (history.tick.generation !== session.active.generation || history.source !== session.active.source) {
    session.nextScanAt = 0;
    say("watching", "Tick provenance changed or a feed interval was missed. Re-measure before any order.");
    return;
  }
  if (!session.receipt || Date.now() >= session.receipt.expiresAt) {
    session.nextScanAt = 0;
    say("watching", "The measured entry rule has expired; refreshing its evidence.");
    return;
  }
  if (!pulseCadenceReady(session.cadence, history.tick.sequence) || Date.now() < session.cooldownUntil) {
    say("cooldown", `Waiting for distinct fresh ticks${session.lossRun ? " after a loss" : " after deployment"}. Recovery never bypasses timing.`);
    return;
  }
  const reading = readPulse(history.digits, MATCH_PAYOUT, session.config?.lockedDigit);
  session.reading = reading;
  if (!reading.ready) { say("watching", reading.reason); return; }
  session.busy = true;
  try { await enter(reading, history); }
  finally { session.busy = false; if (session.stopRequested) finish(); }
}

function requestedStake(payout: number, maxStake: number): number {
  const config = session.config!;
  const rec = ledger();
  const requested = config.executionMode === "live"
    // EXACTLY the Match Sniper sizing policy: one account-global debt ledger.
    ? recovery.getBotRecoveryStake(config.stake, maxStake, session.balance, payout, session.markup)
    : rec.inRecovery
      ? applyRecoveryStakeLimits(calculateBotRecoveryStake(rec.unrecoveredAmount, payout, session.markup), maxStake, session.balance)
      : config.stake;
  return capPulseStake(requested, maxStake, session.balance, config.stopLoss + session.totalProfit);
}

function journalMeta(pending: Omit<Pending, "journalId"> | Pending): string {
  return JSON.stringify({ bot: MATCH_PULSE_ID, version: PULSE.version, botSession: session.id,
    config: session.config, accountId: pending.accountId, decision: pending.tick,
    payout: pending.payout, mode: pending.mode, reference: pending.reference, brokerStartTime: pending.startTime ?? null,
    reading: session.reading, audit: session.active?.report.audit,
    note: `${pending.mode === "paper" ? "[PAPER] " : ""}[Match Pulse] DIGITMATCH ${pending.digit}; broker outcomes only for live execution` });
}

async function enter(reading: PulseReading, history: PulseHistory): Promise<void> {
  const config = session.config!;
  const owner = getBrowserSessionId();
  const [risk, account] = await Promise.all([settings(), activeAccount()]);
  session.markup = Number(risk.botRecoveryMarkup);
  const maxStake = Number(risk.maxTradeStake);
  const token = account?.bearerToken ?? account?.token;
  if (config.executionMode === "live" && (!token || risk.paperTradeMode || (account?.derivAccountId ?? account?.loginId) !== session.accountId)) {
    session.stopRequested = true;
    say("stopping", "Account or paper/live settings changed; no order sent.");
    return;
  }
  const key = `${history.tick.symbol}:${reading.digit}`;
  const expectedPayout = session.quoteRatios.get(key) ?? MATCH_PAYOUT;
  const stake = requestedStake(expectedPayout, maxStake);
  if (stake < 0.35) {
    session.stopRequested = true;
    say("stopping", "Remaining stop-loss budget, balance or maximum stake cannot fund the minimum trade. Debt is preserved.");
    return;
  }
  const guard = (quote?: PulseQuote): void => runWithSessionId(owner, () => {
    const current = pulseHistoryNow(history.tick.symbol);
    assertPulseTick({ decision: history.tick, current: current?.tick, now: Date.now(),
      maxAgeMs: history.tick.symbol.startsWith("1HZ") ? 550 : 900,
      expectedIntervalMs: tickSecondsFor(history.tick.symbol) * 1000,
      live: config.executionMode === "live", stopped: session.stopRequested || !session.running,
      ownsExecution: hasTradingOwnership("match-pulse") });
    if (!session.receipt || session.receipt.expiresAt <= Date.now() || !session.active ||
        session.active.report.symbol !== history.tick.symbol || session.active.generation !== history.tick.generation) {
      throw new PulseOrderError("Market measurement expired or changed", "not-bought");
    }
    if (config.executionMode === "live" && !tickManager.getConnectionStatus()) throw new PulseOrderError("Broker tick feed disconnected", "not-bought");
    const payout = quote?.multiplier ?? expectedPayout;
    if (quote && session.pending) session.pending.payout = payout;
    if (quote) session.quoteRatios.set(key, payout);
    const repriced = qualifyPulseReport(session.active.report, payout, session.receipt.marketsTested, session.receipt.round);
    const fresh = readPulse(current!.digits, payout, config.lockedDigit);
    if (!repriced.qualified || !fresh.ready || fresh.digit !== reading.digit || fresh.lower * payout <= 1) {
      throw new PulseOrderError("Conditional edge or payout evidence failed at the socket-send boundary", "not-bought");
    }
    if (requestedStake(payout, maxStake) !== stake) throw new PulseOrderError("Live payout changed recovery sizing; reprice on a fresh tick", "not-bought");
  });

  try { guard(); } catch (error) {
    if (!(error instanceof PulseOrderError)) throw error;
    session.rejectedEntries++;
    say("watching", error.message);
    return;
  }
  const pending: Omit<Pending, "journalId"> = {
    accountId: session.accountId, tick: history.tick, digit: reading.digit, stake,
    payout: expectedPayout, mode: config.executionMode, sent: false, reference: randomUUID(),
  };
  const [row] = await db.insert(tradesTable).values({
    sessionId: owner, symbol: history.tick.symbol, displayName: session.active!.report.displayName,
    contractType: "DIGITMATCH", barrier: reading.digit, stake: String(stake), direction: "hold",
    status: config.executionMode === "paper" ? "mp-paper" : "mp-pending",
    aiConfidence: String(Math.round(reading.probability * 10000) / 100), aiRiskScore: "90",
    isAutonomous: true, entryPrice: String(history.tick.price), duration: 1, durationUnit: "t",
    agentReasoning: journalMeta(pending),
  }).returning();
  session.pending = { ...pending, journalId: row!.id };
  session.currentStake = stake;
  say("quoting", `${config.executionMode === "paper" ? "Paper" : "Live"} Matches ${reading.digit}: validating the exact next-tick entry.`);
  try {
    guard(); // Database latency may have consumed this tick. Abort, never chase it.
    if (config.executionMode === "paper") {
      recordPulseShot(session.cadence, history.tick.sequence);
      say("settling", "Paper entry recorded. Settlement uses the very next tick, including an identical digit.");
      return;
    }
    const connection = getAccountConnection(token!, session.accountId!);
    // Keep an exact-reference listener after a local buy timeout. A late broker
    // confirmation can recover its contract ID without a second buy or fuzzy match.
    session.unlistenPurchase?.();
    const onPurchase = (message: any) => runWithSessionId(owner, () => {
      const waiting = session.pending;
      if (!waiting) return;
      const confirmation = readPulseBuyConfirmation(message, waiting.reference);
      if (!confirmation) return;
      if (confirmation.rejected) { waiting.cancelled = true; return; }
      waiting.contractId = confirmation.contractId;
      waiting.stake = confirmation.buyPrice;
      waiting.startTime = confirmation.startTime;
      if (confirmation.startTime !== null && confirmation.startTime >= waiting.tick.epoch + tickSecondsFor(waiting.tick.symbol)) {
        session.stopRequested = true;
      }
    });
    connection.on("message", onPurchase);
    session.unlistenPurchase = () => connection.off("message", onPurchase);
    const purchase = await buyPulseMatch({
      transport: connection, reference: session.pending.reference, symbol: history.tick.symbol,
      digit: reading.digit, stake, currency: account!.currency, guard,
      onBuySent: () => runWithSessionId(owner, () => {
        session.pending!.sent = true;
        recordPulseShot(session.cadence, history.tick.sequence);
      }),
    });
    session.pending.contractId = purchase.contractId;
    session.pending.stake = purchase.buyPrice;
    session.pending.payout = purchase.multiplier;
    session.pending.startTime = purchase.startTime;
    if (purchase.startTime !== null && purchase.startTime >= history.tick.epoch + tickSecondsFor(history.tick.symbol)) {
      // The purchase already exists; settle it honestly, but do not trust further
      // entries until the user re-deploys after investigating broker-side latency.
      session.stopRequested = true;
    }
    // Persist the exact broker identity BEFORE polling. A crash can be reconciled
    // without guessing by symbol, time window or an unrelated trade's stake.
    await persistConfirmedPending();
    say("settling", `Contract ${purchase.contractId} purchased. Waiting for Deriv's confirmed result.`);
    await resolveLivePending(token!);
  } catch (error) {
    if (error instanceof PulseOrderError && error.disposition === "not-bought") {
      session.rejectedEntries++;
      await cancelPending(error.message);
      say("watching", `Entry cancelled: ${error.message}`);
    } else {
      session.stopRequested = true;
      session.nextReconcileAt = Date.now() + 15_000;
      say("reconciling", `Order/settlement unconfirmed. NO retry or new trade: ${friendlyErrorMessage(error)}`);
    }
  }
}

async function persistConfirmedPending(): Promise<void> {
  const pending = session.pending;
  if (!pending?.contractId) return;
  await db.update(tradesTable).set({ status: "mp-open", derivContractId: String(pending.contractId),
    stake: String(pending.stake), agentReasoning: journalMeta(pending) })
    .where(and(eq(tradesTable.id, pending.journalId), eq(tradesTable.sessionId, getBrowserSessionId())));
}
async function cancelPending(reason: string): Promise<void> {
  const pending = session.pending;
  if (!pending) return;
  pending.cancelled = true;
  await db.update(tradesTable).set({ status: "cancelled", profit: "0", payout: "0", closedAt: new Date(),
    agentReasoning: `${journalMeta(pending)}\nCANCELLED: ${reason}` })
    .where(and(eq(tradesTable.id, pending.journalId), eq(tradesTable.sessionId, getBrowserSessionId())));
  session.pending = null;
  session.unlistenPurchase?.();
  session.unlistenPurchase = null;
}
async function settlePaper(): Promise<void> {
  const pending = session.pending;
  if (!pending || pending.mode !== "paper") return;
  const snapshot = tickManager.getDigitSnapshot(pending.tick.symbol);
  if (!snapshot) return;
  if (snapshot.tick.generation !== pending.tick.generation || snapshot.tick.source !== pending.tick.source) {
    await cancelPending("Paper source changed before a verified next tick");
    session.nextScanAt = 0;
    return;
  }
  const next = snapshot.ticks.find(t => t.sequence === pending.tick.sequence + 1);
  if (!next) return;
  const won = next.digit === pending.digit;
  await settlePending(won, won ? pending.stake * (pending.payout - 1) : -pending.stake, next.price);
}
async function resolveLivePending(token: string): Promise<void> {
  const pending = session.pending;
  if (!pending?.contractId || !pending.accountId) throw new Error("Unknown contract ID: verify this order in Deriv; automatic re-buy is forbidden");
  const result = await waitForContractResult(token, pending.accountId, pending.contractId, 20_000);
  if (result.missing || !Number.isFinite(result.profit)) throw new Error("Broker settlement is not final");
  await settlePending(result.won, result.profit, result.exitSpot > 0 ? result.exitSpot : undefined);
  const balance = await getLiveBalance(token, pending.accountId);
  if (balance !== null && Number.isFinite(balance)) session.balance = balance;
}

async function settlePending(won: boolean, rawProfit: number, exitPrice?: number): Promise<void> {
  const pending = session.pending;
  if (!pending) return;
  const profit = Math.round(rawProfit * 100) / 100;
  const owner = getBrowserSessionId();
  const config = session.config!;
  // The trade status and recovery JSON commit TOGETHER. Reconciliation retries
  // lock the row and cannot apply the same outcome to account debt twice.
  const committed = await db.transaction(async tx => {
    const [row] = await tx.select().from(tradesTable).where(and(
      eq(tradesTable.id, pending.journalId), eq(tradesTable.sessionId, owner),
    )).for("update");
    if (!row) throw new Error("Pending journal row is unavailable");
    if (row.status === "won" || row.status === "lost") return null;
    if (![...PENDING_STATUSES, "mp-paper"].includes(row.status)) throw new Error("Journal state changed; outcome not applied");
    const next = recovery.reduceRecoveryOutcome({ ...ledger() }, won, profit, pending.stake,
      config.maxRecoverySteps, "DIGITMATCH", pending.payout);
    if (pending.mode === "live") {
      const updated = await tx.update(settingsTable).set({ recoveryStateJson: JSON.stringify(next), updatedAt: new Date() })
        .where(eq(settingsTable.sessionId, owner)).returning({ id: settingsTable.id });
      if (!updated.length) throw new Error("Cannot atomically persist account recovery");
    }
    await tx.update(tradesTable).set({ status: won ? "won" : "lost", profit: String(profit),
      payout: String(Math.round((pending.stake + profit) * 100) / 100),
      ...(exitPrice !== undefined ? { exitPrice: String(exitPrice) } : {}), closedAt: new Date(),
      agentReasoning: `${journalMeta(pending)}\nCONFIRMED: ${won ? "won" : "lost"}; recovery applied atomically`,
    }).where(eq(tradesTable.id, pending.journalId));
    return next;
  });
  if (committed) {
    if (pending.mode === "live") recovery.seedState(committed);
    else session.paperLedger = committed;
  }
  if (!session.settledIds.has(pending.journalId)) {
    session.settledIds.add(pending.journalId);
    session.tradeCount++;
    session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
    session.winCount += Number(won);
    session.lossCount += Number(!won);
    session.lossRun = won ? 0 : session.lossRun + 1;
    session.deepestLossRun = Math.max(session.deepestLossRun, session.lossRun);
    session.lastResult = won ? "won" : "lost";
    const sequence = tickManager.getDigitSnapshot(pending.tick.symbol, 1)?.tick.sequence ?? pending.tick.sequence + 1;
    recordPulseResult(session.cadence, won, sequence);
    session.cooldownUntil = Date.now() + Math.max(0, session.cadence.blockedUntil - sequence) * tickSecondsFor(pending.tick.symbol) * 1000;
    if (pending.mode === "paper") session.balance = Math.max(0, session.balance + profit);
  }
  session.pending = null;
  session.unlistenPurchase?.();
  session.unlistenPurchase = null;
  const boundary = session.totalProfit >= config.takeProfit ? "Take-profit reached"
    : session.totalProfit <= -config.stopLoss ? "Stop-loss reached"
      : session.lossRun >= config.maxConsecutiveLosses ? "Consecutive-loss circuit breaker reached" : null;
  if (boundary) {
    session.stopRequested = true;
    say("stopping", `${boundary}. Session stopped; remaining recovery debt is preserved.`);
  } else {
    if (session.lossRun >= 3) session.nextScanAt = Math.min(session.nextScanAt, Date.now() + 15_000);
    say(session.stopRequested ? "stopping" : "cooldown", `${won ? "Win" : "Loss"} confirmed: ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}. ${session.stopRequested ? "No further entries." : "Waiting for a new, independently timed setup."}`);
  }
}

/** Retry settlement of THE SAME contract, never the purchase. */
export async function reconcileMatchPulse(): Promise<void> {
  if (session.restorationHold) { say("reconciling", session.restorationHold); return; }
  if (session.busy || !session.pending) return;
  session.busy = true;
  session.nextReconcileAt = Date.now() + 15_000;
  try {
    if (session.pending.cancelled) { await cancelPending("Previously aborted before purchase"); return; }
    if (session.pending.mode === "paper") { await settlePaper(); return; }
    const account = await activeAccount();
    const token = account?.bearerToken ?? account?.token;
    if (!token || (account?.derivAccountId ?? account?.loginId) !== session.pending.accountId) throw new Error("Reconnect the original Deriv account to reconcile its contract");
    await persistConfirmedPending();
    await resolveLivePending(token);
  } catch (error) {
    say("reconciling", `Execution remains locked: ${friendlyErrorMessage(error)}`);
  } finally {
    session.busy = false;
    if (session.stopRequested) finish();
  }
}

/** Restore holds after a restart; never auto-resume trading or guess an outcome. */
export async function restoreMatchPulseHolds(): Promise<void> {
  const rows = await db.select().from(tradesTable).where(inArray(tradesTable.status, PENDING_STATUSES));
  const byOwner = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byOwner.get(row.sessionId) ?? [];
    group.push(row);
    byOwner.set(row.sessionId, group);
  }
  for (const [owner, group] of byOwner) {
    const [risk] = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, owner)).limit(1);
    const accounts = await db.select().from(accountsTable).where(eq(accountsTable.sessionId, owner));
    runWithSessionId(owner, () => {
      if (session.running) return;
      if (!acquireTradingOwnership("match-pulse")) throw new Error("Cannot restore Match Pulse hold while another executor owns the account");
      if (risk?.recoveryStateJson) recovery.loadState(risk.recoveryStateJson);
      // A single-flight engine cannot safely attribute multiple interrupted
      // buys. Do not restore just the first and release the lease over the rest.
      const hold = (reason: string) => {
        const message = `Manual reconciliation required: ${reason}. Journal ${group.map(row => row.id).join(", ")}. Verify the original broker account; execution stays locked until the journal is repaired and the server restarted.`;
        replace({ ...freshSession(), running: true, stopRequested: true, id: randomUUID(),
          phase: "reconciling", restorationHold: message, message });
        logger.error({ owner, journalIds: group.map(row => row.id) }, "Match Pulse startup journal requires manual review");
      };
      if (group.length !== 1) { hold("multiple interrupted live orders"); return; }
      const row = group[0]!;
      try {
        const meta = JSON.parse(row.agentReasoning ?? "{}");
        const config = parsePulseConfig(meta.config);
        const decision = meta.decision as DigitTick | undefined;
        const contractId = row.derivContractId === null ? undefined : Number(row.derivContractId);
        if (meta.bot !== MATCH_PULSE_ID || meta.mode !== "live" || config.executionMode !== "live" ||
            typeof meta.accountId !== "string" || !meta.accountId || !decision || decision.source !== "live" ||
            decision.symbol !== row.symbol || !Number.isSafeInteger(decision.sequence) || decision.sequence < 1 ||
            !Number.isSafeInteger(decision.generation) || decision.generation < 1 ||
            !Number.isFinite(decision.epoch) || !Number.isFinite(decision.receivedAt) || !Number.isFinite(decision.price) ||
            row.contractType !== "DIGITMATCH" || row.duration !== 1 || row.durationUnit !== "t" ||
            !Number.isInteger(row.barrier) || row.barrier! < 0 || row.barrier! > 9 ||
            !Number.isFinite(Number(row.stake)) || Number(row.stake) <= 0 ||
            !Number.isFinite(meta.payout) || meta.payout <= 1 ||
            (contractId !== undefined && (!Number.isSafeInteger(contractId) || contractId <= 0))) {
          throw new Error("Invalid interrupted-order metadata");
        }
        replace({ ...freshSession(), running: true, stopRequested: true, id: typeof meta.botSession === "string" ? meta.botSession : randomUUID(),
          config, accountId: meta.accountId,
          account: (() => { const match = accounts.find(account => (account.derivAccountId ?? account.loginId) === meta.accountId); return match ? publicAccount(match) : null; })(),
          phase: "reconciling",
          message: "Interrupted live order found. Trading remains locked until Deriv confirms its settlement.",
          pending: { journalId: row.id, accountId: meta.accountId, tick: decision,
            digit: row.barrier!, stake: Number(row.stake), payout: meta.payout,
            mode: "live", sent: true, reference: typeof meta.reference === "string" ? meta.reference : randomUUID(),
            startTime: Number.isFinite(meta.brokerStartTime) ? meta.brokerStartTime : null, contractId },
        });
      } catch {
        hold("invalid interrupted-order metadata");
      }
    });
  }
}
