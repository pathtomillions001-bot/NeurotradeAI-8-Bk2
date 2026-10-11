/**
 * Desk v4 research harness — report rendering (WP2).
 *
 * Every harness run writes BOTH a JSON file and a markdown file. The JSON is
 * the machine-readable record (trades, decisions, actions) that a later work
 * package re-analyses; the markdown is what a human reads and what the
 * changelog cites. Neither is optional, because "the harness showed it" has to
 * mean a stored artefact, not a memory of a terminal.
 *
 * The markdown deliberately leads with what the run CANNOT tell you: the data
 * it ran on, the conventions it assumed, and how many configurations it should
 * be deflated for. A report that opens with the equity curve invites the reader
 * to skip exactly the part that determines whether the number means anything.
 */

import fs from "node:fs";
import path from "node:path";
import { attributionByExit } from "./metrics";
import { renderChecks } from "./gates";
import type { RunReport, SuiteReport } from "./types";

function fmt(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** The markdown body for a single run. */
export function renderRunMarkdown(report: RunReport): string {
  const m = report.metrics;
  const lines: string[] = [];

  lines.push(`### Run — ${report.symbol} ${report.mode} (seed ${report.seed})`);
  lines.push("");
  lines.push("**What this run is.**");
  lines.push("");
  lines.push(`- Dataset: \`${report.dataset}\``);
  lines.push(`- Bars: ${report.bars.toLocaleString("en-US")} M1, harness \`${report.harness}\``);
  lines.push(
    `- Evaluated: ${new Date(report.evaluatedFrom).toISOString()} → ${new Date(report.evaluatedTo).toISOString()}`,
  );
  lines.push(`- Decisions: ${m.evaluations.toLocaleString("en-US")} · arms ${m.arms} · fills ${m.fills}`);
  lines.push(`- Deflated for ${m.dsrTrials} configuration(s) searched.`);
  lines.push("");
  lines.push("Caveats carried by this run:");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");

  lines.push("**Headline numbers.**");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Arm rate | ${pct(m.armRate, 2)} (${m.arms}/${m.evaluations}) |`);
  lines.push(`| Fill rate (of arms) | ${pct(m.fillRate, 1)} |`);
  lines.push(`| Trades | ${m.trades} |`);
  lines.push(`| Hit rate | ${pct(m.hitRate, 1)} |`);
  lines.push(`| Mean R | ${fmt(m.meanR)} ± ${fmt(m.meanRStdError)} |`);
  lines.push(`| Median R | ${fmt(m.medianR)} |`);
  lines.push(`| Total R | ${fmt(m.totalR, 2)} |`);
  lines.push(`| 5% CVaR (mean tail loss) | ${fmt(m.cvar5R)} R |`);
  lines.push(`| Mean MAE / MFE | ${fmt(m.maeMeanR, 2)} / ${fmt(m.mfeMeanR, 2)} R |`);
  lines.push(`| Longest losing streak | ${m.longestLosingStreak} |`);
  lines.push(`| Max drawdown | ${fmt(m.maxDrawdownR, 2)} R |`);
  lines.push(`| Mean cost | ${fmt(m.costRMean)} R |`);
  lines.push(`| Probabilistic Sharpe | ${fmt(m.probabilisticSharpe)} |`);
  lines.push(`| Deflated Sharpe | ${fmt(m.deflatedSharpe)} |`);
  lines.push("");

  lines.push("**Calibration.**");
  lines.push("");
  if (m.brierScore === null) {
    lines.push("Not enough filled trades with a recorded probability to calibrate.");
  } else {
    lines.push(
      `Brier ${fmt(m.brierScore, 4)}, skill vs base rate ${fmt(m.brierSkill, 4)}, reliability slope ${fmt(m.reliabilitySlope)}.`,
    );
    lines.push("");
    lines.push("| Predicted | Observed | n |");
    lines.push("|---|---|---|");
    for (const bin of m.reliabilityBins) {
      lines.push(`| ${pct(bin.predicted)} | ${pct(bin.observed)} | ${bin.count} |`);
    }
  }
  lines.push("");

  const attribution = attributionByExit(report.trades);
  if (Object.keys(attribution).length > 0) {
    lines.push("**Attribution by exit.**");
    lines.push("");
    lines.push("| Exit | n | Mean R | Total R |");
    lines.push("|---|---|---|---|");
    for (const [reason, stats] of Object.entries(attribution)) {
      lines.push(`| ${reason} | ${stats.count} | ${fmt(stats.meanR)} | ${fmt(stats.totalR, 2)} |`);
    }
    lines.push("");
  }

  const unfilled = report.trades.filter((trade) => !trade.filled);
  if (unfilled.length > 0) {
    const reasons = new Map<string, number>();
    for (const trade of unfilled) {
      const key = trade.unfilledReason ?? "unknown";
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    lines.push("**Unfilled arms.**");
    lines.push("");
    for (const [reason, count] of reasons) lines.push(`- ${reason}: ${count}`);
    lines.push("");
  }

  lines.push("**First 20 trades.**");
  lines.push("");
  lines.push("| # | Filled | R | Exit | MAE | MFE | Bars | Actions |");
  lines.push("|---|---|---|---|---|---|---|---|");
  report.trades.slice(0, 20).forEach((trade, index) => {
    lines.push(
      `| ${index + 1} | ${trade.filled ? "yes" : (trade.unfilledReason ?? "no")} | ${fmt(trade.realisedR, 2)} | ${trade.exitReason ?? "—"} | ${fmt(trade.maeR, 2)} | ${fmt(trade.mfeR, 2)} | ${trade.barsHeld} | ${trade.actions.length} |`,
    );
  });
  lines.push("");

  return lines.join("\n");
}

/** The markdown body for a group of runs and an optional gate verdict. */
export function renderSuiteMarkdown(input: {
  title: string;
  purpose: string;
  suite: SuiteReport;
  extraSections?: string[];
}): string {
  const { title, purpose, suite } = input;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(purpose);
  lines.push("");

  if (suite.verdict) {
    lines.push(`## Verdict: ${suite.verdict.passed ? "**PASS**" : "**FAIL**"}`);
    lines.push("");
    lines.push("| Check | Result | Observed | Required |");
    lines.push("|---|---|---|---|");
    lines.push(...renderChecks(suite.verdict.checks));
    lines.push("");
  }

  if (input.extraSections) {
    for (const section of input.extraSections) {
      lines.push(section);
      lines.push("");
    }
  }

  lines.push("## Aggregate");
  lines.push("");
  const runs = suite.runs;
  if (runs.length > 0) {
    lines.push("| Seed | Dataset | Evals | Arms | Fills | Hit rate | Mean R | Total R | DSR | Rel. slope |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const run of runs) {
      lines.push(
        `| ${run.seed} | ${shortDataset(run.dataset)} | ${run.metrics.evaluations} | ${run.metrics.arms} | ${run.metrics.fills} | ${pct(run.metrics.hitRate)} | ${fmt(run.metrics.meanR)} | ${fmt(run.metrics.totalR, 2)} | ${fmt(run.metrics.deflatedSharpe)} | ${fmt(run.metrics.reliabilitySlope)} |`,
      );
    }
  } else {
    lines.push("_No runs._");
  }
  lines.push("");

  lines.push("## Runs in detail");
  lines.push("");
  for (const run of suite.runs) lines.push(renderRunMarkdown(run));

  return lines.join("\n");
}

function shortDataset(source: string): string {
  return source.length > 48 ? `${source.slice(0, 45)}...` : source;
}

/** Write a markdown + JSON pair, returning the paths. */
export function writeReport(input: {
  directory: string;
  name: string;
  markdown: string;
  json: unknown;
}): { markdownPath: string; jsonPath: string } {
  fs.mkdirSync(input.directory, { recursive: true });
  const markdownPath = path.join(input.directory, `${input.name}.md`);
  const jsonPath = path.join(input.directory, `${input.name}.json`);
  fs.writeFileSync(markdownPath, input.markdown, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(input.json, null, 2), "utf8");
  return { markdownPath, jsonPath };
}

/**
 * Strip a report to the parts worth committing.
 *
 * The full JSON carries every decision's plan snapshot and every trade's action
 * log, which is what a later work package wants to re-analyse — but three runs
 * of it is several megabytes, which does not belong in git. The compact form
 * keeps every aggregate metric, every trade's outcome and the FIRST few
 * management actions (enough to audit the shape of a trade), and replaces the
 * decision list with counts by rejection reason.
 */
const TRADE_SAMPLE = 300;

export function compactReport(report: RunReport): RunReport {
  const rejections = new Map<string, number>();
  for (const decision of report.decisions) {
    if (decision.armed) continue;
    const key = (decision.rejection ?? "unspecified").slice(0, 120);
    rejections.set(key, (rejections.get(key) ?? 0) + 1);
  }
  return {
    ...report,
    decisions: [...rejections.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([rejection, count], index) => ({
        barIndex: index,
        ts: 0,
        symbol: report.symbol,
        mode: report.mode,
        armed: false,
        predictedProbability: null,
        predictedExpectancyR: null,
        rewardRiskAtFill: null,
        qualityScore: 0,
        qualityThreshold: 0,
        rejection: `${count} x ${rejection}`,
        costR: null,
        entryTimeframe: null,
        plan: null,
      })),
    trades: report.trades.slice(0, TRADE_SAMPLE).map((trade) => ({
      ...trade,
      // Two actions are enough to see the shape of the trade (captured, then
      // the first thing the machine did); the full log stays in the run's
      // working directory.
      actions: trade.actions.slice(0, 2).map((action) => ({
        ts: action.ts,
        type: action.type,
        detail: action.detail.slice(0, 70),
      })),
    })),
    notes: [
      ...report.notes,
      `COMPACT: rejection reasons aggregated; the first ${Math.min(TRADE_SAMPLE, report.trades.length)} of ${report.trades.length} trades kept with a 2-entry action log.`,
    ],
  };
}

/** Apply {@link compactReport} to every run in a suite. */
export function compactSuite(suite: SuiteReport): SuiteReport {
  return { ...suite, runs: suite.runs.map(compactReport) };
}

/** One-line summary for the console, so a long run reports as it finishes. */
export function summarise(report: RunReport): string {
  const m = report.metrics;
  return (
    `${report.symbol} ${report.mode} seed=${report.seed}: ` +
    `arm ${(m.armRate * 100).toFixed(2)}% · fills ${m.fills} · meanR ${m.meanR.toFixed(3)} · ` +
    `hit ${(m.hitRate * 100).toFixed(1)}% · DSR ${m.deflatedSharpe.toFixed(3)}`
  );
}
