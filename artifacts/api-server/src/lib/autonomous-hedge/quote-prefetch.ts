/**
 * M5 — Quote prefetch for Recovery Quality Pipeline v2.
 *
 * Background task refreshing payout quotes (via existing resolveRecoveryPayout,
 * read-only and unchanged) for every (symbol, contract, barrier) in the active
 * recovery contract set every 25 s while the engine is in or near recovery
 * (lossRun >= 1 or inRecovery).
 *
 * Exposes livePayoutFor(candidate) synchronously for M1/M3 so quote latency is
 * removed from the hot scoring path. If a live quote differs from the table
 * payout by more than 3%, payoutInfoFor flags it for the decision reason text.
 */

import { resolveRecoveryPayout } from "../recovery-payout";
import { HEDGE_DURATION_TICKS, HEDGE_DURATION_UNIT } from "./constants";
import { hedgePayout, type HedgeContractType, type HedgeFamilySpec } from "./hedge-analysis";

export const QUOTE_PREFETCH_INTERVAL_MS = 25_000;
export const PAYOUT_DRIFT_THRESHOLD = 0.03;

interface CachedLiveQuote {
  payoutMultiplier: number;
  source: "live" | "fallback";
  updatedAt: number;
}

export interface PayoutInfo {
  payout: number;
  tablePayout: number;
  source: "live" | "table";
  driftPct: number;
  drifted: boolean;
  flagText: string | null;
}

const prefetchedQuotes = new Map<string, CachedLiveQuote>();
const sessionTimers = new Map<string, ReturnType<typeof setInterval>>();
const inFlightSessions = new Set<string>();

function quoteKey(symbol: string, contract: HedgeContractType, barrier: number): string {
  const normalizedBarrier =
    contract === "DIGITOVER" || contract === "DIGITUNDER" || contract === "DIGITMATCH" || contract === "DIGITDIFF"
      ? barrier >= 0 ? barrier : 0
      : -1;
  return `${symbol}:${contract}:${normalizedBarrier}`;
}

export function setPrefetchedQuoteForTest(
  symbol: string,
  contract: HedgeContractType,
  barrier: number,
  payoutMultiplier: number,
  source: "live" | "fallback" = "live",
): void {
  prefetchedQuotes.set(quoteKey(symbol, contract, barrier), {
    payoutMultiplier,
    source,
    updatedAt: Date.now(),
  });
}

export function clearPrefetchedQuotes(): void {
  prefetchedQuotes.clear();
}

export function payoutInfoFor(candidate: {
  symbol: string;
  contract: HedgeContractType;
  barrier: number;
}): PayoutInfo {
  const tablePayout = hedgePayout(candidate.contract, candidate.barrier);
  if (prefetchedQuotes.size === 0) {
    return {
      payout: tablePayout,
      tablePayout,
      source: "table",
      driftPct: 0,
      drifted: false,
      flagText: null,
    };
  }
  const cached = prefetchedQuotes.get(quoteKey(candidate.symbol, candidate.contract, candidate.barrier));
  if (cached && cached.source === "live" && Number.isFinite(cached.payoutMultiplier) && cached.payoutMultiplier > 1) {
    const payout = cached.payoutMultiplier;
    const driftPct = tablePayout > 0 ? Math.abs(payout - tablePayout) / tablePayout : 0;
    const drifted = driftPct > PAYOUT_DRIFT_THRESHOLD;
    const signedPct = (((payout - tablePayout) / tablePayout) * 100).toFixed(1);
    const flagText = drifted
      ? `[payout drift: live ${payout.toFixed(2)}x vs table ${tablePayout.toFixed(2)}x (${Number(signedPct) >= 0 ? `+${signedPct}` : signedPct}%)]`
      : null;
    return {
      payout,
      tablePayout,
      source: "live",
      driftPct,
      drifted,
      flagText,
    };
  }
  return {
    payout: tablePayout,
    tablePayout,
    source: "table",
    driftPct: 0,
    drifted: false,
    flagText: null,
  };
}

/** Return cached live payout if available, otherwise canonical table payout. */
export function livePayoutFor(candidate: {
  symbol: string;
  contract: HedgeContractType;
  barrier: number;
}): number {
  return payoutInfoFor(candidate).payout;
}

export async function refreshPrefetchedQuotesOnce(input: {
  symbols: readonly string[];
  specs: readonly HedgeFamilySpec[];
  currency?: string;
}): Promise<void> {
  const currency = input.currency ?? "USD";
  const tasks: Array<Promise<void>> = [];

  for (const symbol of input.symbols) {
    for (const spec of input.specs) {
      const barrier =
        spec.type === "DIGITOVER" || spec.type === "DIGITUNDER" || spec.type === "DIGITMATCH" || spec.type === "DIGITDIFF"
          ? spec.barrier >= 0 ? spec.barrier : 0
          : null;
      tasks.push(
        resolveRecoveryPayout({
          symbol,
          contractType: spec.type,
          barrier,
          duration: HEDGE_DURATION_TICKS,
          durationUnit: HEDGE_DURATION_UNIT,
          currency,
        })
          .then((res) => {
            prefetchedQuotes.set(quoteKey(symbol, spec.type, barrier ?? -1), {
              payoutMultiplier: res.payoutMultiplier,
              source: res.source,
              updatedAt: Date.now(),
            });
          })
          .catch(() => {
            // Keep existing cached entry or fall back to table payout.
          }),
      );
    }
  }

  await Promise.all(tasks);
}

/**
 * Start or stop the 25 s background quote prefetch loop for a session.
 * Active whenever the engine is running in or near recovery (inRecovery || lossRun >= 1).
 */
export function syncQuotePrefetchTask(input: {
  sessionId: string;
  active: boolean;
  symbols: readonly string[];
  specs: readonly HedgeFamilySpec[];
  currency?: string;
}): void {
  const { sessionId, active, symbols, specs, currency } = input;
  if (!active || symbols.length === 0 || specs.length === 0) {
    stopQuotePrefetchTask(sessionId);
    return;
  }

  const runOnce = () => {
    if (inFlightSessions.has(sessionId)) return;
    inFlightSessions.add(sessionId);
    void refreshPrefetchedQuotesOnce({ symbols, specs, currency }).finally(() => {
      inFlightSessions.delete(sessionId);
    });
  };

  if (!sessionTimers.has(sessionId)) {
    runOnce();
    const timer = setInterval(runOnce, QUOTE_PREFETCH_INTERVAL_MS);
    timer.unref?.();
    sessionTimers.set(sessionId, timer);
  }
}

export function stopQuotePrefetchTask(sessionId?: string): void {
  if (sessionId !== undefined) {
    const timer = sessionTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      sessionTimers.delete(sessionId);
    }
    inFlightSessions.delete(sessionId);
    return;
  }
  for (const timer of sessionTimers.values()) {
    clearInterval(timer);
  }
  sessionTimers.clear();
  inFlightSessions.clear();
}
