/** Asset-class helpers for a broker-discovered MT5 symbol catalog. */

import type { AssetClass } from "./types";

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

const FOREX_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "CNH", "HKD", "SGD",
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "ZAR", "MXN", "BRL", "INR", "KRW",
  "THB", "RUB", "ILS", "SAR", "AED",
]);

export function normalizeAssetClass(value: unknown): AssetClass | null {
  return typeof value === "string" && ASSET_CLASSES.includes(value as AssetClass)
    ? (value as AssetClass)
    : null;
}

/**
 * Prefer the MT5 trade-calculation class supplied by the EA. This fallback is
 * only for old EAs/brokers that omit it; it never supplies prices or contract
 * economics and is not used to make a trade decision.
 */
export function inferAssetClass(input: {
  symbol: string;
  path?: string;
  description?: string;
  baseCurrency?: string;
  calculationMode?: string;
}): AssetClass {
  const symbol = input.symbol.toUpperCase();
  const text = `${input.path ?? ""} ${input.description ?? ""} ${symbol}`.toUpperCase();
  const mode = (input.calculationMode ?? "").toUpperCase();
  const base = (input.baseCurrency ?? "").toUpperCase();

  if (/CRYPTO|DIGITAL ASSET|\bCOIN\b/.test(text) || /^(BTC|ETH|LTC|XRP|ADA|SOL|DOGE|DOT|AVAX|BNB)/.test(symbol)) {
    return "crypto";
  }
  if (/METAL|BULLION/.test(text) || ["XAU", "XAG", "XPT", "XPD"].includes(base) || /^(XAU|XAG|XPT|XPD)/.test(symbol)) {
    return "metals";
  }
  if (/STOCK|SHARE|EQUIT|\bNYSE\b|\bNASDAQ\b/.test(text) || /EXCH_STOCK/.test(mode)) {
    return "stocks";
  }
  if (/FUTURE|FORWARD/.test(text) || /FUTURE/.test(mode)) {
    return "futures";
  }
  if (/INDEX|INDICE|INDICES|\bDAX\b|\bUS30\b|\bNAS100\b|\bSPX500\b/.test(text) || /CFDINDEX/.test(mode)) {
    return "indices";
  }
  if (/COMMODIT|ENERGY|OIL|NATURAL GAS|WHEAT|CORN|SUGAR|COFFEE/.test(text)) {
    return "commodities";
  }
  const currencyPair = symbol.match(/^([A-Z]{3})([A-Z]{3})(?:[._-].*)?$/);
  if (
    /FOREX|CURRENC|\bFX\b/.test(text) ||
    /FOREX/.test(mode) ||
    (currencyPair && FOREX_CURRENCIES.has(currencyPair[1]!) && FOREX_CURRENCIES.has(currencyPair[2]!))
  ) {
    return "forex";
  }
  return "other";
}
