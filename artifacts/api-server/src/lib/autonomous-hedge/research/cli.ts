/**
 * Recovery research harness — CLI (`research:recovery`).
 *
 *   pnpm --filter @workspace/api-server run research:recovery -- \
 *     --method instant --set "DIGITEVEN:-1,DIGITODD:-1" \
 *     --capital 200 --episodes 100000 --seed 1
 *
 * Modes:
 *   (default)   fast ladder sweep: one entry per contract in --set, exact
 *               shipped staking geometry, no ranker (100k+ episodes).
 *   --episode   full episode simulator running the real ranker + gates.
 *   --null      engine-selection vs random-selection null test.
 *   --audit     journal audit: hit rate vs p0 / break-even, Wilson interval,
 *               anytime-valid e-value. Reads a JSON array of
 *               {contractType, barrier, mode, won} rows (--input file.json).
 *
 * Every run leaves a JSON + markdown report behind (research-reports/recovery)
 * so a claim is always reproducible from a command line and a file.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mulberry32, splitSeed } from "./rng";
import { runLadderSweep, splitLogDebtDrift, MIN_DERIV_STAKE } from "./ladder";
import { runEpisodeSweep, specTrueP0, meanMarginPaid, type EpisodeRunResult } from "./episode";
import { summarizeEpisodes, proportionCiHalfWidth, type RecoveryMetricsSummary } from "./metrics";
import { auditJournal, type AuditTradeRow } from "./audit";
import { parseContractSpecs, contractSpecLabel } from "../contract-sets";
import { hedgePayout } from "../hedge-analysis";

interface CliOptions {
  method: "instant" | "split" | "adaptive";
  set: string;
  normalSet?: string;
  capital: number;
  base: number;
  maxStake: number;
  episodes: number;
  seed: number;
  maxTrades: number;
  mode: "ladder" | "episode" | "null" | "audit";
  selector: "engine" | "random" | "rci";
  cooldownTicks: number;
  lossLimit: number;
  maxTicks: number;
  originPayout?: number;
  lambda: number;
  budgetBase: number;
  headroomPct: number;
  maxDrawdownPct: number;
  input?: string;
  out?: string;
  name?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    method: "instant",
    set: "DIGITEVEN:-1,DIGITODD:-1",
    capital: 200,
    base: 1,
    maxStake: 500,
    episodes: 100_000,
    seed: 1,
    maxTrades: 3000,
    mode: "ladder",
    selector: "engine",
    cooldownTicks: 60,
    lossLimit: 4,
    maxTicks: 3000,
    lambda: 0.5,
    budgetBase: 25,
    headroomPct: 5,
    maxDrawdownPct: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--method": {
        const m = next();
        if (m !== "instant" && m !== "split" && m !== "adaptive") throw new Error("--method must be instant|split|adaptive");
        opts.method = m;
        break;
      }
      case "--set": opts.set = next(); break;
      case "--normal-set": opts.normalSet = next(); break;
      case "--capital": opts.capital = Number(next()); break;
      case "--base": opts.base = Number(next()); break;
      case "--max-stake": opts.maxStake = Number(next()); break;
      case "--episodes": opts.episodes = Number(next()); break;
      case "--seed": opts.seed = Number(next()); break;
      case "--max-trades": opts.maxTrades = Number(next()); break;
      case "--mode": {
        const m = next();
        if (!["ladder", "episode", "null", "audit"].includes(m)) throw new Error("--mode must be ladder|episode|null|audit");
        opts.mode = m as CliOptions["mode"];
        break;
      }
      case "--selector": {
        const s = next();
        if (s !== "engine" && s !== "random" && s !== "rci") throw new Error("--selector must be engine|random|rci");
        opts.selector = s;
        break;
      }
      case "--cooldown-ticks": opts.cooldownTicks = Number(next()); break;
      case "--loss-limit": opts.lossLimit = Number(next()); break;
      case "--max-ticks": opts.maxTicks = Number(next()); break;
      case "--origin-payout": opts.originPayout = Number(next()); break;
      case "--lambda": opts.lambda = Number(next()); break;
      case "--budget-base": opts.budgetBase = Number(next()); break;
      case "--headroom-pct": opts.headroomPct = Number(next()); break;
      case "--max-drawdown-pct": opts.maxDrawdownPct = Number(next()); break;
      case "--input": opts.input = next(); break;
      case "--out": opts.out = next(); break;
      case "--name": opts.name = next(); break;
      default:
        throw new Error(`Unknown argument ${arg}`);
    }
  }
  return opts;
}

function metricsTable(rows: Array<{ label: string; m: RecoveryMetricsSummary }>): string {
  const header = [
    "config", "episodes", "P(clear)", "P(ruin)", "P(unres)", "P(rebase)",
    "trades p50/p90/p99", "peak debt p95/p99", "mean cash", "CVaR99",
    "run≥6", "run≥8", "run≥10", "cap-trap", "latency(t)",
  ];
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
  ];
  for (const { label, m } of rows) {
    lines.push(
      `| ${label} | ${m.episodes} | ${(m.clearRate * 100).toFixed(2)}% | ${(m.ruinRate * 100).toFixed(2)}% | ${(m.unresolvedRate * 100).toFixed(2)}% | ${(m.rebaseRate * 100).toFixed(2)}% | ${m.tradesToClear.p50}/${m.tradesToClear.p90}/${m.tradesToClear.p99} | ${m.peakDebt.p95.toFixed(2)}/${m.peakDebt.p99.toFixed(2)} | ${m.meanFinalCash.toFixed(2)} | ${m.cvar99FinalCash.toFixed(2)} | ${(m.trueLossRun.pGe6 * 100).toFixed(2)}% | ${(m.trueLossRun.pGe8 * 100).toFixed(2)}% | ${(m.trueLossRun.pGe10 * 100).toFixed(2)}% | ${(m.capTrapRate * 100).toFixed(2)}% | ${m.meanDecisionLatencyTicks.toFixed(1)} |`,
    );
  }
  return lines.join("\n");
}

function writeReports(outDir: string, name: string, json: unknown, markdown: string): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const jsonPath = resolve(outDir, `${stamp}-${name}.json`);
  const mdPath = resolve(outDir, `${stamp}-${name}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(mdPath, `${markdown}\n`);
  return { jsonPath, mdPath };
}

function runLadderMode(opts: CliOptions, outDir: string): void {
  if (opts.method === "adaptive") {
    throw new Error("--mode ladder supports instant|split only; use --mode episode --method adaptive for the WP4 ladder");
  }
  const specs = parseContractSpecs(opts.set);
  if (specs.length === 0) throw new Error("Empty contract set");
  // Narrowed by the adaptive guard above; captured so closures keep the type.
  const method: "instant" | "split" = opts.method;
  const rows: Array<{ label: string; m: RecoveryMetricsSummary }> = [];
  const detail: Record<string, unknown> = {};
  specs.forEach((spec, idx) => {
    const payout = hedgePayout(spec.type, spec.digit);
    const p0 = specTrueP0(spec);
    const rng = mulberry32(splitSeed(opts.seed, idx));
    const { records } = runLadderSweep({
      rng,
      episodes: opts.episodes,
      p0,
      payout,
      baseStake: opts.base,
      capital: opts.capital,
      maxTradeStake: opts.maxStake,
      method,
      maxTrades: opts.maxTrades,
      originPayout: opts.originPayout,
    });
    const label = `${contractSpecLabel(spec)} (${opts.method})`;
    const m = summarizeEpisodes(records);
    rows.push({ label, m });
    detail[contractSpecLabel(spec)] = {
      p0,
      payout,
      margin: Number((1 - p0 * payout).toFixed(4)),
      // D1 diagnostic: the debt level where Split's log-drift turns positive.
      splitDriftAt10xBase: splitLogDebtDrift(p0, payout, opts.base, 10 * opts.base),
      splitDriftAt20xBase: splitLogDebtDrift(p0, payout, opts.base, 20 * opts.base),
      metrics: m,
    };
  });

  const md = [
    `# Recovery ladder baseline — ${opts.method}`,
    "",
    `- Command: \`research:recovery --method ${opts.method} --set "${opts.set}" --capital ${opts.capital} --base ${opts.base} --max-stake ${opts.maxStake} --episodes ${opts.episodes} --seed ${opts.seed}\``,
    `- Episodes: ${opts.episodes} per contract. Horizon: ${opts.maxTrades} trades. Ruin = balance < $${MIN_DERIV_STAKE}.`,
    "- Episode model: one base-stake normal LOSS books the debt; the shipped stake formula + limits then run against i.i.d. outcomes at the contract's true p0. No ranker, no lookahead.",
    "- TRUE loss runs are reset only by a win (cooldown resets never mask them).",
    "",
    metricsTable(rows),
    "",
    "Interpretation: mean cash ≈ −(margin) × expected volume staked; CVaR99 is the",
    "tail cost of the ladder. On i.i.d. data no staking geometry makes these",
    "positive — the table quantifies the SHAPE of the loss, not a way around it.",
  ].join("\n");
  const { jsonPath, mdPath } = writeReports(outDir, opts.name ?? `ladder-${opts.method}`, {
    kind: "ladder",
    options: opts,
    contracts: detail,
  }, md);
  console.log(md);
  console.log(`\nReports: ${jsonPath}\n         ${mdPath}`);
}

function episodeConfigFrom(opts: CliOptions) {
  const recoverySpecs = parseContractSpecs(opts.set);
  const normalSpecs = opts.normalSet ? parseContractSpecs(opts.normalSet) : undefined;
  if (recoverySpecs.length === 0) throw new Error("Empty recovery set");
  return {
    recoverySpecs,
    normalSpecs,
    capital: opts.capital,
    baseStake: opts.base,
    maxTradeStake: opts.maxStake,
    method: opts.method,
    consecutiveLossLimit: opts.lossLimit,
    cooldownTicks: opts.cooldownTicks,
    maxTicks: opts.maxTicks,
    adaptiveLambda: opts.lambda,
    adaptiveBudgetBase: opts.budgetBase,
    adaptiveHeadroomPct: opts.headroomPct,
    maxDrawdownPct: opts.maxDrawdownPct,
  };
}

function runEpisodeMode(opts: CliOptions, outDir: string): void {
  const cfg = episodeConfigFrom(opts);
  const rng = mulberry32(opts.seed);
  const records = runEpisodeSweep({ episodes: opts.episodes, rng, cfg, selector: opts.selector });
  const m = summarizeEpisodes(records);
  const totalRecoveryTrades = records.reduce((s, r) => s + r.recoveryTrades, 0);
  const totalWins = records.reduce((s, r) => s + Math.round(r.hitRate * r.recoveryTrades), 0);
  const hitRate = totalRecoveryTrades > 0 ? totalWins / totalRecoveryTrades : 0;
  const md = [
    `# Recovery episode baseline — ${opts.method} (${opts.selector} selection)`,
    "",
    `- Command: \`research:recovery --mode episode --method ${opts.method} --selector ${opts.selector} --set "${opts.set}" --episodes ${opts.episodes} --seed ${opts.seed}\``,
    `- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → ${opts.cooldownTicks}-tick cooldown → streak reset (D6 semantics).`,
    `- Recovery trades: ${totalRecoveryTrades}. Combined recovery hit rate: ${(hitRate * 100).toFixed(2)}% (detectable edge at this N: ±${(proportionCiHalfWidth(totalRecoveryTrades) * 100).toFixed(2)}pt).`,
    "",
    metricsTable([{ label: `${opts.method}/${opts.selector}`, m }]),
  ].join("\n");
  const { jsonPath, mdPath } = writeReports(outDir, opts.name ?? `episode-${opts.method}-${opts.selector}`, {
    kind: "episode",
    options: opts,
    hitRate,
    totalRecoveryTrades,
    metrics: m,
  }, md);
  console.log(md);
  console.log(`\nReports: ${jsonPath}\n         ${mdPath}`);
}

function hitRateOf(records: EpisodeRunResult[]): { hr: number; n: number } {
  const n = records.reduce((s, r) => s + r.recoveryTrades, 0);
  const hr = n > 0 ? records.reduce((s, r) => s + Math.round(r.hitRate * r.recoveryTrades), 0) / n : 0;
  return { hr, n };
}

function runNullMode(opts: CliOptions, outDir: string): void {
  const cfg = episodeConfigFrom(opts);
  const engine = runEpisodeSweep({ episodes: opts.episodes, rng: mulberry32(splitSeed(opts.seed, 1)), cfg, selector: "engine" });
  const random = runEpisodeSweep({ episodes: opts.episodes, rng: mulberry32(splitSeed(opts.seed, 2)), cfg, selector: "random" });
  const rci = runEpisodeSweep({ episodes: opts.episodes, rng: mulberry32(splitSeed(opts.seed, 3)), cfg, selector: "rci" });
  const mEngine = summarizeEpisodes(engine);
  const mRandom = summarizeEpisodes(random);
  const mRci = summarizeEpisodes(rci);
  const e = hitRateOf(engine);
  const r = hitRateOf(random);
  const c = hitRateOf(rci);
  const power = proportionCiHalfWidth(Math.min(e.n, r.n, c.n));
  const indistinguishable = Math.abs(e.hr - r.hr) <= power;
  const marginEngine = meanMarginPaid(engine);
  const marginRandom = meanMarginPaid(random);
  const marginRci = meanMarginPaid(rci);
  const rciBeatsBoth = marginRci <= marginEngine + 1e-12 && marginRci <= marginRandom + 1e-12;
  const md = [
    `# Recovery selection null test — ${opts.method}`,
    "",
    `- Command: \`research:recovery --mode null --method ${opts.method} --set "${opts.set}" --episodes ${opts.episodes} --seed ${opts.seed}\``,
    `- Engine arm runs the shipped ranker + gates; random arm draws a uniform contract; RCI arm uses the WP3 Recovery Cost Index. All arms trade i.i.d. tapes with the SAME stake formula and cooldown rules.`,
    `- Hit rate: engine ${(e.hr * 100).toFixed(2)}% (${e.n}) vs random ${(r.hr * 100).toFixed(2)}% (${r.n}) vs RCI ${(c.hr * 100).toFixed(2)}% (${c.n}).`,
    `- Mean margin paid per $ staked: engine ${(marginEngine * 100).toFixed(3)}% · random ${(marginRandom * 100).toFixed(3)}% · RCI ${(marginRci * 100).toFixed(3)}%.`,
    `- Decision latency (ticks): engine ${mEngine.meanDecisionLatencyTicks.toFixed(1)} · random ${mRandom.meanDecisionLatencyTicks.toFixed(1)} · RCI ${mRci.meanDecisionLatencyTicks.toFixed(1)}.`,
    `- Detectable edge at this N ≈ ±${(power * 100).toFixed(2)}pt (2·√(0.25/N)).`,
    `- VERDICT (selection skill): ${indistinguishable ? "engine selection is statistically INDISTINGUISHABLE from random choice on i.i.d. data (as expected)" : "arms differ beyond Monte-Carlo power — investigate before trusting either"}.`,
    `- VERDICT (WP3 cost gate): RCI margin ≤ engine AND ≤ random → ${rciBeatsBoth ? "PASS" : "FAIL"}; RCI latency ≤ 1 tick of the watched market → ${mRci.meanDecisionLatencyTicks <= 1.0 ? "PASS" : "FAIL"}.`,
    "",
    metricsTable([
      { label: `${opts.method}/engine`, m: mEngine },
      { label: `${opts.method}/random`, m: mRandom },
      { label: `${opts.method}/rci`, m: mRci },
    ]),
  ].join("\n");
  const { jsonPath, mdPath } = writeReports(outDir, opts.name ?? `null-${opts.method}`, {
    kind: "null",
    options: opts,
    engine: { hitRate: e.hr, trades: e.n, metrics: mEngine, meanMarginPaid: marginEngine },
    random: { hitRate: r.hr, trades: r.n, metrics: mRandom, meanMarginPaid: marginRandom },
    rci: { hitRate: c.hr, trades: c.n, metrics: mRci, meanMarginPaid: marginRci },
    powerAtN: power,
    indistinguishable,
    rciMarginGatePass: rciBeatsBoth,
    rciLatencyGatePass: mRci.meanDecisionLatencyTicks <= 1.0,
  }, md);
  console.log(md);
  console.log(`\nReports: ${jsonPath}\n         ${mdPath}`);
}

function runAuditMode(opts: CliOptions, outDir: string): void {
  if (!opts.input) throw new Error("--audit needs --input <file.json> (array of {contractType, barrier, mode, won})");
  const raw = JSON.parse(readFileSync(resolve(opts.input), "utf8")) as AuditTradeRow[];
  const reports = auditJournal(raw);
  const lines = [
    "# Recovery journal audit",
    "",
    `- Input: ${opts.input} (${raw.length} rows)`,
    "- Wilson 95% interval; e-values are anytime-valid mixture likelihood ratios",
    "  (≥ 20 is the WP6 tilt gate — on honest i.i.d. data they stay small).",
    "",
    "| contract | mode | trades | hit rate | p0 | break-even | Wilson 95% | e(p>p0) | e(p>BE) |",
    "|---|---|---|---|---|---|---|---|---|",
    ...reports.map((r) =>
      `| ${r.contract} | ${r.mode} | ${r.trades} | ${(r.hitRate * 100).toFixed(2)}% | ${(r.p0 * 100).toFixed(1)}% | ${(r.breakEven * 100).toFixed(1)}% | [${(r.wilson.lower * 100).toFixed(1)}%, ${(r.wilson.upper * 100).toFixed(1)}%] | ${r.eValueVsP0.toFixed(2)} | ${r.eValueVsBreakEven.toFixed(2)} |`,
    ),
  ];
  const { jsonPath, mdPath } = writeReports(outDir, opts.name ?? "audit", { kind: "audit", rows: raw.length, reports }, lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`\nReports: ${jsonPath}\n         ${mdPath}`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = opts.out ?? resolve(process.cwd(), "research-reports", "recovery");
  switch (opts.mode) {
    case "ladder": return runLadderMode(opts, outDir);
    case "episode": return runEpisodeMode(opts, outDir);
    case "null": return runNullMode(opts, outDir);
    case "audit": return runAuditMode(opts, outDir);
  }
}

main();
