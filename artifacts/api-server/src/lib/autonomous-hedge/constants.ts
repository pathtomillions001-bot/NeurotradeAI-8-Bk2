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
export const RECOVERY_V2_MODE: RecoveryV2Mode = "shadow";

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

