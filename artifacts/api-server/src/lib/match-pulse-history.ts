/** Match Pulse deliberately does not use the length-based getDeepDigits cache. */
import { tickManager, getMarketInfo, extractLastDigit } from "./deriv";
import { tickSecondsFor } from "./accumulator-analysis";
import { mergeLiveDigitHistory, type DigitTick, type DigitSource } from "./digit-tape";
import { PULSE } from "./match-pulse-analysis";

interface HistoryCache {
  generation: number;
  samples: Array<{ epoch: number; digit: number }>;
}
const cache = new Map<string, HistoryCache>();

export interface PulseHistory {
  digits: number[];
  tick: DigitTick;
  source: DigitSource;
}

export function pulseHistoryNow(symbol: string): PulseHistory | null {
  const snapshot = tickManager.getDigitSnapshot(symbol, PULSE.history);
  if (!snapshot) return null;
  let digits = snapshot.ticks.map(t => t.digit);
  const saved = cache.get(symbol);
  if (snapshot.tick.source === "live" && saved?.generation === snapshot.tick.generation) {
    digits = mergeLiveDigitHistory(saved.samples, snapshot, PULSE.history);
  }
  return { digits, tick: snapshot.tick, source: snapshot.tick.source };
}

export async function primePulseHistory(symbol: string): Promise<PulseHistory | null> {
  const before = tickManager.getDigitSnapshot(symbol);
  if (!before) return null;
  if (before.tick.source === "simulated" || before.ticks.length >= PULSE.history || !tickManager.getConnectionStatus()) {
    return pulseHistoryNow(symbol);
  }
  // Timestamped history is fetched once per source generation. The live tape
  // then extends it by epoch, never by ring length or last-digit equality.
  const saved = cache.get(symbol);
  if (saved?.generation === before.tick.generation && saved.samples.length >= PULSE.minHistory) return pulseHistoryNow(symbol);
  const market = getMarketInfo(symbol);
  if (!market?.digitEnabled) return null;
  const message = await tickManager.request({ ticks_history: symbol, count: PULSE.history, end: "latest", style: "ticks" }, 4000);
  const after = tickManager.getDigitSnapshot(symbol);
  if (!after || after.tick.source !== "live" || after.tick.generation !== before.tick.generation) return null;
  const prices: unknown = message?.history?.prices;
  const times: unknown = message?.history?.times;
  if (!Array.isArray(prices) || !Array.isArray(times) || times.length !== prices.length || !times.length) return pulseHistoryNow(symbol);
  let samples = prices.map((price, i) => ({ epoch: Number(times[i]), digit: extractLastDigit(Number(price), market.pipSize) }));
  // Do not fit Markov transitions across a missing block of broker ticks.
  let start = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.epoch - samples[i - 1]!.epoch > tickSecondsFor(symbol) * 3) start = i;
  }
  samples = samples.slice(start);
  // Validate ordering, digits, overlap agreement and source BEFORE caching.
  mergeLiveDigitHistory(samples, after, PULSE.history);
  cache.set(symbol, { generation: after.tick.generation, samples });
  return pulseHistoryNow(symbol);
}
