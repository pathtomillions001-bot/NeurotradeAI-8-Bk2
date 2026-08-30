/**
 * Self-Measured Signal Value — the engine tunes itself on its own track record.
 *
 * After every FAB trade, the decision-time analysis features are recorded
 * (separately for normal and recovery trades). For each feature the engine
 * compares the realized win-rate of its TOP tercile against its BOTTOM
 * tercile across the pool. Only features with a demonstrated predictive lift
 * (≥ 10pp) earn a bounded score contribution:
 *
 *   +2 per valued feature when the candidate sits in its top tercile
 *   −2 per valued feature when the candidate sits in its bottom tercile
 *   (total clamped to ±6)
 *
 * Session-local: it starts empty each session and learns as the engine
 * trades — the system literally measures, on the markets it trades, which of
 * its own analytical signals predict wins, and re-weights them. No retraining
 * infrastructure, no DB, no gating; features without demonstrated lift earn
 * exactly zero.
 */

import type { QuantumFeatures } from "./quantum-analysis";

export type SignalMode = "normal" | "recovery";

/** Decision-time feature vector captured when a trade is taken. */
export interface DecisionFeatures {
  /** z — significance of the edge vs break-even */
  z: number;
  /** λ — structure confidence */
  lambda: number;
  /** probabilistic entry timing score (0–100) */
  timing: number;
  /** market-specific streak hazard position (break prob / baseline) */
  hazardRelative: number;
  /** entropy onset ΔH */
  entropyDelta: number;
  /** shared CI overlap width across analysis windows (0 for single-window) */
  ciOverlap: number;
}

interface TradeSignalRecord {
  features: DecisionFeatures;
  won: boolean;
  at: number;
}

const pools: Record<SignalMode, TradeSignalRecord[]> = { normal: [], recovery: [] };
const MAX_PER_POOL = 60;
const MIN_POOL_SIZE = 12;
const MIN_TERCILE_SIZE = 4;
const MIN_LIFT = 0.10; // win-rate difference required to value a feature

type FeatureKey = keyof DecisionFeatures;
const FEATURE_KEYS: FeatureKey[] = ["z", "lambda", "timing", "hazardRelative", "entropyDelta", "ciOverlap"];

export function resetSignalValue(): void {
  pools.normal = [];
  pools.recovery = [];
}

export function recordTradeSignal(mode: SignalMode, features: DecisionFeatures, won: boolean): void {
  pools[mode] = [...pools[mode], { features, won, at: Date.now() }].slice(-MAX_PER_POOL);
}

export function signalPoolSize(mode: SignalMode): number {
  return pools[mode].length;
}

interface ValuedSignal {
  key: FeatureKey;
  /** candidate values ≥ this earn the bonus */
  topCutoff: number;
  /** candidate values ≤ this earn the penalty */
  bottomCutoff: number;
  /** realized win-rate lift (top − bottom tercile) */
  lift: number;
  n: number;
}

/**
 * Which of the engine's own features have demonstrated predictive power in
 * this mode so far? Recomputed on demand (≤60 records × 6 features — cheap).
 */
export function valuedSignals(mode: SignalMode): ValuedSignal[] {
  const pool = pools[mode];
  if (pool.length < MIN_POOL_SIZE) return [];
  const out: ValuedSignal[] = [];
  for (const key of FEATURE_KEYS) {
    const sorted = [...pool].sort((a, b) => a.features[key] - b.features[key]);
    const third = Math.floor(sorted.length / 3);
    if (third < MIN_TERCILE_SIZE) continue;
    const bottom = sorted.slice(0, third);
    const top = sorted.slice(-third);
    const winRate = (r: TradeSignalRecord[]) => r.filter(t => t.won).length / r.length;
    const lift = winRate(top) - winRate(bottom);
    if (lift < MIN_LIFT) continue;
    out.push({
      key,
      topCutoff: top[0]!.features[key],
      bottomCutoff: bottom[bottom.length - 1]!.features[key],
      lift,
      n: pool.length,
    });
  }
  return out;
}

/**
 * Bounded meta-bonus (±6) for a candidate based on the features that have
 * actually predicted wins in this mode so far. Zero when the pool is too
 * small or no feature has demonstrated lift — it can only ever reflect
 * evidence, never speculation.
 */
export function metaBonus(features: DecisionFeatures, mode: SignalMode): number {
  let bonus = 0;
  for (const sig of valuedSignals(mode)) {
    const v = features[sig.key];
    if (v >= sig.topCutoff) bonus += 2;
    else if (v <= sig.bottomCutoff) bonus -= 2;
  }
  return Math.max(-6, Math.min(6, bonus));
}
