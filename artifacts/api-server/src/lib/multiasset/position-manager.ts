/**
 * Desk v4 — the position-management state machine (WP0).
 *
 * This module is the SINGLE source of truth for what happens to an open
 * position after it fills: break-even, partial exits, the ATR chandelier
 * trail, the time stop, session/news flattening, regime exit and the optional
 * pyramid add.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * Before this file, `agent.ts` computed a `ManagementPlan` for every armed plan
 * and the EA then threw it away: `ExecutePlan()` cleared `active` on the plan
 * the instant it filled, and `ManageOpenPositions()` looked the plan up through
 * `FindPlanForSymbol()`, which requires `active`. So the only management that
 * ever ran was a hard-coded break-even at +1.0R/+0.2R — and only for as long as
 * some *other* plan for the same symbol happened to be armed. Partials, the
 * trail, the time stop, pyramiding and `flatBeforeSessionClose` were produced by
 * the server and executed nowhere at all.
 *
 * The fix is not "keep the plan object around". A plan is an INTENT that expires;
 * a position is a COMMITMENT that outlives it. This module consumes a
 * `PositionState` — written once, at fill, from the plan — and answers one
 * question per tick: given the position, the market and the rules captured at
 * fill, what must be done NOW?
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 *  • PURE and DETERMINISTIC. No clocks, no randomness, no I/O. The same input
 *    always produces the same output, which is what makes the golden-vector
 *    test in `position-manager.test.ts` meaningful and what lets the MQL5 port
 *    in `NeurotradeBridge.mq5` be verified line by line against it.
 *  • CONSERVATIVE BY CONSTRUCTION. Every rule can only move the stop in the
 *    direction of less risk, close volume, or flatten. Nothing here can widen a
 *    stop, add risk to a losing position, or re-enter.
 *  • NO LOOKAHEAD. Every input is a value observable at the moment of the call:
 *    the live quote, the ATR of bars that have closed, the count of bars that
 *    have closed, and flags the desk has already decided. `structureConfirmed`
 *    is supplied by the caller precisely so this module never has to peek at a
 *    forming bar to decide whether structure agrees.
 *
 * The EA must mirror this function exactly. `position-manager.test.ts` carries
 * the function-by-function mapping and the golden vectors that pin both sides.
 */

import type { ManagementPlan, Side, Timeframe, TradeMode } from "./types";

// ── Phases ───────────────────────────────────────────────────────────────────

/**
 * Where a position is in its life.
 *
 * The phases are ordered by protection, not by time: a position may jump
 * straight from OPEN_RISK to RUNNER (a gap that arms break-even and the trail
 * on the same tick), and RUNNER is a superset of PARTIAL — a runner that has
 * banked a partial is still a runner.
 */
export type PositionPhase =
  /** Filled, stop still at the structural level, nothing banked. */
  | "OPEN_RISK"
  /** Break-even is in place: the stop is at entry + cost + buffer. */
  | "BE_ARMED"
  /** At least one partial has been closed. */
  | "PARTIAL"
  /** Break-even plus an active trail; the trade can no longer lose. */
  | "RUNNER"
  /** Terminal: closed by the time stop. */
  | "TIME_STOP"
  /** Terminal: closed because the regime stopped permitting the trade. */
  | "REGIME_EXIT"
  /** Terminal: closed by a session/news flat rule. */
  | "SESSION_NEWS_FLAT"
  /** A pyramid add has been taken on top of this base position. */
  | "PYRAMID";

/** Phases after which the position no longer exists. */
export const TERMINAL_PHASES: readonly PositionPhase[] = [
  "TIME_STOP",
  "REGIME_EXIT",
  "SESSION_NEWS_FLAT",
] as const;

export function isTerminalPhase(phase: PositionPhase): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase);
}

// ── Rules captured at fill ───────────────────────────────────────────────────

export interface BreakevenRule {
  /** Progress in R at which break-even may be armed. */
  triggerR: number;
  /** Extra distance beyond entry, in R, kept as a buffer. */
  offsetR: number;
  /**
   * When true, break-even waits for a CLOSED bar to confirm the trigger rather
   * than arming intrabar. "Structure confirmation" in the owner's terms: a wick
   * through the level is not structure.
   */
  structureBuffer: boolean;
}

export interface PartialRule {
  /** Progress in R at which this slice is taken. */
  atR: number;
  /** Percentage of the INITIAL volume to close. */
  closePct: number;
}

export interface TrailRule {
  mode: "atr_chandelier" | "structure" | "fixed_points";
  /** ATR period, on the ENTRY timeframe. */
  period: number;
  /** Chandelier multiple of ATR. */
  mult: number;
  /** Progress in R at which the trail activates. */
  activateAtR: number;
  /** Minimum improvement, in points, before a modify is worth sending. */
  stepPoints: number;
}

export interface PyramidRule {
  maxAdds: number;
  addAtR: number;
  /** Add size as a fraction of the base position's volume. */
  sizeRatio: number;
  requireBaseAtBreakeven: boolean;
  /** Cap on total portfolio risk in R once the add is on. */
  portfolioRiskCapR: number;
}

export interface TimeStopRule {
  /** Bars on the entry frame after which a trade that has not worked is closed. */
  noProgressBars: number;
  timeframe: Timeframe;
}

export interface ManagementGuards {
  maxSpreadPoints: number;
  newsBlackoutMin: number;
  flatBeforeSessionClose: boolean;
}

// ── Position state ───────────────────────────────────────────────────────────

/**
 * Everything the machine needs, written ONCE at fill and then carried.
 *
 * `riskPoints` and `entry` are frozen at the real fill price: a management plan
 * must never be recomputed from a later quote, because every R in it — the
 * partial ladder, the trail activation, the time-stop test — is measured
 * against the risk that was actually taken.
 */
export interface PositionState {
  ticket: number;
  symbol: string;
  planId: string;
  side: Side;
  mode: TradeMode;

  /** Real fill price. */
  entry: number;
  /** The stop the position opened with. Never moves. */
  initialSl: number;
  /** |entry − initialSl| in points, frozen at fill. */
  riskPoints: number;
  /** Broker point size for the symbol. */
  point: number;
  digits: number;

  /** Volume at fill, and what remains — both used for partial legality. */
  initialVolume: number;
  openVolume: number;

  /** Timeframe the risk was measured on. Drives the ATR used everywhere. */
  entryTimeframe: Timeframe;
  openedAtMs: number;

  /** The rules, captured from the plan at fill. */
  breakeven: BreakevenRule | null;
  partials: PartialRule[];
  trail: TrailRule | null;
  pyramid: PyramidRule | null;
  timeStop: TimeStopRule | null;
  guards: ManagementGuards;

  // ── Running state ──
  phase: PositionPhase;
  /** Where the stop is now. */
  currentSl: number;
  /** Indices into `partials` that have fired or been ruled infeasible. */
  partialsDone: number[];
  /** True once break-even has been applied. */
  beApplied: boolean;
  /** Pyramid adds taken so far. */
  pyramidAdds: number;
  /** Best favourable excursion seen, in R (MFE). */
  bestR: number;
  /** Worst adverse excursion seen, in R (MAE) — recorded for the journal. */
  worstR: number;
  /** Round-trip cost in points, captured at fill; used for the BE offset. */
  costPoints: number;
}

/** What the market and the desk are saying right now. */
export interface PositionManagerInput {
  state: PositionState;
  bid: number;
  ask: number;
  /** ATR on the ENTRY timeframe, in price units. null when not yet computed. */
  atrPrice: number | null;
  /** Closed bars on the entry frame since the position opened. */
  barsOnEntryFrame: number;
  /**
   * True when the most recent CLOSED bar on the entry frame cleared the
   * break-even trigger. Supplied by the caller so this module never reads a
   * forming bar.
   */
  structureConfirmed: boolean;

  /** Terminal conditions, decided by the desk and passed in. */
  sessionClosing: boolean;
  newsBlackout: boolean;
  regimeExit: boolean;

  /** Broker legality. */
  volumeMin: number;
  volumeStep: number;
  volumeMax: number;
  stopLevelPoints: number;
  freezeLevelPoints: number;

  /** Portfolio risk currently on the book, in R. Used by the pyramid cap. */
  portfolioRiskR: number;
  /** Spread right now, in points — a pyramid add is refused in a wide market. */
  spreadPoints: number;
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type ExitReason = "time_stop" | "regime_exit" | "session_flat" | "news_flat";

export type ManagementAction =
  | { type: "close_all"; ticket: number; reason: ExitReason; detail: string }
  | {
      type: "close_partial";
      ticket: number;
      lots: number;
      atR: number;
      reason: string;
    }
  | {
      type: "modify_sl";
      ticket: number;
      sl: number;
      reason: "breakeven" | "trail";
      detail: string;
    }
  | {
      type: "pyramid_add";
      ticket: number;
      lots: number;
      sl: number;
      reason: string;
    };

// ── Tuning constants ─────────────────────────────────────────────────────────

/**
 * A trade that has not banked this much favourable excursion, in R, by the time
 * the time stop fires is judged "not working" and closed.
 *
 * Using the BEST excursion rather than the current one is deliberate: a trade
 * that ran to +0.9R and came back to +0.1R has worked, and closing it on a
 * time stop would be the exact opposite of what the rule is for.
 */
export const TIME_STOP_MIN_PROGRESS_R = 0.5;

/** Buffer kept beyond entry+cost when break-even is applied, in R. */
export const BREAKEVEN_BUFFER_R = 0.05;

/** Minimum trail step as a fraction of the entry-frame ATR. */
export const MIN_TRAIL_STEP_ATR = 0.1;

/**
 * Tolerance for R-level comparisons.
 *
 * `(1.103 − 1.1) / (200 × 0.00001)` is 1.4999999999999445, not 1.5 — so a plan
 * that asked to bank a partial at 1.5R would sit waiting for a level that this
 * arithmetic can never quite report, and the golden vectors for it would fail
 * for a reason that has nothing to do with the policy. Levels are therefore
 * compared with a tolerance a million times finer than any price granularity:
 * the rule fires when the level is reached, not one tick later.
 */
const R_EPSILON = 1e-9;

/** True when `progress` has reached `level`, tolerant of representation error. */
function reached(progress: number, level: number): boolean {
  return progress >= level - R_EPSILON;
}

/**
 * Tolerance for broker level distances, in points. A stop measured at
 * 19.999999999997797 points against a 20-point stop level is AT the level, and
 * the broker will accept it.
 */
const LEVEL_EPSILON_POINTS = 1e-6;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Signed progress in R. Positive means the trade is winning. */
export function progressR(state: PositionState, price: number): number {
  const distance = state.side === "buy" ? price - state.entry : state.entry - price;
  return distance / (state.riskPoints * state.point);
}

/** Round a volume to the broker's step, never rounding up. */
export function quantiseVolume(lots: number, step: number, digits: number): number {
  if (step <= 0) step = 0.01;
  const quantised = Math.floor(lots / step + 1e-9) * step;
  const factor = Math.pow(10, digits);
  return Math.round(quantised * factor) / factor;
}

function volumeDigits(step: number): number {
  return step < 0.01 ? 3 : 2;
}

/** Is `candidate` a genuine tightening of `current` for this side? */
function tightens(side: Side, candidate: number, current: number, epsilon: number): boolean {
  return side === "buy" ? candidate > current + epsilon : candidate < current - epsilon;
}

/** Round a price to the symbol's digits. */
function roundToDigits(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

// ── The machine ──────────────────────────────────────────────────────────────

export interface ManagementOutcome {
  actions: ManagementAction[];
  /** The updated state. Callers persist this; it is never mutated in place. */
  state: PositionState;
}

/**
 * Decide what to do with one open position, right now.
 *
 * Evaluation order is FIXED and is part of the contract:
 *   1. terminal exits (session/news flatten, regime exit, time stop)
 *   2. partials
 *   3. break-even
 *   4. trail
 *   5. pyramid
 *
 * A terminal exit short-circuits everything else: once the position is being
 * closed there is nothing left to protect, and emitting modifications against a
 * ticket that is about to disappear is how a desk double-acts on one position.
 */
export function managePosition(input: PositionManagerInput): ManagementOutcome {
  const { state } = input;
  // Work on a copy: the machine is pure, so the caller's object is untouched.
  const next: PositionState = { ...state };

  if (isTerminalPhase(next.phase)) {
    return { actions: [], state: next };
  }

  const actions: ManagementAction[] = [];
  // The price this position is closed at: a long exits on the bid, a short on
  // the ask. Every R below is measured on that side, so the journal's MFE/MAE
  // describe realisable prices rather than mid-price fiction.
  const current = state.side === "buy" ? input.bid : input.ask;
  const point = next.point;
  if (!(point > 0) || !(next.riskPoints > 0)) {
    return { actions, state: next };
  }
  const progress = progressR(next, current);

  // Track excursions even on a tick where nothing is done: they are the record
  // the journal and the research harness read back.
  next.bestR = Math.max(next.bestR, progress);
  next.worstR = Math.min(next.worstR, progress);

  /**
   * The single stop modification this tick will send.
   *
   * Break-even and the trail both want to move the same stop, and sending two
   * modifies for one tick is two broker round trips, two chances to be rejected
   * at the stop level, and — if the second one loses a race — a stop that ends
   * up looser than the first. The machine therefore keeps ONE pending
   * modification and lets each rule replace it only by something strictly
   * tighter for this side.
   */
  let pending: { sl: number; reason: "breakeven" | "trail"; detail: string } | null = null;
  const pendingSl = () => pending?.sl ?? next.currentSl;

  // ── 1. Terminal exits ──────────────────────────────────────────────────────
  if (next.guards.flatBeforeSessionClose && input.sessionClosing) {
    next.phase = "SESSION_NEWS_FLAT";
    return {
      actions: [
        {
          type: "close_all",
          ticket: next.ticket,
          reason: "session_flat",
          detail: "Session close — the plan is flat before the session ends.",
        },
      ],
      state: next,
    };
  }
  if (input.newsBlackout) {
    next.phase = "SESSION_NEWS_FLAT";
    return {
      actions: [
        {
          type: "close_all",
          ticket: next.ticket,
          reason: "news_flat",
          detail: "High-impact release — flattening rather than holding through it.",
        },
      ],
      state: next,
    };
  }
  if (input.regimeExit) {
    next.phase = "REGIME_EXIT";
    return {
      actions: [
        {
          type: "close_all",
          ticket: next.ticket,
          reason: "regime_exit",
          detail: "The regime that justified this trade no longer holds.",
        },
      ],
      state: next,
    };
  }
  if (
    next.timeStop &&
    input.barsOnEntryFrame >= next.timeStop.noProgressBars &&
    next.bestR < TIME_STOP_MIN_PROGRESS_R
  ) {
    next.phase = "TIME_STOP";
    return {
      actions: [
        {
          type: "close_all",
          ticket: next.ticket,
          reason: "time_stop",
          detail:
            `${input.barsOnEntryFrame} ${next.timeStop.timeframe} bars with no progress ` +
            `(best ${next.bestR.toFixed(2)}R < ${TIME_STOP_MIN_PROGRESS_R}R) — freeing the margin.`,
        },
      ],
      state: next,
    };
  }

  // ── 2. Partials ────────────────────────────────────────────────────────────
  // Fired in the order the server wrote them, each exactly once, and only when
  // both the closed slice and the remainder are legal broker volumes.
  for (let index = 0; index < next.partials.length; index++) {
    if (next.partialsDone.includes(index)) continue;
    const rule = next.partials[index]!;
    if (!reached(progress, rule.atR)) continue;

    const step = input.volumeStep > 0 ? input.volumeStep : 0.01;
    const slice = quantiseVolume(
      next.initialVolume * (rule.closePct / 100),
      step,
      volumeDigits(step),
    );
    const remainder = Math.round((next.openVolume - slice) * 1e9) / 1e9;

    // Inf easible now means infeasible forever: volume only ever shrinks, so a
    // slice that cannot be cut today can never be cut later. Mark it done so
    // the machine does not re-test it on every tick.
    if (slice < input.volumeMin || remainder < input.volumeMin || slice > next.openVolume) {
      next.partialsDone = [...next.partialsDone, index];
      continue;
    }

    next.partialsDone = [...next.partialsDone, index];
    next.openVolume = remainder;
    actions.push({
      type: "close_partial",
      ticket: next.ticket,
      lots: slice,
      atR: rule.atR,
      reason: `${rule.closePct}% of the position banked at ${rule.atR}R (${progress.toFixed(2)}R reached).`,
    });
    if (next.phase === "OPEN_RISK" || next.phase === "BE_ARMED") next.phase = "PARTIAL";
  }

  // ── 3. Break-even ──────────────────────────────────────────────────────────
  // The stop goes to entry + round-trip cost + a small buffer, so a stopped-out
  // break-even is a genuine scratch and not a small loss.
  if (next.breakeven && reached(progress, next.breakeven.triggerR)) {
    const confirmed = !next.breakeven.structureBuffer || input.structureConfirmed;
    if (confirmed) {
      const offset = (next.costPoints + BREAKEVEN_BUFFER_R * next.riskPoints) * point;
      const candidate = next.side === "buy" ? next.entry + offset : next.entry - offset;
      const rounded = roundToDigits(candidate, next.digits);
      if (tightens(next.side, rounded, pendingSl(), point * 0.01)) {
        pending = {
          sl: rounded,
          reason: "breakeven",
          detail:
            `${progress.toFixed(2)}R reached — stop to entry + ${next.costPoints.toFixed(1)}pt cost ` +
            `+ ${(BREAKEVEN_BUFFER_R * next.riskPoints).toFixed(1)}pt buffer.`,
        };
      }
      // The flag is set whether or not this tick's modify wins the comparison:
      // either way the stop is at or beyond entry, so the base is risk-free and
      // the pyramid rule may rely on it.
      next.beApplied = true;
      if (next.phase === "OPEN_RISK") next.phase = "BE_ARMED";
    }
  }

  // ── 4. Trail ───────────────────────────────────────────────────────────────
  // Chandelier, on the ENTRY frame's ATR — never a fixed M15. The stop may only
  // ever move in the direction of less risk, and only by at least the larger of
  // the plan's step and 0.1 ATR, so a trending market is not modified on noise.
  if (next.trail && input.atrPrice && input.atrPrice > 0 && reached(progress, next.trail.activateAtR)) {
    const chandelier =
      next.side === "buy"
        ? current - input.atrPrice * next.trail.mult
        : current + input.atrPrice * next.trail.mult;
    const atrPoints = input.atrPrice / point;
    const minStepPoints = Math.max(next.trail.stepPoints, atrPoints * MIN_TRAIL_STEP_ATR);
    const improvementPoints = Math.abs(chandelier - pendingSl()) / point;
    const rounded = roundToDigits(chandelier, next.digits);

    if (tightens(next.side, rounded, pendingSl(), 0) && improvementPoints >= minStepPoints) {
      pending = {
        sl: rounded,
        reason: "trail",
        detail:
          `Chandelier ${next.trail.mult}× ATR(${next.trail.period}) on ${next.entryTimeframe} — ` +
          `stop trailed to ${rounded} (+${improvementPoints.toFixed(1)}pt step).`,
      };
      if (next.beApplied) next.phase = "RUNNER";
    }
  }

  // The surviving modification is emitted, with the stop level checked here so
  // the EA is not handed a request the broker will refuse.
  if (pending) {
    const legal = stopIsLegal({
      side: next.side,
      price: current,
      sl: pending.sl,
      point,
      stopLevelPoints: input.stopLevelPoints,
      freezeLevelPoints: input.freezeLevelPoints,
    });
    if (legal) {
      actions.push({
        type: "modify_sl",
        ticket: next.ticket,
        sl: pending.sl,
        reason: pending.reason,
        detail: pending.detail,
      });
      next.currentSl = pending.sl;
    }
  }

  // ── 5. Pyramid ─────────────────────────────────────────────────────────────
  // Only in a trend, only after the base is risk-free, only while the total
  // book stays inside the portfolio cap, and never into a widening spread.
  if (
    next.pyramid &&
    next.pyramidAdds < next.pyramid.maxAdds &&
    reached(progress, next.pyramid.addAtR) &&
    (!next.pyramid.requireBaseAtBreakeven || next.beApplied) &&
    input.portfolioRiskR + 1 <= next.pyramid.portfolioRiskCapR &&
    input.spreadPoints <= next.guards.maxSpreadPoints
  ) {
    const step = input.volumeStep > 0 ? input.volumeStep : 0.01;
    const lots = quantiseVolume(
      next.initialVolume * next.pyramid.sizeRatio,
      step,
      volumeDigits(step),
    );
    if (lots >= input.volumeMin && lots <= input.volumeMax && next.openVolume + lots <= input.volumeMax) {
      next.pyramidAdds += 1;
      next.phase = "PYRAMID";
      actions.push({
        type: "pyramid_add",
        ticket: next.ticket,
        lots,
        sl: next.currentSl,
        reason:
          `Base is at break-even and ${progress.toFixed(2)}R clear — adding ${lots} lots ` +
          `(add ${next.pyramidAdds}/${next.pyramid.maxAdds}), portfolio risk capped at ${next.pyramid.portfolioRiskCapR}R.`,
      });
    }
  }

  return { actions, state: next };
}

/**
 * Does this stop sit far enough from the live price to be legal?
 *
 * The EA re-checks this against the broker before sending, and so does the
 * machine, because a modify that the broker rejects costs a round trip and
 * delays protection. Freeze level matters for the same reason: a modify inside
 * the freeze zone is refused outright.
 */
export function stopIsLegal(input: {
  side: Side;
  price: number;
  sl: number;
  point: number;
  stopLevelPoints: number;
  freezeLevelPoints: number;
}): boolean {
  const { side, price, sl, point, stopLevelPoints, freezeLevelPoints } = input;
  if (!(point > 0)) return false;
  const distancePoints = Math.abs(price - sl) / point;
  if (stopLevelPoints > 0 && distancePoints < stopLevelPoints - LEVEL_EPSILON_POINTS) return false;
  if (freezeLevelPoints > 0 && distancePoints < freezeLevelPoints - LEVEL_EPSILON_POINTS) return false;
  // The stop must be on the protecting side of the price.
  return side === "buy" ? sl < price : sl > price;
}

/**
 * Capture the rules from a plan's `management` block at fill.
 *
 * Kept here, and not in the EA's JSON reader, because the mapping from the wire
 * shape to the machine's shape is a decision, and a decision made in two places
 * is a decision made differently in two places.
 */
export function positionStateFromFill(input: {
  ticket: number;
  symbol: string;
  planId: string;
  side: Side;
  mode: TradeMode;
  entry: number;
  sl: number;
  lots: number;
  point: number;
  digits: number;
  entryTimeframe: Timeframe;
  openedAtMs: number;
  costPoints: number;
  /**
   * The wire shape, straight from `ArmedPlan.management`. `BreakevenRule`,
   * `PartialRule`, `TrailRule`, `PyramidRule`, `TimeStopRule` and
   * `ManagementGuards` are structural aliases of its fields — kept named here
   * because the machine reads them by role, not by where they arrived from.
   */
  management: ManagementPlan;
}): PositionState {
  const riskPoints = Math.abs(input.entry - input.sl) / input.point;
  return {
    ticket: input.ticket,
    symbol: input.symbol,
    planId: input.planId,
    side: input.side,
    mode: input.mode,
    entry: input.entry,
    initialSl: input.sl,
    riskPoints,
    point: input.point,
    digits: input.digits,
    initialVolume: input.lots,
    openVolume: input.lots,
    entryTimeframe: input.entryTimeframe,
    openedAtMs: input.openedAtMs,
    breakeven: input.management.breakeven,
    partials: [...input.management.partials].sort((a, b) => a.atR - b.atR),
    trail: input.management.trail,
    pyramid: input.management.pyramid,
    timeStop: input.management.timeStop,
    guards: input.management.guards,
    phase: "OPEN_RISK",
    currentSl: input.sl,
    partialsDone: [],
    beApplied: false,
    pyramidAdds: 0,
    bestR: 0,
    worstR: 0,
    costPoints: input.costPoints,
  };
}
