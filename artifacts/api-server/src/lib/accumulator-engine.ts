/**
 * Accumulator bot engine — the Compounding Range Sentinel.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS BOT IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Every other bot in this app buys a contract whose odds are fixed at purchase
 * and whose outcome is a single coin. An accumulator is different in four ways
 * that change the whole problem:
 *
 *   1. There is no outcome to predict — there is a SEQUENCE of single-tick
 *      constraints (stay inside a band that re-centres on the previous spot), so
 *      the probability that matters is a per-tick survival rate that thousands of
 *      ticks can MEASURE rather than an inference from a small sample.
 *   2. The payout COMPOUNDS: value multiplies by (1+g) per surviving tick, so
 *      expected value multiplies by λ = p(1+g). Everything downstream — the entry
 *      gate, the horizon, the recovery — is a statement about λ.
 *   3. The house builds the band so that the gross game is FAIR under its own
 *      volatility model (see `lib/accumulator-analysis.ts` §2: the published R_10
 *      bands are σ_tick × the quantile of 1/(1+g), to five significant figures).
 *      The remaining tilt is small and quantified. The ONLY honest edge is a
 *      realised tick volatility materially below the band-implied one — which is
 *      measured here, tested for significance, and rejected when absent.
 *   4. The position can be SOLD at any tick after the first. That is why the
 *      recovery here is not a martingale and why a deteriorating market is
 *      exited near par instead of ridden into a 100 % loss.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LOOP
 * ─────────────────────────────────────────────────────────────────────────────
 *   SCAN      measure every (market × growth rate) into λ, its lower bound and a
 *             Kaplan–Meier survival curve; control the family-wise error with
 *             Benjamini–Hochberg; refuse everything that does not clear.
 *   DEPLOY    one ACCU with the exchange-side take-profit attached, so the target
 *             is realised by Deriv even if this process dies mid-trade.
 *   WATCH     every tick: track survival against the band, recompute the live λ,
 *             and run the SPRT + CUSUM + rolling-rate-window monitors.
 *   EXIT      target hit → the exchange closes it; premise gone while the value
 *             is still ≥ par → SELL at par (the trade a binary bot would have
 *             lost outright comes out flat); flags ≥ 5 → abandon the market.
 *   ROTATE    re-scan and move the session to whichever market now measures best.
 *   RECOVER   buy HORIZON, never stake: n* = ⌈ln(1 + D/S)/ln(1+g)⌉ at the SAME
 *             flat stake, taken only when the measured survival curve carries it.
 */

import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

import {
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  getAccumulatorProposal,
  getTickHistory,
  isAutomatedMarket,
  sellContract,
  tickManager,
  waitForContractResult,
} from "./deriv";
import { logger } from "./logger";
import { friendlyErrorMessage } from "./friendly-error";
import * as recoveryEngine from "./agents/recovery-engine";
import { createSessionScoped, getBrowserSessionId, runWithSessionId } from "./session";
import { broadcastSSE } from "./sse";
import {
  acquireTradingOwnership,
  currentTradingOwner,
  hasTradingOwnership,
  releaseTradingOwnership,
  tradingOwnerLabel,
} from "./engine-arbiter";
import { getBotDefinition } from "./bot-catalog";
import {
  ACCU_CERTAINTY,
  ACCU_GROWTH_RATES,
  ACCU_TICK_CAP_ANCHORS,
  HEALTH_WINDOW_TICKS,
  benjaminiHochberg,
  breakEvenP,
  calibrationTable,
  bandRunLengths,
  calibrateBarrier,
  calibrateTickCap,
  calibratedBarrier,
  conditionalInsideProb,
  cusumUpdate,
  effectiveBarrierRatio,
  empiricalInsideProb,
  evCurve,
  expectedRunLengthFromChain,
  freshCusum,
  freshRateWindow,
  freshSprt,
  iidSurvival,
  impliedSigmaFromBarrier,
  kaplanMeierSurvival,
  lambdaFor,
  liveExitDecision,
  modelLambda,
  optimalHorizon,
  pFromVolRatio,
  planAccumulatorRecovery,
  projectSession,
  pushRateWindow,
  rateWindowZ,
  readEdge,
  requiredVolRatio,
  realizedTickVol,
  relativeIncrements,
  sprtAlternative,
  sprtUpdate,
  tickCapFor,
  volClusteringZ,
  wilsonInterval,
  type AccumulatorRecoveryPlan,
  type CertaintyProfile,
  type CusumState,
  type EdgeReading,
  type EvCurvePoint,
  type MagnitudeChain,
  type RateWindow,
  type SprtState,
} from "./accumulator-analysis";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Ticks of history a market read needs before it may be considered at all. */
const MIN_HISTORY_TICKS = 260;
/** Ticks pulled for the survival curve / horizon estimate. */
const HISTORY_TICKS = 5000;
/** Live ticks the monitors need before they are trusted. */
const HEALTH_WARMUP_TICKS = 60;
/** Ticks between full re-scans while the session is idle between shots. */
const RESCAN_INTERVAL_TICKS = 25;
/** Bounded payout multiple used when the product's ceiling is unknown. */
const DEFAULT_PAYOUT_CAP_MULTIPLE = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AccumulatorConfig {
  ownerSessionId?: string;
  botId: string;
  growthRate: number;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  /** Per-contract take-profit handed to the exchange as a limit order. */
  contractTakeProfit: number;
  certainty: CertaintyProfile["id"];
  marketMode: "locked" | "switching";
  lockedSymbol?: string;
  recoveryAutoMode: boolean;
  maxRecoverySteps: number;
  maxHoldTicks?: number;
}

export interface AccumulatorCandidate {
  symbol: string;
  displayName: string;
  growthRate: number;
  verdict: EdgeReading["verdict"];
  edge: EdgeReading;
  optimalTicks: number;
  optimalEvMultiple: number;
  optimalEvLower: number;
  survivalAtHorizon: number;
  barrierRatio: number;
  barrierPrice: number | null;
  maxTicks: number;
  sigmaModel: number;
  sigmaReal: number;
  markovHitProb: number[];
  markovSpreadZ: number;
  markovRunLength: number;
  clusteringZ: number;
  reason: string;
  score: number;
}

export interface AccumulatorScanResult {
  suitable: boolean;
  best: AccumulatorCandidate | null;
  allScored: AccumulatorCandidate[];
  reason: string;
  hypotheses: number;
  fdrThreshold: number;
  certified: number;
}

export interface AccumulatorLiveMonitor {
  ticksSurvived: number;
  inBand: boolean;
  currentValue: number;
  profit: number;
  lambdaLive: number;
  lambdaLowerLive: number;
  flags: number;
  sprt: SprtState["decision"];
  cusum: number;
  rateZ: number;
  lastDecision: string;
  lastReason: string;
}

export interface AccumulatorExplain {
  symbol: string;
  displayName: string;
  growthRate: number;
  barrierRatio: number;
  barrierCalibrated: boolean;
  breakEvenSurvival: number;
  empiricalSurvival: number;
  lambda: number;
  lambdaLower: number;
  sigmaModel: number;
  sigmaReal: number;
  volRatio: number;
  requiredVolRatio: number;
  optimalTicks: number;
  payoutMultiple: number;
  evMultiple: number;
  evLower: number;
  markovRunLength: number;
  clusteringZ: number;
  verdict: EdgeReading["verdict"];
  reason: string;
  maxTicks: number;
  curve: Array<{ ticks: number; payoutMultiple: number; survival: number; ev: number }>;
  iid: Array<{ ticks: number; survival: number }>;
}

export interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: AccumulatorConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  bailOutCount: number;
  rotationCount: number;
  currentStake: number;
  currentSymbol?: string;
  currentMarket?: string;
  currentValue?: number;
  currentProfit?: number;
  ticksSurvived?: number;
  targetTicks?: number;
  /**
   * Kept to the shared bot-status vocabulary on purpose. An accumulator has a
   * third outcome — sold out of a position at its live value — and the honest
   * mapping for a status field every other page reads is: a bail-out that came
   * out at or above the stake is a win, one below is a loss. The bail-out itself
   * is counted separately in `bailOutCount` and explained in `monitor`.
   */
  lastResult?: "won" | "lost";
  message?: string;
  candidates: AccumulatorCandidate[];
  scan: AccumulatorScanResult | null;
  monitor: AccumulatorLiveMonitor | null;
  rotations: Array<{ from: string; to: string; at: number; reason: string }>;
  recoveryPlan: AccumulatorRecoveryPlan | null;
  recoveryStep: number;
  unrecoveredAmount: number;
  inRecovery: boolean;
  stopRequested: boolean;
}

function freshState(): SessionState {
  return {
    running: false,
    sessionId: null,
    config: null,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    bailOutCount: 0,
    rotationCount: 0,
    currentStake: 0,
    candidates: [],
    scan: null,
    monitor: null,
    rotations: [],
    recoveryPlan: null,
    recoveryStep: 0,
    unrecoveredAmount: 0,
    inRecovery: false,
    stopRequested: false,
  };
}

// One accumulator session per browser session — the same isolation every other
// engine uses (see lib/session.ts).
const sessionStore = createSessionScoped<SessionState>(() => freshState());
const session = sessionStore.state;

function broadcast(): void {
  const owner = session.config?.ownerSessionId;
  if (!owner) return;
  broadcastSSE("accumulator_update", getAccumulatorStatus(), owner);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a market
// ─────────────────────────────────────────────────────────────────────────────

function displayNameFor(symbol: string): string {
  return AUTOMATED_DERIV_MARKETS.find((m) => m.symbol === symbol)?.displayName ?? symbol;
}

interface MarketRead {
  symbol: string;
  increments: number[];
  barrierRatio: number;
  barrierCalibrated: boolean;
  barrierPrice: number | null;
  spot: number;
  /** Unused today: the ACCU proposal carries no per-tick schedule. */
  payoutSchedule: number[] | null;
}

/**
 * Read one market for one growth rate.
 *
 * The barrier is the hinge of the whole analysis, so it is obtained the honest
 * way: ask the exchange for a live proposal and read its high/low barriers. Only
 * when the exchange cannot be reached does the model
 * (`σ_tick(symbol)·bandZ(g)`, which reproduces Deriv's published figures) stand
 * in — and the reading is then labelled un-calibrated so the UI can say so.
 */
async function readMarket(
  symbol: string,
  growthRate: number,
  stake: number,
  currency = "USD",
  options: { calibrate?: boolean } = {},
): Promise<MarketRead | null> {
  const prices = await getTickHistory(symbol, HISTORY_TICKS);
  if (prices.length < MIN_HISTORY_TICKS) return null;

  const increments = relativeIncrements(prices);
  const spot = prices[prices.length - 1] ?? 0;

  const modelled = effectiveBarrierRatio(symbol, growthRate);
  let barrierRatio = modelled.ratio;
  let barrierCalibrated = modelled.calibrated;
  let barrierPrice: number | null = spot > 0 ? spot * barrierRatio : null;

  // Ask the exchange for the real band — but ONLY when asked to.
  //
  // A scan reads 19 markets, and quoting every one of them costs a round trip
  // each (measured at up to 10 s each when the quote cannot be served, which
  // turned a scan into a three-minute request). The model already reproduces the
  // published bands to 0.002 %, so the scan runs on the model and the quote is
  // fetched ONCE, for the market that is about to be traded — where ground truth
  // really matters, because it is the number the knockout is measured against.
  if (options.calibrate && calibratedBarrier(symbol, growthRate) === null) {
    const proposal = await getAccumulatorProposal({
      symbol,
      stake,
      currency,
      growthRate,
      durationTicks: tickCapFor(growthRate),
    });
    if (proposal && proposal.barrierRatio !== null && proposal.barrierRatio > 0) {
      barrierRatio = proposal.barrierRatio;
      barrierCalibrated = true;
      barrierPrice = proposal.highBarrier !== null && spot > 0
        ? Math.abs(proposal.highBarrier - spot)
        : proposal.barrierRatio * spot;
      calibrateBarrier(symbol, growthRate, proposal.barrierRatio);
      calibrateTickCap(growthRate, tickCapFor(growthRate));
    }
  }

  return { symbol, increments, barrierRatio, barrierCalibrated, barrierPrice, spot, payoutSchedule: null };
}

function effectiveMaxTicks(growthRate: number, override?: number | null): number {
  return tickCapFor(growthRate, override ?? null);
}

/**
 * Score one (market, growth rate): the measured edge, the survival curve, and
 * the horizon where the CONSERVATIVE expected value peaks.
 */
async function scoreMarket(params: {
  symbol: string;
  growthRate: number;
  stake: number;
  profile: CertaintyProfile;
  maxTicksOverride?: number | null;
  currency?: string;
  calibrate?: boolean;
}): Promise<AccumulatorCandidate | null> {
  const { symbol, growthRate, stake, profile } = params;
  const read = await readMarket(symbol, growthRate, stake, params.currency ?? "USD", {
    calibrate: params.calibrate ?? false,
  });
  if (!read) return null;

  const maxTicks = effectiveMaxTicks(growthRate, params.maxTicksOverride);
  const edge = readEdge({
    symbol,
    growthRate,
    increments: read.increments,
    barrierRatio: read.barrierRatio,
    barrierCalibrated: read.barrierCalibrated,
    profile,
    maxTicks,
  });
  if (!edge) return null;

  const runs = bandRunLengths(read.increments, read.barrierRatio, maxTicks);
  const survival = kaplanMeierSurvival(runs.lengths, maxTicks);
  const iid = iidSurvival(edge.p, maxTicks);
  const iidLower = iidSurvival(wilsonInterval(
    Math.round(edge.p * edge.samples),
    edge.samples,
    1.281552, // 80 % one-sided lower bound — used only as an EV floor
  ).lower, maxTicks);

  const curve = evCurve({
    survival,
    survivalLower: iidLower,
    growthRate,
    maxTicks,
    payoutCapMultiple: Math.min(
      DEFAULT_PAYOUT_CAP_MULTIPLE,
      Math.pow(1 + growthRate, maxTicks),
    ),
  });
  const best = optimalHorizon(curve, profile.minSurvivalLower);

  const markov = conditionalInsideProb(read.increments, read.barrierRatio);
  const markovRunLength = expectedRunLengthFromChain(markov.chain);

  // The horizon has to be worth holding at the PESSIMISTIC end of the
  // measurement, not merely break even there: compounding turns a small
  // survival bias into a large payout error, so each profile sets a floor on
  // the lower-bound EV it will deploy.
  const certifiesEdge = edge.verdict === "CERTIFIED";
  const meetsEvFloor = best.evLower >= profile.minEvLower;
  const hasHorizon = best.ticks > 0;
  const verdict: EdgeReading["verdict"] = certifiesEdge && (!meetsEvFloor || !hasHorizon) ? "QUALIFIED" : edge.verdict;
  const reason = certifiesEdge && !hasHorizon
    ? `${edge.reason} — but no horizon keeps survival above the ${(profile.minSurvivalLower * 100).toFixed(0)} % floor this ` +
      `profile requires, so there is nothing to hold.`
    : certifiesEdge && !meetsEvFloor
      ? `${edge.reason} — but the conservative EV at the ${best.ticks}-tick horizon is only ` +
        `${(best.evLower * 100).toFixed(2)} %, under the ${(profile.minEvLower * 100).toFixed(1)} % this profile requires.`
      : edge.reason;
  return {
    symbol,
    displayName: displayNameFor(symbol),
    growthRate,
    verdict,
    edge,
    optimalTicks: best.ticks,
    optimalEvMultiple: best.payoutMultiple,
    optimalEvLower: best.evLower,
    survivalAtHorizon: best.survival,
    barrierRatio: read.barrierRatio,
    barrierPrice: read.barrierPrice,
    maxTicks,
    sigmaModel: edge.sigmaModel,
    sigmaReal: edge.sigmaReal,
    markovHitProb: edge.markovHitProb,
    markovSpreadZ: edge.markovSpreadZ,
    markovRunLength,
    clusteringZ: edge.clusteringZ,
    reason,
    // Rank by the conservative EV the horizon actually delivers, then by λ's
    // lower bound — never by the point estimate, which is how a scan fools you.
    score: verdict === "CERTIFIED" ? best.evLower * 1000 + (edge.lambdaLower - 1) * 100 : -1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan
// ─────────────────────────────────────────────────────────────────────────────

export async function scanAccumulators(params: {
  growthRates?: number[];
  symbols?: string[];
  stake?: number;
  certainty?: CertaintyProfile["id"];
}): Promise<AccumulatorScanResult> {
  const growthRates = (params.growthRates ?? [...ACCU_GROWTH_RATES]).filter((g) =>
    (ACCU_GROWTH_RATES as readonly number[]).includes(g),
  );
  const symbols = params.symbols ?? AUTOMATED_DERIV_MARKETS.map((m) => m.symbol);
  const stake = params.stake && params.stake > 0 ? params.stake : 1;
  const profile = ACCU_CERTAINTY[params.certainty ?? "strict"] ?? ACCU_CERTAINTY.strict;

  const scored: Array<AccumulatorCandidate | null> = [];
  for (const symbol of symbols) {
    for (const growthRate of growthRates) {
      try {
        scored.push(await scoreMarket({ symbol, growthRate, stake, profile }));
      } catch (err) {
        logger.debug({ err, symbol, growthRate }, "Accumulator scan: market read failed");
        scored.push(null);
      }
    }
  }

  const measured = scored.filter((c): c is AccumulatorCandidate => c !== null);

  // Multiple testing: scanning 19 markets × 5 growth rates and keeping the best
  // λ manufactures an edge out of noise unless the family is controlled.
  const pValues = measured.map((c) => oneSidedPValue(c.edge.zBreakEven));
  const { discoveries, threshold } = benjaminiHochberg(pValues, profile.fdr);
  const survivorSet = new Set(discoveries.map((i) => measured[i]!.symbol + "|" + measured[i]!.growthRate));

  const certified = measured.filter(
    (c) => c.verdict === "CERTIFIED" && survivorSet.has(c.symbol + "|" + c.growthRate),
  );
  const ranked = [...measured].sort((a, b) => b.score - a.score);
  const best = certified.sort((a, b) => b.score - a.score)[0] ?? null;

  const reason = best
    ? `${best.displayName} @ ${(best.growthRate * 100).toFixed(0)} % growth: λ ${best.edge.lambda.toFixed(5)} ` +
      `(lower ${best.edge.lambdaLower.toFixed(5)}) with realised σ ${best.edge.sigmaReal.toExponential(3)} against a band-implied ` +
      `${best.edge.sigmaModel.toExponential(3)} (k = ${best.edge.volRatio.toFixed(4)}). Best conservative horizon ` +
      `${best.optimalTicks} ticks at ${best.optimalEvMultiple.toFixed(4)}× payout.`
    : `No market currently clears break-even with significance (${measured.length} measured, 0 certified). ` +
      `The bot holds fire rather than trade a band that is fair by construction.`;

  return {
    suitable: best !== null,
    best,
    allScored: ranked,
    reason,
    hypotheses: measured.length,
    fdrThreshold: threshold,
    certified: certified.length,
  };
}

/** One-sided p for a z (normal approximation; n ≥ 100 in every caller). */
function oneSidedPValue(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (1.330274429 * t ** 4 - 1.821255978 * t ** 3 + 1.781477937 * t * t - 0.356563782 * t + 0.319381530);
  const cdf = z >= 0 ? 1 - p : p;
  return Math.max(1e-12, 1 - cdf);
}

// ─────────────────────────────────────────────────────────────────────────────
// Explain — "show me the maths" for one market
// ─────────────────────────────────────────────────────────────────────────────

export async function explainAccumulator(params: {
  symbol: string;
  growthRate: number;
  stake?: number;
  certainty?: CertaintyProfile["id"];
}): Promise<AccumulatorExplain | null> {
  const profile = ACCU_CERTAINTY[params.certainty ?? "strict"] ?? ACCU_CERTAINTY.strict;
  const stake = params.stake && params.stake > 0 ? params.stake : 1;
  const read = await readMarket(params.symbol, params.growthRate, stake, "USD", { calibrate: true });
  if (!read) return null;

  const maxTicks = effectiveMaxTicks(params.growthRate);
  const edge = readEdge({
    symbol: params.symbol,
    growthRate: params.growthRate,
    increments: read.increments,
    barrierRatio: read.barrierRatio,
    barrierCalibrated: read.barrierCalibrated,
    profile,
    maxTicks,
  });
  if (!edge) return null;

  const runs = bandRunLengths(read.increments, read.barrierRatio, maxTicks);
  const survival = kaplanMeierSurvival(runs.lengths, maxTicks);
  const iid = iidSurvival(edge.p, maxTicks);
  const wilson = wilsonInterval(Math.round(edge.p * edge.samples), edge.samples, 1.281552);
  const iidLower = iidSurvival(wilson.lower, maxTicks);

  const curve = evCurve({
    survival,
    survivalLower: iidLower,
    growthRate: params.growthRate,
    maxTicks,
  });
  const best = optimalHorizon(curve, profile.minSurvivalLower);
  const markov = conditionalInsideProb(read.increments, read.barrierRatio);

  return {
    symbol: params.symbol,
    displayName: displayNameFor(params.symbol),
    growthRate: params.growthRate,
    barrierRatio: read.barrierRatio,
    barrierCalibrated: read.barrierCalibrated,
    breakEvenSurvival: breakEvenP(params.growthRate),
    empiricalSurvival: edge.p,
    lambda: edge.lambda,
    lambdaLower: edge.lambdaLower,
    sigmaModel: edge.sigmaModel,
    sigmaReal: edge.sigmaReal,
    volRatio: edge.volRatio,
    requiredVolRatio: requiredVolRatio(params.growthRate),
    optimalTicks: best.ticks,
    payoutMultiple: best.payoutMultiple,
    evMultiple: 1 + best.ev,
    evLower: best.evLower,
    markovRunLength: expectedRunLengthFromChain(markov.chain),
    clusteringZ: volClusteringZ(read.increments),
    verdict: edge.verdict,
    reason: edge.reason,
    maxTicks,
    // Sampled: the UI draws a chart, it does not need 230 rows.
    curve: sampleCurve(curve),
    iid: sampleCurve(curve).map((p, i) => ({ ticks: p.ticks, survival: iid[p.ticks] ?? 0 })).filter((_, i) => i % 1 === 0),
  };
}

function sampleCurve(curve: EvCurvePoint[]): Array<{ ticks: number; payoutMultiple: number; survival: number; ev: number }> {
  const max = curve.length - 1;
  if (max <= 0) return [];
  const step = Math.max(1, Math.ceil(max / 24));
  const out = curve
    .filter((p) => p.ticks % step === 0)
    .map((p) => ({ ticks: p.ticks, payoutMultiple: p.payoutMultiple, survival: p.survival, ev: p.ev }));
  const last = curve[max]!;
  if (out[out.length - 1]?.ticks !== last.ticks) {
    out.push({ ticks: last.ticks, payoutMultiple: last.payoutMultiple, survival: last.survival, ev: last.ev });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | undefined {
  return session.config?.ownerSessionId;
}

export function isAccumulatorRunning(): boolean {
  return session.running;
}

export function getAccumulatorStatus(): SessionState {
  return { ...session };
}

export async function startAccumulatorSession(config: AccumulatorConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "An accumulator session is already running." };

  const definition = getBotDefinition(config.botId);
  if (!definition || definition.family !== "accumulator") {
    return { ok: false, error: `Unknown accumulator bot: ${config.botId}` };
  }
  if (!(ACCU_GROWTH_RATES as readonly number[]).includes(config.growthRate)) {
    return {
      ok: false,
      error: `Growth rate must be one of ${ACCU_GROWTH_RATES.map((g) => `${g * 100} %`).join(", ")}`,
    };
  }
  if (!(config.stake > 0)) return { ok: false, error: "Stake must be greater than zero." };
  if (config.marketMode === "locked" && !config.lockedSymbol) {
    return { ok: false, error: "A locked market must be chosen before deploying in locked mode." };
  }
  if (config.lockedSymbol && !isAutomatedMarket(config.lockedSymbol)) {
    return { ok: false, error: `${config.lockedSymbol} is not available to the accumulator bot.` };
  }
  // Claim the account's single execution lock. Every engine acquires it in its
  // own start path; this one must too, or a bot that can only ever be RUN once
  // somebody else already holds the lock could never be started at all.
  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return {
      ok: false,
      error: `The ${owner ? tradingOwnerLabel(owner) : "other engine"} is currently trading this account. One shared recovery ledger means one trading engine at a time.`,
    };
  }

  sessionStore.replace({ ...freshState(), running: true, sessionId: `accu_${Date.now()}`, config });
  session.message = "Measuring markets…";
  session.currentStake = config.stake;
  if (config.ownerSessionId) recoveryEngine.setPersistenceSession(config.ownerSessionId);
  refreshRecoveryView(config);
  broadcast();

  logger.info(
    { growthRate: config.growthRate, stake: config.stake, mode: config.marketMode, certainty: config.certainty },
    "Accumulator session starting",
  );

  // The loop outlives the request that started it, so it must carry the browser
  // session with it — otherwise every status write inside the loop would land in
  // the shared "legacy" bucket (see lib/session.ts).
  const loopSessionId = config.ownerSessionId ?? getBrowserSessionId();
  runWithSessionId(loopSessionId, () =>
    runLoop(config).catch((err) => {
      logger.error({ err }, "Accumulator loop crashed");
      session.running = false;
      session.message = `Session crashed: ${friendlyErrorMessage(err, { max: 200 })}`;
      releaseTradingOwnership("bots");
      broadcast();
    }),
  );
  return { ok: true };
}

export function stopAccumulatorSession(): void {
  session.stopRequested = true;
  session.running = false;
  session.message = "Stop requested — closing cleanly.";
  releaseTradingOwnership("bots");
  broadcast();
}

async function loadAccount(ownerSessionId: string) {
  let rows = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.sessionId, ownerSessionId), eq(accountsTable.isActive, true)))
    .limit(1);
  if (rows.length === 0) {
    rows = await db.select().from(accountsTable).where(eq(accountsTable.sessionId, ownerSessionId)).limit(1);
  }
  return rows[0] ?? null;
}

function refreshRecoveryView(config: AccumulatorConfig): void {
  const state = recoveryEngine.getState();
  session.inRecovery = recoveryEngine.isInRecovery();
  session.recoveryStep = state.recoveryStep ?? 0;
  session.unrecoveredAmount = state.unrecoveredAmount ?? 0;
  void config;
}

// ─────────────────────────────────────────────────────────────────────────────
// The loop
// ─────────────────────────────────────────────────────────────────────────────

async function runLoop(config: AccumulatorConfig) {
  const ownerSessionId = config.ownerSessionId;
  const botName = getBotDefinition(config.botId)?.name ?? config.botId;

  if (!ownerSessionId) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely.";
    releaseTradingOwnership("bots");
    broadcast();
    return;
  }

  const account = await loadAccount(ownerSessionId);
  const token = (account as { derivToken?: string } | null)?.derivToken ?? null;
  const accountId = account?.derivAccountId ?? account?.loginId ?? null;
  const currency = account?.currency ?? "USD";
  const isLive = Boolean(token && accountId);
  const profile = ACCU_CERTAINTY[config.certainty] ?? ACCU_CERTAINTY.strict;

  let activeSymbol = config.marketMode === "locked" ? config.lockedSymbol! : null;
  let consecutiveLosses = 0;
  let ticksSinceScan = RESCAN_INTERVAL_TICKS;

  while (session.running && !session.stopRequested) {
    try {
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false;
        session.message = `⛔ Session stopped — the ${owner ? tradingOwnerLabel(owner) : "other engine"} is now trading this account.`;
        broadcast();
        return;
      }

      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) {
        session.message = "Stabilising tick feed — syncing markets…";
        broadcast();
        await sleep(1500);
        continue;
      }

      // ── 1. Choose the market ───────────────────────────────────────────────
      if (!activeSymbol || ticksSinceScan >= RESCAN_INTERVAL_TICKS) {
        session.message = `Measuring ${config.marketMode === "locked" ? "" : "every "}market${
          config.marketMode === "locked" ? "" : "s"
        } at ${(config.growthRate * 100).toFixed(0)} % growth…`;
        broadcast();

        const scan = await scanAccumulators({
          growthRates: [config.growthRate],
          symbols: activeSymbol ? [activeSymbol] : undefined,
          stake: config.stake,
          certainty: config.certainty,
        });
        session.scan = scan;
        session.candidates = scan.allScored;
        ticksSinceScan = 0;

        const chosen = scan.best;
        if (!chosen) {
          activeSymbol = null;
          session.message = config.marketMode === "locked"
            ? `🔍 ${scan.reason} Holding fire on the locked market until it measures up.`
            : `🔍 ${scan.reason} Re-measuring every ${RESCAN_INTERVAL_TICKS} ticks.`;
          broadcast();
          await sleep(2500);
          continue;
        }

        if (activeSymbol && chosen.symbol !== activeSymbol) {
          session.rotations.push({
            from: displayNameFor(activeSymbol),
            to: chosen.displayName,
            at: Date.now(),
            reason: `Locked market ${displayNameFor(activeSymbol)} stopped clearing the gate; ${chosen.displayName} now measures λ ${chosen.edge.lambda.toFixed(5)}.`,
          });
          session.rotationCount += 1;
        }
        activeSymbol = chosen.symbol;
        session.currentSymbol = chosen.symbol;
        session.currentMarket = chosen.displayName;
        session.message = `🎯 ${chosen.displayName} @ ${(config.growthRate * 100).toFixed(0)} % — ${chosen.reason}`;
        broadcast();
      }

      let candidate = session.candidates.find((c) => c.symbol === activeSymbol);
      if (!candidate || candidate.verdict !== "CERTIFIED") {
        await sleep(2000);
        continue;
      }
      // Ground truth for the contract about to be opened: one quote, for the one
      // market that matters. If it disagrees with the model materially the
      // candidate is re-scored rather than traded on a model band.
      if (!candidate.edge.barrierCalibrated) {
        const fresh = await scoreMarket({
          symbol: candidate.symbol,
          growthRate: config.growthRate,
          stake: config.stake,
          profile,
          maxTicksOverride: config.maxHoldTicks ?? null,
          currency,
          calibrate: true,
        });
        if (fresh) {
          const idx = session.candidates.findIndex((c) => c.symbol === fresh.symbol);
          if (idx >= 0) session.candidates[idx] = fresh;
          candidate = fresh;
        }
        if (candidate.verdict !== "CERTIFIED") {
          session.message = `⚠️ ${candidate.displayName} no longer certifies on the exchange's own barrier — holding fire.`;
          broadcast();
          ticksSinceScan = RESCAN_INTERVAL_TICKS;
          await sleep(1500);
          continue;
        }
      }

      // ── 2. Stake: flat, always. Recovery buys horizon, not size. ───────────
      refreshRecoveryView(config);
      const recovery = session.inRecovery
        ? planAccumulatorRecovery({
            stake: config.stake,
            debt: Math.max(0, session.unrecoveredAmount),
            growthRate: config.growthRate,
            survival: iidSurvival(candidate.edge.p, candidate.maxTicks),
            survivalLower: iidSurvival(candidate.edge.pHatLower, candidate.maxTicks),
            maxTicks: candidate.maxTicks,
            profile,
          })
        : null;
      if (recovery) session.recoveryPlan = recovery;

      if (recovery && !recovery.viable) {
        session.message = `⚠️ Recovery declined: ${recovery.reason}`;
        broadcast();
        if (recovery.abandoned || session.recoveryStep >= config.maxRecoverySteps) {
          // The debt cannot be bought back with time on this market: stand down
          // rather than escalate the stake (the one move that is provably worse).
          session.message = `🛑 ${recovery.reason} Session standing down instead of escalating stake.`;
          broadcast();
          break;
        }
        await sleep(2000);
        continue;
      }

      const stake = config.stake;
      const horizon = Math.max(1, Math.min(
        config.maxHoldTicks && config.maxHoldTicks > 0 ? config.maxHoldTicks : candidate.optimalTicks || 1,
        candidate.maxTicks,
      ));
      session.currentStake = stake;
      session.targetTicks = horizon;

      // ── 3. Open ────────────────────────────────────────────────────────────
      const barrierNote = candidate.barrierPrice !== null
        ? `±${(candidate.barrierRatio * 100).toFixed(6)} % (±${candidate.barrierPrice.toFixed(5)} at spot)`
        : `±${(candidate.barrierRatio * 100).toFixed(6)} %`;
      const contractTakeProfit = config.contractTakeProfit > 0
        ? config.contractTakeProfit
        : Math.max(0.01, Math.round(stake * (Math.pow(1 + config.growthRate, horizon) - 1) * 100) / 100);
      const reason =
        `${session.inRecovery ? `[RECOVERY] ` : ""}${candidate.reason} — barrier ${barrierNote}, ` +
        `hold ${horizon} ticks, take-profit $${contractTakeProfit.toFixed(2)}`;

      session.message = `▶️ Opening ${candidate.displayName} — hold ${horizon} ticks`;
      broadcast();

      const [journalRow] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: candidate.symbol,
        displayName: candidate.displayName,
        contractType: "ACCU",
        // The trades.barrier column is an integer; for ACCU it carries the band
        // half-width in units of 1e−8 of spot (0.00004 → 4142), which keeps the
        // contract's defining number on the journal row without a schema change.
        barrier: Number.isFinite(candidate.barrierRatio) ? Math.round(candidate.barrierRatio * 1e8) : null,
        stake: String(Math.round(stake * 100) / 100),
        direction: `range ${(candidate.barrierRatio * 100).toFixed(6)}%`,
        status: "open",
        aiConfidence: String(Math.round(Math.min(99, Math.max(0, candidate.edge.pHatLower * 100)))),
        aiRiskScore: String(Math.round(Math.min(99, Math.max(1, (1 - candidate.edge.pHatLower) * 100)))),
        isAutonomous: true,
        agentReasoning: `${isLive ? "" : "[PAPER] "}${reason}`,
        duration: horizon,
        durationUnit: "t",
      }).returning();

      const entrySpot = tickManager.getLatestPrice(candidate.symbol) ?? 0;
      let contractId: number | null = null;
      let buyPrice = stake;
      if (isLive) {
        try {
          const live = await executeLiveTrade(token!, {
            symbol: candidate.symbol,
            contractType: "ACCU",
            stake: Math.round(stake * 100) / 100,
            duration: horizon,
            durationUnit: "t",
            currency,
            accountId: accountId!,
            growthRate: config.growthRate,
            takeProfit: contractTakeProfit,
          });
          contractId = live.contractId;
          buyPrice = live.buyPrice;
        } catch (err) {
          logger.warn({ err, symbol: candidate.symbol }, "Accumulator buy failed");
          await db.update(tradesTable).set({
            status: "error",
            profit: "0",
            payout: "0",
            closedAt: new Date(),
            agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
          }).where(eq(tradesTable.id, journalRow!.id));
          session.message = `🔁 Buy failed — ${friendlyErrorMessage(err)}`;
          broadcast();
          await sleep(1500);
          continue;
        }
      }

      // ── 4. Watch every tick ────────────────────────────────────────────────
      const outcome = await watchContract({
        symbol: candidate.symbol,
        growthRate: config.growthRate,
        barrierRatio: candidate.barrierRatio,
        stake,
        horizon,
        maxTicks: candidate.maxTicks,
        p0: candidate.edge.p,
        isLive,
        token,
        accountId,
        contractId,
        entrySpot,
        rotationCandidateAvailable: session.rotationCount === 0 || session.candidates.some(
          (c) => c.symbol !== candidate.symbol && c.verdict === "CERTIFIED",
        ),
      });

      const profit = outcome.profit;
      session.totalProfit += profit;
      session.tradeCount += 1;
      session.lastResult = outcome.result === "lost" ? "lost" : profit >= 0 ? "won" : "lost";
      if (outcome.result === "lost") session.lossCount += 1;
      else if (outcome.result === "won") session.winCount += 1;
      else session.bailOutCount += 1;

      await db.update(tradesTable).set({
        status: outcome.result === "lost" ? "lost" : "won",
        payout: String(Math.round((stake + profit) * 100) / 100),
        profit: String(Math.round(profit * 100) / 100),
        entryPrice: String(entrySpot),
        exitPrice: String(outcome.exitSpot),
        closedAt: new Date(),
        agentReasoning: `${reason} [${outcome.note}]`,
      }).where(eq(tradesTable.id, journalRow!.id));

      if (config.recoveryAutoMode) {
        const won = outcome.result !== "lost";
        // The shared ledger is told what the trade actually returned; for an
        // accumulator that is the compounded value, never a fixed payout ratio.
        recoveryEngine.recordOutcome(
          won,
          profit,
          stake,
          config.maxRecoverySteps,
          "ACCU",
          Math.max(1, (stake + profit) / stake),
        );
      }
      refreshRecoveryView(config);

      consecutiveLosses = outcome.result === "lost" ? consecutiveLosses + 1 : 0;

      session.message = outcome.result === "won"
        ? `✅ ${candidate.displayName} +$${profit.toFixed(2)} after ${outcome.ticks} ticks (${outcome.note})`
        : outcome.result === "bailed"
          ? `🎯 ${candidate.displayName} exited flat ($${profit.toFixed(2)}) after ${outcome.ticks} ticks — ${outcome.note}`
          : `🛑 ${candidate.displayName} knocked out after ${outcome.ticks} ticks — stake lost (${outcome.note})`;
      broadcast();

      // ── 5. Targets / market rotation ───────────────────────────────────────
      if (session.totalProfit >= config.takeProfit) {
        session.message = `🏁 Take profit reached (+$${session.totalProfit.toFixed(2)}). Session complete.`;
        broadcast();
        break;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.message = `🛑 Stop loss reached (-$${Math.abs(session.totalProfit).toFixed(2)}). Session complete.`;
        broadcast();
        break;
      }

      if (outcome.action === "abandon_market") {
        if (config.marketMode === "locked") {
          session.message = "⚠️ Market unhealthy but the session is LOCKED to it — standing down rather than rotating.";
          broadcast();
          // A locked session that will not leave keeps the lock but stops
          // opening new positions until the market measures up again.
          await sleep(3000);
          ticksSinceScan = RESCAN_INTERVAL_TICKS;
          continue;
        }
        const previous = candidate.displayName;
        activeSymbol = null; // forces a full re-scan on the next pass
        ticksSinceScan = RESCAN_INTERVAL_TICKS;
        session.rotations.push({
          from: previous,
          to: "re-scanning",
          at: Date.now(),
          reason: outcome.note,
        });
        session.rotationCount += 1;
        session.message = `🔁 Rotating off ${previous}: ${outcome.note}`;
        broadcast();
      }

      await sleep(1200);
    } catch (err) {
      logger.error({ err }, "Accumulator loop error");
      session.message = `Recovering from an error: ${friendlyErrorMessage(err, { max: 200 })}`;
      broadcast();
      await sleep(2500);
    }
  }

  session.running = false;
  session.stopRequested = false;
  releaseTradingOwnership("bots");
  if (!session.message?.startsWith("🏁") && !session.message?.startsWith("🛑")) {
    session.message = "Session stopped.";
  }
  broadcast();
}

// ─────────────────────────────────────────────────────────────────────────────
// Watching one contract
// ─────────────────────────────────────────────────────────────────────────────

interface WatchResult {
  result: "won" | "lost" | "bailed";
  profit: number;
  ticks: number;
  exitSpot: number;
  note: string;
  action: "hold" | "sell_target" | "sell_defensive" | "abandon_market";
}

/**
 * Follow one ACCU contract tick by tick.
 *
 * Two things are happening at once here, and keeping them separate is what makes
 * the exit policy sound:
 *
 *   · SURVIVAL — has the tick stayed inside the band the contract is built on?
 *     One breach means the stake is gone, so this is tracked against the same
 *     barrier ratio the contract was priced from.
 *   · VALUE — the stake compounds while it survives, and the position can be
 *     sold at that value on any tick. The value is what makes a defensive exit
 *     possible at all.
 *
 * The exchange-side `take_profit` limit order protects the target independently
 * of this loop; everything below protects the DOWNSIDE, which only this process
 * can do.
 */
async function watchContract(params: {
  symbol: string;
  growthRate: number;
  barrierRatio: number;
  stake: number;
  horizon: number;
  maxTicks: number;
  p0: number;
  isLive: boolean;
  token: string | null;
  accountId: string | null;
  contractId: number | null;
  entrySpot: number;
  rotationCandidateAvailable: boolean;
}): Promise<WatchResult> {
  const { symbol, growthRate, barrierRatio, stake, horizon, p0 } = params;
  session.monitor = {
    ticksSurvived: 0,
    inBand: true,
    currentValue: stake,
    profit: 0,
    lambdaLive: p0 * (1 + growthRate),
    lambdaLowerLive: p0 * (1 + growthRate),
    flags: 0,
    sprt: "continue",
    cusum: 0,
    rateZ: 0,
    lastDecision: "hold",
    lastReason: "Opening.",
  };
  session.currentValue = 1;
  session.ticksSurvived = 0;
  broadcast();

  let sprt = freshSprt(p0, sprtAlternative(p0, Math.max(0.005, (1 - p0) * 0.5)));
  let cusum: CusumState = freshCusum();
  let window: RateWindow = freshRateWindow(p0);
  let ticks = 0;
  let survived = 0;
  let lastPrice = tickManager.getLatestPrice(symbol) ?? params.entrySpot;
  let flags = 0;
  const watchStart = Date.now();

  // Hard ceiling: the contract itself cannot outlive the product's tick cap, and
  // the loop must never hang on a stalled feed.
  const hardDeadlineMs = (params.maxTicks + 10) * Math.max(1, tickSecondsForSymbol(symbol)) * 1000 + 15_000;

  while (session.running && !session.stopRequested && ticks < params.maxTicks) {
    await sleep(250);
    if (Date.now() - watchStart > hardDeadlineMs) {
      return {
        result: "bailed",
        profit: 0,
        ticks,
        exitSpot: lastPrice,
        note: "Feed stalled — abandoning the watch and letting the exchange-side take-profit settle the contract.",
        action: "sell_defensive",
      };
    }

    // Process the tick BUFFER, not the latest price. Two reasons: several ticks
    // can print between two polls (the loop sleeps, scans, or settles), and a
    // multi-tick move compared against a single-tick band is a knockout that
    // never happened. Every tick between the last one seen and the newest is
    // therefore walked individually.
    const buffer = tickManager.getTicks(symbol, 256);
    if (buffer.length === 0) continue;
    let start = -1;
    for (let i = buffer.length - 1; i >= 0; i--) if (buffer[i] === lastPrice) { start = i; break; }
    const freshTicks = start >= 0 ? buffer.slice(start + 1) : buffer.slice(-1);
    if (freshTicks.length === 0) continue;
    if (ticks >= params.maxTicks) break;

    let price = lastPrice;
    for (const next of freshTicks) {
      const move = price > 0 ? (next - price) / price : 0;
      price = next;
      ticks += 1;

      const inBand = Math.abs(move) <= barrierRatio;
    window = pushRateWindow(window, inBand);
    sprt = sprtUpdate(sprt, inBand);
    const cusumResult = cusumUpdate(cusum, inBand, p0, Math.max(0.005, (1 - p0) * 0.5), 5);
    cusum = cusumResult.state;

    if (inBand) survived += 1;
    const value = Math.pow(1 + growthRate, survived);

    // Live λ from the contract's OWN survival so far, blended with the prior so
    // a single early tick cannot swing it.
    const observed = wilsonInterval(survived, Math.max(1, ticks));
    const lambdaLive = observed.p * (1 + growthRate);
    const lambdaLowerLive = observed.lower * (1 + growthRate);

    flags = 0;
    if (window.samples.length >= HEALTH_WARMUP_TICKS && rateWindowZ(window) < -2.5) flags += 1;
    if (sprt.decision === "accept_decayed") flags += 1;
    if (cusumResult.alarm) flags += 1;
    if (ticks >= HEALTH_WARMUP_TICKS && lambdaLowerLive < 1) flags += 1;
    if (ticks >= HEALTH_WARMUP_TICKS && observed.p < p0 - 0.02) flags += 1;

    session.monitor = {
      ticksSurvived: ticks,
      inBand,
      currentValue: value,
      profit: stake * (value - 1),
      lambdaLive,
      lambdaLowerLive,
      flags,
      sprt: sprt.decision,
      cusum: cusumResult.statistic,
      rateZ: rateWindowZ(window),
      lastDecision: "hold",
      lastReason: `Tick ${ticks}: ${inBand ? "inside" : "OUTSIDE"} the band, value ${value.toFixed(4)}×.`,
    };
    session.currentValue = value;
    session.currentProfit = stake * (value - 1);
    session.ticksSurvived = ticks;

    // A knockout ends the contract immediately: the whole stake is gone. In
    // paper mode there is nothing to settle, and the loss is the FULL stake —
    // the one outcome this contract never softens.
    if (!inBand) {
      session.monitor.lastDecision = "knockout";
      session.monitor.lastReason = `Knocked out at tick ${ticks} — the whole stake is lost, which is the contract's own rule.`;
      broadcast();
      const settled = await settle(params, stake, "lost");
      return {
        result: "lost",
        profit: params.isLive && settled.note ? settled.profit : -stake,
        ticks,
        exitSpot: price,
        note: settled.note || `Knocked out at tick ${ticks}: the tick printed outside the band and the stake is gone.`,
        action: "hold",
      };
    }

    const decision = liveExitDecision({
      ticksSurvived: ticks,
      targetTicks: horizon,
      growthRate,
      valueMultiple: value,
      lambdaLowerLive,
      lambdaLive,
      flags,
      cusumTripped: cusumResult.alarm,
      sprt: sprt.decision,
      rotationCandidateAvailable: params.rotationCandidateAvailable,
    });
    session.monitor.lastDecision = decision.action;
    session.monitor.lastReason = decision.reason;

    if (decision.action === "sell_target" || ticks >= horizon) {
      // Either the target horizon is reached, or the exchange-side take-profit
      // already closed it — both settle at the contractual value.
      session.monitor.lastDecision = "sell_target";
      broadcast();
      const settled = await settle(params, stake, "won");
      return {
        result: "won",
        profit: settled.profit > 0 ? settled.profit : stake * (value - 1),
        ticks,
        exitSpot: price,
        note: settled.note || `Target horizon reached at ${value.toFixed(4)}×.`,
        action: "sell_target",
      };
    }

    if (decision.action === "sell_defensive") {
      broadcast();
      if (params.isLive && params.contractId !== null && params.token && params.accountId) {
        const sold = await sellContract(params.token, params.accountId, params.contractId);
        if (sold && Number.isFinite(sold.soldFor)) {
          const profit = sold.soldFor - stake;
          return {
            result: "bailed",
            profit,
            ticks,
            exitSpot: price,
            note: `Sold at ${value.toFixed(4)}× for $${sold.soldFor.toFixed(2)} — ${decision.reason}`,
            action: "sell_defensive",
          };
        }
      }
      // Paper (or the sell failed): the position is marked out at its current
      // value, which is what the sell was for.
      return {
        result: "bailed",
        profit: stake * (value - 1),
        ticks,
        exitSpot: price,
        note: `Exited at ${value.toFixed(4)}× (paper) — ${decision.reason}`,
        action: "sell_defensive",
      };
    }

    if (decision.action === "abandon_market") {
      broadcast();
      if (params.isLive && params.contractId !== null && params.token && params.accountId) {
        const sold = await sellContract(params.token, params.accountId, params.contractId);
        if (sold && Number.isFinite(sold.soldFor)) {
          return {
            result: "bailed",
            profit: sold.soldFor - stake,
            ticks,
            exitSpot: price,
            note: `Market abandoned, position sold for $${sold.soldFor.toFixed(2)} — ${decision.reason}`,
            action: "abandon_market",
          };
        }
      }
      return {
        result: "bailed",
        profit: stake * (value - 1),
        ticks,
        exitSpot: price,
        note: `Market abandoned at ${value.toFixed(4)}× (paper) — ${decision.reason}`,
        action: "abandon_market",
      };
      }

      if (ticks % 5 === 0) broadcast();
      if (ticks >= params.maxTicks) break;
    }
    lastPrice = price;
  }

  // Ran out of ticks without a knockout: the contract expires at its value.
  const settled = await settle(params, stake, "won");
  const finalValue = Math.pow(1 + growthRate, Math.min(survived, params.maxTicks));
  return {
    result: "won",
    profit: settled.profit > 0 ? settled.profit : stake * (finalValue - 1),
    ticks,
    exitSpot: lastPrice,
    note: settled.note || `Survived the full ${Math.min(survived, params.maxTicks)} available ticks.`,
    action: "hold",
  };
}

/** Wait for the exchange's settlement of a live contract (paper returns 0). */
async function settle(
  params: { isLive: boolean; token: string | null; accountId: string | null; contractId: number | null },
  stake: number,
  expect: "won" | "lost",
): Promise<{ profit: number; note: string }> {
  if (!params.isLive || params.contractId === null || !params.token || !params.accountId) {
    return { profit: 0, note: "" };
  }
  try {
    const result = await waitForContractResult(params.token, params.accountId, params.contractId, 45_000);
    if (!result || result.missing) return { profit: 0, note: "Settlement not found in time — reconciled on the next pass." };
    return {
      profit: result.profit,
      note: `${expect === "lost" ? "Knockout" : "Settled"} by the exchange at $${result.sellPrice.toFixed(2)}.`,
    };
  } catch (err) {
    logger.debug({ err }, "Accumulator settlement lookup failed");
    void stake;
    return { profit: 0, note: "Settlement lookup failed — reconciled on the next pass." };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function tickSecondsForSymbol(symbol: string): number {
  return symbol.startsWith("1HZ") ? 1 : 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public extras used by the API surface
// ─────────────────────────────────────────────────────────────────────────────

export interface AccumulatorProjection {
  stake: number;
  growthRate: number;
  horizonTicks: number;
  expectedProfit: number;
  ruinProbability: number;
  requiredSurvival: number;
  measuredSurvival: number;
  payoutMultiple: number;
  houseTilt: number;
  tickCap: number;
}

/** The fully-priced trade the UI shows before deploy: EV, ruin odds, the tilt. */
export async function projectAccumulator(params: {
  symbol: string;
  growthRate: number;
  stake?: number;
  certainty?: CertaintyProfile["id"];
}): Promise<AccumulatorProjection | null> {
  const stake = params.stake && params.stake > 0 ? params.stake : 1;
  const profile = ACCU_CERTAINTY[params.certainty ?? "strict"] ?? ACCU_CERTAINTY.strict;
  const read = await readMarket(params.symbol, params.growthRate, stake);
  if (!read) return null;
  const maxTicks = effectiveMaxTicks(params.growthRate);
  const edge = readEdge({
    symbol: params.symbol,
    growthRate: params.growthRate,
    increments: read.increments,
    barrierRatio: read.barrierRatio,
    barrierCalibrated: read.barrierCalibrated,
    profile,
    maxTicks,
  });
  if (!edge) return null;

  const runs = bandRunLengths(read.increments, read.barrierRatio, maxTicks);
  const survival = kaplanMeierSurvival(runs.lengths, maxTicks);
  const curve = evCurve({ survival, growthRate: params.growthRate, maxTicks });
  const best = optimalHorizon(curve, profile.minSurvivalLower);
  const projection = projectSession({
    stake,
    growthRate: params.growthRate,
    horizonTicks: Math.max(1, best.ticks),
    survival,
    stopLoss: stake * 5,
    targetProfit: stake * 2,
  });

  return {
    stake,
    growthRate: params.growthRate,
    horizonTicks: best.ticks,
    expectedProfit: projection.expectedEv,
    ruinProbability: projection.ruinProbability,
    requiredSurvival: Math.pow(1 + params.growthRate, -Math.max(1, best.ticks)),
    measuredSurvival: best.survival,
    payoutMultiple: best.payoutMultiple,
    houseTilt: 1 - modelLambda(params.growthRate),
    tickCap: maxTicks,
  };
}

/** Bounds for the diagnostic panels, exported so the UI and tests share them. */
export const ACCUMULATOR_LIMITS = {
  minHistoryTicks: MIN_HISTORY_TICKS,
  historyTicks: HISTORY_TICKS,
  healthWarmupTicks: HEALTH_WARMUP_TICKS,
  rescanIntervalTicks: RESCAN_INTERVAL_TICKS,
  healthWindowTicks: HEALTH_WINDOW_TICKS,
  tickCapAnchors: ACCU_TICK_CAP_ANCHORS,
  payoutCapMultiple: DEFAULT_PAYOUT_CAP_MULTIPLE,
};

export type { AccumulatorRecoveryPlan, CertaintyProfile, EdgeReading, MagnitudeChain };
export { calibrationTable, pFromVolRatio, impliedSigmaFromBarrier, realizedTickVol, empiricalInsideProb, lambdaFor };
