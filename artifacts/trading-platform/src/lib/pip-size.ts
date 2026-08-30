/**
 * Per-market price precision (pip size) — FRONTEND mirror of the backend.
 *
 * MUST stay in sync with `pipSize` in
 * `artifacts/api-server/src/lib/deriv.ts` (DERIV_MARKETS).
 *
 * Why this exists: digit contracts (Even/Odd, Over/Under, Matches/Differs)
 * read the last digit of the RAW quote. Rendering a 3-dp market with 2
 * decimals rounds away the very digit the analysis is about — e.g. Volatility
 * 15 (1s) quote 13222.146 displayed as "13222.15" shows last digit 5 instead
 * of 6. Always format prices with `pipSizeForSymbol(symbol)` decimals.
 *
 * Last-digit truth (extraction, distribution, barriers) is computed on the
 * backend from the un-rounded Deriv quote; this map only controls display
 * precision so users see the same digits Deriv shows.
 */

const MARKET_PIP_SIZES: Record<string, number> = {
  // Volatility (2s series)
  R_10: 3,
  R_25: 3,
  R_50: 4,
  R_75: 4,
  R_100: 2,
  // Volatility (1s series) — 15/30/90 carry a 3rd decimal (e.g. 6527.120)
  "1HZ10V": 2,
  "1HZ15V": 3,
  "1HZ25V": 2,
  "1HZ30V": 3,
  "1HZ50V": 2,
  "1HZ75V": 2,
  "1HZ90V": 3,
  "1HZ100V": 2,
  // Basket indices
  RDBULL: 4,
  RDBEAR: 4,
  // Jump indices
  JD10: 2,
  JD25: 2,
  JD50: 2,
  JD75: 2,
  JD100: 2,
};

export const DEFAULT_PIP_SIZE = 2;

/**
 * Number of decimal places to render for a market's price.
 * Unknown symbols fall back to 2 (most Deriv synthetics).
 */
export function pipSizeForSymbol(symbol?: string | null): number {
  if (!symbol) return DEFAULT_PIP_SIZE;
  return MARKET_PIP_SIZES[symbol] ?? DEFAULT_PIP_SIZE;
}
