/**
 * Multi-Asset Desk v4 — position management state machine (WP0).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The v3 Desk produced a management plan with every armed plan — breakeven,
 * partials, a trailing stop, a time stop, a pyramid ladder — and the EA threw
 * all of it away at fill time. `ExecutePlan()` set `g_plans[i].active = false`,
 * and every management feature the EA had was looked up through
 * `FindPlanForSymbol()`, which required `active`. So after a fill:
 *
 *   • breakeven fell back to its hard-coded +1.0R / +0.2R defaults,
 *   • the trailing stop never ran,
 *   • partials, pyramiding, the time stop and the session flatten (which
 *     agent.ts computes on every plan) were executed NOWHERE — `set_management`
 *     existed only as a type in types.ts and as a case in the EA's command
 *     switch that did nothing.
 *
 * This module is the single, testable definition of what management SHOULD do.
 * The EA implements the same rules in MQL5 (`Pm*` functions, mapped 1:1 in
 * docs/mt5-live-desk-v4.md), and both sides are pinned by golden vectors in
 * position-manager.test.ts. Nothing here is random and nothing here reads the
 * clock: the same inputs always produce the same actions, which is what makes
 * the EA's live behaviour comparable to a backtest at all.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 *
 * `managePosition()` is PURE. It takes the position, the market as of `now`,
 * and the policy, and returns
 *
 *   • the ordered list of actions to perform, and
 *   • the next state.
 *
 * It never places an order, never reads a file and never mutates its input.
 * The EA (or the walk-forward simulator in ../research/) is the only thing that
 * executes the actions.
 *
 * ── NO LOOKAHEAD ────────────────────────────────────────────────────────────
 *
 * `bars` must contain CLOSED bars only, oldest first, and the state machine
 * only ever reads the tail of that array. Structure (§ break-even) is taken
 * from confirmed fractal swings, which by construction need `swingLookback`
 * bars AFTER the pivot — so the last completed bars can never be used as a
 * pivot. The prefix-replay test asserts the property directly: managing on a
 * truncated series produces the same actions as managing the full series at
 * the same timestamp.
 */

import { atr, clamp, lastSwing, CLOSE } from "./math";
import type { Bar, ManagementPlan, Side, SymbolSpec, Timeframe, TradeMode } from "./types";
import { TIMEFRAME_MINUTES } from "./types";

/**
 * Index of the timestamp inside a `Bar` tuple.
 *
 * `math.ts` exports OPEN/HIGH/LOW/CLOSE as indices into the OHLC *prices*, not
 * into the tuple: a bar is `[timestamp, open, high, low, close, volume]`, so
 * the clock lives at index 0. Reading `bar[OPEN]` for a timestamp silently
 * compares ~1.10 against ~1.7e12 and always returns "no bars since the fill" —
 * which is exactly how the time stop would have failed to ever fire.
 */
const BAR_TIME = 0;

// ── States ──────────────────────────────────────────────────────────────────

/**
 * The risk phase of an open position.
 *
 * The progression is monotone for the three "healthy" stages —
 * OPEN_RISK → BE_ARMED → PARTIAL → RUNNER — and each terminal exit records WHY
 * it fired, because "the trade closed" is not an audit trail.
 */
export type ManagementStage =
  | "OPEN_RISK"
  | "BE_ARMED"
  | "PARTIAL"
  | "RUNNER"
  /** An add-on has been requested and is outstanding (transient). */
  | "PYRAMID"
  | "TIME_STOP"
  | "REGIME_EXIT"
  | "SESSION_NEWS_FLAT"
  | "CLOSED";

// ── Policy ──────────────────────────────────────────────────────────────────

/**
 * The executable management policy for one position.
 *
 * It is `ManagementPlan` (the wire shape the server already sends) with one
 * v4 addition: the trail's ATR multiple is resolved per mode by the Desk, and
 * `requireStructure` records whether breakeven demands structural confirmation
 * (the v4 rule) or may fire on the R trigger alone (legacy plans).
 */
export interface ManagementPolicy extends Omit<ManagementPlan, "trail"> {
  trail: {
    mode: "atr_chandelier" | "structure" | "fixed_points";
    period: number;
    mult: number;
    activateAtR: number;
    stepPoints: number;
  } | null;
  /** v4 breakeven requires a confirmed structure shift, not just +1R. */
  requireStructure?: boolean;
  /**
   * R past `breakeven.triggerR` after which an unconfirmed structure no longer
   * blocks the stop move. Absent → `BREAKEVEN_STRUCTURE_FALLBACK_R`; `0` →
   * structure confirmation is mandatory and there is no deadline.
   */
  structureFallbackR?: number;
}

/**
 * Chandelier multiples per mode, on the ENTRY timeframe's ATR.
 *
 * The old EA trailed every mode with a hard-coded M15 ATR and a 2.5 multiple,
 * which is meaningless on a scalp (an M15 ATR is several times the scalp's
 * whole risk unit, so the trail sat below the entry and never actually
 * protected anything) and far too tight for a swing. The multiple now scales
 * with the mode, and the ATR is measured on the frame the stop was placed on.
 */
export const TRAIL_ATR_MULT: Record<TradeMode, number> = {
  scalp: 2.0,
  intraday: 2.5,
  swing: 3.0,
};

/** Trail moves must be at least this fraction of an ATR, or they are noise. */
export const TRAIL_MIN_STEP_ATR = 0.1;

/** Breakeven covers the round trip plus this much of R. */
export const BREAKEVEN_PROFIT_R = 0.05;

/**
 * The structure deadline, in R past the breakeven trigger.
 *
 * A policy that requires a confirmed structure shift is right to prefer one —
 * and wrong to wait for it forever. Past this much progress the stop moves on
 * the R trigger alone and the journal records that the confirmation was
 * deferred, so the decision is auditable rather than invisible. 0.35R is small
 * enough that the stop moves while the trade is still worth protecting and
 * large enough to give a genuine pivot one more bar to print.
 *
 * Owners set this per mode in the Desk's Auto-trader settings; `0` there means
 * "wait for structure, however long it takes".
 */
export const BREAKEVEN_STRUCTURE_FALLBACK_R = 0.35;

/** Minimum interval between stop modifications, per position. */
export const MODIFY_COOLDOWN_MS = 1500;

/** How far R must advance to justify a modification inside the cooldown. */
export const MODIFY_COOLDOWN_R = 0.5;

/** Below this R progress the time stop may fire ("no progress"). */
export const TIME_STOP_PROGRESS_R = 0.5;

/** The time stop never fires once the trade has been this far in profit. */
export const TIME_STOP_MFE_R = 1.0;

/** Structure lookback for the breakeven confirmation swing. */
export const DEFAULT_SWING_LOOKBACK = 2;

/** Flatten this many minutes before the session close (non-swing modes). */
export const FLAT_BEFORE_CLOSE_MINUTES = 15;

/** Fraction of an ATR a stop must clear the broker's stop level by. */
const STOP_LEVEL_ATR_BUFFER = 0.1;

// ── State ───────────────────────────────────────────────────────────────────

/**
 * Everything the Desk must remember about one open position.
 *
 * The EA persists exactly these fields per ticket (GlobalVariableSet, see
 * `encodePositionState`), so a terminal restart cannot lose management — which
 * is the same defect as D1 one level down: the plan was lost at fill, and a
 * restart must not lose what replaced it.
 */
export interface PositionState {
  ticket: number;
  planId: string;
  symbol: string;
  side: Side;
  mode: TradeMode;
  /** The frame the stop, ATR and time stop are measured on. */
  entryTimeframe: Timeframe;
  /** Actual fill price. */
  entry: number;
  /** The stop the plan was armed with. Never changes. */
  initialSl: number;
  /** Current stop in the market. */
  sl: number;
  tp: number | null;
  /** |entry − initialSl| in price units — the R unit. */
  riskPrice: number;
  /** Open volume, in lots. */
  volume: number;
  /** Volume at fill, in lots — the base for every percentage ladder. */
  initialVolume: number;
  openedAt: number;
  /** Closed bars of `entryTimeframe` completed since the fill. */
  barsSinceEntry: number;
  /** Progress towards target in R, at the last evaluation. */
  progressR: number;
  /** Maximum favourable excursion in R. */
  mfeR: number;
  /** Most favourable price reached (bid for a buy, ask for a sell). */
  bestPrice: number;
  stage: ManagementStage;
  partialsDone: number;
  beDone: boolean;
  trailArmed: boolean;
  pyramidAdds: number;
  closedVolume: number;
  /** Round-trip cost (spread + commission + slippage) in price units. */
  costPrice: number;
  /** ATR on the entry timeframe at fill, for the first trail evaluation. */
  atrEntry: number;
  /** Last accepted stop modification, for the cooldown and never-loosen rule. */
  lastModifyAt: number;
  lastModifyR: number;
}

/** Market and context for one evaluation. Everything is as of `now`. */
export interface ManageInput {
  state: PositionState;
  /** Live quote. `bid`/`ask` are what a close would actually get. */
  quote: { bid: number; ask: number; ts: number };
  /** CLOSED entry-timeframe bars, oldest first. */
  bars: Bar[];
  spec: Pick<
    SymbolSpec,
    "point" | "digits" | "volumeMin" | "volumeStep" | "stopsLevel" | "freezeLevel"
  >;
  /** ATR(period) on the entry timeframe, in price units, as of the last bar. */
  atrEntry: number;
  policy: ManagementPolicy;
  /** Regime permission, when the v4 regime agent is on. */
  regime?: {
    /** P(the state this agent needs) — the posterior the agent gates on. */
    requiredProbability: number;
    /** The gatekeeper's verdict at the last evaluation. */
    permit: boolean;
    /** P(a change-point inside the last 5 bars). */
    changeProbability: number;
  } | null;
  /** Session and calendar context. */
  session?: {
    /** Minutes until the trading session closes, or null when unknown. */
    minutesToSessionClose: number | null;
    inNewsBlackout: boolean;
  } | null;
  now: number;
}

/** What the executor must do. Ordered; applied top to bottom. */
export type ManagementAction =
  | {
      kind: "modify_sl";
      ticket: number;
      sl: number;
      reason: string;
      stage: ManagementStage;
    }
  | {
      kind: "close_partial";
      ticket: number;
      lots: number;
      percent: number;
      reason: string;
      stage: ManagementStage;
    }
  | {
      kind: "close_all";
      ticket: number;
      reason: string;
      stage: ManagementStage;
    }
  | {
      kind: "pyramid_add";
      ticket: number;
      sizeRatio: number;
      /** Stop the add must be placed with (the base's initial stop). */
      sl: number;
      reason: string;
      stage: ManagementStage;
    };

export interface ManageResult {
  actions: ManagementAction[];
  state: PositionState;
  /** Human-readable notes for the journal: what was considered and skipped. */
  notes: string[];
}

// ── Construction ────────────────────────────────────────────────────────────

/** Build the initial state for a filled position. Called by the EA at fill. */
export function initialPositionState(input: {
  ticket: number;
  planId: string;
  symbol: string;
  side: Side;
  mode: TradeMode;
  entryTimeframe: Timeframe;
  entry: number;
  sl: number;
  tp: number | null;
  volume: number;
  costPrice: number;
  atrEntry: number;
  openedAt: number;
}): PositionState {
  // Rounded to 12 decimal places: the subtraction of two prices that a broker
  // quotes to 5 digits leaves float dust (0.0020000000000000018), and the wire
  // format keeps 8. Rounding here makes the in-memory value and the value the
  // EA reads back after a restart the SAME number.
  const riskPrice = Number(Math.abs(input.entry - input.sl).toFixed(12));
  return {
    ticket: input.ticket,
    planId: input.planId,
    symbol: input.symbol,
    side: input.side,
    mode: input.mode,
    entryTimeframe: input.entryTimeframe,
    entry: input.entry,
    initialSl: input.sl,
    sl: input.sl,
    tp: input.tp,
    riskPrice,
    volume: input.volume,
    initialVolume: input.volume,
    openedAt: input.openedAt,
    barsSinceEntry: 0,
    progressR: 0,
    mfeR: 0,
    bestPrice: input.entry,
    stage: "OPEN_RISK",
    partialsDone: 0,
    beDone: false,
    trailArmed: false,
    pyramidAdds: 0,
    closedVolume: 0,
    costPrice: input.costPrice,
    atrEntry: input.atrEntry,
    lastModifyAt: 0,
    lastModifyR: 0,
  };
}

/**
 * Normalise a wire `ManagementPlan` into an executable policy.
 *
 * The only transformations are conservative ones: a plan with no trail gets
 * none (rather than a default that was never analysed), and the trail multiple
 * is taken from the plan when it is present but falls back to the mode table
 * when it is missing or non-positive — a trail with mult 0 would mean "move
 * the stop onto the current price", which is the one thing a trail must never
 * do.
 */
export function policyFromPlan(
  plan: ManagementPlan,
  mode: TradeMode,
  overrides: Partial<ManagementPolicy> = {},
): ManagementPolicy {
  const trail = plan.trail
    ? {
        ...plan.trail,
        mult: plan.trail.mult > 0 ? plan.trail.mult : TRAIL_ATR_MULT[mode],
        stepPoints: plan.trail.stepPoints > 0 ? plan.trail.stepPoints : 1,
      }
    : null;
  return {
    ...plan,
    trail,
    requireStructure: true,
    ...overrides,
  };
}

// ── Volume arithmetic ───────────────────────────────────────────────────────

/** Round a lot size to the broker's step, without ever rounding UP. */
export function quantiseVolume(volume: number, step: number): number {
  if (!(step > 0)) return Number(volume.toFixed(8));
  const units = Math.floor(volume / step + 1e-9);
  return Number((units * step).toFixed(8));
}

export interface PartialPlan {
  /** Lots to close, or null when the slice is not legally executable. */
  lots: number | null;
  /** True when the partial must instead close the whole position. */
  closeAll: boolean;
  reason: string;
}

/**
 * Decide the legal size of a partial close.
 *
 * Two failure modes are handled explicitly, because both are silent at the
 * broker and both leave the position in a state the plan did not intend:
 *
 *   • the slice is smaller than the broker minimum ⇒ skip it (the ladder rung
 *     is consumed, the position stays whole);
 *   • the slice would leave a remainder smaller than the broker minimum ⇒
 *     shrink the slice; if even that is impossible, close the whole position
 *     rather than sending an order that will be rejected.
 */
export function planPartialClose(input: {
  volume: number;
  initialVolume: number;
  closePct: number;
  volumeMin: number;
  volumeStep: number;
}): PartialPlan {
  const { volume, initialVolume, closePct, volumeMin, volumeStep } = input;
  const step = volumeStep > 0 ? volumeStep : 0.01;
  const min = volumeMin > 0 ? volumeMin : step;
  const desired = quantiseVolume(initialVolume * (closePct / 100), step);

  if (desired < min) {
    return {
      lots: null,
      closeAll: false,
      reason: `${closePct}% of ${initialVolume} is ${desired} lots, below the ${min}-lot minimum — rung skipped.`,
    };
  }
  if (desired >= volume) {
    // The ladder asks for the whole position (or more): that is a full exit.
    return { lots: volume, closeAll: true, reason: `${closePct}% of the base is the whole remaining position.` };
  }

  const remainder = Number((volume - desired).toFixed(8));
  if (remainder >= min) {
    return {
      lots: desired,
      closeAll: false,
      reason: `close ${closePct}% (${desired} lots), leaving ${remainder} lots open.`,
    };
  }

  // Shrink so the remainder stays legal. If that cannot be done, exit fully.
  const shrunk = quantiseVolume(volume - min, step);
  if (shrunk >= min) {
    return {
      lots: shrunk,
      closeAll: false,
      reason: `${closePct}% would leave an illegal ${remainder}-lot remainder; closing ${shrunk} lots instead.`,
    };
  }
  return {
    lots: null,
    closeAll: true,
    reason: `a partial close would leave an illegal ${remainder}-lot remainder — closing the position instead.`,
  };
}

// ── Structure ───────────────────────────────────────────────────────────────

/**
 * Has the market confirmed the shift BE demands?
 *
 * For a buy: the most recent confirmed swing LOW must sit above the entry (a
 * higher low has been established) and the last closed bar must have closed in
 * profit. This is what separates "price ticked +1R for a second" from "the
 * market has accepted the new level" — the old rule (fire breakeven at +1R,
 * no questions) is exactly how a trend-following entry gets scratched by the
 * pullback it was waiting for.
 */
export function structureConfirmed(
  bars: Bar[],
  side: Side,
  entry: number,
  swingLookback = DEFAULT_SWING_LOOKBACK,
): boolean {
  if (bars.length < swingLookback * 2 + 1) return false;
  const lastClosed = bars[bars.length - 1];
  if (!lastClosed) return false;
  const closed = lastClosed[CLOSE];
  if (side === "buy" && !(closed > entry)) return false;
  if (side === "sell" && !(closed < entry)) return false;

  const swing = lastSwing(bars, side === "buy" ? "low" : "high", swingLookback);
  if (!swing) return false;
  return side === "buy" ? swing.price > entry : swing.price < entry;
}

// ── Broker distance rules ───────────────────────────────────────────────────

/**
 * Is a candidate stop acceptable to the broker right now?
 *
 * A stop closer than `stopsLevel` points to the market is rejected outright,
 * and one inside the freeze level can lock the position out of modification
 * entirely. Both are checked against the PRICE THE STOP IS MEASURED FROM —
 * for a buy the stop must clear the bid (that is where it would fill), with an
 * extra 0.1 ATR of room so a normal tick cannot invalidate the placement
 * between deciding and sending.
 */
export function stopRespectsBroker(input: {
  spec: Pick<SymbolSpec, "point" | "stopsLevel" | "freezeLevel" | "digits">;
  side: Side;
  sl: number;
  bid: number;
  ask: number;
  atrEntry: number;
}): boolean {
  const { spec, side, sl, bid, ask, atrEntry } = input;
  const point = spec.point > 0 ? spec.point : 0;
  const buffer = Math.max(spec.stopsLevel * point, atrEntry * STOP_LEVEL_ATR_BUFFER);
  const reference = bid;
  if (side === "buy") return sl <= reference - buffer;
  return sl >= ask + buffer;
}

/** Round a price to the broker's digits. */
export function roundPrice(price: number, digits: number): number {
  return Number(price.toFixed(Math.max(0, Math.min(8, digits))));
}

// ── The state machine ───────────────────────────────────────────────────────

/**
 * Evaluate management for one position.
 *
 * Priority order — safety first, then protection, then profit-taking, then
 * trailing, then additions:
 *
 *   1. session/news flatten (the account must not carry risk through an event)
 *   2. regime exit
 *   3. time stop
 *   4. ladder partials
 *   5. breakeven
 *   6. trailing stop
 *   7. pyramid add
 *
 * At most ONE stop modification is emitted per evaluation: several would race
 * each other into the broker and the last one to land would win, which is not
 * a decision anybody made.
 */
export function managePosition(input: ManageInput): ManageResult {
  const { state, spec, policy } = input;
  const notes: string[] = [];
  const actions: ManagementAction[] = [];
  const next: PositionState = { ...state };

  const point = spec.point > 0 ? spec.point : 0;
  const long = state.side === "buy";
  // The price a close would actually get — never the mid.
  const exitPrice = long ? input.quote.bid : input.quote.ask;

  if (!(state.riskPrice > 0) || !(point > 0)) {
    return { actions, state: { ...next, stage: "CLOSED" }, notes: ["degenerate risk unit — nothing to manage"] };
  }

  // Book-keeping that must happen on every evaluation, exit or not.
  const movePrice = long ? exitPrice - state.entry : state.entry - exitPrice;
  /**
   * ── R IS ROUNDED, AND THAT IS NOT COSMETIC ────────────────────────────────
   *
   * A trade that is exactly 1R in profit evaluates to 0.9999999999999787,
   * because 1.10500 − 1.10000 is 0.004999999999999893 in binary floating point.
   * The desk's triggers are all of the form "progressR >= triggerR", so the
   * ONE reading an owner checks — "we are 1R up, why has nothing happened" —
   * was the reading that fell through the gap by 2 × 10⁻¹⁴.
   *
   * 1e-6 of R is far below any broker's price granularity (it is 0.0001% of the
   * money at risk) and far above float dust, so rounding here removes the gap
   * without moving a trigger by a measurable amount. The EA keeps more digits
   * on the wire; this is the arithmetic the rules are evaluated in.
   */
  next.progressR = Number((movePrice / state.riskPrice).toFixed(6));
  next.mfeR = Math.max(state.mfeR, next.progressR);
  next.bestPrice = long
    ? Math.max(state.bestPrice, exitPrice)
    : Math.min(state.bestPrice === state.entry ? exitPrice : state.bestPrice, exitPrice);
  next.barsSinceEntry = countBarsSince(input.bars, state.openedAt);

  // ── 1. Session / news flatten ─────────────────────────────────────────────
  const session = input.session ?? null;
  if (session) {
    const flattenForClose =
      policy.guards.flatBeforeSessionClose &&
      session.minutesToSessionClose !== null &&
      session.minutesToSessionClose <= FLAT_BEFORE_CLOSE_MINUTES &&
      state.mode !== "swing";
    const flattenForNews = session.inNewsBlackout && state.mode !== "swing";
    if (flattenForClose || flattenForNews) {
      next.stage = "SESSION_NEWS_FLAT";
      return {
        actions: [
          {
            kind: "close_all",
            ticket: state.ticket,
            reason: flattenForClose
              ? `session closes in ${session.minutesToSessionClose} min — flattening (${state.mode}).`
              : "high-impact news blackout — flattening.",
            stage: "SESSION_NEWS_FLAT",
          },
        ],
        state: next,
        notes,
      };
    }
  }

  // ── 2. Regime exit ────────────────────────────────────────────────────────
  if (input.regime) {
    const { permit, requiredProbability, changeProbability } = input.regime;
    const lost = !permit || requiredProbability < 0.4;
    const changed = changeProbability >= 0.7;
    // A runner that is already risk-free is left alone: the exit is there to
    // stop a losing trade becoming a bigger losing trade, not to cap a winner.
    if ((lost || changed) && next.progressR < 1.0) {
      next.stage = "REGIME_EXIT";
      return {
        actions: [
          {
            kind: "close_all",
            ticket: state.ticket,
            reason: changed
              ? `change-point probability ${(changeProbability * 100).toFixed(0)}% — regime no longer valid.`
              : `regime no longer permits this trade (P=${requiredProbability.toFixed(2)}) at ${next.progressR.toFixed(2)}R.`,
            stage: "REGIME_EXIT",
          },
        ],
        state: next,
        notes,
      };
    }
  }

  // ── 3. Time stop ──────────────────────────────────────────────────────────
  // `next.barsSinceEntry`, not `state.barsSinceEntry`: the bar count is
  // recomputed above from the current series, and reading the stored value
  // would lag it by exactly one evaluation — a time stop that ignores the bar
  // that just closed is a time stop that fires late.
  if (policy.timeStop && next.barsSinceEntry >= policy.timeStop.noProgressBars) {
    const stalled = next.progressR < TIME_STOP_PROGRESS_R && next.mfeR < TIME_STOP_MFE_R;
    if (stalled) {
      next.stage = "TIME_STOP";
      return {
        actions: [
          {
            kind: "close_all",
            ticket: state.ticket,
            reason: `${state.barsSinceEntry} ${policy.timeStop.timeframe} bars with no progress (${next.progressR.toFixed(2)}R, MFE ${next.mfeR.toFixed(2)}R) — time stop.`,
            stage: "TIME_STOP",
          },
        ],
        state: next,
        notes,
      };
    }
  }

  // ── 4. Ladder partials ────────────────────────────────────────────────────
  const appliedRungs = next.partialsDone;
  const rung = policy.partials[appliedRungs];
  if (rung && next.progressR >= rung.atR) {
    const plan = planPartialClose({
      volume: next.volume,
      initialVolume: next.initialVolume,
      closePct: rung.closePct,
      volumeMin: spec.volumeMin,
      volumeStep: spec.volumeStep,
    });
    if (plan.closeAll) {
      next.stage = "CLOSED";
      return {
        actions: [
          { kind: "close_all", ticket: state.ticket, reason: plan.reason, stage: "CLOSED" },
        ],
        state: next,
        notes,
      };
    }
    if (plan.lots !== null && plan.lots > 0) {
      next.partialsDone = appliedRungs + 1;
      next.volume = Number((next.volume - plan.lots).toFixed(8));
      next.closedVolume = Number((next.closedVolume + plan.lots).toFixed(8));
      if (next.stage === "OPEN_RISK" || next.stage === "BE_ARMED") next.stage = "PARTIAL";
      actions.push({
        kind: "close_partial",
        ticket: state.ticket,
        lots: plan.lots,
        percent: rung.closePct,
        reason: `${rung.atR}R ladder rung: ${plan.reason}`,
        stage: next.stage,
      });
    } else {
      // Consume the rung: it can never become executable by waiting.
      next.partialsDone = appliedRungs + 1;
      notes.push(plan.reason);
    }
  }

  // ── 5. Breakeven ──────────────────────────────────────────────────────────
  const be = policy.breakeven;
  if (be && !next.beDone && next.progressR >= be.triggerR) {
    const requireStructure = policy.requireStructure !== false && be.structureBuffer;
    const structural = requireStructure
      ? structureConfirmed(input.bars, state.side, state.entry)
      : true;
    /**
     * ── THE STRUCTURE DEADLINE ───────────────────────────────────────────────
     *
     * Waiting for a confirmed fractal pivot is the higher-quality reading of
     * "+1R", and it is also how a winning position kept its original stop
     * indefinitely: a fast frame can simply never print the pivot the rule
     * wants, so the trigger is met, the confirmation never comes, and the desk
     * does nothing. That is the reported defect ("1R in profit and no SL
     * adjustment").
     *
     * So structure remains the PREFERRED confirmation, and it now has a
     * deadline: `structureFallbackR` past the trigger, the stop moves on the R
     * trigger alone. `0` disables the fallback for an owner who genuinely wants
     * to wait. This mirrors the EA's `Pm*` implementation field for field —
     * both sides are pinned by the same golden vectors.
     */
    const fallbackR = policy.structureFallbackR ?? BREAKEVEN_STRUCTURE_FALLBACK_R;
    const deadlinePassed = fallbackR > 0 && next.progressR >= be.triggerR + fallbackR;
    const confirmed = structural || deadlinePassed;
    if (confirmed) {
      /**
       * The stop goes to entry + the round-trip cost + 0.05R.
       *
       * "+ entry" alone is not breakeven — it is breakeven MINUS the cost of
       * both sides, so a position stopped there still books a loss. Covering
       * cost first is what makes the state name true, and it is the difference
       * between a desk that scratches flat and one that slowly bleeds.
       */
      const offset = state.costPrice + BREAKEVEN_PROFIT_R * state.riskPrice;
      const candidate = long ? state.entry + offset : state.entry - offset;
      /**
       * `beDone` is set ONLY when the stop actually moved.
       *
       * It used to be set before the broker check, which would have marked a
       * position "risk-free" while the market still carried the original stop —
       * the single most dangerous state this machine can be in, because every
       * later decision (pyramid, trail arming) trusts it.
       */
      if (!stopRespectsBroker({
        spec,
        side: state.side,
        sl: candidate,
        bid: input.quote.bid,
        ask: input.quote.ask,
        atrEntry: input.atrEntry > 0 ? input.atrEntry : state.atrEntry,
      })) {
        notes.push(
          "breakeven trigger met but the candidate stop is inside the broker's stop level — retried next evaluation.",
        );
      } else if (isTighter(candidate, next.sl, state.side)) {
        next.beDone = true;
        next.sl = candidate;
        next.lastModifyAt = input.now;
        next.lastModifyR = next.progressR;
        if (next.stage === "OPEN_RISK") next.stage = "BE_ARMED";
        actions.push({
          kind: "modify_sl",
          ticket: state.ticket,
          sl: candidate,
          reason: structural
            ? `breakeven: +${next.progressR.toFixed(2)}R with structure confirmed → stop to entry + cost + ${BREAKEVEN_PROFIT_R}R.`
            : `breakeven: +${next.progressR.toFixed(2)}R — structure had not confirmed by +${(be.triggerR + fallbackR).toFixed(2)}R (deadline), stop moved anyway to entry + cost + ${BREAKEVEN_PROFIT_R}R.`,
          stage: next.stage,
        });
        if (!structural) {
          notes.push(
            `structure confirmation missed its +${(be.triggerR + fallbackR).toFixed(2)}R deadline — break-even taken on the R trigger alone.`,
          );
        }
      } else {
        next.beDone = true;
        if (next.stage === "OPEN_RISK") next.stage = "BE_ARMED";
        notes.push(
          `breakeven armed but the stop (${next.sl.toFixed(spec.digits + 1)}) already sits beyond entry + cost.`,
        );
      }
    } else {
      notes.push(
        `breakeven trigger met at ${next.progressR.toFixed(2)}R but structure has not confirmed yet.`,
      );
    }
  }

  // ── 6. Trailing stop ──────────────────────────────────────────────────────
  const trail = policy.trail;
  // A modify already emitted this evaluation wins; the trail does not race it.
  const modifyPending = actions.some((a) => a.kind === "modify_sl");
  if (trail && !modifyPending && next.progressR >= trail.activateAtR) {
    const atrValue = input.atrEntry > 0 ? input.atrEntry : atr(input.bars, trail.period);
    if (atrValue > 0) {
      const candidate = long
        ? next.bestPrice - trail.mult * atrValue
        : next.bestPrice + trail.mult * atrValue;
      const minStep = Math.max(trail.stepPoints * point, TRAIL_MIN_STEP_ATR * atrValue);
      const improvement = long ? candidate - next.sl : next.sl - candidate;
      const cooling = input.now - next.lastModifyAt < MODIFY_COOLDOWN_MS;
      const meaningful = next.progressR - next.lastModifyR >= MODIFY_COOLDOWN_R;

      if (improvement >= minStep) {
        if (cooling && !meaningful) {
          notes.push("trail move deferred: modify cooldown, no material progress since the last one.");
        } else if (!stopRespectsBroker({
          spec,
          side: state.side,
          sl: candidate,
          bid: input.quote.bid,
          ask: input.quote.ask,
          atrEntry: atrValue,
        })) {
          notes.push("trail move deferred: candidate stop is inside the broker's stop level.");
        } else {
          next.sl = candidate;
          next.trailArmed = true;
          next.lastModifyAt = input.now;
          next.lastModifyR = next.progressR;
          if (next.stage === "OPEN_RISK" || next.stage === "BE_ARMED") next.stage = "RUNNER";
          if (next.beDone && next.partialsDone > 0) next.stage = "RUNNER";
          actions.push({
            kind: "modify_sl",
            ticket: state.ticket,
            sl: candidate,
            reason: `chandelier trail: best ${next.bestPrice.toFixed(spec.digits + 1)} − ${trail.mult}×ATR(${trail.period}, ${state.entryTimeframe}) = ${candidate.toFixed(spec.digits + 1)}.`,
            stage: next.stage,
          });
        }
      }
    }
  }

  // ── 7. Pyramid ────────────────────────────────────────────────────────────
  // NOTE: an add-on is NOT a stop modification, so `modifyPending` does not
  // block it. It used to, which meant a plan whose breakeven landed on the same
  // tick as its pyramid trigger silently never pyramided at all.
  const pyramid = policy.pyramid;
  if (pyramid && next.pyramidAdds < pyramid.maxAdds) {
    // `state.beDone` — the state that came IN, not the one this evaluation just
    // produced. A breakeven that lands on the same tick as the pyramid trigger
    // has not been confirmed by the broker yet; the add waits one evaluation
    // for that, which is the conservative ordering of the two.
    const baseSafe = !pyramid.requireBaseAtBreakeven || state.beDone;
    if (baseSafe && next.progressR >= pyramid.addAtR) {
      next.pyramidAdds += 1;
      next.stage = "PYRAMID";
      actions.push({
        kind: "pyramid_add",
        ticket: state.ticket,
        sizeRatio: pyramid.sizeRatio,
        sl: state.initialSl,
        reason: `base at ${next.progressR.toFixed(2)}R and risk-free — adding ${(pyramid.sizeRatio * 100).toFixed(0)}% at the original stop (cap ${pyramid.portfolioRiskCapR}R).`,
        stage: "PYRAMID",
      });
    } else if (next.progressR >= pyramid.addAtR && !baseSafe) {
      notes.push("pyramid deferred: the base position is not at breakeven yet.");
    }
  }

  // RUNNER is the resting state once the trade is both risk-free and banked.
  if (next.beDone && next.partialsDone > 0 && (next.stage === "PARTIAL" || next.stage === "BE_ARMED")) {
    next.stage = "RUNNER";
  }

  return { actions, state: next, notes };
}

/** A candidate stop that is at least as protective as the current one. */
export function isTighter(candidate: number, current: number, side: Side): boolean {
  if (!(current > 0)) return true;
  return side === "buy" ? candidate > current : candidate < current;
}

/**
 * Bars completed since `openedAt`.
 *
 * Bars are CLOSED bars timestamped at their OPEN, so a bar that opened before
 * the fill but closed after it does not count — the position was not exposed
 * for all of it.
 */
export function countBarsSince(bars: Bar[], openedAt: number): number {
  let count = 0;
  for (const bar of bars) if (bar[BAR_TIME] >= openedAt) count++;
  return count;
}

/** Minutes of one bar on a frame. Used to sanity-check time stops in tests. */
export function barMinutes(timeframe: Timeframe): number {
  return TIMEFRAME_MINUTES[timeframe];
}

// ── Persistence (the EA's GlobalVariable wire format) ───────────────────────

/**
 * Compact, MQL5-friendly encoding of a PositionState.
 *
 * The EA keeps this string in a GlobalVariable named `NTPS_<ticket>` so
 * management survives a terminal restart, a reconnect and an EA reload. It is
 * a versioned pipe-delimited record rather than JSON because the EA must parse
 * it on every tick with code it can afford to run at that rate.
 *
 * Field order is part of the contract: `position-manager.test.ts` round-trips
 * it, and the MQL5 `PmEncode`/`PmDecode` pair is tested against the same
 * expectations in ea-contract.test.ts.
 */
export const POSITION_STATE_WIRE_VERSION = "v1";

export function encodePositionState(state: PositionState): string {
  const f = [
    POSITION_STATE_WIRE_VERSION,
    String(state.ticket),
    state.planId,
    state.symbol,
    state.side === "buy" ? "b" : "s",
    state.mode === "scalp" ? "S" : state.mode === "intraday" ? "I" : "W",
    state.entryTimeframe,
    num(state.entry),
    num(state.initialSl),
    num(state.sl),
    state.tp === null ? "" : num(state.tp),
    num(state.riskPrice),
    num(state.volume),
    num(state.initialVolume),
    String(Math.round(state.openedAt)),
    String(state.barsSinceEntry),
    num(state.progressR),
    num(state.mfeR),
    num(state.bestPrice),
    state.stage,
    String(state.partialsDone),
    state.beDone ? "1" : "0",
    state.trailArmed ? "1" : "0",
    String(state.pyramidAdds),
    num(state.closedVolume),
    num(state.costPrice),
    num(state.atrEntry),
    String(Math.round(state.lastModifyAt)),
    num(state.lastModifyR),
  ];
  return f.join("|");
}

export function decodePositionState(text: string): PositionState | null {
  const f = text.split("|");
  if (f.length !== 29 || f[0] !== POSITION_STATE_WIRE_VERSION) return null;
  const side = f[4] === "b" ? "buy" : f[4] === "s" ? "sell" : null;
  if (!side) return null;
  const modeChar = f[5];
  // S = scalp, I = intraday, W = swing. It is NOT the first letter of the mode
  // name: "scalp" and "swing" both start with S, so that convention silently
  // round-tripped every scalp as a swing (and vice versa) — a mode change is a
  // different entry timeframe, a different trail multiple and a different
  // time stop, so it is the last field to guess at.
  const mode: TradeMode | null =
    modeChar === "S" ? "scalp" : modeChar === "I" ? "intraday" : modeChar === "W" ? "swing" : null;
  if (mode === null) return null;
  const stage = f[19] as ManagementStage;
  if (!VALID_STAGES.has(stage)) return null;
  // The entry timeframe decides the ATR the trail runs on and the bar budget
  // the time stop counts. An unknown frame must be rejected, not passed
  // through to a caller that would index a table with it.
  const entryTimeframe = f[6] as Timeframe;
  if (!VALID_TIMEFRAMES.has(entryTimeframe)) return null;
  const tp = f[10] === "" ? null : Number(f[10]);
  return {
    ticket: Number(f[1]),
    planId: f[2] as string,
    symbol: f[3] as string,
    side,
    mode,
    entryTimeframe,
    entry: Number(f[7]),
    initialSl: Number(f[8]),
    sl: Number(f[9]),
    tp: tp !== null && Number.isFinite(tp) ? tp : null,
    riskPrice: Number(f[11]),
    volume: Number(f[12]),
    initialVolume: Number(f[13]),
    openedAt: Number(f[14]),
    barsSinceEntry: Number(f[15]),
    progressR: Number(f[16]),
    mfeR: Number(f[17]),
    bestPrice: Number(f[18]),
    stage,
    partialsDone: Number(f[20]),
    beDone: f[21] === "1",
    trailArmed: f[22] === "1",
    pyramidAdds: Number(f[23]),
    closedVolume: Number(f[24]),
    costPrice: Number(f[25]),
    atrEntry: Number(f[26]),
    lastModifyAt: Number(f[27]),
    lastModifyR: Number(f[28]),
  };
}

const VALID_TIMEFRAMES = new Set<string>([
  "S10",
  "S30",
  "M1",
  "M2",
  "M3",
  "M5",
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
  "W1",
]);

const VALID_STAGES = new Set<string>([
  "OPEN_RISK",
  "BE_ARMED",
  "PARTIAL",
  "RUNNER",
  "PYRAMID",
  "TIME_STOP",
  "REGIME_EXIT",
  "SESSION_NEWS_FLAT",
  "CLOSED",
]);

/** Price formatting with enough digits to round-trip, none to confuse. */
function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(8)));
}

/** The GlobalVariable name the EA uses for a ticket's state. */
export function positionStateVariableName(ticket: number): string {
  return `NTPS_${ticket}`;
}

/** Clamp helper re-exported so callers do not need math.ts for one function. */
export { clamp };
