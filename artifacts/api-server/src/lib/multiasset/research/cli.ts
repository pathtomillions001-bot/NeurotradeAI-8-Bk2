/**
 * Desk v4 research harness — CLI (WP2).
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run research:run -- \
 *     --mode intraday --data <bars.csv> --seed 1
 *
 *   # Control runs, no broker data required:
 *   pnpm --filter @workspace/api-server run research:run -- \
 *     --mode intraday --gate null --seeds 1,2,3,4,5 --out research-reports
 *
 *   pnpm --filter @workspace/api-server run research:run -- \
 *     --mode intraday --gate control --seeds 1,2,3 --bars 40000
 *
 * The CLI never invents a result: if it cannot load what it was asked for, it
 * exits non-zero with the reason. A report that silently fell back to different
 * data would be worse than no report.
 */

import fs from "node:fs";
import path from "node:path";
import { loadDataset, reportsDir } from "./data";
import {
  DEFAULT_GENERATOR_OPTIONS,
  GENERATOR_KINDS,
  blockShuffledReturns,
  driftlessRandomWalk,
  generate,
  phaseRandomisedReturns,
  positiveControl,
  returnsFromBars,
  type GeneratorKind,
} from "./generators";
import { evaluateCalibrationGate, evaluateNullGate, evaluatePositiveControlGate } from "./gates";
import { HARNESS_VERSION, runHarness, type HarnessOptions } from "./harness";
import { compactSuite, renderSuiteMarkdown, summarise, writeReport } from "./report";
import { specFromJson, specFromPreset } from "./spec";
import type { Dataset, RunReport, SuiteReport } from "./types";
import type { TradeMode } from "../types";

interface CliArgs {
  mode: TradeMode;
  data: string | null;
  specPath: string | null;
  symbol: string;
  generator: GeneratorKind | null;
  gate: "null" | "control" | "baseline" | "calibration";
  seeds: number[];
  bars: number;
  barVol: number;
  spreadPoints: number;
  blockLength: number;
  stepBars: number;
  brokerOffsetMinutes: number;
  out: string | null;
  name: string | null;
  quiet: boolean;
  compact: boolean;
}

const USAGE = `research:run — desk v4 harness

  --mode <scalp|intraday|swing>     trading mode to evaluate (default intraday)
  --data <path>                     MT5 M1 bars CSV (see research/data.ts for the export steps)
  --generator <kind>                ${GENERATOR_KINDS.join(" | ")}
  --gate <null|control|baseline|calibration>  which acceptance gate to report (default baseline)
  --seeds <a,b,c>                   seeds to run (default 1); each seed is one datum for the gates
  --bars <n>                        synthetic dataset length in M1 bars
  --symbol <SYM>                    symbol for the preset spec (default EURUSD)
  --spec <path>                     SymbolSpec JSON exported from the terminal (overrides preset)
  --bar-vol <v>                     per-bar log-return sigma for synthetic data (default 1e-4)
  --spread <points>                 synthetic spread in points (default from the spec)
  --block <n>                       block length for block_shuffle (default 60)
  --step <n>                        evaluate a decision every n M1 bars (default 15)
  --broker-offset <minutes>         recorded broker offset for a real export
  --out <dir>                       report directory (default <cwd>/research-reports)
  --name <stem>                     report file stem
  --compact                         write the small JSON (aggregates + trades, no plan snapshots)
  --quiet                           summary lines only
`;

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
  };
  const mode = (get("--mode") ?? "intraday") as TradeMode;
  if (!["scalp", "intraday", "swing"].includes(mode)) {
    throw new Error(`Unknown --mode "${mode}". Use scalp, intraday or swing.`);
  }
  let generator = get("--generator") as GeneratorKind | null;
  if (generator && !GENERATOR_KINDS.includes(generator)) {
    throw new Error(`Unknown --generator "${generator}". Use ${GENERATOR_KINDS.join(", ")}.`);
  }
  const gate = (get("--gate") ?? "baseline") as CliArgs["gate"];
  // Sensible pairing: asking for a gate without naming a generator picks the
  // dataset that gate is about. Explicit is still better, and the report says
  // which generator actually ran.
  if (!generator && !get("--data")) {
    if (gate === "control") generator = "positive_control";
    else if (gate === "null") generator = "driftless";
  }
  const seedsText = get("--seeds") ?? get("--seed") ?? "1";
  const seeds = seedsText
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  if (seeds.length === 0) throw new Error("--seeds must contain at least one number.");

  return {
    mode,
    data: get("--data"),
    specPath: get("--spec"),
    symbol: (get("--symbol") ?? "EURUSD").toUpperCase(),
    generator,
    gate,
    seeds,
    bars: Number(get("--bars") ?? DEFAULT_GENERATOR_OPTIONS.bars),
    barVol: Number(get("--bar-vol") ?? DEFAULT_GENERATOR_OPTIONS.barVol),
    spreadPoints: get("--spread") ? Number(get("--spread")) : 0,
    blockLength: Number(get("--block") ?? 60),
    stepBars: Number(get("--step") ?? 15),
    brokerOffsetMinutes: Number(get("--broker-offset") ?? 0),
    out: get("--out"),
    name: get("--name"),
    quiet: argv.includes("--quiet"),
    compact: argv.includes("--compact"),
  };
}

function resolveSpec(args: CliArgs) {
  if (args.specPath) {
    return specFromJson(fs.readFileSync(args.specPath, "utf8"), args.symbol);
  }
  return specFromPreset(args.symbol, args.spreadPoints || undefined);
}

/** Build the dataset for one seed, real data or synthetic. */
function datasetForSeed(args: CliArgs, seed: number, realReturns: number[] | null): Dataset {
  const spec = resolveSpec(args);

  if (args.data && !args.generator) {
    return loadDataset({
      file: args.data,
      spec,
      brokerOffsetMinutes: args.brokerOffsetMinutes,
      fallbackSpreadPoints: args.spreadPoints || undefined,
    });
  }

  const options = {
    symbol: args.symbol,
    seed,
    bars: args.bars,
    barVol: args.barVol,
    spreadPoints: args.spreadPoints || spec.spreadPoints,
  };

  if (!args.generator) {
    throw new Error("Provide --data <bars.csv> or --generator <kind>.");
  }
  if ((args.generator === "block_shuffle" || args.generator === "phase_random") && !realReturns) {
    throw new Error(
      `--generator ${args.generator} resamples REAL returns; pass --data <bars.csv> as its source.`,
    );
  }
  if (args.generator === "block_shuffle") {
    return blockShuffledReturns({ returns: realReturns!, options, blockLength: args.blockLength });
  }
  if (args.generator === "phase_random") {
    return phaseRandomisedReturns({ returns: realReturns!, options });
  }
  return generate(args.generator, options);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const args = parseArgs(argv);

  // Real returns, when a real dataset is present, so the null generators can
  // resample the actual marginal distribution instead of a GBM's.
  let realReturns: number[] | null = null;
  if (args.data) {
    const spec = resolveSpec(args);
    const real = loadDataset({
      file: args.data,
      spec,
      brokerOffsetMinutes: args.brokerOffsetMinutes,
      fallbackSpreadPoints: args.spreadPoints || undefined,
    });
    realReturns = returnsFromBars(real.bars);
    if (!args.quiet) {
      process.stdout.write(
        `Loaded ${real.bars.length.toLocaleString("en-US")} bars from ${args.data}\n` +
          (real.notes ?? []).map((note) => `  note: ${note}\n`).join(""),
      );
    }
  }

  const reports: RunReport[] = [];
  for (const seed of args.seeds) {
    const dataset = datasetForSeed(args, seed, realReturns);
    const options: HarnessOptions = {
      mode: args.mode,
      seed,
      stepBars: args.stepBars,
      // Every configuration in this invocation counts towards the deflation, so
      // a search over seeds cannot present its best seed as if it were the only
      // one tried.
      dsrTrials: args.seeds.length,
      onProgress: args.quiet
        ? undefined
        : (done, total) => {
            if (done % 250 === 0 || done === total) {
              process.stdout.write(`\r  ${done}/${total} evaluations…`);
            }
          },
    };
    const run = runHarness(dataset, options);
    if (!args.quiet) process.stdout.write("\r");
    reports.push(run.report);
    process.stdout.write(`${summarise(run.report)}\n`);
  }

  let suite: SuiteReport;
  let title: string;
  let purpose: string;
  if (args.gate === "null") {
    suite = evaluateNullGate(reports);
    title = `Desk v4 — NULL gate (${args.mode})`;
    purpose =
      "Datasets with no exploitable structure. The desk must arm rarely (≤3%), must not lose more " +
      "than the round-trip cost, and must not manufacture statistical significance.";
  } else if (args.gate === "control") {
    suite = evaluatePositiveControlGate(reports);
    title = `Desk v4 — POSITIVE CONTROL (${args.mode})`;
    purpose =
      "A market with a deliberate, persistent edge (regime-switching drift plus AR(1) mean " +
      "reversion). A pipeline that cannot find THIS is blind, and its restraint on the nulls " +
      "means nothing.";
  } else if (args.gate === "calibration") {
    suite = evaluateCalibrationGate(reports[reports.length - 1]!);
    title = `Desk v4 — CALIBRATION (${args.mode})`;
    purpose =
      "Reliability of the printed probability. A slope near 1 and a positive Brier skill mean the " +
      "number the desk shows is the number the market delivered.";
  } else {
    suite = { gate: "baseline", runs: reports, verdict: null };
    title = `Desk v4 — BASELINE (${args.mode})`;
    purpose =
      "The CURRENT desk, measured. No gate: this run exists to establish the starting point, not " +
      "to pass anything.";
  }

  const directory = args.out ?? reportsDir(process.cwd());
  const name =
    args.name ??
    `${suite.gate}-${args.mode}-${args.seeds.length === 1 ? `seed${args.seeds[0]}` : `${args.seeds.length}seeds`}`;
  const markdown = renderSuiteMarkdown({
    title,
    purpose,
    suite,
    extraSections: [
      `Harness \`${HARNESS_VERSION}\`. Reproduce with:\n\n\`\`\`\n${reproduceCommand(argv)}\n\`\`\``,
    ],
  });
  const { markdownPath, jsonPath } = writeReport({
    directory,
    name,
    markdown,
    json: args.compact ? compactSuite(suite) : suite,
  });

  process.stdout.write(`\n${suite.verdict ? `Verdict: ${suite.verdict.passed ? "PASS" : "FAIL"}\n` : ""}`);
  process.stdout.write(`Wrote ${path.relative(process.cwd(), markdownPath)}\n`);
  process.stdout.write(`Wrote ${path.relative(process.cwd(), jsonPath)}\n`);
  if (suite.verdict && !suite.verdict.passed) process.exitCode = 1;
}

function reproduceCommand(argv: string[]): string {
  // pnpm forwards its own `--` separator into argv; it is not part of the
  // invocation a reader should retype.
  const clean = argv.filter((value) => value !== "--");
  return `pnpm --filter @workspace/api-server run research:run -- ${clean.join(" ")}`;
}

main();
