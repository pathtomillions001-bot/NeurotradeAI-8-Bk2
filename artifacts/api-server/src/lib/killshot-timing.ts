/**
 * KILL-SHOT EXECUTION TIMING — "the evidence is in; is THIS the tick to fire on?"
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The evidence stack in `killshot-analysis.ts` answers one question: does this
 * market currently carry a measurable edge on this contract? It says nothing
 * about WHEN to enter. Those are different questions, and conflating them is why
 * a statistically sound setup can still be entered at the worst possible moment.
 *
 * A digit contract settles on the NEXT tick. So the entry decision is a
 * one-tick-ahead forecast, and the only honest way to make it is to ask whether
 * the regime the evidence was measured on is still the regime the market is in
 * RIGHT NOW. This module is that check. It runs AFTER every evidence gate has
 * cleared and BEFORE any buy, for normal shots and recovery shots alike.
 *
 * WHAT IT REFUSES, AND WHY EACH ONE MATTERS
 * ─────────────────────────────────────────
 *  1. MOMENTUM MISMATCH. The edge was measured over a long window. If the last
 *     few dozen ticks are running COLDER than that window, the measurement is
 *     describing a regime that has already ended. Firing then is entering on a
 *     stale read — the single most common way a good analysis produces a loss.
 *
 *  2. BAD GAP POSITION. Digit contracts are renewal processes: after a win the
 *     "due" clock resets, and after a very long drought the stream has usually
 *     changed regime rather than become more likely to pay. There is a sweet
 *     spot — roughly 0.6× to 1.6× the contract's own mean gap — where the
 *     empirical hazard is highest without the regime having broken. Firing
 *     immediately after a win, or after a drought twice the mean gap, are both
 *     measurable degradations and both are refused.
 *
 *  3. STALLED FEED. A contract settles against the next tick. If the feed has
 *     stalled, "next tick" is unknown and the entry spot is stale. Refuse.
 *
 *  4. EVIDENCE RE-USE. Two shots fired a tick apart are justified by almost
 *     exactly the same evidence window, so the second one is not an independent
 *     observation — it is the same bet twice. A minimum tick gap between shots
 *     keeps each shot statistically its own trade.
 *
 * THE PATIENCE VALVE
 * ──────────────────
 * Waiting is only free up to a point. A prime setup that waits forever rots: the
 * regime that justified it ends while the bot is still being picky about the
 * entry tick. So the caller is given `waitTicks` — how long this specific
 * objection has been standing — and is expected to fire anyway once that exceeds
 * `maxWaitTicks`. Timing gates the ENTRY, it never vetoes a conclusive setup.
 *
 * Everything here is a pure function of the digit stream, so the whole layer is
 * unit-testable without a tick feed (`killshot-timing.test.ts`).
 */

export interface TimingInput {
  /** Most-recent-last digit history for the target market. */
  digits: number[];
  /** The digits that WIN the target contract. */
  winSet: ReadonlySet<number>;
  /** Seconds since the last tick arrived on this market (feed freshness). */
  secondsSinceLastTick?: number;
  /** Median inter-tick gap in seconds for this market. */
  medianTickGapSeconds?: number;
  /** Ticks observed since this session's previous shot (Infinity if none). */
  ticksSinceLastShot?: number;
  /** Ticks the current timing objection has already been standing. */
  waitedTicks?: number;
}

export interface TimingComponents {
  /** Win rate over the short confirmation window. */
  shortRate: number;
  /** Win rate over the reference window the edge was measured on. */
  referenceRate: number;
  /** shortRate − referenceRate, in probability points ×100. */
  momentumPP: number;
  /** Ticks since the last winning digit. */
  gapTicks: number;
  /** This contract's own mean win-to-win gap. */
  meanGap: number;
  /** gapTicks / meanGap — the renewal position, 1.0 = exactly due. */
  gapRatio: number;
  /** secondsSinceLastTick / medianTickGapSeconds. */
  feedLagRatio: number;
  /** 0–100 composite. */
  score: number;
}

export interface TimingResult {
  /** True when the entry tick is acceptable. */
  ready: boolean;
  /** 0–100 entry quality. Reported even when not ready. */
  score: number;
  /** Ticks this objection has been standing (echoed from the input). */
  waitTicks: number;
  /** Human-readable reason — shown verbatim in the console. */
  reason: string;
  components: TimingComponents;
}

export const TIMING = {
  /** Short confirmation window — the "is the regime still on?" window. */
  shortWindow: 40,
  /** Reference window the momentum check compares against. */
  referenceWindow: 250,
  /**
   * Momentum tolerance, in standard errors of the short-window rate (1.25σ —
   * a hold should need a genuine signal, not a wobble).
   *
   * A flat point threshold here is a trap: the standard error of a 40-tick rate
   * is 7.9 points at p = 0.5 and 4.7 at p = 0.9, so any fixed cut either never
   * fires or fires on pure sampling noise. The tolerance is therefore scaled by
   * the noise of the baseline it is compared against, with an absolute floor so
   * a very high-rate contract cannot be held for a wobble of one tick.
   */
  momentumSigma: 1.25,
  /** Absolute floor on that tolerance, in probability points. */
  minMomentumPP: 1.5,
  /** Renewal position: fire no sooner than this × the mean gap. */
  minGapRatio: 0.6,
  /** Renewal position: refuse past this × the mean gap (regime has broken). */
  maxGapRatio: 2.2,
  /** Feed may lag the median tick gap by at most this factor. */
  maxFeedLagRatio: 2.5,
  /** Minimum ticks between two shots so each has its own evidence. */
  minTicksBetweenShots: 8,
  /** Composite score an entry must reach. */
  minScore: 55,
  /**
   * Ticks the bot will hold a conclusive setup while waiting for a better entry
   * tick. Past this the shot is taken regardless — timing gates the entry, it
   * never vetoes the setup.
   */
  maxWaitTicks: 45,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rate(wins: number[]): number {
  return wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
}

/**
 * Score the current tick as an entry point for a contract whose evidence stack
 * has ALREADY cleared. Never blocks a setup on its own — see the patience valve.
 */
export function evaluateKillShotTiming(input: TimingInput): TimingResult {
  const {
    digits, winSet,
    secondsSinceLastTick = 0,
    medianTickGapSeconds = 2,
    ticksSinceLastShot = Number.POSITIVE_INFINITY,
    waitedTicks = 0,
  } = input;

  const wins = digits.map(d => (winSet.has(d) ? 1 : 0));

  // ── 1. Momentum: is the measured regime still the live one? ──────────────
  const short = wins.slice(-TIMING.shortWindow);
  const reference = wins.slice(-TIMING.referenceWindow);
  const shortRate = rate(short);
  const referenceRate = rate(reference);
  const momentumPP = (shortRate - referenceRate) * 100;
  // Noise-scaled tolerance: one standard error of the short-window rate at the
  // baseline, floored. Measured against the REFERENCE rate because that is the
  // quantity being tested for a change, and it is the more stable of the two.
  const baseP = clamp(referenceRate, 0.02, 0.98);
  const sigmaPP = 100 * Math.sqrt((baseP * (1 - baseP)) / Math.max(1, short.length || TIMING.shortWindow));
  const momentumTolerance = -Math.max(TIMING.minMomentumPP, TIMING.momentumSigma * sigmaPP);
  const momentumOk = short.length < 10 || momentumPP >= momentumTolerance;
  // Reward a hot short window, punish a cold one, saturating at ±6 points.
  const momentumTerm = clamp(0.5 + momentumPP / 12, 0, 1);

  // ── 2. Renewal position: where are we in this contract's own win gap? ────
  // Rebuild the win-to-win gaps from the stream itself, so the "due" clock is
  // this contract's own history rather than a guessed constant.
  const gaps: number[] = [];
  let since = 0;
  for (const w of wins) {
    since++;
    if (w === 1) { gaps.push(since); since = 0; }
  }
  const meanGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : Math.max(1, 10 / Math.max(1, winSet.size));
  const gapTicks = since;
  const gapRatio = meanGap > 0 ? gapTicks / meanGap : 1;
  // Wide win sets (Over 0–2, Even/Odd) win almost every tick, so their gap
  // structure carries no timing information and must not be allowed to block.
  const gapInformative = winSet.size <= 5 && gaps.length >= 8;
  const gapOk = !gapInformative
    || (gapRatio >= TIMING.minGapRatio && gapRatio <= TIMING.maxGapRatio);
  // Best entry sits near "due" (ratio 1.0); both a just-reset clock and a long
  // drought score lower.
  const gapTerm = gapInformative
    ? clamp(1 - Math.abs(gapRatio - 1) / 1.4, 0, 1)
    : 0.6;

  // ── 3. Feed freshness ────────────────────────────────────────────────────
  const medianGap = Math.max(0.2, medianTickGapSeconds);
  const feedLagRatio = secondsSinceLastTick / medianGap;
  const feedOk = feedLagRatio <= TIMING.maxFeedLagRatio;
  const feedTerm = clamp(1 - Math.max(0, feedLagRatio - 1) / 2, 0, 1);

  // ── 4. Evidence independence between shots ───────────────────────────────
  const cadenceOk = ticksSinceLastShot >= TIMING.minTicksBetweenShots;
  const cadenceTerm = clamp(ticksSinceLastShot / TIMING.minTicksBetweenShots, 0, 1);

  const score = Math.round(clamp(
    100 * (0.40 * momentumTerm + 0.30 * gapTerm + 0.15 * feedTerm + 0.15 * cadenceTerm),
    0, 100,
  ));

  const components: TimingComponents = {
    shortRate: Math.round(shortRate * 1e4) / 1e4,
    referenceRate: Math.round(referenceRate * 1e4) / 1e4,
    momentumPP: Math.round(momentumPP * 100) / 100,
    gapTicks,
    meanGap: Math.round(meanGap * 100) / 100,
    gapRatio: Math.round(gapRatio * 100) / 100,
    feedLagRatio: Math.round(feedLagRatio * 100) / 100,
    score,
  };

  // The patience valve: a conclusive setup is taken even on a mediocre tick
  // once the objection has been standing long enough.
  const patienceExhausted = waitedTicks >= TIMING.maxWaitTicks;

  const objection = !cadenceOk
    ? `re-spacing shots — ${ticksSinceLastShot}/${TIMING.minTicksBetweenShots} ticks of fresh evidence`
    : !feedOk
      ? `tick feed lagging (${feedLagRatio.toFixed(1)}× the median gap) — entry spot would be stale`
      : !momentumOk
        ? `last ${short.length} ticks running ${Math.abs(momentumPP).toFixed(1)}pp colder than the measured regime (tolerance ${Math.abs(momentumTolerance).toFixed(1)}pp)`
        : !gapOk
          ? (gapRatio < TIMING.minGapRatio
              ? `contract paid ${gapTicks} tick(s) ago — the renewal clock just reset (needs ≥${TIMING.minGapRatio}× the ${meanGap.toFixed(1)}-tick mean gap)`
              : `${gapTicks}-tick drought is ${gapRatio.toFixed(1)}× the mean gap — regime has likely broken`)
          : score < TIMING.minScore
            ? `entry quality ${score}/100 is below the ${TIMING.minScore} bar`
            : null;

  if (!objection || patienceExhausted) {
    return {
      ready: true,
      score,
      waitTicks: waitedTicks,
      reason: patienceExhausted && objection
        ? `Taking the shot — the setup has been conclusive for ${waitedTicks} ticks and timing will not improve it (entry quality ${score}/100).`
        : `Entry tick accepted — momentum ${momentumPP >= 0 ? "+" : ""}${momentumPP.toFixed(1)}pp, renewal ${gapRatio.toFixed(2)}× mean gap, quality ${score}/100.`,
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
