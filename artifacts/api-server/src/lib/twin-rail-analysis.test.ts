/**
 * Twin-Rail Sentinel — analysis tests.
 *
 * The bot's whole claim is arithmetic, so the arithmetic is what is tested:
 *
 *  1. THE INVARIANT — Over 4 + Under 5 partitions the digits, so exactly one leg
 *     wins on a shared tick and a double loss is impossible; Over 5 + Under 4
 *     has a two-digit dead rail where BOTH legs lose.
 *  2. THE THEOREM — a straddle's expected value is −2m·S per round for ANY digit
 *     distribution and ANY barriers, so the normal rail returns S(p − 2) = −0.05·S
 *     at 1.95× on every single round. No gate can make it positive, and this test
 *     is the proof that the agent's own console copy is honest about it.
 *  3. THE ONE GATE — the recovery rail becomes +EV exactly when the measured
 *     dead-rail rate falls below the rate the LIVE quotes imply (q* = (p−2)/p,
 *     17.70 % at 2.43×). A fair tape must be refused; a tape with a genuinely
 *     under-populated dead rail must be released.
 *  4. THE SYNC CONTRACT — the pair's own outcome pattern classifies every round
 *     (exactly one winner = synced, both winners = split tick), and the fire
 *     window refuses to start a burst it cannot finish inside one tick.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NORMAL_PAIR,
  RECOVERY_PAIR,
  TWIN_RAIL_FALLBACK_QUOTES,
  buildContextualFrequencies,
  chiSquareUpperTail,
  deadRailBreakEven,
  deadZoneDigits,
  detectDigitMemory,
  estimateFrequencies,
  legBreakEven,
  legDisagreement,
  measurePairEdge,
  normalCdf,
  pairExpectancy,
  pairTable,
  partitionComplete,
  partitionMargin,
  planTwinFire,
  roundLedgerDecision,
  roundOutcome,
  settleIdentity,
  straddleAnalysis,
  syncVerdict,
  type PairQuote,
} from "./twin-rail-analysis.ts";

const NORMAL_QUOTES: PairQuote = TWIN_RAIL_FALLBACK_QUOTES.normal;
const RECOVERY_QUOTES: PairQuote = TWIN_RAIL_FALLBACK_QUOTES.recovery;

/** Deterministic RNG so every "tape" in this file is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Uniform 10-digit tape. */
function uniformTape(n: number, seed = 7): number[] {
  const rand = rng(seed);
  return Array.from({ length: n }, () => Math.floor(rand() * 10));
}

/**
 * A tape in which digits 4 and 5 are UNDER-populated — the structure the bot is
 * hunting for: the dead rail is rarer than the 20 % a fair stream would print.
 */
function skewedTape(n: number, deadShare: number, seed = 11): number[] {
  const rand = rng(seed);
  const outside = [0, 1, 2, 3, 6, 7, 8, 9];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = rand();
    out.push(r < deadShare ? (rand() < 0.5 ? 4 : 5) : outside[Math.floor(rand() * outside.length)]!);
  }
  return out;
}

describe("twin-rail: the partition invariant", () => {
  it("Over 4 + Under 5 partitions the digits — exactly one leg always wins", () => {
    assert.equal(deadZoneDigits(NORMAL_PAIR).length, 0);
    assert.equal(partitionComplete(NORMAL_PAIR), true);
    for (let d = 0; d <= 9; d++) {
      const r = roundOutcome(NORMAL_PAIR, NORMAL_QUOTES, 1, d);
      assert.equal(r.overWon !== r.underWon, true, `digit ${d} must have exactly one winner`);
      assert.equal(syncVerdict(NORMAL_PAIR, r.overWon, r.underWon), "synced");
    }
  });

  it("Over 5 + Under 4 has the dead rail {4,5} where BOTH legs lose", () => {
    assert.deepEqual(deadZoneDigits(RECOVERY_PAIR), [4, 5]);
    assert.equal(partitionComplete(RECOVERY_PAIR), false);
    const table = pairTable(RECOVERY_PAIR, RECOVERY_QUOTES, 1);
    for (const d of [4, 5]) {
      assert.equal(table[d]!.overWon, false);
      assert.equal(table[d]!.underWon, false);
      assert.equal(table[d]!.net, -2);
      assert.equal(syncVerdict(RECOVERY_PAIR, false, false), "dead-rail");
    }
    for (const d of [0, 1, 2, 3, 6, 7, 8, 9]) {
      const r = table[d]!;
      assert.equal(r.overWon !== r.underWon, true);
      assert.equal(r.net, 0.43);
    }
  });
});

describe("twin-rail: the straddle theorem", () => {
  it("the normal rail returns S(p − 2) on EVERY digit — a fixed toll, not a coin flip", () => {
    for (const stake of [0.35, 1, 5, 25]) {
      for (let d = 0; d <= 9; d++) {
        const net = roundOutcome(NORMAL_PAIR, NORMAL_QUOTES, stake, d).net;
        assert.ok(
          Math.abs(net - stake * (NORMAL_QUOTES.overPayout - 2)) < 0.011,
          `digit ${d} at $${stake} gave ${net}`,
        );
      }
    }
    // At the canonical 1.95× quotes that is −5 cents per $1 of leg stake.
    assert.equal(roundOutcome(NORMAL_PAIR, NORMAL_QUOTES, 1, 3).net, -0.05);
    assert.equal(roundOutcome(NORMAL_PAIR, NORMAL_QUOTES, 1, 8).net, -0.05);
  });

  it("the toll is independent of the digit distribution (−2m per round)", () => {
    const uniform = estimateFrequencies(uniformTape(4000), NORMAL_PAIR);
    const skewed = estimateFrequencies(skewedTape(4000, 0.1), NORMAL_PAIR);
    const a = pairExpectancy(NORMAL_PAIR, NORMAL_QUOTES, 1, uniform.mean).mean;
    const b = pairExpectancy(NORMAL_PAIR, NORMAL_QUOTES, 1, skewed.mean).mean;
    assert.ok(Math.abs(a - b) < 0.011, `${a} vs ${b}`);
    assert.ok(a < 0, "the normal rail can never be positive");
  });

  it("the quoted margin on the partition pair is 2.5% per leg and 5% per round", () => {
    const m = partitionMargin(NORMAL_QUOTES);
    assert.ok(Math.abs(m - 0.025) < 1e-9);
    const analysis = straddleAnalysis(NORMAL_QUOTES);
    assert.ok(Math.abs(analysis.marginPerRoundPerStake - 0.05) < 1e-9);
    assert.ok(Math.abs(analysis.impliedOverWin - 0.5) < 1e-9);
  });

  it("a leg's break-even win rate is 1/p — 41.15% for Over 5 at 2.43×", () => {
    assert.ok(Math.abs(legBreakEven(2.43) - 0.411523) < 1e-5);
    assert.ok(Math.abs(legBreakEven(1.95) - 0.512821) < 1e-5);
    // A leg priced exactly at its fair rate has zero disagreement.
    assert.ok(Math.abs(legDisagreement(2.5, 0.4)) < 1e-12);
    assert.ok(legDisagreement(2.43, 0.42) > 0, "a genuinely more-frequent win is +EV");
  });
});

describe("twin-rail: the dead-rail quota", () => {
  it("q* = (p − 2)/p — 17.70% at 2.43×", () => {
    const q = deadRailBreakEven(RECOVERY_PAIR, RECOVERY_QUOTES, 1);
    assert.ok(Math.abs(q - 0.43 / 2.43) < 1e-9, `got ${q}`);
    assert.ok(Math.abs(q - 0.176954) < 1e-5);
  });

  it("a margin-free quote tolerates the full 20% dead rail, a worse one less", () => {
    const fair = deadRailBreakEven(RECOVERY_PAIR, { overPayout: 2.5, underPayout: 2.5 }, 1);
    assert.ok(Math.abs(fair - 0.2) < 1e-9);
    const worse = deadRailBreakEven(RECOVERY_PAIR, { overPayout: 2.3, underPayout: 2.3 }, 1);
    assert.ok(worse < fair, "paying less must demand a rarer dead rail");
  });

  it("the partition pair has no break-even dead-rail rate at all", () => {
    assert.equal(deadRailBreakEven(NORMAL_PAIR, NORMAL_QUOTES, 1), 0);
  });
});

describe("twin-rail: the one gate", () => {
  it("refuses a fair tape — a 20% dead rail cannot pay a 2.43× quote", () => {
    const tape = estimateFrequencies(uniformTape(4999), RECOVERY_PAIR);
    const edge = measurePairEdge(RECOVERY_PAIR, RECOVERY_QUOTES, 1, tape);
    assert.ok(edge.deadRate > edge.quota, `${edge.deadRate} should exceed ${edge.quota}`);
    assert.ok(edge.lcb < 0, `a fair tape must not clear the gate (lcb ${edge.lcb})`);
    assert.ok(edge.mean < 0);
    assert.equal(edge.verdict, "refused");
    assert.ok(edge.pPositive < 0.5);
  });

  it("refuses a 19% dead rail — a 1 point skew is not enough at 2.43×", () => {
    const tape = estimateFrequencies(skewedTape(4999, 0.19), RECOVERY_PAIR);
    const edge = measurePairEdge(RECOVERY_PAIR, RECOVERY_QUOTES, 1, tape);
    assert.ok(edge.lcb <= 0, `lcb ${edge.lcb} should not clear zero (quota ${edge.quota})`);
  });

  it("releases a genuinely under-populated dead rail", () => {
    const tape = estimateFrequencies(skewedTape(6000, 0.13), RECOVERY_PAIR);
    const edge = measurePairEdge(RECOVERY_PAIR, RECOVERY_QUOTES, 1, tape);
    assert.ok(edge.deadRate < edge.quota, `${edge.deadRate} vs quota ${edge.quota}`);
    assert.ok(edge.lcb > 0, `a 13% dead rail at 2.43× must clear the gate (lcb ${edge.lcb})`);
    assert.equal(edge.verdict === "certified" || edge.verdict === "qualified", true);
    assert.ok(edge.pPositive > 0.95);
    assert.ok(edge.winNet > 0 && edge.deadNet === -2);
  });

  it("the same tape refuses the NORMAL rail at 1.95× — the theorem, restated", () => {
    const tape = estimateFrequencies(skewedTape(6000, 0.05), NORMAL_PAIR);
    const edge = measurePairEdge(NORMAL_PAIR, NORMAL_QUOTES, 1, tape);
    // Even with a 5% dead rail (which the normal pair does not even have) the
    // partition straddle returns the quoted toll, never a profit.
    assert.ok(Math.abs(edge.mean - (-0.05)) < 0.011, `mean ${edge.mean}`);
    assert.ok(edge.lcb < 0);
  });
});

describe("twin-rail: contextual conditioning", () => {
  it("an i.i.d. tape shows no memory and is left unconditioned", () => {
    const memory = detectDigitMemory(uniformTape(4000, 3));
    assert.equal(memory.order, 0);
    assert.ok(memory.p > 0.01, `p=${memory.p}`);
  });

  it("a planted transition bias is detected and the condition moves the estimate", () => {
    // After a 7 the stream avoids the dead rail; everywhere else it is uniform.
    const rand = rng(5);
    const tape: number[] = [];
    for (let i = 0; i < 6000; i++) {
      const prev = tape[i - 1];
      const r = rand();
      tape.push(prev === 7
        ? [0, 1, 2, 3, 6, 7, 8, 9][Math.floor(r * 8)]!
        : Math.floor(r * 10));
    }
    const memory = detectDigitMemory(tape);
    assert.equal(memory.order, 1, `p=${memory.p} χ²=${memory.chi2}`);

    const marginal = estimateFrequencies(tape, RECOVERY_PAIR);
    const conditioned = buildContextualFrequencies(tape, RECOVERY_PAIR, 1, 7);
    assert.ok(conditioned.context.contextSamples > 300, `context obs ${conditioned.context.contextSamples}`);
    assert.ok(conditioned.context.mixing > 0.8, `mixing ${conditioned.context.mixing}`);
    assert.ok(
      conditioned.deadRate < marginal.deadRate,
      `conditioned ${conditioned.deadRate} should be below marginal ${marginal.deadRate}`,
    );
    // Frequencies must stay a distribution.
    const sum = conditioned.mean.reduce((s, m) => s + m, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it("a thin context is shrunk toward the marginal instead of trusted", () => {
    // Digit 9 appears exactly twice in four thousand ticks, so the "after 9"
    // conditional has two observations and must be almost entirely shrunk away.
    const tape: number[] = [];
    for (let i = 0; i < 4000; i++) {
      tape.push(i === 100 || i === 2000 ? 9 : i % 9);
    }
    const thin = buildContextualFrequencies(tape, RECOVERY_PAIR, 1, 9);
    assert.ok(thin.context.contextSamples <= 2, `context obs ${thin.context.contextSamples}`);
    assert.ok(thin.context.mixing < 0.05, `mixing ${thin.context.mixing}`);
    const marginal = estimateFrequencies(tape, RECOVERY_PAIR);
    assert.ok(Math.abs(thin.deadRate - marginal.deadRate) < 0.02);
  });
});

describe("twin-rail: the same-tick contract", () => {
  it("classifies every round from its own two outcomes", () => {
    assert.equal(syncVerdict(NORMAL_PAIR, true, false), "synced");
    assert.equal(syncVerdict(NORMAL_PAIR, false, true), "synced");
    // Both won is impossible on one tick, on either rail — a desync signature.
    assert.equal(syncVerdict(NORMAL_PAIR, true, true), "split-tick");
    assert.equal(syncVerdict(RECOVERY_PAIR, true, true), "split-tick");
    // Both lost is the dead rail on recovery, and a desync on the normal rail.
    assert.equal(syncVerdict(RECOVERY_PAIR, false, false), "dead-rail");
    assert.equal(syncVerdict(NORMAL_PAIR, false, false), "split-tick");
  });

  it("two legs on one tick must share an exit spot", () => {
    assert.deepEqual(settleIdentity(1234.567, 1234.567), { sameTick: true, delta: 0 });
    const split = settleIdentity(1234.567, 1234.601);
    assert.equal(split.sameTick, false);
    assert.ok(split.delta > 0);
    assert.equal(settleIdentity(0, 1234.5).sameTick, false, "a missing spot cannot prove sync");
  });

  it("fires on a fresh tick with the whole period as budget", () => {
    const plan = planTwinFire({ tickPeriodMs: 2000, tickAgeMs: 50, rttP95Ms: 400, safetyMs: 250 });
    assert.equal(plan.fire, true);
    assert.equal(plan.waitMs, 0);
    assert.ok(plan.headroomMs > 1900);
  });

  it("refuses to start a burst it cannot finish inside the tick", () => {
    // 300 ms left in the window, a 400 ms burst + 250 ms safety → wait.
    const plan = planTwinFire({ tickPeriodMs: 2000, tickAgeMs: 1700, rttP95Ms: 400, safetyMs: 250 });
    assert.equal(plan.fire, false);
    assert.ok(plan.waitMs > 0);
    assert.match(plan.reason, /waiting for the next one/i);
  });

  it("fires anyway when there is no measurable clock, and says so", () => {
    const plan = planTwinFire({ tickPeriodMs: 0, tickAgeMs: 900, rttP95Ms: 0 });
    assert.equal(plan.fire, true);
    assert.match(plan.reason, /No tick clock/i);
  });
});

describe("twin-rail: the recovery trigger", () => {
  it("pair-loss escalates on any negative round, including a split tick", () => {
    const escalated = roundLedgerDecision({
      net: -0.05, overWon: true, underWon: false, sync: "synced", policy: "pair-loss",
    });
    assert.equal(escalated.recovery, true);
    const deadRail = roundLedgerDecision({
      net: -2, overWon: false, underWon: false, sync: "dead-rail", policy: "pair-loss",
    });
    assert.equal(deadRail.recovery, true);
    assert.match(deadRail.reason, /Both legs lost/);
    const winner = roundLedgerDecision({
      net: 0.43, overWon: true, underWon: false, sync: "synced", policy: "pair-loss",
    });
    assert.equal(winner.recovery, false);
  });

  it("both-legs is the literal rule: only a real double loss escalates", () => {
    const toll = roundLedgerDecision({
      net: -0.05, overWon: true, underWon: false, sync: "synced", policy: "both-legs",
    });
    assert.equal(toll.recovery, false, "a one-leg win cannot trigger the strict rule");
    const double = roundLedgerDecision({
      net: -2, overWon: false, underWon: false, sync: "split-tick", policy: "both-legs",
    });
    assert.equal(double.recovery, true);
  });
});

describe("twin-rail: numerics", () => {
  it("normalCdf matches the 95% one-sided point", () => {
    assert.ok(Math.abs(normalCdf(1.645) - 0.95) < 1e-3);
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
    assert.ok(normalCdf(-10) < 1e-6 && normalCdf(10) > 0.999999);
  });

  it("the chi-square upper tail matches the 9-df 5% critical value", () => {
    assert.ok(Math.abs(chiSquareUpperTail(16.919, 9) - 0.05) < 5e-4);
    assert.ok(Math.abs(chiSquareUpperTail(81, 81) - 0.48) < 0.02);
    assert.equal(chiSquareUpperTail(0, 9), 1);
  });

  it("the frequency estimate is a proper distribution with Jeffreys smoothing", () => {
    const tape = estimateFrequencies([0, 0, 0, 0], RECOVERY_PAIR);
    assert.equal(tape.samples, 4);
    const sum = tape.mean.reduce((s, m) => s + m, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.ok(tape.mean[0]! > tape.mean[9]!, "observed digits outrank unobserved ones");
    assert.ok(tape.mean[9]! > 0, "an unobserved digit still carries Jeffreys mass");
  });

  it("an all-dead-rail tape still cannot promise the impossible", () => {
    const tape = estimateFrequencies([4, 5, 4, 5, 4, 5], RECOVERY_PAIR);
    const edge = measurePairEdge(RECOVERY_PAIR, RECOVERY_QUOTES, 1, tape);
    assert.equal(edge.deadRate > 0.99, false, "smoothing keeps a floor under the other digits");
    assert.ok(edge.lcb < -1, "and the gate refuses it decisively");
  });
});
