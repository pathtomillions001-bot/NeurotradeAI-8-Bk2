import { pgTable, serial, text, boolean, numeric, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().default("legacy"),
  riskProfile: text("risk_profile").notNull().default("moderate"),
  maxRiskPerTrade: numeric("max_risk_per_trade", { precision: 5, scale: 2 }).notNull().default("0.50"),
  dailyTarget: numeric("daily_target", { precision: 20, scale: 2 }).notNull().default("5000"),
  dailyLossLimit: numeric("daily_loss_limit", { precision: 20, scale: 2 }).notNull().default("2999"),
  maxDrawdown: numeric("max_drawdown", { precision: 5, scale: 2 }).notNull().default("10"),
  consecutiveLossLimit: integer("consecutive_loss_limit").notNull().default(4),
  minConfidenceThreshold: numeric("min_confidence_threshold", { precision: 5, scale: 2 }).notNull().default("50"),
  marketRotationAfter: integer("market_rotation_after").notNull().default(5),
  preferredContractTypes: text("preferred_contract_types").notNull().default("DIGITOVER,DIGITUNDER"),
  preferredCategories: text("preferred_categories").notNull().default("synthetic,forex"),
  allowedMarkets: text("allowed_markets").default(""),
  autonomousEnabled: boolean("autonomous_enabled").notNull().default(false),
  loopIntervalSec: integer("loop_interval_sec").notNull().default(1),
  recoveryMode: boolean("recovery_mode").notNull().default(true),
  // Wide precision: Manual recovery mode must not impose a hidden multiplier ceiling.
  recoveryMultiplier: numeric("recovery_multiplier", { precision: 20, scale: 4 }).notNull().default("1.62"),
  maxRecoverySteps: integer("max_recovery_steps").notNull().default(3),
  scanAllMarkets: boolean("scan_all_markets").notNull().default(true),
  tradeDurationSec: integer("trade_duration_sec").notNull().default(5),
  maxTradeStake: numeric("max_trade_stake", { precision: 20, scale: 2 }).notNull().default("500"),
  paperTradeMode: boolean("paper_trade_mode").notNull().default(false),
  requirePositiveEv: boolean("require_positive_ev").notNull().default(true),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(1),
  normalOverDigit: integer("normal_over_digit").notNull().default(1),
  normalUnderDigit: integer("normal_under_digit").notNull().default(8),
  recoveryOverDigit: integer("recovery_over_digit").notNull().default(3),
  recoveryUnderDigit: integer("recovery_under_digit").notNull().default(6),
  recoveryMethod: text("recovery_method").notNull().default("split"),
  recoveryAutoMode: boolean("recovery_auto_mode").notNull().default(true),
  recoveryStateJson: text("recovery_state_json"),
  riskAmountType: text("risk_amount_type").notNull().default("fixed"),
  riskAmountValue: numeric("risk_amount_value", { precision: 20, scale: 2 }).notNull().default("1.00"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("settings_session_unique").on(t.sessionId),
]);

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({ id: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;
