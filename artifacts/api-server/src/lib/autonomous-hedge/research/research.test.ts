/**
 * Recovery research harness — self tests (WP0).
 *
 * These pin the harness itself: the ladder reproduces the shipped stake
 * geometry bit-for-bit, the drift-trap diagnostic agrees with the paper, the
 * episode simulator is deterministic under a seed, and the audit statistics
 * behave (e-values stay small on fair data, grow on planted edge). The
 * BASELINE numbers live in research-reports/recovery/, not here — tests pin
 * invariants, the reports pin measurements.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mulberry32 } from "./rng";
import { runLadderEpisode, runLadderSweep, splitLogDebtDrift, MIN_DERIV_STAKE } from "./ladder";
import { runEpisode, runEpisodeSweep, specTrueP0 } from "./episode";
import { summarizeEpisodes, proportionCiHalfWidth } from "./metrics";
import { anytimeEValue, wilsonInterval, auditJournal } from "./audit";
import { createTapeGenerator } from "./tape";
import { parseContractSpecs } from "../contract-sets";
import { applyRecoveryStakeLimits, calculateRecoveryStakeRequest, recoveryTargetProfitFor } from "../../recovery-math";

describe("recovery research harness", () => {
  it("tape generator is deterministic and i.i.d.-shaped", () => {
    const a = createTapeGenerator(mulberry32(42));
    const b = createTapeGenerator(mulberry32(42));
    a.steps(200);
    b.steps(200);
    assert.deepEqual(a.digits(), b.digits(), "same seed ⇒ same tape");
    const digits = a.digits();
    for (const d of digits) assert.ok(d >= 0 && d <= 9);
    const counts = Array.from({ length: 10 }, () => 0);
    for (const d of digits) counts[d] += 1;
    // 200 uniform draws: no digit may be absurdly far from 20.
    for (const c of counts) assert.ok(c > 2 && c < 45, `digit count ${c} implausible`);
  });

  it("ladder reproduces the shipped first-step stake geometry (paper ladder)", () => {
    // Even/Odd, origin payout 1.40 ⇒ target = 0.40 (recoveryTargetProfitFor).
    const target = recoveryTargetProfitFor(1, 1.4);
    assert.ok(Math.abs(target - 0.4) < 1e-12);
    const first = applyRecoveryStakeLimits(
      calculateRecoveryStakeRequest({
        unrecoveredAmount: 1,
        remainingTargetProfit: target,
        payoutMultiplier: 1.95,
        baseStake: 1,
        recoveryAutoMode: true,
        recoveryMethod: "instant",
        recoveryMultiplier: 1.62,
        recoveryStep: 1,
        maxRecoverySteps: 3,
      }),
      500,
      1000,
    );
    // (1 + 0.40) / 0.95 = 1.4737 → rounded up 1.48 — the paper's first rung.
    assert.equal(first, 1.48);
  });

  it("ladder episodes are deterministic and respect the ruin floor", () => {
    const cfg = {
      p0: 0.5,
      payout: 1.95,
      baseStake: 1,
      capital: 200,
      maxTradeStake: 500,
      method: "instant" as const,
      maxTrades: 300,
    };
    const r1 = runLadderEpisode(mulberry32(7), cfg);
    const r2 = runLadderEpisode(mulberry32(7), cfg);
    assert.deepEqual(r1, r2, "same seed ⇒ same episode");
    if (r1.outcome === "ruined") {
      assert.ok(r1.finalCash < MIN_DERIV_STAKE + 1, "ruin means the floor was hit");
    }
  });

  it("Split drift trap: log-debt drift turns positive well before the cap binds (D1)", () => {
    // Even/Odd: the paper places the trap at ≈19× base. The diagnostic must
    // be negative at small debt and positive deep in the ladder.
    assert.ok(splitLogDebtDrift(0.5, 1.95, 1, 1) < 0, "shallow debt drifts down in expectation");
    assert.ok(splitLogDebtDrift(0.5, 1.95, 1, 20) > 0, "deep debt drifts UP — the drift trap");
    // Over 3 (p0 0.6, payout 1.63) traps earlier (~14× per the paper).
    assert.ok(splitLogDebtDrift(0.6, 1.63, 1, 15) > 0, "Over 3 traps earlier than Even/Odd");
  });

  it("Instant cap trap appears when the stake cap binds (D2)", () => {
    const { records } = runLadderSweep({
      rng: mulberry32(11),
      episodes: 4000,
      p0: 0.5,
      payout: 1.95,
      baseStake: 1,
      capital: 200,
      maxTradeStake: 10, // tight cap → trap
      method: "instant",
      maxTrades: 400,
    });
    const m = summarizeEpisodes(records);
    assert.ok(m.capTrapRate > 0.01, "a tight cap must produce cap-trap episodes");
    assert.ok(m.meanFinalCash < 0, "negative expectation on i.i.d. outcomes");
  });

  it("ruin rate scales with base/capital at the paper's order of magnitude", () => {
    const { records } = runLadderSweep({
      rng: mulberry32(3),
      episodes: 20_000,
      p0: 0.5,
      payout: 1.95,
      baseStake: 1,
      capital: 200,
      maxTradeStake: 500,
      method: "instant",
      maxTrades: 3000,
    });
    const m = summarizeEpisodes(records);
    // Paper: P(ruin) ≈ (0.9–1.5) × base/capital = 0.45–0.75 % here.
    assert.ok(m.ruinRate > 0.001, `ruin rate ${m.ruinRate} above the floor`);
    assert.ok(m.ruinRate < 0.03, `ruin rate ${m.ruinRate} below a sane ceiling`);
  });

  it("episode simulator runs the real pipeline and is seeded", () => {
    const cfg = {
      recoverySpecs: parseContractSpecs("DIGITEVEN:-1,DIGITODD:-1"),
      capital: 200,
      baseStake: 1,
      maxTradeStake: 500,
      method: "instant" as const,
      maxTicks: 600,
      cooldownTicks: 30,
      consecutiveLossLimit: 4,
    };
    const e1 = runEpisode(mulberry32(5), cfg, "engine");
    const e2 = runEpisode(mulberry32(5), cfg, "engine");
    assert.deepEqual(e1, e2, "episode simulator is deterministic");
    assert.ok(e1.recoveryTrades >= 1, "episode took recovery trades");
    assert.ok(["cleared", "ruined", "unresolved"].includes(e1.outcome));
  });

  it("null test: engine selection ≈ random selection on i.i.d. data (D8 gate)", () => {
    const cfg = {
      recoverySpecs: parseContractSpecs("DIGITEVEN:-1,DIGITODD:-1"),
      capital: 200,
      baseStake: 1,
      maxTradeStake: 500,
      method: "instant" as const,
      maxTicks: 700,
      cooldownTicks: 30,
      consecutiveLossLimit: 4,
    };
    const episodes = 250;
    const engine = runEpisodeSweep({ episodes, rng: mulberry32(21), cfg, selector: "engine" });
    const random = runEpisodeSweep({ episodes, rng: mulberry32(22), cfg, selector: "random" });
    const nE = engine.reduce((s, r) => s + r.recoveryTrades, 0);
    const nR = random.reduce((s, r) => s + r.recoveryTrades, 0);
    const hrE = engine.reduce((s, r) => s + Math.round(r.hitRate * r.recoveryTrades), 0) / nE;
    const hrR = random.reduce((s, r) => s + Math.round(r.hitRate * r.recoveryTrades), 0) / nR;
    const power = proportionCiHalfWidth(Math.min(nE, nR));
    assert.ok(
      Math.abs(hrE - hrR) <= power + 0.01,
      `engine ${hrE.toFixed(3)} vs random ${hrR.toFixed(3)} beyond power ${power.toFixed(3)}`,
    );
    // Confirmations cost ticks: the engine arm's decision latency must exceed
    // the random arm's first-tick firing (the shipped delay WP3 removes).
    const mE = summarizeEpisodes(engine);
    const mR = summarizeEpisodes(random);
    assert.ok(mE.meanDecisionLatencyTicks > mR.meanDecisionLatencyTicks, "confirmations add latency");
  });

  it("specTrueP0 matches the family geometry", () => {
    assert.equal(specTrueP0({ type: "DIGITOVER", digit: 3 }), 0.6);
    assert.equal(specTrueP0({ type: "DIGITUNDER", digit: 6 }), 0.6);
    assert.equal(specTrueP0({ type: "DIGITEVEN", digit: -1 }), 0.5);
    assert.equal(specTrueP0({ type: "DIGITMATCH", digit: -1 }), 0.1);
    assert.equal(specTrueP0({ type: "CALL", digit: -1 }), 0.5);
  });

  it("wilson interval and e-values behave", () => {
    const w = wilsonInterval(50, 100);
    assert.ok(w.lower < 0.5 && w.upper > 0.5 && w.lower > 0.35 && w.upper < 0.65);

    // Fair stream: the anytime-valid e-value against p ≤ p0 must stay small.
    const rng = mulberry32(99);
    const fair = Array.from({ length: 600 }, () => rng.next() < 0.5);
    assert.ok(anytimeEValue(fair, 0.5) < 20, "no false edge on fair data");

    // Planted edge: it must grow decisively.
    const rng2 = mulberry32(100);
    const edged = Array.from({ length: 600 }, () => rng2.next() < 0.58);
    assert.ok(anytimeEValue(edged, 0.5) > 20, "planted edge is detected");
  });

  it("audit groups by contract and mode", () => {
    const rows = [
      { contractType: "DIGITEVEN", won: true, mode: "recovery" },
      { contractType: "DIGITEVEN", won: false, mode: "recovery" },
      { contractType: "DIGITOVER", barrier: 3, won: true, mode: "normal" },
    ];
    const reports = auditJournal(rows);
    assert.equal(reports.length, 2);
    const even = reports.find((r) => r.contract === "Even");
    assert.ok(even);
    assert.equal(even!.trades, 2);
    assert.equal(even!.p0, 0.5);
    assert.ok(Math.abs(even!.breakEven - 1 / 1.95) < 1e-9);
  });
});
