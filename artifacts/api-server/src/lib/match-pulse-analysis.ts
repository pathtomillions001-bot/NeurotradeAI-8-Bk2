/**
 * Match Pulse: a causal, Matches-only selective predictor.
 *
 * A digit is never "due". On an independent uniform stream every digit is still
 * 10%, irrespective of its gap. We only consider supported conditional counts,
 * then test the WHOLE adaptive digit-selection rule on unseen next ticks.
 *
 * No threshold is fitted on validation/audit outcomes. The same model, digit
 * selector and tick-based cooldown are used by replay and by the live engine.
 * Statistical evidence is not a guarantee of future performance.
 */
import { MATCH_PAYOUT } from "./payouts";

export const PULSE = {
  version: "match-pulse-v1",
  history: 4999,
  minHistory: 1800,
  window: 2400,
  recentWindow: 600,
  minProbability: 0.22,
  entryMargin: 0.02,
  z: 2.576,
  minSupport: [400, 60, 24],
  minRecentSupport: [200, 18, 6],
  minBlockShots: 16,
  minShots: 48,
  minSpacing: 4,
  lossCooldown: 8,
  clusterCooldown: 32,
  scanAlpha: 0.02,
} as const;

export interface PulseReading {
  digit: number;
  probability: number;
  lower: number;
  recentProbability: number;
  support: number;
  recentSupport: number;
  order: 0 | 1 | 2;
  context: string;
  driftZ: number;
  ready: boolean;
  reason: string;
}

interface Observation { digit: number; one: number; two: number }

/** Sliding sufficient statistics; the target is inserted only AFTER prediction. */
class Counts {
  private rows = Array.from({ length: 111 }, () => new Float64Array(10));
  private totals = new Float64Array(111);
  private queue: Observation[] = [];
  private head = 0;
  constructor(private readonly capacity: number) {}

  add(observation: Observation): void {
    this.adjust(observation, 1);
    this.queue.push(observation);
    if (this.queue.length - this.head > this.capacity) {
      this.adjust(this.queue[this.head++]!, -1);
    }
    if (this.head > this.capacity) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }

  private adjust(o: Observation, by: number): void {
    for (const row of [0, o.one < 0 ? -1 : 1 + o.one, o.two < 0 ? -1 : 11 + o.two]) {
      if (row < 0) continue;
      this.rows[row]![o.digit]! += by;
      this.totals[row]! += by;
    }
  }

  get(row: number, digit: number): { hits: number; n: number } {
    return { hits: this.rows[row]![digit]!, n: this.totals[row]! };
  }
}

/** One-sided Wilson bound. A descriptive bound, not a claim of IID shots. */
export function pulseLower(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n));
}

export class PulseModel {
  private long = new Counts(PULSE.window);
  private recent = new Counts(PULSE.recentWindow);
  private previous = -1;
  private penultimate = -1;
  count = 0;

  observe(digit: number): void {
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
      throw new Error("Match Pulse requires an uninterrupted sequence of integer digits 0–9");
    }
    const observation = {
      digit,
      one: this.previous,
      two: this.penultimate < 0 ? -1 : this.penultimate * 10 + this.previous,
    };
    this.long.add(observation);
    this.recent.add(observation);
    this.penultimate = this.previous;
    this.previous = digit;
    this.count++;
  }

  /** All ten digits are considered causally; no full-history hot-digit pre-screen. */
  read(payout = MATCH_PAYOUT, lockedDigit?: number): PulseReading {
    if (!Number.isFinite(payout) || payout <= 1) throw new Error("Invalid Matches payout");
    if (lockedDigit !== undefined && (!Number.isInteger(lockedDigit) || lockedDigit < 0 || lockedDigit > 9)) {
      throw new Error("Invalid locked digit");
    }
    const breakEven = 1 / payout;
    const candidates: PulseReading[] = [];
    const rows = [0, this.previous < 0 ? -1 : 1 + this.previous,
      this.penultimate < 0 ? -1 : 11 + this.penultimate * 10 + this.previous];
    for (let order = 0; order < rows.length; order++) {
      const row = rows[order]!;
      if (row < 0) continue;
      for (let digit = 0; digit <= 9; digit++) {
        if (lockedDigit !== undefined && digit !== lockedDigit) continue;
        const { hits, n } = this.long.get(row, digit);
        const short = this.recent.get(row, digit);
        // Uniform Dirichlet shrinkage. Overlapping horizons are NOT treated as
        // independent votes, and their variances are never added as if they were.
        const probability = (hits + 1) / (n + 10);
        const recentProbability = (short.hits + 1) / (short.n + 10);
        const lower = Math.min(probability, pulseLower(hits, n, PULSE.z));
        const se = Math.sqrt(Math.max(0.001, probability * (1 - probability)) *
          (1 / Math.max(1, short.n) + 1 / Math.max(1, n)));
        // Compare LIKE estimators for drift. Differently shrunk windows would
        // falsely call an all-7 tape cold solely because the short prior weighs more.
        const driftZ = (short.n ? short.hits / short.n - (n ? hits / n : 0.1) : 0) / se;
        const reason = n < PULSE.minSupport[order]!
          ? `Need ${PULSE.minSupport[order]} context observations; have ${n}`
          : short.n < PULSE.minRecentSupport[order]!
            ? `Recent context is thin (${short.n}/${PULSE.minRecentSupport[order]})`
            : probability < PULSE.minProbability
              ? "No supported high-selectivity Matches setup"
              : lower <= breakEven + PULSE.entryMargin
                ? "Conservative probability does not clear the payout hurdle"
                : recentProbability <= breakEven + PULSE.entryMargin || driftZ < -2.33
                  ? "Conditional pattern has cooled in recent ticks"
                  : "Supported next-tick conditional edge";
        candidates.push({
          digit, probability, lower, recentProbability, support: n,
          recentSupport: short.n, order: order as 0 | 1 | 2,
          context: order === 0 ? "marginal" : order === 1 ? `${this.previous} → ?` : `${this.penultimate},${this.previous} → ?`,
          driftZ, ready: reason === "Supported next-tick conditional edge", reason,
        });
      }
    }
    candidates.sort((a, b) => Number(b.ready) - Number(a.ready) || b.lower - a.lower || a.order - b.order || a.digit - b.digit);
    return candidates[0] ?? {
      digit: lockedDigit ?? 0, probability: 0.1, lower: 0, recentProbability: 0.1,
      support: 0, recentSupport: 0, order: 0, context: "warming up", driftZ: 0,
      ready: false, reason: "Collecting digit history",
    };
  }
}

export function readPulse(digits: readonly number[], payout = MATCH_PAYOUT, lockedDigit?: number): PulseReading {
  const model = new PulseModel();
  // Retain two additional observations to reconstruct boundary contexts.
  for (const digit of digits.slice(-PULSE.window - 2)) model.observe(digit);
  return model.read(payout, lockedDigit);
}

export interface PulseCadence {
  lastShot: number | null;
  blockedUntil: number;
  lossRun: number;
}
export function freshPulseCadence(): PulseCadence {
  return { lastShot: null, blockedUntil: 0, lossRun: 0 };
}
export function pulseCadenceReady(c: PulseCadence, sequence: number): boolean {
  return sequence >= c.blockedUntil && (c.lastShot === null || sequence - c.lastShot >= PULSE.minSpacing);
}
export function recordPulseShot(c: PulseCadence, decisionSequence: number): void {
  c.lastShot = decisionSequence;
}
export function recordPulseResult(c: PulseCadence, won: boolean, settlementSequence: number): void {
  c.lossRun = won ? 0 : c.lossRun + 1;
  const cooldown = won ? 0 : c.lossRun >= 3 ? PULSE.clusterCooldown : PULSE.lossCooldown + 2 * (c.lossRun - 1);
  c.blockedUntil = settlementSequence + cooldown;
}

export interface PulseShot {
  /** Index of the unseen OUTCOME, not the signal tick. */
  index: number;
  digit: number;
  probability: number;
  lower: number;
  order: number;
  won: boolean;
}
export interface PulseBlock {
  ticks: number;
  shots: number;
  wins: number;
  winRate: number;
  lower: number;
  meanPrediction: number;
  brierSkill: number;
  longestLossRun: number;
}

function summarize(shots: PulseShot[], ticks: number): PulseBlock {
  const n = shots.length;
  const wins = shots.filter(s => s.won).length;
  let lossRun = 0, longestLossRun = 0, brier = 0, baseline = 0, predicted = 0;
  for (const shot of shots) {
    lossRun = shot.won ? 0 : lossRun + 1;
    longestLossRun = Math.max(longestLossRun, lossRun);
    const y = Number(shot.won);
    brier += (shot.probability - y) ** 2;
    baseline += (0.1 - y) ** 2;
    predicted += shot.probability;
  }
  return {
    ticks, shots: n, wins, winRate: n ? wins / n : 0,
    lower: pulseLower(wins, n), meanPrediction: n ? predicted / n : 0,
    brierSkill: baseline > 0 ? 1 - brier / baseline : 0, longestLossRun,
  };
}

/**
 * Mixture likelihood-ratio e-process against conditional P(win) <= break-even.
 * Alternatives are fixed BEFORE seeing outcomes. Predictable digit selection,
 * outcome-dependent cooldown and optional stopping do not invalidate it.
 * Unlike a binomial p-value conditional on a random shot count, this supports
 * the adaptive sampling policy. Across markets we use e-Bonferroni.
 */
export function pulseLogEvidence(wins: number, shots: number, breakEven: number): number {
  if (!shots || !(breakEven > 0 && breakEven < 1)) return 0;
  const logs = [0.05, 0.15, 0.30, 0.50].map(fraction => {
    const alternative = breakEven + fraction * (1 - breakEven);
    return wins * Math.log(alternative / breakEven) + (shots - wins) * Math.log((1 - alternative) / (1 - breakEven));
  });
  const max = Math.max(...logs);
  return max + Math.log(logs.reduce((sum, log) => sum + Math.exp(log - max), 0) / logs.length);
}

export interface PulseReport {
  symbol: string;
  displayName: string;
  history: number;
  payout: number;
  breakEven: number;
  validation: PulseBlock;
  audit: PulseBlock;
  combined: PulseBlock;
  logEvidence: number;
  requiredLogEvidence: number;
  lowerEv: number;
  qualified: boolean;
  reasons: string[];
  latest: PulseReading;
  /** Only returned by the pure replay; stripped from network responses. */
  replay: PulseShot[];
}

export function evaluatePulseMarket(
  symbol: string, displayName: string, digits: readonly number[],
  options: { lockedDigit?: number; payout?: number; marketsTested?: number; scanRound?: number } = {},
): PulseReport {
  const data = digits.slice(-PULSE.history);
  const payout = options.payout ?? MATCH_PAYOUT;
  const trainEnd = Math.floor(data.length * 0.5);
  const validationEnd = Math.floor(data.length * 0.75);
  const model = new PulseModel();
  const cadence = freshPulseCadence();
  const replay: PulseShot[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i >= trainEnd && pulseCadenceReady(cadence, i - 1)) {
      const reading = model.read(payout, options.lockedDigit);
      if (reading.ready) {
        const won = data[i] === reading.digit;
        replay.push({ index: i, digit: reading.digit, probability: reading.probability,
          lower: reading.lower, order: reading.order, won });
        recordPulseShot(cadence, i - 1);
        recordPulseResult(cadence, won, i);
      }
    }
    model.observe(data[i]!);
  }
  const validation = summarize(replay.filter(s => s.index < validationEnd), validationEnd - trainEnd);
  const audit = summarize(replay.filter(s => s.index >= validationEnd), data.length - validationEnd);
  const combined = summarize(replay, data.length - trainEnd);
  const report: PulseReport = {
    symbol, displayName, history: data.length, payout, breakEven: 1 / payout,
    validation, audit, combined, logEvidence: 0, requiredLogEvidence: 0,
    lowerEv: 0, qualified: false, reasons: [], latest: model.read(payout, options.lockedDigit), replay,
  };
  return qualifyPulseReport(report, payout, options.marketsTested ?? 1, options.scanRound ?? 1);
}

/** Reprice the evidence as well as the live forecast when the broker quotes. */
export function qualifyPulseReport(report: PulseReport, payout: number, marketsTested: number, scanRound: number): PulseReport {
  if (!Number.isFinite(payout) || payout <= 1) throw new Error("Invalid Matches payout");
  const breakEven = 1 / payout;
  const round = Math.max(1, scanRound);
  // Sum_r 1/(r(r+1)) = 1. Automatic and manual scans share this account's
  // process-lifetime budget; restarting the process is NOT new statistical proof.
  const alpha = PULSE.scanAlpha / (round * (round + 1));
  const requiredLogEvidence = Math.log(Math.max(1, marketsTested) / alpha);
  const logEvidence = pulseLogEvidence(report.combined.wins, report.combined.shots, breakEven);
  const reasons: string[] = [];
  if (report.history < PULSE.minHistory) reasons.push(`History ${report.history}/${PULSE.minHistory} ticks`);
  if (report.validation.shots < PULSE.minBlockShots || report.audit.shots < PULSE.minBlockShots || report.combined.shots < PULSE.minShots) {
    reasons.push(`Insufficient unseen entries: validation ${report.validation.shots}, audit ${report.audit.shots} (need ${PULSE.minBlockShots} each and ${PULSE.minShots} total)`);
  }
  if (report.validation.lower <= breakEven || report.audit.lower <= breakEven) reasons.push("Unseen performance does not conservatively beat this payout");
  if (report.audit.brierSkill <= 0 || report.validation.brierSkill <= 0) reasons.push("Forecasts have not beaten the 10% baseline in both unseen blocks");
  if (report.audit.meanPrediction - report.audit.winRate > 0.10) reasons.push("Forecasts are overconfident on the latest audit block");
  if (logEvidence < requiredLogEvidence) reasons.push("Evidence does not clear the market-search / repeated-scan correction");
  return { ...report, payout, breakEven, logEvidence, requiredLogEvidence,
    lowerEv: Math.min(report.validation.lower, report.audit.lower) * payout - 1,
    qualified: reasons.length === 0, reasons };
}

/** Switching never overrules a lock and never chooses an unqualified market. */
export function selectPulseMarket(
  reports: PulseReport[], mode: "locked" | "switching", selectedSymbol: string,
  currentSymbol?: string,
): PulseReport | null {
  const available = reports.filter(r => r.qualified && (mode !== "locked" || r.symbol === selectedSymbol))
    .sort((a, b) => b.lowerEv - a.lowerEv);
  const best = available[0];
  if (!best) return null;
  const current = available.find(r => r.symbol === currentSymbol);
  return current && best.lowerEv - current.lowerEv < 0.12 ? current : best;
}
