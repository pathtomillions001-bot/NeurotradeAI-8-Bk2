/**
 * Trading Execution Arbiter — SESSION-SCOPED
 *
 * ONE ACCOUNT = ONE recovery ledger = ONE executing engine at a time — but
 * DIFFERENT accounts run completely independently. The ownership lock is keyed
 * by account session (browser session id): an autonomous engine trading on
 * account A never blocks (or is blocked by) a NeuroAI FAB session or a
 * specialist bot trading on account B, even when both apps are open in the
 * same browser or the same Google account.
 *
 * Root cause of the "normal/recovery mix-up" incident (within ONE account):
 * the main autonomous engine (`runAutonomousLoop` in routes/ai.ts) and the
 * NeuroAI FAB engine (`runLoop` in lib/speed-ai-engine.ts) could trade the
 * same Deriv account simultaneously while each tracked its own private
 * recovery state. Every win or loss was only visible to the engine that placed
 * it, so the merged account journal looked schizophrenic. Recovery debt is
 * account-level, so exactly one engine may execute against each account's
 * ledger at any moment. Ownership only blocks TRADE EXECUTION — status
 * endpoints, scanning, and analysis always work.
 *
 * Three executors share each per-session lock: the main autonomous engine
 * (`autonomous`), the NeuroAI Quantum FAB (`neuroai`) and the specialist AI
 * bots (`bots`).
 *
 * Session resolution: an explicit `sessionId` argument wins; otherwise the
 * AsyncLocalStorage browser-session context is used (set for every request by
 * the browserSession middleware and for every engine loop via runWithSession);
 * calls with no context at all (e.g. tests) share the legacy global bucket,
 * preserving the pre-multi-account behaviour.
 */

import { getBrowserSessionId } from "./session";

/**
 * `dbot` is the Deriv DBot a user built from a scan and is running in Bot
 * Studio. The bot itself executes in the browser, so the server cannot see its
 * fills directly — but it CAN see that one has been started for this account,
 * and it must hold this lock for as long as the user says it is running
 * (POST /api/dbots/:id/live + heartbeats). That is what stops a server engine
 * from starting next to it and double-trading the same shared recovery ledger.
 */
export type TradingOwner = "autonomous" | "neuroai" | "bots" | "dbot";

const ownersBySession = new Map<string, TradingOwner>();

function scopeKey(sessionId?: string): string {
  if (sessionId) return sessionId;
  const contextual = getBrowserSessionId();
  return contextual && contextual !== "legacy" ? contextual : "legacy";
}

/**
 * Take trading ownership for `owner` on `sessionId`'s account. Idempotent for
 * the current owner of that account. Returns false when another engine already
 * owns execution on THAT account (other accounts are unaffected).
 */
export function acquireTradingOwnership(owner: TradingOwner, sessionId?: string): boolean {
  const key = scopeKey(sessionId);
  const active = ownersBySession.get(key) ?? null;
  if (active === null || active === owner) {
    ownersBySession.set(key, owner);
    return true;
  }
  return false;
}

/** Give up trading ownership on `sessionId`'s account. Only the current owner can release it. */
export function releaseTradingOwnership(owner: TradingOwner, sessionId?: string): void {
  const key = scopeKey(sessionId);
  if (ownersBySession.get(key) === owner) ownersBySession.delete(key);
}

/** Which engine currently owns trade execution on `sessionId`'s account, if any. */
export function currentTradingOwner(sessionId?: string): TradingOwner | null {
  return ownersBySession.get(scopeKey(sessionId)) ?? null;
}

/** True when `owner` holds the execution lock on `sessionId`'s account right now. */
export function hasTradingOwnership(owner: TradingOwner, sessionId?: string): boolean {
  return ownersBySession.get(scopeKey(sessionId)) === owner;
}

/** Human-readable owner label for error messages and UI toasts. */
export function tradingOwnerLabel(owner: TradingOwner): string {
  if (owner === "autonomous") return "main autonomous engine";
  if (owner === "neuroai") return "NeuroAI FAB session";
  if (owner === "dbot") return "Deriv DBot (Bot Studio)";
  return "specialist AI bot";
}
