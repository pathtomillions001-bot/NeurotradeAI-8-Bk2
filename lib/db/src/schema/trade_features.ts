import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";

export const tradeFeaturesTable = pgTable("trade_features", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull(),
  symbol: text("symbol").notNull(),
  contractType: text("contract_type").notNull(),
  barrier: integer("barrier"),
  tickWindow: integer("tick_window"),
  duration: integer("duration"),
  featuresJson: text("features_json").notNull().default("{}"),
  rfProb: numeric("rf_prob", { precision: 8, scale: 6 }),
  gbProb: numeric("gb_prob", { precision: 8, scale: 6 }),
  lrProb: numeric("lr_prob", { precision: 8, scale: 6 }),
  rawConfidence: numeric("raw_confidence", { precision: 5, scale: 2 }),
  calibratedConfidence: numeric("calibrated_confidence", { precision: 5, scale: 2 }),
  expectedValue: numeric("expected_value", { precision: 20, scale: 4 }),
  payoutMultiplier: numeric("payout_multiplier", { precision: 8, scale: 4 }),
  breakevenWinRate: numeric("breakeven_win_rate", { precision: 8, scale: 6 }),
  isPaperTrade: integer("is_paper_trade").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TradeFeature = typeof tradeFeaturesTable.$inferSelect;
