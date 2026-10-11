/**
 * WP5 — weighted L2 logistic regression, written out rather than imported.
 *
 * ── WHY BY HAND ─────────────────────────────────────────────────────────────
 *
 * The brief forbids new heavy dependencies, and this is forty lines of linear
 * algebra. Doing it here also buys three things a library would hide:
 *
 *   • **Weights are first-class.** Every observation carries its uniqueness
 *     weight (`uniqueness.ts`), so the likelihood is Σ w_i · log L_i and the
 *     gradient and Hessian are weighted the same way. A library would need the
 *     weights smuggled in as repeated rows, which is the same thing done worse.
 *   • **Determinism.** Newton–Raphson (IRLS) from a zero start, no random
 *     initialisation, no shuffling, no stochastic gradient. The same data gives
 *     the same coefficients on every machine, which is what the report claims.
 *   • **Standardisation inside the model.** Features are standardised with the
 *     TRAINING means and scales, stored in the artifact, and applied at
 *     prediction time. Standardising outside is the classic train/serve skew:
 *     the desk standardises with the statistics of one live call and the model
 *     was fitted with another.
 *
 * The L2 penalty is applied to the coefficients and NOT to the intercept, which
 * is the correct convention: the intercept is the base rate, and shrinking it
 * would bias every probability downward on an unbalanced label set.
 */
import { mean, stdev } from "../math";

export interface LogisticModel {
  featureNames: string[];
  /** Training means per feature (applied before scaling). */
  means: number[];
  /** Training scales per feature; 1 where the feature had zero variance. */
  scales: number[];
  /** Coefficients in standardised space, one per feature. */
  coefficients: number[];
  intercept: number;
  l2: number;
  iterations: number;
  converged: boolean;
  /** Weighted log-likelihood at the reported fit. */
  logLikelihood: number;
  /** Weighted samples the fit saw, and their Kish effective count. */
  weightSum: number;
  effectiveSampleSize: number;
}

export interface FitLogisticInput {
  /** Rows of raw (unstandardised) features. */
  X: number[][];
  /** Labels; `true` means the profit barrier was reached first. */
  y: boolean[];
  featureNames: string[];
  /** Uniqueness weights, one per row. Defaults to 1 each. */
  weights?: number[];
  l2?: number;
  maxIter?: number;
  tol?: number;
}

function dot(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += (a[i] as number) * (b[i] as number);
  return total;
}

/** Numerically stable sigmoid. */
export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Solve A·x = b by Gaussian elimination with partial pivoting.
 *
 * The design matrix here is p × p with p in the teens, so this is both fast and
 * exact enough. A singular system (perfectly collinear features) returns null
 * rather than NaN coefficients — the caller must decide what to do about it, and
 * "silently produced NaNs" is never the right answer.
 */
export function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs((M[col] as number[])[col] as number);
    for (let row = col + 1; row < n; row++) {
      const value = Math.abs((M[row] as number[])[col] as number);
      if (value > best) {
        best = value;
        pivot = row;
      }
    }
    if (!(best > 1e-12)) return null; // singular
    if (pivot !== col) {
      const tmp = M[pivot] as number[];
      M[pivot] = M[col] as number[];
      M[col] = tmp;
    }
    const diagonal = (M[col] as number[])[col] as number;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = ((M[row] as number[])[col] as number) / diagonal;
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) {
        (M[row] as number[])[k] = ((M[row] as number[])[k] as number) - factor * ((M[col] as number[])[k] as number);
      }
    }
  }
  return M.map((row, i) => (row[n] as number) / ((M[i] as number[])[i] as number));
}

function standardise(X: number[][]): { means: number[]; scales: number[] } {
  const p = (X[0] as number[]).length;
  const means: number[] = [];
  const scales: number[] = [];
  for (let j = 0; j < p; j++) {
    const column = X.map((row) => row[j] as number);
    const m = mean(column);
    const s = stdev(column);
    means.push(m);
    scales.push(Number.isFinite(s) && s > 1e-12 ? s : 1);
  }
  return { means, scales };
}

function standardizedRow(row: number[], means: number[], scales: number[]): number[] {
  return row.map((value, j) => (value - (means[j] as number)) / (scales[j] as number));
}

/** Weighted L2 log-likelihood, used by the convergence test and the report. */
export function logisticLogLikelihood(
  X: number[][],
  y: boolean[],
  coefficients: number[],
  intercept: number,
  weights: number[],
  l2: number,
): number {
  let total = 0;
  for (let i = 0; i < X.length; i++) {
    const row = X[i] as number[];
    let z = intercept;
    for (let j = 0; j < row.length; j++) z += (coefficients[j] as number) * (row[j] as number);
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(z)));
    const w = weights[i] as number;
    total += w * ((y[i] as boolean) ? Math.log(p) : Math.log(1 - p));
  }
  let penalty = 0;
  for (const c of coefficients) penalty += c * c;
  return total - (l2 / 2) * penalty;
}

/**
 * Fit by IRLS: at each step solve the weighted least-squares problem
 *
 *   (ZᵀWZ + λI)β = ZᵀW(z)        z = Zβ + W⁻¹(y − p)
 *
 * which is Newton–Raphson on the penalised likelihood. Note the `(1−p)p`
 * denominator of the working weights: it makes each step the exact Newton step,
 * and it is also why a perfectly separable problem diverges — the caller gets a
 * `converged: false` flag, and the WP5 study refuses to gate on a model that did
 * not converge rather than reading a coefficient of 30 as confidence.
 *
 * Convergence is declared on the SIZE OF THE STEP, not on the size of the
 * likelihood change: a likelihood at −215 cannot move by 1e-8 in double precision
 * even when the parameters have stopped moving entirely, so an objective-based
 * test reports "not converged" on fits that are perfectly converged. Each step is
 * also backtracked, because an unguarded Newton step on a nearly-separable
 * feature can land far past the mode.
 */
export function fitLogistic(input: FitLogisticInput): LogisticModel {
  const { X, y, featureNames } = input;
  const l2 = input.l2 ?? 1;
  const maxIter = input.maxIter ?? 100;
  const tol = input.tol ?? 1e-8;
  const weights = input.weights ?? X.map(() => 1);
  const n = X.length;
  const p = featureNames.length;
  const weightSum = weights.reduce((a, b) => a + b, 0);
  let sumSq = 0;
  for (const w of weights) sumSq += w * w;
  const effectiveSampleSize = sumSq > 0 ? (weightSum * weightSum) / sumSq : 0;

  if (n === 0 || p === 0) {
    return {
      featureNames, means: new Array(p).fill(0), scales: new Array(p).fill(1),
      coefficients: new Array(p).fill(0), intercept: 0, l2, iterations: 0,
      converged: false, logLikelihood: 0, weightSum, effectiveSampleSize,
    };
  }

  const { means, scales } = standardise(X);
  const Z = X.map((row) => standardizedRow(row, means, scales));

  // Start at the weighted base rate: the intercept-only fit.
  const positives = y.reduce((a, hit, i) => a + (hit ? (weights[i] as number) : 0), 0);
  const baseRate = weightSum > 0 ? positives / weightSum : 0.5;
  let intercept = Math.log(Math.min(1 - 1e-6, Math.max(1e-6, baseRate)) / (1 - Math.min(1 - 1e-6, Math.max(1e-6, baseRate))));
  let coefficients = new Array(p).fill(0) as number[];
  let logLikelihood = logisticLogLikelihood(Z, y, coefficients, intercept, weights, l2);
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    // ── One exact Newton step on the penalised likelihood ──────────────────
    //
    // The intercept and the coefficients are solved TOGETHER. Fitting them with
    // two separate one-dimensional steps looks equivalent and is not: near
    // convergence the two half-steps disagree by O(step²), which is enough for
    // the improvement check below to see the likelihood fall by a few units in
    // the last mantissa bits and report `converged: false` on a fit that had in
    // fact arrived. The joint system has no such failure mode.
    const dim = p + 1; // index 0 is the intercept
    const A: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0) as number[]);
    const b = new Array(dim).fill(0) as number[];
    for (let i = 0; i < n; i++) {
      const row = Z[i] as number[];
      const w = weights[i] as number;
      const eta = intercept + dot(coefficients, row);
      const prob = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(eta)));
      const v = w * prob * (1 - prob);
      const residual = ((y[i] as boolean) ? 1 : 0) - prob;
      for (let j = 0; j < dim; j++) {
        const xj = j === 0 ? 1 : (row[j - 1] as number);
        b[j] = (b[j] as number) + w * residual * xj;
        for (let k = 0; k <= j; k++) {
          const xk = k === 0 ? 1 : (row[k - 1] as number);
          (A[j] as number[])[k] = ((A[j] as number[])[k] as number) + v * xj * xk;
        }
      }
    }
    for (let j = 0; j < dim; j++) {
      for (let k = 0; k < j; k++) (A[j] as number[])[k] = (A[k] as number[])[j] as number;
      if (j > 0) {
        // Ridge penalty: on the Hessian's diagonal, and its gradient term on the
        // right-hand side. Penalising only one of the two would make every step
        // slightly too long.
        (A[j] as number[])[j] = ((A[j] as number[])[j] as number) + l2;
        b[j] = (b[j] as number) - l2 * (coefficients[j - 1] as number);
      }
    }
    const step = solveLinearSystem(A, b);
    if (!step) break; // collinear features: keep the last sound fit

    // Backtracking: a full Newton step can overshoot away from the mode. Halve
    // until the penalised log-likelihood improves, and only give up if it cannot.
    const previousLikelihood = logLikelihood;
    let scale = 1;
    let accepted = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const nextIntercept = intercept + (step[0] as number) * scale;
      const nextCoefficients = coefficients.map((c, j) => c + (step[j + 1] as number) * scale);
      const likelihood = logisticLogLikelihood(Z, y, nextCoefficients, nextIntercept, weights, l2);
      if (Number.isFinite(likelihood) && likelihood >= previousLikelihood - 1e-9) {
        intercept = nextIntercept;
        coefficients = nextCoefficients;
        logLikelihood = likelihood;
        accepted = true;
        break;
      }
      scale /= 2;
    }
    if (!accepted) break; // at the mode, in floating point

    const maxChange = Math.max(...step.map((value) => Math.abs(value)));
    if (maxChange * scale < tol) {
      converged = true;
      break;
    }
  }

  return {
    featureNames,
    means,
    scales,
    coefficients,
    intercept,
    l2,
    iterations,
    converged,
    logLikelihood,
    weightSum,
    effectiveSampleSize,
  };
}

/** P(label = 1) for one raw feature row. */
export function predictLogistic(model: LogisticModel, row: number[]): number {
  let z = model.intercept;
  for (let j = 0; j < model.featureNames.length; j++) {
    const scale = model.scales[j] as number;
    const value = ((row[j] as number) - (model.means[j] as number)) / (scale === 0 ? 1 : scale);
    z += (model.coefficients[j] as number) * value;
  }
  return sigmoid(z);
}

/** Brier score of a set of predictions, weighted like the fit. */
export function brierScore(predictions: number[], y: boolean[], weights?: number[]): number {
  const w = weights ?? predictions.map(() => 1);
  let total = 0;
  let sum = 0;
  for (let i = 0; i < predictions.length; i++) {
    const weight = w[i] as number;
    total += weight * ((predictions[i] as number) - ((y[i] as boolean) ? 1 : 0)) ** 2;
    sum += weight;
  }
  return sum > 0 ? total / sum : 1;
}

/** Log loss of a set of predictions, clipped to avoid infinities. */
export function logLoss(predictions: number[], y: boolean[], weights?: number[]): number {
  const w = weights ?? predictions.map(() => 1);
  let total = 0;
  let sum = 0;
  for (let i = 0; i < predictions.length; i++) {
    const weight = w[i] as number;
    const p = Math.min(1 - 1e-12, Math.max(1e-12, predictions[i] as number));
    total += weight * ((y[i] as boolean) ? -Math.log(p) : -Math.log(1 - p));
    sum += weight;
  }
  return sum > 0 ? total / sum : 1;
}
