/**
 * Accumulator-specific research and risk model.
 *
 * This module deliberately does not share the digit-bot recovery model. An
 * accumulator compounds its stake while the underlying remains inside a
 * broker-defined dynamic range, but one breach can make the whole contract
 * worthless. The useful unit of analysis is therefore a survival probability
 * over a tick horizon, not a single win probability.
 *
 * All estimates are conservative diagnostics, not a profitability promise. The
 * broker's contracts_for/proposal response is authoritative for barriers,
 * durations, and payout; the values in this file are a screening fallback when
 * no quote is available yet.
 */

export const ACCUMULATOR_GROWTH_RATES = [0.01, 0.02, 0.03, 0.04, 0.05] as const;
export type AccumulatorGrowthRate = (typeof ACCUMULATOR_GROWTH_RATES)[number];

export const ACCUMULATOR_MIN_STAKE = 0.35;
export const ACCUMULATOR_DEFAULT_DURATION_TICKS = 60;
export const ACCUMULATOR_MIN_DURATION_TICKS = 1;
export const ACCUMULATOR_MAX_DURATION_TICKS = 230;
export const ACCUMULATOR_MIN_HISTORY = 180;
export const ACCUMULATOR_SCAN_HISTORY = 900;
export const ACCUMULATOR_DEFAULT_TARGET_TICKS = 8;
export const ACCUMULATOR_MAX_TARGET_TICKS = 45;

/** A broker quote may replace this estimate at runtime. */
const FALLBACK_BARRIER_PCT = {
  /** Product examples place 1% growth at a wider dynamic range than 5%. */
  lowGrowth: 0.000064867741,
  highGrowth: 0.000049358253,
};

export interface AccumulatorMarketInput {
  symbol: string;
  displayName: string;
  prices: number[];
  /** Optional broker-observed barrier as a fractional price move. */
  brokerBarrierPct?: number;
  /** Optional contract-for maximum; never replaced by a hard-coded ceiling. */
  brokerMaxTicks?: number;
  /** Optional minimum duration returned by the broker. */
  brokerMinTicks?: number;
  /** Per-growth-rate tick caps, e.g. { "0.05": 60, "0.01": 230 }. */
  brokerMaxTicksByGrowth?: Record<string, number>;
}

export interface AccumulatorRiskEstimate {
  samples: number;
  returnVolatility: number;
  recentVolatility: number;
  barrierPct: number;
  barrierSigma: number;
  oneTickHazard: number;
  oneTickHazardUpper: number;
  survivalProbability: number;
  survivalLower: number;
  knockoutProbability: number;
  targetTicks: number;
  durationTicks: number;
  compoundedFactor: number;
  netReturnMultiplier: number;
  breakEvenSurvival: number;
  expectedNetReturn: number;
  lowerExpectedNetReturn: number;
  markovStayInside: number;
  markovKnockoutGivenRecent: number;
  regime: "calm" | "mixed" | "hot";
  recentShock: number;
  maxObservedSafeRun: number;
  p95SafeRun: number;
  effectiveSamples: number;
  bootstrapPaths: number;
}

export interface AccumulatorCandidate {
  symbol: string;
  displayName: string;
  growthRate: AccumulatorGrowthRate;
  growthRatePct: number;
  barrierPct: number;
  barrierSource: "broker" | "screening-estimate";
  targetTicks: number;
  durationTicks: number;
  compoundedFactor: number;
  netReturnMultiplier: number;
  breakEvenSurvival: number;
  survivalProbability: number;
  survivalLower: number;
  knockoutProbability: number;
  oneTickHazard: number;
  oneTickHazardUpper: number;
  markovStayInside: number;
  markovKnockoutGivenRecent: number;
  returnVolatility: number;
  recentVolatility: number;
  regime: "calm" | "mixed" | "hot";
  recentShock: number;
  expectedNetReturn: number;
  lowerExpectedNetReturn: number;
  kellyFraction: number;
  score: number;
  deployable: boolean;
  reason: string;
  signals: string[];
  samples: number;
  maxObservedSafeRun: number;
  p95SafeRun: number;
}

export interface AccumulatorAnalysisOptions {
  growthRate?: number | "auto";
  /** Broker-supported growth rates discovered by contracts_for. */
  growthRates?: number[];
  targetTicks?: number;
  durationTicks?: number;
  minEdge?: number;
  minSurvivalMargin?: number;
  bootstrapPaths?: number;
  brokerBarrierPct?: number;
  brokerMaxTicks?: number;
  brokerMinTicks?: number;
  /**
   * Per-growth-rate tick caps (keyed by growth rate, e.g. "0.05" → 60).
   * ACCU max duration shrinks as growth rises, so the global max is only a
   * ceiling — this map carries the actual cap for each tested rate.
   */
  brokerMaxTicksByGrowth?: Record<string, number>;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function finitePrices(values: number[]): number[] {
  return values.filter((p) => Number.isFinite(p) && p > 0);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1);
}

function std(values: number[]): number {
  return Math.sqrt(Math.max(0, variance(values)));
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

function logReturns(prices: number[]): number[] {
  const clean = finitePrices(prices);
  const out: number[] = [];
  for (let i = 1; i < clean.length; i++) {
    const r = Math.log(clean[i]! / clean[i - 1]!);
    if (Number.isFinite(r)) out.push(r);
  }
  return out;
}

function wilsonLower(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = clamp(successes / total, 0, 1);
  const z2 = z * z;
  const den = 1 + z2 / total;
  return clamp((p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / den, 0, 1);
}

function wilsonUpper(events: number, total: number, z = 1.96): number {
  if (total <= 0) return 1;
  const p = clamp(events / total, 0, 1);
  const z2 = z * z;
  const den = 1 + z2 / total;
  return clamp((p + z2 / (2 * total) + z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / den, 0, 1);
}

/**
 * Estimate the fallback dynamic barrier between the two documented product
 * endpoints. It is intentionally marked an estimate; a broker quote always
 * wins. Growth rate is a decimal: .01, .02, ... .05.
 */
export function estimatedBarrierPct(growthRate: number): number {
  const g = clamp(growthRate, 0.01, 0.05);
  const t = (g - 0.01) / 0.04;
  return FALLBACK_BARRIER_PCT.lowGrowth
    + (FALLBACK_BARRIER_PCT.highGrowth - FALLBACK_BARRIER_PCT.lowGrowth) * t;
}

export function isAccumulatorGrowthRate(value: number): value is AccumulatorGrowthRate {
  return ACCUMULATOR_GROWTH_RATES.some((g) => Math.abs(g - value) < 1e-9);
}

export function normalizeGrowthRate(value: number | "auto" | undefined): AccumulatorGrowthRate | "auto" {
  if (value === "auto" || value === undefined || !Number.isFinite(value)) return "auto";
  let best: AccumulatorGrowthRate = ACCUMULATOR_GROWTH_RATES[0]!;
  for (const g of ACCUMULATOR_GROWTH_RATES) {
    if (Math.abs(g - value) < Math.abs(best - value)) best = g;
  }
  return best;
}

function seeded(seed: number): () => number {
  let state = (Math.abs(Math.trunc(seed)) + 0x9e3779b9) >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function effectiveSampleSize(values: number[]): number {
  if (values.length < 3) return values.length;
  const m = mean(values);
  let num = 0;
  let den = 0;
  for (const x of values) den += (x - m) ** 2;
  for (let i = 1; i < values.length; i++) num += (values[i]! - m) * (values[i - 1]! - m);
  const rho = den > 0 ? clamp(num / den, -0.95, 0.95) : 0;
  return clamp(values.length * (1 - rho) / (1 + rho), 1, values.length);
}

function autocorrelation(values: number[]): number {
  if (values.length < 3) return 0;
  const m = mean(values);
  let den = 0;
  let num = 0;
  for (const x of values) den += (x - m) ** 2;
  for (let i = 1; i < values.length; i++) num += (values[i]! - m) * (values[i - 1]! - m);
  return den > 0 ? clamp(num / den, -0.99, 0.99) : 0;
}

function barrierEvents(returns: number[], barrier: number): { hits: number; total: number; maxSafeRun: number; runs: number[] } {
  const threshold = Math.max(1e-9, Math.abs(Math.log1p(barrier)));
  let hits = 0;
  let safeRun = 0;
  let maxSafeRun = 0;
  const safeRuns: number[] = [];
  for (const r of returns) {
    if (Math.abs(r) >= threshold) {
      hits++;
      safeRuns.push(safeRun);
      maxSafeRun = Math.max(maxSafeRun, safeRun);
      safeRun = 0;
    } else {
      safeRun++;
    }
  }
  safeRuns.push(safeRun);
  maxSafeRun = Math.max(maxSafeRun, safeRun);
  return { hits, total: returns.length, maxSafeRun, runs: safeRuns };
}

function blockBootstrapSurvival(
  returns: number[],
  threshold: number,
  targetTicks: number,
  paths: number,
  seed: number,
): { survived: number; safeRuns: number[] } {
  if (returns.length === 0 || targetTicks <= 0) return { survived: 0, safeRuns: [] };
  const random = seeded(seed);
  const blockLength = clamp(Math.round(2 + Math.abs(autocorrelation(returns)) * 8), 2, 10);
  let survived = 0;
  const safeRuns: number[] = [];
  for (let path = 0; path < paths; path++) {
    let safe = true;
    let run = 0;
    let localMax = 0;
    let cursor = Math.floor(random() * returns.length);
    for (let t = 0; t < targetTicks; t++) {
      if (t % blockLength === 0) cursor = Math.floor(random() * returns.length);
      const r = returns[(cursor + (t % blockLength)) % returns.length]!;
      if (Math.abs(r) >= threshold) {
        safe = false;
        break;
      }
      run++;
      localMax = Math.max(localMax, run);
    }
    if (safe) survived++;
    safeRuns.push(localMax);
  }
  return { survived, safeRuns };
}

function chooseDuration(requested: number | undefined, brokerMin: number | undefined, brokerMax: number | undefined): number {
  const low = clamp(Math.round(brokerMin ?? ACCUMULATOR_MIN_DURATION_TICKS), ACCUMULATOR_MIN_DURATION_TICKS, ACCUMULATOR_MAX_DURATION_TICKS);
  const high = clamp(Math.round(brokerMax ?? ACCUMULATOR_MAX_DURATION_TICKS), low, ACCUMULATOR_MAX_DURATION_TICKS);
  return clamp(Math.round(requested ?? ACCUMULATOR_DEFAULT_DURATION_TICKS), low, high);
}

function chooseTargetTicks(
  requested: number | undefined,
  duration: number,
  growthRate: number,
): number {
  // The early-close target is deliberately shorter than the contract duration.
  // A user can request a higher tick target, but the engine will never trade a
  // target longer than the broker-constrained contract minus one tick.
  const defaultTarget = requested ?? ACCUMULATOR_DEFAULT_TARGET_TICKS;
  const minimum = Math.min(2, Math.max(1, duration - 1));
  const max = Math.min(ACCUMULATOR_MAX_TARGET_TICKS, Math.max(minimum, duration - 1));
  void growthRate;
  return clamp(Math.round(defaultTarget), minimum, max);
}

function candidateScore(risk: AccumulatorRiskEstimate, minEdge: number, minMargin: number): number {
  const edge = clamp((risk.lowerExpectedNetReturn - minEdge) / 0.25, 0, 1);
  const margin = clamp((risk.survivalLower - risk.breakEvenSurvival - minMargin) / 0.20, 0, 1);
  const hazard = clamp(1 - risk.oneTickHazardUpper / 0.25, 0, 1);
  const regime = risk.regime === "calm" ? 1 : risk.regime === "mixed" ? 0.55 : 0.05;
  const stability = clamp(risk.markovStayInside - risk.markovKnockoutGivenRecent + 0.5, 0, 1);
  return Math.round(100 * (
    0.34 * edge + 0.30 * margin + 0.16 * hazard + 0.12 * regime + 0.08 * stability
  ));
}

export function estimateAccumulatorRisk(
  prices: number[],
  growthRate: number,
  options: {
    targetTicks?: number;
    durationTicks?: number;
    brokerBarrierPct?: number;
    brokerMaxTicks?: number;
    brokerMinTicks?: number;
    /** Per-growth-rate tick caps; the cap for THIS growth rate wins. */
    brokerMaxTicksByGrowth?: Record<string, number>;
    bootstrapPaths?: number;
    seed?: number;
  } = {},
): AccumulatorRiskEstimate {
  const clean = finitePrices(prices);
  const returns = logReturns(clean);
  const barrierPct = Number.isFinite(options.brokerBarrierPct)
    && (options.brokerBarrierPct ?? 0) > 0
    ? options.brokerBarrierPct!
    : estimatedBarrierPct(growthRate);
  // The per-growth-rate cap is the binding constraint: at 5% growth the
  // exchange allows far fewer ticks than at 1%. Fall back to the global
  // broker max only when no per-rate cap is known.
  const perRateMax = options.brokerMaxTicksByGrowth
    ? Number(options.brokerMaxTicksByGrowth[String(growthRate)])
    : undefined;
  const effectiveMax = perRateMax !== undefined && Number.isFinite(perRateMax)
    ? perRateMax
    : options.brokerMaxTicks;
  const durationTicks = chooseDuration(options.durationTicks, options.brokerMinTicks, effectiveMax);
  const targetTicks = chooseTargetTicks(options.targetTicks, durationTicks, growthRate);
  const threshold = Math.max(1e-9, Math.abs(Math.log1p(barrierPct)));
  const events = barrierEvents(returns, barrierPct);
  const recent = returns.slice(-Math.min(120, returns.length));
  const recentVolatility = std(recent);
  const returnVolatility = std(returns);
  const recentAbs = recent.map(Math.abs);
  const recentShock = returnVolatility > 0 ? recentAbs.length ? quantile(recentAbs, 0.9) / returnVolatility : 0 : 0;
  const hazardUpper = wilsonUpper(events.hits, Math.max(1, events.total));
  const oneTickHazard = events.total ? events.hits / events.total : 1;

  const safe = returns.filter((r) => Math.abs(r) < threshold).length;
  const effective = Math.max(1, Math.round(effectiveSampleSize(returns)));
  const paths = Math.max(80, Math.min(800, Math.round(options.bootstrapPaths ?? 240)));
  const boot = blockBootstrapSurvival(returns, threshold, targetTicks, paths, options.seed ?? clean.length * 17 + Math.round(growthRate * 1000));
  const survivalProbability = paths > 0 ? boot.survived / paths : 0;
  const survivalLower = paths > 0 ? wilsonLower(boot.survived, paths) : 0;

  // A two-state Markov read: safe/knockout. The conditional hazard following a
  // recent shock catches volatility clustering that an IID estimate misses.
  let safeToSafe = 0;
  let safeTransitions = 0;
  let shockToHit = 0;
  let shockTransitions = 0;
  for (let i = 1; i < returns.length; i++) {
    const previousShock = Math.abs(returns[i - 1]!) >= threshold * 0.65;
    const currentHit = Math.abs(returns[i]!) >= threshold;
    if (previousShock) {
      shockTransitions++;
      if (currentHit) shockToHit++;
    } else {
      safeTransitions++;
      if (!currentHit) safeToSafe++;
    }
  }
  const markovStayInside = (safeToSafe + 1) / (safeTransitions + 2);
  // A no-shock sample contains no conditional row. Use a small knockout prior
  // rather than the uninformative 50% Beta(1,1) midpoint, which would make a
  // perfectly calm market look like a hot one merely because the row is empty.
  const shockPrior = 0.05;
  const markovKnockoutGivenRecent = (shockToHit + shockPrior) / (shockTransitions + 1);
  const regime = recentVolatility <= returnVolatility * 0.85
    ? "calm"
    : recentVolatility >= returnVolatility * 1.25 || recentShock >= 2.1
      ? "hot"
      : "mixed";

  const compoundedFactor = Math.pow(1 + growthRate, targetTicks);
  const netReturnMultiplier = Math.max(0, compoundedFactor - 1);
  const breakEvenSurvival = compoundedFactor > 0 ? 1 / compoundedFactor : 1;
  const expectedNetReturn = survivalProbability * netReturnMultiplier - (1 - survivalProbability);
  const lowerExpectedNetReturn = survivalLower * netReturnMultiplier - (1 - survivalLower);
  const runP95 = quantile(boot.safeRuns, 0.95);
  const safeRate = returns.length ? safe / returns.length : 0;

  return {
    samples: returns.length,
    returnVolatility,
    recentVolatility,
    barrierPct,
    barrierSigma: returnVolatility > 0 ? threshold / returnVolatility : 0,
    oneTickHazard,
    oneTickHazardUpper: hazardUpper,
    survivalProbability,
    survivalLower,
    knockoutProbability: 1 - survivalProbability,
    targetTicks,
    durationTicks,
    compoundedFactor,
    netReturnMultiplier,
    breakEvenSurvival,
    expectedNetReturn,
    lowerExpectedNetReturn,
    markovStayInside,
    markovKnockoutGivenRecent,
    regime,
    recentShock,
    maxObservedSafeRun: events.maxSafeRun,
    p95SafeRun: runP95,
    effectiveSamples: effective,
    bootstrapPaths: paths,
  };
}

function growthRatesToTest(value: number | "auto" | undefined, allowed?: number[]): AccumulatorGrowthRate[] {
  const supported = (allowed?.length ? allowed : [...ACCUMULATOR_GROWTH_RATES])
    .map((rate) => normalizeGrowthRate(rate))
    .filter((rate): rate is AccumulatorGrowthRate => rate !== "auto");
  const unique = [...new Set(supported)];
  const normalized = normalizeGrowthRate(value);
  if (normalized === "auto") return unique;
  return unique.includes(normalized) ? [normalized] : [];
}

export function evaluateAccumulatorMarket(
  input: AccumulatorMarketInput,
  options: AccumulatorAnalysisOptions = {},
): AccumulatorCandidate[] {
  const rates = growthRatesToTest(options.growthRate, options.growthRates);
  const candidates: AccumulatorCandidate[] = [];
  const minEdge = Number.isFinite(options.minEdge) ? options.minEdge! : 0.01;
  const minMargin = Number.isFinite(options.minSurvivalMargin) ? options.minSurvivalMargin! : 0.02;

  for (const growthRate of rates) {
    const brokerBarrier = Number.isFinite(input.brokerBarrierPct)
      ? input.brokerBarrierPct
      : options.brokerBarrierPct;
    const risk = estimateAccumulatorRisk(input.prices, growthRate, {
      targetTicks: options.targetTicks,
      durationTicks: options.durationTicks,
      brokerBarrierPct: brokerBarrier,
      brokerMaxTicks: input.brokerMaxTicks ?? options.brokerMaxTicks,
      brokerMinTicks: input.brokerMinTicks ?? options.brokerMinTicks,
      brokerMaxTicksByGrowth: input.brokerMaxTicksByGrowth ?? options.brokerMaxTicksByGrowth,
      bootstrapPaths: options.bootstrapPaths,
      seed: hashSymbol(input.symbol) + Math.round(growthRate * 1000),
    });
    const barrierSource = Number.isFinite(brokerBarrier) && (brokerBarrier ?? 0) > 0 ? "broker" : "screening-estimate";
    const margin = risk.survivalLower - risk.breakEvenSurvival;
    const deployable = risk.samples >= ACCUMULATOR_MIN_HISTORY
      && risk.lowerExpectedNetReturn >= minEdge
      && margin >= minMargin
      && risk.regime !== "hot"
      && risk.markovKnockoutGivenRecent < 0.35;
    const score = candidateScore(risk, minEdge, minMargin);
    const signals: string[] = [
      `${(growthRate * 100).toFixed(0)}% growth compounds to ${risk.compoundedFactor.toFixed(3)}× after ${risk.targetTicks} target ticks; a breach loses the full stake`,
      `survival ${Math.round(risk.survivalProbability * 100)}% (conservative lower ${Math.round(risk.survivalLower * 100)}%) vs break-even ${Math.round(risk.breakEvenSurvival * 100)}%`,
      `barrier ${barrierSource === "broker" ? "broker quote" : "screening estimate"} ${(risk.barrierPct * 100).toFixed(4)}% · ${risk.barrierSigma.toFixed(1)} return σ wide`,
      `Markov safe→safe ${(risk.markovStayInside * 100).toFixed(1)}% · shock→knockout ${(risk.markovKnockoutGivenRecent * 100).toFixed(1)}% · regime ${risk.regime}`,
      `block bootstrap ${risk.bootstrapPaths} paths, n_eff ${risk.effectiveSamples}, p95 safe run ${Math.round(risk.p95SafeRun)} ticks`,
    ];
    if (risk.lowerExpectedNetReturn < minEdge) signals.push(`⛔ lower-bound net return ${(risk.lowerExpectedNetReturn * 100).toFixed(2)}% is below the ${minEdge * 100}% edge bar`);
    if (margin < minMargin) signals.push(`⛔ survival lower bound is only ${(margin * 100).toFixed(2)}pp above break-even`);
    if (risk.regime === "hot") signals.push("⛔ hot volatility regime — wait or switch, do not average down");
    if (risk.markovKnockoutGivenRecent >= 0.35) signals.push("⛔ recent-shock Markov state has elevated knockout hazard");
    const reason = deployable
      ? `${input.displayName}: measured survival clears the compounded break-even line with a conservative margin`
      : `${input.displayName}: hold — ${risk.regime === "hot" ? "volatility regime is hot" : risk.lowerExpectedNetReturn < minEdge ? "lower-bound edge is insufficient" : "survival margin is insufficient"}`;
    const kellyFraction = clamp(
      (risk.survivalLower * risk.netReturnMultiplier - (1 - risk.survivalLower)) / Math.max(1e-9, risk.netReturnMultiplier),
      0,
      0.25,
    );
    candidates.push({
      symbol: input.symbol,
      displayName: input.displayName,
      growthRate,
      growthRatePct: growthRate * 100,
      barrierPct: risk.barrierPct,
      barrierSource,
      targetTicks: risk.targetTicks,
      durationTicks: risk.durationTicks,
      compoundedFactor: risk.compoundedFactor,
      netReturnMultiplier: risk.netReturnMultiplier,
      breakEvenSurvival: risk.breakEvenSurvival,
      survivalProbability: risk.survivalProbability,
      survivalLower: risk.survivalLower,
      knockoutProbability: risk.knockoutProbability,
      oneTickHazard: risk.oneTickHazard,
      oneTickHazardUpper: risk.oneTickHazardUpper,
      markovStayInside: risk.markovStayInside,
      markovKnockoutGivenRecent: risk.markovKnockoutGivenRecent,
      returnVolatility: risk.returnVolatility,
      recentVolatility: risk.recentVolatility,
      regime: risk.regime,
      recentShock: risk.recentShock,
      expectedNetReturn: risk.expectedNetReturn,
      lowerExpectedNetReturn: risk.lowerExpectedNetReturn,
      kellyFraction,
      score,
      deployable,
      reason,
      signals,
      samples: risk.samples,
      maxObservedSafeRun: risk.maxObservedSafeRun,
      p95SafeRun: risk.p95SafeRun,
    });
  }
  return candidates.sort((a, b) => b.score - a.score || b.lowerExpectedNetReturn - a.lowerExpectedNetReturn);
}

function hashSymbol(symbol: string): number {
  let hash = 2166136261;
  for (let i = 0; i < symbol.length; i++) hash = Math.imul(hash ^ symbol.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function rankAccumulatorCandidates(candidates: AccumulatorCandidate[]): AccumulatorCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.deployable !== b.deployable) return a.deployable ? -1 : 1;
    if (Math.abs(a.lowerExpectedNetReturn - b.lowerExpectedNetReturn) > 0.005) {
      return b.lowerExpectedNetReturn - a.lowerExpectedNetReturn;
    }
    return b.score - a.score;
  });
}

export function recoveryStakeForAccumulator(
  debt: number,
  candidate: Pick<AccumulatorCandidate, "netReturnMultiplier">,
  markupPercent: number,
  maxStake: number,
  balance: number,
): number {
  if (!Number.isFinite(debt) || debt <= 0) return 0;
  const net = Math.max(0.01, candidate.netReturnMultiplier);
  const markup = 1 + clamp(markupPercent, 0, 100) / 100;
  const byEconomics = debt * markup / net;
  const cap = Math.min(
    Number.isFinite(maxStake) && maxStake > 0 ? maxStake : Number.POSITIVE_INFINITY,
    Number.isFinite(balance) && balance > 0 ? balance * 0.10 : Number.POSITIVE_INFINITY,
  );
  return Math.max(0, Math.min(byEconomics, cap));
}

export function accumulatorTradeProfit(stake: number, candidate: Pick<AccumulatorCandidate, "compoundedFactor">, settledValue?: number): number {
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  if (Number.isFinite(settledValue)) return Number(settledValue) - stake;
  return stake * (candidate.compoundedFactor - 1);
}

/**
 * A small, explicit entry gate used by the live engine before every buy. The
 * contract's barrier is dynamic, so this gate is about observed tick health and
 * regime deterioration rather than pretending a static price barrier exists.
 */
export function accumulatorEntryGate(
  prices: number[],
  candidate: Pick<AccumulatorCandidate, "barrierPct" | "returnVolatility" | "recentVolatility" | "regime" | "survivalLower" | "breakEvenSurvival">,
): { ready: boolean; reason: string; recentMove: number; shockRatio: number } {
  const clean = finitePrices(prices);
  if (clean.length < 30) return { ready: false, reason: `warming up — ${clean.length}/30 price ticks`, recentMove: 0, shockRatio: 0 };
  const returns = logReturns(clean);
  const last = returns[returns.length - 1] ?? 0;
  const recent = returns.slice(-30);
  const recentMove = Math.abs(last);
  const baseline = Math.max(1e-9, candidate.returnVolatility, Math.abs(Math.log1p(candidate.barrierPct)) / 3);
  const recentVol = std(recent);
  const shockRatio = recentVol / baseline;
  if (Math.abs(last) >= Math.abs(Math.log1p(candidate.barrierPct)) * 0.65) {
    return { ready: false, reason: "last tick is too close to the broker's dynamic barrier estimate", recentMove, shockRatio };
  }
  if (candidate.regime === "hot" || shockRatio > 1.75) {
    return { ready: false, reason: `volatility regime deteriorated (${shockRatio.toFixed(2)}× baseline)`, recentMove, shockRatio };
  }
  if (candidate.survivalLower <= candidate.breakEvenSurvival + 0.01) {
    return { ready: false, reason: "conservative survival margin has evaporated — hold or switch", recentMove, shockRatio };
  }
  return { ready: true, reason: `entry health clear · last move ${(recentMove * 100).toFixed(3)}% · volatility ${shockRatio.toFixed(2)}×`, recentMove, shockRatio };
}

export function formatAccumulatorCandidate(c: AccumulatorCandidate): Record<string, unknown> {
  return {
    symbol: c.symbol,
    displayName: c.displayName,
    growthRate: c.growthRate,
    growthRatePct: c.growthRatePct,
    barrierPct: c.barrierPct,
    barrierSource: c.barrierSource,
    targetTicks: c.targetTicks,
    durationTicks: c.durationTicks,
    compoundedFactor: c.compoundedFactor,
    netReturnMultiplier: c.netReturnMultiplier,
    breakEvenSurvival: c.breakEvenSurvival,
    survivalProbability: c.survivalProbability,
    survivalLower: c.survivalLower,
    knockoutProbability: c.knockoutProbability,
    oneTickHazard: c.oneTickHazard,
    oneTickHazardUpper: c.oneTickHazardUpper,
    markovStayInside: c.markovStayInside,
    markovKnockoutGivenRecent: c.markovKnockoutGivenRecent,
    returnVolatility: c.returnVolatility,
    recentVolatility: c.recentVolatility,
    regime: c.regime,
    recentShock: c.recentShock,
    expectedNetReturn: c.expectedNetReturn,
    lowerExpectedNetReturn: c.lowerExpectedNetReturn,
    kellyFraction: c.kellyFraction,
    score: c.score,
    deployable: c.deployable,
    reason: c.reason,
    signals: c.signals,
    samples: c.samples,
    maxObservedSafeRun: c.maxObservedSafeRun,
    p95SafeRun: c.p95SafeRun,
  };
}
