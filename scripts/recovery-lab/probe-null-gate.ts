/**
 * Probe: does the v1 autonomous gate actually select an EDGE, or noise?
 *
 * Method: generate provably edge-free tapes (uniform i.i.d. digits, i.e. what a
 * Deriv synthetic index really is), then run the REAL production decision path
 * (buildMarketCandidates + decideHedge + evaluateConfirmation + applySettlement)
 * exactly as cycle.ts does, and measure:
 *   - fire rate (how often a trade is dispatched)
 *   - predicted EV of the chosen candidate (what the engine believed)
 *   - realised EV of the chosen candidate (what the tape actually paid)
 *   - how many candidates pass the hard gate each tick (multiple comparisons)
 */

import {
  buildMarketCandidates,
  type HedgeCandidate,
  type HedgeContractType,
  type HedgeFamilySpec,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/hedge-analysis";
import { decideHedge } from "../../artifacts/api-server/src/lib/autonomous-hedge/contest";
import { applySettlement, type HedgeMemory } from "../../artifacts/api-server/src/lib/autonomous-hedge/hedge-state";
import { HEDGE_WINDOW, hedgeGroupIndex, mulberry32 } from "../../artifacts/api-server/src/lib/autonomous-hedge/constants";

const MARKETS = [
  "R_10", "R_25", "R_50", "R_75", "R_100",
  "1HZ10V", "1HZ15V", "1HZ25V", "1HZ30V", "1HZ50V",
  "1HZ75V", "1HZ90V", "1HZ100V", "RDBULL", "RDBEAR",
  "JD10", "JD25", "JD50", "JD75",
];

// Set B from the lab: Rise, Fall, Over 4, Under 5, Even, Odd, Matches auto, Differs auto
const SPECS: HedgeFamilySpec[] = [
  { type: "CALL", barrier: -1 },
  { type: "PUT", barrier: -1 },
  { type: "DIGITOVER", barrier: 4 },
  { type: "DIGITUNDER", barrier: 5 },
  { type: "DIGITEVEN", barrier: -1 },
  { type: "DIGITODD", barrier: -1 },
  { type: "DIGITMATCH", barrier: -1 },
  { type: "DIGITDIFF", barrier: -1 },
];

const TICKS = 4000;
const SEEDS = [1, 2, 3];

/** True win probability of a (contract, barrier) on a uniform-digest tape. */
function trueWinProbability(c: HedgeContractType, barrier: number, prices: number[], prev: number, cur: number): number {
  switch (c) {
    case "DIGITOVER": return (9 - barrier) / 10;
    case "DIGITUNDER": return barrier / 10;
    case "DIGITEVEN": return 0.5;
    case "DIGITODD": return 0.5;
    case "DIGITMATCH": return 0.1;   // barrier is the auto-selected digit; uniform tape
    case "DIGITDIFF": return 0.9;
    case "CALL": return 0.5;
    case "PUT": return 0.5;
    default: return 0.5;
  }
}

function outcomeOf(c: HedgeContractType, barrier: number, cur: number, prev: number, curPrice = 0, prevPrice = 0): boolean {
  switch (c) {
    case "DIGITOVER": return cur > barrier;
    case "DIGITUNDER": return cur < barrier;
    case "DIGITEVEN": return cur % 2 === 0;
    case "DIGITODD": return cur % 2 === 1;
    case "DIGITMATCH": return cur === barrier;
    case "DIGITDIFF": return cur !== barrier;
    case "CALL": return curPrice > prevPrice;
    case "PUT": return curPrice < prevPrice;
    default: return false;
  }
}

interface Acc {
  ticks: number;
  fireTicks: number;
  gatePassCounts: number[];
  predEv: number;
  realEv: number;
  wins: number;
  trades: number;
  byContract: Map<string, { n: number; predEv: number; realEv: number; wins: number }>;
}

function run(seed: number, mode: "NORMAL" | "RECOVERY"): Acc {
  const acc: Acc = {
    ticks: 0, fireTicks: 0, gatePassCounts: [], predEv: 0, realEv: 0, wins: 0, trades: 0,
    byContract: new Map(),
  };
  const rng = mulberry32(seed * 7919 + 13);
  // One independent uniform tape per market.
  const digitTapes = new Map<string, number[]>();
  const priceTapes = new Map<string, number[]>();
  for (const m of MARKETS) {
    const arr: number[] = [];
    const px: number[] = [];
    let price = 1000;
    for (let t = 0; t < TICKS; t++) {
      arr.push(Math.floor(rng() * 10));
      // Driftless random walk: P(up) = 0.5 exactly, independent of the digits.
      price += (rng() < 0.5 ? -1 : 1) * (0.5 + Math.floor(rng() * 3));
      px.push(price);
    }
    digitTapes.set(m, arr);
    priceTapes.set(m, px);
  }

  const memory: HedgeMemory = {};
  let lossRun = 0;

  for (let t = 60; t < TICKS - 1; t++) {
    const rows: HedgeCandidate[] = [];
    let gatePass = 0;
    for (const m of MARKETS) {
      const digits = digitTapes.get(m)!.slice(Math.max(0, t - HEDGE_WINDOW), t);
      const prices = priceTapes.get(m)!.slice(Math.max(0, t - HEDGE_WINDOW), t);
      const cands = buildMarketCandidates({
        symbol: m, group: hedgeGroupIndex(m), digits, prices,
        tickSequence: t, specs: SPECS, mode,
      });
      for (const c of cands) if (c.eligible) gatePass += 1;
      rows.push(...cands);
    }
    acc.ticks += 1;
    acc.gatePassCounts.push(gatePass);

    const decision = decideHedge({ rows, mode, memory, lossRun, escalation: lossRun });
    if (!decision) { memory.confirmation = undefined; continue; }

    if (!decision.eligible) continue;
    acc.fireTicks += 1;

    const b = decision.best;
    const tape = digitTapes.get(b.symbol)!;
    const cur = tape[t]!;            // the tick the 1-tick contract settles on
    const prev = tape[t - 1]!;
    const px = priceTapes.get(b.symbol)!;
    const won = outcomeOf(b.contract, b.barrier, cur, prev, px[t]!, px[t - 1]!);
    const trueP = trueWinProbability(b.contract, b.barrier, [], prev, cur);

    acc.trades += 1;
    if (won) acc.wins += 1;
    acc.predEv += b.payout * b.probability - 1;
    acc.realEv += (won ? b.payout : 0) - 1;

    const key = `${b.contract}${b.barrier >= 0 ? ":" + b.barrier : ""}`;
    const slot = acc.byContract.get(key) ?? { n: 0, predEv: 0, realEv: 0, wins: 0 };
    slot.n += 1;
    slot.wins += won ? 1 : 0;
    slot.predEv += b.payout * b.probability - 1;
    slot.realEv += (won ? b.payout : 0) - 1;
    acc.byContract.set(key, slot);

    // Advance the exact production settlement path, but skip the live/paper
    // round-trip: the ledger debt is what matters for the recovery state.
    lossRun = won ? 0 : lossRun + 1;
    applySettlement(memory, { won, key: b.key, lossRun, decisionSequence: b.tickSequence });
  }
  return acc;
}

function report(mode: "NORMAL" | "RECOVERY") {
  const totals: Acc = {
    ticks: 0, fireTicks: 0, gatePassCounts: [], predEv: 0, realEv: 0, wins: 0, trades: 0,
    byContract: new Map(),
  };
  for (const s of SEEDS) {
    const a = run(s, mode);
    totals.ticks += a.ticks;
    totals.fireTicks += a.fireTicks;
    totals.gatePassCounts.push(...a.gatePassCounts);
    totals.predEv += a.predEv;
    totals.realEv += a.realEv;
    totals.wins += a.wins;
    totals.trades += a.trades;
    for (const [k, v] of a.byContract) {
      const slot = totals.byContract.get(k) ?? { n: 0, predEv: 0, realEv: 0, wins: 0 };
      slot.n += v.n; slot.wins += v.wins; slot.predEv += v.predEv; slot.realEv += v.realEv;
      totals.byContract.set(k, slot);
    }
  }
  const meanGatePass = totals.gatePassCounts.reduce((s, v) => s + v, 0) / totals.gatePassCounts.length;
  const pctTicksWithGatePass = (totals.gatePassCounts.filter((v) => v > 0).length / totals.gatePassCounts.length) * 100;
  console.log(`\n================ ${mode} MODE — ${SEEDS.length} seeds x ${TICKS} ticks x ${MARKETS.length} markets ================`);
  console.log(`ticks evaluated                : ${totals.ticks}`);
  console.log(`mean candidates passing gate   : ${meanGatePass.toFixed(2)} per tick`);
  console.log(`ticks with >=1 gate-passing    : ${pctTicksWithGatePass.toFixed(1)}%`);
  console.log(`TRADES FIRED                   : ${totals.trades}  (${((totals.trades / totals.ticks) * 100).toFixed(1)}% of ticks)`);
  if (totals.trades === 0) return;
  const predEv = totals.predEv / totals.trades;
  const realEv = totals.realEv / totals.trades;
  const winRate = (totals.wins / totals.trades) * 100;
  console.log(`engine PREDICTED EV per trade  : ${(predEv * 100).toFixed(2)}%`);
  console.log(`REALISED  EV per trade         : ${(realEv * 100).toFixed(2)}%   <-- truth`);
  console.log(`miscalibration |pred - real|   : ${Math.abs(predEv - realEv) * 100 >= 15 ? ">15" : "~" + (Math.abs(predEv - realEv) * 100).toFixed(2)}pp`);
  console.log(`realised win rate              : ${winRate.toFixed(2)}%`);
  console.log(`capital destroyed (sum of realised EV, stake units): ${totals.realEv.toFixed(1)}`);
  console.log(`\n  by contract (what the engine actually chose):`);
  const sorted = [...totals.byContract.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [k, v] of sorted) {
    console.log(
      `   ${k.padEnd(14)} n=${String(v.n).padStart(6)}  winRate=${((v.wins / v.n) * 100).toFixed(1)}%  predEV=${((v.predEv / v.n) * 100).toFixed(2)}%  realEV=${((v.realEv / v.n) * 100).toFixed(2)}%`,
    );
  }
}

report("NORMAL");
report("RECOVERY");
