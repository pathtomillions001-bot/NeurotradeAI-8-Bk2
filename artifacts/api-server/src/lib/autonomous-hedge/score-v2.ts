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
import {
  HEDGE_GATE_CORROBORATION,
  HEDGE_GATE_KAPPA,
  HEDGE_GATE_KAPPA_MAX,
  HEDGE_GATE_SCALE_KAPPA_BY_STAKE,
  HEDGE_GROUP_NAMES,
  hedgeGroupIndex,
  LAMBDA_STOP,
  LAMBDA_TAIL,
  mulberry32,
} from "./constants";
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
  /** Gate tuning (defaults from constants.ts). */
  gateKappa?: number;
  gateCorroboration?: boolean;
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
  /** EV on the shrunk estimate: pTilde * payout - 1. What the gate tests. */
  gateEv: number;
  /** Minimum edge the gate required for this candidate (kappa, stake-scaled). */
  gateThreshold: number;
  /** Why the gate refused this candidate, when it did. */
  gateBlocker: string | null;
  /** Did it survive the multi-window corroboration check? */
  gateCorroborated: boolean;
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

/**
 * Does this candidate demonstrate an edge strong enough to be TRADED?
 *
 * Split out from `isRecoveryStakeEligible` (which answers the different question
 * "is the stake this ladder wants actually placeable?") because conflating the
 * two is precisely the defect that made v2 fire on 100% of ticks: its only test
 * was stake validity, so a perfectly calibrated −2.5% bet was always "eligible".
 *
 * Rules (see constants.ts for the calibrated thresholds):
 *   (a) zTilde > 0                 survives the multiplicity threshold
 *   (b) pTilde*P - 1 > 0           positive on the SHRUNK estimate
 *   (c) pTilde*P - 1 >= kappa      a real edge worth the exposure
 *   (d) corroboration              same-signed survival at the longest window
 *
 * Pure. Reads no clock, touches no stake.
 */
export function gateAdmitsCandidate(input: {
  row: Pick<EvidenceRow, "pTilde" | "zTilde" | "longestZTilde" | "window" | "longestWindowTicks">;
  payout: number;
  /** Stake the recovery LADDER has already decided on (read-only, for exposure scaling). */
  ladderStake?: number | null;
  baseStake?: number | null;
  kappa?: number;
  corroboration?: boolean;
}): { admits: boolean; ev: number; threshold: number; corroborated: boolean; blocker: string | null } {
  const { row, payout } = input;
  const kappa = input.kappa ?? HEDGE_GATE_KAPPA;
  const corroboration = input.corroboration ?? HEDGE_GATE_CORROBORATION;

  // Exposure scaling: a recovery attempt risks more than a base stake, so the same
  // estimated edge is worth less. Threshold scales with stake/base, capped.
  const baseStake = Number.isFinite(input.baseStake) && (input.baseStake as number) > 0
    ? (input.baseStake as number)
    : null;
  const ladderStake = Number.isFinite(input.ladderStake) && (input.ladderStake as number) > 0
    ? (input.ladderStake as number)
    : null;
  const threshold =
    HEDGE_GATE_SCALE_KAPPA_BY_STAKE && baseStake && ladderStake
      ? Math.min(HEDGE_GATE_KAPPA_MAX, kappa * (ladderStake / baseStake))
      : kappa;

  // (a) The deviation must survive the universal threshold for the search it came from.
  // When the selected window is already the longest available, the candidate IS
  // the long-horizon evidence and corroboration is satisfied by construction.
  // A row that carries no longest-window data at all cannot be corroborated; such
  // rows are REFUSED rather than trusted (`longestWindowTicks` is always set by
  // EvidenceTracker, so this only affects hand-built fixtures).
  const hasLongest = typeof row.longestWindowTicks === "number" && Number.isFinite(row.longestWindowTicks);
  const corroborated = hasLongest && (row.window >= row.longestWindowTicks || row.longestZTilde > 0);

  // EV is computed BEFORE any rule runs and is returned on EVERY path, admitted or
  // refused. Ranking sorts by this number, so an early return that reported a
  // placeholder (0) instead of the true EV would silently mis-order candidates
  // across the admit/refuse boundary.
  const ev = row.pTilde * payout - 1;

  if (!(row.zTilde > 0)) {
    return { admits: false, ev, threshold, corroborated, blocker: "no evidence past the multiplicity threshold" };
  }

  // (b)/(c) Positive expectancy on the SHRUNK estimate, and large enough to matter.
  if (!(ev > 0)) {
    return { admits: false, ev, threshold, corroborated, blocker: `EV ${(ev * 100).toFixed(2)}% not positive on the shrunk estimate` };
  }
  if (ev < threshold) {
    return { admits: false, ev, threshold, corroborated, blocker: `EV ${(ev * 100).toFixed(2)}% below the ${(threshold * 100).toFixed(2)}% minimum edge` };
  }

  // (d) Multi-window corroboration: a deviation that survives only at the shortest
  // window is a transient of that window, not a bias. When the selected window IS
  // the longest available one the candidate is already the strongest evidence.
  if (corroboration && !corroborated) {
    return { admits: false, ev, threshold, corroborated, blocker: `uncorroborated at the ${row.longestWindowTicks}-tick window` };
  }

  return { admits: true, ev, threshold, corroborated, blocker: null };
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

    // Admissibility gate: an edge must be demonstrated before the trade is taken.
    // Measured effect (probe-policy.ts, 19 markets x 3 seeds x 4000 ticks, ladder
    // frozen): edge-free worlds bleed 98% less, edge-bearing worlds keep 97% of
    // the capture with 5.4x fewer trades and 5.2x better EV per trade.
    const gate = gateAdmitsCandidate({
      row: evRow,
      payout,
      ladderStake: elig.stake,
      baseStake: base,
      kappa: ladder.gateKappa,
      corroboration: ladder.gateCorroboration,
    });
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
      eligible: elig.eligible && gate.admits,
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
      gateEv: gate.ev,
      gateThreshold: gate.threshold,
      gateCorroborated: gate.corroborated,
      gateBlocker: gate.blocker ?? elig.blocker,
    });
  }

  return rankV2Candidates(scored);
}

/**
 * Rank v2 candidates. Order adopted after measuring the alternatives in
 * scripts/recovery-lab/probe-policy.ts, then corrected against the calibration
 * recorder (T1) — see the note on refused candidates below.
 *
 * 1. ADMISSIBLE FIRST (gate rules a-d). Nothing refused is ever traded, so the
 *    gate is the primary key.
 * 2. Within the admissible set, highest EV on the SHRUNK estimate. This is the
 *    only ordering whose top pick is the candidate with the most real edge;
 *    ranking by J(c) alone optimises the shape of the episode for a bet that may
 *    not be worth taking at all.
 * 3. Lower J(c) breaks EV ties, then the deterministic tick hash, then the key.
 *
 * REFUSED CANDIDATES KEEP THE ORIGINAL J-BUCKET ORDER (with its tick-hash tie
 * rotation). This is not cosmetic. The shadow ledger records the top 10 of this
 * ordering every tick to measure predictive skill (T1 asserts the null-stream
 * calibration slope stays within +-0.03). On an edge-free tape almost every
 * candidate is refused, so ordering the REFUSED set by EV would make that
 * recorder measure the counterfactual "trade the best-EV candidates anyway" —
 * and sorting a null tape by EV selects on the very noise whose outcomes are then
 * regressed against it. Measured cost of getting this wrong (null tape, 19
 * markets, 4 seeds): beta rose to +0.074 / +0.031 / +0.012 against the baseline's
 * +0.028 / +0.020 / +0.003, i.e. the recorder reported manufactured skill that
 * does not exist. Ordering refused candidates the way v1 ordered them keeps the
 * instrument comparable to its validated baseline, and the ordering that decides
 * TRADES (admissible, EV first) is unaffected.
 */
export function rankV2Candidates(rows: V2ScoredCandidate[]): V2ScoredCandidate[] {
  if (rows.length === 0) return [];
  const EV_TIE = 1e-9;
  let minJ = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    if (r.J < minJ) minJ = r.J;
  }
  return [...rows].sort((a, b) => {
    if (a.eligible !== b.eligible) return Number(b.eligible) - Number(a.eligible);
    if (a.eligible) {
      // Traded candidates: the one with the most real edge first.
      const evA = a.gateEv;
      const evB = b.gateEv;
      if (Math.abs(evA - evB) > EV_TIE) return evB - evA;
      if (Math.abs(a.J - b.J) > 1e-9) return a.J - b.J;
    } else {
      // Refused candidates: original v1 J-bucket ordering (bucketed from minJ).
      const bucketA = Math.floor((a.J - minJ + 1e-12) / 0.001);
      const bucketB = Math.floor((b.J - minJ + 1e-12) / 0.001);
      if (bucketA !== bucketB) return bucketA - bucketB;
      const posEvA = a.zTilde > 1e-9 ? 1 : 0;
      const posEvB = b.zTilde > 1e-9 ? 1 : 0;
      if (posEvA !== posEvB) return posEvB - posEvA;
    }
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
    // Say WHY. A refusal to trade is the engine working correctly on a tape with
    // no demonstrable edge, and the operator must be able to see that — otherwise
    // a quiet engine is indistinguishable from a broken one.
    blockers.push(best.gateBlocker ?? "stake outside limits");
  } else if (!shouldFireNow) {
    blockers.push(input.waitReason ?? "patience wait");
  }

  const gateNote = `EV(p~) ${(best.gateEv * 100).toFixed(2)}% (min ${(best.gateThreshold * 100).toFixed(2)}%)`;
  const reason = eligible
    ? `READY [v2] ${best.contract}${barrierText} on ${best.symbol} · ${gateNote} · ${metricsNote}`
    : `HOLD [v2]: ${blockers.join(", ")} · ${gateNote} · ${metricsNote}`;

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
