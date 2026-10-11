import { pgTable, serial, bigint, boolean, doublePrecision, integer, text, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

/**
 * WP9 — the Desk's durable learning and governance record.
 *
 * Five tables, and each one exists because something the desk claims is only
 * true if it survives a restart:
 *
 *   desk_shadow_evaluations — every decision the v4 pipeline made, armed or
 *     refused, with the probabilities and the machine-readable codes behind it.
 *     This is what makes "the desk's out-of-sample record" a fact rather than a
 *     promise: the record is the desk's OWN would-be decisions, taken in shadow,
 *     and it is the corpus every later study and the weekly report read.
 *
 *   desk_trades — every closed position with the R it realised, the risk it was
 *     stamped with at fill, and the slippage the fill carried. This is the only
 *     honest source for a live edge estimate: the EA's `initialRiskMoney` is the
 *     denominator, so a trade whose risk the desk never recorded carries a NULL
 *     R rather than a fabricated one.
 *
 *   desk_journal — the human-readable log, made durable. The in-process journal
 *     is capped at 200 entries and dies on every deploy; "why did the desk not
 *     take that trade last Tuesday" has to be answerable after a restart.
 *
 *   desk_calibrators — fitted artifacts (the WP5 calibrator, the WP3 HMM
 *     parameters) stored with a version, a scope and the sample count they were
 *     fitted on. A model the desk cannot identify later is a model it cannot
 *     audit, so the version and the fit inputs are part of the row.
 *
 *   desk_governance_state — the per-agent e-process and Page–Hinkley state.
 *     These are cumulative statistics: if they reset on restart, then every
 *     deploy gives an agent that was already on its way out a clean slate,
 *     which is precisely the failure mode the layer exists to prevent.
 *
 * Timestamps are epoch milliseconds (BIGINT), not TIMESTAMPTZ, for the same
 * reason the bridge tables use them: the application clock is the one the
 * decision was taken on, and comparing it against a database server's clock
 * across two nodes is how "the journal says one thing and the ledger another"
 * starts.
 */

export const deskShadowEvaluationsTable = pgTable(
  "desk_shadow_evaluations",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    evaluatedAtMs: bigint("evaluated_at_ms", { mode: "number" }).notNull(),
    symbol: text("symbol").notNull(),
    mode: text("mode").notNull(),
    /** True when the pipeline WOULD have armed; false when it refused. */
    armed: boolean("armed").notNull(),
    planId: text("plan_id"),
    direction: text("direction"),
    probability: doublePrecision("probability"),
    probabilityLowerBound: doublePrecision("probability_lower_bound"),
    breakEvenProbability: doublePrecision("break_even_probability"),
    expectancyR: doublePrecision("expectancy_r"),
    costR: doublePrecision("cost_r"),
    /** Alpha agents that proposed, JSON array of ids. */
    agentsJson: text("agents_json").notNull().default("[]"),
    /** Every refusal, in evaluation order (human sentences). */
    refusalsJson: text("refusals_json").notNull().default("[]"),
    /** Machine-readable gate codes (`GK_*`, `EXEC_*`, `PF_*`, `GOV*`). */
    gateCodesJson: text("gate_codes_json").notNull().default("[]"),
    /** The realised R of the plan's trade, filled in when it closes. */
    outcomeR: doublePrecision("outcome_r"),
    resolvedAtMs: bigint("resolved_at_ms", { mode: "number" }),
    payloadJson: text("payload_json"),
  },
  (t) => [
    index("desk_shadow_session_idx").on(t.sessionId, t.evaluatedAtMs),
    index("desk_shadow_symbol_idx").on(t.sessionId, t.symbol, t.mode),
  ],
);

export const deskTradesTable = pgTable(
  "desk_trades",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    ticket: bigint("ticket", { mode: "number" }).notNull(),
    planId: text("plan_id"),
    symbol: text("symbol").notNull(),
    mode: text("mode").notNull(),
    side: text("side").notNull(),
    openedAtMs: bigint("opened_at_ms", { mode: "number" }).notNull(),
    closedAtMs: bigint("closed_at_ms", { mode: "number" }).notNull(),
    lots: doublePrecision("lots").notNull(),
    /** The risk the EA stamped at fill; NULL means the desk cannot measure R. */
    riskMoney: doublePrecision("risk_money"),
    netProfit: doublePrecision("net_profit").notNull(),
    realisedR: doublePrecision("realised_r"),
    /** The probability the desk had when it armed the trade (null if unknown). */
    predictedProbability: doublePrecision("predicted_probability"),
    slippageR: doublePrecision("slippage_r"),
    entryPrice: doublePrecision("entry_price"),
    exitPrice: doublePrecision("exit_price"),
    exitReason: text("exit_reason"),
    agentsJson: text("agents_json").notNull().default("[]"),
    payloadJson: text("payload_json"),
  },
  (t) => [
    index("desk_trades_session_idx").on(t.sessionId, t.closedAtMs),
    index("desk_trades_symbol_idx").on(t.sessionId, t.symbol, t.mode),
  ],
);

export const deskJournalTable = pgTable(
  "desk_journal",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    entryId: text("entry_id").notNull(),
    tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    symbol: text("symbol"),
    message: text("message").notNull(),
    detailJson: text("detail_json"),
  },
  (t) => [
    index("desk_journal_session_idx").on(t.sessionId, t.tsMs),
    uniqueIndex("desk_journal_entry_idx").on(t.sessionId, t.entryId),
  ],
);

export const deskCalibratorsTable = pgTable(
  "desk_calibrators",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    /** Scope key: `symbol|mode`, or `*` for an unscoped artifact. */
    refKey: text("ref_key").notNull().default("*"),
    version: text("version").notNull(),
    mode: text("mode"),
    symbol: text("symbol"),
    samples: integer("samples").notNull().default(0),
    payloadJson: text("payload_json").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("desk_calibrators_version_idx").on(t.kind, t.refKey, t.version),
    index("desk_calibrators_kind_idx").on(t.kind, t.refKey, t.createdAtMs),
  ],
);

export const deskGovernanceStateTable = pgTable(
  "desk_governance_state",
  {
    sessionId: text("session_id").notNull(),
    agentId: text("agent_id").notNull(),
    status: text("status").notNull(),
    eValue: doublePrecision("e_value").notNull().default(1),
    outcomes: integer("outcomes").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    totalR: doublePrecision("total_r").notNull().default(0),
    phValue: doublePrecision("ph_value").notNull().default(0),
    phAlarms: integer("ph_alarms").notNull().default(0),
    phMean: doublePrecision("ph_mean").notNull().default(0),
    phCumulative: doublePrecision("ph_cumulative").notNull().default(0),
    phMax: doublePrecision("ph_max").notNull().default(0),
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
    reason: text("reason"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.agentId] })],
);

export type DeskShadowEvaluation = typeof deskShadowEvaluationsTable.$inferSelect;
export type DeskTrade = typeof deskTradesTable.$inferSelect;
export type DeskJournalRow = typeof deskJournalTable.$inferSelect;
export type DeskCalibrator = typeof deskCalibratorsTable.$inferSelect;
export type DeskGovernanceState = typeof deskGovernanceStateTable.$inferSelect;
