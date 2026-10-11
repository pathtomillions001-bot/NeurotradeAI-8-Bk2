/**
 * Recovery research harness — episode metrics.
 *
 * Every number a recovery claim can be judged on, in one place:
 *  - P(clear), P(ruin), P(unresolved)
 *  - trades-to-clear p50/p90/p99
 *  - peak debt p95/p99
 *  - mean final cash and CVaR99 (mean of the worst 1% of final cash)
 *  - TRUE consecutive-loss run distribution: runs are reset only by a win,
 *    never by a cooldown resume — the counter defect D6 made the dashboard
 *    show runs capped at the loss limit while the real runs reached 10+.
 *  - cap-trap frequency (Instant: the stake cap binds and a win no longer
 *    clears the debt, so debt compounds)
 *  - decision latency in ticks (settlement → next fired recovery trade)
 */

export type EpisodeOutcome = "cleared" | "ruined" | "unresolved";

export interface EpisodeRecord {
  outcome: EpisodeOutcome;
  /** Recovery trades taken in this episode (excludes the originating loss). */
  trades: number;
  finalCash: number;
  peakDebt: number;
  /** Longest consecutive-loss run, reset only by a win. */
  maxTrueRun: number;
  /** A capped stake occurred AND a subsequent win failed to clear the debt. */
  capTrap: boolean;
  /** Mean ticks between settlement and the next fired trade. */
  decisionLatencyTicks: number;
}

export interface Quantiles {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface RecoveryMetricsSummary {
  episodes: number;
  clearRate: number;
  ruinRate: number;
  unresolvedRate: number;
  tradesToClear: Quantiles;
  peakDebt: Quantiles;
  meanFinalCash: number;
  /** Mean of the worst 1% of final cash outcomes (tail cost of the ladder). */
  cvar99FinalCash: number;
  trueLossRun: {
    mean: number;
    max: number;
    /** P(true run ≥ k) — never masked by cooldown resets. */
    pGe6: number;
    pGe8: number;
    pGe10: number;
  };
  capTrapRate: number;
  meanDecisionLatencyTicks: number;
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export function summarizeEpisodes(records: EpisodeRecord[]): RecoveryMetricsSummary {
  const episodes = records.length;
  if (episodes === 0) {
    return {
      episodes: 0,
      clearRate: 0,
      ruinRate: 0,
      unresolvedRate: 0,
      tradesToClear: { p50: 0, p90: 0, p95: 0, p99: 0 },
      peakDebt: { p50: 0, p90: 0, p95: 0, p99: 0 },
      meanFinalCash: 0,
      cvar99FinalCash: 0,
      trueLossRun: { mean: 0, max: 0, pGe6: 0, pGe8: 0, pGe10: 0 },
      capTrapRate: 0,
      meanDecisionLatencyTicks: 0,
    };
  }

  let cleared = 0;
  let ruined = 0;
  let unresolved = 0;
  let capTraps = 0;
  let finalCashSum = 0;
  let runSum = 0;
  let runMax = 0;
  let pGe6 = 0;
  let pGe8 = 0;
  let pGe10 = 0;
  let latencySum = 0;

  const tradesToClear: number[] = [];
  const peakDebts: number[] = [];
  const finalCashList: number[] = [];

  for (const r of records) {
    if (r.outcome === "cleared") cleared++;
    else if (r.outcome === "ruined") ruined++;
    else unresolved++;
    if (r.capTrap) capTraps++;
    if (r.outcome === "cleared") tradesToClear.push(r.trades);
    peakDebts.push(r.peakDebt);
    finalCashSum += r.finalCash;
    finalCashList.push(r.finalCash);
    runSum += r.maxTrueRun;
    runMax = Math.max(runMax, r.maxTrueRun);
    if (r.maxTrueRun >= 6) pGe6++;
    if (r.maxTrueRun >= 8) pGe8++;
    if (r.maxTrueRun >= 10) pGe10++;
    latencySum += r.decisionLatencyTicks;
  }

  tradesToClear.sort((a, b) => a - b);
  peakDebts.sort((a, b) => a - b);
  finalCashList.sort((a, b) => a - b);

  // CVaR99: mean of the worst 1% of final-cash outcomes (at least one sample).
  const tailCount = Math.max(1, Math.ceil(episodes * 0.01));
  let cvar = 0;
  for (let i = 0; i < tailCount; i++) cvar += finalCashList[i];
  cvar /= tailCount;

  return {
    episodes,
    clearRate: cleared / episodes,
    ruinRate: ruined / episodes,
    unresolvedRate: unresolved / episodes,
    tradesToClear: {
      p50: quantile(tradesToClear, 0.5),
      p90: quantile(tradesToClear, 0.9),
      p95: quantile(tradesToClear, 0.95),
      p99: quantile(tradesToClear, 0.99),
    },
    peakDebt: {
      p50: quantile(peakDebts, 0.5),
      p90: quantile(peakDebts, 0.9),
      p95: quantile(peakDebts, 0.95),
      p99: quantile(peakDebts, 0.99),
    },
    meanFinalCash: finalCashSum / episodes,
    cvar99FinalCash: cvar,
    trueLossRun: {
      mean: runSum / episodes,
      max: runMax,
      pGe6: pGe6 / episodes,
      pGe8: pGe8 / episodes,
      pGe10: pGe10 / episodes,
    },
    capTrapRate: capTraps / episodes,
    meanDecisionLatencyTicks: latencySum / episodes,
  };
}

/**
 * Approximate 95% CI half-width for a proportion on N trials — the power
 * statement the null test reports: with N trades an edge smaller than about
 * 2·sqrt(0.25/N) cannot be told apart from zero.
 */
export function proportionCiHalfWidth(n: number): number {
  if (n <= 0) return Infinity;
  return 2 * Math.sqrt(0.25 / n);
}
