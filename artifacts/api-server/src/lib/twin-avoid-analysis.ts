/**
 * TWIN-HEDGE EDGE — the digit 4/5 dead-zone avoidance engine (v3).
 *
 * The contract plan is AUTO-CONFIGURED — the user cannot change it, only the
 * risk settings:
 *
 *   NORMAL shot    : DIGITOVER 4 + DIGITUNDER 5   (equal stakes, same tick)
 *   RECOVERY shot  : DIGITOVER 5 + DIGITUNDER 4   (equal stakes, same tick)
 *
 * WHY THIS SHAPE
 * ──────────────
 * The normal pair is complementary: every closed digit wins exactly one leg
 * (0–4 wins Under 5, 5–9 wins Over 4), so the pair NEVER double-loses. At the
 * 1.95× payout of both legs a normal shot nets +0.95 − 1.00 = **−0.05 per $1**
 * of stake — a small fixed cost that parks a tiny debt in the shared
 * recovery ledger.
 *
 * The recovery pair is the engine. It wins on every digit EXCEPT 4 and 5:
 *   · digit ∉ {4,5} : one leg wins at 2.43×, the other loses  → net **+1.43**
 *   · digit ∈ {4,5} : BOTH legs lose                          → net **−2.00**
 * So the whole analysis budget of the bot is spent on ONE question:
 *
 *     P(next closed digit ∈ {4,5} | context) — and is that reading cleaner
 *     than this market's own baseline?
 *
 * THE MODEL
 * ─────────
 * Three probability estimators for the next digit, fused in inverse variance:
 *   1. order-0  — forgetting Dirichlet (exponential half-life ≈ 69 ticks),
 *   2. order-1  — Markov row conditioned on the last closed digit,
 *   3. order-2  — Markov row conditioned on the last TWO closed digits
 *                 (falls back to order-1 when its own evidence is thin).
 * Each estimator carries its own predictive variance, so a well-fed
 * conditional model outweighs a sparse one automatically — no fixed blending.
 *
 * THE GATE (recovery — the one that matters)
 *   hard vetoes, NEVER overriden ("at no cost"):
 *     · market runs 4/5 hot        — baseline P(4/5) > 22%
 *     · 4/5 hot cluster            — 3+ of the last 6 ticks are 4 or 5
 *     · post-4/5 state             — last tick was 4/5 and P(4/5|last) ≥ baseline
 *     · post-loss cool-down        — 2 ticks after any shot
 *   soft gates, overriden only by the patience valve:
 *     · worst plausible case       — P̂ + 1.25σ must sit BELOW the baseline
 *     · self-referential bar       — P̂ must clear the market's own 30th
 *                                    percentile (recovery) / 55th (normal)
 *   patience valve: a debt that waits 25 ticks is bigger danger than an
 *   imperfect reading — fire on the best available non-vetoed reading.
 *
 * THE SCAN
 * ────────
 * Per market, out of sample: the model is fit on the first 60% of ~4999
 * digits and the gate + the EXACT engine rules (debt-driven recovery stakes,
 * 0.35 leg floor, TP/SL, max steps) are MEASURED on the last 40% it never
 * saw. The headline number is survival: P(take-profit before stop-loss) on
 * unseen data. Stationarity (4-block χ² on 4/5 counts) refuses drifting
 * markets. The ranking also DECIDES the market mode: a clear winner is
 * locked, a tight cluster switches — the user does not choose.
 *
 * Everything here is a pure function of digit streams → unit-testable.
 */

// ── The fixed plan ───────────────────────────────────────────────────────────

export const TWIN_AVOID_PLAN = {
  /** Normal shot — complementary: exactly one leg always wins. */
  normal: { overDigit: 4, underDigit: 5, overPayout: 1.95, underPayout: 1.95 },
  /** Recovery shot — dead zone {4,5}: both legs lose on 4 or 5. */
  recovery: { overDigit: 5, underDigit: 4, overPayout: 2.43, underPayout: 2.43 },
  deadZone: [4, 5] as const,
  /** Net per $1 of (equal) stake. One win at 0.95 profit, one loss at 1.00. */
  normalNetPerBase: 0.95 - 1.0, // -0.05 — always (the pair is complementary)
  /** Net per $1 of (equal) stake when the closed digit avoids {4,5}. */
  recoveryWinNetPerBase: 1.43 - 1.0, // +0.43 (winning leg +1.43, losing leg −1.00)
  /** Net per $1 of (equal) stake when the closed digit lands on 4 or 5. */
  recoveryLossNetPerBase: -2.0,
  /**
   * Total-return multiplier used to size the recovery stake: a winning
   * recovery pair nets +0.43 per $1 of leg stake, so the shared recovery
   * formula (which divides by payout − 1) is passed 1.43.
   */
  recoveryEffPayout: 1.43,
} as const;

export const TWIN_AVOID_MIN_HISTORY = 1200;
export const TWIN_AVOID_SCAN_WINDOW = 4999;
/** Minimum spacing between shots (ticks) — fresh evidence, not re-bets. */
export const TWIN_AVOID_MIN_SPACING = 4;
/** A market whose baseline 4/5 rate exceeds this is hot and refused. */
export const TWIN_AVOID_HOT_BASELINE = 0.22;
/** Worst-case margin on the fused estimate (one-sided ≈ 89%). */
export const TWIN_AVOID_SE_MARGIN = 1.25;
/** Ticks of cool-down after any settled shot. */
export const TWIN_AVOID_COOLDOWN = 2;
/** Patience valves (ticks waited before the best available reading fires). */
export const TWIN_AVOID_PATIENCE = { normal: 12, recovery: 25 } as const;
/** Hot-cluster veto: 3+ of the last 6 ticks in {4,5}. */
export const TWIN_AVOID_HOT_CLUSTER = { window: 6, limit: 3 } as const;

export const isInDeadZone = (d: number): boolean => d === 4 || d === 5;

// ── Fused digit-4/5 probability ─────────────────────────────────────────────

const DECAY = 0.99; // forgetting factor — half-life ≈ ln(2)/ln(1/0.99) ≈ 69 ticks
const PRIOR0 = 4; // order-0 Dirichlet α per digit
const PRIOR1 = 2; // order-1 per cell
const PRIOR2 = 1; // order-2 per cell

export interface P45Reading {
  /** Fused P(next closed digit ∈ {4,5}). */
  p45: number;
  /** Standard error of the fused estimate. */
  p45Se: number;
  /** P(next digit = 4) / P(next digit = 5), fused. */
  p4: number;
  p5: number;
  /** Per-model P(4/5) — printed so the UI can show what each expert says. */
  order0: number;
  order1: number;
  order2: number;
  /** Per-model fusion weight (inverse variance, normalised). */
  weight0: number;
  weight1: number;
  weight2: number;
  /** Effective sample size feeding the fused estimate. */
  nEff: number;
  /** True when the stream is too short to say anything. */
  insufficient: boolean;
}

const flatReading = (): P45Reading => ({
  p45: 0.2,
  p45Se: 1,
  p4: 0.1,
  p5: 0.1,
  order0: 0.2,
  order1: 0.2,
  order2: 0.2,
  weight0: 1 / 3,
  weight1: 1 / 3,
  weight2: 1 / 3,
  nEff: 0,
  insufficient: true,
});

/**
 * Incremental (O(1) per tick) forgetting estimator for P(next digit |
 * context). Prime it with history via repeated `step()` calls, then read it
 * and step it forward as new digits arrive.
 *
 * Order-0/1/2 weighted counts all decay by DECAY per tick; the newest
 * observation enters at weight 1, so every count is a half-life-weighted
 * history of the stream.
 */
export class P45Tracker {
  private w0 = new Array<number>(10).fill(PRIOR0);
  private W0 = 0;
  private W0sq = 0;
  // order-1: row per previous digit
  private rowW = new Array<number>(10).fill(0);
  private rowWsq = new Array<number>(10).fill(0);
  private rowWd = Array.from({ length: 10 }, () => new Array<number>(10).fill(PRIOR1));
  private lastDigit: number | null = null;
  // order-2: row per (prev2, prev1) pair, key = prev2 * 10 + prev1
  private pairW = new Map<number, number>();
  private pairWsq = new Map<number, number>();
  private pairWd = new Map<number, Float64Array>();
  private prev2: number | null = null;
  private n = 0;

  step(d: number): void {
    const λ = DECAY;
    // order 0 — every weight ages one tick; the new digit enters at weight 1
    for (let k = 0; k < 10; k++) this.w0[k] = (this.w0[k] - PRIOR0) * λ + PRIOR0;
    this.W0 = this.W0 * λ + 1;
    this.W0sq = this.W0sq * λ * λ + 1;
    this.w0[d] += 1;

    // order 1 — EVERY context row ages every tick (age is measured in ticks,
    // not in visits), then the new transition last → d is recorded
    for (let c = 0; c < 10; c++) {
      this.rowW[c] *= λ;
      this.rowWsq[c] *= λ * λ;
      const row = this.rowWd[c]!;
      for (let k = 0; k < 10; k++) row[k] = (row[k] - PRIOR1) * λ + PRIOR1;
    }
    if (this.lastDigit !== null) {
      const prev = this.lastDigit;
      this.rowW[prev] += 1;
      this.rowWsq[prev] += 1;
      this.rowWd[prev]![d] += 1;

      // order 2 — every pair row ages every tick, then (prev2, prev) → d
      for (const [key, pw] of this.pairW) {
        this.pairW.set(key, pw * λ);
        const pws = this.pairWsq.get(key) ?? 0;
        this.pairWsq.set(key, pws * λ * λ);
      }
      for (const prow of this.pairWd.values()) {
        for (let k = 0; k < 10; k++) prow[k] = (prow[k] - PRIOR2) * λ + PRIOR2;
      }
      if (this.prev2 !== null) {
        const key = this.prev2 * 10 + prev;
        this.pairW.set(key, (this.pairW.get(key) ?? 0) + 1);
        this.pairWsq.set(key, (this.pairWsq.get(key) ?? 0) + 1);
        let prow = this.pairWd.get(key);
        if (!prow) {
          prow = new Float64Array(10).fill(PRIOR2);
          this.pairWd.set(key, prow);
        }
        prow[d] += 1;
      }
      this.prev2 = prev;
    }
    this.lastDigit = d;
    this.n++;
  }

  prime(digits: readonly number[]): void {
    for (const d of digits) this.step(d);
  }

  get size(): number {
    return this.n;
  }

  read(): P45Reading {
    if (this.n < 30 || this.lastDigit === null) return flatReading();

    // order 0
    const T0 = this.W0 + 10 * PRIOR0;
    const p45_0 = (this.w0[4] + this.w0[5]) / T0;
    const p4_0 = this.w0[4] / T0;
    const p5_0 = this.w0[5] / T0;
    const neff0 = this.W0 * this.W0 / Math.max(this.W0sq, 1e-9);
    const var0 = Math.max((p45_0 * (1 - p45_0)) / neff0, 1e-6);

    // order 1 — row of the last digit
    const last = this.lastDigit;
    const rowW = this.rowW[last];
    const T1 = rowW + 10 * PRIOR1;
    const row = this.rowWd[last]!;
    const p45_1 = (row[4] + row[5]) / T1;
    const p4_1 = row[4] / T1;
    const p5_1 = row[5] / T1;
    const neff1 = (rowW * rowW) / Math.max(this.rowWsq[last], 1e-9);
    // Thin row → inherit the marginal's uncertainty (no false confidence).
    const var1 = rowW < 30 ? var0 : Math.max((p45_1 * (1 - p45_1)) / neff1, 1e-6);

    // order 2 — row of (prev2, prev1)
    let p45_2 = p45_1;
    let p4_2 = p4_1;
    let p5_2 = p5_1;
    let neff2 = neff1;
    let var2 = var1;
    if (this.prev2 !== null) {
      const key = this.prev2 * 10 + last;
      const pw = this.pairW.get(key) ?? 0;
      const prow = this.pairWd.get(key);
      if (pw >= 12 && prow) {
        const T2 = pw + 10 * PRIOR2;
        p45_2 = (prow[4] + prow[5]) / T2;
        p4_2 = prow[4] / T2;
        p5_2 = prow[5] / T2;
        neff2 = (pw * pw) / Math.max(this.pairWsq.get(key) ?? 1e-9, 1e-9);
        var2 = Math.max((p45_2 * (1 - p45_2)) / neff2, 1e-6);
      }
    }

    // inverse-variance fusion
    const i0 = 1 / var0;
    const i1 = 1 / var1;
    const i2 = 1 / var2;
    const sumI = i0 + i1 + i2;
    const p45 = (i0 * p45_0 + i1 * p45_1 + i2 * p45_2) / sumI;
    const p4 = (i0 * p4_0 + i1 * p4_1 + i2 * p4_2) / sumI;
    const p5 = (i0 * p5_0 + i1 * p5_1 + i2 * p5_2) / sumI;
    const fusedVar = 1 / sumI;

    return {
      p45,
      p45Se: Math.sqrt(fusedVar),
      p4,
      p5,
      order0: p45_0,
      order1: p45_1,
      order2: p45_2,
      weight0: i0 / sumI,
      weight1: i1 / sumI,
      weight2: i2 / sumI,
      nEff: neff0 + 0.5 * neff1 + 0.25 * neff2,
      insufficient: false,
    };
  }
}

// ── The entry gate ──────────────────────────────────────────────────────────

export type AvoidMode = "normal" | "recovery";

export interface GateInput {
  reading: P45Reading;
  /** Market baseline P(4/5) — the market's own long-run 4/5 rate. */
  baseline: number;
  /** Self-referential entry bar (quantile of the market's own readings). */
  bar: number;
  mode: AvoidMode;
  /** Recent digits, most-recent-last (≥ 6 for the cluster veto). */
  lastDigits: number[];
  /** Ticks since the last settled shot (Infinity = none yet). */
  ticksSinceLoss: number;
  /** Ticks this mode has been waiting for an entry. */
  waitedTicks: number;
}

export interface GateVerdict {
  ready: boolean;
  /** Hard veto that the patience valve can NEVER override. */
  veto: string | null;
  /** Human-readable status for the console. */
  reason: string;
  p45: number;
  p45Se: number;
  bar: number;
  baseline: number;
  /** True when the patience valve overrode a soft gate. */
  patienceForced: boolean;
}

function gated(
  input: GateInput,
  ready: boolean,
  veto: string | null,
  reason: string,
  patienceForced = false,
): GateVerdict {
  return {
    ready,
    veto,
    reason,
    p45: input.reading.p45,
    p45Se: input.reading.p45Se,
    bar: input.bar,
    baseline: input.baseline,
    patienceForced,
  };
}

/**
 * The 4/5 avoidance gate.
 *
 * Hard vetoes (patience never overrides) → soft gates (patience can
 * override) → ready.
 */
export function evaluateAvoidGate(input: GateInput): GateVerdict {
  const { reading, baseline, mode } = input;
  if (reading.insufficient) {
    return gated(input, false, "warming-up", "collecting digit history");
  }

  // ── Hard vetoes — "at no cost" ──────────────────────────────────────────
  if (baseline > TWIN_AVOID_HOT_BASELINE) {
    return gated(
      input,
      false,
      "market-hot",
      `market runs 4/5 hot — baseline ${(baseline * 100).toFixed(1)}% > ${TWIN_AVOID_HOT_BASELINE * 100}%`,
    );
  }
  const last = input.lastDigits.slice(-TWIN_AVOID_HOT_CLUSTER.window);
  const hotCount = last.filter(isInDeadZone).length;
  if (last.length >= TWIN_AVOID_HOT_CLUSTER.window && hotCount >= TWIN_AVOID_HOT_CLUSTER.limit) {
    return gated(
      input,
      false,
      "hot-cluster",
      `4/5 hot cluster — ${hotCount} of the last ${last.length} ticks are 4 or 5`,
    );
  }
  const lastDigit = input.lastDigits[input.lastDigits.length - 1];
  if (
    lastDigit !== undefined &&
    isInDeadZone(lastDigit) &&
    reading.order1 >= baseline
  ) {
    return gated(
      input,
      false,
      "post-4/5",
      `post-4/5 state — P(4/5|${lastDigit}) ${(reading.order1 * 100).toFixed(1)}% is not below the baseline`,
    );
  }
  if (input.ticksSinceLoss <= TWIN_AVOID_COOLDOWN) {
    return gated(input, false, "cool-down", "post-loss cool-down");
  }

  const { p45, p45Se } = reading;

  // ── Soft gate 1: worst plausible case must sit below the baseline ──────
  // (normal shots carry a relaxed ceiling — their net is digit-independent —
  //  but an above-baseline entry still poisons the recovery shot that follows)
  const worstCeil = mode === "recovery" ? baseline : baseline + 0.03;
  const worst = p45 + TWIN_AVOID_SE_MARGIN * p45Se;
  if (worst > worstCeil) {
    return gated(
      input,
      false,
      null,
      `worst plausible 4/5 rate ${(worst * 100).toFixed(1)}% is not below ${(worstCeil * 100).toFixed(1)}%`,
    );
  }

  // ── Soft gate 2: the self-referential bar ───────────────────────────────
  const patience = TWIN_AVOID_PATIENCE[mode];
  if (p45 <= input.bar) {
    return gated(
      input,
      true,
      null,
      `P(4/5|ctx) ${(p45 * 100).toFixed(1)}% ≤ bar ${(input.bar * 100).toFixed(1)}% — clean ${mode} window`,
    );
  }
  if (input.waitedTicks >= patience) {
    return gated(
      input,
      true,
      null,
      `patience valve — best available reading ${(p45 * 100).toFixed(1)}% after ${input.waitedTicks} ticks held`,
      true,
    );
  }
  return gated(
    input,
    false,
    null,
    `waiting for a cleaner window — P(4/5|ctx) ${(p45 * 100).toFixed(1)}% (±${(p45Se * 100).toFixed(1)}) vs bar ${(input.bar * 100).toFixed(1)}%`,
  );
}

// ── Market measurement (out-of-sample walk-forward) ─────────────────────────

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0.2;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return s[lo]! + (s[hi]! - s[lo]!) * frac;
}

export interface TwinAvoidRisk {
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  /** Bot recovery markup on debt (%) — from the account settings. */
  markupPercent: number;
  /** Max stake per contract from the account settings. */
  maxTradeStake: number;
}

export type TwinAvoidVerdict = "certified" | "qualified" | "watch" | "refused";

export interface TwinAvoidCard {
  symbol: string;
  displayName: string;
  /** Market's own long-run P(closed digit ∈ {4,5}), fit half only. */
  baseline: number;
  /** Self-referential entry bars (quantiles of the market's own readings). */
  barNormal: number;
  barRecovery: number;
  /** Effective evidence behind the fused estimate at the end of the test. */
  nEff: number;
  /** Share of test ticks where each gate opened cleanly (no patience). */
  opportunityNormal: number;
  opportunityRecovery: number;
  /** Baseline minus mean P(4/5) at recovery-gated entries, in percentage points. */
  avoidanceLiftPp: number;
  /**
   * 1 when the out-of-sample replay of the exact engine rules (a) never
   * breached the stop loss, (b) stayed positive in expectancy per normal
   * shot, and (c) kept the ladder inside the max-steps cap.
   */
  survival: number;
  /** Bonus: the take-profit target was reached inside the test window. */
  tpHit: boolean;
  /** Measured net $ per normal shot (per the configured stake). */
  evPerNormalShot: number;
  /** Deepest recovery ladder reached in the out-of-sample simulation. */
  deepestLadder: number;
  simNormalShots: number;
  simRecoveryShots: number;
  /** Wilson–Hilferty z for 4-block homogeneity of 4/5 counts. */
  stationarityZ: number;
  minSpacing: number;
  verdict: TwinAvoidVerdict;
  deployable: boolean;
  /** Ranking score (higher is better). */
  score: number;
  /** What the simulation says, in plain words. */
  summary: string;
}

/**
 * Wilson–Hilferty standardisation of a χ²(k) statistic → z.
 */
export function chiSquareZ(chiSq: number, df: number): number {
  const x = Math.max(1e-9, chiSq / df);
  const c = 2 / (9 * df);
  return (Math.cbrt(x) - (1 - c)) / Math.sqrt(c);
}

interface SimOutcome {
  total: number;
  tpHit: boolean;
  slHit: boolean;
  normalShots: number;
  recoveryShots: number;
  deepestLadder: number;
  opportunityNormal: number;
  opportunityRecovery: number;
  gatedMean: number;
  gatedCount: number;
}

/**
 * Replay the EXACT engine rules (debt-driven recovery stakes, the 0.35 leg
 * floor, the gate with its vetoes and patience valve, TP/SL, max steps) over
 * a digit stream. `digits` is the TEST half — the model was fit on the first
 * half only, so every shot here is out of sample.
 */
function simulateStream(
  train: readonly number[],
  digits: readonly number[],
  baseline: number,
  barNormal: number,
  barRecovery: number,
  risk: TwinAvoidRisk,
): SimOutcome {
  // Prime with the FIT half only — the model must never have seen the test
  // stream it is about to trade on.
  const tracker = new P45Tracker();
  tracker.prime(train);
  const start = 0;
  const end = digits.length;

  let debt = 0;
  let step = 0;
  let total = 0;
  let normalShots = 0;
  let recoveryShots = 0;
  let deepest = 0;
  let ladder = 0;
  // Ticks since the last settled shot (grows over time; the gate's cool-down
  // and the shot spacing both read this — exactly like the live engine).
  let sinceShot = 99;
  let waited = 0;
  let opN = 0;
  let opR = 0;
  let gatedSum = 0;
  let gatedCount = 0;
  let tpHit = false;
  let slHit = false;

  const tp = risk.takeProfit;
  const sl = risk.stopLoss;
  const P = TWIN_AVOID_PLAN;

  // Tick i: the tracker's context is [train, test[0..i−1]], so its reading
  // predicts test[i] — the digit a shot fired NOW would settle against.
  for (let i = start; i < end; i++) {
    const reading = tracker.read();
    const lastDigits = digits.slice(Math.max(0, i - 10), i);
    const inRecovery = debt > 0;
    const mode: AvoidMode = inRecovery ? "recovery" : "normal";
    const bar = inRecovery ? barRecovery : barNormal;

    // opportunity metrics — clean openings only (no patience override)
    const clean =
      !reading.insufficient &&
      baseline <= TWIN_AVOID_HOT_BASELINE &&
      (lastDigits.slice(-6).filter(isInDeadZone).length < 3 ||
        lastDigits.length < 6) &&
      reading.p45 + TWIN_AVOID_SE_MARGIN * reading.p45Se <=
        (mode === "recovery" ? baseline : baseline + 0.03) &&
      reading.p45 <= bar;
    if (clean) {
      if (mode === "recovery") {
        opR++;
        gatedSum += reading.p45;
        gatedCount++;
      } else opN++;
    }

    const d = digits[i]!; // the digit this shot settles on

    if (sinceShot >= TWIN_AVOID_MIN_SPACING) {
      const gate = evaluateAvoidGate({
        reading,
        baseline,
        bar,
        mode,
        lastDigits,
        ticksSinceLoss: sinceShot,
        waitedTicks: waited,
      });

      if (gate.ready) {
        waited = 0;
        sinceShot = 0;
        let profit: number;
        if (inRecovery) {
          // Debt-driven stake — the same formula the live engine uses.
          const raw =
            (debt * (1 + risk.markupPercent / 100)) / P.recoveryWinNetPerBase;
          const r = Math.min(
            Math.max(0.35, raw),
            risk.maxTradeStake / 2,
          );
          if (isInDeadZone(d)) {
            profit = P.recoveryLossNetPerBase * r;
            debt += -profit;
            step++;
            ladder++;
            if (ladder > deepest) deepest = ladder;
            if (step > risk.maxRecoverySteps) slHit = true;
          } else {
            profit = P.recoveryWinNetPerBase * r;
            debt = Math.max(0, debt - profit);
            if (debt <= 0.004) {
              step = 0;
              ladder = 0;
            }
          }
          recoveryShots++;
        } else {
          profit = P.normalNetPerBase * risk.stake;
          debt = -profit;
          step = 1;
          ladder = 0;
          normalShots++;
        }
        total += profit;
        if (total >= tp) tpHit = true;
        if (total <= -sl) slHit = true;
      } else {
        waited++;
      }
    }
    sinceShot++;
    tracker.step(d); // the stream advances on EVERY tick, fired or not
    if (tpHit || slHit) break;
  }

  const ticks = Math.max(1, end - start);
  return {
    total,
    tpHit,
    slHit,
    normalShots,
    recoveryShots,
    deepestLadder: deepest,
    opportunityNormal: opN / ticks,
    opportunityRecovery: opR / ticks,
    gatedMean: gatedCount > 0 ? gatedSum / gatedCount : baseline,
    gatedCount,
  };
}

/**
 * Measure one market OUT OF SAMPLE: fit on the first 60%, then (a) derive the
 * self-referential bars from the test readings and (b) replay the exact
 * engine over the test half. Returns null when there is not enough history.
 */
export function measureMarket45(
  symbol: string,
  displayName: string,
  digits: readonly number[],
  risk: TwinAvoidRisk,
): TwinAvoidCard | null {
  if (digits.length < TWIN_AVOID_MIN_HISTORY) return null;

  const split = Math.floor(digits.length * 0.6);
  const train = digits.slice(0, split);
  const test = digits.slice(split);
  const baseline =
    train.filter(isInDeadZone).length / Math.max(1, train.length);

  // Pass A — the market's own reading distribution on unseen ticks.
  // Context grows one tick at a time; the reading at i predicts test[i].
  const reader = new P45Tracker();
  reader.prime(train);
  const readings: number[] = [];
  for (let i = 0; i < test.length; i++) {
    readings.push(reader.read().p45);
    reader.step(test[i]!);
  }
  if (readings.length < 100) return null;
  const barRecovery = quantile(readings, 0.3);
  const barNormal = quantile(readings, 0.55);

  // Pass B — gates + exact engine replay on the same unseen ticks.
  const sim = simulateStream(train, test, baseline, barNormal, barRecovery, risk);

  // Stationarity — 4-block homogeneity of 4/5 counts on the test window.
  const blocks = 4;
  const blockSize = Math.floor(test.length / blocks);
  const counts: number[] = [];
  let totalZone = 0;
  for (let b = 0; b < blocks; b++) {
    const c = test
      .slice(b * blockSize, (b + 1) * blockSize)
      .filter(isInDeadZone).length;
    counts.push(c);
    totalZone += c;
  }
  const expected = totalZone / blocks;
  const chiSq =
    expected > 0
      ? counts.reduce((s, c) => s + (c - expected) * (c - expected) / expected, 0)
      : 0;
  const stationarityZ = chiSquareZ(chiSq, blocks - 1);

  const evPerNormalShot =
    sim.normalShots > 0 ? sim.total / sim.normalShots : 0;
  const avoidanceLiftPp =
    (baseline - sim.gatedMean) * 100;

  /**
   * SURVIVAL, defined for this bot's economics. The cycle edge here is small
   * (−5% normal, +43%/−200% gated recovery), so a fixed take-profit is only
   * reachable out of sample on the longest histories — using "TP hit before
   * SL" as the raw survival would refuse every fair market on a short window
   * no matter how clean the entries were. A market SURVIVES when, out of
   * sample, all three of these hold:
   *   1. the stop loss was never breached,
   *   2. the realised net expectancy per normal shot is positive,
   *   3. the recovery ladder never outran the configured max steps.
   * `tpHit` is still reported — it is a bonus, not the test.
   */
  const ladderSafe = sim.deepestLadder <= risk.maxRecoverySteps;
  const survival =
    !sim.slHit && evPerNormalShot > 0 && ladderSafe ? 1 : 0;

  // Verdict
  let verdict: TwinAvoidVerdict;
  let refusalReason = "";
  if (baseline > TWIN_AVOID_HOT_BASELINE) {
    verdict = "refused";
    refusalReason = `baseline 4/5 rate ${(baseline * 100).toFixed(1)}% is above the ${TWIN_AVOID_HOT_BASELINE * 100}% hot line`;
  } else if (stationarityZ > 2.5) {
    verdict = "refused";
    refusalReason = `4/5 frequency is drifting (stationarity z ${stationarityZ.toFixed(1)})`;
  } else if (sim.recoveryShots === 0) {
    verdict = "refused";
    refusalReason = "the recovery gate never opened — the dead zone is structurally hot here";
  } else if (sim.slHit) {
    verdict = "refused";
    refusalReason = `stop loss was breached out of sample (${sim.normalShots}/${sim.recoveryShots} shots, net $${sim.total.toFixed(2)})`;
  } else if (evPerNormalShot <= 0) {
    verdict = "refused";
    refusalReason = `out-of-sample expectancy is negative ($${evPerNormalShot.toFixed(4)} per normal shot)`;
  } else if (!ladderSafe) {
    verdict = "refused";
    refusalReason = `the out-of-sample ladder (${sim.deepestLadder}) outran the max-recovery-steps cap (${risk.maxRecoverySteps})`;
  } else if (sim.opportunityRecovery >= 0.08 && baseline <= 0.21) {
    verdict = "certified";
  } else if (sim.opportunityRecovery >= 0.04) {
    verdict = "qualified";
  } else {
    verdict = "watch";
  }
  const deployable = verdict === "certified" || verdict === "qualified";

  const score =
    0.45 * survival +
    0.25 * Math.min(1, Math.max(0, evPerNormalShot) / 0.1) +
    0.15 * Math.min(1, sim.opportunityRecovery / 0.12) +
    0.05 * Math.min(1, Math.max(0, avoidanceLiftPp) / 3) -
    0.25 * Math.min(1, sim.deepestLadder / Math.max(1, risk.maxRecoverySteps)) -
    0.3 * Math.max(0, baseline - 0.2) / 0.02 -
    0.1 * Math.max(0, stationarityZ - 2) / 3;

  const summary = refusalReason
    ? refusalReason
    : `${sim.normalShots} normal + ${sim.recoveryShots} recovery shots out of sample · net $${sim.total.toFixed(2)} (+$${evPerNormalShot.toFixed(3)}/shot) · deepest ladder ${sim.deepestLadder} of ${risk.maxRecoverySteps} · ${sim.tpHit ? "take profit reached in-window" : "stop loss never touched"}`;

  return {
    symbol,
    displayName,
    baseline,
    barNormal,
    barRecovery,
    nEff: Math.round(reader.read().nEff),
    opportunityNormal: sim.opportunityNormal,
    opportunityRecovery: sim.opportunityRecovery,
    avoidanceLiftPp,
    survival,
    tpHit: sim.tpHit,
    evPerNormalShot,
    deepestLadder: sim.deepestLadder,
    simNormalShots: sim.normalShots,
    simRecoveryShots: sim.recoveryShots,
    stationarityZ,
    minSpacing: TWIN_AVOID_MIN_SPACING,
    verdict,
    deployable,
    score,
    summary,
  };
}

// ── Market mode — decided by the analysis, not the user ─────────────────────

export interface ModeDecision {
  mode: "locked" | "switching";
  cluster: TwinAvoidCard[];
  reason: string;
}

/**
 * A clear winner gets locked; a tight cluster of near-equal markets
 * switches. The margin thresholds are on the ranking score.
 */
export function decideMarketMode(ranked: readonly TwinAvoidCard[]): ModeDecision {
  const deployable = ranked.filter((c) => c.deployable);
  if (deployable.length === 0) {
    return {
      mode: "locked",
      cluster: [],
      reason: "no deployable market",
    };
  }
  const best = deployable[0]!;
  const second = deployable[1];
  if (!second || best.score - second.score >= 0.12) {
    return {
      mode: "locked",
      cluster: [best],
      reason: second
        ? `clear winner — ${best.displayName} leads ${second.displayName} by ${(best.score - second.score).toFixed(2)} score (≥ 0.12), so it is locked`
        : `only one deployable market — ${best.displayName} is locked`,
    };
  }
  const cluster = deployable.filter((c) => best.score - c.score <= 0.1);
  return {
    mode: "switching",
    cluster,
    reason: `top ${cluster.length} markets sit within 0.10 score of the leader — the engine starts on ${best.displayName} and rotates when it cools`,
  };
}
