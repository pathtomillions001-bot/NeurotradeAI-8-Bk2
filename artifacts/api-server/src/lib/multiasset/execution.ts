/**
 * WP7 — the execution and timing agent.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * Everything up to WP6 decides WHETHER a trade is worth taking. This decides HOW
 * it gets into the market, and whether now is a moment the desk has any business
 * touching. Four components, each a veto or a choice, all of them measurable:
 *
 *   1. **spread z** — the quote the desk sees against the quote it usually sees
 *      at this moment. A spread that is wide *for this symbol at this minute* is
 *      a moment of one-sided flow, and the desk is about to be the other side of
 *      it. Skip when the z-score is above the brief's 1.0.
 *   2. **minute-of-week timing** — the desk's own realised outcomes bucketed by
 *      minute-of-week, shrunk toward the pooled rate. A bucket that has measured
 *      worse than the desk's average is not a moment to enter. Buckets without
 *      enough evidence abstain rather than refuse (see the assumption in
 *      docs/mt5-live-desk-v4.md §11): a timing filter must be able to say
 *      "no opinion" without stopping the desk, and the edge gates still apply to
 *      every trade it lets through.
 *   3. **the slippage ledger** — every fill's slippage in R, EWMA'd. When the
 *      realised mean exceeds 0.15R the desk is not getting the fills its plans
 *      assume, and it pauses rather than re-pricing its edge live.
 *   4. **the entry style** — institutional entries, not breakout chasing: a
 *      pullback or sweep setup RESTS A LIMIT at the retracement and waits, with
 *      the brief's rules (expiry, cancel at 0.5R unfilled, bar-close
 *      confirmation). A breakout setup still stops in — but it stops in with the
 *      bar-close confirmation, not on the first tick that crosses the level.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * It is not a signal. It never changes the direction or the geometry of a trade:
 * the stop, the target and the risk unit are the gatekeeper's, and they are the
 * same numbers whether the entry rests or fires. It is pure and deterministic,
 * and it can only refuse or reshape an entry — never create one.
 */
import { TIMEFRAME_MINUTES, type Bar, type Side, type SymbolSpec, type Timeframe, type TradeMode } from "./types";
import { CLOSE, atrSeries, mean, stdev } from "./math";

/** Skip an entry when the spread is this many standard deviations above normal. */
export const SPREAD_Z_LIMIT = 1.0;

/** Trailing spread observations the z-score is computed over. */
export const SPREAD_Z_WINDOW = 240;

/** Below this many observations a z-score is not computed (and not applied). */
export const SPREAD_Z_MIN_SAMPLES = 60;

/** Pause new entries when the EWMA of realised slippage exceeds this, in R. */
export const SLIPPAGE_PAUSE_R = 0.15;

/** EWMA decay for the slippage ledger. Same 0.97 as the covariance (WP8). */
export const SLIPPAGE_LAMBDA = 0.97;

/** Cancel a resting entry once the market has run this far away, in R. */
export const PENDING_CANCEL_R = 0.5;

/** How a plan gets in: resting limit, stop-through, or immediate. */
export type EntryStyle = "limit" | "stop" | "market";

export interface ExecutionCode {
  code: string;
  /** Deprecated alias kept for journals written before the rename. */
  severity?: "ok" | "veto";
}

/** Trailing spread distribution, or `null` when there is not enough history. */
export interface SpreadReading {
  z: number;
  mean: number;
  sd: number;
  samples: number;
}

/**
 * The z-score of the current spread against its own trailing window.
 *
 * `history` must be CAUSAL — the spreads observed up to and including the
 * decision bar, oldest first — and belongs to this symbol and this frame. A
 * pooled or forward-looking distribution would make the filter fire on the
 * march of the day rather than on the moment.
 *
 * Returns `null` rather than a number when the window cannot support one: a
 * z-score from three observations is not a measurement, and the caller treats
 * `null` as "no opinion" (see the module doc).
 */
export function spreadZ(input: {
  spreadPoints: number;
  history: number[];
  window?: number;
  minSamples?: number;
}): SpreadReading | null {
  const window = Math.max(2, input.window ?? SPREAD_Z_WINDOW);
  const minSamples = Math.max(2, input.minSamples ?? SPREAD_Z_MIN_SAMPLES);
  const series = input.history.length > window ? input.history.slice(-window) : input.history;
  if (series.length < minSamples) return null;
  const m = mean(series);
  const sd = stdev(series);
  if (!(sd > 0) || !Number.isFinite(input.spreadPoints)) return null;
  return { z: (input.spreadPoints - m) / sd, mean: m, sd, samples: series.length };
}

export interface TimingBucketStats {
  /** Bucket index: minute of the week, 0 = Sunday 00:00 UTC. */
  bucket: number;
  samples: number;
  /** Realised hit rate in this bucket, shrunk toward the pooled rate. */
  hitRate: number;
  /** Mean R realised in this bucket, shrunk toward the pooled mean. */
  meanR: number;
}

export interface TimingLedger {
  buckets: Map<number, { wins: number; losses: number; rSum: number }>;
  pooled: { wins: number; losses: number; rSum: number };
}

/** A fresh ledger. Buckets are minute-of-week (0…10079), UTC. */
export function createTimingLedger(): TimingLedger {
  return { buckets: new Map(), pooled: { wins: 0, losses: 0, rSum: 0 } };
}

/** Minutes in a week. */
export const MINUTES_PER_WEEK = 7 * 24 * 60;

/**
 * The epoch's day offset: 1970-01-01 was a THURSDAY, i.e. four days after the
 * Sunday the buckets are anchored to. Without this the bucket indices are
 * shifted by four days — self-consistent, but every index in the journal points
 * at the wrong weekday, which is a defect in the only thing a bucket is for.
 */
const EPOCH_DAY_OFFSET_MINUTES = 4 * 24 * 60;

/**
 * Minute of the week, UTC, from a timestamp: 0 = Sunday 00:00, 10079 =
 * Saturday 23:59. This is the bucket key of the timing ledger and the number
 * the journal prints, so it is anchored to the calendar rather than to the
 * epoch.
 */
export function minuteOfWeek(timestampMs: number): number {
  const minutes = Math.floor(timestampMs / 60_000);
  const shifted = minutes + EPOCH_DAY_OFFSET_MINUTES;
  const remainder = ((shifted % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
  return remainder;
}

/**
 * Record one realised trade against the bucket its DECISION fell in.
 *
 * The decision bar's timestamp is what buckets a trade, not its exit: a trade
 * entered at 10:00 and closed at 15:00 is evidence about 10:00, and bucketing it
 * by its exit would smear the answer across the whole holding window.
 */
export function recordTimingOutcome(
  ledger: TimingLedger,
  input: { timestampMs: number; rMultiple: number },
): void {
  const bucket = minuteOfWeek(input.timestampMs);
  const entry = ledger.buckets.get(bucket) ?? { wins: 0, losses: 0, rSum: 0 };
  if (input.rMultiple > 0) entry.wins++;
  else entry.losses++;
  entry.rSum += input.rMultiple;
  ledger.buckets.set(bucket, entry);
  if (input.rMultiple > 0) ledger.pooled.wins++;
  else ledger.pooled.losses++;
  ledger.pooled.rSum += input.rMultiple;
}

/** Observations a bucket needs before it may veto anything. */
export const TIMING_MIN_BUCKET_SAMPLES = 20;

/** Shrinkage strength toward the pooled rate: 8 pseudo-observations. */
export const TIMING_SHRINKAGE = 8;

export interface TimingPermit {
  /** `true` ⇒ this moment is either good or unmeasured; the desk may enter. */
  permit: boolean;
  /** Was the bucket measured at all? */
  measured: boolean;
  bucket: number;
  samples: number;
  /** The bucket's shrunk mean R, or the pooled mean when unmeasured. */
  meanR: number;
  /** The pooled mean R the bucket is judged against. */
  pooledMeanR: number;
  reason: string;
  codes: string[];
}

/**
 * The timing permit for a decision at `timestampMs`.
 *
 * The rule is deliberately one-sided: a bucket may only REFUSE. It refuses when
 * it has enough observations AND its shrunk mean R is below the pooled mean R by
 * more than the pooled rate's own standard error — i.e. when the difference is
 * bigger than the noise in the desk's own record. A bucket that is merely
 * unlucky does not veto; a bucket that is measurably worse does.
 */
export function timingPermit(input: {
  ledger: TimingLedger;
  timestampMs: number;
  /** Override for tests; defaults to `TIMING_MIN_BUCKET_SAMPLES`. */
  minSamples?: number;
}): TimingPermit {
  const bucket = minuteOfWeek(input.timestampMs);
  const entry = input.ledger.buckets.get(bucket);
  const minSamples = input.minSamples ?? TIMING_MIN_BUCKET_SAMPLES;
  const closed = input.ledger.pooled.wins + input.ledger.pooled.losses;
  const pooledMeanR = closed > 0 ? input.ledger.pooled.rSum / closed : 0;
  if (!entry || entry.wins + entry.losses < minSamples || closed < minSamples) {
    return {
      permit: true,
      measured: false,
      bucket,
      samples: entry ? entry.wins + entry.losses : 0,
      meanR: pooledMeanR,
      pooledMeanR,
      reason: `minute-of-week bucket ${bucket} has too little evidence (${entry ? entry.wins + entry.losses : 0} trades) — no opinion.`,
      codes: ["TIMING_UNMEASURED"],
    };
  }
  const n = entry.wins + entry.losses;
  const shrunk = (entry.rSum + TIMING_SHRINKAGE * pooledMeanR) / (n + TIMING_SHRINKAGE);
  const pooledSd = stdev(
    Array.from(input.ledger.buckets.values()).flatMap((b) =>
      b.losses + b.wins > 0 ? [b.rSum / (b.wins + b.losses)] : [],
    ),
  );
  const se = pooledSd > 0 ? pooledSd / Math.sqrt(n) : 0;
  const below = shrunk < pooledMeanR - Math.max(se, 1e-9);
  return {
    permit: !below,
    measured: true,
    bucket,
    samples: n,
    meanR: shrunk,
    pooledMeanR,
    reason: below
      ? `minute-of-week bucket ${bucket} has realised ${shrunk.toFixed(3)}R over ${n} trades against the desk's ${pooledMeanR.toFixed(3)}R pooled — a measured worse time to enter.`
      : `minute-of-week bucket ${bucket} is not measurably worse than the desk's pooled ${pooledMeanR.toFixed(3)}R (${shrunk.toFixed(3)}R over ${n} trades).`,
    codes: below ? ["TIMING_BUCKET"] : ["TIMING_OK"],
  };
}

/** The slippage ledger: EWMA of realised slippage in R. */
export interface SlippageLedger {
  /** EWMA of slippage in R; positive means fills are worse than planned. */
  ewmaR: number | null;
  samples: number;
  /** The individual observations, newest last (bounded). */
  observations: number[];
}

export function createSlippageLedger(): SlippageLedger {
  return { ewmaR: null, samples: 0, observations: [] };
}

/** Maximum observations retained, so a long-running desk cannot grow unbounded. */
export const SLIPPAGE_MAX_OBSERVATIONS = 500;

/**
 * Record a fill's slippage, in R.
 *
 * `signedSlipR` must be signed AGAINST the trade: a buy filled above its plan
 * and a sell filled below it are both positive. A reporter that recorded the
 * absolute distance would make a favourable fill look like a cost.
 */
export function recordSlippage(ledger: SlippageLedger, signedSlipR: number): void {
  if (!Number.isFinite(signedSlipR)) return;
  ledger.ewmaR = ledger.ewmaR === null ? signedSlipR : SLIPPAGE_LAMBDA * ledger.ewmaR + (1 - SLIPPAGE_LAMBDA) * signedSlipR;
  ledger.samples++;
  ledger.observations.push(signedSlipR);
  if (ledger.observations.length > SLIPPAGE_MAX_OBSERVATIONS) ledger.observations.shift();
}

export interface SlippagePause {
  paused: boolean;
  /** The EWMA, or null when nothing has been observed. */
  ewmaR: number | null;
  samples: number;
  reason: string;
}

/**
 * Pause new entries when the desk's fills have drifted beyond the brief's 0.15R.
 *
 * A desk whose realised slippage is 0.15R is giving away three quarters of a
 * 0.20R floor before the trade starts. Pausing is the honest response: the
 * alternative — re-pricing the edge live — is how a strategy quietly becomes a
 * different one.
 */
export function slippagePause(ledger: SlippageLedger): SlippagePause {
  const paused = ledger.ewmaR !== null && ledger.ewmaR > SLIPPAGE_PAUSE_R;
  return {
    paused,
    ewmaR: ledger.ewmaR,
    samples: ledger.samples,
    reason: paused
      ? `realised slippage is ${(ledger.ewmaR as number).toFixed(3)}R EWMA over ${ledger.samples} fills, above the ${SLIPPAGE_PAUSE_R.toFixed(2)}R ceiling — new entries pause until the fills improve.`
      : ledger.ewmaR === null
        ? "no fills have been observed yet, so the slippage ledger has no opinion."
        : `realised slippage is ${ledger.ewmaR.toFixed(3)}R EWMA over ${ledger.samples} fills, inside the ${SLIPPAGE_PAUSE_R.toFixed(2)}R ceiling.`,
  };
}

/**
 * Signed slippage in R for a fill.
 *
 * `side` is the trade's direction and `riskPrice` the plan's risk unit in price
 * units. Positive = the desk paid worse than its plan.
 */
export function signedSlippageR(input: {
  side: Side;
  plannedPrice: number;
  fillPrice: number;
  riskPrice: number;
}): number | null {
  if (!(input.riskPrice > 0)) return null;
  const raw = input.side === "buy" ? input.fillPrice - input.plannedPrice : input.plannedPrice - input.fillPrice;
  return raw / input.riskPrice;
}

export interface PendingEntryPlan {
  style: EntryStyle;
  /** Price at which the resting order sits, or at which a stop triggers. */
  trigger: number;
  /** Bars the order may rest before it expires. */
  expireAfterBars: number;
  /** Cancel once price has moved this far away, in R. */
  cancelAtR: number;
  /** Confirm the cross on a closed bar rather than a tick. */
  confirmOnBarClose: boolean;
  reason: string;
}

/** How long a resting entry may wait, in bars, per mode. */
export const PENDING_EXPIRY_BARS: Record<TradeMode, number> = { scalp: 3, intraday: 6, swing: 12 };

/**
 * The resting-limit entry for a pullback setup.
 *
 * The level is quoted in ATR from the decision close, and the SAME level is what
 * the stop and the target are then measured from — so the reward:risk the desk
 * promised is the reward:risk it gets. The order expires after the mode's bar
 * budget and is cancelled if price runs away, which is what stops a "pullback"
 * entry from becoming a position entered at the worst possible price.
 */
export function pendingEntryPlan(input: {
  mode: TradeMode;
  side: Side;
  decisionClose: number;
  atr: number;
  /** Retracement the setup asks for, in ATR. */
  retraceAtr: number;
  /** Style the setup belongs to: pullbacks rest, breakouts stop. */
  setup: "pullback" | "breakout";
  /** Stop distance in price units, for the cancel rule. */
  riskPrice: number;
  slippagePrice: number;
}): PendingEntryPlan {
  const { mode, side, decisionClose, atr, retraceAtr, setup, riskPrice, slippagePrice } = input;
  const direction = side === "buy" ? -1 : 1;
  const limit = decisionClose + direction * retraceAtr * atr;
  const stopSide = decisionClose + (side === "buy" ? 1 : -1) * (retraceAtr * atr + slippagePrice);
  const trigger = setup === "pullback" ? limit : stopSide;
  return {
    style: setup === "pullback" ? "limit" : "stop",
    trigger,
    expireAfterBars: PENDING_EXPIRY_BARS[mode],
    cancelAtR: PENDING_CANCEL_R,
    confirmOnBarClose: true,
    reason:
      setup === "pullback"
        ? `a pullback setup rests a limit at ${trigger.toPrecision(7)} (${retraceAtr.toFixed(2)} ATR back), expiring after ${PENDING_EXPIRY_BARS[mode]} bars and cancelling if price runs ${PENDING_CANCEL_R.toFixed(2)}R away unfilled.`
        : `a breakout setup stops in at ${trigger.toPrecision(7)} (${retraceAtr.toFixed(2)} ATR through) with bar-close confirmation.`,
  };
}

/**
 * Observations a measured allowance needs before it may replace the modelled
 * one. Below this the ledger is a recount of a handful of fills, and a
 * constant-plus-noise is a better estimate than three data points.
 */
export const SLIPPAGE_MEASUREMENT_MIN_SAMPLES = 20;

/**
 * Ceiling on the measured allowance: this many times the modelled one.
 *
 * A single catastrophic fill (a weekend gap, a news spike) must not quietly
 * quintuple the desk's cost basis for the next week; the response to slippage
 * that bad is the PAUSE above, not a permanently inflated allowance.
 */
export const SLIPPAGE_MEASUREMENT_CEILING_MULT = 3;

/**
 * The measured slippage allowance, in R, or `null` when the desk has not
 * measured enough fills for the number to mean anything.
 *
 * This is the D7 fix: the desk's cost basis was a constant chosen by asset class
 * (`slippageAllowancePoints`), and a constant is an assumption. Once the desk has
 * watched its own fills, the assumption is replaced by the measurement — in the
 * conservative direction only: the caller takes `max(modelled, measured)`, so a
 * desk that fills BETTER than its allowance does not start pretending it will
 * keep doing so, and a plan is never costed below the brief's own allowance.
 */
export function measuredSlippageR(
  ledger: SlippageLedger,
  minSamples: number = SLIPPAGE_MEASUREMENT_MIN_SAMPLES,
): number | null {
  if (ledger.ewmaR === null || !Number.isFinite(ledger.ewmaR)) return null;
  if (ledger.samples < Math.max(1, minSamples)) return null;
  return ledger.ewmaR;
}

// ── The spread history ──────────────────────────────────────────────────────

/**
 * Per-symbol trailing spread observations, oldest first.
 *
 * The desk feeds this from every accepted quote and the execution layer's
 * z-score reads it. It is NOT a candle field: MT5's bars carry no spread column
 * on most brokers, so the only honest source of "the spread this symbol usually
 * shows" is the quotes the desk has actually received.
 */
export interface SpreadHistory {
  samples: Map<string, number[]>;
}

/** Observations retained per symbol: comfortably more than the z window. */
export const SPREAD_HISTORY_MAX = 400;

export function createSpreadHistory(): SpreadHistory {
  return { samples: new Map() };
}

export function recordSpread(history: SpreadHistory, symbol: string, spreadPoints: number): void {
  if (!Number.isFinite(spreadPoints) || spreadPoints <= 0) return;
  const series = history.samples.get(symbol) ?? [];
  series.push(spreadPoints);
  if (series.length > SPREAD_HISTORY_MAX) series.splice(0, series.length - SPREAD_HISTORY_MAX);
  history.samples.set(symbol, series);
}

/** A copy of the symbol's trailing spreads, oldest first. */
export function spreadHistoryFor(history: SpreadHistory, symbol: string): number[] {
  return [...(history.samples.get(symbol) ?? [])];
}

/** The full execution verdict for one candidate. */
export interface ExecutionDecision {
  /** `false` refuses the entry; the plan is not armed. */
  allowed: boolean;
  codes: string[];
  reasons: string[];
  spread: SpreadReading | null;
  timing: TimingPermit;
  slippage: SlippagePause;
  entry: PendingEntryPlan;
}

/**
 * The composition: spread z, timing, slippage, then the entry style.
 *
 * Pure and total. The order of the checks is cheapest-first and the first
 * refusal is the headline, but every layer's verdict is recorded — a journal
 * that lists only the objection cannot be audited for the checks that passed.
 */
export function executionDecision(input: {
  mode: TradeMode;
  side: Side;
  spec: Pick<SymbolSpec, "assetClass" | "spreadPoints" | "point">;
  decisionClose: number;
  atr: number;
  retraceAtr: number;
  setup: "pullback" | "breakout";
  riskPrice: number;
  slippagePrice: number;
  spreadPoints: number;
  spreadHistory: number[];
  timestampMs: number;
  timing: TimingLedger;
  slippage: SlippageLedger;
  /** Force a style (tests, operator); otherwise the setup decides. */
  style?: EntryStyle;
}): ExecutionDecision {
  const codes: string[] = [];
  const reasons: string[] = [];

  const spread = spreadZ({ spreadPoints: input.spreadPoints, history: input.spreadHistory });
  if (spread !== null && spread.z > SPREAD_Z_LIMIT) {
    codes.push("EXEC_SPREAD_Z");
    reasons.push(
      `the spread is ${spread.z.toFixed(2)}σ above its trailing mean (${spread.mean.toFixed(2)} points over ${spread.samples} observations), over the ${SPREAD_Z_LIMIT.toFixed(1)}σ ceiling — this is a moment of one-sided flow.`,
    );
  }

  const timing = timingPermit({ ledger: input.timing, timestampMs: input.timestampMs });
  if (!timing.permit) {
    codes.push("EXEC_TIMING");
    reasons.push(timing.reason);
  }

  const slippage = slippagePause(input.slippage);
  if (slippage.paused) {
    codes.push("EXEC_SLIPPAGE_PAUSE");
    reasons.push(slippage.reason);
  }

  const entry = pendingEntryPlan({
    mode: input.mode,
    side: input.side,
    decisionClose: input.decisionClose,
    atr: input.atr,
    retraceAtr: input.retraceAtr,
    setup: input.setup,
    riskPrice: input.riskPrice,
    slippagePrice: input.slippagePrice,
  });
  if (input.style && input.style !== entry.style) {
    // An operator or a test may force a style; the geometry is unchanged.
    entry.style = input.style;
    entry.reason = `${entry.reason} (style forced to ${input.style})`;
  }

  const allowed = codes.length === 0;
  if (allowed) {
    codes.push("EXEC_OK");
    reasons.push(entry.reason);
  }

  return { allowed, codes, reasons, spread, timing, slippage, entry };
}

/**
 * The refusal lines a journal shows: one per failing layer, `[CODE] sentence`.
 *
 * Membership is decided by the codes the layer actually set, never by a
 * threshold field — a refusal with no number in it (`EXEC_SLIPPAGE_PAUSE`) is
 * still a refusal, and filtering those out is how a blocked entry reads as an
 * armed one. `codes` and `reasons` are appended together inside
 * `executionDecision`, so the pairing is positional: one sentence per code, in
 * the order they fired.
 */
export function executionRejections(decision: ExecutionDecision): string[] {
  if (decision.allowed) return [];
  const lines: string[] = [];
  decision.codes.forEach((code, index) => {
    if (code === "EXEC_OK") return;
    lines.push(`[${code}] ${decision.reasons[index] ?? code}`);
  });
  return lines;
}

/**
 * The desk's own ATR for a decision bar, or null when there is not enough
 * history. Delegates to `math.atrSeries` so the execution layer cannot develop a
 * second, subtly different definition of "ATR" from the one the stop uses — the
 * retracement it quotes is in the same units as the risk unit it qualifies.
 */
export function decisionAtr(bars: Bar[]): number | null {
  if (bars.length < 15) return null;
  const close = (bars[bars.length - 1] as Bar)[CLOSE] as number;
  if (!(close > 0)) return null;
  const series = atrSeries(bars);
  const value = series[series.length - 1] as number | undefined;
  return value !== undefined && value > 0 ? value : null;
}

/** Frame width in ms, from the desk's own timeframe table. */
export function frameWidthOf(frame: Timeframe): number {
  return TIMEFRAME_MINUTES[frame] * 60_000;
}
