/**
 * Sandbox preview of the Multi-Asset Desk.
 *
 * The Desk only renders broker data from a paired MT5 terminal, which a
 * sandbox cannot provide. This module supplies a clearly labelled, simulated
 * broker feed so the Desk's layout can be reviewed without a live account.
 *
 * It is double-gated so it can never reach a real user:
 *  1. `import.meta.env.DEV` — the production build dead-code-eliminates it.
 *  2. The `?desk-preview` query flag must be present in the URL.
 *
 * Nothing here is ever sent to the server. Mutations (mode, watchlist,
 * close, arm, …) only change this in-memory copy.
 */

import type {
  AgentDecision,
  ArmedPlan,
  AssetClass,
  DeskPerformance,
  DeskStateResponse,
  Instrument,
  JournalEntry,
  Market,
  Position,
  ScanRow,
  TradeMode,
  UpcomingNewsEvent,
} from "@/lib/desk";

export const DESK_PREVIEW: boolean =
  import.meta.env.DEV === true &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("desk-preview");

type SimStatus = "live" | "warming" | "stale";

interface SimSymbol {
  symbol: string;
  description: string;
  assetClass: AssetClass;
  path: string;
  base: number;
  digits: number;
  spread: number;
  status: SimStatus;
}

const SIM_CATALOG: SimSymbol[] = [
  { symbol: "EURUSD", description: "Euro vs US Dollar", assetClass: "forex", path: "Forex\\Majors", base: 1.0842, digits: 5, spread: 8, status: "live" },
  { symbol: "GBPUSD", description: "Pound Sterling vs US Dollar", assetClass: "forex", path: "Forex\\Majors", base: 1.2635, digits: 5, spread: 11, status: "live" },
  { symbol: "USDJPY", description: "US Dollar vs Japanese Yen", assetClass: "forex", path: "Forex\\Majors", base: 151.42, digits: 3, spread: 14, status: "live" },
  { symbol: "AUDUSD", description: "Australian Dollar vs US Dollar", assetClass: "forex", path: "Forex\\Majors", base: 0.6612, digits: 5, spread: 12, status: "warming" },
  { symbol: "XAUUSD", description: "Gold vs US Dollar", assetClass: "metals", path: "Metals\\Precious", base: 2651.3, digits: 2, spread: 28, status: "live" },
  { symbol: "XAGUSD", description: "Silver vs US Dollar", assetClass: "metals", path: "Metals\\Precious", base: 30.82, digits: 3, spread: 22, status: "stale" },
  { symbol: "US30", description: "Dow Jones Industrial Average", assetClass: "indices", path: "Indices\\US", base: 41250.5, digits: 1, spread: 22, status: "warming" },
  { symbol: "NAS100", description: "Nasdaq 100", assetClass: "indices", path: "Indices\\US", base: 18320.4, digits: 1, spread: 18, status: "stale" },
  { symbol: "USOIL", description: "US Crude Oil", assetClass: "commodities", path: "Energy", base: 81.42, digits: 2, spread: 4, status: "live" },
  { symbol: "BTCUSD", description: "Bitcoin vs US Dollar", assetClass: "crypto", path: "Crypto\\Majors", base: 67400, digits: 2, spread: 1200, status: "live" },
  { symbol: "ETHUSD", description: "Ethereum vs US Dollar", assetClass: "crypto", path: "Crypto\\Majors", base: 3520.6, digits: 2, spread: 90, status: "live" },
  { symbol: "AAPL", description: "Apple Inc.", assetClass: "stocks", path: "Stocks\\US", base: 228.4, digits: 2, spread: 4, status: "live" },
];

const TIMEZONES = [
  { id: "Africa/Nairobi", label: "Nairobi · EAT" },
  { id: "Europe/London", label: "London · GMT/BST" },
  { id: "America/New_York", label: "New York · ET" },
  { id: "Asia/Tokyo", label: "Tokyo · JST" },
];

function simSymbol(symbol: string): SimSymbol {
  return SIM_CATALOG.find((entry) => entry.symbol === symbol) ?? SIM_CATALOG[0]!;
}

/** Simulated price: a slow drift plus a faster wobble, so the board visibly moves. */
function priceAt(sim: SimSymbol, t: number): number {
  const i = SIM_CATALOG.indexOf(sim) + 1;
  const drift = 0.0011 * Math.sin(t / (9000 + i * 900));
  const wobble = 0.00045 * Math.sin(t / (1300 + i * 170) + i);
  return sim.base * (1 + drift + wobble);
}

function instrumentFor(sim: SimSymbol, t: number): Instrument {
  const index = SIM_CATALOG.indexOf(sim);
  const price = priceAt(sim, t);
  const open = sim.base * (1 + 0.0031 * (index % 2 === 0 ? 1 : -1));
  const point = Math.pow(10, -sim.digits);
  const ask = price + sim.spread * point;
  const sparkline = Array.from({ length: 40 }, (_, k) => priceAt(sim, t - (39 - k) * 4000));
  const age = sim.status === "live" ? 400 + ((index * 137) % 900) : sim.status === "warming" ? 2600 : 14000;
  return {
    symbol: sim.symbol,
    description: sim.description,
    assetClass: sim.assetClass,
    digits: sim.digits,
    bid: price,
    ask,
    spreadPoints: sim.spread,
    changePct: ((price - open) / open) * 100,
    watched: true,
    dataStatus: sim.status,
    lastQuoteAt: t - age,
    quoteAgeMs: age,
    priceWarning: null,
    deviationPct: 0.01,
    sessionHigh: Math.max(price, ...sparkline) * 1.0012,
    sessionLow: Math.min(price, ...sparkline) * 0.9988,
    sparkline,
    contractSize: sim.assetClass === "crypto" ? 1 : 100000,
    point,
  };
}

// ── Mutable in-memory preview state ───────────────────────────────────────────

const preview = {
  mode: "intraday" as TradeMode,
  autoTrade: false,
  watchlist: ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "US30", "BTCUSD", "NAS100"],
  timezone: "Africa/Nairobi",
  plans: [] as ArmedPlan[],
  positions: [
    { ticket: 418220, symbol: "XAUUSD", side: "buy", volume: 0.1, openPrice: 2638.4, openTime: Date.now() - 3 * 3_600_000, sl: 2621.0, tp: 2670.0, profit: 42.6, swap: -1.2, commission: -0.7, initialRiskMoney: 90 },
    { ticket: 418245, symbol: "USDJPY", side: "sell", volume: 0.2, openPrice: 151.9, openTime: Date.now() - 3_600_000, sl: 152.6, tp: 150.4, profit: -18.3, swap: 0, commission: -0.9, initialRiskMoney: 80 },
  ] as Position[],
};

function journalEntries(t: number): JournalEntry[] {
  return [
    { id: "j1", ts: t - 120_000, kind: "signal", symbol: "XAUUSD", message: "Long bias confirmed on M15 and H1; evidence vote 4 of 5 agree." },
    { id: "j2", ts: t - 540_000, kind: "no_trade", symbol: "NAS100", message: "Feed stale — symbol skipped until its quote is fresh again." },
    { id: "j3", ts: t - 1_260_000, kind: "risk", symbol: null, message: "Daily loss budget at 18% — trading continues within policy." },
    { id: "j4", ts: t - 2_100_000, kind: "execution", symbol: "USDJPY", message: "Sell 0.20 lots filled at 151.90 (SL 152.60, TP 150.40)." },
    { id: "j5", ts: t - 3_300_000, kind: "bridge", symbol: null, message: "MT5 heartbeat resumed after a 6s gap; no action required." },
  ];
}

function decisionFor(symbol: string, mode: TradeMode, t: number): AgentDecision {
  const sim = simSymbol(symbol);
  const seed = SIM_CATALOG.indexOf(sim) + 1;
  const up = seed % 3 !== 0;
  const direction: "up" | "down" = up ? "up" : "down";
  const score = 58 + ((seed * 13) % 33);
  const threshold = 70;
  const grade = score >= 88 ? "A+" : score >= 80 ? "A" : score >= 72 ? "B" : "C";
  const armed = symbol === "XAUUSD";
  const price = priceAt(sim, t);
  const pip = Math.pow(10, -sim.digits) * 10;
  const plan: ArmedPlan | null = armed
    ? {
        id: "preview-plan-xau",
        symbol,
        side: "buy",
        mode,
        trigger: price + pip * 2,
        invalidate: price - pip * 30,
        sl: price - pip * 30,
        tp: [price + pip * 60],
        lots: 0.12,
        riskMoney: 95,
        riskPoints: 300,
        expiresAt: t + 1_200_000,
        createdAt: t - 60_000,
      }
    : null;
  const views = [
    { timeframe: "M5", bias: direction, kind: up ? "trend-up" : "trend-down", confidence: 72, rsi: up ? 61 : 39, persistence: 0.7, weight: 0.3, contribution: up ? 0.31 : -0.22, trendQuality: 0.6, volatilityRatio: 1.1, role: "analysis" as const },
    { timeframe: "M15", bias: direction, kind: up ? "trend-up" : "trend-down", confidence: 66, rsi: up ? 57 : 44, persistence: 0.6, weight: 0.35, contribution: up ? 0.36 : -0.27, trendQuality: 0.55, volatilityRatio: 1.0, role: "analysis" as const },
    { timeframe: "H1", bias: up ? "up" : "neutral", kind: up ? "trend-up" : "range", confidence: 58, rsi: 52, persistence: 0.5, weight: 0.35, contribution: up ? 0.18 : -0.04, trendQuality: 0.4, volatilityRatio: 0.9, role: "context" as const },
  ] as AgentDecision["confluence"]["views"];
  const side = up ? 1 : -1;
  const factors = [
    { family: "trend", label: "Trend", vote: side as 1 | -1, strength: 0.7, reliability: 0.8, weight: 0.3, contribution: up ? 0.42 : -0.35, detail: "EMA stack aligned across M5–H1" },
    { family: "momentum", label: "Momentum", vote: side as 1 | -1, strength: 0.55, reliability: 0.7, weight: 0.2, contribution: up ? 0.22 : -0.18, detail: "RSI and MACD agree with direction" },
    { family: "structure", label: "Structure", vote: 1 as const, strength: 0.4, reliability: 0.6, weight: 0.2, contribution: up ? 0.16 : 0.05, detail: "Higher low held above prior swing" },
    { family: "volatility", label: "Volatility", vote: 0 as const, strength: 0.1, reliability: 0.5, weight: 0.1, contribution: 0.02, detail: "Volatility within its normal band" },
    { family: "flow", label: "Order flow", vote: (-side) as 1 | -1, strength: 0.3, reliability: 0.45, weight: 0.2, contribution: up ? -0.08 : 0.12, detail: "Tick flow leans against the move" },
  ];
  const agreeing = factors.filter((factor) => factor.vote === side).length;
  const opposed = factors.filter((factor) => factor.vote !== 0 && factor.vote !== side).length;
  return {
    symbol,
    mode,
    armed,
    plan,
    confluence: {
      direction,
      score,
      baseScore: score - 4,
      grade,
      higherTimeframeAligned: up,
      contextPenalty: up ? 0 : 6,
      views,
      factors: [
        { label: "Multi-timeframe trend", detail: "Three frames agree on direction", weight: 0.3, aligned: true },
        { label: "Session timing", detail: "Inside the London–New York overlap", weight: 0.15, aligned: true },
        { label: "Spread cost", detail: "Spread is small against the expected move", weight: 0.1, aligned: up },
      ],
      warnings: up ? [] : ["Higher-timeframe context leans the other way."],
    },
    monteCarlo: {
      winProbability: 0.46 + (seed % 5) * 0.03,
      lossProbability: 0.36,
      timeoutProbability: 0.18,
      expectancyR: 0.12 + (seed % 4) * 0.07,
      grossExpectancyR: 0.28 + (seed % 4) * 0.07,
      rewardRisk: 2.0,
      meanBarsToResolve: 14 + seed,
    },
    sizing: {
      ok: true,
      lots: 0.12,
      riskMoney: 95,
      riskPoints: 300,
      pointValue: 1,
      costMoney: 4.2,
      marginRequired: 210,
      effectiveRiskPct: 0.95,
      explanation: "Risk 0.95% of equity ($95) over a 300-point stop at 0.12 lots.",
    },
    risk: { allow: true, riskPct: 0.95, scoreBump: 0, reasons: [], breaches: [] },
    news: { status: "clear", blocked: false, reason: null, relevantEvents: [], checkedAt: t },
    evidence: {
      symbol,
      mode,
      timeframe: "M15",
      direction,
      confidence: score - 6,
      raw: 0.42,
      factors,
      agreeingFamilies: agreeing,
      totalFamilies: factors.length,
      dissentingFamilies: opposed,
      diagnostics: {},
    },
    qualityScore: score,
    qualityThreshold: threshold,
    entryTimeframe: "M15",
    horizonMinutes: 360,
    costR: 0.18,
    stopWidened: false,
    rejections: armed ? [] : [up ? "Quality is below the arming threshold." : "Short bias lacks higher-timeframe confirmation."],
    warnings: armed ? ["Spread widens around the US open."] : [],
    summary: armed ? "A+ long setup on M15 with aligned evidence." : "Watching — conditions not yet clear.",
  };
}

function scanRows(t: number): ScanRow[] {
  return preview.watchlist.map((symbol) => {
    const decision = decisionFor(symbol, preview.mode, t);
    return {
      symbol,
      status: simSymbol(symbol).status,
      armed: decision.armed,
      direction: decision.confluence.direction,
      score: decision.qualityScore,
      grade: decision.confluence.grade,
      expectancyR: decision.monteCarlo?.expectancyR ?? null,
      winProbability: decision.monteCarlo?.winProbability ?? null,
      lots: decision.sizing?.lots ?? null,
      riskMoney: decision.sizing?.riskMoney ?? null,
      rejections: decision.rejections,
      summary: decision.summary,
    };
  });
}

function performance(t: number): DeskPerformance {
  const closed = [
    { ticket: 417901, symbol: "EURUSD", side: "buy" as const, volume: 0.15, openPrice: 1.0801, profit: 118.4, swap: -0.6, commission: -1.4, rMultiple: 1.6 },
    { ticket: 417932, symbol: "XAUUSD", side: "sell" as const, volume: 0.1, openPrice: 2664.1, profit: -72.0, swap: 0, commission: -0.9, rMultiple: -1.0 },
    { ticket: 417980, symbol: "GBPUSD", side: "buy" as const, volume: 0.12, openPrice: 1.259, profit: 96.2, swap: -0.2, commission: -1.1, rMultiple: 1.3 },
    { ticket: 418010, symbol: "USDJPY", side: "buy" as const, volume: 0.1, openPrice: 150.8, profit: 61.7, swap: 0, commission: -0.8, rMultiple: 0.9 },
    { ticket: 418077, symbol: "US30", side: "sell" as const, volume: 0.05, openPrice: 41610, profit: -44.5, swap: 0, commission: -0.5, rMultiple: -1.0 },
    { ticket: 418150, symbol: "EURUSD", side: "sell" as const, volume: 0.15, openPrice: 1.0874, profit: 132.9, swap: -0.4, commission: -1.5, rMultiple: 2.0 },
  ];
  const curve = Array.from({ length: 48 }, (_, k) => {
    const equity = 10_000 + 260 * Math.sin(k / 6) + k * 14;
    return { t: t - (47 - k) * 1_800_000, equity, balance: equity - 40 };
  });
  const totalR = closed.reduce((sum, trade) => sum + trade.rMultiple, 0);
  const wins = closed.filter((trade) => trade.profit > 0).length;
  const overall = {
    trades: closed.length,
    wins,
    losses: closed.length - wins,
    winRate: wins / closed.length,
    totalR,
    avgR: totalR / closed.length,
    profitFactor: 1.9,
    sharpeLike: 1.1,
    maxLosingStreak: 2,
    maxDrawdownR: 2.0,
  };
  const symbols = [...new Set(closed.map((trade) => trade.symbol))];
  return {
    source: "mt5",
    currency: "USD",
    equityCurve: curve,
    closedTrades: closed.map((trade, index) => ({
      ...trade,
      openedAt: t - (closed.length - index) * 5_400_000,
      closedAt: t - (closed.length - index) * 5_400_000 + 1_800_000,
    })),
    bySymbol: symbols.map((symbol) => {
      const rows = closed.filter((trade) => trade.symbol === symbol);
      const rowWins = rows.filter((trade) => trade.profit > 0).length;
      const r = rows.reduce((sum, trade) => sum + trade.rMultiple, 0);
      const stats = {
        trades: rows.length,
        wins: rowWins,
        losses: rows.length - rowWins,
        winRate: rowWins / rows.length,
        totalR: r,
        avgR: r / rows.length,
        profitFactor: 1.6,
        sharpeLike: 0.9,
        maxLosingStreak: 1,
        maxDrawdownR: 1.0,
      };
      return {
        symbol,
        trades: rows.length,
        net: rows.reduce((sum, trade) => sum + trade.profit, 0),
        wins: rowWins,
        losses: rows.length - rowWins,
        winRate: rowWins / rows.length,
        stats,
      };
    }),
    overall,
    outcomes: [],
    realisedPnl: closed.reduce((sum, trade) => sum + trade.profit + trade.swap + trade.commission, 0),
    generatedAt: t,
  };
}

function newsEvents(t: number): UpcomingNewsEvent[] {
  return [
    { id: "n1", time: t + 42 * 60_000, currency: "USD", country: "US", name: "Core PCE Price Index m/m", importance: "high", forecast: 0.2, previous: 0.1, actual: null, inMs: 42 * 60_000, next: true, passed: false },
    { id: "n2", time: t + 4 * 3_600_000, currency: "EUR", country: "EU", name: "ECB President Speaks", importance: "high", forecast: null, previous: null, actual: null, inMs: 4 * 3_600_000, next: false, passed: false },
    { id: "n3", time: t - 3 * 3_600_000, currency: "GBP", country: "GB", name: "BoE Rate Decision", importance: "high", forecast: 5.0, previous: 5.0, actual: 5.0, inMs: -3 * 3_600_000, next: false, passed: true },
  ];
}

function buildState(t: number): DeskStateResponse {
  const coverage = (status: SimStatus) => preview.watchlist.filter((symbol) => simSymbol(symbol).status === status).length;
  return {
    source: "mt5",
    terminal: {
      accountId: "preview",
      login: 50123456,
      server: "Preview-Demo",
      company: "Sandbox preview",
      pairedAt: t - 86_400_000,
      lastSyncAt: t - 800,
      lastSyncAgeMs: 800,
      stale: false,
      degraded: false,
      degradedAfterMs: 15_000,
      staleAfterMs: 120_000,
      syncIntervalMs: 1000,
    },
    account: {
      balance: 10_000,
      equity: 10_182.4,
      margin: 620,
      freeMargin: 9_562.4,
      marginLevel: 1642,
      currency: "USD",
      leverage: 100,
      mode: "demo",
      isLive: false,
      dayStartEquity: 10_060,
      peakEquity: 10_240,
    },
    mode: preview.mode,
    autoTrade: preview.autoTrade,
    watchlist: [...preview.watchlist],
    timezone: preview.timezone,
    timezones: TIMEZONES,
    market: {
      catalogCount: SIM_CATALOG.length,
      selectedCount: preview.watchlist.length,
      liveSymbols: coverage("live"),
      warmingSymbols: coverage("warming"),
      staleSymbols: coverage("stale"),
      mismatchSymbols: 0,
      quoteFreshForMs: 8000,
    },
    feed: { clockSkewMs: 120, clockWarning: null, lastQuoteAgeMs: 800, quoteFreshForMs: 8000 },
    positions: preview.positions,
    plans: preview.plans,
    policy: {
      baseRiskPct: 1,
      maxRiskPct: 2,
      maxDailyLossPct: 3,
      maxDrawdownPct: 10,
      maxOpenPositions: 4,
      maxPositionsPerSymbol: 1,
      maxCurrencyExposurePct: 3,
      haltAfterConsecutiveLosses: 4,
      minMarginLevelPct: 150,
      symbolCooldownMs: 900_000,
      liveTradingEnabled: false,
    },
    risk: {
      state: {
        consecutiveLosses: 1,
        suspendedSymbols: ["NAS100"],
        realisedPnlToday: 61.2,
        tradesToday: 3,
        haltedUntilNextSession: false,
        haltReason: null,
      },
      budget: { usedPct: 18, remainingMoney: 240, limitMoney: 300 },
      exposure: [
        { key: "USD", riskMoney: 90, riskPct: 0.9 },
        { key: "JPY", riskMoney: 80, riskPct: 0.8 },
        { key: "EUR", riskMoney: 40, riskPct: 0.4 },
      ],
    },
    news: { available: true, checkedAt: t, events: [], rawCount: 9, redCount: 3 },
    newsUpcoming: newsEvents(t),
    autoSelect: {
      last: {
        at: t - 240_000,
        mode: preview.mode,
        scanned: preview.watchlist.length,
        qualified: 1,
        chosen: "XAUUSD",
        reason: "XAUUSD ranked first with an A+ long setup and armed one plan.",
        skipped: ["NAS100"],
        ranked: [
          { symbol: "XAUUSD", expectancyR: 0.31, score: 88, grade: "A+", armed: true },
          { symbol: "EURUSD", expectancyR: 0.12, score: 72, grade: "B", armed: false },
        ],
      },
      intervalMs: 300_000,
      maxCandidates: 6,
      noteIntervalMs: 900_000,
      nextDueAt: t + 60_000,
    },
    journal: journalEntries(t),
    serverTime: t,
  };
}

// ── Preview API: same shapes as `deskApi`, served from the simulation ───────

const resolved = <T,>(value: T): Promise<T> => Promise.resolve(value);

/** Mirrors the subset of `deskApi` the Desk page calls. */
export const previewDeskApi = {
  state: () => resolved(buildState(Date.now())),
  markets: () => {
    const t = Date.now();
    return resolved({
      source: "mt5" as const,
      catalogCount: SIM_CATALOG.length,
      markets: SIM_CATALOG.map((sim): Market => ({
        symbol: sim.symbol,
        description: sim.description,
        path: sim.path,
        assetClass: sim.assetClass,
        tradeable: true,
        selected: preview.watchlist.includes(sim.symbol),
        dataStatus: sim.status,
        lastQuoteAt: t - 800,
      })),
    });
  },
  instruments: () => {
    const t = Date.now();
    return resolved({
      source: "mt5" as const,
      instruments: preview.watchlist.map((symbol) => instrumentFor(simSymbol(symbol), t)),
      feed: { clockSkewMs: 120, clockWarning: null, lastQuoteAgeMs: 800, quoteFreshForMs: 8000 },
    });
  },
  performance: () => resolved(performance(Date.now())),
  analysis: (symbol: string, mode: TradeMode) =>
    resolved({ source: "mt5" as const, horizonMinutes: 360, decision: decisionFor(symbol, mode, Date.now()) }),
  scan: (mode: TradeMode) => {
    const t = Date.now();
    const coverage = (status: SimStatus) => preview.watchlist.filter((symbol) => simSymbol(symbol).status === status).length;
    return resolved({
      mode,
      source: "mt5" as const,
      results: scanRows(t),
      coverage: {
        selected: preview.watchlist.length,
        live: coverage("live"),
        warming: coverage("warming"),
        stale: coverage("stale"),
      },
      scannedAt: t,
    });
  },
  settings: (patch: Record<string, unknown>) => {
    if (typeof patch.mode === "string") preview.mode = patch.mode as TradeMode;
    if (typeof patch.autoTrade === "boolean") preview.autoTrade = patch.autoTrade;
    if (Array.isArray(patch.watchlist)) preview.watchlist = patch.watchlist as string[];
    if (typeof patch.timezone === "string") preview.timezone = patch.timezone;
    const state = buildState(Date.now());
    return resolved({
      mode: state.mode,
      autoTrade: state.autoTrade,
      watchlist: state.watchlist,
      policy: state.policy,
      timezone: state.timezone,
      timezones: state.timezones,
    });
  },
  arm: (symbol: string, mode: TradeMode) => {
    const plan = decisionFor(symbol, mode, Date.now()).plan;
    if (!plan) return Promise.reject(new Error("Preview: this symbol has no armable setup right now."));
    preview.plans = [...preview.plans.filter((existing) => existing.id !== plan.id), plan];
    return resolved({ plan });
  },
  cancelPlan: (id: string) => {
    preview.plans = preview.plans.filter((plan) => plan.id !== id);
    return resolved({ ok: true as const });
  },
  closePosition: (ticket: number) => {
    preview.positions = preview.positions.filter((position) => position.ticket !== ticket);
    return resolved({ ok: true as const });
  },
  flatten: (_reason: string) => {
    preview.plans = [];
    preview.positions = [];
    return resolved({ ok: true as const });
  },
  resumeSymbol: (_symbol: string) => resolved({ ok: true as const }),
};
