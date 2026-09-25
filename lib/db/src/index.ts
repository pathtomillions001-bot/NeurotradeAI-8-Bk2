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
-- OAuth access tokens expire (typically 1h). Storing the expiry lets the API
-- refresh the token BEFORE it lapses, so a connected account is never silently
-- logged out mid-session. refresh_token (already present) is exchanged for a
-- new access token when this timestamp is near.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_login_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_session_login_unique ON accounts (session_id, login_id);
CREATE INDEX IF NOT EXISTS accounts_session_active_idx ON accounts (session_id, is_active);

-- ── Durable session links ─────────────────────────────────────────────────────
-- Binds a lasting browser identity (a 1-year cookie / localStorage client id)
-- and each tab identity to the account-scoped session that owns the connected
-- Deriv account. Without this table the only durable identity was the session
-- cookie, which the per-tab identity deliberately overrides — so every new tab,
-- every closed-and-reopened tab and every browser restart looked like a brand
-- new anonymous visitor ("logged out of my account").
CREATE TABLE IF NOT EXISTS session_links (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'client' (durable) | 'cookie' | 'tab'
  key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS session_links_kind_key ON session_links (kind, key);
CREATE INDEX IF NOT EXISTS session_links_session_idx ON session_links (session_id);

CREATE TABLE IF NOT EXISTS ai_insights (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy',
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  actionable BOOLEAN NOT NULL DEFAULT TRUE,
  related_market TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE ai_insights ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS ai_insights_session_idx ON ai_insights (session_id, created_at);

CREATE TABLE IF NOT EXISTS market_win_rates (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy',
  symbol TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  barrier INTEGER,
  win_rate NUMERIC(8, 6) NOT NULL DEFAULT '0.550000',
  trade_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE market_win_rates ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
DROP INDEX IF EXISTS market_win_rates_key;
CREATE UNIQUE INDEX IF NOT EXISTS market_win_rates_key ON market_win_rates (session_id, symbol, contract_type, barrier);

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
ALTER TABLE trade_features ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS trade_features_session_idx ON trade_features (session_id);

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
ALTER TABLE trade_intelligence_reports ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS trade_intel_session_idx ON trade_intelligence_reports (session_id, created_at);

CREATE TABLE IF NOT EXISTS missed_opportunities (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy',
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
ALTER TABLE missed_opportunities ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS missed_opps_session_idx ON missed_opportunities (session_id, created_at);

CREATE TABLE IF NOT EXISTS adaptive_thresholds (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy',
  confidence_threshold NUMERIC(5, 2) DEFAULT '38',
  ev_threshold NUMERIC(10, 6) DEFAULT '-0.05',
  timing_threshold NUMERIC(5, 2) DEFAULT '38',
  agent_weights_json TEXT DEFAULT '{}',
  agent_accuracy_json TEXT DEFAULT '{}',
  recent_win_rate NUMERIC(5, 4),
  trades_analyzed INTEGER DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- One adaptive row PER ACCOUNT. The previous single global row meant the last
-- account to trade set the thresholds every other account then learned from.
ALTER TABLE adaptive_thresholds ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
CREATE UNIQUE INDEX IF NOT EXISTS adaptive_thresholds_session_unique ON adaptive_thresholds (session_id);

-- ── Durable Deriv journal cache ───────────────────────────────────────────────
-- The profit-table history used to live ONLY in the server process's memory, so
-- a restart/redeploy (or a rate-limited re-pagination) showed an empty journal
-- for minutes — the "my trades disappeared" report. Every transaction Deriv
-- returns is now written through to this table and served from it instantly.
CREATE TABLE IF NOT EXISTS deriv_journal (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  contract_id TEXT,
  symbol TEXT,
  contract_type TEXT,
  buy_price NUMERIC(20, 4),
  sell_price NUMERIC(20, 4),
  purchase_time INTEGER,
  sell_time INTEGER,
  payload_json TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS deriv_journal_unique
  ON deriv_journal (session_id, account_id, transaction_id);
CREATE INDEX IF NOT EXISTS deriv_journal_session_idx
  ON deriv_journal (session_id, purchase_time DESC);

-- ── DBot strategies (Create Bot flow) ─────────────────────────────────────────
-- Scanner manifests compiled to Deriv DBot Blockly XML. The Bot Builder page
-- loads these into the embedded builder; the XML is executed by DBot itself.
CREATE TABLE IF NOT EXISTS dbot_strategies (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy',
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'overunder-turbo',
  symbol TEXT NOT NULL,
  manifest TEXT NOT NULL,
  xml TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dbot_strategies_session_idx
  ON dbot_strategies (session_id, created_at);

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
-- Deriv contract id, so an interrupted live trade can be settled from Deriv's
-- own profit_table instead of being stuck as "open"/"error" forever.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS deriv_contract_id TEXT;
CREATE INDEX IF NOT EXISTS trades_session_created_idx ON trades (session_id, created_at);
CREATE INDEX IF NOT EXISTS trades_unsettled_idx ON trades (status, created_at)
  WHERE status IN ('open', 'error');
`;

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

const useExternalPostgres = Boolean(
  process.env.DATABASE_URL &&
    (process.env.DATABASE_URL.startsWith("postgres://") ||
      process.env.DATABASE_URL.startsWith("postgresql://")) &&
    !process.env.DATABASE_URL.includes("pglite")
);

let poolInstance: any;
let pgliteInstance: PGlite | null = null;
let dbInstance: NodePgDatabase<typeof schema>;

/**
 * Resolves once the idempotent INIT_DDL has been applied (or definitively
 * attempted) against the backing database. Callers that need tables/columns
 * to exist should await this before their first query.
 *
 * WHY: on Railway the API runtime container has no pnpm/drizzle-kit, so the
 * previous "run drizzle-kit push at boot" strategy silently failed and every
 * settings/accounts/markets query died with `relation "settings" does not
 * exist`. Running the CREATE TABLE IF NOT EXISTS DDL directly over the pool
 * guarantees the schema exists regardless of build tooling availability.
 */
let resolveSchemaReady!: () => void;
export const schemaReady: Promise<void> = new Promise<void>((resolve) => {
  resolveSchemaReady = resolve;
});

if (useExternalPostgres) {
  // Railway / managed Postgres. Prefer DATABASE_URL from the plugin.
  // SSL is commonly required on managed hosts; rejectUnauthorized:false is the
  // usual serverless-friendly default when the provider uses a private CA.
  const needsSsl =
    process.env.PGSSL === "true" ||
    process.env.DATABASE_SSL === "true" ||
    /railway\.app|rlwy\.net|amazonaws\.com|supabase\.co|neon\.tech/i.test(
      process.env.DATABASE_URL ?? "",
    );

  poolInstance = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  dbInstance = drizzlePg(poolInstance, { schema });
} else {
  // Explicit test URL uses an isolated in-memory DB per process; unit tests
  // must never share a running preview's data directory or external credentials.
  const dbDir = process.env.DATABASE_URL === "pglite:memory"
    ? undefined
    : path.resolve(process.cwd(), ".data/pglite");
  if (dbDir) {
    try { fs.mkdirSync(dbDir, { recursive: true }); } catch {}
  }

  const pglite = new PGlite(dbDir);
  pgliteInstance = pglite;

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

/** Applies the idempotent INIT_DDL. Safe to call repeatedly. */
async function applySchemaDdl(): Promise<void> {
  if (useExternalPostgres) {
    await poolInstance.query(INIT_DDL);
  } else {
    await pgliteInstance!.exec(INIT_DDL);
  }
}

/**
 * Keep retrying the DDL until it succeeds, then resolve schemaReady.
 *
 * WHY a retry loop: the first boot attempt can hit a transient Postgres outage
 * (on Railway a simultaneous redeploy produced `connect ETIMEDOUT …:5432` for
 * minutes). A one-shot DDL then left the schema permanently missing even after
 * the network recovered, so settings/accounts/markets stayed broken until a
 * manual redeploy. Retrying in the background self-heals as soon as Postgres
 * answers.
 */
let ddlSucceeded = false;
async function ddlRetryLoop(): Promise<void> {
  let attempt = 0;
  while (!ddlSucceeded) {
    attempt++;
    try {
      await applySchemaDdl();
      ddlSucceeded = true;
      console.log(
        attempt === 1
          ? "[db] Initial DDL applied"
          : `[db] Initial DDL applied after ${attempt} attempts`,
      );
      resolveSchemaReady();
    } catch (err) {
      if (attempt === 1) resolveSchemaReady(); // don't block routes on a dead DB
      const waitMs = Math.min(30_000, 5_000 * attempt);
      console.error(
        `[db] DDL attempt ${attempt} failed — retrying in ${Math.round(waitMs / 1000)}s:`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
void ddlRetryLoop().catch((err) => {
  console.error("[db] DDL retry loop crashed:", err);
  resolveSchemaReady();
});

export const pool = poolInstance;
export const db = dbInstance;

export * from "./schema";