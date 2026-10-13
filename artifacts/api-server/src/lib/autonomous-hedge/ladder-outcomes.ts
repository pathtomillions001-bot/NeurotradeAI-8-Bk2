/**
 * M2 — Recovery Episode Simulator & Cache (`ladder-outcomes.ts`).
 *
 * Pure Monte Carlo simulator for 1-tick recovery episodes that calls the REAL
 * `calculateRecoveryStakeRequest`, `applyRecoveryStakeLimits`, and
 * `settleRecoveryWin` from `../recovery-math` on each simulated step (never
 * re-deriving ladder formulas).
 *
 * Uses Common Random Numbers (CRN) indexed by `(pathIdx, stepIdx)` across
 * candidates so differences are variance-reduced and monotone in `p`, and
 * Rao-Blackwellizes `meanPnl` via Wald's identity `(p * payout - 1) * E[totalStake]`.
 * Caches results keyed by `(mode params, debt in cents, targetRemaining in cents,
 * p bucket 0.005, payout 2dp, nStop)`.
 */

import {
  addMoney,
  applyRecoveryStakeLimits,
  calculateRecoveryStakeRequest,
   recoveryTargetProfitFor,
  settleRecoveryWin,
  toCents,
} from "../recovery-math";
import { mulberry32 } from "./constants";

export interface SimulateEpisodeInput {
  p: number;
  payout: number;
  method: "split" | "instant";
  autoMode: boolean;
  multiplier: number;
  step: number;
  maxRecoverySteps?: number;
  debt: number;
  targetRemaining: number;
  base: number;
  maxTradeStake: number;
  balance: number;
  nStop: number;
  paths?: number;
  horizon?: number;
  seed?: number;
}

export interface EpisodeStats {
  meanPnl: number;
  es5: number;
  pStop: number;
  pCapHit: number;
  meanTrades: number;
}

interface InternalEpisodeResult extends EpisodeStats {
  meanTotalStake: number;
}

const DEFAULT_PATHS = 2000;
const DEFAULT_HORIZON = 40;
const DEFAULT_SEED = 0x9e3779b9;
const MAX_CACHE_ENTRIES = 8192;
const P_BUCKET_STEP = 0.005;

// Precomputed Common Random Numbers table for default (paths=2000, horizon=40, seed=DEFAULT_SEED)
// Indexed by pathIdx * DEFAULT_HORIZON + h so path i step h uses the exact same uniform draw
// across all candidates regardless of when earlier paths terminate.
const DEFAULT_CRN_UNIFORMS: Float64Array = (() => {
  const rng = mulberry32(DEFAULT_SEED);
  const arr = new Float64Array(DEFAULT_PATHS * DEFAULT_HORIZON);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = rng();
  }
  return arr;
})();

const episodeCache = new Map<string, InternalEpisodeResult>();
let lastSettingsSignature = "";

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function bucketPIndex(p: number): number {
  const clamped = clamp(p, 0.001, 0.999);
  return Math.round(clamped / P_BUCKET_STEP);
}

function roundPayout2dp(payout: number): number {
  return Math.round(payout * 100) / 100;
}

function buildCacheKey(input: SimulateEpisodeInput, pBucketIdx: number): string {
  const pBucket = (pBucketIdx * P_BUCKET_STEP).toFixed(3);
  const payout2dp = roundPayout2dp(input.payout).toFixed(2);
  const debtCents = Math.max(0, toCents(input.debt));
  const targetCents = Math.max(0, toCents(input.targetRemaining));
  const baseCents = Math.max(35, toCents(input.base));
  const capCents = Number.isFinite(input.maxTradeStake) && input.maxTradeStake > 0
    ? toCents(input.maxTradeStake)
    : -1;
  const balCents = Number.isFinite(input.balance) && input.balance > 0
    ? Math.min(100_000_00, Math.round(toCents(input.balance) / 100) * 100)
    : -1;
  const mult2dp = Math.round((input.multiplier || 1) * 100);
  const maxSteps = input.maxRecoverySteps ?? 3;
  const step = Math.max(1, Math.floor(input.step || 1));
  const nStop = Math.max(1, Math.floor(input.nStop || 1));
  const paths = input.paths ?? DEFAULT_PATHS;
  const horizon = input.horizon ?? DEFAULT_HORIZON;
  const seed = input.seed ?? DEFAULT_SEED;
  return `${input.method}:${input.autoMode ? 1 : 0}:${mult2dp}:${step}:${maxSteps}:${debtCents}:${targetCents}:${baseCents}:${capCents}:${balCents}:${pBucket}:${payout2dp}:${nStop}:${paths}:${horizon}:${seed}`;
}

/**
 * Invalidate the episode outcome cache on settlement or settings change.
 */
export function invalidateLadderOutcomeCache(newSettingsSignature?: string): void {
  if (newSettingsSignature !== undefined) {
    if (newSettingsSignature === lastSettingsSignature) return;
    lastSettingsSignature = newSettingsSignature;
  }
  episodeCache.clear();
}

export function clearLadderOutcomeCache(): void {
  episodeCache.clear();
}

export function getLadderOutcomeCacheSize(): number {
  return episodeCache.size;
}

function getUniformTable(paths: number, horizon: number, seed: number): Float64Array {
  if (paths === DEFAULT_PATHS && horizon === DEFAULT_HORIZON && seed === DEFAULT_SEED) {
    return DEFAULT_CRN_UNIFORMS;
  }
  const rng = mulberry32(seed);
  const arr = new Float64Array(paths * horizon);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = rng();
  }
  return arr;
}

function runSimulation(input: SimulateEpisodeInput): InternalEpisodeResult {
  const p = clamp(input.p, 0.001, 0.999);
  const payout = Math.max(1.01, input.payout);
  const netRate = payout - 1;
  const base = Number.isFinite(input.base) && input.base > 0 ? input.base : 0.35;

  const initialDebt = input.debt > 0 ? input.debt : base;
  const initialTarget = input.debt > 0
    ? Math.max(0, input.targetRemaining)
    : recoveryTargetProfitFor(base, payout);
  const initialStep = Math.max(1, Math.floor(input.step || 1));
  const maxRecoverySteps = input.maxRecoverySteps !== undefined && input.maxRecoverySteps > 0
    ? Math.floor(input.maxRecoverySteps)
    : 3;
  const stepCap = Math.max(initialStep, maxRecoverySteps);
  const maxTradeStake = Number.isFinite(input.maxTradeStake) && input.maxTradeStake > 0
    ? input.maxTradeStake
    : Number.POSITIVE_INFINITY;
  const initialBalance = Number.isFinite(input.balance) && input.balance > 0
    ? input.balance
    : Number.POSITIVE_INFINITY;
  const nStop = Math.max(1, Math.floor(input.nStop || 1));
  const paths = Math.max(1, Math.floor(input.paths ?? DEFAULT_PATHS));
  const horizon = Math.max(1, Math.floor(input.horizon ?? DEFAULT_HORIZON));
  const seed = input.seed ?? DEFAULT_SEED;

  const uniforms = getUniformTable(paths, horizon, seed);
  const pnls = new Float64Array(paths);
  let sumTrades = 0;
  let sumTotalStake = 0;
  let stopCount = 0;
  let capHitCount = 0;

  for (let pathIdx = 0; pathIdx < paths; pathIdx++) {
    let curDebt = initialDebt;
    let curTarget = initialTarget;
    let curStep = initialStep;
    let curBalance = initialBalance;
    let pnl = 0;
    let pathStake = 0;
    let trades = 0;
    let initialStreakLosses = 0;
    let hadWin = false;
    let hitStop = false;
    let hitCap = false;
    const baseOffset = pathIdx * horizon;

    for (let h = 0; h < horizon; h++) {
      if (curBalance < 0.35) break;

      const requested = calculateRecoveryStakeRequest({
        unrecoveredAmount: curDebt,
        remainingTargetProfit: curTarget,
        payoutMultiplier: payout,
        baseStake: base,
        recoveryAutoMode: input.autoMode,
        recoveryMethod: input.method,
        recoveryMultiplier: input.multiplier,
        recoveryStep: curStep,
        maxRecoverySteps,
      });
      const stake = applyRecoveryStakeLimits(requested, maxTradeStake, curBalance);
      const effectiveCap = Math.min(maxTradeStake, curBalance);
      if (
        Number.isFinite(effectiveCap) &&
        (requested >= effectiveCap - 1e-6 || stake >= effectiveCap - 1e-6)
      ) {
        hitCap = true;
      }

      const u = uniforms[baseOffset + h]!;
      const won = u < p;
      trades += 1;
      pathStake += stake;

      if (won) {
        hadWin = true;
        const profit = stake * netRate;
        pnl += profit;
        curBalance += profit;
        const settled = settleRecoveryWin({
          unrecoveredAmount: curDebt,
          remainingTargetProfit: curTarget,
          actualNetProfit: profit,
        });
        curDebt = settled.remainingDebt;
        curTarget = settled.remainingTargetProfit;
        if (settled.recoveryComplete) {
          break;
        }
      } else {
        pnl -= stake;
        curBalance = Math.max(0, curBalance - stake);
        curStep = Math.min(curStep + 1, stepCap);
        curDebt = addMoney(curDebt, stake);

        if (!hadWin) {
          initialStreakLosses += 1;
          if (initialStreakLosses >= nStop) {
            hitStop = true;
          }
        }
      }
    }

    pnls[pathIdx] = pnl;
    sumTrades += trades;
    sumTotalStake += pathStake;
    if (hitStop) stopCount += 1;
    if (hitCap) capHitCount += 1;
  }

  // Sort pnls ascending to compute ES5 (mean of worst 5% episode P&L)
  pnls.sort();
  const tailCount = Math.max(1, Math.floor(paths * 0.05));
  let tailSum = 0;
  for (let i = 0; i < tailCount; i++) {
    tailSum += pnls[i]!;
  }

  const meanTotalStake = sumTotalStake / paths;
  // Rao-Blackwellized expected episode P&L via Wald's identity: E[pnl] = (p * payout - 1) * E[totalStake]
  const meanPnl = (p * payout - 1) * meanTotalStake;

  return {
    meanPnl,
    es5: tailSum / tailCount,
    pStop: stopCount / paths,
    pCapHit: capHitCount / paths,
    meanTrades: sumTrades / paths,
    meanTotalStake,
  };
}

/**
 * Uncached Monte Carlo episode simulation.
 * Uses Common Random Numbers (same default seed across candidates).
 */
export function simulateEpisodeStats(input: SimulateEpisodeInput): EpisodeStats {
  const res = runSimulation(input);
  return {
    meanPnl: res.meanPnl,
    es5: res.es5,
    pStop: res.pStop,
    pCapHit: res.pCapHit,
    meanTrades: res.meanTrades,
  };
}

function getBucketedResult(input: SimulateEpisodeInput, bucketIdx: number): InternalEpisodeResult {
  const pBucket = clamp(bucketIdx * P_BUCKET_STEP, 0.001, 0.999);
  const payout2dp = roundPayout2dp(input.payout);
  const key = buildCacheKey(input, bucketIdx);
  let cached = episodeCache.get(key);
  if (!cached) {
    cached = runSimulation({
      ...input,
      p: pBucket,
      payout: payout2dp,
    });
    if (episodeCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = episodeCache.keys().next().value;
      if (oldestKey !== undefined) {
        episodeCache.delete(oldestKey);
      }
    }
    episodeCache.set(key, cached);
  }
  return cached;
}

/**
 * Cached episode simulator used by `score-v2.ts` during per-tick candidate scoring.
 * Caches by `0.005` `p` bucket and `2dp` payout, interpolating smoothly between
 * bracketing `0.005` buckets when `p` lies between buckets.
 */
export function simulateEpisodeStatsCached(input: SimulateEpisodeInput): EpisodeStats {
  const clampedP = clamp(input.p, 0.001, 0.999);
  const exactBucketPos = clampedP / P_BUCKET_STEP;
  const loIdx = Math.max(0, Math.floor(exactBucketPos));
  const hiIdx = Math.min(200, Math.ceil(exactBucketPos));
  const alpha = clamp(exactBucketPos - loIdx, 0, 1);

  const loRes = getBucketedResult(input, loIdx);
  if (loIdx === hiIdx || alpha < 1e-6) {
    const exactMeanPnl = (clampedP * input.payout - 1) * loRes.meanTotalStake;
    return {
      meanPnl: exactMeanPnl,
      es5: loRes.es5,
      pStop: loRes.pStop,
      pCapHit: loRes.pCapHit,
      meanTrades: loRes.meanTrades,
    };
  }

  const hiRes = getBucketedResult(input, hiIdx);
  const interpStake = (1 - alpha) * loRes.meanTotalStake + alpha * hiRes.meanTotalStake;
  const exactMeanPnl = (clampedP * input.payout - 1) * interpStake;

  return {
    meanPnl: exactMeanPnl,
    es5: (1 - alpha) * loRes.es5 + alpha * hiRes.es5,
    pStop: (1 - alpha) * loRes.pStop + alpha * hiRes.pStop,
    pCapHit: (1 - alpha) * loRes.pCapHit + alpha * hiRes.pCapHit,
    meanTrades: (1 - alpha) * loRes.meanTrades + alpha * hiRes.meanTrades,
  };
}

/**
 * Deterministic multi-step stake trajectory replayer using the real
 * `calculateRecoveryStakeRequest`, `applyRecoveryStakeLimits`, and `settleRecoveryWin`.
 * Used by T5 to verify 100% staking equivalence across all recovery configurations.
 */
export function replayLadderStakePath(input: {
  outcomes: boolean[];
  payout: number;
  method: "split" | "instant";
  autoMode: boolean;
  multiplier: number;
  maxRecoverySteps: number;
  initialDebt: number;
  initialTarget: number;
  base: number;
  maxTradeStake: number;
  balance: number;
}): { stakes: number[]; debtsAfter: number[]; stepsUsed: number[] } {
  let curDebt = input.initialDebt;
  let curTarget = input.initialTarget;
  let curStep = 1;
  let curBalance = input.balance;
  const stepCap = Math.max(1, input.maxRecoverySteps);
  const netRate = input.payout - 1;

  const stakes: number[] = [];
  const debtsAfter: number[] = [];
  const stepsUsed: number[] = [];

  for (const won of input.outcomes) {
    stepsUsed.push(curStep);
    const requested = calculateRecoveryStakeRequest({
      unrecoveredAmount: curDebt,
      remainingTargetProfit: curTarget,
      payoutMultiplier: input.payout,
      baseStake: input.base,
      recoveryAutoMode: input.autoMode,
      recoveryMethod: input.method,
      recoveryMultiplier: input.multiplier,
      recoveryStep: curStep,
      maxRecoverySteps: input.maxRecoverySteps,
    });
    const stake = applyRecoveryStakeLimits(requested, input.maxTradeStake, curBalance);
    stakes.push(stake);

    if (won) {
      const profit = stake * netRate;
      curBalance += profit;
      const settled = settleRecoveryWin({
        unrecoveredAmount: curDebt,
        remainingTargetProfit: curTarget,
        actualNetProfit: profit,
      });
      curDebt = settled.remainingDebt;
      curTarget = settled.remainingTargetProfit;
      if (settled.recoveryComplete) {
        curStep = 1;
      }
    } else {
      curBalance = Math.max(0, curBalance - stake);
      curDebt = addMoney(curDebt, stake);
      curStep = Math.min(curStep + 1, stepCap);
    }
    debtsAfter.push(curDebt);
  }

  return { stakes, debtsAfter, stepsUsed };
}
