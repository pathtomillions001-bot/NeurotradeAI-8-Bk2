/**
 * Trading Execution Arbiter
 *
 * ONE account = ONE recovery ledger = ONE executing engine at a time.
 *
 * Recovery debt is account-level: there is exactly one shared recovery ledger
 * (`lib/agents/recovery-engine.ts`), and this module enforces that exactly one
 * engine may execute against it at any moment. Ownership only blocks TRADE
 * EXECUTION — status endpoints, scanning, and analysis always work.
 *
 * Three executors share this lock: the main autonomous engine (`autonomous`),
 * the NeuroAI Quantum FAB (`neuroai`), and the specialist AI bots (`bots` — one
 * bot session at a time). They all share the live ledger and must not execute together.
 */

import { getBrowserSessionId } from "./session";

export type TradingOwner = "autonomous" | "neuroai" | "bots";

/**
 * One execution lock PER CONNECTED ACCOUNT (browser session), not one per
 * process. Within one account exactly one of the three executors may trade at a time.
 */
const activeOwnerBySession = new Map<string, TradingOwner>();

function sessionKey(): string {
  return getBrowserSessionId();
}

/**
 * Take trading ownership for `owner`. Idempotent for the current owner.
 * Returns false when the other engine already owns execution.
 */
export function acquireTradingOwnership(owner: TradingOwner): boolean {
  const key = sessionKey();
  const activeOwner = activeOwnerBySession.get(key) ?? null;
  if (activeOwner === null || activeOwner === owner) {
    activeOwnerBySession.set(key, owner);
    return true;
  }
  return false;
}

/** Give up trading ownership. Only the current owner can release it. */
export function releaseTradingOwnership(owner: TradingOwner): void {
  const key = sessionKey();
  if (activeOwnerBySession.get(key) === owner) activeOwnerBySession.delete(key);
}

/** Which engine currently owns trade execution, if any. */
export function currentTradingOwner(): TradingOwner | null {
  return activeOwnerBySession.get(sessionKey()) ?? null;
}

/** True when `owner` holds the execution lock right now. */
export function hasTradingOwnership(owner: TradingOwner): boolean {
  return activeOwnerBySession.get(sessionKey()) === owner;
}

/** Human-readable owner label for error messages and UI toasts. */
export function tradingOwnerLabel(owner: TradingOwner): string {
  if (owner === "autonomous") return "main autonomous engine";
  if (owner === "neuroai") return "NeuroAI FAB session";
  return "specialist AI bot";
}
