/**
 * Probe 3 — DECISION-RULE COMPARISON for the proposed implementation.
 *
 * Tests three decision rules on IDENTICAL information (the same EvidenceTracker
 * rows, the same tapes, the same tick), across the lab's four worlds, with the
 * user's full contract set (Matches/Differs auto always available):
 *
 *   P0  = v1 as shipped today  (in-sample digit resolution + EV/LCB gate + 2-3 tick confirmation)
 *   P1  = v2 as shipped today  (honest shrunk estimate, but NO EV gate — "stake is valid" only)
 *   P2  = PROPOSED: honest shrunk estimate + admissibility gate
 *            (a) zTilde > 0                      survives the multiplicity threshold
 *            (b) EV(p~) = p~*P - 1 > 0          positive on the SHRUNK estimate
 *            (c) EV(p~) >= KAPPA                 minimum real edge to bother
 *
 * Capital is measured in BASE-STAKE units as sum(payout*1{win} - 1), which
 * isolates the decision layer from staking (the ladder is frozen by design).
 *
 * Worlds mirror scripts/recovery-lab/index.ts exactly.
 */

import {
  buildMarketCandidates,
  hedgePayout,
  type HedgeCandidate,
  type HedgeContractType,
  type HedgeFamilySpec,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/hedge-analysis";
import { decideHedge } from "../../artifacts/api-server/src/lib/autonomous-hedge/contest";
import { applySettlement, type HedgeMemory } from "../../artifacts/api-server/src/lib/autonomous-hedge/hedge-state";
import { hedgeGroupIndex, HEDGE_WINDOW, mulberry32 } from "../../artifacts/api-server/src/lib/autonomous-hedge/constants";
import {
  EvidenceTracker,
  type EvidenceRow,
  type MarketTapeInput,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/evidence";
import {
  gateAdmitsCandidate,
  rankV2Candidates,
  scoreV2Candidates,
  type V2LadderConfig,
  type V2ScoredCandidate,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/score-v2";

// ── World generation (faithful mirror of scripts/recovery-lab/index.ts) ───────
export type WorldId = "NULL" | "PLANTED" | "MARKOV" | "REGIME";

const MARKETS = [
  "R_10", "R_25", "R_50", "R_75", "R_100",
  "1HZ10V", "1HZ15V", "1HZ25V", "1HZ30V", "1HZ50V",
  "1HZ75V", "1HZ90V", "1HZ100V", "RDBULL", "RDBEAR",
  "JD10", "JD25", "JD50", "JD75",
];

const EVEN_DIGITS = [0, 2, 4, 6, 8];
const ODD_DIGITS = [1, 3, 5, 7, 9];
const OVER4_DIGITS = [5, 6, 7, 8, 9];
const UNDER5_DIGITS = [0, 1, 2, 3, 4];

/** The user's full selectable set — Matches/Differs auto are ALWAYS present. */
const USER_SET: HedgeFamilySpec[] = [
  { type: "CALL", barrier: -1 },
  { type: "PUT", barrier: -1 },
  { type: "DIGITOVER", barrier: 4 },
  { type: "DIGITUNDER", barrier: 5 },
  { type: "DIGITEVEN", barrier: -1 },
  { type: "DIGITODD", barrier: -1 },
  { type: "DIGITMATCH", barrier: -1 },
  { type: "DIGITDIFF", barrier: -1 },
];

function drawDigit(u: number, world: WorldId, marketIdx: number, tickIdx: number, prevDigit: number): number {
  if (marketIdx === 0) {
    if (world === "PLANTED") {
      if (u < 0.55) return EVEN_DIGITS[Math.min(4, Math.floor((u / 0.55) * 5))]!;
      return ODD_DIGITS[Math.min(4, Math.floor(((u - 0.55) / 0.45) * 5))]!;
    }
    if (world === "MARKOV") {
      const prevEven = (prevDigit & 1) === 0;
      const sameParity = u < 0.55;
      const wantEven = sameParity ? prevEven : !prevEven;
      const sub = sameParity ? u / 0.55 : (u - 0.55) / 0.45;
      const bucket = Math.min(4, Math.floor(sub * 5));
      return wantEven ? EVEN_DIGITS[bucket]! : ODD_DIGITS[bucket]!;
    }
    if (world === "REGIME" && tickIdx >= 3000) {
      if (u < 0.54) return OVER4_DIGITS[Math.min(4, Math.floor((u / 0.54) * 5))]!;
      return UNDER5_DIGITS[Math.min(4, Math.floor(((u - 0.54) / 0.46) * 5))]!;
    }
  }
  return Math.min(9, Math.floor(u * 10));
}

interface Tapes {
  digits: number[][];  // [market][tick]
  prices: number[][];
}

function generate(world: WorldId, seed: number, ticks: number): Tapes {
  const rng = mulberry32(seed);
  const digits: number[][] = [];
  const prices: number[][] = [];
  for (let m = 0; m < MARKETS.length; m++) {
    const d: number[] = [];
    const p: number[] = [];
    let price = 1000;
    let prev = 5;
    for (let t = 0; t < ticks; t++) {
      const u = rng();
      const dig = drawDigit(u, world, m, t, prev);
      prev = dig;
      d.push(dig);
      price += (rng() < 0.5 ? -1 : 1) * (0.5 + Math.floor(rng() * 3));
      p.push(price);
    }
    digits.push(d);
    prices.push(p);
  }
  return { digits, prices };
}

/** Judge a chosen contract against the tape on the settlement tick. */
function realised(
  contract: HedgeContractType,
  barrier: number,
  tapes: Tapes,
  marketIdx: number,
  t: number,
): boolean {
  const d = tapes.digits[marketIdx]!;
  const p = tapes.prices[marketIdx]!;
  const cur = d[t]!;
  const prevDig = d[t - 1]!;
  const curP = p[t]!;
  const prevP = p[t - 1]!;
  switch (contract) {
    case "DIGITOVER": return cur > barrier;
    case "DIGITUNDER": return cur < barrier;
    case "DIGITEVEN": return cur % 2 === 0;
    case "DIGITODD": return cur % 2 === 1;
    case "DIGITMATCH": return cur === barrier;
    case "DIGITDIFF": return cur !== barrier;
    case "CALL": return curP > prevP;
    case "PUT": return curP < prevP;
    default: return prevDig === cur;
  }
}

interface PolicyResult {
  trades: number;
  wins: number;
  predEv: number;
  realEv: number;
}

const empty = (): PolicyResult => ({ trades: 0, wins: 0, predEv: 0, realEv: 0 });

const TICKS = 4000;
const SEEDS = [1, 2, 3];
const WARMUP = 40;

// Same ladder shape the lab uses (frozen — only eligibility strips trades out).
const LADDER: V2LadderConfig = {
  method: "instant", autoMode: true, multiplier: 1.62, step: 1, maxRecoverySteps: 3,
  debt: 1, targetRemaining: 0.95, base: 1, maxTradeStake: 50, balance: 1000,
  consecutiveLossLimit: 10, currentLossRun: 1, hardStop: false,
};

/** Multi-window corroboration toggle (rule d), so the probe can measure it on and off. */
const CORROBORATION = process.env.GATE_CORROBORATION !== "0";

/**
 * The PRODUCTION admissibility gate. Imported rather than reimplemented so this
 * probe measures the code that actually ships.
 */
function gateAdmits(row: EvidenceRow, kappa: number): boolean {
  const payout = hedgePayout(row.spec.type, row.resolvedBarrier);
  return gateAdmitsCandidate({
    row, payout, kappa, corroboration: CORROBORATION,
  }).admits;
}

const REFIRE_COOLDOWN_TICKS = 60;

function runWorld(world: WorldId, kappa: number): { p0: PolicyResult; p1: PolicyResult; p2: PolicyResult; p3: PolicyResult } {
  const p0 = empty(), p1 = empty(), p2 = empty(), p3 = empty();
  let p0Mem: HedgeMemory = {};
  let p0LossRun = 0;

  for (const seed of SEEDS) {
    const tapes = generate(world, seed * 7919 + 13, TICKS);
    const tracker = new EvidenceTracker();
    lastFiredAt = new Map();
    p0Mem = {};
    p0LossRun = 0;

    for (let t = Math.max(WARMUP, HEDGE_WINDOW + 1); t < TICKS - 1; t++) {
      // 1. Evidence rows over the honest multi-horizon windows, ending at t-1.
      const marketInputs: MarketTapeInput[] = [];
      for (let m = 0; m < MARKETS.length; m++) {
        marketInputs.push({
          symbol: MARKETS[m]!,
          digits: tapes.digits[m]!.slice(0, t),
          prices: tapes.prices[m]!.slice(0, t),
          tickSequence: t,
          specs: USER_SET,
        });
      }
      const rows = tracker.evaluate({ markets: marketInputs, marketsScanned: MARKETS.length });

      const marketIndex = (symbol: string) => MARKETS.indexOf(symbol);

      // ── P1: v2 ranking, shipped eligibility (stake-valid only) ──
      const v2Ranked = rankV2Candidates(scoreV2Candidates({
        evidenceRows: rows,
        tickSequenceBySymbol: new Map(MARKETS.map((s) => [s, t])),
        ladder: LADDER,
      }));
      const p1Pick: V2ScoredCandidate | undefined = v2Ranked[0];
      if (p1Pick && p1Pick.eligible) {
        const won = realised(p1Pick.contract, p1Pick.barrier, tapes, marketIndex(p1Pick.symbol), t);
        p1.trades += 1; p1.wins += won ? 1 : 0;
        p1.predEv += p1Pick.pTilde * p1Pick.payout - 1;
        p1.realEv += (won ? p1Pick.payout : 0) - 1;
      }

      // ── P2: PROPOSED gate on the same rows ──
      let bestP2: { row: EvidenceRow; payout: number; ev: number } | null = null;
      for (const row of rows) {
        if (!gateAdmits(row, kappa)) continue;
        const payout = hedgePayout(row.spec.type, row.resolvedBarrier);
        const ev = row.pTilde * payout - 1;
        if (!bestP2 || ev > bestP2.ev) bestP2 = { row, payout, ev };
      }
      if (bestP2) {
        const won = realised(bestP2.row.spec.type, bestP2.row.resolvedBarrier, tapes, marketIndex(bestP2.row.symbol), t);
        p2.trades += 1; p2.wins += won ? 1 : 0;
        p2.predEv += bestP2.ev;
        p2.realEv += (won ? bestP2.payout : 0) - 1;
      }

      // ── P3: PROPOSED gate + per-key re-fire suppression (same excursion guard) ──
      if (bestP2) {
        const key = `${bestP2.row.symbol}:${bestP2.row.spec.type}:${bestP2.row.resolvedBarrier}`;
        const last = lastFiredAt.get(key);
        if (last === undefined || t - last >= REFIRE_COOLDOWN_TICKS) {
          lastFiredAt.set(key, t);
          const won3 = realised(bestP2.row.spec.type, bestP2.row.resolvedBarrier, tapes, marketIndex(bestP2.row.symbol), t);
          p3.trades += 1; p3.wins += won3 ? 1 : 0;
          p3.predEv += bestP2.ev;
          p3.realEv += (won3 ? bestP2.payout : 0) - 1;
        }
      }

      // ── P0: v1 as shipped (in-sample rows + confirmation memory) ──
      const v1Rows: HedgeCandidate[] = [];
      for (let m = 0; m < MARKETS.length; m++) {
        v1Rows.push(...buildMarketCandidates({
          symbol: MARKETS[m]!,
          group: hedgeGroupIndex(MARKETS[m]!),
          digits: tapes.digits[m]!.slice(t - HEDGE_WINDOW, t),
          prices: tapes.prices[m]!.slice(t - HEDGE_WINDOW, t),
          tickSequence: t,
          specs: USER_SET,
          mode: "RECOVERY",
          escalation: p0LossRun,
        }));
      }
      const decision = decideHedge({ rows: v1Rows, mode: "RECOVERY", memory: p0Mem, lossRun: p0LossRun });
      if (decision?.eligible) {
        const b = decision.best;
        const won = realised(b.contract, b.barrier, tapes, marketIndex(b.symbol), t);
        p0.trades += 1; p0.wins += won ? 1 : 0;
        p0.predEv += b.probability * b.payout - 1;
        p0.realEv += (won ? b.payout : 0) - 1;
        p0LossRun = won ? 0 : p0LossRun + 1;
        applySettlement(p0Mem, { won, key: b.key, lossRun: p0LossRun, decisionSequence: b.tickSequence });
      }
    }
  }
  return { p0, p1, p2, p3 };
}

let lastFiredAt = new Map<string, number>();

function line(label: string, r: PolicyResult): string {
  if (r.trades === 0) return `${label.padEnd(26)} trades=      0   capital=     0.0   (never fires)`;
  const real = r.realEv / r.trades;
  const pred = r.predEv / r.trades;
  return `${label.padEnd(26)} trades=${String(r.trades).padStart(6)}   winRate=${((r.wins / r.trades) * 100).toFixed(1).padStart(5)}%   predEV=${(pred * 100).toFixed(2).padStart(7)}%   realEV=${(real * 100).toFixed(2).padStart(7)}%   capital=${r.realEv.toFixed(1).padStart(8)}`;
}

console.log(`\n=== Decision-rule comparison | ${MARKETS.length} markets | ${SEEDS.length} seeds x ${TICKS} ticks | ladder FROZEN (instant, base 1) ===`);
console.log(`User contract set: CALL, PUT, Over 4, Under 5, Even, Odd, Matches(auto), Differs(auto)\n`);

for (const world of ["NULL", "PLANTED", "MARKOV", "REGIME"] as const) {
  const { p0, p1, p2, p3 } = runWorld(world, 0.005);
  console.log(`── ${world} ${"─".repeat(60)}`);
  console.log(line("P0 v1 (shipped)", p0));
  console.log(line("P1 v2 (shipped)", p1));
  console.log(line("P2 PROPOSED gate", p2));
  console.log(line("P3 gate + re-fire guard", p3));
  console.log("");
}

// ── Diagnosis: what are the residual NULL-world discoveries? ─────────────────
if (process.env.SHOW_RESIDUAL === "1") console.log(`\n=== Residual NULL/REGIME discoveries under the gate ===`);
if (process.env.SHOW_RESIDUAL === "1") for (const world of ["NULL"] as const) {
  for (const seed of SEEDS) {
    const tapes = generate(world, seed * 7919 + 13, TICKS);
    const tracker = new EvidenceTracker();
    for (let t = Math.max(WARMUP, HEDGE_WINDOW + 1); t < TICKS - 1; t++) {
      const marketInputs: MarketTapeInput[] = MARKETS.map((sym, m) => ({
        symbol: sym, digits: tapes.digits[m]!.slice(0, t), prices: tapes.prices[m]!.slice(0, t),
        tickSequence: t, specs: USER_SET,
      }));
      const rows = tracker.evaluate({ markets: marketInputs, marketsScanned: MARKETS.length });
      let best: { row: EvidenceRow; payout: number; ev: number } | null = null;
      for (const row of rows) {
        if (!gateAdmits(row, 0.005)) continue;
        const payout = hedgePayout(row.spec.type, row.resolvedBarrier);
        const ev = row.pTilde * payout - 1;
        if (!best || ev > best.ev) best = { row, payout, ev };
      }
      if (!best) continue;
      const won = realised(best.row.spec.type, best.row.resolvedBarrier, tapes, MARKETS.indexOf(best.row.symbol), t);
      console.log(
        `  seed ${seed} tick ${String(t).padStart(5)}  ${best.row.symbol.padEnd(8)} ${(best.row.spec.type + (best.row.resolvedBarrier >= 0 ? ":" + best.row.resolvedBarrier : "")).padEnd(14)}` +
        ` window=${String(best.row.window).padStart(4)}  nEff=${String(best.row.nEff).padStart(4)}  p0=${best.row.p0.toFixed(2)}  z=${best.row.z.toFixed(2)}  zTilde=${best.row.zTilde.toFixed(2)}  payout=${best.payout.toFixed(2)}  predEV=${(best.ev * 100).toFixed(1)}%  ${won ? "WON" : "lost"}`,
      );
    }
  }
}

console.log(`\n=== KAPPA sensitivity (capital in base-stake units; NULL should trend to 0, PLANTED must stay positive) ===`);
for (const kappa of [0.002, 0.005, 0.01, 0.02]) {
  const nul = runWorld("NULL", kappa);
  const planted = runWorld("PLANTED", kappa);
  console.log(
    `kappa=${kappa.toFixed(3)}  NULL: trades=${String(nul.p2.trades).padStart(5)} capital=${nul.p2.realEv.toFixed(1).padStart(8)}   |   PLANTED: trades=${String(planted.p2.trades).padStart(5)} capital=${planted.p2.realEv.toFixed(1).padStart(8)}  realEV=${planted.p2.trades ? ((planted.p2.realEv / planted.p2.trades) * 100).toFixed(2) : "0"}%`,
  );
}
