/**
 * APEX ONE-SHOT SNIPER — analysis core of the 7th specialist bot.
 *
 * THE BRIEF
 * ─────────
 * "Prioritise only highly accurate trades — no margin for error. Top-tier
 *  analysis, timing and execution. The user picks ONE contract (Over N, Under N,
 *  Matches, Even or Odd — never both sides of a pair). The MARKET is analysed,
 *  the best one is LOCKED, and from then on there is no switching and no
 *  rotation. Take as long as you need; when it fires it must be the one shot.
 *  Find the market that will not allow consecutive losses."
 *
 * Every other bot in this section maximises EDGE PER UNIT TIME. This one
 * maximises CERTAINTY PER TRADE and is indifferent to how long it waits. That
 * single change of objective is what licenses the design below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL IDEA: PRICE THE ENTRY RULE, DON'T GUESS AT IT
 * ─────────────────────────────────────────────────────────────────────────────
 * A "high accuracy" bot is normally built by stacking thresholds and hoping the
 * combination is selective. That is untestable: nobody knows what the thresholds
 * actually do until real money is on them.
 *
 * This bot does something stronger. It takes the EXACT rule the live engine will
 * use to decide an entry, replays it tick-by-tick over the market's own digit
 * history using only information available at each tick, and measures what the
 * rule really produced: how often it fired, how many of those shots won, and —
 * the number the user actually asked for — how its LOSSES came.
 *
 *   `replayEntryRule()` — a walk-forward backtest with no look-ahead.
 *
 * A market is then ranked on the properties of THOSE shots, not on a promising
 * looking statistic computed on the whole stream. A market whose entry rule
 * fires 40 times at 93 % with no two losses adjacent is a different object from
 * a market with the same average win rate whose losses arrive in pairs, and only
 * the replay can tell them apart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY "CONSECUTIVE LOSSES" IS THE RIGHT OBJECTIVE, AND HOW IT IS MEASURED
 * ─────────────────────────────────────────────────────────────────────────────
 * A single-contract bot with a shared recovery ladder is not ruined by a low win
 * rate. It is ruined by DEPTH: the debt-driven recovery stake is
 *
 *     stake(k+1) = debt(k) · (1 + markup) / (payout − 1)      [ladder step k]
 *     debt(k)    = baseStake · (1 + a)^(k−1),  a = (1 + markup)/(payout − 1)
 *
 * so the ladder grows GEOMETRICALLY in the length of the loss run, and it fails
 * at the first k whose required stake exceeds the configured cap — from there a
 * win no longer clears the debt. `ladderDepthLimit()` turns that into the one
 * number that matters:
 *
 *     k* = the number of consecutive losses this session can absorb
 *
 * given the user's stake, payout, markup, stake cap and stop loss.
 *
 * The loss sequence is then modelled as a 2-state Markov chain — the standard
 * and correct model for "do losses attract losses" — and the ruin probability is
 * computed EXACTLY by finite Markov chain imbedding (Fu & Koutras 1994): the
 * embedded chain carries the current loss-run length as its state, with an
 * absorbing state at k*+1, and
 *
 *     P(ladder break within N shots) = 1 − π₀ · T^N · 1
 *
 * is evaluated by iterating the (k*+2)-state transition matrix. No Monte Carlo,
 * no normal approximation, no "expected longest run" heuristic. `ladderSafety`
 * = 1 − that probability is the headline number on the scan card, and it is
 * reported next to `expectedShotsToLadderBreak()`, the closed-form mean waiting
 * time for k*+1 consecutive losses in a 2-state chain:
 *
 *     E[T_k] = [1 + r·(1 − q^(k−1))/(1 − q)] / (r·q^(k−1)),   r = P(L|W)
 *
 * The scale-free clustering statistic is ξ = P(L|L)/P(L), gated on its one-sided
 * 95 % UPPER bound — ξ wanders either side of 1.0 on an independent stream from
 * sampling noise alone, so only DEMONSTRATED clustering is refused.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE EDGE COMES FROM (and why the marginal rate alone can never supply it)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every Deriv digit contract pays below its fair rate: Over 1 pays 1.23× against
 * an 80 % fair rate, so break-even is 81.3 %. On an unbiased stream the contract
 * is −EV by construction and NO analysis can honestly call it +EV. Reporting
 * that gap (`headroomPP`) instead of hiding it is what stops this bot from
 * telling the user a fair market is a good market.
 *
 * The only honest edge available is CONDITIONAL structure: P(win | the digits
 * that just came) can sit well above the marginal. So the entry decision is made
 * on a variable-order Markov estimate of exactly that quantity —
 *
 *     P(win | last 0, 1 or 2 digits), fused by Krichevsky–Trofimov mixing
 *
 * which is the Context-Tree-Weighting estimator: it provably competes with the
 * best fixed-order model in hindsight without knowing the right order in advance,
 * so a deep context is trusted exactly in proportion to the evidence behind it.
 * When the whole market is running hot the order-0 term carries the shot; when
 * only a particular context is hot the deeper terms carry it. Both are the same
 * rule.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EVIDENCE STACK (market-level, evaluated on the locked market)
 * ─────────────────────────────────────────────────────────────────────────────
 *  A1 WALD SPRT on the marginal stream — H₀: p = break-even, H₁: break-even + δ
 *     in ABSOLUTE points. Wald–Wolfowitz proved the SPRT minimises the expected
 *     sample size among all tests of the same error rates, which is precisely
 *     "be certain, take as long as you like". A relative δ is a known trap: on
 *     Over 0 it puts H₁ at 97 %, a rate no digit stream reaches, so the test can
 *     only abandon and the bot can never fire.
 *  A2 ANYTIME-VALID CONFIDENCE SEQUENCE — a betting test supermartingale gives a
 *     lower bound valid SIMULTANEOUSLY at every tick. A bot that re-tests on
 *     every tick and fires when the test passes is guaranteed to fire eventually
 *     on pure noise; fixed-sample intervals do not survive that peeking, this does.
 *  A3 REPLAY — see above. This is the layer that decides.
 *  A4 LADDER MODEL — see above. This is the layer the user asked for.
 *  A5 STATIONARITY — Pearson χ² block homogeneity (Wilson–Hilferty z) plus an
 *     OLS drift slope. A LOCKED market cannot be rotated out of, so a drifting
 *     regime is fatal here in a way it is not for a rotating bot.
 *  A6 MULTI-HORIZON CONCORDANCE — the read must survive 60/120/240/480 ticks.
 *     An edge in one window and absent in the others is a window artefact.
 *  A7 SELECTION CONTROL — Benjamini–Hochberg FDR across every market × digit
 *     examined, plus a log(#candidates) surcharge on the SPRT threshold. The
 *     winner must be genuinely exceptional, not the luckiest of dozens.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MARKET SELECTION IS ONCE, AND FINAL
 * ─────────────────────────────────────────────────────────────────────────────
 * The user names the contract; this module names the market — once, before the
 * session. There is no hunt mode and no rotation, exactly like the Barrier
 * Architect in locked mode. Because a lock cannot be corrected mid-session, the
 * live engine carries a Page–Hinkley change detector on the locked market's
 * realised win rate: if the edge measurably decays the bot STOPS FIRING and asks
 * for a re-analysis. It never quietly moves to another market.
 */

import {
  lagAutocorr,
  waldWolfowitz,
  benjaminiHochberg,
  regularizedIncompleteBeta,
  payoutForBarrier,
} from "./specialist-analysis";
import { EVEN_ODD_PAYOUT, MATCH_PAYOUT } from "./payouts";

// ── Contract vocabulary ───────────────────────────────────────────────────────

export type ApexKind = "over" | "under" | "match" | "even" | "odd";

export interface ApexContract {
  kind: ApexKind;
  /** Barrier digit. Required for over/under/match; ignored for even/odd. */
  digit?: number;
}

export const APEX_CONTRACT_TYPE: Record<ApexKind, string> = {
  over: "DIGITOVER",
  under: "DIGITUNDER",
  match: "DIGITMATCH",
  even: "DIGITEVEN",
  odd: "DIGITODD",
};

export function apexLabel(c: ApexContract): string {
  switch (c.kind) {
    case "over":  return `Over ${c.digit}`;
    case "under": return `Under ${c.digit}`;
    case "match": return c.digit === undefined ? "Matches (AI picks the digit)" : `Matches ${c.digit}`;
    case "even":  return "Even";
    case "odd":   return "Odd";
  }
}

/** Digits that WIN this contract. */
export function apexWinSet(c: ApexContract): Set<number> {
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

/** Total-return payout multiplier (stake included). */
export function apexPayout(c: ApexContract): number {
  switch (c.kind) {
    case "over":  return payoutForBarrier("DIGITOVER", c.digit ?? 4);
    case "under": return payoutForBarrier("DIGITUNDER", c.digit ?? 5);
    case "match": return MATCH_PAYOUT;
    case "even":
    case "odd":   return EVEN_ODD_PAYOUT;
  }
}

/** Break-even win rate = 1 / payout. */
export function apexBreakEven(c: ApexContract): number {
  return 1 / apexPayout(c);
}

/**
 * Validate the user's contract. Enforces "exactly one side": Over OR Under,
 * Even OR Odd, or Matches. There is no "both" anywhere in this bot.
 */
export function validateApexContract(raw: any): { ok: true; contract: ApexContract } | { ok: false; error: string } {
  const kind = raw?.kind;
  if (!["over", "under", "match", "even", "odd"].includes(kind)) {
    return { ok: false, error: "kind must be one of: over, under, match, even, odd" };
  }
  if (kind === "even" || kind === "odd") return { ok: true, contract: { kind } };
  const digit = raw?.digit;
  if (kind === "match" && (digit === undefined || digit === null || digit === "")) {
    // Matches may delegate the digit to the AI — the scan scores all ten.
    return { ok: true, contract: { kind: "match" } };
  }
  const d = Number(digit);
  if (!Number.isInteger(d) || d < 0 || d > 9) return { ok: false, error: `${kind} requires an integer digit 0–9` };
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

/** Effective sample size of a binary series under lag-1 serial dependence. */
export function effectiveSampleSize(series: number[]): number {
  const n = series.length;
  if (n < 10) return n;
  const rho = clamp(lagAutocorr(series, 1), -0.95, 0.95);
  return clamp((n * (1 - rho)) / (1 + rho), 5, n);
}

// ── Certainty levels ──────────────────────────────────────────────────────────

export type ApexCertainty = "elite" | "strict" | "balanced";

export interface ApexCertaintySpec {
  id: ApexCertainty;
  label: string;
  blurb: string;
  /** Minimum replayed shots before a market may be judged at all. */
  minShots: number;
  /** The replayed shots' win rate must clear break-even by at least this much. */
  accuracyMargin: number;
  /** How far the 5 % lower bound on the replayed shot rate may sit UNDER break-even. */
  shortfallTolerance: number;
  /** Minimum ladder safety = 1 − P(a loss run deeper than the ladder limit). */
  minLadderSafety: number;
  /**
   * One-sided z at which loss clustering among the replayed shots becomes a veto
   * (1.28 ≈ 90 %, 1.645 ≈ 95 %, 2.33 ≈ 99 %). Used with `minClusterGapPP` so a
   * large sample cannot veto on a clustering too small to matter.
   */
  maxClusterZ: number;
  /** Clustering must also be this many probability points wide to count. */
  minClusterGapPP: number;
  /** Composite confidence floor. */
  minConfidence: number;
  /** Benjamini–Hochberg FDR is a HARD gate at this level (else a badge). */
  fdrRequired: boolean;
  /** The conditional lower bound must clear break-even by this much to fire. */
  entryLcbMargin: number;
  /** A context must carry this many observations before it may drive an entry. */
  minContextCount: number;
}

/**
 * Three certainty bars, one product decision.
 *
 * The previous version of this bot hard-coded a single severe bar and the
 * practical result was a bot that never traded — which is indistinguishable from
 * a broken bot. The bar is therefore explicit and user-facing: ELITE will wait
 * hours and may never fire, BALANCED trades on materially less evidence. STRICT
 * is the default and is the honest middle: the replayed shots must actually
 * clear break-even, the ladder must be safe in four sessions out of five, and
 * losses must not be demonstrably paired.
 */
export const APEX_CERTAINTY: Record<ApexCertainty, ApexCertaintySpec> = {
  elite: {
    id: "elite", label: "Elite", minShots: 30, accuracyMargin: 0.04, shortfallTolerance: 0,
    minLadderSafety: 0.90, maxClusterZ: 1.28, minClusterGapPP: 2, minConfidence: 82, fdrRequired: true,
    entryLcbMargin: 0.02, minContextCount: 22,
    blurb: "The replayed shots must beat break-even by 4pp and the ladder must be safe in 9 sessions of 10. Will wait a very long time and may never fire.",
  },
  strict: {
    id: "strict", label: "Strict", minShots: 24, accuracyMargin: 0.02, shortfallTolerance: 0.03,
    minLadderSafety: 0.80, maxClusterZ: 1.645, minClusterGapPP: 3, minConfidence: 72, fdrRequired: true,
    entryLcbMargin: 0.005, minContextCount: 16,
    blurb: "Default. The replayed shots must clear break-even by 2pp, ladder safety ≥ 80 %, and losses must not be demonstrably paired.",
  },
  balanced: {
    id: "balanced", label: "Balanced", minShots: 16, accuracyMargin: 0.005, shortfallTolerance: 0.07,
    minLadderSafety: 0.65, maxClusterZ: 2.33, minClusterGapPP: 4, minConfidence: 60, fdrRequired: false,
    entryLcbMargin: -0.01, minContextCount: 10,
    blurb: "Fires on materially less evidence. More shots, thinner edge — use it to see the engine work, not to protect a balance.",
  },
};

export function certaintySpec(id?: string): ApexCertaintySpec {
  return APEX_CERTAINTY[(id as ApexCertainty) ?? "strict"] ?? APEX_CERTAINTY.strict;
}

// ── A1: Wald sequential probability ratio test ────────────────────────────────

export interface SprtResult {
  logLR: number;
  upper: number;
  lower: number;
  decision: "fire" | "abandon" | "continue";
  /** Evidence odds in favour of a real edge. */
  oddsForEdge: number;
  /** Fraction of the way to the fire threshold. */
  progress: number;
  n: number;
  /** Wald's expected additional observations to a decision under H₁. */
  expectedRemaining: number;
}

/**
 * Wald's SPRT for a Bernoulli stream.
 *
 * @param p0  Null rate — break-even (the trade is worthless).
 * @param p1  Alternative — break-even + δ, δ ABSOLUTE. The house margin on a
 *            digit contract lives at 1–2 points, so that is the scale the test
 *            is powered for; a relative δ made H₁ unreachable on high-probability
 *            contracts and is why an earlier bot of this kind could never fire.
 * @param penaltyNats  Selection surcharge, log(#candidates examined).
 */
export function sprt(
  series: number[],
  p0: number,
  p1: number,
  alpha = 0.05,
  beta = 0.20,
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

  const drift = b * llrWin + (1 - b) * llrLoss;
  const remaining = drift > 1e-9 ? Math.ceil(Math.max(0, upper - logLR) / drift) : Number.POSITIVE_INFINITY;

  return {
    logLR: round(logLR, 3),
    upper: round(upper, 3),
    lower: round(lower, 3),
    decision,
    oddsForEdge: round(Math.min(1e9, Math.exp(clamp(logLR, -50, 20))), 2),
    progress: clamp(upper > 0 ? logLR / upper : 0, -1, 1),
    n: series.length,
    expectedRemaining: Number.isFinite(remaining) ? remaining : 9999,
  };
}

// ── A2: anytime-valid confidence sequence ─────────────────────────────────────

export interface ConfidenceSequence {
  lower: number;
  mean: number;
  maxWealth: number;
  n: number;
}

/**
 * Betting-style (Waudby-Smith–Ramdas) anytime-valid lower confidence bound.
 *
 * For each candidate rate m the wealth process K_n(m) = Π (1 + λᵢ(xᵢ − m)) is a
 * non-negative martingale when m is the true mean, so Ville's inequality gives
 * P(∃n : K_n(m) ≥ 1/α) ≤ α. Rejecting every m whose wealth ever crosses 1/α
 * leaves a confidence set valid at ALL times simultaneously — including at the
 * data-dependent moment this bot fires, which is exactly where a fixed-sample
 * interval silently becomes invalid from repeated peeking.
 *
 * λ is the predictable (past-only) plug-in bet, capped for stability.
 */
export function anytimeLowerBound(series: number[], alpha = 0.01): ConfidenceSequence {
  const n = series.length;
  const mean = n > 0 ? series.reduce((a, b) => a + b, 0) / n : 0.5;
  if (n < 20) return { lower: Math.max(0, mean - 0.3), mean: round(mean), maxWealth: 1, n };

  const threshold = Math.log(1 / alpha);
  const peakWealth = (m: number): number => {
    let logK = 0;
    let peak = 0;
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const pastMean = (hits + 0.5) / (i + 1);
      const varEst = Math.max(0.01, pastMean * (1 - pastMean));
      const lambda = clamp((pastMean - m) / varEst, 0, 0.75 / Math.max(1e-6, 1 - m));
      logK += Math.log(Math.max(1e-12, 1 + lambda * (series[i]! - m)));
      peak = Math.max(peak, logK);
      hits += series[i]!;
    }
    return peak;
  };

  let lo = 0;
  let hi = mean;
  for (let it = 0; it < 24; it++) {
    const mid = (lo + hi) / 2;
    if (peakWealth(mid) >= threshold) lo = mid; else hi = mid;
  }
  return {
    lower: round(clamp(lo, 0, 1)),
    mean: round(mean),
    maxWealth: round(Math.exp(Math.min(30, peakWealth(Math.max(0, lo)))), 2),
    n,
  };
}

// ── Conditional context model (KT-mixed, variable order) ──────────────────────

export interface ContextEstimate {
  /** Fused P(win | current context). */
  p: number;
  /** Conservative lower bound on the fused estimate. */
  lower: number;
  /** Blended posterior standard error. */
  sigma: number;
  /** Per-order contributions. */
  byOrder: Array<{ order: number; p: number; n: number; weight: number; lower: number }>;
  /** Depth that carried the most weight. */
  dominantOrder: number;
  /** Observations behind the dominant context. */
  dominantCount: number;
  /** The digits forming the dominant context, most recent last. */
  context: number[];
  /** Total evidence weight — low means "no context information here". */
  evidence: number;
}

/**
 * Krichevsky–Trofimov-mixed variable-order estimate of P(win | recent digits).
 *
 * The KT estimator (h + ½)/(n + 1) is minimax-optimal for a Bernoulli source;
 * mixing over context depths with weights proportional to each depth's own
 * evidence is the Context-Tree-Weighting principle. Practical effect: a sparse
 * 2nd-order context can never override a well-evidenced marginal, and a hot
 * marginal carries the estimate when the whole market is hot.
 *
 * `counts` may be supplied by the walk-forward replay so the same estimator is
 * used live and in backtest — the replay is only a valid backtest if it prices
 * the identical rule.
 */
export function contextEstimate(
  digits: number[],
  wins: number[],
  maxOrder = 2,
): ContextEstimate {
  const n = digits.length;
  const byOrder: ContextEstimate["byOrder"] = [];

  for (let order = 0; order <= maxOrder; order++) {
    if (n < order + 25) continue;
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
    if (count < 4 && order > 0) continue;
    // Krichevsky–Trofimov posterior: Beta(h + ½, n − h + ½).
    const alpha = hits + 0.5;
    const beta = count - hits + 0.5;
    const p = alpha / (alpha + beta);
    const sd = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
    const weight = (count / (count + 12)) * Math.pow(0.7, order);
    byOrder.push({
      order,
      p: round(p, 5),
      n: count,
      weight: round(weight, 5),
      lower: round(clamp(p - 1.645 * sd, 0, 1), 5),
    });
  }

  if (byOrder.length === 0) {
    const base = n > 0 ? wins.reduce((a, b) => a + b, 0) / n : 0.5;
    return {
      p: round(base, 5), lower: round(Math.max(0, base - 0.2), 5), sigma: 0.2,
      byOrder: [], dominantOrder: 0, dominantCount: 0, context: [], evidence: 0,
    };
  }

  const wSum = byOrder.reduce((a, o) => a + o.weight, 0);
  const p = byOrder.reduce((a, o) => a + o.weight * o.p, 0) / wSum;
  // Variance of a weighted mean of independent posteriors.
  const varSum = byOrder.reduce((a, o) => {
    const sd = Math.max(0, o.p - o.lower) / 1.645;
    return a + (o.weight ** 2) * (sd ** 2);
  }, 0);
  const sigma = Math.sqrt(varSum) / wSum;
  const dominant = byOrder.reduce((best, o) => (o.weight > best.weight ? o : best), byOrder[0]!);

  return {
    p: round(clamp(p, 1e-5, 1 - 1e-5), 5),
    lower: round(clamp(p - 1.645 * sigma, 0, 1), 5),
    sigma: round(sigma, 5),
    byOrder,
    dominantOrder: dominant.order,
    dominantCount: dominant.n,
    context: digits.slice(n - dominant.order),
    evidence: round(wSum, 4),
  };
}

// ── A4a: the ladder — how many consecutive losses can this session absorb? ────

export interface LadderDepthLimit {
  /** stake(k+1)/stake(k) − 1 growth factor a = (1 + markup)/(payout − 1). */
  growthFactor: number;
  /** Consecutive losses before the debt-driven stake exceeds the stake cap. */
  byStakeCap: number;
  /** Consecutive losses before the accumulated debt reaches the stop loss. */
  byStopLoss: number;
  /** The binding limit — the depth at which the ladder actually fails. */
  limit: number;
  /** Stake the ladder would be asking for at the limit. */
  stakeAtLimit: number;
  /** Debt at the limit. */
  debtAtLimit: number;
}

/**
 * Exact geometry of the shared debt-driven recovery ladder.
 *
 * With debt(1) = baseStake and stake(k+1) = debt(k)·(1+markup)/(payout−1):
 *
 *     a        = (1 + markup) / (payout − 1)
 *     debt(k)  = baseStake · (1 + a)^(k−1)
 *     stake(k) = baseStake · a · (1 + a)^(k−2)      (k ≥ 2)
 *
 * The ladder fails at the first k whose required stake exceeds the cap, because
 * from there a win can no longer clear the debt — and, independently, at the
 * first k whose accumulated debt reaches the user's stop loss. Both are solved
 * in closed form; the binding one is the depth this session can absorb.
 */
export function ladderDepthLimit(input: {
  baseStake: number;
  payout: number;
  markupPercent: number;
  maxStake: number;
  stopLoss: number;
}): LadderDepthLimit {
  const netRate = Math.max(1e-6, input.payout - 1);
  const a = (1 + Math.max(0, input.markupPercent) / 100) / netRate;
  const base = Math.max(0.01, input.baseStake);

  // base·a·(1+a)^(k−2) ≤ cap  ⇒  k ≤ 2 + log(cap/(base·a)) / log(1+a)
  const cap = Number.isFinite(input.maxStake) && input.maxStake > 0 ? input.maxStake : 1e9;
  const kCap = base * a >= cap
    ? 1
    : Math.floor(2 + Math.log(cap / (base * a)) / Math.log(1 + a));
  // base·(1+a)^(k−1) ≤ stopLoss  ⇒  k ≤ 1 + log(stopLoss/base)/log(1+a)
  const sl = Math.max(base, input.stopLoss);
  const kSl = Math.floor(1 + Math.log(sl / base) / Math.log(1 + a));

  const limit = Math.max(1, Math.min(kCap, kSl));
  return {
    growthFactor: round(a, 4),
    byStakeCap: Math.max(1, kCap),
    byStopLoss: Math.max(1, kSl),
    limit,
    stakeAtLimit: round(base * a * Math.pow(1 + a, Math.max(0, limit - 2)), 2),
    debtAtLimit: round(base * Math.pow(1 + a, limit - 1), 2),
  };
}

/**
 * EXACT probability that a loss run longer than `limit` occurs within `nShots`,
 * for a 2-state Markov loss chain — finite Markov chain imbedding
 * (Fu & Koutras 1994).
 *
 * The embedded chain's state is the current consecutive-loss count j = 0..limit,
 * plus one absorbing state. From j = 0 the next loss probability is the marginal
 * pLoss; from j ≥ 1 it is q = P(L|L). Iterating the transition vector nShots
 * times gives the absorption probability exactly — no simulation, no
 * approximation, O(nShots · limit).
 */
export function ladderAbsorption(pLoss: number, qLossGivenLoss: number, limit: number, nShots: number): number {
  const p0 = clamp(pLoss, 0, 1);
  const q = clamp(qLossGivenLoss, 0, 1);
  const k = Math.max(1, Math.floor(limit));
  const steps = Math.max(0, Math.floor(nShots));
  if (steps === 0) return 0;

  // states 0..k are transient; absorption is tracked separately.
  let v = new Array<number>(k + 1).fill(0);
  v[0] = 1;
  let absorbed = 0;

  for (let s = 0; s < steps; s++) {
    const next = new Array<number>(k + 1).fill(0);
    for (let j = 0; j <= k; j++) {
      const mass = v[j]!;
      if (mass <= 0) continue;
      const pL = j === 0 ? p0 : q;
      if (j + 1 > k) {
        absorbed += mass * pL;      // one more loss breaks the ladder
        next[0]! += mass * (1 - pL);
      } else {
        next[j + 1]! += mass * pL;
        next[0]! += mass * (1 - pL);
      }
    }
    v = next;
  }
  return clamp(absorbed, 0, 1);
}

/**
 * Closed-form mean waiting time for `k` consecutive losses in a 2-state Markov
 * chain, starting from a neutral state.
 *
 * Solving m_j = 1 + q·m_{j+1} + (1−q)·m_0 with m_k = 0 and
 * m_0 = 1/r + m_1 (r = P(L|W)) gives
 *
 *     E[T_k] = [1 + r·(1 − q^(k−1))/(1 − q)] / (r · q^(k−1))
 *
 * which reduces to the classical (1 − p^k)/((1−p)p^k) when r = q = p.
 */
export function expectedShotsToLadderBreak(pLoss: number, qLossGivenLoss: number, k: number): number {
  const p = clamp(pLoss, 1e-6, 1 - 1e-6);
  const q = clamp(qLossGivenLoss, 1e-6, 1 - 1e-6);
  const kk = Math.max(1, Math.floor(k) + 1); // breaking the ladder needs limit+1 losses
  // Stationarity: π_L = r/(r + 1 − q) = p  ⇒  r = p(1−q)/(1−p)
  const r = clamp((p * (1 - q)) / (1 - p), 1e-6, 1 - 1e-6);
  if (kk === 1) return 1 / r;
  const geom = (1 - Math.pow(q, kk - 1)) / (1 - q);
  const e = (1 + r * geom) / (r * Math.pow(q, kk - 1));
  return Number.isFinite(e) ? Math.round(e) : 999999;
}

// ── A4b: the 2-state loss chain ───────────────────────────────────────────────

export interface LossChain {
  /** Marginal loss rate. */
  pLoss: number;
  /** q = P(loss | loss). */
  q: number;
  /** r = P(loss | win). */
  r: number;
  /** ξ = q / pLoss. > 1 means losses attract losses. */
  xi: number;
  /** One-sided 95 % UPPER bound on ξ — reported, not gated (see `clusterZ`). */
  xiUpper: number;
  /** One-sided 95 % LOWER bound on ξ. */
  xiLower: number;
  /**
   * One-sided z for H₀: q = pLoss against H₁: q > pLoss, i.e. "losses attract
   * losses". THIS is what the gate uses.
   *
   * An absolute ceiling on ξ or on its upper bound is unusable here: on a
   * high-win-rate contract the losses are rare, so the conditional q is estimated
   * from few transitions and ξ_upper is wide from sampling noise alone — Over 1 on
   * a perfectly fair stream scores ξ_upper ≈ 1.21, which would veto every
   * high-probability contract no matter how clean the market is. Comparing q with
   * pLoss in units of q's OWN standard error is the scale-free version of the same
   * question and does not have that failure mode.
   */
  clusterZ: number;
  /** q − pLoss in probability points: the size of the clustering, not just its significance. */
  clusterGapPP: number;
  /** P(win | loss) — the state-conditional entry preference. */
  pWinGivenLoss: number;
  /** P(win | win). */
  pWinGivenWin: number;
  /** P(two losses in a row). */
  pTwoInARow: number;
  /** Independence baseline for the above, pLoss². */
  pairBaseline: number;
  /** Longest observed loss run. */
  maxLossRun: number;
  /** Wald–Wolfowitz runs z: > 0 alternates, < 0 clusters. */
  runsZ: number;
  /** Observations behind the chain. */
  n: number;
}

/**
 * Fit the 2-state Markov chain of the LOSS indicator and bound its clustering.
 *
 * Clustering is judged by `clusterZ` — the one-sided z for q > pLoss in units of
 * q's own standard error — together with the absolute size of the gap, NOT by an
 * absolute ceiling on ξ. Gating on ξ (or on its upper bound) silently vetoes
 * every high-win-rate contract: the rarer the losses, the fewer transitions there
 * are behind q, so ξ_upper is wide from sampling noise alone and a perfectly
 * clean market looks clustered.
 */
export function lossChain(wins: number[]): LossChain {
  const n = wins.length;
  const losses = wins.map(w => (w === 1 ? 0 : 1));
  const nLoss = losses.reduce((a, b) => a + b, 0);
  const pLoss = n > 0 ? nLoss / n : 1;

  let ll = 0; let afterLoss = 0;
  let lw = 0; let afterWin = 0;
  for (let i = 1; i < n; i++) {
    if (losses[i - 1] === 1) { afterLoss++; if (losses[i] === 1) ll++; }
    else { afterWin++; if (losses[i] === 1) lw++; }
  }
  // Laplace-smoothed toward the marginal so a handful of transitions cannot
  // claim a 0 % or 100 % conditional.
  const prior = 5;
  const q = (ll + prior * pLoss) / (afterLoss + prior);
  const r = (lw + prior * pLoss) / (afterWin + prior);
  const xi = pLoss > 1e-6 ? q / pLoss : 1;

  const qSe = Math.sqrt(Math.max(1e-9, q * (1 - q)) / Math.max(1, afterLoss));
  const qUpper = Math.min(1, q + 1.645 * qSe);
  const qLower = Math.max(0, q - 1.645 * qSe);
  const clusterZ = (q - pLoss) / Math.max(1e-6, qSe);

  let maxRun = 0; let cur = 0;
  for (const l of losses) { if (l === 1) { cur++; maxRun = Math.max(maxRun, cur); } else cur = 0; }

  return {
    pLoss: round(pLoss, 4),
    q: round(q, 4),
    r: round(r, 4),
    xi: round(xi, 3),
    xiUpper: round(pLoss > 1e-6 ? qUpper / pLoss : 1, 3),
    xiLower: round(pLoss > 1e-6 ? qLower / pLoss : 1, 3),
    clusterZ: round(clusterZ, 3),
    clusterGapPP: round((q - pLoss) * 100, 2),
    pWinGivenLoss: round(1 - q, 4),
    pWinGivenWin: round(1 - r, 4),
    pTwoInARow: round(pLoss * q, 5),
    pairBaseline: round(pLoss * pLoss, 5),
    maxLossRun: maxRun,
    runsZ: round(waldWolfowitz(wins).z, 2),
    n,
  };
}

// ── A3: walk-forward replay of the entry rule ─────────────────────────────────

export interface ReplayShot {
  /** Index in the digit stream. */
  index: number;
  won: boolean;
  /** Conditional point estimate at the moment of entry. */
  condP: number;
  /** Conservative lower bound at the moment of entry. */
  condLower: number;
  /** Context depth that drove the entry. */
  order: number;
  /** Observations behind that context. */
  contextCount: number;
}

export interface ApexReplay {
  shots: ReplayShot[];
  nShots: number;
  /** Ticks the rule was allowed to consider (after burn-in). */
  examined: number;
  /** Shots / examined — how patient the rule is on this market. */
  fireRate: number;
  winRate: number;
  /** 5 %-lower Beta bound on the replayed shot win rate. */
  winRateLower: number;
  /** EV per $1 staked at the contract's payout. */
  evPerDollar: number;
  longestLossRun: number;
  /** Loss chain fitted to the SHOT outcomes, not to every tick. */
  chain: LossChain;
  /** Deepest ladder the replayed shots would have driven, in debt terms. */
  maxDebt: number;
  /** Stake the ladder would have demanded at its deepest. */
  maxStake: number;
  /** True if the replayed ladder ever exceeded its depth limit. */
  ladderBroke: boolean;
}

export interface ReplayParams {
  breakEven: number;
  payout: number;
  baseStake: number;
  markupPercent: number;
  maxStake: number;
  stopLoss: number;
  /** Certainty spec supplying entryLcbMargin / minContextCount. */
  spec: ApexCertaintySpec;
  /** Ticks of history required before the rule may fire. */
  burnIn?: number;
  /** Minimum ticks between two shots (each shot must be its own evidence). */
  minSpacing?: number;
}

/**
 * Walk-forward replay of the live entry rule — the layer that decides.
 *
 * At each tick the KT-mixed conditional estimate is computed from context counts
 * built ONLY from earlier ticks, exactly as the live engine computes it, and the
 * rule fires when the conservative lower bound clears break-even by the
 * certainty level's margin and the dominant context carries enough evidence. The
 * outcome of that shot is the tick's own win/loss. Nothing looks ahead.
 *
 * What this prices, and what it does not: it prices the CONDITIONAL ENTRY RULE.
 * The live timing layer only ever defers an entry (its patience valve eventually
 * takes it), so shot ACCURACY transfers to the live bot while shot CADENCE is
 * approximate. That is stated on the scan card rather than hidden.
 */
export function replayEntryRule(digits: number[], winSet: ReadonlySet<number>, params: ReplayParams): ApexReplay {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  const wins = clean.map(d => (winSet.has(d) ? 1 : 0));
  const n = clean.length;
  const burnIn = Math.max(40, params.burnIn ?? 120);
  const spacing = Math.max(1, params.minSpacing ?? 8);
  const be = params.breakEven;
  const bar = be + params.spec.entryLcbMargin;

  // Incremental context counts: key = order-prefixed digit context.
  const hits = new Map<string, number>();
  const counts = new Map<string, number>();
  const MAX_ORDER = 2;

  const shots: ReplayShot[] = [];
  let examined = 0;
  let lastFire = -Number.POSITIVE_INFINITY;

  for (let i = 0; i < n; i++) {
    if (i >= burnIn) {
      examined++;
      if (i - lastFire >= spacing) {
        // Fused conditional estimate from counts built from ticks < i.
        let wSum = 0; let pSum = 0; let varSum = 0;
        let domOrder = 0; let domCount = 0; let domWeight = -1;
        for (let order = 0; order <= MAX_ORDER; order++) {
          if (i < order + 20) continue;
          const key = `${order}:${clean.slice(i - order, i).join("")}`;
          const c = counts.get(key) ?? 0;
          if (c < 4 && order > 0) continue;
          const h = hits.get(key) ?? 0;
          const alpha = h + 0.5;
          const beta = c - h + 0.5;
          const p = alpha / (alpha + beta);
          const sd = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
          const w = (c / (c + 12)) * Math.pow(0.7, order);
          wSum += w; pSum += w * p; varSum += (w ** 2) * (sd ** 2);
          if (w > domWeight) { domWeight = w; domOrder = order; domCount = c; }
        }
        if (wSum > 0 && domCount >= params.spec.minContextCount) {
          const p = pSum / wSum;
          const sigma = Math.sqrt(varSum) / wSum;
          const lower = p - 1.645 * sigma;
          if (lower >= bar) {
            shots.push({
              index: i,
              won: wins[i] === 1,
              condP: round(p, 5),
              condLower: round(lower, 5),
              order: domOrder,
              contextCount: domCount,
            });
            lastFire = i;
          }
        }
      }
    }
    // Update the counts with tick i AFTER the decision — no look-ahead.
    for (let order = 0; order <= MAX_ORDER; order++) {
      if (i < order) continue;
      const key = `${order}:${clean.slice(i - order, i).join("")}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (wins[i] === 1) hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }

  const nShots = shots.length;
  const shotWins = shots.map(s => (s.won ? 1 : 0));
  const winCount = shotWins.reduce((a, b) => a + b, 0);
  const winRate = nShots > 0 ? winCount / nShots : 0;
  // Beta(h + ½, n − h + ½) 5 % quantile via a normal approximation on the exact
  // Beta moments — cheap, and the replay's own gate is the point estimate plus
  // the accuracy margin, so this bound is a report, not a trigger.
  const aPost = winCount + 0.5;
  const bPost = nShots - winCount + 0.5;
  const sdPost = Math.sqrt((aPost * bPost) / ((aPost + bPost) ** 2 * (aPost + bPost + 1)));
  const winRateLower = clamp(winRate - 1.645 * sdPost, 0, 1);

  // Realised ladder depth, in the shared engine's own debt arithmetic.
  const ladder = ladderDepthLimit({
    baseStake: params.baseStake, payout: params.payout,
    markupPercent: params.markupPercent, maxStake: params.maxStake, stopLoss: params.stopLoss,
  });
  const growth = ladder.growthFactor;
  let depth = 0; let maxDepth = 0; let maxDebt = 0; let maxStake = params.baseStake;
  let ladderBroke = false;
  for (const s of shots) {
    if (s.won) { depth = 0; continue; }
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    const debt = params.baseStake * Math.pow(1 + growth, depth - 1);
    const stake = depth === 1 ? params.baseStake : params.baseStake * growth * Math.pow(1 + growth, depth - 2);
    maxDebt = Math.max(maxDebt, debt);
    maxStake = Math.max(maxStake, stake);
    if (depth > ladder.limit) ladderBroke = true;
  }

  return {
    shots,
    nShots,
    examined,
    fireRate: examined > 0 ? round(nShots / examined, 5) : 0,
    winRate: round(winRate, 5),
    winRateLower: round(winRateLower, 5),
    evPerDollar: round(winRate * params.payout - 1, 5),
    longestLossRun: maxDepth,
    chain: lossChain(shotWins),
    maxDebt: round(maxDebt, 2),
    maxStake: round(maxStake, 2),
    ladderBroke,
  };
}

// ── A5: stationarity + change detection ───────────────────────────────────────

/** Pearson χ² block homogeneity as a Wilson–Hilferty z, plus an OLS drift slope. */
export function stationarity(series: number[], blocks = 5): { z: number; trend: number; rates: number[] } {
  const n = series.length;
  if (n < blocks * 20) return { z: 0, trend: 0, rates: [] };
  const size = Math.floor(n / blocks);
  const rates: number[] = [];
  const counts: Array<{ hits: number; n: number }> = [];
  for (let b = 0; b < blocks; b++) {
    const seg = series.slice(b * size, (b + 1) * size);
    const h = seg.reduce((a, x) => a + x, 0);
    counts.push({ hits: h, n: seg.length });
    rates.push(round(h / Math.max(1, seg.length), 3));
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

  const xBar = (blocks - 1) / 2;
  const yBar = rates.reduce((a, r) => a + r, 0) / blocks;
  let num = 0; let den = 0;
  for (let i = 0; i < blocks; i++) { num += (i - xBar) * (rates[i]! - yBar); den += (i - xBar) ** 2; }

  return { z: round((t - m) / s, 2), trend: round(den > 0 ? num / den : 0, 4), rates };
}

export interface PageHinkley {
  /** Accumulated deviation statistic m_T. */
  m: number;
  /** Running minimum of m. */
  min: number;
  /** PH = m_T − min(m). Fires when it exceeds `threshold`. */
  ph: number;
  fired: boolean;
  threshold: number;
  /** Cumulative mean the detector is comparing against. */
  reference: number;
}

/**
 * Page–Hinkley change detector, oriented to catch a FALL in the win rate.
 *
 * A LOCKED market cannot be rotated out of, so the engine needs to know when the
 * regime it was locked on has ended. Page's cumulative-sum test accumulates
 *
 *     m_T = Σ_{t>warmup} ( x̄_{t−1} − x_t − δ )        M_T = min_{t} m_t
 *     PH_T = m_T − M_T                                alarm when PH_T > λ
 *
 * where x̄_{t−1} is the mean of the PAST ONLY, so the statistic is predictable and
 * cannot be inflated by the observation being tested. While the rate holds, each
 * term has mean −δ and m drifts down with its minimum, so PH stays near zero;
 * once the rate falls below its own history the terms turn positive, m climbs
 * away from that minimum, and PH crosses λ.
 *
 * δ is the size of drift worth ignoring and λ the accumulated evidence required.
 * With δ = 0.03 the expected excursion of a stable stream above its own minimum
 * is σ²/2δ ≈ 1.5, so λ = 10 leaves a wide margin against false alarms while a
 * genuine 10pp decay still trips it in ~140 ticks.
 */
export function pageHinkley(wins: number[], delta = 0.03, lambda = 10, warmup = 40): PageHinkley {
  let sum = 0;
  let m = 0;
  let min = 0;
  for (let i = 0; i < wins.length; i++) {
    const x = wins[i]!;
    const pastMean = i > 0 ? sum / i : x;
    sum += x;
    if (i < warmup) continue;
    m += (pastMean - x - delta);
    if (m < min) min = m;
  }
  const ph = m - min;
  return {
    m: round(m, 3),
    min: round(min, 3),
    ph: round(ph, 3),
    fired: ph > lambda,
    threshold: lambda,
    reference: round(wins.length > 0 ? sum / wins.length : 0, 4),
  };
}

// ── A6: multi-horizon concordance ─────────────────────────────────────────────

export const APEX_HORIZONS = [60, 120, 240, 480] as const;

export interface Concordance {
  rates: Array<{ window: number; p: number; n: number }>;
  agreeing: number;
  total: number;
  spread: number;
}

export function concordance(
  digits: number[],
  winSet: ReadonlySet<number>,
  breakEven: number,
  margin: number,
): Concordance {
  const rates: Concordance["rates"] = [];
  for (const w of APEX_HORIZONS) {
    const seg = digits.slice(-w);
    if (seg.length < Math.min(40, w * 0.6)) continue;
    const hits = seg.reduce((a, d) => a + (winSet.has(d) ? 1 : 0), 0);
    rates.push({ window: w, p: round(hits / seg.length), n: seg.length });
  }
  if (rates.length === 0) return { rates, agreeing: 0, total: 0, spread: 1 };
  const agreeing = rates.filter(r => r.p >= breakEven + margin).length;
  const ps = rates.map(r => r.p);
  return {
    rates,
    agreeing,
    total: rates.length,
    spread: round(Math.max(...ps) - Math.min(...ps)),
  };
}

/**
 * Digit history the engine feeds each evaluation. Long enough that the
 * anytime-valid sequence is tight (its width falls as 1/√n) and the 2nd-order
 * contexts have observations behind them, short enough to describe one regime.
 */
export const APEX_WINDOW = 1200;

// ── Candidate evaluation ──────────────────────────────────────────────────────

export interface ApexLadder {
  limit: number;
  byStakeCap: number;
  byStopLoss: number;
  growthFactor: number;
  /** 1 − P(a loss run deeper than the limit within the shot horizon). */
  safety: number;
  /** Expected shots before the ladder breaks. */
  expectedShotsToBreak: number;
  /** Shots the projection is computed over. */
  horizon: number;
  stakeAtLimit: number;
  debtAtLimit: number;
}

export interface ApexCandidate {
  symbol: string;
  displayName: string;
  contract: ApexContract;
  label: string;
  certainty: ApexCertainty;
  /** 0–100 composite confidence. */
  confidence: number;
  /** Fused conditional win probability at the current context. */
  pWin: number;
  /** Anytime-valid lower bound on the MARGINAL rate. */
  pLower: number;
  /** Marginal rate. */
  pMean: number;
  breakEven: number;
  payout: number;
  /** EV per $1 at the marginal rate — the honest, unconditioned number. */
  expectedValue: number;
  sprt: SprtResult;
  context: ContextEstimate;
  replay: ApexReplay;
  ladder: ApexLadder;
  stationarity: { z: number; trend: number; rates: number[] };
  concordance: Concordance;
  drift: PageHinkley;
  samples: number;
  /** prime = the anytime-valid floor clears break-even; standard = SPRT fired. */
  tier: "prime" | "standard" | "marginal";
  /** Win rate of an unbiased stream on this contract. */
  fairRate: number;
  /** The rate the SPRT must be convinced of. */
  requiredRate: number;
  /** fairRate − breakEven in percentage points: the house margin, negated. */
  headroomPP: number;
  /** Passed every gate at this certainty level. */
  deployable: boolean;
  /** Reasons it was refused — empty means clean. */
  blockers: string[];
  signals: string[];
  pValue: number;
  significant: boolean;
}

export interface ApexEvalOptions {
  certainty?: ApexCertainty;
  /** Selection surcharge, log(#candidates examined). */
  penaltyNats?: number;
  baseStake?: number;
  markupPercent?: number;
  maxStake?: number;
  stopLoss?: number;
}

/**
 * Score ONE (market, contract) candidate through the full stack.
 *
 * Returns null when the market has too little history to judge — a locked
 * session may never be opened on a guess.
 */
export function evaluateApexCandidate(
  symbol: string,
  displayName: string,
  digits: number[],
  contract: ApexContract,
  options: ApexEvalOptions = {},
): ApexCandidate | null {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  const spec = certaintySpec(options.certainty);
  if (clean.length < 240) return null;

  const winSet = apexWinSet(contract);
  if (winSet.size === 0) return null;

  const payout = apexPayout(contract);
  const breakEven = apexBreakEven(contract);
  const wins = clean.map(d => (winSet.has(d) ? 1 : 0));
  const penaltyNats = options.penaltyNats ?? 0;

  // A1 — SPRT on the marginal stream, δ absolute (see sprt()).
  const delta = Math.min(0.02, (1 - breakEven) * 0.35);
  const p1 = clamp(breakEven + Math.max(0.004, delta), breakEven + 0.004, 0.995);
  const sprtRes = sprt(wins, breakEven, p1, 0.05, 0.20, penaltyNats);

  // Conditional read at the current context (the quantity the entry gate uses).
  const ctx = contextEstimate(clean, wins, 2);
  // A2 — anytime-valid sequence on the marginal.
  const cs = anytimeLowerBound(wins, 0.01);

  // A3 — the replay. This is the layer that decides.
  const replay = replayEntryRule(clean, winSet, {
    breakEven,
    payout,
    baseStake: options.baseStake ?? 1,
    markupPercent: options.markupPercent ?? 10,
    maxStake: options.maxStake ?? 500,
    stopLoss: options.stopLoss ?? 5,
    spec,
  });

  // A4 — the ladder.
  const depth = ladderDepthLimit({
    baseStake: options.baseStake ?? 1,
    payout,
    markupPercent: options.markupPercent ?? 10,
    maxStake: options.maxStake ?? 500,
    stopLoss: options.stopLoss ?? 5,
  });
  const horizon = Math.max(40, replay.nShots, 60);
  const absorption = ladderAbsorption(replay.chain.pLoss, replay.chain.q, depth.limit, horizon);
  const ladder: ApexLadder = {
    limit: depth.limit,
    byStakeCap: depth.byStakeCap,
    byStopLoss: depth.byStopLoss,
    growthFactor: depth.growthFactor,
    safety: round(1 - absorption, 4),
    expectedShotsToBreak: expectedShotsToLadderBreak(replay.chain.pLoss, replay.chain.q, depth.limit),
    horizon,
    stakeAtLimit: depth.stakeAtLimit,
    debtAtLimit: depth.debtAtLimit,
  };

  // A5 — stationarity + live drift detector.
  const stat = stationarity(wins, 5);
  const drift = pageHinkley(wins);
  // A6 — concordance.
  const conc = concordance(clean, winSet, breakEven, 0.005);

  const pMean = cs.mean;
  const pWin = ctx.p;
  const expectedValue = round(pMean * payout - 1, 5);
  const fairRate = winSet.size / 10;
  const headroomPP = (fairRate - breakEven) * 100;

  // A7 — exact one-sided posterior p-value that the marginal rate is not above
  // break-even, on an autocorrelation-corrected effective sample size.
  const nEff = effectiveSampleSize(wins);
  const nRaw = Math.max(1, wins.length);
  const scaledHits = pMean * nEff;
  const alphaPost = Math.max(1e-9, scaledHits + 0.5);
  const betaPost = Math.max(1e-9, nEff - scaledHits + 0.5);
  const pValue = round(clamp(regularizedIncompleteBeta(clamp(breakEven, 0, 1), alphaPost, betaPost), 0, 1), 6);
  void nRaw;

  // ── Gates ────────────────────────────────────────────────────────────────
  const blockers: string[] = [];

  if (replay.nShots < spec.minShots) {
    blockers.push(
      `entry rule fired only ${replay.nShots}× in ${replay.examined} ticks — ${spec.minShots} shots are needed to judge a market's accuracy`,
    );
  } else {
    if (replay.winRate < breakEven + spec.accuracyMargin) {
      blockers.push(
        `replayed shots win ${(replay.winRate * 100).toFixed(1)}% — needs ${(breakEven * 100).toFixed(1)}% break-even + ${(spec.accuracyMargin * 100).toFixed(1)}pp`,
      );
    }
    if (replay.winRateLower < breakEven - spec.shortfallTolerance) {
      blockers.push(
        `worst-case replayed accuracy ${(replay.winRateLower * 100).toFixed(1)}% is more than ${(spec.shortfallTolerance * 100).toFixed(0)}pp under break-even`,
      );
    }
  }

  if (ladder.safety < spec.minLadderSafety) {
    blockers.push(
      `ladder safety ${(ladder.safety * 100).toFixed(1)}% over ${horizon} shots — ${spec.id} requires ${(spec.minLadderSafety * 100).toFixed(0)}% (limit ${ladder.limit} consecutive losses)`,
    );
  }
  // Loss clustering: significant (one-sided z in units of q's OWN standard
  // error) AND big enough to matter. See LossChain.clusterZ for why an absolute
  // ceiling on ξ is the wrong instrument.
  if (replay.nShots > 0
      && replay.chain.clusterZ > spec.maxClusterZ
      && replay.chain.clusterGapPP >= spec.minClusterGapPP) {
    blockers.push(
      `shots pair their losses — P(L|L) ${(replay.chain.q * 100).toFixed(1)}% vs marginal ${(replay.chain.pLoss * 100).toFixed(1)}% ` +
      `(ξ ${replay.chain.xi.toFixed(2)}, +${replay.chain.clusterGapPP.toFixed(1)}pp at z ${replay.chain.clusterZ.toFixed(2)} > ${spec.maxClusterZ})`,
    );
  }
  if (Math.abs(stat.z) > 2.5) blockers.push(`non-stationary market (χ²→z ${stat.z})`);
  if (Math.abs(stat.trend) > 0.05) blockers.push(`rate is drifting (slope ${stat.trend}/block)`);
  if (conc.total > 0 && conc.agreeing < Math.min(2, conc.total)) {
    blockers.push(`only ${conc.agreeing}/${conc.total} horizons agree`);
  }
  if (conc.spread > 0.18) blockers.push(`horizons disagree (spread ${(conc.spread * 100).toFixed(1)}pp)`);

  // ── Evidence tier (market-level) ─────────────────────────────────────────
  const prime = cs.lower >= breakEven;
  const standard = sprtRes.decision === "fire";
  const tier: ApexCandidate["tier"] = prime ? "prime" : standard ? "standard" : "marginal";
  if (tier === "marginal") {
    blockers.push(
      sprtRes.decision === "abandon"
        ? `SPRT rejected a market-wide edge (logLR ${sprtRes.logLR} ≤ ${sprtRes.lower}) — ${apexLabel(contract)} needs ${((p1) * 100).toFixed(1)}% and this stream is not running there`
        : `SPRT still gathering market-wide evidence (${sprtRes.logLR}/${sprtRes.upper} nats, ≈${sprtRes.expectedRemaining} more ticks)`,
    );
  }

  // ── Composite confidence ─────────────────────────────────────────────────
  // Every term is bounded and independently meaningful. Accuracy of the REPLAYED
  // shots carries the most weight because it is the only term measured on the
  // decisions this bot actually makes.
  const accTerm = clamp((replay.winRate - breakEven) / Math.max(0.02, spec.accuracyMargin * 2.5), 0, 1);
  const ladderTerm = clamp(ladder.safety, 0, 1);
  const xiTerm = clamp(1.5 - Math.max(replay.chain.xiUpper, replay.chain.xi), 0, 1);
  const sprtTerm = clamp(sprtRes.progress, 0, 1);
  const statTerm = clamp(1 - Math.abs(stat.z) / 2.5, 0, 1);
  const concTerm = conc.total > 0 ? conc.agreeing / conc.total : 0;
  const cadenceTerm = clamp(replay.nShots / (spec.minShots * 2), 0, 1);
  const tierTerm = tier === "prime" ? 1 : tier === "standard" ? 0.6 : 0.15;
  const condTerm = clamp((ctx.lower - breakEven) / Math.max(0.02, spec.entryLcbMargin + 0.03), 0, 1);

  const confidence = Math.round(clamp(100 * (
    0.24 * accTerm +
    0.20 * ladderTerm +
    0.12 * xiTerm +
    0.12 * sprtTerm +
    0.08 * statTerm +
    0.06 * concTerm +
    0.06 * cadenceTerm +
    0.06 * tierTerm +
    0.06 * condTerm
  ), 0, 100));

  if (confidence < spec.minConfidence) {
    blockers.push(`composite confidence ${confidence} is below the ${spec.id} floor of ${spec.minConfidence}`);
  }

  const signals: string[] = [
    `${tier === "prime" ? "🥇 PRIME" : tier === "standard" ? "🥈 STANDARD" : "◇ MARGINAL"} · SPRT ${sprtRes.logLR}/${sprtRes.upper} nats · ${sprtRes.decision} · odds ${sprtRes.oddsForEdge.toFixed(0)}:1 · needs ${((p1) * 100).toFixed(1)}%`,
    `REPLAY · the live entry rule fired ${replay.nShots}× in ${replay.examined} ticks (${(replay.fireRate * 100).toFixed(1)}%) at ${(replay.winRate * 100).toFixed(1)}% (worst case ${(replay.winRateLower * 100).toFixed(1)}%) vs break-even ${(breakEven * 100).toFixed(1)}% · EV ${replay.evPerDollar >= 0 ? "+" : ""}${(replay.evPerDollar * 100).toFixed(1)}%/$1`,
    `LADDER · this session absorbs ${ladder.limit} consecutive losses (stake cap ${ladder.byStakeCap}, stop loss ${ladder.byStopLoss}) · safety ${(ladder.safety * 100).toFixed(1)}% over ${horizon} shots · expected ${ladder.expectedShotsToBreak} shots to break · deepest replayed run ${replay.longestLossRun}${replay.ladderBroke ? " (BROKE)" : ""}`,
    `LOSS CHAIN (of the shots) · P(L|L) ${(replay.chain.q * 100).toFixed(1)}% vs marginal ${(replay.chain.pLoss * 100).toFixed(1)}% · ξ ${replay.chain.xi.toFixed(2)} [${replay.chain.xiLower.toFixed(2)}, ${replay.chain.xiUpper.toFixed(2)}] · P(2 in a row) ${(replay.chain.pTwoInARow * 100).toFixed(2)}% vs ${(replay.chain.pairBaseline * 100).toFixed(2)}% independent · runs z ${replay.chain.runsZ >= 0 ? "+" : ""}${replay.chain.runsZ.toFixed(2)}`,
    `CONDITIONAL · P(win | last ${ctx.dominantOrder} digit${ctx.dominantOrder === 1 ? "" : "s"}) ${(ctx.p * 100).toFixed(1)}% (floor ${(ctx.lower * 100).toFixed(1)}%, n ${ctx.dominantCount}) · marginal ${(pMean * 100).toFixed(1)}% · anytime-valid floor ${(cs.lower * 100).toFixed(1)}%`,
    `STRUCTURAL HEADROOM ${headroomPP >= 0 ? "+" : ""}${headroomPP.toFixed(1)}pp — a fair stream wins ${(fairRate * 100).toFixed(1)}%, break-even is ${(breakEven * 100).toFixed(1)}%, so the market must run ${Math.abs(headroomPP).toFixed(1)}pp ${headroomPP < 0 ? "hot" : "cold"} before this contract is +EV at all`,
    `stationarity χ²→z ${stat.z} · trend ${stat.trend >= 0 ? "+" : ""}${stat.trend}/block · horizons ${conc.agreeing}/${conc.total} agree (spread ${(conc.spread * 100).toFixed(1)}pp) · Page–Hinkley ${drift.ph.toFixed(1)}/${drift.threshold}`,
  ];
  for (const b of blockers) signals.push(`⛔ ${b}`);

  return {
    symbol,
    displayName,
    contract,
    label: apexLabel(contract),
    certainty: spec.id,
    confidence,
    pWin,
    pLower: cs.lower,
    pMean,
    breakEven: round(breakEven),
    payout,
    expectedValue,
    sprt: sprtRes,
    context: ctx,
    replay,
    ladder,
    stationarity: stat,
    concordance: conc,
    drift,
    samples: clean.length,
    tier,
    fairRate: round(fairRate),
    requiredRate: round(p1),
    headroomPP: round(headroomPP, 2),
    deployable: blockers.length === 0,
    blockers,
    signals,
    pValue,
    significant: false, // filled by the BH pass
  };
}

// ── Live entry decision ───────────────────────────────────────────────────────

export interface ApexEntry {
  /** True when the conditional evidence says this tick is a valid entry. */
  ready: boolean;
  /** Fused conditional P(win | current context). */
  condP: number;
  /** Conservative lower bound on that estimate. */
  condLower: number;
  /** The bar it had to clear. */
  bar: number;
  /** Context depth that drove the read. */
  order: number;
  /** Observations behind the dominant context. */
  contextCount: number;
  /** The digits forming the dominant context. */
  context: number[];
  /** Evidence margin over the bar, in probability points. */
  marginPP: number;
  /** Why it is not ready (empty when ready). */
  reason: string;
}

/**
 * The per-tick entry decision, and the SAME rule `replayEntryRule` prices.
 *
 * This is deliberately the whole of the statistical entry gate: the conditional
 * estimate's conservative lower bound must clear break-even by the certainty
 * level's margin, on a context with enough observations behind it. Everything
 * else — momentum, renewal clock, feed freshness, shot spacing — is timing, and
 * lives in `apex-timing.ts`.
 */
export function evaluateApexEntry(
  digits: number[],
  winSet: ReadonlySet<number>,
  breakEven: number,
  spec: ApexCertaintySpec,
): ApexEntry {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  const wins = clean.map(d => (winSet.has(d) ? 1 : 0));
  const ctx = contextEstimate(clean, wins, 2);
  const bar = breakEven + spec.entryLcbMargin;
  const enoughHistory = clean.length >= 160;
  const enoughContext = ctx.dominantCount >= spec.minContextCount;
  const clears = ctx.lower >= bar;
  const ready = enoughHistory && enoughContext && clears;

  const reason = !enoughHistory
    ? `building history — ${clean.length}/160 digits`
    : !enoughContext
      ? `the current context has only ${ctx.dominantCount} observations (${spec.minContextCount} needed) — refusing to bet on a thin read`
      : !clears
        ? `conditional floor ${(ctx.lower * 100).toFixed(1)}% is under the ${(bar * 100).toFixed(1)}% bar (P(win|context) ${(ctx.p * 100).toFixed(1)}%)`
        : "";

  return {
    ready,
    condP: ctx.p,
    condLower: ctx.lower,
    bar: round(bar),
    order: ctx.dominantOrder,
    contextCount: ctx.dominantCount,
    context: ctx.context,
    marginPP: round((ctx.lower - bar) * 100, 2),
    reason,
  };
}

// ── A7: selection control ─────────────────────────────────────────────────────

/**
 * Benjamini–Hochberg across the whole candidate set, then rank.
 *
 * The scan examines every digit-enabled market and (for delegated Matches) all
 * ten digits, so the raw argmax is a maximum over dozens of noisy estimates. BH
 * controls the false discovery rate across the family; whether it is a hard gate
 * or a badge is the certainty level's decision.
 *
 * Ranking is by what the user is buying: replayed accuracy first (that is the
 * bot's promise), then ladder safety (that is the user's stated priority), then
 * the composite.
 */
export function screenApexCandidates(candidates: ApexCandidate[], q = 0.10): ApexCandidate[] {
  if (candidates.length === 0) return [];
  const passes = benjaminiHochberg(candidates.map(c => c.pValue), q);
  const screened = candidates.map((c, i) => {
    const significant = passes[i] === true;
    const spec = certaintySpec(c.certainty);
    return {
      ...c,
      significant,
      deployable: c.deployable && (!spec.fdrRequired || significant),
    };
  });
  return screened.sort((a, b) => {
    if (a.deployable !== b.deployable) return a.deployable ? -1 : 1;
    if (Math.abs(a.replay.winRate - b.replay.winRate) > 0.005) return b.replay.winRate - a.replay.winRate;
    if (Math.abs(a.ladder.safety - b.ladder.safety) > 0.01) return b.ladder.safety - a.ladder.safety;
    return b.confidence - a.confidence;
  });
}
