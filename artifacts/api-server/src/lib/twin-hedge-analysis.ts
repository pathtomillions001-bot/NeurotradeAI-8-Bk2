/**
 * BOUNDARY HEDGE SENTINEL — analysis layer.
 *
 * THE BOT IN ONE PARAGRAPH
 * ─────────────────────────
 * Normal mode: Over 4 + Under 5, SAME stake, SAME tick. On ANY single digit
 * one leg wins and the other loses — EXCEPT digits 4 and 5 where BOTH lose.
 * Recovery mode: Over 5 + Under 4, SAME stake, SAME tick, only when BOTH
 * normal legs lost. Same split-win/lose dynamic, same gap at {4,5}.
 *
 * THE USER'S KEY INSIGHT
 * ──────────────────────
 * Since both trades execute simultaneously on the same tick, we always get
 * one win and one loss UNLESS we land on digit 4 or 5. That means:
 *   - Every round on digit 0-3 or 6-9 nets a profit (one leg pays out)
 *   - Every round on digit 4 or 5 loses both legs
 *   - 80% win rate per round on a fair stream
 *
 * THE ANALYSIS CHALLENGE
 * ─────────────────────
 * Since digits are i.i.d. uniform, no analysis can PREDICT whether the next
 * digit will be 4 or 5. The analysis therefore focuses on:
 *   1. MARKET QUALITY: does this market show a normal 4/5 frequency (~20%)?
 *      Markets hovering on 4/5 (>28%) are avoided.
 *   2. RECOVERY VIABILITY: can the safe rate (1 - 4/5 frequency) clear the
 *      recovery break-even line q* = 2/payout?
 *   3. SPEED: the gate fires on almost every tick. Only a genuinely 4/5-heavy
 *      stream holds the round. Recovery has a patience valve that forces
 *      a fire after 5 ticks to prevent stranded debt.
 *
 * DESIGN PRINCIPLE: MINIMAL GATES, MAXIMUM SPEED
 * ──────────────────────────────────────────────
 * The old Twin-Lock had too many gates (crossing analysis, boundary asymmetry,
 * stationarity, clustering, cool-downs) that blocked nearly every trade.
 * This version has TWO gates:
 *   Normal:   gap rate < 30% → fire
 *   Recovery: current digit ≠ 4/5 → fire (patience valve after 5 ticks)
 * That's it. The hedge structure IS the edge — we just need to avoid markets
 * that are genuinely hovering on the boundary.
 */

import {
  betaPosterior,
  betaQuantile,
  lagAutocorr,
  benjaminiHochberg,
  regularizedIncompleteBeta,
  payoutForBarrier,
} from "./specialist-analysis";

// ── Contract vocabulary (hard-wired) ──────────────────────────────────────────

export interface TwinLeg {
  side: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
}

/** Normal: Over 4 + Under 5, equal stakes, one tick. */
export const TWIN_NORMAL_LEGS: readonly TwinLeg[] = [
  { side: "DIGITOVER", barrier: 4 },   // wins on 5–9 · 50% · ~1.95×
  { side: "DIGITUNDER", barrier: 5 },  // wins on 0–4 · 50% · ~1.95×
] as const;

/** Recovery: Over 5 + Under 4, equal stakes, one tick. */
export const TWIN_RECOVERY_LEGS: readonly TwinLeg[] = [
  { side: "DIGITOVER", barrier: 5 },   // wins on 6–9 · 40% · ~2.43×
  { side: "DIGITUNDER", barrier: 4 },  // wins on 0–3 · 40% · ~2.43×
] as const;

export const GAP_DIGITS: readonly number[] = [4, 5];

export function isGapDigit(d: number): boolean {
  return d === 4 || d === 5;
}

export function legWins(leg: TwinLeg, digit: number): boolean {
  return leg.side === "DIGITOVER" ? digit > leg.barrier : digit < leg.barrier;
}

export function legLabel(leg: TwinLeg): string {
  return `${leg.side === "DIGITOVER" ? "Over" : "Under"} ${leg.barrier}`;
}

export function isTwinNormalLeg(side: string, barrier: number): boolean {
  return TWIN_NORMAL_LEGS.some(l => l.side === side && l.barrier === barrier);
}

export function isTwinRecoveryLeg(side: string, barrier: number): boolean {
  return TWIN_RECOVERY_LEGS.some(l => l.side === side && l.barrier === barrier);
}

/**
 * Break-even safe rate for recovery: q* = 2/m.
 * At m=2.43 that's q* ≈ 0.823 — the safe rate must clear this for the
 * recovery ladder to digest debt.
 */
export function recoveryBreakEvenGapRate(payoutMultiplier: number): number {
  const m = Number.isFinite(payoutMultiplier) && payoutMultiplier > 2 ? payoutMultiplier : 2.0001;
  return Math.min(0.999, 2 / m);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ── Gap hazard: P(next digit ∈ {4,5}) — SIMPLIFIED ───────────────────────────

export interface EdgeHazard {
  /** Point estimate of P(next digit is 4 or 5). */
  p: number;
  /** 95th-percentile upper bound (worst plausible). */
  pWorst: number;
  /** Safe rate q = 1 − p. */
  safe: number;
  /** Lower bound of q. */
  safeLcb: number;
  sigma: number;
  samples: number;
}

/**
 * Estimate P(next ∈ {4,5}) using a Dirichlet-smoothed marginal on an
 * autocorrelation-corrected effective sample size. One estimator, not three —
 * the stream is i.i.d. and the extra estimators added latency without accuracy.
 */
export function edgeHazard(digits: number[]): EdgeHazard {
  const n = digits.length;
  if (n < 30) {
    return { p: 0.9, pWorst: 0.99, safe: 0.1, safeLcb: 0.01, sigma: 0.3, samples: n };
  }
  const gap = digits.map(d => (isGapDigit(d) ? 1 : 0));
  const gapHits = gap.reduce((a, b) => a + b, 0);

  // Effective sample size under lag-1 autocorrelation
  const rho = clamp(lagAutocorr(gap, 1), -0.95, 0.95);
  const nEff = Math.max(10, n * (1 - rho) / (1 + rho));

  // Beta posterior with Jeffreys prior (0.5, 0.5) + a mild pull toward fair 20%
  const post = betaPosterior(gapHits * (nEff / n), nEff, 0.2, 12);
  const pWorst = clamp(betaQuantile(0.95, post.alpha, post.beta), post.mean, 0.99);

  return {
    p: round(post.mean),
    pWorst: round(pWorst),
    safe: round(1 - post.mean),
    safeLcb: round(1 - pWorst),
    sigma: round(post.sigma, 4),
    samples: n,
  };
}

// ── Entry gate — TWO LANES, minimal logic ─────────────────────────────────────

export interface TwinGateInput {
  digits: number[];
  mode: "normal" | "recovery";
  /** Normal lane: refuse if gap rate above this (default 0.30). */
  maxHazard?: number;
  /** Recovery lane: ticks waited so far (for patience valve). */
  waitedTicks?: number;
  /** Recovery patience: force fire after this many refused ticks. */
  maxWaitTicks?: number;
}

export interface TwinGateVerdict {
  fire: boolean;
  reason: string;
  hazard: EdgeHazard;
  forced?: boolean;
}

/**
 * TWO LANES:
 *
 *   NORMAL (fast): fire if gap rate < 30%. That's the ONLY check. The hedge
 *   handles everything else — on any single tick one leg wins. No crossing
 *   analysis, no asymmetry, no cool-downs. Speed is the product.
 *
 *   RECOVERY (guarded + patience): fire if current digit ≠ 4/5. If the
 *   current digit IS 4 or 5, wait one tick. Patience valve forces a fire
 *   after maxWaitTicks (5) to prevent stranded debt.
 */
export function twinEntryGate(input: TwinGateInput): TwinGateVerdict {
  const {
    digits, mode,
    maxHazard = 0.30,
    waitedTicks = 0,
    maxWaitTicks = 5,
  } = input;

  if (digits.length < 30) {
    return { fire: false, reason: "warming up — 30+ ticks needed", hazard: edgeHazard(digits) };
  }

  const hazard = edgeHazard(digits);

  // ── NORMAL: fast lane — just check gap rate ────────────────────────────
  if (mode === "normal") {
    if (hazard.p > maxHazard) {
      return {
        fire: false,
        reason: `gap rate ${Math.round(hazard.p * 100)}% > ${Math.round(maxHazard * 100)}% — boundary is hot`,
        hazard,
      };
    }
    return {
      fire: true,
      reason: `gap ${Math.round(hazard.p * 100)}% — clear to fire`,
      hazard,
    };
  }

  // ── RECOVERY: guarded lane + patience valve ────────────────────────────
  const patienceOpen = waitedTicks >= maxWaitTicks;
  const last = digits[digits.length - 1]!;

  if (isGapDigit(last) && !patienceOpen) {
    return { fire: false, reason: `digit ${last} is the gap — waiting`, hazard };
  }

  if (hazard.p > 0.35 && !patienceOpen) {
    return {
      fire: false,
      reason: `gap rate ${Math.round(hazard.p * 100)}% > 35% — boundary is too hot for recovery`,
      hazard,
    };
  }

  return {
    fire: true,
    reason: patienceOpen
      ? `recovery forced after ${waitedTicks} ticks — debt must be digested`
      : `gap ${Math.round(hazard.p * 100)}% — clear for recovery`,
    hazard,
    forced: patienceOpen,
  };
}

// ── Market scan — rank by 4/5 avoidance ───────────────────────────────────────

export interface TwinHedgeCandidate {
  symbol: string;
  displayName: string;
  score: number;
  gapHazard: number;
  gapHazardWorst: number;
  safeRate: number;
  safeLcb: number;
  recoveryBreakEven: number;
  recoveryViable: boolean;
  crossingRate: number;
  payoutNormal: number;
  payoutRecovery: number;
  samples: number;
  reason: string;
  signals: string[];
  metrics: Record<string, number>;
  significant?: boolean;
}

/**
 * Score one market: how well does it avoid digits 4 and 5?
 * Simple scoring: lower 4/5 frequency = better market.
 */
export function evaluateTwinMarket(
  symbol: string,
  displayName: string,
  digits: number[],
  opts: { stake: number; payoutNormal: number; payoutRecovery: number },
): TwinHedgeCandidate {
  const signals: string[] = [];
  const n = digits.length;

  const hazard = edgeHazard(digits);

  // Crossing rate: how often does the stream cross the 4|5 boundary?
  let crossings = 0;
  for (let i = 1; i < n; i++) {
    if ((digits[i - 1]! <= 4) !== (digits[i]! <= 4)) crossings++;
  }
  const crossingRate = n > 1 ? crossings / (n - 1) : 0;

  // Recovery viability: does the safe rate clear the break-even line?
  const qStar = recoveryBreakEvenGapRate(opts.payoutRecovery);
  const recoveryViable = hazard.safe >= qStar;

  // Score: lower gap rate = higher score (max 100)
  const gapScore = clamp((0.30 - hazard.p) / 0.20, 0, 1) * 60;
  const safeScore = clamp((hazard.safe - qStar) / 0.15, 0, 1) * 25;
  const crossScore = clamp((0.30 - crossingRate) / 0.20, 0, 1) * 15;
  const score = Math.round(clamp(gapScore + safeScore + crossScore, 0, 100));

  if (n < 120) signals.push(`BLOCKED: only ${n} digits (120 needed)`);
  if (!recoveryViable) signals.push(`INFO: safe rate ${Math.round(hazard.safe * 100)}% < ${(qStar * 100).toFixed(1)}% digest — recovery works harder`);
  if (hazard.p > 0.26) signals.push(`WARN: 4/5 at ${Math.round(hazard.p * 100)}% — boundary is being hovered`);
  if (recoveryViable) signals.push(`OK: safe rate ${Math.round(hazard.safe * 100)}% clears ${(qStar * 100).toFixed(1)}% digest line`);

  const reason = recoveryViable
    ? `${displayName}: 4/5 at ${Math.round(hazard.p * 100)}% · safe ${Math.round(hazard.safe * 100)}% clears ${(qStar * 100).toFixed(1)}% digest · score ${score}`
    : `${displayName}: 4/5 at ${Math.round(hazard.p * 100)}% · safe ${Math.round(hazard.safe * 100)}% below ${(qStar * 100).toFixed(1)}% digest · score ${score}`;

  return {
    symbol,
    displayName,
    score,
    gapHazard: hazard.p,
    gapHazardWorst: hazard.pWorst,
    safeRate: hazard.safe,
    safeLcb: hazard.safeLcb,
    recoveryBreakEven: round(qStar),
    recoveryViable,
    crossingRate: round(crossingRate),
    payoutNormal: round(opts.payoutNormal),
    payoutRecovery: round(opts.payoutRecovery),
    samples: n,
    reason,
    signals,
    metrics: {
      gapHazard: hazard.p,
      safeRate: hazard.safe,
      crossingRate,
    },
  };
}

/**
 * Rank markets: viable-first, then by score. BH-FDR across the family.
 */
export function screenAndRankTwin(
  candidates: TwinHedgeCandidate[],
  q = 0.2,
): TwinHedgeCandidate[] {
  if (candidates.length === 0) return [];

  const pValues = candidates.map(c => {
    if (c.samples < 120) return 1;
    const post = betaPosterior(c.safeRate * c.samples, c.samples, c.recoveryBreakEven, 12);
    return clamp(regularizedIncompleteBeta(c.recoveryBreakEven, post.alpha, post.beta), 1e-9, 1);
  });
  const significant = benjaminiHochberg(pValues, q);
  const decorated = candidates.map((c, i) => ({
    ...c,
    significant: significant[i] === true && c.samples >= 120,
  }));
  return decorated.sort((a, b) => {
    if (a.recoveryViable !== b.recoveryViable) return a.recoveryViable ? -1 : 1;
    if (a.significant !== b.significant) return a.significant ? -1 : 1;
    return b.score - a.score;
  });
}