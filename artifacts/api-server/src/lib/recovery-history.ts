/** Broker history warm-up, merged with the current live generation. Never mix
 * simulated prices into a live recovery analysis. Public history is cached, not
 * fetched repeatedly for every family or account. */
import type { DigitSnapshot, DigitTick } from "./digit-tape";
import {
  tickManager,
  tickSecondsFor,
  getMarketInfo,
  extractLastDigit,
} from "./deriv";
import { RECOVERY_POLICY } from "./recovery-quality";

interface History {
  epoch: number;
  price: number;
  digit: number;
}
const cache = new Map<
  string,
  { generation: number; history: History[]; retryAt: number }
>();
const pending = new Map<string, Promise<void>>();

export function mergeRecoveryHistory(
  live: DigitSnapshot,
  history: History[],
  periodMs: number,
): DigitSnapshot {
  if (live.tick.source !== "live" || !history.length) return live;
  const map = new Map<number, History>();
  for (const t of history) {
    if (
      !Number.isFinite(t.epoch) ||
      !Number.isFinite(t.price) ||
      t.price <= 0 ||
      !Number.isInteger(t.digit) ||
      t.digit < 0 ||
      t.digit > 9
    )
      return live;
    if (t.epoch <= live.tick.epoch) map.set(t.epoch, t);
  }
  for (const t of live.ticks) {
    if (t.source !== "live" || t.generation !== live.tick.generation)
      return live;
    const previous = map.get(t.epoch);
    if (previous && (previous.price !== t.price || previous.digit !== t.digit))
      return live;
    map.set(t.epoch, t);
  }
  let ordered = [...map.values()].sort((a, b) => a.epoch - b.epoch);
  // Keep only the latest uninterrupted run. A historical gap is not evidence.
  let start = 0;
  for (let i = 1; i < ordered.length; i++)
    if ((ordered[i].epoch - ordered[i - 1].epoch) * 1000 > periodMs * 3)
      start = i;
  ordered = ordered.slice(start).slice(-RECOVERY_POLICY.history);
  const ticks: DigitTick[] = ordered.map((t, i) => ({
    ...t,
    symbol: live.tick.symbol,
    source: "live",
    generation: live.tick.generation,
    sequence: live.tick.sequence - (ordered.length - 1 - i),
    receivedAt: t.epoch * 1000,
  }));
  if (ticks.length) ticks[ticks.length - 1] = { ...live.tick };
  return { tick: { ...live.tick }, ticks };
}
export function recoverySnapshot(symbol: string): DigitSnapshot | null {
  const live = tickManager.getDigitSnapshot(symbol, RECOVERY_POLICY.history);
  if (!live) return null;
  const hit = cache.get(symbol);
  return hit?.generation === live.tick.generation
    ? mergeRecoveryHistory(live, hit.history, tickSecondsFor(symbol) * 1000)
    : live;
}
export async function primeRecoveryHistory(symbol: string): Promise<void> {
  const existing = pending.get(symbol);
  if (existing) return existing;
  const live = tickManager.getDigitSnapshot(symbol, RECOVERY_POLICY.history);
  if (
    !live ||
    live.tick.source !== "live" ||
    live.ticks.length >= RECOVERY_POLICY.history
  )
    return;
  const hit = cache.get(symbol);
  if (
    hit?.generation === live.tick.generation &&
    (hit.history.length || hit.retryAt > Date.now())
  )
    return;
  const task = (async () => {
    // Set backoff before I/O, including broker refusals/timeouts.
    cache.set(symbol, {
      generation: live.tick.generation,
      history: [],
      retryAt: Date.now() + 60_000,
    });
    const msg = await tickManager.request(
      {
        ticks_history: symbol,
        style: "ticks",
        count: RECOVERY_POLICY.history,
        end: "latest",
      },
      5000,
    );
    const prices = msg?.history?.prices,
      times = msg?.history?.times;
    const market = getMarketInfo(symbol);
    if (
      !market ||
      !Array.isArray(prices) ||
      !Array.isArray(times) ||
      prices.length !== times.length
    )
      return;
    const history: History[] = prices.map((p, i) => ({
      price: Number(p),
      epoch: Number(times[i]),
      digit: extractLastDigit(Number(p), market.pipSize),
    }));
    if (
      history.some(
        (t, i) =>
          !Number.isFinite(t.price) ||
          t.price <= 0 ||
          !Number.isFinite(t.epoch) ||
          (i > 0 && t.epoch <= history[i - 1].epoch),
      )
    )
      return;
    cache.set(symbol, {
      generation: live.tick.generation,
      history,
      retryAt: Date.now() + 60_000,
    });
  })().finally(() => pending.delete(symbol));
  pending.set(symbol, task);
  await task;
}
