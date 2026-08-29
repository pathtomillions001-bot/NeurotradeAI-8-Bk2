import { pgTable, serial, text, boolean, integer, numeric, timestamp } from "drizzle-orm/pg-core";

/**
 * Trade Intelligence Reports
 * Generated after every completed trade — explains WHY the trade won or lost,
 * what could have been done better, and feeds the adaptive-confidence engine.
 */
export const tradeIntelligenceReportsTable = pgTable("trade_intelligence_reports", {
  id:           serial("id").primaryKey(),
  tradeId:      integer("trade_id").notNull(),
  symbol:       text("symbol").notNull(),
  contractType: text("contract_type").notNull(),
  barrier:      integer("barrier"),
  stake:        numeric("stake",  { precision: 20, scale: 2 }).notNull(),
  won:          boolean("won").notNull(),
  profit:       numeric("profit", { precision: 20, scale: 2 }).notNull(),

  // Market conditions captured at trade entry
  regime:              text("regime"),
  volatility:          numeric("volatility",  { precision: 10, scale: 6 }),
  momentum:            numeric("momentum",    { precision: 10, scale: 6 }),
  tickAcceleration:    numeric("tick_acceleration", { precision: 10, scale: 6 }),
  noiseScore:          numeric("noise_score", { precision: 5, scale: 2 }),
  confidenceAtEntry:   numeric("confidence_at_entry", { precision: 5, scale: 2 }),
  evAtEntry:           numeric("ev_at_entry",          { precision: 10, scale: 6 }),
  qualityScore:        numeric("quality_score",        { precision: 5, scale: 2 }),
  winProbAtEntry:      numeric("win_prob_at_entry",    { precision: 5, scale: 2 }),
  agentScoresJson:     text("agent_scores_json").default("{}"),

  // Post-trade analysis
  whyWon:               text("why_won"),
  whyLost:              text("why_lost"),
  couldHaveAvoided:     boolean("could_have_avoided").default(false),
  avoidanceReason:      text("avoidance_reason"),
  confidenceAssessment: text("confidence_assessment"),   // 'too_high'|'appropriate'|'too_low'
  betterContractType:   text("better_contract_type"),
  betterBarrier:        integer("better_barrier"),
  timingAssessment:     text("timing_assessment"),        // 'too_early'|'optimal'|'too_late'
  agentAgreementScore:  numeric("agent_agreement_score", { precision: 5, scale: 2 }),
  dissidentAgentsJson:  text("dissident_agents_json").default("[]"),
  
  // Structured findings (serialised array of insight strings)
  findingsJson:         text("findings_json").default("[]"),

  // Temporal features
  hourOfDay:   integer("hour_of_day"),
  minuteOfHour: integer("minute_of_hour"),
  dayOfWeek:   integer("day_of_week"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TradeIntelligenceReport = typeof tradeIntelligenceReportsTable.$inferSelect;

/**
 * Missed Opportunities
 * Recorded when the AI rejects a trade. After the would-be contract duration
 * the agent evaluates whether the trade would have won and whether the rejection
 * was justified — fuelling the adaptive-threshold calibration.
 */
export const missedOpportunitiesTable = pgTable("missed_opportunities", {
  id:           serial("id").primaryKey(),
  symbol:       text("symbol").notNull(),
  contractType: text("contract_type").notNull(),
  barrier:      integer("barrier"),
  stake:        numeric("stake", { precision: 20, scale: 2 }),

  // Why rejected
  rejectReason:          text("reject_reason"),
  blockingFiltersJson:   text("blocking_filters_json").default("[]"),
  confidenceAtRejection: numeric("confidence_at_rejection", { precision: 5, scale: 2 }),
  evAtRejection:         numeric("ev_at_rejection",         { precision: 10, scale: 6 }),
  qualityScore:          numeric("quality_score",           { precision: 5, scale: 2 }),
  regime:                text("regime"),
  hourOfDay:             integer("hour_of_day"),

  // Would-have-been outcome (filled in after duration elapses)
  wouldHaveWon:        boolean("would_have_won"),
  estimatedProfit:     numeric("estimated_profit", { precision: 20, scale: 2 }),
  wasRejectionCorrect: boolean("was_rejection_correct"),
  filterTooStrict:     boolean("filter_too_strict"),

  createdAt:   timestamp("created_at").notNull().defaultNow(),
  evaluatedAt: timestamp("evaluated_at"),
});

export type MissedOpportunity = typeof missedOpportunitiesTable.$inferSelect;

/**
 * Adaptive Thresholds
 * Single-row table (updated in-place) storing the current learned threshold
 * and per-agent accuracy weights used by the Dynamic Confidence Engine.
 */
export const adaptiveThresholdsTable = pgTable("adaptive_thresholds", {
  id:                  serial("id").primaryKey(),
  confidenceThreshold: numeric("confidence_threshold", { precision: 5, scale: 2 }).default("38"),
  evThreshold:         numeric("ev_threshold",         { precision: 10, scale: 6 }).default("-0.05"),
  timingThreshold:     numeric("timing_threshold",     { precision: 5, scale: 2 }).default("38"),
  agentWeightsJson:    text("agent_weights_json").default("{}"),
  agentAccuracyJson:   text("agent_accuracy_json").default("{}"),
  recentWinRate:       numeric("recent_win_rate",      { precision: 5, scale: 4 }),
  tradesAnalyzed:      integer("trades_analyzed").default(0),
  updatedAt:           timestamp("updated_at").notNull().defaultNow(),
});

export type AdaptiveThresholds = typeof adaptiveThresholdsTable.$inferSelect;
