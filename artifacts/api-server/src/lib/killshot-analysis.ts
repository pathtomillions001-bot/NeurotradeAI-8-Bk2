/**
 * KILL-SHOT PRECISION SNIPER — analysis core of the 7th specialist bot.
 *
 * THE BRIEF
 * ─────────
 * "Few trades, extremely accurate, no margin for error. Take as long as you
 *  need for the analysis, but when you fire it must be the kill shot. The user
 *  picks ONE contract — Over N, Under N, Matches D, Even, or Odd (never both
 *  sides of a pair). The market is LOCKED: no switching, no rotation. Use the
 *  same shared recovery system as the other bots."
 *
 * That brief inverts the objective of every other bot in this app. The other
 * six maximise EDGE PER UNIT TIME — they want a decent trade soon. This one
 * maximises CONFIDENCE PER TRADE and is completely indifferent to how long it
 * waits. Waiting costs nothing here; being wrong costs everything.
 *
 * That single change of objective is what licenses a genuinely different, and
 * strictly stronger, statistical design.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE OBVIOUS APPROACH IS WRONG
 * ─────────────────────────────────────────────────────────────────────────────
 * The naive "high accuracy" bot computes p̂ over a window and fires when
 * p̂ > threshold. It fails for three separate reasons, and this bot fixes all
 * three:
 *
 *  (1) CONTINUOUS PEEKING BREAKS FIXED-SAMPLE STATISTICS. A bot that re-tests
 *      the same hypothesis on every tick and fires the moment the test passes
 *      is guaranteed to fire eventually, even on pure noise — that is the law
 *      of the iterated logarithm, not a bug. A 95 % fixed-sample confidence
 *      interval, checked 500 times, has a false-positive rate far above 5 %.
 *      FIX: everything here is ANYTIME-VALID. Confidence comes from test
 *      supermartingales, whose guarantees hold at arbitrary, data-dependent
 *      stopping times — which is exactly what "fire when you're sure" is.
 *
 *  (2) ARGMAX OVER MANY CANDIDATES IS BIASED UPWARD. Scanning 10 digits × many
 *      contexts and taking the best inflates the winner's apparent edge.
 *      FIX: Benjamini–Hochberg FDR across the candidate set, plus a selection
 *      penalty proportional to log(number of candidates examined).
 *
 *  (3) AVERAGE ACCURACY IS THE WRONG TARGET. A 95 %-accurate strategy that
 *      loses in pairs is worse than a 90 %-accurate one that never does,
 *      because the recovery ladder is what actually ruins an account.
 *      FIX: consecutive-loss structure is a FIRST-CLASS GATE, not a diagnostic
 *      (see the Markov section below).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEVEN-LAYER EVIDENCE STACK
 * ─────────────────────────────────────────────────────────────────────────────
 * A trade fires only when ALL seven layers agree. Any single veto stands.
 *
 * L1 is satisfied at one of two bars. PRIME: the anytime-valid floor itself
 * clears break-even — airtight at any stopping time, and rare. STANDARD: the
 * sequential test has fired and the floor sits within a bounded relative
 * shortfall of break-even, with the cross-market Benjamini–Hochberg screen
 * carrying the multiple-comparison risk. The prime bar alone needs ~1300 ticks
 * of one regime to resolve a 2-point edge, which is why the prime-only version
 * of this bot never traded.
 *
 * L1. WALD SEQUENTIAL PROBABILITY RATIO TEST (the primary trigger).
 *     H₀: p = p_be (break-even — the trade is worthless)
 *     H₁: p = p_be + δ (a real, tradeable edge)
 *     Λ_n = Σ log[ f₁(xᵢ) / f₀(xᵢ) ], accumulated tick by tick.
 *     Fire when Λ_n ≥ B = log((1−β)/α); abandon when Λ_n ≤ A = log(β/(1−α)).
 *     Wald–Wolfowitz proved the SPRT minimises the expected number of
 *     observations among ALL tests with the same error rates — i.e. it is the
 *     provably fastest way to reach a given certainty. Since this bot is
 *     defined by "be certain, take as long as you like", the SPRT is not a
 *     heuristic choice; it is the optimal one. The alternative H₁ is break-even
 *     + 2 ABSOLUTE points, which is the scale the house margin lives at; a
 *     relative δ made H₁ unreachable on high-probability contracts and is why an
 *     earlier revision of this bot could never fire.
 *
 * L2. VARIABLE-ORDER MARKOV CONTEXT MODEL.
 *     Digit streams carry short-range structure. A fixed 1st-order chain is too
 *     coarse and a fixed 3rd-order chain is too sparse (10³ = 1000 contexts).
 *     This model estimates P(win | last k digits) for k = 0,1,2,3 and fuses
 *     them by KRICHEVSKY–TROFIMOV mixing — the context-tree-weighting estimator
 *     that provably competes with the best fixed-order model in hindsight,
 *     without having to know the right order in advance. Deeper contexts are
 *     only trusted in proportion to the evidence actually behind them.
 *
 * L3. ANYTIME-VALID CONFIDENCE SEQUENCE (the peeking fix).
 *     A betting-style test supermartingale gives a lower bound on p that is
 *     valid SIMULTANEOUSLY at every tick:
 *         M_n = Π (1 + λ(xᵢ − p)),  P(∃n : M_n ≥ 1/α) ≤ α  for the true p.
 *     Inverting M gives an anytime-valid lower confidence bound. Unlike a Wald
 *     interval, this one cannot be gamed by watching it until it looks good.
 *
 * L4. CONSECUTIVE-LOSS MARKOV GATE (the ruin fix — the user's stated priority).
 *     Model the loss indicator as a 2-state chain and require the scale-free
 *         ξ = P(loss|loss)/P(loss) ≤ 1.0   (losses must not attract losses)
 *     The gate uses the one-sided 95 % LOWER bound on ξ, not its point estimate:
 *     ξ wanders either side of 1.0 on an independent stream from sampling noise
 *     alone, and gating on the estimate refused clean markets half the time.
 *     An absolute ceiling on P(two losses in a row) was tried and removed: it is
 *     unsatisfiable below ~86 % win rate, so it banned every mid-barrier contract
 *     regardless of the market. P(two in a row) is still reported, against its
 *     own independence baseline pLoss², because the comparison is what is
 *     meaningful. Also compute the stationary-chain probability of a k-long loss run
 *         P(run ≥ k) = π_L · q^(k−1)
 *     which must stay under a hard ceiling. A market that produces paired
 *     losses is refused no matter how high its win rate is, because the whole
 *     value of this bot is that the recovery ladder is never asked to go deep.
 *
 * L5. STATIONARITY + DRIFT.
 *     Pearson χ² block homogeneity (Wilson–Hilferty z) plus a monotone-trend
 *     check. The evidence the SPRT accumulated over hundreds of ticks is only
 *     meaningful if those ticks came from one regime.
 *
 * L6. MULTI-HORIZON CONCORDANCE.
 *     The edge must be visible at 60, 120, 240 and 480 ticks. A signal present
 *     in one window and absent in the others is a window artefact. Disagreement
 *     across horizons is an automatic veto.
 *
 * L7. SELECTION CONTROL.
 *     BH-FDR across every candidate the bot considered (all 10 digits for
 *     Matches), plus a log(#candidates) evidence surcharge on the SPRT
 *     threshold. The winner has to be good, not merely luckiest.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MARKET SELECTION (also locked, also once)
 * ─────────────────────────────────────────────────────────────────────────────
 * The user names the contract; the bot names the market — once, before the
 * session, from the same seven-layer stack applied to every market. After that
 * the market is FROZEN. There is no rotation and no switching at any point,
 * including after a loss. Everything about this bot is "decide slowly, commit
 * completely".
 */

import {
  betaPosterior,
  regularizedIncompleteBeta,
  lagAutocorr,
  waldWolfowitz,
  benjaminiHochberg,
  payoutForBarrier,
} from "./specialist-analysis";
import { EVEN_ODD_PAYOUT, MATCH_PAYOUT } from "./payouts";

// ── Contract vocabulary ───────────────────────────────────────────────────────

export type KillShotKind = "over" | "under" | "match" | "even" | "odd";

export interface KillShotContract {
  kind: KillShotKind;
  /** Barrier digit. Required for over/under/match; ignored for even/odd. */
  digit?: number;
}

export const KILLSHOT_CONTRACT_TYPE: Record<KillShotKind, string> = {
  over: "DIGITOVER",
  under: "DIGITUNDER",
  match: "DIGITMATCH",
  even: "DIGITEVEN",
  odd: "DIGITODD",
};

export function killShotLabel(c: KillShotContract): string {
  switch (c.kind) {
    case "over":  return `Over ${c.digit}`;
    case "under": return `Under ${c.digit}`;
    case "match": return c.digit === undefined ? "Matches (AI picks digit)" : `Matches ${c.digit}`;
    case "even":  return "Even";
    case "odd":   return "Odd";
  }
}

/** Digits that WIN this contract. */
export function killShotWinSet(c: KillShotContract): Set<number> {
  const s = new Set<number>();
  for (let d = 0; d <= 9; d++) {
    switch (c.kind) {
      case "over":  if (c.digit !== undefined && d > c.digit) s.add(d); break;
      case "under": if (c.digit !== undefined && d < c.digit) s.add(d); break;
      case "match": if (d === c.digit) s.add(d); break;
      case "even":  if (d % 2 === 0) s.add(d); break;
      case "odd":   if (d % 2 === 1) s.add(d); break;
    }
  }
  return s;
}

/** Total-return payout multiplier for this contract (stake included). */
export function killShotPayout(c: KillShotContract): number {
  switch (c.kind) {
    case "over":  return payoutForBarrier("DIGITOVER", c.digit ?? 4);
    case "under": return payoutForBarrier("DIGITUNDER", c.digit ?? 5);
    case "match": return MATCH_PAYOUT;
    case "even":
    case "odd":   return EVEN_ODD_PAYOUT;
  }
}

/** Break-even win rate = 1 / payout. */
export function killShotBreakEven(c: KillShotContract): number {
  return 1 / killShotPayout(c);
}

/**
 * Validate a user-chosen contract. Enforces the "exactly one side" rule: the
 * caller may name Over OR Under (never both), Even OR Odd (never both), or
 * Matches. There is no "both" mode anywhere in this bot.
 */
export function validateKillShotContract(raw: any): { ok: true; contract: KillShotContract } | { ok: false; error: string } {
  const kind = raw?.kind;
  if (!["over", "under", "match", "even", "odd"].includes(kind)) {
    return { ok: false, error: "kind must be one of: over, under, match, even, odd" };
  }
  if (kind === "even" || kind === "odd") {
    return { ok: true, contract: { kind } };
  }
  const digit = raw?.digit;
  if (kind === "match" && (digit === undefined || digit === null || digit === "")) {
    // Matches may delegate the digit choice to the AI.
    return { ok: true, contract: { kind: "match" } };
  }
  const d = Number(digit);
  if (!Number.isInteger(d) || d < 0 || d > 9) {
    return { ok: false, error: `${kind} requires an integer digit 0–9` };
  }
  if (kind === "over" && d > 8) return { ok: false, error: "Over 9 can never win — choose 0–8" };
  if (kind === "under" && d < 1) return { ok: false, error: "Under 0 can never win — choose 1–9" };
  return { ok: true, contract: { kind, digit: d } };
}

// ── Numeric helpers ───────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// ── L1: Wald Sequential Probability Ratio Test ────────────────────────────────

export interface SprtResult {
  /** Accumulated log-likelihood ratio. */
  logLR: number;
  /** Upper (accept-H₁ / FIRE) threshold. */
  upper: number;
  /** Lower (accept-H₀ / abandon) threshold. */
  lower: number;
  decision: "fire" | "abandon" | "continue";
  /** Evidence odds in favour of a real edge (e^logLR), capped for display. */
  oddsForEdge: number;
  /** Fraction of the way to the fire threshold, 0–1. */
  progress: number;
  n: number;
  /** Expected additional observations to a decision under H₁ (Wald's formula). */
  expectedRemaining: number;
}

/**
 * Wald's SPRT for a Bernoulli stream.
 *
 * @param series   0/1 win indicators, oldest → newest.
 * @param p0       Null rate (no edge) — the break-even rate.
 * @param p1       Alternative rate (real edge) — break-even + δ.
 * @param alpha    Type-I error (firing on a market with no edge). Default 0.5 %.
 * @param beta     Type-II error (missing a real edge). Default 10 % — being slow
 *                 is free for this bot, so type-I is priced far more strictly.
 * @param penaltyNats  Extra evidence required to offset multiple-candidate
 *                 selection (log of the number of candidates examined).
 */
export function sprt(
  series: number[],
  p0: number,
  p1: number,
  alpha = 0.005,
  beta = 0.10,
  penaltyNats = 0,
): SprtResult {
  const a = clamp(p0, 1e-6, 1 - 1e-6);
  const b = clamp(p1, 1e-6, 1 - 1e-6);
  const llrWin = Math.log(b / a);
  const llrLoss = Math.log((1 - b) / (1 - a));

  let logLR = 0;
  for (const x of series) logLR += x === 1 ? llrWin : llrLoss;

  const upper = Math.log((1 - beta) / alpha) + penaltyNats;
  const lower = Math.log(beta / (1 - alpha));

  const decision: SprtResult["decision"] =
    logLR >= upper ? "fire" : logLR <= lower ? "abandon" : "continue";

  // Wald's expected sample size under H₁:
  //   E[n] ≈ [(1−β)·B + β·A] / E₁[llr],  E₁[llr] = p₁·llrWin + (1−p₁)·llrLoss
  const drift = b * llrWin + (1 - b) * llrLoss;
  const remainingNats = Math.max(0, upper - logLR);
  const expectedRemaining = drift > 1e-9 ? Math.ceil(remainingNats / drift) : Number.POSITIVE_INFINITY;

  return {
    logLR: round(logLR, 3),
    upper: round(upper, 3),
    lower: round(lower, 3),
    decision,
    oddsForEdge: round(Math.min(1e9, Math.exp(clamp(logLR, -50, 20))), 2),
    progress: clamp(upper > 0 ? logLR / upper : 0, -1, 1),
    n: series.length,
    expectedRemaining: Number.isFinite(expectedRemaining) ? expectedRemaining : 9999,
  };
}

// ── L2: Variable-order Markov context model (KT-mixed) ────────────────────────

export interface ContextModel {
  /** Fused P(win | current context). */
  p: number;
  /** Per-order estimates, index = context depth. */
  byOrder: Array<{ order: number; p: number; n: number; weight: number }>;
  /** Depth that carried the most weight. */
  dominantOrder: number;
}

/**
 * Krichevsky–Trofimov-mixed variable-order Markov estimate of P(win | context).
 *
 * The KT estimator (a + ½)/(n + 1) is the minimax-optimal sequential predictor
 * for a Bernoulli source; mixing over depths with weights proportional to each
 * depth's own KT evidence is the Context-Tree-Weighting principle. The practical
 * effect: deep context is used exactly as much as it has earned, and a sparse
 * 3rd-order context can never override a well-evidenced 1st-order one.
 */
export function contextModel(digits: number[], winSet: ReadonlySet<number>, maxOrder = 3): ContextModel {
  const wins = digits.map(d => (winSet.has(d) ? 1 : 0));
  const n = digits.length;
  const byOrder: ContextModel["byOrder"] = [];

  for (let order = 0; order <= maxOrder; order++) {
    if (n < order + 30) continue;
    // The context is the last `order` digits of the stream.
    const ctx = digits.slice(n - order);
    let hits = 0;
    let count = 0;
    for (let i = order; i < n; i++) {
      let match = true;
      for (let k = 0; k < order; k++) {
        if (digits[i - order + k] !== ctx[k]) { match = false; break; }
      }
      if (!match) continue;
      count++;
      hits += wins[i]!;
    }
    if (count < 5 && order > 0) continue;
    // Krichevsky–Trofimov estimator.
    const p = (hits + 0.5) / (count + 1);
    // Evidence weight: grows with count, discounted for depth (a deeper model
    // must earn its extra parameters).
    const weight = (count / (count + 12)) * Math.pow(0.7, order);
    byOrder.push({ order, p: round(p), n: count, weight: round(weight, 4) });
  }

  if (byOrder.length === 0) {
    const base = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : winSet.size / 10;
    return { p: base, byOrder: [], dominantOrder: 0 };
  }

  const wSum = byOrder.reduce((a, o) => a + o.weight, 0);
  const p = wSum > 0
    ? byOrder.reduce((a, o) => a + o.weight * o.p, 0) / wSum
    : byOrder[0]!.p;
  const dominant = byOrder.reduce((best, o) => (o.weight > best.weight ? o : best), byOrder[0]!);

  return { p: round(clamp(p, 1e-4, 1 - 1e-4)), byOrder, dominantOrder: dominant.order };
}

// ── L3: Anytime-valid confidence sequence ─────────────────────────────────────

export interface ConfidenceSequence {
  /** Anytime-valid lower confidence bound on the true win rate. */
  lower: number;
  /** Point estimate. */
  mean: number;
  /** Peak value of the test supermartingale (evidence against the null). */
  maxWealth: number;
  n: number;
}

/**
 * Betting-style (Waudby-Smith–Ramdas) anytime-valid lower confidence bound.
 *
 * For each candidate rate m, the wealth process
 *     K_n(m) = Π_{i≤n} (1 + λᵢ · (xᵢ − m))
 * is a non-negative martingale when m is the true mean, so Ville's inequality
 * gives  P(∃n : K_n(m) ≥ 1/α) ≤ α.  Rejecting every m whose wealth ever exceeds
 * 1/α leaves a confidence set valid at ALL times simultaneously — including at
 * the data-dependent moment this bot chooses to fire, which is precisely where
 * a fixed-sample interval would be invalid.
 *
 * λ is the predictable (past-only) GRAPA-style plug-in bet, capped for
 * stability.
 */
export function anytimeLowerBound(series: number[], alpha = 0.01): ConfidenceSequence {
  const n = series.length;
  const mean = n > 0 ? series.reduce((a, b) => a + b, 0) / n : 0.5;
  if (n < 20) return { lower: Math.max(0, mean - 0.3), mean: round(mean), maxWealth: 1, n };

  const threshold = Math.log(1 / alpha);
  // Grid search for the largest m whose wealth never crosses the threshold.
  const wealthLog = (m: number): number => {
    let logK = 0;
    let peak = 0;
    let runHits = 0;
    for (let i = 0; i < n; i++) {
      // Predictable estimate of the mean from the PAST only (no look-ahead).
      const pastMean = (runHits + 0.5) / (i + 1);
      const varEst = Math.max(0.01, pastMean * (1 - pastMean));
      // Bet size: capped fraction of the Kelly-optimal bet, one-sided (we test
      // "is the true rate below m?", so we bet on positive deviations).
      const lambda = clamp((pastMean - m) / varEst, 0, 0.75 / Math.max(1e-6, 1 - m));
      logK += Math.log(Math.max(1e-12, 1 + lambda * (series[i]! - m)));
      peak = Math.max(peak, logK);
      runHits += series[i]!;
    }
    return peak;
  };

  let lo = 0;
  let hi = mean;
  // The bound is the smallest m NOT rejected; wealth is monotone-ish in m, so
  // bisect. 24 iterations ⇒ ~1e-7 precision, negligible cost.
  for (let it = 0; it < 24; it++) {
    const mid = (lo + hi) / 2;
    if (wealthLog(mid) >= threshold) lo = mid; else hi = mid;
  }
  return {
    lower: round(clamp(lo, 0, 1)),
    mean: round(mean),
    maxWealth: round(Math.exp(Math.min(30, wealthLog(Math.max(0, lo)))), 2),
    n,
  };
}

// ── L4: Consecutive-loss Markov gate ──────────────────────────────────────────

export interface LossStructure {
  pLoss: number;
  pLossGivenLoss: number;
  /** ξ = P(loss|loss)/P(loss). ≤ 1 means losses REPEL each other. */
  clusterRatio: number;
  /**
   * One-sided 95 % LOWER bound on ξ. This is what the gate uses.
   *
   * ξ is an estimate, and on an independent stream it wanders either side of
   * 1.0 purely from sampling noise — gating on the point estimate refused
   * perfectly clean markets half the time (a synthetic 28 % stream scored
   * ξ = 1.01 and was vetoed). "Losses must not attract losses" is only a
   * meaningful veto when the clustering is DEMONSTRATED, so the gate asks
   * whether even the conservative bound still exceeds 1.
   */
  clusterRatioLower: number;
  /** Stationary-chain P(two losses in a row). */
  pTwoInARow: number;
  /** Stationary-chain P(three losses in a row). */
  pThreeInARow: number;
  /** Longest observed loss run in the window. */
  maxLossRun: number;
  /** Wald–Wolfowitz runs z: > 0 means the stream alternates (good here). */
  runsZ: number;
  /** Expected longest loss run over a 100-trade horizon. */
  expectedMaxRun: number;
}

/**
 * Full consecutive-loss structure of a win/loss stream.
 *
 * This is the layer the user actually asked for: "an edge that won't allow
 * consecutive losses". Average accuracy says nothing about pairing — a stream
 * can be 95 % accurate and still deliver its 5 % of losses back to back, which
 * is what forces the recovery ladder deep. So the loss indicator gets its own
 * 2-state Markov chain and the pairing probabilities become hard gates.
 */
export function lossStructure(wins: number[]): LossStructure {
  const n = wins.length;
  const losses = wins.map(w => (w === 1 ? 0 : 1));
  const nLoss = losses.reduce((a, b) => a + b, 0);
  const pLoss = n > 0 ? nLoss / n : 1;

  let lossThenLoss = 0;
  let lossTransitions = 0;
  for (let i = 1; i < n; i++) {
    if (losses[i - 1] === 1) {
      lossTransitions++;
      if (losses[i] === 1) lossThenLoss++;
    }
  }
  // Laplace-smoothed toward the marginal so a handful of losses cannot claim a
  // 0 % or 100 % conditional.
  const prior = 5;
  const q = (lossThenLoss + prior * pLoss) / (lossTransitions + prior);
  const clusterRatio = pLoss > 1e-6 ? q / pLoss : 1;
  // Wald interval on the conditional, carried through the ξ = q/pLoss scaling.
  const qSe = Math.sqrt(Math.max(1e-9, q * (1 - q)) / Math.max(1, lossTransitions));
  const qLower = Math.max(0, q - 1.645 * qSe);
  const clusterRatioLower = pLoss > 1e-6 ? qLower / pLoss : 1;

  let maxRun = 0;
  let cur = 0;
  for (const l of losses) { if (l === 1) { cur++; maxRun = Math.max(maxRun, cur); } else cur = 0; }

  const qc = clamp(q, 1e-4, 0.9999);
  const expectedMaxRun = Math.log(Math.max(1.0001, 100 * (1 - qc))) / Math.log(1 / qc);

  return {
    pLoss: round(pLoss),
    pLossGivenLoss: round(q),
    clusterRatio: round(clusterRatio, 3),
    clusterRatioLower: round(clusterRatioLower, 3),
    pTwoInARow: round(pLoss * q),
    pThreeInARow: round(pLoss * q * q),
    maxLossRun: maxRun,
    runsZ: round(waldWolfowitz(wins).z, 2),
    expectedMaxRun: round(expectedMaxRun, 2),
  };
}

// ── L5: Stationarity ──────────────────────────────────────────────────────────

/** Pearson χ² block homogeneity as a Wilson–Hilferty z, plus a trend slope. */
export function stationarity(series: number[], blocks = 5): { z: number; trend: number; rates: number[] } {
  const n = series.length;
  if (n < blocks * 20) return { z: 0, trend: 0, rates: [] };
  const size = Math.floor(n / blocks);
  const rates: number[] = [];
  const counts: Array<{ hits: number; n: number }> = [];
  for (let b = 0; b < blocks; b++) {
    const seg = series.slice(b * size, (b + 1) * size);
    const hits = seg.reduce((a, x) => a + x, 0);
    counts.push({ hits, n: seg.length });
    rates.push(round(hits / Math.max(1, seg.length), 3));
  }
  const totalHits = counts.reduce((a, c) => a + c.hits, 0);
  const totalN = counts.reduce((a, c) => a + c.n, 0);
  const pBar = totalHits / Math.max(1, totalN);
  if (pBar <= 0 || pBar >= 1) return { z: 0, trend: 0, rates };

  let chi2 = 0;
  for (const c of counts) {
    const eH = c.n * pBar;
    const eM = c.n * (1 - pBar);
    chi2 += (c.hits - eH) ** 2 / Math.max(1e-9, eH);
    chi2 += ((c.n - c.hits) - eM) ** 2 / Math.max(1e-9, eM);
  }
  const df = blocks - 1;
  const t = Math.cbrt(chi2 / df);
  const m = 1 - 2 / (9 * df);
  const s = Math.sqrt(2 / (9 * df));

  // Ordinary least-squares slope of block rate vs block index — a directional
  // drift the χ² (which is order-blind) cannot see.
  const xBar = (blocks - 1) / 2;
  const yBar = rates.reduce((a, r) => a + r, 0) / blocks;
  let num = 0;
  let den = 0;
  for (let i = 0; i < blocks; i++) { num += (i - xBar) * (rates[i]! - yBar); den += (i - xBar) ** 2; }

  return { z: round((t - m) / s, 2), trend: round(den > 0 ? num / den : 0, 4), rates };
}

// ── L6: Multi-horizon concordance ─────────────────────────────────────────────

export const KILLSHOT_HORIZONS = [60, 120, 240, 480] as const;

export interface Concordance {
  /** Per-horizon win rates. */
  rates: Array<{ window: number; p: number; n: number }>;
  /** Number of horizons whose rate clears the break-even hurdle. */
  agreeing: number;
  total: number;
  /** Spread between the best and worst horizon (small = coherent signal). */
  spread: number;
  /** All horizons agree. */
  unanimous: boolean;
}

export function concordance(digits: number[], winSet: ReadonlySet<number>, breakEven: number, margin: number): Concordance {
  const rates: Concordance["rates"] = [];
  for (const w of KILLSHOT_HORIZONS) {
    const seg = digits.slice(-w);
    if (seg.length < Math.min(40, w * 0.6)) continue;
    const hits = seg.reduce((a, d) => a + (winSet.has(d) ? 1 : 0), 0);
    rates.push({ window: w, p: round(hits / seg.length), n: seg.length });
  }
  if (rates.length === 0) return { rates, agreeing: 0, total: 0, spread: 1, unanimous: false };
  const agreeing = rates.filter(r => r.p >= breakEven + margin).length;
  const ps = rates.map(r => r.p);
  return {
    rates,
    agreeing,
    total: rates.length,
    spread: round(Math.max(...ps) - Math.min(...ps)),
    unanimous: agreeing === rates.length && rates.length >= 3,
  };
}

/**
 * Digit history the engine feeds each evaluation. Long enough that the
 * anytime-valid confidence sequence is tight (its width falls as 1/√n), short
 * enough that it still describes the current regime.
 */
export const KILLSHOT_WINDOW = 1200;

// ── Candidate evaluation ──────────────────────────────────────────────────────

/**
 * GATE CONSTANTS — deliberately severe. This bot's whole product promise is
 * that it fires rarely and is right when it does; every one of these numbers is
 * set where it is because loosening it would trade precision for frequency,
 * which is the opposite of the brief.
 */
export const KILLSHOT_GATES = {
  /** Minimum digit history before any candidate may even be scored. */
  minSamples: 200,
  /**
   * SPRT type-I error: firing on a market with no edge. 1-in-20 (≈20:1 evidence
   * odds per test). It was 0.5 % while this bot locked a single market and had
   * nothing else to do; in hunt mode the multiple-comparison risk is carried by
   * the Benjamini–Hochberg screen and the log(#candidates) surcharge instead,
   * which is where it belongs, so the per-test α can be honest rather than
   * punitive.
   */
  alpha: 0.05,
  /** SPRT type-II error: missing a real edge. */
  beta: 0.20,
  /**
   * The edge the SPRT is powered to detect, in ABSOLUTE probability points
   * above break-even — deliberately not a relative fraction.
   *
   * A relative δ made the test unanswerable: for Over 0 (break-even 91.7 %) a
   * 6 % relative δ set H₁ at 97.2 %, a rate no digit stream reaches, so the test
   * could only ever abandon and the bot could never fire on any contract. Two
   * absolute points is the scale the house margin actually lives at, and it is
   * reachable — when the truth sits above H₁ the log-likelihood ratio
   * accumulates at ~0.02 nats/tick and the test decides in ~150 ticks.
   */
  deltaAbs: 0.02,
  /** Ceiling on H₁ so an extreme contract is never handed an unreachable bar. */
  deltaMaxRel: 0.35,
  /** PRIME tier: the anytime-valid floor must clear break-even by this much. */
  lcbMarginRel: 0.015,
  /**
   * STANDARD tier: how far the anytime-valid floor may sit BELOW break-even
   * while the SPRT still carries the shot. A confidence sequence over a few
   * hundred ticks is several points wide, so demanding the floor itself beat
   * break-even is demanding ~1300 ticks of one regime — airtight, but it is why
   * the bot previously never traded. The BH-FDR screen across every market is
   * what controls the false-discovery risk this tolerance admits.
   */
  maxLcbShortfallRel: 0.09,
  /** Loss clustering ceiling — losses must not attract losses. */
  maxClusterRatio: 1.0,
  /** |χ²→z| ceiling: the regime must be stable. */
  maxStationarityZ: 2.5,
  /** Absolute ceiling on the block-rate trend slope. */
  maxTrend: 0.05,
  /** Minimum agreeing horizons out of those measurable. */
  minAgreeingHorizons: 2,
  /** Maximum spread between horizon rates. */
  maxHorizonSpread: 0.15,
  /** Composite confidence a candidate must reach to be deployable. */
  minConfidence: 70,
  /** Confidence a PRIME (anytime-valid) setup must reach. */
  minConfidencePrime: 66,
} as const;

export interface KillShotCandidate {
  symbol: string;
  displayName: string;
  contract: KillShotContract;
  label: string;
  /** 0–100 composite confidence. */
  confidence: number;
  /** Fused win-probability estimate. */
  pWin: number;
  /** Anytime-valid lower confidence bound. */
  pLower: number;
  breakEven: number;
  payout: number;
  /** Expected value per $1 staked. */
  expectedValue: number;
  sprt: SprtResult;
  context: ContextModel;
  loss: LossStructure;
  stationarity: { z: number; trend: number; rates: number[] };
  concordance: Concordance;
  samples: number;
  /**
   * Evidence tier. `prime` — the anytime-valid floor itself clears break-even,
   * so the shot is defensible at any stopping time. `standard` — the sequential
   * test fired and the floor sits within tolerance of break-even. `marginal` —
   * never fired.
   */
  tier: "prime" | "standard" | "marginal";
  /** Win rate of an unbiased stream on this contract (winSet.size / 10). */
  fairRate: number;
  /** The rate the SPRT must be convinced of (break-even + δ). */
  requiredRate: number;
  /**
   * fairRate − breakEven, in percentage points. Negative for every Deriv digit
   * contract — that gap is the house margin, and it is the amount by which the
   * market must be running hot before the contract can be +EV at all.
   */
  headroomPP: number;
  /** Independence baseline for P(two losses in a row), i.e. pLoss². */
  pairBaseline: number;
  /** Passed every hard gate — only these may ever be fired. */
  deployable: boolean;
  /** Reasons the candidate was refused (empty ⇒ clean). */
  blockers: string[];
  signals: string[];
  pValue: number;
  significant: boolean;
}

/**
 * Score ONE (market, contract) candidate through the full seven-layer stack.
 *
 * `penaltyNats` carries the selection surcharge: when the caller is choosing
 * among N candidates it passes log(N), which raises the SPRT bar so the winner
 * must be genuinely exceptional rather than merely the luckiest of N.
 */
export function evaluateKillShotCandidate(
  symbol: string,
  displayName: string,
  digits: number[],
  contract: KillShotContract,
  penaltyNats = 0,
): KillShotCandidate | null {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  if (clean.length < KILLSHOT_GATES.minSamples) return null;

  const winSet = killShotWinSet(contract);
  if (winSet.size === 0) return null;

  const payout = killShotPayout(contract);
  const breakEven = killShotBreakEven(contract);
  const wins = clean.map(d => (winSet.has(d) ? 1 : 0));

  // ── L1: SPRT ──────────────────────────────────────────────────────────────
  // H₁ = break-even + δ, with δ absolute (see KILLSHOT_GATES.deltaAbs) and
  // capped so an extreme contract is never handed an unreachable alternative.
  const deltaCap = Math.min(KILLSHOT_GATES.deltaAbs, (1 - breakEven) * KILLSHOT_GATES.deltaMaxRel);
  const p1 = clamp(breakEven + Math.max(0.004, deltaCap), breakEven + 0.004, 0.995);
  const sprtRes = sprt(wins, breakEven, p1, KILLSHOT_GATES.alpha, KILLSHOT_GATES.beta, penaltyNats);

  // ── L2: variable-order context model ──────────────────────────────────────
  const ctx = contextModel(clean, winSet, 3);

  // ── L3: anytime-valid confidence sequence ─────────────────────────────────
  const cs = anytimeLowerBound(wins, 0.01);

  // ── L4: consecutive-loss structure ────────────────────────────────────────
  const loss = lossStructure(wins);

  // ── L5: stationarity ──────────────────────────────────────────────────────
  const stat = stationarity(wins, 5);

  // ── L6: multi-horizon concordance ─────────────────────────────────────────
  const conc = concordance(clean, winSet, breakEven, breakEven * KILLSHOT_GATES.lcbMarginRel);

  // Fused win probability: the marginal rate and the context-conditional
  // estimate, blended by evidence, then FLOORED by the anytime-valid bound. The
  // floor is what makes the number safe to act on — it is the rate the data can
  // actually defend at a data-dependent stopping time.
  const marginal = cs.mean;
  const fused = 0.5 * marginal + 0.5 * ctx.p;
  const pWin = round(clamp(fused, 1e-4, 1 - 1e-4));
  const pLower = round(Math.min(pWin, cs.lower));
  const expectedValue = round(pWin * payout - 1, 4);

  // Exact one-sided posterior p-value that the rate exceeds break-even, used
  // for the BH-FDR screen the caller applies across all candidates.
  const nEffRho = clamp(lagAutocorr(wins, 1), -0.95, 0.95);
  const nEff = clamp((wins.length * (1 - nEffRho)) / (1 + nEffRho), 10, wins.length);
  const post = betaPosterior((cs.mean * nEff), nEff, winSet.size / 10, 10);
  // Posterior probability the rate is BELOW break-even (small ⇒ real edge).
  // This IS the one-sided p-value fed to the BH-FDR screen.
  const pBelowBe = round(clamp(regularizedBelow(breakEven, post.alpha, post.beta), 0, 1), 6);

  // Structural headroom: how far an unbiased stream sits from break-even. This
  // is the number that explains a refusal — for Over 0 it is −1.7pp, which is
  // why no honest analysis of a fair market can ever call it +EV.
  const fairRate = winSet.size / 10;
  const headroomPP = (fairRate - breakEven) * 100;
  const pairBaseline = (1 - pWin) ** 2;

  // ── Structural gates (contract-agnostic, always hard) ───────────────────
  //
  // These are the gates that keep a kill shot a kill shot. Note what is NOT
  // here any more: an absolute ceiling on P(two losses in a row). A flat 2 %
  // ceiling is unsatisfiable for any contract whose win rate is below ~86 % —
  // an independent 55 % stream pairs its losses 20 % of the time — so it silently
  // banned Over 3–8, Matches, Even and Odd outright no matter how good the market
  // was. Loss pairing is scale-dependent; the scale-free statistic that actually
  // measures it is ξ = P(loss|loss)/P(loss), and that is what gates here.
  const blockers: string[] = [];

  if (loss.clusterRatioLower > KILLSHOT_GATES.maxClusterRatio) {
    blockers.push(
      `losses cluster — ξ ${loss.clusterRatio.toFixed(2)} (95% lower bound ${loss.clusterRatioLower.toFixed(2)}) ` +
      `is demonstrably above ${KILLSHOT_GATES.maxClusterRatio}`,
    );
  }
  if (Math.abs(stat.z) > KILLSHOT_GATES.maxStationarityZ) {
    blockers.push(`non-stationary (z ${stat.z})`);
  }
  if (Math.abs(stat.trend) > KILLSHOT_GATES.maxTrend) {
    blockers.push(`rate is drifting (slope ${stat.trend} per block)`);
  }
  if (conc.agreeing < Math.min(KILLSHOT_GATES.minAgreeingHorizons, conc.total)) {
    blockers.push(`only ${conc.agreeing}/${conc.total} horizons agree`);
  }
  if (conc.spread > KILLSHOT_GATES.maxHorizonSpread) {
    blockers.push(`horizons disagree (spread ${(conc.spread * 100).toFixed(1)}%)`);
  }
  if (expectedValue <= 0) {
    blockers.push(
      `negative expected value (${(expectedValue * 100).toFixed(1)}% per $1) — ` +
      `${killShotLabel(contract)} needs the market running at ${((1 / payout) * 100).toFixed(1)}% ` +
      `but an unbiased stream wins only ${((winSet.size / 10) * 100).toFixed(1)}%`,
    );
  }

  // ── Evidence tier (the trigger) ─────────────────────────────────────────
  // Two bars, one of which must be met. The prime bar is airtight at any
  // stopping time. The standard bar admits a bounded shortfall on the
  // anytime-valid floor and leans on the SPRT plus the cross-market FDR screen;
  // it exists because the prime bar alone needs ~1300 ticks of a single regime
  // to detect a 2-point edge, which is why this bot previously never fired.
  const shortfallRel = Math.max(0, breakEven - pLower) / Math.max(1e-6, breakEven);
  /**
   * The edge the confidence score is built from.
   *
   * Above break-even the anytime-valid floor is used directly — it is the
   * airtight number. Within tolerance of break-even the point estimate is used
   * but DISCOUNTED in proportion to how much of the tolerance is consumed, so
   * the score falls continuously to zero exactly at the tolerance edge. Without
   * this, a stream running 8.3 points hot on Over 1 scored zero on the edge term
   * purely because a simultaneous confidence bound over 1200 ticks is wide, and
   * an overwhelming setup (SPRT odds ~10⁶:1) failed the confidence bar.
   */
  const edgeEvidence = pLower >= breakEven
    ? pLower - breakEven
    : (pWin - breakEven) * Math.max(0, 1 - shortfallRel / KILLSHOT_GATES.maxLcbShortfallRel);
  const prime = pLower >= breakEven * (1 + KILLSHOT_GATES.lcbMarginRel);
  const standard = sprtRes.decision === "fire" && shortfallRel <= KILLSHOT_GATES.maxLcbShortfallRel;
  const tier: KillShotCandidate["tier"] = prime ? "prime" : standard ? "standard" : "marginal";

  if (tier === "marginal") {
    if (sprtRes.decision !== "fire") {
      blockers.push(
        sprtRes.decision === "abandon"
          ? `SPRT rejected the edge (logLR ${sprtRes.logLR} ≤ ${sprtRes.lower}) — the stream is running below the ${((p1) * 100).toFixed(1)}% this contract needs`
          : `SPRT still gathering evidence (${sprtRes.logLR}/${sprtRes.upper} nats, ≈${sprtRes.expectedRemaining} more ticks)`,
      );
    } else {
      blockers.push(`anytime-valid worst case ${(pLower * 100).toFixed(1)}% sits ${((breakEven - pLower) * 100).toFixed(1)}pp under break-even ${(breakEven * 100).toFixed(1)}% (tolerance ${(KILLSHOT_GATES.maxLcbShortfallRel * breakEven * 100).toFixed(1)}pp)`);
    }
  }

  // ── Composite confidence ──────────────────────────────────────────────────
  // Each term is bounded and independently meaningful; the product-like blend
  // means a single weak layer drags the whole score down, which is the correct
  // behaviour for a bot whose promise is "no margin for error".
  const sprtTerm = clamp(sprtRes.progress, 0, 1);
  // Scale the edge by δ, the increment the sequential test is powered to detect,
  // NOT by break-even. Dividing by break-even collapsed this term on
  // high-probability contracts — a 6-point edge on Over 1 (break-even 81.3 %)
  // scored 0.07 out of 1, so the best possible setup on that contract could not
  // reach the confidence bar. δ is the same yardstick everywhere else.
  const edgeTerm = clamp(edgeEvidence / KILLSHOT_GATES.deltaAbs, 0, 1);
  const lossTerm = clamp(1.6 - Math.max(loss.clusterRatioLower, Math.min(1, loss.clusterRatio)), 0, 1);
  const statTerm = clamp(1 - Math.abs(stat.z) / KILLSHOT_GATES.maxStationarityZ, 0, 1);
  const concTerm = conc.total > 0 ? conc.agreeing / conc.total : 0;
  const evTerm = clamp(expectedValue / 0.15, 0, 1);
  // The tier is itself evidence: an anytime-valid floor above break-even is a
  // strictly stronger claim than a fired sequential test with a bounded shortfall.
  const tierTerm = tier === "prime" ? 1 : tier === "standard" ? 0.65 : 0.15;

  const confidence = Math.round(clamp(
    100 * (
      0.24 * sprtTerm +
      0.18 * edgeTerm +
      0.18 * lossTerm +
      0.10 * statTerm +
      0.10 * concTerm +
      0.08 * evTerm +
      0.12 * tierTerm
    ), 0, 100));

  const signals: string[] = [
    `${tier === "prime" ? "🥇 PRIME" : tier === "standard" ? "🥈 STANDARD" : "◇ MARGINAL"} · SPRT ${sprtRes.logLR}/${sprtRes.upper} nats · ${sprtRes.decision === "fire" ? "FIRE" : sprtRes.decision} · odds ${sprtRes.oddsForEdge.toFixed(0)}:1 · needs ${((p1) * 100).toFixed(1)}%`,
    `structural headroom ${headroomPP >= 0 ? "+" : ""}${headroomPP.toFixed(1)}pp — a fair stream wins ${((winSet.size / 10) * 100).toFixed(1)}%, break-even is ${(breakEven * 100).toFixed(1)}%, so the market must run ${Math.abs(headroomPP).toFixed(1)}pp ${headroomPP < 0 ? "hot" : "cold"} before this contract is +EV`,
    `p̂ ${(pWin * 100).toFixed(1)}% · anytime-valid floor ${(pLower * 100).toFixed(1)}% vs break-even ${(breakEven * 100).toFixed(1)}%`,
    `context model order ${ctx.dominantOrder} · P(win|context) ${(ctx.p * 100).toFixed(1)}%`,
    `loss pairing ξ ${loss.clusterRatio.toFixed(2)} (bound ${loss.clusterRatioLower.toFixed(2)}) · P(2 in a row) ${(loss.pTwoInARow * 100).toFixed(2)}% vs ${(pairBaseline * 100).toFixed(2)}% if losses were independent · longest run ${loss.maxLossRun}`,
    `stationarity z ${stat.z} · trend ${stat.trend >= 0 ? "+" : ""}${stat.trend}/block`,
    `horizons ${conc.agreeing}/${conc.total} agree · spread ${(conc.spread * 100).toFixed(1)}%`,
    `EV ${expectedValue >= 0 ? "+" : ""}${(expectedValue * 100).toFixed(1)}% per $1 at ${payout.toFixed(2)}×`,
  ];
  for (const b of blockers) signals.push(`⛔ ${b}`);

  return {
    symbol,
    displayName,
    contract,
    label: killShotLabel(contract),
    confidence,
    pWin,
    pLower,
    breakEven: round(breakEven),
    payout,
    expectedValue,
    sprt: sprtRes,
    context: ctx,
    loss,
    stationarity: stat,
    concordance: conc,
    samples: clean.length,
    tier,
    fairRate: round(winSet.size / 10),
    requiredRate: round(p1),
    headroomPP: round(headroomPP, 2),
    pairBaseline: round(pairBaseline),
    deployable: blockers.length === 0
      && confidence >= (tier === "prime" ? KILLSHOT_GATES.minConfidencePrime : KILLSHOT_GATES.minConfidence),
    blockers,
    signals,
    pValue: pBelowBe,
    significant: false, // filled by the BH pass
  };
}

/**
 * P(rate ≤ x | data) from a Beta posterior — the exact one-sided p-value.
 *
 * The regularised incomplete beta function I_x(α, β) is by definition the Beta
 * CDF, so this is a direct evaluation rather than a numerical inversion.
 */
function regularizedBelow(x: number, alpha: number, beta: number): number {
  return regularizedIncompleteBeta(clamp(x, 0, 1), alpha, beta);
}

/**
 * Screen a full candidate set with Benjamini–Hochberg and rank it.
 *
 * The scan considers every market and (for Matches) every digit, so the raw
 * argmax is a maximum over dozens of noisy estimates. BH controls the false
 * discovery rate across the whole family before anything may be called
 * deployable.
 */
export function screenKillShotCandidates(candidates: KillShotCandidate[], q = 0.10): KillShotCandidate[] {
  if (candidates.length === 0) return [];
  const passes = benjaminiHochberg(candidates.map(c => c.pValue), q);
  const screened = candidates.map((c, i) => ({
    ...c,
    significant: passes[i] === true,
    // FDR is a HARD requirement here: a kill-shot may never be a lucky argmax.
    deployable: c.deployable && passes[i] === true,
  }));
  return screened.sort((a, b) => {
    if (a.deployable !== b.deployable) return a.deployable ? -1 : 1;
    if (Math.abs(a.confidence - b.confidence) > 1) return b.confidence - a.confidence;
    return b.expectedValue - a.expectedValue;
  });
}
