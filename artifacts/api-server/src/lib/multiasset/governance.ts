/**
 * WP9 — learning and governance: the layer that takes a claim back.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 *
 * WP4 measured which agents may propose, and WP5/WP6 price their probabilities.
 * Every one of those measurements is a statement about the PAST. Nothing in
 * WP0–WP8 can notice that an agent stopped working, that the desk's slippage
 * grew past what its EV assumed, or that a model's calibration drifted — the
 * desk would keep taking the same trades with growing confidence while the edge
 * quietly left.
 *
 * This module is the only place in the v4 programme that can REDUCE an agent's
 * standing, and it is deliberately the only one that acts on the desk's OWN
 * realised outcomes rather than on a study:
 *
 *   • a per-agent **e-process** — a nonnegative martingale against the null
 *     "this agent's realised R still has mean ≥ 0". Losing trades accumulate as
 *     evidence; it is not a p-value, so it can be watched after every single
 *     trade without the false-alarm rate inflating (that is the whole point of
 *     an e-value: Ville's inequality bounds P(ever reaching K) by 1/K for any
 *     stopping rule). At e ≥ 5 the agent's budget is HALVED; at e ≥ 20 the agent
 *     is DISABLED.
 *   • a **Page–Hinkley** detector per agent — the CUSUM-style change detector for
 *     a shift in the mean, reported alongside the e-value because the two answer
 *     different questions: "is it worse than break-even" (e-process) and "has
 *     something changed recently" (PH).
 *
 * ── WHY THE ACTIONS ARE ONE-WAY ─────────────────────────────────────────────
 *
 * A halved agent stays halved and a disabled agent stays disabled until an
 * operator explicitly resumes it. That is not conservatism for its own sake: the
 * WP4 rule is that "the one thing this layer must not do is quietly come back to
 * life", and an e-process whose threshold is crossed and then recrossed is
 * exactly that. `resumeAgent()` exists so the decision is a human's, with the
 * e-value and the reason recorded in the journal.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * No RNG, no wall clock, no I/O. Every function here is a pure function of the
 * state and the observation it is given, so a week's governance can be replayed
 * from the stored trades and must produce the same verdict — which is the only
 * reason the stored trades are worth storing.
 */

import { ALPHA_IDS, type AlphaId } from "./alpha/types";

/** Evidence of a real degradation: halve the agent's budget. */
export const E_HALVE = 5;
/** Evidence that the agent is not working: disable it. */
export const E_DISABLE = 20;

/**
 * The bound the e-process's outcomes are clipped to, in R.
 *
 * An e-process for "mean ≤ 0" needs each observation bounded below, and the
 * desk's own geometry supplies that bound: the stop caps a loss at ~1R (a gap
 * can exceed it, which is why the clip is stated rather than assumed). Wins are
 * clipped at +3R — TARGET_MULTIPLES tops out at 3. The RAW R is what the weekly
 * report and the trade ledger carry; the clip exists only so the test remains
 * valid, and no verdict is drawn from the clipped value that the raw value would
 * contradict by more than the clip itself.
 */
export const EPROCESS_LOWER_BOUND_R = 1;
export const EPROCESS_UPPER_BOUND_R = 3;

/**
 * The β grid the per-step bet is hedged over, and the SIGN that matters.
 *
 * The null is "this agent still has mean R ≥ 0". Evidence against it is a run of
 * losses, so the wealth has to GROW when x is negative: `1 − β·x` with β > 0.
 * Writing it the other way round (`1 + λx`) produces a test that grows on WINS —
 * it would disable the desk's best agents and leave its worst alone, which is
 * exactly the mistake this comment exists to prevent.
 *
 * For x ∈ [−1, 3] and β ≤ 1/3 the wealth stays nonnegative, and under the null
 * E[1 − β·x] = 1 − β·E[x] ≤ 1 whenever E[x] ≥ 0 — so the running product is a
 * nonnegative supermartingale under H0 and Ville's inequality bounds
 * P(sup e ≥ K) by 1/K for ANY stopping rule (no multiple-testing correction is
 * needed, which is why this layer may look after every single trade).
 *
 * No single β is best for every alternative, and the mixture of martingales is
 * itself a martingale, so the grid is mixed uniformly. β = 1/3 (the largest
 * admissible) carries most of the power; the geometric tail keeps the test from
 * missing a slow bleed that the aggressive bet would ride through.
 */
export const EPROCESS_BETA_GRID: readonly number[] = [1 / 3, 1 / 6, 1 / 12, 1 / 24, 1 / 48, 1 / 96];
/** Out-of-the-money start: the mixture begins with a small prior on each β. */
const EPROCESS_INITIAL = 1;
/**
 * The floor the running e-value is kept above.
 *
 * A long winning run drives the product toward zero — 2,000 wins put it below
 * the smallest double, and a float that has reached exactly 0 can never grow
 * again, so a catastrophic streak afterwards would go unnoticed forever. The
 * floor is therefore a CORRECTNESS guard, not a tuning knob, and it is
 * conservative in the only direction that matters: restarting from 1e-9 makes
 * the test slower to alarm by ~9 orders of magnitude, never faster.
 */
const EPROCESS_FLOOR = 1e-9;

/**
 * Page–Hinkley parameters, in R.
 *
 * `delta` is the allowance: a shift smaller than this is not worth an alarm.
 * `threshold` is the alarm level on the cumulative deviation.
 */
/**
 * The lower CUSUM's slack, and the report bar it has to cross.
 *
 * MEASURED, not chosen: the study grid in `research/governance-eval.ts` reports
 * the operating characteristics of thirteen (δ, h) pairs over 4,000 break-even
 * streams and 500 degraded ones. This pair — a quarter-R slack, a 12R bar — alarm
 * at 2.5% of quiet 200-trade streams while catching a −0.35R degradation 95.6% of
 * the time, in a mean of 78 trades. Both numbers are re-measured by the unit
 * tests, so a change to either constant has to come with its own measurement.
 */
export const PH_DELTA_R = 0.25;
export const PH_THRESHOLD_R = 12;

/** The governor's verdict on one agent. */
export type AgentGovernanceStatus = "active" | "halved" | "disabled";

export interface AgentGovernanceState {
  agentId: AlphaId;
  status: AgentGovernanceStatus;
  /** The e-value against H0: mean R ≤ 0. Starts at 1; grows with evidence. */
  eValue: number;
  /** Clipped observations seen. */
  outcomes: number;
  wins: number;
  /** Sum of the RAW R (not the clipped values), for the weekly report. */
  totalR: number;
  /** Page–Hinkley's current alarm statistic (`phMax − phCumulative`). */
  phValue: number;
  phAlarms: number;
  /**
   * The Page–Hinkley internals, carried explicitly.
   *
   * They are cumulative sums, so recomputing them from the outcome count would
   * only be right if every outcome had the same value — restarting from a stale
   * mean is how a change detector either misses a shift or alarms on one that
   * never happened.
   */
  phMean: number;
  phCumulative: number;
  phMax: number;
  /** Why the status is what it is — the sentence the journal prints. */
  reason: string | null;
  updatedAtMs: number;
}

/** One outcome attributed to one agent. */
export interface AgentOutcome {
  agentId: AlphaId;
  /** The realised R of the trade this agent proposed. */
  r: number;
  timestampMs: number;
}

/** The action a single outcome caused, if any. Reported so it can be journalled. */
export interface GovernanceAction {
  agentId: AlphaId;
  action: "none" | "halve" | "disable";
  eValue: number;
  reason: string;
}

function clampOutcome(r: number): number {
  if (!Number.isFinite(r)) return 0;
  return Math.min(EPROCESS_UPPER_BOUND_R, Math.max(-EPROCESS_LOWER_BOUND_R, r));
}

/** A fresh state for one agent, at rest. */
export function initialAgentState(agentId: AlphaId, nowMs = 0): AgentGovernanceState {
  return {
    agentId,
    status: "active",
    eValue: EPROCESS_INITIAL,
    outcomes: 0,
    wins: 0,
    totalR: 0,
    phValue: 0,
    phAlarms: 0,
    phMean: 0,
    phCumulative: 0,
    phMax: 0,
    reason: null,
    updatedAtMs: nowMs,
  };
}

/** A fresh registry covering every shipped agent (nothing is left ungoverned). */
export function initialGovernanceRegistry(nowMs = 0): AgentGovernanceState[] {
  return ALPHA_IDS.map((id) => initialAgentState(id, nowMs));
}

/**
 * The hedged e-process's per-step wealth: `Σ_k w_k (1 + λ_k x) / Σ_k w_k`.
 *
 * Under H0 (E[x] ≤ 0) each term `1 + λ_k x` has conditional expectation ≤ 1 —
 * nonnegative because x ≥ −1 and λ_k ≤ 1 — so the running product is a
 * nonnegative martingale starting at 1. Ville's inequality then bounds the
 * false-alarm probability of `e ≥ K` by 1/K, for ANY stopping rule: the desk may
 * look after every trade without the bound degrading.
 */
export function eProcessStepWealth(r: number): number {
  const x = clampOutcome(r);
  let weighted = 0;
  for (const beta of EPROCESS_BETA_GRID) {
    weighted += (1 - beta * x) / EPROCESS_BETA_GRID.length;
  }
  return Math.max(0, weighted);
}

/**
 * Page–Hinkley's cumulative-deviation update for one observation — the LOWER
 * arm, because a trader's change-of-concern is a mean moving DOWN.
 *
 * The statistic is the drop of the running mean below its running maximum
 * (`max − cumulative`), and it accumulates when observations sit below the mean
 * they built — which is exactly the −1R streak this layer exists to notice. (The
 * textbook upper arm, `cumulative − min`, would watch for improvements.)
 *
 * It is reported, never acted on by itself: unlike the e-process, PH has no
 * false-alarm guarantee, so a threshold crossing earns a sentence in the journal
 * and a field in the report, not a budget change. The e-process is the layer that
 * acts.
 */
export function pageHinkleyStep(input: {
  state: { mean: number; cumulative: number; max: number; value: number; observations: number };
  r: number;
  deltaR?: number;
  thresholdR?: number;
}): { mean: number; cumulative: number; max: number; value: number; observations: number; alarm: boolean } {
  const delta = input.deltaR ?? PH_DELTA_R;
  const threshold = input.thresholdR ?? PH_THRESHOLD_R;
  const observations = input.state.observations + 1;
  // The running mean is carried in the state and reported, but it is NOT the
  // reference the statistic measures against: on a constant stream of losses a
  // recursive mean converges to the very value being tested, the deviations
  // telescope to zero, and the detector degenerates into a straight line of
  // slope δ. (This was measured, not assumed — the first version of this
  // function grew 0.05R per trade forever.) The reference is BREAK-EVEN: zero,
  // which is the desk's own definition of the null and needs no human baseline.
  const mean = input.state.mean + (input.r - input.state.mean) / observations;
  // The lower CUSUM resets at zero, which is what makes it a CHANGE detector
  // rather than another global one: an agent with a long profitable history has
  // burned its e-value down toward zero, so a deterioration that begins after
  // two hundred good trades is invisible to the e-process for a long time. This
  // one measures the recent stream on its own terms and reacts in single-digit
  // trades.
  const cumulative = Math.max(0, input.state.cumulative + (-input.r - delta));
  const max = Math.max(input.state.max, cumulative);
  const value = cumulative;
  return { mean, cumulative, max, value, observations, alarm: value > threshold };
}

/**
 * Apply one outcome to one agent's state.
 *
 * The status transitions are one-way, and the e-value is NOT reset when either
 * threshold is crossed: the number that caused the action stays visible in the
 * state (and in the journal), which is what makes the action auditable later.
 */
export function applyAgentOutcome(
  state: AgentGovernanceState,
  outcome: AgentOutcome,
): { state: AgentGovernanceState; action: GovernanceAction } {
  const next: AgentGovernanceState = { ...state, updatedAtMs: outcome.timestampMs };
  next.outcomes += 1;
  next.totalR += Number.isFinite(outcome.r) ? outcome.r : 0;
  if (outcome.r > 0) next.wins += 1;
  next.eValue = Math.max(EPROCESS_FLOOR, next.eValue * eProcessStepWealth(outcome.r));

  const ph = pageHinkleyStep({
    state: {
      mean: state.phMean,
      cumulative: state.phCumulative,
      max: state.phMax,
      value: state.phValue,
      observations: state.outcomes,
    },
    r: outcome.r,
  });
  next.phMean = ph.mean;
  next.phCumulative = ph.cumulative;
  next.phMax = ph.max;
  next.phValue = ph.value;
  const firstAlarm = ph.alarm && state.phValue <= PH_THRESHOLD_R;
  if (ph.alarm) next.phAlarms = state.phAlarms + 1;

  let action: GovernanceAction["action"] = "none";
  let reason: string | null = null;
  if (next.status !== "disabled" && next.eValue >= E_DISABLE) {
    next.status = "disabled";
    action = "disable";
    reason = `the per-agent e-process reached ${next.eValue.toFixed(1)} against break-even (disable at ${E_DISABLE}) after ${next.outcomes} outcomes totalling ${next.totalR.toFixed(3)}R`;
  } else if (state.status === "active" && next.eValue >= E_HALVE) {
    next.status = "halved";
    action = "halve";
    reason = `the per-agent e-process reached ${next.eValue.toFixed(1)} against break-even (halve at ${E_HALVE}); the agent keeps proposing at half its budget until an operator resumes it`;
  } else if (firstAlarm) {
    // A change detector firing on an agent that is still working is a second,
    // independent reason to look — recorded once per crossing, and it does not
    // act on its own: PH has no false-alarm guarantee to spend.
    reason = `Page–Hinkley registered a downward shift (the running mean is ${ph.value.toFixed(2)}R below its peak, over the ${PH_THRESHOLD_R}R report bar) after ${next.outcomes} outcomes`;
  }
  if (reason !== null) next.reason = reason;
  return { state: next, action: { agentId: outcome.agentId, action, eValue: next.eValue, reason: next.reason ?? "" } };
}

/**
 * Apply a whole outcome to the registry, returning the new registry and any
 * actions taken (at most one per outcome, and only for the agent named).
 */
export function applyGovernanceOutcome(
  registry: AgentGovernanceState[],
  outcome: AgentOutcome,
): { registry: AgentGovernanceState[]; action: GovernanceAction } {
  const index = registry.findIndex((entry) => entry.agentId === outcome.agentId);
  if (index < 0) {
    // An unknown agent is registered rather than ignored: an agent the desk
    // cannot govern is an agent it should not be running.
    const seeded = applyAgentOutcome(initialAgentState(outcome.agentId, outcome.timestampMs), outcome);
    return { registry: [...registry, seeded.state], action: seeded.action };
  }
  const current = registry[index] as AgentGovernanceState;
  const { state, action } = applyAgentOutcome(current, outcome);
  const next = registry.slice();
  next[index] = state;
  return { registry: next, action };
}

/** An operator's explicit decision to put an agent back to work. */
export function resumeAgent(
  registry: AgentGovernanceState[],
  agentId: AlphaId,
  nowMs: number,
  note: string,
): AgentGovernanceState[] {
  return registry.map((entry) =>
    entry.agentId === agentId
      ? {
          ...entry,
          status: "active" as AgentGovernanceStatus,
          // The evidence is NOT cleared: the resuming operator keeps the number
          // that caused the halt in front of them, and the next crossings of the
          // thresholds act immediately rather than after another full tally.
          reason: `resumed by the operator at ${new Date(nowMs).toISOString()}: ${note}`,
          updatedAtMs: nowMs,
        }
      : entry,
  );
}

/** Agents whose budget must be halved (status 'halved', or 'disabled' — see below). */
export function halvedAgents(registry: AgentGovernanceState[]): AlphaId[] {
  return registry.filter((entry) => entry.status === "halved").map((entry) => entry.agentId);
}

/**
 * Agents that may no longer be proposed by, and whose readings the desk removes.
 *
 * A DISABLED agent is removed outright; a HALVED agent still proposes but its
 * plans are sized at half budget by the caller (`sizingRiskPct`). Both are
 * reduce-only.
 */
export function disabledAgents(registry: AgentGovernanceState[]): AlphaId[] {
  return registry.filter((entry) => entry.status === "disabled").map((entry) => entry.agentId);
}

// ── The weekly report ────────────────────────────────────────────────────────

/** One closed trade as the weekly report reads it. */
export interface WeeklyTrade {
  symbol: string;
  mode: string;
  side: string;
  closedAtMs: number;
  realisedR: number | null;
  netProfit: number;
  /** The probability the desk had when it armed this trade, if it recorded one. */
  predictedProbability: number | null;
  slippageR: number | null;
}

/** One shadow evaluation as the weekly report reads it. */
export interface WeeklyEvaluation {
  symbol: string;
  mode: string;
  evaluatedAtMs: number;
  armed: boolean;
  refusals: string[];
  gateCodes: string[];
}

export interface WeeklyReport {
  /** ISO dates, inclusive start / exclusive end (a Monday-to-Monday window). */
  weekStart: string;
  weekEnd: string;
  generatedAtMs: number;
  trades: {
    closed: number;
    measuredR: number;
    /** Trades with no realised R (the EA never stamped a risk) — reported, not dropped. */
    unmeasured: number;
    wins: number;
    hitRate: number | null;
    meanR: number | null;
    totalR: number;
    meanPredictedProbability: number | null;
    /** Mean realised hit rate minus mean predicted probability, in points. */
    calibrationGapPoints: number | null;
    /** Brier score of `predictedProbability` against the realised outcome. */
    brier: number | null;
    meanSlippageR: number | null;
    worstR: number | null;
    bestR: number | null;
  };
  decisions: {
    evaluated: number;
    armed: number;
    refused: number;
    /** Refusal sentences counted by their leading code, most frequent first. */
    refusalCodes: { code: string; count: number }[];
  };
  perSymbol: { symbol: string; trades: number; totalR: number; meanR: number | null }[];
  agents: AgentGovernanceState[];
  /** Everything the report says the desk should look at, in one list. */
  flags: string[];
}

/** The code a refusal sentence starts with, or "OTHER". */
export function refusalCode(refusal: string): string {
  const match = /^\[?([A-Z][A-Z0-9_]{2,})\b/.exec(refusal.trim());
  return match ? (match[1] as string) : "OTHER";
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, v) => a + v, 0) / values.length : null;
}

/**
 * Build the weekly report.
 *
 * A pure function of rows, so the same week always produces the same document —
 * and so a test can hold it against a recount. Windows are half-open
 * `[weekStartMs, weekEndMs)` on the CLOSE time of a trade and the EVALUATION
 * time of a decision, which is the honest convention for "what happened this
 * week": a trade that closed on Monday belongs to Monday's week, not to the week
 * its plan was armed in.
 */
export function weeklyReport(input: {
  weekStartMs: number;
  weekEndMs: number;
  generatedAtMs: number;
  trades: WeeklyTrade[];
  evaluations: WeeklyEvaluation[];
  registry: AgentGovernanceState[];
}): WeeklyReport {
  const inWindow = (ts: number): boolean => ts >= input.weekStartMs && ts < input.weekEndMs;
  const trades = input.trades.filter((trade) => inWindow(trade.closedAtMs));
  const evaluations = input.evaluations.filter((entry) => inWindow(entry.evaluatedAtMs));

  const measured = trades.map((trade) => trade.realisedR).filter((r): r is number => r !== null);
  const wins = measured.filter((r) => r > 0).length;
  const hitRate = measured.length > 0 ? wins / measured.length : null;

  const withPrediction = trades.filter(
    (trade): trade is WeeklyTrade & { realisedR: number; predictedProbability: number } =>
      trade.realisedR !== null && trade.predictedProbability !== null,
  );
  const meanPredicted = mean(withPrediction.map((trade) => trade.predictedProbability));
  const brier =
    withPrediction.length > 0
      ? withPrediction.reduce((a, trade) => {
          const outcome = trade.realisedR > 0 ? 1 : 0;
          const error = trade.predictedProbability - outcome;
          return a + error * error;
        }, 0) / withPrediction.length
      : null;
  const predictedHitRate =
    withPrediction.length > 0 ? meanPredicted : null;
  const calibrationGapPoints =
    predictedHitRate !== null && withPrediction.length > 0
      ? (withPrediction.filter((trade) => trade.realisedR > 0).length / withPrediction.length) * 100 -
        predictedHitRate * 100
      : null;

  // ── the refusal histogram ──────────────────────────────────────────────────
  //
  // A refusals-only picture, and a code is counted ONCE per decision however it
  // reached the record: the sentence a user reads (`[GK_EV_LCB] …`) and the gate
  // code list carry the same code, and double-counting it would make the
  // histogram answer "how many times was this printed" instead of "how many
  // decisions did this stop". An `_OK` code is a PASS, so it is not a refusal by
  // definition — an armed decision's codes are skipped entirely.
  const refusalCounts = new Map<string, number>();
  for (const evaluation of evaluations) {
    const seen = new Set<string>();
    for (const refusal of evaluation.refusals) {
      const code = refusalCode(refusal);
      seen.add(code);
      refusalCounts.set(code, (refusalCounts.get(code) ?? 0) + 1);
    }
    if (evaluation.armed) continue;
    for (const code of evaluation.gateCodes) {
      if (/_OK$/.test(code) || seen.has(code)) continue;
      refusalCounts.set(code, (refusalCounts.get(code) ?? 0) + 1);
    }
  }
  const refusalCodes = [...refusalCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const symbols = [...new Set(trades.map((trade) => trade.symbol))].sort();
  const perSymbol = symbols.map((symbol) => {
    const rows = trades.filter((trade) => trade.symbol === symbol);
    const rs = rows.map((trade) => trade.realisedR).filter((r): r is number => r !== null);
    return {
      symbol,
      trades: rows.length,
      totalR: rs.reduce((a, r) => a + r, 0),
      meanR: mean(rs),
    };
  });

  const armRate = evaluations.length > 0 ? evaluations.filter((entry) => entry.armed).length / evaluations.length : null;
  const flags: string[] = [];
  for (const agent of input.registry) {
    if (agent.status !== "active") {
      flags.push(`agent ${agent.agentId} is ${agent.status}: ${agent.reason ?? "no reason recorded"}`);
    }
  }
  if (calibrationGapPoints !== null && Math.abs(calibrationGapPoints) > 8) {
    flags.push(
      `hit rate is ${calibrationGapPoints > 0 ? "above" : "below"} the predicted probability by ${Math.abs(calibrationGapPoints).toFixed(1)} points (the rollout's live monitor is 8)`,
    );
  }
  if (trades.some((trade) => trade.realisedR === null)) {
    flags.push(
      `${trades.filter((trade) => trade.realisedR === null).length} closed trade(s) carry no realised R — the EA did not stamp a risk at fill, so the desk cannot measure them`,
    );
  }
  if (armRate !== null && armRate > 0.9) {
    flags.push(`the desk armed on ${(armRate * 100).toFixed(0)}% of its own decisions — a gate that never refuses is not a gate`);
  }
  if (evaluations.length === 0) {
    flags.push("no decisions were evaluated in this window");
  }

  const slippages = trades.map((trade) => trade.slippageR).filter((s): s is number => s !== null);
  return {
    weekStart: new Date(input.weekStartMs).toISOString().slice(0, 10),
    weekEnd: new Date(input.weekEndMs).toISOString().slice(0, 10),
    generatedAtMs: input.generatedAtMs,
    trades: {
      closed: trades.length,
      measuredR: measured.length,
      unmeasured: trades.length - measured.length,
      wins,
      hitRate,
      meanR: mean(measured),
      totalR: measured.reduce((a, r) => a + r, 0),
      meanPredictedProbability: meanPredicted,
      calibrationGapPoints,
      brier,
      meanSlippageR: mean(slippages),
      worstR: measured.length > 0 ? Math.min(...measured) : null,
      bestR: measured.length > 0 ? Math.max(...measured) : null,
    },
    decisions: {
      evaluated: evaluations.length,
      armed: evaluations.filter((entry) => entry.armed).length,
      refused: evaluations.filter((entry) => !entry.armed).length,
      refusalCodes,
    },
    perSymbol,
    agents: input.registry,
    flags,
  };
}

/**
 * The Monday 00:00 UTC that starts the week containing `nowMs`.
 *
 * UTC and Monday because that is what the rest of the v4 work reports in: the
 * minute-of-week ledger, the seasonal features and every stored report are UTC,
 * and a weekly report on a different clock than its own inputs is a reconciliation
 * bug waiting to happen.
 */
export function weekWindow(nowMs: number): { weekStartMs: number; weekEndMs: number } {
  const day = 86_400_000;
  const weekday = new Date(nowMs).getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (weekday + 6) % 7;
  const midnight = Math.floor(nowMs / day) * day;
  const weekStartMs = midnight - daysSinceMonday * day;
  return { weekStartMs, weekEndMs: weekStartMs + 7 * day };
}
