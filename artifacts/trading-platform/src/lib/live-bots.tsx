/**
 * Global "what is trading right now" state — scoped to the connected account.
 *
 * The server's `GET /api/bots/live` is the single source of truth for every
 * engine (specialist, Dual-Lock, Kill-Shot, Kill-Shot family, Match Prism). It
 * answers a question with TWO parts, not one:
 *
 *   "is a bot running?"  AND  "is it running on THIS Deriv account?"
 *
 * A browser session can hold several linked Deriv accounts and switch between
 * them. An engine reads the active account once when it starts and then trades
 * that account's token — so after a switch the sidebar and the running bot can
 * disagree, and a bot started on account A must never be presented as the live
 * bot of account B. The API stamps every live entry with the account it was
 * started on and reports a `scope` against the account the browser is on now:
 *
 *   "this-account"  — yours, on the account you are connected to.
 *   "other-account" — same browser, a DIFFERENT linked account. Visible (a
 *                     running engine must never be invisible) but never
 *                     rendered as this account's bot.
 *   "other-session" — another browser session's engine: masked marker only.
 *   "unattributed"  — no account stamp (paper trading): treated as your own.
 *
 * `LiveBotsProvider` polls this once for the whole app, so the layout's popup
 * and the Bot Arena cards cannot disagree about what is running.
 */

import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from "react";
import { withTabSession } from "./tab-session";

export type LiveBotScope = "this-account" | "other-account" | "other-session" | "unattributed";

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
  /** Deriv login this bot is trading (null when masked or unattributed). */
  account?: string | null;
  /** How this bot relates to the account this browser is connected to. */
  scope: LiveBotScope;
  status: LiveBotStatus;
}

export interface LiveBotsState {
  bots: LiveBot[];
  /** Deriv login the API sees this browser connected to (null when none). */
  account: string | null;
}

/** The one running bot that belongs to the account this browser is on. */
export function ownAccountBot(bots: LiveBot[]): LiveBot | null {
  return bots.find(b => b.scope === "this-account" || b.scope === "unattributed") ?? null;
}

/** A bot running for this browser, but on a DIFFERENT linked Deriv account. */
export function otherAccountBot(bots: LiveBot[]): LiveBot | null {
  return bots.find(b => b.scope === "other-account") ?? null;
}

/** A bot running for another browser session (masked, no telemetry). */
export function otherSessionBot(bots: LiveBot[]): LiveBot | null {
  return bots.find(b => b.scope === "other-session") ?? null;
}

/**
 * The stop endpoint for each bot family. Everything not named here rides the
 * generic specialist route (`/api/bots/:botId/stop`).
 */
export function stopPathForBot(botId: string): string {
  switch (botId) {
    case "duallock":
      return "/api/bots/duallock/stop";
    case "killshot":
      return "/api/bots/killshot/stop";
    case "ks-overunder":
    case "ks-parity":
    case "ks-matchdiff":
      return "/api/bots/family/stop";
    case "match-prism":
      return "/api/bots/prism/stop";
    default:
      return `/api/bots/${botId}/stop`;
  }
}

// ── Immediate refresh, for account switches ───────────────────────────────────
//
// Scope is decided by the account the browser is on, and the account changes
// outside this hook (the account switcher / the connect page). Waiting for the
// next 5s poll would leave the popup attributing a bot to the account the user
// just left, for up to five seconds — exactly the confusion this module exists
// to remove. Anything that changes the connected account calls `refreshLiveBots()`
// and every mounted poll refetches at once.

const refreshListeners = new Set<() => void>();

export function refreshLiveBots(): void {
  for (const listener of [...refreshListeners]) {
    try {
      listener();
    } catch {
      /* a listener must never break the others */
    }
  }
}

/**
 * Every engine running for THIS session, each tagged with how it relates to the
 * currently connected account. Polls `/api/bots/live` and merges SSE
 * `bot_update` payloads between polls. Never throws — an unreachable API keeps
 * the last known state.
 */
export function useLiveBots(pollMs = 5_000): LiveBotsState {
  const [state, setState] = useState<LiveBotsState>({ bots: [], account: null });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/bots/live");
      if (!res.ok) return;
      const data = await res.json();
      const bots = Array.isArray(data?.bots) ? (data.bots as LiveBot[]) : [];
      const account = typeof data?.account?.loginId === "string" ? data.account.loginId : null;
      setState({ bots, account });
    } catch {
      /* keep the last known state */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    refreshListeners.add(refresh);
    return () => {
      clearInterval(id);
      refreshListeners.delete(refresh);
    };
  }, [refresh, pollMs]);

  // SSE keeps the indicator live between polls.
  useEffect(() => {
    let es: EventSource;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const apply = (status: LiveBotStatus) => {
      const botId = status.botId;
      if (!botId) return;
      setState(prev => {
        const idx = prev.bots.findIndex(b => b.botId === botId);
        if (status.running) {
          if (idx >= 0) {
            const next = [...prev.bots];
            const existing = next[idx]!;
            next[idx] = {
              ...existing,
              botName: existing.botName || status.botName || botId,
              status: { ...existing.status, ...status },
            };
            return { ...prev, bots: next };
          }
          // An SSE `bot_update` is only ever broadcast to the session that owns
          // the engine, so a bot appearing here has just started for THIS
          // session — which means it is running on the account this browser is
          // on right now. (If the account is switched away a moment later, the
          // next poll re-scopes it; `refreshLiveBots()` makes that immediate.)
          return {
            ...prev,
            bots: [...prev.bots, { botId, botName: status.botName ?? botId, console: "", account: prev.account, scope: "this-account", status }],
          };
        }
        if (idx >= 0) return { ...prev, bots: prev.bots.filter((_, i) => i !== idx) };
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

  return state;
}

// ── One poll for the whole app ────────────────────────────────────────────────
//
// The layout's popup and the Bot Arena both need this answer. Polling it twice
// would let the two disagree for a few seconds at exactly the moment that
// matters (a bot starting, an account switching), so the layout owns the poll
// and everything else reads it from here.

const LiveBotsContext = createContext<LiveBotsState>({ bots: [], account: null });

export function LiveBotsProvider({ children, pollMs }: { children: ReactNode; pollMs?: number }) {
  const state = useLiveBots(pollMs);
  return <LiveBotsContext.Provider value={state}>{children}</LiveBotsContext.Provider>;
}

export function useLiveBotsState(): LiveBotsState {
  return useContext(LiveBotsContext);
}
