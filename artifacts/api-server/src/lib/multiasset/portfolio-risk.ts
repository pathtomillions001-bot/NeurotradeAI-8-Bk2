/**
 * WP8 — the portfolio and risk layer.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * WP7 gets one trade in. This decides how much of the account goes with it, and
 * whether the BOOK it joins still looks like a portfolio rather than one bet
 * wearing several symbols.
 *
 * Three ideas, and each one replaces something the desk used to guess:
 *
 *   1. **Risk per trade is a MINIMUM of two honest numbers**, not a knob:
 *      `min(0.35%, ¼-Kelly on p_LCB)`, scaled by the drawdown state. `p_LCB` is
 *      WP5's lower bound, so the Kelly term is fed the pessimistic probability —
 *      a desk that sizes on p̂ is paid in confidence it has not earned.
 *   2. **Correlations are measured and shrunk toward a diagonal**, EWMA-weighted
 *      at λ = 0.97 with Ledoit–Wolf shrinkage. An unshrunk sample covariance of
 *      n assets and n/2 observations is invertible in exact arithmetic and
 *      nonsense in practice; shrinkage is what keeps the heat number honest.
 *   3. **Three limits that bind before the account does**: portfolio heat
 *      `√(r'Cr) ≤ 1.5%` of equity, any cluster of assets correlated above 0.6
 *      capped at 1.0% of equity combined, and the book's daily 95% CVaR at or
 *      below 1.5%.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * It never raises risk: every cap in this file can only reduce or refuse. It
 * does not re-open WP1's halt (10% drawdown ⇒ stop) or the daily loss limit; it
 * adds a GRADED response between them. And it never changes a stop, a target or
 * a direction — only the fraction of the account behind them.
 */
import { CLOSE, stdev } from "./math";
import { kellyFraction } from "./sizing";
import type { Bar } from "./types";

/** Hard ceiling on a single trade's risk, whatever Kelly says. */
export const PORTFOLIO_MAX_TRADE_RISK_PCT = 0.35;

/** Kelly fraction: quarter-Kelly, per the brief. */
export const PORTFOLIO_KELLY_FRACTION = 0.25;

/**
 * Drawdown at which the scalar starts to bite.
 *
 * The brief fixes the endpoints (1.0 → 0.25 at 8%) and the halt (10%); the
 * knee at 4% is a documented choice, not a measurement: scaling linearly all the
 * way from 0% would tax a desk at its all-time high, and switching abruptly at
 * exactly 8% would be a cliff in the middle of a losing run.
 */
export const DD_SCALAR_KNEE_PCT = 4;

/** Drawdown at which the scalar reaches its floor. */
export const DD_SCALAR_FULL_PCT = 8;

export const DD_SCALAR_FLOOR = 0.25;

/** Drawdown at which the desk stops opening anything (WP1's halt). */
export const DD_HALT_PCT = 10;

/** Portfolio heat ceiling, in % of equity: √(r'Cr). */
export const PORTFOLIO_HEAT_MAX_PCT = 1.5;

/** Correlation above which positions count as one bet. */
export const CORRELATION_CLUSTER_RHO = 0.6;

/** Ceiling on the COMBINED risk of any correlated cluster, in % of equity. */
export const CLUSTER_RISK_MAX_PCT = 1.0;

/** Ceiling on the book's one-day 95% CVaR, in % of equity. */
export const DAILY_CVAR_MAX_PCT = 1.5;

/** EWMA decay of the covariance. Same 0.97 the slippage ledger uses. */
export const EWMA_LAMBDA = 0.97;

/** Fewer observations than this and no covariance is estimated. */
export const MIN_COVARIANCE_SAMPLES = 40;

export type Matrix = number[][];

/**
 * Covariance of aligned return series, EWMA-weighted when `lambda` is given.
 *
 * `series[i][t]` is asset i's return at time t. The EWMA form is what makes the
 * matrix about TODAY rather than about the sample: with λ = 0.97 a shock a week
 * old carries 0.6^5 ≈ 8% of the weight of today's.
 */
export function sampleCovariance(
  series: number[][],
  input: { lambda?: number | null; meanAdjusted?: boolean } = {},
): Matrix | null {
  const n = series.length;
  if (n === 0) return null;
  const lengths = new Set(series.map((s) => s.length));
  if (lengths.size !== 1) return null;
  const t = series[0]?.length ?? 0;
  const lambda = input.lambda ?? null;
  // Effective sample size under an EWMA: what the shrinkage intensity must use.
  const tEff = lambda === null ? t : Math.min(t, (1 + lambda) / (1 - lambda));
  if (tEff < MIN_COVARIANCE_SAMPLES) return null;

  const means = series.map((s) =>
    input.meanAdjusted === false ? 0 : s.reduce((a, b) => a + b, 0) / Math.max(1, s.length),
  );

  let weightSum = 0;
  const matrix: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let time = 0; time < t; time++) {
    const weight = lambda === null ? 1 : (1 - lambda) * Math.pow(lambda, t - 1 - time);
    weightSum += weight;
    for (let i = 0; i < n; i++) {
      const xi = (series[i] as number[])[time] as number - (means[i] as number);
      for (let j = i; j < n; j++) {
        const xj = (series[j] as number[])[time] as number - (means[j] as number);
        const cell = (matrix[i] as number[])[j] as number;
        (matrix[i] as number[])[j] = cell + weight * xi * xj;
      }
    }
  }
  if (!(weightSum > 0)) return null;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const value = ((matrix[i] as number[])[j] as number) / weightSum;
      (matrix[i] as number[])[j] = value;
      (matrix[j] as number[])[i] = value;
    }
  }
  return matrix;
}

export interface ShrinkageResult {
  covariance: Matrix;
  /** Estimated shrinkage intensity, in [0, 1]. */
  intensity: number;
  /** The diagonal target's average variance. */
  targetVariance: number;
}

/**
 * Ledoit–Wolf shrinkage of a covariance matrix toward a diagonal target.
 *
 * The target is `average variance × I`: it keeps every asset's own scale (so the
 * matrix stays in the units of the returns) and destroys every off-diagonal. The
 * intensity is the standard LW ratio
 *
 *   κ = Σ_t ‖x_t x_t' − S‖²_F / T,   γ = ‖S − F‖²_F,   δ = clip(κ/(T γ), 0, 1)
 *
 * which grows when the sample is noisy relative to the structure it claims.
 * Shrinking a well-determined matrix barely moves it; shrinking one estimated
 * from 40 observations on 8 assets moves it a great deal, which is the point.
 */
export function ledoitWolfShrinkage(input: { series: number[][]; covariance: Matrix }): ShrinkageResult {
  const { covariance } = input;
  const n = covariance.length;
  const series = input.series;
  const t = series[0]?.length ?? 0;
  let trace = 0;
  for (let i = 0; i < n; i++) trace += (covariance[i] as number[])[i] as number;
  const targetVariance = n > 0 ? trace / n : 0;
  const target: Matrix = Array.from({ length: n }, (_, i) =>
    new Array<number>(n).fill(0).map((_, j) => (i === j ? targetVariance : 0)),
  );

  let kappa = 0;
  if (t > 0) {
    const means = series.map((s) => s.reduce((a, b) => a + b, 0) / Math.max(1, s.length));
    for (let time = 0; time < t; time++) {
      let norm = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const xi = ((series[i] as number[])[time] as number) - (means[i] as number);
          const xj = ((series[j] as number[])[time] as number) - (means[j] as number);
          const diff = xi * xj - ((covariance[i] as number[])[j] as number);
          norm += diff * diff;
        }
      }
      kappa += norm;
    }
    kappa /= t;
  }
  let gamma = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const diff = ((covariance[i] as number[])[j] as number) - ((target[i] as number[])[j] as number);
      gamma += diff * diff;
    }
  }
  const intensity = t > 0 && gamma > 0 ? Math.min(1, Math.max(0, kappa / (t * gamma))) : 0;
  const shrunk: Matrix = covariance.map((row, i) =>
    row.map((value, j) => intensity * ((target[i] as number[])[j] as number) + (1 - intensity) * value),
  );
  return { covariance: shrunk, intensity, targetVariance };
}

/** Correlation matrix from a covariance matrix, or null if any variance is 0. */
export function correlationMatrix(covariance: Matrix): Matrix | null {
  const n = covariance.length;
  const sd = covariance.map((row, i) => Math.sqrt(Math.max(0, row[i] as number)));
  if (sd.some((s) => !(s > 0))) return null;
  return covariance.map((row, i) =>
    row.map((value, j) => {
      const denom = (sd[i] as number) * (sd[j] as number);
      const rho = denom > 0 ? value / denom : 0;
      return Math.max(-1, Math.min(1, rho));
    }),
  );
}

/**
 * Groups of assets that move together: the transitive closure of ρ > threshold.
 *
 * Transitive on purpose. A→B at 0.7 and B→C at 0.7 with A→C at 0.5 is one bet,
 * and a pairwise check that stops at the direct edge would let the cluster carry
 * three positions' risk while calling them independent.
 */
export function correlationClusters(
  correlation: Matrix,
  labels: string[],
  rho: number = CORRELATION_CLUSTER_RHO,
): string[][] {
  const n = correlation.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while ((parent[root] as number) !== root) root = parent[root] as number;
    let node = x;
    while ((parent[node] as number) !== node) {
      const next = parent[node] as number;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = (correlation[i] as number[])[j] as number;
      if (Number.isFinite(r) && r > rho) union(i, j);
    }
  }
  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(labels[i] ?? String(i));
    groups.set(root, list);
  }
  return Array.from(groups.values());
}

/**
 * Portfolio heat: `√(r'Cr)` in % of equity.
 *
 * `risksPct[i]` is the money at risk on position i as a percentage of equity and
 * `correlation` is the return correlation matrix — unit variances — so the
 * result is directly comparable with the 1.5% ceiling. With one position this is
 * simply its own risk, which is the property that makes the ceiling meaningful
 * for the first trade as well as the tenth.
 */
export function portfolioHeatPct(risksPct: number[], correlation: Matrix): number | null {
  const n = risksPct.length;
  if (n === 0) return null;
  if (correlation.length !== n) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sum += (risksPct[i] as number) * (risksPct[j] as number) * ((correlation[i] as number[])[j] as number);
    }
  }
  if (!(sum >= 0)) return null;
  return Math.sqrt(sum);
}

/** Standard-normal density, for the parametric CVaR. */
function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * One-day 95% CVaR of the book, in % of equity.
 *
 * Parametric and normal, which is a documented approximation: the desk's own
 * return distribution has fatter tails, so this number is a LOWER bound on the
 * true CVaR and the ceiling that uses it is the least protective of the three.
 * It is used because it is the one the book can compute from a covariance it
 * already has, and because the alternative — resampling — is the WP6 Monte
 * Carlo's job, per trade.
 *
 * CVaR for a normal tail: σ · φ(z) / (1 − confidence), with z the
 * (1 − confidence) quantile. At 95% that is σ · 2.063.
 */
export function dailyCvarPct(
  risksPct: number[],
  correlation: Matrix,
  confidence = 0.95,
): number | null {
  const heat = portfolioHeatPct(risksPct, correlation);
  if (heat === null) return null;
  const tail = 1 - confidence;
  if (!(tail > 0 && tail < 1)) return null;
  const z = inverseNormal(tail);
  return (heat * normalPdf(z)) / tail;
}

/**
 * The largest candidate risk that keeps the BOOK's CVaR inside `ceilingPct`.
 *
 * The obvious remedy — scale the candidate by `ceiling / cvar` — does not work,
 * and the failure is silent: CVaR is `heat × factor`, heat is a square root of a
 * quadratic, and a square root is CONCAVE in the candidate's own risk. Scaling
 * the candidate by s < 1 therefore shrinks the book's CVaR by LESS than s, so
 * the book is left above the ceiling it was supposed to be brought under. That
 * is a gate whose own remedy cannot satisfy it; a study that measured "the
 * composed book never exceeds its ceiling" would fail forever.
 *
 * The correct question is which candidate risk puts the total exactly on the
 * ceiling, so this solves for it. Heat is NOT necessarily monotone in the
 * candidate's own risk — a candidate negatively correlated with the book lowers
 * the book's variance before raising it — so the admissible set is scanned for
 * its upper bracket first and only then bisected. Returns 0 when the book is
 * already over the ceiling without this trade, which is the honest answer: no
 * size of this trade can fix a book that is already too big.
 */
function affordableRiskForCvar(input: {
  bookRisks: number[];
  correlation: Matrix;
  ceilingPct: number;
  capPct: number;
}): number {
  const { bookRisks, correlation, ceilingPct, capPct } = input;
  if (!(capPct > 0)) return 0;
  const admissible = (risk: number): boolean => {
    const cvar = dailyCvarPct([...bookRisks, risk], correlation);
    return cvar !== null && cvar <= ceilingPct + 1e-12;
  };
  if (!admissible(0)) return 0;
  if (admissible(capPct)) return capPct;
  const STEPS = 64;
  let best = 0;
  let upper = capPct;
  for (let step = STEPS; step >= 1; step--) {
    const risk = (capPct * step) / STEPS;
    if (admissible(risk)) {
      best = risk;
      upper = Math.min(capPct, (capPct * (step + 1)) / STEPS);
      break;
    }
  }
  for (let iteration = 0; iteration < 48; iteration++) {
    const mid = (best + upper) / 2;
    if (admissible(mid)) best = mid;
    else upper = mid;
  }
  return best;
}

/**
 * Inverse standard-normal CDF (Acklam's rational approximation).
 *
 * Written with named intermediates rather than one return expression: the
 * rational forms below differ from each other only in a sign and in where the
 * `+ 1` sits, and a single misplaced parenthesis turns z(0.5) into 1 instead of
 * 0 — which is exactly what this function did before it was tested against the
 * known quantiles (5% ⇒ −1.6449, 50% ⇒ 0, 95% ⇒ 1.6449).
 */
export function inverseNormal(p: number): number {
  if (!(p > 0 && p < 1)) return Number.NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;

  const tail = (q: number): number => {
    // Horner form of the c-polynomial over the d-polynomial, denominator = D(q)·q + 1.
    const numerator = (((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q + (c[5] as number);
    const denominator = (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q) + 1;
    return numerator / denominator;
  };

  if (p < plow) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > phigh) return -tail(Math.sqrt(-2 * Math.log(1 - p)));

  const q = p - 0.5;
  const r = q * q;
  const numerator = (((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r + (a[3] as number)) * r + (a[4] as number)) * r + (a[5] as number);
  const denominator = ((((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r + (b[3] as number)) * r + (b[4] as number)) * r) + 1;
  return (numerator * q) / denominator;
}

export interface DrawdownState {
  drawdownPct: number;
  /** Multiplier applied to the per-trade budget: 1 ⇒ full, 0.25 ⇒ floor. */
  scalar: number;
  /** True at or above the 10% halt; nothing new may open. */
  halted: boolean;
  reason: string;
}

/** The graded drawdown response: 1.0 → 0.25 across the knee, halt at 10%. */
export function drawdownScalar(drawdownPct: number): DrawdownState {
  const dd = Number.isFinite(drawdownPct) ? Math.max(0, drawdownPct) : 0;
  if (dd >= DD_HALT_PCT) {
    return {
      drawdownPct: dd,
      scalar: 0,
      halted: true,
      reason: `drawdown ${dd.toFixed(2)}% has reached the ${DD_HALT_PCT}% halt — no new entries.`,
    };
  }
  if (dd <= DD_SCALAR_KNEE_PCT) {
    return {
      drawdownPct: dd,
      scalar: 1,
      halted: false,
      reason: `drawdown ${dd.toFixed(2)}% is inside the ${DD_SCALAR_KNEE_PCT}% knee — full size.`,
    };
  }
  const span = DD_SCALAR_FULL_PCT - DD_SCALAR_KNEE_PCT;
  const progress = Math.min(1, (dd - DD_SCALAR_KNEE_PCT) / span);
  const scalar = Number((1 - progress * (1 - DD_SCALAR_FLOOR)).toFixed(4));
  return {
    drawdownPct: dd,
    scalar,
    halted: false,
    reason: `drawdown ${dd.toFixed(2)}% scales new risk to ${(scalar * 100).toFixed(1)}% of the budget.`,
  };
}

export interface PortfolioCode {
  code: string;
  detail: string;
}

export interface PortfolioDecision {
  allowed: boolean;
  /** The risk budget for THIS trade, in % of equity. */
  riskPct: number;
  /** `min(0.35%, ¼-Kelly(p_LCB))` before the drawdown scalar. */
  cappedRiskPct: number;
  kellyRiskPct: number;
  drawdown: DrawdownState;
  /** Heat the book would carry with this trade included, or null if unmeasured. */
  heatPct: number | null;
  /** The cluster this candidate joins, if any asset in it is already held. */
  cluster: string[] | null;
  /** Combined risk of that cluster with this trade included. */
  clusterRiskPct: number | null;
  cvarPct: number | null;
  codes: string[];
  reasons: string[];
}

/**
 * The composition, and the order matters:
 *
 *   size → drawdown scalar → cluster cap → heat cap → CVaR cap → halt.
 *
 * Each step can only reduce what the previous one allowed. The caps are applied
 * to the DECISION's own risk, not to the whole book retroactively — the desk
 * cannot un-risk a position it is already in, so a book that is already at its
 * heat ceiling gets a smaller new trade (or none), never a warning.
 */
export function portfolioDecision(input: {
  drawdownPct: number;
  /** The trade's own probability lower bound (WP5). Absent ⇒ no Kelly term. */
  probabilityLowerBound: number | null;
  /** The trade's reward:risk at the expected fill. */
  rewardRisk: number;
  /** Existing book: one entry per open position. */
  book: { symbol: string; riskPct: number; cluster?: string | null }[];
  /** Return correlation matrix for `book` (plus the candidate, last). */
  correlation: Matrix | null;
  /** The candidate's index in the label list, for cluster lookup. */
  candidateIndex?: number;
  /** Labels aligned with `correlation`. */
  labels?: string[];
  /** Hard ceiling override, never above the desk's 0.35%. */
  maxTradeRiskPct?: number;
}): PortfolioDecision {
  const codes: string[] = [];
  const reasons: string[] = [];
  const cap = Math.min(input.maxTradeRiskPct ?? PORTFOLIO_MAX_TRADE_RISK_PCT, PORTFOLIO_MAX_TRADE_RISK_PCT);

  const p = input.probabilityLowerBound;
  const kelly = p !== null && Number.isFinite(p) && input.rewardRisk > 0 ? kellyFraction(p, input.rewardRisk, PORTFOLIO_KELLY_FRACTION) : 0;
  // Kelly returns a FRACTION of the account; the desk's units are percent.
  const kellyRiskPct = Math.max(0, kelly * 100);
  const cappedRiskPct = Math.min(cap, kellyRiskPct > 0 ? kellyRiskPct : cap);
  const drawdown = drawdownScalar(input.drawdownPct);
  let riskPct = cappedRiskPct * drawdown.scalar;

  if (drawdown.halted) {
    codes.push("PF_HALT");
    reasons.push(drawdown.reason);
  }
  // Compare Kelly against the CEILING, not against `cappedRiskPct`: when Kelly is
  // the binding constraint the two are equal by construction, and the original
  // comparison therefore never fired — the code existed but was unreachable, and
  // the journal could not say which of the two sized the trade.
  if (kellyRiskPct > 0 && kellyRiskPct < cap) {
    codes.push("PF_KELLY");
    reasons.push(
      `quarter-Kelly on p_LCB ${(p as number).toFixed(3)} at 1:${input.rewardRisk.toFixed(2)} is ${kellyRiskPct.toFixed(3)}% of equity, under the ${cap.toFixed(2)}% ceiling.`,
    );
  }

  const labels = input.labels ?? input.book.map((entry) => entry.symbol);
  const correlation = input.correlation;
  const correlationsUsable =
    correlation !== null && correlation.length >= input.book.length && correlation.every((row) => row.length >= input.book.length);

  let cluster: string[] | null = null;
  let clusterRiskPct: number | null = null;
  let heatPct: number | null = null;
  let cvarPct: number | null = null;

  if (correlationsUsable && correlation !== null) {
    const matrix = correlation;
    const clusters = correlationClusters(matrix, labels);
    const candidateLabel =
      input.candidateIndex !== undefined ? labels[input.candidateIndex] : (labels[input.book.length] ?? "candidate");
    cluster = clusters.find((group) => group.includes(candidateLabel)) ?? [candidateLabel];
    const inCluster = cluster.filter((label) => label !== candidateLabel);
    const clusterBookRisk = input.book
      .filter((entry) => inCluster.includes(entry.symbol))
      .reduce((a, entry) => a + entry.riskPct, 0);
    clusterRiskPct = clusterBookRisk + riskPct;
    if (clusterRiskPct > CLUSTER_RISK_MAX_PCT) {
      const affordable = Math.max(0, CLUSTER_RISK_MAX_PCT - clusterBookRisk);
      codes.push("PF_CLUSTER");
      reasons.push(
        `the correlated cluster [${cluster.join(", ")}] would carry ${clusterRiskPct.toFixed(3)}% of equity, over the ${CLUSTER_RISK_MAX_PCT}% ceiling — this trade is capped to ${affordable.toFixed(3)}%.`,
      );
      riskPct = affordable;
      clusterRiskPct = CLUSTER_RISK_MAX_PCT;
    }

    const risks = [...input.book.map((entry) => entry.riskPct), riskPct];
    const n = risks.length;
    // The candidate's row/column: the book's own ordering is preserved, with the
    // candidate appended, so the heat is computed for the book AS IT WOULD BE.
    const sub: Matrix = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => {
        const row = i < input.book.length ? i : input.book.length;
        const col = j < input.book.length ? j : input.book.length;
        return (matrix[row] as number[])[col] as number;
      }),
    );
    heatPct = portfolioHeatPct(risks, sub);
    cvarPct = dailyCvarPct(risks, sub);
    if (heatPct !== null && heatPct > PORTFOLIO_HEAT_MAX_PCT) {
      const bookOnly = portfolioHeatPct(
        input.book.map((entry) => entry.riskPct),
        Array.from({ length: input.book.length }, (_, i) =>
          Array.from({ length: input.book.length }, (_, j) => (matrix[i] as number[])[j] as number),
        ),
      );
      const budget = Math.max(0, PORTFOLIO_HEAT_MAX_PCT - (bookOnly ?? 0));
      codes.push("PF_HEAT");
      reasons.push(
        `portfolio heat would be ${heatPct.toFixed(3)}% of equity, over the ${PORTFOLIO_HEAT_MAX_PCT}% ceiling — this trade is capped to ${budget.toFixed(3)}%.`,
      );
      riskPct = Math.min(riskPct, budget);
      heatPct = portfolioHeatPct([...input.book.map((entry) => entry.riskPct), riskPct], sub);
      cvarPct = dailyCvarPct([...input.book.map((entry) => entry.riskPct), riskPct], sub);
    }
    if (cvarPct !== null && cvarPct > DAILY_CVAR_MAX_PCT) {
      const affordable = affordableRiskForCvar({
        bookRisks: input.book.map((entry) => entry.riskPct),
        correlation: sub,
        ceilingPct: DAILY_CVAR_MAX_PCT,
        capPct: riskPct,
      });
      codes.push("PF_CVAR");
      reasons.push(
        affordable > 0
          ? `the book's one-day 95% CVaR would be ${cvarPct.toFixed(3)}% of equity, over the ${DAILY_CVAR_MAX_PCT}% ceiling — this trade is cut to ${affordable.toFixed(3)}%, the largest size that keeps the book under it.`
          : `the book's one-day 95% CVaR is already ${dailyCvarPct(input.book.map((entry) => entry.riskPct), sub)?.toFixed(3) ?? cvarPct.toFixed(3)}% of equity without this trade, over the ${DAILY_CVAR_MAX_PCT}% ceiling — no size of this trade can fix a book that is already too big, so it takes none.`,
      );
      riskPct = Math.min(riskPct, affordable);
      cvarPct = dailyCvarPct([...input.book.map((entry) => entry.riskPct), riskPct], sub);
    }
  } else if (input.book.length > 0) {
    // No covariance ⇒ the desk cannot see whether this trade doubles a bet it
    // already has. The conservative reading is to keep the per-trade cap.
    codes.push("PF_NO_COVARIANCE");
    reasons.push(
      "the book's covariance could not be estimated from the history available, so only the per-trade ceiling applies — the desk cannot yet tell whether this trade doubles an existing one.",
    );
  }

  const allowed = !drawdown.halted && riskPct > 0;
  if (allowed) codes.push("PF_OK");
  if (!allowed && !drawdown.halted && riskPct <= 0) {
    codes.push("PF_NO_BUDGET");
    reasons.push("every ceiling in this layer is already spent by the open book, so this trade takes no risk.");
  }

  return {
    allowed,
    riskPct: Math.max(0, riskPct),
    cappedRiskPct,
    kellyRiskPct,
    drawdown,
    heatPct,
    cluster,
    clusterRiskPct,
    cvarPct,
    codes,
    reasons,
  };
}

/**
 * Return correlations built from the desk's OWN bars.
 *
 * `series[i].bars` must be CLOSED bars of the same timeframe, and every series
 * must supply at least `count + 1` closes; the function returns `null` rather
 * than a matrix with a hole in it, because the caller's alternative when the
 * book cannot be measured is to keep the per-trade ceiling (PF_NO_COVARIANCE),
 * not to assume the missing asset is uncorrelated with everything else.
 *
 * Returns are aligned by index from the END of each series, which is exact when
 * the bars are time-bucketed on the same clock (they are: the desk requests one
 * timeframe per mode, and MT5 stamps bar opens on the minute). The last `count`
 * returns are used, EWMA-weighted, then shrunk toward the diagonal and
 * normalised to correlations.
 */
export function correlationFromBars(input: {
  series: { label: string; bars: Bar[] }[];
  count?: number;
  lambda?: number | null;
}): { labels: string[]; correlation: Matrix; covariance: Matrix; shrinkageIntensity: number; returnCount: number } | null {
  const count = Math.max(MIN_COVARIANCE_SAMPLES, Math.floor(input.count ?? MIN_COVARIANCE_SAMPLES));
  if (input.series.length < 2) return null;
  const returns: number[][] = [];
  const labels: string[] = [];
  for (const entry of input.series) {
    const bars = entry.bars;
    if (bars.length < count + 1) return null;
    const slice = bars.slice(bars.length - (count + 1));
    const series: number[] = [];
    for (let i = 1; i < slice.length; i++) {
      const previous = (slice[i - 1] as Bar)[CLOSE] as number;
      const current = (slice[i] as Bar)[CLOSE] as number;
      if (!(previous > 0) || !(current > 0)) return null;
      series.push(Math.log(current / previous));
    }
    returns.push(series);
    labels.push(entry.label);
  }
  const lambda = input.lambda === undefined ? EWMA_LAMBDA : input.lambda;
  const covariance = sampleCovariance(returns, { lambda });
  if (!covariance) return null;
  const shrunk = ledoitWolfShrinkage({ series: returns, covariance });
  const correlation = correlationMatrix(shrunk.covariance);
  if (!correlation) return null;
  return { labels, correlation, covariance: shrunk.covariance, shrinkageIntensity: shrunk.intensity, returnCount: count };
}

/** The drawdown from peak equity, in percent, from an account snapshot. */
export function drawdownFromPeak(input: { equity: number; peakEquity: number | null | undefined }): number {
  const peak = Math.max(input.peakEquity ?? 0, input.equity);
  if (!(peak > 0)) return 0;
  return Math.max(0, ((peak - input.equity) / peak) * 100);
}

/** Realised volatility of a return series, per bar (for report context). */
export function realisedVolatility(returns: number[]): number {
  return stdev(returns);
}
