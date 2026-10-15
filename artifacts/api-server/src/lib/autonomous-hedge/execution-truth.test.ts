/**
 * Execution-truth tests.
 *
 * Phase 3 closes the loop between the payout that SIZED a recovery step and the
 * payout the broker actually PAID. The properties that matter:
 *
 *  1. A faithful broker (realised == quoted) must never raise an alarm — the
 *     ladder is already correctly sized and the telemetry must stay quiet.
 *  2. A systematically short-paying broker must raise the alarm, because every
 *     recovery step divides by `(quotedMultiplier - 1)` and would silently
 *     under-recover forever.
 *  3. A single unlucky small payout must NOT raise it.
 *  4. Dispatch latency must count staleness against the freshness bound.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  QUOTE_DRIFT_ALARM_STREAK,
  getExecutionTruthReport,
  realisedMultiplier,
  recordDispatchLatency,
  recordQuoteOutcome,
  resetExecutionTruth,
} from "./execution-truth";

beforeEach(() => resetExecutionTruth());

describe("execution truth: quote drift", () => {
  it("stays silent when the broker pays exactly what it quoted", () => {
    for (let i = 0; i < 40; i++) {
      const t = recordQuoteOutcome({
        contract: "DIGITOVER",
        barrier: 3,
        quotedMultiplier: 1.63,
        realisedMultiplier: 1.63,
        won: true,
      });
      assert.equal(t.alarm, false);
    }
    assert.deepEqual(getExecutionTruthReport().alarms, []);
  });

  it("raises the alarm when the realised multiplier is consistently below the quote", () => {
    // 1.5% short on every win — under the single-observation noise floor per
    // trade, but material and consistent across the ladder.
    let last = recordQuoteOutcome({
      contract: "DIGITOVER",
      barrier: 3,
      quotedMultiplier: 1.63,
      realisedMultiplier: 1.6055,
      won: true,
    });
    for (let i = 1; i < QUOTE_DRIFT_ALARM_STREAK + 3; i++) {
      last = recordQuoteOutcome({
        contract: "DIGITOVER",
        barrier: 3,
        quotedMultiplier: 1.63,
        realisedMultiplier: 1.6055,
        won: true,
      });
    }
    assert.equal(last.adverseStreak >= QUOTE_DRIFT_ALARM_STREAK, true);
    assert.equal(last.alarm, true);
    assert.deepEqual(getExecutionTruthReport().alarms, ["DIGITOVER:3"]);
  });

  it("does not raise the alarm on one unusually small payout", () => {
    for (let i = 0; i < 10; i++) {
      recordQuoteOutcome({
        contract: "DIGITOVER",
        barrier: 3,
        quotedMultiplier: 1.63,
        realisedMultiplier: 1.63,
        won: true,
      });
    }
    const t = recordQuoteOutcome({
      contract: "DIGITOVER",
      barrier: 3,
      quotedMultiplier: 1.63,
      realisedMultiplier: 1.4,
      won: true,
    });
    assert.equal(t.adverseStreak, 1);
    assert.equal(t.alarm, false);
  });

  it("treats losses as carrying no pricing information", () => {
    for (let i = 0; i < 30; i++) {
      const t = recordQuoteOutcome({
        contract: "DIGITOVER",
        barrier: 3,
        quotedMultiplier: 1.63,
        realisedMultiplier: 0, // broker keeps the stake
        won: false,
      });
      assert.equal(t.alarm, false);
      assert.equal(t.meanRealisedOnWin, 0);
    }
    assert.equal(getExecutionTruthReport().contracts[0].samples, 30);
    assert.equal(getExecutionTruthReport().contracts[0].wins, 0);
  });

  it("separates contracts by barrier", () => {
    recordQuoteOutcome({
      contract: "DIGITOVER", barrier: 3, quotedMultiplier: 1.63, realisedMultiplier: 1.63, won: true,
    });
    recordQuoteOutcome({
      contract: "DIGITOVER", barrier: 7, quotedMultiplier: 5.2, realisedMultiplier: 5.2, won: true,
    });
    const keys = getExecutionTruthReport().contracts.map((c) => c.key).sort();
    assert.deepEqual(keys, ["DIGITOVER:3", "DIGITOVER:7"]);
  });
});

describe("execution truth: dispatch latency", () => {
  it("counts a decision sent on the tape it was decided on as fresh", () => {
    const l = recordDispatchLatency({
      decisionTickSequence: 100,
      dispatchTickSequence: 100,
      elapsedMs: 120,
    });
    assert.equal(l.samples, 1);
    assert.equal(l.meanTicksElapsed, 0);
    assert.equal(l.staleDispatches, 0);
  });

  it("flags a dispatch made on a decision older than the freshness bound", () => {
    recordDispatchLatency({ decisionTickSequence: 100, dispatchTickSequence: 100, elapsedMs: 120 });
    const l = recordDispatchLatency({
      decisionTickSequence: 100,
      dispatchTickSequence: 103,
      elapsedMs: 3900,
    });
    assert.equal(l.staleDispatches, 1, "a 3-tick-old decision must count as stale");
    assert.equal(l.maxTicksElapsed, 3);
    assert.equal(l.maxMs, 3900);
    assert.ok(l.meanTicksElapsed > 0 && l.meanTicksElapsed < 3);
  });

  it("survives a tape that went backwards without going negative", () => {
    const l = recordDispatchLatency({
      decisionTickSequence: 100,
      dispatchTickSequence: 98,
      elapsedMs: 80,
    });
    assert.equal(l.meanTicksElapsed, 0);
    assert.equal(l.staleDispatches, 0);
  });
});

describe("execution truth: realised multiplier", () => {
  it("derives the paid multiplier from a winning settlement", () => {
    // 1.00 stake returning 1.63 => multiplier 1.63
    assert.equal(realisedMultiplier(1, 0.63, true), 1.63);
    // 2.00 stake returning 3.26 => the same multiplier, one cent of rounding
    assert.equal(realisedMultiplier(2, 1.26, true), 1.63);
    // Settlement is rounded to cents before the ratio, as the ledger does.
    assert.ok(Math.abs(realisedMultiplier(2.5, 1.575, true) - 1.63) < 0.005);
  });

  it("reports zero for a loss and never divides by a non-positive stake", () => {
    assert.equal(realisedMultiplier(1, -1, false), 0);
    assert.equal(realisedMultiplier(0, 0, true), 0);
    assert.equal(realisedMultiplier(-1, 5, true), 0);
  });
});
