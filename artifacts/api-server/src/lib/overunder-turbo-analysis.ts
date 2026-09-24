/**
 * Over/Under Turbo — analysis layer.
 *
 * WHAT THIS BOT IS
 * ────────────────
 * The continuous-fire Over/Under specialist. Like the Dual-Lock Range Sentinel
 * it spends ALL of its intelligence ONCE, up front, on a single question:
 *
 *   "Which (market, normal barrier, recovery barrier) triple is most likely to
 *    survive an UNINTERRUPTED, non-stop session — reach take-profit before
 *    stop-loss — when the recovery leg only ever trades in the exact state that
 *    follows a normal loss?"
 *
 * …and then it FIRES. One contract settles and the next opens immediately, with
 * no mid-session re-analysis, no green-light waiting and no re-scanning, until
 * TP or SL. That is the whole product requirement: supersonic, back-to-back
 * over/under trading.
 *
 * HOW IT DIFFERS FROM THE TWO BOTS IT SIT BETWEEN
 * ───────────────────────────────────────────────
 *  · vs the Over/Under NAVIGATOR — the Navigator re-fits a policy and gates
 *    EVERY trade behind a pacing valve ("no forced trades"); it waits for fair
 *    setups. Turbo never gates mid-session. It arms ONCE on a good entry tick
 *    and then trades non-stop.
 *  · vs DUAL-LOCK — Dual-Lock is locked to one market with no switching at all.
 *    Turbo adds an explicit market mode: LOCKED (never move) or SWITCHING (leave
 *    the market ONLY when it turns measurably unfavorable, and then move the
 *    fire budget to a better tape — the chosen barriers never change).
 *
 * THE BARRIER SETS ARE FIXED (the user's spec, and identical to Dual-Lock's):
 *   normal   ∈ { Over 1, Over 2, Under 7, Under 8 }
 *   recovery ∈ { Over 4, Over 5, Under 4, Under 5 }
 * The scan subjects EVERY digit market × EVERY one of those combinations to the
 * full survival model and returns the single best market with its best normal
 * and best recovery barrier.
 *
 * REUSED MATH (not re-implemented, so the two over/under-continuous bots can
 * never silently diverge): the conservative lower-confidence bounds, the
 * autocorrelation-corrected effective sample size, the loss-clustering Markov
 * chain (ξ = P(loss|loss)/P(loss)), the CONDITIONAL recovery estimand
 * P(recovery wins | last digit ∈ normal-loss set), the χ² stationarity test, the
 * stationary block-bootstrap session simulation (→ P(TP before SL)) and the
 * Benjamini–Hochberg FDR screen all live in `dual-lock-analysis.ts` and are
 * re-exported here verbatim. This module adds only the two turbo-specific
 * pieces the continuous engine needs: the ARM-ENTRY read and the cheap
 * MARKET-FAVORABILITY health used by the switching rescue.
 */

import {
  DUAL_LOCK_NORMAL_CONTRACTS,
  DUAL_LOCK_RECOVERY_CONTRACTS,
  DUAL_LOCK_MIN_SCORE,
  type DualLockCandidate,
  type DualLockContract,
  type DualLockSide,
  type SessionSimParams,
  contractKey,
  contractLabel,
  isNormalContract,
  isRecoveryContract,
  winSet,
  lossSet,
  evaluateMarket,
  evaluateDualLockCandidate,
  screenAndRank,
  isDeployable,
  conservativeRate,
  lossClustering,
  stationarityZ,
} from "./dual-lock-analysis";
import { payoutForBarrier } from "./specialist-analysis";

// ── Fixed contract vocabulary (the user's barrier sets) ───────────────────────
//
// These are EXACTLY the barriers the bot was specified with. They are the same
// sets Dual-Lock trades, so we adopt them directly rather than duplicating the
// constants (a single source of truth means the survival math, the sovereignty
// checks and the UI can never disagree about what "Over 2" means).

export type TurboSide = DualLockSide;
export type TurboContract = DualLockContract;
export type TurboCandidate = DualLockCandidate;

/** The ONLY contracts allowed for normal (non-recovery) trades. */
export const TURBO_NORMAL_CONTRACTS = DUAL_LOCK_NORMAL_CONTRACTS;
/** The ONLY contracts allowed for recovery trades. */
export const TURBO_RECOVERY_CONTRACTS = DUAL_LOCK_RECOVERY_CONTRACTS;

export {
  contractKey,
  contractLabel,
  isNormalContract,
  isRecoveryContract,
  winSet,
  lossSet,
  evaluateMarket,
  evaluateDualLockCandidate,
  screenAndRank,
  isDeployable,
  DUAL_LOCK_MIN_SCORE as TURBO_MIN_SCORE,
  type SessionSimParams,
};

// ── Scan result ───────────────────────────────────────────────────────────────

export interface TurboScanResult {
  /** True when at least one triple cleared the structural gates. */
  suitable: boolean;
  /** The single best (market, normal, recovery) triple, or null. */
  best: TurboCandidate | null;
  /** Best-ranked triples, for the console's runner-up list. */
  allScored: TurboCandidate[];
  /** Human-readable verdict / blocker, printed verbatim in the console. */
  reason: string;
  /** How many digit markets were scanned. */
  marketsScanned: number;
}

/**
 * Rank a flat list of evaluated triples into a scan result. Kept separate from
 * the market crawl so the ENGINE can reuse it for the switching rescue (which
 * evaluates a fresh set of markets mid-session) without re-implementing the
 * screen/rank/verdict logic.
 */
export function rankTurboCandidates(
  candidates: TurboCandidate[],
  marketsScanned: number,
): TurboScanResult {
  const ranked = screenAndRank(candidates);
  if (ranked.length === 0) {
    return {
      suitable: false,
      best: null,
      allScored: [],
      marketsScanned,
      reason:
        "No market has enough tick history yet (120+ digits per market) — wait a few seconds and re-scan.",
    };
  }
  const best = ranked[0]!;
  const suitable = isDeployable(best);
  const blocker =
    best.signals.find((s) => s.startsWith("BLOCKED:")) ??
    (best.clusterRatio > 1.08
      ? `losses cluster (ξ ${best.clusterRatio.toFixed(2)} > 1.08)`
      : `composite score ${best.score.toFixed(0)} is under the ${DUAL_LOCK_MIN_SCORE} floor`);
  const reason = suitable
    ? `${best.displayName}: ${contractLabel(best.normal)} normal → ${contractLabel(
        best.recovery,
      )} recovery — ${(best.survival * 100).toFixed(0)}% simulated survival, loss-clustering ξ ${best.clusterRatio.toFixed(
        2,
      )}, worst-case normal ${(best.normalLcb * 100).toFixed(1)}% vs ${(
        best.normalBreakEven * 100
      ).toFixed(1)}% break-even.`
    : `No triple is deployable right now (best: ${best.displayName} ${contractLabel(
        best.normal,
      )}→${contractLabel(best.recovery)}, survival ${(best.survival * 100).toFixed(0)}%, score ${best.score.toFixed(
        0,
      )}). Reason: ${blocker.replace(/^BLOCKED:\s*/, "")} A non-stop session needs a market that is stationary and does not pair its losses.`;
  return { suitable, best, allScored: ranked.slice(0, 24), reason, marketsScanned };
}

// ── ARM ENTRY ─────────────────────────────────────────────────────────────────
//
// The user asked for the bot to "wait for the best trade entry and START taking
// those supersonic trades non-stop". That is a ONE-SHOT gate: before the very
// first fire we wait for the locked normal contract to be in a favourable
// short-window state, then we arm and never gate again. It is deliberately NOT a
// per-trade valve (that is the Navigator, which this bot is not).

export interface ArmRead {
  /** True when the recent window is at/above break-even for the locked normal contract. */
  ready: boolean;
  /** Short-window empirical win rate of the locked normal contract (0..1). */
  recentRate: number;
  /** The contract's break-even win rate = 1 / payout (0..1). */
  breakEven: number;
  /** Digits in the window actually used. */
  window: number;
  /** Short human-readable reason for the console's arming line. */
  reason: string;
}

/**
 * Read the live tick window and decide whether NOW is a good entry to arm the
 * continuous run. "Good" = the locked normal contract's empirical win rate over
 * the most recent `window` digits is at or above its break-even rate (so we do
 * not start the turbo run leaning into an immediate loss ladder).
 *
 * Pure and cheap: it reads a digit buffer the caller already has.
 */
export function armEntryRead(
  digits: readonly number[],
  normal: TurboContract,
  window = 40,
): ArmRead {
  const clean = digits.filter((d) => d >= 0 && d <= 9);
  const payout = payoutForBarrier(normal.side, normal.barrier);
  const breakEven = 1 / payout;
  const slice = clean.slice(-window);
  if (slice.length < 12) {
    return {
      ready: false,
      recentRate: 0,
      breakEven,
      window: slice.length,
      reason: "warming up the live tick window",
    };
  }
  const wins = winSet(normal);
  const hits = slice.reduce((acc, d) => acc + (wins.has(d) ? 1 : 0), 0);
  const recentRate = hits / slice.length;
  const ready = recentRate >= breakEven;
  return {
    ready,
    recentRate,
    breakEven,
    window: slice.length,
    reason: ready
      ? `${contractLabel(normal)} hitting ${(recentRate * 100).toFixed(0)}% over the last ${
          slice.length
        } ticks (≥ ${(breakEven * 100).toFixed(0)}% break-even) — arming`
      : `${contractLabel(normal)} at ${(recentRate * 100).toFixed(0)}% over the last ${
          slice.length
        } ticks — waiting for a ≥ ${(breakEven * 100).toFixed(0)}% entry`,
  };
}

// ── MARKET FAVOURABILITY (switching rescue) ───────────────────────────────────
//
// In SWITCHING mode the bot leaves the market ONLY when it turns unfavourable —
// it never re-scans while the tape is healthy, so continuous trading is never
// interrupted for a good market. This is the cheap, live check that decides
// "unfavourable"; the expensive cross-market re-fit only runs when it trips.

export interface TurboMarketHealth {
  symbol: string;
  displayName: string;
  /** Conservative (5 %) lower bound on the locked normal contract's win rate. */
  normalLcb: number;
  /** The normal contract's break-even rate. */
  breakEven: number;
  /** ξ = P(loss|loss)/P(loss) on the normal leg (> 1 means losses attract losses). */
  clusterRatio: number;
  /** Wilson–Hilferty z of the χ² block-homogeneity test (|z| large = drifting). */
  stationarityZ: number;
  /** Digits used. */
  samples: number;
  /**
   * True when the market is still a good host for a non-stop locked session:
   * worst-case normal rate clears break-even, losses do not cluster, and the
   * rate is stationary. When false, the engine's switching rescue looks for a
   * better tape.
   */
  favorable: boolean;
  /** Why it is unfavorable (empty when favorable). */
  reason: string;
}

/**
 * Cheap health of ONE market for the locked normal contract, from a live digit
 * buffer. Mirrors the structural gates in `evaluateDualLockCandidate` but
 * WITHOUT the (expensive) bootstrap simulation, so it can run every few seconds
 * inside the continuous loop without ever pausing the fire cadence for long.
 */
export function turboMarketHealth(
  symbol: string,
  displayName: string,
  digits: readonly number[],
  normal: TurboContract,
): TurboMarketHealth {
  const clean = digits.filter((d) => d >= 0 && d <= 9);
  const payout = payoutForBarrier(normal.side, normal.barrier);
  const breakEven = 1 / payout;
  const fair = winSet(normal).size / 10;
  if (clean.length < 60) {
    return {
      symbol,
      displayName,
      normalLcb: 0,
      breakEven,
      clusterRatio: 1,
      stationarityZ: 0,
      samples: clean.length,
      favorable: false,
      reason: "not enough live history to trust the market yet",
    };
  }
  const series = clean.map((d) => (winSet(normal).has(d) ? 1 : 0));
  const rate = conservativeRate(series, fair, 12);
  const cluster = lossClustering(series);
  const stat = stationarityZ(series, 4);
  const reasons: string[] = [];
  if (rate.lcb <= breakEven) {
    reasons.push(
      `worst-case ${(rate.lcb * 100).toFixed(1)}% ≤ ${(breakEven * 100).toFixed(1)}% break-even`,
    );
  }
  if (cluster.clusterRatio > 1.08) {
    reasons.push(`losses cluster (ξ ${cluster.clusterRatio.toFixed(2)})`);
  }
  if (Math.abs(stat.z) > 3) {
    reasons.push(`rate drifting (z ${stat.z.toFixed(1)})`);
  }
  return {
    symbol,
    displayName,
    normalLcb: rate.lcb,
    breakEven,
    clusterRatio: cluster.clusterRatio,
    stationarityZ: stat.z,
    samples: clean.length,
    favorable: reasons.length === 0,
    reason: reasons.join(" · "),
  };
}

/**
 * Evaluate ONE market against the bot's locked normal/recovery pair (used by the
 * switching rescue, which keeps the barriers fixed and only re-chooses WHERE to
 * fire). Returns the full survival candidate, or null when the market is too
 * thin / structurally blocked.
 */
export function evaluateTurboPair(
  symbol: string,
  displayName: string,
  digits: readonly number[],
  normal: TurboContract,
  recovery: TurboContract,
  sim: SessionSimParams,
): TurboCandidate | null {
  return evaluateDualLockCandidate(symbol, displayName, [...digits], normal, recovery, {
    ...sim,
    simulate: true,
  });
}
