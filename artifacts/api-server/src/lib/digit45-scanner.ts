// Scanner only: never quotes a buy, opens a contract, or starts an engine.
// Digit Over 4 / Under 5 split the ten possible settlement digits; their
// recovery pair (Over 5 / Under 4) BOTH lose on 4 or 5. These estimates rank
// observed broker digits, not guaranteed future probabilities or an edge.

export const DIGIT45_MIN_SAMPLES = 300;
export const DIGIT45_WINDOW = 600;
export const DIGIT45_RECENT_WINDOW = 100;
export const DIGIT45_SCAN_TTL_MS = 90_000;

export interface Digit45Candidate {
  symbol: string;
  displayName: string;
  samples: number;
  asOf: number;
  digit4: { count: number; rate: number; upper: number };
  digit5: { count: number; rate: number; upper: number };
  combined: { count: number; rate: number; upper: number };
  recentCombinedRate: number;
  effectiveSamples: number;
  score: number;
  eligible: boolean;
  reason: string;
}

/** One-sided 95% Wilson upper bound; never present an observed rate as certainty. */
export function wilsonUpper(rate: number, samples: number, z = 1.645): number {
  if (!Number.isFinite(rate) || !Number.isFinite(samples) || samples <= 0) return 1;
  const n = samples;
  const p = Math.max(0, Math.min(1, rate));
  const denominator = 1 + z * z / n;
  return Math.min(1, (p + z * z / (2 * n) + z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denominator);
}

/** Do not overstate confidence when hits of 4/5 cluster in adjacent ticks. */
function effectiveCount(digits: number[]): number {
  const n = digits.length;
  if (n < 3) return n;
  const hits = digits.map(d => Number(d === 4 || d === 5));
  const mean = hits.reduce((a, b) => a + b, 0) / n;
  const variance = mean * (1 - mean);
  if (variance <= 0) return n;
  let adjacent = 0;
  for (let i = 1; i < n; i++) adjacent += (hits[i]! - mean) * (hits[i - 1]! - mean);
  const rho = Math.max(0, Math.min(0.8, adjacent / ((n - 1) * variance)));
  return Math.max(1, n * (1 - rho) / (1 + rho));
}

export function evaluateDigit45Market(
  symbol: string,
  displayName: string,
  digits: number[],
  asOf: number,
): Digit45Candidate | null {
  if (!digits.length || digits.some(d => !Number.isInteger(d) || d < 0 || d > 9)) return null;
  const window = digits.slice(-DIGIT45_WINDOW);
  const samples = window.length;
  const recent = window.slice(-DIGIT45_RECENT_WINDOW);
  const nEff = effectiveCount(window);
  const count4 = window.filter(d => d === 4).length;
  const count5 = window.filter(d => d === 5).length;
  const rate4 = count4 / samples;
  const rate5 = count5 / samples;
  const combinedRate = rate4 + rate5;
  const recentCombinedRate = recent.filter(d => d === 4 || d === 5).length / recent.length;
  const digit4 = { count: count4, rate: rate4, upper: wilsonUpper(rate4, nEff) };
  const digit5 = { count: count5, rate: rate5, upper: wilsonUpper(rate5, nEff) };
  const combined = { count: count4 + count5, rate: combinedRate, upper: wilsonUpper(combinedRate, nEff) };
  const eligible = samples >= DIGIT45_MIN_SAMPLES &&
    digit4.upper < 0.10 && digit5.upper < 0.10 && combined.upper < 0.20 &&
    recentCombinedRate < 0.20;
  const reason = samples < DIGIT45_MIN_SAMPLES
    ? `Need at least ${DIGIT45_MIN_SAMPLES} verified broker ticks (${samples} available)`
    : recentCombinedRate >= 0.20
      ? "Digits 4/5 are not weak in the latest 100 ticks"
      : digit4.upper >= 0.10 || digit5.upper >= 0.10 || combined.upper >= 0.20
        ? "Insufficient evidence that both 4 and 5 are below their 10% baselines"
        : "Both 4 and 5 are below baseline at the measured confidence level";
  return {
    symbol, displayName, samples, asOf,
    digit4, digit5, combined, recentCombinedRate,
    effectiveSamples: Math.round(nEff),
    score: Math.round((0.2 - combined.upper) * 1000 + (0.2 - recentCombinedRate) * 100),
    eligible, reason,
  };
}

export function rankDigit45Markets(candidates: Digit45Candidate[]): Digit45Candidate[] {
  return [...candidates].sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.symbol.localeCompare(b.symbol));
}
