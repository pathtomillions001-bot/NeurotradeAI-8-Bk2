/**
 * APEX ONE-SHOT SNIPER — execution timing.
 *
 * "The conditional evidence is in. Is THIS the tick to fire on?"
 *
 * WHY THIS IS A SEPARATE LAYER
 * ────────────────────────────
 * `apex-analysis.ts` answers two questions: which MARKET to lock, and whether the
 * current context carries a conditional edge. Neither says anything about WHEN to
 * enter, and a digit contract settles on the NEXT tick — so the entry decision is
 * a one-tick-ahead forecast. Entering a sound setup on a stale or hostile tick is
 * the most common way a good analysis produces a loss.
 *
 * WHAT IT REFUSES, AND WHY
 * ────────────────────────
 *  1. REGIME MISMATCH. The conditional read was measured over a long window. If
 *     the last few dozen ticks are running materially colder than that window, the
 *     measurement describes a regime that has already ended. The tolerance is
 *     noise-scaled (1.25σ of the short-window rate at the reference baseline) with
 *     an absolute floor — a flat point threshold is a trap, because the standard
 *     error of a 40-tick rate is 7.9pp at p = 0.5 and 4.7pp at p = 0.9, so any
 *     fixed cut either never fires or fires on pure sampling noise.
 *
 *  2. HOSTILE MARKOV STATE. This is the layer the loss-chain model buys. If the
 *     fitted chain says P(win | last tick lost) materially exceeds
 *     P(win | last tick won), then the state after a loss is the better entry and
 *     the bot waits for it — and vice versa. The preference is only applied when
 *     the chain has enough transitions behind it and the gap between the two
 *     conditionals is wider than its own standard error, so a coin-flip stream
 *     never gets a spurious preference. This is a genuine timing edge measured on
 *     the same model that gates consecutive losses.
 *
 *  3. BAD RENEWAL POSITION. Digit contracts are renewal processes: right after a
 *     win the "due" clock has just reset, and after a drought twice the mean gap
 *     the stream has usually changed regime rather than become more likely to pay.
 *     The sweet spot is roughly 0.6×–2.2× the contract's OWN mean win-to-win gap,
 *     rebuilt from the stream rather than guessed. Wide win sets (Over 0–2,
 *     Even/Odd) win nearly every tick, carry no gap information, and are exempted
 *     rather than blocked.
 *
 *  4. STALLED FEED. A contract settles against the next tick; if the feed has
 *     stalled, the entry spot is stale.
 *
 *  5. EVIDENCE RE-USE. Two shots a tick apart are justified by almost the same
 *     evidence window, so the second is the same bet twice. A minimum tick gap
 *     keeps every shot statistically its own trade.
 *
 * THE PATIENCE VALVE
 * ──────────────────
 * Waiting is free only up to a point: a conclusive setup that waits forever rots,
 * because the regime that justified it ends while the bot is being picky about the
 * tick. So the caller passes `waitedTicks` and the shot is taken anyway once the
 * objection has stood `maxWaitTicks`. Timing gates the ENTRY; it never vetoes the
 * SETUP.
 *
 * Everything here is a pure function of the digit stream, so the whole layer is
 * unit-testable without a tick feed.
 */

import { lossChain } from "./apex-analysis";

export interface ApexTimingInput {
  /** Most-recent-last digit history for the locked market. */
  digits: number[];
  /** Digits that WIN the locked contract. */
  winSet: ReadonlySet<number>;
  /** Seconds since the last tick arrived (feed freshness). */
  secondsSinceLastTick?: number;
  /** Median inter-tick gap in seconds for this market. */
  medianTickGapSeconds?: number;
  /** Ticks observed since the previous shot (Infinity if none). */
  ticksSinceLastShot?: number;
  /** Ticks the current timing objection has already been standing. */
  waitedTicks?: number;
}

export interface ApexTimingComponents {
  shortRate: number;
  referenceRate: number;
  /** shortRate − referenceRate, in probability points. */
  momentumPP: number;
  /** Ticks since the last winning digit. */
  gapTicks: number;
  /** The contract's own mean win-to-win gap. */
  meanGap: number;
  /** gapTicks / meanGap — 1.0 is exactly due. */
  gapRatio: number;
  /** secondsSinceLastTick / medianTickGapSeconds. */
  feedLagRatio: number;
  /** Which outcome-state the chain prefers to enter from, if either. */
  preferredState: "after-loss" | "after-win" | "none";
  /** P(win | last tick lost) − P(win | last tick won), in probability points. */
  stateEdgePP: number;
  /** Whether the CURRENT tick is in the preferred state. */
  inPreferredState: boolean;
  score: number;
}

export interface ApexTimingResult {
  ready: boolean;
  /** 0–100 entry quality. Reported even when not ready. */
  score: number;
  waitTicks: number;
  /** Human-readable reason, shown verbatim in the console. */
  reason: string;
  components: ApexTimingComponents;
}

export const APEX_TIMING = {
  /** "Is the regime still on?" window. */
  shortWindow: 40,
  /** Reference window the momentum check compares against. */
  referenceWindow: 250,
  /** Momentum tolerance in standard errors of the short-window rate. */
  momentumSigma: 1.25,
  /** Absolute floor on that tolerance, in probability points. */
  minMomentumPP: 1.5,
  /** Renewal position: fire no sooner than this × the mean gap. */
  minGapRatio: 0.6,
  /** Renewal position: refuse past this × the mean gap. */
  maxGapRatio: 2.2,
  /** Feed may lag the median tick gap by at most this factor. */
  maxFeedLagRatio: 2.5,
  /** Minimum ticks between two shots so each has its own evidence. */
  minTicksBetweenShots: 10,
  /** Composite score an entry must reach. */
  minScore: 55,
  /** Transitions the loss chain needs before a state preference is applied. */
  minStateTransitions: 40,
  /** State preference gap, in probability points, before it becomes a gate. */
  minStateEdgePP: 3,
  /** Ticks a conclusive setup may be held for a better entry. */
  maxWaitTicks: 40,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rate(wins: number[]): number {
  return wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
}

/**
 * Score the current tick as an entry point for a setup whose conditional
 * evidence has ALREADY cleared. Never blocks a setup on its own — see the
 * patience valve.
 */
export function evaluateApexTiming(input: ApexTimingInput): ApexTimingResult {
  const {
    digits, winSet,
    secondsSinceLastTick = 0,
    medianTickGapSeconds = 2,
    ticksSinceLastShot = Number.POSITIVE_INFINITY,
    waitedTicks = 0,
  } = input;

  const wins = digits.map(d => (winSet.has(d) ? 1 : 0));

  // ── 1. Momentum: is the measured regime still the live one? ────────────────
  const short = wins.slice(-APEX_TIMING.shortWindow);
  const reference = wins.slice(-APEX_TIMING.referenceWindow);
  const shortRate = rate(short);
  const referenceRate = rate(reference);
  const momentumPP = (shortRate - referenceRate) * 100;
  const baseP = clamp(referenceRate, 0.02, 0.98);
  const sigmaPP = 100 * Math.sqrt((baseP * (1 - baseP)) / Math.max(1, short.length || APEX_TIMING.shortWindow));
  const momentumTolerance = -Math.max(APEX_TIMING.minMomentumPP, APEX_TIMING.momentumSigma * sigmaPP);
  const momentumOk = short.length < 10 || momentumPP >= momentumTolerance;
  const momentumTerm = clamp(0.5 + momentumPP / 12, 0, 1);

  // ── 2. Markov state preference (the loss chain, used as a timing signal) ───
  // If losses demonstrably repel, the tick after a loss is the better entry; if
  // wins demonstrably persist, the tick after a win is. Applied only when the
  // chain has the transitions to support it and the gap beats its own noise.
  const chain = lossChain(wins);
  const transitions = Math.max(1, Math.round(chain.pLoss * wins.length) + wins.length - Math.round(chain.pLoss * wins.length));
  const stateEdgePP = (chain.pWinGivenLoss - chain.pWinGivenWin) * 100;
  const enoughTransitions = wins.length >= APEX_TIMING.minStateTransitions * 2;
  // Standard error of the difference of two conditionals, in pp.
  const sePP = 100 * Math.sqrt(
    (chain.pWinGivenLoss * (1 - chain.pWinGivenLoss)) / Math.max(1, chain.pLoss * wins.length) +
    (chain.pWinGivenWin * (1 - chain.pWinGivenWin)) / Math.max(1, (1 - chain.pLoss) * wins.length),
  );
  const preferredState: ApexTimingComponents["preferredState"] =
    !enoughTransitions || Math.abs(stateEdgePP) < Math.max(APEX_TIMING.minStateEdgePP, 1.645 * sePP)
      ? "none"
      : stateEdgePP > 0 ? "after-loss" : "after-win";
  const lastWasLoss = wins.length > 0 && wins[wins.length - 1] === 0;
  const inPreferredState = preferredState === "none"
    ? true
    : preferredState === "after-loss" ? lastWasLoss : !lastWasLoss;
  const stateOk = inPreferredState;
  const stateTerm = preferredState === "none" ? 0.6 : (inPreferredState ? 1 : 0.15);

  // ── 3. Renewal position ────────────────────────────────────────────────────
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
  const gapInformative = winSet.size <= 5 && gaps.length >= 8;
  const gapOk = !gapInformative
    || (gapRatio >= APEX_TIMING.minGapRatio && gapRatio <= APEX_TIMING.maxGapRatio);
  const gapTerm = gapInformative ? clamp(1 - Math.abs(gapRatio - 1) / 1.4, 0, 1) : 0.6;

  // ── 4. Feed freshness ──────────────────────────────────────────────────────
  const medianGap = Math.max(0.2, medianTickGapSeconds);
  const feedLagRatio = secondsSinceLastTick / medianGap;
  const feedOk = feedLagRatio <= APEX_TIMING.maxFeedLagRatio;
  const feedTerm = clamp(1 - Math.max(0, feedLagRatio - 1) / 2, 0, 1);

  // ── 5. Evidence independence between shots ─────────────────────────────────
  const cadenceOk = ticksSinceLastShot >= APEX_TIMING.minTicksBetweenShots;
  const cadenceTerm = clamp(ticksSinceLastShot / APEX_TIMING.minTicksBetweenShots, 0, 1);

  const score = Math.round(clamp(100 * (
    0.32 * momentumTerm +
    0.22 * stateTerm +
    0.24 * gapTerm +
    0.11 * feedTerm +
    0.11 * cadenceTerm
  ), 0, 100));

  const components: ApexTimingComponents = {
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
  void transitions;

  const patienceExhausted = waitedTicks >= APEX_TIMING.maxWaitTicks;

  const objection = !cadenceOk
    ? `re-spacing shots — ${ticksSinceLastShot}/${APEX_TIMING.minTicksBetweenShots} ticks of fresh evidence`
    : !feedOk
      ? `tick feed lagging (${feedLagRatio.toFixed(1)}× the median gap) — the entry spot would be stale`
      : !momentumOk
        ? `last ${short.length} ticks running ${Math.abs(momentumPP).toFixed(1)}pp colder than the measured regime (tolerance ${Math.abs(momentumTolerance).toFixed(1)}pp)`
        : !stateOk
          ? `waiting for the favoured Markov state — the chain pays ${(Math.abs(stateEdgePP)).toFixed(1)}pp more ${preferredState === "after-loss" ? "after a LOSS" : "after a WIN"} and the last tick was a ${lastWasLoss ? "loss" : "win"}`
          : !gapOk
            ? (gapRatio < APEX_TIMING.minGapRatio
              ? `the contract paid ${gapTicks} tick(s) ago — the renewal clock just reset (needs ≥${APEX_TIMING.minGapRatio}× the ${meanGap.toFixed(1)}-tick mean gap)`
              : `${gapTicks}-tick drought is ${gapRatio.toFixed(1)}× the mean gap — the regime has likely broken`)
            : score < APEX_TIMING.minScore
              ? `entry quality ${score}/100 is below the ${APEX_TIMING.minScore} bar`
              : null;

  if (!objection || patienceExhausted) {
    return {
      ready: true,
      score,
      waitTicks: waitedTicks,
      reason: patienceExhausted && objection
        ? `Taking the shot — the setup has been conclusive for ${waitedTicks} ticks and timing will not improve it (entry quality ${score}/100).`
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
