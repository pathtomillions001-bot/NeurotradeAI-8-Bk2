/**
 * Probe 2: do the three v1 RECOVERY score terms actually re-rank candidates?
 *
 * The v1 recovery score is
 *   S_R = S_0 + 18w(P(edge)-0.5) - 18w*R3L - 8*sqrt(Var)
 * The design doc claims these distinguish candidates "similar in EV" by
 * uncertainty and clustering. This measures, on real tapes from the engine's own
 * builder, how much the ranking actually changes versus S_0 alone, and what R3L
 * really is as a function of the unconditional loss rate.
 */
import {
  analyseHedgeCandidate,
  buildMarketCandidates,
  type HedgeContractType,
  type HedgeFamilySpec,
} from "../../artifacts/api-server/src/lib/autonomous-hedge/hedge-analysis";
import { HEDGE_WINDOW, hedgeGroupIndex, mulberry32 } from "../../artifacts/api-server/src/lib/autonomous-hedge/constants";

const MARKETS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ10V", "1HZ25V", "1HZ50V", "1HZ100V", "RDBULL", "RDBEAR", "JD10", "JD25", "JD50", "JD75"];
const SPECS: HedgeFamilySpec[] = [
  { type: "CALL", barrier: -1 }, { type: "PUT", barrier: -1 },
  { type: "DIGITOVER", barrier: 2 }, { type: "DIGITUNDER", barrier: 7 },
  { type: "DIGITEVEN", barrier: -1 }, { type: "DIGITODD", barrier: -1 },
];
const TICKS = 3000;

function spearman(a: number[], b: number[]): number {
  const n = a.length;
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(n);
    idx.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i]! - ma) * (rb[i]! - mb); da += (ra[i]! - ma) ** 2; db += (rb[i]! - mb) ** 2; }
  return num / Math.sqrt(da * db);
}

function baseScoreOf(c: { lowerBound: number; breakEven: number; conditionalEdge: number; ev: number; instability: number; clustering: number }): number {
  return 100 * ((c.lowerBound - c.breakEven) * 0.5 + c.conditionalEdge * 0.22 + c.ev * 0.18 - c.instability * 0.18 - Math.max(0, c.clustering - 1) * 0.07);
}

const rng = mulberry32(20241014);
const tapes = new Map<string, { digits: number[]; prices: number[] }>();
for (const m of MARKETS) {
  const digits: number[] = []; const prices: number[] = [];
  let price = 1000;
  for (let t = 0; t < TICKS; t++) {
    digits.push(Math.floor(rng() * 10));
    price += (rng() < 0.5 ? -1 : 1) * (0.5 + Math.floor(rng() * 3));
    prices.push(price);
  }
  tapes.set(m, { digits, prices });
}

const correlations: number[] = [];
let top1Agree = 0, top1Total = 0;
let recoveryTermMagnitude = 0, baseMagnitude = 0, samples = 0;

for (let t = 200; t < TICKS - 1; t += 7) {
  const rows = [];
  for (const m of MARKETS) {
    const tape = tapes.get(m)!;
    const digits = tape.digits.slice(t - HEDGE_WINDOW, t);
    const prices = tape.prices.slice(t - HEDGE_WINDOW, t);
    rows.push(...buildMarketCandidates({
      symbol: m, group: hedgeGroupIndex(m), digits, prices, tickSequence: t, specs: SPECS, mode: "RECOVERY", escalation: 2,
    }));
  }
  if (rows.length < 8) continue;
  const base = rows.map((r) => baseScoreOf(r));
  const full = rows.map((r) => r.score);
  correlations.push(spearman(base, full));
  const bestBase = rows[base.indexOf(Math.max(...base))]!;
  const bestFull = rows[full.indexOf(Math.max(...full))]!;
  top1Total += 1;
  if (bestBase.key === bestFull.key) top1Agree += 1;
  for (let i = 0; i < rows.length; i++) baseMagnitude += Math.abs(base[i]!);
  for (let i = 0; i < rows.length; i++) recoveryTermMagnitude += Math.abs(full[i]! - base[i]!);
  samples += rows.length;
}

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
console.log(`candidates per tick        : ${(samples / correlations.length).toFixed(1)}`);
console.log(`Spearman(S_0, S_R)         : ${mean(correlations).toFixed(4)}   (1.0 = recovery terms re-rank nothing)`);
console.log(`top-1 pick agreement       : ${((top1Agree / top1Total) * 100).toFixed(1)}%  (${top1Agree}/${top1Total} ticks)`);
console.log(`mean |S_0|                 : ${(baseMagnitude / samples).toFixed(2)}`);
console.log(`mean |S_R - S_0|           : ${(recoveryTermMagnitude / samples).toFixed(2)}  (the three recovery terms)`);

// R3L as a function of the unconditional loss rate: is it an independent
// clustering signal or a monotone re-encoding of 1-p?
console.log(`\nR3L vs (1-p)^3 on uniform tapes (independent -> R3L should be ~(1-p)^3):`);
for (const pTrue of [0.3, 0.5, 0.7, 0.9]) {
  let sumR3L = 0, sumCube = 0, n = 0;
  for (let trial = 0; trial < 300; trial++) {
    const wins: boolean[] = [];
    for (let i = 0; i < HEDGE_WINDOW; i++) wins.push(rng() < pTrue);
    const st = analyseHedgeCandidate({ wins, p0: pTrue, payout: 1.95, mode: "RECOVERY", escalation: 0 });
    // the code's own "1 - q_L->W" and q_L->L
    const prob = st.recoveryAfterLoss;
    const ltl = (1 - prob);
    sumR3L += st.lossRunRisk;
    sumCube += ltl * ltl * ltl;
    n += 1;
  }
  console.log(`  p=${pTrue}: R3L=${(sumR3L / n).toFixed(4)}   (1-q)^3=${(sumCube / n).toFixed(4)}`);
}
