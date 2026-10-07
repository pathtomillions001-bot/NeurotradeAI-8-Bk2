/**
 * Live Desk stream.
 *
 * The Desk used to poll `/api/desk/instruments` every four seconds, so the
 * price on screen was always at least one poll old — and on a symbol the EA
 * had not reached in its rotation, several heartbeats old. The API now pushes
 * every quote the instant the MT5 terminal's heartbeat lands.
 *
 * Polling is kept as a *fallback*, not the primary path: if the event stream
 * drops (proxy timeout, tab suspension, a redeploy) the desk silently reverts
 * to a slower refresh instead of freezing on stale prices.
 */

import { useEffect, useRef, useState } from "react";
import { deskUrl } from "@/lib/desk";
import { withTabSession } from "@/lib/tab-session";
import type {
  Account,
  ArmedPlan,
  FeedDiagnostics,
  Instrument,
  Position,
  TradeMode,
} from "@/lib/desk";

export interface DeskStreamPayload {
  serverTime: number;
  mode: TradeMode;
  autoTrade: boolean;
  terminal: { login: number; lastSyncAt: number; stale: boolean } | null;
  account: Account | null;
  instruments: Instrument[];
  positions: Position[];
  plans: ArmedPlan[];
  clockSkewMs: number | null;
  lastQuoteAgeMs: number | null;
}

export interface DeskStreamState {
  /** Latest pushed prices, or null until the first event arrives. */
  instruments: Instrument[] | null;
  account: Account | null;
  positions: Position[] | null;
  plans: ArmedPlan[] | null;
  terminal: DeskStreamPayload["terminal"];
  connected: boolean;
  /** Server timestamp of the last event — a heartbeat, not a price update. */
  lastEventAt: number | null;
  feed: FeedDiagnostics | null;
}

/** Poll fallback interval when the stream is down. */
const FALLBACK_POLL_MS = 4_000;

export function deskStreamUrl(): string {
  return withTabSession(deskUrl("/desk/stream"));
}

/**
 * Subscribe to the Desk's server-sent event stream.
 *
 * `enabled` lets the caller avoid holding a connection open on a desk that is
 * not paired yet.
 */
export function useDeskStream(enabled: boolean): DeskStreamState & {
  /** Poll once — used by the fallback timer and after mutations. */
  refresh: () => void;
} {
  const [state, setState] = useState<DeskStreamState>({
    instruments: null,
    account: null,
    positions: null,
    plans: null,
    terminal: null,
    connected: false,
    lastEventAt: null,
    feed: null,
  });
  const [tick, setTick] = useState(0);
  const lastEventAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState((prev) => ({ ...prev, connected: false }));
      return;
    }

    const source = new EventSource(deskStreamUrl());

    source.addEventListener("desk", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as DeskStreamPayload;
        lastEventAtRef.current = Date.now();
        setState({
          instruments: payload.instruments,
          account: payload.account,
          positions: payload.positions,
          plans: payload.plans,
          terminal: payload.terminal,
          connected: true,
          lastEventAt: Date.now(),
          feed: {
            clockSkewMs: payload.clockSkewMs,
            clockWarning: null,
            lastQuoteAgeMs: payload.lastQuoteAgeMs,
            quoteFreshForMs: 8_000,
          },
        });
      } catch {
        // A malformed frame must not kill the stream.
      }
    });

    source.onopen = () => setState((prev) => ({ ...prev, connected: true }));
    source.onerror = () => setState((prev) => ({ ...prev, connected: false }));

    return () => source.close();
  }, [enabled]);

  // Fallback polling while the stream is not delivering.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      if (lastEventAtRef.current && Date.now() - lastEventAtRef.current < FALLBACK_POLL_MS) return;
      setTick((value) => value + 1);
    }, FALLBACK_POLL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  return { ...state, refresh: () => setTick((value) => value + 1) };
}

export { FALLBACK_POLL_MS };
