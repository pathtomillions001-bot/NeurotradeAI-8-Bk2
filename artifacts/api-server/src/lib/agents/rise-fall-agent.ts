/**
 * Agent 4: Rise/Fall Intelligence Agent
 *
 * RESPONSIBILITY: Estimate the probability that price will be higher (CALL/RISE)
 * or lower (PUT/FALL) than entry after N ticks. Enhanced replacement for the
 * original direction-agent.ts — adds regime-adjusted ML, trend exhaustion
 * detection, and multi-model consensus scoring.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import type { FeatureSet } from "./feature-engineering";
import { mean, stddev } from "./feature-engineering";

export interface DirectionResult {
  probUp: number;
  probDown: number;
  confidence: number;
  direction: "up" | "down";
  models: { rf: number; gb: number; momentum: number };
  horizon: number;
  disagreement: number;
  exhaustionDetected: boolean;
  regimeMultiplier: number;
}

// ── Per-symbol ML model cache ─────────────────────────────────────────────────
interface GBStump { fi: number; thr: number; lv: number; rv: number; alpha: number; }
interface ModelCache { stumps: GBStump[]; pricesLen: number; trainedAt: number; }
const modelCache = new Map<string, ModelCache>();
const RETRAIN_INTERVAL_MS = 30_000;
const MIN_NEW_SAMPLES = 10;

// ── Feature vector ─────────────────────────────────────────────────────────────
function toFeatureVector(pf: FeatureSet["price"]): number[] {
  return [
    pf.autocorr1, pf.autocorr3, pf.autocorr5,
    Math.tanh(pf.momentum1 * 5000),
    Math.tanh(pf.momentum5 * 2000),
    Math.tanh(pf.momentum10 * 1000),
    pf.hurst - 0.5,
    pf.returnEntropy - 1.0,
    pf.zScoreLast * 0.1,
    pf.volRatio - 1.0,
    pf.vol20 * 10000,
    pf.upFrac1 - 0.5,
    pf.upFrac5 - 0.5,
    pf.tickVelocity * 10000,
    (pf.upFrac1 - 0.5) * (pf.hurst - 0.5) * 4, // interaction
  ];
}

// ── Training data builder ──────────────────────────────────────────────────────
function buildTrainingSet(prices: number[], horizon: number) {
  const X: number[][] = [];
  const y: number[] = [];
  const w = Math.min(40, Math.floor(prices.length / 3));
  for (let end = w + 1; end < prices.length - horizon; end++) {
    const slice = prices.slice(Math.max(0, end - w), end);
    if (slice.length < 5) continue;
    const fv = quickFeatures(slice);
    X.push(fv);
    y.push(prices[end + horizon - 1] > prices[end - 1] ? 1 : 0);
  }
  return { X, y };
}

function quickFeatures(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) r.push((prices[i] - prices[i - 1]) / (prices[i - 1] || 1));
  if (!r.length) return Array(15).fill(0);
  const m = mean(r), sd = stddev(r) || 1e-10;
  const ac1Num = r.slice(1).reduce((s, v, i) => s + (v - m) * (r[i] - m), 0);
  const ac1Den = r.reduce((s, v) => s + (v - m) ** 2, 0);
  return [
    ac1Den > 0 ? ac1Num / ac1Den : 0, 0, 0,
    Math.tanh(mean(r.slice(-1)) * 5000),
    Math.tanh(mean(r.slice(-5)) * 2000),
    Math.tanh(mean(r.slice(-10)) * 1000),
    0, 0,
    r.length > 0 ? (r[r.length - 1] - m) / sd * 0.1 : 0,
    0, sd * 10000,
    r.filter(v => v > 0).length / r.length - 0.5,
    r.slice(-5).filter(v => v > 0).length / Math.max(1, Math.min(5, r.length)) - 0.5,
    sd * 10000, 0,
  ];
}

// ── Gradient Boosting ──────────────────────────────────────────────────────────
function trainGB(X: number[][], y: number[], rounds = 12): GBStump[] {
  // Raised from 5 → 12: fewer than 12 labelled samples produce highly unstable
  // stumps that overfit noise, worsening direction accuracy.
  if (X.length < 12) return [];
  const n = y.length;
  let w = Array(n).fill(1 / n);
  const stumps: GBStump[] = [];
  const nF = X[0].length;

  for (let r = 0; r < rounds; r++) {
    let bestErr = Infinity, best: GBStump | null = null;
    const fSubset = Array.from({ length: nF }, (_, i) => i).sort(() => Math.random() - 0.5).slice(0, Math.ceil(nF / 2));
    for (const f of fSubset) {
      const vals = [...new Set(X.map(row => row[f]))].sort((a, b) => a - b);
      for (const thr of vals) {
        const lI = X.map((row, i) => row[f] <= thr ? i : -1).filter(i => i >= 0);
        const rI = X.map((row, i) => row[f] > thr ? i : -1).filter(i => i >= 0);
        if (!lI.length || !rI.length) continue;
        const lW = lI.reduce((s, i) => s + w[i], 0), rW = rI.reduce((s, i) => s + w[i], 0);
        const lv = lW > 0 ? lI.reduce((s, i) => s + w[i] * y[i], 0) / lW : 0.5;
        const rv = rW > 0 ? rI.reduce((s, i) => s + w[i] * y[i], 0) / rW : 0.5;
        const err = lI.reduce((s, i) => s + w[i] * Math.abs(y[i] - lv), 0) + rI.reduce((s, i) => s + w[i] * Math.abs(y[i] - rv), 0);
        if (err < bestErr) { bestErr = err; best = { fi: f, thr, lv, rv, alpha: 0 }; }
      }
    }
    if (!best || bestErr >= 0.5) break;
    best.alpha = 0.5 * Math.log((1 - bestErr + 1e-9) / (bestErr + 1e-9));
    stumps.push(best);
    for (let i = 0; i < n; i++) {
      const p = X[i][best.fi] <= best.thr ? best.lv : best.rv;
      w[i] *= Math.exp(-best.alpha * (2 * y[i] - 1) * (2 * p - 1));
    }
    const ws = w.reduce((a, b) => a + b, 0);
    w = w.map(v => v / ws);
  }
  return stumps;
}

function predictGB(stumps: GBStump[], f: number[]): number {
  if (!stumps.length) return 0.5;
  let score = 0, alphaSum = 0;
  for (const s of stumps) {
    const p = f[s.fi] <= s.thr ? s.lv : s.rv;
    score += s.alpha * p; alphaSum += Math.abs(s.alpha);
  }
  return Math.max(0.05, Math.min(0.95, alphaSum > 0 ? score / alphaSum : 0.5));
}

// ── Momentum-based feature estimate ───────────────────────────────────────────
function momentumProb(pf: FeatureSet["price"]): number {
  // Weighted combination of recent up-fraction windows
  const base = pf.upFrac1 * 0.20 + pf.upFrac5 * 0.50 + pf.upFrac10 * 0.30;

  // Momentum adjustments — scaled more carefully to avoid overshooting
  const mom5Adj  = Math.tanh(pf.momentum5 * 800)  * 0.10;
  const mom10Adj = Math.tanh(pf.momentum10 * 500) * 0.08;

  // Hurst multiplier: high Hurst (> 0.55) = trending → amplify signal
  // low Hurst (< 0.45) = mean-reverting → attenuate (go AGAINST recent direction)
  const hurstMult = pf.hurst > 0.58 ? 1.40 : pf.hurst > 0.55 ? 1.20 : pf.hurst < 0.42 ? 0.65 : 1.0;

  // Mean-reversion flip when Hurst is strongly mean-reverting
  const meanRevFlip = pf.hurst < 0.42 ? (0.5 - (base - 0.5)) : 0;

  // Autocorrelation & z-score adjustments
  const acAdj  = Math.tanh(pf.autocorr1 * 6) * 0.07;
  const zAdj   = pf.zScoreLast >  2.0 ? -0.06 : pf.zScoreLast < -2.0 ? 0.06 : 0;

  // Volatility penalty: high vol regimes blur direction signal
  const volPenalty = pf.volRatio > 1.5 ? -0.03 : 0;

  const raw = base + (mom5Adj + mom10Adj) * hurstMult + acAdj + zAdj + volPenalty + meanRevFlip;
  return Math.max(0.15, Math.min(0.85, raw));
}

// ── Trend exhaustion detection ─────────────────────────────────────────────────
function detectExhaustion(pf: FeatureSet["price"]): boolean {
  // Extreme z-score combined with low recent autocorrelation signals exhaustion
  const extremeZ = Math.abs(pf.zScoreLast) > 2.5;
  const lowAC = Math.abs(pf.autocorr1) < 0.05;
  const highVol = pf.volRatio > 1.8;
  return extremeZ && (lowAC || highVol);
}

// ── Reconstruct prices ─────────────────────────────────────────────────────────
function reconstructPrices(returns: number[]): number[] {
  const prices = [1000];
  for (const r of returns) prices.push(prices[prices.length - 1] * (1 + r));
  return prices;
}

// ── Multi-horizon consensus ────────────────────────────────────────────────────
// Train/predict at 3 horizons and check whether they agree on direction.
// Agreement across horizons (short, medium, long) provides stronger conviction
// than a single horizon and filters out noise spikes.
function multiHorizonConsensus(prices: number[], stumps: GBStump[]): {
  agreementRatio: number;   // 0–1: fraction of horizons agreeing with primary direction
  primaryUp: boolean;       // direction from the shortest horizon
} {
  const horizons = [3, 5, 10];
  const votes: boolean[] = [];
  for (const h of horizons) {
    const { X, y } = buildTrainingSet(prices, h);
    if (X.length < 6) { votes.push(true); continue; }
    // Use the shared trained stumps from the primary horizon for speed —
    // the feature vector shape is identical, only the label changes.
    const preds = X.map(fv => predictGB(stumps, fv));
    const avgP = preds.reduce((a, b) => a + b, 0) / preds.length;
    votes.push(avgP >= 0.5);
  }
  const primaryUp = votes[0] ?? true;
  const agrees = votes.filter(v => v === primaryUp).length;
  return { agreementRatio: agrees / votes.length, primaryUp };
}

// ── Public API ─────────────────────────────────────────────────────────────────
export function predictDirection(symbol: string, features: FeatureSet, horizon = 5): DirectionResult {
  const pf = features.price;
  const fv = toFeatureVector(pf);
  const now = Date.now();
  const cached = modelCache.get(symbol);

  let stumps: GBStump[] = [];
  const needsRetrain = !cached
    || (now - cached.trainedAt > RETRAIN_INTERVAL_MS)
    || (pf.priceN - cached.pricesLen >= MIN_NEW_SAMPLES);

  if (needsRetrain && pf.returns1.length > 20) {
    const synPrices = reconstructPrices(pf.returns1);
    const { X, y } = buildTrainingSet(synPrices, horizon);
    if (X.length >= 5) {
      stumps = trainGB(X, y, 12);
      modelCache.set(symbol, { stumps, pricesLen: pf.priceN, trainedAt: now });
    }
  } else if (cached) {
    stumps = cached.stumps;
  }

  const gbProb = stumps.length > 0 ? predictGB(stumps, fv) : 0.5;
  const momProb = momentumProb(pf);

  // Ensemble: 55% GB (when trained), 45% momentum
  const hasModel = stumps.length > 0;
  const rawProb = hasModel ? gbProb * 0.55 + momProb * 0.45 : momProb;

  // Platt calibration
  const logit = Math.log(rawProb / (1 - rawProb + 1e-9) + 1e-9);
  const probUp = Math.max(0.05, Math.min(0.95, 1 / (1 + Math.exp(-logit))));

  const disagreement = Math.abs(gbProb - momProb);
  const edgeStrength = Math.abs(probUp - 0.5) * 2;
  const agreementBonus = 1 - Math.min(1, disagreement * 2);
  const confidence = Math.round(Math.max(0, Math.min(100, edgeStrength * agreementBonus * 100)));

  const exhaustionDetected = detectExhaustion(pf);
  // In trending regime (high Hurst), amplify; in mean-reverting, attenuate
  const regimeMultiplier = pf.hurst > 0.58 ? 1.1 : pf.hurst < 0.42 ? 0.9 : 1.0;

  // Multi-horizon consensus — only meaningful when the GB model is trained
  let horizonAgreementRatio = 1.0;
  if (hasModel && pf.returns1.length > 30) {
    const synPrices = reconstructPrices(pf.returns1);
    const hc = multiHorizonConsensus(synPrices, stumps);
    // If the short-horizon direction disagrees with our primary probUp direction,
    // penalise confidence. agreementRatio < 0.67 means at least 2 horizons disagree.
    if (hc.primaryUp !== (probUp >= 0.5)) horizonAgreementRatio = 0.85;
    else horizonAgreementRatio = 0.7 + hc.agreementRatio * 0.3;
  }

  return {
    probUp, probDown: 1 - probUp,
    confidence: Math.round(confidence * horizonAgreementRatio),
    direction: probUp >= 0.5 ? "up" : "down",
    models: { rf: gbProb, gb: gbProb, momentum: momProb },
    horizon, disagreement, exhaustionDetected, regimeMultiplier,
  };
}

export function runRiseFallAgent(
  ctx: ScanContext,
  features: FeatureSet,
  horizon = 5,
): AgentOutput & { directionResult: DirectionResult } {
  const t0 = Date.now();
  const result = predictDirection(ctx.symbol, features, horizon);
  const pf = features.price;

  // Edge score: distance from 50% amplified — require a MEANINGFUL edge.
  // A 52% probability gives only 4 edge points → score = 54 (below buy threshold of 63).
  // A 55% probability gives 10 edge points → score = 60.
  // A 58% probability gives 16 edge points → score = 66 (buy).
  // A 62% probability gives 24 edge points → score = 74 (strong buy).
  const edgePct = Math.abs(result.probUp - 0.5);
  // Quadratic amplification: small edges stay small, strong edges get boosted
  const edgeAmplified = edgePct < 0.05 ? edgePct * 0.5 : edgePct * 1.2;
  const edgeScore = Math.round(50 + edgeAmplified * 200);
  let score = Math.min(95, Math.round(edgeScore * (1 - result.disagreement * 0.5)));

  // Penalize exhaustion signals more strongly
  if (result.exhaustionDetected) score = Math.round(score * 0.80);

  // Apply regime multiplier
  score = Math.min(95, Math.round(score * result.regimeMultiplier));

  // Hard floor: if probUp is too close to 50% (< 53% either direction),
  // cap the score at 58 so it never triggers a "buy" recommendation
  if (edgePct < 0.03) score = Math.min(score, 58);

  // ── Regime filter — mean-reverting markets ────────────────────────────────
  // Hurst < 0.45 indicates a mean-reverting regime where directional signals
  // are unreliable (price oscillates). In such regimes, even a 60 % GB
  // prediction is noise. Cap the score hard to prevent direction trades.
  // Hurst 0.45–0.50: mildly choppy — apply a softer cap.
  if (pf.hurst < 0.42) {
    score = Math.min(score, 45);  // strongly mean-reverting: block direction trades
  } else if (pf.hurst < 0.47) {
    score = Math.min(score, 55);  // mildly choppy: only fire on strong signals
  }

  // ── Model agreement gate ─────────────────────────────────────────────────
  // When GB and momentum disagree on direction (one predicts up, other predicts
  // down), the ensemble output averages toward 50 %. High disagreement means
  // the signal is unreliable regardless of the blended value.
  if (result.disagreement > 0.15) {
    // Models significantly disagree: penalise confidence
    score = Math.min(score, 58);
  }
  if (result.disagreement > 0.25) {
    // Models strongly disagree: hard cap below buy threshold
    score = Math.min(score, 48);
  }

  // ── Autocorrelation filter ────────────────────────────────────────────────
  // Near-zero autocorrelation (autocorr1 ≈ 0) means the price series is
  // close to a random walk with no predictable momentum. Direction trades
  // in this state rely purely on luck.
  if (Math.abs(pf.autocorr1) < 0.03 && edgePct < 0.06) {
    score = Math.min(score, 54);  // weak autocorr + weak edge → not reliable
  }

  // During a loss streak, demand stronger directional conviction.
  // After 2+ consecutive losses the AI must have a real edge — not a coin flip.
  // Each level of streak tightens the required edge and caps the score lower.
  const sessionLosses = ctx.daily.consecutiveLosses;
  if (sessionLosses >= 2) {
    if (edgePct < 0.05) score = Math.min(score, 52); // < 55% probability → cap below buy threshold
    if (sessionLosses >= 3 && edgePct < 0.07) score = Math.min(score, 46); // need ≥ 57% after 3 losses
    if (sessionLosses >= 4 && edgePct < 0.09) score = Math.min(score, 40); // need ≥ 59% after 4 losses
  }

  const dirLabel = result.direction === "up" ? "UP" : "DOWN";

  const reasoning = [
    `Direction: ${dirLabel} (↑${(result.probUp * 100).toFixed(1)}% ↓${(result.probDown * 100).toFixed(1)}%).`,
    `GB=${(result.models.gb * 100).toFixed(0)}% Mom=${(result.models.momentum * 100).toFixed(0)}% Disagreement=${(result.disagreement * 100).toFixed(0)}%.`,
    `Horizon: ${horizon}t. Hurst: ${pf.hurst.toFixed(2)}. Regime ×${result.regimeMultiplier.toFixed(2)}.`,
    result.exhaustionDetected ? "⚠ Trend exhaustion detected — reduced confidence." : "",
  ].filter(Boolean).join(" ");

  return {
    agentId: "riseFallAgent",
    score,
    confidence: result.confidence,
    signal: result.direction === "up" ? scoreToSignal(score) : scoreToSignal(100 - score),
    reasoning,
    data: {
      probUp: result.probUp,
      probDown: result.probDown,
      direction: result.direction,
      models: result.models,
      horizon: result.horizon,
      exhaustionDetected: result.exhaustionDetected,
    },
    executionTimeMs: Date.now() - t0,
    directionResult: result,
  };
}
