import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Saved DBot strategies compiled from scanner manifests (Create Bot flow).
 * The Bot Builder page lists/loads these; the XML is what gets injected into
 * the embedded Deriv DBot workspace.
 */
export const dbotStrategiesTable = pgTable(
  "dbot_strategies",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull().default("legacy"),
    name: text("name").notNull(),
    source: text("source").notNull().default("overunder-turbo"),
    symbol: text("symbol").notNull(),
    /** JSON-serialised DbotStrategyManifest (text keeps PGlite/pg parity). */
    manifest: text("manifest").notNull(),
    xml: text("xml").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("dbot_strategies_session_idx").on(t.sessionId, t.createdAt)],
);

export type DbotStrategy = typeof dbotStrategiesTable.$inferSelect;
