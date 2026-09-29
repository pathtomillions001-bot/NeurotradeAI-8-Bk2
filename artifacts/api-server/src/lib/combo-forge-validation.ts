/**
 * Combo Forge validation harness.
 *
 * Runs the vendored RUNTIME module (`combo-forge-analysis.js` — what the
 * generated bot actually executes, not the typed port) and the Omni Forge
 * runtime gate on IDENTICAL synthetic streams and reports, honestly:
 *
 *   1. NULL      — i.i.d. ticks, no edge anywhere. The false-fire rate of the
 *                  gate per evaluation must be ≤ its nominal α, and the
 *                  realised return of the trades it does take must equal
 *                  −(house margin) within sampling error.
 *   2. LADDER    — whole sessions (normal → recovery ladder → TP/SL/breaker)
 *                  on null tapes: total P&L ÷ total staked ≈ −margin. The
 *                  shared recovery ladder must not manufacture or destroy
 *                  expectation.
 *   3. POWER     — planted edges of +3/+6/+10/+15 points above a contract's
 *                  break-even: detection rate and time, and the realised
 *                  return after detection, against the forge-time claim.
 *   4. HEAD-TO-HEAD — the same null and planted streams through the Omni
 *                  Forge gate.
 *   5. REPLAY    — any recorded tape (CSV of quotes) can be replayed with
 *                  `--replay file.csv`. No recorded Deriv tape is reachable
 *                  from CI, so the default run replays an adversarial
 *                  SYNTHETIC tape (regime switches, digit clustering) and is
 *                  labelled as such.
 *
 * Nothing here can make the tape fairer or less fair — it only measures.
 *
 *   cd artifacts/api-server
 *   npx tsx src/lib/combo-forge-validation.ts            # full report (minutes)
 *   npx tsx src/lib/combo-forge-validation.ts --quick    # small, seconds
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { mulberry32, comboFairRate, comboLabel, analyseComboGate, type ComboSpec } from "./combo-forge-analysis";

const here = path.dirname(fileURLToPath(import.meta.url));
const TRADE_DIR = path.resolve(here, "../../../dbot-builder/src/external/bot-skeleton/services/tradeEngine/trade");

let runtime: any;
let omniRuntime: any;
async function load(): Promise<void> {
  if (runtime) return;
  const a: any = await import(path.join(TRADE_DIR, "combo-forge-analysis.js"));
  runtime = a.default ?? a;
  const b: any = await import(path.join(TRADE_DIR, "omni-forge-analysis.js"));
  omniRuntime = b.default ?? b;
}

// ── Streams ─────────────────────────────────────────────────────────────────

export interface Market {
  symbol: string;
  digits: Uint8Array;
  quotes: Float64Array;
}

/** i.i.d. fair market: uniform digits, symmetric ±0.01 quote steps (no flats). */
export function iidMarket(symbol: string, n: number, seed: number): Market {
  const rand = mulberry32(seed);
  const digits = new Uint8Array(n);
  const quotes = new Float64Array(n);
  let q = 1000;
  for (let i = 0; i < n; i++) {
    digits[i] = Math.floor(rand() * 10);
    q += rand() < 0.5 ? 0.01 : -0.01;
    quotes[i] = Math.round(q * 100) / 100;
  }
  return { symbol, digits, quotes };
}

/** Planted edge: the contract wins with probability `p` on every tick (other digits/directions fair). */
export function plantedMarket(symbol: string, n: number, seed: number, spec: ComboSpec, p: number): Market {
  const base = iidMarket(symbol, n, seed);
  const rand = mulberry32(seed ^ 0x5bd1e995);
  if (spec.type === "CALL" || spec.type === "PUT") {
    let q = 1000;
    for (let i = 0; i < n; i++) {
      const win = rand() < p;
      const up = spec.type === "CALL" ? win : !win;
      q += up ? 0.01 : -0.01;
      base.quotes[i] = Math.round(q * 100) / 100;
    }
    return base;
  }
  const wins: number[] = [];
  const loses: number[] = [];
  for (let d = 0; d <= 9; d++) (winFn(spec)(d) ? wins : loses).push(d);
  for (let i = 0; i < n; i++) {
    const pool = rand() < p ? wins : loses;
    base.digits[i] = pool[Math.floor(rand() * pool.length)]!;
  }
  return base;
}

/** Adversarial synthetic tape: digit clustering + regime switches. NOT recorded data. */
export function adversarialMarket(symbol: string, n: number, seed: number): Market {
  const rand = mulberry32(seed);
  const digits = new Uint8Array(n);
  const quotes = new Float64Array(n);
  let q = 1000;
  let regime = 0;
  let hot = 0;
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) { regime = Math.floor(rand() * 3); hot = Math.floor(rand() * 10); }
    const r = rand();
    digits[i] = regime === 0 ? Math.floor(rand() * 10) : r < (regime === 1 ? 0.25 : 0.4) ? hot : Math.floor(rand() * 10);
    const up = regime === 2 ? 0.58 : regime === 1 ? 0.45 : 0.5;
    q += rand() < up ? 0.01 : -0.01;
    quotes[i] = Math.round(q * 100) / 100;
  }
  return { symbol, digits, quotes };
}

export function loadReplayCsv(file: string, symbol = "REPLAY"): Market {
  const raw = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const nums = raw.map((l) => Number(l.split(",").pop())).filter((v) => Number.isFinite(v));
  const pip = Math.max(...raw.map((l) => (l.split(",").pop()!.split(".")[1] ?? "").length), 2);
  return {
    symbol,
    quotes: Float64Array.from(nums),
    digits: Uint8Array.from(nums.map((v) => Number(v.toFixed(pip).slice(-1)))),
  };
}

function winFn(spec: ComboSpec): (d: number) => boolean {
  switch (spec.type) {
    case "DIGITOVER": return (d) => d > spec.digit;
    case "DIGITUNDER": return (d) => d < spec.digit;
    case "DIGITEVEN": return (d) => d % 2 === 0;
    case "DIGITODD": return (d) => d % 2 === 1;
    case "DIGITMATCH": return (d) => d === spec.digit;
    case "DIGITDIFF": return (d) => d !== spec.digit;
    default: return () => false;
  }
}

/** Did `spec` win on tick `t` of `m`? (Rise/Fall: relative to tick t−1; a flat is a loss.) */
export function wins(m: Market, t: number, spec: ComboSpec): boolean {
  if (spec.type === "CALL") return m.quotes[t]! > m.quotes[t - 1]!;
  if (spec.type === "PUT") return m.quotes[t]! < m.quotes[t - 1]!;
  return winFn(spec)(m.digits[t]!);
}

export const PAYOUT: Record<string, number> = {
  DIGITEVEN: 1.95, DIGITODD: 1.95, DIGITMATCH: 8.93, DIGITDIFF: 1.09, CALL: 1.92, PUT: 1.92,
};
export function payoutOf(spec: ComboSpec): number {
  if (spec.type === "DIGITOVER") return ({ 0: 1.09, 1: 1.23, 2: 1.35, 3: 1.52, 4: 1.95, 5: 2.26, 6: 2.78, 7: 3.74, 8: 8.93 } as Record<number, number>)[spec.digit] ?? 1.95;
  if (spec.type === "DIGITUNDER") return ({ 9: 1.09, 8: 1.23, 7: 1.4, 6: 1.63, 5: 1.95, 4: 2.42, 3: 3.25, 2: 4.9, 1: 9.85 } as Record<number, number>)[spec.digit] ?? 1.95;
  return PAYOUT[spec.type]!;
}
export const marginOf = (spec: ComboSpec): number => 1 - comboFairRate(spec) * payoutOf(spec);

const csvOf = (specs: ComboSpec[]): string => specs.map((s) => `${s.type}:${s.digit}:${payoutOf(s)}`).join(",");
const slice = (m: Market, end: number, w: number) => ({
  symbol: m.symbol,
  digits: Array.from(m.digits.subarray(Math.max(0, end - w), end)),
  quotes: Array.from(m.quotes.subarray(Math.max(0, end - w), end)),
});

// ── Gates under test ────────────────────────────────────────────────────────

export interface GateDecision { fire: boolean; symbol: string; spec: ComboSpec }
export type Gate = (markets: Market[], end: number, current: string) => GateDecision | null;

export function comboGate(specs: ComboSpec[], opts: { strictness: "strict" | "balanced" | "always"; window: number; mode?: "NORMAL" | "RECOVERY"; debt?: number; balance?: number }): Gate {
  const contracts = runtime.parseComboContracts(csvOf(specs));
  return (markets, end, current) => {
    const r = runtime.analyseCombo({
      mode: opts.mode ?? "NORMAL", strictness: opts.strictness,
      tapes: markets.map((m) => slice(m, end, opts.window)), contracts, currentSymbol: current,
      window: opts.window, rho: 0, debt: opts.debt ?? 0, markupPercent: 10, maxStake: 500, balance: opts.balance ?? 1000,
    });
    const d = r.decision;
    if (!d) return null;
    const spec: ComboSpec = { type: d.contract, digit: d.barrier };
    return { fire: d.eligible === true, symbol: d.symbol, spec };
  };
}

/** Omni Forge's runtime gate, run exactly as `ntAnalyseContracts` ranks: best score wins, fires iff eligible. */
export function omniGate(specs: ComboSpec[], opts: { window: number }): Gate {
  const digitSpecs = specs.filter((s) => s.type !== "CALL" && s.type !== "PUT");
  return (markets, end) => {
    let best: { score: number; eligible: boolean; symbol: string; spec: ComboSpec } | null = null;
    for (const m of markets) {
      const tail = Array.from(m.digits.subarray(Math.max(0, end - opts.window), end));
      for (const spec of digitSpecs) {
        const fn = winFn(spec);
        const row = omniRuntime.analyseOmniForgeCandidate({
          wins: tail.map(fn), p0: comboFairRate(spec), payout: payoutOf(spec), mode: "NORMAL",
        });
        if (!best || (row.eligible && !best.eligible) || (row.eligible === best.eligible && row.score > best.score)) {
          best = { score: row.score, eligible: row.eligible, symbol: m.symbol, spec };
        }
      }
    }
    return best ? { fire: best.eligible, symbol: best.symbol, spec: best.spec } : null;
  };
}

// ── 1. Null harness ─────────────────────────────────────────────────────────

export interface NullResult {
  gate: string;
  evaluations: number;
  fires: number;
  fireRate: number;
  /** Wilson-ish 95% upper bound on the fire rate. */
  fireRateUpper95: number;
  trades: number;
  returnPerDollar: number;
  expectedReturnPerDollar: number;
  zScore: number;
  byContract: Record<string, { trades: number; meanReturn: number; expected: number }>;
}

export function runNull(name: string, gate: Gate, opts: { markets: number; ticks: number; every: number; window: number; seed: number }): NullResult {
  const markets = Array.from({ length: opts.markets }, (_, i) => iidMarket(`M${i}`, opts.ticks, opts.seed + i * 7919));
  let evaluations = 0, fires = 0, trades = 0, pnl = 0, expected = 0, variance = 0;
  const per: Record<string, { n: number; pnl: number; exp: number }> = {};
  for (let t = Math.max(opts.window, 100); t < opts.ticks - 1; t += opts.every) {
    evaluations += 1;
    const d = gate(markets, t, markets[0]!.symbol);
    if (!d || !d.fire) continue;
    fires += 1;
    const m = markets.find((x) => x.symbol === d.symbol)!;
    const payout = payoutOf(d.spec);
    const win = wins(m, t, d.spec);
    const ret = win ? payout - 1 : -1;
    const p0 = comboFairRate(d.spec);
    const e = p0 * payout - 1;
    trades += 1; pnl += ret; expected += e; variance += p0 * (1 - p0) * payout * payout;
    const key = comboLabel(d.spec);
    (per[key] ??= { n: 0, pnl: 0, exp: 0 });
    per[key]!.n += 1; per[key]!.pnl += ret; per[key]!.exp += e;
  }
  const rate = evaluations ? fires / evaluations : 0;
  const z = 1.96;
  const upper = evaluations ? (rate + (z * z) / (2 * evaluations) + z * Math.sqrt((rate * (1 - rate)) / evaluations + (z * z) / (4 * evaluations * evaluations))) / (1 + (z * z) / evaluations) : 0;
  return {
    gate: name, evaluations, fires, fireRate: rate, fireRateUpper95: upper, trades,
    returnPerDollar: trades ? pnl / trades : 0,
    expectedReturnPerDollar: trades ? expected / trades : 0,
    zScore: variance > 0 ? (pnl - expected) / Math.sqrt(variance) : 0,
    byContract: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { trades: v.n, meanReturn: v.pnl / v.n, expected: v.exp / v.n }])),
  };
}

// ── 2. Ladder sessions on null tapes ────────────────────────────────────────

export interface LadderResult {
  sessions: number;
  trades: number;
  totalStaked: number;
  totalPnl: number;
  pnlPerDollarStaked: number;
  expectedPerDollarStaked: number;
  zScore: number;
  endings: Record<string, number>;
  maxStakeSeen: number;
  minStakeSeen: number;
}

/** The shared ladder, verbatim: clamp(debt·(1+m)/(payout−1), 0.35, cap), round UP to the cent, ≤ balance. */
export function ladderStake(debt: number, payout: number, markupPercent: number, maxStake: number, balance: number): number {
  let s = Math.min(maxStake, Math.max(0.35, (debt * (1 + markupPercent / 100)) / (payout - 1)));
  s = Math.ceil((s - 1e-9) * 100) / 100;
  if (s > balance) s = Math.floor(balance * 100) / 100;
  return Math.max(0.35, s);
}

export function runLadderSessions(opts: {
  normal: ComboSpec[]; recovery: ComboSpec[]; strictness: "strict" | "balanced" | "always";
  sessions: number; markets: number; seed: number; stake: number; takeProfit: number; stopLoss: number;
  maxRecoverySteps: number; breakerDepth: number; window: number; recoveryPatience: number; normalPatience: number; maxTicks: number;
  /** Ticks between evaluations while waiting for a qualified setup (the real bot evaluates every tick). */
  waitStep: number;
}): LadderResult {
  const normalGate = comboGate(opts.normal, { strictness: opts.strictness, window: opts.window, mode: "NORMAL" });
  const endings: Record<string, number> = { "take-profit": 0, "stop-loss": 0, breaker: 0, "tape-end": 0 };
  let trades = 0, staked = 0, pnl = 0, expected = 0, variance = 0, maxSeen = 0, minSeen = Infinity;
  for (let s = 0; s < opts.sessions; s++) {
    const markets = Array.from({ length: opts.markets }, (_, i) => iidMarket(`M${i}`, opts.maxTicks, opts.seed + s * 104729 + i * 7919));
    let t = opts.window + 5, balance = 1000, total = 0, debt = 0, step = 0, lossRun = 0, evals = 0;
    let ending = "tape-end";
    while (t < opts.maxTicks - 2) {
      const recovering = debt > 0.005;
      const gate = recovering
        ? comboGate(opts.recovery, { strictness: opts.strictness, window: opts.window, mode: "RECOVERY", debt, balance })
        : normalGate;
      evals += 1;
      const d = gate(markets, t, markets[0]!.symbol);
      const patience = recovering ? opts.recoveryPatience : opts.normalPatience;
      const fire = d && (d.fire || (patience > 0 && evals >= patience));
      if (!fire || !d) { t += opts.waitStep; continue; }
      const payout = payoutOf(d.spec);
      const stake = recovering ? ladderStake(debt, payout, 10, 500, balance) : opts.stake;
      maxSeen = Math.max(maxSeen, stake); minSeen = Math.min(minSeen, stake);
      const m = markets.find((x) => x.symbol === d.symbol)!;
      const win = wins(m, t, d.spec);
      const profit = win ? Math.round(stake * (payout - 1) * 100) / 100 : -stake;
      const p0 = comboFairRate(d.spec);
      trades += 1; staked += stake; pnl += profit; total += profit; balance += profit;
      expected += stake * (p0 * payout - 1); variance += stake * stake * p0 * (1 - p0) * payout * payout;
      t += 1; evals = 0;
      if (win) {
        lossRun = 0;
        if (recovering) { debt = Math.round((debt - profit) * 100) / 100; if (debt <= 0.005) { debt = 0; step = 0; } }
      } else {
        lossRun += 1;
        if (recovering) { step = Math.min(opts.maxRecoverySteps, step + 1); debt = Math.round((debt + stake) * 100) / 100; }
        else { step = 1; debt = stake; }
      }
      if (total >= opts.takeProfit) { ending = "take-profit"; break; }
      if (total <= -opts.stopLoss) { ending = "stop-loss"; break; }
      if (lossRun >= opts.breakerDepth) { ending = "breaker"; break; }
    }
    endings[ending] = (endings[ending] ?? 0) + 1;
  }
  return {
    sessions: opts.sessions, trades, totalStaked: staked, totalPnl: pnl,
    pnlPerDollarStaked: staked ? pnl / staked : 0, expectedPerDollarStaked: staked ? expected / staked : 0,
    zScore: variance > 0 ? (pnl - expected) / Math.sqrt(variance) : 0, endings,
    maxStakeSeen: maxSeen, minStakeSeen: Number.isFinite(minSeen) ? minSeen : 0,
  };
}

// ── 3 + 4. Planted-edge power ───────────────────────────────────────────────

export interface PowerResult {
  gate: string;
  edge: number;
  trueWinRate: number;
  replicates: number;
  detectedWithin500: number;
  detectedWithin1000: number;
  medianTicksToDetect: number | null;
  falseContractFires: number;
  returnAfterDetect: number | null;
  theoreticalReturn: number;
}

export function runPower(name: string, makeGate: (window: number) => Gate, target: ComboSpec, edge: number, opts: { replicates: number; seed: number; markets: number; maxTicks: number; minTicks: number; every: number; windowFor: (t: number) => number }): PowerResult {
  const breakEven = 1 / payoutOf(target);
  const p = Math.min(0.995, breakEven + edge);
  const detect: number[] = [];
  let within500 = 0, within1000 = 0, otherFires = 0, pnl = 0, pnlN = 0;
  for (let r = 0; r < opts.replicates; r++) {
    const seed = opts.seed + r * 6151;
    const markets = [plantedMarket("M0", opts.maxTicks + 2, seed, target, p), ...Array.from({ length: opts.markets - 1 }, (_, i) => iidMarket(`M${i + 1}`, opts.maxTicks + 2, seed + (i + 1) * 911))];
    let found: number | null = null;
    for (let t = opts.minTicks; t <= opts.maxTicks; t += opts.every) {
      const gate = makeGate(opts.windowFor(t));
      const d = gate(markets, t, "M0");
      if (!d?.fire) continue;
      const hit = d.symbol === "M0" && d.spec.type === target.type && (d.spec.digit === target.digit || target.digit < 0);
      if (hit) {
        found = t;
        pnl += wins(markets[0]!, t, target) ? payoutOf(target) - 1 : -1; pnlN += 1;
        break;
      }
      otherFires += 1;
      break; // fired on something that is NOT the planted edge
    }
    if (found !== null) { detect.push(found); if (found <= 500) within500 += 1; if (found <= 1000) within1000 += 1; }
  }
  detect.sort((a, b) => a - b);
  return {
    gate: name, edge, trueWinRate: p, replicates: opts.replicates,
    detectedWithin500: within500 / opts.replicates, detectedWithin1000: within1000 / opts.replicates,
    medianTicksToDetect: detect.length >= opts.replicates / 2 ? detect[Math.floor(opts.replicates / 2)]! : null,
    falseContractFires: otherFires / opts.replicates,
    returnAfterDetect: pnlN ? pnl / pnlN : null, theoreticalReturn: p * payoutOf(target) - 1,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

const READING_NOTE = "\n## How to read this (honestly)\n\n- **Null tapes (1, 2):** on i.i.d. ticks no gate can have an edge, so the only thing a gate can change is how often it pays the house margin. A gate that fires on a fair tape is just trading. Strict and Balanced fire far *below* their nominal \u03b1 (the e-process is deliberately conservative: it is valid, not tight), so they mostly stay out; Always-trade and the Omni gate trade almost every evaluation and realise \u2248 \u2212margin, which is the expected value of a fair tape. Realised P&L per $ staked matches \u2212margin within sampling error (|z| < 2) in every row that has enough trades.\n- **Power (3, 4):** the price of that conservatism is slower detection. Quoted \"ticks to detect\" figures in the console come from a seeded simulation of the real gate; the information-theoretic floor is shown beside them. Edges of +3 points are effectively invisible inside a 1000-tick window. The Omni gate appears to \"detect\" sooner in some rows only because it also fires on contracts that have no edge (see \"fires on something else\"), which is not detection.\n- **Replay (5):** no recorded Deriv tape is reachable from this environment, so the replay is an adversarial *synthetic* tape that contains real, exploitable structure. Both gates profit there, and Omni's gate profits at least as much because it takes more trades. That says the two gates can both find large structure; it does not say a live Deriv tape contains any. Run `--replay quotes.csv` on a real recording to get that answer.\n- **What this does not show:** nothing here promises a win rate or profit on a live, fair synthetic index. The expected result on such a tape is \u2212margin per $ staked for every strategy, including this one.\n";

async function main(): Promise<void> {
  await load();
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const replayIdx = args.indexOf("--replay");
  const NORMAL: ComboSpec[] = [
    { type: "DIGITOVER", digit: 1 }, { type: "DIGITUNDER", digit: 8 }, { type: "DIGITEVEN", digit: -1 },
    { type: "DIGITODD", digit: -1 }, { type: "CALL", digit: -1 }, { type: "PUT", digit: -1 },
  ];
  const DIGITS_ONLY = NORMAL.filter((s) => s.type !== "CALL" && s.type !== "PUT");
  const out: string[] = [];
  const log = (s = "") => { out.push(s); console.log(s); };
  const t0 = Date.now();

  const nullTicks = quick ? 120_000 : 1_000_000;
  const every = quick ? 60 : 100;
  log(`# Combo Forge validation ${quick ? "(quick)" : "(full)"}`);
  log(`\n## 1. Null harness — ${nullTicks.toLocaleString()} i.i.d. ticks × 4 markets, evaluation every ${every} ticks, window 500`);
  log("| gate | evaluations | fires | fire rate | 95% upper | nominal α | trades | return/$ | expected −margin/$ | z |");
  log("|---|---|---|---|---|---|---|---|---|---|");
  const nullCfg = { markets: 4, ticks: nullTicks, every, window: 500, seed: 424242 };
  const rows: Array<[string, Gate, string]> = [
    ["Combo strict", comboGate(NORMAL, { strictness: "strict", window: 500 }), "5%"],
    ["Combo balanced", comboGate(NORMAL, { strictness: "balanced", window: 500 }), "25%"],
    ["Combo always", comboGate(NORMAL, { strictness: "always", window: 500 }), "—"],
    ["Omni gate (digits only, window 120)", omniGate(DIGITS_ONLY, { window: 120 }), "—"],
    ["Omni gate (digits only, window 500)", omniGate(DIGITS_ONLY, { window: 500 }), "—"],
  ];
  const byContractNotes: string[] = [];
  for (const [name, gate, alpha] of rows) {
    const r = runNull(name, gate, nullCfg);
    log(`| ${name} | ${r.evaluations} | ${r.fires} | ${pct(r.fireRate, 2)} | ${pct(r.fireRateUpper95, 2)} | ${alpha} | ${r.trades} | ${r.trades ? pct(r.returnPerDollar, 2) : "—"} | ${r.trades ? pct(r.expectedReturnPerDollar, 2) : "—"} | ${r.trades ? r.zScore.toFixed(2) : "—"} |`);
    if (r.trades >= 50) byContractNotes.push(`${name}: ${Object.entries(r.byContract).map(([k, v]) => `${k} ${v.trades}× ${pct(v.meanReturn, 1)} (exp ${pct(v.expected, 1)})`).join("; ")}`);
  }
  if (byContractNotes.length) { log("\nPer-contract realised vs expected return:"); byContractNotes.forEach((n) => log(`- ${n}`)); }

  log(`\n## 2. Ladder sessions on null tapes (shared recovery formula, TP 10 / SL 5 / breaker 6 / 3 steps)`);
  log("| mode | sessions | trades | staked | P&L | P&L per $ staked | expected | z | take-profit | stop-loss | breaker | tape-end | stake range |");
  log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const strictness of ["always", "balanced", "strict"] as const) {
    const sessions = strictness === "strict" ? (quick ? 8 : 30) : strictness === "balanced" ? (quick ? 20 : 120) : quick ? 40 : 300;
    const r = runLadderSessions({
      normal: NORMAL, recovery: [{ type: "DIGITEVEN", digit: -1 }, { type: "DIGITOVER", digit: 4 }, { type: "PUT", digit: -1 }],
      strictness, sessions, markets: 4, seed: 99, stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, breakerDepth: 6,
      window: 300, recoveryPatience: 20, normalPatience: strictness === "always" ? 1 : 0, maxTicks: strictness === "strict" ? 4000 : 1500, waitStep: 10,
    });
    log(`| ${strictness} | ${r.sessions} | ${r.trades} | ${r.totalStaked.toFixed(0)} | ${r.totalPnl.toFixed(1)} | ${pct(r.pnlPerDollarStaked, 2)} | ${pct(r.expectedPerDollarStaked, 2)} | ${r.zScore.toFixed(2)} | ${r.endings["take-profit"]} | ${r.endings["stop-loss"]} | ${r.endings.breaker} | ${r.endings["tape-end"]} | ${r.minStakeSeen.toFixed(2)}–${r.maxStakeSeen.toFixed(2)} |`);
  }

  log(`\n## 3+4. Planted-edge power — Over 1 (payout 1.23, break-even 81.3%), one edge market among 4, evidence grows with ticks (window = ticks so far, max 1000)`);
  log("| gate | edge | true win rate | detected ≤500 | detected ≤1000 | median ticks | fires on something else | return after detect | theory |");
  log("|---|---|---|---|---|---|---|---|---|");
  const target: ComboSpec = { type: "DIGITOVER", digit: 1 };
  const reps = quick ? 25 : 120;
  const claim = analyseComboGate([{ ...target, payout: 1.23 }], { window: 1000, strictness: "strict", candidates: 6 * 4, tapes: 10 })[0]!;
  for (const edge of quick ? [0.06, 0.1] : [0.03, 0.06, 0.1, 0.15]) {
    const base = { replicates: reps, seed: 777, markets: 4, maxTicks: 1000, minTicks: 100, every: quick ? 50 : 25 };
    const cases: Array<[string, (w: number) => Gate]> = [
      ["Combo strict", (w) => comboGate(NORMAL, { strictness: "strict", window: Math.min(1000, w) })],
      ["Combo balanced", (w) => comboGate(NORMAL, { strictness: "balanced", window: Math.min(1000, w) })],
      ["Omni gate (window 120)", () => omniGate(DIGITS_ONLY, { window: 120 })],
    ];
    for (const [name, mk] of cases) {
      const r = runPower(name, mk, target, edge, { ...base, windowFor: (t) => t });
      log(`| ${name} | +${(edge * 100).toFixed(0)} pts | ${pct(r.trueWinRate)} | ${pct(r.detectedWithin500, 0)} | ${pct(r.detectedWithin1000, 0)} | ${r.medianTicksToDetect ?? "—"} | ${pct(r.falseContractFires, 0)} | ${r.returnAfterDetect === null ? "—" : pct(r.returnAfterDetect, 1)} | ${pct(r.theoreticalReturn, 1)} |`);
    }
  }
  const claimed = claim.ticksToDetect.map((t) => `+${(t.edge * 100).toFixed(0)}pts ≈ ${t.ticks ?? ">1000"} ticks (floor ${t.idealTicks})`).join(", ");
  log(`\nForge-time claim for Over 1 under strict (K=24), as the console quotes it (seeded simulation of the real gate; floor = threshold ÷ KL with the true rate known): ${claimed}. Compare with the measured medians above.`);

  log(`\n## 5. Replay`);
  if (replayIdx >= 0 && args[replayIdx + 1]) {
    const m = loadReplayCsv(args[replayIdx + 1]!);
    log(`Recorded tape ${args[replayIdx + 1]} — ${m.quotes.length} ticks.`);
    replay(m, NORMAL, log);
  } else {
    log("No recorded Deriv tape is reachable from this environment (no network access to Deriv). Replaying an adversarial SYNTHETIC tape instead (regime switches every 400 ticks, digit clustering, drift) — this is a stress test, NOT recorded data. Pass `--replay quotes.csv` (one quote per line, or `epoch,quote`) to replay a real recording.");
    replay(adversarialMarket("ADV", quick ? 20_000 : 120_000, 31337), NORMAL, log);
  }
  log(READING_NOTE);
  log(`\n_Elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s._`);
  if (args.includes("--report")) {
    const { writeFileSync } = await import("node:fs");
    const file = path.resolve(here, "../../validation/combo-forge-validation.md");
    writeFileSync(file, out.join("\n") + "\n");
    console.log(`wrote ${file}`);
  }
}

function replay(m: Market, specs: ComboSpec[], log: (s?: string) => void): void {
  log("| gate | evaluations | fires | trades | realised return/$ | expected if tape were fair/$ |");
  log("|---|---|---|---|---|---|");
  const gates: Array<[string, Gate]> = [
    ["Combo strict", comboGate(specs, { strictness: "strict", window: 500 })],
    ["Combo balanced", comboGate(specs, { strictness: "balanced", window: 500 })],
    ["Omni gate (digits, window 120)", omniGate(specs, { window: 120 })],
  ];
  for (const [name, gate] of gates) {
    let ev = 0, fires = 0, pnl = 0, exp = 0;
    for (let t = 500; t < m.quotes.length - 1; t += 50) {
      ev += 1;
      const d = gate([m], t, m.symbol);
      if (!d?.fire) continue;
      fires += 1;
      const payout = payoutOf(d.spec);
      pnl += wins(m, t, d.spec) ? payout - 1 : -1;
      exp += comboFairRate(d.spec) * payout - 1;
    }
    log(`| ${name} | ${ev} | ${fires} | ${fires} | ${fires ? pct(pnl / fires, 1) : "—"} | ${fires ? pct(exp / fires, 1) : "—"} |`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { load as loadValidationRuntime };
