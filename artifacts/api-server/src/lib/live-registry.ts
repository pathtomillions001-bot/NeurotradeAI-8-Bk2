/**
 * Cross-session live-engine registry.
 *
 * Why this exists: every bot engine keeps its state through
 * `createSessionScoped` (lib/session.ts) — a Proxy that resolves each read
 * against the AMBIENT browser session (AsyncLocalStorage). An engine running
 * for session A is simply invisible to a request from session B: `isRunning()`
 * under B's context reads B's own empty state. That scoping is exactly what
 * made a running bot trade "in the background" with nothing visible on any
 * page that was not the starting session's.
 *
 * This registry closes the gap: each engine registers its OWN status getter
 * once when a session starts (in the starting session's ambient context).
 * `listLiveBots()` then re-reads every registration under the OWNING
 * session's context (runWithSessionId), so a /live poll from ANY session can
 * discover which engines are actually running — the ROUTE then decides what
 * each session is allowed to see (strictly its own account's engines).
 *
 * Multi-account: registrations are namespaced by OWNING session, so two
 * connected Deriv accounts may run the same engine family at the same time
 * (the execution arbiter is per-account) without clobbering each other's
 * registration.
 *
 * Self-cleaning: entries whose owner is no longer running are dropped on the
 * next poll — engines have many stop paths (circuit breakers, feed stalls,
 * explicit stop), so a single withdrawal call would be error-prone.
 */

import { getBrowserSessionId, runWithSession } from "./session";

/**
 * The shape every engine status shares. Deliberately WITHOUT an index
 * signature so the concrete status interfaces (which carry engine-specific
 * fields) remain assignable to it.
 */
export interface LiveBotStatusShape {
  running: boolean;
  botId?: string | null;
  botName?: string | null;
}

interface LiveBotRegistration {
  /** Engine key (e.g. "killshot-family", "neuroai", "autonomous"). */
  key: string;
  /** The account-scoped session that started (and owns) the engine. */
  ownerSessionId: string;
  status: () => LiveBotStatusShape | null;
}

const registrations = new Map<string, LiveBotRegistration>();

function registryKey(key: string, ownerSessionId: string): string {
  return `${key}::${ownerSessionId}`;
}

/**
 * Called by an engine's startSession (in the starting session's ambient
 * context) to publish its live status. `key` identifies the engine family
 * (e.g. "killshot-family"); re-registering the same family for the SAME
 * owning session replaces the previous entry, while a DIFFERENT owning
 * session gets its own entry (two Deriv accounts can run the same family).
 */
export function registerLiveBot(key: string, status: () => LiveBotStatusShape | null): void {
  const ownerSessionId = getBrowserSessionId();
  registrations.set(registryKey(key, ownerSessionId), { key, ownerSessionId, status });
}

/**
 * Drop a registration (best-effort; polling cleans up stale entries anyway).
 *
 * Called under the owning session it removes exactly that session's entry.
 * Called from a foreign context (no entry for the ambient session) it falls
 * back to removing every entry for the key — the historical behaviour, kept
 * for cleanup paths that have no session context.
 */
export function unregisterLiveBot(key: string): void {
  const ambient = getBrowserSessionId();
  const hasOwnEntry = [...registrations.values()].some(
    r => r.key === key && r.ownerSessionId === ambient,
  );
  for (const [k, reg] of [...registrations.entries()]) {
    if (reg.key !== key) continue;
    if (hasOwnEntry ? reg.ownerSessionId === ambient : true) registrations.delete(k);
  }
}

/**
 * Every engine that is ACTUALLY running right now, with its full status read
 * under the owning session's context. Safe to call from any request context.
 *
 * NOTE: this lists engines of ALL sessions — including other connected Deriv
 * accounts. Callers (GET /api/bots/live) are responsible for scoping the
 * result to the requesting account; other accounts' engines are never shown.
 */
export function listLiveBots(): Array<{
  ownerSessionId: string;
  status: LiveBotStatusShape;
}> {
  const live: Array<{ ownerSessionId: string; status: LiveBotStatusShape }> = [];
  for (const [key, reg] of [...registrations.entries()]) {
    let status: LiveBotStatusShape | null;
    try {
      status = runWithSession(reg.ownerSessionId, () => reg.status());
    } catch {
      status = null;
    }
    if (status && status.running && status.botId) {
      live.push({ ownerSessionId: reg.ownerSessionId, status });
      continue;
    }
    registrations.delete(key);
  }
  return live;
}
