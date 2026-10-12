/**
 * WP2 — quote freshness and stake exactness (D7).
 *
 * Acceptance: simulated quote drift never leaves a "clearing" win short by
 * more than 1 cent per $100 of debt; timeout and fallback paths behave
 * (fallback = table + 2 % safety margin, never an under-sized stake).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  prepareRecoveryBuy,
  resolveRecoveryPayout,
  clearRecoveryQuoteCache,
  FALLBACK_SAFETY_MARGIN,
  PAYOUT_DRIFT_TOLERANCE,
  type ProposalFetcher,
} from "./recovery-payout";
import { getFallbackPayout } from "./payouts";

const base = {
  symbol: "R_100",
  contractType: "DIGITEVEN",
  barrier: null,
  duration: 1,
  durationUnit: "t",
  currency: "USD",
};

function liveFetcher(payout: number, askFor = (stake: number) => stake): ProposalFetcher {
  return async (params) => ({ payoutMultiplier: payout, askPrice: askFor(params.stake) });
}

function timingOutFetcher(): ProposalFetcher {
  return () => new Promise(() => {/* never resolves — the race times it out */});
}

describe("WP2 recovery payout freshness", () => {
  it("resolveRecoveryPayout caches live quotes for at most 3 s", async () => {
    clearRecoveryQuoteCache();
    let calls = 0;
    const fetcher: ProposalFetcher = async (p) => { calls += 1; return { payoutMultiplier: 1.94, askPrice: p.stake }; };
    const first = await resolveRecoveryPayout({ ...base, fetchProposal: fetcher });
    const second = await resolveRecoveryPayout({ ...base, fetchProposal: fetcher });
    assert.equal(first.source, "live");
    assert.equal(calls, 1, "within TTL the cache serves the quote");
    assert.equal(second.payoutMultiplier, 1.94);
    assert.ok(first.takenAt > 0, "live quotes carry their timestamp");
  });

  it("buy plan sizes exactly at the live payout (no drift)", async () => {
    const debt = 100;
    const assumed = 1.95;
    const plan = await prepareRecoveryBuy({
      ...base,
      targetClearance: debt,
      assumedPayout: assumed,
      candidateStake: debt / (assumed - 1),
      fetchProposal: liveFetcher(1.95, (s) => Math.round(s * 100) / 100),
    });
    assert.equal(plan.source, "live");
    assert.equal(plan.reSized, false);
    const winProfit = plan.stake * (plan.payoutMultiplier - 1);
    assert.ok(Math.abs(winProfit - debt) < 0.01 * (debt / 100), "a clearing win clears at the actual payout");
    assert.ok(plan.askPrice !== null && plan.askPrice > 0, "the actual buy price is recorded");
  });

  it("quote drift beyond 1 % re-sizes once and never under-clears", async () => {
    // A sweep of drifts, both directions, several debt sizes: a win at the
    // live payout must never fall short by more than 1 cent per $100 of debt.
    const drifts = [1.80, 1.88, 1.93, 1.94, 1.95, 1.97, 2.05, 2.43, 8.93];
    for (const debt of [1, 12.34, 100, 456.78]) {
      for (const live of drifts) {
        const assumed = 1.95;
        const plan = await prepareRecoveryBuy({
          ...base,
          targetClearance: debt,
          assumedPayout: assumed,
          candidateStake: debt / (assumed - 1),
          fetchProposal: liveFetcher(live),
        });
        assert.equal(plan.source, "live");
        if (Math.abs(live - assumed) / assumed > PAYOUT_DRIFT_TOLERANCE) {
          assert.equal(plan.reSized, true, `drifted payout ${live} must trigger the one re-size`);
        }
        const winProfit = plan.stake * (plan.payoutMultiplier - 1);
        const shortfall = Math.max(0, debt - winProfit);
        assert.ok(
          shortfall <= 0.01 * (debt / 100) + 1e-9,
          `shortfall ${shortfall} on debt ${debt} at live payout ${live}`,
        );
      }
    }
  });

  it("timeout falls back to the table with the 2 % safety margin", async () => {
    const debt = 50;
    const assumed = getFallbackPayout("DIGITEVEN", null);
    const candidate = debt / (assumed - 1);
    const plan = await prepareRecoveryBuy({
      ...base,
      targetClearance: debt,
      assumedPayout: assumed,
      candidateStake: candidate,
      fetchProposal: timingOutFetcher(),
      timeoutMs: 30,
    });
    assert.equal(plan.source, "fallback");
    assert.equal(plan.askPrice, null);
    assert.equal(plan.safetyMarginApplied, true);
    assert.ok(Math.abs(plan.stake - candidate * (1 + FALLBACK_SAFETY_MARGIN)) < 1e-9);
    // The margin means a win at the TABLE payout over-clears (never under).
    assert.ok(plan.stake * (assumed - 1) >= debt);
  });

  it("a rejected/errored proposal also falls back safely", async () => {
    const debt = 10;
    const assumed = 1.95;
    const plan = await prepareRecoveryBuy({
      ...base,
      targetClearance: debt,
      assumedPayout: assumed,
      candidateStake: debt / (assumed - 1),
      fetchProposal: async () => { throw new Error("ws down"); },
      timeoutMs: 30,
    });
    assert.equal(plan.source, "fallback");
    assert.equal(plan.safetyMarginApplied, true);
  });

  it("drift within tolerance does not flag a re-size", async () => {
    const debt = 20;
    const assumed = 1.95;
    const plan = await prepareRecoveryBuy({
      ...base,
      targetClearance: debt,
      assumedPayout: assumed,
      candidateStake: debt / (assumed - 1),
      fetchProposal: liveFetcher(assumed * (1 + PAYOUT_DRIFT_TOLERANCE * 0.5)),
    });
    assert.equal(plan.reSized, false);
    assert.equal(plan.source, "live");
  });
});
