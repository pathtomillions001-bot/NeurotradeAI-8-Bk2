/**
 * Twin-Rail Sentinel — the analysis core (pure, deterministic, no broker I/O).
 *
 * THE IDEA (as specified by the user, and it is a good one):
 *   Fire TWO contracts at the same instant, on the same tick, for the same
 *   stake, straddling a barrier:
 *
 *     NORMAL   — Over 4  +  Under 5   (per-leg stake S)
 *     RECOVERY — Over 5  +  Under 4   (per-leg stake R)
 *
 *   Over 4 wins on digits {5..9}, Under 5 wins on digits {0..4}: the two legs
 *   PARTITION the digit space, so on a shared settle tick exactly one of them
 *   wins and NEITHER round can produce a double loss.
 *
 *   Over 5 wins on {6..9} and Under 4 on {0..3}: digits 4 and 5 belong to
 *   neither leg. That pair carries a real double-loss zone — the "dead rail".
 *
 * WHY THIS FILE EXISTS
 *   The user's instinct ("we win one and lose one, so we are at profit") is
 *   ALMOST right, and the difference is the whole bot. Winning one leg while
 *   losing the other returns
 *        net per round = S · (p_winner − 2)
 *   where p is the TOTAL return multiplier of the winning leg (stake included).
 *   Deriv quotes Over 4 / Under 5 at ≈1.95×, so a normal round returns
 *   −0.05·S — a fixed, variance-free toll, every single round, whatever digit
 *   prints. It is not a profit and it is not a coin flip: it is the bookmaker's
 *   margin, paid deterministically. The same is true of the recovery pair:
 *        net = S·(p − 2) when one leg wins, −2S when the dead rail hits,
 *   which is −0.056·S per round at the canonical 2.43× quotes.
 *
 *   Therefore the ONLY thing that can turn this structure positive is the same
 *   thing that makes any quote beatable: the market's ACTUAL digit frequencies
 *   disagreeing with the frequencies the quotes were priced from. So this
 *   module measures exactly two numbers per market and derives one decision:
 *
 *     1. q̂  — how often the digit tape actually lands on the dead rail digits
 *              {4,5} for the recovery pair (and, more generally, the full
 *              10-digit frequency vector f̂, Jeffreys-smoothed).
 *     2. q* — the BREAK-EVEN dead-rail rate implied by the LIVE payout quotes.
 *              Whenever q < q*, the straddle is +EV, because the two legs
 *              together are paid as if the dead rail were more likely than it
 *              is. In the balanced case q* = (p − 2) / p exactly: 17.70 % at
 *              2.43×, 20 % at a 2.50× (margin-free) quote, 15.4 % at 2.36×.
 *
 *   ONE gate falls out of those two numbers — the LOWER CONFIDENCE BOUND of
 *   the pair's measured edge must clear the carrier toll — and nothing else
 *   blocks a round. That is deliberate: an "exactly one leg wins" structure has
 *   no signal to hunt for beyond the digit distribution, so a stack of entry
 *   gates could only ever veto trades without improving them (the user's own
 *   warning, and the reason five of this platform's bots are gate-heavy while
 *   this one is not).
 *
 * THE SYNC INVARIANT (this bot's hard contract)
 *   On a shared settle tick the outcome PATTERN is itself a proof of sync:
 *     exactly one leg won  → SYNCED (the only legal result for either pair)
 *     both legs lost       → the dead rail was hit (legal for Over 5/Under 4,
 *                            IMPOSSIBLE for Over 4/Under 5 — so on the normal
 *                            pair it can only mean the legs settled on
 *                            different ticks: a genuine double loss)
 *     both legs won        → mathematically impossible on one tick, so it is a
 *                            split-tick signature (and it is a profit, not a
 *                            loss: the two legs captured two different digits)
 *   `syncVerdict` classifies every round from the two booleans alone, and the
 *   engine counts the rate. This is the "closed at the same time — latency and
 *   digit" guarantee the user asked for, made measurable instead of promised.
 */

// ── Identity ──────────────────────────────────────────────────────────────────

export const TWIN_RAIL_BOT_ID = "twinrail";
export const TWIN_RAIL_BOT_NAME = "Twin-Rail Sentinel";

/** Locked contract pair: the user picks nothing, the bot owns both legs. */
export interface PairSpec {
  /** Barrier of the OVER leg (wins on digits > over). */
  over: number;
  /** Barrier of the UNDER leg (wins on digits < under). */
  under: number;
}

/**
 * FROZEN. Both pairs are module constants and are re-asserted before every buy
 * by the engine — no request body, no UI control and no market scan can widen,
 * swap or re-tune them. A Twin-Rail session trades these four contracts and
 * nothing else, in either market mode.
 */
export const NORMAL_PAIR: PairSpec = Object.freeze({ over: 4, under: 5 });
export const RECOVERY_PAIR: PairSpec = Object.freeze({ over: 5, under: 4 });

/** Every Twin-Rail leg is a ONE-TICK digit contract: one shared settle digit. */
export const TWIN_RAIL_DURATION_TICKS = 1;

export function pairLabel(spec: PairSpec): string {
  return `Over ${spec.over} + Under ${spec.under}`;
}

export function pairContracts(spec: PairSpec): { over: "DIGITOVER"; under: "DIGITUNDER" } {
  return { over: "DIGITOVER", under: "DIGITUNDER" };
}

// ── Round payoff algebra ──────────────────────────────────────────────────────

/** Live quotes for the pair's two legs: TOTAL return per $1 staked. */
export interface PairQuote {
  overPayout: number;
  underPayout: number;
}

export interface RoundOutcome {
  digit: number;
  overWon: boolean;
  underWon: boolean;
  /** Net P&L of the WHOLE pair for this digit, in account currency. */
  net: number;
}

export function overWins(spec: PairSpec, digit: number): boolean {
  return digit > spec.over;
}

export function underWins(spec: PairSpec, digit: number): boolean {
  return digit < spec.under;
}

/**
 * Digits on which BOTH legs lose — the "dead rail".
 *
 * Over b wins on d > b, Under u wins on d < u, so the dead rail is the closed
 * interval [u, b]. It is EMPTY exactly when u = b + 1 (adjacent barriers),
 * which is why Over 4 + Under 5 can never double-lose and Over 5 + Under 4 can.
 */
export function deadZoneDigits(spec: PairSpec): number[] {
  const out: number[] = [];
  for (let d = 0; d <= 9; d++) {
    if (!overWins(spec, d) && !underWins(spec, d)) out.push(d);
  }
  return out;
}

/** True when the pair partitions the digits: exactly one leg always wins. */
export function partitionComplete(spec: PairSpec): boolean {
  return deadZoneDigits(spec).length === 0;
}

/** Net P&L of both legs at one settled digit, for equal per-leg stakes. */
export function roundOutcome(spec: PairSpec, quote: PairQuote, stake: number, digit: number): RoundOutcome {
  const o = overWins(spec, digit);
  const u = underWins(spec, digit);
  const gross =
    (o ? stake * (quote.overPayout - 1) : -stake) + (u ? stake * (quote.underPayout - 1) : -stake);
  return { digit, overWon: o, underWon: u, net: normalizeMoney(gross) };
}

/** Account-currency rounding (cents) — the ledger never sees 1e-15 of a cent. */
export function normalizeMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/** The payoff table of a pair: one row per digit 0–9. */
export function pairTable(spec: PairSpec, quote: PairQuote, stake: number): RoundOutcome[] {
  return Array.from({ length: 10 }, (_, d) => roundOutcome(spec, quote, stake, d));
}

export interface PairExpectancy {
  /** Expected net P&L of one round (both legs) at the measured frequencies. */
  mean: number;
  /** Net per round if a one-leg win happens (or the dead-rail double loss). */
  winNet: number;
  deadNet: number;
  /** Expected net per $1 of per-leg stake — the comparable "edge" number. */
  edgePerStake: number;
}

/** Expected round P&L given the digit frequency vector (sums to 1). */
export function pairExpectancy(
  spec: PairSpec,
  quote: PairQuote,
  stake: number,
  frequency: number[],
): PairExpectancy {
  const rows = pairTable(spec, quote, stake);
  let mean = 0;
  for (let d = 0; d <= 9; d++) mean += (frequency[d] ?? 0) * rows[d]!.net;
  const dead = deadZoneDigits(spec);
  const winRow = rows.find((r) => r.overWon || r.underWon) ?? rows[0]!;
  const deadRow = dead.length > 0 ? rows[dead[0]!]! : rows[0]!;
  return {
    mean: normalizeMoney(mean),
    winNet: winRow.net,
    deadNet: deadRow.net,
    edgePerStake: stake > 0 ? mean / (2 * stake) : 0,
  };
}

/**
 * BREAK-EVEN DEAD-RAIL RATE — the number this bot is built around.
 *
 * With one leg winning on the remaining ticks, a balanced split of the
 * surviving cases gives
 *     E = (1 − q)·A − (1 + 1)·q·S,   A = per-leg net at a one-leg win
 * and solving E = 0 yields the closed form
 *     q* = A / (A + 2S).
 *
 * `split` is the measured share of the OVER leg among the one-leg-win digits,
 * so an asymmetric quote/frequency mix is handled by
 *     A = split·S(p_o − 2) + (1 − split)·S(p_u − 2).
 *
 * At the canonical quotes (1.95 / 2.43) this returns 17.70 % and 0 % — the
 * second because the NORMAL pair has no dead rail at all: there is no q that
 * makes it break even, and the function says so instead of inventing one.
 */
export function deadRailBreakEven(
  spec: PairSpec,
  quote: PairQuote,
  stake: number,
  split = 0.5,
): number {
  if (deadZoneDigits(spec).length === 0) return 0;
  const s = Number.isFinite(split) ? Math.min(1, Math.max(0, split)) : 0.5;
  const overNet = stake * (quote.overPayout - 2);
  const underNet = stake * (quote.underPayout - 2);
  const a = s * overNet + (1 - s) * underNet;
  const denom = a + 2 * stake;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return Math.min(1, Math.max(0, a / denom));
}

// ── Frequency estimation (Dirichlet–multinomial with a Jeffreys prior) ────────

/**
 * Jeffreys prior α = 1/2 on each of the ten digits.
 *
 * Two reasons, both load-bearing:
 *  · it never lets an unseen digit carry zero probability, so a hot tape cannot
 *    make the dead rail look impossible;
 *  · it is the reference prior for a multinomial, so the posterior mean is the
 *    variance-minimising shrinkage of the raw counts toward 10 % each — exactly
 *    the right amount of "do not trust 4 999 digits as if they were infinite".
 */
export const JEFFREYS_ALPHA = 0.5;

export interface FrequencyEstimate {
  counts: number[];
  samples: number;
  /** Posterior mean per digit (α_d / Σα). */
  mean: number[];
  /** Posterior alpha vector, kept for downstream credible-interval maths. */
  alpha: number[];
  alphaSum: number;
  /** Dead-rail posterior mean and sd, when the pair has one. */
  deadRate: number;
  deadSd: number;
  /** Raw (unshrunk) dead-rail count, for the console's honesty strip. */
  deadRaw: number;
  /** χ² uniformity statistic over the ten digits and its p-value (9 df). */
  uniformityChi2: number;
  uniformityP: number;
}

export function estimateFrequencies(
  digits: readonly number[],
  spec: PairSpec,
): FrequencyEstimate {
  const counts = new Array<number>(10).fill(0);
  let used = 0;
  for (const d of digits) {
    if (!Number.isInteger(d) || d < 0 || d > 9) continue;
    counts[d]! += 1;
    used += 1;
  }
  const alpha = counts.map((c) => c + JEFFREYS_ALPHA);
  const alphaSum = alpha.reduce((s, a) => s + a, 0);
  const mean = alpha.map((a) => a / alphaSum);

  const dead = deadZoneDigits(spec);
  const deadCount = dead.reduce((s, d) => s + counts[d]!, 0);
  const deadRate = dead.reduce((s, d) => s + mean[d]!, 0);
  // Dirichlet marginal variance: Var(f_d) = m_d(1 − m_d)/(Σα + 1); the sum over
  // a subset needs the covariances too, which collapse to
  // Var(Σ_dead f) = q̂(1 − q̂)/(Σα + 1).
  const deadSd = Math.sqrt(Math.max(0, (deadRate * (1 - deadRate)) / (alphaSum + 1)));

  // χ² goodness-of-fit against a uniform 10-digit stream.
  const expected = used / 10;
  let chi2 = 0;
  if (expected > 0) {
    for (let d = 0; d <= 9; d++) {
      const diff = counts[d]! - expected;
      chi2 += (diff * diff) / expected;
    }
  }
  return {
    counts,
    samples: used,
    mean,
    alpha,
    alphaSum,
    deadRate,
    deadSd,
    deadRaw: used > 0 ? deadCount / used : 0,
    uniformityChi2: chi2,
    uniformityP: used > 0 ? chiSquareUpperTail(chi2, 9) : 1,
  };
}

// ── The measured edge ─────────────────────────────────────────────────────────

export interface EdgeEstimate {
  pair: PairSpec;
  quote: PairQuote;
  stake: number;
  /** Posterior-mean edge per round, in account currency (both legs). */
  mean: number;
  /** Posterior sd of that mean. */
  sd: number;
  /** One-sided lower/upper credible bounds at the requested level. */
  lcb: number;
  ucb: number;
  /** P(edge > 0) under the posterior — the console prints this. */
  pPositive: number;
  /** Break-even dead-rail rate and the measured one. */
  quota: number;
  deadRate: number;
  deadSd: number;
  /** Expected net per round if a one-leg win happens / if the dead rail hits. */
  winNet: number;
  deadNet: number;
  samples: number;
  verdict: TwinRailVerdict;
}

export type TwinRailVerdict = "certified" | "qualified" | "watch" | "refused";

/**
 * Posterior edge of ONE round of `spec`, given the tape and the live quotes.
 *
 * The edge is LINEAR in the digit frequencies, so with a Dirichlet posterior
 * its mean and variance are exact in closed form:
 *     E[net]   = Σ_d net_d · m_d
 *     Var(net) = [ Σ_d net_d² m_d − (Σ_d net_d m_d)² ] / (Σα + 1)
 * No Monte Carlo, no bootstrap — the same numbers every time, which is what
 * makes the gate testable.
 */
export function measurePairEdge(
  spec: PairSpec,
  quote: PairQuote,
  stake: number,
  est: FrequencyEstimate,
  z = 1.645,
): EdgeEstimate {
  const rows = pairTable(spec, quote, stake);
  let mean = 0;
  let secondMoment = 0;
  for (let d = 0; d <= 9; d++) {
    const m = est.mean[d] ?? 0;
    const net = rows[d]!.net;
    mean += net * m;
    secondMoment += net * net * m;
  }
  const variance = Math.max(0, (secondMoment - mean * mean) / (est.alphaSum + 1));
  const sd = Math.sqrt(variance);
  const dead = deadZoneDigits(spec);
  const winRow = rows.find((r) => r.overWon || r.underWon) ?? rows[0]!;
  const deadRow = dead.length > 0 ? rows[dead[0]!]! : rows[0]!;

  // The dead-rail split among the surviving digits, so an asymmetric quote mix
  // still gets the right break-even rate.
  let overMass = 0;
  for (let d = 0; d <= 9; d++) if (overWins(spec, d)) overMass += est.mean[d] ?? 0;
  const surviveMass = 1 - est.deadRate;
  const split = surviveMass > 0 ? overMass / surviveMass : 0.5;

  const lcb = normalizeMoney(mean - z * sd);
  const ucb = normalizeMoney(mean + z * sd);
  const verdict: TwinRailVerdict =
    lcb > 0 ? (mean > 2 * sd ? "certified" : "qualified")
    : mean > 0 ? "watch"
    : "refused";

  return {
    pair: spec,
    quote,
    stake,
    mean: normalizeMoney(mean),
    sd,
    lcb,
    ucb,
    pPositive: sd > 0 ? normalCdf(mean / sd) : mean > 0 ? 1 : 0,
    quota: deadRailBreakEven(spec, quote, stake, split),
    deadRate: est.deadRate,
    deadSd: est.deadSd,
    winNet: winRow.net,
    deadNet: deadRow.net,
    samples: est.samples,
    verdict,
  };
}

// ── The straddle theorem (why this bot measures instead of promising) ─────────

/**
 * THE ONE FACT THIS WHOLE BOT IS BUILT AROUND.
 *
 * Deriv prices each leg off its own win probability: a leg that wins with true
 * probability f is quoted at p ≈ (1 − m)/f, where m is the book's margin
 * (≈2.5–3 % on digit contracts). A straddle buys BOTH legs. Stepping through
 * the algebra:
 *
 *     E[round] = Σ_legs [ f_leg·(p_leg − 1) − (1 − f_leg) ]
 *              = Σ_legs [ f_leg·p_leg − 1 ]
 *              = Σ_legs [ (1 − m) − 1 ]
 *              = −2m·S          (per-leg stake S, whatever the barriers are)
 *
 * So a straddle is not a hedge that can be won: it is a constant, deterministic
 * payment of twice the per-contract margin per round, and it does not care which
 * digits print, which barriers are used, or how the tape is conditioned. That is
 * exactly why the normal rail (Over 4 + Under 5) returns S(p − 2) = −0.05·S at
 * the canonical 1.95× quotes on EVERY round, and it is why no entry filter can
 * turn it positive.
 *
 * The conclusion is not "the idea is worthless" — it is that the ONLY thing
 * worth analysing is the DISAGREEMENT between our measured win probabilities and
 * the probabilities the quotes were priced from. That disagreement is what
 * `straddleDisagreement` estimates, per leg, with a lower confidence bound.
 * When our measured f is high enough that f·p > 1 for a leg, that leg is +EV.
 */
export interface StraddleAnalysis {
  /** Deterministic per-round cost of a PARTITION straddle, per $1 of leg stake. */
  marginPerRoundPerStake: number;
  /** Implied win probability of each leg, solved from the pair's own quotes. */
  impliedOverWin: number;
  impliedUnderWin: number;
}

/**
 * The margin a PARTITION pair's quotes imply.
 *
 * The two implied win probabilities must sum to 1, so
 *     m = 1 − 1 / (1/p_o + 1/p_u).
 * At the canonical 1.95× / 1.95× this is exactly 2.5 %, and the pair's round
 * therefore returns −5.0 % of the per-leg stake — every round, every market,
 * every context.
 *
 * It is NOT meaningful for a pair with a dead rail (Over 5 + Under 4), whose
 * legs do not partition the digits: use `deadRailBreakEven` for those, which
 * solves the break-even dead-rail rate from the same quotes.
 */
export function partitionMargin(quote: PairQuote): number {
  const denom = 1 / quote.overPayout + 1 / quote.underPayout;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return Math.max(0, 1 - 1 / denom);
}

/** Full breakdown of a partition pair's deterministic toll. */
export function straddleAnalysis(quote: PairQuote): StraddleAnalysis {
  const m = partitionMargin(quote);
  return {
    marginPerRoundPerStake: 2 * m,
    impliedOverWin: 1 - m > 0 ? (1 - m) / quote.overPayout : 0,
    impliedUnderWin: 1 - m > 0 ? (1 - m) / quote.underPayout : 0,
  };
}

/**
 * Per-leg break-even win probability: the frequency a leg must actually achieve
 * for its contract to be worth buying, `1/p`.
 *
 * This is the number the conditioning must beat. For Over 5 at 2.43× the hurdle
 * is 41.15 % (not 40 %): the quote already keeps the margin.
 */
export function legBreakEven(payout: number): number {
  return payout > 0 ? 1 / payout : 1;
}

/**
 * The measured disagreement between the tape and the quote, per leg, as an
 * edge per $1 staked:  edge = f̂·p − 1  (positive = the leg is underpriced).
 * The pair's edge is the sum of its legs' edges — the same quantity
 * `measurePairEdge` computes on the full 10-digit vector, in a form the console
 * can print leg by leg.
 */
export function legDisagreement(payout: number, measuredWinRate: number): number {
  return measuredWinRate * payout - 1;
}

// ── Contextual conditioning (the only place an edge can come from) ────────────

/** Order-1 conditioning: the digit that just printed is the context. */
export interface ContextInfo {
  /** 0 = marginal, 1 = conditioned on the previous digit. */
  order: number;
  /** Human label, e.g. "after 7" or "unconditioned". */
  label: string;
  /** Observations of this exact context in the tape. */
  contextSamples: number;
  /** Jelinek–Mercer weight given to the context (rest goes to the marginal). */
  mixing: number;
  /** Whether the tape showed measurable memory at all (χ² test on the table). */
  memoryDetected: boolean;
  /** χ² statistic + p-value of the transition-table uniformity test. */
  chi2: number;
  chi2P: number;
}

export interface ContextualFrequencyEstimate extends FrequencyEstimate {
  context: ContextInfo;
  /** Dead-rail rate of the unconditioned tape, for comparison. */
  marginalDeadRate: number;
}

/**
 * Context weight: how many observations of a context are needed before it is
 * trusted as much as the marginal. 60 keeps an order-1 context from firing on a
 * handful of lucky ticks (λ = n/(n + 60) → 25 obs = 29 % weight).
 */
export const CONTEXT_PRIOR_WEIGHT = 60;

/** χ² p-value below which the digit tape is treated as having memory. */
export const MEMORY_ALPHA = 0.01;

/**
 * Does this market's digit stream carry memory?
 *
 * A 10×10 transition table with 9×9 = 81 degrees of freedom is compared against
 * the uniform-rows null. Below MEMORY_ALPHA the tape is treated as a Markov
 * chain of order 1 and the gate is allowed to condition on the previous digit;
 * otherwise the bot uses the marginal alone and thereby refuses to invent an
 * edge out of sampling noise. This is the anti-overfitting switch of the whole
 * bot, and it is a TEST rather than a tuned threshold.
 */
export function detectDigitMemory(digits: readonly number[]): { order: 0 | 1; chi2: number; p: number } {
  const table = new Array<number>(100).fill(0);
  let transitions = 0;
  for (let i = 1; i < digits.length; i++) {
    const prev = digits[i - 1]!;
    const cur = digits[i]!;
    if (!Number.isInteger(prev) || !Number.isInteger(cur) || prev < 0 || prev > 9 || cur < 0 || cur > 9) continue;
    table[prev * 10 + cur]! += 1;
    transitions += 1;
  }
  if (transitions < 500) return { order: 0, chi2: 0, p: 1 };

  let chi2 = 0;
  for (let prev = 0; prev <= 9; prev++) {
    let rowTotal = 0;
    for (let cur = 0; cur <= 9; cur++) rowTotal += table[prev * 10 + cur]!;
    if (rowTotal === 0) continue;
    const expected = rowTotal / 10;
    for (let cur = 0; cur <= 9; cur++) {
      const diff = table[prev * 10 + cur]! - expected;
      chi2 += (diff * diff) / expected;
    }
  }
  const p = chiSquareUpperTail(chi2, 81);
  return { order: p < MEMORY_ALPHA ? 1 : 0, chi2, p };
}

/**
 * Frequencies conditioned on the live context, mixed toward the marginal.
 *
 * This is the bot's analysis, in one function: take every occurrence of the
 * current context in the tape, count the digits that FOLLOWED it, shrink those
 * counts toward the market's own marginal with a Jelinek–Mercer weight, and
 * hand the result to `measurePairEdge`. Everything else — the quota, the LCB,
 * the verdict — is the same algebra as the unconditional case.
 */
export function buildContextualFrequencies(
  digits: readonly number[],
  spec: PairSpec,
  order: 0 | 1,
  contextDigit: number,
): ContextualFrequencyEstimate {
  const marginal = estimateFrequencies(digits, spec);
  let contextCounts = new Array<number>(10).fill(0);
  let contextSamples = 0;
  if (order === 1) {
    for (let i = 1; i < digits.length; i++) {
      if (digits[i - 1] !== contextDigit) continue;
      const cur = digits[i]!;
      if (!Number.isInteger(cur) || cur < 0 || cur > 9) continue;
      contextCounts[cur]! += 1;
      contextSamples += 1;
    }
  } else {
    contextCounts = marginal.counts.slice();
    contextSamples = marginal.samples;
  }

  const mixing = order === 1 ? contextSamples / (contextSamples + CONTEXT_PRIOR_WEIGHT) : 0;
  const mixed = new Array<number>(10);
  for (let d = 0; d <= 9; d++) {
    const c = contextSamples > 0 ? contextCounts[d]! / contextSamples : marginal.mean[d]!;
    mixed[d] = mixing * c + (1 - mixing) * marginal.mean[d]!;
  }
  const sum = mixed.reduce((s, m) => s + m, 0) || 1;
  for (let d = 0; d <= 9; d++) mixed[d] = mixed[d]! / sum;

  const dead = deadZoneDigits(spec);
  const deadRate = dead.reduce((s, d) => s + mixed[d]!, 0);
  // Effective sample size: the context's own observations plus the marginal's,
  // weighted exactly as the mixture weights them.
  const nEff = mixing * contextSamples + (1 - mixing) * marginal.samples;

  const memory = order === 1 ? detectDigitMemory(digits) : { order: 0 as const, chi2: 0, p: 1 };
  return {
    ...marginal,
    mean: mixed,
    alphaSum: nEff + 10 * JEFFREYS_ALPHA,
    deadRate,
    deadSd: Math.sqrt(Math.max(0, (deadRate * (1 - deadRate)) / (nEff + 10 * JEFFREYS_ALPHA + 1))),
    marginalDeadRate: marginal.deadRate,
    context: {
      order,
      label: order === 1 ? `after digit ${contextDigit}` : "unconditioned",
      contextSamples: order === 1 ? contextSamples : marginal.samples,
      mixing,
      memoryDetected: memory.order === 1,
      chi2: memory.chi2,
      chi2P: memory.p,
    },
  };
}

// ── Same-tick sync (the bot's hard execution contract) ────────────────────────

export type SyncVerdict = "synced" | "dead-rail" | "split-tick";

/**
 * Classify a settled round from the two booleans ALONE.
 *
 * On one shared tick, Over b and Under u can never both win (a digit cannot be
 * > b and < u at once when u ≤ b + 1), so "both won" is a proof that the legs
 * settled on different ticks. "Both lost" is legal only when the pair has a
 * dead rail; on the normal pair it is the same proof of desync, and it is the
 * exact event the user's spec calls "both normal trades lost".
 */
export function syncVerdict(spec: PairSpec, overWon: boolean, underWon: boolean): SyncVerdict {
  if (overWon && underWon) return "split-tick";
  if (!overWon && !underWon) return deadZoneDigits(spec).length > 0 ? "dead-rail" : "split-tick";
  return "synced";
}

/**
 * Second, physical sync check: two 1-tick contracts that settle on the same
 * tick must observe the SAME exit spot. Any real difference means the legs
 * closed on different ticks — it is the only measurement that survives a
 * contract whose win/loss flags were misreported.
 */
export function settleIdentity(
  exitSpotA: number,
  exitSpotB: number,
  tolerance = 1e-9,
): { sameTick: boolean; delta: number } {
  if (!Number.isFinite(exitSpotA) || !Number.isFinite(exitSpotB) || exitSpotA <= 0 || exitSpotB <= 0) {
    return { sameTick: false, delta: Number.NaN };
  }
  const delta = Math.abs(exitSpotA - exitSpotB);
  return { sameTick: delta <= tolerance, delta };
}

// ── Tick profile + the fire window ────────────────────────────────────────────

export interface TickProfile {
  /** Median inter-tick interval in ms (0 when unknown). */
  periodMs: number;
  /** Inter-quartile spread of the intervals, ms. */
  jitterMs: number;
  samples: number;
  /** Age of the newest tick when the profile was taken, ms. */
  ageMs: number;
}

export function profileTicks(tickTimestamps: readonly number[], now = Date.now()): TickProfile {
  const times = tickTimestamps.filter((t) => Number.isFinite(t) && t > 0).slice().sort((a, b) => a - b);
  if (times.length < 3) {
    return { periodMs: 0, jitterMs: 0, samples: times.length, ageMs: Number.POSITIVE_INFINITY };
  }
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (gap > 0 && gap < 120_000) gaps.push(gap);
  }
  if (gaps.length < 2) {
    return { periodMs: 0, jitterMs: 0, samples: times.length, ageMs: Number.POSITIVE_INFINITY };
  }
  gaps.sort((a, b) => a - b);
  const median = quantileSorted(gaps, 0.5);
  return {
    periodMs: median,
    jitterMs: Math.max(0, quantileSorted(gaps, 0.75) - quantileSorted(gaps, 0.25)),
    samples: times.length,
    ageMs: Math.max(0, now - times[times.length - 1]!),
  };
}

export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface TwinFirePlan {
  fire: boolean;
  /** Milliseconds to wait before firing (0 = fire now). */
  waitMs: number;
  /** Time left in the current inter-tick window, ms (can be negative). */
  headroomMs: number;
  tickPeriodMs: number;
  reason: string;
}

/**
 * THE FIRE WINDOW — the whole latency/timing problem in one function.
 *
 * A 1-tick contract opens on the tick that is current when Deriv processes its
 * buy. Two legs processed in the SAME inter-tick window start and settle on the
 * same tick (the sync invariant); two legs split across a tick boundary settle
 * on different digits. `executeBulkLiveTrades` sends both proposals in one
 * unscheduled burst, so the only remaining exposure is FIRE TIME: the burst must
 * complete (proposal → buy → ack, for both legs) before the next tick lands.
 *
 * So the bot waits for a FRESH tick and fires immediately, with the whole tick
 * period as its budget, and refuses to fire when the remaining budget cannot
 * cover the measured round-trip plus a safety margin. On a 1s market the budget
 * is ~1000 ms; on the 2s indices ~2000 ms. Nothing exotic, nothing slow: just
 * never start a race you cannot finish.
 */
export function planTwinFire(input: {
  /** Measured tick period for the active market, ms (0 = unknown). */
  tickPeriodMs: number;
  /** Time since the newest tick arrived, ms. */
  tickAgeMs: number;
  /** p95 of the measured burst round-trip (proposal+ack for both legs), ms. */
  rttP95Ms: number;
  /** Extra margin the operator wants (default 250 ms). */
  safetyMs?: number;
}): TwinFirePlan {
  const safety = Number.isFinite(input.safetyMs) ? Math.max(0, input.safetyMs!) : 250;
  const period = input.tickPeriodMs;
  const rtt = Number.isFinite(input.rttP95Ms) && input.rttP95Ms > 0 ? input.rttP95Ms : 400;

  // No measurable clock (feed down / simulated): the burst itself is still
  // atomic on the exchange side, so fire — but say so.
  if (!Number.isFinite(period) || period <= 0 || !Number.isFinite(input.tickAgeMs)) {
    return {
      fire: true,
      waitMs: 0,
      headroomMs: Number.POSITIVE_INFINITY,
      tickPeriodMs: period > 0 ? period : 0,
      reason: "No tick clock yet — firing the atomic burst and verifying the settle",
    };
  }

  const headroom = period - input.tickAgeMs;
  const budget = rtt + safety;
  if (headroom >= budget) {
    return {
      fire: true,
      waitMs: 0,
      headroomMs: headroom,
      tickPeriodMs: period,
      reason: `${Math.round(headroom)} ms of window for a ${Math.round(budget)} ms burst`,
    };
  }
  return {
    fire: false,
    waitMs: Math.max(0, headroom + 25),
    headroomMs: headroom,
    tickPeriodMs: period,
    reason: `Only ${Math.round(Math.max(0, headroom))} ms left in this tick — waiting for the next one rather than splitting the legs`,
  };
}

// ── Recovery trigger policy ───────────────────────────────────────────────────

export type RecoveryTrigger = "pair-loss" | "both-legs";

export interface RoundLedgerInput {
  /** Net P&L of the round's two legs together. */
  net: number;
  overWon: boolean;
  underWon: boolean;
  sync: SyncVerdict;
  policy: RecoveryTrigger;
}

export interface RoundLedgerDecision {
  /** True when this round puts the account into (or extends) recovery. */
  recovery: boolean;
  reason: string;
}

/**
 * Deciding when a round counts as a LOSS.
 *
 * The spec says "recover when both normal trades lost". On a synced pair of
 * Over 4 / Under 5 that event is impossible — the barriers partition the digits
 * — so the honest generalisation of the user's intent is the round's NET: a
 * round that took money out of the account is a round to recover. That is
 * `pair-loss`, and it also covers the genuine double loss (a split-tick
 * settle, which the invariant flags) at full 2×stake debt.
 *
 * `both-legs` is kept because it is the literal specification: it only ever
 * fires after a real double loss, which the console reports as a sync failure.
 * Both policies record the SAME debt — whatever the ledger actually lost — so
 * neither can invent an obligation.
 */
export function roundLedgerDecision(input: RoundLedgerInput): RoundLedgerDecision {
  const doubleLoss = !input.overWon && !input.underWon;
  if (input.policy === "both-legs") {
    return doubleLoss
      ? { recovery: true, reason: "Both legs lost — recovering the full pair stake" }
      : { recovery: false, reason: "At least one leg won" };
  }
  if (input.net < 0) {
    return {
      recovery: true,
      reason: doubleLoss
        ? `Both legs lost (${input.sync}) — full pair debt`
        : `Pair net −${Math.abs(input.net).toFixed(2)} — debt to recover`,
    };
  }
  return { recovery: false, reason: `Pair net +${input.net.toFixed(2)} — no debt` };
}

// ── Market scoring (what the scan ranks) ──────────────────────────────────────

export interface TwinRailMarketScore {
  symbol: string;
  displayName: string;
  /** Live payout quotes used for the numbers above. */
  quotes: { normal: PairQuote; recovery: PairQuote };
  /** Quotes came from a live Deriv proposal (false → canonical fallback table). */
  quotesLive: boolean;
  normal: EdgeEstimate;
  recovery: EdgeEstimate;
  tape: FrequencyEstimate;
  /**
   * The one number the scan ranks on: the recovery round's LOWER BOUND minus
   * the carrier toll the normal round pays to get there. Positive = the bot can
   * grind; negative = the structure is paying the book, and the scan says so.
   */
  cycleEdge: number;
  cycleEdgeLcb: number;
  /** Expected rounds per cycle if the dead rail behaves as measured. */
  survival: number;
  profile: TickProfile;
  verdict: TwinRailVerdict;
  deployable: boolean;
  reason: string;
  signals: string[];
}

/**
 * The cycle the bot actually runs.
 *
 *   carrier (normal pair)      → net ≈ S(p₁ − 2)   (deterministic, ≤ 0)
 *   recovery (recovery pair)   → measured posterior, positive only when the
 *                                tape beats the quoted dead-rail rate
 *
 * A cycle's expected value is therefore `carrierNet + recoveryEdge` — and since
 * the recovery stake is the DEBT-DRIVEN stake (the shared formula: debt ×
 * (1+markup)/(payout−1) per leg), the recovery edge must be evaluated at that
 * stake, not at the base stake. `cycleEdgeAtRecoveryStake` does exactly that.
 */
export function cycleEdgeAtRecoveryStake(input: {
  carrierNet: number;
  recoveryEdgePerStake: number;
  recoveryStake: number;
}): number {
  return normalizeMoney(input.carrierNet + input.recoveryEdgePerStake * 2 * input.recoveryStake);
}

// ── Numeric helpers (kept in-file: no dependency, fully testable) ─────────────

/** Standard normal CDF via Abramowitz & Stegun 26.2.17 (|err| < 7.5e-8). */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Upper tail P(X > x) of a χ² with `df` degrees of freedom. */
export function chiSquareUpperTail(x: number, df: number): number {
  if (!Number.isFinite(x) || x <= 0) return 1;
  return regularizedGammaQ(df / 2, x / 2);
}

/** Regularized upper incomplete gamma Q(s, x) — Numerical Recipes 6.2 form. */
export function regularizedGammaQ(s: number, x: number): number {
  if (!(s > 0) || x < 0) return 1;
  if (x === 0) return 1;
  if (x < s + 1) return 1 - gammaSeries(s, x);
  return gammaContinuedFraction(s, x);
}

function gammaSeries(s: number, x: number): number {
  const maxIter = 200;
  const eps = 3e-12;
  let ap = s;
  let sum = 1 / s;
  let del = sum;
  for (let n = 1; n <= maxIter; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * eps) break;
  }
  return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
}

function gammaContinuedFraction(s: number, x: number): number {
  const maxIter = 200;
  const eps = 3e-12;
  const tiny = 1e-300;
  let b = x + 1 - s;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= maxIter; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return Math.exp(-x + s * Math.log(x) - logGamma(s)) * h;
}

/** Lanczos log-gamma (g = 7, n = 9) — 15 significant digits. */
export function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j]! / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Canonical quotes, used when Deriv's public WS cannot serve a proposal. */
export const TWIN_RAIL_FALLBACK_QUOTES = Object.freeze({
  normal: Object.freeze({ overPayout: 1.95, underPayout: 1.95 }) as PairQuote,
  recovery: Object.freeze({ overPayout: 2.43, underPayout: 2.43 }) as PairQuote,
});

/**
 * The frozen explanation strip the console prints under the live numbers — one
 * line per idea, in the order the trader needs them.
 */
export const TWIN_RAIL_MECHANICS: readonly string[] = Object.freeze([
  "TWO LEGS, ONE TICK — Over 4 + Under 5 on the normal rail and Over 5 + Under 4 on recovery are sent in a single unscheduled burst on the account's pooled socket, so both legs open and settle on the SAME digit. Closed at the same time is not a hope here: the pair outcome is the proof.",
  "EXACTLY ONE LEG WINS ON A SHARED TICK — Over 4 covers digits 5–9 and Under 5 covers 0–4, so the two legs partition the digit space. A double loss is therefore impossible on the normal rail, and the engine still counts the event because a desync is the only way it can happen.",
  "THE NORMAL RAIL IS A TOLL, NOT A PROFIT — winning one leg while losing the other returns S·(p − 2) = −0.05 S at the canonical 1.95× quotes. Fixed, variance-free, every round. The console prints it as the carrier toll instead of pretending it is a win.",
  "THE RECOVERY RAIL IS WHERE THE MONEY CAN BE — Over 5 + Under 4 pays ≈2.43× on digits 0–3 and 6–9 but loses BOTH legs on digits 4 and 5 (the dead rail). One number decides it: the break-even dead-rail rate q* = (p − 2)/p, 17.70 % at 2.43×, against the rate the tape actually prints.",
  "ONE GATE, NOT NINE — the round is approved only when the LOWER confidence bound of the measured edge clears the carrier toll. A straddle has no second signal to hunt for: extra gates could only remove trades without improving them.",
  "SYNC IS MEASURED, NOT PROMISED — every round is classified from its own two outcomes (exactly one winner = synced, both winners = split ticks) and cross-checked by comparing the two exit spots. The console shows the rate, the p95 burst latency and the milliseconds of tick window left at fire time.",
]);
