import { pgTable, serial, text, boolean, numeric, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accountsTable = pgTable("accounts", {
  id: serial("id").primaryKey(),
  // Opaque HttpOnly browser-session id. Credentials must never be global.
  sessionId: text("session_id").notNull().default("legacy"),
  loginId: text("login_id").notNull(),
  token: text("token"),
  bearerToken: text("bearer_token"),
  refreshToken: text("refresh_token"),
  derivAccountId: text("deriv_account_id"),
  currency: text("currency").notNull().default("USD"),
  balance: numeric("balance", { precision: 20, scale: 2 }).notNull().default("0"),
  isVirtual: boolean("is_virtual").notNull().default(false),
  // Active is scoped to session; each browser may select one linked sub-account.
  isActive: boolean("is_active").notNull().default(false),
  email: text("email"),
  fullName: text("full_name"),
  country: text("country"),
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("accounts_session_login_unique").on(t.sessionId, t.loginId),
  index("accounts_session_active_idx").on(t.sessionId, t.isActive),
]);

export const insertAccountSchema = createInsertSchema(accountsTable).omit({ id: true });
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
