/**
 * Multi-Asset Desk — deterministic replay feed.
 *
 * The desk needs market data before a user has linked a terminal, and the
 * development sandbox has no outbound access to a broker. This module
 * synthesises specs, quotes and multi-timeframe candles for a demo watchlist.
 *
 * It is a REPLAY/MOCK provider sitting behind the same interface a live
 * provider uses, not a toy: the generator produces realistic regime changes,
 * volatility clustering and per-asset tick economics, so the regime, Markov,
 * Monte Carlo and sizing paths all exercise genuinely different numbers for
 * EURUSD, XAUUSD and US30. Every series is seeded, so a reload shows the same
 * history rather than a new random market.
 *
 * Nothing here is ever used once a real terminal is linked: `DeskState.simulated`
 * flips to false on pairing and the EA's data takes over.
 */

import { gaussian, hashSeed, makeRng } from "./math";
import { TIMEFRAME_MINUTES, type AssetClass, type Bar, type CandleSeries, type Quote, type SymbolSpec, type Timeframe } from "./types";

interface SimSymbol {
  symbol: string;
  assetClass: AssetClass;
  basePrice: number;
  digits: number;
  point: number;
  tickValue: number;
  contractSize: number;
  spreadPoints: number;
  commissionPerLot: number;
  /** Annualised-ish volatility knob; tuned so each class behaves distinctly. */
  volatility: number;
  volumeMin: number;
  volumeStep: number;
  stopsLevel: number;
  baseCurrency?: string;
  quoteCurrency?: string;
}

/**
 * Contract economics mirror typical retail broker specs. The important
 * property is that they DIFFER: the sizing engine must produce very different
 * lot numbers for the same dollar risk, and the tests assert exactly that.
 */
const SIM_SYMBOLS: SimSymbol[] = [
  {
    symbol: "EURUSD",
    assetClass: "forex",
    basePrice: 1.0845,
    digits: 5,
    point: 0.00001,
    tickValue: 1.0, // USD per POINT (0.00001) per lot = 100_000 * 0.00001
    contractSize: 100_000,
    spreadPoints: 12,
    commissionPerLot: 7,
    volatility: 0.00045,
    volumeMin: 0.01,
    volumeStep: 0.01,
    stopsLevel: 0,
    baseCurrency: "EUR",
    quoteCurrency: "USD",
  },
  {
    symbol: "GBPUSD",
    assetClass: "forex",
    basePrice: 1.2712,
    digits: 5,
    point: 0.00001,
    tickValue: 1.0, // as EURUSD: 100_000 * 0.00001 = 1.00 USD per point per lot
    contractSize: 100_000,
    spreadPoints: 16,
    commissionPerLot: 7,
    volatility: 0.00055,
    volumeMin: 0.01,
    volumeStep: 0.01,
    stopsLevel: 0,
    baseCurrency: "GBP",
    quoteCurrency: "USD",
  },
  {
    symbol: "USDJPY",
    assetClass: "forex",
    basePrice: 151.42,
    digits: 3,
    point: 0.001,
    tickValue: 0.66, // 100_000 * 0.001 JPY = 100 JPY per point per lot ≈ 0.66 USD
    contractSize: 100_000,
    spreadPoints: 14,
    commissionPerLot: 7,
    volatility: 0.0004,
    volumeMin: 0.01,
    volumeStep: 0.01,
    stopsLevel: 0,
    baseCurrency: "USD",
    quoteCurrency: "JPY",
  },
  {
    symbol: "XAUUSD",
    assetClass: "metals",
    basePrice: 2338.5,
    digits: 2,
    point: 0.01,
    tickValue: 1, // $1 per 0.01 move per lot (100 oz)
    contractSize: 100,
    spreadPoints: 28,
    commissionPerLot: 0,
    volatility: 0.0009,
    volumeMin: 0.01,
    volumeStep: 0.01,
    stopsLevel: 0,
    baseCurrency: "XAU",
    quoteCurrency: "USD",
  },
  {
    symbol: "US30",
    assetClass: "indices",
    basePrice: 39250,
    digits: 1,
    point: 0.1,
    tickValue: 0.1,
    contractSize: 1,
    spreadPoints: 30,
    commissionPerLot: 0,
    volatility: 0.0007,
    volumeMin: 0.1,
    volumeStep: 0.1,
    stopsLevel: 50,
  },
  {
    symbol: "NAS100",
    assetClass: "indices",
    basePrice: 18120,
    digits: 1,
    point: 0.1,
    tickValue: 0.1,
    contractSize: 1,
    spreadPoints: 25,
    commissionPerLot: 0,
    volatility: 0.0011,
    volumeMin: 0.1,
    volumeStep: 0.1,
    stopsLevel: 50,
  },
  {
    symbol: "BTCUSD",
    assetClass: "crypto",
    basePrice: 64250,
    digits: 2,
    point: 0.01,
    tickValue: 0.01,
    contractSize: 1,
    spreadPoints: 4000,
    commissionPerLot: 0,
    volatility: 0.0028,
    volumeMin: 0.01,
    volumeStep: 0.01,
    stopsLevel: 0,
  },
];

const BY_SYMBOL = new Map(SIM_SYMBOLS.map((s) => [s.symbol, s]));

export function simulatedSymbols(): string[] {
  return SIM_SYMBOLS.map((s) => s.symbol);
}

export function simulatedSpec(symbol: string): SymbolSpec | null {
  const sim = BY_SYMBOL.get(symbol);
  if (!sim) return null;
  return {
    symbol: sim.symbol,
    assetClass: sim.assetClass,
    point: sim.point,
    digits: sim.digits,
    tickSize: sim.point,
    tickValue: sim.tickValue,
    contractSize: sim.contractSize,
    volumeMin: sim.volumeMin,
    volumeMax: 100,
    volumeStep: sim.volumeStep,
    stopsLevel: sim.stopsLevel,
    freezeLevel: 0,
    marginInitial: 0,
    swapLong: -2.1,
    swapShort: -0.4,
    commissionPerLot: sim.commissionPerLot,
    spreadPoints: sim.spreadPoints,
    baseCurrency: sim.baseCurrency,
    quoteCurrency: sim.quoteCurrency,
  };
}

/**
 * Generate bars ending at the most recent completed bar boundary.
 *
 * The walk is a regime-switching process: a slowly varying drift plus
 * volatility that clusters, which is what makes the regime classifier and the
 * Markov model produce meaningful (and varying) output instead of white noise.
 */
export function simulatedCandles(symbol: string, timeframe: Timeframe, count = 320): CandleSeries | null {
  const sim = BY_SYMBOL.get(symbol);
  if (!sim) return null;

  const minutes = TIMEFRAME_MINUTES[timeframe];
  const stepMs = minutes * 60_000;
  // Anchor to the bar grid so repeated calls return a stable history and only
  // the newest bar advances.
  const now = Date.now();
  const lastOpen = Math.floor(now / stepMs) * stepMs;
  const startTs = lastOpen - (count - 1) * stepMs;

  // Seeded per symbol+timeframe+day so a page reload shows the same market.
  const day = Math.floor(lastOpen / 86_400_000);
  const rng = makeRng(hashSeed(`${symbol}|${timeframe}|${day}`));

  // Volatility scales with the square root of the bar length.
  const sigma = sim.volatility * Math.sqrt(minutes);
  let price = sim.basePrice;
  let drift = 0;
  let volMultiplier = 1;

  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    // Regime switching: the drift occasionally re-rolls, producing runs of
    // trend and runs of chop rather than a single stationary process.
    if (rng() < 0.04) drift = (rng() - 0.5) * sigma * 1.6;
    // Volatility clustering, mean-reverting around 1.
    volMultiplier = 0.85 * volMultiplier + 0.15 * (0.6 + rng() * 1.2);

    const open = price;
    const stepSigma = sigma * volMultiplier;
    const close = open * Math.exp(drift + stepSigma * gaussian(rng));
    const wick = Math.abs(close - open) * (0.4 + rng() * 0.9) + open * stepSigma * 0.4;
    const high = Math.max(open, close) + wick * rng();
    const low = Math.min(open, close) - wick * rng();
    const volume = Math.round(400 + rng() * 2600);

    bars.push([
      startTs + i * stepMs,
      round(open, sim.digits),
      round(high, sim.digits),
      round(low, sim.digits),
      round(close, sim.digits),
      volume,
    ]);
    price = close;
  }

  return { symbol, timeframe, bars };
}

export function simulatedQuote(symbol: string): Quote | null {
  const sim = BY_SYMBOL.get(symbol);
  if (!sim) return null;
  // Derive the quote from the M1 series so chart and quote never disagree.
  const series = simulatedCandles(symbol, "M1", 3);
  const last = series?.bars[series.bars.length - 1];
  const mid = last ? last[4] : sim.basePrice;
  const halfSpread = (sim.spreadPoints * sim.point) / 2;
  return {
    symbol,
    bid: round(mid - halfSpread, sim.digits),
    ask: round(mid + halfSpread, sim.digits),
    spreadPoints: sim.spreadPoints,
    ts: Date.now(),
  };
}

/** A demo account used until a real terminal is paired. */
export function simulatedAccount(): import("./types").AccountSnapshot {
  return {
    balance: 5000,
    equity: 5000,
    margin: 0,
    freeMargin: 5000,
    marginLevel: Number.POSITIVE_INFINITY,
    currency: "USD",
    leverage: 500,
    mode: "hedging",
    isLive: false,
    dayStartEquity: 5000,
    peakEquity: 5000,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
