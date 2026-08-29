import { pgTable, serial, text, integer, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const marketWinRatesTable = pgTable("market_win_rates", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  contractType: text("contract_type").notNull(),
  barrier: integer("barrier"),
  winRate: numeric("win_rate", { precision: 8, scale: 6 }).notNull().default("0.550000"),
  tradeCount: integer("trade_count").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("market_win_rates_key").on(t.symbol, t.contractType, t.barrier),
]);

export type MarketWinRate = typeof marketWinRatesTable.$inferSelect;
