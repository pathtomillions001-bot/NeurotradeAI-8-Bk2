/**
 * Desk v4 research harness — the WP2 acceptance gates.
 *
 * These are the numbers an agent configuration must clear before it may leave
 * shadow mode. They are stated once, here, and every report quotes the same
 * constants, so a "pass" cannot mean something different in two places.
 *
 * The gates are deliberately asymmetric:
 *
 *   On the NULL, the requirement is RESTRAINT. Arm rarely (≤ 3%), do not lose
 *   money (mean R ≥ −(cost + 0.05)), and do not manufacture significance
 *   (≤ 5% of runs DSR-significant). A strategy that finds edge in noise is
 *   broken even when the equity curve looks good, because the mechanism
 *   producing it is selection.
 *
 *   On the POSITIVE CONTROL, the requirement is VISION. Arm ≥ 10% of the time
 *   and make money (≥ +0.30R). This is what stops the null gate from being
 *   passed trivially by a system that never trades — the failure mode that a
 *   naive "don't lose money on noise" test would reward.
 *
 *   On CALIBRATION, the requirement is HONESTY. A reliability slope near 1 and
 *   a Brier skill above zero mean the probability printed is the probability
 *   observed. Position sizing multiplies that number by money.
 */

import { mean } from "./numerics";
import type { RunReport, SuiteReport } from "./types";

export interface GateCheck {
  name: string;
  passed: boolean;
  observed: number;
  required: string;
}

/** Thresholds. Changing any of these changes what "proven" means. */
export const GATE_THRESHOLDS = {
  /** NULL: maximum share of evaluations that may arm. */
  nullMaxArmRate: 0.03,
  /**
   * NULL: the worst tolerated mean realised R, relative to the round-trip cost.
   * A strategy cannot be required to make money on noise (nothing can), but it
   * must not lose materially more than the cost of trading.
   */
  nullCostSlackR: 0.05,
  /** NULL: maximum share of runs allowed to show a deflated-Sharpe significance. */
  nullMaxSignificantShare: 0.05,
  /** A run counts as "significant" above this DSR. */
  significanceDsr: 0.95,
  /** POSITIVE CONTROL: minimum share of evaluations that must arm. */
  controlMinArmRate: 0.1,
  /** POSITIVE CONTROL: minimum mean realised R. */
  controlMinMeanR: 0.3,
  /** POSITIVE CONTROL: maximum |predicted − realised| expectancy, in R. */
  controlMaxExpectancyGapR: 0.15,
  /** CALIBRATION: accepted reliability slope band. */
  calibrationSlopeMin: 0.8,
  calibrationSlopeMax: 1.2,
  /** CALIBRATION: minimum Brier skill against the base-rate forecast. */
  calibrationMinBrierSkill: 0,
} as const;

/** Round for display so a borderline pass is never dressed up. */
function r(value: number, digits = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

/**
 * The NULL gate: driftless and phase-randomised datasets.
 *
 * `costR` is averaged across the runs because different symbols carry different
 * round-trip costs, and the slack is measured against what the strategy would
 * actually have paid.
 */
export function evaluateNullGate(reports: RunReport[]): SuiteReport {
  const armRate = mean(reports.map((report) => report.metrics.armRate));
  const trades = reports.flatMap((report) => report.trades.filter((trade) => trade.filled));
  const realisedMeanR = mean(trades.map((trade) => trade.realisedR ?? 0));
  const costR = mean(trades.map((trade) => trade.costR));
  const significantShare =
    reports.length > 0
      ? reports.filter((report) => report.metrics.deflatedSharpe >= GATE_THRESHOLDS.significanceDsr)
          .length / reports.length
      : 0;

  // The floor is expressed as a loss no worse than the round-trip cost plus a
  // small slack; when nothing traded, costR is 0 and the floor is −slack, which
  // is the correct reading of "did not trade, did not lose".
  const floor = -(costR + GATE_THRESHOLDS.nullCostSlackR);
  const checks: GateCheck[] = [
    {
      name: "null_arm_rate",
      passed: armRate <= GATE_THRESHOLDS.nullMaxArmRate,
      observed: r(armRate, 4),
      required: `<= ${GATE_THRESHOLDS.nullMaxArmRate}`,
    },
    {
      name: "null_mean_realised_r",
      passed: trades.length === 0 || realisedMeanR >= floor,
      observed: r(realisedMeanR, 4),
      required: `>= ${r(floor, 4)} (cost ${r(costR, 3)} + slack ${GATE_THRESHOLDS.nullCostSlackR})`,
    },
    {
      name: "null_dsr_significant_share",
      passed: significantShare <= GATE_THRESHOLDS.nullMaxSignificantShare,
      observed: r(significantShare, 4),
      required: `<= ${GATE_THRESHOLDS.nullMaxSignificantShare} at DSR >= ${GATE_THRESHOLDS.significanceDsr}`,
    },
  ];

  return {
    gate: "null",
    runs: reports,
    verdict: { passed: checks.every((check) => check.passed), checks },
  };
}

/** The POSITIVE CONTROL gate: a market with a deliberate, known edge. */
export function evaluatePositiveControlGate(reports: RunReport[]): SuiteReport {
  const armRate = mean(reports.map((report) => report.metrics.armRate));
  const trades = reports.flatMap((report) => report.trades.filter((trade) => trade.filled));
  const realisedMeanR = mean(trades.map((trade) => trade.realisedR ?? 0));

  // Predicted expectancy, weighted over the decisions that produced the trades
  // that were actually taken.
  const predicted: number[] = [];
  for (const report of reports) {
    const byId = new Map(
      report.decisions.filter((decision) => decision.plan !== null).map((decision) => [decision.plan!.id, decision]),
    );
    for (const trade of report.trades) {
      if (!trade.filled) continue;
      const decision = byId.get(trade.planId);
      if (decision?.predictedExpectancyR != null) predicted.push(decision.predictedExpectancyR);
    }
  }
  const predictedMeanR = mean(predicted);
  const gap = predicted.length > 0 ? Math.abs(predictedMeanR - realisedMeanR) : Infinity;

  const checks: GateCheck[] = [
    {
      name: "control_arm_rate",
      passed: armRate >= GATE_THRESHOLDS.controlMinArmRate,
      observed: r(armRate, 4),
      required: `>= ${GATE_THRESHOLDS.controlMinArmRate}`,
    },
    {
      name: "control_mean_realised_r",
      passed: trades.length > 0 && realisedMeanR >= GATE_THRESHOLDS.controlMinMeanR,
      observed: r(realisedMeanR, 4),
      required: `>= ${GATE_THRESHOLDS.controlMinMeanR} over >= 1 trade`,
    },
    {
      name: "control_expectancy_gap",
      passed: predicted.length > 0 && gap <= GATE_THRESHOLDS.controlMaxExpectancyGapR,
      observed: r(gap, 4),
      required: `|predicted ${r(predictedMeanR, 3)} - realised| <= ${GATE_THRESHOLDS.controlMaxExpectancyGapR}`,
    },
  ];

  return {
    gate: "positive_control",
    runs: reports,
    verdict: { passed: checks.every((check) => check.passed), checks },
  };
}

/** The CALIBRATION gate, over held-out trades with predictions. */
export function evaluateCalibrationGate(report: RunReport): SuiteReport {
  const metrics = report.metrics;
  const checks: GateCheck[] = [
    {
      name: "calibration_reliability_slope",
      passed:
        metrics.reliabilitySlope !== null &&
        metrics.reliabilitySlope >= GATE_THRESHOLDS.calibrationSlopeMin &&
        metrics.reliabilitySlope <= GATE_THRESHOLDS.calibrationSlopeMax,
      observed: r(metrics.reliabilitySlope ?? Number.NaN, 4),
      required: `in [${GATE_THRESHOLDS.calibrationSlopeMin}, ${GATE_THRESHOLDS.calibrationSlopeMax}]`,
    },
    {
      name: "calibration_brier_skill",
      passed: metrics.brierSkill !== null && metrics.brierSkill >= GATE_THRESHOLDS.calibrationMinBrierSkill,
      observed: r(metrics.brierSkill ?? Number.NaN, 4),
      required: `>= ${GATE_THRESHOLDS.calibrationMinBrierSkill} vs base rate`,
    },
    {
      name: "calibration_sample",
      passed: metrics.trades >= 30,
      observed: metrics.trades,
      required: ">= 30 filled trades",
    },
  ];
  return {
    gate: "calibration",
    runs: [report],
    verdict: { passed: checks.every((check) => check.passed), checks },
  };
}

/** Convenience: the checks as aligned text rows, for the markdown report. */
export function renderChecks(checks: GateCheck[]): string[] {
  return checks.map(
    (check) => `| ${check.name} | ${check.passed ? "PASS" : "FAIL"} | ${check.observed} | ${check.required} |`,
  );
}
