import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiInsightsTable = pgTable("ai_insights", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  priority: text("priority").notNull().default("medium"),
  actionable: boolean("actionable").notNull().default(true),
  relatedMarket: text("related_market"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAiInsightSchema = createInsertSchema(aiInsightsTable).omit({ id: true });
export type InsertAiInsight = z.infer<typeof insertAiInsightSchema>;
export type AiInsight = typeof aiInsightsTable.$inferSelect;
