/**
 * Research harness — contract specifications for offline studies (WP2).
 *
 * ── THE HONEST WARNING ──────────────────────────────────────────────────────
 *
 * Every number a study produces is denominated in R, and R is denominated in
 * the broker's contract specification: `point`, `tickValue`, `spreadPoints`,
 * `commissionPerLot`. Get one of them wrong by 2× and the study's conclusion
 * flips while every statistic still looks healthy.
 *
 * So the harness NEVER trusts a guessed spec. The live desk gets the real one
 * from the terminal (SYMBOL_POINT, SYMBOL_TRADE_TICK_VALUE_LOSS, …). Offline,
 * the defaults below are the COMMON case for a retail MT5 account — 5-digit FX
 * with a 1.0 account-currency value per point per standard lot — and the CLI
 * prints every assumed value in the report so a study can be rejected on sight
 * when the assumptions are wrong. For indices, crypto, futures and commodity
 * CFDs the defaults are almost certainly wrong and the CLI says so.
 *
 * The correct workflow is to read the values off your own terminal
 * (View → Symbols → the symbol → Specification) and pass them:
 *
 *   --point 0.01 --digits 2 --tick-value 1 --contract-size 100 \
 *   --volume-min 0.1 --volume-step 0.1 --spread 30 --commission 7
 */

import type { AssetClass, SymbolSpec } from "../types";

export interface SpecOverrides {
  assetClass?: AssetClass;
  point?: number;
  digits?: number;
  tickSize?: number;
  tickValue?: number;
  contractSize?: number;
  volumeMin?: number;
  volumeMax?: number;
  volumeStep?: number;
  stopsLevel?: number;
  freezeLevel?: number;
  spreadPoints?: number;
  commissionPerLot?: number;
  baseCurrency?: string;
  quoteCurrency?: string;
}

/** Currencies MT5 brokers quote with a 3-digit price (JPY crosses, HUF, …). */
const THREE_DIGIT_QUOTES = ["JPY", "HUF", "KRW", "THB", "IDR"];

const INDEX_TOKENS = ["US30", "US100", "US500", "US2000", "NAS", "SPX", "DAX", "DE40", "GER", "UK100", "FTSE", "JP225", "NIKKEI", "HK50", "F40", "CAC", "AUS200", "EU50", "STOXX"];
const METAL_TOKENS = ["XAU", "XAG", "GOLD", "SILVER", "XPT", "XPD", "PLATINUM"];
const CRYPTO_TOKENS = ["BTC", "ETH", "XRP", "LTC", "BCH", "SOL", "ADA", "DOGE", "DOT", "LINK"];
const COMMODITY_TOKENS = ["USOIL", "UKOIL", "BRENT", "WTI", "NGAS", "NATGAS", "XBR", "XTI", "COPPER", "CORN", "WHEAT", "SOYBEAN", "COCOA", "COFFEE", "SUGAR"];
const FUTURES_TOKENS = ["US500.", "ES", "NQ", "CL", "GC", "SI", "ZB", "ZN", "VX"];

/** Guess the asset class from the symbol name. Heuristic — and overridable. */
export function inferAssetClass(symbol: string): AssetClass {
  const s = symbol.toUpperCase();
  if (METAL_TOKENS.some((t) => s.includes(t))) return "metals";
  if (CRYPTO_TOKENS.some((t) => s.includes(t))) return "crypto";
  if (INDEX_TOKENS.some((t) => s.includes(t))) return "indices";
  if (COMMODITY_TOKENS.some((t) => s.includes(t))) return "commodities";
  if (FUTURES_TOKENS.some((t) => s.startsWith(t))) return "futures";
  // Six letters that are two ISO codes, or the broker's .a/.pro/.raw suffixes.
  const bare = s.replace(/[^A-Z]/g, "");
  if (bare.length >= 6 && (THREE_DIGIT_QUOTES.includes(bare.slice(3, 6)) || THREE_DIGIT_QUOTES.includes(bare.slice(0, 3)))) return "forex";
  if (bare.length === 6 || /^[A-Z]{3}\/[A-Z]{3}$/.test(s)) return "forex";
  if (bare.length <= 5) return "stocks";
  return "other";
}

/** Default point/price granularity for the guessed class. */
function defaultPoint(assetClass: AssetClass, symbol: string): number {
  const s = symbol.toUpperCase();
  if (assetClass === "forex") {
    const bare = s.replace(/[^A-Z]/g, "");
    return THREE_DIGIT_QUOTES.includes(bare.slice(-3)) ? 0.001 : 0.00001;
  }
  if (assetClass === "metals") return s.includes("XAG") || s.includes("SILVER") ? 0.001 : 0.01;
  if (assetClass === "indices") return 0.1;
  if (assetClass === "crypto") return s.includes("BTC") ? 0.01 : 0.001;
  if (assetClass === "commodities") return 0.001;
  if (assetClass === "futures") return 0.01;
  if (assetClass === "stocks") return 0.01;
  return 0.00001;
}

function digitsFor(point: number): number {
  const text = point.toFixed(10).replace(/0+$/, "");
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * Build a contract spec for an offline study.
 *
 * Returns the spec plus the list of values that were ASSUMED (not passed in),
 * so the CLI can print them and the report can carry them. An assumption that
 * is printed is a caveat; one that is hidden is a bug waiting in the results.
 */
export function specForSymbol(
  symbol: string,
  overrides: SpecOverrides = {},
): { spec: SymbolSpec; assumed: string[] } {
  const assumed: string[] = [];
  const assetClass = overrides.assetClass ?? inferAssetClass(symbol);
  if (overrides.assetClass === undefined) assumed.push(`assetClass=${assetClass}`);

  const point = overrides.point ?? defaultPoint(assetClass, symbol);
  if (overrides.point === undefined) assumed.push(`point=${point}`);
  const digits = overrides.digits ?? digitsFor(point);
  if (overrides.digits === undefined) assumed.push(`digits=${digits}`);
  const tickSize = overrides.tickSize ?? point;
  if (overrides.tickSize === undefined) assumed.push(`tickSize=${tickSize}`);
  // 1.0 account-currency per tick per lot is right for a 5-digit USD-quoted
  // pair on a standard contract; it is wrong nearly everywhere else.
  const tickValue = overrides.tickValue ?? 1;
  if (overrides.tickValue === undefined) assumed.push(`tickValue=${tickValue}`);
  const contractSize = overrides.contractSize ?? (assetClass === "forex" ? 100_000 : 1);
  if (overrides.contractSize === undefined) assumed.push(`contractSize=${contractSize}`);
  const volumeMin = overrides.volumeMin ?? 0.01;
  if (overrides.volumeMin === undefined) assumed.push(`volumeMin=${volumeMin}`);
  const volumeMax = overrides.volumeMax ?? 100;
  const volumeStep = overrides.volumeStep ?? 0.01;
  if (overrides.volumeStep === undefined) assumed.push(`volumeStep=${volumeStep}`);
  const spreadPoints = overrides.spreadPoints ?? (assetClass === "forex" ? 12 : 30);
  if (overrides.spreadPoints === undefined) assumed.push(`spreadPoints=${spreadPoints}`);
  const commissionPerLot = overrides.commissionPerLot ?? 0;
  if (overrides.commissionPerLot === undefined) assumed.push(`commissionPerLot=${commissionPerLot}`);

  const spec: SymbolSpec = {
    symbol,
    assetClass,
    point,
    digits,
    tickSize,
    tickValue,
    contractSize,
    volumeMin,
    volumeMax,
    volumeStep,
    stopsLevel: overrides.stopsLevel ?? 0,
    freezeLevel: overrides.freezeLevel ?? 0,
    marginInitial: 0,
    swapLong: 0,
    swapShort: 0,
    commissionPerLot,
    spreadPoints,
    baseCurrency: overrides.baseCurrency,
    quoteCurrency: overrides.quoteCurrency,
  };
  return { spec, assumed };
}
