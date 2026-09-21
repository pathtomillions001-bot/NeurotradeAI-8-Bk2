/**
 * Over/Under Navigator — configurable digit-band analysis.
 *
 * Unlike a generic barrier bot, this policy keeps separate user-selected
 * contracts for the normal leg and the recovery leg. It uses the same
 * probability foundations as the strongest specialist engines:
 *
 * - order-1/2 digit Markov with Jeffreys smoothing;
 * - outcome-chain Markov for loss clustering;
 * - a censored hole hazard (Kaplan–Meier style);
 * - decayed suffix memory;
 * - skill-weighted logarithmic opinion pooling and temperature calibration;
 * - utility that prices the probability of extending a loss pair.
 *
 * Normal timing uses a soft pacing valve. Recovery timing uses a STATIC,
 * contract-specific fair-rate bar. The current loss run is deliberately not an
 * input to the recovery selector, so a recovery loss never hardens the bar.
 * The policy waits when no recovery contract has a positive measured setup and
 * the engine may search other markets when switching mode is enabled.
 */

import {
  DigitMarkov,
  BandMarkov,
  HoleHazard,
  SuffixMemory,
  PacingValve,
  logPoolBinary,
  temperatureScaleBinary,
  sideUtility,
  wilson,
} from "./bastion-analysis";

export type NavigatorSideMode = "both" | "over" | "under";
export type NavigatorVerdict = "prime" | "viable" | "thin";
export type NavigatorMode = "normal" | "recovery";

export interface NavigatorPlan {
  normalOver: number;
  normalUnder: number;
  recoveryOver: number;
  recoveryUnder: number;
  normalSide: NavigatorSideMode;
  recoverySide: NavigatorSideMode;
}

export interface NavigatorContract {
  id: string;
  mode: NavigatorMode;
  contractType: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
  label: string;
  wins: readonly boolean[];
  fair: number;
  payout: number;
}

export interface NavigatorParams {
  weights: [number, number, number, number];
  tau: number;
  normalInitBar: number;
}

export interface NavigatorSideRead {
  contract: NavigatorContract;
  p: number;
  pRaw: number;
  lenses: [number, number, number, number];
  qLL: number;
  pairRisk: number;
  utility: number;
  breakEven: number;
}

export interface NavigatorDecision {
  mode: NavigatorMode;
  side: NavigatorContract | null;
  read: NavigatorSideRead | null;
  alt: NavigatorSideRead | null;
  ready: boolean;
  bar: number;
  reason: string;
}

export interface NavigatorReplayMetrics {
  ticks: number;
  normalShots: number;
  normalHits: number;
  normalHitRate: number;
  normalHitRateLower: number;
  recoveryShots: number;
  recoveryHits: number;
  recoveryHitRate: number;
  recoveryHitRateLower: number;
  recoveryLossPairs: number;
  recoveryLosses: number;
  avgTicksInRecovery: number;
  paperEdgePerDollar: number;
  fireRatePer100: number;
  avgP: number;
}

export interface NavigatorMarketRead {
  verdict: NavigatorVerdict;
  confidence: number;
  paperEdgePerDollar: number;
  metrics: NavigatorReplayMetrics;
  params: NavigatorParams;
  diag: {
    weights: [number, number, number, number];
    tau: number;
    normalInitBar: number;
    recoveryBars: { over: number; under: number };
    historyUsed: number;
    qLL: { over: number; under: number };
  };
  thinData: boolean;
  normalContracts: NavigatorContract[];
  recoveryContracts: NavigatorContract[];
}

const TRAIN_FRACTION = 0.6;
const MIN_MEASURE_DIGITS = 300;
const NORMAL_PACE = 0.2;
const NORMAL_PAIR_WEIGHT = 0.15;
const RECOVERY_PAIR_WEIGHT = 0.45;
const JEFFREY_PAYOUT_FACTOR = 0.985;

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}
function logit(p: number) {
  const q = clamp01(p) * (1 - 1e-9) + 1e-9 * 0.5;
  return Math.log(q / (1 - q));
}
function sigmoid(x: number) {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}
function quantile(values: number[], q: number) {
  if (values.length === 0) return 0.8;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))
  ]!;
}
function cleanDigits(digits: ArrayLike<number>) {
  const out: number[] = [];
  for (let i = 0; i < digits.length; i++) {
    const d = digits[i]!;
    if (Number.isInteger(d) && d >= 0 && d <= 9) out.push(d);
  }
  return out;
}
function barrierLabel(type: "DIGITOVER" | "DIGITUNDER", barrier: number) {
  return `${type === "DIGITOVER" ? "Over" : "Under"} ${barrier}`;
}
function payoutFor(fair: number) {
  return Math.max(1.01, (1 / Math.max(0.01, fair)) * JEFFREY_PAYOUT_FACTOR);
}
function winsFor(type: "DIGITOVER" | "DIGITUNDER", barrier: number): boolean[] {
  return Array.from({ length: 10 }, (_, d) =>
    type === "DIGITOVER" ? d > barrier : d < barrier,
  );
}
function makeContract(
  mode: NavigatorMode,
  type: "DIGITOVER" | "DIGITUNDER",
  barrier: number,
): NavigatorContract {
  const wins = winsFor(type, barrier);
  const fair = wins.filter(Boolean).length / 10;
  return {
    id: `${mode}-${type}-${barrier}`,
    mode,
    contractType: type,
    barrier,
    label: barrierLabel(type, barrier),
    wins,
    fair,
    payout: payoutFor(fair),
  };
}

export function validateNavigatorPlan(plan: NavigatorPlan): string | null {
  const values = [
    plan.normalOver,
    plan.normalUnder,
    plan.recoveryOver,
    plan.recoveryUnder,
  ];
  if (values.some((v) => !Number.isInteger(v)))
    return "All barriers must be whole digits";
  if (plan.normalOver < 0 || plan.normalOver > 8)
    return "Normal Over must be 0–8";
  if (plan.normalUnder < 1 || plan.normalUnder > 9)
    return "Normal Under must be 1–9";
  if (plan.recoveryOver < 0 || plan.recoveryOver > 8)
    return "Recovery Over must be 0–8";
  if (plan.recoveryUnder < 1 || plan.recoveryUnder > 9)
    return "Recovery Under must be 1–9";
  return null;
}

export function contractsForPlan(plan: NavigatorPlan) {
  const error = validateNavigatorPlan(plan);
  if (error) throw new Error(error);
  const normal = [
    ...(plan.normalSide === "under"
      ? []
      : [makeContract("normal", "DIGITOVER", plan.normalOver)]),
    ...(plan.normalSide === "over"
      ? []
      : [makeContract("normal", "DIGITUNDER", plan.normalUnder)]),
  ];
  const recovery = [
    ...(plan.recoverySide === "under"
      ? []
      : [makeContract("recovery", "DIGITOVER", plan.recoveryOver)]),
    ...(plan.recoverySide === "over"
      ? []
      : [makeContract("recovery", "DIGITUNDER", plan.recoveryUnder)]),
  ];
  return { normal, recovery, all: [...normal, ...recovery] };
}

function weightsFromLogLoss(
  losses: number[],
  n: number,
): [number, number, number, number] {
  const baseline = Math.log(2);
  const skills = losses.map((v) => baseline - (n > 0 ? v / n : baseline));
  const max = Math.max(...skills);
  const exp = skills.map((v) => Math.exp((v - max) / 0.05));
  const total = exp.reduce((a, b) => a + b, 0) || 1;
  const w = exp.map((v) => 0.05 + (0.85 * v) / total);
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return [w[0]! / sum, w[1]! / sum, w[2]! / sum, w[3]! / sum];
}

export class NavigatorPolicy {
  private digits = new DigitMarkov();
  private suffix = new SuffixMemory();
  private bands = new Map<string, BandMarkov>();
  private holes = new Map<string, HoleHazard>();
  private valve: PacingValve;

  constructor(
    private readonly params: NavigatorParams,
    readonly normalContracts: readonly NavigatorContract[],
    readonly recoveryContracts: readonly NavigatorContract[],
  ) {
    for (const c of [...normalContracts, ...recoveryContracts]) {
      this.bands.set(c.id, new BandMarkov(c.wins));
      this.holes.set(c.id, new HoleHazard(c.wins.map((w) => !w)));
    }
    this.valve = new PacingValve(NORMAL_PACE, params.normalInitBar, 0);
  }

  get normalBar() {
    return this.valve.bar;
  }
  update(history: ArrayLike<number>, idx: number) {
    this.digits.update(history, idx);
    this.suffix.update(history, idx);
    for (const c of [...this.normalContracts, ...this.recoveryContracts]) {
      this.bands.get(c.id)!.update(history, idx);
      this.holes.get(c.id)!.update(history, idx);
    }
  }
  readSide(
    history: ArrayLike<number>,
    idx: number,
    contract: NavigatorContract,
  ): NavigatorSideRead {
    const dd = this.digits.dist(history, idx);
    const sd = this.suffix.dist(history, idx);
    let pD = 0;
    let pS = 0;
    for (let d = 0; d < 10; d++) {
      if (contract.wins[d]) {
        pD += dd[d]!;
        pS += sd[d]!;
      }
    }
    const pB = this.bands.get(contract.id)!.p(history, idx);
    const pH = this.holes.get(contract.id)!.p(history, idx);
    const lenses: [number, number, number, number] = [pD, pB, pH, pS];
    const pRaw = clamp01(
      sigmoid(
        lenses.reduce(
          (s, p, i) => s + (this.params.weights[i] ?? 0) * logit(p),
          0,
        ),
      ),
    );
    const p = clamp01(temperatureScaleBinary(pRaw, this.params.tau));
    const qLL = this.bands.get(contract.id)!.qLL();
    const pairWeight =
      contract.mode === "recovery" ? RECOVERY_PAIR_WEIGHT : NORMAL_PAIR_WEIGHT;
    const risk = sideUtility(p, contract.payout, qLL, pairWeight);
    return {
      contract,
      p,
      pRaw,
      lenses,
      qLL,
      pairRisk: risk.pairRisk,
      utility: risk.utility,
      breakEven: 1 / contract.payout,
    };
  }
  private best(
    history: ArrayLike<number>,
    idx: number,
    list: readonly NavigatorContract[],
  ) {
    const reads = list
      .map((c) => this.readSide(history, idx, c))
      .sort((a, b) => b.utility - a.utility);
    return { best: reads[0] ?? null, alt: reads[1] ?? null };
  }
  decideNormal(history: ArrayLike<number>, idx: number): NavigatorDecision {
    const { best, alt } = this.best(history, idx, this.normalContracts);
    if (!best)
      return {
        mode: "normal",
        side: null,
        read: null,
        alt: null,
        ready: false,
        bar: this.valve.bar,
        reason: "no normal side armed",
      };
    const ready = this.valve.observe(best.p);
    return {
      mode: "normal",
      side: best.contract,
      read: best,
      alt,
      ready,
      bar: this.valve.bar,
      reason: ready
        ? `timed ${best.contract.label} at ${(best.p * 100).toFixed(1)}%`
        : `timing valve holding (${(best.p * 100).toFixed(1)}% vs ${(this.valve.bar * 100).toFixed(1)}%)`,
    };
  }
  decideRecovery(history: ArrayLike<number>, idx: number): NavigatorDecision {
    const { best, alt } = this.best(history, idx, this.recoveryContracts);
    if (!best)
      return {
        mode: "recovery",
        side: null,
        read: null,
        alt: null,
        ready: false,
        bar: 1,
        reason: "no recovery side armed",
      };
    // Static, contract-specific bar. It cannot receive recoveryStep or loss-run.
    const ready = best.p >= best.contract.fair;
    return {
      mode: "recovery",
      side: best.contract,
      read: best,
      alt,
      ready,
      bar: best.contract.fair,
      reason: ready
        ? `best recovery setup ${best.contract.label} at ${(best.p * 100).toFixed(1)}%`
        : `holding for recovery edge (${(best.p * 100).toFixed(1)}% vs ${(best.contract.fair * 100).toFixed(0)}% static bar)`,
    };
  }
}

function replay(
  digits: number[],
  params: NavigatorParams,
  contracts: ReturnType<typeof contractsForPlan>,
  warmup: number,
): NavigatorReplayMetrics {
  const policy = new NavigatorPolicy(
    params,
    contracts.normal,
    contracts.recovery,
  );
  for (let i = 0; i < warmup; i++) policy.update(digits, i);
  let inRecovery = false,
    prevRecLoss = false,
    episodeTicks = 0,
    recTicks = 0,
    episodes = 0;
  let normalShots = 0,
    normalHits = 0,
    recoveryShots = 0,
    recoveryHits = 0,
    recoveryLosses = 0,
    pairs = 0;
  let paper = 0,
    sumP = 0;
  for (let i = warmup; i < digits.length - 1; i++) {
    if (inRecovery) episodeTicks++;
    const dec = inRecovery
      ? policy.decideRecovery(digits, i)
      : policy.decideNormal(digits, i);
    if (dec.ready && dec.side && dec.read) {
      const hit = dec.side.wins[digits[i + 1]!] ? 1 : 0;
      const payout = dec.side.payout;
      sumP += dec.read.p;
      paper += hit ? payout - 1 : -1;
      if (inRecovery) {
        recoveryShots++;
        recoveryHits += hit;
        if (!hit) {
          recoveryLosses++;
          if (prevRecLoss) pairs++;
          prevRecLoss = true;
        } else {
          prevRecLoss = false;
          inRecovery = false;
          recTicks += episodeTicks;
          episodes++;
          episodeTicks = 0;
        }
      } else {
        normalShots++;
        normalHits += hit;
        if (!hit) {
          inRecovery = true;
          prevRecLoss = false;
          episodeTicks = 0;
        }
      }
    }
    policy.update(digits, i + 1);
  }
  const measured = Math.max(1, digits.length - 1 - warmup);
  const nw = wilson(normalHits, normalShots);
  const rw = wilson(recoveryHits, recoveryShots);
  const shots = normalShots + recoveryShots;
  return {
    ticks: measured,
    normalShots,
    normalHits,
    normalHitRate: normalShots ? normalHits / normalShots : 0,
    normalHitRateLower: normalShots ? nw.lower : 0,
    recoveryShots,
    recoveryHits,
    recoveryHitRate: recoveryShots ? recoveryHits / recoveryShots : 0,
    recoveryHitRateLower: recoveryShots ? rw.lower : 0,
    recoveryLossPairs: pairs,
    recoveryLosses,
    avgTicksInRecovery: episodes ? recTicks / episodes : 0,
    paperEdgePerDollar: shots ? paper / shots : 0,
    fireRatePer100: (shots / measured) * 100,
    avgP: shots ? sumP / shots : 0,
  };
}

export function fitNavigatorParams(
  digits: number[],
  plan: NavigatorPlan,
): {
  params: NavigatorParams;
  train: NavigatorReplayMetrics;
  test: NavigatorReplayMetrics;
} {
  const contracts = contractsForPlan(plan);
  const split = Math.floor(digits.length * TRAIN_FRACTION);
  const train = digits.slice(0, split);
  const test = digits.slice(split);
  const probeParams: NavigatorParams = {
    weights: [0.25, 0.25, 0.25, 0.25],
    tau: 1,
    normalInitBar: 0.8,
  };
  const probe = new NavigatorPolicy(
    probeParams,
    contracts.normal,
    contracts.recovery,
  );
  const warm = Math.min(300, Math.max(20, Math.floor(train.length / 4)));
  for (let i = 0; i < warm && i < train.length; i++) probe.update(train, i);
  const losses = [0, 0, 0, 0];
  const vectors: Array<{ p: [number, number, number, number]; event: number }> =
    [];
  const normalScores: number[] = [];
  let n = 0;
  for (let i = warm; i < train.length - 1; i++) {
    const next = train[i + 1]!;
    for (const c of contracts.all) {
      const r = probe.readSide(train, i, c);
      const event = c.wins[next] ? 1 : 0;
      for (let j = 0; j < 4; j++)
        losses[j]! += -(event
          ? Math.log(Math.max(1e-9, r.lenses[j]!))
          : Math.log(Math.max(1e-9, 1 - r.lenses[j]!)));
      vectors.push({ p: r.lenses, event });
      n++;
    }
    const normal = contracts.normal
      .map((c) => probe.readSide(train, i, c))
      .sort((a, b) => b.utility - a.utility)[0];
    if (normal) normalScores.push(normal.p);
    probe.update(train, i + 1);
  }
  const weights = weightsFromLogLoss(losses, n);
  let tau = 1;
  let bestLL = Infinity;
  for (const t of [0.7, 0.85, 1, 1.15, 1.35, 1.6, 2]) {
    let ll = 0;
    for (const v of vectors) {
      const p = temperatureScaleBinary(logPoolBinary(v.p, weights), t);
      ll += -(v.event
        ? Math.log(Math.max(1e-9, p))
        : Math.log(Math.max(1e-9, 1 - p)));
    }
    if (ll < bestLL) {
      bestLL = ll;
      tau = t;
    }
  }
  normalScores.sort((a, b) => a - b);
  const params: NavigatorParams = {
    weights,
    tau,
    normalInitBar: quantile(normalScores, 1 - NORMAL_PACE),
  };
  const trainMetrics = replay(
    train,
    params,
    contracts,
    Math.min(250, Math.floor(train.length / 3)),
  );
  const testMetrics = replay(
    test,
    params,
    contracts,
    Math.min(250, Math.floor(test.length / 3)),
  );
  return { params, train: trainMetrics, test: testMetrics };
}

export function scoreNavigatorMarket(
  digitsInput: ArrayLike<number>,
  plan: NavigatorPlan,
): NavigatorMarketRead {
  const digits = cleanDigits(digitsInput);
  const contracts = contractsForPlan(plan);
  const thinData = digits.length < MIN_MEASURE_DIGITS;
  const fit = fitNavigatorParams(digits, plan);
  const m = fit.test;
  const live = new NavigatorPolicy(
    fit.params,
    contracts.normal,
    contracts.recovery,
  );
  for (let i = 0; i < digits.length; i++) live.update(digits, i);
  const over = contracts.recovery.find((c) => c.contractType === "DIGITOVER");
  const under = contracts.recovery.find((c) => c.contractType === "DIGITUNDER");
  const readOver = over ? live.readSide(digits, digits.length - 1, over) : null;
  const readUnder = under
    ? live.readSide(digits, digits.length - 1, under)
    : null;
  let verdict: NavigatorVerdict = "thin";
  if (
    !thinData &&
    m.paperEdgePerDollar >= 0.015 &&
    m.recoveryShots >= 5 &&
    m.normalShots >= 5
  )
    verdict = "prime";
  else if (!thinData && m.paperEdgePerDollar > -0.02 && m.recoveryShots >= 3)
    verdict = "viable";
  const confidence =
    verdict === "prime"
      ? Math.min(95, 70 + Math.round(m.paperEdgePerDollar * 500))
      : verdict === "viable"
        ? Math.min(69, 45 + Math.round(Math.max(0, m.paperEdgePerDollar) * 400))
        : Math.min(44, 25 + Math.max(0, Math.round(m.avgP * 20)));
  return {
    verdict,
    confidence,
    paperEdgePerDollar: Math.round(m.paperEdgePerDollar * 10000) / 10000,
    metrics: m,
    params: fit.params,
    diag: {
      weights: fit.params.weights,
      tau: fit.params.tau,
      normalInitBar: fit.params.normalInitBar,
      recoveryBars: { over: over?.fair ?? 0, under: under?.fair ?? 0 },
      historyUsed: digits.length,
      qLL: { over: readOver?.qLL ?? 0, under: readUnder?.qLL ?? 0 },
    },
    thinData,
    normalContracts: [...contracts.normal],
    recoveryContracts: [...contracts.recovery],
  };
}

export function contractLabel(contract: NavigatorContract | null | undefined) {
  return contract?.label ?? "—";
}
export const NAVIGATOR_MIN_MEASURE_DIGITS = MIN_MEASURE_DIGITS;
export const NAVIGATOR_RECOVERY_PAIR_WEIGHT = RECOVERY_PAIR_WEIGHT;
