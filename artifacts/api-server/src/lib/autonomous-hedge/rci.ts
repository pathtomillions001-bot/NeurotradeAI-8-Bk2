/**
 * Autonomous engine — Recovery Cost Index (RCI) contract selector (WP3).
 *
 * Replaces the Nexus recovery RANKING for the v2 path (normal mode is
 * untouched). The shipped ranker scores (lowerBound − breakEven) plus Markov /
 * clustering / instability terms that carry no information on i.i.d. data and
 * only add confirmations, rematch penalties and tick delays (D8). RCI instead
 * prices the four things that genuinely differ between recovery contracts on a
 * cryptographic RNG:
 *
 *   margin_c     = 1 − p0_c · payout_c           house edge paid per $1 staked
 *   geometry_c   = payout_c / (payout_c − 1)     how many $ of stake a $ of debt needs
 *   firstStake_c = (D + T′) / (payout_c − 1)     exact one-win stake (T′ = 0 in adaptive)
 *   feasible_c   = firstStake_c ≤ headroomCap     can the budget actually take it?
 *
 *   RCI_c = w1·margin_c + w2·ruinPreview_c + w3·clearTimePreview_c
 *
 * Pick the LOWEST RCI among feasible candidates. Ties break by feed health
 * (freshest tape, then freshest quote), then by fewest recent rejections —
 * never by a wait. No confirmations, no rematch penalty, no Markov terms: a
 * recovery fires on the first tick where feasibility and freshness pass.
 *
 * The ruin / clear-time previews are wired in WP5; until then they are 0 and
 * RCI reduces to the margin ordering (still correct — lowest house edge first).
 */

import type { AutonomousContractSpec } from "./contract-sets";

/** Deriv's minimum stake (production copy — the cycle uses the same value). */
const MIN_DERIV_STAKE = 0.35;

export interface RciWeights {
  /** Weight on the margin (house edge) term. */
  w1: number;
  /** Weight on the WP5 ruin preview. 0 until WP5. */
  w2: number;
  /** Weight on the WP5 clear-time preview. 0 until WP5. */
  w3: number;
}

export const DEFAULT_RCI_WEIGHTS: RciWeights = Object.freeze({ w1: 1, w2: 0, w3: 0 });

/** True per-tick win probability of a contract on i.i.d. data (D5's p0, not the tape estimate). */
export function recoverySpecP0(spec: AutonomousContractSpec): number {
  switch (spec.type) {
    case "DIGITOVER": return (9 - spec.digit) / 10;
    case "DIGITUNDER": return spec.digit / 10;
    case "DIGITMATCH": return 0.1;
    case "DIGITDIFF": return 0.9;
    default: return 0.5; // Even, Odd, Rise, Fall
  }
}

export interface RciCandidateInput {
  spec: AutonomousContractSpec;
  /** Market symbol — keys the WP6 honesty tilt (e-processes are per market). */
  symbol?: string;
  /** Payout multiplier used for sizing — the live quote when fresh, else the table. */
  payout: number;
  /** Where `payout` came from (telemetry + tiebreak). */
  quoteSource: "live" | "fallback";
  /** Milliseconds since the quote was taken (lower = fresher). */
  quoteAgeMs: number;
  /** Milliseconds since the market's newest tick (lower = healthier feed). */
  tapeAgeMs: number;
  /** Recent execution rejections for this contract (tiebreak, lower better). */
  recentRejections: number;
  /** Optional WP5 previews; default 0 keeps WP3 self-contained. */
  ruinPreview?: number;
  clearTimePreview?: number;
}

export interface RciScored extends RciCandidateInput {
  p0: number;
  margin: number;
  geometry: number;
  firstStake: number;
  feasible: boolean;
  rci: number;
}

export interface RciDecision {
  /** The contract to trade, or null when nothing is affordable this tick. */
  chosen: RciScored | null;
  /**
   * True when the chosen contract cannot clear the debt in one win at the
   * headroom cap, so the stake is capped and the budget rule (WP4) carries the
   * remainder. Only ever true for the highest-p0 partial candidate.
   */
  partial: boolean;
  feasibleCount: number;
  /** Every candidate scored, best-first — published for telemetry/shadow. */
  ranked: RciScored[];
}

export function scoreRecoveryCandidates(input: {
  candidates: RciCandidateInput[];
  /** Outstanding loss debt D. */
  debt: number;
  /** Optional sizing target T′ — the adaptive method passes 0 (D4). */
  targetProfit?: number;
  /** Remaining drawdown headroom a single stake may consume (WP4). */
  headroomCap: number;
  weights?: RciWeights;
  /**
   * WP6 honesty tilt: per-candidate multiplier applied to the margin weight w1.
   * Must return a factor in [TILT_FLOOR, 1] — it can only REDUCE margin
   * aversion, never amplify it, and never touches stakes. Omitted ⇒ 1.
   */
  marginWeightFactor?: (spec: AutonomousContractSpec, symbol?: string) => number;
}): RciDecision {
  const debt = Math.max(0, Number.isFinite(input.debt) ? input.debt : 0);
  const targetRaw = input.targetProfit ?? 0;
  const target = Math.max(0, Number.isFinite(targetRaw) ? targetRaw : 0);
  const cap = Number.isFinite(input.headroomCap) ? input.headroomCap : Number.POSITIVE_INFINITY;
  const w = input.weights ?? DEFAULT_RCI_WEIGHTS;

  const scored: RciScored[] = input.candidates
    .filter((c) => Number.isFinite(c.payout) && c.payout > 1)
    .map((c) => {
      const p0 = recoverySpecP0(c.spec);
      const margin = 1 - p0 * c.payout;
      const geometry = c.payout / (c.payout - 1);
      const firstStake = (debt + target) / (c.payout - 1);
      const feasible = firstStake <= cap;
      const ruinPreview = Number.isFinite(c.ruinPreview) ? c.ruinPreview! : 0;
      const clearTimePreview = Number.isFinite(c.clearTimePreview) ? c.clearTimePreview! : 0;
      const rawFactor = input.marginWeightFactor ? input.marginWeightFactor(c.spec) : 1;
      // Clamp defensively: the tilt is a REDUCTION bounded below by 0.5.
      const factor = Number.isFinite(rawFactor) ? Math.min(1, Math.max(0.5, rawFactor)) : 1;
      const rci = w.w1 * factor * margin + w.w2 * ruinPreview + w.w3 * clearTimePreview;
      return { ...c, p0, margin, geometry, firstStake, feasible, rci };
    });

  // Sort: feasible first, then lowest RCI, then feed health, then rejections.
  const ranked = [...scored].sort((a, b) =>
    Number(b.feasible) - Number(a.feasible) ||
    a.rci - b.rci ||
    a.tapeAgeMs - b.tapeAgeMs ||
    a.quoteAgeMs - b.quoteAgeMs ||
    a.recentRejections - b.recentRejections,
  );

  const feasibleOnes = ranked.filter((r) => r.feasible);
  if (feasibleOnes.length > 0) {
    return { chosen: feasibleOnes[0], partial: false, feasibleCount: feasibleOnes.length, ranked };
  }

  // Nothing clears in one win inside the cap. Take the highest-p0 contract the
  // cap can still fund at the minimum stake and run partial recovery — never
  // idle. If even the minimum stake exceeds the cap there is genuinely nothing
  // affordable this tick (chosen = null), which is a budget fact, not a wait.
  const partialCandidates = ranked
    .filter((r) => cap >= MIN_DERIV_STAKE)
    .sort((a, b) => b.p0 - a.p0 || a.rci - b.rci);
  if (partialCandidates.length > 0) {
    return { chosen: partialCandidates[0], partial: true, feasibleCount: 0, ranked };
  }
  return { chosen: null, partial: false, feasibleCount: 0, ranked };
}
