/**
 * TWIN-RAIL SENTINEL ENGINE — two frozen straddles fired as ONE atomic burst.
 *
 * The analysis module (`twin-rail-analysis.ts`) owns every number this bot
 * believes. This module owns the SESSION: scanning the universe, choosing a
 * market, waiting for a fresh tick, firing both legs inside one inter-tick
 * window, verifying that they actually shared that tick, and recording the
 * round into the shared recovery ledger.
 *
 * The contracts are NOT configurable. Over 4 + Under 5 is the normal rail and
 * Over 5 + Under 4 is the recovery rail, both frozen in the analysis module and
 * re-asserted immediately before every burst. There is no side picker, no
 * barrier picker and no contract picker — the user chooses risk, market mode
 * and how strictly the carrier is treated, nothing else.
 *
 * Invariants it inherits from every other bot in this repo:
 *
 *   · ONE EXECUTOR — `engine-arbiter` ownership is acquired on start and
 *     re-checked before every burst. Only one engine may own the shared ledger.
 *   · ONE RECOVERY LEDGER — the shared, DB-persisted, debt-driven ladder. The
 *     stake comes from `recoveryEngine.getBotRecoveryStake` and the outcome goes
 *     back through `recoveryEngine.recordOutcome`, with the debt set to what the
 *     pair ACTUALLY lost (|net|), never to the nominal leg stake.
 *   · SAME-TICK OR NOTHING — both legs ride one `executeBulkLiveTrades` burst on
 *     the account's pooled socket, fire only when `planTwinFire` says the window
 *     can hold the burst, and are then VERIFIED by the pair's own outcome
 *     pattern: exactly one winner = synced, both winners = split tick.
 *   · NEVER SELF-STOP ON A TRANSIENT ERROR — the session ends on take profit,
 *     stop loss, or the user's stop. A flaky socket is a message, not an exit.
 *   · SESSION SCOPE — the loop is pinned with `runWithSession`, and the engine
 *     publishes itself to the cross-session live registry.
 *
 * The one thing that is uniquely Twin-Rail: it knows that its normal rail is a
 * PAYMENT, not a bet. Over 4 + Under 5 partitions the digits, so exactly one leg
 * always wins and the round costs S·(p − 2) ≈ 5 % of the leg stake every single
 * time, whatever the tape does. The console prints that toll per round, per cycle
 * and per hour, and the recovery rail — the only place an edge can exist — fires
 * only when the MEASURED dead-rail rate clears the rate the live quotes imply.
 */

import {
  tickManager,
  getContractProposal,
  executeBulkLiveTrades,
  waitForContractResult,
  getLiveBalance,
  getDeepDigits,
  deepHistoryDegraded,
  isAutomatedMarket,
  executeLiveTrade,
  AUTOMATED_DERIV_MARKETS,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import * as recoveryEngine from "./agents/recovery-engine";
import {
  acquireTradingOwnership,
  releaseTradingOwnership,
  hasTradingOwnership,
  currentTradingOwner,
  tradingOwnerLabel,
} from "./engine-arbiter";
import { getBrowserSessionId, runWithSession } from "./session";
import { resolveRecoveryPayout } from "./recovery-payout";
import {
  NORMAL_PAIR,
  RECOVERY_PAIR,
  TWIN_RAIL_BOT_ID,
  TWIN_RAIL_BOT_NAME,
  TWIN_RAIL_DURATION_TICKS,
  TWIN_RAIL_FALLBACK_QUOTES,
  buildContextualFrequencies,
  cycleEdgeAtRecoveryStake,
  deadRailBreakEven,
  deadZoneDigits,
  detectDigitMemory,
  estimateFrequencies,
  measurePairEdge,
  pairLabel,
  planTwinFire,
  profileTicks,
  quantileSorted,
  normalCdf,
  roundLedgerDecision,
  roundOutcome,
  syncVerdict,
  type ContextInfo,
  type ContextualFrequencyEstimate,
  type EdgeEstimate,
  type FrequencyEstimate,
  type PairQuote,
  type PairSpec,
  type RecoveryTrigger,
  type RoundLedgerDecision,
  type SyncVerdict,
  type TickProfile,
  type TwinFirePlan,
  type TwinRailMarketScore,
  type TwinRailVerdict,
  TWIN_RAIL_MECHANICS,
} from "./twin-rail-analysis";

// ── Tuning ────────────────────────────────────────────────────────────────────

/** Digits pulled per market when measuring. Deriv's own history cap is 4999. */
const SCAN_WINDOW = 4999;
/** How many markets get the (slower) live-quote pass after the digit pass. */
const SCAN_SHORTLIST = 6;
/** Scan gate confidence: one-sided 95 %. */
const GATE_Z = 1.645;
/** A switching session only moves to a market that beats the incumbent by this. */
const SWITCH_MARGIN = 0.02;
const REANALYZE_LOCKED_MS = 20_000;
const REANALYZE_SWITCHING_MS = 90_000;
const TICK_WAIT_MS = 120;
const MAX_TICK_WAIT_MS = 8_000;
const LEG_SETTLE_TIMEOUT_MS = 30_000;
/** Safety margin on top of the measured burst round-trip inside a tick window. */
const FIRE_SAFETY_MS = 250;
/** How many measured bursts feed the p95 used by the fire window. */
const RTT_WINDOW = 24;
/** Wake-ups without ownership before the loop gives up (defensive). */
const OWNERSHIP_SLEEP_MS = 1500;

/**
 * What the carrier does while it is NOT recovering.
 *
 * `spec`     — the user's rule: the normal rail runs continuously, because on a
 *              partition straddle it can never have a losing *leg* pattern to
 *              wait for. Its toll is printed instead of gated away.
 * `measured` — the carrier also has to earn its place: a cycle only starts when
 *              the measured cycle lower bound is positive. On a fair tape that
 *              is never, and the console says exactly why.
 */
export type RailDiscipline = "spec" | "measured";

const TWIN_RAIL_DISCIPLINES: readonly RailDiscipline[] = ["spec", "measured"];

export function isRailDiscipline(value: unknown): value is RailDiscipline {
  return typeof value === "string" && (TWIN_RAIL_DISCIPLINES as readonly string[]).includes(value);
}

export function isRecoveryTrigger(value: unknown): value is RecoveryTrigger {
  return value === "pair-loss" || value === "both-legs";
}

// ── Session state ─────────────────────────────────────────────────────────────

export interface TwinRailConfig {
  ownerSessionId: string;
  botId?: string;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  symbol: string;
  displayName: string;
  recoveryTrigger: RecoveryTrigger;
  discipline: RailDiscipline;
  score?: TwinRailMarketScore | null;
  forced?: boolean;
}

interface TwinRailRailState {
  symbol: string;
  displayName: string;
  normal: string;
  recovery: string;
  marketMode: "locked" | "switching";
  trigger: RecoveryTrigger;
  discipline: RailDiscipline;
  quotesLive: boolean;
  normalQuote: PairQuote;
  recoveryQuote: PairQuote;
  /** What the normal rail costs per round at the CURRENT leg stake. */
  carrierToll: number;
  /** What the normal rail costs per hour at the measured tick period. */
  carrierTollPerHour: number;
  quota: number;
  deadRate: number;
  contextualDeadRate: number;
  context: string;
  samples: number;
  verdict: TwinRailVerdict;
  score: number;
  reason: string;
  signals: string[];
  forced: boolean;
  /** Contextual conditioning actually being used by the gate. */
  conditioning: string;
  memoryNote: string;
}

interface TwinRailWatch {
  phase: "measuring" | "aiming" | "holding" | "firing" | "settling";
  gateOpen: boolean;
  gateReason: string;
  cycleLcb: number;
  cycleMean: number;
  carrierToll: number;
  railMean: number;
  railLcb: number;
  tickPeriodMs: number;
  tickAgeMs: number;
  headroomMs: number;
  budgetMs: number;
  waitReason: string;
  holds: number;
  rttP95Ms: number;
  burstSamples: number;
  /** What the next stake is actually sized to, in plain language. */
  stakeNote: string;
}

interface TwinRailLedger {
  roundCount: number;
  cycleCount: number;
  syncedRounds: number;
  deadRailHits: number;
  splitRounds: number;
  nakedRepairs: number;
  doubleLosses: number;
  syncRate: number;
  burstP50Ms: number;
  burstP95Ms: number;
  lastBurstMs: number;
  lastHeadroomMs: number;
  lastDigit: number | null;
  lastSync: SyncVerdict | null;
  legStake: number;
  pairExposure: number;
}

interface SessionState {
  running: boolean;
  stopRequested: boolean;
  sessionId: string | null;
  config: TwinRailConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  currentMarket: string;
  currentContractType: string;
  currentLossRun: number;
  deepestLossRun: number;
  lastResult: "won" | "lost" | null;
  message: string;
  rail: TwinRailRailState | null;
  watch: TwinRailWatch;
  ledger: TwinRailLedger;
  /** Measured digit tape for the active market (the gate's evidence). */
  tape: number[];
  /** Contextual conditioning for the NEXT tick, rebuilt on every measurement. */
  conditioned: ContextualFrequencyEstimate | null;
  /** Latest measured edges for the active market, at the current stake. */
  normalEdge: EdgeEstimate | null;
  recoveryEdge: EdgeEstimate | null;
  /** Last round's ledger verdict — drives what rail fires next. */
  decision: RoundLedgerDecision | null;
  /** Rolling measured burst round-trips, ms. */
  burstRtts: number[];
  /** Consecutive holds, so a closed gate re-measures instead of idling. */
  holds: number;
  lastMeasuredAt: number;
}

function freshWatch(): TwinRailWatch {
  return {
    phase: "measuring",
    gateOpen: false,
    gateReason: "Measuring the tape before the first round…",
    cycleLcb: 0,
    cycleMean: 0,
    carrierToll: 0,
    railMean: 0,
    railLcb: 0,
    tickPeriodMs: 0,
    tickAgeMs: 0,
    headroomMs: 0,
    budgetMs: 0,
    waitReason: "",
    holds: 0,
    rttP95Ms: 0,
    burstSamples: 0,
    stakeNote: "",
  };
}

function freshLedger(): TwinRailLedger {
  return {
    roundCount: 0,
    cycleCount: 0,
    syncedRounds: 0,
    deadRailHits: 0,
    splitRounds: 0,
    nakedRepairs: 0,
    doubleLosses: 0,
    syncRate: 1,
    burstP50Ms: 0,
    burstP95Ms: 0,
    lastBurstMs: 0,
    lastHeadroomMs: 0,
    lastDigit: null,
    lastSync: null,
    legStake: 0,
    pairExposure: 0,
  };
}

function freshSession(): SessionState {
  return {
    running: false,
    stopRequested: false,
    sessionId: null,
    config: null,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    currentStake: 0,
    currentMarket: "",
    currentContractType: "",
    currentLossRun: 0,
    deepestLossRun: 0,
    lastResult: null,
    message: `${TWIN_RAIL_BOT_NAME} is idle. Run the twin analysis to deploy it.`,
    rail: null,
    watch: freshWatch(),
    ledger: freshLedger(),
    tape: [],
    conditioned: null,
    normalEdge: null,
    recoveryEdge: null,
    decision: null,
    burstRtts: [],
    holds: 0,
    lastMeasuredAt: 0,
  };
}

let session: SessionState = freshSession();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function broadcast() {
  broadcastSSE("bot_update", getStatus(), session.config?.ownerSessionId);
}

function progress(ownerSessionId: string, scanning: string, scanned: number, total: number) {
  broadcastSSE("bot_scan_progress", { botId: TWIN_RAIL_BOT_ID, scanning, scanned, total }, ownerSessionId);
}

// ── Quotes ────────────────────────────────────────────────────────────────────

export interface TwinRailQuotes {
  normal: PairQuote;
  recovery: PairQuote;
  live: boolean;
}

/**
 * Price both rails from the exchange's own proposals, falling back to the
 * canonical schedule when the public feed cannot be reached. A quote is a fact
 * about the payout, never a prediction: the gate is measured against whatever
 * these numbers are, so a degraded quote makes the bot more conservative, never
 * more confident.
 */
export async function fetchTwinRailQuotes(
  symbol: string,
  currency = "USD",
): Promise<TwinRailQuotes> {
  const want = [
    { key: "over4", contractType: "DIGITOVER", barrier: NORMAL_PAIR.over },
    { key: "under5", contractType: "DIGITUNDER", barrier: NORMAL_PAIR.under },
    { key: "over5", contractType: "DIGITOVER", barrier: RECOVERY_PAIR.over },
    { key: "under4", contractType: "DIGITUNDER", barrier: RECOVERY_PAIR.under },
  ] as const;

  const resolved = await Promise.all(want.map(async (leg) => {
    const quote = await resolveRecoveryPayout({
      symbol,
      contractType: leg.contractType,
      barrier: leg.barrier,
      duration: TWIN_RAIL_DURATION_TICKS,
      durationUnit: "t",
      currency,
    });
    return { key: leg.key, value: quote };
  }));

  const byKey = new Map<string, typeof resolved[number]["value"]>(resolved.map((r) => [r.key as string, r.value]));
  const live = resolved.every((r) => r.value.source === "live");
  const read = (key: string, fallback: number): number => {
    const q = byKey.get(key);
    return q && Number.isFinite(q.payoutMultiplier) && q.payoutMultiplier > 1
      ? q.payoutMultiplier
      : fallback;
  };

  return {
    normal: {
      overPayout: read("over4", TWIN_RAIL_FALLBACK_QUOTES.normal.overPayout),
      underPayout: read("under5", TWIN_RAIL_FALLBACK_QUOTES.normal.underPayout),
    },
    recovery: {
      overPayout: read("over5", TWIN_RAIL_FALLBACK_QUOTES.recovery.overPayout),
      underPayout: read("under4", TWIN_RAIL_FALLBACK_QUOTES.recovery.underPayout),
    },
    live,
  };
}

// ── Measurement ───────────────────────────────────────────────────────────────

interface MarketMeasurement {
  tape: FrequencyEstimate;
  conditioned: ContextualFrequencyEstimate;
  memory: { order: 0 | 1; chi2: number; p: number };
  context: ContextInfo;
  normalEdge: EdgeEstimate;
  recoveryEdge: EdgeEstimate;
  cycleEdge: number;
  cycleEdgeLcb: number;
  profile: TickProfile;
  quotes: TwinRailQuotes;
  digits: number[];
}

/**
 * Measure ONE market: the tape, the contextual conditioning for the next tick,
 * and the posterior edge of both rails at the given leg stake.
 *
 * Everything here is deterministic given the tape and the quotes — which is the
 * point. The gate cannot drift, and the same tape always produces the same
 * verdict, so a hold is always explainable.
 */
export function measureTwinRailMarket(input: {
  symbol: string;
  digits: number[];
  quotes: TwinRailQuotes;
  stake: number;
  tickTimestamps?: number[];
  now?: number;
}): MarketMeasurement {
  const { digits, quotes, stake } = input;
  const memory = detectDigitMemory(digits);
  const tape = estimateFrequencies(digits, RECOVERY_PAIR);
  const previousDigit = digits.length > 0 ? digits[digits.length - 1]! : null;
  const conditioned =
    memory.order === 1 && previousDigit !== null
      ? buildContextualFrequencies(digits, RECOVERY_PAIR, 1, previousDigit)
      : buildContextualFrequencies(digits, RECOVERY_PAIR, 0, previousDigit ?? 0);

  const normalEdge = measurePairEdge(NORMAL_PAIR, quotes.normal, stake, tape, GATE_Z);
  const recoveryEdge = measurePairEdge(RECOVERY_PAIR, quotes.recovery, stake, conditioned, GATE_Z);

  // The cycle the bot actually runs: a carrier round (its toll) followed by the
  // recovery round the ladder will place. Both are evaluated at the stake the
  // bot is about to use, so the number on the console is the number it trades.
  const cycleEdge = cycleEdgeAtRecoveryStake({
    carrierNet: normalEdge.mean,
    recoveryEdgePerStake: recoveryEdge.mean / Math.max(1e-9, stake),
    recoveryStake: stake,
  });
  const recoveryLcbPerStake = recoveryEdge.lcb / Math.max(1e-9, stake);
  const cycleEdgeLcb = cycleEdgeAtRecoveryStake({
    carrierNet: normalEdge.mean,
    recoveryEdgePerStake: recoveryLcbPerStake,
    recoveryStake: stake,
  });

  const profile = profileTicks(input.tickTimestamps ?? [], input.now ?? Date.now());

  return {
    tape,
    conditioned,
    memory,
    context: conditioned.context,
    normalEdge,
    recoveryEdge,
    cycleEdge,
    cycleEdgeLcb,
    profile,
    quotes,
    digits,
  };
}

/** Tick arrival timestamps for the active market, straight from the digit tape. */
export function tickTimestampsFor(symbol: string, count = 400): number[] {
  const snapshot = tickManager.getDigitSnapshot(symbol, count);
  if (!snapshot) return [];
  return snapshot.ticks
    .filter((t) => t.generation === snapshot.tick.generation)
    .map((t) => t.receivedAt);
}

function buildSignals(m: MarketMeasurement, stake: number, pairLabelText: string): string[] {
  const signals: string[] = [];
  const toll = m.normalEdge.mean;
  const tollPerHour = m.profile.periodMs > 0 ? toll * (3_600_000 / m.profile.periodMs) : 0;

  signals.push(
    `Carrier cost: ${pairLabelText} partitions the digits, so the round returns ` +
    `${toll >= 0 ? "+" : "−"}$${Math.abs(toll).toFixed(3)} on ${stake.toFixed(2)}/leg — ` +
    `a fixed toll ($${Math.abs(tollPerHour).toFixed(2)}/hour at this tick rate), not a coin flip.`,
  );
  signals.push(
    `Recovery quota: this market's own quotes need the dead rail {${deadZoneDigits(RECOVERY_PAIR).join(", ")}} ` +
    `rarer than ${(m.recoveryEdge.quota * 100).toFixed(2)} % to pay; the deep history prints ` +
    `${(m.recoveryEdge.deadRate * 100).toFixed(2)} % (raw ${(m.tape.deadRaw * 100).toFixed(2)} % over ${m.tape.samples} ticks).`,
  );
  signals.push(
    `Posterior on the recovery rail: E = ${m.recoveryEdge.mean >= 0 ? "+" : "−"}$${Math.abs(m.recoveryEdge.mean).toFixed(4)} ` +
    `± ${m.recoveryEdge.sd.toFixed(4)} per round → 95 % lower bound ` +
    `${m.recoveryEdge.lcb >= 0 ? "+" : "−"}$${Math.abs(m.recoveryEdge.lcb).toFixed(4)} ` +
    `(P(edge > 0) = ${(m.recoveryEdge.pPositive * 100).toFixed(1)} %).`,
  );
  if (m.memory.order === 1) {
    signals.push(
      `Digit memory detected (χ² = ${m.memory.chi2.toFixed(1)}, p = ${m.memory.p.toExponential(1)}): the gate is ` +
      `conditioned on the previous digit ${m.context.label} — ${m.context.contextSamples} observations, ` +
      `${(m.context.mixing * 100).toFixed(0)} % weight on the conditional.`,
    );
  } else {
    signals.push(
      `No usable digit memory (χ² = ${m.memory.chi2.toFixed(1)}, p = ${m.memory.p.toFixed(3)}): the gate uses the ` +
      `unconditional tape rather than inventing a pattern.`,
    );
  }
  if (m.profile.samples > 20) {
    signals.push(
      `Tick clock: ${Math.round(m.profile.periodMs)} ms period (±${Math.round(m.profile.jitterMs)} ms over ` +
      `${m.profile.samples} ticks) — the whole same-tick budget the burst must fit inside.`,
    );
  }
  return signals;
}

// ── Scan ──────────────────────────────────────────────────────────────────────

export interface TwinRailScanCandidate extends TwinRailMarketScore {
  contextualDeadRate: number;
  contextLabel: string;
}

export interface TwinRailScanResult {
  suitable: boolean;
  best: TwinRailScanCandidate | null;
  allScored: TwinRailScanCandidate[];
  reason: string;
  degraded: boolean;
  memoryNote: string;
  mechanics: readonly string[];
}

function candidateFrom(
  symbol: string,
  displayName: string,
  m: MarketMeasurement,
  stake: number,
): TwinRailScanCandidate {
  const verdict: TwinRailVerdict = m.recoveryEdge.verdict;
  const deployable = m.recoveryEdge.lcb > 0 || m.cycleEdgeLcb > 0;
  const reason = deployable
    ? `${displayName}: dead rail prints ${(m.recoveryEdge.deadRate * 100).toFixed(2)} % against a ` +
      `${(m.recoveryEdge.quota * 100).toFixed(2)} % quota — the recovery rail clears its gate by ` +
      `$${Math.abs(m.recoveryEdge.lcb).toFixed(4)} per round.`
    : `${displayName}: dead rail prints ${(m.recoveryEdge.deadRate * 100).toFixed(2)} % against a ` +
      `${(m.recoveryEdge.quota * 100).toFixed(2)} % quota — the recovery rail does not clear its gate.`;

  return {
    symbol,
    displayName,
    quotes: { normal: m.quotes.normal, recovery: m.quotes.recovery },
    quotesLive: m.quotes.live,
    normal: m.normalEdge,
    recovery: m.recoveryEdge,
    tape: m.tape,
    cycleEdge: m.cycleEdge,
    cycleEdgeLcb: m.cycleEdgeLcb,
    survival: 1 - m.recoveryEdge.deadRate,
    profile: m.profile,
    verdict,
    deployable,
    reason,
    signals: buildSignals(m, stake, pairLabel(NORMAL_PAIR)),
    contextualDeadRate: m.conditioned.deadRate,
    contextLabel: m.memory.order === 1 ? m.context.label : "unconditional",
  };
}

/**
 * Measure every digit-enabled automated market and rank them.
 *
 * Two passes, because quotes are expensive and digits are not: the digit pass
 * ranks ALL markets on the only structural fact that matters (how often the dead
 * rail actually prints), then the quote pass prices the shortlist properly. A
 * market whose tape cannot beat 17.7 % never needs a proposal fetched to be
 * eliminated — which is what keeps the scan fast enough to run before every
 * switching rotation.
 */
export async function scanForTwinRail(ownerSessionId: string, params: {
  stake: number;
  currency?: string;
}): Promise<TwinRailScanResult> {
  const currency = params.currency ?? "USD";
  const stake = Math.max(0.35, Number(params.stake) || 1);
  const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
  const total = markets.length;

  progress(ownerSessionId, "digit tape", 0, total);

  const firstPass: Array<{
    symbol: string;
    displayName: string;
    digits: number[];
    deadRate: number;
    samples: number;
  }> = [];

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    progress(ownerSessionId, market.displayName, i, total);
    let digits: number[];
    try {
      digits = await getDeepDigits(market.symbol, SCAN_WINDOW);
    } catch {
      digits = [];
    }
    if (digits.length < 30) digits = tickManager.getDigits(market.symbol, SCAN_WINDOW);
    if (digits.length < 30) continue;
    const tape = estimateFrequencies(digits, RECOVERY_PAIR);
    firstPass.push({
      symbol: market.symbol,
      displayName: market.displayName,
      digits,
      deadRate: tape.deadRate,
      samples: tape.samples,
    });
    await sleep(5);
  }

  // The digit pass is only a ranking heuristic: keep the markets whose tape is
  // least likely to hit the dead rail, then price them for real.
  const shortlist = firstPass
    .slice()
    .sort((a, b) => a.deadRate - b.deadRate)
    .slice(0, SCAN_SHORTLIST);

  const scored: TwinRailScanCandidate[] = [];
  for (let i = 0; i < shortlist.length; i++) {
    const row = shortlist[i]!;
    progress(ownerSessionId, row.displayName, i, shortlist.length);
    const quotes = await fetchTwinRailQuotes(row.symbol, currency);
    const measured = measureTwinRailMarket({
      symbol: row.symbol,
      digits: row.digits,
      quotes,
      stake,
      tickTimestamps: tickTimestampsFor(row.symbol),
    });
    scored.push(candidateFrom(row.symbol, row.displayName, measured, stake));
    await sleep(5);
  }

  scored.sort((a, b) => b.cycleEdgeLcb - a.cycleEdgeLcb);
  const best = scored[0] ?? null;
  const degraded = deepHistoryDegraded();
  const suitable = !!best && best.deployable;

  const memoryNote = best
    ? best.contextLabel === "unconditional"
      ? "Order 0 — the digits carry no usable memory, so the gate uses the unconditional tape."
      : `Order 1 — the gate conditions on ${best.contextLabel} (${best.contextualDeadRate !== best.recovery.deadRate
        ? `${(best.contextualDeadRate * 100).toFixed(2)} % conditioned vs ${(best.recovery.deadRate * 100).toFixed(2)} % marginal dead rail`
        : "no material difference from the marginal"}).`
    : "No market produced a usable tape.";

  const reason = suitable
    ? `Best cycle: ${best!.displayName} — carrier toll $${Math.abs(best!.normal.mean).toFixed(3)}/round, ` +
      `recovery gate clears by $${Math.abs(best!.recovery.lcb).toFixed(4)}/round, ` +
      `dead rail ${(best!.recovery.deadRate * 100).toFixed(2)} % vs quota ${(best!.recovery.quota * 100).toFixed(2)} %.`
    : best
      ? `No market cleared the recovery gate. Best was ${best.displayName} at ` +
        `${(best.recovery.deadRate * 100).toFixed(2)} % dead rail against a ${(best.recovery.quota * 100).toFixed(2)} % quota — ` +
        `an honest tape cannot pay this rail; you can still lock it deliberately and the console will keep printing the toll.`
      : "No digit-enabled market returned enough history to measure.";

  return {
    suitable,
    best,
    allScored: scored,
    reason,
    degraded,
    memoryNote,
    mechanics: TWIN_RAIL_MECHANICS,
  };
}

// ── Public status ─────────────────────────────────────────────────────────────

export interface TwinRailStatus {
  running: boolean;
  botId: string;
  botName: string;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  recoveryTargetProfit: number;
  recoveryRemainingTargetProfit: number;
  consecutiveRecoveryLosses: number;
  currentLossRun: number;
  deepestLossRun: number;
  currentMarket: string;
  currentContractType: string;
  lastResult: "won" | "lost" | null;
  message: string;
  config?: Omit<TwinRailConfig, "score">;
  /** Named `rail`/`twinWatch`/`twinLedger` — never collides with other consoles. */
  rail?: TwinRailRailState;
  twinWatch: TwinRailWatch;
  twinLedger: TwinRailLedger;
}

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): TwinRailStatus {
  const recovery = recoveryEngine.getState();
  const cfg = session.config;
  return {
    running: session.running,
    botId: TWIN_RAIL_BOT_ID,
    botName: TWIN_RAIL_BOT_NAME,
    sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    currentStake: Math.round(session.currentStake * 100) / 100,
    inRecovery: recoveryEngine.isInRecovery(),
    recoveryStep: recovery.recoveryStep,
    unrecoveredAmount: Math.round(recovery.unrecoveredAmount * 100) / 100,
    recoveryTargetProfit: Math.round(recovery.targetProfit * 100) / 100,
    recoveryRemainingTargetProfit: Math.round(recovery.remainingTargetProfit * 100) / 100,
    consecutiveRecoveryLosses: recovery.streakLossCount,
    currentLossRun: session.currentLossRun,
    deepestLossRun: session.deepestLossRun,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    config: cfg ? (() => { const { score: _s, ...rest } = cfg; return rest; })() : undefined,
    rail: session.rail ? { ...session.rail, signals: [...session.rail.signals] } : undefined,
    twinWatch: { ...session.watch },
    twinLedger: { ...session.ledger },
  };
}

// ── Session start / stop ──────────────────────────────────────────────────────

export async function startSession(config: TwinRailConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "Twin-Rail Sentinel is already active — stop it first" };

  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return {
      ok: false,
      error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account. Stop it first — only one engine may own the shared recovery ledger.`,
    };
  }

  const fail = (error: string) => {
    releaseTradingOwnership("bots");
    return { ok: false as const, error };
  };

  if (!config.ownerSessionId) return fail("Browser session missing — reload the page and try again");
  if (!(config.stake >= 0.35)) return fail("Minimum stake is $0.35 per leg");
  if (!(config.stopLoss > 0)) return fail("Stop loss must be positive");
  if (!(config.takeProfit > 0)) return fail("Take profit must be positive");
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  const market = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === config.symbol);
  if (!market || !market.digitEnabled) return fail("Twin-Rail needs a digit-enabled market");
  if (config.marketMode === "locked") {
    const locked = config.lockedSymbol ?? config.symbol;
    if (!isAutomatedMarket(locked)) return fail(`${locked} cannot be analysed or traded by this bot`);
    const lockedMarket = AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === locked);
    if (!lockedMarket || !lockedMarket.digitEnabled) return fail("The locked market must be digit-enabled");
  }
  // CONTRACT SOVEREIGNTY: the rails are constants. Nothing in the request can
  // widen, swap or re-tune them — re-assert it here so a bug upstream cannot.
  if (NORMAL_PAIR.over !== 4 || NORMAL_PAIR.under !== 5) {
    return fail("The normal rail has been tampered with — refusing to trade");
  }
  if (RECOVERY_PAIR.over !== 5 || RECOVERY_PAIR.under !== 4) {
    return fail("The recovery rail has been tampered with — refusing to trade");
  }

  const locked = config.marketMode === "locked";
  const symbol = locked ? (config.lockedSymbol ?? config.symbol) : config.symbol;
  const displayName = locked
    ? (AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol)?.displayName ?? config.displayName)
    : config.displayName;

  const deployment: TwinRailConfig = {
    ...config,
    symbol,
    displayName,
    botId: TWIN_RAIL_BOT_ID,
    recoveryTrigger: isRecoveryTrigger(config.recoveryTrigger) ? config.recoveryTrigger : "pair-loss",
    discipline: isRailDiscipline(config.discipline) ? config.discipline : "spec",
  };

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_twinrail_${Date.now()}`,
    config: deployment,
    currentStake: deployment.stake,
    currentMarket: displayName,
    currentContractType: `${pairLabel(NORMAL_PAIR)} + ${pairLabel(RECOVERY_PAIR)}`,
    message: locked
      ? `🔒 Locked on ${displayName} — normal rail ${pairLabel(NORMAL_PAIR)}, recovery rail ${pairLabel(RECOVERY_PAIR)}.`
      : `🔀 Deployed on ${displayName} — Twin-Rail may rotate to a better measure.`,
  };
  session.watch.rttP95Ms = 400;

  logger.info({
    botId: deployment.botId,
    symbol: deployment.symbol,
    marketMode: deployment.marketMode,
    recoveryTrigger: deployment.recoveryTrigger,
    discipline: deployment.discipline,
    stake: deployment.stake,
    forced: deployment.forced === true,
  }, "Twin-Rail Sentinel session starting");
  broadcast();

  const loopSessionId = deployment.ownerSessionId ?? getBrowserSessionId();
  runWithSession(loopSessionId, () =>
    runLoop(deployment)
      .catch((err) => {
        logger.error({ err }, "Twin-Rail runLoop error");
        session.running = false;
        session.message = `⚠️ ${friendlyErrorMessage(err)}`;
        broadcast();
      })
      .finally(() => releaseTradingOwnership("bots")),
  );

  return { ok: true };
}

export function stopSession(): void {
  if (!session.running) return;
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped.";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info("Twin-Rail Sentinel stopped");
}

// ── The loop ──────────────────────────────────────────────────────────────────

async function runLoop(config: TwinRailConfig) {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely";
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
  const accountId = accounts.length > 0
    ? (accounts[0].derivAccountId ?? accounts[0].loginId)
    : "";
  const isLive = !paperTradeMode && !!token && !!accountId;
  const maxStake = settings.length > 0 ? Number((settings[0] as any).maxTradeStake) || 500 : 500;
  const botRecoveryMarkup = settings.length > 0
    ? Number((settings[0] as any).botRecoveryMarkup ?? 10)
    : 10;

  let availableBalance = accounts.length > 0 && Number(accounts[0].balance) > 0
    ? Number(accounts[0].balance)
    : Number.POSITIVE_INFINITY;

  if (isLive) {
    const live = await getLiveBalance(token!, accountId).catch(() => null);
    if (typeof live === "number" && live > 0) availableBalance = live;
  }

  const LOCKED = config.marketMode === "locked";
  const REANALYZE_MS = LOCKED ? REANALYZE_LOCKED_MS : REANALYZE_SWITCHING_MS;

  let activeSymbol = config.symbol;
  let activeName = config.displayName;
  let quotes: TwinRailQuotes = { ...TWIN_RAIL_FALLBACK_QUOTES, live: false };
  let measurement: MarketMeasurement | null = null;

  const inactive = () => !session.running || session.stopRequested ||
    !hasTradingOwnership("bots");

  try {
    while (!inactive()) {
      // ── 1. Measure (or re-measure) the active market ────────────────────────
      const stale = Date.now() - session.lastMeasuredAt > REANALYZE_MS;
      if (!measurement || stale) {
        session.watch.phase = "measuring";
        session.message = `📊 Measuring ${activeName} — both rails, live quotes, tick clock…`;
        broadcast();

        let digits: number[] = [];
        try {
          digits = await getDeepDigits(activeSymbol, SCAN_WINDOW);
        } catch { /* fall through */ }
        if (digits.length < 30) digits = tickManager.getDigits(activeSymbol, SCAN_WINDOW);

        if (digits.length < 30) {
          session.watch.gateOpen = false;
          session.watch.gateReason = "Feed is not printing digits for this market — holding fire rather than guessing.";
          session.message = `⏳ ${activeName} has no usable digit tape yet — waiting.`;
          session.watch.phase = "holding";
          broadcast();
          await sleep(4000);
          continue;
        }

        quotes = await fetchTwinRailQuotes(activeSymbol, currency);
        measurement = measureTwinRailMarket({
          symbol: activeSymbol,
          digits,
          quotes,
          stake: config.stake,
          tickTimestamps: tickTimestampsFor(activeSymbol),
        });
        session.tape = digits;
        session.conditioned = measurement.conditioned;
        session.normalEdge = measurement.normalEdge;
        session.recoveryEdge = measurement.recoveryEdge;
        session.lastMeasuredAt = Date.now();
        session.holds = 0;

        const quota = deadRailBreakEven(RECOVERY_PAIR, quotes.recovery, config.stake);
        const tollPerHour = measurement.profile.periodMs > 0
          ? measurement.normalEdge.mean * (3_600_000 / measurement.profile.periodMs)
          : 0;
        session.rail = {
          symbol: activeSymbol,
          displayName: activeName,
          normal: pairLabel(NORMAL_PAIR),
          recovery: pairLabel(RECOVERY_PAIR),
          marketMode: config.marketMode,
          trigger: config.recoveryTrigger,
          discipline: config.discipline,
          quotesLive: quotes.live,
          normalQuote: { ...quotes.normal },
          recoveryQuote: { ...quotes.recovery },
          carrierToll: measurement.normalEdge.mean,
          carrierTollPerHour: tollPerHour,
          quota,
          deadRate: measurement.tape.deadRate,
          contextualDeadRate: measurement.conditioned.deadRate,
          context: session.conditioned.context.label,
          samples: measurement.tape.samples,
          verdict: measurement.recoveryEdge.verdict,
          score: measurement.cycleEdgeLcb,
          reason: measurement.recoveryEdge.lcb > 0
            ? `Recovery gate clears by $${measurement.recoveryEdge.lcb.toFixed(4)}/round at ${(measurement.tape.deadRate * 100).toFixed(2)} % dead rail.`
            : `Recovery gate closed: dead rail ${(measurement.tape.deadRate * 100).toFixed(2)} % vs quota ${(quota * 100).toFixed(2)} %.`,
          signals: buildSignals(measurement, config.stake, pairLabel(NORMAL_PAIR)),
          forced: config.forced === true,
          conditioning: session.conditioned.context.mixing > 0
            ? `order ${session.conditioned.context.order} · ${session.conditioned.context.label} · ` +
              `${(session.conditioned.context.mixing * 100).toFixed(0)} % conditional weight`
            : "order 0 · unconditional",
          memoryNote: measurement.memory.order === 1
            ? `digit memory χ²=${measurement.memory.chi2.toFixed(1)} (p=${measurement.memory.p.toExponential(1)})`
            : `no digit memory (p=${measurement.memory.p.toFixed(3)})`,
        };
        session.currentStake = config.stake;
        session.currentMarket = activeName;
        session.currentContractType = `${pairLabel(NORMAL_PAIR)} + ${pairLabel(RECOVERY_PAIR)}`;
        broadcast();
      }

      const m = measurement!;
      const previousDigit = session.tape[session.tape.length - 1] ?? null;
      // Re-condition on the digit that just printed: this is the "next tick"
      // estimate the gate is actually being asked about.
      const conditioned = previousDigit !== null
        ? buildContextualFrequencies(session.tape, RECOVERY_PAIR, m.memory.order, previousDigit)
        : m.conditioned;
      const recoveryEdge = measurePairEdge(RECOVERY_PAIR, quotes.recovery, config.stake, conditioned, GATE_Z);
      const normalEdge = measurePairEdge(NORMAL_PAIR, quotes.normal, config.stake, m.tape, GATE_Z);
      session.conditioned = conditioned;
      session.recoveryEdge = recoveryEdge;
      session.normalEdge = normalEdge;

      // ── 2. Rotation (switching mode only) ───────────────────────────────────
      if (!LOCKED) {
        const better = await pickBetterMarket(
          activeSymbol,
          measurement,
          config.stake,
          currency,
          ownerSessionId,
        );
        if (better) {
          activeSymbol = better.symbol;
          activeName = better.displayName;
          measurement = better.measurement;
          quotes = better.measurement.quotes;
          session.tape = better.measurement.digits;
          session.lastMeasuredAt = Date.now();
          session.rail = null;
          session.message = `🔀 Rotated to ${activeName} — its measured cycle beats the incumbent.`;
          broadcast();
          continue;
        }
      }

      // ── 3. Choose the rail and evaluate the ONE gate ────────────────────────
      const inRecovery = recoveryEngine.isInRecovery() || session.decision?.recovery === true;
      const railway = inRecovery ? RECOVERY_PAIR : NORMAL_PAIR;
      const railwayLabel = pairLabel(railway);
      const legStake = inRecovery
        ? await recoveryStakeFor(config, maxStake, availableBalance, quotes.recovery, botRecoveryMarkup)
        : config.stake;

      const railEdge = inRecovery ? recoveryEdge : normalEdge;
      const cycleEdge = cycleEdgeAtRecoveryStake({
        carrierNet: normalEdge.mean,
        recoveryEdgePerStake: recoveryEdge.mean / Math.max(1e-9, config.stake),
        recoveryStake: legStake,
      });
      const cycleEdgeLcb = cycleEdgeAtRecoveryStake({
        carrierNet: normalEdge.mean,
        recoveryEdgePerStake: recoveryEdge.lcb / Math.max(1e-9, config.stake),
        recoveryStake: legStake,
      });

      const tickPeriodMs = measurement.profile.periodMs;
      const tickAgeMs = measurement.profile.samples > 0
        ? Math.max(0, (tickManager.getTickAgeSeconds(activeSymbol) || 0) * 1000)
        : 0;
      const rttP95 = session.burstRtts.length >= 5
        ? quantileSorted([...session.burstRtts].sort((a, b) => a - b), 0.95)
        : 400;
      const plan = planTwinFire({
        tickPeriodMs,
        tickAgeMs,
        rttP95Ms: rttP95,
        safetyMs: FIRE_SAFETY_MS,
      });

      // The ONE gate. The carrier's toll is a constant, so there is nothing to
      // wait for on a partition straddle under the user's rule; the recovery rail
      // — the only rail that can lose BOTH legs — must clear its lower bound.
      const forced = config.forced === true;
      const gateOpen = inRecovery
        ? recoveryEdge.lcb > 0 || forced
        : config.discipline === "spec" || cycleEdgeLcb > 0;
      const gateReason = inRecovery
        ? forced && !(recoveryEdge.lcb > 0)
          ? `Recovery FORCED — you overrode a measured edge of −$${Math.abs(recoveryEdge.lcb).toFixed(4)}/round ` +
            `against a ${(recoveryEdge.quota * 100).toFixed(2)} % quota. The tape prints ` +
            `${(conditioned.deadRate * 100).toFixed(2)} % dead rail; this round is paying the spread.`
          : recoveryEdge.lcb > 0
            ? `Recovery gate OPEN — lower bound +$${recoveryEdge.lcb.toFixed(4)}/round vs quota ${(recoveryEdge.quota * 100).toFixed(2)} % dead rail.`
            : `Recovery HELD — the tape prints ${(conditioned.deadRate * 100).toFixed(2)} % dead rail against a ` +
              `${(recoveryEdge.quota * 100).toFixed(2)} % quota; the lower bound is −$${Math.abs(recoveryEdge.lcb).toFixed(4)}/round. Not adding to the debt.`
        : config.discipline === "spec"
          ? `Carrier running (your rule) — toll $${Math.abs(normalEdge.mean).toFixed(3)}/round; the rails partition the digits, so a double loss is impossible on one tick.`
          : cycleEdgeLcb > 0
            ? `Carrier OPEN — measured cycle lower bound +$${cycleEdgeLcb.toFixed(4)}.`
            : `Carrier HELD (measured mode) — the cycle lower bound is −$${Math.abs(cycleEdgeLcb).toFixed(4)}: ` +
              `the toll plus the recovery round this tape would place does not pay.`;

      session.watch.phase = "aiming";
      session.watch.gateOpen = gateOpen;
      session.watch.gateReason = gateReason;
      session.watch.cycleLcb = cycleEdgeLcb;
      session.watch.cycleMean = cycleEdge;
      session.watch.carrierToll = normalEdge.mean;
      session.watch.railMean = railEdge.mean;
      session.watch.railLcb = railEdge.lcb;
      session.watch.tickPeriodMs = tickPeriodMs;
      session.watch.tickAgeMs = tickAgeMs;
      session.watch.headroomMs = plan.headroomMs;
      session.watch.budgetMs = rttP95 + FIRE_SAFETY_MS;
      session.watch.waitReason = plan.reason;
      session.watch.rttP95Ms = rttP95;
      session.watch.burstSamples = session.burstRtts.length;
      session.watch.holds = session.holds;
      session.watch.stakeNote = inRecovery
        ? recoveryEngine.getState().unrecoveredAmount * (1 + botRecoveryMarkup / 100) / Math.max(0.01, quotes.recovery.overPayout - 1) < 0.35
          ? `Debt $${recoveryEngine.getState().unrecoveredAmount.toFixed(2)} needs less than the $0.35 exchange minimum per leg — the recovery round bets the floor.`
          : `Recovery stake targets $${(recoveryEngine.getState().unrecoveredAmount * (1 + botRecoveryMarkup / 100)).toFixed(2)} ` +
            `(${botRecoveryMarkup}% markup on $${recoveryEngine.getState().unrecoveredAmount.toFixed(2)} debt) at ${quotes.recovery.overPayout.toFixed(2)}×.`
        : `Carrier stake $${config.stake.toFixed(2)}/leg — pair exposure $${(config.stake * 2).toFixed(2)}.`;

      const stopHit = session.totalProfit <= -Math.abs(config.stopLoss);
      const targetHit = session.totalProfit >= Math.abs(config.takeProfit);
      if (stopHit || targetHit) {
        session.running = false;
        session.message = stopHit
          ? `🛑 Stop loss hit ($${session.totalProfit.toFixed(2)}). Session stopped.`
          : `🎯 Take profit reached (+$${session.totalProfit.toFixed(2)}). Session stopped.`;
        broadcast();
        return;
      }

      if (!gateOpen) {
        session.watch.phase = "holding";
        session.holds++;
        session.watch.holds = session.holds;
        session.message = inRecovery
          ? `⏸️ Recovery held — ${gateReason}`
          : `⏸️ Carrier held — ${gateReason}`;
        broadcast();
        // A closed gate is a measurement problem, not a sleep problem: re-measure
        // sooner than the rotation interval so a real edge is not missed.
        if (session.holds >= 6) session.lastMeasuredAt = 0;
        await sleep(2500);
        continue;
      }

      if (!plan.fire) {
        session.watch.phase = "holding";
        session.message = `⏱️ ${plan.reason}`;
        session.watch.waitReason = plan.reason;
        broadcast();
        await sleep(Math.min(Math.max(40, plan.waitMs), 800));
        continue;
      }

      // ── 4. Fire both legs in ONE burst ──────────────────────────────────────
      const round = await fireRound({
        ownerSessionId,
        symbol: activeSymbol,
        displayName: activeName,
        railway,
        legStake,
        quotes,
        token: isLive ? token! : null,
        accountId,
        currency,
        isLive,
        paperTradeMode,
        plan,
      });

      if (!round) {
        // Firing never happened (or was aborted); the loop continues.
        continue;
      }

      // ── 5. Settle, verify the sync invariant, and update the shared ledger ──
      const roundNet = await settleRound({ ownerSessionId, round, railway, config });

      if (!isLive && Number.isFinite(availableBalance)) {
        availableBalance = Math.max(0, availableBalance + roundNet);
      }

      await sleep(150);
    }
  } finally {
    session.watch.phase = "holding";
    if (session.running) {
      session.running = false;
      session.message = "Session ended.";
    }
    broadcast();
  }
}

// ── Rotation ──────────────────────────────────────────────────────────────────

async function pickBetterMarket(
  incumbentSymbol: string,
  incumbent: MarketMeasurement,
  stake: number,
  currency: string,
  ownerSessionId: string,
): Promise<{ symbol: string; displayName: string; measurement: MarketMeasurement } | null> {
  const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
  progress(ownerSessionId, "rotation scan", 0, markets.length);

  let best: { symbol: string; displayName: string; measurement: MarketMeasurement; lcb: number } | null = null;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    if (market.symbol === incumbentSymbol) continue;
    progress(ownerSessionId, market.displayName, i, markets.length);
    let digits: number[] = [];
    try {
      digits = await getDeepDigits(market.symbol, SCAN_WINDOW);
    } catch { /* fall through */ }
    if (digits.length < 30) digits = tickManager.getDigits(market.symbol, SCAN_WINDOW);
    if (digits.length < 30) continue;
    const tape = estimateFrequencies(digits, RECOVERY_PAIR);
    // Cheap elimination first: a market whose dead rail is already too common
    // can never beat an incumbent that clears its quota.
    if (tape.deadRate > 0.22) continue;
    const quotes = await fetchTwinRailQuotes(market.symbol, currency);
    const measured = measureTwinRailMarket({
      symbol: market.symbol,
      digits,
      quotes,
      stake,
      tickTimestamps: tickTimestampsFor(market.symbol),
    });
    if (measured.recoveryEdge.lcb <= 0) continue;
    const lcb = measured.cycleEdgeLcb;
    if (!best || lcb > best.lcb) {
      best = { symbol: market.symbol, displayName: market.displayName, measurement: measured, lcb };
    }
    await sleep(5);
  }

  if (!best) return null;
  const incumbentLcb = incumbent.cycleEdgeLcb;
  if (best.lcb <= incumbentLcb + SWITCH_MARGIN) return null;
  return { symbol: best.symbol, displayName: best.displayName, measurement: best.measurement };
}

// ── Recovery stake ────────────────────────────────────────────────────────────

/**
 * The shared, debt-driven recovery stake — with one twin-specific rule.
 *
 * The ledger's debt is per LEG (that is what its own formula expects), while a
 * twin round puts BOTH legs on the table. So the per-leg stake is sized so that
 * the round's expected recovery covers the whole debt, and then the pair
 * exposure is clamped to the user's max stake: `maxStake` is a PAIR cap, which
 * is the number the user actually cares about.
 */
async function recoveryStakeFor(
  config: TwinRailConfig,
  maxStake: number,
  balance: number,
  quotes: PairQuote,
  markupPercent: number,
): Promise<number> {
  const payout = Math.max(1.01, Math.min(quotes.overPayout, quotes.underPayout));
  const perLeg = recoveryEngine.getBotRecoveryStake(
    config.stake,
    maxStake / 2,
    Number.isFinite(balance) ? balance / 2 : balance,
    payout,
    markupPercent,
  );
  const pairCapped = Math.min(perLeg, maxStake / 2);
  const balanceCapped = Number.isFinite(balance) ? Math.min(pairCapped, balance / 2) : pairCapped;
  return Math.max(0.35, Math.round(balanceCapped * 100) / 100);
}

// ── Firing ────────────────────────────────────────────────────────────────────

interface FiredRound {
  overContractId: number | null;
  underContractId: number | null;
  overJournalId: number | null;
  underJournalId: number | null;
  overEntry: number;
  underEntry: number;
  spec: PairSpec;
  legStake: number;
  burstMs: number;
  headroomMs: number;
  startedAt: number;
  quote: PairQuote;
  /** Paper mode only: the digit the round is settling against. */
  paperDigit: number | null;
  syncHint: SyncVerdict | null;
  error: string | null;
}

async function fireRound(input: {
  ownerSessionId: string;
  symbol: string;
  displayName: string;
  railway: PairSpec;
  legStake: number;
  quotes: TwinRailQuotes;
  token: string | null;
  accountId: string;
  currency: string;
  isLive: boolean;
  paperTradeMode: boolean;
  plan: TwinFirePlan;
}): Promise<FiredRound | null> {
  const { railway, legStake } = input;
  const quote: PairQuote = railway === NORMAL_PAIR ? input.quotes.normal : input.quotes.recovery;
  const inRecovery = railway === RECOVERY_PAIR;

  session.watch.phase = "firing";
  session.currentStake = legStake;
  session.message = `${inRecovery ? "🎯 [Recovery]" : "🎯"} ${pairLabel(railway)} on ${input.displayName} · ` +
    `$${legStake.toFixed(2)}/leg (pair $${(legStake * 2).toFixed(2)})`;
  broadcast();

  const reason =
    `[${TWIN_RAIL_BOT_NAME}${inRecovery ? " RECOVERY" : ""}] ${pairLabel(railway)} on ${input.displayName} · ` +
    `$${legStake.toFixed(2)}/leg, one unscheduled burst (both legs same tick) · ` +
    `window ${Math.round(input.plan.headroomMs)} ms for a ${Math.round(session.watch.budgetMs)} ms budget · ` +
    `toll/round $${Math.abs(session.normalEdge?.mean ?? 0).toFixed(3)}`;

  // Journal BOTH legs before firing: if the process dies mid-burst the account
  // still shows what was attempted.
  const legs = [
    { contractType: "DIGITOVER" as const, barrier: railway.over, barrierLabel: `Over ${railway.over}` },
    { contractType: "DIGITUNDER" as const, barrier: railway.under, barrierLabel: `Under ${railway.under}` },
  ];

  const journalIds: Array<number | null> = [];
  for (const leg of legs) {
    try {
      const [row] = await db.insert(tradesTable).values({
        sessionId: input.ownerSessionId,
        symbol: input.symbol,
        displayName: input.displayName,
        contractType: leg.contractType,
        barrier: leg.barrier,
        stake: String(Math.round(legStake * 100) / 100),
        direction: "hold",
        status: "open",
        aiConfidence: String(Math.max(0, Math.min(1, session.recoveryEdge?.pPositive ?? 0.5))),
        aiRiskScore: inRecovery ? "45" : "20",
        isAutonomous: true,
        agentReasoning: `${input.paperTradeMode ? "[PAPER] " : ""}${reason}`,
        duration: TWIN_RAIL_DURATION_TICKS,
        durationUnit: "t",
      }).returning();
      journalIds.push(row?.id ?? null);
    } catch (err) {
      logger.warn({ err }, "Twin-Rail: failed to journal a leg");
      journalIds.push(null);
    }
  }

  const startedAt = Date.now();
  let overContractId: number | null = null;
  let underContractId: number | null = null;
  let overEntry = tickManager.getLatestPrice(input.symbol) ?? 0;
  let underEntry = overEntry;
  let burstMs = 0;
  let error: string | null = null;
  let nakedRepairs = 0;

  if (input.isLive && input.token) {
    const params = legs.map((leg) => ({
      symbol: input.symbol,
      contractType: leg.contractType,
      stake: Math.round(legStake * 100) / 100,
      duration: TWIN_RAIL_DURATION_TICKS,
      durationUnit: "t",
      currency: input.currency,
      barrier: leg.barrier,
    }));

    try {
      const results = await executeBulkLiveTrades(input.token, input.accountId, params);
      burstMs = Date.now() - startedAt;

      const [overRes, underRes] = results;
      if (overRes && !("error" in overRes)) {
        overContractId = overRes.contractId;
        overEntry = Number(overRes.entrySpot) || overEntry;
      } else {
        error = overRes && "error" in overRes
          ? friendlyErrorMessage(overRes.error, { max: 120 })
          : "Over leg was not opened";
      }
      if (underRes && !("error" in underRes)) {
        underContractId = underRes.contractId;
        underEntry = Number(underRes.entrySpot) || underEntry;
      } else if (!error) {
        error = underRes && "error" in underRes
          ? friendlyErrorMessage(underRes.error, { max: 120 })
          : "Under leg was not opened";
      }

      // A NAKED LEG IS THE ONE THING WORSE THAN NO TRADE: one leg open, the other
      // missing, means the pair is no longer a straddle at all. Repair it by
      // firing the missing leg immediately (still inside the tick if possible),
      // and if that fails, the settle path closes the survivor.
      if (overContractId === null && underContractId !== null) {
        const repaired = await repairLeg(input, legs[0]!, legStake);
        if (repaired) { overContractId = repaired.contractId; overEntry = repaired.entrySpot; nakedRepairs++; }
      } else if (underContractId === null && overContractId !== null) {
        const repaired = await repairLeg(input, legs[1]!, legStake);
        if (repaired) { underContractId = repaired.contractId; underEntry = repaired.entrySpot; nakedRepairs++; }
      }
      if (nakedRepairs > 0) session.ledger.nakedRepairs += nakedRepairs;
    } catch (err) {
      burstMs = Date.now() - startedAt;
      error = friendlyErrorMessage(err, { max: 160 });
      logger.warn({ err }, "Twin-Rail: bulk burst failed");
    }
  } else {
    // PAPER: both legs are simulated against the next tick. The round still has
    // to be classified by the pair's own outcome pattern, so the invariant is
    // exercised in paper mode exactly as it is live.
    burstMs = Date.now() - startedAt;
  }

  if (overContractId === null && underContractId === null && error) {
    session.watch.phase = "holding";
    session.message = `🔁 Burst aborted — ${error}. Back to measuring.`;
    broadcast();
    for (const id of journalIds) {
      if (id === null) continue;
      try {
        await db.update(tradesTable).set({
          status: "error", profit: "0", payout: "0", closedAt: new Date(),
          agentReasoning: `${reason} [EXECUTION FAILED: ${error}]`,
        }).where(eq(tradesTable.id, id));
      } catch { /* best-effort */ }
    }
    await sleep(2000);
    return null;
  }

  session.ledger.lastBurstMs = burstMs;
  session.ledger.lastHeadroomMs = input.plan.headroomMs;
  if (Number.isFinite(burstMs) && burstMs > 0) {
    session.burstRtts.push(burstMs);
    if (session.burstRtts.length > RTT_WINDOW) session.burstRtts.shift();
    const sorted = [...session.burstRtts].sort((a, b) => a - b);
    session.ledger.burstP50Ms = Math.round(quantileSorted(sorted, 0.5));
    session.ledger.burstP95Ms = Math.round(quantileSorted(sorted, 0.95));
    session.watch.rttP95Ms = session.ledger.burstP95Ms;
    session.watch.burstSamples = session.burstRtts.length;
  }

  return {
    overContractId,
    underContractId,
    overJournalId: journalIds[0] ?? null,
    underJournalId: journalIds[1] ?? null,
    overEntry,
    underEntry,
    spec: railway,
    legStake,
    burstMs,
    headroomMs: input.plan.headroomMs,
    startedAt,
    quote,
    paperDigit: null,
    syncHint: null,
    error,
  };
}

async function repairLeg(
  input: { token: string | null; accountId: string; symbol: string; currency: string },
  leg: { contractType: "DIGITOVER" | "DIGITUNDER"; barrier: number },
  legStake: number,
): Promise<{ contractId: number; entrySpot: number } | null> {
  if (!input.token) return null;
  try {
    const proposal = await getContractProposal(input.token, {
      symbol: input.symbol,
      contractType: leg.contractType,
      stake: Math.round(legStake * 100) / 100,
      duration: TWIN_RAIL_DURATION_TICKS,
      durationUnit: "t",
      currency: input.currency,
      barrier: leg.barrier,
    });
    if (!proposal) return null;
    const result = await executeLiveTrade(input.token, {
      symbol: input.symbol,
      contractType: leg.contractType,
      stake: Math.round(legStake * 100) / 100,
      duration: TWIN_RAIL_DURATION_TICKS,
      durationUnit: "t",
      currency: input.currency,
      accountId: input.accountId,
      barrier: leg.barrier,
    } as any);
    return { contractId: result.contractId, entrySpot: Number(result.entrySpot) || 0 };
  } catch (err) {
    logger.warn({ err }, "Twin-Rail: naked-leg repair failed");
    return null;
  }
}

// ── Settlement ────────────────────────────────────────────────────────────────

async function settleRound(input: {
  ownerSessionId: string;
  round: FiredRound;
  railway: PairSpec;
  config: TwinRailConfig;
}): Promise<number> {
  const { round, railway, config } = input;
  session.watch.phase = "settling";
  broadcast();

  let overWon = false;
  let underWon = false;
  let overProfit = 0;
  let underProfit = 0;
  let exitSpot: number | null = null;
  let settlementError: string | null = null;

  const isLive = round.overContractId !== null || round.underContractId !== null;

  if (isLive && session.config) {
    // Live: both legs settle on the exchange. Each leg is fetched by its own
    // contract id, and the exit spot is compared across legs — the pair's own
    // evidence about whether the burst really shared one tick.
    const legs = [
      { id: round.overContractId, side: "over" as const },
      { id: round.underContractId, side: "under" as const },
    ];
    for (const leg of legs) {
      if (leg.id === null) continue;
      try {
        const token = (await liveToken(input.ownerSessionId)) ?? null;
        const accountId = await liveAccountId(input.ownerSessionId);
        if (!token || !accountId) throw new Error("Live account is no longer connected");
        const result = await waitForContractResult(token, accountId, leg.id, LEG_SETTLE_TIMEOUT_MS);
        if (leg.side === "over") {
          overWon = result.won;
          overProfit = result.profit;
          if (Number.isFinite(result.exitSpot)) exitSpot = Number(result.exitSpot);
        } else {
          underWon = result.won;
          underProfit = result.profit;
          if (Number.isFinite(result.exitSpot)) {
            exitSpot = exitSpot === null ? Number(result.exitSpot) : exitSpot;
          }
        }
      } catch (err) {
        settlementError = friendlyErrorMessage(err, { max: 120 });
        logger.warn({ err, leg }, "Twin-Rail: leg settle failed");
      }
    }
  } else {
    // Paper: settle on the NEXT tick, exactly as a 1-tick contract would.
    const symbol = session.rail?.symbol ?? config.symbol;
    const start = tickManager.getDigits(symbol, 1)[0];
    let digit: number | undefined = start;
    let waited = 0;
    while (waited < 12_000) {
      await sleep(TICK_WAIT_MS);
      waited += TICK_WAIT_MS;
      const d = tickManager.getDigits(symbol, 1)[0];
      if (d !== undefined && d !== start) { digit = d; break; }
    }
    const printed = digit ?? 0;
    round.paperDigit = printed;
    const outcome = roundOutcome(railway, round.quote, round.legStake, printed);
    overWon = outcome.overWon;
    underWon = outcome.underWon;
    overProfit = overWon ? round.legStake * (round.quote.overPayout - 1) : -round.legStake;
    underProfit = underWon ? round.legStake * (round.quote.underPayout - 1) : -round.legStake;
  }

  // ── The sync invariant. Both legs shared one tick iff exactly one won. ──────
  const sync: SyncVerdict = settlementError && !overWon && !underWon
    ? "split-tick"
    : syncVerdict(railway, overWon, underWon);
  let net = overProfit + underProfit;
  if (settlementError && !isLive) net = 0;
  if (!isLive && round.paperDigit === null) net = 0;
  net = Math.round(net * 100) / 100;

  session.tradeCount += 2;
  session.totalProfit = Math.round((session.totalProfit + net) * 100) / 100;
  const roundWon = net > 0;
  if (roundWon) {
    session.winCount++;
    session.lastResult = "won";
    session.currentLossRun = 0;
  } else {
    session.lossCount++;
    session.lastResult = "lost";
    session.currentLossRun++;
    session.deepestLossRun = Math.max(session.deepestLossRun, session.currentLossRun);
  }

  // ── The shared ledger. The debt is what the pair ACTUALLY lost (|net|), not
  // the nominal leg stake — that is what makes "recover 2 × $1" exact.
  const decision = roundLedgerDecision({
    net,
    overWon,
    underWon,
    sync,
    policy: config.recoveryTrigger,
  });
  session.decision = decision;

  const shouldRecord = config.recoveryTrigger === "pair-loss" || !overWon && !underWon;
  if (shouldRecord && session.rail) {
    const lossMagnitude = Math.max(0, -net);
    recoveryEngine.recordOutcome(
      roundWon,
      net,
      roundWon ? round.legStake : lossMagnitude,
      config.maxRecoverySteps,
      "DIGITOVER",
      Math.max(1, round.quote.overPayout),
    );
  }

  // ── Twin telemetry ─────────────────────────────────────────────────────────
  const led = session.ledger;
  led.roundCount++;
  if (!railway || railway === NORMAL_PAIR) led.cycleCount++;
  if (sync === "synced") led.syncedRounds++;
  if (sync === "dead-rail") { led.deadRailHits++; led.doubleLosses++; }
  if (sync === "split-tick") {
    led.splitRounds++;
    if (!overWon && !underWon) led.doubleLosses++;
  }
  led.syncRate = led.roundCount > 0 ? led.syncedRounds / led.roundCount : 1;
  led.lastDigit = round.paperDigit;
  led.lastSync = sync;
  led.legStake = round.legStake;
  led.pairExposure = Math.round(round.legStake * 2 * 100) / 100;

  session.message =
    `${roundWon ? "✅" : "❌"} ${pairLabel(railway)} on ${session.rail?.displayName ?? config.displayName} · ` +
    `${sync === "synced" ? "same tick" : sync === "dead-rail" ? "DEAD RAIL — both legs lost" : "SPLIT TICK — legs did not share a tick"}` +
    ` · net ${net >= 0 ? "+" : "−"}$${Math.abs(net).toFixed(2)}` +
    (round.paperDigit !== null ? ` · digit ${round.paperDigit}` : "") +
    (settlementError ? ` · ⚠️ ${settlementError}` : "");
  broadcast();

  // ── Close the journal rows ─────────────────────────────────────────────────
  const rows = [
    { id: round.overJournalId, won: overWon, profit: overProfit, entry: round.overEntry },
    { id: round.underJournalId, won: underWon, profit: underProfit, entry: round.underEntry },
  ];
  for (const row of rows) {
    if (row.id === null) continue;
    try {
      await db.update(tradesTable).set({
        status: row.won ? "won" : "lost",
        payout: String(row.won ? Math.round((round.legStake + row.profit) * 100) / 100 : 0),
        profit: String(Math.round(row.profit * 100) / 100),
        entryPrice: String(row.entry),
        exitPrice: exitSpot !== null ? String(exitSpot) : undefined,
        closedAt: new Date(),
      }).where(eq(tradesTable.id, row.id));
    } catch (err) {
      logger.warn({ err }, "Twin-Rail: failed to settle a journaled leg");
    }
  }

  return net;
}

// ── Live account helpers (re-read per settle: the loop outlives the token) ────

async function liveToken(ownerSessionId: string): Promise<string | null> {
  const rows = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, ownerSessionId),
    eq(accountsTable.isActive, true),
  )).limit(1);
  const account = rows[0];
  return account ? (account.bearerToken ?? account.token ?? null) : null;
}

async function liveAccountId(ownerSessionId: string): Promise<string> {
  const rows = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, ownerSessionId),
    eq(accountsTable.isActive, true),
  )).limit(1);
  const account = rows[0];
  return account ? (account.derivAccountId ?? account.loginId ?? "") : "";
}

// ── Exports the route layer needs ─────────────────────────────────────────────

export { NORMAL_PAIR, RECOVERY_PAIR, TWIN_RAIL_BOT_ID, TWIN_RAIL_BOT_NAME };
export { normalCdf, deadZoneDigits };
