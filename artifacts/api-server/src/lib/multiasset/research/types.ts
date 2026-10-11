/**
 * Desk v4 research harness — dataset and result contracts (WP2).
 *
 * Everything the harness measures flows through these shapes, so that a report
 * generated from a real broker export and one generated from a synthetic null
 * are directly comparable — which is the whole point: a strategy claim is only
 * meaningful next to the same measurement performed on data with no edge in it.
 */

import type { Bar, SymbolSpec, TradeMode } from "../types";

/**
 * A price dataset the harness can evaluate against.
 *
 * `bars` are M1 BID bars in the broker's own convention, because that is what
 * MetaTrader's history is (MODE_BID by default) and because pretending they are
 * mid prices would silently hand every strategy half the spread on entry.
 *
 * `spreadPointsAt` returns the spread in POINTS at a timestamp. It is a
 * function rather than a parallel array because the sources differ: a CSV with
 * a spread column, a constant from the symbol spec, or a simulated intraday
 * profile should all be able to drive the simulator without first being
 * materialised into an aligned series.
 */
export interface Dataset {
  /** Human-readable origin: a file path, or the generator id and seed. */
  source: string;
  /** Instrument this series belongs to. */
  symbol: string;
  /** M1 bid bars, strictly ascending by timestamp, no gaps renumbered. */
  bars: Bar[];
  /** Spread in points at a timestamp. Must be > 0. */
  spreadPointsAt: (ts: number) => number;
  /** Broker contract specification used for costs, sizing and volume steps. */
  spec: SymbolSpec;
  /**
   * Epoch ms of the session boundary used by `flatBeforeSessionClose`, or null
   * when the dataset has no session structure (synthetic data).
   */
  sessionCloseHourUtc?: number | null;
  /**
   * Provenance of the timestamps: `"utc"` when the export was converted, or the
   * broker's server offset in minutes when it was not. Recorded because a
   * session rule evaluated against the wrong offset is a different rule.
   */
  clock?: { kind: "utc"; } | { kind: "broker"; offsetMinutes: number };
  /** Free-form provenance surfaced in the report (export tool, date, account). */
  notes?: string[];
}

/** One decision the desk made, and what came of it. */
export interface HarnessDecision {
  /** Index into `Dataset.bars` of the last bar the decision could see. */
  barIndex: number;
  ts: number;
  symbol: string;
  mode: TradeMode;
  armed: boolean;
  /** Predicted probability of the trade reaching its primary target. */
  predictedProbability: number | null;
  /** Expected value in R after costs, as the desk reported it. */
  predictedExpectancyR: number | null;
  /** Reward:risk at the expected fill, as the desk reported it. */
  rewardRiskAtFill: number | null;
  /** Quality score and the threshold it was compared against. */
  qualityScore: number;
  qualityThreshold: number;
  /** First rejection reason, when the decision was a no-trade. */
  rejection: string | null;
  /** Cost as a fraction of the risk unit. */
  costR: number | null;
  entryTimeframe: string | null;
  /** The plan, when armed. Kept so a decision can be replayed or audited. */
  plan: {
    id: string;
    side: "buy" | "sell";
    trigger: number;
    triggerType: "break" | "retest" | "market";
    sl: number;
    tp: number;
    lots: number;
    riskPoints: number;
    expiresAt: number;
    /** Present on v4 plans; older plans are replayed with the EA defaults. */
    entryTimeframe?: string;
    costPoints?: number;
    /** The management block, verbatim, so the simulator runs the shipped rules. */
    management: unknown;
    maxSpreadPoints: number;
  } | null;
}

/** The outcome of replaying one armed plan through the executed-policy simulator. */
export interface ReplayResult {
  planId: string;
  /** Did the order fill at all? */
  filled: boolean;
  /** Why not, when it did not: expired, invalidated, or refused at the spread guard. */
  unfilledReason: "expired" | "invalidated" | "spread_guard" | "no_data" | null;
  fillTs: number | null;
  fillPrice: number | null;
  /** Realised R, net of commission. Null when the plan never filled. */
  realisedR: number | null;
  /** Exit classification. */
  exitReason:
    | "take_profit"
    | "stop_loss"
    | "time_stop"
    | "break_even"
    | "trail"
    | "session_flat"
    | "news_flat"
    | "regime_exit"
    | "end_of_data"
    | null;
  exitTs: number | null;
  exitPrice: number | null;
  /** Max adverse / favourable excursion during the trade, in R. */
  maeR: number;
  mfeR: number;
  /** Bars held on the entry timeframe. */
  barsHeld: number;
  /** Management actions the position machine emitted, in order. */
  actions: { ts: number; type: string; detail: string }[];
  /** R contributed by partial exits already banked. */
  bankedR: number;
  /** Cost in R actually charged (commission only; spread sits in the fill). */
  costR: number;
  /** True when the trade would have been profitable gross but not net. */
  costFlipped: boolean;
}

/** Aggregate statistics for one (dataset, mode, configuration) run. */
export interface RunMetrics {
  evaluations: number;
  arms: number;
  fills: number;
  /** arms / evaluations. */
  armRate: number;
  /** fills / arms. */
  fillRate: number;
  trades: number;
  wins: number;
  hitRate: number;
  meanR: number;
  medianR: number;
  totalR: number;
  /** Standard error of `meanR` across trades. */
  meanRStdError: number;
  /** 5% conditional value-at-risk of the R distribution (positive = loss). */
  cvar5R: number;
  maeMeanR: number;
  mfeMeanR: number;
  longestLosingStreak: number;
  maxDrawdownR: number;
  /** Mean realised R of the timed-out / non-target exits, for attribution. */
  costRMean: number;
  /** Brier score of predicted probability vs realised win, when predictions exist. */
  brierScore: number | null;
  brierSkill: number | null;
  /** Calibration bins: predicted vs observed, with counts. */
  reliabilityBins: { predicted: number; observed: number; count: number }[];
  /** Weighted least-squares slope of observed on predicted across the bins. */
  reliabilitySlope: number | null;
  probabilisticSharpe: number;
  deflatedSharpe: number;
  /** Number of configurations the DSR benchmark was deflated for. */
  dsrTrials: number;
}

/** Everything one harness invocation produced. */
export interface RunReport {
  generatedAt: string;
  /** Harness version string, so a stored report can be traced to code. */
  harness: string;
  dataset: string;
  symbol: string;
  mode: TradeMode;
  seed: number;
  bars: number;
  /** The window actually evaluated (after warm-up). */
  evaluatedFrom: number;
  evaluatedTo: number;
  metrics: RunMetrics;
  trades: ReplayResult[];
  /** Decisions, trimmed: keeps rejections without storing every plan twice. */
  decisions: HarnessDecision[];
  notes: string[];
}

/** A group of runs reported together (a gate check across seeds). */
export interface SuiteReport {
  gate: "null" | "positive_control" | "calibration" | "baseline";
  runs: RunReport[];
  /** Gate verdict, when the suite corresponds to one. */
  verdict: {
    passed: boolean;
    checks: { name: string; passed: boolean; observed: number; required: string }[];
  } | null;
}
