import { pgTable, text, jsonb, bigint } from "drizzle-orm/pg-core";

/**
 * Durable, revocable credentials; never store plaintext pairing codes/tokens.
 * The embedded database bootstrap keeps this column shape current with
 * additive ALTERs so a partial prior migration is repaired without deleting
 * existing token hashes, terminal settings or account claims.
 */
export const mt5BridgeLinksTable = pgTable("mt5_bridge_links", {
  sessionId: text("session_id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  tokenHash: text("token_hash").unique(),
  terminal: jsonb("terminal"),
  settings: jsonb("settings").notNull().default({}),
  codeAccountKey: text("code_account_key"),
  connectorId: text("connector_id"),
  connectorSeenMs: bigint("connector_seen_ms", { mode: "number" })
    .notNull()
    .default(0),
});
