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
 * session's context (runWithSessionId), so a /live poll from ANY session sees
 * every engine that is actually running, regardless of whose tab is asking.
 *
 * Self-cleaning: entries whose owner is no longer running are dropped on the
 * next poll — engines have many stop paths (circuit breakers, feed stalls,
 * explicit stop), so a single withdrawal call would be error-prone.
 */

import { getBrowserSessionId, runWithSessionId } from "./session";

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
  ownerSessionId: string;
  status: () => LiveBotStatusShape | null;
}

const registrations = new Map<string, LiveBotRegistration>();

/**
 * Called by an engine's startSession (in the starting session's ambient
 * context) to publish its live status. `key` identifies the engine
 * (e.g. "twin-hedge"); re-registering replaces the previous entry.
 */
export function registerLiveBot(key: string, status: () => LiveBotStatusShape | null): void {
  registrations.set(key, {
    ownerSessionId: getBrowserSessionId(),
    status,
  });
}

/** Drop a registration (best-effort; polling cleans up stale entries anyway). */
export function unregisterLiveBot(key: string): void {
  registrations.delete(key);
}

/**
 * Every engine that is ACTUALLY running right now, with its full status read
 * under the owning session's context. Safe to call from any request context.
 */
export function listLiveBots(): Array<{
  ownerSessionId: string;
  status: LiveBotStatusShape;
}> {
  const live: Array<{ ownerSessionId: string; status: LiveBotStatusShape }> = [];
  for (const [key, reg] of [...registrations.entries()]) {
    let status: LiveBotStatusShape | null;
    try {
      status = runWithSessionId(reg.ownerSessionId, () => reg.status());
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
