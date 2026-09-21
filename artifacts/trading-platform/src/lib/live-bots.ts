/**
 * Global "what is trading right now" state.
 *
 * The server's `GET /api/bots/live` is the single source of truth for every
 * engine in the app — the specialist bots in the AI Bots section, the
 * NeuroAI Quantum FAB ("neuroai") and the main autonomous engine
 * ("autonomous"). The layout's live indicator polls it every few seconds so
 * an engine that starts in the background is visible the moment this tab
 * next polls (and immediately after any refresh). The SSE `bot_update`
 * stream keeps the indicator in step between polls without waiting.
 *
 * Strict account isolation: the API returns ONLY the engines owned by the
 * connected Deriv account behind THIS session (session ids are derived from
 * the Deriv login) — an engine running under a different Deriv account is
 * never listed, so the indicator is always "what is my account doing".
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
  /** Console id the API expects (e.g. "killshot-family@1"). */
  console: string;
  status: LiveBotStatus;
}

/**
 * The stop endpoint for each engine. Everything not named here rides the
 * generic specialist route (`/api/bots/:botId/stop`).
 *
 * The two app-level engines stop through their OWN routes:
 *  - "neuroai"    → the NeuroAI Quantum FAB session
 *  - "autonomous" → the main autonomous engine (toggle off)
 */
export function stopPathForBot(botId: string): string {
  switch (botId) {
    case "apex":
      return "/api/bots/apex/stop";
    case "duallock":
      return "/api/bots/duallock/stop";
    case "killshot":
      return "/api/bots/killshot/stop";
    case "ks-overunder":
    case "ks-parity":
    case "ks-matchdiff":
      return "/api/bots/family/stop";
    case "neuroai":
      return "/api/speed-ai/stop";
    case "autonomous":
      return "/api/ai/engine/toggle";
    default:
      return `/api/bots/${botId}/stop`;
  }
}

/**
 * Extra POST body for non-bots stop endpoints. The autonomous engine is
 * toggled (running:false); everything else stops with an empty body.
 */
export function stopBodyForBot(botId: string): Record<string, unknown> | undefined {
  if (botId === "autonomous") return { running: false };
  return undefined;
}

/**
 * Where the "Open" action should take the user for each engine.
 *  - catalogue bots  → their live console on the AI Bots page
 *  - "neuroai"       → the NeuroAI FAB panel (opened via a window event,
 *                      the FAB button lives on every page)
 *  - "autonomous"    → the dashboard, which hosts the engine's live card
 * Returns null when there is no dedicated target (the engine is always
 * reachable through its own UI, so nothing is lost).
 */
export function openPathForBot(botId: string): string | null {
  if (botId === "neuroai" || botId === "autonomous") return null;
  return `/bots?open=${botId}`;
}

/** Event name the layout uses to ask the NeuroAI FAB to open its panel. */
export const OPEN_SPEED_AI_EVENT = "neurotrade:open-speed-ai";

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
