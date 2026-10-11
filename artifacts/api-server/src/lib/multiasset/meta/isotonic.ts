/**
 * WP5 — isotonic calibration by pool-adjacent-violators.
 *
 * ── WHAT IT FIXES ───────────────────────────────────────────────────────────
 *
 * A logistic fit is monotone in its features by construction but NOT in
 * probability: nothing in the likelihood forces the predicted probability to
 * match the realised frequency. The WP2 baseline measured exactly that failure
 * in the v3 desk — a stated 50% that realised 85%, slope −0.24 — and a
 * mis-calibrated probability is worse than no probability at all, because the
 * sizing and the EV gate both multiply by it.
 *
 * Isotonic regression is the minimal repair: it finds the non-decreasing step
 * function of the predicted probability that best fits the observed outcomes
 * (weighted least squares), which is the strongest assumption one can justify —
 * "bigger predictions mean bigger frequencies, nothing more" — and it cannot
 * invert an ordering, so it can never make a confident setup look worse than a
 * marginal one.
 *
 * ── WHY PER REGIME, AND WHY A SAMPLE FLOOR ──────────────────────────────────
 *
 * The reliability of the same prediction is not the same in a trend and in a
 * range: the desk's whole v4 premise is that context changes the meaning of a
 * signal. So the calibrator is fitted per regime when a regime has enough
 * samples, and falls back to the pooled map when it does not — the floor is
 * `MIN_CALIBRATION_SAMPLES = 200`, which is the brief's number and is also
 * about the smallest sample on which a step function with a handful of blocks
 * is meaningfully constrained. A regime below the floor uses the pooled map,
 * and the report says which map was used for every decision.
 */
import { wilsonInterval } from "../alpha/edge";
import { effectiveSampleSize } from "./pcb";

/** The sample floor below which a per-regime calibrator is not fitted. */
export const MIN_CALIBRATION_SAMPLES = 200;

/**
 * The smallest weight a single step of the map may rest on.
 *
 * PAV is a step function fitted to whatever it is given, and its extremes are
 * where it is thinnest: one observation above everything else becomes a step at
 * 100%, and the next decision whose raw score lands just under it is told the
 * trade cannot lose. That is not a calibration, it is a memory. Every step must
 * therefore rest on at least this much evidence, and steps that do not are pooled
 * into their neighbour before the map is used — a regularisation that only ever
 * moves the map toward its own average, which is the direction that keeps the
 * gatekeeper honest.
 *
 * 20 is the floor below which a probability estimate carries no information worth
 * acting on (a Wilson interval on 20 observations is ±20 points wide), and it
 * composes with `MIN_CALIBRATION_SAMPLES`: a map needs ≥ 200 observations to be
 * fitted at all, and each of its steps needs ≥ 20 to stand alone.
 */
export const MIN_ISOTONIC_BLOCK_WEIGHT = 20;

export interface IsotonicPoint {
  /** Raw probability at the block. */
  x: number;
  /** Calibrated probability for predictions at or below `x`. */
  y: number;
  /** Weight of the block. */
  w: number;
}

export interface IsotonicMap {
  /** Block breakpoints, ascending in `x`, non-decreasing in `y`. */
  points: IsotonicPoint[];
  /** Number of samples the map was fitted on (weight sum). */
  samples: number;
  /** Effective sample size (Kish) of those samples. */
  effectiveSampleSize: number;
  /** The base rate, returned for empty maps. */
  baseRate: number;
  /** Smallest step weight in the map — how thin its thinnest step is. */
  minBlockWeight: number;
  /** Steps that were pooled into a neighbour for resting on too little. */
  pooledThinBlocks: number;
  /**
   * A two-parameter logistic recalibration instead of a step function:
   * `logit(p) = a + b · logit(p_raw)`. Present only on maps built by the study's
   * Platt option (`research/meta-eval.ts`), and it is recorded in the report so
   * the reader always knows which kind of map produced a number.
   */
  platt?: { a: number; b: number };
}

/** The identity calibrator: used when there is nothing to calibrate with. */
export function identityMap(baseRate = 0.5): IsotonicMap {
  return { points: [], samples: 0, effectiveSampleSize: 0, baseRate, minBlockWeight: 0, pooledThinBlocks: 0 };
}

/**
 * Fit with PAV.
 *
 * Pooling only merges blocks that violate monotonicity, so a set of
 * already-ordered frequencies is returned unchanged — the map does nothing when
 * there is nothing to fix, which is the property that makes it safe to run on
 * every fold.
 */
export function fitIsotonic(input: {
  /** Raw predictions. */
  p: number[];
  /** Outcomes, one per prediction. */
  y: boolean[];
  /** Sample weights (uniqueness × recency). */
  weights?: number[];
  /** Smallest step weight before a step is pooled into its neighbour. */
  minBlockWeight?: number;
}): IsotonicMap {
  const minBlockWeight = input.minBlockWeight ?? MIN_ISOTONIC_BLOCK_WEIGHT;
  const { p, y } = input;
  const w = input.weights ?? p.map(() => 1);
  if (p.length === 0) return identityMap();
  let weightSum = 0;
  let positives = 0;
  for (let i = 0; i < p.length; i++) {
    weightSum += w[i] as number;
    if (y[i]) positives += w[i] as number;
  }
  const baseRate = weightSum > 0 ? positives / weightSum : 0.5;

  const order = p.map((_, i) => i).sort((a, b) => (p[a] as number) - (p[b] as number));
  const blocks: { x: number; sum: number; weight: number; count: number }[] = [];
  for (const index of order) {
    const weight = w[index] as number;
    blocks.push({
      x: p[index] as number,
      sum: (y[index] ? 1 : 0) * weight,
      weight,
      count: 1,
    });
    // Merge while the last two blocks are out of order.
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1] as { x: number; sum: number; weight: number; count: number };
      const prev = blocks[blocks.length - 2] as { x: number; sum: number; weight: number; count: number };
      const lastMean = last.weight > 0 ? last.sum / last.weight : 0;
      const prevMean = prev.weight > 0 ? prev.sum / prev.weight : 0;
      if (prevMean <= lastMean + 1e-15) break;
      blocks.splice(blocks.length - 2, 2, {
        x: last.x, // the block's right edge keeps ascending
        sum: prev.sum + last.sum,
        weight: prev.weight + last.weight,
        count: prev.count + last.count,
      });
    }
  }
  // ── Regularise: no step may rest on fewer than `minBlockWeight` observations
  //
  // Two passes, both one-directional (they only ever pool evidence, never split
  // it):
  //
  //   1. Equal-x pooling. Two observations with the identical raw score must
  //      carry the identical calibrated probability, or the "map" is not a
  //      function of its input. PAV leaves them as separate blocks.
  //   2. Thin-step pooling. A step below the weight floor is merged into the
  //      neighbour whose mean is closer, and any monotonicity violation the merge
  //      creates is repaired by another merge. This repeats until stable.
  const pooled = poolEqualX(blocks);
  const { blocks: thinned, pooledThin } = poolThinBlocks(pooled, minBlockWeight);

  const points: IsotonicPoint[] = thinned.map((block) => ({
    x: block.x,
    y: block.weight > 0 ? block.sum / block.weight : baseRate,
    w: block.weight,
  }));
  // The effective size is a property of the SAMPLE, not of the map: it is the
  // number of independent observations the whole calibration rests on (Kish),
  // which is the number a confidence bound has to be built from.
  let sumSq = 0;
  for (let i = 0; i < p.length; i++) sumSq += (w[i] as number) ** 2;
  const effectiveSampleSize = sumSq > 0 ? (weightSum * weightSum) / sumSq : 0;
  const minStep = points.reduce((smallest, point) => Math.min(smallest, point.w), Number.POSITIVE_INFINITY);
  return {
    points,
    samples: weightSum,
    effectiveSampleSize,
    baseRate,
    minBlockWeight: points.length > 0 ? minStep : 0,
    pooledThinBlocks: pooledThin,
  };
}

type PavaBlock = { x: number; sum: number; weight: number; count: number };

/** Pool blocks with the same x: a step function cannot take two values at one x. */
function poolEqualX(blocks: PavaBlock[]): PavaBlock[] {
  const out: PavaBlock[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - block.x) <= 1e-12) {
      last.sum += block.sum;
      last.weight += block.weight;
      last.count += block.count;
      continue;
    }
    out.push({ ...block });
  }
  return out;
}

/** Merge steps below the floor, then repair monotonicity until stable. */
function poolThinBlocks(blocks: PavaBlock[], minWeight: number): { blocks: PavaBlock[]; pooledThin: number } {
  let current = blocks.map((block) => ({ ...block }));
  let pooledThin = 0;
  let guard = 0;
  while (current.length > 1 && guard++ < 10_000) {
    const thinIndex = current.findIndex((block) => block.weight < minWeight);
    if (thinIndex >= 0) {
      const previous = thinIndex > 0 ? (current[thinIndex - 1] as PavaBlock) : null;
      const next = thinIndex < current.length - 1 ? (current[thinIndex + 1] as PavaBlock) : null;
      const thin = current[thinIndex] as PavaBlock;
      const thinMean = meanOf(thin);
      const target =
        previous && next
          ? Math.abs(meanOf(previous) - thinMean) <= Math.abs(meanOf(next) - thinMean)
            ? thinIndex - 1
            : thinIndex + 1
          : previous
            ? thinIndex - 1
            : thinIndex + 1;
      current = mergeAt(current, thinIndex, target);
      pooledThin++;
      continue;
    }
    // Monotonicity repair: merge any adjacent pair that decreases.
    let violation = -1;
    for (let i = 0; i + 1 < current.length; i++) {
      if (meanOf(current[i] as PavaBlock) > meanOf(current[i + 1] as PavaBlock) + 1e-15) {
        violation = i;
        break;
      }
    }
    if (violation < 0) break;
    current = mergeAt(current, violation, violation + 1);
  }
  return { blocks: current, pooledThin };
}

function mergeAt(blocks: PavaBlock[], a: number, b: number): PavaBlock[] {
  const first = blocks[Math.min(a, b)] as PavaBlock;
  const second = blocks[Math.max(a, b)] as PavaBlock;
  const merged: PavaBlock = {
    // The right edge keeps the map ascending in x.
    x: second.x,
    sum: first.sum + second.sum,
    weight: first.weight + second.weight,
    count: first.count + second.count,
  };
  const out = [...blocks];
  out.splice(Math.min(a, b), 2, merged);
  return out;
}

function meanOf(block: PavaBlock): number {
  return block.weight > 0 ? block.sum / block.weight : 0;
}

/** The calibrated probability for a raw prediction (step lookup). */
export function applyIsotonic(map: IsotonicMap, p: number): number {
  if (map.points.length === 0) return map.baseRate;
  // The first block whose right edge is at or above p. Points are ascending in x.
  let low = 0;
  let high = map.points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((map.points[mid] as IsotonicPoint).x < p) low = mid + 1;
    else high = mid;
  }
  const point = map.points[low] as IsotonicPoint;
  return Math.max(0, Math.min(1, point.y));
}

/**
 * Apply a calibrator of either shipped kind.
 *
 * The map carries both possibilities — a PAV step function, or the two-parameter
 * Platt recalibration the WP5 study selected on the measured slopes — and every
 * consumer must resolve it the same way. `applyIsotonic` alone ignores `platt`,
 * so calling it on a Platt map would silently return the base rate; this function
 * is the one entry point, and the live model and the report use it.
 */
export function applyCalibrator(map: IsotonicMap, pRaw: number): number {
  const platt = map.platt;
  if (platt) {
    const clipped = Math.min(1 - 1e-9, Math.max(1e-9, pRaw));
    const z = platt.a + platt.b * Math.log(clipped / (1 - clipped));
    if (z >= 0) return 1 / (1 + Math.exp(-z));
    const e = Math.exp(z);
    return e / (1 + e);
  }
  return applyIsotonic(map, pRaw);
}

/**
 * Fit per regime, falling back to the pooled map below the floor.
 *
 * `keyOf` maps a row to its regime label; rows without one use the pooled map.
 */
export function fitCohortCalibrators(input: {
  p: number[];
  y: boolean[];
  keys: (string | null)[];
  weights?: number[];
  minSamples?: number;
}): { pooled: IsotonicMap; byKey: Record<string, IsotonicMap>; skipped: string[] } {
  const minSamples = input.minSamples ?? MIN_CALIBRATION_SAMPLES;
  const pooled = fitIsotonic({ p: input.p, y: input.y, ...(input.weights ? { weights: input.weights } : {}) });
  const groups = new Map<string, number[]>();
  input.keys.forEach((key, i) => {
    if (!key) return;
    const list = groups.get(key) ?? [];
    list.push(i);
    groups.set(key, list);
  });
  const byKey: Record<string, IsotonicMap> = {};
  const skipped: string[] = [];
  for (const [key, indices] of groups) {
    const weightSum = indices.reduce((a, i) => a + (input.weights?.[i] ?? 1), 0);
    if (weightSum < minSamples || indices.length < minSamples) {
      skipped.push(key);
      continue;
    }
    byKey[key] = fitIsotonic({
      p: indices.map((i) => input.p[i] as number),
      y: indices.map((i) => input.y[i] as boolean),
      ...(input.weights ? { weights: indices.map((i) => input.weights?.[i] ?? 1) } : {}),
    });
  }
  return { pooled, byKey, skipped };
}

/**
 * Calibration slope and offset from a reliability regression.
 *
 * `logit(P(y = 1)) = a + b · logit(p̂)` — the standard logistic recalibration,
 * which is what the rollout criteria call "calibration slope ∈ [0.8, 1.2]":
 * b = 1 means the model's confidence means what it says, b < 1 means it is
 * overconfident.
 *
 * ── WHY NOT A LINE THROUGH THE OUTCOMES ─────────────────────────────────────
 *
 * Regressing the 0/1 outcome directly on the logit produces a slope in units of
 * *probability per logit*, and such a slope is not a calibration measurement: a
 * perfectly calibrated model forecasting 5–60% outcomes lands near 0.1, and an
 * overconfident one can land at the same number. The two-parameter logistic fit
 * below is the quantity that has the b = 1 / b < 1 reading, and it is fitted with
 * the same uniqueness weights the model was fitted under, by Newton–Raphson from
 * the perfectly-calibrated starting point (a, b) = (0, 1).
 *
 * `identifiable` is false when the predictions barely move in logit space (or
 * when the fit is singular or diverges): a slope fitted to outputs spanning 0.3
 * logits is not a measurement, and returning one anyway is exactly the
 * overclaiming this file exists to prevent.
 */
export function reliability(
  predictions: number[],
  y: boolean[],
  weights?: number[],
): {
  slope: number | null;
  intercept: number | null;
  identifiable: boolean;
  reason: string;
  /** Weighted effective sample size the slope rests on. */
  effectiveSampleSize: number;
  iterations: number;
} {
  const w = weights ?? predictions.map(() => 1);
  const n = predictions.length;
  const ess = effectiveSampleSize(w);
  if (n < 20) {
    return { slope: null, intercept: null, identifiable: false, reason: `only ${n} predictions`, effectiveSampleSize: ess, iterations: 0 };
  }
  const logits = predictions.map((p) => logitOf(p));
  const min = Math.min(...logits);
  const max = Math.max(...logits);
  if (!(max - min > 0.1)) {
    return {
      slope: null,
      intercept: null,
      identifiable: false,
      reason: `predictions span only ${(max - min).toFixed(3)} logits — a slope fitted to that is not a measurement`,
      effectiveSampleSize: ess,
      iterations: 0,
    };
  }

  let a = 0;
  let b = 1;
  let iterations = 0;
  for (; iterations < 50; iterations++) {
    let g0 = 0;
    let g1 = 0;
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;
    for (let i = 0; i < n; i++) {
      const weight = w[i] as number;
      const x = logits[i] as number;
      const p = sigmoidStable(a + b * x);
      const residual = ((y[i] as boolean) ? 1 : 0) - p;
      g0 += weight * residual;
      g1 += weight * residual * x;
      const v = weight * p * (1 - p);
      h00 += v;
      h01 += v * x;
      h11 += v * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) {
      return { slope: null, intercept: null, identifiable: false, reason: "singular calibration fit", effectiveSampleSize: ess, iterations };
    }
    // Newton step. The log-likelihood's Hessian is negative definite here, so the
    // update adds H⁻¹g with (g0, g1) the score in (a, b).
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a += da;
    b += db;
    if (Math.abs(da) < 1e-9 && Math.abs(db) < 1e-9) break;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { slope: null, intercept: null, identifiable: false, reason: "calibration fit diverged", effectiveSampleSize: ess, iterations };
  }
  return { slope: b, intercept: a, identifiable: true, reason: "ok", effectiveSampleSize: ess, iterations };
}

function logitOf(p: number): number {
  const clipped = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(clipped / (1 - clipped));
}

function sigmoidStable(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Wilson interval for a realised frequency, re-exported for report symmetry. */
export { wilsonInterval };
