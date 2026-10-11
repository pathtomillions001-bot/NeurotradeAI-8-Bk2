/**
 * WP6 — the gatekeeper: the last thing between a plan and the market.
 *
 * ── THE IDEA ────────────────────────────────────────────────────────────────
 *
 * Every layer upstream of this file produces either a CALIBRATED PROBABILITY or
 * a HARD PERMISSION. Neither is a decision. The gatekeeper is where they become
 * one, and it does so with a single auditable rule:
 *
 *   arm the trade only if its edge survives EVERY layer, at the LOWER bound of
 *   the probability, at the expected fill, net of the measured cost.
 *
 * ── THE LAYERS, AND WHY EACH EXISTS ─────────────────────────────────────────
 *
 *   1. INPUTS       a risk unit, a cost, an entry and a horizon. A plan whose
 *                   geometry cannot be priced is refused before anything
 *                   statistical is asked about it.
 *   2. MODEL        a calibrated probability with independent evidence behind
 *                   it. No model, no trade: `p_LCB` comes from WP5 and it is
 *                   the only probability the gate is allowed to multiply by.
 *   3. R:R          reward:risk at the expected FILL ≥ 2. Slippage is money, and
 *                   it is the first thing that quietly eats a "3R" setup.
 *   4. COST/σ_h     the round trip against the travel available over the desk's
 *                   own horizon. A trade can have a lovely R:R and still be a
 *                   coin flip paying a fee; this is the layer that says so.
 *   5. EV_LCB       EV at p_LCB against the mode's floor — a floor ABOVE zero,
 *                   because "break-even after costs" is a trade whose entire
 *                   expected profit is estimation error.
 *   6. REGIME       the WP3 permit, composed rather than inferred. A permit that
 *                   could not be computed is a REFUSAL: "we do not know" is not
 *                   permission.
 *   7. MC_TAIL      the executed-policy Monte Carlo (GARCH-FHS + stationary block
 *                   bootstrap) as a GEOMETRY check: a target the desk's own
 *                   horizon cannot reach, or a block-mean tail that leaks past
 *                   its floor, is a plan the market disagrees with — and the
 *                   study measured 0 of 197 sampled bars passing the first,
 *                   unsatisfiable form of this rule before it was redefined
 *                   (see the constants below and §8.4 of the desk docs).
 *   8. FAMILY       Benjamini–Hochberg at q = 0.10. If the desk scans 40
 *                   candidates and trades the best, the p-value of "the best" is
 *                   not the p-value of a single test, and treating it as one is
 *                   how a search becomes a discovery.
 *
 * ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
 *
 * It is pure: no I/O, no clock, no randomness, no mutation of its inputs. Given
 * the same inputs it returns the same decision — which is what makes a rejection
 * appealable a week later. It can only ADD a refusal, and the caller composes it
 * AFTER every existing gate, so the legacy pipeline keeps its own vetoes intact.
 *
 * Every gate is RECORDED whether it passed or failed (`reasons`), because a
 * decision that only lists its objections cannot be audited for the gates it
 * silently skipped. Every failure carries a machine-readable code and one human
 * sentence with the numbers in it.
 */
import { MIN_RR_FILL } from "../desk-constants";
import { expectedValueLowerBound } from "./pcb";
import type { ExecutedMcResult } from "../montecarlo-v2";
import type { Side, TradeMode } from "../types";

/**
 * R:R at the EXPECTED FILL must be at least this.
 *
 * Deliberately the SAME constant the legacy pipeline enforces at plan time
 * (`MIN_RR_FILL`, re-exported by `agent.ts`): a second floor with a different
 * number would eventually disagree with the first, and the disagreement would be
 * discovered in the market.
 */
export const GATEKEEPER_MIN_RR_FILL = MIN_RR_FILL;

/**
 * The EV floor per mode, at p_LCB.
 *
 * Scalp is stricter on purpose: the same absolute R is a much thinner slice of
 * movement at a scalper's stop, so the estimation error in p̂ is a larger
 * fraction of the edge and a marginal scalp is the most expensive trade the desk
 * can take. The floor is a FLOOR: a later work package may raise it per cohort,
 * never lower it (docs/mt5-live-desk-v4.md §10, the gate ledger).
 */
export const MIN_EV_LCB_R: Record<TradeMode, number> = {
  scalp: 0.25,
  intraday: 0.2,
  swing: 0.2,
};

/** Modes in which the cost/σ_h ceiling is enforced. */
export const COST_OVER_SIGMA_MODES: readonly TradeMode[] = ["scalp"];

/** Cost over the horizon's volatility: at most this, where enforced. */
export const MAX_COST_OVER_HORIZON_SIGMA = 0.15;

/** Benjamini–Hochberg false-discovery rate for a scan's family of setups. */
export const BH_Q = 0.1;

/**
 * The executed-policy MC's two bars. Both are GEOMETRY checks — not alpha claims.
 *
 * ── WHY THEY ARE NOT "THE SIMULATION MUST BE PROFITABLE" ────────────────────
 *
 * The first version of this layer required `p05MeanR > 0`: the 5th percentile of
 * the simulated block means above zero. The WP6 study measured it on the desk's
 * own positive control and on every null: **0 of 197 sampled decision bars
 * passed**, with the simulated per-row mean R centred near −0.1R and a lower tail
 * near −1R. That is not a defect in the Monte Carlo — it is what the Monte Carlo
 * is for. It resamples the market's own paths, enters at the fill, and holds no
 * alpha view, so its expectation IS the random-entry expectation; the entire gate
 * stack exists because that expectation is negative. "The random-entry simulation
 * must be profitable" is therefore unsatisfiable BY CONSTRUCTION, and a gate that
 * can never pass is not a safety gate — it is a stopped desk.
 *
 * What the simulation can veto, model-free, is whether the plan's GEOMETRY is
 * executable inside the desk's own horizon and whether its tail is pathological:
 *
 *   - `targetShare` — the share of simulated trades that reached the target. A
 *     random entry that almost never touches a 2R target within h bars means the
 *     target is out of the market's reach in the time allowed, whatever the model
 *     says about direction.
 *   - `p05MeanR` — the 5th percentile of the simulated block means. Below the
 *     floor the geometry leaks: a stop that gaps, costs that compound.
 *
 * Both bars sit BELOW the range measured on the desk's own corpora — the study
 * stores every sampled reading and prints its range — because a geometry check
 * that bites on healthy plans is an alpha filter in disguise, and the alpha claim
 * belongs to `EV_LCB`, where it is measured.
 */
export const MC_MIN_TARGET_SHARE = 0.02;
export const MC_TAIL_FLOOR_R = 1.5;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Natural log of the gamma function (Lanczos). */
function logGamma(x: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < coefficients.length; i++) a += (coefficients[i] as number) / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log C(n, k) — stable for the sample sizes the desk works with. */
function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** P(X ≥ k) for X ~ Binomial(n, p). Exact, so the gate has no approximation to blame. */
function binomialTail(n: number, p: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let sum = 0;
  for (let i = k; i <= n; i++) {
    sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * One-sided p-value that the setup's true hit rate beats the MEASURED break-even.
 *
 * The comparison is against a rate the desk measured by random entry on this very
 * market (see `alpha/edge.ts`), never against the textbook `1/(1+RR)`: the desk's
 * corpora produce random-entry hit rates of 0.10–0.34, so a textbook test would
 * either wave through trades that are not better than noise or refuse trades that
 * genuinely are. `evidence` is the number of INDEPENDENT observations behind the
 * probability (WP5's Kish effective size), not the row count.
 *
 * Returns 1 when the test cannot be formed — a test that cannot be computed has
 * not been passed.
 */
export function edgeTestPValue(input: {
  probability: number;
  evidence: number;
  breakEven: number;
}): number {
  const { probability, evidence, breakEven } = input;
  if (!Number.isFinite(probability) || !Number.isFinite(evidence) || !Number.isFinite(breakEven)) {
    return 1;
  }
  const n = Math.floor(evidence);
  if (!(n >= 1)) return 1;
  const p0 = clamp01(breakEven);
  const hits = Math.round(clamp01(probability) * n);
  if (hits <= 0) return 1;
  return binomialTail(n, p0, hits);
}

/**
 * Benjamini–Hochberg, step-up.
 *
 * Returns the threshold (so a caller can print the bar that was applied) and the
 * per-hypothesis verdicts. A p-value equal to the threshold is significant; a
 * non-finite or negative p-value never is, because a test that cannot produce a
 * number has not passed. Order-invariant by construction: the hypotheses are
 * sorted internally and the verdicts are mapped back.
 */
export function benjaminiHochberg(
  pValues: number[],
  q: number = BH_Q,
): { threshold: number; accepted: boolean[]; k: number } {
  const m = pValues.length;
  const accepted = new Array<boolean>(m).fill(false);
  if (m === 0) return { threshold: 0, accepted, k: 0 };
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => (a.p === b.p ? a.index - b.index : a.p - b.p));
  let k = 0;
  for (let rank = 1; rank <= m; rank++) {
    const entry = order[rank - 1] as { p: number; index: number };
    if (Number.isFinite(entry.p) && entry.p >= 0 && entry.p <= (rank * q) / m) k = rank;
  }
  // The threshold is the BAR that was crossed — `k·q/m` — not the k-th p-value.
  // Reporting the p-value would make the printed bar depend on which hypothesis
  // happened to land on it, and a journal that re-runs the test could not say
  // what the test was.
  const threshold = k > 0 ? (k * q) / m : 0;
  for (let rank = 0; rank < k; rank++) {
    accepted[(order[rank] as { index: number }).index as number] = true;
  }
  return { threshold, accepted, k };
}

/**
 * Cost against the travel the trade needs to be worth taking:
 *
 *   costPrice / (expectedFill · σ_step · √h)
 *
 * Both sides are in PRICE units, so the ratio is dimensionless and comparable
 * across symbols with very different point values. `stepVolatility` must be a
 * per-bar log-return volatility measured causally, and `horizonBars` the desk's
 * own holding horizon for the mode.
 *
 * Returns `null` when the inputs cannot support a ratio. The caller treats that
 * as "not measured", and an unmeasured cost ceiling is a refusal — not a pass.
 */
export function costOverHorizonSigma(input: {
  costPrice: number;
  expectedFill: number;
  stepVolatility: number;
  horizonBars: number;
}): number | null {
  const { costPrice, expectedFill, stepVolatility, horizonBars } = input;
  if (!(costPrice >= 0) || !Number.isFinite(costPrice)) return null;
  if (!(expectedFill > 0) || !Number.isFinite(expectedFill)) return null;
  if (!(stepVolatility > 0) || !Number.isFinite(stepVolatility)) return null;
  if (!(horizonBars >= 1) || !Number.isFinite(horizonBars)) return null;
  const sigmaH = expectedFill * stepVolatility * Math.sqrt(horizonBars);
  if (!(sigmaH > 0)) return null;
  return costPrice / sigmaH;
}

export type GatekeeperCode =
  | "GK_OK"
  | "GK_BAD_INPUT"
  | "GK_NO_MODEL"
  | "GK_RR_FILL"
  | "GK_COST_SIGMA"
  | "GK_EV_LCB"
  | "GK_REGIME"
  | "GK_MC_UNAVAILABLE"
  | "GK_MC_TAIL"
  | "GK_FAMILY";

/** The WP3 permit as the gatekeeper consumes it — a verdict plus its numbers. */
export interface GatekeeperRegimeInput {
  permit: boolean;
  codes: string[];
  reason: string;
  /** P(required state), for the record whether the permit passed or not. */
  probability: number;
  required: string;
}

export interface GatekeeperInput {
  mode: TradeMode;
  side: Side;
  /** R:R at the expected fill, from the plan's own geometry. */
  rrFill: number;
  /** The expected fill price. */
  expectedFill: number;
  /** The risk unit in price units — the distance to the stop at the fill. */
  riskPrice: number;
  /** Round trip in price units. */
  costPrice: number;
  /** Per-bar log-return volatility, measured causally. */
  stepVolatility: number;
  /** Bars allowed before the time stop. */
  horizonBars: number;
  /** Calibrated probability, and its lower confidence bound. */
  probability: number | null;
  probabilityLowerBound: number | null;
  /** Independent observations behind `p_LCB`. */
  evidence: number;
  /** The measured, direction-matched random-entry rate for this market. */
  breakEvenProbability: number | null;
  /**
   * The WP3 permit. `null` means it could not be computed for this decision, and
   * that is a refusal: an absent permit is never "no objection".
   */
  regime: GatekeeperRegimeInput | null;
  /** The executed-policy Monte Carlo, or `null` when it was not run. */
  mc: ExecutedMcResult | null;
  /** Setups considered in the same scan — the family BH corrects over. */
  familySize: number;
  /** Why no model was available, in the caller's words, for the reason string. */
  modelNote?: string;
}

/** One gate's verdict, with the numbers that produced it — the audit trail. */
export interface GatekeeperReason {
  code: GatekeeperCode;
  /** Human label, for a journal that prints the matrix of gates. */
  label: string;
  /** Whether this gate allowed the trade. */
  pass: boolean;
  /** What was measured (null when there was nothing to measure). */
  value: number | null;
  /** What it had to beat, where a threshold applies. */
  threshold: number | null;
  /** One sentence, with the numbers in it. */
  detail: string;
}

export interface GatekeeperDecision {
  armed: boolean;
  /** The headline code: `GK_OK` when armed, otherwise the first failure. */
  code: GatekeeperCode;
  /** `["GK_OK"]` when armed, else every failing code in evaluation order. */
  codes: GatekeeperCode[];
  /** One human sentence: the first refusal, or what was bought when armed. */
  reason: string;
  /** Every gate, in evaluation order, passed or failed. */
  reasons: GatekeeperReason[];
  /** EV at p_LCB, net of cost, in R. */
  evLcbR: number | null;
  /** The floor it had to beat. */
  requiredEvLcbR: number;
  rrFill: number;
  /** Round trip in R. */
  costR: number;
  /** The horizon's volatility in price units: fill · σ_step · √h. */
  horizonSigma: number | null;
  /** Cost over that volatility — reported for every mode, enforced where listed. */
  costOverSigma: number | null;
  /** One-sided p-value of the edge against the measured break-even. */
  edgePValue: number | null;
  /** The significance bar the test had to clear after correction. */
  bhThreshold: number | null;
  /** The MC's 5th percentile of mean R, or null when there is no MC. */
  mcP05MeanR: number | null;
  /** The share of simulated trades that reached the target, or null. */
  mcTargetShare: number | null;
  horizonBars: number;
}

/**
 * The decision. Pure, total, and ordered cheapest-first so that a bad input never
 * reaches a statistical layer — and so that the first sentence a user reads names
 * the most fundamental thing wrong with the plan.
 */
export function gatekeeperDecision(input: GatekeeperInput): GatekeeperDecision {
  const reasons: GatekeeperReason[] = [];
  const required = MIN_EV_LCB_R[input.mode];
  const rrFill = input.rrFill;

  const riskUsable =
    Number.isFinite(input.riskPrice) && input.riskPrice > 0 && Number.isFinite(input.costPrice);
  const costR = riskUsable ? input.costPrice / input.riskPrice : Number.NaN;
  const pLcb = input.probabilityLowerBound;
  const evLcbR =
    riskUsable && pLcb !== null && Number.isFinite(pLcb) && Number.isFinite(rrFill)
      ? expectedValueLowerBound({ pLcb, targetMultipleR: rrFill, costR })
      : null;
  const horizonSigma =
    Number.isFinite(input.expectedFill) &&
    input.expectedFill > 0 &&
    Number.isFinite(input.stepVolatility) &&
    input.stepVolatility > 0 &&
    input.horizonBars >= 1
      ? input.expectedFill * input.stepVolatility * Math.sqrt(input.horizonBars)
      : null;
  const costOverSigma = costOverHorizonSigma({
    costPrice: input.costPrice,
    expectedFill: input.expectedFill,
    stepVolatility: input.stepVolatility,
    horizonBars: input.horizonBars,
  });
  const breakEven = input.breakEvenProbability;
  const edgePValue =
    breakEven !== null &&
    input.probability !== null &&
    Number.isFinite(breakEven) &&
    Number.isFinite(input.probability)
      ? edgeTestPValue({
          probability: input.probability,
          evidence: input.evidence,
          breakEven,
        })
      : null;
  const bhThreshold =
    Number.isFinite(input.familySize) && input.familySize >= 1 ? BH_Q / input.familySize : null;

  // ── 1. inputs ─────────────────────────────────────────────────────────────
  const hold = (code: GatekeeperCode, label: string, pass: boolean, value: number | null, threshold: number | null, detail: string): void => {
    reasons.push({ code, label, pass, value, threshold, detail });
  };

  const inputsOk =
    riskUsable &&
    breakEven !== null &&
    Number.isFinite(breakEven) &&
    Number.isFinite(rrFill) &&
    rrFill > 0 &&
    Number.isFinite(input.expectedFill) &&
    input.expectedFill > 0 &&
    input.horizonBars >= 1;
  hold(
    "GK_BAD_INPUT",
    "plan geometry",
    inputsOk,
    riskUsable ? input.riskPrice : null,
    null,
    inputsOk
      ? `geometry usable: risk ${input.riskPrice.toPrecision(4)} price units, round trip ${input.costPrice.toPrecision(4)} (${(costR || 0).toFixed(4)}R), horizon ${input.horizonBars} bars.`
      : breakEven === null
        ? "no measured break-even rate was supplied, so the edge cannot be tested against anything."
        : "the plan's risk unit, cost, entry price or horizon is unusable, so its edge cannot be priced.",
  );

  // ── 2. model ──────────────────────────────────────────────────────────────
  const modelOk = pLcb !== null && Number.isFinite(pLcb) && input.probability !== null && input.evidence >= 1;
  hold(
    "GK_NO_MODEL",
    "calibrated probability",
    modelOk,
    modelOk ? pLcb : null,
    null,
    modelOk
      ? `p_LCB ${(pLcb as number).toFixed(4)} on ${Math.round(input.evidence)} independent observations.`
      : `no calibrated probability with evidence behind it — ${input.modelNote ?? "the meta-model could not be fitted for this decision"}.`,
  );

  // ── 3. R:R at the fill ────────────────────────────────────────────────────
  const rrOk = Number.isFinite(rrFill) && rrFill >= GATEKEEPER_MIN_RR_FILL;
  hold(
    "GK_RR_FILL",
    "R:R at the fill",
    rrOk,
    Number.isFinite(rrFill) ? rrFill : null,
    GATEKEEPER_MIN_RR_FILL,
    rrOk
      ? `R:R at the expected fill is 1:${rrFill.toFixed(2)}, at or above the 1:${GATEKEEPER_MIN_RR_FILL.toFixed(2)} the desk requires.`
      : `R:R at the expected fill is 1:${(Number.isFinite(rrFill) ? rrFill : 0).toFixed(2)}, under the 1:${GATEKEEPER_MIN_RR_FILL.toFixed(2)} the desk requires.`,
  );

  // ── 4. cost against the horizon's volatility ──────────────────────────────
  const enforced = COST_OVER_SIGMA_MODES.includes(input.mode);
  const costOk = !enforced || (costOverSigma !== null && costOverSigma <= MAX_COST_OVER_HORIZON_SIGMA);
  hold(
    "GK_COST_SIGMA",
    "cost vs horizon volatility",
    costOk,
    costOverSigma,
    enforced ? MAX_COST_OVER_HORIZON_SIGMA : null,
    costOk
      ? costOverSigma === null
        ? `the round trip against the horizon's volatility was not enforced for ${input.mode}.`
        : `the round trip is ${(100 * costOverSigma).toFixed(1)}% of the horizon's volatility, within the ${(100 * MAX_COST_OVER_HORIZON_SIGMA).toFixed(0)}% ceiling for ${input.mode}.`
      : costOverSigma === null
        ? "the round trip could not be measured against the horizon's volatility, and an unmeasured cost ceiling is a refusal."
        : `the round trip is ${(100 * costOverSigma).toFixed(1)}% of the horizon's volatility, over the ${(100 * MAX_COST_OVER_HORIZON_SIGMA).toFixed(0)}% ceiling for ${input.mode}.`,
  );

  // ── 5. EV at the bound ────────────────────────────────────────────────────
  const evOk = evLcbR !== null && evLcbR >= required;
  hold(
    "GK_EV_LCB",
    "expected value at p_LCB",
    evOk,
    evLcbR,
    required,
    evOk
      ? `EV_LCB is ${(evLcbR as number).toFixed(3)}R against the ${required.toFixed(2)}R floor for ${input.mode}.`
      : evLcbR === null
        ? `EV_LCB could not be computed (p_LCB or the geometry is missing), so it cannot clear the ${required.toFixed(2)}R floor for ${input.mode}.`
        : `EV_LCB is ${evLcbR.toFixed(3)}R, under the ${required.toFixed(2)}R floor for ${input.mode}.`,
  );

  // ── 6. the regime permit ──────────────────────────────────────────────────
  const regime = input.regime;
  const regimeOk = regime !== null && regime.permit;
  hold(
    "GK_REGIME",
    "WP3 regime permit",
    regimeOk,
    regime !== null && Number.isFinite(regime.probability) ? regime.probability : null,
    null,
    regimeOk
      ? `${regime.reason} [${regime.codes.join(", ")}] P=${regime.probability.toFixed(3)}`
      : regime === null
        ? "the regime permit could not be computed for this decision, and an unmeasured state is not permission."
        : `${regime.reason} [${regime.codes.join(", ")}] P=${regime.probability.toFixed(3)}`,
  );

  // ── 7. the executed-policy tail ───────────────────────────────────────────
  const mc = input.mc;
  if (mc === null) {
    hold(
      "GK_MC_UNAVAILABLE",
      "executed-policy Monte Carlo",
      false,
      null,
      null,
      "the executed-policy Monte Carlo was not run for this decision, and a tail nobody measured is not a tail that is safe.",
    );
  } else if (!mc.pathsUsingGarch) {
    hold(
      "GK_MC_UNAVAILABLE",
      "executed-policy Monte Carlo",
      false,
      null,
      null,
      "the executed-policy Monte Carlo could not fit a GARCH(1,1) to this history, so today's volatility could not be resampled.",
    );
  } else {
    const traded = mc.outcomes.target + mc.outcomes.stop + mc.outcomes.timeout;
    const targetShare = traded > 0 ? mc.outcomes.target / traded : 0;
    const targetOk = targetShare >= MC_MIN_TARGET_SHARE;
    const tailOk = mc.p05MeanR >= -MC_TAIL_FLOOR_R;
    const geometryOk = targetOk && tailOk;
    hold(
      "GK_MC_TAIL",
      "executed-policy geometry",
      geometryOk,
      mc.p05MeanR,
      -MC_TAIL_FLOOR_R,
      geometryOk
        ? `the simulation reaches the target on ${(100 * targetShare).toFixed(1)}% of paths and the 5th percentile of the block means is ${mc.p05MeanR.toFixed(3)}R over ${mc.paths} paths.`
        : targetOk
          ? `the 5th percentile of the simulated block means is ${mc.p05MeanR.toFixed(3)}R, through the ${(-MC_TAIL_FLOOR_R).toFixed(2)}R floor — the geometry leaks at the tail.`
          : `the simulation reaches the target on only ${(100 * targetShare).toFixed(1)}% of paths (floor ${(100 * MC_MIN_TARGET_SHARE).toFixed(1)}%): the target is not reachable inside this horizon.`,
    );
  }

  // ── 8. multiplicity ───────────────────────────────────────────────────────
  const familyOk =
    edgePValue !== null && bhThreshold !== null && Number.isFinite(edgePValue) && edgePValue <= bhThreshold;
  hold(
    "GK_FAMILY",
    "Benjamini–Hochberg",
    familyOk,
    edgePValue,
    bhThreshold,
    familyOk
      ? `the edge's p-value is ${(edgePValue as number).toPrecision(3)} against the ${(bhThreshold as number).toPrecision(3)} Benjamini–Hochberg bar for a family of ${input.familySize} at q = ${BH_Q}.`
      : edgePValue === null
        ? "the edge's significance could not be tested, because the measured break-even rate is unavailable."
        : bhThreshold === null
          ? `the edge's p-value is ${edgePValue.toPrecision(3)} but the size of the scan's family was not supplied, so no correction could be applied.`
          : `the edge's p-value is ${edgePValue.toPrecision(3)} against the ${bhThreshold.toPrecision(3)} Benjamini–Hochberg bar for a family of ${input.familySize} at q = ${BH_Q}.`,
  );

  const failures = reasons.filter((reason) => !reason.pass);
  const armed = failures.length === 0;
  const codes: GatekeeperCode[] = armed
    ? ["GK_OK"]
    : (failures.map((reason) => reason.code) as GatekeeperCode[]);
  const reason = armed
    ? `armed: EV_LCB ${(evLcbR as number).toFixed(3)}R over the ${required.toFixed(2)}R floor for ${input.mode}, at 1:${rrFill.toFixed(2)} to the expected fill.`
    : ((failures[0] as GatekeeperReason).detail as string);

  return {
    armed,
    code: (codes[0] as GatekeeperCode) ?? "GK_OK",
    codes,
    reason,
    reasons,
    evLcbR,
    requiredEvLcbR: required,
    rrFill,
    costR: Number.isFinite(costR) ? costR : Number.NaN,
    horizonSigma,
    costOverSigma,
    edgePValue,
    bhThreshold,
    mcP05MeanR: mc === null ? null : mc.p05MeanR,
    mcTargetShare:
      mc === null ||
      mc.outcomes.target + mc.outcomes.stop + mc.outcomes.timeout <= 0
        ? null
        : mc.outcomes.target / (mc.outcomes.target + mc.outcomes.stop + mc.outcomes.timeout),
    horizonBars: input.horizonBars,
  };
}

/**
 * The refusal lines a journal shows: one per failing gate, `[CODE] sentence`.
 *
 * Membership is decided by the FAILED gates themselves — never by whether a
 * numeric threshold is attached. A code with no threshold (`GK_NO_MODEL`,
 * `GK_MC_UNAVAILABLE`, `GK_REGIME`) is still a refusal, and filtering those out
 * once made a refused plan read as though it had been armed.
 */
export function gatekeeperRejections(decision: GatekeeperDecision): string[] {
  if (decision.armed) return [];
  return decision.reasons
    .filter((reason) => !reason.pass)
    .map((reason) => `[${reason.code}] ${reason.detail}`);
}
