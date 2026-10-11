/**
 * Desk v4 research harness — executed-policy simulator (WP2).
 *
 * ── WHY THIS IS NOT A BACKTESTER ─────────────────────────────────────────────
 *
 * A backtester answers "what would the signal have made". This answers "what
 * would the EA have made", and the difference is the whole reason the harness
 * exists. It replays an armed plan through:
 *
 *   • the REAL entry order type (the desk arms `break` plans, i.e. stop orders
 *     beyond the market, so the fill is at the trigger + spread + slippage —
 *     not at the price the analysis saw);
 *   • the plan's own invalidation level and TTL;
 *   • the fill-time spread guard, so a plan is not filled into a runaway quote;
 *   • the SAME `position-manager.ts` state machine the EA runs — partials,
 *     break-even, the chandelier trail, the time stop — rather than an
 *     idealised "exit at target or stop" assumption;
 *   • a spread series, per-asset-class slippage, and commission.
 *
 * ── MODELLING CONVENTIONS (all conservative, all documented) ─────────────────
 *
 *   BID BARS. MetaTrader's M1 history is bid prices, so the dataset is bid. A
 *   long's entry is therefore `trigger + spread + slippage` (you buy the ask)
 *   and its exit is on the bid, which is what the bars already are. A short
 *   enters on the bid and exits on the ask.
 *
 *   PESSIMISTIC INTRABAR ORDER. Within one bar, if both the stop and the target
 *   are inside the range, the STOP is assumed to have been hit first. If both
 *   the trigger and the invalidation level are inside the range, the plan is
 *   assumed to have been INVALIDATED. Bars cannot resolve intrabar sequence, so
 *   the harness always takes the reading that flatters the strategy least.
 *
 *   MANAGEMENT RUNS ON THE FAVOURABLE EXTREME. After the exit checks, the
 *   position machine is stepped once per bar with the bar's best price for the
 *   position's side (the high for a long). A real machine is tick-driven and
 *   would act at that price; using the close instead would systematically
 *   understate both the partial ladder and the trail, which would flatter the
 *   strategy on winners and punish it on losers in ways no real terminal does.
 *
 *   ATR IS COMPUTED ONLY FROM CLOSED ENTRY-FRAME BARS, and only from bars at or
 *   before the current M1 bar. No forming bucket is ever aggregated.
 *
 *   SESSION FLAT uses the dataset's `sessionCloseHourUtc` when it has one;
 *   synthetic datasets have no session and the rule is inert. That is recorded
 *   in every report rather than assumed silently.
 *
 *   PYRAMID ADDS ARE RECORDED, NOT SIMULATED. The machine emits `pyramid_add`
 *   and the replay logs it, but an add is a SEPARATE position with its own
 *   ticket, and its P&L is not folded into the base plan's R. The reported R is
 *   therefore the base position's R and nothing else — an honest per-trade
 *   figure, and not a portfolio figure. Portfolio accounting is WP8's scope.
 */

import { atr, clamp } from "../math";
import {
  managePosition,
  positionStateFromFill,
  progressR,
  type ManagementAction,
  type PositionState,
} from "../position-manager";
import { pointValuePerLot } from "../sizing";
import {
  TIMEFRAME_MINUTES,
  type Bar,
  type ManagementPlan,
  type SymbolSpec,
  type Timeframe,
  type TradeMode,
} from "../types";
import { buildMarketView, closedSeriesAt, type MarketView } from "./market-view";
import type { Dataset, ReplayResult } from "./types";

const HIGH = 2;
const LOW = 3;
const OPEN = 1;
const CLOSE = 4;

export interface SimulatorOptions {
  /**
   * Slippage allowance in points, applied adversely to every fill and every
   * stop exit. The desk's own allowance (asset-costs) should be passed here so
   * the simulation pays what the live system pays.
   */
  slippagePoints: number;
  /**
   * When true (default), the position machine's `flatBeforeSessionClose` rule is
   * evaluated against the dataset's session close hour. Synthetic datasets have
   * none, so it is inert there regardless.
   */
  respectSessionClose?: boolean;
  /**
   * Simulated red-folder blackouts: close every open position when `barIndex %
   * newsBlackoutEveryBars === 0`. Zero (default) disables the rule, which is
   * the honest setting for a price-logic baseline; the gate is measured
   * separately by the news module's own tests.
   */
  newsBlackoutEveryBars?: number;
  /**
   * Bars of history the entries' ATR needs before the machine will act. Below
   * this the trail is skipped rather than fed a wobbly ATR.
   */
  minAtrBars?: number;
}

export const DEFAULT_SIMULATOR_OPTIONS: SimulatorOptions = {
  slippagePoints: 1,
  respectSessionClose: true,
  newsBlackoutEveryBars: 0,
  minAtrBars: 20,
};

/** The subset of an armed plan the simulator needs. Structural, not nominal. */
export interface ReplayablePlan {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  mode: TradeMode;
  trigger: number;
  triggerType: "break" | "retest" | "market";
  invalidate: number;
  sl: number;
  tp: number;
  lots: number;
  riskPoints: number;
  expiresAt: number;
  maxSpreadPoints: number;
  entryTimeframe: Timeframe;
  costPoints: number;
  management: ManagementPlan;
}

/** Index of the bar containing `ts`, or -1. Assumes contiguous M1 bars. */
function indexAtOrAfter(bars: Bar[], ts: number, from: number): number {
  for (let i = from; i < bars.length; i++) {
    if (bars[i]![0] >= ts) return i;
  }
  return -1;
}

/** Close of the last fully-formed entry-frame bar at or before M1 index `j`. */
function closedEntryBars(view: MarketView, j: number, timeframe: Timeframe): Bar[] {
  return closedSeriesAt(view, timeframe, j);
}

/**
 * Replay one plan against the bars that follow its creation.
 *
 * @param dataset       the market data
 * @param plan          the armed plan
 * @param startIndex    M1 index of the bar the plan was created on
 * @param options       simulator conventions
 */
export function replayPlan(
  dataset: Dataset,
  plan: ReplayablePlan,
  startIndex: number,
  options: Partial<SimulatorOptions> = {},
  view?: MarketView,
): ReplayResult {
  const config: SimulatorOptions = { ...DEFAULT_SIMULATOR_OPTIONS, ...options };
  const marketView = view ?? buildMarketView(dataset);
  const bars = dataset.bars;
  const spec = dataset.spec;
  const point = spec.point;
  const slippagePrice = config.slippagePoints * point;

  const empty = (reason: ReplayResult["unfilledReason"]): ReplayResult => ({
    planId: plan.id,
    filled: false,
    unfilledReason: reason,
    fillTs: null,
    fillPrice: null,
    realisedR: null,
    exitReason: null,
    exitTs: null,
    exitPrice: null,
    maeR: 0,
    mfeR: 0,
    barsHeld: 0,
    actions: [],
    bankedR: 0,
    costR: 0,
    costFlipped: false,
  });

  if (bars.length === 0 || startIndex < 0 || startIndex >= bars.length) return empty("no_data");

  // ── 1. Fill the order ──────────────────────────────────────────────────────
  let fillIndex = -1;
  let fillPrice = 0;

  for (let i = startIndex; i < bars.length; i++) {
    const bar = bars[i]!;
    const ts = bar[0]!;

    // TTL and gap: a bar that opens after the plan expired cannot fill it.
    if (ts > plan.expiresAt) return empty("expired");

    const spreadPoints = dataset.spreadPointsAt(ts);
    const spreadPrice = spreadPoints * point;
    const high = bar[HIGH]!;
    const low = bar[LOW]!;
    const open = bar[OPEN]!;

    // Invalidation is checked BEFORE the trigger inside the same bar.
    const invalidated = plan.side === "buy" ? low <= plan.invalidate : high >= plan.invalidate;
    const touched =
      plan.triggerType === "market"
        ? true
        : plan.side === "buy"
          ? high >= plan.trigger
          : low <= plan.trigger;
    if (invalidated && touched) return empty("invalidated");
    if (invalidated) return empty("invalidated");
    if (!touched) continue;

    // Fill-time spread guard: the EA refuses to fill into a quote that has run
    // away from the one the plan was armed on.
    if (plan.maxSpreadPoints > 0 && spreadPoints > plan.maxSpreadPoints) {
      return empty("spread_guard");
    }

    const bidLevel =
      plan.triggerType === "market"
        ? open
        : plan.triggerType === "retest"
          ? plan.side === "buy"
            ? Math.min(open, plan.trigger)
            : Math.max(open, plan.trigger)
          : plan.side === "buy"
            ? Math.max(open, plan.trigger)
            : Math.min(open, plan.trigger);

    // A buy pays the ask (bid + spread) and slips up; a sell receives the bid
    // and slips down.
    fillPrice =
      plan.side === "buy" ? bidLevel + spreadPrice + slippagePrice : bidLevel - slippagePrice;
    fillIndex = i;
    break;
  }

  if (fillIndex < 0) return empty("expired");

  const riskPrice = Math.abs(fillPrice - plan.sl);
  if (!(riskPrice > 0)) return empty("no_data");

  // ── 2. Capture the management state, exactly as the EA does at fill ────────
  const commissionPoints = commissionInPoints(spec);
  const costPoints = plan.costPoints > 0 ? plan.costPoints : commissionPoints;
  let state: PositionState = positionStateFromFill({
    ticket: 1,
    symbol: plan.symbol,
    planId: plan.id,
    side: plan.side,
    mode: plan.mode,
    entry: fillPrice,
    sl: plan.sl,
    lots: plan.lots,
    point,
    digits: spec.digits,
    entryTimeframe: plan.entryTimeframe,
    openedAtMs: bars[fillIndex]![0]!,
    costPoints,
    management: plan.management,
  });

  const actions: { ts: number; type: string; detail: string }[] = [
    {
      ts: bars[fillIndex]![0]!,
      type: "captured",
      detail: `Filled ${plan.side} ${plan.lots} at ${fillPrice.toFixed(spec.digits)} (trigger ${plan.trigger}, risk ${(riskPrice / point).toFixed(1)}pt).`,
    },
  ];

  /** Realised R banked by partial closes, weighted by the initial volume. */
  let bankedR = 0;
  let exitReason: ReplayResult["exitReason"] = null;
  let exitPrice: number | null = null;
  let exitTs: number | null = null;
  let maeR = 0;
  let mfeR = 0;
  let barsHeld = 0;
  /** Bars the trade ran, for the time stop — counted on the entry frame. */
  let entryBarsElapsed = 0;
  let previousEntryBarCount = closedEntryBars(marketView, fillIndex, plan.entryTimeframe).length;

  const positionR = (price: number) =>
    plan.side === "buy" ? (price - fillPrice) / riskPrice : (fillPrice - price) / riskPrice;

  // ── 3. Walk forward, running the machine ───────────────────────────────────
  for (let i = fillIndex; i < bars.length; i++) {
    const bar = bars[i]!;
    const ts = bar[0]!;
    const high = bar[HIGH]!;
    const low = bar[LOW]!;
    const spreadPoints = dataset.spreadPointsAt(ts);
    const spreadPrice = spreadPoints * point;
    const bid = bar[CLOSE]!;

    // Excursions, measured on realisable prices (a long exits on the bid).
    const favourablePrice = plan.side === "buy" ? high : low;
    const adversePrice = plan.side === "buy" ? low : high;
    mfeR = Math.max(mfeR, positionR(favourablePrice));
    maeR = Math.min(maeR, positionR(adversePrice));

    // (a) Stop and target, with the stop assumed to come first. The fill bar is
    // included: an entry bar whose range already contains the stop is treated
    // as a stop-out, which is the pessimistic reading of an ambiguous bar.
    const stopLevel = state.currentSl;
    const stopHit = plan.side === "buy" ? low <= stopLevel : high >= stopLevel;
    const targetHit = plan.side === "buy" ? high >= plan.tp : low <= plan.tp;

    if (stopHit) {
      let exit = plan.side === "buy" ? stopLevel - slippagePrice : stopLevel + slippagePrice;
      // Slippage can push the stop past the bar's own extreme; cap it there so
      // the fill stays inside a price that existed.
      exit = plan.side === "buy" ? Math.min(Math.max(exit, low), stopLevel) : Math.max(Math.min(exit, high), stopLevel);
      exitPrice = exit;
      exitReason = state.beApplied ? stopReasonAfterBreakeven(state) : "stop_loss";
      exitTs = ts;
      break;
    }
    if (targetHit) {
      exitPrice = plan.tp;
      exitReason = "take_profit";
      exitTs = ts;
      break;
    }

    // (b) The position machine.
    const entryBars = closedEntryBars(marketView, i, plan.entryTimeframe);
    const atrPrice = entryBars.length >= (config.minAtrBars ?? 20) ? atr(entryBars, 14) : null;
    if (entryBars.length > previousEntryBarCount) {
      entryBarsElapsed += entryBars.length - previousEntryBarCount;
      previousEntryBarCount = entryBars.length;
    }

    // The machine reads the price for the position's side out of bid/ask, so it
    // is handed the bar's best realisable price for that side: the high for a
    // long, the low for a short. Break-even's structure confirmation uses the
    // CLOSE, because a wick is not structure.
    const decisionPrice = favourablePrice;
    const structureConfirmed =
      state.breakeven !== null && progressR(state, bid) >= state.breakeven.triggerR;

    const hour = new Date(ts).getUTCHours();
    const sessionClosing =
      (config.respectSessionClose ?? true) &&
      typeof dataset.sessionCloseHourUtc === "number" &&
      hour >= dataset.sessionCloseHourUtc;

    const outcome = managePosition({
      state,
      bid: plan.side === "buy" ? high : bid,
      ask: plan.side === "sell" ? low : bid + spreadPrice,
      atrPrice: atrPrice && atrPrice > 0 ? atrPrice : null,
      barsOnEntryFrame: entryBarsElapsed,
      structureConfirmed,
      sessionClosing,
      newsBlackout:
        (config.newsBlackoutEveryBars ?? 0) > 0
          ? i % (config.newsBlackoutEveryBars ?? 1) === 0
          : false,
      regimeExit: false,
      volumeMin: spec.volumeMin,
      volumeStep: spec.volumeStep,
      volumeMax: spec.volumeMax,
      stopLevelPoints: spec.stopsLevel,
      freezeLevelPoints: spec.freezeLevel,
      portfolioRiskR: 0,
      spreadPoints,
    });

    state = outcome.state;

    for (const action of outcome.actions) {
      actions.push({ ts, type: action.type, detail: describeAction(action) });
      if (action.type === "close_partial") {
        // A partial fills at the price the machine acted on, i.e. the bar's
        // favourable extreme for this side.
        const slice = action.lots;
        const sliceR = (slice / state.initialVolume) * positionR(decisionPrice);
        bankedR += sliceR;
        actions.push({
          ts,
          type: "partial_banked",
          detail: `${slice} lots closed at ${decisionPrice.toFixed(spec.digits)} → +${sliceR.toFixed(2)}R banked.`,
        });
      }
      if (action.type === "close_all") {
        // A flatten is a market order, so it is charged the bar's close rather
        // than the best price the bar happened to print.
        exitReason = mapExitReason(action.reason);
        exitPrice = bid;
        exitTs = ts;
      }
    }
    if (exitReason) break;
    barsHeld += 1;
  }

  // ── 4. Handle a trade still open at the end of the data ────────────────────
  const lastBar = bars[bars.length - 1]!;
  if (!exitReason) {
    const lastSpread = dataset.spreadPointsAt(lastBar[0]!) * point;
    // Marked to market at the close, on the side that must be paid to exit.
    exitPrice = plan.side === "buy" ? lastBar[CLOSE]! : lastBar[CLOSE]! + lastSpread;
    exitReason = "end_of_data";
    exitTs = lastBar[0]!;
  }

  const exitR = positionR(exitPrice!);
  const remainingFraction = clamp(state.openVolume / state.initialVolume, 0, 1);
  const grossR = bankedR + remainingFraction * exitR;
  const costR = commissionPoints / (riskPrice / point);
  const realisedR = grossR - costR;

  return {
    planId: plan.id,
    filled: true,
    unfilledReason: null,
    fillTs: bars[fillIndex]![0]!,
    fillPrice,
    realisedR,
    exitReason,
    exitTs,
    exitPrice,
    maeR,
    mfeR,
    barsHeld,
    actions,
    bankedR,
    costR,
    costFlipped: grossR > 0 && realisedR <= 0,
  };
}

/** Was the exit a genuine break-even scratch, or a trailed stop? */
function stopReasonAfterBreakeven(state: PositionState): ReplayResult["exitReason"] {
  return state.phase === "RUNNER" ? "trail" : "break_even";
}

function mapExitReason(reason: string): ReplayResult["exitReason"] {
  switch (reason) {
    case "time_stop":
      return "time_stop";
    case "regime_exit":
      return "regime_exit";
    case "session_flat":
      return "session_flat";
    case "news_flat":
      return "news_flat";
    default:
      return null;
  }
}

function describeAction(action: ManagementAction): string {
  switch (action.type) {
    case "close_all":
      return `Close all: ${action.detail}`;
    case "close_partial":
      return `Partial ${action.lots} lots at ${action.atR}R: ${action.reason}`;
    case "modify_sl":
      return `Stop → ${action.sl} (${action.reason}): ${action.detail}`;
    case "pyramid_add":
      return `Pyramid add ${action.lots} lots: ${action.reason}`;
  }
}

/**
 * Commission expressed in points.
 *
 * `SymbolSpec.commissionPerLot` is the round-trip commission per 1.00 lot in
 * account currency; converting to points via the point value makes it directly
 * comparable with the risk unit, which is what R is measured in.
 */
export function commissionInPoints(spec: SymbolSpec): number {
  const perPoint = pointValuePerLot(spec);
  if (perPoint <= 0 || spec.point <= 0) return 0;
  return spec.commissionPerLot / perPoint;
}

/** Points per bar of an entry frame, for horizon arithmetic in reports. */
export function barsToMinutes(timeframe: Timeframe, bars: number): number {
  return bars * TIMEFRAME_MINUTES[timeframe];
}
