import { pgTable, serial, text, boolean, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  displayName: text("display_name").notNull(),
  contractType: text("contract_type").notNull(),
  barrier: integer("barrier"),
  stake: numeric("stake", { precision: 20, scale: 2 }).notNull(),
  direction: text("direction").notNull(),
  status: text("status").notNull().default("open"),
  payout: numeric("payout", { precision: 20, scale: 2 }),
  profit: numeric("profit", { precision: 20, scale: 2 }),
  entryPrice: numeric("entry_price", { precision: 20, scale: 6 }),
  exitPrice: numeric("exit_price", { precision: 20, scale: 6 }),
  aiConfidence: numeric("ai_confidence", { precision: 5, scale: 2 }),
  aiRiskScore: numeric("ai_risk_score", { precision: 5, scale: 2 }),
  isAutonomous: boolean("is_autonomous").notNull().default(false),
  agentReasoning: text("agent_reasoning"),
  duration: integer("duration"),
  durationUnit: text("duration_unit").default("t"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
