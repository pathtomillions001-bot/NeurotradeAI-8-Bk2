import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const { Pool } = pg;

const INIT_DDL = `
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy',
  login_id TEXT NOT NULL,
  token TEXT,
  bearer_token TEXT,
  refresh_token TEXT,
  deriv_account_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  balance NUMERIC(20, 2) NOT NULL DEFAULT '0',
  is_virtual BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  email TEXT,
  full_name TEXT,
  country TEXT,
  connected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_login_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_session_login_unique ON accounts (session_id, login_id);
CREATE INDEX IF NOT EXISTS accounts_session_active_idx ON accounts (session_id, is_active);

CREATE TABLE IF NOT EXISTS ai_insights (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  actionable BOOLEAN NOT NULL DEFAULT TRUE,
  related_market TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_win_rates (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  barrier INTEGER,
  win_rate NUMERIC(8, 6) NOT NULL DEFAULT '0.550000',
  trade_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS market_win_rates_key ON market_win_rates (symbol, contract_type, barrier);

CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy',
  risk_profile TEXT NOT NULL DEFAULT 'moderate',
  max_risk_per_trade NUMERIC(5, 2) NOT NULL DEFAULT '0.50',
  daily_target NUMERIC(20, 2) NOT NULL DEFAULT '5000',
  daily_loss_limit NUMERIC(20, 2) NOT NULL DEFAULT '2999',
  max_drawdown NUMERIC(5, 2) NOT NULL DEFAULT '10',
  consecutive_loss_limit INTEGER NOT NULL DEFAULT 4,
  min_confidence_threshold NUMERIC(5, 2) NOT NULL DEFAULT '50',
  market_rotation_after INTEGER NOT NULL DEFAULT 5,
  preferred_contract_types TEXT NOT NULL DEFAULT 'DIGITOVER,DIGITUNDER',
  preferred_categories TEXT NOT NULL DEFAULT 'synthetic,forex',
  allowed_markets TEXT DEFAULT '',
  autonomous_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  loop_interval_sec INTEGER NOT NULL DEFAULT 1,
  recovery_mode BOOLEAN NOT NULL DEFAULT TRUE,
  recovery_multiplier NUMERIC(20, 4) NOT NULL DEFAULT '1.62',
  max_recovery_steps INTEGER NOT NULL DEFAULT 3,
  scan_all_markets BOOLEAN NOT NULL DEFAULT TRUE,
  trade_duration_sec INTEGER NOT NULL DEFAULT 5,
  max_trade_stake NUMERIC(20, 2) NOT NULL DEFAULT '500',
  paper_trade_mode BOOLEAN NOT NULL DEFAULT FALSE,
  require_positive_ev BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_minutes INTEGER NOT NULL DEFAULT 1,
  normal_over_digit INTEGER NOT NULL DEFAULT 1,
  normal_under_digit INTEGER NOT NULL DEFAULT 8,
  recovery_over_digit INTEGER NOT NULL DEFAULT 3,
  recovery_under_digit INTEGER NOT NULL DEFAULT 6,
  recovery_method TEXT NOT NULL DEFAULT 'split',
  recovery_auto_mode BOOLEAN NOT NULL DEFAULT TRUE,
  recovery_state_json TEXT,
  risk_amount_type TEXT NOT NULL DEFAULT 'fixed',
  risk_amount_value NUMERIC(20, 2) NOT NULL DEFAULT '1.00',
  bot_recovery_markup NUMERIC(5, 2) NOT NULL DEFAULT '10',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE settings ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS bot_recovery_markup NUMERIC(5, 2) NOT NULL DEFAULT '10';
-- Legacy global rows remain inaccessible and get distinct owners so older
-- deployments with multiple settings rows can migrate safely.
UPDATE settings SET session_id = 'legacy-' || id::text WHERE session_id = 'legacy';
CREATE UNIQUE INDEX IF NOT EXISTS settings_session_unique ON settings (session_id);

CREATE TABLE IF NOT EXISTS trade_features (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  barrier INTEGER,
  tick_window INTEGER,
  duration INTEGER,
  features_json TEXT NOT NULL DEFAULT '{}',
  rf_prob NUMERIC(8, 6),
  gb_prob NUMERIC(8, 6),
  lr_prob NUMERIC(8, 6),
  raw_confidence NUMERIC(5, 2),
  calibrated_confidence NUMERIC(5, 2),
  expected_value NUMERIC(20, 4),
  payout_multiplier NUMERIC(8, 4),
  breakeven_win_rate NUMERIC(8, 6),
  is_paper_trade INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trade_intelligence_reports (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  barrier INTEGER,
  stake NUMERIC(20, 2) NOT NULL,
  won BOOLEAN NOT NULL,
  profit NUMERIC(20, 2) NOT NULL,
  regime TEXT,
  volatility NUMERIC(10, 6),
  momentum NUMERIC(10, 6),
  tick_acceleration NUMERIC(10, 6),
  noise_score NUMERIC(5, 2),
  confidence_at_entry NUMERIC(5, 2),
  ev_at_entry NUMERIC(10, 6),
  quality_score NUMERIC(5, 2),
  win_prob_at_entry NUMERIC(5, 2),
  agent_scores_json TEXT DEFAULT '{}',
  why_won TEXT,
  why_lost TEXT,
  could_have_avoided BOOLEAN DEFAULT FALSE,
  avoidance_reason TEXT,
  confidence_assessment TEXT,
  better_contract_type TEXT,
  better_barrier INTEGER,
  timing_assessment TEXT,
  agent_agreement_score NUMERIC(5, 2),
  dissident_agents_json TEXT DEFAULT '[]',
  findings_json TEXT DEFAULT '[]',
  hour_of_day INTEGER,
  minute_of_hour INTEGER,
  day_of_week INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS missed_opportunities (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  barrier INTEGER,
  stake NUMERIC(20, 2),
  reject_reason TEXT,
  blocking_filters_json TEXT DEFAULT '[]',
  confidence_at_rejection NUMERIC(5, 2),
  ev_at_rejection NUMERIC(10, 6),
  quality_score NUMERIC(5, 2),
  regime TEXT,
  hour_of_day INTEGER,
  would_have_won BOOLEAN,
  estimated_profit NUMERIC(20, 2),
  was_rejection_correct BOOLEAN,
  filter_too_strict BOOLEAN,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  evaluated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS adaptive_thresholds (
  id SERIAL PRIMARY KEY,
  confidence_threshold NUMERIC(5, 2) DEFAULT '38',
  ev_threshold NUMERIC(10, 6) DEFAULT '-0.05',
  timing_threshold NUMERIC(5, 2) DEFAULT '38',
  agent_weights_json TEXT DEFAULT '{}',
  agent_accuracy_json TEXT DEFAULT '{}',
  recent_win_rate NUMERIC(5, 4),
  trades_analyzed INTEGER DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy',
  symbol TEXT NOT NULL,
  display_name TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  barrier INTEGER,
  stake NUMERIC(20, 2) NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  payout NUMERIC(20, 2),
  profit NUMERIC(20, 2),
  entry_price NUMERIC(20, 6),
  exit_price NUMERIC(20, 6),
  ai_confidence NUMERIC(5, 2),
  ai_risk_score NUMERIC(5, 2),
  is_autonomous BOOLEAN NOT NULL DEFAULT FALSE,
  agent_reasoning TEXT,
  duration INTEGER,
  duration_unit TEXT DEFAULT 't',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP
);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS trades_session_created_idx ON trades (session_id, created_at);
`;

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

const useExternalPostgres = Boolean(
  process.env.DATABASE_URL &&
    (process.env.DATABASE_URL.startsWith("postgres://") ||
      process.env.DATABASE_URL.startsWith("postgresql://")) &&
    !process.env.DATABASE_URL.includes("pglite")
);

let poolInstance: any;
let dbInstance: NodePgDatabase<typeof schema>;

if (useExternalPostgres) {
  poolInstance = new Pool({ connectionString: process.env.DATABASE_URL });
  dbInstance = drizzlePg(poolInstance, { schema });
} else {
  // Use embedded PGlite with persistent disk storage
  const dbDir = path.resolve(process.cwd(), ".data/pglite");
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch {}

  const pglite = new PGlite(dbDir);
  // Execute initial DDL synchronously or on startup
  pglite.exec(INIT_DDL).catch((err: unknown) => {
    console.error("Failed to execute initial PGlite DDL:", err);
  });

  poolInstance = {
    async query(text: string, params?: any[]) {
      await pglite.waitReady;
      const res = await pglite.query(text, params);
      return {
        rows: res.rows,
        rowCount: res.affectedRows ?? res.rows.length,
        fields: res.fields,
      };
    },
    async end() {
      await pglite.close();
    },
    on() {},
  };

  dbInstance = drizzlePglite(pglite, { schema }) as unknown as NodePgDatabase<typeof schema>;
}

export const pool = poolInstance;
export const db = dbInstance;

export * from "./schema";
