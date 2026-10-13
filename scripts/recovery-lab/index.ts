/**
 * M9 — Reproducible Recovery Quality Pipeline v2 Lab Simulator.
 *
 * Imports the real autonomous-hedge modules and evaluates v1 vs v2 across:
 *   - 19 Deriv synthetic markets
 *   - Contract sets A, B, C
 *   - Worlds: (1) NULL, (2) PLANTED (+5 pp Even on market 0),
 *             (3) MARKOV (P(same parity) = 0.55 on market 0),
 *             (4) REGIME (+4 pp Over 4 after tick 3000 on market 0)
 *   - >= 6 seeds x >= 6000 ticks
 *
 * Prints full comparative tables + ladder-episode stats (Instant & Split,
 * base 1, cap 50) + Acceptance table A1–A6.
 */

import {
  HEDGE_WINDOW,
  hedgeGroupIndex,
  mulberry32,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/constants";
import {
  buildMarketCandidates,
  type HedgeCandidate,
  type HedgeContractType,
  type HedgeFamilySpec,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/hedge-analysis";
import { recoveryRiskWeight } from "../../artifacts/api-server/src/lib/autonomous-hedge/recovery-risk";
import { decideHedge } from "../../artifacts/api-server/src/lib/autonomous-hedge/contest";
import { applySettlement, type HedgeMemory } from "../../artifacts/api-server/src/lib/autonomous-hedge/hedge-state";
import {
  EvidenceTracker,
  type EvidenceRow,
  type MarketTapeInput,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/evidence";
import {
  simulateEpisodeStats,
  type EpisodeStats,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/ladder-outcomes";
import {
  buildV2RecoveryDecision,
  scoreV2Candidates,
  type V2LadderConfig,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/score-v2";
import { TimingV2Controller } from "../../artifacts/api-server/src/lib/autonomous-hedge/timing-v2";
import { resolveOneTickOutcome } from "../../artifacts/api-server/src/lib/autonomous-hedge/shadow-ledger";

export const LAB_MARKETS: readonly string[] = [
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",
  "1HZ10V",
  "1HZ15V",
  "1HZ25V",
  "1HZ30V",
  "1HZ50V",
  "1HZ75V",
  "1HZ90V",
  "1HZ100V",
  "RDBULL",
  "RDBEAR",
  "JD10",
  "JD25",
  "JD50",
  "JD75",
];

export type ContractSetId = "A" | "B" | "C";
export type WorldId = "NULL" | "PLANTED" | "MARKOV" | "REGIME";

export const CONTRACT_SETS: Record<ContractSetId, HedgeFamilySpec[]> = {
  // Set A: Rise, Fall, Over 3, Under 6, Even, Odd
  A: [
    { type: "CALL", barrier: -1 },
    { type: "PUT", barrier: -1 },
    { type: "DIGITOVER", barrier: 3 },
    { type: "DIGITUNDER", barrier: 6 },
    { type: "DIGITEVEN", barrier: -1 },
    { type: "DIGITODD", barrier: -1 },
  ],
  // Set B: Rise, Fall, Over 4, Under 5, Even, Odd, Matches auto, Differs auto
  B: [
    { type: "CALL", barrier: -1 },
    { type: "PUT", barrier: -1 },
    { type: "DIGITOVER", barrier: 4 },
    { type: "DIGITUNDER", barrier: 5 },
    { type: "DIGITEVEN", barrier: -1 },
    { type: "DIGITODD", barrier: -1 },
    { type: "DIGITMATCH", barrier: -1 },
    { type: "DIGITDIFF", barrier: -1 },
  ],
  // Set C: Over 2, Over 5, Under 3, Under 7, Rise, Fall, Even, Matches auto
  C: [
    { type: "CALL", barrier: -1 },
    { type: "PUT", barrier: -1 },
    { type: "DIGITOVER", barrier: 2 },
    { type: "DIGITOVER", barrier: 5 },
    { type: "DIGITUNDER", barrier: 3 },
    { type: "DIGITUNDER", barrier: 7 },
    { type: "DIGITEVEN", barrier: -1 },
    { type: "DIGITMATCH", barrier: -1 },
  ],
};

const ALL_UNION_SPECS: HedgeFamilySpec[] = (() => {
  const seen = new Set<string>();
  const list: HedgeFamilySpec[] = [];
  for (const setId of ["A", "B", "C"] as const) {
    for (const spec of CONTRACT_SETS[setId]) {
      const k = `${spec.type}:${spec.barrier}`;
      if (!seen.has(k)) {
        seen.add(k);
        list.push(spec);
      }
    }
  }
  return list;
})();

export interface ScorerRunStats {
  scorer: "v1" | "v2";
  world: WorldId;
  setId: ContractSetId;
  trades: number;
  wins: number;
  winRate: number;
  predictedEv: number;
  realisedEv: number;
  evErrorPp: number;
  lossRuns8Per1k: number;
  lossRuns10Per1k: number;
  maxLossRun: number;
  plantedShareAll: number;
  plantedShareAfter2000: number;
  medianWaitTicks: number;
  p99WaitTicks: number;
  instantEpisode: EpisodeStats;
  splitEpisode: EpisodeStats;
}

const EVEN_DIGITS = [0, 2, 4, 6, 8];
const ODD_DIGITS = [1, 3, 5, 7, 9];
const OVER4_DIGITS = [5, 6, 7, 8, 9];
const UNDER5_DIGITS = [0, 1, 2, 3, 4];

/**
 * Coupled CRN digit draw from a single uniform `u in [0, 1)` so all 4 worlds
 * share identical uniforms per (market, tick).
 */
function drawDigitFromUniform(
  u: number,
  world: WorldId,
  marketIdx: number,
  tickIdx: number,
  prevDigit: number,
): number {
  if (marketIdx === 0) {
    if (world === "PLANTED") {
      // +5 pp Even bias on market 0: P(Even) = 0.55
      if (u < 0.55) {
        const bucket = Math.min(4, Math.floor((u / 0.55) * 5));
        return EVEN_DIGITS[bucket]!;
      }
      const bucket = Math.min(4, Math.floor(((u - 0.55) / 0.45) * 5));
      return ODD_DIGITS[bucket]!;
    }
    if (world === "MARKOV") {
      // P(next digit parity equals last) = 0.55 on market 0
      const prevEven = (prevDigit & 1) === 0;
      const sameParity = u < 0.55;
      const wantEven = sameParity ? prevEven : !prevEven;
      const subU = sameParity ? u / 0.55 : (u - 0.55) / 0.45;
      const bucket = Math.min(4, Math.floor(subU * 5));
      return wantEven ? EVEN_DIGITS[bucket]! : ODD_DIGITS[bucket]!;
    }
    if (world === "REGIME" && tickIdx >= 3000) {
      // +4 pp Over 4 bias after tick 3000 on market 0: P(digit > 4) = 0.54
      if (u < 0.54) {
        const bucket = Math.min(4, Math.floor((u / 0.54) * 5));
        return OVER4_DIGITS[bucket]!;
      }
      const bucket = Math.min(4, Math.floor(((u - 0.54) / 0.46) * 5));
      return UNDER5_DIGITS[bucket]!;
    }
  }
  return Math.min(9, Math.floor(u * 10));
}

function isPlantedTarget(
  world: WorldId,
  setId: ContractSetId,
  tickIdx: number,
  lastDigitOnMarket0: number,
  symbol: string,
  contract: HedgeContractType,
  barrier: number,
): boolean {
  if (symbol !== LAB_MARKETS[0]) return false;
  if (world === "PLANTED") {
    return contract === "DIGITEVEN";
  }
  if (world === "MARKOV") {
    const lastEven = (lastDigitOnMarket0 & 1) === 0;
    if (setId === "C") {
      return lastEven && contract === "DIGITEVEN";
    }
    return lastEven ? contract === "DIGITEVEN" : contract === "DIGITODD";
  }
  if (world === "REGIME") {
    if (tickIdx < 3000) return false;
    if (setId === "B") return contract === "DIGITOVER" && barrier === 4;
    if (setId === "A") return contract === "DIGITOVER" && barrier === 3;
    if (setId === "C") return contract === "DIGITOVER" && barrier === 5;
  }
  return false;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx]!;
}

interface FamilyAccumulator {
  trades: number;
  wins: number;
  payout: number;
}

interface RawAccumulator {
  trades: number;
  wins: number;
  sumPredEv: number;
  sumRealEv: number;
  sumPayout: number;
  lossRuns8: number;
  lossRuns10: number;
  maxLossRun: number;
  plantedAllCount: number;
  plantedEligibleAll: number;
  plantedAfter2000Count: number;
  plantedAfter2000Total: number;
  waitTicks: number[];
  families: Map<string, FamilyAccumulator>;
}

function createAccumulator(): RawAccumulator {
  return {
    trades: 0,
    wins: 0,
    sumPredEv: 0,
    sumRealEv: 0,
    sumPayout: 0,
    lossRuns8: 0,
    lossRuns10: 0,
    maxLossRun: 0,
    plantedAllCount: 0,
    plantedEligibleAll: 0,
    plantedAfter2000Count: 0,
    plantedAfter2000Total: 0,
    waitTicks: [],
    families: new Map(),
  };
}

function recordFamilyTrade(acc: RawAccumulator, contract: string, payout: number, won: boolean): void {
  const key = `${contract}:${payout.toFixed(2)}`;
  let fam = acc.families.get(key);
  if (!fam) {
    fam = { trades: 0, wins: 0, payout };
    acc.families.set(key, fam);
  }
  fam.trades += 1;
  if (won) fam.wins += 1;
}

function reweightV1RowForEscalation(row: HedgeCandidate, escalation: number): HedgeCandidate {
  if (escalation === 0) return row;
  const rw = recoveryRiskWeight(escalation);
  const deltaScore = 18 * (rw - 1) * (row.posteriorEdgeProbability - 0.5 - row.lossRunRisk);
  return {
    ...row,
    riskWeight: rw,
    score: row.score + deltaScore,
  };
}

function rowBelongsToSpecList(row: HedgeCandidate, specs: HedgeFamilySpec[]): boolean {
  for (const s of specs) {
    if (s.type !== row.contract) continue;
    if (s.type === "DIGITMATCH" || s.type === "DIGITDIFF") {
      if (s.barrier < 0 || s.barrier === row.barrier) return true;
    } else if (s.barrier === row.barrier) {
      return true;
    }
  }
  return false;
}

function evRowBelongsToSpecList(row: EvidenceRow, specs: HedgeFamilySpec[]): boolean {
  for (const s of specs) {
    if (s.type === row.spec.type && s.barrier === row.spec.barrier) return true;
  }
  return false;
}

const ladderConfig: V2LadderConfig = {
  method: "instant",
  autoMode: true,
  multiplier: 1.62,
  step: 1,
  maxRecoverySteps: 3,
  debt: 1,
  targetRemaining: 0.95,
  base: 1,
  maxTradeStake: 50,
  balance: 1000,
  consecutiveLossLimit: 10,
  currentLossRun: 1,
  hardStop: false,
};

function finalizeAccumulator(
  scorer: "v1" | "v2",
  world: WorldId,
  setId: ContractSetId,
  acc: RawAccumulator,
): ScorerRunStats {
  const trades = Math.max(1, acc.trades);
  const winRate = acc.wins / trades;
  const predictedEv = acc.sumPredEv / trades;
  const realisedEv = acc.sumRealEv / trades;
  const evErrorPp = Math.abs(predictedEv - realisedEv) * 100;
  const sortedWaits = [...acc.waitTicks].sort((a, b) => a - b);

  const computeWeightedEpisode = (method: "instant" | "split"): EpisodeStats => {
    if (acc.families.size === 0) {
      return simulateEpisodeStats({
        p: Math.min(0.99, Math.max(0.01, winRate)),
        payout: 1.95,
        method,
        autoMode: true,
        multiplier: 1.62,
        step: 1,
        maxRecoverySteps: 3,
        debt: 1,
        targetRemaining: 0.95,
        base: 1,
        maxTradeStake: 50,
        balance: 1000,
        nStop: 8,
        paths: 2000,
        horizon: 40,
        seed: 0x12345678,
      });
    }
    let meanPnl = 0;
    let es5 = 0;
    let pStop = 0;
    let pCapHit = 0;
    let meanTrades = 0;
    for (const fam of acc.families.values()) {
      const weight = fam.trades / trades;
      const famP = Math.min(0.99, Math.max(0.01, fam.wins / Math.max(1, fam.trades)));
      const ep = simulateEpisodeStats({
        p: famP,
        payout: fam.payout > 1 ? fam.payout : 1.95,
        method,
        autoMode: true,
        multiplier: 1.62,
        step: 1,
        maxRecoverySteps: 3,
        debt: 1,
        targetRemaining: 0.95,
        base: 1,
        maxTradeStake: 50,
        balance: 1000,
        nStop: 8,
        paths: 2000,
        horizon: 40,
        seed: 0x12345678,
      });
      meanPnl += weight * ep.meanPnl;
      es5 += weight * ep.es5;
      pStop += weight * ep.pStop;
      pCapHit += weight * ep.pCapHit;
      meanTrades += weight * ep.meanTrades;
    }
    return { meanPnl, es5, pStop, pCapHit, meanTrades };
  };

  return {
    scorer,
    world,
    setId,
    trades: acc.trades,
    wins: acc.wins,
    winRate,
    predictedEv,
    realisedEv,
    evErrorPp,
    lossRuns8Per1k: (acc.lossRuns8 / trades) * 1000,
    lossRuns10Per1k: (acc.lossRuns10 / trades) * 1000,
    maxLossRun: acc.maxLossRun,
    plantedShareAll: acc.plantedAllCount / Math.max(1, acc.plantedEligibleAll),
    plantedShareAfter2000: acc.plantedAfter2000Count / Math.max(1, acc.plantedAfter2000Total),
    medianWaitTicks: quantile(sortedWaits, 0.5),
    p99WaitTicks: quantile(sortedWaits, 0.99),
    instantEpisode: computeWeightedEpisode("instant"),
    splitEpisode: computeWeightedEpisode("split"),
  };
}

/**
 * Evaluate all requested worlds and contract sets in a single coupled-CRN pass per seed.
 * Markets 1..18 are identical across worlds for a given seed, so their v1 and v2
 * candidates are computed once per tick and combined with each world's Market 0.
 */
export function runCoupledGridSimulation(options?: {
  worlds?: readonly WorldId[];
  setIds?: readonly ContractSetId[];
  seeds?: readonly number[];
  ticksPerSeed?: number;
}): Map<string, { v1: ScorerRunStats; v2: ScorerRunStats }> {
  const worlds = options?.worlds ?? (["NULL", "PLANTED", "MARKOV", "REGIME"] as const);
  const setIds = options?.setIds ?? (["A", "B", "C"] as const);
  const seeds = options?.seeds ?? [101, 202, 303, 404, 505, 606];
  const totalTicks = options?.ticksPerSeed ?? 6000;
  const warmupTicks = 120;
  const numMarkets = LAB_MARKETS.length;

  const accMap = new Map<string, { v1: RawAccumulator; v2: RawAccumulator }>();
  for (const w of worlds) {
    for (const s of setIds) {
      accMap.set(`${w}:${s}`, { v1: createAccumulator(), v2: createAccumulator() });
    }
  }

  const seqBySymbol = new Map<string, number>();

  for (const seed of seeds) {
    const rng = mulberry32(seed * 99991 + 17);

    // Pre-generate shared markets 1..18 + per-world market 0
    const sharedDigits: number[][] = Array.from({ length: numMarkets }, () => new Array<number>(totalTicks));
    const sharedPrices: number[][] = Array.from({ length: numMarkets }, () => new Array<number>(totalTicks));
    const m0DigitsByWorld = new Map<WorldId, number[]>();
    for (const w of worlds) {
      m0DigitsByWorld.set(w, new Array<number>(totalTicks));
    }

    for (let m = 0; m < numMarkets; m++) {
      let price = 1000;
      const prevByWorld: Record<WorldId, number> = {
        NULL: 0,
        PLANTED: 0,
        MARKOV: 0,
        REGIME: 0,
      };
      for (let t = 0; t < totalTicks; t++) {
        const uDigit = rng();
        const uPrice = rng();
        price = Math.max(10, price + (uPrice < 0.5 ? 0.01 : -0.01));
        sharedPrices[m]![t] = price;
        if (m === 0) {
          for (const w of worlds) {
            const d = drawDigitFromUniform(uDigit, w, 0, t, prevByWorld[w]);
            prevByWorld[w] = d;
            m0DigitsByWorld.get(w)![t] = d;
          }
          sharedDigits[0]![t] = m0DigitsByWorld.get(worlds[0]!)![t]!;
        } else {
          sharedDigits[m]![t] = Math.min(9, Math.floor(uDigit * 10));
        }
      }
    }

    // Shared EvidenceTrackers for markets 1..18 per contract set (identical across worlds)
    const sharedEvTrackerBySet = new Map<ContractSetId, EvidenceTracker>();
    for (const setId of setIds) {
      sharedEvTrackerBySet.set(setId, new EvidenceTracker());
    }

    // Per-(world, setId) state + Market 0 EvidenceTracker
    const cellState = new Map<
      string,
      {
        v1Memory: HedgeMemory;
        v1LossRun: number;
        v1WaitCounter: number;
        m0Evidence: EvidenceTracker;
        v2Timing: TimingV2Controller;
        v2LossRun: number;
      }
    >();
    for (const w of worlds) {
      for (const s of setIds) {
        cellState.set(`${w}:${s}`, {
          v1Memory: {},
          v1LossRun: 0,
          v1WaitCounter: 0,
          m0Evidence: new EvidenceTracker(),
          v2Timing: new TimingV2Controller(),
          v2LossRun: 0,
        });
      }
    }

    for (let t = warmupTicks; t < totalTicks - 1; t++) {
      const seq = t + 1;
      for (let m = 0; m < numMarkets; m++) {
        seqBySymbol.set(LAB_MARKETS[m]!, seq);
      }

      const v1Start = Math.max(0, t + 1 - HEDGE_WINDOW);
      const v2AvailTicks = Math.min(1500, t + 1);

      // 1. Build v1 rows for shared markets 1..18 ONCE
      const sharedV1Rows: HedgeCandidate[] = [];
      for (let m = 1; m < numMarkets; m++) {
        const symbol = LAB_MARKETS[m]!;
        sharedV1Rows.push(
          ...buildMarketCandidates({
            symbol,
            group: hedgeGroupIndex(symbol),
            digits: sharedDigits[m]!.slice(v1Start, t + 1),
            prices: sharedPrices[m]!.slice(v1Start, t + 1),
            tickSequence: seq,
            specs: ALL_UNION_SPECS,
            mode: "RECOVERY",
            escalation: 0,
          }),
        );
      }

      // 2. Build v1 rows for Market 0 per world
      const m0V1RowsByWorld = new Map<WorldId, HedgeCandidate[]>();
      const m0PricesSlice = sharedPrices[0]!.slice(v1Start, t + 1);
      for (const w of worlds) {
        const m0Digits = m0DigitsByWorld.get(w)!;
        m0V1RowsByWorld.set(
          w,
          buildMarketCandidates({
            symbol: LAB_MARKETS[0]!,
            group: hedgeGroupIndex(LAB_MARKETS[0]!),
            digits: m0Digits.slice(v1Start, t + 1),
            prices: m0PricesSlice,
            tickSequence: seq,
            specs: ALL_UNION_SPECS,
            mode: "RECOVERY",
            escalation: 0,
          }),
        );
      }

      // 3. Evaluate v2 EvidenceTracker for shared markets 1..18 ONCE per setId
      const sharedEvRowsBySet = new Map<ContractSetId, EvidenceRow[]>();
      const sharedV1FilteredBySet = new Map<ContractSetId, HedgeCandidate[]>();
      for (const setId of setIds) {
        const specs = CONTRACT_SETS[setId];
        sharedV1FilteredBySet.set(
          setId,
          sharedV1Rows.filter((r) => rowBelongsToSpecList(r, specs)),
        );
        const sharedInputs: MarketTapeInput[] = [];
        for (let m = 1; m < numMarkets; m++) {
          sharedInputs.push({
            symbol: LAB_MARKETS[m]!,
            digits:
              t === warmupTicks
                ? sharedDigits[m]!.slice(0, t + 1)
                : [sharedDigits[m]![t - 1]!, sharedDigits[m]![t]!],
            prices:
              t === warmupTicks
                ? sharedPrices[m]!.slice(0, t + 1)
                : [sharedPrices[m]![t - 1]!, sharedPrices[m]![t]!],
            availableTicks: v2AvailTicks,
            tickSequence: seq,
            specs,
          });
        }
        sharedEvRowsBySet.set(
          setId,
          sharedEvTrackerBySet.get(setId)!.evaluate({
            markets: sharedInputs,
            marketsScanned: numMarkets,
            specsInSet: specs.length,
            evidenceWeight: 1,
          }),
        );
      }

      // Per-tick caches for shared markets 1..18 keyed by `${setId}:${lossRunBucket}`
      const sharedV1TopMemo = new Map<string, HedgeCandidate[]>();
      const sharedV2TopMemo = new Map<string, ReturnType<typeof scoreV2Candidates>>();

      // 4. Step each (world, setId) cell
      for (const w of worlds) {
        const m0Digits = m0DigitsByWorld.get(w)!;
        const lastDigitM0 = m0Digits[t]!;
        const m0V1Base = m0V1RowsByWorld.get(w)!;

        for (const setId of setIds) {
          const cellKey = `${w}:${setId}`;
          const specs = CONTRACT_SETS[setId];
          const st = cellState.get(cellKey)!;
          const accs = accMap.get(cellKey)!;
          const accV1 = accs.v1;
          const accV2 = accs.v2;

          // ── v1 decision ──
          const escV1 = Math.min(6, st.v1LossRun);
          const v1MemoKey = `${setId}:${escV1}`;
          let sharedTopV1 = sharedV1TopMemo.get(v1MemoKey);
          if (!sharedTopV1) {
            const reweighted = sharedV1FilteredBySet
              .get(setId)!
              .map((r) => reweightV1RowForEscalation(r, escV1));
            reweighted.sort((a, b) => b.score - a.score);
            // Top 3 rows across shared markets 1..18 suffice because applyRematch penalizes at most 1 key
            sharedTopV1 = reweighted.slice(0, 3);
            sharedV1TopMemo.set(v1MemoKey, sharedTopV1);
          }

          const v1Rows: HedgeCandidate[] = [...sharedTopV1];
          for (const r of m0V1Base) {
            if (rowBelongsToSpecList(r, specs)) {
              v1Rows.push(reweightV1RowForEscalation(r, escV1));
            }
          }

          const v1Dec = decideHedge({
            rows: v1Rows,
            mode: "RECOVERY",
            memory: st.v1Memory,
            lossRun: Math.max(1, st.v1LossRun),
            escalation: escV1,
          });

          if (v1Dec && v1Dec.eligible) {
            const chosen = v1Dec.best;
            const mIdx = LAB_MARKETS.indexOf(chosen.symbol);
            const digitsArr = mIdx === 0 ? m0Digits : sharedDigits[mIdx]!;
            const nextDigit = digitsArr[t + 1]!;
            const nextPrice = sharedPrices[mIdx]![t + 1]!;
            const curPrice = sharedPrices[mIdx]![t]!;
            const won =
              resolveOneTickOutcome(
                { contract: chosen.contract, barrier: chosen.barrier, lastPrice: curPrice },
                { digit: nextDigit, price: nextPrice, prevPrice: curPrice },
              ) === 1;

            accV1.trades += 1;
            if (won) accV1.wins += 1;
            accV1.sumPredEv += chosen.ev;
            accV1.sumRealEv += won ? chosen.payout - 1 : -1;
            accV1.sumPayout += chosen.payout;
            accV1.waitTicks.push(st.v1WaitCounter);
            recordFamilyTrade(accV1, chosen.contract, chosen.payout, won);
            st.v1WaitCounter = 0;

            const isPlanted = isPlantedTarget(
              w,
              setId,
              t,
              lastDigitM0,
              chosen.symbol,
              chosen.contract,
              chosen.barrier,
            );
            accV1.plantedEligibleAll += 1;
            if (isPlanted) accV1.plantedAllCount += 1;
            if (t >= 2000) {
              accV1.plantedAfter2000Total += 1;
              if (isPlanted) accV1.plantedAfter2000Count += 1;
            }

            if (won) {
              st.v1LossRun = 0;
            } else {
              st.v1LossRun += 1;
              if (st.v1LossRun === 8) accV1.lossRuns8 += 1;
              if (st.v1LossRun === 10) accV1.lossRuns10 += 1;
              if (st.v1LossRun > accV1.maxLossRun) accV1.maxLossRun = st.v1LossRun;
            }

            applySettlement(st.v1Memory, {
              won,
              key: chosen.key,
              lossRun: Math.max(1, st.v1LossRun),
              decisionSequence: seq,
            });
          } else {
            st.v1WaitCounter += 1;
          }

          // ── v2 decision ──
          const m0EvRows = st.m0Evidence.evaluate({
            markets: [
              {
                symbol: LAB_MARKETS[0]!,
                digits:
                  t === warmupTicks ? m0Digits.slice(0, t + 1) : [m0Digits[t - 1]!, m0Digits[t]!],
                prices:
                  t === warmupTicks
                    ? sharedPrices[0]!.slice(0, t + 1)
                    : [sharedPrices[0]![t - 1]!, sharedPrices[0]![t]!],
                availableTicks: v2AvailTicks,
                tickSequence: seq,
                specs,
              },
            ],
            marketsScanned: numMarkets,
            specsInSet: specs.length,
            evidenceWeight: 1,
          });

          const lossRunBucket = Math.min(9, st.v2LossRun);
          const escV2 = Math.min(6, st.v2LossRun);
          const v2MemoKey = `${setId}:${lossRunBucket}`;
          let sharedTopV2 = sharedV2TopMemo.get(v2MemoKey);
          if (!sharedTopV2) {
            const fullSharedRanked = scoreV2Candidates({
              evidenceRows: sharedEvRowsBySet.get(setId)!,
              tickSequenceBySymbol: seqBySymbol,
              ladder: {
                ...ladderConfig,
                currentLossRun: lossRunBucket,
              },
              escalation: escV2,
            });
            sharedTopV2 = fullSharedRanked.slice(0, 2);
            sharedV2TopMemo.set(v2MemoKey, sharedTopV2);
          }

          const m0Ranked = scoreV2Candidates({
            evidenceRows: m0EvRows,
            tickSequenceBySymbol: seqBySymbol,
            ladder: {
              ...ladderConfig,
              currentLossRun: lossRunBucket,
            },
            escalation: escV2,
          });
          const v2Ranked = [...m0Ranked, ...sharedTopV2];
          v2Ranked.sort((a, b) => {
            if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
            const dJ = a.J - b.J;
            if (Math.abs(dJ) >= 0.001) return dJ;
            if (Math.abs(b.zTilde - a.zTilde) > 1e-6) return b.zTilde - a.zTilde;
            if (a.tieHash !== b.tieHash) return a.tieHash - b.tieHash;
            return a.key.localeCompare(b.key);
          });

          if (v2Ranked.length > 0) {
            const bestV2 = v2Ranked[0]!;
            let baselineJ = bestV2.nullJ;
            for (const c of v2Ranked) {
              if (c.nullJ < baselineJ) baselineJ = c.nullJ;
            }
            const timing = st.v2Timing.evaluate({
              bestJ: bestV2.J,
              baselineJ,
              tickSequence: seq,
              nowMs: seq * 1000,
            });
            const v2Dec = buildV2RecoveryDecision({
              ranked: v2Ranked,
              escalation: escV2,
              waitTicks: timing.waitTicks,
              shouldFireNow: timing.shouldFire,
              waitReason: timing.reason,
            });

            if (v2Dec && v2Dec.eligible) {
              const chosen = bestV2;
              const mIdx = LAB_MARKETS.indexOf(chosen.symbol);
              const digitsArr = mIdx === 0 ? m0Digits : sharedDigits[mIdx]!;
              const nextDigit = digitsArr[t + 1]!;
              const nextPrice = sharedPrices[mIdx]![t + 1]!;
              const curPrice = sharedPrices[mIdx]![t]!;
              const won =
                resolveOneTickOutcome(
                  { contract: chosen.contract, barrier: chosen.barrier, lastPrice: curPrice },
                  { digit: nextDigit, price: nextPrice, prevPrice: curPrice },
                ) === 1;

              accV2.trades += 1;
              if (won) accV2.wins += 1;
              accV2.sumPredEv += chosen.ev;
              accV2.sumRealEv += won ? chosen.payout - 1 : -1;
              accV2.sumPayout += chosen.payout;
              accV2.waitTicks.push(timing.waitTicks);
              recordFamilyTrade(accV2, chosen.contract, chosen.payout, won);

              const isPlanted = isPlantedTarget(
                w,
                setId,
                t,
                lastDigitM0,
                chosen.symbol,
                chosen.contract,
                chosen.barrier,
              );
              accV2.plantedEligibleAll += 1;
              if (isPlanted) accV2.plantedAllCount += 1;
              if (t >= 2000) {
                accV2.plantedAfter2000Total += 1;
                if (isPlanted) accV2.plantedAfter2000Count += 1;
              }

              if (won) {
                st.v2LossRun = 0;
              } else {
                st.v2LossRun += 1;
                if (st.v2LossRun === 8) accV2.lossRuns8 += 1;
                if (st.v2LossRun === 10) accV2.lossRuns10 += 1;
                if (st.v2LossRun > accV2.maxLossRun) accV2.maxLossRun = st.v2LossRun;
              }
            }
          }
        }
      }
    }
  }

  const out = new Map<string, { v1: ScorerRunStats; v2: ScorerRunStats }>();
  for (const w of worlds) {
    for (const s of setIds) {
      const cellKey = `${w}:${s}`;
      const accs = accMap.get(cellKey)!;
      out.set(cellKey, {
        v1: finalizeAccumulator("v1", w, s, accs.v1),
        v2: finalizeAccumulator("v2", w, s, accs.v2),
      });
    }
  }
  return out;
}

export function runWorldSetSimulation(options: {
  world: WorldId;
  setId: ContractSetId;
  seeds?: readonly number[];
  ticksPerSeed?: number;
}): { v1: ScorerRunStats; v2: ScorerRunStats } {
  const res = runCoupledGridSimulation({
    worlds: [options.world],
    setIds: [options.setId],
    seeds: options.seeds,
    ticksPerSeed: options.ticksPerSeed,
  });
  return res.get(`${options.world}:${options.setId}`)!;
}

export interface LabReport {
  results: Array<{
    world: WorldId;
    setId: ContractSetId;
    v1: ScorerRunStats;
    v2: ScorerRunStats;
  }>;
  acceptance: {
    A1: { pass: boolean; v2Value: number; v1Value: number; threshold: string };
    A2: { pass: boolean; v2Value: number; v1Value: number; threshold: string };
    A3: { pass: boolean; v2Value: number; v1Value: number; threshold: string };
    A4: { pass: boolean; v2Median: number; v2P99: number; threshold: string };
    A5: { pass: boolean; v2Value: number; v1Value: number; diffPp: number; threshold: string };
  };
}

export function runFullLab(options?: {
  seeds?: readonly number[];
  ticksPerSeed?: number;
  silent?: boolean;
}): LabReport {
  const seeds = options?.seeds ?? [101, 202, 303, 404, 505, 606];
  const ticksPerSeed = options?.ticksPerSeed ?? 6000;
  const worlds: WorldId[] = ["NULL", "PLANTED", "MARKOV", "REGIME"];
  const sets: ContractSetId[] = ["A", "B", "C"];

  if (!options?.silent) {
    console.log(
      `\n=== Recovery Quality Pipeline v2 Lab (19 markets, ${seeds.length} seeds x ${ticksPerSeed} ticks) ===\n`,
    );
    console.log(
      [
        "World".padEnd(8),
        "Set".padEnd(4),
        "Ver".padEnd(4),
        "Trades".padEnd(7),
        "WinRate".padEnd(8),
        "PredEV".padEnd(9),
        "RealEV".padEnd(9),
        "|dEV|".padEnd(8),
        "Run>=8/1k".padEnd(9),
        "Run>=10/1k".padEnd(10),
        "MaxRun".padEnd(7),
        "Planted>2k".padEnd(11),
        "Wait50/99".padEnd(9),
        "Inst(u/ES5)".padEnd(14),
        "Split(u/ES5)".padEnd(14),
      ].join(" | "),
    );
    console.log("-".repeat(163));
  }

  const grid = runCoupledGridSimulation({
    worlds,
    setIds: sets,
    seeds,
    ticksPerSeed,
  });

  const results: Array<{
    world: WorldId;
    setId: ContractSetId;
    v1: ScorerRunStats;
    v2: ScorerRunStats;
  }> = [];

  for (const world of worlds) {
    for (const setId of sets) {
      const pair = grid.get(`${world}:${setId}`)!;
      results.push({ world, setId, v1: pair.v1, v2: pair.v2 });

      if (!options?.silent) {
        for (const s of [pair.v1, pair.v2]) {
          console.log(
            [
              s.world.padEnd(8),
              s.setId.padEnd(4),
              s.scorer.padEnd(4),
              String(s.trades).padEnd(7),
              `${(s.winRate * 100).toFixed(2)}%`.padEnd(8),
              `${(s.predictedEv * 100).toFixed(2)}%`.padEnd(9),
              `${(s.realisedEv * 100).toFixed(2)}%`.padEnd(9),
              `${s.evErrorPp.toFixed(2)}pp`.padEnd(8),
              s.lossRuns8Per1k.toFixed(2).padEnd(9),
              s.lossRuns10Per1k.toFixed(2).padEnd(10),
              String(s.maxLossRun).padEnd(7),
              `${(s.plantedShareAfter2000 * 100).toFixed(1)}%`.padEnd(11),
              `${s.medianWaitTicks}/${s.p99WaitTicks}`.padEnd(9),
              `${s.instantEpisode.meanPnl.toFixed(2)}/${s.instantEpisode.es5.toFixed(1)}`.padEnd(14),
              `${s.splitEpisode.meanPnl.toFixed(2)}/${s.splitEpisode.es5.toFixed(1)}`.padEnd(14),
            ].join(" | "),
          );
        }
      }
    }
  }

  const nullB = results.find((r) => r.world === "NULL" && r.setId === "B")!;
  const plantedB = results.find((r) => r.world === "PLANTED" && r.setId === "B")!;

  const a1Pass = nullB.v2.lossRuns10Per1k <= 0.8;
  const a2Pass = nullB.v2.evErrorPp <= 1.5;
  const a3Pass = plantedB.v2.plantedShareAfter2000 >= 0.5;
  const a4Pass = nullB.v2.medianWaitTicks === 0 && nullB.v2.p99WaitTicks <= 3;
  const evDiffPp = (nullB.v2.realisedEv - nullB.v1.realisedEv) * 100;
  const a5Pass = evDiffPp >= -1.0;

  const acceptance = {
    A1: {
      pass: a1Pass,
      v2Value: nullB.v2.lossRuns10Per1k,
      v1Value: nullB.v1.lossRuns10Per1k,
      threshold: "<= 0.8 per 1000 trades",
    },
    A2: {
      pass: a2Pass,
      v2Value: nullB.v2.evErrorPp,
      v1Value: nullB.v1.evErrorPp,
      threshold: "<= 1.5 pp",
    },
    A3: {
      pass: a3Pass,
      v2Value: plantedB.v2.plantedShareAfter2000 * 100,
      v1Value: plantedB.v1.plantedShareAfter2000 * 100,
      threshold: ">= 50.0% after 2000 ticks",
    },
    A4: {
      pass: a4Pass,
      v2Median: nullB.v2.medianWaitTicks,
      v2P99: nullB.v2.p99WaitTicks,
      threshold: "median = 0, p99 <= 3 ticks",
    },
    A5: {
      pass: a5Pass,
      v2Value: nullB.v2.realisedEv * 100,
      v1Value: nullB.v1.realisedEv * 100,
      diffPp: evDiffPp,
      threshold: "v2 >= v1 - 1.0 pp",
    },
  };

  if (!options?.silent) {
    console.log("\n=== Acceptance Criteria (Set B, >= 6 seeds x 6000 ticks) ===");
    console.log(
      `A1 (Loss runs >= 10 / 1k): v2=${acceptance.A1.v2Value.toFixed(2)} vs v1=${acceptance.A1.v1Value.toFixed(2)} [${acceptance.A1.threshold}] -> ${acceptance.A1.pass ? "PASS" : "FAIL"}`,
    );
    console.log(
      `A2 (|Pred EV - Real EV|):  v2=${acceptance.A2.v2Value.toFixed(2)} pp vs v1=${acceptance.A2.v1Value.toFixed(2)} pp [${acceptance.A2.threshold}] -> ${acceptance.A2.pass ? "PASS" : "FAIL"}`,
    );
    console.log(
      `A3 (Planted share >2000):  v2=${acceptance.A3.v2Value.toFixed(1)}% vs v1=${acceptance.A3.v1Value.toFixed(1)}% [${acceptance.A3.threshold}] -> ${acceptance.A3.pass ? "PASS" : "FAIL"}`,
    );
    console.log(
      `A4 (Wait ticks 50/99):     v2=${acceptance.A4.v2Median}/${acceptance.A4.v2P99} [${acceptance.A4.threshold}] -> ${acceptance.A4.pass ? "PASS" : "FAIL"}`,
    );
    console.log(
      `A5 (Realised EV null):     v2=${acceptance.A5.v2Value.toFixed(2)}% vs v1=${acceptance.A5.v1Value.toFixed(2)}% (diff ${acceptance.A5.diffPp >= 0 ? "+" : ""}${acceptance.A5.diffPp.toFixed(2)} pp) [${acceptance.A5.threshold}] -> ${acceptance.A5.pass ? "PASS" : "FAIL"}`,
    );
  }

  return { results, acceptance };
}

// Run when invoked directly as CLI script
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (process.argv[1].endsWith("recovery-lab/index.ts") || process.argv[1].endsWith("recovery-lab"));

if (isMain) {
  runFullLab();
}
