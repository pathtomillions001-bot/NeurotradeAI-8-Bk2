import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  calculateRecoveryV2Stake,
  effectiveSampleSize,
  evaluateRecoveryCandidates,
  isRecoveryDecisionV2Enabled,
  mergeRecoveryHistory,
  priceRecoveryCandidate,
  recoveryExecutionProposalRejection,
  recoveryFeedRejection,
  recoveryHypothesisCount,
  standardNormalQuantile,
  type RecoveryMarketSample,
} from "./recovery-decision-v2.ts";
import type { DigitSnapshot, DigitTick } from "./digit-tape.ts";

const originalRecoveryFlag = process.env.AUTONOMOUS_RECOVERY_V2;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function samplePrice(digit: number): number {
  return 100 + digit / 10;
}

function hotOverFourSamples(count: number, seed = 192): RecoveryMarketSample[] {
  const rng = random(seed);
  return Array.from({ length: count }, (_, index) => {
    // 75% of samples are winning digits, 25% are losing digits.
    const digit = rng() < 0.75
      ? 5 + Math.floor(rng() * 5)
      : Math.floor(rng() * 5);
    return { epoch: index + 1, price: samplePrice(digit), digit };
  });
}

function makeLiveSnapshot(now = Date.now()): DigitSnapshot {
  const baseEpoch = Math.floor(now / 1_000) - 9;
  const liveTicks: DigitTick[] = [];
  for (let i = 8; i <= 9; i++) {
    const digit = i % 10;
    liveTicks.push({
      symbol: "R_10",
      sequence: i + 1,
      generation: 2,
      source: "live",
      epoch: baseEpoch + i,
      receivedAt: now - (9 - i) * 1_000,
      digit,
      price: samplePrice(digit),
    });
  }
  return { tick: liveTicks[liveTicks.length - 1]!, ticks: liveTicks };
}

afterEach(() => {
  if (originalRecoveryFlag === undefined) delete process.env.AUTONOMOUS_RECOVERY_V2;
  else process.env.AUTONOMOUS_RECOVERY_V2 = originalRecoveryFlag;
});

describe("recovery decision v2", () => {
  it("is enabled by default and can be rolled back with the environment flag", () => {
    delete process.env.AUTONOMOUS_RECOVERY_V2;
    assert.equal(isRecoveryDecisionV2Enabled(), true);
    for (const value of ["false", "0", "off", "no", "disabled"]) {
      assert.equal(isRecoveryDecisionV2Enabled(value), false);
    }
    for (const value of ["true", "1", "yes", "on"]) {
      assert.equal(isRecoveryDecisionV2Enabled(value), true);
    }
    assert.equal(isRecoveryDecisionV2Enabled("typo"), false);
  });

  it("uses a high-accuracy normal quantile for multiple-test confidence bounds", () => {
    assert.ok(Math.abs(standardNormalQuantile(0.975) - 1.9599639845) < 1e-7);
    assert.equal(recoveryHypothesisCount(1, ["DIGITOVER", "DIGITMATCH"]), 11);
  });

  it("rejects simulated, stale, mixed-generation, and malformed live snapshots", () => {
    const now = Date.now();
    const live = makeLiveSnapshot(now);
    assert.equal(recoveryFeedRejection(live, now, 6_000), null);
    assert.equal(recoveryFeedRejection(live, now + 10_000, 6_000), "live_tick_stale");

    const simulated = {
      ...live,
      tick: { ...live.tick, source: "simulated" as const },
      ticks: live.ticks.map((tick) => ({ ...tick, source: "simulated" as const })),
    };
    assert.equal(recoveryFeedRejection(simulated, now, 6_000), "feed_not_live");

    const mixed = {
      ...live,
      ticks: [live.ticks[0]!, { ...live.tick, generation: 1 }],
    };
    assert.equal(recoveryFeedRejection(mixed, now, 6_000), "mixed_or_malformed_live_tape");
  });

  it("merges broker history by timestamp and refuses conflicting or simulated provenance", () => {
    const now = Date.now();
    const snapshot = makeLiveSnapshot(now);
    const baseEpoch = snapshot.tick.epoch - 9;
    const digits = Array.from({ length: 10 }, (_, index) => index);
    const history = {
      prices: digits.map(samplePrice),
      times: digits.map((_, index) => baseEpoch + index),
    };
    const merged = mergeRecoveryHistory(history, snapshot, 1, 1_000, 20);
    assert.equal(merged.length, 10);
    assert.equal(merged.at(-1)?.epoch, snapshot.tick.epoch);
    assert.deepEqual(merged.map((sample) => sample.digit), digits);

    const conflicting = {
      ...history,
      prices: history.prices.map((price, index) => index === 9 ? Number(price) + 1 : price),
    };
    assert.throws(
      () => mergeRecoveryHistory(conflicting, snapshot, 1, 1_000, 20),
      /broker_history_disagrees_with_live_tape/,
    );
    assert.throws(
      () => mergeRecoveryHistory(null, {
        ...snapshot,
        tick: { ...snapshot.tick, source: "simulated" },
        ticks: snapshot.ticks.map((tick) => ({ ...tick, source: "simulated" })),
      }, 1, 1_000, 20),
      /feed_not_live/,
    );
  });

  it("matches the configured expiry horizon instead of using a one-tick proxy", () => {
    const samples = Array.from({ length: 401 }, (_, index) => ({
      epoch: index + 1,
      price: 100 + index,
      digit: index % 10,
    }));
    const candidate = evaluateRecoveryCandidates({
      symbol: "R_10",
      samples,
      contractTypes: ["CALL"],
      recoveryOverBarrier: 4,
      recoveryUnderBarrier: 5,
      durationFor: () => 2,
      hypothesisCount: 1,
      sourceGeneration: 2,
      latestSequence: 401,
      latestReceivedAt: Date.now(),
    })[0]!;
    assert.equal(candidate.duration, 2);
    assert.equal(candidate.sampleSize, 200);
    assert.ok(candidate.winProbability > 0.5);
    // A constant winning stream is explicitly discounted because dependence
    // cannot be estimated from a zero-variance Bernoulli series.
    assert.ok(candidate.effectiveSampleSize < 100);
    assert.equal(candidate.rejectionReason, "insufficient_effective_samples");
  });

  it("shrinks estimates toward theory, corrects for scanning, and requires positive conservative EV", () => {
    const samples = hotOverFourSamples(4_000);
    const single = evaluateRecoveryCandidates({
      symbol: "R_10",
      samples,
      contractTypes: ["DIGITOVER"],
      recoveryOverBarrier: 4,
      recoveryUnderBarrier: 5,
      durationFor: () => 1,
      hypothesisCount: 1,
      sourceGeneration: 2,
      latestSequence: 4_000,
      latestReceivedAt: Date.now(),
    })[0]!;
    const multiple = evaluateRecoveryCandidates({
      symbol: "R_10",
      samples,
      contractTypes: ["DIGITOVER"],
      recoveryOverBarrier: 4,
      recoveryUnderBarrier: 5,
      durationFor: () => 1,
      hypothesisCount: 200,
      sourceGeneration: 2,
      latestSequence: 4_000,
      latestReceivedAt: Date.now(),
    })[0]!;
    assert.ok(single.lowerWinProbability > multiple.lowerWinProbability);

    const priced = priceRecoveryCandidate(multiple, 1.95, "live");
    assert.equal(priced.accepted, true);
    assert.ok((priced.lowerExpectedValue ?? 0) > 0.01);
    const fallback = priceRecoveryCandidate(multiple, 1.95, "fallback");
    assert.equal(fallback.accepted, false);
    assert.equal(fallback.rejectionReason, "live_payout_unavailable");

    const fairSamples = Array.from({ length: 3_000 }, (_, index) => {
      const digit = index % 10;
      return { epoch: index + 1, price: samplePrice(digit), digit };
    });
    const fair = evaluateRecoveryCandidates({
      symbol: "R_25",
      samples: fairSamples,
      contractTypes: ["DIGITOVER"],
      recoveryOverBarrier: 3,
      recoveryUnderBarrier: 6,
      durationFor: () => 1,
      hypothesisCount: 200,
      sourceGeneration: 1,
      latestSequence: 3_000,
      latestReceivedAt: Date.now(),
    })[0]!;
    const fairPriced = priceRecoveryCandidate(fair, 1.63, "live");
    assert.equal(fairPriced.accepted, false);
    assert.equal(fairPriced.rejectionReason, "lower_confidence_ev_below_minimum");
  });

  it("reduces effective sample size for positively correlated outcomes", () => {
    const independentAlternation = Array.from({ length: 400 }, (_, index) => index % 2 === 0);
    const clustered = Array.from({ length: 400 }, (_, index) => Math.floor(index / 20) % 2 === 0);
    assert.ok(effectiveSampleSize(clustered) < effectiveSampleSize(independentAlternation));
  });

  it("sizes only from conservative edge and caps risk independently of debt", () => {
    const stats = evaluateRecoveryCandidates({
      symbol: "R_10",
      samples: hotOverFourSamples(4_000),
      contractTypes: ["DIGITOVER"],
      recoveryOverBarrier: 4,
      recoveryUnderBarrier: 5,
      durationFor: () => 1,
      hypothesisCount: 1,
      sourceGeneration: 2,
      latestSequence: 4_000,
      latestReceivedAt: Date.now(),
    })[0]!;
    const candidate = priceRecoveryCandidate(stats, 1.95, "live");
    assert.equal(candidate.accepted, true);
    const sized = calculateRecoveryV2Stake({ candidate, balance: 1_000, baseStake: 25, maxTradeStake: 100, unrecoveredDebt: 50 });
    assert.equal(sized.stake, 5);
    assert.ok(sized.stake <= 1_000 * 0.005);
    assert.ok(sized.stake <= 25);
    assert.ok(sized.stake <= 50);

    const debtCapped = calculateRecoveryV2Stake({ candidate, balance: 1_000, baseStake: 25, maxTradeStake: 100, unrecoveredDebt: 0.4 });
    assert.equal(debtCapped.stake, 0.4);
    assert.ok(debtCapped.stake <= 0.4);
    const configuredRiskCapped = calculateRecoveryV2Stake({
      candidate, balance: 1_000, baseStake: 25, maxTradeStake: 100,
      maxRiskPerTrade: 0.4, unrecoveredDebt: 50,
    });
    assert.equal(configuredRiskCapped.stake, 0.4);

    const tooSmall = calculateRecoveryV2Stake({ candidate, balance: 10, baseStake: 1, maxTradeStake: 100, unrecoveredDebt: 5 });
    assert.equal(tooSmall.stake, 0);
    assert.equal(tooSmall.reason, "edge_sized_stake_below_minimum");
  });

  it("revalidates actual live payout, feed generation, freshness, and stake cap before buy", () => {
    const now = Date.now();
    const tick = makeLiveSnapshot(now).tick;
    const guard = {
      lowerWinProbability: 0.7,
      minimumExpectedValue: 0.01,
      maxStake: 1,
      expectedGeneration: tick.generation,
      minimumSequence: tick.sequence,
      maxTickAgeMs: 6_000,
    };
    const proposal = { askPrice: 1, payout: 1.95 };
    assert.equal(recoveryExecutionProposalRejection({ guard, proposal, latestTick: tick, now }), null);
    assert.equal(
      recoveryExecutionProposalRejection({ guard, proposal: { askPrice: 1, payout: 1.2 }, latestTick: tick, now }),
      "live_quote_ev_below_minimum",
    );
    assert.equal(
      recoveryExecutionProposalRejection({ guard, proposal: { askPrice: 1.01, payout: 1.95 }, latestTick: tick, now }),
      "live_ask_exceeds_risk_cap",
    );
    assert.equal(
      recoveryExecutionProposalRejection({ guard, proposal, latestTick: { ...tick, generation: 3 }, now }),
      "execution_feed_generation_changed",
    );
    assert.equal(
      recoveryExecutionProposalRejection({ guard, proposal, latestTick: { ...tick, receivedAt: now - 10_000 }, now }),
      "execution_feed_stale",
    );
  });
});
