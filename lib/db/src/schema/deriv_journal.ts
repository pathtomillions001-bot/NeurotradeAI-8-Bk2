import { pgTable, serial, text, integer, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Durable Deriv profit-table (journal) cache.
 *
 * The trading journal used to exist only as an in-memory array inside the
 * server process. A restart, a redeploy, or a Deriv rate limit during
 * re-pagination emptied it and the user saw "no trades" for minutes even though
 * the trades were safely on Deriv's side. Every transaction Deriv returns is now
 * written through to this table and the journal endpoint serves from it
 * immediately, then reconciles with Deriv in the background.
 */
export const derivJournalTable = pgTable("deriv_journal", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  accountId: text("account_id").notNull(),
  transactionId: text("transaction_id").notNull(),
  contractId: text("contract_id"),
  symbol: text("symbol"),
  contractType: text("contract_type"),
  buyPrice: numeric("buy_price", { precision: 20, scale: 4 }),
  sellPrice: numeric("sell_price", { precision: 20, scale: 4 }),
  purchaseTime: integer("purchase_time"),
  sellTime: integer("sell_time"),
  /** Full transaction payload as returned by Deriv, so responses stay identical. */
  payloadJson: text("payload_json").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("deriv_journal_unique").on(t.sessionId, t.accountId, t.transactionId),
  index("deriv_journal_session_idx").on(t.sessionId, t.purchaseTime),
]);

export type DerivJournalRow = typeof derivJournalTable.$inferSelect;
