/**
 * M4 — Bounded Value-of-Waiting Timing Controller (`timing-v2.ts`).
 *
 * Tracks a rolling 500-evaluation distribution of 1–3-tick improvements in `J_best`:
 *   `valueOfWaiting = max(0, mean_{t}(max_{h in 1..3}(J_best(t) - J_best(t+h))))`
 * (antisymmetrized against 1–3-tick deteriorations so stationary zero-drift processes
 * have zero expected value of waiting while improving trajectories preserve
 * `max_{h in 1..3}(J_best(t) - J_best(t+h))`).
 *
 * Rules:
 *   1. If `valueOfWaiting <= 0.02`, fire immediately (`waitTicks = 0`).
 *   2. Otherwise wait up to AT MOST 3 fresh ticks or 6 seconds wall-clock,
 *      whichever comes first — NEVER extend.
 *   3. Fire early as soon as the current `J_best` is within `0.005` of the best `J`
 *      seen during the wait (once `J_best` has improved from the wait start or
 *      captured the expected `valueOfWaiting`).
 *   4. Re-evaluate the candidate once on the newest tape before dispatching if
 *      more than 1 tick elapsed since the decision was formed.
 */

export const ROLLING_EVAL_WINDOW = 500;
export const VALUE_OF_WAITING_THRESHOLD = 0.02;
export const MAX_WAIT_TICKS = 3;
export const MAX_WAIT_WALL_MS = 6_000;
export const EARLY_FIRE_TOLERANCE = 0.005;
export const PRE_BUY_SWITCH_MARGIN = 0.02;

interface PendingEval {
  seq: number;
  startJ: number;
  maxImprovement: number;
  minImprovement: number;
  horizonsSeen: number;
}

interface ActiveWaitState {
  startSeq: number;
  lastSeq: number;
  startMs: number;
  waitTicks: number;
  startJ: number;
  bestJSeen: number;
}

export interface TimingDecision {
  shouldFire: boolean;
  waitTicks: number;
  waitMs: number;
  valueOfWaiting: number;
  reason: string | null;
}

export class TimingV2Controller {
  private rollingImprovements = new Float64Array(ROLLING_EVAL_WINDOW);
  private rollingCount = 0;
  private rollingCursor = 0;
  private rollingSum = 0;
  private pending: PendingEval[] = [];
  private lastRecordedSeq = -1;
  private activeWait: ActiveWaitState | null = null;

  reset(): void {
    this.rollingCount = 0;
    this.rollingCursor = 0;
    this.rollingSum = 0;
    this.pending = [];
    this.lastRecordedSeq = -1;
    this.activeWait = null;
  }

  resetWaitOnly(): void {
    this.activeWait = null;
  }

  getValueOfWaiting(): number {
    if (this.rollingCount === 0) return 0;
    const mean = this.rollingSum / this.rollingCount;
    return Math.max(0, mean);
  }

  getRecordedSampleCount(): number {
    return this.rollingCount;
  }

  private recordTickJ(normJ: number, tickSequence: number): void {
    if (!Number.isFinite(normJ)) return;
    if (tickSequence === this.lastRecordedSeq) return;
    this.lastRecordedSeq = tickSequence;

    const remaining: PendingEval[] = [];
    for (const item of this.pending) {
      if (tickSequence > item.seq) {
        item.horizonsSeen += 1;
        const improvement = item.startJ - normJ;
        if (item.horizonsSeen === 1 || improvement > item.maxImprovement) {
          item.maxImprovement = improvement;
        }
        if (item.horizonsSeen === 1 || improvement < item.minImprovement) {
          item.minImprovement = improvement;
        }
        if (item.horizonsSeen >= MAX_WAIT_TICKS) {
          const netImp = item.maxImprovement + Math.min(0, item.minImprovement);
          this.pushCompletedImprovement(netImp);
          continue;
        }
      }
      remaining.push(item);
    }
    remaining.push({
      seq: tickSequence,
      startJ: normJ,
      maxImprovement: Number.NEGATIVE_INFINITY,
      minImprovement: Number.POSITIVE_INFINITY,
      horizonsSeen: 0,
    });
    this.pending = remaining;
  }

  private pushCompletedImprovement(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.rollingCount < ROLLING_EVAL_WINDOW) {
      this.rollingImprovements[this.rollingCursor] = value;
      this.rollingSum += value;
      this.rollingCount += 1;
      this.rollingCursor = (this.rollingCursor + 1) % ROLLING_EVAL_WINDOW;
    } else {
      const old = this.rollingImprovements[this.rollingCursor]!;
      this.rollingImprovements[this.rollingCursor] = value;
      this.rollingSum += value - old;
      this.rollingCursor = (this.rollingCursor + 1) % ROLLING_EVAL_WINDOW;
    }
  }

  evaluate(input: {
    bestJ: number;
    baselineJ?: number;
    tickSequence: number;
    nowMs?: number;
  }): TimingDecision {
    const { bestJ, tickSequence } = input;
    const normJ = Number.isFinite(input.baselineJ) ? bestJ - input.baselineJ! : bestJ;
    const nowMs = input.nowMs ?? Date.now();

    // Update rolling 1..3-tick improvement history before deciding.
    const valueOfWaiting = this.getValueOfWaiting();
    this.recordTickJ(normJ, tickSequence);
    const updatedVow = this.getValueOfWaiting();
    const vow = Math.max(valueOfWaiting, updatedVow);

    if (!this.activeWait) {
      if (vow <= VALUE_OF_WAITING_THRESHOLD) {
        return {
          shouldFire: true,
          waitTicks: 0,
          waitMs: 0,
          valueOfWaiting: vow,
          reason: null,
        };
      }
      // Start bounded wait (max 3 fresh ticks or 6 s wall-clock).
      this.activeWait = {
        startSeq: tickSequence,
        lastSeq: tickSequence,
        startMs: nowMs,
        waitTicks: 0,
        startJ: normJ,
        bestJSeen: normJ,
      };
      return {
        shouldFire: false,
        waitTicks: 0,
        waitMs: 0,
        valueOfWaiting: vow,
        reason: `waiting for better J (0/${MAX_WAIT_TICKS} ticks, VoW=${vow.toFixed(3)})`,
      };
    }

    const wait = this.activeWait;
    const isFreshTick = tickSequence > wait.lastSeq;
    if (isFreshTick) {
      wait.waitTicks += 1;
      wait.lastSeq = tickSequence;
    }
    const elapsedMs = Math.max(0, nowMs - wait.startMs);
    const priorBestJ = wait.bestJSeen;
    if (normJ < wait.bestJSeen) {
      wait.bestJSeen = normJ;
    }

    // Hard cap: max 3 fresh ticks or 6 s wall-clock, whichever comes first. Never extend.
    if (wait.waitTicks >= MAX_WAIT_TICKS || elapsedMs >= MAX_WAIT_WALL_MS) {
      const finalTicks = Math.min(MAX_WAIT_TICKS, wait.waitTicks);
      const finalMs = Math.min(MAX_WAIT_WALL_MS, elapsedMs);
      this.activeWait = null;
      return {
        shouldFire: true,
        waitTicks: finalTicks,
        waitMs: finalMs,
        valueOfWaiting: vow,
        reason: null,
      };
    }

    // Early fire: on a fresh tick, if current J_best has captured the expected
    // improvement (within 0.005) or is within 0.005 of an already-improved best J seen.
    if (wait.waitTicks >= 1) {
      const targetJ = wait.startJ - vow;
      const capturedExpected = normJ <= targetJ + EARLY_FIRE_TOLERANCE;
      const nearImprovedBest =
        (priorBestJ < wait.startJ - EARLY_FIRE_TOLERANCE || normJ < wait.startJ - EARLY_FIRE_TOLERANCE) &&
        normJ <= wait.bestJSeen + EARLY_FIRE_TOLERANCE;
      if (capturedExpected || nearImprovedBest) {
        const firedAfterTicks = wait.waitTicks;
        this.activeWait = null;
        return {
          shouldFire: true,
          waitTicks: firedAfterTicks,
          waitMs: elapsedMs,
          valueOfWaiting: vow,
          reason: null,
        };
      }
    }

    return {
      shouldFire: false,
      waitTicks: wait.waitTicks,
      waitMs: elapsedMs,
      valueOfWaiting: vow,
      reason: `waiting for better J (${wait.waitTicks}/${MAX_WAIT_TICKS} ticks, ${(elapsedMs / 1000).toFixed(1)}s/${MAX_WAIT_WALL_MS / 1000}s)`,
    };
  }
}

export function isDecisionStale(decisionSequence: number, newestSequence: number): boolean {
  return newestSequence - decisionSequence > 1;
}

export function shouldSwitchCandidateBeforeBuy(
  chosenRefreshedJ: number,
  bestAlternativeJ: number,
): boolean {
  return chosenRefreshedJ - bestAlternativeJ > PRE_BUY_SWITCH_MARGIN;
}
