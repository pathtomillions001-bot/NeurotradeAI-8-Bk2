/**
 * WP10 — the pure presentation logic behind the learning page.
 *
 * Everything here is a function of a number the SERVER produced. No clock, no
 * fetch, no state: the page's arithmetic is testable, and a reader can check what a
 * colour means without running a browser. It also keeps the page honest in one
 * specific way — the e-value's bar is drawn on a LOG scale, because e = 5 and
 * e = 20 are the same distance apart in evidence terms as e = 4 is from e = 1, and
 * a linear bar would make a halved agent look untouched and a disabled one look
 * merely at the halfway mark.
 */

/** The shipped thresholds, as the API reports them. Fallbacks are the documented ones. */
export const E_HALVE_FALLBACK = 5;
export const E_DISABLE_FALLBACK = 20;

export type AgentStatus = "active" | "halved" | "disabled";

export interface AgentStatusTone {
  label: string;
  /** Tailwind classes for the badge, matching the rest of the desk's palette. */
  className: string;
  /** One sentence a user can act on. */
  blurb: string;
}

export function agentStatusTone(status: AgentStatus): AgentStatusTone {
  switch (status) {
    case "disabled":
      return {
        label: "disabled",
        className: "border-rose-500/40 bg-rose-500/10 text-rose-300",
        blurb: "Out of service: the desk's own outcomes reached the disable threshold.",
      };
    case "halved":
      return {
        label: "halved",
        className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
        blurb: "Still proposing, at half the risk budget, until the evidence improves or an operator resumes it.",
      };
    default:
      return {
        label: "active",
        className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
        blurb: "No evidence against this agent's edge.",
      };
  }
}

/**
 * The e-value as a fraction of a log-scale bar up to the disable threshold.
 *
 * `e = 1` is the start (0%), `e = disable` is a full bar (100%), and the halve
 * threshold is marked at `ln(halve)/ln(disable)`. Values below 1 (an agent with
 * evidence FOR it) are clamped to 0 — the bar measures evidence against, and a
 * good agent's bar is empty rather than negative.
 */
export function eBarFraction(eValue: number, disableAt = E_DISABLE_FALLBACK): number {
  if (!Number.isFinite(eValue) || eValue <= 1 || disableAt <= 1) return 0;
  return Math.max(0, Math.min(1, Math.log(eValue) / Math.log(disableAt)));
}

/** Where the halve threshold sits on that same bar. */
export function eHalveFraction(halveAt = E_HALVE_FALLBACK, disableAt = E_DISABLE_FALLBACK): number {
  if (halveAt <= 1 || disableAt <= 1) return 0;
  return Math.max(0, Math.min(1, Math.log(halveAt) / Math.log(disableAt)));
}

/** `e = 12.34`, always two decimals — an e-value is never a headline. */
export function formatEValue(eValue: number): string {
  if (!Number.isFinite(eValue)) return "—";
  if (eValue < 0.001) return "<0.001";
  return eValue.toFixed(2);
}

/** An R multiple with its sign, because +0.4R and −0.4R must not look alike. */
export function formatR(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}R`;
}

/** A percentage with a sign and one decimal, for gaps between two percentages. */
export function formatPoints(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)} pts`;
}

export function formatProbability(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * The calibration gap's verdict, at the brief's own bar.
 *
 * The rollout rule is "hit rate within 8 points of predicted". Inside 8 points the
 * calibration is on target; outside it the direction of the error is named, because
 * "overconfident" and "underconfident" call for different fixes and an unsigned gap
 * hides which one the desk has.
 */
export function calibrationVerdict(gapPoints: number | null): {
  tone: "ok" | "warn" | "unknown";
  label: string;
} {
  if (gapPoints === null || !Number.isFinite(gapPoints)) return { tone: "unknown", label: "not measurable yet" };
  if (Math.abs(gapPoints) <= 8) return { tone: "ok", label: "within the 8-point bar" };
  return gapPoints < 0
    ? { tone: "warn", label: `${Math.abs(gapPoints).toFixed(1)} pts OVERCONFIDENT` }
    : { tone: "warn", label: `${gapPoints.toFixed(1)} pts UNDERCONFIDENT` };
}

/**
 * The Brier score against the two references that make it mean something.
 *
 * A Brier of 0.25 is exactly what a coin flip always saying 50% scores, so it is
 * the floor a model must beat; 0 is a perfect forecast. Rendering a bare "0.24"
 * invites the reader to think it is good.
 */
export function brierVerdict(brier: number | null): { tone: "ok" | "warn" | "unknown"; label: string } {
  if (brier === null || !Number.isFinite(brier)) return { tone: "unknown", label: "not measurable yet" };
  if (brier < 0.25) return { tone: "ok", label: "better than a 50% coin" };
  return { tone: "warn", label: "no better than a 50% coin" };
}

/** The refusal histogram, biggest first, with the code's share of all refusals. */
export function refusalRows(
  codes: { code: string; count: number }[],
): { code: string; count: number; share: number }[] {
  const total = codes.reduce((a, entry) => a + entry.count, 0);
  return [...codes]
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .map((entry) => ({ ...entry, share: total > 0 ? entry.count / total : 0 }));
}

/** A journal kind's short label; unknown kinds are shown as-is rather than dropped. */
export function journalKindLabel(kind: string): string {
  const map: Record<string, string> = {
    signal: "signal",
    no_trade: "no trade",
    execution: "execution",
    risk: "risk",
    error: "error",
    info: "info",
  };
  return map[kind] ?? kind;
}

/** One line summarising a weekly report, for a header or a card title. */
export function weeklyHeadline(report: {
  trades: { closed: number; measuredR: number; unmeasured: number; hitRate: number | null; meanR: number | null };
  decisions: { evaluated: number; armed: number; refused: number };
}): string {
  const hit = report.trades.hitRate === null ? "no measured hit rate" : `${(report.trades.hitRate * 100).toFixed(1)}% hit`;
  return (
    `${report.trades.closed} closed (${report.trades.measuredR} measured, ${report.trades.unmeasured} unmeasured) · ${hit} · ` +
    `mean ${formatR(report.trades.meanR)} · ${report.decisions.armed}/${report.decisions.evaluated} decisions armed`
  );
}

/** The regime state's tone, so the terminal and the learning page agree. */
export function regimeTone(state: string): string {
  switch (state) {
    case "trend_up":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    case "trend_down":
      return "border-sky-500/40 bg-sky-500/10 text-sky-300";
    case "volatile":
      return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-600/40 bg-zinc-600/10 text-zinc-300";
  }
}

/**
 * The rollout kill rules, evaluated against the numbers on this page.
 *
 * These are the brief's own gates (DD > 6%, e ≥ 20, slope outside [0.7, 1.3],
 * slippage > 0.15R). Only the ones the page can actually see are reported: an
 * unknown is "not measurable", never "fine".
 */
export function killRuleStatus(input: {
  maxDrawdownPct?: number | null;
  worstAgentE?: number | null;
  meanSlippageR?: number | null;
}): { rule: string; breached: boolean | null; detail: string }[] {
  const rows: { rule: string; breached: boolean | null; detail: string }[] = [];
  const dd = input.maxDrawdownPct ?? null;
  rows.push({
    rule: "drawdown ≤ 6%",
    breached: dd === null ? null : dd > 6,
    detail: dd === null ? "the desk has not reported a drawdown yet" : `${dd.toFixed(2)}%`,
  });
  const worstE = input.worstAgentE ?? null;
  rows.push({
    rule: "no agent at e ≥ 20",
    breached: worstE === null ? null : worstE >= 20,
    detail: worstE === null ? "no agent has traded yet" : `worst e = ${formatEValue(worstE)}`,
  });
  const slip = input.meanSlippageR ?? null;
  rows.push({
    rule: "mean slippage ≤ 0.15R",
    breached: slip === null ? null : slip > 0.15,
    detail: slip === null ? "no fills with a stamped risk yet" : `${slip.toFixed(3)}R`,
  });
  return rows;
}
