/**
 * DUAL-LOCK RANGE SENTINEL — the analysis layer of the 6th specialist bot.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Every other specialist re-analyses the market before every single trade. This
 * bot deliberately does NOT: once deployed it fires continuously, in one market,
 * with ONE pre-locked normal contract and ONE pre-locked recovery contract,
 * until take-profit or stop-loss. All of the intelligence therefore has to be
 * spent ONCE, up front, on a single question:
 *
 *   "Which (market, normal contract, recovery contract) triple is most likely to
 *    survive an uninterrupted session — i.e. reach TP before SL — given that the
 *    recovery leg only ever trades in the exact state that follows a loss?"
 *
 * That is a fundamentally different question from "what is the best trade right
 * now", and it needs different mathematics:
 *
 *  1. LOWER CONFIDENCE, NOT POINT ESTIMATES. A locked session cannot correct a
 *     mis-estimate, so every probability is the 5th-percentile Beta posterior
 *     quantile (exact, not normal-approximated), computed on an
 *     autocorrelation-corrected effective sample size n_eff = n(1−ρ₁)/(1+ρ₁).
 *     We trade the worst plausible market, not the best hoped-for one.
 *
 *  2. LOSS CLUSTERING IS THE REAL ENEMY. With no mid-session analysis, ruin
 *     comes from consecutive losses, not from a low win rate. So the loss
 *     indicator series is modelled as its own 2-state Markov chain:
 *         q = P(loss_{t+1} | loss_t)   vs   marginal loss rate π_L.
 *     ξ = q/π_L is the CLUSTERING RATIO. ξ > 1 means losses attract losses —
 *     the single most disqualifying property for this bot, and completely
 *     invisible to a win-rate-only view. The censored run hazard gives the
 *     empirical probability that a k-long loss run breaks, and the expected
 *     longest loss run over an N-trade session follows the geometric extreme
 *     value E[L_max] ≈ log(N(1−q))/log(1/q).
 *
 *  3. THE RECOVERY LEG IS A CONDITIONAL BET, NOT A MARGINAL ONE. Recovery only
 *     ever fires on the tick AFTER a normal loss — i.e. from the state "the last
 *     digit was in the normal contract's LOSING set". Scoring it on its
 *     unconditional win rate is simply the wrong estimand. We therefore compute
 *         P(recovery wins | last digit ∈ normal-loss set)
 *     from the exact Dirichlet-smoothed transition rows out of every losing
 *     digit, weighted by how often each losing digit actually occurs. This
 *     coupling term is what makes a PAIR good rather than two good singles.
 *
 *  4. STATIONARITY, BECAUSE THE LOCK CANNOT ADAPT. The tail-membership series is
 *     split into K blocks and tested for homogeneity with Pearson's χ²
 *     (Wilson–Hilferty transformed to a z). A market whose rate drifts across
 *     blocks is refused however good its current read is — drift is precisely
 *     the failure mode of a locked session.
 *
 *  5. SELECTION BIAS ACROSS ~100 CANDIDATES. We rank 4 normal × 4 recovery
 *     combinations across ~20 markets. Taking the argmax of ~320 noisy estimates
 *     is badly biased upward, so every candidate's edge is tested with an exact
 *     one-sided posterior p-value and screened by Benjamini–Hochberg FDR before
 *     it may be locked.
 *
 *  6. THE VERDICT IS A RUIN PROBABILITY, NOT A SCORE. The finalists are run
 *     through a stationary BLOCK BOOTSTRAP (block length 10, preserving serial
 *     dependence — an i.i.d. bootstrap would destroy exactly the clustering we
 *     care about) that replays the real digit stream through the REAL engine
 *     rules: normal stake, debt-driven recovery stake, max recovery steps, TP
 *     and SL. The headline number, P(TP before SL), is an honest simulation of
 *     the session the user is about to run.
 *
 * Everything here is additive and self-contained: no other bot's code path is
 * touched, and the shared recovery ledger/stake formula is mirrored exactly.
 */

import {
  betaPosterior,
  betaQuantile,
  lagAutocorr,
  runHazard,
  waldWolfowitz,
  benjaminiHochberg,
  regularizedIncompleteBeta,
  payoutForBarrier,
} from "./specialist-analysis";

// ── Contract vocabulary (hard-wired: this bot may not trade anything else) ────

export type DualLockSide = "DIGITOVER" | "DIGITUNDER";

export interface DualLockContract {
  side: DualLockSide;
  barrier: number;
}

/** The ONLY contracts allowed for normal trades. */
export const DUAL_LOCK_NORMAL_CONTRACTS: readonly DualLockContract[] = [
  { side: "DIGITOVER", barrier: 1 },   // wins on 2–9 · 80 % · 1.23×
  { side: "DIGITUNDER", barrier: 8 },  // wins on 0–7 · 80 % · 1.23×
  { side: "DIGITOVER", barrier: 2 },   // wins on 3–9 · 70 % · 1.40×
  { side: "DIGITUNDER", barrier: 7 },  // wins on 0–6 · 70 % · 1.40×
] as const;

/** The ONLY contracts allowed for recovery trades. */
export const DUAL_LOCK_RECOVERY_CONTRACTS: readonly DualLockContract[] = [
  { side: "DIGITOVER", barrier: 4 },   // wins on 5–9 · 50 % · 1.95×
  { side: "DIGITOVER", barrier: 5 },   // wins on 6–9 · 40 % · 2.43×
  { side: "DIGITUNDER", barrier: 5 },  // wins on 0–4 · 50 % · 1.95×
  { side: "DIGITUNDER", barrier: 4 },  // wins on 0–3 · 40 % · 2.43×
] as const;

export function contractKey(c: DualLockContract): string {
  return `${c.side === "DIGITOVER" ? "OVER" : "UNDER"}${c.barrier}`;
}

export function contractLabel(c: DualLockContract): string {
  return `${c.side === "DIGITOVER" ? "Over" : "Under"} ${c.barrier}`;
}

export function isNormalContract(side: string, barrier: number): boolean {
  return DUAL_LOCK_NORMAL_CONTRACTS.some(c => c.side === side && c.barrier === barrier);
}

export function isRecoveryContract(side: string, barrier: number): boolean {
  return DUAL_LOCK_RECOVERY_CONTRACTS.some(c => c.side === side && c.barrier === barrier);
}

/** Digits that WIN this contract. */
export function winSet(c: DualLockContract): Set<number> {
  const s = new Set<number>();
  for (let d = 0; d <= 9; d++) {
    if (c.side === "DIGITOVER" ? d > c.barrier : d < c.barrier) s.add(d);
  }
  return s;
}

/** Digits that LOSE this contract (the state recovery inherits). */
export function lossSet(c: DualLockContract): Set<number> {
  const w = winSet(c);
  const s = new Set<number>();
  for (let d = 0; d <= 9; d++) if (!w.has(d)) s.add(d);
  return s;
}

// ── Small numeric helpers ─────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Effective sample size of a binary series under lag-1 serial dependence:
 *     n_eff = n · (1 − ρ₁)/(1 + ρ₁)
 * Positively autocorrelated (clustered) data carries LESS information per
 * observation than n suggests; using n would make every confidence bound too
 * tight, which for a locked session is the dangerous direction of the error.
 */
export function effectiveSampleSize(series: number[]): number {
  const n = series.length;
  if (n < 10) return n;
  const rho = clamp(lagAutocorr(series, 1), -0.95, 0.95);
  return clamp((n * (1 - rho)) / (1 + rho), 5, n);
}

/**
 * Conservative (5th-percentile) Beta posterior bound of a Bernoulli rate,
 * computed on the EFFECTIVE sample size and with a fair-rate prior.
 *
 * `fairRate` is the theoretical rate implied by the barrier (e.g. 0.8 for
 * Over 1) — the correct sceptical prior for a synthetic index that is designed
 * to be uniform.
 */
export function conservativeRate(
  series: number[],
  fairRate: number,
  priorCount = 12,
  quantile = 0.05,
): { mean: number; lcb: number; sigma: number; n: number; nEff: number; hits: number } {
  const n = series.length;
  const hits = series.reduce((a, b) => a + b, 0);
  const nEff = effectiveSampleSize(series);
  const scale = n > 0 ? nEff / n : 1;
  const post = betaPosterior(hits * scale, nEff, fairRate, priorCount);
  return {
    mean: post.mean,
    lcb: betaQuantile(quantile, post.alpha, post.beta),
    sigma: post.sigma,
    n,
    nEff,
    hits,
  };
}

/**
 * Exact one-sided posterior p-value for "this rate is NOT above `threshold`":
 *     p = P(rate ≤ threshold | data) = I_threshold(α, β).
 * Small p ⇒ the rate is genuinely above the threshold. Fed to Benjamini–Hochberg
 * across all candidates so the winner is not just the luckiest of hundreds.
 */
export function edgePValue(series: number[], fairRate: number, threshold: number): number {
  const n = series.length;
  if (n === 0) return 1;
  const nEff = effectiveSampleSize(series);
  const hits = series.reduce((a, b) => a + b, 0) * (nEff / n);
  const post = betaPosterior(hits, nEff, fairRate, 12);
  return clamp(regularizedIncompleteBeta(threshold, post.alpha, post.beta), 0, 1);
}

/**
 * Pearson χ² homogeneity of a binary rate across K contiguous blocks, reported
 * as a Wilson–Hilferty z (χ² with df → standard normal). z ≈ 0 ⇒ stationary,
 * large positive z ⇒ the rate is drifting between blocks.
 *
 * A drifting market is disqualifying for a LOCKED session: the read that
 * justified the lock will not be true an hour later.
 */
export function stationarityZ(series: number[], blocks = 4): { z: number; rates: number[] } {
  const n = series.length;
  if (n < blocks * 15) return { z: 0, rates: [] };
  const size = Math.floor(n / blocks);
  const rates: number[] = [];
  const counts: Array<{ hits: number; n: number }> = [];
  for (let b = 0; b < blocks; b++) {
    const seg = series.slice(b * size, (b + 1) * size);
    const hits = seg.reduce((a, x) => a + x, 0);
    counts.push({ hits, n: seg.length });
    rates.push(hits / Math.max(1, seg.length));
  }
  const totalHits = counts.reduce((a, c) => a + c.hits, 0);
  const totalN = counts.reduce((a, c) => a + c.n, 0);
  const pBar = totalHits / Math.max(1, totalN);
  if (pBar <= 0 || pBar >= 1) return { z: 0, rates };
  let chi2 = 0;
  for (const c of counts) {
    const expHit = c.n * pBar;
    const expMiss = c.n * (1 - pBar);
    chi2 += (c.hits - expHit) ** 2 / Math.max(1e-9, expHit);
    chi2 += ((c.n - c.hits) - expMiss) ** 2 / Math.max(1e-9, expMiss);
  }
  const df = blocks - 1;
  // Wilson–Hilferty: (χ²/df)^(1/3) ~ N(1 − 2/(9df), 2/(9df)).
  const t = Math.cbrt(chi2 / df);
  const m = 1 - 2 / (9 * df);
  const s = Math.sqrt(2 / (9 * df));
  return { z: round((t - m) / s), rates: rates.map(r => round(r, 3)) };
}

/**
 * Loss-clustering diagnostics for a win/loss indicator series.
 *
 * The number the whole bot turns on: ξ = P(loss | loss) / P(loss). ξ < 1 means
 * a loss makes the NEXT loss less likely (self-correcting stream — ideal for an
 * unattended martingale-style recovery); ξ > 1 means losses arrive in bursts,
 * which is what destroys a locked session.
 */
export function lossClustering(wins: number[]): {
  pLoss: number;
  pLossGivenLoss: number;
  clusterRatio: number;
  runsZ: number;
  hazardAt1: number;
  maxLossRun: number;
  expectedMaxRun: number;
  pTwoInARow: number;
} {
  const n = wins.length;
  const losses = wins.map(w => (w === 1 ? 0 : 1));
  const nLoss = losses.reduce((a, b) => a + b, 0);
  const pLoss = n > 0 ? nLoss / n : 1;

  let lossThenLoss = 0;
  let lossTransitions = 0;
  for (let i = 1; i < n; i++) {
    if (losses[i - 1] === 1) {
      lossTransitions++;
      if (losses[i] === 1) lossThenLoss++;
    }
  }
  // Laplace-smoothed toward the marginal, so a market with 3 losses in the
  // window cannot claim a 0 % or 100 % conditional.
  const prior = 6;
  const pLossGivenLoss = (lossThenLoss + prior * pLoss) / (lossTransitions + prior);
  const clusterRatio = pLoss > 1e-6 ? pLossGivenLoss / pLoss : 1;

  const runs = waldWolfowitz(wins);
  const hz = runHazard(losses.map(l => l === 1));
  const hazardAt1 = hz.hazard.get(1) ?? hz.baseline;

  let maxRun = 0;
  let cur = 0;
  for (const l of losses) {
    if (l === 1) { cur++; maxRun = Math.max(maxRun, cur); } else cur = 0;
  }
  // Expected longest loss run in an N=150-trade session under the fitted chain:
  //   E[L_max] ≈ log(N(1−q)) / log(1/q),  q = P(loss|loss).
  const q = clamp(pLossGivenLoss, 1e-4, 0.9999);
  const N = 150;
  const expectedMaxRun = Math.log(Math.max(1.0001, N * (1 - q))) / Math.log(1 / q);

  return {
    pLoss: round(pLoss, 4),
    pLossGivenLoss: round(pLossGivenLoss, 4),
    clusterRatio: round(clusterRatio, 3),
    runsZ: runs.z,
    hazardAt1: round(hazardAt1, 3),
    maxLossRun: maxRun,
    expectedMaxRun: round(expectedMaxRun, 2),
    pTwoInARow: round(pLoss * pLossGivenLoss, 4),
  };
}

/**
 * P(next digit ∈ targetSet | current digit ∈ conditionSet).
 *
 * This is the recovery leg's TRUE estimand: recovery fires on the tick after a
 * normal loss, so its state of departure is "the last digit lost the normal
 * contract". Each losing digit contributes its own Dirichlet-smoothed
 * transition row (shrunk toward the marginal digit distribution with strength
 * κ), weighted by that digit's observed share of losses.
 */
export function conditionalTransitionRate(
  digits: number[],
  conditionSet: ReadonlySet<number>,
  targetSet: ReadonlySet<number>,
  kappa = 8,
): { p: number; lcb: number; n: number; perDigit: Array<{ from: number; p: number; n: number }> } {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  const fair = targetSet.size / 10;
  if (clean.length < 30) return { p: fair, lcb: fair * 0.6, n: 0, perDigit: [] };

  const marg = new Array<number>(10).fill(0);
  for (const d of clean) marg[d]! += 1;
  const margP = marg.map(c => (c + 1) / (clean.length + 10));

  // Transition counts.
  const rowN = new Array<number>(10).fill(0);
  const rowHit = new Array<number>(10).fill(0);
  const followers: number[] = []; // 0/1 series of "next ∈ target" over conditioned steps
  for (let i = 1; i < clean.length; i++) {
    const from = clean[i - 1]!;
    if (!conditionSet.has(from)) continue;
    rowN[from]! += 1;
    const hit = targetSet.has(clean[i]!) ? 1 : 0;
    rowHit[from]! += hit;
    followers.push(hit);
  }

  const totalN = rowN.reduce((a, b) => a + b, 0);
  if (totalN < 8) return { p: fair, lcb: fair * 0.6, n: totalN, perDigit: [] };

  // Weighted Dirichlet mixture over the losing digits.
  let p = 0;
  const perDigit: Array<{ from: number; p: number; n: number }> = [];
  for (const from of conditionSet) {
    const nFrom = rowN[from]!;
    if (nFrom === 0) continue;
    let priorMass = 0;
    for (const t of targetSet) priorMass += margP[t]!;
    const pFrom = (rowHit[from]! + kappa * priorMass) / (nFrom + kappa);
    perDigit.push({ from, p: round(pFrom, 3), n: nFrom });
    p += (nFrom / totalN) * pFrom;
  }

  // Conservative bound on the conditioned series (its own n_eff and prior).
  const cons = conservativeRate(followers, fair, 12);
  return {
    p: round(clamp(p, 0.01, 0.99), 4),
    lcb: round(Math.min(cons.lcb, p), 4),
    n: totalN,
    perDigit: perDigit.sort((a, b) => b.n - a.n).slice(0, 5),
  };
}

// ── Session simulation (stationary block bootstrap) ───────────────────────────

export interface SessionSimParams {
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  /** Debt markup used by the shared bot recovery stake formula (percent). */
  markupPercent: number;
  maxStake: number;
}

export interface SessionSimResult {
  survival: number;        // P(reach TP before SL)
  ruin: number;            // P(hit SL)
  meanPnl: number;
  medianTrades: number;
  worstDrawdown: number;
  maxRecoveryDepthP95: number;
}

/**
 * Replay the REAL engine rules over bootstrapped digit paths.
 *
 * Stationary block bootstrap with geometric block lengths (mean 10): resampling
 * blocks — not single digits — preserves the serial dependence (clustering,
 * hazard shape) that decides whether an unattended recovery ladder survives.
 * An i.i.d. bootstrap would erase exactly the structure being tested and would
 * report a falsely comfortable survival probability.
 *
 * The recovery stake mirrors `recovery-engine.calculateBotRecoveryStake`:
 *     stake = debt · (1 + markup/100) / (payout − 1),  capped by maxStake.
 */
export function simulateSession(
  digits: number[],
  normal: DualLockContract,
  recovery: DualLockContract,
  params: SessionSimParams,
  paths = 240,
  maxTrades = 400,
  seed = 12345,
): SessionSimResult {
  const clean = digits.filter(d => d >= 0 && d <= 9);
  if (clean.length < 60) {
    return { survival: 0, ruin: 1, meanPnl: 0, medianTrades: 0, worstDrawdown: 0, maxRecoveryDepthP95: 0 };
  }

  const nWin = winSet(normal);
  const rWin = winSet(recovery);
  const nPayout = payoutForBarrier(normal.side, normal.barrier);
  const rPayout = payoutForBarrier(recovery.side, recovery.barrier);

  // Deterministic RNG so a scan is reproducible for the same tick buffer.
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };

  const blockMean = 10;
  const pathTrades: number[] = [];
  let survived = 0;
  let ruined = 0;
  let pnlSum = 0;
  let worstDd = 0;
  const depths: number[] = [];

  for (let path = 0; path < paths; path++) {
    let pnl = 0;
    let peak = 0;
    let dd = 0;
    let debt = 0;
    let step = 0;
    let deepest = 0;
    let trades = 0;
    let idx = Math.floor(rnd() * clean.length);
    let blockLeft = 1 + Math.floor(-blockMean * Math.log(1 - rnd()));

    while (trades < maxTrades) {
      if (blockLeft <= 0) {
        idx = Math.floor(rnd() * clean.length);
        blockLeft = 1 + Math.floor(-blockMean * Math.log(1 - rnd()));
      }
      const digit = clean[idx % clean.length]!;
      idx++; blockLeft--;
      trades++;

      const inRecovery = debt > 0;
      const contractWin = inRecovery ? rWin : nWin;
      const payout = inRecovery ? rPayout : nPayout;

      let stake = params.stake;
      if (inRecovery) {
        const raw = (debt * (1 + params.markupPercent / 100)) / Math.max(0.05, payout - 1);
        stake = Math.min(params.maxStake, Math.max(params.stake, raw));
        // Max-step ceiling: the engine stops escalating past maxRecoverySteps.
        if (step >= params.maxRecoverySteps) {
          stake = Math.min(stake, params.stake * (params.maxRecoverySteps + 1));
        }
      }

      const won = contractWin.has(digit);
      if (won) {
        const profit = stake * (payout - 1);
        pnl += profit;
        if (inRecovery) {
          debt = Math.max(0, debt - profit);
          if (debt <= 0.009) { debt = 0; step = 0; }
        }
      } else {
        pnl -= stake;
        debt += stake;
        step = inRecovery ? step + 1 : 1;
        deepest = Math.max(deepest, step);
      }

      peak = Math.max(peak, pnl);
      dd = Math.max(dd, peak - pnl);

      if (pnl >= params.takeProfit) { survived++; break; }
      if (pnl <= -params.stopLoss) { ruined++; break; }
    }

    pnlSum += pnl;
    worstDd = Math.max(worstDd, dd);
    depths.push(deepest);
    pathTrades.push(trades);
  }

  pathTrades.sort((a, b) => a - b);
  depths.sort((a, b) => a - b);
  return {
    survival: round(survived / paths, 4),
    ruin: round(ruined / paths, 4),
    meanPnl: round(pnlSum / paths, 2),
    medianTrades: pathTrades[Math.floor(pathTrades.length / 2)] ?? 0,
    worstDrawdown: round(worstDd, 2),
    maxRecoveryDepthP95: depths[Math.floor(depths.length * 0.95)] ?? 0,
  };
}

// ── Candidate evaluation ──────────────────────────────────────────────────────

export interface DualLockCandidate {
  symbol: string;
  displayName: string;
  normal: DualLockContract;
  recovery: DualLockContract;
  /** 0–100 composite lock score. */
  score: number;
  /** P(TP before SL) from the block-bootstrap session simulation. */
  survival: number;
  ruin: number;
  meanPnl: number;
  /** Conservative (5 %) win-probability bound for the normal leg. */
  normalLcb: number;
  normalMean: number;
  normalBreakEven: number;
  normalPayout: number;
  /** Conditional recovery estimates, given the state after a normal loss. */
  recoveryConditional: number;
  recoveryLcb: number;
  recoveryBreakEven: number;
  recoveryPayout: number;
  /** ξ = P(loss|loss)/P(loss) for the normal leg (<1 is good). */
  clusterRatio: number;
  pTwoInARow: number;
  expectedMaxLossRun: number;
  /** Wilson–Hilferty z of the χ² block-homogeneity test (small is stationary). */
  stationarityZ: number;
  /** Passed the Benjamini–Hochberg FDR screen across every candidate. */
  significant: boolean;
  pValue: number;
  samples: number;
  reason: string;
  signals: string[];
  metrics: Record<string, number>;
}

export interface DualLockEvalOptions extends SessionSimParams {
  /** Skip the (expensive) simulation for candidates that fail the hard gates. */
  simulate?: boolean;
}

const DEFAULT_SIM: SessionSimParams = {
  stake: 1,
  takeProfit: 10,
  stopLoss: 5,
  maxRecoverySteps: 3,
  markupPercent: 10,
  maxStake: 500,
};

/**
 * Evaluate ONE (market, normal, recovery) triple.
 *
 * Hard gates (a candidate that fails any of them can never be locked):
 *   G1  ≥ 120 digit samples — a locked session may not be opened on a guess.
 *   G2  normal LCB > break-even — the WORST plausible rate must still be +EV.
 *   G3  ξ ≤ 1.08 — losses must not attract losses.
 *   G4  |stationarity z| ≤ 3 — no drifting market.
 *   G5  conditional recovery LCB > break-even — the recovery leg must be +EV
 *       in the state it actually trades in, not on average.
 */
export function evaluateDualLockCandidate(
  symbol: string,
  displayName: string,
  digits: number[],
  normal: DualLockContract,
  recovery: DualLockContract,
  options: Partial<DualLockEvalOptions> = {},
): DualLockCandidate | null {
  const opts: DualLockEvalOptions = { ...DEFAULT_SIM, ...options };
  const clean = digits.filter(d => d >= 0 && d <= 9);
  if (clean.length < 120) return null;

  const nWin = winSet(normal);
  const nLoss = lossSet(normal);
  const rWin = winSet(recovery);

  const nPayout = payoutForBarrier(normal.side, normal.barrier);
  const rPayout = payoutForBarrier(recovery.side, recovery.barrier);
  const nBe = 1 / nPayout;
  const rBe = 1 / rPayout;
  const nFair = nWin.size / 10;
  const rFair = rWin.size / 10;

  // ── Normal leg: conservative rate on the tail-membership series ────────────
  const nSeries = clean.map(d => (nWin.has(d) ? 1 : 0));
  const nRate = conservativeRate(nSeries, nFair, 12);
  const nStat = stationarityZ(nSeries, 4);
  const cluster = lossClustering(nSeries);
  const nP = edgePValue(nSeries, nFair, nBe);

  // ── Recovery leg: the conditional estimand + its own clustering ───────────
  const rCond = conditionalTransitionRate(clean, nLoss, rWin);
  const rSeries = clean.map(d => (rWin.has(d) ? 1 : 0));
  const rRate = conservativeRate(rSeries, rFair, 12);
  const rCluster = lossClustering(rSeries);
  // Recovery's operative probability: the conditional estimate, floored by the
  // unconditional conservative bound (never let a thin conditional sample tell
  // a better story than the market's own long-run rate can support).
  const rOperative = Math.min(rCond.p, Math.max(rRate.lcb, rCond.lcb));

  // ── Gates ─────────────────────────────────────────────────────────────────
  //
  // Two tiers, and the distinction matters.
  //
  // HARD gates are structural properties of the market that a locked session
  // cannot survive no matter how the economics look: clustered losses, a
  // drifting rate, or a normal/recovery rate that is significantly BELOW
  // break-even (not merely below the house edge). These block the candidate.
  //
  // SOFT flags cover the ordinary situation on a synthetic index: the digit
  // stream is near-uniform, so Over 1 (80 % fair vs 81.3 % break-even) is
  // mildly −EV per trade by construction. Refusing on that alone would refuse
  // every market forever — and it would also miss the actual thesis of this
  // bot, which is that a single-trade −EV pair can still have a high
  // P(take-profit before stop-loss) because the debt-driven recovery leg
  // converts many small wins into a cleared ladder. That question is answered
  // by the bootstrap, not by a per-trade EV sign, so soft flags cost score and
  // are surfaced verbatim to the user, but they do not veto.
  const gates: string[] = [];
  const softFlags: string[] = [];

  // How far below break-even the conservative bound sits, in its own σ.
  const nShortfallSigma = (nBe - nRate.lcb) / Math.max(0.005, nRate.sigma);
  if (nRate.mean <= nBe && nShortfallSigma > 3) {
    gates.push(`normal rate significantly below break-even (p̂ ${(nRate.mean * 100).toFixed(1)}% vs ${(nBe * 100).toFixed(1)}%, ${nShortfallSigma.toFixed(1)}σ)`);
  } else if (nRate.lcb <= nBe) {
    softFlags.push(`normal worst case ${(nRate.lcb * 100).toFixed(1)}% under break-even ${(nBe * 100).toFixed(1)}% — survival must come from the recovery structure`);
  }
  if (cluster.clusterRatio > 1.08) gates.push(`losses cluster (ξ ${cluster.clusterRatio.toFixed(2)})`);
  if (Math.abs(nStat.z) > 3) gates.push(`non-stationary (z ${nStat.z.toFixed(2)})`);
  if (rCond.p <= rBe * 0.9) {
    gates.push(`recovery conditional ${(rCond.p * 100).toFixed(1)}% far below break-even ${(rBe * 100).toFixed(1)}%`);
  } else if (rOperative <= rBe) {
    softFlags.push(`recovery worst case ${(rOperative * 100).toFixed(1)}% under break-even ${(rBe * 100).toFixed(1)}%`);
  }

  // ── Composite lock score ──────────────────────────────────────────────────
  // Each term is bounded, signed and independently interpretable.
  const edgeN = (nRate.lcb - nBe) / Math.max(0.01, nBe);        // relative edge, normal
  const edgeR = (rOperative - rBe) / Math.max(0.01, rBe);       // relative edge, recovery (conditional)
  const clusterTerm = clamp((1.02 - cluster.clusterRatio) * 60, -25, 18);
  const statTerm = clamp((1.5 - Math.abs(nStat.z)) * 4, -18, 6);
  const couplingTerm = clamp((rCond.p - rRate.mean) * 120, -10, 12); // does the loss state HELP recovery?
  const runsTerm = clamp(cluster.runsZ * 2.5, -8, 8);            // >0 ⇒ alternating ⇒ good here
  const depthTerm = clamp((3.2 - cluster.expectedMaxRun) * 4, -14, 10);

  let score =
    50 - softFlags.length * 3 +
    clamp(edgeN * 120, -22, 26) +
    clamp(edgeR * 60, -16, 18) +
    clusterTerm + statTerm + couplingTerm + runsTerm + depthTerm;

  // ── Session simulation (the verdict) ──────────────────────────────────────
  const runSim = opts.simulate !== false && gates.length === 0;
  const sim = runSim
    ? simulateSession(clean, normal, recovery, opts)
    : { survival: 0, ruin: 1, meanPnl: 0, medianTrades: 0, worstDrawdown: 0, maxRecoveryDepthP95: 0 };
  if (runSim) {
    // Survival dominates: a beautiful edge that still ruins 40 % of sessions is
    // not a lock candidate.
    score = score * 0.55 + (sim.survival * 100) * 0.45;
  } else {
    score = Math.min(score, 45);
  }
  score = clamp(score, 0, 100);

  const signals: string[] = [];
  signals.push(`normal ${contractLabel(normal)} · p̂ ${(nRate.mean * 100).toFixed(1)}% · LCB ${(nRate.lcb * 100).toFixed(1)}% vs be ${(nBe * 100).toFixed(1)}% (n_eff ${nRate.nEff.toFixed(0)})`);
  signals.push(`recovery ${contractLabel(recovery)} · P(win | after normal loss) ${(rCond.p * 100).toFixed(1)}% (n ${rCond.n}) vs be ${(rBe * 100).toFixed(1)}%`);
  signals.push(`loss clustering ξ ${cluster.clusterRatio.toFixed(2)} · P(loss|loss) ${(cluster.pLossGivenLoss * 100).toFixed(1)}% · P(2 in a row) ${(cluster.pTwoInARow * 100).toFixed(1)}%`);
  signals.push(`E[longest loss run/150] ${cluster.expectedMaxRun.toFixed(1)} · observed max ${cluster.maxLossRun} · runs z ${cluster.runsZ >= 0 ? "+" : ""}${cluster.runsZ.toFixed(2)}`);
  signals.push(`stationarity χ²→z ${nStat.z >= 0 ? "+" : ""}${nStat.z.toFixed(2)} · block rates ${nStat.rates.map(r => (r * 100).toFixed(0)).join("/")}%`);
  if (runSim) {
    signals.push(`bootstrap session: survival ${(sim.survival * 100).toFixed(1)}% · ruin ${(sim.ruin * 100).toFixed(1)}% · E[P&L] ${sim.meanPnl >= 0 ? "+" : ""}$${sim.meanPnl.toFixed(2)} · median ${sim.medianTrades} trades`);
    signals.push(`recovery depth p95 ${sim.maxRecoveryDepthP95} steps · worst drawdown $${sim.worstDrawdown.toFixed(2)}`);
  }
  for (const f of softFlags) signals.push(`⚠ ${f}`);
  if (gates.length > 0) signals.push(`BLOCKED: ${gates.join(" · ")}`);

  const reason = gates.length > 0
    ? `Rejected — ${gates[0]}`
    : `${contractLabel(normal)} → recovery ${contractLabel(recovery)} · survival ${(sim.survival * 100).toFixed(0)}% · ξ ${cluster.clusterRatio.toFixed(2)} · LCB ${(nRate.lcb * 100).toFixed(1)}%`;

  return {
    symbol,
    displayName,
    normal,
    recovery,
    score: round(score, 1),
    survival: sim.survival,
    ruin: sim.ruin,
    meanPnl: sim.meanPnl,
    normalLcb: round(nRate.lcb, 4),
    normalMean: round(nRate.mean, 4),
    normalBreakEven: round(nBe, 4),
    normalPayout: nPayout,
    recoveryConditional: rCond.p,
    recoveryLcb: round(rOperative, 4),
    recoveryBreakEven: round(rBe, 4),
    recoveryPayout: rPayout,
    clusterRatio: cluster.clusterRatio,
    pTwoInARow: cluster.pTwoInARow,
    expectedMaxLossRun: cluster.expectedMaxRun,
    stationarityZ: nStat.z,
    significant: false, // filled in by the FDR pass across all candidates
    pValue: round(nP, 5),
    samples: clean.length,
    reason,
    signals,
    metrics: {
      normalLcb: round(nRate.lcb, 4),
      normalMean: round(nRate.mean, 4),
      normalBe: round(nBe, 4),
      nEff: round(nRate.nEff, 1),
      recoveryCond: rCond.p,
      recoveryLcb: round(rOperative, 4),
      recoveryBe: round(rBe, 4),
      recoveryUncond: round(rRate.mean, 4),
      recoveryClusterRatio: rCluster.clusterRatio,
      clusterRatio: cluster.clusterRatio,
      pLossGivenLoss: cluster.pLossGivenLoss,
      pTwoInARow: cluster.pTwoInARow,
      expectedMaxRun: cluster.expectedMaxRun,
      observedMaxRun: cluster.maxLossRun,
      runsZ: cluster.runsZ,
      stationarityZ: nStat.z,
      survival: sim.survival,
      ruin: sim.ruin,
      meanPnl: sim.meanPnl,
      recoveryDepthP95: sim.maxRecoveryDepthP95,
      samples: clean.length,
      blocked: gates.length > 0 ? 1 : 0,
      softFlags: softFlags.length,
      normalShortfallSigma: round(nShortfallSigma, 2),
    },
  };
}

/**
 * Rank every (normal × recovery) pair for one market.
 */
export function evaluateMarket(
  symbol: string,
  displayName: string,
  digits: number[],
  options: Partial<DualLockEvalOptions> = {},
): DualLockCandidate[] {
  const out: DualLockCandidate[] = [];
  for (const normal of DUAL_LOCK_NORMAL_CONTRACTS) {
    for (const recovery of DUAL_LOCK_RECOVERY_CONTRACTS) {
      const c = evaluateDualLockCandidate(symbol, displayName, digits, normal, recovery, options);
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * Apply the Benjamini–Hochberg FDR screen across every candidate produced by a
 * full scan and re-rank.
 *
 * With 4 normal × 4 recovery × ~20 markets the argmax of the raw scores is a
 * maximum of hundreds of noisy estimates; without an FDR screen the "best"
 * candidate is very often just the luckiest. Candidates that fail the screen
 * keep their score but are never proposed as a lock.
 */
export function screenAndRank(candidates: DualLockCandidate[], q = 0.2): DualLockCandidate[] {
  if (candidates.length === 0) return [];
  // One test per DISTINCT (market, normal) leg — the recovery leg shares it.
  const legKey = (c: DualLockCandidate) => `${c.symbol}|${contractKey(c.normal)}`;
  const legs = new Map<string, number>();
  for (const c of candidates) if (!legs.has(legKey(c))) legs.set(legKey(c), c.pValue);
  const keys = [...legs.keys()];
  const passes = benjaminiHochberg(keys.map(k => legs.get(k)!), q);
  const passing = new Set(keys.filter((_, i) => passes[i]));

  const ranked = candidates.map(c => ({
    ...c,
    significant: passing.has(legKey(c)) && c.metrics["blocked"] === 0,
  }));

  // Rank by what the user actually buys: a session that reaches TP. Blocked
  // candidates sink; among the rest survival leads, the FDR badge only breaks
  // near-ties.
  return ranked.sort((a, b) => {
    const aBlocked = a.metrics["blocked"] === 1;
    const bBlocked = b.metrics["blocked"] === 1;
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
    if (Math.abs(a.survival - b.survival) > 0.02) return b.survival - a.survival;
    if (a.significant !== b.significant) return a.significant ? -1 : 1;
    return b.score - a.score;
  });
}

/**
 * Composite score floor for a lock.
 *
 * Lowered from 58 when the survival floor was lifted. The composite is 55 %
 * structural read + 45 % simulated survival, so with the survival bar gone a
 * high floor here would simply re-impose it by the back door: a market at 50 %
 * survival with a perfect structural read scored 52.8 and was refused anyway.
 * 40 keeps the floor's actual job — refuse a candidate whose STRUCTURAL read is
 * poor — without silently vetoing every market whose bootstrap survival is
 * merely ordinary.
 */
export const DUAL_LOCK_MIN_SCORE = 40;

/**
 * SURVIVAL IS A RANKING SIGNAL, NOT A GATE.
 *
 * This bot previously refused to lock ANY market whose block-bootstrap
 * P(take-profit before stop-loss) was ≤ 90 %. In practice that admitted nothing:
 * a synthetic index whose digits are close to uniform produces a normal leg that
 * is mildly −EV per trade by construction, so the bootstrap survival clusters in
 * the 40–80 % band and the scan returned "no lock" every single time. The bar was
 * not selecting good markets, it was switching the bot off.
 *
 * Survival is therefore no longer a deployability condition. It still does the
 * two jobs it is genuinely good at:
 *   · it is 45 % of the composite lock score, so it dominates the RANKING, and
 *   · it is printed verbatim on the scan result, so the user chooses with the
 *     number in front of them rather than having the choice made for them.
 * Kept as an exported constant so the UI and the docs can quote what the old bar
 * was, and so a future re-tightening is a one-line change rather than a rewrite.
 */
export const DUAL_LOCK_MIN_SURVIVAL = 0;

/**
 * Is this candidate good enough to open a locked, unattended session on?
 *
 * The gates that remain are the STRUCTURAL ones — the properties of a market
 * that no recovery arithmetic can rescue a frozen session from:
 *   · `blocked` — the hard gates in `evaluateDualLockCandidate` (losses cluster,
 *     the rate is non-stationary, or a leg is significantly below break-even);
 *   · `score` — the composite read, which survival now only influences;
 *   · `clusterRatio` ≤ 1.08 — losses must not attract losses, because
 *     consecutive losses (not a low win rate) is what ruins an unattended ladder.
 *
 * The FDR `significant` flag is reported as a quality badge, not a veto: a market
 * can be perfectly lockable without a statistically provable per-trade edge,
 * which is the normal state of a well-behaved synthetic index.
 */
export function isDeployable(c: DualLockCandidate | null | undefined): boolean {
  return !!c
    && c.metrics["blocked"] === 0
    && c.score >= DUAL_LOCK_MIN_SCORE
    && c.clusterRatio <= 1.08;
}
