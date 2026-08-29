/**
 * ML Trading Engine — ensemble models for Deriv synthetics
 *
 * Models (no EMA/RSI — crowd indicators avoided):
 *  - Random Forest classifier (direction: up/down)
 *  - Gradient Boosting stumps (direction confidence)
 *  - Logistic regression (regime probability)
 *  - Markov chain + multinomial model (digit 0-9 prediction)
 *  - Chi-square deviation detector (digit distribution edge)
 *
 * Adaptive tick windows selected per market via cross-validation proxy.
 */

import { OVER_PAYOUTS, UNDER_PAYOUTS } from "./payouts";

// ── Math utilities ────────────────────────────────────────────────────────────
function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function stddev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length || 1));
}
function shannonEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  let h = 0;
  for (const c of counts) {
    if (c > 0) { const p = c / total; h -= p * Math.log2(p); }
  }
  return h;
}
function autocorr(arr: number[], lag: number): number {
  if (arr.length <= lag) return 0;
  const m = mean(arr);
  let num = 0, den = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    den += d * d;
    if (i >= lag) num += (arr[i] - m) * (arr[i - lag] - m);
  }
  return den > 0 ? num / den : 0;
}
function hurstApprox(returns: number[]): number {
  if (returns.length < 20) return 0.5;
  const n = returns.length;
  const meanR = mean(returns);
  let cum = 0, maxC = -Infinity, minC = Infinity;
  const devs: number[] = [];
  for (const r of returns) { cum += r - meanR; devs.push(cum); maxC = Math.max(maxC, cum); minC = Math.min(minC, cum); }
  const R = maxC - minC;
  const S = stddev(returns) || 1e-10;
  const rs = R / S;
  return Math.max(0, Math.min(1, Math.log(rs) / Math.log(n) * 0.5 + 0.5));
}

// ── Feature extraction (price-based, no EMA/RSI) ─────────────────────────────
export interface PriceFeatures {
  returns: number[];
  autocorr1: number;
  autocorr3: number;
  autocorr5: number;
  returnEntropy: number;
  hurst: number;
  tickVelocity: number;
  momentumSkew: number;
  volatilityRegime: number;
  spectralEnergy: number;
  zScoreLast: number;
}

export function extractPriceFeatures(prices: number[]): PriceFeatures {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / (prices[i - 1] || 1));
  }
  if (returns.length === 0) returns.push(0);

  const signCounts = [returns.filter((r) => r > 0).length, returns.filter((r) => r < 0).length, returns.filter((r) => r === 0).length];
  const recent = returns.slice(-10);
  const older = returns.slice(-20, -10);
  const momentumSkew = mean(recent) - mean(older.length ? older : recent);

  // Simple DFT energy in low-frequency band
  const n = Math.min(returns.length, 32);
  const slice = returns.slice(-n);
  let spectralEnergy = 0;
  for (let k = 1; k <= 3; k++) {
    let re = 0, im = 0;
    for (let t = 0; t < slice.length; t++) {
      const angle = (2 * Math.PI * k * t) / slice.length;
      re += slice[t] * Math.cos(angle);
      im += slice[t] * Math.sin(angle);
    }
    spectralEnergy += Math.sqrt(re * re + im * im) / slice.length;
  }

  const m = mean(returns);
  const sd = stddev(returns) || 1e-10;
  const zScoreLast = (returns[returns.length - 1] - m) / sd;

  return {
    returns,
    autocorr1: autocorr(returns, 1),
    autocorr3: autocorr(returns, 3),
    autocorr5: autocorr(returns, 5),
    returnEntropy: shannonEntropy(signCounts),
    hurst: hurstApprox(returns),
    tickVelocity: mean(returns.slice(-5).map(Math.abs)),
    momentumSkew,
    volatilityRegime: sd / (Math.abs(mean(prices)) || 1),
    spectralEnergy,
    zScoreLast,
  };
}

export function featuresToVector(f: PriceFeatures): number[] {
  return [
    f.autocorr1, f.autocorr3, f.autocorr5,
    f.returnEntropy, f.hurst, f.tickVelocity,
    f.momentumSkew * 1000, f.volatilityRegime * 10000,
    f.spectralEnergy * 100, f.zScoreLast,
    mean(f.returns.slice(-3)) * 1000,
    stddev(f.returns.slice(-5)) * 10000,
  ];
}

// ── Random Forest (pure TS, no deps) ─────────────────────────────────────────
interface TreeNode {
  featureIdx?: number;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
  prediction?: number;
}

function buildTree(data: number[][], labels: number[], depth: number, maxDepth: number): TreeNode {
  const n = labels.length;
  const posCount = labels.filter((l) => l === 1).length;
  if (depth >= maxDepth || n < 4 || posCount === 0 || posCount === n) {
    return { prediction: posCount / n };
  }

  const nFeatures = data[0].length;
  let bestGain = 0, bestFeat = 0, bestThresh = 0;
  const parentImpurity = (posCount / n) * (1 - posCount / n);

  for (let f = 0; f < nFeatures; f++) {
    const vals = data.map((row) => row[f]).sort((a, b) => a - b);
    for (let i = 1; i < vals.length; i++) {
      const thresh = (vals[i - 1] + vals[i]) / 2;
      const leftIdx = data.map((row, j) => row[f] <= thresh ? j : -1).filter((j) => j >= 0);
      const rightIdx = data.map((row, j) => row[f] > thresh ? j : -1).filter((j) => j >= 0);
      if (leftIdx.length === 0 || rightIdx.length === 0) continue;
      const leftPos = leftIdx.filter((j) => labels[j] === 1).length;
      const rightPos = rightIdx.filter((j) => labels[j] === 1).length;
      const leftImp = (leftPos / leftIdx.length) * (1 - leftPos / leftIdx.length);
      const rightImp = (rightPos / rightIdx.length) * (1 - rightPos / rightIdx.length);
      const gain = parentImpurity - (leftIdx.length / n) * leftImp - (rightIdx.length / n) * rightImp;
      if (gain > bestGain) { bestGain = gain; bestFeat = f; bestThresh = thresh; }
    }
  }

  if (bestGain < 0.001) return { prediction: posCount / n };

  const leftData: number[][] = [], leftLabels: number[] = [];
  const rightData: number[][] = [], rightLabels: number[] = [];
  for (let i = 0; i < n; i++) {
    if (data[i][bestFeat] <= bestThresh) { leftData.push(data[i]); leftLabels.push(labels[i]); }
    else { rightData.push(data[i]); rightLabels.push(labels[i]); }
  }

  return {
    featureIdx: bestFeat,
    threshold: bestThresh,
    left: buildTree(leftData, leftLabels, depth + 1, maxDepth),
    right: buildTree(rightData, rightLabels, depth + 1, maxDepth),
  };
}

function predictTree(node: TreeNode, features: number[]): number {
  if (node.prediction !== undefined) return node.prediction;
  if (node.featureIdx === undefined) return 0.5;
  return features[node.featureIdx] <= node.threshold!
    ? predictTree(node.left!, features)
    : predictTree(node.right!, features);
}

class RandomForest {
  private trees: TreeNode[] = [];

  fit(data: number[][], labels: number[]) {
    this.trees = [];
    const nTrees = 25;
    for (let t = 0; t < nTrees; t++) {
      const bootIdx = Array.from({ length: data.length }, () => Math.floor(Math.random() * data.length));
      const bootData = bootIdx.map((i) => data[i]);
      const bootLabels = bootIdx.map((i) => labels[i]);
      const featSubset = Array.from({ length: data[0].length }, (_, i) => i)
        .sort(() => Math.random() - 0.5)
        .slice(0, Math.ceil(Math.sqrt(data[0].length)));
      const subData = bootData.map((row) => featSubset.map((f) => row[f]));
      this.trees.push(buildTree(subData, bootLabels, 0, 5));
    }
  }

  predict(features: number[]): number {
    if (this.trees.length === 0) return 0.5;
    const preds = this.trees.map((tree) => predictTree(tree, features));
    return mean(preds);
  }
}

// ── Gradient Boosting (AdaBoost with decision stumps) ──────────────────────────
interface Stump { featIdx: number; threshold: number; leftVal: number; rightVal: number; alpha: number; }

class GradientBoosting {
  private stumps: Stump[] = [];

  fit(data: number[][], labels: number[]) {
    this.stumps = [];
    const n = labels.length;
    let weights = Array(n).fill(1 / n);
    const nRounds = 30;

    for (let round = 0; round < nRounds; round++) {
      let bestErr = Infinity, bestStump: Stump | null = null;

      for (let f = 0; f < data[0].length; f++) {
        const vals = [...new Set(data.map((row) => row[f]))].sort((a, b) => a - b);
        for (const thresh of vals) {
          const leftIdx = data.map((row, i) => row[f] <= thresh ? i : -1).filter((i) => i >= 0);
          const rightIdx = data.map((row, i) => row[f] > thresh ? i : -1).filter((i) => i >= 0);
          if (!leftIdx.length || !rightIdx.length) continue;

          const leftPos = leftIdx.reduce((s, i) => s + labels[i] * weights[i], 0) / leftIdx.reduce((s, i) => s + weights[i], 0);
          const rightPos = rightIdx.reduce((s, i) => s + labels[i] * weights[i], 0) / rightIdx.reduce((s, i) => s + weights[i], 0);
          const err = leftIdx.reduce((s, i) => s + weights[i] * Math.abs(labels[i] - leftPos), 0)
            + rightIdx.reduce((s, i) => s + weights[i] * Math.abs(labels[i] - rightPos), 0);

          if (err < bestErr) {
            bestErr = err;
            bestStump = { featIdx: f, threshold: thresh, leftVal: leftPos, rightVal: rightPos, alpha: 0 };
          }
        }
      }

      if (!bestStump || bestErr >= 0.5) break;
      bestStump.alpha = 0.5 * Math.log((1 - bestErr + 1e-10) / (bestErr + 1e-10));
      this.stumps.push(bestStump);

      for (let i = 0; i < n; i++) {
        const pred = data[i][bestStump.featIdx] <= bestStump.threshold ? bestStump.leftVal : bestStump.rightVal;
        weights[i] *= Math.exp(-bestStump.alpha * (2 * labels[i] - 1) * (2 * pred - 1));
      }
      const wSum = weights.reduce((a, b) => a + b, 0);
      weights = weights.map((w) => w / wSum);
    }
  }

  predict(features: number[]): number {
    if (!this.stumps.length) return 0.5;
    let score = 0, alphaSum = 0;
    for (const s of this.stumps) {
      const pred = features[s.featIdx] <= s.threshold ? s.leftVal : s.rightVal;
      score += s.alpha * pred;
      alphaSum += Math.abs(s.alpha);
    }
    const raw = alphaSum > 0 ? score / alphaSum : 0.5;
    return Math.max(0.05, Math.min(0.95, raw));
  }
}

// ── Training data generation from price history (online bootstrap) ─────────────
function buildTrainingSet(prices: number[]): { data: number[][]; labels: number[] } {
  const data: number[][] = [];
  const labels: number[] = [];
  const minWindow = 15;

  for (let end = minWindow + 1; end < prices.length; end++) {
    const window = prices.slice(Math.max(0, end - 40), end);
    const feats = extractPriceFeatures(window);
    const vec = featuresToVector(feats);
    const nextReturn = (prices[end] - prices[end - 1]) / (prices[end - 1] || 1);
    data.push(vec);
    labels.push(nextReturn >= 0 ? 1 : 0);
  }

  if (data.length < 5) {
    const feats = extractPriceFeatures(prices);
    data.push(featuresToVector(feats));
    labels.push(feats.momentumSkew >= 0 ? 1 : 0);
  }

  return { data, labels };
}

// ── Direction ensemble ─────────────────────────────────────────────────────────
export interface DirectionPrediction {
  probUp: number;
  probDown: number;
  confidence: number;
  direction: "up" | "down";
  models: { randomForest: number; gradientBoosting: number; logistic: number };
  reasoning: string;
}

function logisticPredict(features: number[]): number {
  const weights = [0.35, 0.15, 0.10, -0.20, 0.25, 0.30, 0.40, -0.15, 0.20, 0.18, 0.22, -0.10];
  let z = -0.05;
  for (let i = 0; i < Math.min(features.length, weights.length); i++) {
    z += features[i] * weights[i];
  }
  return 1 / (1 + Math.exp(-z));
}

export function predictDirection(prices: number[]): DirectionPrediction {
  const { data, labels } = buildTrainingSet(prices);
  const currentFeats = extractPriceFeatures(prices);
  const currentVec = featuresToVector(currentFeats);

  const rf = new RandomForest();
  rf.fit(data, labels);
  const rfProb = rf.predict(currentVec);

  const gb = new GradientBoosting();
  gb.fit(data, labels);
  const gbProb = gb.predict(currentVec);

  const lrProb = logisticPredict(currentVec);

  const probUp = rfProb * 0.40 + gbProb * 0.35 + lrProb * 0.25;
  const probDown = 1 - probUp;
  const confidence = Math.round(Math.abs(probUp - 0.5) * 200);
  const direction: "up" | "down" = probUp >= 0.5 ? "up" : "down";

  const reasoning = [
    `RF: ${(rfProb * 100).toFixed(0)}% up`,
    `GBM: ${(gbProb * 100).toFixed(0)}% up`,
    `LogReg: ${(lrProb * 100).toFixed(0)}% up`,
    `Hurst=${currentFeats.hurst.toFixed(2)}`,
    `entropy=${currentFeats.returnEntropy.toFixed(2)}`,
  ].join(", ");

  return {
    probUp, probDown, confidence, direction,
    models: { randomForest: rfProb, gradientBoosting: gbProb, logistic: lrProb },
    reasoning,
  };
}

// ── Digit ML: Markov chain + chi-square edge detection ────────────────────────
export interface DigitPrediction {
  digitProbs: number[];
  optimalWindow: number;
  contractType: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
  confidence: number;
  expectedEdge: number;
  reasoning: string;
  markovNext: number[];
}

const TICK_WINDOWS = [30, 50, 75, 100, 150, 200];

function buildTransitionMatrix(digits: number[]): number[][] {
  const matrix = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < digits.length; i++) {
    matrix[digits[i - 1]][digits[i]]++;
  }
  return matrix.map((row) => {
    const sum = row.reduce((a, b) => a + b, 0) || 1;
    return row.map((c) => c / sum);
  });
}

function chiSquareDeviation(digits: number[]): number {
  const counts = Array(10).fill(0);
  for (const d of digits) counts[d]++;
  const n = digits.length || 1;
  const expected = n / 10;
  let chi2 = 0;
  for (const c of counts) chi2 += ((c - expected) ** 2) / expected;
  return chi2;
}

function selectOptimalWindow(digits: number[]): number {
  let bestWindow = 100;
  let bestScore = -Infinity;

  for (const w of TICK_WINDOWS) {
    if (digits.length < w) continue;
    const window = digits.slice(-w);
    const chi2 = chiSquareDeviation(window);
    const trans = buildTransitionMatrix(window);
    const last = window[window.length - 1];
    const markovEntropy = shannonEntropy(trans[last].map((p) => Math.round(p * 1000)));
    const score = chi2 * 0.3 - markovEntropy * 0.7 + w * 0.001;
    if (score > bestScore) { bestScore = score; bestWindow = w; }
  }

  return Math.min(bestWindow, digits.length);
}

function markovPredict(trans: number[][], lastDigit: number): number[] {
  return trans[lastDigit].map((p, d) => ({ d, p }))
    .sort((a, b) => b.p - a.p)
    .reduce((probs, { d, p }, rank) => {
      probs[d] = p * (1 - rank * 0.02);
      return probs;
    }, Array(10).fill(0));
}

function multinomialPredict(digits: number[]): number[] {
  const counts = Array(10).fill(1); // Laplace smoothing
  for (const d of digits) counts[d]++;
  const total = counts.reduce((a: number, b: number) => a + b, 0);
  return counts.map((c: number) => c / total);
}

export function predictDigitContract(digits: number[]): DigitPrediction | null {
  if (digits.length < 30) return null;

  const optimalWindow = selectOptimalWindow(digits);
  const window = digits.slice(-optimalWindow);
  const trans = buildTransitionMatrix(window);
  const lastDigit = window[window.length - 1];

  const markovProbs = markovPredict(trans, lastDigit);
  const multiProbs = multinomialPredict(window);

  const digitProbs = markovProbs.map((mp, d) => mp * 0.55 + multiProbs[d] * 0.45);

  let bestContract: "DIGITOVER" | "DIGITUNDER" = "DIGITOVER";
  let bestBarrier = 4;
  let bestEdge = 0;
  let bestConf = 0;

  for (let barrier = 0; barrier <= 8; barrier++) {
    const pOver = digitProbs.slice(barrier + 1).reduce((a, b) => a + b, 0);
    const pUnder = digitProbs.slice(0, barrier).reduce((a, b) => a + b, 0);
    // True theoretical probabilities — P(digit > barrier) and P(digit < barrier)
    // assuming a perfectly uniform digit distribution (each digit 0-9 equally likely)
    const expectedOver = (9 - barrier) / 10;
    const expectedUnder = barrier / 10;

    // Canonical total-return payout multipliers (live proposal pricing is used
    // later by the execution pipeline whenever available).
    const overPayout = OVER_PAYOUTS[barrier] ?? OVER_PAYOUTS[4];
    const underPayout = UNDER_PAYOUTS[barrier] ?? UNDER_PAYOUTS[5];

    // Edge = deviation from theoretical + EV weighting
    const overEdge = pOver - expectedOver;
    const underEdge = pUnder - expectedUnder;

    // Expected value = win_prob * payout - (1 - win_prob) * stake, normalised to 0-1
    const overEV = pOver * overPayout - (1 - pOver);
    const underEV = pUnder * underPayout - (1 - pUnder);

    // Score = edge weighted by EV (avoid recommending barriers with negative EV)
    const overScore = overEdge > 0 && overEV > 0 ? overEdge * (1 + overEV) : -1;
    const underScore = underEdge > 0 && underEV > 0 ? underEdge * (1 + underEV) : -1;

    if (overScore > bestEdge) {
      bestEdge = overScore;
      bestContract = "DIGITOVER";
      bestBarrier = barrier;
      bestConf = Math.round(pOver * 100);
    }
    if (underScore > bestEdge) {
      bestEdge = underScore;
      bestContract = "DIGITUNDER";
      bestBarrier = barrier;
      bestConf = Math.round(pUnder * 100);
    }
  }

  if (bestEdge < 0.01) return null;

  const chi2 = chiSquareDeviation(window);
  const reasoning = [
    `Markov+Multinomial ensemble`,
    `window=${optimalWindow} ticks`,
    `barrier=${bestBarrier}`,
    `edge=${(bestEdge * 100).toFixed(1)}%`,
    `chi²=${chi2.toFixed(1)}`,
    `last=${lastDigit}`,
  ].join(", ");

  return {
    digitProbs,
    optimalWindow,
    contractType: bestContract,
    barrier: bestBarrier,
    confidence: Math.min(95, bestConf + Math.round(bestEdge * 50)),
    expectedEdge: bestEdge,
    reasoning,
    markovNext: markovProbs,
  };
}

// ── Volatility regime (for risk agent, no RSI) ───────────────────────────────
export function detectVolatilityRegime(prices: number[]): {
  regime: "low" | "medium" | "high" | "extreme";
  score: number;
  reasoning: string;
} {
  const feats = extractPriceFeatures(prices);
  const v = feats.volatilityRegime;

  if (v > 0.01) return { regime: "extreme", score: 25, reasoning: `Extreme vol regime (${(v * 100).toFixed(4)}%) — avoid trading` };
  if (v > 0.004) return { regime: "high", score: 58, reasoning: `High vol (${(v * 100).toFixed(4)}%) — reduce stake` };
  if (v > 0.001) return { regime: "medium", score: 82, reasoning: `Medium vol (${(v * 100).toFixed(4)}%) — optimal conditions` };
  return { regime: "low", score: 48, reasoning: `Low vol (${(v * 100).toFixed(4)}%) — limited movement` };
}

// ── Trend from ML direction (replaces EMA crossover) ─────────────────────────
export function detectTrendFromML(prices: number[]): {
  trend: "strong_up" | "up" | "sideways" | "down" | "strong_down";
  strength: number;
  score: number;
} {
  const pred = predictDirection(prices);
  const { probUp } = pred;

  if (probUp > 0.72) return { trend: "strong_up", strength: probUp, score: Math.round(probUp * 100) };
  if (probUp > 0.58) return { trend: "up", strength: probUp, score: Math.round(probUp * 90) };
  if (probUp < 0.28) return { trend: "strong_down", strength: 1 - probUp, score: Math.round((1 - probUp) * 100) };
  if (probUp < 0.42) return { trend: "down", strength: 1 - probUp, score: Math.round((1 - probUp) * 90) };
  return { trend: "sideways", strength: 0.3, score: 45 };
}
