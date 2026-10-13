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
  // v5 UI: the segmented control reads "Intraday", matching the workspace
  // copy; the id (and every data-testid derived from it) is unchanged.
  { id: "intraday", label: "Intraday", blurb: "5–30min band · ~6 hour horizon" },
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
    /**
     * v5 UI — the agents that proposed this trade's plan, via the server's
     * fill→plan join. Null (or absent on an older server) when the attribution
     * is unknown; the Desk prints an em dash — "unknown" is not "no agents".
     */
    agents?: string[] | null;
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
  /**
   * v5 UI — the ONE management state the wire data can prove: the stop sits at
   * or beyond the entry ("be"), or the position still carries its initial risk
   * ("open"). Optional: a server that predates the field simply omits it and
   * the Desk shows no state badge rather than guessing one.
   */
  managementState?: "open" | "be";
}

export interface ArmedPlan {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  mode: TradeMode;
  trigger: number;
  /**
   * The order style the plan will rest as. Optional on the wire (older
   * servers omit it); the Desk renders an em dash when absent.
   */
  triggerType?: "break" | "retest" | "market" | "confirm" | "limit" | "stop";
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
    /** The reward:risk AT THE EXPECTED FILL (agent.ts §5a), not from the quote. */
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
  /**
   * v5 UI mirrors — the decision fields the server already computed and sent
   * (the route spreads the whole decision). All optional so a response from an
   * older server keeps type-checking; the Desk renders em dashes when absent.
   */
  /** Blended win probability the edge gate enforced. */
  winProbability?: number | null;
  /** Blended expectancy after costs, in R. */
  expectancyR?: number | null;
  /** The probability LOWER BOUND the sizing spent (WP5 model), or null. */
  sizingProbabilityLowerBound?: number | null;
  /** The WP6 gatekeeper's verdict when the subsystem decided this plan. */
  gatekeeper?: GatekeeperDecisionWire | null;
  /** The alpha agents that proposed this setup, after the governance overlay. */
  alphaAgents?: string[];
  evaluatedAt?: number;
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

/** One gate of the WP6 gatekeeper, recorded whether it passed or failed. */
export interface GatekeeperReasonWire {
  code: string;
  label: string;
  pass: boolean;
  /** What was measured (null when there was nothing to measure). */
  value: number | null;
  /** What it had to beat, where a threshold applies. */
  threshold: number | null;
  detail: string;
}

/**
 * The WP6 gatekeeper's verdict, as the wire carries it. `reasons` is the
 * per-gate pass/fail list the Decision panel's edge gate renders — thresholds
 * included, so the UI never hard-codes a number the server owns.
 */
export interface GatekeeperDecisionWire {
  armed: boolean;
  code: string;
  codes: string[];
  reason: string;
  reasons: GatekeeperReasonWire[];
  /** EV at p_LCB, net of cost, in R — the "edge floor" reading. */
  evLcbR: number | null;
  requiredEvLcbR: number;
  rrFill: number;
  costR: number;
  horizonSigma: number | null;
  costOverSigma: number | null;
  edgePValue: number | null;
  bhThreshold: number | null;
  mcP05MeanR: number | null;
  mcTargetShare: number | null;
  horizonBars: number;
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
  /**
   * The range (UTC epoch ms) the terminal actually read, when it reports one.
   * "0 red-folder events" is only meaningful next to the window it describes.
   */
  windowFromMs?: number | null;
  windowToMs?: number | null;
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
  /**
   * v5 UI — which v4 layers are computing right now (the server's own flag
   * summary). Optional: absent on a server that predates the field, and then
   * the title bar simply shows no V4 chip.
   */
  v4?: DeskV4Summary | null;
}

/** The server's `DESK_V4_*` configuration, summarised for the Desk UI. */
export interface DeskV4Summary {
  enabled: boolean;
  /** Global shadow: nothing v4 produces may arm an order. */
  shadow: boolean;
  layers: {
    governance: boolean;
    regimeHmm: boolean;
    gatekeeper: boolean;
    metaModel: boolean;
    execution: boolean;
    portfolio: boolean;
    ui: boolean;
  };
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
  /** v5 UI — reward:risk at the expected fill; null ⇒ em dash. */
  rrFill?: number | null;
  /** v5 UI — the gatekeeper's EV at p_LCB (the edge floor); null ⇒ em dash. */
  edgeFloorR?: number | null;
  /** v5 UI — the mode's EV floor the edge had to beat; null ⇒ em dash. */
  edgeRequiredR?: number | null;
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

/**
 * WP10 — the learning and governance surfaces.
 *
 * Everything here is READ-ONLY except the operator resume, which is the one action
 * a human takes on this page. Each endpoint is absent (404) while its v4 subsystem
 * is switched off, so a component must treat "not available" as a normal answer
 * rather than an error — the desk has simply never had those layers switched on.
 */
export interface GovernanceAgent {
  agentId: string;
  status: "active" | "halved" | "disabled";
  /** Evidence against the agent's edge; grows on losses, decays on wins. */
  eValue: number;
  /** The bars the e-value is compared against. */
  halveAt: number;
  disableAt: number;
  outcomes: number;
  wins: number;
  totalR: number;
  /** The change detector's statistic, and how many times it has registered. */
  phValue: number;
  phAlarms: number;
  reason: string | null;
  updatedAtMs: number | null;
}

export interface WeeklyReport {
  source: "desk";
  weekStart: string;
  weekEnd: string;
  generatedAtMs: number;
  trades: {
    closed: number;
    measuredR: number;
    unmeasured: number;
    wins: number;
    hitRate: number | null;
    meanR: number | null;
    totalR: number;
    meanPredictedProbability: number | null;
    calibrationGapPoints: number | null;
    brier: number | null;
    meanSlippageR: number | null;
    worstR: number | null;
    bestR: number | null;
    /**
     * v5 UI — realised hit rate per predicted-probability bucket, from stored
     * rows only. Optional: an older server omits it and the calibration table
     * shows its footer verdicts alone (derive nothing, per the brief).
     */
    calibrationBuckets?: CalibrationBucketRow[];
    /** v5 UI — one-sided 80% lower confidence bound of the mean measured R. */
    meanRLower80?: number | null;
  };
  decisions: {
    evaluated: number;
    armed: number;
    refused: number;
    armRate: number | null;
    refusalCodes: { code: string; count: number }[];
  };
  perSymbol: { symbol: string; trades: number; totalR: number; meanR: number | null }[];
  agents: { agentId: string; status: string; eValue: number; outcomes: number; totalR: number; reason: string | null }[];
  flags: string[];
  window: { weekStartMs: number; weekEndMs: number };
}

export interface JournalEntryRow {
  id: string;
  ts: number;
  kind: string;
  symbol: string | null;
  message: string;
  detail: unknown;
}

/** One calibration bucket of the weekly report (v5 UI mirror). */
export interface CalibrationBucketRow {
  label: string;
  lower: number;
  upper: number;
  n: number;
  meanPredicted: number | null;
  realisedHitRate: number | null;
  gapPoints: number | null;
}

export interface RegimeRead {
  symbol: string;
  frame: string;
  mode: TradeMode;
  state: string;
  posterior: Record<string, number>;
  expectedDwellBars: number;
  changeProbability: number;
  fit: { bars: number; iterations: number; logLikelihood: number; reused: boolean; adequate: boolean };
  sides: {
    buy: { required: string; probability: number; permit: boolean; codes: string[]; reason: string };
    sell: { required: string; probability: number; permit: boolean; codes: string[]; reason: string };
  };
  asOfMs: number;
  ageMs: number;
  cached: boolean;
  available: boolean;
  reason: string;
  bars: number;
  lastBarAtMs: number | null;
}

/** The WP7 execution/portfolio readout, as `GET /desk/execution` serves it. */
export interface DeskExecutionReport {
  execution: {
    /** Per-symbol spread observations: how many, and the latest in points. */
    spreadSamples: Record<string, { samples: number; last: number | null }>;
    timingBuckets: number;
    timingPooled: { wins: number; losses: number; rSum: number };
    /** Every fill's slippage in R, EWMA'd — null before the first fill. */
    slippage: { ewmaR: number | null; samples: number; observations: number };
  } | null;
  /** `[symbol, returnCount]` pairs the correlation layer could read. */
  portfolio: [string, number][] | null;
}

export const deskApi = {
  state: () => request<DeskStateResponse>("/desk/state"),
  markets: () => request<{ source: "mt5" | "unlinked"; markets: Market[]; catalogCount: number }>("/desk/markets"),
  instruments: () => request<{ source: "mt5" | "unlinked"; instruments: Instrument[]; feed: FeedDiagnostics }>("/desk/instruments"),
  performance: () => request<DeskPerformance>("/desk/performance"),
  series: (symbol: string) => request<DeskSeries>(`/desk/series?symbol=${encodeURIComponent(symbol)}`),
  analysis: (symbol: string, mode: TradeMode) =>
    request<{
      source: "mt5";
      horizonMinutes: number;
      /**
       * v5 UI — the server's gate constants (MIN_RR_FILL, MIN_COST_COVERAGE),
       * so the legacy gate rows print thresholds the server owns. Optional:
       * absent on an older server.
       */
      thresholds?: { minRrFill: number; minCostCoverage: number };
      decision: AgentDecision;
    }>(`/desk/analysis?symbol=${encodeURIComponent(symbol)}&mode=${mode}`),
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
  /**
   * The per-agent governance registry.
   *
   * `available: false` means the endpoint 404'd — the layer is off, which is the
   * shipped state, not a failure to report as one.
   */
  governance: () =>
    request<{ sessionId: string; agents: GovernanceAgent[] }>("/desk/governance").then(
      (data) => ({ available: true as const, ...data }),
      () => ({ available: false as const, sessionId: "", agents: [] as GovernanceAgent[] }),
    ),
  /** The Monday-to-Monday report, rebuilt from the durable rows on every read. */
  weeklyReport: (weekStart?: string) =>
    request<WeeklyReport>(`/desk/learning/weekly${weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : ""}`).then(
      (data) => ({ available: true as const, report: data }),
      () => ({ available: false as const, report: null }),
    ),
  /** The durable journal, newest first. */
  journal: (params: { kind?: string | null; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.kind) query.set("kind", params.kind);
    if (params.limit) query.set("limit", String(params.limit));
    return request<{ sessionId: string; entries: JournalEntryRow[] }>(`/desk/learning/journal?${query.toString()}`).then(
      (data) => ({ available: true as const, entries: data.entries }),
      () => ({ available: false as const, entries: [] as JournalEntryRow[] }),
    );
  },
  /** The desk-timeframe regime state, memoised server-side for two seconds. */
  regime: (symbol?: string, mode?: TradeMode) => {
    const query = new URLSearchParams();
    if (symbol) query.set("symbol", symbol);
    if (mode) query.set("mode", mode);
    return request<{ mode: TradeMode; frame: string; ttlMs: number; asOfMs: number; states: RegimeRead[] }>(
      `/desk/regime?${query.toString()}`,
    ).then(
      (data) => ({ available: true as const, ...data }),
      () => ({ available: false as const, mode: (mode ?? "intraday") as TradeMode, frame: "", ttlMs: 0, asOfMs: 0, states: [] as RegimeRead[] }),
    );
  },
  /**
   * v5 UI — the WP7 execution ledgers (slippage EWMA, spread samples, timing
   * pool). The endpoint 404s while the execution AND portfolio layers are both
   * off, which is the shipped state: `available: false` hides those rows, it is
   * not an error.
   */
  execution: () =>
    request<DeskExecutionReport>("/desk/execution").then(
      (data) => ({ available: true as const, ...data }),
      () => ({ available: false as const, execution: null, portfolio: null }),
    ),
  /** An OPERATOR action: put an agent back to work. The note is required. */
  resumeAgent: (agentId: string, note: string) =>
    request<{ ok: true; agent: GovernanceAgent | null }>("/desk/governance/resume", {
      method: "POST",
      body: JSON.stringify({ agentId, note }),
    }),
  projection: (params: { winProbability: number; rewardRisk: number; trades: number }) => request<{ assumptions: Record<string, number>; disciplined: ProjectionResult; martingale: ProjectionResult; note: string }>(`/desk/risk/projection?winProbability=${params.winProbability}&rewardRisk=${params.rewardRisk}&trades=${params.trades}`),
  /**
   * The session's pairing code.
   *
   * The code connects ONE terminal session. Re-opening the dialog hands back
   * the code a live terminal is already using rather than minting a second one,
   * so reading it out loud cannot invalidate the terminal that is connected —
   * and once that terminal goes away the code goes with it, which is why a new
   * session starts from a new code.
   */
  pairingCode: (rotate = false) =>
    request<{
      pairingCode: string;
      expiresInMs: number;
      reused?: boolean;
      /** True once a terminal has redeemed this code. */
      redeemed?: boolean;
      /**
       * Whether the store holding this code survives a server restart. A code
       * minted into a process-local store is not the credential this dialog
       * promises, so the dialog says so instead of handing over a value that
       * dies on the next deploy.
       */
      durable?: boolean;
      storeReachable?: boolean;
      warning?: string;
    }>("/bridge/pairing-code", {
      method: "POST",
      body: JSON.stringify({ rotate }),
    }),
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
    /**
     * The terminal MACHINE's own clock error (EA v3.04+). The EA self-corrects
     * its timestamps against the server clock, so this is a calm "sync NTP"
     * signal, not a data-quality alarm.
     */
    computerClockSkewMs?: number | null;
    lastQuoteAgeMs?: number | null;
    /** Rolling heartbeat round-trip health (ms), for diagnosing a slow beat. */
    lastBeatRttMs?: number | null;
    avgBeatRttMs?: number | null;
    /**
     * The link lives only as long as the terminal (EA v3.08+). Closing MT5 ends
     * it, its pairing code is spent, and reconnecting starts from a new code.
     * `durable` is always false now — kept so an older Desk reading this key is
     * never told a link outlives the terminal that owns it.
     */
    durable?: boolean;
    /** The link contract the API implements. */
    linkModel?: "terminal-session";
    /** True: MT5 closing ends the connection. */
    linkEndsWithTerminal?: boolean;
    /** Heartbeat silence, in ms, after which the server releases the link. */
    leaseMs?: number;
    /** Where the link is stored, and whether that store survives a restart. */
    store?: BridgeStoreReport;
    /** Version the terminal reported, or null before the first heartbeat. */
    eaVersion?: string | null;
    expectedEaVersion?: string;
    /** True when the connected EA is older than the one the Desk ships. */
    eaUpdateAvailable?: boolean;
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

/**
 * The bridge's link store, as the API reports it.
 *
 * A link is remembered for exactly as long as the terminal that made it is
 * open, so the store has to survive a deploy inside that window. Without a
 * `postgres://` DATABASE_URL the API falls back to embedded PGlite — a file
 * inside the container — and a running terminal is dropped on every restart,
 * replica and cold start, which from the Desk is indistinguishable from the
 * terminal itself closing. Invisible from the browser unless the API says which
 * store it is using.
 */
export interface BridgeStoreReport {
  /** "postgres" or "pglite". */
  backend: string;
  /** True only when a row written now survives the process ending. */
  durable: boolean;
  /** Human-readable description, including the PGlite path. */
  detail: string;
  /** Whether the bootstrap DDL has been applied. */
  schemaApplied: boolean;
  /** Whether the two bridge tables could actually be read just now. */
  reachable: boolean;
  tables?: string[];
}

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
