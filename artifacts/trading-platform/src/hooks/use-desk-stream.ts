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
  Instrument,
  Position,
  TradeMode,
} from "@/lib/desk";

export interface DeskStreamPayload {
  serverTime: number;
  mode: TradeMode;
  autoTrade: boolean;
  terminal: { login: number; lastSyncAt: number; stale: boolean; degraded?: boolean } | null;
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
  terminal: { login: number; lastSyncAt: number; stale: boolean; degraded?: boolean } | null;
  connected: boolean;
  /**
   * True while `desk` events are actually arriving. Distinct from
   * `connected` (the socket being open): during a heartbeat gap the socket
   * stays open but no data flows, and the desk must fall back to fast polling
   * instead of showing frozen prices for twenty seconds.
   */
  flowing: boolean;
  /** Server timestamp of the last event — a heartbeat, not a price update. */
  lastEventAt: number | null;
}

/**
 * How long to consider SSE data "fresh" before falling back to polling.
 *
 * When the stream has not delivered an event within this window the hook
 * clears its cached instruments/account/positions/plans so the polled REST
 * data takes over. Without this, the stale SSE array (which is non-null and
 * therefore wins `??` over the polling query's data) would keep being
 * rendered indefinitely — which is exactly the bug that made the Desk show
 * frozen prices after every proxy timeout or redeploy.
 */
const STALE_STREAM_MS = 6_000;

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
    flowing: false,
    lastEventAt: null,
  });
  const [tick, setTick] = useState(0);
  const lastEventAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState({
        instruments: null,
        account: null,
        positions: null,
        plans: null,
        terminal: null,
        connected: false,
        flowing: false,
        lastEventAt: null,
      });
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
          flowing: true,
          lastEventAt: Date.now(),
        });
      } catch {
        // A malformed frame must not kill the stream.
      }
    });

    source.onopen = () => setState((prev) => ({ ...prev, connected: true }));
    source.onerror = () => setState((prev) => ({ ...prev, connected: false }));

    return () => source.close();
  }, [enabled]);

  // Stale-data watchdog: when the SSE stream has not delivered an event in
  // STALE_STREAM_MS the cached push data is cleared so the polled REST
  // fallback takes over. Without this, `stream.instruments` (a non-null
  // array) shadows `instruments.data?.instruments` via `??` — and the Desk
  // renders frozen prices from the last successful push forever.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      const last = lastEventAtRef.current;
      if (last !== null && Date.now() - last > STALE_STREAM_MS) {
        // Clear the push cache so the polling fallback wins the `??` race,
        // and mark the stream as not flowing so the desk polls fast and the
        // STREAM/POLL badge tells the truth.
        setState((prev) => ({
          ...prev,
          instruments: null,
          account: null,
          positions: null,
          plans: null,
          flowing: false,
          // Keep terminal — it describes the connection, not tick-level data,
          // and the REST /state query already refreshes it independently.
        }));
        lastEventAtRef.current = null;
      }
      setTick((value) => value + 1);
    }, STALE_STREAM_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  return { ...state, refresh: () => setTick((value) => value + 1) };
}

export { STALE_STREAM_MS };
