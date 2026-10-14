/**
 * Autonomous engine — Nexus Hedge Forge logic (1-tick).
 *
 * COPY, NOT SHARED. These values mirror the Nexus Hedge Forge runtime
 * (dbot-builder: nexus-hedge-analysis.js, Ticks.js ntAnalyseHedge, Total.js)
 * and are duplicated here on purpose. The Nexus bot in the bots section must
 * stay byte-for-byte independent: changing a number here must never change
 * Nexus, and changing Nexus must never silently change the autonomous engine.
 */

/** Prefix on every autonomous Nexus-logic trade row. The reconciler and the
 *  exposure gate key on it, so no other engine's rows are ever touched. */
export const AUTONOMOUS_HEDGE_PREFIX = "[Autonomous 1T] ";

/** Every autonomous trade is exactly one tick. Nexus sends 1t for all families. */
export const HEDGE_DURATION_TICKS = 1;
export const HEDGE_DURATION_UNIT = "t" as const;

/** Tape window the ranker reads: last N digits (Nexus default, clamped 20–300). */
export const HEDGE_WINDOW = 120;
export const HEDGE_MIN_WINDOW = 20;
export const HEDGE_MAX_WINDOW = 300;

/** Minimum ticks in the window before a market may be ranked (Nexus: digits.length < 20 skips). */
export const HEDGE_MIN_TICKS = 20;

export const HEDGE_LIMITS = Object.freeze({
  priorStrength: 20,
  confidenceZ: 1.282,
  minClusterLosses: 10,
  /** Ticks in the recent window used for the after-loss conditional estimate. */
  recentAfterLossWindow: 40,
  /** Ceiling on how strongly the recent window may outvote the long-run estimate. */
  regimeWeightCap: 0.75,
  /** Fresh distinct ticks the same best candidate must hold before a RECOVERY fires. */
  recoveryConfirmations: 2,
  /** Confirmations escalate to this value once the consecutive loss run is ≥ 3. */
  recoveryConfirmationsEscalated: 3,
  escalateAtLossRun: 3,
  /** Score deficit applied to the exact losing tuple after a settled loss. */
  rematchPenalty: 8,
  rematchDecay: 0.8,
  rematchPenaltyPerLoss: 2,
  normal: Object.freeze({
    minSamples: 30,
    minEv: 0,
    lowerBoundMargin: 0.025,
    maxInstability: 0.16,
    maxClustering: 1.45,
  }),
  recovery: Object.freeze({
    minSamples: 20,
    minEv: -0.01,
    lowerBoundMargin: 0.05,
    maxInstability: Infinity,
    maxClustering: 1.6,
    /**
     * Loss-streak response of the recovery RANKING (never of a stake). At
     * escalation 0 the two directional risk terms keep their design-document
     * weight of 18; at `escalationCap` they are 1 + riskWeightMax times heavier,
     * which widens the gap between well-evidenced and weakly-evidenced recovery
     * candidates as a loss run deepens.
     */
    riskWeightMax: 0.5,
    escalationCap: 6,
  }),
});

/** The four parallel tournament groups (contest mode). Order matters for display. */
export const HEDGE_GROUP_NAMES = ["Volatility 1s", "Volatility", "Jump Indices", "Bull/Bear"] as const;

export function hedgeGroupIndex(symbol: string): number {
  if (symbol.startsWith("1HZ")) return 0;
  if (symbol.startsWith("R_")) return 1;
  if (symbol.startsWith("JD")) return 2;
  return 3;
}

// ── Recovery Quality Pipeline v2 constants ────────────────────────────────────

export type RecoveryV2Mode = "off" | "shadow" | "on";

/**
 * Feature flag for Recovery Quality Pipeline v2:
 * - "off":    v1 behaviour exactly.
 * - "shadow": v1 decides and trades; v2 is computed alongside and logged.
 * - "on":     v2 decides and executes through the same executeDecision / ladder path.
 */
export const RECOVERY_V2_MODE: RecoveryV2Mode = "on";

let recoveryV2ModeOverride: RecoveryV2Mode | null = null;

export function setRecoveryV2ModeOverride(mode: RecoveryV2Mode | null): void {
  recoveryV2ModeOverride = mode;
}

export function getRecoveryV2Mode(): RecoveryV2Mode {
  if (recoveryV2ModeOverride) return recoveryV2ModeOverride;
  const envMode = process.env["RECOVERY_V2_MODE"];
  if (envMode === "off" || envMode === "shadow" || envMode === "on") return envMode;
  return RECOVERY_V2_MODE;
}

// ── Admissibility gate (Recovery Quality Pipeline v3) ─────────────────────────
//
// THE PROBLEM THIS SOLVES (measured, docs/autonomous-recovery-audit.md section 3):
// v2's estimator is superbly calibrated (|pred - real| = 0.15pp) but its only
// eligibility test was "is the stake valid", so it fired on 100% of ticks and
// destroyed 1.7x more capital than v1 in the NULL world. Calibrating a belief is
// not the same as declining to bet on it.
//
// The gate admits a candidate only when ALL of the following hold:
//
//   (a) zTilde > 0                  the deviation survives the multiplicity
//                                   threshold lambda = sqrt(2 ln M_eff), i.e. the
//                                   search it came from has been paid for;
//   (b) pTilde * payout - 1 > 0     positive expectancy on the SHRUNK estimate,
//                                   not on the raw in-sample proportion;
//   (c) pTilde * payout - 1 >= kappa        a minimum real edge worth the exposure
//                                   (default 0.005 = 0.5%);
//   (d) multi-window corroboration  when enabled, the deviation must also survive
//                                   the threshold at the LONGEST available window.
//
// This changes ELIGIBILITY only. It never computes, scales or caps a stake:
// `computeDynamicStake` receives the win probability as the unused parameter
// `_blendedWinP`, so no change here can move a stake. Pinned by
// recovery-staking-invariant.test.ts and recovery-v2.test.ts.

/**
 * Minimum real edge, as a fraction of stake, a recovery entry must demonstrate on
 * the shrunk estimate before it may be traded (gate rule c).
 *
 * Calibrated in scripts/recovery-lab/probe-policy.ts (case 1: layout pinned):
 *   kappa   NULL capital   PLANTED capital   PLANTED realEV
 *   0.002        -12.7            +169.8            7.05%
 *   0.005         -4.3            +147.3            6.88%   <-- shipped default
 *   0.010         -3.3            +121.7            7.57%
 *   0.020         -3.3             +19.0            3.38%
 * 0.005 removes 98% of the edge-free bleed while keeping 97% of the edge
 * capture; 0.02 starts eating the capture. 0.01 is the conservative fallback.
 */
export const HEDGE_GATE_KAPPA = 0.005;

/**
 * Recovery exposure scaling of `kappa`.
 *
 * A recovery attempt stakes more than a base stake, so the same estimated edge
 * represents a larger absolute risk. The required edge therefore scales with the
 * stake the RECOVERY LADDER has already decided on. This is an eligibility
 * threshold only — the ladder's number is read, never written.
 *
 * Enabled only when a ladder stake is supplied. With no stake the plain `kappa`
 * applies.
 */
export const HEDGE_GATE_SCALE_KAPPA_BY_STAKE = true;

/** Hard ceiling on the stake-scaled threshold, so a deep ladder cannot lock the engine out entirely. */
export const HEDGE_GATE_KAPPA_MAX = 0.03;

/**
 * Multi-window corroboration (gate rule d).
 *
 * When true, a candidate whose selected window is NOT the longest available one
 * must additionally show a same-signed deviation at the longest window that
 * survives its own threshold. A genuine bias survives every horizon; a 120-tick
 * transient does not.
 *
 * Default is decided by measurement, not by preference — see
 * docs/autonomous-recovery-improvement-plan.md section 4.1 and the
 * HEDGE_GATE_CORROBORATION evidence table.
 */
export const HEDGE_GATE_CORROBORATION = true;


/** Multi-horizon windows evaluated by M1 (ticks). */
export const HEDGE_V2_WINDOWS = [120, 500, 1500] as const;
export const HEDGE_V2_MAX_WINDOW = 1500;

/**
 * Tail aversion: weight on max(0, -es5) / base in M3 soft cost J(c).
 * Penalises contracts whose worst-5% recovery episode shortfall is large relative to base stake.
 */
export const LAMBDA_TAIL = 0.25;

/**
 * Streak aversion: weight on pStop in M3 soft cost J(c).
 * Penalises contracts with a high probability of hitting the consecutive-loss stop inside an episode.
 */
export const LAMBDA_STOP = 4;

/** Deterministic seeded PRNG (Mulberry32). Never use Math.random in scoring paths. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

