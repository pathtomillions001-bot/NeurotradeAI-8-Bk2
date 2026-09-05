/**
 * KILL-SHOT ORACLE — analysis core of the 7th specialist bot.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE BRIEF                                                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * "Only highly accurate trades — no margin for error. Top-tier analysis, timing
 *  and execution, but ONE kill-shot trade. The user picks exactly one contract
 *  (Over N, Under N, Matches, Even or Odd — never both sides of a pair). The AI
 *  analyses every market and LOCKS the best one. No switching, no rotation,
 *  exactly like the Barrier Architect in locked mode. Same shared recovery
 *  system as the other bots. Find the edge that does not allow consecutive
 *  losses. Take as long as it takes."
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THE PREVIOUS BOT-7 (APEX) COULD NEVER FIND A MARKET — THE POST-MORTEM ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * The user's report was: "I set Balanced, asked for Over 0 — the easiest
 * contract there is — and it still says no market qualifies." Three separate
 * defects produced that, and only one of them was a threshold:
 *
 *  1. DATA STARVATION — A HARD BUG, NOT A STRICT GATE.
 *     `DIGIT_BUFFER_SIZE` was 300, so `getDigits(sym, 1200)` returned at most
 *     300 digits. The replay burned in 120 ticks → ~180 examined ticks, and with
 *     an 8-tick minimum spacing the rule could fire at most ⌊180/8⌋ = 22 times
 *     even if EVERY eligible tick qualified. Strict demanded 24 shots. The gate
 *     was arithmetically unsatisfiable — "⛔ entry rule fired only 2× in 180
 *     ticks" was the symptom of a 300-element array, not of a fussy market.
 *     FIX: `getDeepDigits()` pulls 4999 ticks per market from Deriv's
 *     `ticks_history` (its hard maximum) on the first scan, and the live ring
 *     buffer now holds 10 000. The analysis sees 25× more evidence, instantly.
 *
 *  2. THE SPRT WAS TESTING THE WRONG HYPOTHESIS.
 *     It ran on the MARGINAL tick stream: "is this whole market's Over-0 rate
 *     above 93.7%?" That is not the bot's bet. The bot bets on selected ticks,
 *     so the null that matters is "do the SHOTS THE RULE TAKES beat break-even?"
 *     Testing the market-wide rate needed ~2000 more ticks to say anything and
 *     blocked every candidate with "SPRT still gathering market-wide evidence".
 *     FIX: the evidence test (an anytime-valid betting e-value, Ville's
 *     inequality) is applied to the OUT-OF-SAMPLE SHOT SEQUENCE. Same rigour,
 *     correct null, ~100× less data needed because the effect size is the
 *     conditional edge, not the marginal one.
 *
 *  3. THE ENTRY BAR WAS AN ABSOLUTE CONSTANT, SO SELECTIVITY WAS UNCONTROLLED.
 *     "Conditional LCB ≥ break-even + 0.5pp" fires thousands of times on Even
 *     and zero times on Over 0, because the LCB's distance from break-even
 *     depends on the contract's variance, not on how good the setup is.
 *     FIX: the bar is a QUANTILE of the model's own edge-z distribution on the
 *     training half — "take the top 1.5% of ticks" — so selectivity is a design
 *     parameter and every market always produces a measurable number of shots.
 *     The certainty level chooses the quantile; the DATA chooses the threshold.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE HONEST STARTING POINT: WHAT AN EDGE MUST OVERCOME                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * Every Deriv digit contract pays below its fair rate. With p_fair = |winSet|/10
 * and break-even b = 1/payout:
 *
 *     Over 0 : fair 90.0%  pays 1.09× → b = 91.74%  → hurdle +1.74pp
 *     Over 4 : fair 50.0%  pays 1.95× → b = 51.28%  → hurdle +1.28pp
 *     Matches: fair 10.0%  pays 8.93× → b = 11.20%  → hurdle +1.20pp
 *
 * So "Over 0 is the easiest market" is true about the WIN RATE and false about
 * the EDGE: it wins 9 times in 10 and still loses money on an unbiased stream.
 * What is genuinely special about Over 0 is DETECTABILITY. The per-shot
 * signal-to-noise of the hurdle is
 *
 *     S = (b − p_fair) / √(p_fair(1 − p_fair))
 *
 * which is 0.058 for Over 0/Under 9 — the highest in the whole family, roughly
 * 2.3× that of Over 4 — because its variance is small. The number of shots
 * needed to certify an edge at one-sided z is (z/S)², so the extreme contracts
 * need the FEWEST shots to prove themselves. `detectability()` computes this and
 * the console prints it, so the user can see which contract their patience buys
 * the most information about.
 *
 * The only edge that can clear the hurdle is CONDITIONAL: P(win | the digits
 * that just came) sitting above b, and being right about it out of sample.
 * Everything below exists to estimate that quantity honestly and to refuse it
 * when it is not there.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE ENSEMBLE — FIVE ESTIMATORS, AGGREGATED WITH A REGRET BOUND           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * One model is a guess about which structure the market has. Five models plus a
 * regret-bounded aggregator is a guarantee that the bot performs almost as well
 * as whichever of them was right, without knowing in advance which one it is.
 *
 *  E1 FORGETTING DIRICHLET — Dirichlet(½,…,½) posterior over the ten digits with
 *     exponential forgetting (λ = 0.997, half-life ≈ 230 ticks). Tracks a
 *     drifting marginal; the Jeffreys prior keeps it honest on small counts.
 *
 *  E2 CONTEXT-TREE MIXING (orders 0–4) — Krichevsky–Trofimov estimators
 *     (h+½)/(n+1) for P(win | last k digits), mixed with weights proportional to
 *     each depth's own evidence. This is the CTW principle: it provably competes
 *     with the best fixed-order Markov model in hindsight, so a rich context is
 *     trusted exactly in proportion to how often it has actually been seen.
 *
 *  E3 OUTCOME CHAIN — a 2-state Markov chain on the WIN INDICATOR itself
 *     (Laplace-smoothed), i.e. P(win | last outcome). Streaks and alternation in
 *     the contract's own outcome series are invisible to a digit-context model.
 *
 *  E4 RENEWAL HAZARD — Kaplan–Meier-style discrete hazard h(g) = P(win | g ticks
 *     since the last win), pooled over the observed gap distribution. This is
 *     the estimator that carries Matches and other narrow win sets, where the
 *     digit-context models are starved.
 *
 *  E5 TWO-STATE HMM REGIME FILTER — hot/cold Bernoulli emissions moment-matched
 *     from block rates, transitions estimated from block-state runs, and a
 *     forward recursion (α-filter) giving P(hot | evidence) at every tick. The
 *     predictive probability is the regime-weighted mixture. This is what tells
 *     the difference between "this market is hot" and "this market has been
 *     hot for the last 40 ticks and is about to stop".
 *
 *  AGGREGATION — Hedge / multiplicative weights on the log-loss:
 *     w_i ← w_i · exp(−η · (−log p_i(x_t))), renormalised each tick.
 *     Log-loss is exp-concave, so the mixture's cumulative loss exceeds the best
 *     expert's by at most O(log N / η) — the classic prediction-with-expert-
 *     advice guarantee. The bot cannot be much worse than its best component.
 *
 *  UNCERTAINTY — σ² = (posterior variance of the mixture) + (disagreement
 *     variance between experts). Disagreement is real uncertainty and is priced
 *     as such: when the five models argue, the bot does not shoot.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ CALIBRATION — THE STEP THAT MAKES "95% CONFIDENT" MEAN 95%               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * A fused score is not a probability until it is calibrated. Platt scaling
 * (a 1-D logistic regression of the outcome on logit(p̂), fitted by Newton–
 * Raphson on the TRAINING half only) maps the score onto observed frequencies.
 * Two things fall out of it:
 *   · the slope A. If the model has no skill, A collapses toward 0 and the
 *     calibrated probability collapses onto the base rate. The bot then reports
 *     "no conditional skill in this market" instead of inventing an edge.
 *   · the BRIER SKILL SCORE against the marginal baseline — a single number for
 *     "does knowing the context help at all here?", printed on the scan card.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ NO CONSECUTIVE LOSSES — THE OBJECTIVE, COMPUTED THREE WAYS               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * The shared recovery ladder is debt-driven: debt(k) = stake·(1+a)^(k−1) with
 * a = (1+markup)/(payout−1). It grows geometrically in the LENGTH of the loss
 * run, so a session dies of DEPTH, not of a low win rate.
 *  · `ladderDepthLimit()` solves in closed form for k*, the number of
 *    consecutive losses the user's stake, payout, markup, stake cap and stop
 *    loss can actually absorb.
 *  · `ladderAbsorption()` gives the EXACT probability of a deeper run inside N
 *    shots by finite Markov chain imbedding (Fu & Koutras 1994) — an absorbing
 *    state at k*+1, the transition matrix iterated N times. No Monte Carlo.
 *  · `expectedShotsToLadderBreak()` gives the closed-form mean waiting time.
 * The loss chain ξ = P(L|L)/P(L) is fitted to the OUT-OF-SAMPLE SHOTS and gated
 * on the one-sided z of q vs p (not on ξ itself, which is noisy by construction
 * when losses are rare). And the engine's live POST-LOSS PROTOCOL — a raised
 * bar plus a cool-down after every loss — is scored here too, by re-running the
 * shot ledger under that rule (`pairShield`).
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ A VERDICT, NOT A WALL                                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * The old bot had one binary: deployable or not, and the practical result was a
 * dead end with a lecture attached. Every candidate here gets one of four
 * verdicts — CERTIFIED / QUALIFIED / WATCH / REFUSED — and the scan always
 * returns the ranking plus the single best available market, with the exact
 * reason it is not better. A WATCH market can still be locked deliberately (the
 * console makes the user confirm). Only REFUSED is a wall, and it means the
 * measured out-of-sample expectancy is negative — the one case where trading is
 * simply the wrong thing to do.
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

export type ShotKind = "over" | "under" | "match" | "even" | "odd";

export interface ShotContract {
  kind: ShotKind;
  /** Barrier digit. Required for over/under; optional for match (AI may pick). */
  digit?: number;
}

export const KILLSHOT_CONTRACT_TYPE: Record<ShotKind, string> = {
  over: "DIGITOVER",
  under: "DIGITUNDER",
  match: "DIGITMATCH",
  even: "DIGITEVEN",
  odd: "DIGITODD",
};

export function shotLabel(c: ShotContract): string {
  switch (c.kind) {
    case "over":  return `Over ${c.digit}`;
    case "under": return `Under ${c.digit}`;
    case "match": return c.digit === undefined ? "Matches (AI picks the digit)" : `Matches ${c.digit}`;
    case "even":  return "Even";
    case "odd":   return "Odd";
  }
}

/** Digits that WIN this contract. */
export function shotWinSet(c: ShotContract): Set<number> {
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
export function shotPayout(c: ShotContract): number {
  switch (c.kind) {
    case "over":  return payoutForBarrier("DIGITOVER", c.digit ?? 4);
    case "under": return payoutForBarrier("DIGITUNDER", c.digit ?? 5);
    case "match": return MATCH_PAYOUT;
    case "even":
    case "odd":   return EVEN_ODD_PAYOUT;
  }
}

/** Break-even win rate = 1 / payout. */
export function shotBreakEven(c: ShotContract): number {
  return 1 / shotPayout(c);
}

/**
 * Validate the user's contract. Enforces "exactly one side": Over OR Under,
 * Even OR Odd, or Matches. There is no "both" anywhere in this bot — that is a
 * product rule, not a preference.
 */
export function validateShotContract(raw: any): { ok: true; contract: ShotContract } | { ok: false; error: string } {
  const kind = raw?.kind;
  if (!["over", "under", "match", "even", "odd"].includes(kind)) {
    return { ok: false, error: "kind must be one of: over, under, match, even, odd" };
  }
  if (kind === "even" || kind === "odd") return { ok: true, contract: { kind } };
  const digit = raw?.digit;
  if (kind === "match" && (digit === undefined || digit === null || digit === "")) {
    return { ok: true, contract: { kind: "match" } };
  }
  const d = Number(digit);
  if (!Number.isInteger(d) || d < 0 || d > 9) return { ok: false, error: `${kind} requires an integer digit 0–9` };
  if (kind === "over" && d > 8) return { ok: false, error: "Over 9 can never win — choose 0–8" };
  if (kind === "under" && d < 1) return { ok: false, error: "Under 0 can never win — choose 1–9" };
  return { ok: true, contract: { kind, digit: d } };
}

// ── Numeric helpers ───────────────────────────────────────────────────────────

function clampIndex(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function logit(p: number): number {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(q / (1 - q));
}
function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * One-sided Wilson score lower bound — the right interval for a proportion.
 *
 * The Wald interval (p̂ ± z·√(p̂(1−p̂)/n)) is badly wrong exactly where this bot
 * lives: near p = 0.9 with modest n it under-covers, which would let a market
 * look safer than it is. Wilson is the score interval and behaves.
 */
export function wilsonLower(hits: number, n: number, z = 1.645): number {
  if (n <= 0) return 0;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return clamp((centre - margin) / denom, 0, 1);
}

/** Effective sample size of a binary series under lag-1 serial dependence. */
export function effectiveSampleSize(series: number[]): number {
  const n = series.length;
  if (n < 10) return n;
  const rho = clamp(lagAutocorr(series, 1), -0.95, 0.95);
  return clamp((n * (1 - rho)) / (1 + rho), 5, n);
}

// ── Detectability: how much patience does this contract actually cost? ────────

export interface Detectability {
  fairRate: number;
  breakEven: number;
  payout: number;
  /** (breakEven − fairRate) in probability points: the house margin. */
  hurdlePP: number;
  /** Hurdle in units of one shot's standard deviation. Higher = easier to prove. */
  snrPerShot: number;
  /** Shots needed to certify the hurdle-sized edge at one-sided 95%. */
  shotsToCertify: number;
  /** Plain-language note for the console. */
  note: string;
}

/**
 * Why "Over 0 is the easiest contract" is only half true.
 *
 * Its win rate is the highest in the family and its hurdle is the widest
 * (+1.74pp), but its variance is the smallest, and PROOF scales with the ratio
 * of the two. S = (b − p_fair)/√(p_fair(1−p_fair)) is the per-shot signal-to-
 * noise of the hurdle and (1.645/S)² is the number of shots needed to establish
 * an edge of exactly that size. Over 0 needs ~800 shots; Over 4 needs ~4100.
 * A real conditional edge is several times the hurdle, so the practical figures
 * are far smaller — but the RANKING between contracts is the same, and it is
 * the opposite of most traders' intuition.
 */
export function detectability(contract: ShotContract): Detectability {
  const winSet = shotWinSet(contract);
  const fairRate = winSet.size / 10;
  const payout = shotPayout(contract);
  const breakEven = 1 / payout;
  const hurdle = breakEven - fairRate;
  const sd = Math.sqrt(Math.max(1e-9, fairRate * (1 - fairRate)));
  const snr = hurdle / sd;
  const shots = snr > 1e-6 ? Math.ceil((1.645 / snr) ** 2) : 999999;
  return {
    fairRate: round(fairRate),
    breakEven: round(breakEven),
    payout: round(payout, 3),
    hurdlePP: round(hurdle * 100, 2),
    snrPerShot: round(snr, 4),
    shotsToCertify: shots,
    note:
      `${shotLabel(contract)} pays ${payout.toFixed(2)}×, so break-even is ${(breakEven * 100).toFixed(1)}% ` +
      `against a fair ${(fairRate * 100).toFixed(1)}% — a ${(hurdle * 100).toFixed(2)}pp hurdle worth ` +
      `${snr.toFixed(3)}σ per shot. An edge exactly the size of the hurdle would take ~${shots} shots to prove; ` +
      `a conditional edge 3× that size takes ~${Math.ceil(shots / 9)}.`,
  };
}

// ── Certainty levels ──────────────────────────────────────────────────────────

export type Certainty = "elite" | "strict" | "balanced";

export interface CertaintySpec {
  id: Certainty;
  label: string;
  blurb: string;
  /**
   * TARGET SELECTIVITY — the fraction of ticks the entry rule is allowed to fire
   * on. THIS is the knob, not an absolute probability bar: it makes "how picky"
   * a design parameter and guarantees every market yields shots to judge.
   */
  targetShotRate: number;
  /** Minimum out-of-sample shots before a market may be certified. */
  minShots: number;
  /** Out-of-sample shot rate must clear break-even by this much to certify. */
  accuracyMargin: number;
  /** How far the Wilson lower bound may sit under break-even and still qualify. */
  shortfallTolerance: number;
  /** Evidence required from the anytime-valid e-value on the shots. */
  minEvidenceE: number;
  /** Minimum ladder safety = 1 − P(a loss run deeper than the ladder limit). */
  minLadderSafety: number;
  /** One-sided z at which demonstrated loss clustering becomes a veto. */
  maxClusterZ: number;
  /** Clustering must also be this many probability points wide to count. */
  minClusterGapPP: number;
  /** Composite confidence floor for a CERTIFIED verdict. */
  minConfidence: number;
  /** Benjamini–Hochberg significance is a hard requirement at this level. */
  fdrRequired: boolean;
  /** Extra σ added to the live bar after a loss (the post-loss protocol). */
  postLossTightening: number;
  /** Ticks of enforced cool-down after a loss. */
  postLossCoolTicks: number;
  /** Minimum ticks between two shots so each carries its own evidence. */
  minSpacing: number;
}

/**
 * Three bars. The difference between them is HOW PICKY the entry rule is and
 * HOW MUCH PROOF the market must show — never whether the maths runs.
 *
 * The target rates are deliberately sized against the data that actually exists.
 * A scan sees 4,999 digits, of which ~2,300 are out of sample, so a "top 0.6% of
 * ticks" rule would produce ~14 shots — fewer than the 26 the Elite bar demands
 * to certify. Such a specification is unsatisfiable by construction, which is
 * precisely how the previous Bot 7 ended up un-tradeable. Every rate here is
 * chosen so that `minShots` is reachable within one scan window, and
 * `walkForward` additionally floors τ at whatever level delivers that count.
 * Selectivity still increases monotonically from Balanced to Elite; what Elite
 * buys is far more PROOF per shot, not an unreachable threshold.
 */
export const KILLSHOT_CERTAINTY: Record<Certainty, CertaintySpec> = {
  elite: {
    id: "elite", label: "Elite",
    targetShotRate: 0.015, minShots: 26, accuracyMargin: 0.03, shortfallTolerance: 0,
    minEvidenceE: 40, minLadderSafety: 0.90, maxClusterZ: 1.28, minClusterGapPP: 2,
    minConfidence: 80, fdrRequired: true, postLossTightening: 0.75, postLossCoolTicks: 25, minSpacing: 12,
    blurb: "Top ~1.5% of ticks. Needs 26+ out-of-sample shots, break-even +3pp, an e-value ≥ 40 and 90% ladder safety. Rarely satisfied — but always measured.",
  },
  strict: {
    id: "strict", label: "Strict",
    targetShotRate: 0.025, minShots: 18, accuracyMargin: 0.015, shortfallTolerance: 0.02,
    minEvidenceE: 12, minLadderSafety: 0.80, maxClusterZ: 1.645, minClusterGapPP: 3,
    minConfidence: 68, fdrRequired: false, postLossTightening: 0.5, postLossCoolTicks: 18, minSpacing: 10,
    blurb: "Default. Top ~2.5% of ticks, 18+ out-of-sample shots, break-even +1.5pp, e-value ≥ 12, ladder safe in 4 sessions of 5.",
  },
  balanced: {
    id: "balanced", label: "Balanced",
    targetShotRate: 0.04, minShots: 12, accuracyMargin: 0.004, shortfallTolerance: 0.05,
    minEvidenceE: 4, minLadderSafety: 0.65, maxClusterZ: 2.33, minClusterGapPP: 4,
    minConfidence: 55, fdrRequired: false, postLossTightening: 0.35, postLossCoolTicks: 12, minSpacing: 8,
    blurb: "Top ~4% of ticks. Trades on a thinner but still positive out-of-sample expectancy — more shots, less proof per shot.",
  },
};

export function certaintySpec(id?: string): CertaintySpec {
  return KILLSHOT_CERTAINTY[(id as Certainty) ?? "strict"] ?? KILLSHOT_CERTAINTY.strict;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ENSEMBLE
// ═══════════════════════════════════════════════════════════════════════════

export const EXPERT_NAMES = ["dirichlet", "context-tree", "outcome-chain", "renewal-hazard", "regime-hmm"] as const;
export type ExpertName = (typeof EXPERT_NAMES)[number];

export interface ExpertReading {
  name: ExpertName;
  p: number;
  /** Evidence behind this reading (observations). */
  n: number;
  weight: number;
}

export interface EnsembleReading {
  /** Hedge-weighted fused probability, before calibration. */
  raw: number;
  /** Calibrated probability (identity until a Platt map is supplied). */
  p: number;
  /** Posterior + disagreement standard deviation. */
  sigma: number;
  /** Disagreement between experts (standard deviation of their readings). */
  spread: number;
  /** (p − breakEven) / sigma — the raw edge, in posterior standard deviations. */
  z: number;
  /**
   * THE DECISION STATISTIC: `z` standardised against the model's own recent
   * readings on this market.
   *
   * Raw z is not comparable across time. As the ensemble accumulates ticks its
   * posterior variance shrinks, so on a market with no edge z drifts steadily
   * more negative and a threshold fitted early in the history can never be
   * cleared later — which is exactly how a bot ends up "finding no market".
   * Standardising against a trailing window of its own past readings removes
   * that drift, so a threshold measured on the training half means the same
   * thing on the test half and in live trading. Every input is a past reading,
   * so it stays strictly causal.
   */
  zRel: number;
  /**
   * THE FIRING STATISTIC: how far the current standardised edge sits ABOVE the
   * model's own trailing selectivity quantile.
   *
   * Anchoring the decision to a self-referential quantile is what makes the bot
   * tradeable without loosening anything: whatever the market is doing, the top
   * `targetShotRate` of the model's own readings are candidates, so the rule
   * always produces shots to measure — and the out-of-sample ledger, not the
   * threshold, decides whether those shots are worth taking. A rule that fires
   * twice in 180 ticks cannot be measured, and a bot that cannot be measured
   * cannot be trusted.
   */
  zGate: number;
  /** The trailing quantile the gate is measured against, in standardised units. */
  gate: number;
  experts: ExpertReading[];
  /** Name of the expert currently carrying the most weight. */
  leader: ExpertName;
  /** Observations behind the deepest matched digit context. */
  contextCount: number;
  /** Depth of that context. */
  contextOrder: number;
}

interface HmmParams {
  pHot: number;
  pCold: number;
  /** P(stay in the same regime). */
  stay: number;
  /** Prior probability of starting hot. */
  prior: number;
}

/** Platt (logistic) calibration map fitted on the training half. */
export interface PlattMap {
  a: number;
  b: number;
  /** Brier skill score of the calibrated model vs the marginal baseline. */
  brierSkill: number;
  /** Log-loss skill vs the marginal baseline. */
  logLossSkill: number;
  n: number;
}

export const IDENTITY_PLATT: PlattMap = { a: 1, b: 0, brierSkill: 0, logLossSkill: 0, n: 0 };

const MAX_ORDER = 4;
const DIRICHLET_DECAY = 0.997;
const HEDGE_ETA = 0.35;
/** Trailing readings used to standardise the edge into the decision statistic. */
const Z_WINDOW = 600;
/** Readings required before the standardised statistic may be acted on. */
const Z_WINDOW_MIN = 200;
/** Ticks between refreshes of the trailing selectivity quantile. */
const Q_REFRESH = 25;

/**
 * The incremental, look-ahead-free predictor.
 *
 * Every method uses ONLY ticks already observed. `predict()` is the exact rule
 * the live engine calls; `observe()` folds the realised digit in afterwards.
 * That ordering is the whole reason the backtest is a backtest: it is enforced
 * structurally rather than by discipline, and `killshot-analysis.test.ts` checks
 * it by feeding prefixes and asserting predictions never change.
 */
export class ShotEnsemble {
  private readonly winSet: ReadonlySet<number>;
  private readonly breakEven: number;

  /** E1: decayed Dirichlet counts over the ten digits. */
  private dirichlet = new Array<number>(10).fill(0.5);
  /** E2: KT counts keyed by "order:context". */
  private ctxHits = new Map<string, number>();
  private ctxCount = new Map<string, number>();
  /** E3: outcome chain counts. */
  private chain = { ww: 0, wl: 0, lw: 0, ll: 0 };
  /** E4: renewal gaps. */
  private gapHits = new Map<number, { wins: number; n: number }>();
  private sinceWin = 0;
  /** E5: HMM filter state. */
  private hmm: HmmParams;
  private hotBelief: number;

  /** Hedge weights over the experts (log-domain for stability). */
  private logW: number[];

  private digits: number[] = [];
  private wins: number[] = [];
  private nSeen = 0;

  /** Trailing window of this model's OWN past edge readings, for standardising. */
  private zHist: number[] = [];
  private zSum = 0;
  private zSumSq = 0;
  /** Target fraction of ticks the gate should admit. */
  private readonly targetRate: number;
  /** Cached trailing quantile, refreshed every Q_REFRESH ticks. */
  private qCache = 0;
  private qFresh = false;

  constructor(winSet: ReadonlySet<number>, breakEven: number, hmm?: HmmParams, targetShotRate = 0.025) {
    this.winSet = winSet;
    this.breakEven = breakEven;
    this.targetRate = clamp(targetShotRate, 0.001, 0.5);
    const fair = winSet.size / 10;
    this.hmm = hmm ?? { pHot: clamp(fair + 0.06, 0.02, 0.98), pCold: clamp(fair - 0.06, 0.01, 0.97), stay: 0.97, prior: 0.5 };
    this.hotBelief = this.hmm.prior;
    this.logW = EXPERT_NAMES.map(() => 0);
  }

  /** Ticks folded in so far. */
  get seen(): number { return this.nSeen; }

  /** Marginal win rate over everything seen. */
  get marginal(): number { return this.nSeen > 0 ? mean(this.wins) : this.winSet.size / 10; }

  private ctxKey(order: number): string {
    if (order === 0) return "0:";
    const n = this.digits.length;
    if (n < order) return "";
    return `${order}:${this.digits.slice(n - order).join("")}`;
  }

  // ── E1 ─────────────────────────────────────────────────────────────────────
  private readDirichlet(): { p: number; n: number } {
    const total = this.dirichlet.reduce((a, b) => a + b, 0);
    let win = 0;
    for (const d of this.winSet) win += this.dirichlet[d];
    return { p: clamp(win / Math.max(1e-9, total), 1e-4, 1 - 1e-4), n: Math.round(total) };
  }

  // ── E2 ─────────────────────────────────────────────────────────────────────
  private readContextTree(): { p: number; n: number; order: number; count: number } {
    let wSum = 0;
    let pSum = 0;
    let bestW = -1;
    let bestOrder = 0;
    let bestCount = 0;
    for (let order = 0; order <= MAX_ORDER; order++) {
      const key = this.ctxKey(order);
      if (!key) continue;
      const c = this.ctxCount.get(key) ?? 0;
      if (order > 0 && c < 6) continue;
      const h = this.ctxHits.get(key) ?? 0;
      // Krichevsky–Trofimov: Beta(h + ½, c − h + ½) posterior mean.
      const p = (h + 0.5) / (c + 1);
      // CTW-style weight: evidence-proportional, discounted by depth.
      const w = (c / (c + 15)) * Math.pow(0.62, order);
      wSum += w;
      pSum += w * p;
      if (w > bestW) { bestW = w; bestOrder = order; bestCount = c; }
    }
    if (wSum <= 0) return { p: this.marginal, n: 0, order: 0, count: 0 };
    return { p: clamp(pSum / wSum, 1e-4, 1 - 1e-4), n: bestCount, order: bestOrder, count: bestCount };
  }

  // ── E3 ─────────────────────────────────────────────────────────────────────
  private readOutcomeChain(): { p: number; n: number } {
    if (this.wins.length === 0) return { p: this.marginal, n: 0 };
    const lastWon = this.wins[this.wins.length - 1] === 1;
    const prior = 4 * this.marginal;
    const priorN = 4;
    if (lastWon) {
      const n = this.chain.ww + this.chain.wl;
      return { p: clamp((this.chain.ww + prior) / (n + priorN), 1e-4, 1 - 1e-4), n };
    }
    const n = this.chain.lw + this.chain.ll;
    return { p: clamp((this.chain.lw + prior) / (n + priorN), 1e-4, 1 - 1e-4), n };
  }

  // ── E4 ─────────────────────────────────────────────────────────────────────
  private readHazard(): { p: number; n: number } {
    // Pool the current gap with its neighbours — a discrete hazard estimated on
    // one exact gap value is unusable, and neighbouring gaps carry the same
    // information about "how overdue is overdue".
    const g = this.sinceWin;
    let wins = 0;
    let n = 0;
    for (let d = -1; d <= 1; d++) {
      const cell = this.gapHits.get(g + d);
      if (cell) { wins += cell.wins; n += cell.n; }
    }
    if (n < 8) return { p: this.marginal, n };
    const prior = 6 * this.marginal;
    return { p: clamp((wins + prior) / (n + 6), 1e-4, 1 - 1e-4), n };
  }

  // ── E5 ─────────────────────────────────────────────────────────────────────
  private readRegime(): { p: number; n: number } {
    const { pHot, pCold, stay } = this.hmm;
    // One-step-ahead predictive: propagate the belief through the transition
    // matrix, then mix the two emission rates.
    const hotNext = this.hotBelief * stay + (1 - this.hotBelief) * (1 - stay);
    return { p: clamp(hotNext * pHot + (1 - hotNext) * pCold, 1e-4, 1 - 1e-4), n: this.nSeen };
  }

  /** Current belief that the market is in its hot regime. */
  get regimeHot(): number { return round(this.hotBelief, 4); }

  /** Past readings behind the standardisation window. */
  get statWarmth(): number { return this.zHist.length; }

  /** True once the trailing window can support a meaningful standardisation. */
  get statReady(): boolean { return this.zHist.length >= Z_WINDOW_MIN; }

  /**
   * Express a raw edge z in units of this model's own recent behaviour. Before
   * the window is warm the raw value is returned unchanged and `statReady` is
   * false, so callers know not to act on it yet.
   */
  private standardise(z: number): number {
    const n = this.zHist.length;
    if (n < Z_WINDOW_MIN) return z;
    const mu = this.zSum / n;
    const varZ = Math.max(1e-6, this.zSumSq / n - mu * mu);
    return (z - mu) / Math.sqrt(varZ);
  }

  /**
   * The trailing (1 − targetRate) quantile of this model's own readings, in
   * standardised units. Recomputed every `Q_REFRESH` ticks — the cadence is
   * driven by the tick counter alone, so a replay of the same prefix reproduces
   * it exactly.
   */
  private windowGate(): number {
    const n = this.zHist.length;
    if (n < Z_WINDOW_MIN) return Number.POSITIVE_INFINITY;
    if (!this.qFresh) {
      const sorted = [...this.zHist].sort((a, b) => a - b);
      const idx = clampIndex(Math.floor(n * (1 - this.targetRate)), 0, n - 1);
      const mu = this.zSum / n;
      const sd = Math.sqrt(Math.max(1e-6, this.zSumSq / n - mu * mu));
      this.qCache = (sorted[idx] - mu) / sd;
      this.qFresh = true;
    }
    return this.qCache;
  }

  /**
   * The one-tick-ahead prediction. Pure: calling it twice returns the same
   * thing, and it never touches state.
   */
  predict(platt: PlattMap = IDENTITY_PLATT): EnsembleReading {
    const readings: Array<{ name: ExpertName; p: number; n: number }> = [];
    const d1 = this.readDirichlet();
    const d2 = this.readContextTree();
    const d3 = this.readOutcomeChain();
    const d4 = this.readHazard();
    const d5 = this.readRegime();
    readings.push({ name: "dirichlet", p: d1.p, n: d1.n });
    readings.push({ name: "context-tree", p: d2.p, n: d2.n });
    readings.push({ name: "outcome-chain", p: d3.p, n: d3.n });
    readings.push({ name: "renewal-hazard", p: d4.p, n: d4.n });
    readings.push({ name: "regime-hmm", p: d5.p, n: d5.n });

    // Hedge weights (softmax of the negative cumulative log-loss).
    const maxLog = Math.max(...this.logW);
    const exps = this.logW.map(l => Math.exp(l - maxLog));
    const zSum = exps.reduce((a, b) => a + b, 0) || 1;
    const weights = exps.map(e => e / zSum);

    const raw = clamp(readings.reduce((a, r, i) => a + weights[i] * r.p, 0), 1e-5, 1 - 1e-5);

    // Disagreement variance — genuine uncertainty, priced as such.
    const spreadVar = readings.reduce((a, r, i) => a + weights[i] * (r.p - raw) ** 2, 0);
    // Posterior variance of the leading estimator (Beta approximation).
    const leadIdx = weights.indexOf(Math.max(...weights));
    const leadN = Math.max(8, readings[leadIdx].n);
    const postVar = (raw * (1 - raw)) / leadN;
    const sigma = Math.sqrt(postVar + spreadVar);

    const p = platt.n > 0 ? clamp(sigmoid(platt.a * logit(raw) + platt.b), 1e-5, 1 - 1e-5) : raw;

    const z = (p - this.breakEven) / Math.max(1e-4, sigma);
    const zRel = this.standardise(z);
    const gate = this.windowGate();

    return {
      raw: round(raw, 6),
      p: round(p, 6),
      sigma: round(Math.max(sigma, 1e-4), 6),
      spread: round(Math.sqrt(spreadVar), 6),
      z: round(z, 4),
      zRel: round(zRel, 4),
      zGate: round(Number.isFinite(gate) ? zRel - gate : -99, 4),
      gate: round(Number.isFinite(gate) ? gate : 0, 4),
      experts: readings.map((r, i) => ({ name: r.name, p: round(r.p, 5), n: r.n, weight: round(weights[i], 4) })),
      leader: readings[leadIdx].name,
      contextCount: d2.count,
      contextOrder: d2.order,
    };
  }

  /**
   * Fold the realised tick in. Called AFTER `predict()` for that tick, always.
   *
   * @param reading the prediction made for this tick, used to score the experts.
   */
  observe(digit: number, reading?: EnsembleReading) {
    const won = this.winSet.has(digit) ? 1 : 0;

    // Trailing window of past readings — the basis of the decision statistic.
    if (reading) {
      this.zHist.push(reading.z);
      this.zSum += reading.z;
      this.zSumSq += reading.z * reading.z;
      if (this.zHist.length > Z_WINDOW) {
        const old = this.zHist.shift()!;
        this.zSum -= old;
        this.zSumSq -= old * old;
      }
      if (this.zHist.length % Q_REFRESH === 0) this.qFresh = false;
    }

    // Hedge update: penalise each expert by its log-loss on this outcome.
    if (reading) {
      for (let i = 0; i < reading.experts.length; i++) {
        const pi = clamp(reading.experts[i].p, 1e-5, 1 - 1e-5);
        const loss = won === 1 ? -Math.log(pi) : -Math.log(1 - pi);
        this.logW[i] -= HEDGE_ETA * loss;
      }
      const maxLog = Math.max(...this.logW);
      for (let i = 0; i < this.logW.length; i++) this.logW[i] -= maxLog;
    }

    // E1 — decayed Dirichlet.
    for (let d = 0; d < 10; d++) this.dirichlet[d] = 0.5 + (this.dirichlet[d] - 0.5) * DIRICHLET_DECAY;
    this.dirichlet[digit] += 1;

    // E2 — KT context counts for every order, keyed on the context BEFORE this digit.
    for (let order = 0; order <= MAX_ORDER; order++) {
      const key = this.ctxKey(order);
      if (!key) continue;
      this.ctxCount.set(key, (this.ctxCount.get(key) ?? 0) + 1);
      if (won === 1) this.ctxHits.set(key, (this.ctxHits.get(key) ?? 0) + 1);
    }

    // E3 — outcome chain.
    if (this.wins.length > 0) {
      const prevWon = this.wins[this.wins.length - 1] === 1;
      if (prevWon && won === 1) this.chain.ww++;
      else if (prevWon && won === 0) this.chain.wl++;
      else if (!prevWon && won === 1) this.chain.lw++;
      else this.chain.ll++;
    }

    // E4 — renewal hazard, keyed on the gap BEFORE this tick.
    const cell = this.gapHits.get(this.sinceWin) ?? { wins: 0, n: 0 };
    cell.n++;
    if (won === 1) cell.wins++;
    this.gapHits.set(this.sinceWin, cell);
    this.sinceWin = won === 1 ? 0 : this.sinceWin + 1;

    // E5 — forward (α) recursion of the 2-state filter.
    const { pHot, pCold, stay } = this.hmm;
    const hotPrior = this.hotBelief * stay + (1 - this.hotBelief) * (1 - stay);
    const lHot = won === 1 ? pHot : 1 - pHot;
    const lCold = won === 1 ? pCold : 1 - pCold;
    const num = hotPrior * lHot;
    const den = num + (1 - hotPrior) * lCold;
    this.hotBelief = den > 1e-12 ? clamp(num / den, 1e-4, 1 - 1e-4) : hotPrior;

    this.digits.push(digit);
    this.wins.push(won);
    if (this.digits.length > 12_000) { this.digits.shift(); this.wins.shift(); }
    this.nSeen++;
  }
}

/**
 * Moment-match a 2-state HMM from block win rates.
 *
 * A full Baum–Welch on every market × contract in a scan is not worth its cost,
 * and it is not needed: the quantity the filter has to get right is HOW FAR
 * APART the two regimes are and HOW STICKY they are. Both are readable from the
 * block-rate distribution directly — the hot state is the mean of the
 * above-median blocks, the cold state the mean of the rest, and the stickiness
 * is the observed persistence of block-level state. Fast, stable, and honest
 * about being an approximation.
 */
export function fitRegimeHmm(wins: number[], blockSize = 25): HmmParams {
  const fair = mean(wins);
  if (wins.length < blockSize * 6) {
    return { pHot: clamp(fair + 0.05, 0.02, 0.98), pCold: clamp(fair - 0.05, 0.01, 0.97), stay: 0.97, prior: 0.5 };
  }
  const rates: number[] = [];
  for (let i = 0; i + blockSize <= wins.length; i += blockSize) {
    rates.push(mean(wins.slice(i, i + blockSize)));
  }
  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const hotBlocks = rates.filter(r => r > median);
  const coldBlocks = rates.filter(r => r <= median);
  const pHot = clamp(hotBlocks.length > 0 ? mean(hotBlocks) : fair + 0.05, 0.02, 0.98);
  const pCold = clamp(coldBlocks.length > 0 ? mean(coldBlocks) : fair - 0.05, 0.01, 0.97);

  let same = 0;
  for (let i = 1; i < rates.length; i++) {
    if ((rates[i] > median) === (rates[i - 1] > median)) same++;
  }
  const blockStay = rates.length > 1 ? same / (rates.length - 1) : 0.5;
  // Convert block-level persistence into a per-tick stay probability.
  const stay = clamp(Math.pow(clamp(blockStay, 0.5, 0.99), 1 / blockSize), 0.9, 0.999);

  return { pHot, pCold, stay, prior: 0.5 };
}

/**
 * Platt scaling — a 1-D logistic regression of the outcome on logit(p̂), fitted
 * by Newton–Raphson with a small ridge term.
 *
 * Fitted on the TRAINING half only, and the slope `a` is the model's own
 * confession: a ≈ 1 means the raw scores were already calibrated, a ≈ 0 means
 * they carried no information and the calibrated output collapses to the base
 * rate. There is no way for an uninformative model to survive this step looking
 * confident, which is exactly the property a bot that promises accuracy needs.
 */
export function fitPlatt(scores: number[], outcomes: number[]): PlattMap {
  const n = Math.min(scores.length, outcomes.length);
  if (n < 40) return { ...IDENTITY_PLATT };
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = logit(scores[i]);
  const base = mean(outcomes.slice(0, n));

  let a = 1;
  let b = 0;
  const ridge = 1e-3;
  for (let it = 0; it < 30; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(a * x[i] + b);
      const r = p - outcomes[i];
      const w = Math.max(1e-6, p * (1 - p));
      g0 += r * x[i]; g1 += r;
      h00 += w * x[i] * x[i]; h01 += w * x[i]; h11 += w;
    }
    g0 += ridge * a; h00 += ridge;
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const da = (g0 * h11 - g1 * h01) / det;
    const db = (g1 * h00 - g0 * h01) / det;
    a -= da; b -= db;
    if (!Number.isFinite(a) || !Number.isFinite(b)) { a = 1; b = 0; break; }
    if (Math.abs(da) < 1e-8 && Math.abs(db) < 1e-8) break;
  }
  a = clamp(a, -3, 3);
  b = clamp(b, -8, 8);

  // Skill scores against the marginal baseline.
  let brierModel = 0, brierBase = 0, llModel = 0, llBase = 0;
  for (let i = 0; i < n; i++) {
    const p = clamp(sigmoid(a * x[i] + b), 1e-6, 1 - 1e-6);
    const y = outcomes[i];
    brierModel += (p - y) ** 2;
    brierBase += (base - y) ** 2;
    llModel += y === 1 ? -Math.log(p) : -Math.log(1 - p);
    llBase += y === 1 ? -Math.log(clamp(base, 1e-6, 1 - 1e-6)) : -Math.log(clamp(1 - base, 1e-6, 1 - 1e-6));
  }
  return {
    a: round(a, 5),
    b: round(b, 5),
    brierSkill: round(brierBase > 0 ? 1 - brierModel / brierBase : 0, 5),
    logLossSkill: round(llBase > 0 ? 1 - llModel / llBase : 0, 5),
    n,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOSS CHAIN + LADDER (the "no consecutive losses" mathematics)
// ═══════════════════════════════════════════════════════════════════════════

export interface LossChain {
  pLoss: number;
  /** q = P(loss | loss). */
  q: number;
  /** r = P(loss | win). */
  r: number;
  /** ξ = q / pLoss. > 1 means losses attract losses. */
  xi: number;
  xiUpper: number;
  xiLower: number;
  /**
   * One-sided z for H₀: q = pLoss against H₁: q > pLoss.
   *
   * This, not ξ itself, is the gate. On a high-win-rate contract the losses are
   * rare, so q is estimated from few transitions and ξ's upper bound is wide
   * from sampling noise alone — a perfectly clean Over 1 stream scores ξ_upper
   * ≈ 1.2 and an absolute ceiling would veto it. Comparing q with p in units of
   * q's OWN standard error is the scale-free version of the same question.
   */
  clusterZ: number;
  clusterGapPP: number;
  pWinGivenLoss: number;
  pWinGivenWin: number;
  pTwoInARow: number;
  pairBaseline: number;
  maxLossRun: number;
  runsZ: number;
  n: number;
}

export function lossChain(wins: number[]): LossChain {
  const n = wins.length;
  const losses = wins.map(w => (w === 1 ? 0 : 1));
  const nLoss = losses.reduce((a, b) => a + b, 0);
  const pLoss = n > 0 ? nLoss / n : 1;

  let ll = 0, afterLoss = 0, lw = 0, afterWin = 0;
  for (let i = 1; i < n; i++) {
    if (losses[i - 1] === 1) { afterLoss++; if (losses[i] === 1) ll++; }
    else { afterWin++; if (losses[i] === 1) lw++; }
  }
  const prior = 5;
  const q = (ll + prior * pLoss) / (afterLoss + prior);
  const r = (lw + prior * pLoss) / (afterWin + prior);
  const xi = pLoss > 1e-6 ? q / pLoss : 1;

  const qSe = Math.sqrt(Math.max(1e-9, q * (1 - q)) / Math.max(1, afterLoss));
  const clusterZ = (q - pLoss) / Math.max(1e-6, qSe);

  let maxRun = 0, cur = 0;
  for (const l of losses) { if (l === 1) { cur++; maxRun = Math.max(maxRun, cur); } else cur = 0; }

  return {
    pLoss: round(pLoss),
    q: round(q),
    r: round(r),
    xi: round(xi, 3),
    xiUpper: round(pLoss > 1e-6 ? Math.min(1, q + 1.645 * qSe) / pLoss : 1, 3),
    xiLower: round(pLoss > 1e-6 ? Math.max(0, q - 1.645 * qSe) / pLoss : 1, 3),
    clusterZ: round(clusterZ, 3),
    clusterGapPP: round((q - pLoss) * 100, 2),
    pWinGivenLoss: round(1 - q),
    pWinGivenWin: round(1 - r),
    pTwoInARow: round(pLoss * q, 5),
    pairBaseline: round(pLoss * pLoss, 5),
    maxLossRun: maxRun,
    runsZ: round(waldWolfowitz(wins).z, 2),
    n,
  };
}

export interface LadderDepthLimit {
  growthFactor: number;
  byStakeCap: number;
  byStopLoss: number;
  limit: number;
  stakeAtLimit: number;
  debtAtLimit: number;
}

/**
 * Exact geometry of the shared debt-driven recovery ladder.
 *
 *     a        = (1 + markup) / (payout − 1)
 *     debt(k)  = baseStake · (1 + a)^(k−1)
 *     stake(k) = baseStake · a · (1 + a)^(k−2)      (k ≥ 2)
 *
 * The ladder fails at the first k whose required stake exceeds the cap (a win
 * can no longer clear the debt) and, independently, at the first k whose debt
 * reaches the stop loss. Both solve in closed form; the binding one is the
 * number of consecutive losses this session can actually absorb.
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
  const cap = Number.isFinite(input.maxStake) && input.maxStake > 0 ? input.maxStake : 1e9;
  const kCap = base * a >= cap ? 1 : Math.floor(2 + Math.log(cap / (base * a)) / Math.log(1 + a));
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
 * (Fu & Koutras 1994). The embedded state is the current consecutive-loss count
 * with an absorbing state at limit+1; iterating the transition vector nShots
 * times gives the absorption probability exactly. No Monte Carlo.
 */
export function ladderAbsorption(pLoss: number, qLossGivenLoss: number, limit: number, nShots: number): number {
  const p0 = clamp(pLoss, 0, 1);
  const q = clamp(qLossGivenLoss, 0, 1);
  const k = Math.max(1, Math.floor(limit));
  const steps = Math.max(0, Math.floor(nShots));
  if (steps === 0) return 0;

  let v = new Array<number>(k + 1).fill(0);
  v[0] = 1;
  let absorbed = 0;
  for (let s = 0; s < steps; s++) {
    const next = new Array<number>(k + 1).fill(0);
    for (let j = 0; j <= k; j++) {
      const mass = v[j];
      if (mass <= 0) continue;
      const pL = j === 0 ? p0 : q;
      if (j + 1 > k) { absorbed += mass * pL; next[0] += mass * (1 - pL); }
      else { next[j + 1] += mass * pL; next[0] += mass * (1 - pL); }
    }
    v = next;
  }
  return clamp(absorbed, 0, 1);
}

/**
 * Closed-form mean waiting time for k+1 consecutive losses in a 2-state chain:
 *
 *     E[T_k] = [1 + r·(1 − q^(k−1))/(1 − q)] / (r · q^(k−1)),   r = P(L|W)
 *
 * which reduces to the classical (1 − p^k)/((1−p)p^k) when r = q = p.
 */
export function expectedShotsToLadderBreak(pLoss: number, qLossGivenLoss: number, k: number): number {
  const p = clamp(pLoss, 1e-6, 1 - 1e-6);
  const q = clamp(qLossGivenLoss, 1e-6, 1 - 1e-6);
  const kk = Math.max(1, Math.floor(k) + 1);
  const r = clamp((p * (1 - q)) / (1 - p), 1e-6, 1 - 1e-6);
  if (kk === 1) return Math.round(1 / r);
  const geom = (1 - Math.pow(q, kk - 1)) / (1 - q);
  const e = (1 + r * geom) / (r * Math.pow(q, kk - 1));
  return Number.isFinite(e) ? Math.round(e) : 999999;
}

// ═══════════════════════════════════════════════════════════════════════════
// EVIDENCE: an anytime-valid e-value on the SHOTS
// ═══════════════════════════════════════════════════════════════════════════

export interface EvidenceValue {
  /** Wealth of the betting martingale. e ≥ 1/α rejects H₀ at level α. */
  e: number;
  /** log(e), the numerically stable quantity. */
  logE: number;
  /** Peak wealth ever reached — Ville's inequality applies to the supremum. */
  peak: number;
  n: number;
  /** Implied anytime-valid p-value = 1/peak. */
  pValue: number;
}

/**
 * Betting test supermartingale for H₀: shot win rate ≤ p₀ (Waudby-Smith &
 * Ramdas; Ville's inequality).
 *
 *     K_n = Π ( 1 + λ_i (x_i − p₀) ),   λ_i predictable
 *
 * Under H₀, K is a non-negative supermartingale with K₀ = 1, so
 * P(∃n : K_n ≥ 1/α) ≤ α. The bet λ is the past-only plug-in (a GRAPA-style
 * estimate), clipped for stability.
 *
 * WHY THIS AND NOT THE OLD SPRT: the bot re-evaluates every tick and would fire
 * the moment any fixed-sample test happened to pass — which, tested repeatedly,
 * it eventually will on pure noise. An e-value is valid at every stopping time,
 * including the data-dependent one the bot actually uses. And it is applied to
 * the SHOT sequence, which is the sequence being bet on; the previous bot tested
 * the market-wide tick stream and consequently demanded thousands of ticks to
 * say anything at all.
 */
export function evidenceValue(shots: number[], p0: number): EvidenceValue {
  const n = shots.length;
  if (n === 0) return { e: 1, logE: 0, peak: 1, n: 0, pValue: 1 };
  const base = clamp(p0, 1e-4, 1 - 1e-4);
  let logK = 0;
  let peak = 0;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const past = (hits + 0.5) / (i + 1);
    const varEst = Math.max(0.02, base * (1 - base));
    // λ ∈ [0, 0.8/(1−p₀)] keeps 1 + λ(x − p₀) strictly positive.
    const lambda = clamp((past - base) / varEst, 0, 0.8 / Math.max(1e-6, 1 - base));
    logK += Math.log(Math.max(1e-12, 1 + lambda * (shots[i] - base)));
    peak = Math.max(peak, logK);
    hits += shots[i];
  }
  return {
    e: round(Math.min(1e12, Math.exp(clamp(logK, -50, 27))), 3),
    logE: round(logK, 4),
    peak: round(Math.min(1e12, Math.exp(clamp(peak, -50, 27))), 3),
    n,
    pValue: round(clamp(Math.exp(-Math.max(0, peak)), 1e-12, 1), 8),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STATIONARITY / DRIFT / CONCORDANCE
// ═══════════════════════════════════════════════════════════════════════════

/** Pearson χ² block homogeneity as a Wilson–Hilferty z, plus an OLS drift slope. */
export function stationarity(series: number[], blocks = 6): { z: number; trend: number; rates: number[] } {
  const n = series.length;
  if (n < blocks * 25) return { z: 0, trend: 0, rates: [] };
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
  const yBar = mean(rates);
  let num = 0, den = 0;
  for (let i = 0; i < blocks; i++) { num += (i - xBar) * (rates[i] - yBar); den += (i - xBar) ** 2; }

  return { z: round((t - m) / s, 2), trend: round(den > 0 ? num / den : 0, 4), rates };
}

export interface PageHinkley {
  m: number;
  min: number;
  ph: number;
  fired: boolean;
  threshold: number;
  reference: number;
}

/**
 * Page–Hinkley change detector, oriented to catch a FALL in the win rate.
 *
 *     m_T = Σ ( x̄_{t−1} − x_t − δ ),   PH_T = m_T − min_t m_t,   alarm at λ
 *
 * x̄ is the mean of the PAST ONLY, so the statistic is predictable. A locked
 * market cannot be rotated out of, so this is the instrument that tells the user
 * their lock's premise has ended — it drives the "rescan required" alert.
 */
export function pageHinkley(wins: number[], delta = 0.03, lambda = 10, warmup = 60): PageHinkley {
  let sum = 0, m = 0, min = 0;
  for (let i = 0; i < wins.length; i++) {
    const x = wins[i];
    const pastMean = i > 0 ? sum / i : x;
    sum += x;
    if (i < warmup) continue;
    m += (pastMean - x - delta);
    if (m < min) min = m;
  }
  const ph = m - min;
  return {
    m: round(m, 3), min: round(min, 3), ph: round(ph, 3),
    fired: ph > lambda, threshold: lambda,
    reference: round(wins.length > 0 ? sum / wins.length : 0),
  };
}

export const HORIZONS = [120, 250, 500, 1000] as const;

export interface Concordance {
  rates: Array<{ window: number; p: number; n: number }>;
  agreeing: number;
  total: number;
  spread: number;
}

export function concordance(digits: number[], winSet: ReadonlySet<number>, breakEven: number, margin = 0): Concordance {
  const rates: Concordance["rates"] = [];
  for (const w of HORIZONS) {
    const seg = digits.slice(-w);
    if (seg.length < Math.min(80, w * 0.6)) continue;
    const hits = seg.reduce((a, d) => a + (winSet.has(d) ? 1 : 0), 0);
    rates.push({ window: w, p: round(hits / seg.length), n: seg.length });
  }
  if (rates.length === 0) return { rates, agreeing: 0, total: 0, spread: 1 };
  const ps = rates.map(r => r.p);
  return {
    rates,
    agreeing: rates.filter(r => r.p >= breakEven + margin).length,
    total: rates.length,
    spread: round(Math.max(...ps) - Math.min(...ps)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE WALK-FORWARD: train → threshold → OUT-OF-SAMPLE test
// ═══════════════════════════════════════════════════════════════════════════

export interface Shot {
  index: number;
  won: boolean;
  /** Calibrated probability at entry. */
  p: number;
  /** Raw edge z at entry, in posterior standard deviations. */
  z: number;
  /** The decision statistic at entry: standardised edge minus the trailing gate. */
  zGate: number;
  leader: ExpertName;
  contextOrder: number;
  contextCount: number;
  /** True when the post-loss protocol would have suppressed this shot. */
  suppressedByShield: boolean;
}

export interface ShotLedger {
  shots: Shot[];
  nShots: number;
  examined: number;
  fireRate: number;
  winRate: number;
  /** One-sided 95% Wilson lower bound on the shot win rate. */
  winRateLower: number;
  evPerDollar: number;
  /** EV computed at the LOWER bound — the worst plausible case. */
  evLowerPerDollar: number;
  longestLossRun: number;
  chain: LossChain;
  evidence: EvidenceValue;
  ladderBroke: boolean;
  /** Mean calibrated probability at entry vs realised — the honesty check. */
  meanPredicted: number;
}

export interface PairShield {
  /** Shots the post-loss protocol would have suppressed. */
  suppressed: number;
  /** Win rate of the shots that survive the shield. */
  shieldedWinRate: number;
  shieldedShots: number;
  /** Consecutive-loss pairs before and after the shield. */
  pairsBefore: number;
  pairsAfter: number;
  /** Longest loss run after the shield. */
  longestRunAfter: number;
}

export interface WalkForward {
  /** Ticks used to fit the model, the calibration and the threshold. */
  trainTicks: number;
  /** Ticks the reported numbers are measured on — never seen by the fit. */
  testTicks: number;
  /** The data-derived entry threshold, in edge-z units. */
  tau: number;
  /** Realised in-sample selectivity at tau. */
  trainShotRate: number;
  platt: PlattMap;
  /** In-sample ledger (diagnostic only — never used to certify). */
  train: ShotLedger;
  /** OUT-OF-SAMPLE ledger. This is what every gate reads. */
  test: ShotLedger;
  /** Post-loss protocol simulated on the out-of-sample shots. */
  shield: PairShield;
  hmm: HmmParams;
}

export interface WalkForwardParams {
  breakEven: number;
  payout: number;
  spec: CertaintySpec;
  baseStake: number;
  markupPercent: number;
  maxStake: number;
  stopLoss: number;
  /** Ticks of burn-in before the model is allowed to predict at all. */
  burnIn?: number;
  /** Fraction of the (post-burn-in) stream used for fitting. */
  trainFraction?: number;
}

function summariseLedger(
  shots: Shot[],
  examined: number,
  payout: number,
  breakEven: number,
  ladderLimit: number,
): ShotLedger {
  const outcomes = shots.map(s => (s.won ? 1 : 0));
  const nShots = shots.length;
  const hits = outcomes.reduce((a, b) => a + b, 0);
  const winRate = nShots > 0 ? hits / nShots : 0;
  const lower = wilsonLower(hits, nShots);

  let depth = 0, maxDepth = 0, broke = false;
  for (const s of shots) {
    if (s.won) { depth = 0; continue; }
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    if (depth > ladderLimit) broke = true;
  }

  return {
    shots,
    nShots,
    examined,
    fireRate: examined > 0 ? round(nShots / examined, 5) : 0,
    winRate: round(winRate, 5),
    winRateLower: round(lower, 5),
    evPerDollar: round(winRate * payout - 1, 5),
    evLowerPerDollar: round(lower * payout - 1, 5),
    longestLossRun: maxDepth,
    chain: lossChain(outcomes),
    evidence: evidenceValue(outcomes, breakEven),
    ladderBroke: broke,
    meanPredicted: round(nShots > 0 ? mean(shots.map(s => s.p)) : 0, 5),
  };
}

/**
 * Simulate the engine's live POST-LOSS PROTOCOL over a shot sequence.
 *
 * The live rule after a loss is: raise the bar to τ + tightening × lossRun
 * (capped, exactly as `killshot-engine` caps it) and sit out `postLossCoolTicks`
 * ticks. Replaying THAT rule — not an approximation of it — answers the question
 * the user actually asked, "does this stop consecutive losses?", with a number
 * instead of an assurance: pairs before, pairs after, and what it cost in shots.
 *
 * The bar is anchored on τ rather than on the z of the shot that just lost. That
 * distinction matters: anchoring on the loss would let one unlucky high-edge
 * shot lock the bar above every subsequent WINNING setup, which suppresses good
 * shots, keeps the loss state alive and makes the pair count go UP.
 */
function simulateShield(shots: Shot[], spec: CertaintySpec, tau: number, maxBarBoost = 2.5): PairShield {
  let pairsBefore = 0;
  for (let i = 1; i < shots.length; i++) {
    if (!shots[i].won && !shots[i - 1].won) pairsBefore++;
  }

  const kept: Shot[] = [];
  let lastLossIndex = -Infinity;
  let lossRun = 0;
  for (const s of shots) {
    const boost = Math.min(maxBarBoost, spec.postLossTightening * lossRun);
    const cooled = s.index - lastLossIndex >= spec.postLossCoolTicks;
    const clears = s.zGate >= tau + boost;
    if (cooled && clears) {
      kept.push({ ...s, suppressedByShield: false });
      if (!s.won) { lastLossIndex = s.index; lossRun++; }
      else { lastLossIndex = -Infinity; lossRun = 0; }
    }
  }

  let pairsAfter = 0, run = 0, longest = 0;
  for (let i = 0; i < kept.length; i++) {
    if (!kept[i].won) { run++; longest = Math.max(longest, run); if (i > 0 && !kept[i - 1].won) pairsAfter++; }
    else run = 0;
  }
  const hits = kept.filter(s => s.won).length;

  return {
    suppressed: shots.length - kept.length,
    shieldedWinRate: round(kept.length > 0 ? hits / kept.length : 0, 5),
    shieldedShots: kept.length,
    pairsBefore,
    pairsAfter,
    longestRunAfter: longest,
  };
}

/**
 * THE CORE ROUTINE.
 *
 * One left-to-right pass over the digit stream:
 *   · ticks [0, burnIn)               — the model warms up, no decisions.
 *   · ticks [burnIn, split)           — TRAINING: predictions are recorded to fit
 *                                       the Platt map and to choose τ, and the
 *                                       ensemble keeps learning.
 *   · ticks [split, n)                — TEST: the frozen τ and Platt map are
 *                                       applied. These shots, and only these,
 *                                       are what the verdict is based on.
 *
 * Nothing anywhere reads a future tick: `predict()` runs before `observe()` for
 * every index, and the threshold/calibration used on the test half are computed
 * exclusively from the training half. That property is asserted in the tests by
 * re-running on prefixes.
 */
export function walkForward(
  digits: number[],
  winSet: ReadonlySet<number>,
  params: WalkForwardParams,
): WalkForward {
  const clean = digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  const n = clean.length;
  const burnIn = Math.max(150, params.burnIn ?? 300);
  const trainFraction = clamp(params.trainFraction ?? 0.5, 0.3, 0.7);
  const spec = params.spec;
  const be = params.breakEven;

  const ladder = ladderDepthLimit({
    baseStake: params.baseStake, payout: params.payout,
    markupPercent: params.markupPercent, maxStake: params.maxStake, stopLoss: params.stopLoss,
  });

  const empty = (): ShotLedger => summariseLedger([], 0, params.payout, be, ladder.limit);
  if (n < burnIn + 200) {
    return {
      trainTicks: 0, testTicks: 0, tau: 0, trainShotRate: 0,
      platt: { ...IDENTITY_PLATT }, train: empty(), test: empty(),
      shield: { suppressed: 0, shieldedWinRate: 0, shieldedShots: 0, pairsBefore: 0, pairsAfter: 0, longestRunAfter: 0 },
      hmm: fitRegimeHmm([]),
    };
  }

  const wins = clean.map(d => (winSet.has(d) ? 1 : 0));
  const splitIndex = burnIn + Math.floor((n - burnIn) * trainFraction);

  // Regime parameters are fitted on the TRAINING portion only.
  const hmm = fitRegimeHmm(wins.slice(0, splitIndex));

  // ── PASS 1: train. Collect raw scores + outcomes for calibration and τ. ────
  const fitEnsemble = new ShotEnsemble(winSet, be, hmm, spec.targetShotRate);
  const trainRaw: number[] = [];
  const trainOutcome: number[] = [];
  for (let i = 0; i < splitIndex; i++) {
    if (i >= burnIn) {
      const r = fitEnsemble.predict();
      trainRaw.push(r.raw);
      trainOutcome.push(wins[i]);
      fitEnsemble.observe(clean[i], r);
    } else {
      fitEnsemble.observe(clean[i]);
    }
  }

  const platt = fitPlatt(trainRaw, trainOutcome);

  // τ: the (1 − targetShotRate) quantile of the CALIBRATED edge-z on the training
  // half. Selectivity is the design parameter; the threshold is data-derived.
  //
  // The quantile is taken over a SECOND pass across the training half rather than
  // over the pass-1 scores, because applying the Platt map changes p and therefore
  // z, and the hedge weights evolve with the calibrated readings. Measuring τ on
  // the exact quantity pass 2 will compare against is what makes the realised
  // out-of-sample shot rate land where the spec says it should. The pass reads
  // training ticks only, so nothing leaks.
  const calEnsemble = new ShotEnsemble(winSet, be, hmm, spec.targetShotRate);
  const calZ: number[] = [];
  for (let i = 0; i < splitIndex; i++) {
    if (i >= burnIn) {
      const r = calEnsemble.predict(platt);
      // Only readings the standardisation window can support are eligible, so
      // the quantile describes the same statistic the test half will produce.
      if (calEnsemble.statReady) calZ.push(r.zGate);
      calEnsemble.observe(clean[i], r);
    } else {
      calEnsemble.observe(clean[i]);
    }
  }
  calZ.sort((a, b) => a - b);

  // A rule that cannot fire cannot be judged, and a bar nobody can clear is not
  // rigour — it is the bug the previous bot shipped. τ is therefore floored at
  // the level that yields enough shots to satisfy `minShots` out of sample. The
  // train and test halves are the same size, and `minSpacing` costs some of the
  // candidate ticks, so the floor asks for a comfortable multiple.
  const targetCount = Math.ceil(calZ.length * spec.targetShotRate);
  const neededCount = Math.ceil(spec.minShots * 1.6);
  const wanted = Math.min(calZ.length, Math.max(targetCount, neededCount));
  const qIndex = Math.max(0, Math.min(Math.max(0, calZ.length - 1), calZ.length - wanted));
  const tau = calZ.length > 0 ? calZ[qIndex] : 0;

  // ── PASS 2: one continuous walk-forward, applying τ from `split` onward. ───
  const live = new ShotEnsemble(winSet, be, hmm, spec.targetShotRate);
  const trainShots: Shot[] = [];
  const testShots: Shot[] = [];
  let trainExamined = 0;
  let testExamined = 0;
  let lastFire = -Infinity;

  for (let i = 0; i < n; i++) {
    if (i >= burnIn) {
      const r = live.predict(platt);
      const isTest = i >= splitIndex;
      const eligible = live.statReady;
      if (eligible) { if (isTest) testExamined++; else trainExamined++; }
      if (eligible && i - lastFire >= spec.minSpacing && r.zGate >= tau) {
        const shot: Shot = {
          index: i,
          won: wins[i] === 1,
          p: r.p,
          z: r.z,
          zGate: r.zGate,
          leader: r.leader,
          contextOrder: r.contextOrder,
          contextCount: r.contextCount,
          suppressedByShield: false,
        };
        (isTest ? testShots : trainShots).push(shot);
        lastFire = i;
      }
      live.observe(clean[i], r);
    } else {
      live.observe(clean[i]);
    }
  }

  return {
    trainTicks: trainExamined,
    testTicks: testExamined,
    tau: round(tau, 4),
    trainShotRate: trainExamined > 0 ? round(trainShots.length / trainExamined, 5) : 0,
    platt,
    train: summariseLedger(trainShots, trainExamined, params.payout, be, ladder.limit),
    test: summariseLedger(testShots, testExamined, params.payout, be, ladder.limit),
    shield: simulateShield(testShots, spec, tau),
    hmm,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE MODEL CARD — what the scan freezes into the session
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Everything the live engine needs to reproduce EXACTLY the rule that was
 * measured. Freezing it is what makes the quoted out-of-sample accuracy a
 * statement about the session being run, rather than about a scan that has
 * already ended.
 */
export interface ModelCard {
  tau: number;
  /** Selectivity the trailing gate is tuned to — part of the frozen rule. */
  targetShotRate: number;
  platt: PlattMap;
  hmm: HmmParams;
  breakEven: number;
  payout: number;
  minSpacing: number;
  postLossTightening: number;
  postLossCoolTicks: number;
  /** Digits the analysis was fitted on, for reference in the journal. */
  fittedOn: number;
}

export interface LiveEntry {
  ready: boolean;
  p: number;
  sigma: number;
  /** The DECISION statistic — the standardised edge, compared against `bar`. */
  z: number;
  /** The raw edge in posterior standard deviations, for the journal. */
  edgeZ: number;
  /** Past readings behind the standardisation window. */
  statWarmth: number;
  tau: number;
  /** The effective bar right now, including any post-loss tightening. */
  bar: number;
  marginZ: number;
  leader: ExpertName;
  contextOrder: number;
  contextCount: number;
  regimeHot: number;
  experts: ExpertReading[];
  reason: string;
}

/**
 * The live entry decision — the same rule `walkForward` measured, driven by the
 * frozen model card.
 *
 * The replay is deliberately faithful rather than convenient. It reproduces
 * `walkForward`'s pass 2 tick for tick: raw observation through the burn-in,
 * then predict-then-observe with the reading fed back, because the hedge weights
 * over the five experts are updated from the reading and a warm-up that skips
 * that step silently produces a DIFFERENT model. The test suite asserts this by
 * replaying prefixes and matching z to the digit; if the two paths ever diverge,
 * the out-of-sample number on the scan card stops describing the live bot, which
 * is the only claim this bot makes.
 *
 * The engine passes `barBoost` (post-loss tightening, in σ) and `ticksSinceLoss`
 * so the post-loss protocol that was simulated in `simulateShield` is the one
 * that actually runs.
 */
export function evaluateLiveEntry(
  digits: number[],
  winSet: ReadonlySet<number>,
  card: ModelCard,
  opts: { barBoost?: number; ticksSinceLoss?: number; burnIn?: number } = {},
): LiveEntry {
  const clean = digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  const ens = new ShotEnsemble(winSet, card.breakEven, card.hmm, card.targetShotRate);
  const warm = Math.max(0, clean.length - 1);
  const burnIn = Math.max(0, Math.min(opts.burnIn ?? 300, warm));
  for (let i = 0; i < warm; i++) {
    if (i >= burnIn) {
      const r = ens.predict(card.platt);
      ens.observe(clean[i], r);
    } else {
      ens.observe(clean[i]);
    }
  }
  const reading = ens.predict(card.platt);

  const boost = opts.barBoost ?? 0;
  const bar = card.tau + boost;
  const cooled = (opts.ticksSinceLoss ?? Number.POSITIVE_INFINITY) >= card.postLossCoolTicks;
  const enoughHistory = clean.length >= 300;
  const warmStat = ens.statReady;
  const clears = reading.zGate >= bar;
  const ready = enoughHistory && warmStat && cooled && clears;

  const reason = !enoughHistory
    ? `building history — ${clean.length}/300 digits on the locked market`
    : !warmStat
      ? `calibrating the live scale — ${ens.statWarmth}/200 readings before the bar means anything`
      : !cooled
        ? `post-loss cool-down — ${opts.ticksSinceLoss ?? 0}/${card.postLossCoolTicks} ticks. A hurried re-entry after a loss is how one loss becomes three.`
        : !clears
          ? `edge ${reading.zGate.toFixed(2)}σ is under the ${bar.toFixed(2)}σ bar` +
            (boost > 0 ? ` (raised ${boost.toFixed(2)}σ by the post-loss protocol)` : "") +
            ` · P(win|context) ${(reading.p * 100).toFixed(1)}% vs break-even ${(card.breakEven * 100).toFixed(1)}%`
          : "";

  return {
    ready,
    p: reading.p,
    sigma: reading.sigma,
    z: reading.zGate,
    edgeZ: reading.z,
    statWarmth: ens.statWarmth,
    tau: card.tau,
    bar: round(bar, 4),
    marginZ: round(reading.zGate - bar, 4),
    leader: reading.leader,
    contextOrder: reading.contextOrder,
    contextCount: reading.contextCount,
    regimeHot: ens.regimeHot,
    experts: reading.experts,
    reason,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CANDIDATE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════

export interface LadderReport {
  limit: number;
  byStakeCap: number;
  byStopLoss: number;
  growthFactor: number;
  safety: number;
  expectedShotsToBreak: number;
  horizon: number;
  stakeAtLimit: number;
  debtAtLimit: number;
}

export type Verdict = "certified" | "qualified" | "watch" | "refused";

export interface KillShotCandidate {
  symbol: string;
  displayName: string;
  contract: ShotContract;
  label: string;
  certainty: Certainty;
  verdict: Verdict;
  /** 0–100 composite. Ranks candidates; never the sole gate. */
  confidence: number;
  /** Out-of-sample expectancy per $1 staked. The headline honesty number. */
  edgePerDollar: number;
  breakEven: number;
  payout: number;
  detect: Detectability;
  walk: WalkForward;
  ladder: LadderReport;
  stationarity: { z: number; trend: number; rates: number[] };
  concordance: Concordance;
  drift: PageHinkley;
  /** Marginal (unconditional) win rate over the whole history. */
  marginalRate: number;
  samples: number;
  /** Kelly fraction implied by the lower-bound estimate. */
  kellyFraction: number;
  /** Reasons this is not CERTIFIED. Empty when it is. */
  blockers: string[];
  /** Positive findings, printed on the scan card. */
  signals: string[];
  /** Everything the engine must freeze to run the measured rule. */
  card: ModelCard;
  pValue: number;
  significant: boolean;
  /** True when the bot may be deployed onto it at this certainty level. */
  deployable: boolean;
}

export interface EvalOptions {
  certainty?: Certainty;
  baseStake?: number;
  markupPercent?: number;
  maxStake?: number;
  stopLoss?: number;
}

/** History below this cannot support a train/test split worth the name. */
export const MIN_HISTORY = 900;
/** Digits the scan asks the feed for. Deriv's ticks_history maximum is 4999. */
export const SCAN_WINDOW = 4999;

/**
 * Score ONE (market, contract) candidate end to end.
 *
 * Returns null only when the market physically cannot be judged — too little
 * history for a split. Everything else gets a verdict and a reason.
 */
export function evaluateCandidate(
  symbol: string,
  displayName: string,
  digits: number[],
  contract: ShotContract,
  options: EvalOptions = {},
): KillShotCandidate | null {
  const clean = digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  const spec = certaintySpec(options.certainty);
  if (clean.length < MIN_HISTORY) return null;

  const winSet = shotWinSet(contract);
  if (winSet.size === 0) return null;

  const payout = shotPayout(contract);
  const breakEven = 1 / payout;
  const wins = clean.map(d => (winSet.has(d) ? 1 : 0));
  const detect = detectability(contract);

  const baseStake = options.baseStake ?? 1;
  const markupPercent = options.markupPercent ?? 10;
  const maxStake = options.maxStake ?? 500;
  const stopLoss = options.stopLoss ?? 5;

  const walk = walkForward(clean, winSet, {
    breakEven, payout, spec, baseStake, markupPercent, maxStake, stopLoss,
  });

  const depth = ladderDepthLimit({ baseStake, payout, markupPercent, maxStake, stopLoss });
  const horizon = Math.max(60, walk.test.nShots * 2, 80);
  const chain = walk.test.chain;
  const absorption = ladderAbsorption(chain.pLoss, chain.q, depth.limit, horizon);
  const ladder: LadderReport = {
    limit: depth.limit,
    byStakeCap: depth.byStakeCap,
    byStopLoss: depth.byStopLoss,
    growthFactor: depth.growthFactor,
    safety: round(1 - absorption, 4),
    expectedShotsToBreak: expectedShotsToLadderBreak(chain.pLoss, chain.q, depth.limit),
    horizon,
    stakeAtLimit: depth.stakeAtLimit,
    debtAtLimit: depth.debtAtLimit,
  };

  const stat = stationarity(wins, 6);
  const drift = pageHinkley(wins);
  const conc = concordance(clean, winSet, breakEven, 0);
  const marginalRate = mean(wins);

  // Kelly at the conservative estimate: f* = (p·b − (1−p)) / b, b = payout − 1.
  const b = Math.max(1e-6, payout - 1);
  const pK = walk.test.winRateLower;
  const kelly = clamp((pK * b - (1 - pK)) / b, 0, 1);

  // Posterior p-value that the OUT-OF-SAMPLE shot rate is not above break-even,
  // on an autocorrelation-corrected effective sample size.
  const shotOutcomes = walk.test.shots.map(s => (s.won ? 1 : 0));
  const nEff = Math.max(1, effectiveSampleSize(shotOutcomes));
  const scaledHits = walk.test.winRate * nEff;
  const pValue = walk.test.nShots > 0
    ? round(clamp(regularizedIncompleteBeta(clamp(breakEven, 0, 1), Math.max(1e-9, scaledHits + 0.5), Math.max(1e-9, nEff - scaledHits + 0.5)), 0, 1), 6)
    : 1;

  // ── Gates ────────────────────────────────────────────────────────────────
  const blockers: string[] = [];
  const test = walk.test;

  if (test.nShots < spec.minShots) {
    blockers.push(
      `only ${test.nShots} out-of-sample shots (${spec.minShots} needed) — ${walk.testTicks} test ticks at ${(spec.targetShotRate * 100).toFixed(1)}% selectivity. ` +
      `A longer history or a looser certainty bar produces them.`,
    );
  }
  if (test.nShots > 0 && test.winRate < breakEven + spec.accuracyMargin) {
    blockers.push(
      `out-of-sample shots win ${(test.winRate * 100).toFixed(1)}% — needs break-even ${(breakEven * 100).toFixed(1)}% + ${(spec.accuracyMargin * 100).toFixed(1)}pp`,
    );
  }
  if (test.nShots > 0 && test.winRateLower < breakEven - spec.shortfallTolerance) {
    blockers.push(
      `worst-case (Wilson 95%) accuracy ${(test.winRateLower * 100).toFixed(1)}% sits more than ${(spec.shortfallTolerance * 100).toFixed(1)}pp under break-even`,
    );
  }
  if (test.evidence.peak < spec.minEvidenceE) {
    blockers.push(
      `evidence e-value ${test.evidence.peak.toFixed(1)} < ${spec.minEvidenceE} — the shots have not yet ruled out "no edge" ` +
      `(anytime-valid p ≈ ${test.evidence.pValue < 0.001 ? test.evidence.pValue.toExponential(1) : test.evidence.pValue.toFixed(3)})`,
    );
  }
  if (ladder.safety < spec.minLadderSafety) {
    blockers.push(
      `ladder safety ${(ladder.safety * 100).toFixed(1)}% over ${horizon} shots — ${spec.label} wants ${(spec.minLadderSafety * 100).toFixed(0)}% ` +
      `(this stake/stop-loss absorbs ${ladder.limit} consecutive losses)`,
    );
  }
  if (test.nShots > 4 && chain.clusterZ > spec.maxClusterZ && chain.clusterGapPP >= spec.minClusterGapPP) {
    blockers.push(
      `losses pair up — P(L|L) ${(chain.q * 100).toFixed(1)}% vs marginal ${(chain.pLoss * 100).toFixed(1)}% ` +
      `(ξ ${chain.xi.toFixed(2)}, +${chain.clusterGapPP.toFixed(1)}pp at z ${chain.clusterZ.toFixed(2)})`,
    );
  }
  if (walk.platt.brierSkill <= 0 && walk.platt.n > 0) {
    blockers.push(
      `no conditional skill — the context model's Brier skill vs the base rate is ${(walk.platt.brierSkill * 100).toFixed(2)}% ` +
      `(calibration slope ${walk.platt.a.toFixed(2)}). Knowing the recent digits does not help predict this contract here.`,
    );
  }
  if (Math.abs(stat.z) > 3) blockers.push(`non-stationary market (χ²→z ${stat.z}) — a locked market that drifts cannot be corrected`);
  if (Math.abs(stat.trend) > 0.06) blockers.push(`rate is drifting (slope ${stat.trend}/block)`);

  // ── Composite confidence ─────────────────────────────────────────────────
  // Every term is bounded, independently meaningful, and measured OUT OF SAMPLE.
  const accTerm = clamp((test.winRate - breakEven) / Math.max(0.01, spec.accuracyMargin * 2.5), 0, 1);
  const lcbTerm = clamp((test.winRateLower - breakEven) / Math.max(0.01, spec.accuracyMargin * 2), 0, 1);
  const eTerm = clamp(Math.log10(Math.max(1, test.evidence.peak)) / Math.log10(Math.max(2, spec.minEvidenceE * 4)), 0, 1);
  const ladderTerm = clamp(ladder.safety, 0, 1);
  const pairTerm = clamp(1 - Math.max(0, chain.clusterZ) / Math.max(1, spec.maxClusterZ * 2), 0, 1);
  const skillTerm = clamp(walk.platt.brierSkill / 0.02, 0, 1);
  const statTerm = clamp(1 - Math.abs(stat.z) / 3, 0, 1);
  const concTerm = conc.total > 0 ? conc.agreeing / conc.total : 0;
  const cadenceTerm = clamp(test.nShots / Math.max(4, spec.minShots * 1.6), 0, 1);
  const shieldTerm = walk.shield.pairsBefore > 0
    ? clamp(1 - walk.shield.pairsAfter / walk.shield.pairsBefore, 0, 1)
    : 0.8;

  const confidence = Math.round(clamp(100 * (
    0.20 * accTerm +
    0.14 * lcbTerm +
    0.14 * eTerm +
    0.14 * ladderTerm +
    0.09 * pairTerm +
    0.08 * skillTerm +
    0.06 * cadenceTerm +
    0.06 * shieldTerm +
    0.05 * statTerm +
    0.04 * concTerm
  ), 0, 100));

  if (confidence < spec.minConfidence) {
    blockers.push(`composite confidence ${confidence} is below the ${spec.label} floor of ${spec.minConfidence}`);
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  // Four states, not a binary. Only REFUSED is a wall, and it means the measured
  // out-of-sample expectancy is negative — the one case where the right answer
  // is genuinely "do not trade this".
  const measurable = test.nShots >= Math.max(6, Math.floor(spec.minShots / 2));
  const positive = test.nShots > 0 && test.evPerDollar > 0;
  const safeLadder = ladder.safety >= Math.min(0.6, spec.minLadderSafety);

  let verdict: Verdict;
  if (blockers.length === 0) verdict = "certified";
  else if (measurable && positive && safeLadder && test.winRateLower >= breakEven - spec.shortfallTolerance) verdict = "qualified";
  else if (positive || !measurable) verdict = "watch";
  else verdict = "refused";

  const deployable = verdict === "certified" || verdict === "qualified";

  // ── Signals ──────────────────────────────────────────────────────────────
  const signals: string[] = [
    `VERDICT ${verdict.toUpperCase()} · confidence ${confidence}/100 · out-of-sample expectancy ${test.evPerDollar >= 0 ? "+" : ""}${(test.evPerDollar * 100).toFixed(2)}% per $1 (worst case ${(test.evLowerPerDollar * 100).toFixed(2)}%)`,
    `WALK-FORWARD · fitted on ${walk.trainTicks} ticks, MEASURED on ${walk.testTicks} unseen ticks · ${test.nShots} shots at ${(test.winRate * 100).toFixed(1)}% (Wilson floor ${(test.winRateLower * 100).toFixed(1)}%) vs break-even ${(breakEven * 100).toFixed(1)}% · in-sample was ${(walk.train.winRate * 100).toFixed(1)}% over ${walk.train.nShots}`,
    `ENTRY BAR · τ = ${walk.tau.toFixed(2)}σ above the model's own trailing top-${(spec.targetShotRate * 100).toFixed(1)}% quantile — a self-referential bar, not a hard-coded probability, so the rule stays measurable in any regime. Realised selectivity ${(test.fireRate * 100).toFixed(2)}% of ticks.`,
    `EVIDENCE · anytime-valid e-value ${test.evidence.peak.toFixed(1)} (p ≈ ${test.evidence.pValue < 0.001 ? test.evidence.pValue.toExponential(1) : test.evidence.pValue.toFixed(3)}) on the SHOTS — Ville's inequality, valid at every stopping time including the one the bot picks`,
    `CALIBRATION · Platt slope ${walk.platt.a.toFixed(2)}, Brier skill ${(walk.platt.brierSkill * 100).toFixed(2)}%, log-loss skill ${(walk.platt.logLossSkill * 100).toFixed(2)}% vs the base rate · mean predicted ${(test.meanPredicted * 100).toFixed(1)}% vs realised ${(test.winRate * 100).toFixed(1)}%`,
    `LADDER · absorbs ${ladder.limit} consecutive losses (cap ${ladder.byStakeCap}, stop loss ${ladder.byStopLoss}) · exact FMCI safety ${(ladder.safety * 100).toFixed(1)}% over ${horizon} shots · E[shots to break] ${ladder.expectedShotsToBreak >= 999999 ? "—" : ladder.expectedShotsToBreak} · deepest observed run ${test.longestLossRun}${test.ladderBroke ? " (BROKE)" : ""}`,
    `PAIR SHIELD · out-of-sample loss pairs ${walk.shield.pairsBefore} → ${walk.shield.pairsAfter} under the post-loss protocol (+${spec.postLossTightening}σ bar, ${spec.postLossCoolTicks}-tick cool-down), cost ${walk.shield.suppressed} shots · longest run after ${walk.shield.longestRunAfter}`,
    `LOSS CHAIN · P(L|L) ${(chain.q * 100).toFixed(1)}% vs marginal ${(chain.pLoss * 100).toFixed(1)}% · ξ ${chain.xi.toFixed(2)} [${chain.xiLower.toFixed(2)}, ${chain.xiUpper.toFixed(2)}] · P(2 in a row) ${(chain.pTwoInARow * 100).toFixed(2)}% vs ${(chain.pairBaseline * 100).toFixed(2)}% independent · runs z ${chain.runsZ >= 0 ? "+" : ""}${chain.runsZ.toFixed(2)}`,
    `DETECTABILITY · ${detect.note}`,
    `REGIME · HMM hot ${(walk.hmm.pHot * 100).toFixed(1)}% / cold ${(walk.hmm.pCold * 100).toFixed(1)}%, stickiness ${(walk.hmm.stay * 100).toFixed(1)}% · stationarity χ²→z ${stat.z}, trend ${stat.trend >= 0 ? "+" : ""}${stat.trend}/block · horizons ${conc.agreeing}/${conc.total} above break-even (spread ${(conc.spread * 100).toFixed(1)}pp) · Page–Hinkley ${drift.ph.toFixed(1)}/${drift.threshold}`,
    `SIZING · Kelly at the worst-case rate is ${(kelly * 100).toFixed(1)}% of bankroll — stake above that is over-betting a measured edge`,
  ];
  for (const bl of blockers) signals.push(`⛔ ${bl}`);

  const card: ModelCard = {
    tau: walk.tau,
    targetShotRate: spec.targetShotRate,
    platt: walk.platt,
    hmm: walk.hmm,
    breakEven: round(breakEven),
    payout: round(payout, 3),
    minSpacing: spec.minSpacing,
    postLossTightening: spec.postLossTightening,
    postLossCoolTicks: spec.postLossCoolTicks,
    fittedOn: walk.trainTicks,
  };

  return {
    symbol,
    displayName,
    contract,
    label: shotLabel(contract),
    certainty: spec.id,
    verdict,
    confidence,
    edgePerDollar: test.evPerDollar,
    breakEven: round(breakEven),
    payout: round(payout, 3),
    detect,
    walk,
    ladder,
    stationarity: stat,
    concordance: conc,
    drift,
    marginalRate: round(marginalRate),
    samples: clean.length,
    kellyFraction: round(kelly, 4),
    blockers,
    signals,
    card,
    pValue,
    significant: false,
    deployable,
  };
}

// ── Selection control + ranking ───────────────────────────────────────────────

/**
 * Benjamini–Hochberg across the whole candidate family, then rank.
 *
 * A scan looks at ~19 markets, and a delegated Matches scan looks at 190
 * (market × digit), so the raw argmax is the maximum of a lot of noisy
 * estimates. BH controls the false discovery rate across the family. Whether it
 * is a hard requirement or a badge is the certainty level's decision — at
 * Balanced a user who understands the caveat is allowed to act on the best
 * available read.
 *
 * Ranking order is deliberately the user's own priority list: verdict first,
 * then measured out-of-sample expectancy, then ladder safety, then confidence.
 */
export function screenCandidates(candidates: KillShotCandidate[], q = 0.10): KillShotCandidate[] {
  if (candidates.length === 0) return [];
  const passes = benjaminiHochberg(candidates.map(c => c.pValue), q);
  const rank: Record<Verdict, number> = { certified: 0, qualified: 1, watch: 2, refused: 3 };

  const screened = candidates.map((c, i) => {
    const significant = passes[i] === true;
    const spec = certaintySpec(c.certainty);
    const failsFdr = spec.fdrRequired && !significant;
    const verdict: Verdict = failsFdr && c.verdict === "certified" ? "qualified" : c.verdict;
    const blockers = failsFdr && c.verdict === "certified"
      ? [...c.blockers, `did not survive Benjamini–Hochberg across the ${candidates.length} candidates examined (q = ${q})`]
      : c.blockers;
    return {
      ...c,
      significant,
      verdict,
      blockers,
      deployable: verdict === "certified" || verdict === "qualified",
    };
  });

  return screened.sort((a, b) => {
    if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict];
    if (Math.abs(a.edgePerDollar - b.edgePerDollar) > 0.002) return b.edgePerDollar - a.edgePerDollar;
    if (Math.abs(a.ladder.safety - b.ladder.safety) > 0.01) return b.ladder.safety - a.ladder.safety;
    return b.confidence - a.confidence;
  });
}
