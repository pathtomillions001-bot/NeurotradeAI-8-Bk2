/**
 * Research harness — `research:run` (WP2).
 *
 * ── WHY A CLI AND A STORED REPORT ───────────────────────────────────────────
 *
 * "The new version is better" is an opinion. Every claim this project makes
 * about an agent — that it has an edge, that a threshold is right, that a
 * change helped — has to be reproducible from a command and a data file, and
 * has to leave a report behind. That is the whole point of this module.
 *
 *   pnpm --filter @workspace/api-server run research:run -- \
 *     --mode intraday --data ./data/EURUSD_M1.csv --symbol EURUSD \
 *     --server-offset-minutes 180 --seed 1
 *
 * With no broker export to hand, the harness runs on its own generators, which
 * is how the null and positive-control gates are checked:
 *
 *   … research:run --mode intraday --data synthetic:null --runs 12
 *   … research:run --mode intraday --data synthetic:control
 *
 * WHAT IT PRINTS, AND WHAT IT REFUSES TO PRINT:
 *   • the arm rate, the fill rate and the realised R of every configuration —
 *     never a hit rate on its own;
 *   • the null gates (what the strategy must NOT do on structureless data) and
 *     the positive-control gates (what it MUST be able to do on data with a
 *     known edge);
 *   • the calibration reliability slope and Brier skill;
 *   • the assumed contract spec, in full, because a study built on a wrong
 *     tickValue is worthless and looks exactly like one built on a right one;
 *   • the walk-forward split geometry (purge and embargo), so the absence of
 *     leakage is a printed fact rather than a promise.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  generate,
  DEFAULT_GENERATOR_SPEC,
  type GeneratorKind,
  type SyntheticSeries,
  type ThreeRegimeLabel,
} from "./generators";
import { calibrationReport } from "./metrics";
import {
  NULL_ARM_RATE_MAX,
  calibrationGates,
  controlGates,
  legacyDeskStrategy,
  nullGates,
  nullSignificanceRate,
  regimeGatedDeskStrategy,
  runHarness,
  type GateReport,
  type GateResult,
  type HarnessRun,
  type HarnessOptions,
  type RegimeStrategy,
  type RegimeTally,
} from "./harness";
import {
  DEFAULT_REGIME_HMM_CONFIG,
  measureRegimeAccuracy,
  type RegimeAccuracy,
  type RegimeHmmConfig,
  type RegimePermit,
} from "../regime-hmm";
import { ALPHA_IDS, buildAlphaAgents, type AlphaAgent, type AlphaId } from "../alpha";
import { MODE_HORIZON_BARS } from "../confluence";
import {
  META_CALIBRATOR_DEFAULT,
  META_STUDY_FIXTURES,
  META_TARGET_MULTIPLE_R,
  measureMeta,
  metaCalibrationGates,
  metaNullGates,
  summariseMetaRows,
  toSeriesRecord,
  type MetaCalibratorKind,
  type MetaFixtureVerdict,
  type MetaStudyReport,
} from "./meta-eval";
import {
  GK_MC_PATHS,
  GK_MC_STRIDE,
  GK_MC_TRADES_PER_PATH,
  assessGatekeeperSeries,
  gatekeeperNullGates,
  poolGatekeeperHomes,
  poolGatekeeperSeries,
  renderGatekeeperStudy,
  type GatekeeperFixtureAssessment,
  type GatekeeperSeriesAssessment,
  type GatekeeperStudyReport,
} from "./gatekeeper-eval";
import { BH_Q, COST_OVER_SIGMA_MODES, MAX_COST_OVER_HORIZON_SIGMA, MIN_EV_LCB_R } from "../meta/gatekeeper";
import { DAILY_CVAR_MAX_PCT, PORTFOLIO_HEAT_MAX_PCT, PORTFOLIO_MAX_TRADE_RISK_PCT } from "../portfolio-risk";
import {
  EXECUTION_ALLOWANCE_CEILING_MULT,
  EXECUTION_MIN_FILL_RATE,
  EXECUTION_PAIRED_TOLERANCE_R,
  EXECUTION_STRIDE,
  EXECUTION_TIMING_REFUSAL_MAX,
  EXECUTION_WARMUP,
  assessExecutionSeries,
  executionGatesPass,
  summariseExecution,
  type ExecutionSeriesAssessment,
  type GateRow,
} from "./execution-eval";
import {
  PORTFOLIO_CORRELATION_TARGET,
  PORTFOLIO_DD_FLOOR,
  assessPortfolioSeries,
  portfolioGatesPass,
  summarisePortfolio,
  type PortfolioSeriesAssessment,
} from "./portfolio-eval";
import { DEFAULT_ALPHA_CONFIG } from "../alpha/edge";
import { lowerBoundMeanR, tradeStats } from "./metrics";
import {
  alphaDriftlessGates,
  alphaFixtureGates,
  alphaNullGates,
  measureAlpha,
  poolAlphaMeasurements,
  type AlphaGateReport,
  type AlphaMeasurement,
} from "./alpha-eval";
import { alphaStrategy, summariseAlphaLedger, type AlphaLedgerEntry } from "./harness";
import type { SimulatedTrade } from "./executed-policy";
import { loadMt5Bars, resampleBars } from "./loader";
import type { Strategy } from "./harness";
import { specForSymbol } from "./specs";
import { walkForwardSplits } from "./walkforward";
import { MODE_ANALYSIS_TIMEFRAMES, type Bar, type Timeframe, type TradeMode } from "../types";

// ── Arguments ───────────────────────────────────────────────────────────────

interface CliArgs {
  mode: TradeMode;
  data: string;
  symbol: string;
  timeframe: Timeframe;
  serverOffsetMinutes: number;
  seed: number;
  runs: number;
  stride: number;
  bars: number;
  includeTrades: boolean;
  horizonBars: number;
  /** True when the caller set --horizon-bars explicitly. */
  horizonBarsExplicit: boolean;
  warmupBars: number;
  trials: number;
  out: string | null;
  label: string;
  quiet: boolean;
  spec: ReturnType<typeof specForSymbol>;
  specOverrides: Parameters<typeof specForSymbol>[1];
  strategy: StrategyChoice;
  regimeFitBars: number;
  alphas: boolean;
  alphasOnly: AlphaId[];
  alphaSeries: number;
  /** True when the caller set --alpha-series explicitly. */
  alphaSeriesExplicit: boolean;
  alphaBars: number;
  /** Run the WP5 meta-model study instead of a strategy study. */
  meta: boolean;
  metaSeries: number;
  metaSeriesExplicit: boolean;
  metaBars: number;
  metaCalibrator: MetaCalibratorKind;
  /** Run the WP6 gatekeeper study instead of a strategy study. */
  gatekeeper: boolean;
  /** Run the WP7 execution study instead of a strategy study. */
  execution: boolean;
  /** Run the WP8 portfolio study instead of a strategy study. */
  portfolio: boolean;
  /** True when the caller set --stride explicitly. */
  strideExplicit: boolean;
}

/** Which decision layer a study runs. */
export type StrategyChoice = "desk-v3" | "v4-regime" | "v4-regime-shadow";

const USAGE = `research:run — the MT5 Desk v4 research harness

  --mode <scalp|intraday|swing>     trading style to study (default intraday)
  --data <path|synthetic:null|synthetic:control|synthetic:all>
  --symbol <EURUSD>                 default EURUSD
  --timeframe <M1|M5|M15|H1>        analysis frame of the source file (default M1)
  --server-offset-minutes <n>       broker server clock minus UTC (GMT+3 => 180)
  --seed <n>                        master seed (default 1)
  --runs <n>                        independent series, for null studies (default 8)
  --stride <n>                      evaluate every Nth bar (default 5)
  --bars <n>                        bars per synthetic series (default 2400)
  --include-trades                  store every trade in the report (large)
  --horizon-bars <n>                max bars a position may be held (default 30)
  --warmup-bars <n>                 bars before the first decision (default 120)
  --trials <n>                      configurations tried, for the DSR deflation
  --out <path>                      where to write the JSON report
  --label <name>                    report label
  --point --digits --tick-size --tick-value --contract-size
  --volume-min --volume-step --stops-level --spread --commission
  --asset-class <forex|metals|indices|crypto|commodities|futures|stocks|other>
  --strategy <desk-v3|v4-regime|v4-regime-shadow>
                                    desk-v3 (default) is the shipped desk;
                                    v4-regime adds the WP3 regime permission as
                                    a hard veto; v4-regime-shadow measures the
                                    same permission without changing any trade
  --regime-fit-bars <n>             bars the regime HMM is fitted on (default 1000)
  --execution                       run the WP7 execution study instead of a
                                    strategy study: the legacy trigger against a
                                    resting limit on the same geometry, via the
                                    executed-policy simulator, plus the timing
                                    ledger's premise over the same corpus
  --portfolio                       run the WP8 portfolio study instead of a
                                    strategy study: a book with a constructed
                                    correlation, the estimator's recovery of it,
                                    the layer's ceilings on the book's heat and
                                    CVaR, and the drawdown scalar on an equity
                                    path driven by the execution study's trades
  --gatekeeper                      run the WP6 gatekeeper study instead of a
                                    strategy study: the WP5 corpora re-read through
                                    the gate (EV floors, BH q=0.10, cost/sigma_h,
                                    sampled executed-policy Monte Carlo)
  --alphas                          run the WP4 alpha-agent study instead of a
                                    strategy study: every agent is measured on
                                    its own labelled fixture and on the nulls
  --alpha <id,id>                   restrict the study to these agents
  --alpha-series <n>                independent series per fixture (default 4)
  --alpha-bars <n>                  bars per series (default 3000)
  --meta                            run the WP5 meta-model study: triple-barrier
                                    labels, uniqueness weights, cross-fitted
                                    isotonic calibration, purged folds + CPCV,
                                    and p_hat / p_LCB on every out-of-sample row
  --meta-series <n>                 independent series per fixture (default 3)
  --meta-bars <n>                   bars per series (default 2500)
  --meta-calibrator <isotonic|platt>
                                    how the out-of-fold score becomes a
                                    probability (default isotonic; both are
                                    measured by the study's own gates)
  --quiet                           only the verdict line
`;

export function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, "true");
      continue;
    }
    flags.set(key, next);
    i++;
  }
  const num = (key: string, fallback: number): number => {
    const raw = flags.get(key);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const mode = (flags.get("mode") ?? "intraday") as TradeMode;
  if (mode !== "scalp" && mode !== "intraday" && mode !== "swing") {
    throw new Error(`--mode must be scalp, intraday or swing (got "${String(flags.get("mode"))}")`);
  }
  const specOverrides: Parameters<typeof specForSymbol>[1] = {};
  const opt = <K extends keyof NonNullable<Parameters<typeof specForSymbol>[1]>>(key: K, flag: string): void => {
    if (flags.has(flag)) specOverrides[key] = flags.get(flag) as never;
  };
  if (flags.has("point")) specOverrides.point = num("point", 0.00001);
  if (flags.has("digits")) specOverrides.digits = num("digits", 5);
  if (flags.has("tick-size")) specOverrides.tickSize = num("tick-size", 0.00001);
  if (flags.has("tick-value")) specOverrides.tickValue = num("tick-value", 1);
  if (flags.has("contract-size")) specOverrides.contractSize = num("contract-size", 100_000);
  if (flags.has("volume-min")) specOverrides.volumeMin = num("volume-min", 0.01);
  if (flags.has("volume-step")) specOverrides.volumeStep = num("volume-step", 0.01);
  if (flags.has("stops-level")) specOverrides.stopsLevel = num("stops-level", 0);
  if (flags.has("freeze-level")) specOverrides.freezeLevel = num("freeze-level", 0);
  if (flags.has("spread")) specOverrides.spreadPoints = num("spread", 12);
  if (flags.has("commission")) specOverrides.commissionPerLot = num("commission", 0);
  if (flags.has("asset-class")) opt("assetClass", "asset-class");

  const symbol = flags.get("symbol") ?? "EURUSD";
  const strategy = (flags.get("strategy") ?? "desk-v3") as StrategyChoice;
  if (!["desk-v3", "v4-regime", "v4-regime-shadow"].includes(strategy)) {
    throw new Error(`--strategy must be desk-v3, v4-regime or v4-regime-shadow (got "${String(flags.get("strategy"))}")`);
  }
  const alphasOnly = (flags.get("alpha") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is AlphaId => (ALPHA_IDS as readonly string[]).includes(entry));
  return {
    strategy,
    alphas: flags.has("alphas"),
    alphasOnly,
    alphaSeries: Math.max(1, Math.floor(num("alpha-series", 4))),
    alphaSeriesExplicit: flags.has("alpha-series"),
    alphaBars: Math.max(1200, Math.floor(num("alpha-bars", 3000))),
    meta: flags.has("meta"),
    metaSeries: Math.max(1, Math.floor(num("meta-series", 3))),
    metaSeriesExplicit: flags.has("meta-series"),
    metaBars: Math.max(1200, Math.floor(num("meta-bars", 2500))),
    metaCalibrator: (flags.get("meta-calibrator") ?? META_CALIBRATOR_DEFAULT) as MetaCalibratorKind,
    gatekeeper: flags.has("gatekeeper"),
    execution: flags.has("execution"),
    portfolio: flags.has("portfolio"),
    regimeFitBars: Math.max(200, Math.floor(num("regime-fit-bars", DEFAULT_REGIME_HMM_CONFIG.fitBars))),
    mode,
    data: flags.get("data") ?? "synthetic:all",
    symbol,
    timeframe: (flags.get("timeframe") ?? "M1") as Timeframe,
    serverOffsetMinutes: num("server-offset-minutes", 0),
    seed: num("seed", 1),
    runs: Math.max(1, Math.floor(num("runs", 8))),
    stride: Math.max(1, Math.floor(num("stride", 5))),
    strideExplicit: flags.has("stride"),
    bars: Math.max(300, Math.floor(num("bars", 2400))),
    includeTrades: flags.get("include-trades") === "true",
    horizonBars: Math.max(5, Math.floor(num("horizon-bars", 30))),
    horizonBarsExplicit: flags.has("horizon-bars"),
    warmupBars: Math.max(60, Math.floor(num("warmup-bars", 120))),
    trials: Math.max(1, Math.floor(num("trials", 1))),
    out: flags.get("out") ?? null,
    label: flags.get("label") ?? "baseline",
    quiet: flags.get("quiet") === "true",
    spec: specForSymbol(symbol, specOverrides),
    specOverrides,
  };
}

// ── Series assembly ─────────────────────────────────────────────────────────

/**
 * The frames a mode analyses, as the live desk analyses them.
 *
 * The desk scores every frame in its own band (MODE_ANALYSIS_TIMEFRAMES) and
 * places the stop on the nearest one with enough history. The harness builds
 * the same band from the source file, so a study measures the pipeline the
 * desk runs — not a simplified one. Frames slower than the source are
 * resampled from it; frames FASTER than it are simply absent (the terminal
 * never sent those bars, and inventing them would be fabrication).
 */
export function framesForMode(mode: TradeMode, source: Bar[], sourceFrame: Timeframe): Partial<Record<Timeframe, Bar[]>> {
  const out: Partial<Record<Timeframe, Bar[]>> = {};
  const sourceMinutes = frameMinutes(sourceFrame);
  for (const frame of MODE_ANALYSIS_TIMEFRAMES[mode]) {
    if (frameMinutes(frame) < sourceMinutes) continue;
    const bars = frameMinutes(frame) === sourceMinutes ? source : resampleBars(source, frame);
    if (bars.length >= 30) out[frame] = bars;
  }
  // Always include the source frame itself as a fallback: a mode whose band is
  // entirely faster than the file (a scalp study on M5 data) still gets a
  // series rather than a silent zero-arm result.
  if (Object.keys(out).length === 0) out[sourceFrame] = source;
  return out;
}

function frameMinutes(frame: Timeframe): number {
  const table: Partial<Record<Timeframe, number>> = {
    S10: 10 / 60,
    S30: 0.5,
    M1: 1,
    M2: 2,
    M3: 3,
    M5: 5,
    M15: 15,
    M30: 30,
    H1: 60,
    H4: 240,
    D1: 1440,
    W1: 10_080,
  };
  return table[frame] ?? 1;
}

/**
 * Synthetic data for the gates, generated on the FASTEST frame of the mode's
 * band and aggregated up from there.
 *
 * The base frame matters: generating 15-minute bars and then telling the frame
 * builder they are M1 minute bars re-aggregates them into 75-minute and
 * 3.75-hour monstrosities, and the desk is then measured on a series that is
 * not the one the control claims to be. Generate at the band's fastest frame
 * (S10 / M5 / H1), aggregate the rest from it, and every frame in the band is a
 * genuine aggregation of one underlying path.
 */
export const SYNTHETIC_BASE_FRAME: Record<TradeMode, Timeframe> = {
  scalp: "S10",
  intraday: "M5",
  swing: "H1",
};

export function syntheticSeriesForMode(mode: TradeMode, kind: GeneratorKind, seed: number, bars: number): SyntheticSeries {
  const frame = SYNTHETIC_BASE_FRAME[mode];
  return generate(kind, {
    ...DEFAULT_GENERATOR_SPEC,
    bars,
    timeframeMs: frameMinutes(frame) * 60_000,
    // Per-bar volatility scaled so a bar of each mode's band carries a similar
    // amount of information: 10 s and 1 h bars cannot both use 8 bp.
    volatility: mode === "scalp" ? 0.00035 : mode === "intraday" ? 0.0008 : 0.0016,
    seed,
  });
}

// ── The study ───────────────────────────────────────────────────────────────

/** One run's numbers, without shipping every trade to the report file. */
export interface RunSummary {
  strategy: string;
  evaluations: number;
  arms: number;
  armRate: number;
  fills: number;
  fillRate: number;
  stats: HarnessRun["stats"];
  lowerBoundMeanR: number;
  dsr: number;
  meanPredicted: number;
  predictedVsRealised: number;
  /** Realised R per trade, bucketed in 0.25R steps from −3R to +8R. */
  rHistogram: { bucket: string; count: number }[];
  exitReasons: Record<string, number>;
  partialsFired: number;
  /** Only present with --include-trades. */
  trades?: SimulatedTrade[];
}

export function summariseRun(run: HarnessRun, includeTrades: boolean): RunSummary {
  const buckets = new Map<string, number>();
  const exits: Record<string, number> = {};
  let partials = 0;
  for (const trade of run.trades) {
    const bucket = Math.max(-3, Math.min(8, Math.floor(trade.r / 0.25) * 0.25));
    const label = `${bucket.toFixed(2)}R`;
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
    exits[trade.exitReason] = (exits[trade.exitReason] ?? 0) + 1;
    partials += trade.partialFills;
  }
  const rHistogram = [...buckets.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => Number.parseFloat(a.bucket) - Number.parseFloat(b.bucket));
  return {
    strategy: run.strategy,
    evaluations: run.evaluations,
    arms: run.arms,
    armRate: run.armRate,
    fills: run.fills,
    fillRate: run.fillRate,
    stats: run.stats,
    lowerBoundMeanR: run.lowerBoundMeanR,
    dsr: run.dsr,
    meanPredicted: run.meanPredicted,
    predictedVsRealised: run.predictedVsRealised,
    rHistogram,
    exitReasons: exits,
    partialsFired: partials,
    ...(includeTrades ? { trades: run.trades } : {}),
  };
}

export interface StudyReport {
  label: string;
  generatedAt: string;
  command: string;
  mode: TradeMode;
  symbol: string;
  seed: number;
  contractSpec: Record<string, unknown>;
  assumedSpecValues: string[];
  dataSource: string;
  seriesKind: string;
  barsPerRun: number;
  timeframe: Timeframe;
  walkForward: { splits: number; purgeBars: number; embargoBars: number; clean: boolean };
  runs: RunSummary[];
  gates: Record<string, GateReport & { runs?: number }>;
  verdict: "pass" | "fail";
  notes: string[];
  /**
   * The WP3 regime layer, when the study ran it: accuracy against the
   * generator's own labels (the gate), and what the permission did to the
   * trades.
   */
  regime: {
    accuracy: { series: string; accuracy: RegimeAccuracy }[];
    tallies: { strategy: string; series: string; tally: RegimeTally }[];
  } | null;
  /** Held-out calibration for the configuration, when enough trades exist. */
  calibration: ReturnType<typeof calibrationReport> | null;
}

/** WP3's acceptance criterion, in one place. */
export const REGIME_ACCURACY_MIN = 0.8;

export function runStudy(args: CliArgs): StudyReport {
  const notes: string[] = [];
  const barsPerRun = args.bars;
  const seriesList: {
    label: string;
    bars: Bar[];
    kind: GeneratorKind | "real";
    frame: Timeframe;
    regimeLabels?: ThreeRegimeLabel[];
  }[] = [];

  if (args.data.startsWith("synthetic:")) {
    const which = args.data.slice("synthetic:".length);
    const kinds: GeneratorKind[] =
      which === "all"
        ? ["driftless", "block-shuffled", "phase-randomised", "positive-control"]
        : which === "null"
          ? ["driftless", "block-shuffled", "phase-randomised"]
          : which === "control"
            ? ["positive-control"]
            : [which as GeneratorKind];
    for (const kind of kinds) {
      const count = kind === "positive-control" ? 1 : args.runs;
      for (let r = 0; r < count; r++) {
        const series = syntheticSeriesForMode(args.mode, kind, args.seed + r * 1013, barsPerRun);
        seriesList.push({
          label: `${kind}#${r + 1}`,
          bars: series.bars,
          kind,
          frame: SYNTHETIC_BASE_FRAME[args.mode],
          ...(series.regimeLabels ? { regimeLabels: series.regimeLabels } : {}),
        });
      }
    }
  } else {
    const path = resolve(args.data);
    const text = readFileSync(path, "utf8");
    const loaded = loadMt5Bars(text, {
      symbol: args.symbol,
      timeframe: args.timeframe,
      serverUtcOffsetMinutes: args.serverOffsetMinutes,
    });
    notes.push(...loaded.warnings);
    if (!text.length) notes.push("the data file is empty");
    seriesList.push({ label: path, bars: loaded.bars, kind: "real", frame: args.timeframe });
    notes.push(
      args.serverOffsetMinutes === 0 && !args.data.startsWith("synthetic:")
        ? "┌ NO SERVER OFFSET GIVEN (--server-offset-minutes 0): if the broker's server clock is not UTC, every \
session boundary, session-close flatten and news window in this study is shifted. Re-run with the real offset \
before believing anything below."
        : `timestamps shifted by ${args.serverOffsetMinutes} min from server time to UTC`,
    );
  }

  const runs: HarnessRun[] = [];
  let calibrationSamples: { p: number; outcome: 0 | 1 }[] = [];
  const regimeConfig: Partial<RegimeHmmConfig> = { fitBars: args.regimeFitBars };
  const regimeTallies: { strategy: string; series: string; tally: RegimeTally }[] = [];
  const regimeAccuracy: { series: string; accuracy: RegimeAccuracy }[] = [];

  for (const entry of seriesList) {
    const options: HarnessOptions = {
      spec: args.spec.spec,
      mode: args.mode,
      stride: args.stride,
      horizonBars: args.horizonBars,
      warmupBars: args.warmupBars,
      trials: args.trials,
    };
    const frames = framesForMode(args.mode, entry.bars, entry.frame);
    // One memo per series: the veto and shadow variants answer the same
    // question at the same bar, and a study must not pay for two EM fits — nor
    // report two different answers to one question.
    const memo = new Map<string, RegimePermit>();
    const baseline = legacyDeskStrategy(`desk-v3 (${entry.kind})`);
    const gated: RegimeStrategy[] =
      args.strategy === "desk-v3"
        ? []
        : [
            regimeGatedDeskStrategy({
              veto: true,
              id: `v4-regime (${entry.kind})`,
              config: regimeConfig,
              memo,
            }),
            regimeGatedDeskStrategy({
              veto: false,
              id: `v4-regime-shadow (${entry.kind})`,
              config: regimeConfig,
              memo,
            }),
          ];
    for (const strategy of [baseline, ...gated] as Strategy[]) {
      const run = runHarness({ frames, symbol: args.symbol, strategy, options });
      runs.push(run);
    }
    for (const strategy of gated) {
      regimeTallies.push({ strategy: strategy.id, series: entry.label, tally: strategy.tally });
    }
    const baselineRun = runs[runs.length - 1 - gated.length] as HarnessRun;
    if (entry.kind === "real" || entry.kind === "positive-control") {
      calibrationSamples = calibrationSamples.concat(heldOutCalibration(baselineRun));
    }
    if (entry.regimeLabels) {
      // The accuracy gate is measured on the SAME bars the strategy read: the
      // series' own fastest frame.
      regimeAccuracy.push({
        series: entry.label,
        accuracy: measureRegimeAccuracy(entry.bars, entry.regimeLabels as string[], regimeConfig),
      });
    }
  }

  // Gates are measured on the BASELINE strategy only in a multi-strategy study:
  // mixing a gated run into the null arm rate would compare a filter against
  // the thing it filters.
  const baselineRuns = runs.filter((r) => r.strategy.startsWith("desk-v3"));
  const nullRuns = baselineRuns.filter((r) => r.strategy.includes("driftless") || r.strategy.includes("block-shuffled") || r.strategy.includes("phase-randomised"));
  const controlRuns = baselineRuns.filter((r) => r.strategy.includes("positive-control"));

  const meanCostR = 0.05; // the desk's own MIN_COST_COVERAGE floor, in R
  const gates: Record<string, GateReport & { runs?: number }> = {};
  if (nullRuns.length > 0) gates["null"] = nullFamilyGates(nullRuns, meanCostR);
  // The same null gates for the WP3-gated strategy. This is an ADDED gate: the
  // regime permission either reduces the structureless arm rate or it does not
  // earn its milliseconds — and "it feels safer" is not a measurement.
  const gatedNullRuns = runs.filter(
    (r) =>
      r.strategy.startsWith("v4-regime (") &&
      (r.strategy.includes("driftless") || r.strategy.includes("block-shuffled") || r.strategy.includes("phase-randomised")),
  );
  if (gatedNullRuns.length > 0) gates["null:v4-regime"] = nullFamilyGates(gatedNullRuns, meanCostR);
  if (controlRuns.length > 0) {
    const control = controlGates(controlRuns[0] as HarnessRun);
    gates["control"] = { ...control, runs: controlRuns.length };
  }
  const calibration = calibrationSamples.length > 0 ? calibrationReport(calibrationSamples) : null;
  if (calibration) gates["calibration"] = calibrationGates(calibration);
  if (regimeAccuracy.length > 0) {
    const worst = regimeAccuracy.reduce((a, b) => (a.accuracy.causal <= b.accuracy.causal ? a : b));
    gates["regime"] = {
      runs: regimeAccuracy.length,
      pass: worst.accuracy.causal >= REGIME_ACCURACY_MIN,
      gates: [
        {
          gate: "regime: causal accuracy ≥ 80% on labelled 3-regime data",
          pass: worst.accuracy.causal >= REGIME_ACCURACY_MIN,
          measured: worst.accuracy.causal,
          threshold: REGIME_ACCURACY_MIN,
          detail:
            `worst of ${regimeAccuracy.length} series: ${(worst.accuracy.causal * 100).toFixed(1)}% causal ` +
            `(Wilson 95% LCB ${(worst.accuracy.causalLowerBound * 100).toFixed(1)}%) on ${worst.accuracy.samples} held-out bars; ` +
            `supervised ceiling for the same series ${(worst.accuracy.ceiling * 100).toFixed(1)}%`,
        },
        {
          gate: "regime: the detector is within 10 points of the supervised ceiling",
          pass: worst.accuracy.ceiling - worst.accuracy.causal <= 0.1,
          measured: worst.accuracy.ceiling - worst.accuracy.causal,
          threshold: 0.1,
          detail:
            `a gap wider than this means the fit failed, not the data: fitted ${(worst.accuracy.causal * 100).toFixed(1)}% ` +
            `vs ceiling ${(worst.accuracy.ceiling * 100).toFixed(1)}% on ${worst.series}`,
        },
      ],
    };
    notes.push(
      `Regime accuracy is measured causally (the filtered posterior, forward pass only) against the generator's own ` +
        `labels on the held-out second half of each series, with the state→label mapping learned on the first half.`,
    );
  }

  const wf = walkForwardSplits(
    (seriesList[0]?.bars.length ?? barsPerRun),
    { trainBars: 600, testBars: 200, purgeBars: 50, embargoBars: 6 },
  );

  const verdict: "pass" | "fail" = Object.values(gates).every((g) => g.pass) ? "pass" : "fail";
  notes.push(
    "The harness studies the DECISION and its EXECUTION (the real position-manager state machine). Portfolio-level " +
      "limits — daily loss, drawdown scalar, correlation heat — are governed live by risk.ts and portfolio-risk.ts and are " +
      "not re-simulated here beyond the consecutive-loss state carried across trades.",
  );
  notes.push(
    "Calibration is reported on trades whose decision fell in the last two thirds of each series (quasi-held-out). A " +
      "fitted model's calibration (WP5) is reported from the walk-forward test windows instead.",
  );
  if (args.data.startsWith("synthetic:three-regime")) {
    notes.push(
      "This is a REGIME-DETECTOR study: the labelled three-regime series has known states, and the gate here is the " +
        "accuracy of the causal posterior against those labels. The probability-calibration gates are deliberately " +
        "absent (the labelled series is not a probability study) — they are measured on synthetic:control and on real " +
        "data, and the legacy desk FAILS them in both WP2 baselines (research-reports/baseline-*.json).",
    );
    notes.push(
      "The v4-regime-shadow row must have EXACTLY the trades of the desk-v3 row: it observes the permission without " +
        "acting on it. The inner desk's arm count can still differ between the veto and shadow rows, because a vetoed " +
        "trade leaves no outcome to feed back into the desk's risk state (loss ladder, cooldown, consecutive-loss " +
        "backstop) — that feedback is part of the live desk and is not switched off for the study.",
    );
  }

  return {
    runs: runs.map((run) => summariseRun(run, args.includeTrades)),
    label: args.label,
    generatedAt: new Date().toISOString(),
    command: process.argv.join(" "),
    mode: args.mode,
    symbol: args.symbol,
    seed: args.seed,
    contractSpec: args.spec.spec as unknown as Record<string, unknown>,
    assumedSpecValues: args.spec.assumed,
    dataSource: args.data,
    seriesKind: seriesList.map((s) => s.kind).join(","),
    // For real data this is the length of the file; for synthetic runs it is
    // the requested bar count.
    barsPerRun: seriesList[0]?.bars.length ?? barsPerRun,
    timeframe: args.timeframe,
    walkForward: { splits: wf.length, purgeBars: 50, embargoBars: 6, clean: wf.every((s) => s.trainEnd <= s.testStart) },
    gates,
    verdict,
    notes,
    calibration,
    regime:
      regimeAccuracy.length > 0 || regimeTallies.length > 0
        ? { accuracy: regimeAccuracy, tallies: regimeTallies }
        : null,
  };
}

/**
 * The null gates for one family of runs: no structureless series may tempt it.
 *
 * Every reading is the WORST series in the family, and the detail names it. A
 * family must not be able to pass by averaging a bad series against a good one,
 * and a reader must be able to see which series produced a failure — an earlier
 * version of this function reported the first series' number next to another
 * series' verdict, which is exactly the kind of report that lies quietly.
 */
function nullFamilyGates(runs: HarnessRun[], meanCostR: number): GateReport & { runs: number } {
  const evaluations = runs.reduce((a, r) => a + r.evaluations, 0);
  const arms = runs.reduce((a, r) => a + r.arms, 0);
  const highest = (pick: (run: HarnessRun) => number): HarnessRun => runs.reduce((a, b) => (pick(b) > pick(a) ? b : a));
  const worstArm = highest((r) => r.armRate);
  const worstDsr = highest((r) => r.dsr);
  const traded = runs.filter((r) => r.stats.trades > 0);
  const worstMean =
    traded.length > 0 ? traded.reduce((a, b) => (b.stats.meanR < a.stats.meanR ? b : a)) : null;
  const significance = nullSignificanceRate(runs);
  const aggregateArmRate = arms / Math.max(1, evaluations);
  const gates: GateResult[] = [
    {
      gate: "null: arm rate ≤ 3%",
      pass: worstArm.armRate <= NULL_ARM_RATE_MAX + 1e-12,
      measured: worstArm.armRate,
      threshold: NULL_ARM_RATE_MAX,
      detail: `${worstArm.arms} arms in ${worstArm.evaluations} evaluations — worst of ${runs.length} structureless series (${worstArm.strategy})`,
    },
    {
      gate: "null: mean realised R ≥ −(cost+0.05)",
      pass: worstMean === null || worstMean.stats.meanR >= -(meanCostR + 0.05) - 1e-9,
      measured: worstMean ? worstMean.stats.meanR : 0,
      threshold: -(meanCostR + 0.05),
      detail: worstMean
        ? `${worstMean.stats.trades} realised trades at mean ${worstMean.stats.meanR.toFixed(3)}R — worst series (${worstMean.strategy})`
        : "no trades were taken on any structureless series",
    },
    {
      gate: "null: DSR not significant",
      pass: worstDsr.dsr < 0.95,
      measured: worstDsr.dsr,
      threshold: 0.95,
      detail: `Deflated Sharpe probability ${(worstDsr.dsr * 100).toFixed(1)}% — worst series (${worstDsr.strategy})`,
    },
    {
      gate: "null: ≤ 5% of runs DSR-significant",
      pass: significance <= 0.05 + 1e-12,
      measured: significance,
      threshold: 0.05,
      detail: `${(significance * 100).toFixed(1)}% of ${runs.length} structureless runs looked profitable at DSR ≥ 0.95`,
    },
    {
      gate: "null: aggregate arm rate ≤ 3%",
      pass: aggregateArmRate <= NULL_ARM_RATE_MAX + 1e-12,
      measured: aggregateArmRate,
      threshold: NULL_ARM_RATE_MAX,
      detail: `${arms} arms in ${evaluations} evaluations over ${runs.length} structureless series`,
    },
  ];
  return { pass: gates.every((g) => g.pass), gates, runs: runs.length };
}

/**
 * Held-out calibration: only trades decided in the last two thirds of the
 * series, so the numbers are not the ones the strategy was selected on.
 */
function heldOutCalibration(run: HarnessRun): { p: number; outcome: 0 | 1 }[] {
  const decisions = run.trades.map((t) => t.decisionIndex);
  if (decisions.length === 0) return [];
  const maxIndex = Math.max(...decisions);
  const cut = maxIndex / 3;
  return run.trades
    .filter((t) => t.decisionIndex >= cut && t.predictedProbability !== undefined && t.predictedProbability > 0)
    .map((t) => ({ p: t.predictedProbability as number, outcome: (t.r > 0 ? 1 : 0) as 0 | 1 }));
}

// ── The WP4 alpha study ─────────────────────────────────────────────────────

/**
 * The fixtures each agent is measured on.
 *
 * `home` is the fixture that expresses the agent's CLAIM — the market structure
 * it says it can trade — and it is the fixture its edge gate runs on. Every agent
 * is also measured on every other fixture, because a detector that "works"
 * everywhere is measuring something other than the structure it claims, and the
 * cross-table is where that shows.
 *
 * The three nulls are the OTHER half of the gate. `phase-randomised` is the
 * strictest of them (it preserves linear structure), which is why it carries the
 * most series.
 */
export interface AlphaFixture {
  name: string;
  kind: GeneratorKind;
  series: number;
  bars: number;
  spec?: Record<string, number>;
  home?: AlphaId[];
  null?: boolean;
  note: string;
}

export const ALPHA_STUDY_FIXTURES: AlphaFixture[] = [
  { name: "trend-control", kind: "positive-control", series: 4, bars: 3000, home: ["trend"],
    note: "regime-switching drift + AR(1) residual: the desk's own positive control, and the fixture the trend claim is about" },
  { name: "mean-reverting", kind: "mean-reverting", series: 5, bars: 3000, spec: { meanReversionHalfLife: 16 },
    home: ["mean-reversion"],
    note: "OU around a level with a 16-bar half-life: the structure a fade is supposed to trade" },
  { name: "sweep-rich", kind: "mean-reverting", series: 5, bars: 3000,
    spec: { meanReversionHalfLife: 16, jumpProbability: 0.01, jumpSigma: 6 }, home: ["liquidity-sweep"],
    note: "the same level plus a raid every ~100 bars that is absorbed: sweep-rich on purpose, because a setup that happens twice a series cannot be measured" },
  { name: "vol-clustered", kind: "vol-clustered", series: 4, bars: 3000, home: ["vol-regime"],
    note: "GARCH(1,1): quiet stretches and shock clusters, the one property of real returns no null generator has" },
  { name: "seasonal", kind: "seasonal", series: 4, bars: 3000, home: ["seasonality"],
    note: "a drift that depends only on the UTC hour: clock structure and nothing else" },
  { name: "regime-labelled", kind: "three-regime", series: 3, bars: 3000, home: [],
    note: "the WP3 labelled control: bull/bear/range, useful for the trend agent's direction rather than its probability" },
  { name: "null-driftless", kind: "driftless", series: 4, bars: 3000, null: true,
    note: "driftless random walk: no structure of any kind" },
  { name: "null-phase", kind: "phase-randomised", series: 6, bars: 3000, null: true,
    note: "phase-randomised: linear structure survives, non-linear does not — the strictest null" },
  { name: "null-shuffled", kind: "block-shuffled", series: 4, bars: 3000, null: true,
    note: "block-shuffled returns: the marginal distribution kept exactly, every temporal dependence destroyed" },
];

export interface AlphaPaperLeg {
  summary: RunSummary;
  ledger: Record<string, number>;
  /** Decisions the paper leg walked through. */
  decisions: number;
}

export interface AlphaAgentVerdict {
  agent: AlphaId;
  label: string;
  /** The fixture its claim was measured on. */
  home: string;
  fixture: AlphaMeasurement;
  null: AlphaMeasurement;
  fixtureGates: AlphaGateReport;
  nullGates: AlphaGateReport;
  /** The brief's selectivity gate, measured on the driftless fixture alone. */
  driftless: AlphaMeasurement;
  driftlessGates: AlphaGateReport;
  /** Every fixture the agent was measured on, for the cross-table. */
  all: AlphaMeasurement[];
  /** Paper trading: the executed-policy leg on its home fixture + the null. */
  paper: { fixture: AlphaPaperLeg; null: AlphaPaperLeg } | null;
  verdict: "enabled" | "disabled";
  reason: string;
}

export interface AlphaStudyReport {
  label: string;
  generatedAt: string;
  command: string;
  mode: TradeMode;
  symbol: string;
  seed: number;
  dataSource: string;
  barsPerSeries: number;
  stride: number;
  contractSpec: Record<string, unknown>;
  assumedSpecValues: string[];
  fixtures: { name: string; kind: string; series: number; bars: number; note: string }[];
  agents: AlphaAgentVerdict[];
  /** Agents whose gates all passed — the only ones that may be wired in. */
  allowlist: AlphaId[];
  verdict: "pass" | "fail";
  notes: string[];
}

/** How many agents' measurements are kept in the report (all of them). */
export function runAlphaStudy(args: CliArgs): AlphaStudyReport {
  const notes: string[] = [];
  const agents = buildAlphaAgents();
  const ids: AlphaId[] = args.alphasOnly.length > 0 ? args.alphasOnly : [...ALPHA_IDS];
  // `--alpha-series` overrides every fixture uniformly. Uniformly on purpose: a
  // flag that gave one agent's fixture more series than another's would be a
  // knob that changes which agent passes, which is not a knob a study should have.
  const fixtures = ALPHA_STUDY_FIXTURES.map((fixture) => ({
    ...fixture,
    series: args.alphaSeriesExplicit ? args.alphaSeries : fixture.series,
    bars: args.alphaBars,
  }));
  const frame = SYNTHETIC_BASE_FRAME[args.mode];
  const frameWidth = frameMinutes(frame) * 60_000;

  // One pass: measure every requested agent on every series of every fixture.
  const measurements = new Map<string, AlphaMeasurement[]>(); // `${agent}|${fixture}`
  const homeBars = new Map<string, { bars: Bar[]; fixture: AlphaFixture; label: string }[]>();
  for (const fixture of fixtures) {
    const seriesBars: { bars: Bar[]; fixture: AlphaFixture; label: string }[] = [];
    for (let r = 0; r < fixture.series; r++) {
      const series = generate(fixture.kind, {
        ...DEFAULT_GENERATOR_SPEC,
        seed: args.seed + r * 1013,
        bars: fixture.bars,
        timeframeMs: frameWidth,
        volatility: args.mode === "scalp" ? 0.00035 : args.mode === "intraday" ? 0.0008 : 0.0016,
        ...(fixture.spec ?? {}),
      });
      seriesBars.push({ bars: series.bars, fixture, label: `${fixture.name}#${r + 1}` });
    }
    for (const id of ids) {
      const collected: AlphaMeasurement[] = [];
      for (const entry of seriesBars) {
        collected.push(
          measureAlpha({
            agent: agents[id],
            bars: entry.bars,
            frame,
            symbol: args.symbol,
            spec: args.spec.spec,
            mode: args.mode,
            series: entry.label,
            kind: fixture.kind,
            stride: Math.max(1, Math.min(args.stride, 3)),
            // A series must be long enough for the agent to have seen the setup
            // before it can say anything about it; the default is its own floor.
            warmupBars: Math.max(120, agents[id].minBars),
            frameWidthMs: frameWidth,
          }),
        );
      }
      measurements.set(`${id}|${fixture.name}`, collected);
      if (fixture.home?.includes(id)) homeBars.set(id, seriesBars);
    }
  }

  const nullFixtures = fixtures.filter((f) => f.null);
  const verdicts: AlphaAgentVerdict[] = [];
  for (const id of ids) {
    const agent = agents[id] as AlphaAgent;
    const home = fixtures.find((f) => f.home?.includes(id)) ?? fixtures[0];
    // The fixture gates are decided on the HOME fixture alone, never on a pool of
    // fixtures: the random-entry baseline is a property of the series (it ranged
    // 10–34% across these fixtures), so pooling two of them would compare an
    // agent against the average of two different coin flips. The other fixtures
    // are still measured and reported, in the cross-table.
    const homeMeasurements = measurements.get(`${id}|${home.name}`) ?? [];
    const fixtureMeasurement = poolAlphaMeasurements(homeMeasurements);
    const nullMeasurements = nullFixtures.flatMap((f) => measurements.get(`${id}|${f.name}`) ?? []);
    const nullMeasurement = poolAlphaMeasurements(nullMeasurements);
    const driftlessMeasurement = poolAlphaMeasurements(measurements.get(`${id}|null-driftless`) ?? []);
    const fixtureGates = alphaFixtureGates(fixtureMeasurement);
    const nullGates = alphaNullGates(nullMeasurements);
    const driftlessGates = alphaDriftlessGates(driftlessMeasurement);

    // Paper trading: the same agent through the desk's real geometry and the
    // shipped position manager, on its home fixture and on the pooled null.
    let paper: AlphaAgentVerdict["paper"] = null;
    const paperSeries = homeBars.get(id);
    if (paperSeries && paperSeries.length > 0) {
      const runOne = (seriesBars: { bars: Bar[]; label: string }[], kind: string): AlphaPaperLeg => {
        const runs: HarnessRun[] = [];
        const ledger: AlphaLedgerEntry[] = [];
        let decisions = 0;
        for (const entry of seriesBars.slice(0, 2)) {
          const strategy = alphaStrategy({
            agent,
            id: `alpha:${id} (${kind})`,
            frame,
            cache: new Map<string, unknown>(),
          });
          const run = runHarness({
            frames: framesForMode(args.mode, entry.bars, frame),
            symbol: args.symbol,
            strategy,
            options: {
              spec: args.spec.spec,
              mode: args.mode,
              stride: Math.max(1, Math.min(args.stride, 5)),
              warmupBars: Math.max(120, agent.minBars),
              horizonBars: DEFAULT_ALPHA_CONFIG.horizonBars[args.mode],
              trials: 1,
            },
          });
          runs.push(run);
          ledger.push(...strategy.ledger);
          decisions += strategy.ledger.length;
        }
        return {
          summary: summariseRun(mergeRuns(runs, `alpha:${id} (${kind})`), false),
          ledger: { ...summariseAlphaLedger(ledger) },
          decisions,
        };
      };
      const paperNullSeries: { bars: Bar[]; label: string }[] = [];
      const firstNull = nullFixtures[0];
      if (firstNull) {
        for (let r = 0; r < Math.min(3, firstNull.series); r++) {
          const series = generate(firstNull.kind, {
            ...DEFAULT_GENERATOR_SPEC,
            seed: args.seed + r * 1013,
            bars: firstNull.bars,
            timeframeMs: frameWidth,
            volatility: args.mode === "intraday" ? 0.0008 : 0.0016,
          });
          paperNullSeries.push({ bars: series.bars, label: `${firstNull.name}#${r + 1}` });
        }
      }
      paper = {
        fixture: runOne(paperSeries, home.name),
        null:
          paperNullSeries.length > 0
            ? runOne(paperNullSeries, firstNull?.name ?? "null")
            : {
                summary: summariseRun(emptyHarnessRun(`alpha:${id}`, args.symbol, args.mode), false),
                ledger: {},
                decisions: 0,
              },
      };
    }

    const gates = [...fixtureGates.gates, ...driftlessGates.gates, ...nullGates.gates];
    const failed = gates.filter((g) => !g.pass);
    verdicts.push({
      agent: id,
      label: agent.label,
      home: home.name,
      fixture: fixtureMeasurement,
      null: nullMeasurement,
      fixtureGates,
      nullGates,
      driftless: driftlessMeasurement,
      driftlessGates,
      all: fixtures.map((f) => poolAlphaMeasurements(measurements.get(`${id}|${f.name}`) ?? [])),
      paper,
      verdict: failed.length === 0 ? "enabled" : "disabled",
      reason:
        failed.length === 0
          ? `all ${gates.length} gates passed on ${home.name} and the pooled nulls`
          : failed.map((g) => `${g.gate} → ${g.detail}`).join("; "),
    });
  }

  verdicts.sort((a, b) => ALPHA_IDS.indexOf(a.agent) - ALPHA_IDS.indexOf(b.agent));
  const allowlist = verdicts.filter((v) => v.verdict === "enabled").map((v) => v.agent);
  notes.push(
    "Every agent states a probability, and the probability is its own measured hit rate for this exact setup, shrunk " +
      "toward the MEASURED random-entry baseline for the same stop and horizon (see alpha/edge.ts). The gate is " +
      "whether that number beats the baseline on the fixture and fails to beat it on the nulls.",
  );
  notes.push(
    "The 'baseline' column is the random-entry hit rate with identical geometry AND the same direction as each view, " +
      "measured causally on windows that had closed by the decision bar. It is not 1/(1+RR): with a time horizon most " +
      "setups expire, and on these M15 fixtures the coin-flip rate measures 0.10–0.34 depending on the fixture's " +
      "volatility, so judging an agent against 1/3 would have measured the calendar. It is also direction-matched on " +
      "purpose: a realised driftless path still ends 25–35σ from its start, buys then do better than sells, and an agent " +
      "that is simply long on such a path would otherwise show an edge it does not have (measured: +8.6 points on pure " +
      "noise before the comparator was matched).",
  );
  notes.push(
    "Paper trading runs the agent through the SHIPPED position manager and the executed-policy simulator " +
      "(alphaStrategy in research/harness.ts): the stop, targets, partials, break-even and trail are the desk's, and " +
      "only the direction and the probability come from the agent. It is reported for EVERY agent with a home fixture, " +
      "enabled or not — a measured zero is evidence — and it is a smaller sample by construction. The ledger beside it " +
      "says which layer refused each decision.",
  );
  notes.push(
    "An agent that fails its gates is left DISABLED. Its code, its fixture and its numbers stay in the repository: a " +
      "measured negative result is a result, and the next person to have the same idea should find it here.",
  );

  return {
    label: args.label,
    generatedAt: new Date().toISOString(),
    command: process.argv.join(" "),
    mode: args.mode,
    symbol: args.symbol,
    seed: args.seed,
    dataSource: "synthetic (WP4 alpha fixtures)",
    barsPerSeries: args.alphaBars,
    stride: Math.max(1, Math.min(args.stride, 3)),
    contractSpec: args.spec.spec as unknown as Record<string, unknown>,
    assumedSpecValues: args.spec.assumed,
    fixtures: fixtures.map((f) => ({ name: f.name, kind: f.kind, series: f.series, bars: f.bars, note: f.note })),
    agents: verdicts,
    allowlist,
    verdict: allowlist.length > 0 ? "pass" : "fail",
    notes,
  };
}

/** Merge several runs of the same strategy into one summary (pooled trades). */
function mergeRuns(runs: HarnessRun[], id: string): HarnessRun {
  const first = runs[0] as HarnessRun;
  const trades = runs.flatMap((r) => r.trades);
  const stats = tradeStats(trades as never);
  return {
    ...first,
    strategy: id,
    evaluations: runs.reduce((a, r) => a + r.evaluations, 0),
    arms: runs.reduce((a, r) => a + r.arms, 0),
    armRate: 0,
    fills: trades.length,
    fillRate: 0,
    trades,
    stats,
    lowerBoundMeanR: lowerBoundMeanR(stats),
    dsr: 0,
    meanPredicted: trades.length === 0 ? 0 : trades.reduce((a, t) => a + (t.predictedProbability ?? 0), 0) / trades.length,
    predictedVsRealised: 0,
  };
}

function emptyHarnessRun(strategy: string, symbol: string, mode: TradeMode): HarnessRun {
  const stats = tradeStats([]);
  return {
    strategy,
    symbol,
    mode,
    evaluations: 0,
    arms: 0,
    armRate: 0,
    fills: 0,
    fillRate: 0,
    trades: [],
    stats,
    lowerBoundMeanR: 0,
    dsr: 0,
    meanPredicted: 0,
    predictedVsRealised: 0,
  };
}

export function renderAlphaStudy(report: AlphaStudyReport): string {
  const lines: string[] = [];
  lines.push(`MT5 Desk v4 — WP4 alpha-agent study (${report.label})`);
  lines.push(`  ${report.generatedAt}  |  mode ${report.mode}  |  symbol ${report.symbol}  |  seed ${report.seed}`);
  lines.push(`  ${report.barsPerSeries} bars per series, stride ${report.stride}, decision-level measurement`);
  lines.push("");
  for (const agent of report.agents) {
    const f = agent.fixture;
    const n = agent.null;
    lines.push(`  ${agent.label}  [${agent.verdict.toUpperCase()}]`);
    lines.push(
      `    fixture ${agent.home.padEnd(16)} views ${String(f.views).padStart(4)}  hit ${(f.hitRate * 100).toFixed(1).padStart(5)}%  ` +
        `base ${(f.baselineRate * 100).toFixed(1).padStart(5)}%  edge ${(f.edgeOverBaseline * 100).toFixed(1).padStart(6)} pp  ` +
        `stated ${(f.meanProbability * 100).toFixed(1).padStart(5)}%  skill ${f.brierSkill.toFixed(3)}`,
    );
    lines.push(
      `    nulls   ${"pooled".padEnd(16)} views ${String(n.views).padStart(4)}  hit ${(n.hitRate * 100).toFixed(1).padStart(5)}%  ` +
        `base ${(n.baselineRate * 100).toFixed(1).padStart(5)}%  edge ${(n.edgeOverBaseline * 100).toFixed(1).padStart(6)} pp  ` +
        `stated ${(n.meanProbability * 100).toFixed(1).padStart(5)}%  skill ${n.brierSkill.toFixed(3)}`,
    );
    lines.push(
      `    driftless ${"".padEnd(14)} views ${String(agent.driftless.views).padStart(4)}  ` +
        `rate ${(agent.driftless.viewRate * 100).toFixed(2).padStart(5)}%  hit ${(agent.driftless.hitRate * 100).toFixed(1).padStart(5)}%  ` +
        `base ${(agent.driftless.baselineRate * 100).toFixed(1).padStart(5)}%  edge ${(agent.driftless.edgeOverBaseline * 100).toFixed(1).padStart(6)} pp`,
    );
    for (const gate of [...agent.fixtureGates.gates, ...agent.driftlessGates.gates, ...agent.nullGates.gates]) {
      lines.push(`      ${gate.pass ? "ok  " : "FAIL"} ${gate.gate} — ${gate.detail}`);
    }
    if (agent.paper) {
      const p = agent.paper.fixture;
      const pn = agent.paper.null;
      lines.push(
        `    paper   home: ${p.summary.arms} arms / ${p.summary.fills} fills / E[R] ${p.summary.stats.meanR.toFixed(3)} ` +
          `(hit ${(p.summary.stats.hitRate * 100).toFixed(0)}%)   ` +
          `null: ${pn.summary.arms} arms / ${pn.summary.fills} fills / E[R] ${pn.summary.stats.meanR.toFixed(3)}`,
      );
      lines.push(
        `    ledger  home: ${Object.entries(p.ledger).map(([k, v]) => `${k} ${v}`).join(", ")}`,
      );
    }
    if (agent.verdict === "disabled") lines.push(`    why: ${agent.reason}`);
    lines.push("");
  }
  // Cross-table: every agent on every fixture (the "works everywhere" test).
  lines.push("  cross-table (edge over the measured baseline, in hit-rate points):");
  const header = ["fixture".padEnd(18), ...report.agents.map((a) => a.agent.slice(0, 12).padStart(13))].join("");
  lines.push(`    ${header}`);
  const fixtureNames = report.agents[0]?.all.map((m) => m.series.split(",")[0]?.split("#")[0] ?? m.series) ?? [];
  for (let i = 0; i < report.fixtures.length; i++) {
    const cells = report.agents.map((a) => {
      const m = a.all[i];
      if (!m) return "".padStart(13);
      return `${(m.edgeOverBaseline * 100).toFixed(1)} (${m.views})`.padStart(13);
    });
    lines.push(`    ${(report.fixtures[i]?.name ?? fixtureNames[i] ?? "").padEnd(18)}${cells.join("")}`);
  }
  lines.push("");
  lines.push(`  ALLOWLIST (agents that may be wired in): ${report.allowlist.length > 0 ? report.allowlist.join(", ") : "none"}`);
  lines.push(`  VERDICT: ${report.verdict.toUpperCase()}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

// ── Report output ───────────────────────────────────────────────────────────

export function renderReport(report: StudyReport): string {
  const lines: string[] = [];
  lines.push(`MT5 Desk v4 research report — ${report.label}`);
  lines.push(`  ${report.generatedAt}  |  mode ${report.mode}  |  symbol ${report.symbol}  |  seed ${report.seed}`);
  lines.push(`  data: ${report.dataSource} (${report.seriesKind}), ${report.barsPerRun} bars/run`);
  lines.push(`  walk-forward: ${report.walkForward.splits} splits, purge ${report.walkForward.purgeBars}, embargo ${report.walkForward.embargoBars}, clean=${report.walkForward.clean}`);
  lines.push("");
  lines.push("  contract spec (assumed values are the study's weakest link):");
  const spec = report.contractSpec;
  lines.push(
    `    point ${String(spec.point)}  digits ${String(spec.digits)}  tickValue ${String(spec.tickValue)}  ` +
      `spread ${String(spec.spreadPoints)} pt  commission ${String(spec.commissionPerLot)}/lot`,
  );
  if (report.assumedSpecValues.length > 0) lines.push(`    ASSUMED: ${report.assumedSpecValues.join(", ")}`);
  lines.push("");
  lines.push("  run                                    evals  arms   rate   fills   E[R]    hit   LCB80   DSR");
  for (const run of report.runs) {
    lines.push(
      `  ${run.strategy.padEnd(38)} ${String(run.evaluations).padStart(5)} ${String(run.arms).padStart(5)} ` +
        `${(run.armRate * 100).toFixed(1).padStart(5)}% ${String(run.fills).padStart(6)} ` +
        `${run.stats.meanR.toFixed(3).padStart(7)} ${(run.stats.hitRate * 100).toFixed(0).padStart(4)}% ` +
        `${run.lowerBoundMeanR.toFixed(3).padStart(6)} ${(run.dsr * 100).toFixed(1).padStart(5)}%`,
    );
  }
  lines.push("");
  lines.push("  gates:");
  for (const [name, gate] of Object.entries(report.gates)) {
    lines.push(`    [${gate.pass ? "PASS" : "FAIL"}] ${name}${gate.runs ? ` (${gate.runs} series)` : ""}`);
    for (const g of gate.gates) {
      lines.push(
        `        ${g.pass ? "ok  " : "FAIL"} ${g.gate} — measured ${Number(g.measured).toFixed(4)} ` +
          `(threshold ${Number(g.threshold).toFixed(4)}): ${g.detail}`,
      );
    }
  }
  if (report.regime) {
    lines.push("");
    lines.push("  WP3 regime layer:");
    for (const entry of report.regime.accuracy) {
      const a = entry.accuracy;
      lines.push(
        `    ${entry.series.padEnd(24)} causal ${(a.causal * 100).toFixed(1).padStart(5)}%  ` +
          `(LCB ${(a.causalLowerBound * 100).toFixed(1)}%)  viterbi ${(a.viterbi * 100).toFixed(1)}%  ` +
          `ceiling ${(a.ceiling * 100).toFixed(1)}%  n=${a.samples}  states=${a.fittedLabels.join("/")}`,
      );
    }
    for (const entry of report.regime.tallies) {
      const t = entry.tally;
      const codes = Object.entries(t.byCode)
        .map(([code, n]) => `${code}×${n}`)
        .join(" ");
      lines.push(
        `    ${entry.strategy.padEnd(36)} asked ${String(t.asked).padStart(4)}  permits ${String(t.permits).padStart(4)}  ` +
          `vetoes ${String(t.vetoes).padStart(4)}  |  ${codes}`,
      );
      const states = Object.entries(t.byState)
        .map(([state, n]) => `${state} ${n}`)
        .join(" ");
      lines.push(`      ${" ".repeat(34)}states: ${states}`);
    }
  }
  if (report.calibration) {
    const c = report.calibration;
    lines.push("");
    lines.push(`  calibration: n=${c.samples}  slope ${c.reliabilitySlope.toFixed(3)}  intercept ${c.reliabilityIntercept.toFixed(3)}  Brier ${c.brier.toFixed(4)}  skill ${c.brierSkill.toFixed(4)}`);
  }
  lines.push("");
  lines.push(`  VERDICT: ${report.verdict.toUpperCase()}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

// ── WP5 meta-model study ────────────────────────────────────────────────────

/**
 * Run the WP5 study.
 *
 * The verdict is pre-committed and it is not negotiable after the fact:
 *
 *   PASS  ⟺  every HOME fixture (the two positive controls) passes the
 *            calibration gates  AND  every null fixture passes the null gates.
 *
 * Report-only fixtures (the OU series) are still measured and printed, but they
 * do not decide the verdict — they were never claimed as the corpus where the
 * model is supposed to work, and letting them vote would be a way to tune the
 * rule after seeing the numbers.
 */
export function runMetaStudy(args: CliArgs): MetaStudyReport {
  const notes: string[] = [];
  const frame = SYNTHETIC_BASE_FRAME[args.mode];
  const frameWidth = frameMinutes(frame) * 60_000;
  const seriesCount = args.metaSeriesExplicit ? args.metaSeries : undefined;
  // Every closed bar is a decision the desk could take, and a meta-model cannot
  // calibrate on a corpus of a few hundred overlapping events: the WP5 run is at
  // stride 1 unless the caller says otherwise (`uniqueness.ts` counts the corpus
  // in INDEPENDENT observations, which is a good deal smaller than the row count).
  const stride = args.strideExplicit ? args.stride : 1;
  // The label's horizon is the desk's OWN holding horizon for the mode
  // (`MODE_HORIZON_BARS`: 12 / 24 / 48). A study that labelled intraday setups on
  // a swing horizon would be measuring a trade the desk never places, and the
  // mode's own number is the one the gatekeeper has to price.
  const horizonBars = args.horizonBarsExplicit ? args.horizonBars : MODE_HORIZON_BARS[args.mode];
  const verdicts: MetaFixtureVerdict[] = [];

  for (const fixture of META_STUDY_FIXTURES) {
    const count = seriesCount ?? fixture.series;
    const measurements = [] as ReturnType<typeof measureMeta>[];
    for (let r = 0; r < count; r++) {
      const series = generate(fixture.kind as GeneratorKind, {
        ...DEFAULT_GENERATOR_SPEC,
        seed: args.seed + r * 1013,
        bars: args.metaBars,
        timeframeMs: frameWidth,
        volatility: args.mode === "scalp" ? 0.00035 : args.mode === "intraday" ? 0.0008 : 0.0016,
      });
      measurements.push(
        measureMeta({
          bars: series.bars,
          series: `${fixture.name}#${r + 1}`,
          kind: fixture.kind,
          mode: args.mode,
          spec: args.spec.spec,
          symbol: args.symbol,
          frame,
          frameWidthMs: frameWidth,
          stride: Math.max(1, Math.min(stride, 5)),
          warmupBars: 150,
          targetMultipleR: META_TARGET_MULTIPLE_R,
          horizonBars,
          calibrator: args.metaCalibrator,
        }),
      );
    }
    const pooled = summariseMetaRows(measurements.flatMap((measurement) => measurement.rows));
    verdicts.push({
      name: fixture.name,
      kind: fixture.kind,
      home: fixture.home === true,
      null: fixture.null === true,
      note: fixture.note,
      pooled,
      series: measurements.map((measurement) => toSeriesRecord(measurement)),
      calibration: metaCalibrationGates(pooled),
      nullGates: fixture.null ? metaNullGates(pooled) : null,
    });
  }

  const homeFailures = verdicts.filter((verdict) => verdict.home && !verdict.calibration.pass);
  const nullFailures = verdicts.filter((verdict) => verdict.null && verdict.nullGates !== null && !verdict.nullGates.pass);
  const verdict: "pass" | "fail" = homeFailures.length === 0 && nullFailures.length === 0 ? "pass" : "fail";
  for (const record of homeFailures) {
    for (const gate of record.calibration.gates.filter((entry) => !entry.pass)) {
      notes.push(`home fixture ${record.name} failed "${gate.name}": ${gate.detail}`);
    }
  }
  for (const record of nullFailures) {
    for (const gate of (record.nullGates?.gates ?? []).filter((entry) => !entry.pass)) {
      notes.push(`null fixture ${record.name} failed "${gate.name}": ${gate.detail}`);
    }
  }
  // A report-only fixture that fails a calibration gate is a caveat the artifact
  // must carry: silence here would turn "measured elsewhere" into "hidden".
  for (const record of verdicts) {
    if (record.home || record.null) continue;
    for (const gate of record.calibration.gates.filter((entry) => !entry.pass)) {
      notes.push(
        `report-only fixture ${record.name} fails "${gate.name}" (${gate.detail}) — it does not decide this ` +
          `work package's verdict, but it is a measured limitation of the model on that corpus.`,
      );
    }
  }
  notes.push(
    "p_LCB is computed from the Kish effective sample size of the fold's training weights; it is deliberately the " +
      "sample the calibration rests on, not the size of the test set.",
  );
  notes.push(
    "row-level records are not persisted in the artifact; the run is deterministic, so the same command reproduces them.",
  );
  if (args.spec.assumed.length > 0) {
    notes.push(`spec assumptions: ${args.spec.assumed.join(", ")}`);
  }

  return {
    label: args.label,
    generatedAt: new Date().toISOString(),
    command: process.argv.join(" "),
    mode: args.mode,
    symbol: args.symbol,
    seed: args.seed,
    dataSource: `synthetic (${META_STUDY_FIXTURES.map((fixture) => fixture.kind).join(", ")})`,
    barsPerSeries: args.metaBars,
    seriesPerFixture: seriesCount ?? 0,
    stride,
    horizonBars,
    targetMultipleR: META_TARGET_MULTIPLE_R,
    calibrator: args.metaCalibrator,
    contractSpec: args.spec.spec as unknown as Record<string, unknown>,
    assumedSpecValues: args.spec.assumed,
    fixtures: verdicts,
    verdict,
    notes,
  };
}

export function renderMetaStudy(report: MetaStudyReport): string {
  const lines: string[] = [];
  lines.push(`MT5 Desk v4 — WP5 meta-model study (${report.label})`);
  lines.push(`  ${report.generatedAt}  |  mode ${report.mode}  |  symbol ${report.symbol}  |  seed ${report.seed}`);
  lines.push(`  ${report.barsPerSeries} bars per series, stride ${report.stride}, ${report.horizonBars}-bar horizon, target ${report.targetMultipleR}R`);
  lines.push("");
  lines.push("  fixture              rows   indep base   hit   skill  slope  armed   meanR  corpusR   p_LCB cov");
  for (const verdict of report.fixtures) {
    const st = verdict.pooled;
    const slope = st.reliability.identifiable ? (st.reliability.slope ?? 0).toFixed(2) : " n/a";
    lines.push(
      `  ${verdict.name.padEnd(18)} ${String(st.rows).padStart(5)} ${verdict.series.reduce((a, r) => a + r.independentObservations, 0).toFixed(0).padStart(5)} ` +
        `${(st.baseRate * 100).toFixed(1).padStart(5)}% ${(st.hitRate * 100).toFixed(1).padStart(5)}% ` +
        `${st.brierSkill.toFixed(3).padStart(6)} ${slope.padStart(6)} ${String(st.fitted.armed).padStart(5)} ` +
        `${st.fitted.meanR.toFixed(3).padStart(7)} ${st.corpus.meanR.toFixed(3).padStart(8)} ` +
        `${st.violationBuckets.length}/${st.judgeableBuckets}`,
    );
  }
  lines.push("");
  for (const verdict of report.fixtures) {
    const st = verdict.pooled;
    lines.push(`  ${verdict.name}${verdict.home ? " [home]" : ""}${verdict.null ? " [null]" : ""}`);
    lines.push(
      `    deciles (predicted / lower bound / observed): ` +
        st.buckets.map((bucket) => `${(bucket.meanPredicted * 100).toFixed(0)}:${(bucket.meanLowerBound * 100).toFixed(0)}/${(bucket.observed * 100).toFixed(0)}`).join(" "),
    );
    lines.push(
      `    reference policy (measured WP4 allowlist): ${st.reference.armed} taken, hit ${(st.reference.hitRate * 100).toFixed(1)}%, mean R ${st.reference.meanR.toFixed(3)}`,
    );
    lines.push(
      `    fitted policy (EV_LCB > 0): ${st.fitted.armed} armed, hit ${(st.fitted.hitRate * 100).toFixed(1)}%, mean R ${st.fitted.meanR.toFixed(3)} ` +
        `(95% lower ${st.fitted.meanRLower.toFixed(3)}), mean p_LCB ${st.fitted.meanLowerBound.toFixed(3)}`,
    );
    const cpcv = verdict.series.reduce(
      (acc, record) => ({ paths: acc.paths + record.cpcvPaths, positive: acc.positive + record.cpcvPositivePaths }),
      { paths: 0, positive: 0 },
    );
    lines.push(`    CPCV: ${cpcv.positive}/${cpcv.paths} out-of-sample paths with a positive mean R on the armed subset`);
    for (const gate of verdict.calibration.gates) {
      if (verdict.home || !gate.pass) lines.push(`      ${gate.pass ? "ok  " : "FAIL"} ${gate.name} — ${gate.detail}`);
    }
    for (const gate of verdict.nullGates?.gates ?? []) {
      lines.push(`      ${gate.pass ? "ok  " : "FAIL"} ${gate.name} — ${gate.detail}`);
    }
    lines.push("");
  }
  lines.push(`  VERDICT: ${report.verdict.toUpperCase()}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}


/**
 * The WP7 execution study.
 *
 * The instrument is the executed-policy simulator: the same geometry, stop,
 * target and management, simulated twice per decision — once with the legacy
 * breakout trigger and once resting a limit at the pullback retracement — so the
 * difference is the entry style and nothing else. The fixtures are the WP5/WP6
 * ones, so "the entry style is measured on the corpus the desk was calibrated
 * on" is true by construction rather than by assertion.
 */
export interface ExecutionStudyReport {
  tool: string;
  mode: TradeMode;
  generatedAt: string;
  command: string;
  contractSpec: Record<string, unknown>;
  thresholds: {
    stride: number;
    warmupBars: number;
    minFillRate: number;
    pairedToleranceR: number;
    timingRefusalMax: number;
    allowanceCeilingMult: number;
  };
  fixtures: {
    name: string;
    kind: string;
    note: string;
    home: boolean;
    pooled: ReturnType<typeof summariseExecution>;
    series: Omit<ExecutionSeriesAssessment, "legacyR">[];
  }[];
  gates: GateRow[];
  verdict: "PASS" | "FAIL";
  notes: string[];
}

function executionFixtureAssessment(args: CliArgs, fixture: (typeof META_STUDY_FIXTURES)[number]): ExecutionStudyReport["fixtures"][number] {
  const frame = SYNTHETIC_BASE_FRAME[args.mode];
  const count = args.metaSeriesExplicit ? args.metaSeries : fixture.series;
  const assessments: ExecutionSeriesAssessment[] = [];
  for (let r = 0; r < count; r++) {
    const series = syntheticSeriesForMode(args.mode, fixture.kind as GeneratorKind, args.seed + r * 1013, args.metaBars);
    assessments.push(
      assessExecutionSeries({
        bars: series.bars,
        spec: args.spec.spec,
        mode: args.mode,
        symbol: args.symbol,
        fixture: fixture.name,
        series: `${fixture.name}#${r + 1}`,
        frame,
        stride: EXECUTION_STRIDE,
        seed: args.seed + r * 7919,
        horizonBars: MODE_HORIZON_BARS[args.mode],
      }),
    );
  }
  return {
    name: fixture.name,
    kind: fixture.kind,
    note: fixture.note,
    home: fixture.home === true,
    pooled: summariseExecution(assessments),
    // legacyR is an input to the portfolio study, not a result: keep it out of the report
    series: assessments.map(({ legacyR: _legacyR, ...rest }) => rest),
  };
}

export function runExecutionStudy(args: CliArgs): ExecutionStudyReport {
  const fixtures = META_STUDY_FIXTURES.map((fixture) => executionFixtureAssessment(args, fixture));
  const gates = fixtures.flatMap((fixture) => fixture.pooled.gates);
  const notes: string[] = [];
  notes.push(
    "the spread z-score and the slippage ledger are NOT measured here: the synthetic corpora carry no SPREAD column and no fills of their own. Both layers only refuse when a measurement exists, both are unit-tested (wp7-execution.test.ts), and the live desk's own quote and fill records are their measurement",
  );
  notes.push(
    "the entry-style comparison is PAIRED: same decision bar, same stop LEVEL, same target rule, same management policy, two triggers. Each trade is measured in its own R, and the resting plan is additionally re-expressed in the legacy plan's R before the difference is taken",
  );
  notes.push(
    `directions alternate deterministically (buy, sell, buy, …) because the entry-style question is direction-symmetric; always going long on a drifting generator would answer a different question`,
  );
  notes.push(
    `every simulation starts at bar ${EXECUTION_WARMUP} and scans FORWARD from the decision bar (see executed-policy.ts: nothing at or before the decision bar is ever read for a price)`,
  );
  notes.push(
    "the simulator's fill window is executed-policy.ts's own MAX_FILL_WAIT_BARS: the live desk's pending-order EXPIRY (PENDING_EXPIRY_BARS) and its 0.5R cancel rule are EA/desk wiring rules and are covered by wp7-execution.test.ts, not by this study. The plan's invalidation LEVEL is the desk's 0.6 ATR rule, so a pullback that goes too deep kills the plan rather than filling it",
  );
  notes.push(
    "the timing layer is measured as a REFUSAL RATE, not as an edge: the synthetic generators carry no calendar structure, so bucket means on them are noise by construction. What the corpus can say is that the rule is a filter and not a blanket ban; the ledger's own value has to come from the live desk's fills (bridge.ts) and is reported by GET /execution",
  );
  return {
    tool: "MT5 Desk v4 — WP7 execution study",
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    command: process.argv.join(" "),
    contractSpec: args.spec.spec as unknown as Record<string, unknown>,
    thresholds: {
      stride: EXECUTION_STRIDE,
      warmupBars: EXECUTION_WARMUP,
      minFillRate: EXECUTION_MIN_FILL_RATE,
      pairedToleranceR: EXECUTION_PAIRED_TOLERANCE_R,
      timingRefusalMax: EXECUTION_TIMING_REFUSAL_MAX,
      allowanceCeilingMult: EXECUTION_ALLOWANCE_CEILING_MULT,
    },
    fixtures,
    gates,
    verdict: executionGatesPass(gates) ? "PASS" : "FAIL",
    notes,
  };
}

export function renderExecutionStudy(report: ExecutionStudyReport): string {
  const lines: string[] = [];
  lines.push(`WP7 execution study — mode ${report.mode} — VERDICT: ${report.verdict}`);
  lines.push(`  stride ${report.thresholds.stride}, warmup ${report.thresholds.warmupBars} bars, executed-policy simulator`);
  for (const fixture of report.fixtures) {
    const pooled = fixture.pooled;
    const timing = fixture.series[0]?.timing;
    lines.push(
      `  ${fixture.name}${fixture.home ? " (home)" : ""}: ${pooled.decisions} decisions — legacy mean ${pooled.legacyMeanR.toFixed(4)}R (fills), resting mean ${pooled.restingMeanR.toFixed(4)}R at a ${(pooled.restingFillRate * 100).toFixed(1)}% fill rate — paired ΔR ${pooled.pairedMeanDeltaR.toFixed(4)} (better in ${(pooled.betterShare * 100).toFixed(1)}%) — timing refuses ${(pooled.timingRefusalRate * 100).toFixed(1)}%`,
    );
    if (timing) {
      lines.push(
        `      timing buckets: ${timing.measuredBuckets}/${timing.buckets} measured — bucket means ${timing.worstMeanR === null ? "n/a" : timing.worstMeanR.toFixed(3)}R…${timing.bestMeanR === null ? "n/a" : timing.bestMeanR.toFixed(3)}R`,
      );
    }
  }
  for (const gate of report.gates) {
    lines.push(`  ${gate.pass ? "ok  " : "FAIL"} ${gate.code.padEnd(22)} ${gate.detail}`);
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

export function writeExecutionReport(report: ExecutionStudyReport, outPath: string | null): string {
  const stamp = report.generatedAt.slice(0, 10);
  const target =
    outPath ?? resolve(process.cwd(), `research-reports/${stamp}-wp7-execution-${report.mode}-study.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return target;
}

/**
 * The WP8 portfolio study.
 *
 * The book is constructed, not hoped for: a companion instrument is built from
 * the fixture's own returns at a KNOWN correlation, plus an independent
 * instrument, so the estimator's answer can be checked against the truth it was
 * given. The composition then runs over the fixture's decision points, and the
 * equity path is walked with the R sequence the WP7 study's simulator produced
 * on the same corpus — the desk's own instrument, not a hypothetical one.
 */
export interface PortfolioStudyReport {
  tool: string;
  mode: TradeMode;
  generatedAt: string;
  command: string;
  contractSpec: Record<string, unknown>;
  thresholds: {
    correlationTarget: number;
    covarianceBars: number;
    maxTradeRiskPct: number;
    heatCeilingPct: number;
    cvarCeilingPct: number;
    ddFloorScalar: number;
  };
  fixtures: {
    name: string;
    kind: string;
    home: boolean;
    note: string;
    pooled: ReturnType<typeof summarisePortfolio>;
    series: PortfolioSeriesAssessment[];
  }[];
  gates: GateRow[];
  verdict: "PASS" | "FAIL";
  notes: string[];
}

export function runPortfolioStudy(args: CliArgs): PortfolioStudyReport {
  const frame = SYNTHETIC_BASE_FRAME[args.mode];
  const fixtures: PortfolioStudyReport["fixtures"] = [];
  const gates: GateRow[] = [];
  const count = args.metaSeriesExplicit ? args.metaSeries : META_STUDY_FIXTURES[0]!.series;
  for (const fixture of META_STUDY_FIXTURES) {
    const series: PortfolioStudyReport["fixtures"][number]["series"] = [];
    const tradeCounts: number[] = [];
    for (let r = 0; r < count; r++) {
      const generated = syntheticSeriesForMode(args.mode, fixture.kind as GeneratorKind, args.seed + r * 1013, args.metaBars);
      // The R sequence for the drawdown path comes from the same simulator the
      // WP7 study uses, on the same bars and the same seed.
      const execution = assessExecutionSeries({
        bars: generated.bars,
        spec: args.spec.spec,
        mode: args.mode,
        symbol: args.symbol,
        fixture: fixture.name,
        series: `${fixture.name}#${r + 1}`,
        frame,
        stride: EXECUTION_STRIDE,
        seed: args.seed + r * 7919,
        horizonBars: MODE_HORIZON_BARS[args.mode],
      });
      tradeCounts.push(execution.legacyR.length);
      series.push(
        assessPortfolioSeries({
          bars: generated.bars,
          spec: args.spec.spec,
          mode: args.mode,
          symbol: args.symbol,
          fixture: fixture.name,
          trades: execution.legacyR.map((r2) => ({ r: r2 })),
          seed: args.seed + 977 + r * 1013,
          stride: EXECUTION_STRIDE,
        }),
      );
    }
    const pooled = summarisePortfolio(series);
    fixtures.push({ name: fixture.name, kind: fixture.kind, home: fixture.home === true, note: fixture.note, pooled, series });
    gates.push(...pooled.gates);
  }
  const notes: string[] = [];
  notes.push(
    `the Kelly term is NOT measured here: it consumes the WP5 model's p_LCB and this study does not fit a model, so the composition runs with probabilityLowerBound = null and the ${PORTFOLIO_MAX_TRADE_RISK_PCT}% per-trade cap is the binding constraint. The wiring test wp8-portfolio.test.ts covers the Kelly branch`,
  );
  notes.push(
    `the companion instrument is built as r_c = ${PORTFOLIO_CORRELATION_TARGET}·r_p + √(1−${PORTFOLIO_CORRELATION_TARGET}²)·ε from the primary's own returns, with a separate noise stream for the independent instrument, so the estimator is checked against a correlation it was GIVEN`,
  );
  notes.push(
    "the drawdown comparison walks the WP7 simulator's realised R sequence at a fixed 0.35% per trade with and without the drawdown scalar; it is a measurement of the scalar's effect on THAT path, not a forecast of anyone's equity",
  );
  notes.push(
    "the parametric CVaR is a normal-tail LOWER bound on a fat-tailed number (see portfolio-risk.ts). The composed book's CVaR therefore lands ON its 1.5% ceiling rather than under it: the layer cuts the candidate to the largest size that fits, and a trade that cannot be cut small enough is refused with PF_NO_BUDGET. The 1.5% is only a floor on the true tail risk, which is why the kurtosis caveat is repeated here",
  );
  notes.push(
    "the drawdown comparison walks the SAME realised R sequence twice, with and without the scalar, and then walks it once more mirrored to all-losses. The mirror is the only version a safety gate can hold: on a profitable path a risk scalar can leave a LARGER percentage drawdown behind, because the percentage is measured against an equity curve that also grew more slowly. The mirrored flat path reaches ruin (197% of the initial equity) while the scalar halts the desk at ~10% — that is the mechanism the gate measures, together with the invariant that the layer's risk is never above the cap",
  );
  return {
    tool: "MT5 Desk v4 — WP8 portfolio study",
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    command: process.argv.join(" "),
    contractSpec: args.spec.spec as unknown as Record<string, unknown>,
    thresholds: {
      correlationTarget: PORTFOLIO_CORRELATION_TARGET,
      covarianceBars: 120,
      maxTradeRiskPct: PORTFOLIO_MAX_TRADE_RISK_PCT,
      heatCeilingPct: PORTFOLIO_HEAT_MAX_PCT,
      cvarCeilingPct: DAILY_CVAR_MAX_PCT,
      ddFloorScalar: PORTFOLIO_DD_FLOOR,
    },
    fixtures,
    gates,
    verdict: portfolioGatesPass(gates) ? "PASS" : "FAIL",
    notes,
  };
}

export function renderPortfolioStudy(report: PortfolioStudyReport): string {
  const lines: string[] = [];
  lines.push(`WP8 portfolio study — mode ${report.mode} — VERDICT: ${report.verdict}`);
  lines.push(
    `  book: ρ_target ${report.thresholds.correlationTarget}, ${report.thresholds.covarianceBars} bars, cap ${report.thresholds.maxTradeRiskPct}%, heat ≤ ${report.thresholds.heatCeilingPct}%, CVaR ≤ ${report.thresholds.cvarCeilingPct}%`,
  );
  for (const fixture of report.fixtures) {
    const a = fixture.pooled;
    lines.push(
      `  ${fixture.name}${fixture.home ? " (home)" : ""}: ρ̂ ${a.estimatedRho === null ? "n/a" : a.estimatedRho.toFixed(4)} (independent built: ${a.independentRho === null ? "n/a" : a.independentRho.toFixed(4)}) — cluster captures the neighbour ${a.clusterCapturesNeighbour === 1} / excludes the independent ${a.clusterExcludesIndependent === 1} — heat ${a.maxHeatCappedPct.toFixed(4)}% composed vs ${a.maxHeatNaivePct.toFixed(4)}% uncapped — CVaR ${a.maxCvarCappedPct.toFixed(4)}% composed vs ${a.maxCvarNaivePct.toFixed(4)}% uncapped — candidate risk ${a.cappedRiskPctMean.toFixed(4)}% mean — refusals ${a.refusedCandidates} of ${a.candidateOffers} candidate offers — maxDD ${a.maxDrawdownScaledPct.toFixed(2)}% vs ${a.maxDrawdownFlatPct.toFixed(2)}% flat`,
    );
  }
  for (const gate of report.gates) lines.push(`  ${gate.pass ? "ok  " : "FAIL"} ${gate.code.padEnd(22)} ${gate.detail}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

export function writePortfolioReport(report: PortfolioStudyReport, outPath: string | null): string {
  const stamp = report.generatedAt.slice(0, 10);
  const target =
    outPath ?? resolve(process.cwd(), `research-reports/${stamp}-wp8-portfolio-${report.mode}-study.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return target;
}

/**
 * The WP6 gatekeeper study.
 *
 * Same corpora, same folds, same calibrator as `runMetaStudy` — deliberately, and
 * by construction: the gatekeeper exists to spend that model, so measuring it on
 * any other corpus would answer a question nobody asked. The one addition is what
 * WP6 needs and WP5 never had: a MEASURED break-even rate per row (the
 * direction-matched random-entry rate at that row's own bar), the mode's EV
 * floors, BH at q = 0.10, the cost against the horizon's volatility, and the
 * sampled executed-policy Monte Carlo.
 */
export function runGatekeeperStudy(args: CliArgs): GatekeeperStudyReport {
  const notes: string[] = [];
  const frame = SYNTHETIC_BASE_FRAME[args.mode];
  const frameWidth = frameMinutes(frame) * 60_000;
  const seriesCount = args.metaSeriesExplicit ? args.metaSeries : undefined;
  // Every closed bar is a decision: the gate is measured at decision cadence, and
  // the corpus has to be large enough to calibrate at all (see `uniqueness.ts`).
  // Same cadence as the WP5 study this consumes: every closed bar unless the
  // caller says otherwise. The gatekeeper is measured on the corpus the model was
  // fitted and judged on, or it is measuring a different desk.
  const stride = args.strideExplicit ? args.stride : 1;
  const horizonBars = args.horizonBarsExplicit ? args.horizonBars : MODE_HORIZON_BARS[args.mode];
  const fixtures: GatekeeperFixtureAssessment[] = [];
  let mcSamples = 0;
  let mcFailed = 0;
  let costSigmaMeasured = 0;

  for (const fixture of META_STUDY_FIXTURES) {
    const count = seriesCount ?? fixture.series;
    const assessments: GatekeeperSeriesAssessment[] = [];
    for (let r = 0; r < count; r++) {
      const series = generate(fixture.kind as GeneratorKind, {
        ...DEFAULT_GENERATOR_SPEC,
        seed: args.seed + r * 1013,
        bars: args.metaBars,
        timeframeMs: frameWidth,
        volatility: args.mode === "scalp" ? 0.00035 : args.mode === "intraday" ? 0.0008 : 0.0016,
      });
      const measurement = measureMeta({
        bars: series.bars,
        series: `${fixture.name}#${r + 1}`,
        kind: fixture.kind,
        mode: args.mode,
        spec: args.spec.spec,
        symbol: args.symbol,
        frame,
        frameWidthMs: frameWidth,
        stride: Math.max(1, Math.min(stride, 5)),
        warmupBars: 150,
        targetMultipleR: META_TARGET_MULTIPLE_R,
        horizonBars,
        calibrator: args.metaCalibrator,
      });
      const assessment = assessGatekeeperSeries({
        measurement,
        bars: series.bars,
        spec: args.spec.spec,
        mode: args.mode,
        horizonBars,
        seed: args.seed + r * 7919,
      });
      mcSamples += assessment.mc.samples;
      mcFailed += assessment.mc.failedFit;
      costSigmaMeasured += assessment.costSigma.measured;
      assessments.push(assessment);
    }
    const pooled = poolGatekeeperSeries(assessments, {
      hitRate:
        assessments.reduce((a, s) => a + s.corpus.hitRate * s.rows, 0) /
        Math.max(1, assessments.reduce((a, s) => a + s.rows, 0)),
      meanR:
        assessments.reduce((a, s) => a + s.corpus.meanR * s.rows, 0) /
        Math.max(1, assessments.reduce((a, s) => a + s.rows, 0)),
    });
    fixtures.push({
      name: fixture.name,
      kind: fixture.kind,
      mode: args.mode,
      home: fixture.home === true,
      null: fixture.null === true,
      note: fixture.note,
      series: assessments,
      pooled,
    });
  }

  const homes = fixtures.filter((fixture) => fixture.home);
  const nulls = fixtures.filter((fixture) => fixture.null);
  const homeGates = homes.length > 0 ? poolGatekeeperHomes(homes) : null;
  const nullGates = nulls.length > 0 ? gatekeeperNullGates(nulls) : null;
  if (homes.length === 0) notes.push("no home fixture in this run: the verdict rests on the nulls alone");
  notes.push(
    "the WP3 regime permit and the executed-policy Monte Carlo are NOT the same measurement here: the permit is measured by the WP3 study (research-reports/2026-10-11-wp3-regime-study-*.json) and its composition by wp6-gatekeeper-wiring.test.ts; the MC is SAMPLED at the stride below, and the per-decision path is covered by the wiring tests",
  );
  notes.push(
    `sampled MC: ${mcSamples} decision bars (every ${GK_MC_STRIDE}th row), ${mcFailed} refused for want of a GARCH fit`,
  );
  notes.push(
    `cost/sigma_h measured on ${costSigmaMeasured} rows with a usable trailing sigma; enforced only on scalp (${COST_OVER_SIGMA_MODES.join(", ")})`,
  );
  notes.push(
    `scalp is not measured here: the meta corpus has no scalp frames, so the ${MIN_EV_LCB_R.scalp}R scalp floor and the ${MAX_COST_OVER_HORIZON_SIGMA} cost ceiling are asserted by the unit and wiring tests only`,
  );
  if (args.mode !== "intraday" && args.mode !== "swing") {
    notes.push(`mode ${args.mode} is not one of the corpus modes this study was designed around`);
  }

  return {
    tool: "MT5 Desk v4 — WP6 gatekeeper study",
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    command: process.argv.join(" "),
    mc: { stride: GK_MC_STRIDE, paths: GK_MC_PATHS, tradesPerPath: GK_MC_TRADES_PER_PATH },
    thresholds: { evLcbFloorR: MIN_EV_LCB_R, bhQ: BH_Q, costSigmaMax: MAX_COST_OVER_HORIZON_SIGMA },
    contractSpec: args.spec.spec as unknown as Record<string, unknown>,
    fixtures,
    homeGates,
    nullGates,
    verdict: (homeGates === null || homeGates.pass) && (nullGates === null || nullGates.pass) ? "PASS" : "FAIL",
    notes,
  };
}

export function writeGatekeeperReport(report: GatekeeperStudyReport, outPath: string | null): string {
  const stamp = report.generatedAt.slice(0, 10);
  const target =
    outPath ??
    resolve(process.cwd(), `research-reports/${stamp}-wp6-gatekeeper-${report.mode}-gatekeeper-study.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return target;
}

export function writeMetaReport(report: MetaStudyReport, outPath: string | null): string {
  const stamp = report.generatedAt.slice(0, 10);
  const target =
    outPath ?? resolve(process.cwd(), `research-reports/${stamp}-wp5-meta-${report.mode}-${report.label}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return target;
}

export function writeAlphaReport(report: AlphaStudyReport, outPath: string | null): string {
  const stamp = report.generatedAt.slice(0, 10);
  const target =
    outPath ?? resolve(process.cwd(), `research-reports/${stamp}-wp4-alpha-${report.mode}-${report.label}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return target;
}

export function writeReport(report: StudyReport, outPath: string | null): string {
  const stamp = report.generatedAt.slice(0, 10);
  const target = outPath ?? resolve(process.cwd(), `research-reports/${stamp}-${report.label}-${report.mode}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return target;
}

export function main(argv = process.argv.slice(2)): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  const started = Date.now();
  if (args.execution) {
    const study = runExecutionStudy(args);
    const written = writeExecutionReport(study, args.out);
    if (!args.quiet) process.stdout.write(`${renderExecutionStudy(study)}\n`);
    process.stdout.write(`  report: ${written}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
    return study.verdict === "PASS" ? 0 : 1;
  }
  if (args.portfolio) {
    const study = runPortfolioStudy(args);
    const written = writePortfolioReport(study, args.out);
    if (!args.quiet) process.stdout.write(`${renderPortfolioStudy(study)}\n`);
    process.stdout.write(`  report: ${written}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
    return study.verdict === "PASS" ? 0 : 1;
  }
  if (args.gatekeeper) {
    const study = runGatekeeperStudy(args);
    const written = writeGatekeeperReport(study, args.out);
    if (!args.quiet) process.stdout.write(`${renderGatekeeperStudy(study)}\n`);
    process.stdout.write(`  report: ${written}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
    // WP6's verdict: the gate must select something better than the corpus on its
    // POSITIVE CONTROL and must claim nothing on the nulls.
    return study.verdict === "PASS" ? 0 : 1;
  }
  if (args.meta) {
    const study = runMetaStudy(args);
    const written = writeMetaReport(study, args.out);
    if (!args.quiet) process.stdout.write(`${renderMetaStudy(study)}\n`);
    process.stdout.write(`  report: ${written}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
    // WP5's verdict is a composition: the model must be calibrated on both
    // positive controls AND must claim nothing on the nulls.
    return study.verdict === "pass" ? 0 : 1;
  }
  if (args.alphas) {
    const study = runAlphaStudy(args);
    const written = writeAlphaReport(study, args.out);
    if (!args.quiet) process.stdout.write(`${renderAlphaStudy(study)}\n`);
    process.stdout.write(`  report: ${written}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
    // A WP4 study exits 0 when AT LEAST ONE agent earned its gates — this is a
    // per-agent gate, not a family gate: an agent left disabled is a correct
    // outcome, but a family where nothing passed means the wiring has nothing to
    // switch on and CI should say so.
    return study.allowlist.length > 0 ? 0 : 1;
  }
  const report = runStudy(args);
  const written = writeReport(report, args.out);
  if (!args.quiet) process.stdout.write(`${renderReport(report)}\n`);
  process.stdout.write(`  report: ${written}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
  // Exit code tells CI (and the reader) which side of the gates this run fell on.
  return report.verdict === "pass" ? 0 : 1;
}

// tsup/esbuild-safe entry point check.
if (process.argv[1] && /cli\.(ts|mjs|js)$/.test(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
