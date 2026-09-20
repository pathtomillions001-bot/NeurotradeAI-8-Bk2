/**
 * Match Nexus: one causal, multiclass model for the NEXT digit.
 *
 * No "overdue digit" assumption, no Monte Carlo forecasts presented as facts,
 * and no independent stack of entropy/FDR/gap gates. All ten digits compete
 * inside the same prequential policy, including during held-out evaluation.
 * Predict -> decide -> observe is the order in BOTH replay and live trading.
 */
import { MATCH_PAYOUT } from "./payouts";
import { evidenceValue, wilsonLower } from "./killshot-analysis";
import {
  addMoney,
  applyRecoveryStakeLimits,
  calculateBotRecoveryStake,
} from "./recovery-math";

export const NEXUS_VERSION = "nexus-2";
export const NEXUS_HISTORY = 4999;
export const NEXUS_MIN_HISTORY = 300;
export type NexusActivity = "active" | "balanced" | "patient";
export const NEXUS_PROFILES = {
  active: {
    label: "Active",
    targetFraction: 0.45,
    uncertaintyWeight: 0.05,
    patienceTicks: 8,
  },
  balanced: {
    label: "Balanced",
    targetFraction: 0.28,
    uncertaintyWeight: 0.2,
    patienceTicks: 12,
  },
  patient: {
    label: "Patient",
    targetFraction: 0.15,
    uncertaintyWeight: 0.45,
    patienceTicks: 20,
  },
} as const;
export const NEXUS_EXPERTS = [
  "Fair baseline",
  "Slow frequency",
  "Fast frequency",
  "Markov 1",
  "Markov 2",
  "Renewal",
] as const;
const PRIOR_WEIGHTS = [0.3, 0.15, 0.15, 0.2, 0.1, 0.1];
const GAP_BOUNDS = [0, 1, 2, 3, 5, 8, 12, 18, 27, 40, 64, Infinity];
const WINDOW = 2048;
const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
const rounded = (x: number, places = 5) => Number(x.toFixed(places));
const normalize = (xs: number[]) => {
  const sum = xs.reduce((a, b) => a + b, 0);
  return xs.map((x) => x / sum);
};
const gapBucket = (gap: number) =>
  GAP_BOUNDS.findIndex((bound) => gap <= bound);
const validDigit = (d: number) => Number.isInteger(d) && d >= 0 && d <= 9;

export interface NexusPrediction {
  probabilities: number[];
  sigma: number[];
  gaps: number[];
  entropy: number;
  samples: number;
  contextSamples: number;
  experts: Array<{ name: string; weight: number; probabilities: number[] }>;
}
interface RawPrediction {
  probabilities: number[];
  sigma: number[];
  experts: NexusPrediction["experts"];
  contextSamples: number;
}

/** Bounded memory; constant work per tick. predict() never advances the model. */
export class NexusModel {
  private ring = new Int8Array(WINDOW);
  private size = 0;
  private cursor = 0;
  private n = 0;
  private slow = new Float64Array(10);
  private fast = new Float64Array(10);
  private m1 = new Float64Array(100);
  private n1 = new Float64Array(10);
  private m2 = new Float64Array(1000);
  private n2 = new Float64Array(100);
  private hazardN = new Float64Array(10 * GAP_BOUNDS.length);
  private hazardWins = new Float64Array(10 * GAP_BOUNDS.length);
  private gaps = new Array<number>(10).fill(0);
  private seen = new Array<boolean>(10).fill(false);
  private logScores = new Array<number>(NEXUS_EXPERTS.length).fill(0);
  private cached: RawPrediction | null = null;

  get samples(): number {
    return this.n;
  }
  private at(index: number): number {
    return this.ring[(this.cursor - this.size + index + WINDOW) % WINDOW]!;
  }

  private raw(): RawPrediction {
    if (this.cached) return this.cached;
    const slowN = this.slow.reduce((a, b) => a + b, 0);
    const fastN = this.fast.reduce((a, b) => a + b, 0);
    const marginal = Array.from(this.slow, (x) => (x + 2) / (slowN + 20));
    const recent = Array.from(this.fast, (x) => (x + 3) / (fastN + 30));
    const last = this.size ? this.at(this.size - 1) : 0;
    const context = this.size > 1 ? this.at(this.size - 2) * 10 + last : 0;
    const n1 = this.size ? this.n1[last]! : 0;
    const n2 = this.size > 1 ? this.n2[context]! : 0;
    const order1 = marginal.map(
      (p, d) => (this.m1[last * 10 + d]! + 40 * p) / (n1 + 40),
    );
    const order2 = order1.map(
      (p, d) => (this.m2[context * 10 + d]! + 30 * p) / (n2 + 30),
    );
    const renewal = normalize(
      marginal.map((p, d) => {
        const idx = d * GAP_BOUNDS.length + gapBucket(this.gaps[d]!);
        // An unseen digit has a left-censored age, not a proven long drought.
        return this.seen[d]
          ? (this.hazardWins[idx]! + 30 * p) / (this.hazardN[idx]! + 30)
          : p;
      }),
    );
    const distributions = [
      new Array<number>(10).fill(0.1),
      marginal,
      recent,
      order1,
      order2,
      renewal,
    ];
    const peak = Math.max(...this.logScores);
    const weights = normalize(
      this.logScores.map((v, i) => PRIOR_WEIGHTS[i]! * Math.exp(v - peak)),
    );
    const supports = [
      Math.min(this.n, WINDOW) + 20,
      slowN + 20,
      fastN + 30,
      n1 + 40,
      n2 + 30,
      Math.max(30, slowN / 10),
    ];
    const probabilities = Array.from({ length: 10 }, (_, d) =>
      distributions.reduce((s, ps, i) => s + weights[i]! * ps[d]!, 0),
    );
    // Epistemic proxy, NOT a confidence interval: includes model disagreement.
    const sigma = probabilities.map((p, d) =>
      Math.sqrt(
        distributions.reduce((s, ps, i) => {
          const q = ps[d]!;
          return (
            s +
            weights[i]! * ((q * (1 - q)) / (supports[i]! + 1) + (q - p) ** 2)
          );
        }, 0),
      ),
    );
    this.cached = {
      probabilities,
      sigma,
      contextSamples: n2,
      experts: distributions.map((ps, i) => ({
        name: NEXUS_EXPERTS[i]!,
        weight: weights[i]!,
        probabilities: ps,
      })),
    };
    return this.cached;
  }

  predict(calibration = 1): NexusPrediction {
    const raw = this.raw();
    const alpha = clamp(calibration, 0, 1);
    const probabilities = raw.probabilities.map((p) => 0.1 + alpha * (p - 0.1));
    return {
      probabilities,
      sigma: raw.sigma.map((s) => alpha * s),
      gaps: [...this.gaps],
      entropy: -probabilities.reduce((s, p) => s + p * Math.log2(p), 0),
      samples: this.n,
      contextSamples: raw.contextSamples,
      experts: raw.experts.map((e) => ({
        ...e,
        probabilities: [...e.probabilities],
      })),
    };
  }

  observe(digit: number): void {
    if (!validDigit(digit))
      throw new Error("A digit stream must contain only integers 0–9");
    const raw = this.raw();
    // Discounted prequential log score + fixed share. Only PAST predictions
    // earn weight; complex models lose influence when they stop predicting.
    this.logScores = this.logScores.map((v, i) =>
      clamp(
        0.995 * v +
          0.4 *
            Math.log(
              Math.max(1e-8, raw.experts[i]!.probabilities[digit]!) / 0.1,
            ),
        -30,
        30,
      ),
    );
    for (let i = 0; i < this.hazardN.length; i++) {
      this.hazardN[i]! *= 0.998;
      this.hazardWins[i]! *= 0.998;
    }
    for (let d = 0; d < 10; d++) {
      this.slow[d] = this.slow[d]! * 0.999 + Number(d === digit);
      this.fast[d] = this.fast[d]! * 0.98 + Number(d === digit);
      if (this.seen[d]) {
        const idx = d * GAP_BOUNDS.length + gapBucket(this.gaps[d]!);
        this.hazardN[idx]!++;
        this.hazardWins[idx]! += Number(d === digit);
      }
      this.gaps[d] = d === digit ? 0 : this.gaps[d]! + 1;
    }
    this.seen[digit] = true;
    if (this.size === WINDOW) {
      const a = this.at(0),
        b = this.at(1),
        c = this.at(2);
      this.m1[a * 10 + b]!--;
      this.n1[a]!--;
      this.m2[(a * 10 + b) * 10 + c]!--;
      this.n2[a * 10 + b]!--;
    }
    if (this.size >= 1) {
      const a = this.at(this.size - 1);
      this.m1[a * 10 + digit]!++;
      this.n1[a]!++;
    }
    if (this.size >= 2) {
      const ab = this.at(this.size - 2) * 10 + this.at(this.size - 1);
      this.m2[ab * 10 + digit]!++;
      this.n2[ab]!++;
    }
    this.ring[this.cursor] = digit;
    this.cursor = (this.cursor + 1) % WINDOW;
    this.size = Math.min(WINDOW, this.size + 1);
    this.n++;
    this.cached = null;
  }
}

export interface NexusPolicy {
  version: typeof NEXUS_VERSION;
  activity: NexusActivity;
  digit?: number;
  calibration: number;
  threshold: number;
  fittedTicks: number;
}
export interface NexusDecision {
  digit: number;
  p: number;
  sigma: number;
  conservativeP: number;
  payout: number;
  breakEven: number;
  expectedValue: number;
  utility: number;
  threshold: number;
  ready: boolean;
  reason: string;
}

/** The SAME decision rule is replayed out of sample and used at socket-send. */
export function decideNexus(
  prediction: NexusPrediction,
  policy: NexusPolicy,
  payout = MATCH_PAYOUT,
  waitedTicks = 0,
): NexusDecision {
  if (!Number.isFinite(payout) || payout <= 1)
    throw new Error("A finite payout above 1 is required");
  if (policy.digit !== undefined && !validDigit(policy.digit))
    throw new Error("Invalid locked digit");
  const profile = NEXUS_PROFILES[policy.activity];
  const candidates =
    policy.digit === undefined
      ? Array.from({ length: 10 }, (_, d) => d)
      : [policy.digit];
  const utility = (d: number) =>
    (prediction.probabilities[d]! -
      profile.uncertaintyWeight * prediction.sigma[d]!) *
      payout -
    1;
  const digit = candidates.reduce(
    (best, d) => (utility(d) > utility(best) ? d : best),
    candidates[0]!,
  );
  const p = prediction.probabilities[digit]!;
  const sigma = prediction.sigma[digit]!;
  const conservativeP = clamp(p - profile.uncertaintyWeight * sigma, 0, 1);
  // A soft cadence preference fades with waiting, but NEVER below positive EV.
  // Active/Balanced/Patient are pacing preferences, not promised trade quotas.
  const threshold = Math.max(
    0.005,
    policy.threshold * Math.max(0, 1 - waitedTicks / profile.patienceTicks),
  );
  const score = conservativeP * payout - 1;
  const ready =
    Number.isFinite(score) &&
    prediction.samples >= NEXUS_MIN_HISTORY &&
    score >= threshold;
  const reason =
    prediction.samples < NEXUS_MIN_HISTORY
      ? `Warming up: ${prediction.samples}/${NEXUS_MIN_HISTORY} observed digits`
      : score <= 0
        ? "Waiting for positive payout-adjusted edge; a digit is never due just because it is absent"
        : !ready
          ? "Positive estimate; waiting for a better entry within the activity preference"
          : "Payout-adjusted entry is ready; checking fresh tick and risk budget";
  return {
    digit,
    p,
    sigma,
    conservativeP,
    payout,
    breakEven: 1 / payout,
    expectedValue: p * payout - 1,
    utility: score,
    threshold,
    ready,
    reason,
  };
}

export interface NexusValidation {
  trainTicks: number;
  testTicks: number;
  shots: number;
  wins: number;
  hitRate: number | null;
  lower95: number | null;
  upper95: number | null;
  meanPrediction: number | null;
  evPerStake: number | null;
  fireRate: number;
  brierSkill: number;
  logLossSkill: number;
  calibrationError: number | null;
  longestLossRun: number;
  evidenceP: number;
  adjustedEvidenceP: number;
  evidence: "supported" | "developing" | "unproven";
}
export interface NexusRisk {
  paths: number;
  horizon: number;
  sampleShots: number;
  stopProbability: number;
  targetProbability: number;
  pnl05: number;
  pnl50: number;
  pnl95: number;
  drawdown95: number;
  note: string;
}
export interface NexusRiskInput {
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxStake: number;
  markupPercent: number;
}
export interface NexusEvaluation {
  model: NexusModel;
  policy: NexusPolicy;
  prediction: NexusPrediction;
  decision: NexusDecision;
  validation: NexusValidation;
  risk: NexusRisk;
  warnings: string[];
  analysisMs: number;
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))
  ]!;
}

/** Calibration is chosen ONLY on training predictions, never on held-out wins. */
export function fitNexusCalibration(
  rows: Array<{ ps: number[]; outcome: number }>,
): number {
  if (!rows.length) return 0;
  let bestAlpha = 0,
    bestLoss = Infinity;
  for (const alpha of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    // Small complexity penalty favours the honest uniform forecast in ties.
    const loss =
      rows.reduce(
        (s, r) => s - Math.log(0.1 + alpha * (r.ps[r.outcome]! - 0.1)),
        0,
      ) +
      alpha * alpha * 2;
    if (loss < bestLoss) {
      bestLoss = loss;
      bestAlpha = alpha;
    }
  }
  return bestAlpha;
}

export function evaluateNexus(
  digits: number[],
  options: NexusRiskInput & {
    activity: NexusActivity;
    digit?: number;
    payout?: number;
    seed?: number;
  },
): NexusEvaluation {
  const started = performance.now();
  if (digits.length < NEXUS_MIN_HISTORY || digits.some((d) => !validDigit(d)))
    throw new Error(
      `At least ${NEXUS_MIN_HISTORY} valid, ordered digits are required`,
    );
  if (options.digit !== undefined && !validDigit(options.digit))
    throw new Error("Invalid digit");
  const payout = options.payout ?? MATCH_PAYOUT;
  const model = new NexusModel();
  // At least 300 training observations makes the live and replay warm-up equal.
  const trainEnd = Math.min(
    digits.length - 1,
    Math.max(NEXUS_MIN_HISTORY, Math.floor(digits.length * 0.6)),
  );
  const training: Array<{
    ps: number[];
    outcome: number;
    prediction: NexusPrediction;
  }> = [];
  for (let i = 0; i < trainEnd; i++) {
    if (i >= 120) {
      const p = model.predict();
      training.push({
        ps: p.probabilities,
        outcome: digits[i]!,
        prediction: p,
      });
    }
    model.observe(digits[i]!);
  }
  const calibration = fitNexusCalibration(training);
  const policy: NexusPolicy = {
    version: NEXUS_VERSION,
    activity: options.activity,
    digit: options.digit,
    calibration,
    threshold: 0,
    fittedTicks: trainEnd,
  };
  const scores = training.map(
    (r) =>
      decideNexus(
        {
          ...r.prediction,
          probabilities: r.ps.map((p) => 0.1 + calibration * (p - 0.1)),
          sigma: r.prediction.sigma.map((s) => calibration * s),
        },
        policy,
        payout,
      ).utility,
  );
  policy.threshold = Math.max(
    0.005,
    quantile(scores, 1 - NEXUS_PROFILES[options.activity].targetFraction),
  );

  const shots: number[] = [];
  let brier = 0,
    logLoss = 0,
    predictedSum = 0,
    wait = 0,
    run = 0,
    deepest = 0;
  for (let i = trainEnd; i < digits.length; i++) {
    const prediction = model.predict(calibration);
    const decision = decideNexus(prediction, policy, payout, wait);
    const outcome = digits[i]!; // revealed ONLY after the decision
    brier += prediction.probabilities.reduce(
      (s, p, d) => s + (p - Number(d === outcome)) ** 2,
      0,
    );
    logLoss -= Math.log(Math.max(1e-8, prediction.probabilities[outcome]!));
    if (decision.ready) {
      const won = Number(outcome === decision.digit);
      shots.push(won);
      predictedSum += decision.p;
      wait = 0;
      run = won ? 0 : run + 1;
      deepest = Math.max(deepest, run);
    } else wait++;
    model.observe(outcome);
  }
  const wins = shots.reduce((a, b) => a + b, 0),
    n = shots.length,
    ticks = digits.length - trainEnd;
  const p = n ? wins / n : null;
  const predicted = n ? predictedSum / n : null;
  const evidenceP = evidenceValue(shots, 1 / payout).pValue;
  const validation: NexusValidation = {
    trainTicks: trainEnd,
    testTicks: ticks,
    shots: n,
    wins,
    hitRate: p,
    lower95: n ? wilsonLower(wins, n, 1.96) : null,
    upper95: n ? 1 - wilsonLower(n - wins, n, 1.96) : null,
    meanPrediction: predicted,
    evPerStake: p === null ? null : p * payout - 1,
    fireRate: n / ticks,
    brierSkill: 1 - brier / (ticks * 0.9),
    logLossSkill: 1 - logLoss / (ticks * Math.log(10)),
    calibrationError:
      p === null || predicted === null ? null : Math.abs(p - predicted),
    longestLossRun: deepest,
    evidenceP,
    adjustedEvidenceP: evidenceP,
    evidence: "unproven",
  };
  const warnings = [
    "Matches wins on one digit. Even an improved estimate can lose most individual trades; recovery cannot create an edge.",
  ];
  if (n < 40)
    warnings.push(
      "Few held-out entries: win-rate and risk estimates have substantial uncertainty.",
    );
  if (calibration === 0)
    warnings.push(
      "Training did not support predictive skill: forecasts shrink to the 10% fair baseline.",
    );
  if (validation.brierSkill <= 0)
    warnings.push(
      "Held-out digit forecasts did not beat the uniform baseline on Brier score.",
    );
  if (p !== null && p * payout < 1)
    warnings.push(
      "The historical held-out entry policy had negative expectancy at the indicative payout.",
    );
  const prediction = model.predict(calibration);
  return {
    model,
    policy,
    prediction,
    decision: decideNexus(prediction, policy, payout),
    validation,
    risk: simulateNexusRisk(
      shots,
      { ...options, payout },
      options.seed ?? 20260920,
    ),
    warnings,
    analysisMs: rounded(performance.now() - started, 2),
  };
}

/** Bonferroni/Ville diagnostic across markets. Never a separate entry veto. */
export function correctNexusEvidence<T extends { validation: NexusValidation }>(
  rows: T[],
): void {
  for (const row of rows) {
    const v = row.validation;
    v.adjustedEvidenceP = Math.min(1, rows.length * v.evidenceP);
    v.evidence =
      v.shots >= 40 && v.adjustedEvidenceP <= 0.05
        ? "supported"
        : v.shots >= 20 && (v.evPerStake ?? -1) > 0
          ? "developing"
          : "unproven";
  }
}

/** Seeded posterior-predictive risk, NOT a next-digit oracle. */
function randomSource(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gamma(shape: number, rng: () => number): number {
  if (shape < 1)
    return gamma(shape + 1, rng) * Math.max(1e-12, rng()) ** (1 / shape);
  const d = shape - 1 / 3,
    c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x =
      Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) *
      Math.cos(2 * Math.PI * rng());
    const base = 1 + c * x;
    if (base <= 0) continue;
    const v = base ** 3,
      u = Math.max(1e-12, rng());
    if (
      u < 1 - 0.0331 * x ** 4 ||
      Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))
    )
      return d * v;
  }
}
function beta(a: number, b: number, rng: () => number): number {
  const x = gamma(a, rng);
  return x / (x + gamma(b, rng));
}

export function simulateNexusRisk(
  shots: number[],
  risk: NexusRiskInput & { payout: number },
  seed = 20260920,
  paths = 512,
  horizon = 100,
): NexusRisk {
  const rng = randomSource(seed);
  const wins = shots.reduce((a, b) => a + b, 0);
  // A fair-digit prior is deliberately conservative when there are few shots.
  const base = (wins + 1) / (shots.length + 10);
  const n = [0, 0],
    w = [0, 0];
  for (let i = 1; i < shots.length; i++) {
    n[shots[i - 1]!]!++;
    w[shots[i - 1]!]! += shots[i]!;
  }
  const pnls: number[] = [],
    drawdowns: number[] = [];
  let stopped = 0,
    targeted = 0;
  for (let path = 0; path < paths; path++) {
    const p = n.map((count, i) =>
      beta(w[i]! + 10 * base, count - w[i]! + 10 * (1 - base), rng),
    );
    let pnl = 0,
      debt = 0,
      peak = 0,
      drawdown = 0,
      previous = 0;
    for (let i = 0; i < horizon; i++) {
      const room = Math.floor((risk.stopLoss + pnl + 1e-9) * 100) / 100;
      if (room < 0.35) {
        stopped++;
        break;
      }
      const stake =
        debt > 0
          ? applyRecoveryStakeLimits(
              calculateBotRecoveryStake(debt, risk.payout, risk.markupPercent),
              Math.min(risk.maxStake, room),
            )
          : risk.stake;
      if (stake > room || stake > risk.maxStake) {
        stopped++;
        break;
      }
      const won = rng() < p[previous]!;
      const profit = won ? addMoney(stake * (risk.payout - 1)) : -stake;
      pnl = addMoney(pnl, profit);
      debt = won ? Math.max(0, addMoney(debt, -profit)) : addMoney(debt, stake);
      peak = Math.max(peak, pnl);
      drawdown = Math.max(drawdown, peak - pnl);
      previous = Number(won);
      if (pnl <= -risk.stopLoss) {
        stopped++;
        break;
      }
      if (pnl >= risk.takeProfit) {
        targeted++;
        break;
      }
    }
    pnls.push(pnl);
    drawdowns.push(drawdown);
  }
  return {
    paths,
    horizon,
    sampleShots: shots.length,
    stopProbability: stopped / paths,
    targetProbability: targeted / paths,
    pnl05: rounded(quantile(pnls, 0.05), 2),
    pnl50: rounded(quantile(pnls, 0.5), 2),
    pnl95: rounded(quantile(pnls, 0.95), 2),
    drawdown95: rounded(quantile(drawdowns, 0.95), 2),
    note: "Scenario estimate, not a guarantee: posterior two-state win/loss chain, indicative payout, shared debt/markup recovery and your risk limits. No latency/slippage model. Thin samples are prior-sensitive.",
  };
}
