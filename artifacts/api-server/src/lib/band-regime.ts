/**
 * Band Regime — shared statistical toolkit for the Over/Under family
 * (Barrier Bastion + Over/Under Navigator).
 *
 * Pure and synchronous: no Deriv imports, no DB, no clock — everything here
 * is testable on a deterministic digit tape.
 *
 * New structure added on top of the four legacy lenses (digit Markov, band
 * Markov, hole hazard, suffix memory):
 *
 *  5. EW DRIFT — a recency-weighted win rate shrunk toward the band's fair
 *     rate (Bayesian EWMA with an informative Beta prior on the combinatorial
 *     fair probability). It is the lens that sees SLOW regime drift — "this
 *     tape has been running 68% Over-3 for the last five minutes" — which
 *     order-1/2 Markov contexts structurally cannot.
 *  6. REGIME HMM — a 2-state hidden Markov model (Bernoulli emissions) fitted
 *     by Baum–Welch on a rolling window of the band's win/loss indicator.
 *     The forward filter produces the posterior over the hidden regime and
 *     the posterior predictive P(win) = Σ γ(s)·B_s — persistence-aware
 *     regime estimation, the classic HMM regime-detection construction.
 *
 * Plus two decision-layer upgrades:
 *
 *  - CONTEXTUAL PAIR RISK — the loss-pair penalty now uses the order-2 band
 *    chain P(loss | last two band states) blended with the order-1 estimate,
 *    so the side/market that is actually clustering losses right now loses
 *    the arbitration (still a function of the TAPE, never of the loss run).
 *  - CALIBRATED STATIC BAR — the recovery bar moves from "combinatorial fair"
 *    to the payout-aware break-even rate, clamped to [fair, fair + 0.02].
 *    It is STILL static: a function of the contract and its payout only —
 *    nothing on the recovery path sees the loss run, and the clamp bounds the
 *    shift so the fire rate can barely change. Shots fired AT the bar now
 *    have (≈) non-negative paper expectancy instead of a built-in −1.5% leak.
 *
 * And the MARKET SCOUT — the switching engine (normal AND recovery):
 * a per-market composite score built from (a) the live EW edge of each armed
 * band on the recent tape, (b) the held-out walk-forward edge from the last
 * full re-fit (age-decayed), and (c) the bot's own fired-outcome record on
 * that market (Beta-shrunk). Switching is hysteresis-protected (margin +
 * cooldown + minimum dwell). The scout only redirects WHERE the existing
 * fire budget lands — it adds no veto, so it can never starve the trade
 * stream.
 */

// ── Lens 5: EW drift (recency-weighted rate, informative Beta prior) ─────────

export interface EWBandOptions {
  /** Ticks of half-life (default 120 ≈ a few minutes of 1s ticks). */
  halfLife?: number;
  /** Pseudo-sample prior strength on the fair rate (default 4). */
  priorK?: number;
  /** Tail length to weight (default 240). */
  tail?: number;
}

/**
 * Recency-weighted win rate of a band over the tail of the tape, shrunk
 * toward the band's fair rate: p = (sW + k·fair) / (sW + sL + k) with
 * sW/sL exponentially weighted (weight 2^(−Δticks/halfLife), newest = 1).
 * Stateless — cheap enough to run for every market on every scout pass.
 */
export function ewBandRate(
  digits: ArrayLike<number>,
  wins: readonly boolean[],
  fair: number,
  opts: EWBandOptions = {},
): number {
  const halfLife = opts.halfLife ?? 120;
  const k = opts.priorK ?? 4;
  const tail = Math.max(1, opts.tail ?? 240);
  const n = digits.length;
  if (n === 0) return fair;
  const start = Math.max(0, n - tail);
  let sW = 0;
  let sL = 0;
  const newest = n - 1;
  for (let i = start; i < n; i++) {
    const d = digits[i]!;
    if (!Number.isInteger(d) || d < 0 || d > 9) continue;
    const dt = newest - i;
    const w = Math.pow(0.5, dt / halfLife);
    if (wins[d]) sW += w;
    else sL += w;
  }
  return (sW + k * fair) / (sW + sL + k);
}

/** Expected value per dollar of betting on the band at the given payout. */
export function bandEdge(rate: number, payout: number): number {
  return rate * payout - 1;
}

// ── Lens 6: 2-state regime HMM (Baum–Welch + forward filter) ─────────────────

export interface RegimeHMMParams {
  /** 2×2 transition matrix, row-major: [P(0|0), P(1|0), P(0|1), P(1|1)]. */
  A: [number, number, number, number];
  /** Emission: P(win | state 0), P(win | state 1) — state 1 is the hot state. */
  B: [number, number];
  /** Log-likelihood of the fitted window (diagnostics). */
  logLik: number;
}

const HMM_MIN_WINDOW = 40;
const HMM_MAX_ITER = 24;
const HMM_EPS = 0.05;

/**
 * Baum–Welch for a 2-state HMM with Bernoulli emissions on the band's
 * win/loss indicator. Regularized (Jeffreys on transitions, Beta(1,1) on
 * emissions, clip to [0.05, 0.95]) and identifiability-fixed (the hotter
 * emission is always state 1). Fast: T×2×iterations of tiny arithmetic.
 */
export function fitRegimeHMM(indicators: readonly number[]): RegimeHMMParams | null {
  const T = indicators.length;
  if (T < HMM_MIN_WINDOW) return null;

  // Init: slow-switching chain, generic emissions around the data mean.
  const mean = indicators.reduce((a, b) => a + b, 0) / T;
  let A: [number, number, number, number] = [0.9, 0.1, 0.1, 0.9];
  let B: [number, number] = [clamp01(mean - 0.15), clamp01(mean + 0.15)];
  if (B[1]! - B[0]! < 0.02) {
    B = [clamp01(mean - 0.2), clamp01(mean + 0.2)];
  }

  const o = new Float64Array(T);
  for (let t = 0; t < T; t++) o[t] = indicators[t]! === 1 ? 1 : 0;

  let logLik = 0;
  for (let iter = 0; iter < HMM_MAX_ITER; iter++) {
    // Forward (scaled).
    const alpha = new Float64Array(T * 2);
    const scale = new Float64Array(T);
    const b0 = B[0]!;
    const b1 = B[1]!;
    alpha[0] = 0.5 * (o[0] ? b0 : 1 - b0); // state 0
    alpha[1] = 0.5 * (o[0] ? b1 : 1 - b1); // state 1
    scale[0] = alpha[0] + alpha[1] || 1e-300;
    alpha[0] /= scale[0];
    alpha[1] /= scale[0];
    logLik = Math.log(scale[0]);
    for (let t = 1; t < T; t++) {
      const ot = o[t]!;
      const s0 = alpha[t * 2 - 2]! * A[0]! + alpha[t * 2 - 1]! * A[2]!;
      const s1 = alpha[t * 2 - 2]! * A[1]! + alpha[t * 2 - 1]! * A[3]!;
      alpha[t * 2] = s0 * (ot ? b0 : 1 - b0); // state 0
      alpha[t * 2 + 1] = s1 * (ot ? b1 : 1 - b1); // state 1
      scale[t] = alpha[t * 2] + alpha[t * 2 + 1] || 1e-300;
      alpha[t * 2] /= scale[t];
      alpha[t * 2 + 1] /= scale[t];
      logLik += Math.log(scale[t]);
    }
    // Backward.
    const beta = new Float64Array(T * 2);
    beta[(T - 1) * 2] = 1;
    beta[(T - 1) * 2 + 1] = 1;
    for (let t = T - 2; t >= 0; t--) {
      // em* = P(o[t+1] | state*).  With the in-place-scaled alpha, the
      // matching scaled backward recursion divides by scale[t+1] so that
      // gamma[t,i] = alpha[t,i]·beta[t,i] sums to 1 per time step.
      const em0 = o[t + 1] ? b0 : 1 - b0;
      const em1 = o[t + 1] ? b1 : 1 - b1;
      const b0n = beta[(t + 1) * 2]!;
      const b1n = beta[(t + 1) * 2 + 1]!;
      beta[t * 2] = (A[0]! * em0 * b0n + A[1]! * em1 * b1n) / scale[t + 1]!;
      beta[t * 2 + 1] = (A[2]! * em0 * b0n + A[3]! * em1 * b1n) / scale[t + 1]!;
    }
    // Gamma + xi aggregation (single pass). With the in-place-scaled alpha
    // and the scale[t+1]-divided backward pass above, gamma[t,i] =
    // alpha[t,i]·beta[t,i] exactly (sums to 1 per step), and the transition
    // occupancy is xi[t,i,j] = alpha[t,i]·A[i→j]·em_j·beta[t+1,j]/scale[t+1].
    let n00 = 0, n01 = 0, n10 = 0, n11 = 0;
    let e0 = 0.5, e1 = 0.5;
    let d0 = 1, d1 = 1;
    for (let t = 0; t < T; t++) {
      const g0 = alpha[t * 2]! * beta[t * 2]!;
      const g1 = alpha[t * 2 + 1]! * beta[t * 2 + 1]!;
      e0 += g0 * o[t]!;
      e1 += g1 * o[t]!;
      d0 += g0;
      d1 += g1;
      if (t < T - 1) {
        const den = scale[t + 1]! || 1e-300;
        const em0 = o[t + 1] ? b0 : 1 - b0;
        const em1 = o[t + 1] ? b1 : 1 - b1;
        const b0n = beta[(t + 1) * 2]!;
        const b1n = beta[(t + 1) * 2 + 1]!;
        n00 += (alpha[t * 2]! * A[0]! * em0 * b0n) / den;
        n01 += (alpha[t * 2]! * A[1]! * em1 * b1n) / den;
        n10 += (alpha[t * 2 + 1]! * A[2]! * em0 * b0n) / den;
        n11 += (alpha[t * 2 + 1]! * A[3]! * em1 * b1n) / den;
      }
    }
    // M-step with regularization.
    const R0 = n00 + n01 + 2 * HMM_EPS;
    const R1 = n10 + n11 + 2 * HMM_EPS;
    const NA: [number, number, number, number] = [
      (n00 + HMM_EPS) / R0,
      (n01 + HMM_EPS) / R0,
      (n10 + HMM_EPS) / R1,
      (n11 + HMM_EPS) / R1,
    ];
    const NB: [number, number] = [clampHMM(e0 / d0), clampHMM(e1 / d1)];
    // Identifiability: state 1 must be the hotter state. Swapping state
    // names (new0 = old1, new1 = old0) relabels the transition matrix as
    // A' = [A11, A10, A01, A00].
    if (NB[1]! >= NB[0]!) {
      A = NA;
      B = NB;
    } else {
      A = [NA[3]!, NA[2]!, NA[1]!, NA[0]!];
      B = [NB[1]!, NB[0]!];
    }
    if (B[1]! - B[0]! < 0.02) break; // degenerate — no regime structure
  }

  return { A, B, logLik };
}

function clampHMM(v: number): number { return Math.min(0.95, Math.max(0.05, v)); }

/**
 * Online 2-state regime filter. Fit once on a rolling window (causal — only
 * past data), then advance one tick per new observation. `p()` is the
 * posterior predictive P(next band win) = Σ γ(s)·B_s.
 */
export class BandRegimeHMM {
  private A: [number, number, number, number] | null = null;
  private B: [number, number] | null = null;
  private a0 = 0.5;
  private a1 = 0.5;
  private fitted = false;
  private readonly wins: readonly boolean[];

  constructor(wins: readonly boolean[]) {
    this.wins = wins;
  }

  /** Fit (or adopt) parameters and initialize the forward filter on a window of PAST indicators. */
  load(params: RegimeHMMParams | null, window?: readonly number[]): void {
    if (!params || !window || window.length < HMM_MIN_WINDOW) {
      this.A = null;
      this.B = null;
      this.a0 = 0.5;
      this.a1 = 0.5;
      this.fitted = false;
      return;
    }
    this.A = [...params.A] as [number, number, number, number];
    this.B = [...params.B] as [number, number];
    // Forward pass over the window so the posterior at the window's end is live.
    this.a0 = 0.5;
    this.a1 = 0.5;
    for (let t = 0; t < window.length; t++) {
      const ind = window[t]! === 1 ? 1 : 0;
      this.step(ind);
    }
    this.fitted = true;
  }

  get isFitted(): boolean { return this.fitted; }
  get emissions(): [number, number] | null { return this.B ? [...this.B] as [number, number] : null; }
  /** Posterior of the hot state (diagnostics: regime belief 0..1). */
  get hotBelief(): number {
    const s = this.a0 + this.a1;
    return s > 0 ? this.a1 / s : 0.5;
  }

  private step(ind: 0 | 1): void {
    const A = this.A!;
    const B = this.B!;
    const bHot = ind ? B[1]! : 1 - B[1]!;
    const bCold = ind ? B[0]! : 1 - B[0]!;
    const s0 = this.a0 * A[0]! + this.a1 * A[2]!;
    const s1 = this.a0 * A[1]! + this.a1 * A[3]!;
    this.a0 = s0 * bCold;
    this.a1 = s1 * bHot;
    const norm = this.a0 + this.a1 || 1e-300;
    this.a0 /= norm;
    this.a1 /= norm;
  }

  /** Advance with a fresh digit (O(1)). */
  update(digit: number): void {
    if (!this.fitted) return;
    this.step(this.wins[digit] ? 1 : 0);
  }

  /** Posterior predictive P(next win); neutral 0.5 when unfitted. */
  p(): number {
    if (!this.fitted || !this.B) return 0.5;
    const s = this.a0 + this.a1 || 1e-300;
    return (this.a0 * this.B[0]! + this.a1 * this.B[1]!) / s;
  }
}

/** Extract a band's win/loss indicator sequence (1 = win) from digits. */
export function bandIndicators(
  digits: ArrayLike<number>,
  wins: readonly boolean[],
  tail = Infinity,
): number[] {
  const n = Math.min(digits.length, tail);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = digits[digits.length - n + i]!;
    out[i]! = Number.isInteger(d) && d >= 0 && d <= 9 && wins[d] ? 1 : 0;
  }
  return out;
}

// ── Calibrated static recovery bar ───────────────────────────────────────────

/**
 * The static recovery bar, payout-aware: the break-even win probability
 * (1/payout) clamped into [fair, fair + 0.02].
 *
 * - Never below the combinatorial fair rate (it can never make the bot MORE
 *   aggressive than the legacy design on the probability axis).
 * - Capped at fair + 0.02 so the shift is bounded — the fire rate moves at
 *   most a hair, while shots fired exactly at the bar stop leaking ~1.5% of
 *   stake to the house edge (with the canonical payoutFor(fair) = 0.985/fair
 *   schedule, 1/payout = fair/0.985 ≈ fair × 1.0152).
 * - A function of the contract and its payout ONLY. Nothing on the recovery
 *   path sees the loss run — the no-ratchet guarantee is untouched.
 */
export function calibratedRecoveryBar(fair: number, payout: number): number {
  const breakEven = 1 / Math.max(1.001, payout);
  return Math.min(fair + 0.02, Math.max(fair, breakEven));
}

// ── Pool-weight compatibility (4 legacy lenses → 6) ──────────────────────────

/**
 * Accept legacy 4-lens weight vectors (old scan cards still in browsers) and
 * current 6-lens vectors; produce a normalized length-`dim` vector. Legacy
 * weights map to the same four lenses with the two regime lenses at zero —
 * exactly the legacy behaviour until the next re-fit delivers 6-lens weights.
 */
export function expandPoolWeights(
  w: readonly number[],
  dim: number,
): number[] {
  if (w.length === dim) {
    const s = w.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    return w.map((v) => (Number.isFinite(v) ? v : 0) / (s || 1));
  }
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < Math.min(dim, w.length); i++) {
    out[i] = Number.isFinite(w[i]) ? w[i]! : 0;
  }
  const s = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((v) => v / s);
}

// ── Market Scout (switching engine) ──────────────────────────────────────────

export interface ScoutMarket {
  symbol: string;
  displayName: string;
}

export interface ScoutContractSpec {
  wins: readonly boolean[];
  fair: number;
  payout: number;
}

export interface ScoutModeSpec {
  normal: ScoutContractSpec[];
  recovery: ScoutContractSpec[];
}

/** Held-out walk-forward card from the last full re-fit of a market. */
export interface ScoutCard {
  /** Combined paper edge, $ per $ (normal + recovery replay). */
  edge: number;
  recoveryHitRate: number;
  recoveryShots: number;
  at: number; // Date.now() when the card was made
}

export interface ScoutConfig {
  /** Composite edge advantage required to switch (default 0.012 $/$). */
  margin?: number;
  /** Minimum ms between two switches (default 60s). */
  cooldownMs?: number;
  /** Minimum ms spent on a market before it may be abandoned (default 90s). */
  minDwellMs?: number;
  /** Half-life of the card's authority, ms (default 15 min). */
  cardHalfLifeMs?: number;
  /** Scout live EW window options. */
  live?: EWBandOptions;
  liveWeight?: number;
  cardWeight?: number;
  provenWeight?: number;
  /** Half-life of loss-streak penalties (default 4 min). */
  penaltyHalfLifeMs?: number;
}

export interface ScoutScore {
  symbol: string;
  displayName: string;
  composite: number;
  live: number;
  card: number;
  proven: number;
  /** Decayed loss-streak penalty already subtracted from `composite`. */
  penalty: number;
}

export interface ScoutChallenger {
  symbol: string;
  displayName: string;
  composite: number;
  activeComposite: number;
  /** True when the flee clause (active tape dead) relaxed the margin. */
  flee: boolean;
  /** Which clause opened the door: hysteresis (default), flee, or urgency. */
  via: "margin" | "flee" | "urgent";
}

/**
 * Optional urgency signal for `bestChallenger`. When the caller reports that
 * the active market is STARVING it (no bar-clearing setup for a long stretch)
 * or BLEEDING it (a fresh loss streak), the anti-flap clocks are waived and
 * the margin relaxed — those clocks exist to stop flapping between two good
 * tapes, not to pin the bot to a tape that is giving it nothing. Default
 * (no urgency) is byte-for-byte the legacy hysteresis rule.
 */
export interface ScoutUrgency {
  /** 0 = calm (legacy rule) … 1 = fully urgent (dwell waived, margin ÷ 4). */
  level: number;
  /** Human reason, echoed back in the challenger for the console. */
  reason?: string;
}

/**
 * The Market Scout. Scores every allowed market on a per-$ composite of three
 * independent evidence streams and decides, with hysteresis, whether the bot
 * should redirect its fire budget elsewhere.
 *
 *   live    — EW edge of each armed band on the last ~240 ticks (regime
 *             evidence, seconds-old, O(20·240) arithmetic — no network)
 *   card    — held-out walk-forward edge from the last full re-fit,
 *             age-decayed (measurement evidence, minutes-old)
 *   proven  — the bot's own fired outcomes on that market, Beta-shrunk
 *             (experience evidence; silent until 4+ shots)
 *
 * Switch rules (anti-flap):
 *   challenger − active ≥ margin, AND ≥ cooldown since the last switch, AND
 *   ≥ min-dwell on the active market. Flee clause: when the active tape's
 *   live edge is ≤ 0, the margin is halved — a dead tape should be abandoned
 *   faster, not waited out.
 *
 * The scout NEVER suppresses a shot: if it says "stay", the policy behaves
 * exactly as the legacy bot. Switching only changes which tape the existing
 * fire budget (the pacing valve / the static recovery bar) is applied to.
 */
export class MarketScout {
  private readonly margin: number;
  private readonly cooldownMs: number;
  private readonly minDwellMs: number;
  private readonly cardHalfLifeMs: number;
  private readonly live: EWBandOptions;
  private readonly liveWeight: number;
  private readonly cardWeight: number;
  private readonly provenWeight: number;

  private cards = new Map<string, ScoutCard>();
  private enteredAt = new Map<string, number>();
  private lastSwitchAt = 0;
  private outcomes = new Map<string, { nH: number; nL: number; rH: number; rL: number }>();
  /** Decaying per-market penalty ($/$) applied after a loss streak. */
  private penalties = new Map<string, { amount: number; at: number }>();
  private readonly penaltyHalfLifeMs: number;

  constructor(
    public readonly markets: readonly ScoutMarket[],
    public readonly modes: ScoutModeSpec,
    config: ScoutConfig = {},
  ) {
    this.margin = config.margin ?? 0.012;
    this.cooldownMs = config.cooldownMs ?? 60_000;
    this.minDwellMs = config.minDwellMs ?? 90_000;
    this.cardHalfLifeMs = config.cardHalfLifeMs ?? 15 * 60_000;
    this.live = config.live ?? {};
    this.liveWeight = config.liveWeight ?? 0.55;
    this.cardWeight = config.cardWeight ?? 0.3;
    this.provenWeight = config.provenWeight ?? 0.15;
    this.penaltyHalfLifeMs = config.penaltyHalfLifeMs ?? 4 * 60_000;
  }

  /**
   * Punish a market that just cost the bot a streak. The penalty is a plain
   * $/$ subtraction from that market's composite that halves every
   * `penaltyHalfLifeMs`, so the market is not banned — it must simply EARN the
   * seat back rather than keep it by inertia. Stacks (capped) on repeats.
   */
  penalize(symbol: string, amount: number, now: number): void {
    const cur = this.penaltyOf(symbol, now);
    this.penalties.set(symbol, { amount: Math.min(0.08, cur + amount), at: now });
  }

  /** Current (decayed) penalty for a market, $/$. */
  penaltyOf(symbol: string, now: number): number {
    const p = this.penalties.get(symbol);
    if (!p) return 0;
    const v = p.amount * Math.pow(0.5, Math.max(0, now - p.at) / this.penaltyHalfLifeMs);
    return v < 1e-4 ? 0 : v;
  }

  /** Called when the bot starts on a market (or lands on one via a switch). */
  enter(symbol: string, now: number): void {
    if (!this.enteredAt.has(symbol)) this.enteredAt.set(symbol, now);
  }

  /** Called after every executed switch (resets the cooldown). */
  markSwitch(now: number): void {
    this.lastSwitchAt = now;
  }

  setCard(symbol: string, card: ScoutCard): void {
    this.cards.set(symbol, card);
  }

  recordOutcome(symbol: string, mode: "normal" | "recovery", won: boolean): void {
    let o = this.outcomes.get(symbol);
    if (!o) {
      o = { nH: 0, nL: 0, rH: 0, rL: 0 };
      this.outcomes.set(symbol, o);
    }
    if (mode === "recovery") (won ? (o.rH += 1) : (o.rL += 1));
    else won ? (o.nH += 1) : (o.nL += 1);
  }

  private avgPayout(mode: "normal" | "recovery"): number {
    const list = mode === "normal" ? this.modes.normal : this.modes.recovery;
    if (!list.length) return 1.5;
    return list.reduce((a, c) => a + c.payout, 0) / list.length;
  }

  /** Live EW edge of a market's armed bands in the given mode ($ per $). */
  liveEdge(symbol: string, mode: "normal" | "recovery", digits: ArrayLike<number>): number {
    const list = mode === "normal" ? this.modes.normal : this.modes.recovery;
    if (!list.length || digits.length < 20) return 0;
    let sum = 0;
    for (const c of list) {
      sum += bandEdge(ewBandRate(digits, c.wins, c.fair, this.live), c.payout);
    }
    return sum / list.length;
  }

  /** Composite scores for all markets in the given mode (ranked desc). */
  scores(
    mode: "normal" | "recovery",
    read: (symbol: string) => ArrayLike<number>,
    now: number,
  ): ScoutScore[] {
    const out: ScoutScore[] = [];
    for (const m of this.markets) {
      const digits = read(m.symbol);
      const live = this.liveEdge(m.symbol, mode, digits);

      const card = this.cards.get(m.symbol);
      let cardTerm = 0;
      if (card) {
        const age = Math.max(0, now - card.at);
        const decay = Math.pow(0.5, age / this.cardHalfLifeMs);
        const base =
          mode === "recovery" && card.recoveryShots >= 3
            ? bandEdge(card.recoveryHitRate, this.avgPayout("recovery"))
            : card.edge;
        cardTerm = Math.max(-1, Math.min(1, base * decay));
      }

      let proven = 0;
      const o = this.outcomes.get(m.symbol);
      if (o) {
        const hits = mode === "recovery" ? o.rH : o.nH;
        const misses = mode === "recovery" ? o.rL : o.nL;
        const n = hits + misses;
        if (n >= 4) {
          const rate = (hits + 2) / (n + 4); // Beta(2,2) shrink toward 0.5
          proven = Math.max(-1, Math.min(1, bandEdge(rate, this.avgPayout(mode))));
        }
      }

      // Renormalize over the components that actually have evidence.
      let w = this.liveWeight;
      let composite = this.liveWeight * live;
      if (card) {
        composite += this.cardWeight * cardTerm;
        w += this.cardWeight;
      }
      if (proven !== 0) {
        composite += this.provenWeight * proven;
        w += this.provenWeight;
      }
      composite /= w || 1;
      const penalty = this.penaltyOf(m.symbol, now);
      composite -= penalty;

      out.push({
        symbol: m.symbol,
        displayName: m.displayName,
        composite,
        live,
        card: cardTerm,
        proven,
        penalty,
      });
    }
    out.sort((a, b) => b.composite - a.composite);
    return out;
  }

  /**
   * Hysteresis-protected switch decision. Returns the best challenger when it
   * beats the active market by the margin AND the anti-flap clocks allow it;
   * null otherwise (the bot stays and trades exactly as before).
   */
  bestChallenger(
    mode: "normal" | "recovery",
    read: (symbol: string) => ArrayLike<number>,
    activeSymbol: string,
    now: number,
    urgency?: ScoutUrgency,
  ): ScoutChallenger | null {
    if (this.markets.length < 2) return null;
    const ranked = this.scores(mode, read, now);
    const active = ranked.find((s) => s.symbol === activeSymbol);
    if (!active) return null;
    const u = clamp01(urgency?.level ?? 0);
    const urgent = u > 0;
    // Urgency waives the dwell clock entirely and shrinks the cooldown — a
    // starving/bleeding tape has forfeited its right to be waited out. A
    // short residual cooldown always remains so two urgent passes in a row
    // cannot ping-pong.
    const dwellOk = urgent || now - (this.enteredAt.get(activeSymbol) ?? 0) >= this.minDwellMs;
    const effCooldown = urgent ? Math.max(5_000, this.cooldownMs * (1 - 0.75 * u)) : this.cooldownMs;
    const cooldownOk = now - this.lastSwitchAt >= effCooldown;
    if (!dwellOk || !cooldownOk) return null;

    const deadTape = active.live <= 0;
    let effMargin = deadTape ? this.margin / 2 : this.margin;
    if (urgent) effMargin = Math.min(effMargin, this.margin / (1 + 3 * u));
    for (const s of ranked) {
      if (s.symbol === activeSymbol) continue;
      // An urgent switch must still land on a tape with a POSITIVE live edge —
      // fleeing a bad market into an equally dead one is not a rescue.
      if (urgent && s.live <= 0) break;
      if (s.composite - active.composite >= effMargin) {
        return {
          symbol: s.symbol,
          displayName: s.displayName,
          composite: s.composite,
          activeComposite: active.composite,
          flee: deadTape,
          via: urgent ? "urgent" : deadTape ? "flee" : "margin",
        };
      }
      break; // only the TOP challenger is ever considered
    }
    return null;
  }

  /** Top-N leaderboard for the UI (composite scores, current mode). */
  top(
    mode: "normal" | "recovery",
    read: (symbol: string) => ArrayLike<number>,
    now: number,
    n = 3,
  ): ScoutScore[] {
    return this.scores(mode, read, now).slice(0, n);
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
