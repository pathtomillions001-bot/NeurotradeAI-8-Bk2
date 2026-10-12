/**
 * Recovery research harness — fast ladder simulator.
 *
 * Exact-geometry sweeps at 100k–1M episodes. It runs the REAL shipped math —
 * `calculateRecoveryStakeRequest`, `applyRecoveryStakeLimits`,
 * `settleRecoveryWin`, `recoveryTargetProfitFor` — for one fixed contract
 * (p0, payout) and one method, without the ranker. That separation is
 * deliberate: the ladder answers "what does this staking geometry cost on
 * i.i.d. outcomes?" while the episode simulator answers "what does selection
 * add on top?".
 *
 * Episode model (documented, no lookahead):
 *  - The episode starts with one normal trade at `baseStake` that LOSES
 *    (recovery debt = baseStake; target = recoveryTargetProfitFor(baseStake,
 *    originPayout), exactly as reduceRecoveryOutcome records it).
 *  - Each recovery trade stakes the shipped formula at the live balance, wins
 *    with probability p0 (i.i.d.), pays stake·(payout − 1) net on a win.
 *  - Ends cleared (debt = 0), ruined (balance cannot fund the minimum stake),
 *    or unresolved (maxTrades reached — the paper's 3,000-trade horizon).
 */

import {
  applyRecoveryStakeLimits,
  calculateRecoveryStakeRequest,
  recoveryTargetProfitFor,
  settleRecoveryWin,
} from "../../recovery-math";
import type { Rng } from "./rng";
import type { EpisodeRecord } from "./metrics";

export const MIN_DERIV_STAKE = 0.35;

export interface LadderConfig {
  /** True per-tick win probability of the contract (i.i.d.). */
  p0: number;
  /** Total-return payout multiplier (includes the stake). */
  payout: number;
  baseStake: number;
  capital: number;
  maxTradeStake: number;
  method: "instant" | "split";
  /**
   * Payout of the ORIGINATING normal trade (drives the aspirational target
   * profit via recoveryTargetProfitFor). Defaults to the recovery contract's
   * own payout. The paper's Even/Odd ladder (1.48, 3.04, …) used an origin
   * payout of 1.40; the shipped engine records whatever contract lost.
   */
  originPayout?: number;
  /** Horizon per episode (paper: 3,000). */
  maxTrades?: number;
  /** Manual-mode inputs, kept for completeness (auto mode by default). */
  recoveryAutoMode?: boolean;
  recoveryMultiplier?: number;
  maxRecoverySteps?: number;
}

/** One episode's stake ladder — returned for inspection/tests, not for speed. */
export interface LadderTrace {
  stakes: number[];
  debts: number[];
  wins: boolean[];
}

export function runLadderEpisode(rng: Rng, cfg: LadderConfig, trace?: LadderTrace): EpisodeRecord {
  const maxTrades = cfg.maxTrades ?? 3000;
  const originPayout = cfg.originPayout ?? cfg.payout;
  const autoMode = cfg.recoveryAutoMode ?? true;
  const multiplier = cfg.recoveryMultiplier ?? 1.62;
  const maxSteps = cfg.maxRecoverySteps ?? 3;

  let balance = cfg.capital;
  // Originating normal trade loses.
  balance -= cfg.baseStake;
  let debt = cfg.baseStake;
  let target = recoveryTargetProfitFor(cfg.baseStake, originPayout);
  let step = 1;
  let peakDebt = debt;

  let trades = 0;
  let run = 1; // the originating loss is the first consecutive loss
  let maxTrueRun = 1;
  let cappedSeen = false;
  let capTrap = false;
  let latencyTicks = 0; // the ladder fires every tick: latency is 1 by construction

  for (;;) {
    if (balance < MIN_DERIV_STAKE) {
      return record("ruined");
    }
    if (trades >= maxTrades) {
      return record("unresolved");
    }

    const requested = calculateRecoveryStakeRequest({
      unrecoveredAmount: debt,
      remainingTargetProfit: target,
      payoutMultiplier: cfg.payout,
      baseStake: cfg.baseStake,
      recoveryAutoMode: autoMode,
      recoveryMethod: cfg.method,
      recoveryMultiplier: multiplier,
      recoveryStep: step,
      maxRecoverySteps: maxSteps,
    });
    const stake = applyRecoveryStakeLimits(requested, cfg.maxTradeStake, balance);
    if (!Number.isFinite(stake) || stake > balance || stake < MIN_DERIV_STAKE) {
      return record("ruined");
    }

    // Cap bookkeeping (D2): a capped stake a win cannot clear is the trap.
    const capped = stake >= cfg.maxTradeStake - 1e-9 || stake >= balance - 1e-9;
    if (capped) cappedSeen = true;

    trades += 1;
    trace?.stakes.push(stake);
    trace?.debts.push(debt);

    const won = rng.next() < cfg.p0;
    trace?.wins.push(won);
    balance -= stake;

    if (won) {
      const profit = stake * (cfg.payout - 1);
      balance += stake + profit;
      const settlement = settleRecoveryWin({
        unrecoveredAmount: debt,
        remainingTargetProfit: target,
        actualNetProfit: profit,
      });
      if (capped && !settlement.recoveryComplete) capTrap = true;
      if (settlement.recoveryComplete) {
        return record("cleared");
      }
      debt = settlement.remainingDebt;
      target = settlement.remainingTargetProfit;
      run = 0;
    } else {
      debt += stake;
      peakDebt = Math.max(peakDebt, debt);
      step = Math.min(step + 1, Math.max(1, maxSteps));
      run += 1;
      maxTrueRun = Math.max(maxTrueRun, run);
    }
  }

  function record(outcome: EpisodeRecord["outcome"]): EpisodeRecord {
    return {
      outcome,
      trades,
      // Net P&L vs the starting capital — the paper's convention (mean final
      // cash −1.26 Instant / −7.24 Split on Even/Odd base 1 capital 200).
      finalCash: balance - cfg.capital,
      peakDebt,
      maxTrueRun,
      capTrap,
      decisionLatencyTicks: latencyTicks,
    };
  }
}

export interface LadderRunOptions extends LadderConfig {
  episodes: number;
  rng: Rng;
}

export function runLadderSweep(options: LadderRunOptions): { records: EpisodeRecord[] } {
  const { episodes, rng, ...cfg } = options;
  const records: EpisodeRecord[] = new Array(episodes);
  for (let i = 0; i < episodes; i++) {
    records[i] = runLadderEpisode(rng, cfg);
  }
  return { records };
}

/**
 * Exact expected log-debt drift per loss/win step for the Split geometry —
 * the D1 drift-trap diagnostic. Positive drift means the ladder tends UP even
 * though individual steps are fair-priced.
 */
export function splitLogDebtDrift(p0: number, payout: number, baseStake: number, debt: number): number {
  const exact = debt / (payout - 1);
  const stake = Math.min(exact, baseStake);
  const winDebt = Math.max(0, debt - stake * (payout - 1));
  const lossDebt = debt + stake;
  const eps = 1e-9;
  return p0 * Math.log((winDebt + eps) / (debt + eps)) + (1 - p0) * Math.log((lossDebt + eps) / (debt + eps));
}
