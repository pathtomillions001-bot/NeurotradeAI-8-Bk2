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

/**
 * Desk timeframes.
 *
 * Ordered from fastest to slowest.
 *
 * `S10` / `S30` are the ten- and thirty-second frames. MetaTrader has no such
 * chart periods — its fastest period is M1 — so they are SYNTHESISED on the
 * server from the tick stream the EA already pushes on every heartbeat (see
 * subminute.ts). They exist because a scalp book has to be able to see faster
 * than a minute: "3-minute-and-below" without a sub-minute frame is really
 * "1–3 minutes", which is a slower decision than a scalper is making.
 *
 * M2/M3 exist so a scalp has 2- and 3-minute structure to place a stop against
 * rather than M1 alone. W1 gives swing trades the weekly context they are held
 * for.
 *
 * IMPORTANT: `TIMEFRAMES` below is the BROKER list — the frames the EA can
 * request history for and stream. Never add a synthetic frame to it: the EA's
 * `Period()` call would fail and the subscription contract would be wrong. Use
 * `SYNTHETIC_TIMEFRAMES` / `ALL_TIMEFRAMES` where the server-side set is meant.
 */
export type Timeframe =
  | "S10"
  | "S30"
  | "M1"
  | "M2"
  | "M3"
  | "M5"
  | "M15"
  | "M30"
  | "H1"
  | "H4"
  | "D1"
  | "W1";

/** Every timeframe the MT5 terminal can stream. The EA wire contract. */
export const TIMEFRAMES: readonly Timeframe[] = [
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
] as const;

/** Frames the server builds itself from the tick feed. Never sent to the EA. */
export const SYNTHETIC_TIMEFRAMES: readonly Timeframe[] = ["S10", "S30"] as const;

/** Broker + synthetic frames, fastest to slowest. */
export const ALL_TIMEFRAMES: readonly Timeframe[] = [
  ...SYNTHETIC_TIMEFRAMES,
  ...TIMEFRAMES,
] as const;

/** Bar width of a synthesised frame, in milliseconds. */
export const TICK_TIMEFRAME_MS: Partial<Record<Timeframe, number>> = {
  S10: 10_000,
  S30: 30_000,
};

export function isSyntheticTimeframe(timeframe: Timeframe): boolean {
  return (SYNTHETIC_TIMEFRAMES as readonly string[]).includes(timeframe);
}

/** Minutes per timeframe — used for horizons and time stops. */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  S10: 10 / 60,
  S30: 0.5,
  M1: 1,
  M2: 2,
  M3: 3,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
  W1: 10_080,
};

/**
 * The set of timeframes each trading style is actually analysed on.
 *
 * These bands are the monitoring windows the desk is specified to work in, and
 * they are exclusive — a mode looks at its own band and nothing else:
 *
 *   scalp    → S10 … M3    (ten seconds up to three minutes)
 *   intraday → M5 … M30    (five minutes to half an hour)
 *   swing    → H1 … W1     (one hour to the weekly candle)
 *
 * Nothing outside a mode's band is scored, penalised or required (see
 * confluence.ts). A scalp is never demoted because an hourly candle leans the
 * other way; that was the old bounded-context penalty and it is gone.
 */
export const MODE_ANALYSIS_TIMEFRAMES: Record<TradeMode, readonly Timeframe[]> = {
  scalp: ["S10", "S30", "M1", "M2", "M3"],
  intraday: ["M5", "M15", "M30"],
  swing: ["H1", "H4", "D1", "W1"],
} as const;

/** Human label for a mode's monitoring window, for the terminal. */
export const MODE_ANALYSIS_LABEL: Record<TradeMode, string> = {
  scalp: "S10–M3",
  intraday: "M5–M30",
  swing: "H1–W1",
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
  /**
   * Tick timestamp as a TRUE UTC epoch in milliseconds.
   *
   * MetaTrader reports `MqlTick.time_msc`, `CopyRates().time` and the economic
   * calendar in the broker's *trade server* timezone, not UTC. Treating those
   * values as epoch milliseconds shifts every timestamp by the server's GMT
   * offset (commonly ±2–3 h), which silently corrupts quote-freshness checks,
   * bar ordering and every news countdown. The EA normalises to UTC before
   * sending; the server re-validates against its own clock.
   */
  ts: number;
  /** Tick age in ms at the moment the EA sampled it. 0 when unavailable. */
  ageMs?: number;
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
 *
 * ── EMPTY IS NOT THE SAME AS CLEAR ───────────────────────────────────────────
 *
 * `rawCount` is how many rows the MT5 calendar API returned for the window,
 * before any importance filtering, and `redCount` is how many survived it.
 * Both exist because the desk was reporting "No high-impact events in the next
 * 24 hours. The gate stays armed" on terminals whose calendar read had simply
 * come back empty — MT5 returns success with a zero-length array while the
 * terminal's calendar database is still syncing, and the old code could not
 * tell that apart from a genuinely quiet day. `rawCount === 0` means "the
 * terminal could not tell us", and the desk says exactly that instead of
 * claiming an all-clear it cannot back up.
 */
export interface NewsFeed {
  available: boolean;
  checkedAt: number;
  events: HighImpactNewsEvent[];
  detail?: string;
  /** Rows the MT5 calendar returned for the window, before importance filter. */
  rawCount?: number;
  /** Rows that survived the red-folder filter. Equals events.length when sent. */
  redCount?: number;
  /**
   * The time range (UTC epoch ms) the terminal actually read.
   *
   * WHY IT MATTERS: "0 red-folder events" is only meaningful next to the window
   * it describes. An older EA read a two-hour window and reported nothing about
   * it, so the Desk printed "No high-impact events in the next 24 hours" while
   * the terminal's own calendar tab listed three red-folder releases for the
   * day. The Desk now shows the range it was given, and says plainly when that
   * range does not cover the day it claims to describe.
   */
  windowFromMs?: number | null;
  windowToMs?: number | null;
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

/**
 * The terminal's clock relationship, shipped on every heartbeat.
 *
 * `MqlTick.time_msc` is broker-server time, so the EA converts terminal
 * timestamps to UTC with `TimeTradeServer() − TimeGMT()`. Shipping that offset
 * (and the terminal's own UTC-epoch reading) lets the server detect a skewed
 * or drifting clock instead of trusting it — a terminal whose clock is wrong
 * produces quotes that look either impossibly fresh or permanently stale.
 */
export interface SyncClock {
  /** Seconds the trade server is ahead of UTC. Equals TimeTradeServer() − TimeGMT(). */
  serverUtcOffsetSeconds: number;
  /** The terminal's own reading of the current UTC time, in epoch ms. */
  terminalUtcMs: number;
  /** Human-readable broker timezone label, when the terminal exposes one. */
  label?: string;
  /**
   * The heartbeat interval the EA is actually configured with.
   *
   * Reported so the desk can size its own patience from the terminal's contract
   * instead of guessing: an EA told to beat every 10 seconds must not be
   * declared dead after 30, and one beating every 500ms should not keep a dead
   * link alive for two minutes. Absent means "unknown" — the fixed window
   * applies.
   */
  syncIntervalMs?: number;
}

export interface SyncRequest {
  seq: number;
  account: AccountSnapshot;
  /** Terminal clock context. Absent from older EAs, which are then skew-checked. */
  clock?: SyncClock;
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
