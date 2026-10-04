/** Verified, broker-backed history loader used only by autonomous recovery v2. */

import type { DigitSnapshot } from "./digit-tape";
import { tickManager, tickSecondsFor } from "./deriv";
import {
  mergeRecoveryHistory,
  recoveryFeedRejection,
  type RecoveryMarketSample,
} from "./recovery-decision-v2";

const RECOVERY_HISTORY_TICKS = 1_500;
const RECOVERY_HISTORY_TTL_MS = 60_000;
const RECOVERY_HISTORY_FAILURE_BACKOFF_MS = 15_000;
const RECOVERY_HISTORY_TIMEOUT_MS = 1_800;

interface BrokerHistory {
  prices: unknown[];
  times: unknown[];
}

interface HistoryCacheEntry {
  generation: number;
  fetchedAt: number;
  retryAfter: number;
  history: BrokerHistory | null;
  loading: Promise<BrokerHistory | null> | null;
}

export interface VerifiedRecoveryMarketTape {
  snapshot: DigitSnapshot | null;
  samples: RecoveryMarketSample[];
  feedSource: "live" | "simulated" | "missing";
  ageMs: number | null;
  historyUsed: boolean;
  rejectionReason: string | null;
  historyRejectionReason: string | null;
}

const historyBySymbol = new Map<string, HistoryCacheEntry>();

function normalizeHistoryResponse(response: any): BrokerHistory | null {
  const prices = response?.history?.prices;
  const times = response?.history?.times;
  if (
    response?.msg_type !== "history" ||
    !Array.isArray(prices) ||
    !Array.isArray(times) ||
    prices.length === 0 ||
    prices.length !== times.length
  ) return null;
  return { prices, times };
}

async function fetchBrokerHistory(
  symbol: string,
  generation: number,
): Promise<BrokerHistory | null> {
  const now = Date.now();
  let entry = historyBySymbol.get(symbol);
  if (!entry || entry.generation !== generation) {
    entry = {
      generation,
      fetchedAt: 0,
      retryAfter: 0,
      history: null,
      loading: null,
    };
    historyBySymbol.set(symbol, entry);
  }
  if (entry.history && now - entry.fetchedAt < RECOVERY_HISTORY_TTL_MS) {
    return entry.history;
  }
  if (entry.loading) return entry.loading;
  if (now < entry.retryAfter || !tickManager.getConnectionStatus()) return null;

  const activeEntry = entry;
  const loading = (async () => {
    let history: BrokerHistory | null = null;
    try {
      const response = await tickManager.request({
        ticks_history: symbol,
        count: RECOVERY_HISTORY_TICKS,
        end: "latest",
        style: "ticks",
      }, RECOVERY_HISTORY_TIMEOUT_MS);
      history = normalizeHistoryResponse(response);
    } catch {
      history = null;
    }

    if (historyBySymbol.get(symbol) === activeEntry) {
      activeEntry.loading = null;
      if (history) {
        activeEntry.history = history;
        activeEntry.fetchedAt = Date.now();
        activeEntry.retryAfter = 0;
      } else {
        activeEntry.history = null;
        activeEntry.retryAfter = Date.now() + RECOVERY_HISTORY_FAILURE_BACKOFF_MS;
      }
    }
    return history;
  })();
  activeEntry.loading = loading;
  historyBySymbol.set(symbol, activeEntry);
  return loading;
}

function invalidateCachedHistory(symbol: string, generation: number): void {
  const entry = historyBySymbol.get(symbol);
  if (!entry || entry.generation !== generation) return;
  entry.history = null;
  entry.fetchedAt = 0;
  entry.loading = null;
  entry.retryAfter = Date.now() + RECOVERY_HISTORY_FAILURE_BACKOFF_MS;
}

/**
 * Resolve one market's same-generation live tape, warming it with Deriv's
 * ticks_history response when the in-process tape is shallow. History is
 * merged by broker epoch and checked against overlapping live ticks. A fallback
 * to a live-only tape is allowed; simulated data and stale feeds are never
 * eligible for recovery v2.
 */
export async function getVerifiedRecoveryMarketTape(
  symbol: string,
  pipSize: number,
  now = Date.now(),
): Promise<VerifiedRecoveryMarketTape> {
  const periodMs = tickSecondsFor(symbol) * 1_000;
  let snapshot = tickManager.getDigitSnapshot(symbol, RECOVERY_HISTORY_TICKS);
  if (!snapshot) {
    return {
      snapshot: null,
      samples: [],
      feedSource: "missing",
      ageMs: null,
      historyUsed: false,
      rejectionReason: "no_tick_snapshot",
      historyRejectionReason: null,
    };
  }

  const feedSource = snapshot.tick.source;
  const ageMs = now - snapshot.tick.receivedAt;
  const freshnessReason = recoveryFeedRejection(
    snapshot,
    now,
    Math.max(5_000, periodMs * 3),
  );
  if (freshnessReason) {
    return {
      snapshot,
      samples: [],
      feedSource,
      ageMs,
      historyUsed: false,
      rejectionReason: freshnessReason,
      historyRejectionReason: null,
    };
  }

  let history: BrokerHistory | null = null;
  if (
    snapshot.ticks.length < RECOVERY_HISTORY_TICKS &&
    tickManager.getConnectionStatus()
  ) {
    history = await fetchBrokerHistory(symbol, snapshot.tick.generation);
    // Anchor the merge to the latest tick after the history request completes.
    const latestSnapshot = tickManager.getDigitSnapshot(symbol, RECOVERY_HISTORY_TICKS);
    if (
      !latestSnapshot ||
      latestSnapshot.tick.source !== "live" ||
      latestSnapshot.tick.generation !== snapshot.tick.generation
    ) {
      return {
        snapshot: latestSnapshot ?? snapshot,
        samples: [],
        feedSource: latestSnapshot?.tick.source ?? feedSource,
        ageMs: latestSnapshot ? Date.now() - latestSnapshot.tick.receivedAt : ageMs,
        historyUsed: false,
        rejectionReason: "feed_generation_changed_during_history_load",
        historyRejectionReason: null,
      };
    }
    snapshot = latestSnapshot;
  }

  let samples: RecoveryMarketSample[] = [];
  let historyRejectionReason: string | null = null;
  let historyUsed = false;
  if (history) {
    try {
      samples = mergeRecoveryHistory(history, snapshot, pipSize, periodMs, RECOVERY_HISTORY_TICKS);
      historyUsed = true;
    } catch (error) {
      historyRejectionReason = error instanceof Error ? error.message : "invalid_broker_history";
      invalidateCachedHistory(symbol, snapshot.tick.generation);
    }
  }

  if (!historyUsed) {
    try {
      samples = mergeRecoveryHistory(null, snapshot, pipSize, periodMs, RECOVERY_HISTORY_TICKS);
    } catch (error) {
      return {
        snapshot,
        samples: [],
        feedSource: snapshot.tick.source,
        ageMs: Date.now() - snapshot.tick.receivedAt,
        historyUsed: false,
        rejectionReason: error instanceof Error ? error.message : "invalid_live_tape",
        historyRejectionReason,
      };
    }
  }

  return {
    snapshot,
    samples,
    feedSource: snapshot.tick.source,
    ageMs: Date.now() - snapshot.tick.receivedAt,
    historyUsed,
    rejectionReason: null,
    historyRejectionReason,
  };
}

