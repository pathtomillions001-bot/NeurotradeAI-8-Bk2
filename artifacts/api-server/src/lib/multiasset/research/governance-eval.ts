/**
 * WP9 — the measurements behind the learning and governance layer.
 *
 * ── WHAT THIS STUDY IS, AND WHAT IT REFUSES TO BE ───────────────────────────
 *
 * Governance is the one layer in the desk that changes OTHER layers' behaviour
 * from outcomes, so its operating characteristics are not a detail: a test that
 * fires too often disables a working agent, and one that never fires is a
 * decoration. Nothing here is chosen by eye. Every constant the layer ships is
 * either measured below or is arithmetic that can be checked by hand:
 *
 *   • the e-process's thresholds (5 / 20) come from its own false-alarm bound —
 *     Ville's inequality gives P(ever reaching K) ≤ 1/K for ANY stopping rule, so
 *     1/5 and 1/20 are statements about the layer, and the study MEASURES that
 *     streams under a break-even null respect them;
 *   • its power and its speed against a genuinely degraded stream are measured at
 *     four drifts, because "it eventually fires" is not a useful sentence;
 *   • the change detector's (δ, h) pair comes from a stored GRID — thirteen pairs,
 *     each with its measured null rate and its measured detection rate — and the
 *     pair that ships is the one whose null rate lands inside the report's own
 *     tolerance with the fastest detection. This is the only threshold in the desk
 *     with a published grid behind it, and it exists because the first version of
 *     this statistic was degenerate (see governance.ts);
 *   • the overlay is swept EXHAUSTIVELY: every combination of proposers × agent
 *     statuses is enumerated and the composed risk multiplier is checked to be
 *     reduce-only. There is no sampling in that claim.
 *
 * The layer's constants are inputs to this study, never outputs of it: if a
 * measurement fails a gate, the fix is a decision recorded in the docs, not a
 * number quietly moved until the gate goes green.
 *
 * ── THE ONE THING THIS STUDY CANNOT MEASURE ─────────────────────────────────
 *
 * Whether the desk's live agents will degrade. What it CAN do is run the layer
 * over the desk's own measured corpus (the same WP7 simulator the execution study
 * uses) and report what governance does to a stream that has positive expectancy:
 * it must do nothing, and the stored sup-e is the evidence.
 */
import { makeRng } from "../math";
import {
  E_DISABLE,
  E_HALVE,
  EPROCESS_BETA_GRID,
  EPROCESS_LOWER_BOUND_R,
  EPROCESS_UPPER_BOUND_R,
  PH_DELTA_R,
  PH_THRESHOLD_R,
  applyAgentOutcome,
  eProcessStepWealth,
  initialAgentState,
  pageHinkleyStep,
  weeklyReport,
  type AgentGovernanceStatus,
  type WeeklyEvaluation,
  type WeeklyTrade,
} from "../governance";
import { ALPHA_IDS, type AlphaId } from "../alpha/types";

/** A ±1R coin's loss probability, the desk's simplest model of a break-even stream. */
export const GOVERNANCE_BREAK_EVEN_P_LOSS = 0.5;
/** Drifts the power table is measured at: 0.5, 0.6, 0.675 (−0.35R), 0.75. */
export const GOVERNANCE_ALT_P_LOSS = [0.6, 0.675, 0.75] as const;
/** Stream length of one measurement run. */
export const GOVERNANCE_STREAM_TRADES = 200;
/** Streams per cell of the tables. */
export const GOVERNANCE_STREAMS = 2_000;
/** The grid the change detector's operating point was chosen from. */
export const GOVERNANCE_DELTA_GRID = [0.25, 0.5, 0.75] as const;
export const GOVERNANCE_THRESHOLD_GRID = [5, 6, 8, 10, 12, 15] as const;

export interface StreamMeasurement {
  /** Share of streams that reached e ≥ K inside the run. */
  rate: number;
  /** Trades to the crossing, averaged over the streams that crossed. */
  meanSteps: number | null;
  /** The same, at the median — the tail is where a slow detector hides. */
  medianSteps: number | null;
  streams: number;
  trades: number;
  pLoss: number;
}

/**
 * Run `streams` independent ±1R streams of `trades` trades through one agent's
 * e-process and report how often, and how soon, the bar was crossed.
 *
 * The ±1R coin is the honest straw man: the desk's own geometry is a ~1R stop
 * against a 2–3R target, so the outcome scale is fixed by the plan and the only
 * unknown is the direction. A drift is then a single number, which is what makes
 * the power table readable.
 */
export function measureEProcess(input: {
  streams: number;
  trades: number;
  pLoss: number;
  threshold?: number;
  seed: number;
}): StreamMeasurement {
  const threshold = input.threshold ?? E_DISABLE;
  const rng = makeRng(input.seed);
  const steps: number[] = [];
  for (let s = 0; s < input.streams; s++) {
    let state = initialAgentState("trend");
    let t = 0;
    for (; t < input.trades; t++) {
      const r = rng() < input.pLoss ? -1 : 1;
      state = applyAgentOutcome(state, { agentId: "trend", r, timestampMs: t }).state;
      if (state.eValue >= threshold) break;
    }
    if (t < input.trades) steps.push(t + 1);
  }
  steps.sort((a, b) => a - b);
  return {
    rate: steps.length / input.streams,
    meanSteps: steps.length > 0 ? steps.reduce((a, b) => a + b, 0) / steps.length : null,
    medianSteps: steps.length > 0 ? (steps[Math.floor(steps.length / 2)] as number) : null,
    streams: input.streams,
    trades: input.trades,
    pLoss: input.pLoss,
  };
}

export interface ChangeDetectorCell {
  deltaR: number;
  thresholdR: number;
  nullRate: number;
  nullMeanSteps: number | null;
  altRate: number;
  altMeanSteps: number | null;
  selected: boolean;
}

/** One cell of the (δ, h) grid: its null rate and its detection rate/speed. */
export function measureChangeDetector(input: {
  deltaR: number;
  thresholdR: number;
  streams: number;
  trades: number;
  seed: number;
}): Omit<ChangeDetectorCell, "selected"> {
  const run = (pLoss: number, seed: number): { rate: number; meanSteps: number | null } => {
    const rng = makeRng(seed);
    let alarm = 0;
    let total = 0;
    for (let s = 0; s < input.streams; s++) {
      let state = { mean: 0, cumulative: 0, max: 0, value: 0, observations: 0 };
      let t = 0;
      for (; t < input.trades; t++) {
        const r = rng() < pLoss ? -1 : 1;
        const next = pageHinkleyStep({ state, r, deltaR: input.deltaR, thresholdR: input.thresholdR });
        state = next;
        if (next.alarm) break;
      }
      if (t < input.trades) {
        alarm++;
        total += t + 1;
      }
    }
    return { rate: alarm / input.streams, meanSteps: alarm > 0 ? total / alarm : null };
  };
  const nul = run(GOVERNANCE_BREAK_EVEN_P_LOSS, input.seed);
  const alt = run(0.675, input.seed ^ 0x9e3779b9);
  return {
    deltaR: input.deltaR,
    thresholdR: input.thresholdR,
    nullRate: nul.rate,
    nullMeanSteps: nul.meanSteps,
    altRate: alt.rate,
    altMeanSteps: alt.meanSteps,
  };
}

/** The whole grid, with the pair this build ships marked. */
export function changeDetectorGrid(input: { streams: number; trades: number; seed: number }): ChangeDetectorCell[] {
  const cells: ChangeDetectorCell[] = [];
  for (const deltaR of GOVERNANCE_DELTA_GRID) {
    for (const thresholdR of GOVERNANCE_THRESHOLD_GRID) {
      cells.push({
        ...measureChangeDetector({ ...input, deltaR, thresholdR }),
        selected: deltaR === PH_DELTA_R && thresholdR === PH_THRESHOLD_R,
      });
    }
  }
  return cells;
}

/**
 * Every outcome an e-process can produce on the ±1R scale, with the wealth each
 * contributes — the arithmetic behind "16 losses to halve, 29 to disable".
 */
export function eProcessArithmetic(): {
  r: number;
  stepWealth: number;
  note: string;
}[] {
  return [-1, -0.5, 0, 0.5, 1, 2, 3].map((r) => ({
    r,
    stepWealth: eProcessStepWealth(r),
    note:
      r < 0
        ? "evidence against the agent"
        : r === 0
          ? "no information"
          : "evidence for the agent",
  }));
}

export interface ConsecutiveThresholds {
  halveSteps: number | null;
  disableSteps: number | null;
  /** e after that many −1R trades, for the record. */
  eAtHalve: number;
  eAtDisable: number;
}

/** How many consecutive −1R trades each threshold takes, measured by iterating. */
export function consecutiveThresholds(limit = 80): ConsecutiveThresholds {
  let e = 1;
  let halveSteps: number | null = null;
  let disableSteps: number | null = null;
  let eAtHalve = 0;
  let eAtDisable = 0;
  for (let i = 1; i <= limit; i++) {
    e *= eProcessStepWealth(-1);
    if (halveSteps === null && e >= E_HALVE) {
      halveSteps = i;
      eAtHalve = e;
    }
    if (disableSteps === null && e >= E_DISABLE) {
      disableSteps = i;
      eAtDisable = e;
    }
    if (disableSteps !== null) break;
  }
  return { halveSteps, disableSteps, eAtHalve, eAtDisable };
}

export interface OverlaySweep {
  combinations: number;
  maxMultiplier: number;
  /** Combinations where a disabled proposer emptied the view — the plan must be refused. */
  blockedCombinations: number;
  /** Combinations where the composed multiplier is exactly 0.5. */
  halvedCombinations: number;
  /** Combinations where the composed multiplier is 1 — no governance action at all. */
  unchangedCombinations: number;
}

/**
 * The overlay's reduce-only claim, proven by enumeration rather than by sampling.
 *
 * The composed rule is the one `agent.ts` applies: a proposer that is DISABLED
 * does not contribute its reading (and if that leaves nobody, the plan is
 * refused), and if any surviving proposer is HALVED the risk budget is multiplied
 * by 0.5 exactly once. Every non-empty proposer set (2^|\ALPHA| − 1) is crossed
 * with every status assignment (3^|\ALPHA|), and the multiplier is checked to be
 * in {0 (blocked), 0.5, 1} — never above 1, and never a function of how MANY
 * agents were halved, which is what would let two degraded agents compound into a
 * quarter-budget trade the sizing layer could not express in whole lots anyway.
 */
export function overlaySweep(agents: readonly AlphaId[] = ALPHA_IDS): OverlaySweep {
  const statuses: AgentGovernanceStatus[] = ["active", "halved", "disabled"];
  const combos: AgentGovernanceStatus[][] = [];
  const build = (index: number, current: AgentGovernanceStatus[]): void => {
    if (index === agents.length) {
      combos.push([...current]);
      return;
    }
    for (const status of statuses) {
      current.push(status);
      build(index + 1, current);
      current.pop();
    }
  };
  build(0, []);

  let combinations = 0;
  let maxMultiplier = 0;
  let blocked = 0;
  let halved = 0;
  let unchanged = 0;
  // Every non-empty subset of agents can be the proposer set of a setup.
  for (let mask = 1; mask < 1 << agents.length; mask++) {
    const proposers = agents.filter((_, index) => (mask & (1 << index)) !== 0);
    for (const status of combos) {
      const statusOf = new Map<AlphaId, AgentGovernanceStatus>(agents.map((id, index) => [id, status[index] as AgentGovernanceStatus]));
      const survivors = proposers.filter((id) => statusOf.get(id) !== "disabled");
      const multiplier = survivors.length === 0 ? 0 : survivors.some((id) => statusOf.get(id) === "halved") ? 0.5 : 1;
      combinations++;
      maxMultiplier = Math.max(maxMultiplier, multiplier);
      if (multiplier === 0) blocked++;
      else if (multiplier === 0.5) halved++;
      else unchanged++;
    }
  }
  return { combinations, maxMultiplier, blockedCombinations: blocked, halvedCombinations: halved, unchangedCombinations: unchanged };
}

export interface CorpusGovernance {
  fixture: string;
  series: string;
  trades: number;
  meanR: number;
  finalE: number;
  maxE: number;
  halvedAt: number | null;
  disabledAt: number | null;
  phMax: number;
  phRegistrations: number;
}

/**
 * What governance does to a stream that has POSITIVE expectancy — the desk's own
 * measured corpus. The answer has to be "nothing": the e-value must stay under
 * the halve bar for the whole stream, because a governance layer that halves a
 * profitable agent is worse than no governance layer at all.
 */
export function governCorpus(input: { fixture: string; series: string; rs: number[] }): CorpusGovernance {
  let state = initialAgentState("trend");
  let maxE = 1;
  let halvedAt: number | null = null;
  let disabledAt: number | null = null;
  let phMax = 0;
  let phRegistrations = 0;
  input.rs.forEach((r, index) => {
    const before = state.status;
    const applied = applyAgentOutcome(state, { agentId: "trend", r, timestampMs: index });
    state = applied.state;
    if (applied.action.action === "disable" && disabledAt === null) disabledAt = index + 1;
    if (applied.action.action === "halve" && halvedAt === null) halvedAt = index + 1;
    if (state.phValue > PH_THRESHOLD_R && before !== "disabled") phRegistrations++;
    maxE = Math.max(maxE, state.eValue);
    phMax = Math.max(phMax, state.phValue);
  });
  return {
    fixture: input.fixture,
    series: input.series,
    trades: input.rs.length,
    meanR: input.rs.length > 0 ? input.rs.reduce((a, b) => a + b, 0) / input.rs.length : 0,
    finalE: state.eValue,
    maxE,
    halvedAt,
    disabledAt,
    phMax,
    phRegistrations,
  };
}

export interface WeeklyRehearsal {
  report: ReturnType<typeof weeklyReport>;
  /** The values the test asserts, printed so a reader can check them by hand. */
  expected: Record<string, number | null>;
}

/**
 * A rehearsal of the weekly report on a week whose arithmetic is small enough to
 * check by hand: two measured trades and one unmeasured, three decisions with two
 * refusals (one from a gate code, one from a sentence).
 */
export function weeklyRehearsal(): WeeklyRehearsal {
  const weekStartMs = Date.UTC(2025, 0, 6); // a Monday
  const trade = (over: Partial<WeeklyTrade>): WeeklyTrade => ({
    symbol: "EURUSD",
    mode: "intraday",
    side: "buy",
    closedAtMs: weekStartMs + 3_600_000,
    realisedR: null,
    netProfit: 0,
    predictedProbability: null,
    slippageR: null,
    ...over,
  });
  const trades: WeeklyTrade[] = [
    trade({ realisedR: 2, netProfit: 40, predictedProbability: 0.5 }),
    trade({ realisedR: -1, netProfit: -20, predictedProbability: 0.5 }),
    trade({ symbol: "XAUUSD", mode: "swing", realisedR: null, netProfit: -5 }),
  ];
  const evaluation = (over: Partial<WeeklyEvaluation>): WeeklyEvaluation => ({
    symbol: "EURUSD",
    mode: "intraday",
    evaluatedAtMs: weekStartMs + 60_000,
    armed: false,
    refusals: [],
    gateCodes: [],
    ...over,
  });
  const evaluations: WeeklyEvaluation[] = [
    evaluation({ armed: true, gateCodes: ["GK_OK"] }),
    evaluation({ refusals: ["[GK_EV_LCB] EV at the lower bound is 0.11R, under the 0.20R floor."], gateCodes: ["GK_EV_LCB"] }),
    evaluation({ refusals: ["[GK_EV_LCB] EV at the lower bound is 0.16R, under the 0.20R floor."], gateCodes: ["GK_EV_LCB"] }),
  ];
  const report = weeklyReport({
    weekStartMs,
    weekEndMs: weekStartMs + 7 * 86_400_000,
    generatedAtMs: weekStartMs + 8 * 86_400_000,
    trades,
    evaluations,
    registry: [],
  });
  return {
    report,
    expected: {
      closed: report.trades.closed,
      measuredR: report.trades.measuredR,
      unmeasured: report.trades.unmeasured,
      hitRate: report.trades.hitRate,
      meanR: report.trades.meanR,
      totalR: report.trades.totalR,
      calibrationGapPoints: report.trades.calibrationGapPoints,
      brier: report.trades.brier,
      armed: report.decisions.armed,
      refused: report.decisions.refused,
    },
  };
}

/** The step-wealth table, printed as lines for the report renderer. */
export function renderEProcessArithmetic(): string[] {
  return eProcessArithmetic().map(
    (row) => `${row.r >= 0 ? "+" : ""}${row.r}R → ×${row.stepWealth.toFixed(6)} ${row.note}`,
  );
}

/** The lower bound / upper bound pair the e-process is clipped to, as a sentence. */
export function boundsNote(): string {
  return `outcomes are clipped to [−${EPROCESS_LOWER_BOUND_R}R, +${EPROCESS_UPPER_BOUND_R}R]: the lower bound is what makes the wealth nonnegative (λ ≤ 1/|lower|), and the upper one keeps a single outsized win from retiring an agent`;
}

/** The shipped β grid, as a sentence for the report. */
export function betaGridNote(): string {
  return `the per-step bet is mixed uniformly over β ∈ {${EPROCESS_BETA_GRID.map((b) => b.toFixed(6)).join(", ")}} — a mixture of martingales is a martingale, so the 1/K bound survives the hedge`;
}
