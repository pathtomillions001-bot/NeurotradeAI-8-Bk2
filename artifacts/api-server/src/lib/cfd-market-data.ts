/**
 * Isolated live candle feed for Market Intelligence.
 *
 * This module intentionally does not import the legacy DerivTickManager. That
 * manager has a simulation fallback for the existing digit/options engine;
 * Market Intelligence must fail closed when the public Deriv feed is down.
 */
import WebSocket from "ws";

export const MARKET_DATA_WS_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

export type MarketCategory =
  | "forex"
  | "cryptocurrency"
  | "commodities"
  | "indices"
  | "synthetic_index"
  | "basket_index"
  | "stocks"
  | "other";

export interface LiveMarketSymbol {
  symbol: string;
  displayName: string;
  category: MarketCategory;
  market: string;
  submarket: string;
  pipSize: number | null;
  exchangeIsOpen: boolean | null;
  isSuspended: boolean;
}

export interface LiveCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export class LiveMarketDataUnavailable extends Error {
  readonly code = "LIVE_MARKET_DATA_UNAVAILABLE";

  constructor(message = "Deriv live market data is unavailable") {
    super(message);
    this.name = "LiveMarketDataUnavailable";
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const ACTIVE_SYMBOL_CACHE_MS = 30_000;
let activeSymbolCache: { fetchedAt: number; symbols: LiveMarketSymbol[] } | null = null;

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCategory(rawMarket: unknown, rawSubmarket: unknown): MarketCategory {
  const value = `${rawMarket ?? ""} ${rawSubmarket ?? ""}`.toLowerCase();
  if (value.includes("forex") || value.includes("major") || value.includes("minor")) return "forex";
  if (value.includes("crypt") || value.includes("crypto")) return "cryptocurrency";
  if (value.includes("commodit") || value.includes("metal") || value.includes("energy")) return "commodities";
  if (value.includes("basket")) return "basket_index";
  if (value.includes("stock")) return "stocks";
  if (value.includes("synthetic") || value.includes("derived") || value.includes("volatility") || value.includes("jump")) return "synthetic_index";
  if (value.includes("index") || value.includes("indices")) return "indices";
  return "other";
}

function normalizeSymbol(raw: any): LiveMarketSymbol | null {
  const symbol = String(raw?.symbol ?? raw?.underlying_symbol ?? "").trim();
  if (!symbol) return null;
  const market = String(raw?.market ?? raw?.market_name ?? "").trim();
  const submarket = String(raw?.submarket ?? raw?.submarket_name ?? "").trim();
  const displayName = String(
    raw?.display_name ?? raw?.underlying_symbol_name ?? raw?.name ?? symbol,
  ).trim();
  return {
    symbol,
    displayName,
    category: normalizeCategory(market, submarket),
    market,
    submarket,
    pipSize: asNumber(raw?.pip_size),
    exchangeIsOpen: typeof raw?.exchange_is_open === "boolean" ? raw.exchange_is_open : null,
    isSuspended: Boolean(raw?.is_trading_suspended ?? raw?.trading_suspended),
  };
}

function isCandleMessage(message: any, reqId: number): boolean {
  return message?.msg_type === "candles" || message?.req_id === reqId && Array.isArray(message?.candles);
}

/**
 * A short-lived request client is deliberate here. It prevents a stale or
 * partially subscribed stream from being mistaken for a fresh analysis feed.
 * Every response is tied to a request id and every request has a hard timeout.
 */
async function requestDeriv<T>(
  payload: Record<string, unknown>,
  accepts: (message: any, reqId: number) => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const requestId = Math.floor(Math.random() * 2_000_000_000) + 1;
    const ws = new WebSocket(MARKET_DATA_WS_URL, { perMessageDeflate: false });

    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch { /* best effort */ }
      if (error) reject(error);
      else resolve(value as T);
    };

    const timer = setTimeout(() => {
      finish(new LiveMarketDataUnavailable("Timed out waiting for Deriv live market data"));
    }, REQUEST_TIMEOUT_MS);

    ws.once("open", () => {
      try {
        const request = {
          ...payload,
          req_id: requestId,
          ...(payload.ticks_history ? { subscribe: 0 } : {}),
        };
        ws.send(JSON.stringify(request));
      } catch (error) {
        finish(new LiveMarketDataUnavailable(error instanceof Error ? error.message : "Could not request live data"));
      }
    });

    ws.on("message", (raw) => {
      let message: any;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        finish(new LiveMarketDataUnavailable("Deriv returned an invalid live-data response"));
        return;
      }
      if (message?.error) {
        finish(new LiveMarketDataUnavailable(String(message.error.message ?? "Deriv rejected the live-data request")));
        return;
      }
      if (accepts(message, requestId)) finish(undefined, message as T);
    });

    ws.once("error", (error) => {
      finish(new LiveMarketDataUnavailable(
        `Could not connect to Deriv live market data: ${error instanceof Error ? error.message : "network error"}`,
      ));
    });

    ws.once("close", () => {
      if (!settled) finish(new LiveMarketDataUnavailable("Deriv closed the live market-data connection"));
    });
  });
}

export async function getLiveMarketSymbols(forceRefresh = false): Promise<LiveMarketSymbol[]> {
  if (!forceRefresh && activeSymbolCache && Date.now() - activeSymbolCache.fetchedAt < ACTIVE_SYMBOL_CACHE_MS) {
    return activeSymbolCache.symbols;
  }
  const response = await requestDeriv<any>(
    { active_symbols: "brief" },
    (message, reqId) => message?.msg_type === "active_symbols" || (message?.req_id === reqId && Array.isArray(message?.active_symbols)),
  );
  const symbols = (Array.isArray(response.active_symbols) ? response.active_symbols : [])
    .map(normalizeSymbol)
    .filter((symbol: LiveMarketSymbol | null): symbol is LiveMarketSymbol => Boolean(symbol));
  if (symbols.length === 0) throw new LiveMarketDataUnavailable("Deriv returned no active symbols");
  activeSymbolCache = { fetchedAt: Date.now(), symbols };
  return symbols;
}

export async function getLiveCandles(
  symbol: string,
  granularity: number,
  count = 320,
): Promise<{ candles: LiveCandle[]; fetchedAt: number; symbol: string; granularity: number }> {
  const response = await requestDeriv<any>(
    {
      ticks_history: symbol,
      end: "latest",
      count: Math.max(50, Math.min(1000, Math.floor(count))),
      style: "candles",
      granularity: Math.max(60, Math.floor(granularity)),
      adjust_start_time: 1,
    },
    isCandleMessage,
  );
  const candles = (Array.isArray(response.candles) ? response.candles : [])
    .map((candle: any) => ({
      epoch: Number(candle.epoch),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }))
    .filter((candle: LiveCandle) =>
      Number.isFinite(candle.epoch) &&
      [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) &&
      candle.high >= Math.max(candle.open, candle.close) &&
      candle.low <= Math.min(candle.open, candle.close),
    )
    .sort((a: LiveCandle, b: LiveCandle) => a.epoch - b.epoch);
  if (candles.length < 50) throw new LiveMarketDataUnavailable("Deriv returned too few candles for a defensible analysis");
  return { candles, fetchedAt: Date.now(), symbol, granularity };
}

export function isFreshCandleFeed(candles: LiveCandle[], granularity: number, nowMs = Date.now()): boolean {
  const latest = candles[candles.length - 1];
  if (!latest) return false;
  // A closed market may legitimately have no current candle. We still fail
  // closed after three bars plus a small network allowance.
  return nowMs / 1000 - latest.epoch <= granularity * 3 + 120;
}

export function categoryLabel(category: MarketCategory): string {
  return category === "synthetic_index" ? "Synthetic / Derived" : category === "cryptocurrency" ? "Crypto" : category[0].toUpperCase() + category.slice(1);
}
