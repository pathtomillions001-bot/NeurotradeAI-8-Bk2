/**
 * Autonomous engine — recovery Markov-chain DP preview (WP5, pure).
 *
 * The adaptive ladder's debt path is a random walk on the debt axis:
 *   transient debt ∈ (0, budget)     — the adaptive stake is placed each tick
 *   debt ≤ 0                         — CLEARED (absorbing)
 *   debt ≥ budget                    — RE-BASED (absorbing; the realised debt
 *                                      at first passage pins the cash tail)
 *
 * The chain is solved by value iteration on a collocation grid of 1%-budget
 * buckets. Transitions stay CONTINUOUS and value functions are interpolated
 * between grid points, so the DP approximates the true continuous-debt walk
 * the Monte-Carlo harness runs (error O(step²) — validated to < 1 % against
 * 1e6 MC episodes in wp5-markov-dp.test.ts).
 *
 * Cash flows telescope: recovery cash at any time equals D₀ − D(t), so the
 * final-cash distribution is determined by the absorption point alone — a
 * point mass at +D₀ on clearance and masses at D₀ − D_rebase on re-base.
 * That keeps the DP one-dimensional in debt.
 *
 * The optimizer picks λ from a fixed grid, minimising
 *   U = |CVaR99| / capital + wTrades · E[trades]   s.t. P(rebase) ≤ tol
 * — the "auto" lambda in settings. Everything here is cached and answers in
 * < 5 ms after warm-up (cycle scan payload budget).
 */

import { computeAdaptiveStake, ADAPTIVE_DEFAULT_LAMBDA } from "./adaptive-stake";

/** 1%-of-budget collocation buckets (spec grid; interpolation removes the O(step) bias). */
export const DEBT_GRID = 400; // 1%-budget buckets, 4x oversampled; interpolation removes O(step) bias
export const LAMBDA_GRID = [0.25, 0.33, 0.5, 0.67, 1.0] as const;

export interface DpInput {
  /** Outstanding loss debt D₀. */
  debt: number;
  baseStake: number;
  /** Total-return payout multiplier of the recovery contract. */
  payout: number;
  /** Win probability used for the preview (ranker posterior; no lookahead). */
  p0: number;
  lambda: number;
  budgetBase: number;
  /** Current per-stake headroom cap (WP4). */
  headroomCap: number;
  minStake?: number;
}

export interface DpPreview {
  lambda: number;
  pClear: number;
  pRebase: number;
  expectedTrades: number;
  expectedCash: number;
  /** Mean of the worst-1% final-cash mass (negative). */
  cvar99: number;
  pRunGe6: number;
  pRunGe8: number;
  pRunGe10: number;
  /** Mean realised re-base debt, conditional on re-basing. */
  rebaseDebtMean: number;
}

export interface OptimizerInput extends Omit<DpInput, "lambda"> {
  capital: number;
  /** Trade-count penalty weight in U (default 0.01). */
  wTrades?: number;
  /** Max acceptable P(rebase) (default 0.10). */
  rebaseTol?: number;
}

export interface OptimizerResult {
  lambda: number;
  utility: number;
  feasible: boolean;
  preview: DpPreview;
  candidates: Array<{ lambda: number; utility: number; pRebase: number; feasible: boolean }>;
}

interface ChainModel {
  winDebt: Float64Array; // continuous debt after a win (≤ 0 ⇒ cleared)
  lossDebt: Float64Array; // continuous debt after a loss (≥ budget ⇒ rebase)
  stake: Float64Array;
  winCash: Float64Array; // +stake·(payout−1)
  lossCash: Float64Array; // −stake
  p0: number;
  step: number;
  budgetAmount: number;
}

interface SolvedChain {
  pClear: Float64Array;
  eTrades: Float64Array;
  eCash: Float64Array;
  rebaseDist: Float64Array[]; // per rebase-debt bin: first-passage probability
  rebaseBinWidth: number;
}

const REBASE_BINS = 64; // resolution of the realised re-base debt tail
const MAX_ITERATIONS = 4000;
const TOLERANCE = 1e-11;

function buildChain(input: DpInput): { model: ChainModel; budgetAmount: number; step: number } {
  const base = Math.max(input.minStake ?? 0.35, input.baseStake > 0 ? input.baseStake : 0.35);
  const payout = input.payout > 1 ? input.payout : 1.95;
  const p0 = Math.min(0.99, Math.max(0.01, input.p0));
  const budgetAmount = Math.max(base, input.budgetBase * base);
  const step = budgetAmount / DEBT_GRID;

  const winDebt = new Float64Array(DEBT_GRID);
  const lossDebt = new Float64Array(DEBT_GRID);
  const stake = new Float64Array(DEBT_GRID);
  const winCash = new Float64Array(DEBT_GRID);
  const lossCash = new Float64Array(DEBT_GRID);

  for (let i = 1; i < DEBT_GRID; i++) {
    const debt = i * step;
    const plan = computeAdaptiveStake({
      debt,
      baseStake: base,
      payout,
      lambda: input.lambda,
      headroomCap: input.headroomCap,
      budgetBase: input.budgetBase,
      minStake: input.minStake,
    });
    // A re-base trigger at this debt absorbs the chain on entry.
    const s = plan.rebaseBudget || plan.rebaseHeadroom ? 0 : plan.stake;
    stake[i] = s;
    winCash[i] = s * (payout - 1);
    lossCash[i] = -s;
    winDebt[i] = s > 0 ? debt - s * (payout - 1) : debt;
    lossDebt[i] = s > 0 ? debt + s : budgetAmount; // stake 0 ⇒ absorb as re-base
  }
  return { model: { winDebt, lossDebt, stake, winCash, lossCash, p0, step, budgetAmount }, budgetAmount, step };
}

/**
 * Linear interpolation of a value array at continuous debt x.
 * Absorbed lookups (x ≤ 0 cleared, x ≥ budget re-based) return the boundary
 * values. INSIDE the transient range the interpolation never crosses the
 * absorption boundaries (the value functions are discontinuous there): near
 * the edges it extrapolates flat, keeping every metric's Bellman operator
 * linear and consistent — so Σ rebase bins ≡ 1 − P(clear) at the fixed point.
 */
function interpAt(V: Float64Array, x: number, step: number, budget: number, vClear: number, vRebase: number): number {
  if (x <= 0) return vClear;
  if (x >= budget) return vRebase;
  const t = x / step;
  if (t < 1) return V[1];
  if (t >= DEBT_GRID - 1) return V[DEBT_GRID - 1];
  const lo = Math.floor(t);
  const frac = t - lo;
  return V[lo] * (1 - frac) + V[lo + 1] * frac;
}

function solveChain(model: ChainModel): SolvedChain {
  const p = model.p0;
  const q = 1 - p;
  const n = DEBT_GRID;
  const step = model.step;
  const budget = model.budgetAmount;

  const iterate = (vClear: number, vRebase: number, absorbLoss: (i: number) => number): Float64Array => {
    let cur = new Float64Array(n);
    for (let it = 0; it < MAX_ITERATIONS; it++) {
      const nxt = new Float64Array(n);
      for (let i = 1; i < n; i++) {
        if (model.stake[i] <= 0) { nxt[i] = vRebase; continue; }
        const wv = model.winDebt[i] <= 0
          ? vClear
          : interpAt(cur, model.winDebt[i], step, budget, vClear, vRebase);
        const lv = model.lossDebt[i] >= budget
          ? absorbLoss(i)
          : interpAt(cur, model.lossDebt[i], step, budget, vClear, vRebase);
        nxt[i] = p * wv + q * lv;
      }
      let delta = 0;
      for (let i = 1; i < n; i++) delta = Math.max(delta, Math.abs(nxt[i] - cur[i]));
      cur = nxt;
      if (delta < TOLERANCE) break;
    }
    return cur;
  };

  // P(clear): cleared boundary 1, rebase boundary 0.
  const pClear = iterate(1, 0, () => 0);
  // E[trades] and E[cash]: one-step rewards added inside the Bellman update.
  const iterateReward = (
    reward: (i: number) => [number, number], // [win-side, loss-side] one-step reward
  ): Float64Array => {
    let cur = new Float64Array(n);
    for (let it = 0; it < MAX_ITERATIONS; it++) {
      const nxt = new Float64Array(n);
      for (let i = 1; i < n; i++) {
        if (model.stake[i] <= 0) { nxt[i] = 0; continue; }
        const [rw, rl] = reward(i);
        const wv = model.winDebt[i] <= 0 ? 0 : interpAt(cur, model.winDebt[i], step, budget, 0, 0);
        const lv = model.lossDebt[i] >= budget ? 0 : interpAt(cur, model.lossDebt[i], step, budget, 0, 0);
        nxt[i] = p * (rw + wv) + q * (rl + lv);
      }
      let delta = 0;
      for (let i = 1; i < n; i++) delta = Math.max(delta, Math.abs(nxt[i] - cur[i]));
      cur = nxt;
      if (delta < TOLERANCE) break;
    }
    return cur;
  };
  const eTrades = iterateReward((i) => (model.stake[i] > 0 ? [1, 1] : [0, 0]));
  const eCash = iterateReward((i) => [model.winCash[i], model.lossCash[i]]);

  // First-passage distribution over the realised re-base debt (binned).
  const rebaseBinWidth = budget / REBASE_BINS;
  const rebaseBinOf = (i: number): number => {
    const over = model.lossDebt[i] - budget;
    return Math.min(REBASE_BINS - 1, Math.max(0, Math.floor(over / rebaseBinWidth)));
  };
  const rebaseDist: Float64Array[] = [];
  for (let b = 0; b < REBASE_BINS; b++) {
    rebaseDist.push(iterate(0, 0, (i) => (rebaseBinOf(i) === b ? 1 : 0)));
  }

  return { pClear, eTrades, eCash, rebaseDist, rebaseBinWidth };
}

/** P(max consecutive-loss run ≥ k) from a continuous start debt. */
function pMaxRunGe(model: ChainModel, startDebt: number, k: number): number {
  const p = model.p0;
  const q = 1 - p;
  const n = DEBT_GRID;
  const step = model.step;
  const budget = model.budgetAmount;
  const look = (V: Float64Array, x: number, r: number): number => {
    if (x <= 0 || x >= budget) return 0; // cleared or re-based: run ends, not BAD
    const t = x / step;
    if (t < 1) return V[1 * k + r];
    if (t >= n - 1) return V[(n - 1) * k + r];
    const lo = Math.floor(t);
    const frac = t - lo;
    return V[lo * k + r] * (1 - frac) + V[(lo + 1) * k + r] * frac;
  };
  let cur = new Float64Array(n * k);
  for (let it = 0; it < MAX_ITERATIONS; it++) {
    const nxt = new Float64Array(n * k);
    for (let i = 1; i < n; i++) {
      if (model.stake[i] <= 0) continue; // re-bases on entry: not BAD
      for (let r = 0; r < k; r++) {
        const winV = model.winDebt[i] <= 0 ? 0 : look(cur, model.winDebt[i], 0);
        const lossV = r + 1 >= k
          ? 1
          : (model.lossDebt[i] >= budget ? 0 : look(cur, model.lossDebt[i], r + 1));
        nxt[i * k + r] = p * winV + q * lossV;
      }
    }
    let delta = 0;
    for (let x = 0; x < n * k; x++) delta = Math.max(delta, Math.abs(nxt[x] - cur[x]));
    cur = nxt;
    if (delta < TOLERANCE) break;
  }
  const t = Math.min(n - 1.000001, Math.max(1, startDebt / step));
  const lo = Math.floor(t);
  const frac = t - lo;
  return cur[lo * k + 0] * (1 - frac) + cur[Math.min(n - 1, lo + 1) * k + 0] * frac;
}

/** Value at a continuous debt via grid interpolation. */
function valueAt(V: Float64Array, debt: number, step: number, vClear: number, vRebase: number): number {
  return interpAt(V, debt, step, DEBT_GRID * step, vClear, vRebase);
}

function finalizePreview(input: DpInput, model: ChainModel, solved: SolvedChain, step: number): DpPreview {
  const budget = model.budgetAmount;
  const startDebt = Math.min(budget - 1e-9, Math.max(1e-9, input.debt));
  const pClear = valueAt(solved.pClear, startDebt, step, 1, 0);
  const pRebase = Math.max(0, 1 - pClear);
  const eTrades = valueAt(solved.eTrades, startDebt, step, 0, 0);
  const eCash = valueAt(solved.eCash, startDebt, step, 0, 0);

  let rebaseDebtMean = 0;
  const masses: Array<{ value: number; prob: number }> = [];
  if (pClear > 0) masses.push({ value: startDebt, prob: pClear }); // win the debt back
  for (let b = 0; b < REBASE_BINS; b++) {
    const pr = valueAt(solved.rebaseDist[b], startDebt, step, 0, 0);
    if (pr <= 1e-15) continue;
    const rebaseDebt = budget + (b + 0.5) * solved.rebaseBinWidth;
    rebaseDebtMean += pr * rebaseDebt;
    masses.push({ value: startDebt - rebaseDebt, prob: pr });
  }
  if (pRebase > 1e-15) rebaseDebtMean /= pRebase;

  // CVaR99 over the final-cash lattice: worst atoms until ≥ 1% probability
  // mass is accumulated (whole atoms — conservative at the boundary).
  masses.sort((a, b) => a.value - b.value);
  let acc = 0;
  let weighted = 0;
  for (const m of masses) {
    weighted += m.prob * m.value;
    acc += m.prob;
    if (acc >= 0.01) break;
  }
  const cvar99 = acc > 0 ? weighted / acc : 0;

  return {
    lambda: input.lambda,
    pClear,
    pRebase,
    expectedTrades: eTrades,
    expectedCash: eCash,
    cvar99,
    pRunGe6: pMaxRunGe(model, startDebt, 6),
    pRunGe8: pMaxRunGe(model, startDebt, 8),
    pRunGe10: pMaxRunGe(model, startDebt, 10),
    rebaseDebtMean,
  };
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const previewCache = new Map<string, DpPreview>();
const CACHE_LIMIT = 512;

function quant(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function cacheKey(input: DpInput): string {
  return [
    quant(input.debt, 0.05),
    quant(input.baseStake, 0.01),
    quant(input.payout, 0.005),
    quant(input.p0, 0.005),
    quant(input.lambda, 0.01),
    quant(input.budgetBase, 0.5),
    quant(input.headroomCap, 0.25),
  ].join("|");
}

/** DP preview of the adaptive ladder from the current debt. Cached (< 5 ms). */
export function recoveryDpPreview(input: DpInput): DpPreview {
  const key = cacheKey(input);
  const hit = previewCache.get(key);
  if (hit) return hit;
  const { model, step } = buildChain(input);
  const solved = solveChain(model);
  const preview = finalizePreview(input, model, solved, step);
  if (previewCache.size >= CACHE_LIMIT) previewCache.clear();
  previewCache.set(key, preview);
  return preview;
}

export function clearRecoveryDpCache(): void {
  previewCache.clear();
}

// ── λ optimizer ("auto") ──────────────────────────────────────────────────────

/**
 * Pick λ from LAMBDA_GRID minimising U = |CVaR99|/capital + wTrades·E[trades]
 * subject to P(rebase) ≤ rebaseTol. If no candidate is feasible, the one with
 * the lowest P(rebase) wins (never trade an unvalidated lambda).
 */
export function chooseOptimalLambda(input: OptimizerInput): OptimizerResult {
  const wTrades = Number.isFinite(input.wTrades) ? input.wTrades! : 0.01;
  const rebaseTol = Number.isFinite(input.rebaseTol) ? input.rebaseTol! : 0.10;
  const capital = Math.max(1, input.capital);

  let best: OptimizerResult | null = null;
  const candidates: OptimizerResult["candidates"] = [];
  for (const lambda of LAMBDA_GRID) {
    const preview = recoveryDpPreview({ ...input, lambda });
    const utility = Math.abs(preview.cvar99) / capital + wTrades * preview.expectedTrades;
    const feasible = preview.pRebase <= rebaseTol;
    candidates.push({ lambda, utility, pRebase: preview.pRebase, feasible });
    const better = best === null
      || (feasible && (!best.feasible || utility < best.utility))
      || (!feasible && !best.feasible && preview.pRebase < best.preview.pRebase);
    if (better) best = { lambda, utility, feasible, preview, candidates };
  }
  if (!best) {
    const fallback = recoveryDpPreview({ ...input, lambda: ADAPTIVE_DEFAULT_LAMBDA });
    return { lambda: ADAPTIVE_DEFAULT_LAMBDA, utility: Infinity, feasible: false, preview: fallback, candidates };
  }
  best.candidates = candidates;
  return best;
}
