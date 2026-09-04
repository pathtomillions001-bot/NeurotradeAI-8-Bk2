import { test } from "node:test";
import assert from "node:assert";
import { evaluateKillShotTiming, TIMING } from "./killshot-timing";

// ── Stream builders ───────────────────────────────────────────────────────────

/**
 * A digit stream with a win on a strict `gap`-tick cadence. Every renewal
 * interval is therefore exactly `gap`, so the tests can assert on the resulting
 * position directly instead of guessing at it.
 */
function cadence(len: number, winDigit: number, gap: number, lossDigit = 0): number[] {
  return Array.from({ length: len }, (_, i) => (i % gap === 0 ? winDigit : lossDigit));
}

/**
 * Overwrite the final `n` digits with a LOSING digit — a drought of exactly n
 * ticks. The loss digit has to be named, not derived: 9 is a loss for Over 8 but
 * a win for Over 4, and guessing it silently turns the drought into a hot streak.
 */
function withTailLosses(digits: number[], lossDigit: number, n: number): number[] {
  const out = [...digits];
  for (let i = out.length - n; i < out.length; i++) out[i] = lossDigit;
  return out;
}

/** Over 8 wins on digit 9 only — a narrow win set with a real gap structure. */
const OVER8 = new Set([9]);
/** Over 4 wins on 5–9 — a coin-flip win set, mean gap 2. */
const OVER4 = new Set([5, 6, 7, 8, 9]);
/** Over 2 wins on 3–9 — a wide win set whose gap structure carries no signal. */
const OVER2 = new Set([3, 4, 5, 6, 7, 8, 9]);

const goodFeed = { secondsSinceLastTick: 1, medianTickGapSeconds: 2 };

// ── The accept path ───────────────────────────────────────────────────────────

test("a due contract on a fresh feed with steady momentum is taken", () => {
  // 9 every 10 ticks, last one 9 ticks ago ⇒ renewal position 0.9× the mean
  // gap: close to due without being a drought.
  const digits = cadence(300, 9, 10);
  const t = evaluateKillShotTiming({
    digits, winSet: OVER8, ...goodFeed, ticksSinceLastShot: 40,
  });
  assert.equal(t.ready, true, t.reason);
  assert.ok(t.components.gapRatio >= TIMING.minGapRatio && t.components.gapRatio <= TIMING.maxGapRatio,
    `gapRatio ${t.components.gapRatio}`);
  assert.ok(t.score >= TIMING.minScore, `score ${t.score}`);
});

test("the renewal clock never objects on a wide win set", () => {
  // Six wins then one loss, repeating: an 86% stream whose mean win gap is ~2
  // ticks. The final 5 ticks are losses, so gapRatio is well past the drought
  // ceiling — but on a 7-digit win set the gap clock carries no timing
  // information, so it must never be the reason a shot is held. Momentum may
  // still object to the same stream, and that is a different, legitimate gate:
  // on a high-rate contract the two signals largely coincide, which is exactly
  // why the clock is switched off for wide win sets rather than tuned.
  const base = Array.from({ length: 300 }, (_, i) => (i % 7 === 6 ? 0 : 5));
  const digits = withTailLosses(base, 0, 5);
  const t = evaluateKillShotTiming({
    digits, winSet: OVER2, ...goodFeed, ticksSinceLastShot: 40,
  });
  assert.ok(t.components.gapRatio > TIMING.maxGapRatio,
    `the drought must be real: gapRatio ${t.components.gapRatio}`);
  assert.doesNotMatch(t.reason, /renewal clock|mean gap|drought/,
    `the gap clock must stay silent on a wide win set: ${t.reason}`);

  // The same drought on a NARROW win set is a genuine timing objection.
  const narrow = evaluateKillShotTiming({
    digits: withTailLosses(cadence(300, 9, 10, 0), 0, 25),
    winSet: OVER8, ...goodFeed, ticksSinceLastShot: 40,
  });
  assert.ok(narrow.components.gapRatio > TIMING.maxGapRatio,
    `narrow-stream drought must be real: ${narrow.components.gapRatio}`);
  assert.equal(narrow.ready, false);
});

// ── The four refusals ─────────────────────────────────────────────────────────

test("a regime that has gone cold is held — the measurement is stale", () => {
  const hot = cadence(300, 9, 10);
  // Wipe the last 40 ticks of wins: the short window now reads 0% while the
  // reference window still reads ~10%.
  const cold = hot.map((d, i) => (i >= hot.length - 40 && d === 9 ? 0 : d));
  const t = evaluateKillShotTiming({ digits: cold, winSet: OVER8, ...goodFeed, ticksSinceLastShot: 40 });
  assert.equal(t.ready, false, "a cold short window must hold the shot");
  assert.ok(t.components.momentumPP < TIMING.minMomentumPP, `momentum ${t.components.momentumPP}`);
  assert.match(t.reason, /colder than the measured regime/);
});

test("a contract that just paid is held — the renewal clock has reset", () => {
  // Strict 5/0 alternation ending ON a win: momentum is flat and the mean gap is
  // exactly 2, so the reset clock is the only thing left to object.
  const digits = cadence(301, 5, 2, 0);
  assert.equal(digits[digits.length - 1], 5, "the last tick must be a win");
  const t = evaluateKillShotTiming({ digits, winSet: OVER4, ...goodFeed, ticksSinceLastShot: 40 });
  assert.equal(t.ready, false, "firing straight after a win must be held");
  assert.ok(t.components.gapRatio < TIMING.minGapRatio, `gapRatio ${t.components.gapRatio}`);
  assert.match(t.reason, /renewal clock just reset/);
});

test("a drought far past the mean gap is held — the regime has probably broken", () => {
  const digits = withTailLosses(cadence(300, 5, 2, 0), 0, 8);
  const t = evaluateKillShotTiming({ digits, winSet: OVER4, ...goodFeed, ticksSinceLastShot: 40 });
  assert.equal(t.ready, false, "a long drought must hold the shot");
  assert.ok(t.components.gapRatio > TIMING.maxGapRatio, `gapRatio ${t.components.gapRatio}`);
});

test("a stalled tick feed is held — the entry spot would be stale", () => {
  const digits = cadence(300, 9, 10);
  const t = evaluateKillShotTiming({
    digits, winSet: OVER8,
    secondsSinceLastTick: 60, medianTickGapSeconds: 2,
    ticksSinceLastShot: 40,
  });
  assert.equal(t.ready, false, "a stalled feed must hold the shot");
  assert.ok(t.components.feedLagRatio > TIMING.maxFeedLagRatio, `lag ${t.components.feedLagRatio}`);
  assert.match(t.reason, /tick feed lagging/);
});

test("two shots must be spaced — the same evidence window cannot justify both", () => {
  const digits = cadence(300, 9, 10);
  const t = evaluateKillShotTiming({
    digits, winSet: OVER8, ...goodFeed, ticksSinceLastShot: 2,
  });
  assert.equal(t.ready, false, "an immediate re-fire must be held");
  assert.match(t.reason, /re-spacing shots/);
});

// ── The patience valve ────────────────────────────────────────────────────────

test("a conclusive setup is taken anyway once the objection has stood too long", () => {
  const hot = cadence(300, 9, 10);
  const cold = hot.map((d, i) => (i >= hot.length - 40 && d === 9 ? 0 : d));

  const held = evaluateKillShotTiming({
    digits: cold, winSet: OVER8, ...goodFeed, ticksSinceLastShot: 40, waitedTicks: 0,
  });
  assert.equal(held.ready, false, "sanity: the same stream must be held at first");

  const taken = evaluateKillShotTiming({
    digits: cold, winSet: OVER8, ...goodFeed, ticksSinceLastShot: 40,
    waitedTicks: TIMING.maxWaitTicks,
  });
  assert.equal(taken.ready, true, "the patience valve must release a conclusive setup");
  assert.match(taken.reason, /Taking the shot/);
  assert.ok(taken.score < TIMING.minScore || taken.components.momentumPP < 0,
    "the released shot should still be reported as a mediocre entry");
});

test("the wait counter is echoed back so the console can show it", () => {
  const digits = cadence(300, 5, 2);
  const t = evaluateKillShotTiming({
    digits, winSet: OVER4, ...goodFeed, ticksSinceLastShot: 40, waitedTicks: 7,
  });
  assert.equal(t.waitTicks, 7);
});
