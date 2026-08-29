/**
 * Recovery completion is debt-based, not target-profit-based.
 *
 * Previous main-engine condition that caused the extra trade:
 *   remainingDebt + remainingTarget <= 0.005
 * After losses 0.70 + 0.69 + 1.17 + 1.99 = 4.55 and a 4.82 win,
 * remainingDebt was 0 but remainingTarget was 0.01 (target 0.28 − excess 0.27).
 * 0 + 0.01 is not <= 0.005, so recovery stayed active and another recovery
 * trade was opened to chase one cent of optional target profit.
 *
 * FAB previously used remainingDebt <= 0.01, which completed the reported
 * scenario but would also exit when a real $0.01 of debt remained.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  addMoney,
  settleRecoveryWin,
  toCents,
} from "./recovery-math.ts";
import * as recoveryEngine from "./agents/recovery-engine.ts";
import {
  acquireTradingOwnership,
  currentTradingOwner,
  hasTradingOwnership,
  releaseTradingOwnership,
} from "./engine-arbiter.ts";
import { AUTOMATED_DERIV_MARKETS, DERIV_MARKETS, isAutomatedMarket } from "./deriv.ts";
import { browserSession } from "./session.ts";
import { getTzOffset, setTzOffset } from "./tz.ts";
import {
  recordRecoveryOutcome,
  type SpeedRecoveryState,
} from "./speed-recovery-state.ts";

const MAX_STEPS = 5;
const ORIGIN_PAYOUT = 1.4; // 0.70 * 0.4 = 0.28 target profit

function inBrowserSession<T>(sessionId: string, action: () => T): T {
  let value!: T;
  browserSession(
    { cookies: { neurotrade_session: sessionId } } as any,
    { cookie: () => undefined } as any,
    () => { value = action(); },
  );
  return value;
}

function emptyFab(baseStake = 0.7): SpeedRecoveryState {
  return {
    inRecovery: false,
    recoveryStep: 0,
    unrecoveredAmount: 0,
    baseStake,
    targetProfit: 0,
    remainingTargetProfit: 0,
    originPayoutMultiplier: 1,
    consecutiveRecoveryLosses: 0,
    recentRecoveryTrades: [],
  };
}

function playReportedSequenceMain() {
  recoveryEngine.resetAll();
  recoveryEngine.recordOutcome(false, -0.7, 0.7, MAX_STEPS, "DIGITOVER", ORIGIN_PAYOUT);
  recoveryEngine.recordOutcome(false, -0.69, 0.69, MAX_STEPS, "DIGITOVER", ORIGIN_PAYOUT);
  recoveryEngine.recordOutcome(false, -1.17, 1.17, MAX_STEPS, "DIGITOVER", ORIGIN_PAYOUT);
  recoveryEngine.recordOutcome(false, -1.99, 1.99, MAX_STEPS, "DIGITOVER", ORIGIN_PAYOUT);
  return recoveryEngine.recordOutcome(true, 4.82, 2.5, MAX_STEPS, "DIGITOVER", ORIGIN_PAYOUT);
}

function playReportedSequenceFab() {
  let rec = emptyFab(0.7);
  rec = recordRecoveryOutcome(rec, false, -0.7, 0.7, MAX_STEPS, ORIGIN_PAYOUT);
  rec = recordRecoveryOutcome(rec, false, -0.69, 0.69, MAX_STEPS, ORIGIN_PAYOUT);
  rec = recordRecoveryOutcome(rec, false, -1.17, 1.17, MAX_STEPS, ORIGIN_PAYOUT);
  rec = recordRecoveryOutcome(rec, false, -1.99, 1.99, MAX_STEPS, ORIGIN_PAYOUT);
  return recordRecoveryOutcome(rec, true, 4.82, 2.5, MAX_STEPS, ORIGIN_PAYOUT);
}

afterEach(() => {
  recoveryEngine.resetAll();
  releaseTradingOwnership("autonomous");
  releaseTradingOwnership("neuroai");
});

describe("settleRecoveryWin (shared helper)", () => {
  it("reported scenario: 4.55 debt, 4.82 win, 0.28 target → complete with 0.27 excess", () => {
    const result = settleRecoveryWin({
      unrecoveredAmount: 4.55,
      remainingTargetProfit: 0.28,
      actualNetProfit: 4.82,
    });
    assert.equal(result.remainingDebt, 0);
    assert.equal(result.debtRecovered, 4.55);
    assert.equal(result.excessProfit, 0.27);
    assert.equal(result.remainingTargetProfit, 0.01);
    assert.equal(result.recoveryComplete, true);
  });

  it("debt fully recovered while leftover target is $0.01 → complete", () => {
    const result = settleRecoveryWin({
      unrecoveredAmount: 0,
      remainingTargetProfit: 0.01,
      actualNetProfit: 0,
    });
    assert.equal(result.remainingDebt, 0);
    assert.equal(result.remainingTargetProfit, 0.01);
    assert.equal(result.recoveryComplete, true);
  });

  it("partial recovery leaves remaining debt and stays incomplete", () => {
    const result = settleRecoveryWin({
      unrecoveredAmount: 4.55,
      remainingTargetProfit: 0.28,
      actualNetProfit: 4,
    });
    assert.equal(result.remainingDebt, 0.55);
    assert.equal(result.debtRecovered, 4);
    assert.equal(result.excessProfit, 0);
    assert.equal(result.remainingTargetProfit, 0.28);
    assert.equal(result.recoveryComplete, false);
  });

  it("exact debt recovery completes even if target remains", () => {
    const result = settleRecoveryWin({
      unrecoveredAmount: 4.55,
      remainingTargetProfit: 0.28,
      actualNetProfit: 4.55,
    });
    assert.equal(result.remainingDebt, 0);
    assert.equal(result.excessProfit, 0);
    assert.equal(result.remainingTargetProfit, 0.28);
    assert.equal(result.recoveryComplete, true);
  });

  it("profit exceeds debt but misses desired target → still complete", () => {
    const result = settleRecoveryWin({
      unrecoveredAmount: 4.55,
      remainingTargetProfit: 0.28,
      actualNetProfit: 4.56,
    });
    assert.equal(result.remainingDebt, 0);
    assert.equal(result.excessProfit, 0.01);
    assert.equal(result.remainingTargetProfit, 0.27);
    assert.equal(result.recoveryComplete, true);
  });

  it("real $0.01 remaining debt is not treated as a target shortfall", () => {
    const result = settleRecoveryWin({
      unrecoveredAmount: 0.01,
      remainingTargetProfit: 0,
      actualNetProfit: 0,
    });
    assert.equal(result.remainingDebt, 0.01);
    assert.equal(result.recoveryComplete, false);
  });

  it("does not invent phantom debt from 0.10 + 0.20 + 0.30", () => {
    const debt = addMoney(0.1, 0.2, 0.3);
    assert.equal(debt, 0.6);
    assert.equal(toCents(debt), 60);
    const result = settleRecoveryWin({
      unrecoveredAmount: debt,
      remainingTargetProfit: 0,
      actualNetProfit: 0.6,
    });
    assert.equal(result.remainingDebt, 0);
    assert.equal(result.recoveryComplete, true);
  });
});

describe("main autonomous engine recordOutcome", () => {
  it("reported sequence exits recovery and selects normal next", () => {
    const state = playReportedSequenceMain();
    assert.equal(state.inRecovery, false);
    assert.equal(state.unrecoveredAmount, 0);
    assert.equal(state.recoveryStep, 0);
    assert.equal(state.remainingTargetProfit, 0);
    assert.equal(state.targetProfit, 0);
    assert.equal(state.streakLossCount, 0);
    assert.equal(state.consecutiveMatchLosses, 0);
    assert.equal(recoveryEngine.isInRecovery(), false);
    const nextStake = recoveryEngine.getDynamicRecoveryStake(0.7, 500, 1000, 1.4, 0.8, "moderate");
    assert.equal(nextStake, 0.7);
  });

  it("partial recovery remains in recovery", () => {
    recoveryEngine.resetAll();
    recoveryEngine.recordOutcome(false, -4.55, 4.55, MAX_STEPS, "CALL", 1.4);
    const state = recoveryEngine.recordOutcome(true, 4, 4, MAX_STEPS, "CALL", 1.4);
    assert.equal(state.inRecovery, true);
    assert.equal(state.unrecoveredAmount, 0.55);
    assert.equal(recoveryEngine.isInRecovery(), true);
  });

  it("exact debt recovery exits recovery", () => {
    recoveryEngine.resetAll();
    recoveryEngine.recordOutcome(false, -4.55, 4.55, MAX_STEPS, "CALL", 1.4);
    const state = recoveryEngine.recordOutcome(true, 4.55, 4.55, MAX_STEPS, "CALL", 1.4);
    assert.equal(state.inRecovery, false);
    assert.equal(state.unrecoveredAmount, 0);
  });

  it("profit just above debt with unmet target exits recovery", () => {
    recoveryEngine.resetAll();
    recoveryEngine.recordOutcome(false, -4.55, 4.55, MAX_STEPS, "CALL", ORIGIN_PAYOUT);
    const state = recoveryEngine.recordOutcome(true, 4.56, 4.55, MAX_STEPS, "CALL", ORIGIN_PAYOUT);
    assert.equal(state.inRecovery, false);
    assert.equal(state.remainingTargetProfit, 0);
  });

  it("0.10 + 0.20 + 0.30 losses do not create phantom debt", () => {
    recoveryEngine.resetAll();
    recoveryEngine.recordOutcome(false, -0.1, 0.1, MAX_STEPS, "CALL", 1);
    recoveryEngine.recordOutcome(false, -0.2, 0.2, MAX_STEPS, "CALL", 1);
    recoveryEngine.recordOutcome(false, -0.3, 0.3, MAX_STEPS, "CALL", 1);
    assert.equal(recoveryEngine.getState().unrecoveredAmount, 0.6);
    assert.equal(toCents(recoveryEngine.getState().unrecoveredAmount), 60);
  });

  it("next normal loss after completion starts a fresh cycle", () => {
    playReportedSequenceMain();
    const next = recoveryEngine.recordOutcome(false, -0.7, 0.7, MAX_STEPS, "DIGITUNDER", ORIGIN_PAYOUT);
    assert.equal(next.inRecovery, true);
    assert.equal(next.unrecoveredAmount, 0.7);
    assert.equal(next.recoveryStep, 1);
    assert.equal(next.streakLossCount, 1);
    assert.equal(next.targetProfit, 0.28);
    assert.equal(next.remainingTargetProfit, 0.28);
  });

  it("persisted completed state cannot be resurrected on reload", () => {
    playReportedSequenceMain();
    const snapshot = recoveryEngine.serializeState();
    const parsed = JSON.parse(snapshot) as recoveryEngine.RecoveryState;
    assert.equal(parsed.inRecovery, false);
    assert.equal(parsed.unrecoveredAmount, 0);
    assert.equal(parsed.remainingTargetProfit, 0);

    recoveryEngine.seedState({
      ...parsed,
      inRecovery: true,
      remainingTargetProfit: 0.01,
      targetProfit: 0.28,
      recoveryStep: 4,
    });
    assert.equal(recoveryEngine.isInRecovery(), false);
    assert.equal(recoveryEngine.getState().unrecoveredAmount, 0);
    assert.equal(recoveryEngine.getState().remainingTargetProfit, 0);
    assert.equal(recoveryEngine.getState().recoveryStep, 0);

    recoveryEngine.loadState(JSON.stringify({
      inRecovery: true,
      recoveryStep: 4,
      unrecoveredAmount: 0,
      baseStake: 0.7,
      streakLossCount: 0,
      streakStartAmount: 4.55,
      targetProfit: 0.28,
      remainingTargetProfit: 0.01,
      originPayoutMultiplier: 1.4,
      resetDate: recoveryEngine.getState().resetDate,
      consecutiveMatchLosses: 0,
    }));
    assert.equal(recoveryEngine.isInRecovery(), false);
    assert.equal(recoveryEngine.getState().unrecoveredAmount, 0);
  });
});

describe("NeuroAI Quantum FAB recordRecoveryOutcome", () => {
  it("reported sequence exits recovery and selects normal next", () => {
    const rec = playReportedSequenceFab();
    assert.equal(rec.inRecovery, false);
    assert.equal(rec.unrecoveredAmount, 0);
    assert.equal(rec.recoveryStep, 0);
    assert.equal(rec.remainingTargetProfit, 0);
    assert.equal(rec.targetProfit, 0);
    assert.equal(rec.consecutiveRecoveryLosses, 0);
    assert.deepEqual(rec.recentRecoveryTrades, []);
    const nextMode = rec.inRecovery ? "recovery" : "normal";
    assert.equal(nextMode, "normal");
  });

  it("partial recovery remains in recovery", () => {
    let rec = recordRecoveryOutcome(emptyFab(), false, -4.55, 4.55, MAX_STEPS, ORIGIN_PAYOUT);
    rec = recordRecoveryOutcome(rec, true, 4, 4, MAX_STEPS, ORIGIN_PAYOUT);
    assert.equal(rec.inRecovery, true);
    assert.equal(rec.unrecoveredAmount, 0.55);
  });

  it("exact debt recovery exits recovery", () => {
    let rec = recordRecoveryOutcome(emptyFab(), false, -4.55, 4.55, MAX_STEPS, ORIGIN_PAYOUT);
    rec = recordRecoveryOutcome(rec, true, 4.55, 4.55, MAX_STEPS, ORIGIN_PAYOUT);
    assert.equal(rec.inRecovery, false);
    assert.equal(rec.unrecoveredAmount, 0);
  });

  it("profit just above debt with unmet target exits recovery", () => {
    let rec = recordRecoveryOutcome(emptyFab(), false, -4.55, 4.55, MAX_STEPS, ORIGIN_PAYOUT);
    rec = recordRecoveryOutcome(rec, true, 4.56, 4.55, MAX_STEPS, ORIGIN_PAYOUT);
    assert.equal(rec.inRecovery, false);
    assert.equal(rec.remainingTargetProfit, 0);
  });

  it("0.10 + 0.20 + 0.30 losses do not create phantom debt", () => {
    let rec = recordRecoveryOutcome(emptyFab(), false, -0.1, 0.1, MAX_STEPS, 1);
    rec = recordRecoveryOutcome(rec, false, -0.2, 0.2, MAX_STEPS, 1);
    rec = recordRecoveryOutcome(rec, false, -0.3, 0.3, MAX_STEPS, 1);
    assert.equal(rec.unrecoveredAmount, 0.6);
    assert.equal(toCents(rec.unrecoveredAmount), 60);
  });

  it("next normal loss after completion starts a fresh cycle", () => {
    let rec = playReportedSequenceFab();
    rec = recordRecoveryOutcome(rec, false, -0.7, 0.7, MAX_STEPS, ORIGIN_PAYOUT);
    assert.equal(rec.inRecovery, true);
    assert.equal(rec.unrecoveredAmount, 0.7);
    assert.equal(rec.recoveryStep, 1);
    assert.equal(rec.targetProfit, 0.28);
    assert.equal(rec.remainingTargetProfit, 0.28);
  });

  it("real $0.01 remaining debt keeps FAB in recovery", () => {
    let rec = recordRecoveryOutcome(emptyFab(), false, -0.01, 0.01, MAX_STEPS, 1);
    rec = recordRecoveryOutcome(rec, true, 0, 0.01, MAX_STEPS, 1);
    assert.equal(rec.inRecovery, true);
    assert.equal(rec.unrecoveredAmount, 0.01);
  });
});

/**
 * Incident replay (August 2026): instant recovery, normal over 1 / under 8
 * (payout 1.23), recovery over 5 / under 4 (payout 2.43), base stake 0.40.
 *
 * The reported journal — 0.40 L, 0.40 W, 0.35 L, 0.40 L, 0.59 L, 0.35 W,
 * 1.00 L, 0.40 W, 0.40 W, 1.70 L — looked like the recovery system flipping
 * modes at random. It actually decomposes to the CENT into two independent
 * engines (main autonomous engine + NeuroAI FAB session) each keeping its own
 * private recovery ledger while trading the same account:
 *
 *   Engine 1: 0.40 L → 0.35 L → 0.59 L → 1.00 L → 1.70 L  (never won)
 *   Engine 2: 0.40 W → 0.40 L → 0.35 W (+0.50 ≥ 0.40 debt → complete) → W → W
 *
 * The tests below lock in both halves of the fix:
 *   1. Both engines now share ONE account-global ledger (this module's
 *      behavior, also used verbatim by speed-ai-engine.ts), and
 *   2. Only one engine may execute at a time (engine-arbiter).
 */
describe("incident replay — instant recovery on the single shared ledger", () => {
  const NORMAL_PAYOUT = 1.23; // OVER 1 / UNDER 8
  const RECOVERY_PAYOUT = 2.43; // OVER 5 / UNDER 4
  const BASE_STAKE = 0.4;

  function nextInstantStake(winP = 0.4): number {
    return recoveryEngine.getDynamicRecoveryStake(
      BASE_STAKE, 500, Number.POSITIVE_INFINITY, RECOVERY_PAYOUT, winP,
      "moderate", 1.62, "instant", 3, true,
    );
  }

  it("losing chain reproduces 0.35 → 0.59 → 1.00 → 1.70 exactly", () => {
    recoveryEngine.resetAll();

    // Normal trade lost → whole account enters recovery ($0.40 debt, $0.09 target).
    let state = recoveryEngine.recordOutcome(false, -0.4, 0.4, 3, "DIGITOVER", NORMAL_PAYOUT);
    assert.equal(state.inRecovery, true);
    assert.equal(state.unrecoveredAmount, 0.4);
    assert.equal(state.remainingTargetProfit, 0.09); // 0.40 * (1.23 - 1)

    // Every subsequent trade MUST be a recovery trade: (debt + target) / 1.43.
    assert.equal(nextInstantStake(), 0.35);
    state = recoveryEngine.recordOutcome(false, -0.35, 0.35, 3, "DIGITOVER", RECOVERY_PAYOUT);
    assert.equal(state.unrecoveredAmount, 0.75);

    assert.equal(nextInstantStake(), 0.59);
    state = recoveryEngine.recordOutcome(false, -0.59, 0.59, 3, "DIGITOVER", RECOVERY_PAYOUT);
    assert.equal(state.unrecoveredAmount, 1.34);

    assert.equal(nextInstantStake(), 1.0);
    state = recoveryEngine.recordOutcome(false, -1.0, 1.0, 3, "DIGITUNDER", RECOVERY_PAYOUT);
    assert.equal(state.unrecoveredAmount, 2.34);

    assert.equal(nextInstantStake(), 1.7);
    assert.equal(recoveryEngine.isInRecovery(), true);
  });

  it("a recovery win that covers debt + a little profit exits to normal — next trade is normal-sized", () => {
    recoveryEngine.resetAll();

    recoveryEngine.recordOutcome(false, -0.4, 0.4, 3, "DIGITUNDER", NORMAL_PAYOUT);
    assert.equal(nextInstantStake(), 0.35);

    // Recovery win: 0.35 * (2.43 - 1) = 0.50 profit ≥ 0.40 debt → instant complete.
    const state = recoveryEngine.recordOutcome(true, 0.5, 0.35, 3, "DIGITOVER", RECOVERY_PAYOUT);
    assert.equal(state.inRecovery, false);
    assert.equal(state.unrecoveredAmount, 0);
    assert.equal(recoveryEngine.isInRecovery(), false);

    // The very next trade is a NORMAL trade at the base stake — never another
    // recovery trade after the debt was covered.
    const nextStake = recoveryEngine.getDynamicRecoveryStake(
      BASE_STAKE, 500, Number.POSITIVE_INFINITY, NORMAL_PAYOUT, 0.8,
      "moderate", 1.62, "instant", 3, true,
    );
    assert.equal(nextStake, BASE_STAKE);

    // Normal wins afterwards never re-enter recovery.
    recoveryEngine.recordOutcome(true, 0.09, 0.4, 3, "DIGITOVER", NORMAL_PAYOUT);
    recoveryEngine.recordOutcome(true, 0.09, 0.4, 3, "DIGITOVER", NORMAL_PAYOUT);
    assert.equal(recoveryEngine.isInRecovery(), false);
  });

  it("interleaved engines on one ledger behave like the reported chains (no mix-up)", () => {
    recoveryEngine.resetAll();

    // Engine 1: normal LOSS → account in recovery.
    recoveryEngine.recordOutcome(false, -0.4, 0.4, 3, "DIGITOVER", NORMAL_PAYOUT);
    assert.equal(recoveryEngine.isInRecovery(), true);

    // Engine 2 reads the SAME ledger: it also sees recovery mode and sizes off
    // the same debt — it cannot open a "normal" trade while debt is open.
    const shared = recoveryEngine.getState();
    assert.equal(shared.inRecovery, true);
    assert.equal(shared.unrecoveredAmount, 0.4);

    // Whichever engine executes next, the stake is the instant-recovery stake...
    assert.equal(nextInstantStake(), 0.35);

    // ...and when a covering win lands (from EITHER engine), BOTH engines see
    // normal mode — no dangling recovery trade.
    const done = recoveryEngine.recordOutcome(true, 0.5, 0.35, 3, "DIGITUNDER", RECOVERY_PAYOUT);
    assert.equal(done.inRecovery, false);
    assert.equal(done.unrecoveredAmount, 0);
    assert.equal(recoveryEngine.isInRecovery(), false);
  });

  it("covering win across engines fully completes for any profit ≥ debt", () => {
    recoveryEngine.resetAll();
    recoveryEngine.recordOutcome(false, -0.4, 0.4, 3, "DIGITOVER", NORMAL_PAYOUT);
    recoveryEngine.recordOutcome(false, -0.35, 0.35, 3, "DIGITOVER", RECOVERY_PAYOUT);
    // debt 0.75 — a win paying ≥ 0.75 completes for BOTH engines' view.
    const state = recoveryEngine.recordOutcome(true, 0.84, 0.59, 3, "DIGITUNDER", RECOVERY_PAYOUT);
    assert.equal(state.inRecovery, false);
    assert.equal(recoveryEngine.isInRecovery(), false);
  });

  it("split mode caps each attempt at one base stake; instant does not", () => {
    recoveryEngine.resetAll();
    recoveryEngine.recordOutcome(false, -0.4, 0.4, 3, "DIGITOVER", NORMAL_PAYOUT);
    recoveryEngine.recordOutcome(false, -0.35, 0.35, 3, "DIGITOVER", RECOVERY_PAYOUT);
    assert.equal(recoveryEngine.getState().unrecoveredAmount, 0.75);

    const instant = recoveryEngine.getDynamicRecoveryStake(
      BASE_STAKE, 500, Number.POSITIVE_INFINITY, RECOVERY_PAYOUT, 0.4,
      "moderate", 1.62, "instant", 3, true,
    );
    const split = recoveryEngine.getDynamicRecoveryStake(
      BASE_STAKE, 500, Number.POSITIVE_INFINITY, RECOVERY_PAYOUT, 0.4,
      "moderate", 1.62, "split", 3, true,
    );
    assert.equal(instant, 0.59); // full (0.75 + 0.09) / 1.43 rounded up
    assert.equal(split, 0.4);    // exact 0.59 capped at one base stake
  });
});

describe("browser-session runtime isolation", () => {
  const sessionA = "11111111-1111-4111-8111-111111111111";
  const sessionB = "22222222-2222-4222-8222-222222222222";

  it("keeps recovery debt in the browser session that recorded it", () => {
    inBrowserSession(sessionA, () => {
      recoveryEngine.resetAll();
      recoveryEngine.recordOutcome(false, -0.7, 0.7, 3, "DIGITOVER", ORIGIN_PAYOUT);
    });
    assert.equal(inBrowserSession(sessionB, () => recoveryEngine.getState().inRecovery), false);
    assert.equal(inBrowserSession(sessionA, () => recoveryEngine.getState().unrecoveredAmount), 0.7);
  });

  it("keeps browser timezone offsets independent", () => {
    inBrowserSession(sessionA, () => setTzOffset(-180));
    inBrowserSession(sessionB, () => setTzOffset(300));
    assert.equal(inBrowserSession(sessionA, getTzOffset), -180);
    assert.equal(inBrowserSession(sessionB, getTzOffset), 300);
  });
});

describe("autonomous market universe", () => {
  it("keeps Jump 100 manual-only while retaining it in the full catalog", () => {
    assert.equal(DERIV_MARKETS.some((market) => market.symbol === "JD100"), true);
    assert.equal(isAutomatedMarket("JD100"), false);
    assert.equal(AUTOMATED_DERIV_MARKETS.some((market) => market.symbol === "JD100"), false);
  });

  it("includes the three requested 1-second volatility indices", () => {
    for (const symbol of ["1HZ15V", "1HZ30V", "1HZ90V"]) {
      assert.equal(isAutomatedMarket(symbol), true, `${symbol} should be automated-eligible`);
    }
    assert.equal(DERIV_MARKETS.length, 20);
    assert.equal(AUTOMATED_DERIV_MARKETS.length, 19);
  });
});

describe("engine arbiter — one executor per account", () => {
  it("refuses a second engine while one is trading", () => {
    assert.equal(acquireTradingOwnership("autonomous"), true);
    assert.equal(currentTradingOwner(), "autonomous");
    assert.equal(acquireTradingOwnership("neuroai"), false);
    releaseTradingOwnership("autonomous");
    assert.equal(currentTradingOwner(), null);
    assert.equal(acquireTradingOwnership("neuroai"), true);
  });

  it("re-acquiring by the same owner is idempotent", () => {
    assert.equal(acquireTradingOwnership("neuroai"), true);
    assert.equal(acquireTradingOwnership("neuroai"), true);
    assert.equal(hasTradingOwnership("neuroai"), true);
    assert.equal(hasTradingOwnership("autonomous"), false);
  });

  it("release by the non-owner is a no-op", () => {
    acquireTradingOwnership("autonomous");
    releaseTradingOwnership("neuroai");
    assert.equal(currentTradingOwner(), "autonomous");
  });

  it("ownership is free again after the owner releases", () => {
    acquireTradingOwnership("neuroai");
    releaseTradingOwnership("neuroai");
    assert.equal(acquireTradingOwnership("autonomous"), true);
  });
});
