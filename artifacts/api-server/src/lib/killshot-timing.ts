/**
 * KILL-SHOT ORACLE — execution timing.
 *
 * The analysis layer answers "does this market carry a measurable conditional
 * edge, and is the current context one of the ones that carries it?". This layer
 * answers a different and strictly later question: IS THIS THE TICK?
 *
 * A digit contract settles on the NEXT tick, so an entry is a one-tick-ahead
 * decision. A sound setup entered on a stale, hostile or already-spent tick is
 * the most common way a correct analysis still produces a loss.
 *
 * WHAT IT REFUSES
 * ───────────────
 *  1. REGIME MISMATCH — the conditional read was measured over a long window;
 *     if the last few dozen ticks are running materially colder than that
 *     window, the measurement describes a regime that has already ended. The
 *     tolerance is NOISE-SCALED (1.25σ of the short-window rate) with an
 *     absolute floor, because a flat point threshold is a trap: the standard
 *     error of a 40-tick rate is 7.9pp at p = 0.5 but 4.7pp at p = 0.9, so any
 *     fixed cut either never fires or fires on pure sampling noise.
 *
 *  2. HOSTILE MARKOV STATE — if the fitted outcome chain says P(win | last tick
 *     lost) materially exceeds P(win | last tick won), the post-loss state is
 *     the better entry and the bot waits for it (and vice versa). Applied only
 *     when the chain has the transitions to support it AND the gap between the
 *     two conditionals beats its own standard error, so a coin-flip stream never
 *     acquires a spurious preference.
 *
 *  3. BAD RENEWAL POSITION — digit contracts are renewal processes. Immediately
 *     after a win the "due" clock has just reset; past ~2.2× the mean gap the
 *     stream has usually changed regime rather than become more due. Wide win
 *     sets (Over 0–2, Even/Odd) carry no gap information and are exempted rather
 *     than blocked.
 *
 *  4. STALLED FEED — the contract settles against the next tick; if the feed has
 *     stalled, the entry spot is stale and the "next tick" is unknowable.
 *
 *  5. EVIDENCE RE-USE — two shots a few ticks apart rest on almost the same
 *     evidence window, so the second is the same bet twice. The spacing comes
 *     from the model card, so it is the SAME spacing the walk-forward measured.
 *
 * THE PATIENCE VALVE
 * ──────────────────
 * Waiting is free only up to a point: a conclusive setup that waits forever rots
 * because the regime that justified it ends while the bot is being fussy about
 * the tick. The caller passes `waitedTicks` and the shot is taken anyway once an
 * objection has stood `maxWaitTicks`. This layer gates the ENTRY; it never
 * vetoes the SETUP.
 *
 * Everything here is a pure function of the digit stream, so it is unit-testable
 * without a feed.
 */

import { lossChain } from "./killshot-analysis";

export interface TimingInput {
  digits: number[];
  winSet: ReadonlySet<number>;
  secondsSinceLastTick?: number;
  medianTickGapSeconds?: number;
  ticksSinceLastShot?: number;
  waitedTicks?: number;
  /** Minimum spacing between shots, taken from the frozen model card. */
  minSpacing?: number;
}

export interface TimingComponents {
  shortRate: number;
  referenceRate: number;
  momentumPP: number;
  gapTicks: number;
  meanGap: number;
  gapRatio: number;
  feedLagRatio: number;
  preferredState: "after-loss" | "after-win" | "none";
  stateEdgePP: number;
  inPreferredState: boolean;
  score: number;
}

export interface TimingResult {
  ready: boolean;
  score: number;
  waitTicks: number;
  reason: string;
  components: TimingComponents;
}

export const TIMING = {
  shortWindow: 40,
  referenceWindow: 400,
  momentumSigma: 1.25,
  minMomentumPP: 1.5,
  minGapRatio: 0.55,
  maxGapRatio: 2.4,
  maxFeedLagRatio: 2.5,
  defaultSpacing: 10,
  minScore: 52,
  minStateTransitions: 60,
  minStateEdgePP: 3,
  maxWaitTicks: 45,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function rate(wins: number[]): number {
  return wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
}

export function evaluateTiming(input: TimingInput): TimingResult {
  const {
    digits, winSet,
    secondsSinceLastTick = 0,
    medianTickGapSeconds = 2,
    ticksSinceLastShot = Number.POSITIVE_INFINITY,
    waitedTicks = 0,
    minSpacing = TIMING.defaultSpacing,
  } = input;

  const wins = digits.map(d => (winSet.has(d) ? 1 : 0));

  // 1 — momentum
  const short = wins.slice(-TIMING.shortWindow);
  const reference = wins.slice(-TIMING.referenceWindow);
  const shortRate = rate(short);
  const referenceRate = rate(reference);
  const momentumPP = (shortRate - referenceRate) * 100;
  const baseP = clamp(referenceRate, 0.02, 0.98);
  const sigmaPP = 100 * Math.sqrt((baseP * (1 - baseP)) / Math.max(1, short.length || TIMING.shortWindow));
  const tolerance = -Math.max(TIMING.minMomentumPP, TIMING.momentumSigma * sigmaPP);
  const momentumOk = short.length < 10 || momentumPP >= tolerance;
  const momentumTerm = clamp(0.5 + momentumPP / 12, 0, 1);

  // 2 — Markov state preference
  const chain = lossChain(wins);
  const stateEdgePP = (chain.pWinGivenLoss - chain.pWinGivenWin) * 100;
  const enoughTransitions = wins.length >= TIMING.minStateTransitions * 2;
  const sePP = 100 * Math.sqrt(
    (chain.pWinGivenLoss * (1 - chain.pWinGivenLoss)) / Math.max(1, chain.pLoss * wins.length) +
    (chain.pWinGivenWin * (1 - chain.pWinGivenWin)) / Math.max(1, (1 - chain.pLoss) * wins.length),
  );
  const preferredState: TimingComponents["preferredState"] =
    !enoughTransitions || Math.abs(stateEdgePP) < Math.max(TIMING.minStateEdgePP, 1.645 * sePP)
      ? "none"
      : stateEdgePP > 0 ? "after-loss" : "after-win";
  const lastWasLoss = wins.length > 0 && wins[wins.length - 1] === 0;
  const inPreferredState = preferredState === "none"
    ? true
    : preferredState === "after-loss" ? lastWasLoss : !lastWasLoss;
  const stateTerm = preferredState === "none" ? 0.6 : (inPreferredState ? 1 : 0.15);

  // 3 — renewal position
  const gaps: number[] = [];
  let since = 0;
  for (const w of wins) {
    since++;
    if (w === 1) { gaps.push(since); since = 0; }
  }
  const meanGap = gaps.length > 0
    ? gaps.reduce((a, b) => a + b, 0) / gaps.length
    : Math.max(1, 10 / Math.max(1, winSet.size));
  const gapTicks = since;
  const gapRatio = meanGap > 0 ? gapTicks / meanGap : 1;
  const gapInformative = winSet.size <= 5 && gaps.length >= 12;
  const gapOk = !gapInformative || (gapRatio >= TIMING.minGapRatio && gapRatio <= TIMING.maxGapRatio);
  const gapTerm = gapInformative ? clamp(1 - Math.abs(gapRatio - 1) / 1.4, 0, 1) : 0.6;

  // 4 — feed freshness
  //
  // An UNKNOWN tick age is not evidence of a stale feed. When the transport does
  // not stamp arrivals (a simulated or replayed feed, or a symbol whose first
  // tick has not landed yet) the age comes back non-finite, and treating that as
  // "the feed has stalled" would veto every entry forever — a refusal dressed up
  // as caution. Unknown is scored neutrally and never objects; a genuinely
  // stalled feed reports a large FINITE age and is still caught.
  const medianGap = Math.max(0.2, medianTickGapSeconds);
  const feedAgeKnown = Number.isFinite(secondsSinceLastTick);
  const feedLagRatio = feedAgeKnown ? secondsSinceLastTick / medianGap : 0;
  const feedOk = !feedAgeKnown || feedLagRatio <= TIMING.maxFeedLagRatio;
  const feedTerm = feedAgeKnown ? clamp(1 - Math.max(0, feedLagRatio - 1) / 2, 0, 1) : 0.6;

  // 5 — evidence independence
  const cadenceOk = ticksSinceLastShot >= minSpacing;
  const cadenceTerm = clamp(ticksSinceLastShot / Math.max(1, minSpacing), 0, 1);

  const score = Math.round(clamp(100 * (
    0.32 * momentumTerm +
    0.22 * stateTerm +
    0.24 * gapTerm +
    0.11 * feedTerm +
    0.11 * cadenceTerm
  ), 0, 100));

  const components: TimingComponents = {
    shortRate: Math.round(shortRate * 1e4) / 1e4,
    referenceRate: Math.round(referenceRate * 1e4) / 1e4,
    momentumPP: Math.round(momentumPP * 100) / 100,
    gapTicks,
    meanGap: Math.round(meanGap * 100) / 100,
    gapRatio: Math.round(gapRatio * 100) / 100,
    feedLagRatio: Math.round(feedLagRatio * 100) / 100,
    preferredState,
    stateEdgePP: Math.round(stateEdgePP * 100) / 100,
    inPreferredState,
    score,
  };

  const patienceExhausted = waitedTicks >= TIMING.maxWaitTicks;

  const objection = !cadenceOk
    ? `re-spacing shots — ${Number.isFinite(ticksSinceLastShot) ? ticksSinceLastShot : minSpacing}/${minSpacing} ticks of fresh evidence`
    : !feedOk
      ? `tick feed lagging (${feedLagRatio.toFixed(1)}× the median gap) — the entry spot would be stale`
      : !momentumOk
        ? `last ${short.length} ticks running ${Math.abs(momentumPP).toFixed(1)}pp colder than the measured regime (tolerance ${Math.abs(tolerance).toFixed(1)}pp)`
        : !inPreferredState
          ? `waiting for the favoured state — the chain pays ${Math.abs(stateEdgePP).toFixed(1)}pp more ${preferredState === "after-loss" ? "after a LOSS" : "after a WIN"} and the last tick was a ${lastWasLoss ? "loss" : "win"}`
          : !gapOk
            ? (gapRatio < TIMING.minGapRatio
              ? `the contract paid ${gapTicks} tick(s) ago — the renewal clock just reset (needs ≥${TIMING.minGapRatio}× the ${meanGap.toFixed(1)}-tick mean gap)`
              : `${gapTicks}-tick drought is ${gapRatio.toFixed(1)}× the mean gap — the regime has likely broken`)
            : score < TIMING.minScore
              ? `entry quality ${score}/100 is below the ${TIMING.minScore} bar`
              : null;

  if (!objection || patienceExhausted) {
    return {
      ready: true,
      score,
      waitTicks: waitedTicks,
      reason: patienceExhausted && objection
        ? `Taking the shot — the setup has been conclusive for ${waitedTicks} ticks and timing will not improve it (quality ${score}/100).`
        : `Entry tick accepted — momentum ${momentumPP >= 0 ? "+" : ""}${momentumPP.toFixed(1)}pp, renewal ${gapRatio.toFixed(2)}× mean gap, state ${preferredState === "none" ? "neutral" : preferredState}, quality ${score}/100.`,
      components,
    };
  }

  return {
    ready: false,
    score,
    waitTicks: waitedTicks,
    reason: `Holding for a better entry — ${objection}.`,
    components,
  };
}
