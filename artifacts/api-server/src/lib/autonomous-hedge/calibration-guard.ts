/**
 * M7 — Self-correcting over-confidence guard (CUSUM) for Recovery Quality Pipeline v2.
 *
 * Over REAL recovery trades:
 *   - Residual: r = win - pTilde (where win in {0, 1})
 *   - One-sided CUSUM against over-confidence (r < 0, i.e. pTilde > win):
 *       S_t = max(0, S_{t-1} - r)
 *   - Decision interval: h = 4 * sigma, with sigma = sqrt(pTilde * (1 - pTilde))
 *   - On alarm (S_t >= h): set evidenceWeight = 0 (p~ := p0 for every candidate)
 *     for 500 ticks, then restore evidenceWeight = 1.
 *
 * This is a soft shrink on evidence only — never a trading gate.
 */

export const CUSUM_H_SIGMA = 4;
export const CUSUM_SHRINK_TICKS = 500;

export interface CalibrationGuardState {
  cusumDeficit: number;
  lastSigma: number;
  lastThresholdH: number;
  alarmActive: boolean;
  ticksRemaining: number;
  shrinkTicksRemaining: number;
  evidenceWeight: number;
  alarmsTriggered: number;
  tradesObserved: number;
}

export class CalibrationGuard {
  private cusumDeficit = 0;
  private lastSigma = 0.5;
  private lastThresholdH = CUSUM_H_SIGMA * 0.5;
  private ticksRemaining = 0;
  private alarmsTriggered = 0;
  private tradesObserved = 0;

  reset(): void {
    this.cusumDeficit = 0;
    this.lastSigma = 0.5;
    this.lastThresholdH = CUSUM_H_SIGMA * 0.5;
    this.ticksRemaining = 0;
    this.alarmsTriggered = 0;
    this.tradesObserved = 0;
  }

  getEvidenceWeight(): number {
    return this.ticksRemaining > 0 ? 0 : 1;
  }

  isAlarmActive(): boolean {
    return this.ticksRemaining > 0;
  }

  isShrunkToPrior(): boolean {
    return this.ticksRemaining > 0;
  }

  applyGuard(pTilde: number, p0: number): number {
    return this.ticksRemaining > 0 ? p0 : pTilde;
  }

  getTicksRemaining(): number {
    return this.ticksRemaining;
  }

  getState(): CalibrationGuardState {
    return {
      cusumDeficit: this.cusumDeficit,
      lastSigma: this.lastSigma,
      lastThresholdH: this.lastThresholdH,
      alarmActive: this.ticksRemaining > 0,
      ticksRemaining: this.ticksRemaining,
      shrinkTicksRemaining: this.ticksRemaining,
      evidenceWeight: this.getEvidenceWeight(),
      alarmsTriggered: this.alarmsTriggered,
      tradesObserved: this.tradesObserved,
    };
  }

  recordRecoverySettlement(input: { won: boolean | 0 | 1; pTilde: number; p0?: number }): boolean {
    return this.recordRecoveryTrade(input);
  }

  /**
   * Record the outcome of a REAL recovery trade.
   * Returns true if this trade triggered a new CUSUM over-confidence alarm.
   */
  recordRecoveryTrade(input: { won: boolean | 0 | 1; pTilde: number }): boolean {
    const win = input.won === true || input.won === 1 ? 1 : 0;
    const p = Math.min(0.999, Math.max(0.001, input.pTilde));
    const r = win - p;
    const sigma = Math.sqrt(p * (1 - p));
    const h = CUSUM_H_SIGMA * sigma;

    this.tradesObserved += 1;
    this.lastSigma = sigma;
    this.lastThresholdH = h;
    this.cusumDeficit = Math.max(0, this.cusumDeficit - r);

    if (this.cusumDeficit >= h) {
      this.cusumDeficit = 0;
      this.ticksRemaining = CUSUM_SHRINK_TICKS;
      this.alarmsTriggered += 1;
      return true;
    }
    return false;
  }

  /** Advance the tick counter by `count` fresh ticks (default 1). */
  onTick(count = 1): void {
    const step = Math.max(0, Math.floor(count));
    if (this.ticksRemaining > 0 && step > 0) {
      this.ticksRemaining = Math.max(0, this.ticksRemaining - step);
    }
  }
}

export const defaultCalibrationGuard = new CalibrationGuard();
