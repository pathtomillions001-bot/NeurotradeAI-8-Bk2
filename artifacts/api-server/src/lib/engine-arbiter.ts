/**
 * Trading Execution Arbiter
 *
 * ONE account = ONE recovery ledger = ONE executing engine at a time.
 *
 * Root cause of the "normal/recovery mix-up" incident: the main autonomous
 * engine (`runAutonomousLoop` in routes/ai.ts) and the NeuroAI FAB engine
 * (`runLoop` in lib/speed-ai-engine.ts) could trade the same Deriv account
 * simultaneously while each tracked its own private recovery state. Every win
 * or loss was only visible to the engine that placed it, so the merged account
 * journal looked schizophrenic: normal trades appeared while one engine was in
 * recovery (they belonged to the other engine), and a fully-covering recovery
 * win did not stop the other engine's recovery trades (its debt was still open).
 *
 * Recovery debt is account-level: there is exactly one shared recovery ledger
 * (`lib/agents/recovery-engine.ts`), and this module enforces that exactly one
 * engine may execute against it at any moment. Ownership only blocks TRADE
 * EXECUTION — status endpoints, scanning, and analysis always work.
 *
 * Three executors share this lock: the main autonomous engine (`autonomous`),
 * the NeuroAI Quantum FAB (`neuroai`) and the specialist AI bots (`bots` — one
 * bot session at a time, see `lib/bot-engine.ts`). All three read and write the
 * same ledger, so a fourth concurrent executor would recreate exactly the
 * mix-up described above.
 */

export type TradingOwner = "autonomous" | "neuroai" | "bots";

let activeOwner: TradingOwner | null = null;

/**
 * Take trading ownership for `owner`. Idempotent for the current owner.
 * Returns false when the other engine already owns execution.
 */
export function acquireTradingOwnership(owner: TradingOwner): boolean {
  if (activeOwner === null || activeOwner === owner) {
    activeOwner = owner;
    return true;
  }
  return false;
}

/** Give up trading ownership. Only the current owner can release it. */
export function releaseTradingOwnership(owner: TradingOwner): void {
  if (activeOwner === owner) activeOwner = null;
}

/** Which engine currently owns trade execution, if any. */
export function currentTradingOwner(): TradingOwner | null {
  return activeOwner;
}

/** True when `owner` holds the execution lock right now. */
export function hasTradingOwnership(owner: TradingOwner): boolean {
  return activeOwner === owner;
}

/** Human-readable owner label for error messages and UI toasts. */
export function tradingOwnerLabel(owner: TradingOwner): string {
  if (owner === "autonomous") return "main autonomous engine";
  if (owner === "neuroai") return "NeuroAI FAB session";
  return "specialist AI bot";
}
