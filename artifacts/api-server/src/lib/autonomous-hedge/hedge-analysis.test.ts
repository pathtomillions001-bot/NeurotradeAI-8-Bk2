import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyseHedgeCandidate,
  buildMarketCandidates,
  candidateKey,
  hedgePayout,
  hedgeWinStream,
  resolveAutoDigit,
} from "./hedge-analysis";
import { HEDGE_LIMITS } from "./constants";
import { OVER_PAYOUTS, EVEN_ODD_PAYOUT, RISE_FALL_PAYOUT, MATCH_PAYOUT, DIFF_PAYOUT } from "../payouts";

/** Period-5 pattern with four wins and one loss: a real, isolated-loss edge. */
function edgeWins(n: number): boolean[] {
  return Array.from({ length: n }, (_, i) => i % 5 !== 4);
}

/** Period-4 pattern: losses are isolated, so loss→loss transitions are absent. */
function isolatedLossWins(n: number): boolean[] {
  return Array.from({ length: n }, (_, i) => i % 4 !== 3);
}

/** Period-10 pattern with three losses in a row: losses cluster. */
function clusteredLossWins(n: number): boolean[] {
  return Array.from({ length: n }, (_, i) => i % 10 < 7);
}

/** A flat hit rate of `rate` over `n` ticks, spread evenly. */
function rateWins(n: number, rate: number): boolean[] {
  const hits = Math.round(n * rate);
  return Array.from({ length: n }, (_, i) => i < hits);
}

describe("autonomous hedge analysis", () => {
  it("pays the canonical table values per family", () => {
    assert.equal(hedgePayout("DIGITOVER", 4), OVER_PAYOUTS[4]);
    assert.equal(hedgePayout("DIGITEVEN", -1), EVEN_ODD_PAYOUT);
    assert.equal(hedgePayout("DIGITODD", -1), EVEN_ODD_PAYOUT);
    assert.equal(hedgePayout("CALL", -1), RISE_FALL_PAYOUT);
    assert.equal(hedgePayout("PUT", -1), RISE_FALL_PAYOUT);
    assert.equal(hedgePayout("DIGITMATCH", 3), MATCH_PAYOUT);
    assert.equal(hedgePayout("DIGITDIFF", 3), DIFF_PAYOUT);
  });

  it("resolves the auto digit for Matches (most frequent) and Differs (least frequent)", () => {
    const digits = [1, 1, 1, 4, 4, 9, 2, 2, 2, 2];
    assert.equal(resolveAutoDigit("DIGITMATCH", -1, digits), 2);
    assert.equal(resolveAutoDigit("DIGITDIFF", -1, digits), 0);
    assert.equal(resolveAutoDigit("DIGITMATCH", 7, digits), 7, "an explicit digit is never overridden");
  });

  it("builds Over/Under win streams exactly as the Nexus runtime does", () => {
    const digits = [0, 3, 5, 9];
    const over = hedgeWinStream({ type: "DIGITOVER", barrier: 2 }, digits, digits.map(() => 1));
    assert.deepEqual(over?.wins, [false, true, true, true]);
    assert.equal(over?.p0, 0.7);
    const under = hedgeWinStream({ type: "DIGITUNDER", barrier: 5 }, digits, digits.map(() => 1));
    assert.deepEqual(under?.wins, [true, true, false, false]);
    assert.equal(under?.p0, 0.5);
    assert.equal(hedgeWinStream({ type: "DIGITOVER", barrier: 9 }, digits, digits.map(() => 1)), null, "Over 9 is impossible");
    assert.equal(hedgeWinStream({ type: "DIGITUNDER", barrier: 0 }, digits, digits.map(() => 1)), null, "Under 0 is impossible");
  });

  it("uses the Nexus direction placeholder for CALL and PUT", () => {
    const prices = [10, 11, 10, 10];
    const call = hedgeWinStream({ type: "CALL", barrier: -1 }, [0, 1, 0, 0], prices);
    const put = hedgeWinStream({ type: "PUT", barrier: -1 }, [0, 1, 0, 0], prices);
    assert.deepEqual(call?.wins, [false, true, false, false]);
    assert.deepEqual(put?.wins, [false, false, true, false]);
  });

  it("keeps probability and bounds consistent and computes EV from the payout", () => {
    const stats = analyseHedgeCandidate({ wins: edgeWins(120), p0: 0.5, payout: 1.9, mode: "NORMAL" });
    assert.ok(stats.probability > 0 && stats.probability < 1);
    assert.ok(stats.lowerBound <= stats.probability);
    assert.ok(Math.abs(stats.ev - (stats.probability * 1.9 - 1)) < 1e-12);
    assert.equal(stats.samples, 120);
    assert.equal(stats.losses, 24);
  });

  it("is eligible on a real edge in normal mode and rejects thin samples", () => {
    const strong = analyseHedgeCandidate({ wins: edgeWins(120), p0: 0.5, payout: 1.9, mode: "NORMAL" });
    assert.equal(strong.eligible, true);
    const thin = analyseHedgeCandidate({ wins: edgeWins(HEDGE_LIMITS.normal.minSamples - 1), p0: 0.5, payout: 1.9, mode: "NORMAL" });
    assert.equal(thin.eligible, false, "normal needs the full sample minimum");
  });

  it("rejects a candidate whose payout does not beat its break-even", () => {
    const stats = analyseHedgeCandidate({ wins: edgeWins(120), p0: 0.5, payout: 1.1, mode: "NORMAL" });
    assert.equal(stats.eligible, false);
    assert.ok(stats.ev < 0);
  });

  it("accepts fewer samples in recovery, which has the looser gate", () => {
    const wins = edgeWins(HEDGE_LIMITS.recovery.minSamples + 5);
    const recovery = analyseHedgeCandidate({ wins, p0: 0.5, payout: 1.9, mode: "RECOVERY" });
    assert.equal(recovery.eligible, true);
  });

  it("reports the posterior edge probability and the three-loss stress indicator", () => {
    const stats = analyseHedgeCandidate({ wins: edgeWins(120), p0: 0.5, payout: 1.9, mode: "RECOVERY" });
    assert.ok(stats.posteriorEdgeProbability > 0.5, "a strong tape is more likely than not to beat break-even");
    assert.ok(stats.lossRunRisk >= 0 && stats.lossRunRisk <= 1);
    assert.ok(stats.recentAfterLoss > 0 && stats.recentAfterLoss < 1);
    assert.equal(stats.riskWeight, 1, "no escalation means the design-document weights");
  });

  it("does not rank a 55% win rate on 20 samples like the same rate on 2,000", () => {
    const thin = analyseHedgeCandidate({ wins: rateWins(20, 0.55), p0: 0.5, payout: 1.9, mode: "RECOVERY" });
    const deep = analyseHedgeCandidate({ wins: rateWins(2000, 0.55), p0: 0.5, payout: 1.9, mode: "RECOVERY" });
    assert.ok(
      deep.posteriorEdgeProbability > thin.posteriorEdgeProbability,
      "posterior uncertainty must discount a small recovery sample",
    );
  });

  it("penalises recovery candidates with clustered future losses", () => {
    const stable = analyseHedgeCandidate({ wins: isolatedLossWins(120), p0: 0.5, payout: 1.9, mode: "RECOVERY" });
    const clustered = analyseHedgeCandidate({ wins: clusteredLossWins(120), p0: 0.5, payout: 1.9, mode: "RECOVERY" });
    assert.ok(clustered.lossRunRisk > stable.lossRunRisk, "R3L must rise when losses follow losses");
    assert.ok(clustered.score < stable.score, "the stress indicator must lower the recovery score");
  });

  it("widens the recovery gap as the loss run deepens, without moving eligibility", () => {
    const strong = edgeWins(120);
    const clustered = clusteredLossWins(120);
    const analyse = (wins: boolean[], escalation: number) =>
      analyseHedgeCandidate({ wins, p0: 0.5, payout: 1.9, mode: "RECOVERY", escalation });

    const calmGap = analyse(strong, 0).score - analyse(clustered, 0).score;
    const deepGap = analyse(strong, 6).score - analyse(clustered, 6).score;
    assert.ok(deepGap > calmGap, "a deeper run must separate the well-evidenced candidate further");
    assert.equal(analyse(strong, 6).riskWeight, 1 + HEDGE_LIMITS.recovery.riskWeightMax);
    assert.equal(
      analyse(strong, 99).riskWeight,
      1 + HEDGE_LIMITS.recovery.riskWeightMax,
      "the weight is bounded at the escalation cap",
    );
    assert.equal(analyse(strong, 6).eligible, analyse(strong, 0).eligible, "escalation re-ranks, it never gates");
  });

  it("leaves the normal-mode score untouched by the loss run", () => {
    const calm = analyseHedgeCandidate({ wins: edgeWins(120), p0: 0.5, payout: 1.9, mode: "NORMAL", escalation: 0 });
    const deep = analyseHedgeCandidate({ wins: edgeWins(120), p0: 0.5, payout: 1.9, mode: "NORMAL", escalation: 6 });
    assert.equal(calm.score, deep.score, "normal ranking keeps the pre-existing base score");
    assert.equal(deep.riskWeight, 1);
  });

  it("builds candidate rows with stable keys and a per-tick identity", () => {
    const digits = Array.from({ length: 120 }, (_, i) => (i * 7) % 10);
    const prices = digits.map((d, i) => 100 + (i % 3) * 0.01 + d * 0.001);
    const rows = buildMarketCandidates({
      symbol: "R_100",
      group: 1,
      digits,
      prices,
      tickSequence: 555,
      specs: [
        { type: "DIGITMATCH", barrier: -1 },
        { type: "DIGITOVER", barrier: 2 },
        { type: "CALL", barrier: -1 },
      ],
      mode: "NORMAL",
    });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.group === 1 && r.tickSequence === 555 && r.symbol === "R_100"));
    const match = rows.find((r) => r.contract === "DIGITMATCH");
    assert.ok(match);
    assert.equal(match.barrier >= 0 && match.barrier <= 9, true, "auto digit is resolved");
    assert.equal(match.key, candidateKey("R_100", "DIGITMATCH", match.barrier));
  });

  it("returns no candidates for a tape too thin to rank", () => {
    const rows = buildMarketCandidates({
      symbol: "1HZ100V",
      group: 0,
      digits: [1, 2, 3],
      prices: [1, 2, 3],
      tickSequence: 1,
      specs: [{ type: "CALL", barrier: -1 }],
      mode: "NORMAL",
    });
    assert.deepEqual(rows, []);
  });
});
