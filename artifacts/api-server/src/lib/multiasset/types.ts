/**
 * Multi-Asset Desk — shared types.
 *
 * See docs/multi-asset-architecture.md. Everything here is transport-shaped:
 * these are the exact objects exchanged with the MT5 Expert Advisor and with
 * the terminal UI, so changes are protocol changes.
 */

// ── Instruments ──────────────────────────────────────────────────────────────

export type AssetClass =
  | "forex"
  | "metals"
  | "indices"
  | "commodities"
  | "crypto"
  | "futures"
  | "stocks"
  | "other";

export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";

export const TIMEFRAMES: readonly Timeframe[] = [
  "M1",
  "M5",
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
] as const;

/** Minutes per timeframe — used for horizons and time stops. */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
};

/**
 * The broker's own contract specification, reported by the EA.
 *
 * This is the single source of truth for position sizing. Nothing about an
 * instrument is inferred from its name — a symbol called "XAUUSD" can have a
 * contract size of 100 on one broker and 10 on another, and guessing is how
 * retail bots silently risk 10x what the user asked for.
 */
export interface SymbolSpec {
  symbol: string;
  assetClass: AssetClass;
  /** Smallest price increment reported by the terminal (SYMBOL_POINT). */
  point: number;
  digits: number;
  /** SYMBOL_TRADE_TICK_SIZE — price granularity used for tick valuation. */
  tickSize: number;
  /**
   * SYMBOL_TRADE_TICK_VALUE_LOSS, already expressed in the ACCOUNT currency.
   * The loss-side value is deliberate: size against the worse of the two.
   */
  tickValue: number;
  /** SYMBOL_TRADE_CONTRACT_SIZE (units per 1.00 lot). */
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  /** Minimum distance (points) between price and SL/TP. 0 = no restriction. */
  stopsLevel: number;
  /** Distance (points) inside which modify/close is rejected outright. */
  freezeLevel: number;
  /** Initial margin per lot in account currency (0 = derive from leverage). */
  marginInitial: number;
  swapLong: number;
  swapShort: number;
  /** Round-trip commission per lot in account currency. */
  commissionPerLot: number;
  /** Current spread in points. Updated on every quote. */
  spreadPoints: number;
  /** Base/quote currency, used for correlation and exposure grouping. */
  baseCurrency?: string;
  quoteCurrency?: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  spreadPoints: number;
  ts: number;
}

/** [timestamp(ms), open, high, low, close, volume] — compact on the wire. */
export type Bar = [number, number, number, number, number, number];

export interface CandleSeries {
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
}

// ── Account ──────────────────────────────────────────────────────────────────

export type AccountMode = "hedging" | "netting";

export interface AccountSnapshot {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  /** equity / margin * 100, or Infinity when no position is open. */
  marginLevel: number;
  currency: string;
  leverage: number;
  mode: AccountMode;
  /** True when the terminal reports a real-money account. */
  isLive: boolean;
  /** Equity at the start of the trading day — the daily-loss baseline. */
  dayStartEquity?: number;
  /** Highest equity ever observed — the drawdown baseline. */
  peakEquity?: number;
}

export type Side = "buy" | "sell";

export interface Position {
  ticket: number;
  symbol: string;
  side: Side;
  volume: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  swap: number;
  commission: number;
  comment?: string;
  /** Risk in account currency at open — needed to express progress in R. */
  initialRiskMoney?: number;
  /** Price distance from entry to the original SL, in points. */
  initialRiskPoints?: number;
}

// ── Trading intent ───────────────────────────────────────────────────────────

export type TradeMode = "scalp" | "intraday" | "swing";

export interface TradeIntent {
  symbol: string;
  mode: TradeMode;
  /** Base risk budget per trade as a percentage of equity. */
  riskPct: number;
  maxRiskPct: number;
}

/**
 * A plan the EA holds in memory and triggers locally.
 *
 * The server does not send "buy now" — by the time a network message lands the
 * price has moved. It sends the conditions under which the EA should buy.
 */
export interface ArmedPlan {
  id: string;
  symbol: string;
  side: Side;
  mode: TradeMode;
  /** Price that activates the order. */
  trigger: number;
  /**
   * `break`  — fire when price trades through `trigger` in the trade direction.
   * `retest` — fire when price returns to `trigger` from the trade direction.
   * `market` — fire immediately on receipt (used for exits and manual orders).
   */
  triggerType: "break" | "retest" | "market";
  /** Consecutive ticks beyond the trigger required before firing. */
  confirmTicks: number;
  /** Plan is dead if price reaches this level before triggering. */
  invalidate: number;
  sl: number;
  /** One or more take-profit levels; the first is the primary. */
  tp: number[];
  lots: number;
  /** Money at risk in account currency if the SL is hit. */
  riskMoney: number;
  riskPoints: number;
  /** Execution gates evaluated locally by the EA at trigger time. */
  maxSpreadPoints: number;
  maxSlippagePoints: number;
  /** Epoch ms after which the EA must discard the plan. */
  expiresAt: number;
  createdAt: number;
  management: ManagementPlan;
  /** Human-readable rationale shown in the terminal and journaled. */
  rationale: PlanRationale;
}

export interface PlanRationale {
  confluenceScore: number;
  grade: "A+" | "A" | "B" | "C" | "no-trade";
  regime: string;
  winProbability: number;
  expectancyR: number;
  rewardRisk: number;
  markovPersistence: number;
  /** One line per contributing factor, in display order. */
  factors: { label: string; detail: string; weight: number; aligned: boolean }[];
  warnings: string[];
}

export interface ManagementPlan {
  breakeven: { triggerR: number; offsetR: number; structureBuffer: boolean } | null;
  partials: { atR: number; closePct: number }[];
  trail:
    | {
        mode: "atr_chandelier" | "structure" | "fixed_points";
        period: number;
        mult: number;
        activateAtR: number;
        stepPoints: number;
      }
    | null;
  pyramid: {
    maxAdds: number;
    addAtR: number;
    sizeRatio: number;
    requireBaseAtBreakeven: boolean;
    portfolioRiskCapR: number;
  } | null;
  timeStop: { noProgressBars: number; timeframe: Timeframe } | null;
  guards: {
    maxSpreadPoints: number;
    newsBlackoutMin: number;
    flatBeforeSessionClose: boolean;
  };
}

// ── Bridge commands ──────────────────────────────────────────────────────────

export type BridgeCommand =
  | { id: string; type: "arm_plan"; plan: ArmedPlan }
  | { id: string; type: "cancel_plan"; planId: string }
  | {
      id: string;
      type: "open";
      symbol: string;
      side: Side;
      lots: number;
      sl: number | null;
      tp: number | null;
      maxSlippagePoints: number;
      comment?: string;
    }
  | { id: string; type: "close"; ticket: number }
  | { id: string; type: "close_partial"; ticket: number; lots: number }
  | { id: string; type: "modify"; ticket: number; sl: number | null; tp: number | null }
  | { id: string; type: "set_management"; ticket: number; management: ManagementPlan }
  | { id: string; type: "flatten_all"; reason: string };

export type CommandStatus = "filled" | "rejected" | "expired" | "skipped" | "done";

export interface CommandResult {
  commandId: string;
  status: CommandStatus;
  ticket?: number;
  price?: number;
  slippagePoints?: number;
  error?: string | null;
  ts: number;
}

// ── Sync envelopes ───────────────────────────────────────────────────────────

export interface SyncRequest {
  seq: number;
  account: AccountSnapshot;
  specs?: SymbolSpec[];
  quotes?: Quote[];
  candles?: CandleSeries[];
  positions?: Position[];
  results?: CommandResult[];
}

export interface SyncResponse {
  serverTime: number;
  commands: BridgeCommand[];
  /**
   * True when the server lacks enough history to analyse the watchlist — after
   * a restart, a re-pair, or a newly watched symbol. The EA seeds full history
   * once and then sends only the newest bars, so without this flag a restarted
   * server would be left analysing a four-bar window forever.
   */
  needsHistory: boolean;
  subscriptions: { symbols: string[]; timeframes: Timeframe[] };
  limits: {
    maxDailyLossPct: number;
    maxOpenPositions: number;
    tradingEnabled: boolean;
    liveTradingEnabled: boolean;
    staleAfterMs: number;
    flatOnDisconnect: boolean;
  };
}
