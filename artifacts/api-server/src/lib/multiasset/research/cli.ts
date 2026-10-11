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
  warmupBars: number;
  trials: number;
  out: string | null;
  label: string;
  quiet: boolean;
  spec: ReturnType<typeof specForSymbol>;
  specOverrides: Parameters<typeof specForSymbol>[1];
  strategy: StrategyChoice;
  regimeFitBars: number;
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
  return {
    strategy,
    regimeFitBars: Math.max(200, Math.floor(num("regime-fit-bars", DEFAULT_REGIME_HMM_CONFIG.fitBars))),
    mode,
    data: flags.get("data") ?? "synthetic:all",
    symbol,
    timeframe: (flags.get("timeframe") ?? "M1") as Timeframe,
    serverOffsetMinutes: num("server-offset-minutes", 0),
    seed: num("seed", 1),
    runs: Math.max(1, Math.floor(num("runs", 8))),
    stride: Math.max(1, Math.floor(num("stride", 5))),
    bars: Math.max(300, Math.floor(num("bars", 2400))),
    includeTrades: flags.get("include-trades") === "true",
    horizonBars: Math.max(5, Math.floor(num("horizon-bars", 30))),
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
