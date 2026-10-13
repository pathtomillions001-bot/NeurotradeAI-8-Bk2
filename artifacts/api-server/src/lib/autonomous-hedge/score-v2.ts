/**
 * M3 — Soft cost J(c) and gate-free ranking for Recovery Quality Pipeline v2.
 *
 * Cost function (lower is better; score = -J):
 *   J(c) = -meanPnl / base + LAMBDA_TAIL * max(0, -es5) / base + LAMBDA_STOP * pStop
 *
 * - Evidence enters only through p~ from M1 (no separate bonus terms).
 * - Payout used = live quoted payout if available (M5) else table payout.
 * - No tuple penalty, no rematch penalty, no confirmation wait.
 * - Exact ties (|dJ| < 0.001) are broken by a deterministic hash of tickSequence
 *   so markets rotate fairly.
 * - Eligibility = the stake is valid under existing limits and hard safety stops pass.
 */

import { applyRecoveryStakeLimits, calculateRecoveryStakeRequest } from "../recovery-math";
import { HEDGE_GROUP_NAMES, hedgeGroupIndex, LAMBDA_STOP, LAMBDA_TAIL, mulberry32 } from "./constants";
import type { GroupWinner, HedgeDecision } from "./contest";
import type { EvidenceRow } from "./evidence";
import { candidateKey, type HedgeCandidate } from "./hedge-analysis";
import { simulateEpisodeStatsCached, type EpisodeStats } from "./ladder-outcomes";
import { payoutInfoFor } from "./quote-prefetch";

export interface V2LadderConfig {
  method: "split" | "instant";
  autoMode: boolean;
  multiplier: number;
  step: number;
  maxRecoverySteps: number;
  debt: number;
  targetRemaining: number;
  base: number;
  maxTradeStake: number;
  balance: number;
  consecutiveLossLimit: number;
  currentLossRun: number;
  hardStop?: boolean;
  lambdaTail?: number;
  lambdaStop?: number;
  seed?: number;
}

export interface V2ScoredCandidate extends HedgeCandidate {
  J: number;
  nullJ: number;
  p0: number;
  pTilde: number;
  z: number;
  zTilde: number;
  window: number;
  nEff: number;
  q: number;
  depUsed: boolean;
  edgeIndex: number;
  meanPnl: number;
  es5: number;
  pStop: number;
  pCapHit: number;
  meanTrades: number;
  payoutSource: "live" | "table";
  payoutFlag: string | null;
  tieHash: number;
}

/** Compute the v2 soft cost J(c) in units of base stakes (lower is better). */
export function computeRecoveryCostJ(input: {
  meanPnl: number;
  es5: number;
  pStop: number;
  base: number;
  lambdaTail?: number;
  lambdaStop?: number;
}): number {
  const base = Number.isFinite(input.base) && input.base > 0 ? input.base : 1;
  const lambdaTail = input.lambdaTail ?? LAMBDA_TAIL;
  const lambdaStop = input.lambdaStop ?? LAMBDA_STOP;
  return (
    -input.meanPnl / base +
    (lambdaTail * Math.max(0, -input.es5)) / base +
    lambdaStop * input.pStop
  );
}

const keyHashCache = new Map<string, number>();

function getKeyBaseHash(key: string): number {
  let h = keyHashCache.get(key);
  if (h !== undefined) return h;
  h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  if (keyHashCache.size > 4096) keyHashCache.clear();
  keyHashCache.set(key, h | 0);
  return h | 0;
}

/**
 * Deterministic hash of (tickSequence, candidateKey) in [0, 1) using mulberry32.
 * Ensures fair rotation across markets and specs when |dJ| < 0.001.
 */
export function deterministicTieHash(tickSequence: number, key: string): number {
  const baseHash = getKeyBaseHash(key);
  const mixedSeed = (baseHash ^ Math.imul((tickSequence | 0) + 1, 0x9e3779b1)) | 0;
  let t = (mixedSeed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function isRecoveryStakeEligible(
  payout: number,
  ladder: V2LadderConfig,
): { eligible: boolean; stake: number; blocker: string | null } {
  if (ladder.hardStop) {
    return { eligible: false, stake: 0, blocker: "hard safety stop active" };
  }
  const base = Number.isFinite(ladder.base) && ladder.base > 0 ? ladder.base : 1;
  const debt = ladder.debt > 0 ? ladder.debt : base;
  const requested = calculateRecoveryStakeRequest({
    unrecoveredAmount: debt,
    remainingTargetProfit: Math.max(0, ladder.targetRemaining),
    payoutMultiplier: payout,
    baseStake: base,
    recoveryAutoMode: ladder.autoMode,
    recoveryMethod: ladder.method,
    recoveryMultiplier: ladder.multiplier,
    recoveryStep: Math.max(1, ladder.step),
    maxRecoverySteps: ladder.maxRecoverySteps,
  });
  const capped = applyRecoveryStakeLimits(requested, ladder.maxTradeStake, ladder.balance);
  const stake = Math.round(capped * 100) / 100;
  if (!Number.isFinite(stake) || stake < 0.35) {
    return { eligible: false, stake, blocker: `stake ${stake.toFixed(2)} below minimum 0.35` };
  }
  if (stake > ladder.balance) {
    return { eligible: false, stake, blocker: `stake ${stake.toFixed(2)} exceeds balance ${ladder.balance.toFixed(2)}` };
  }
  if (Number.isFinite(ladder.maxTradeStake) && ladder.maxTradeStake > 0 && stake > ladder.maxTradeStake) {
    return { eligible: false, stake, blocker: `stake ${stake.toFixed(2)} exceeds maxTradeStake ${ladder.maxTradeStake.toFixed(2)}` };
  }
  return { eligible: true, stake, blocker: null };
}

export function scoreV2Candidates(input: {
  evidenceRows: EvidenceRow[];
  tickSequenceBySymbol: ReadonlyMap<string, number> | Record<string, number>;
  ladder: V2LadderConfig;
  escalation?: number;
}): V2ScoredCandidate[] {
  const { evidenceRows, ladder } = input;
  if (evidenceRows.length === 0) return [];

  const nStop = Math.max(1, (ladder.consecutiveLossLimit || 4) - (ladder.currentLossRun || 0));
  const base = Number.isFinite(ladder.base) && ladder.base > 0 ? ladder.base : 1;
  const debt = ladder.debt > 0 ? ladder.debt : base;

  const getSeq = (symbol: string): number => {
    if (input.tickSequenceBySymbol instanceof Map) {
      return input.tickSequenceBySymbol.get(symbol) ?? 0;
    }
    return (input.tickSequenceBySymbol as Record<string, number>)[symbol] ?? 0;
  };

  // Global synchronization clock for tie rotation: use the max tickSequence across markets
  let globalSequence = 0;
  for (const row of evidenceRows) {
    const seq = getSeq(row.symbol);
    if (seq > globalSequence) globalSequence = seq;
  }

  const scored: V2ScoredCandidate[] = [];
  const localEpisodeMemo = new Map<string, { episode: EpisodeStats; J: number }>();
  const localEligMemo = new Map<number, { eligible: boolean; stake: number; blocker: string | null }>();

  const evalEpisodeAndJ = (p: number, payout: number): { episode: EpisodeStats; J: number } => {
    const memoKey = `${payout}:${p}`;
    let hit = localEpisodeMemo.get(memoKey);
    if (!hit) {
      const episode = simulateEpisodeStatsCached({
        p,
        payout,
        method: ladder.method,
        autoMode: ladder.autoMode,
        multiplier: ladder.multiplier,
        step: Math.max(1, ladder.step),
        maxRecoverySteps: ladder.maxRecoverySteps,
        debt,
        targetRemaining: Math.max(0, ladder.targetRemaining),
        base,
        maxTradeStake: ladder.maxTradeStake,
        balance: ladder.balance,
        nStop,
        seed: ladder.seed,
      });
      const J = computeRecoveryCostJ({
        meanPnl: episode.meanPnl,
        es5: episode.es5,
        pStop: episode.pStop,
        base,
        lambdaTail: ladder.lambdaTail,
        lambdaStop: ladder.lambdaStop,
      });
      hit = { episode, J };
      localEpisodeMemo.set(memoKey, hit);
    }
    return hit;
  };

  for (const evRow of evidenceRows) {
    const barrier = evRow.resolvedBarrier;
    const contract = evRow.spec.type;
    const pInfo = payoutInfoFor({ symbol: evRow.symbol, contract, barrier });
    const payout = pInfo.payout;
    const tickSequence = getSeq(evRow.symbol);
    const key = candidateKey(evRow.symbol, contract, barrier);

    const { episode, J } = evalEpisodeAndJ(evRow.pTilde, payout);
    const nullJ =
      Math.abs(evRow.pTilde - evRow.p0) > 1e-9
        ? evalEpisodeAndJ(evRow.p0, payout).J
        : J;
    const score = -J;
    let elig = localEligMemo.get(payout);
    if (!elig) {
      elig = isRecoveryStakeEligible(payout, ladder);
      localEligMemo.set(payout, elig);
    }
    const breakEven = payout > 0 ? 1 / payout : 1;
    const ev = evRow.pTilde * payout - 1;
    const sigmaP = Math.sqrt((evRow.pTilde * (1 - evRow.pTilde)) / Math.max(1, evRow.nEff));
    const lowerBound = Math.max(0, evRow.pTilde - 1.282 * sigmaP);
    const losses = Math.max(0, Math.round(evRow.nEff * (1 - evRow.pTilde)));
    const tieHash = deterministicTieHash(globalSequence, key);

    scored.push({
      symbol: evRow.symbol,
      group: hedgeGroupIndex(evRow.symbol),
      contract,
      barrier,
      payout,
      tickSequence,
      key,
      samples: evRow.nEff,
      losses,
      probability: evRow.pTilde,
      lowerBound,
      breakEven,
      ev,
      markov: evRow.pTilde,
      afterLoss: evRow.pTilde,
      afterWin: evRow.pTilde,
      conditionalEdge: evRow.pTilde - breakEven,
      posteriorEdgeProbability: evRow.q,
      lossRunRisk: episode.pStop,
      recentAfterLoss: evRow.pTilde,
      recoveryAfterLoss: evRow.pTilde,
      riskWeight: 1,
      clustering: 1,
      instability: 0,
      score,
      eligible: elig.eligible,
      J,
      nullJ,
      p0: evRow.p0,
      pTilde: evRow.pTilde,
      z: evRow.z,
      zTilde: evRow.zTilde,
      window: evRow.window,
      nEff: evRow.nEff,
      q: evRow.q,
      depUsed: evRow.depUsed,
      edgeIndex: evRow.edgeIndex,
      meanPnl: episode.meanPnl,
      es5: episode.es5,
      pStop: episode.pStop,
      pCapHit: episode.pCapHit,
      meanTrades: episode.meanTrades,
      payoutSource: pInfo.source,
      payoutFlag: pInfo.flagText,
      tieHash,
    });
  }

  return rankV2Candidates(scored);
}

/**
 * Rank v2 candidates:
 * 1. Eligible first.
 * 2. Lower J (with exact ties |dJ| < 0.001 grouped into 0.001 buckets from minJ).
 * 3. Within a 0.001 J-tie, candidates with positive soft-thresholded evidence (zTilde > 0) precede zero evidence.
 * 4. Deterministic hash of tickSequence breaks ties fairly across markets and contracts.
 */
export function rankV2Candidates(rows: V2ScoredCandidate[]): V2ScoredCandidate[] {
  if (rows.length === 0) return [];
  let minJ = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    if (r.J < minJ) minJ = r.J;
  }
  return [...rows].sort((a, b) => {
    if (a.eligible !== b.eligible) return Number(b.eligible) - Number(a.eligible);
    const bucketA = Math.floor((a.J - minJ + 1e-12) / 0.001);
    const bucketB = Math.floor((b.J - minJ + 1e-12) / 0.001);
    if (bucketA !== bucketB) return bucketA - bucketB;
    const posEvA = a.zTilde > 1e-9 ? 1 : 0;
    const posEvB = b.zTilde > 1e-9 ? 1 : 0;
    if (posEvA !== posEvB) return posEvB - posEvA;
    if (a.tieHash !== b.tieHash) return a.tieHash - b.tieHash;
    return a.key.localeCompare(b.key);
  });
}

export function buildV2RecoveryDecision(input: {
  ranked: V2ScoredCandidate[];
  escalation: number;
  waitTicks: number;
  shouldFireNow: boolean;
  waitReason?: string | null;
}): HedgeDecision | null {
  const { ranked, escalation, waitTicks, shouldFireNow } = input;
  if (ranked.length === 0) return null;

  const best = ranked[0]!;
  const groupWinners: GroupWinner[] = [];
  for (let g = 0; g < HEDGE_GROUP_NAMES.length; g++) {
    const inGroup = ranked.filter((r) => r.group === g);
    if (inGroup.length === 0) continue;
    groupWinners.push({
      group: g,
      groupName: HEDGE_GROUP_NAMES[g]!,
      winner: inGroup[0]!,
      rowsInGroup: inGroup.length,
    });
  }

  const eligible = best.eligible && shouldFireNow;
  const barrierText = best.barrier >= 0 ? ` ${best.barrier}` : "";
  const driftNote = best.payoutFlag ? ` ${best.payoutFlag}` : "";
  const depNote = best.depUsed ? " · dep" : "";
  const metricsNote =
    `J ${best.J.toFixed(3)} · p~ ${(best.pTilde * 100).toFixed(1)}% (z~ ${best.zTilde.toFixed(2)}, w=${best.window}) · ` +
    `pStop ${(best.pStop * 100).toFixed(1)}% · ES5 ${best.es5.toFixed(2)}${depNote}${driftNote}`;

  const blockers: string[] = [];
  if (!best.eligible) {
    blockers.push("stake outside limits");
  } else if (!shouldFireNow) {
    blockers.push(input.waitReason ?? `patience wait (${waitTicks}/3 ticks)`);
  }

  const reason = eligible
    ? `READY [v2] ${best.contract}${barrierText} on ${best.symbol} · ${metricsNote}`
    : `HOLD [v2]: ${blockers.join(", ")} · ${metricsNote}`;

  return {
    mode: "RECOVERY",
    best,
    eligible,
    confirmations: shouldFireNow ? 1 : waitTicks,
    requiredConfirmations: 1,
    rescanInProgress: false,
    escalation,
    blockers,
    reason,
    groupWinners,
    rowsRanked: ranked.length,
  };
}
