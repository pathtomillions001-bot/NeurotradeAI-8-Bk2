import { pgTable, serial, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Durable session links.
 *
 * A browser identity (`kind: "client"`, mirrored in a 1-year HttpOnly cookie
 * and in localStorage) and each tab identity (`kind: "tab"`) are bound here to
 * the account-scoped session that owns the connected Deriv account.
 *
 * WHY: the per-tab identity deliberately overrides the session cookie so two
 * tabs can hold two different Deriv accounts. That made every NEW tab (and any
 * tab whose `sessionStorage` was evicted — closing the tab, a browser restart,
 * mobile memory pressure) resolve to a brand-new anonymous session: the account
 * was still connected server-side, but the visitor was shown the "Connect your
 * Deriv account" screen. The link table is what makes a connection persist
 * until the user explicitly disconnects.
 */
export const sessionLinksTable = pgTable("session_links", {
  id: serial("id").primaryKey(),
  /** 'client' (durable browser) | 'cookie' | 'tab' */
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  sessionId: text("session_id").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("session_links_kind_key").on(t.kind, t.key),
  index("session_links_session_idx").on(t.sessionId),
]);

export type SessionLink = typeof sessionLinksTable.$inferSelect;
