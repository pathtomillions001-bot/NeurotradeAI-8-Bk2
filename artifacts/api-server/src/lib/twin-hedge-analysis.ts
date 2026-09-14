/**
 * TWIN-HEDGE EDGE — analysis core of the 11th specialist bot.
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
 * none=∅ — exactly one leg always wins. The other user-selected pairs (Over
 * 7/Under 2, Over 6/Under 3, Over 8/Under 1, and the overlapping Over 2/Under
 * 8 and Over 1/Under 9) still trade both legs, but their EV is measured against
 * the FULL four-region outcome, so a pair with a big dead zone is refused unless
 * the model is genuinely confident it will land on a covered digit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EDGE
 * ─────────────────────────────────────────────────────────────────────────────
 * Fair 50/50 legs payout below 2.0 (Over 4 / Under 5 = 1.95), so betting both
 * at EQUAL stakes loses money on every tick. The edge is therefore a STAKE
 * SKEW: the model reads the digit stream and decides which side is more likely,
 * then puts a (small, capped) extra increment on that side. If the favoured
 * side lands, the winning leg's payout more than covers the hedge leg's loss —
 * a positive net. If the hedge side lands, the net loss is recorded and the
 * shared recovery ledger sizes the next pair-shot to recover it.
 *
 * The skew is SELF-ADAPTIVE and derived from the model's own probability: the
 * smallest skew that makes the expected net hit the target return at the model's
 * reading, bounded to keep the hedge a hedge. A model that cannot make the net
 * positive at even the maximum skew is REFUSED — that is the honest bar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS BORROWED FROM THE OVER/UNDER ORACLE
 * ─────────────────────────────────────────────────────────────────────────────
 *   · the walk-forward discipline — fit on the first half, MEASURE on the second
 *   · the self-referential entry bar (a quantile of the model's own trail)
 *   · the anytime-valid e-value on the shot sequence
 *   · the Page–Hinkley regime watch and the post-loss shield
 *   · the exact ladder-safety mathematics
 *   · the same shared recovery ledger / single-executor arbiter
 * The pair side (joint four-region outcome, adaptive stake skew, both-leg
 * execution) is new.
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
  pageHinkley,
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
  /** stake increment on the primary side (0.02 … TWIN_MAX_BIAS). */
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
  /** Fraction of ticks the entry rule may fire on (self-referential). */
  targetShotRate: number;
  /** Minimum out-of-sample pair shots before certifying. */
  minShots: number;
  /** Minimum measured $ net per $1 base stake on unseen shots. */
  minEvPerDollar: number;
  /** Minimum conservative (Wilson) $ net per $1 base stake. */
  minEvLower: number;
  /** Anytime-valid e-value required on the shot sequence. */
  minEvidenceE: number;
  /** Minimum ladder safety = 1 − P(deeper run than the ladder limits). */
  minLadderSafety: number;
  /** One-sided z at which demonstrated loss clustering becomes a veto. */
  maxClusterZ: number;
  minClusterGapPP: number;
  /** Composite confidence floor for a CERTIFIED verdict. */
  minConfidence: number;
  postLossTightening: number;
  postLossCoolTicks: number;
  minSpacing: number;
}

/**
 * Deliberately looser than the Kill-Shot Oracle — this bot is a volume/edge
 * bot. These bars were tuned far too tight (the pair edge cleared on almost no
 * ticks even at Balanced, so the bot took no trades). The shot-rate quantile is
 * the primary "pair edge" lever: a higher `targetShotRate` lowers the
 * self-referential tau, so more ticks clear the bar. The certification floors
 * (shots / EV / evidence / confidence) were lifted in step so more markets
 * deploy and the live gate re-arms faster after a loss.
 */
export const TWIN_CERTAINTY: Record<TwinCertainty, TwinCertaintySpec> = {
  elite: {
    id: "elite",
    label: "Elite",
    targetShotRate: 0.07,
    minShots: 10,
    minEvPerDollar: 0.008,
    minEvLower: 0,
    minEvidenceE: 3,
    minLadderSafety: 0.7,
    maxClusterZ: 1.645,
    minClusterGapPP: 3,
    minConfidence: 58,
    postLossTightening: 0.5,
    postLossCoolTicks: 16,
    minSpacing: 6,
    blurb:
      "Top ~7% of ticks. 10+ out-of-sample pair shots, positive EV, 3× evidence.",
  },
  strict: {
    id: "strict",
    label: "Strict",
    targetShotRate: 0.11,
    minShots: 7,
    minEvPerDollar: 0.002,
    minEvLower: 0,
    minEvidenceE: 2,
    minLadderSafety: 0.55,
    maxClusterZ: 1.96,
    minClusterGapPP: 3,
    minConfidence: 48,
    postLossTightening: 0.4,
    postLossCoolTicks: 12,
    minSpacing: 5,
    blurb:
      "Top ~11% of ticks. 7+ out-of-sample pair shots, measurable positive EV, 2× evidence.",
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    targetShotRate: 0.18,
    minShots: 5,
    minEvPerDollar: 0,
    minEvLower: 0,
    minEvidenceE: 1.2,
    minLadderSafety: 0.45,
    maxClusterZ: 2.33,
    minClusterGapPP: 4,
    minConfidence: 40,
    postLossTightening: 0.3,
    postLossCoolTicks: 8,
    minSpacing: 4,
    blurb:
      "Top ~18% of ticks. Most shots, honest positive out-of-sample EV — the loosest bar.",
  },
};

export function twinCertaintySpec(id?: string): TwinCertaintySpec {
  return (
    TWIN_CERTAINTY[(id as TwinCertainty) ?? "balanced"] ??
    TWIN_CERTAINTY.balanced
  );
}

// ── The pair model (five-experts on the 10-state digit stream) ────────────────

export const TWIN_EXPERT_NAMES = [
  "dirichlet",
  "context-tree",
  "outcome-chain",
  "renewal-hazard",
  "regime-hmm",
] as const;
export type TwinExpertName = (typeof TWIN_EXPERT_NAMES)[number];

export interface TwinDigitReading {
  /** Probabilities for digits 0..9 (sum ≈ 1). */
  digits: number[];
  pOver: number;
  pUnder: number;
  state: TwinStateProb;
  /** $ net per $1 base at the chosen plan (the decision scalar). */
  edgePerBase: number;
  primary: TwinSide;
  bias: number;
  expected: number;
  spread: number;
  uncertainty: number;
  /** Edge per $1 base in units of posterior + disagreement sigma. */
  z: number;
  /** Standardised edge in units of the model's own trailing reading. */
  zRel: number;
  gate: number;
  zGate: number;
}

export interface TwinExpertReading {
  name: TwinExpertName;
  digits: number[];
  weight: number;
}

interface DigitDist {
  digits: number[];
  state: TwinStateProb;
}

const DIRICHLET_DECAY = 0.997;
const MAX_ORDER = 4;
const HEDGE_ETA = 0.35;
const Z_WINDOW = 600;
const Z_WINDOW_MIN = 200;
const Q_REFRESH = 25;
export const TWIN_MAX_BIAS = 0.35;
export const TWIN_MIN_BIAS = 0.02;
/** Default target per-$1 base return the auto-skew aims to reach. */
export const TWIN_DEFAULT_TARGET_EV = 0.01;

function stateFromDigits(digits: number[], c: TwinContract): TwinStateProb {
  const p: TwinStateProb = { overOnly: 0, underOnly: 0, both: 0, none: 0 };
  for (let d = 0; d <= 9; d++) {
    const s = classifyDigit(c.overDigit, c.underDigit, d);
    p[s] += digits[d] ?? 0;
  }
  return p;
}
function normalize(xs: number[]): number[] {
  const total = xs.reduce((a, b) => a + b, 0);
  if (total <= 1e-12)
    return new Array<number>(xs.length).fill(1 / Math.max(1, xs.length));
  return xs.map((x) => Math.max(0, x) / total);
}

function pickPlan(
  c: TwinContract,
  state: TwinStateProb,
  targetEv: number,
  baseStake: number,
): Pick<
  Omit<TwinPlan, "overStake" | "underStake" | "overLeg" | "underLeg">,
  | "primary"
  | "bias"
  | "baseStake"
  | "edgePerBase"
  | "netOnWinPerBase"
  | "netOnLossPerBase"
> {
  const primary: TwinSide =
    state.overOnly + state.both >= state.underOnly + state.both
      ? "over"
      : "under";
  const payouts = twinPayouts(c);
  let bestBias = TWIN_MAX_BIAS;
  let bestEdge = -Infinity;
  for (let bias = TWIN_MIN_BIAS; bias <= TWIN_MAX_BIAS + 1e-9; bias += 0.005) {
    const plan = buildTwinPlan(c, primary, bias, baseStake);
    const edge = twinExpectedNet(c, plan, state);
    // Prefer the SMALLEST bias that clears the target — "slightly increased".
    if (edge >= targetEv) {
      const netOverWin = twinRegionNet(
        c,
        plan,
        primary === "over" ? "overOnly" : "underOnly",
      );
      const netLoss = twinRegionNet(
        c,
        plan,
        primary === "over" ? "underOnly" : "overOnly",
      );
      return {
        primary,
        bias,
        baseStake,
        edgePerBase: edge,
        netOnWinPerBase: netOverWin,
        netOnLossPerBase: netLoss,
      };
    }
    if (edge > bestEdge) {
      bestEdge = edge;
      bestBias = bias;
    }
  }
  const plan = buildTwinPlan(c, primary, bestBias, baseStake);
  return {
    primary,
    bias: bestBias,
    baseStake,
    edgePerBase: bestEdge,
    netOnWinPerBase: twinRegionNet(
      c,
      plan,
      primary === "over" ? "overOnly" : "underOnly",
    ),
    netOnLossPerBase: twinRegionNet(
      c,
      plan,
      primary === "over" ? "underOnly" : "overOnly",
    ),
  };
}

/**
 * Incremental, look-ahead-free digit predictor for the pair. predict() is pure;
 * observe() folds the realised digit in AFTER the prediction.
 */
export class TwinEnsemble {
  private readonly overDigit: number;
  private readonly underDigit: number;
  private readonly targetEv: number;

  private dirichlet = new Array<number>(10).fill(0.5);
  private ctxCount = new Map<string, number>();
  private ctxHits = new Map<string, number[]>();
  private chainCounts = new Map<string, number>();
  private gapHits = new Map<number, { hits: number[]; n: number }>();
  private sinceState: TwinState;
  private hmm: { pHot: number; pCold: number; stay: number; prior: number };
  private hotBelief: number;

  private digits: number[] = [];
  private nSeen = 0;
  private logW: number[];
  private zHist: number[] = [];
  private zSum = 0;
  private zSumSq = 0;
  private targetShotRate: number;
  private qCache = 0;
  private qFresh = false;
  private basePayouts: { over: number; under: number };
  private outcomeProbs: TwinStateProb = {
    overOnly: 0.25,
    underOnly: 0.25,
    both: 0.25,
    none: 0.25,
  };

  constructor(
    c: TwinContract,
    targetShotRate = 0.05,
    hmm?: { pHot: number; pCold: number; stay: number; prior: number },
    targetEv = TWIN_DEFAULT_TARGET_EV,
  ) {
    this.overDigit = c.overDigit;
    this.underDigit = c.underDigit;
    this.targetShotRate = clamp(targetShotRate, 0.001, 0.5);
    this.targetEv = targetEv;
    this.basePayouts = twinPayouts(c);
    this.sinceState = "none";
    this.hmm = hmm ?? { pHot: 0.62, pCold: 0.5, stay: 0.96, prior: 0.5 };
    this.hotBelief = this.hmm.prior;
    this.logW = TWIN_EXPERT_NAMES.map(() => 0);
  }

  get seen(): number {
    return this.nSeen;
  }
  get statWarmth(): number {
    return this.zHist.length;
  }
  get statReady(): boolean {
    return this.zHist.length >= Z_WINDOW_MIN;
  }

  private ctxKey(order: number): string {
    if (order === 0) return "0:";
    const n = this.digits.length;
    if (n < order) return "";
    return `${order}:${this.digits.slice(n - order).join("")}`;
  }

  private readDirichlet(): DigitDist {
    const total = this.dirichlet.reduce((a, b) => a + b, 0);
    const digits = this.dirichlet.map((x) => x / Math.max(1e-9, total));
    return {
      digits,
      state: stateFromDigits(digits, {
        overDigit: this.overDigit,
        underDigit: this.underDigit,
      }),
    };
  }

  private readContextTree(): DigitDist {
    let wSum = 0;
    let pSum = new Array<number>(10).fill(0);
    for (let order = 0; order <= MAX_ORDER; order++) {
      const key = this.ctxKey(order);
      if (!key) continue;
      const c = this.ctxCount.get(key) ?? 0;
      if (order > 0 && c < 6) continue;
      const hits = this.ctxHits.get(key);
      const digits = new Array<number>(10).fill(0);
      let denom = 0;
      for (let d = 0; d < 10; d++) {
        digits[d] = ((hits?.[d] ?? 0) + 0.5) / (c + 5);
        denom += digits[d];
      }
      if (denom <= 0) continue;
      const p = digits.map((x) => x / denom);
      const w = (c / (c + 15)) * Math.pow(0.62, order);
      wSum += w;
      for (let d = 0; d < 10; d++) pSum[d] += w * p[d];
    }
    if (wSum <= 0) return this.readDirichlet();
    return {
      digits: pSum.map((x) => x / wSum),
      state: stateFromDigits(
        pSum.map((x) => x / wSum),
        { overDigit: this.overDigit, underDigit: this.underDigit },
      ),
    };
  }

  private stateKey(state: TwinState, prev?: TwinState): string {
    return prev === undefined ? `${state}:*` : `${prev}:${state}`;
  }

  private readOutcomeChain(): DigitDist {
    const last =
      this.digits.length > 0
        ? classifyDigit(
            this.overDigit,
            this.underDigit,
            this.digits[this.digits.length - 1],
          )
        : "none";
    const prior = 4;
    const p = new Array<number>(4).fill(0);
    let total = 0;
    for (const s of TWIN_STATES) {
      const key = this.stateKey(s, last);
      const count = this.chainCounts.get(key) ?? 0;
      const marginal = this.chainCounts.get(`${s}:*`) ?? 0;
      p[TWIN_STATES.indexOf(s)] = (count + prior * 0.25) / (marginal + prior);
      total += p[TWIN_STATES.indexOf(s)];
    }
    const probs = p.map((x) => x / Math.max(1e-9, total));
    // Distribute each state's mass across the digits of that state.
    const digits = new Array<number>(10).fill(0);
    const out = twinOutcome({
      overDigit: this.overDigit,
      underDigit: this.underDigit,
    });
    const buckets: Array<[TwinState, number[]]> = [
      ["overOnly", out.overOnly],
      ["underOnly", out.underOnly],
      ["both", out.both],
      ["none", out.none],
    ];
    for (const [state, dset] of buckets) {
      if (dset.length === 0) continue;
      const share = probs[TWIN_STATES.indexOf(state)] / dset.length;
      for (const d of dset) digits[d] += share;
    }
    return {
      digits,
      state: stateFromDigits(digits, {
        overDigit: this.overDigit,
        underDigit: this.underDigit,
      }),
    };
  }

  private readRenewal(): DigitDist {
    // Per-state renewal hazard: P(next state | ticks since last time in that state).
    const c = { overDigit: this.overDigit, underDigit: this.underDigit };
    const out = twinOutcome(c);
    const weights = new Array<number>(4).fill(0);
    for (let si = 0; si < TWIN_STATES.length; si++) {
      const state = TWIN_STATES[si];
      const g = this.sinceState === state ? 0 : 1 + this.distanceSince(state);
      let hits = 0;
      let n = 0;
      for (let dg = -1; dg <= 1; dg++) {
        const cell = this.gapHits.get(g + dg);
        if (cell) {
          hits += cell.hits[si] ?? 0;
          n += cell.n;
        }
      }
      const base = this.hmm.pCold;
      weights[si] =
        n >= 8 ? (hits + 6 * base) / (n + 6) : this.hmm.pCold * 0.25;
    }
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const digits = new Array<number>(10).fill(0);
    const buckets: Array<[TwinState, number[]]> = [
      ["overOnly", out.overOnly],
      ["underOnly", out.underOnly],
      ["both", out.both],
      ["none", out.none],
    ];
    for (let si = 0; si < TWIN_STATES.length; si++) {
      const dset = buckets[si]![1];
      if (dset.length === 0) continue;
      const share = weights[si] / total / dset.length;
      for (const d of dset) digits[d] += share;
    }
    return { digits, state: stateFromDigits(digits, c) };
  }

  private distanceSince(state: TwinState): number {
    let dist = 0;
    for (let i = this.digits.length - 1; i >= 0; i--) {
      if (
        classifyDigit(this.overDigit, this.underDigit, this.digits[i]) === state
      )
        return dist;
      dist++;
    }
    return dist;
  }

  private readRegime(): DigitDist {
    const base = this.readDirichlet();
    const over = base.state.overOnly + base.state.both;
    const pHotOver = Math.max(0.02, Math.min(0.98, this.hmm.pHot));
    const pColdOver = Math.max(0.01, Math.min(0.97, this.hmm.pCold));
    const hotNext =
      this.hotBelief * this.hmm.stay +
      (1 - this.hotBelief) * (1 - this.hmm.stay);
    const predicted = hotNext * pHotOver + (1 - hotNext) * pColdOver;
    const digits = base.digits.slice();
    let overMass = 0;
    for (const d of twinOverWinSet(this.overDigit)) overMass += digits[d] ?? 0;
    if (overMass > 1e-9) {
      const scale = clamp(predicted / overMass, 0.1, 10);
      const overSet = twinOverWinSet(this.overDigit);
      for (const d of overSet) digits[d] = (digits[d] ?? 0) * scale;
      const rest =
        digits.reduce((a, b) => a + b, 0) -
        digits.reduce((a, b, idx) => a + (overSet.has(idx) ? b : 0), 0);
      const underM = Math.max(1e-6, 1 - predicted);
      const nonOver = digits.reduce(
        (a, b, idx) => a + (overSet.has(idx) ? 0 : b),
        0,
      );
      const restScale = nonOver > 1e-9 ? Math.max(0.01, underM / nonOver) : 1;
      const outDigits = digits.map((x, idx) =>
        overSet.has(idx) ? x : x * restScale,
      );
      const norm = normalize(outDigits);
      return {
        digits: norm,
        state: stateFromDigits(norm, {
          overDigit: this.overDigit,
          underDigit: this.underDigit,
        }),
      };
    }
    return base;
  }

  private standardise(z: number): number {
    const n = this.zHist.length;
    if (n < Z_WINDOW_MIN) return z;
    const mu = this.zSum / n;
    const v = Math.max(1e-6, this.zSumSq / n - mu * mu);
    return (z - mu) / Math.sqrt(v);
  }

  private windowGate(): number {
    const n = this.zHist.length;
    if (n < Z_WINDOW_MIN) return Number.POSITIVE_INFINITY;
    if (!this.qFresh) {
      const sorted = [...this.zHist].sort((a, b) => a - b);
      const idx = Math.max(
        0,
        Math.min(n - 1, Math.floor(n * (1 - this.targetShotRate))),
      );
      const mu = this.zSum / n;
      const sd = Math.sqrt(Math.max(1e-6, this.zSumSq / n - mu * mu));
      this.qCache = (sorted[idx] - mu) / sd;
      this.qFresh = true;
    }
    return this.qCache;
  }

  /** One-tick-ahead reading. Pure — never mutates. */
  predict(baseStake = 1): TwinDigitReading {
    const c = { overDigit: this.overDigit, underDigit: this.underDigit };
    const readings: TwinExpertReading[] = [];
    const dists: DigitDist[] = [
      this.readDirichlet(),
      this.readContextTree(),
      this.readOutcomeChain(),
      this.readRenewal(),
      this.readRegime(),
    ];
    const maxLog = Math.max(...this.logW);
    const exps = this.logW.map((l) => Math.exp(l - maxLog));
    const wSum = exps.reduce((a, b) => a + b, 0) || 1;
    const weights = exps.map((e) => e / wSum);

    const fused = new Array<number>(10).fill(0);
    let spread = 0;
    for (let i = 0; i < dists.length; i++) {
      readings.push({
        name: TWIN_EXPERT_NAMES[i],
        digits: dists[i]!.digits,
        weight: round(weights[i], 4),
      });
      for (let d = 0; d < 10; d++) fused[d] += weights[i] * dists[i]!.digits[d];
    }
    const state = stateFromDigits(fused, c);
    const pOver = state.overOnly + state.both;
    const pUnder = state.underOnly + state.both;

    // Expert disagreement as uncertainty (variance of per-digit predictions).
    let varAcc = 0;
    for (let d = 0; d < 10; d++) {
      for (let i = 0; i < dists.length; i++)
        varAcc += weights[i] * (dists[i]!.digits[d] - fused[d]) ** 2;
    }
    spread = Math.sqrt(varAcc);

    const plan = pickPlan(c, state, this.targetEv, baseStake);
    const edge = plan.edgePerBase;
    const z = edge / Math.max(1e-5, Math.max(spread, 0.01));
    const zRel = this.standardise(z);
    const gate = this.windowGate();

    return {
      digits: fused.map((x) => round(x, 6)),
      pOver: round(state.overOnly + state.both, 6),
      pUnder: round(state.underOnly + state.both, 6),
      state,
      edgePerBase: round(edge, 6),
      primary: plan.primary,
      bias: round(plan.bias, 3),
      expected: round(
        twinExpectedNet(
          c,
          buildTwinPlan(c, plan.primary, plan.bias, baseStake),
          state,
        ),
        6,
      ),
      spread: round(spread, 6),
      uncertainty: round(Math.max(spread, 1e-4), 6),
      z: round(z, 4),
      zRel: round(zRel, 4),
      gate: round(Number.isFinite(gate) ? gate : 0, 4),
      zGate: round(Number.isFinite(gate) ? zRel - gate : -99, 4),
    };
  }

  /** Fold the realised digit in AFTER predict(). */
  observe(digit: number, reading?: TwinDigitReading) {
    const c = { overDigit: this.overDigit, underDigit: this.underDigit };
    const won = 0;
    void won;
    const state = classifyDigit(this.overDigit, this.underDigit, digit);

    if (reading) {
      this.zHist.push(reading.z);
      this.zSum += reading.z;
      this.zSumSq += reading.z * reading.z;
      if (this.zHist.length > Z_WINDOW) {
        const old = this.zHist.shift()!;
        this.zSum -= old;
        this.zSumSq -= old * old;
      }
      if (this.zHist.length % Q_REFRESH === 0) this.qFresh = false;
      // Hedge update on the 10-class log-loss of the fused digit distribution.
      const p = Math.max(1e-5, reading.digits[digit] ?? 1e-5);
      const loss = -Math.log(p);
      for (let i = 0; i < this.logW.length; i++)
        this.logW[i] -= HEDGE_ETA * loss;
      const maxLog = Math.max(...this.logW);
      for (let i = 0; i < this.logW.length; i++) this.logW[i] -= maxLog;
    }

    // E1 — decayed Dirichlet over digits.
    for (let d = 0; d < 10; d++)
      this.dirichlet[d] = 0.5 + (this.dirichlet[d] - 0.5) * DIRICHLET_DECAY;
    this.dirichlet[digit] += 1;

    // E2 — KT context counts for every order, keyed on the context BEFORE this digit.
    for (let order = 0; order <= MAX_ORDER; order++) {
      const key = this.ctxKey(order);
      if (!key) continue;
      this.ctxCount.set(key, (this.ctxCount.get(key) ?? 0) + 1);
      const hits = this.ctxHits.get(key) ?? new Array<number>(10).fill(0);
      hits[digit] += 1;
      this.ctxHits.set(key, hits);
    }

    // E3 — 4-state outcome chain.
    const prevState =
      this.digits.length > 0
        ? classifyDigit(
            this.overDigit,
            this.underDigit,
            this.digits[this.digits.length - 1],
          )
        : null;
    this.chainCounts.set(
      this.stateKey(state, prevState ?? undefined),
      (this.chainCounts.get(this.stateKey(state, prevState ?? undefined)) ??
        0) + 1,
    );
    this.chainCounts.set(
      this.stateKey(state),
      (this.chainCounts.get(this.stateKey(state)) ?? 0) + 1,
    );

    // E4 — renewal hazard per state (gap before this tick).
    const g = this.sinceState === state ? 0 : this.distanceSince(state) + 1;
    const cell = this.gapHits.get(g) ?? {
      hits: new Array<number>(4).fill(0),
      n: 0,
    };
    cell.hits[TWIN_STATES.indexOf(state)] += 1;
    cell.n += 1;
    this.gapHits.set(g, cell);
    this.sinceState = state;

    // E5 — 2-state regime filter on the "over leg wins" indicator.
    const overSet = twinOverWinSet(this.overDigit);
    const overWon = overSet.has(digit) ? 1 : 0;
    const { pHot, pCold, stay } = this.hmm;
    const hotPrior = this.hotBelief * stay + (1 - this.hotBelief) * (1 - stay);
    const lHot = overWon === 1 ? pHot : 1 - pHot;
    const lCold = overWon === 1 ? pCold : 1 - pCold;
    const num = hotPrior * lHot;
    const den = num + (1 - hotPrior) * lCold;
    this.hotBelief = den > 1e-12 ? clamp(num / den, 1e-4, 1 - 1e-4) : hotPrior;

    this.digits.push(digit);
    if (this.digits.length > 12_000) this.digits.shift();
    this.nSeen++;
  }

  /** Marginal over / under probability observed so far (for diagnostics). */
  get marginalState(): TwinStateProb {
    if (this.nSeen === 0)
      return { overOnly: 0.25, underOnly: 0.25, both: 0.25, none: 0.25 };
    const counts: Record<TwinState, number> = {
      overOnly: 0,
      underOnly: 0,
      both: 0,
      none: 0,
    };
    for (const d of this.digits)
      counts[classifyDigit(this.overDigit, this.underDigit, d)]++;
    const total = this.digits.length;
    return {
      overOnly: counts.overOnly / total,
      underOnly: counts.underOnly / total,
      both: counts.both / total,
      none: counts.none / total,
    };
  }

  setRegime(hmm: {
    pHot: number;
    pCold: number;
    stay: number;
    prior: number;
  }): void {
    this.hmm = hmm;
  }
}

// ── Model card + live entry ───────────────────────────────────────────────────

export interface TwinHmmParams {
  pHot: number;
  pCold: number;
  stay: number;
  prior: number;
}

export interface TwinModelCard {
  tau: number;
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
}

export interface TwinLiveEntry {
  ready: boolean;
  digits: number[];
  pOver: number;
  pUnder: number;
  state: TwinStateProb;
  primary: TwinSide;
  bias: number;
  edgePerBase: number;
  expected: number;
  statWarmth: number;
  tau: number;
  bar: number;
  zGate: number;
  reason: string;
}

/** Replay the frozen rule live from the digit prefix (same deterministic path). */
export function evaluateTwinLiveEntry(
  digits: number[],
  contract: TwinContract,
  card: TwinModelCard,
  opts: { barBoost?: number; ticksSinceLoss?: number; burnIn?: number } = {},
): TwinLiveEntry {
  const clean = digits.filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
  const ens = new TwinEnsemble(
    contract,
    card.targetShotRate,
    card.hmm,
    card.targetEvPerDollar,
  );
  const warm = Math.max(0, clean.length - 1);
  const burnIn = Math.max(0, Math.min(opts.burnIn ?? 300, warm));
  for (let i = 0; i < warm; i++) {
    if (i >= burnIn) {
      const r = ens.predict(1);
      ens.observe(clean[i], r);
    } else {
      ens.observe(clean[i]);
    }
  }
  const reading = ens.predict(1);
  const boost = opts.barBoost ?? 0;
  const bar = card.tau + boost;
  const cooled =
    (opts.ticksSinceLoss ?? Number.POSITIVE_INFINITY) >= card.postLossCoolTicks;
  const enough = clean.length >= 300;
  const warmStat = ens.statReady;
  const z = reading.zGate;
  const clears = z >= bar;
  const ready =
    enough && warmStat && cooled && clears && reading.edgePerBase > 0;

  const reason = !enough
    ? `building history — ${clean.length}/300 digits`
    : !warmStat
      ? `calibrating the live scale — ${ens.statWarmth}/200 readings before the bar means anything`
      : !cooled
        ? `post-loss cool-down — ${opts.ticksSinceLoss ?? 0}/${card.postLossCoolTicks} ticks`
        : !clears
          ? `pair edge ${z.toFixed(2)}σ under the ${bar.toFixed(2)}σ bar · P(over|ctx) ${(reading.pOver * 100).toFixed(1)}% · P(under|ctx) ${(reading.pUnder * 100).toFixed(1)}%`
          : reading.edgePerBase <= 0
            ? `pair edge is not positive at this reading (${(reading.edgePerBase * 100).toFixed(2)}% per $1 base)`
            : "";

  return {
    ready,
    digits: reading.digits,
    pOver: reading.pOver,
    pUnder: reading.pUnder,
    state: reading.state,
    primary: reading.primary,
    bias: reading.bias,
    edgePerBase: reading.edgePerBase,
    expected: reading.expected,
    statWarmth: ens.statWarmth,
    tau: card.tau,
    bar: round(bar, 4),
    zGate: round(z, 4),
    reason,
  };
}

// Re-export the standardisation helper for tests.
export function twinEdgeStats(zHist: number[]): { mean: number; sd: number } {
  if (zHist.length < 2) return { mean: 0, sd: 1 };
  const mu = mean(zHist);
  const v = Math.max(
    1e-6,
    zHist.reduce((a, b) => a + (b - mu) ** 2, 0) / zHist.length,
  );
  return { mean: mu, sd: Math.sqrt(v) };
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
  tau: number,
  maxBarBoost = 2.5,
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
    const clears = s.zGate >= tau + boost;
    if (cooled && clears && s.edgePerBase > 0) {
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
  const clean = digits.filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
  const n = clean.length;
  const burnIn = Math.max(150, params.burnIn ?? 300);
  const trainFraction = clamp(params.trainFraction ?? 0.5, 0.3, 0.7);
  const spec = params.spec;
  const targetEv = params.targetEvPerDollar ?? TWIN_DEFAULT_TARGET_EV;

  const empty = (): TwinShotLedger => summariseTwin([], 0, 0.5);
  if (n < burnIn + 200) {
    return {
      trainTicks: 0,
      testTicks: 0,
      tau: 0,
      trainShotRate: 0,
      hmm: { pHot: 0.62, pCold: 0.5, stay: 0.96, prior: 0.5 },
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
  const payouts = twinPayouts(contract);
  // Primary side has to be materialised per shot; for the break-even we use the
  // model-implied marginal preference.
  const marginalOver = out.overCount / 10;
  const primaryFallback: TwinSide = marginalOver >= 0.5 ? "over" : "under";
  const bePrimary = primaryFallback;
  const beBias = 0.1;
  const beWinRate = twinBreakEvenWinRate(contract, bePrimary, beBias);

  const splitIndex = burnIn + Math.floor((n - burnIn) * trainFraction);

  // Pass 1: fit the HMM and report on the training tail.
  const overWins = clean.map((d) => (out.overWinSet.has(d) ? 1 : 0));
  const hmm = fitRegimeHmm(overWins.slice(0, splitIndex));

  const fitEns = new TwinEnsemble(contract, spec.targetShotRate, hmm, targetEv);
  const trainGates: number[] = [];
  for (let i = 0; i < splitIndex; i++) {
    if (i >= burnIn) {
      const r = fitEns.predict(1);
      if (fitEns.statReady) trainGates.push(r.zGate);
      fitEns.observe(clean[i], r);
    } else {
      fitEns.observe(clean[i]);
    }
  }

  // Build a self-referential tau from the training readings (in zGate units).
  const trainGatesSorted = [...trainGates].sort((a, b) => a - b);
  const targetCount = Math.ceil(trainGates.length * spec.targetShotRate);
  const neededCount = Math.ceil(spec.minShots * 1.6);
  const wanted = Math.min(
    trainGates.length,
    Math.max(targetCount, neededCount),
  );
  const qIndex = Math.max(
    0,
    Math.min(Math.max(0, trainGates.length - 1), trainGates.length - wanted),
  );
  const tau = trainGates.length > 0 ? trainGatesSorted[qIndex] : 0;

  // Pass 2: walk forward, applying tau from `split` onward.
  const live = new TwinEnsemble(contract, spec.targetShotRate, hmm, targetEv);
  const trainShots: TwinShot[] = [];
  const testShots: TwinShot[] = [];
  let trainExamined = 0;
  let testExamined = 0;
  let lastFire = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i >= burnIn) {
      const r = live.predict(1);
      const isTest = i >= splitIndex;
      if (live.statReady) {
        if (isTest) testExamined++;
        else trainExamined++;
      }
      if (
        live.statReady &&
        i - lastFire >= spec.minSpacing &&
        r.zGate >= tau &&
        r.edgePerBase > 0
      ) {
        const state = classifyDigit(
          contract.overDigit,
          contract.underDigit,
          clean[i],
        );
        const plan = buildTwinPlan(contract, r.primary, r.bias, 1);
        const net = twinRegionNet(contract, plan, state);
        const shot: TwinShot = {
          index: i,
          won: net > 0,
          edgePerBase: r.edgePerBase,
          zGate: r.zGate,
          netPerBase: net,
          primary: r.primary,
          bias: r.bias,
          pOver: r.pOver,
          pUnder: r.pUnder,
          state,
          suppressedByShield: false,
        };
        (isTest ? testShots : trainShots).push(shot);
        lastFire = i;
      }
      live.observe(clean[i], r);
    } else {
      live.observe(clean[i]);
    }
  }

  const train = summariseTwin(trainShots, trainExamined, beWinRate);
  const test = summariseTwin(testShots, testExamined, beWinRate);
  return {
    trainTicks: trainExamined,
    testTicks: testExamined,
    tau: round(tau, 6),
    trainShotRate:
      trainExamined > 0 ? round(trainShots.length / trainExamined, 5) : 0,
    hmm: { pHot: hmm.pHot, pCold: hmm.pCold, stay: hmm.stay, prior: hmm.prior },
    train,
    test,
    shield: simulateTwinShield(testShots, spec, tau),
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
}

export const TWIN_MIN_HISTORY = 900;
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
  const primary: TwinSide =
    test.shots.length > 0
      ? test.shots.reduce<Record<TwinSide | "tie", number>>(
          (acc, s) => {
            acc[s.primary] += 1;
            return acc;
          },
          { over: 0, under: 0, tie: 0 } as Record<TwinSide | "tie", number>,
        ).over >=
        test.shots.reduce<Record<TwinSide | "tie", number>>(
          (acc, s) => {
            acc[s.primary] += 1;
            return acc;
          },
          { over: 0, under: 0, tie: 0 } as Record<TwinSide | "tie", number>,
        ).under
        ? "over"
        : "under"
      : out.overCount >= out.underCount
        ? "over"
        : "under";
  const avgBias =
    test.shots.length > 0 ? mean(test.shots.map((s) => s.bias)) : 0.1;
  const netOnWinPerBase = test.avgWinPerBase;
  const netOnLossPerBase = test.avgLossPerBase;
  const beWinRate = twinBreakEvenWinRate(contract, primary, avgBias);
  const limitPlan = buildTwinPlan(contract, primary, avgBias, baseStake);
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

  const blockers: string[] = [];
  if (test.nShots < spec.minShots) {
    blockers.push(
      `only ${test.nShots} out-of-sample pair shots (${spec.minShots} needed)`,
    );
  }
  if (test.nShots > 0 && test.evPerDollar < spec.minEvPerDollar) {
    blockers.push(
      `measured net ${(test.evPerDollar * 100).toFixed(2)}% per $1 base < ${(spec.minEvPerDollar * 100).toFixed(2)}%`,
    );
  }
  if (test.nShots > 0 && test.evLowerPerDollar < spec.minEvLower) {
    blockers.push(
      `conservative (Wilson) net ${(test.evLowerPerDollar * 100).toFixed(2)}% per $1 base < ${(spec.minEvLower * 100).toFixed(2)}%`,
    );
  }
  if (test.evidence.peak < spec.minEvidenceE) {
    blockers.push(
      `evidence e-value ${test.evidence.peak.toFixed(1)} < ${spec.minEvidenceE}`,
    );
  }
  if (
    test.nShots > 4 &&
    chain.clusterZ > spec.maxClusterZ &&
    chain.clusterGapPP >= spec.minClusterGapPP
  ) {
    blockers.push(
      `losses pair up — P(L|L) ${(chain.q * 100).toFixed(1)}% vs marginal ${(chain.pLoss * 100).toFixed(1)}%`,
    );
  }
  if (
    out.noneCount > 0 &&
    (test.avgLossPerBase <= -0.9 || test.winRate < 0.25)
  ) {
    blockers.push(
      `this pair leaves ${out.noneCount} digit(s) outside both legs — the measured shots do not support it`,
    );
  }
  if (walk.test.shots.length > 0 && walk.test.evPerDollar <= 0) {
    blockers.push("out-of-sample expected net is not positive");
  }

  // Confidence composite (out-of-sample terms only).
  const accTerm = clamp(
    test.evPerDollar / Math.max(0.02, spec.minEvPerDollar * 2.5),
    0,
    1,
  );
  const lcbTerm = clamp(
    test.evLowerPerDollar / Math.max(0.01, Math.abs(spec.minEvLower) + 0.01),
    0,
    1,
  );
  const eTerm = clamp(
    Math.log10(Math.max(1, test.evidence.peak)) /
      Math.log10(Math.max(2, spec.minEvidenceE * 4)),
    0,
    1,
  );
  const pairTerm = clamp(
    1 - Math.max(0, chain.clusterZ) / Math.max(1, spec.maxClusterZ * 2),
    0,
    1,
  );
  const cadenceTerm = clamp(
    test.nShots / Math.max(4, spec.minShots * 1.6),
    0,
    1,
  );
  const balanceTerm = out.complementary
    ? 1
    : clamp(out.noneCount === 0 ? 0.9 : 1 - out.noneCount / 10, 0, 1);
  const confidence = Math.round(
    clamp(
      100 *
        (0.34 * accTerm +
          0.22 * lcbTerm +
          0.18 * eTerm +
          0.12 * pairTerm +
          0.08 * cadenceTerm +
          0.06 * balanceTerm),
      0,
      100,
    ),
  );
  if (confidence < spec.minConfidence)
    blockers.push(`composite confidence ${confidence} < ${spec.minConfidence}`);

  const measurable = test.nShots >= Math.max(5, Math.floor(spec.minShots / 2));
  const positive = test.nShots > 0 && test.evPerDollar > 0;
  let verdict: TwinVerdict;
  if (blockers.length === 0) verdict = "certified";
  else if (
    measurable &&
    positive &&
    test.evLowerPerDollar >= Math.min(0, spec.minEvLower)
  )
    verdict = "qualified";
  else if (positive || !measurable) verdict = "watch";
  else verdict = "refused";
  const deployable = verdict === "certified" || verdict === "qualified";

  const safe = clamp(1 - absorption, 0, 1);
  const signals = [
    `VERDICT ${verdict.toUpperCase()} · confidence ${confidence}/100 · out-of-sample net ${(test.evPerDollar * 100).toFixed(2)}% per $1 base (Wilson ${(test.evLowerPerDollar * 100).toFixed(2)}%)`,
    `PAIR · ${twinLabel(contract)} on ${displayName} · ${out.complementary ? "complementary 50/50 (exactly one leg always wins)" : out.noneCount === 0 ? `covers every digit (${out.bothCount} overlap)` : `${out.noneCount} dead digit(s) outside both legs`} · payout over ${payouts.over.toFixed(2)}× / under ${payouts.under.toFixed(2)}×`,
    `WALK-FORWARD · ${test.nShots} unseen pair shots at ${(test.winRate * 100).toFixed(1)}% joint win rate (break-even ${(beWinRate * 100).toFixed(1)}%) · mean net/when right ${(netOnWinPerBase * 100).toFixed(2)}%, when wrong ${(netOnLossPerBase * 100).toFixed(2)}%`,
    `SKEW · auto-bias ${(avgBias * 100).toFixed(1)}% on the ${primary} side — the smallest skew that keeps the pair +EV at the model's reading`,
    `EVIDENCE · e-value ${test.evidence.peak.toFixed(1)} (anytime-valid, p≈${test.evidence.pValue < 0.001 ? test.evidence.pValue.toExponential(1) : test.evidence.pValue.toFixed(3)})`,
    `LADDER · effective payout ${effPayout.toFixed(2)}× → absorbs ${ladderLimit} consecutive losses · FMCI safety ${(safe * 100).toFixed(1)}% over ${horizon} shots · E[break] ${test.chain.q ? expectedShotsToLadderBreak(chain.pLoss, chain.q, ladderLimit) : "—"}`,
    `SHIELD · out-of-sample loss pairs ${walk.shield.pairsBefore} → ${walk.shield.pairsAfter} under the post-loss protocol · longest run after ${walk.shield.longestRunAfter}`,
    `MODEL · P(over|ctx) mean ${(test.meanPredictedOver * 100).toFixed(1)}% · P(under|ctx) mean ${(test.meanPredictedUnder * 100).toFixed(1)}% · HMM hot ${(walk.hmm.pHot * 100).toFixed(1)}% / cold ${(walk.hmm.pCold * 100).toFixed(1)}%`,
  ];
  for (const b of blockers) signals.push(`⛔ ${b}`);

  const card: TwinModelCard = {
    tau: walk.tau,
    targetShotRate: spec.targetShotRate,
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
    bias: round(avgBias, 3),
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
  };
}

/** Benjamini–Hochberg across the family, then rank by verdict → EV → safety. */
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
    if (Math.abs(a.edgePerDollar - b.edgePerDollar) > 0.001)
      return b.edgePerDollar - a.edgePerDollar;
    return b.ladder.safety - a.ladder.safety;
  });
}
