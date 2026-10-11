/**
 * Desk v4 research harness — broker contract specifications (WP2).
 *
 * The harness needs a `SymbolSpec` to price anything. A real run should always
 * use the terminal's own figures (`SymbolInfoDouble`/`SymbolInfoInteger`,
 * exported to JSON — see `specFromJson`), because tick value, stops level and
 * commission are broker- and account-specific. The presets below exist so the
 * synthetic control runs are reproducible and so a missing spec produces
 * documented assumptions rather than silent ones.
 */

import type { AssetClass, SymbolSpec } from "../types";

export interface SpecPreset {
  symbol: string;
  assetClass: AssetClass;
  digits: number;
  /** Smallest price increment, 10^-digits unless a symbol quotes coarser. */
  point: number;
  tickSize: number;
  /** Account currency per tick, per 1.00 lot. */
  tickValue: number;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  stopsLevel: number;
  freezeLevel: number;
  commissionPerLot: number;
  spreadPoints: number;
  baseCurrency?: string;
  quoteCurrency?: string;
}

export const SPEC_PRESETS: Record<string, SpecPreset> = {
  EURUSD: {
    symbol: "EURUSD",
    assetClass: "forex",
    digits: 5,
    point: 0.00001,
    tickSize: 0.00001,
    tickValue: 1,
    contractSize: 100_000,
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    stopsLevel: 0,
    freezeLevel: 0,
    commissionPerLot: 7,
    spreadPoints: 8,
    baseCurrency: "EUR",
    quoteCurrency: "USD",
  },
  GBPUSD: {
    symbol: "GBPUSD",
    assetClass: "forex",
    digits: 5,
    point: 0.00001,
    tickSize: 0.00001,
    tickValue: 1,
    contractSize: 100_000,
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    stopsLevel: 0,
    freezeLevel: 0,
    commissionPerLot: 7,
    spreadPoints: 12,
    baseCurrency: "GBP",
    quoteCurrency: "USD",
  },
  USDJPY: {
    symbol: "USDJPY",
    assetClass: "forex",
    digits: 3,
    point: 0.001,
    tickSize: 0.001,
    tickValue: 0.67,
    contractSize: 100_000,
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    stopsLevel: 0,
    freezeLevel: 0,
    commissionPerLot: 7,
    spreadPoints: 10,
    baseCurrency: "USD",
    quoteCurrency: "JPY",
  },
  XAUUSD: {
    symbol: "XAUUSD",
    assetClass: "metals",
    digits: 2,
    point: 0.01,
    tickSize: 0.01,
    tickValue: 1,
    contractSize: 100,
    volumeMin: 0.01,
    volumeMax: 50,
    volumeStep: 0.01,
    stopsLevel: 30,
    freezeLevel: 0,
    commissionPerLot: 7,
    spreadPoints: 25,
    baseCurrency: "XAU",
    quoteCurrency: "USD",
  },
};

/** True when the symbol has a preset, case-insensitively. */
export function hasPreset(symbol: string): boolean {
  return Boolean(SPEC_PRESETS[symbol.toUpperCase()]);
}

/** Broker-side defaults derived from a preset's point size. */
export function specFromPreset(symbol: string, spreadPoints?: number): SymbolSpec {
  const preset =
    SPEC_PRESETS[symbol.toUpperCase()] ??
    // Unknown symbols get an FX-like contract; recorded so the report can say
    // that the cost model was assumed rather than reported by the terminal.
    { ...SPEC_PRESETS.EURUSD!, symbol, assetClass: "other" as AssetClass };
  return {
    symbol: preset.symbol,
    assetClass: preset.assetClass,
    point: preset.point,
    digits: preset.digits,
    tickSize: preset.tickSize,
    tickValue: preset.tickValue,
    contractSize: preset.contractSize,
    volumeMin: preset.volumeMin,
    volumeMax: preset.volumeMax,
    volumeStep: preset.volumeStep,
    stopsLevel: preset.stopsLevel,
    freezeLevel: preset.freezeLevel,
    marginInitial: 0,
    swapLong: 0,
    swapShort: 0,
    commissionPerLot: preset.commissionPerLot,
    spreadPoints: spreadPoints ?? preset.spreadPoints,
    baseCurrency: preset.baseCurrency,
    quoteCurrency: preset.quoteCurrency,
  };
}

/**
 * Parse a SymbolSpec JSON exported from the terminal.
 *
 * Accepts either a single object or an array, and fills any absent numeric
 * field from the matching preset (or the FX default), because a partially
 * exported spec is still far better than a guessed one.
 */
export function specFromJson(text: string, fallbackSymbol?: string): SymbolSpec {
  const parsed = JSON.parse(text) as Partial<SymbolSpec> | Partial<SymbolSpec>[];
  const raw = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;
  const symbol = (raw.symbol ?? fallbackSymbol ?? "EURUSD").toString();
  const base = specFromPreset(symbol);
  return {
    ...base,
    ...raw,
    symbol,
    point: numberOr(raw.point, base.point),
    digits: numberOr(raw.digits, base.digits),
    tickSize: numberOr(raw.tickSize, base.tickSize),
    tickValue: numberOr(raw.tickValue, base.tickValue),
    contractSize: numberOr(raw.contractSize, base.contractSize),
    volumeMin: numberOr(raw.volumeMin, base.volumeMin),
    volumeMax: numberOr(raw.volumeMax, base.volumeMax),
    volumeStep: numberOr(raw.volumeStep, base.volumeStep),
    commissionPerLot: numberOr(raw.commissionPerLot, base.commissionPerLot),
    spreadPoints: numberOr(raw.spreadPoints, base.spreadPoints),
    assetClass: (raw.assetClass ?? base.assetClass) as AssetClass,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
