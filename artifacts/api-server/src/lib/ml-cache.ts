import type { DirectionPrediction, DigitPrediction } from "./ml-engine";
import { predictDirection, predictDigitContract } from "./ml-engine";

interface DirectionCacheEntry {
  pricesLen: number;
  lastPrice: number;
  expiresAt: number;
  prediction: DirectionPrediction;
}

interface DigitCacheEntry {
  digitsLen: number;
  lastDigit: number;
  expiresAt: number;
  prediction: DigitPrediction | null;
}

const directionCache = new Map<string, DirectionCacheEntry>();
const digitCache = new Map<string, DigitCacheEntry>();
const CACHE_TTL_MS = 5000;

export function getCachedDirection(symbol: string, prices: number[]): DirectionPrediction {
  const lastPrice = prices[prices.length - 1] ?? 0;
  const cached = directionCache.get(symbol);
  if (
    cached &&
    cached.pricesLen === prices.length &&
    cached.lastPrice === lastPrice &&
    cached.expiresAt > Date.now()
  ) {
    return cached.prediction;
  }

  const prediction = predictDirection(prices);
  directionCache.set(symbol, {
    pricesLen: prices.length,
    lastPrice,
    expiresAt: Date.now() + CACHE_TTL_MS,
    prediction,
  });
  return prediction;
}

export function getCachedDigitPrediction(symbol: string, digits: number[]): DigitPrediction | null {
  if (digits.length < 30) return null;
  const lastDigit = digits[digits.length - 1];
  const cached = digitCache.get(symbol);
  if (
    cached &&
    cached.digitsLen === digits.length &&
    cached.lastDigit === lastDigit &&
    cached.expiresAt > Date.now()
  ) {
    return cached.prediction;
  }

  const prediction = predictDigitContract(digits);
  digitCache.set(symbol, {
    digitsLen: digits.length,
    lastDigit,
    expiresAt: Date.now() + CACHE_TTL_MS,
    prediction,
  });
  return prediction;
}

export function clearMlCache(): void {
  directionCache.clear();
  digitCache.clear();
}
