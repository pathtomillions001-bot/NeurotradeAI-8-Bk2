/**
 * Deriv DBot registry — the server's view of every bot built in Bot Studio.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A Deriv DBot executes in the user's BROWSER: the platform hands the builder a
 * single-use OTP WebSocket URL for the account this app already has selected
 * (routes/dbot.ts) and the bot then trades on its own. The server never sees a
 * fill directly, which means it has to be told two things:
 *
 *   1. "a DBot is RUNNING for this account, right now" — so the execution
 *      arbiter can hold the account's single-executor lock (owner `dbot`) and no
 *      server engine starts next to it and double-trades the shared recovery
 *      ledger;
 *   2. "here is a heartbeat" — so the app can mirror the fills that appeared on
 *      the account since the last one, and so a closed browser tab (no more
 *      heartbeats) stops counting as a running bot.
 *
 * Liveness is therefore heartbeat-based, not connection-based. The Bot Studio
 * page posts `/api/dbots/:id/heartbeat` every few seconds while the builder says
 * the bot is running; once heartbeats stop for DBOT_HEARTBEAT_TTL_MS the bot is
 * treated as stopped and the account's execution lock is released.
 *
 * Scoping: records are keyed by BROWSER SESSION, exactly like every other piece
 * of account state in this app. A session can only ever read, list, stop or
 * mirror its own bots.
 */

import { acquireTradingOwnership, releaseTradingOwnership, currentTradingOwner } from "../engine-arbiter";
import { registerLiveBot, unregisterLiveBot, type LiveBotStatusShape } from "../live-registry";
import { runWithSessionId } from "../session";
import type { DbotStrategySpec } from "./strategy-xml";

/** No heartbeat for this long ⇒ the bot is not running any more. */
export const DBOT_HEARTBEAT_TTL_MS = 45_000;

export interface DbotFill {
  /** Deriv contract id — the idempotency key for mirroring. */
  contractId: string;
  transactionId?: string | null;
  contractType: string;
  symbol: string;
  stake: number;
  payout: number;
  profit: number;
  won: boolean;
  barrier: number | null;
  purchasedAt: string;
  closedAt: string | null;
  longcode: string | null;
}

export interface DbotRecord {
  id: string;
  sessionId: string;
  /** Account the bot was built for — it can never trade a different one. */
  accountId: string;
  isVirtual: boolean;
  name: string;
  symbol: string;
  displayName: string;
  contractTypes: string[];
  /** The compiled program (Blockly XML) and the spec it came from. */
  xml: string;
  spec: DbotStrategySpec;
  createdAt: number;
  /** Live bookkeeping (heartbeat based — see DBOT_HEARTBEAT_TTL_MS). */
  live: boolean;
  liveSince: number | null;
  lastSeenAt: number | null;
  lastMirroredAt: number | null;
  stoppedAt: number | null;
  /** Why it stopped: "user" | "account-switch" | "stale" | "killed". */
  stopReason: string | null;
  /** Mirrored fills (the app's view of what this bot did). */
  fills: DbotFill[];
  stopRequestedAt: number | null;
}

/** sessionId → (dbotId → record). One session never sees another's bots. */
const bySession = new Map<string, Map<string, DbotRecord>>();
/** sessionId → dbotId of the bot that currently holds the account's lock. */
const liveBySession = new Map<string, string>();

function sessionBots(sessionId: string): Map<string, DbotRecord> {
  let bots = bySession.get(sessionId);
  if (!bots) {
    bots = new Map();
    bySession.set(sessionId, bots);
  }
  return bots;
}

/** True while the bot is marked live AND still heartbeating. */
export function isDbotRunning(record: DbotRecord, now = Date.now()): boolean {
  if (!record.live) return false;
  if (record.lastSeenAt === null) return false;
  return now - record.lastSeenAt < DBOT_HEARTBEAT_TTL_MS;
}

/**
 * Reconcile a session's live bookkeeping with reality and return the running bot
 * (if any). Called on every read, so a closed tab is noticed everywhere at once:
 * the arbiter lock is released, the live-registry entry withdraws itself and the
 * record keeps its fills for the app's journal.
 */
export function reconcileLive(sessionId: string, now = Date.now()): DbotRecord | null {
  const liveId = liveBySession.get(sessionId);
  if (!liveId) return null;
  const record = sessionBots(sessionId).get(liveId);
  if (!record) {
    liveBySession.delete(sessionId);
    return null;
  }
  if (isDbotRunning(record, now)) return record;
  // Heartbeat lost — the browser tab is gone, was reloaded, or the bot was
  // stopped in the builder. Treat it as stopped (release the account).
  stopDbot(sessionId, record.id, "stale");
  return null;
}

/** The bot currently holding this session's execution lock, if any. */
export function runningDbot(sessionId: string): DbotRecord | null {
  return reconcileLive(sessionId);
}

export function getDbot(sessionId: string, id: string): DbotRecord | null {
  return sessionBots(sessionId).get(id) ?? null;
}

export function listDbots(sessionId: string): DbotRecord[] {
  return [...sessionBots(sessionId).values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function saveDbot(record: DbotRecord): DbotRecord {
  sessionBots(record.sessionId).set(record.id, record);
  return record;
}

export function deleteDbot(sessionId: string, id: string): boolean {
  const record = getDbot(sessionId, id);
  if (!record) return false;
  if (record.live) stopDbot(sessionId, id, "user");
  return sessionBots(sessionId).delete(id);
}

/**
 * Live status in the shape `GET /api/bots/live` and the layout's live indicator
 * understand. Registered through the cross-session live registry, so the badge
 * appears on every page of the app while the bot runs (and disappears the moment
 * the heartbeats stop).
 */
/**
 * The DBot's live status. Wider than the registry's minimal shape: the badge and
 * the DBot console read the extra fields (market, fills, which bot to stop), and
 * the API publishes this object verbatim through `GET /api/bots/live`.
 */
export interface DbotLiveStatus extends LiveBotStatusShape {
  /** The stored bot the status belongs to (what the badge stops/opens). */
  dbotId: string;
  symbol: string;
  currentMarket: string;
  currentContractType: string;
  tradeCount: number;
  totalProfit: number;
  message: string;
  inRecovery: boolean;
  recoveryStep: number;
  accountId: string;
  isVirtual: boolean;
  lastSeenAt: number | null;
  stopRequestedAt: number | null;
}

export function dbotLiveStatus(sessionId: string): DbotLiveStatus | null {
  const record = runningDbot(sessionId);
  if (!record) return null;
  const lastFill = record.fills[record.fills.length - 1] ?? null;
  return {
    running: true,
    botId: "dbot",
    botName: record.name,
    symbol: record.symbol,
    currentMarket: record.displayName,
    currentContractType: record.contractTypes.join("/"),
    tradeCount: record.fills.length,
    totalProfit: record.fills.reduce((sum, fill) => sum + fill.profit, 0),
    message: lastFill
      ? `Last: ${lastFill.won ? "win" : "loss"} ${lastFill.profit >= 0 ? "+" : ""}${lastFill.profit.toFixed(2)}`
      : "Deriv DBot running in Bot Studio",
    // The bot's own ladder state is mirrored into the record below.
    inRecovery: record.spec.recoveryState.debt > 0,
    recoveryStep: record.fills.filter((fill) => !fill.won).length,
    dbotId: record.id,
    accountId: record.accountId,
    isVirtual: record.isVirtual,
    lastSeenAt: record.lastSeenAt,
    stopRequestedAt: record.stopRequestedAt,
  };
}

export type MarkLiveResult =
  | { ok: true; record: DbotRecord; stoppedOthers: false }
  | { ok: false; reason: "not-found" | "account-locked"; owner: string | null; record: DbotRecord | null };

/**
 * Take the account's single-executor lock for a DBot without talking to Deriv.
 *
 * Used by the API route (a real run in Bot Studio) and by the mirror when it
 * confirms fills on the account even though no heartbeat arrived yet.
 */
export function markLive(sessionId: string, id: string, now = Date.now()): MarkLiveResult {
  const record = getDbot(sessionId, id);
  if (!record) return { ok: false, reason: "not-found", owner: currentTradingOwner(sessionId), record: null };

  const previousLiveId = liveBySession.get(sessionId);
  if (previousLiveId && previousLiveId !== id) {
    // Only one DBot per account: the previous one gives up the lock first.
    stopDbot(sessionId, previousLiveId, "killed");
  }

  if (!acquireTradingOwnership("dbot", sessionId)) {
    return { ok: false, reason: "account-locked", owner: currentTradingOwner(sessionId), record };
  }

  record.live = true;
  record.liveSince = record.liveSince ?? now;
  record.lastSeenAt = now;
  record.stoppedAt = null;
  record.stopReason = null;
  record.stopRequestedAt = null;
  liveBySession.set(sessionId, id);

  // Publish to the cross-session live registry from THIS session's context, so
  // every page in the app can show "Deriv DBot is trading" immediately.
  runWithSessionId(sessionId, () => {
    registerLiveBot("dbot", () => dbotLiveStatus(sessionId));
  });

  return { ok: true, record, stoppedOthers: false };
}

export function heartbeatDbot(sessionId: string, id: string, now = Date.now()): DbotRecord | null {
  const record = getDbot(sessionId, id);
  if (!record || !record.live) return null;
  record.lastSeenAt = now;
  return record;
}

/**
 * Stop a DBot: release the account's execution lock, withdraw the live badge and
 * leave the fills in place (they are history, and the app's journal keeps them).
 *
 * The bot itself runs in the browser; when Bot Studio is open it sees
 * `stopRequestedAt` on its next heartbeat and stops the builder. When it is not
 * reachable the mirror simply stops, which is the strongest thing a server can
 * do about a program in someone else's tab.
 */
export function stopDbot(sessionId: string, id: string, reason: string, now = Date.now()): DbotRecord | null {
  const record = getDbot(sessionId, id);
  if (!record) return null;
  record.live = false;
  record.stoppedAt = now;
  record.stopReason = reason;
  record.stopRequestedAt = now;
  if (liveBySession.get(sessionId) === id) liveBySession.delete(sessionId);
  // Release only if WE hold it — another engine may have taken over meanwhile.
  runWithSessionId(sessionId, () => {
    releaseTradingOwnership("dbot", sessionId);
    unregisterLiveBot("dbot");
  });
  return record;
}

/** Records a mirrored fill on the bot (idempotent by contract id). */
export function appendFill(record: DbotRecord, fill: DbotFill, now = Date.now()): boolean {
  if (record.fills.some((existing) => existing.contractId === fill.contractId)) return false;
  record.fills.push(fill);
  record.lastMirroredAt = now;
  return true;
}

/** Test-only: drop every registration (and the locks they hold). */
export function __resetDbotsForTests(): void {
  for (const sessionId of [...bySession.keys()]) {
    for (const id of [...sessionBots(sessionId).keys()]) stopDbot(sessionId, id, "killed");
  }
  bySession.clear();
  liveBySession.clear();
}

/** Bots whose stop was requested and that Bot Studio has not acknowledged yet. */
export function pendingStopRequests(sessionId: string): DbotRecord[] {
  return listDbots(sessionId).filter((record) => record.live && record.stopRequestedAt !== null);
}
