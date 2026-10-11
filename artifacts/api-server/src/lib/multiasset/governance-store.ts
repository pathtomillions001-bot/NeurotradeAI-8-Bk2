/**
 * WP9 — the durable side of governance: the desk's own record, written down.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM `governance.ts` ────────────────────
 *
 * `governance.ts` is pure arithmetic: state in, state out, no I/O. That is what
 * makes it testable and replayable. This module is the opposite end — it is the
 * only place that touches the database — and keeping the two apart is what makes
 * "the weekly report is reproducible from the stored trades" a statement about
 * code rather than a hope about timing.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────
 *
 *   • **Mirror first, database second.** Every write lands in an in-process
 *     mirror immediately (so the desk's own API can answer even when Postgres is
 *     unreachable) and is then written through, best-effort. A failed write logs
 *     once and never throws into a request.
 *   • **Reads prefer the database.** The mirror only holds this process's life;
 *     the whole point of the tables is that a restart does not erase the record,
 *     so a read that CAN hit the database does.
 *   • **No fabricated values.** A trade without a real risk denominator stores a
 *     NULL `realised_r` rather than a zero, and a shadow evaluation that never
 *     closed keeps a NULL `outcome_r`. "Unknown" is a value the report can count.
 *   • **Bounded mirrors.** The mirrors are capped exactly like the desk's own
 *     in-process journal, so a long-lived process cannot grow without limit.
 */

import type { AgentGovernanceState, WeeklyEvaluation, WeeklyTrade } from "./governance";

export const SHADOW_TABLE = "desk_shadow_evaluations";
export const TRADE_TABLE = "desk_trades";
export const JOURNAL_TABLE = "desk_journal";
export const CALIBRATOR_TABLE = "desk_calibrators";
export const GOVERNANCE_TABLE = "desk_governance_state";

/** How many rows an in-process mirror keeps when the database is unreachable. */
const MIRROR_LIMIT = 500;

export interface ShadowEvaluationRow {
  sessionId: string;
  evaluatedAtMs: number;
  symbol: string;
  mode: string;
  armed: boolean;
  planId: string | null;
  direction: string | null;
  probability: number | null;
  probabilityLowerBound: number | null;
  breakEvenProbability: number | null;
  expectancyR: number | null;
  costR: number | null;
  agents: string[];
  refusals: string[];
  gateCodes: string[];
  outcomeR?: number | null;
  resolvedAtMs?: number | null;
  payload?: unknown;
}

export interface TradeRow {
  sessionId: string;
  ticket: number;
  planId: string | null;
  symbol: string;
  mode: string;
  side: string;
  openedAtMs: number;
  closedAtMs: number;
  lots: number;
  riskMoney: number | null;
  netProfit: number;
  realisedR: number | null;
  /** The probability the desk had when it armed the trade, when it recorded one. */
  predictedProbability: number | null;
  slippageR: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  agents: string[];
  payload?: unknown;
}

export interface JournalRow {
  sessionId: string;
  entryId: string;
  tsMs: number;
  kind: string;
  symbol: string | null;
  message: string;
  detail?: unknown;
}

export interface StoredArtifact {
  kind: string;
  refKey: string;
  version: string;
  mode: string | null;
  symbol: string | null;
  samples: number;
  payload: unknown;
  createdAtMs: number;
}

// ── In-process mirrors ──────────────────────────────────────────────────────

const shadowMirror: ShadowEvaluationRow[] = [];
const tradeMirror: TradeRow[] = [];
const journalMirror: JournalRow[] = [];
const artifactMirror: StoredArtifact[] = [];
const governanceMirror = new Map<string, AgentGovernanceState[]>();

function pushBounded<T>(mirror: T[], row: T): void {
  mirror.push(row);
  if (mirror.length > MIRROR_LIMIT) mirror.splice(0, mirror.length - MIRROR_LIMIT);
}

/**
 * Test-only reset. Clears BOTH the mirrors and (when a database is attached) the
 * rows this module wrote, so one test's governance cannot leak into another's.
 */
export async function resetGovernanceStoreForTests(): Promise<void> {
  shadowMirror.length = 0;
  tradeMirror.length = 0;
  journalMirror.length = 0;
  artifactMirror.length = 0;
  governanceMirror.clear();
  const db = await pool();
  if (!db) return;
  try {
    await db.query(`DELETE FROM ${SHADOW_TABLE}`);
    await db.query(`DELETE FROM ${TRADE_TABLE}`);
    await db.query(`DELETE FROM ${JOURNAL_TABLE}`);
    await db.query(`DELETE FROM ${CALIBRATOR_TABLE}`);
    await db.query(`DELETE FROM ${GOVERNANCE_TABLE}`);
  } catch {
    // A missing table means the DDL has not run yet; there is nothing to clear.
  }
}

async function pool(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } | null> {
  try {
    const mod = await import("@workspace/db");
    return (mod as { pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } }).pool ?? null;
  } catch {
    return null;
  }
}

let warned = false;
function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn("[desk-governance] database unavailable; the record is in-process only", err);
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Record one shadow evaluation (armed or refused). Never throws. */
export async function recordShadowEvaluation(row: ShadowEvaluationRow): Promise<void> {
  pushBounded(shadowMirror, row);
  const db = await pool();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO ${SHADOW_TABLE}
         (session_id, evaluated_at_ms, symbol, mode, armed, plan_id, direction, probability,
          probability_lower_bound, break_even_probability, expectancy_r, cost_r,
          agents_json, refusals_json, gate_codes_json, outcome_r, resolved_at_ms, payload_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        row.sessionId,
        row.evaluatedAtMs,
        row.symbol,
        row.mode,
        row.armed,
        row.planId,
        row.direction,
        row.probability,
        row.probabilityLowerBound,
        row.breakEvenProbability,
        row.expectancyR,
        row.costR,
        json(row.agents),
        json(row.refusals),
        json(row.gateCodes),
        row.outcomeR ?? null,
        row.resolvedAtMs ?? null,
        row.payload === undefined ? null : json(row.payload),
      ],
    );
  } catch (err) {
    warnOnce(err);
  }
}

/** Record one closed trade. `realisedR` is null when the desk cannot measure it. */
export async function recordTrade(row: TradeRow): Promise<void> {
  pushBounded(tradeMirror, row);
  const db = await pool();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO ${TRADE_TABLE}
         (session_id, ticket, plan_id, symbol, mode, side, opened_at_ms, closed_at_ms, lots,
          risk_money, net_profit, realised_r, predicted_probability, slippage_r, entry_price,
          exit_price, exit_reason, agents_json, payload_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        row.sessionId,
        row.ticket,
        row.planId,
        row.symbol,
        row.mode,
        row.side,
        row.openedAtMs,
        row.closedAtMs,
        row.lots,
        row.riskMoney,
        row.netProfit,
        row.realisedR,
        row.predictedProbability,
        row.slippageR,
        row.entryPrice,
        row.exitPrice,
        row.exitReason,
        json(row.agents),
        row.payload === undefined ? null : json(row.payload),
      ],
    );
  } catch (err) {
    warnOnce(err);
  }
}

/** Append one journal entry. Idempotent on `(session_id, entry_id)`. */
export async function recordJournalEntry(row: JournalRow): Promise<void> {
  pushBounded(journalMirror, row);
  const db = await pool();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO ${JOURNAL_TABLE} (session_id, entry_id, ts_ms, kind, symbol, message, detail_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (session_id, entry_id) DO NOTHING`,
      [row.sessionId, row.entryId, row.tsMs, row.kind, row.symbol, row.message, row.detail === undefined ? null : json(row.detail)],
    );
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Persist a fitted artifact (a WP5 calibrator, a WP3 HMM parameter set).
 *
 * `version` is supplied by the caller and must identify the fit — the table's
 * unique index is on `(kind, ref_key, version)`, so storing the same version
 * twice is a no-op rather than a second row that makes "which model is live?"
 * unanswerable.
 */
export async function saveArtifact(artifact: StoredArtifact): Promise<void> {
  pushBounded(artifactMirror, artifact);
  const db = await pool();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO ${CALIBRATOR_TABLE}
         (kind, ref_key, version, mode, symbol, samples, payload_json, created_at_ms, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
       ON CONFLICT (kind, ref_key, version) DO NOTHING`,
      [
        artifact.kind,
        artifact.refKey,
        artifact.version,
        artifact.mode,
        artifact.symbol,
        artifact.samples,
        json(artifact.payload),
        artifact.createdAtMs,
      ],
    );
  } catch (err) {
    warnOnce(err);
  }
}

/** Persist the per-agent governance state (one row per agent, upserted). */
export async function saveGovernanceState(sessionId: string, registry: AgentGovernanceState[]): Promise<void> {
  governanceMirror.set(sessionId, registry);
  const db = await pool();
  if (!db) return;
  try {
    for (const agent of registry) {
      await db.query(
        `INSERT INTO ${GOVERNANCE_TABLE}
           (session_id, agent_id, status, e_value, outcomes, wins, total_r, ph_value, ph_alarms,
            ph_mean, ph_cumulative, ph_max, updated_at_ms, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (session_id, agent_id) DO UPDATE SET
           status = EXCLUDED.status, e_value = EXCLUDED.e_value, outcomes = EXCLUDED.outcomes,
           wins = EXCLUDED.wins, total_r = EXCLUDED.total_r, ph_value = EXCLUDED.ph_value,
           ph_alarms = EXCLUDED.ph_alarms, ph_mean = EXCLUDED.ph_mean,
           ph_cumulative = EXCLUDED.ph_cumulative, ph_max = EXCLUDED.ph_max,
           updated_at_ms = EXCLUDED.updated_at_ms, reason = EXCLUDED.reason`,
        [
          sessionId,
          agent.agentId,
          agent.status,
          agent.eValue,
          agent.outcomes,
          agent.wins,
          agent.totalR,
          agent.phValue,
          agent.phAlarms,
          agent.phMean,
          agent.phCumulative,
          agent.phMax,
          agent.updatedAtMs,
          agent.reason,
        ],
      );
    }
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Fill in the realised R of the evaluation that armed a plan.
 *
 * Keyed by `(session_id, plan_id)` and only ever written once per evaluation —
 * a second close for the same plan (a partial fill reported twice, a re-sync)
 * must not overwrite the first measured outcome with a later one.
 */
export async function resolveShadowEvaluation(input: {
  sessionId: string;
  planId: string;
  outcomeR: number;
  resolvedAtMs: number;
}): Promise<void> {
  for (const row of shadowMirror) {
    if (row.sessionId === input.sessionId && row.planId === input.planId && row.outcomeR === null) {
      row.outcomeR = input.outcomeR;
      row.resolvedAtMs = input.resolvedAtMs;
    }
  }
  const db = await pool();
  if (!db) return;
  try {
    await db.query(
      `UPDATE ${SHADOW_TABLE} SET outcome_r = $3, resolved_at_ms = $4
       WHERE session_id = $1 AND plan_id = $2 AND outcome_r IS NULL`,
      [input.sessionId, input.planId, input.outcomeR, input.resolvedAtMs],
    );
  } catch (err) {
    warnOnce(err);
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listShadowEvaluations(input: {
  sessionId: string;
  limit?: number;
  symbol?: string | null;
}): Promise<ShadowEvaluationRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  const db = await pool();
  if (db) {
    try {
      const result = await db.query(
        `SELECT * FROM ${SHADOW_TABLE}
         WHERE session_id = $1 ${input.symbol ? "AND symbol = $3" : ""}
         ORDER BY evaluated_at_ms DESC LIMIT $2`,
        input.symbol ? [input.sessionId, limit, input.symbol] : [input.sessionId, limit],
      );
      return (result.rows as Record<string, unknown>[]).map(rowFromShadow);
    } catch (err) {
      warnOnce(err);
    }
  }
  return shadowMirror
    .filter((row) => row.sessionId === input.sessionId && (!input.symbol || row.symbol === input.symbol))
    .slice(-limit)
    .reverse();
}

export async function listTrades(input: { sessionId: string; limit?: number }): Promise<TradeRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  const db = await pool();
  if (db) {
    try {
      const result = await db.query(
        `SELECT * FROM ${TRADE_TABLE} WHERE session_id = $1 ORDER BY closed_at_ms DESC LIMIT $2`,
        [input.sessionId, limit],
      );
      return (result.rows as Record<string, unknown>[]).map(rowFromTrade);
    } catch (err) {
      warnOnce(err);
    }
  }
  return tradeMirror
    .filter((row) => row.sessionId === input.sessionId)
    .slice(-limit)
    .reverse();
}

export async function listJournal(input: {
  sessionId: string;
  limit?: number;
  kind?: string | null;
}): Promise<JournalRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
  const db = await pool();
  if (db) {
    try {
      const result = await db.query(
        `SELECT * FROM ${JOURNAL_TABLE}
         WHERE session_id = $1 ${input.kind ? "AND kind = $3" : ""}
         ORDER BY ts_ms DESC LIMIT $2`,
        input.kind ? [input.sessionId, limit, input.kind] : [input.sessionId, limit],
      );
      return (result.rows as Record<string, unknown>[]).map(rowFromJournal);
    } catch (err) {
      warnOnce(err);
    }
  }
  return journalMirror
    .filter((row) => row.sessionId === input.sessionId && (!input.kind || row.kind === input.kind))
    .slice(-limit)
    .reverse();
}

/** The active artifact for a scope, newest first, or null. */
export async function loadArtifact(input: { kind: string; refKey?: string }): Promise<StoredArtifact | null> {
  const refKey = input.refKey ?? "*";
  const db = await pool();
  if (db) {
    try {
      const result = await db.query(
        `SELECT * FROM ${CALIBRATOR_TABLE}
         WHERE kind = $1 AND ref_key = $2 AND active = TRUE
         ORDER BY created_at_ms DESC LIMIT 1`,
        [input.kind, refKey],
      );
      const row = (result.rows as Record<string, unknown>[])[0];
      if (row) return artifactFromRow(row);
    } catch (err) {
      warnOnce(err);
    }
  }
  const candidates = artifactMirror.filter((row) => row.kind === input.kind && row.refKey === refKey);
  return candidates.length > 0 ? (candidates[candidates.length - 1] as StoredArtifact) : null;
}

export async function loadGovernanceState(sessionId: string): Promise<AgentGovernanceState[] | null> {
  const db = await pool();
  if (db) {
    try {
      const result = await db.query(`SELECT * FROM ${GOVERNANCE_TABLE} WHERE session_id = $1`, [sessionId]);
      const rows = result.rows as Record<string, unknown>[];
      if (rows.length > 0) {
        return rows.map((row) => ({
          agentId: String(row.agent_id) as AgentGovernanceState["agentId"],
          status: String(row.status) as AgentGovernanceState["status"],
          eValue: num(row.e_value) ?? 1,
          outcomes: Number(row.outcomes ?? 0),
          wins: Number(row.wins ?? 0),
          totalR: num(row.total_r) ?? 0,
          phValue: num(row.ph_value) ?? 0,
          phAlarms: Number(row.ph_alarms ?? 0),
          phMean: num(row.ph_mean) ?? 0,
          phCumulative: num(row.ph_cumulative) ?? 0,
          phMax: num(row.ph_max) ?? 0,
          reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
          updatedAtMs: num(row.updated_at_ms) ?? 0,
        }));
      }
    } catch (err) {
      warnOnce(err);
    }
  }
  return governanceMirror.get(sessionId) ?? null;
}

/** Shape a stored evaluation into what the weekly report reads. */
export function toWeeklyEvaluation(row: ShadowEvaluationRow): WeeklyEvaluation {
  return {
    symbol: row.symbol,
    mode: row.mode,
    evaluatedAtMs: row.evaluatedAtMs,
    armed: row.armed,
    refusals: row.refusals,
    gateCodes: row.gateCodes,
  };
}

/** Shape a stored trade into what the weekly report reads. */
export function toWeeklyTrade(row: TradeRow): WeeklyTrade {
  return {
    symbol: row.symbol,
    mode: row.mode,
    side: row.side,
    closedAtMs: row.closedAtMs,
    realisedR: row.realisedR,
    netProfit: row.netProfit,
    // Stored on the trade at close time (copied from the plan's own evaluation):
    // a trade whose decision the desk cannot identify keeps a NULL prediction
    // rather than a guess, and the report counts it instead of dropping it.
    predictedProbability: row.predictedProbability,
    slippageR: row.slippageR,
  };
}

// ── Row mapping (the database returns snake_case) ───────────────────────────

function rowFromShadow(row: Record<string, unknown>): ShadowEvaluationRow {
  return {
    sessionId: String(row.session_id),
    evaluatedAtMs: num(row.evaluated_at_ms) ?? 0,
    symbol: String(row.symbol),
    mode: String(row.mode),
    armed: Boolean(row.armed),
    planId: row.plan_id === null || row.plan_id === undefined ? null : String(row.plan_id),
    direction: row.direction === null || row.direction === undefined ? null : String(row.direction),
    probability: num(row.probability),
    probabilityLowerBound: num(row.probability_lower_bound),
    breakEvenProbability: num(row.break_even_probability),
    expectancyR: num(row.expectancy_r),
    costR: num(row.cost_r),
    agents: parseJson<string[]>(row.agents_json, []),
    refusals: parseJson<string[]>(row.refusals_json, []),
    gateCodes: parseJson<string[]>(row.gate_codes_json, []),
    outcomeR: num(row.outcome_r),
    resolvedAtMs: num(row.resolved_at_ms),
    payload: parseJson<unknown>(row.payload_json, null),
  };
}

function rowFromTrade(row: Record<string, unknown>): TradeRow {
  return {
    sessionId: String(row.session_id),
    ticket: Number(row.ticket ?? 0),
    planId: row.plan_id === null || row.plan_id === undefined ? null : String(row.plan_id),
    symbol: String(row.symbol),
    mode: String(row.mode),
    side: String(row.side),
    openedAtMs: num(row.opened_at_ms) ?? 0,
    closedAtMs: num(row.closed_at_ms) ?? 0,
    lots: num(row.lots) ?? 0,
    riskMoney: num(row.risk_money),
    netProfit: num(row.net_profit) ?? 0,
    realisedR: num(row.realised_r),
    predictedProbability: num(row.predicted_probability),
    slippageR: num(row.slippage_r),
    entryPrice: num(row.entry_price),
    exitPrice: num(row.exit_price),
    exitReason: row.exit_reason === null || row.exit_reason === undefined ? null : String(row.exit_reason),
    agents: parseJson<string[]>(row.agents_json, []),
    payload: parseJson<unknown>(row.payload_json, null),
  };
}

function rowFromJournal(row: Record<string, unknown>): JournalRow {
  return {
    sessionId: String(row.session_id),
    entryId: String(row.entry_id),
    tsMs: num(row.ts_ms) ?? 0,
    kind: String(row.kind),
    symbol: row.symbol === null || row.symbol === undefined ? null : String(row.symbol),
    message: String(row.message),
    detail: parseJson<unknown>(row.detail_json, null),
  };
}

function artifactFromRow(row: Record<string, unknown>): StoredArtifact {
  return {
    kind: String(row.kind),
    refKey: String(row.ref_key),
    version: String(row.version),
    mode: row.mode === null || row.mode === undefined ? null : String(row.mode),
    symbol: row.symbol === null || row.symbol === undefined ? null : String(row.symbol),
    samples: Number(row.samples ?? 0),
    payload: parseJson<unknown>(row.payload_json, null),
    createdAtMs: num(row.created_at_ms) ?? 0,
  };
}
