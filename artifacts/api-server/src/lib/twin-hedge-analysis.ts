/**
 * TWIN-HEDGE EDGE — analysis core of the 11th specialist bot (v2 volume engine).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 * The user names ONE digit pair — Over A and Under B (e.g. Over 4 / Under 5).
 * The bot places BOTH contracts on the SAME market at the SAME tick. It never
 * runs one leg on market X and the other on market Y; switching (when enabled)
 * happens only between whole pair-shots.
 *
 * Because the two contracts share the same digit stream, their joint outcome
 * falls into exactly four regions:
 *
 *   overOnly   — digit wins the OVER leg and loses the UNDER leg
 *   underOnly  — digit wins the UNDER leg and loses the OVER leg
 *   both       — the digit makes BOTH legs win (overlapping pairs)
 *   none       — the digit makes BOTH legs lose (dead zone of a non-covering pair)
 *
 * A "balanced" pair (Over 4 / Under 5) is the special case where both=∅ and
 * none=∅ — exactly one leg always wins. Every other user-selected pair still
 * trades both legs, and its EV is measured against the FULL four-region
 * outcome, so overlap and dead zones are priced into every reading instead of
 * being used as an excuse to refuse the pair.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EDGE (v2 — always-on, mode-aware)
 * ─────────────────────────────────────────────────────────────────────────────
 * Fair 50/50 legs payout below 2.0 (Over 4 / Under 5 = 1.95), so betting both
 * at EQUAL stakes loses money on every tick. The edge is therefore a STAKE
 * SKEW: the model reads the digit stream and decides which side is more likely,
 * then puts a (small, capped) extra increment on that side. If the favoured
 * side lands, the winning leg's payout more than covers the hedge leg's loss —
 * a positive net. If the hedge side lands, the net loss is recorded and the
 * shared recovery ledger sizes the next pair-shot to recover it.
 *
 * v1 stacked three rare probabilistic gates (self-referential top-quantile bar
 * × positive-analytic-EV × oracle timing), so the product almost never fired —
 * the bot watched forever and traded never, even in Balanced mode. v2 inverts
 * that philosophy:
 *
 *   · the edge estimator is ALWAYS DEFINED (shrunk multi-window imbalance +
 *     EMA momentum + window agreement + follow/chop regime). It never refuses;
 *     weak readings simply produce a weak skew and a small stake scale.
 *   · the mode (Balanced / Strict / Elite) sets the firing bar, the cadence,
 *     the timing agreement and the skew cap — Balanced trades near-continuously
 *     after warmup, Elite waits for a genuine measured tilt.
 *   · timing is cadence + feed freshness + post-shot spacing + post-loss
 *     cool-down, with an optional last-print agreement rule per mode — never a
 *     stack of probabilistic vetoes.
 *   · profitability comes from harvesting short-horizon imbalance with an
 *     adaptive skew, conviction-scaled staking, the shared recovery ladder for
 *     drawdowns, and hard session TP/SL. The walk-forward backtest paper-trades
 *     this exact rule out of sample so the scan numbers are honest.
 */

import {
  benjaminiHochberg,
  regularizedIncompleteBeta,
  payoutForBarrier,
} from "./specialist-analysis";
import {
  wilsonLower,
  evidenceValue,
  effectiveSampleSize,
  ladderDepthLimit,
  ladderAbsorption,
  expectedShotsToLadderBreak,
  lossChain,
  fitRegimeHmm,
} from "./killshot-analysis";

// ── Pair vocabulary ───────────────────────────────────────────────────────────

export type TwinSide = "over" | "under";
export type TwinState = "overOnly" | "underOnly" | "both" | "none";
export const TWIN_STATES: TwinState[] = [
  "overOnly",
  "underOnly",
  "both",
  "none",
];

export interface TwinContract {
  overDigit: number;
  underDigit: number;
}

/** The curated same-payout / complementary pairs offered in the console. */
export const TWIN_PRESET_PAIRS: Array<{
  over: number;
  under: number;
  label: string;
}> = [
  { over: 4, under: 5, label: "Over 4 / Under 5" },
  { over: 7, under: 2, label: "Over 7 / Under 2" },
  { over: 6, under: 3, label: "Over 6 / Under 3" },
  { over: 8, under: 1, label: "Over 8 / Under 1" },
  { over: 2, under: 8, label: "Over 2 / Under 8" },
  { over: 1, under: 9, label: "Over 1 / Under 9" },
];

export function twinLabel(c: TwinContract): string {
  return `Over ${c.overDigit} · Under ${c.underDigit}`;
}

export function twinOverWinSet(overDigit: number): Set<number> {
  const s = new Set<number>();
  for (let d = 0; d <= 9; d++) if (d > overDigit) s.add(d);
  return s;
}

export function twinUnderWinSet(underDigit: number): Set<number> {
  const s = new Set<number>();
  for (let d = 0; d <= 9; d++) if (d < underDigit) s.add(d);
  return s;
}

/** Classify a realised digit into the four-region joint outcome. */
export function classifyDigit(
  overDigit: number,
  underDigit: number,
  d: number,
): TwinState {
  const o = d > overDigit;
  const u = d < underDigit;
  if (o && u) return "both";
  if (o) return "overOnly";
  if (u) return "underOnly";
  return "none";
}

export interface TwinOutcome {
  overWinSet: Set<number>;
  underWinSet: Set<number>;
  overOnly: number[];
  underOnly: number[];
  both: number[];
  none: number[];
  overCount: number;
  underCount: number;
  bothCount: number;
  noneCount: number;
  /** true when exactly one leg wins on every digit (Over 4 / Under 5). */
  complementary: boolean;
  /** true when the pair covers every digit (no both-lose zone). */
  covering: boolean;
  /** digit counts for the two legs (used for the "same-payout" heuristic). */
  overDigits: number;
  underDigits: number;
}

export function twinOutcome(c: TwinContract): TwinOutcome {
  const overWinSet = twinOverWinSet(c.overDigit);
  const underWinSet = twinUnderWinSet(c.underDigit);
  const overOnly: number[] = [];
  const underOnly: number[] = [];
  const both: number[] = [];
  const none: number[] = [];
  for (let d = 0; d <= 9; d++) {
    const state = classifyDigit(c.overDigit, c.underDigit, d);
    if (state === "overOnly") overOnly.push(d);
    else if (state === "underOnly") underOnly.push(d);
    else if (state === "both") both.push(d);
    else none.push(d);
  }
  return {
    overWinSet,
    underWinSet,
    overOnly,
    underOnly,
    both,
    none,
    overCount: overOnly.length + both.length,
    underCount: underOnly.length + both.length,
    bothCount: both.length,
    noneCount: none.length,
    complementary:
      overOnly.length + underOnly.length === 10 &&
      both.length === 0 &&
      none.length === 0,
    covering: none.length === 0,
    overDigits: overOnly.length + both.length,
    underDigits: underOnly.length + both.length,
  };
}

export function twinPayouts(c: TwinContract): { over: number; under: number } {
  return {
    over: payoutForBarrier("DIGITOVER", c.overDigit),
    under: payoutForBarrier("DIGITUNDER", c.underDigit),
  };
}

/** A single leg of the pair trade. */
export interface TwinLeg {
  side: TwinSide;
  digit: number;
  contractType: "DIGITOVER" | "DIGITUNDER";
  payout: number;
  stake: number;
}

/** The complete pair shot: both legs, same market, same tick. */
export interface TwinPlan {
  primary: TwinSide;
  /** stake increment on the primary side (TWIN_MIN_BIAS … mode cap). */
  bias: number;
  /** The base stake BOTH leg scales are derived from. */
  baseStake: number;
  overStake: number;
  underStake: number;
  overLeg: TwinLeg;
  underLeg: TwinLeg;
  /** $ expected net per $1 of base stake at the model's reading. */
  edgePerBase: number;
  /** $ net when the favoured region wins, per $1 of base stake. */
  netOnWinPerBase: number;
  /** $ net when the hedge region wins, per $1 of base stake (≤ 0). */
  netOnLossPerBase: number;
}

/** Net P&L in the four regions, per $1 of base stake, for a plan. */
export function twinRegionNet(
  c: TwinContract,
  plan: TwinPlan,
  region: TwinState,
): number {
  const { over, under } = twinPayouts(c);
  if (region === "overOnly")
    return plan.overStake * (over - 1) - plan.underStake;
  if (region === "underOnly")
    return plan.underStake * (under - 1) - plan.overStake;
  if (region === "both")
    return plan.overStake * (over - 1) + plan.underStake * (under - 1);
  return -(plan.overStake + plan.underStake);
}

export function buildTwinPlan(
  c: TwinContract,
  primary: TwinSide,
  bias: number,
  baseStake: number,
): TwinPlan {
  const payouts = twinPayouts(c);
  const overStake =
    primary === "over" ? baseStake * (1 + bias) : baseStake * (1 - bias);
  const underStake =
    primary === "under" ? baseStake * (1 + bias) : baseStake * (1 - bias);
  const overLeg: TwinLeg = {
    side: "over",
    digit: c.overDigit,
    contractType: "DIGITOVER",
    payout: payouts.over,
    stake: overStake,
  };
  const underLeg: TwinLeg = {
    side: "under",
    digit: c.underDigit,
    contractType: "DIGITUNDER",
    payout: payouts.under,
    stake: underStake,
  };
  return {
    primary,
    bias,
    baseStake,
    overStake,
    underStake,
    overLeg,
    underLeg,
    edgePerBase: 0,
    netOnWinPerBase: 0,
    netOnLossPerBase: 0,
  };
}

export interface TwinStateProb {
  overOnly: number;
  underOnly: number;
  both: number;
  none: number;
}

/** Expected $ net per $1 base stake for a plan under a state distribution. */
export function twinExpectedNet(
  c: TwinContract,
  plan: TwinPlan,
  p: TwinStateProb,
): number {
  return (
    (p.overOnly * twinRegionNet(c, plan, "overOnly") +
      p.underOnly * twinRegionNet(c, plan, "underOnly") +
      p.both * twinRegionNet(c, plan, "both") +
      p.none * twinRegionNet(c, plan, "none")) /
    Math.max(1e-9, plan.baseStake)
  );
}

// ── Numeric helpers ───────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// ── Certainty levels for the Twin-Hedge bot ──────────────────────────────────

export type TwinCertainty = "elite" | "strict" | "balanced";

export interface TwinCertaintySpec {
  id: TwinCertainty;
  label: string;
  blurb: string;
  /** Ticks of history before the live gate may fire. */
  minHistory: number;
  /** Minimum ticks between pair-shots (cadence). */
  minSpacing: number;
  /** Post-loss cool-down in ticks. */
  postLossCoolTicks: number;
  /** How much each consecutive loss tightens the bar (gentle shield). */
  postLossTightening: number;
  /**
   * Minimum analytic $ edge per $1 base to fire (Balanced = −1: always fires
   * once warm — the skew and stake scale carry the edge instead of a veto).
   */
  edgeFloor: number;
  /** Minimum |tilt| in standard errors to fire (0 = no z veto). */
  zBar: number;
  /** Maximum stake skew the mode may use. */
  maxBias: number;
  /** Last-print agreement ticks required by the timing rule (0 = none). */
  agreeTicks: number;
  /** Minimum out-of-sample paper shots before certifying a market. */
  minShots: number;
  /** Minimum paper $ net per $1 base for CERTIFIED / QUALIFIED. */
  minEvCertified: number;
  minEvQualified: number;
  /** Minimum paper $ net per $1 base before a market is REFUSED. */
  minEvRefuse: number;
  /** Minimum live conviction for CERTIFIED. */
  minConvictionCertified: number;
  /** Composite confidence floor for a CERTIFIED verdict. */
  minConfidence: number;
}

/**
 * Volume-first bars. Balanced is the "trade nonstop" mode: once the feed is
 * warm it fires on cadence with an adaptive skew and conviction-scaled stake,
 * and lets the hedge + recovery ladder do their job. Strict asks for a
 * measurable tilt; Elite waits for a strong one. Nothing here can veto a flat
 * market forever in Balanced — that was the v1 failure mode.
 */
export const TWIN_CERTAINTY: Record<TwinCertainty, TwinCertaintySpec> = {
  elite: {
    id: "elite",
    label: "Elite",
    minHistory: 240,
    minSpacing: 8,
    postLossCoolTicks: 14,
    postLossTightening: 0.25,
    edgeFloor: 0.004,
    zBar: 1.0,
    maxBias: 0.35,
    agreeTicks: 2,
    minShots: 10,
    minEvCertified: 0.01,
    minEvQualified: 0.002,
    minEvRefuse: -0.012,
    minConvictionCertified: 0.55,
    minConfidence: 58,
    blurb:
      "Waits for a strong measured tilt. Fewest shots, biggest skew, strictest proof.",
  },
  strict: {
    id: "strict",
    label: "Strict",
    minHistory: 180,
    minSpacing: 5,
    postLossCoolTicks: 10,
    postLossTightening: 0.2,
    edgeFloor: 0.0,
    zBar: 0.5,
    maxBias: 0.3,
    agreeTicks: 1,
    minShots: 8,
    minEvCertified: 0.006,
    minEvQualified: -0.004,
    minEvRefuse: -0.02,
    minConvictionCertified: 0.45,
    minConfidence: 48,
    blurb:
      "Trades on a measurable tilt with last-print agreement. Balanced proof, steady cadence.",
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    minHistory: 120,
    minSpacing: 3,
    postLossCoolTicks: 6,
    postLossTightening: 0.15,
    edgeFloor: -1,
    zBar: 0,
    maxBias: 0.22,
    agreeTicks: 0,
    minShots: 6,
    minEvCertified: 0.004,
    minEvQualified: -0.012,
    minEvRefuse: -0.35,
    minConvictionCertified: 0.35,
    minConfidence: 35,
    blurb:
      "Trades near-continuously once warm. Adaptive skew + conviction staking harvest short-horizon imbalance.",
  },
};

export function twinCertaintySpec(id?: string): TwinCertaintySpec {
  return (
    TWIN_CERTAINTY[(id as TwinCertainty) ?? "balanced"] ??
    TWIN_CERTAINTY.balanced
  );
}

// ── The v2 edge estimator (always-on, shrunk, look-ahead-free) ───────────────

export const TWIN_MAX_BIAS = 0.35;
export const TWIN_MIN_BIAS = 0.02;
/** Default target per-$1 base return the walk-forward skew aims to reach. */
export const TWIN_DEFAULT_TARGET_EV = 0.01;

/** Trailing windows (ticks) and pseudo-counts for the shrunk over-rate. */
const TILT_WINDOWS = [25, 100, 400] as const;
const TILT_ALPHAS = [8, 16, 32] as const;
const TILT_WEIGHTS = [0.5, 0.3, 0.2] as const;
const REGION_WINDOW = 200;
const REGION_ALPHA = 24;
const EMA_FAST = 0.08;
const EMA_SLOW = 0.02;
const FOLLOW_WINDOW = 60;

export interface TwinEdgeReading {
  /** P(OVER leg wins) under the shrunk trailing digit distribution. */
  pOver: number;
  /** P(UNDER leg wins) under the shrunk trailing digit distribution. */
  pUnder: number;
  state: TwinStateProb;
  /** Fair (uniform-digit) share of the OVER leg — the no-edge baseline. */
  fairOver: number;
  /** Signed imbalance vs fair after momentum blending, clamped ±0.15. */
  tilt: number;
  /** |tilt| in standard errors (n_eff ≈ 60). */
  z: number;
  /** 0.05 … 1 — drives skew size and stake scale. Never zero. */
  conviction: number;
  primary: TwinSide;
  /** Mode-capped skew actually recommended for this reading. */
  bias: number;
  /** $ expected net per $1 base at the recommended skew. */
  edgePerBase: number;
  /** $ net when the favoured region wins, per $1 of base stake. */
  netOnWinPerBase: number;
  /** $ net when the hedge region wins, per $1 of base stake (≤ 0). */
  netOnLossPerBase: number;
}

function shrunkRate(hits: number, n: number, prior: number, alpha: number): number {
  if (n <= 0) return prior;
  return (hits + alpha * prior) / (n + alpha);
}

function stateFromDigits(digits: number[], c: TwinContract): TwinStateProb {
  const p: TwinStateProb = { overOnly: 0, underOnly: 0, both: 0, none: 0 };
  for (let d = 0; d <= 9; d++) {
    const s = classifyDigit(c.overDigit, c.underDigit, d);
    p[s] += digits[d] ?? 0;
  }
  return p;
}

/**
 * One always-defined reading of the pair edge from trailing digits only.
 * Heavy shrinkage toward the fair (uniform) baseline keeps tiny samples
 * honest; strong recent imbalance still moves the needle through the fast
 * window and the EMA momentum term.
 */
export function estimateTwinEdge(
  digits: number[],
  contract: TwinContract,
  opts: { maxBias?: number; targetEv?: number } = {},
): TwinEdgeReading {
  const out = twinOutcome(contract);
  const fairOver = out.overCount / 10;
  const maxBias = clamp(opts.maxBias ?? TWIN_MAX_BIAS, TWIN_MIN_BIAS, TWIN_MAX_BIAS);
  const n = digits.length;
  const overSet = out.overWinSet;

  // 1) Multi-window shrunk over-rate → tilt vs fair.
  let pCtx = 0;
  const devs: number[] = [];
  for (let w = 0; w < TILT_WINDOWS.length; w++) {
    const len = Math.min(n, TILT_WINDOWS[w]);
    let hits = 0;
    for (let i = n - len; i < n; i++) if (overSet.has(digits[i]!)) hits++;
    const p = shrunkRate(hits, len, fairOver, TILT_ALPHAS[w]);
    pCtx += TILT_WEIGHTS[w] * p;
    if (len >= 10) devs.push(p - fairOver);
  }
  const totalSign = Math.sign(pCtx - fairOver);
  const agreement =
    devs.length > 0
      ? devs.filter((d) => d === 0 || Math.sign(d) === totalSign).length /
        devs.length
      : 0.5;

  // 2) EMA momentum on the over-indicator (fast − slow).
  let fast = fairOver;
  let slow = fairOver;
  const emaLen = Math.min(n, 300);
  for (let i = n - emaLen; i < n; i++) {
    const x = overSet.has(digits[i]!) ? 1 : 0;
    fast += EMA_FAST * (x - fast);
    slow += EMA_SLOW * (x - slow);
  }
  const momentum = emaLen >= 10 ? fast - slow : 0;

  const tilt = clamp(pCtx - fairOver + 0.5 * momentum, -0.15, 0.15);

  // 3) Follow/chop regime: does trailing-majority-following win lately?
  let followHits = 0;
  let followN = 0;
  const fw = Math.min(n - 1, FOLLOW_WINDOW);
  for (let i = n - fw; i < n; i++) {
    if (i < 10) continue;
    let h = 0;
    const look = Math.min(15, i);
    for (let j = i - look; j < i; j++) if (overSet.has(digits[j]!)) h++;
    const majorityOver = h / look >= 0.5;
    const realisedOver = overSet.has(digits[i]!);
    if (majorityOver === realisedOver) followHits++;
    followN++;
  }
  const followRate = followN > 0 ? followHits / followN : 0.5;
  const followScore = clamp((followRate - 0.45) / 0.15, 0, 1);

  // 4) Conviction: tilt magnitude + window agreement, MULTIPLIED by proven
  // follow-through. A big tilt the stream keeps reversing (choppy /
  // mean-reverting regime) must not command a big skew — the multiplier
  // collapses conviction toward the floor instead of merely nudging it.
  const base = Math.min(1, Math.abs(tilt) / 0.045);
  const conviction = clamp(
    (0.65 * base + 0.35 * agreement) * (0.35 + 0.65 * followScore),
    0.05,
    1,
  );

  // 5) Coherent region distribution from the shrunk trailing digits.
  const rLen = Math.min(n, REGION_WINDOW);
  const counts = new Array<number>(10).fill(0);
  for (let i = n - rLen; i < n; i++) counts[digits[i]!]++;
  const dist = counts.map((x) => (x + REGION_ALPHA / 10) / (rLen + REGION_ALPHA));
  const state = stateFromDigits(dist, contract);
  const pOver = state.overOnly + state.both;
  const pUnder = state.underOnly + state.both;

  // 6) Primary + skew. Primary follows the tilt sign; the skew grows with
  // conviction. When the tilt is strong enough that a SMALLER skew already
  // clears the target EV, prefer the smaller skew (cheaper hedge).
  const primary: TwinSide = tilt >= 0 ? "over" : "under";
  const targetEv = opts.targetEv ?? TWIN_DEFAULT_TARGET_EV;
  let bias = clamp(TWIN_MIN_BIAS + conviction * (maxBias - TWIN_MIN_BIAS), TWIN_MIN_BIAS, maxBias);
  for (let b = TWIN_MIN_BIAS; b <= bias + 1e-9; b += 0.01) {
    const trial = buildTwinPlan(contract, primary, b, 1);
    if (twinExpectedNet(contract, trial, state) >= targetEv) {
      bias = b;
      break;
    }
  }
  bias = round(bias, 3);
  const plan = buildTwinPlan(contract, primary, bias, 1);
  const edgePerBase = twinExpectedNet(contract, plan, state);
  const winRegion: TwinState = primary === "over" ? "overOnly" : "underOnly";
  const lossRegion: TwinState = primary === "over" ? "underOnly" : "overOnly";

  const se = Math.sqrt(Math.max(1e-6, fairOver * (1 - fairOver) / 60));
  return {
    pOver: round(pOver, 6),
    pUnder: round(pUnder, 6),
    state,
    fairOver: round(fairOver, 6),
    tilt: round(tilt, 6),
    z: round(tilt / se, 4),
    conviction: round(conviction, 4),
    primary,
    bias,
    edgePerBase: round(edgePerBase, 6),
    netOnWinPerBase: round(twinRegionNet(contract, plan, winRegion), 6),
    netOnLossPerBase: round(twinRegionNet(contract, plan, lossRegion), 6),
  };
}

// ── Model card + live entry ───────────────────────────────────────────────────

export interface TwinHmmParams {
  pHot: number;
  pCold: number;
  stay: number;
  prior: number;
}

export interface TwinModelCard {
  /** z-bar the live |tilt| must clear (mode floor, tightened after losses). */
  tau: number;
  /** Target fire cadence as a fraction of ticks (≈ 1 / minSpacing). */
  targetShotRate: number;
  hmm: TwinHmmParams;
  overDigit: number;
  underDigit: number;
  overPayout: number;
  underPayout: number;
  minSpacing: number;
  postLossTightening: number;
  postLossCoolTicks: number;
  targetEvPerDollar: number;
  fittedOn: number;
  /** v2 fields — the mode this card was measured for. */
  certainty: TwinCertainty;
  edgeFloor: number;
  maxBias: number;
  agreeTicks: number;
  minHistory: number;
}

export interface TwinLiveEntry {
  ready: boolean;
  pOver: number;
  pUnder: number;
  state: TwinStateProb;
  primary: TwinSide;
  bias: number;
  edgePerBase: number;
  expected: number;
  conviction: number;
  tilt: number;
  statWarmth: number;
  tau: number;
  bar: number;
  zGate: number;
  reason: string;
}

/**
 * Live gate. Balanced fires on cadence once the feed is warm and the
 * post-loss cool-down has passed — the skew and stake scale (not a veto)
 * carry the edge. Strict/Elite add the measured-tilt bar on top.
 */
export function evaluateTwinLiveEntry(
  digits: number[],
  contract: TwinContract,
  card: TwinModelCard,
  opts: { barBoost?: number; ticksSinceLoss?: number; burnIn?: number } = {},
): TwinLiveEntry {
  const clean = digits.filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
  const certainty: TwinCertainty =
    card.certainty === "elite" || card.certainty === "strict" ? card.certainty : "balanced";
  const spec = twinCertaintySpec(certainty);
  const minHistory = Number.isFinite(card.minHistory) && card.minHistory > 0 ? card.minHistory : spec.minHistory;
  const edgeFloor = Number.isFinite(card.edgeFloor) ? card.edgeFloor : spec.edgeFloor;
  const maxBias = clamp(
    Number.isFinite(card.maxBias) ? card.maxBias : spec.maxBias,
    TWIN_MIN_BIAS,
    TWIN_MAX_BIAS,
  );
  const reading = estimateTwinEdge(clean, contract, {
    maxBias,
    targetEv: Number.isFinite(card.targetEvPerDollar) ? card.targetEvPerDollar : TWIN_DEFAULT_TARGET_EV,
  });

  const boost = Math.max(0, opts.barBoost ?? 0);
  const bar = card.tau + boost;
  const floorNow = edgeFloor + boost * 0.002;
  const cooled =
    (opts.ticksSinceLoss ?? Number.POSITIVE_INFINITY) >= card.postLossCoolTicks;
  const enough = clean.length >= minHistory;
  const zMag = Math.abs(reading.z);
  const clears = zMag >= bar;
  const richEnough = reading.edgePerBase >= floorNow;
  const ready = enough && cooled && clears && richEnough;

  const reason = !enough
    ? `building history — ${clean.length}/${minHistory} digits`
    : !cooled
      ? `post-loss cool-down — ${opts.ticksSinceLoss ?? 0}/${card.postLossCoolTicks} ticks`
      : !clears
        ? `tilt ${zMag.toFixed(2)}σ under the ${bar.toFixed(2)}σ bar · P(over|ctx) ${(reading.pOver * 100).toFixed(1)}% · P(under|ctx) ${(reading.pUnder * 100).toFixed(1)}%`
        : !richEnough
          ? `pair edge is not positive at this reading (${(reading.edgePerBase * 100).toFixed(2)}% per $1 base vs ${(floorNow * 100).toFixed(2)}% floor)`
          : "";

  return {
    ready,
    pOver: reading.pOver,
    pUnder: reading.pUnder,
    state: reading.state,
    primary: reading.primary,
    bias: reading.bias,
    edgePerBase: reading.edgePerBase,
    expected: reading.edgePerBase,
    conviction: reading.conviction,
    tilt: reading.tilt,
    statWarmth: clean.length,
    tau: card.tau,
    bar: round(bar, 4),
    zGate: round(zMag, 4),
    reason,
  };
}

// ── Timing (cadence + freshness + agreement — never a veto stack) ────────────

export interface TwinTimingInput {
  digits: number[];
  contract: TwinContract;
  primary: TwinSide;
  /** Seconds since the active market's last tick. */
  secondsSinceLastTick: number;
  /** Typical tick gap of the active market (1s for 1HZ, else 2s). */
  medianTickGapSeconds: number;
  ticksSinceLastShot: number;
  minSpacing: number;
  /** Last-print agreement ticks required (mode-driven, 0 = none). */
  agreeTicks: number;
}

export interface TwinTiming {
  ready: boolean;
  reason: string;
}

/**
 * The v2 timing rule: re-space shots, refuse a stale feed, and (Strict/Elite)
 * ask the last print(s) to agree with the favoured side before firing. Three
 * cheap checks, each legible in the console — no probabilistic veto stack.
 */
export function evaluateTwinTiming(input: TwinTimingInput): TwinTiming {
  const gap = Math.max(0.5, input.medianTickGapSeconds || 2);
  const age = Math.max(0, input.secondsSinceLastTick || 0);
  if (age > gap * 8) {
    return { ready: false, reason: `feed lagging — last tick ${age.toFixed(0)}s ago` };
  }
  const since = input.ticksSinceLastShot;
  if (Number.isFinite(since) && since < input.minSpacing) {
    return { ready: false, reason: `re-spacing shots — ${Math.max(0, Math.ceil(input.minSpacing - since))} tick(s) to go` };
  }
  const need = Math.max(0, Math.min(3, Math.floor(input.agreeTicks || 0)));
  if (need > 0) {
    const winSet =
      input.primary === "over"
        ? twinOverWinSet(input.contract.overDigit)
        : twinUnderWinSet(input.contract.underDigit);
    const tail = input.digits.slice(-3);
    let agree = 0;
    for (const d of tail) if (winSet.has(d)) agree++;
    const required = need >= 2 ? 2 : 1;
    const window = need >= 2 ? tail : tail.slice(-1);
    let windowAgree = 0;
    for (const d of window) if (winSet.has(d)) windowAgree++;
    if (windowAgree < required) {
      return {
        ready: false,
        reason:
          need >= 2
            ? `waiting for the favoured prints — ${windowAgree}/3 agree with ${input.primary.toUpperCase()}`
            : `last print disagrees with ${input.primary.toUpperCase()} — holding one tick`,
      };
    }
  }
  return { ready: true, reason: "" };
}

// ── Walk-forward (train → threshold → out-of-sample) ─────────────────────────

export interface TwinShot {
  index: number;
  won: boolean;
  edgePerBase: number;
  zGate: number;
  netPerBase: number;
  primary: TwinSide;
  bias: number;
  pOver: number;
  pUnder: number;
  state: TwinState;
  suppressedByShield: boolean;
}

export interface TwinShotLedger {
  shots: TwinShot[];
  nShots: number;
  examined: number;
  fireRate: number;
  /** fraction of shots with net > 0 */
  winRate: number;
  winRateLower: number;
  evPerDollar: number;
  evLowerPerDollar: number;
  avgWinPerBase: number;
  avgLossPerBase: number;
  longestLossRun: number;
  chain: ReturnType<typeof lossChain>;
  evidence: ReturnType<typeof evidenceValue>;
  meanPredictedOver: number;
  meanPredictedUnder: number;
}

export interface TwinPairShield {
  suppressed: number;
  shieldedWinRate: number;
  shieldedShots: number;
  pairsBefore: number;
  pairsAfter: number;
  longestRunAfter: number;
}

export interface TwinWalkForward {
  trainTicks: number;
  testTicks: number;
  tau: number;
  trainShotRate: number;
  hmm: TwinHmmParams;
  train: TwinShotLedger;
  test: TwinShotLedger;
  shield: TwinPairShield;
}

export interface TwinWalkParams {
  spec: TwinCertaintySpec;
  baseStake: number;
  targetEvPerDollar?: number;
  burnIn?: number;
  trainFraction?: number;
}

function summariseTwin(
  shots: TwinShot[],
  examined: number,
  breakEvenWinRate: number,
): TwinShotLedger {
  const outcomes = shots.map((s) => (s.won ? 1 : 0));
  const nShots = shots.length;
  const hits = outcomes.reduce((a, b) => a + b, 0);
  const winRate = nShots > 0 ? hits / nShots : 0;
  const lower = wilsonLower(hits, nShots);
  const ev = mean(shots.map((s) => s.netPerBase));
  const wins = shots.filter((s) => s.won);
  const losses = shots.filter((s) => !s.won);
  const avgWin = wins.length > 0 ? mean(wins.map((s) => s.netPerBase)) : 0;
  const avgLoss = losses.length > 0 ? mean(losses.map((s) => s.netPerBase)) : 0;
  // Conservative EV: use the Wilson lower bound on the win rate.
  const evLower =
    lower * Math.max(0, avgWin) + (1 - lower) * Math.min(0, avgLoss);

  let depth = 0;
  let maxDepth = 0;
  for (const s of shots) {
    if (s.won) depth = 0;
    else {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
    }
  }

  return {
    shots,
    nShots,
    examined,
    fireRate: examined > 0 ? round(nShots / examined, 5) : 0,
    winRate: round(winRate, 5),
    winRateLower: round(lower, 5),
    evPerDollar: round(ev, 5),
    evLowerPerDollar: round(evLower, 5),
    avgWinPerBase: round(avgWin, 5),
    avgLossPerBase: round(avgLoss, 5),
    longestLossRun: maxDepth,
    chain: lossChain(outcomes),
    evidence: evidenceValue(outcomes, breakEvenWinRate),
    meanPredictedOver: round(
      nShots > 0 ? mean(shots.map((s) => s.pOver)) : 0,
      5,
    ),
    meanPredictedUnder: round(
      nShots > 0 ? mean(shots.map((s) => s.pUnder)) : 0,
      5,
    ),
  };
}

function simulateTwinShield(
  shots: TwinShot[],
  spec: TwinCertaintySpec,
  maxBarBoost = 1.5,
): TwinPairShield {
  let pairsBefore = 0;
  for (let i = 1; i < shots.length; i++)
    if (!shots[i].won && !shots[i - 1].won) pairsBefore++;

  const kept: TwinShot[] = [];
  let lastLossIndex = -Infinity;
  let lossRun = 0;
  for (const s of shots) {
    const boost = Math.min(maxBarBoost, spec.postLossTightening * lossRun);
    const cooled = s.index - lastLossIndex >= spec.postLossCoolTicks;
    const clears = s.zGate >= spec.zBar + boost;
    const richEnough = s.edgePerBase >= spec.edgeFloor + boost * 0.002;
    if (cooled && clears && richEnough) {
      kept.push({ ...s, suppressedByShield: false });
      if (!s.won) {
        lastLossIndex = s.index;
        lossRun++;
      } else {
        lastLossIndex = -Infinity;
        lossRun = 0;
      }
    }
  }

  let pairsAfter = 0,
    run = 0,
    longest = 0;
  for (let i = 0; i < kept.length; i++) {
    if (!kept[i].won) {
      run++;
      longest = Math.max(longest, run);
      if (i > 0 && !kept[i - 1].won) pairsAfter++;
    } else run = 0;
  }
  const hits = kept.filter((s) => s.won).length;
  return {
    suppressed: shots.length - kept.length,
    shieldedWinRate: round(kept.length > 0 ? hits / kept.length : 0, 5),
    shieldedShots: kept.length,
    pairsBefore,
    pairsAfter,
    longestRunAfter: longest,
  };
}

/** Break-even joint win rate: the probability the favourite must win to break even. */
export function twinBreakEvenWinRate(
  c: TwinContract,
  primary: TwinSide,
  bias: number,
): number {
  const plan = buildTwinPlan(c, primary, bias, 1);
  const netW = twinRegionNet(
    c,
    plan,
    primary === "over" ? "overOnly" : "underOnly",
  );
  const netL = twinRegionNet(
    c,
    plan,
    primary === "over" ? "underOnly" : "overOnly",
  );
  if (netW <= 0) return 1;
  return Math.min(1, Math.max(0, -netL / (netW + -netL)));
}

export function twinWalkForward(
  digits: number[],
  contract: TwinContract,
  params: TwinWalkParams,
): TwinWalkForward {
  const all = digits.filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
  // The walk only needs the trailing window — older ticks add CPU, not signal.
  const clean = all.length > 2400 ? all.slice(all.length - 2400) : all;
  const n = clean.length;
  const burnIn = Math.max(60, params.burnIn ?? 120);
  const trainFraction = clamp(params.trainFraction ?? 0.5, 0.3, 0.7);
  const spec = params.spec;
  const targetEv = params.targetEvPerDollar ?? TWIN_DEFAULT_TARGET_EV;

  const empty = (): TwinShotLedger => summariseTwin([], 0, 0.5);
  const fallbackHmm = { pHot: 0.62, pCold: 0.5, stay: 0.96, prior: 0.5 };
  if (n < burnIn + 60) {
    return {
      trainTicks: 0,
      testTicks: 0,
      tau: spec.zBar,
      trainShotRate: 0,
      hmm: fallbackHmm,
      train: empty(),
      test: empty(),
      shield: {
        suppressed: 0,
        shieldedWinRate: 0,
        shieldedShots: 0,
        pairsBefore: 0,
        pairsAfter: 0,
        longestRunAfter: 0,
      },
    };
  }

  const out = twinOutcome(contract);
  const marginalOver = out.overCount / 10;
  const beWinRate = twinBreakEvenWinRate(
    contract,
    marginalOver >= 0.5 ? "over" : "under",
    0.1,
  );
  const splitIndex = burnIn + Math.floor((n - burnIn) * trainFraction);

  // Regime snapshot on the training half (diagnostic context on the card).
  const overWins = clean.map((d) => (out.overWinSet.has(d) ? 1 : 0));
  const hmm = fitRegimeHmm(overWins.slice(0, splitIndex));

  // Walk forward paper-trading the EXACT live rule: trailing-only readings,
  // mode cadence, the mode bar + cool-down shield.
  const trainShots: TwinShot[] = [];
  const testShots: TwinShot[] = [];
  let trainExamined = 0;
  let testExamined = 0;
  let lastFire = -Infinity;
  let lastLossIndex = -Infinity;
  let lossRun = 0;
  for (let i = burnIn; i < n; i++) {
    const isTest = i >= splitIndex;
    if (isTest) testExamined++;
    else trainExamined++;
    // Spacing and cool-down are known without a reading — only pay for the
    // estimator on ticks that could actually fire.
    if (i - lastFire < spec.minSpacing) continue;
    if (i - lastLossIndex < spec.postLossCoolTicks) continue;
    const prefix = clean.slice(Math.max(0, i - 600), i);
    const reading = estimateTwinEdge(prefix, contract, {
      maxBias: spec.maxBias,
      targetEv,
    });
    const boost = Math.min(1.5, spec.postLossTightening * lossRun);
    const clears =
      Math.abs(reading.z) >= spec.zBar + boost &&
      reading.edgePerBase >= spec.edgeFloor + boost * 0.002;
    if (clears) {
      const state = classifyDigit(
        contract.overDigit,
        contract.underDigit,
        clean[i],
      );
      const plan = buildTwinPlan(contract, reading.primary, reading.bias, 1);
      const net = twinRegionNet(contract, plan, state);
      const won = net > 0;
      const shot: TwinShot = {
        index: i,
        won,
        edgePerBase: reading.edgePerBase,
        zGate: Math.abs(reading.z),
        netPerBase: net,
        primary: reading.primary,
        bias: reading.bias,
        pOver: reading.pOver,
        pUnder: reading.pUnder,
        state,
        suppressedByShield: false,
      };
      (isTest ? testShots : trainShots).push(shot);
      lastFire = i;
      if (!won) {
        lastLossIndex = i;
        lossRun++;
      } else {
        lastLossIndex = -Infinity;
        lossRun = 0;
      }
    }
  }

  const train = summariseTwin(trainShots, trainExamined, beWinRate);
  const test = summariseTwin(testShots, testExamined, beWinRate);
  return {
    trainTicks: trainExamined,
    testTicks: testExamined,
    tau: round(spec.zBar, 6),
    trainShotRate:
      trainExamined > 0 ? round(trainShots.length / trainExamined, 5) : 0,
    hmm: { pHot: hmm.pHot, pCold: hmm.pCold, stay: hmm.stay, prior: hmm.prior },
    train,
    test,
    shield: simulateTwinShield(testShots, spec),
  };
}

// ── Candidate evaluation ──────────────────────────────────────────────────────

export type TwinVerdict = "certified" | "qualified" | "watch" | "refused";

export interface TwinLadderReport {
  limit: number;
  safety: number;
  expectedShotsToBreak: number;
  horizon: number;
  netOnWinPerBase: number;
  netOnLossPerBase: number;
}

export interface TwinCandidate {
  symbol: string;
  displayName: string;
  contract: TwinContract;
  label: string;
  certainty: TwinCertainty;
  verdict: TwinVerdict;
  confidence: number;
  edgePerDollar: number;
  evLowerPerDollar: number;
  oosWinRate: number;
  oosShots: number;
  primary: TwinSide;
  bias: number;
  breakEvenWinRate: number;
  overPayout: number;
  underPayout: number;
  netOnWinPerBase: number;
  netOnLossPerBase: number;
  ladder: TwinLadderReport;
  pValue: number;
  significant: boolean;
  deployable: boolean;
  blockers: string[];
  signals: string[];
  card: TwinModelCard;
  walk: TwinWalkForward;
  /** Live conviction at the trailing reading (0.05 … 1). */
  conviction: number;
  /** Ranking score: paper edge + conviction + coverage. */
  score: number;
}

export const TWIN_MIN_HISTORY = 120;
export const TWIN_SCAN_WINDOW = 4999;

export interface TwinEvalOptions {
  certainty?: TwinCertainty;
  baseStake?: number;
  targetEvPerDollar?: number;
}

export function evaluateTwinCandidate(
  symbol: string,
  displayName: string,
  digits: number[],
  contract: TwinContract,
  options: TwinEvalOptions = {},
): TwinCandidate | null {
  const clean = digits.filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
  const spec = twinCertaintySpec(options.certainty);
  if (clean.length < TWIN_MIN_HISTORY) return null;
  const out = twinOutcome(contract);
  const payouts = twinPayouts(contract);
  const baseStake = options.baseStake ?? 1;
  const targetEv = options.targetEvPerDollar ?? TWIN_DEFAULT_TARGET_EV;

  const walk = twinWalkForward(clean, contract, {
    spec,
    baseStake,
    targetEvPerDollar: targetEv,
  });
  const test = walk.test;
  // Deploy with the LIVE reading (current tilt), not a stale test average.
  const live = estimateTwinEdge(clean.slice(-600), contract, {
    maxBias: spec.maxBias,
    targetEv,
  });
  const primary = live.primary;
  const bias = live.bias;
  const netOnWinPerBase = live.netOnWinPerBase;
  const netOnLossPerBase = live.netOnLossPerBase;
  const beWinRate = twinBreakEvenWinRate(contract, primary, bias);
  const limitPlan = buildTwinPlan(contract, primary, bias, baseStake);
  const primaryRegion = primary === "over" ? "overOnly" : "underOnly";
  const hedgeRegion = primary === "over" ? "underOnly" : "overOnly";
  const winNet = Math.max(
    1e-6,
    twinRegionNet(contract, limitPlan, primaryRegion),
  );
  const lossNet = Math.min(
    -1e-6,
    twinRegionNet(contract, limitPlan, hedgeRegion),
  );
  const effPayout = 1 + winNet;
  const effLoss = Math.abs(lossNet);
  const ladderLimit = ladderDepthLimit({
    baseStake,
    payout: effPayout,
    markupPercent: 10,
    maxStake: 5000,
    stopLoss: Math.max(1, 5),
  }).limit;
  const horizon = Math.max(60, test.nShots * 2, 80);
  const chain = test.chain;
  const absorption = ladderAbsorption(
    chain.pLoss,
    chain.q,
    ladderLimit,
    horizon,
  );

  // Conservative posterior p-value that the joint win rate is not above the
  // break-even (autocorrelation-corrected effective sample size).
  const shotOutcomes = test.shots.map((s) => (s.won ? 1 : 0));
  const nEff = Math.max(1, effectiveSampleSize(shotOutcomes));
  const scaledHits = test.winRate * nEff;
  const pValue =
    test.nShots > 0
      ? round(
          clamp(
            regularizedIncompleteBeta(
              clamp(beWinRate, 0, 1),
              Math.max(1e-9, scaledHits + 0.5),
              Math.max(1e-9, nEff - scaledHits + 0.5),
            ),
            0,
            1,
          ),
          6,
        )
      : 1;

  // ── Mode-aware verdict. Balanced deploys on any warm market; Strict/Elite
  // ask the paper trail to clear progressively higher bars. A dead-zone pair
  // lowers confidence but never single-handedly refuses in Balanced — the
  // four-region EV already prices the dead zone into every reading.
  const blockers: string[] = [];
  const paperEv = test.nShots > 0 ? test.evPerDollar : -1;
  if (test.nShots < spec.minShots) {
    blockers.push(
      `only ${test.nShots} out-of-sample paper shots (${spec.minShots} needed for full proof)`,
    );
  }
  if (paperEv < spec.minEvCertified) {
    blockers.push(
      `paper net ${(paperEv * 100).toFixed(2)}% per $1 base < ${(spec.minEvCertified * 100).toFixed(2)}% certified bar`,
    );
  }
  if (live.conviction < spec.minConvictionCertified) {
    blockers.push(
      `live conviction ${(live.conviction * 100).toFixed(0)}% < ${(spec.minConvictionCertified * 100).toFixed(0)}% certified bar`,
    );
  }

  const balanceTerm = out.complementary
    ? 1
    : clamp(out.noneCount === 0 ? 0.9 : 1 - out.noneCount / 10, 0, 1);
  const confidence = Math.round(
    clamp(
      100 *
        (0.34 * clamp((paperEv + 0.02) / 0.04, 0, 1) +
          0.26 * live.conviction +
          0.16 * clamp(test.nShots / Math.max(6, spec.minShots * 1.6), 0, 1) +
          0.12 *
            clamp(
              1 - Math.max(0, chain.clusterZ) / 4,
              0,
              1,
            ) +
          0.12 * balanceTerm),
      1,
      100,
    ),
  );

  let verdict: TwinVerdict;
  if (test.nShots === 0) {
    verdict = spec.id === "balanced" ? "watch" : "refused";
    if (verdict === "refused") blockers.push("no paper shots fired out of sample");
  } else if (
    blockers.length === 0 &&
    confidence >= spec.minConfidence
  ) {
    verdict = "certified";
  } else if (paperEv >= spec.minEvQualified) {
    verdict = "qualified";
  } else if (paperEv >= spec.minEvRefuse) {
    verdict = "watch";
  } else {
    verdict = "refused";
    blockers.push(
      `paper net ${(paperEv * 100).toFixed(2)}% below the ${(spec.minEvRefuse * 100).toFixed(2)}% refuse floor`,
    );
  }
  const deployable =
    spec.id === "balanced"
      ? verdict !== "refused"
      : spec.id === "strict"
        ? verdict === "certified" || verdict === "qualified" || verdict === "watch"
        : verdict === "certified" || verdict === "qualified";

  const safe = clamp(1 - absorption, 0, 1);
  const signals = [
    `VERDICT ${verdict.toUpperCase()} · confidence ${confidence}/100 · paper net ${(test.evPerDollar * 100).toFixed(2)}% per $1 base (Wilson ${(test.evLowerPerDollar * 100).toFixed(2)}%)`,
    `PAIR · ${twinLabel(contract)} on ${displayName} · ${out.complementary ? "complementary 50/50 (exactly one leg always wins)" : out.noneCount === 0 ? `covers every digit (${out.bothCount} overlap)` : `${out.noneCount} dead digit(s) outside both legs`} · payout over ${payouts.over.toFixed(2)}× / under ${payouts.under.toFixed(2)}×`,
    `WALK-FORWARD · ${test.nShots} unseen paper shots at ${(test.winRate * 100).toFixed(1)}% joint win rate (break-even ${(beWinRate * 100).toFixed(1)}%) · live tilt ${(live.tilt * 100).toFixed(2)}pp · conviction ${(live.conviction * 100).toFixed(0)}%`,
    `SKEW · live bias ${(bias * 100).toFixed(1)}% on the ${primary} side at a ${(spec.maxBias * 100).toFixed(0)}% ${spec.label} cap — grows with conviction, shrinks when flat`,
    `EVIDENCE · e-value ${test.evidence.peak.toFixed(1)} (anytime-valid, p≈${test.evidence.pValue < 0.001 ? test.evidence.pValue.toExponential(1) : test.evidence.pValue.toFixed(3)})`,
    `LADDER · effective payout ${effPayout.toFixed(2)}× → absorbs ${ladderLimit} consecutive losses · FMCI safety ${(safe * 100).toFixed(1)}% over ${horizon} shots · E[break] ${test.chain.q ? expectedShotsToLadderBreak(chain.pLoss, chain.q, ladderLimit) : "—"}`,
    `SHIELD · paper loss pairs ${walk.shield.pairsBefore} → ${walk.shield.pairsAfter} under the post-loss protocol · longest run after ${walk.shield.longestRunAfter}`,
    `MODEL · P(over|ctx) ${(live.pOver * 100).toFixed(1)}% · P(under|ctx) ${(live.pUnder * 100).toFixed(1)}% · HMM hot ${(walk.hmm.pHot * 100).toFixed(1)}% / cold ${(walk.hmm.pCold * 100).toFixed(1)}%`,
  ];
  for (const b of blockers) signals.push(`⛔ ${b}`);

  const card: TwinModelCard = {
    tau: walk.tau,
    targetShotRate: round(1 / Math.max(1, spec.minSpacing), 4),
    hmm: walk.hmm,
    overDigit: contract.overDigit,
    underDigit: contract.underDigit,
    overPayout: payouts.over,
    underPayout: payouts.under,
    minSpacing: spec.minSpacing,
    postLossTightening: spec.postLossTightening,
    postLossCoolTicks: spec.postLossCoolTicks,
    targetEvPerDollar: targetEv,
    fittedOn: walk.trainTicks,
    certainty: spec.id,
    edgeFloor: spec.edgeFloor,
    maxBias: spec.maxBias,
    agreeTicks: spec.agreeTicks,
    minHistory: spec.minHistory,
  };

  const ladder: TwinLadderReport = {
    limit: ladderLimit,
    safety: round(safe, 4),
    expectedShotsToBreak: expectedShotsToLadderBreak(
      chain.pLoss,
      chain.q,
      ladderLimit,
    ),
    horizon,
    netOnWinPerBase: round(winNet, 5),
    netOnLossPerBase: round(-effLoss, 5),
  };

  const score = round(
    test.evPerDollar + 0.05 * live.conviction + 0.01 * balanceTerm,
    6,
  );

  return {
    symbol,
    displayName,
    contract,
    label: twinLabel(contract),
    certainty: spec.id,
    verdict,
    confidence,
    edgePerDollar: test.evPerDollar,
    evLowerPerDollar: test.evLowerPerDollar,
    oosWinRate: test.winRate,
    oosShots: test.nShots,
    primary,
    bias: round(bias, 3),
    breakEvenWinRate: round(beWinRate, 5),
    overPayout: payouts.over,
    underPayout: payouts.under,
    netOnWinPerBase: round(netOnWinPerBase, 5),
    netOnLossPerBase: round(netOnLossPerBase, 5),
    ladder,
    pValue,
    significant: false,
    deployable,
    blockers,
    signals,
    card,
    walk,
    conviction: live.conviction,
    score,
  };
}

/** Benjamini–Hochberg across the family, then rank by verdict → score → safety. */
export function screenTwinCandidates(
  candidates: TwinCandidate[],
  q = 0.1,
): TwinCandidate[] {
  if (candidates.length === 0) return [];
  const passes = benjaminiHochberg(
    candidates.map((c) => c.pValue),
    q,
  );
  const rank: Record<TwinVerdict, number> = {
    certified: 0,
    qualified: 1,
    watch: 2,
    refused: 3,
  };
  const screened = candidates.map((c, i) => {
    const significant = passes[i] === true;
    return { ...c, significant, deployable: c.deployable };
  });
  return screened.sort((a, b) => {
    if (rank[a.verdict] !== rank[b.verdict])
      return rank[a.verdict] - rank[b.verdict];
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    return b.ladder.safety - a.ladder.safety;
  });
}
