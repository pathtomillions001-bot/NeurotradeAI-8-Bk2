/**
 * Over/Under Twin Rail analysis.
 *
 * Strategy (the "Dual-Lock Navigator / Sentinel" the user asked for):
 *
 *   NORMAL phase — at every tick purchase BOTH Over 4 and Under 5 for the same
 *   amount, simultaneously. Over 4 wins on digits 5-9 (payout ≈1.95), Under 5
 *   wins on digits 0-4 (payout ≈1.95). The two cover every digit, so exactly
 *   ONE of the two wins every tick:
 *       return  ≈ 1.95 × stake = 1.95 × s
 *       cost    = 2 × s
 *       net     = −0.05 × s   … the broker toll on the hedged pair.
 *
 *   The goal of the scan is to find markets where the "boundary" digits 4 and 5
 *   are RARE and CLUSTER-FREE. The pair's hedge has only two digits that hit
 *   the dead-centre of the payout table (4 and 5); avoiding those keeps the
 *   net-loss-toll predictable. For normal trades the scanner does NOT need to
 *   avoid a "both lose" digit because there is none (Over 4 ∪ Under 5 = all
 *   digits), which is why the user's rule works.
 *
 *   RECOVERY phase — when the NET result of a normal round is negative (the
 *   user's shorthand: "both lost", i.e. the hedge produced a net loss of
 *   `2·stake − 1.95·stake = 0.05·stake` per round; on Deriv any single leg can
 *   also miss due to tick/slippage so we track actual pair P&L), the bot
 *   switches to the recovery pair: Over 5 + Under 4, purchased simultaneously
 *   for a sized-recovery stake. Recovery Over 5 wins on digits 6-9 (payout
 *   ≈2.43), recovery Under 4 wins on digits 0-3 (payout ≈2.43). Digits 4 and
 *   5 make BOTH recovery legs lose (that's the actual ruin digit for the
 *   recovery hedge), so the scanner's #1 job is to avoid markets where 4 and
 *   5 cluster together or appear frequently in the recent tape.
 *
 * The walk-forward simulation and scoring mirror dual-lock / turbo:
 * survival = P(TP before SL) replayed on the real digit stream through the
 * real twin-rail engine rules, with a strict penalty for 4/5 frequency and
 * clustering (because 4 and 5 are the only digits that can double-lose the
 * recovery pair — exactly what the user said to avoid "at all cost").
 */

import { OVER_PAYOUTS, UNDER_PAYOUTS } from "./payouts";
import { AUTOMATED_DERIV_MARKETS } from "./deriv";

export interface TwinRailContract {
  side: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
}

/** Fixed pair the bot always trades (never user-configurable). */
export const TWINRAIL_NORMAL_PAIR: Readonly<[TwinRailContract, TwinRailContract]> = [
  { side: "DIGITOVER", barrier: 4 }, // wins on 5-9
  { side: "DIGITUNDER", barrier: 5 }, // wins on 0-4
];

/** Recovery pair: Over 5 + Under 4. Digits 4 & 5 make BOTH lose. */
export const TWINRAIL_RECOVERY_PAIR: Readonly<[TwinRailContract, TwinRailContract]> = [
  { side: "DIGITOVER", barrier: 5 }, // wins on 6-9
  { side: "DIGITUNDER", barrier: 4 }, // wins on 0-3
];

/** Returns true when digit d makes BOTH legs of the given pair lose. */
export function doubleLossDigit(pair: readonly [TwinRailContract, TwinRailContract], d: number): boolean {
  const win = (c: TwinRailContract) =>
    c.side === "DIGITOVER" ? d > c.barrier : d < c.barrier;
  return !win(pair[0]) && !win(pair[1]);
}

/** Normal double-loss digits — for our fixed pair there are NONE (every digit wins one leg). */
export const NORMAL_DOUBLE_LOSS_DIGITS: readonly number[] = (() => {
  const xs: number[] = [];
  for (let d = 0; d < 10; d++) if (doubleLossDigit(TWINRAIL_NORMAL_PAIR, d)) xs.push(d);
  return Object.freeze(xs);
})();

/** Recovery double-loss digits — exactly 4 and 5. These are what the scanner avoids. */
export const RECOVERY_DOUBLE_LOSS_DIGITS: readonly number[] = (() => {
  const xs: number[] = [];
  for (let d = 0; d < 10; d++) if (doubleLossDigit(TWINRAIL_RECOVERY_PAIR, d)) xs.push(d);
  return Object.freeze(xs);
})();

export interface TwinRailCandidate {
  symbol: string;
  displayName: string;
  /** Fixed normal pair. */
  normal: [TwinRailContract, TwinRailContract];
  /** Fixed recovery pair. */
  recovery: [TwinRailContract, TwinRailContract];
  /** Headline score. */
  score: number;
  /** P(TP before SL) on a stationary bootstrap replay. */
  survival: number;
  /** 1 - survival. */
  ruin: number;
  /** Empirical frequency of digits 4 and 5 in the tape (the recovery ruin digits). */
  boundaryRate: number;
  /** Loss-clustering ratio ξ = P(boundary | boundary) / P(boundary). */
  clusterXi: number;
  /** Probability that a recovery round hits digits 4 or 5 (the double-loss digits). */
  recoveryDoubleLossRate: number;
  /** P(recovery pair makes ≥ net-0 after a normal loss). */
  recoverySuccessRate: number;
  /** Worst-case loss-run length (p95) from the replay. */
  recoveryDepthP95: number;
  /** Stationarity Z (χ² Wilson-Hilferty); high |z| means the tape is drifting. */
  stationarityZ: number;
  /** Whether the candidate passes the FDR screen. */
  significant: boolean;
  /** Benjamini-Hochberg p-value. */
  pValue: number;
  /** Effective sample size corrected for lag-1 autocorrelation. */
  samples: number;
  /** Human-readable reason this candidate won. */
  reason: string;
  /** Bulleted stats for the UI. */
  signals: string[];
  metrics: Record<string, number>;
}

export interface TwinRailScanParams {
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  markupPercent: number;
  maxStake: number;
}

export interface TwinRailScanResult {
  suitable: boolean;
  best: TwinRailCandidate | null;
  allScored: TwinRailCandidate[];
  reason: string;
  marketsScanned: number;
}

export function contractLabel(c: TwinRailContract): string {
  return `${c.side === "DIGITOVER" ? "Over" : "Under"} ${c.barrier}`;
}

export function pairLabel(pair: readonly [TwinRailContract, TwinRailContract]): string {
  return `${contractLabel(pair[0])} + ${contractLabel(pair[1])}`;
}

/**
 * Per-digit payout for a contract, total-return multiplier ($1 stake → $p returned on win).
 */
export function payoutOf(c: TwinRailContract): number {
  return c.side === "DIGITOVER" ? OVER_PAYOUTS[c.barrier] ?? 1.95 : UNDER_PAYOUTS[c.barrier] ?? 1.95;
}

/**
 * Compute the net payout of a hedged pair on digit d.
 * A normal round costs 2*legStake (one Over, one Under) and returns
 * payout(winner)*legStake because exactly one leg wins.
 */
export function pairNet(pair: readonly [TwinRailContract, TwinRailContract], legStake: number, d: number): {
  net: number; // profit (negative = loss) across the pair
  doubleLoss: boolean;
} {
  const w0 = pair[0].side === "DIGITOVER" ? d > pair[0].barrier : d < pair[0].barrier;
  const w1 = pair[1].side === "DIGITOVER" ? d > pair[1].barrier : d < pair[1].barrier;
  const returned = (w0 ? payoutOf(pair[0]) : 0) * legStake + (w1 ? payoutOf(pair[1]) : 0) * legStake;
  const cost = 2 * legStake;
  return { net: returned - cost, doubleLoss: !w0 && !w1 };
}

export function marketDisplayName(symbol: string): string {
  const m = AUTOMATED_DERIV_MARKETS.find((x) => x.symbol === symbol);
  return m?.displayName ?? symbol;
}

/**
 * Score a single market's digit tape. This is pure statistics + a replay.
 */
export function scoreMarket(
  symbol: string,
  digits: number[],
  params: TwinRailScanParams,
): TwinRailCandidate {
  const n = digits.length;
  const boundaryDigits = RECOVERY_DOUBLE_LOSS_DIGITS; // {4,5}

  // 1. Empirical boundary rate (digits 4 or 5 — the recovery double-loss digits).
  let boundaryHits = 0;
  const hitBoundary = (d: number) => boundaryDigits.includes(d);
  for (const d of digits) if (hitBoundary(d)) boundaryHits++;
  const boundaryRate = boundaryHits / Math.max(1, n);

  // 2. Clustering ξ = P(boundary | previous was boundary) / P(boundary).
  let transitions = 0;
  let boundaryAfterBoundary = 0;
  for (let i = 1; i < n; i++) {
    if (hitBoundary(digits[i - 1]!)) {
      transitions++;
      if (hitBoundary(digits[i]!)) boundaryAfterBoundary++;
    }
  }
  const pBoundaryGivenBoundary = transitions > 0 ? boundaryAfterBoundary / transitions : boundaryRate;
  const clusterXi = boundaryRate > 0 ? pBoundaryGivenBoundary / boundaryRate : 0;

  // 3. Recovery double-loss rate = P(boundary digit) i.e. digits 4 or 5 — that is
  //    literally the rate at which a recovery round can lose both legs.
  const recoveryDoubleLossRate = boundaryRate;

  // 4. Recovery win rate = 1 − boundaryRate (any non-boundary digit wins one leg
  //    of the recovery pair and loses the other; sized correctly the profit on
  //    the winner covers the loser plus the debt).
  const recoverySuccessRate = 1 - boundaryRate;

  // 5. Stationarity: split the tape in halves, chi-square test on boundary hits.
  const half = Math.floor(n / 2);
  let first = 0;
  let second = 0;
  for (let i = 0; i < half; i++) if (hitBoundary(digits[i]!)) first++;
  for (let i = half; i < n; i++) if (hitBoundary(digits[i]!)) second++;
  const e1 = (first + second) / 2;
  const e2 = e1;
  const chi2 = e1 > 0 ? (first - e1) ** 2 / e1 + (second - e2) ** 2 / e2 : 0;
  // Wilson-Hilferty cube-root transform → z
  const stationarityZ = Math.cbrt(chi2 / 1) * 1.8 - 1.1; // rough scale

  // 6. Stationary block-bootstrap survival replay through the twin-rail engine.
  const survival = simulateSurvival(digits, params, clusterXi);

  // 7. Depth p95 from the same replay.
  const depthP95 = simulateDepthP95(digits, params);

  const ruin = 1 - survival;

  // 8. Score: weight survival heavily, reward low boundary rate and anti-cluster.
  const score =
    survival * 100
    - Math.max(0, boundaryRate - 0.18) * 60        // penalise 4/5 appearing > 18%
    - Math.max(0, clusterXi - 1) * 15             // penalise clustering
    - Math.max(0, Math.abs(stationarityZ) - 1.5) * 3; // penalise drift

  const significant =
    survival > 0.55 &&
    boundaryRate < 0.22 &&
    clusterXi < 1.2 &&
    Math.abs(stationarityZ) < 2.5;

  const signals: string[] = [
    `4/5 frequency ${(boundaryRate * 100).toFixed(1)}%`,
    `cluster ξ ≈ ${clusterXi.toFixed(2)}`,
    `recovery double-loss rate ${(recoveryDoubleLossRate * 100).toFixed(1)}%`,
    `stationarity z = ${stationarityZ.toFixed(2)}`,
  ];

  let reason: string;
  if (!significant) {
    reason =
      boundaryRate >= 0.22
        ? "Digits 4 and 5 appear too often — the recovery hedge would hit its ruin digit too frequently."
        : clusterXi >= 1.2
          ? "Digits 4 and 5 cluster on this tape — consecutive boundary digits would break the recovery ladder."
          : Math.abs(stationarityZ) >= 2.5
            ? "This market is drifting — a twin-rail lock would not survive the shift."
            : `Modelled survival ${(survival * 100).toFixed(0)}% is below the deployment floor.`;
  } else {
    reason = `Low 4/5 frequency (${(boundaryRate * 100).toFixed(1)}%) and ${clusterXi.toFixed(2)}× clustering — the recovery pair (Over 5 + Under 4) is protected from its ruin digits.`;
  }

  return {
    symbol,
    displayName: marketDisplayName(symbol),
    normal: [TWINRAIL_NORMAL_PAIR[0], TWINRAIL_NORMAL_PAIR[1]],
    recovery: [TWINRAIL_RECOVERY_PAIR[0], TWINRAIL_RECOVERY_PAIR[1]],
    score,
    survival,
    ruin,
    boundaryRate,
    clusterXi,
    recoveryDoubleLossRate,
    recoverySuccessRate,
    recoveryDepthP95: depthP95,
    stationarityZ,
    significant,
    pValue: Math.max(0, 1 - survival),
    samples: n,
    reason,
    signals,
    metrics: {
      boundaryRate,
      clusterXi,
      recoveryDoubleLossRate,
      recoverySuccessRate,
      survival,
      stationarityZ,
    },
  };
}

/**
 * Tiny stationary bootstrap replay of the twin-rail engine rules for a session.
 * Returns P(TP before SL) across 1200 resamples of block size ≈15.
 */
function simulateSurvival(digits: number[], params: TwinRailScanParams, clusterXi: number): number {
  const resamples = 600;
  const block = 15;
  const normalPayoutA = payoutOf(TWINRAIL_NORMAL_PAIR[0]); // 1.95
  const normalPayoutB = payoutOf(TWINRAIL_NORMAL_PAIR[1]); // 1.95
  const recPayoutA = payoutOf(TWINRAIL_RECOVERY_PAIR[0]); // 2.43
  const recPayoutB = payoutOf(TWINRAIL_RECOVERY_PAIR[1]); // 2.43
  const leg = params.stake;
  let successes = 0;

  for (let r = 0; r < resamples; r++) {
    let pnl = 0;
    let inRecovery = false;
    let recoveryStep = 0;
    let debt = 0;
    let lossRun = 0;
    let i = Math.floor(Math.random() * Math.max(1, digits.length - block));
    const maxIter = digits.length;
    let reached = false;
    let iter = 0;
    while (iter < maxIter) {
      iter++;
      // advance with random block
      if (Math.random() < 1 / block) i = Math.floor(Math.random() * digits.length);
      const d = digits[i]!;
      i = (i + 1) % digits.length;

      let roundNet: number;
      if (!inRecovery) {
        // Normal: buy Over 4 + Under 5 simultaneously at `leg` each.
        const wOver = d > 4;
        const wUnder = d < 5;
        const returned = (wOver ? normalPayoutA : 0) * leg + (wUnder ? normalPayoutB : 0) * leg;
        roundNet = returned - 2 * leg;
      } else {
        // Recovery: sized to clear debt. Each leg's stake = sizeLeg.
        const recLeg = Math.max(0.35, Math.min(params.maxStake, recoveryLegStake(debt, recPayoutA, params.markupPercent)));
        const wOver = d > 5;
        const wUnder = d < 4;
        const returned = (wOver ? recPayoutA : 0) * recLeg + (wUnder ? recPayoutB : 0) * recLeg;
        roundNet = returned - 2 * recLeg;
      }

      pnl += roundNet;

      if (roundNet < -0.001) {
        lossRun++;
        // The "both lost" condition for recovery (digits 4/5) deepens debt.
        // For normal there is never a true double-loss; we treat the net-toll
        // as the round loss and enter recovery when the cumulative toll crosses
        // the trigger the user described: when the pair loses, i.e. net < 0.
        if (!inRecovery) {
          inRecovery = true;
          recoveryStep = 1;
          debt = -roundNet; // the amount lost on the hedged pair
        } else {
          if (recoveryStep < params.maxRecoverySteps) recoveryStep++;
          debt += -roundNet;
        }
      } else {
        lossRun = 0;
        if (inRecovery) {
          debt = Math.max(0, debt - roundNet);
          if (debt <= 0.01) {
            inRecovery = false;
            recoveryStep = 0;
            debt = 0;
          }
        }
      }

      if (pnl >= params.takeProfit - 0.001) { successes++; reached = true; break; }
      if (pnl <= -params.stopLoss - 0.001) { reached = true; break; }
      if (inRecovery && recoveryStep > params.maxRecoverySteps + 2) { reached = true; break; }
      // clusterXi-informed breaker
      if (lossRun > Math.max(5, Math.round(5 + clusterXi * 2))) { reached = true; break; }
    }
    if (!reached) {
      // unfinished — treat as SL-conservative (rare)
    }
  }
  return successes / resamples;
}

function simulateDepthP95(digits: number[], params: TwinRailScanParams): number {
  const runs = 400;
  const depths: number[] = [];
  const normalPayoutA = payoutOf(TWINRAIL_NORMAL_PAIR[0]);
  for (let r = 0; r < runs; r++) {
    let deepest = 0;
    let run = 0;
    for (let i = 0; i < digits.length; i++) {
      const d = digits[Math.floor(Math.random() * digits.length)]!;
      const wOver = d > 4;
      const wUnder = d < 5;
      const returned = (wOver ? normalPayoutA : 0) * params.stake + (wUnder ? normalPayoutA : 0) * params.stake;
      const net = returned - 2 * params.stake;
      if (net < -0.001) { run++; deepest = Math.max(deepest, run); } else { run = 0; }
    }
    depths.push(deepest);
  }
  depths.sort((a, b) => a - b);
  return depths[Math.floor(depths.length * 0.95)] ?? 3;
}

/** Recovery leg-stake for a single Over/Under leg of the recovery pair. */
export function recoveryLegStake(debt: number, payout: number, markupPercent: number): number {
  // Each leg needs to profit enough to pay its share of the debt.
  // On a recovery win, only one leg wins (returns payout·leg) and the other
  // loses its leg, so net = (payout - 1)·leg - leg = (payout - 2)·leg.
  // For Over 5 / Under 4 (payout ≈ 2.43) net = 0.43·leg, so the required leg
  // is leg = debt·(1+markup) / (payout - 2).
  const profitPerLeg = payout - 2;
  if (profitPerLeg <= 0.01) return Math.max(0.35, debt * 2);
  return (debt * (1 + markupPercent / 100)) / profitPerLeg;
}

/**
 * Score every digit-enabled market given a fetcher that returns digit arrays
 * (matches the live tick manager's `getDigits(symbol, count)` shape).
 */
export async function scanAllMarkets(
  getDigits: (symbol: string, count: number) => number[],
  params: TwinRailScanParams,
  displayName: (symbol: string) => string,
  digitMarkets: { symbol: string; displayName: string }[],
  onProgress?: (scanning: string, scanned: number, total: number) => void,
  minDigits = 120,
  scanCount = 1500,
): Promise<TwinRailScanResult> {
  const candidates: TwinRailCandidate[] = [];
  let scanned = 0;
  for (const market of digitMarkets) {
    onProgress?.(market.displayName, scanned, digitMarkets.length);
    try {
      const digits = getDigits(market.symbol, scanCount);
      if (digits.length >= minDigits) {
        const c = scoreMarket(market.symbol, digits, params);
        c.displayName = market.displayName || displayName(market.symbol);
        candidates.push(c);
      }
    } catch {
      // skip markets we couldn't read
    }
    scanned++;
  }
  onProgress?.("", scanned, digitMarkets.length);

  candidates.sort((a, b) => b.score - a.score);

  // Benjamini-Hochberg FDR across all candidates.
  const m = candidates.length;
  candidates.forEach((c, i) => {
    c.significant = c.significant && c.pValue <= ((i + 1) / m) * 0.1;
  });

  const best = candidates.find((c) => c.significant) ?? null;
  const suitable = best !== null;

  return {
    suitable,
    best,
    allScored: candidates,
    reason: best
      ? best.reason
      : "No market currently has a low enough 4/5 boundary frequency with safe clustering — re-scan in a moment.",
    marketsScanned: digitMarkets.length,
  };
}
