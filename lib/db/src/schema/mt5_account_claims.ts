import { pgTable, serial, bigint, text, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One row per connected MT5 account — the global uniqueness registry.
 *
 * WHY THIS EXISTS: the Desk's live state is held per browser session, so
 * nothing stopped the same broker account being paired twice from two different
 * browsers (or two devices). Both sessions would then stream the same account,
 * both would arm plans against it, and each would close or flatten positions
 * the other believed it owned — the Desk's risk limits would be counted twice
 * against one balance.
 *
 * The unique index on `account_key` is the actual guarantee: two concurrent
 * pairings race on the insert and exactly one wins.
 *
 * Timestamps are epoch milliseconds (BIGINT), not TIMESTAMPTZ, so the
 * heartbeat diagnostics are comparable across processes. Ownership is only
 * released by explicit unlink or an intentional account replacement.
 */
export const mt5AccountClaimsTable = pgTable("mt5_account_claims", {
  id: serial("id").primaryKey(),
  /** Normalised `login@SERVER` — the identity being protected. */
  accountKey: text("account_key").notNull(),
  login: bigint("login", { mode: "number" }).notNull(),
  server: text("server").notNull(),
  company: text("company"),
  /** Browser session that currently owns this account. */
  sessionId: text("session_id").notNull(),
  pairedAtMs: bigint("paired_at_ms", { mode: "number" }).notNull(),
  /** Refreshed on every EA heartbeat; ownership does not expire when this stops. */
  lastSeenAtMs: bigint("last_seen_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("mt5_account_claims_key").on(t.accountKey),
  index("mt5_account_claims_session_idx").on(t.sessionId),
]);

export type Mt5AccountClaim = typeof mt5AccountClaimsTable.$inferSelect;
