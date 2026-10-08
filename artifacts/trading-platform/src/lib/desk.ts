/**
 * Multi-Asset Desk — client-side transport shapes and API access.
 *
 * Desk data is always broker-originated. Before MT5 pairs the API returns an
 * explicit empty connection state; it never manufactures a balance, quote or
 * chart series for presentation.
 */

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export function deskUrl(path: string): string {
  return `${BASE}/api${path}`;
}

export type AssetClass = "forex" | "metals" | "indices" | "commodities" | "crypto" | "futures" | "stocks" | "other";
export const ASSET_CLASSES: AssetClass[] = ["forex", "metals", "indices", "commodities", "crypto", "futures", "stocks", "other"];
export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  forex: "Forex",
  metals: "Metals",
  indices: "Indices",
  commodities: "Commodities",
  crypto: "Crypto",
  futures: "Futures",
  stocks: "Stocks",
  other: "Other",
};

export type TradeMode = "scalp" | "intraday" | "swing";

/** Nairobi / East Africa Time. The Desk renders every timestamp here by default. */
export const DEFAULT_DESK_TIMEZONE = "Africa/Nairobi";

export const TRADE_MODES: { id: TradeMode; label: string; blurb: string }[] = [
  { id: "scalp", label: "Scalp", blurb: "10s–3min band · ~25 min horizon" },
  { id: "intraday", label: "Day", blurb: "5–30min band · ~6 hour horizon" },
  { id: "swing", label: "Swing", blurb: "1h–weekly band · multi-day horizon" },
];

/**
 * The monitoring window each style works in. These bands are EXCLUSIVE: a mode
 * scores its own band and nothing else.
 *
 * `S10`/`S30` are the ten- and thirty-second frames. MetaTrader has no period
 * faster than M1, so the server builds them from the tick stream the EA pushes
 * on every heartbeat — and withholds them entirely when the feed is too slow to
 * build them honestly, rather than pretending a one-tick "candle" is a chart.
 */
export const MODE_ANALYSIS_TIMEFRAMES: Record<TradeMode, string[]> = {
  scalp: ["S10", "S30", "M1", "M2", "M3"],
  intraday: ["M5", "M15", "M30"],
  swing: ["H1", "H4", "D1", "W1"],
};

/** Short label for a mode's band, used in the terminal header. */
export const MODE_ANALYSIS_LABEL: Record<TradeMode, string> = {
  scalp: "S10–M3",
  intraday: "M5–M30",
  swing: "H1–W1",
};

/** Every timeframe the Desk can render, fastest to slowest. */
export const DESK_TIMEFRAMES = ["S10", "S30", "M1", "M2", "M3", "M5", "M15", "M30", "H1", "H4", "D1", "W1"] as const;

export interface Market {
  symbol: string;
  description: string;
  path: string;
  assetClass: AssetClass;
  tradeable: boolean;
  selected: boolean;
  dataStatus: "live" | "warming" | "stale";
  lastQuoteAt: number | null;
}

/**
 * How trustworthy a symbol's data is right now.
 *
 * `mismatch` is the important addition: the quote has drifted away from the
 * symbol's own candles, which almost always means a cached tick, a renamed
 * broker symbol, or a contract the EA is not subscribed to. It is rendered
 * loudly and it blocks trading — a plausible-looking wrong price is far more
 * dangerous than an obvious gap.
 */
export type FeedStatus = "live" | "warming" | "stale" | "mismatch";

export interface Instrument {
  symbol: string;
  description: string;
  assetClass: AssetClass;
  digits: number | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
  changePct: number | null;
  watched: true;
  dataStatus: FeedStatus;
  lastQuoteAt: number | null;
  /** Milliseconds since the tick was taken. Drives the freshness indicator. */
  quoteAgeMs: number | null;
  /** Non-null when the quote disagrees with the symbol's own candles. */
  priceWarning: string | null;
  deviationPct: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  /** Recent closes for the compact sparkline. */
  sparkline: number[];
  contractSize: number | null;
  point: number | null;
}

/** Diagnostics for "the data looks delayed". */
export interface FeedDiagnostics {
  clockSkewMs: number | null;
  clockWarning: string | null;
  lastQuoteAgeMs: number | null;
  quoteFreshForMs: number;
}

export interface DeskTimezone {
  id: string;
  label: string;
}

export interface DeskPerformance {
  source: "mt5" | "unlinked";
  currency: string;
  equityCurve: { t: number; equity: number; balance: number }[];
  closedTrades: {
    ticket: number;
    symbol: string;
    side: "buy" | "sell";
    volume: number;
    openPrice: number;
    profit: number;
    swap: number;
    commission: number;
    rMultiple: number | null;
    openedAt: number;
    closedAt: number;
  }[];
  bySymbol: {
    symbol: string;
    trades: number;
    net: number;
    wins: number;
    losses: number;
    winRate: number;
    stats: {
      trades: number;
      wins: number;
      losses: number;
      winRate: number;
      totalR: number;
      avgR: number;
      profitFactor: number;
      sharpeLike: number;
      maxLosingStreak: number;
      maxDrawdownR: number;
    };
  }[];
  overall: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalR: number;
    avgR: number;
    profitFactor: number;
    sharpeLike: number;
    maxLosingStreak: number;
    maxDrawdownR: number;
  };
  outcomes: { key: string; symbol: string; mode: TradeMode; wins: number; losses: number; totalR: number; updatedAt: number }[];
  realisedPnl: number;
  generatedAt: number;
}

export interface DeskSeries {
  symbol: string;
  source: "mt5";
  series: Partial<Record<string, Bar[]>>;
  spec: { digits: number; point: number; contractSize: number } | null;
  quote: { bid: number; ask: number; ts: number } | null;
  health: { status: FeedStatus; ageMs: number | null; detail: string | null };
}

/** A compact OHLC bar: [time, open, high, low, close, volume]. */
export type Bar = [number, number, number, number, number, number];

/** One family of the statistical evidence ensemble. */
export interface EvidenceFactor {
  family: string;
  label: string;
  vote: -1 | 0 | 1;
  strength: number;
  reliability: number;
  weight: number;
  contribution: number;
  detail: string;
}

export interface EvidenceResult {
  symbol: string;
  mode: TradeMode;
  timeframe: string;
  direction: "up" | "down" | "none";
  confidence: number;
  raw: number;
  factors: EvidenceFactor[];
  agreeingFamilies: number;
  totalFamilies: number;
  dissentingFamilies: number;
  diagnostics: Record<string, number>;
}

export interface Account {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
  currency: string;
  leverage: number;
  mode: string;
  isLive: boolean;
  dayStartEquity?: number;
  peakEquity?: number;
}

export interface Position {
  ticket: number;
  symbol: string;
  side: "buy" | "sell";
  volume: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  swap: number;
  commission: number;
  initialRiskMoney?: number;
}

export interface ArmedPlan {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  mode: TradeMode;
  trigger: number;
  invalidate: number;
  sl: number;
  tp: number[];
  lots: number;
  riskMoney: number;
  riskPoints: number;
  expiresAt: number;
  createdAt: number;
}

export interface TimeframeView {
  timeframe: string;
  bias: "up" | "down" | "neutral";
  kind: string;
  confidence: number;
  rsi: number;
  persistence: number;
  weight: number;
  contribution: number;
  trendQuality: number;
  volatilityRatio: number;
}

export interface NewsGate {
  status: "clear" | "blackout" | "unavailable";
  blocked: boolean;
  reason: string | null;
  relevantEvents: HighImpactNewsEvent[];
  checkedAt: number | null;
}

export interface AgentDecision {
  symbol: string;
  mode: TradeMode;
  armed: boolean;
  plan: ArmedPlan | null;
  confluence: {
    direction: "up" | "down" | "none";
    score: number;
    baseScore: number;
    grade: string;
    higherTimeframeAligned: boolean;
    contextPenalty: number;
    views: (TimeframeView & { role?: "analysis" | "context" })[];
    factors: { label: string; detail: string; weight: number; aligned: boolean }[];
    warnings: string[];
  };
  monteCarlo: {
    winProbability: number;
    lossProbability: number;
    timeoutProbability: number;
    expectancyR: number;
    grossExpectancyR: number;
    rewardRisk: number;
    meanBarsToResolve: number;
  } | null;
  sizing: {
    ok: boolean;
    lots: number;
    riskMoney: number;
    riskPoints: number;
    pointValue: number;
    costMoney: number;
    marginRequired: number;
    effectiveRiskPct: number;
    explanation: string;
  } | null;
  risk: { allow: boolean; riskPct: number; scoreBump: number; reasons: string[]; breaches: string[] };
  news: NewsGate;
  /** The statistical evidence ensemble that decided this. */
  evidence: EvidenceResult | null;
  /** Blended confluence/evidence score that was actually gated on. */
  qualityScore: number;
  qualityThreshold: number;
  /** The frame the stop, the volatility and the horizon were measured on. */
  entryTimeframe: string | null;
  /** That frame's horizon, in minutes — the number the pane prints. */
  horizonMinutes: number | null;
  /** Round-trip cost as a fraction of the risk unit (0.25 = 25% of one R). */
  costR: number | null;
  /** True when the structural stop was widened to keep the risk unit real. */
  stopWidened: boolean;
  rejections: string[];
  /** Cautions recorded but not enforced. */
  warnings: string[];
  summary: string;
}

export interface RiskPolicy {
  baseRiskPct: number;
  maxRiskPct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxOpenPositions: number;
  maxPositionsPerSymbol: number;
  maxCurrencyExposurePct: number;
  haltAfterConsecutiveLosses: number;
  minMarginLevelPct: number;
  symbolCooldownMs: number;
  liveTradingEnabled: boolean;
}

export interface JournalEntry {
  id: string;
  ts: number;
  kind: "signal" | "no_trade" | "execution" | "risk" | "bridge";
  symbol: string | null;
  message: string;
}

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

export interface NewsFeed {
  available: boolean;
  checkedAt: number;
  events: HighImpactNewsEvent[];
  detail?: string;
  /**
   * Rows the MT5 calendar returned for the window, before importance filtering.
   * `0` means the terminal could not read its calendar at all — an empty list
   * that must never be rendered as an all-clear.
   */
  rawCount?: number;
  /** Rows that survived the red-folder filter. */
  redCount?: number;
}

export interface DeskStateResponse {
  source: "mt5" | "unlinked";
  terminal: {
    accountId: string;
    login: number;
    server: string;
    company: string;
    pairedAt: number;
    lastSyncAt: number;
    lastSyncAgeMs: number | null;
    /** Hard state: the terminal is gone and new analysis is paused. */
    stale: boolean;
    /**
     * Soft state: the heartbeat is late but every symbol is still gated on its
     * own quote age, so the desk keeps working. Never shown as "paused".
     */
    degraded: boolean;
    degradedAfterMs: number;
    staleAfterMs: number;
    syncIntervalMs: number | null;
  } | null;
  account: Account | null;
  mode: TradeMode;
  autoTrade: boolean;
  watchlist: string[];
  timezone: string;
  timezones: DeskTimezone[];
  market: {
    catalogCount: number;
    selectedCount: number;
    liveSymbols: number;
    warmingSymbols: number;
    staleSymbols: number;
    mismatchSymbols: number;
    quoteFreshForMs: number;
  };
  feed: FeedDiagnostics;
  positions: Position[];
  plans: ArmedPlan[];
  policy: RiskPolicy;
  risk: {
    state: {
      consecutiveLosses: number;
      suspendedSymbols: string[];
      realisedPnlToday: number;
      tradesToday: number;
      haltedUntilNextSession: boolean;
      haltReason: string | null;
    };
    budget: { usedPct: number; remainingMoney: number; limitMoney: number } | null;
    exposure: { key: string; riskMoney: number; riskPct: number }[];
  };
  news: NewsFeed;
  /**
   * The next 24 hours of red-folder events, filtered, sorted and
   * distance-stamped by the server so the calendar pane and the agent's news
   * gate describe the same window.
   */
  newsUpcoming: UpcomingNewsEvent[];
  /** Automatic best-market selection: what it last did, and its cadence. */
  autoSelect: {
    last: AutoSelectRecord | null;
    intervalMs: number;
    maxCandidates: number;
    noteIntervalMs: number;
    /** When the next pass is due, or null if none has run yet. */
    nextDueAt: number | null;
  };
  journal: JournalEntry[];
  serverTime: number;
}

export interface UpcomingNewsEvent extends HighImpactNewsEvent {
  /** Milliseconds from the response's `serverTime` to the event. */
  inMs: number;
  /** True for the very next event that has not started yet. */
  next: boolean;
  /**
   * True once the release is behind us. Passed events stay listed for the day
   * so a quiet session can be read against what already happened.
   */
  passed: boolean;
}

/** One automatic best-market pass, as reported by the desk. */
export interface AutoSelectRecord {
  at: number;
  mode: TradeMode;
  scanned: number;
  qualified: number;
  chosen: string | null;
  reason: string;
  /** Selected markets the pass could not analyse (no fresh, coherent data). */
  skipped: string[];
  ranked: {
    symbol: string;
    expectancyR: number | null;
    score: number;
    grade: string;
    armed: boolean;
  }[];
}

export interface ScanRow {
  symbol: string;
  status: FeedStatus;
  armed: boolean;
  direction: "up" | "down" | "none";
  score: number;
  grade: string;
  expectancyR: number | null;
  winProbability: number | null;
  lots: number | null;
  riskMoney: number | null;
  rejections: string[];
  summary: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(deskUrl(path), {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
      if (Array.isArray(body?.rejections) && body.rejections.length > 0) message = `${message}: ${body.rejections[0]}`;
    } catch {
      // non-JSON response
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export const deskApi = {
  state: () => request<DeskStateResponse>("/desk/state"),
  markets: () => request<{ source: "mt5" | "unlinked"; markets: Market[]; catalogCount: number }>("/desk/markets"),
  instruments: () => request<{ source: "mt5" | "unlinked"; instruments: Instrument[]; feed: FeedDiagnostics }>("/desk/instruments"),
  performance: () => request<DeskPerformance>("/desk/performance"),
  series: (symbol: string) => request<DeskSeries>(`/desk/series?symbol=${encodeURIComponent(symbol)}`),
  analysis: (symbol: string, mode: TradeMode) => request<{ source: "mt5"; horizonMinutes: number; decision: AgentDecision }>(`/desk/analysis?symbol=${encodeURIComponent(symbol)}&mode=${mode}`),
  scan: (mode: TradeMode) => request<{ mode: TradeMode; source: "mt5"; results: ScanRow[]; coverage: { selected: number; live: number; warming: number; stale: number }; scannedAt: number }>(`/desk/scan?mode=${mode}`),
  /**
   * Run the automatic best-market pass immediately.
   *
   * The pass runs by itself while auto-trade is on; this is the same pass, on
   * demand, so the user can ask "look now" without waiting for the mode's
   * interval.
   */
  autoSelect: () => request<{ mode: TradeMode; chosen: string | null; scanned: number; qualified: number; reason: string; skipped: string[]; ranked: AutoSelectRecord["ranked"]; plans: ArmedPlan[] }>("/desk/auto-select", { method: "POST" }),
  arm: (symbol: string, mode: TradeMode) => request<{ plan: ArmedPlan }>("/desk/arm", { method: "POST", body: JSON.stringify({ symbol, mode }) }),
  cancelPlan: (id: string) => request<{ ok: true }>(`/desk/plans/${id}`, { method: "DELETE" }),
  closePosition: (ticket: number, lots?: number) => request<{ ok: true }>(`/desk/positions/${ticket}/close`, { method: "POST", body: JSON.stringify(lots === undefined ? {} : { lots }) }),
  flatten: (reason: string) => request<{ ok: true }>("/desk/flatten", { method: "POST", body: JSON.stringify({ reason }) }),
  settings: (patch: Record<string, unknown>) => request<{ mode: TradeMode; autoTrade: boolean; watchlist: string[]; policy: RiskPolicy; timezone: string; timezones: DeskTimezone[] }>("/desk/settings", { method: "POST", body: JSON.stringify(patch) }),
  resumeSymbol: (symbol: string) => request<unknown>("/desk/risk/resume", { method: "POST", body: JSON.stringify({ symbol }) }),
  projection: (params: { winProbability: number; rewardRisk: number; trades: number }) => request<{ assumptions: Record<string, number>; disciplined: ProjectionResult; martingale: ProjectionResult; note: string }>(`/desk/risk/projection?winProbability=${params.winProbability}&rewardRisk=${params.rewardRisk}&trades=${params.trades}`),
  pairingCode: () => request<{ pairingCode: string; expiresInMs: number | null }>("/bridge/pairing-code", { method: "POST" }),
  bridgeStatus: () => request<{
    linked: boolean;
    login?: number;
    server?: string;
    lastSyncAgeMs?: number;
    /** Hard state: the desk has written the terminal off and paused entries. */
    stale?: boolean;
    /** Soft state: late heartbeat, still analysing, gated per symbol. */
    degraded?: boolean;
    degradedAfterMs?: number;
    staleAfterMs?: number;
    syncIntervalMs?: number | null;
    queuedCommands?: number;
    catalogCount: number;
    selectedCount: number;
    calendarAvailable?: boolean;
    calendarAgeMs?: number | null;
    clockSkewMs?: number | null;
    lastQuoteAgeMs?: number | null;
    /**
     * Why the EA's last pairing attempt was refused, or null.
     *
     * The EA performs the pairing, not the browser, so without this the setup
     * dialog would sit on "waiting for the terminal" while the only explanation
     * sat in the MT5 Experts log.
     */
    lastPairingError?: string | null;
  }>("/bridge/status"),
  unpair: () => request<{ ok: true }>("/bridge/unpair", { method: "POST" }),
};

export interface ProjectionResult {
  medianReturnPct: number;
  meanMaxDrawdownPct: number;
  worstDrawdownPct: number;
  ruinProbability: number;
}

export function formatMoney(value: number, currency = "USD"): string {
  const sign = value < 0 ? "−" : "";
  return `${sign}${currency === "USD" ? "$" : ""}${Math.abs(value).toFixed(2)}${currency === "USD" ? "" : ` ${currency}`}`;
}

export function gradeColor(grade: string): string {
  switch (grade) {
    case "A+": return "text-emerald-400 border-emerald-500/40 bg-emerald-500/10";
    case "A": return "text-green-400 border-green-500/40 bg-green-500/10";
    case "B": return "text-amber-400 border-amber-500/40 bg-amber-500/10";
    case "C": return "text-orange-400 border-orange-500/40 bg-orange-500/10";
    default: return "text-zinc-400 border-zinc-600/40 bg-zinc-500/10";
  }
}

export function regimeColor(kind: string): string {
  if (kind.includes("up")) return "text-emerald-400";
  if (kind.includes("down")) return "text-red-400";
  if (kind === "volatile") return "text-amber-400";
  return "text-zinc-400";
}

/**
 * Render a timestamp in the desk's chosen timezone.
 *
 * The Desk defaults to Africa/Nairobi (EAT, UTC+3) because that is where it is
 * operated from. Previously every time was rendered in the *browser's*
 * timezone, which silently disagreed with the user's mental clock whenever
 * they travelled or used a VPS — and made a correct news time look wrong.
 */
export function formatInZone(
  ts: number,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(new Date(ts));
  } catch {
    return new Intl.DateTimeFormat("en-GB", options).format(new Date(ts));
  }
}

/** Short timezone label for the given instant, e.g. "EAT" for Nairobi. */
export function zoneAbbreviation(ts: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(ts));
    return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** Human-readable countdown: "in 4h 1m", "in 12m", "now", "18m ago". */
export function countdown(target: number, now = Date.now()): string {
  const diff = target - now;
  const abs = Math.abs(diff);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  if (Math.abs(diff) < 60_000) return "now";
  return diff > 0 ? `in ${label}` : `${label} ago`;
}

export function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
