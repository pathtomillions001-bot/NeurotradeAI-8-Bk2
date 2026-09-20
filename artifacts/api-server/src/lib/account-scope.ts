/**
 * WHICH DERIV ACCOUNT A RUNNING BOT BELONGS TO.
 *
 * The Bot Arena is one browser session that may hold SEVERAL linked Deriv
 * accounts, and exactly one of them is active at a time (`accounts.is_active`).
 * Engines, though, read the active account once when a session STARTS and then
 * trade that account's token. So after a switch the two views disagree:
 *
 *   · the sidebar says "you are on CR777";
 *   · the running engine is still trading CR123.
 *
 * Before this module the live indicator read only `bot.running`, so a bot
 * started on one account was reported as the live bot of whatever account was
 * connected next — a running bot silently attributed to the wrong account, and
 * its P&L shown next to the wrong balance. The fix is to stamp the account on
 * the bot at the moment it starts and to compare that stamp with the account
 * the browser is looking at now.
 *
 * Three scopes, and each one exists for a reason:
 *
 *   "this-account"  — the bot's account is the account this browser is on.
 *   "other-account" — same browser, different account. The bot is real and
 *                     visible, but it is NOT this account's bot, so it must
 *                     never be rendered as "your live bot" (or with this
 *                     account's balance next to it).
 *   "unattributed"  — the engine reported no account (paper trading, or a start
 *                     that predates account linking). Treated as this browser's
 *                     own bot: there is no contradicting identity, and hiding a
 *                     running engine is the one failure this whole subsystem
 *                     exists to prevent.
 *
 * The stamp is read SYNC by `registerLiveBot` through a session-scoped note
 * (`noteBotAccount`), because engine `startSession` functions register their
 * status synchronously and cannot await a query. The note is written by the
 * start routes, which resolve the account before handing control to the engine.
 */

import { and, eq } from "drizzle-orm";
import { accountsTable, db } from "@workspace/db";
import { createSessionScoped, getBrowserSessionId } from "./session";

export type AccountScope = "this-account" | "other-account" | "unattributed";

/** Login ids are case-insensitive to Deriv; blank strings are "unknown". */
function normalizeLoginId(loginId: string | null | undefined): string | null {
  if (typeof loginId !== "string") return null;
  const trimmed = loginId.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

/**
 * Classify a running bot against the account the browser is looking at.
 *
 * A bot with NO stamped account is never classified as foreign: it has no
 * account to contradict, and mistaking a paper bot for another account's bot
 * would hide a running engine.
 */
export function botAccountScope(
  botAccount: string | null | undefined,
  activeAccount: string | null | undefined,
): AccountScope {
  const bot = normalizeLoginId(botAccount);
  if (!bot) return "unattributed";
  const active = normalizeLoginId(activeAccount);
  return active && active === bot ? "this-account" : "other-account";
}

/** True when the scope means "this browser's own bot" (never foreign). */
export function isOwnAccountScope(scope: AccountScope): boolean {
  return scope !== "other-account";
}

/**
 * The Deriv account this browser session is currently trading, or null when
 * nothing is connected. Mirrors the engines' own resolution: the active row
 * first, then the session's only row (legacy rows predate `is_active`).
 */
export async function activeAccountLoginId(sessionId: string): Promise<string | null> {
  try {
    let rows = await db.select({ loginId: accountsTable.loginId }).from(accountsTable).where(and(
      eq(accountsTable.sessionId, sessionId),
      eq(accountsTable.isActive, true),
    )).limit(1);
    if (rows.length === 0) {
      rows = await db.select({ loginId: accountsTable.loginId }).from(accountsTable)
        .where(eq(accountsTable.sessionId, sessionId)).limit(1);
    }
    return rows[0]?.loginId ?? null;
  } catch {
    // An unreadable account table must not take the whole arena down; the
    // callers treat null as "unknown", which is the fail-visible direction.
    return null;
  }
}

// ── The session-scoped note the SYNC registry reads ───────────────────────────

const note = createSessionScoped<{ loginId: string | null }>(() => ({ loginId: null }));

/** Record the account a bot is about to start on (see `stampActiveAccount`). */
export function noteBotAccount(loginId: string | null): void {
  note.state.loginId = loginId;
}

/** The account noted for the ambient session, or null if none was noted. */
export function notedBotAccount(): string | null {
  return note.state.loginId ?? null;
}

/**
 * Resolve the session's active account AND note it, in one call.
 *
 * Every bot `start` route calls this immediately before `startSession`, so the
 * registration the engine performs is stamped with the account it was
 * authorised against even if the user switches accounts a moment later.
 */
export async function stampActiveAccount(sessionId: string): Promise<string | null> {
  const loginId = await activeAccountLoginId(sessionId);
  // The note is session-scoped through the AMBIENT session, which the caller's
  // request context supplies; `sessionId` is used only for the read.
  noteBotAccount(loginId);
  return loginId;
}

/** The ambient session id, for diagnostics and tests. */
export function currentBotAccountSession(): string {
  return getBrowserSessionId();
}
