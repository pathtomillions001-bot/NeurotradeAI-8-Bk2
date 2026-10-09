/**
 * Autonomous engine — Nexus Hedge Forge candidate analysis (pure).
 *
 * Ported from dbot-builder nexus-hedge-analysis.js + Ticks.js ntAnalyseHedge.
 * Pure: no I/O, no clocks, no broker. The same tape always yields the same
 * rows, which is what makes the rescan confirmations and rematch rules
 * deterministic and testable.
 */

import {
  OVER_PAYOUTS,
  UNDER_PAYOUTS,
  EVEN_ODD_PAYOUT,
  RISE_FALL_PAYOUT,
  MATCH_PAYOUT,
  DIFF_PAYOUT,
} from "../payouts";
import { HEDGE_LIMITS, HEDGE_MIN_TICKS } from "./constants";

export type HedgeContractType =
  | "DIGITOVER"
  | "DIGITUNDER"
  | "DIGITEVEN"
  | "DIGITODD"
  | "DIGITMATCH"
  | "DIGITDIFF"
  | "CALL"
  | "PUT";

export type HedgeMode = "NORMAL" | "RECOVERY";

/** One contract the ranker may consider. barrier = -1 when the family has no digit. */
export interface HedgeFamilySpec {
  type: HedgeContractType;
  barrier: number;
}

export interface HedgeStats {
  samples: number;
  losses: number;
  probability: number;
  lowerBound: number;
  breakEven: number;
  ev: number;
  markov: number;
  afterLoss: number;
  afterWin: number;
  conditionalEdge: number;
  clustering: number;
  instability: number;
  score: number;
  eligible: boolean;
}

/**
 * Exact port of analyseNexusHedgeCandidate (hedge term fixed at 0, as in the
 * Nexus runtime, where phi/rho is never computed). `wins` is chronological:
 * index n-1 is the most recent outcome.
 */
export function analyseHedgeCandidate(input: {
  wins: boolean[];
  p0: number;
  payout: number;
  mode: HedgeMode;
}): HedgeStats {
  const { wins, p0, payout, mode } = input;
  const isRecovery = mode === "RECOVERY";
  const limits = isRecovery ? HEDGE_LIMITS.recovery : HEDGE_LIMITS.normal;
  const z = HEDGE_LIMITS.confidenceZ;
  const n = wins.length;
  const hits = wins.filter(Boolean).length;
  const losses = n - hits;
  const probability = (hits + HEDGE_LIMITS.priorStrength * p0) / (n + HEDGE_LIMITS.priorStrength);
  const denom = 1 + (z * z) / n;
  const centre = probability + (z * z) / (2 * n);
  const spread = z * Math.sqrt((probability * (1 - probability) + (z * z) / (4 * n)) / n);
  const lowerBound = (centre - spread) / denom;
  const breakEven = 1 / payout;
  const ev = probability * payout - 1;
  let ll = 0;
  let lw = 0;
  let wl = 0;
  let ww = 0;
  for (let i = 1; i < n; i++) {
    if (!wins[i - 1] && !wins[i]) ll++;
    else if (!wins[i - 1]) lw++;
    else if (!wins[i]) wl++;
    else ww++;
  }
  const afterLoss = (lw + 1) / (ll + lw + 2);
  const afterWin = (ww + 1) / (wl + ww + 2);
  const markov = wins[n - 1] ? afterWin : afterLoss;
  const lossRate = 1 - probability;
  const clustering =
    losses >= HEDGE_LIMITS.minClusterLosses
      ? (ll + 1) / (ll + lw + 2) / Math.max(0.01, lossRate)
      : 1;
  const half = Math.max(10, Math.floor(n / 2));
  const recent = wins.slice(-half).filter(Boolean).length / half;
  const prior = wins.slice(0, half).filter(Boolean).length / half;
  const instability = Math.abs(recent - prior);
  const conditionalEdge = (isRecovery ? afterLoss : markov) - breakEven;
  const score =
    100 *
    ((lowerBound - breakEven) * 0.5 +
      conditionalEdge * 0.22 +
      ev * 0.18 -
      instability * 0.18 -
      Math.max(0, clustering - 1) * 0.07);
  const eligible =
    n >= limits.minSamples &&
    ev > limits.minEv &&
    lowerBound > breakEven - limits.lowerBoundMargin &&
    instability < limits.maxInstability &&
    clustering < limits.maxClustering;
  return {
    samples: n,
    losses,
    probability,
    lowerBound,
    breakEven,
    ev,
    markov,
    afterLoss,
    afterWin,
    conditionalEdge,
    clustering,
    instability,
    score,
    eligible,
  };
}

/** Canonical payout for a family/barrier (same table Nexus uses via nexusPayout). */
export function hedgePayout(type: HedgeContractType, barrier: number): number {
  switch (type) {
    case "DIGITOVER":
      return OVER_PAYOUTS[barrier] ?? OVER_PAYOUTS[4]!;
    case "DIGITUNDER":
      return UNDER_PAYOUTS[barrier] ?? UNDER_PAYOUTS[5]!;
    case "DIGITEVEN":
    case "DIGITODD":
      return EVEN_ODD_PAYOUT;
    case "DIGITMATCH":
      return MATCH_PAYOUT;
    case "DIGITDIFF":
      return DIFF_PAYOUT;
    default:
      return RISE_FALL_PAYOUT;
  }
}

/** Resolve the digit a Matches/Differs family trades on (auto when no barrier given). */
export function resolveAutoDigit(
  type: "DIGITMATCH" | "DIGITDIFF",
  barrier: number,
  digits: number[],
): number {
  if (Number.isInteger(barrier) && barrier >= 0 && barrier <= 9) return barrier;
  const counts = Array.from({ length: 10 }, () => 0);
  for (const d of digits) counts[d] += 1;
  return type === "DIGITMATCH"
    ? counts.indexOf(Math.max(...counts))
    : counts.indexOf(Math.min(...counts));
}

/** Win stream + p0 for one family on one tape. Mirrors ntAnalyseHedge exactly. */
export function hedgeWinStream(
  spec: HedgeFamilySpec,
  digits: number[],
  prices: number[],
): { wins: boolean[]; p0: number; barrier: number } | null {
  let barrier = spec.barrier;
  switch (spec.type) {
    case "DIGITOVER": {
      if (barrier < 0 || barrier > 8) return null;
      return { wins: digits.map((d) => d > barrier), p0: (9 - barrier) / 10, barrier };
    }
    case "DIGITUNDER": {
      if (barrier < 1 || barrier > 9) return null;
      return { wins: digits.map((d) => d < barrier), p0: barrier / 10, barrier };
    }
    case "DIGITEVEN":
      return { wins: digits.map((d) => d % 2 === 0), p0: 0.5, barrier: -1 };
    case "DIGITODD":
      return { wins: digits.map((d) => d % 2 === 1), p0: 0.5, barrier: -1 };
    case "DIGITMATCH": {
      barrier = resolveAutoDigit("DIGITMATCH", barrier, digits);
      return { wins: digits.map((d) => d === barrier), p0: 0.1, barrier };
    }
    case "DIGITDIFF": {
      barrier = resolveAutoDigit("DIGITDIFF", barrier, digits);
      return { wins: digits.map((d) => d !== barrier), p0: 0.9, barrier };
    }
    case "CALL": {
      const up: boolean[] = [false];
      for (let i = 1; i < prices.length; i++) up.push(prices[i] > prices[i - 1]);
      return { wins: up, p0: 0.5, barrier: -1 };
    }
    case "PUT": {
      const down: boolean[] = [false];
      for (let i = 1; i < prices.length; i++) down.push(prices[i] < prices[i - 1]);
      return { wins: down, p0: 0.5, barrier: -1 };
    }
    default:
      return null;
  }
}

export interface HedgeCandidate extends HedgeStats {
  symbol: string;
  group: number;
  contract: HedgeContractType;
  barrier: number;
  payout: number;
  /** Monotonic identity of the newest tick this row was computed on. */
  tickSequence: number;
  /** symbol:contract:barrier — the identity used by confirmations and rematch. */
  key: string;
}

export function candidateKey(symbol: string, contract: HedgeContractType, barrier: number): string {
  return `${symbol}:${contract}:${String(barrier)}`;
}

/** Rank every family spec on one market's tape. Returns [] when the tape is too thin. */
export function buildMarketCandidates(input: {
  symbol: string;
  group: number;
  digits: number[];
  prices: number[];
  tickSequence: number;
  specs: HedgeFamilySpec[];
  mode: HedgeMode;
}): HedgeCandidate[] {
  const { symbol, group, digits, prices, tickSequence, specs, mode } = input;
  if (digits.length < HEDGE_MIN_TICKS || prices.length !== digits.length) return [];
  const rows: HedgeCandidate[] = [];
  for (const spec of specs) {
    const stream = hedgeWinStream(spec, digits, prices);
    if (!stream) continue;
    const payout = hedgePayout(spec.type, stream.barrier);
    const stats = analyseHedgeCandidate({ wins: stream.wins, p0: stream.p0, payout, mode });
    rows.push({
      ...stats,
      symbol,
      group,
      contract: spec.type,
      barrier: stream.barrier,
      payout,
      tickSequence,
      key: candidateKey(symbol, spec.type, stream.barrier),
    });
  }
  return rows;
}
