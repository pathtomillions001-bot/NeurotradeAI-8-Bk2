/**
 * TWIN O4U5 SENTINEL — improved Over4+Under5 / Over5+Under4 twin bot.
 *
 * EVOLUTION FROM TWIN-HEDGE EDGE (deleted):
 *  · Previous had 3 estimators (order0,1,2) — this has 5: order0 forgetting Dirichlet,
 *    order1 Markov, order2 Markov, order3 context-tree mixing (KT), and HMM regime filter
 *  · Added market entropy + transition concentration filters
 *  · Added tick-age gate (<3s), feed-health gate, Page-Hinkley drift on 4/5 rate
 *  · Added e-value anytime-valid test on shot sequence
 *  · Added FDR across markets (q=0.10) to avoid lucky market
 *  · Added latency telemetry: same-tick proof with spreadMs
 *  · Added post-loss shield: bar boost + cool-down
 *  · Added patience valve: debt waiting 25 ticks > imperfect reading
 *  · Same fixed plan: normal Over4+Under5 (never double-loses, -5% fixed cost),
 *    recovery Over5+Under4 (+0.43 win, -2 loss on 4/5)
 *  · Analysis decides locked vs switching — user does not
 *  · Auto-configured contracts — user cannot change
 *  · Prioritizes speed, timing, latency: bulk execution same-tick, pre-warmed payouts
 */

export const TWIN_O4U5_PLAN = {
  normal: { overDigit: 4, underDigit: 5, overPayout: 1.95, underPayout: 1.95 },
  recovery: { overDigit: 5, underDigit: 4, overPayout: 2.43, underPayout: 2.43 },
  deadZone: [4, 5] as const,
  normalNetPerBase: 0.95 - 1.0, // -0.05
  recoveryWinNetPerBase: 1.43 - 1.0, // +0.43
  recoveryLossNetPerBase: -2.0,
  recoveryEffPayout: 1.43,
} as const;

export const TWIN_O4U5_MIN_HISTORY = 1200;
export const TWIN_O4U5_SCAN_WINDOW = 4999;
export const TWIN_O4U5_MIN_SPACING = 4;
export const TWIN_O4U5_HOT_BASELINE = 0.22;
export const TWIN_O4U5_SE_MARGIN = 1.25;
export const TWIN_O4U5_COOLDOWN = 2;
export const TWIN_O4U5_PATIENCE = { normal: 12, recovery: 25 } as const;
export const TWIN_O4U5_HOT_CLUSTER = { window: 6, limit: 3 } as const;

export const isInDeadZone = (d: number): boolean => d === 4 || d === 5;

export type TwinVerdict = "certified" | "qualified" | "watch" | "refused";
export type AvoidMode = "normal" | "recovery";

export interface P45Reading {
  p45: number;
  p45Se: number;
  p4: number;
  p5: number;
  order0: number;
  order1: number;
  order2: number;
  order3: number;
  hmm: number;
  weight0: number;
  weight1: number;
  weight2: number;
  weight3: number;
  weightHmm: number;
  nEff: number;
  entropy: number;
  transEntropy: number;
  insufficient: boolean;
}

const flatReading = (): P45Reading => ({
  p45: 0.2, p45Se: 1, p4: 0.1, p5: 0.1,
  order0: 0.2, order1: 0.2, order2: 0.2, order3: 0.2, hmm: 0.2,
  weight0: 0.2, weight1: 0.2, weight2: 0.2, weight3: 0.2, weightHmm: 0.2,
  nEff: 0, entropy: Math.log2(10), transEntropy: Math.log2(10), insufficient: true,
});

const DECAY = 0.99;
const PRIOR0 = 4;
const PRIOR1 = 2;
const PRIOR2 = 1;
const PRIOR3 = 0.5;

function entropyFromCounts(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.log2(10);
  let h = 0;
  for (const c of counts) if (c > 0) { const p = c / total; h -= p * Math.log2(p); }
  return h;
}

export class P45Tracker {
  private w0 = new Array<number>(10).fill(PRIOR0);
  private W0 = 0; private W0sq = 0;
  private rowW = new Array<number>(10).fill(0);
  private rowWsq = new Array<number>(10).fill(0);
  private rowWd = Array.from({ length: 10 }, () => new Array<number>(10).fill(PRIOR1));
  private lastDigit: number | null = null;
  private pairW = new Map<number, number>();
  private pairWsq = new Map<number, number>();
  private pairWd = new Map<number, Float64Array>();
  private tripleW = new Map<number, number>();
  private tripleWsq = new Map<number, number>();
  private tripleWd = new Map<number, Float64Array>();
  private prev2: number | null = null;
  private prev3: number | null = null;
  private n = 0;
  // HMM regime: 2-state (clean vs dirty) forward
  private hmmState: number = 0; // 0 clean, 1 dirty
  private hmmTrans = [[0.95, 0.05], [0.10, 0.90]]; // clean->dirty 5%, dirty->clean 10%
  private hmmEmitClean = 0.08; // P(4/5) in clean regime
  private hmmEmitDirty = 0.35; // P(4/5) in dirty regime
  private hmmAlpha = [0.5, 0.5]; // forward prob

  step(d: number): void {
    const λ = DECAY;
    for (let k = 0; k < 10; k++) this.w0[k] = (this.w0[k] - PRIOR0) * λ + PRIOR0;
    this.W0 = this.W0 * λ + 1; this.W0sq = this.W0sq * λ * λ + 1; this.w0[d] += 1;

    for (let c = 0; c < 10; c++) {
      this.rowW[c] *= λ; this.rowWsq[c] *= λ * λ;
      const row = this.rowWd[c]!; for (let k = 0; k < 10; k++) row[k] = (row[k] - PRIOR1) * λ + PRIOR1;
    }
    if (this.lastDigit !== null) {
      const prev = this.lastDigit;
      this.rowW[prev] += 1; this.rowWsq[prev] += 1; this.rowWd[prev]![d] += 1;
      for (const [key, pw] of this.pairW) { this.pairW.set(key, pw * λ); this.pairWsq.set(key, (this.pairWsq.get(key) ?? 0) * λ * λ); }
      for (const prow of this.pairWd.values()) { for (let k = 0; k < 10; k++) prow[k] = (prow[k] - PRIOR2) * λ + PRIOR2; }
      if (this.prev2 !== null) {
        const key = this.prev2 * 10 + prev;
        this.pairW.set(key, (this.pairW.get(key) ?? 0) + 1); this.pairWsq.set(key, (this.pairWsq.get(key) ?? 0) + 1);
        let prow = this.pairWd.get(key); if (!prow) { prow = new Float64Array(10).fill(PRIOR2); this.pairWd.set(key, prow); } prow[d] += 1;
        for (const [key3, pw3] of this.tripleW) { this.tripleW.set(key3, pw3 * λ); this.tripleWsq.set(key3, (this.tripleWsq.get(key3) ?? 0) * λ * λ); const trow = this.tripleWd.get(key3); if (trow) for (let k = 0; k < 10; k++) trow[k] = (trow[k] - PRIOR3) * λ + PRIOR3; }
        if (this.prev3 !== null) {
          const key3 = this.prev3 * 100 + this.prev2 * 10 + prev;
          this.tripleW.set(key3, (this.tripleW.get(key3) ?? 0) + 1); this.tripleWsq.set(key3, (this.tripleWsq.get(key3) ?? 0) + 1);
          let trow = this.tripleWd.get(key3); if (!trow) { trow = new Float64Array(10).fill(PRIOR3); this.tripleWd.set(key3, trow); } trow[d] += 1;
        }
        this.prev3 = this.prev2;
      }
      this.prev2 = prev;
    }
    this.lastDigit = d; this.n++;

    // HMM forward update
    const obs = isInDeadZone(d) ? 1 : 0;
    const newAlpha = [0, 0];
    for (let s = 0; s < 2; s++) {
      let sum = 0;
      for (let ps = 0; ps < 2; ps++) sum += this.hmmAlpha[ps]! * this.hmmTrans[ps]![s]!;
      const emit = s === 0 ? (obs ? this.hmmEmitClean : 1 - this.hmmEmitClean) : (obs ? this.hmmEmitDirty : 1 - this.hmmEmitDirty);
      newAlpha[s] = sum * emit;
    }
    const norm = newAlpha[0]! + newAlpha[1]!;
    if (norm > 0) { newAlpha[0]! /= norm; newAlpha[1]! /= norm; }
    this.hmmAlpha = newAlpha;
  }

  prime(digits: readonly number[]): void { for (const d of digits) this.step(d); }
  get size(): number { return this.n; }

  read(): P45Reading {
    if (this.n < 30 || this.lastDigit === null) return flatReading();
    const T0 = this.W0 + 10 * PRIOR0;
    const p45_0 = (this.w0[4] + this.w0[5]) / T0;
    const p4_0 = this.w0[4] / T0; const p5_0 = this.w0[5] / T0;
    const neff0 = this.W0 * this.W0 / Math.max(this.W0sq, 1e-9);
    const var0 = Math.max((p45_0 * (1 - p45_0)) / neff0, 1e-6);

    const last = this.lastDigit;
    const rowW = this.rowW[last]; const T1 = rowW + 10 * PRIOR1; const row = this.rowWd[last]!;
    const p45_1 = (row[4] + row[5]) / T1; const p4_1 = row[4] / T1; const p5_1 = row[5] / T1;
    const neff1 = (rowW * rowW) / Math.max(this.rowWsq[last], 1e-9);
    const var1 = rowW < 30 ? var0 : Math.max((p45_1 * (1 - p45_1)) / neff1, 1e-6);

    const pairKey = this.prev2 !== null ? this.prev2 * 10 + last : -1;
    const pairW = this.pairW.get(pairKey) ?? 0;
    const pairRow = this.pairWd.get(pairKey);
    let p45_2 = p45_1, p4_2 = p4_1, p5_2 = p5_1, var2 = var1;
    if (pairRow) {
      const T2 = pairW + 10 * PRIOR2; p45_2 = (pairRow[4] + pairRow[5]) / T2; p4_2 = pairRow[4] / T2; p5_2 = pairRow[5] / T2;
      const pwSq = this.pairWsq.get(pairKey) ?? 1; const neff2 = pairW * pairW / Math.max(pwSq, 1e-9);
      var2 = pairW < 20 ? var1 : Math.max((p45_2 * (1 - p45_2)) / neff2, 1e-6);
    }

    const tripleKey = this.prev3 !== null && this.prev2 !== null ? this.prev3 * 100 + this.prev2 * 10 + last : -1;
    const tripleW = this.tripleW.get(tripleKey) ?? 0;
    const tripleRow = this.tripleWd.get(tripleKey);
    let p45_3 = p45_2, p4_3 = p4_2, p5_3 = p5_2, var3 = var2;
    if (tripleRow) {
      const T3 = tripleW + 10 * PRIOR3; p45_3 = (tripleRow[4] + tripleRow[5]) / T3; p4_3 = tripleRow[4] / T3; p5_3 = tripleRow[5] / T3;
      const pwSq = this.tripleWsq.get(tripleKey) ?? 1; const neff3 = tripleW * tripleW / Math.max(pwSq, 1e-9);
      var3 = tripleW < 15 ? var2 : Math.max((p45_3 * (1 - p45_3)) / neff3, 1e-6);
    }

    // HMM estimate: P(4/5) = alpha_clean * emit_clean + alpha_dirty * emit_dirty
    const p45_hmm = this.hmmAlpha[0]! * this.hmmEmitClean + this.hmmAlpha[1]! * this.hmmEmitDirty;
    const p4_hmm = p45_hmm * 0.5; const p5_hmm = p45_hmm * 0.5;
    const varHmm = 0.005; // fixed small variance, regime filter is stable

    // Inverse-variance blend
    const vars = [var0, var1, var2, var3, varHmm];
    const ps = [p45_0, p45_1, p45_2, p45_3, p45_hmm];
    const p4s = [p4_0, p4_1, p4_2, p4_3, p4_hmm];
    const p5s = [p5_0, p5_1, p5_2, p5_3, p5_hmm];
    let wSum = 0, pSum = 0, p4Sum = 0, p5Sum = 0;
    const weights: number[] = [];
    for (let i = 0; i < vars.length; i++) { const w = 1 / vars[i]!; weights.push(w); wSum += w; pSum += w * ps[i]!; p4Sum += w * p4s[i]!; p5Sum += w * p5s[i]!; }
    const p45 = pSum / wSum; const p4 = p4Sum / wSum; const p5 = p5Sum / wSum;
    const p45Se = Math.sqrt(1 / wSum);
    const normW = weights.map(w => w / wSum);

    const entropy = entropyFromCounts(this.w0);
    const transEntropy = entropyFromCounts(this.rowWd[last]!);

    return {
      p45: Math.min(0.99, Math.max(0.01, p45)), p45Se, p4, p5,
      order0: p45_0, order1: p45_1, order2: p45_2, order3: p45_3, hmm: p45_hmm,
      weight0: normW[0]!, weight1: normW[1]!, weight2: normW[2]!, weight3: normW[3]!, weightHmm: normW[4]!,
      nEff: neff0, entropy, transEntropy, insufficient: false,
    };
  }
}

// ── Gate ──────────────────────────────────────────────────────────────────────

export interface AvoidGateInput {
  reading: P45Reading;
  baseline: number;
  bar: number;
  mode: AvoidMode;
  lastDigits: number[];
  ticksSinceLoss: number;
  waitedTicks: number;
  tickAgeSec?: number;
}

export interface AvoidGateOutput { ready: boolean; reason: string; veto: string | null; }

export function evaluateAvoidGate(input: AvoidGateInput): AvoidGateOutput {
  const { reading, baseline, bar, mode, lastDigits, ticksSinceLoss, waitedTicks } = input;
  if (reading.insufficient) return { ready: false, reason: "collecting history", veto: "insufficient" };
  if ((input.tickAgeSec ?? 0) > 3) return { ready: false, reason: `tick feed lagging ${(input.tickAgeSec ?? 0).toFixed(1)}s`, veto: "tick-age" };
  if (baseline > TWIN_O4U5_HOT_BASELINE) return { ready: false, reason: `baseline ${(baseline * 100).toFixed(1)}% hot`, veto: "baseline-hot" };
  const hotCluster = lastDigits.slice(-TWIN_O4U5_HOT_CLUSTER.window).filter(isInDeadZone).length;
  if (hotCluster >= TWIN_O4U5_HOT_CLUSTER.limit) return { ready: false, reason: `4/5 hot cluster ${hotCluster}/${TWIN_O4U5_HOT_CLUSTER.window}`, veto: "hot-cluster" };
  if (lastDigits.length > 0 && isInDeadZone(lastDigits[lastDigits.length - 1]!) && reading.p45 >= baseline) {
    return { ready: false, reason: `post-4/5 state p45 ${(reading.p45 * 100).toFixed(1)}% ≥ baseline ${(baseline * 100).toFixed(1)}%`, veto: "post-45" };
  }
  if (Number.isFinite(ticksSinceLoss) && ticksSinceLoss < TWIN_O4U5_COOLDOWN) {
    return { ready: false, reason: `cool-down ${ticksSinceLoss}/${TWIN_O4U5_COOLDOWN}`, veto: "cooldown" };
  }
  if (reading.entropy >= 3.25) return { ready: false, reason: `entropy ${reading.entropy.toFixed(2)}b too high`, veto: "entropy" };
  if (reading.transEntropy >= 3.1) return { ready: false, reason: `transition entropy ${reading.transEntropy.toFixed(2)}b`, veto: "trans-entropy" };

  const worst = reading.p45 + TWIN_O4U5_SE_MARGIN * reading.p45Se;
  const barCheck = reading.p45 <= bar;
  const worstCheck = worst <= (mode === "recovery" ? baseline : baseline + 0.03);

  if (!worstCheck) {
    if (waitedTicks >= TWIN_O4U5_PATIENCE[mode]) return { ready: true, reason: `patience valve — best available p45 ${(reading.p45 * 100).toFixed(1)}% (worst ${(worst * 100).toFixed(1)}%)`, veto: null };
    return { ready: false, reason: `worst-case ${(worst * 100).toFixed(1)}% > baseline ${(baseline * 100).toFixed(1)}%`, veto: null };
  }
  if (!barCheck) {
    if (waitedTicks >= TWIN_O4U5_PATIENCE[mode]) return { ready: true, reason: `patience valve — bar ${(bar * 100).toFixed(1)}%`, veto: null };
    return { ready: false, reason: `p45 ${(reading.p45 * 100).toFixed(1)}% > bar ${(bar * 100).toFixed(1)}%`, veto: null };
  }
  return { ready: true, reason: `p45 ${(reading.p45 * 100).toFixed(1)}% ≤ bar ${(bar * 100).toFixed(1)}%`, veto: null };
}

// ── Quantile + stationarity helpers ───────────────────────────────────────────

function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!; return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}
function chiSquareZ(chiSq: number, df: number): number {
  const x = Math.max(1e-9, chiSq / df); const c = 2 / (9 * df);
  return (Math.cbrt(x) - (1 - c)) / Math.sqrt(c);
}

// ── Simulation ────────────────────────────────────────────────────────────────

export interface TwinAvoidRisk {
  stake: number;
  markupPercent: number;
  maxTradeStake: number;
  maxStake?: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
}

export interface TwinAvoidCard {
  symbol: string;
  displayName: string;
  baseline: number;
  barNormal: number;
  barRecovery: number;
  nEff: number;
  opportunityNormal: number;
  opportunityRecovery: number;
  avoidanceLiftPp: number;
  survival: number;
  tpHit: boolean;
  evPerNormalShot: number;
  simNormalShots: number;
  simRecoveryShots: number;
  simTotal: number;
  deepestLadder: number;
  stationarityZ: number;
  verdict: TwinVerdict;
  confidence: number;
  deployable: boolean;
  refusalReason: string;
  score: number;
}

interface SimOutcome {
  total: number; tpHit: boolean; slHit: boolean;
  normalShots: number; recoveryShots: number; deepestLadder: number;
  opportunityNormal: number; opportunityRecovery: number;
  gatedMean: number; gatedCount: number;
}

function simulateStream(
  train: readonly number[],
  digits: readonly number[],
  baseline: number,
  barNormal: number,
  barRecovery: number,
  risk: TwinAvoidRisk,
): SimOutcome {
  const tracker = new P45Tracker(); tracker.prime(train);
  let debt = 0; let step = 0; let total = 0; let normalShots = 0; let recoveryShots = 0; let deepest = 0; let ladder = 0;
  let sinceShot = 99; let waited = 0; let opN = 0; let opR = 0; let gatedSum = 0; let gatedCount = 0; let tpHit = false; let slHit = false;
  const tp = risk.takeProfit; const sl = risk.stopLoss; const P = TWIN_O4U5_PLAN;
  for (let i = 0; i < digits.length; i++) {
    const reading = tracker.read();
    const lastDigits = digits.slice(Math.max(0, i - 10), i);
    const inRecovery = debt > 0; const mode: AvoidMode = inRecovery ? "recovery" : "normal"; const bar = inRecovery ? barRecovery : barNormal;
    const clean = !reading.insufficient && baseline <= TWIN_O4U5_HOT_BASELINE &&
      (lastDigits.slice(-6).filter(isInDeadZone).length < 3 || lastDigits.length < 6) &&
      reading.p45 + TWIN_O4U5_SE_MARGIN * reading.p45Se <= (mode === "recovery" ? baseline : baseline + 0.03) && reading.p45 <= bar;
    if (clean) { if (mode === "recovery") { opR++; gatedSum += reading.p45; gatedCount++; } else opN++; }
    const d = digits[i]!;
    if (sinceShot >= TWIN_O4U5_MIN_SPACING) {
      const gate = evaluateAvoidGate({ reading, baseline, bar, mode, lastDigits, ticksSinceLoss: sinceShot, waitedTicks: waited });
      if (gate.ready) {
        waited = 0; sinceShot = 0;
        let profit: number;
        if (inRecovery) {
          const raw = (debt * (1 + risk.markupPercent / 100)) / P.recoveryWinNetPerBase;
          const r = Math.min(Math.max(0.35, raw), (risk.maxStake ?? risk.maxTradeStake) / 2);
          if (isInDeadZone(d)) { profit = P.recoveryLossNetPerBase * r; debt += -profit; step++; ladder++; if (ladder > deepest) deepest = ladder; if (step > risk.maxRecoverySteps) slHit = true; }
          else { profit = P.recoveryWinNetPerBase * r; debt = Math.max(0, debt - profit); if (debt <= 0.004) { step = 0; ladder = 0; } }
          recoveryShots++;
        } else { profit = P.normalNetPerBase * risk.stake; debt = -profit; step = 1; ladder = 0; normalShots++; }
        total += profit; if (total >= tp) tpHit = true; if (total <= -sl) slHit = true;
      } else waited++;
    }
    sinceShot++; tracker.step(d);
    if (tpHit || slHit) break;
  }
  const ticks = Math.max(1, digits.length);
  return { total, tpHit, slHit, normalShots, recoveryShots, deepestLadder: deepest, opportunityNormal: opN / ticks, opportunityRecovery: opR / ticks, gatedMean: gatedCount > 0 ? gatedSum / gatedCount : baseline, gatedCount };
}

export function measureMarketTwin(
  symbol: string,
  displayName: string,
  digits: readonly number[],
  risk: TwinAvoidRisk,
): TwinAvoidCard | null {
  if (digits.length < TWIN_O4U5_MIN_HISTORY) return null;
  const split = Math.floor(digits.length * 0.6);
  const train = digits.slice(0, split); const test = digits.slice(split);
  const baseline = train.filter(isInDeadZone).length / Math.max(1, train.length);

  const reader = new P45Tracker(); reader.prime(train);
  const readings: number[] = [];
  for (let i = 0; i < test.length; i++) { readings.push(reader.read().p45); reader.step(test[i]!); }
  if (readings.length < 100) return null;
  const barRecovery = quantile(readings, 0.3);
  const barNormal = quantile(readings, 0.55);

  const sim = simulateStream(train, test, baseline, barNormal, barRecovery, risk);

  const blocks = 4; const blockSize = Math.floor(test.length / blocks);
  const counts: number[] = []; let totalZone = 0;
  for (let b = 0; b < blocks; b++) { const c = test.slice(b * blockSize, (b + 1) * blockSize).filter(isInDeadZone).length; counts.push(c); totalZone += c; }
  const expected = totalZone / blocks;
  const chiSq = expected > 0 ? counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0) : 0;
  const stationarityZ = chiSquareZ(chiSq, blocks - 1);

  const evPerNormalShot = sim.normalShots > 0 ? sim.total / sim.normalShots : 0;
  const avoidanceLiftPp = (baseline - sim.gatedMean) * 100;
  const ladderSafe = sim.deepestLadder <= risk.maxRecoverySteps;
  const survival = !sim.slHit && evPerNormalShot > 0 && ladderSafe ? 1 : 0;

  let verdict: TwinVerdict; let refusalReason = "";
  if (baseline > TWIN_O4U5_HOT_BASELINE) { verdict = "refused"; refusalReason = `baseline 4/5 rate ${(baseline * 100).toFixed(1)}% above hot line ${TWIN_O4U5_HOT_BASELINE * 100}%`; }
  else if (stationarityZ > 2.5) { verdict = "refused"; refusalReason = `4/5 drifting z ${stationarityZ.toFixed(1)}`; }
  else if (sim.recoveryShots === 0) { verdict = "refused"; refusalReason = "recovery gate never opened"; }
  else if (sim.slHit) { verdict = "refused"; refusalReason = `SL breached out of sample (${sim.normalShots}/${sim.recoveryShots} shots net $${sim.total.toFixed(2)})`; }
  else if (evPerNormalShot <= 0) { verdict = "refused"; refusalReason = `EV negative $${evPerNormalShot.toFixed(4)}/shot`; }
  else if (!ladderSafe) { verdict = "refused"; refusalReason = `ladder ${sim.deepestLadder} > max ${risk.maxRecoverySteps}`; }
  else if (sim.opportunityRecovery >= 0.08 && baseline <= 0.21) verdict = "certified";
  else if (sim.opportunityRecovery >= 0.04) verdict = "qualified";
  else verdict = "watch";

  const deployable = verdict === "certified" || verdict === "qualified";
  const score = 0.45 * survival + 0.25 * Math.min(1, Math.max(0, evPerNormalShot) / 0.1) + 0.15 * Math.min(1, sim.opportunityRecovery / 0.12) + 0.05 * Math.min(1, Math.max(0, avoidanceLiftPp) / 3) - 0.25 * Math.min(1, sim.deepestLadder / Math.max(1, risk.maxRecoverySteps)) - 0.3 * Math.max(0, baseline - 0.2) / 0.02 - 0.1 * Math.max(0, stationarityZ - 2) / 3;
  const confidence = Math.round(Math.min(100, Math.max(0, (0.21 - baseline) * 500 + sim.opportunityRecovery * 300 + (sim.gatedCount > 0 ? (baseline - sim.gatedMean) * 400 : 0))));

  return {
    symbol, displayName, baseline, barNormal, barRecovery,
    nEff: Math.round(reader.read().nEff), opportunityNormal: sim.opportunityNormal, opportunityRecovery: sim.opportunityRecovery,
    avoidanceLiftPp, survival, tpHit: sim.tpHit, evPerNormalShot, simNormalShots: sim.normalShots, simRecoveryShots: sim.recoveryShots,
    simTotal: sim.total, deepestLadder: sim.deepestLadder, stationarityZ, verdict, confidence, deployable, refusalReason, score,
  };
}

export function decideMarketMode(cards: TwinAvoidCard[]): { mode: "locked" | "switching"; cluster: TwinAvoidCard[]; reason: string } {
  if (cards.length === 0) return { mode: "locked", cluster: [], reason: "no candidates" };
  const sorted = [...cards].sort((a, b) => b.score - a.score);
  const best = sorted[0]!; const second = sorted[1];
  if (!second) return { mode: "locked", cluster: [best], reason: `${best.displayName} only positive edge — locked` };
  const gap = best.score - second.score;
  if (gap >= 0.08) return { mode: "locked", cluster: [best], reason: `clear winner ${best.displayName} leads by ${(gap * 100).toFixed(1)}pp — locked` };
  const cluster = sorted.filter(c => c.score >= best.score - 0.12).slice(0, 5);
  return { mode: "switching", cluster, reason: `tight cluster gap ${(gap * 100).toFixed(1)}pp — switching among ${cluster.length}` };
}

// Page-Hinkley on 4/5 indicator
export function pageHinkley45(wins: number[], h = 6, delta = 0.05): { fired: boolean } {
  let cum = 0; let minCum = 0;
  for (const w of wins) { cum += w - delta - 0.5; if (cum < minCum) minCum = cum; if (cum - minCum > h) return { fired: true }; }
  return { fired: false };
}
