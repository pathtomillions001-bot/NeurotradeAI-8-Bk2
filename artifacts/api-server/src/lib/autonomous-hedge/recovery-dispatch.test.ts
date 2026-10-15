import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EvidenceTracker, type EvidenceRow } from "./evidence";
import { scoreV2Candidates, selectFreshV2RecoveryDecision, revalidateV2RecoveryCandidate, type V2LadderConfig } from "./score-v2";
import { clearPrefetchedQuotes } from "./quote-prefetch";
import { mulberry32 } from "./constants";
import { shouldSwitchCandidateBeforeBuy } from "./timing-v2";

const ladder: V2LadderConfig = {
  method: "split", autoMode: true, multiplier: 1.5, step: 1, maxRecoverySteps: 3,
  debt: 1, targetRemaining: 0.95, base: 1, maxTradeStake: 50, balance: 1000,
  consecutiveLossLimit: 10, currentLossRun: 1,
};

function evidence(type: "DIGITEVEN" | "DIGITMATCH", p: number): EvidenceRow {
  return {
    symbol: "R_100", spec: { type, barrier: type === "DIGITMATCH" ? 7 : -1 },
    resolvedBarrier: type === "DIGITMATCH" ? 7 : -1, p0: type === "DIGITMATCH" ? 0.1 : 0.5,
    pTilde: p, z: 8, zTilde: p > (type === "DIGITMATCH" ? 0.1 : 0.5) ? 4 : 0,
    window: 1500, nEff: 1500, q: 0.99, depUsed: false, edgeIndex: 1,
    longestZ: 8, longestZTilde: 4, longestWindowTicks: 1500,
  };
}
function score(rows: EvidenceRow[], overrides: Partial<V2LadderConfig> = {}) {
  return scoreV2Candidates({ evidenceRows: rows, tickSequenceBySymbol: { R_100: 100 }, ladder: { ...ladder, ...overrides } });
}

afterEach(clearPrefetchedQuotes);

describe("recovery pre-buy selection", () => {
  it("replaces a refused original with an admissible candidate even when J is worse", () => {
    const rows = score([evidence("DIGITEVEN", 0.514), evidence("DIGITMATCH", 0.12)]);
    const original = rows.find(r => r.contract === "DIGITEVEN")!;
    const replacement = rows.find(r => r.contract === "DIGITMATCH")!;
    assert.equal(original.eligible, false);
    assert.equal(replacement.eligible, true);
    assert.equal(shouldSwitchCandidateBeforeBuy(original.J, replacement.J), false,
      "negative control: the old J-only rule vetoes this valid recovery replacement");
    const fresh = selectFreshV2RecoveryDecision(rows, 1)!;
    assert.equal(fresh.eligible, true);
    assert.equal(fresh.best.key, replacement.key);
  });

  it("uses eligibility then EV, rather than the obsolete J-only ordering", () => {
    const rows = score([evidence("DIGITEVEN", 0.65), evidence("DIGITMATCH", 0.25)]);
    const fresh = selectFreshV2RecoveryDecision([...rows].reverse(), 1)!;
    assert.equal(fresh.best.contract, "DIGITMATCH");
    assert.equal(fresh.eligible, true);
  });

  it("does not reuse a vanished original when no fresh candidates exist", () => {
    assert.equal(selectFreshV2RecoveryDecision([], 1), null);
  });

  it("still holds on an edge-free tape or a hard risk stop", () => {
    assert.equal(selectFreshV2RecoveryDecision(score([evidence("DIGITEVEN", 0.5)]), 1)!.eligible, false);
    assert.equal(selectFreshV2RecoveryDecision(score([evidence("DIGITEVEN", 0.8)], { hardStop: true }), 1)!.eligible, false);
  });

  it("positive control: real evidence -> scorer -> fresh decision -> resolved gate passes", () => {
    const rng = mulberry32(12345);
    const digits = Array.from({ length: 1500 }, () => rng() < 0.8 ? 2 : 1);
    const rows = new EvidenceTracker().evaluate({ markets: [{
      symbol: "R_100", digits, prices: digits.map((_, i) => 1000 + i * 0.01),
      tickSequence: 1500, specs: [{ type: "DIGITEVEN", barrier: -1 }],
    }] });
    const candidate = selectFreshV2RecoveryDecision(score(rows), 1)!.best;
    const checked = revalidateV2RecoveryCandidate(candidate as ReturnType<typeof score>[number], {
      payout: 1.95, stake: 1, base: 1, balance: 1000, maxTradeStake: 50,
    });
    assert.equal(checked.eligible, true);
  });

  it("refuses quote drift and resolved stakes outside limits without changing the stake", () => {
    const candidate = score([evidence("DIGITEVEN", 0.6)])[0]!;
    const resolved = { payout: 1.95, stake: 1, base: 1, balance: 1000, maxTradeStake: 50 };
    assert.equal(revalidateV2RecoveryCandidate(candidate, resolved).eligible, true);
    assert.equal(revalidateV2RecoveryCandidate(candidate, { ...resolved, payout: 1.6 }).eligible, false);
    for (const payout of [NaN, Infinity, 0, 1]) {
      assert.equal(revalidateV2RecoveryCandidate(candidate, { ...resolved, payout }).eligible, false);
    }
    for (const stake of [0.1, 51, 1001, NaN]) {
      assert.equal(revalidateV2RecoveryCandidate(candidate, { ...resolved, stake }).eligible, false);
    }
    assert.equal(resolved.stake, 1);
  });
});
