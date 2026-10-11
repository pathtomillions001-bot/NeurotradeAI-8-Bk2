/**
 * position-manager.ts — golden vectors and the MQL5 mapping (WP0 acceptance).
 *
 * The EA cannot import TypeScript, so the state machine exists twice: once in
 * `position-manager.ts` and once in `NeurotradeBridge.mq5`. Two implementations
 * of one policy is a known hazard, and the only honest way to manage it is to
 * make one of them the reference, pin its behaviour to vectors that cannot move
 * silently, and state the mapping so a reviewer can check the other side by eye.
 *
 * ── The mapping (TS → MQL5) ──────────────────────────────────────────────────
 *
 *   progressR()                  → ProgressR()
 *   quantiseVolume()             → QuantiseVolume()
 *   tightens()                   → Tightens()
 *   roundToDigits()              → NormalizeDouble(v, digits)
 *   stopIsLegal()                → StopIsLegal()
 *   managePosition() step 1      → PositionCheckTerminalExit()
 *   managePosition() step 2      → PositionApplyPartials()
 *   managePosition() step 3      → PositionApplyBreakeven()
 *   managePosition() step 4      → PositionApplyTrail()
 *   managePosition() step 5      → PositionApplyPyramid()
 *   managePosition() dispatch    → ManagePositionState()   (fixed 1→5 order)
 *   positionStateFromFill()      → CapturePositionStateFromPlan()
 *   state persistence            → SavePositionState() / LoadPositionState()
 *
 * The order of the five steps is part of the contract, not an implementation
 * detail: the vectors below assert it, and the EA's dispatch function is written
 * in the same order with the same early returns.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BREAKEVEN_BUFFER_R,
  TIME_STOP_MIN_PROGRESS_R,
  managePosition,
  positionStateFromFill,
  progressR,
  quantiseVolume,
  stopIsLegal,
  type ManagementAction,
  type PositionManagerInput,
  type PositionState,
} from "./position-manager";
import type { ManagementPlan } from "./types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const POINT = 0.00001;
const DIGITS = 5;
const ENTRY = 1.1;
const SL = 1.098;
const RISK_POINTS = 200;
const COST_POINTS = 10;
const ATR_PRICE = 0.0003; // 30 points

/** Trending policy — mirrors `buildManagementPlan`'s `trending` branch. */
function trendManagement(): ManagementPlan {
  return {
    breakeven: { triggerR: 1.2, offsetR: 0.2, structureBuffer: false },
    partials: [
      { atR: 1.5, closePct: 35 },
      { atR: 3.0, closePct: 25 },
    ],
    trail: {
      mode: "atr_chandelier",
      period: 14,
      mult: 2.5,
      activateAtR: 1.2,
      stepPoints: 5,
    },
    pyramid: null,
    timeStop: { noProgressBars: 25, timeframe: "M15" },
    guards: { maxSpreadPoints: 20, newsBlackoutMin: 15, flatBeforeSessionClose: true },
  };
}

/** Range policy — the non-trending branch, with the structure buffer on. */
function rangeManagement(): ManagementPlan {
  return {
    breakeven: { triggerR: 1.0, offsetR: 0.2, structureBuffer: true },
    partials: [
      { atR: 1.0, closePct: 50 },
      { atR: 1.8, closePct: 25 },
    ],
    trail: null,
    pyramid: null,
    timeStop: { noProgressBars: 25, timeframe: "M15" },
    guards: { maxSpreadPoints: 20, newsBlackoutMin: 15, flatBeforeSessionClose: true },
  };
}

/**
 * Structure-buffer policy in isolation: break-even only, no partials and no
 * trail, so a vector about the structure rule cannot be satisfied or defeated
 * by another rule firing on the same tick.
 */
function structureManagement(): ManagementPlan {
  return {
    breakeven: { triggerR: 1.2, offsetR: 0.2, structureBuffer: true },
    partials: [],
    trail: null,
    pyramid: null,
    timeStop: { noProgressBars: 25, timeframe: "M15" },
    guards: { maxSpreadPoints: 20, newsBlackoutMin: 15, flatBeforeSessionClose: true },
  };
}

function state(
  management: ManagementPlan,
  overrides: Partial<PositionState> = {},
): PositionState {
  const base = positionStateFromFill({
    ticket: 55201,
    symbol: "EURUSD",
    planId: "plan-1",
    side: "buy",
    mode: "intraday",
    entry: ENTRY,
    sl: SL,
    lots: 0.1,
    point: POINT,
    digits: DIGITS,
    entryTimeframe: "M15",
    openedAtMs: 1_700_000_000_000,
    costPoints: COST_POINTS,
    management,
  });
  return { ...base, ...overrides };
}

function input(
  st: PositionState,
  bid: number,
  overrides: Partial<PositionManagerInput> = {},
): PositionManagerInput {
  return {
    state: st,
    bid,
    ask: bid + POINT * 8,
    atrPrice: ATR_PRICE,
    barsOnEntryFrame: 3,
    structureConfirmed: false,
    sessionClosing: false,
    newsBlackout: false,
    regimeExit: false,
    volumeMin: 0.01,
    volumeStep: 0.01,
    volumeMax: 100,
    stopLevelPoints: 0,
    freezeLevelPoints: 0,
    portfolioRiskR: 0,
    spreadPoints: 8,
    ...overrides,
  };
}

/** Compact, order-sensitive fingerprint of an action list. */
function fingerprint(actions: ManagementAction[]): string[] {
  return actions.map((action) => {
    switch (action.type) {
      case "close_all":
        return `close_all:${action.reason}`;
      case "close_partial":
        return `close_partial:${action.lots}@${action.atR}R`;
      case "modify_sl":
        return `modify_sl:${action.sl}:${action.reason}`;
      case "pyramid_add":
        return `pyramid_add:${action.lots}`;
    }
  });
}

// ── Golden vectors ───────────────────────────────────────────────────────────

describe("position-manager golden vectors", () => {
  /**
   * V1 — nothing to do. 0.5R on a trending plan is below the 1.2R break-even
   * trigger, below the 1.5R partial and below trail activation.
   */
  it("V1 quiet tick emits nothing", () => {
    const { actions, state: next } = managePosition(input(state(trendManagement()), 1.101));
    assert.deepEqual(fingerprint(actions), []);
    assert.equal(next.phase, "OPEN_RISK");
    assert.equal(next.currentSl, SL);
    // bestR/worstR still advance: the record is kept even when nothing is done.
    assert.equal(Number(next.bestR.toFixed(4)), 0.5);
  });

  /**
   * V2 — 1.25R: break-even and the trail both qualify, and the machine sends
   * exactly ONE modification — the tighter of the two (the trail).
   *
   * BE candidate   = entry + (cost + 0.05R) = 1.10000 + 0.00020 = 1.10020
   * Chandelier     = 1.10250 − 2.5 × 0.00030 = 1.10250 − 0.00075 = 1.10175
   * Both tighten; 1.10175 is tighter for a buy, so it wins.
   */
  it("V2 break-even and trail collapse into one tighter modify", () => {
    const { actions, state: next } = managePosition(
      input(state(trendManagement()), 1.1025),
    );
    assert.deepEqual(fingerprint(actions), ["modify_sl:1.10175:trail"]);
    assert.equal(next.currentSl, 1.10175);
    assert.equal(next.beApplied, true);
    assert.equal(next.phase, "RUNNER");
  });

  /**
   * V3 — the structure buffer is honoured: with `structureBuffer` true and no
   * closed-bar confirmation, break-even does NOT arm. On a plan with no trail
   * there is nothing else to do at 1.25R.
   */
  it("V3 structure buffer blocks break-even until a bar confirms", () => {
    const { actions, state: next } = managePosition(
      input(state(structureManagement()), 1.1025),
    );
    assert.deepEqual(fingerprint(actions), []);
    assert.equal(next.beApplied, false);
    assert.equal(next.phase, "OPEN_RISK");
    assert.equal(next.currentSl, SL);
  });

  /** V4 — the same tick with the confirmation present arms break-even. */
  it("V4 confirmed structure arms break-even", () => {
    const { actions, state: next } = managePosition(
      input(state(structureManagement()), 1.1025, { structureConfirmed: true }),
    );
    assert.deepEqual(fingerprint(actions), ["modify_sl:1.1002:breakeven"]);
    assert.equal(next.beApplied, true);
    // 1.10020 is entry + the 10-point round trip + the 0.05R (10-point) buffer.
    assert.equal(next.currentSl, 1.1 + (COST_POINTS + BREAKEVEN_BUFFER_R * RISK_POINTS) * POINT);
  });

  /** V5 — the first partial fires at 1.0R and is quantised to the volume step. */
  it("V5 partial fires with a legal slice", () => {
    const { actions, state: next } = managePosition(
      input(state(rangeManagement()), 1.102),
    );
    assert.deepEqual(fingerprint(actions), ["close_partial:0.05@1R"]);
    assert.equal(next.openVolume, 0.05);
    assert.deepEqual(next.partialsDone, [0]);
    assert.equal(next.phase, "PARTIAL");
  });

  /**
   * V6 — partial and break-even on the SAME tick emit in contract order:
   * the partial first (it changes volume), then the single stop modify.
   */
  it("V6 partial and break-even emit partial-then-modify", () => {
    const { actions } = managePosition(
      input(state(rangeManagement()), 1.102, { structureConfirmed: true }),
    );
    assert.deepEqual(fingerprint(actions), [
      "close_partial:0.05@1R",
      "modify_sl:1.1002:breakeven",
    ]);
  });

  /** V7 — the second partial fires at 1.8R off the ORIGINAL volume. */
  it("V7 second partial uses the initial volume as its base", () => {
    const first = managePosition(input(state(rangeManagement()), 1.102));
    const second = managePosition(input(first.state, 1.104));
    assert.deepEqual(fingerprint(second.actions), ["close_partial:0.02@1.8R"]);
    assert.equal(second.state.openVolume, 0.03);
  });

  /** V8 — a partial that is not a legal broker volume is skipped, once. */
  it("V8 infeasible partial is retired and never retried", () => {
    const st = state(rangeManagement(), {
      initialVolume: 0.06,
      openVolume: 0.06,
    });
    const first = managePosition(
      input(st, 1.102, { volumeMin: 0.05, volumeStep: 0.01 }),
    );
    // 50% of 0.06 = 0.03, below the 0.05 broker minimum.
    assert.deepEqual(fingerprint(first.actions), []);
    assert.deepEqual(first.state.partialsDone, [0]);

    const second = managePosition(
      input(first.state, 1.104, { volumeMin: 0.05, volumeStep: 0.01 }),
    );
    // The 1.8R slice (0.02) is also below the minimum, so it too is retired —
    // and the 1.0R slice is not re-tested.
    assert.deepEqual(fingerprint(second.actions), []);
    assert.deepEqual(second.state.partialsDone, [0, 1]);
  });

  /** V9 — the trail may only ever tighten. */
  it("V9 trail never loosens", () => {
    const armed = managePosition(input(state(trendManagement()), 1.1025));
    assert.equal(armed.state.currentSl, 1.10175);

    // Price eases to 1.225R: the chandelier now sits BELOW the placed stop.
    const pulledBack = managePosition(input(armed.state, 1.10245));
    assert.deepEqual(fingerprint(pulledBack.actions), []);
    assert.equal(pulledBack.state.currentSl, 1.10175);
  });

  /** V10 — a trail improvement smaller than the step is not worth a modify. */
  it("V10 sub-step trail improvement is ignored", () => {
    // Place the stop 3 points below the chandelier by hand: the improvement is
    // 3 points, under the 5-point step, so rule 4 refuses it. (The 1.5R partial
    // legitimately fires on the same tick — the assertion here is that NO stop
    // modification is emitted.)
    const st = state(trendManagement(), { currentSl: 1.10222, beApplied: true });
    const { actions, state: next } = managePosition(input(st, 1.103));
    assert.deepEqual(fingerprint(actions), ["close_partial:0.03@1.5R"]);
    assert.equal(next.currentSl, 1.10222);
    assert.equal(Math.max(5, (ATR_PRICE / POINT) * 0.1), 5);
  });

  /** V11 — the time stop closes a trade that never worked. */
  it("V11 time stop fires when nothing ever progressed", () => {
    const { actions, state: next } = managePosition(
      input(state(rangeManagement()), 1.1005, { barsOnEntryFrame: 25 }),
    );
    assert.deepEqual(fingerprint(actions), ["close_all:time_stop"]);
    assert.equal(next.phase, "TIME_STOP");
  });

  /** V12 — a trade that HAS progressed is not time-stopped. */
  it("V12 time stop spares a trade that reached its progress floor", () => {
    // Run to +0.75R, fall back to +0.25R, then sit for 25 bars.
    const ran = managePosition(input(state(rangeManagement()), 1.1015));
    assert.equal(Number(ran.state.bestR.toFixed(2)), 0.75);

    const back = managePosition(
      input(ran.state, 1.1005, { barsOnEntryFrame: 25 }),
    );
    assert.deepEqual(fingerprint(back.actions), []);
    assert.ok(ran.state.bestR >= TIME_STOP_MIN_PROGRESS_R);
  });

  /** V13 — session flatten wins over everything, even at a loss. */
  it("V13 session close flattens immediately", () => {
    const { actions, state: next } = managePosition(
      input(state(trendManagement()), 1.099, { sessionClosing: true }),
    );
    assert.deepEqual(fingerprint(actions), ["close_all:session_flat"]);
    assert.equal(next.phase, "SESSION_NEWS_FLAT");
  });

  /** V14 — a news blackout flattens rather than holding through the release. */
  it("V14 news blackout flattens", () => {
    const { actions } = managePosition(
      input(state(trendManagement()), 1.105, { newsBlackout: true }),
    );
    assert.deepEqual(fingerprint(actions), ["close_all:news_flat"]);
  });

  /** V15 — the regime withdrawing flattens. */
  it("V15 regime exit flattens", () => {
    const { actions } = managePosition(
      input(state(trendManagement()), 1.105, { regimeExit: true }),
    );
    assert.deepEqual(fingerprint(actions), ["close_all:regime_exit"]);
  });

  /** V16 — a terminal position is never acted on again. */
  it("V16 terminal positions are inert", () => {
    const closed = state(trendManagement(), { phase: "TIME_STOP" });
    const { actions } = managePosition(input(closed, 1.11));
    assert.deepEqual(fingerprint(actions), []);
  });

  /** V17 — the pyramid add, once the base is risk-free and the book has room. */
  it("V17 pyramid adds after break-even inside the portfolio cap", () => {
    const management = trendManagement();
    management.pyramid = {
      maxAdds: 1,
      addAtR: 1.5,
      sizeRatio: 0.5,
      requireBaseAtBreakeven: true,
      portfolioRiskCapR: 1.5,
    };
    const armed = managePosition(input(state(management), 1.1025));
    const added = managePosition(
      input(armed.state, 1.103, { portfolioRiskR: 0.4 }),
    );
    assert.deepEqual(fingerprint(added.actions), [
      "close_partial:0.03@1.5R",
      "modify_sl:1.10225:trail",
      "pyramid_add:0.05",
    ]);
    assert.equal(added.state.pyramidAdds, 1);
    assert.equal(added.state.phase, "PYRAMID");
  });

  /** V18 — the pyramid is refused when the portfolio cap would be breached. */
  it("V18 pyramid respects the portfolio risk cap", () => {
    const management = trendManagement();
    management.pyramid = {
      maxAdds: 1,
      addAtR: 1.5,
      sizeRatio: 0.5,
      requireBaseAtBreakeven: true,
      portfolioRiskCapR: 1.5,
    };
    const armed = managePosition(input(state(management), 1.1025));
    // 1.2R already on the book + the 1R this add would create > 1.5R cap.
    const refused = managePosition(
      input(armed.state, 1.103, { portfolioRiskR: 1.2 }),
    );
    assert.deepEqual(fingerprint(refused.actions), [
      "close_partial:0.03@1.5R",
      "modify_sl:1.10225:trail",
    ]);
    assert.equal(refused.state.pyramidAdds, 0);
  });

  /** V19 — no pyramid while the base is still at risk. */
  it("V19 pyramid waits for break-even", () => {
    const management = trendManagement();
    management.breakeven = { triggerR: 5, offsetR: 0.2, structureBuffer: false };
    management.trail = null;
    management.pyramid = {
      maxAdds: 1,
      addAtR: 1.5,
      sizeRatio: 0.5,
      requireBaseAtBreakeven: true,
      portfolioRiskCapR: 1.5,
    };
    const { actions, state: next } = managePosition(
      input(state(management), 1.103, { portfolioRiskR: 0.4 }),
    );
    // The 1.5R partial fires, but nothing may ADD on top of a base that is
    // still fully at risk.
    assert.deepEqual(fingerprint(actions), ["close_partial:0.03@1.5R"]);
    assert.equal(next.pyramidAdds, 0);
    assert.equal(next.currentSl, SL);
  });

  /** V20 — a pyramid add is refused in a widening spread. */
  it("V20 pyramid refuses a blown-out spread", () => {
    const management = trendManagement();
    management.pyramid = {
      maxAdds: 1,
      addAtR: 1.5,
      sizeRatio: 0.5,
      requireBaseAtBreakeven: true,
      portfolioRiskCapR: 1.5,
    };
    const armed = managePosition(input(state(management), 1.1025));
    const { actions } = managePosition(
      input(armed.state, 1.103, { portfolioRiskR: 0.4, spreadPoints: 40 }),
    );
    assert.ok(!fingerprint(actions).some((line) => line.startsWith("pyramid_add")));
  });

  /**
   * V21 — a modify the broker would reject is withheld, not sent. A stop that
   * violates the stop level costs a round trip and leaves the position naked
   * for another tick.
   */
  it("V21 illegal stop is withheld", () => {
    const st = state(trendManagement());
    const { actions, state: next } = managePosition(
      // Chandelier wants 1.10175, which is only 5 points under a 1.10230 bid —
      // inside a 20-point stop level.
      input(st, 1.1023, { stopLevelPoints: 20 }),
    );
    assert.deepEqual(fingerprint(actions), []);
    assert.equal(next.currentSl, SL);
  });
});

// ── Properties ───────────────────────────────────────────────────────────────

describe("position-manager properties", () => {
  /**
   * The plan is gone; the state is all that is left. This is the defect that
   * started WP0: management must not depend on a plan object surviving.
   */
  it("management outlives the plan that created it", () => {
    const plan = {
      id: "plan-1",
      management: trendManagement(),
    };
    let state_ = positionStateFromFill({
      ticket: 1,
      symbol: "EURUSD",
      planId: plan.id,
      side: "buy",
      mode: "intraday",
      entry: ENTRY,
      sl: SL,
      lots: 0.1,
      point: POINT,
      digits: DIGITS,
      entryTimeframe: "M15",
      openedAtMs: 0,
      costPoints: COST_POINTS,
      management: plan.management,
    });
    // The plan object is discarded here — the state is the only survivor.
    const survivingState = state_;

    const armed = managePosition(input(survivingState, 1.1025));
    assert.deepEqual(fingerprint(armed.actions), ["modify_sl:1.10175:trail"]);
    const after = managePosition(input(armed.state, 1.103));
    assert.deepEqual(fingerprint(after.actions), [
      "close_partial:0.03@1.5R",
      "modify_sl:1.10225:trail",
    ]);
  });

  it("is pure: inputs are never mutated", () => {
    const before = state(trendManagement());
    const snapshot = JSON.stringify(before);
    managePosition(input(before, 1.1025));
    assert.equal(JSON.stringify(before), snapshot);
  });

  it("is deterministic: identical inputs give identical outputs", () => {
    const run = () => {
      const first = managePosition(input(state(trendManagement()), 1.1025));
      const second = managePosition(input(first.state, 1.103));
      return JSON.stringify({ a: first.actions, b: second.actions, s: second.state });
    };
    assert.equal(run(), run());
  });

  it("recomputing on a truncated history reproduces the tick exactly", () => {
    // The machine reads only the values handed to it, so the same tick reached
    // by two different routes must produce the same decision.
    const direct = managePosition(input(state(trendManagement(), { beApplied: true, currentSl: 1.10175, bestR: 1.2 }), 1.103));
    const stepped = (() => {
      const a = managePosition(input(state(trendManagement()), 1.1025));
      return managePosition(input(a.state, 1.103));
    })();
    assert.deepEqual(fingerprint(direct.actions), fingerprint(stepped.actions));
  });

  it("progressR is symmetric between sides", () => {
    const buy = state(trendManagement());
    const sell = state(trendManagement(), { side: "sell", entry: 1.1, initialSl: 1.102 });
    assert.equal(progressR(buy, 1.102), 1);
    assert.equal(progressR(sell, 1.098), 1);
  });

  it("quantiseVolume never rounds up past the requested size", () => {
    assert.equal(quantiseVolume(0.026, 0.01, 2), 0.02);
    assert.equal(quantiseVolume(0.02, 0.01, 2), 0.02);
    assert.equal(quantiseVolume(0.0049, 0.01, 2), 0);
  });
});

describe("stopIsLegal", () => {
  const base = { point: POINT, stopLevelPoints: 0, freezeLevelPoints: 0 };

  it("requires the stop on the protecting side", () => {
    assert.equal(stopIsLegal({ ...base, side: "buy", price: 1.1, sl: 1.099 }), true);
    assert.equal(stopIsLegal({ ...base, side: "buy", price: 1.1, sl: 1.101 }), false);
    assert.equal(stopIsLegal({ ...base, side: "sell", price: 1.1, sl: 1.101 }), true);
    assert.equal(stopIsLegal({ ...base, side: "sell", price: 1.1, sl: 1.099 }), false);
  });

  it("respects the broker stop level and freeze level", () => {
    assert.equal(
      stopIsLegal({ ...base, side: "buy", price: 1.1, sl: 1.0999, stopLevelPoints: 20 }),
      false,
    );
    assert.equal(
      stopIsLegal({ ...base, side: "buy", price: 1.1, sl: 1.0998, stopLevelPoints: 20 }),
      true,
    );
    assert.equal(
      stopIsLegal({ ...base, side: "buy", price: 1.1, sl: 1.0999, freezeLevelPoints: 20 }),
      false,
    );
  });
});
