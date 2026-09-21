/** Source-aware, timestamp-merged history. Never uses ring LENGTH as a clock. */
import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  extractLastDigit,
  tickSecondsFor,
} from "./deriv";
import { mergeLiveDigitHistory } from "./digit-tape";
import {
  evaluatePrism,
  PRISM_HISTORY,
  PRISM_MIN_HISTORY,
  type PrismRiskInput,
} from "./prism-match-analysis";
import type { PrismScanInput } from "./prism-match-policy";
import type { PrismMarket } from "./prism-match-runner";

interface CachedHistory {
  fetchedAt: number;
  generation: number;
  rows: Array<{ epoch: number; digit: number }>;
}
const cache = new Map<string, CachedHistory>();
const inFlight = new Map<string, Promise<CachedHistory | null>>();

async function brokerHistory(
  symbol: string,
  generation: number,
  pip: number,
): Promise<CachedHistory | null> {
  const old = cache.get(symbol);
  if (
    old &&
    old.generation === generation &&
    Date.now() - old.fetchedAt < 60_000
  )
    return old;
  const key = `${symbol}:${generation}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const task = (async () => {
    const response = await tickManager.request(
      {
        ticks_history: symbol,
        count: PRISM_HISTORY,
        end: "latest",
        style: "ticks",
      },
      3500,
    );
    const prices: unknown = response?.history?.prices,
      times: unknown = response?.history?.times;
    if (
      !Array.isArray(prices) ||
      !Array.isArray(times) ||
      prices.length !== times.length ||
      !prices.length
    )
      return null;
    const rows = prices.map((price, i) => {
      const p = Number(price),
        epoch = Number(times[i]);
      if (
        !Number.isFinite(p) ||
        p <= 0 ||
        !Number.isFinite(epoch) ||
        epoch <= 0
      )
        throw new Error("Invalid broker history");
      return { epoch, digit: extractLastDigit(p, pip) };
    });
    // Reject unordered history; retain only the newest contiguous regime.
    let start = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]!.epoch <= rows[i - 1]!.epoch)
        throw new Error("Unordered broker history");
      if (rows[i]!.epoch - rows[i - 1]!.epoch > tickSecondsFor(symbol) * 3)
        start = i;
    }
    const entry = {
      rows: rows.slice(start),
      generation,
      fetchedAt: Date.now(),
    };
    cache.set(symbol, entry);
    return entry;
  })()
    .catch(() => null)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

export async function loadPrismMarket(
  symbol: string,
  config: PrismScanInput,
  risk: PrismRiskInput,
): Promise<PrismMarket | null> {
  const market = AUTOMATED_DERIV_MARKETS.find(
    (m) => m.symbol === symbol && m.digitEnabled,
  );
  if (!market) return null;
  let snapshot = tickManager.getDigitSnapshot(symbol, PRISM_HISTORY);
  if (!snapshot) return null;
  let digits = snapshot.ticks.map((t) => t.digit);
  let historySource: PrismMarket["historySource"] =
    snapshot.tick.source === "live" ? "buffer" : "simulated";
  if (snapshot.tick.source === "live") {
    const generation = snapshot.tick.generation;
    const history = await brokerHistory(symbol, generation, market.pipSize);
    snapshot = tickManager.getDigitSnapshot(symbol, PRISM_HISTORY);
    if (
      !snapshot ||
      snapshot.tick.source !== "live" ||
      snapshot.tick.generation !== generation
    )
      return null;
    digits = snapshot.ticks.map((t) => t.digit);
    if (
      history &&
      history.generation === generation &&
      history.rows.at(-1)!.epoch >=
        snapshot.ticks[0]!.epoch - tickSecondsFor(symbol) * 3
    ) {
      try {
        digits = mergeLiveDigitHistory(history.rows, snapshot, PRISM_HISTORY);
        historySource = "broker";
      } catch {
        /* explicit buffer-only provenance; never patch conflicting data */
      }
    }
  }
  if (digits.length < PRISM_MIN_HISTORY) return null;
  // Yield between markets; there is no CPU-heavy full-history fit on the tick path.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const evaluated = evaluatePrism(digits, {
    ...risk,
    activity: config.activity,
    digit: config.digit,
  });
  return {
    ...evaluated,
    symbol,
    displayName: market.displayName,
    tick: snapshot.tick,
    source: snapshot.tick.source,
    historySource,
    valid: true,
    waitedTicks: 0,
    refreshedAtSequence: snapshot.tick.sequence,
  };
}
