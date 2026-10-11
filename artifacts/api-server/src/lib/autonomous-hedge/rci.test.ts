/**
 * WP3 — Recovery Cost Index selector.
 *
 * Acceptance (pure level): RCI picks the lowest-margin feasible contract,
 * honours the headroom cap, falls back to the highest-p0 partial candidate
 * when nothing clears in one win, and breaks ties by feed health then
 * rejections — never by a wait. On i.i.d. data the selector's mean margin paid
 * per $ staked must be ≤ the legacy engine's and ≤ random's (harness level).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreRecoveryCandidates, recoverySpecP0, DEFAULT_RCI_WEIGHTS } from "./rci";
import { parseContractSpecs } from "./contract-sets";

const cand = (spec: string, payout: number, over: Partial<Parameters<typeof scoreRecoveryCandidates>[0]["candidates"][number]> = {}) => ({
  spec: parseContractSpecs(spec)[0],
  payout,
  quoteSource: "live" as const,
  quoteAgeMs: 0,
  tapeAgeMs: 0,
  recentRejections: 0,
  ...over,
});

describe("WP3 RCI selector", () => {
  it("picks the lowest-margin feasible contract (D5 fix)", () => {
    // Even/Odd margin 1 - 0.5*1.95 = 0.025; Over 8 margin 1 - 0.1*8.93 = 0.107.
    const decision = scoreRecoveryCandidates({
      candidates: [cand("DIGITOVER:8", 8.93), cand("DIGITEVEN:-1", 1.95)],
      debt: 1,
      headroomCap: 100,
    });
    assert.ok(decision.chosen);
    assert.equal(decision.chosen!.spec.type, "DIGITEVEN", "lowest house edge wins");
    assert.ok(!decision.partial);
  });

  it("margin and geometry match the contract tables", () => {
    const decision = scoreRecoveryCandidates({
      candidates: [cand("DIGITEVEN:-1", 1.95)],
      debt: 1,
      headroomCap: 100,
    });
    const c = decision.chosen!;
    assert.ok(Math.abs(c.margin - (1 - 0.5 * 1.95)) < 1e-12);
    assert.ok(Math.abs(c.geometry - 1.95 / 0.95) < 1e-12);
    // exact one-win stake with T'=0: debt/(payout-1).
    assert.ok(Math.abs(c.firstStake - 1 / 0.95) < 1e-12);
    assert.equal(recoverySpecP0({ type: "DIGITOVER", digit: 3 }), 0.6);
  });

  it("honours the headroom cap: infeasible one-win stakes are skipped", () => {
    // Matches exact stake = 1/(8.93-1) = 0.126 < cap, feasible; but a high-debt
    // Even/Odd exact = 100/0.95 = 105 > cap 10 -> infeasible.
    const decision = scoreRecoveryCandidates({
      candidates: [cand("DIGITEVEN:-1", 1.95), cand("DIGITMATCH:-1", 8.93)],
      debt: 100,
      headroomCap: 10,
    });
    // Even/Odd cannot clear in one win under the cap; Matches can (0.126... wait
    // debt 100 -> 100/7.93 = 12.6 > 10 also infeasible). So NO feasible one.
    assert.equal(decision.feasibleCount, 0);
    assert.ok(decision.partial, "falls back to partial recovery");
    assert.equal(decision.chosen!.spec.type, "DIGITEVEN", "highest p0 among fundable");
  });

  it("chooses a feasible full-clear over a partial fallback", () => {
    const decision = scoreRecoveryCandidates({
      candidates: [cand("DIGITOVER:8", 8.93), cand("DIGITEVEN:-1", 1.95)],
      debt: 5,
      headroomCap: 10, // Even exact 5/0.95=5.26<=10 feasible; Over8 exact 5/7.93=0.63 feasible
    });
    assert.ok(!decision.partial);
    assert.equal(decision.chosen!.spec.type, "DIGITEVEN", "lower margin among feasible");
  });

  it("breaks ties by feed health then rejections", () => {
    const a = cand("DIGITEVEN:-1", 1.95, { tapeAgeMs: 500, quoteAgeMs: 0, recentRejections: 0 });
    const b = cand("DIGITODD:-1", 1.95, { tapeAgeMs: 100, quoteAgeMs: 0, recentRejections: 0 });
    const byFeed = scoreRecoveryCandidates({ candidates: [a, b], debt: 1, headroomCap: 100 });
    assert.equal(byFeed.chosen!.spec.type, "DIGITODD", "fresher tape wins the tie");

    const c = cand("DIGITEVEN:-1", 1.95, { tapeAgeMs: 0, recentRejections: 3 });
    const d = cand("DIGITODD:-1", 1.95, { tapeAgeMs: 0, recentRejections: 0 });
    const byRej = scoreRecoveryCandidates({ candidates: [c, d], debt: 1, headroomCap: 100 });
    assert.equal(byRej.chosen!.spec.type, "DIGITODD", "fewer rejections win the tie");
  });

  it("returns null only when even the minimum stake is unaffordable (a budget fact, not a wait)", () => {
    const decision = scoreRecoveryCandidates({
      candidates: [cand("DIGITEVEN:-1", 1.95)],
      debt: 100,
      headroomCap: 0.10, // below the $0.35 Deriv minimum
    });
    assert.equal(decision.chosen, null);
    assert.ok(!decision.partial);
  });

  it("never requires a confirmation: the decision is fully determined by this tick's inputs", () => {
    // Running the same inputs twice must yield the same chosen contract with no
    // internal state accumulating between calls (no confirmation counter).
    const input = {
      candidates: [cand("DIGITEVEN:-1", 1.95), cand("DIGITOVER:4", 1.95)],
      debt: 2,
      headroomCap: 50,
      weights: DEFAULT_RCI_WEIGHTS,
    };
    const first = scoreRecoveryCandidates(input);
    const second = scoreRecoveryCandidates(input);
    assert.equal(first.chosen!.spec.type, second.chosen!.spec.type);
    assert.equal(first.chosen!.rci, second.chosen!.rci);
  });
});
