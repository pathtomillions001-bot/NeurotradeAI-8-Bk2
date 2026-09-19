import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bestPulseMarket, pulseRiskError, pulseScanMatchesAccount, type PulseReport, type PulseRiskSettings, type PulseScan } from "./match-pulse.ts";

const account = { id: "broker-demo", loginId: "VRTC-TEST", isVirtual: true, currency: "USD" };
const block = { ticks: 1000, shots: 50, wins: 20, winRate: 0.4, lower: 0.27, meanPrediction: 0.4, brierSkill: 0.1, longestLossRun: 3 };
function report(symbol: string, lowerEv: number, qualified = true, source: PulseReport["source"] = "live"): PulseReport {
  return { symbol, displayName: symbol, source, qualified, lowerEv, history: 4000, payout: 8.93, breakEven: 1 / 8.93,
    validation: block, audit: block, combined: block, logEvidence: 10, requiredLogEvidence: 8, reasons: [],
    latest: { digit: 7, probability: 0.4, lower: 0.3, recentProbability: 0.4, support: 500, recentSupport: 200, order: 0, context: "marginal", driftZ: 0, ready: true, reason: "qualified" } };
}
function scan(candidates: PulseReport[]): PulseScan {
  return { scanId: "test-scan", createdAt: 0, expiresAt: 120_000, account, marketsTested: candidates.length, scanRound: 1,
    qualifiedCount: candidates.filter(candidate => candidate.qualified).length, candidates, note: "Test fixture, not live performance." };
}

describe("Match Pulse specialist-console workflow", () => {
  it("chooses the best qualified broker market, not the first card or a simulated winner", () => {
    const measured = scan([report("rejected", 5, false), report("runner-up", 0.2), report("best", 0.4), report("simulated", 9, true, "simulated")]);
    const before = measured.candidates.map(candidate => candidate.symbol);
    assert.equal(bestPulseMarket(measured)?.symbol, "best");
    assert.deepEqual(measured.candidates.map(candidate => candidate.symbol), before, "ranking does not mutate scan state");
    assert.equal(bestPulseMarket(scan([report("none", 1, false)])), null);
    assert.equal(bestPulseMarket(null), null);
  });
  it("requires the same selected demo/real account that was used for the scan", () => {
    const measured = scan([report("R_100", 0.2)]);
    assert.equal(pulseScanMatchesAccount(measured, account), true);
    assert.equal(pulseScanMatchesAccount(measured, { ...account, isVirtual: false }), false);
    assert.equal(pulseScanMatchesAccount(measured, { ...account, loginId: "CR-OTHER" }), false);
    assert.equal(pulseScanMatchesAccount(measured, { ...account, currency: "EUR" }), false);
    assert.equal(pulseScanMatchesAccount(measured, null), false);
    assert.equal(pulseScanMatchesAccount({ ...measured, account: null }, account), false);
    const real = { ...account, id: "broker-real", loginId: "CR-TEST", isVirtual: false };
    assert.equal(pulseScanMatchesAccount({ ...measured, account: real }, real), true);
  });
  it("validates risk settings before allowing the scan step", () => {
    const valid: PulseRiskSettings = { stake: 1, stopLoss: 5, takeProfit: 10, maxRecoverySteps: 3, maxConsecutiveLosses: 6 };
    assert.equal(pulseRiskError(valid), null);
    for (const change of [{ stake: NaN }, { stake: 0 }, { stake: 1.001 }, { stake: 6 }, { stopLoss: -1 }, { takeProfit: Infinity }, { maxRecoverySteps: 0 }, { maxRecoverySteps: 2.5 }, { maxConsecutiveLosses: 2 }, { maxConsecutiveLosses: 21 }]) {
      assert.ok(pulseRiskError({ ...valid, ...change }));
    }
  });
});
