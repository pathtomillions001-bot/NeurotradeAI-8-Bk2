/**
 * Multi-Asset Desk — shared transport types.
 *
 * The MT5 terminal is the Desk's market-data authority. These shapes are used
 * on both sides of the bridge so broker symbols, account figures, calendar
 * events and execution commands all retain their provenance.
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

export const ASSET_CLASSES: readonly AssetClass[] = [
  "forex",
  "metals",
  "indices",
  "commodities",
  "crypto",
  "futures",
  "stocks",
  "other",
] as const;

/**
 * A broker-market catalogue entry. It deliberately contains no quote: a
 * catalogue tells the user what their broker offers, while quotes only arrive
 * in a live MT5 heartbeat for symbols the user has selected.
 */
export interface MarketCatalogEntry {
  symbol: string;
  description: string;
  path: string;
  assetClass: AssetClass;
  tradeable: boolean;
}

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
 * The broker's own contract specification, reported by the EA for actively
 * monitored symbols. This is the single source of truth for position sizing.
 */
export interface SymbolSpec {
  symbol: string;
  assetClass: AssetClass;
  /** Smallest price increment reported by the terminal (SYMBOL_POINT). */
  point: number;
  digits: number;
  /** SYMBOL_TRADE_TICK_SIZE — price granularity used for tick valuation. */
  tickSize: number;
  /** SYMBOL_TRADE_TICK_VALUE_LOSS, already in the account currency. */
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
  /** Base/quote currency, used for exposure and red-folder news gates. */
  baseCurrency?: string;
  quoteCurrency?: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  spreadPoints: number;
  /** Broker-terminal timestamp, in epoch milliseconds. */
  ts: number;
}

/** [timestamp(ms), open, high, low, close, volume] — compact on the wire. */
export type Bar = [number, number, number, number, number, number];

export interface CandleSeries {
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
}

// ── Economic calendar / red-folder events ───────────────────────────────────

/** A high-importance event read from MT5's economic calendar. */
export interface HighImpactNewsEvent {
  id: string;
  time: number;
  currency: string;
  country: string;
  name: string;
  importance: "high";
  actual?: number | null;
  forecast?: number | null;
  previous?: number | null;
}

/**
 * The EA emits a fresh status even when there are no events. `available:false`
 * is intentionally meaningful: the server fails closed for new entries rather
 * than pretending a missing calendar means a clear calendar.
 */
export interface NewsFeed {
  available: boolean;
  checkedAt: number;
  events: HighImpactNewsEvent[];
  detail?: string;
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
 * A plan the EA holds in memory and triggers locally. The server sends the
 * conditions under which the EA may buy or sell; it never sends a blind
 * market-order instruction.
 */
export interface ArmedPlan {
  id: string;
  symbol: string;
  side: Side;
  mode: TradeMode;
  trigger: number;
  triggerType: "break" | "retest" | "market";
  confirmTicks: number;
  invalidate: number;
  sl: number;
  tp: number[];
  lots: number;
  riskMoney: number;
  riskPoints: number;
  maxSpreadPoints: number;
  maxSlippagePoints: number;
  expiresAt: number;
  createdAt: number;
  management: ManagementPlan;
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
  /** Full broker catalogue, normally supplied at pairing and optionally later. */
  catalog?: MarketCatalogEntry[];
  specs?: SymbolSpec[];
  quotes?: Quote[];
  candles?: CandleSeries[];
  news?: NewsFeed;
  positions?: Position[];
  results?: CommandResult[];
}

export interface SyncResponse {
  serverTime: number;
  commands: BridgeCommand[];
  needsHistory: boolean;
  subscriptions: { symbols: string[]; timeframes: Timeframe[] };
  /** Calendar context lets the EA report and display the same safety posture. */
  news: NewsFeed;
  limits: {
    maxDailyLossPct: number;
    maxOpenPositions: number;
    tradingEnabled: boolean;
    liveTradingEnabled: boolean;
    staleAfterMs: number;
    flatOnDisconnect: boolean;
  };
}
