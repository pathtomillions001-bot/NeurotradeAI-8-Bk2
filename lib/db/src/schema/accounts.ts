import { pgTable, serial, text, boolean, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accountsTable = pgTable("accounts", {
  id: serial("id").primaryKey(),
  loginId: text("login_id").notNull().unique(),
  // Legacy PAT token (kept for bulk-purchase fallback; null after OAuth login)
  token: text("token"),
  // OAuth2 Bearer access token (used for REST + OTP endpoint)
  // All sub-accounts from one OAuth login share the same bearer/refresh token
  bearerToken: text("bearer_token"),
  // OAuth2 refresh token (used to renew the Bearer token)
  refreshToken: text("refresh_token"),
  // Deriv trading account ID from GET /trading/v1/options/accounts (e.g. "CR123456")
  derivAccountId: text("deriv_account_id"),
  currency: text("currency").notNull().default("USD"),
  balance: numeric("balance", { precision: 20, scale: 2 }).notNull().default("0"),
  isVirtual: boolean("is_virtual").notNull().default(false),
  // True for the account currently selected for live trading.
  // Exactly one row should have isActive=true at any time.
  isActive: boolean("is_active").notNull().default(false),
  email: text("email"),
  fullName: text("full_name"),
  country: text("country"),
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAccountSchema = createInsertSchema(accountsTable).omit({ id: true });
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
