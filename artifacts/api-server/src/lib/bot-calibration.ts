/**
 * Bot Probability Calibration — self-learning Platt scaling per contract family.
 *
 * A bot's probability estimate is only as good as its calibration: if a
 * "58% win" trade wins 50% of the time, every EV gate, stake size and paper
 * simulation built on top of it is systematically wrong. This module closes
 * the loop — every bot trade records (decision-time win probability, outcome)
 * and a small ridge logistic (Platt scaling) is refit on the family's own
 * history, so the estimate drifts toward realized frequency as evidence
 * accumulates.
 *
 * Design rules:
 *  - PER-FAMILY memory (parity / barrier / match / differ / momentum). A
 *    match digit's track record says nothing about parity — cross-family
 *    calibration would contaminate both.
 *  - Ridge logistic on x = logit(p), two parameters, IRLS — sub-millisecond
 *    for ≤300 records, no dependencies, deterministic.
 *  - SHRINKAGE TO IDENTITY: with n records the calibration strength is
 *    n/(n+40). A fresh account (no trades) behaves exactly like the
 *    uncalibrated bot; 40 trades ⇒ half-learned; 160+ ⇒ fully learned.
 *  - Below MIN_RECORDS the pool is not trusted at all (returns identity).
 *  - History loads from the shared `trades` table: bot trades are journaled
 *    with their decision-time win probability in `ai_confidence` and tagged
 *    with the bot's name in `agent_reasoning` ("[Parity Sentinel] …" /
 *    "[Parity Sentinel RECOVERY] Sniper …"). No new schema — identical
 *    behaviour on PGlite and external Postgres. The FAB tags its rows
 *    "[NEUROAI FAB] …", so bot pools can never cross-contaminate.
 */

import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { tradesTable } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import type { SpecialistFamily } from "./specialist-analysis";

type Db = NodePgDatabase<typeof schema>;

export interface CalibrationRecord {
  /** Decision-time win probability (0,1). */
  p: number;
  won: boolean;
}

export interface PlattFit {
  w0: number;
  w1: number;
  n: number;
}

/** Below this many own-history trades the pool is not trusted at all. */
export const CALIBRATION_MIN_RECORDS = 12;
/** Shrinkage scale: strength = n / (n + 40). */
export const CALIBRATION_SHRINK_N0 = 40;
/** Ring capacity per family. */
export const CALIBRATION_MAX_RECORDS = 300;

const store: Partial<Record<SpecialistFamily, CalibrationRecord[]>> = {};

/** Test / session hygiene. */
export function resetBotCalibration(): void {
  for (const key of Object.keys(store) as SpecialistFamily[]) delete store[key];
}

/** Record one of this bot's own trade outcomes. */
export function recordBotOutcome(family: SpecialistFamily, winProbability: number, won: boolean): void {
  if (!Number.isFinite(winProbability) || winProbability <= 0.005 || winProbability >= 0.995) return;
  const recs = store[family] ?? [];
  recs.push({ p: winProbability, won });
  store[family] = recs.slice(-CALIBRATION_MAX_RECORDS);
}

export function getCalibrationRecords(family: SpecialistFamily): CalibrationRecord[] {
  return store[family] ?? [];
}

/**
 * Fit Platt scaling:  y ~ σ(w0 + w1 · logit(p))  by IRLS with an L2 ridge.
 *
 * Degenerate inputs (n < 2, all one outcome, non-finite) return the identity
 * fit { w0: 0, w1: 1 }. w1 is clamped to [0.25, 3] and w0 to [−3, 3] so a
 * pathological pool can at most double or halve a log-odds, never invert it.
 */
export function fitPlatt(records: CalibrationRecord[], ridge = 0.05): PlattFit {
  const usable = records.filter(r => Number.isFinite(r.p) && r.p > 0.005 && r.p < 0.995);
  const n = usable.length;
  if (n < 2) return { w0: 0, w1: 1, n: usable.length };
  const x = usable.map(r => Math.log(r.p / (1 - r.p)));
  const y = usable.map(r => (r.won ? 1 : 0));
  if (y.every(v => v === y[0])) return { w0: 0, w1: 1, n }; // no information

  let w0 = 0;
  let w1 = 1;
  const lam = ridge * Math.sqrt(n);
  for (let it = 0; it < 15; it++) {
    let g0 = 0, g1 = 0, H00 = 0, H01 = 0, H11 = 0;
    for (let i = 0; i < n; i++) {
      const pi = 1 / (1 + Math.exp(-(w0 + w1 * x[i]!)));
      const wi = Math.max(1e-4, pi * (1 - pi));
      const resid = y[i]! - pi;
      g0 += wi * resid;
      g1 += wi * x[i]! * resid;
      H00 += wi;
      H01 += wi * x[i]!;
      H11 += wi * x[i]! * x[i]!;
    }
    H00 += lam;
    H11 += lam;
    const det = H00 * H11 - H01 * H01;
    if (Math.abs(det) < 1e-12) break;
    const d0 = (g0 * H11 - g1 * H01) / det;
    const d1 = (H00 * g1 - H01 * g0) / det;
    w0 = Math.max(-3, Math.min(3, w0 + d0));
    w1 = Math.max(0.25, Math.min(3, w1 + d1));
  }
  return { w0, w1, n };
}

/**
 * Apply a fit with shrinkage toward the identity map:
 *   strength = n / (n + 40);  w0' = strength·w0;  w1' = 1 + strength·(w1−1).
 */
export function applyPlatt(p: number, fit: PlattFit): number {
  if (!Number.isFinite(p) || p <= 0.005 || p >= 0.995) return Math.max(0.01, Math.min(0.99, p));
  const strength = fit.n / (fit.n + CALIBRATION_SHRINK_N0);
  const w0 = strength * fit.w0;
  const w1 = 1 + strength * (fit.w1 - 1);
  const q = Math.min(0.995, Math.max(0.005, p));
  const logit = Math.log(q / (1 - q));
  return Math.max(0.01, Math.min(0.99, 1 / (1 + Math.exp(-(w0 + w1 * logit)))));
}

/**
 * Calibrated win probability for one family. Identity below the minimum
 * record count — a fresh account trades exactly like the uncalibrated bot.
 */
export function calibratedWinProbability(family: SpecialistFamily, p: number): number {
  const recs = store[family];
  if (!recs || recs.length < CALIBRATION_MIN_RECORDS) {
    return Math.max(0.01, Math.min(0.99, p));
  }
  return applyPlatt(p, fitPlatt(recs));
}

/**
 * Load this bot's own trade history into the family's calibration pool.
 * Returns the number of records loaded. Never throws — calibration is a
 * best-effort enhancement, not a boot dependency.
 */
export async function loadBotCalibration(db: Db, botName: string, family: SpecialistFamily): Promise<number> {
  const normalTag = `%[${botName}]%`;
  const recoveryTag = `%[${botName} RECOVERY]%`;
  const rows = await db
    .select({ status: tradesTable.status, aiConfidence: tradesTable.aiConfidence })
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.isAutonomous, true),
        inArray(tradesTable.status, ["won", "lost"]),
        or(like(tradesTable.agentReasoning, normalTag), like(tradesTable.agentReasoning, recoveryTag)),
      ),
    )
    .orderBy(desc(tradesTable.createdAt))
    .limit(CALIBRATION_MAX_RECORDS);

  const recs: CalibrationRecord[] = rows
    .map(r => ({ p: Number(r.aiConfidence) / 100, won: r.status === "won" }))
    .filter(r => Number.isFinite(r.p) && r.p > 0.005 && r.p < 0.995)
    .reverse(); // oldest → newest (stable order; the fit is order-agnostic)
  store[family] = recs;
  return recs.length;
}
