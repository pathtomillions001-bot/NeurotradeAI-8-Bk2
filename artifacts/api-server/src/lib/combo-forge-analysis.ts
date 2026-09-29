/**
 * Combo Forge — pure, import-free analysis core.
 *
 * TYPED PORT of the runtime module the generated DBot executes:
 *   artifacts/dbot-builder/src/external/bot-skeleton/services/tradeEngine/trade/combo-forge-analysis.js
 * KEEP IN PARITY — `combo-forge-analysis.test.ts` replays identical tapes through
 * both files and fails on any divergence. The API uses this copy for forge-time
 * expectation setting (margins, detectability, fair-tape false-fire rate).
 *
 * WHAT IT DECIDES
 * ───────────────
 * Every candidate is a (market, contract) pair: Over/Under, Even/Odd,
 * Matches/Differs or Rise/Fall (1-tick). Each has a win/lose series over the
 * market's tape. The engine answers two different questions:
 *
 *  NORMAL entry — "is there evidence that this contract's win probability is
 *  ABOVE its break-even (1/payout), and is the CURRENT state favourable?"
 *    · A prequential mixture e-process (a test martingale): six experts —
 *      fair rate, shrunk marginal, fast-decay marginal, lag-aware order-1
 *      context, order-2 context, and a state context (last digit, or the
 *      last move's direction and size for Rise/Fall) — are blended by their
 *      own PAST log-loss only. The product of (mixture prediction ÷ break-even)
 *      over the tape is the evidence. The mixture is clipped at break-even
 *      from below (the one-sided trick), which makes the product a genuine
 *      supermartingale for every win rate ≤ break-even: Ville's inequality
 *      then bounds the false-alarm rate by 1/threshold.
 *    · The threshold is Bonferroni'd over EVERY candidate scanned this cycle
 *      (markets × contracts, with auto Matches/Differs expanded to ten digits),
 *      so scanning more markets never makes noise look like an edge.
 *    · Lag correction: a 1-tick contract enters on the first tick AFTER the
 *      buy, so if a tick lands during decision + round trip the state the bot
 *      saw is two ticks old. The order-1 expert blends the lag-1 and lag-2
 *      rows by rho = P(a tick lands in between).
 *    · Edge expiry: if the most recent quarter of the tape is significantly
 *      worse than the whole tape, the evidence is treated as expired.
 *    · Loss clustering veto (only when enough losses exist to measure it).
 *
 *  RECOVERY entry — the debt must be repaid, so there is no edge to demand.
 *  The contract/market are chosen by the expected log-growth of the exact
 *  attempt the shared recovery ladder will place:
 *      stake = clamp(debt · (1 + markup) / (payout − 1), 0.35, maxStake)
 *      U     = p·ln(1 + stake·(payout−1)/W) + (1−p)·ln(1 − stake/W)
 *  with p the mixture's CURRENT-state win probability and W the live balance.
 *  That single number trades win chance against the stake a low-payout leg
 *  forces, and refuses an attempt that would consume the balance.
 *
 * HONESTY
 * ───────
 * Digit and Rise/Fall contracts are priced below fair odds, so on a fair random
 * tape NO rule is profitable. Strict mode therefore stays silent on fair tapes
 * (that is the point); Always mode trades the cheapest, best-timed candidate
 * without demanding evidence. Neither mode promises a win rate.
 */

export const COMBO_CONTRACT_TYPES = [
  "DIGITOVER",
  "DIGITUNDER",
  "DIGITEVEN",
  "DIGITODD",
  "DIGITMATCH",
  "DIGITDIFF",
  "CALL",
  "PUT",
] as const;

export type ComboContractType = (typeof COMBO_CONTRACT_TYPES)[number];

export const COMBO_FALLBACK_PAYOUT: Readonly<Record<ComboContractType, number>> = Object.freeze({
  DIGITOVER: 1.95,
  DIGITUNDER: 1.95,
  DIGITEVEN: 1.95,
  DIGITODD: 1.95,
  DIGITMATCH: 8.93,
  DIGITDIFF: 1.09,
  CALL: 1.92,
  PUT: 1.92,
});

export const COMBO_FORGE_LIMITS = Object.freeze({
  priorStrength: 20,
  fastDecay: 0.94,
  fastStrength: 8,
  ctx1Strength: 12,
  ctx2Strength: 12,
  stateStrength: 10,
  clampLow: 0.001,
  clampHigh: 0.999,
  confidenceZ: 1.282,
  expiryZ: 1.645,
  minClusterLosses: 10,
  minStake: 0.35,
  minSamples: Object.freeze({ normal: 60, recovery: 40 }),
  maxClustering: Object.freeze({ normal: 1.45, recovery: 1.6 }),
  alpha: Object.freeze({ strict: 0.05, balanced: 0.25, always: 1 }),
});

export const COMBO_STRICTNESS = ["strict", "balanced", "always"] as const;
export type ComboStrictness = (typeof COMBO_STRICTNESS)[number];

export interface ComboSpec {
  type: ComboContractType;
  digit: number;
}
export interface ComboWireSpec extends ComboSpec {
  payout: number;
  auto?: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);
const clampP = (p: number): number => clamp(finiteOr(p, 0.5), COMBO_FORGE_LIMITS.clampLow, COMBO_FORGE_LIMITS.clampHigh);

export function normaliseStrictness(value: unknown): ComboStrictness {
  const s = String(value ?? "").toLowerCase();
  return (COMBO_STRICTNESS as readonly string[]).includes(s) ? (s as ComboStrictness) : "strict";
}

export function parseComboContracts(csv: string): ComboWireSpec[] {
  return String(csv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((raw) => {
      const [type = "", digitRaw = "-1", payoutRaw = ""] = raw.split(":");
      const t = type.toUpperCase();
      const digit = Math.trunc(Number(digitRaw));
      const payout = Number(payoutRaw);
      return {
        type: t as ComboContractType,
        digit: Number.isFinite(digit) ? digit : -1,
        payout:
          Number.isFinite(payout) && payout > 1
            ? payout
            : (COMBO_FALLBACK_PAYOUT[t as ComboContractType] ?? 1.95),
      };
    })
    .filter((c) => (COMBO_CONTRACT_TYPES as readonly string[]).includes(c.type));
}

export function expandComboContracts(specs: ComboWireSpec[]): ComboWireSpec[] {
  const out: ComboWireSpec[] = [];
  for (const spec of specs) {
    if ((spec.type === "DIGITMATCH" || spec.type === "DIGITDIFF") && !(spec.digit >= 0 && spec.digit <= 9)) {
      for (let d = 0; d <= 9; d++) out.push({ ...spec, digit: d, auto: true });
    } else {
      out.push({ ...spec, auto: false });
    }
  }
  return out;
}

const isDirection = (type: string): boolean => type === "CALL" || type === "PUT";

export function comboFairRate(spec: ComboSpec): number {
  switch (spec.type) {
    case "DIGITOVER":
      return (9 - spec.digit) / 10;
    case "DIGITUNDER":
      return spec.digit / 10;
    case "DIGITEVEN":
    case "DIGITODD":
      return 0.5;
    case "DIGITMATCH":
      return 0.1;
    case "DIGITDIFF":
      return 0.9;
    default:
      return 0.5;
  }
}

function digitWinFn(spec: ComboSpec): ((d: number) => boolean) | null {
  switch (spec.type) {
    case "DIGITOVER":
      return spec.digit >= 0 && spec.digit <= 8 ? (d) => d > spec.digit : null;
    case "DIGITUNDER":
      return spec.digit >= 1 && spec.digit <= 9 ? (d) => d < spec.digit : null;
    case "DIGITEVEN":
      return (d) => d % 2 === 0;
    case "DIGITODD":
      return (d) => d % 2 === 1;
    case "DIGITMATCH":
      return spec.digit >= 0 && spec.digit <= 9 ? (d) => d === spec.digit : null;
    case "DIGITDIFF":
      return spec.digit >= 0 && spec.digit <= 9 ? (d) => d !== spec.digit : null;
    default:
      return null;
  }
}

export interface ComboSeries {
  wins: boolean[];
  states: number[];
  stateCount: number;
  p0: number;
}

export function buildComboSeries(
  spec: ComboSpec,
  digits: readonly number[],
  quotes?: readonly number[],
): ComboSeries | null {
  if (isDirection(spec.type)) {
    const q = (quotes ?? []).map(Number);
    if (q.length < 4 || q.some((v) => !Number.isFinite(v))) return null;
    const deltas: number[] = [];
    for (let i = 1; i < q.length; i++) deltas.push(q[i]! - q[i - 1]!);
    const mags = deltas.map(Math.abs).sort((a, b) => a - b);
    const median = mags[Math.floor(mags.length / 2)]!;
    const wins = deltas.map((d) => (spec.type === "CALL" ? d > 0 : d < 0));
    const states = deltas.map((d) => (d > 0 ? 1 : 0) + (Math.abs(d) > median ? 2 : 0));
    return { wins, states, stateCount: 4, p0: 0.5 };
  }
  const winOf = digitWinFn(spec);
  if (!winOf || !Array.isArray(digits) || digits.length < 4) return null;
  const clean = digits.map((d) => clamp(Math.trunc(Number(d)) || 0, 0, 9));
  return { wins: clean.map(winOf), states: clean, stateCount: 10, p0: comboFairRate(spec) };
}

const EXPERTS = 6;

export interface ComboEvidence {
  samples: number;
  hits: number;
  losses: number;
  logE: number;
  pNext: number;
  pNextLower: number;
  pNextUpper: number;
  marginal: number;
  breakEven: number;
  clustering: number;
  expiryZ: number;
  expired: boolean;
  contextSamples: number;
}

export function scanEvidence(input: {
  wins: readonly boolean[];
  states: readonly number[];
  stateCount: number;
  p0: number;
  payout: number;
  rho?: number;
}): ComboEvidence {
  const { wins, states, stateCount, p0, payout } = input;
  const L = COMBO_FORGE_LIMITS;
  const n = wins.length;
  const pb = clamp(1 / payout, 0.001, 0.999);
  const S = Math.max(1, Math.trunc(stateCount) || 1);
  const r = clamp(finiteOr(Number(input.rho ?? 0), 0), 0, 1);
  const stateOf = (i: number): number => clamp(Math.trunc(Number(states[i])) || 0, 0, S - 1);
  const bit = (i: number): 0 | 1 => (wins[i] ? 1 : 0);

  let h = 0;
  let m = 0;
  let fh = 0;
  let fn = 0;
  const c1: number[][] = [[0, 0], [0, 0]];
  const cl: number[][] = [[0, 0], [0, 0]];
  const c2: number[][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
  const cs: number[][] = Array.from({ length: S }, () => [0, 0]);
  const logW: number[] = new Array(EXPERTS).fill(0);
  let logE = 0;

  const predict = (x1: 0 | 1, x2: 0 | 1, s1: number): number[] => {
    const pm = (h + L.priorStrength * p0) / (m + L.priorStrength);
    const pf = (fh + L.fastStrength * pm) / (fn + L.fastStrength);
    const row1 = c1[x1]!;
    const rowL = cl[x2]!;
    const p1 = (row1[1]! + L.ctx1Strength * pm) / (row1[0]! + row1[1]! + L.ctx1Strength);
    const pL = (rowL[1]! + L.ctx1Strength * pm) / (rowL[0]! + rowL[1]! + L.ctx1Strength);
    const pLag = (1 - r) * p1 + r * pL;
    const row2 = c2[2 * x2 + x1]!;
    const p2 = (row2[1]! + L.ctx2Strength * pLag) / (row2[0]! + row2[1]! + L.ctx2Strength);
    const rowS = cs[s1]!;
    const pS = (rowS[1]! + L.stateStrength * pLag) / (rowS[0]! + rowS[1]! + L.stateStrength);
    return [p0, pm, pf, pLag, p2, pS].map(clampP);
  };

  const mix = (qs: number[]): number => {
    let max = -Infinity;
    for (const v of logW) max = Math.max(max, v);
    let z = 0;
    const w = logW.map((v) => {
      const e = Math.exp(v - max);
      z += e;
      return e;
    });
    let q = 0;
    for (let i = 0; i < EXPERTS; i++) q += (w[i]! / z) * qs[i]!;
    return q;
  };

  for (let t = 0; t < n; t++) {
    const x = bit(t);
    if (t >= 2) {
      const qs = predict(bit(t - 1), bit(t - 2), stateOf(t - 1));
      const q = clampP(mix(qs));
      const qe = clamp(Math.max(q, pb), pb, L.clampHigh);
      logE += x ? Math.log(qe / pb) : Math.log((1 - qe) / (1 - pb));
      for (let i = 0; i < EXPERTS; i++) logW[i]! += Math.log(x ? qs[i]! : 1 - qs[i]!);
    }
    h += x;
    m += 1;
    fh = L.fastDecay * fh + x;
    fn = L.fastDecay * fn + 1;
    if (t >= 1) c1[bit(t - 1)]![x]! += 1;
    if (t >= 2) {
      cl[bit(t - 2)]![x]! += 1;
      c2[2 * bit(t - 2) + bit(t - 1)]![x]! += 1;
      cs[stateOf(t - 1)]![x]! += 1;
    }
  }

  let pNext = clampP(p0);
  let contextSamples = 0;
  if (n >= 3) {
    const x1 = bit(n - 1);
    const x2 = bit(n - 2);
    pNext = clampP(mix(predict(x1, x2, stateOf(n - 1))));
    contextSamples = c1[x1]![0]! + c1[x1]![1]!;
  }

  const hits = h;
  const losses = n - hits;
  let ll = 0;
  let lw = 0;
  for (let i = 1; i < n; i++) {
    if (!wins[i - 1]) {
      if (!wins[i]) ll++;
      else lw++;
    }
  }
  const rawLossRate = n > 0 ? losses / n : 1;
  // Loss clustering: P(loss | previous loss) over P(loss), using the one-sided 90% LOWER confidence
  // bound of the numerator. A raw ratio over a few dozen losses is mostly noise (it vetoed a
  // genuine 93% edge on an i.i.d. tape); this only vetoes clustering that is statistically present.
  let clustering = 1;
  if (losses >= L.minClusterLosses) {
    const m = ll + lw;
    const pLL = (ll + 1) / (m + 2);
    const lo = Math.max(0, pLL - 1.2816 * Math.sqrt((pLL * (1 - pLL)) / (m + 2)));
    clustering = lo / Math.max(0.01, rawLossRate);
  }

  const recentLen = Math.max(20, Math.floor(n / 4));
  let expiryZ = 0;
  if (n >= recentLen * 2) {
    let recentHits = 0;
    for (let i = n - recentLen; i < n; i++) recentHits += bit(i);
    const whole = clamp(hits / n, 0.02, 0.98);
    const se0 = Math.sqrt((whole * (1 - whole)) / recentLen);
    expiryZ = (recentHits / recentLen - whole) / se0;
  }

  const marginal = (hits + L.priorStrength * p0) / (n + L.priorStrength);
  const nEff = Math.max(20, Math.min(n, contextSamples + L.priorStrength));
  const se = Math.sqrt((pNext * (1 - pNext)) / nEff);
  const pNextLower = clamp(pNext - L.confidenceZ * se, 0, 1);
  const pNextUpper = clamp(pNext + L.confidenceZ * se, 0, 1);

  return {
    samples: n,
    hits,
    losses,
    logE: finiteOr(logE, 0),
    pNext,
    pNextLower,
    pNextUpper,
    marginal,
    breakEven: pb,
    clustering,
    expiryZ,
    expired: expiryZ < -L.expiryZ,
    contextSamples,
  };
}

export function recoveryAttempt(input: {
  debt: number;
  payout: number;
  markupPercent: number;
  maxStake: number;
  balance: number;
  pWin: number;
}): { stake: number; utility: number; feasible: boolean } {
  const { payout, pWin } = input;
  const L = COMBO_FORGE_LIMITS;
  const b = Math.max(1e-9, payout - 1);
  const target =
    Math.max(0, finiteOr(Number(input.debt), 0)) * (1 + Math.max(0, finiteOr(Number(input.markupPercent), 0)) / 100);
  const cap = input.maxStake > 0 ? input.maxStake : 500;
  // The app's shared recovery stake, verbatim: debt×(1+markup)/(payout−1),
  // clamped to [0.35, max stake], rounded UP to the cent, never above balance.
  let stake = clamp(target / b, L.minStake, cap);
  stake = Math.ceil((stake - 1e-9) * 100) / 100;
  if (input.balance > 0 && stake > input.balance) stake = Math.floor(input.balance * 100) / 100;
  if (stake < L.minStake) stake = L.minStake;
  const wealth = input.balance > 0 ? input.balance : stake * 20;
  if (stake >= wealth * 0.98) return { stake, utility: -Infinity, feasible: false };
  const utility = pWin * Math.log(1 + (stake * b) / wealth) + (1 - pWin) * Math.log(1 - stake / wealth);
  return { stake, utility: finiteOr(utility, -Infinity), feasible: true };
}

export const comboMargin = (p0: number, payout: number): number => 1 - p0 * payout;

export interface ComboRow extends ComboEvidence {
  symbol: string;
  contract: ComboContractType;
  barrier: number;
  payout: number;
  fairRate: number;
}

export interface ComboEvaluatedRow extends ComboRow {
  ev: number;
  evLower: number;
  score: number;
  eligible: boolean;
  blockers: string[];
  stake: number;
}

export interface ComboRankContext {
  mode: "NORMAL" | "RECOVERY";
  strictness: ComboStrictness;
  threshold: number;
  debt: number;
  markupPercent: number;
  maxStake: number;
  balance: number;
}

export function evaluateComboRow(row: ComboRow, ctx: ComboRankContext): ComboEvaluatedRow {
  const L = COMBO_FORGE_LIMITS;
  const recovery = ctx.mode === "RECOVERY";
  const strictness = ctx.strictness;
  const minSamples = recovery ? L.minSamples.recovery : L.minSamples.normal;
  const maxCluster = recovery ? L.maxClustering.recovery : L.maxClustering.normal;
  const ev = row.pNext * row.payout - 1;
  const evLower = row.pNextLower * row.payout - 1;
  const blockers: string[] = [];

  if (row.samples < minSamples) blockers.push(`samples ${row.samples}/${minSamples}`);
  if (row.expired) blockers.push(`edge expiring (z ${row.expiryZ.toFixed(1)})`);
  if (row.clustering >= maxCluster) blockers.push(`loss clustering ${row.clustering.toFixed(2)}x`);

  if (recovery) {
    const attempt = recoveryAttempt({
      debt: ctx.debt,
      payout: row.payout,
      markupPercent: ctx.markupPercent,
      maxStake: ctx.maxStake,
      balance: ctx.balance,
      pWin: row.pNext,
    });
    if (!attempt.feasible) blockers.push("stake would exceed the balance");
    if (strictness === "strict" && row.pNext < row.fairRate) {
      blockers.push(`state below fair (${(row.pNext * 100).toFixed(1)}% vs ${(row.fairRate * 100).toFixed(1)}%)`);
    } else if (strictness === "balanced" && row.pNextUpper < row.fairRate) {
      blockers.push("conditional win rate significantly below fair");
    }
    return { ...row, ev, evLower, score: attempt.utility, eligible: blockers.length === 0, blockers, stake: attempt.stake };
  }

  if (strictness !== "always") {
    if (row.logE < ctx.threshold) blockers.push(`evidence ${row.logE.toFixed(1)}/${ctx.threshold.toFixed(1)} nats`);
    if (ev <= 0) blockers.push(`state EV ${(ev * 100).toFixed(2)}%`);
  }
  return { ...row, ev, evLower, score: evLower, eligible: blockers.length === 0, blockers, stake: 0 };
}

export function rankComboRows(
  rows: ComboRow[],
  opts: {
    mode: "NORMAL" | "RECOVERY";
    strictness?: unknown;
    debt?: number;
    markupPercent?: number;
    maxStake?: number;
    balance?: number;
  },
): { rows: ComboEvaluatedRow[]; threshold: number; candidates: number; strictness: ComboStrictness } {
  const s = normaliseStrictness(opts.strictness);
  const k = Math.max(1, rows.length);
  const alpha = COMBO_FORGE_LIMITS.alpha[s];
  const threshold = s === "always" ? 0 : Math.log(k / alpha);
  const evaluated = rows.map((row) =>
    evaluateComboRow(row, {
      mode: opts.mode,
      strictness: s,
      threshold,
      debt: opts.debt ?? 0,
      markupPercent: opts.markupPercent ?? 10,
      maxStake: opts.maxStake ?? 500,
      balance: opts.balance ?? 0,
    }),
  );
  evaluated.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const sa = Number.isFinite(a.score) ? a.score : -1e9;
    const sb = Number.isFinite(b.score) ? b.score : -1e9;
    return sb - sa || b.logE - a.logE;
  });
  return { rows: evaluated, threshold, candidates: k, strictness: s };
}

export interface ComboDecision {
  symbol: string;
  contract: ComboContractType;
  barrier: number;
  payout: number;
  eligible: boolean;
  forceable: boolean;
  score: number;
  probability: number;
  lowerBound: number;
  breakEven: number;
  ev: number;
  evidence: number;
  threshold: number;
  margin: number;
  clustering: number;
  samples: number;
  candidates: number;
  stake: number;
  changedMarket: boolean;
  reason: string;
}

export function describeComboDecision(
  best: ComboEvaluatedRow,
  meta: { threshold: number; candidates: number; strictness: ComboStrictness },
  currentSymbol: string,
): ComboDecision {
  const label = `${best.contract}${best.barrier >= 0 && best.contract !== "CALL" && best.contract !== "PUT" ? ` ${best.barrier}` : ""}`;
  return {
    symbol: best.symbol,
    contract: best.contract,
    barrier: best.barrier,
    payout: best.payout,
    eligible: best.eligible,
    forceable: true,
    score: Number.isFinite(best.score) ? best.score : -999,
    probability: best.pNext,
    lowerBound: best.pNextLower,
    breakEven: best.breakEven,
    ev: best.ev,
    evidence: best.logE,
    threshold: meta.threshold,
    margin: comboMargin(best.fairRate, best.payout),
    clustering: best.clustering,
    samples: best.samples,
    candidates: meta.candidates,
    stake: best.stake || 0,
    changedMarket: best.symbol !== currentSymbol,
    reason: best.eligible
      ? `READY ${label} ${meta.strictness} · evidence ${best.logE.toFixed(1)} nats (need ${meta.threshold.toFixed(1)}) · win ${(best.pNext * 100).toFixed(1)}% vs BE ${(best.breakEven * 100).toFixed(1)}%`
      : `HOLD: ${best.blockers.join(", ") || "no qualified setup"}`,
  };
}

export const SWITCH_HYSTERESIS = Object.freeze({ normal: 0.01, recovery: 0.0001, relative: 0.25 });

export function pickDecisionRow(
  rankedRows: ComboEvaluatedRow[],
  currentSymbol: string,
  mode: "NORMAL" | "RECOVERY",
): ComboEvaluatedRow {
  const best = rankedRows[0]!;
  if (best.symbol === currentSymbol) return best;
  const here = rankedRows.find((r) => r.symbol === currentSymbol);
  if (!here || here.eligible !== best.eligible || !Number.isFinite(here.score)) return best;
  const floor = mode === "RECOVERY" ? SWITCH_HYSTERESIS.recovery : SWITCH_HYSTERESIS.normal;
  const gain = (Number.isFinite(best.score) ? best.score : -1e9) - here.score;
  return gain > Math.max(floor, SWITCH_HYSTERESIS.relative * Math.abs(here.score)) ? best : here;
}

export interface ComboTape {
  symbol: string;
  digits: number[];
  quotes: number[];
}

export function scanComboMarket(input: {
  symbol: string;
  digits: number[];
  quotes: number[];
  candidates: ComboWireSpec[];
  window?: number;
  rho?: number;
}): ComboRow[] {
  const w = Math.max(20, Math.min(1000, Math.trunc(Number(input.window)) || 500));
  const d = input.digits.slice(-w);
  const q = input.quotes.slice(-w);
  const rows: ComboRow[] = [];
  for (const spec of input.candidates) {
    const series = buildComboSeries(spec, d, q);
    if (!series) continue;
    const evidence = scanEvidence({ ...series, payout: spec.payout, rho: input.rho });
    rows.push({
      symbol: input.symbol,
      contract: spec.type,
      barrier: isDirection(spec.type) ? -1 : spec.digit,
      payout: spec.payout,
      fairRate: series.p0,
      ...evidence,
    });
  }
  return rows;
}

export function analyseCombo(input: {
  mode?: "NORMAL" | "RECOVERY";
  strictness?: unknown;
  tapes: ComboTape[];
  contracts: ComboWireSpec[];
  currentSymbol: string;
  window?: number;
  rho?: number;
  debt?: number;
  markupPercent?: number;
  maxStake?: number;
  balance?: number;
}): { decision: ComboDecision | null; rows: ComboEvaluatedRow[]; threshold: number; candidates: number } {
  const candidates = expandComboContracts(input.contracts);
  const rows: ComboRow[] = [];
  for (const tape of input.tapes) {
    rows.push(...scanComboMarket({ ...tape, candidates, window: input.window ?? 500, rho: input.rho ?? 0 }));
  }
  if (rows.length === 0) return { decision: null, rows: [], threshold: 0, candidates: 0 };
  const ranked = rankComboRows(rows, {
    mode: input.mode ?? "NORMAL",
    strictness: input.strictness ?? "strict",
    debt: input.debt ?? 0,
    markupPercent: input.markupPercent ?? 10,
    maxStake: input.maxStake ?? 500,
    balance: input.balance ?? 0,
  });
  const decision = describeComboDecision(
    pickDecisionRow(ranked.rows, input.currentSymbol, input.mode ?? "NORMAL"),
    ranked,
    input.currentSymbol,
  );
  return { decision, rows: ranked.rows, threshold: ranked.threshold, candidates: ranked.candidates };
}

// ── Forge-time expectation setting ───────────────────────────────────────────

/** Deterministic PRNG (mulberry32) so forge-time diagnostics are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fair random tape: uniform digits and symmetric ±1 price moves. */
export function fairTape(symbol: string, length: number, rand: () => number): ComboTape {
  const digits: number[] = [];
  const quotes: number[] = [];
  let q = 1000;
  for (let i = 0; i < length; i++) {
    digits.push(Math.floor(rand() * 10));
    q += rand() < 0.5 ? -1 : 1;
    quotes.push(q);
  }
  return { symbol, digits, quotes };
}

/** KL(p ‖ q) for Bernoulli, in nats. */
export function bernoulliKl(p: number, q: number): number {
  const pp = clamp(p, 1e-9, 1 - 1e-9);
  const qq = clamp(q, 1e-9, 1 - 1e-9);
  return pp * Math.log(pp / qq) + (1 - pp) * Math.log((1 - pp) / (1 - qq));
}

export interface ComboContractReading {
  key: string;
  label: string;
  payout: number;
  fairRate: number;
  breakEven: number;
  /** House margin per $1 staked at fair odds (fairRate × payout − 1, negated). */
  margin: number;
  /**
   * Ticks a true win rate `edge` points above break-even needs before the ACTUAL gate fires, median over
   * seeded planted tapes (null = fewer than half crossed within 1000 ticks). `idealTicks` is the
   * information-theoretic floor (threshold ÷ KL, true rate known) — the gate pays a learning cost on top.
   */
  ticksToDetect: { edge: number; ticks: number | null; idealTicks: number | null }[];
  /** Share of fair-tape scans (1 + candidates) on which this contract alone would pass the evidence gate. */
  fairFalseFire: number;
}


const DETECT_CHECKPOINTS = [80, 100, 130, 170, 220, 290, 380, 500, 650, 800, 1000] as const;

/** A tape on which `spec` wins with probability `p` on every tick (everything else fair). */
function plantedTape(spec: ComboSpec, length: number, p: number, rand: () => number): ComboTape {
  const base = fairTape("PLANT", length, rand);
  if (spec.type === "CALL" || spec.type === "PUT") {
    let q = 1000;
    base.quotes = base.quotes.map(() => {
      const win = rand() < p;
      q += (spec.type === "CALL" ? win : !win) ? 1 : -1;
      return q;
    });
    return base;
  }
  const win = digitWinFn(spec);
  if (!win) return base;
  const wins: number[] = [];
  const loses: number[] = [];
  for (let d = 0; d <= 9; d++) (win(d) ? wins : loses).push(d);
  base.digits = base.digits.map(() => {
    const pool = rand() < p ? wins : loses;
    return pool[Math.floor(rand() * pool.length)]!;
  });
  return base;
}

/**
 * Median ticks until the real gate's evidence clears `threshold` on a tape whose true win rate is `p`
 * (prefix of length n, exactly as a window of n ticks would be scored). Null when fewer than half of
 * the seeded replicates cross by 1000 ticks.
 */
function measuredDetectionTicks(
  spec: ComboWireSpec,
  p: number,
  threshold: number,
  strictness: ComboStrictness,
  reps: number,
): number | null {
  if (strictness === "always") return DETECT_CHECKPOINTS[0];
  const crossings: number[] = [];
  for (let r = 0; r < reps; r++) {
    const rand = mulberry32(0xc0ffee ^ (r * 7919) ^ Math.round(spec.payout * 1000) ^ ((spec.digit + 3) * 131));
    const tape = plantedTape(spec, DETECT_CHECKPOINTS[DETECT_CHECKPOINTS.length - 1]!, p, rand);
    for (const n of DETECT_CHECKPOINTS) {
      const series = buildComboSeries(spec, tape.digits.slice(0, n), tape.quotes.slice(0, n));
      if (!series) continue;
      const ev = scanEvidence({ ...series, payout: spec.payout });
      if (ev.logE >= threshold && ev.pNext * spec.payout - 1 > 0) {
        crossings.push(n);
        break;
      }
    }
  }
  if (crossings.length * 2 < reps) return null;
  crossings.sort((a, b) => a - b);
  return crossings[Math.floor(reps / 2)] ?? crossings[crossings.length - 1]!;
}

export const comboLabel = (spec: ComboSpec): string => {
  switch (spec.type) {
    case "DIGITOVER":
      return `Over ${spec.digit}`;
    case "DIGITUNDER":
      return `Under ${spec.digit}`;
    case "DIGITEVEN":
      return "Even";
    case "DIGITODD":
      return "Odd";
    case "DIGITMATCH":
      return spec.digit >= 0 ? `Matches ${spec.digit}` : "Matches auto";
    case "DIGITDIFF":
      return spec.digit >= 0 ? `Differs ${spec.digit}` : "Differs auto";
    case "CALL":
      return "Rise";
    case "PUT":
      return "Fall";
  }
};

/**
 * Forge-time replica of the NORMAL evidence gate for each chosen contract:
 * the analytic detection time for a real edge, plus a seeded Monte-Carlo of
 * how often a FAIR tape would trip the gate (it should be ~0 in strict).
 */
export function analyseComboGate(
  specs: ComboWireSpec[],
  opts: { window: number; strictness: ComboStrictness; candidates: number; tapes?: number; detectReps?: number },
): ComboContractReading[] {
  const alpha = COMBO_FORGE_LIMITS.alpha[opts.strictness];
  const k = Math.max(1, opts.candidates);
  const threshold = opts.strictness === "always" ? 0 : Math.log(k / alpha);
  const tapes = Math.max(10, opts.tapes ?? 80);
  const detectReps = Math.max(4, opts.detectReps ?? 10);
  return specs.map((spec) => {
    const fairRate = comboFairRate(spec);
    const breakEven = 1 / spec.payout;
    // Auto Matches/Differs resolve their digit from the live tape; simulate a representative concrete one.
    const sim: ComboWireSpec =
      (spec.type === "DIGITMATCH" || spec.type === "DIGITDIFF") && !(spec.digit >= 0 && spec.digit <= 9)
        ? { ...spec, digit: 5 }
        : spec;
    const ticksToDetect = [0.03, 0.06, 0.1].map((edge) => {
      const target = breakEven + edge;
      if (target >= 0.999) return { edge, ticks: null, idealTicks: null };
      const kl = bernoulliKl(target, breakEven);
      const idealTicks = kl > 0 ? Math.ceil(threshold / kl) : null;
      return { edge, ticks: measuredDetectionTicks(sim, target, threshold, opts.strictness, detectReps), idealTicks };
    });
    let fires = 0;
    const rand = mulberry32(0x9e3779b9 ^ (spec.payout * 1000) ^ (spec.digit + 7));
    for (let i = 0; i < tapes; i++) {
      const tape = fairTape("SIM", opts.window, rand);
      const series = buildComboSeries(sim, tape.digits, tape.quotes);
      if (!series) continue;
      const ev = scanEvidence({ ...series, payout: spec.payout });
      const stateEv = ev.pNext * spec.payout - 1;
      if (opts.strictness === "always" || (ev.logE >= threshold && stateEv > 0)) fires += 1;
    }
    return {
      key: `${spec.type}:${spec.digit}`,
      label: comboLabel(spec),
      payout: spec.payout,
      fairRate,
      breakEven,
      margin: 1 - fairRate * spec.payout,
      ticksToDetect,
      fairFalseFire: fires / tapes,
    };
  });
}
