/**
 * Replay the desk's decision logic on a CSV of M1 bars and print the record.
 *
 *   pnpm --filter @workspace/api-server backtest -- \
 *     --csv data/EURUSD_M1.csv --spec data/EURUSD.spec.json --mode intraday
 *
 * Options
 *   --csv <path>               M1 bars: time,open,high,low,close[,volume]   (required)
 *   --spec <path>              the symbol's SymbolSpec as JSON               (required)
 *   --symbol <name>            default: spec.symbol
 *   --mode scalp|intraday|swing                                             (default intraday)
 *   --balance <n>              starting balance, account currency           (default 10000)
 *   --spread-points <n>        fixed spread in points                       (default spec.spreadPoints)
 *   --slippage-points <n>      adverse slippage on fills and stops          (default 2)
 *   --commission-per-lot <n>   per lot per side, account currency           (default spec.commissionPerLot)
 *   --every <n>                evaluate every n M1 bars                     (default 5)
 *   --from <iso> --to <iso>    restrict the window
 *   --out <path>               also write the full result as JSON
 *
 * Times in the CSV are read as UTC. MT5 exports are in the broker's server time,
 * so export with the server offset removed, or the sessions will be misaligned.
 *
 * What this prints is a check on the logic over one history, with the costs you
 * give it. It is not a forecast, and it does not model news, the daily-loss halts,
 * or the broker's real spread and fill behaviour.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCsv, runBacktest, type BacktestConfig } from "./backtest";
import { DEFAULT_RISK_POLICY } from "./risk";
import type { SymbolSpec, TradeMode } from "./types";

const MODES: readonly TradeMode[] = ["scalp", "intraday", "swing"];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}".`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
    out[arg.slice(2)] = value;
    i++;
  }
  return out;
}

function num(args: Record<string, string>, key: string, fallback: number): number {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number.`);
  return value;
}

function timeArg(args: Record<string, string>, key: string): number | undefined {
  if (args[key] === undefined) return undefined;
  const value = Date.parse(args[key] as string);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be an ISO date, e.g. 2025-01-01.`);
  return value;
}

const f = (value: number | null | undefined, digits = 2): string => {
  if (value === Number.POSITIVE_INFINITY) return "∞ (no losing trades)";
  return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
};

export function main(argv: string[]): void {
  const args = parseArgs(argv);
  if (!args.csv || !args.spec) {
    throw new Error("Both --csv and --spec are required. See the header of backtest-cli.ts.");
  }
  // Validate the arguments before touching the disk, so a typo reports itself.
  const mode = (args.mode ?? "intraday") as TradeMode;
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(", ")}.`);
  const spec = JSON.parse(readFileSync(args.spec, "utf8")) as SymbolSpec;

  const bars = parseCsv(readFileSync(args.csv, "utf8"));
  const config: BacktestConfig = {
    symbol: args.symbol ?? spec.symbol,
    mode,
    spec,
    balance: num(args, "balance", 10_000),
    spreadPoints: num(args, "spread-points", spec.spreadPoints),
    slippagePoints: num(args, "slippage-points", 2),
    commissionPerLot: num(args, "commission-per-lot", spec.commissionPerLot),
    decisionEvery: num(args, "every", 5),
    from: timeArg(args, "from"),
    to: timeArg(args, "to"),
  };

  const started = Date.now();
  const result = runBacktest(bars, config);
  const m = result.metrics;
  const winRate = m.winRate;

  const lines = [
    `Backtest ${config.symbol} · ${mode} · ${path.basename(args.csv)}`,
    `  bars ${result.counts.bars}   decisions ${result.counts.decisions}   armed ${result.counts.armed}   filled ${result.counts.filled}   expired ${result.counts.expired}   errors ${result.counts.errors}`,
    `  costs: spread ${config.spreadPoints} pts · slippage ${config.slippagePoints} pts · commission ${config.commissionPerLot}/lot/side`,
    "",
    `  trades            ${m.trades}`,
    `  win rate          ${f(winRate !== null && winRate !== undefined ? winRate * 100 : null, 1)}%`,
    `  expectancy        ${f(m.expectancyR, 3)} R   95% CI [${f(m.expectancyCI95.low, 3)}, ${f(m.expectancyCI95.high, 3)}]`,
    `  profit factor     ${f(m.profitFactor)}`,
    `  Sharpe (annual)   ${f(m.sharpeAnnualised)}   per trade ${f(m.sharpePerTrade, 3)}`,
    `  Sortino           ${f(m.sortino)}`,
    `  max drawdown      ${f(m.maxDrawdownPct)}% at ${DEFAULT_RISK_POLICY.baseRiskPct}% risk per trade`,
    `  t-statistic       ${f(m.tStat)}`,
    "",
    "  exits:",
    ...tally(result.trades.map((t) => t.reason)).map(([reason, count]) => `    ${reason.padEnd(16)} ${count}`),
  ];
  if (result.refusals.length > 0) {
    lines.push("", "  most common refusals:");
    for (const refusal of result.refusals.slice(0, 5)) lines.push(`    ${String(refusal.count).padStart(5)}  ${refusal.reason}`);
  }
  if (result.firstError) lines.push("", `  first error: ${result.firstError}`);
  lines.push("", `  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  console.log(lines.join("\n"));

  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ config: { ...config, spec: undefined }, ...result }, null, 2));
    console.log(`  full result written to ${args.out}`);
  }
}

function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Run only when executed directly (tsx src/lib/multiasset/backtest-cli.ts ...).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
