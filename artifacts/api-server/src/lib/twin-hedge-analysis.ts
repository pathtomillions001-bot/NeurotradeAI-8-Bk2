/**
 * TWIN-LOCK HEDGE SENTINEL — the analysis layer.
 *
 * THE BOT IN ONE PARAGRAPH
 * ─────────────────────────
 * Normal mode fires TWO contracts on the SAME tick with the SAME stake:
 * Over 4 (wins on 5–9) and Under 5 (wins on 0–4). Recovery mode fires the
 * mirrored pair Over 5 (wins on 6–9) and Under 4 (wins on 0–3). Both trades of
 * a round are always simultaneous; the recovery round is only ever armed when
 * BOTH normal legs lost (the split "one wins, one loses" round is deliberately
 * ignored and never triggers recovery), and its stake is sized against the
 * TOTAL lost amount of the round that triggered it.
 *
 * WHY DIGITS 4 AND 5 ARE THE ENTIRE GAME
 * ──────────────────────────────────────
 * The two contract pairs are built around the same boundary — the line between
 * digit 4 and digit 5 — and every failure mode of this bot lives on it:
 *
 *   1. NORMAL pair. Over 4 and Under 5 are complementary: on any ONE exit tick
 *      exactly one leg wins. A round can therefore only lose BOTH legs when
 *      the two buys settle on DIFFERENT ticks and the stream crosses the 4|5
 *      boundary upward between them (leg A sees ≤ 4, leg B sees ≥ 5). That is
 *      the only way a normal round reaches the recovery ladder — and the only
 *      digits whose presence at the boundary makes a crossing dangerous are
 *      4 and 5 themselves. A stream hovering on 4↔5 is a coin flip for the
 *      both-lose event; a stream anchored firmly inside {0..3} or {6..9} is
 *      not. So the entry gate refuses any tick whose boundary-hover probability
 *      is elevated, and refuses outright when the last digit IS 4 or 5 or the
 *      last tick crossed the boundary.
 *
 *   2. RECOVERY pair. Over 5 ∪ Under 4 covers 8 of 10 digits; the gap is
 *      exactly {4, 5}. A recovery round loses BOTH legs — doubling the debt —
 *      if and only if the exit digit is 4 or 5. With equal stakes S per leg
 *      and a winning-side payout m, the round pays S·(m−2) on any covered digit
 *      and −2S on a gap digit, so the pair is break-even only at
 *
 *          q* = 2 / m        (q = P(exit digit ∉ {4,5}))
 *
 *      At the canonical m = 2.43 that is q* = 0.823 — vs a "fair" 0.80. This
 *      is the ONE number the whole bot turns on: the recovery ladder can only
 *      digest debt on a market whose measured, worst-case gap-avoidance clears
 *      q* with margin. Everything the scanner computes feeds that verdict.
 *
 * WHAT THIS FILE PROVIDES
 * ───────────────────────
 *  - `edgeHazard`   worst-case P(next digit ∈ {4,5}) from three fused
 *                   estimators (Dirichlet-smoothed marginal, first-order
 *                   Markov row, zone-conditional chain), on an
 *                   autocorrelation-corrected effective sample size; the
 *                   reported number is the 95th-percentile posterior bound —
 *                   the bot trades the worst plausible hazard, not the mean.
 *  - `crossingStats` rate and asymmetry of boundary crossings (up-crossings
 *                   are the both-lose trigger; down-crossings are the
 *                   both-win windfall) with a Wald–Wolfowitz runs z on the
 *                   side-of-boundary indicator.
 *  - `boundaryAsymmetry` the recent-window (down − up)/(down + up) crossing
 *                   read the fast lane uses to stay out of up-crossing-dominant
 *                   regimes — the one microstructure that feeds both-lose.
 *  - `twinEntryGate` the pure per-tick fire/no-fire decision, TWO LANES:
 *                   NORMAL is a fast lane (point gap-rate + crossing
 *                   dominance only — the pair is self-hedging on any single
 *                   settlement tick, so there is little to check and speed is
 *                   the product), RECOVERY is a guarded lane (boundary digit,
 *                   crossing, cool-down, hazard ceiling) with a patience
 *                   valve that FORCES a fire so stranded debt never waits
 *                   forever.
 *  - `simulateTwinSession` a block bootstrap that replays the REAL digit
 *                   stream through the REAL round mechanics — same-tick
 *                   settlement with an execution-jitter probability,
 *                   debt-driven recovery stakes, max steps, TP/SL — and
 *                   returns P(take-profit before stop-loss) plus the loss-run
 *                   depth the live circuit breaker is armed against.
 *  - `evaluateTwinMarket` / `screenAndRankTwin` the market scan: every
 *                   digit-enabled market scored on survival, not vetoed by a
 *                   floor, then Benjamini–Hochberg screened; the console
 *                   offers LOCK (freeze the chosen market) or SWITCH (the
 *                   engine rotates to the next best market when the boundary
 *                   hazard measurably decays).
 *
 * Everything here is a pure function of the digit stream — unit-testable
 * without sockets, and mirrored exactly by the engine's live gates.
 */

import {
  betaPosterior,
  betaQuantile,
  lagAutocorr,
  waldWolfowitz,
  benjaminiHochberg,
  regularizedIncompleteBeta,
  payoutForBarrier,
} from "./specialist-analysis";

// ── Contract vocabulary (hard-wired: this bot may not trade anything else) ────

export interface TwinLeg {
  side: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
}

/** The normal round: Over 4 + Under 5, equal stakes, one tick. */
export const TWIN_NORMAL_LEGS: readonly TwinLeg[] = [
  { side: "DIGITOVER", barrier: 4 },   // wins on 5–9 · 50% · ~1.95×
  { side: "DIGITUNDER", barrier: 5 },  // wins on 0–4 · 50% · ~1.95×
] as const;

/** The recovery round: Over 5 + Under 4, equal stakes, one tick. */
export const TWIN_RECOVERY_LEGS: readonly TwinLeg[] = [
  { side: "DIGITOVER", barrier: 5 },   // wins on 6–9 · 40% · ~2.43×
  { side: "DIGITUNDER", barrier: 4 },  // wins on 0–3 · 40% · ~2.43×
] as const;

/** The two digits that kill every round of this bot. */
export const GAP_DIGITS: readonly number[] = [4, 5];

export function isGapDigit(d: number): boolean {
  return d === 4 || d === 5;
}

/** Which side of the 4|5 boundary a digit sits on (true = ≤ 4, "LOW side"). */
export function lowSide(d: number): boolean {
  return d <= 4;
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
 * Break-even gap-avoidance rate of the recovery pair with equal stakes:
 * the round nets S·(m−2) when a leg wins and −2S when both lose, so it is
 * break-even exactly when q·(m−2) = (1−q)·2  ⇔  q* = 2/m.
 */
export function recoveryBreakEvenGapRate(payoutMultiplier: number): number {
  const m = Number.isFinite(payoutMultiplier) && payoutMultiplier > 2 ? payoutMultiplier : 2.0001;
  return Math.min(0.999, 2 / m);
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Effective sample size under lag-1 serial dependence (dual-lock rule). */
function effectiveN(series: number[]): number {
  const rho = clamp(lagAutocorr(series, 1), -0.95, 0.95);
  return series.length * (1 - rho) / (1 + rho);
}

// ── Gap-hazard model: P(next digit ∈ {4,5}) — the number that decides all ─────

export interface EdgeHazard {
  /** Fused point estimate of P(next digit is 4 or 5). */
  p: number;
  /** Worst plausible value: 95th-percentile posterior upper bound. */
  pWorst: number;
  /** Point estimate of the SAFE rate q = 1 − p (the recovery estimand). */
  safe: number;
  /** Lower bound of q — must clear recoveryBreakEvenGapRate for ladder digest. */
  safeLcb: number;
  /** Posterior sigma of the fused estimate (before worst-case inflation). */
  sigma: number;
  samples: number;
  /** Which estimators fired (for the UI's "why"). */
  sources: string[];
}

/**
 * Fuse three estimators of P(next digit ∈ {4,5}) in inverse variance:
 *   1. Dirichlet marginal — the flat occurrence rate of {4,5}.
 *   2. First-order Markov — P(next ∈ gap | current digit), weighted by how
 *      often the current digit actually occurs (dual-lock's conditional
 *      estimand: recovery only ever trades from the post-loss digit state).
 *   3. A 2-state boundary-side chain — P(LOW→LOW, HIGH→LOW); a gap hit is a
 *      side change, so the transition structure directly prices crossings.
 * When the last digit is itself a gap digit the Markov row collapses onto the
 * post-gap state — the stream is AT the boundary and hazard estimates from it
 * are the most honest the bot will ever get.
 */
export function edgeHazard(digits: number[]): EdgeHazard {
  const n = digits.length;
  if (n < 30) {
    // Not enough history: pretend maximum hazard so gates refuse everything.
    return { p: 0.9, pWorst: 0.99, safe: 0.1, safeLcb: 0.01, sigma: 0.3, samples: n, sources: [] };
  }
  const gap = digits.map(d => (isGapDigit(d) ? 1 : 0));
  const gapHits = gap.reduce((a, b) => a + b, 0);
  const nEff = Math.max(10, effectiveN(gap));

  const ests: Array<{ p: number; sigma: number; name: string }> = [];

  // 1) Marginal — Beta posterior on the effective sample.
  {
    const post = betaPosterior(gapHits * (nEff / n), nEff, 0.2, 12);
    ests.push({ p: post.mean, sigma: post.sigma, name: "marginal" });
  }

  // 2) Markov row weighted by occurrence: P(next ∈ gap | current = d),
  //    evaluated from transition counts, smoothed, and averaged over the
  //    empirical distribution of the CURRENT digit (and, if given, over the
  //    actual last digit's row for the live gate via conditionalAt()).
  const trans = transCounts(digits);
  {
    const row = trans.rowFor(digits[n - 1]!);
    ests.push({ p: row.pGap, sigma: row.sigmaGap, name: "markov-1" });
  }

  // 3) Boundary-side chain: indicator s_t = 1[d_t ≤ 4]. A gap hit implies the
  //    stream is adjacent to the boundary on the exit tick; price P(side flip)
  //    and attribute it to the gap when the flip lands ON {4,5}.
  {
    const side = digits.map(d => (lowSide(d) ? 1 : 0));
    let flips = 0;
    let gapOnFlip = 0;
    for (let i = 1; i < side.length; i++) {
      if (side[i] !== side[i - 1]) {
        flips++;
        if (isGapDigit(digits[i]!)) gapOnFlip++;
      }
    }
    const flipN = Math.max(1, side.length - 1);
    const pFlip = flips / flipN;
    // P(next ∈ gap) ≈ P(side flip) × P(next is exactly the boundary digit | flip)
    // + P(no flip) × P(current side's boundary digit is next) — the second
    // term is second-order small; approximate with the marginal for safety.
    const marg = gapHits / n;
    const est = clamp(pFlip * clamp(gapOnFlip / Math.max(1, flips), 0, 1) + (1 - pFlip) * marg * 0.5, 0.001, 0.999);
    const sigma = Math.sqrt((est * (1 - est)) / nEff) * 1.15;
    ests.push({ p: est, sigma, name: "side-chain" });
  }

  // Inverse-variance fusion.
  const wSum = ests.reduce((a, e) => a + 1 / (e.sigma * e.sigma), 0);
  const fused = ests.reduce((a, e) => a + e.p / (e.sigma * e.sigma), 0) / wSum;
  const sigma = Math.sqrt(1 / wSum);

  // Posterior bounds on the fused rate (exact Beta quantile via the method of
  // moments: keep sigma, solve for pseudo-counts).
  const pseudo = clamp(1 / (4 * sigma * sigma) - 1, 5, nEff);
  const post = betaPosterior(fused * pseudo, pseudo, fused, 0.001);
  const pWorst = clamp(betaQuantile(0.95, post.alpha, post.beta), fused, 0.99);
  const safe = 1 - fused;
  const safeLcb = 1 - pWorst;

  return {
    p: round(fused),
    pWorst: round(pWorst),
    safe: round(safe),
    safeLcb: round(safeLcb),
    sigma: round(sigma, 4),
    samples: n,
    sources: ests.map(e => e.name),
  };
}

// ── Transition machinery (shared by the hazard model and the live gate) ──────

export interface TransitionModel {
  /** P(next digit ∈ gap | given current digit), smoothed. */
  rowFor: (current: number) => { pGap: number; sigmaGap: number };
}

function transCounts(digits: number[]): TransitionModel {
  const counts = new Map<number, { gap: number; tot: number }>();
  for (let i = 1; i < digits.length; i++) {
    const prev = digits[i - 1]!;
    const cur = digits[i]!;
    const c = counts.get(prev) ?? { gap: 0, tot: 0 };
    c.tot++;
    if (isGapDigit(cur)) c.gap++;
    counts.set(prev, c);
  }
  const margGap = digits.filter(isGapDigit).length / Math.max(1, digits.length);
  return {
    rowFor: (current: number) => {
      const c = counts.get(current) ?? { gap: 0, tot: 0 };
      // Dirichlet-style smoothing at 8 pseudo-observations of the marginal.
      const k = 8;
      const p = (c.gap + k * margGap) / (c.tot + k);
      const sigma = Math.sqrt((p * (1 - p)) / (c.tot + k + 1));
      return { pGap: clamp(p, 0.001, 0.999), sigmaGap: Math.max(0.004, sigma) };
    },
  };
}

// ── Crossing statistics: how often does the stream hop the 4|5 boundary? ──────

export interface CrossingStats {
  /** P(LOW side at t) for t+1 differ — ANY crossing rate. */
  rate: number;
  /** Up-crossings (≤4 → ≥5): the normal-pair both-lose trigger. */
  up: number;
  /** Down-crossings (≥5 → ≤4): the normal-pair both-win windfall. */
  down: number;
  /** Asymmetry (down − up) / (down + up) — positive = crossing favours us. */
  asymmetry: number;
  /** Wald–Wolfowitz z on the side indicator (>2 ⇒ clustered sides). */
  runsZ: number;
  samples: number;
}

export function crossingStats(digits: number[]): CrossingStats {
  const n = digits.length;
  if (n < 30) {
    return { rate: 1, up: 1, down: 1, asymmetry: 0, runsZ: 0, samples: n };
  }
  let up = 0;
  let down = 0;
  for (let i = 1; i < n; i++) {
    if (lowSide(digits[i - 1]!) && !lowSide(digits[i]!)) up++;
    else if (!lowSide(digits[i - 1]!) && lowSide(digits[i]!)) down++;
  }
  const steps = n - 1;
  const rate = (up + down) / steps;
  const total = up + down;
  const side = digits.map(d => (lowSide(d) ? 1 : 0));
  const runs = waldWolfowitz(side);
  return {
    rate: round(rate),
    up: round(up / steps),
    down: round(down / steps),
    asymmetry: total > 0 ? round((down - up) / total) : 0,
    runsZ: round(runs.z, 2),
    samples: steps,
  };
}

// ── Stationarity of the gap-hazard series (locks cannot adapt; drift is fatal) ─

export function hazardStationarityZ(digits: number[], blocks = 4): { z: number; rates: number[] } {
  const gap = digits.map(d => (isGapDigit(d) ? 1 : 0));
  const n = gap.length;
  if (n < blocks * 20) return { z: 0, rates: [] };
  const len = Math.floor(n / blocks);
  const rates: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const seg = gap.slice(b * len, b === blocks - 1 ? n : (b + 1) * len);
    rates.push(seg.reduce((a, x) => a + x, 0) / Math.max(1, seg.length));
  }
  const pooled = gap.reduce((a, x) => a + x, 0) / n;
  const p = clamp(pooled, 1e-6, 1 - 1e-6);
  let chi = 0;
  for (const r of rates) {
    const exp = len * p;
    const obs = r * len;
    chi += (obs - exp) ** 2 / exp + ((len - obs) - len * (1 - p)) ** 2 / (len * (1 - p));
  }
  // Wilson–Hilferty: χ²_k → ≈ N(0,1) via ((χ/k)^{1/3} − (1 − 2/(9k))) / √(2/(9k))
  const k = blocks;
  const z = ((chi / k) ** (1 / 3) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
  return { z: round(z, 2), rates: rates.map(r => round(r)) };
}

// ── Loss clustering of BOTH-LOSE events (the ladder's real enemy) ─────────────

export function gapRunStats(digits: number[]): {
  pTwoInARow: number;
  clusterRatio: number;
  expectedMaxGapRun: number;
} {
  const gap = digits.map(d => (isGapDigit(d) ? 1 : 0));
  const n = gap.length;
  if (n < 30) return { pTwoInARow: 1, clusterRatio: 2, expectedMaxGapRun: 4 };
  let pairs = 0;
  let hits = 0;
  for (let i = 1; i < n; i++) if (gap[i] === 1 && gap[i - 1] === 1) pairs++;
  for (const g of gap) hits += g;
  const pMarg = hits / n;
  const pTwo = pairs / (n - 1);
  const clusterRatio = pMarg > 0 ? pTwo / (pMarg * pMarg) : 2; // ≈1 for i.i.d.
  const qCond = clamp(pTwo / Math.max(1e-9, pMarg), 0.001, 0.999); // P(gap | gap)
  // Expected longest gap run over n ticks, geometric EV: log(n·(1−q))/log(1/q)
  const expected = Math.max(1, Math.round(Math.log(Math.max(2, n) * (1 - qCond)) / Math.log(1 / qCond)));
  return { pTwoInARow: round(pTwo), clusterRatio: round(clusterRatio, 2), expectedMaxGapRun: expected };
}

// ── Live entry gate (pure; the engine calls it once per fresh tick) ───────────

/**
 * Recent-window crossing asymmetry: (down − up) / (down + up) over the last
 * `window` ticks. Positive = down-crossings dominate (the both-WIN windfall
 * direction for the normal pair), negative = up-crossings dominate (the
 * both-LOSE trigger). 0 when the stream barely crosses.
 */
export function boundaryAsymmetry(digits: number[], window = 120): number {
  const w = digits.slice(-window);
  if (w.length < 10) return 0;
  let up = 0;
  let down = 0;
  for (let i = 1; i < w.length; i++) {
    const prevLow = w[i - 1]! <= 4;
    const curLow = w[i]! <= 4;
    if (prevLow !== curLow) {
      if (prevLow) up++;
      else down++;
    }
  }
  const total = up + down;
  return total > 0 ? (down - up) / total : 0;
}

export interface TwinGateInput {
  digits: number[];
  mode: "normal" | "recovery";
  /** Point gap-rate (hazard.p) the gate will still fire under. The old
   *  worst-case-posterior ceiling was unreachable on ordinary streams (a
   *  300-tick window's 95th-percentile bound sits ~4–6pp above the mean),
   *  which is what kept the gate closed forever. The point estimate is the
   *  honest rate; the worst case is still priced by the scan + breaker. */
  maxHazard: number;
  /** Recovery lane only: the MEASURED safe rate q̂ must clear this
   *  (= q* + margin) or the round fires FORCED (never blocked forever). */
  minSafe?: number;
  /** Recovery lane only: ticks to skip after a gap-digit settlement. */
  cooldownTicks?: number;
  /** Recovery lane only: clean ticks since the boundary (engine-computed). */
  ticksSinceBoundary?: number;
  /** How long the current setup has already waited (patience valve). */
  waitedTicks?: number;
  /** After this many waited ticks every recovery-lane refusal is overridden
   *  — debt must be digested, so the valve forces a fire. */
  maxWaitTicks?: number;
  /** Recovery lane only: the last two digits flipped sides of the boundary
   *  (engine pre-computes; a crossing in progress). */
  crossedOnLastTick?: boolean;
}

export interface TwinGateVerdict {
  fire: boolean;
  reason: string;
  hazard: EdgeHazard;
  /** True when the fire was forced by the patience valve / digest override. */
  forced?: boolean;
}

/**
 * TWO LANES, one gate:
 *
 *   NORMAL (fast lane) — the pair is self-hedging: on any single settlement
 *   tick exactly one leg wins, so the per-tick analysis can be cheap. Only
 *   two things can make a normal round bad, and both are measurable in one
 *   pass over the stream:
 *     (a) a pathologically 4/5-heavy stream (point gap rate above the
 *         ceiling) — the boundary is being hovered, so the execution split
 *         between the two legs lands on the gap far more often than fair;
 *     (b) up-crossings dominating the recent window — up-crossings are the
 *         both-lose trigger, down-crossings are the both-win windfall, so a
 *         strongly negative asymmetry is the one regime where the hedge
 *         systematically bleeds.
 *   Anything else FIRES on the fresh tick. No boundary-digit refusals, no
 *   crossing refusals, no cool-downs: a current tick of 4 or 5 only matters
 *   through (a), and a crossing in progress is priced by (b) plus the
 *   settlement skew — gating it out was the "no trades ever" behaviour.
 *
 *   RECOVERY (guarded lane) — the pair has NO hedge on the gap (both legs
 *   die on 4 or 5) and it carries debt, so the structural guards stay:
 *   boundary digit, crossing in progress, post-gap cool-down, hazard
 *   ceiling. But the patience valve FORCES a fire once it opens — stranded
 *   debt is worse than an unfavourable recovery round, and a recovery gate
 *   that never opens is as broken as one that is always open.
 */
export function twinEntryGate(input: TwinGateInput): TwinGateVerdict {
  const {
    digits, mode, maxHazard, minSafe = 0,
    cooldownTicks = 0, ticksSinceBoundary = Infinity,
    waitedTicks = 0, maxWaitTicks = 12, crossedOnLastTick = false,
  } = input;

  if (digits.length < 30) {
    return { fire: false, reason: "warming up — 30+ ticks of history required", hazard: edgeHazard(digits) };
  }
  const hazard = edgeHazard(digits);

  // ── NORMAL: fast lane ────────────────────────────────────────────────────
  if (mode === "normal") {
    if (hazard.p > maxHazard) {
      return {
        fire: false,
        reason: `gap rate ${Math.round(hazard.p * 100)}% > ${Math.round(maxHazard * 100)}% — the stream is hovering on 4/5`,
        hazard,
      };
    }
    const asym = boundaryAsymmetry(digits);
    if (asym < -0.2) {
      return {
        fire: false,
        reason: `up-crossings dominate (${Math.round(asym * 100)}% asymmetry) — the both-lose trigger is hot`,
        hazard,
      };
    }
    return {
      fire: true,
      reason: `gap ${Math.round(hazard.p * 100)}% · crossings ${asym >= 0.05 ? "favoured" : "balanced"}`,
      hazard,
    };
  }

  // ── RECOVERY: guarded lane ───────────────────────────────────────────────
  const patienceOpen = waitedTicks >= maxWaitTicks;
  const last = digits[digits.length - 1]!;

  if (isGapDigit(last) && !patienceOpen) {
    return { fire: false, reason: `current tick is the gap digit ${last} — waiting for the stream to move`, hazard };
  }
  if (crossedOnLastTick && !patienceOpen) {
    return { fire: false, reason: "boundary crossing in progress on the last tick", hazard };
  }
  if (ticksSinceBoundary < cooldownTicks && !patienceOpen) {
    return {
      fire: false,
      reason: `post-gap cool-down (${Math.floor(ticksSinceBoundary)}/${cooldownTicks} ticks)`,
      hazard,
    };
  }
  if (hazard.p > maxHazard && !patienceOpen) {
    return {
      fire: false,
      reason: `gap rate ${Math.round(hazard.p * 100)}% > ${Math.round(maxHazard * 100)}% ceiling`,
      hazard,
    };
  }

  // The digest floor: q̂ must clear break-even for an UNFORCED fire. Below it
  // the round still fires once patience opens — but the verdict says FORCED,
  // because refusing to recover strands the debt worse than an unfavourable
  // recovery does.
  const forced = minSafe > 0 && hazard.safe < minSafe;

  return {
    fire: true,
    reason: forced
      ? `recovery forced despite q̂ ${Math.round(hazard.safe * 100)}% < ${(minSafe * 100).toFixed(1)}% digest line`
      : `gap ${Math.round(hazard.p * 100)}% under ceiling · q̂ ${Math.round(hazard.safe * 100)}%`,
    hazard,
    forced,
  };
}

// ── Session simulation: the honest headline number ────────────────────────────

export interface TwinSimParams {
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  /** Recovery stake markup over exact debt coverage, percent (shared ledger). */
  markupPercent: number;
  /** Payout multipliers (live quote preferred, canonical table otherwise). */
  payoutNormal: number;  // per-leg, ≈1.95
  payoutRecovery: number; // per-leg, ≈2.43 (the MIN of the two legs — sizing)
  /** Probability one leg's buy confirms a tick late (execution jitter). */
  legSkewProb?: number;
  /** Max rounds simulated. */
  maxRounds?: number;
}

export interface TwinSimResult {
  survival: number;        // P(TP before SL)
  ruin: number;            // P(SL before TP)
  meanPnl: number;         // per-round expected net at base stake
  recoveryDepthP95: number;
  rounds: number;
  bothWinRate: number;
  bothLoseRate: number;
  splitRate: number;
}

/**
 * Stationary block bootstrap (block length 10) of the real digit stream
 * replayed through the real engine rules: same-tick pair settlement with a
 * per-round skew probability, debt-driven recovery stake
 * (debt·(1+markup)/(m−2) per leg — the pair's net profit rate, matching
 * `getBotRecoveryStake` fed the effective pair multiplier), max recovery
 * steps, TP and SL. An i.i.d. draw would destroy the clustering the ladder
 * dies on, so blocks are kept intact.
 */
export function simulateTwinSession(digits: number[], params: TwinSimParams, sims = 60, block = 10): TwinSimResult {
  const {
    stake, takeProfit, stopLoss, maxRecoverySteps, markupPercent,
    payoutNormal, payoutRecovery,
  } = params;
  const legSkew = clamp(params.legSkewProb ?? 0.15, 0, 0.6);
  const maxRounds = params.maxRounds ?? 400;
  const n = digits.length;
  if (n < 4 * block || stake <= 0) {
    return { survival: 0, ruin: 0, meanPnl: 0, recoveryDepthP95: 0, rounds: 0, bothWinRate: 0, bothLoseRate: 0, splitRate: 0 };
  }

  let tpHits = 0;
  let slHits = 0;
  let roundsTotal = 0;
  let bothWin = 0;
  let bothLose = 0;
  let splits = 0;
  let pnlSum = 0;
  const depths: number[] = [];

  // Deterministic PRNG so tests are stable; seeded from the digit stream.
  let seed = digits.reduce((a, d, i) => (a + d * (i + 7) ** 2) % 2147483647, 1013904223);
  const rnd = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };

  for (let s = 0; s < sims; s++) {
    let pnl = 0;
    let debt = 0;
    let inRec = false;
    let recStep = 0;
    let curRun = 0;
    let maxRun = 0;
    let rounds = 0;

    while (rounds < maxRounds && pnl < takeProfit && pnl > -stopLoss) {
      const start = Math.floor(rnd() * (n - block));
      const blockDigits = digits.slice(start, start + block);
      for (let i = 0; i < blockDigits.length && rounds < maxRounds; i++) {
        const dA = blockDigits[i]!;
        // Skew leg B onto the NEXT tick of the block (or the stream if at end).
        const dB = rnd() < legSkew
          ? (i + 1 < blockDigits.length ? blockDigits[i + 1]! : digits[(start + block) % n]!)
          : dA;
        const legs = inRec ? TWIN_RECOVERY_LEGS : TWIN_NORMAL_LEGS;
        const mLeg = inRec ? payoutRecovery : payoutNormal;
        const stakeLeg = inRec
          ? Math.max(0.35, (debt * (1 + markupPercent / 100)) / Math.max(0.05, mLeg - 2))
          : stake;
        const winA = legWins(legs[0]!, dA);
        const winB = legWins(legs[1]!, dB);
        let roundNet = 0;
        roundNet += winA ? stakeLeg * (mLeg - 1) - stakeLeg : -stakeLeg;
        // The skewed leg's payout uses the same per-leg multiplier for brevity.
        roundNet += winB ? stakeLeg * (mLeg - 1) - stakeLeg : -stakeLeg;

        if (inRec) {
          debt = Math.max(0, debt - roundNet);
          if (roundNet > 0) {
            recStep = 0;
            if (debt <= 0.005) { inRec = false; debt = 0; }
          } else {
            debt += -roundNet;
            recStep++;
            curRun++;
            maxRun = Math.max(maxRun, curRun);
            if (recStep > maxRecoverySteps) { slHits++; rounds++; break; }
          }
        } else {
          if (winA === false && winB === false) {
            // BOTH lost → the only normal outcome that arms recovery.
            debt += Math.max(0, -roundNet); // roundNet is −2·stake here
            inRec = true;
            recStep = 1;
            curRun = 1;
            maxRun = Math.max(maxRun, curRun);
            bothLose++;
          } else if (winA && winB) {
            bothWin++;
            curRun = 0;
          } else {
            splits++;
            // Split rounds are IGNORED for recovery (product rule) — the small
            // (m−2)·stake tax still lands in the P&L.
          }
        }
        pnl += roundNet;
        pnlSum += roundNet;
        rounds++;
        if (pnl >= takeProfit || pnl <= -stopLoss || rounds >= maxRounds) break;
      }
      roundsTotal += rounds;
      depths.push(maxRun);
      if (pnl >= takeProfit) tpHits++;
      else if (pnl <= -stopLoss && recStep <= maxRecoverySteps) slHits++;
    }
  }

  const finished = tpHits + slHits;
  depths.sort((a, b) => a - b);
  const p95 = depths.length ? depths[Math.floor(depths.length * 0.95)] ?? depths[depths.length - 1]! : 0;
  return {
    survival: finished > 0 ? round(tpHits / finished) : 0,
    ruin: finished > 0 ? round(slHits / finished) : 0,
    meanPnl: roundsTotal > 0 ? round(pnlSum / roundsTotal, 4) : 0,
    recoveryDepthP95: p95,
    rounds: roundsTotal,
    bothWinRate: roundsTotal > 0 ? round(bothWin / roundsTotal) : 0,
    bothLoseRate: roundsTotal > 0 ? round(bothLose / roundsTotal) : 0,
    splitRate: roundsTotal > 0 ? round(splits / roundsTotal) : 0,
  };
}

// ── Market candidate: what the scan produces per market ──────────────────────

export interface TwinHedgeCandidate {
  symbol: string;
  displayName: string;
  /** 0–100 composite. */
  score: number;
  /** Bootstrap P(TP before SL) under the user's real risk numbers. */
  survival: number;
  ruin: number;
  meanPnl: number;
  recoveryDepthP95: number;
  bothWinRate: number;
  bothLoseRate: number;
  /** Gap hazard, fused worst case. */
  gapHazard: number;
  gapHazardWorst: number;
  /** P(next ∉ {4,5}) point + LCB — the recovery digest estimand. */
  safeRate: number;
  safeLcb: number;
  /** Break-even q* for the recovery pair at this market's live payouts. */
  recoveryBreakEven: number;
  /**
   * Measured digest: the POINT safe rate clears break-even. This is the
   * deployment badge — a stream where 4/5 appear at or below the break-even
   * frequency lets the ladder repay on average. It is deliberately the point
   * estimate: the old worst-case LCB test vetoed nearly every real market
   * (a 300-tick window's 5th-percentile bound sits a few points below the
   * mean), which is what kept the deploy buttons locked forever.
   */
  recoveryViable: boolean;
  /** The old strict test (worst-case LCB clears q*) — a quality badge, not a veto. */
  recoveryViableWorst: boolean;
  crossingRate: number;
  crossingAsymmetry: number;
  runsZ: number;
  stationarityZ: number;
  clusterRatio: number;
  expectedMaxGapRun: number;
  payoutNormal: number;
  payoutRecovery: number;
  samples: number;
  reason: string;
  signals: string[];
  metrics: Record<string, number>;
  /** BH significance of the recovery-digest test — set by screenAndRankTwin. */
  significant?: boolean;
}

export interface TwinEvalOptions extends TwinSimParams {
  /** Live payout quotes override the canonical table when provided. */
  livePayouts?: { over4: number; under5: number; over5: number; under4: number };
}

/**
 * Score one market from its digit stream. `livePayouts` (a quote cache)
 * replaces the canonical multipliers for the recovery break-even test.
 */
export function evaluateTwinMarket(
  symbol: string,
  displayName: string,
  digits: number[],
  opts: TwinEvalOptions,
): TwinHedgeCandidate {
  const signals: string[] = [];
  const n = digits.length;

  const hazard = edgeHazard(digits);
  const crossing = crossingStats(digits);
  const station = hazardStationarityZ(digits);
  const runs = gapRunStats(digits);

  const pOver5 = opts.livePayouts?.over5 ?? payoutForBarrier("DIGITOVER", 5);
  const pUnder4 = opts.livePayouts?.under4 ?? payoutForBarrier("DIGITUNDER", 4);
  const pOver4 = opts.livePayouts?.over4 ?? payoutForBarrier("DIGITOVER", 4);
  const pUnder5 = opts.livePayouts?.under5 ?? payoutForBarrier("DIGITUNDER", 5);
  // Sizing uses the MIN of the two recovery legs — a win must cover the debt
  // whichever side won it.
  const pRecMin = Math.min(pOver5, pUnder4);
  const pNormAvg = (pOver4 + pUnder5) / 2;
  const qStar = recoveryBreakEvenGapRate(pRecMin);
  const recoveryViable = hazard.safe >= qStar;
  const recoveryViableWorst = hazard.safeLcb >= qStar;

  const sim = simulateTwinSession(digits, {
    ...opts,
    payoutNormal: pNormAvg,
    payoutRecovery: pRecMin,
  });

  // ── Composite score ───────────────────────────────────────────────────────
  // Survival dominates (it prices everything), then the MEASURED digest
  // margin, then gap level (point — the worst-case bound is a small-sample
  // artefact and would punish every honest stream), then crossing churn,
  // drift and clustering.
  let score = 0;
  score += clamp(sim.survival, 0, 1) * 40;
  score += clamp((hazard.safe - qStar) / 0.05, 0, 1) * 20;
  score += clamp((0.24 - hazard.p) / 0.12, 0, 1) * 12;
  score += clamp((0.25 - crossing.rate) / 0.12, 0, 1) * 8;
  score += clamp((3 - station.z) / 3, 0, 1) * 7;
  score += clamp((1.25 - runs.clusterRatio) / 0.5, 0, 1) * 3;
  score = Math.round(clamp(score, 0, 100));

  if (n < 120) signals.push(`BLOCKED: only ${n} digits in buffer (120 needed)`);
  if (!recoveryViableWorst && recoveryViable) {
    signals.push(`INFO: worst-case gap-avoidance ${Math.round(hazard.safeLcb * 100)}% is under the ${(qStar * 100).toFixed(1)}% digest line — recovery rounds work harder here, the measured rate clears it`);
  }
  if (!recoveryViable) {
    signals.push(`INFO: measured gap-avoidance ${Math.round(hazard.safe * 100)}% is under the ${(qStar * 100).toFixed(1)}% digest line — the ladder takes longer to repay; normal rounds still trade freely`);
  }
  if (hazard.p > 0.26) signals.push(`WARN: gap digits are ${Math.round(hazard.p * 100)}% of the stream (>26%) — the boundary is being hovered`);
  if (station.z > 3) signals.push(`WARN: gap-hazard drift across blocks (z ${station.z})`);
  if (runs.clusterRatio > 1.35) signals.push(`WARN: gap digits cluster (ξ ${runs.clusterRatio}) — both-lose events pair up`);
  if (crossing.asymmetry < -0.12) signals.push(`WARN: up-crossings dominate (${Math.round(crossing.asymmetry * 100)}% asymmetry) — both-lose risk elevated`);
  if (sim.survival >= 0.6) signals.push(`survival ${(sim.survival * 100).toFixed(0)}% over ${sim.rounds} simulated rounds`);
  if (pNormAvg >= 1.0 && (pOver4 + pUnder5) >= 2.001) signals.push("normal pair pays over stakes (mOver+mUnder ≥ 2)");

  const reason = recoveryViable
    ? `${displayName}: measured gap-avoidance ${Math.round(hazard.safe * 100)}% clears the ${(qStar * 100).toFixed(1)}% digest line (worst case ${Math.round(hazard.safeLcb * 100)}%), survival ${(sim.survival * 100).toFixed(0)}%`
    : `${displayName}: below the ${(qStar * 100).toFixed(1)}% digest line (measured q̂ ${Math.round(hazard.safe * 100)}%) — the ladder works harder here; normal rounds trade freely and the patience valve keeps recovery moving`;

  return {
    symbol,
    displayName,
    score,
    survival: sim.survival,
    ruin: sim.ruin,
    meanPnl: sim.meanPnl,
    recoveryDepthP95: sim.recoveryDepthP95,
    bothWinRate: sim.bothWinRate,
    bothLoseRate: sim.bothLoseRate,
    gapHazard: hazard.p,
    gapHazardWorst: hazard.pWorst,
    safeRate: hazard.safe,
    safeLcb: hazard.safeLcb,
    recoveryBreakEven: round(qStar),
    recoveryViable,
    recoveryViableWorst,
    crossingRate: crossing.rate,
    crossingAsymmetry: crossing.asymmetry,
    runsZ: crossing.runsZ,
    stationarityZ: station.z,
    clusterRatio: runs.clusterRatio,
    expectedMaxGapRun: runs.expectedMaxGapRun,
    payoutNormal: round(pNormAvg),
    payoutRecovery: round(pRecMin),
    samples: n,
    reason,
    signals,
    metrics: {
      recoveryDepthP95: sim.recoveryDepthP95,
      bothWinRate: sim.bothWinRate,
      bothLoseRate: sim.bothLoseRate,
      splitRate: sim.splitRate,
      upCross: crossing.up,
      downCross: crossing.down,
    },
  };
}

// ── Cross-market screening ───────────────────────────────────────────────────

/**
 * Rank candidates: BH-FDR over the per-market recovery-digest test
 * (P(q > q*) evaluated as a one-sided posterior probability turned into a
 * p-value), viable-first, then score. Markets are never vetoed for a modest
 * survival figure — the scan ranks, the USER decides whether to deploy (the
 * dual-lock lesson).
 */
export function screenAndRankTwin(
  candidates: TwinHedgeCandidate[],
  q = 0.2,
): TwinHedgeCandidate[] {
  if (candidates.length === 0) return [];
  // One-sided posterior test per market: P(safe rate > break-even).
  const pValues = candidates.map(c => {
    if (c.samples < 120) return 1;
    const post = betaPosterior(c.safeRate * c.samples, c.samples, c.recoveryBreakEven, 12);
    // p = P(true safe rate ≤ break-even): small ⇒ the market's gap-avoidance
    // is significantly ABOVE the digest line. Exact posterior CDF at be.
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

export interface RankedTwinCandidate extends TwinHedgeCandidate {
  significant: boolean;
}
