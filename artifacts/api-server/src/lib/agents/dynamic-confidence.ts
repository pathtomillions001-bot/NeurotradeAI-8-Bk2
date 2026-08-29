/**
 * Dynamic Confidence Engine
 *
 * RESPONSIBILITY: Replace the fixed per-agent weights in ConfidenceFusion with
 * a data-driven, continuously recalibrated model.  After every completed trade
 * the engine:
 *   1. Scores each agent — did its score correctly predict the outcome?
 *   2. Updates an exponential moving average of each agent's prediction accuracy.
 *   3. Derives new weights proportional to accuracy (high-accuracy agents get more say).
 *   4. Gradually shifts the confidence threshold based on recent win-rate.
 *
 * Adaptive threshold rules (within user-defined bounds):
 *   recentWinRate > 0.62 for ≥10 trades  → lower threshold by 0.5 (catch more opportunities)
 *   recentWinRate < 0.44 for ≥10 trades  → raise threshold by 0.5 (demand stronger signals)
 *   Always clamp: [MIN_THRESHOLD, MAX_THRESHOLD]
 *
 * Weights are multiplied on top of the base AGENT_WEIGHTS in confidence-fusion.ts
 * so existing logic degrades gracefully when data is sparse.
 */

import { db } from "@workspace/db";
import { adaptiveThresholdsTable } from "@workspace/db";
import { logger } from "../logger";

// ── Base weights (same as confidence-fusion.ts) ────────────────────────────────
// recoveryIntelligence raised from 0.6 → 1.2 so its streak-based score penalty
// has real pull in the weighted sum (it drops to 15-25 during a loss streak, which
// drags the fusion score well below any reasonable threshold).
// learningAgent raised from 0.9 → 1.1 so historical win-rate calibration has
// meaningful influence on whether a trade is taken.
const BASE_WEIGHTS: Record<string, number> = {
  marketScanner:        1.5,
  tickIntelligence:     0.8,
  digitProbability:     1.2,
  riseFallAgent:        1.2,
  marketRegime:         1.0,
  executionTiming:      0.7,
  recoveryIntelligence: 1.2,   // raised: must carry real veto weight during loss streaks
  riskIntelligence:     1.3,
  portfolioManager:     1.1,
  learningAgent:        1.1,   // raised: historical calibration should steer trade selection
  patternDiscovery:     0.5,
};

const AGENT_IDS = Object.keys(BASE_WEIGHTS);
const MIN_THRESHOLD = 34;
const MAX_THRESHOLD = 65;
const ACCURACY_ALPHA = 1 / 20; // EMA window ≈ 20 trades

interface AgentAccuracyRecord {
  /** EMA of correct directional predictions (0–1) */
  accuracy: number;
  /** total real trade samples seen */
  samples: number;
}

// ── In-memory state ───────────────────────────────────────────────────────────
const agentAccuracy: Record<string, AgentAccuracyRecord> = {};
for (const id of AGENT_IDS) {
  agentAccuracy[id] = { accuracy: 0.5, samples: 0 };
}

// Recent outcomes window (circular buffer of length 20)
const recentOutcomes: boolean[] = [];
const MAX_RECENT = 20;

let currentConfidenceThreshold = 38;
let currentEvThreshold = -0.05;
let currentTimingThreshold = 38;
let tradesAnalyzed = 0;

// Whether we've loaded state from DB this session
let initialized = false;

// ── DB persistence ─────────────────────────────────────────────────────────────

export async function loadFromDb(): Promise<void> {
  if (initialized) return;
  try {
    const rows = await db.select().from(adaptiveThresholdsTable).limit(1);
    if (rows.length > 0) {
      const row = rows[0];
      currentConfidenceThreshold = Number(row.confidenceThreshold ?? 38);
      currentEvThreshold = Number(row.evThreshold ?? -0.05);
      currentTimingThreshold = Number(row.timingThreshold ?? 38);
      tradesAnalyzed = row.tradesAnalyzed ?? 0;

      if (row.agentAccuracyJson) {
        try {
          const stored = JSON.parse(row.agentAccuracyJson) as Record<string, AgentAccuracyRecord>;
          for (const [id, rec] of Object.entries(stored)) {
            if (agentAccuracy[id]) agentAccuracy[id] = rec;
          }
        } catch { /* ignore parse error */ }
      }

      // Restore the recent-outcomes window to preserve adaptive threshold continuity
      if (row.agentWeightsJson) {
        try {
          const parsed = JSON.parse(row.agentWeightsJson) as any;
          if (Array.isArray(parsed._recentOutcomes)) {
            const restored = (parsed._recentOutcomes as boolean[]).slice(-MAX_RECENT);
            recentOutcomes.splice(0, recentOutcomes.length, ...restored);
          }
        } catch { /* ignore */ }
      }
    }
    initialized = true;
    logger.info({ tradesAnalyzed, confidenceThreshold: currentConfidenceThreshold }, "DynamicConfidenceEngine loaded from DB");
  } catch (err) {
    logger.warn({ err }, "DynamicConfidenceEngine: could not load from DB — using defaults");
    initialized = true;
  }
}

async function persistToDb(): Promise<void> {
  try {
    const recentWinRate = recentOutcomes.length > 0
      ? recentOutcomes.filter(Boolean).length / recentOutcomes.length
      : 0.5;

    const payload = {
      confidenceThreshold: String(currentConfidenceThreshold),
      evThreshold:         String(currentEvThreshold),
      timingThreshold:     String(currentTimingThreshold),
      agentAccuracyJson:   JSON.stringify(agentAccuracy),
      // Also persist the recent outcomes window so cold-start restores continuity
      agentWeightsJson:    JSON.stringify({ ...getDynamicWeights(), _recentOutcomes: recentOutcomes }),
      recentWinRate:       String(recentWinRate),
      tradesAnalyzed,
      updatedAt:           new Date(),
    };

    const existing = await db.select().from(adaptiveThresholdsTable).limit(1);
    if (existing.length > 0) {
      await db.update(adaptiveThresholdsTable).set(payload);
    } else {
      await db.insert(adaptiveThresholdsTable).values(payload as any);
    }
  } catch (err) {
    logger.warn({ err }, "DynamicConfidenceEngine: could not persist to DB");
  }
}

// ── Core update logic ─────────────────────────────────────────────────────────

/**
 * Called after every completed trade (autonomous or manual).
 * agentScores: map of agentId → score (0–100) at the time of the trade.
 * won: actual outcome.
 */
export function recordTradeOutcome(
  agentScores: Record<string, number>,
  won: boolean,
): void {
  // Update recent outcome window
  if (recentOutcomes.length >= MAX_RECENT) recentOutcomes.shift();
  recentOutcomes.push(won);
  tradesAnalyzed++;

  // Update per-agent accuracy via EMA
  for (const id of AGENT_IDS) {
    const score = agentScores[id] ?? 50;
    // Agent correctly predicted direction when:
    //   score > 60 and won  (bullish signal → win)
    //   score < 40 and !won (bearish signal → loss = expected)
    // Score 40-60 is neutral — don't update accuracy
    let correct: boolean | null = null;
    if (score > 60) correct = won;
    else if (score < 40) correct = !won;

    if (correct !== null) {
      const prev = agentAccuracy[id];
      const alpha = prev.samples < 5 ? 0.3 : ACCURACY_ALPHA; // faster learning when cold
      agentAccuracy[id] = {
        accuracy: prev.accuracy * (1 - alpha) + (correct ? alpha : 0),
        samples:  prev.samples + 1,
      };
    }
  }

  // Adaptive confidence threshold
  if (recentOutcomes.length >= 10) {
    const recentWinRate = recentOutcomes.filter(Boolean).length / recentOutcomes.length;

    if (recentWinRate > 0.62) {
      // Doing well — slightly relax threshold to catch more opportunities
      currentConfidenceThreshold = Math.max(MIN_THRESHOLD, currentConfidenceThreshold - 0.5);
    } else if (recentWinRate < 0.44) {
      // Losing too much — tighten threshold
      currentConfidenceThreshold = Math.min(MAX_THRESHOLD, currentConfidenceThreshold + 0.5);
    }
    // Also adapt EV threshold
    if (recentWinRate > 0.65) {
      currentEvThreshold = Math.max(-0.08, currentEvThreshold - 0.002);
    } else if (recentWinRate < 0.40) {
      currentEvThreshold = Math.min(0.0, currentEvThreshold + 0.002);
    }
  }

  // Persist every 5 trades (don't await — fire-and-forget)
  if (tradesAnalyzed % 5 === 0) {
    persistToDb().catch(() => {});
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns dynamic per-agent weights derived from historical accuracy.
 * Falls back to base weights when data is sparse (< 5 samples).
 * The multiplier ranges from 0.5× (consistently wrong) to 1.5× (consistently right).
 */
export function getDynamicWeights(): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const id of AGENT_IDS) {
    const rec = agentAccuracy[id];
    // Multiplier: accuracy=0 → 0.5×, accuracy=0.5 → 1.0×, accuracy=1 → 1.5×
    const multiplier = rec.samples >= 5
      ? 0.5 + rec.accuracy        // data-driven
      : 1.0;                      // neutral when cold
    weights[id] = BASE_WEIGHTS[id] * multiplier;
  }
  return weights;
}

/**
 * Returns the adaptive confidence threshold, clamped within user limits.
 * The userMax is the value from settings.minConfidenceThreshold.
 */
export function getAdaptiveConfidenceThreshold(userMax: number): number {
  // Cap at the lower of: user setting, adaptive learned threshold, and 55
  const base = Math.min(userMax, currentConfidenceThreshold, 55);
  return Math.max(MIN_THRESHOLD, base);
}

/** Returns the adaptive EV threshold (-0.08 to 0.0). */
export function getAdaptiveEvThreshold(): number {
  return currentEvThreshold;
}

/** Returns the adaptive timing threshold. */
export function getAdaptiveTimingThreshold(): number {
  return currentTimingThreshold;
}

/** Returns a summary suitable for the API response. */
export function getStatus() {
  const recentWinRate = recentOutcomes.length > 0
    ? recentOutcomes.filter(Boolean).length / recentOutcomes.length
    : null;

  const agentStats = AGENT_IDS.map(id => ({
    agentId: id,
    accuracy: Math.round(agentAccuracy[id].accuracy * 100),
    samples: agentAccuracy[id].samples,
    dynamicWeight: Math.round(getDynamicWeights()[id] * 100) / 100,
    baseWeight: BASE_WEIGHTS[id],
  }));

  return {
    confidenceThreshold: currentConfidenceThreshold,
    evThreshold: currentEvThreshold,
    timingThreshold: currentTimingThreshold,
    recentWinRate: recentWinRate !== null ? Math.round(recentWinRate * 1000) / 10 : null,
    recentSampleSize: recentOutcomes.length,
    tradesAnalyzed,
    agentStats,
  };
}
