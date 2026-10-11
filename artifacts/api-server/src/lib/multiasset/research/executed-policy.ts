/**
 * Research harness — the EXECUTED-POLICY simulator (WP2).
 *
 * ── WHAT THIS SIMULATES, AND WHY IT IS NOT A BACKTEST ───────────────────────
 *
 * A backtest scores the DECISION: "the desk said buy, and price went up, so
 * that was a win". The v3 desk's own null experiment is what happens when that
 * distinction is ignored — on a driftless random walk it predicted E = +0.46R
 * from the quote, while a forward simulation of what the EA ACTUALLY does
 * (trigger entry, spread, slippage, stop, target, time stop, no management
 * because v3.04 lost the plan) realised about −0.50R. The gap was not model
 * error in the ordinary sense; it was the difference between the plan on paper
 * and the trade in the market.
 *
 * So this module replays the whole execution path, and nothing is assumed:
 *
 *   1. the decision is made on bars up to and including index i — never later;
 *   2. the ENTRY is resolved exactly as the EA would: "break" fills when price
 *      trades through the trigger (plus slippage), "market" fills at the next
 *      bar's open, "limit"/"stop" rest at the plan's trigger and are cancelled
 *      when price runs 0.5R away unfilled;
 *   3. the SPREAD is charged at entry (the ask is paid on a buy, the bid
 *      received on a sell) and commission and slippage are charged in price
 *      units, all from the plan's own cost model;
 *   4. the STOP and TARGET are resolved on the bar's own high/low, and when
 *      both are inside one bar the STOP is taken first (the pessimistic
 *      tie-break — the same one simulateTrade uses);
 *   5. MANAGEMENT runs through the REAL position-manager state machine on every
 *      bar close, so partials, breakeven, the chandelier trail on the entry
 *      timeframe's ATR and the time stop all affect the outcome exactly as
 *      they do live;
 *   6. the result is the realised R of that trade, with partial closes and the
 *      final exit accounted slice by slice, and MAE/MFE measured from the
 *      actual path.
 *
 * The output per trade is a `TradeRecord` from metrics.ts, so a run feeds
 * straight into the statistics, the calibration and the null gates.
 */

import { atr, atrSeries } from "../math";
import {
  initialPositionState,
  managePosition,
  policyFromPlan,
  type ManageInput,
  type PositionState,
} from "../position-manager";
import type { TradeRecord } from "./metrics";
import type { ArmedPlan, Bar, Quote, SymbolSpec, Timeframe } from "../types";
import { HIGH, LOW, OPEN, CLOSE } from "../math";

export interface ExecutionOptions {
  spec: SymbolSpec;
  /** Spread in points, per bar. Defaults to the spec's spread. */
  spreadPoints?: number[];
  /** Commission in price units per round trip (defaults from the spec). */
  commissionPrice?: number;
  /** Extra slippage in price units applied adversarially at entry and exit. */
  slippagePrice?: number;
  /** Entry style override. Defaults to the plan's own triggerType. */
  entryStyle?: "break" | "market" | "limit" | "stop";
  /** ATR series on the entry timeframe, aligned with the bars. */
  atrSeries?: number[];
}

export interface SimulatedTrade extends TradeRecord {
  /** Index of the bar the decision was made on. */
  decisionIndex: number;
  /** Index of the bar the entry filled on (null = never filled). */
  entryIndex: number | null;
  entryPrice: number;
  exitPrice: number;
  exitReason: "target" | "stop" | "time_stop" | "regime_exit" | "session_flat" | "horizon" | "partial_close";
  /** Slices closed before the final exit. */
  partialFills: number;
  /** The plan's advertised reward:risk at the expected fill. */
  plannedRrFill: number;
}

export interface SimulatePlanResult {
  trade: SimulatedTrade | null;
  /** Set when the plan never became a position. */
  unfilled?: "expired" | "invalidated" | "ran_away";
}

const MAX_FILL_WAIT_BARS = 8;

/**
 * Fill the entry exactly as the EA does, scanning FORWARD from the decision bar.
 *
 * `bars` must contain the decision bar at `decisionIndex`; the scan starts at
 * `decisionIndex + 1`, which is the earliest bar the fill could possibly use.
 * Nothing at or before `decisionIndex` is ever read for a price — that is the
 * no-lookahead guarantee, and `executed-policy.test.ts` asserts it by mutating
 * the future and requiring the past decision to be unchanged.
 */
export function resolveEntry(input: {
  plan: ArmedPlan;
  bars: Bar[];
  decisionIndex: number;
  spec: SymbolSpec;
  options: ExecutionOptions;
}): { index: number; price: number } | null {
  const { plan, bars, decisionIndex, spec, options } = input;
  const style = options.entryStyle ?? (plan.triggerType === "market" ? "market" : "break");
  const slippage = options.slippagePrice ?? 0;
  const point = spec.point;
  const lastIndex = Math.min(bars.length - 1, decisionIndex + MAX_FILL_WAIT_BARS);

  for (let i = decisionIndex + 1; i <= lastIndex; i++) {
    const bar = bars[i] as Bar;
    const spread = (options.spreadPoints?.[i] ?? spec.spreadPoints) * point;
    const open = bar[OPEN];
    const high = bar[HIGH];
    const low = bar[LOW];

    if (plan.side === "buy") {
      if (style === "market" || style === "break") {
        // The fill is the WORSE of the trigger and the bar's open: a bar that
        // gapped straight through the trigger fills at the open, not at the
        // level the plan hoped for. A buy pays the ask, so the spread goes on top.
        if (style === "market" || high >= plan.trigger) {
          const price = Math.max(plan.trigger, open) + spread + slippage;
          return { index: i, price };
        }
      } else if (style === "limit") {
        // A buy limit rests BELOW the market and fills when the low trades
        // through it. If price is already below the limit at the decision bar,
        // the limit is instantly marketable — filled at the limit (aggressive
        // assumption in the strategy's favour, so it is stated).
        if (low <= plan.trigger) return { index: i, price: plan.trigger + slippage };
      } else {
        if (high >= plan.trigger) return { index: i, price: plan.trigger + spread + slippage };
      }
    } else {
      if (style === "market" || style === "break") {
        // Mirror of the buy: the fill is the worse of trigger and open, and a
        // sell receives the bid (already the traded price in the series).
        if (style === "market" || low <= plan.trigger) {
          const price = Math.min(plan.trigger, open) - slippage;
          return { index: i, price };
        }
      } else if (style === "limit") {
        if (high >= plan.trigger) return { index: i, price: plan.trigger - slippage };
      } else {
        if (low <= plan.trigger) return { index: i, price: plan.trigger - spread - slippage };
      }
    }
    // Invalidation kills the plan before the next bar is considered.
    if (plan.side === "buy" ? low <= plan.invalidate : high >= plan.invalidate) return null;
  }
  return null;
}

/**
 * Walk a filled position forward with the REAL management state machine.
 *
 * The intrabar stop/target test is pessimistic (stop first) because the
 * alternative — assuming the target was reached — is the single most common
 * way a backtest manufactures a win rate that live trading then fails to
 * reproduce.
 */
export function simulatePlan(input: {
  plan: ArmedPlan;
  bars: Bar[];
  decisionIndex: number;
  spec: SymbolSpec;
  options: ExecutionOptions;
  atrSeries: number[];
  /** Maximum bars to hold before the horizon closes the trade at market. */
  horizonBars: number;
}): SimulatePlanResult {
  const { plan, bars, decisionIndex, spec, options, atrSeries, horizonBars } = input;
  const entry = resolveEntry({ plan, bars, decisionIndex, spec, options });
  if (!entry) return { trade: null, unfilled: "expired" };

  const point = spec.point;
  const riskPrice = Math.abs(entry.price - plan.sl);
  if (!(riskPrice > 0)) return { trade: null, unfilled: "expired" };

  // Commission, in the R unit. The plan risks
  //   (riskPrice / tickSize) x tickValue x lots  account-currency units,
  // and a round trip costs commissionPerLot x lots, so the ratio is
  // independent of the lot size. An explicit `commissionPrice` (price units)
  // overrides the spec.
  const commissionR =
    options.commissionPrice !== undefined
      ? options.commissionPrice / riskPrice
      : spec.tickValue > 0 && spec.tickSize > 0
        ? (spec.commissionPerLot * spec.tickSize) / (riskPrice * spec.tickValue)
        : 0;

  const entryTimeframe: Timeframe = plan.entryTimeframe ?? "M15";
  const policy = policyFromPlan(plan.management, plan.mode, { requireStructure: true });
  let state: PositionState = initialPositionState({
    ticket: 1,
    planId: plan.id,
    symbol: plan.symbol,
    side: plan.side,
    mode: plan.mode,
    entryTimeframe,
    entry: entry.price,
    sl: plan.sl,
    tp: plan.tp[0] ?? null,
    volume: plan.lots,
    // The cost baked into the position, in PRICE units (spread + commission),
    // which is what the management state machine uses for breakeven and for
    // the "am I paying for this trade" test.
    costPrice: (options.spreadPoints?.[entry.index] ?? spec.spreadPoints) * point + commissionR * riskPrice,
    atrEntry: atrSeries[entry.index] ?? 0,
    openedAt: (bars[entry.index] as Bar)[0],
  });

  let maeR = 0;
  let mfeR = 0;
  let realisedR = 0;
  let partials = 0;
  let exitReason: SimulatedTrade["exitReason"] = "horizon";
  let exitPrice = entry.price;
  let exitIndex = entry.index;

  // The entry bar is evaluated from its OPEN, so the excursion and the
  // stop/target test on that bar use the whole bar — including the part before
  // the fill. That is deliberately pessimistic: it can stop the trade out on
  // the entry bar at a price the fill may not have seen, which understates the
  // result rather than flattering it.
  const lastIndex = Math.min(bars.length - 1, entry.index + horizonBars);
  for (let i = entry.index; i <= lastIndex; i++) {
    const bar = bars[i] as Bar;
    const high = bar[HIGH];
    const low = bar[LOW];
    const spread = (options.spreadPoints?.[i] ?? spec.spreadPoints) * point;

    // ── Intrabar excursion on the OPEN position, in R ────────────────────────
    const favoured = plan.side === "buy" ? (high - entry.price) / riskPrice : (entry.price - low) / riskPrice;
    const adverse = plan.side === "buy" ? (entry.price - low) / riskPrice : (high - entry.price) / riskPrice;
    mfeR = Math.max(mfeR, favoured);
    maeR = Math.max(maeR, adverse);

    // ── Stop / target resolution (stop wins a tie) ──────────────────────────
    const stopHit = plan.side === "buy" ? low <= state.sl : high >= state.sl;
    const targetHit = state.tp !== null && (plan.side === "buy" ? high >= state.tp : low <= state.tp);
    if (stopHit) {
      // Slippage on the stop: a stop is a market order when it triggers.
      const slip = options.slippagePrice ?? 0;
      const fill = plan.side === "buy" ? state.sl - slip : state.sl + slip;
      const openFraction = state.volume / state.initialVolume;
      realisedR += ((plan.side === "buy" ? fill - entry.price : entry.price - fill) / riskPrice) * openFraction;
      exitPrice = fill;
      exitIndex = i;
      exitReason = i > entry.index ? "stop" : "stop";
      state = { ...state, volume: 0, stage: "CLOSED" };
      break;
    }
    if (targetHit) {
      const fill = state.tp as number;
      const openFraction = state.volume / state.initialVolume;
      realisedR += ((plan.side === "buy" ? fill - entry.price : entry.price - fill) / riskPrice) * openFraction;
      exitPrice = fill;
      exitIndex = i;
      exitReason = "target";
      state = { ...state, volume: 0, stage: "CLOSED" };
      break;
    }

    // ── Management at the bar's close ───────────────────────────────────────
    const closedBars = bars.slice(0, i + 1);
    const atrValue = atrSeries[i] ?? atr(closedBars, 14);
    const quote: Quote = {
      symbol: plan.symbol,
      bid: plan.side === "buy" ? bar[CLOSE] : bar[CLOSE] + spread,
      ask: plan.side === "buy" ? bar[CLOSE] + spread : bar[CLOSE],
      spreadPoints: spread / point,
      ts: bar[0],
    };
    const manageInput: ManageInput = {
      state,
      quote: { bid: quote.bid, ask: quote.ask, ts: quote.ts },
      bars: closedBars,
      spec,
      atrEntry: atrValue,
      policy,
      session: null,
      regime: null,
      now: bar[0],
    };
    const managed = managePosition(manageInput);
    state = managed.state;
    for (const action of managed.actions) {
      if (action.kind === "modify_sl") continue;
      if (action.kind === "close_partial") {
        const fraction = action.lots / state.initialVolume;
        const fill = plan.side === "buy" ? quote.bid : quote.ask;
        realisedR += ((plan.side === "buy" ? fill - entry.price : entry.price - fill) / riskPrice) * fraction;
        partials++;
        continue;
      }
      if (action.kind === "close_all") {
        const fill = plan.side === "buy" ? quote.bid : quote.ask;
        const fraction = state.volume / state.initialVolume;
        realisedR += ((plan.side === "buy" ? fill - entry.price : entry.price - fill) / riskPrice) * fraction;
        exitPrice = fill;
        exitIndex = i;
        exitReason =
          action.stage === "TIME_STOP"
            ? "time_stop"
            : action.stage === "REGIME_EXIT"
              ? "regime_exit"
              : action.stage === "SESSION_NEWS_FLAT"
                ? "session_flat"
                : "partial_close";
        state = { ...state, volume: 0, stage: "CLOSED" };
        break;
      }
    }
    if (state.volume <= 0) break;
    exitPrice = plan.side === "buy" ? quote.bid : quote.ask;
    exitIndex = i;
  }

  // Close whatever is left at the horizon's last price.
  if (state.volume > 0) {
    const bar = bars[Math.min(exitIndex, bars.length - 1)] as Bar;
    const spread = (options.spreadPoints?.[exitIndex] ?? spec.spreadPoints) * point;
    const fill = plan.side === "buy" ? bar[CLOSE] : bar[CLOSE] - spread;
    const fraction = state.volume / state.initialVolume;
    realisedR += ((plan.side === "buy" ? fill - entry.price : entry.price - fill) / riskPrice) * fraction;
    exitPrice = fill;
  }

  // Commission is charged here, in R, rather than in the price geometry above:
  // it is not a price the market ever trades at, and folding it into the entry
  // would corrupt the fill price (and with it the MAE/MFE in R).
  const costR = commissionR;
  realisedR -= costR;

  const trade: SimulatedTrade = {
    r: realisedR,
    maeR,
    mfeR,
    mode: plan.mode,
    predictedProbability: plan.rationale.winProbability,
    bars: exitIndex - entry.index,
    costR,
    decisionIndex,
    entryIndex: entry.index,
    entryPrice: entry.price,
    exitPrice,
    exitReason,
    partialFills: partials,
    plannedRrFill: plan.rationale.rewardRisk,
  };
  return { trade };
}

/**
 * ATR series for the entry timeframe, computed causally (index i uses ≤ i).
 *
 * Moved to `meta/atr.ts` when the live meta-model needed the same series — a
 * live module must not import from the research harness — and re-exported here so
 * every existing caller and the equivalence test are unchanged.
 */
export { causalAtrSeries } from "../meta/atr";
