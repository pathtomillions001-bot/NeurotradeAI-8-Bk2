/**
 * Conservative, outcome-based quality checks for the autonomous recovery path.
 *
 * Consensus is used only to identify a stable candidate. This module estimates
 * how often that exact contract would have won at the selected expiry from the
 * same live tick generation, adjusts the nominal sample size for serial
 * dependence, and compares a one-sided Wilson lower bound with the broker's
 * gross payout multiplier. It deliberately does not size or change recovery
 * stakes; Split/Instant sizing remains in recovery-engine.ts.
 */

export type RecoveryContractType =
  | "CALL" | "PUT" | "RISE" | "FALL"
  | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF";

export interface RecoveryTickLike {
  source: "live" | "simulated";
  generation: number;
  sequence: number;
  receivedAt: number;
  digit: number;
  price: number;
}

export interface RecoverySnapshotLike {
  tick: RecoveryTickLike;
  ticks: RecoveryTickLike[];
}

export interface RecoveryProbabilityEstimate {
  wins: number;
  observations: number;
  probability: number;
  effectiveSampleSize: number;
  lowerWinProbability: number;
  confidenceZ: number;
}

export interface RecoveryEconomics {
  payoutMultiplier: number;
  breakEvenProbability: number;
  expectedValueLowerBound: number;
  acceptable: boolean;
  rejectionReason: string | null;
}

const DEFAULT_WILSON_Z = 1.96;
// Ten possible digit barriers are searched for Match/Diff. This Bonferroni
// lower-bound adjustment reduces the winner's-curse from choosing a digit on
// the same observed sample. It is not a substitute for later walk-forward tests.
const DIGIT_SELECTION_WILSON_Z = 2.576;
export const MIN_RECOVERY_EFFECTIVE_SAMPLE_SIZE = 20;

export function recoveryDurationFor(contractType: string, configuredDuration: number): number {
  const duration = Number.isFinite(configuredDuration) ? Math.round(configuredDuration) : 5;
  const safeDuration = Math.max(1, duration);
  if (contractType === "DIGITEVEN" || contractType === "DIGITODD") return Math.max(5, safeDuration);
  if (contractType === "DIGITMATCH" || contractType === "DIGITDIFF") return Math.min(5, safeDuration);
  return safeDuration;
}

/** Validate source, freshness and generation before using a tick tape. */
export function isUsableRecoverySnapshot(
  snapshot: RecoverySnapshotLike | null | undefined,
  options: {
    expectedSource: "live" | "simulated";
    minTicks: number;
    maxAgeMs: number;
    nowMs?: number;
    expectedGeneration?: number;
    minimumSequence?: number;
  },
): boolean {
  if (!snapshot || !snapshot.tick || !Array.isArray(snapshot.ticks)) return false;
  const now = options.nowMs ?? Date.now();
  const latest = snapshot.tick;
  if (latest.source !== options.expectedSource || !Number.isFinite(latest.receivedAt)) return false;
  if (latest.receivedAt > now || now - latest.receivedAt > options.maxAgeMs) return false;
  if (!Number.isInteger(latest.generation) || latest.generation < 1) return false;
  if (!Number.isInteger(latest.sequence) || latest.sequence < 1) return false;
  if (options.expectedGeneration !== undefined && latest.generation !== options.expectedGeneration) return false;
  if (options.minimumSequence !== undefined && latest.sequence < options.minimumSequence) return false;
  if (snapshot.ticks.length < options.minTicks) return false;
  const last = snapshot.ticks[snapshot.ticks.length - 1];
  if (!last || last.sequence !== latest.sequence || last.generation !== latest.generation || last.source !== latest.source) return false;
  let previousSequence = 0;
  return snapshot.ticks.every((tick) => {
    const valid = tick.source === options.expectedSource &&
      tick.generation === latest.generation &&
      Number.isInteger(tick.sequence) && tick.sequence > previousSequence &&
      Number.isInteger(tick.digit) && tick.digit >= 0 && tick.digit <= 9 &&
      Number.isFinite(tick.price) && tick.price > 0;
    previousSequence = tick.sequence;
    return valid;
  });
}

function estimateEffectiveSampleSize(outcomes: boolean[], maxLag = 20): number {
  const n = outcomes.length;
  if (n < 2) return n;
  const values = outcomes.map((v) => v ? 1 : 0);
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  // A constant run is not independent evidence for a near-certain event.
  if (variance <= 1e-12) return 1;

  const limit = Math.min(maxLag, Math.floor(n / 4));
  let positiveAutocorrelation = 0;
  for (let lag = 1; lag <= limit; lag++) {
    let covariance = 0;
    for (let i = lag; i < n; i++) covariance += (values[i] - mean) * (values[i - lag] - mean);
    const rho = covariance / variance;
    // Initial-positive-sequence truncation: don't let noisy negative lags
    // manufacture a larger effective sample.
    if (!Number.isFinite(rho) || rho <= 0) break;
    positiveAutocorrelation += rho;
  }
  return Math.max(1, Math.min(n, n / (1 + 2 * positiveAutocorrelation)));
}

/** One-sided Wilson score lower bound using an effective sample size. */
export function wilsonLowerBound(probability: number, sampleSize: number, z = DEFAULT_WILSON_Z): number {
  if (!Number.isFinite(probability) || !Number.isFinite(sampleSize) || sampleSize <= 0 || !Number.isFinite(z) || z <= 0) return 0;
  const p = Math.max(0, Math.min(1, probability));
  const z2 = z * z;
  const denominator = 1 + z2 / sampleSize;
  const center = p + z2 / (2 * sampleSize);
  const margin = z * Math.sqrt((p * (1 - p)) / sampleSize + z2 / (4 * sampleSize * sampleSize));
  return Math.max(0, Math.min(1, (center - margin) / denominator));
}

/** Acklam's inverse-normal approximation; used for a per-scan Bonferroni bound. */
function inverseNormalCdf(probability: number): number {
  const p = Math.max(1e-12, Math.min(1 - 1e-12, probability));
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Recompute the lower bound after selecting from several candidate markets and
 * contract families. Uses a 2.5% one-sided family error budget; Match/Diff also
 * account for choosing among ten digits.
 */
export function adjustRecoveryEstimateForSelection(
  estimate: RecoveryProbabilityEstimate,
  candidateCount: number,
  digitChoices = 1,
): RecoveryProbabilityEstimate {
  const comparisons = Math.max(1, Math.round(candidateCount)) * Math.max(1, Math.round(digitChoices));
  const alphaPerComparison = 0.025 / comparisons;
  const confidenceZ = inverseNormalCdf(1 - alphaPerComparison);
  return {
    ...estimate,
    confidenceZ,
    lowerWinProbability: wilsonLowerBound(estimate.probability, estimate.effectiveSampleSize, confidenceZ),
  };
}

function isDigitContract(contractType: string): boolean {
  return contractType.startsWith("DIGIT");
}

function isWinningDigit(contractType: string, digit: number, barrier: number | null): boolean {
  switch (contractType) {
    case "DIGITOVER": return barrier !== null && digit > barrier;
    case "DIGITUNDER": return barrier !== null && digit < barrier;
    case "DIGITEVEN": return digit % 2 === 0;
    case "DIGITODD": return digit % 2 === 1;
    case "DIGITMATCH": return barrier !== null && digit === barrier;
    case "DIGITDIFF": return barrier !== null && digit !== barrier;
    default: return false;
  }
}

/**
 * Estimate wins for the exact contract and expiry from historical terminal
 * outcomes. For digit contracts, each observation is the digit at the selected
 * number of ticks after a historical entry. For CALL/PUT, it compares entry and
 * expiry prices. Overlapping outcomes are retained, then serial dependence is
 * reflected in effectiveSampleSize rather than counted as independent votes.
 */
export function estimateRecoveryProbability(input: {
  contractType: RecoveryContractType | string;
  barrier: number | null;
  duration: number;
  digits: number[];
  prices: number[];
}): RecoveryProbabilityEstimate | null {
  const duration = Math.max(1, Math.round(input.duration));
  const outcomes: boolean[] = [];

  if (isDigitContract(input.contractType)) {
    if (input.barrier !== null && (!Number.isInteger(input.barrier) || input.barrier < 0 || input.barrier > 9)) return null;
    if (input.digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)) return null;
    for (let entry = 0; entry + duration < input.digits.length; entry++) {
      outcomes.push(isWinningDigit(input.contractType, input.digits[entry + duration], input.barrier));
    }
  } else if (["CALL", "RISE", "PUT", "FALL"].includes(input.contractType)) {
    if (input.prices.some((price) => !Number.isFinite(price) || price <= 0)) return null;
    for (let entry = 0; entry + duration < input.prices.length; entry++) {
      const start = input.prices[entry];
      const expiry = input.prices[entry + duration];
      outcomes.push(input.contractType === "CALL" || input.contractType === "RISE"
        ? expiry > start
        : expiry < start);
    }
  } else {
    return null;
  }

  if (outcomes.length === 0) return null;
  const wins = outcomes.filter(Boolean).length;
  const probability = wins / outcomes.length;
  const effectiveSampleSize = estimateEffectiveSampleSize(outcomes, Math.max(20, duration * 3));
  const confidenceZ = input.contractType === "DIGITMATCH" || input.contractType === "DIGITDIFF"
    ? DIGIT_SELECTION_WILSON_Z
    : DEFAULT_WILSON_Z;

  return {
    wins,
    observations: outcomes.length,
    probability,
    effectiveSampleSize,
    lowerWinProbability: wilsonLowerBound(probability, effectiveSampleSize, confidenceZ),
    confidenceZ,
  };
}

/**
 * Compare a conservative probability bound with the exact gross payout.
 * M includes the original stake, so EV per unit stake is p*M - 1 and
 * break-even is 1/M.
 */
export function evaluateRecoveryEconomics(
  estimate: RecoveryProbabilityEstimate | null,
  payoutMultiplier: number,
  minEffectiveSampleSize = MIN_RECOVERY_EFFECTIVE_SAMPLE_SIZE,
): RecoveryEconomics {
  if (!Number.isFinite(payoutMultiplier) || payoutMultiplier <= 1) {
    return {
      payoutMultiplier,
      breakEvenProbability: Number.POSITIVE_INFINITY,
      expectedValueLowerBound: Number.NEGATIVE_INFINITY,
      acceptable: false,
      rejectionReason: "invalid_payout",
    };
  }
  if (!estimate || estimate.effectiveSampleSize < minEffectiveSampleSize) {
    return {
      payoutMultiplier,
      breakEvenProbability: 1 / payoutMultiplier,
      expectedValueLowerBound: Number.NEGATIVE_INFINITY,
      acceptable: false,
      rejectionReason: "insufficient_effective_sample",
    };
  }
  const breakEvenProbability = 1 / payoutMultiplier;
  const expectedValueLowerBound = estimate.lowerWinProbability * payoutMultiplier - 1;
  const acceptable = Number.isFinite(expectedValueLowerBound) && expectedValueLowerBound > 0;
  return {
    payoutMultiplier,
    breakEvenProbability,
    expectedValueLowerBound,
    acceptable,
    rejectionReason: acceptable ? null : "conservative_ev_not_positive",
  };
}
