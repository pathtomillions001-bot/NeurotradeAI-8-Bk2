/**
 * Conservative recovery-only decision layer for the main autonomous engine.
 *
 * The normal-trade coordinator does not use this module. Recovery candidates
 * are estimated at the exact contract horizon, shrunk toward the contract's
 * theoretical rate, discounted for serial dependence, corrected for the number
 * of opportunities scanned, and accepted only when a conservative probability
 * bound clears the live payout's break-even rate plus a small EV buffer.
 *
 * This is a risk filter, not a claim that historical digit bias predicts future
 * Deriv ticks. Markov features are deliberately excluded until an out-of-sample
 * calibration study demonstrates value.
 */

import type { DigitSnapshot, DigitTick } from "./digit-tape";

export const RECOVERY_V2_MIN_EXPECTED_VALUE = 0.01;
export const RECOVERY_V2_MIN_EFFECTIVE_SAMPLES = 100;
export const RECOVERY_V2_PRIOR_STRENGTH = 40;
export const RECOVERY_V2_FAMILYWISE_ALPHA = 0.05;
export const RECOVERY_V2_MAX_ACCOUNT_RISK_FRACTION = 0.005;
export const RECOVERY_V2_FRACTIONAL_KELLY = 0.25;
export const RECOVERY_V2_MIN_STAKE = 0.35;
export const RECOVERY_V2_MAX_QUOTE_CANDIDATES = 10;
export const RECOVERY_V2_PREFILTER_EV_FLOOR = -0.03;

export interface RecoveryMarketSample {
  /** Broker epoch in seconds. */
  epoch: number;
  price: number;
  digit: number;
}

export interface RecoveryCandidateV2 {
  symbol: string;
  contractType: string;
  barrier: number | null;
  duration: number;
  theoreticalWinProbability: number;
  winProbability: number;
  lowerWinProbability: number;
  upperWinProbability: number;
  uncertainty: number;
  sampleSize: number;
  effectiveSampleSize: number;
  wins: number;
  hypothesisCount: number;
  sourceGeneration: number;
  latestSequence: number;
  latestReceivedAt: number;
  payoutMultiplier: number | null;
  payoutSource: "live" | "fallback" | null;
  expectedValue: number | null;
  lowerExpectedValue: number | null;
  accepted: boolean;
  rejectionReason: string | null;
}

export interface RecoveryExecutionGuard {
  lowerWinProbability: number;
  minimumExpectedValue: number;
  maxStake: number;
  expectedGeneration: number;
  minimumSequence: number;
  maxTickAgeMs: number;
}

export interface RecoveryExecutionProposal {
  askPrice: number;
  payout: number;
}

/**
 * The environment flag is on by default so an approved rollout uses v2 without
 * requiring an additional deployment edit. Set AUTONOMOUS_RECOVERY_V2=false
 * (or 0/off/no) to immediately restore the prior recovery-only path. Normal
 * trades are unaffected either way.
 */
export function isRecoveryDecisionV2Enabled(
  value: string | undefined = process.env.AUTONOMOUS_RECOVERY_V2,
): boolean {
  if (value == null || value.trim() === "") return true;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no", "disabled"].includes(normalized)) return false;
  if (["1", "true", "on", "yes", "enabled"].includes(normalized)) return true;
  return false;
}

/** Normalize a raw broker timestamp to epoch seconds. */
function epochSeconds(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric > 1e11 ? numeric / 1000 : numeric;
}

function lastDigit(price: number, pipSize: number): number {
  return Math.round(price * 10 ** pipSize) % 10;
}

/**
 * Fail closed if the current sample isn't a fresh, single-generation live tape.
 * The broker history itself is merged separately; this validates the live tail
 * that anchors it to the current market.
 */
export function recoveryFeedRejection(
  snapshot: DigitSnapshot | null | undefined,
  now = Date.now(),
  maxTickAgeMs = 6_000,
): string | null {
  if (!snapshot?.tick) return "no_tick_snapshot";
  if (snapshot.tick.source !== "live") return "feed_not_live";
  if (!Number.isFinite(snapshot.tick.receivedAt) || snapshot.tick.receivedAt <= 0) {
    return "invalid_tick_timestamp";
  }
  const ageMs = now - snapshot.tick.receivedAt;
  if (ageMs < -1_000 || ageMs > maxTickAgeMs) return "live_tick_stale";
  if (!Number.isFinite(snapshot.tick.epoch) || snapshot.tick.epoch <= 0) {
    return "invalid_broker_epoch";
  }
  if (!Number.isInteger(snapshot.tick.sequence) || snapshot.tick.sequence < 1) {
    return "invalid_tick_sequence";
  }
  if (!Number.isInteger(snapshot.tick.generation) || snapshot.tick.generation < 1) {
    return "invalid_feed_generation";
  }
  if (snapshot.ticks.length === 0) return "empty_live_tape";

  let previousSequence = 0;
  let previousEpoch = -Infinity;
  for (const sample of snapshot.ticks) {
    if (
      sample.source !== "live" ||
      sample.generation !== snapshot.tick.generation ||
      sample.symbol !== snapshot.tick.symbol ||
      !Number.isInteger(sample.digit) || sample.digit < 0 || sample.digit > 9 ||
      !Number.isFinite(sample.price) || sample.price <= 0 ||
      !Number.isFinite(sample.epoch) || sample.epoch <= previousEpoch ||
      !Number.isInteger(sample.sequence) || sample.sequence <= previousSequence
    ) {
      return "mixed_or_malformed_live_tape";
    }
    previousSequence = sample.sequence;
    previousEpoch = sample.epoch;
  }

  const tail = snapshot.ticks[snapshot.ticks.length - 1]!;
  if (
    tail.sequence !== snapshot.tick.sequence ||
    tail.generation !== snapshot.tick.generation ||
    tail.source !== snapshot.tick.source ||
    tail.epoch !== snapshot.tick.epoch ||
    tail.digit !== snapshot.tick.digit ||
    tail.price !== snapshot.tick.price
  ) {
    return "snapshot_tail_mismatch";
  }
  return null;
}

/**
 * Merge Deriv ticks_history with the live tape by broker timestamp. Historical
 * values are accepted only when they agree with overlapping live ticks, belong
 * to the same live feed generation, and form a continuous suffix ending at the
 * latest live sample. Invalid history never contaminates the live tail.
 */
export function mergeRecoveryHistory(
  history: { prices: unknown[]; times: unknown[] } | null | undefined,
  snapshot: DigitSnapshot,
  pipSize: number,
  expectedIntervalMs: number,
  maxSamples = 1_500,
): RecoveryMarketSample[] {
  const feedError = recoveryFeedRejection(
    snapshot,
    Date.now(),
    Math.max(5_000, expectedIntervalMs * 3),
  );
  if (feedError) throw new Error(feedError);
  if (!Number.isInteger(pipSize) || pipSize < 0 || pipSize > 10) {
    throw new Error("invalid_pip_size");
  }

  const byEpoch = new Map<number, RecoveryMarketSample>();
  if (history) {
    if (!Array.isArray(history.prices) || !Array.isArray(history.times) ||
        history.prices.length !== history.times.length) {
      throw new Error("malformed_broker_history");
    }
    let previousEpoch = -Infinity;
    for (let i = 0; i < history.prices.length; i++) {
      const epoch = epochSeconds(history.times[i]);
      const price = Number(history.prices[i]);
      if (!epoch || epoch <= previousEpoch || !Number.isFinite(price) || price <= 0) {
        throw new Error("malformed_broker_history");
      }
      previousEpoch = epoch;
      // A history response can race a new tick. Ignore anything newer than the
      // snapshot anchor; the next scan will see it in the live tape.
      if (epoch <= epochSeconds(snapshot.tick.epoch)) {
        byEpoch.set(epoch, { epoch, price, digit: lastDigit(price, pipSize) });
      }
    }
  }

  for (const sample of snapshot.ticks) {
    if (
      sample.source !== "live" ||
      sample.generation !== snapshot.tick.generation ||
      sample.symbol !== snapshot.tick.symbol
    ) {
      throw new Error("mixed_tick_provenance");
    }
    const epoch = epochSeconds(sample.epoch);
    const historical = byEpoch.get(epoch);
    if (historical) {
      const priceTolerance = Math.max(1e-10, Math.abs(sample.price) * 1e-12);
      if (
        Math.abs(historical.price - sample.price) > priceTolerance ||
        historical.digit !== sample.digit
      ) {
        throw new Error("broker_history_disagrees_with_live_tape");
      }
    }
    byEpoch.set(epoch, { epoch, price: sample.price, digit: sample.digit });
  }

  const sorted = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  if (sorted.length === 0) throw new Error("empty_recovery_history");
  const latest = sorted[sorted.length - 1]!;
  if (
    latest.epoch !== epochSeconds(snapshot.tick.epoch) ||
    latest.digit !== snapshot.tick.digit ||
    Math.abs(latest.price - snapshot.tick.price) > Math.max(1e-10, Math.abs(latest.price) * 1e-12)
  ) {
    throw new Error("history_does_not_reach_live_tick");
  }

  // Do not splice observations across a prolonged feed gap. Keep only the
  // contiguous current regime, applying the same 3-tick tolerance as DigitTape.
  const maxGapSeconds = (expectedIntervalMs * 3) / 1000;
  let suffixStart = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.epoch - sorted[i - 1]!.epoch > maxGapSeconds) suffixStart = i;
  }
  return sorted.slice(suffixStart).slice(-maxSamples);
}

function normalizeContractType(contractType: string): string {
  return contractType === "RISE" ? "CALL"
    : contractType === "FALL" ? "PUT"
    : contractType;
}

function candidateDefinitions(
  contractTypes: readonly string[],
  recoveryOverBarrier: number,
  recoveryUnderBarrier: number,
): Array<{ contractType: string; barrier: number | null }> {
  const definitions: Array<{ contractType: string; barrier: number | null }> = [];
  const seen = new Set<string>();
  for (const input of contractTypes) {
    const contractType = normalizeContractType(input);
    const barriers = contractType === "DIGITMATCH" || contractType === "DIGITDIFF"
      ? Array.from({ length: 10 }, (_, digit) => digit)
      : contractType === "DIGITOVER" ? [recoveryOverBarrier]
      : contractType === "DIGITUNDER" ? [recoveryUnderBarrier]
      : [null];
    for (const barrier of barriers) {
      if (contractType === "DIGITOVER" && (!Number.isInteger(barrier) || barrier! < 0 || barrier! > 8)) continue;
      if (contractType === "DIGITUNDER" && (!Number.isInteger(barrier) || barrier! < 1 || barrier! > 9)) continue;
      if (!["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF"].includes(contractType)) continue;
      const key = `${contractType}|${barrier ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      definitions.push({ contractType, barrier });
    }
  }
  return definitions;
}

function theoreticalProbability(contractType: string, barrier: number | null): number {
  if (contractType === "DIGITOVER") return (9 - (barrier ?? 4)) / 10;
  if (contractType === "DIGITUNDER") return (barrier ?? 5) / 10;
  if (contractType === "DIGITMATCH") return 0.1;
  if (contractType === "DIGITDIFF") return 0.9;
  return 0.5;
}

function outcomeFor(
  sample: RecoveryMarketSample,
  expiry: RecoveryMarketSample,
  contractType: string,
  barrier: number | null,
): boolean {
  switch (contractType) {
    case "CALL": return expiry.price > sample.price;
    case "PUT": return expiry.price < sample.price;
    case "DIGITOVER": return expiry.digit > (barrier ?? 4);
    case "DIGITUNDER": return expiry.digit < (barrier ?? 5);
    case "DIGITEVEN": return expiry.digit % 2 === 0;
    case "DIGITODD": return expiry.digit % 2 === 1;
    case "DIGITMATCH": return expiry.digit === barrier;
    case "DIGITDIFF": return expiry.digit !== barrier;
    default: return false;
  }
}

/** Construct non-overlapping historical trades with the exact configured tick horizon. */
function historicalOutcomes(
  samples: readonly RecoveryMarketSample[],
  contractType: string,
  barrier: number | null,
  duration: number,
): boolean[] {
  const outcomes: boolean[] = [];
  for (let expiryIndex = samples.length - 1; expiryIndex >= duration; expiryIndex -= duration) {
    const entry = samples[expiryIndex - duration]!;
    const expiry = samples[expiryIndex]!;
    if (
      !Number.isFinite(entry.price) || entry.price <= 0 ||
      !Number.isFinite(expiry.price) || expiry.price <= 0 ||
      !Number.isInteger(expiry.digit) || expiry.digit < 0 || expiry.digit > 9
    ) continue;
    outcomes.push(outcomeFor(entry, expiry, contractType, barrier));
  }
  return outcomes.reverse();
}

/**
 * Estimate effective independent observations using a positive-lag
 * autocorrelation correction (Newey-West style). Negative estimated correlation
 * is not allowed to inflate sample size. Constant outcome streams are treated
 * as weak evidence because their dependence cannot be identified from variance.
 */
export function effectiveSampleSize(outcomes: readonly boolean[]): number {
  const n = outcomes.length;
  if (n < 2) return n;
  const values = outcomes.map((value) => value ? 1 : 0);
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  if (variance < 1e-12) return Math.max(1, Math.sqrt(n));

  const maxLag = Math.min(20, Math.max(1, Math.floor(Math.sqrt(n))));
  let dependenceInflation = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let covariance = 0;
    for (let i = 0; i < n - lag; i++) {
      covariance += (values[i]! - mean) * (values[i + lag]! - mean);
    }
    covariance /= n - lag;
    const rho = covariance / variance;
    if (!Number.isFinite(rho) || rho <= 0) break;
    const bartlettWeight = 1 - lag / (maxLag + 1);
    dependenceInflation += 2 * rho * bartlettWeight;
  }
  return Math.max(1, Math.min(n, n / dependenceInflation));
}

/** Acklam's inverse-normal approximation, used for a Bonferroni-adjusted bound. */
export function standardNormalQuantile(probability: number): number {
  const p = Math.max(1e-12, Math.min(1 - 1e-12, probability));
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01,
    -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01,
    2.445134137142996e+00, 3.754408661907416e+00,
  ];
  const low = 0.02425;
  const high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export function recoveryHypothesisCount(
  marketCount: number,
  contractTypes: readonly string[],
): number {
  const perMarket = candidateDefinitions(contractTypes, 4, 5).length;
  // Match/Diff barrier candidates are counted individually by candidateDefinitions.
  return Math.max(1, Math.max(0, marketCount) * perMarket);
}

export function evaluateRecoveryCandidates(input: {
  symbol: string;
  samples: readonly RecoveryMarketSample[];
  contractTypes: readonly string[];
  recoveryOverBarrier: number;
  recoveryUnderBarrier: number;
  durationFor: (contractType: string) => number;
  hypothesisCount: number;
  sourceGeneration: number;
  latestSequence: number;
  latestReceivedAt: number;
}): RecoveryCandidateV2[] {
  const definitions = candidateDefinitions(
    input.contractTypes,
    input.recoveryOverBarrier,
    input.recoveryUnderBarrier,
  );
  const tests = Math.max(1, input.hypothesisCount, definitions.length);
  const z = standardNormalQuantile(1 - RECOVERY_V2_FAMILYWISE_ALPHA / tests);

  return definitions.map(({ contractType, barrier }) => {
    const duration = Math.max(1, Math.min(100, Math.round(input.durationFor(contractType) || 1)));
    const outcomes = historicalOutcomes(input.samples, contractType, barrier, duration);
    const sampleSize = outcomes.length;
    const wins = outcomes.reduce((total, result) => total + (result ? 1 : 0), 0);
    const rawRate = sampleSize > 0 ? wins / sampleSize : theoreticalProbability(contractType, barrier);
    const effectiveN = effectiveSampleSize(outcomes);
    const priorP = theoreticalProbability(contractType, barrier);
    const effectiveWins = rawRate * effectiveN;
    const alpha = priorP * RECOVERY_V2_PRIOR_STRENGTH + effectiveWins;
    const beta = (1 - priorP) * RECOVERY_V2_PRIOR_STRENGTH + effectiveN - effectiveWins;
    const posteriorTotal = alpha + beta;
    const winProbability = posteriorTotal > 0 ? alpha / posteriorTotal : priorP;
    const posteriorVariance = posteriorTotal > 0
      ? (alpha * beta) / (posteriorTotal ** 2 * (posteriorTotal + 1))
      : 0.25;
    const uncertainty = Math.sqrt(Math.max(0, posteriorVariance));
    const lowerWinProbability = Math.max(0, winProbability - z * uncertainty);
    const upperWinProbability = Math.min(1, winProbability + z * uncertainty);

    return {
      symbol: input.symbol,
      contractType,
      barrier,
      duration,
      theoreticalWinProbability: priorP,
      winProbability,
      lowerWinProbability,
      upperWinProbability,
      uncertainty,
      sampleSize,
      effectiveSampleSize: effectiveN,
      wins,
      hypothesisCount: tests,
      sourceGeneration: input.sourceGeneration,
      latestSequence: input.latestSequence,
      latestReceivedAt: input.latestReceivedAt,
      payoutMultiplier: null,
      payoutSource: null,
      expectedValue: null,
      lowerExpectedValue: null,
      accepted: false,
      rejectionReason: effectiveN < RECOVERY_V2_MIN_EFFECTIVE_SAMPLES
        ? "insufficient_effective_samples"
        : null,
    };
  });
}

export function priceRecoveryCandidate(
  candidate: RecoveryCandidateV2,
  payoutMultiplier: number,
  payoutSource: "live" | "fallback",
  minimumExpectedValue = RECOVERY_V2_MIN_EXPECTED_VALUE,
): RecoveryCandidateV2 {
  if (!Number.isFinite(payoutMultiplier) || payoutMultiplier <= 1) {
    return {
      ...candidate,
      payoutMultiplier,
      payoutSource,
      accepted: false,
      rejectionReason: "invalid_payout",
    };
  }
  const expectedValue = candidate.winProbability * payoutMultiplier - 1;
  const lowerExpectedValue = candidate.lowerWinProbability * payoutMultiplier - 1;
  let rejectionReason = candidate.rejectionReason;
  if (!rejectionReason && payoutSource !== "live") rejectionReason = "live_payout_unavailable";
  if (!rejectionReason && lowerExpectedValue < minimumExpectedValue) {
    rejectionReason = "lower_confidence_ev_below_minimum";
  }
  return {
    ...candidate,
    payoutMultiplier,
    payoutSource,
    expectedValue,
    lowerExpectedValue,
    accepted: rejectionReason === null,
    rejectionReason,
  };
}

export function compareRecoveryCandidates(a: RecoveryCandidateV2, b: RecoveryCandidateV2): number {
  const evA = a.lowerExpectedValue ?? Number.NEGATIVE_INFINITY;
  const evB = b.lowerExpectedValue ?? Number.NEGATIVE_INFINITY;
  return evB - evA || b.effectiveSampleSize - a.effectiveSampleSize || b.winProbability - a.winProbability;
}

/**
 * Quarter-Kelly sizing using the conservative probability bound, capped by the
 * configured normal stake, maxTradeStake, maxRiskPerTrade, 0.5% of verified
 * available balance, and outstanding debt itself. Debt can cap stake but never increase it.
 */
export function calculateRecoveryV2Stake(input: {
  candidate: RecoveryCandidateV2;
  balance: number;
  baseStake: number;
  maxTradeStake: number;
  maxRiskPerTrade?: number;
  unrecoveredDebt: number;
}): { stake: number; riskCap: number; kellyFraction: number; reason: string | null } {
  const { candidate } = input;
  const payout = Number(candidate.payoutMultiplier);
  const p = candidate.lowerWinProbability;
  const balance = Number.isFinite(input.balance) && input.balance > 0 ? input.balance : 0;
  const baseStake = Number.isFinite(input.baseStake) && input.baseStake > 0 ? input.baseStake : 0;
  const maxTradeStake = Number.isFinite(input.maxTradeStake) && input.maxTradeStake > 0
    ? input.maxTradeStake
    : 0;
  const maxRiskPerTrade = Number.isFinite(input.maxRiskPerTrade) && Number(input.maxRiskPerTrade) >= 0
    ? Number(input.maxRiskPerTrade)
    : Number.POSITIVE_INFINITY;
  const unrecoveredDebt = Number.isFinite(input.unrecoveredDebt) && input.unrecoveredDebt > 0
    ? input.unrecoveredDebt
    : 0;
  if (!candidate.accepted || !Number.isFinite(payout) || payout <= 1 || balance <= 0 || unrecoveredDebt <= 0) {
    return { stake: 0, riskCap: 0, kellyFraction: 0, reason: "candidate_or_balance_not_eligible" };
  }

  const netOdds = payout - 1;
  const kellyFraction = Math.max(0, Math.min(1, (payout * p - 1) / netOdds));
  const riskCap = Math.min(
    baseStake,
    maxTradeStake,
    maxRiskPerTrade,
    balance * RECOVERY_V2_MAX_ACCOUNT_RISK_FRACTION,
    unrecoveredDebt,
  );
  const rawKellyStake = balance * kellyFraction * RECOVERY_V2_FRACTIONAL_KELLY;
  const stake = Math.floor((Math.min(rawKellyStake, riskCap) + 1e-9) * 100) / 100;
  if (!Number.isFinite(stake) || stake < RECOVERY_V2_MIN_STAKE) {
    return { stake: 0, riskCap, kellyFraction, reason: "edge_sized_stake_below_minimum" };
  }
  return { stake, riskCap, kellyFraction, reason: null };
}

/** Return a reason when the live account proposal fails recovery v2 revalidation. */
export function recoveryExecutionProposalRejection(input: {
  guard: RecoveryExecutionGuard;
  proposal: RecoveryExecutionProposal;
  latestTick: DigitTick | null | undefined;
  now?: number;
}): string | null {
  const { guard, proposal, latestTick } = input;
  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(guard.lowerWinProbability) || guard.lowerWinProbability < 0 || guard.lowerWinProbability > 1 ||
    !Number.isFinite(guard.minimumExpectedValue) ||
    !Number.isFinite(guard.maxStake) || guard.maxStake < RECOVERY_V2_MIN_STAKE
  ) return "invalid_recovery_guard";
  if (!Number.isFinite(proposal.askPrice) || proposal.askPrice < RECOVERY_V2_MIN_STAKE) {
    return "invalid_or_subminimum_live_ask";
  }
  if (!Number.isFinite(proposal.payout) || proposal.payout <= proposal.askPrice) {
    return "invalid_live_payout";
  }
  if (proposal.askPrice > guard.maxStake + 1e-6) return "live_ask_exceeds_risk_cap";
  if (!latestTick || latestTick.source !== "live") return "execution_feed_not_live";
  if (latestTick.generation !== guard.expectedGeneration) return "execution_feed_generation_changed";
  if (latestTick.sequence < guard.minimumSequence) return "execution_tick_sequence_regressed";
  const tickAge = now - latestTick.receivedAt;
  if (tickAge < -1_000 || tickAge > guard.maxTickAgeMs) return "execution_feed_stale";

  const payoutMultiplier = proposal.payout / proposal.askPrice;
  const liveExpectedValue = guard.lowerWinProbability * payoutMultiplier - 1;
  if (!Number.isFinite(liveExpectedValue) || liveExpectedValue < guard.minimumExpectedValue) {
    return "live_quote_ev_below_minimum";
  }
  return null;
}

/** Compact, reproducible decision text stored with the trade record. */
export function describeRecoveryCandidate(candidate: RecoveryCandidateV2): string {
  const barrier = candidate.barrier == null ? "" : ` barrier=${candidate.barrier}`;
  const payout = candidate.payoutMultiplier == null ? "n/a" : candidate.payoutMultiplier.toFixed(4);
  const ev = candidate.expectedValue == null ? "n/a" : `${(candidate.expectedValue * 100).toFixed(2)}%`;
  const lowerEv = candidate.lowerExpectedValue == null ? "n/a" : `${(candidate.lowerExpectedValue * 100).toFixed(2)}%`;
  return `Recovery v2 ${candidate.contractType}${barrier} ${candidate.symbol}: ` +
    `p=${(candidate.winProbability * 100).toFixed(2)}%, ` +
    `LCB=${(candidate.lowerWinProbability * 100).toFixed(2)}%, ` +
    `uncertainty=±${(candidate.uncertainty * 100).toFixed(2)}pp, ` +
    `effectiveN=${candidate.effectiveSampleSize.toFixed(1)}/${candidate.sampleSize}, ` +
    `payout=${payout} (${candidate.payoutSource ?? "unquoted"}), EV=${ev}, lowerEV=${lowerEv}`;
}
