import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const { Pool } = pg;

export const INIT_DDL = `
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
  cooldown_enabled BOOLEAN NOT NULL DEFAULT TRUE,
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
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autonomous_normal_contracts TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autonomous_recovery_contracts TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS cooldown_enabled BOOLEAN NOT NULL DEFAULT TRUE;
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
-- Quoted entry payout of an autonomous row (see schema/trades.ts entryPayout).
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_payout NUMERIC(20, 6);
CREATE INDEX IF NOT EXISTS trades_session_created_idx ON trades (session_id, created_at);
CREATE INDEX IF NOT EXISTS trades_unsettled_idx ON trades (status, created_at)
  WHERE status IN ('open', 'error');

-- ── Global MT5 account claims ─────────────────────────────────────────────────
-- One row per connected MetaTrader account. Desk state is per browser session,
-- so without a global registry the SAME broker account could be paired from two
-- browsers at once: both would stream it, both would arm plans against it, and
-- each could flatten positions the other thought it owned — counting one
-- balance against two sets of risk limits.
-- The unique index is the guarantee: concurrent pairings race on INSERT and
-- exactly one wins. A claim is released on unpair, or goes idle once the
-- terminal stops heartbeating, so a connection can never be locked out forever.
CREATE TABLE IF NOT EXISTS mt5_account_claims (
  id SERIAL PRIMARY KEY,
  account_key TEXT NOT NULL,          -- normalised 'login@SERVER'
  login BIGINT NOT NULL,
  server TEXT NOT NULL,
  company TEXT,
  session_id TEXT NOT NULL,           -- owning browser session
  paired_at_ms BIGINT NOT NULL,       -- epoch ms, comparable across processes
  last_seen_at_ms BIGINT NOT NULL     -- refreshed on every EA heartbeat
);
CREATE UNIQUE INDEX IF NOT EXISTS mt5_account_claims_key ON mt5_account_claims (account_key);
CREATE INDEX IF NOT EXISTS mt5_account_claims_session_idx ON mt5_account_claims (session_id);

-- ── Durable MT5 bridge links ────────────────────────────────────────────────
-- The bridge token used to live only in the API process's memory, so every
-- deploy, restart or crash broke the terminal <-> Desk link: the EA's token
-- became "invalid", the EA fell back to its pairing code, and the code was
-- only in memory too — so it had expired as well. The terminal then retried a
-- dead code every 5 seconds forever (HTTP 401 in the MT5 journal), stopped
-- heartbeating (the Desk showed "reconnecting"), and armed plans were never
-- delivered. Persisting both makes the link survive restarts and makes the
-- pairing code stay valid until the user actually unlinks the terminal.
--
-- Tokens are stored HASHED: the raw bearer token only ever exists in the
-- terminal and in process memory, so a database leak cannot be replayed
-- against the bridge. A row here is one LIVE terminal session, and it is
-- deleted — not merely revoked — when that session ends (the terminal closes,
-- or its heartbeat lease lapses). Only the user's explicit "Unlink terminal"
-- marks a row revoked, because that is the one answer the EA is allowed to
-- treat as final and stop retrying on; those rows are pruned on a timer.
CREATE TABLE IF NOT EXISTS mt5_bridge_links (
  token_hash TEXT PRIMARY KEY,        -- sha256 of the bearer token the EA holds
  session_id TEXT NOT NULL,           -- Desk (browser session) this terminal feeds
  account_key TEXT NOT NULL,          -- normalised 'login@SERVER'
  login BIGINT NOT NULL,
  server TEXT NOT NULL,
  company TEXT,
  code TEXT,                          -- pairing code that created this link; deleted with it
  paired_at_ms BIGINT NOT NULL,
  last_seen_at_ms BIGINT NOT NULL,    -- heartbeat marker; the lease is measured from here
  revoked_at_ms BIGINT                -- non-null only after an explicit unlink
);
CREATE INDEX IF NOT EXISTS mt5_bridge_links_session_idx ON mt5_bridge_links (session_id);
CREATE INDEX IF NOT EXISTS mt5_bridge_links_account_idx ON mt5_bridge_links (account_key);

-- Existing deployments: the link/code binding is new, so add it in place.
ALTER TABLE mt5_bridge_links ADD COLUMN IF NOT EXISTS code TEXT;

-- Pairing codes are active only while the terminal they paired is open. Before
-- redemption a code simply has a short TTL (it is typed into the EA by hand).
-- After redemption expires_at_ms is 0, which means "no timer of its own":
-- the code then lives exactly as long as the link it created, so the same
-- terminal can re-present it after an API redeploy. When that link ends the
-- code is RETIRED — stamped with the time it stopped working — so a terminal
-- presenting it is told "that session is over, take a new code" instead of the
-- indistinguishable "unknown code"; the row is pruned shortly after.
-- Reconnecting after MT5 was closed therefore requires a NEW code — which is
-- the whole point.
CREATE TABLE IF NOT EXISTS mt5_pairing_codes (
  code TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,      -- redeemed codes use 0 = bound to the link
  redeemed_at_ms BIGINT               -- first successful use
);
CREATE INDEX IF NOT EXISTS mt5_pairing_codes_session_idx ON mt5_pairing_codes (session_id);

-- ── WP9: the Desk's durable learning and governance record ───────────────────
-- Every claim the v4 pipeline makes about itself ("this is the desk's
-- out-of-sample record", "this agent was disabled by its own e-process") is only
-- true if it survives a restart. These five tables are that record; the Drizzle
-- definitions live in src/schema/desk.ts and must stay in step with this DDL.
CREATE TABLE IF NOT EXISTS desk_shadow_evaluations (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  evaluated_at_ms BIGINT NOT NULL,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL,
  armed BOOLEAN NOT NULL,
  plan_id TEXT,
  direction TEXT,
  probability DOUBLE PRECISION,
  probability_lower_bound DOUBLE PRECISION,
  break_even_probability DOUBLE PRECISION,
  expectancy_r DOUBLE PRECISION,
  cost_r DOUBLE PRECISION,
  agents_json TEXT NOT NULL DEFAULT '[]',
  refusals_json TEXT NOT NULL DEFAULT '[]',
  gate_codes_json TEXT NOT NULL DEFAULT '[]',
  outcome_r DOUBLE PRECISION,
  resolved_at_ms BIGINT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS desk_shadow_session_idx ON desk_shadow_evaluations (session_id, evaluated_at_ms);
CREATE INDEX IF NOT EXISTS desk_shadow_symbol_idx ON desk_shadow_evaluations (session_id, symbol, mode);

CREATE TABLE IF NOT EXISTS desk_trades (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  ticket BIGINT NOT NULL,
  plan_id TEXT,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL,
  side TEXT NOT NULL,
  opened_at_ms BIGINT NOT NULL,
  closed_at_ms BIGINT NOT NULL,
  lots DOUBLE PRECISION NOT NULL,
  risk_money DOUBLE PRECISION,
  net_profit DOUBLE PRECISION NOT NULL,
  realised_r DOUBLE PRECISION,
  predicted_probability DOUBLE PRECISION,
  slippage_r DOUBLE PRECISION,
  entry_price DOUBLE PRECISION,
  exit_price DOUBLE PRECISION,
  exit_reason TEXT,
  agents_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS desk_trades_session_idx ON desk_trades (session_id, closed_at_ms);
CREATE INDEX IF NOT EXISTS desk_trades_symbol_idx ON desk_trades (session_id, symbol, mode);

CREATE TABLE IF NOT EXISTS desk_journal (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  ts_ms BIGINT NOT NULL,
  kind TEXT NOT NULL,
  symbol TEXT,
  message TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS desk_journal_session_idx ON desk_journal (session_id, ts_ms);
CREATE UNIQUE INDEX IF NOT EXISTS desk_journal_entry_idx ON desk_journal (session_id, entry_id);

CREATE TABLE IF NOT EXISTS desk_calibrators (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_key TEXT NOT NULL DEFAULT '*',
  version TEXT NOT NULL,
  mode TEXT,
  symbol TEXT,
  samples INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS desk_calibrators_version_idx ON desk_calibrators (kind, ref_key, version);
CREATE INDEX IF NOT EXISTS desk_calibrators_kind_idx ON desk_calibrators (kind, ref_key, created_at_ms);

CREATE TABLE IF NOT EXISTS desk_governance_state (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  e_value DOUBLE PRECISION NOT NULL DEFAULT 1,
  outcomes INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  total_r DOUBLE PRECISION NOT NULL DEFAULT 0,
  ph_value DOUBLE PRECISION NOT NULL DEFAULT 0,
  ph_alarms INTEGER NOT NULL DEFAULT 0,
  ph_mean DOUBLE PRECISION NOT NULL DEFAULT 0,
  ph_cumulative DOUBLE PRECISION NOT NULL DEFAULT 0,
  ph_max DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL,
  reason TEXT,
  PRIMARY KEY (session_id, agent_id)
);

-- The owner's auto-trader settings (desk-settings.ts), one row per browser
-- session. The desk is otherwise in-process state that dies with the process,
-- and an auto-trader policy that silently reverted to the factory defaults on
-- every deploy would be a policy the owner cannot rely on: "risk 0.25% per
-- scalp" is a promise, and this table is what keeps it.
CREATE TABLE IF NOT EXISTS desk_settings (
  session_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
`;

// ── Applying the bootstrap script ONE STATEMENT AT A TIME ────────────────────
//
// ── WHY THIS IS NOT ONE QUERY ──────────────────────────────────────────────
//
// The script used to be handed to the driver whole (`pool.query(INIT_DDL)`).
// `pg` sends a parameterless query over the SIMPLE protocol, and Postgres runs
// a multi-statement simple query as ONE IMPLICIT TRANSACTION — so the first
// statement that fails rolls back everything before it AND SKIPS EVERYTHING
// AFTER IT. That is not a theoretical hazard here: several statements in this
// script are data-dependent (`CREATE UNIQUE INDEX … ON accounts (session_id,
// login_id)`, `… ON market_win_rates (…)`, `… ON deriv_journal (…)`), so a
// database that already holds duplicate legacy rows fails them on EVERY boot,
// with the same error, forever.
//
// The MT5 bridge's own tables (`mt5_account_claims`, `mt5_bridge_links`,
// `mt5_pairing_codes`) sit near the END of the script. One failing index over
// `accounts` therefore meant those tables were never created — while
// `/api/bridge/pairing-code` still answered 200 (the code was kept in process
// memory), the EA could still pair, and everything looked fine until the API
// restarted and the terminal presented the token it had saved. Then the lookup
// had nowhere to go, the link store was reported as unreachable, and the EA —
// whose contract says a 503 is transient and nothing was revoked — retried the
// same heartbeat forever. "MT5 cannot connect to the Desk" was, in the end, a
// schema that had been silently one statement short since the failing index
// entered the script.
//
// Running the script statement by statement makes that impossible: a statement
// that cannot apply is reported, the rest of the script still applies, and the
// next pass can finish whatever a transient failure (a lock timeout, a dropped
// connection mid-pass) left behind. The script is idempotent, so re-running it
// is free.
//
// A CONNECTION-level failure still aborts the pass: when the socket is gone
// there is nothing to learn from the remaining statements, and the caller's
// back-off/retry is the right answer.

export interface SchemaStatementFailure {
  /** The statement that did not apply (clipped; the SQL itself is in the repo). */
  statement: string;
  /** The database's own words, surfaced by `/api/healthz` and the bridge report. */
  message: string;
  /** Postgres SQLSTATE / driver code, when the driver reported one. */
  code?: string;
  at: number;
}

const STATEMENT_LOG_CLIP = 140;

function statementLabel(sql: string): string {
  const withoutComments = stripSqlComments(sql).replace(/\s+/g, " ").trim();
  const label = withoutComments || sql.replace(/\s+/g, " ").trim();
  return label.length > STATEMENT_LOG_CLIP ? `${label.slice(0, STATEMENT_LOG_CLIP - 1)}…` : label;
}

/**
 * Remove line comments and block comments, keeping string literals intact.
 *
 * Used to decide whether a chunk of the script contains anything to execute at
 * all (a chunk can be comments only) and to label a failing statement.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const span = literalEnd(sql, i, ch);
      out += sql.slice(i, span);
      i = span;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** End index (exclusive) of a quoted run starting at `start`, or `sql.length`. */
function literalEnd(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      // A doubled quote is an escaped quote, not the end of the literal.
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/**
 * Split a SQL script into individual statements.
 *
 * Semicolons inside string literals, quoted identifiers, dollar-quoted blocks
 * (`$$ … $$`, `$tag$ … $tag$`) and comments are not separators, so a script can
 * carry data as well as DDL. Comments stay attached to the statement that
 * follows them — Postgres is happy to receive them, and they are what makes a
 * failing statement readable in a log line.
 */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < script.length) {
    const ch = script[i];
    const next = script[i + 1];
    if (ch === "-" && next === "-") {
      const end = script.indexOf("\n", i);
      const stop = end === -1 ? script.length : end + 1;
      current += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = script.indexOf("*/", i + 2);
      const stop = end === -1 ? script.length : end + 2;
      current += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const stop = literalEnd(script, i, ch);
      current += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(script.slice(i));
      if (tag) {
        const end = script.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? script.length : end + tag[0].length;
        current += script.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      statements.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => stripSqlComments(statement).trim().length > 0);
}

/**
 * Driver/SQLSTATE codes that mean "the connection is gone", not "this
 * statement is not applicable". A pass that hits one of these aborts, so the
 * caller's retry is what runs next instead of a long list of statements each
 * reporting a socket error.
 */
const CONNECTION_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENETDOWN",
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "08007", // transaction_resolution_unknown
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

export function isConnectionLevelFailure(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  if (CONNECTION_FAILURE_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /(connection terminated|connection error|server closed the connection|client has encountered a connection error|terminating connection|could not connect|connect (?:econnrefused|etimedout|reset)|network is unreachable|socket hang up)/i.test(
    message,
  );
}

const loggedSchemaFailures = new Set<string>();

function noteSchemaFailure(failure: SchemaStatementFailure): void {
  const signature = `${failure.code ?? ""}|${failure.message}|${failure.statement.slice(0, 80)}`;
  if (loggedSchemaFailures.has(signature)) return;
  loggedSchemaFailures.add(signature);
  console.error(
    `[db] bootstrap statement NOT applied (${failure.code ?? "no code"}): ${failure.message}\n` +
      `[db]   in: ${failure.statement}\n` +
      "[db]   carrying on with the rest of the script — the statements after this one are still applied.",
  );
}

/**
 * Apply a script statement by statement.
 *
 * Returns the statements that could not be applied. Throws only when the
 * connection itself failed, because then the answer for every remaining
 * statement is the same and the caller must back off and retry.
 */
export async function applySchemaStatements(
  run: (sql: string) => Promise<void>,
  script: string = INIT_DDL,
): Promise<SchemaStatementFailure[]> {
  const failures: SchemaStatementFailure[] = [];
  for (const statement of splitSqlStatements(script)) {
    try {
      await run(statement);
    } catch (err) {
      if (isConnectionLevelFailure(err)) throw err;
      const failure: SchemaStatementFailure = {
        statement: statementLabel(statement),
        message: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string } | null)?.code !== undefined ? String((err as { code?: string }).code) : undefined,
        at: Date.now(),
      };
      failures.push(failure);
      noteSchemaFailure(failure);
    }
  }
  return failures;
}

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

/** Applies the idempotent INIT_DDL, one statement at a time. Safe to re-run. */
async function applySchemaDdl(): Promise<SchemaStatementFailure[]> {
  return applySchemaStatements(async (sql) => {
    if (useExternalPostgres) {
      await poolInstance.query(sql);
    } else {
      await pgliteInstance!.exec(sql);
    }
  });
}

/**
 * Run the bootstrap until it stops making progress, then keep it honest.
 *
 * WHY a retry loop: the first boot attempt can hit a transient Postgres outage
 * (on Railway a simultaneous redeploy produced `connect ETIMEDOUT …:5432` for
 * minutes). A one-shot DDL then left the schema permanently missing even after
 * the network recovered, so settings/accounts/markets stayed broken until a
 * manual redeploy. Retrying in the background self-heals as soon as Postgres
 * answers.
 *
 * WHAT A PASS MEANS NOW: every statement is ATTEMPTED. A pass therefore ends in
 * one of three states —
 *
 *   1. clean:        nothing to retry, done;
 *   2. connection:   the socket went away mid-pass, so retry the whole pass;
 *   3. short:        the pass ran to the end but some statements did not apply
 *                    (a unique index over duplicate legacy rows, a lock that
 *                    timed out, a permission the deployment lacks).
 *
 * State 3 no longer means "the schema is missing": every statement that COULD
 * apply has. So the pass resolves `schemaReady`, records the failures for
 * `/api/healthz` and the bridge report, and keeps retrying on the same capped
 * back-off — a failure that was transient (a lock, a restart mid-pass) is gone
 * on the next pass, and one that is permanent is retried for the price of an
 * idempotent script instead of leaving the database permanently short.
 */
let ddlSucceeded = false;
let ddlFailures: SchemaStatementFailure[] = [];
let ddlPasses = 0;

async function ddlRetryLoop(): Promise<void> {
  let attempt = 0;
  let readyResolved = false;
  const resolveReadyOnce = () => {
    if (readyResolved) return;
    readyResolved = true;
    resolveSchemaReady();
  };

  for (;;) {
    attempt++;
    let failures: SchemaStatementFailure[] = [];
    try {
      failures = await applySchemaDdl();
      ddlSucceeded = true;
      ddlPasses = attempt;
      ddlFailures = failures;
      resolveReadyOnce();
    } catch (err) {
      // A connection-level failure says nothing about the statements that were
      // not reached; the pass is retried as a whole.
      resolveReadyOnce();
      const waitMs = Math.min(30_000, 5_000 * attempt);
      console.error(
        `[db] DDL attempt ${attempt} could not reach the database — retrying in ${Math.round(waitMs / 1000)}s:`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (failures.length === 0) {
      console.log(
        attempt === 1
          ? `[db] Initial DDL applied (${splitSqlStatements(INIT_DDL).length} statements)`
          : `[db] Initial DDL applied after ${attempt} attempts`,
      );
      return;
    }

    const waitMs = Math.min(30_000, 5_000 * attempt);
    console.error(
      `[db] bootstrap pass ${attempt} ran to the end, but ${failures.length} statement(s) did not apply ` +
        `(${failures.map((f) => f.message).join(" | ")}). Everything else is applied; retrying in ` +
        `${Math.round(waitMs / 1000)}s. /api/healthz reports these as db.schemaFailures.`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
}
void ddlRetryLoop().catch((err) => {
  console.error("[db] DDL retry loop crashed:", err);
  resolveSchemaReady();
});

/**
 * Which store this process is actually talking to — and whether a link written
 * to it now will still be there after the next restart.
 *
 * WHY THIS IS EXPORTED: the MT5 bridge persists its pairing codes and bearer
 * tokens here so that a deploy, a crash or a cold start cannot disconnect a
 * paired terminal. That guarantee is only as strong as this store. Without a
 * `postgres://` DATABASE_URL the process falls back to embedded PGlite, and
 * `pglite:memory` is per-process — so a deployment that believes its links are
 * durable can be writing them to a database that disappears on restart (or that
 * a second replica behind the router has never seen). Callers that make a
 * keep/discard decision on the strength of a stored row need to know which of
 * those worlds they are in, instead of discovering it as a 401 loop in a
 * customer's MT5 journal.
 */
export type DatabaseBackend = "postgres" | "pglite";

export const databaseBackend: DatabaseBackend = useExternalPostgres ? "postgres" : "pglite";

/** True only when a row written now survives this process ending. */
export const databaseIsDurable: boolean =
  useExternalPostgres || process.env.DATABASE_URL !== "pglite:memory";

export const pgliteDirectory: string | null = useExternalPostgres
  ? null
  : process.env.DATABASE_URL === "pglite:memory"
    ? null
    : path.resolve(process.cwd(), ".data/pglite");

export const databaseDetail: string = useExternalPostgres
  ? "external Postgres (DATABASE_URL)"
  : pgliteDirectory
    ? `embedded PGlite at ${pgliteDirectory}`
    : "embedded PGlite, in-memory (this process only)";

/**
 * Whether the bootstrap script has been applied — i.e. a pass ran to the END.
 *
 * READ THIS BEFORE USING IT AS A GATE. `true` means every statement in the
 * script was attempted, NOT that every statement succeeded: statements that
 * cannot apply (a unique index over duplicate legacy rows, a missing privilege)
 * are reported by `schemaFailures()` and do not stop the pass. `false` means the
 * database could not be reached at all, so nothing is known yet.
 *
 * It follows that this flag may not be used to decide whether a table can be
 * read. It briefly was — the MT5 bridge refused to look at a link while this
 * was false — and on a database where one unrelated statement failed forever,
 * that turned "your link row is right there" into a permanent
 * `503 The bridge link store could not be reached` on every heartbeat, which the
 * EA (correctly) retries forever. Reads attempt the read and report what the
 * store actually said; see `bridge-links.ts`.
 */
export function schemaApplied(): boolean {
  return ddlSucceeded;
}

/**
 * Statements from the most recent bootstrap pass that did NOT apply, exactly as
 * the database worded them. Empty is the normal, healthy answer.
 *
 * Exposed for `/api/healthz` (so a degraded schema is visible instead of being
 * discovered as a hung MT5 terminal) and for the bridge store report.
 */
export function schemaFailures(): SchemaStatementFailure[] {
  return [...ddlFailures];
}

/** How many bootstrap passes have run (a permanent failure is retried). */
export function schemaPasses(): number {
  return ddlPasses;
}

export const pool = poolInstance;
export const db = dbInstance;

/**
 * Test-only hooks — never called from a request path.
 *
 * `setSchemaApplied` exists so a test can prove a READ DOES NOT DEPEND ON THIS
 * FLAG (the defect that answered 503 for a row that was in the store). The
 * production flag is owned by the bootstrap loop above; nothing else may set it.
 */
export const schemaTesting = {
  setSchemaApplied(value: boolean): void {
    ddlSucceeded = value;
  },
};

export * from "./schema";