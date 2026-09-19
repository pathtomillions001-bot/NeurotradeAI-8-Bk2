/**
 * Market specifications — annual vol and tick interval.
 * Extracted from accumulator-analysis so Deriv tick manager can use it
 * without pulling the whole accumulator bot.
 */

export const YEAR_SECONDS = 365 * 24 * 3600;

const ANNUAL_VOL: Record<string, number> = {
  R_10: 0.10, R_25: 0.25, R_50: 0.50, R_75: 0.75, R_100: 1.00,
  "1HZ10V": 0.10, "1HZ15V": 0.15, "1HZ25V": 0.25, "1HZ30V": 0.30,
  "1HZ50V": 0.50, "1HZ75V": 0.75, "1HZ90V": 0.90, "1HZ100V": 1.00,
  JD10: 0.10, JD25: 0.25, JD50: 0.50, JD75: 0.75, JD100: 1.00,
  RDBULL: 0.40, RDBEAR: 0.40,
};

export function tickSecondsFor(symbol: string): number {
  return symbol.startsWith("1HZ") ? 1 : 2;
}

export function annualVolFor(symbol: string): number {
  return ANNUAL_VOL[symbol] ?? 0.25;
}
