/**
 * M6 — Shadow ledger for Recovery Quality Pipeline v2.
 *
 * Every fresh tick, evaluates the 1-tick outcomes on the new tick for the
 * PREVIOUS tick's:
 *   (i)   top 10 candidates by v2 score,
 *   (ii)  top 10 candidates by v1 score,
 *   (iii) one deterministic random control per contract family.
 *
 * Maintains a 20,000-record ring buffer in memory plus persistent aggregate
 * counters per scorer ("v1", "v2", "control"):
 *   - Calibration slope beta = OLS slope of (outcome - p0) on (predictedP - p0)
 *     with standard error SE
 *   - kappa = Phi(beta / SE) clipped to [0, 1]
 *   - Brier skill vs p0
 *   - Mean predicted EV and mean realised EV
 *   - edgeReport() summary
 */

import fs from "node:fs";
import path from "node:path";
import { mulberry32 } from "./constants";
import type { HedgeCandidate, HedgeContractType } from "./hedge-analysis";
import { normalCdf } from "./recovery-risk";
import type { V2ScoredCandidate } from "./score-v2";

export const SHADOW_RING_CAPACITY = 20_000;
const OLS_RIDGE_STABILIZER = 0.05;

export type ShadowScorerId = "v1" | "v2" | "control";

export interface ShadowRecord {
  scorer: ShadowScorerId;
  symbol: string;
  contract: HedgeContractType;
  barrier: number;
  tickSequence: number;
  p0: number;
  predictedP: number;
  payout: number;
  outcome: 0 | 1;
  depUsed: boolean;
}

export interface ShadowScorerCounters {
  n: number;
  sumX: number;
  sumY: number;
  sumXX: number;
  sumYY: number;
  sumXY: number;
  sumBrierModel: number;
  sumBrierBase: number;
  sumPredictedEv: number;
  sumRealisedEv: number;
  depN: number;
  depSumY: number;
  freqN: number;
  freqSumY: number;
}

export interface ShadowScorerMetrics {
  n: number;
  count: number;
  beta: number;
  se: number;
  kappa: number;
  brierSkill: number;
  meanPredictedEv: number;
  meanRealisedEv: number;
  meanExcessWinRate: number;
}

export interface PersistedShadowAggregates {
  version: 1;
  updatedAt: number;
  ticksCompared: number;
  disagreements: number;
  scorers: Record<ShadowScorerId, ShadowScorerCounters>;
}

interface PendingPick {
  scorer: ShadowScorerId;
  symbol: string;
  contract: HedgeContractType;
  barrier: number;
  tickSequence: number;
  lastPrice: number;
  p0: number;
  predictedP: number;
  payout: number;
  depUsed: boolean;
}

export interface LatestTickObservation {
  symbol: string;
  tickSequence: number;
  digit: number;
  price: number;
  prevPrice: number;
}

function emptyCounters(): ShadowScorerCounters {
  return {
    n: 0,
    sumX: 0,
    sumY: 0,
    sumXX: 0,
    sumYY: 0,
    sumXY: 0,
    sumBrierModel: 0,
    sumBrierBase: 0,
    sumPredictedEv: 0,
    sumRealisedEv: 0,
    depN: 0,
    depSumY: 0,
    freqN: 0,
    freqSumY: 0,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function resolveOneTickOutcome(
  pick: { contract: HedgeContractType; barrier: number; lastPrice: number },
  obs: { digit: number; price: number; prevPrice: number },
): 0 | 1 {
  const d = obs.digit;
  switch (pick.contract) {
    case "DIGITOVER":
      return d > pick.barrier ? 1 : 0;
    case "DIGITUNDER":
      return d < pick.barrier ? 1 : 0;
    case "DIGITEVEN":
      return (d & 1) === 0 ? 1 : 0;
    case "DIGITODD":
      return (d & 1) === 1 ? 1 : 0;
    case "DIGITMATCH":
      return d === pick.barrier ? 1 : 0;
    case "DIGITDIFF":
      return d !== pick.barrier ? 1 : 0;
    case "CALL": {
      const ref = Number.isFinite(pick.lastPrice) && pick.lastPrice > 0 ? pick.lastPrice : obs.prevPrice;
      return obs.price > ref ? 1 : 0;
    }
    case "PUT": {
      const ref = Number.isFinite(pick.lastPrice) && pick.lastPrice > 0 ? pick.lastPrice : obs.prevPrice;
      return obs.price < ref ? 1 : 0;
    }
  }
}

export function computeScorerMetrics(c: ShadowScorerCounters): ShadowScorerMetrics {
  if (c.n === 0) {
    return {
      n: 0,
      count: 0,
      beta: 0,
      se: 0,
      kappa: 0.5,
      brierSkill: 0,
      meanPredictedEv: 0,
      meanRealisedEv: 0,
      meanExcessWinRate: 0,
    };
  }

  const sigmaY2 = Math.max(0.01, c.sumYY / c.n);
  const rawTStat = c.sumXX > 1e-12 ? c.sumXY / Math.sqrt(c.sumXX * sigmaY2) : 0;
  // Empirical-Bayes prior variance floor when |tStat| < 3 and Sxx/n is tiny (shrunk null stream)
  const priorRidge = 0.0005 * c.n * Math.max(0, 1 - (rawTStat / 3) * (rawTStat / 3));
  const denom = c.sumXX + Math.max(1e-9, priorRidge);
  const beta = c.sumXX > 1e-12 ? c.sumXY / denom : 0;
  const se = c.sumXX > 1e-12 ? Math.sqrt(c.sumXX * sigmaY2) / denom : Math.sqrt(sigmaY2 / c.n);
  const kappa = c.sumXX > 1e-12 ? clamp(normalCdf(rawTStat), 0, 1) : 0.5;

  const brierModel = c.sumBrierModel / c.n;
  const brierBase = c.sumBrierBase / c.n;
  const brierSkill = brierBase > 1e-12 ? 1 - brierModel / brierBase : 0;

  return {
    n: c.n,
    count: c.n,
    beta,
    se,
    kappa,
    brierSkill,
    meanPredictedEv: c.sumPredictedEv / c.n,
    meanRealisedEv: c.sumRealisedEv / c.n,
    meanExcessWinRate: c.sumY / c.n,
  };
}

export class ShadowLedger {
  private ring: ShadowRecord[] = new Array(SHADOW_RING_CAPACITY);
  private ringCount = 0;
  private ringCursor = 0;
  private pendingPicks: PendingPick[] = [];
  private scorers: Record<ShadowScorerId, ShadowScorerCounters> = {
    v1: emptyCounters(),
    v2: emptyCounters(),
    control: emptyCounters(),
  };
  private ticksCompared = 0;
  private disagreements = 0;
  private readonly persistPath: string | null;

  constructor(options?: { persistPath?: string | null; autoLoad?: boolean }) {
    this.persistPath =
      options?.persistPath === undefined
        ? path.resolve(process.cwd(), ".data/recovery-v2-shadow-ledger.json")
        : options.persistPath;
    if (options?.autoLoad !== false && this.persistPath) {
      this.loadFromDisk();
    }
  }

  reset(): void {
    this.ringCount = 0;
    this.ringCursor = 0;
    this.pendingPicks = [];
    this.scorers = {
      v1: emptyCounters(),
      v2: emptyCounters(),
      control: emptyCounters(),
    };
    this.ticksCompared = 0;
    this.disagreements = 0;
  }

  getRingRecords(): ShadowRecord[] {
    const out: ShadowRecord[] = [];
    const start = this.ringCount < SHADOW_RING_CAPACITY ? 0 : this.ringCursor;
    for (let i = 0; i < this.ringCount; i++) {
      const idx = (start + i) % SHADOW_RING_CAPACITY;
      const rec = this.ring[idx];
      if (rec) out.push(rec);
    }
    return out;
  }

  getRingSize(): number {
    return this.ringCount;
  }

  recordOutcomeDirect(rec: ShadowRecord): void {
    this.ring[this.ringCursor] = rec;
    if (this.ringCount < SHADOW_RING_CAPACITY) this.ringCount += 1;
    this.ringCursor = (this.ringCursor + 1) % SHADOW_RING_CAPACITY;

    const c = this.scorers[rec.scorer];
    const x = rec.predictedP - rec.p0;
    const y = rec.outcome - rec.p0;
    c.n += 1;
    c.sumX += x;
    c.sumY += y;
    c.sumXX += x * x;
    c.sumYY += y * y;
    c.sumXY += x * y;
    const errModel = rec.outcome - rec.predictedP;
    const errBase = rec.outcome - rec.p0;
    c.sumBrierModel += errModel * errModel;
    c.sumBrierBase += errBase * errBase;
    c.sumPredictedEv += rec.predictedP * rec.payout - 1;
    c.sumRealisedEv += rec.outcome * rec.payout - 1;
    if (rec.depUsed) {
      c.depN += 1;
      c.depSumY += y;
    } else {
      c.freqN += 1;
      c.freqSumY += y;
    }
  }

  /**
   * Process a new tick:
   * 1. Settle any pending picks from the previous tick whose market has a new tick.
   * 2. Register the current tick's top-10 v2, top-10 v1, and 1 random control per family.
   */
  stepTick(input: {
    observations: ReadonlyMap<string, LatestTickObservation> | Record<string, LatestTickObservation>;
    v2Ranked: readonly (Partial<V2ScoredCandidate> & HedgeCandidate)[];
    v1Ranked: readonly HedgeCandidate[];
    tickSeed?: number;
    persist?: boolean;
  }): void {
    const getObs = (symbol: string): LatestTickObservation | undefined => {
      if (input.observations instanceof Map) return input.observations.get(symbol);
      return (input.observations as Record<string, LatestTickObservation>)[symbol];
    };

    // 1. Settle previous tick's pending picks where the market advanced
    const stillPending: PendingPick[] = [];
    let settledAny = false;
    for (const pick of this.pendingPicks) {
      const obs = getObs(pick.symbol);
      if (!obs || obs.tickSequence <= pick.tickSequence) {
        stillPending.push(pick);
        continue;
      }
      const outcome = resolveOneTickOutcome(pick, obs);
      this.recordOutcomeDirect({
        scorer: pick.scorer,
        symbol: pick.symbol,
        contract: pick.contract,
        barrier: pick.barrier,
        tickSequence: obs.tickSequence,
        p0: pick.p0,
        predictedP: pick.predictedP,
        payout: pick.payout,
        outcome,
        depUsed: pick.depUsed,
      });
      settledAny = true;
    }
    this.pendingPicks = stillPending;

    // 2. Compare v1 #1 vs v2 #1
    if (input.v1Ranked.length > 0 && input.v2Ranked.length > 0) {
      this.ticksCompared += 1;
      if (input.v1Ranked[0]!.key !== input.v2Ranked[0]!.key) {
        this.disagreements += 1;
      }
    }

    // 3. Register new pending picks (top 10 v2, top 10 v1, 1 control per family)
    const nextPending: PendingPick[] = [];
    const topV2 = input.v2Ranked.slice(0, 10);
    for (const c of topV2) {
      const obs = getObs(c.symbol);
      const p0 =
        typeof c.p0 === "number" && Number.isFinite(c.p0)
          ? c.p0
          : baseProbForCandidate(c.contract, c.barrier);
      const predictedP =
        typeof c.pTilde === "number" && Number.isFinite(c.pTilde) ? c.pTilde : c.probability;
      nextPending.push({
        scorer: "v2",
        symbol: c.symbol,
        contract: c.contract,
        barrier: c.barrier,
        tickSequence: c.tickSequence,
        lastPrice: obs?.price ?? 0,
        p0,
        predictedP,
        payout: c.payout,
        depUsed: Boolean(c.depUsed),
      });
    }

    const topV1 = input.v1Ranked.slice(0, 10);
    for (const c of topV1) {
      const obs = getObs(c.symbol);
      const p0 = baseProbForCandidate(c.contract, c.barrier);
      nextPending.push({
        scorer: "v1",
        symbol: c.symbol,
        contract: c.contract,
        barrier: c.barrier,
        tickSequence: c.tickSequence,
        lastPrice: obs?.price ?? 0,
        p0,
        predictedP: c.probability,
        payout: c.payout,
        depUsed: false,
      });
    }

    // One deterministic random control per contract family
    const byFamily = new Map<HedgeContractType, (Partial<V2ScoredCandidate> & HedgeCandidate)[]>();
    for (const c of input.v2Ranked) {
      let list = byFamily.get(c.contract);
      if (!list) {
        list = [];
        byFamily.set(c.contract, list);
      }
      list.push(c);
    }
    const seed = input.tickSeed ?? (input.v2Ranked[0]?.tickSequence ?? 1);
    const rng = mulberry32(seed ^ 0x5bd1e995);
    for (const [, familyList] of byFamily) {
      if (familyList.length === 0) continue;
      const idx = Math.floor(rng() * familyList.length);
      const chosen = familyList[idx]!;
      const obs = getObs(chosen.symbol);
      const p0 = Number.isFinite(chosen.p0) ? chosen.p0! : baseProbForCandidate(chosen.contract, chosen.barrier);
      nextPending.push({
        scorer: "control",
        symbol: chosen.symbol,
        contract: chosen.contract,
        barrier: chosen.barrier,
        tickSequence: chosen.tickSequence,
        lastPrice: obs?.price ?? 0,
        p0,
        predictedP: p0,
        payout: chosen.payout,
        depUsed: false,
      });
    }

    this.pendingPicks = nextPending;

    if (settledAny && input.persist !== false) {
      this.saveToDisk();
    }
  }

  getMetrics(scorer: ShadowScorerId = "v2"): ShadowScorerMetrics {
    return computeScorerMetrics(this.scorers[scorer]);
  }

  getAllMetrics(): {
    v1: ShadowScorerMetrics;
    v2: ShadowScorerMetrics;
    control: ShadowScorerMetrics;
    ticksCompared: number;
    disagreements: number;
    disagreementRate: number;
  } {
    return {
      v1: this.getMetrics("v1"),
      v2: this.getMetrics("v2"),
      control: this.getMetrics("control"),
      ticksCompared: this.ticksCompared,
      disagreements: this.disagreements,
      disagreementRate: this.ticksCompared > 0 ? this.disagreements / this.ticksCompared : 0,
    };
  }

  /**
   * Expose kappa = Phi(beta / SE) clipped to [0, 1] for the requested scorer (default "v2").
   */
  getKappa(scorer: ShadowScorerId = "v2"): number {
    return this.getMetrics(scorer).kappa;
  }

  /**
   * Human-readable statistical diagnosis of whether any exploitable structure
   * has been detected in real out-of-sample tick outcomes.
   */
  edgeReport(scorer: ShadowScorerId = "v2"): string {
    const c = this.scorers[scorer];
    const m = computeScorerMetrics(c);
    if (c.n === 0) {
      return "no exploitable structure detected: |edge| < 0.00 pp with 95% confidence over 0 observations";
    }
    const meanY = c.sumY / c.n;
    const varY = Math.max(1e-6, c.sumYY / c.n - meanY * meanY);
    const seY = Math.sqrt(varY / c.n);
    const halfWidth95 = 1.96 * seY;
    const tBeta = m.se > 1e-12 ? m.beta / m.se : 0;

    if (c.n < 30 || (meanY <= halfWidth95 && tBeta <= 1.96)) {
      const boundPp = ((Math.abs(meanY) + halfWidth95) * 100).toFixed(2);
      return `no exploitable structure detected: |edge| < ${boundPp} pp with 95% confidence over ${c.n} observations`;
    }

    const depMean = c.depN > 0 ? c.depSumY / c.depN : Number.NEGATIVE_INFINITY;
    const freqMean = c.freqN > 0 ? c.freqSumY / c.freqN : Number.NEGATIVE_INFINITY;
    const feature = depMean > freqMean && c.depN > 0 ? "dependence (Markov transition)" : "frequency (multi-window z~)";
    const edgePp = (meanY * 100).toFixed(2);
    return `exploitable structure detected: +${edgePp} pp edge via ${feature} (beta=${m.beta.toFixed(3)} ± ${m.se.toFixed(3)}, kappa=${m.kappa.toFixed(3)}) over ${c.n} observations`;
  }

  serializeAggregates(): string {
    const payload: PersistedShadowAggregates = {
      version: 1,
      updatedAt: Date.now(),
      ticksCompared: this.ticksCompared,
      disagreements: this.disagreements,
      scorers: {
        v1: { ...this.scorers.v1 },
        v2: { ...this.scorers.v2 },
        control: { ...this.scorers.control },
      },
    };
    return JSON.stringify(payload);
  }

  hydrateAggregates(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as Partial<PersistedShadowAggregates>;
      if (!parsed || typeof parsed !== "object" || !parsed.scorers) return false;
      for (const id of ["v1", "v2", "control"] as const) {
        const src = parsed.scorers[id];
        if (src && typeof src.n === "number") {
          this.scorers[id] = {
            ...emptyCounters(),
            ...src,
          };
        }
      }
      if (typeof parsed.ticksCompared === "number") this.ticksCompared = parsed.ticksCompared;
      if (typeof parsed.disagreements === "number") this.disagreements = parsed.disagreements;
      return true;
    } catch {
      return false;
    }
  }

  exportPersistedState(): string {
    return this.serializeAggregates();
  }

  importPersistedState(json: string): boolean {
    return this.hydrateAggregates(json);
  }

  saveToDisk(filePath = this.persistPath): boolean {
    if (!filePath) return false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, this.serializeAggregates(), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  loadFromDisk(filePath = this.persistPath): boolean {
    if (!filePath || !fs.existsSync(filePath)) return false;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return this.hydrateAggregates(raw);
    } catch {
      return false;
    }
  }
}

function baseProbForCandidate(contract: HedgeContractType, barrier: number): number {
  switch (contract) {
    case "DIGITOVER":
      return (9 - barrier) / 10;
    case "DIGITUNDER":
      return barrier / 10;
    case "DIGITMATCH":
      return 0.1;
    case "DIGITDIFF":
      return 0.9;
    default:
      return 0.5;
  }
}

export const defaultShadowLedger = new ShadowLedger();

export function edgeReport(scorer: ShadowScorerId = "v2"): string {
  return defaultShadowLedger.edgeReport(scorer);
}
