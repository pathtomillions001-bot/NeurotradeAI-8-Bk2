/**
 * Execution truth — the closed loop the recovery ladder never had.
 *
 * WHY THIS EXISTS
 *
 * Recovery stakes are sized from the payout QUOTE captured before the order
 * (`ledgerEntryPayout`, ledger.ts:77) and from the engine's own probability
 * estimate. Nothing ever compared those assumptions against what the broker
 * actually paid, so a systematically optimistic quote or a slow dispatch would
 * under-recover forever and never appear in any log, because there was no
 * measurement of it.
 *
 * This module records the two things that can silently break the ladder:
 *
 *  1. QUOTE DRIFT — the realised multiplier of a settled contract versus the
 *     multiplier that sized and ranked the trade. Recovery divides by
 *     `(payout - 1)`, so a quote that is 2% too high under-recovers every
 *     subsequent step. Drift is tracked as a relative EWMA per contract family
 *     and an alarm fires when it is both material and consistent.
 *
 *  2. DISPATCH LATENCY — the ticks and milliseconds between forming a decision
 *     and the order going out. A 1-tick contract decided on tick N and bought on
 *     tick N+2 is not the trade that was analysed. The pre-dispatch revalidation
 *     in cycle.ts refuses stale decisions; this measures how often that matters.
 *
 * DETERMINISM: recorded from real settlements only. No simulated outcomes — the
 * paper mode that used to fabricate them has been removed from the product.
 */

import { toCents } from "../recovery-math";

/** Relative drift below this is rounding noise, not a pricing problem. */
export const QUOTE_DRIFT_NOISE_FLOOR = 0.005;

/** Consecutive adverse observations before the alarm is raised. */
export const QUOTE_DRIFT_ALARM_STREAK = 5;

/** EWMA smoothing for the relative drift (half-life ~7 observations). */
const DRIFT_ALPHA = 0.1;

export interface QuoteObservation {
  contract: string;
  barrier: number | null;
  /** Multiplier quoted before dispatch — the number that sized the trade. */
  quotedMultiplier: number;
  /** Multiplier actually realised on settlement: (buyPrice + profit) / buyPrice. */
  realisedMultiplier: number;
  won: boolean;
}

export interface ContractTruth {
  samples: number;
  wins: number;
  /** Mean quoted multiplier across samples. */
  meanQuoted: number;
  /** Mean realised multiplier on WINNING contracts only (the meaningful comparison). */
  meanRealisedOnWin: number;
  /**
   * Relative drift on wins: (realised - quoted) / quoted, as an EWMA.
   * Negative = the broker paid less than the quote that sized our stake.
   */
  relativeDriftEwma: number;
  /** Longest current run of adverse (drift < -noise floor) win observations. */
  adverseStreak: number;
  alarm: boolean;
}

export interface DispatchLatency {
  samples: number;
  /** Ticks elapsed between the decision's tape and the order. */
  meanTicksElapsed: number;
  maxTicksElapsed: number;
  meanMs: number;
  maxMs: number;
  /** Orders sent on a decision older than the freshness bound. */
  staleDispatches: number;
}

interface MutableTruth extends ContractTruth {}

const truthByContract = new Map<string, MutableTruth>();

const latency: DispatchLatency = {
  samples: 0,
  meanTicksElapsed: 0,
  maxTicksElapsed: 0,
  meanMs: 0,
  maxMs: 0,
  staleDispatches: 0,
};

function keyFor(contract: string, barrier: number | null): string {
  return barrier === null ? contract : `${contract}:${barrier}`;
}

function emptyTruth(): MutableTruth {
  return {
    samples: 0,
    wins: 0,
    meanQuoted: 0,
    meanRealisedOnWin: 0,
    relativeDriftEwma: 0,
    adverseStreak: 0,
    alarm: false,
  };
}

/**
 * Record one settled contract against the quote that sized it.
 *
 * Returns the updated truth entry so the caller can surface an alarm in the
 * trade reason or stop the engine when drift is sustained.
 */
export function recordQuoteOutcome(obs: QuoteObservation): ContractTruth {
  const key = keyFor(obs.contract, obs.barrier);
  const t = truthByContract.get(key) ?? emptyTruth();

  t.samples += 1;
  if (obs.won) t.wins += 1;
  t.meanQuoted = t.meanQuoted + (obs.quotedMultiplier - t.meanQuoted) / t.samples;

  // Only WINS carry a realised multiplier. On a loss the broker keeps the stake
  // and the "realised multiplier" is 0, which says nothing about pricing.
  if (obs.won && Number.isFinite(obs.realisedMultiplier) && obs.realisedMultiplier > 0) {
    t.meanRealisedOnWin =
      t.wins === 1
        ? obs.realisedMultiplier
        : t.meanRealisedOnWin + (obs.realisedMultiplier - t.meanRealisedOnWin) / t.wins;

    if (Number.isFinite(obs.quotedMultiplier) && obs.quotedMultiplier > 0) {
      const relative = (obs.realisedMultiplier - obs.quotedMultiplier) / obs.quotedMultiplier;
      t.relativeDriftEwma =
        t.wins === 1 ? relative : (1 - DRIFT_ALPHA) * t.relativeDriftEwma + DRIFT_ALPHA * relative;

      if (relative < -QUOTE_DRIFT_NOISE_FLOOR) {
        t.adverseStreak += 1;
      } else {
        t.adverseStreak = 0;
      }
      // An alarm needs BOTH a material EWMA drift and a consistent streak: one
      // unusually small payout must not stop a session.
      t.alarm = t.adverseStreak >= QUOTE_DRIFT_ALARM_STREAK && t.relativeDriftEwma < -QUOTE_DRIFT_NOISE_FLOOR;
    }
  }

  truthByContract.set(key, t);
  return t;
}

/** Record decision -> dispatch latency for one attempt. */
export function recordDispatchLatency(input: {
  /** Tick sequence of the tape the decision was formed on. */
  decisionTickSequence: number;
  /** Tick sequence of the tape in force when the order was sent. */
  dispatchTickSequence: number;
  elapsedMs: number;
  /** Bound beyond which cycle.ts refuses to dispatch at all. */
  staleAfterTicks?: number;
}): DispatchLatency {
  const ticks = Math.max(0, input.dispatchTickSequence - input.decisionTickSequence);
  const staleAfter = input.staleAfterTicks ?? 1;
  latency.samples += 1;
  latency.meanTicksElapsed =
    latency.meanTicksElapsed + (ticks - latency.meanTicksElapsed) / latency.samples;
  latency.maxTicksElapsed = Math.max(latency.maxTicksElapsed, ticks);
  latency.meanMs = latency.meanMs + (input.elapsedMs - latency.meanMs) / latency.samples;
  latency.maxMs = Math.max(latency.maxMs, input.elapsedMs);
  if (ticks > staleAfter) latency.staleDispatches += 1;
  return latency;
}

export interface ExecutionTruthReport {
  contracts: Array<{ key: string } & ContractTruth>;
  latency: DispatchLatency;
  /** Contracts whose payout is consistently paying less than the quote. */
  alarms: string[];
}

export function getExecutionTruthReport(): ExecutionTruthReport {
  const contracts = [...truthByContract.entries()].map(([key, t]) => ({ key, ...t }));
  return {
    contracts,
    latency: { ...latency },
    alarms: contracts.filter((c) => c.alarm).map((c) => c.key),
  };
}

/** Wire the report into a log line / trade reason without dumping every contract. */
export function describeExecutionTruth(): string {
  const report = getExecutionTruthReport();
  const parts: string[] = [];
  if (report.alarms.length > 0) {
    parts.push(`quote drift alarm on ${report.alarms.join(", ")}`);
  }
  if (report.latency.samples > 0) {
    parts.push(
      `dispatch ${report.latency.meanTicksElapsed.toFixed(2)} ticks / ${Math.round(report.latency.meanMs)}ms mean` +
        (report.latency.staleDispatches > 0 ? `, ${report.latency.staleDispatches} stale` : ""),
    );
  }
  return parts.join(" · ");
}

export function resetExecutionTruth(): void {
  truthByContract.clear();
  latency.samples = 0;
  latency.meanTicksElapsed = 0;
  latency.maxTicksElapsed = 0;
  latency.meanMs = 0;
  latency.maxMs = 0;
  latency.staleDispatches = 0;
}

/**
 * Realised multiplier of a settled contract.
 *
 * A winning contract returns `buyPrice + profit`; dividing by the stake paid
 * gives the multiplier that actually applied — the number the next recovery step
 * should have been sized from.
 */
export function realisedMultiplier(buyPrice: number, profit: number, won: boolean): number {
  if (!won || !Number.isFinite(buyPrice) || buyPrice <= 0) return 0;
  const returned = toCents(buyPrice + profit) / 100;
  return returned / buyPrice;
}
