/**
 * DUAL-LOCK EDGE VALIDITY — "how long is this locked edge expected to last?"
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The Dual-Lock Range Sentinel freezes one (market, normal, recovery) triple and
 * then never re-analyses. That is deliberate — but it leaves the user with one
 * unanswered question, and it is the question that actually decides their P&L:
 *
 *     "The scan said this market is good NOW. Market conditions drift. How long
 *      does that verdict stay true, so I know when to stop and re-scan?"
 *
 * A locked edge does not die at a fixed clock time. It dies when the digit
 * stream's tail rate drifts far enough that the margin the lock was justified on
 * is consumed. So the honest answer is a FIRST-PASSAGE TIME: given how fast this
 * particular market's rate wanders, how many ticks until the wandering eats the
 * margin?
 *
 * Nothing here ever stops the session. Every number produced by this module is
 * ADVISORY: it is surfaced in the console as a countdown and a freshness state,
 * and the user decides when to stop and re-scan. (The pre-existing loss-run
 * circuit breaker is a separate, unrelated safety and is untouched.)
 *
 * THE MATHEMATICS
 * ───────────────
 * Three independent horizons are estimated; the binding one (the minimum) is
 * reported, because an edge is only valid while ALL of its supports hold.
 *
 *  H1. DRIFT FIRST-PASSAGE (the primary estimator).
 *      Split the tail-membership series into K blocks and measure the block
 *      rates p̂_1..p̂_K. Their variance has two parts:
 *          Var(p̂_b) = p(1−p)/m        (binomial sampling noise — harmless)
 *                   + σ²_drift        (real regime movement — the killer)
 *      The excess variance σ²_drift is estimated by subtracting the expected
 *      binomial component (a one-way random-effects / DerSimonian–Laird style
 *      moment estimator, floored at 0). Treating the rate as a random walk with
 *      per-block step σ_drift, the number of blocks until the rate wanders by
 *      the available margin m = p̂ − p_critical follows the first-passage
 *      relation  E[B] ≈ (m/σ_drift)²  (Brownian first passage of a level), so
 *          H1 = blockSize · (m/σ_drift)².
 *      The critical level is NOT break-even — it is the rate at which the
 *      SESSION verdict flips, i.e. the LCB the lock was granted on. Using the
 *      conservative bound keeps the horizon conservative too.
 *
 *  H2. AUTOCORRELATION MEMORY.
 *      The structure the lock exploits (clustering ξ, the conditional recovery
 *      coupling) is carried by serial dependence with correlation time
 *          τ = −1 / ln|ρ₁|.
 *      Beyond a few multiples of τ the stream has forgotten the state the scan
 *      measured. H2 = 6τ — six correlation times is the standard "memory is
 *      gone" horizon (e^-6 ≈ 0.25 % of the original correlation).
 *
 *  H3. EMPIRICAL REGIME DWELL.
 *      A two-sided CUSUM over the tail-membership series detects the change
 *      points this market has actually produced in its own recent history. The
 *      mean observed dwell between change points is the market's own empirical
 *      regime lifetime — no model assumptions at all. If the market has produced
 *      no change point in the whole window, H3 is unbounded (reported as the
 *      window length, a floor, not a ceiling).
 *
 * Each horizon is a MEAN. Users need a planning number, not an average, so the
 * reported "valid for" figure is the conservative p20 of an exponential lifetime
 * with that mean:  t_20 = −H · ln(0.8) ≈ 0.223 · H, and a p50 (half-life,
 * 0.693·H) is reported alongside it as the "expected" figure.
 *
 * LIVE DECAY TRACKING
 * ───────────────────
 * The pre-deploy horizon is a forecast. Once the session runs, the bot has real
 * outcomes, so the tracker replaces the forecast with evidence:
 *
 *   - PAGE–HINKLEY TEST on the realised win indicator of the locked normal leg.
 *     PH accumulates  m_t = Σ (x_i − p̂_lock + δ)  and reports the drop from the
 *     running maximum. It is the standard sequential change detector for a
 *     Bernoulli mean and needs no window.
 *   - EWMA realised rate (α tuned to ≈40 trades of memory) versus the locked
 *     probability, expressed in σ.
 *   - Elapsed fraction of the forecast horizon.
 *
 * These fuse into a single 0–100 FRESHNESS score and one of four states:
 * `fresh`, `aging`, `stale`, `expired`. The console shows the state, the
 * countdown, and a plain-language recommendation. The session keeps running in
 * every state — stopping is the user's call.
 */

import { lagAutocorr } from "./specialist-analysis";

// ── Tick cadence ──────────────────────────────────────────────────────────────

/**
 * Seconds per tick for Deriv synthetics. The "1s" indices publish one tick per
 * second; the classic Volatility / Jump / Bull-Bear indices publish one every
 * two seconds. Used only to translate a tick horizon into wall-clock time.
 */
export function secondsPerTick(symbol: string): number {
  return symbol.startsWith("1HZ") ? 1 : 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, d = 3): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// ── H1: drift first-passage ───────────────────────────────────────────────────

export interface DriftEstimate {
  /** Per-block standard deviation of REAL rate movement (binomial noise removed). */
  sigmaDrift: number;
  /** Margin available before the verdict flips. */
  margin: number;
  /** Mean ticks until the drift consumes the margin (∞ ⇒ no measurable drift). */
  horizonTicks: number;
  blockSize: number;
  blocks: number;
}

/**
 * Random-effects (DerSimonian–Laird style) estimate of genuine rate drift, then
 * a Brownian first-passage horizon for the available margin.
 *
 * `criticalRate` is the level at which the lock's justification fails — the
 * conservative bound the scan approved, not the break-even rate.
 */
export function driftHorizon(
  series: number[],
  criticalRate: number,
  blocks = 8,
): DriftEstimate {
  const n = series.length;
  const blockSize = Math.floor(n / blocks);
  const empty: DriftEstimate = {
    sigmaDrift: 0, margin: 0, horizonTicks: Number.POSITIVE_INFINITY, blockSize, blocks,
  };
  if (n < blocks * 12 || blockSize < 12) return empty;

  const rates: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const seg = series.slice(b * blockSize, (b + 1) * blockSize);
    rates.push(seg.reduce((a, x) => a + x, 0) / seg.length);
  }
  const pBar = rates.reduce((a, r) => a + r, 0) / rates.length;
  const observedVar = rates.reduce((a, r) => a + (r - pBar) ** 2, 0) / Math.max(1, rates.length - 1);
  // Expected variance from binomial sampling alone.
  const binomialVar = (pBar * (1 - pBar)) / blockSize;
  // Excess (between-block) variance = genuine regime movement. Floored at 0:
  // a market quieter than binomial noise simply has no measurable drift.
  const sigmaDrift = Math.sqrt(Math.max(0, observedVar - binomialVar));

  const margin = Math.max(0, pBar - criticalRate);
  if (sigmaDrift <= 1e-6) {
    return { sigmaDrift: 0, margin: round(margin, 4), horizonTicks: Number.POSITIVE_INFINITY, blockSize, blocks };
  }
  if (margin <= 1e-6) {
    // Already at the critical level — the edge is at its boundary right now.
    return { sigmaDrift: round(sigmaDrift, 5), margin: 0, horizonTicks: 0, blockSize, blocks };
  }
  // Brownian first passage: E[blocks] = (margin / σ_step)².
  const blocksToBreach = (margin / sigmaDrift) ** 2;
  return {
    sigmaDrift: round(sigmaDrift, 5),
    margin: round(margin, 4),
    horizonTicks: blocksToBreach * blockSize,
    blockSize,
    blocks,
  };
}

// ── H2: autocorrelation memory ────────────────────────────────────────────────

/** Correlation time τ = −1/ln|ρ₁|, and the 6τ memory horizon. */
export function memoryHorizon(series: number[]): { rho: number; tau: number; horizonTicks: number } {
  if (series.length < 40) return { rho: 0, tau: 0, horizonTicks: Number.POSITIVE_INFINITY };
  const rho = clamp(Math.abs(lagAutocorr(series, 1)), 0, 0.99);
  if (rho < 0.02) {
    // No measurable memory: nothing to decay, so this horizon does not bind.
    return { rho: round(rho, 4), tau: 0, horizonTicks: Number.POSITIVE_INFINITY };
  }
  const tau = -1 / Math.log(rho);
  return { rho: round(rho, 4), tau: round(tau, 2), horizonTicks: 6 * tau };
}

// ── H3: empirical regime dwell (CUSUM change points) ──────────────────────────

export interface DwellEstimate {
  changePoints: number;
  meanDwellTicks: number;
  horizonTicks: number;
}

/**
 * Two-sided CUSUM change-point detector on a Bernoulli series.
 *
 * S⁺_t = max(0, S⁺_{t−1} + (x_t − p̂ − k)),  S⁻_t = max(0, S⁻_{t−1} − (x_t − p̂ − k))
 * A detection fires when either arm exceeds h·σ. k is the slack (half the
 * smallest shift worth detecting, here 0.5σ) and h the decision interval (4σ) —
 * the classic Page parameters, which give an in-control average run length of
 * several hundred observations, i.e. few false alarms on a stationary stream.
 */
export function dwellHorizon(series: number[]): DwellEstimate {
  const n = series.length;
  if (n < 80) return { changePoints: 0, meanDwellTicks: n, horizonTicks: Number.POSITIVE_INFINITY };
  const p = series.reduce((a, b) => a + b, 0) / n;
  const sigma = Math.sqrt(Math.max(1e-6, p * (1 - p)));
  const k = 0.5 * sigma;
  const h = 4 * sigma;

  let sPos = 0;
  let sNeg = 0;
  let last = 0;
  const dwells: number[] = [];
  for (let i = 0; i < n; i++) {
    const dev = series[i]! - p;
    sPos = Math.max(0, sPos + dev - k);
    sNeg = Math.max(0, sNeg - dev - k);
    if (sPos > h || sNeg > h) {
      dwells.push(i - last);
      last = i;
      sPos = 0;
      sNeg = 0;
    }
  }
  if (dwells.length === 0) {
    // No regime change in the whole window: the window itself is a LOWER bound
    // on the dwell, so this horizon must not bind the estimate.
    return { changePoints: 0, meanDwellTicks: n, horizonTicks: Number.POSITIVE_INFINITY };
  }
  const mean = dwells.reduce((a, d) => a + d, 0) / dwells.length;
  return {
    changePoints: dwells.length,
    meanDwellTicks: round(mean, 1),
    horizonTicks: mean,
  };
}

// ── Combined validity forecast ────────────────────────────────────────────────

export interface EdgeValidity {
  /** Mean lifetime of the edge, in ticks (the binding horizon). */
  meanTicks: number;
  /** Conservative planning horizon — p20 of an exponential lifetime. */
  p20Ticks: number;
  /** Expected (median) lifetime — p50 of an exponential lifetime. */
  p50Ticks: number;
  p20Seconds: number;
  p50Seconds: number;
  /** Rough trade counts (this bot fires roughly one trade per tick cadence + settle). */
  p20Trades: number;
  p50Trades: number;
  /** Which of the three horizons is the binding constraint. */
  bindingFactor: "drift" | "memory" | "regime-dwell" | "unbounded";
  /** 0–100 confidence in the horizon itself (sample size + agreement). */
  confidence: number;
  drift: DriftEstimate;
  memory: { rho: number; tau: number; horizonTicks: number };
  dwell: DwellEstimate;
  /** One-line plain-language summary for the console. */
  summary: string;
}

const EXP_P20 = -Math.log(0.8);   // 0.2231
const EXP_P50 = Math.LN2;         // 0.6931

/**
 * Forecast how long the locked edge should stay valid.
 *
 * @param series        Tail-membership 0/1 series of the LOCKED normal contract.
 * @param criticalRate  Rate below which the lock's justification fails (the LCB
 *                      the scan approved).
 * @param symbol        Market symbol — sets the tick cadence for wall-clock.
 * @param secondsPerTrade  Average seconds the engine spends per trade
 *                      (execution + settle), used for the trade-count estimate.
 */
export function estimateEdgeValidity(
  series: number[],
  criticalRate: number,
  symbol: string,
  secondsPerTrade = 2.2,
): EdgeValidity {
  const drift = driftHorizon(series, criticalRate);
  const memory = memoryHorizon(series);
  const dwell = dwellHorizon(series);

  const candidates: Array<{ factor: EdgeValidity["bindingFactor"]; ticks: number }> = [
    { factor: "drift", ticks: drift.horizonTicks },
    { factor: "memory", ticks: memory.horizonTicks },
    { factor: "regime-dwell", ticks: dwell.horizonTicks },
  ];
  const finite = candidates.filter(c => Number.isFinite(c.ticks));
  let binding: EdgeValidity["bindingFactor"] = "unbounded";
  let meanTicks = Number.POSITIVE_INFINITY;
  for (const c of finite) {
    if (c.ticks < meanTicks) { meanTicks = c.ticks; binding = c.factor; }
  }

  // Cap at something a user can act on. An "8 hour" edge forecast from 300
  // ticks of history is not evidence, it is extrapolation — so the forecast is
  // capped by the observation window itself (you cannot credibly forecast a
  // lifetime longer than the history you measured it from).
  const windowCap = Math.max(120, series.length) * 3;
  if (!Number.isFinite(meanTicks) || meanTicks > windowCap) {
    meanTicks = windowCap;
    if (binding === "unbounded" || meanTicks === windowCap) binding = binding === "unbounded" ? "unbounded" : binding;
  }
  meanTicks = clamp(meanTicks, 12, windowCap);

  const p20Ticks = Math.round(meanTicks * EXP_P20);
  const p50Ticks = Math.round(meanTicks * EXP_P50);
  const spt = secondsPerTick(symbol);

  // Confidence: more history and agreement between the independent horizons
  // both raise it; a single binding estimator from a thin window lowers it.
  const sampleTerm = clamp((series.length - 120) / 300, 0, 1);
  const spread = finite.length >= 2
    ? clamp(1 - (Math.max(...finite.map(c => c.ticks)) - Math.min(...finite.map(c => c.ticks))) /
        Math.max(1, Math.max(...finite.map(c => c.ticks))), 0, 1)
    : 0.4;
  const confidence = Math.round(clamp(35 + 45 * sampleTerm + 20 * spread, 20, 95));

  const mins = (t: number) => (t * spt) / 60;
  const factorWord =
    binding === "drift" ? "rate drift"
    : binding === "memory" ? "loss of serial memory"
    : binding === "regime-dwell" ? "this market's own regime turnover"
    : "the length of the analysed window";

  const summary =
    `Edge expected to hold ≈ ${Math.round(mins(p50Ticks))} min (${p50Ticks} ticks); ` +
    `plan to re-scan by ≈ ${Math.round(mins(p20Ticks))} min (${p20Ticks} ticks). ` +
    `Binding constraint: ${factorWord}.`;

  return {
    meanTicks: Math.round(meanTicks),
    p20Ticks,
    p50Ticks,
    p20Seconds: Math.round(p20Ticks * spt),
    p50Seconds: Math.round(p50Ticks * spt),
    p20Trades: Math.max(1, Math.round((p20Ticks * spt) / Math.max(0.5, secondsPerTrade))),
    p50Trades: Math.max(1, Math.round((p50Ticks * spt) / Math.max(0.5, secondsPerTrade))),
    bindingFactor: binding,
    confidence,
    drift,
    memory,
    dwell,
    summary,
  };
}

// ── Live decay tracking ───────────────────────────────────────────────────────

export type FreshnessState = "fresh" | "aging" | "stale" | "expired";

export interface ValiditySnapshot {
  state: FreshnessState;
  /** 0–100. 100 = exactly the edge the scan measured; 0 = fully consumed. */
  freshness: number;
  /** Ticks/seconds remaining against the p20 planning horizon (floored at 0). */
  remainingSeconds: number;
  remainingTrades: number;
  elapsedSeconds: number;
  /** Forecast planning horizon in seconds (p20) and expected (p50). */
  horizonSeconds: number;
  expectedSeconds: number;
  /** Realised win rate of the locked normal leg (EWMA), and the locked estimate. */
  realisedRate: number;
  lockedRate: number;
  /** Deviation of realised from locked, in σ (negative = underperforming). */
  deviationSigma: number;
  /** Page–Hinkley drift statistic and its alarm threshold. */
  phStatistic: number;
  phThreshold: number;
  /** Did the sequential change detector fire? (advisory only — never stops.) */
  changeDetected: boolean;
  normalTrades: number;
  /** Plain-language recommendation shown to the user. */
  advice: string;
}

/**
 * Live edge-decay tracker for one locked session.
 *
 * Advisory ONLY. It never stops, pauses or alters the session — its entire job
 * is to keep an honest, continuously-updated answer to "is the edge I locked
 * still there, and how much longer should I expect it to last?" so the user can
 * choose their own exit and re-scan moment.
 */
export class EdgeValidityTracker {
  private readonly startedAt = Date.now();
  private readonly lockedRate: number;
  private readonly horizon: EdgeValidity;

  /** EWMA of the locked normal leg's realised win indicator (~40-trade memory). */
  private ewma: number;
  private readonly alpha = 0.975;
  private normalTrades = 0;

  // Page–Hinkley state (one-sided: detects a DROP in the win rate).
  private phSum = 0;
  private phMax = 0;
  private phAlarm = false;
  /** Magnitude of drop we care about: 3 percentage points. */
  private readonly phDelta = 0.03;
  private readonly phLambda: number;

  constructor(lockedRate: number, horizon: EdgeValidity) {
    this.lockedRate = lockedRate;
    this.horizon = horizon;
    this.ewma = lockedRate;
    // Threshold scaled to the leg's own noise: 8σ of a single Bernoulli draw.
    this.phLambda = 8 * Math.sqrt(Math.max(1e-4, lockedRate * (1 - lockedRate)));
  }

  /** Record the outcome of ONE normal-leg trade (recovery trades are excluded). */
  recordNormalOutcome(won: boolean): void {
    const x = won ? 1 : 0;
    this.normalTrades++;
    this.ewma = this.alpha * this.ewma + (1 - this.alpha) * x;

    // Page–Hinkley (drop detection).
    this.phSum += this.lockedRate - x - this.phDelta;
    this.phMax = Math.max(this.phMax, this.phSum);
    // Note: for drop detection we track the RISE of the cumulative deficit.
    if (this.phSum - Math.min(0, this.phMax) > this.phLambda) this.phAlarm = true;
  }

  snapshot(): ValiditySnapshot {
    const elapsedSeconds = Math.round((Date.now() - this.startedAt) / 1000);
    const horizonSeconds = this.horizon.p20Seconds;
    const expectedSeconds = this.horizon.p50Seconds;
    const remainingSeconds = Math.max(0, horizonSeconds - elapsedSeconds);

    const sigma = Math.sqrt(Math.max(1e-6, (this.lockedRate * (1 - this.lockedRate)) /
      Math.max(8, Math.min(40, this.normalTrades || 8))));
    const deviationSigma = this.normalTrades >= 8 ? (this.ewma - this.lockedRate) / sigma : 0;

    // Freshness fuses three independent signals, each 0–1 (1 = perfectly fresh):
    //   time   — how much of the planning horizon is left
    //   perf   — realised vs locked rate, in σ (only underperformance costs)
    //   change — the sequential change detector's proximity to its alarm
    const timeTerm = horizonSeconds > 0 ? clamp(remainingSeconds / horizonSeconds, 0, 1) : 0;
    const perfTerm = clamp(1 + Math.min(0, deviationSigma) / 3, 0, 1);
    const phRatio = this.phLambda > 0 ? clamp(this.phSum / this.phLambda, 0, 1) : 0;
    const changeTerm = this.phAlarm ? 0 : clamp(1 - phRatio, 0, 1);

    // Evidence outranks the forecast once there is enough of it: with < 10
    // normal trades the time term carries the score, after ~30 the realised
    // performance does.
    const evidenceWeight = clamp(this.normalTrades / 30, 0, 1);
    const freshness01 =
      (1 - evidenceWeight) * timeTerm +
      evidenceWeight * (0.55 * perfTerm + 0.25 * changeTerm + 0.20 * timeTerm);
    const freshness = Math.round(clamp(freshness01, 0, 1) * 100);

    let state: FreshnessState;
    if (this.phAlarm || freshness < 25) state = "expired";
    else if (freshness < 45) state = "stale";
    else if (freshness < 70) state = "aging";
    else state = "fresh";

    const mins = Math.round(remainingSeconds / 60);
    const advice =
      state === "fresh"
        ? `Edge intact — about ${mins} min of validity left before a re-scan is advisable.`
        : state === "aging"
          ? `Edge aging — roughly ${mins} min left. Fine to keep running; plan your exit.`
          : state === "stale"
            ? `Edge weakening — the analysed conditions are fading. Consider stopping and re-scanning for a fresh market.`
            : this.phAlarm
              ? `Edge expired — a statistically significant drop from the locked ${(this.lockedRate * 100).toFixed(1)}% rate was detected. Stopping and re-scanning is recommended (the bot will keep trading until you do).`
              : `Edge expired — the forecast validity window has elapsed. Stopping and re-scanning is recommended (the bot will keep trading until you do).`;

    return {
      state,
      freshness,
      remainingSeconds,
      remainingTrades: Math.max(0, this.horizon.p20Trades - this.normalTrades),
      elapsedSeconds,
      horizonSeconds,
      expectedSeconds,
      realisedRate: round(this.ewma, 4),
      lockedRate: round(this.lockedRate, 4),
      deviationSigma: round(deviationSigma, 2),
      phStatistic: round(this.phSum, 3),
      phThreshold: round(this.phLambda, 3),
      changeDetected: this.phAlarm,
      normalTrades: this.normalTrades,
      advice,
    };
  }
}
