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
export const TRADE_MODES: { id: TradeMode; label: string; blurb: string }[] = [
  { id: "scalp", label: "Scalp", blurb: "M1–M15 emphasis · ~1 hour horizon" },
  { id: "intraday", label: "Day", blurb: "M15–H4 emphasis · ~6 hour horizon" },
  { id: "swing", label: "Swing", blurb: "H1–D1 emphasis · multi-day horizon" },
];

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
  dataStatus: "live" | "warming" | "stale";
  lastQuoteAt: number | null;
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
    grade: string;
    higherTimeframeAligned: boolean;
    views: TimeframeView[];
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
  rejections: string[];
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
    stale: boolean;
  } | null;
  account: Account | null;
  mode: TradeMode;
  autoTrade: boolean;
  watchlist: string[];
  market: {
    catalogCount: number;
    selectedCount: number;
    liveSymbols: number;
    warmingSymbols: number;
    staleSymbols: number;
    quoteFreshForMs: number;
  };
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
  journal: JournalEntry[];
  serverTime: number;
}

export interface ScanRow {
  symbol: string;
  status: "live" | "warming" | "stale";
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
  instruments: () => request<{ source: "mt5" | "unlinked"; instruments: Instrument[] }>("/desk/instruments"),
  analysis: (symbol: string, mode: TradeMode) => request<{ source: "mt5"; horizonMinutes: number; decision: AgentDecision }>(`/desk/analysis?symbol=${encodeURIComponent(symbol)}&mode=${mode}`),
  scan: (mode: TradeMode) => request<{ mode: TradeMode; source: "mt5"; results: ScanRow[]; coverage: { selected: number; live: number; warming: number; stale: number }; scannedAt: number }>(`/desk/scan?mode=${mode}`),
  arm: (symbol: string, mode: TradeMode) => request<{ plan: ArmedPlan }>("/desk/arm", { method: "POST", body: JSON.stringify({ symbol, mode }) }),
  cancelPlan: (id: string) => request<{ ok: true }>(`/desk/plans/${id}`, { method: "DELETE" }),
  closePosition: (ticket: number, lots?: number) => request<{ ok: true }>(`/desk/positions/${ticket}/close`, { method: "POST", body: JSON.stringify(lots === undefined ? {} : { lots }) }),
  flatten: (reason: string) => request<{ ok: true }>("/desk/flatten", { method: "POST", body: JSON.stringify({ reason }) }),
  settings: (patch: Record<string, unknown>) => request<{ mode: TradeMode; autoTrade: boolean; watchlist: string[]; policy: RiskPolicy }>("/desk/settings", { method: "POST", body: JSON.stringify(patch) }),
  resumeSymbol: (symbol: string) => request<unknown>("/desk/risk/resume", { method: "POST", body: JSON.stringify({ symbol }) }),
  projection: (params: { winProbability: number; rewardRisk: number; trades: number }) => request<{ assumptions: Record<string, number>; disciplined: ProjectionResult; martingale: ProjectionResult; note: string }>(`/desk/risk/projection?winProbability=${params.winProbability}&rewardRisk=${params.rewardRisk}&trades=${params.trades}`),
  pairingCode: () => request<{ pairingCode: string; expiresInMs: number }>("/bridge/pairing-code", { method: "POST" }),
  bridgeStatus: () => request<{
    linked: boolean;
    login?: number;
    server?: string;
    lastSyncAgeMs?: number;
    stale?: boolean;
    queuedCommands?: number;
    catalogCount: number;
    selectedCount: number;
    calendarAvailable?: boolean;
    calendarAgeMs?: number | null;
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

export function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
