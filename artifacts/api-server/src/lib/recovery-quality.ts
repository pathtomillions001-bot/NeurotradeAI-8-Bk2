/** Recovery policy v2. Pure, broker-independent analysis; no debt enters prediction.
 * Chronological selection/evaluation, exact expiry labels and shrinkage prevent
 * the old overlapping-window vote from masquerading as independent evidence.
 * Bounds are conservative screening estimates, NOT sequential coverage guarantees.
 */
import type { DigitSnapshot } from "./digit-tape";
import { getFallbackPayout } from "./payouts";

export const RECOVERY_POLICY = Object.freeze({
  history: 4000,
  minimumHistory: 500,
  minimumValidation: 100,
  minimumEdge: 0.01,
  maxBalanceFraction: 0.005,
  kellyFraction: 0.25,
  minimumStake: 0.35,
  quoteLifetimeMs: 2500,
});
export interface RecoveryCandidate {
  symbol: string;
  contractType: string;
  barrier: number | null;
  duration: number;
  probability: number;
  lowerProbability: number;
  payoutMultiplier: number;
  conservativeEV: number;
  growth: number;
  qualified: boolean;
  reason: string;
  samples: number;
  effectiveSamples: number;
  model: "baseline" | "validated-markov" | "validated-direction";
  validationBrier: number;
  baselineBrier: number;
  generation: number;
  sequence: number;
}
export function recoveryDuration(type: string, configured: number): number {
  const d = Math.max(
    1,
    Math.min(15, Math.round(Number.isFinite(configured) ? configured : 5)),
  );
  return type === "DIGITEVEN" || type === "DIGITODD"
    ? Math.max(5, d)
    : type === "DIGITMATCH" || type === "DIGITDIFF"
      ? Math.min(5, d)
      : d;
}
export function feedProblem(
  snapshot: DigitSnapshot | null,
  periodMs: number,
  live: boolean,
  now = Date.now(),
): string | null {
  if (!snapshot) return "Gathering market history";
  const { tick, ticks } = snapshot;
  if (live && tick.source !== "live") return "Live trading requires live data";
  if (
    now - tick.receivedAt > Math.max(2500, periodMs * 2.5) ||
    tick.receivedAt > now + 1000 ||
    (live &&
      (now - tick.epoch * 1000 > Math.max(3500, periodMs * 3) ||
        tick.epoch * 1000 > now + 1000))
  )
    return "Market feed is stale";
  if (
    ticks.some(
      (t, i) =>
        t.source !== tick.source ||
        t.generation !== tick.generation ||
        !Number.isFinite(t.price) ||
        t.price <= 0 ||
        !Number.isInteger(t.digit) ||
        t.digit < 0 ||
        t.digit > 9 ||
        (i > 0 &&
          (t.sequence !== ticks[i - 1].sequence + 1 ||
            (live && t.epoch <= ticks[i - 1].epoch))),
    )
  )
    return "Invalid or discontinuous history";
  return null;
}
const average = (a: number[]) =>
  a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
/** Positive autocorrelation reduces sample size; never increases it. */
export function effectiveSampleSize(ys: number[]): number {
  const m = average(ys),
    variance = ys.reduce((s, y) => s + (y - m) ** 2, 0);
  if (!variance) return Math.max(1, ys.length / 2); // perfect runs are not unlimited certainty
  let inflation = 1;
  for (let lag = 1; lag <= Math.min(10, Math.floor(ys.length / 5)); lag++) {
    let cov = 0;
    for (let i = lag; i < ys.length; i++)
      cov += (ys[i] - m) * (ys[i - lag] - m);
    inflation += 2 * Math.max(0, cov / variance);
  }
  return Math.max(1, ys.length / inflation);
}
/** Wilson lower bound; deliberately conservative tail factor adjusted for scan breadth. */
export function lowerBound(
  rate: number,
  n: number,
  candidates: number,
): number {
  if (!(n > 0) || !Number.isFinite(rate)) return 0;
  const z = Math.sqrt(2 * Math.log(Math.max(1, candidates) / 0.025));
  const z2 = z * z;
  return Math.max(
    0,
    (rate +
      z2 / (2 * n) -
      z * Math.sqrt((rate * (1 - rate)) / n + z2 / (4 * n * n))) /
      (1 + z2 / n),
  );
}
function winDigit(type: string, barrier: number | null, d: number): boolean {
  switch (type) {
    case "DIGITOVER":
      return d > barrier!;
    case "DIGITUNDER":
      return d < barrier!;
    case "DIGITEVEN":
      return d % 2 === 0;
    case "DIGITODD":
      return d % 2 !== 0;
    case "DIGITMATCH":
      return d === barrier;
    case "DIGITDIFF":
      return d !== barrier;
    default:
      return false;
  }
}
function horizonRow(matrix: number[][], state: number, h: number): number[] {
  let row: number[] = matrix.map((_, i) => (i === state ? 1 : 0));
  for (let t = 0; t < h; t++)
    row = row.map((_, j) => row.reduce((s, p, i) => s + p * matrix[i][j], 0));
  return row;
}
export function analyseRecoveryCandidate(input: {
  snapshot: DigitSnapshot;
  contractType: string;
  barrier?: number | null;
  duration: number;
  candidateCount: number;
  payoutMultiplier?: number;
}): RecoveryCandidate {
  const { snapshot, contractType: type, candidateCount } = input;
  const ticks = snapshot.ticks.slice(-RECOVERY_POLICY.history),
    h = recoveryDuration(type, input.duration);
  const direction = type === "CALL" || type === "PUT";
  const split = Math.floor(ticks.length * 0.5);
  const train = ticks.slice(0, split);
  let barrier = input.barrier ?? null;
  // Digit selection uses TRAINING ONLY. All evaluation labels refer to this digit.
  if (type === "DIGITMATCH" || type === "DIGITDIFF") {
    if (barrier == null) {
      const counts = Array(10).fill(0);
      train.forEach((t) => counts[t.digit]++);
      barrier = counts.indexOf(
        type === "DIGITMATCH" ? Math.max(...counts) : Math.min(...counts),
      );
    }
  }
  const payout = input.payoutMultiplier ?? getFallbackPayout(type, barrier);
  const supported = [
    "CALL",
    "PUT",
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITEVEN",
    "DIGITODD",
    "DIGITMATCH",
    "DIGITDIFF",
  ].includes(type);
  const validBarrier =
    type === "DIGITOVER"
      ? Number.isInteger(barrier) && barrier! >= 0 && barrier! <= 8
      : type === "DIGITUNDER"
        ? Number.isInteger(barrier) && barrier! >= 1 && barrier! <= 9
        : type === "DIGITMATCH" || type === "DIGITDIFF"
          ? Number.isInteger(barrier) && barrier! >= 0 && barrier! <= 9
          : true;
  const theoretical = direction
    ? 0.5
    : Array.from({ length: 10 }, (_, d) => +winDigit(type, barrier, d)).reduce(
        (a, b) => a + b,
        0,
      ) / 10;
  const outcome = (i: number) =>
    direction
      ? +(type === "CALL"
          ? ticks[i + h].price > ticks[i].price
          : ticks[i + h].price < ticks[i].price)
      : +winDigit(type, barrier, ticks[i + h].digit);
  const stateAt = (i: number) =>
    direction
      ? Math.sign(ticks[i].price - ticks[Math.max(0, i - 1)].price) + 1
      : type === "DIGITMATCH" || type === "DIGITDIFF"
        ? ticks[i].digit
        : +winDigit(type, barrier, ticks[i].digit);
  const states = direction
    ? 3
    : type === "DIGITMATCH" || type === "DIGITDIFF"
      ? 10
      : 2;
  const trainingY: number[] = [];
  const conditional = Array.from({ length: states }, () => ({ wins: 0, n: 0 }));
  for (let i = 1; i + h < split; i += h) {
    const y = outcome(i);
    trainingY.push(y);
    conditional[stateAt(i)].wins += y;
    conditional[stateAt(i)].n++;
  }
  const base =
    (trainingY.reduce((a, b) => a + b, 0) + theoretical * 20) /
    (trainingY.length + 20);
  const counts = Array.from({ length: states }, () => Array(states).fill(0));
  for (let i = 2; i < split; i++) counts[stateAt(i - 1)][stateAt(i)]++;
  const prior = Array(states).fill(states === 2 ? 0 : 1 / states);
  if (states === 2) {
    prior[0] = 1 - base;
    prior[1] = base;
  }
  const matrix = counts.map((row) =>
    row.map(
      (n, j) => (n + 30 * prior[j]) / (row.reduce((a, b) => a + b, 0) + 30),
    ),
  );
  const predict = (state: number) => {
    if (direction)
      return (
        (conditional[state].wins + 30 * base) / (conditional[state].n + 30)
      );
    const row = horizonRow(matrix, state, h);
    return states === 2
      ? row[1]
      : row.reduce((s, p, d) => s + p * +winDigit(type, barrier, d), 0);
  };
  const current = ticks.length > 1 ? stateAt(ticks.length - 1) : 0;
  const validationStart = Math.floor(ticks.length * 0.75);
  let modelError = 0,
    baseError = 0,
    calibrationN = 0;
  for (let i = split; i + h < validationStart; i += h) {
    const y = outcome(i);
    calibrationN++;
    modelError += (predict(stateAt(i)) - y) ** 2;
    baseError += (base - y) ** 2;
  }
  const brier = modelError / Math.max(1, calibrationN),
    baselineBrier = baseError / Math.max(1, calibrationN);
  const validated =
    calibrationN >= RECOVERY_POLICY.minimumValidation &&
    brier < baselineBrier * 0.98;
  const ys: number[] = [],
    matching: number[] = [];
  for (let i = validationStart; i + h < ticks.length; i += h) {
    const y = outcome(i);
    ys.push(y);
    if (stateAt(i) === current) matching.push(y);
  }
  // Select the model BEFORE evaluating held-out outcomes. A conditional model
  // with insufficient support waits; do not cherry-pick a baseline afterwards.
  const evidence = validated ? matching : ys;
  const n = effectiveSampleSize(evidence),
    rate = average(evidence);
  const posterior =
    (evidence.reduce((a, b) => a + b, 0) + theoretical * 20) /
    (evidence.length + 20);
  const probability = Math.min(posterior, validated ? predict(current) : base);
  const recent = evidence.slice(-Math.max(20, Math.floor(evidence.length / 3)));
  // Deterioration is a soft probability penalty, not another unanimity gate.
  const driftPenalty = Math.max(0, rate - average(recent));
  const lowerProbability = Math.max(
    0,
    Math.min(probability, lowerBound(rate, n, candidateCount * 2)) -
      driftPenalty,
  );
  const conservativeEV = payout * lowerProbability - 1;
  const f = Math.max(
    0,
    Math.min(
      RECOVERY_POLICY.maxBalanceFraction,
      (RECOVERY_POLICY.kellyFraction * conservativeEV) / (payout - 1),
    ),
  );
  const growth =
    f > 0
      ? lowerProbability * Math.log1p(f * (payout - 1)) +
        (1 - lowerProbability) * Math.log1p(-f)
      : 0;
  const reason =
    !supported || !validBarrier
      ? "Invalid recovery contract"
      : ticks.length < RECOVERY_POLICY.minimumHistory ||
          evidence.length < RECOVERY_POLICY.minimumValidation
        ? `Gathering evidence (${evidence.length}/${RECOVERY_POLICY.minimumValidation} expiry observations)`
        : !Number.isFinite(payout) || payout <= 1
          ? "Invalid payout"
          : conservativeEV < RECOVERY_POLICY.minimumEdge
            ? `Insufficient conservative edge (${(conservativeEV * 100).toFixed(2)}%; need 1%)`
            : "Qualified: held-out evidence and payout-adjusted edge";
  return {
    symbol: snapshot.tick.symbol,
    contractType: type,
    barrier,
    duration: h,
    probability,
    lowerProbability,
    payoutMultiplier: payout,
    conservativeEV,
    growth,
    qualified: reason.startsWith("Qualified"),
    reason,
    samples: evidence.length,
    effectiveSamples: n,
    model: validated
      ? direction
        ? "validated-direction"
        : "validated-markov"
      : "baseline",
    validationBrier: brier,
    baselineBrier,
    generation: snapshot.tick.generation,
    sequence: snapshot.tick.sequence,
  };
}
/** Limits round DOWN. Below-minimum budget means wait, never force $0.35. */
export function sizeRecovery(input: {
  candidate: RecoveryCandidate;
  balance: number;
  debt: number;
  baseStake: number;
  maxStake: number;
  dailyRemaining: number;
  drawdownRemaining: number;
}): number {
  const c = input.candidate;
  if (
    !c.qualified ||
    ![
      input.balance,
      input.debt,
      input.baseStake,
      input.maxStake,
      input.dailyRemaining,
      input.drawdownRemaining,
    ].every((v) => Number.isFinite(v) && v > 0)
  )
    return 0;
  const kelly = Math.max(
    0,
    (c.payoutMultiplier * c.lowerProbability - 1) / (c.payoutMultiplier - 1),
  );
  const cap = Math.min(
    input.balance * RECOVERY_POLICY.maxBalanceFraction,
    input.balance * RECOVERY_POLICY.kellyFraction * kelly,
    input.maxStake,
    input.baseStake,
    input.dailyRemaining,
    input.drawdownRemaining,
    Math.max(
      RECOVERY_POLICY.minimumStake,
      input.debt / (c.payoutMultiplier - 1),
    ),
  );
  const stake = Math.floor((cap + 1e-9) * 100) / 100;
  return stake >= RECOVERY_POLICY.minimumStake ? stake : 0;
}

/** Shared market-only cache. Debt/account state is deliberately not cached. */
const analysisCache = new Map<string, RecoveryCandidate>();
export function cachedRecoveryCandidate(
  input: Parameters<typeof analyseRecoveryCandidate>[0],
): RecoveryCandidate {
  const s = input.snapshot;
  const key = [
    s.tick.symbol,
    s.tick.source,
    s.tick.generation,
    s.tick.sequence,
    s.ticks.length,
    s.ticks[0]?.epoch,
    input.contractType,
    input.barrier ?? "",
    input.duration,
    input.candidateCount,
    input.payoutMultiplier ?? "fallback",
  ].join(":");
  const hit = analysisCache.get(key);
  if (hit) return { ...hit };
  const value = analyseRecoveryCandidate(input);
  if (analysisCache.size >= 1024)
    analysisCache.delete(analysisCache.keys().next().value!);
  analysisCache.set(key, value);
  return { ...value };
}
