/**
 * Global "what is trading right now" state.
 *
 * The server's `GET /api/bots/live` is the single source of truth for every
 * engine (specialist, Dual-Lock, Twin-Lock, Accumulator, Kill-Shot, Kill-Shot
 * family, Match Catalyst) — the layout's live indicator polls it every few
 * seconds so a bot that starts in the background is visible the moment this
 * tab next polls (and immediately after any refresh). The SSE `bot_update`
 * stream keeps the indicator in step between polls without waiting.
 *
 * Privacy: the API masks status details for engines owned by ANOTHER browser
 * session (same rule as every other status endpoint) — the indicator then
 * shows a plain "engine active" marker so nothing runs invisibly, without
 * leaking one visitor's telemetry to another.
 */

import { useCallback, useEffect, useState } from "react";
import { withTabSession } from "./tab-session";

export interface LiveBotStatus {
  running: boolean;
  /** Set by the API when the engine belongs to another browser session. */
  masked?: boolean;
  botId?: string | null;
  botName?: string | null;
  totalProfit?: number;
  tradeCount?: number;
  winCount?: number;
  lossCount?: number;
  currentMarket?: string;
  currentContractType?: string;
  message?: string;
  inRecovery?: boolean;
  recoveryStep?: number;
  [key: string]: unknown;
}

export interface LiveBot {
  botId: string;
  botName: string;
  /** Console id the API expects (e.g. "twin-hedge@1"). */
  console: string;
  status: LiveBotStatus;
}

/**
 * The stop endpoint for each bot family. Everything not named here rides the
 * generic specialist route (`/api/bots/:botId/stop`).
 */
export function stopPathForBot(botId: string): string {
  switch (botId) {
    case "duallock":
      return "/api/bots/duallock/stop";
    case "twinhedge":
      return "/api/bots/twin/stop";
    case "accumulators":
      return "/api/bots/accumulator/stop";
    case "killshot":
      return "/api/bots/killshot/stop";
    case "match-catalyst":
      return "/api/bots/catalyst/stop";
    case "ks-overunder":
    case "ks-parity":
    case "ks-matchdiff":
      return "/api/bots/family/stop";
    default:
      return `/api/bots/${botId}/stop`;
  }
}

/**
 * All engines currently running for THIS session (the arbiter caps it at one).
 * Polls `/api/bots/live` on an interval and merges SSE `bot_update` payloads
 * between polls. Never throws — an unreachable API keeps the last known state.
 */
export function useLiveBots(pollMs = 5_000): LiveBot[] {
  const [live, setLive] = useState<LiveBot[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/bots/live");
      if (!res.ok) return;
      const data = await res.json();
      const bots = Array.isArray(data?.bots) ? data.bots : [];
      setLive(bots as LiveBot[]);
    } catch {
      /* keep the last known state */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  // SSE keeps the indicator live between polls.
  useEffect(() => {
    let es: EventSource;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const apply = (status: LiveBotStatus) => {
      const botId = status.botId;
      if (!botId) return;
      setLive(prev => {
        const idx = prev.findIndex(b => b.botId === botId);
        if (status.running) {
          if (idx >= 0) {
            const next = [...prev];
            const existing = next[idx]!;
            next[idx] = {
              ...existing,
              botName: existing.botName || status.botName || botId,
              status: { ...existing.status, ...status },
            };
            return next;
          }
          return [...prev, { botId, botName: status.botName ?? botId, console: "", status }];
        }
        if (idx >= 0) return prev.filter((_, i) => i !== idx);
        return prev;
      });
    };

    function connect() {
      if (destroyed) return;
      es = new EventSource(withTabSession("/api/ai/events"));
      es.addEventListener("bot_update", (e: MessageEvent) => {
        try {
          apply(JSON.parse(e.data) as LiveBotStatus);
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        es.close();
        if (!destroyed) reconnect = setTimeout(connect, 2500);
      };
    }
    connect();

    return () => {
      destroyed = true;
      if (reconnect) clearTimeout(reconnect);
      es?.close();
    };
  }, []);

  return live;
}
