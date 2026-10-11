/**
 * Recovery research harness — journal audit.
 *
 * Reads settled trades (a Deriv journal export as JSON, or rows shaped like
 * the trades table) and reports, per contract and per mode:
 *   - realised hit rate vs the fair probability p0 and vs break-even;
 *   - a Wilson 95% interval on the hit rate;
 *   - an ANYTIME-VALID e-value against "no edge" (a mixture likelihood-ratio
 *     test martingale). An e-value ≥ 20 is the (deliberately strict) bar the
 *     WP6 tilt needs; on i.i.d. data it is expected to stay small.
 */

export interface AuditTradeRow {
  contractType: string;
  barrier?: number | null;
  mode?: string;
  won: boolean;
  stake?: number;
  profit?: number;
}

export interface AuditContractReport {
  contract: string;
  mode: string;
  trades: number;
  hits: number;
  hitRate: number;
  p0: number;
  breakEven: number;
  wilson: { lower: number; upper: number };
  /** Anytime-valid e-value against H0: p ≤ p0 (fair-or-worse). */
  eValueVsP0: number;
  /** Anytime-valid e-value against H0: p ≤ breakEven (no positive expectation). */
  eValueVsBreakEven: number;
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(hits: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 0 };
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lower: Math.max(0, (centre - spread) / denom),
    upper: Math.min(1, (centre + spread) / denom),
  };
}

/**
 * Anytime-valid e-value against H0: p ≤ pNull, observed sequence `wins` of
 * Bernoulli outcomes. Uses a mixture of simple likelihood-ratio test
 * martingales over a grid of alternatives p1 > pNull:
 *
 *   E_n = Σ_m w_m · (p1_m / pNull)^W · ((1 − p1_m)/(1 − pNull))^(n − W)
 *
 * Each term is a non-negative martingale with E_0 = 1 under p = pNull, so the
 * mixture is too: Ville's inequality gives P(sup E_n ≥ 1/pNull-bounds) control
 * at every stopping time — safe under optional stopping, unlike a p-value.
 * The mixture is conservative vs a tuned single alternative, which is exactly
 * the honesty the tilt gate wants.
 */
export function anytimeEValue(wins: boolean[], pNull: number): number {
  if (wins.length === 0) return 1;
  const p0 = Math.min(Math.max(pNull, 1e-6), 1 - 1e-6);
  const alternatives: number[] = [];
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const p1 = p0 + ((1 - p0 - 1e-4) * i) / steps;
    if (p1 > p0) alternatives.push(p1);
  }
  const W = wins.reduce((s, w) => s + (w ? 1 : 0), 0);
  const n = wins.length;
  let e = 0;
  for (const p1 of alternatives) {
    const logLr = W * Math.log(p1 / p0) + (n - W) * Math.log((1 - p1) / (1 - p0));
    // Clamp to keep the sum finite on long streams; e-values above ~1e12 are
    // already astronomically beyond the tilt gate of 20.
    e += Math.exp(Math.min(logLr, 280)) / alternatives.length;
  }
  return e;
}

const DIGIT_PAYOUT_TABLE: Record<string, number> = {
  DIGITEVEN: 1.95,
  DIGITODD: 1.95,
  DIGITMATCH: 8.93,
  DIGITDIFF: 1.09,
  CALL: 1.92,
  PUT: 1.92,
  RISE: 1.92,
  FALL: 1.92,
};

const OVER_PAYOUT: Record<number, number> = { 0: 1.09, 1: 1.23, 2: 1.4, 3: 1.63, 4: 1.95, 5: 2.43, 6: 3.21, 7: 4.72, 8: 8.93 };
const UNDER_PAYOUT: Record<number, number> = { 9: 1.09, 8: 1.23, 7: 1.4, 6: 1.63, 5: 1.95, 4: 2.43, 3: 3.21, 2: 4.72, 1: 8.93 };

export function auditContractKey(row: AuditTradeRow): string {
  const t = row.contractType.toUpperCase();
  if (t === "DIGITOVER") return `Over ${row.barrier ?? "?"}`;
  if (t === "DIGITUNDER") return `Under ${row.barrier ?? "?"}`;
  if (t === "DIGITMATCH") return row.barrier != null && row.barrier >= 0 ? `Matches ${row.barrier}` : "Matches auto";
  if (t === "DIGITDIFF") return row.barrier != null && row.barrier >= 0 ? `Differs ${row.barrier}` : "Differs auto";
  if (t === "DIGITEVEN") return "Even";
  if (t === "DIGITODD") return "Odd";
  return t === "RISE" ? "Rise" : t === "FALL" ? "Fall" : t.charAt(0) + t.slice(1).toLowerCase();
}

export function auditP0(row: AuditTradeRow): number {
  const t = row.contractType.toUpperCase();
  if (t === "DIGITOVER") return (9 - (row.barrier ?? 4)) / 10;
  if (t === "DIGITUNDER") return (row.barrier ?? 5) / 10;
  if (t === "DIGITMATCH") return 0.1;
  if (t === "DIGITDIFF") return 0.9;
  return 0.5;
}

export function auditPayout(row: AuditTradeRow): number {
  const t = row.contractType.toUpperCase();
  if (t === "DIGITOVER") return OVER_PAYOUT[row.barrier ?? 4] ?? 1.95;
  if (t === "DIGITUNDER") return UNDER_PAYOUT[row.barrier ?? 5] ?? 1.95;
  return DIGIT_PAYOUT_TABLE[t] ?? 1.92;
}

export function auditJournal(rows: AuditTradeRow[]): AuditContractReport[] {
  const groups = new Map<string, { wins: boolean[]; mode: string }>();
  for (const row of rows) {
    const key = `${auditContractKey(row)}|${row.mode ?? "any"}`;
    let g = groups.get(key);
    if (!g) {
      g = { wins: [], mode: row.mode ?? "any" };
      groups.set(key, g);
    }
    g.wins.push(row.won);
  }
  const reports: AuditContractReport[] = [];
  for (const [key, g] of groups) {
    const contract = key.split("|")[0];
    const n = g.wins.length;
    const hits = g.wins.filter(Boolean).length;
    const hitRate = n > 0 ? hits / n : 0;
    // Re-derive p0/breakEven from one representative row is not possible from
    // the grouped key alone; recompute from the label.
    const p0 = p0FromLabel(contract);
    const payout = payoutFromLabel(contract);
    const breakEven = payout > 0 ? 1 / payout : 1;
    reports.push({
      contract,
      mode: g.mode,
      trades: n,
      hits,
      hitRate,
      p0,
      breakEven,
      wilson: wilsonInterval(hits, n),
      eValueVsP0: anytimeEValue(g.wins, p0),
      eValueVsBreakEven: anytimeEValue(g.wins, breakEven),
    });
  }
  return reports.sort((a, b) => a.contract.localeCompare(b.contract));
}

function p0FromLabel(label: string): number {
  const over = /^Over (\d)$/.exec(label);
  if (over) return (9 - Number(over[1])) / 10;
  const under = /^Under (\d)$/.exec(label);
  if (under) return Number(under[1]) / 10;
  if (label.startsWith("Matches")) return 0.1;
  if (label.startsWith("Differs")) return 0.9;
  return 0.5;
}

function payoutFromLabel(label: string): number {
  const over = /^Over (\d)$/.exec(label);
  if (over) return OVER_PAYOUT[Number(over[1])] ?? 1.95;
  const under = /^Under (\d)$/.exec(label);
  if (under) return UNDER_PAYOUT[Number(under[1])] ?? 1.95;
  if (label.startsWith("Matches")) return 8.93;
  if (label.startsWith("Differs")) return 1.09;
  return 1.95; // Even/Odd; Rise/Fall close enough for an audit label
}
